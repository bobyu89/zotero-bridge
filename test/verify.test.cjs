const test = require("node:test");
const assert = require("node:assert/strict");
const verify = require("../content/verify.js");

const PDF_TEXT = [
	"Background: Falls are a leading cause of injury among older inpatients.",
	"Results: The intervention group showed a signiﬁcant reduc-",
	"tion in falls compared with usual care (RR = 0.70, 95% CI 0.52–0.94;",
	"p = .02). Patients’ fear of falling also decreased over the 12-week",
	"follow-up. Nurse-led education was well accepted by both patients and families.",
	"結果顯示，介入組 的 跌倒 發生率",
	"顯著 低於對照組，且病人的跌倒自我效能",
	"提升。",
].join("\n");

test("normalizeForMatch handles case, ligatures, curly apostrophes and line-break hyphenation", () => {
	assert.equal(verify.normalizeForMatch("ﬁNAL"), "final");
	assert.equal(verify.normalizeForMatch("Patients’ fear"), "patients fear");
	assert.equal(verify.normalizeForMatch("interven-\ntion"), "intervention");
	assert.equal(verify.normalizeForMatch("interven-\r\n   tion"), "intervention");
	assert.equal(verify.normalizeForMatch("evidence-based"), "evidencebased");
	assert.equal(verify.normalizeForMatch("soft­hyphen"), "softhyphen");
	assert.equal(verify.normalizeForMatch("ＲＣＴ１２０"), "rct120", "full-width letters and digits");
});

test("tokenize splits words and single CJK characters, ignoring punctuation and spacing", () => {
	assert.deepEqual(verify.tokenize("Falls decreased by 30% (p < .05)."), ["falls", "decreased", "by", "30", "p", "05"]);
	assert.deepEqual(verify.tokenize("跌倒 發生率，RCT研究"), ["跌", "倒", "發", "生", "率", "rct", "研", "究"]);
	assert.deepEqual(verify.tokenize("「自我效能」"), ["自", "我", "效", "能"]);
	assert.deepEqual(verify.tokenize("…"), []);
});

test("containsQuote: exact quotes despite PDF line wraps, hyphenation, ligatures and case", () => {
	assert.ok(verify.containsQuote(PDF_TEXT, "The intervention group showed a significant reduction in falls compared with usual care"));
	assert.ok(verify.containsQuote(PDF_TEXT, "the INTERVENTION group showed a significant reduction in falls"));
	assert.ok(verify.containsQuote(PDF_TEXT, "(RR = 0.70, 95% CI 0.52-0.94; p = .02)"), "en dash vs hyphen");
	assert.ok(verify.containsQuote(PDF_TEXT, "Nurse-led education was well accepted by both patients and families."));
	assert.ok(verify.containsQuote(PDF_TEXT, "Nurse–led education was well accepted"), "en dash inside the word");
});

test("containsQuote: curly and straight apostrophes are equivalent", () => {
	assert.ok(verify.containsQuote(PDF_TEXT, "Patients' fear of falling also decreased over the 12-week follow-up"));
	assert.ok(verify.containsQuote("The patients' fear decreased.", "The patients’ fear decreased"));
});

test("containsQuote: CJK text split by spaces and line breaks in the PDF", () => {
	assert.ok(verify.containsQuote(PDF_TEXT, "結果顯示，介入組的跌倒發生率顯著低於對照組"));
	assert.ok(verify.containsQuote(PDF_TEXT, "病人的跌倒自我效能提升"));
	assert.ok(!verify.containsQuote(PDF_TEXT, "介入組的跌倒發生率顯著高於對照組，且住院天數縮短"));
});

test("containsQuote: ellipses split the quote into fragments that must appear in order", () => {
	assert.ok(verify.containsQuote(PDF_TEXT, "The intervention group showed … compared with usual care"));
	assert.ok(verify.containsQuote(PDF_TEXT, "The intervention group showed ... compared with usual care"));
	assert.ok(verify.containsQuote(PDF_TEXT, "The intervention group showed [...] compared with usual care"));
	assert.ok(verify.containsQuote(PDF_TEXT, "結果顯示……顯著低於對照組"));
	assert.ok(!verify.containsQuote(PDF_TEXT, "compared with usual care … The intervention group showed"), "out of order");
	assert.ok(!verify.containsQuote(PDF_TEXT, "The intervention group showed … compared with placebo"));
	assert.deepEqual(verify.splitOnEllipsis("a b [...] c … d (…) e. . . f"), ["a b", "c", "d", "e", "f"]);
});

test("containsQuote: ≥ 90% of the words in order is accepted, less is not", () => {
	// 18 words, one changed (94%)
	assert.ok(verify.containsQuote(PDF_TEXT, "The intervention group showed a significant decrease in falls compared with usual care (RR = 0.70, 95% CI"));
	// one extra word inserted by the model (word order kept)
	assert.ok(verify.containsQuote(PDF_TEXT, "The intervention group showed a statistically significant reduction in falls compared with usual care"));
	// several changes in a short quote
	assert.ok(!verify.containsQuote(PDF_TEXT, "The control group showed a small increase in falls"));
	// short quotes must match exactly
	assert.ok(!verify.containsQuote(PDF_TEXT, "falls increased"));
	assert.ok(verify.containsQuote(PDF_TEXT, "reduction in falls"));
	// words present but scattered across the text don't count
	assert.ok(!verify.containsQuote(PDF_TEXT, "falls injury inpatients education families care patients group"));
});

test("containsQuote is fast on a long full text", () => {
	let filler = Array.from({ length: 20000 }, (_, i) => `the patients and the nurses ${i % 97} 的 護理`).join(" ");
	let text = filler + " Uniquely phrased finding about bedside handover safety. " + filler;
	let t0 = Date.now();
	assert.ok(verify.containsQuote(text, "Uniquely phrased finding about bedside handover safety"));
	assert.ok(!verify.containsQuote(text, "the patients and the nurses agreed that the 的 護理 was poor overall in the ward"));
	assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
});

test("extractQuote picks the longest quoted span on the line", () => {
	assert.equal(verify.extractQuote('- "Falls decreased by 30%" (p. 5) — 作者稱為「顯著」'), "Falls decreased by 30%");
	assert.equal(verify.extractQuote("> “Patients’ fear decreased” (p. 6)"), "Patients’ fear decreased");
	assert.equal(verify.extractQuote("- 「介入組的跌倒發生率顯著低於對照組」（p. 7）"), "介入組的跌倒發生率顯著低於對照組");
	assert.equal(verify.extractQuote('- "Mixed quotes” (p. 1)'), "Mixed quotes");
	assert.equal(verify.extractQuote("- 沒有引號的說明文字"), null);
});

const NOTE = `## 一句話摘要
衛教有效。

## 可引用的句子
- "The intervention group showed a significant reduction in falls" (p. 5) — 主要結果
- “Patients’ fear of falling also decreased over the 12-week follow-up” (p. 6)
> "Falls decreased by 30% in every ward we studied" (p. 9)
- 「結果顯示，介入組的跌倒發生率顯著低於對照組」（p. 7）
- 說明文字（沒有引號，不查證）

## 關鍵概念
- "Fall prevention" is not a quote section line`;

test("verifyQuotes marks found and missing quotes and leaves other sections alone", () => {
	let r = verify.verifyQuotes(NOTE, { fullText: PDF_TEXT, texts: [] });
	assert.equal(r.total, 4);
	assert.equal(r.verified, 3);
	assert.equal(r.notFound, 1);
	assert.equal(r.unchecked, 0);
	assert.match(r.md, /^- "The intervention group showed a significant reduction in falls" \(p\. 5\) — 主要結果 ✅$/m);
	assert.match(r.md, /^- “Patients’ fear of falling also decreased over the 12-week follow-up” \(p\. 6\) ✅$/m);
	assert.match(r.md, /^> "Falls decreased by 30% in every ward we studied" \(p\. 9\) ⚠️ 未在全文中找到$/m);
	assert.match(r.md, /^- 「結果顯示，介入組的跌倒發生率顯著低於對照組」（p\. 7） ✅$/m);
	assert.match(r.md, /^- 說明文字（沒有引號，不查證）$/m);
	assert.match(r.md, /^- "Fall prevention" is not a quote section line$/m);
	assert.equal(verify.summarize(r), "可引用句 4 句：✅ 3、⚠️ 1 句未在全文中找到");
	// Re-verifying replaces the old marks instead of stacking them
	let again = verify.verifyQuotes(r.md, { fullText: PDF_TEXT });
	assert.equal(again.md, r.md);
});

test("verifyQuotes without full text: annotations still verify, the rest is unchecked", () => {
	let r = verify.verifyQuotes(NOTE, { fullText: "", texts: ["Falls decreased by 30% in every ward we studied", null] });
	assert.equal(r.hasFullText, false);
	assert.equal(r.verified, 1);
	assert.equal(r.unchecked, 3);
	assert.equal(r.notFound, 0);
	assert.match(r.md, /\(p\. 9\) ✅$/m);
	assert.match(r.md, /\(p\. 5\) — 主要結果 ⚠️ 無全文可查證$/m);
	assert.equal(verify.summarize(r), "可引用句 4 句：✅ 1、⚠️ 3 句無全文可查證");
});

test("verifyQuotes: no quotes section, deeper headings and fenced blocks", () => {
	let none = verify.verifyQuotes("## 一句話摘要\nx", { fullText: PDF_TEXT });
	assert.equal(none.total, 0);
	assert.equal(none.md, "## 一句話摘要\nx");
	assert.equal(verify.summarize(none), "");
	let md = "### 可引用的句子\n- \"reduction in falls\" (p. 5)\n\n```json\n{\"a\": \"not a quote\"}\n```";
	let r = verify.verifyQuotes(md, { fullText: PDF_TEXT });
	assert.equal(r.total, 1);
	assert.match(r.md, /```json\n\{"a": "not a quote"\}\n```$/);
});
