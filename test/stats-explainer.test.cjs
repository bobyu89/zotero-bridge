// 讀懂統計 (content/stats-explainer.js), the pure parts: the Methods / Statistical analysis excerpt, the
// prompt, parsing the model's JSON (also malformed or cut off), the number check, the history record
// in the child note, and appending to the literature note's 「統計筆記」 so that a re-sync keeps it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const S = require("../content/stats-explainer.js");
const core = require("../content/core.js");
const F = require("../content/fulltext-md.js");

const ROOT = path.join(__dirname, "..");

const PAPER_MD = [
	"## Abstract", "", "Falls are common. The intervention reduced falls (RR 0.70).", "",
	"## Methods", "", "This randomised controlled trial enrolled 240 adults aged 65 years or older.", "",
	"Participants were allocated 1:1 by computer-generated blocks.", "",
	"Statistical analysis", "", "Analyses followed the intention-to-treat principle. Odds ratios (OR) with 95% confidence intervals were estimated by logistic regression; a two-sided P < 0.05 was considered significant.", "",
	"## Results", "", "Falls occurred in 18% of the intervention group and 26% of controls (OR 0.62, 95% CI 0.39–0.98; p = .04).", "",
	"## References", "", "1. Someone (2020).",
].join("\n");

const SELECTION = "Falls occurred in 18% of the intervention group and 26% of controls (OR 0.62, 95% CI 0.39–0.98; p = .04).";

// ---------- excerpt and prompt ----------

test("methodsExcerpt: the Statistical analysis paragraphs, with the start of the methods when there is room", () => {
	let ex = S.methodsExcerpt(PAPER_MD);
	assert.equal(ex.kind, "statistics");
	assert.match(ex.text, /intention-to-treat principle/);
	assert.match(ex.text, /^This randomised controlled trial enrolled 240/, "design and participants first");
	assert.doesNotMatch(ex.text, /Falls occurred in 18%/, "not the results");
	assert.doesNotMatch(ex.text, /Someone \(2020\)/, "not the references");
	// Methods without a statistics paragraph: from the top, cut at the limit
	let plain = S.methodsExcerpt("## Methods\n\n" + "A long methods paragraph. ".repeat(400) + "\n\n## Results\n\nx");
	assert.equal(plain.kind, "methods");
	assert.ok(plain.text.length <= 6001, String(plain.text.length));
	assert.match(plain.text, /…$/);
	// A statistics heading the converter didn't recognise as a section: found anyway
	let loose = S.methodsExcerpt("Intro text.\n\n2.4 Statistical analyses\n\nWe used Cox models (HR).");
	assert.equal(loose.kind, "statistics");
	assert.match(loose.text, /Cox models/);
	// Chinese headings
	let zh = S.methodsExcerpt("## 研究方法\n\n本研究為類實驗設計。\n\n統計分析\n\n以 t 檢定比較兩組。\n\n## 結果\n\n略");
	assert.match(zh.text, /以 t 檢定比較兩組/);
	assert.deepEqual(S.methodsExcerpt(""), { text: "", kind: "" });
	// The excerpt reads the converter's own Markdown headings
	let md = F.toMarkdown("Title\nMethods\nWe randomised people.\nStatistical analysis\nWe used chi-square tests.\nResults\nIt worked.").md;
	assert.match(S.methodsExcerpt(md).text, /chi-square/);
});

test("buildPrompt: fixed system block, the selection and the methods excerpt; the abstract only without methods", () => {
	let ex = S.methodsExcerpt(PAPER_MD);
	let p = S.buildPrompt({ selection: SELECTION, methods: ex.text, methodsKind: ex.kind, abstract: "Abstract text 99.", study: { study_design: "RCT", sample_size: 240 }, title: "Exercise and falls" });
	assert.deepEqual(p.system, [S.SYSTEM_PROMPT], "one cacheable block, the same for every call");
	assert.match(p.user, /<selection>\nFalls occurred in 18%/);
	assert.match(p.user, /<methods source="方法與統計分析段落的節錄">\nThis randomised/);
	assert.match(p.user, /<study>研究設計：RCT；樣本數：240（來自 AI 文獻筆記，只供理解脈絡）<\/study>/);
	assert.doesNotMatch(p.user, /Abstract text 99/, "the methods are there: no abstract");
	assert.deepEqual(p.sources, [SELECTION, ex.text], "what numbers may come from");
	// The system prompt: who it is for, the four parts, the number rules
	for (let re of [/護理研究所學生/, /繁體中文/, /"terms"/, /"restatement"/, /"clinical"/, /"cautions"/, /原樣出現在 <selection>/, /不要計算新的數字/, /0 和 1/]) {
		assert.match(S.SYSTEM_PROMPT, re);
	}
	// No full text: the abstract instead
	let q = S.buildPrompt({ selection: "OR 2.1", abstract: "We found OR 2.1 (95% CI 1.1-4.0)." });
	assert.match(q.user, /<abstract>\nWe found OR 2.1/);
	assert.deepEqual(q.sources, ["OR 2.1", "We found OR 2.1 (95% CI 1.1-4.0)."]);
	let none = S.buildPrompt({ selection: "OR 2.1" });
	assert.match(none.user, /沒有全文也沒有摘要/);
	assert.deepEqual(none.sources, ["OR 2.1"]);
	// A huge selection is cut
	assert.ok(S.buildPrompt({ selection: "x".repeat(9000) }).sources[0].length < 4100);
});

test("buildSimplerPrompt: the same system prompt, the selection and the checked explanation; the removed marker is not sent as is", () => {
	let entry = {
		selection: { text: SELECTION },
		explanation: { terms: [{ term: "OR", what: "勝算比", here: `是 0.62，NNT ${S.REMOVED}` }], restatement: "介入組比較少跌倒。", clinical: "", cautions: [] },
	};
	let p = S.buildSimplerPrompt(entry);
	assert.deepEqual(p.system, [S.SYSTEM_PROMPT]);
	assert.match(p.user, /<previous>\n- OR：勝算比 在這段裡：是 0.62，NNT （已移除）/);
	assert.match(p.user, /更簡單的說法/);
	assert.equal(p.sources[0], SELECTION);
});

// ---------- parsing ----------

test("parseResponse: clean JSON, code fences, prose around it, trailing commas, Chinese keys", () => {
	let json = { terms: [{ term: "OR", what: "勝算比", here: "0.62" }], restatement: "r", clinical: "c", cautions: ["a", "b"] };
	assert.deepEqual(S.parseResponse(JSON.stringify(json)).explanation, json);
	let fenced = S.parseResponse("好的，以下是解釋：\n```json\n" + JSON.stringify(json, null, 2).replace(/"b"\n/, "\"b\",\n") + "\n```\n希望有幫助");
	assert.equal(fenced.ok, true);
	assert.deepEqual(fenced.explanation, json);
	let zh = S.parseResponse(JSON.stringify({ 這是什麼: [{ 名稱: "p 值", 說明: "機率", 在這段裡: "p = .04" }], 這段在說什麼: "r", 臨床上代表什麼: "c", 要注意的地方: "第一點\n- 第二點" }));
	assert.deepEqual(zh.explanation, { terms: [{ term: "p 值", what: "機率", here: "p = .04" }], restatement: "r", clinical: "c", cautions: ["第一點", "第二點"] });
	// terms as a map, a string term
	let map = S.parseResponse(JSON.stringify({ terms: { OR: "勝算比", CI: { what: "信賴區間", here: "0.39–0.98" } }, restatement: "r" }));
	assert.deepEqual(map.explanation.terms, [{ term: "OR", what: "勝算比", here: "" }, { term: "CI", what: "信賴區間", here: "0.39–0.98" }]);
	assert.deepEqual(S.parseResponse(JSON.stringify({ terms: ["ITT"] })).explanation.terms, [{ term: "ITT", what: "", here: "" }]);
});

test("parseResponse: partial and malformed answers keep what is there", () => {
	// Cut off mid-string (max_tokens): repaired, marked truncated
	let cut = S.parseResponse("{\"terms\":[{\"term\":\"OR\",\"what\":\"勝算比\"}],\"restatement\":\"介入組跌倒比較少，因為\n\n> ⚠️ 輸出達到長度上限，內容可能不完整。");
	assert.equal(cut.ok, true);
	assert.equal(cut.truncated, true);
	assert.deepEqual(cut.explanation.terms, [{ term: "OR", what: "勝算比", here: "" }]);
	assert.equal(cut.explanation.restatement, "介入組跌倒比較少，因為");
	// Cut after a key
	let key = S.parseResponse("{\"restatement\":\"r\",\"clinical\":");
	assert.equal(key.ok, true);
	assert.equal(key.explanation.restatement, "r");
	// Missing fields are empty, not errors
	let some = S.parseResponse("{\"restatement\":\"只有這個\"}");
	assert.deepEqual(some.explanation, { terms: [], restatement: "只有這個", clinical: "", cautions: [] });
	// Not JSON at all: the text, flagged
	let prose = S.parseResponse("這段在說介入有效。");
	assert.equal(prose.ok, false);
	assert.match(prose.error, /沒有照格式/);
	assert.equal(prose.explanation.restatement, "這段在說介入有效。");
	// Empty object, nonsense types
	assert.equal(S.parseResponse("{}").ok, false);
	assert.deepEqual(S.parseResponse("{\"terms\": 5, \"cautions\": null, \"clinical\": {\"x\": 1}}").explanation, { terms: [], restatement: "", clinical: "", cautions: [] });
	assert.ok(S.repairJSON("{\"a\":[1,2").endsWith("]}"));
	assert.equal(JSON.parse(S.repairJSON("{\"a\":\"x\\")).a, "x");
});

// ---------- the number check ----------

test("extractNumbers: decimals, middle dots, .001, percentages, thousands, ranges, full-width digits and Chinese punctuation", () => {
	let values = text => S.extractNumbers(text).map(n => n.value);
	assert.deepEqual(values("OR 1.8 (95% CI 1.2–2.6)"), ["1.8", "95", "1.2", "2.6"]);
	assert.deepEqual(values("RR 1·8 (95% CI 1·2–2·6)"), ["1.8", "95", "1.2", "2.6"], "the Lancet's middle dot");
	assert.deepEqual(values("p<.001; P = 0.001; p<0.05"), ["0.001", "0.001", "0.05"]);
	assert.deepEqual(values("1.2-2.6 and 1.2 to 2.6"), ["1.2", "2.6", "1.2", "2.6"]);
	assert.deepEqual(values("N = 1,234; 12,345.6 mg; 1,2 and 3"), ["1234", "12345.6", "1", "2", "3"]);
	assert.deepEqual(values("勝算比為１.８，信賴區間１．２至２．６；ｐ＝０.０４。"), ["1.8", "1.2", "2.6", "0.04"]);
	assert.deepEqual(values("差值 −0.45（−0.80 至 −0.10）"), ["0.45", "0.8", "0.1"], "signs are not part of the value");
	assert.deepEqual(values("1.80 and 01.8"), ["1.8", "1.8"]);
	assert.deepEqual(values("I² = 45%; log₁₀"), ["45"], "superscript and subscript digits are notation");
	assert.deepEqual(values("COVID-19 and SF-36"), ["19", "36"]);
	let n = S.extractNumbers("p＝０.０４")[0];
	assert.equal(n.raw, "０.０４", "positions are those of the original text");
});

test("checkExplanation: numbers from the selection or the excerpt stay; invented ones are removed and counted per part", () => {
	let sources = [SELECTION, "Odds ratios (OR) with 95% confidence intervals; a two-sided P < 0.05."];
	let ex = {
		terms: [
			{ term: "OR", what: "勝算比", here: "OR 0.62：介入組跌倒的勝算是對照組的 0.62 倍" },
			{ term: "95% CI", what: "信賴區間", here: "0.39 到 0.98，沒有跨過 1" },
			{ term: "NNT", what: "需治數", here: "約 8 人（1 ÷ 0.08 算出）" },
		],
		restatement: "介入組 18%、對照組 26% 跌倒；p 值 .04，小於 0.05。",
		clinical: "大約可以少 30% 的跌倒。",
		cautions: ["信賴區間上限 0.98 很接近 1。", "樣本 240 人。"],
	};
	let r = S.checkExplanation(ex, sources);
	assert.equal(r.explanation.terms[0].here, "OR 0.62：介入組跌倒的勝算是對照組的 0.62 倍");
	assert.equal(r.explanation.terms[1].here, "0.39 到 0.98，沒有跨過 1", "1 is a null value: allowed");
	assert.equal(r.explanation.terms[2].here, `約 ${S.REMOVED} 人（1 ÷ ${S.REMOVED} 算出）`, "a calculated NNT is not in the text");
	assert.equal(r.explanation.restatement, "介入組 18%、對照組 26% 跌倒；p 值 .04，小於 0.05。");
	assert.equal(r.explanation.clinical, `大約可以少 ${S.REMOVED} 的跌倒。`, "the % goes with the number");
	assert.deepEqual(r.explanation.cautions, ["信賴區間上限 0.98 很接近 1。", `樣本 ${S.REMOVED} 人。`], "240 is in the methods, but they weren't sent");
	assert.deepEqual(r.removed, { terms: 2, restatement: 0, clinical: 1, cautions: 1 });
	assert.equal(r.total, 4);
	// Formats differ between text and answer: still the same numbers
	let same = S.checkExplanation({ restatement: "RR 為 1.8（95% CI 1.2 至 2.6），p 值 0.001，差值 0.45" }, ["RR 1·80 (95% CI 1·2–2·6); p<.001; difference −0.45"]);
	assert.equal(same.total, 0, JSON.stringify(same));
	// Chinese punctuation around numbers, full-width digits in the answer
	let zh = S.checkExplanation({ restatement: "勝算比１.８，信賴區間１.２～２.６。" }, ["OR 1.8 (1.2-2.6)"]);
	assert.equal(zh.total, 0);
	// A rounded number is not the text's number
	let rounded = S.checkExplanation({ restatement: "OR 約 0.6" }, ["OR 0.62"]);
	assert.equal(rounded.explanation.restatement, `OR 約 ${S.REMOVED}`);
	// 0 and 1 only
	assert.equal(S.checkExplanation({ restatement: "跨過 0 或 1" }, [""]).total, 0);
	assert.equal(S.checkExplanation({ restatement: "門檻 0.05" }, [""]).total, 1, "a conventional threshold is still a number the text didn't give");
});

// ---------- history and the child note ----------

function entry(i, extra = {}) {
	return Object.assign({
		id: `e${i}`, at: `2026-10-0${i}T08:00:00Z`, model: "test-model",
		selection: { text: `selection ${i} OR 1.${i}`, pageLabel: String(i), pageIndex: i - 1, rects: [[1, 2, 3, 4]], attachmentKey: "ABCD1234" },
		context: "statistics",
		explanation: { terms: [{ term: "OR", what: "勝算比", here: `1.${i}` }], restatement: `r${i}`, clinical: "c", cautions: ["x"] },
		removed: { terms: 0, restatement: 0, clinical: i === 2 ? 1 : 0, cautions: 0 },
	}, extra);
}

test("history: newest first, the last five kept, stored as JSON in the child note and read back", () => {
	let record = S.normalizeRecord(null);
	for (let i = 1; i <= 7; i++) record = S.addEntry(record, entry(i <= 9 ? i : 9));
	assert.equal(record.entries.length, S.MAX_HISTORY);
	assert.deepEqual(record.entries.map(e => e.id), ["e7", "e6", "e5", "e4", "e3"]);
	record = S.updateEntry(record, "e5", { savedAt: "2026-10-09T00:00:00Z", simpler: { at: "2026-10-09T01:00:00Z", model: "m", explanation: { restatement: "簡單說" } } });
	let html = S.noteHTML(record, { title: "Exercise <and> falls" });
	assert.match(html, /<h1>📊 統計解釋<\/h1>/);
	assert.match(html, /Exercise &lt;and&gt; falls/);
	assert.match(html, /<blockquote><p>selection 7 OR 1.7<\/p><\/blockquote>/);
	assert.match(html, /<strong>簡單版<\/strong>：簡單說/);
	let back = S.readNoteHTML(html);
	assert.deepEqual(back, record);
	assert.equal(back.entries[2].savedAt, "2026-10-09T00:00:00Z");
	assert.equal(back.entries[2].simpler.explanation.restatement, "簡單說");
	// Zotero's note editor may rewrite the HTML around the <pre>: entities still decode
	assert.deepEqual(S.readNoteHTML(`<div data-schema-version="9">${html.replace(/\n/g, "")}</div>`), record);
	// Broken or foreign JSON: nothing
	assert.equal(S.readNoteHTML("<pre>{not json</pre>"), null);
	assert.equal(S.readNoteHTML("<pre>{\"format\":\"zotero-bridge-appraisal\"}</pre>"), null);
	// Junk entries are dropped, fields cleaned
	let clean = S.normalizeRecord({ entries: [null, { selection: {} }, { id: "x", selection: { text: "ok", attachmentKey: "../../etc", rects: [[1, 2], "x"] }, removed: { terms: -3 } }] });
	assert.equal(clean.entries.length, 1);
	assert.equal(clean.entries[0].selection.attachmentKey, "");
	assert.deepEqual(clean.entries[0].selection.rects, []);
	assert.equal(clean.entries[0].removed.terms, 0);
});

// ---------- the literature note ----------

test("entryMarkdown and pdfLink: quote, the four parts, the simpler version and a link back to the page", () => {
	let e = entry(2, { simpler: { at: "2026-10-09", model: "m", explanation: { restatement: "簡單說", clinical: "少跌一點" } } });
	let link = S.pdfLink("library", S.normalizeRecord({ entries: [e] }).entries[0].selection);
	assert.equal(link, "zotero://open-pdf/library/items/ABCD1234?page=2");
	assert.equal(S.pdfLink("groups/7", { attachmentKey: "ABCD1234", pageLabel: "iv", pageIndex: 3 }), "zotero://open-pdf/groups/7/items/ABCD1234?page=4");
	assert.equal(S.pdfLink("library", { attachmentKey: "" }), "");
	let md = S.entryMarkdown(e, link);
	assert.match(md, /^\*\*2026-10-02 · p\. 2\*\* · \[回到 PDF\]\(zotero:\/\/open-pdf\/library\/items\/ABCD1234\?page=2\)/);
	assert.match(md, /\n> selection 2 OR 1\.2\n/);
	assert.match(md, /\*\*這是什麼\*\*\n- \*\*OR\*\*：勝算比 在這段裡：1\.2/);
	assert.match(md, /\*\*這段在說什麼\*\*：r2/);
	assert.match(md, /\*\*臨床上代表什麼\*\*：c/);
	assert.match(md, /\*\*要注意的地方\*\*\n- x/);
	assert.match(md, /\*\*簡單版\*\*：簡單說 少跌一點/);
	assert.match(md, /1 個不在原文裡的數字已移除/);
});

/** A literature note as core.buildObsidianNote writes it for a paper. */
function literatureNote(existing, title = "Exercise and falls") {
	let data = { key: "ABCD1234", libraryPath: "library", title, creators: [], attachments: [], tags: [], collections: [], year: "2024" };
	return core.buildObsidianNote(existing, data, { aiMarkdown: "## 一句話摘要\n運動讓跌倒變少。" });
}

test("appendStatsNote: a new folded 「統計筆記」 callout outside the managed block, then entries appended to it", () => {
	let note = literatureNote(null);
	let once = S.appendStatsNote(note, S.entryMarkdown(entry(1)));
	let calloutAt = once.indexOf("> [!note]- 統計筆記");
	assert.ok(calloutAt > once.indexOf("%% zotero-bridge:end %%"), "after the managed block");
	assert.ok(calloutAt > once.indexOf("## ✍️ 我的筆記"), "in the user's part at the end");
	assert.match(once, /> \[!note\]- 統計筆記\n> ZotMax「讀懂統計」存下的解釋/);
	assert.match(once, /\n> > selection 1 OR 1\.1\n/, "the selection quoted inside the callout");
	let twice = S.appendStatsNote(once, S.entryMarkdown(entry(2)));
	assert.equal(twice.split("[!note]- 統計筆記").length, 2, "one callout");
	assert.ok(twice.indexOf("selection 2") > twice.indexOf("selection 1"), "the new one at the end");
	assert.match(twice, /\n>\n> ---\n>\n> \*\*2026-10-02/);
	// Text the user wrote after the callout stays after it
	let mine = twice + "\n我自己的想法。\n";
	let thrice = S.appendStatsNote(mine, S.entryMarkdown(entry(3)));
	assert.ok(thrice.indexOf("selection 3") < thrice.indexOf("我自己的想法。"));
	assert.match(thrice, /我自己的想法。\n$/);
	// A callout of that name inside the managed block is not the user's: a new one goes outside
	let fake = note.replace("%% zotero-bridge:end %%", "> [!note]- 統計筆記\n> managed\n\n%% zotero-bridge:end %%");
	let out = S.appendStatsNote(fake, S.entryMarkdown(entry(4)));
	assert.equal(out.split("統計筆記").length, 3);
	assert.ok(out.lastIndexOf("[!note]- 統計筆記") > out.indexOf("%% zotero-bridge:end %%"));
	// An empty note
	assert.match(S.appendStatsNote("", "x"), /^> \[!note\]- 統計筆記\n/);
});

test("「統計筆記」 survives re-syncs, including the first re-sync of a note in the old layout", () => {
	// Current layout: sync, save twice, sync again with a changed AI note
	let note = S.appendStatsNote(S.appendStatsNote(literatureNote(null), S.entryMarkdown(entry(1))), S.entryMarkdown(entry(2)));
	let block = note.slice(note.indexOf("> [!note]- 統計筆記"));
	let resynced = core.buildObsidianNote(note, { key: "ABCD1234", libraryPath: "library", title: "Exercise and falls", creators: [], attachments: [], tags: [], collections: [] }, { aiMarkdown: "## 一句話摘要\n改過的摘要。" });
	assert.match(resynced, /改過的摘要/);
	assert.ok(resynced.includes(block), "the callout is unchanged");
	// The v0.9.0 layout (fixture): the callout added to it, then the re-sync into the new layout
	let old = fs.readFileSync(path.join(ROOT, "test", "fixtures", "note-v0.9.0.md"), "utf8");
	let saved = S.appendStatsNote(old, S.entryMarkdown(entry(3)));
	let oldBlock = saved.slice(saved.indexOf("> [!note]- 統計筆記")).trimEnd();
	let { frontmatter } = core.splitFrontmatter(old);
	let key = /zotero_key:\s*"?([^"\n]+)"?/.exec(frontmatter)[1].split("/").pop();
	let upgraded = core.buildObsidianNote(saved, { key, libraryPath: "library", title: "Old note", creators: [], attachments: [], tags: [], collections: [] }, { aiMarkdown: "## 一句話摘要\n新版。" });
	assert.ok(upgraded.includes(oldBlock), "kept through the layout change");
	assert.equal(upgraded.split("[!note]- 統計筆記").length, 2);
	// …and appending again after the upgrade still finds it
	let more = S.appendStatsNote(upgraded, S.entryMarkdown(entry(4)));
	assert.equal(more.split("[!note]- 統計筆記").length, 2);
	assert.ok(more.indexOf("selection 4") > more.indexOf("selection 3"));
	// Without markers (the user removed them) the whole body is the user's: still kept
	let bare = "---\nzotero_key: \"library/ABCD1234\"\n---\n# T\n\nmy text\n";
	let withStats = S.appendStatsNote(bare, "x");
	let again = core.buildObsidianNote(withStats, { key: "ABCD1234", libraryPath: "library", title: "T", creators: [], attachments: [], tags: [], collections: [] }, {});
	assert.match(again, /> \[!note\]- 統計筆記\n/);
});

test("cost: confirm always, only above the threshold (default US$0.05; unpriced models never block), or never", () => {
	assert.equal(S.needsConfirm("always", 0.001, 0.05), true);
	assert.equal(S.needsConfirm("never", 5, 0.05), false);
	assert.equal(S.needsConfirm("above", 0.01, 0.05), false);
	assert.equal(S.needsConfirm("above", 0.06, 0.05), true);
	assert.equal(S.needsConfirm("above", 0.06, "junk"), true, "a broken threshold falls back to the default");
	assert.equal(S.needsConfirm("above", 0.04, "junk"), false);
	assert.equal(S.needsConfirm("above", null, 0.05), false, "no price: the inline estimate shows tokens");
	assert.equal(S.needsConfirm(undefined, 0.06, 0.05), true, "unknown mode = above");
	let usage = require("../content/usage.js");
	let p = S.buildPrompt({ selection: SELECTION, methods: S.methodsExcerpt(PAPER_MD).text });
	let est = S.estimateCall(p, "claude-opus-5-5", usage.DEFAULT_PRICES, usage);
	assert.ok(est.inputTokens > 500 && est.inputTokens < 5000, String(est.inputTokens));
	assert.ok(est.cost > 0 && est.cost < 0.05, `a selection costs a few cents at most: ${est.cost}`);
	assert.equal(S.estimateCall(p, "unpriced-model", usage.DEFAULT_PRICES, usage).cost, null);
});

test("prefs.js and both FTL files have every string, zh-TW identical to the module's text", () => {
	let prefs = fs.readFileSync(path.join(ROOT, "prefs.js"), "utf8");
	assert.match(prefs, /^pref\("extensions\.zotero-bridge\.feature\.statsExplainer", false\);$/m);
	assert.match(prefs, /^pref\("extensions\.zotero-bridge\.statsExplainer\.confirm", "above"\);$/m);
	assert.match(prefs, /^pref\("extensions\.zotero-bridge\.statsExplainer\.confirmAbove", "0\.05"\);$/m);
	let zh = fs.readFileSync(path.join(ROOT, "locale", "zh-TW", "zotero-bridge.ftl"), "utf8");
	let en = fs.readFileSync(path.join(ROOT, "locale", "en-US", "zotero-bridge.ftl"), "utf8");
	for (let [name, [id, text]] of Object.entries(S.STRINGS)) {
		let m = new RegExp(`^${id} = (.+)$`, "m").exec(zh);
		assert.ok(m, `zh-TW ${id}`);
		assert.equal(m[1], text, `zh-TW ${name}`);
		assert.match(en, new RegExp(`^${id} = \\S`, "m"), `en-US ${id}`);
	}
	for (let ftl of [zh, en]) {
		assert.match(ftl, /^zotero-bridge-feature-stats-explainer = \S/m);
		assert.match(ftl, /^zotero-bridge-feature-stats-explainer-desc = \S/m);
		assert.match(ftl, /^zotero-bridge-cmd-explain-stats =\n {4}\.label = \S/m);
		assert.match(ftl, /^zotero-bridge-pane-stats = \S/m);
	}
	// No model names in the module
	let src = fs.readFileSync(path.join(ROOT, "content", "stats-explainer.js"), "utf8");
	assert.doesNotMatch(src, /claude-|gpt-|opus|sonnet|haiku/i);
});
