/*
 * ZotMax — advisor progress report (指導教授會議進度報告).
 *
 * Tools menu → a dialog (period, sections, questions to discuss, next goals) → an Obsidian note
 * `<folder>/進度報告/<YYYY-MM-DD>.md` built from data only, no AI needed:
 *   - 本期閱讀: papers whose reading status moved to 已讀/已引用 in the period (from the status log
 *     below), papers added, AI notes generated, appraisal forms verified;
 *   - 系統性回顧進度: each Reviews/*.md PRISMA count now and its change since the previous report
 *     (a snapshot is kept per report), with what still awaits screening;
 *   - 寫作進度: Drafts/*.md updated in the period and the words of the user's own text in them
 *     (outside the plugin's %% zotero-bridge %% regions), with the change since the last report;
 *   - 新文獻追蹤: the PubMed watch's daily digests (新文獻/<date>.md) in the period;
 *   - 問題與下次目標: from the dialog, and the previous report's 下次目標 as a 上次目標回顧 checklist.
 * Optionally (off by default) one LLM call writes a short 本期摘要 from those facts only; numbers it
 * uses that are not in the facts are flagged. Exports: a Lua filter + Pandoc command for Word, plain
 * text on the clipboard for LINE/Email, and a Notion child page of the synthesis parent.
 *
 * Status log: status.js calls logStatusChange() when a sync, the status pass or the item pane changes
 * an item's status. The log is the `progressReport.statusLog` pref, { "library/KEY": [{ date, from, to }] },
 * capped per item, by age and in total, so it works without a vault and never grows without bound.
 *
 * The helpers at the top are pure (Node tests); the rest needs Zotero.
 */
(function (root, factory) {
	if (typeof module === "object" && module.exports) {
		module.exports = factory(require("./core.js"), require("./dashboard.js"), require("./usage.js"), globalThis);
	}
	else {
		(root.ZB = root.ZB || {}).progressReport = factory(root.ZB.core, root.ZB.dashboard, root.ZB.usage, root);
	}
})(this, function (core, dashboard, usage, scope) {
	const PREF = "extensions.zotero-bridge.";
	const STATUS_LOG_PREF = "progressReport.statusLog";
	// The day status changes started to be logged (this version's first status change or report)
	const LOG_SINCE_PREF = "progressReport.statusLogSince";
	const HISTORY_PREF = "progressReport.history";
	const OPTIONS_PREF = "progressReport.options";
	const REPORT_FOLDER = "進度報告";
	const REVIEW_FOLDER = "Reviews";
	const DRAFTS_FOLDER = "Drafts";
	const DIGEST_FOLDER = "新文獻";
	const FILTER_FILE = "zotero-bridge-report.lua";
	const DIALOG_TITLE = "ZotMax：進度報告";
	const DEFAULT_DAYS = 14;
	const READ_STATUSES = ["已讀", "已引用"];
	const LOG_LIMITS = { maxPerItem: 20, maxEntries: 3000, maxAgeDays: 730 };
	const HISTORY_MAX = 24;
	const MAX_LIST = 40;
	const HEAD_BYTES = 16384;
	const EXPECTED_OUTPUT_TOKENS = 1500;
	const MAX_OUTPUT_TOKENS = 16000;
	const PLACEHOLDER = "（未填寫）";
	const QUESTIONS_HEADING = "本次想討論的問題";
	const GOALS_HEADING = "下次目標";
	const REVIEW_GOALS_HEADING = "上次目標回顧";
	const SUMMARY_HEADING = "本期摘要（AI 整理）";
	const PANDOC_HEADING = "Pandoc 指令";
	const USER_SECTION = "## ✍️ 我的筆記\n\n";
	const NOTION_CONTAINER_TITLE = "進度報告（重新產生會覆寫，修改請寫在此區塊外）";
	const MARK_START = "%% zotero-bridge:start — 此區塊由 ZotMax 自動產生；同一天重新產生報告時會覆寫（「上次目標回顧」的勾選會保留，問題與目標會帶回對話框）%%";
	const MARK_START_RE = /^%% zotero-bridge:start.*%%[ \t]*$/m;
	const MARK_END_RE = /^%% zotero-bridge:end %%[ \t]*$/m;
	const SECTIONS = [
		["reading", "本期閱讀"],
		["reviews", "系統性回顧進度"],
		["writing", "寫作進度"],
		["pubmed", "新文獻追蹤"],
		["goals", "問題與下次目標"],
	];

	// ---------- dates (pure) ----------

	const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

	function pad(n) {
		return String(n).padStart(2, "0");
	}

	/** "YYYY-MM-DD" in local time. */
	function localDate(d = new Date()) {
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	}

	function isDay(s) {
		return DAY_RE.test(String(s || "")) && Number.isFinite(Date.parse(s));
	}

	function addDays(day, n) {
		let [y, m, d] = String(day).split("-").map(Number);
		return localDate(new Date(y, m - 1, d + n));
	}

	/** The local day of a date value: "2026-10-01" as is, ISO times and Zotero's UTC "YYYY-MM-DD HH:MM:SS" converted; "" if unreadable. */
	function toLocalDay(v) {
		let s = String(v === undefined || v === null ? "" : v).trim();
		if (!s) return "";
		if (DAY_RE.test(s)) return isDay(s) ? s : "";
		if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(s)) s = s.replace(" ", "T") + "Z";
		let t = Date.parse(s);
		return Number.isFinite(t) ? localDate(new Date(t)) : "";
	}

	function inPeriod(v, period) {
		let d = toLocalDay(v);
		return !!d && d >= period.start && d <= period.end;
	}

	/**
	 * The dialog's default period: from the previous report (when it is before today, inclusive) or
	 * else the last DEFAULT_DAYS days, to today.
	 */
	function defaultPeriod(now = new Date(), lastReportDate = "", days = DEFAULT_DAYS) {
		let end = localDate(now);
		if (isDay(lastReportDate) && lastReportDate < end) return { start: lastReportDate, end, fromLastReport: true };
		return { start: addDays(end, -(days - 1)), end, fromLastReport: false };
	}

	/** A period from the dialog's fields: invalid dates fall back to the default, reversed ones are swapped. */
	function normalizePeriod(start, end, now = new Date()) {
		let e = isDay(end) ? end : localDate(now);
		let s = isDay(start) ? start : addDays(e, -(DEFAULT_DAYS - 1));
		if (s > e) [s, e] = [e, s];
		return { start: s, end: e };
	}

	/** The latest report date before `date` ("" if none). */
	function previousReportDate(dates, date) {
		return [...new Set(dates || [])].filter(d => isDay(d) && d < date).sort().pop() || "";
	}

	// ---------- status log (pure) ----------

	function cleanStatus(v) {
		return String(v === undefined || v === null ? "" : v).trim();
	}

	/** The log from its pref text: { key: [{ date, from, to }] }, anything malformed dropped. */
	function parseStatusLog(text) {
		let obj;
		try {
			obj = JSON.parse(text || "{}");
		}
		catch (e) {
			return {};
		}
		if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
		let out = {};
		for (let [key, list] of Object.entries(obj)) {
			if (!Array.isArray(list)) continue;
			let entries = list.filter(e => e && typeof e === "object" && isDay(e.date) && cleanStatus(e.to))
				.map(e => ({ date: e.date, from: cleanStatus(e.from), to: cleanStatus(e.to) }));
			if (entries.length) out[key] = entries;
		}
		return out;
	}

	/** Entries older than maxAgeDays dropped, then only the newest maxEntries kept (per-item order unchanged). */
	function capStatusLog(log, today, limits = LOG_LIMITS) {
		let cutoff = addDays(today, -(limits.maxAgeDays || LOG_LIMITS.maxAgeDays));
		let all = [];
		for (let [key, list] of Object.entries(log)) {
			list.forEach((e, i) => {
				if (e.date >= cutoff) all.push({ key, i, e });
			});
		}
		let max = limits.maxEntries || LOG_LIMITS.maxEntries;
		if (all.length > max) {
			all.sort((a, b) => b.e.date.localeCompare(a.e.date) || b.i - a.i);
			all = all.slice(0, max);
		}
		let out = {};
		for (let { key, i, e } of all.sort((a, b) => a.i - b.i)) (out[key] = out[key] || []).push(e);
		return out;
	}

	/**
	 * The log with one more change. Nothing is added for an empty or unchanged status, or when the
	 * item's last logged change already went to `to` (the item pane, then the next sync, see the same change).
	 * @returns {{ log, changed: boolean }}
	 */
	function appendStatusLog(log, key, from, to, date, limits = LOG_LIMITS) {
		from = cleanStatus(from);
		to = cleanStatus(to);
		if (!key || !to || from === to || !isDay(date)) return { log, changed: false };
		let list = (log[key] || []).slice();
		let last = list[list.length - 1];
		if (last && last.to === to) return { log, changed: false };
		list.push({ date, from, to });
		let out = Object.assign({}, log, { [key]: list.slice(-(limits.maxPerItem || LOG_LIMITS.maxPerItem)) });
		return { log: capStatusLog(out, date, limits), changed: true };
	}

	/**
	 * Items whose last change in the period went to 已讀/已引用: [{ key, date, from, to }], newest first.
	 * `from` is the status before the period's first change (待讀 → 閱讀中 → 已讀 reads 待讀 → 已讀).
	 */
	function readingChanges(log, period) {
		let out = [];
		for (let [key, list] of Object.entries(log || {})) {
			let within = list.filter(e => e.date >= period.start && e.date <= period.end);
			if (!within.length) continue;
			let last = within[within.length - 1];
			if (!READ_STATUSES.includes(last.to)) continue;
			out.push({ key, date: last.date, from: within[0].from, to: last.to });
		}
		return out.sort((a, b) => b.date.localeCompare(a.date) || a.key.localeCompare(b.key));
	}

	// ---------- report history and PRISMA snapshots (pure) ----------

	function parseHistory(text) {
		let list;
		try {
			list = JSON.parse(text || "[]");
		}
		catch (e) {
			return [];
		}
		if (!Array.isArray(list)) return [];
		return list.filter(h => h && typeof h === "object" && isDay(h.date))
			.map(h => Object.assign({}, h, {
				prisma: h.prisma && typeof h.prisma === "object" && !Array.isArray(h.prisma) ? h.prisma : {},
				drafts: h.drafts && typeof h.drafts === "object" && !Array.isArray(h.drafts) ? h.drafts : {},
			}))
			.sort((a, b) => a.date.localeCompare(b.date));
	}

	/** History with `entry` (replacing one of the same date), oldest dropped beyond `max`. */
	function updateHistory(history, entry, max = HISTORY_MAX) {
		let out = history.filter(h => h.date !== entry.date);
		out.push(entry);
		out.sort((a, b) => a.date.localeCompare(b.date));
		return out.slice(-max);
	}

	/** The report before `date` (null if none). */
	function previousEntry(history, date) {
		let before = history.filter(h => h.date < date);
		return before.length ? before[before.length - 1] : null;
	}

	const PRISMA_FIELDS = [["identified", "辨識"], ["screened", "篩選"], ["assessed", "全文評估"], ["included", "納入"]];
	const AWAITING_FIELDS = [["awaitingScreening", "標題摘要"], ["awaitingFulltext", "全文"]];

	function num(v) {
		let s = Array.isArray(v) ? "" : String(v === undefined || v === null ? "" : v).trim();
		let n = Number(s);
		return s !== "" && Number.isFinite(n) ? n : null;
	}

	/** A Reviews/*.md note (screening.js) from its frontmatter. */
	function reviewRecord(fm, relPath) {
		let f = typeof fm === "string" ? dashboard.parseFrontmatter(fm) : (fm || {});
		let name = String(relPath).split("/").pop().replace(/\.md$/i, "");
		let text = v => (Array.isArray(v) ? v.join(", ") : String(v === undefined || v === null ? "" : v).trim());
		return {
			relPath,
			link: String(relPath).replace(/\.md$/i, ""),
			name,
			title: text(f.title) || name,
			identified: num(f.prisma_identified),
			screened: num(f.prisma_screened),
			assessed: num(f.prisma_assessed),
			included: num(f.prisma_included),
			awaitingScreening: num(f.prisma_awaiting_screening),
			awaitingFulltext: num(f.prisma_awaiting_fulltext),
			generatedAt: text(f.last_generated) || text(f.generated_at),
		};
	}

	/** { relPath: counts } for the history. */
	function prismaSnapshot(reviews) {
		let out = {};
		for (let r of reviews) {
			out[r.relPath] = {};
			for (let [k] of [...PRISMA_FIELDS, ...AWAITING_FIELDS]) out[r.relPath][k] = r[k];
		}
		return out;
	}

	/**
	 * Each review now and its change since the snapshot: [{ review, previous (counts | null), delta: { field: n | null } }].
	 * delta is null where either side has no count, or when there is no previous snapshot of the review.
	 */
	function diffPrisma(reviews, snapshot) {
		return reviews.map((review) => {
			let previous = snapshot && snapshot[review.relPath] ? snapshot[review.relPath] : null;
			let delta = {};
			for (let [k] of [...PRISMA_FIELDS, ...AWAITING_FIELDS]) {
				let a = review[k];
				let b = previous ? num(previous[k]) : null;
				delta[k] = a !== null && b !== null ? a - b : null;
			}
			return { review, previous, delta };
		});
	}

	// ---------- drafts: the user's own words (pure) ----------

	/** A note's text without frontmatter, plugin regions, comments, code, headings and link syntax. */
	function userText(text) {
		let { body } = core.splitFrontmatter(String(text || "").replace(/^\uFEFF/, ""));
		return body
			.replace(/^%% zotero-bridge:start.*%%[ \t]*$[\s\S]*?^%% zotero-bridge:end %%[ \t]*$/gm, "")
			.replace(/^```[\s\S]*?^```[ \t]*$/gm, "")
			.replace(/%%[\s\S]*?%%/g, "")
			.replace(/<!--[\s\S]*?-->/g, "")
			.replace(/^#{1,6}\s.*$/gm, "")
			.replace(/!\[\[[^\]]*\]\]/g, "")
			.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
			.replace(/\[\[([^\]]*)\]\]/g, "$1")
			.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
			// Pandoc citations are references, not words
			.replace(/\[(?:-?@[^\]]*)\]/g, "")
			.replace(/^>\s*\[![^\]]*\][+-]?/gm, "");
	}

	/** Words as a Chinese thesis counts them: each Han character, plus each Latin word or number. */
	function countWords(text) {
		let s = String(text || "");
		let han = (s.match(/\p{Script=Han}/gu) || []).length;
		let latin = (s.replace(/\p{Script=Han}/gu, " ").match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu) || []).length;
		return han + latin;
	}

	/** A Drafts/*.md note: { relPath, link, name, type, generatedAt, modified (local day), words }. */
	function draftRecord(text, relPath, mtime) {
		let { frontmatter } = core.splitFrontmatter(String(text || "").replace(/^\uFEFF/, ""));
		let f = dashboard.parseFrontmatter(frontmatter || "");
		let name = String(relPath).split("/").pop().replace(/\.md$/i, "");
		let str = v => (Array.isArray(v) ? "" : String(v === undefined || v === null ? "" : v).trim());
		return {
			relPath,
			link: String(relPath).replace(/\.md$/i, ""),
			name,
			type: str(f.type),
			generatedAt: str(f.generated_at) || str(f.last_generated),
			modified: mtime ? toLocalDay(new Date(mtime).toISOString()) : "",
			words: countWords(userText(text)),
		};
	}

	function draftUpdated(d, period) {
		return inPeriod(d.generatedAt, period) || inPeriod(d.modified, period);
	}

	// ---------- PubMed digests (pure) ----------

	/** A 新文獻/<date>.md note (pubmed-watch.js): [{ name, total, checked }] per watch. */
	function digestSummary(text) {
		let body = String(text || "");
		let start = MARK_START_RE.exec(body);
		let end = MARK_END_RE.exec(body);
		if (start && end && end.index > start.index) body = body.slice(start.index + start[0].length, end.index);
		let groups = [];
		for (let line of body.split(/\r?\n/)) {
			let h = /^##\s+(.+?)\s*$/.exec(line);
			if (h) {
				groups.push({ name: h[1], total: 0, checked: 0 });
				continue;
			}
			let item = /^\s*[-*]\s+\[( |x|X)\]\s/.exec(line);
			if (item && groups.length) {
				groups[groups.length - 1].total++;
				if (item[1] !== " ") groups[groups.length - 1].checked++;
			}
		}
		return groups.filter(g => g.total);
	}

	// ---------- questions and goals (pure) ----------

	/** Lines of a free-text field or a Markdown list: bullets, numbers and checkboxes removed. */
	function parseLines(text) {
		return String(text || "").split(/\r?\n/)
			.map(l => l.replace(/^\s*(?:[-*+•]\s+|\d+[.)、]\s*)?(?:\[[ xX]\]\s+)?/, "").trim())
			.filter(l => l && l !== PLACEHOLDER)
			.slice(0, 30);
	}

	/** The text under a heading with exactly this text (any level), up to the next heading of the same or a higher level. */
	function extractSection(md, heading) {
		let lines = String(md || "").split(/\r?\n/);
		let out = null;
		let level = 0;
		for (let line of lines) {
			let h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
			if (out !== null) {
				if ((h && h[1].length <= level) || MARK_END_RE.test(line)) break;
				out.push(line);
			}
			else if (h && h[2] === heading) {
				out = [];
				level = h[1].length;
			}
		}
		return out === null ? "" : out.join("\n").trim();
	}

	/** Checklist items of a section: [{ text, done }]; plain list items count as not done. */
	function parseChecklist(text) {
		let out = [];
		for (let line of String(text || "").split(/\r?\n/)) {
			let m = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*\S)\s*$/.exec(line);
			if (!m || m[2] === PLACEHOLDER) continue;
			if (!out.some(g => g.text === m[2])) out.push({ text: m[2], done: !!m[1] && m[1] !== " " });
		}
		return out;
	}

	/**
	 * 上次目標回顧: the previous report's 下次目標, with the check marks the user has set (in the
	 * current day's note when it is rebuilt, else in the previous report).
	 */
	function carryOverGoals(previousNote, currentNote) {
		let goals = parseChecklist(extractSection(previousNote, GOALS_HEADING));
		let states = new Map(parseChecklist(extractSection(currentNote, REVIEW_GOALS_HEADING)).map(g => [g.text, g.done]));
		return goals.map(g => ({ text: g.text, done: states.has(g.text) ? states.get(g.text) : g.done }));
	}

	// ---------- Markdown (pure) ----------

	function link(target, text) {
		let label = String(text || "").replace(/\s+/g, " ").trim();
		if (label.length > 80) label = label.slice(0, 79) + "…";
		label = label.replace(/\|/g, "｜").replace(/\[/g, "(").replace(/\]/g, ")");
		return label && label !== target ? `[[${target}|${label}]]` : `[[${target}]]`;
	}

	function signed(n) {
		return n > 0 ? `+${n}` : String(n);
	}

	function fmtNumber(n) {
		return Number(n).toLocaleString("en-US");
	}

	function capped(lines, total) {
		return lines.slice(0, MAX_LIST).join("\n") + (total > MAX_LIST ? `\n- ……另有 ${total - MAX_LIST} 篇未列出` : "");
	}

	function paperLine(p, extra) {
		return `- ${p.link ? link(p.link, p.title) : p.title}${extra ? ` — ${extra}` : ""}`;
	}

	function readingSection(r) {
		let parts = ["## 本期閱讀"];
		parts.push(`讀完 **${r.finished.length}** 篇 · 新加入 **${r.added.length}** 篇 · AI 文獻筆記 **${r.aiNotes.length}** 篇 · 完成核對的嚴格評讀 **${r.appraisals.length}** 篇`);
		parts.push(`### 讀完（狀態改為${READ_STATUSES.join("／")}）`);
		parts.push(r.finished.length
			? capped(r.finished.map(p => paperLine(p, `${p.from || "（未設定）"} → ${p.to}（${p.date}）`)), r.finished.length)
			: "本期沒有狀態改為已讀或已引用的文獻。");
		if (!r.logSince) {
			parts.push("> [!note] 閱讀狀態的變更從安裝這一版之後才開始記錄；更早的變更不會出現在報告中。");
		}
		parts.push("### 新加入的文獻");
		parts.push(r.added.length ? capped(r.added.map(p => paperLine(p, `${p.date} 加入${p.status ? `（${p.status}）` : ""}`)), r.added.length) : "本期沒有新加入的文獻。");
		parts.push("### AI 文獻筆記");
		parts.push(r.aiNotes.length ? capped(r.aiNotes.map(p => paperLine(p, `${p.date} 產生`)), r.aiNotes.length) : "本期沒有產生 AI 文獻筆記。");
		parts.push("### 完成核對的嚴格評讀");
		parts.push(r.appraisals.length
			? capped(r.appraisals.map(p => paperLine(p, [p.tool, p.overall ? `整體：${p.overall}` : "", `${p.date} 核對`].filter(Boolean).join("，"))), r.appraisals.length)
			: "本期沒有完成核對的文獻評讀表。");
		return parts.join("\n\n");
	}

	function prismaLine(row, hasSnapshot) {
		let r = row.review;
		let flow = PRISMA_FIELDS.filter(([k]) => r[k] !== null).map(([k, label]) => {
			let d = row.delta[k];
			return `${label} ${fmtNumber(r[k])}${d ? `（${signed(d)}）` : ""}`;
		}).join(" → ");
		let awaiting = AWAITING_FIELDS.filter(([k]) => r[k]).map(([k, label]) => `${label} ${fmtNumber(r[k])}`);
		let bits = [flow || "尚無 PRISMA 計數"];
		bits.push(awaiting.length ? `尚待篩選：${awaiting.join("、")}` : "沒有待篩選的文獻");
		let note = hasSnapshot && !row.previous ? "（上次報告後新增的回顧）" : "";
		return `- ${link(r.link, r.title)}：${bits.join("；")}${note}`;
	}

	function reviewsSection(rows, hasSnapshot) {
		let parts = ["## 系統性回顧進度"];
		if (!rows.length) {
			parts.push("還沒有回顧專案（Zotero 分類右鍵 → ZotMax → 產生 PRISMA 流程圖與證據表（目前分類））。");
			return parts.join("\n\n");
		}
		parts.push(rows.map(r => prismaLine(r, hasSnapshot)).join("\n"));
		parts.push(hasSnapshot
			? "括號內是和上次報告相比的變化；計數取自 Reviews 筆記最近一次產生的 PRISMA（要最新數字請先重新產生 PRISMA）。"
			: "這是第一份報告，沒有上次的數字可以比較；計數取自 Reviews 筆記最近一次產生的 PRISMA。");
		return parts.join("\n\n");
	}

	function writingSection(w) {
		let parts = ["## 寫作進度"];
		if (!w.total) {
			parts.push("Drafts 資料夾還沒有草稿。");
			return parts.join("\n\n");
		}
		parts.push(`Drafts 共 ${w.total} 份，本期更新 **${w.updated.length}** 份。`);
		if (w.updated.length) {
			parts.push(w.updated.map((d) => {
				let when = [d.modified ? `修改於 ${d.modified}` : "", d.generatedInPeriod ? `草稿產生於 ${toLocalDay(d.generatedAt)}` : ""].filter(Boolean).join("，");
				let words = `我的文字約 ${fmtNumber(d.words)} 字${d.wordsDelta ? `（${signed(d.wordsDelta)}）` : ""}`;
				return `- ${link(d.link, d.name)}：${[when, words].filter(Boolean).join(" · ")}`;
			}).join("\n"));
		}
		parts.push("字數只算插件自動產生區塊以外、你自己寫的文字（不含標題；中文每字算 1，英文每個單字算 1）；括號內是和上次報告相比的變化。");
		return parts.join("\n\n");
	}

	function pubmedSection(p) {
		let parts = ["## 新文獻追蹤"];
		if (!p.days.length) {
			parts.push("本期 PubMed 追蹤沒有匯入新文獻。");
			return parts.join("\n\n");
		}
		parts.push(`PubMed 追蹤本期匯入 **${p.total}** 篇（勾選看過 ${p.checked} 篇）：`);
		parts.push(p.days.map(d => `- ${link(d.link, d.date)}：${d.groups.map(g => `${g.name} ${g.total} 篇`).join("、")}`).join("\n"));
		return parts.join("\n\n");
	}

	function goalsSection(g) {
		let parts = ["## 問題與下次目標"];
		parts.push(`### ${REVIEW_GOALS_HEADING}`);
		parts.push(g.previous.length
			? g.previous.map(x => `- [${x.done ? "x" : " "}] ${x.text}`).join("\n")
			: (g.hasPrevious ? "上次報告沒有列出下次目標。" : "這是第一份報告。"));
		parts.push(`### ${QUESTIONS_HEADING}`);
		parts.push(g.questions.length ? g.questions.map((q, i) => `${i + 1}. ${q}`).join("\n") : PLACEHOLDER);
		parts.push(`### ${GOALS_HEADING}`);
		parts.push(g.next.length ? g.next.map(x => `- [${x.done ? "x" : " "}] ${x.text}`).join("\n") : PLACEHOLDER);
		return parts.join("\n\n");
	}

	/** The report's sections (only those selected) as Markdown with wikilinks. */
	function buildSections(facts, sections = {}) {
		let on = k => sections[k] !== false;
		let parts = [];
		if (on("reading")) parts.push(readingSection(facts.reading));
		if (on("reviews")) parts.push(reviewsSection(facts.reviews, facts.hasSnapshot));
		if (on("writing")) parts.push(writingSection(facts.writing));
		if (on("pubmed")) parts.push(pubmedSection(facts.pubmed));
		if (on("goals")) parts.push(goalsSection(facts.goals));
		return parts.join("\n\n");
	}

	/** Markdown → plain text for LINE/Email: no link syntax, callouts or bold; 【section】 headings and ・ bullets. */
	function toPlainText(md) {
		let out = [];
		let inCallout = false;
		for (let line of String(md || "").split(/\r?\n/)) {
			if (/^%%.*%%\s*$/.test(line)) continue;
			if (/^>\s*\[!/.test(line)) {
				inCallout = true;
				continue;
			}
			if (inCallout && /^>/.test(line)) continue;
			inCallout = false;
			let s = line
				.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
				.replace(/\[\[([^\]]*)\]\]/g, (m, t) => t.split("/").pop())
				.replace(/\*\*([^*]+)\*\*/g, "$1")
				.replace(/^##\s+(.*)$/, "【$1】")
				.replace(/^#{3,6}\s+(.*)$/, "■ $1")
				.replace(/^#\s+(.*)$/, "$1")
				.replace(/^(\s*)[-*]\s+\[[xX]\]\s+/, "$1☑ ")
				.replace(/^(\s*)[-*]\s+\[ \]\s+/, "$1☐ ")
				.replace(/^(\s*)[-*]\s+/, "$1・")
				.replace(/^>\s?/, "");
			out.push(s);
		}
		return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
	}

	/** Wikilinks as their text (Notion has no vault to link to). */
	function stripWikilinks(md) {
		return String(md || "")
			.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
			.replace(/\[\[([^\]]*)\]\]/g, (m, t) => t.split("/").pop());
	}

	// ---------- the optional AI paragraph (pure) ----------

	const SUMMARY_PROMPT = `你是護理研究所碩士生的研究助理。請根據 <facts> 中的進度資料，用臺灣學術繁體中文寫一段給指導教授看的「本期摘要」。

規則：
- 只能使用 <facts> 裡的事實與數字，不得加入新的研究發現、文獻內容、評價、推測或承諾；沒有資料的部分不要提。
- 數字照抄，不要換算、加總或四捨五入；文獻名稱可省略，不要自行翻譯標題。
- 依序簡述：閱讀與評讀、系統性回顧進度、寫作進度、新文獻追蹤；有「本次想討論的問題」時，最後一句點出要討論的事。
- 一段 120–220 字，語氣客觀精簡；不要標題、條列、粗體或引號，不要前言或結語說明。`;

	/** { system, user } for llm.generateText: the report's facts as plain text. */
	function buildSummaryPrompt(factsText, period) {
		return {
			system: SUMMARY_PROMPT,
			user: `<period>${period.start} 至 ${period.end}</period>\n<facts>\n${String(factsText || "").trim()}\n</facts>\n\n請依照系統指示撰寫本期摘要。`,
		};
	}

	/** Rough token count (CJK ≈ 1 token per character, other text ≈ 4 characters per token). */
	function estimateTokens(text) {
		let s = String(text || "");
		let cjk = (s.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length;
		return Math.ceil(cjk + (s.length - cjk) / 4);
	}

	/** { inputTokens, expected, max } in USD (null when the model is unpriced). */
	function estimateSummaryCost(prompt, model, prices) {
		let price = usage.priceFor(model, prices);
		let inputTokens = estimateTokens(prompt.system) + estimateTokens(prompt.user);
		if (!price) return { inputTokens, expected: null, max: null };
		return {
			inputTokens,
			expected: usage.costOf({ input: inputTokens, output: EXPECTED_OUTPUT_TOKENS }, price),
			max: usage.costOf({ input: inputTokens, output: MAX_OUTPUT_TOKENS }, price),
		};
	}

	function numbersIn(text) {
		return (String(text || "").normalize("NFKC").replace(/(\d),(\d{3})/g, "$1$2").match(/\d+(?:\.\d+)?/g) || [])
			.map(n => String(Number(n)));
	}

	/** The model's paragraph: one paragraph, no fence/heading/list; `unsupported` lists numbers that are not in the facts. */
	function processSummary(text, factsText) {
		let s = String(text || "").replace(/\r\n?/g, "\n").trim();
		let fence = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i.exec(s);
		if (fence) s = fence[1];
		let truncated = /^>\s*⚠️\s*輸出(?:達到長度上限|未完成).*$/m.test(s);
		s = s.replace(/^>\s*⚠️\s*輸出(?:達到長度上限|未完成).*$/gm, "")
			.split("\n")
			.filter(l => !/^#{1,6}\s/.test(l) && !/^\s*本期摘要[:：]?\s*$/.test(l))
			.map(l => l.replace(/^\s*(?:[-*•]\s+|\d+[.)]\s+)/, "").replace(/\*\*([^*]+)\*\*/g, "$1").trim())
			.filter(Boolean)
			.join("");
		let known = new Set(numbersIn(factsText));
		let unsupported = [...new Set(numbersIn(s).filter(n => !known.has(n)))];
		return { text: s, unsupported, truncated };
	}

	function summarySection(summary) {
		let lines = [`## ${SUMMARY_HEADING}`, "", summary.text];
		let notes = [`> [!note] 由 ${summary.model || "AI"} 依本報告列出的事實整理，沒有提供其他資料；送出前請確認內容與下列各節一致。`];
		if (summary.unsupported.length) notes.push(`> ⚠️ 摘要中的數字 ${summary.unsupported.join("、")} 在報告資料中找不到，請確認或刪除。`);
		if (summary.truncated) notes.push("> ⚠️ AI 輸出不完整，可能被截斷。");
		return lines.join("\n") + "\n\n" + notes.join("\n");
	}

	// ---------- the note and Pandoc (pure) ----------

	function shellQuote(s) {
		return /^[\p{L}\p{N}._\/@+-]+$/u.test(s) ? s : `"${String(s).replace(/(["\\$`])/g, "\\$1")}"`;
	}

	/** Where the report goes and the Pandoc command (with a reference .docx from Drafts when there is one). */
	function reportPaths(folderParts, date, referenceDoc) {
		let dirParts = [...folderParts, REPORT_FOLDER];
		let fileName = `${date}.md`;
		let docx = `進度報告-${date}.docx`;
		let ref = referenceDoc ? ` --reference-doc ${shellQuote(`../${DRAFTS_FOLDER}/${referenceDoc}`)}` : "";
		return {
			dirParts,
			fileName,
			relPath: [...dirParts, fileName].join("/"),
			link: [...dirParts, date].join("/"),
			docx,
			referenceDoc: referenceDoc || "",
			command: `pandoc ${shellQuote(fileName)} -f markdown+wikilinks_title_after_pipe --lua-filter ${FILTER_FILE}${ref} -o ${shellQuote(docx)}`,
		};
	}

	/** A reference .docx for Word styles among the Drafts files (e.g. a thesis template), "" if none. */
	function pickReferenceDoc(names) {
		let docx = (names || []).filter(n => /\.docx$/i.test(n) && !n.startsWith("~$")).sort();
		return docx.find(n => /^reference\.docx$/i.test(n)) || docx.find(n => /reference|範本|樣板|template/i.test(n)) || "";
	}

	const PANDOC_FILTER = `-- ZotMax：把進度報告轉成 Word 時，略過 Obsidian 註解（%% … %%）、提示框（> [!info] …）、
-- 「${PANDOC_HEADING}」「我的筆記」兩節，並把連到 vault 筆記的連結換成文字。這個檔案由插件產生，重新產生報告時會覆寫。
local SKIP = { "${PANDOC_HEADING}", "我的筆記" }

local function skipped(text)
  for _, word in ipairs(SKIP) do
    if text:find(word, 1, true) then return true end
  end
  return false
end

function Link(el)
  if not el.target:match("^%a[%w+.-]*:") then return el.content end
end

function Pandoc(doc)
  local out = {}
  local skipLevel = nil
  for _, b in ipairs(doc.blocks) do
    if b.t == "Header" then
      if skipLevel and b.level <= skipLevel then skipLevel = nil end
      if not skipLevel and skipped(pandoc.utils.stringify(b)) then skipLevel = b.level end
    end
    if not skipLevel then
      local text = pandoc.utils.stringify(b)
      local comment = (b.t == "Para" or b.t == "Plain") and text:sub(1, 2) == "%%"
      local callout = b.t == "BlockQuote" and text:sub(1, 2) == "[!"
      if not comment and not callout then table.insert(out, b) end
    end
  end
  doc.blocks = out
  return doc
end
`;

	function pandocSection(paths) {
		return [
			`## ${PANDOC_HEADING}`,
			"",
			`在這份筆記所在的資料夾（\`${paths.dirParts.join("/")}\`）開啟終端機執行：`,
			"",
			"```bash",
			paths.command,
			"```",
			"",
			`- \`${FILTER_FILE}\`：插件放在同一資料夾，轉檔時略過 %% 標記、提示框、本節與「我的筆記」，並把筆記連結換成文字。`,
			paths.referenceDoc
				? `- \`--reference-doc\`：沿用 \`${DRAFTS_FOLDER}/${paths.referenceDoc}\` 的 Word 樣式；不需要可以拿掉。`
				: `- 想套用論文的 Word 樣式：把範本存成 \`${DRAFTS_FOLDER}/reference.docx\`，下次產生報告時指令會自動加上 \`--reference-doc\`。`,
		].join("\n");
	}

	/**
	 * The managed region. meta: { period, previous: { date, link } | null, paths, generatedAt }
	 */
	function buildRegion(sectionsMd, summary, meta) {
		let p = meta.period;
		let info = [`> [!info] 報告期間 ${p.start} 至 ${p.end}`
			+ (meta.previous ? `（上次報告：${link(meta.previous.link, meta.previous.date)}）` : "（第一份報告）")
			+ `。由 ZotMax 於 ${String(meta.generatedAt || "").slice(0, 10)} 依 Zotero 與 vault 的資料產生${summary ? "，「本期摘要」由 AI 依這些資料整理" : "，沒有使用 AI"}。`,
		"> 要修改內容請寫在「✍️ 我的筆記」或另存；同一天重新產生時，這個區塊會被覆寫。"];
		return [
			MARK_START,
			info.join("\n"),
			summary ? summarySection(summary) : "",
			sectionsMd,
			pandocSection(meta.paths),
			core.MARK_END,
		].filter(Boolean).join("\n\n");
	}

	/**
	 * The report note. With `existing`, only the plugin's frontmatter keys and the managed region
	 * change; the user's text and keys stay.
	 * meta: { date, period, previous, generatedAt, model, notionUrl }
	 */
	function buildReportNote(existing, region, meta) {
		let managed = [
			["type", "advisor-progress-report"],
			["date", meta.date],
			["period_start", meta.period.start],
			["period_end", meta.period.end],
			["previous_report", meta.previous ? meta.previous.date : ""],
			["generated_at", meta.generatedAt || ""],
			["ai_model", meta.model || ""],
		];
		if (meta.notionUrl) managed.push(["notion", meta.notionUrl]);
		let split = existing ? core.splitFrontmatter(existing) : { frontmatter: null, body: null };
		// An empty value is written only to clear a key an earlier build set
		let has = k => core.parseFrontmatterBlocks(split.frontmatter || "").some(b => b.key === k);
		let fm = managed.filter(([k, v]) => v !== "" || has(k))
			.reduce((acc, [k, v]) => core.setFrontmatterValue(acc, k, v), split.frontmatter || "");
		let body = split.body;
		if (body === null) {
			body = `\n# 進度報告 ${meta.date}\n\n${region}\n\n${USER_SECTION}`;
		}
		else {
			let start = MARK_START_RE.exec(body);
			let end = MARK_END_RE.exec(body);
			if (start && end && end.index > start.index) {
				body = body.slice(0, start.index) + region + body.slice(end.index + end[0].length);
			}
			else {
				// Markers removed by the user: a fresh region after the first heading
				let h1 = /^# .*$/m.exec(body);
				let at = h1 ? h1.index + h1[0].length : 0;
				body = body.slice(0, at) + "\n\n" + region + "\n" + body.slice(at);
			}
			if (!body.startsWith("\n")) body = "\n" + body;
		}
		return `---\n${fm}\n---\n${body}`;
	}

	/** Clipboard text: title, period, the AI paragraph and the sections in plain text. */
	function buildPlainReport(sectionsMd, summary, meta) {
		let head = [`進度報告 ${meta.date}`, `報告期間：${meta.period.start} 至 ${meta.period.end}`];
		let parts = [head.join("\n")];
		if (summary) parts.push(`【本期摘要】\n${summary.text}`);
		parts.push(toPlainText(sectionsMd));
		return parts.join("\n\n");
	}

	/** Markdown for the Notion page (wikilinks as text, no Obsidian markers). */
	function buildNotionMarkdown(sectionsMd, summary, meta) {
		let parts = [`> 報告期間 ${meta.period.start} 至 ${meta.period.end}${meta.previous ? `（上次報告 ${meta.previous.date}）` : ""}。由 ZotMax 依 Zotero 與 Obsidian 的資料產生。`];
		if (summary) parts.push(`## ${SUMMARY_HEADING}\n\n${summary.text}`);
		parts.push(stripWikilinks(sectionsMd));
		return parts.join("\n\n");
	}

	// ---------- options (pure) ----------

	function parseOptions(text) {
		try {
			let o = JSON.parse(text || "{}");
			return o && typeof o === "object" && !Array.isArray(o) ? o : {};
		}
		catch (e) {
			return {};
		}
	}

	function sectionFlags(saved) {
		let out = {};
		for (let [k] of SECTIONS) out[k] = !(saved && saved[k] === false);
		return out;
	}

	// ---------- Zotero side ----------

	// Test hooks: { ask, now, copy }
	let runtime = {};

	function now() {
		return runtime.now ? runtime.now() : new Date();
	}

	function pref(key) {
		return Zotero.Prefs.get(PREF + key, true);
	}

	function setPref(key, value) {
		Zotero.Prefs.set(PREF + key, value, true);
	}

	function readStatusLog() {
		return parseStatusLog(pref(STATUS_LOG_PREF));
	}

	/** The day logging started ("" before); set to `today` the first time. */
	function logSince(today) {
		let since = String(pref(LOG_SINCE_PREF) || "");
		if (isDay(since)) return since;
		try {
			setPref(LOG_SINCE_PREF, today);
		}
		catch (e) {
			Zotero.logError(e);
		}
		return today;
	}

	/**
	 * status.js: an item's reading status changed from `from` to `to` (key "library/KEY"). Never throws;
	 * returns whether the log changed.
	 */
	function logStatusChange(key, from, to) {
		try {
			let today = localDate(now());
			logSince(today);
			let { log, changed } = appendStatusLog(readStatusLog(), key, from, to, today);
			if (changed) setPref(STATUS_LOG_PREF, JSON.stringify(log));
			return changed;
		}
		catch (e) {
			Zotero.logError(e);
			return false;
		}
	}

	function readHistory() {
		return parseHistory(pref(HISTORY_PREF));
	}

	async function children(dir) {
		try {
			return await IOUtils.getChildren(dir);
		}
		catch (e) {
			return [];
		}
	}

	/** The frontmatter text of a note (null if none), reading only its head when that suffices. */
	async function readFrontmatter(path) {
		let bytes = await IOUtils.read(path, { maxBytes: HEAD_BYTES });
		let text = new TextDecoder().decode(bytes).replace(/^\uFEFF/, "");
		let { frontmatter } = core.splitFrontmatter(text);
		if (frontmatter === null && bytes.length >= HEAD_BYTES && /^---\r?\n/.test(text)) {
			frontmatter = core.splitFrontmatter((await IOUtils.readUTF8(path)).replace(/^\uFEFF/, "")).frontmatter;
		}
		return frontmatter;
	}

	function folderParts(settings) {
		return core.splitFolder(settings.defaults.obsidianFolder);
	}

	/** Report notes in <folder>/進度報告: [{ date, path }] (files named YYYY-MM-DD.md), oldest first. */
	async function reportFiles(settings) {
		let dir = PathUtils.join(settings.vaultPath, ...folderParts(settings), REPORT_FOLDER);
		let out = [];
		for (let child of await children(dir)) {
			let m = /^(\d{4}-\d{2}-\d{2})\.md$/i.exec(PathUtils.filename(child));
			if (m && isDay(m[1])) out.push({ date: m[1], path: child });
		}
		return out.sort((a, b) => a.date.localeCompare(b.date));
	}

	/** Dashboard hook: the newest report { date, link } (null without a vault or a report). Never throws. */
	async function latestReport(settings) {
		try {
			if (!settings || !settings.vaultPath) return null;
			let files = await reportFiles(settings);
			let last = files[files.length - 1];
			return last ? { date: last.date, link: [...folderParts(settings), REPORT_FOLDER, last.date].join("/") } : null;
		}
		catch (e) {
			Zotero.logError(e);
			return null;
		}
	}

	/** Literature notes by zotero key: { key, link, title, status, dateAdded, aiGenerated, appraisalVerified }. */
	async function literature(settings) {
		let index = await scope.ZB.main.buildObsidianIndex(settings);
		let out = new Map();
		for (let [key, entries] of index) {
			let entry = entries[0];
			try {
				let fm = await readFrontmatter(entry.path);
				if (fm === null) continue;
				let f = dashboard.parseFrontmatter(fm);
				let text = v => (Array.isArray(v) ? v.join(", ") : String(v === undefined || v === null ? "" : v).trim());
				let relPath = entry.relParts.join("/");
				out.set(key, {
					key,
					link: relPath.replace(/\.md$/i, ""),
					title: text(f.title) || relPath.split("/").pop().replace(/\.md$/i, ""),
					status: text(f.status),
					deleted: text(f.status) === core.DELETED_STATUS || !!f.zotero_deleted,
					dateAdded: text(f.date_added),
					aiGenerated: text(f.ai_generated),
					appraisalVerified: text(f.appraisal_verified) === "true",
				});
			}
			catch (e) {
				Zotero.debug(`ZotMax: progress report skipped ${entry.path}: ${e}`);
			}
		}
		return out;
	}

	/** The Zotero item of "library/KEY" or "groups/ID/KEY" (null if gone). */
	function itemForKey(key) {
		let m = /^(?:library|groups\/(\d+))\/([A-Z0-9]+)$/i.exec(String(key || ""));
		if (!m) return null;
		let libraryID = m[1] ? Zotero.Groups.getLibraryIDFromGroupID(Number(m[1])) : Zotero.Libraries.userLibraryID;
		if (!libraryID) return null;
		return Zotero.Items.getByLibraryAndKey(libraryID, m[2]) || null;
	}

	/** Appraisal forms (appraisal-form.js) marked verified in the period, among notes with appraisal_verified. */
	function verifiedAppraisals(records, period) {
		let ZB = scope.ZB;
		let out = [];
		if (!ZB.appraisalForm) return out;
		for (let r of records) {
			if (!r.appraisalVerified) continue;
			try {
				let item = itemForKey(r.key);
				let record = item ? ZB.appraisalForm.loadRecord(item) : null;
				if (!record || !record.verified || !inPeriod(record.verifiedAt, period)) continue;
				let tool = ZB.appraisalTools && ZB.appraisalTools.getTool(record.tool);
				out.push(Object.assign({}, r, { date: toLocalDay(record.verifiedAt), tool: tool ? tool.name : "", overall: record.overall || "" }));
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
		return out.sort((a, b) => b.date.localeCompare(a.date));
	}

	async function projectNotes(settings, sub) {
		let dirParts = [...folderParts(settings), sub];
		let out = [];
		for (let child of await children(PathUtils.join(settings.vaultPath, ...dirParts))) {
			let name = PathUtils.filename(child);
			if (name.startsWith(".")) continue;
			out.push({ path: child, name, relPath: [...dirParts, name].join("/") });
		}
		return out;
	}

	async function reviewRecords(settings) {
		let out = [];
		for (let f of await projectNotes(settings, REVIEW_FOLDER)) {
			if (!/\.md$/i.test(f.name)) continue;
			try {
				let r = reviewRecord((await readFrontmatter(f.path)) || "", f.relPath);
				if (PRISMA_FIELDS.some(([k]) => r[k] !== null)) out.push(r);
			}
			catch (e) {
				Zotero.debug(`ZotMax: progress report skipped ${f.path}: ${e}`);
			}
		}
		return out.sort((a, b) => a.title.localeCompare(b.title, "zh-Hant"));
	}

	/** { drafts: draftRecord()[], referenceDoc } */
	async function draftRecords(settings) {
		let drafts = [];
		let names = [];
		for (let f of await projectNotes(settings, DRAFTS_FOLDER)) {
			names.push(f.name);
			if (!/\.md$/i.test(f.name)) continue;
			try {
				let stat = await IOUtils.stat(f.path);
				drafts.push(draftRecord(await IOUtils.readUTF8(f.path), f.relPath, stat && stat.lastModified));
			}
			catch (e) {
				Zotero.debug(`ZotMax: progress report skipped ${f.path}: ${e}`);
			}
		}
		drafts.sort((a, b) => (b.modified || "").localeCompare(a.modified || "") || a.name.localeCompare(b.name, "zh-Hant"));
		return { drafts, referenceDoc: pickReferenceDoc(names) };
	}

	async function digests(settings, period) {
		let dirParts = [...folderParts(settings), DIGEST_FOLDER];
		let out = [];
		for (let child of await children(PathUtils.join(settings.vaultPath, ...dirParts))) {
			let m = /^(\d{4}-\d{2}-\d{2})\.md$/i.exec(PathUtils.filename(child));
			if (!m || !inPeriod(m[1], period)) continue;
			try {
				let groups = digestSummary(await IOUtils.readUTF8(child));
				if (groups.length) out.push({ date: m[1], link: [...dirParts, m[1]].join("/"), groups });
			}
			catch (e) {
				Zotero.debug(`ZotMax: progress report skipped ${child}: ${e}`);
			}
		}
		return out.sort((a, b) => a.date.localeCompare(b.date));
	}

	/**
	 * Everything the report shows, read from the vault, the prefs and Zotero.
	 * ctx: { period, previous: { date, link, path } | null, previousEntry, answer, currentNote }
	 */
	async function collectFacts(settings, ctx) {
		let { period, answer } = ctx;
		let records = [...(await literature(settings)).values()].filter(r => !r.deleted);
		let byKey = new Map(records.map(r => [r.key, r]));
		let log = readStatusLog();
		let finished = readingChanges(log, period).map((c) => {
			let r = byKey.get(c.key);
			let item = r ? null : itemForKey(c.key);
			return Object.assign({}, c, {
				link: r ? r.link : "",
				title: r ? r.title : (item && item.getField("title")) || c.key,
			});
		});
		let byDay = field => records.filter(r => inPeriod(r[field], period))
			.map(r => Object.assign({}, r, { date: toLocalDay(r[field]) }))
			.sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
		let since = logSince(ctx.date || localDate(now()));

		let reviews = await reviewRecords(settings);
		let prev = ctx.previousEntry;
		let { drafts, referenceDoc } = await draftRecords(settings);
		let updated = drafts.filter(d => draftUpdated(d, period)).map(d => Object.assign({}, d, {
			generatedInPeriod: inPeriod(d.generatedAt, period),
			wordsDelta: prev && prev.drafts && Number.isFinite(prev.drafts[d.relPath]) ? d.words - prev.drafts[d.relPath] : null,
		}));
		let days = await digests(settings, period);

		let previousNote = "";
		if (ctx.previous && ctx.previous.path) {
			try {
				previousNote = await IOUtils.readUTF8(ctx.previous.path);
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
		let nextStates = new Map(parseChecklist(extractSection(ctx.currentNote || "", GOALS_HEADING)).map(g => [g.text, g.done]));
		return {
			reading: {
				finished,
				added: byDay("dateAdded"),
				aiNotes: byDay("aiGenerated"),
				appraisals: verifiedAppraisals(records, period),
				logSince: since <= period.start,
			},
			reviews: diffPrisma(reviews, prev ? prev.prisma : null),
			hasSnapshot: !!prev,
			reviewSnapshot: prismaSnapshot(reviews),
			writing: { total: drafts.length, updated },
			draftWords: Object.fromEntries(drafts.map(d => [d.relPath, d.words])),
			referenceDoc,
			pubmed: {
				days,
				total: days.reduce((n, d) => n + d.groups.reduce((m, g) => m + g.total, 0), 0),
				checked: days.reduce((n, d) => n + d.groups.reduce((m, g) => m + g.checked, 0), 0),
			},
			goals: {
				hasPrevious: !!ctx.previous,
				previous: carryOverGoals(previousNote, ctx.currentNote || ""),
				questions: parseLines(answer.questions),
				next: parseLines(answer.goals).map(text => ({ text, done: nextStates.get(text) || false })),
			},
		};
	}

	function notify(text) {
		scope.ZB.main.notify(DIALOG_TITLE, text);
	}

	const HTML_NS = "http://www.w3.org/1999/xhtml";

	/**
	 * The dialog: period, sections, questions, next goals, the optional AI paragraph and outputs.
	 * Resolves { period, sections, questions, goals, ai, copy, notion } or null (cancelled). Falls back
	 * to two Services.prompt fields (questions and goals, separated by 「；」) where a modal <dialog> can't be shown.
	 */
	function askOptions(win, init) {
		let doc = win && win.document;
		let dialog = null;
		try {
			dialog = doc.createElementNS(HTML_NS, "dialog");
		}
		catch (e) {}
		if (!dialog || typeof dialog.showModal !== "function") return Promise.resolve(askWithPrompts(win, init));
		return new Promise((resolve) => {
			let el = (tag, style, text) => {
				let e = doc.createElementNS(HTML_NS, tag);
				if (style) e.setAttribute("style", style);
				if (text !== undefined) e.textContent = text;
				return e;
			};
			let checkbox = (label, checked, disabled) => {
				let wrap = el("label", "display: block; margin: 3px 0;");
				let box = el("input");
				box.setAttribute("type", "checkbox");
				box.checked = !!checked;
				if (disabled) box.disabled = true;
				wrap.append(box, " " + label);
				return { wrap, box };
			};
			let area = (label, hint, value, placeholder) => {
				let wrap = el("label", "display: block; margin: 10px 0 0;");
				wrap.append(el("div", "font-weight: 600;", label), el("div", "opacity: 0.75; font-size: 0.92em; margin: 2px 0 4px;", hint));
				let a = el("textarea", "width: 100%; box-sizing: border-box; font: inherit; resize: vertical;");
				a.setAttribute("rows", "4");
				if (placeholder) a.setAttribute("placeholder", placeholder);
				a.value = value || "";
				wrap.append(a);
				return { wrap, area: a };
			};
			let date = (value) => {
				let input = el("input", "font: inherit;");
				input.setAttribute("type", "date");
				input.value = value;
				return input;
			};
			dialog.setAttribute("style", "width: min(640px, 92vw); padding: 16px 18px; border: 1px solid rgba(128,128,128,0.5); border-radius: 8px; background: Canvas; color: CanvasText; font: message-box;");
			let start = date(init.period.start);
			let end = date(init.period.end);
			let periodRow = el("div", "display: flex; align-items: center; gap: 6px; margin: 10px 0 2px;");
			periodRow.append(el("span", "font-weight: 600;", "報告期間"), start, el("span", "", "至"), end);
			let periodHint = el("div", "opacity: 0.75; font-size: 0.92em;", init.previousDate
				? `預設從上次報告（${init.previousDate}）開始。`
				: `還沒有報告，預設為近 ${DEFAULT_DAYS} 天。`);
			let sectionBoxes = SECTIONS.map(([k, label]) => [k, checkbox(label, init.sections[k] !== false)]);
			let sectionWrap = el("div", "margin: 10px 0 0;");
			sectionWrap.append(el("div", "font-weight: 600;", "包含的段落"), ...sectionBoxes.map(([, c]) => c.wrap));
			let questions = area(QUESTIONS_HEADING, "每行一個問題，會列在報告中。", init.questions, "例如：研究對象的納入條件要不要排除失智症病人？");
			let goals = area(GOALS_HEADING, "每行一個目標；下次產生報告時會變成「上次目標回顧」勾選清單。", init.goals, "例如：完成第二章文獻探討初稿\n標題摘要篩選完 50 篇");
			let ai = checkbox("加上 AI 寫的「本期摘要」（只依報告中的資料；會產生少量 API 費用，產生前會先確認）", false, !init.aiAvailable);
			let copy = checkbox("完成後複製純文字（貼到 LINE／Email）", init.copy !== false);
			let notion = checkbox("同時寫入 Notion 頁面（文獻比較表的 Notion 父頁面底下）", init.notion && init.notionAvailable, !init.notionAvailable);
			let outWrap = el("div", "margin: 10px 0 0;");
			outWrap.append(el("div", "font-weight: 600;", "其他"), ai.wrap, copy.wrap, notion.wrap);
			let buttons = el("div", "display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px;");
			let cancel = el("button", "", "取消");
			let ok = el("button", "font-weight: 600;", "產生報告");
			for (let b of [cancel, ok]) b.setAttribute("type", "button");
			buttons.append(cancel, ok);
			dialog.append(el("div", "font-size: 1.15em; font-weight: 600;", "產生進度報告（給指導教授）"),
				periodRow, periodHint, sectionWrap, questions.wrap, goals.wrap, outWrap, buttons);
			cancel.addEventListener("click", () => dialog.close("cancel"));
			ok.addEventListener("click", () => dialog.close("ok"));
			dialog.addEventListener("close", () => {
				let result = dialog.returnValue === "ok"
					? {
						period: normalizePeriod(start.value, end.value),
						sections: Object.fromEntries(sectionBoxes.map(([k, c]) => [k, c.box.checked])),
						questions: questions.area.value.replace(/\r\n?/g, "\n").trim(),
						goals: goals.area.value.replace(/\r\n?/g, "\n").trim(),
						ai: ai.box.checked && !ai.box.disabled,
						copy: copy.box.checked,
						notion: notion.box.checked && !notion.box.disabled,
					}
					: null;
				dialog.remove();
				resolve(result);
			}, { once: true });
			(doc.body || doc.documentElement).append(dialog);
			try {
				dialog.showModal();
			}
			catch (e) {
				Zotero.logError(e);
			}
			if (!dialog.open) {
				dialog.remove();
				resolve(askWithPrompts(win, init));
			}
		});
	}

	function askWithPrompts(win, init) {
		let questions = { value: parseLines(init.questions).join("；") };
		if (!Services.prompt.prompt(win, DIALOG_TITLE, `${QUESTIONS_HEADING}（以「；」分隔，可留空）`, questions, null, {})) return null;
		let goals = { value: parseLines(init.goals).join("；") };
		if (!Services.prompt.prompt(win, DIALOG_TITLE, `${GOALS_HEADING}（以「；」分隔，可留空）`, goals, null, {})) return null;
		let split = v => v.split(/[；;]/).map(s => s.trim()).filter(Boolean).join("\n");
		return {
			period: init.period, sections: init.sections, questions: split(questions.value), goals: split(goals.value),
			ai: false, copy: init.copy !== false, notion: !!(init.notion && init.notionAvailable),
		};
	}

	/** Tools menu: the dialog, then the report after any sync in progress. */
	async function run() {
		let ZB = scope.ZB;
		// 「進度報告」 off (the 研究生引導 preset)
		if (!featureOn("progressReport")) {
			ZB.main.notifyFeatureOff("progressReport");
			return null;
		}
		let settings;
		try {
			settings = await ZB.main.readSettings();
		}
		catch (e) {
			notify(`設定有誤：${e.message || e}`);
			return null;
		}
		if (!settings.vaultPath) {
			notify("進度報告寫在 Obsidian：請先到 設定 → ZotMax 填入 Obsidian vault 路徑。");
			return null;
		}
		let at = now();
		let today = localDate(at);
		let files = await reportFiles(settings);
		let history = readHistory();
		let prevDate = previousReportDate([...files.map(f => f.date), ...history.map(h => h.date)], today);
		let current = files.find(f => f.date === today);
		let currentNote = current ? await IOUtils.readUTF8(current.path) : "";
		let period = defaultPeriod(at, prevDate);
		if (currentNote) {
			let fm = core.splitFrontmatter(currentNote).frontmatter || "";
			let s = core.frontmatterScalar(fm, "period_start");
			if (isDay(s)) period = normalizePeriod(s, core.frontmatterScalar(fm, "period_end") || today, at);
		}
		let saved = parseOptions(pref(OPTIONS_PREF));
		let notionAvailable = !!(settings.notionToken && settings.notionSynthesisParent);
		let init = {
			period: { start: period.start, end: period.end },
			previousDate: prevDate,
			sections: sectionFlags(saved.sections),
			questions: currentNote ? parseLines(extractSection(currentNote, QUESTIONS_HEADING)).join("\n") : "",
			goals: currentNote ? parseChecklist(extractSection(currentNote, GOALS_HEADING)).map(g => g.text).join("\n") : "",
			aiAvailable: !!settings.llm.apiKey,
			copy: saved.copy !== false,
			notion: saved.notion === true,
			notionAvailable,
		};
		let answer = await (runtime.ask || askOptions)(Zotero.getMainWindow(), init);
		if (!answer) return null;
		answer.period = normalizePeriod(answer.period && answer.period.start, answer.period && answer.period.end, at);
		answer.sections = sectionFlags(answer.sections);
		try {
			setPref(OPTIONS_PREF, JSON.stringify({ sections: answer.sections, copy: !!answer.copy, notion: !!answer.notion }));
		}
		catch (e) {
			Zotero.logError(e);
		}
		let prevFile = files.filter(f => f.date === prevDate)[0];
		let previous = prevDate ? { date: prevDate, link: [...folderParts(settings), REPORT_FOLDER, prevDate].join("/"), path: prevFile ? prevFile.path : "" } : null;
		return ZB.main.enqueue(() => generate(settings, answer, { date: today, previous, previousEntry: previousEntry(history, today), currentNote }));
	}

	function confirmText(settings, prompt) {
		let lines = [`將用 ${settings.llm.model} 依報告中的資料寫一段「本期摘要」，會產生一次 API 費用。`];
		try {
			let est = estimateSummaryCost(prompt, settings.llm.model, usage.parsePrices(pref("usage.prices")).prices);
			lines.push(est.expected === null
				? `輸入約 ${usage.formatTokens(est.inputTokens)} tokens（這個模型沒有價格資料，無法估算費用）。`
				: `預估費用：約 ${usage.formatUSD(est.expected)}（輸入約 ${usage.formatTokens(est.inputTokens)} tokens、輸出以約 ${usage.formatTokens(EXPECTED_OUTPUT_TOKENS)} tokens 估算；最多約 ${usage.formatUSD(est.max)}）。`);
		}
		catch (e) {
			Zotero.logError(e);
		}
		lines.push("", "要繼續嗎？（取消：報告照常產生，只是沒有 AI 摘要）");
		return lines.join("\n");
	}

	async function aiSummary(settings, factsText, period, line, runTotals, notes) {
		let ZB = scope.ZB;
		if (!settings.llm.apiKey) {
			notes.push("沒有設定 LLM API key，報告不含 AI 摘要。");
			return null;
		}
		let prompt = buildSummaryPrompt(factsText, period);
		if (!Services.prompt.confirm(Zotero.getMainWindow(), "ZotMax", confirmText(settings, prompt))) {
			notes.push("已取消 AI 摘要，報告不含「本期摘要」。");
			return null;
		}
		line.setText("AI 整理本期摘要中…");
		try {
			let result = await ZB.llm.generateText(settings.llm, prompt.system, prompt.user, (u, i) => fetch(u, i),
				Object.assign({ onRetry: ZB.main.retryStatus(s => line.setText(s)) }, ZB.main.runtime.retry));
			ZB.main.recordAIUsage(result, runTotals);
			let summary = Object.assign(processSummary(result.text, factsText), { model: result.model || settings.llm.model });
			if (!summary.text) {
				notes.push("⚠️ AI 沒有回傳摘要內容，報告不含「本期摘要」。");
				return null;
			}
			if (summary.unsupported.length) notes.push(`⚠️ AI 摘要中有報告資料裡找不到的數字（${summary.unsupported.join("、")}），請確認。`);
			return summary;
		}
		catch (e) {
			Zotero.logError(e);
			notes.push(`⚠️ AI 摘要失敗：${e.message || e}；報告其他部分照常產生。`);
			return null;
		}
	}

	async function writeNotion(settings, title, markdown, pageId) {
		let ZB = scope.ZB;
		let client = new ZB.notion.NotionClient({ token: settings.notionToken, fetch: (u, i) => fetch(u, i) });
		let page = null;
		if (pageId) {
			try {
				let p = await client.request("GET", `pages/${pageId}`);
				if (p && !p.in_trash && !p.archived) page = p;
			}
			catch (e) {
				if (!(e.status === 404 || e.status === 400)) throw e;
			}
		}
		if (!page) page = await client.createChildPage(settings.notionSynthesisParent, title, [], "📋");
		await client.replaceManagedContainer(page.id, NOTION_CONTAINER_TITLE, ZB.markdown.mdToNotionBlocks(markdown));
		return { id: page.id, url: page.url || "" };
	}

	function copyText(text) {
		if (runtime.copy) return runtime.copy(text);
		Zotero.Utilities.Internal.copyTextToClipboard(text);
		return true;
	}

	async function writeIfChanged(path, text) {
		if (await IOUtils.exists(path) && await IOUtils.readUTF8(path) === text) return false;
		await IOUtils.writeUTF8(path, text);
		return true;
	}

	/** Build and write the report; returns { relPath, text, plain, facts, summary } or null on failure. */
	async function generate(settings, answer, ctx) {
		let ZB = scope.ZB;
		let title = `進度報告 ${ctx.date}`;
		let pw = new Zotero.ProgressWindow({ closeOnClick: true });
		pw.changeHeadline(DIALOG_TITLE);
		pw.show();
		let line = new pw.ItemProgress("note", "整理本期資料…");
		let notes = [];
		let errors = [];
		try {
			let period = answer.period;
			let facts = await collectFacts(settings, Object.assign({ period, answer }, ctx));
			let sectionsMd = buildSections(facts, answer.sections);
			let runTotals = { ledger: {} };
			let summary = answer.ai ? await aiSummary(settings, toPlainText(sectionsMd), period, line, runTotals, notes) : null;

			let paths = reportPaths(folderParts(settings), ctx.date, facts.referenceDoc);
			let generatedAt = new Date().toISOString();
			let meta = { date: ctx.date, period, previous: ctx.previous, generatedAt, paths, model: summary ? summary.model : "" };
			let history = readHistory();
			let saved = history.find(h => h.date === ctx.date) || {};
			let outputs = [];

			if (answer.notion && settings.notionToken && settings.notionSynthesisParent) {
				line.setText("寫入 Notion…");
				try {
					let page = await writeNotion(settings, title, buildNotionMarkdown(sectionsMd, summary, meta), saved.notionPageId);
					meta.notionUrl = page.url;
					saved.notionPageId = page.id;
					outputs.push("Notion");
				}
				catch (e) {
					errors.push(`Notion：${e.message || e}`);
				}
			}

			line.setText("寫入 Obsidian…");
			let dir = PathUtils.join(settings.vaultPath, ...paths.dirParts);
			await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
			let path = PathUtils.join(dir, paths.fileName);
			let existing = (await IOUtils.exists(path)) ? await IOUtils.readUTF8(path) : null;
			let text = buildReportNote(existing, buildRegion(sectionsMd, summary, meta), meta);
			await IOUtils.writeUTF8(path, text);
			await writeIfChanged(PathUtils.join(dir, FILTER_FILE), PANDOC_FILTER);
			outputs.unshift(`Obsidian（${paths.relPath}）`);

			try {
				setPref(HISTORY_PREF, JSON.stringify(updateHistory(history, {
					date: ctx.date, relPath: paths.relPath, periodStart: period.start, periodEnd: period.end,
					prisma: facts.reviewSnapshot, drafts: facts.draftWords, notionPageId: saved.notionPageId || "",
				})));
			}
			catch (e) {
				Zotero.logError(e);
				notes.push(`⚠️ 無法記錄這次的 PRISMA 與字數快照：${e.message || e}`);
			}

			let plain = buildPlainReport(sectionsMd, summary, meta);
			if (answer.copy) {
				try {
					copyText(plain);
					notes.push("已複製純文字版，可以直接貼到 LINE 或 Email。");
				}
				catch (e) {
					Zotero.logError(e);
					notes.push(`⚠️ 無法複製到剪貼簿：${e.message || e}`);
				}
			}

			line.setText(`${title} — 已寫入 ${outputs.join("、")}`);
			if (errors.length) {
				line.setError();
				errors.forEach(e => Zotero.logError(new Error(e)));
				pw.addDescription(errors.join("\n"));
			}
			else {
				line.setProgress(100);
			}
			let r = facts.reading;
			pw.addDescription(`期間 ${period.start} 至 ${period.end}：讀完 ${r.finished.length} 篇、新加入 ${r.added.length} 篇、核對評讀 ${r.appraisals.length} 篇、更新草稿 ${facts.writing.updated.length} 份。`);
			for (let n of notes) pw.addDescription(n);
			let usageLine = ZB.main.runUsageLine(runTotals);
			if (usageLine) pw.addDescription(usageLine);
			pw.startCloseTimer(errors.length ? 20000 : 10000);
			// The dashboard links to the newest report (afterSync never throws)
			await ZB.dashboard.afterSync(settings);
			return { relPath: paths.relPath, text, plain, facts, summary, errors };
		}
		catch (e) {
			Zotero.logError(e);
			line.setText(`失敗：${e.message || e}`);
			line.setError();
			pw.startCloseTimer(20000);
			return null;
		}
	}

	// Feature switches (features.js): checked live; always on when this file runs without them (Node tests)
	function featureOn(id) {
		let f = scope.ZB && scope.ZB.features;
		return !f || f.isEnabled(id);
	}

	const api = {
		STATUS_LOG_PREF, HISTORY_PREF, OPTIONS_PREF, REPORT_FOLDER, FILTER_FILE, PANDOC_FILTER, SECTIONS, LOG_LIMITS, SUMMARY_PROMPT,
		// pure
		localDate, addDays, toLocalDay, inPeriod, defaultPeriod, normalizePeriod, previousReportDate,
		parseStatusLog, capStatusLog, appendStatusLog, readingChanges,
		parseHistory, updateHistory, previousEntry, reviewRecord, prismaSnapshot, diffPrisma,
		userText, countWords, draftRecord, digestSummary,
		parseLines, extractSection, parseChecklist, carryOverGoals,
		buildSections, toPlainText, stripWikilinks, buildSummaryPrompt, estimateSummaryCost, processSummary,
		reportPaths, pickReferenceDoc, buildRegion, buildReportNote, buildPlainReport, buildNotionMarkdown,
		// Zotero
		runtime, logStatusChange, latestReport, collectFacts, askOptions, askWithPrompts, run,
	};
	return api;
});
