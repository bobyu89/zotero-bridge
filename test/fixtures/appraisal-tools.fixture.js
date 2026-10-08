// Test fixture for the shared checklist catalog (content/appraisal-tools.js).
// Implements the same interface with two small stub tools so site/appraisal.html can be tested
// without the real catalog. UMD: module.exports in Node, window.ZBAppraisalTools in browsers.
(function (root, factory) {
	var api = factory();
	if (typeof module === "object" && module.exports) module.exports = api;
	if (root) root.ZBAppraisalTools = api;
})(typeof self !== "undefined" ? self : this, function () {
	"use strict";

	var ANSWERS = ["是", "否", "不清楚", "不適用"];
	var VERDICTS = ["納入", "排除", "需更多資訊"];

	var TOOLS = [
		{
			id: "casp-rct-stub", family: "CASP", name: "CASP RCT (stub)", nameZh: "CASP 隨機對照試驗（測試用）",
			designs: ["RCT"], source: "https://casp-uk.net/casp-tools-checklists/", license: "CC BY-NC-SA 4.0",
			verdicts: VERDICTS,
			items: [
				{ id: "q1", section: "A. 研究設計是否有效？", text: "研究是否針對一個清楚聚焦的問題？", textEn: "Did the study address a clearly focused research question?", hint: "看 PICO 是否寫清楚。" },
				{ id: "q2", section: "A. 研究設計是否有效？", text: "受試者是否隨機分派到各組？", textEn: "Was the assignment of participants to interventions randomised?", hint: "分派方式、分派隱匿。" },
				{ id: "q3", section: "B. 研究方法是否可靠？", text: "受試者、介入者、評估者是否盲化？", textEn: "Were participants, investigators and assessors blinded?", hint: "" },
				{ id: "q4", section: "C. 結果是什麼？", text: "介入的效果有多大、多精確？", textEn: "How large and precise was the effect?", hint: "效應值、95% CI。" }
			]
		},
		{
			id: "jbi-qual-stub", family: "JBI", name: "JBI Qualitative (stub)", nameZh: "JBI 質性研究（測試用）",
			designs: ["qualitative"], source: "https://jbi.global/critical-appraisal-tools", license: "© JBI；教學與研究用途",
			verdicts: VERDICTS,
			items: [
				{ id: "j1", text: "哲學觀點與研究方法是否一致？", textEn: "Congruity between philosophical perspective and methodology?", hint: "" },
				{ id: "j2", text: "研究方法與研究問題是否一致？", textEn: "Congruity between methodology and research question?" },
				{ id: "j3", text: "參與者的聲音是否被充分呈現？", textEn: "Are participants and their voices adequately represented?", hint: "看引文。" }
			]
		}
	];

	function getTool(id) {
		for (var i = 0; i < TOOLS.length; i++) if (TOOLS[i].id === id) return TOOLS[i];
		return null;
	}

	function toolsForDesign(design) {
		return TOOLS.filter(function (t) { return t.designs.indexOf(design) !== -1; });
	}

	function summarize(tool, answers) {
		answers = answers || {};
		var counts = {};
		ANSWERS.forEach(function (a) { counts[a] = 0; });
		var missing = [];
		tool.items.forEach(function (it) {
			var a = answers[it.id] && answers[it.id].answer;
			if (ANSWERS.indexOf(a) !== -1) counts[a]++;
			else missing.push(it.id);
		});
		var total = tool.items.length, answered = total - missing.length;
		return { counts: counts, total: total, answered: answered, percentYes: total ? Math.round(counts["是"] / total * 100) : 0, missing: missing };
	}

	function cell(s) { return String(s == null ? "" : s).replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>"); }

	function toMarkdownTable(tool, answers, opts) {
		answers = answers || {};
		var notes = !opts || opts.includeNotes !== false;
		var lines = notes ? ["| 評讀項目 | 評讀結果 | 評析根據 |", "| --- | --- | --- |"] : ["| 評讀項目 | 評讀結果 |", "| --- | --- |"];
		tool.items.forEach(function (it, i) {
			var a = answers[it.id] || {};
			var row = [cell((i + 1) + ". " + it.text), cell(a.answer || "")];
			if (notes) row.push(cell(a.note || ""));
			lines.push("| " + row.join(" | ") + " |");
		});
		return lines.join("\n");
	}

	function toCSV(rows) {
		return rows.map(function (r) {
			return r.map(function (v) {
				v = String(v == null ? "" : v);
				return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
			}).join(",");
		}).join("\r\n");
	}

	return { ANSWERS: ANSWERS, TOOLS: TOOLS, getTool: getTool, toolsForDesign: toolsForDesign, summarize: summarize, toMarkdownTable: toMarkdownTable, toCSV: toCSV };
});
