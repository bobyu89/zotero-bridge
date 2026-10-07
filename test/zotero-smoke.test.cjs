// Loads bootstrap.js and every content script into a mocked Zotero environment and
// drives a full sync from the item context menu: Zotero → Claude → Notion + Obsidian.
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

function makeEnv({ prefs, fetch }) {
	let items = new Map();
	let nextID = 100;
	let menus = [];
	let progressLines = [];
	let errors = [];

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
			items.set(this.id, this);
		}
		get parentItem() { return this.parentID ? items.get(this.parentID) : undefined; }
		isRegularItem() { return !["note", "attachment", "annotation"].includes(this.itemType); }
		isFileAttachment() { return this.itemType === "attachment"; }
		isPDFAttachment() { return this.itemType === "attachment"; }
		get attachmentContentType() { return "application/pdf"; }
		get attachmentText() { return Promise.resolve(this.fields.fulltext || ""); }
		getField(f) { return this.fields[f] || ""; }
		getCreatorsJSON() { return this.fields.creators || []; }
		getTags() { return this.tags.map(tag => ({ tag })); }
		addTag(t) { this.tags.push(t); }
		getCollections() { return this.fields.collectionIDs || []; }
		getAttachments() { return this.children.filter(id => items.get(id).itemType === "attachment"); }
		getNotes() { return this.children.filter(id => items.get(id).itemType === "note"); }
		getAnnotations() { return this.annotations; }
		getNote() { return this.noteHTML; }
		setNote(h) { this.noteHTML = h; }
		getNoteTitle() { return "note"; }
		getItemTypeIconName() { return this.itemType; }
		async saveTx() {
			if (this.parentID && !items.get(this.parentID).children.includes(this.id)) {
				items.get(this.parentID).children.push(this.id);
			}
			return this.id;
		}
	}

	function addChild(parent, child) {
		child.parentID = parent.id;
		parent.children.push(child.id);
	}

	let prefStore = Object.assign({}, prefs);
	let Zotero = {
		Prefs: { get: k => prefStore[k], set: (k, v) => { prefStore[k] = v; } },
		MenuManager: {
			registerMenu: (opts) => { menus.push(opts); return opts.menuID; },
			unregisterMenu: () => true,
		},
		Notifier: { registerObserver: () => "obs", unregisterObserver: () => {} },
		PreferencePanes: { register: async () => "pane" },
		getMainWindows: () => [],
		getMainWindow: () => ({}),
		Items: {
			get: ids => (Array.isArray(ids) ? ids.map(id => items.get(id)) : items.get(ids)),
			exists: id => items.has(id),
		},
		Item: function (type) { return new MockItem(type); },
		Libraries: { get: () => ({ libraryType: "user", name: "My Library" }) },
		Groups: { getGroupIDFromLibraryID: () => null },
		Collections: {
			get: (ids) => {
				let all = { 7: { name: "碩論", parentID: null }, 8: { name: "文獻回顧", parentID: 7 } };
				return Array.isArray(ids) ? ids.map(id => all[id]) : all[ids];
			},
			getByParent: () => [],
		},
		Styles: { get: () => null },
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
			addDescription(t) { this.description = t; }
			show() {}
			startCloseTimer() {}
		},
		logError: (e) => { errors.push(e); },
		debug: () => {},
	};
	// Zotero.Item is used with `new`
	Zotero.Item = MockItem;

	let IOUtils = {
		exists: async p => fs.existsSync(p),
		readUTF8: async p => fsp.readFile(p, "utf8"),
		writeUTF8: async (p, t) => fsp.writeFile(p, t, "utf8"),
		makeDirectory: async p => fsp.mkdir(p, { recursive: true }),
	};
	let PathUtils = { join: (...parts) => path.join(...parts), filename: p => path.basename(p) };

	let context = vm.createContext({
		Zotero, IOUtils, PathUtils, fetch, console,
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
		},
	});
	vm.runInContext(fs.readFileSync(path.join(ROOT, "bootstrap.js"), "utf8"), context, { filename: "bootstrap.js" });
	return { context, Zotero, MockItem, addChild, menus, progressLines, items, prefStore, errors };
}

function notionMock(log) {
	let pages = new Map();
	return async (url, init) => {
		let body = init.body ? JSON.parse(init.body) : undefined;
		let ok = json => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(json) });
		if (url.startsWith("https://api.anthropic.com/")) {
			log.push({ api: "anthropic", body });
			return ok({ model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: AI_MD }] });
		}
		let p = url.replace("https://api.notion.com/v1/", "");
		log.push({ api: "notion", method: init.method, path: p, body });
		if (p.startsWith("databases/")) return ok({ data_sources: [{ id: "ds-1" }] });
		if (p === "data_sources/ds-1" && init.method === "GET") {
			let props = { Name: { type: "title" } };
			if (log.some(l => l.method === "PATCH" && l.path === "data_sources/ds-1")) {
				for (let [k, v] of Object.entries(require("../content/notion.js").PROPERTY_SCHEMA)) props[k] = { type: Object.keys(v)[0] };
			}
			return ok({ properties: props });
		}
		if (p === "data_sources/ds-1") return ok({});
		if (p === "data_sources/ds-1/query") {
			let key = body.filter.rich_text.equals;
			return ok({ results: pages.has(key) ? [pages.get(key)] : [] });
		}
		if (p === "pages" && init.method === "POST") {
			let page = { id: "page-1", url: "https://www.notion.so/page-1" };
			pages.set(body.properties["Zotero Key"].rich_text[0].text.content, page);
			return ok(page);
		}
		if (p.startsWith("pages/")) return ok({ id: "page-1", url: "https://www.notion.so/page-1" });
		if (p.startsWith("blocks/page-1/children?")) return ok({ results: [], has_more: false });
		if (p === "blocks/page-1/children") return ok({ results: [{ id: "container-1" }] });
		return { status: 404, ok: false, headers: { get: () => null }, text: async () => JSON.stringify({ message: p }) };
	};
}

test("full sync from the item menu writes Notion, Obsidian and the AI note", async () => {
	let vault = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-vault-"));
	let log = [];
	let env = makeEnv({
		fetch: notionMock(log),
		prefs: {
			"extensions.zotero-bridge.obsidian.vaultPath": vault,
			"extensions.zotero-bridge.obsidian.folder": "Zotero",
			"extensions.zotero-bridge.obsidian.filenameFormat": "citekey",
			"extensions.zotero-bridge.notion.token": "ntn_test",
			"extensions.zotero-bridge.notion.database": "https://www.notion.so/ws/Default-11111111111111111111111111111111",
			"extensions.zotero-bridge.routing.rules": JSON.stringify([
				{ name: "thesis", library: "user", collection: "碩論", notionDatabase: "https://www.notion.so/ws/Thesis-0123456789abcdef0123456789abcdef", obsidianFolder: "Zotero/碩論" },
			]),
			"extensions.zotero-bridge.llm.enabled": true,
			"extensions.zotero-bridge.llm.provider": "anthropic",
			"extensions.zotero-bridge.llm.anthropicKey": "sk-ant-test",
			"extensions.zotero-bridge.llm.anthropicModel": "claude-opus-5-5",
			"extensions.zotero-bridge.llm.effort": "medium",
			"extensions.zotero-bridge.llm.fullTextLimit": "20",
			"extensions.zotero-bridge.includeNotes": true,
		},
	});
	await vm.runInContext(`startup({ id: "zotero-bridge@bobyu89.github.io", version: "0.1.0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);
	assert.deepEqual(env.menus.map(m => m.target), ["main/library/item", "main/library/collection", "main/menubar/tools"]);

	let { MockItem, addChild } = env;
	let item = new MockItem("journalArticle", {
		title: "Fall prevention RCT", year: "2024", citationKey: "chen2024", DOI: "10.1/x",
		creators: [{ firstName: "Mei", lastName: "Chen", creatorType: "author" }],
		abstractNote: "Abstract text", collectionIDs: [8],
	});
	let pdf = new MockItem("attachment", { title: "PDF", fulltext: "0123456789".repeat(5) });
	addChild(item, pdf);
	pdf.annotations = [{
		key: "ANN1", annotationType: "highlight", annotationText: "Falls decreased", annotationComment: "important",
		annotationColor: "#ffd400", annotationPageLabel: "5", annotationSortIndex: "00001", getTags: () => [],
	}];
	let note = new MockItem("note");
	note.noteHTML = "<p>My <strong>own</strong> note</p>";
	addChild(item, note);

	// Click "同步到 Notion + Obsidian（沒有 AI 筆記才產生）" on the selected attachment
	let itemMenu = env.menus[0].menus[0];
	assert.equal(itemMenu.menuType, "submenu");
	let syncEntry = itemMenu.menus.find(m => m.l10nID === "zotero-bridge-menu-sync");
	syncEntry.onCommand({}, { items: [pdf] });
	await env.context.ZB.main.run([], {}); // wait for the queued run

	assert.deepEqual(env.errors, []);
	assert.equal(env.progressLines.length, 1);
	assert.equal(env.progressLines[0].error, undefined, env.progressLines[0].text);
	assert.equal(env.progressLines[0].progress, 100);

	// LLM call: full text truncated to the configured limit
	let llmCalls = log.filter(l => l.api === "anthropic");
	assert.equal(llmCalls.length, 1);
	assert.match(llmCalls[0].body.messages[0].content, /<fulltext>\n（全文過長[^\n]*\n01234567890123456789\n<\/fulltext>/);
	assert.match(llmCalls[0].body.messages[0].content, /My \*\*own\*\* note/);

	// AI note saved under the item with the plugin tag
	let aiNote = env.Zotero.Items.get(item.getNotes()).find(n => n.tags.includes("zotero-bridge-ai"));
	assert.ok(aiNote);
	assert.match(aiNote.noteHTML, /<h1>🤖 AI 文獻筆記<\/h1>/);

	// Notion: routed to the thesis database, page created with properties and a managed container
	let dbCall = log.find(l => l.api === "notion" && l.path.startsWith("databases/"));
	assert.equal(dbCall.path, "databases/01234567-89ab-cdef-0123-456789abcdef");
	let create = log.find(l => l.path === "pages" && l.method === "POST");
	assert.deepEqual(create.body.parent, { type: "data_source_id", data_source_id: "ds-1" });
	assert.equal(create.body.properties["Zotero Key"].rich_text[0].text.content, "library/" + item.key);
	assert.match(create.body.properties.Obsidian.url, /^obsidian:\/\/open\?vault=zb-vault-/);
	assert.match(create.body.properties.Summary.rich_text[0].text.content, /^護理師主導衛教/);
	assert.deepEqual(create.body.properties.Collections.multi_select, [{ name: "碩論/文獻回顧" }]);
	let container = log.find(l => l.path === "blocks/page-1/children" && l.method === "PATCH");
	assert.equal(container.body.children[0].type, "callout");

	// Obsidian file in the routed folder with Notion link and AI note
	let file = path.join(vault, "Zotero", "碩論", "chen2024.md");
	let text = fs.readFileSync(file, "utf8");
	assert.match(text, /^notion: "https:\/\/www\.notion\.so\/page-1"$/m);
	assert.match(text, /^ai_model: "claude-opus-5-5"$/m);
	assert.match(text, /^fulltext_truncated: true$/m);
	assert.match(text, /\[\[Fall prevention\]\]/);
	assert.match(text, /My \*\*own\*\* note/);
	assert.match(text, /> 🟡 Falls decreased/);

	// User writes in their section, then a sync without AI reuses the stored note
	fs.appendFileSync(file, "\n我的心得：值得引用。\n");
	log.length = 0;
	let noAI = itemMenu.menus.find(m => m.l10nID === "zotero-bridge-menu-no-ai");
	noAI.onCommand({}, { items: [item] });
	await env.context.ZB.main.run([], {});
	assert.deepEqual(env.errors, []);
	assert.equal(log.filter(l => l.api === "anthropic").length, 0);
	assert.ok(log.some(l => l.method === "PATCH" && l.path === "pages/page-1"), "existing page is updated, not duplicated");
	assert.ok(!log.some(l => l.path === "pages" && l.method === "POST"));
	let text2 = fs.readFileSync(file, "utf8");
	assert.match(text2, /我的心得：值得引用。/);
	assert.match(text2, /\[\[Fall prevention\]\]/, "AI note read back from Zotero");
	assert.match(text2, /^ai_model: "claude-opus-5-5"$/m);
	assert.equal((text2.match(/zotero-bridge:start/g) || []).length, 1);

	await vm.runInContext("shutdown()", env.context);
	assert.equal(env.Zotero.ZoteroBridge, undefined);
});

test("AI failure still writes Obsidian, and an unconfigured Notion is skipped", async () => {
	let vault = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-vault-"));
	let calls = [];
	let fetch = async (url) => {
		calls.push(url);
		return { status: 500, ok: false, statusText: "err", headers: { get: () => null }, text: async () => JSON.stringify({ error: { message: "overloaded" } }) };
	};
	let env = makeEnv({
		fetch,
		prefs: {
			"extensions.zotero-bridge.obsidian.vaultPath": vault,
			"extensions.zotero-bridge.obsidian.folder": "",
			"extensions.zotero-bridge.obsidian.filenameFormat": "authorYearTitle",
			"extensions.zotero-bridge.notion.token": "",
			"extensions.zotero-bridge.routing.rules": "[]",
			"extensions.zotero-bridge.llm.enabled": true,
			"extensions.zotero-bridge.llm.provider": "openai",
			"extensions.zotero-bridge.llm.openaiKey": "sk-test",
			"extensions.zotero-bridge.llm.fullTextLimit": "0",
		},
	});
	await vm.runInContext(`startup({ id: "zb", version: "0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);
	let item = new env.MockItem("book", { title: "Nursing Theory", year: "2020", creators: [{ name: "WHO", creatorType: "author" }] });
	await env.context.ZB.main.run([item], { targets: ["notion", "obsidian"], ai: "missing" });

	assert.deepEqual(calls, ["https://api.openai.com/v1/responses"], "no Notion calls without a token");
	let line = env.progressLines[0];
	assert.equal(line.error, true);
	assert.match(line.text, /AI 筆記：OpenAI API 500: overloaded/);
	let text = fs.readFileSync(path.join(vault, "WHO 2020 - Nursing Theory.md"), "utf8");
	assert.match(text, /^title: "Nursing Theory"$/m);
	assert.doesNotMatch(text, /AI 文獻筆記/);
});
