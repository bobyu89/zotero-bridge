// 「AI 標重點」 in the AI note's request and structured data (content/llm.js), and the Markdown full
// text in the prompt.
const test = require("node:test");
const assert = require("node:assert/strict");
const llm = require("../content/llm.js");
const verify = require("../content/verify.js");
const { sampleItem } = require("./fixtures.cjs");

test("the key sentences are asked for only with the switch on, in the same request (a cached system part)", () => {
	let off = llm.buildPrompt(sampleItem(), {});
	assert.deepEqual(off.systemParts, [llm.DEFAULT_SYSTEM_PROMPT, llm.STUDY_DATA_PROMPT]);
	let on = llm.buildPrompt(sampleItem(), { aiHighlights: true });
	assert.deepEqual(on.systemParts, [llm.DEFAULT_SYSTEM_PROMPT, llm.STUDY_DATA_PROMPT, llm.AI_HIGHLIGHTS_PROMPT]);
	assert.equal(on.user, off.user, "the item part is the same");
	assert.match(llm.AI_HIGHLIGHTS_PROMPT, /"highlights": \[\{ "quote": "逐字照抄的原句", "why"/);
	assert.match(llm.AI_HIGHLIGHTS_PROMPT, /對不上的會被刪掉/);
	let body = llm.noteRequestBody({ provider: "anthropic", model: "m" }, sampleItem(), { aiHighlights: true });
	assert.equal(body.system.length, 3);
	assert.deepEqual(body.system.at(-1).cache_control, { type: "ephemeral" }, "the whole instruction prefix is cached");
	assert.equal(body.system.slice(0, 2).some(b => b.cache_control), false);
});

test("structured data: highlights normalised, deduplicated, capped; absent without any; round trip through the Zotero note", () => {
	let md = "## 一句話摘要\nx\n\n```json\n" + JSON.stringify({
		study_design: "RCT", sample_size: 10,
		highlights: [
			{ quote: "  “Falls  decreased by 30%.”  ", why: " 主要結果 " },
			{ quote: "falls decreased by 30%.", why: "dup" },
			{ quote: "", why: "empty" },
			"A bare string quote.",
			{ quote: null },
			...Array.from({ length: 10 }, (_, i) => ({ quote: `Sentence ${i}.`, why: "" })),
		],
	}) + "\n```\n";
	let parsed = llm.extractStudyData(md);
	assert.equal(parsed.error, "");
	let h = parsed.data.highlights;
	assert.equal(h.length, llm.MAX_AI_HIGHLIGHTS);
	assert.deepEqual(h[0], { quote: "Falls decreased by 30%.", why: "主要結果" });
	assert.deepEqual(h[1], { quote: "A bare string quote.", why: "" });
	assert.equal(parsed.data.study_design, "RCT");
	assert.equal(llm.hasStudyData({ highlights: [{ quote: "x" }] }), false, "the key sentences alone are not study data");
	// No highlights: the key is absent, so older data compares the same
	let plain = llm.normalizeStudyData({ study_design: "RCT" });
	assert.equal("highlights" in plain, false);
	assert.deepEqual(Object.keys(plain), llm.STUDY_FIELDS);
	// Stored in the AI note and read back by a later sync without AI
	let block = llm.studyDataBlock(parsed.data);
	assert.match(block, /"highlights": \[/);
	let back = llm.extractStudyData("## A\nb\n\n" + block).data;
	assert.deepEqual(back.highlights, h);
	assert.doesNotMatch(llm.studyDataBlock(plain), /highlights/);
});

test("verification uses verify.js matching: exact or ≥ 90% of the words, ellipses allowed; others are dropped", () => {
	let text = "## Results\n\nThe intervention reduced the rate of falls by thirty percent compared with usual care.";
	let index = verify.buildIndex(text);
	assert.equal(verify.quoteInIndex("The intervention reduced the rate of falls by thirty percent", index), true);
	assert.equal(verify.quoteInIndex("The intervention reduced … compared with usual care.", index), true);
	assert.equal(verify.quoteInIndex("The programme doubled the rate of hospital admissions in every ward.", index), false);
});

test("the prompt says when the full text is Markdown with the reference list cut", () => {
	let data = sampleItem({ fullText: "## Results\n\nx", fullTextStatus: "ok", fullTextFormat: "markdown", fullTextTrimmed: true });
	assert.match(llm.buildPrompt(data, {}).user, /<fulltext>\n（全文已整理成 Markdown；參考文獻、誌謝、經費與利益衝突等段落已省略）\n## Results\n\nx\n<\/fulltext>/);
	let untrimmed = llm.buildPrompt(Object.assign(data, { fullTextTrimmed: false }), {}).user;
	assert.match(untrimmed, /<fulltext>\n## Results/);
});
