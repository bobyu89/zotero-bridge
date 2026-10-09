// Evidence-based health care report (content/ebhc-report.js): PICO and search prefill, evidence table,
// prompt, number check, citations, EBHC checks, scoring self-check, Obsidian note and Pandoc
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { JSDOM } = require("jsdom");
const eb = require("../content/ebhc-report.js");
const rd = require("../content/review-draft.js");
const scr = require("../content/screening.js");
const { sampleItem } = require("./fixtures.cjs");

const RCT_STUDY = {
	study_design: "RCT", sample_size: 120, population: "65 歲以上住院病人", intervention: "護理師主導跌倒預防衛教",
	comparison: "常規照護", outcomes: "跌倒發生率", evidence_level: "2", jbi_level: "1.c",
	appraisal_tool: "JBI Checklist for Randomized Controlled Trials", appraisal_overall: "納入", measures: [],
};
const SR_STUDY = {
	study_design: "meta-analysis", sample_size: 2400, population: "65歲以上住院病人 ", intervention: "跌倒預防衛教",
	comparison: "常規照護", outcomes: "跌倒發生率", evidence_level: "1",
	appraisal_tool: "CASP Systematic Review Checklist", appraisal_overall: "納入", measures: [],
};

const RCT_NOTE = `## 一句話摘要
護理師主導衛教使跌倒率降低 30%。

## 主要結果
介入組跌倒率降低 30%（OR = 0.45, 95% CI 0.30–0.68, p = .002）。

## 嚴格評讀
- 評讀工具：JBI Checklist for Randomized Controlled Trials
1. 是否真正隨機分派：是 — 電腦亂數分派。
- 整體評價：納入 — 品質良好。

## 證據等級
Oxford CEBM 2011 Level 2。

## 關鍵概念
[[Fall prevention]]`;

const chen = sampleItem();
const wang = sampleItem({
	key: "WANG0001", title: "Fall prevention education for inpatients: a meta-analysis", year: "2022", citationKey: "wang2022fall",
	creators: [{ lastName: "Wang", firstName: "Li", creatorType: "author" }], abstract: "Pooled RR = 0.72 (95% CI 0.61–0.85; I² = 41%).",
	apa: "Wang, L. (2022). Fall prevention education for inpatients. Nursing Research.", attachments: [],
});
const lin = sampleItem({
	key: "LIN00001", title: "住院病人跌倒預防衛教之成效", year: "2023", citationKey: "lin2023", language: "zh-TW",
	creators: [{ lastName: "林", firstName: "小華", creatorType: "author" }], abstract: "", attachments: [],
	apa: "林小華（2023）。住院病人跌倒預防衛教之成效。護理雜誌，70(2)，45–56。",
	apaMarkdown: "林小華（2023）。住院病人跌倒預防衛教之成效。*護理雜誌，70*(2)，45–56。",
});

function sources() {
	return [
		{ data: chen, aiMarkdown: RCT_NOTE, study: RCT_STUDY },
		{ data: lin, aiMarkdown: "", study: null },
		{ data: wang, aiMarkdown: "## 一句話摘要\n統合分析顯示衛教降低跌倒風險。", study: SR_STUDY },
	];
}

const ANSWER = {
	scenario: "78 歲陳先生因肺炎住院，夜間曾跌倒一次。病人問：「我晚上起來上廁所，要怎麼做才不會再跌倒？」",
	population: "65 歲以上住院病人", intervention: "跌倒預防衛教", comparison: "常規照護", outcomes: "跌倒發生率",
	questionType: "therapy", databases: "Cochrane Library（n = 12）、PubMed（n = 80）", query: "(fall) AND (education)",
	limits: "2015–2025 年", searchDate: "2026 年 9 月 30 日", screening: "",
};

test("PICO prefill: only fields every study agrees on (ignoring case, spaces, punctuation)", () => {
	let r = eb.picoPrefill([RCT_STUDY, SR_STUDY, null]);
	assert.equal(r.fields.population, "65 歲以上住院病人");
	assert.equal(r.consistent.population, true);
	assert.equal(r.fields.comparison, "常規照護");
	assert.equal(r.fields.outcomes, "跌倒發生率");
	assert.equal(r.fields.intervention, "");
	assert.equal(r.consistent.intervention, false);
	assert.deepEqual(r.variants.intervention, ["護理師主導跌倒預防衛教", "跌倒預防衛教"]);
	let none = eb.picoPrefill([null, {}]);
	assert.deepEqual(none.fields, { population: "", intervention: "", comparison: "", outcomes: "" });
	assert.equal(eb.guessQuestionType([{ study_design: "qualitative" }, null]), "qualitative");
	assert.equal(eb.guessQuestionType([{ study_design: "qualitative" }, RCT_STUDY]), "therapy");
	assert.equal(eb.guessQuestionType([]), "therapy");
});

test("sources are ordered by CEBM level, then design, newest first", () => {
	let ordered = eb.orderSources(sources());
	assert.deepEqual(ordered.map(s => s.data.key), ["WANG0001", "ABCD1234", "LIN00001"]);
});

test("evidence table and summary come from the structured data, not the model", () => {
	let src = eb.orderSources(sources());
	let p = eb.buildEbhcPrompt(src, { answer: ANSWER });
	let rows = eb.evidenceRows(src, p.entries);
	assert.deepEqual(rows.map(r => [r.id, r.design, r.n, r.level]), [["S1", "meta-analysis", 2400, "1"], ["S2", "RCT", 120, "2"], ["S3", "", null, ""]]);
	let table = eb.evidenceTable(rows);
	assert.equal(table.split("\n")[0], "| 文獻 | 研究設計 | 樣本數（N） | 證據等級（Oxford CEBM 2011） | 評讀工具 | 整體評讀 | 主要發現（AI 筆記一句話摘要） |");
	assert.match(table, /\n\| \[S1\] \| 系統性回顧與統合分析 \| 2400 \| Level 1 \| CASP Systematic Review Checklist \| 納入 \| 統合分析顯示衛教降低跌倒風險。 \|/);
	assert.match(table, /\n\| \[S2\] \| 隨機對照試驗（RCT） \| 120 \| Level 2 \| JBI Checklist for Randomized Controlled Trials \| 納入 \| 護理師主導衛教使跌倒率降低 30%。 \|/);
	assert.match(table, /\n\| \[S3\] \| （無結構化資料） \| 未報告 \| 未判定 \| （未評讀） \| — \| （沒有 AI 筆記） \|$/);
	assert.equal(eb.evidenceSummary(rows), "納入 3 篇：系統性回顧與統合分析 1 篇、隨機對照試驗（RCT） 1 篇、未報告設計 1 篇；原始研究樣本數合計 120 人（1 篇有報告樣本數，1 篇未報告）；系統性回顧的合併樣本可能已包含其他納入的原始研究，請勿直接相加。");
});

let nextID = 1;
function rec(tags, extra = {}) {
	let id = nextID++;
	return Object.assign({ id, key: `K${id}`, title: `Paper ${id}`, year: "2024", tags, catalog: "", creators: [] }, extra);
}

test("search prefill: PRISMA counts from the screening tags, a PubMed watch's query, or a PICO search string", () => {
	let records = [
		rec(["篩選/全文/納入", "來源/PubMed"]),
		rec(["篩選/全文/排除", "排除原因/族群不符（wrong population）", "來源/PubMed"]),
		rec(["篩選/標題摘要/排除", "來源/CINAHL"]),
		rec(["篩選/重複", "來源/CINAHL"]),
		rec(["篩選/全文/納入", "來源/Cochrane"]),
	];
	let prisma = scr.computePrisma(records, scr.normalizeConfig({}));
	let fromPrisma = eb.searchPrefill({ prisma, watches: [], pico: {} });
	assert.equal(fromPrisma.databases, "CINAHL（n = 2）、PubMed（n = 2）、Cochrane（n = 1）");
	assert.equal(fromPrisma.screening, "資料庫與登錄庫共搜尋 5 篇（CINAHL（n = 2）、PubMed（n = 2）、Cochrane（n = 1）），排除重複文獻 1 篇，閱讀標題與摘要篩選 4 篇，排除 1 篇，全文評估 3 篇，排除 1 篇（族群不符（wrong population） 1 篇），最後納入 2 篇進行評讀。");
	assert.equal(fromPrisma.query, "");

	let watches = [{ name: "跌倒", query: "falls[Mesh] AND education", since: "2020/01/01", collection: "📥 新文獻/跌倒" }];
	let fromWatch = eb.searchPrefill({ prisma: null, watches, pico: {} });
	assert.equal(fromWatch.databases, "PubMed");
	assert.equal(fromWatch.query, "(falls[Mesh] AND education) AND (\"2020/01/01\"[dp] : \"3000\"[dp])");
	assert.equal(fromWatch.queryNote, "PubMed 追蹤「跌倒」的檢索式");
	assert.equal(fromWatch.limits, "出版日期：2020/01/01 起（PubMed 追蹤設定）");

	let fromPico = eb.searchPrefill({ pico: { population: "older adults 住院病人", intervention: "fall prevention education", outcomes: "falls" } });
	assert.equal(fromPico.query, "\"older adults\" AND \"fall prevention education\" AND falls");
	assert.match(fromPico.queryNote, /尚未實際檢索/);
	assert.deepEqual(eb.searchPrefill({}), { databases: "", query: "", queryNote: "", limits: "", searchDate: "", screening: "" });

	// Which watches belong to a collection: the same path, or their 追蹤/ tag on its items
	let all = [{ name: "跌倒", collection: "📥 新文獻/跌倒" }, { name: "壓傷", collection: "📥 新文獻/壓傷" }, { name: "疼痛", collection: "x" }];
	assert.deepEqual(eb.matchWatches(all, "📥 新文獻/跌倒", ["追蹤/疼痛"]).map(w => w.name), ["跌倒", "疼痛"]);
	assert.deepEqual(eb.matchWatches(all, "", []), []);
});

test("dialog values: saved answers win, except the live PRISMA summary", () => {
	let derived = { population: "P1", databases: "PubMed（n = 2）", screening: "最後納入 2 篇進行評讀。", questionType: "qualitative", prismaLive: true };
	let init = eb.dialogInit({ population: "我的 P", screening: "舊的", databases: "", questionType: "bogus" }, derived);
	assert.equal(init.population, "我的 P");
	assert.equal(init.databases, "PubMed（n = 2）");
	assert.equal(init.screening, "最後納入 2 篇進行評讀。");
	assert.equal(init.questionType, "therapy");
	assert.equal(eb.dialogInit({}, Object.assign({}, derived, { prismaLive: false })).questionType, "qualitative");
	assert.equal(eb.dialogInit({ screening: "舊的" }, { screening: "", prismaLive: false }).screening, "舊的");
});

test("the prompt: [S#] labels, study data, the appraisal kept up front, scenario, PICO, CEBM column and search", () => {
	let src = eb.orderSources(sources());
	let p = eb.buildEbhcPrompt(src, { answer: Object.assign({}, ANSWER, { questionType: "prognosis" }), evidenceSummary: "納入 3 篇。" });
	assert.match(p.system, /^你是臺灣護理實證健康照護（EBHC）的寫作助理/);
	assert.match(p.system, /引用只能使用提供的代號 \[S1\]/);
	assert.match(p.system, /病人說的話只能引用使用者提供的案例情境原文/);
	assert.deepEqual(p.entries.map(e => [e.id, e.citekey]), [["S1", "wang2022fall"], ["S2", "chen2024effects"], ["S3", "lin2023"]]);
	let s2 = /<source id="S2">[\s\S]*?<\/source>/.exec(p.user)[0];
	assert.match(s2, /<study_data>\n研究設計：RCT\n樣本數：120/);
	assert.match(s2, /<appraisal_from_ai_note>\n## 嚴格評讀\n- 評讀工具：JBI Checklist for Randomized Controlled Trials[\s\S]*## 證據等級\nOxford CEBM 2011 Level 2。\n<\/appraisal_from_ai_note>/);
	let note = /<ai_note>\n([\s\S]*?)\n<\/ai_note>/.exec(s2)[1];
	assert.doesNotMatch(note, /嚴格評讀|證據等級/, "the appraisal is not sent twice");
	assert.match(note, /## 主要結果/);
	assert.match(p.user, /<clinical_scenario>\n78 歲陳先生[\s\S]*「我晚上起來上廁所/);
	assert.match(p.user, /<pico>\n問題類型：預後（Prognosis）\nP（族群／問題（Patient／Problem））：65 歲以上住院病人\n/);
	assert.match(p.user, /<cebm_2011>\n預後（What will happen/);
	assert.match(p.user, /<search_summary>\n資料庫：Cochrane Library（n = 12）、PubMed（n = 80）\n檢索式：\(fall\) AND \(education\)/);
	assert.match(p.user, /<evidence_summary>\n納入 3 篇。\n<\/evidence_summary>/);
	assert.match(p.user, /請依照系統指示的標題與順序撰寫實證健康照護報告草稿。$/);
	assert.equal(eb.takeSection("## A\nx\n### A1\ny\n## B\nz", "A").section, "## A\nx\n### A1\ny");
	assert.equal(eb.takeSection("## A\nx", "C").section, "");
});

const MODEL_OUT = `# 實證報告

## 題目
住院高齡病人接受跌倒預防衛教是否能降低跌倒？
Does Fall Prevention Education Reduce Falls in Older Inpatients?

## 中文摘要
**形成臨床提問**：病人擔心夜間再跌倒。
**文獻搜尋的方法與分析**：搜尋 Cochrane Library 與 PubMed，最後納入 3 篇共 4321 位病人。
**文獻的品質評讀**：統合分析 RR = 0.72，跌倒率降低 30%，另一數字 0.99。
**結論與建議**：建議衛教。
關鍵詞：跌倒、衛教、住院病人

## 英文摘要
**Ask an answerable question (PICO)**: Falls.

## 前言
臨床上病人問：「我晚上起來上廁所，要怎麼做才不會再跌倒？」因而引發作者動機。住院跌倒盛行率為 〔待補：盛行率與臨床負擔的統計數據及出處〕。

## 形成臨床提問
78 歲陳先生住院中，依據實證護理五大步驟，形成一個可回答的問題。

## 文獻的品質評讀
評讀工具依各篇 AI 筆記。

### [S1] 系統性回顧與統合分析
| 評讀項目 | 評讀結果 | 評析根據 |
|---|---|---|
| 結果是否一致 | 是 | I² = 41%，異質性中等 |
**主要研究成果**：RR = 0.72，95% CI 0.61–0.85。

### [S2] 隨機對照試驗
**主要研究成果**：OR = 0.45，95% CI 0.30–0.68，p = .002；追蹤 18 個月共 333 人。

## 證據綜整
兩篇結果一致 [S1, S2]，另一篇研究的效果為 0.5 [S7]。

## 臨床應用
建議由受訓護理師於入院 24 小時內衛教 [S2]。

## 結論與建議
故本文臨床建議可教導病人夜間如廁前按鈴 [S2]。

## 參考文獻
- Chen (2024)
`;

function processed(answer = ANSWER, extra = {}) {
	let src = eb.orderSources(sources());
	let p = eb.buildEbhcPrompt(src, { answer });
	let rows = eb.evidenceRows(src, p.entries);
	let texts = new Map(src.map((s, i) => [p.entries[i].id, rd.sourceText(s)]));
	let report = eb.processReport(extra.text || MODEL_OUT, p.entries, texts, Object.assign({
		answer, rows, prisma: null, search: null, withoutAI: ["林小華，2023"],
		contextText: [answer.scenario, answer.databases, "最後納入 3 篇進行評讀。"].join("\n"),
	}, extra.ctx || {}));
	return { src, p, rows, report };
}

test("model output: sections, number check (abstract vs. all sources, heading citations, user's numbers), unknown labels", () => {
	let { p, report } = processed();
	assert.equal(report.sections.title.split("\n")[0], "住院高齡病人接受跌倒預防衛教是否能降低跌倒？");
	assert.match(report.sections.appraisal, /^評讀工具依各篇 AI 筆記。/);
	assert.doesNotMatch(report.sections.conclusion, /參考文獻|Chen \(2024\)/, "the model's reference list is dropped");
	assert.deepEqual(report.missingSections, []);
	assert.deepEqual(report.missingAppraisal.map(e => e.id), ["S3"]);
	assert.deepEqual(report.issues.unknown, ["S7"]);
	let nums = report.issues.numbers.map(f => [f.sentence.slice(0, 14), f.missing, f.ids]);
	// Abstract: 4321 is not in any source; 0.72 and 30% are (S1 abstract, S2 note); 0.99 is not
	assert.deepEqual(nums.find(n => n[1].includes("4321")), ["**文獻搜尋的方法與分析**", ["4321"], ["S1", "S2", "S3"]]);
	assert.deepEqual(nums.find(n => n[1].includes("0.99"))[1], ["0.99"]);
	assert.ok(!nums.some(n => n[1].includes("78")), "the scenario's age comes from the user");
	// Under "### [S2]": 0.45 / 0.30 / .002 are in S2's note, 18 and 333 are not
	assert.ok(nums.some(n => n[1].join() === "18,333" && n[2].join() === "S2"), JSON.stringify(nums));
	// The table row under "### [S1]" is checked against S1: I² = 41% is in its abstract
	assert.ok(!nums.some(n => n[1].includes("41%")), JSON.stringify(nums));
	assert.ok(nums.some(n => n[1].includes("0.5")), "the unknown source's number has nothing to check against");
	assert.equal(eb.propagateHeadingCitations("### [S1] x\na 30%\n\n| r |\n### y\nb"), "### [S1] x\na 30% [S1]\n\n| r | [S1]\n### y\nb");
	assert.equal(p.entries.length, 3);
});

test("citations: Pandoc keys in the body and evidence table, in-text in headings; plain text for Notion", () => {
	let { p, rows, report } = processed();
	let body = eb.assembleBody({ report, answer: ANSWER, rows, search: null, prisma: null });
	assert.match(body, /^## 題目\n\n住院高齡病人/);
	assert.match(body, /## 方法\n\n### 一、形成臨床提問（PICO）\n\n78 歲陳先生/);
	assert.match(body, /### 三、文獻的品質評讀\n\n\*\*表二　納入文獻證據表\*\*/);
	assert.match(body, /\n#### \[S1\] 系統性回顧與統合分析\n/, "the model's ### become ####");
	let pandoc = eb.toPandoc(body, p.entries);
	assert.match(pandoc, /\n#### @wang2022fall 系統性回顧與統合分析\n/);
	assert.match(pandoc, /\| \[@chen2024effects\] \| 隨機對照試驗（RCT） \| 120 \|/);
	assert.match(pandoc, /兩篇結果一致 \[@wang2022fall; @chen2024effects\]，另一篇研究的效果為 0\.5 【⚠️ 未知來源 S7】。/);
	assert.doesNotMatch(pandoc, /\[S\d/);
	let plain = eb.buildReportPlain(report, p.entries, { answer: ANSWER, rows, search: null, prisma: null, model: "m", generatedAt: "2026-10-08" });
	assert.match(plain, /兩篇結果一致 \(Wang, 2022; Chen & Smith, 2024\)/);
	assert.match(plain, /## 參考文獻\n\n- 林小華（2023）。住院病人跌倒預防衛教之成效。\*護理雜誌，70\*\(2\)，45–56。\n- Chen, M\./, "Chinese APA first");
	assert.doesNotMatch(plain, /@wang2022fall/);
});

test("EBHC checks and the scoring self-check map each criterion to its section", () => {
	let { report } = processed();
	let codes = report.checks.map(c => c.code);
	assert.ok(codes.includes("missingAppraisal"));
	assert.ok(codes.includes("tool"), "JBI instead of CASP");
	assert.ok(codes.includes("withoutAI"));
	assert.ok(codes.includes("noPrisma"));
	assert.ok(codes.includes("chineseRefs"));
	assert.ok(codes.includes("todos"));
	assert.ok(!codes.includes("noQuote"), "the scenario has the patient's words");
	assert.ok(!codes.includes("databases"), "Cochrane and PubMed are there");
	assert.ok(!codes.includes("noReview"));
	let tool = report.checks.find(c => c.code === "tool").text;
	assert.match(tool, /Chen & Smith, 2024 的 AI 筆記使用 JBI Checklist for Randomized Controlled Trials/);
	assert.doesNotMatch(tool, /Wang/);

	let other = processed(Object.assign({}, ANSWER, { scenario: "病人跌倒。", comparison: "", databases: "Embase", questionType: "prognosis" })).report;
	let codes2 = other.checks.map(c => c.code);
	assert.ok(codes2.includes("noQuote"));
	assert.ok(codes2.includes("pico"));
	assert.match(other.checks.find(c => c.code === "databases").text, /Cochrane Library、PubMed/);
	assert.ok(codes2.includes("cebmColumn"));

	let table = eb.scoringChecklist(report);
	assert.match(table, /^## 📋 評分項目自我檢核\n/);
	assert.match(table, /列出的項目合計 95 分/);
	assert.match(table, /\| 中英文題目（5 分） \| 題目 \| 中英文題目一致；以問句反映 PICO \| ✅ 草稿已涵蓋（仍需人工確認） \|/);
	assert.match(table, /\| 方法：文獻的品質評讀（25 分） \| 方法 三、文獻的品質評讀（含表二） \| .* \| ⚠️ 見查核清單 \|/);
	assert.match(table, /\| 方法：文獻搜尋的方法與分析（20 分） \| .* \| ⚠️ 見查核清單 \|/);
	assert.match(table, /\| 參考文獻（5 分） \| 參考文獻 \| .* \| ℹ️ 見查核清單 \|/);
	assert.doesNotMatch(table, /得分|總分：/, "not a score");
	assert.equal(eb.SCORING.reduce((n, s) => n + s.points, 0), 95);

	// A missing section is reported and gets a placeholder
	let partial = processed(ANSWER, { text: "## 題目\nA\nB\n\n## 前言\n內容" }).report;
	assert.deepEqual(partial.missingSections, ["abstractZh", "abstractEn", "question", "appraisal", "synthesis", "application", "conclusion"]);
	assert.match(eb.scoringChecklist(partial), /\| 摘要（13 分） \| .* \| ⚠️ 見查核清單 \|/);
});

test("the Obsidian note: frontmatter type ebhc-report, managed region, PRISMA figure, checklist; re-run keeps the user's text", () => {
	let { p, rows, report } = processed();
	let prisma = scr.computePrisma([rec(["篩選/全文/納入", "來源/PubMed"]), rec(["篩選/標題摘要/排除", "來源/PubMed"])], scr.normalizeConfig({}));
	let paths = eb.reportPaths(["Zotero"], "跌倒");
	assert.equal(paths.relPath, "Zotero/Drafts/實證報告-跌倒.md");
	assert.equal(paths.command, "pandoc 實證報告-跌倒.md --citeproc --bibliography ../references.json --csl ../../apa.csl --lua-filter zotero-bridge-ebhc.lua -o 實證報告-跌倒.docx");
	let meta = {
		title: "實證報告：跌倒", scope: "跌倒", model: "test-model", generatedAt: "2026-10-08T00:00:00Z", answer: ANSWER, rows,
		search: { query: ANSWER.query, queryNote: "PubMed 追蹤「跌倒」的檢索式" }, prisma, paths, withoutAI: ["林小華，2023"],
	};
	let note = eb.buildReportNote(null, report, p.entries, meta);
	assert.match(note, /^---\ntype: "ebhc-report"\nscope: "跌倒"\nquestion_type: "therapy"\nsources:\n/);
	assert.match(note, /citekeys:\n {2}- "wang2022fall"\n {2}- "chen2024effects"\n {2}- "lin2023"\n/);
	assert.match(note, /\n# 實證報告：跌倒\n\n%% zotero-bridge:start/);
	assert.match(note, /- \*\*檢索式（布林邏輯 AND／OR）\*\*：PubMed 追蹤「跌倒」的檢索式\n\n```text\n\(fall\) AND \(education\)\n```/);
	assert.match(note, /資料庫與登錄庫共搜尋 2 篇（PubMed（n = 2））/);
	assert.match(note, /\*\*圖一　搜尋文獻及篩選流程圖（PRISMA 2020）\*\*\n\n```mermaid\nflowchart TD/);
	assert.match(note, /\| P：族群／問題（Patient／Problem） \| 65 歲以上住院病人 \| 〔待補〕 \| 〔待補〕 \| 〔待補〕 \|/);
	assert.match(note, /## 參考文獻\n\n::: \{#refs\}\n:::\n\n> \[!abstract\]- 引用對照/);
	assert.match(note, /> - `@lin2023`：林小華（2023）。住院病人跌倒預防衛教之成效。\*護理雜誌，70\*\(2\)，45–56。/);
	assert.match(note, /## ⚠️ 查核清單\n\n> \[!warning\] \d+ 項需要確認/);
	assert.match(note, /> - \*\*未知來源代號\*\*：S7/);
	assert.match(note, /## 📋 評分項目自我檢核/);
	assert.match(note, /## ✍️ 我的筆記\n\n$/);
	assert.doesNotMatch(note, /\[S\d/);

	let edited = note.replace("# 實證報告：跌倒\n", "# 實證報告：跌倒\n\n我的前言。\n").replace("## ✍️ 我的筆記\n\n", "## ✍️ 我的筆記\n\n老師建議。\n")
		.replace("model: \"test-model\"", "model: \"test-model\"\nstatus: \"撰寫中\"");
	let again = eb.buildReportNote(edited, report, p.entries, Object.assign({}, meta, { notionUrl: "https://www.notion.so/x" }));
	assert.match(again, /# 實證報告：跌倒\n\n我的前言。\n\n%% zotero-bridge:start/);
	assert.match(again, /老師建議。/);
	assert.match(again, /status: "撰寫中"/);
	assert.match(again, /notion: "https:\/\/www\.notion\.so\/x"/);
	assert.equal(again.match(/zotero-bridge:start/g).length, 1);
	// A report made as Zotero Bridge (≤ 0.10): rebuilt in place under the new name
	const asOld = text => text.split("ZotMax").join("Zotero Bridge");
	assert.match(asOld(edited), /此區塊由 Zotero Bridge 自動產生/);
	let fromOld = eb.buildReportNote(asOld(edited), report, p.entries, meta);
	assert.equal(fromOld.match(/zotero-bridge:start/g).length, 1);
	assert.match(fromOld, /# 實證報告：跌倒\n\n我的前言。\n\n%% zotero-bridge:start — 此區塊由 ZotMax 自動產生/);
	assert.match(fromOld, /老師建議。/);
	assert.doesNotMatch(fromOld, /Zotero Bridge/);
});

test("dialog: a modal <dialog> with the scenario, PICO, question type and search fields, or prompts as a fallback", async () => {
	let dom = new JSDOM("<!doctype html><body></body>");
	let win = dom.window;
	win.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
	win.HTMLDialogElement.prototype.close = function (rv) {
		this.removeAttribute("open");
		this.returnValue = rv || "";
		this.dispatchEvent(new win.Event("close"));
	};
	global.Zotero = { logError: (e) => { throw e; } };
	let init = Object.assign({}, ANSWER, { questionType: "diagnosis", name: "跌倒", count: 3, hints: { intervention: "各篇不一致，未自動帶入：A／B" } });
	let pending = eb.askOptions(win, init);
	let dialog = win.document.querySelector("dialog");
	assert.ok(dialog.open);
	assert.match(dialog.textContent, /實證健康照護報告草稿：跌倒（3 篇）/);
	assert.match(dialog.textContent, /各篇不一致，未自動帶入：A／B/);
	let areas = [...dialog.querySelectorAll("textarea")];
	assert.equal(areas.length, 10);
	assert.equal(areas[0].value, ANSWER.scenario);
	let select = dialog.querySelector("select");
	assert.equal(select.value, "diagnosis");
	assert.deepEqual([...select.options].map(o => o.value), ["therapy", "prognosis", "diagnosis", "etiology", "qualitative"]);
	areas[3].value = " 無 \r\n";
	select.value = "prognosis";
	[...dialog.querySelectorAll("button")].find(b => /下一步/.test(b.textContent)).click();
	let out = await pending;
	assert.equal(out.comparison, "無");
	assert.equal(out.questionType, "prognosis");
	assert.equal(out.databases, ANSWER.databases);
	assert.equal(win.document.querySelector("dialog"), null, "removed after closing");
	let cancelled = eb.askOptions(win, init);
	[...win.document.querySelectorAll("button")].find(b => b.textContent === "取消").click();
	assert.equal(await cancelled, null);

	// No modal dialogs: scenario, then P｜I｜C｜O, then the question type
	let answers = ["新情境", "P1｜I1｜｜O1"];
	global.Services = {
		prompt: {
			prompt: (w, title, text, value) => { value.value = answers.shift(); return true; },
			select: (w, title, text, list, selected) => { selected.value = 4; return true; },
		},
	};
	let fallback = await eb.askOptions({ document: { createElementNS: () => ({}) } }, init);
	assert.equal(fallback.scenario, "新情境");
	assert.deepEqual([fallback.population, fallback.intervention, fallback.comparison, fallback.outcomes], ["P1", "I1", "", "O1"]);
	assert.equal(fallback.questionType, "qualitative");
	assert.equal(fallback.query, ANSWER.query, "search fields keep their prefilled values");
	assert.equal(fallback.name, undefined);
	delete global.Services;
	delete global.Zotero;
});

let hasPandoc = false;
try {
	execFileSync("pandoc", ["--version"], { stdio: "ignore" });
	hasPandoc = true;
}
catch (e) {}

test("the report converts with pandoc --citeproc and the Lua filter", { skip: !hasPandoc && "pandoc is not installed" }, () => {
	let { p, rows, report } = processed();
	let prisma = scr.computePrisma([rec(["篩選/全文/納入", "來源/PubMed"])], scr.normalizeConfig({}));
	let vault = fs.mkdtempSync(path.join(os.tmpdir(), "zb-ebhc-"));
	let dir = path.join(vault, "Zotero", "Drafts");
	fs.mkdirSync(dir, { recursive: true });
	let paths = eb.reportPaths(["Zotero"], "跌倒");
	let meta = { title: "實證報告：跌倒", scope: "跌倒", model: "m", generatedAt: "2026-10-08", answer: ANSWER, rows, search: null, prisma, paths };
	fs.writeFileSync(path.join(dir, paths.fileName), eb.buildReportNote(null, report, p.entries, meta).replace("## ✍️ 我的筆記\n\n", "## ✍️ 我的筆記\n\n私人筆記內容\n"));
	fs.writeFileSync(path.join(dir, eb.FILTER_FILE), eb.PANDOC_FILTER);
	fs.writeFileSync(path.join(vault, "Zotero", "references.json"), JSON.stringify([
		{ id: "chen2024effects", type: "article-journal", title: "Effects", author: [{ family: "Chen", given: "Mei" }, { family: "Smith", given: "John" }], issued: { "date-parts": [[2024]] } },
		{ id: "wang2022fall", type: "article-journal", title: "Fall", author: [{ family: "Wang", given: "Li" }], issued: { "date-parts": [[2022]] } },
		{ id: "lin2023", type: "article-journal", title: "住院病人跌倒預防衛教之成效", author: [{ literal: "林小華" }], issued: { "date-parts": [[2023]] } },
	]));
	let args = paths.command.split(" ").slice(1).filter((a, i, all) => a !== "--csl" && all[i - 1] !== "--csl");
	let out = execFileSync("pandoc", [...args.slice(0, args.indexOf("-o")), "-t", "plain", "--wrap=none"], { cwd: dir, encoding: "utf8" });
	assert.match(out, /兩篇結果一致 \(Wang 2022; Chen and Smith 2024\)/);
	assert.match(out, /Wang \(2022\) 系統性回顧與統合分析/, "heading citation is in-text");
	assert.match(out, /〔圖一：請在 Obsidian 把 PRISMA 流程圖匯出成圖片後插入這裡〕/);
	assert.doesNotMatch(out, /flowchart|%%|查核清單|評分項目自我檢核|Pandoc 指令|引用對照|私人筆記|AI 產生的實證/);
	assert.match(out, /參考文獻\n\nChen, Mei, and John Smith\. 2024\./);
});
