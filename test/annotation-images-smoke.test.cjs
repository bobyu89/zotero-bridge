// Image and ink annotations through the real plugin in a mocked Zotero: Zotero's cached PNGs
// (rendered on demand) are copied into the vault, uploaded to Notion and shown to Claude.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");
const { AI_MD } = require("./fixtures.cjs");

const ROOT = path.join(__dirname, "..");
const ROOT_URI = "file://" + ROOT + "/";
const ITEM_KEY = "ITEM2345";

// A PNG header (signature + IHDR) and filler bytes that make each image distinct
function png(width, height, fill) {
	let buf = Buffer.alloc(64, fill);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
	buf.writeUInt32BE(13, 8);
	buf.write("IHDR", 12, "latin1");
	buf.writeUInt32BE(width, 16);
	buf.writeUInt32BE(height, 20);
	return buf;
}

function annotation(key, type, sortIndex, extra = {}) {
	return Object.assign({
		key, annotationType: type, annotationText: "", annotationComment: "", annotationColor: "#ffd400",
		annotationPageLabel: "", annotationSortIndex: sortIndex, getTags: () => [],
	}, extra);
}

// The parts of Zotero, Gecko and the plugin scope that a sync touches
function makeEnv({ prefs, fetch, cacheDir, render, textEncoder = true }) {
	let items = new Map();
	let nextID = 100;
	let progressLines = [];
	let errors = [];
	let writes = [];
	let renders = [];

	class MockItem {
		constructor(type, fields = {}) {
			this.id = nextID++;
			this.key = fields.key || `KEY${this.id}`;
			this.itemType = type;
			this.libraryID = 1;
			this.deleted = false;
			this.parentID = null;
			this.fields = fields;
			this.tags = [];
			this.children = [];
			this.annotations = [];
			this.noteHTML = "";
			this.dateAdded = "2024-05-01 08:00:00";
			this.dateModified = "2024-05-02 08:00:00";
			items.set(this.id, this);
		}
		get parentItem() { return this.parentID ? items.get(this.parentID) : undefined; }
		isRegularItem() { return !["note", "attachment", "annotation"].includes(this.itemType); }
		isNote() { return this.itemType === "note"; }
		isFileAttachment() { return this.itemType === "attachment"; }
		isPDFAttachment() { return this.itemType === "attachment"; }
		get attachmentContentType() { return "application/pdf"; }
		get attachmentText() { return Promise.resolve(this.fields.fulltext || ""); }
		getField(f) { return this.fields[f] || ""; }
		getCreatorsJSON() { return this.fields.creators || []; }
		getTags() { return this.tags.map(tag => ({ tag })); }
		addTag(t) { this.tags.push(t); }
		getCollections() { return []; }
		getAttachments() { return this.children.filter(id => items.get(id).itemType === "attachment"); }
		getNotes() { return this.children.filter(id => items.get(id).itemType === "note"); }
		getAnnotations() { return this.annotations; }
		getNote() { return this.noteHTML; }
		setNote(h) { this.noteHTML = h; }
		getNoteTitle() { return "note"; }
		getItemTypeIconName() { return this.itemType; }
		async saveTx() {
			if (this.parentID && !items.get(this.parentID).children.includes(this.id)) items.get(this.parentID).children.push(this.id);
			return this.id;
		}
	}
	function addChild(parent, child) {
		child.parentID = parent.id;
		parent.children.push(child.id);
	}

	let prefStore = Object.assign({}, prefs);
	let Zotero = {
		Prefs: { get: k => prefStore[k], set: (k, v) => { prefStore[k] = v; }, clear: (k) => { delete prefStore[k]; } },
		MenuManager: { registerMenu: o => o.menuID, unregisterMenu: () => true },
		Notifier: { registerObserver: () => "obs", unregisterObserver: () => {} },
		ItemPaneManager: { registerSection: o => o.paneID, unregisterSection: () => true },
		PreferencePanes: { register: async () => "pane" },
		getMainWindows: () => [],
		getMainWindow: () => ({}),
		Items: {
			get: ids => (Array.isArray(ids) ? ids.map(id => items.get(id)) : items.get(ids)),
			getByLibraryAndKey: (libraryID, key) => [...items.values()].find(i => i.libraryID === libraryID && i.key === key) || false,
		},
		Libraries: { get: () => ({ libraryType: "user", name: "My Library" }), getAll: () => [] },
		Groups: { getGroupIDFromLibraryID: () => null },
		Collections: { get: ids => (Array.isArray(ids) ? [] : null), getByParent: () => [] },
		Styles: { get: () => null },
		// xpcom/annotations.js: <data dir>/cache/library/<annotation key>.png
		Annotations: { getCacheImagePath: ({ libraryID, key }) => path.join(cacheDir, `${libraryID}`, key + ".png") },
		// xpcom/pdfWorker/manager.js: renders the PDF's image/ink annotations that have no cached PNG
		PDFWorker: {
			renderAttachmentAnnotations: async (itemID, isPriority) => {
				renders.push({ itemID, isPriority });
				return render ? render(items.get(itemID)) : 0;
			},
		},
		ProgressWindow: class {
			constructor() {
				this.ItemProgress = class {
					constructor(icon, text) { this.text = text; progressLines.push(this); }
					setText(t) { this.text = t; }
					setProgress(p) { this.progress = p; }
					setError() { this.error = true; }
				};
			}
			changeHeadline() {}
			addDescription() {}
			show() {}
			startCloseTimer() {}
		},
		logError: (e) => { errors.push(e); },
		debug: () => {},
	};
	Zotero.Item = MockItem;

	let IOUtils = {
		exists: async p => fs.existsSync(p),
		readUTF8: async p => fsp.readFile(p, "utf8"),
		writeUTF8: async (p, t) => fsp.writeFile(p, t, "utf8"),
		makeDirectory: async p => fsp.mkdir(p, { recursive: true }),
		read: async (p, opts = {}) => {
			let buf = await fsp.readFile(p);
			return new Uint8Array(opts.maxBytes == null ? buf : buf.subarray(0, opts.maxBytes));
		},
		write: async (p, bytes) => {
			writes.push(p);
			await fsp.writeFile(p, bytes);
			return bytes.length;
		},
		remove: async p => fsp.rm(p),
		getChildren: async p => (await fsp.readdir(p)).map(name => path.join(p, name)),
		stat: async (p) => {
			let st = await fsp.stat(p);
			return { type: st.isDirectory() ? "directory" : "regular", size: st.size };
		},
		move: async (from, to) => fsp.rename(from, to),
	};
	let PathUtils = { join: (...parts) => path.join(...parts), filename: p => path.basename(p), parent: p => path.dirname(p) };
	let logins = [];
	let globals = {
		Zotero, IOUtils, PathUtils, fetch, console, TextDecoder,
		Components: {
			// `new Components.Constructor(...)` returns the nsILoginInfo constructor
			Constructor: function () {
				return function (origin, formActionOrigin, httpRealm, username, password) {
					Object.assign(this, { origin, httpRealm, username, password });
				};
			},
			interfaces: { nsILoginInfo: {} },
		},
		DOMParser: new JSDOM("").window.DOMParser,
		setTimeout, clearTimeout,
		Services: {
			scriptloader: {
				loadSubScript: (url) => {
					let file = url.replace("file://", "");
					vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
				},
			},
			prompt: { confirm: () => true },
			logins: {
				searchLoginsAsync: async m => logins.filter(l => Object.entries(m).every(([k, v]) => l[k] === v)),
				addLoginAsync: async (l) => { logins.push(l); return l; },
				modifyLoginAsync: async (old, l) => { logins[logins.indexOf(old)] = l; },
				removeLoginAsync: async (old) => { logins.splice(logins.indexOf(old), 1); },
			},
		},
	};
	// Zotero's plugin sandbox has TextEncoder (xpcom/plugins.js); without it Notion uploads are skipped
	if (textEncoder) globals.TextEncoder = TextEncoder;
	let context = vm.createContext(globals);
	vm.runInContext(fs.readFileSync(path.join(ROOT, "bootstrap.js"), "utf8"), context, { filename: "bootstrap.js" });
	return { context, MockItem, addChild, progressLines, errors, writes, renders, prefStore };
}

// Notion with one data source, plus the File Upload API; `uploads` records each upload's create + send
function notionMock(log, opts = {}) {
	let pages = new Map();
	let uploads = [];
	let ok = json => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(json) });
	let fetch = async (url, init) => {
		if (url.startsWith("https://api.anthropic.com/")) {
			log.push({ api: "anthropic", body: JSON.parse(init.body) });
			return ok({ model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: AI_MD }], usage: { input_tokens: 10, output_tokens: 10 } });
		}
		let p = url.replace("https://api.notion.com/v1/", "");
		let m = /^file_uploads\/([^/]+)\/send$/.exec(p);
		if (m) {
			log.push({ api: "notion", method: init.method, path: p, headers: init.headers, raw: init.body });
			let up = uploads.find(u => u.id === m[1]);
			up.sent = { headers: init.headers, body: Buffer.from(init.body) };
			return ok({ object: "file_upload", id: up.id, status: "uploaded", filename: up.filename, content_type: "image/png" });
		}
		let body = init.body ? JSON.parse(init.body) : undefined;
		log.push({ api: "notion", method: init.method, path: p, body });
		if (p === "file_uploads" && init.method === "POST") {
			if (opts.uploadStatus) {
				return { status: opts.uploadStatus, ok: false, headers: { get: () => null }, text: async () => JSON.stringify({ code: "restricted_resource", message: "no uploads" }) };
			}
			let up = { id: `fu-${uploads.length + 1}`, create: body, filename: body.filename };
			uploads.push(up);
			return ok({ object: "file_upload", id: up.id, status: "pending" });
		}
		if (p.startsWith("databases/")) return ok({ data_sources: [{ id: "ds-1" }] });
		if (p === "data_sources/ds-1" && init.method === "GET") {
			let props = { Name: { type: "title" } };
			for (let [k, v] of Object.entries(require("../content/notion.js").PROPERTY_SCHEMA)) props[k] = { type: Object.keys(v)[0] };
			return ok({ properties: props });
		}
		if (p === "data_sources/ds-1/query") {
			let key = body.filter.rich_text.equals;
			return ok({ results: pages.has(key) ? [pages.get(key)] : [], has_more: false });
		}
		if (p === "pages" && init.method === "POST") {
			let page = { id: `page-${pages.size + 1}`, url: `https://www.notion.so/page-${pages.size + 1}` };
			pages.set(body.properties["Zotero Key"].rich_text[0].text.content, page);
			return ok(page);
		}
		if (/^pages\/[^/]+$/.test(p)) return ok([...pages.values()].find(pg => p.endsWith(pg.id)));
		if (/^blocks\/page-\d+\/children\?/.test(p)) return ok({ results: [], has_more: false });
		if (/^blocks\/page-\d+\/children$/.test(p)) return ok({ results: [{ id: "container-1" }] });
		// The folded sections: toggles appended to the container
		if (/^blocks\/[\w-]+\/children$/.test(p) && init.method === "PATCH") return ok({ results: (body.children || []).map((c, i) => ({ id: `toggle-${i + 1}` })) });
		if (/^blocks\/[\w-]+\/children\?/.test(p)) return ok({ results: [], has_more: false });
		return { status: 404, ok: false, headers: { get: () => null }, text: async () => JSON.stringify({ message: p }) };
	};
	return { fetch, uploads };
}

async function setup(opts = {}) {
	let vault = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-vault-"));
	let cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-cache-"));
	await fsp.mkdir(path.join(cacheDir, "1"));
	let log = [];
	let mock = notionMock(log, opts);
	let env = makeEnv({
		fetch: mock.fetch,
		cacheDir,
		render: opts.render,
		textEncoder: opts.textEncoder,
		prefs: Object.assign({
			"extensions.zotero-bridge.obsidian.vaultPath": vault,
			"extensions.zotero-bridge.obsidian.folder": "Zotero",
			"extensions.zotero-bridge.notion.token": "ntn_test",
			"extensions.zotero-bridge.notion.database": "https://www.notion.so/ws/Default-11111111111111111111111111111111",
			"extensions.zotero-bridge.llm.enabled": true,
			"extensions.zotero-bridge.llm.provider": "anthropic",
			"extensions.zotero-bridge.llm.anthropicKey": "sk-ant-test",
		}, opts.prefs),
	});
	await vm.runInContext(`startup({ id: "zotero-bridge@bobyu89.github.io", version: "0.0.0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);
	return Object.assign(env, { vault, cacheDir, log, uploads: mock.uploads });
}

function addPaper(env, key, annotations) {
	let item = new env.MockItem("journalArticle", {
		key, title: `Paper ${key}`, year: "2024", citationKey: `paper${key.toLowerCase()}`,
		creators: [{ firstName: "Mei", lastName: "Chen", creatorType: "author" }],
	});
	let pdf = new env.MockItem("attachment", { key: `PDF${key.slice(3)}`, title: "PDF" });
	env.addChild(item, pdf);
	pdf.annotations = annotations;
	return { item, pdf };
}

async function sync(env, items, action) {
	await env.context.ZB.main.run(items, action);
}

test("image and ink annotations: vault copies, Notion uploads, Claude image blocks; cleanup on re-sync", async () => {
	let image1 = png(640, 480, 1);
	let ink = png(200, 100, 2);
	// INK33333 has no cached PNG until the PDF worker renders it; IMG44444 can't be rendered at all
	let env = await setup({
		prefs: { "extensions.zotero-bridge.images.sendToAI": true },
		// Like Zotero, only annotations without a cached PNG are rendered
		render: async () => {
			let file = path.join(env.cacheDir, "1", "INK33333.png");
			if (fs.existsSync(file)) return 0;
			fs.writeFileSync(file, ink);
			return 1;
		},
	});
	fs.writeFileSync(path.join(env.cacheDir, "1", "IMG22222.png"), image1);
	let { item, pdf } = addPaper(env, ITEM_KEY, [
		annotation("HLT11111", "highlight", "00001", { annotationText: "Falls decreased", annotationPageLabel: "5" }),
		annotation("IMG22222", "image", "00002", { annotationComment: "Table 2：主要結果", annotationPageLabel: "6", annotationColor: "#5fb236" }),
		annotation("INK33333", "ink", "00003", { annotationPageLabel: "7", annotationColor: "#2ea8e5" }),
		annotation("IMG44444", "image", "00004", { annotationComment: "Figure 3", annotationPageLabel: "8" }),
	]);

	await sync(env, [item], { targets: ["notion", "obsidian"], ai: "missing" });
	assert.deepEqual(env.errors, []);
	let line = env.progressLines.at(-1);
	assert.equal(line.error, undefined, line.text);
	assert.match(line.text, /⚠️ 1 個圖片劃線無法產生圖片（保留評註）/);
	// One render request for the PDF covers both missing images
	assert.deepEqual(env.renders, [{ itemID: pdf.id, isPriority: true }]);

	// Obsidian: PNGs next to the note, embedded in sort order under their captions
	let attachments = path.join(env.vault, "Zotero", "attachments");
	assert.deepEqual(fs.readdirSync(attachments).sort(), [`${ITEM_KEY}-IMG22222.png`, `${ITEM_KEY}-INK33333.png`]);
	assert.ok(fs.readFileSync(path.join(attachments, `${ITEM_KEY}-IMG22222.png`)).equals(image1));
	assert.ok(fs.readFileSync(path.join(attachments, `${ITEM_KEY}-INK33333.png`)).equals(ink));
	let note = fs.readFileSync(path.join(env.vault, "Zotero", `paper${ITEM_KEY.toLowerCase()}.md`), "utf8");
	let at = s => note.indexOf(s);
	assert.match(note, new RegExp(`^> - 🟢 \\*\\[圖片註記\\]\\* · \\[p\\. 6\\]\\([^)]+\\)\\n> {3}!\\[\\[Zotero/attachments/${ITEM_KEY}-IMG22222\\.png\\]\\]\\n> {3}💬 Table 2：主要結果$`, "m"));
	assert.match(note, new RegExp(`^> - 🔵 \\*\\[手繪註記\\]\\* · \\[p\\. 7\\]\\([^)]+\\)\\n> {3}!\\[\\[Zotero/attachments/${ITEM_KEY}-INK33333\\.png\\]\\]`, "m"));
	assert.match(note, /^> - 🟡 \*\[圖片註記\]\* · \[p\. 8\]\([^)]+\)\n> {3}💬 Figure 3$/m, "an image that can't be produced keeps its caption and comment");
	assert.doesNotMatch(note, /IMG44444\.png/);
	// Grouped by colour meaning (yellow 重要發現, green 研究方法, blue 可引用句), in reading order within a group
	assert.ok(at("==🟡Falls decreased== ·") < at("Figure 3") && at("Figure 3") < at("IMG22222.png") && at("IMG22222.png") < at("INK33333.png"));

	// Notion: each PNG uploaded (create + multipart send) and attached as an image block in the container
	assert.equal(env.uploads.length, 2);
	assert.deepEqual(env.uploads.map(u => u.create), [
		{ mode: "single_part", filename: `${ITEM_KEY}-IMG22222.png`, content_type: "image/png" },
		{ mode: "single_part", filename: `${ITEM_KEY}-INK33333.png`, content_type: "image/png" },
	]);
	for (let [i, up] of env.uploads.entries()) {
		let m = /^multipart\/form-data; boundary=(\S+)$/.exec(up.sent.headers["Content-Type"]);
		assert.ok(m);
		assert.equal(up.sent.headers.Authorization, "Bearer ntn_test");
		assert.equal(up.sent.headers["Notion-Version"], "2025-09-03");
		let expected = Buffer.concat([
			Buffer.from(`--${m[1]}\r\nContent-Disposition: form-data; name="file"; filename="${up.filename}"\r\nContent-Type: image/png\r\n\r\n`),
			[image1, ink][i],
			Buffer.from(`\r\n--${m[1]}--\r\n`),
		]);
		assert.ok(up.sent.body.equals(expected), "multipart body");
	}
	let container = env.log.find(l => l.path === "blocks/page-1/children" && l.method === "PATCH");
	// The annotations are in their meaning's toggle inside the container
	let sections = env.log.find(l => l.path === "blocks/container-1/children" && l.method === "PATCH");
	let children = sections.body.children.flatMap(t => t.toggle.children);
	let imageBlocks = children.filter(b => b.type === "image");
	assert.deepEqual(imageBlocks, [
		{ object: "block", type: "image", image: { type: "file_upload", file_upload: { id: "fu-1" } } },
		{ object: "block", type: "image", image: { type: "file_upload", file_upload: { id: "fu-2" } } },
	]);
	let i1 = children.indexOf(imageBlocks[0]);
	assert.match(children[i1 - 1].bulleted_list_item.rich_text.map(r => r.text.content).join(""), /\[圖片註記\].*p\. 6/);
	assert.match(children[i1 + 1].paragraph.rich_text.map(r => r.text.content).join(""), /💬 Table 2：主要結果/);
	assert.doesNotMatch(JSON.stringify([container.body, sections.body]), /!\s*ITEM2345|attachments\//, "no wikilink text in Notion");
	// The uploads happen before the container is written (they expire if not attached within an hour)
	let paths = env.log.filter(l => l.api === "notion").map(l => l.path);
	assert.ok(paths.lastIndexOf("file_uploads") < paths.indexOf("blocks/page-1/children"));

	// Claude: the two images as labelled base64 blocks before the prompt
	let claude = env.log.find(l => l.api === "anthropic");
	let content = claude.body.messages[0].content;
	assert.deepEqual(content.slice(0, 4), [
		{ type: "text", text: "[圖片劃線 1] — p. 6 — 使用者評註：Table 2：主要結果" },
		{ type: "image", source: { type: "base64", media_type: "image/png", data: image1.toString("base64") } },
		{ type: "text", text: "[手繪註記 2] — p. 7" },
		{ type: "image", source: { type: "base64", media_type: "image/png", data: ink.toString("base64") } },
	]);
	assert.match(content[4].text, /p\. 8 \[image\] — 使用者評註：Figure 3/, "comments still go in the text");

	// Re-sync after deleting the first image annotation in Zotero; the user's own files stay
	fs.writeFileSync(path.join(attachments, "my figure.png"), "user");
	fs.writeFileSync(path.join(attachments, "OTHR2345-IMG22222.png"), "other item");
	pdf.annotations = pdf.annotations.filter(a => a.key !== "IMG22222");
	env.writes.length = 0;
	env.uploads.length = 0;
	await sync(env, [item], { targets: ["notion", "obsidian"], ai: "reuse" });
	assert.deepEqual(env.errors, []);
	assert.deepEqual(fs.readdirSync(attachments).sort(), [`${ITEM_KEY}-INK33333.png`, "OTHR2345-IMG22222.png", "my figure.png"]);
	assert.deepEqual(env.writes, [], "unchanged images are not rewritten");
	let note2 = fs.readFileSync(path.join(env.vault, "Zotero", `paper${ITEM_KEY.toLowerCase()}.md`), "utf8");
	assert.doesNotMatch(note2, /IMG22222/);
	assert.match(note2, /INK33333\.png\]\]/);
	// Uploaded again just in time for the new container
	assert.deepEqual(env.uploads.map(u => u.filename), [`${ITEM_KEY}-INK33333.png`]);

	// A changed image (e.g. the rectangle was moved and Zotero re-rendered it) is copied again
	let ink2 = png(300, 100, 3);
	fs.writeFileSync(path.join(env.cacheDir, "1", "INK33333.png"), ink2);
	await sync(env, [item], { targets: ["obsidian"], ai: "reuse" });
	assert.deepEqual(env.writes, [path.join(attachments, `${ITEM_KEY}-INK33333.png`)]);
	assert.ok(fs.readFileSync(path.join(attachments, `${ITEM_KEY}-INK33333.png`)).equals(ink2));

	// Turning the export off leaves the vault and Notion as plain captions
	env.prefStore["extensions.zotero-bridge.images.export"] = false;
	env.uploads.length = 0;
	await sync(env, [item], { targets: ["notion", "obsidian"], ai: "reuse" });
	assert.equal(env.uploads.length, 0);
	assert.doesNotMatch(fs.readFileSync(path.join(env.vault, "Zotero", `paper${ITEM_KEY.toLowerCase()}.md`), "utf8"), /!\[\[/);
	await vm.runInContext("shutdown()", env.context);
});

test("Notion uploads that can't be made never fail the sync", async () => {
	// No TextEncoder in the plugin scope: skipped with one message per run, not per item
	let env = await setup({ textEncoder: false });
	let a = addPaper(env, "AAAA2345", [annotation("IMG55555", "image", "00001", { annotationComment: "Table 1" })]);
	let b = addPaper(env, "BBBB2345", [annotation("IMG66666", "image", "00001")]);
	fs.writeFileSync(path.join(env.cacheDir, "1", "IMG55555.png"), png(10, 10, 5));
	fs.writeFileSync(path.join(env.cacheDir, "1", "IMG66666.png"), png(10, 10, 6));
	await sync(env, [a.item, b.item], { targets: ["notion", "obsidian"], ai: "none" });
	assert.deepEqual(env.errors, []);
	let lines = env.progressLines.filter(l => /Paper/.test(l.text));
	assert.equal(lines.length, 2);
	assert.ok(lines.every(l => !l.error && l.progress === 100), lines.map(l => l.text).join("\n"));
	assert.match(lines[0].text, /⚠️ 這個 Zotero 版本無法上傳檔案到 Notion，圖片劃線只同步評註/);
	assert.doesNotMatch(lines[1].text, /無法上傳/);
	assert.equal(env.uploads.length, 0);
	let sections = env.log.find(l => l.path === "blocks/container-1/children" && l.method === "PATCH");
	assert.ok(!sections.body.children.flatMap(t => t.toggle.children).some(b => b.type === "image"));
	assert.match(JSON.stringify(sections.body), /💬 Table 1/);
	// Obsidian still gets the image
	assert.ok(fs.existsSync(path.join(env.vault, "Zotero", "attachments", "AAAA2345-IMG55555.png")));
	await vm.runInContext("shutdown()", env.context);

	// Notion refuses the upload (e.g. workspace limits): reported on the line, page still written
	let env2 = await setup({ uploadStatus: 403 });
	let c = addPaper(env2, "CCCC2345", [
		annotation("IMG77777", "image", "00001", { annotationComment: "Fig 1" }),
		annotation("IMG88888", "image", "00002"),
	]);
	fs.writeFileSync(path.join(env2.cacheDir, "1", "IMG77777.png"), png(10, 10, 7));
	fs.writeFileSync(path.join(env2.cacheDir, "1", "IMG88888.png"), png(10, 10, 8));
	await sync(env2, [c.item], { targets: ["notion"], ai: "none" });
	let line = env2.progressLines.at(-1);
	assert.equal(line.error, undefined, line.text);
	assert.match(line.text, /⚠️ 2 張圖片無法上傳到 Notion（保留評註）/);
	assert.equal(env2.log.filter(l => l.path === "file_uploads").length, 1, "stops after the first refusal");
	let sections2 = env2.log.find(l => l.path === "blocks/container-1/children" && l.method === "PATCH");
	assert.match(JSON.stringify(sections2.body), /💬 Fig 1/);
	assert.equal(env2.errors.length, 1, "the refusal is logged");
	await vm.runInContext("shutdown()", env2.context);
});
