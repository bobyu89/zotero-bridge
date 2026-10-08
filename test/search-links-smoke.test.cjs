// Quick medical-literature search links through the real plugin in a mocked Zotero (environment
// copied from zotero-smoke): the item context menu, the item pane links, Tools → 醫學文獻快速搜尋…
// with MeSH suggestions and saving a PubMed watch, and the 「🔎 延伸搜尋」 callout in Obsidian notes.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");
const { CI_DATE } = require("../content/search-links.js");

const ROOT = path.join(__dirname, "..");
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
function makeEnv({ prefs, fetch, logins = [], confirm = () => true, timers, prompts = [], selects = [] }) {
	let items = new Map();
	let observers = [];
	let nextID = 100;
	let menus = [];
	let progressLines = [];
	let descriptions = [];
	let errors = [];
	let panes = [];
	let translations = [];
	let launched = [];
	let clipboard = [];
	let dialogs = [];

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
		launchURL: (url) => { launched.push(url); },
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
			Internal: { copyTextToClipboard: (t) => { clipboard.push(t); } },
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
		Zotero, IOUtils, PathUtils, fetch, console, TextDecoder, URL, URLSearchParams,
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
			prompt: {
				confirm: (win, title, text) => confirm(text),
				// prompts: answers for Services.prompt.prompt (null = cancel); selects: indexes (or a
				// function of the labels) for Services.prompt.select (null = cancel)
				prompt: (win, title, text, value) => {
					dialogs.push({ type: "prompt", text, value: value.value });
					let answer = prompts.shift();
					if (answer === null || answer === undefined) return false;
					value.value = answer;
					return true;
				},
				select: (win, title, text, list, selected) => {
					dialogs.push({ type: "select", text, list: Array.from(list) });
					let answer = selects.shift();
					if (typeof answer === "function") answer = answer(Array.from(list));
					if (answer === null || answer === undefined || answer < 0) return false;
					selected.value = answer;
					return true;
				},
			},
			logins: loginManager,
		},
	});
	vm.runInContext(fs.readFileSync(path.join(ROOT, "bootstrap.js"), "utf8"), context, { filename: "bootstrap.js" });
	return { context, Zotero, MockItem, addChild, menus, progressLines, descriptions, items, prefStore, errors, panes, loginManager, translations, observers, launched, clipboard, dialogs, prompts, selects };
}
const PROXY = "https://ezproxy.example.edu.tw/login?url=";

async function setup(opts = {}) {
	let vault = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-search-"));
	let fetchLog = [];
	let fetch = opts.fetch
		? async (url, init) => {
			fetchLog.push(url);
			return opts.fetch(url, init);
		}
		: async (url) => {
			fetchLog.push(url);
			throw new Error("no network expected");
		};
	let env = makeEnv({
		fetch,
		prompts: opts.prompts || [],
		selects: opts.selects || [],
		prefs: Object.assign({
			"extensions.zotero-bridge.obsidian.vaultPath": vault,
			"extensions.zotero-bridge.obsidian.folder": "Zotero",
			"extensions.zotero-bridge.llm.enabled": true,
			"extensions.zotero-bridge.llm.provider": "anthropic",
		}, opts.prefs),
	});
	await vm.runInContext(`startup({ id: "zotero-bridge@bobyu89.github.io", version: "0.0.0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);
	// The NCBI throttle (3 requests per second) needn't wait in tests
	env.context.ZB.pubmedWatch.runtime.sleep = async () => {};
	return Object.assign(env, { vault, fetchLog });
}

function paper(env, fields = {}) {
	return new env.MockItem("journalArticle", Object.assign({
		title: "Nurse-led fall prevention in hospitals",
		DOI: "10.1000/fall.1",
		extra: "PMID: 123456",
		year: "2024",
		citationKey: "chen2024",
		creators: [{ firstName: "Mei", lastName: "Chen", creatorType: "author" }],
	}, fields));
}

// An AI note with structured data (PICO), as main.js writes it
function addAINote(env, item, study) {
	let note = new env.MockItem("note");
	note.noteHTML = "<h1>🤖 AI 文獻筆記</h1><p><em>由 test-model 於 2026-10-01T00:00:00Z 產生（Zotero Bridge）</em></p><h2>一句話摘要</h2><p>衛教降低跌倒。</p>"
		+ `<h2>📋 結構化資料（Zotero Bridge）</h2><pre>${JSON.stringify(Object.assign({ study_design: "RCT", sample_size: 80 }, study), null, 2)}</pre>`;
	note.tags = ["zotero-bridge-ai"];
	env.addChild(item, note);
	return note;
}

function showing(entry, items) {
	let state = { visible: undefined, args: null };
	entry.onShowing({}, {
		items,
		setVisible: (v) => { state.visible = v; },
		setL10nArgs: (a) => { state.args = JSON.parse(a); },
	});
	return state;
}

const STUDY = { population: "older inpatients", intervention: "護理師主導衛教", comparison: "常規照護", outcomes: "falls、跌倒自我效能" };
const CINAHL = "https://search.ebscohost.com/login.aspx?direct=true&db=rzh&bquery=";

test("item context menu: find this paper per database, similar articles, more databases, proxy", async () => {
	let env = await setup({
		prefs: { "extensions.zotero-bridge.searchLinks.proxyPrefix": PROXY },
		selects: [list => list.indexOf("PubMed 相似文獻"), list => list.indexOf("Europe PMC"), null],
	});
	let item = paper(env);
	let reg = env.menus.find(m => m.menuID === "zotero-bridge-search-item");
	assert.equal(reg.target, "main/library/item");
	let sub = reg.menus[0];
	assert.equal(sub.menuType, "submenu");
	assert.equal(sub.l10nID, "zotero-bridge-search-menu");
	assert.ok(sub.icon.endsWith("content/icons/bridge.svg"));
	assert.equal(showing(sub, [item]).visible, true);
	let note = new env.MockItem("note");
	assert.equal(showing(sub, [note]).visible, false);
	assert.equal(showing(sub, []).visible, false);

	let slots = [...sub.menus].filter(m => m.l10nID === "zotero-bridge-search-db");
	assert.equal(slots.length, 8);
	let labels = slots.map(s => showing(s, [item])).map(s => (s.visible ? s.args.name : null));
	assert.deepEqual(labels, ["PubMed", "Cochrane Library", "CINAHL", "Embase（複製標題）", "Google Scholar", "Europe PMC", "Semantic Scholar", "華藝線上圖書館（複製標題）"]);

	slots[0].onCommand({}, { items: [item] });
	slots[2].onCommand({}, { items: [item] });
	assert.deepEqual(env.launched, [
		"https://pubmed.ncbi.nlm.nih.gov/123456/",
		PROXY + CINAHL + "TI%20%22Nurse-led%20fall%20prevention%20in%20hospitals%22&type=1&searchMode=And&site=ehost-live",
	]);
	// Embase has no search URL: the title goes to the clipboard and the (proxied) start page opens
	slots[3].onCommand({}, { items: [item] });
	assert.equal(env.launched.at(-1), PROXY + "https://www.embase.com/");
	assert.deepEqual(env.clipboard, ["Nurse-led fall prevention in hospitals"]);
	assert.match(env.descriptions.at(-1), /Embase 沒有可直接帶入檢索詞的網址：已複製「Nurse-led fall prevention in hospitals」/);

	let related = sub.menus.find(m => m.l10nID === "zotero-bridge-search-related");
	assert.equal(showing(related, [item]).visible, true);
	related.onCommand({}, { items: [item] });
	assert.equal(env.launched.at(-1), "https://pubmed.ncbi.nlm.nih.gov/?linkname=pubmed_pubmed&from_uid=123456");

	// 更多資料庫…: a list of every source; it comes back after each pick until cancelled
	let more = sub.menus.find(m => m.l10nID === "zotero-bridge-search-more");
	assert.deepEqual([...sub.menus].map(m => m.menuType), [...Array(8).fill("menuitem"), "menuitem", "separator", "menuitem"]);
	let launchedBefore = env.launched.length;
	let picked = await env.context.ZB.searchLinks.showMore(item);
	assert.deepEqual([...picked], ["PubMed 相似文獻", "Europe PMC"]);
	let dialog = env.dialogs.filter(d => d.type === "select");
	assert.equal(dialog.length, 3);
	assert.deepEqual(dialog[0].list, ["PubMed", "Cochrane Library", "CINAHL（經圖書館代理）", "Embase（經圖書館代理，開首頁＋複製檢索詞）", "Google Scholar",
		"Europe PMC", "Semantic Scholar", "華藝線上圖書館（開首頁＋複製檢索詞）", "臺灣博碩士論文知識加值系統（開首頁＋複製檢索詞）",
		"國家圖書館期刊文獻資訊網（開首頁＋複製檢索詞）", "PubMed 相似文獻"]);
	assert.match(dialog[0].text, /^在醫學資料庫搜尋：Nurse-led fall prevention in hospitals\n/);
	assert.deepEqual(env.launched.slice(launchedBefore), [
		"https://pubmed.ncbi.nlm.nih.gov/?linkname=pubmed_pubmed&from_uid=123456",
		"https://europepmc.org/search?query=EXT_ID%3A123456%20AND%20SRC%3AMED",
	]);
	assert.equal(typeof more.onCommand, "function");

	// Fewer entries; no PMID; nothing to search with
	env.prefStore["extensions.zotero-bridge.searchLinks.menuCount"] = "3";
	assert.deepEqual(slots.map(s => showing(s, [item]).visible), [true, true, true, false, false, false, false, false]);
	let noPMID = paper(env, { extra: "" });
	assert.equal(showing(related, [noPMID]).visible, false);
	slots[0].onCommand({}, { items: [noPMID] });
	assert.equal(env.launched.at(-1), "https://pubmed.ncbi.nlm.nih.gov/?term=10.1000%2Ffall.1%5Bdoi%5D");
	let bare = new env.MockItem("journalArticle", {});
	assert.deepEqual(slots.map(s => showing(s, [bare]).visible), Array(8).fill(false));
	// Chinese title: Chinese databases first
	env.prefStore["extensions.zotero-bridge.searchLinks.menuCount"] = "8";
	let zh = paper(env, { title: "護理人員跌倒預防衛教之成效", DOI: "", extra: "" });
	assert.equal(showing(slots[0], [zh]).args.name, "華藝線上圖書館（複製標題）");
	assert.equal(showing(slots[3], [zh]).args.name, "Google Scholar");
	assert.equal(showing(slots[4], [zh]).visible, false);
	assert.deepEqual(env.errors, []);
});

test("item pane: quick links for the item and PICO links from the AI note", async () => {
	let env = await setup({ prefs: { "extensions.zotero-bridge.searchLinks.proxyPrefix": PROXY } });
	let item = paper(env);
	addAINote(env, item, STUDY);
	let doc = new JSDOM("<div id=b></div>").window.document;
	let body = doc.getElementById("b");
	let render = it => env.panes[0].onRender({ doc, body, item: it, setSectionSummary: () => {} });
	render(item);
	let rows = [...body.querySelectorAll("div")].filter(d => d.querySelector("a[data-source]"));
	assert.equal(rows.length, 2);
	assert.match(rows[0].textContent, /^🔎 搜尋：PubMedCochrane Library/);
	assert.deepEqual([...rows[0].querySelectorAll("a")].map(a => a.dataset.source), ["pubmed", "cochrane", "cinahl", "embase", "scholar", "europepmc", "related"]);
	assert.equal(rows[1].firstChild.textContent, "PICO：");
	assert.deepEqual([...rows[1].querySelectorAll("a")].map(a => a.dataset.source), ["pubmed", "cinahl", "scholar"]);
	// The AI note itself is still shown below
	assert.match(body.textContent, /衛教降低跌倒。/);

	let click = (el) => el.dispatchEvent(new doc.defaultView.MouseEvent("click", { bubbles: true, cancelable: true }));
	click(rows[0].querySelector("a"));
	click(rows[1].querySelector("a[data-source=pubmed]"));
	click(rows[1].querySelector("a[data-source=cinahl]"));
	assert.deepEqual(env.launched, [
		"https://pubmed.ncbi.nlm.nih.gov/123456/",
		"https://pubmed.ncbi.nlm.nih.gov/?term=%22older%20inpatients%22%20AND%20falls",
		PROXY + CINAHL + "%22older%20inpatients%22%20AND%20falls&type=1&searchMode=And&site=ehost-live",
	]);
	assert.equal(rows[1].querySelector("a[data-source=pubmed]").getAttribute("href"), env.launched[1]);
	click(rows[0].querySelector("a[data-source=embase]"));
	click(rows[1].querySelector("button"));
	assert.deepEqual(env.clipboard, ["Nurse-led fall prevention in hospitals", '"older inpatients" AND falls']);

	// Only Chinese PICO: the fields as written, for Google Scholar and 華藝
	let zh = paper(env, { title: "跌倒預防衛教", DOI: "", extra: "" });
	addAINote(env, zh, { population: "住院病人", intervention: "衛教", outcomes: "跌倒發生率" });
	render(zh);
	let zhRows = [...body.querySelectorAll("div")].filter(d => d.querySelector("a[data-source]"));
	assert.equal(zhRows[1].firstChild.textContent, "PICO（原文詞彙）：");
	assert.deepEqual([...zhRows[1].querySelectorAll("a")].map(a => [a.dataset.source, a.getAttribute("href")]), [
		["scholar", "https://scholar.google.com/scholar?hl=zh-TW&q=%E4%BD%8F%E9%99%A2%E7%97%85%E4%BA%BA%20AND%20%E8%A1%9B%E6%95%99%20AND%20%E8%B7%8C%E5%80%92%E7%99%BC%E7%94%9F%E7%8E%87"],
		["airiti", "https://www.airitilibrary.com/"],
	]);

	// No AI note: links only; turned off: nothing
	let plain = paper(env);
	render(plain);
	assert.equal([...body.querySelectorAll("div")].filter(d => d.querySelector("a[data-source]")).length, 1);
	assert.match(body.textContent, /還沒有 AI 文獻筆記/);
	env.prefStore["extensions.zotero-bridge.searchLinks.paneLinks"] = false;
	render(item);
	assert.equal(body.querySelectorAll("a[data-source]").length, 0);
	assert.deepEqual(env.errors, []);
});

// NCBI E-utilities for db=mesh: "fall prevention" → Accidental Falls; "older adults" → Aged
function ncbiMock(opts = {}) {
	let MESH = { "fall prevention": ["68000058"], "older adults": ["68000368"] };
	let SUMMARY = {
		"68000058": { ds_meshui: "D000058", ds_meshterms: ["Accidental Falls"] },
		"68000368": { ds_meshui: "D000368", ds_meshterms: ["Aged"] },
	};
	return async (url) => {
		let u = new URL(url);
		let reply = json => ({ status: 200, ok: true, text: async () => JSON.stringify(json) });
		if (opts.down) return { status: 500, ok: false, text: async () => "" };
		if (u.pathname.endsWith("esearch.fcgi")) return reply({ esearchresult: { count: "1", idlist: MESH[u.searchParams.get("term")] || [] } });
		let ids = u.searchParams.get("id").split(",");
		return reply({ result: Object.assign({ uids: ids }, Object.fromEntries(ids.map(id => [id, SUMMARY[id]]))) });
	};
}

test("Tools → 醫學文獻快速搜尋…: MeSH suggestions, open PubMed, save the query as a PubMed watch", async () => {
	let MESH_QUERY = '("Accidental Falls"[Mesh] OR "fall prevention"[tiab]) AND ("Aged"[Mesh] OR "older adults"[tiab])';
	let env = await setup({
		fetch: ncbiMock(),
		prefs: { "extensions.zotero-bridge.pubmedWatch.email": "nurse@example.com" },
		prompts: ["fall prevention, older adults", "跌倒預防（長者）"],
		selects: [0, list => list.indexOf("📋 複製 PubMed 檢索式（MeSH）"), list => list.indexOf("💾 存成 PubMed 新文獻追蹤…"), null],
	});
	let tools = env.menus.find(m => m.menuID === "zotero-bridge-search-tools");
	assert.equal(tools.target, "main/menubar/tools");
	assert.equal(tools.menus[0].l10nID, "zotero-bridge-search-tools");
	let r = await env.context.ZB.searchLinks.quickSearch();
	assert.equal(r.query, "fall prevention, older adults");
	assert.equal(r.mesh.query, MESH_QUERY);
	assert.equal(env.fetchLog.length, 4, "esearch + esummary per concept");
	for (let url of env.fetchLog) {
		let u = new URL(url);
		assert.equal(u.searchParams.get("db"), "mesh");
		assert.equal(u.searchParams.get("email"), "nurse@example.com");
		assert.equal(u.searchParams.get("tool"), "zotero-bridge");
	}
	let select = env.dialogs.find(d => d.type === "select");
	assert.match(select.text, /^MeSH 建議：\nfall prevention → Accidental Falls\nolder adults → Aged\n\n選一個開啟/);
	assert.equal(select.list[0], `PubMed（MeSH 檢索式）：${MESH_QUERY.slice(0, 89)}…`);
	assert.equal(select.list[1], "PubMed");
	assert.ok(select.list.includes("CINAHL（需機構權限）"));
	assert.equal(select.list.indexOf("華藝線上圖書館（開首頁＋複製檢索詞）") > select.list.indexOf("CDC"), true, "Chinese sources last for English keywords");
	assert.deepEqual(env.launched, ["https://pubmed.ncbi.nlm.nih.gov/?term=" + env.context.ZB.searchLinks.encodeQuery(MESH_QUERY)]);
	assert.deepEqual(env.clipboard, [MESH_QUERY]);
	// Saved as a PubMed watch, valid for pubmed-watch.js
	let prompt = env.dialogs.filter(d => d.type === "prompt");
	assert.equal(prompt.length, 2);
	assert.equal(prompt[1].value, "fall prevention, older adults");
	let { watches, errors } = env.context.ZB.pubmedWatch.readWatches();
	assert.deepEqual([...errors], []);
	assert.deepEqual([...watches].map(w => [w.name, w.query, w.collection, w.enabled]), [["跌倒預防（長者）", MESH_QUERY, "📥 新文獻/跌倒預防（長者）", true]]);
	assert.match(env.descriptions.at(-1), /已新增 PubMed 追蹤「跌倒預防（長者）」/);
	assert.deepEqual([...r.picked], [select.list[0], "📋 複製 PubMed 檢索式（MeSH）", "💾 存成 PubMed 新文獻追蹤…"]);
	assert.deepEqual(env.errors, []);
});

test("quick search: Chinese keywords, NCBI down, MeSH helper off, cancelled", async () => {
	// Chinese: no MeSH lookup; 華藝 first (start page + clipboard)
	let env = await setup({ fetch: ncbiMock(), prompts: ["壓力性損傷"], selects: [0, list => list.indexOf("PubMed"), null] });
	env.menus.find(m => m.menuID === "zotero-bridge-search-tools").menus[0].onCommand();
	for (let i = 0; i < 100 && env.dialogs.filter(d => d.type === "select").length < 3; i++) await new Promise(r => setTimeout(r, 5));
	let select = env.dialogs.find(d => d.type === "select");
	assert.match(select.text, /^中文關鍵字：中文資料庫排在前面/);
	assert.deepEqual(select.list.slice(0, 4), ["華藝線上圖書館（開首頁＋複製檢索詞）", "臺灣博碩士論文知識加值系統（開首頁＋複製檢索詞）", "國家圖書館期刊文獻資訊網（開首頁＋複製檢索詞）", "衛福部／國健署"]);
	assert.ok(!select.list.some(l => l.startsWith("💾")));
	assert.deepEqual(env.launched, ["https://www.airitilibrary.com/", "https://pubmed.ncbi.nlm.nih.gov/?term=%E5%A3%93%E5%8A%9B%E6%80%A7%E6%90%8D%E5%82%B7"]);
	assert.deepEqual(env.clipboard, ["壓力性損傷"]);
	assert.equal(env.fetchLog.length, 0);

	// NCBI unreachable: plain keywords, with a note
	let down = await setup({ fetch: ncbiMock({ down: true }), prompts: ["falls"], selects: [0, null] });
	let r = await down.context.ZB.searchLinks.quickSearch();
	assert.equal(r.mesh, null);
	assert.match(down.dialogs.find(d => d.type === "select").text, /^MeSH 查詢失敗（PubMed 連線失敗（HTTP 500））/);
	assert.deepEqual(down.launched, ["https://pubmed.ncbi.nlm.nih.gov/?term=falls"]);
	down.errors.length = 0;

	// Helper off: no request at all
	let off = await setup({ fetch: ncbiMock(), prompts: ["falls"], selects: [null], prefs: { "extensions.zotero-bridge.searchLinks.meshHelper": false } });
	await off.context.ZB.searchLinks.quickSearch();
	assert.equal(off.fetchLog.length, 0);
	assert.equal(off.dialogs.find(d => d.type === "select").list[0], "PubMed");

	// Cancelled or empty input
	let cancel = await setup({ prompts: [null] });
	assert.equal(await cancel.context.ZB.searchLinks.quickSearch(), null);
	let empty = await setup({ prompts: ["   "] });
	assert.equal(await empty.context.ZB.searchLinks.quickSearch(), null);
	assert.equal(empty.dialogs.filter(d => d.type === "select").length, 0);
});

test("Obsidian note: the 「🔎 延伸搜尋」 callout in the managed region, and the switch that removes it", async () => {
	let env = await setup({ prefs: { "extensions.zotero-bridge.searchLinks.proxyPrefix": PROXY } });
	let item = paper(env);
	item.tags = ["*Accidental Falls/prevention & control", "Humans", "狀態/待讀"];
	addAINote(env, item, STUDY);
	let ZB = env.context.ZB;
	await ZB.main.run([item], { targets: ["obsidian"], ai: "reuse" });
	let file = path.join(env.vault, "Zotero", "chen2024.md");
	let note = fs.readFileSync(file, "utf8");
	let start = note.indexOf("%% zotero-bridge:start");
	let end = note.indexOf("%% zotero-bridge:end %%");
	let at = note.indexOf("> [!search]- 🔎 延伸搜尋");
	assert.ok(start < at && at < end, note);
	assert.ok(at > note.indexOf("> [!info] 書目資訊"));
	assert.ok(note.includes("> **找這篇**：[PubMed](https://pubmed.ncbi.nlm.nih.gov/123456/) · "));
	assert.ok(note.includes("> **相似文獻**：[PubMed Similar articles](https://pubmed.ncbi.nlm.nih.gov/?linkname=pubmed_pubmed&from_uid=123456)"));
	assert.ok(note.includes("> **MeSH**：[Accidental Falls](https://www.ncbi.nlm.nih.gov/mesh/?term=Accidental%20Falls)"));
	assert.ok(note.includes('> **PICO 檢索式**：`"older inpatients" AND falls`'));
	assert.ok(note.includes(`[CINAHL](${PROXY}${CINAHL}%22older%20inpatients%22%20AND%20falls&type=1&searchMode=And&site=ehost-live)`));
	assert.ok(note.includes("> **PICO（原文詞彙）**："));
	// Nothing but the query in any link: no email, key or vault path
	assert.doesNotMatch(note, /email=|api_key|zb-search-/);

	// User text outside the region stays; turning the callout off removes it on the next sync
	fs.writeFileSync(file, note.replace("## ✍️ 我的筆記\n\n", "## ✍️ 我的筆記\n\n我的想法\n"));
	env.prefStore["extensions.zotero-bridge.searchLinks.noteCallout"] = false;
	await ZB.main.run([item], { targets: ["obsidian"], ai: "reuse" });
	let after = fs.readFileSync(file, "utf8");
	assert.doesNotMatch(after, /\[!search\]/);
	assert.match(after, /我的想法/);
	assert.deepEqual(env.errors, []);
});

test("settings pane lists the source IDs and problems with the search settings", async () => {
	let env = await setup({
		prefs: {
			"extensions.zotero-bridge.searchLinks.custom": JSON.stringify([{ name: "學校館藏", url: "https://lib.example.edu.tw/?q={q}" }]),
			"extensions.zotero-bridge.searchLinks.disabled": "embase",
			"extensions.zotero-bridge.searchLinks.proxyPrefix": "ezproxy.example.edu.tw",
		},
	});
	let observed = [];
	env.Zotero.Prefs.registerObserver = (name, fn) => {
		observed.push({ name, fn });
		return Symbol(name);
	};
	env.Zotero.Prefs.unregisterObserver = () => {};
	env.Zotero.ZoteroBridge = env.context.ZB;
	let { window } = new JSDOM(`<div><div id="zb-secrets-status"></div><pre id="zb-usage"></pre><div id="zb-rules"></div><pre id="zb-search-sources"></pre></div>`);
	let paneScope = vm.createContext({ Zotero: env.Zotero, window, document: window.document, Event: window.Event, setTimeout, clearTimeout });
	vm.runInContext(fs.readFileSync(path.join(ROOT, "content", "preferences.js"), "utf8"), paneScope);
	window.ZoteroBridgePrefs.init();
	let pre = window.document.getElementById("zb-search-sources");
	let lines = pre.textContent.split("\n");
	assert.equal(lines[0], "資料庫 ID｜名稱：");
	assert.match(lines[1], /^⚠️ 圖書館代理伺服器前綴必須是 http/);
	assert.equal(lines[2], `pubmed｜PubMed（實測可帶入檢索詞，CI 實測 ${CI_DATE}：OK）`);
	assert.ok(lines.includes(`embase｜Embase（已隱藏，需機構權限，開首頁＋複製檢索詞，CI 實測 ${CI_DATE}：需登入）`));
	assert.equal(lines.at(-1), "custom-1｜學校館藏（自訂）");
	// Changing the custom list redraws it
	env.prefStore["extensions.zotero-bridge.searchLinks.custom"] = "[]";
	observed.find(o => o.name === "extensions.zotero-bridge.searchLinks.custom").fn();
	assert.equal(pre.textContent.split("\n").at(-1), `cdc｜CDC（實測可帶入檢索詞，CI 實測 ${CI_DATE}：OK）`);
});
