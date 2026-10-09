// 文獻自動分類 through the real plugin in a mocked Zotero: menus follow the switches, the review window (the
// real classify-review.xhtml in jsdom) → 套用 creates the collection tree and memberships, 取消 writes
// nothing, 復原上次分類 restores, the AI topic dimension with a mocked Claude API (request shape, cost in the
// ledger), and the AI dimension skipped with a message when it is off or has no key — without any request.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const ROOT_URI = "file://" + ROOT + "/";
const P = "extensions.zotero-bridge.";

// The parts of Zotero, Gecko and the plugin scope that classification touches (copied from concepts-smoke),
// with collections that can be created, filled and erased, and a main window whose openDialog() loads the
// real review window into jsdom
function makeEnv({ prefs, fetch, confirmEx = () => 0, confirm = () => true }) {
	let items = new Map();
	let nextID = 100;
	let menus = [];
	let panes = [];
	let progressLines = [];
	let descriptions = [];
	let errors = [];
	let saves = [];
	let confirms = [];
	let dialogs = [];
	let collections = new Map();
	let erased = [];

	class MockItem {
		constructor(type, fields = {}) {
			this.id = nextID++;
			this.key = fields.key || `KEY${this.id}`;
			this.itemType = type;
			this.libraryID = 1;
			this.deleted = false;
			this.parentID = null;
			this.fields = fields;
			this.tags = (fields.tags || []).slice();
			this.children = [];
			this.noteHTML = "";
			this.collectionIDs = new Set();
			this.dateAdded = fields.dateAdded || "2024-05-01 08:00:00";
			items.set(this.id, this);
		}
		get parentItem() { return this.parentID ? items.get(this.parentID) : undefined; }
		isRegularItem() { return !["note", "attachment", "annotation"].includes(this.itemType); }
		isNote() { return this.itemType === "note"; }
		getField(f) { return this.fields[f] || ""; }
		getCreatorsJSON() { return this.fields.creators || []; }
		getTags() { return this.tags.map(tag => ({ tag })); }
		addTag(t) { this.tags.push(t); return true; }
		removeTag(t) { this.tags = this.tags.filter(x => x !== t); return true; }
		getCollections() { return [...this.collectionIDs]; }
		inCollection(id) { return this.collectionIDs.has(id); }
		addToCollection(id) { this.collectionIDs.add(id); }
		removeFromCollection(id) { this.collectionIDs.delete(id); }
		getAttachments() { return []; }
		getNotes() { return this.children.filter(id => items.get(id).itemType === "note"); }
		getNote() { return this.noteHTML; }
		setNote(h) { this.noteHTML = h; }
		getItemTypeIconName() { return this.itemType; }
		async saveTx() { saves.push(this.id); return this.id; }
	}

	class MockCollection {
		constructor() {
			this.id = null;
			this.key = null;
			this.libraryID = 1;
			this.parentID = null;
			this.deleted = false;
		}
		async saveTx() {
			if (!this.id) {
				this.id = nextID++;
				this.key = `COLL${this.id}`;
				collections.set(this.id, this);
			}
			return this.id;
		}
		getChildItems(asIDs) {
			let list = [...items.values()].filter(i => i.collectionIDs.has(this.id) && !i.deleted);
			return asIDs ? list.map(i => i.id) : list;
		}
		async eraseTx() {
			collections.delete(this.id);
			erased.push(this.name);
		}
	}

	let prefStore = Object.assign({}, prefs);
	let activeCollection = null;
	let selectedItems = [];
	let mainWindow = {
		openDialog(url, name, features) {
			assert.equal(url, "chrome://zotero-bridge/content/classify-review.xhtml");
			assert.match(features, /chrome/);
			let dom = new JSDOM(fs.readFileSync(path.join(ROOT, "content", "classify-review.xhtml"), "utf8"), { contentType: "application/xml" });
			dialogs.push(dom.window);
			return dom.window;
		},
	};
	let Zotero = {
		Prefs: {
			get: k => prefStore[k],
			set: (k, v) => { prefStore[k] = v; },
			clear: (k) => { delete prefStore[k]; },
			// The settings pane registers observers; these tests change prefs directly
			registerObserver: () => Symbol("observer"),
			unregisterObserver: () => {},
		},
		MenuManager: { registerMenu: (o) => { menus.push(o); return o.menuID; }, unregisterMenu: () => true },
		Notifier: { registerObserver: () => "obs", unregisterObserver: () => {} },
		ItemPaneManager: { registerSection: (o) => { panes.push(o); return o.paneID; }, unregisterSection: () => true },
		PreferencePanes: { register: async () => "pane" },
		getMainWindows: () => [],
		getMainWindow: () => mainWindow,
		getActiveZoteroPane: () => ({
			getSelectedCollections: () => (activeCollection ? [activeCollection] : []),
			getSelectedItems: () => selectedItems,
		}),
		Items: {
			get: ids => (Array.isArray(ids) ? ids.map(id => items.get(id)) : items.get(ids)),
			exists: id => items.has(id),
			getByLibraryAndKey: (libraryID, key) => [...items.values()].find(i => i.libraryID === libraryID && i.key === key) || false,
			getAll: async () => [],
		},
		Libraries: { userLibraryID: 1, get: () => ({ libraryType: "user", name: "我的文獻庫" }), getAll: () => [] },
		Groups: { getGroupIDFromLibraryID: () => null },
		Collection: MockCollection,
		Collections: {
			get: ids => (Array.isArray(ids) ? ids.map(id => collections.get(id)) : collections.get(ids)),
			getByLibrary: libraryID => [...collections.values()].filter(c => c.libraryID === libraryID && !c.parentID),
			getByParent: id => [...collections.values()].filter(c => c.parentID === id),
			getByLibraryAndKey: (libraryID, key) => [...collections.values()].find(c => c.libraryID === libraryID && c.key === key) || false,
		},
		Tags: { getID: () => false },
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
			addDescription(t) { descriptions.push(t); }
			show() {}
			close() {}
			startCloseTimer() {}
		},
		logError: (e) => { errors.push(e); },
		debug: () => {},
	};
	Zotero.Item = MockItem;

	function addCollection(name, parentID = null) {
		let c = new MockCollection();
		c.name = name;
		c.parentID = parentID;
		c.id = nextID++;
		c.key = `USER${c.id}`;
		collections.set(c.id, c);
		return c;
	}

	let PathUtils = { join: (...parts) => path.join(...parts), filename: p => path.basename(p), parent: p => path.dirname(p) };
	let IOUtils = { exists: async p => fs.existsSync(p), readUTF8: async p => fsp.readFile(p, "utf8") };
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
		setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
		clearTimeout,
		Services: {
			scriptloader: {
				loadSubScript: (url) => {
					let file = url.replace("file://", "");
					vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
				},
			},
			prompt: {
				BUTTON_POS_0: 1, BUTTON_POS_1: 256, BUTTON_POS_2: 65536, BUTTON_TITLE_IS_STRING: 127, BUTTON_TITLE_CANCEL: 2, BUTTON_POS_0_DEFAULT: 0,
				confirm: (win, title, text) => { confirms.push(text); return confirm(text); },
				confirmEx: (win, title, text, flags, b0, b1, b2) => { confirms.push(text); return confirmEx(text, [b0, b1, b2]); },
			},
			logins: {
				searchLoginsAsync: async m => logins.filter(l => Object.entries(m).every(([k, v]) => l[k] === v)),
				addLoginAsync: async (l) => { logins.push(l); return l; },
				modifyLoginAsync: async (old, l) => { logins[logins.indexOf(old)] = l; },
				removeLoginAsync: async (old) => { logins.splice(logins.indexOf(old), 1); },
			},
		},
	});
	vm.runInContext(fs.readFileSync(path.join(ROOT, "bootstrap.js"), "utf8"), context, { filename: "bootstrap.js" });
	return {
		context, Zotero, MockItem, items, collections, erased, menus, progressLines, descriptions, errors, saves, confirms, dialogs, prefStore, addCollection,
		setActiveCollection: (c) => { activeCollection = c; },
		setSelectedItems: (list) => { selectedItems = list; },
	};
}

const TOPIC_ANSWER = JSON.stringify({ results: [
	{ id: "S1", topics: [{ topic: "跌倒預防", confidence: "high" }, { topic: "睡眠品質", confidence: "high" }] },
	{ id: "S2", topics: [{ topic: "跌倒預防", confidence: "low" }] },
	{ id: "S3", topics: [] },
] });

function claude(log) {
	let ok = json => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(json) });
	return async (url, init) => {
		let body = init && init.body ? JSON.parse(init.body) : undefined;
		log.push({ url, body, headers: init && init.headers });
		if (String(url).startsWith("https://api.anthropic.com/")) {
			return ok({ model: "test-model", stop_reason: "end_turn", content: [{ type: "text", text: TOPIC_ANSWER }],
				usage: { input_tokens: 900, output_tokens: 120, cache_creation_input_tokens: 400 } });
		}
		throw new Error(`unexpected request ${url}`);
	};
}

const RULES = "跌倒 = title:falls OR tag:跌倒\n中文文獻 = language:zh\n近年 = year>=2020\n壞的 = (title:x";

async function setup(opts = {}) {
	let requests = [];
	let env = makeEnv({
		fetch: claude(requests),
		confirmEx: opts.confirmEx,
		prefs: Object.assign({
			[P + "features.version"]: 2,
			[P + "llm.provider"]: "anthropic",
			[P + "llm.anthropicModel"]: "test-model",
			[P + "usage.prices"]: JSON.stringify({ "test-model": { input: 1, output: 5 } }),
			[P + "classify.ruleList"]: RULES,
			[P + "concepts.aliases"]: "跌倒 = Accidental Falls = falls",
		}, opts.prefs),
	});
	await vm.runInContext(`startup({ id: "zotero-bridge@bobyu89.github.io", version: "0.0.0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);
	let ZB = env.context.ZB;
	ZB.main.runtime.retry = { maxRetries: 0 };

	// Three papers: one with an AI note (structured data), an RCT by its title, a Chinese one without either
	let aiPaper = new env.MockItem("journalArticle", { key: "AIPAPER", title: "Exercise and falls in older inpatients", date: "2021-03-01",
		abstractNote: "Balance training reduced falls.", publicationTitle: "Geriatric Nursing", tags: ["nursing"] });
	let note = new env.MockItem("note");
	note.parentID = aiPaper.id;
	note.tags = ["zotero-bridge-ai"];
	let data = { study_design: "RCT", sample_size: 120, population: "Inpatients", intervention: "運動訓練", outcomes: "Accidental Falls、跌倒自我效能",
		measures: ["Morse Fall Scale"], evidence_level: "2", jbi_level: "1.c" };
	note.noteHTML = "<h1>🤖 AI 文獻筆記</h1><p><em>由 m 於 2026-10-01T00:00:00Z 產生（Zotero Bridge）</em></p>"
		+ ZB.markdown.mdToHtml("## 一句話摘要\n運動訓練降低住院長者跌倒。\n\n" + ZB.llm.studyDataBlock(ZB.llm.normalizeStudyData(data)));
	aiPaper.children.push(note.id);
	let rct = new env.MockItem("journalArticle", { key: "RCTPAPER", title: "Hip protectors: a randomized controlled trial", date: "2018",
		abstractNote: "Hip protectors and falls in nursing homes." });
	let zh = new env.MockItem("journalArticle", { key: "ZHPAPER", title: "護理人員跌倒預防衛教之成效", date: "2023", tags: ["跌倒"] });
	let review = env.addCollection("E2E Review");
	for (let i of [aiPaper, rct, zh]) i.addToCollection(review.id);
	return Object.assign(env, { ZB, requests, papers: { aiPaper, rct, zh }, review });
}

/** The 「Zotero Bridge ▸」 submenu of the item or collection menu (commands.js, menus.js). */
function zbMenu(env, menuID) {
	return env.menus.find(o => o.menuID === menuID).menus[0];
}

/** An entry of that submenu. */
function menuEntry(env, menuID, l10nID) {
	let found = zbMenu(env, menuID).menus.find(m => m.l10nID === l10nID);
	assert.ok(found, `no ${l10nID} in ${menuID}`);
	return found;
}

/** Whether the toolbar button's menu and 快速指令 offer a command right now. */
function offered(env, id) {
	let C = env.ZB.commands;
	return C.isVisible(C.get(id));
}

function visible(menu, context = {}) {
	let v = null;
	menu.onShowing({}, Object.assign({ items: [], collectionTreeRows: [], setVisible: (x) => { v = x; }, setL10nArgs() {} }, context));
	return v;
}

/** The review window once it shows the plan. */
async function openedDialog(env, count = 1) {
	for (let i = 0; i < 400; i++) {
		let win = env.dialogs[count - 1];
		if (win && win.document.querySelector(".zb-cl-apply")) return win.document.getElementById("zb-classify");
		await new Promise(r => setTimeout(r, 5));
	}
	throw new Error("the review window never showed the plan");
}

/** Collection paths with their members' keys, e.g. "自動分類/規則/跌倒 [AIPAPER,ZHPAPER]". */
function tree(env) {
	let out = [];
	let walk = (parentID, prefix) => {
		for (let c of [...env.collections.values()].filter(x => x.parentID === parentID)) {
			let p = [...prefix, c.name];
			let keys = c.getChildItems(false).map(i => i.key).sort();
			out.push(p.join("/") + (keys.length ? ` [${keys.join(",")}]` : ""));
			walk(c.id, p);
		}
	};
	walk(null, []);
	return out.sort();
}

test("menus follow the switches; 復原上次分類 shows only while there is a run to undo", async () => {
	let env = await setup();
	let F = env.ZB.features;
	let row = { collectionTreeRows: [{ isCollection: () => true, ref: env.review }] };
	let items = { items: [env.papers.aiPaper] };
	// Item menu, collection menu (Zotero Bridge ▸ 整理), toolbar and 快速指令: one command
	assert.equal(visible(menuEntry(env, "zotero-bridge-item", "zotero-bridge-classify-tools"), items), true, "on in 研究生引導");
	assert.equal(offered(env, "classify"), true);
	assert.equal(visible(zbMenu(env, "zotero-bridge-collection")), false, "no collection selected");
	assert.equal(visible(zbMenu(env, "zotero-bridge-collection"), row), true);
	assert.equal(visible(menuEntry(env, "zotero-bridge-collection", "zotero-bridge-classify-tools"), row), true);
	assert.equal(offered(env, "classify-undo"), false, "nothing to undo yet");
	F.setEnabled("autoClassify", false);
	assert.equal(visible(menuEntry(env, "zotero-bridge-item", "zotero-bridge-classify-tools"), items), false);
	assert.equal(offered(env, "classify"), false);
	assert.equal(visible(menuEntry(env, "zotero-bridge-collection", "zotero-bridge-classify-tools"), row), false);
	// Reached anyway: the usual message, nothing opened or written
	let before = env.descriptions.length;
	assert.equal(await env.ZB.classify.run([env.papers.aiPaper]), null);
	assert.match(env.descriptions[before], /「文獻自動分類」目前關閉。要使用的話：設定 → Zotero Bridge → 功能，把它打開。/);
	assert.equal(env.dialogs.length, 0);
	// A run to undo: the entry shows even with the switch off, so a run can always be taken back
	env.prefStore[P + "classify.lastRun"] = JSON.stringify({ at: "2026-10-08T00:00:00Z", libraries: [{ libraryID: 1, created: [], added: [] }] });
	assert.equal(offered(env, "classify-undo"), true);
	assert.deepEqual(env.requests, []);
	assert.deepEqual(env.errors, []);
});

test("collection menu → review → 套用 creates the tree and memberships; undo restores; nothing leaves the user's collection", async () => {
	let env = await setup();
	let { aiPaper, rct, zh } = env.papers;
	// From the collection menu, as Zotero calls it (the command itself doesn't wait)
	menuEntry(env, "zotero-bridge-collection", "zotero-bridge-classify-tools").onCommand({}, { collectionTreeRows: [{ isCollection: () => true, ref: env.review }] });
	let root = await openedDialog(env);
	let $$ = sel => [...root.querySelectorAll(sel)];
	assert.equal(root.querySelector(".zb-cl-target").textContent, "放在：我的文獻庫 › 自動分類");
	let notes = $$(".zb-cl-notes li").map(li => li.textContent);
	assert.ok(notes.some(n => /^規則：第 4 行：少了右括號/.test(n)), notes.join(" | "));
	assert.ok(notes.some(n => /^主題：「AI 主題分類」目前關閉/.test(n)), notes.join(" | "));
	assert.ok(notes.some(n => /^PICO：2 篇沒有 AI 筆記的結構化資料/.test(n)), notes.join(" | "));
	let titles = $$(".zb-cl-item-title").map(h => h.textContent);
	assert.deepEqual(titles, ["Exercise and falls in older inpatients", "Hip protectors: a randomized controlled trial", "護理人員跌倒預防衛教之成效"]);
	let why = $$(".zb-cl-item")[0].textContent;
	assert.match(why, /AI 筆記・高｜AI 筆記的研究設計：RCT/);
	assert.match(why, /CEBM Level 2/);
	assert.match(why, /依同義詞設定合併為「跌倒」/);
	assert.match($$(".zb-cl-item")[1].textContent, /規則推測・高｜標題有「randomized」/);
	assert.match($$(".zb-cl-item")[2].textContent, /沒有 AI 筆記的結構化資料：沒有 PICO 與證據等級建議/);
	// The summary counts what will happen; the user unticks 證據等級 and applies
	assert.match(root.querySelector(".zb-cl-summary").textContent, /^已勾選 \d+ 項：會建立 \d+ 個子分類，加入 \d+ 筆。$/);
	root.querySelector('.zb-cl-none-btn[data-dimension="level"]').click();
	root.querySelector(".zb-cl-apply").click();
	for (let i = 0; i < 200 && !env.descriptions.some(d => /已加入/.test(d)); i++) await new Promise(r => setTimeout(r, 5));
	assert.deepEqual(tree(env), [
		"E2E Review [AIPAPER,RCTPAPER,ZHPAPER]",
		"自動分類",
		"自動分類/研究設計",
		"自動分類/研究設計/RCT [AIPAPER,RCTPAPER]",
		"自動分類/結果 O",
		"自動分類/結果 O/跌倒 [AIPAPER]",
		"自動分類/規則",
		"自動分類/規則/中文文獻 [ZHPAPER]",
		"自動分類/規則/跌倒 [AIPAPER,ZHPAPER]",
		"自動分類/規則/近年 [AIPAPER,ZHPAPER]",
	]);
	// PICO values only one paper uses were offered unticked (Accidental Falls joined the 跌倒 alias group: ticked)
	let done = env.descriptions.find(d => /已加入/.test(d));
	assert.equal(done, "已加入 8 筆分類，新建 9 個子分類。\n想反悔：Zotero Bridge 按鈕或快速指令 → 復原上次分類。");
	assert.ok(env.prefStore[P + "classify.lastRun"]);
	assert.equal(offered(env, "classify-undo"), true);

	// The same again: reuses everything, adds nothing, keeps the undo record of the first run
	let last = env.prefStore[P + "classify.lastRun"];
	let second = env.ZB.classify.run([aiPaper, rct, zh]);
	root = await openedDialog(env, 2);
	root.querySelector('.zb-cl-none-btn[data-dimension="level"]').click();
	assert.match(root.querySelector(".zb-cl-summary").textContent, /不需要新的子分類，沒有新的加入（8 筆原本就在）/);
	root.querySelector(".zb-cl-apply").click();
	let r2 = await second;
	assert.deepEqual([r2.created, r2.added, r2.already], [0, 0, 8]);
	assert.equal(env.prefStore[P + "classify.lastRun"], last);

	// 復原上次分類 from the toolbar button or 快速指令
	env.confirms.length = 0;
	env.ZB.commands.execute("classify-undo");
	for (let i = 0; i < 200 && !env.descriptions.some(d => /已復原/.test(d)); i++) await new Promise(r => setTimeout(r, 5));
	assert.match(env.confirms[0], /會把那次加入的 8 筆分類收回/);
	assert.match(env.confirms[0], /文獻本身和你原本的分類都不會動/);
	assert.deepEqual(tree(env), ["E2E Review [AIPAPER,RCTPAPER,ZHPAPER]"]);
	assert.match(env.descriptions.find(d => /已復原/.test(d)), /已復原：收回 8 筆分類，刪除 9 個空的子分類。/);
	assert.equal(env.prefStore[P + "classify.lastRun"], "");
	assert.equal(offered(env, "classify-undo"), false);
	assert.deepEqual(env.requests, [], "no network without the AI dimension");
	assert.deepEqual(env.errors, []);
});

test("取消 (and closing with Escape) writes nothing", async () => {
	let env = await setup({ prefs: { [P + "classify.parentPath"]: "E2E Review" } });
	let saves = env.saves.length;
	let run = env.ZB.classify.run(Object.values(env.papers));
	let root = await openedDialog(env);
	assert.equal(root.querySelector(".zb-cl-target").textContent, "放在：我的文獻庫 › E2E Review › 自動分類");
	root.querySelector(".zb-cl-cancel").click();
	assert.equal((await run).cancelled, true);
	assert.deepEqual(tree(env), ["E2E Review [AIPAPER,RCTPAPER,ZHPAPER]"]);
	assert.equal(env.saves.length, saves);
	assert.equal(env.prefStore[P + "classify.lastRun"], undefined);

	run = env.ZB.classify.run(Object.values(env.papers));
	root = await openedDialog(env, 2);
	root.dispatchEvent(new env.dialogs[1].KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	assert.equal((await run).cancelled, true);
	assert.deepEqual(tree(env), ["E2E Review [AIPAPER,RCTPAPER,ZHPAPER]"]);

	// A parent path that doesn't exist: said in the review, the top level is used
	env.prefStore[P + "classify.parentPath"] = "碩論/不存在";
	run = env.ZB.classify.run([env.papers.rct]);
	root = await openedDialog(env, 3);
	assert.ok([...root.querySelectorAll(".zb-cl-notes li")].some(li => /找不到分類「碩論\/不存在」/.test(li.textContent)));
	root.querySelector(".zb-cl-apply").click();
	await run;
	assert.ok(tree(env).includes("自動分類/研究設計/RCT [RCTPAPER]"), tree(env).join("\n"));
	assert.deepEqual(env.errors, []);
});

test("AI topics: estimate first, batched request with the cached system prompt, cost in the ledger, suggestions to tick", async () => {
	let env = await setup({ prefs: {
		[P + "feature.classifyAI"]: true,
		[P + "classify.topicList"]: "跌倒預防: 跌倒、fall prevention\n照顧者負荷",
		[P + "classify.rules"]: false,
		[P + "classify.pico"]: false,
	} });
	await env.ZB.secrets.set("anthropicKey", "sk-ant-test");
	let run = env.ZB.classify.run(Object.values(env.papers));
	let root = await openedDialog(env);
	// The confirmation came first, with the item count and the estimate
	assert.equal(env.confirms.length, 1);
	assert.match(env.confirms[0], /會把 3 篇文獻的標題與摘要送到 Claude（test-model），分 1 次判斷它們屬於你列的 2 個主題/);
	assert.match(env.confirms[0], /預估費用：約 (< )?US\$/);
	assert.match(env.confirms[0], /按「套用」才會寫進 Zotero/);
	// One request: instructions + topics as cached system blocks, the papers as S1–S3, low effort
	assert.equal(env.requests.length, 1);
	let body = env.requests[0].body;
	assert.equal(body.system.length, 2);
	assert.equal(body.system[1].cache_control.type, "ephemeral");
	assert.match(body.system[1].text, /- 跌倒預防：跌倒、fall prevention\n- 照顧者負荷/);
	assert.match(body.messages[0].content, /\[S1\]\n標題：Exercise and falls in older inpatients\n摘要：Balance training reduced falls\.\n筆記摘要：運動訓練降低住院長者跌倒。/);
	assert.match(body.messages[0].content, /\[S3\]\n標題：護理人員跌倒預防衛教之成效\n摘要：（無）/);
	assert.equal(body.output_config.effort, "low");
	assert.equal(env.requests[0].headers["x-api-key"], "sk-ant-test");
	// The ledger has the call
	let ledger = JSON.parse(env.prefStore[P + "usage.ledger"]);
	let month = Object.values(ledger)[0];
	assert.equal(month.calls, 1);
	assert.equal(month.cacheWrite, 400);
	let notes = [...root.querySelectorAll(".zb-cl-notes li")].map(li => li.textContent);
	assert.ok(notes.some(n => /^主題：AI 判斷了 3 篇。$/.test(n)), notes.join(" | "));
	assert.ok(notes.some(n => /AI 提到不在清單裡的主題（睡眠品質），已忽略/.test(n)), notes.join(" | "));
	assert.ok(notes.some(n => /^AI 用量：1 次呼叫/.test(n)), notes.join(" | "));
	// High confidence ticked, low confidence offered unticked
	let topicBoxes = [...root.querySelectorAll(".zb-cl-group")].filter(g => g.querySelector(".zb-cl-group-name").textContent === "主題");
	assert.deepEqual(topicBoxes.map(g => [g.textContent.includes("AI 判斷・高"), g.querySelector("input").checked]), [[true, true], [false, false]]);
	root.querySelector(".zb-cl-apply").click();
	let result = await run;
	assert.equal(result.cancelled, false);
	assert.ok(tree(env).includes("自動分類/主題/跌倒預防 [AIPAPER]"), tree(env).join("\n"));
	assert.deepEqual(env.errors, []);
});

test("AI topics skipped with a message — switch off, no key, 跳過 — and never a request; 取消分類 stops before the review", async () => {
	let topics = { [P + "classify.topicList"]: "跌倒預防" };
	// Switched off (研究生引導)
	let env = await setup({ prefs: topics });
	let run = env.ZB.classify.run([env.papers.rct]);
	let root = await openedDialog(env);
	assert.ok([...root.querySelectorAll(".zb-cl-notes li")].some(li => li.textContent === "主題：「AI 主題分類」目前關閉，這次沒有主題建議。要使用的話：設定 → Zotero Bridge → 功能，把它打開。"));
	root.querySelector(".zb-cl-cancel").click();
	await run;
	assert.deepEqual(env.requests, []);
	assert.equal(env.confirms.length, 0);

	// On, but blocked by AI 文獻筆記
	env = await setup({ prefs: Object.assign({ [P + "feature.classifyAI"]: true, [P + "llm.enabled"]: false }, topics) });
	run = env.ZB.classify.run([env.papers.rct]);
	root = await openedDialog(env);
	assert.ok([...root.querySelectorAll(".zb-cl-notes li")].some(li => /要先打開「AI 文獻筆記」/.test(li.textContent)));
	root.querySelector(".zb-cl-cancel").click();
	await run;
	assert.deepEqual(env.requests, []);

	// On, with an empty topic list: where to write it
	env = await setup({ prefs: { [P + "feature.classifyAI"]: true } });
	run = env.ZB.classify.run([env.papers.rct]);
	root = await openedDialog(env);
	assert.ok([...root.querySelectorAll(".zb-cl-notes li")].some(li => li.textContent === "主題：還沒有列主題（設定 → 文獻自動分類 → 主題清單），這次略過。"));
	root.querySelector(".zb-cl-cancel").click();
	await run;
	assert.deepEqual(env.requests, []);

	// On, without an API key
	env = await setup({ prefs: Object.assign({ [P + "feature.classifyAI"]: true }, topics) });
	run = env.ZB.classify.run([env.papers.rct]);
	root = await openedDialog(env);
	assert.ok([...root.querySelectorAll(".zb-cl-notes li")].some(li => /還沒有設定 AI 的 API key/.test(li.textContent)));
	root.querySelector(".zb-cl-cancel").click();
	await run;
	assert.deepEqual(env.requests, []);

	// With a key: 跳過主題 continues without AI, 取消分類 stops everything
	env = await setup({ confirmEx: () => 2, prefs: Object.assign({ [P + "feature.classifyAI"]: true }, topics) });
	await env.ZB.secrets.set("anthropicKey", "sk-ant-test");
	run = env.ZB.classify.run([env.papers.rct]);
	root = await openedDialog(env);
	assert.ok([...root.querySelectorAll(".zb-cl-notes li")].some(li => /你選擇這次跳過 AI/.test(li.textContent)));
	root.querySelector(".zb-cl-cancel").click();
	await run;
	assert.deepEqual(env.requests, []);

	env = await setup({ confirmEx: () => 1, prefs: Object.assign({ [P + "feature.classifyAI"]: true }, topics) });
	await env.ZB.secrets.set("anthropicKey", "sk-ant-test");
	assert.equal((await env.ZB.classify.run([env.papers.rct])).cancelled, true);
	assert.equal(env.dialogs.length, 0);
	assert.deepEqual(env.requests, []);
	assert.deepEqual(env.errors, []);
});

test("a review window that can't open is reported and nothing is written", async () => {
	let env = await setup();
	env.Zotero.getMainWindow().openDialog = () => { throw new Error("no chrome package"); };
	let before = env.descriptions.length;
	assert.equal(await env.ZB.classify.run([env.papers.rct]), null);
	assert.match(env.descriptions[before], /確認視窗沒有開啟（no chrome package），Zotero 沒有變動。/);
	assert.deepEqual(tree(env), ["E2E Review [AIPAPER,RCTPAPER,ZHPAPER]"]);
	assert.equal(env.errors.length, 1, "logged for the debug output");
});

test("the toolbar and 快速指令 classify the selected items, else the selected collection; nothing selected says so", async () => {
	let env = await setup();
	env.setSelectedItems([env.papers.zh]);
	env.ZB.commands.execute("classify");
	let root = await openedDialog(env);
	assert.deepEqual([...root.querySelectorAll(".zb-cl-item-title")].map(h => h.textContent), ["護理人員跌倒預防衛教之成效"]);
	root.querySelector(".zb-cl-cancel").click();
	// The command doesn't wait for the run; the next one starts after it finished
	await new Promise(r => setTimeout(r, 30));
	env.setSelectedItems([]);
	env.setActiveCollection(env.review);
	env.ZB.commands.execute("classify");
	root = await openedDialog(env, 2);
	assert.equal(root.querySelectorAll(".zb-cl-item-title").length, 3);
	root.querySelector(".zb-cl-cancel").click();
	env.setActiveCollection(null);
	let before = env.descriptions.length;
	assert.equal(await env.ZB.classify.run([]), null);
	assert.match(env.descriptions[before], /請先選取文獻/);
	assert.deepEqual(env.errors, []);
});

// ---------- settings pane ----------

const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

function openPane(env) {
	let xhtml = fs.readFileSync(path.join(ROOT, "content", "preferences.xhtml"), "utf8");
	let { window } = new JSDOM(`<box xmlns="${XUL_NS}" xmlns:html="http://www.w3.org/1999/xhtml">${xhtml}</box>`, { contentType: "application/xml" });
	let paneScope = vm.createContext({ Zotero: env.Zotero, window, document: window.document, Event: window.Event, setTimeout, clearTimeout });
	vm.runInContext(fs.readFileSync(path.join(ROOT, "content", "preferences.js"), "utf8"), paneScope);
	window.ZoteroBridgePrefs.init();
	return window;
}

test("settings pane: the 文獻自動分類 section, its switches, and live validation with line numbers", async () => {
	let env = await setup();
	let F = env.ZB.features;
	let window = openPane(env);
	let doc = window.document;
	let $ = sel => doc.querySelector(sel);
	let box = $("#zb-classify-box");
	assert.ok(box);
	assert.equal(box.getAttribute("data-zb-feature"), "autoClassify");
	assert.equal(box.hasAttribute("hidden"), false, "on in 研究生引導");
	assert.equal($('[data-zb-feature="classifyAI"]').hasAttribute("hidden"), true, "the topic list waits for AI 主題分類");
	for (let pref of ["classify.parentPath", "classify.parentName", "classify.design", "classify.topics", "classify.rules", "classify.pico",
		"classify.topicList", "classify.ruleList"]) {
		assert.ok(doc.querySelector(`[preference="${P}${pref}"]`), pref);
	}
	// The rule list from setup() has an error on line 4; the textarea starts empty here (no pref binding in jsdom)
	let rules = $("#zb-classify-rules");
	let status = $("#zb-classify-rules-status");
	assert.equal(status.getAttribute("role"), "status");
	assert.equal(rules.getAttribute("aria-describedby"), "zb-classify-rules-status");
	assert.equal(status.textContent, "還沒有規則。");
	rules.value = "跌倒 = title:falls\n\n壞的 = (title:x\n年份 = year>=abc";
	rules.dispatchEvent(new window.Event("input"));
	assert.equal(status.textContent, "第 3 行：少了右括號 )\n第 4 行：年份要是四位數字，例如 year>=2020 或 year:2018-2022（現在是「abc」）");
	assert.equal(rules.getAttribute("aria-invalid"), "true");
	assert.ok(status.classList.contains("is-error"));
	rules.value = "跌倒 = title:falls\n近年 = year>=2020";
	rules.dispatchEvent(new window.Event("input"));
	assert.equal(status.textContent, "2 條規則，格式都正確。");
	assert.equal(rules.hasAttribute("aria-invalid"), false);
	let topics = $("#zb-classify-topics");
	topics.value = "跌倒預防: 跌倒\n跌倒預防";
	topics.dispatchEvent(new window.Event("input"));
	assert.equal($("#zb-classify-topics-status").textContent, "第 2 行：主題「跌倒預防」在第 1 行已經列過");
	// Switches: AI 主題分類 shows the topic list; 文獻自動分類 off folds the section
	$("#zb-feature-classifyAI").click();
	assert.equal(F.rawValue("classifyAI"), true);
	assert.equal($('[data-zb-feature="classifyAI"]').hasAttribute("hidden"), false);
	$("#zb-feature-autoClassify").click();
	assert.equal(F.rawValue("autoClassify"), false);
	assert.equal(box.hasAttribute("hidden"), true);
	assert.equal($("#zb-feature-classifyAI").disabled, true, "AI 主題分類 needs 文獻自動分類");
	assert.equal($("#zb-feature-classifyAI-req").textContent, "要先打開「文獻自動分類」才會生效。");
	assert.deepEqual(env.errors, []);
});
