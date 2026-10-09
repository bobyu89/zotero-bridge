/*
 * ZotMax — 文獻自動分類: suggest Zotero sub-collections, the user ticks what they agree with,
 * then the plugin adds the items to them.
 *
 * Four dimensions, each switchable in the settings (classify.design / .topics / .rules / .pico):
 *   研究設計／證據等級  the AI note's structured data when there is one (no extra cost); otherwise a
 *                       transparent guess from tags, Extra, title and abstract (「規則推測」). Evidence
 *                       levels only come from the AI note.
 *   自訂主題            the user's topic list; an AI decides membership from title + abstract (+ the AI
 *                       note's one-line summary), several items per request, system prompt cached.
 *                       Needs the 「AI 主題分類」 switch (classifyAI) and an API key, never silently skipped.
 *   規則                the user's rules, `子分類名稱 = 條件` (title:/abstract:/tag:/journal:/year/
 *                       language:/type:/author: with AND/OR/NOT, parentheses, quotes); deterministic.
 *   PICO               P / I / O from the AI note, merged with the concept cards' alias groups.
 *
 * Output is Zotero sub-collections only: <location>/自動分類/<dimension folder>/<value>. Existing
 * collections with the same name are reused; items are only ever added, never removed, and no user
 * collection is renamed or deleted. The last applied run is kept (classify.lastRun) so 「復原上次分類」
 * removes exactly the memberships it added and the collections it created that are empty again.
 *
 * The functions down to "Zotero" are pure (Node tests); the rest needs Zotero.
 */
(function (root, factory) {
	if (typeof module === "object" && module.exports) {
		module.exports = factory(require("./concepts.js"), require("./usage.js"), require("./llm.js"), globalThis);
	}
	else {
		(root.ZB = root.ZB || {}).classify = factory(root.ZB.concepts, root.ZB.usage, root.ZB.llm, root);
	}
})(this, function (concepts, usage, llm, scope) {
	const PREF = "extensions.zotero-bridge.";
	const TITLE = "ZotMax：文獻自動分類";
	const DEFAULT_PARENT = "自動分類";
	const HTML_NS = "http://www.w3.org/1999/xhtml";
	const DIALOG_URL = "chrome://zotero-bridge/content/classify-review.xhtml";
	const DIALOG_ROOT = "zb-classify";
	const MAX_NAME = 80;
	const TOPIC_BATCH = 10;
	const MAX_ABSTRACT = 2000;

	/** Dimensions in display order, with their folder under the parent collection. */
	const DIMENSIONS = [
		{ id: "design", folder: "研究設計", label: "研究設計", setting: "design" },
		{ id: "level", folder: "證據等級", label: "證據等級", setting: "design" },
		{ id: "topic", folder: "主題", label: "主題", setting: "topics" },
		{ id: "rule", folder: "規則", label: "規則", setting: "rules" },
		{ id: "population", folder: "族群 P", label: "族群 P", setting: "pico" },
		{ id: "intervention", folder: "介入 I", label: "介入 I", setting: "pico" },
		{ id: "outcome", folder: "結果 O", label: "結果 O", setting: "pico" },
	];
	const DIM = new Map(DIMENSIONS.map(d => [d.id, d]));

	const SOURCE_LABELS = { ai: "AI 筆記", heuristic: "規則推測", rule: "你的規則", topic: "AI 判斷" };
	const CONFIDENCE_LABELS = { high: "高", medium: "中", low: "低" };

	// llm.STUDY_DESIGNS → sub-collection names (method terms stay in English)
	const DESIGN_NAMES = {
		"RCT": "RCT",
		"quasi-experimental": "Quasi-experimental",
		"cohort": "Cohort",
		"case-control": "Case-control",
		"cross-sectional": "Cross-sectional",
		"qualitative": "Qualitative",
		"mixed methods": "Mixed methods",
		"systematic review": "Systematic review & meta-analysis",
		"meta-analysis": "Systematic review & meta-analysis",
		"scoping review": "Scoping review",
		"guideline": "Guideline",
		"other": "其他設計",
	};

	// ---------- names (pure) ----------

	/** NFKC, single spaces, trimmed, at most MAX_NAME characters (no control characters). */
	function cleanName(raw) {
		return String(raw === undefined || raw === null ? "" : raw).normalize("NFKC")
			.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME).trim();
	}

	/** Collection names compare case-insensitively after NFKC (full-width → half-width). */
	function nameKey(raw) {
		return cleanName(raw).toLowerCase();
	}

	function sameName(a, b) {
		return nameKey(a) === nameKey(b);
	}

	/** Text for matching: NFKC, lower case, single spaces. */
	function norm(s) {
		return String(s === undefined || s === null ? "" : s).normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
	}

	function hasCJK(s) {
		return /[㐀-鿿豈-﫿]/.test(String(s || ""));
	}

	// ---------- rules (pure) ----------

	// Field names in rules, English and Chinese
	const FIELDS = {
		title: "title", "標題": "title",
		abstract: "abstract", "摘要": "abstract",
		tag: "tag", tags: "tag", "標籤": "tag",
		journal: "journal", "期刊": "journal",
		year: "year", "年份": "year",
		language: "language", lang: "language", "語言": "language",
		type: "type", "類型": "type",
		author: "author", "作者": "author",
	};
	const FIELD_RE = new RegExp(`^(${Object.keys(FIELDS).join("|")})\\s*(>=|<=|>|<|=|:|：)\\s*`, "i");
	const QUOTES = { "\"": "\"", "“": "”", "「": "」", "『": "』" };
	// Item types by their Chinese names (the English Zotero names work too)
	const TYPE_ALIASES = {
		"期刊文章": "journalArticle", "期刊論文": "journalArticle", "期刊": "journalArticle",
		"學位論文": "thesis", "論文": "thesis", "碩博士論文": "thesis",
		"書": "book", "書籍": "book", "專書": "book",
		"書籍章節": "bookSection", "章節": "bookSection",
		"研討會論文": "conferencePaper", "報告": "report", "網頁": "webpage", "預印本": "preprint",
	};

	class RuleError extends Error {}

	/** Tokens of one condition: ( ) AND OR NOT, field terms and bare words. */
	function tokenize(text) {
		// NFKC: full-width letters, colons and parentheses become their ASCII forms
		let s = String(text).normalize("NFKC");
		let tokens = [];
		let i = 0;
		let readQuoted = () => {
			let open = s[i];
			let close = QUOTES[open];
			let end = s.indexOf(close, i + 1);
			if (end === -1) throw new RuleError(`引號 ${open} 沒有成對`);
			let value = s.slice(i + 1, end);
			i = end + 1;
			return value;
		};
		while (i < s.length) {
			let rest = s.slice(i);
			let ws = /^\s+/.exec(rest);
			if (ws) {
				i += ws[0].length;
				continue;
			}
			let c = s[i];
			if (c === "(" || c === "（") {
				tokens.push({ type: "(" });
				i++;
				continue;
			}
			if (c === ")" || c === "）") {
				tokens.push({ type: ")" });
				i++;
				continue;
			}
			let field = FIELD_RE.exec(rest);
			if (field) {
				i += field[0].length;
				let op = field[2] === "：" ? ":" : field[2];
				let value;
				if (QUOTES[s[i]]) value = readQuoted();
				else {
					let m = /^[^\s()（）]+/.exec(s.slice(i));
					value = m ? m[0] : "";
					i += value.length;
				}
				if (!value.trim()) throw new RuleError(`「${field[1]}${field[2]}」後面要接要找的字`);
				tokens.push({ type: "term", field: FIELDS[field[1].toLowerCase()] || FIELDS[field[1]], op, value: value.trim(), raw: field[1] });
				continue;
			}
			if (QUOTES[c]) {
				let value = readQuoted();
				if (!value.trim()) throw new RuleError("引號裡沒有字");
				tokens.push({ type: "term", field: "text", op: ":", value: value.trim() });
				continue;
			}
			let m = /^[^\s()（）"“「『]+/.exec(rest);
			let word = m[0];
			i += word.length;
			let upper = word.toUpperCase();
			if (upper === "AND" || upper === "OR" || upper === "NOT") tokens.push({ type: upper });
			else tokens.push({ type: "term", field: "text", op: ":", value: word });
		}
		return tokens;
	}

	/** Check a term and turn year values into numbers. */
	function checkTerm(t) {
		if (t.field === "year") {
			let range = /^(\d{4})\s*[-–~～]\s*(\d{4})$/.exec(t.value);
			if (range && (t.op === ":" || t.op === "=")) return Object.assign(t, { from: Number(range[1]), to: Number(range[2]) });
			if (!/^\d{4}$/.test(t.value)) throw new RuleError(`年份要是四位數字，例如 year>=2020 或 year:2018-2022（現在是「${t.value}」）`);
			return Object.assign(t, { year: Number(t.value) });
		}
		if (t.op !== ":" && t.op !== "=") throw new RuleError(`只有 year 可以用 ${t.op} 比較大小；${t.raw || t.field} 請用「${t.raw || t.field}:字詞」`);
		return t;
	}

	/** Parse one condition into a tree: { and: [a, b] } | { or: [a, b] } | { not: a } | term. Throws RuleError. */
	function parseCondition(text) {
		let tokens = tokenize(text);
		if (!tokens.length) throw new RuleError("等號後面要有條件");
		let pos = 0;
		let peek = () => tokens[pos];
		let next = () => tokens[pos++];
		let parseOr = () => {
			let left = parseAnd();
			while (peek() && peek().type === "OR") {
				next();
				left = { or: [left, parseAnd()] };
			}
			return left;
		};
		let parseAnd = () => {
			let left = parseNot();
			while (peek() && peek().type !== "OR" && peek().type !== ")") {
				if (peek().type === "AND") next();
				left = { and: [left, parseNot()] };
			}
			return left;
		};
		let parseNot = () => {
			if (peek() && peek().type === "NOT") {
				next();
				return { not: parseNot() };
			}
			return parsePrimary();
		};
		let parsePrimary = () => {
			let t = next();
			if (!t) throw new RuleError("條件寫到一半：最後還少一個條件");
			if (t.type === "(") {
				let inner = parseOr();
				if (!peek() || peek().type !== ")") throw new RuleError("少了右括號 )");
				next();
				return inner;
			}
			if (t.type === ")") throw new RuleError("多了一個右括號 )，或括號裡沒有條件");
			if (t.type === "AND" || t.type === "OR") throw new RuleError(`${t.type} 前後都要有條件`);
			return checkTerm(t);
		};
		let tree = parseOr();
		if (pos < tokens.length) throw new RuleError("多了一個右括號 )");
		return tree;
	}

	/**
	 * The rule list from the settings, one per line: `子分類名稱 = 條件`. Lines starting with # or // are
	 * comments. Returns { rules: [{ name, condition, line, tree }], errors: [{ line, message }] }.
	 */
	function parseRules(text) {
		let rules = [];
		let errors = [];
		String(text || "").split(/\r?\n/).forEach((raw, index) => {
			let line = index + 1;
			let s = raw.trim();
			if (!s || s.startsWith("#") || s.startsWith("//")) return;
			let eq = s.search(/[=＝]/);
			if (eq === -1) {
				errors.push({ line, message: "要寫成「子分類名稱 = 條件」，中間用等號分開" });
				return;
			}
			let name = cleanName(s.slice(0, eq));
			let condition = s.slice(eq + 1).trim();
			if (!name) {
				errors.push({ line, message: "等號前面要有子分類名稱" });
				return;
			}
			if (s.slice(0, eq).trim().length > MAX_NAME) {
				errors.push({ line, message: `子分類名稱太長（最多 ${MAX_NAME} 字）` });
				return;
			}
			try {
				rules.push({ name, condition, line, tree: parseCondition(condition) });
			}
			catch (e) {
				if (!(e instanceof RuleError)) throw e;
				errors.push({ line, message: e.message });
			}
		});
		return { rules, errors };
	}

	/** "第 3 行：…" lines for the settings pane and the review dialog. */
	function describeErrors(errors) {
		return errors.map(e => `第 ${e.line} 行：${e.message}`);
	}

	function itemTypeMatches(type, value) {
		let v = TYPE_ALIASES[cleanName(value)] || value;
		return norm(type) === norm(v);
	}

	function languageMatches(record, value) {
		let v = norm(value);
		let lang = norm(record.language);
		if (/^(zh|chi|chinese|中文|華語)$/.test(v)) {
			if (/zh|chi|中/.test(lang)) return true;
			// Chinese items often have no language: a Chinese title counts
			return !lang && hasCJK(record.title);
		}
		if (/^(en|eng|english|英文)$/.test(v)) {
			if (/^en|eng|英/.test(lang)) return true;
			return !lang && !!record.title && !hasCJK(record.title);
		}
		return !!lang && lang.includes(v);
	}

	function termMatches(t, record) {
		let v = norm(t.value);
		switch (t.field) {
			case "title": return norm(record.title).includes(v);
			case "abstract": return norm(record.abstract).includes(v);
			case "text": return norm(record.title).includes(v) || norm(record.abstract).includes(v);
			case "journal": return (record.journal || []).some(j => norm(j).includes(v));
			case "author": return (record.authors || []).some(a => norm(a).includes(v));
			case "type": return itemTypeMatches(record.itemType, t.value);
			case "language": return languageMatches(record, t.value);
			case "tag": {
				let prefix = v.endsWith("*") ? v.slice(0, -1) : null;
				return (record.tags || []).some(tag => (prefix !== null ? norm(tag).startsWith(prefix) : norm(tag) === v));
			}
			case "year": {
				let y = Number(record.year);
				if (!Number.isFinite(y) || !y) return false;
				if (t.from) return y >= Math.min(t.from, t.to) && y <= Math.max(t.from, t.to);
				switch (t.op) {
					case ">=": return y >= t.year;
					case "<=": return y <= t.year;
					case ">": return y > t.year;
					case "<": return y < t.year;
					default: return y === t.year;
				}
			}
			default: return false;
		}
	}

	/** Does the record satisfy the parsed condition? */
	function evaluate(tree, record) {
		if (tree.and) return evaluate(tree.and[0], record) && evaluate(tree.and[1], record);
		if (tree.or) return evaluate(tree.or[0], record) || evaluate(tree.or[1], record);
		if (tree.not) return !evaluate(tree.not, record);
		return termMatches(tree, record);
	}

	// ---------- topics (pure) ----------

	/** The topic list, one per line: `名稱` or `名稱: 說明`. Returns { topics: [{ name, description, line }], errors }. */
	function parseTopics(text) {
		let topics = [];
		let errors = [];
		let seen = new Map();
		String(text || "").split(/\r?\n/).forEach((raw, index) => {
			let line = index + 1;
			let s = raw.trim();
			if (!s || s.startsWith("#") || s.startsWith("//")) return;
			let colon = s.search(/[:：]/);
			let name = cleanName(colon === -1 ? s : s.slice(0, colon));
			let description = colon === -1 ? "" : s.slice(colon + 1).trim();
			if (!name) {
				errors.push({ line, message: "冒號前面要有主題名稱" });
				return;
			}
			if (seen.has(nameKey(name))) {
				errors.push({ line, message: `主題「${name}」在第 ${seen.get(nameKey(name))} 行已經列過` });
				return;
			}
			seen.set(nameKey(name), line);
			topics.push({ name, description, line });
		});
		return { topics, errors };
	}

	const TOPIC_SYSTEM = `你是護理與醫學研究生的文獻整理助理。任務：判斷每篇文獻屬於使用者列出的哪些主題，結果只是建議，使用者會逐篇確認。

判斷規則：
- 只根據提供的標題、摘要與筆記摘要判斷，不要猜測沒有寫到的內容。
- 一篇文獻可以屬於多個主題，也可以都不屬於；不確定時寧可不歸類。
- confidence：high＝標題或摘要明確以這個主題為重點；medium＝內容相關但不是重點；low＝只有間接關聯。

輸出格式：只輸出一個 JSON 物件，不要加任何說明文字或 Markdown：
{"results":[{"id":"S1","topics":[{"topic":"主題名稱","confidence":"high"}]}]}
- id 照抄文獻代號，每篇文獻都要出現在 results 中。
- topic 必須完全照抄主題清單中的名稱；不屬於任何主題時 topics 給 []。`;

	function topicListText(topics) {
		return "主題清單（名稱：說明）：\n" + topics.map(t => `- ${t.name}${t.description ? `：${t.description}` : ""}`).join("\n");
	}

	function truncate(text, max) {
		let s = String(text || "").replace(/\s+/g, " ").trim();
		return s.length > max ? s.slice(0, max) + "…" : s;
	}

	/**
	 * One request for a batch of items. system: the instructions and the topic list (the same for every
	 * batch, so it is cached with a breakpoint after it); user: the items, labelled S1, S2…
	 * entries: [{ id, title, abstract, summary }]
	 */
	function buildTopicPrompt(topics, entries) {
		let user = [`請判斷以下 ${entries.length} 篇文獻屬於哪些主題：`];
		for (let e of entries) {
			let lines = [`[${e.id}]`, `標題：${truncate(e.title, 500) || "（無）"}`, `摘要：${truncate(e.abstract, MAX_ABSTRACT) || "（無）"}`];
			if (e.summary) lines.push(`筆記摘要：${truncate(e.summary, 300)}`);
			user.push(lines.join("\n"));
		}
		return { system: [TOPIC_SYSTEM, topicListText(topics)], user: user.join("\n\n") };
	}

	function parseJSONLoose(text) {
		let s = String(text || "").trim();
		let fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
		if (fence) s = fence[1].trim();
		let start = s.search(/[[{]/);
		if (start > 0) s = s.slice(start);
		let end = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
		if (end >= 0) s = s.slice(0, end + 1);
		try {
			return JSON.parse(s);
		}
		catch (e) {
			// Trailing commas, the most common slip
			return JSON.parse(s.replace(/,\s*([}\]])/g, "$1"));
		}
	}

	function normalizeConfidence(v) {
		let s = norm(v);
		if (/^(high|高|strong|明確)/.test(s)) return "high";
		if (/^(low|低|weak|間接)/.test(s)) return "low";
		return "medium";
	}

	/**
	 * Read the AI's answer. Unknown topics and unknown IDs are ignored (and counted).
	 * Returns { results: Map<id, [{ topic, confidence }]>, unknownTopics: [names], error }.
	 */
	function parseTopicResponse(text, topics, ids) {
		let results = new Map();
		let unknownTopics = new Set();
		let byKey = new Map(topics.map(t => [nameKey(t.name), t.name]));
		let known = new Set(ids);
		let json;
		try {
			json = parseJSONLoose(text);
		}
		catch (e) {
			return { results, unknownTopics: [], error: "AI 的回覆不是有效的 JSON" };
		}
		let list = Array.isArray(json) ? json : json && Array.isArray(json.results) ? json.results : null;
		if (!list) return { results, unknownTopics: [], error: "AI 的回覆沒有 results 清單" };
		for (let entry of list) {
			if (!entry || typeof entry !== "object") continue;
			let id = String(entry.id || "").trim().replace(/^\[|\]$/g, "");
			if (!known.has(id)) continue;
			let picked = new Map();
			for (let t of Array.isArray(entry.topics) ? entry.topics : []) {
				let raw = typeof t === "string" ? t : t && (t.topic || t.name);
				let name = byKey.get(nameKey(raw));
				if (!name) {
					if (raw) unknownTopics.add(String(raw));
					continue;
				}
				if (!picked.has(name)) picked.set(name, { topic: name, confidence: normalizeConfidence(typeof t === "object" ? t.confidence : "") });
			}
			results.set(id, [...picked.values()]);
		}
		return { results, unknownTopics: [...unknownTopics], error: "" };
	}

	/** Rough tokens: about one per CJK character, one per four other characters. */
	function estimateTokens(text) {
		let s = String(text || "");
		let cjk = (s.match(/[　-鿿豈-﫿＀-￯]/g) || []).length;
		return Math.ceil(cjk + (s.length - cjk) / 4);
	}

	/**
	 * Calls, tokens and cost (null when the model has no price) of classifying `entries` into `topics`.
	 * The system prompt is written to the cache by the first call and read by the others (when it is
	 * long enough to be cached at all).
	 */
	function estimateTopicRun(topics, entries, model, prices, batchSize = TOPIC_BATCH) {
		let calls = Math.ceil(entries.length / batchSize);
		let systemTokens = estimateTokens(TOPIC_SYSTEM + topicListText(topics));
		let counters = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		for (let i = 0; i < calls; i++) {
			let batch = entries.slice(i * batchSize, (i + 1) * batchSize);
			counters.input += estimateTokens(buildTopicPrompt(topics, batch).user);
			if (systemTokens < 1024) counters.input += systemTokens;
			else if (i === 0) counters.cacheWrite += systemTokens;
			else counters.cacheRead += systemTokens;
			counters.output += 20 + batch.length * (15 + 12 * Math.min(topics.length, 3));
		}
		let price = usage.priceFor(model, prices);
		return Object.assign({ calls, items: entries.length, cost: price ? usage.costOf(counters, price) : null }, counters);
	}

	// ---------- study design, evidence level, PICO (pure) ----------

	// Checked in order: the more specific designs win ("systematic review of randomized trials" is a review).
	// weak: a hint rather than a statement of the design.
	const DESIGN_RULES = [
		{ value: "Scoping review", review: true, re: /scoping (?:review|study)|範域回顧|範疇回顧/i },
		{ value: "Systematic review & meta-analysis", review: true, re: /meta[\s-]?analy[sz]|systematic (?:literature )?review|umbrella review|統合分析|後設分析|系統性(?:文獻)?回顧/i },
		{ value: "Mixed methods", re: /mixed[\s-]?methods?|混合(?:研究)?方法/i },
		{ value: "Quasi-experimental", re: /quasi[\s-]?experiment|non[\s-]?randomi[sz]ed|pre[\s-]?(?:and[\s-]?)?post[\s-]?test|one[\s-]group|before[\s-]and[\s-]after|類實驗|準實驗|前後測/i },
		{ value: "RCT", re: /\brcts?\b|randomi[sz]ed|隨機(?:分派|分配|對照|控制|臨床)/i },
		{ value: "Case-control", re: /case[\s-]control|病例對照/i },
		{ value: "Cohort", re: /\bcohort\b|longitudinal (?:study|analysis|survey)|世代研究|縱貫(?:性)?研究/i },
		{ value: "Cross-sectional", re: /cross[\s-]?sectional|橫斷(?:面|性)?(?:研究|調查)/i },
		{ value: "Qualitative", re: /qualitative|phenomenolog|grounded theory|ethnograph|thematic analysis|質性研究|現象學|紮根理論|深度訪談/i },
		{ value: "Guideline", re: /(?:practice|clinical) guidelines?\b|consensus statement|臨床(?:實務)?指引|照護指引/i },
		{ value: "Cross-sectional", weak: true, re: /\bsurvey\b|questionnaire study|correlational|問卷調查|相關性研究/i },
	];

	function firstDesign(text) {
		for (let rule of DESIGN_RULES) {
			let m = rule.re.exec(text);
			if (m) return { rule, match: m[0] };
		}
		return null;
	}

	function suggestion(dimension, value, source, confidence, reason) {
		return { dimension, value: cleanName(value), source, confidence, reason, checked: confidence !== "low" };
	}

	/**
	 * The study design from the item itself (no AI note): publication types in tags/Extra and the title
	 * are strong signals, the abstract a weaker one (it also mentions the designs of other studies).
	 */
	function guessDesign(record) {
		// MeSH "… as Topic" tags describe the subject, not this paper's design
		let tagText = (record.tags || []).filter(t => !/as topic/i.test(t)).join("\n") + "\n" + (record.extra || "");
		let hit = firstDesign(tagText);
		if (hit) return suggestion("design", hit.rule.value, "heuristic", hit.rule.weak ? "medium" : "high", `標籤或 Extra 有「${hit.match}」`);
		hit = firstDesign(record.title || "");
		if (hit) return suggestion("design", hit.rule.value, "heuristic", hit.rule.weak ? "medium" : "high", `標題有「${hit.match}」`);
		let abstract = record.abstract || "";
		hit = firstDesign(abstract);
		if (!hit) return null;
		let others = new Set(DESIGN_RULES.filter(r => !r.weak && r.re.test(abstract)).map(r => r.value));
		others.delete(hit.rule.value);
		let clear = !hit.rule.weak && (hit.rule.review || !others.size);
		return suggestion("design", hit.rule.value, "heuristic", clear ? "medium" : "low",
			`摘要有「${hit.match}」${others.size ? `，也提到 ${[...others].join("、")}` : ""}`);
	}

	/** Design from the AI note's structured data, else the guess; evidence levels only from the AI note. */
	function designSuggestions(record) {
		let data = record.ai && record.ai.data;
		let out = [];
		if (data && data.study_design && DESIGN_NAMES[data.study_design]) {
			out.push(suggestion("design", DESIGN_NAMES[data.study_design], "ai", "high", `AI 筆記的研究設計：${data.study_design}`));
		}
		else {
			let guess = guessDesign(record);
			if (guess) out.push(guess);
		}
		if (data && data.evidence_level) {
			out.push(suggestion("level", `CEBM Level ${data.evidence_level}`, "ai", "medium", "AI 筆記的證據等級（Oxford CEBM 2011），請對照原文確認"));
		}
		if (data && data.jbi_level) {
			out.push(suggestion("level", `JBI Level ${data.jbi_level}`, "ai", "medium", "AI 筆記的 JBI 證據等級，請對照原文確認"));
		}
		return out;
	}

	const NOT_REPORTED_RE = /^(?:n\/?a|null|none|無|不適用|未報告|文中未報告|not reported|未提及)$/i;

	function splitPart(text) {
		return [...new Set(String(text || "").split(/\s*[;；\n]\s*/).map(cleanName).filter(s => s && !NOT_REPORTED_RE.test(s)))];
	}

	/** P, I and O values of one AI note: { population, intervention, outcome: [{ value, from }] }. */
	function picoValues(data) {
		if (!data) return null;
		let outcomes = concepts.splitOutcomes(data.outcomes).map(cleanName).filter(Boolean);
		let from = "outcomes";
		if (!outcomes.length && Array.isArray(data.measures)) {
			outcomes = data.measures.map(cleanName).filter(s => s && !NOT_REPORTED_RE.test(s));
			from = "measures";
		}
		return {
			population: splitPart(data.population).map(value => ({ value, from: "population" })),
			intervention: splitPart(data.intervention).map(value => ({ value, from: "intervention" })),
			outcome: outcomes.map(value => ({ value, from })),
		};
	}

	/**
	 * PICO suggestions for every record (Map key → suggestions). Values are merged by the concept
	 * cards' alias groups and by spelling (NFKC, case, spaces, hyphens); an existing sub-collection
	 * keeps its name. A value only one paper uses (and no alias or existing sub-collection backs it) is
	 * suggested unchecked, so the folder doesn't fill with one-paper sub-collections.
	 * existing: { population: [names], intervention: [...], outcome: [...] }
	 */
	function picoSuggestions(records, aliases, existing = {}) {
		let aliasMap = (aliases && aliases.map) || new Map();
		let per = new Map();
		let groups = { population: new Map(), intervention: new Map(), outcome: new Map() };
		for (let r of records) {
			let values = picoValues(r.ai && r.ai.data);
			if (!values) continue;
			let list = [];
			for (let dim of ["population", "intervention", "outcome"]) {
				for (let v of values[dim]) {
					let ck = concepts.conceptKey(v.value);
					let alias = aliasMap.get(ck);
					let key = alias ? alias.key : ck;
					let g = groups[dim].get(key);
					if (!g) {
						let have = (existing[dim] || []).find(n => concepts.conceptKey(n) === key || (alias && alias.names.some(a => concepts.conceptKey(a) === concepts.conceptKey(n))));
						g = { name: have || (alias ? alias.name : v.value), alias: !!alias, existing: !!have, items: new Set() };
						groups[dim].set(key, g);
					}
					g.items.add(r.key);
					list.push({ dim, key, raw: v.value, from: v.from });
				}
			}
			per.set(r.key, list);
		}
		let out = new Map();
		for (let [itemKey, list] of per) {
			let seen = new Set();
			let suggestions = [];
			for (let { dim, key, raw, from } of list) {
				if (seen.has(dim + "|" + key)) continue;
				seen.add(dim + "|" + key);
				let g = groups[dim].get(key);
				let shared = g.items.size >= 2;
				let reasons = [`AI 筆記的 ${from}${raw !== g.name ? `「${raw}」` : ""}`];
				if (g.alias && raw !== g.name) reasons.push(`依同義詞設定合併為「${g.name}」`);
				else if (!g.alias && raw !== g.name) reasons.push(`和「${g.name}」視為同一個`);
				if (g.existing) reasons.push("已有這個子分類");
				else if (shared) reasons.push(`這次有 ${g.items.size} 篇`);
				else if (!g.alias) reasons.push("只有這篇用這個說法，先不勾");
				suggestions.push(suggestion(dim, g.name, "ai", shared || g.alias || g.existing ? "medium" : "low", reasons.join("；")));
			}
			out.set(itemKey, suggestions);
		}
		return out;
	}

	// ---------- plan (pure) ----------

	/**
	 * Every suggestion for every record, grouped as the review dialog shows them.
	 * opts: { dimensions: { design, topics, rules, pico }, rules: parseRules().rules, aliases,
	 *   topics: Map<record key, [{ topic, confidence }]> | null, existing: { population: [names], … } }
	 * Returns [{ key, id, libraryID, title, year, journal, hasAI, suggestions, notes }].
	 */
	function buildSuggestions(records, opts = {}) {
		let dims = Object.assign({ design: true, topics: true, rules: true, pico: true }, opts.dimensions);
		let pico = dims.pico ? picoSuggestions(records, opts.aliases, opts.existing) : new Map();
		return records.map((r) => {
			let list = [];
			let notes = [];
			let hasAI = !!(r.ai && r.ai.data);
			if (dims.design) list.push(...designSuggestions(r));
			if (dims.topics && opts.topics) {
				for (let t of opts.topics.get(r.key) || []) {
					list.push(suggestion("topic", t.topic, "topic", t.confidence, "AI 依標題與摘要判斷"));
				}
			}
			if (dims.rules) {
				for (let rule of opts.rules || []) {
					if (evaluate(rule.tree, r)) list.push(suggestion("rule", rule.name, "rule", "high", `符合第 ${rule.line} 行：${rule.condition}`));
				}
			}
			if (dims.pico) list.push(...(pico.get(r.key) || []));
			if (!hasAI && (dims.pico || dims.design)) {
				notes.push(dims.pico ? "沒有 AI 筆記的結構化資料：沒有 PICO 與證據等級建議" : "沒有 AI 筆記的結構化資料：沒有證據等級建議");
			}
			// One suggestion per dimension and name
			let seen = new Set();
			let suggestions = list.filter((s) => {
				let k = s.dimension + "|" + nameKey(s.value);
				if (!s.value || seen.has(k)) return false;
				seen.add(k);
				return true;
			}).sort((a, b) => DIMENSIONS.indexOf(DIM.get(a.dimension)) - DIMENSIONS.indexOf(DIM.get(b.dimension)));
			return {
				key: r.key, id: r.id, libraryID: r.libraryID, title: r.title || "（無標題）", year: r.year || "",
				journal: (r.journal || [])[0] || "", hasAI, suggestions, notes,
			};
		});
	}

	/** The ticked suggestions as picks: [{ itemKey, itemID, libraryID, dimension, value }]. */
	function defaultPicks(plan) {
		let picks = [];
		for (let item of plan.items) {
			for (let s of item.suggestions) {
				if (s.checked) picks.push({ itemKey: item.key, itemID: item.id, libraryID: item.libraryID, dimension: s.dimension, value: s.value });
			}
		}
		return picks;
	}

	function childNamed(node, name) {
		return node ? (node.children || []).find(c => sameName(c.name, name)) || null : null;
	}

	/**
	 * What applying `picks` would do, given what already exists under the location:
	 * snapshot: { parentName, parent: { name, key, items: [item keys], children: [same] } | null }
	 * Returns { creates: [[names…]], adds: [{ path, items: [item keys] }], already, added } with paths
	 * relative to the location (parent / dimension folder / value). Existing names are reused.
	 */
	function planApply(snapshot, picks) {
		let parentName = (snapshot && snapshot.parentName) || DEFAULT_PARENT;
		let creates = [];
		let createdKeys = new Set();
		let adds = new Map();
		let already = 0;
		let added = 0;
		let mark = (path) => {
			let k = path.map(nameKey).join("/");
			if (!createdKeys.has(k)) {
				createdKeys.add(k);
				creates.push(path);
			}
		};
		let parent = snapshot && snapshot.parent;
		for (let pick of picks) {
			let dim = DIM.get(pick.dimension);
			if (!dim) continue;
			let folder = childNamed(parent, dim.folder);
			let value = childNamed(folder, pick.value);
			let path = [parent ? parent.name : parentName, folder ? folder.name : dim.folder, value ? value.name : cleanName(pick.value)];
			if (!parent) mark(path.slice(0, 1));
			if (!folder) mark(path.slice(0, 2));
			if (!value) mark(path);
			if (value && (value.items || []).includes(pick.itemKey)) {
				already++;
				continue;
			}
			let k = path.map(nameKey).join("/");
			let entry = adds.get(k) || { path, items: [] };
			if (!entry.items.includes(pick.itemKey)) {
				entry.items.push(pick.itemKey);
				added++;
			}
			adds.set(k, entry);
		}
		return { creates, adds: [...adds.values()], already, added };
	}

	/** "會建立 3 個子分類，加入 12 筆（2 筆原本就在）" for the dialog footer. */
	function describeCounts(counts, picked) {
		if (!picked) return "還沒有勾選任何建議。按「套用」不會有任何變動。";
		let parts = [`已勾選 ${picked} 項：`];
		parts.push(counts.creates ? `會建立 ${counts.creates} 個子分類，` : "不需要新的子分類，");
		parts.push(counts.added ? `加入 ${counts.added} 筆` : "沒有新的加入");
		if (counts.already) parts.push(`（${counts.already} 筆原本就在）`);
		return parts.join("") + "。";
	}

	// ---------- review dialog (DOM; pure enough for jsdom) ----------

	/**
	 * Draw the review into `root` (an HTML element of the dialog window) and wire it up.
	 * plan: { items, notes, target, libraries: [{ libraryID, snapshot }] }
	 * handlers: { onApply(picks), onCancel() } — called once.
	 */
	function renderReview(doc, root, plan, handlers) {
		let el = (tag, attrs, text) => {
			let e = doc.createElementNS(HTML_NS, tag);
			for (let [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
			if (text !== undefined) e.textContent = text;
			return e;
		};
		root.replaceChildren();
		let boxes = [];
		let decided = false;

		let head = el("header", { class: "zb-cl-head" });
		head.append(
			el("h1", { class: "zb-cl-title" }, "文獻自動分類：先看建議，再決定"),
			el("p", { class: "zb-cl-lead" }, "下面是建議，判斷在你。勾選你同意的，按「套用」才會把文獻加進 Zotero 子分類；不會把文獻移出任何分類，也不會改動或刪除你原本的分類。之後想反悔：ZotMax 按鈕或快速指令 → 復原上次分類。"),
		);
		if (plan.target) head.append(el("p", { class: "zb-cl-target" }, `放在：${plan.target}`));
		if (plan.notes && plan.notes.length) {
			let notes = el("ul", { class: "zb-cl-notes", "aria-label": "這次的說明" });
			for (let n of plan.notes) notes.append(el("li", {}, n));
			head.append(notes);
		}

		let withSuggestions = plan.items.filter(i => i.suggestions.length);
		let without = plan.items.filter(i => !i.suggestions.length);
		let dimsPresent = DIMENSIONS.filter(d => withSuggestions.some(i => i.suggestions.some(s => s.dimension === d.id)));
		if (dimsPresent.length) {
			let bar = el("div", { class: "zb-cl-dims", role: "group", "aria-label": "依面向全選或全不選" });
			for (let d of dimsPresent) {
				let count = withSuggestions.reduce((n, i) => n + i.suggestions.filter(s => s.dimension === d.id).length, 0);
				let row = el("div", { class: "zb-cl-dim" });
				let all = el("button", { type: "button", class: "zb-cl-all", "data-dimension": d.id, "aria-label": `${d.label}：全選` }, "全選");
				let none = el("button", { type: "button", class: "zb-cl-none-btn", "data-dimension": d.id, "aria-label": `${d.label}：全不選` }, "全不選");
				all.addEventListener("click", () => setDimension(d.id, true));
				none.addEventListener("click", () => setDimension(d.id, false));
				row.append(el("span", { class: "zb-cl-dim-name" }, d.label), el("span", { class: "zb-cl-dim-count" }, `${count} 項`), all, none);
				bar.append(row);
			}
			head.append(bar);
		}

		let list = el("div", { class: "zb-cl-list", tabindex: "-1" });
		if (!withSuggestions.length) {
			list.append(el("p", { class: "zb-cl-empty" }, "這次沒有任何分類建議。可以到 設定 → ZotMax → 文獻自動分類 打開更多面向、列主題或寫規則，再試一次。"));
		}
		withSuggestions.forEach((item, index) => {
			let section = el("section", { class: "zb-cl-item", "aria-labelledby": `zb-cl-item-${index}` });
			section.append(el("h2", { class: "zb-cl-item-title", id: `zb-cl-item-${index}` }, item.title));
			let meta = [item.year, item.journal].filter(Boolean).join(" · ");
			if (meta) section.append(el("p", { class: "zb-cl-item-meta" }, meta));
			for (let d of DIMENSIONS) {
				let suggestions = item.suggestions.filter(s => s.dimension === d.id);
				if (!suggestions.length) continue;
				let groupID = `zb-cl-g-${index}-${d.id}`;
				let group = el("div", { class: "zb-cl-group", role: "group", "aria-labelledby": groupID });
				group.append(el("span", { class: "zb-cl-group-name", id: groupID }, d.label));
				let options = el("div", { class: "zb-cl-options" });
				suggestions.forEach((s, j) => {
					let id = `zb-cl-s-${index}-${d.id}-${j}`;
					let box = el("input", { type: "checkbox", id, "aria-describedby": `${id}-why` });
					box.checked = !!s.checked;
					box.addEventListener("change", update);
					boxes.push({ box, item, s });
					let label = el("label", { class: "zb-cl-sugg", for: id });
					label.append(el("span", { class: "zb-cl-value" }, s.value));
					let row = el("div", { class: "zb-cl-option" });
					row.append(box, label, el("span", { class: "zb-cl-why", id: `${id}-why` },
						`${SOURCE_LABELS[s.source] || s.source}・${CONFIDENCE_LABELS[s.confidence] || s.confidence}${s.reason ? `｜${s.reason}` : ""}`));
					options.append(row);
				});
				group.append(options);
				section.append(group);
			}
			for (let n of item.notes) section.append(el("p", { class: "zb-cl-item-note" }, n));
			list.append(section);
		});
		if (without.length) {
			let details = el("details", { class: "zb-cl-without" });
			details.append(el("summary", {}, `${without.length} 篇沒有任何建議`));
			let ul = el("ul");
			for (let item of without) ul.append(el("li", {}, item.title + (item.notes.length ? `（${item.notes.join("；")}）` : "")));
			details.append(ul);
			list.append(details);
		}

		let foot = el("footer", { class: "zb-cl-foot" });
		let summary = el("p", { class: "zb-cl-summary", role: "status", "aria-live": "polite" });
		let cancel = el("button", { type: "button", class: "zb-cl-cancel" }, "取消");
		let apply = el("button", { type: "button", class: "zb-cl-apply" }, "套用");
		if (!withSuggestions.length) cancel.textContent = "關閉";
		cancel.addEventListener("click", () => finish(null));
		apply.addEventListener("click", () => finish(picks()));
		let buttons = el("div", { class: "zb-cl-buttons" });
		buttons.append(cancel, apply);
		foot.append(summary, buttons);
		root.append(head, list, foot);
		root.addEventListener("keydown", (ev) => {
			if (ev.key === "Escape") {
				ev.preventDefault();
				finish(null);
			}
		});

		function picks() {
			return boxes.filter(b => b.box.checked).map(b => ({
				itemKey: b.item.key, itemID: b.item.id, libraryID: b.item.libraryID, dimension: b.s.dimension, value: b.s.value,
			}));
		}

		function setDimension(id, on) {
			for (let b of boxes) {
				if (b.s.dimension === id) b.box.checked = on;
			}
			update();
		}

		function update() {
			let current = picks();
			let counts = { creates: 0, added: 0, already: 0 };
			for (let lib of plan.libraries || [{ libraryID: undefined, snapshot: null }]) {
				let mine = current.filter(p => lib.libraryID === undefined || p.libraryID === lib.libraryID);
				if (!mine.length) continue;
				let r = planApply(lib.snapshot, mine);
				counts.creates += r.creates.length;
				counts.added += r.added;
				counts.already += r.already;
			}
			summary.textContent = describeCounts(counts, current.length);
			apply.disabled = !withSuggestions.length;
		}

		function finish(result) {
			if (decided) return;
			decided = true;
			apply.disabled = true;
			cancel.disabled = true;
			if (result) handlers.onApply(result);
			else handlers.onCancel();
		}

		update();
		let first = boxes.length ? boxes[0].box : cancel;
		try {
			first.focus();
		}
		catch (e) {}
		return { picks, update, setDimension, finish };
	}

	// ---------- Zotero ----------

	function pref(key) {
		return Zotero.Prefs.get(PREF + key, true);
	}

	function setPref(key, value) {
		Zotero.Prefs.set(PREF + key, value, true);
	}

	function featureOn(id) {
		let f = scope.ZB && scope.ZB.features;
		return !f || f.isEnabled(id);
	}

	function notify(text, headline = TITLE) {
		scope.ZB.main.notify(headline, text);
	}

	function readOptions() {
		let flag = (key) => pref(key) !== false;
		return {
			parentName: cleanName(pref("classify.parentName")) || DEFAULT_PARENT,
			parentPath: String(pref("classify.parentPath") || "").trim(),
			dimensions: { design: flag("classify.design"), topics: flag("classify.topics"), rules: flag("classify.rules"), pico: flag("classify.pico") },
			rules: parseRules(pref("classify.ruleList")),
			topics: parseTopics(pref("classify.topicList")),
			aliases: concepts.parseAliases(pref("concepts.aliases")),
		};
	}

	function yearOf(item) {
		let m = /\b(1[5-9]\d\d|20\d\d)\b/.exec(item.getField("date") || "");
		return m ? Number(m[1]) : (Number(item.getField("year")) || null);
	}

	function creatorName(c) {
		if (c.name) return c.name;
		return [c.lastName, c.firstName].filter(Boolean).join(hasCJK(c.lastName) ? "" : ", ");
	}

	/** The fields rules and heuristics read, plus the AI note's summary and structured data. */
	function recordFor(item) {
		let ZB = scope.ZB;
		let field = (f) => {
			try {
				return item.getField(f) || "";
			}
			catch (e) {
				return "";
			}
		};
		let ai = null;
		try {
			let note = ZB.adapter.getAINote(item);
			if (note) {
				let parsed = ZB.main.readAINote(note.getNote());
				ai = { summary: ZB.markdown.plainText(llm.extractSummary(parsed.md)), data: parsed.data || null };
			}
		}
		catch (e) {
			Zotero.logError(e);
		}
		return {
			id: item.id,
			key: item.key,
			libraryID: item.libraryID,
			title: field("title"),
			abstract: field("abstractNote"),
			tags: item.getTags().map(t => t.tag).filter(t => !/^zotero-bridge-/.test(t)),
			journal: [field("publicationTitle"), field("journalAbbreviation")].filter(Boolean),
			year: yearOf(item),
			language: field("language"),
			itemType: item.itemType,
			authors: (item.getCreatorsJSON() || []).map(creatorName).filter(Boolean),
			extra: field("extra"),
			ai,
		};
	}

	function libraryName(libraryID) {
		let lib = Zotero.Libraries.get(libraryID);
		return (lib && lib.name) || "我的文獻庫";
	}

	/** Top-level collections of a library, or the children of a collection (trashed ones left out). */
	function childCollections(libraryID, parentID) {
		let list = parentID ? Zotero.Collections.getByParent(parentID) : Zotero.Collections.getByLibrary(libraryID);
		return (list || []).filter(c => c && !c.deleted);
	}

	function findChild(libraryID, parentID, name) {
		return childCollections(libraryID, parentID).find(c => sameName(c.name, name)) || null;
	}

	/** The collection set in 「放在哪裡」 (classify.parentPath, "碩論/文獻回顧"), or the library root. */
	function resolveLocation(libraryID, options) {
		let parts = options.parentPath.split("/").map(cleanName).filter(Boolean);
		let label = [libraryName(libraryID)];
		if (!parts.length) return { collection: null, label, note: "" };
		let current = null;
		for (let part of parts) {
			let next = findChild(libraryID, current && current.id, part);
			if (!next) {
				return { collection: null, label, note: `找不到分類「${options.parentPath}」（${libraryName(libraryID)}），這次放在文獻庫最上層；要改位置：設定 → 文獻自動分類。` };
			}
			current = next;
			label.push(next.name);
		}
		return { collection: current, label, note: "" };
	}

	/**
	 * The 自動分類 sub-collections an item is in: collections two levels under a collection named like
	 * the parent (classify.parentName), as [{ folder, value, id }] (研究設計 / RCT). Read-only; for the
	 * item pane's ZotMax panel.
	 */
	function itemClassifications(item) {
		let parentName = readOptions().parentName;
		let out = [];
		for (let c of Zotero.Collections.get(item.getCollections()) || []) {
			if (!c || c.deleted || !c.parentID) continue;
			let folder = Zotero.Collections.get(c.parentID);
			let parent = folder && folder.parentID ? Zotero.Collections.get(folder.parentID) : null;
			if (!parent || folder.deleted || parent.deleted || !sameName(parent.name, parentName)) continue;
			out.push({ folder: folder.name, value: c.name, id: c.id });
		}
		let order = name => {
			let i = DIMENSIONS.findIndex(d => d.folder === name);
			return i < 0 ? DIMENSIONS.length : i;
		};
		return out.sort((a, b) => order(a.folder) - order(b.folder) || a.value.localeCompare(b.value));
	}

	function itemKeysOf(collection) {
		try {
			return Zotero.Items.get(collection.getChildItems(true)).filter(Boolean).map(i => i.key);
		}
		catch (e) {
			return [];
		}
	}

	/** What already exists under the location: the parent (自動分類), its folders and their sub-collections. */
	function readSnapshot(libraryID, location, parentName) {
		let parent = findChild(libraryID, location.collection && location.collection.id, parentName);
		let node = (c, depth) => ({
			name: c.name,
			key: c.key,
			items: depth === 2 ? itemKeysOf(c) : [],
			children: depth < 2 ? childCollections(libraryID, c.id).map(x => node(x, depth + 1)) : [],
		});
		return { parentName, parent: parent ? node(parent, 0) : null };
	}

	/** Names of the existing PICO sub-collections, so new values reuse them. */
	function existingPICO(snapshots) {
		let out = { population: [], intervention: [], outcome: [] };
		for (let snap of snapshots) {
			for (let dim of ["population", "intervention", "outcome"]) {
				let folder = childNamed(snap.parent, DIM.get(dim).folder);
				if (folder) out[dim].push(...folder.children.map(c => c.name));
			}
		}
		return out;
	}

	function llmSettingsLabel(settings) {
		return `${settings.llm.provider === "openai" ? "OpenAI" : "Claude"}（${settings.llm.model}）`;
	}

	/** Why 「AI 主題分類」 can't run right now, or "" when it can. */
	function topicBlocker() {
		let F = scope.ZB.features;
		if (F.isEnabled("classifyAI")) return "";
		let f = F.get("classifyAI");
		if (!F.rawValue("classifyAI")) return `主題：「${f.label}」目前關閉，這次沒有主題建議。要使用的話：設定 → ZotMax → 功能，把它打開。`;
		let req = f.requires.find(r => !F.isEnabled(r));
		return `主題：「${f.label}」要先打開「${F.get(req).label}」，這次沒有主題建議。`;
	}

	/**
	 * Ask the AI which topics each record belongs to. Returns Map<record key, [{ topic, confidence }]>,
	 * or null when the dimension is skipped (the reason is pushed to notes), or "cancel".
	 */
	async function classifyTopics(records, topics, notes, ui) {
		let ZB = scope.ZB;
		let blocked = topicBlocker();
		if (blocked) {
			notes.push(blocked);
			return null;
		}
		let settings;
		try {
			settings = await ZB.main.readSettings();
		}
		catch (e) {
			notes.push(`主題：設定有誤（${e.message || e}），這次略過。`);
			return null;
		}
		if (!settings.llm.apiKey) {
			notes.push("主題：還沒有設定 AI 的 API key（設定 → ZotMax → AI 服務），這次沒有主題建議。");
			return null;
		}
		let entries = [];
		let skipped = 0;
		records.forEach((r) => {
			if (!r.title && !r.abstract) {
				skipped++;
				return;
			}
			entries.push({ id: `S${entries.length + 1}`, key: r.key, title: r.title, abstract: r.abstract, summary: r.ai && r.ai.summary });
		});
		if (skipped) notes.push(`主題：${skipped} 篇沒有標題也沒有摘要，沒有送給 AI。`);
		if (!entries.length) return null;
		let { prices } = usage.parsePrices(pref("usage.prices"));
		let est = estimateTopicRun(topics, entries, settings.llm.model, prices);
		let estimate = est.cost === null
			? `這個模型沒有價格表，只能粗估 tokens：輸入約 ${usage.formatTokens(est.input + est.cacheRead + est.cacheWrite)}、輸出約 ${usage.formatTokens(est.output)}。`
			: `預估費用：約 ${usage.formatUSD(est.cost)}（依字數粗估，實際以帳單為準）。`;
		let text = `「AI 主題分類」會把 ${entries.length} 篇文獻的標題與摘要送到 ${llmSettingsLabel(settings)}，分 ${est.calls} 次判斷它們屬於你列的 ${topics.length} 個主題。\n\n`
			+ `${estimate}\n\nAI 的判斷只是建議：下一步你會逐篇勾選，按「套用」才會寫進 Zotero。`;
		let choice = ui.confirmAI(text);
		if (choice === "cancel") return "cancel";
		if (choice === "skip") {
			notes.push("主題：你選擇這次跳過 AI，沒有主題建議。");
			return null;
		}
		let results = new Map();
		let runTotals = { ledger: {} };
		let unknown = new Set();
		let failed = 0;
		let answered = 0;
		let llmSettings = Object.assign({}, settings.llm, { effort: "low" });
		let calls = Math.ceil(entries.length / TOPIC_BATCH);
		for (let i = 0; i < calls; i++) {
			let batch = entries.slice(i * TOPIC_BATCH, (i + 1) * TOPIC_BATCH);
			ui.status(`AI 判斷主題中（第 ${i + 1}／${calls} 批）…`);
			try {
				let { system, user } = buildTopicPrompt(topics, batch);
				let result = await llm.generateText(llmSettings, system, user, (u, init) => fetch(u, init),
					Object.assign({ onRetry: ZB.main.retryStatus(ui.status) }, ZB.main.runtime.retry));
				ZB.main.recordAIUsage(result, runTotals);
				let parsed = parseTopicResponse(result.text, topics, batch.map(e => e.id));
				if (parsed.error) {
					failed += batch.length;
					notes.push(`主題：第 ${i + 1} 批 ${parsed.error}，這 ${batch.length} 篇沒有主題建議。`);
					continue;
				}
				parsed.unknownTopics.forEach(t => unknown.add(t));
				for (let e of batch) {
					if (!parsed.results.has(e.id)) {
						failed++;
						continue;
					}
					answered++;
					results.set(e.key, parsed.results.get(e.id));
				}
			}
			catch (e) {
				Zotero.logError(e);
				failed += batch.length;
				notes.push(`主題：AI 呼叫失敗（${e.message || e}），${batch.length} 篇沒有主題建議；其他面向不受影響。`);
			}
		}
		if (answered) notes.push(`主題：AI 判斷了 ${answered} 篇${failed ? `，${failed} 篇沒有回覆` : ""}。`);
		if (unknown.size) notes.push(`主題：AI 提到不在清單裡的主題（${[...unknown].slice(0, 5).join("、")}），已忽略。`);
		let usageLine = ZB.main.runUsageLine(runTotals);
		if (usageLine) notes.push(usageLine);
		return results;
	}

	/** confirmEx: "run" | "skip" | "cancel". */
	function confirmAIDialog(text) {
		let p = Services.prompt;
		let flags = p.BUTTON_POS_0 * p.BUTTON_TITLE_IS_STRING + p.BUTTON_POS_1 * p.BUTTON_TITLE_IS_STRING
			+ p.BUTTON_POS_2 * p.BUTTON_TITLE_IS_STRING + p.BUTTON_POS_0_DEFAULT;
		let button = p.confirmEx(Zotero.getMainWindow(), TITLE, text, flags, "用 AI 判斷主題", "取消分類", "跳過主題，只看其他建議", null, {});
		return button === 0 ? "run" : button === 2 ? "skip" : "cancel";
	}

	/**
	 * Suggestions for the items: { items, notes, target, libraries: [{ libraryID, location, snapshot }] },
	 * or null when cancelled. opts: { ui: { confirmAI(text), status(text) } } (defaults: Zotero dialogs).
	 */
	async function suggest(items, opts = {}) {
		let ZB = scope.ZB;
		let options = readOptions();
		let ui = Object.assign({ confirmAI: confirmAIDialog, status: () => {} }, opts.ui);
		let records = ZB.adapter.toRegularItems(items).map(recordFor);
		let notes = [];
		let libraries = [];
		for (let libraryID of [...new Set(records.map(r => r.libraryID))]) {
			let location = resolveLocation(libraryID, options);
			if (location.note) notes.push(location.note);
			libraries.push({ libraryID, location, snapshot: readSnapshot(libraryID, location, options.parentName) });
		}
		let dims = options.dimensions;
		if (!Object.values(dims).some(Boolean)) {
			notes.push("四個面向都關著：到 設定 → ZotMax → 文獻自動分類 打開至少一個。");
		}
		if (dims.rules) {
			if (options.rules.errors.length) notes.push(`規則：${describeErrors(options.rules.errors).join("；")}。這幾行先略過（設定頁會標出原因）。`);
			if (!options.rules.rules.length && !options.rules.errors.length) notes.push("規則：還沒有寫規則（設定 → 文獻自動分類），這次略過。");
		}
		let topics = null;
		if (dims.topics) {
			let blocked = topicBlocker();
			if (blocked) {
				// Said first: the topic list itself is hidden in the settings while the switch is off
				notes.push(blocked);
			}
			else if (!options.topics.topics.length) {
				if (options.topics.errors.length) notes.push(`主題清單：${describeErrors(options.topics.errors).join("；")}。`);
				notes.push("主題：還沒有列主題（設定 → 文獻自動分類 → 主題清單），這次略過。");
			}
			else {
				if (options.topics.errors.length) notes.push(`主題清單：${describeErrors(options.topics.errors).join("；")}。這幾行先略過。`);
				topics = await classifyTopics(records, options.topics.topics, notes, ui);
				if (topics === "cancel") return null;
			}
		}
		if (dims.pico) {
			let missing = records.filter(r => !(r.ai && r.ai.data)).length;
			if (missing) notes.push(`PICO：${missing} 篇沒有 AI 筆記的結構化資料，沒有 PICO 建議（可以先產生 AI 筆記）。`);
		}
		let planItems = buildSuggestions(records, {
			dimensions: dims,
			rules: options.rules.rules,
			aliases: options.aliases,
			topics: topics instanceof Map ? topics : null,
			existing: existingPICO(libraries.map(l => l.snapshot)),
		});
		let target = libraries.map(l => [...l.location.label, (l.snapshot.parent && l.snapshot.parent.name) || options.parentName].join(" › ")).join("；");
		return { items: planItems, notes, target, libraries, parentName: options.parentName };
	}

	// ---------- review window ----------

	/** Wait for the dialog document (not the initial about:blank) to be ready. */
	function waitForDialog(win, timeoutMs = 15000) {
		return new Promise((resolve, reject) => {
			let start = Date.now();
			let check = () => {
				try {
					let doc = win.document;
					let rootEl = doc && doc.getElementById(DIALOG_ROOT);
					if (rootEl && doc.readyState === "complete") {
						resolve(rootEl);
						return;
					}
				}
				catch (e) {}
				if (win.closed || Date.now() - start > timeoutMs) {
					reject(new Error("分類建議視窗沒有開啟"));
					return;
				}
				setTimeout(check, 50);
			};
			check();
		});
	}

	/**
	 * Show the plan in the review window; resolves with the picks, or null when the user cancels or
	 * closes the window. opts.onOpen(win) is called once the window shows the plan (tests).
	 */
	async function review(plan, opts = {}) {
		let main = Zotero.getMainWindow();
		let win = main.openDialog(DIALOG_URL, "zotero-bridge-classify", "chrome,dialog=no,resizable,centerscreen");
		let rootEl = await waitForDialog(win);
		return new Promise((resolve) => {
			let done = false;
			let finish = (picks) => {
				if (done) return;
				done = true;
				resolve(picks);
				try {
					if (!win.closed) win.close();
				}
				catch (e) {}
			};
			win.addEventListener("unload", () => finish(null));
			renderReview(win.document, rootEl, plan, { onApply: picks => finish(picks), onCancel: () => finish(null) });
			if (opts.onOpen) opts.onOpen(win);
		});
	}

	// ---------- apply and undo ----------

	const LAST_RUN_PREF = "classify.lastRun";

	function readLastRun() {
		try {
			let run = JSON.parse(pref(LAST_RUN_PREF) || "null");
			return run && Array.isArray(run.libraries) ? run : null;
		}
		catch (e) {
			return null;
		}
	}

	/** Walk (and create where missing) location / names…; created collections are recorded. */
	async function ensurePath(libraryID, base, names, created, cache) {
		let parent = base;
		let keyPath = [];
		for (let name of names) {
			keyPath.push(nameKey(name));
			let cacheKey = keyPath.join("/");
			let c = cache.get(cacheKey);
			if (!c) {
				c = findChild(libraryID, parent && parent.id, name);
				if (!c) {
					c = new Zotero.Collection();
					c.libraryID = libraryID;
					c.name = cleanName(name);
					if (parent) c.parentID = parent.id;
					await c.saveTx();
					created.push(c.key);
				}
				cache.set(cacheKey, c);
			}
			parent = c;
		}
		return parent;
	}

	/**
	 * Add the picked items to their sub-collections. Never removes anything. Returns
	 * { created, added, already, errors } and keeps the run for 「復原上次分類」 when it changed something.
	 */
	async function apply(plan, picks) {
		let options = readOptions();
		let record = { at: new Date().toISOString(), libraries: [] };
		let totals = { created: 0, added: 0, already: 0, errors: [] };
		let byLibrary = new Map();
		for (let p of picks) {
			let list = byLibrary.get(p.libraryID) || [];
			list.push(p);
			byLibrary.set(p.libraryID, list);
		}
		for (let [libraryID, list] of byLibrary) {
			let lib = (plan.libraries || []).find(l => l.libraryID === libraryID);
			let location = lib ? lib.location : resolveLocation(libraryID, options);
			// Re-read: the user may have changed collections while the dialog was open
			let snapshot = readSnapshot(libraryID, location, plan.parentName || options.parentName);
			let planned = planApply(snapshot, list);
			totals.already += planned.already;
			let created = [];
			let addedByItem = new Map();
			let cache = new Map();
			for (let add of planned.adds) {
				let collection;
				try {
					collection = await ensurePath(libraryID, location.collection, add.path, created, cache);
				}
				catch (e) {
					Zotero.logError(e);
					totals.errors.push(`無法建立「${add.path.join(" › ")}」：${e.message || e}`);
					continue;
				}
				for (let itemKey of add.items) {
					let item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
					if (!item || item.deleted) continue;
					if (item.inCollection(collection.id)) {
						totals.already++;
						continue;
					}
					item.addToCollection(collection.id);
					let keys = addedByItem.get(itemKey) || [];
					keys.push(collection.key);
					addedByItem.set(itemKey, keys);
				}
			}
			// Folders and parents created for nothing (every pick was already there) are kept: they exist now
			for (let [itemKey, keys] of addedByItem) {
				let item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
				try {
					await item.saveTx();
					totals.added += keys.length;
				}
				catch (e) {
					Zotero.logError(e);
					addedByItem.delete(itemKey);
					totals.errors.push(`「${item.getField("title") || itemKey}」無法加入分類：${e.message || e}`);
				}
			}
			totals.created += created.length;
			if (created.length || addedByItem.size) {
				record.libraries.push({ libraryID, created, added: [...addedByItem].map(([item, collections]) => ({ item, collections })) });
			}
		}
		if (record.libraries.length) {
			try {
				setPref(LAST_RUN_PREF, JSON.stringify(record));
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
		return totals;
	}

	function describeRun(run) {
		let added = 0;
		let created = 0;
		for (let lib of run.libraries) {
			created += lib.created.length;
			for (let a of lib.added) added += a.collections.length;
		}
		return { added, created };
	}

	/**
	 * 「復原上次分類」: remove exactly the memberships the last run added, then delete the collections it
	 * created that are empty again. Returns { removed, deleted, kept: [names] } or null without a record.
	 */
	async function undoLast(opts = {}) {
		let run = readLastRun();
		if (!run) {
			if (!opts.silent) notify("沒有可以復原的分類紀錄（只能復原最後一次套用）。");
			return null;
		}
		let counts = describeRun(run);
		if (!opts.silent) {
			let when = new Date(run.at);
			let stamp = isNaN(when.getTime()) ? run.at : when.toLocaleString();
			let ok = Services.prompt.confirm(Zotero.getMainWindow(), TITLE,
				`要復原 ${stamp} 的自動分類嗎？\n\n會把那次加入的 ${counts.added} 筆分類收回，並刪除那次新建、現在又是空的子分類（最多 ${counts.created} 個）。文獻本身和你原本的分類都不會動。`);
			if (!ok) return null;
		}
		let result = { removed: 0, deleted: 0, kept: [] };
		for (let lib of run.libraries) {
			for (let { item: itemKey, collections } of lib.added) {
				let item = Zotero.Items.getByLibraryAndKey(lib.libraryID, itemKey);
				if (!item) continue;
				let changed = false;
				for (let key of collections) {
					let c = Zotero.Collections.getByLibraryAndKey(lib.libraryID, key);
					if (c && item.inCollection(c.id)) {
						item.removeFromCollection(c.id);
						changed = true;
						result.removed++;
					}
				}
				if (changed) {
					try {
						await item.saveTx();
					}
					catch (e) {
						Zotero.logError(e);
					}
				}
			}
			// Deepest first: a value collection, then its folder, then the parent
			for (let key of lib.created.slice().reverse()) {
				let c = Zotero.Collections.getByLibraryAndKey(lib.libraryID, key);
				if (!c || c.deleted) continue;
				let hasItems = (c.getChildItems(true, true) || []).length > 0;
				let hasChildren = (Zotero.Collections.getByParent(c.id, false, true) || []).length > 0;
				if (hasItems || hasChildren) {
					result.kept.push(c.name);
					continue;
				}
				try {
					await c.eraseTx();
					result.deleted++;
				}
				catch (e) {
					Zotero.logError(e);
					result.kept.push(c.name);
				}
			}
		}
		setPref(LAST_RUN_PREF, "");
		if (!opts.silent) {
			notify(`已復原：收回 ${result.removed} 筆分類，刪除 ${result.deleted} 個空的子分類。`
				+ (result.kept.length ? `\n${result.kept.length} 個子分類裡還有其他東西，保留下來：${result.kept.slice(0, 5).join("、")}` : ""));
		}
		return result;
	}

	// ---------- run ----------

	let busy = false;

	/**
	 * Classify items: suggest → review → apply. Returns { cancelled } or the apply totals, or null when
	 * the feature is off or there is nothing to do. opts: { ui, review(plan) } for tests.
	 */
	async function run(items, opts = {}) {
		let ZB = scope.ZB;
		if (!featureOn("autoClassify")) {
			ZB.main.notifyFeatureOff("autoClassify");
			return null;
		}
		items = ZB.adapter.toRegularItems(items || []);
		if (!items.length) {
			notify("請先選取文獻，或在分類上按右鍵。");
			return null;
		}
		if (busy) {
			notify("上一次的分類還在進行中，請等它完成。");
			return null;
		}
		busy = true;
		let pw = null;
		let line = null;
		try {
			let plan = await suggest(items, {
				ui: Object.assign({
					status: (text) => {
						if (!pw) {
							pw = new Zotero.ProgressWindow({ closeOnClick: true });
							pw.changeHeadline(TITLE);
							pw.show();
							line = new pw.ItemProgress("note", text);
						}
						line.setText(text);
					},
				}, opts.ui),
			});
			if (pw) {
				pw.close && pw.close();
				pw = null;
			}
			if (!plan) return { cancelled: true };
			let picks;
			try {
				picks = await (opts.review || review)(plan);
			}
			catch (e) {
				Zotero.logError(e);
				notify(`確認視窗沒有開啟（${e.message || e}），Zotero 沒有變動。可以重新啟動 Zotero 後再試一次。`);
				return null;
			}
			if (!picks) return { cancelled: true };
			if (!picks.length) {
				notify("沒有勾選任何建議，Zotero 沒有變動。");
				return { cancelled: false, created: 0, added: 0, already: 0, errors: [] };
			}
			let result = await apply(plan, picks);
			let lines = [result.added || result.created
				? `已加入 ${result.added} 筆分類，新建 ${result.created} 個子分類${result.already ? `（${result.already} 筆原本就在）` : ""}。`
				: `勾選的 ${result.already} 筆原本就在這些分類裡，沒有變動。`];
			if (result.added || result.created) lines.push("想反悔：ZotMax 按鈕或快速指令 → 復原上次分類。");
			if (result.errors.length) lines.push(...result.errors.slice(0, 3));
			notify(lines.join("\n"));
			return Object.assign({ cancelled: false }, result);
		}
		finally {
			busy = false;
			if (pw && pw.startCloseTimer) pw.startCloseTimer(3000);
		}
	}

	return {
		DIMENSIONS, DESIGN_NAMES, DEFAULT_PARENT, TOPIC_SYSTEM, DIALOG_URL, DIALOG_ROOT, SOURCE_LABELS, CONFIDENCE_LABELS,
		cleanName, nameKey, sameName, tokenize, parseCondition, parseRules, describeErrors, evaluate, parseTopics,
		buildTopicPrompt, parseTopicResponse, estimateTokens, estimateTopicRun, guessDesign, designSuggestions, picoValues,
		picoSuggestions, buildSuggestions, defaultPicks, planApply, describeCounts, renderReview,
		readOptions, recordFor, itemClassifications, suggest, review, apply, undoLast, readLastRun, run,
	};
});
