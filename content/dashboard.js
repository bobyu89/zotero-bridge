/*
 * Zotero Bridge — research dashboard (研究儀表板) in Obsidian.
 *
 * `<folder>/研究儀表板.md` sums up the vault's literature notes: reading progress (with a Mermaid
 * pie chart), evidence overview, a to-do list (longest unread, data-quality issues), review
 * projects (Reviews/*.md PRISMA counts, Drafts/*.md), AI usage from the ledger and this week's
 * additions. It is rebuilt from the notes' frontmatter only (no network, no AI), from the Tools
 * menu and after each manual sync. Only the %% zotero-bridge:start/end %% block is rewritten.
 * `<folder>/研究儀表板.base` adds Bases views; like the other .base file it is created once and
 * never overwritten. Everything works in plain Obsidian (Mermaid, Bases, links), no plugins.
 *
 * The helpers at the top are pure (Node tests); the rest needs Zotero.
 */
(function (root, factory) {
	if (typeof module === "object" && module.exports) {
		module.exports = factory(require("./core.js"), require("./apa-zh.js"), require("./usage.js"), require("./scanned.js"), globalThis);
	}
	else {
		(root.ZB = root.ZB || {}).dashboard = factory(root.ZB.core, root.ZB.apaZh, root.ZB.usage, root.ZB.scanned, root);
	}
})(this, function (core, apaZh, usage, scanned, scope) {
	const PREF = "extensions.zotero-bridge.";
	const NOTE_NAME = "研究儀表板";
	const BASE_NAME = "研究儀表板.base";
	const REVIEW_FOLDER = "Reviews";
	const DRAFTS_FOLDER = "Drafts";
	const NO_VALUE = "（未填）";
	const NO_COLLECTION = "（未分類）";
	const NO_STATUS = "（未設定）";
	const READ_STATUSES = ["已讀", "已引用"];
	const DAY_MS = 86400000;
	const MAX_COLLECTIONS = 30;
	const MAX_UNREAD = 10;
	const MAX_ISSUES = 20;
	const MAX_NEW = 30;
	const USAGE_MONTHS = 3;
	// Enough for the plugin's frontmatter; a longer one is read whole
	const HEAD_BYTES = 16384;
	const USER_SECTION = "## ✍️ 我的筆記\n\n";
	const MARK_START_RE = /^%% zotero-bridge:start.*%%[ \t]*$/m;
	const MARK_END_RE = /^%% zotero-bridge:end %%[ \t]*$/m;
	const ISSUE_LABELS = {
		noAI: "無 AI 筆記",
		scanned: "掃描檔待 OCR",
		noDOI: "期刊文章缺 DOI",
		zhNames: "中文作者姓名可疑",
	};

	// ---------- frontmatter (pure) ----------

	function unquote(raw) {
		raw = String(raw).trim();
		if (/^"/.test(raw)) {
			try {
				return String(JSON.parse(raw));
			}
			catch (e) {}
		}
		return raw.replace(/^'(.*)'$/, "$1");
	}

	/** Every top-level key of a frontmatter: scalars as strings, block or inline lists as arrays. */
	function parseFrontmatter(fm) {
		let out = {};
		for (let block of core.parseFrontmatterBlocks(fm || "")) {
			if (!block.key) continue;
			let lines = block.text.split(/\r?\n/);
			let first = lines[0].slice(lines[0].indexOf(":") + 1).trim();
			if (!first) {
				let items = lines.slice(1).map(l => /^\s*-(?:\s+(.*))?$/.exec(l)).filter(Boolean);
				out[block.key] = items.length ? items.map(m => unquote(m[1] || "")).filter(Boolean) : "";
			}
			else if (/^\[.*\]$/.test(first)) {
				let inner = first.slice(1, -1).trim();
				let list;
				try {
					list = JSON.parse(first).map(String);
				}
				catch (e) {
					list = inner ? inner.split(",").map(unquote) : [];
				}
				out[block.key] = list.filter(Boolean);
			}
			else {
				out[block.key] = unquote(first);
			}
		}
		return out;
	}

	function asList(v) {
		if (Array.isArray(v)) return v;
		return v ? [String(v)] : [];
	}

	function asText(v) {
		return Array.isArray(v) ? v.join(", ") : String(v === undefined || v === null ? "" : v).trim();
	}

	/**
	 * Names that look wrong in a Chinese item's author list: the plugin writes Han names whole
	 * (陳美玲, apa-zh.js), so a comma or space inside one, a single character or Han mixed with
	 * Latin letters means the Zotero creator needs fixing.
	 */
	function suspectChineseNames(title, authors) {
		if (!apaZh || !apaZh.isChineseText(title)) return [];
		return asList(authors).filter((name) => {
			name = String(name).trim();
			if (!apaZh.isChineseText(name)) return false;
			let han = name.replace(/[^\p{Script=Han}]/gu, "");
			return /[,，\s]/.test(name) || han.length === 1 || /[A-Za-z]/.test(name);
		});
	}

	/** One literature note, from its frontmatter. relPath is vault-relative ("Zotero/x.md"). */
	function noteRecord(fm, relPath) {
		let f = typeof fm === "string" ? parseFrontmatter(fm) : (fm || {});
		let name = String(relPath).split("/").pop().replace(/\.md$/i, "");
		let title = asText(f.title) || name;
		let authors = asList(f.authors);
		let status = asText(f.status);
		return {
			relPath,
			link: String(relPath).replace(/\.md$/i, ""),
			name,
			title,
			authors,
			year: asText(f.year),
			itemType: asText(f.item_type),
			doi: asText(f.doi),
			status,
			deleted: status === core.DELETED_STATUS || !!f.zotero_deleted,
			collections: asList(f.collections),
			fullText: asText(f.full_text),
			studyDesign: asText(f.study_design),
			evidenceLevel: asText(f.evidence_level),
			jbiLevel: asText(f.jbi_level),
			appraisal: asText(f.appraisal_overall),
			hasAI: !!(asText(f.ai_model) || asText(f.ai_generated)),
			hasStudyData: ["study_design", "evidence_level", "jbi_level", "sample_size", "appraisal_overall"].some(k => asText(f[k])),
			dateAdded: asText(f.date_added),
			suspectNames: suspectChineseNames(title, authors),
		};
	}

	/** A review (Reviews/*.md) or draft (Drafts/*.md) note, from its frontmatter. */
	function projectRecord(fm, relPath) {
		let f = typeof fm === "string" ? parseFrontmatter(fm) : (fm || {});
		let num = (k) => {
			let n = Number(asText(f[k]));
			return asText(f[k]) !== "" && Number.isFinite(n) ? n : null;
		};
		let name = String(relPath).split("/").pop().replace(/\.md$/i, "");
		return {
			relPath,
			link: String(relPath).replace(/\.md$/i, ""),
			name,
			title: asText(f.title) || name,
			type: asText(f.type),
			scope: asText(f.scope),
			sources: asList(f.sources).length,
			generatedAt: asText(f.generated_at) || asText(f.last_generated),
			prisma: {
				identified: num("prisma_identified"),
				duplicates: num("prisma_duplicates"),
				screened: num("prisma_screened"),
				assessed: num("prisma_assessed"),
				included: num("prisma_included"),
				awaiting: (num("prisma_awaiting_screening") || 0) + (num("prisma_awaiting_fulltext") || 0),
			},
		};
	}

	// ---------- aggregation (pure) ----------

	function countBy(records, fn) {
		let counts = new Map();
		for (let r of records) {
			for (let k of [].concat(fn(r))) counts.set(k, (counts.get(k) || 0) + 1);
		}
		return counts;
	}

	// Most first; the "not filled in" bucket last
	function sortedCounts(map, last = NO_VALUE, compare) {
		return [...map].sort((a, b) => {
			if (a[0] === last) return 1;
			if (b[0] === last) return -1;
			return compare ? compare(a[0], b[0]) : b[1] - a[1] || a[0].localeCompare(b[0], "zh-Hant");
		});
	}

	function dateOf(iso) {
		let t = Date.parse(iso);
		return Number.isFinite(t) ? t : null;
	}

	function percent(n, total) {
		return total ? Math.round((n / total) * 100) : 0;
	}

	function isScanned(r) {
		return r.fullText === "none" || r.fullText === "partial";
	}

	function issuesOf(r) {
		let issues = [];
		if (!r.hasAI) issues.push("noAI");
		if (isScanned(r)) issues.push("scanned");
		if (r.itemType === "journalArticle" && !r.doi) issues.push("noDOI");
		if (r.suspectNames.length) issues.push("zhNames");
		return issues;
	}

	/**
	 * Everything the dashboard shows about the literature notes.
	 * @param {object[]} records noteRecord()s
	 * @param {object} opts { now: Date }
	 */
	function aggregate(records, opts = {}) {
		let now = (opts.now || new Date()).getTime();
		let deleted = records.filter(r => r.deleted);
		let notes = records.filter(r => !r.deleted);
		let total = notes.length;

		let statusMap = countBy(notes, r => r.status || NO_STATUS);
		let statuses = core.STATUSES.map(s => [s, statusMap.get(s) || 0]);
		for (let [s, n] of sortedCounts(statusMap, NO_STATUS)) {
			if (!core.STATUSES.includes(s)) statuses.push([s, n]);
		}
		let read = notes.filter(r => READ_STATUSES.includes(r.status)).length;

		let collections = new Map();
		for (let r of notes) {
			for (let c of r.collections.length ? r.collections : [NO_COLLECTION]) {
				let row = collections.get(c) || { name: c, total: 0, read: 0, byStatus: {} };
				row.total++;
				if (READ_STATUSES.includes(r.status)) row.read++;
				let s = r.status || NO_STATUS;
				row.byStatus[s] = (row.byStatus[s] || 0) + 1;
				collections.set(c, row);
			}
		}
		let collectionRows = [...collections.values()].sort((a, b) => {
			if (a.name === NO_COLLECTION) return 1;
			if (b.name === NO_COLLECTION) return -1;
			return b.total - a.total || a.name.localeCompare(b.name, "zh-Hant");
		});

		let levelOrder = (a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
		let fullText = new Map([["ok", 0], ["partial", 0], ["none", 0], ["no_pdf", 0], ["", 0]]);
		for (let r of notes) {
			let k = fullText.has(r.fullText) ? r.fullText : "";
			fullText.set(k, fullText.get(k) + 1);
		}

		let byAdded = (a, b) => (dateOf(a.dateAdded) || 0) - (dateOf(b.dateAdded) || 0) || a.title.localeCompare(b.title);
		let unread = notes.filter(r => r.status === core.STATUSES[0]).sort(byAdded);

		let withIssues = notes.map(r => ({ record: r, issues: issuesOf(r) })).filter(x => x.issues.length)
			.sort((a, b) => b.issues.length - a.issues.length || byAdded(a.record, b.record));
		let issueCounts = {};
		for (let k of Object.keys(ISSUE_LABELS)) issueCounts[k] = withIssues.filter(x => x.issues.includes(k)).length;

		let weekAgo = now - 7 * DAY_MS;
		let added = notes.filter(r => (dateOf(r.dateAdded) || 0) >= weekAgo).sort((a, b) => byAdded(b, a));

		return {
			total,
			deleted: deleted.length,
			statuses,
			read,
			readPercent: percent(read, total),
			collections: collectionRows,
			designs: sortedCounts(countBy(notes, r => r.studyDesign || NO_VALUE)),
			levels: sortedCounts(countBy(notes, r => r.evidenceLevel || NO_VALUE), NO_VALUE, levelOrder),
			jbiLevels: sortedCounts(countBy(notes, r => r.jbiLevel || NO_VALUE), NO_VALUE, levelOrder),
			appraisals: sortedCounts(countBy(notes, r => r.appraisal || NO_VALUE)),
			withAI: notes.filter(r => r.hasAI).length,
			withStudyData: notes.filter(r => r.hasStudyData).length,
			fullText: [...fullText],
			unread,
			issues: withIssues,
			issueCounts,
			added,
			now,
		};
	}

	/** The last `months` months of the ledger (current first): [{ month, summary }] and their total. */
	function usageReport(ledger, prices, opts = {}) {
		let now = opts.now || new Date();
		let months = [];
		let total = { calls: 0, tokens: 0, cost: 0, unpricedCalls: 0 };
		for (let i = 0; i < (opts.months || USAGE_MONTHS); i++) {
			let key = usage.monthKey(new Date(now.getFullYear(), now.getMonth() - i, 1));
			let s = usage.summarize((ledger || {})[key], prices);
			months.push({ month: key, summary: s });
			total.calls += s.calls;
			total.tokens += s.tokens;
			total.cost += s.cost;
			total.unpricedCalls += s.unpricedCalls;
		}
		return { months, total };
	}

	// ---------- Markdown (pure) ----------

	function cell(v) {
		return String(v === undefined || v === null ? "" : v).replace(/\r?\n+/g, " ").replace(/\|/g, "\\|").trim();
	}

	function table(header, rows) {
		return [
			`| ${header.map(cell).join(" | ")} |`,
			`|${header.map((h, i) => (i ? " ---: " : " --- ")).join("|")}|`,
			...rows.map(r => `| ${r.map(cell).join(" | ")} |`),
		].join("\n");
	}

	/** [[path|title]] for a list item (not inside a table) */
	function wikilink(target, text) {
		let label = String(text || "").replace(/\s+/g, " ").trim();
		if (label.length > 80) label = label.slice(0, 79) + "…";
		label = label.replace(/\|/g, "｜").replace(/\[/g, "(").replace(/\]/g, ")");
		return label && label !== target ? `[[${target}|${label}]]` : `[[${target}]]`;
	}

	function day(iso) {
		return String(iso || "").slice(0, 10);
	}

	function mermaidText(s) {
		return String(s).replace(/"/g, "'").replace(/[\r\n]+/g, " ");
	}

	/** Mermaid pie chart of the reading statuses ("" when there is nothing to draw). */
	function buildStatusPie(statuses) {
		let slices = statuses.filter(([, n]) => n > 0);
		if (!slices.length) return "";
		return [
			"```mermaid",
			"pie showData",
			"    title 閱讀狀態",
			...slices.map(([s, n]) => `    "${mermaidText(s)}" : ${n}`),
			"```",
		].join("\n");
	}

	function progressSection(stats) {
		if (!stats.total) return "## 📖 閱讀進度\n\n還沒有同步到 Obsidian 的文獻筆記。";
		let parts = ["## 📖 閱讀進度"];
		parts.push(`共 **${stats.total}** 篇文獻，已讀完成率 **${stats.readPercent}%**（已讀 + 已引用 ${stats.read} 篇）。`
			+ (stats.deleted ? ` 另有 ${stats.deleted} 篇已從 Zotero 刪除，不列入計算。` : ""));
		parts.push(table(["狀態", "篇數", "比例"], stats.statuses.map(([s, n]) => [s, n, `${percent(n, stats.total)}%`])));
		let pie = buildStatusPie(stats.statuses);
		if (pie) parts.push(pie);
		parts.push("### 各分類進度");
		let rows = stats.collections.slice(0, MAX_COLLECTIONS).map(c => [
			c.name, c.total, ...core.STATUSES.map(s => c.byStatus[s] || 0), `${percent(c.read, c.total)}%`,
		]);
		parts.push(table(["分類", "篇數", ...core.STATUSES, "完成率"], rows));
		if (stats.collections.length > MAX_COLLECTIONS) parts.push(`（另有 ${stats.collections.length - MAX_COLLECTIONS} 個分類未列出）`);
		parts.push("一篇文獻在多個分類時，每個分類都會計入。");
		return parts.join("\n\n");
	}

	function evidenceSection(stats) {
		if (!stats.total) return "## 🔬 證據概況\n\n（尚無資料）";
		let fullTextLabel = code => (code ? `${code}：${(scanned && scanned.STATUS_LABELS[code]) || code}` : "尚未判斷");
		let scannedCount = stats.fullText.filter(([k]) => k === "none" || k === "partial").reduce((a, [, n]) => a + n, 0);
		let parts = ["## 🔬 證據概況"];
		parts.push([
			`- 有 AI 文獻筆記：**${stats.withAI}** 篇；沒有：**${stats.total - stats.withAI}** 篇`,
			`- 有結構化研讀資料（研究設計、證據等級等）：**${stats.withStudyData}** 篇；沒有：**${stats.total - stats.withStudyData}** 篇`,
			`- 掃描檔（全文 none／partial，建議先 OCR 再產生 AI 筆記）：**${scannedCount}** 篇`,
		].join("\n"));
		parts.push("### 研究設計");
		parts.push(table(["研究設計", "篇數"], stats.designs));
		parts.push("### 證據等級（Oxford CEBM 2011）");
		parts.push(table(["證據等級", "篇數"], stats.levels));
		if (stats.jbiLevels.some(([k]) => k !== NO_VALUE)) {
			parts.push("### JBI 證據等級");
			parts.push(table(["JBI 等級", "篇數"], stats.jbiLevels));
		}
		parts.push("### 嚴格評讀整體結果");
		parts.push(table(["評讀結果", "篇數"], stats.appraisals));
		parts.push("### 全文狀態");
		parts.push(table(["全文", "篇數"], stats.fullText.map(([k, n]) => [fullTextLabel(k), n])));
		return parts.join("\n\n");
	}

	function todoSection(stats) {
		let parts = ["## 📝 待處理清單"];
		let now = stats.now;
		parts.push(`### 待讀最久（前 ${MAX_UNREAD} 篇）`);
		if (!stats.unread.length) {
			parts.push("沒有待讀的文獻。");
		}
		else {
			parts.push(stats.unread.slice(0, MAX_UNREAD).map((r) => {
				let t = dateOf(r.dateAdded);
				let when = t === null ? "加入日期不明" : `${day(r.dateAdded)} 加入（已 ${Math.max(0, Math.floor((now - t) / DAY_MS))} 天）`;
				return `- ${wikilink(r.link, r.title)} — ${when}`;
			}).join("\n") + (stats.unread.length > MAX_UNREAD ? `\n\n共 ${stats.unread.length} 篇待讀。` : ""));
		}
		parts.push("### ⚠️ 資料品質");
		if (!stats.issues.length) {
			parts.push("沒有發現資料品質問題。");
		}
		else {
			parts.push(Object.entries(ISSUE_LABELS).map(([k, label]) => `${label} ${stats.issueCounts[k]}`).join(" · "));
			parts.push(stats.issues.slice(0, MAX_ISSUES).map(({ record, issues }) => {
				let detail = issues.map(k => (k === "zhNames" ? `${ISSUE_LABELS[k]}（${record.suspectNames.join("、")}）` : ISSUE_LABELS[k]));
				return `- ⚠️ ${wikilink(record.link, record.title)}：${detail.join("、")}`;
			}).join("\n") + (stats.issues.length > MAX_ISSUES ? `\n\n（另有 ${stats.issues.length - MAX_ISSUES} 篇未列出）` : ""));
			parts.push("> [!tip] 怎麼補\n"
				+ "> - 無 AI 筆記：在 Zotero 選取文獻 → 右鍵 → Zotero Bridge → 同步（沒有 AI 筆記才產生）\n"
				+ "> - 掃描檔：用 OCR 工具替 PDF 加上文字層後重新同步，或讓 AI 直接讀 PDF（設定 → AI 文獻筆記 → 掃描版 PDF 直接傳給 AI 讀）\n"
				+ "> - 缺 DOI：在 Zotero 補上 DOI 欄位\n"
				+ "> - 中文作者姓名可疑：在 Zotero 把作者改成「姓／名」兩欄或單欄全名（例如 陳／美玲）");
		}
		return parts.join("\n\n");
	}

	function projectsSection(reviews, drafts) {
		let parts = ["## 🗂️ 回顧專案"];
		parts.push("### 系統性／範圍回顧（PRISMA）");
		if (!reviews.length) {
			parts.push("還沒有回顧專案：在 Zotero 的分類上按右鍵 → Zotero Bridge：系統性回顧篩選 → 產生 PRISMA 流程圖與證據表。");
		}
		else {
			parts.push(reviews.map((r) => {
				let p = r.prisma;
				let flow = [
					p.identified !== null ? `辨識 ${p.identified}` : "",
					p.screened !== null ? `篩選 ${p.screened}` : "",
					p.assessed !== null ? `全文評估 ${p.assessed}` : "",
				].filter(Boolean).join(" → ");
				let bits = [
					p.included !== null ? `納入 **${p.included}** 篇` : "",
					flow ? `（${flow}）` : "",
					p.awaiting ? `；尚待篩選 ${p.awaiting} 筆` : "",
					r.generatedAt ? ` · 更新於 ${day(r.generatedAt)}` : "",
				].join("");
				return `- ${wikilink(r.link, r.title)}${bits ? "：" + bits : ""}`;
			}).join("\n"));
		}
		parts.push("### 文獻探討草稿");
		if (!drafts.length) {
			parts.push("還沒有草稿：選取文獻或分類 → 右鍵 → 產生文獻探討草稿（AI）。");
		}
		else {
			parts.push(drafts.map((d) => {
				let bits = [d.sources ? `${d.sources} 篇文獻` : "", d.generatedAt ? `產生於 ${day(d.generatedAt)}` : ""].filter(Boolean).join(" · ");
				return `- ${wikilink(d.link, d.name)}${bits ? "：" + bits : ""}`;
			}).join("\n"));
		}
		return parts.join("\n\n");
	}

	function usageSection(report) {
		let parts = ["## 🤖 AI 用量"];
		if (!report || !report.total.calls) {
			parts.push(`近 ${USAGE_MONTHS} 個月沒有 AI 呼叫紀錄。`);
			return parts.join("\n\n");
		}
		let cost = s => (s.calls ? (s.priced ? usage.formatUSD(s.cost) + (s.unpricedCalls ? "（部分未定價）" : "") : "未定價") : "—");
		parts.push(table(["月份", "呼叫次數", "Tokens", "估計費用"], report.months.map(({ month, summary: s }, i) => [
			i ? month : `${month}（本月）`, s.calls, usage.formatTokens(s.tokens), cost(s),
		])));
		let current = report.months[0].summary;
		parts.push(`本月估計費用 **${current.calls ? cost(current) : usage.formatUSD(0)}**；近 ${USAGE_MONTHS} 個月合計 ${report.total.calls} 次呼叫，約 **${usage.formatUSD(report.total.cost)}**`
			+ `${report.total.unpricedCalls ? `（不含未定價模型的 ${report.total.unpricedCalls} 次呼叫）` : ""}。費用依 設定 → 本月 AI 用量 的價格表估算，實際以帳單為準。`);
		return parts.join("\n\n");
	}

	function newSection(stats) {
		let parts = ["## 🆕 本週新增"];
		if (!stats.added.length) {
			parts.push("這 7 天沒有新增文獻。");
		}
		else {
			parts.push(`這 7 天新增 **${stats.added.length}** 篇：`);
			parts.push(stats.added.slice(0, MAX_NEW).map(r => `- ${wikilink(r.link, r.title)} — ${day(r.dateAdded)} 加入${r.status ? `（${r.status}）` : ""}`).join("\n")
				+ (stats.added.length > MAX_NEW ? `\n\n（另有 ${stats.added.length - MAX_NEW} 篇未列出）` : ""));
		}
		return parts.join("\n\n");
	}

	function stamp(date) {
		let p = n => String(n).padStart(2, "0");
		return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
	}

	/**
	 * The managed region's content.
	 * meta: { now: Date, reviews, drafts, usage: usageReport(), baseLink: "Zotero/研究儀表板.base" | "", latestReport: { date, link } | null,
	 *   concepts: the 「🧠 熱門概念」 section (concepts.js) | "" }
	 */
	function buildDashboardSection(stats, meta = {}) {
		let info = [
			`> [!info] 由 Zotero Bridge 於 ${stamp(meta.now || new Date())} 依 vault 中的文獻筆記 frontmatter 產生；`
				+ "重新整理：Zotero 工具 → 更新研究儀表板（手動同步後也會自動更新）。這個區塊以外的內容不會被覆寫。",
		];
		if (meta.baseLink) info.push(`> Bases 檢視：[[${meta.baseLink}|${BASE_NAME}]]（證據等級表、掃描檔待 OCR、待讀（依分類））`);
		if (meta.latestReport) info.push(`> 最新進度報告（給指導教授）：[[${meta.latestReport.link}|${meta.latestReport.date}]]`);
		return [
			info.join("\n"),
			progressSection(stats),
			evidenceSection(stats),
			todoSection(stats),
			projectsSection(meta.reviews || [], meta.drafts || []),
			// 「🧠 熱門概念」 (concepts.js), when given
			...(meta.concepts ? [meta.concepts] : []),
			usageSection(meta.usage),
			newSection(stats),
		].join("\n\n");
	}

	/**
	 * The dashboard note. With `existing`, only `type`/`updated` in the frontmatter and the
	 * %% zotero-bridge:start/end %% block change; everything else is the user's.
	 */
	function buildDashboardNote(existing, section, meta = {}) {
		let block = `${core.MARK_START}\n\n${section}\n\n${core.MARK_END}`;
		let updated = meta.updated || new Date().toISOString();
		if (existing === null || existing === undefined) {
			return core.buildFrontmatter({ type: "research-dashboard", updated }, null)
				+ `\n# ${NOTE_NAME}\n\n${block}\n\n${USER_SECTION}`;
		}
		let { frontmatter, body } = core.splitFrontmatter(existing);
		let fm = core.setFrontmatterValue(core.setFrontmatterValue(frontmatter || "", "type", "research-dashboard"), "updated", updated);
		let start = MARK_START_RE.exec(body);
		let end = MARK_END_RE.exec(body);
		if (start && end && end.index > start.index) {
			body = body.slice(0, start.index) + block + body.slice(end.index + end[0].length);
		}
		else {
			// The markers were removed: a fresh block after the first heading
			let h1 = /^# .*$/m.exec(body);
			let at = h1 ? h1.index + h1[0].length : 0;
			body = body.slice(0, at) + "\n\n" + block + "\n" + body.slice(at);
		}
		return `---\n${fm}\n---\n` + (body.startsWith("\n") ? body : "\n" + body);
	}

	/** `研究儀表板.base`: evidence table, scanned PDFs to OCR, unread by collection. */
	function buildDashboardBase() {
		return [
			"filters:",
			"  and:",
			"    - file.hasProperty(\"zotero_key\")",
			"    - '!file.hasProperty(\"zotero_deleted\")'",
			"properties:",
			"  note.title:",
			"    displayName: 標題",
			"  note.authors:",
			"    displayName: 作者",
			"  note.year:",
			"    displayName: 年份",
			"  note.status:",
			"    displayName: 閱讀狀態",
			"  note.collections:",
			"    displayName: 分類",
			"  note.study_design:",
			"    displayName: 研究設計",
			"  note.sample_size:",
			"    displayName: 樣本數",
			"  note.evidence_level:",
			"    displayName: 證據等級",
			"  note.jbi_level:",
			"    displayName: JBI 等級",
			"  note.appraisal_overall:",
			"    displayName: 評讀結果",
			"  note.country:",
			"    displayName: 國家",
			"  note.full_text:",
			"    displayName: 全文",
			"  note.date_added:",
			"    displayName: 加入日期",
			"views:",
			"  - type: table",
			"    name: 證據等級表",
			"    filters:",
			"      and:",
			"        - file.hasProperty(\"evidence_level\")",
			"        - 'evidence_level != \"\"'",
			"    groupBy:",
			"      property: note.study_design",
			"      direction: ASC",
			"    order:",
			"      - file.name",
			"      - note.title",
			"      - note.year",
			"      - note.study_design",
			"      - note.sample_size",
			"      - note.evidence_level",
			"      - note.jbi_level",
			"      - note.appraisal_overall",
			"      - note.country",
			"      - note.status",
			"  - type: table",
			"    name: 掃描檔待 OCR",
			"    filters:",
			"      or:",
			"        - 'full_text == \"none\"'",
			"        - 'full_text == \"partial\"'",
			"    groupBy:",
			"      property: note.full_text",
			"      direction: ASC",
			"    order:",
			"      - file.name",
			"      - note.title",
			"      - note.year",
			"      - note.full_text",
			"      - note.collections",
			"      - note.status",
			"  - type: table",
			"    name: 待讀（依分類）",
			"    filters:",
			"      and:",
			`        - 'status == "${core.STATUSES[0]}"'`,
			"    groupBy:",
			"      property: note.collections",
			"      direction: ASC",
			"    order:",
			"      - file.name",
			"      - note.title",
			"      - note.authors",
			"      - note.year",
			"      - note.date_added",
			"      - note.collections",
			"",
		].join("\n");
	}

	// ---------- vault (needs Zotero) ----------

	function pref(key) {
		return Zotero.Prefs.get(PREF + key, true);
	}

	/** The frontmatter text of a note (null if none), reading only its head when that suffices. */
	async function readFrontmatter(path) {
		let bytes = await IOUtils.read(path, { maxBytes: HEAD_BYTES });
		let text = new TextDecoder().decode(bytes).replace(/^﻿/, "");
		let { frontmatter } = core.splitFrontmatter(text);
		if (frontmatter === null && bytes.length >= HEAD_BYTES && /^---\r?\n/.test(text)) {
			frontmatter = core.splitFrontmatter((await IOUtils.readUTF8(path)).replace(/^﻿/, "")).frontmatter;
		}
		return frontmatter;
	}

	/** One record per synced item (its first note when there are copies), via main.js's vault index. */
	async function literatureRecords(settings) {
		let index = await scope.ZB.main.buildObsidianIndex(settings);
		let records = [];
		for (let entries of index.values()) {
			let entry = entries[0];
			try {
				let fm = await readFrontmatter(entry.path);
				if (fm !== null) records.push(noteRecord(fm, entry.relParts.join("/")));
			}
			catch (e) {
				Zotero.debug(`Zotero Bridge: dashboard skipped ${entry.path}: ${e}`);
			}
		}
		return records;
	}

	/** Reviews/*.md or Drafts/*.md under the default folder, newest first. */
	async function projectRecords(settings, sub) {
		let dirParts = [...core.splitFolder(settings.defaults.obsidianFolder), sub];
		let children;
		try {
			children = await IOUtils.getChildren(PathUtils.join(settings.vaultPath, ...dirParts));
		}
		catch (e) {
			return [];
		}
		let out = [];
		for (let child of children) {
			let name = PathUtils.filename(child);
			if (name.startsWith(".") || !/\.md$/i.test(name)) continue;
			try {
				out.push(projectRecord((await readFrontmatter(child)) || "", [...dirParts, name].join("/")));
			}
			catch (e) {
				Zotero.debug(`Zotero Bridge: dashboard skipped ${child}: ${e}`);
			}
		}
		return out.sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)) || a.name.localeCompare(b.name));
	}

	/** Create `研究儀表板.base` once (Bases setting on); an existing file is never overwritten. */
	async function ensureBase(settings, dir, folderParts) {
		if (!settings.createBase) return "";
		let path = PathUtils.join(dir, BASE_NAME);
		if (!(await IOUtils.exists(path))) await IOUtils.writeUTF8(path, buildDashboardBase());
		return [...folderParts, BASE_NAME].join("/");
	}

	/**
	 * Rebuild the dashboard note (and create the .base file when missing).
	 * Returns { relPath, stats, written } or null without a vault.
	 */
	async function update(settings, opts = {}) {
		if (!settings || !settings.vaultPath) return null;
		let now = opts.now || new Date();
		let folderParts = core.splitFolder(settings.defaults.obsidianFolder);
		let dir = PathUtils.join(settings.vaultPath, ...folderParts);
		await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
		let stats = aggregate(await literatureRecords(settings), { now });
		let reviews = await projectRecords(settings, REVIEW_FOLDER);
		let drafts = await projectRecords(settings, DRAFTS_FOLDER);
		let report = usageReport(usage.parseLedger(pref("usage.ledger")), usage.parsePrices(pref("usage.prices")).prices, { now });
		let baseLink = "";
		try {
			baseLink = await ensureBase(settings, dir, folderParts);
		}
		catch (e) {
			Zotero.logError(e);
		}
		// 進度報告 (progress-report.js): link to the newest one
		let latestReport = scope.ZB && scope.ZB.progressReport ? await scope.ZB.progressReport.latestReport(settings) : null;
		// Top concept cards (concepts.js; their frontmatter only, never throws)
		let concepts = scope.ZB && scope.ZB.concepts ? await scope.ZB.concepts.dashboardSection(settings) : "";
		let section = buildDashboardSection(stats, { now, reviews, drafts, usage: report, baseLink, latestReport, concepts });
		let path = PathUtils.join(dir, NOTE_NAME + ".md");
		let existing = (await IOUtils.exists(path)) ? await IOUtils.readUTF8(path) : null;
		let text = buildDashboardNote(existing, section, { updated: now.toISOString() });
		if (text !== existing) await IOUtils.writeUTF8(path, text);
		return { relPath: [...folderParts, NOTE_NAME + ".md"].join("/"), stats, written: text !== existing };
	}

	/** After a manual sync run (main.js): rebuild when 「同步後更新研究儀表板」 is on. Never throws. */
	async function afterSync(settings) {
		try {
			if (!featureOn("dashboard") || pref("dashboard.autoUpdate") === false || !settings || !settings.vaultPath) return null;
			return await update(settings);
		}
		catch (e) {
			Zotero.logError(e);
			return null;
		}
	}

	/** Tools menu: rebuild now (after any sync in progress) and report. */
	function runFromMenu() {
		let ZB = scope.ZB;
		let headline = "Zotero Bridge：研究儀表板";
		return ZB.main.enqueue(async () => {
			let settings;
			try {
				settings = await ZB.main.readSettings();
			}
			catch (e) {
				ZB.main.notify("Zotero Bridge 設定有誤", String(e.message || e));
				return null;
			}
			if (!settings.vaultPath) {
				ZB.main.notify(headline, "請先到 設定 → Zotero Bridge 填入 Obsidian vault 路徑。");
				return null;
			}
			try {
				let result = await update(settings);
				let s = result.stats;
				ZB.main.notify(headline, `已更新 ${result.relPath}：${s.total} 篇文獻，已讀完成率 ${s.readPercent}%`
					+ `，待讀 ${s.unread.length} 篇${s.issues.length ? `，${s.issues.length} 篇有資料品質問題` : ""}。`);
				return result;
			}
			catch (e) {
				Zotero.logError(e);
				ZB.main.notify(headline, `更新失敗：${e.message || e}`);
				return null;
			}
		});
	}

	// Feature switches (features.js): checked live; always on when this file runs without them (Node tests)
	function featureOn(id) {
		let f = scope.ZB && scope.ZB.features;
		return !f || f.isEnabled(id);
	}

	/** Menu entries that hide while the feature is off (features.js gateMenus). */
	function gated(id, menus) {
		let f = scope.ZB && scope.ZB.features;
		return f ? f.gateMenus(id, menus) : menus;
	}

	/** Tools menu entry; returns the menu IDs to unregister. */
	function registerMenus({ pluginID }) {
		return [Zotero.MenuManager.registerMenu({
			menuID: "zotero-bridge-dashboard-tools",
			pluginID,
			target: "main/menubar/tools",
			menus: gated("dashboard", [{
				menuType: "menuitem",
				l10nID: "zotero-bridge-menu-dashboard",
				onCommand: () => {
					runFromMenu().catch(e => Zotero.logError(e));
				},
			}]),
		})].filter(Boolean);
	}

	return {
		NOTE_NAME, BASE_NAME, ISSUE_LABELS,
		parseFrontmatter, suspectChineseNames, noteRecord, projectRecord, aggregate, usageReport,
		buildStatusPie, buildDashboardSection, buildDashboardNote, buildDashboardBase,
		update, afterSync, runFromMenu, registerMenus,
	};
});
