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

// What the model returns: the note, one more quote (from the user's highlight) and the JSON block
const AI_RESPONSE = AI_MD + `- "Falls decreased" (p. 5)

\`\`\`json
{"study_design": "randomized controlled trial", "sample_size": 120, "setting": "內科病房", "population": "住院病人",
 "intervention": "衛教", "comparison": "常規照護", "outcomes": "跌倒發生率", "measures": ["Morse Fall Scale"],
 "evidence_level": "2", "jbi_level": "1.c", "appraisal_tool": "JBI Checklist for Randomized Controlled Trials",
 "appraisal_overall": "納入", "country": "Taiwan"}
\`\`\`
`;
const ROOT_URI = "file://" + ROOT + "/";

// Gecko login manager (Services.logins) backed by an array; lookups return the stored objects
function loginManagerMock(initial = []) {
	let logins = [...initial];
	let same = (a, b) => a.origin === b.origin && a.httpRealm === b.httpRealm && a.username === b.username;
	return {
		logins,
		searchLoginsAsync: async match => logins.filter(l => Object.entries(match).every(([k, v]) => l[k] === v)),
		addLoginAsync: async (login) => {
			if (logins.some(l => same(l, login))) throw new Error("This login already exists.");
			logins.push(login);
			return login;
		},
		modifyLoginAsync: async (old, login) => {
			let i = logins.indexOf(old);
			if (i < 0) throw new Error("No matching logins");
			logins[i] = login;
		},
		removeLoginAsync: async (old) => {
			let i = logins.indexOf(old);
			if (i < 0) throw new Error("No matching logins");
			logins.splice(i, 1);
		},
	};
}

function LoginInfo(origin, formActionOrigin, httpRealm, username, password) {
	Object.assign(this, { origin, formActionOrigin, httpRealm, username, password });
}

// `timers`, when given, collects the plugin's long setTimeout callbacks (auto-sync debounce,
// self-modified expiry) so a test can fire them itself
function makeEnv({ prefs, fetch, logins = [], confirm = () => true, timers }) {
	let items = new Map();
	let observers = [];
	let nextID = 100;
	let menus = [];
	let progressLines = [];
	let descriptions = [];
	let errors = [];
	let panes = [];
	let translations = [];

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
			this.dateAdded = fields.dateAdded || "2024-05-01 08:00:00";
			this.dateModified = fields.dateModified || "2024-05-02 08:00:00";
			this.version = 0;
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
		removeTag(t) { this.tags = this.tags.filter(x => x !== t); }
		getCollections() { return this.fields.collectionIDs || []; }
		getAttachments() { return this.children.filter(id => items.get(id).itemType === "attachment"); }
		getNotes() { return this.children.filter(id => items.get(id).itemType === "note"); }
		getAnnotations() { return this.annotations; }
		getNote() { return this.noteHTML; }
		setNote(h) { this.noteHTML = h; }
		getNoteTitle() { return "note"; }
		getItemTypeIconName() { return this.itemType; }
		addToCollection(id) { this.collectionsAdded = (this.collectionsAdded || []).concat(id); }
		addRelatedItem(item) { this.related = (this.related || []).concat(item.key); }
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
		Prefs: { get: k => prefStore[k], set: (k, v) => { prefStore[k] = v; }, clear: (k) => { delete prefStore[k]; } },
		MenuManager: {
			registerMenu: (opts) => { menus.push(opts); return opts.menuID; },
			unregisterMenu: () => true,
		},
		Notifier: {
			registerObserver: (ref, types) => { observers.push({ ref, types }); return "obs"; },
			unregisterObserver: () => { observers.length = 0; },
		},
		ItemPaneManager: {
			registerSection: (opts) => { panes.push(opts); return opts.paneID; },
			unregisterSection: () => true,
		},
		PreferencePanes: { register: async () => "pane" },
		getMainWindows: () => [],
		getMainWindow: () => ({}),
		Items: {
			get: ids => (Array.isArray(ids) ? ids.map(id => items.get(id)) : items.get(ids)),
			exists: id => items.has(id),
			getByLibraryAndKey: (libraryID, key) => [...items.values()].find(i => i.libraryID === libraryID && i.key === key) || false,
			// Top-level items not in the trash (annotations aren't modelled here)
			getAll: async (libraryID, onlyTopLevel) => [...items.values()]
				.filter(i => i.libraryID === libraryID && !i.deleted && (!onlyTopLevel || !i.parentID)),
		},
		Item: function (type) { return new MockItem(type); },
		Libraries: {
			get: () => ({ libraryType: "user", name: "My Library" }),
			getAll: () => [{ libraryID: 1, libraryType: "user", name: "My Library" }],
		},
		Utilities: {
			Item: {
				// Stand-in for Zotero's CSL conversion: the id is the item URI, as in Zotero
				itemToCSLJSON: item => ({
					id: `http://zotero.org/users/1/items/${item.key}`,
					type: "article-journal",
					title: item.fields.title,
					author: (item.fields.creators || []).map(c => ({ family: c.lastName, given: c.firstName })),
					issued: { "date-parts": [[Number(item.fields.year)]] },
					page: item.fields.pages,
					URL: "https://example.org/" + item.key,
				}),
			},
		},
		Translate: {
			Export: class {
				constructor() { this.handlers = {}; translations.push(this); }
				setItems(list) { this.items = list; }
				setTranslator(id) { this.translatorID = id; }
				setDisplayOptions(o) { this.displayOptions = o; }
				setHandler(type, fn) { this.handlers[type] = fn; }
				async translate() {
					// Like Zotero's ItemGetter: ascending item ID, one entry per regular item
					this.items.sort((a, b) => a.id - b.id);
					this.string = "\n" + this.items.map(i => `@article{${i.key.toLowerCase()}_bibtex,\n\ttitle = {${i.fields.title}},\n}`).join("\n\n") + "\n";
					this.handlers.done(this, true);
				}
			},
		},
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
			addDescription(t) {
				this.description = t;
				descriptions.push(t);
			}
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
		read: async (p, opts = {}) => {
			let buf = await fsp.readFile(p);
			return new Uint8Array(opts.maxBytes == null ? buf : buf.subarray(0, opts.maxBytes));
		},
		getChildren: async p => (await fsp.readdir(p)).map(name => path.join(p, name)),
		stat: async (p) => {
			let st = await fsp.stat(p);
			return { path: p, type: st.isDirectory() ? "directory" : st.isFile() ? "regular" : "other", size: st.size };
		},
		move: async (from, to, opts = {}) => {
			if (opts.noOverwrite && fs.existsSync(to)) throw new Error("NoModificationAllowedError: " + to);
			await fsp.rename(from, to);
		},
	};
	let PathUtils = { join: (...parts) => path.join(...parts), filename: p => path.basename(p), parent: p => path.dirname(p) };

	let loginManager = loginManagerMock(logins);
	let context = vm.createContext({
		Zotero, IOUtils, PathUtils, fetch, console, TextDecoder,
		Components: {
			// `new Components.Constructor(cid, iface, "init")` returns the nsILoginInfo constructor
			Constructor: function (cid, iface, init) {
				assert.equal(cid, "@mozilla.org/login-manager/loginInfo;1");
				assert.equal(init, "init");
				return LoginInfo;
			},
			interfaces: { nsILoginInfo: {} },
		},
		DOMParser: new JSDOM("").window.DOMParser,
		// Short waits (Notion rate limiting) run for real
		setTimeout: timers ? (fn, ms) => (ms >= 8000 ? timers.push({ fn, ms }) : setTimeout(fn, ms)) : setTimeout,
		clearTimeout: timers ? (id) => (typeof id === "number" ? timers[id - 1].cleared = true : clearTimeout(id)) : clearTimeout,
		Services: {
			scriptloader: {
				loadSubScript: (url) => {
					let file = url.replace("file://", "");
					vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
				},
			},
			prompt: { confirm: (win, title, text) => confirm(text) },
			logins: loginManager,
		},
	});
	vm.runInContext(fs.readFileSync(path.join(ROOT, "bootstrap.js"), "utf8"), context, { filename: "bootstrap.js" });
	return { context, Zotero, MockItem, addChild, menus, progressLines, descriptions, items, prefStore, errors, panes, loginManager, translations, observers };
}

// One data source (ds-1); pages are created as page-1, page-2… and can be moved to the trash
function notionMock(log, pages = new Map()) {
	let schemaPatched = false;
	let blockSeq = 0;
	return async (url, init) => {
		let body = init.body ? JSON.parse(init.body) : undefined;
		let ok = json => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(json) });
		if (url.startsWith("https://api.anthropic.com/")) {
			log.push({ api: "anthropic", body, headers: init.headers });
			return ok({
				model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: AI_RESPONSE }],
				usage: { input_tokens: 12000, output_tokens: 3000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			});
		}
		let p = url.replace("https://api.notion.com/v1/", "");
		log.push({ api: "notion", method: init.method, path: p, body });
		if (p.startsWith("databases/")) return ok({ data_sources: [{ id: "ds-1" }] });
		if (p === "data_sources/ds-1" && init.method === "GET") {
			let props = { Name: { type: "title" } };
			if (schemaPatched) {
				for (let [k, v] of Object.entries(require("../content/notion.js").PROPERTY_SCHEMA)) props[k] = { type: Object.keys(v)[0] };
			}
			return ok({ properties: props });
		}
		if (p === "data_sources/ds-1") {
			schemaPatched = true;
			return ok({});
		}
		if (p === "data_sources/ds-1/query") {
			// Like Notion, a query doesn't return pages in the trash
			if (body.filter.rich_text && body.filter.rich_text.is_not_empty) {
				return ok({ results: [...pages.values()].filter(pg => !pg.in_trash), has_more: false });
			}
			let keys = body.filter.or ? body.filter.or.map(f => f.rich_text.equals) : [body.filter.rich_text.equals];
			return ok({ results: keys.filter(k => pages.has(k) && !pages.get(k).in_trash).map(k => pages.get(k)), has_more: false });
		}
		if (p === "pages" && init.method === "POST") {
			let id = `page-${pages.size + 1}`;
			let page = { id, url: `https://www.notion.so/${id}`, properties: body.properties };
			pages.set(body.properties["Zotero Key"].rich_text[0].text.content, page);
			return ok(page);
		}
		let m = /^pages\/([^/?]+)$/.exec(p);
		if (m) {
			let page = [...pages.values()].find(pg => pg.id === m[1]);
			if (body && body.in_trash !== undefined) page.in_trash = body.in_trash;
			if (body && body.properties) Object.assign(page.properties, body.properties);
			return ok(page);
		}
		if (/^blocks\/page-\d+\/children\?/.test(p)) return ok({ results: [], has_more: false });
		if (/^blocks\/page-\d+\/children$/.test(p)) return ok({ results: [{ id: "container-1" }] });
		// The folded sections: toggles appended to the container (and anything appended inside them)
		if (/^blocks\/[\w-]+\/children$/.test(p) && init.method === "PATCH") return ok({ results: (body.children || []).map(() => ({ id: `block-${++blockSeq}` })) });
		if (/^blocks\/[\w-]+\/children\?/.test(p)) return ok({ results: [], has_more: false });
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
	// One registration per menu: the item and collection menus' 「ZotMax ▸」 and the Tools menu (menus.js)
	assert.deepEqual(env.menus.map(m => [m.menuID, m.target]), [["zotero-bridge-item", "main/library/item"],
		["zotero-bridge-collection", "main/library/collection"], ["zotero-bridge-tools", "main/menubar/tools"]]);
	assert.equal(env.panes[0].paneID, "zotero-bridge-ai-note");
	// The ZotMax submenus (items and collections) end with the AI group: AI notes, then the drafts
	// (review-draft.js, ebhc-report.js)
	for (let i of [0, 1]) {
		assert.deepEqual([...env.menus[i].menus[0].menus.slice(-6).map(m => m.l10nID || m.menuType)],
			["separator", "zotero-bridge-toolbar-group-ai", "zotero-bridge-menu-regenerate", "zotero-bridge-menu-synthesis", "zotero-bridge-menu-review-draft", "zotero-bridge-menu-ebhc-report"]);
	}

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
	// Quote verification is reported on the item's progress line
	assert.equal(env.progressLines[0].text, "Fall prevention RCT — 可引用句 2 句：✅ 1、⚠️ 1 句未在全文中找到");

	// Secrets moved from prefs.js into the login manager on startup, then cleared from prefs
	assert.equal(env.prefStore["extensions.zotero-bridge.llm.anthropicKey"], undefined);
	assert.equal(env.prefStore["extensions.zotero-bridge.notion.token"], undefined);
	assert.deepEqual(env.loginManager.logins.map(l => [l.origin, l.httpRealm, l.username, l.password]).sort(), [
		["chrome://zotero-bridge", "Zotero Bridge", "anthropicKey", "sk-ant-test"],
		["chrome://zotero-bridge", "Zotero Bridge", "notionToken", "ntn_test"],
	]);

	// Usage recorded in this month's ledger and summarized in the progress window
	let ledger = JSON.parse(env.prefStore["extensions.zotero-bridge.usage.ledger"]);
	let month = ledger[env.context.ZB.usage.monthKey()];
	assert.equal(month.calls, 1);
	assert.deepEqual(month.byModel["claude-opus-5-5"], { calls: 1, input: 12000, output: 3000, cacheRead: 0, cacheWrite: 0 });
	// 12,000 × $4 + 3,000 × $20 per million = $0.108
	assert.equal(env.descriptions.at(-1), "AI 用量：1 次呼叫，輸入 12,000／輸出 3,000 tokens，約 US$0.11");

	// LLM call: full text truncated to the configured limit
	let llmCalls = log.filter(l => l.api === "anthropic");
	assert.equal(llmCalls.length, 1);
	assert.equal(llmCalls[0].headers["x-api-key"], "sk-ant-test", "API key read back from the login manager");
	assert.match(llmCalls[0].body.messages[0].content, /<fulltext>\n（全文過長[^\n]*\n01234567890123456789\n<\/fulltext>/);
	assert.match(llmCalls[0].body.messages[0].content, /My \*\*own\*\* note/);

	// AI note saved under the item with the plugin tag
	let aiNote = env.Zotero.Items.get(item.getNotes()).find(n => n.tags.includes("zotero-bridge-ai"));
	assert.ok(aiNote);
	assert.match(aiNote.noteHTML, /<h1>🤖 AI 文獻筆記<\/h1>/);
	// The structured data is kept at the end of the Zotero note as a heading + <pre>
	assert.match(aiNote.noteHTML, /<h2>📋 結構化資料（ZotMax）<\/h2>\n<pre>\{\n {2}&quot;study_design&quot;: &quot;RCT&quot;,[\s\S]*<\/pre>$/);
	assert.match(aiNote.noteHTML, /Falls decreased by 30%&quot; \(p\. 5\) ⚠️ 未在全文中找到/);

	// Notion: routed to the thesis database, page created with properties and a managed container
	let dbCall = log.find(l => l.api === "notion" && l.path.startsWith("databases/"));
	assert.equal(dbCall.path, "databases/01234567-89ab-cdef-0123-456789abcdef");
	let create = log.find(l => l.path === "pages" && l.method === "POST");
	assert.deepEqual(create.body.parent, { type: "data_source_id", data_source_id: "ds-1" });
	assert.equal(create.body.properties["Zotero Key"].rich_text[0].text.content, "library/" + item.key);
	assert.match(create.body.properties.Obsidian.url, /^obsidian:\/\/open\?vault=zb-vault-/);
	assert.match(create.body.properties.Summary.rich_text[0].text.content, /^護理師主導衛教/);
	assert.deepEqual(create.body.properties.Collections.multi_select, [{ name: "碩論/文獻回顧" }]);
	assert.deepEqual(create.body.properties["Study Design"], { select: { name: "RCT" } });
	assert.deepEqual(create.body.properties["Sample Size"], { number: 120 });
	assert.deepEqual(create.body.properties.Measures, { multi_select: [{ name: "Morse Fall Scale" }] });
	assert.deepEqual(create.body.properties.Appraisal, { select: { name: "納入" } });
	let container = log.find(l => l.path === "blocks/page-1/children" && l.method === "PATCH");
	assert.equal(container.body.children[0].type, "callout");
	assert.doesNotMatch(JSON.stringify(container.body), /study_design/, "no raw JSON in the Notion page");

	// Obsidian file in the routed folder with Notion link and AI note
	let file = path.join(vault, "Zotero", "碩論", "chen2024.md");
	let text = fs.readFileSync(file, "utf8");
	assert.match(text, /^notion: "https:\/\/www\.notion\.so\/page-1"$/m);
	assert.match(text, /^ai_model: "claude-opus-5-5"$/m);
	assert.match(text, /^fulltext_truncated: true$/m);
	assert.match(text, /\[\[Fall prevention\]\]/);
	assert.match(text, /My \*\*own\*\* note/);
	assert.match(text, /^> - ==🟡Falls decreased== · \[p\. 5\]/m, "the highlight under its colour's meaning");
	assert.match(text, /^> \[!abstract\] 重點\n> \*\*一句話\*\*：護理師主導衛教/m, "重點 at the top");
	assert.match(text, /^study_design: "RCT"$/m);
	assert.match(text, /^sample_size: 120$/m);
	assert.match(text, /^measures:\n {2}- "Morse Fall Scale"$/m);
	assert.doesNotMatch(text, /"study_design"|```json|結構化資料/, "no raw JSON in the Obsidian body");
	assert.match(text, /^> - "Falls decreased" \(p\. 5\) ✅$/m);
	// Bases overview created once in the default folder
	let base = path.join(vault, "Zotero", "Zotero 文獻庫.base");
	assert.match(fs.readFileSync(base, "utf8"), /type: kanban/);
	fs.writeFileSync(base, "user edited");

	// User writes in their section, then a sync without AI reuses the stored note
	fs.appendFileSync(file, "\n我的心得：值得引用。\n");
	log.length = 0;
	let noAI = itemMenu.menus.find(m => m.l10nID === "zotero-bridge-menu-no-ai");
	noAI.onCommand({}, { items: [item] });
	await env.context.ZB.main.run([], {});
	assert.deepEqual(env.errors, []);
	assert.equal(log.filter(l => l.api === "anthropic").length, 0);
	assert.equal(env.descriptions.at(-1), "完成 1 筆", "no usage line when AI was not called");
	assert.ok(log.some(l => l.method === "PATCH" && l.path === "pages/page-1"), "existing page is updated, not duplicated");
	assert.ok(!log.some(l => l.path === "pages" && l.method === "POST"));
	let text2 = fs.readFileSync(file, "utf8");
	assert.match(text2, /我的心得：值得引用。/);
	assert.match(text2, /\[\[Fall prevention\]\]/, "AI note read back from Zotero");
	assert.match(text2, /^ai_model: "claude-opus-5-5"$/m);
	// Structured data read back from the Zotero note (no AI call)
	assert.match(text2, /^study_design: "RCT"$/m);
	assert.doesNotMatch(text2, /"study_design"|結構化資料/);
	let patch = log.find(l => l.method === "PATCH" && l.path === "pages/page-1");
	assert.deepEqual(patch.body.properties["Study Design"], { select: { name: "RCT" } });
	assert.deepEqual(patch.body.properties["Evidence Level"], { select: { name: "2" } });
	assert.equal(env.progressLines.at(-1).text, "Fall prevention RCT");
	assert.equal((text2.match(/zotero-bridge:start/g) || []).length, 1);
	assert.equal(fs.readFileSync(base, "utf8"), "user edited", "existing .base is never overwritten");

	await vm.runInContext("shutdown()", env.context);
	assert.equal(env.Zotero.ZoteroBridge, undefined);
});

test("AI failure still writes Obsidian, and an unconfigured Notion is skipped", async () => {
	let vault = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-vault-"));
	let calls = [];
	let fetch = async (url) => {
		calls.push(url);
		return {
			status: 500, ok: false, statusText: "err",
			headers: { get: k => (k === "retry-after-ms" ? "250" : null) },
			text: async () => JSON.stringify({ error: { message: "overloaded" } }),
		};
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
	let sleeps = [];
	env.context.ZB.main.runtime.retry = { sleep: async (ms) => { sleeps.push(ms); } };
	// An abstract to read (an item with nothing at all to read never reaches the AI)
	let item = new env.MockItem("book", { title: "Nursing Theory", year: "2020", creators: [{ name: "WHO", creatorType: "author" }], abstractNote: "Abstract" });
	await env.context.ZB.main.run([item], { targets: ["notion", "obsidian"], ai: "missing" });

	// 1 try + 4 retries, each waiting the server's retry-after-ms; never any Notion call without a token
	assert.deepEqual(calls, Array(5).fill("https://api.openai.com/v1/responses"));
	assert.deepEqual(sleeps, [250, 250, 250, 250]);
	let line = env.progressLines[0];
	assert.equal(line.error, true);
	assert.match(line.text, /AI 筆記：OpenAI API 500: overloaded（已重試 4 次）/);
	assert.equal(env.prefStore["extensions.zotero-bridge.usage.ledger"], undefined, "failed calls are not billed");
	let text = fs.readFileSync(path.join(vault, "WHO 2020 - Nursing Theory.md"), "utf8");
	assert.match(text, /^title: "Nursing Theory"$/m);
	assert.doesNotMatch(text, /AI 文獻筆記/);
});

test("scanned PDF: the file goes to Claude, the status reaches Obsidian and Notion; nothing to read skips the AI", async () => {
	let vault = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-vault-"));
	let storage = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-storage-"));
	let pdfPath = path.join(storage, "scan.pdf");
	let pdfBytes = Buffer.from("%PDF-1.4\n% scanned pages, images only\n");
	fs.writeFileSync(pdfPath, pdfBytes);
	let log = [];
	let env = makeEnv({
		fetch: notionMock(log),
		prefs: basePrefs(vault, {
			"extensions.zotero-bridge.llm.enabled": true,
			"extensions.zotero-bridge.llm.provider": "anthropic",
			"extensions.zotero-bridge.llm.anthropicKey": "sk-ant-test",
			"extensions.zotero-bridge.llm.anthropicModel": "claude-opus-5-5",
			"extensions.zotero-bridge.llm.fullTextLimit": "150000",
		}),
	});
	// Zotero's full-text index: a scan without text is never indexed, so the page count comes from
	// the PDF worker; the partly scanned PDF below is indexed (10 pages)
	let pageRows = new Map();
	let workerCalls = [];
	env.Zotero.Fulltext = { getPages: async id => pageRows.get(id) || false };
	env.Zotero.PDFWorker = {
		getFullText: async (id, maxPages) => {
			workerCalls.push([id, maxPages]);
			return { text: "", extractedPages: 0, totalPages: 3 };
		},
	};
	await vm.runInContext(`startup({ id: "zb", version: "0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);
	let creators = [{ lastName: "Chen", creatorType: "author" }];

	let scan = new env.MockItem("journalArticle", { title: "Scanned RCT", year: "1998", citationKey: "chen1998", creators, abstractNote: "Abstract of a scanned paper" });
	let pdf = new env.MockItem("attachment", { title: "Full Text PDF", fulltext: "" });
	pdf.getFilePathAsync = async () => pdfPath;
	env.addChild(scan, pdf);
	pdf.annotations = [{
		key: "ANN1", annotationType: "highlight", annotationText: "Falls decreased", annotationComment: "",
		annotationColor: "#ffd400", annotationPageLabel: "5", annotationSortIndex: "00001", getTags: () => [],
	}];
	// Bibliographic fields only: nothing for the AI to read
	let bare = new env.MockItem("journalArticle", { title: "Bare record", year: "2001", citationKey: "lee2001", creators });

	await env.context.ZB.main.run([scan, bare], { targets: ["notion", "obsidian"], ai: "missing" });
	assert.deepEqual(env.errors, []);
	assert.deepEqual(workerCalls, [[pdf.id, 1]], "only the page count is asked of the PDF worker");

	// One Claude call, for the scan, with the PDF as a base64 document block before the prompt
	let llmCalls = log.filter(l => l.api === "anthropic");
	assert.equal(llmCalls.length, 1);
	let content = llmCalls[0].body.messages[0].content;
	assert.deepEqual(content[0], { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBytes.toString("base64") } });
	assert.equal(content[1].type, "text");
	assert.match(content[1].text, /全文以附件 PDF 提供/);
	assert.doesNotMatch(content[1].text, /<fulltext>/);

	let [scanLine, bareLine] = env.progressLines.filter(l => !/要中途停止/.test(l.text));
	assert.equal(scanLine.error, undefined, scanLine.text);
	assert.equal(scanLine.text, "Scanned RCT — ⚠️ 掃描版 PDF（沒有文字層）：已把 PDF 直接傳給 AI 讀（3 頁，較耗 token）；可引用句 2 句：✅ 1、⚠️ 1 句無全文可查證");
	assert.equal(bareLine.error, undefined, bareLine.text);
	assert.equal(bareLine.text, "Bare record — ⚠️ 沒有全文、摘要、劃線或筆記可讀，略過 AI 筆記（避免 AI 憑空產生內容）");

	// The call is in the usage ledger like any other
	let month = JSON.parse(env.prefStore["extensions.zotero-bridge.usage.ledger"])[env.context.ZB.usage.monthKey()];
	assert.equal(month.calls, 1);
	assert.equal(month.input, 12000);

	// Quotes: the one from the highlight is verified, the other can't be checked without a text layer
	let aiNote = env.Zotero.Items.get(scan.getNotes()).find(n => n.tags.includes("zotero-bridge-ai"));
	assert.match(aiNote.noteHTML, /Falls decreased by 30%&quot; \(p\. 5\) ⚠️ 無全文可查證/);
	assert.equal(env.Zotero.Items.get(bare.getNotes()).length, 0, "no AI note for the bare record");

	// Obsidian frontmatter and the Notion column
	let scanNote = fs.readFileSync(path.join(vault, "Zotero", "chen1998.md"), "utf8");
	assert.match(scanNote, /^full_text: "none"$/m);
	let bareNote = fs.readFileSync(path.join(vault, "Zotero", "lee2001.md"), "utf8");
	assert.match(bareNote, /^full_text: "no_pdf"$/m);
	assert.doesNotMatch(bareNote, /^ai_model:/m);
	let created = log.filter(l => l.path === "pages" && l.method === "POST");
	assert.deepEqual(created.map(c => c.body.properties["Full Text"]), [{ select: { name: "none" } }, { select: { name: "no_pdf" } }]);

	// A mostly scanned PDF with the option off: the partial text layer is sent, with a warning
	log.length = 0;
	env.prefStore["extensions.zotero-bridge.llm.sendScannedPDF"] = false;
	let partial = new env.MockItem("journalArticle", { title: "Partly scanned", year: "2005", citationKey: "wu2005", creators, abstractNote: "Abstract" });
	let partialPdf = new env.MockItem("attachment", { title: "PDF", fulltext: "Page one text. ".repeat(160) });
	partialPdf.getFilePathAsync = async () => pdfPath;
	env.addChild(partial, partialPdf);
	pageRows.set(partialPdf.id, { indexedPages: 10, total: 10 });
	await env.context.ZB.main.run([partial], { targets: ["notion", "obsidian"], ai: "missing" });
	assert.deepEqual(env.errors, []);
	assert.equal(workerCalls.length, 1, "indexed PDFs take the page count from the index");
	let call = log.find(l => l.api === "anthropic");
	assert.equal(typeof call.body.messages[0].content, "string", "no PDF attached");
	assert.match(call.body.messages[0].content, /<fulltext>\n（這份 PDF 大部分頁面是掃描影像/);
	assert.match(env.progressLines.at(-1).text, /^Partly scanned — ⚠️ PDF 大部分沒有文字層（每頁平均約 192 字），AI 讀到的全文不完整；/);
	assert.match(fs.readFileSync(path.join(vault, "Zotero", "wu2005.md"), "utf8"), /^full_text: "partial"$/m);

	// A sync without AI still writes the status (and reads no PDF)
	log.length = 0;
	await env.context.ZB.main.run([scan], { targets: ["notion", "obsidian"], ai: "none" });
	assert.equal(log.filter(l => l.api === "anthropic").length, 0);
	assert.match(fs.readFileSync(path.join(vault, "Zotero", "chen1998.md"), "utf8"), /^full_text: "none"$/m);
	let patch = log.find(l => l.method === "PATCH" && /^pages\/page-\d+$/.test(l.path));
	assert.deepEqual(patch.body.properties["Full Text"], { select: { name: "none" } });
	assert.equal(env.progressLines.at(-1).text, "Scanned RCT", "status warnings only when the AI ran");
});

test("item pane shows the AI note; synthesis from a collection writes Obsidian, Notion and a Zotero note", async () => {
	let vault = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-vault-"));
	let log = [];
	let fetch = async (url, init) => {
		let body = init.body ? JSON.parse(init.body) : undefined;
		log.push({ url, method: init.method, body });
		let ok = json => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(json) });
		if (url.startsWith("https://api.anthropic.com/")) {
			return ok({
				model: "claude-opus-5-5", stop_reason: "end_turn",
				usage: { input_tokens: 50000, output_tokens: 8000 },
				content: [{ type: "text", text: "## 綜合摘要\n兩篇都有效 [S1, S2]。\n\n## 文獻比較表\n| 文獻 | 設計 |\n|---|---|\n| [S1] | RCT |\n| [S2] | cohort |\n" }],
			});
		}
		if (url === "https://api.notion.com/v1/pages") return ok({ id: "syn-page", url: "https://www.notion.so/syn-page" });
		if (url === "https://api.notion.com/v1/blocks/syn-page/children") return ok({ results: [] });
		return { status: 404, ok: false, headers: { get: () => null }, text: async () => "{}" };
	};
	let env = makeEnv({
		fetch,
		prefs: {
			"extensions.zotero-bridge.obsidian.vaultPath": vault,
			"extensions.zotero-bridge.obsidian.folder": "Zotero",
			"extensions.zotero-bridge.obsidian.filenameFormat": "citekey",
			"extensions.zotero-bridge.notion.token": "ntn_test",
			"extensions.zotero-bridge.notion.synthesisParent": "https://www.notion.so/Research-22222222222222222222222222222222",
			"extensions.zotero-bridge.routing.rules": "[]",
			"extensions.zotero-bridge.llm.enabled": true,
			"extensions.zotero-bridge.llm.provider": "anthropic",
			"extensions.zotero-bridge.llm.anthropicKey": "sk-ant-test",
			"extensions.zotero-bridge.llm.anthropicModel": "claude-opus-5-5",
		},
	});
	await vm.runInContext(`startup({ id: "zb", version: "0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);
	let a = new env.MockItem("journalArticle", { title: "A", year: "2024", citationKey: "chen2024", creators: [{ lastName: "Chen", creatorType: "author" }] });
	let b = new env.MockItem("journalArticle", { title: "B", year: "2021", citationKey: "lee2021", creators: [{ lastName: "Lee", creatorType: "author" }], abstractNote: "abstract B" });
	let aiNote = new env.MockItem("note");
	aiNote.noteHTML = "<h1>🤖 AI 文獻筆記</h1><p><em>由 claude-opus-5-5 於 2026-10-01T00:00:00Z 產生（ZotMax）</em></p><h2>一句話摘要</h2><p>衛教降低跌倒。</p><h2>研究設計</h2><ul><li>設計：RCT</li></ul>"
		+ "<h2>📋 結構化資料（ZotMax）</h2><pre>{\n  \"study_design\": \"RCT\",\n  \"sample_size\": 80\n}</pre>";
	aiNote.tags = ["zotero-bridge-ai"];
	env.addChild(a, aiNote);
	// Item A already has a literature note in the vault, so the synthesis links to it
	await fsp.mkdir(path.join(vault, "Zotero"), { recursive: true });
	await fsp.writeFile(path.join(vault, "Zotero", "chen2024.md"), "---\nzotero_key: \"library/" + a.key + "\"\n---\n");

	// Item pane
	let doc = new JSDOM("<div id=b></div>").window.document;
	let body = doc.getElementById("b");
	let summary;
	env.panes[0].onRender({ doc, body, item: a, setSectionSummary: s => { summary = s; } });
	assert.equal(summary, "衛教降低跌倒。");
	let keyPoints = body.querySelector('[data-zb-sub="keyPoints"]');
	assert.equal(keyPoints.querySelector(".zb-sp-lead").textContent, "衛教降低跌倒。");
	assert.equal(keyPoints.querySelector(".zb-sp-facts").textContent, "RCT · N = 80");
	assert.doesNotMatch(body.textContent, /study_design/);
	// The whole AI note, folded, named by model and date; its one-sentence summary only in 重點
	let full = keyPoints.querySelector("[data-zb-full-note]");
	assert.equal(full.querySelector("summary").textContent, "完整 AI 筆記（claude-opus-5-5 · 2026-10-01）");
	assert.deepEqual([...full.querySelectorAll("li")].map(li => li.textContent), ["設計：RCT"]);
	assert.doesNotMatch(full.textContent, /衛教降低跌倒/);
	// The catalog's item commands (進階: all on) and 快速指令…; 「開啟評讀表」 on the 文獻評讀表 row (appraisal-form.js)
	assert.deepEqual([...body.querySelectorAll('[data-zb-sub="actions"] button')].map(b => b.dataset.zbCommand),
		["sync", "sync-no-ai", "regenerate", "classify", "search-item", "chase-items", "appraisal-coach", "palette"]);
	assert.ok(body.querySelector('[data-zb-appraisal] [data-zb-action="toggle"]'));
	assert.match(body.textContent, /文獻評讀表：尚未評讀/);
	// The literature note in the vault: its link appears once the note has been read
	for (let i = 0; i < 100 && !body.querySelector("[data-zb-link=obsidian]"); i++) await new Promise(r => setTimeout(r, 10));
	assert.ok(body.querySelector("[data-zb-link=obsidian]"), "在 Obsidian 開啟筆記");
	assert.equal(body.querySelector("[data-zb-links]").hidden, false);
	// An AI note saved by Zotero Bridge (≤ 0.10): read exactly like a current one
	let oldHTML = aiNote.noteHTML.split("ZotMax").join("Zotero Bridge");
	assert.match(oldHTML, /產生（Zotero Bridge）<\/em>[\s\S]*📋 結構化資料（Zotero Bridge）/);
	let fromOld = env.context.ZB.main.readAINote(oldHTML);
	assert.equal(JSON.stringify(fromOld), JSON.stringify(env.context.ZB.main.readAINote(aiNote.noteHTML)));
	assert.equal(fromOld.data.sample_size, 80);
	assert.equal(fromOld.at, "2026-10-01T00:00:00Z");
	assert.doesNotMatch(fromOld.md, /Zotero Bridge|結構化資料/);
	env.panes[0].onRender({ doc, body, item: b, setSectionSummary: s => { summary = s; } });
	assert.equal(summary, "尚未產生");
	assert.match(body.querySelector('[data-zb-sub="keyPoints"]').textContent, /這篇還沒有 AI 文獻筆記。/);

	// Synthesis from the collection menu
	let collection = { id: 7, name: "碩論", libraryID: 1, getChildItems: () => [a, b] };
	let collMenu = env.menus[1].menus[0].menus.find(m => m.l10nID === "zotero-bridge-menu-synthesis");
	collMenu.onCommand({}, { collectionTreeRows: [{ isCollection: () => true, ref: collection }] });
	await env.context.ZB.main.run([], {});
	assert.deepEqual(env.errors, []);
	let line = env.progressLines.at(-1);
	assert.equal(line.error, undefined, line.text);
	assert.match(line.text, /已寫入 Notion、Obsidian、Zotero 筆記/);
	// 50,000 × $4 + 8,000 × $20 per million = $0.36
	assert.equal(env.descriptions.at(-1), "AI 用量：1 次呼叫，輸入 50,000／輸出 8,000 tokens，約 US$0.36");

	let llm = log.find(l => l.url.startsWith("https://api.anthropic.com/"));
	assert.match(llm.body.messages[0].content, /<source id="S1">[\s\S]*<ai_note>[\s\S]*衛教降低跌倒/);
	assert.doesNotMatch(llm.body.messages[0].content, /study_design|結構化資料/, "the JSON block is not sent to the synthesis");
	assert.match(llm.body.messages[0].content, /<source id="S2">[\s\S]*abstract B/);

	let create = log.find(l => l.url === "https://api.notion.com/v1/pages");
	assert.deepEqual(create.body.parent, { type: "page_id", page_id: "22222222-2222-2222-2222-222222222222" });
	let appended = log.find(l => l.url.endsWith("/blocks/syn-page/children"));
	assert.ok(appended.body.children.some(bl => bl.type === "table"));

	let dir = path.join(vault, "Zotero", "文獻比較");
	let files = fs.readdirSync(dir);
	assert.equal(files.length, 1);
	let text = fs.readFileSync(path.join(dir, files[0]), "utf8");
	assert.match(text, /兩篇都有效 \[\[Zotero\/chen2024\|Chen, 2024\]\]; \(Lee, 2021\)/);
	assert.match(text, /^\| \[\[Zotero\/chen2024\\\|Chen, 2024\]\] \| RCT \|$/m);
	assert.match(text, /^notion: "https:\/\/www\.notion\.so\/syn-page"$/m);

	let synNote = [...env.items.values()].find(i => i.tags.includes("zotero-bridge-synthesis"));
	assert.ok(synNote);
	assert.deepEqual(synNote.collectionsAdded, [7]);
	assert.deepEqual(synNote.related.sort(), [a.key, b.key].sort());
	assert.match(synNote.noteHTML, /<table>/);
});

test("keys come from the login manager; batch confirm shows a cost estimate; 529 is retried", async () => {
	let vault = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-vault-"));
	let calls = 0;
	let fetch = async (url, init) => {
		assert.equal(init.headers["x-api-key"], "sk-ant-stored");
		calls++;
		if (calls === 1) {
			return {
				status: 529, ok: false, statusText: "",
				headers: { get: k => (k === "retry-after" ? "2" : null) },
				text: async () => JSON.stringify({ error: { type: "overloaded_error", message: "Overloaded" } }),
			};
		}
		return {
			status: 200, ok: true, headers: { get: () => null },
			text: async () => JSON.stringify({
				model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: AI_MD }],
				usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			}),
		};
	};
	let confirms = [];
	let env = makeEnv({
		fetch,
		confirm: (text) => {
			confirms.push(text);
			return true;
		},
		// Stored by an earlier session; nothing in prefs
		logins: [new LoginInfo("chrome://zotero-bridge", null, "Zotero Bridge", "anthropicKey", "sk-ant-stored")],
		prefs: {
			"extensions.zotero-bridge.obsidian.vaultPath": vault,
			"extensions.zotero-bridge.obsidian.folder": "",
			"extensions.zotero-bridge.obsidian.filenameFormat": "title",
			"extensions.zotero-bridge.routing.rules": "[]",
			"extensions.zotero-bridge.llm.enabled": true,
			"extensions.zotero-bridge.llm.provider": "anthropic",
			"extensions.zotero-bridge.llm.anthropicModel": "claude-opus-5-5",
			"extensions.zotero-bridge.llm.fullTextLimit": "0",
			// Two earlier calls averaging 10,000 input + 2,000 output tokens = $0.08 per call
			"extensions.zotero-bridge.usage.ledger": JSON.stringify({
				"2020-01": { calls: 2, input: 20000, output: 4000, byModel: { "claude-opus-5-5": { calls: 2, input: 20000, output: 4000 } } },
			}),
		},
	});
	await vm.runInContext(`startup({ id: "zb", version: "0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);
	let sleeps = [];
	env.context.ZB.main.runtime.retry = { sleep: async (ms) => { sleeps.push(ms); } };
	// Record every status line (the retry notice is replaced once the item finishes)
	let statuses = [];
	let push = env.progressLines.push.bind(env.progressLines);
	env.progressLines.push = (line) => {
		let setText = line.setText.bind(line);
		line.setText = (t) => {
			statuses.push(t);
			setText(t);
		};
		return push(line);
	};
	let items = Array.from({ length: 6 }, (_, i) => new env.MockItem("journalArticle", { title: `Paper ${i}`, year: "2024", abstractNote: `Abstract ${i}` }));
	await env.context.ZB.main.run(items, { targets: ["notion", "obsidian"], ai: "missing" });

	assert.deepEqual(env.errors, []);
	assert.equal(confirms.length, 1);
	assert.match(confirms[0], /6 筆文獻呼叫 Claude（claude-opus-5-5）/);
	assert.match(confirms[0], /預估費用：約 US\$0\.48（6 筆 × 每筆約 US\$0\.08，依過去 2 次呼叫的平均用量估算/);
	assert.equal(calls, 7, "one retry after the 529, then one call per item");
	assert.deepEqual(sleeps, [2000], "retry-after (seconds) is honored");
	assert.ok(statuses.some(t => /AI 服務暫時無法使用（529），2 秒後重試（1\/4）/.test(t)), statuses.join("\n"));
	assert.ok(env.progressLines.every(l => l.progress === 100));

	let ledger = JSON.parse(env.prefStore["extensions.zotero-bridge.usage.ledger"]);
	let month = ledger[env.context.ZB.usage.monthKey()];
	assert.equal(month.calls, 6);
	assert.equal(month.input, 6000);
	assert.equal(month.output, 3000);
	assert.equal(ledger["2020-01"].calls, 2, "history kept");
	// 6,000 × $4 + 3,000 × $20 per million = $0.084
	assert.equal(env.descriptions.at(-1), "AI 用量：6 次呼叫，輸入 6,000／輸出 3,000 tokens，約 US$0.08");
	let report = env.context.ZB.main.usageReport();
	assert.equal(report[0], "呼叫次數：6");
	assert.match(report[2], /估計費用：US\$0\.08/);

	// Without a stored key nothing is called
	await env.context.ZB.secrets.clear("anthropicKey");
	assert.deepEqual(env.loginManager.logins, []);
	await env.context.ZB.main.run(items, { targets: ["obsidian"], ai: "regenerate" });
	assert.equal(calls, 7);
});

test("settings pane loads and saves secrets through the login manager, never prefs", async () => {
	let xhtml = fs.readFileSync(path.join(ROOT, "content", "preferences.xhtml"), "utf8");
	let passwords = [...xhtml.matchAll(/<html:input[^>]*type="password"[^>]*>/g)].map(m => m[0]);
	// Claude, OpenAI, Notion, NCBI (PubMed watch)
	assert.equal(passwords.length, 4);
	for (let tag of passwords) assert.doesNotMatch(tag, /preference=/, tag);
	assert.doesNotMatch(xhtml, /llm\.anthropicKey|llm\.openaiKey|notion\.token/);

	let env = makeEnv({
		fetch: async () => { throw new Error("no network in this test"); },
		logins: [new LoginInfo("chrome://zotero-bridge", null, "Zotero Bridge", "notionToken", "ntn_stored")],
		prefs: {
			"extensions.zotero-bridge.llm.openaiKey": "sk-legacy",
			"extensions.zotero-bridge.usage.ledger": "{}",
		},
	});
	env.Zotero.Prefs.registerObserver = () => Symbol("obs");
	env.Zotero.Prefs.unregisterObserver = () => {};
	env.Zotero.Libraries.getAll = () => [];
	await vm.runInContext(`startup({ id: "zb", version: "0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);

	let { window } = new JSDOM(`<div>
		<input id="zb-anthropic-key" type="password"><input id="zb-openai-key" type="password"><input id="zb-notion-token" type="password">
		<div id="zb-secrets-status"></div><pre id="zb-usage"></pre><div id="zb-rules"></div>
	</div>`);
	let paneScope = vm.createContext({ Zotero: env.Zotero, window, document: window.document, Event: window.Event, setTimeout, clearTimeout });
	vm.runInContext(fs.readFileSync(path.join(ROOT, "content", "preferences.js"), "utf8"), paneScope);
	let settle = () => new Promise(r => setTimeout(r, 0));
	window.ZoteroBridgePrefs.init();
	await env.context.ZB.secrets.get("notionToken");
	await settle();
	let $ = id => window.document.getElementById(id);
	assert.equal($("zb-notion-token").value, "ntn_stored");
	assert.equal($("zb-openai-key").value, "sk-legacy", "value migrated from prefs is shown");
	assert.equal($("zb-anthropic-key").value, "");
	assert.equal($("zb-usage").textContent, "本月尚未呼叫 AI。");
	assert.equal($("zb-secrets-status").textContent, "");

	// Typing saves to the login manager only
	let input = $("zb-anthropic-key");
	input.value = "sk-ant-new";
	input.dispatchEvent(new window.Event("input"));
	input.dispatchEvent(new window.Event("change"));
	await env.context.ZB.secrets.get("anthropicKey");
	await settle();
	let stored = Object.fromEntries(env.loginManager.logins.map(l => [l.username, l.password]));
	assert.deepEqual(stored, { notionToken: "ntn_stored", openaiKey: "sk-legacy", anthropicKey: "sk-ant-new" });
	assert.ok(!Object.keys(env.prefStore).some(k => /Key$|token$/.test(k)), Object.keys(env.prefStore).join(", "));

	// Clearing the field removes the login
	$("zb-notion-token").value = "";
	$("zb-notion-token").dispatchEvent(new window.Event("change"));
	assert.equal(await env.context.ZB.secrets.get("notionToken"), "");
	assert.ok(!env.loginManager.logins.some(l => l.username === "notionToken"));
	window.dispatchEvent(new window.Event("unload"));
});

test("bibliography export: the 匯出參考文獻 command writes references.json whose ids match the notes' citekeys", async () => {
	let vault = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-vault-"));
	let env = makeEnv({
		fetch: async () => { throw new Error("no network expected"); },
		prefs: {
			"extensions.zotero-bridge.obsidian.vaultPath": vault,
			"extensions.zotero-bridge.obsidian.folder": "Zotero",
			"extensions.zotero-bridge.obsidian.filenameFormat": "citekey",
			"extensions.zotero-bridge.routing.rules": "[]",
			"extensions.zotero-bridge.llm.enabled": false,
		},
	});
	await vm.runInContext(`startup({ id: "zb", version: "0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);
	let { MockItem } = env;
	let lee = [{ firstName: "Ann", lastName: "Lee", creatorType: "author" }];
	let keyed = new MockItem("journalArticle", { title: "Fall prevention RCT", year: "2024", citationKey: "chen2024", pages: "1-9", creators: [{ lastName: "Chen", creatorType: "author" }] });
	let older = new MockItem("journalArticle", { title: "Effects of exercise", year: "2021", creators: lee, dateAdded: "2023-01-01 00:00:00" });
	let newer = new MockItem("journalArticle", { title: "The effects of sleep", year: "2021", creators: lee, dateAdded: "2024-01-01 00:00:00" });
	let trashed = new MockItem("journalArticle", { title: "Deleted", year: "2020", creators: lee });
	trashed.deleted = true;
	let standalone = new MockItem("note");
	standalone.noteHTML = "<p>standalone</p>";

	// Sync the newer keyless item first: its note gets the key the export will use
	await env.context.ZB.main.run([newer], { targets: ["obsidian"], ai: "none" });
	let note = fs.readFileSync(path.join(vault, "Zotero", "Lee 2021 - The effects of sleep.md"), "utf8");
	assert.match(note, /^citekey: "lee2021effectsa"$/m);
	// An item with a Zotero Citation Key keeps it everywhere
	await env.context.ZB.main.run([keyed], { targets: ["obsidian"], ai: "none" });
	assert.match(fs.readFileSync(path.join(vault, "Zotero", "chen2024.md"), "utf8"), /^citekey: "chen2024"$/m);

	// 匯出參考文獻到 Obsidian from the toolbar button or 快速指令 (commands.js)
	let C = env.context.ZB.commands;
	assert.equal(C.get("bibliography").l10n, "zotero-bridge-menu-export-library");
	let toolsEntry = { onCommand: () => C.execute("bibliography") };
	toolsEntry.onCommand({}, {});
	await env.context.ZB.bibliography.whenIdle();
	assert.deepEqual(env.errors, []);
	let file = path.join(vault, "Zotero", "references.json");
	let refs = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.deepEqual(refs.map(r => r.id), ["chen2024", "lee2021effects", "lee2021effectsa"]);
	assert.equal(refs.find(r => r.id === "lee2021effectsa").title, "The effects of sleep");
	assert.equal(refs[0].URL, undefined, "journal article with pages: URL dropped as in Zotero's APA output");
	assert.equal(refs[1].URL, "https://example.org/" + older.key);
	assert.match(env.descriptions.at(-1), /已匯出 3 筆參考文獻到 Zotero\/references\.json/);
	assert.equal(env.translations.length, 0, "no .bib unless enabled");
	// Generated keys are remembered in the vault so they never move to another item
	let store = JSON.parse(fs.readFileSync(path.join(vault, "Zotero", ".zotero-bridge-citekeys.json"), "utf8"));
	assert.deepEqual(store, { keys: { [`library/${older.key}`]: "lee2021effects", [`library/${newer.key}`]: "lee2021effectsa" }, retired: [] });

	// Unchanged library → file not rewritten
	let mtime = fs.statSync(file).mtimeMs;
	await new Promise(r => setTimeout(r, 20));
	toolsEntry.onCommand({}, {});
	await env.context.ZB.bibliography.whenIdle();
	assert.equal(fs.statSync(file).mtimeMs, mtime);

	// Collection menu → ZotMax ▸ 匯出目前分類的參考文獻: same keys as the main file, only that collection's items
	let collEntry = env.menus.find(m => m.menuID === "zotero-bridge-collection").menus[0].menus.find(m => m.l10nID === "zotero-bridge-cmd-export-collection");
	let collection = { id: 7, name: "碩論", libraryID: 1, getChildItems: () => [newer] };
	let context = { collectionTreeRows: [{ isCollection: () => true, ref: collection }] };
	let visible;
	collEntry.onShowing({}, Object.assign({ setVisible: v => { visible = v; } }, context));
	assert.equal(visible, true);
	collEntry.onCommand({}, context);
	await env.context.ZB.bibliography.whenIdle();
	let coll = JSON.parse(fs.readFileSync(path.join(vault, "Zotero", "references-碩論.json"), "utf8"));
	assert.deepEqual(coll.map(r => r.id), ["lee2021effectsa"]);

	// 「同步時自動更新參考文獻檔」 + BibTeX: a sync refreshes both files
	env.prefStore["extensions.zotero-bridge.export.autoUpdate"] = true;
	env.prefStore["extensions.zotero-bridge.export.bibtex"] = true;
	let added = new MockItem("book", { title: "Nursing theory", year: "2019", creators: [{ lastName: "Wang", creatorType: "author" }] });
	await env.context.ZB.main.run([added], { targets: ["obsidian"], ai: "none" });
	refs = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.deepEqual(refs.map(r => r.id), ["chen2024", "lee2021effects", "lee2021effectsa", "wang2019nursing"]);
	let translation = env.translations.at(-1);
	assert.equal(translation.translatorID, "9cb70025-a888-4a29-a210-93ec52da40d4");
	assert.equal(translation.displayOptions.exportNotes, false);
	let bibText = fs.readFileSync(path.join(vault, "Zotero", "references.bib"), "utf8");
	assert.deepEqual([...bibText.matchAll(/^@article\{([^,]+),/gm)].map(m => m[1]),
		["chen2024", "lee2021effects", "lee2021effectsa", "wang2019nursing"]);
	assert.match(bibText, /@article\{lee2021effectsa,\n\ttitle = \{The effects of sleep\}/);
	assert.deepEqual(env.errors, []);
	assert.ok(!fs.readdirSync(path.join(vault, "Zotero")).some(f => f.endsWith(".tmp")));

	await vm.runInContext("shutdown()", env.context);
});

function basePrefs(vault, extra = {}) {
	return Object.assign({
		"extensions.zotero-bridge.obsidian.vaultPath": vault,
		"extensions.zotero-bridge.obsidian.vaultName": "Vault",
		"extensions.zotero-bridge.obsidian.folder": "Zotero",
		"extensions.zotero-bridge.obsidian.filenameFormat": "citekey",
		"extensions.zotero-bridge.obsidian.createBase": false,
		// No 研究儀表板.md in the folder listings below (test/dashboard-smoke.test.cjs covers it)
		"extensions.zotero-bridge.dashboard.autoUpdate": false,
		"extensions.zotero-bridge.notion.token": "ntn_test",
		"extensions.zotero-bridge.notion.database": "https://www.notion.so/ws/Default-11111111111111111111111111111111",
		"extensions.zotero-bridge.routing.rules": JSON.stringify([
			{ name: "thesis", library: "user", collection: "碩論", obsidianFolder: "Thesis" },
		]),
		"extensions.zotero-bridge.llm.enabled": false,
	}, extra);
}

// .md files under `dir` (recursively, hidden folders included) whose frontmatter has `zoteroKey`
function notesWithKey(dir, zoteroKey) {
	return fs.readdirSync(dir, { recursive: true })
		.filter(f => f.endsWith(".md") && fs.readFileSync(path.join(dir, f), "utf8").includes(`zotero_key: "${zoteroKey}"`))
		.sort();
}

test("a changed citekey renames the item's existing note instead of writing a second one", async () => {
	let vault = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-vault-"));
	let log = [];
	let env = makeEnv({ fetch: notionMock(log), prefs: basePrefs(vault) });
	await vm.runInContext(`startup({ id: "zb", version: "0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);
	let creators = [{ lastName: "Chen", creatorType: "author" }];
	let a = new env.MockItem("journalArticle", { title: "A", year: "2024", citationKey: "chen2024", creators });
	let b = new env.MockItem("journalArticle", { title: "B", year: "2021", citationKey: "lee2021", creators });
	let c = new env.MockItem("journalArticle", { title: "C", year: "2023", citationKey: "wang2023", creators, collectionIDs: [7] });
	let sync = (items, targets = ["notion", "obsidian"]) => env.context.ZB.main.run(items, { targets, ai: "none" });
	await sync([a, b, c]);
	let zdir = path.join(vault, "Zotero");
	assert.deepEqual(fs.readdirSync(zdir).sort(), ["chen2024.md", "lee2021.md"]);
	assert.deepEqual(fs.readdirSync(path.join(vault, "Thesis")), ["wang2023.md"]);
	// Things the index must skip: a copy in a hidden folder, and the user's own notes
	fs.mkdirSync(path.join(zdir, ".trash"));
	fs.copyFileSync(path.join(zdir, "chen2024.md"), path.join(zdir, ".trash", "chen2024.md"));
	fs.writeFileSync(path.join(zdir, "my idea.md"), "# idea\n");
	fs.appendFileSync(path.join(zdir, "chen2024.md"), "\n我的心得\n");

	a.fields.citationKey = "chen2024b";
	log.length = 0;
	await sync([a]);
	assert.deepEqual(env.errors, []);
	assert.deepEqual(fs.readdirSync(zdir).sort(), [".trash", "chen2024b.md", "lee2021.md", "my idea.md"]);
	let text = fs.readFileSync(path.join(zdir, "chen2024b.md"), "utf8");
	assert.match(text, /我的心得/);
	assert.match(text, /^citekey: "chen2024b"$/m);
	let patch = log.find(l => l.method === "PATCH" && l.path === "pages/page-1");
	assert.equal(patch.body.properties.Obsidian.url, "obsidian://open?vault=Vault&file=Zotero%2Fchen2024b");

	// Rule folders are searched too
	c.fields.citationKey = "wang2023b";
	await sync([c], ["obsidian"]);
	assert.deepEqual(fs.readdirSync(path.join(vault, "Thesis")), ["wang2023b.md"]);

	// A Notion-only sync doesn't rename; its Obsidian link points to the note as it is
	a.fields.citationKey = "chen2024c";
	log.length = 0;
	await sync([a], ["notion"]);
	assert.ok(fs.existsSync(path.join(zdir, "chen2024b.md")));
	patch = log.find(l => l.method === "PATCH" && l.path === "pages/page-1");
	assert.equal(patch.body.properties.Obsidian.url, "obsidian://open?vault=Vault&file=Zotero%2Fchen2024b");

	// The new name belongs to another item: same collision rule as for new notes
	a.fields.citationKey = "lee2021";
	await sync([a], ["obsidian"]);
	assert.deepEqual(fs.readdirSync(zdir).filter(f => f.endsWith(".md")).sort(), [`lee2021 (${a.key}).md`, "lee2021.md", "my idea.md"]);
	assert.match(fs.readFileSync(path.join(zdir, "lee2021.md"), "utf8"), new RegExp(`zotero_key: "library/${b.key}"`));
	// Syncing again keeps that name
	await sync([a], ["obsidian"]);
	assert.ok(fs.existsSync(path.join(zdir, `lee2021 (${a.key}).md`)));

	// The user filed the note in a subfolder: it is renamed there, not recreated at the top
	fs.mkdirSync(path.join(zdir, "讀完"));
	fs.renameSync(path.join(zdir, `lee2021 (${a.key}).md`), path.join(zdir, "讀完", `lee2021 (${a.key}).md`));
	a.fields.citationKey = "chen2025";
	log.length = 0;
	await sync([a]);
	assert.deepEqual(env.errors, []);
	assert.ok(!fs.existsSync(path.join(zdir, "chen2025.md")));
	text = fs.readFileSync(path.join(zdir, "讀完", "chen2025.md"), "utf8");
	assert.match(text, /我的心得/);
	patch = log.find(l => l.method === "PATCH" && l.path === "pages/page-1");
	assert.equal(patch.body.properties.Obsidian.url, "obsidian://open?vault=Vault&file=Zotero%2F%E8%AE%80%E5%AE%8C%2Fchen2025");
	assert.deepEqual(notesWithKey(vault, `library/${a.key}`), ["Zotero/.trash/chen2024.md", "Zotero/讀完/chen2025.md"]);
	assert.equal((text.match(/zotero-bridge:start/g) || []).length, 1);
});

test("trashed and deleted items: Notion page to the trash, Obsidian note marked, restore undoes it", async () => {
	let vault = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-vault-"));
	let log = [];
	let pages = new Map();
	let timers = [];
	let env = makeEnv({ fetch: notionMock(log, pages), timers, prefs: basePrefs(vault, { "extensions.zotero-bridge.autoSync": true }) });
	await vm.runInContext(`startup({ id: "zb", version: "0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);
	let ZB = env.context.ZB;
	let creators = [{ lastName: "Chen", creatorType: "author" }];
	let a = new env.MockItem("journalArticle", { title: "A", year: "2024", citationKey: "chen2024", creators });
	let b = new env.MockItem("journalArticle", { title: "B", year: "2021", citationKey: "lee2021", creators });
	let c = new env.MockItem("journalArticle", { title: "C", year: "2023", citationKey: "wang2023", creators, collectionIDs: [7] });
	let child = new env.MockItem("note");
	child.noteHTML = "<p>child note</p>";
	env.addChild(b, child);
	await ZB.main.run([a, b, c], { targets: ["notion", "obsidian"], ai: "none" });
	assert.deepEqual([...pages.values()].map(p => p.id), ["page-1", "page-2", "page-3"]);
	let fileA = path.join(vault, "Zotero", "chen2024.md");
	let fileB = path.join(vault, "Zotero", "lee2021.md");
	let fileC = path.join(vault, "Thesis", "wang2023.md");
	fs.appendFileSync(fileA, "\n我的心得\n");

	let observer = env.observers[0];
	assert.deepEqual([...observer.types], ["item"]);
	let flush = async () => {
		let pending = timers.filter(t => t.ms === 8000 && !t.cleared && !t.fired);
		assert.equal(pending.length, 1, "one debounced flush");
		pending[0].fired = true;
		pending[0].fn();
		await ZB.main.run([], {}); // wait for the queued work
	};

	// Move A to the trash: Zotero sends modify + trash
	a.deleted = true;
	observer.ref.notify("modify", "item", [a.id], {});
	observer.ref.notify("trash", "item", [a.id], {});
	log.length = 0;
	await flush();
	assert.deepEqual(env.errors, []);
	let query = log.find(l => l.path === "data_sources/ds-1/query");
	assert.deepEqual(query.body.filter.or, [{ property: "Zotero Key", rich_text: { equals: `library/${a.key}` } }]);
	assert.deepEqual(log.filter(l => l.method === "PATCH" && l.path.startsWith("pages/")).map(l => [l.path, l.body]),
		[["pages/page-1", { in_trash: true }]], "only archived, the trashed item itself is not synced");
	let text = fs.readFileSync(fileA, "utf8");
	assert.match(text, /^status: "已刪除"$/m);
	assert.match(text, /^status_before_delete: "待讀"$/m);
	assert.match(text, /> \[!warning\] 已從 Zotero 刪除/);
	assert.match(text, /我的心得/);
	assert.match(fs.readFileSync(fileB, "utf8"), /^status: "待讀"$/m);

	// A trashed child note re-syncs its parent instead of archiving anything
	child.deleted = true;
	b.children = b.children.filter(id => id !== child.id);
	observer.ref.notify("trash", "item", [child.id], {});
	log.length = 0;
	await flush();
	assert.ok(log.some(l => l.method === "PATCH" && l.path === "pages/page-2" && l.body.properties));
	assert.ok(!log.some(l => l.body && l.body.in_trash));
	assert.doesNotMatch(fs.readFileSync(fileB, "utf8"), /child note/);

	// B deleted for good (e.g. emptied from the trash): only libraryID/key are left
	env.items.delete(b.id);
	observer.ref.notify("delete", "item", [b.id], { [b.id]: { libraryID: 1, key: b.key } });
	log.length = 0;
	await flush();
	assert.deepEqual(log.filter(l => l.body && l.body.in_trash).map(l => l.path), ["pages/page-2"]);
	assert.match(fs.readFileSync(fileB, "utf8"), /^status: "已刪除"$/m);
	assert.ok(fs.existsSync(fileB), "the user's file is kept");

	// Trashed, then restored before the timer fired: nothing is archived and the item syncs
	c.deleted = true;
	observer.ref.notify("trash", "item", [c.id], {});
	c.deleted = false;
	observer.ref.notify("modify", "item", [c.id], {});
	log.length = 0;
	await flush();
	assert.ok(!log.some(l => l.body && l.body.in_trash));
	assert.ok(log.some(l => l.method === "PATCH" && l.path === "pages/page-3" && l.body.properties));
	assert.match(fs.readFileSync(fileC, "utf8"), /^status: "待讀"$/m);

	// A restored from the trash later: a sync gives the note its status back
	a.deleted = false;
	await ZB.main.run([a], { targets: ["obsidian"], ai: "none" });
	text = fs.readFileSync(fileA, "utf8");
	assert.match(text, /^status: "待讀"$/m);
	assert.doesNotMatch(text, /已從 Zotero 刪除|zotero_deleted/);
	assert.match(text, /我的心得/);

	// archiveItems can be called directly; already-archived items are no-ops
	let counts = await ZB.main.archiveItems([`library/${b.key}`, "library/NOSUCHKEY"]);
	assert.deepEqual({ ...counts }, { notion: 0, obsidian: 0 });

	// Nothing happens while auto-sync is off
	env.prefStore["extensions.zotero-bridge.autoSync"] = false;
	let before = timers.length;
	observer.ref.notify("trash", "item", [c.id], {});
	assert.equal(timers.length, before);
	assert.deepEqual(env.errors, []);
});

test("regenerating the AI note keeps the previous version as a history note that is never synced", async () => {
	let vault = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-vault-"));
	let log = [];
	let timers = [];
	let env = makeEnv({
		fetch: notionMock(log), timers,
		prefs: basePrefs(vault, {
			"extensions.zotero-bridge.autoSync": true,
			"extensions.zotero-bridge.llm.enabled": true,
			"extensions.zotero-bridge.llm.provider": "anthropic",
			"extensions.zotero-bridge.llm.anthropicKey": "sk-ant-test",
			"extensions.zotero-bridge.llm.anthropicModel": "claude-opus-5-5",
			"extensions.zotero-bridge.includeNotes": true,
		}),
	});
	await vm.runInContext(`startup({ id: "zb", version: "0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);
	let ZB = env.context.ZB;
	let item = new env.MockItem("journalArticle", { title: "A", year: "2024", citationKey: "chen2024", creators: [{ lastName: "Chen", creatorType: "author" }] });
	let own = new env.MockItem("note");
	own.noteHTML = "<p>My own note</p>";
	env.addChild(item, own);
	let notes = () => env.Zotero.Items.get(item.getNotes());

	await ZB.main.run([item], { targets: ["notion", "obsidian"], ai: "missing" });
	let aiNote = notes().find(n => n.tags.includes("zotero-bridge-ai"));
	assert.ok(aiNote);
	aiNote.noteHTML = aiNote.noteHTML.replace("</h1>", "</h1><p>使用者在 Zotero 改過的第一版</p>");

	log.length = 0;
	await ZB.main.run([item], { targets: ["notion", "obsidian"], ai: "regenerate" });
	assert.deepEqual(env.errors, []);
	let history = notes().filter(n => n.tags.includes("zotero-bridge-ai-history"));
	assert.equal(history.length, 1);
	assert.deepEqual(history[0].tags, ["zotero-bridge-ai-history"]);
	assert.equal(history[0].parentID, item.id);
	assert.match(history[0].noteHTML, /^<h1>🤖 AI 文獻筆記（舊版 \d{4}-\d{2}-\d{2} \d{2}:\d{2}）<\/h1>/);
	assert.match(history[0].noteHTML, /使用者在 Zotero 改過的第一版/);
	assert.equal(notes().filter(n => n.tags.includes("zotero-bridge-ai")).length, 1, "still one current AI note");
	assert.doesNotMatch(aiNote.noteHTML, /第一版/, "the AI note itself was overwritten");

	// Once it exists, the history note is not sent to Notion, Obsidian or the LLM; the user's own note is
	log.length = 0;
	await ZB.main.run([item], { targets: ["notion", "obsidian"], ai: "reuse" });
	// The container and its folded sections (the notes are in a toggle)
	let written = JSON.stringify(log.filter(l => l.method === "PATCH" && /^blocks\/[\w-]+\/children$/.test(l.path)).map(l => l.body));
	assert.match(written, /My own note/);
	assert.doesNotMatch(written, /舊版|第一版/);
	let text = fs.readFileSync(path.join(vault, "Zotero", "chen2024.md"), "utf8");
	assert.match(text, /My own note/);
	assert.doesNotMatch(text, /舊版|第一版/);

	// Regenerating again adds another history note
	log.length = 0;
	await ZB.main.run([item], { targets: ["obsidian"], ai: "regenerate" });
	assert.equal(notes().filter(n => n.tags.includes("zotero-bridge-ai-history")).length, 2);
	let prompt = log.find(l => l.api === "anthropic").body.messages[0].content;
	assert.match(prompt, /My own note/);
	assert.doesNotMatch(prompt, /舊版|第一版/);

	// Zotero reports the saves (new history note, AI note, and the parent item): no auto-sync follows
	let historyIDs = notes().filter(n => n.tags.includes("zotero-bridge-ai-history")).map(n => n.id);
	let observer = env.observers[0].ref;
	observer.notify("add", "item", historyIDs, {});
	observer.notify("modify", "item", [aiNote.id, item.id], {});
	let flushes = () => timers.filter(t => t.ms === 8000 && !t.cleared && !t.fired);
	assert.equal(flushes().length, 0, "nothing queued");
	// A history note the user edits later doesn't trigger a sync either
	for (let t of timers.filter(t => t.ms === 16000)) t.fn();
	observer.notify("modify", "item", historyIDs, {});
	assert.equal(flushes().length, 0);
	// …while a real change to the item does
	observer.notify("modify", "item", [item.id], {});
	assert.equal(flushes().length, 1);
	log.length = 0;
	let t = flushes()[0];
	t.fired = true;
	t.fn();
	await ZB.main.run([], {});
	assert.equal(log.filter(l => l.api === "anthropic").length, 0, "auto-sync never calls the LLM");
	assert.ok(log.some(l => l.method === "PATCH" && l.path === "pages/page-1" && l.body.properties));
	assert.deepEqual(env.errors, []);
});

test("a batch can be stopped from the Tools menu and resumed later; failures are kept for the retry", async () => {
	let vault = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-vault-"));
	let env = makeEnv({ fetch: async () => { throw new Error("no network expected"); }, prefs: basePrefs(vault, { "extensions.zotero-bridge.notion.token": "" }) });
	await vm.runInContext(`startup({ id: "zb", version: "0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);
	let ZB = env.context.ZB;
	let creators = [{ lastName: "Chen", creatorType: "author" }];
	let items = ["a", "b", "c", "d"].map((k, i) => new env.MockItem("journalArticle",
		{ title: `Paper ${k}`, year: "2024", citationKey: `key${k}`, creators, key: `KEY${k.toUpperCase()}` }));
	let pending = () => JSON.parse(env.prefStore["extensions.zotero-bridge.batch.pending"] || "null");

	// Tools menu entries, shown through onShowing like MenuManager does
	let tools = env.menus.find(m => m.menuID === "zotero-bridge-tools").menus;
	let entry = id => tools.find(m => m.l10nID === id);
	let showing = (id) => {
		let state = { visible: true, args: null };
		entry(id).onShowing({}, { setVisible: v => { state.visible = v; }, setL10nArgs: a => { state.args = JSON.parse(a); } });
		return state;
	};
	assert.equal(showing("zotero-bridge-menu-stop").visible, false);
	assert.equal(showing("zotero-bridge-menu-resume").visible, false);

	// Stop while the second item is being written
	let seen = [];
	let push = env.progressLines.push.bind(env.progressLines);
	env.progressLines.push = (line) => {
		seen.push(line.text);
		if (line.text === "Paper b") {
			assert.equal(showing("zotero-bridge-menu-stop").visible, true);
			assert.deepEqual(pending().remaining, ["1/KEYA", "1/KEYB", "1/KEYC", "1/KEYD"].slice(1), "progress saved per item");
			entry("zotero-bridge-menu-stop").onCommand();
		}
		return push(line);
	};
	await ZB.main.run(items, { targets: ["obsidian"], ai: "none" });
	assert.deepEqual(seen, ["Paper a", "Paper b", "正在停止…（處理中的這篇完成後停止）"]);
	assert.deepEqual(fs.readdirSync(path.join(vault, "Zotero")).sort(), ["keya.md", "keyb.md"]);
	let stopLine = env.progressLines.find(l => l.text === "已停止");
	assert.ok(stopLine && stopLine.progress === 100);
	assert.ok(env.descriptions.includes("完成 2 筆，未處理 2 筆"), env.descriptions.join("\n"));
	assert.equal(env.descriptions.at(-1), "要接續：工具 → 繼續未完成的 ZotMax 同步（2 筆）");
	let saved = pending();
	assert.deepEqual(saved.remaining, ["1/KEYC", "1/KEYD"]);
	assert.deepEqual(saved.failed, []);
	assert.deepEqual(saved.action, { targets: ["obsidian"], ai: "none" });
	assert.equal(saved.running, false);
	assert.equal(showing("zotero-bridge-menu-stop").visible, false);
	assert.deepEqual(showing("zotero-bridge-menu-resume"), { visible: true, args: { count: 2 } });
	assert.equal(showing("zotero-bridge-menu-discard").visible, true);

	// Resume: one item now fails, so it stays for a retry; a deleted item is skipped
	env.progressLines.push = push;
	let extract = ZB.adapter.extractItemData;
	ZB.adapter.extractItemData = async (item, ...rest) => {
		if (item.key === "KEYC") throw new Error("PDF 讀取失敗");
		return extract(item, ...rest);
	};
	await ZB.main.resumeBatch();
	assert.deepEqual(fs.readdirSync(path.join(vault, "Zotero")).sort(), ["keya.md", "keyb.md", "keyd.md"]);
	saved = pending();
	assert.deepEqual(saved.remaining, []);
	assert.deepEqual(saved.failed, ["1/KEYC"]);
	assert.equal(env.descriptions.at(-1), "要接續：工具 → 繼續未完成的 ZotMax 同步（1 筆，含失敗 1 筆）");
	assert.deepEqual(showing("zotero-bridge-menu-resume").args, { count: 1 });

	// Retrying the failure clears the record
	ZB.adapter.extractItemData = extract;
	await ZB.main.resumeBatch();
	assert.ok(fs.existsSync(path.join(vault, "Zotero", "keyc.md")));
	assert.equal(pending(), null);
	assert.equal(showing("zotero-bridge-menu-resume").visible, false);
	assert.equal(showing("zotero-bridge-menu-discard").visible, false);

	// A finished batch leaves nothing; single items and auto-sync are never tracked
	await ZB.main.run(items.slice(0, 2), { targets: ["obsidian"], ai: "none" });
	assert.equal(pending(), null);
	env.prefStore["extensions.zotero-bridge.batch.pending"] = JSON.stringify({ action: { targets: ["obsidian"], ai: "none" }, remaining: ["1/KEYA"], failed: [], total: 1, running: false });
	await ZB.main.run([items[3]], { targets: ["obsidian"], ai: "none" });
	await ZB.main.run(items, { targets: ["obsidian"], ai: "none", silent: true });
	assert.deepEqual(pending().remaining, ["1/KEYA"], "an unrelated single-item or silent run keeps the record");

	// Discard
	entry("zotero-bridge-menu-discard").onCommand();
	assert.equal(pending(), null);

	// Every pending item deleted: the record is cleared
	env.prefStore["extensions.zotero-bridge.batch.pending"] = JSON.stringify({ action: { targets: ["obsidian"], ai: "none" }, remaining: ["1/GONE"], failed: [], total: 1, running: false });
	await ZB.main.resumeBatch();
	assert.equal(pending(), null);
	assert.equal(env.descriptions.at(-1), "未完成的文獻都已刪除，已清除這筆紀錄。");
	assert.deepEqual(env.errors.map(String), ["Error: PDF 讀取失敗"]);
});

test("a batch cut off by shutdown is reported at the next startup", async () => {
	let vault = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-vault-"));
	let prefs = basePrefs(vault, { "extensions.zotero-bridge.notion.token": "" });
	let env = makeEnv({ fetch: async () => { throw new Error("no network expected"); }, prefs });
	await vm.runInContext(`startup({ id: "zb", version: "0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);
	let creators = [{ lastName: "Chen", creatorType: "author" }];
	let items = ["a", "b", "c"].map(k => new env.MockItem("journalArticle",
		{ title: `Paper ${k}`, year: "2024", citationKey: `key${k}`, creators, key: `KEY${k.toUpperCase()}` }));
	let push = env.progressLines.push.bind(env.progressLines);
	env.progressLines.push = (line) => {
		if (line.text === "Paper a") vm.runInContext("shutdown()", env.context);
		return push(line);
	};
	await env.context.ZB.main.run(items, { targets: ["obsidian"], ai: "none" });
	let saved = JSON.parse(env.prefStore["extensions.zotero-bridge.batch.pending"]);
	assert.deepEqual(saved.remaining, ["1/KEYB", "1/KEYC"]);
	assert.equal(saved.running, true, "still marked running so the next start reminds the user");

	// Next start with the same prefs
	let next = makeEnv({ fetch: async () => { throw new Error("no network expected"); }, prefs: env.prefStore });
	await vm.runInContext(`startup({ id: "zb", version: "0", rootURI: ${JSON.stringify(ROOT_URI)} })`, next.context);
	await new Promise(r => setTimeout(r, 0));
	assert.equal(next.descriptions.at(-1), "還有 2 筆文獻沒有同步。要接續：工具 → 繼續未完成的 ZotMax 同步。");
	assert.equal(JSON.parse(next.prefStore["extensions.zotero-bridge.batch.pending"]).running, false, "reminded once");
	assert.deepEqual(next.errors, []);
});

// ---------- reading status (status.js) ----------

const statusOf = text => (/^status: "?([^"\n]*)"?$/m.exec(text) || [])[1];
const syncedOf = text => (/^status_synced: "?([^"\n]*)"?$/m.exec(text) || [])[1];
const statusTags = item => item.tags.filter(t => t.startsWith("狀態/"));
const setNoteStatus = (file, value) => fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/^status: .*$/m, `status: ${value}`));

test("reading status: a change in Zotero, Notion or Obsidian reaches the other two on the next sync", async () => {
	let vault = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-vault-"));
	let log = [];
	let pages = new Map();
	let timers = [];
	let env = makeEnv({ fetch: notionMock(log, pages), timers, prefs: basePrefs(vault, { "extensions.zotero-bridge.autoSync": true }) });
	await vm.runInContext(`startup({ id: "zb", version: "0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);
	let ZB = env.context.ZB;
	let creators = [{ lastName: "Chen", creatorType: "author" }];
	let a = new env.MockItem("journalArticle", { title: "A", year: "2024", citationKey: "chen2024", creators });
	let b = new env.MockItem("journalArticle", { title: "B", year: "2021", citationKey: "lee2021", creators });
	let c = new env.MockItem("journalArticle", { title: "C", year: "2022", citationKey: "lin2022", creators });
	a.tags = ["fall prevention"];
	let sync = (items, targets = ["notion", "obsidian"]) => ZB.main.run(items, { targets, ai: "none" });
	let file = item => path.join(vault, "Zotero", item.fields.citationKey + ".md");
	let page = item => pages.get(`library/${item.key}`);
	let notionStatus = item => page(item).properties.Status && page(item).properties.Status.select.name;
	let statusPatches = () => log.filter(l => l.method === "PATCH" && /^pages\//.test(l.path) && l.body.properties && l.body.properties.Status)
		.map(l => [l.path, l.body.properties.Status.select.name]);

	// C was synced by an earlier version (no status sync), then dragged to 已讀 on the kanban
	env.prefStore["extensions.zotero-bridge.status.enabled"] = false;
	await sync([c]);
	assert.equal(notionStatus(c), undefined);
	setNoteStatus(file(c), "已讀");
	delete env.prefStore["extensions.zotero-bridge.status.enabled"];

	await sync([a, b, c]);
	assert.deepEqual(env.errors, []);
	for (let item of [a, b]) {
		let text = fs.readFileSync(file(item), "utf8");
		assert.equal(statusOf(text), "待讀");
		assert.equal(syncedOf(text), "待讀");
		assert.deepEqual(statusTags(item), ["狀態/待讀"]);
		assert.equal(notionStatus(item), "待讀");
	}
	// The user's 已讀 is kept (not the default 待讀) and given to Zotero and Notion
	let textC = fs.readFileSync(file(c), "utf8");
	assert.equal(statusOf(textC), "已讀");
	assert.equal(syncedOf(textC), "已讀");
	assert.deepEqual(statusTags(c), ["狀態/已讀 ✅"]);
	assert.equal(notionStatus(c), "已讀");
	// The status tag is carried by Status / `status`, not by Tags / `tags`
	assert.deepEqual(page(a).properties.Tags.multi_select, [{ name: "fall prevention" }]);
	assert.match(fs.readFileSync(file(a), "utf8"), /^tags:\n {2}- "fall-prevention"\nnotion:/m);
	assert.ok(env.progressLines.every(l => !/閱讀狀態/.test(l.text)), "no status messages for new or upgraded items");

	// Zotero: the user swaps the tag (e.g. with a colored tag's number key, so both are there for a moment)
	a.tags.push("狀態/已讀 ✅");
	log.length = 0;
	await sync([a]);
	assert.deepEqual(statusTags(a), ["狀態/已讀 ✅"], "exactly one status tag left");
	assert.equal(statusOf(fs.readFileSync(file(a), "utf8")), "已讀");
	assert.equal(syncedOf(fs.readFileSync(file(a), "utf8")), "已讀");
	assert.deepEqual(statusPatches(), [[`pages/${page(a).id}`, "已讀"]]);
	assert.equal(log.filter(l => l.path === "data_sources/ds-1/query").length, 1, "the page looked up for the status is reused");
	assert.equal(env.progressLines.at(-1).text, "A — 閱讀狀態 → 已讀（來自 Zotero）");

	// Notion: Status changed on the page
	page(b).properties.Status = { select: { name: "已引用" } };
	await sync([b]);
	assert.deepEqual(statusTags(b), ["狀態/已引用 📝"]);
	assert.equal(statusOf(fs.readFileSync(file(b), "utf8")), "已引用");
	assert.equal(env.progressLines.at(-1).text, "B — 閱讀狀態 → 已引用（來自 Notion）");

	// Obsidian: card dragged on the kanban (Obsidian writes the value unquoted)
	setNoteStatus(file(a), "閱讀中");
	log.length = 0;
	await sync([a]);
	assert.deepEqual(statusTags(a), ["狀態/閱讀中 📖"]);
	assert.equal(notionStatus(a), "閱讀中");
	assert.equal(syncedOf(fs.readFileSync(file(a), "utf8")), "閱讀中");

	// Changed in two places to different values: Obsidian wins, and the progress line says so
	setNoteStatus(file(b), "已讀");
	page(b).properties.Status = { select: { name: "閱讀中" } };
	await sync([b]);
	assert.equal(env.progressLines.at(-1).text, "B — ⚠️ 閱讀狀態衝突：Obsidian「已讀」、Notion「閱讀中」 → 採用 Obsidian「已讀」");
	assert.equal(env.progressLines.at(-1).error, undefined, "a conflict is not a failure");
	assert.equal(notionStatus(b), "已讀");
	assert.deepEqual(statusTags(b), ["狀態/已讀 ✅"]);

	// An Obsidian-only sync leaves Notion alone and doesn't move status_synced…
	a.tags = a.tags.filter(t => !t.startsWith("狀態/")).concat("狀態/已引用 📝");
	log.length = 0;
	await sync([a], ["obsidian"]);
	assert.equal(log.filter(l => l.api === "notion").length, 0);
	let textA = fs.readFileSync(file(a), "utf8");
	assert.equal(statusOf(textA), "已引用");
	assert.equal(syncedOf(textA), "閱讀中");
	// …so the next full sync still takes it to Notion, without a conflict
	await sync([a]);
	assert.equal(notionStatus(a), "已引用");
	assert.equal(syncedOf(fs.readFileSync(file(a), "utf8")), "已引用");
	assert.doesNotMatch(env.progressLines.at(-1).text, /衝突/);

	// The plugin's own tag write doesn't trigger auto-sync (Zotero notifies inside saveTx)…
	let observer = env.observers[0].ref;
	let flushes = () => timers.filter(t => t.ms === 8000 && !t.cleared && !t.fired);
	c.saveTx = async function () {
		observer.notify("modify", "item", [this.id], {});
		return this.id;
	};
	page(c).properties.Status = { select: { name: "閱讀中" } };
	await sync([c]);
	assert.deepEqual(statusTags(c), ["狀態/閱讀中 📖"]);
	assert.equal(flushes().length, 0, "nothing queued");
	// …but the user's next change to the item does
	c.tags = ["狀態/已引用 📝"];
	observer.notify("modify", "item", [c.id], {});
	assert.equal(flushes().length, 1);
	// Auto-sync follows a change in Zotero, so Zotero wins a conflict there (with a notice: no progress window)
	setNoteStatus(file(c), "已讀");
	let flush = flushes()[0];
	flush.fired = true;
	flush.fn();
	await ZB.main.run([], {});
	assert.deepEqual(statusTags(c), ["狀態/已引用 📝"]);
	assert.equal(statusOf(fs.readFileSync(file(c), "utf8")), "已引用");
	assert.equal(notionStatus(c), "已引用");
	assert.equal(env.descriptions.at(-1), "C\n⚠️ 閱讀狀態衝突：Zotero「已引用」、Obsidian「已讀」 → 採用 Zotero「已引用」");
	assert.deepEqual(env.errors, []);
});

test("reading status: 同步閱讀狀態 updates only the status of synced items and leaves trashed ones alone", async () => {
	let vault = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-vault-"));
	let log = [];
	let pages = new Map();
	let env = makeEnv({ fetch: notionMock(log, pages), prefs: basePrefs(vault) });
	await vm.runInContext(`startup({ id: "zb", version: "0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);
	let ZB = env.context.ZB;
	let creators = [{ lastName: "Chen", creatorType: "author" }];
	let [a, b, c, d] = ["a", "b", "c", "d"].map(k => new env.MockItem("journalArticle", { title: `Paper ${k}`, year: "2024", citationKey: `key${k}`, creators }));
	let neverSynced = new env.MockItem("journalArticle", { title: "Not synced", year: "2024", citationKey: "keye", creators });
	await ZB.main.run([a, b, c, d], { targets: ["notion", "obsidian"], ai: "none" });
	let file = item => path.join(vault, "Zotero", item.fields.citationKey + ".md");
	let page = item => pages.get(`library/${item.key}`);
	// D is trashed: its Notion page goes to the trash and its note is marked 已刪除
	d.deleted = true;
	await ZB.main.archiveItems([`library/${d.key}`]);
	let textD = fs.readFileSync(file(d), "utf8");
	assert.equal(statusOf(textD), "已刪除");

	// Changes in each app since the last sync; a's note also has the user's own writing
	setNoteStatus(file(a), "已讀");
	fs.appendFileSync(file(a), "\n我的心得\n");
	page(b).properties.Status = { select: { name: "閱讀中" } };
	c.tags = ["狀態/已引用 📝"];
	let before = new Map([a, b, c].map(i => [i, fs.readFileSync(file(i), "utf8")]));
	log.length = 0;

	// 同步閱讀狀態 from the toolbar button or 快速指令 (commands.js)
	env.context.ZB.commands.execute("status");
	await ZB.main.run([], {}); // runs after the pass
	assert.deepEqual(env.errors, []);

	// Notion: one query for the whole database, then one PATCH of just Status per page that changed
	let notionCalls = log.filter(l => l.api === "notion");
	let queries = notionCalls.filter(l => l.path === "data_sources/ds-1/query");
	assert.deepEqual(queries.map(q => q.body), [{ filter: { property: "Zotero Key", rich_text: { is_not_empty: true } }, page_size: 100 }]);
	let patches = notionCalls.filter(l => l.method === "PATCH");
	assert.deepEqual(patches.map(l => [l.path, l.body]), [
		[`pages/${page(a).id}`, { properties: { Status: { select: { name: "已讀" } } } }],
		[`pages/${page(c).id}`, { properties: { Status: { select: { name: "已引用" } } } }],
	]);
	assert.ok(!notionCalls.some(l => l.method === "POST" && l.path === "pages" || /^blocks\//.test(l.path)), "no pages created, no content rewritten");
	assert.equal(log.filter(l => l.api === "anthropic").length, 0);

	// Zotero: one status tag each
	assert.deepEqual(statusTags(a), ["狀態/已讀 ✅"]);
	assert.deepEqual(statusTags(b), ["狀態/閱讀中 📖"]);
	assert.deepEqual(statusTags(c), ["狀態/已引用 📝"]);
	// Obsidian: only the status keys changed
	let expected = { [a.key]: "已讀", [b.key]: "閱讀中", [c.key]: "已引用" };
	let withoutStatus = t => t.replace(/^status(_synced)?: .*\n/gm, "");
	for (let item of [a, b, c]) {
		let after = fs.readFileSync(file(item), "utf8");
		assert.equal(statusOf(after), expected[item.key]);
		assert.equal(syncedOf(after), expected[item.key]);
		assert.equal(withoutStatus(after), withoutStatus(before.get(item)));
	}
	assert.match(fs.readFileSync(file(a), "utf8"), /我的心得/);
	// The trashed item and the never-synced one are left alone
	assert.equal(fs.readFileSync(file(d), "utf8"), textD);
	assert.equal(page(d).in_trash, true);
	assert.deepEqual(statusTags(d), ["狀態/待讀"]);
	assert.deepEqual(neverSynced.tags, []);
	assert.ok(!fs.existsSync(file(neverSynced)));
	assert.equal(env.descriptions.at(-1), "閱讀狀態：檢查 3 筆，更新 Zotero 2 筆、Notion 2 筆、Obsidian 2 筆");

	// Run again: nothing left to do
	log.length = 0;
	env.context.ZB.commands.execute("status");
	await ZB.main.run([], {});
	assert.equal(log.filter(l => l.method === "PATCH").length, 0);
	assert.equal(env.descriptions.at(-1), "閱讀狀態：檢查 3 筆，三邊都一致");

	// A conflict is listed on its own progress line
	setNoteStatus(file(a), "閱讀中");
	page(a).properties.Status = { select: { name: "已引用" } };
	env.context.ZB.commands.execute("status");
	await ZB.main.run([], {});
	assert.ok(env.progressLines.some(l => l.text === "Paper a — ⚠️ 閱讀狀態衝突：Obsidian「閱讀中」、Notion「已引用」 → 採用 Obsidian「閱讀中」"));
	assert.equal(page(a).properties.Status.select.name, "閱讀中");
	assert.match(env.descriptions.at(-1), /；衝突 1 筆（依 Obsidian > Zotero > Notion 採用）$/);
	assert.deepEqual(env.errors, []);
});

test("reading status: without a vault the last synced value lives in a pref; the item pane sets the tag", async () => {
	let log = [];
	let pages = new Map();
	let env = makeEnv({ fetch: notionMock(log, pages), prefs: basePrefs("", { "extensions.zotero-bridge.obsidian.vaultPath": "" }) });
	await vm.runInContext(`startup({ id: "zb", version: "0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);
	let ZB = env.context.ZB;
	let a = new env.MockItem("journalArticle", { title: "A", year: "2024", citationKey: "chen2024", creators: [{ lastName: "Chen", creatorType: "author" }] });
	let bases = () => JSON.parse(env.prefStore["extensions.zotero-bridge.status.synced"] || "{}");
	await ZB.main.run([a], { targets: ["notion", "obsidian"], ai: "none" });
	assert.deepEqual(bases(), { [`library/${a.key}`]: "待讀" });
	assert.deepEqual(statusTags(a), ["狀態/待讀"]);

	// Item pane: the picker shows the Zotero status and changing it replaces the tag
	let doc = new JSDOM("<div id=b></div>").window.document;
	let body = doc.getElementById("b");
	env.panes[0].onRender({ doc, body, item: a, setSectionSummary: () => {} });
	let select = body.querySelector("select");
	assert.ok(select, "status picker rendered");
	assert.match(body.textContent, /閱讀狀態：/);
	assert.equal(select.value, "待讀");
	assert.deepEqual([...select.options].map(o => o.value), ["", "待讀", "閱讀中", "已讀", "已引用"]);
	select.value = "已讀";
	select.dispatchEvent(new doc.defaultView.Event("change"));
	assert.deepEqual(statusTags(a), ["狀態/已讀 ✅"]);

	// The next sync takes it to Notion and records it
	await ZB.main.run([a], { targets: ["notion"], ai: "none" });
	assert.equal(pages.get(`library/${a.key}`).properties.Status.select.name, "已讀");
	assert.deepEqual(bases(), { [`library/${a.key}`]: "已讀" });
	// …and a Notion change comes back through the Tools pass
	pages.get(`library/${a.key}`).properties.Status = { select: { name: "已引用" } };
	await ZB.status.runPass();
	assert.deepEqual(statusTags(a), ["狀態/已引用 📝"]);
	assert.deepEqual(bases(), { [`library/${a.key}`]: "已引用" });

	// Turned off: no tags, no Status, the pane shows no picker
	env.prefStore["extensions.zotero-bridge.status.enabled"] = false;
	let b = new env.MockItem("journalArticle", { title: "B", year: "2021", citationKey: "lee2021", creators: [] });
	await ZB.main.run([b], { targets: ["notion"], ai: "none" });
	assert.deepEqual(b.tags, []);
	assert.equal(pages.get(`library/${b.key}`).properties.Status, undefined);
	env.panes[0].onRender({ doc, body, item: b, setSectionSummary: () => {} });
	assert.equal(body.querySelector("select"), null);
	assert.deepEqual(env.errors, []);
});

// Found by the e2e test in Zotero 10.0.6: Zotero sends "unload" to the pane's root element and then
// nukes the pane script's sandbox, so cleanup registered on the window never ran ("can't access dead
// object"), the pref observers stayed registered and a key typed just before closing was not saved
test("settings pane: closing it saves a pending key and unregisters its pref observers (unload on the pane root)", async () => {
	let env = makeEnv({
		fetch: async () => { throw new Error("no network in this test"); },
		prefs: { "extensions.zotero-bridge.usage.ledger": "{}" },
	});
	let registered = new Set();
	env.Zotero.Prefs.registerObserver = () => {
		let s = Symbol("obs");
		registered.add(s);
		return s;
	};
	env.Zotero.Prefs.unregisterObserver = s => registered.delete(s);
	env.Zotero.Libraries.getAll = () => [];
	await vm.runInContext(`startup({ id: "zb", version: "0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);

	let { window } = new JSDOM(`<div id="zotero-bridge-prefs">
		<input id="zb-anthropic-key" type="password"><input id="zb-openai-key" type="password"><input id="zb-notion-token" type="password">
		<div id="zb-secrets-status"></div><pre id="zb-usage"></pre><div id="zb-rules"></div>
	</div>`);
	let paneScope = vm.createContext({ Zotero: env.Zotero, window, document: window.document, Event: window.Event, setTimeout, clearTimeout });
	vm.runInContext(fs.readFileSync(path.join(ROOT, "content", "preferences.js"), "utf8"), paneScope);
	// Observers the plugin itself keeps until shutdown (e.g. pubmed-watch.js) aren't the pane's
	let pluginObservers = new Set(registered);
	window.ZoteroBridgePrefs.init();
	await env.context.ZB.secrets.get("notionToken");
	await new Promise(r => setTimeout(r, 0));
	let paneObservers = () => [...registered].filter(o => !pluginObservers.has(o)).length;
	assert.equal(paneObservers(), 7, "provider + two usage + four search-source pref observers");

	// Typed, and the window closed before the 600 ms save delay
	let input = window.document.getElementById("zb-openai-key");
	input.value = "sk-typed-then-closed";
	input.dispatchEvent(new window.Event("input"));
	window.document.getElementById("zotero-bridge-prefs").dispatchEvent(new window.Event("unload"));
	assert.equal(await env.context.ZB.secrets.get("openaiKey"), "sk-typed-then-closed");
	assert.equal(paneObservers(), 0, "pref observers left registered after the pane closed");
	assert.equal(registered.size, pluginObservers.size, "the plugin's own observers stay until shutdown");
});
