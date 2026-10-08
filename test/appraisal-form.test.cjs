// 文獻評讀表 sync and summary (appraisal-form.js, pure parts): AI prefill, the child note round trip,
// the Obsidian section and frontmatter, Notion properties and blocks, the EBHC/screening hooks, and
// the collection summary (traffic-light matrix, CSV, Word version, Cohen's kappa).
const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const tools = require("../content/appraisal-tools.js");
const form = require("../content/appraisal-form.js");
const core = require("../content/core.js");
const notion = require("../content/notion.js");
const markdown = require("../content/markdown.js");
const llm = require("../content/llm.js");

const AI_MD = `## 一句話摘要
衛教降低跌倒。

## 嚴格評讀
- 評讀工具：JBI Checklist for Randomized Controlled Trials
1. 是否真正隨機分派：是 — 電腦亂數
2. 分派是否隱匿：不清楚 — 未說明
3. 基準期是否相似：是
- 整體評價：納入 — 品質良好

## 證據等級
Level 2`;
const AI_DATA = llm.normalizeStudyData({ study_design: "RCT", sample_size: 120, appraisal_tool: "JBI Checklist for Randomized Controlled Trials", appraisal_overall: "納入" });

function verifiedRecord() {
	return tools.normalizeRecord({
		tool: "casp-rct",
		answers: {
			1: { answer: "是", note: "PICO 明確", source: "human" },
			2: { answer: "是", note: "電腦亂數 | 區塊", source: "human" },
			3: { answer: "否", note: "流失 25%", source: "human" },
			"4a": { answer: "否", note: "衛教無法盲化", source: "ai" },
		},
		overall: "納入", overallNote: "整體可信", verified: true, verifiedAt: "2026-10-08",
		dual: true, answersB: { 1: "是", 2: "否", 3: "否", "4a": "否" }, overallB: "需更多資訊",
	});
}

test("prefill: tool from the AI note, answers only for that tool, overall verdict always", () => {
	let r = form.prefill(AI_MD, AI_DATA);
	assert.equal(r.tool, "jbi-rct");
	assert.deepEqual(r.answers["1"], { answer: "是", note: "電腦亂數", source: "ai" });
	assert.equal(Object.keys(r.answers).length, 3);
	assert.equal(r.overall, "納入");
	assert.equal(r.overallNote, "品質良好");
	assert.equal(r.aiTool, "JBI Checklist for Randomized Controlled Trials");
	assert.equal(r.verified, false);
	assert.equal(form.statusOf(r), "ai");
	assert.equal(form.statusText(r), "AI 初評，尚未核對");
	// The user switches to CASP: no item answers carry over, the verdict does
	let casp = form.prefill(AI_MD, AI_DATA, "casp-rct");
	assert.equal(casp.tool, "casp-rct");
	assert.deepEqual(casp.answers, {});
	assert.equal(casp.overall, "納入");
	assert.equal(casp.overallNote, "");
	// Without an appraisal section: tool from appraisal_tool, then from study_design
	assert.equal(form.prefill("", { study_design: "qualitative" }).tool, "casp-qualitative");
	assert.equal(form.prefill("", { appraisal_tool: "JBI Checklist for Cohort Studies", study_design: "cohort" }).tool, "jbi-cohort");
	assert.equal(form.prefill("", null).tool, "casp-rct");
	// mergeAI fills only empty items
	let mine = tools.normalizeRecord({ tool: "jbi-rct", answers: { 1: { answer: "否", note: "我的判斷", source: "human" } } });
	let merged = form.mergeAI(mine, AI_MD);
	assert.deepEqual(merged.answers["1"], { answer: "否", note: "我的判斷", source: "human" });
	assert.equal(merged.answers["2"].source, "ai");
	assert.equal(form.statusOf(merged), "human");
	assert.equal(form.statusText(merged), "評讀中，尚未核對");
});

test("child note: readable table + JSON block; round trip, also through an HTML parser and serializer", () => {
	let r = verifiedRecord();
	let html = form.noteHTML(r, { title: "Fall <prevention> RCT" });
	assert.match(html, /^<h1>📝 文獻評讀表<\/h1>/);
	assert.match(html, /<em>已核對（2026-10-08） · Fall &lt;prevention&gt; RCT/);
	assert.match(html, /<table><tr><th>評讀項目<\/th><th>評讀結果<\/th><th>評析根據<\/th><\/tr>/);
	assert.match(html, /<td>2\. 受試者是否被隨機分派到各介入組？<\/td><td>是<\/td><td>電腦亂數 \| 區塊<\/td>/);
	assert.match(html, /<strong>整體評價<\/strong>：納入 — 整體可信/);
	assert.match(html, /<h2>評讀者 B<\/h2>/);
	assert.match(html, /κ = /);
	assert.match(html, /<h2>📋 評讀表資料（Zotero Bridge）<\/h2>\n<pre>\{/);
	let back = form.readNoteHTML(html);
	assert.deepEqual(back, r);
	// Zotero's note editor re-serializes the HTML
	let dom = new JSDOM(`<div id="n">${html}</div>`);
	assert.deepEqual(form.readNoteHTML(dom.window.document.getElementById("n").innerHTML), r);
	// A <pre><code> wrapper and <br> line breaks
	let wrapped = html.replace(/<pre>([\s\S]*?)<\/pre>/, (all, body) => `<pre><code>${body.replace(/\n/g, "<br>")}</code></pre>`);
	assert.deepEqual(form.readNoteHTML(wrapped), r);
	assert.equal(form.readNoteHTML("<p>no data</p>"), null);
	assert.equal(form.readNoteHTML("<pre>{\"format\":\"other\"}</pre>"), null);
	assert.equal(form.readNoteHTML("<pre>{broken</pre>"), null);
});

test("syncInfo: the saved form wins; else the AI prefill; nothing without answers", () => {
	let html = form.noteHTML(verifiedRecord());
	let info = form.syncInfo({ appraisalNote: { key: "N1", html } }, { md: AI_MD, data: AI_DATA });
	assert.equal(info.saved, true);
	assert.equal(info.verified, true);
	assert.equal(info.tool.id, "casp-rct");
	assert.deepEqual(info.values, { verified: true, tool: tools.getTool("casp-rct").name, overall: "納入" });
	assert.match(info.markdown, /^## 文獻評讀表\n\n> \[!success\] 已核對（2026-10-08）\n> 評讀工具：\[CASP Checklist: For Randomised Controlled Trials \(RCTs\) \(2024\)\]\(https:\/\/casp-uk\.net\/[^)]+\)｜是 2／否 2／不清楚 0／不適用 0（共 13 題，已答 4 題，「是」占 50%）\n\n\| 評讀項目 \| 評讀結果 \| 評析根據 \|/);
	assert.match(info.markdown, /\*\*整體評價\*\*：納入 — 整體可信/);
	assert.match(info.markdown, /\*\*雙人評讀\*\*：評讀者 A／B；κ = [-\d.]+（[^）]+）；一致率 75%（3\/4）；B 的整體評價：需更多資訊/);
	assert.match(info.markdown, /不一致的題目：2（A 是／B 否）/);
	assert.doesNotMatch(info.notionMarkdown, /\| 評讀項目/);
	assert.match(info.tableMarkdown, /^\| 評讀項目 \| 評讀結果 \| 評析根據 \|/);

	let ai = form.syncInfo({ appraisalNote: null }, { md: AI_MD, data: AI_DATA });
	assert.equal(ai.saved, false);
	assert.equal(ai.verified, false);
	assert.match(ai.markdown, /> \[!warning\] AI 初評，尚未核對\n> 評讀工具：\[JBI Critical Appraisal Tool/);
	assert.match(ai.markdown, /請在 Zotero 條目窗格「AI 文獻筆記 → 文獻評讀表」逐題核對/);
	assert.deepEqual(ai.values, { verified: false, tool: tools.getTool("jbi-rct").name, overall: "納入" });
	assert.equal(form.syncInfo({}, { md: "## 主要結果\n…", data: AI_DATA }), null);
	assert.equal(form.syncInfo({}, null), null);
	// A broken note falls back to the AI prefill
	assert.equal(form.syncInfo({ appraisalNote: { html: "<pre>{x</pre>" } }, { md: AI_MD, data: AI_DATA }).saved, false);
});

test("Obsidian: 「文獻評讀表」 folded before the AI note (the user's judgement first); appraisal_verified, and the verified tool/verdict override the AI's", () => {
	let data = { key: "ABCD1234", libraryPath: "library", title: "Fall prevention RCT", creators: [], year: "2024" };
	let verified = form.syncInfo({ appraisalNote: { html: form.noteHTML(verifiedRecord()) } }, { md: AI_MD, data: AI_DATA });
	let note = core.buildObsidianNote(null, data, {
		aiMarkdown: AI_MD, study: AI_DATA, appraisalMarkdown: verified.markdown, appraisal: verified.values,
	});
	assert.match(note, /\nappraisal_tool: "CASP Checklist: For Randomised Controlled Trials \(RCTs\) \(2024\)"\n/);
	assert.match(note, /\nappraisal_overall: "納入"\n/);
	assert.match(note, /\nappraisal_verified: true\n/);
	assert.ok(note.indexOf("> [!example]- 文獻評讀表\n> > [!success]") > note.indexOf("%% zotero-bridge:start"));
	assert.ok(note.indexOf("> [!example]- 文獻評讀表") < note.indexOf("> [!note]- AI 文獻筆記"));
	assert.ok(note.indexOf("> [!note]- AI 文獻筆記") < note.indexOf("%% zotero-bridge:end %%"));
	// The verified verdict is in 重點 too
	assert.match(note, /^> RCT · N = 120 · 評讀：納入（已核對）$/m);

	// Not verified: the AI's values stay, appraisal_verified false; a later sync without any form keeps the keys as they are
	let ai = form.syncInfo({}, { md: AI_MD, data: AI_DATA });
	let again = core.buildObsidianNote(note, data, { aiMarkdown: AI_MD, study: Object.assign({}, AI_DATA, { appraisal_overall: "排除" }), appraisalMarkdown: ai.markdown, appraisal: ai.values });
	assert.match(again, /\nappraisal_tool: "JBI Checklist for Randomized Controlled Trials"\n/);
	assert.match(again, /\nappraisal_overall: "排除"\n/);
	assert.match(again, /\nappraisal_verified: false\n/);
	assert.equal(again.match(/\[!example\]- 文獻評讀表/g).length, 1);
	assert.match(again, /\[!warning\] AI 初評，尚未核對/);
	let none = core.buildObsidianNote(again, data, { aiMarkdown: "## 一句話摘要\nx" });
	assert.doesNotMatch(none, /## 文獻評讀表/);
	assert.doesNotMatch(none, /appraisal_verified/, "no form, no key");
	assert.deepEqual(core.appraisalFrontmatter(null), {});
	assert.deepEqual(core.appraisalFrontmatter({ verified: false, tool: "x", overall: "排除" }), { appraisal_verified: false });
});

test("Notion: Appraisal Verified checkbox; the verified form's tool and verdict; the table as a real table block", async () => {
	let schema = { titleName: "Name", props: { Name: "title", "Appraisal Tool": "select", Appraisal: "select", "Appraisal Verified": "checkbox" } };
	let study = AI_DATA;
	let p = notion.buildProperties(schema, { title: "T", study, appraisal: { verified: true, tool: "CASP Checklist, RCT", overall: "排除" } });
	assert.deepEqual(p["Appraisal Tool"], { select: { name: "CASP Checklist， RCT" } });
	assert.deepEqual(p.Appraisal, { select: { name: "排除" } });
	assert.deepEqual(p["Appraisal Verified"], { checkbox: true });
	let unverified = notion.buildProperties(schema, { title: "T", study, appraisal: { verified: false, tool: "x", overall: "排除" } });
	assert.deepEqual(unverified["Appraisal Tool"], { select: { name: "JBI Checklist for Randomized Controlled Trials" } });
	assert.deepEqual(unverified["Appraisal Verified"], { checkbox: false });
	assert.deepEqual(notion.buildProperties(schema, { title: "T" })["Appraisal Verified"], { checkbox: false });
	assert.deepEqual(notion.PROPERTY_SCHEMA["Appraisal Verified"], { checkbox: {} });

	// The table goes right after the status callout under the heading
	let info = form.syncInfo({ appraisalNote: { html: form.noteHTML(verifiedRecord()) } }, null);
	let blocks = markdown.mdToNotionBlocks(info.notionMarkdown);
	assert.equal(blocks[0].type, "heading_2");
	assert.equal(blocks[1].type, "quote");
	let calls = [];
	let children = blocks.map((b, i) => Object.assign({ id: `b${i}` }, JSON.parse(JSON.stringify(b))));
	for (let b of children) for (let r of b[b.type].rich_text || []) r.plain_text = r.text.content;
	let client = {
		listChildren: async (id) => {
			calls.push(["list", id]);
			return [{ id: "x0", type: "paragraph", paragraph: { rich_text: [{ plain_text: "書目" }] } }, ...children];
		},
		appendChildren: async (id, kids, placement) => {
			calls.push(["append", id, kids, placement]);
			return [];
		},
	};
	await form.insertNotionTable(client, "container-1", info, []);
	assert.equal(calls[1][1], "container-1");
	assert.deepEqual(calls[1][3], { after: "b1" });
	let table = calls[1][2][0];
	assert.equal(table.type, "table");
	assert.equal(table.table.table_width, 3);
	assert.equal(table.table.has_column_header, true);
	assert.equal(table.table.children.length, 14);
	assert.equal(table.table.children[2].table_row.cells[2][0].text.content, "電腦亂數 | 區塊");
	// `after` rejected: appended at the end; a failing listing is reported, not thrown
	calls = [];
	let messages = [];
	client.appendChildren = async (id, kids, placement) => {
		calls.push(placement);
		if (placement) throw new Error("400 after");
		return [];
	};
	await form.insertNotionTable(client, "container-1", info, messages);
	assert.deepEqual(calls.filter(c => !Array.isArray(c)), [{ after: "b1" }, undefined]);
	client.listChildren = async () => {
		throw new Error("Notion API 500");
	};
	await form.insertNotionTable(client, "container-1", info, messages);
	assert.deepEqual(messages, ["⚠️ Notion 文獻評讀表：Notion API 500"]);
});

test("EBHC and screening hooks: a verified form replaces the 嚴格評讀 section and the tool/verdict; unverified changes nothing", () => {
	let html = form.noteHTML(verifiedRecord());
	let src = { data: { appraisalNote: { html } }, aiMarkdown: AI_MD, study: AI_DATA };
	form.applyToSource(src);
	assert.equal(src.appraisalVerified, true);
	assert.match(src.aiMarkdown, /## 嚴格評讀\n- 評讀工具：CASP Checklist: For Randomised Controlled Trials \(RCTs\) \(2024\)（研究者已逐題核對，2026-10-08）\n\n\| 評讀項目 \| 評讀結果 \| 評析根據 \|/);
	assert.match(src.aiMarkdown, /- 整體評價：納入 — 整體可信\n\n## 證據等級\nLevel 2$/);
	assert.doesNotMatch(src.aiMarkdown, /JBI Checklist/);
	assert.match(src.aiMarkdown, /^## 一句話摘要/);
	assert.equal(src.study.appraisal_tool, tools.getTool("casp-rct").name);
	assert.equal(src.study.sample_size, 120);
	assert.equal(AI_DATA.appraisal_tool, "JBI Checklist for Randomized Controlled Trials", "the AI data is not mutated");

	let unverified = tools.normalizeRecord(Object.assign({}, verifiedRecord(), { verified: false }));
	let src2 = { data: { appraisalNote: { html: form.noteHTML(unverified) } }, aiMarkdown: AI_MD, study: AI_DATA };
	form.applyToSource(src2);
	assert.equal(src2.aiMarkdown, AI_MD);
	assert.equal(src2.study, AI_DATA);
	assert.equal(form.overrideStudy(null, verifiedRecord()), null);
	// A note without the section gets one at the end
	assert.match(form.replaceAppraisalSection("## 主要結果\nx", "## 嚴格評讀\ny"), /^## 主要結果\nx\n\n## 嚴格評讀\ny$/);
});

test("collection summary: counts, traffic lights per tool, per-study tables, kappa with formula, CSV and Word version", () => {
	let rec1 = verifiedRecord();
	let rec2 = form.prefill(AI_MD, AI_DATA);
	let entries = [
		{ citation: "Chen, 2024", title: "Fall prevention RCT", link: "Zotero/chen2024", record: rec1, source: "form" },
		{ citation: "Lee, 2021", title: "Falls", link: "", record: rec2, source: "ai" },
		{ citation: "Wu, 2020", title: "Nothing", link: "", record: null, source: "none" },
	];
	let paths = form.summaryPaths(["Zotero", "Reviews"], "跌倒實證 評讀總表");
	assert.deepEqual(paths, {
		dirParts: ["Zotero", "Reviews"], note: "跌倒實證 評讀總表.md", csv: "跌倒實證 評讀總表.csv", word: "跌倒實證 評讀總表（Word）.md",
		docx: "跌倒實證 評讀總表.docx", command: "pandoc \"跌倒實證 評讀總表（Word）.md\" -o \"跌倒實證 評讀總表.docx\"",
	});
	let meta = { name: "跌倒實證", generatedAt: "2026-10-08T00:00:00Z", uri: "zotero://select/library/collections/C1", title: "跌倒實證：文獻評讀總表", paths, collectionKey: "1/C1" };
	assert.deepEqual(form.counts(entries), { total: 3, appraised: 2, verified: 1, unverified: 1, none: 1, verdicts: { 納入: 2, 排除: 0, 需更多資訊: 0 } });

	let body = form.summaryBody(entries, meta);
	assert.match(body, /^> \[!info\] 由 Zotero Bridge 依分類「跌倒實證」的 3 篇文獻於 2026-10-08 產生/);
	assert.match(body, /\| 已核對（研究者確認） \| 1 \|\n\| 尚未核對（AI 初評或評讀中） \| 1 \|\n\| 沒有評讀資料 \| 1 \|/);
	assert.match(body, /### CASP Checklist: For Randomised Controlled Trials \(RCTs\) \(2024\)（1 篇）\n\n\| 文獻 \| 1 \| 2 \| 3 \| 4a \| 4b \| 4c \| 5 \|/);
	assert.match(body, /\| \[\[Zotero\/chen2024\\\|Chen, 2024\]\] \| ✅ \| ✅ \| ❌ \| ❌ \| ⬜ /);
	assert.match(body, /### JBI Critical Appraisal Tool[^\n]*（1 篇）\n\n[^\n]*\n[^\n]*\n\| Lee, 2021 \| ✅ \| ❓ \| ✅ \| ⬜ /);
	assert.match(body, /> \[!note\]- 題號對照\n> 1 = 研究是否針對一個明確聚焦的問題（PICO）？；2 = /);
	assert.match(body, /### \[\[Zotero\/chen2024\\\|Chen, 2024\]\]\n\n> \[!success\] 已核對（2026-10-08）｜評讀工具：CASP/);
	assert.match(body, /### Lee, 2021\n\n> \[!warning\] AI 初評，尚未核對｜/);
	assert.match(body, /## 雙人評讀一致性（Cohen's κ）\n\nCohen's κ = \(p_o − p_e\) ÷ \(1 − p_e\)/);
	// Chen: A = 是 是 否 否, B = 是 否 否 否 → p_o .75, p_e = .5·.25 + .5·.75 = .5, κ = .5
	assert.match(body, /\| \[\[Zotero\/chen2024\\\|Chen, 2024\]\] \| CASP[^|]* \| 4 \| 3 \| 75% \| 0\.50 \| 中等一致 \|/);
	assert.match(body, /\| \*\*合計\*\* \| {2}\| 4 \| 3 \| 75% \| 0\.50 \| 中等一致 \|/);
	assert.match(body, /### 不一致的題目\n\n- \[\[Zotero\/chen2024\\\|Chen, 2024\]\]：2\. 受試者是否被隨機分派到各介入組？（A 是／B 否）/);
	assert.match(body, /## 沒有評讀資料的文獻\n\n- Wu, 2020/);
	assert.match(body, /## Pandoc 指令[\s\S]*```bash\npandoc "跌倒實證 評讀總表（Word）\.md" -o "跌倒實證 評讀總表\.docx"\n```/);

	let word = form.wordDocument(entries, meta);
	assert.match(word, /^# 跌倒實證：文獻評讀總表\n\n依 Zotero 分類「跌倒實證」的 3 篇文獻產生/);
	assert.doesNotMatch(word, /\[!|\[\[|✅|⬜|%%|Pandoc 指令/);
	assert.match(word, /\| Chen, 2024 \| ✓ \| ✓ \| ✗ \| ✗ \| {3}\|/);
	assert.match(word, /題號：1 = /);

	let csv = form.summaryCSV(entries).split("\r\n");
	assert.equal(csv[0], "﻿文獻,標題,評讀工具,題號,評讀項目,評讀結果,評析根據,評讀者B,整體評價,核對狀態,核對日期");
	assert.equal(csv.length, 1 + 13 + 13 + 1 + 1);
	assert.match(csv[2], /^"Chen, 2024",Fall prevention RCT,CASP Checklist: For Randomised Controlled Trials \(RCTs\) \(2024\),2,受試者是否被隨機分派到各介入組？,是,電腦亂數 \| 區塊,否,納入,已核對（2026-10-08）,2026-10-08$/);
	assert.match(csv[27], /^"Wu, 2020",Nothing,,,,,,,,沒有評讀資料,$/);

	let fm = form.summaryFrontmatter(entries, meta);
	assert.equal(fm.appraisal_csv, "Zotero/Reviews/跌倒實證 評讀總表.csv");
	let note = form.buildSummaryNote(null, fm, meta.title, body);
	assert.match(note, /^---\ntitle: "跌倒實證：文獻評讀總表"\ntype: "appraisal-summary"\nzotero_collection: "1\/C1"/);
	assert.match(note, /\ntags:\n {2}- "文獻評讀"\n---\n\n# 跌倒實證：文獻評讀總表\n\n%% zotero-bridge:start/);
	// Re-generating keeps the user's text
	let edited = note.replace("## ✍️ 我的筆記\n\n", "## ✍️ 我的筆記\n\n老師的意見。\n").replace("# 跌倒實證：文獻評讀總表\n", "# 跌倒實證：文獻評讀總表\n\n前言。\n");
	let again = form.buildSummaryNote(edited, Object.assign({}, fm, { studies: 4 }), meta.title, "新內容");
	assert.match(again, /前言。\n\n%% zotero-bridge:start[^\n]*%%\n\n新內容\n\n%% zotero-bridge:end %%/);
	assert.match(again, /老師的意見。/);
	assert.match(again, /\nstudies: 4\n/);
	// Nothing appraised yet
	assert.match(form.summaryBody([entries[2]], meta), /（還沒有任何評讀資料）/);
});
