// The literature note layout (content/core.js): colour meanings, 「重點」 at the top, folded sections in a
// fixed order, the Notion variant, and a note written by v0.9.0 re-synced into the new layout.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../content/core.js");
const concepts = require("../content/concepts.js");
const { sampleItem, AI_MD } = require("./fixtures.cjs");

const AI_FULL = AI_MD + `
## 主要結果
- 跌倒率下降 30%（p < .05）
- 跌倒自我效能提升
- 沒有不良事件
- 第四點不會出現在重點

## 證據等級
CEBM 2，JBI 1.c。
`;
const STUDY = { study_design: "RCT", sample_size: 120, evidence_level: "2", jbi_level: "1.c", appraisal_overall: "納入" };

function item() {
	let d = sampleItem();
	d.attachments[0].annotations = [
		{ key: "Y1", type: "highlight", text: "Falls decreased by 30%", comment: "", color: "#ffd400", pageLabel: "5", tags: [] },
		{ key: "R1", type: "highlight", text: "Only two wards took part", comment: "外推性？", color: "#ff6666", pageLabel: "7", tags: [] },
		{ key: "B1", type: "highlight", text: "Nurse-led education is feasible", comment: "", color: "#2ea8e5", pageLabel: "8", tags: [] },
		{ key: "Y2", type: "highlight", text: "Adherence was 92%", comment: "", color: "#ffd400", pageLabel: "6", tags: [] },
		{ key: "X1", type: "note", text: "", comment: "odd colour", color: "#123456", pageLabel: "9", tags: [] },
	];
	return d;
}

/** The callout titles of the managed block, in order. */
function calloutTitles(note) {
	return [...note.matchAll(/^> \[!([\w-]+)\](-?) (.+)$/gm)].map(m => `${m[1]}${m[2]} ${m[3]}`);
}

test("colorMeanings: Zotero's eight colours once each, in the user's order; defaults fill the gaps", () => {
	let d = core.colorMeanings("");
	assert.deepEqual(d.map(m => m.meaning), ["重要發現", "限制／疑問", "研究方法", "可引用句", "定義／概念", "待查證", "我的想法", "其他"]);
	assert.deepEqual(d.map(m => m.color), ["#ffd400", "#ff6666", "#5fb236", "#2ea8e5", "#a28ae5", "#f19837", "#e56eee", "#aaaaaa"]);
	assert.equal(d[0].info.emoji, "🟡");
	let custom = core.colorMeanings(JSON.stringify([
		{ color: "#FF6666", meaning: "  研究缺口 " }, { color: "#ffd400", meaning: "" }, { color: "#ff6666", meaning: "dup" },
		{ color: "#000000", meaning: "not a Zotero colour" }, { color: "#5fb236", meaning: "x".repeat(60) },
	]));
	assert.deepEqual(custom.slice(0, 3).map(m => [m.color, m.meaning]), [["#ff6666", "研究缺口"], ["#ffd400", "重要發現"], ["#5fb236", "x".repeat(40)]]);
	assert.equal(custom.length, 8, "the missing colours follow in the default order");
	assert.deepEqual(custom.slice(3).map(m => m.color), ["#2ea8e5", "#a28ae5", "#f19837", "#e56eee", "#aaaaaa"]);
	assert.deepEqual(core.colorMeanings("{not json").map(m => m.meaning), d.map(m => m.meaning));
	assert.deepEqual(core.colorMeanings([{ color: "#aaaaaa", meaning: "灰" }])[0].meaning, "灰");
});

test("annotationGroups: grouped by meaning in the user's order; a colour outside Zotero's eight goes last", () => {
	let order = JSON.stringify([{ color: "#ff6666", meaning: "限制" }, { color: "#2ea8e5", meaning: "引用" }]);
	let groups = core.annotationGroups(item(), order);
	assert.deepEqual(groups.map(g => [g.meaning, g.items.map(i => i.ann.key)]), [
		["限制", ["R1"]], ["引用", ["B1"]], ["重要發現", ["Y1", "Y2"]], ["其他顏色", ["X1"]],
	]);
	// 重點 picks one per meaning first, in that order
	assert.deepEqual(core.topHighlights(groups).map(h => h.ann.key), ["R1", "B1", "Y1"]);
	assert.deepEqual(core.topHighlights(groups, 5).map(h => h.ann.key), ["R1", "B1", "Y1", "Y2"], "then the second of each");
});

test("AI note parts: one sentence, 2–3 key findings, the rest without the summary heading", () => {
	assert.equal(core.oneSentence(AI_FULL), "護理師主導衛教可降低住院病人跌倒率 30%（[[Fall prevention]]）。");
	assert.deepEqual(core.keyFindings(AI_FULL), ["跌倒率下降 30%（p < .05）", "跌倒自我效能提升", "沒有不良事件"]);
	assert.deepEqual(core.keyFindings("## 主要結果\nThe rate fell by 30%. Adherence was high. A third sentence.\n"), ["The rate fell by 30%.", "Adherence was high."]);
	assert.deepEqual(core.keyFindings("## 其他\n- x"), []);
	let body = core.aiNoteBody(AI_FULL);
	assert.doesNotMatch(body, /一句話摘要|護理師主導衛教可降低/);
	assert.match(body, /^### 研究設計與方法$/m);
	// A custom template without the summary heading is kept whole
	assert.equal(core.aiNoteBody("## A\nx"), "### A\nx");
	assert.equal(core.factsLine(STUDY), "RCT · N = 120 · CEBM 2 · JBI 1.c · 評讀：納入（AI 初評）");
	assert.equal(core.factsLine(STUDY, { overall: "排除", verified: true }), "RCT · N = 120 · CEBM 2 · JBI 1.c · 評讀：排除（已核對）");
	assert.equal(core.factsLine(null), "");
});

test("the note: 「重點」 open at the top, then folded sections in a fixed order, own words before the AI's", () => {
	let note = core.buildObsidianNote(null, item(), {
		aiMarkdown: AI_FULL, aiModel: "model-x", aiGeneratedAt: "2026-10-07T01:02:03Z", study: STUDY,
		notionUrl: "https://www.notion.so/abc", notesMarkdown: [{ title: "n", md: "# 我的子筆記\n自己的想法" }],
		appraisalMarkdown: "## 文獻評讀表\n\n> [!success] 已核對（2026-10-01）\n> 評讀工具：CASP",
		appraisal: { verified: true, tool: "CASP", overall: "納入" },
		searchCallout: "> [!search]- 🔎 延伸搜尋\n> **找這篇**：[PubMed](https://pubmed.ncbi.nlm.nih.gov/?term=x)",
		fullTextLink: "Zotero/全文/chen2024effects",
		aiHighlights: [{ quote: "Falls decreased by 30%", why: "主要結果" }],
		colorMeanings: "",
	});
	assert.deepEqual(calloutTitles(note), [
		"abstract 重點",
		"quote- 🟡 重要發現（2）",
		"quote- 🔴 限制／疑問（1）",
		"quote- 🔵 可引用句（1）",
		"quote- ⚫ 其他顏色（1）",
		"note- 我的 Zotero 筆記（1）",
		"example- 文獻評讀表",
		"tip- AI 標的重點（僅供參考）",
		"note- AI 文獻筆記（model-x · 2026-10-07）",
		"info- 摘要（Abstract）",
		"search- 🔎 延伸搜尋",
		"info- 書目資訊",
	]);
	let keyPoints = note.slice(note.indexOf("> [!abstract] 重點"), note.indexOf("> [!quote]-"));
	assert.equal(keyPoints, [
		"> [!abstract] 重點",
		"> **一句話**：護理師主導衛教可降低住院病人跌倒率 30%（[[Fall prevention]]）。",
		">",
		"> RCT · N = 120 · CEBM 2 · JBI 1.c · 評讀：納入（已核對）",
		">",
		"> **主要發現**",
		"> - 跌倒率下降 30%（p < .05）",
		"> - 跌倒自我效能提升",
		"> - 沒有不良事件",
		">",
		"> **我的劃線**",
		"> - ==🟡Falls decreased by 30%== 重要發現 · [p. 5](zotero://open-pdf/library/items/PDF00001?page=5&annotation=Y1)",
		"> - ==🔴Only two wards took part== 限制／疑問 · [p. 7](zotero://open-pdf/library/items/PDF00001?page=7&annotation=R1)",
		"> - ==🔵Nurse-led education is feasible== 可引用句 · [p. 8](zotero://open-pdf/library/items/PDF00001?page=8&annotation=B1)",
		">",
		"> [[Zotero/全文/chen2024effects|全文與劃線]] · [Zotero](zotero://select/library/items/ABCD1234) · [Notion](https://www.notion.so/abc) · [DOI](https://doi.org/10.1111/jan.12345)",
		"",
		"",
	].join("\n"));
	// Said once: the summary isn't repeated in the AI callout, the links not in 書目資訊
	assert.equal(note.match(/護理師主導衛教可降低住院病人跌倒率/g).length, 1);
	assert.doesNotMatch(note.slice(note.indexOf("> [!info]- 書目資訊")), /\*\*Zotero\*\*|\*\*Notion\*\*/);
	// AI key sentences: secondary to the user's highlights, listed with the robot marker
	assert.match(note, /^> \[!tip\]- AI 標的重點（僅供參考）\n> AI 從原文挑出、已核對確實在全文裡的句子；跟你自己的劃線分開，判斷還是你來做。在全文裡以 🤖 加底線標出。\n>\n> - 🤖 "Falls decreased by 30%" — 主要結果$/m);
	assert.match(note, /^fulltext: "\[\[Zotero\/全文\/chen2024effects\]\]"$/m);
	// The appraisal's own heading is the callout title; its nested callout stays a callout
	assert.match(note, /^> \[!example\]- 文獻評讀表\n> > \[!success\] 已核對（2026-10-01）$/m);
	// Zotero notes keep their headings, two levels down
	assert.match(note, /^> ### 我的子筆記$/m);
	// Concept cards still find the summary and the key concepts inside the callouts
	assert.equal(concepts.oneLineSummary(note), "護理師主導衛教可降低住院病人跌倒率 30%（[[Fall prevention]]）。");
	assert.deepEqual(concepts.keyConcepts(note), ["Fall prevention", "Health education", "Self-efficacy"]);
});

test("the note without AI or highlights: 重點 says what will appear there; no empty sections", () => {
	let d = sampleItem({ attachments: [], abstract: "" });
	let note = core.buildObsidianNote(null, d, {});
	assert.deepEqual(calloutTitles(note), ["abstract 重點", "info- 書目資訊"]);
	assert.match(note, /^> 還沒有 AI 筆記或劃線。在 Zotero 劃線（顏色代表的意義在設定裡）或產生 AI 筆記後重新同步，重點會整理在這裡。$/m);
	assert.doesNotMatch(note, /^fulltext:/m);
});

test("Notion variant: the same parts, no vault links, the appraisal keeps its heading, groups carry their colour", () => {
	let { keyPoints, sections } = core.buildNoteSections(item(), {
		aiMarkdown: AI_FULL, study: STUDY, target: "notion", fullTextNote: true, fullTextLink: "Zotero/全文/x",
		appraisalMarkdown: "## 文獻評讀表\n\n> [!warning] AI 初評",
	});
	assert.doesNotMatch(keyPoints, /\[\[Zotero|zotero:\/\/select/);
	assert.match(keyPoints, /全文與劃線：本頁下方的子頁面 · \[DOI\]/);
	assert.deepEqual(sections.map(s => s.id), [
		"annotations:#ffd400", "annotations:#ff6666", "annotations:#2ea8e5", "annotations:other", "appraisal", "ai", "abstract", "info",
	]);
	assert.deepEqual(sections.slice(0, 4).map(s => s.color), ["yellow_background", "red_background", "blue_background", "default"]);
	assert.match(sections.find(s => s.id === "appraisal").md, /^## 文獻評讀表/, "insertNotionTable finds the heading");
});

test("a note written by v0.9.0, with the user's text around the managed block, re-syncs into the new layout without losing a word", () => {
	let old = fs.readFileSync(path.join(__dirname, "fixtures", "note-v0.9.0.md"), "utf8");
	assert.match(old, /^## Annotations$/m, "the fixture is the old layout");
	assert.match(old, /^%% zotero-bridge:start — 此區塊由 Zotero Bridge 自動產生/m, "the fixture's marker carries the old name");
	// The user's own edits: a frontmatter key, a changed status, text above the block and under 我的筆記
	let edited = old
		.replace("status: \"待讀\"", "status: \"閱讀中\"\nmy_rating: 4\naliases:\n  - \"Chen RCT\"")
		.replace(/(# Effects[^\n]*\n)/, "$1\n寫在自動區塊上方的提醒：先讀 Methods。\n")
		+ "\n我的心得：樣本只有兩個病房。\n\n- [ ] 查原始量表\n";
	let data = sampleItem();
	data.attachments[0].annotations = data.attachments[0].annotations.slice(0, 2);
	let opts = { aiMarkdown: AI_MD, aiModel: "model-x", notionUrl: "https://www.notion.so/abc", now: "2026-10-08T00:00:00Z", notesMarkdown: [{ title: "n", md: "Zotero note text" }] };
	let resynced = core.buildObsidianNote(edited, data, opts);
	let { frontmatter, body } = core.splitFrontmatter(resynced);
	// Everything the user wrote is still there, once
	for (let s of ["寫在自動區塊上方的提醒：先讀 Methods。", "我的心得：樣本只有兩個病房。", "- [ ] 查原始量表", "## ✍️ 我的筆記"]) {
		assert.equal(body.split(s).length - 1, 1, s);
	}
	assert.match(frontmatter, /^status: "閱讀中"$/m);
	assert.match(frontmatter, /^my_rating: 4$/m);
	assert.match(frontmatter, /^aliases:\n {2}- "Chen RCT"$/m);
	assert.match(frontmatter, /^last_synced: "2026-10-08T00:00:00Z"$/m);
	// The managed block is the new layout, and only that
	assert.equal(body.match(/zotero-bridge:start/g).length, 1);
	assert.equal(body.match(/zotero-bridge:end/g).length, 1);
	// …written under the new name (the old name was only ever inside the block)
	assert.match(body, /^%% zotero-bridge:start — 此區塊由 ZotMax 自動產生/m);
	assert.doesNotMatch(resynced, /Zotero Bridge/);
	assert.doesNotMatch(body, /^## (Annotations|Abstract|Zotero Notes|🤖 AI 文獻筆記)$/m, "old sections are gone");
	assert.ok(body.indexOf("寫在自動區塊上方") < body.indexOf("%% zotero-bridge:start"));
	assert.ok(body.indexOf("%% zotero-bridge:end %%") < body.indexOf("## ✍️ 我的筆記"));
	assert.ok(body.indexOf("## ✍️ 我的筆記") < body.indexOf("我的心得"));
	let block = body.slice(body.indexOf("%% zotero-bridge:start"), body.indexOf("%% zotero-bridge:end"));
	assert.match(block, /^> \[!abstract\] 重點$/m);
	assert.match(block, /^> - ==🟡Falls decreased by 30%== · \[p\. 5\]/m);
	assert.match(block, /^> Zotero note text$/m);
	// Idempotent from here on
	assert.equal(core.buildObsidianNote(resynced, data, opts), resynced);
});
