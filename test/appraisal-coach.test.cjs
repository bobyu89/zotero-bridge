// 評讀陪練 (content/appraisal-coach.js), the pure parts: readiness, the prompt (never the user's answers),
// defensive parsing of the AI's JSON, quotes checked against the full text, the plugin's comparison,
// decisions, the summary lines, and the run stored in the form's JSON and synced line.
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../content/appraisal-coach.js");
const tools = require("../content/appraisal-tools.js");
const form = require("../content/appraisal-form.js");
const usage = require("../content/usage.js");

const PAPER_TEXT = [
	"## Methods",
	"Participants were randomly assigned to the intervention or control group using a computer-generated sequence.",
	"Allocation was concealed in sealed opaque envelopes prepared by an independent statistician.",
	"\f",
	"## Results",
	"Twelve participants (10%) were lost to follow-up and were not included in the analysis.",
	"Outcome assessors were not blinded to group allocation.",
].join("\n");

// The user's own appraisal: every closed CASP RCT item answered, with notes only they wrote
function userRecord(extra = {}) {
	let answers = {};
	for (let item of C.closedItems("casp-rct")) answers[item.id] = { answer: "是", note: `我的評析 ${item.id}：SECRET-NOTE`, source: "human" };
	answers["3"] = { answer: "否", note: "流失 10%，SECRET-NOTE", source: "human" };
	answers["4c"] = { answer: "不清楚", note: "", source: "human" };
	return tools.normalizeRecord(Object.assign({ tool: "casp-rct", answers, overall: "納入" }, extra));
}

function aiJSON(entries) {
	return JSON.stringify({ items: entries });
}

test("readiness: every closed item must be the user's own answer; AI 初評 counts once confirmed", () => {
	let r = C.readiness(userRecord());
	assert.equal(r.ready, true);
	assert.equal(r.reason, "");
	// Open-ended items (CASP SR 6, 7) are never required
	assert.ok(C.closedItems("casp-sr").every(i => !i.open));
	assert.ok(C.closedItems("casp-sr").length < tools.getTool("casp-sr").items.length);

	let partial = userRecord();
	delete partial.answers["5"];
	partial.answers["2"] = { answer: "是", note: "", source: "ai" };
	r = C.readiness(partial);
	assert.equal(r.ready, false);
	assert.deepEqual(r.missing, ["5"]);
	assert.deepEqual(r.unconfirmed, ["2"]);
	assert.equal(r.reason, "先自己答完每一題，才能對照 AI：第 5 題還沒答；第 2 題是 AI 初評帶入、還沒確認（點一下你的答案就算確認）。");
	// 我已核對 confirms the AI's prefill
	let verified = userRecord({ verified: true, verifiedAt: "2026-10-01" });
	verified.answers["2"] = { answer: "是", note: "", source: "ai" };
	assert.equal(C.readiness(verified).ready, true);
	assert.equal(C.readiness(tools.normalizeRecord({ tool: null })).ready, false);
});

test("buildPrompt: instructions and checklist as cacheable system blocks; the paper and item IDs only — never the user's answers", () => {
	let record = userRecord();
	let paper = { title: "Nurse-led falls trial", year: "2024", text: PAPER_TEXT, source: "fulltext", trimmed: true };
	let p = C.buildPrompt(record.tool, paper);
	assert.equal(p.system.length, 2, "two system blocks: Claude caches up to the end of the second");
	assert.equal(p.system[0], C.INSTRUCTIONS);
	assert.match(p.system[1], /^<checklist>\n評讀工具：CASP Checklist: For Randomised Controlled Trials \(RCTs\) \(2024\)/);
	assert.match(p.system[1], /- 4a\. 受試者是否不知道自己接受的介入（設盲）？｜Participants blinded｜看什麼：/);
	assert.deepEqual(p.ids, ["1", "2", "3", "4a", "4b", "4c", "5", "6", "7", "8", "9", "10", "11"]);
	assert.match(p.user, /^<paper>\n標題：Nurse-led falls trial\n年份：2024\n（全文已整理成 Markdown；參考文獻/);
	assert.ok(p.user.includes("Allocation was concealed in sealed opaque envelopes"));
	assert.match(p.user, /逐題作答以下 13 題：1, 2, 3, 4a, 4b, 4c, 5, 6, 7, 8, 9, 10, 11。只輸出 JSON。$/);
	// Nothing of the user's appraisal goes out
	let all = JSON.stringify(p);
	assert.doesNotMatch(all, /SECRET-NOTE|我的評析|你的答案|納入/);
	assert.match(C.INSTRUCTIONS, /你看不到研究生的答案/);
	// The function can't even be handed the record's answers: only the tool and the paper
	assert.equal(C.buildPrompt.length, 2);
	// The same tool → the same system blocks for every paper (one cache prefix)
	assert.deepEqual(C.buildPrompt("casp-rct", { text: "x", source: "fulltext" }).system, p.system);
	// Abstract only: said so in the prompt
	let a = C.buildPrompt("casp-rct", { text: "Background. Methods.", source: "abstract" });
	assert.match(a.user, /這篇沒有可用的全文，以下只有摘要/);
	let t = C.buildPrompt("casp-rct", { text: "x", source: "fulltext", truncated: true });
	assert.match(t.user, /全文過長，以下只有前段/);
	assert.throws(() => C.buildPrompt("nope", paper), /沒有這份評讀工具/);
});

test("estimateCost: input from both system blocks and the paper, output budget per item; null cost when unpriced", () => {
	let p = C.buildPrompt("casp-rct", { text: PAPER_TEXT, source: "fulltext" });
	let model = Object.keys(usage.DEFAULT_PRICES)[0];
	let est = C.estimateCost(p, model, usage.DEFAULT_PRICES);
	assert.ok(est.inputTokens > 300, String(est.inputTokens));
	assert.ok(est.expected > 0 && est.max > est.expected);
	let unpriced = C.estimateCost(p, "some-unpriced-model", usage.DEFAULT_PRICES);
	assert.equal(unpriced.expected, null);
	assert.equal(unpriced.inputTokens, est.inputTokens);
});

test("parseResponse: fences, prose, trailing commas, arrays and keyed objects; unknown IDs and answers reported, never guessed", () => {
	let text = "好的，以下是結果：\n```json\n" + aiJSON([
		{ id: "Q1", answer: "Yes", reason: "PICO 清楚。", quotes: [{ text: "Participants were randomly assigned", page: "3" }] },
		{ id: "4(a)", answer: "Can't tell", reason: "未說明。", quotes: "a bare string quote of some length" },
		{ id: "2", answer: "maybe", reason: "?" },
		{ id: "99", answer: "是" },
		{ id: "1", answer: "否", reason: "duplicate: the first one wins" },
	]).replace(/}]}$/, "},]}") + "\n```\n以上。";
	let r = C.parseResponse(text, "casp-rct");
	assert.deepEqual(Object.keys(r.items).sort(), ["1", "4a"]);
	assert.deepEqual(r.items["1"], { answer: "是", reason: "PICO 清楚。", quotes: [{ text: "Participants were randomly assigned", page: "3" }] });
	assert.equal(r.items["4a"].answer, "不清楚");
	assert.deepEqual(r.items["4a"].quotes, [{ text: "a bare string quote of some length", page: "" }]);
	assert.deepEqual(r.unknownIDs, ["99"]);
	assert.deepEqual(r.invalid, ["2"]);
	assert.ok(r.missing.includes("2") && r.missing.includes("11") && !r.missing.includes("1"));
	// A bare array, and an object keyed by item ID
	assert.equal(C.parseResponse(JSON.stringify([{ id: 3, answer: "No" }]), "casp-rct").items["3"].answer, "否");
	let keyed = C.parseResponse(JSON.stringify({ "第 5 題": { answer: "不適用" }, 6: "是" }), "casp-rct");
	assert.equal(keyed.items["5"].answer, "不適用");
	assert.equal(keyed.items["6"].answer, "是");
	// At most two quotes, cleaned
	let many = C.parseResponse(aiJSON([{ id: "1", answer: "是", quotes: ["「one quote here」", "two", "three"] }]), "casp-rct");
	assert.deepEqual(many.items["1"].quotes.map(q => q.text), ["one quote here", "two"]);
	// Malformed: no JSON at all
	assert.throws(() => C.parseResponse("I could not read the paper.", "casp-rct"), /沒有 JSON/);
	assert.throws(() => C.parseResponse("{\"items\": [", "casp-rct"));
	assert.throws(() => C.parseResponse("42", "casp-rct"), /不是逐題的 JSON/);
	assert.equal(C.normalizeID(" Q 4 (b). "), "4b");
});

test("verifyItems: quotes must be in the text (page found per PDF page); the others are dropped; none left → low confidence", () => {
	let parsed = C.parseResponse(aiJSON([
		{ id: "2", answer: "是", quotes: [{ text: "using a computer-generated sequence", page: "9" }, { text: "Randomisation was stratified by ward and age group", page: "3" }] },
		{ id: "3", answer: "是", quotes: [{ text: "lost to follow-up and were not included in the analysis" }] },
		{ id: "4c", answer: "否", quotes: [{ text: "Assessors were fully blinded throughout the study" }] },
		{ id: "5", answer: "是", quotes: [{ text: "random" }] },
		{ id: "6", answer: "是", quotes: [] },
	]), "casp-rct");
	let pages = PAPER_TEXT.split("\f");
	let checked = C.verifyItems(parsed.items, { texts: [PAPER_TEXT, "an abstract sentence that is only in the abstract here"], pages: [{ key: "PDFKEY", pages }] });
	assert.equal(checked.kept, 2);
	assert.equal(checked.dropped, 3, "invented, contradicting and too-short quotes are dropped");
	assert.deepEqual(checked.items["2"].quotes, [{ text: "using a computer-generated sequence", page: 1, attachmentKey: "PDFKEY" }], "the PDF page, not the AI's claim");
	assert.equal(checked.items["2"].lowConfidence, false);
	assert.deepEqual(checked.items["3"].quotes, [{ text: "lost to follow-up and were not included in the analysis", page: 2, attachmentKey: "PDFKEY" }]);
	assert.equal(checked.items["4c"].lowConfidence, true);
	assert.equal(checked.items["5"].lowConfidence, true, "a one-word quote proves nothing");
	assert.equal(checked.items["6"].lowConfidence, true);
	// Found in the abstract but on no PDF page: kept, with the AI's page as a hint only
	let abs = C.verifyItems(C.parseResponse(aiJSON([{ id: "1", answer: "是", quotes: [{ text: "an abstract sentence that is only in the abstract", page: "1" }] }]), "casp-rct").items,
		{ texts: ["an abstract sentence that is only in the abstract here"], pages: [] });
	assert.deepEqual(abs.items["1"].quotes, [{ text: "an abstract sentence that is only in the abstract", pageGiven: "1" }]);
});

test("compare and buildRun: the plugin computes the disagreements; only those wait for a decision", () => {
	let record = userRecord();
	let ai = {};
	for (let id of C.closedItems("casp-rct").map(i => i.id)) ai[id] = { answer: "是", reason: `理由 ${id}`, quotes: [{ text: "q" }], lowConfidence: false };
	ai["3"] = { answer: "是", reason: "AI 認為有交代流失。", quotes: [], lowConfidence: true };
	ai["5"] = { answer: "否", reason: "基準期有差異。", quotes: [{ text: "q5" }], lowConfidence: false };
	delete ai["11"];
	let cmp = C.compare(record.tool, record.answers, ai);
	assert.equal(cmp.compared, 12);
	assert.equal(cmp.agreed, 9);
	assert.equal(cmp.disagreed, 3);
	assert.deepEqual(cmp.missing, ["11"]);
	let diff = cmp.items.filter(i => i.agree === false);
	assert.deepEqual(diff.map(i => [i.id, i.user, i.ai]), [["3", "否", "是"], ["4c", "不清楚", "是"], ["5", "是", "否"]]);
	assert.deepEqual(diff.find(i => i.id === "3"), { id: "3", user: "否", ai: "是", reason: "AI 認為有交代流失。", quotes: [], lowConfidence: true, agree: false, decision: "", why: "", decidedAt: "" });
	assert.equal(cmp.items.find(i => i.id === "11").agree, null);
	assert.equal(cmp.items.find(i => i.id === "1").decision, undefined, "agreements need no decision");

	let run = C.buildRun({ tool: "casp-rct", model: "m", provider: "anthropic", at: "2026-10-09T01:00:00.000Z", source: "fulltext", dropped: 2, comparison: cmp, unknownIDs: ["99"], invalid: ["2"] });
	assert.equal(run.tool, "casp-rct");
	assert.equal(run.compared, 12);
	assert.equal(run.agreed, 9);
	assert.equal(run.dropped, 2);
	assert.deepEqual(run.ignored, ["99", "2（答案不在選項內）"]);
	assert.equal(C.summaryText(run), "12 題中 9 題一致，3 題不同（一致 75%）；AI 沒有回答第 11 題");
	assert.equal(C.summaryText(Object.assign({}, run, { agreed: 12, missing: [] })), "12 題全部一致（一致 100%）");
});

test("decide: 保留 leaves the answer; 改成 AI 的答案 changes only that answer (the note stays the user's); both are recorded", () => {
	let record = userRecord();
	let ai = {};
	for (let id of C.closedItems("casp-rct").map(i => i.id)) ai[id] = { answer: record.answers[id].answer, reason: "", quotes: [], lowConfidence: true };
	ai["3"] = { answer: "是", reason: "r3", quotes: [], lowConfidence: true };
	ai["5"] = { answer: "否", reason: "r5", quotes: [], lowConfidence: true };
	let run = C.buildRun({ tool: "casp-rct", model: "m", comparison: C.compare("casp-rct", record.answers, ai) });
	let withRun = C.addRun(record, run);
	assert.equal(C.summaryLine(withRun), "評讀陪練：一致 11/13，修改 0 題，2 題尚未決定");

	let now = new Date("2026-10-09T02:00:00Z");
	let kept = C.decide(withRun, "3", "kept", "  流失其實沒有分析  ", now);
	assert.equal(kept.answers["3"].answer, "否", "kept: unchanged");
	let e3 = C.latestRun(kept).items.find(i => i.id === "3");
	assert.deepEqual([e3.decision, e3.why, e3.decidedAt], ["kept", "流失其實沒有分析", "2026-10-09T02:00:00.000Z"]);
	assert.equal(withRun.coach[0].items.find(i => i.id === "3").decision, "", "a copy: the input record is untouched");

	let changed = C.decide(kept, "5", "changed", "", now);
	assert.deepEqual(changed.answers["5"], { answer: "否", note: "我的評析 5：SECRET-NOTE", source: "human" });
	for (let id of Object.keys(record.answers)) {
		if (id !== "5") assert.deepEqual(changed.answers[id], record.answers[id], `item ${id} unchanged`);
	}
	assert.equal(C.summaryLine(changed), "評讀陪練：一致 11/13，修改 1 題");
	assert.throws(() => C.decide(changed, "1", "kept"), /不在這次對照的差異裡/);
	assert.throws(() => C.decide(changed, "3", "maybe"), /Unknown decision/);
	assert.equal(C.summaryLine(record), "", "no run, no line");

	// Runs are capped
	let many = record;
	for (let i = 0; i < C.MAX_RUNS + 2; i++) many = C.addRun(many, Object.assign({}, run, { at: String(i) }));
	assert.equal(many.coach.length, C.MAX_RUNS);
	assert.equal(C.latestRun(many).at, String(C.MAX_RUNS + 1));
});

test("the run lives in the form's JSON: normalizeRecord, the child note and the synced section keep it; the AI's answers never become the appraisal", () => {
	let record = userRecord({ verified: true, verifiedAt: "2026-10-08" });
	let ai = {};
	for (let id of C.closedItems("casp-rct").map(i => i.id)) ai[id] = { answer: "是", reason: "", quotes: [{ text: "verbatim quote here", page: 2, attachmentKey: "K" }], lowConfidence: false };
	let run = C.buildRun({ tool: "casp-rct", model: "m", at: "2026-10-09T00:00:00.000Z", comparison: C.compare("casp-rct", record.answers, ai) });
	let decided = C.decide(C.addRun(record, run), "3", "changed", "AI 指出有 ITT", new Date("2026-10-09T03:00:00Z"));
	let normalized = tools.normalizeRecord(decided);
	assert.deepEqual(normalized.coach, decided.coach);
	assert.equal(tools.normalizeRecord(record).coach, undefined, "no key without runs (older records keep their shape)");
	let back = tools.fromJSON(tools.toJSON(decided));
	assert.equal(back.coach[0].items.find(i => i.id === "3").decision, "changed");
	assert.deepEqual(back.coach[0].items.find(i => i.id === "1").quotes, [{ text: "verbatim quote here", page: 2, attachmentKey: "K" }]);

	let html = form.noteHTML(decided, { title: "T" });
	assert.match(html, /<p>評讀陪練：一致 11\/13，修改 1 題，1 題尚未決定<\/p>/);
	assert.deepEqual(form.readNoteHTML(html).coach, normalized.coach);
	let md = form.sectionMarkdown(decided);
	assert.match(md, /\*\*整體評價\*\*：納入\n\n評讀陪練：一致 11\/13，修改 1 題，1 題尚未決定/);
	assert.match(form.sectionMarkdown(decided, { notion: true }), /評讀陪練：一致 11\/13/);
	// The table shows the user's answers (item 3 changed by the user's own decision), not the AI's
	assert.match(md, /\| 4c\. 評估或分析結果的人員是否設盲？ \| 不清楚 \|/);
	assert.match(md, /\| 3\. 所有進入研究的受試者在研究結束時是否都有交代？ \| 是 \|/);
	assert.doesNotMatch(md, /AI 的答案|verbatim quote/);
	assert.doesNotMatch(form.sectionMarkdown(record), /評讀陪練/);
});
