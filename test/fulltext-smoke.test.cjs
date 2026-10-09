// Full text as Markdown, highlight colours and AI key sentences, Notion columns in Chinese: the real
// plugin (bootstrap.js and every content script) in a mocked Zotero, from sync to the files and requests.
// The mock environment is copied from test/zotero-smoke.test.cjs, plus Subprocess.sys.mjs (markitdown)
// and Zotero's data directory (the full-text cache).
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
const P = "extensions.zotero-bridge.";

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
function makeEnv({ prefs, fetch, logins = [], confirm = () => true, timers, subprocess = null, dataDir = null }) {
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
		// The full-text cache lives in the data directory (fulltext.js)
		DataDirectory: dataDir ? { dir: dataDir } : undefined,
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
			return { path: p, type: st.isDirectory() ? "directory" : st.isFile() ? "regular" : "other", size: st.size, lastModified: Math.round(st.mtimeMs) };
		},
		remove: async p => fsp.rm(p, { force: true }),
		move: async (from, to, opts = {}) => {
			if (opts.noOverwrite && fs.existsSync(to)) throw new Error("NoModificationAllowedError: " + to);
			await fsp.rename(from, to);
		},
	};
	let PathUtils = { join: (...parts) => path.join(...parts), filename: p => path.basename(p), parent: p => path.dirname(p) };

	let loginManager = loginManagerMock(logins);
	let subprocessCalls = [];
	let context = vm.createContext({
		Zotero, IOUtils, PathUtils, fetch, console, TextDecoder, TextEncoder,
		// Firefox's Subprocess.sys.mjs, replaced by the test's fake (markitdown)
		ChromeUtils: {
			importESModule: (url) => {
				assert.equal(url, "resource://gre/modules/Subprocess.sys.mjs");
				subprocessCalls.push(url);
				if (!subprocess) throw new Error("no Subprocess in this test");
				return { Subprocess: subprocess };
			},
		},
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
	return { context, Zotero, MockItem, addChild, menus, progressLines, descriptions, items, prefStore, errors, panes, loginManager, translations, observers, subprocessCalls };
}

// ---------- fixtures ----------

const HEAD = "Journal of Fall Research 2024;12:1–3";
// Zotero's PDF worker text: one paragraph per line, pages separated by \f
const FULL_TEXT = [
	[HEAD, "Nurse-led exercise and falls", "Abstract", "Falls are common among older adults in hospital.", "Introduction",
		"Exercise delivered by nurses may prevent falls in older inpatients.", "1"],
	[HEAD, "Methods", "We randomised 120 patients to a twelve week exercise interven- tion or usual care.", "Results",
		"The intervention reduced the rate of falls by thirty percent compared with usual care.",
		"Adherence was high and no serious adverse events were reported.", "2"],
	[HEAD, "Discussion", "Nurses can deliver structured exercise safely in hospital wards.", "Funding", "This study was funded by Grant 123.",
		"References", "1. Smith J. Falls in older adults. J Nurs. 2020;1:1-10.", "2. Lee A. Exercise and balance. Geriatr Nurs. 2021;2:2-20.", "3"],
].map(lines => lines.join("\n") + "\n\n").join("\f").trim();

const AI_TEXT = `## 一句話摘要
護理師帶的運動課讓住院長者跌倒率下降 30%。

## 主要結果
- 跌倒率下降 30%
- 遵從度高、沒有嚴重不良事件

## 關鍵概念
[[Fall prevention]]

## 可引用的句子
- "The intervention reduced the rate of falls by thirty percent" (p. 2)

\`\`\`json
{"study_design": "RCT", "sample_size": 120, "evidence_level": "2", "jbi_level": "1.c", "appraisal_overall": "納入", "measures": [],
 "highlights": [
  {"quote": "Nurses can deliver structured exercise safely in hospital wards.", "why": "作者結論"},
  {"quote": "This sentence was invented by the model.", "why": "不存在"}
 ]}
\`\`\`
`;

function ok(json) {
	return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(json) };
}

/**
 * Claude + Notion. One data source (ds-1) whose columns start as `columns` ({ name: { id, type } }; default:
 * every plugin column under its English name). Pages page-1…; the literature page's blocks are tracked so
 * the full-text child page can be listed, trashed and recreated.
 */
function apiMock(log, opts = {}) {
	let props = opts.columns || null;
	let pages = new Map();
	let pageChildren = new Map();
	let seq = 0;
	let fetch = async (url, init) => {
		let body = init.body ? JSON.parse(init.body) : undefined;
		if (url.startsWith("https://api.anthropic.com/")) {
			log.push({ api: "anthropic", body });
			return ok({ model: "model-x", stop_reason: "end_turn", content: [{ type: "text", text: opts.aiText || AI_TEXT }],
				usage: { input_tokens: 1000, output_tokens: 300 } });
		}
		let p = url.replace("https://api.notion.com/v1/", "");
		log.push({ api: "notion", method: init.method, path: p, body });
		if (p.startsWith("databases/")) return ok({ data_sources: [{ id: "ds-1" }] });
		if (p === "data_sources/ds-1" && init.method === "GET") {
			if (!props) {
				props = { Name: { id: "title", type: "title" } };
				let i = 0;
				for (let [k, v] of Object.entries(require("../content/notion.js").PROPERTY_SCHEMA)) props[k] = { id: `id${i++}`, type: Object.keys(v)[0] };
			}
			return ok({ properties: props });
		}
		if (p === "data_sources/ds-1" && init.method === "PATCH") {
			for (let [key, def] of Object.entries(body.properties)) {
				let hit = Object.entries(props).find(([name, prop]) => name === key || prop.id === key);
				if (hit && def.name) {
					delete props[hit[0]];
					props[def.name] = hit[1];
				}
				else if (!hit) props[key] = { id: `new${++seq}`, type: Object.keys(def)[0] };
			}
			return ok({});
		}
		if (p === "data_sources/ds-1/query") {
			let f = body.filter.rich_text ? body.filter : body.filter.or[0];
			let key = f.rich_text.equals;
			let found = [...pages.values()].filter(pg => !pg.in_trash && pg.zoteroKey === key);
			return ok({ results: found, has_more: false });
		}
		if (p === "pages" && init.method === "POST") {
			let id = body.parent.page_id ? `child-${++seq}` : `page-${pages.size + 1}`;
			let page = { id, url: `https://www.notion.so/${id}`, properties: body.properties, parent: body.parent };
			if (body.parent.page_id) {
				let list = pageChildren.get(body.parent.page_id) || [];
				list.push({ id, type: "child_page", child_page: { title: body.properties.title.title[0].text.content } });
				pageChildren.set(body.parent.page_id, list);
			}
			else {
				let zk = Object.entries(body.properties).find(([name]) => /Zotero (Key|識別碼)/.test(name));
				page.zoteroKey = zk[1].rich_text[0].text.content;
			}
			pages.set(id, page);
			return ok(page);
		}
		let m = /^pages\/([^/?]+)$/.exec(p);
		if (m) {
			let page = pages.get(m[1]);
			if (body && body.in_trash) {
				page.in_trash = true;
				for (let [parent, list] of pageChildren) pageChildren.set(parent, list.filter(b => b.id !== m[1]));
			}
			if (body && body.properties) Object.assign(page.properties, body.properties);
			return ok(page);
		}
		if ((m = /^blocks\/(page-\d+)\/children\?/.exec(p))) return ok({ results: pageChildren.get(m[1]) || [], has_more: false });
		if ((m = /^blocks\/(page-\d+)\/children$/.exec(p))) return ok({ results: [{ id: "container-1" }] });
		if (/^blocks\/[\w-]+\/children$/.test(p) && init.method === "PATCH") return ok({ results: (body.children || []).map(() => ({ id: `block-${++seq}` })) });
		if (/^blocks\/[\w-]+\/children\?/.test(p)) return ok({ results: [], has_more: false });
		if (/^blocks\/[\w-]+$/.test(p) && init.method === "DELETE") return ok({});
		return { status: 404, ok: false, headers: { get: () => null }, text: async () => JSON.stringify({ message: p }) };
	};
	return { fetch, pages, pageChildren, props: () => props };
}

function prefs(vault, extra = {}) {
	return Object.assign({
		[P + "obsidian.vaultPath"]: vault,
		[P + "obsidian.vaultName"]: "Vault",
		[P + "obsidian.folder"]: "Zotero",
		[P + "obsidian.filenameFormat"]: "citekey",
		[P + "obsidian.createBase"]: false,
		[P + "dashboard.autoUpdate"]: false,
		[P + "concepts.autoUpdate"]: false,
		[P + "notion.token"]: "ntn_test",
		[P + "notion.database"]: "https://www.notion.so/ws/Default-11111111111111111111111111111111",
		[P + "routing.rules"]: "[]",
		[P + "llm.enabled"]: true,
		[P + "llm.provider"]: "anthropic",
		[P + "llm.anthropicKey"]: "sk-ant-test",
		[P + "llm.fullTextLimit"]: "150000",
		[P + "includeNotes"]: true,
	}, extra);
}

async function start(env) {
	await vm.runInContext(`startup({ id: "zotero-bridge@bobyu89.github.io", version: "0.0.0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);
	return env.context.ZB;
}

/** A paper with a PDF (Zotero's text above) and the user's highlights. */
function paper(env, opts = {}) {
	let item = new env.MockItem("journalArticle", {
		title: "Nurse-led exercise and falls", year: "2024", citationKey: "lee2024", DOI: "10.1/falls",
		creators: [{ firstName: "Anna", lastName: "Lee", creatorType: "author" }], abstractNote: "Falls are common.",
	});
	let pdf = new env.MockItem("attachment", { title: "Full Text PDF", fulltext: opts.fulltext || FULL_TEXT });
	if (opts.pdfPath) pdf.getFilePathAsync = async () => opts.pdfPath;
	env.addChild(item, pdf);
	let ann = (key, text, color, page, sort) => ({
		key, annotationType: "highlight", annotationText: text, annotationComment: "", annotationColor: color,
		annotationPageLabel: page, annotationSortIndex: sort, getTags: () => [],
	});
	pdf.annotations = opts.annotations || [
		ann("HLY", "reduced the rate of falls by thirty per-\ncent", "#ffd400", "2", "00001"),
		ann("HLR", "no serious adverse events were reported", "#ff6666", "2", "00002"),
		ann("HLB", "a sentence the PDF text doesn't have", "#2ea8e5", "3", "00003"),
	];
	return { item, pdf };
}

const fullTextPath = vault => path.join(vault, "Zotero", "全文", "lee2024.md");
const notePath = vault => path.join(vault, "Zotero", "lee2024.md");

// ---------- tests ----------

test("sync writes the full-text note with coloured highlights and the compact literature note; the AI reads trimmed Markdown", async () => {
	let vault = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-ft-"));
	let log = [];
	let api = apiMock(log);
	// A vault means earlier use: the profile lands on 進階 (AI 標重點 on)
	let env = makeEnv({ fetch: api.fetch, prefs: prefs(vault) });
	let ZB = await start(env);
	assert.equal(ZB.features.isEnabled("fullTextMarkdown"), true);
	assert.equal(ZB.features.isEnabled("aiHighlights"), true);
	let { item } = paper(env);
	await ZB.main.run([item], { targets: ["notion", "obsidian"], ai: "missing" });
	assert.deepEqual(env.errors, []);

	// One AI call, with the key sentences asked for in it (no extra request)
	let calls = log.filter(l => l.api === "anthropic");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].body.system.at(-1).text, ZB.llm.AI_HIGHLIGHTS_PROMPT);
	let prompt = calls[0].body.messages[0].content;
	let sent = /<fulltext>\n([\s\S]*?)\n<\/fulltext>/.exec(prompt)[1];
	assert.match(sent, /^（全文已整理成 Markdown；參考文獻、誌謝、經費與利益衝突等段落已省略）\n/);
	assert.match(sent, /^## Results$/m);
	assert.match(sent, /twelve week exercise intervention or usual care/, "hyphenation rejoined");
	assert.doesNotMatch(sent, /Journal of Fall Research/, "running head dropped");
	assert.doesNotMatch(sent, /Smith J\.|Grant 123/, "references and funding cut");
	// The run summary says how much was trimmed
	let summary = env.descriptions.find(d => /全文整理成 Markdown 後送給 AI/.test(d));
	assert.match(summary, /^全文整理成 Markdown 後送給 AI：\d{3} 字（原本 \d{3} 字，省下 \d+%，略過 Funding、References）$/);
	let line = env.progressLines.find(l => /Nurse-led/.test(l.text));
	assert.match(line.text, /AI 標的重點 2 句，1 句在全文中找不到，已刪除/);

	// The full-text note: managed, linked both ways, highlights in their colours, the AI's quote marked apart
	let ft = fs.readFileSync(fullTextPath(vault), "utf8");
	assert.match(ft, /^---\nfulltext_of: "library\/KEY\d+"\nfulltext_source: "built-in"\n---\n/);
	assert.doesNotMatch(ft, /zotero_key/);
	assert.match(ft, /^> \[!info\] 全文・由 ZotMax 產生\n> 每次同步都會重新產生，請不要在這裡寫字；想法寫在文獻筆記 \[\[Zotero\/lee2024\|文獻筆記\]\]。\n> 劃線：🟡 重要發現 · 🔴 限制／疑問 · 🤖 底線＝AI 標的重點（僅供參考）$/m);
	assert.match(ft, /^The intervention ==🟡reduced the rate of falls by thirty percent== compared with usual care\.$/m);
	assert.match(ft, /^Adherence was high and ==🔴no serious adverse events were reported==\.$/m);
	assert.match(ft, /^🤖<u>Nurses can deliver structured exercise safely in hospital wards<\/u>\.$/m);
	assert.doesNotMatch(ft, /invented by the model/);
	assert.match(ft, /## 沒有在全文中找到位置的劃線\n\n.*\n\n- ==🔵a sentence the PDF text doesn't have== — 可引用句 · p\. 3\n$/);
	assert.match(ft, /^1\. Smith J\./m, "the full-text note keeps the reference list");

	// The literature note: 重點 first, links to the full text, the AI's quotes listed apart
	let note = fs.readFileSync(notePath(vault), "utf8");
	assert.match(note, /^fulltext: "\[\[Zotero\/全文\/lee2024\]\]"$/m);
	assert.match(note, /%%\n\n> \[!abstract\] 重點\n> \*\*一句話\*\*：護理師帶的運動課讓住院長者跌倒率下降 30%。\n>\n> RCT · N = 120 · CEBM 2 · JBI 1\.c · 評讀：納入（AI 初評）\n/);
	assert.match(note, /^> \[\[Zotero\/全文\/lee2024\|全文與劃線\]\] · \[Zotero\]/m);
	assert.match(note, /^> \[!tip\]- AI 標的重點（僅供參考）\n(?:>.*\n)*> - 🤖 "Nurses can deliver structured exercise safely in hospital wards\." — 作者結論$/m);
	assert.doesNotMatch(note, /invented by the model/);
	assert.ok(note.indexOf("[!quote]- 🔴 限制／疑問") < note.indexOf("[!tip]- AI 標的重點"), "the AI's after the user's own");

	// Notion: 重點 open in the container, the rest as coloured toggles
	let container = log.find(l => l.method === "PATCH" && l.path === "blocks/page-1/children");
	assert.match(JSON.stringify(container.body.children[0].callout.children), /一句話/);
	let toggles = log.find(l => l.method === "PATCH" && l.path === "blocks/container-1/children").body.children;
	assert.deepEqual(toggles.slice(0, 4).map(t => [t.toggle.rich_text[0].text.content, t.toggle.color]), [
		["🟡 重要發現（1）", "yellow_background"], ["🔴 限制／疑問（1）", "red_background"], ["🔵 可引用句（1）", "blue_background"],
		["AI 標的重點（僅供參考）", "default"],
	]);
	// No full-text child page unless asked for
	assert.ok(!log.some(l => l.path === "pages" && l.body && l.body.parent.page_id));

	// A sync without AI: nothing rewritten, the AI's verified quotes still marked, no AI call
	let before = fs.readFileSync(fullTextPath(vault), "utf8");
	log.length = 0;
	await ZB.main.run([item], { targets: ["obsidian"], ai: "reuse" });
	assert.equal(log.filter(l => l.api === "anthropic").length, 0);
	assert.equal(fs.readFileSync(fullTextPath(vault), "utf8"), before);
	assert.equal(fs.readdirSync(path.join(vault, "Zotero")).filter(f => f.endsWith(".md")).length, 1, "the full-text note isn't taken for a literature note");

	// A full-text note written by Zotero Bridge (≤ 0.10): still ours (fulltext_of), rebuilt under the new name
	fs.writeFileSync(fullTextPath(vault), before.split("ZotMax").join("Zotero Bridge"));
	assert.match(fs.readFileSync(fullTextPath(vault), "utf8"), /^> \[!info\] 全文・由 Zotero Bridge 產生$/m);
	await ZB.main.run([item], { targets: ["obsidian"], ai: "reuse" });
	assert.deepEqual(env.errors, []);
	assert.equal(fs.readFileSync(fullTextPath(vault), "utf8"), before);
	await vm.runInContext("shutdown()", env.context);
});

test("AI 標重點 off (研究生引導): no key sentences asked for, none shown or marked; a renamed note moves its full text", async () => {
	let vault = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-ft-"));
	let log = [];
	let api = apiMock(log);
	// Migrations already done on a guided profile
	let env = makeEnv({ fetch: api.fetch, prefs: prefs(vault, { [P + "features.version"]: 2, [P + "notion.token"]: "" }) });
	let ZB = await start(env);
	assert.equal(ZB.features.currentPreset(), "guided");
	assert.equal(ZB.features.isEnabled("aiHighlights"), false);
	let { item } = paper(env);
	await ZB.main.run([item], { targets: ["obsidian"], ai: "missing" });
	assert.deepEqual(env.errors, []);
	let calls = log.filter(l => l.api === "anthropic");
	assert.equal(calls.length, 1, "one call, as before");
	assert.equal(calls[0].body.system.length, 2);
	assert.doesNotMatch(JSON.stringify(calls[0].body.system), /"highlights"/);
	let note = fs.readFileSync(notePath(vault), "utf8");
	assert.doesNotMatch(note, /AI 標的重點|🤖 "/);
	let ft = fs.readFileSync(fullTextPath(vault), "utf8");
	assert.doesNotMatch(ft, /🤖/);
	assert.match(ft, /==🟡reduced the rate of falls by thirty percent==/);

	// The citekey changes: the note is renamed, the full-text note follows (the old one is ours and goes)
	item.fields.citationKey = "lee2024nurse";
	await ZB.main.run([item], { targets: ["obsidian"], ai: "reuse" });
	assert.ok(fs.existsSync(path.join(vault, "Zotero", "全文", "lee2024nurse.md")));
	assert.ok(!fs.existsSync(fullTextPath(vault)), "the old full-text note is removed");
	assert.match(fs.readFileSync(path.join(vault, "Zotero", "lee2024nurse.md"), "utf8"), /^fulltext: "\[\[Zotero\/全文\/lee2024nurse\]\]"$/m);
	// A note of the user's where a full-text note would go is never overwritten
	fs.writeFileSync(path.join(vault, "Zotero", "全文", "lee2024nurse.md"), "# 我自己的筆記\n");
	await ZB.main.run([item], { targets: ["obsidian"], ai: "reuse" });
	assert.equal(fs.readFileSync(path.join(vault, "Zotero", "全文", "lee2024nurse.md"), "utf8"), "# 我自己的筆記\n");
	assert.match(env.progressLines.at(-1).text, /⚠️ 全文筆記：「Zotero\/全文\/lee2024nurse\.md」不是 ZotMax 產生的全文筆記，沒有覆寫/);

	// 全文筆記 off: no full-text note, and the AI gets the raw text again
	ZB.features.setEnabled("fullTextMarkdown", false);
	let other = paper(env);
	other.item.fields.citationKey = "kim2024";
	log.length = 0;
	await ZB.main.run([other.item], { targets: ["obsidian"], ai: "regenerate" });
	assert.ok(!fs.existsSync(path.join(vault, "Zotero", "全文", "kim2024.md")));
	assert.match(log.find(l => l.api === "anthropic").body.messages[0].content, /Journal of Fall Research/);
	assert.doesNotMatch(fs.readFileSync(path.join(vault, "Zotero", "kim2024.md"), "utf8"), /^fulltext:/m);
	await vm.runInContext("shutdown()", env.context);
});

/** A fake Subprocess.sys.mjs: `run(call)` decides { stdout: [chunks], stderr, exitCode, hang }. */
function fakeSubprocess(run) {
	let calls = [];
	let pipe = (chunks) => {
		let queue = [...chunks];
		return { readString: async () => (queue.length ? queue.shift() : "") };
	};
	let Subprocess = {
		calls,
		pathSearch: async name => `/usr/local/bin/${name}`,
		call: async (opts) => {
			calls.push(opts);
			let r = run(opts);
			let killed = false;
			let proc = {
				stdout: r.hang ? { readString: () => new Promise(() => {}) } : pipe(r.stdout || []),
				stderr: pipe(r.stderr ? [r.stderr] : []),
				wait: () => (r.hang ? new Promise(() => {}) : Promise.resolve({ exitCode: r.exitCode || 0 })),
				kill: async () => {
					killed = true;
					proc.killed = true;
				},
				get wasKilled() { return killed; },
			};
			calls[calls.length - 1].proc = proc;
			return proc;
		},
	};
	return Subprocess;
}

test("markitdown: run on the PDF when its path is set (cached per file); a failure falls back to the built-in conversion", async () => {
	let vault = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-ft-"));
	let dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-data-"));
	let pdfPath = path.join(dataDir, "paper.pdf");
	fs.writeFileSync(pdfPath, "%PDF-1.4 fake");
	let outcome = { stdout: ["Results\n\nThe intervention reduced the rate of falls by thirty\npercent compared with usual care.\n\n", "| Group | Falls |\n| --- | --- |\n| Exercise | 12 |\n"] };
	let sub = fakeSubprocess(() => outcome);
	let log = [];
	let env = makeEnv({
		fetch: apiMock(log).fetch, subprocess: sub, dataDir,
		prefs: prefs(vault, { [P + "notion.token"]: "", [P + "llm.enabled"]: false, [P + "fullText.markitdownPath"]: "markitdown" }),
	});
	let ZB = await start(env);
	let { item } = paper(env, { pdfPath });
	await ZB.main.run([item], { targets: ["obsidian"], ai: "none" });
	assert.deepEqual(env.errors, []);
	assert.equal(sub.calls.length, 1);
	assert.equal(sub.calls[0].command, "/usr/local/bin/markitdown", "a bare name is looked up on PATH");
	assert.deepEqual([...sub.calls[0].arguments], [pdfPath]);
	assert.equal(sub.calls[0].environmentAppend, true);
	assert.equal(sub.calls[0].environment.PYTHONIOENCODING, "utf-8");
	let ft = fs.readFileSync(fullTextPath(vault), "utf8");
	assert.match(ft, /^fulltext_source: "markitdown"$/m);
	assert.match(ft, /^## Results$/m);
	assert.match(ft, /^The intervention ==🟡reduced the rate of falls by thirty percent== compared with usual care\.$/m);
	assert.match(ft, /^\| Group \| Falls \|\n\| --- \| --- \|\n\| Exercise \| 12 \|$/m, "markitdown's table is kept");
	// Cached by file: the next sync doesn't run it again
	await ZB.main.run([item], { targets: ["obsidian"], ai: "none" });
	assert.equal(sub.calls.length, 1);
	assert.ok(fs.readdirSync(path.join(dataDir, "zotero-bridge", "fulltext")).some(f => f.endsWith(".json")));

	// The file changes and markitdown fails: the built-in conversion is used and the reason reported once
	fs.writeFileSync(pdfPath, "%PDF-1.4 fake, changed and longer");
	outcome = { exitCode: 1, stderr: "Traceback (most recent call last):\nModuleNotFoundError: No module named 'pdfminer'" };
	await ZB.main.run([item], { targets: ["obsidian"], ai: "none" });
	assert.equal(sub.calls.length, 2);
	assert.match(env.progressLines.at(-1).text, /⚠️ markitdown 轉換失敗，改用內建轉換（markitdown 結束代碼 1：.*No module named 'pdfminer'）/);
	ft = fs.readFileSync(fullTextPath(vault), "utf8");
	assert.match(ft, /^fulltext_source: "built-in"$/m);
	assert.match(ft, /^## Funding$/m, "the built-in conversion of Zotero's text");
	// The failure is remembered for this file: no retry and no repeated warning on the next sync
	await ZB.main.run([item], { targets: ["obsidian"], ai: "none" });
	assert.equal(sub.calls.length, 2);
	assert.doesNotMatch(env.progressLines.at(-1).text, /markitdown/);

	// A hung process is killed after the timeout; output past the cap is refused
	let hung = fakeSubprocess(() => ({ hang: true }));
	ZB.fulltext.runtime.subprocess = hung;
	await assert.rejects(ZB.fulltext.runMarkitdown("/opt/markitdown", pdfPath, { timeoutMs: 30 }), /markitdown 超過 0 秒沒有完成/);
	assert.equal(hung.calls[0].proc.killed, true);
	ZB.fulltext.runtime.subprocess = fakeSubprocess(() => ({ stdout: ["x".repeat(50), "y".repeat(50)] }));
	await assert.rejects(ZB.fulltext.runMarkitdown("/opt/markitdown", pdfPath, { maxChars: 60 }), /markitdown 輸出超過/);
	ZB.fulltext.runtime.subprocess = fakeSubprocess(() => ({ stdout: ["  \n"] }));
	await assert.rejects(ZB.fulltext.runMarkitdown("/opt/markitdown", pdfPath), /markitdown 沒有輸出任何文字/);
	delete ZB.fulltext.runtime.subprocess;
	await vm.runInContext("shutdown()", env.context);
});

test("Notion full-text child page (option): chunked appends, rebuilt only when it changed, never two of them", async () => {
	let vault = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-ft-"));
	let dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-data-"));
	let log = [];
	let api = apiMock(log);
	let env = makeEnv({ fetch: api.fetch, dataDir, prefs: prefs(vault, { [P + "llm.enabled"]: false, [P + "notion.fullTextPage"]: true }) });
	let ZB = await start(env);
	// A long paper: 260 paragraphs, one longer than a rich-text item allows
	let long = FULL_TEXT.replace("Discussion", Array.from({ length: 260 }, (_, i) => `Paragraph ${i} of the discussion.${i === 5 ? " " + "long ".repeat(500) : ""}`).join("\n") + "\nDiscussion");
	let { item, pdf } = paper(env, { fulltext: long });
	await ZB.main.run([item], { targets: ["notion"], ai: "none" });
	assert.deepEqual(env.errors, []);
	let child = log.find(l => l.method === "POST" && l.path === "pages" && l.body.parent.page_id);
	assert.deepEqual(child.body.parent, { type: "page_id", page_id: "page-1" });
	assert.equal(child.body.properties.title.title[0].text.content, "全文：Nurse-led exercise and falls");
	let childID = api.pageChildren.get("page-1")[0].id;
	let appends = log.filter(l => l.method === "PATCH" && l.path === `blocks/${childID}/children`);
	assert.ok(appends.length >= 3);
	for (let a of appends) {
		assert.ok(a.body.children.length <= 100);
		for (let b of a.body.children) for (let r of b[b.type].rich_text || []) assert.ok(r.text.content.length <= 2000);
	}
	let written = JSON.stringify(appends.map(a => a.body));
	assert.match(written, /"content":"reduced the rate of falls by thirty percent","link":null|"content":"reduced the rate of falls by thirty percent"/);
	let yellow = appends.flatMap(a => a.body.children).flatMap(b => b[b.type].rich_text || []).find(r => r.text.content === "reduced the rate of falls by thirty percent");
	assert.deepEqual(yellow.annotations, { color: "yellow_background" });
	// 重點 says where the full text is
	assert.match(JSON.stringify(log.find(l => l.path === "blocks/page-1/children" && l.method === "PATCH").body), /全文與劃線：本頁下方的子頁面/);

	// Unchanged: no new page, nothing trashed
	log.length = 0;
	await ZB.main.run([item], { targets: ["notion"], ai: "none" });
	assert.ok(!log.some(l => l.method === "POST" && l.path === "pages"));
	assert.ok(!log.some(l => l.body && l.body.in_trash));
	// A new highlight: the old page goes to the trash, one new page
	pdf.annotations.push({ key: "HLG", annotationType: "highlight", annotationText: "Falls are common among older adults", annotationComment: "",
		annotationColor: "#5fb236", annotationPageLabel: "1", annotationSortIndex: "00000", getTags: () => [] });
	log.length = 0;
	await ZB.main.run([item], { targets: ["notion"], ai: "none" });
	assert.ok(log.some(l => l.method === "PATCH" && l.path === `pages/${childID}` && l.body.in_trash === true));
	assert.equal(log.filter(l => l.method === "POST" && l.path === "pages").length, 1);
	assert.equal(api.pageChildren.get("page-1").length, 1, "only one full-text page");
	await vm.runInContext("shutdown()", env.context);
});

test("「把 Notion 欄位改成中文」: shows the renames first, renames by ID after confirming; syncs then write the Chinese columns", async () => {
	let vault = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-ft-"));
	let log = [];
	let api = apiMock(log);
	let answers = [false, true];
	let asked = [];
	let env = makeEnv({
		fetch: api.fetch, confirm: (text) => { asked.push(text); return answers.shift(); },
		prefs: prefs(vault, { [P + "llm.enabled"]: false }),
	});
	let ZB = await start(env);
	// An English database from an earlier version; a first sync records the column IDs
	let { item } = paper(env);
	await ZB.main.run([item], { targets: ["notion"], ai: "none" });
	assert.deepEqual(env.errors, []);
	let created = log.find(l => l.method === "POST" && l.path === "pages");
	assert.ok(created.body.properties["Zotero Key"], "English columns still work");
	let ids = JSON.parse(env.prefStore[P + "notion.propertyIds"])["ds-1"];
	assert.equal(ids.Authors, api.props().Authors.id);

	// Cancelled: nothing renamed
	log.length = 0;
	let lines = await ZB.main.renameNotionColumns({});
	assert.match(asked[0], /^以下 Notion 欄位會改成中文名稱（只改名字，欄位裡的資料不變；之後同步照常寫入）：\n\n預設\n {2}Name → 標題\n {2}Authors → 作者\n {2}Year → 年份\n/);
	assert.match(asked[0], /\n {2}Zotero Key → Zotero 識別碼\n/);
	assert.doesNotMatch(asked[0], /DOI →/);
	assert.equal(lines.at(-1), "已取消，沒有改任何欄位。");
	assert.ok(!log.some(l => l.method === "PATCH" && l.path === "data_sources/ds-1"));

	// Confirmed: one PATCH, by property ID
	let authorsID = api.props().Authors.id;
	lines = await ZB.main.renameNotionColumns({});
	let patch = log.find(l => l.method === "PATCH" && l.path === "data_sources/ds-1");
	assert.deepEqual(patch.body.properties[authorsID], { name: "作者" });
	assert.deepEqual(patch.body.properties.title, { name: "標題" });
	assert.match(lines.at(-1), /^✅ 預設：已改名 \d+ 個欄位（標題、作者、年份/);
	assert.ok(api.props()["作者"] && !api.props().Authors);

	// The next sync finds the page by its Chinese key column and writes the Chinese columns, no duplicates
	log.length = 0;
	item.fields.title = "Nurse-led exercise and falls (updated)";
	await ZB.main.run([item], { targets: ["notion"], ai: "none" });
	assert.deepEqual(env.errors, []);
	let query = log.find(l => l.path === "data_sources/ds-1/query");
	assert.equal(query.body.filter.property, "Zotero 識別碼");
	let update = log.find(l => l.method === "PATCH" && l.path === "pages/page-1");
	assert.ok(update.body.properties["作者"]);
	assert.ok(update.body.properties["標題"]);
	assert.ok(!update.body.properties.Authors);
	assert.ok(!log.some(l => l.method === "POST" && l.path === "pages"), "the existing page is updated");
	assert.ok(!log.some(l => l.method === "PATCH" && l.path === "data_sources/ds-1"), "no columns added");
	// Nothing left to rename
	asked.length = 0;
	lines = await ZB.main.renameNotionColumns({});
	assert.equal(asked.length, 0);
	assert.deepEqual([...lines], ["✅ 預設：欄位已經是中文"]);
	await vm.runInContext("shutdown()", env.context);
});
