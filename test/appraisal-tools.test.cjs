// 文獻評讀表 catalog (appraisal-tools.js): checklist integrity, design mapping, AI-note parsing,
// summary counts, Markdown/CSV/JSON output, Cohen's kappa and the traffic-light matrix.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const tools = require("../content/appraisal-tools.js");
const llm = require("../content/llm.js");

test("catalog: unique ids, required fields, expected item counts, official sources and licenses", () => {
	let ids = tools.TOOLS.map(t => t.id);
	assert.equal(new Set(ids).size, ids.length, "tool ids are unique");
	let expected = {
		"casp-rct": 13, "casp-sr": 10, "casp-cohort": 14, "casp-case-control": 12, "casp-qualitative": 10, "casp-diagnostic": 12,
		"jbi-rct": 13, "jbi-quasi": 9, "jbi-cohort": 11, "jbi-case-control": 10, "jbi-cross-sectional": 8, "jbi-prevalence": 9,
		"jbi-qualitative": 10, "jbi-sr": 11, "jbi-case-report": 8, "jbi-text-opinion": 6,
	};
	assert.deepEqual(Object.fromEntries(tools.TOOLS.map(t => [t.id, t.items.length])), expected);
	for (let t of tools.TOOLS) {
		assert.ok(["CASP", "JBI"].includes(t.family), t.id);
		assert.ok(t.name && t.nameZh && t.source && t.license, t.id);
		assert.match(t.source, /^https:\/\/(casp-uk\.net|jbi\.global)\//, t.id);
		assert.match(t.license, t.family === "CASP" ? /CC BY-NC-SA/ : /JBI/, t.id);
		assert.ok(Array.isArray(t.designs) && t.designs.length, t.id);
		assert.deepEqual(t.verdicts, ["納入", "排除", "需更多資訊"]);
		let itemIds = t.items.map(i => i.id);
		assert.equal(new Set(itemIds).size, itemIds.length, `${t.id}: item ids are unique`);
		for (let i of t.items) {
			assert.equal(typeof i.id, "string");
			assert.ok(i.text && i.textEn && i.hint, `${t.id} ${i.id}`);
			assert.match(i.text, /[？?]$/, `${t.id} ${i.id} is a question`);
		}
		// Items are numbered in order: 1, 2, 3, 4a, 4b, …
		let numbers = itemIds.map(id => parseInt(id, 10));
		assert.deepEqual(numbers, numbers.slice().sort((a, b) => a - b), t.id);
		assert.equal(numbers[0], 1, t.id);
	}
	// CASP RCT: four sections, blinding split into (a)–(c)
	let rct = tools.getTool("casp-rct");
	assert.deepEqual(rct.items.map(i => i.id), ["1", "2", "3", "4a", "4b", "4c", "5", "6", "7", "8", "9", "10", "11"]);
	assert.deepEqual([...new Set(rct.items.map(i => i.section[8]))], ["A", "B", "C", "D"]);
	assert.match(rct.name, /2024/);
	assert.match(tools.getTool("casp-sr").name, /2018/);
	assert.equal(tools.getTool("nope"), null);
});

test("catalog matches llm.js: answers, verdicts, study designs, and the JBI item counts of the AI prompt", () => {
	assert.deepEqual(tools.VERDICTS, llm.APPRAISAL_VERDICTS);
	assert.deepEqual(tools.DESIGNS, llm.STUDY_DESIGNS);
	assert.deepEqual(tools.ANSWERS, ["是", "否", "不清楚", "不適用"]);
	for (let design of llm.STUDY_DESIGNS) {
		assert.ok(tools.toolsForDesign(design).length >= 1, `${design} has a tool`);
	}
	// The counts the AI prompt states for each JBI checklist
	let prompt = llm.DEFAULT_SYSTEM_PROMPT;
	let counts = { "jbi-rct": /RCT（(\d+) 題）/, "jbi-quasi": /Quasi-experimental（(\d+) 題）/, "jbi-cohort": /Cohort（(\d+) 題）/,
		"jbi-case-control": /Case-control（(\d+) 題）/, "jbi-cross-sectional": /Analytical cross-sectional（(\d+) 題）/,
		"jbi-qualitative": /Qualitative（(\d+) 題）/, "jbi-sr": /Systematic review（(\d+) 題）/ };
	for (let [id, re] of Object.entries(counts)) assert.equal(tools.getTool(id).items.length, Number(re.exec(prompt)[1]), id);
	// CASP first (TWNA prefers CASP), then JBI
	assert.deepEqual(tools.toolsForDesign("RCT").map(t => t.id), ["casp-rct", "jbi-rct"]);
	assert.deepEqual(tools.toolsForDesign("meta-analysis").map(t => t.id), ["casp-sr", "jbi-sr"]);
	assert.deepEqual(tools.toolsForDesign("quasi-experimental").map(t => t.id), ["jbi-quasi"]);
	assert.deepEqual(tools.toolsForDesign("cross-sectional").map(t => t.id), ["jbi-cross-sectional", "jbi-prevalence"]);
	assert.deepEqual(tools.toolsForDesign("unknown design"), []);
});

test("findToolByName: AI notes' official names, loose wording, ids; null for tools not in the catalog", () => {
	let id = n => (tools.findToolByName(n) || {}).id || null;
	assert.equal(id("JBI Checklist for Randomized Controlled Trials"), "jbi-rct");
	assert.equal(id("JBI Critical Appraisal Checklist for Quasi-Experimental Studies"), "jbi-quasi");
	assert.equal(id("JBI Checklist for Analytical Cross Sectional Studies"), "jbi-cross-sectional");
	assert.equal(id("JBI Checklist for Systematic Reviews and Research Syntheses"), "jbi-sr");
	assert.equal(id("JBI Checklist for Prevalence Studies"), "jbi-prevalence");
	assert.equal(id("JBI Checklist for Case Control Studies"), "jbi-case-control");
	assert.equal(id("CASP Randomised Controlled Trial Checklist (2020)"), "casp-rct");
	assert.equal(id("CASP Systematic Review Checklist"), "casp-sr");
	assert.equal(id("Critical Appraisal Skills Programme cohort study checklist"), "casp-cohort");
	assert.equal(id("CASP qualitative checklist"), "casp-qualitative");
	assert.equal(id("Qualitative research checklist"), "jbi-qualitative", "no family: JBI");
	assert.equal(id("diagnostic accuracy checklist"), "casp-diagnostic", "no family and JBI has none: CASP");
	assert.equal(id("casp-sr"), "casp-sr");
	assert.equal(id(tools.getTool("jbi-rct").name), "jbi-rct");
	assert.equal(id("CASP 隨機對照試驗評讀表（2024 版）"), "casp-rct");
	assert.equal(id("MMAT 2018"), null);
	assert.equal(id("AGREE II"), null);
	assert.equal(id(""), null);
	assert.equal(id(null), null);
});

const AI_MD = `## 一句話摘要
衛教降低跌倒。

## 嚴格評讀
- 評讀工具：JBI Checklist for Randomized Controlled Trials
1. 是否真正隨機分派：是 — 以電腦亂數分派（p. 3）
2. 分派是否隱匿（allocation concealment）：不清楚 — 文中未說明
3. 各組基準期特性是否相似：**是**（兩組 p > .05）
4. 受試者是否對分組設盲：否 — 衛教無法盲化
5. 執行介入者是否設盲：否
6. 除介入外各組是否接受相同照護：Yes — 皆接受常規照護
7. 結果評估者是否設盲：Can't tell
8. 各組結果測量方式是否相同：是
9. 結果測量是否可信：是 — Morse Fall Scale
10. 追蹤是否完整：是 — 流失率 5%
11. 是否依原隨機分組分析：N/A — 無流失
12. 統計分析是否適當：是
13. 試驗設計是否適當：是
- 整體評價：納入 — 偏差風險低

## 證據等級
Level 2`;

test("parseAIAppraisal: tool, per-item answers and reasons, overall verdict; answersFromAI maps by position", () => {
	let p = tools.parseAIAppraisal(AI_MD);
	assert.equal(p.toolName, "JBI Checklist for Randomized Controlled Trials");
	assert.equal(p.tool.id, "jbi-rct");
	assert.equal(p.items.length, 13);
	assert.deepEqual(p.items.map(i => i.answer), ["是", "不清楚", "是", "否", "否", "是", "不清楚", "是", "是", "是", "不適用", "是", "是"]);
	assert.equal(p.items[0].note, "以電腦亂數分派（p. 3）");
	assert.equal(p.items[1].text, "分派是否隱匿（allocation concealment）");
	assert.equal(p.items[4].note, "");
	assert.equal(p.overall, "納入");
	assert.equal(p.overallNote, "偏差風險低");

	let a = tools.answersFromAI(p, "jbi-rct");
	assert.deepEqual(a["1"], { answer: "是", note: "以電腦亂數分派（p. 3）", source: "ai" });
	assert.equal(Object.keys(a).length, 13);
	// Another tool: nothing is prefilled
	assert.deepEqual(tools.answersFromAI(p, "casp-rct"), {});
	// No section: empty
	assert.deepEqual(tools.parseAIAppraisal("## 主要結果\n…"), { toolName: "", tool: null, items: [], overall: "", overallNote: "" });
});

test("parseAIAppraisal: CASP sections that restart the numbering, sub-items 4a–4c, and missing items", () => {
	let md = [
		"## 嚴格評讀", "- 評讀工具：CASP Randomised Controlled Trial Checklist", "**Section A**",
		"1. 問題是否明確：是", "2. 是否隨機分派：是 — 區塊隨機", "3. 受試者是否都被交代：否 — 流失 25%",
		"**Section B**", "1. 4(a) 受試者是否設盲：否", "4b. 研究人員是否設盲：不清楚", "4c. 評估者是否設盲：是", "5. 基準期是否相似：是",
		"- 整體評價：需更多資訊",
	].join("\n");
	let p = tools.parseAIAppraisal(md);
	assert.equal(p.tool.id, "casp-rct");
	assert.deepEqual(p.items.map(i => i.id), ["1", "2", "3", "4", "4b", "4c", "5"]);
	let a = tools.answersFromAI(p, "casp-rct");
	// By item number (7 ≠ 13 items): "4" matches none of 4a–4c and stays empty
	assert.deepEqual(Object.keys(a).sort(), ["1", "2", "3", "4b", "4c", "5"]);
	assert.equal(a["3"].note, "流失 25%");
	assert.equal(p.overall, "需更多資訊");
});

test("summarize and describeSummary: counts over scored items, open items left out, % yes of applicable answers", () => {
	let s = tools.summarize("casp-sr", { 1: "是", 2: { answer: "否", note: "x" }, 3: "不適用", 6: { answer: "", note: "OR = 2.1" }, 99: "是" });
	assert.deepEqual(s.counts, { 是: 1, 否: 1, 不清楚: 0, 不適用: 1 });
	assert.equal(s.total, 8, "items 6 and 7 are open-ended");
	assert.equal(s.answered, 3);
	assert.equal(s.percentYes, 50);
	assert.deepEqual(s.missing, ["4", "5", "8", "9", "10"]);
	assert.equal(tools.describeSummary(s), "是 1／否 1／不清楚 0／不適用 1（共 8 題，已答 3 題，「是」占 50%）");
	assert.equal(tools.summarize("jbi-rct", {}).percentYes, null);
	assert.equal(tools.summarize("jbi-rct", { 1: "Yes", 2: "Can't tell" }).counts.不清楚, 1);
});

test("toMarkdownTable: TWNA columns 評讀項目｜評讀結果｜評析根據, escaping, without notes, with sections", () => {
	let md = tools.toMarkdownTable("casp-rct", { 1: { answer: "是", note: "P: 65 歲以上 | I: 衛教" }, "4a": "否" });
	let lines = md.split("\n");
	assert.equal(lines[0], "| 評讀項目 | 評讀結果 | 評析根據 |");
	assert.equal(lines[1], "|---|---|---|");
	assert.equal(lines[2], "| 1. 研究是否針對一個明確聚焦的問題（PICO）？ | 是 | P: 65 歲以上 \\| I: 衛教 |");
	assert.equal(lines[3], "| 2. 受試者是否被隨機分派到各介入組？ | （未評） |  |");
	assert.equal(lines[5], "| 4a. 受試者是否不知道自己接受的介入（設盲）？ | 否 |  |");
	assert.equal(lines.length, 2 + 13);
	let short = tools.toMarkdownTable("jbi-quasi", {}, { includeNotes: false, empty: "" }).split("\n");
	assert.equal(short[0], "| 評讀項目 | 評讀結果 |");
	assert.equal(short[2], "| 1. 是否清楚區分「因」（介入）與「果」（結果）？ |  |");
	let grouped = tools.toMarkdownTable("casp-rct", {}, { sections: true });
	assert.match(grouped, /\| \*\*Section A：研究設計是否有效[^|]*\*\* \| {2}\| {2}\|/);
	assert.equal(grouped.split("\n").length, 2 + 13 + 4);
	// Open items with only a note
	assert.match(tools.toMarkdownTable("casp-sr", { 6: { note: "OR 0.72" } }), /\| 6\. 回顧的整體結果為何？ \| （見評析） \| OR 0\.72 \|/);
});

test("toCSV: UTF-8 BOM, CRLF, quoting, formula guard; arrays or objects; csvRows long format", () => {
	let csv = tools.toCSV([["文獻", "註"], ["Chen, 2024", "a, \"b\""], ["=1+1", "-5"]]);
	assert.ok(csv.startsWith("﻿文獻,註\r\n"));
	assert.ok(csv.includes("\"Chen, 2024\",\"a, \"\"b\"\"\"\r\n"));
	assert.ok(csv.includes("'=1+1,-5\r\n"));
	let rows = tools.csvRows("jbi-quasi", { 4: { answer: "否", note: "單組前後測" } }, { before: { 文獻: "Lee, 2021" }, after: item => ({ 題號重複: item.id }) });
	assert.equal(rows.length, 9);
	assert.deepEqual(rows[3], { 文獻: "Lee, 2021", 評讀工具: tools.getTool("jbi-quasi").name, 題號: "4", 評讀項目: "是否有對照組？", 評讀結果: "否", 評析根據: "單組前後測", 題號重複: "4" });
	let fromObjects = tools.toCSV(rows).split("\r\n");
	assert.equal(fromObjects[0], "﻿文獻,評讀工具,題號,評讀項目,評讀結果,評析根據,題號重複");
	assert.equal(fromObjects.length, 1 + 9 + 1);
});

test("toJSON / fromJSON: records and bare answer maps round-trip; bad answers and verdicts are dropped", () => {
	let record = {
		tool: "casp-rct", answers: { 1: { answer: "是", note: "PICO 明確", source: "human" }, 2: { answer: "maybe", note: "" }, 3: "否" },
		overall: "納入", verified: true, verifiedAt: "2026-10-08T10:00:00Z", dual: true, answersB: { 1: "否" }, overallB: "nonsense",
	};
	let back = tools.fromJSON(tools.toJSON(record));
	assert.equal(back.format, "zotero-bridge-appraisal");
	assert.equal(back.tool, "casp-rct");
	assert.deepEqual(back.answers, { 1: { answer: "是", note: "PICO 明確", source: "human" }, 3: { answer: "否", note: "" } });
	assert.equal(back.verifiedAt, "2026-10-08");
	assert.equal(back.overallB, "");
	assert.deepEqual(back.answersB, { 1: { answer: "否", note: "" } });
	assert.deepEqual(tools.fromJSON(tools.toJSON(back)), back, "stable");
	// A bare answers map
	let bare = tools.fromJSON('{"1":{"answer":"是","note":"x"}}');
	assert.equal(bare.tool, null);
	assert.deepEqual(bare.answers, { 1: { answer: "是", note: "x" } });
	assert.match(tools.toJSON({ 2: "不清楚" }), /"2": \{\n\s+"answer": "不清楚"/);
	assert.throws(() => tools.fromJSON("[1]"), /不是 JSON 物件/);
	assert.throws(() => tools.fromJSON("{bad"));
	// Unverified: no date
	assert.equal(tools.fromJSON({ answers: {}, verified: false, verifiedAt: "2026-01-01" }).verifiedAt, "");
});

test("Cohen's kappa: textbook values, no-variance and empty cases, labels, disagreements", () => {
	// 2 categories, 10 pairs: agree 4×是 + 3×否, 2 是/否, 1 否/是 → p_o = .7, p_e = .6·.5 + .4·.5 = .5, κ = .4
	let pairs = [
		...Array(4).fill(["是", "是"]), ...Array(3).fill(["否", "否"]), ["是", "否"], ["是", "否"], ["否", "是"],
	];
	let k = tools.cohenKappa(pairs);
	assert.equal(k.n, 10);
	assert.equal(k.agree, 7);
	assert.ok(Math.abs(k.po - 0.7) < 1e-9);
	assert.ok(Math.abs(k.pe - 0.5) < 1e-9);
	assert.ok(Math.abs(k.kappa - 0.4) < 1e-9);
	assert.equal(tools.kappaLabel(k.kappa), "尚可");
	assert.equal(tools.formatKappa(k), "κ = 0.40（尚可）；一致率 70%（7/10）");
	// Perfect agreement with variance: 1; both always 是: undefined (p_e = 1)
	assert.equal(tools.cohenKappa([["是", "是"], ["否", "否"]]).kappa, 1);
	let flat = tools.cohenKappa([["是", "是"], ["是", "是"]]);
	assert.equal(flat.kappa, null);
	assert.match(tools.formatKappa(flat), /κ 無法計算（雙方答案沒有變異）；一致率 100%/);
	assert.equal(tools.cohenKappa([["是", ""], ["", "否"]]).n, 0);
	assert.equal(tools.formatKappa(tools.cohenKappa([])), "—（沒有雙方都作答的題目）");
	assert.deepEqual([-0.1, 0.1, 0.3, 0.5, 0.7, 0.9].map(tools.kappaLabel), ["低於隨機一致", "輕微一致", "尚可", "中等一致", "高度一致", "幾乎完全一致"]);
	// Per tool: only scored items both reviewers answered
	let a = { 1: "是", 2: "是", 3: "否", 6: "是" };
	let b = { 1: "是", 2: "否", 3: "否", 6: "否", 4: "是" };
	assert.equal(tools.kappa("casp-sr", a, b).n, 3, "item 6 is open-ended, 4 has one answer only");
	assert.deepEqual(tools.disagreements("casp-sr", a, b), [{ id: "2", text: "作者是否尋找適當類型的文獻？", a: "是", b: "否" }]);
});

test("trafficLightMatrix: studies × items with emoji, or plain symbols for Word", () => {
	let studies = [
		{ label: "Chen, 2024", answers: { 1: "是", 2: "否", 3: "不清楚", 4: "不適用" }, overall: "納入", verified: true },
		{ label: "Lee | 2021", answers: {}, overall: "", verified: false },
	];
	let lines = tools.trafficLightMatrix("jbi-quasi", studies).split("\n");
	assert.equal(lines[0], "| 文獻 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 整體評價 | 核對 |");
	assert.equal(lines[2], "| Chen, 2024 | ✅ | ❌ | ❓ | ➖ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | 納入 | 已核對 |");
	assert.equal(lines[3], "| Lee \\| 2021 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | — | 未核對 |");
	let plain = tools.trafficLightMatrix("jbi-quasi", studies, { plain: true }).split("\n");
	assert.equal(plain[2], "| Chen, 2024 | ✓ | ✗ | ? | – |   |   |   |   |   | 納入 | 已核對 |");
	assert.equal(tools.legend(), "✅ 是　❌ 否　❓ 不清楚　➖ 不適用　⬜ 未評");
});

test("UMD: loads in a browser-like page as window.ZBAppraisalTools without Zotero or ZB", () => {
	let window = {};
	window.window = window;
	let ctx = vm.createContext(window);
	vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "content", "appraisal-tools.js"), "utf8"), ctx);
	assert.equal(typeof window.ZBAppraisalTools.getTool, "function");
	assert.equal(window.ZB, undefined);
	assert.equal(window.ZBAppraisalTools.TOOLS.length, tools.TOOLS.length);
	// In the plugin scope (Zotero present): ZB.appraisalTools
	let plugin = { Zotero: {} };
	vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "content", "appraisal-tools.js"), "utf8"), vm.createContext(plugin));
	assert.equal(typeof plugin.ZB.appraisalTools.summarize, "function");
});
