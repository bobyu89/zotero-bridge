// Scanned PDFs: full-text classification, what is sent to the AI, request shapes, Notion/Obsidian fields
const test = require("node:test");
const assert = require("node:assert/strict");
const scanned = require("../content/scanned.js");
const llm = require("../content/llm.js");
const notion = require("../content/notion.js");
const core = require("../content/core.js");
const verify = require("../content/verify.js");
const { sampleItem, AI_MD } = require("./fixtures.cjs");

const pdfSource = (o = {}) => Object.assign({ key: "P1", isPDF: true, hasFile: true, path: "/s/P1/a.pdf", chars: 0, pages: 0 }, o);

test("classifySource: characters per page decide ok / partial / none", () => {
	assert.equal(scanned.classifySource({ isPDF: true, chars: 0, pages: 12 }), "none");
	// A download stamp on every page of a scan is still a scan
	assert.equal(scanned.classifySource({ isPDF: true, chars: 12 * 90, pages: 12 }), "none");
	assert.equal(scanned.classifySource({ isPDF: true, chars: 12 * 100, pages: 12 }), "partial");
	// One text page out of ten
	assert.equal(scanned.classifySource({ isPDF: true, chars: 4000, pages: 10 }), "partial");
	assert.equal(scanned.classifySource({ isPDF: true, chars: 10 * 600, pages: 10 }), "ok");
	assert.equal(scanned.classifySource({ isPDF: true, chars: 40000, pages: 10 }), "ok");
	// No page count: only an (almost) empty text layer is called a scan
	assert.equal(scanned.classifySource({ isPDF: true, chars: 0, pages: 0 }), "none");
	assert.equal(scanned.classifySource({ isPDF: true, chars: 19, pages: null }), "none");
	assert.equal(scanned.classifySource({ isPDF: true, chars: 50, pages: 0 }), "ok");
	// EPUB / HTML snapshot
	assert.equal(scanned.classifySource({ isPDF: false, chars: 5000 }), "ok");
	assert.equal(scanned.classifySource({ isPDF: false, chars: 10 }), "none");
});

test("classifyFullText: the best attachment wins; no file and no text is no_pdf", () => {
	assert.equal(scanned.classifyFullText([]).status, "no_pdf");
	// A PDF whose file isn't on this computer and has no synced text
	assert.equal(scanned.classifyFullText([pdfSource({ hasFile: false, path: false })]).status, "no_pdf");
	// An HTML snapshot without text is not a scan
	assert.equal(scanned.classifyFullText([{ key: "H", isPDF: false, hasFile: true, chars: 0 }]).status, "no_pdf");
	let scan = pdfSource({ chars: 0, pages: 8 });
	let r = scanned.classifyFullText([scan]);
	assert.equal(r.status, "none");
	assert.equal(r.source.key, "P1");
	assert.equal(r.source.path, "/s/P1/a.pdf");
	// Text article + scanned supplement → ok, described by the article
	r = scanned.classifyFullText([scan, pdfSource({ key: "P2", chars: 30000, pages: 8 })]);
	assert.equal(r.status, "ok");
	assert.equal(r.source.key, "P2");
	assert.equal(scanned.classifyFullText([scan, pdfSource({ key: "P3", chars: 2000, pages: 8 })]).status, "partial");
	// Synced full text of a PDF that isn't downloaded
	assert.equal(scanned.classifyFullText([pdfSource({ hasFile: false, path: false, chars: 30000 })]).status, "ok");
	assert.equal(scanned.countChars(" a b\n\tc "), 3);
});

test("bytesToBase64 matches Node's encoder; countPDFPages counts page objects", () => {
	for (let n of [0, 1, 2, 3, 4, 5, 100, 0x6000 * 3 + 1, 70000]) {
		let bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255);
		assert.equal(scanned.bytesToBase64(bytes), Buffer.from(bytes).toString("base64"), `length ${n}`);
	}
	let pdf = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Pages /Kids [2 0 R 3 0 R] /Count 2 >>\n2 0 obj << /Type /Page >>\n3 0 obj <</Type/Page/Parent 1 0 R>>\n");
	assert.equal(scanned.countPDFPages(new Uint8Array(pdf)), 2);
	assert.equal(scanned.countPDFPages(new Uint8Array(Buffer.from("no pages"))), 0);
});

// io for prepareAIInput: a file of `size` bytes
function fileIO(bytes, calls = []) {
	return {
		stat: async (p) => { calls.push(["stat", p]); return { size: bytes.length }; },
		read: async (p) => { calls.push(["read", p]); return bytes; },
	};
}
const claude = (o = {}) => Object.assign({ provider: "anthropic", fullTextLimit: 150000, sendScannedPDF: true }, o);

test("prepareAIInput sends a scanned PDF to Claude and says so", async () => {
	let bytes = new Uint8Array(Buffer.from("%PDF-1.4 scanned"));
	let calls = [];
	let data = sampleItem({ fullTextStatus: "none", fullTextSource: pdfSource({ pages: 3, filename: "chen.pdf" }) });
	let r = await scanned.prepareAIInput(data, claude(), [], fileIO(bytes, calls));
	assert.equal(r.skip, false);
	assert.deepEqual(r.pdf, { data: Buffer.from(bytes).toString("base64"), filename: "chen.pdf", pages: 3, size: bytes.length });
	assert.deepEqual(r.messages, ["⚠️ 掃描版 PDF（沒有文字層）：已把 PDF 直接傳給 AI 讀（3 頁，較耗 token）"]);
	assert.deepEqual(calls, [["stat", "/s/P1/a.pdf"], ["read", "/s/P1/a.pdf"]]);

	// OpenAI's own API reads PDFs too; an OpenAI-compatible server behind a custom base URL may not
	r = await scanned.prepareAIInput(data, claude({ provider: "openai" }), [], fileIO(bytes));
	assert.ok(r.pdf);
	r = await scanned.prepareAIInput(data, claude({ provider: "openai", baseURL: "http://localhost:11434/v1" }), [], fileIO(bytes));
	assert.equal(r.pdf, null);
	assert.deepEqual(r.messages, ["⚠️ 掃描版 PDF（沒有文字層），AI 只讀了摘要與劃線（使用自訂 API base URL 時不傳送 PDF）"]);
});

test("prepareAIInput: option off, size and page caps, partial text, no PDF", async () => {
	let bytes = new Uint8Array(Buffer.from("%PDF"));
	let data = sampleItem({ fullTextStatus: "none", fullTextSource: pdfSource({ pages: 3 }) });
	let calls = [];
	let r = await scanned.prepareAIInput(data, claude({ sendScannedPDF: false }), [], fileIO(bytes, calls));
	assert.equal(r.pdf, null);
	assert.deepEqual(r.messages, ["⚠️ 掃描版 PDF（沒有文字層），AI 只讀了摘要與劃線"]);
	assert.deepEqual(calls, [], "the file isn't read when the option is off");

	let big = { stat: async () => ({ size: 25 * 1024 * 1024 }), read: async () => assert.fail("not read") };
	r = await scanned.prepareAIInput(data, claude(), [], big);
	assert.match(r.messages[0], /（PDF 25\.0 MB，超過 20 MB，沒有傳給 AI）$/);
	r = await scanned.prepareAIInput(data, claude({ pdfMaxMB: 30 }), [], big);
	assert.equal(r.messages.length, 1);
	assert.doesNotMatch(r.messages[0], /超過/, "the cap follows the pref");

	let long = sampleItem({ fullTextStatus: "none", fullTextSource: pdfSource({ pages: 240 }) });
	r = await scanned.prepareAIInput(long, claude(), [], fileIO(bytes));
	assert.match(r.messages[0], /（PDF 240 頁，超過 100 頁，沒有傳給 AI）$/);
	// Page count unknown to Zotero: counted in the file
	let unknown = sampleItem({ fullTextStatus: "none", fullTextSource: pdfSource({ pages: 0 }) });
	let threePages = new Uint8Array(Buffer.from("<< /Type /Page >> << /Type /Page >> << /Type /Page >>"));
	r = await scanned.prepareAIInput(unknown, claude({ pdfMaxPages: 2 }), [], fileIO(threePages));
	assert.match(r.messages[0], /（PDF 3 頁，超過 2 頁，沒有傳給 AI）$/);
	r = await scanned.prepareAIInput(unknown, claude(), [], { stat: async () => { throw new Error("gone"); } });
	assert.match(r.messages[0], /AI 只讀了摘要與劃線（無法讀取 PDF 檔：gone）$/);

	let partial = sampleItem({ fullText: "x".repeat(2000), fullTextStatus: "partial", fullTextSource: pdfSource({ chars: 2000, pages: 10 }) });
	r = await scanned.prepareAIInput(partial, claude({ sendScannedPDF: false }), [], fileIO(bytes));
	assert.deepEqual(r.messages, ["⚠️ PDF 大部分沒有文字層（每頁平均約 200 字），AI 讀到的全文不完整"]);
	r = await scanned.prepareAIInput(partial, claude(), [], fileIO(bytes));
	assert.ok(r.pdf, "a mostly scanned PDF is sent too");
	assert.deepEqual(r.messages, ["⚠️ PDF 大部分沒有文字層（每頁平均約 200 字）：已把 PDF 直接傳給 AI 讀（10 頁，較耗 token）"]);

	let noPdf = sampleItem({ attachments: [], fullTextStatus: "no_pdf", fullTextSource: null });
	r = await scanned.prepareAIInput(noPdf, claude(), [{ title: "n", md: "my note" }], fileIO(bytes));
	assert.deepEqual(r, { pdf: null, skip: false, messages: ["⚠️ 沒有 PDF 全文，AI 只讀了摘要與筆記"] });
	// Full text switched off by the user: no PDF, no warnings
	r = await scanned.prepareAIInput(data, claude({ fullTextLimit: 0 }), [], fileIO(bytes));
	assert.deepEqual(r, { pdf: null, skip: false, messages: [] });
	r = await scanned.prepareAIInput(sampleItem({ fullText: "text", fullTextStatus: "ok" }), claude(), [], fileIO(bytes));
	assert.deepEqual(r, { pdf: null, skip: false, messages: [] });
});

test("prepareAIInput skips the AI when there is nothing to read", async () => {
	let empty = sampleItem({
		abstract: "", attachments: [{ key: "P1", annotations: [{ type: "image", text: "", comment: "" }] }],
		fullText: "Downloaded from journals.example.com", fullTextStatus: "none", fullTextSource: pdfSource({ pages: 3 }),
	});
	let skip = ["⚠️ 沒有全文、摘要、劃線或筆記可讀，略過 AI 筆記（避免 AI 憑空產生內容）"];
	let r = await scanned.prepareAIInput(empty, claude({ sendScannedPDF: false }), [], fileIO(new Uint8Array(4)));
	assert.deepEqual(r, { pdf: null, skip: true, messages: skip }, "a scan's download stamp is not full text");
	r = await scanned.prepareAIInput(sampleItem({ abstract: "", attachments: [], fullTextStatus: "no_pdf" }), claude(), [{ md: "  " }], fileIO(new Uint8Array(4)));
	assert.equal(r.skip, true);
	// The same scan sent as a PDF has something to read
	r = await scanned.prepareAIInput(empty, claude(), [], fileIO(new Uint8Array(Buffer.from("%PDF"))));
	assert.equal(r.skip, false);
	assert.ok(r.pdf);
	assert.equal(scanned.hasReadableInput(sampleItem({ abstract: "", attachments: [], fullText: "text", fullTextStatus: "partial" }), []), true);
	assert.equal(scanned.readLabel(sampleItem({ attachments: [] }), []), "摘要");
	assert.equal(scanned.readLabel(sampleItem(), [{ md: "n" }]), "摘要、劃線與筆記");
});

test("generateWithPDF retries without the PDF when the API rejects it", async () => {
	let data = sampleItem({ fullTextStatus: "none" });
	let pdf = { data: "AAAA", filename: "a.pdf", pages: 200 };
	let messages = ["⚠️ 掃描版 PDF（沒有文字層）：已把 PDF 直接傳給 AI 讀（200 頁，較耗 token）"];
	let seen = [];
	let generate = async (p) => {
		seen.push(p);
		if (p) throw Object.assign(new Error("Claude API 400: A maximum of 100 PDF pages may be provided."), { status: 400 });
		return { text: "ok" };
	};
	let r = await scanned.generateWithPDF({ pdf }, data, [], generate, messages);
	assert.deepEqual(r, { text: "ok" });
	assert.deepEqual(seen, [pdf, null]);
	assert.equal(data.aiReadPDF, false);
	assert.deepEqual(messages, ["⚠️ AI 無法讀取這份 PDF（Claude API 400: A maximum of 100 PDF pages may be provided.），改讀摘要與劃線"]);

	// Other errors, and nothing else to read, are not retried
	let failing = async () => { throw Object.assign(new Error("boom"), { status: 500 }); };
	await assert.rejects(scanned.generateWithPDF({ pdf }, data, [], failing, []), /boom/);
	let bare = sampleItem({ abstract: "", attachments: [], fullTextStatus: "none" });
	let calls = 0;
	await assert.rejects(scanned.generateWithPDF({ pdf }, bare, [], async () => {
		calls++;
		throw Object.assign(new Error("bad pdf"), { status: 400 });
	}, []), /bad pdf/);
	assert.equal(calls, 1);
	let ok = sampleItem();
	await scanned.generateWithPDF({ pdf }, ok, [], async () => ({}), []);
	assert.equal(ok.aiReadPDF, true);
	await scanned.generateWithPDF(null, ok, [], async (p) => assert.equal(p, null), []);
	assert.equal(ok.aiReadPDF, false);
});

test("quotes from a PDF the AI read as a scan are marked 無全文可查證", () => {
	let md = AI_MD + "- \"Falls decreased\" (p. 5)\n";
	let texts = ["Abstract", "Falls decreased"];
	// Partial text layer, PDF sent: a quote missing from it is unchecked, not "not found"
	let data = sampleItem({ fullText: "Some page text", fullTextStatus: "partial", aiReadPDF: true });
	let r = verify.verifyQuotes(md, scanned.quoteSources(data, texts));
	assert.deepEqual([r.verified, r.notFound, r.unchecked], [1, 0, 1]);
	assert.match(r.md, /"Falls decreased by 30%" \(p\. 5\) ⚠️ 無全文可查證/);
	assert.match(r.md, /"Falls decreased" \(p\. 5\) ✅/);
	// The text layer still verifies what it contains
	r = verify.verifyQuotes(md, scanned.quoteSources(sampleItem({ fullText: "Falls decreased by 30% in…", aiReadPDF: true }), []));
	assert.equal(r.verified, 2);
	// Scan without the PDF sent: the download stamp is no full text either
	r = verify.verifyQuotes(md, scanned.quoteSources(sampleItem({ fullText: "Downloaded from x", fullTextStatus: "none" }), texts));
	assert.deepEqual([r.verified, r.notFound, r.unchecked], [1, 0, 1]);
	// Normal text PDF: unchanged
	assert.deepEqual(scanned.quoteSources(sampleItem({ fullText: "T", fullTextStatus: "ok" }), texts), { fullText: "T", texts });
});

test("prompt and request bodies: Claude document block, OpenAI input_file", async () => {
	let pdf = { data: "JVBERi0=", filename: "chen.pdf", pages: 3 };
	let data = sampleItem({ fullText: "stamp", fullTextStatus: "none" });
	let { user } = llm.buildPrompt(data, { pdf });
	assert.ok(user.includes(llm.PDF_ATTACHED_NOTE));
	assert.doesNotMatch(user, /<fulltext>/);
	// Scan, PDF not sent: the stamp isn't sent as full text
	user = llm.buildPrompt(data, {}).user;
	assert.doesNotMatch(user, /<fulltext>|stamp/);
	assert.match(user, /PDF 是掃描版，沒有可用的全文/);
	user = llm.buildPrompt(sampleItem({ fullText: "page one text", fullTextStatus: "partial" }), {}).user;
	assert.match(user, /<fulltext>\n（這份 PDF 大部分頁面是掃描影像[^\n]*\npage one text\n<\/fulltext>/);
	user = llm.buildPrompt(sampleItem({ fullText: "whole text", fullTextStatus: "ok" }), {}).user;
	assert.match(user, /<fulltext>\nwhole text\n<\/fulltext>/);

	assert.deepEqual(llm.anthropicContent("prompt", pdf), [
		{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" } },
		{ type: "text", text: "prompt" },
	]);
	assert.equal(llm.anthropicContent("prompt", null), "prompt");
	assert.deepEqual(llm.openaiInput("prompt", pdf), [{
		role: "user",
		content: [
			{ type: "input_file", filename: "chen.pdf", file_data: "data:application/pdf;base64,JVBERi0=" },
			{ type: "input_text", text: "prompt" },
		],
	}]);
	assert.equal(llm.openaiInput("prompt", null), "prompt");

	let bodies = [];
	let fetch = async (url, init) => {
		bodies.push({ url, body: JSON.parse(init.body) });
		let json = url.includes("anthropic")
			? { model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: "note" }], usage: { input_tokens: 9000, output_tokens: 10 } }
			: { model: "gpt-5.5", output_text: "note", usage: { input_tokens: 9000, output_tokens: 10 } };
		return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(json) };
	};
	let r = await llm.generateNote({ provider: "anthropic", apiKey: "k", model: "claude-opus-5-5" }, data, { pdf }, fetch, { maxRetries: 0 });
	assert.equal(r.usage.input, 9000, "usage of a PDF call is reported like any other");
	let content = bodies[0].body.messages[0].content;
	assert.equal(content[0].type, "document");
	assert.equal(content[0].source.data, "JVBERi0=");
	assert.ok(content[1].text.includes(llm.PDF_ATTACHED_NOTE));
	await llm.generateNote({ provider: "openai", apiKey: "k", model: "gpt-5.5" }, data, { pdf }, fetch);
	assert.equal(bodies[1].body.input[0].content[0].type, "input_file");
	assert.equal(bodies[1].body.input[0].content[0].file_data, "data:application/pdf;base64,JVBERi0=");
	assert.equal(bodies[1].body.input[0].content[1].type, "input_text");
	// Without a PDF the request is unchanged
	await llm.generateNote({ provider: "anthropic", apiKey: "k" }, sampleItem(), {}, fetch);
	assert.equal(typeof bodies[2].body.messages[0].content, "string");
});

test("full_text frontmatter and the Notion Full Text column", () => {
	assert.ok(core.MANAGED_KEYS.includes("full_text"));
	let note = core.buildObsidianNote(null, sampleItem({ fullTextStatus: "none" }), {});
	assert.match(note, /^full_text: "none"$/m);
	// Always rewritten by the plugin, and dropped when unknown
	let again = core.buildObsidianNote(note, sampleItem({ fullTextStatus: "ok" }), {});
	assert.match(again, /^full_text: "ok"$/m);
	assert.doesNotMatch(core.buildObsidianNote(again, sampleItem(), {}), /^full_text:/m);

	assert.equal(Object.keys(notion.PROPERTY_SCHEMA["Full Text"])[0], "select");
	assert.deepEqual(notion.PROPERTY_SCHEMA["Full Text"].select.options.map(o => o.name), scanned.STATUSES);
	let schema = { titleName: "Name", props: { Name: "title", "Full Text": "select" } };
	assert.deepEqual(notion.buildProperties(schema, { title: "T", fullText: "partial" })["Full Text"], { select: { name: "partial" } });
	assert.deepEqual(notion.buildProperties(schema, { title: "T" })["Full Text"], { select: null });
});
