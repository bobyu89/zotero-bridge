// Chinese-language items through the real plugin in a mocked Zotero: Chinese APA in the Obsidian
// note and Notion, full names in the frontmatter, references.json and a synthesis reference list.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const ROOT_URI = "file://" + ROOT + "/";

// The parts of Zotero, Gecko and the plugin scope that sync, export and synthesis touch
function makeEnv({ prefs, fetch }) {
	let items = new Map();
	let nextID = 100;
	let progressLines = [];
	let errors = [];
	let citeprocCalls = [];

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
			this.dateModified = "2024-05-02 08:00:00";
			this.version = 0;
			items.set(this.id, this);
		}
		get parentItem() { return this.parentID ? items.get(this.parentID) : undefined; }
		isRegularItem() { return !["note", "attachment", "annotation"].includes(this.itemType); }
		isNote() { return this.itemType === "note"; }
		isFileAttachment() { return this.itemType === "attachment"; }
		isPDFAttachment() { return this.itemType === "attachment"; }
		// Item.getField(field, unformatted, includeBaseMapped): `type` is thesisType, `publisher` university
		getField(f) {
			let base = { type: "thesisType", publisher: "university" };
			return this.fields[f] || (base[f] && this.fields[base[f]]) || "";
		}
		getCreatorsJSON() { return this.fields.creators || []; }
		getTags() { return this.tags.map(tag => ({ tag })); }
		addTag(t) { this.tags.push(t); }
		removeTag(t) { this.tags = this.tags.filter(x => x !== t); }
		getCollections() { return []; }
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
			if (this.parentID && !items.get(this.parentID).children.includes(this.id)) items.get(this.parentID).children.push(this.id);
			return this.id;
		}
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
			exists: id => items.has(id),
			getByLibraryAndKey: (libraryID, key) => [...items.values()].find(i => i.libraryID === libraryID && i.key === key) || false,
			getAll: async (libraryID, onlyTopLevel) => [...items.values()]
				.filter(i => i.libraryID === libraryID && !i.deleted && (!onlyTopLevel || !i.parentID)),
		},
		Libraries: {
			get: () => ({ libraryType: "user", name: "My Library" }),
			getAll: () => [{ libraryID: 1, libraryType: "user", name: "My Library" }],
		},
		Groups: { getGroupIDFromLibraryID: () => null },
		Collections: { get: ids => (Array.isArray(ids) ? [] : null), getByParent: () => [] },
		// Zotero's APA style through citeproc (English rules): used for the English item only
		Styles: { get: () => ({ getCiteProc: () => ({}) }) },
		Cite: {
			makeFormattedBibliographyOrCitationList: (engine, list) => {
				citeprocCalls.push(list[0].key);
				let f = list[0].fields;
				return `${f.creators[0].lastName}, ${f.creators[0].firstName[0]}. (${f.year}). ${f.title}. ${f.publicationTitle}.\n`;
			},
		},
		Utilities: {
			Item: {
				// Zotero's conversion (utilities_item.js): a single-field name becomes `literal`
				itemToCSLJSON: item => ({
					id: `http://zotero.org/users/1/items/${item.key}`,
					type: item.itemType === "thesis" ? "thesis" : "article-journal",
					title: item.fields.title,
					author: (item.fields.creators || []).map(c => (c.name ? { literal: c.name } : { family: c.lastName, given: c.firstName })),
					issued: { "date-parts": [[Number(item.fields.year)]] },
					language: item.fields.language || undefined,
				}),
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
		read: async p => new Uint8Array(await fsp.readFile(p)),
		getChildren: async p => (await fsp.readdir(p)).map(name => path.join(p, name)),
		stat: async (p) => {
			let st = await fsp.stat(p);
			return { path: p, type: st.isDirectory() ? "directory" : "regular", size: st.size };
		},
		move: async (from, to) => fsp.rename(from, to),
	};
	let PathUtils = { join: (...parts) => path.join(...parts), filename: p => path.basename(p), parent: p => path.dirname(p) };
	let logins = [];
	let context = vm.createContext({
		Zotero, IOUtils, PathUtils, fetch, console, TextDecoder, TextEncoder,
		Components: {
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
	});
	vm.runInContext(fs.readFileSync(path.join(ROOT, "bootstrap.js"), "utf8"), context, { filename: "bootstrap.js" });
	return { context, MockItem, progressLines, errors, prefStore, citeprocCalls, items };
}

// Notion with one data source, and the Anthropic API for the synthesis
function apiMock(log) {
	let pages = new Map();
	let ok = json => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(json) });
	return async (url, init) => {
		let body = init.body ? JSON.parse(init.body) : undefined;
		if (url.startsWith("https://api.anthropic.com/")) {
			log.push({ api: "anthropic", body });
			return ok({
				model: "claude-opus-5-5", stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 10 },
				content: [{ type: "text", text: "## 綜合摘要\n三篇結果一致 [S1, S2, S3]。\n\n## 文獻比較表\n| 文獻 | 設計 |\n|---|---|\n| [S1] | RCT |\n" }],
			});
		}
		let p = url.replace("https://api.notion.com/v1/", "");
		log.push({ api: "notion", method: init.method, path: p, body });
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
			if (body.parent.type === "page_id") return ok({ id: "syn-page", url: "https://www.notion.so/syn-page" });
			let page = { id: `page-${pages.size + 1}`, url: `https://www.notion.so/page-${pages.size + 1}` };
			pages.set(body.properties["Zotero Key"].rich_text[0].text.content, page);
			return ok(page);
		}
		if (/^pages\/[^/]+$/.test(p)) return ok([...pages.values()].find(pg => p.endsWith(pg.id)));
		if (/^blocks\/[^/]+\/children\?/.test(p)) return ok({ results: [], has_more: false });
		if (/^blocks\/[^/]+\/children$/.test(p)) return ok({ results: [{ id: "container-1" }] });
		return { status: 404, ok: false, headers: { get: () => null }, text: async () => JSON.stringify({ message: p }) };
	};
}

async function setup(prefs = {}) {
	let vault = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-vault-"));
	let log = [];
	let env = makeEnv({
		fetch: apiMock(log),
		prefs: Object.assign({
			"extensions.zotero-bridge.obsidian.vaultPath": vault,
			"extensions.zotero-bridge.obsidian.folder": "Zotero",
			"extensions.zotero-bridge.obsidian.filenameFormat": "citekey",
			"extensions.zotero-bridge.notion.token": "ntn_test",
			"extensions.zotero-bridge.notion.database": "https://www.notion.so/ws/Default-11111111111111111111111111111111",
			"extensions.zotero-bridge.notion.synthesisParent": "https://www.notion.so/Research-22222222222222222222222222222222",
			"extensions.zotero-bridge.llm.enabled": true,
			"extensions.zotero-bridge.llm.provider": "anthropic",
			"extensions.zotero-bridge.llm.anthropicKey": "sk-ant-test",
		}, prefs),
	});
	await vm.runInContext(`startup({ id: "zotero-bridge@bobyu89.github.io", version: "0.0.0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);
	return Object.assign(env, { vault, log });
}

// The literature note of an item (the file name comes from the author, year and title)
function readNote(vault, key) {
	let dir = path.join(vault, "Zotero");
	for (let name of fs.readdirSync(dir).filter(n => n.endsWith(".md"))) {
		let text = fs.readFileSync(path.join(dir, name), "utf8");
		if (text.includes(`zotero_key: "library/${key}"`)) return text;
	}
	throw new Error(`no note for ${key}`);
}

function addItems(env) {
	// As the Airiti translator saves them: split after the first character, language "zh"
	let article = new env.MockItem("journalArticle", {
		key: "ZHART001", title: "護理人員跌倒預防衛教之成效", year: "2023", language: "zh",
		publicationTitle: "護理雜誌", volume: "70", issue: "2", pages: "45-56", DOI: "10.6224/JN.202304_70(2).07",
		creators: [
			{ lastName: "陳", firstName: "美玲", creatorType: "author" },
			{ name: "林小華", creatorType: "author" },
			{ lastName: "歐", firstName: "陽志明", creatorType: "author" },
		],
		dateAdded: "2024-01-01 00:00:00",
	});
	let thesis = new env.MockItem("thesis", {
		key: "ZHTHS001", title: "加護病房護理人員之工作壓力", year: "2020", language: "zh",
		university: "國防醫學院", thesisType: "Master's Thesis", libraryCatalog: "Airiti",
		url: "https://www.airitilibrary.com/Publication/alDetailedMesh1?DocID=U0011-1", extra: "DOI: 10.6832/NDMC.2020.00001",
		// Name splitting in Western order: "王 大明" → firstName 王, lastName 大明
		creators: [{ firstName: "王", lastName: "大明", creatorType: "author" }],
		dateAdded: "2024-01-02 00:00:00",
	});
	let english = new env.MockItem("journalArticle", {
		key: "ENART001", title: "Exercise and falls", year: "2021", citationKey: "lee2021exercise",
		publicationTitle: "Geriatric Nursing", creators: [{ lastName: "Lee", firstName: "Anna", creatorType: "author" }],
	});
	return { article, thesis, english };
}

test("sync, references.json and a synthesis with Chinese and English items", async () => {
	let env = await setup();
	let { article, thesis, english } = addItems(env);

	await env.context.ZB.main.run([article, thesis, english], { targets: ["notion", "obsidian"], ai: "none" });
	assert.deepEqual(env.errors, []);
	assert.ok(env.progressLines.every(l => !l.error), env.progressLines.map(l => l.text).join("\n"));
	assert.deepEqual(env.citeprocCalls, ["ENART001"], "Zotero's citeproc only for the English item");

	// Obsidian: Chinese APA with italics, full names in the frontmatter, the citekey as before
	let dir = path.join(env.vault, "Zotero");
	let note = readNote(env.vault, "ZHART001");
	assert.match(note, /^authors:\n  - "陳美玲"\n  - "林小華"\n  - "歐陽志明"$/m);
	assert.match(note, /^citekey: "陳2023護理人員"$/m);
	assert.match(note, /^> \*\*Authors\*\*: 陳美玲; 林小華; 歐陽志明 {2}$/m);
	assert.match(note, /^> \*\*APA 7\*\*: 陳美玲、林小華、歐陽志明（2023）。護理人員跌倒預防衛教之成效。\*護理雜誌，70\*\(2\)，45–56。https:\/\/doi\.org\/10\.6224\/JN\.202304_70\(2\)\.07$/m);
	let thesisNote = readNote(env.vault, "ZHTHS001");
	assert.match(thesisNote, /^ {2}- "王大明"$/m);
	assert.match(thesisNote, /\*\*APA 7\*\*: 王大明（2020）。\*加護病房護理人員之工作壓力\*〔碩士論文，國防醫學院〕。華藝線上圖書館。https:\/\/doi\.org\/10\.6832\/NDMC\.2020\.00001$/m);
	let englishNote = readNote(env.vault, "ENART001");
	assert.match(englishNote, /\*\*APA 7\*\*: Lee, A\. \(2021\)\. Exercise and falls\. Geriatric Nursing\.$/m, "English items keep Zotero's APA");
	assert.match(englishNote, /^ {2}- "Lee, Anna"$/m);

	// Notion: plain-text Chinese APA and full names
	let created = env.log.filter(l => l.api === "notion" && l.path === "pages" && l.method === "POST");
	let props = created.find(c => c.body.properties["Zotero Key"].rich_text[0].text.content === "library/ZHART001").body.properties;
	assert.equal(props.APA.rich_text.map(r => r.text.content).join(""),
		"陳美玲、林小華、歐陽志明（2023）。護理人員跌倒預防衛教之成效。護理雜誌，70(2)，45–56。https://doi.org/10.6224/JN.202304_70(2).07");
	assert.equal(props.Authors.rich_text.map(r => r.text.content).join(""), "陳美玲; 林小華; 歐陽志明");

	// references.json: full literal names, language zh-TW; the English entry as Zotero wrote it
	await env.context.ZB.bibliography.exportLibrary();
	let refs = JSON.parse(fs.readFileSync(path.join(dir, "references.json"), "utf8"));
	let byId = Object.fromEntries(refs.map(r => [r.id, r]));
	// Generated citekeys keep using the stored last name, so existing keys never move
	assert.deepEqual(Object.keys(byId).sort(), ["lee2021exercise", "大明2020加護病房", "陳2023護理人員"].sort());
	assert.deepEqual(byId["陳2023護理人員"].author, [{ literal: "陳美玲" }, { literal: "林小華" }, { literal: "歐陽志明" }]);
	assert.equal(byId["陳2023護理人員"].language, "zh-TW");
	assert.deepEqual(byId["大明2020加護病房"].author, [{ literal: "王大明" }]);
	assert.deepEqual(byId.lee2021exercise.author, [{ family: "Lee", given: "Anna" }]);
	assert.equal(byId.lee2021exercise.language, undefined);
	// Zotero's items are never changed
	assert.deepEqual(article.fields.creators[0], { lastName: "陳", firstName: "美玲", creatorType: "author" });

	// Synthesis: Chinese in-text citations; reference list with Chinese first (by stroke count).
	// Note file names keep using the stored last name (renaming would break links)
	await env.context.ZB.main.runSynthesis([english, article, thesis], { label: "跌倒" });
	assert.deepEqual(env.errors, []);
	let synDir = path.join(dir, "文獻比較");
	let syn = fs.readFileSync(path.join(synDir, fs.readdirSync(synDir)[0]), "utf8");
	assert.match(syn, /三篇結果一致 \[\[Zotero\/lee2021exercise\|Lee, 2021\]\]; \[\[Zotero\/陳 2023 - 護理人員跌倒預防衛教之成效\|陳美玲等，2023\]\]; \[\[Zotero\/大明 2020 - 加護病房護理人員之工作壓力\|王大明，2020\]\]。/);
	let list = syn.split("## 參考文獻\n\n")[1].split("\n\n")[0].split("\n");
	assert.deepEqual(list.map(l => l.slice(0, 5)), ["- 王大明", "- 陳美玲", "- Lee"]);
	assert.match(list[1], /\*護理雜誌，70\*\(2\)/);
	await vm.runInContext("shutdown()", env.context);
});

test("settings: 台灣護理學會 punctuation, English order, or Chinese APA off", async () => {
	let env = await setup({
		"extensions.zotero-bridge.apaZh.style": "twna",
		"extensions.zotero-bridge.apaZh.chineseFirst": false,
	});
	let { article, thesis, english } = addItems(env);
	await env.context.ZB.main.run([article], { targets: ["obsidian"], ai: "none" });
	let note = readNote(env.vault, "ZHART001");
	assert.match(note, /\*\*APA 7\*\*: 陳美玲、林小華、歐陽志明（2023）．護理人員跌倒預防衛教之成效．\*護理雜誌，70\*\(2\)，45–56。https/);
	await env.context.ZB.main.runSynthesis([article, thesis, english], { label: "x" });
	let synDir = path.join(env.vault, "Zotero", "文獻比較");
	let syn = fs.readFileSync(path.join(synDir, fs.readdirSync(synDir)[0]), "utf8");
	let list = syn.split("## 參考文獻\n\n")[1].split("\n\n")[0].split("\n");
	assert.deepEqual(list.map(l => l.slice(0, 5)), ["- Lee", "- 王大明", "- 陳美玲"]);
	await vm.runInContext("shutdown()", env.context);

	// Off: Zotero's APA (citeproc) for every item and Zotero's CSL names; full names stay
	let off = await setup({ "extensions.zotero-bridge.apaZh.enabled": false });
	let items = addItems(off);
	await off.context.ZB.main.run([items.article], { targets: ["obsidian"], ai: "none" });
	let offNote = readNote(off.vault, "ZHART001");
	assert.match(offNote, /\*\*APA 7\*\*: 陳, 美\. \(2023\)\. 護理人員跌倒預防衛教之成效\. 護理雜誌\.$/m);
	assert.match(offNote, /^ {2}- "陳美玲"$/m);
	await off.context.ZB.bibliography.exportLibrary();
	let refs = JSON.parse(fs.readFileSync(path.join(off.vault, "Zotero", "references.json"), "utf8"));
	assert.deepEqual(refs.find(r => r.id === "陳2023護理人員").author[0], { family: "陳", given: "美玲" });
	await vm.runInContext("shutdown()", off.context);
});
