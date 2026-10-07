const test = require("node:test");
const assert = require("node:assert/strict");
const syn = require("../content/synthesis.js");
const md = require("../content/markdown.js");
const { sampleItem } = require("./fixtures.cjs");

const one = sampleItem();
const two = sampleItem({
	key: "EFGH5678", title: "Exercise and falls", year: "2021",
	creators: [{ lastName: "Lee", firstName: "A", creatorType: "author" }],
	apa: "Lee, A. (2021). Exercise and falls. Geriatric Nursing.",
});
const three = sampleItem({
	key: "IJKL9012", year: "",
	creators: [
		{ lastName: "Wang", creatorType: "author" }, { lastName: "Lin", creatorType: "author" },
		{ lastName: "Hsu", creatorType: "author" },
	],
	apa: "",
});

test("shortCitation follows APA author rules", () => {
	assert.equal(syn.shortCitation(two), "Lee, 2021");
	assert.equal(syn.shortCitation(one), "Chen & Smith, 2024");
	assert.equal(syn.shortCitation(three), "Wang et al., n.d.");
	assert.equal(syn.shortCitation({ title: "WHO guideline on falls prevention 2024", creators: [] }), "WHO guideline on falls, n.d.");
});

test("buildSynthesisPrompt labels sources and prefers AI notes", () => {
	let long = "x".repeat(syn.MAX_CHARS_PER_SOURCE + 10);
	let { system, user, entries } = syn.buildSynthesisPrompt([
		{ data: one, aiMarkdown: "## 一句話摘要\nAI note one" },
		{ data: two, aiMarkdown: "", annotationsText: "- p. 3 「highlight」" },
		{ data: three, aiMarkdown: long },
	], { focus: "跌倒預防" });
	assert.equal(system, syn.DEFAULT_SYNTHESIS_PROMPT);
	assert.deepEqual(entries.map(e => e.id), ["S1", "S2", "S3"]);
	assert.match(user, /<source id="S1">[\s\S]*<ai_note>\n## 一句話摘要\nAI note one/);
	assert.match(user, /<source id="S2">[\s\S]*<abstract>[\s\S]*<user_annotations>\n- p\. 3/);
	assert.equal(entries[2].truncated, true);
	assert.match(user, /（內容過長，已截斷）/);
	assert.match(user, /分析重點：跌倒預防/);
	assert.equal(syn.buildSynthesisPrompt([{ data: one }], { systemPrompt: "custom" }).system, "custom");
});

const OUTPUT = `## 綜合摘要
兩篇研究都支持衛教 [S1]，運動介入也有效 [S2, S1]；未知代號 [S9] 保持原樣。

## 文獻比較表
| 文獻 | 研究設計 | 主要結果 |
|---|---|---|
| [S1] | RCT | 跌倒率降低 30% |
| [S2] | cohort | 有效 |
`;

test("resolveCitations: Obsidian links, escaped pipes in tables, plain citations", () => {
	let { entries } = syn.buildSynthesisPrompt([{ data: one }, { data: two }]);
	let obs = syn.resolveCitations(OUTPUT, entries, "obsidian", { S1: "Zotero/碩論/chen2024effects" });
	assert.match(obs, /衛教 \[\[Zotero\/碩論\/chen2024effects\|Chen & Smith, 2024\]\]/);
	assert.match(obs, /有效 \(Lee, 2021\); \[\[Zotero\/碩論\/chen2024effects\|Chen & Smith, 2024\]\]/);
	assert.match(obs, /^\| \[\[Zotero\/碩論\/chen2024effects\\\|Chen & Smith, 2024\]\] \| RCT \|/m);
	assert.match(obs, /\[S9\]/);
	let plain = syn.resolveCitations(OUTPUT, entries, "plain");
	assert.match(plain, /有效 \(Lee, 2021; Chen & Smith, 2024\)/);
	assert.match(plain, /^\| \(Chen & Smith, 2024\) \| RCT/m);
});

test("buildSynthesisNote has frontmatter, links and an alphabetical APA list", () => {
	let { entries } = syn.buildSynthesisPrompt([{ data: one }, { data: two }]);
	let note = syn.buildSynthesisNote(OUTPUT, entries, {
		title: "文獻比較：碩論（2 篇）", scope: "碩論", model: "claude-opus-5-5",
		generatedAt: "2026-10-07T00:00:00Z", notionUrl: "https://www.notion.so/x", linkTargets: { S2: "Zotero/lee" },
	});
	assert.match(note, /^---\ntitle: "文獻比較：碩論（2 篇）"\ntype: "literature-synthesis"/);
	assert.match(note, /^sources:\n {2}- "library\/ABCD1234"\n {2}- "library\/EFGH5678"$/m);
	assert.match(note, /^notion: "https:\/\/www\.notion\.so\/x"$/m);
	assert.match(note, /\[\[Zotero\/lee\|Lee, 2021\]\]/);
	let refs = note.slice(note.indexOf("## 參考文獻"));
	assert.ok(refs.indexOf("- Chen, M.") < refs.indexOf("- Lee, A."), "APA list is alphabetical");
	assert.match(note, /## ✍️ 我的筆記/);
});

test("synthesis Markdown becomes a real Notion table and an HTML table", () => {
	let { entries } = syn.buildSynthesisPrompt([{ data: one }, { data: two }]);
	let plain = syn.buildSynthesisPlain(OUTPUT, entries);
	let blocks = md.mdToNotionBlocks(plain, { tables: true });
	let table = blocks.find(b => b.type === "table");
	assert.equal(table.table.table_width, 3);
	assert.equal(table.table.has_column_header, true);
	assert.equal(table.table.children.length, 3);
	assert.equal(table.table.children[1].table_row.cells[0][0].text.content, "(Chen & Smith, 2024)");
	assert.ok(blocks.some(b => b.type === "heading_2" && b.heading_2.rich_text[0].text.content === "參考文獻"));
	let html = md.mdToHtml(plain);
	assert.match(html, /<table><tr><th>文獻<\/th><th>研究設計<\/th><th>主要結果<\/th><\/tr><tr><td>\(Chen &amp; Smith, 2024\)<\/td>/);
	// In the container (no tables option) rows fall back to paragraphs
	assert.ok(!md.mdToNotionBlocks(plain).some(b => b.type === "table"));
});

test("Obsidian-escaped wikilinks inside table cells survive conversion", () => {
	let blocks = md.mdToNotionBlocks("| a | b |\n|---|---|\n| [[x/y\\|Chen, 2024]] | 2 |", { tables: true });
	assert.equal(blocks[0].table.children[1].table_row.cells[0].map(r => r.text.content).join(""), "Chen, 2024");
});

test("mdToOutline flattens Markdown for the item pane", () => {
	let out = md.mdToOutline("## 一句話摘要\n**重點** [[A|B]]\n- 設計：RCT\n  - 子項\n> [!info] 提示\n```\ncode\n```");
	assert.deepEqual(out, [
		{ type: "h", level: 2, text: "一句話摘要" },
		{ type: "p", text: "重點 B" },
		{ type: "li", level: 0, text: "設計：RCT" },
		{ type: "li", level: 1, text: "子項" },
		{ type: "quote", text: "提示" },
		{ type: "p", text: "code" },
	]);
});
