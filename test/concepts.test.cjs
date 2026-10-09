// Concept hub notes (概念卡片): extraction from literature notes, normalization and aliases,
// co-occurrence, the cards and the index (Mermaid), and the AI synthesis block (pure helpers)
const test = require("node:test");
const assert = require("node:assert/strict");
const c = require("../content/concepts.js");
const core = require("../content/core.js");
const searchLinks = require("../content/search-links.js");
const reviewDraft = require("../content/review-draft.js");

const NOW = "2026-10-08T12:00:00.000Z";
const LATER = "2026-10-09T08:00:00.000Z";

// A literature note as main.js writes it (core.buildObsidianNote), with an AI note
function literatureNote(key, opts = {}) {
	let title = opts.title || `Paper ${key}`;
	let ai = [
		"## 一句話摘要", "", opts.summary || `${title} 的一句話摘要。`, "",
		"## 主要結果", "", "介入組跌倒率降低 30%（[[Not a concept]]）。", "",
		`## ${opts.heading || "關鍵概念"}`, "",
		...(opts.concepts || []).map(x => `- [[${x}]]：說明`), "",
		"## 可引用的句子", "", "- \"Falls fell.\" (p. 3) — [[Quoted link]]",
	].join("\n");
	let text = core.buildObsidianNote(null, {
		title, year: opts.year || "2024", key, libraryPath: "library",
		creators: [{ lastName: "Chen", firstName: "Mei", creatorType: "author" }],
	}, { aiMarkdown: ai, study: opts.study || null, aiModel: "test-model", aiGeneratedAt: NOW, now: NOW });
	// The user's own links below the managed region are not concepts
	return text + (opts.user || "");
}

function record(key, opts = {}, recOpts = {}) {
	return c.paperRecord(literatureNote(key, opts), `Zotero/${key}.md`, recOpts);
}

test("names: NFKC (full-width → half-width), case, spaces and hyphens", () => {
	assert.equal(c.cleanName("  Ｓｅｌｆ－ｅｆｆｉｃａｃｙ \n"), "Self-efficacy");
	assert.equal(c.conceptKey("Ｓｅｌｆ－ｅｆｆｉｃａｃｙ"), "self efficacy");
	assert.equal(c.conceptKey("self  efficacy"), "self efficacy");
	assert.equal(c.conceptKey("Self_Efficacy"), "self efficacy");
	assert.equal(c.conceptKey("Self‐efficacy"), "self efficacy", "U+2010 hyphen");
	assert.equal(c.conceptKey("跌倒（Falls）"), "跌倒(falls)");
	assert.equal(c.conceptKey("  "), "");
});

test("parseAliases: groups, the first name is the card, full-width = and comments, conflicts reported", () => {
	let a = c.parseAliases("跌倒 = Accidental Falls = falls\n# 註解\n自我效能 ＝ Self-efficacy\n\nlonely\nfalls = 摔倒");
	assert.deepEqual(a.groups.map(g => [g.name, g.names]), [
		["跌倒", ["跌倒", "Accidental Falls", "falls"]],
		["自我效能", ["自我效能", "Self-efficacy"]],
		["falls", ["falls", "摔倒"]],
	]);
	assert.equal(a.map.get("accidental falls").name, "跌倒");
	assert.equal(a.map.get("self efficacy").name, "自我效能");
	// "falls" stays in its first group; "摔倒" joins the third
	assert.equal(a.map.get("falls").name, "跌倒");
	assert.equal(a.map.get("摔倒").name, "falls");
	assert.equal(a.errors.length, 2);
	assert.match(a.errors[0], /lonely/);
	assert.match(a.errors[1], /「falls」同時出現在兩組別名中/);
	assert.deepEqual(c.parseAliases("").groups, []);
	assert.deepEqual(c.parseAliases(undefined).errors, []);
});

test("keyConcepts: only the 關鍵概念 links of the managed region; labels, anchors and embeds", () => {
	let text = literatureNote("A", {
		concepts: ["Self-efficacy", "跌倒預防|Fall prevention", "Health literacy#定義", "自我效能"],
		user: "\n- [[Self-efficacy]] 我自己的連結\n- [[My own idea]]\n",
	});
	assert.deepEqual(c.keyConcepts(text), ["Self-efficacy", "跌倒預防", "Health literacy", "自我效能"]);
	// An embed is not a concept; duplicates once
	let section = "%% zotero-bridge:start %%\n### 關鍵概念\n- ![[figure.png]] [[A]] [[A]]\n#### 小標\n- [[B]]\n### 可引用的句子\n- [[C]]\n%% zotero-bridge:end %%";
	assert.deepEqual(c.keyConcepts(section), ["A", "B"]);
	// A custom template's English heading
	assert.deepEqual(c.keyConcepts(literatureNote("B", { heading: "Key Concepts", concepts: ["Resilience"] })), ["Resilience"]);
	// No managed region (the user removed the markers): nothing
	assert.deepEqual(c.keyConcepts("# Note\n\n## 關鍵概念\n\n- [[A]]\n"), []);
	// No heading: nothing
	assert.deepEqual(c.keyConcepts(literatureNote("C", { heading: "其他" , concepts: ["X"] })), []);
	// Inside a code fence the heading of the next section doesn't end the section early
	assert.deepEqual(c.wikilinkTargets("[[A|a]] [[B\\|b]] ![[C]] [[ ]]"), ["A", "B"]);
});

test("paperRecord: frontmatter fields, summary, measures and outcomes as typed mentions, deleted notes", () => {
	let study = { study_design: "RCT", evidence_level: "2", measures: ["Morse Fall Scale", "文中未報告"], outcomes: "跌倒發生率、跌倒自我效能; null" };
	let r = record("A", { concepts: ["Self-efficacy"], study, title: "Nurse-led education", year: "2023", summary: "衛教降低跌倒。" });
	assert.equal(r.title, "Nurse-led education");
	assert.equal(r.year, "2023");
	assert.equal(r.design, "RCT");
	assert.equal(r.level, "2");
	assert.equal(r.zoteroKey, "library/A");
	assert.equal(r.link, "Zotero/A");
	assert.equal(r.summary, "衛教降低跌倒。");
	assert.equal(r.deleted, false);
	assert.deepEqual(r.mentions, [{ name: "Self-efficacy", type: "概念" }, { name: "Morse Fall Scale", type: "測量工具" }]);
	let all = record("A", { concepts: [], study }, { measures: false, outcomes: true });
	assert.deepEqual(all.mentions, [{ name: "跌倒發生率", type: "結果指標" }, { name: "跌倒自我效能", type: "結果指標" }]);
	let deleted = c.paperRecord(core.markObsidianNoteDeleted(literatureNote("D", { concepts: ["X"] }), { now: NOW }), "Zotero/D.md");
	assert.equal(deleted.deleted, true);
	assert.deepEqual(c.splitOutcomes("A，B, A;  " + "x".repeat(41)), ["A", "B"]);
});

function library() {
	return [
		record("A", { concepts: ["Self-efficacy", "Fall prevention", "跌倒"], year: "2024", study: { study_design: "RCT", evidence_level: "2", measures: ["Morse Fall Scale"] } }),
		record("B", { concepts: ["self efficacy", "Accidental Falls"], year: "2021", study: { study_design: "cohort", measures: ["Morse Fall Scale"] } }),
		record("C", { concepts: ["Ｓｅｌｆ－ｅｆｆｉｃａｃｙ", "Fall prevention"], year: "2022", title: "Paper | C" }),
		Object.assign(record("D", { concepts: ["Self-efficacy", "Gone"] }), { deleted: true }),
	];
}

test("collectConcepts: one concept per normalized name or alias group, by paper count, with co-occurrence", () => {
	let result = c.collectConcepts(library(), { aliases: c.parseAliases("跌倒 = Accidental Falls = falls") });
	assert.deepEqual(result.concepts.map(x => [x.name, x.papers.length, x.types]), [
		["Self-efficacy", 3, ["概念"]],
		["跌倒", 2, ["概念"]],
		["Fall prevention", 2, ["概念"]],
		["Morse Fall Scale", 2, ["測量工具"]],
	]);
	let se = result.concepts[0];
	// The most used spelling names the card; the others (and the raw full-width link) are aliases
	assert.deepEqual(se.aliases, ["self efficacy", "Ｓｅｌｆ－ｅｆｆｉｃａｃｙ"]);
	// Papers newest first; the deleted one is left out
	assert.deepEqual(se.papers.map(p => p.relPath), ["Zotero/A.md", "Zotero/C.md", "Zotero/B.md"]);
	assert.equal(result.byKey.has("gone"), false);
	let falls = result.byKey.get("跌倒");
	assert.deepEqual(falls.aliases, ["Accidental Falls", "falls"]);
	assert.deepEqual(se.cooccur.map(o => [o.concept.name, o.count]), [["跌倒", 2], ["Fall prevention", 2], ["Morse Fall Scale", 2]]);
	assert.deepEqual(result.byKey.get("fall prevention").cooccur.map(o => [o.concept.name, o.count]),
		[["Self-efficacy", 2], ["跌倒", 1], ["Morse Fall Scale", 1]]);
	assert.equal(result.papers.length, 3);
	// A name used as a concept and as a measure has both types
	let both = c.collectConcepts([record("E", { concepts: ["Morse Fall Scale"], study: { measures: ["morse fall scale"] } })]);
	assert.deepEqual(both.concepts.map(x => [x.name, x.types, x.papers.length]), [["Morse Fall Scale", ["概念", "測量工具"], 1]]);
});

test("assignFiles: sanitized, unique (case-insensitive) names, never the index; the spelled name becomes an alias", () => {
	let result = c.collectConcepts([record("A", { concepts: ["HIV/AIDS", "HIV AIDS", "概念索引", "hiv aids?"] })]);
	c.assignFiles(result.concepts, ["Zotero", "概念"]);
	let files = Object.fromEntries(result.concepts.map(x => [x.name, x.fileName]));
	// Same paper count: by name, so "HIV AIDS" comes first and keeps the plain file name
	assert.deepEqual(files, { "HIV AIDS": "HIV AIDS.md", "hiv aids?": "hiv aids (概念).md", "HIV/AIDS": "HIV AIDS (2).md", "概念索引": "概念索引 (概念).md" });
	let slash = result.concepts.find(x => x.name === "HIV/AIDS");
	assert.equal(slash.link, "Zotero/概念/HIV AIDS (2)");
	assert.equal(slash.relPath, "Zotero/概念/HIV AIDS (2).md");
	assert.ok(slash.aliases.includes("HIV/AIDS"));
});

function cards() {
	let result = c.collectConcepts(library(), { aliases: c.parseAliases("跌倒 = Accidental Falls = falls") });
	c.assignFiles(result.concepts, ["Zotero", "概念"]);
	return result;
}

test("a card: aliases, search links, paper table, co-occurring concepts and the definition placeholder", () => {
	let result = cards();
	let cfg = searchLinks.normalizeConfig({});
	let text = c.buildConceptNote(null, result.concepts[0], { indexLink: "Zotero/概念/概念索引", cfg, now: NOW });
	assert.match(text, /^---\ntype: "concept"\nconcept: "Self-efficacy"\nconcept_types:\n {2}- "概念"\npapers: 3\naliases:\n {2}- "self efficacy"\n {2}- "Ｓｅｌｆ－ｅｆｆｉｃａｃｙ"\nupdated: "2026-10-08T12:00:00.000Z"\n---\n\n# Self-efficacy\n\n## 📖 我的定義\n/);
	assert.match(text, /\*\*類型\*\*：概念 · \*\*文獻數\*\*：3 · \*\*年份\*\*：2021–2024 · \*\*別名\*\*：self efficacy、Ｓｅｌｆ－ｅｆｆｉｃａｃｙ/);
	assert.match(text, /\[MeSH：Self-efficacy\]\(https:\/\/www\.ncbi\.nlm\.nih\.gov\/mesh\/\?term=Self-efficacy\)/);
	assert.match(text, /\[PubMed 搜尋\]\(https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/\?term=%22Self-efficacy%22%5Btiab%5D\)/);
	assert.match(text, /\| \[\[Zotero\/A\\\|Paper A\]\] \| 2024 \| RCT \| 2 \| Paper A 的一句話摘要。 \|/);
	assert.match(text, /\| \[\[Zotero\/C\\\|Paper ｜ C\]\] \| 2022 \| {2}\| {2}\| Paper \\\| C 的一句話摘要。 \|/);
	assert.match(text, /## 🔗 常一起出現的概念\n\n- \[\[Zotero\/概念\/跌倒\|跌倒\]\]（2 篇）\n- \[\[Zotero\/概念\/Fall prevention\|Fall prevention\]\]（2 篇）/);
	assert.match(text, /← \[\[Zotero\/概念\/概念索引\|概念索引\]\]\n\n%% zotero-bridge:end %%\n\n## ✍️ 我的筆記\n\n$/);
	// A Chinese card looks up its English alias; Google Scholar gets the Chinese name
	let falls = c.searchLine(result.byKey.get("跌倒"), cfg);
	assert.match(falls, /MeSH：Accidental Falls\]\(https:\/\/www\.ncbi\.nlm\.nih\.gov\/mesh\/\?term=Accidental%20Falls\)/);
	assert.match(falls, /Google Scholar：跌倒\]\(https:\/\/scholar\.google\.com\/scholar\?hl=zh-TW&q=%E8%B7%8C%E5%80%92\)/);
	// Only Chinese: no MeSH/PubMed; sources the user turned off are left out
	let zh = c.collectConcepts([record("Z", { concepts: ["病人安全"] })]).concepts[0];
	assert.doesNotMatch(c.searchLine(zh, cfg), /MeSH|PubMed/);
	assert.equal(c.searchLine(zh, searchLinks.normalizeConfig({ disabled: "scholar" })), "");
	assert.doesNotMatch(c.searchLine(result.concepts[0], searchLinks.normalizeConfig({ disabled: "mesh,pubmed" })), /MeSH|PubMed/);
	// A measure's card says where it came from
	assert.match(c.buildConceptSection(result.byKey.get("morse fall scale"), {}), /「關鍵概念」的連結與研讀資料（測量工具／結果指標）整理/);
});

test("rebuilding a card keeps the user's text, keys and aliases; unchanged cards are not rewritten", () => {
	let result = cards();
	let se = result.concepts[0];
	let first = c.buildConceptNote(null, se, { indexLink: "Zotero/概念/概念索引", now: NOW });
	let edited = first
		.replace("aliases:\n", "my_rating: 5\naliases:\n  - \"自我效能\"\n")
		.replace(/> \[!note\] 用自己的話.*\n/, "Bandura (1977) 定義為相信自己能完成某行為的信念。\n")
		+ "我的想法：和健康識能有關。\n";
	// Same data: the same text, `updated` kept
	assert.equal(c.buildConceptNote(edited, se, { indexLink: "Zotero/概念/概念索引", now: LATER }), edited);
	// A new paper: managed parts change, the user's stay
	let more = c.collectConcepts([...library(), record("E", { concepts: ["Self-efficacy"], year: "2025", title: "Newest" })]);
	c.assignFiles(more.concepts, ["Zotero", "概念"]);
	let again = c.buildConceptNote(edited, more.concepts[0], { indexLink: "Zotero/概念/概念索引", now: LATER });
	assert.match(again, /papers: 4\n/);
	assert.match(again, /my_rating: 5\naliases:\n {2}- "自我效能"\n {2}- "self efficacy"\n {2}- "Ｓｅｌｆ－ｅｆｆｉｃａｃｙ"\nupdated: "2026-10-09T08:00:00.000Z"/);
	assert.match(again, /Bandura \(1977\) 定義為相信自己能完成某行為的信念。/);
	assert.match(again, /我的想法：和健康識能有關。\n$/);
	assert.match(again, /\[\[Zotero\/E\\\|Newest\]\] \| 2025/);
	assert.equal(again.split("%% zotero-bridge:start").length, 2);

	// A note the user wrote before (no markers): the region goes after its heading, nothing is lost
	let mine = "---\ntags: [idea]\n---\n# Self-efficacy\n\n我自己的筆記。\n";
	let merged = c.buildConceptNote(mine, se, { now: NOW });
	assert.match(merged, /^---\ntags: \[idea\]\ntype: "concept"\n/);
	assert.match(merged, /# Self-efficacy\n\n%% zotero-bridge:start[^\n]*\n[\s\S]*%% zotero-bridge:end %%\n\n\n我自己的筆記。\n$/);
	// An orphan card: only papers and the managed region change
	let orphan = c.buildManagedNote(again, { papers: 0 }, c.buildOrphanSection({ indexLink: "Zotero/概念/概念索引" }), { now: LATER });
	assert.match(orphan, /papers: 0\n/);
	assert.match(orphan, /目前沒有文獻筆記提到這個概念/);
	assert.match(orphan, /Bandura \(1977\)/);
});

test("the AI block survives a rebuild and is replaced by the next synthesis", () => {
	let result = cards();
	let se = result.concepts[0];
	let card = c.buildConceptNote(null, se, { now: NOW });
	let block1 = "%% zotero-bridge:concept-ai:start — x %%\n## 🤖 AI 綜整（草稿）\n\n第一版\n\n%% zotero-bridge:concept-ai:end %%";
	let withAI = c.insertAIBlock(card, block1, { generatedAt: NOW });
	assert.match(withAI, /ai_synthesis: "2026-10-08T12:00:00.000Z"\n/);
	assert.match(withAI, /%% zotero-bridge:end %%\n\n%% zotero-bridge:concept-ai:start — x %%[\s\S]*第一版[\s\S]*concept-ai:end %%\n\n## ✍️ 我的筆記/);
	// A rebuild (new paper) leaves the AI block alone
	let more = c.collectConcepts([...library(), record("E", { concepts: ["Self-efficacy"] })]);
	c.assignFiles(more.concepts, ["Zotero", "概念"]);
	let rebuilt = c.buildConceptNote(withAI, more.concepts[0], { now: LATER });
	assert.match(rebuilt, /papers: 4/);
	assert.match(rebuilt, /第一版/);
	assert.match(rebuilt, /ai_synthesis: /);
	let block2 = block1.replace("第一版", "第二版");
	let replaced = c.insertAIBlock(rebuilt, block2, { generatedAt: LATER });
	assert.doesNotMatch(replaced, /第一版/);
	assert.equal(replaced.split("concept-ai:start").length, 2);
	assert.match(replaced, /ai_synthesis: "2026-10-09T08:00:00.000Z"/);
	// Without markers: before 我的筆記, else at the end
	assert.match(c.insertAIBlock("# X\n\n## ✍️ 我的筆記\n\n心得\n", block1), /^# X\n\n%% zotero-bridge:concept-ai:start[\s\S]*end %%\n\n## ✍️ 我的筆記\n\n心得\n$/);
	assert.match(c.insertAIBlock("# X\n", block1), /^# X\n\n%% zotero-bridge:concept-ai:start[\s\S]*end %%\n$/);
});

test("buildMermaid: top concepts with paper counts, shapes per type, strongest co-occurrence edges, safe labels", () => {
	let result = cards();
	let m = c.buildMermaid(result.concepts);
	assert.equal(m, [
		"```mermaid",
		"graph LR",
		"    c1[\"Self-efficacy（3）\"]",
		"    c2[\"跌倒（2）\"]",
		"    c3[\"Fall prevention（2）\"]",
		"    c4([\"Morse Fall Scale（2）\"])",
		"    c1 ---|2| c2",
		"    c1 ---|2| c3",
		"    c1 ---|2| c4",
		"    c2 ---|2| c4",
		"    c2 ---|1| c3",
		"    c3 ---|1| c4",
		"```",
	].join("\n"));
	assert.equal(c.buildMermaid([]), "");
	// Only the top 15 nodes; quotes in names don't break the label; outcomes are hexagons
	let many = c.collectConcepts(Array.from({ length: 20 }, (_, i) => record(`P${i}`, {
		concepts: Array.from({ length: 20 - i }, (__, j) => `Concept "${j}"`),
		study: i === 0 ? { outcomes: "跌倒率" } : null,
	}, { outcomes: true })));
	let big = c.buildMermaid(many.concepts);
	assert.equal((big.match(/^ {4}c\d+[[({]/gm) || []).length, 15);
	assert.match(big, /c1\["Concept #quot;0#quot;（20）"\]/);
	assert.ok((big.match(/---\|/g) || []).length <= 30);
	let outcome = c.collectConcepts([record("O", { concepts: [], study: { outcomes: "跌倒率" } }, { outcomes: true })]);
	assert.match(c.buildMermaid(outcome.concepts), /c1\{\{"跌倒率（1）"\}\}/);
});

test("the index note: counts, Mermaid, the frequency table and alias errors; empty state", () => {
	let result = cards();
	let text = c.buildIndexNote(null, result, { now: NOW, aliasErrors: ["「x」至少要有兩個名稱"] });
	assert.match(text, /^---\ntype: "concept-index"\nconcepts: 4\nupdated: "2026-10-08T12:00:00.000Z"\n---\n\n# 概念索引\n\n%% zotero-bridge:start/);
	assert.match(text, /> \[!warning\] 別名設定有問題\n> - 「x」至少要有兩個名稱/);
	assert.match(text, /共 \*\*4\*\* 個概念，來自 \*\*3\*\* 篇文獻筆記。/);
	assert.match(text, /```mermaid\ngraph LR\n/);
	assert.match(text, /\| \[\[Zotero\/概念\/Self-efficacy\\\|Self-efficacy\]\] \| 概念 \| 3 \| \[\[Zotero\/概念\/跌倒\\\|跌倒\]\]、/);
	assert.match(text, /\| \[\[Zotero\/概念\/Morse Fall Scale\\\|Morse Fall Scale\]\] \| 測量工具 \| 2 \|/);
	let empty = c.buildIndexSection({ concepts: [], papers: [] });
	assert.match(empty, /還沒有概念/);
	assert.doesNotMatch(empty, /\[\[/);
});

test("the dashboard's 熱門概念 section", () => {
	let top = [{ name: "Self-efficacy", link: "Zotero/概念/Self-efficacy", papers: 3 }, { name: "跌倒", link: "Zotero/概念/跌倒", papers: 2 }];
	assert.equal(c.buildDashboardSection(top, { indexLink: "Zotero/概念/概念索引", total: 2 }), [
		"## 🧠 熱門概念",
		"[[Zotero/概念/概念索引|概念索引]]：共 2 個概念；文獻數最多的 2 個：",
		"[[Zotero/概念/Self-efficacy|Self-efficacy]]（3） · [[Zotero/概念/跌倒|跌倒]]（2）",
	].join("\n\n"));
	let none = c.buildDashboardSection([]);
	assert.match(none, /還沒有概念卡片：Zotero Bridge 按鈕或快速指令 → 更新概念卡片/);
	assert.doesNotMatch(none, /\[\[/);
});

test("AI synthesis: [S#] prompt about the concept, citations to note links, number check, references", () => {
	let result = cards();
	let se = result.concepts[0];
	let sources = se.papers.map((p, i) => ({
		paper: p,
		data: { title: p.title, year: p.year, key: p.zoteroKey.split("/")[1], libraryPath: "library", creators: [{ lastName: ["Chen", "Lee", "Wang"][i], creatorType: "author" }], apa: `${["Chen", "Lee", "Wang"][i]}, M. (${p.year}). ${p.title}.` },
		aiMarkdown: i === 0 ? "## 主要結果\n\n自我效能分數提升 12.5 分。" : "## 主要結果\n\n沒有差異。",
		study: i === 0 ? { study_design: "RCT", sample_size: 120, measures: ["GSE"] } : null,
		annotationsText: "",
	}));
	let prompt = c.buildConceptPrompt(se, sources);
	assert.equal(prompt.system, c.DEFAULT_CONCEPT_PROMPT.trim());
	assert.match(prompt.system, /引用只能使用提供的代號 \[S1\]、\[S2\]/);
	assert.match(prompt.user, /^以下是 3 篇文獻（代號 S1、S2、S3）。/);
	assert.match(prompt.user, /<source id="S1">\n標題：Paper A\n年份：2024\n[\s\S]*<study_data>\n研究設計：RCT\n樣本數：120\n測量工具：GSE\n<\/study_data>/);
	assert.match(prompt.user, /<concept>\n名稱：Self-efficacy\n其他寫法：self efficacy、Ｓｅｌｆ－ｅｆｆｉｃａｃｙ\n類型：概念\n<\/concept>/);
	assert.match(prompt.user, /聚焦在「Self-efficacy」撰寫概念綜整草稿。$/);
	assert.deepEqual(prompt.entries.map(e => e.citation), ["Chen, 2024", "Lee, 2022", "Wang, 2021"]);
	assert.equal(c.buildConceptPrompt(se, sources, { systemPrompt: " 自訂 " }).system, "自訂");

	let answer = "## 定義與內涵\n自我效能是相信自己能完成行為的信念 [S1]。介入後分數提升 12.5 分 [S1]，另一研究為 40 分 [S2]。\n\n## 研究缺口\n缺少長期追蹤 [S9]。";
	let texts = new Map(sources.map((s, i) => [prompt.entries[i].id, reviewDraft.sourceText(s)]));
	let linkTargets = Object.fromEntries(sources.map((s, i) => [prompt.entries[i].id, s.paper.link]));
	let draft = c.processConceptDraft(answer, prompt.entries, texts, linkTargets);
	assert.deepEqual(draft.issues.unknown, ["S9"]);
	assert.deepEqual(draft.issues.uncited.map(e => e.id), ["S3"]);
	let block = c.buildAIBlock(draft, prompt.entries, { model: "test-model", generatedAt: NOW });
	assert.match(block, /^%% zotero-bridge:concept-ai:start[^\n]*%%\n\n## 🤖 AI 綜整（草稿）\n\n> \[!warning\] AI 草稿：由 test-model 於 2026-10-08 依 3 篇文獻的 AI 筆記產生/);
	assert.match(block, /### 定義與內涵\n自我效能是相信自己能完成行為的信念 \[\[Zotero\/A\|Chen, 2024\]\]。介入後分數提升 12\.5 分 \[\[Zotero\/A\|Chen, 2024\]\]，另一研究為 40 分 \[\[Zotero\/C\|Lee, 2022\]\]。/);
	assert.match(block, /缺少長期追蹤 【⚠️ 未知來源 S9】。/);
	assert.match(block, /### 參考文獻\n\n- Chen, M\. \(2024\)\. Paper A\./);
	// S9 is unknown; 40 is in neither cited note (12.5 is in Chen's); Wang is never cited
	assert.match(block, /### ⚠️ 查核清單\n\n> \[!warning\] 2 項需要回原文確認\n> - \*\*未知來源代號\*\*：S9/);
	assert.match(block, /\*\*數字\*\*：「介入後分數提升 12\.5 分 \(Chen, 2024\)，另一研究為 40 分 \(Lee, 2022\)。」— 在 Chen, 2024; Lee, 2022 的 AI 筆記、摘要與劃線中找不到 40\n/);
	assert.match(block, /\*\*未引用的文獻\*\*（僅供參考）：Wang, 2021/);
	assert.doesNotMatch(block, /citekey/);
	// Nothing to flag
	let clean = c.processConceptDraft("## 定義與內涵\n分數提升 12.5 分 [S1]。其他研究一致 [S2, S3]。", prompt.entries, texts, linkTargets);
	assert.match(c.buildAIBlock(clean, prompt.entries, {}), /> \[!success\]/);
	assert.match(block, /%% zotero-bridge:concept-ai:end %%$/);
});
