// 文獻自動分類 (content/classify.js): the rule language, the study-design guess, PICO merged with the concept
// aliases, the AI topic prompt and its answer, the plan (collections to create, idempotency), the review
// dialog's DOM, and apply + undo on a small in-memory Zotero.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const C = require("../content/classify.js");
const concepts = require("../content/concepts.js");
const llm = require("../content/llm.js");

function record(fields = {}) {
	return Object.assign({
		key: "K1", id: 1, libraryID: 1, title: "", abstract: "", tags: [], journal: [], year: null,
		language: "", itemType: "journalArticle", authors: [], extra: "", ai: null,
	}, fields);
}

function rule(text) {
	let r = C.parseRules(`x = ${text}`);
	assert.deepEqual(r.errors, [], text);
	return r.rules[0].tree;
}

function matches(text, rec) {
	return C.evaluate(rule(text), record(rec));
}

// ---------- rules ----------

test("rules: fields, case-insensitive contains, quotes, Chinese text", () => {
	let rec = { title: "Exercise and Falls in Older Adults", abstract: "A fall prevention programme.", tags: ["跌倒", "篩選/全文/納入"],
		journal: ["Geriatric Nursing"], year: 2021, language: "en", authors: ["Lee, Anna", "陳美玲"] };
	assert.equal(matches("title:falls", rec), true);
	assert.equal(matches("TITLE:FALLS", rec), true, "field names and values ignore case");
	assert.equal(matches("title:\"older adults\"", rec), true, "quoted phrase");
	assert.equal(matches("title:「older adults」", rec), true, "Chinese quotes");
	assert.equal(matches("abstract:\"fall prevention\"", rec), true);
	assert.equal(matches("\"fall prevention\"", rec), true, "a bare phrase searches title and abstract");
	assert.equal(matches("programme", rec), true);
	assert.equal(matches("tag:跌倒", rec), true);
	assert.equal(matches("標籤:跌倒", rec), true, "Chinese field names");
	assert.equal(matches("tag:跌", rec), false, "tags match whole");
	assert.equal(matches("tag:篩選/*", rec), true, "tag prefix with *");
	assert.equal(matches("journal:geriatric", rec), true);
	assert.equal(matches("author:陳美玲", rec), true);
	assert.equal(matches("author:lee", rec), true);
	assert.equal(matches("type:journalArticle", rec), true);
	assert.equal(matches("type:期刊文章", rec), true, "Chinese item type names");
	assert.equal(matches("type:thesis", rec), false);
	assert.equal(matches("title：falls", rec), true, "full-width colon");
	assert.equal(matches("ｔｉｔｌｅ:ＦＡＬＬＳ", rec), true, "full-width letters (NFKC)");
});

test("rules: precedence NOT > AND > OR, implicit AND, parentheses", () => {
	let rec = { title: "falls", abstract: "", tags: ["a"] };
	// a OR (b AND c)
	assert.equal(matches("title:falls OR title:nothing AND tag:none", rec), true);
	assert.equal(matches("(title:falls OR title:nothing) AND tag:none", rec), false);
	// NOT binds tighter than AND
	assert.equal(matches("NOT tag:a AND title:falls", rec), false);
	assert.equal(matches("NOT (tag:a AND title:nothing)", rec), true);
	assert.equal(matches("not not tag:a", rec), true, "operators ignore case, NOT nests");
	assert.equal(matches("title:falls tag:a", rec), true, "no operator = AND");
	assert.equal(matches("title:falls tag:b", rec), false);
	assert.equal(matches("（title:falls OR tag:b） AND tag:a", rec), true, "full-width parentheses");
	let tree = rule("a OR b c");
	assert.ok(tree.or && tree.or[1].and, "OR of (b AND c)");
});

test("rules: years compare as numbers; items without a year never match", () => {
	let rec = { year: 2021 };
	for (let [cond, want] of [["year>=2020", true], ["year>2021", false], ["year<=2021", true], ["year<2021", false],
		["year=2021", true], ["year:2021", true], ["year:2018-2022", true], ["year:2022-2025", false], ["年份>=2021", true],
		["year >= 2020", true]]) {
		assert.equal(matches(cond, rec), want, cond);
	}
	assert.equal(matches("year>=1900", { year: null }), false);
	assert.equal(matches("NOT year>=1900", { year: null }), true);
});

test("rules: language:zh counts Chinese titles without a language", () => {
	assert.equal(matches("language:zh", { language: "zh-TW" }), true);
	assert.equal(matches("language:zh", { language: "", title: "護理人員跌倒預防衛教之成效" }), true);
	assert.equal(matches("language:zh", { language: "", title: "Falls" }), false);
	assert.equal(matches("language:en", { language: "", title: "Falls" }), true);
	assert.equal(matches("language:中文", { language: "Chinese" }), true);
	assert.equal(matches("language:ja", { language: "ja" }), true);
});

test("rules: errors name the line and what to fix; good lines still parse", () => {
	let text = [
		"# 註解不算",
		"跌倒 = title:falls OR tag:跌倒",
		"",
		"壞括號 = (title:x OR tag:y",
		"多括號 = title:x)",
		"斷尾 = title:x AND",
		"開頭 = OR title:x",
		"年份 = year>=abc",
		"比較 = title>x",
		"沒有等號",
		" = title:x",
		"空條件 = ",
		"引號 = title:\"fall",
		"空值 = title:",
		"// 也是註解",
		"近五年 = year>=2021",
		"全形 ＝ tag:跌倒",
	].join("\n");
	let { rules, errors } = C.parseRules(text);
	assert.deepEqual(rules.map(r => [r.name, r.line]), [["跌倒", 2], ["近五年", 16], ["全形", 17]]);
	assert.deepEqual(errors.map(e => e.line), [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
	let lines = C.describeErrors(errors);
	assert.match(lines[0], /^第 4 行：少了右括號/);
	assert.match(lines[1], /^第 5 行：多了一個右括號/);
	assert.match(lines[2], /^第 6 行：條件寫到一半/);
	assert.match(lines[3], /^第 7 行：OR 前後都要有條件/);
	assert.match(lines[4], /^第 8 行：年份要是四位數字/);
	assert.match(lines[5], /^第 9 行：只有 year 可以用 > 比較大小/);
	assert.match(lines[6], /^第 10 行：要寫成「子分類名稱 = 條件」/);
	assert.match(lines[7], /^第 11 行：等號前面要有子分類名稱/);
	assert.match(lines[8], /^第 12 行：等號後面要有條件/);
	assert.match(lines[9], /^第 13 行：引號 " 沒有成對/);
	assert.match(lines[10], /^第 14 行：「title:」後面要接要找的字/);
	assert.deepEqual(C.parseRules(""), { rules: [], errors: [] });
	assert.equal(C.parseRules(`${"長".repeat(81)} = title:x`).errors[0].line, 1);
});

// ---------- topics ----------

test("topics: one per line with an optional description; duplicates are errors", () => {
	let { topics, errors } = C.parseTopics("跌倒預防: 跌倒、fall prevention、hip protector\n\n壓力性損傷：pressure injury\n照顧者負荷\n# 註解\n跌倒預防: again\n: 沒名稱");
	assert.deepEqual(topics.map(t => [t.name, t.description]), [
		["跌倒預防", "跌倒、fall prevention、hip protector"], ["壓力性損傷", "pressure injury"], ["照顧者負荷", ""],
	]);
	assert.deepEqual(errors.map(e => e.line), [6, 7]);
	assert.match(errors[0].message, /第 1 行已經列過/);
});

test("topic prompt: instructions and topic list as cached system blocks, items labelled S1…", () => {
	let topics = C.parseTopics("跌倒預防: 跌倒、fall prevention\n照顧者負荷").topics;
	let entries = [
		{ id: "S1", title: "Exercise and falls", abstract: "x".repeat(3000), summary: "運動降低跌倒。" },
		{ id: "S2", title: "Caregiver burden", abstract: "" },
	];
	let { system, user } = C.buildTopicPrompt(topics, entries);
	assert.equal(system.length, 2);
	assert.equal(system[0], C.TOPIC_SYSTEM);
	assert.match(system[1], /- 跌倒預防：跌倒、fall prevention\n- 照顧者負荷$/);
	assert.match(user, /請判斷以下 2 篇文獻/);
	assert.match(user, /\[S1\]\n標題：Exercise and falls\n摘要：x+…\n筆記摘要：運動降低跌倒。/);
	assert.match(user, /\[S2\]\n標題：Caregiver burden\n摘要：（無）/);
	assert.ok(user.length < 2600, "the abstract is cut");
	// llm.js puts the cache breakpoint on the last system block: instructions + topics are reused by every batch
	let body = llm.anthropicBody({ model: "test-model", system, user });
	assert.deepEqual(body.system.map(b => !!b.cache_control), [false, true]);
	assert.equal(body.messages[0].content, user);
});

test("topic answer: JSON in or out of a fence, trailing commas, unknown topics and IDs ignored, malformed reported", () => {
	let topics = C.parseTopics("跌倒預防\n照顧者負荷").topics;
	let ids = ["S1", "S2", "S3"];
	let answer = "結果如下：\n```json\n{\"results\":[{\"id\":\"S1\",\"topics\":[{\"topic\":\"跌倒預防\",\"confidence\":\"high\"},{\"topic\":\"睡眠\",\"confidence\":\"high\"}]},"
		+ "{\"id\":\"S2\",\"topics\":[\"照顧者負荷\", {\"name\":\"跌倒預防\",\"confidence\":\"低\"}],},{\"id\":\"S9\",\"topics\":[\"跌倒預防\"]},{\"id\":\"[S3]\",\"topics\":[]}]}\n```";
	let r = C.parseTopicResponse(answer, topics, ids);
	assert.equal(r.error, "");
	assert.deepEqual(r.results.get("S1"), [{ topic: "跌倒預防", confidence: "high" }]);
	assert.deepEqual(r.results.get("S2"), [{ topic: "照顧者負荷", confidence: "medium" }, { topic: "跌倒預防", confidence: "low" }]);
	assert.deepEqual(r.results.get("S3"), []);
	assert.equal(r.results.has("S9"), false, "unknown IDs are ignored");
	assert.deepEqual(r.unknownTopics, ["睡眠"]);
	// A bare array and case/width differences in topic names
	r = C.parseTopicResponse("[{\"id\":\"S1\",\"topics\":[\"跌倒預防 \"]}]", topics, ids);
	assert.deepEqual(r.results.get("S1"), [{ topic: "跌倒預防", confidence: "medium" }]);
	for (let bad of ["抱歉，我無法判斷。", "{\"results\": [", "{\"answer\": 1}", ""]) {
		let x = C.parseTopicResponse(bad, topics, ids);
		assert.ok(x.error, bad);
		assert.equal(x.results.size, 0);
	}
});

test("topic estimate: calls per batch of 10, priced from the price table, null when unpriced", () => {
	let topics = C.parseTopics("跌倒預防\n照顧者負荷").topics;
	let entries = Array.from({ length: 23 }, (_, i) => ({ id: `S${i + 1}`, title: `Paper ${i}`, abstract: "Falls ".repeat(200) }));
	let est = C.estimateTopicRun(topics, entries, "test-model", { "test-model": { input: 1, output: 5 } });
	assert.equal(est.calls, 3);
	assert.equal(est.items, 23);
	assert.ok(est.input > 23 * 250 && est.output > 0);
	assert.ok(est.cost > 0 && est.cost < 0.1, String(est.cost));
	assert.equal(C.estimateTopicRun(topics, entries, "unpriced-model", {}).cost, null);
	assert.equal(C.estimateTokens("跌倒預防"), 4, "about one token per CJK character");
	assert.equal(C.estimateTokens("abcdefgh"), 2);
});

// ---------- study design, evidence levels, PICO ----------

test("design guess: publication-type tags and the title are strong, the abstract weaker, reviews win", () => {
	let g = C.guessDesign(record({ tags: ["Randomized Controlled Trial", "Humans"] }));
	assert.deepEqual([g.value, g.source, g.confidence, g.checked], ["RCT", "heuristic", "high", true]);
	assert.match(g.reason, /標籤或 Extra 有「Randomized」/);
	assert.equal(C.guessDesign(record({ tags: ["Randomized Controlled Trials as Topic"] })), null, "MeSH \"as Topic\" is the subject, not the design");
	assert.equal(C.guessDesign(record({ extra: "Publication Type: Meta-Analysis" })).value, "Systematic review & meta-analysis");
	g = C.guessDesign(record({ title: "Hip protectors: a cohort study" }));
	assert.deepEqual([g.value, g.confidence, g.reason], ["Cohort", "high", "標題有「cohort」"]);
	assert.equal(C.guessDesign(record({ title: "A systematic review and meta-analysis of randomized trials" })).value, "Systematic review & meta-analysis");
	assert.equal(C.guessDesign(record({ title: "A scoping review of fall prevention" })).value, "Scoping review");
	assert.equal(C.guessDesign(record({ title: "A non-randomized controlled trial" })).value, "Quasi-experimental");
	assert.equal(C.guessDesign(record({ title: "護理人員跌倒預防衛教之成效：類實驗研究" })).value, "Quasi-experimental");
	assert.equal(C.guessDesign(record({ title: "照顧者的經驗：質性研究" })).value, "Qualitative");
	assert.equal(C.guessDesign(record({ title: "Adherence to guidelines: a cross-sectional study" })).value, "Cross-sectional", "a design beats a guideline mention");
	// A weak hint: medium in the title, low in the abstract
	assert.deepEqual(["value", "confidence"].map(k => C.guessDesign(record({ title: "A national survey of nurses" }))[k]), ["Cross-sectional", "medium"]);
	g = C.guessDesign(record({ abstract: "We conducted a qualitative study with interviews." }));
	assert.deepEqual([g.value, g.confidence, g.checked], ["Qualitative", "medium", true]);
	g = C.guessDesign(record({ abstract: "Unlike earlier randomized trials, this cohort was followed for 2 years." }));
	assert.deepEqual([g.value, g.confidence, g.checked], ["RCT", "low", false], "two designs in the abstract: low, unchecked");
	assert.match(g.reason, /也提到 Cohort/);
	assert.equal(C.guessDesign(record({ title: "Nursing research methods", itemType: "book" })), null);
});

test("design and levels: the AI note's structured data first; evidence levels only from it", () => {
	let ai = { summary: "", data: { study_design: "RCT", evidence_level: "2", jbi_level: "1.c" } };
	let list = C.designSuggestions(record({ title: "A cohort study", ai }));
	assert.deepEqual(list.map(s => [s.dimension, s.value, s.source, s.confidence]), [
		["design", "RCT", "ai", "high"], ["level", "CEBM Level 2", "ai", "medium"], ["level", "JBI Level 1.c", "ai", "medium"],
	]);
	list = C.designSuggestions(record({ title: "A cohort study", ai: { data: { study_design: "", evidence_level: "" } } }));
	assert.deepEqual(list.map(s => [s.value, s.source]), [["Cohort", "heuristic"]], "no levels are guessed");
	assert.deepEqual(C.designSuggestions(record({ ai: { data: { study_design: "meta-analysis" } } })).map(s => s.value), ["Systematic review & meta-analysis"]);
	assert.deepEqual(C.designSuggestions(record({ ai: { data: { study_design: "other" } } })).map(s => s.value), ["其他設計"]);
});

test("PICO: values from the AI note, merged by the concept aliases and by spelling; one-paper values unchecked", () => {
	let aliases = concepts.parseAliases("跌倒 = Accidental Falls = falls = 跌倒發生率\n住院病人 = inpatients");
	let rec = (key, data) => record({ key, ai: { summary: "", data } });
	let records = [
		rec("A", { population: "Inpatients", intervention: "運動訓練；衛教", outcomes: "falls、跌倒自我效能", measures: ["Morse Fall Scale"] }),
		rec("B", { population: "65 歲以上住院病人", intervention: "運動訓練", outcomes: "Accidental Falls", measures: [] }),
		rec("C", { population: "未報告", intervention: "", outcomes: "", measures: ["Morse Fall Scale", "FES-I"] }),
		rec("D", null),
	];
	records[3].ai = null;
	let out = C.picoSuggestions(records, aliases, { intervention: ["運動訓練"] });
	let pick = (key) => out.get(key).map(s => [s.dimension, s.value, s.confidence]);
	assert.deepEqual(pick("A"), [
		["population", "住院病人", "medium"],
		["intervention", "運動訓練", "medium"],
		["intervention", "衛教", "low"],
		["outcome", "跌倒", "medium"],
		["outcome", "跌倒自我效能", "low"],
	]);
	assert.deepEqual(pick("B"), [
		["population", "65 歲以上住院病人", "low"],
		["intervention", "運動訓練", "medium"],
		["outcome", "跌倒", "medium"],
	]);
	// No outcomes: the measures stand in
	assert.deepEqual(pick("C"), [["outcome", "Morse Fall Scale", "low"], ["outcome", "FES-I", "low"]]);
	assert.equal(out.has("D"), false, "no AI note, no PICO");
	let a = out.get("A");
	assert.match(a[0].reason, /AI 筆記的 population「Inpatients」；依同義詞設定合併為「住院病人」/);
	assert.match(a[1].reason, /已有這個子分類/);
	assert.match(a[2].reason, /只有這篇用這個說法，先不勾/);
	assert.equal(a[2].checked, false);
	// Spelling alone (case, full-width) merges too; the first spelling names the sub-collection
	let spelled = C.picoSuggestions([rec("E", { population: "Older Adults" }), rec("F", { population: "older adults" }), rec("G", { population: "ＯＬＤＥＲ ＡＤＵＬＴＳ" })], null);
	assert.deepEqual([...spelled.values()].map(l => [l[0].value, l[0].confidence]), [["Older Adults", "medium"], ["Older Adults", "medium"], ["Older Adults", "medium"]]);
});

test("buildSuggestions: dimension switches, rules, topics, notes for items without an AI note", () => {
	let rules = C.parseRules("跌倒 = title:falls\n近年 = year>=2020").rules;
	let records = [
		record({ key: "A", id: 1, title: "Exercise and falls: a randomized controlled trial", year: 2021, journal: ["Geriatric Nursing"],
			ai: { summary: "", data: { study_design: "RCT", evidence_level: "2", population: "older adults", intervention: "exercise", outcomes: "falls" } } }),
		record({ key: "B", id: 2, title: "Hip protectors: a cohort study", year: 2018 }),
	];
	let topics = new Map([["A", [{ topic: "跌倒預防", confidence: "high" }, { topic: "運動", confidence: "low" }]]]);
	let items = C.buildSuggestions(records, { rules, topics });
	let a = items[0];
	assert.deepEqual(a.suggestions.map(s => [s.dimension, s.value, s.checked]), [
		["design", "RCT", true], ["level", "CEBM Level 2", true], ["topic", "跌倒預防", true], ["topic", "運動", false],
		["rule", "跌倒", true], ["rule", "近年", true],
		["population", "older adults", false], ["intervention", "exercise", false], ["outcome", "falls", false],
	]);
	assert.equal(a.journal, "Geriatric Nursing");
	assert.deepEqual(a.notes, []);
	let b = items[1];
	assert.deepEqual(b.suggestions.map(s => [s.dimension, s.value, s.source]), [["design", "Cohort", "heuristic"]]);
	assert.deepEqual(b.notes, ["沒有 AI 筆記的結構化資料：沒有 PICO 與證據等級建議"]);
	// Switched-off dimensions
	items = C.buildSuggestions(records, { rules, topics, dimensions: { design: false, pico: false, topics: false } });
	assert.deepEqual(items[0].suggestions.map(s => s.dimension), ["rule", "rule"]);
	assert.deepEqual(items[1].notes, []);
	// Defaults are what the dialog pre-checks
	let picks = C.defaultPicks({ items: C.buildSuggestions(records, { rules }) });
	assert.deepEqual(picks.map(p => [p.itemKey, p.dimension, p.value]), [
		["A", "design", "RCT"], ["A", "level", "CEBM Level 2"], ["A", "rule", "跌倒"], ["A", "rule", "近年"], ["B", "design", "Cohort"],
	]);
});

// ---------- plan ----------

test("planApply: what to create, reuse of existing names (case, width), idempotent once applied", () => {
	let picks = [
		{ itemKey: "A", dimension: "design", value: "RCT" },
		{ itemKey: "B", dimension: "design", value: "rct" },
		{ itemKey: "A", dimension: "rule", value: "跌倒" },
		{ itemKey: "A", dimension: "rule", value: "跌倒" },
		{ itemKey: "B", dimension: "population", value: "住院病人" },
	];
	let empty = C.planApply({ parentName: "自動分類", parent: null }, picks);
	assert.deepEqual(empty.creates, [
		["自動分類"], ["自動分類", "研究設計"], ["自動分類", "研究設計", "RCT"],
		["自動分類", "規則"], ["自動分類", "規則", "跌倒"], ["自動分類", "族群 P"], ["自動分類", "族群 P", "住院病人"],
	]);
	assert.deepEqual(empty.adds, [
		{ path: ["自動分類", "研究設計", "RCT"], items: ["A", "B"] },
		{ path: ["自動分類", "規則", "跌倒"], items: ["A"] },
		{ path: ["自動分類", "族群 P", "住院病人"], items: ["B"] },
	]);
	assert.equal(empty.added, 4);
	// After applying: the tree holds them, nothing to create or add
	let applied = {
		parentName: "自動分類",
		parent: {
			name: "自動分類", key: "P", items: [], children: [
				{ name: "研究設計", key: "D", items: [], children: [{ name: "RCT", key: "R", items: ["A", "B"], children: [] }] },
				{ name: "規則", key: "U", items: [], children: [{ name: "跌倒", key: "F", items: ["A"], children: [] }] },
				{ name: "族群 P", key: "Q", items: [], children: [{ name: "住院病人", key: "H", items: ["B"], children: [] }] },
			],
		},
	};
	let again = C.planApply(applied, picks);
	assert.deepEqual(again.creates, []);
	assert.deepEqual(again.adds, []);
	assert.equal(again.already, 5);
	// Existing collections named differently in case/width are reused with their own names
	let user = { parentName: "自動分類", parent: { name: "自動分類", key: "P", items: [], children: [
		{ name: "研究設計", key: "D", items: [], children: [{ name: "ＲＣＴ", key: "R", items: ["C"], children: [] }] },
	] } };
	let plan = C.planApply(user, [{ itemKey: "A", dimension: "design", value: "rct" }, { itemKey: "A", dimension: "level", value: "CEBM Level 2" }]);
	assert.deepEqual(plan.creates, [["自動分類", "證據等級"], ["自動分類", "證據等級", "CEBM Level 2"]]);
	assert.deepEqual(plan.adds[0], { path: ["自動分類", "研究設計", "ＲＣＴ"], items: ["A"] });
	assert.equal(C.describeCounts({ creates: 2, added: 2, already: 1 }, 3), "已勾選 3 項：會建立 2 個子分類，加入 2 筆（1 筆原本就在）。");
	assert.match(C.describeCounts({ creates: 0, added: 0, already: 0 }, 0), /還沒有勾選/);
});

// ---------- review dialog ----------

function dialogDOM() {
	let xhtml = fs.readFileSync(path.join(__dirname, "..", "content", "classify-review.xhtml"), "utf8");
	let dom = new JSDOM(xhtml, { contentType: "application/xml" });
	return dom;
}

function samplePlan() {
	let rules = C.parseRules("跌倒 = title:falls").rules;
	let records = [
		record({ key: "A", id: 1, title: "Exercise and falls: a randomized controlled trial", year: 2021 }),
		record({ key: "B", id: 2, title: "Falls and a survey", abstract: "" }),
		record({ key: "C", id: 3, title: "Nursing research methods", itemType: "book" }),
	];
	return {
		items: C.buildSuggestions(records, { rules, dimensions: { pico: false } }),
		notes: ["主題：「AI 主題分類」目前關閉，這次沒有主題建議。"],
		target: "我的文獻庫 › 自動分類",
		libraries: [{ libraryID: 1, snapshot: { parentName: "自動分類", parent: null } }],
	};
}

test("review dialog: grouped by item and dimension, source and confidence shown, live counts, select all/none", () => {
	let dom = dialogDOM();
	let doc = dom.window.document;
	let root = doc.getElementById(C.DIALOG_ROOT);
	assert.ok(root, "the real classify-review.xhtml has the root element");
	let applied = null;
	let cancelled = 0;
	let ui = C.renderReview(doc, root, samplePlan(), { onApply: (p) => { applied = p; }, onCancel: () => { cancelled++; } });
	let $$ = sel => [...root.querySelectorAll(sel)];
	assert.equal(root.querySelector("h1").textContent, "文獻自動分類：先看建議，再決定");
	assert.match(root.querySelector(".zb-cl-lead").textContent, /判斷在你/);
	assert.match(root.querySelector(".zb-cl-lead").textContent, /不會把文獻移出任何分類/);
	assert.equal(root.querySelector(".zb-cl-target").textContent, "放在：我的文獻庫 › 自動分類");
	assert.deepEqual($$(".zb-cl-notes li").map(li => li.textContent), ["主題：「AI 主題分類」目前關閉，這次沒有主題建議。"]);
	assert.deepEqual($$(".zb-cl-item-title").map(h => h.textContent), ["Exercise and falls: a randomized controlled trial", "Falls and a survey"]);
	assert.match(root.querySelector(".zb-cl-without summary").textContent, /1 篇沒有任何建議/);
	assert.deepEqual($$(".zb-cl-dim-name").map(e => e.textContent), ["研究設計", "規則"]);
	let first = root.querySelector(".zb-cl-item");
	assert.deepEqual([...first.querySelectorAll(".zb-cl-group-name")].map(e => e.textContent), ["研究設計", "規則"]);
	assert.deepEqual([...first.querySelectorAll(".zb-cl-why")].map(e => e.textContent), ["規則推測・高｜標題有「randomized」", "你的規則・高｜符合第 1 行：title:falls"]);
	// Every checkbox has a label and its explanation
	for (let box of $$("input[type=checkbox]")) {
		assert.ok(root.querySelector(`label[for="${box.id}"]`), box.id);
		assert.ok(doc.getElementById(box.getAttribute("aria-describedby")), box.id);
	}
	let boxes = $$("input[type=checkbox]");
	assert.deepEqual(boxes.map(b => b.checked), [true, true, true, true], "high confidence and rule matches are pre-checked");
	let summary = () => root.querySelector(".zb-cl-summary").textContent;
	assert.equal(summary(), "已勾選 4 項：會建立 6 個子分類，加入 4 筆。");
	assert.equal(root.querySelector(".zb-cl-summary").getAttribute("role"), "status");
	// 全不選 for 研究設計
	root.querySelector('.zb-cl-none-btn[data-dimension="design"]').click();
	assert.deepEqual(boxes.map(b => b.checked), [false, true, false, true]);
	assert.equal(summary(), "已勾選 2 項：會建立 3 個子分類，加入 2 筆。");
	root.querySelector('.zb-cl-all[data-dimension="design"]').click();
	boxes[3].click();
	assert.equal(summary(), "已勾選 3 項：會建立 6 個子分類，加入 3 筆。");
	root.querySelector(".zb-cl-apply").click();
	assert.deepEqual(applied.map(p => [p.itemKey, p.itemID, p.libraryID, p.dimension, p.value]), [
		["A", 1, 1, "design", "RCT"], ["A", 1, 1, "rule", "跌倒"], ["B", 2, 1, "design", "Cross-sectional"],
	]);
	// Decided once: buttons disabled, a second click does nothing
	assert.equal(root.querySelector(".zb-cl-apply").disabled, true);
	root.querySelector(".zb-cl-cancel").click();
	assert.equal(cancelled, 0);
	assert.equal(typeof ui.picks, "function");
});

test("review dialog: cancel and Escape write nothing; an empty plan only offers 關閉", () => {
	let doc = dialogDOM().window.document;
	let root = doc.getElementById(C.DIALOG_ROOT);
	let calls = [];
	C.renderReview(doc, root, samplePlan(), { onApply: p => calls.push(["apply", p]), onCancel: () => calls.push(["cancel"]) });
	root.querySelector(".zb-cl-cancel").click();
	assert.deepEqual(calls, [["cancel"]]);

	calls = [];
	C.renderReview(doc, root, samplePlan(), { onApply: p => calls.push(["apply", p]), onCancel: () => calls.push(["cancel"]) });
	root.dispatchEvent(new doc.defaultView.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	assert.deepEqual(calls, [["cancel"]]);

	calls = [];
	let empty = { items: C.buildSuggestions([record({ title: "Nursing research methods" })], { dimensions: { pico: false } }), notes: [], libraries: [] };
	C.renderReview(doc, root, empty, { onApply: p => calls.push(["apply", p]), onCancel: () => calls.push(["cancel"]) });
	assert.match(root.querySelector(".zb-cl-empty").textContent, /這次沒有任何分類建議/);
	assert.equal(root.querySelector(".zb-cl-apply").disabled, true);
	assert.equal(root.querySelector(".zb-cl-cancel").textContent, "關閉");
	assert.equal(root.querySelectorAll(".zb-cl-dim").length, 0);
});

// ---------- apply and undo on a small in-memory Zotero ----------

function fakeZotero() {
	let collections = new Map();
	let items = new Map();
	let prefs = {};
	let nextID = 1;
	let log = [];
	class Collection {
		constructor() {
			this.id = null;
			this.key = null;
			this.parentID = null;
			this.deleted = false;
		}
		async saveTx() {
			if (!this.id) {
				this.id = nextID++;
				this.key = `C${this.id}`;
				collections.set(this.id, this);
				log.push(["create", this.name]);
			}
		}
		getChildItems(asIDs) {
			let list = [...items.values()].filter(i => i.collections.has(this.id));
			return asIDs ? list.map(i => i.id) : list;
		}
		async eraseTx() {
			collections.delete(this.id);
			log.push(["erase", this.name]);
		}
	}
	let Z = {
		Collection,
		Prefs: { get: k => prefs[k], set: (k, v) => { prefs[k] = v; } },
		Libraries: { get: () => ({ name: "我的文獻庫" }) },
		Collections: {
			getByLibrary: () => [...collections.values()].filter(c => !c.parentID),
			getByParent: id => [...collections.values()].filter(c => c.parentID === id),
			getByLibraryAndKey: (lib, key) => [...collections.values()].find(c => c.key === key) || false,
		},
		Items: {
			get: ids => (Array.isArray(ids) ? ids.map(id => items.get(id)) : items.get(ids)),
			getByLibraryAndKey: (lib, key) => [...items.values()].find(i => i.key === key) || false,
		},
		logError: (e) => { throw e; },
	};
	function addItem(key, title) {
		let item = {
			id: 1000 + items.size, key, libraryID: 1, deleted: false, collections: new Set(),
			getField: () => title,
			inCollection(id) { return this.collections.has(id); },
			addToCollection(id) { this.collections.add(id); },
			removeFromCollection(id) { this.collections.delete(id); },
			async saveTx() { log.push(["save", key]); },
		};
		items.set(item.id, item);
		return item;
	}
	function addCollection(name, parentID = null) {
		let c = new Collection();
		c.name = name;
		c.parentID = parentID;
		c.id = nextID++;
		c.key = `U${c.id}`;
		collections.set(c.id, c);
		return c;
	}
	return { Z, prefs, collections, items, log, addItem, addCollection };
}

function pathsOf(env) {
	let out = [];
	let walk = (parentID, prefix) => {
		for (let c of [...env.collections.values()].filter(x => x.parentID === parentID)) {
			let p = [...prefix, c.name];
			out.push(p.join("/") + (c.getChildItems(true).length ? ` [${c.getChildItems(false).map(i => i.key).sort().join(",")}]` : ""));
			walk(c.id, p);
		}
	};
	walk(null, []);
	return out.sort();
}

test("apply adds memberships only, reuses existing collections, is idempotent; undo takes back exactly that run", async () => {
	let env = fakeZotero();
	globalThis.Zotero = env.Z;
	globalThis.ZB = { main: { notify: () => {} } };
	try {
		let a = env.addItem("A", "Paper A");
		let b = env.addItem("B", "Paper B");
		// The user's own collections: one is reused by name, none is ever changed
		let review = env.addCollection("My review");
		a.addToCollection(review.id);
		let parent = env.addCollection("自動分類");
		let rules = env.addCollection("規則", parent.id);
		let mine = env.addCollection("跌倒", rules.id);
		b.addToCollection(mine.id);
		let plan = { parentName: "自動分類", libraries: [{ libraryID: 1, location: { collection: null, label: ["我的文獻庫"] } }] };
		let picks = [
			{ itemKey: "A", libraryID: 1, dimension: "rule", value: "跌倒" },
			{ itemKey: "B", libraryID: 1, dimension: "rule", value: "跌倒" },
			{ itemKey: "A", libraryID: 1, dimension: "design", value: "RCT" },
		];
		let result = await C.apply(plan, picks);
		assert.deepEqual([result.created, result.added, result.already, result.errors], [2, 2, 1, []]);
		assert.deepEqual(pathsOf(env), ["My review [A]", "自動分類", "自動分類/研究設計", "自動分類/研究設計/RCT [A]", "自動分類/規則", "自動分類/規則/跌倒 [A,B]"]);
		let last = JSON.parse(env.prefs["extensions.zotero-bridge.classify.lastRun"]);
		assert.equal(last.libraries.length, 1);
		assert.equal(last.libraries[0].created.length, 2, "only what this run created");
		assert.deepEqual(last.libraries[0].added.map(x => [x.item, x.collections.length]).sort(), [["A", 2]]);

		// Again: nothing changes, and the record of the run that did something is kept
		let again = await C.apply(plan, picks);
		assert.deepEqual([again.created, again.added, again.already], [0, 0, 3]);
		assert.equal(env.prefs["extensions.zotero-bridge.classify.lastRun"], JSON.stringify(last));

		// The user puts their own item into a collection this run created: it is kept on undo
		let c = env.addItem("C", "Paper C");
		let rct = [...env.collections.values()].find(x => x.name === "RCT");
		c.addToCollection(rct.id);
		let undo = await C.undoLast({ silent: true });
		assert.deepEqual(undo, { removed: 2, deleted: 0, kept: ["RCT", "研究設計"] });
		assert.deepEqual(pathsOf(env), ["My review [A]", "自動分類", "自動分類/研究設計", "自動分類/研究設計/RCT [C]", "自動分類/規則", "自動分類/規則/跌倒 [B]"]);
		assert.equal(env.prefs["extensions.zotero-bridge.classify.lastRun"], "");
		assert.equal(await C.undoLast({ silent: true }), null, "nothing left to undo");

		// A run whose collections stay empty after undo: they are deleted, deepest first
		c.removeFromCollection(rct.id);
		await C.apply(plan, [{ itemKey: "A", libraryID: 1, dimension: "level", value: "CEBM Level 2" }]);
		assert.ok(pathsOf(env).includes("自動分類/證據等級/CEBM Level 2 [A]"));
		env.log.length = 0;
		undo = await C.undoLast({ silent: true });
		assert.deepEqual(undo, { removed: 1, deleted: 2, kept: [] });
		assert.deepEqual(env.log.filter(e => e[0] === "erase").map(e => e[1]), ["CEBM Level 2", "證據等級"]);
		assert.ok(!pathsOf(env).some(p => p.includes("證據等級")));
		assert.ok(pathsOf(env).includes("My review [A]"), "the user's collection is untouched");
	}
	finally {
		delete globalThis.Zotero;
		delete globalThis.ZB;
	}
});
