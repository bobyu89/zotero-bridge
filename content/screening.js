/*
 * ZotMax — screening for systematic and scoping reviews (PRISMA 2020).
 *
 * Decisions are Zotero tags, so they show in the tag selector, can be filtered and colored,
 * and travel with Zotero sync (prefixes and reasons are settings):
 *   篩選/標題摘要/納入｜排除｜待定      title/abstract screening of a record
 *   篩選/全文/納入｜排除｜無法取得       full-text assessment of a report (無法取得 = not retrieved)
 *   排除原因/<reason>                   why a report was excluded at full text (one per item)
 *   篩選/重複                           duplicate record, removed before screening
 *   來源/<database>                     where a record was found (else the item's Library Catalog)
 *   來源/引文追蹤｜網站｜機構           found by other methods: the PRISMA 2020 right-hand column (a setting)
 * The newest decision wins: a full-text decision means the record passed title/abstract
 * screening, and excluding at title/abstract drops any full-text decision.
 *
 * A review is a Zotero collection (with its subcollections). For it the plugin finds likely
 * duplicates, counts the PRISMA 2020 flow, checks that the decisions add up, and writes an
 * Obsidian note (counts, Mermaid flow diagram, evidence table of the included studies from the
 * structured data of their AI notes), a CSV of the evidence table and optionally a Notion page.
 *
 * The helpers at the top are pure (Node tests); the rest needs Zotero.
 */
(function (root, factory) {
	if (typeof module === "object" && module.exports) {
		module.exports = factory(require("./core.js"), require("./synthesis.js"), globalThis);
	}
	else {
		(root.ZB = root.ZB || {}).screening = factory(root.ZB.core, root.ZB.synthesis, root);
	}
})(this, function (core, synthesis, scope) {
	const PREF = "extensions.zotero-bridge.";
	const DEFAULT_PREFIX = "篩選/";
	const DEFAULT_REASON_PREFIX = "排除原因/";
	const DEFAULT_SOURCE_PREFIX = "來源/";
	const STAGE_NAMES = { ta: "標題摘要", ft: "全文" };
	const DECISION_WORDS = { include: "納入", exclude: "排除", maybe: "待定", notRetrieved: "無法取得" };
	const STAGE_DECISIONS = { ta: ["include", "exclude", "maybe"], ft: ["include", "exclude", "notRetrieved"] };
	const DUPLICATE_WORD = "重複";
	// Common reasons in nursing reviews; one tag each, so keep them short
	const DEFAULT_REASONS = [
		"族群不符（wrong population）",
		"介入不符（wrong intervention）",
		"結果指標不符（wrong outcome）",
		"研究設計不符（wrong study design）",
		"非全文／研討會摘要（conference abstract）",
		"語言不符（language）",
		"重複發表（duplicate publication）",
	];
	// Menu slots for the reasons (the menu is registered once; extra reasons can still be tagged by hand)
	const MAX_MENU_REASONS = 20;
	const NO_REASON = "未註明原因";
	const NO_SOURCE = "未標示來源";
	// 來源/<name> tags that mean "other methods" in PRISMA 2020 (citation searching, websites, organisations)
	const DEFAULT_OTHER_SOURCES = ["引文追蹤", "網站", "機構"];
	const OTHER_SOURCE_LABELS = { 引文追蹤: "Citation searching", 網站: "Websites", 機構: "Organisations" };
	// Shorter normalized titles ("Editorial", "Letter") match too easily
	const MIN_TITLE_CHARS = 10;
	const REVIEW_FOLDER = "Reviews";
	const NOTION_ANCHOR = "🔄 ZotMax 自動產生：重新產生 PRISMA 時，這段到「✍️ 我的筆記」之間的內容會被覆寫。";
	// How the anchor paragraph starts, now and before the rename (pages made as Zotero Bridge ≤ 0.10)
	const NOTION_ANCHOR_PREFIXES = ["🔄 ZotMax 自動產生", "🔄 Zotero Bridge 自動產生"];
	const USER_HEADING = "✍️ 我的筆記";
	const MARK_START_RE = /^%% zotero-bridge:start.*%%[ \t]*$/m;
	const MARK_END_RE = /^%% zotero-bridge:end %%[ \t]*$/m;
	const MAX_LISTED = 10;

	// ---------- tags (pure) ----------

	/** Reasons from the settings textarea: one per line, blank lines and repeats dropped. */
	function parseReasons(text) {
		let seen = new Set();
		let out = [];
		for (let line of String(text || "").split(/\r?\n/)) {
			let s = line.replace(/^\s*[-*•]\s*/, "").trim();
			if (!s || seen.has(s)) continue;
			seen.add(s);
			out.push(s);
		}
		return out;
	}

	function normalizeConfig(cfg = {}) {
		let text = (v, d) => String(v === undefined || v === null ? "" : v).trim() || d;
		return {
			prefix: text(cfg.prefix, DEFAULT_PREFIX),
			reasonPrefix: text(cfg.reasonPrefix, DEFAULT_REASON_PREFIX),
			sourcePrefix: text(cfg.sourcePrefix, DEFAULT_SOURCE_PREFIX),
			reasons: Array.isArray(cfg.reasons) && cfg.reasons.length ? cfg.reasons.slice() : DEFAULT_REASONS.slice(),
			otherSources: Array.isArray(cfg.otherSources) && cfg.otherSources.length ? cfg.otherSources.slice() : DEFAULT_OTHER_SOURCES.slice(),
		};
	}

	/** Other-method sources from the settings: one per line or comma-separated; empty = the defaults. */
	function parseSourceList(text) {
		return parseReasons(String(text || "").replace(/[,，、]/g, "\n"));
	}

	/** A record found only by other methods (all its 來源/ tags are other-method sources) goes to the right-hand column. */
	function isOtherMethod(state, cfg) {
		return state.sources.length > 0 && state.sources.every(s => cfg.otherSources.includes(s));
	}

	function stageTag(cfg, stage, decision) {
		return `${cfg.prefix}${STAGE_NAMES[stage]}/${DECISION_WORDS[decision]}`;
	}

	function duplicateTag(cfg) {
		return cfg.prefix + DUPLICATE_WORD;
	}

	function reasonTag(cfg, reason) {
		return cfg.reasonPrefix + reason;
	}

	function tagValue(tag, prefix) {
		return prefix && tag.startsWith(prefix) ? tag.slice(prefix.length).trim() : "";
	}

	/** Every tag name the plugin writes for decisions (not reasons or sources). */
	function decisionTags(cfg) {
		cfg = normalizeConfig(cfg);
		return [
			...STAGE_DECISIONS.ta.map(d => stageTag(cfg, "ta", d)),
			...STAGE_DECISIONS.ft.map(d => stageTag(cfg, "ft", d)),
			duplicateTag(cfg),
		];
	}

	/**
	 * The screening state in an item's tags.
	 * ta / ft: the decision ("" when none, or when several conflict: taAll / ftAll list them all)
	 */
	function readState(tags, cfg) {
		cfg = normalizeConfig(cfg);
		let state = { ta: "", ft: "", taAll: [], ftAll: [], duplicate: false, reasons: [], sources: [] };
		let stageTags = new Map();
		for (let stage of ["ta", "ft"]) {
			for (let d of STAGE_DECISIONS[stage]) stageTags.set(stageTag(cfg, stage, d), [stage, d]);
		}
		for (let tag of tags || []) {
			tag = String(tag);
			let hit = stageTags.get(tag);
			if (hit) {
				let list = state[hit[0] + "All"];
				if (!list.includes(hit[1])) list.push(hit[1]);
				continue;
			}
			if (tag === duplicateTag(cfg)) {
				state.duplicate = true;
				continue;
			}
			let reason = tagValue(tag, cfg.reasonPrefix);
			if (reason) {
				if (!state.reasons.includes(reason)) state.reasons.push(reason);
				continue;
			}
			let source = tagValue(tag, cfg.sourcePrefix);
			if (source && !state.sources.includes(source)) state.sources.push(source);
		}
		state.ta = state.taAll.length === 1 ? state.taAll[0] : "";
		state.ft = state.ftAll.length === 1 ? state.ftAll[0] : "";
		return state;
	}

	function isScreeningTag(tag, cfg) {
		cfg = normalizeConfig(cfg);
		return decisionTags(cfg).includes(tag) || !!tagValue(String(tag), cfg.reasonPrefix);
	}

	function hasDecision(state) {
		return !!(state.taAll.length || state.ftAll.length || state.duplicate || state.reasons.length);
	}

	/**
	 * Tags to add and remove for a change:
	 *   { stage: "ta", decision: "include" | "exclude" | "maybe" }
	 *   { stage: "ft", decision: "include" | "exclude" | "notRetrieved", reason }
	 *   { duplicate: true | false }   { clear: true }
	 * A full-text decision also records title/abstract 納入; title/abstract 排除 drops the
	 * full-text decision and reason (the newest decision wins).
	 */
	function planChange(tags, change, cfg) {
		cfg = normalizeConfig(cfg);
		let have = new Set((tags || []).map(String));
		let want = new Set(have);
		let drop = (pred) => {
			for (let t of [...want]) {
				if (pred(t)) want.delete(t);
			}
		};
		let isStage = stage => t => STAGE_DECISIONS[stage].some(d => stageTag(cfg, stage, d) === t);
		let isReason = t => !!tagValue(t, cfg.reasonPrefix);
		if (change.clear) {
			drop(t => isScreeningTag(t, cfg));
		}
		else if (change.duplicate !== undefined) {
			if (change.duplicate) want.add(duplicateTag(cfg));
			else want.delete(duplicateTag(cfg));
		}
		else if (change.stage === "ta" && STAGE_DECISIONS.ta.includes(change.decision)) {
			drop(isStage("ta"));
			want.add(stageTag(cfg, "ta", change.decision));
			if (change.decision === "exclude") {
				drop(isStage("ft"));
				drop(isReason);
			}
		}
		else if (change.stage === "ft" && STAGE_DECISIONS.ft.includes(change.decision)) {
			drop(isStage("ft"));
			drop(isReason);
			want.add(stageTag(cfg, "ft", change.decision));
			if (change.decision === "exclude" && change.reason) want.add(reasonTag(cfg, change.reason));
			drop(isStage("ta"));
			want.add(stageTag(cfg, "ta", "include"));
		}
		else {
			throw new Error(`Unknown screening change: ${JSON.stringify(change)}`);
		}
		return {
			add: [...want].filter(t => !have.has(t)),
			remove: [...have].filter(t => !want.has(t)),
		};
	}

	/** "標題摘要：納入｜全文：排除（族群不符）" for the item pane ("" when undecided). */
	function describeState(state) {
		if (state.duplicate) return "重複（篩選前移除）";
		let part = (stage) => {
			let all = state[stage + "All"];
			if (!all.length) return "";
			let words = all.map(d => DECISION_WORDS[d]).join("／");
			let reason = stage === "ft" && state.ft === "exclude" && state.reasons.length ? `（${state.reasons.join("、")}）` : "";
			return `${STAGE_NAMES[stage]}：${words}${all.length > 1 ? " ⚠️" : ""}${reason}`;
		};
		return [part("ta"), part("ft")].filter(Boolean).join("｜");
	}

	function describeChange(change) {
		if (change.clear) return "清除篩選決定";
		if (change.duplicate !== undefined) return change.duplicate ? "標記為重複" : "取消重複標記";
		let text = `${STAGE_NAMES[change.stage]}：${DECISION_WORDS[change.decision]}`;
		return change.reason ? `${text}（${change.reason}）` : text;
	}

	// ---------- deduplication (pure) ----------

	function normalizeDOI(doi) {
		let s = String(doi || "").trim().toLowerCase();
		s = s.replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//, "").replace(/^doi:\s*/, "");
		try {
			s = decodeURIComponent(s);
		}
		catch (e) {}
		s = s.replace(/[\s.,;]+$/, "");
		return /^10\.\d{4,9}\/\S+$/.test(s) ? s : "";
	}

	/** Letters and digits only: case, accents, punctuation, spacing and Zotero's <i>…</i> markup ignored. */
	function normalizeTitle(title) {
		return String(title || "")
			.replace(/<\/?(?:i|b|sub|sup|span)[^>]*>/gi, "")
			.normalize("NFKD")
			.replace(/[̀-ͯ]/g, "")
			.toLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, "");
	}

	function yearOf(record) {
		let m = /\d{4}/.exec(String(record.year || "")) || /\d{4}/.exec(String(record.date || ""));
		return m ? m[0] : "";
	}

	// The record to keep in a group: not already marked duplicate, already screened, has a DOI,
	// an abstract and attachments, then the oldest
	function keepOrder(cfg) {
		let rank = (r) => {
			let s = readState(r.tags, cfg);
			return [s.duplicate ? 1 : 0, s.taAll.length || s.ftAll.length ? 0 : 1, normalizeDOI(r.doi) ? 0 : 1,
				r.hasAbstract ? 0 : 1, -(r.attachments || 0)];
		};
		return (a, b) => {
			let ra = rank(a);
			let rb = rank(b);
			for (let i = 0; i < ra.length; i++) {
				if (ra[i] !== rb[i]) return ra[i] - rb[i];
			}
			return String(a.dateAdded || "").localeCompare(String(b.dateAdded || "")) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
		};
	}

	/**
	 * Likely duplicates: the same DOI, or the same normalized title and year. Titles only match
	 * when the records don't carry two different DOIs (an erratum, a preprint with its own DOI).
	 * @param {object[]} records { id, title, year, date, doi, tags, hasAbstract, attachments, dateAdded }
	 * @returns {Array<{ keep, duplicates, basis: string[] }>} groups of 2+ records
	 */
	function findDuplicates(records, cfg) {
		cfg = normalizeConfig(cfg);
		let parent = new Map(records.map(r => [r.id, r.id]));
		let find = (id) => {
			while (parent.get(id) !== id) {
				parent.set(id, parent.get(parent.get(id)));
				id = parent.get(id);
			}
			return id;
		};
		let links = [];
		let join = (list, basis) => {
			for (let r of list.slice(1)) {
				let a = find(list[0].id);
				let b = find(r.id);
				if (a !== b) parent.set(b, a);
			}
			links.push({ id: list[0].id, basis });
		};
		let bucket = (keyOf) => {
			let map = new Map();
			for (let r of records) {
				let key = keyOf(r);
				if (!key) continue;
				if (!map.has(key)) map.set(key, []);
				map.get(key).push(r);
			}
			return [...map.values()].filter(list => list.length > 1);
		};
		for (let list of bucket(r => normalizeDOI(r.doi))) join(list, "DOI 相同");
		for (let list of bucket((r) => {
			let t = normalizeTitle(r.title);
			return t.length >= MIN_TITLE_CHARS ? `${t}|${yearOf(r)}` : "";
		})) {
			let dois = new Set(list.map(r => normalizeDOI(r.doi)).filter(Boolean));
			let members = dois.size > 1 ? list.filter(r => !normalizeDOI(r.doi)) : list;
			if (members.length > 1) join(members, "標題與年份相同");
		}
		let groups = new Map();
		for (let r of records) {
			let root = find(r.id);
			if (!groups.has(root)) groups.set(root, []);
			groups.get(root).push(r);
		}
		let order = keepOrder(cfg);
		let out = [];
		for (let [root, list] of groups) {
			if (list.length < 2) continue;
			list.sort(order);
			let basis = [...new Set(links.filter(l => find(l.id) === root).map(l => l.basis))];
			out.push({ keep: list[0], duplicates: list.slice(1), basis });
		}
		out.sort((a, b) => String(a.keep.title || "").localeCompare(String(b.keep.title || "")));
		return out;
	}

	// ---------- PRISMA 2020 counts (pure) ----------

	const ISSUES = [
		["taConflict", "warn", "同時有多個標題摘要決定，視為尚未篩選"],
		["ftConflict", "warn", "同時有多個全文決定，視為尚未完成全文評估"],
		["duplicateDecided", "warn", "標記為重複，但也有篩選決定（以重複計算，不列入篩選）"],
		["ftWithoutTA", "warn", "有全文決定，但標題摘要不是「納入」（以通過標題摘要篩選計算）"],
		["noReason", "warn", "全文排除但沒有排除原因（計入「未註明原因」）"],
		["manyReasons", "warn", "有多個排除原因（只計入設定清單中排在最前面的一個）"],
		["reasonWithoutExclude", "warn", "有排除原因，但全文決定不是「排除」（原因不計入）"],
		["countMismatch", "warn", "計數不一致"],
		["taPending", "info", "尚未完成標題摘要篩選（沒有決定或「待定」）"],
		["ftPending", "info", "已通過標題摘要篩選，但還沒有全文決定"],
		["noStudyData", "info", "納入研究還沒有 AI 筆記的結構化資料，證據表的欄位是空的（先對這些文獻執行同步產生 AI 筆記）"],
	];

	function primaryReason(reasons, cfg) {
		if (!reasons.length) return NO_REASON;
		let known = reasons.filter(r => cfg.reasons.includes(r)).sort((a, b) => cfg.reasons.indexOf(a) - cfg.reasons.indexOf(b));
		return known[0] || reasons.slice().sort((a, b) => a.localeCompare(b))[0];
	}

	function emptyCounts(identified) {
		return {
			identified, duplicates: 0, screened: 0, taExcluded: 0, taPending: 0,
			sought: 0, notRetrieved: 0, assessed: 0, ftExcluded: 0, ftPending: 0, included: 0,
		};
	}

	/**
	 * Count the PRISMA 2020 flow of a review's records (new review). Records whose 來源/ tags are all
	 * other-method sources (cfg.otherSources: citation searching, websites, …) are counted in `other`,
	 * the right-hand column; everything else in `counts` (databases and registers).
	 * @param {object[]} records { id, title, tags, catalog, … }
	 * @returns {{ counts, sources: [name, n][], reasons: [reason, n][], other: null | { counts, sources, reasons },
	 *   totalIncluded, issues, included }}
	 */
	function computePrisma(records, cfg) {
		cfg = normalizeConfig(cfg);
		let rows = records.map((r) => {
			let s = readState(r.tags, cfg);
			return { r, s, other: isOtherMethod(s, cfg) };
		});
		let column = n => ({ c: emptyCounts(n), sources: new Map(), reasons: new Map() });
		let otherCount = rows.filter(x => x.other).length;
		let columns = { db: column(rows.length - otherCount), other: column(otherCount) };
		let found = new Map(ISSUES.map(([code]) => [code, []]));
		let included = [];
		let issue = (code, r) => found.get(code).push(r);
		for (let { r, s, other: isOther } of rows) {
			let col = isOther ? columns.other : columns.db;
			let c = col.c;
			let { sources, reasons } = col;
			let from = s.sources.length ? s.sources : [String(r.catalog || "").trim() || NO_SOURCE];
			for (let src of from) sources.set(src, (sources.get(src) || 0) + 1);
			if (s.taAll.length > 1) issue("taConflict", r);
			if (s.ftAll.length > 1) issue("ftConflict", r);
			if (s.duplicate) {
				c.duplicates++;
				if (s.taAll.length || s.ftAll.length || s.reasons.length) issue("duplicateDecided", r);
				continue;
			}
			c.screened++;
			// Other methods have no title/abstract stage in PRISMA 2020: going straight to full text is fine
			if (s.ft && s.ta !== "include" && !isOther) issue("ftWithoutTA", r);
			if (s.reasons.length && s.ft !== "exclude") issue("reasonWithoutExclude", r);
			let ta = s.ft ? "include" : s.ta;
			if (ta === "exclude") {
				c.taExcluded++;
				continue;
			}
			if (ta !== "include") {
				c.taPending++;
				issue("taPending", r);
				continue;
			}
			c.sought++;
			if (s.ft === "notRetrieved") {
				c.notRetrieved++;
				continue;
			}
			c.assessed++;
			if (s.ft === "include") {
				c.included++;
				included.push(r);
			}
			else if (s.ft === "exclude") {
				c.ftExcluded++;
				if (!s.reasons.length) issue("noReason", r);
				else if (s.reasons.length > 1) issue("manyReasons", r);
				let reason = primaryReason(s.reasons, cfg);
				reasons.set(reason, (reasons.get(reason) || 0) + 1);
			}
			else {
				c.ftPending++;
				issue("ftPending", r);
			}
		}
		let reasonList = col => [...col.reasons].sort((a, b) => {
			let rank = ([name]) => (name === NO_REASON ? 1e6 : cfg.reasons.includes(name) ? cfg.reasons.indexOf(name) : 1e5);
			return rank(a) - rank(b) || a[0].localeCompare(b[0]);
		});
		let sourceList = col => [...col.sources].sort((a, b) => (a[0] === NO_SOURCE) - (b[0] === NO_SOURCE) || b[1] - a[1] || a[0].localeCompare(b[0]));
		let db = columns.db;
		let other = otherCount
			? { counts: columns.other.c, sources: sourceList(columns.other), reasons: reasonList(columns.other) }
			: null;
		let mismatch = checkCounts(db.c, reasonList(db));
		if (other) mismatch.push(...checkCounts(other.counts, other.reasons).map(m => `其他方法：${m}`));
		let issues = ISSUES.map(([code, level, message]) => ({ code, level, message, records: found.get(code) }))
			.filter(i => i.records.length);
		if (mismatch.length) issues.push({ code: "countMismatch", level: "warn", message: `計數不一致：${mismatch.join("；")}`, records: [] });
		return {
			counts: db.c, sources: sourceList(db), reasons: reasonList(db), other,
			totalIncluded: db.c.included + (other ? other.counts.included : 0),
			issues, included,
		};
	}

	/** The PRISMA arithmetic; returns the equations that don't hold (none for computePrisma's own counts). */
	function checkCounts(c, reasonList = []) {
		let rules = [
			["identified = duplicates + screened", c.identified, c.duplicates + c.screened],
			["screened = excluded + awaiting + sought", c.screened, c.taExcluded + c.taPending + c.sought],
			["sought = not retrieved + assessed", c.sought, c.notRetrieved + c.assessed],
			["assessed = excluded + included + awaiting", c.assessed, c.ftExcluded + c.included + c.ftPending],
			["reports excluded = sum of reasons", c.ftExcluded, reasonList.reduce((n, [, v]) => n + v, 0)],
		];
		return rules.filter(([, a, b]) => a !== b).map(([name, a, b]) => `${name}（${a} ≠ ${b}）`);
	}

	// ---------- outputs (pure) ----------

	function mermaidLabel(lines) {
		let esc = s => String(s).replace(/"/g, "#quot;").replace(/</g, "#lt;").replace(/>/g, "#gt;");
		return `["${lines.map(esc).join("<br/>")}"]`;
	}

	function otherSourceLabel(name) {
		return OTHER_SOURCE_LABELS[name] || name;
	}

	/**
	 * PRISMA 2020 flow diagram (new review) as a Mermaid flowchart: databases and registers, plus the
	 * "other methods" column when some records came from citation searching, websites, ….
	 */
	function buildMermaid(result) {
		let c = result.counts;
		let o = result.other ? result.other.counts : null;
		let total = result.totalIncluded === undefined ? c.included : result.totalIncluded;
		let n = v => `(n = ${v})`;
		let out = ["flowchart TD"];
		let node = (id, lines, cls) => out.push(`    ${id}${mermaidLabel(lines)}${cls ? ":::" + cls : ""}`);
		let named = result.sources.filter(([s]) => s !== NO_SOURCE).length > 0;
		out.push("    subgraph identification[\"Identification\"]");
		node("identified", ["Records identified from databases and registers", n(c.identified),
			...(named ? result.sources.map(([s, v]) => `${s} ${n(v)}`) : [])]);
		node("removed", ["Records removed before screening:", `Duplicate records removed ${n(c.duplicates)}`]);
		if (o) {
			node("otherIdentified", ["Records identified from:", ...result.other.sources.map(([s, v]) => `${otherSourceLabel(s)} ${n(v)}`)]);
			// Not a box in the PRISMA 2020 template; shown only when needed so the column adds up
			let notSought = [
				o.duplicates ? `Duplicate records removed ${n(o.duplicates)}` : "",
				o.taExcluded ? `Records excluded ${n(o.taExcluded)}` : "",
			].filter(Boolean);
			if (notSought.length) node("otherRemoved", notSought);
		}
		out.push("    end");
		out.push("    subgraph screening[\"Screening\"]");
		node("screened", ["Records screened", n(c.screened)]);
		node("excluded", ["Records excluded", n(c.taExcluded)]);
		node("sought", ["Reports sought for retrieval", n(c.sought)]);
		node("notRetrieved", ["Reports not retrieved", n(c.notRetrieved)]);
		node("assessed", ["Reports assessed for eligibility", n(c.assessed)]);
		node("reportsExcluded", [`Reports excluded ${n(c.ftExcluded)}${result.reasons.length ? ":" : ""}`,
			...result.reasons.map(([r, v]) => `${r} ${n(v)}`)]);
		if (c.taPending) node("taPending", ["Records awaiting screening", n(c.taPending)], "pending");
		if (c.ftPending) node("ftPending", ["Reports awaiting assessment", n(c.ftPending)], "pending");
		if (o) {
			node("otherSought", ["Reports sought for retrieval", n(o.sought)]);
			node("otherNotRetrieved", ["Reports not retrieved", n(o.notRetrieved)]);
			node("otherAssessed", ["Reports assessed for eligibility", n(o.assessed)]);
			node("otherExcluded", [`Reports excluded ${n(o.ftExcluded)}${result.other.reasons.length ? ":" : ""}`,
				...result.other.reasons.map(([r, v]) => `${r} ${n(v)}`)]);
			if (o.taPending) node("otherTaPending", ["Records awaiting screening", n(o.taPending)], "pending");
			if (o.ftPending) node("otherFtPending", ["Reports awaiting assessment", n(o.ftPending)], "pending");
		}
		out.push("    end");
		out.push("    subgraph includedStage[\"Included\"]");
		node("included", ["Studies included in review", n(total), `Reports of included studies ${n(total)}`]);
		out.push("    end");
		out.push(
			"    identified --> removed",
			"    identified --> screened",
			"    screened --> excluded",
			"    screened --> sought",
			"    sought --> notRetrieved",
			"    sought --> assessed",
			"    assessed --> reportsExcluded",
			"    assessed --> included",
		);
		if (c.taPending) out.push("    screened -.-> taPending");
		if (c.ftPending) out.push("    assessed -.-> ftPending");
		if (o) {
			if (o.duplicates || o.taExcluded) out.push("    otherIdentified --> otherRemoved");
			out.push(
				"    otherIdentified --> otherSought",
				"    otherSought --> otherNotRetrieved",
				"    otherSought --> otherAssessed",
				"    otherAssessed --> otherExcluded",
				"    otherAssessed --> included",
			);
			if (o.taPending) out.push("    otherIdentified -.-> otherTaPending");
			if (o.ftPending) out.push("    otherAssessed -.-> otherFtPending");
		}
		if (c.taPending || c.ftPending || (o && (o.taPending || o.ftPending))) out.push("    classDef pending stroke-dasharray: 5 5");
		return out.join("\n");
	}

	function cell(v) {
		return String(v === undefined || v === null ? "" : v).replace(/\r?\n+/g, " ").replace(/\|/g, "\\|").trim();
	}

	// The "other methods" column of the counts table (none without such records)
	function otherRows(other) {
		if (!other) return [];
		let o = other.counts;
		let stage = "其他方法";
		return [
			[stage, "Records identified from other methods（引文追蹤、網站等）", o.identified],
			...other.sources.map(([s, v]) => ["", `└ ${s}${OTHER_SOURCE_LABELS[s] ? `（${OTHER_SOURCE_LABELS[s]}）` : ""}`, v]),
			...(o.duplicates ? [[stage, "Duplicate records removed（重複）", o.duplicates]] : []),
			...(o.taExcluded ? [[stage, "Records excluded（標題摘要排除）", o.taExcluded]] : []),
			...(o.taPending ? [[stage, "Records awaiting screening（尚未篩選／待定）", o.taPending]] : []),
			[stage, "Reports sought for retrieval", o.sought],
			[stage, "Reports not retrieved（無法取得全文）", o.notRetrieved],
			[stage, "Reports assessed for eligibility", o.assessed],
			[stage, "Reports excluded", o.ftExcluded],
			...other.reasons.map(([r, v]) => ["", `└ ${r}`, v]),
			...(o.ftPending ? [[stage, "Reports awaiting assessment（尚未有全文決定）", o.ftPending]] : []),
			[stage, "Studies included（其他方法）", o.included],
		];
	}

	function countsTable(result) {
		let c = result.counts;
		let rows = [
			["辨識", "Records identified from databases and registers", c.identified],
			...result.sources.map(([s, v]) => ["", `└ ${s}`, v]),
			["辨識", "Duplicate records removed（重複）", c.duplicates],
			["標題摘要", "Records screened", c.screened],
			["標題摘要", "Records excluded", c.taExcluded],
			...(c.taPending ? [["標題摘要", "Records awaiting screening（尚未篩選／待定）", c.taPending]] : []),
			["全文", "Reports sought for retrieval", c.sought],
			["全文", "Reports not retrieved（無法取得全文）", c.notRetrieved],
			["全文", "Reports assessed for eligibility", c.assessed],
			["全文", "Reports excluded", c.ftExcluded],
			...result.reasons.map(([r, v]) => ["", `└ ${r}`, v]),
			...(c.ftPending ? [["全文", "Reports awaiting assessment（尚未有全文決定）", c.ftPending]] : []),
			...otherRows(result.other),
			["納入", "Studies included in review", result.totalIncluded === undefined ? c.included : result.totalIncluded],
			...(result.other ? [["", "└ 資料庫與登錄庫／其他方法", `${c.included}／${result.other.counts.included}`]] : []),
		];
		return ["| 階段 | PRISMA 2020 | n |", "|---|---|---:|", ...rows.map(r => `| ${r.map(cell).join(" | ")} |`)].join("\n");
	}

	function issuesMarkdown(issues) {
		if (!issues.length) return "- ✅ 計數一致，沒有發現問題。";
		return issues.map((i) => {
			let icon = i.level === "warn" ? "⚠️" : "ℹ️";
			let shown = i.records.slice(0, MAX_LISTED).map((r) => {
				let title = String(r.title || r.key || "Untitled").replace(/[[\]]/g, " ").trim();
				return r.uri ? `[${title}](${r.uri})` : title;
			});
			let more = i.records.length > MAX_LISTED ? `…等 ${i.records.length} 筆` : "";
			let count = i.records.length ? `（${i.records.length} 筆）` : "";
			return `- ${icon} ${i.message}${count}${shown.length ? "：" + shown.join("；") + more : ""}`;
		}).join("\n");
	}

	/** One evidence-table row from a record and its AI note's structured data (null when none). */
	function evidenceRow(record, study, link) {
		let s = study || {};
		let text = v => (v === null || v === undefined ? "" : String(v));
		return {
			citation: synthesis.shortCitation({ creators: record.creators, title: record.title, year: yearOf(record) }),
			authors: core.authorNames({ creators: record.creators || [] }).join("; "),
			year: yearOf(record),
			title: text(record.title),
			publication: text(record.publication),
			doi: text(record.doi),
			uri: text(record.uri),
			link: link || "",
			hasData: !!study,
			design: text(s.study_design),
			sampleSize: Number.isFinite(s.sample_size) ? String(s.sample_size) : "",
			setting: text(s.setting),
			country: text(s.country),
			population: text(s.population),
			intervention: text(s.intervention),
			comparison: text(s.comparison),
			outcomes: text(s.outcomes),
			measures: Array.isArray(s.measures) ? s.measures.join("; ") : "",
			evidenceLevel: text(s.evidence_level),
			jbiLevel: text(s.jbi_level),
			appraisalTool: text(s.appraisal_tool),
			appraisalOverall: text(s.appraisal_overall),
		};
	}

	function sortRows(rows) {
		return rows.slice().sort((a, b) => a.citation.localeCompare(b.citation, "en") || a.title.localeCompare(b.title));
	}

	/** Markdown evidence table; with `links`, the first column links to the literature note. */
	function evidenceTable(rows, opts = {}) {
		if (!rows.length) return "（還沒有全文納入的研究）";
		let head = ["文獻", "研究設計", "樣本數", "場域／國家", "族群", "介入／對照", "結果指標", "證據等級", "JBI 評讀"];
		let lines = [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`];
		for (let r of rows) {
			let first = opts.links && r.link ? `[[${r.link}\\|${cell(r.citation)}]]` : cell(r.citation);
			let both = (a, b, sep) => [a, b].filter(Boolean).join(sep);
			lines.push("| " + [
				first,
				r.hasData ? cell(r.design) : "（無結構化資料）",
				cell(r.sampleSize),
				cell(both(r.setting, r.country, "；")),
				cell(r.population),
				cell(both(r.intervention, r.comparison ? `對照：${r.comparison}` : "", "；")),
				cell(r.outcomes),
				cell(both(r.evidenceLevel ? `CEBM ${r.evidenceLevel}` : "", r.jbiLevel ? `JBI ${r.jbiLevel}` : "", "；")),
				cell(both(r.appraisalOverall, r.appraisalTool ? `（${r.appraisalTool}）` : "", "")),
			].join(" | ") + " |");
		}
		return lines.join("\n");
	}

	const CSV_COLUMNS = [
		["文獻", "citation"], ["作者", "authors"], ["年份", "year"], ["標題", "title"], ["期刊", "publication"], ["DOI", "doi"],
		["研究設計", "design"], ["樣本數", "sampleSize"], ["場域", "setting"], ["國家", "country"], ["族群", "population"],
		["介入", "intervention"], ["對照", "comparison"], ["結果指標", "outcomes"], ["測量工具", "measures"],
		["CEBM 證據等級", "evidenceLevel"], ["JBI 證據等級", "jbiLevel"], ["評讀工具", "appraisalTool"], ["評讀結果", "appraisalOverall"],
		["Zotero", "uri"],
	];

	function csvCell(v) {
		let s = String(v === undefined || v === null ? "" : v);
		// A cell starting with = + - @ would run as a formula in Excel
		if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(?:\.\d+)?$/.test(s)) s = "'" + s;
		return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, "\"\"")}"` : s;
	}

	/** CSV with a UTF-8 BOM and CRLF line ends, so Excel opens the Chinese text correctly. */
	function buildCSV(rows) {
		let lines = [CSV_COLUMNS.map(([h]) => h), ...rows.map(r => CSV_COLUMNS.map(([, k]) => r[k]))];
		return "﻿" + lines.map(l => l.map(csvCell).join(",")).join("\r\n") + "\r\n";
	}

	/**
	 * The managed part of the review note (and the Notion page).
	 * meta: { name, uri, generatedAt, csvPath, links }
	 */
	function buildReviewSection(result, rows, meta) {
		let info = [
			`> [!info] 由 ZotMax 依分類「${meta.name}」的 ${result.counts.identified} 筆文獻於 ${String(meta.generatedAt || "").slice(0, 10)} 產生；重新產生只會覆寫這個區塊。`,
			meta.uri ? `> Zotero：[開啟分類](${meta.uri})` + (meta.csvPath ? ` · 證據表 CSV：\`${meta.csvPath}\`` : "") : "",
		].filter(Boolean).join("\n");
		return [
			info,
			"## PRISMA 2020 計數",
			countsTable(result),
			"## PRISMA 2020 流程圖",
			"```mermaid\n" + buildMermaid(result) + "\n```",
			"## 一致性檢查",
			issuesMarkdown(result.issues),
			`## 證據表（納入研究 ${rows.length} 篇）`,
			evidenceTable(rows, { links: meta.links }),
		].join("\n\n");
	}

	function otherFrontmatter(other) {
		if (!other) return {};
		let o = other.counts;
		return {
			prisma_other_identified: o.identified,
			prisma_other_sought: o.sought,
			prisma_other_not_retrieved: o.notRetrieved,
			prisma_other_assessed: o.assessed,
			prisma_other_excluded: o.ftExcluded,
			prisma_other_included: o.included,
		};
	}

	function frontmatterFor(result, meta) {
		let c = result.counts;
		return {
			title: meta.title,
			type: "review-screening",
			zotero_collection: meta.collectionKey,
			collection_path: meta.path || meta.name,
			zotero: meta.uri || "",
			prisma_identified: c.identified,
			prisma_duplicates: c.duplicates,
			prisma_screened: c.screened,
			prisma_excluded_screening: c.taExcluded,
			prisma_awaiting_screening: c.taPending,
			prisma_sought: c.sought,
			prisma_not_retrieved: c.notRetrieved,
			prisma_assessed: c.assessed,
			prisma_excluded_fulltext: c.ftExcluded,
			prisma_awaiting_fulltext: c.ftPending,
			prisma_included: result.totalIncluded === undefined ? c.included : result.totalIncluded,
			...otherFrontmatter(result.other),
			evidence_csv: meta.csvPath || "",
			notion: meta.notionUrl || "",
			last_generated: meta.generatedAt || "",
		};
	}

	/**
	 * The whole review note. With `existing`, only the plugin's frontmatter keys and the
	 * %% zotero-bridge:start/end %% block change; empty values keep what the note has (e.g. the
	 * Notion link when this run had no Notion).
	 */
	function buildReviewNote(existing, fm, title, section) {
		let block = `${core.MARK_START}\n\n${section}\n\n${core.MARK_END}`;
		if (!existing) {
			return core.buildFrontmatter(Object.assign({}, fm, { tags: ["系統性回顧"] }), null)
				+ `\n# ${title}\n\n${block}\n\n## ${USER_HEADING}\n\n`;
		}
		let { frontmatter, body } = core.splitFrontmatter(existing);
		let f = frontmatter || "";
		for (let [key, value] of Object.entries(fm)) {
			if (value === "" || value === null || value === undefined) continue;
			f = core.setFrontmatterValue(f, key, value);
		}
		let start = MARK_START_RE.exec(body);
		let end = MARK_END_RE.exec(body);
		if (start && end && end.index > start.index) {
			body = body.slice(0, start.index) + block + body.slice(end.index + end[0].length);
		}
		else {
			// The markers were removed: put a fresh block after the first heading
			let h1 = /^# .*$/m.exec(body);
			let at = h1 ? h1.index + h1[0].length : 0;
			body = body.slice(0, at) + "\n\n" + block + "\n" + body.slice(at);
		}
		return `---\n${f}\n---\n` + (body.startsWith("\n") ? body : "\n" + body);
	}

	/** Notion blocks for the page: real tables, and the flow diagram as a Mermaid code block. */
	function notionBlocks(markdown, mdToNotionBlocks) {
		let blocks = mdToNotionBlocks(markdown, { tables: true });
		for (let b of blocks) {
			if (b.type !== "code") continue;
			let text = (b.code.rich_text || []).map(r => r.text.content).join("");
			if (/^flowchart\b/.test(text)) b.code.language = "mermaid";
		}
		return blocks;
	}

	// ---------- settings ----------

	function config() {
		let get = k => Zotero.Prefs.get(PREF + k, true);
		return normalizeConfig({
			prefix: get("screening.tagPrefix"),
			reasonPrefix: get("screening.reasonPrefix"),
			sourcePrefix: get("screening.sourcePrefix"),
			reasons: parseReasons(get("screening.reasons")),
			otherSources: parseSourceList(get("screening.otherSources")),
		});
	}

	// ---------- Zotero items ----------

	function field(item, name) {
		try {
			return item.getField(name, false, true) || "";
		}
		catch (e) {
			return "";
		}
	}

	/** The plain record the pure helpers work on. */
	function itemRecord(item) {
		let ZB = scope.ZB;
		let lib = ZB.adapter.libraryInfo(item.libraryID);
		// Item types without a DOI field keep it in Extra ("DOI: 10.…")
		let doi = field(item, "DOI") || ((/^\s*DOI:\s*(\S+)/im.exec(field(item, "extra")) || [])[1] || "");
		return {
			id: item.id,
			key: item.key,
			libraryPath: lib.path,
			title: field(item, "title"),
			year: field(item, "year"),
			date: field(item, "date"),
			doi,
			catalog: field(item, "libraryCatalog"),
			publication: field(item, "publicationTitle"),
			creators: item.getCreatorsJSON(),
			tags: item.getTags().map(t => t.tag),
			dateAdded: item.dateAdded || "",
			hasAbstract: !!field(item, "abstractNote"),
			attachments: item.getAttachments().length,
			uri: `zotero://select/${lib.path}/items/${item.key}`,
		};
	}

	function collectionKey(collection) {
		return `${scope.ZB.adapter.libraryInfo(collection.libraryID).path}/collections/${collection.key}`;
	}

	/** Apply a change to the items' tags. Saved quietly: auto-sync doesn't push every click to Notion. */
	async function setDecision(items, change, opts = {}) {
		let ZB = scope.ZB;
		items = ZB.adapter.toRegularItems(items);
		if (!items.length) return 0;
		let cfg = config();
		let changed = 0;
		let errors = [];
		for (let item of items) {
			let plan = planChange(item.getTags().map(t => t.tag), change, cfg);
			if (!plan.add.length && !plan.remove.length) continue;
			try {
				for (let tag of plan.remove) item.removeTag(tag);
				for (let tag of plan.add) item.addTag(tag);
				await ZB.main.saveQuietly(item);
				changed++;
			}
			catch (e) {
				Zotero.logError(e);
				errors.push(`${field(item, "title") || item.key}：${e.message || e}`);
			}
		}
		if (!opts.silent && (items.length > 1 || errors.length)) {
			ZB.main.notify("ZotMax：篩選", `${describeChange(change)}：已更新 ${changed} 篇`
				+ (items.length - changed - errors.length ? `（${items.length - changed - errors.length} 篇原本就是）` : "")
				+ (errors.length ? `\n失敗 ${errors.length} 篇：${errors.slice(0, 3).join("；")}` : ""));
		}
		return changed;
	}

	// Show the pane row on every item once screening has started somewhere (Zotero.Tags knows the tag)
	function screeningInUse(cfg) {
		try {
			return decisionTags(cfg).some(t => Zotero.Tags.getID(t) !== false);
		}
		catch (e) {
			return false;
		}
	}

	/** "篩選" row in the plugin's item pane section: the decisions, and buttons for title/abstract. */
	function renderPaneRow(doc, body, item) {
		if (!item || !item.isRegularItem()) return;
		let cfg = config();
		if (!hasDecision(readState(item.getTags().map(t => t.tag), cfg)) && !screeningInUse(cfg)) return;
		let row = doc.createElement("div");
		row.setAttribute("style", "display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; margin: 2px 0 6px;");
		let draw = () => {
			row.replaceChildren();
			let state = readState(item.getTags().map(t => t.tag), cfg);
			let label = doc.createElement("span");
			label.textContent = `篩選：${describeState(state) || "尚未篩選"}`;
			row.append(label);
			for (let decision of STAGE_DECISIONS.ta) {
				let b = doc.createElement("button");
				b.textContent = DECISION_WORDS[decision];
				b.title = `標題摘要：${DECISION_WORDS[decision]}`;
				b.setAttribute("style", "padding: 0 6px;");
				b.addEventListener("click", () => {
					setDecision([item], { stage: "ta", decision }).then(draw).catch(e => Zotero.logError(e));
				});
				row.append(b);
			}
		};
		draw();
		body.append(row);
	}

	// ---------- deduplication ----------

	function describeGroup(group) {
		let name = r => `「${String(r.title || r.key).slice(0, 60)}」${yearOf(r) ? `（${yearOf(r)}）` : ""}`;
		return `${name(group.keep)} ← ${group.duplicates.length} 筆（${group.basis.join("、")}）`;
	}

	/** Find likely duplicates in a review collection and, after confirmation, tag all but one per group. */
	async function dedupCollection(collection) {
		let ZB = scope.ZB;
		let cfg = config();
		let items = ZB.adapter.itemsInCollection(collection, true);
		let records = items.map(itemRecord);
		let byID = new Map(items.map(i => [i.id, i]));
		let groups = findDuplicates(records, cfg);
		let headline = "ZotMax：找重複";
		if (!groups.length) {
			ZB.main.notify(headline, `「${collection.name}」的 ${records.length} 筆文獻中沒有找到可能重複的文獻（比對 DOI，以及標題＋年份）。`);
			return { groups: 0, tagged: 0 };
		}
		let todo = groups.flatMap(g => g.duplicates.filter(r => !readState(r.tags, cfg).duplicate));
		let lines = groups.slice(0, 15).map(describeGroup);
		if (groups.length > 15) lines.push(`…另有 ${groups.length - 15} 組`);
		let merge = "要合併條目，請在 Zotero 左側的「重覆的項目」（Duplicate Items）中合併；合併後辨識數（Records identified）會跟著減少，建議 PRISMA 計數定案後再合併。";
		if (!todo.length) {
			ZB.main.notify(headline, `找到 ${groups.length} 組可能重複，都已標記「${duplicateTag(cfg)}」。\n${merge}`);
			return { groups: groups.length, tagged: 0 };
		}
		let ok = Services.prompt.confirm(Zotero.getMainWindow(), headline,
			`「${collection.name}」中找到 ${groups.length} 組可能重複的文獻（每組保留第一筆）：\n\n${lines.join("\n")}\n\n`
			+ `要把其餘 ${todo.length} 筆加上標籤「${duplicateTag(cfg)}」嗎？不會合併或刪除任何條目，標錯了可以直接刪掉標籤。\n\n${merge}`);
		if (!ok) return { groups: groups.length, tagged: 0 };
		let tagged = await setDecision(todo.map(r => byID.get(r.id)), { duplicate: true }, { silent: true });
		ZB.main.notify(headline, `已將 ${tagged} 筆標記為「${duplicateTag(cfg)}」（${groups.length} 組）。\n${merge}`);
		return { groups: groups.length, tagged };
	}

	// ---------- PRISMA report ----------

	function readNotionPages() {
		try {
			let all = JSON.parse(Zotero.Prefs.get(PREF + "screening.notionPages", true) || "{}");
			return all && typeof all === "object" && !Array.isArray(all) ? all : {};
		}
		catch (e) {
			return {};
		}
	}

	function writeNotionPage(key, pageId) {
		let all = readNotionPages();
		all[key] = pageId;
		Zotero.Prefs.set(PREF + "screening.notionPages", JSON.stringify(all), true);
	}

	function notionParent(settings) {
		return String(Zotero.Prefs.get(PREF + "screening.notionParent", true) || "").trim() || settings.notionSynthesisParent;
	}

	/** Whether a paragraph's text is the anchor of a PRISMA page, under the current or the old name. */
	function isNotionAnchor(text) {
		return NOTION_ANCHOR_PREFIXES.some(p => String(text || "").startsWith(p));
	}

	function anchorText() {
		return [{ type: "text", text: { content: NOTION_ANCHOR }, annotations: { italic: true, color: "gray" } }];
	}

	function plainText(block) {
		let rich = (block[block.type] && block[block.type].rich_text) || [];
		return rich.map(r => (r.plain_text !== undefined ? r.plain_text : (r.text && r.text.content) || "")).join("");
	}

	/**
	 * Rewrite the review's page: the blocks between the anchor paragraph and the 「✍️ 我的筆記」
	 * heading are replaced, everything else is the user's. Returns the URL, or null when the page
	 * is gone or the anchor or heading was deleted (a new page is made then; nothing is guessed away).
	 */
	async function updateNotionPage(client, pageId, title, blocks) {
		let page;
		try {
			page = await client.request("GET", `pages/${pageId}`);
		}
		catch (e) {
			// Deleted for good, or no longer shared with the integration
			if (e instanceof scope.ZB.notion.NotionError && (e.status === 404 || e.status === 403)) return null;
			throw e;
		}
		if (page.in_trash || page.archived) return null;
		let children = await client.listChildren(pageId);
		let anchor = children.findIndex(b => b.type === "paragraph" && isNotionAnchor(plainText(b)));
		let end = children.findIndex((b, i) => anchor >= 0 && i > anchor && /^heading_/.test(b.type) && plainText(b).trim() === USER_HEADING);
		if (anchor < 0 || end < 0) return null;
		// A page made before the rename: the anchor now carries the current name
		if (plainText(children[anchor]) !== NOTION_ANCHOR) {
			await client.request("PATCH", `blocks/${children[anchor].id}`, { paragraph: { rich_text: anchorText() } });
		}
		for (let b of children.slice(anchor + 1, end)) {
			await client.request("DELETE", `blocks/${b.id}`);
		}
		// Chunks go in last-first, each right after the anchor, so they end up in order
		let chunks = [];
		for (let i = 0; i < blocks.length; i += 100) chunks.push(blocks.slice(i, i + 100));
		for (let chunk of chunks.reverse()) {
			await client.request("PATCH", `blocks/${pageId}/children`, { children: chunk, after: children[anchor].id });
		}
		await client.request("PATCH", `pages/${pageId}`, {
			properties: { title: { title: [{ type: "text", text: { content: title } }] } },
		});
		return page.url;
	}

	async function syncNotion(settings, key, title, markdown) {
		let ZB = scope.ZB;
		let client = new ZB.notion.NotionClient({ token: settings.notionToken, fetch: (u, i) => fetch(u, i) });
		// The divider before 「✍️ 我的筆記」 is part of the managed blocks
		let blocks = [...notionBlocks(markdown, ZB.markdown.mdToNotionBlocks), { object: "block", type: "divider", divider: {} }];
		let pageId = readNotionPages()[key];
		if (pageId) {
			let url = await updateNotionPage(client, pageId, title, blocks);
			if (url) return url;
		}
		let page = await client.createChildPage(notionParent(settings), title, [
			{ object: "block", type: "paragraph", paragraph: { rich_text: anchorText() } },
			...blocks,
			{ object: "block", type: "heading_2", heading_2: { rich_text: [{ type: "text", text: { content: USER_HEADING } }] } },
		], "🧾");
		writeNotionPage(key, page.id);
		return page.url;
	}

	/** The review note's path; a note of the user's or of another collection with the same name keeps its file. */
	async function reviewNotePath(settings, collection) {
		let dirParts = [...core.splitFolder(settings.defaults.obsidianFolder), REVIEW_FOLDER];
		let dir = PathUtils.join(settings.vaultPath, ...dirParts);
		let key = collectionKey(collection);
		let base = core.sanitizeFilename(collection.name);
		let target = null;
		for (let name of [base, `${base} (${collection.key})`]) {
			let path = PathUtils.join(dir, name + ".md");
			let existing = (await IOUtils.exists(path)) ? await IOUtils.readUTF8(path) : null;
			let owner = existing === null ? "" : core.frontmatterScalar(core.splitFrontmatter(existing).frontmatter || "", "zotero_collection");
			// The second name has the collection key in it, so it is this collection's either way
			target = { dir, dirParts, name, path, existing };
			if (existing === null || owner === key) break;
		}
		return target;
	}

	function generateReport(collection) {
		return scope.ZB.main.enqueue(() => generateReportNow(collection));
	}

	async function generateReportNow(collection) {
		let ZB = scope.ZB;
		let headline = "ZotMax：PRISMA 與證據表";
		let settings;
		try {
			settings = await ZB.main.readSettings();
		}
		catch (e) {
			ZB.main.notify("ZotMax 設定有誤", String(e.message || e));
			return null;
		}
		let useNotion = !!(settings.notionToken && notionParent(settings));
		if (!settings.vaultPath && !useNotion) {
			ZB.main.notify(headline, "請先到 設定 → ZotMax 填入 Obsidian vault 路徑（或 Notion token 與「PRISMA 頁面的 Notion 父頁面」）。");
			return null;
		}
		let cfg = config();
		let items = ZB.adapter.itemsInCollection(collection, true);
		if (!items.length) {
			ZB.main.notify(headline, `「${collection.name}」裡沒有文獻。`);
			return null;
		}
		let pw = new Zotero.ProgressWindow({ closeOnClick: true });
		pw.changeHeadline(headline);
		pw.show();
		let line = new pw.ItemProgress("note", `計算「${collection.name}」的 PRISMA 計數…`);
		let errors = [];
		let outputs = [];
		let result;
		try {
			let records = items.map(itemRecord);
			let byID = new Map(items.map(i => [i.id, i]));
			result = computePrisma(records, cfg);
			// Evidence table: each included study's structured data, read from its AI note like a sync does
			let index = settings.vaultPath ? await ZB.main.buildObsidianIndex(settings) : null;
			let rows = [];
			let noData = [];
			for (let r of result.included) {
				let study = null;
				let note = ZB.adapter.getAINote(byID.get(r.id));
				if (note) {
					try {
						study = ZB.main.readAINote(note.getNote()).data;
					}
					catch (e) {
						Zotero.logError(e);
					}
				}
				if (!study) noData.push(r);
				// A verified 文獻評讀表 overrides the AI note's tool and verdict (appraisal-form.js)
				if (study && ZB.appraisalForm) study = ZB.appraisalForm.overrideStudyForItem(byID.get(r.id), study);
				let entries = index ? index.get(`${r.libraryPath}/${r.key}`) || [] : [];
				let link = entries.length ? entries[0].relParts.join("/").replace(/\.md$/i, "") : "";
				rows.push(evidenceRow(r, study, link));
			}
			rows = sortRows(rows);
			if (noData.length) {
				let [, level, message] = ISSUES.find(i => i[0] === "noStudyData");
				result.issues.push({ code: "noStudyData", level, message, records: noData });
			}
			let generatedAt = new Date().toISOString();
			let lib = ZB.adapter.libraryInfo(collection.libraryID);
			let meta = {
				name: collection.name,
				path: ZB.adapter.collectionPath(collection),
				collectionKey: collectionKey(collection),
				uri: `zotero://select/${lib.path}/collections/${collection.key}`,
				generatedAt,
				title: `${collection.name}：篩選與 PRISMA 2020`,
			};
			let target = settings.vaultPath ? await reviewNotePath(settings, collection) : null;
			if (target) meta.csvPath = [...target.dirParts, `${target.name} 證據表.csv`].join("/");

			if (useNotion) {
				line.setText("寫入 Notion…");
				try {
					let md = buildReviewSection(result, rows, Object.assign({}, meta, { links: false, csvPath: "" }));
					meta.notionUrl = await syncNotion(settings, meta.collectionKey, `PRISMA 2020：${collection.name}`, md);
					outputs.push("Notion");
				}
				catch (e) {
					errors.push(`Notion：${e.message || e}`);
				}
			}
			if (target) {
				line.setText("寫入 Obsidian…");
				try {
					await IOUtils.makeDirectory(target.dir, { createAncestors: true, ignoreExisting: true });
					await IOUtils.writeUTF8(PathUtils.join(target.dir, `${target.name} 證據表.csv`), buildCSV(rows));
					let section = buildReviewSection(result, rows, Object.assign({}, meta, { links: true }));
					let text = buildReviewNote(target.existing, frontmatterFor(result, meta), meta.title, section);
					if (text !== target.existing) await IOUtils.writeUTF8(target.path, text);
					outputs.push(`Obsidian（${[...target.dirParts, target.name + ".md"].join("/")}）`, "CSV");
				}
				catch (e) {
					errors.push(`Obsidian：${e.message || e}`);
				}
			}
			let c = result.counts;
			let o = result.other && result.other.counts;
			line.setText(`辨識 ${c.identified} → 重複 ${c.duplicates} → 篩選 ${c.screened} → 全文評估 ${c.assessed} → 納入 ${c.included}`
				+ (o ? `｜其他方法：辨識 ${o.identified} → 全文評估 ${o.assessed} → 納入 ${o.included}（共納入 ${result.totalIncluded}）` : ""));
			pw.addDescription(`已寫入：${outputs.join("、") || "（無）"}`);
			let warns = result.issues.filter(i => i.level === "warn");
			if (warns.length) pw.addDescription(`⚠️ 一致性檢查有 ${warns.length} 項問題，詳見筆記的「一致性檢查」`);
			let taPending = c.taPending + (o ? o.taPending : 0);
			let ftPending = c.ftPending + (o ? o.ftPending : 0);
			if (taPending + ftPending) pw.addDescription(`還有 ${taPending + ftPending} 筆尚未完成篩選（標題摘要 ${taPending}、全文 ${ftPending}）`);
			if (settings.notionToken && !useNotion) pw.addDescription("想同步到 Notion：請在設定填入「PRISMA 頁面的 Notion 父頁面」（或文獻比較表的父頁面）。");
			if (errors.length) {
				line.setError();
				errors.forEach(e => Zotero.logError(new Error(e)));
				pw.addDescription(errors.join("\n"));
			}
			else {
				line.setProgress(100);
			}
		}
		catch (e) {
			Zotero.logError(e);
			errors.push(String(e.message || e));
			line.setText(`失敗：${e.message || e}`);
			line.setError();
		}
		pw.startCloseTimer(errors.length ? 20000 : 10000);
		return result ? { result, outputs, errors } : null;
	}

	return {
		DEFAULT_PREFIX, DEFAULT_REASON_PREFIX, DEFAULT_SOURCE_PREFIX, DEFAULT_REASONS, MAX_MENU_REASONS, NO_REASON, NO_SOURCE,
		NOTION_ANCHOR, NOTION_ANCHOR_PREFIXES, isNotionAnchor, REVIEW_FOLDER, DEFAULT_OTHER_SOURCES,
		parseReasons, parseSourceList, isOtherMethod, normalizeConfig, stageTag, duplicateTag, reasonTag, decisionTags, readState, isScreeningTag, hasDecision,
		planChange, describeState, describeChange,
		normalizeDOI, normalizeTitle, yearOf, findDuplicates,
		computePrisma, checkCounts, buildMermaid, countsTable, issuesMarkdown, evidenceRow, sortRows, evidenceTable,
		csvCell, buildCSV, buildReviewSection, frontmatterFor, buildReviewNote, notionBlocks,
		config, itemRecord, setDecision, renderPaneRow, dedupCollection, generateReport,
	};
});
