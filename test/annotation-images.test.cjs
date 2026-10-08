const test = require("node:test");
const assert = require("node:assert/strict");
const images = require("../content/annotation-images.js");
const core = require("../content/core.js");
const markdown = require("../content/markdown.js");
const notion = require("../content/notion.js");
const llm = require("../content/llm.js");
const { sampleItem } = require("./fixtures.cjs");

// A PNG header (signature + IHDR) followed by filler bytes; enough for pngSize()
function png(width, height, filler = 32) {
	let buf = Buffer.alloc(33 + filler, 7);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
	buf.writeUInt32BE(13, 8);
	buf.write("IHDR", 12, "latin1");
	buf.writeUInt32BE(width, 16);
	buf.writeUInt32BE(height, 20);
	return new Uint8Array(buf);
}

test("image file names, embed paths and the cleanup of deleted annotations' images", () => {
	assert.equal(images.imageFileName("ABCD1234", "IMG22222"), "ABCD1234-IMG22222.png");
	assert.equal(images.embedPath(["Zotero", "碩論"], "ABCD1234-IMG22222.png"), "Zotero/碩論/attachments/ABCD1234-IMG22222.png");
	assert.equal(images.embedPath([], "A.png"), "attachments/A.png");
	assert.equal(images.embedPath(["Lit [old]"], "A.png"), "A.png", "a folder name that would end the wikilink");
	let files = [
		"ABCD1234-IMG22222.png", // still annotated
		"ABCD1234-GONE3333.png", // annotation deleted → removed
		"WXYZ9876-GONE3333.png", // another item's image
		"ABCD1234-GONE3333.jpg", // not a plugin file name
		"my figure.png",
		"ABCD1234-lower123.png",
		"ABCD1234-GONE3333 (1).png",
	];
	assert.deepEqual(images.staleImageFiles(files, "ABCD1234", ["IMG22222"]), ["ABCD1234-GONE3333.png"]);
	assert.deepEqual(images.staleImageFiles(files, "ABCD1234", []), ["ABCD1234-IMG22222.png", "ABCD1234-GONE3333.png"]);
	assert.deepEqual(images.staleImageFiles([], "ABCD1234", []), []);
});

test("withImages copies the item data and only marks image/ink annotations", () => {
	let data = sampleItem();
	let out = images.withImages(data, ann => ({ embed: `x/${ann.key}.png` }));
	let anns = out.attachments[0].annotations;
	assert.equal(anns[0].image, undefined, "highlights are left alone");
	assert.deepEqual(anns[2].image, { embed: "x/ANN00003.png" });
	assert.equal(data.attachments[0].annotations[2].image, undefined, "the original is not modified");
	assert.equal(images.withImages(data, () => null).attachments[0].annotations[2], data.attachments[0].annotations[2]);
});

test("pngSize, base64 and the multipart body", () => {
	assert.deepEqual(images.pngSize(png(640, 480)), { width: 640, height: 480 });
	assert.equal(images.pngSize(new Uint8Array([1, 2, 3])), null);
	assert.equal(images.pngSize(new Uint8Array(40)), null);
	for (let n of [0, 1, 2, 3, 4, 5, 255, 1000]) {
		let bytes = new Uint8Array(Array.from({ length: n }, (_, i) => (i * 37 + 11) % 256));
		assert.equal(images.base64(bytes), Buffer.from(bytes).toString("base64"), `length ${n}`);
	}
	let bytes = png(10, 10);
	let body = images.multipartBody("BOUNDARY", "file", "ABCD1234-IMG22222.png", "image/png", bytes);
	let text = Buffer.from(body).toString("latin1");
	let head = "--BOUNDARY\r\nContent-Disposition: form-data; name=\"file\"; filename=\"ABCD1234-IMG22222.png\"\r\nContent-Type: image/png\r\n\r\n";
	assert.ok(text.startsWith(head));
	assert.ok(text.endsWith("\r\n--BOUNDARY--\r\n"));
	assert.deepEqual(body.slice(head.length, head.length + bytes.length), bytes);
	assert.equal(body.length, head.length + bytes.length + "\r\n--BOUNDARY--\r\n".length);
});

test("prompt images stay within Claude's per-image, size and count limits", () => {
	let ann = { key: "IMG22222", type: "image", pageLabel: "7", comment: "Table 2" };
	assert.equal(images.promptLabel(ann, 1), "[圖片劃線 1] — p. 7 — 使用者評註：Table 2");
	assert.equal(images.promptLabel({ type: "ink", pageLabel: "" }, 2), "[手繪註記 2]");
	let small = png(800, 600);
	let { images: picked, skipped } = images.selectPromptImages([
		{ annotation: ann, bytes: small },
		{ annotation: ann, bytes: png(9000, 100) }, // wider than 8000 px
		{ annotation: ann, bytes: new Uint8Array([1, 2, 3]) }, // not a PNG
		{ annotation: ann, bytes: png(100, 100, 4 * 1024 * 1024) }, // over 5 MB once base64-encoded
	]);
	assert.equal(skipped, 3);
	assert.deepEqual(picked, [{ label: "[圖片劃線 1] — p. 7 — 使用者評註：Table 2", mediaType: "image/png", data: Buffer.from(small).toString("base64") }]);
	let many = Array.from({ length: images.AI_MAX_IMAGES + 3 }, () => ({ annotation: ann, bytes: small }));
	let r = images.selectPromptImages(many);
	assert.equal(r.images.length, images.AI_MAX_IMAGES);
	assert.equal(r.skipped, 3);
	assert.equal(r.images.at(-1).label, `[圖片劃線 ${images.AI_MAX_IMAGES}] — p. 7 — 使用者評註：Table 2`);
});

test("Obsidian: the image is embedded under the caption, before the comment", () => {
	let data = sampleItem();
	data.attachments[0].annotations[2].comment = "Table 2：主要結果";
	let withEmbed = images.withImages(data, ann => ({ embed: `Zotero/attachments/ABCD1234-${ann.key}.png` }));
	let md = core.annotationsMarkdown(withEmbed);
	assert.match(md, /> 🟢 \*\[圖片註記\]\* — \[p\. 7\]\(zotero:\/\/open-pdf\/library\/items\/PDF00001\?page=7&annotation=ANN00003\)\n\n!\[\[Zotero\/attachments\/ABCD1234-ANN00003\.png\]\]\n\n💬 Table 2：主要結果/);
	// Without an image (export off or not renderable) the caption and comment stay as before
	let plain = core.annotationsMarkdown(data);
	assert.doesNotMatch(plain, /!\[\[/);
	assert.match(plain, /> 🟢 \*\[圖片註記\]\* — \[p\. 7\]\([^)]+\)\n\n💬 Table 2：主要結果/);
	// Ink annotations get the same treatment
	data.attachments[0].annotations[2].type = "ink";
	let ink = core.annotationsMarkdown(images.withImages(data, () => ({ embed: "a/b.png" })));
	assert.match(ink, /\*\[手繪註記\]\* — \[p\. 7\]\([^)]+\)\n\n!\[\[a\/b\.png\]\]/);
});

test("Notion: an uploaded image becomes an image block in place; other embeds stay text", () => {
	let data = images.withImages(sampleItem(), ann => ({ embed: `ABCD1234-${ann.key}.png` }));
	let md = core.buildManagedSection(data, {});
	let blocks = markdown.mdToNotionBlocks(md, { images: { "ABCD1234-ANN00003.png": "fu-1" } });
	let i = blocks.findIndex(b => b.type === "image");
	assert.deepEqual(blocks[i], { object: "block", type: "image", image: { type: "file_upload", file_upload: { id: "fu-1" } } });
	assert.equal(blocks[i - 1].type, "quote");
	assert.match(blocks[i - 1].quote.rich_text.map(r => r.text.content).join(""), /\[圖片註記\]/);
	assert.equal(blocks.filter(b => b.type === "image").length, 1);
	// Not uploaded → no image block (and the plugin doesn't write the embed for Notion in that case)
	let none = markdown.mdToNotionBlocks("![[x.png]]\n\n![[ABCD1234-ANN00003.png|300]]", { images: { "ABCD1234-ANN00003.png": "fu-2" } });
	assert.equal(none[0].type, "paragraph");
	assert.deepEqual(none[1].image.file_upload, { id: "fu-2" }, "an alias after | is ignored");
	assert.equal(markdown.mdToNotionBlocks("![[x.png]]")[0].type, "paragraph");
});

test("Notion file upload: create, then multipart send with the integration's headers", async () => {
	let calls = [];
	let fetch = async (url, init) => {
		calls.push({ url, init });
		let json = url.endsWith("/file_uploads")
			? { object: "file_upload", id: "fu-123", status: "pending", upload_url: "https://api.notion.com/v1/file_uploads/fu-123/send" }
			: { object: "file_upload", id: "fu-123", status: "uploaded", filename: "ABCD1234-IMG22222.png", content_type: "image/png" };
		return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(json) };
	};
	let client = new notion.NotionClient({ token: "ntn_x", fetch, sleep: async () => {} });
	let bytes = png(20, 10);
	let id = await images.uploadFile(client, "ABCD1234-IMG22222.png", "image/png", bytes);
	assert.equal(id, "fu-123");
	assert.equal(calls.length, 2);
	assert.equal(calls[0].url, "https://api.notion.com/v1/file_uploads");
	assert.equal(calls[0].init.method, "POST");
	assert.deepEqual(JSON.parse(calls[0].init.body), { mode: "single_part", filename: "ABCD1234-IMG22222.png", content_type: "image/png" });
	let send = calls[1];
	assert.equal(send.url, "https://api.notion.com/v1/file_uploads/fu-123/send");
	assert.equal(send.init.method, "POST");
	assert.equal(send.init.headers.Authorization, "Bearer ntn_x");
	assert.equal(send.init.headers["Notion-Version"], notion.NOTION_VERSION);
	let m = /^multipart\/form-data; boundary=(\S+)$/.exec(send.init.headers["Content-Type"]);
	assert.ok(m, send.init.headers["Content-Type"]);
	assert.ok(send.init.body instanceof Uint8Array);
	assert.deepEqual(send.init.body, images.multipartBody(m[1], "file", "ABCD1234-IMG22222.png", "image/png", bytes));

	// A failed send is a NotionError, so the caller can report it and keep the rest of the sync
	let failing = new notion.NotionClient({
		token: "ntn_x",
		sleep: async () => {},
		fetch: async url => (url.endsWith("/send")
			? { status: 400, ok: false, headers: { get: () => null }, text: async () => JSON.stringify({ code: "validation_error", message: "too large" }) }
			: { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ id: "fu-9" }) }),
	});
	await assert.rejects(images.uploadFile(failing, "a.png", "image/png", bytes), e => e instanceof notion.NotionError && e.status === 400 && /too large/.test(e.message));
});

test("Claude request: labelled image blocks before the prompt text; OpenAI gets text only", async () => {
	let bodies = [];
	let fetch = async (url, init) => {
		bodies.push({ url, body: JSON.parse(init.body) });
		let json = url.includes("anthropic")
			? { model: "m", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }], usage: {} }
			: { model: "m", output_text: "ok", usage: {} };
		return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(json) };
	};
	let img = { label: "[圖片劃線 1] — p. 7", mediaType: "image/png", data: "iVBORw0KGgo=" };
	await llm.generateNote({ provider: "anthropic", apiKey: "k", model: "m" }, sampleItem(), { images: [img] }, fetch);
	let content = bodies[0].body.messages[0].content;
	assert.deepEqual(content.slice(0, 2), [
		{ type: "text", text: "[圖片劃線 1] — p. 7" },
		{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
	]);
	assert.equal(content.length, 3);
	assert.equal(content[2].type, "text");
	assert.match(content[2].text, /<metadata>/);
	assert.match(content[2].text, /p\. 7 \[image\]/, "the annotation is still listed in the text");
	await llm.generateNote({ provider: "openai", apiKey: "k", model: "m" }, sampleItem(), { images: [img] }, fetch);
	assert.equal(typeof bodies[1].body.input, "string");
	await llm.generateNote({ provider: "anthropic", apiKey: "k", model: "m" }, sampleItem(), {}, fetch);
	assert.equal(typeof bodies[2].body.messages[0].content, "string", "unchanged without images");
});
