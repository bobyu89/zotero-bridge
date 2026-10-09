// Full text as Markdown (content/fulltext-md.js): conversion, trimming for the AI, highlights marked
// in place, the full-text note and Notion chunking.
const test = require("node:test");
const assert = require("node:assert/strict");
const F = require("../content/fulltext-md.js");
const markdown = require("../content/markdown.js");

// Text shaped like Zotero's PDF worker output: one paragraph per line, "\n\n\f" between pages
function workerText(pages) {
	return pages.map(lines => lines.join("\n") + "\n\n").join("\f").trim();
}

const BODY = "Falls are a leading cause of injury among older adults living in the community and in hospitals.";

test("headingId: English and Chinese section names, numbered, capitals, letter-spaced; not sentences", () => {
	for (let [line, id] of [
		["Abstract", "abstract"], ["ABSTRACT", "abstract"], ["Background", "background"], ["1. Introduction", "background"],
		["2 Methods", "methods"], ["2.1. Materials and Methods", "methods"], ["Methods:", "methods"], ["III. RESULTS", "results"],
		["Discussion", "discussion"], ["Conclusions", "conclusion"], ["Conclusion", "conclusion"], ["Limitations", "limitations"],
		["Strengths and limitations", "limitations"], ["References", "references"], ["R E F E R E N C E S", "references"],
		["Acknowledgements", "acknowledgements"], ["Acknowledgments", "acknowledgements"], ["Funding", "funding"],
		["Conflict of interest", "coi"], ["Conflicts of Interest", "coi"], ["Declaration of competing interest", "coi"],
		["摘要", "abstract"], ["前言", "background"], ["壹、緒論", "background"], ["研究方法", "methods"], ["二、方法", "methods"],
		["結果", "results"], ["討論", "discussion"], ["結論", "conclusion"], ["研究限制", "limitations"], ["參 考 文 獻", "references"],
		["參考文獻", "references"], ["誌謝", "acknowledgements"],
	]) {
		assert.equal(F.headingId(line), id, line);
	}
	for (let line of ["Methods: we recruited 120 patients from two wards.", "The results were significant.", "", "Results of the trial in the community and the hospital wards"]) {
		assert.equal(F.headingId(line), null, line);
	}
});

test("joinHyphenBreaks: rejoins line-break hyphenation, keeps real hyphens and 'pre- and post-'", () => {
	assert.equal(F.joinHyphenBreaks("a twelve week interven- tion was"), "a twelve week intervention was");
	assert.equal(F.joinHyphenBreaks("interven-\ntion"), "intervention");
	assert.equal(F.joinHyphenBreaks("evidence-based practice"), "evidence-based practice");
	assert.equal(F.joinHyphenBreaks("pre- and post-test scores"), "pre- and post-test scores");
	assert.equal(F.joinHyphenBreaks("self- reported falls"), "self-reported falls");
	assert.equal(F.joinHyphenBreaks("soft\u00adhyphen"), "softhyphen");
	assert.equal(F.joinHyphenBreaks("Mann- Whitney"), "Mann- Whitney", "a capital after the break is not a syllable");
});

test("toMarkdown: running headers, footers and page numbers go; headings, hyphenation and page-spanning paragraphs are fixed", () => {
	let head = i => `Journal of Advanced Nursing. 2024;80:${100 + i}–${101 + i}`;
	let stamp = i => `Downloaded from https://onlinelibrary.wiley.com/doi/10.1111/jan.${i} by Test University, Wiley Online Library on [0${i}/01/2025]`;
	// The last paragraph of each page goes on at the top of the next one
	let pages = [
		[head(1), "Abstract", "Background: falls are common.", BODY,
			"We randomised the participants to a twelve week exercise interven- tion delivered by nurses, and the", stamp(1), "1"],
		[head(2), "Chen et al.", "follow-up lasted twelve months.", BODY, "2. Methods", "Participants who could walk without help", stamp(2), "2"],
		[head(3), "Chen et al.", "were recruited in four wards.", BODY, "The trial", stamp(3), "3"],
		[head(4), "Chen et al.", "ended in May.", BODY, "Data were analysed by intention to treat.", stamp(4), "4"],
		[head(5), "Chen et al.", "Most falls happened at night.", stamp(5), "5"],
	];
	pages.push(["References", "1. Smith J. Falls in older adults. 2020.", "2. Lee A. Exercise. 2021.", "6"]);
	let { md, stats } = F.toMarkdown(workerText(pages));
	assert.equal(stats.pages, 6);
	assert.doesNotMatch(md, /Journal of Advanced Nursing/, "running head on every page");
	assert.doesNotMatch(md, /Downloaded from/, "download stamp on every page");
	assert.doesNotMatch(md, /^\d+$/m, "bare page numbers");
	assert.match(md, /^## Abstract$/m);
	assert.match(md, /^## 2\. Methods$/m);
	assert.match(md, /^## References$/m);
	assert.match(md, /^We randomised the participants to a twelve week exercise intervention delivered by nurses, and the follow-up lasted twelve months\.$/m, "hyphenation, and the paragraph continued on the next page");
	assert.match(md, /^Participants who could walk without help were recruited in four wards\.$/m);
	assert.equal((md.match(new RegExp(BODY.replace(/\./g, "\\."), "g")) || []).length, 4, "a whole sentence repeated at page edges is body text: kept");
	assert.equal(stats.headings.map(h => h.id).join(","), "abstract,methods,references");
	assert.ok(stats.removedLines >= 12);
	// "Chen et al." repeats on 4 of 6 pages at the top: a running head too
	assert.doesNotMatch(md, /Chen et al\./);
});

test("toMarkdown is conservative: body text that repeats on few pages, numbers inside a page and odd input stay", () => {
	let pages = [
		["Table 1 Baseline characteristics", "Age", "72", "Sex", BODY],
		["Table 1 Baseline characteristics", "The same caption on two pages is not a running head.", BODY],
		["Results were stable across sites.", "12", "Last paragraph of the paper."],
	];
	let { md } = F.toMarkdown(workerText(pages));
	assert.equal((md.match(/Table 1 Baseline characteristics/g) || []).length, 2, "only two pages: kept");
	assert.match(md, /^72$/m, "a number in the middle of a page is a table cell, not a page number");
	assert.match(md, /^12$/m);
	assert.equal(F.toMarkdown("").md, "");
	assert.equal(F.toMarkdown("   \n\f  ").md, "");
	let odd = F.toMarkdown("# not a heading\n> not a quote\n==not a highlight== and %%no comment%% and [[no link]]\n---").md;
	assert.match(odd, /^\\# not a heading$/m);
	assert.match(odd, /^\\> not a quote$/m);
	assert.match(odd, /=\\=not a highlight=\\=/);
	assert.match(odd, /%\\%no comment%\\%/);
	assert.match(odd, /\[\\\[no link\]\]/);
	assert.match(odd, /^\\---$/m);
	// Nothing of the body is lost
	assert.equal(F.toMarkdown(workerText([[BODY]])).md, BODY);
});

test("toMarkdown: hard-wrapped text (pdftotext, markitdown) is joined into paragraphs; markitdown tables stay", () => {
	let wrapped = [
		"Introduction",
		"",
		"Falls are a leading cause of injury among older",
		"adults and nurses can deliver structured exer-",
		"cise safely in primary care.",
		"",
		"護理人員可以在社區",
		"安全地提供運動課程。",
		"",
		"| Group | n | Falls |",
		"| --- | --- | --- |",
		"| Exercise | 60 | 12 |",
		"",
		"Discussion",
		"",
		"The intervention reduced falls by thirty",
		"percent.",
	].join("\n");
	assert.equal(F.isWrapped(wrapped.split("\n")), true);
	let { md } = F.toMarkdown(wrapped, { source: "markitdown" });
	assert.match(md, /^## Introduction$/m);
	assert.match(md, /^Falls are a leading cause of injury among older adults and nurses can deliver structured exercise safely in primary care\.$/m);
	assert.match(md, /^護理人員可以在社區安全地提供運動課程。$/m, "CJK lines join without a space");
	assert.match(md, /^\| Group \| n \| Falls \|\n\| --- \| --- \| --- \|\n\| Exercise \| 60 \| 12 \|$/m, "table rows stay one table");
	assert.match(md, /^The intervention reduced falls by thirty percent\.$/m);
	// The worker's one-paragraph-per-line text is not "wrapped"
	assert.equal(F.isWrapped(["First paragraph ends here.", "Second paragraph.", "Third one.", "Fourth."]), false);
});

test("trimForAI: cuts References, Acknowledgements, Funding and COI; keeps tables after the references and misplaced headings", () => {
	let body = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} of the results with enough words to count as body text.`).join("\n\n");
	let md = [
		"## Abstract", "Short abstract.", "## Results", body, "## Conclusions", "Exercise works.",
		"## Acknowledgements", "We thank the nurses.", "## Funding", "Grant 123.", "## Conflict of interest", "None declared.",
		"## References", "1. Smith J. 2020.", "2. Lee A. 2021.", "Table 2 Outcomes at 12 months", "Falls 12 vs 20",
	].join("\n\n");
	let t = F.trimForAI(md);
	assert.deepEqual(t.cut.map(c => c.id), ["acknowledgements", "funding", "coi", "references"]);
	assert.doesNotMatch(t.md, /We thank|Grant 123|None declared|Smith J\./);
	assert.match(t.md, /Exercise works\./);
	assert.match(t.md, /Table 2 Outcomes at 12 months\n\nFalls 12 vs 20$/, "results printed after the reference list stay");
	assert.equal(t.before, md.length);
	assert.equal(t.after, t.md.length);
	assert.ok(t.after < t.before);
	assert.equal(F.describeCut(t.cut), "Acknowledgements、Funding、Conflict of interest、References");

	// A "References" heading early in the text is a misread heading: nothing is cut
	let early = ["## References", "see below", "## Results", body].join("\n\n");
	assert.deepEqual(F.trimForAI(early).cut, []);
	// A Funding section that runs on for pages (its next heading wasn't found) is left alone
	let long = ["## Results", "x", "## Funding", body, body].join("\n\n");
	assert.deepEqual(F.trimForAI(long).cut, []);
	assert.equal(F.trimForAI("").md, "");
});

test("markHighlights: exact and fuzzy matches marked in place, line by line; overlaps and duplicates; the rest listed", () => {
	let md = [
		"## Results",
		"The intervention reduced the rate of falls by thirty percent compared with usual care.",
		"Adherence was high and no serious adverse events were reported.",
		"Falls were rare. Falls were rare.",
		"護理人員可以安全地提供運動課程。",
	].join("\n\n");
	let items = [
		// Line breaks and hyphenation from the PDF reader's copy of the highlight
		{ id: "a", text: "reduced the rate of falls by thirty per-\ncent", open: "==🟡", close: "==" },
		// Spans two paragraphs: each line is wrapped on its own
		{ id: "b", text: "compared with usual care. Adherence was high", open: "==🔴", close: "==" },
		// One word different (OCR): still found (≥ 90% of the words)
		{ id: "c", text: "and no serious adverse events were reported in either group of the trial", open: "==🟢", close: "==" },
		{ id: "d", text: "Falls were rare.", open: "==🔵", close: "==" },
		{ id: "e", text: "Falls were rare.", open: "==🔵", close: "==" },
		{ id: "f", text: "護理人員可以安全地提供運動課程", open: "==🟣", close: "==" },
		{ id: "g", text: "a sentence that is not in the paper", open: "==", close: "==" },
		{ id: "ai", text: "The intervention reduced … usual care", open: "🤖<u>", close: "</u>" },
	];
	let r = F.markHighlights(md, items);
	assert.match(r.md, /The intervention ==🟡reduced the rate of falls by thirty percent== ==🔴compared with usual care\.==/);
	assert.match(r.md, /^==🔴Adherence was high== and no serious/m);
	assert.match(r.md, /==🔵Falls were rare==\. ==🔵Falls were rare==\./, "a second identical highlight goes to the next occurrence");
	assert.match(r.md, /==🟣護理人員可以安全地提供運動課程==。/);
	assert.deepEqual(r.missing.map(m => m.id), ["c", "g", "ai"], "too different, absent, and overlapping the user's own marks");
	assert.deepEqual(r.located, ["a", "b", "d", "e", "f"]);
	// Headings keep their "## "
	let h = F.markHighlights("## Results\n\nText.", [{ id: "x", text: "Results Text", open: "==", close: "==" }]);
	assert.equal(h.md, "## ==Results==\n\n==Text==.");
});

test("markHighlights: AI quotes get their own marker that survives the Notion conversion", () => {
	let md = "The intervention reduced falls (p < 0.05) in older adults.";
	let r = F.markHighlights(md, [
		{ id: "u", text: "older adults", open: "==🟡", close: "==" },
		{ id: "ai", text: "The intervention reduced falls (p < 0.05)", open: "🤖<u>", close: "</u>" },
	]);
	assert.equal(r.md, "🤖<u>The intervention reduced falls (p < 0.05</u>) in ==🟡older adults==.");
	let rich = markdown.mdToNotionBlocks(r.md)[0].paragraph.rich_text;
	assert.deepEqual(rich.map(x => [x.text.content, x.annotations || null]), [
		["🤖", null],
		["The intervention reduced falls (p < 0.05", { underline: true }],
		[") in ", null],
		["older adults", { color: "yellow_background" }],
		[".", null],
	]);
	assert.equal(F.containsQuote(md, "intervention reduced falls"), true);
	assert.equal(F.containsQuote(md, "made up"), false);
});

test("buildFullTextNote: managed note without zotero_key, a small callout, legend and the highlights it couldn't place", () => {
	let note = F.buildFullTextNote({
		zoteroKey: "library/ABCD1234", title: "Falls RCT", md: "## Results\n\n==🟡Falls decreased==.",
		noteLink: "Zotero/chen2024", legend: [{ emoji: "🟡", meaning: "重要發現" }], aiLegend: true, source: "markitdown",
		missing: [{ text: "lost  text", emoji: "🔴", meaning: "限制／疑問", page: "7" }],
	});
	assert.match(note, /^---\nfulltext_of: "library\/ABCD1234"\nfulltext_source: "markitdown"\n---\n/);
	assert.doesNotMatch(note, /zotero_key/, "the vault index and Bases only list literature notes");
	assert.match(note, /^> \[!info\] 全文・由 ZotMax 產生\n> 每次同步都會重新產生，請不要在這裡寫字；想法寫在文獻筆記 \[\[Zotero\/chen2024\|文獻筆記\]\]。\n> 劃線：🟡 重要發現 · 🤖 底線＝AI 標的重點（僅供參考）$/m);
	assert.match(note, /^# Falls RCT$/m);
	assert.match(note, /## 沒有在全文中找到位置的劃線\n\n.*\n\n- ==🔴lost text== — 限制／疑問 · p\. 7\n$/);
	// Nothing time-based: the same input gives the same file (no rewrite on every sync)
	assert.equal(F.buildFullTextNote({ zoteroKey: "k", title: "t", md: "x", noteLink: "n" }), F.buildFullTextNote({ zoteroKey: "k", title: "t", md: "x", noteLink: "n" }));
	assert.equal(F.missingSection([]), "");
});

test("notionChunks and the full text's blocks respect Notion's limits", () => {
	let long = "長".repeat(4500);
	let md = Array.from({ length: 250 }, (_, i) => (i % 50 === 0 ? `## Section ${i}` : `Paragraph ${i} ==🟡marked== ${i === 7 ? long : ""}`)).join("\n\n");
	let blocks = markdown.mdToNotionBlocks(md);
	for (let b of blocks) {
		for (let r of b[b.type].rich_text) assert.ok(r.text.content.length <= 2000);
		assert.ok(b[b.type].rich_text.length <= 100);
	}
	let chunks = F.notionChunks(blocks);
	assert.ok(chunks.every(c => c.length <= 100));
	assert.equal(chunks.flat().length, blocks.length, "nothing lost or duplicated");
	assert.deepEqual(chunks.flat(), blocks, "order kept");
	// The payload cap splits earlier than 100 blocks when the text is large (CJK is 3 bytes a character)
	let big = Array.from({ length: 60 }, () => ({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: "字".repeat(2000) } }] } }));
	let parts = F.notionChunks(big, { maxBytes: 100000 });
	assert.ok(parts.length > 1);
	assert.ok(parts.every(c => new TextEncoder().encode(JSON.stringify(c)).length <= 100000 + 7000));
	assert.deepEqual(F.notionChunks([]), []);
});

test("hash: stable and sensitive", () => {
	assert.equal(F.hash("abc"), F.hash("abc"));
	assert.notEqual(F.hash("abc"), F.hash("abd"));
	assert.notEqual(F.hash(""), F.hash(" "));
});
