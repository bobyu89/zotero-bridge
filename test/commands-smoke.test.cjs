// The command catalog (content/commands.js) and everything generated from it, through the real plugin in
// a mocked Zotero with jsdom windows: one 「Zotero Bridge ▸」 submenu in the item and in the collection
// menu (workflow groups, at most two levels), a Tools menu with only 設定…, 快速指令… and the batch
// entries, live gating, the commands acting on what was right-clicked, 快速指令 (search in Chinese and
// English, fuzzy, keyboard, disabled results with their reason, settings destinations), the shortcut,
// and a shutdown that leaves nothing behind.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const ROOT_URI = "file://" + ROOT + "/";
const P = "extensions.zotero-bridge.";
const PLUGIN_ID = "zotero-bridge@bobyu89.github.io";

const MAIN_WINDOW = `<!DOCTYPE html><html><body>
<toolbar id="zotero-toolbar-item-tree">
	<hbox id="zotero-items-toolbar">
		<toolbarbutton id="zotero-tb-note-add" class="zotero-tb-button" tabindex="-1" type="menu"></toolbarbutton>
		<input id="zotero-tb-search">
	</hbox>
</toolbar>
<button id="zotero-tb-collections-search"></button>
</body></html>`;

/**
 * Every menu entry before the catalog, where it lives now (the table in the 0.11 notes): old menu ID
 * and l10n ID → the catalog command (or variant) and the surfaces that offer it.
 */
const OLD_ENTRIES = [
	// Item menu: 「Zotero Bridge ▸」
	["zotero-bridge-item", "zotero-bridge-menu-sync", "sync", ["item", "collection"]],
	["zotero-bridge-item", "zotero-bridge-menu-regenerate", "regenerate", ["item", "collection"]],
	["zotero-bridge-item", "zotero-bridge-menu-no-ai", "sync-no-ai", ["item", "collection"]],
	["zotero-bridge-item", "zotero-bridge-menu-obsidian", "sync-obsidian", ["item", "collection"]],
	["zotero-bridge-item", "zotero-bridge-menu-notion", "sync-notion", ["item", "collection"]],
	["zotero-bridge-item", "zotero-bridge-menu-synthesis", "synthesis", ["item", "collection"]],
	["zotero-bridge-item", "zotero-bridge-menu-review-draft", "review-draft", ["item", "collection"]],
	["zotero-bridge-item", "zotero-bridge-menu-ebhc-report", "ebhc-report", ["item", "collection"]],
	// Item menu: the other registrations
	["zotero-bridge-screening-item", "zotero-bridge-screen-menu", "screen", ["item"]],
	["zotero-bridge-chase-item", "zotero-bridge-chase-items", "chase-items", ["item"]],
	["zotero-bridge-search-item", "zotero-bridge-search-menu", "search-item", ["item"]],
	["zotero-bridge-classify-item", "zotero-bridge-classify-items", "classify", ["item", "collection"]],
	// Collection menu
	["zotero-bridge-collection", "zotero-bridge-menu-collection", "sync", ["item", "collection"]],
	["zotero-bridge-export-collection", "zotero-bridge-menu-export-collection", "export-collection", ["collection"]],
	["zotero-bridge-screening-collection", "zotero-bridge-screen-dedup", "dedup", ["collection"]],
	["zotero-bridge-screening-collection", "zotero-bridge-screen-prisma", "prisma", ["collection"]],
	["zotero-bridge-chase-collection", "zotero-bridge-chase-included", "chase-included", ["collection"]],
	["zotero-bridge-chase-collection", "zotero-bridge-chase-import", "chase-import", ["collection"]],
	["zotero-bridge-appraisal-collection", "zotero-bridge-appraisal-summary", "appraisal-summary", ["collection"]],
	["zotero-bridge-classify-collection", "zotero-bridge-classify-collection", "classify", ["item", "collection"]],
	// Tools menu
	["zotero-bridge-tools", "zotero-bridge-menu-settings", "settings", ["tools"]],
	["zotero-bridge-tools", "zotero-bridge-menu-status", "status", []],
	["zotero-bridge-tools", "zotero-bridge-menu-stop", "stop", ["tools"]],
	["zotero-bridge-tools", "zotero-bridge-menu-resume", "resume", ["tools"]],
	["zotero-bridge-tools", "zotero-bridge-menu-discard", "discard", ["tools"]],
	["zotero-bridge-export-tools", "zotero-bridge-menu-export-library", "bibliography", []],
	["zotero-bridge-screening-tools", "zotero-bridge-screen-tools-dedup", "dedup", ["collection"]],
	["zotero-bridge-screening-tools", "zotero-bridge-screen-tools-prisma", "prisma", ["collection"]],
	["zotero-bridge-pubmed-watch-tools", "zotero-bridge-menu-pubmed-watch", "pubmed-watch", []],
	["zotero-bridge-dashboard-tools", "zotero-bridge-menu-dashboard", "dashboard", []],
	["zotero-bridge-concepts-tools", "zotero-bridge-menu-concepts-update", "concepts", []],
	["zotero-bridge-concepts-tools", "zotero-bridge-menu-concepts-ai", "concepts-ai", []],
	["zotero-bridge-chase-tools", "zotero-bridge-chase-tools-included", "chase-included", ["collection"]],
	["zotero-bridge-chase-tools", "zotero-bridge-chase-tools-import", "chase-import", ["collection"]],
	["zotero-bridge-search-tools", "zotero-bridge-search-tools", "quick-search", []],
	["zotero-bridge-appraisal-tools", "zotero-bridge-appraisal-tools-summary", "appraisal-summary", ["collection"]],
	["zotero-bridge-progress-report-tools", "zotero-bridge-menu-progress-report", "progress-report", []],
	["zotero-bridge-classify-tools", "zotero-bridge-classify-tools", "classify", ["item", "collection"]],
	["zotero-bridge-classify-tools", "zotero-bridge-classify-undo", "classify-undo", []],
	["zotero-bridge-ai-batch-tools", "zotero-bridge-menu-ai-batch-check", "ai-batch-check", ["tools"]],
	["zotero-bridge-ai-batch-tools", "zotero-bridge-menu-ai-batch-cancel", "ai-batch-cancel", ["tools"]],
];

function makeMainWindow(selection, opened) {
	let dom = new JSDOM(MAIN_WINDOW);
	let win = dom.window;
	win.document.createXULElement = tag => win.document.createElement(tag);
	win.MozXULElement = { insertFTLIfNeeded: () => {} };
	win.ZoteroPane = {
		getSelectedItems: () => selection.items,
		getSelectedCollections: () => (selection.collection ? [selection.collection] : []),
	};
	// The palette window: the real palette.xhtml in jsdom
	win.openDialog = (url, name, features) => {
		assert.equal(url, "chrome://zotero-bridge/content/palette.xhtml");
		assert.equal(name, "zotero-bridge-palette");
		assert.match(features, /chrome/);
		let d = new JSDOM(fs.readFileSync(path.join(ROOT, "content", "palette.xhtml"), "utf8"), { contentType: "application/xml" });
		let closed = false;
		d.window.close = () => {
			closed = true;
		};
		Object.defineProperty(d.window, "closed", { get: () => closed });
		opened.push(d.window);
		return d.window;
	};
	return win;
}

function makeEnv({ prefs = {}, mac = false } = {}) {
	let items = new Map();
	let nextID = 100;
	let descriptions = [];
	let errors = [];
	let menus = [];
	let unregistered = [];
	let prefsOpened = [];
	let dialogs = [];
	let selection = { items: [], collection: null };

	class MockItem {
		constructor(type, fields = {}) {
			this.id = nextID++;
			this.key = `KEY${this.id}`;
			this.itemType = type;
			this.libraryID = 1;
			this.deleted = false;
			this.parentID = null;
			this.fields = fields;
			items.set(this.id, this);
		}
		get parentItem() { return this.parentID ? items.get(this.parentID) : undefined; }
		isRegularItem() { return !["note", "attachment", "annotation"].includes(this.itemType); }
		getField(f) { return this.fields[f] || ""; }
		getTags() { return []; }
		getNotes() { return []; }
		getAttachments() { return []; }
	}

	let prefStore = Object.assign({}, prefs);
	let observers = new Map();
	let win = makeMainWindow(selection, dialogs);
	let Zotero = {
		isMac: mac,
		Prefs: {
			get: k => prefStore[k],
			set: (k, v) => {
				prefStore[k] = v;
				for (let o of observers.get(k) || []) o.fn();
			},
			clear: (k) => {
				delete prefStore[k];
				for (let o of observers.get(k) || []) o.fn();
			},
			registerObserver: (name, fn) => {
				let o = { fn, symbol: Symbol(name) };
				observers.set(name, [...(observers.get(name) || []), o]);
				return o.symbol;
			},
			unregisterObserver: (symbol) => {
				for (let [name, list] of observers) observers.set(name, list.filter(o => o.symbol !== symbol));
			},
		},
		MenuManager: {
			registerMenu: (o) => {
				menus.push(o);
				return o.menuID;
			},
			unregisterMenu: (id) => {
				unregistered.push(id);
				return true;
			},
		},
		Notifier: { registerObserver: () => "obs", unregisterObserver: () => {} },
		ItemPaneManager: { registerSection: o => o.paneID, unregisterSection: () => true },
		PreferencePanes: { register: async () => "pane" },
		getMainWindows: () => [win],
		getMainWindow: () => win,
		getActiveZoteroPane: () => win.ZoteroPane,
		Items: {
			get: ids => (Array.isArray(ids) ? ids.map(id => items.get(id)) : items.get(ids)),
			exists: id => items.has(id),
			getByLibraryAndKey: () => false,
			getAll: async () => [],
		},
		Libraries: { get: () => ({ libraryType: "user", name: "My Library" }), getAll: () => [] },
		Collections: { get: () => null, getByParent: () => [] },
		Utilities: {
			Internal: {
				openPreferences: (...args) => {
					prefsOpened.push(args);
					return { closed: false };
				},
			},
		},
		ProgressWindow: class {
			constructor() {
				this.ItemProgress = class {
					setText() {}
					setProgress() {}
					setError() {}
				};
			}
			changeHeadline() {}
			addDescription(t) { descriptions.push(t); }
			show() {}
			startCloseTimer() {}
		},
		logError: (e) => { errors.push(e); },
		debug: () => {},
	};
	Zotero.Item = MockItem;

	let timers = [];
	let context = vm.createContext({
		Zotero, console, TextDecoder, TextEncoder,
		IOUtils: { exists: async () => false },
		PathUtils: { join: (...parts) => path.join(...parts), filename: p => path.basename(p) },
		fetch: async (url) => { throw new Error(`unexpected request ${url}`); },
		Components: {
			Constructor: function () {
				return function (origin, formActionOrigin, httpRealm, username, password) {
					Object.assign(this, { origin, httpRealm, username, password });
				};
			},
			interfaces: { nsILoginInfo: {} },
		},
		DOMParser: new JSDOM("").window.DOMParser,
		setTimeout: (fn, ms) => {
			if (ms >= 1000) {
				timers.push({ fn, ms });
				return timers.length;
			}
			return setTimeout(fn, ms);
		},
		clearTimeout: (id) => {
			if (typeof id !== "number") clearTimeout(id);
		},
		Services: {
			scriptloader: {
				loadSubScript: (url) => {
					let file = url.replace("file://", "");
					vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
				},
			},
			prompt: { confirm: () => true },
			logins: {
				searchLoginsAsync: async () => [],
				addLoginAsync: async l => l,
				modifyLoginAsync: async () => {},
				removeLoginAsync: async () => {},
			},
		},
	});
	vm.runInContext(fs.readFileSync(path.join(ROOT, "bootstrap.js"), "utf8"), context, { filename: "bootstrap.js" });
	return {
		context, Zotero, MockItem, prefStore, descriptions, errors, menus, unregistered, prefsOpened, dialogs, selection, win,
	};
}

async function setup(opts) {
	let env = makeEnv(opts);
	await vm.runInContext(`startup({ id: ${JSON.stringify(PLUGIN_ID)}, version: "0.0.0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);
	env.ZB = env.context.ZB;
	return env;
}

const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));

/** The registered submenu of a right-click menu. */
function zbSubmenu(env, menuID) {
	let reg = env.menus.find(o => o.menuID === menuID);
	assert.ok(reg, `${menuID} registered`);
	assert.equal(reg.menus.length, 1, `${menuID}: one entry`);
	return reg.menus[0];
}

function showing(menu, context) {
	let state = { visible: null, enabled: true, args: null, classes: [] };
	let menuElem = { classList: { add: c => state.classes.push(c) }, setAttribute() {}, removeAttribute() {} };
	menu.onShowing({}, Object.assign({
		items: [], collectionTreeRows: [], menuElem,
		setVisible: (v) => { state.visible = !!v; },
		setEnabled: (v) => { state.enabled = !!v; },
		setL10nArgs: (a) => { state.args = JSON.parse(a); },
		setIcon() {},
	}, context));
	return state;
}

/** What a submenu shows for a context: [kind, l10nID] of the visible entries (captions as "caption"). */
function shown(submenu, context) {
	let out = [];
	for (let m of submenu.menus) {
		let s = m.onShowing ? showing(m, context) : { visible: true, enabled: true };
		if (!s.visible) continue;
		if (m.menuType === "separator") out.push("—");
		else if (!s.enabled) out.push(`# ${m.l10nID}`);
		else out.push(m.menuType === "submenu" ? `${m.l10nID} ▸` : m.l10nID);
	}
	return out;
}

function row(collection) {
	return { isCollection: () => true, ref: collection };
}

function papers(env) {
	let a = new env.MockItem("journalArticle", { title: "Falls A" });
	let b = new env.MockItem("journalArticle", { title: "Falls B" });
	let note = new env.MockItem("note");
	let collection = { id: 7, name: "跌倒回顧", libraryID: 1 };
	let other = { id: 8, name: "睡眠", libraryID: 1 };
	env.ZB.adapter.itemsInCollection = (c, sub) => (!sub ? [] : c === collection ? [a, b] : c === other ? [b] : []);
	return { a, b, note, collection, other };
}

function spies(env, names) {
	let calls = [];
	for (let name of names) {
		let [mod, fn] = name.split(".");
		env.ZB[mod][fn] = (...args) => {
			calls.push([name, ...args]);
			return Promise.resolve(null);
		};
	}
	return calls;
}

// Values made in the plugin's vm context: compared by content (items as their IDs)
function plain(v) {
	return JSON.parse(JSON.stringify(v, (k, x) => (x && typeof x === "object" && "itemType" in x ? `item:${x.id}` : x)));
}

function same(actual, expected, message) {
	assert.deepEqual(plain(actual), plain(expected), message);
}

function ftl(lang) {
	return fs.readFileSync(path.join(ROOT, "locale", lang, "zotero-bridge.ftl"), "utf8");
}

/** zh-TW/en-US text of a message: its .label, else its value. */
function ftlText(text, id) {
	let m = new RegExp(`^${id} =\\n {4}\\.label = (.+)$`, "m").exec(text) || new RegExp(`^${id} = (.+)$`, "m").exec(text);
	return m ? m[1] : null;
}

// ---------- the catalog ----------

test("catalog: unique IDs, every command and variant runnable, real switches, keywords, labels identical to the zh-TW FTL", async () => {
	let env = await setup();
	let C = env.ZB.commands;
	let F = env.ZB.features;
	let all = [...C.COMMANDS, C.PALETTE, C.SETTINGS];
	let ids = [];
	for (let c of all) {
		ids.push(c.id);
		for (let v of c.variants || []) if (!v.separator) ids.push(v.id);
	}
	assert.equal(new Set(ids).size, ids.length, "IDs are unique");
	let zh = ftl("zh-TW");
	let en = ftl("en-US");
	for (let c of all) {
		assert.ok(C.GROUPS.some(g => g.id === c.group) || c === C.PALETTE || c === C.SETTINGS, `${c.id}: a workflow group`);
		for (let f of c.features) assert.doesNotThrow(() => F.get(f), `${c.id}: switch ${f} exists`);
		assert.ok((c.keywords || []).length >= 3, `${c.id}: keywords`);
		assert.ok(c.keywords.some(k => /[一-鿿]/.test(k)) && c.keywords.some(k => /^[\x20-\x7e]+$/.test(k)), `${c.id}: Chinese and English keywords`);
		assert.ok(c.variants ? c.variants.every(v => v.separator || typeof v.run === "function" || typeof v.list === "function") : typeof c.run === "function", `${c.id}: runnable`);
		assert.ok([null, "items", "collection", "itemsOrCollection"].includes(c.needs), `${c.id}: needs`);
		assert.ok(c.menus.every(m => m === "item" || m === "collection"), `${c.id}: menus`);
		for (let [id, label] of [[c.l10n, c.label], [c.toolsL10n, c.toolsLabel]].filter(([id]) => id)) {
			assert.equal(ftlText(zh, id), label, `${c.id}: zh-TW ${id}`);
			assert.ok(ftlText(en, id), `${c.id}: en-US ${id}`);
		}
		for (let v of c.variants || []) {
			if (v.separator) continue;
			assert.equal(ftlText(zh, v.l10n), v.label, `${v.id}: zh-TW ${v.l10n}`);
			assert.ok(ftlText(en, v.l10n), `${v.id}: en-US ${v.l10n}`);
		}
	}
	// Every command is gated by a real switch except the ones that must stay reachable
	let ungated = C.COMMANDS.filter(c => !c.features.length).map(c => c.id);
	same(ungated, ["stop", "discard", "classify-undo", "ai-batch-check", "ai-batch-cancel"]);
	// The list variants fill as many slots as the modules allow
	assert.equal(C.get("screen-ft-exclude").max, env.ZB.screening.MAX_MENU_REASONS);
	assert.equal(C.get("search-db").max, env.ZB.searchLinks.MENU_SLOTS);
	// Groups and settings destinations
	same(C.GROUPS.map(g => g.label), ["同步", "整理", "找文獻", "篩選與評讀", "AI 輔助與寫作"]);
	for (let g of C.GROUPS) assert.equal(ftlText(zh, g.l10n), g.label);
	same(C.SECTIONS.map(s => s.id), ["features", "sync", "obsidian", "notion", "routing", "autosync", "status", "apaZh", "bibliography",
		"concepts", "fulltext", "colors", "classify", "searchLinks", "ncbi", "pubmedWatch", "citationChase", "screening", "ai", "usage"]);
	for (let s of C.SECTIONS) {
		assert.equal(ftlText(zh, s.l10n), s.label, `section ${s.id}`);
		assert.ok(ftlText(en, s.l10n), `en-US section ${s.id}`);
		for (let f of s.features) assert.doesNotThrow(() => F.get(f));
	}
	// The palette's own strings
	for (let [name, [id, text]] of Object.entries(env.ZB.palette.STRINGS)) {
		assert.equal(ftlText(zh, id), text, `palette ${name}`);
		assert.ok(ftlText(en, id), `en-US palette ${name}`);
	}
	same(env.errors, []);
});

test("every entry of the old menus is reachable: same command, on the surfaces the table says", async () => {
	let env = await setup();
	let C = env.ZB.commands;
	env.ZB.features.applyPreset("advanced");
	let itemMenu = zbSubmenu(env, "zotero-bridge-item");
	let collMenu = zbSubmenu(env, "zotero-bridge-collection");
	let tools = env.menus.find(o => o.menuID === "zotero-bridge-tools").menus;
	let inMenu = (submenu, cmd) => submenu.menus.some(m => m.l10nID === cmd.l10n);
	for (let [oldMenu, oldL10n, id, surfaces] of OLD_ENTRIES) {
		let cmd = C.get(id);
		assert.ok(cmd, `${oldMenu} ${oldL10n} → ${id}`);
		assert.ok(cmd.group || cmd === C.SETTINGS, `${id} is in the toolbar menu and the palette`);
		assert.equal(inMenu(itemMenu, cmd), surfaces.includes("item"), `${oldL10n} → ${id} in the item menu`);
		assert.equal(inMenu(collMenu, cmd), surfaces.includes("collection"), `${id} in the collection menu`);
		assert.equal(tools.some(m => m.l10nID === (cmd.toolsL10n || cmd.l10n)), surfaces.includes("tools"), `${id} in the Tools menu`);
	}
	// And nothing in the catalog is unreachable from the palette
	let entries = C.paletteEntries(C.fromWindow(env.win, "palette"));
	let commandIDs = new Set(entries.filter(e => e.kind === "command").map(e => e.command.id));
	for (let c of C.COMMANDS.filter(x => !x.when)) assert.ok(commandIDs.has(c.id), `${c.id} in the palette`);
	same(env.errors, []);
});

// ---------- the menus ----------

test("right-click and Tools menus: one Zotero Bridge submenu each, workflow groups, two levels at most; Tools keeps settings, palette, batch entries", async () => {
	let env = await setup();
	let { a, collection } = papers(env);
	// Exactly three registrations: the item menu, the collection menu, the Tools menu
	same(env.menus.map(o => [o.menuID, o.target]), [
		["zotero-bridge-item", "main/library/item"],
		["zotero-bridge-collection", "main/library/collection"],
		["zotero-bridge-tools", "main/menubar/tools"],
	]);
	let itemMenu = zbSubmenu(env, "zotero-bridge-item");
	let collMenu = zbSubmenu(env, "zotero-bridge-collection");
	for (let m of [itemMenu, collMenu]) {
		assert.equal(m.menuType, "submenu");
		assert.equal(m.l10nID, "zotero-bridge-menu");
		assert.match(m.icon, /content\/icons\/bridge\.svg$/);
		// Below the right-click entry: commands, and submenus of variants whose entries are no submenus
		for (let child of m.menus) {
			for (let grandchild of child.menus || []) assert.notEqual(grandchild.menuType, "submenu", `${child.l10nID}: no third level`);
		}
	}
	// 研究生引導, one item right-clicked
	let ctx = { items: [a], collectionTreeRows: [row(collection)] };
	assert.equal(showing(itemMenu, ctx).visible, true);
	same(shown(itemMenu, ctx), [
		"# zotero-bridge-toolbar-group-sync",
		"zotero-bridge-menu-sync", "zotero-bridge-menu-no-ai", "zotero-bridge-menu-obsidian", "zotero-bridge-menu-notion",
		"—", "# zotero-bridge-toolbar-group-organize",
		"zotero-bridge-classify-tools",
		"—", "# zotero-bridge-toolbar-group-search",
		"zotero-bridge-search-menu ▸",
		"—", "# zotero-bridge-toolbar-group-appraise",
		"zotero-bridge-toolbar-screen ▸",
		"—", "# zotero-bridge-toolbar-group-ai",
		"zotero-bridge-menu-regenerate",
	]);
	// Captions are never commands and look like the toolbar's
	let caption = itemMenu.menus.find(m => m.l10nID === "zotero-bridge-toolbar-group-sync");
	assert.equal(caption.onCommand, undefined);
	same(showing(caption, ctx).classes, ["zotero-bridge-caption"]);
	// The collection menu: the collection's commands
	let cctx = { collectionTreeRows: [row(collection)] };
	assert.equal(showing(collMenu, cctx).visible, true);
	same(shown(collMenu, cctx), [
		"# zotero-bridge-toolbar-group-sync",
		"zotero-bridge-menu-sync", "zotero-bridge-menu-no-ai", "zotero-bridge-menu-obsidian", "zotero-bridge-menu-notion",
		"—", "# zotero-bridge-toolbar-group-organize",
		"zotero-bridge-classify-tools", "zotero-bridge-cmd-export-collection",
		"—", "# zotero-bridge-toolbar-group-appraise",
		"zotero-bridge-screen-tools-dedup", "zotero-bridge-screen-tools-prisma", "zotero-bridge-appraisal-tools-summary",
		"—", "# zotero-bridge-toolbar-group-ai",
		"zotero-bridge-menu-regenerate",
	]);
	// 進階: the AI writing and citation searching commands join their groups
	env.ZB.features.applyPreset("advanced");
	same(shown(itemMenu, ctx).filter(x => !x.startsWith("#") && x !== "—"), [
		"zotero-bridge-menu-sync", "zotero-bridge-menu-no-ai", "zotero-bridge-menu-obsidian", "zotero-bridge-menu-notion",
		"zotero-bridge-classify-tools", "zotero-bridge-search-menu ▸", "zotero-bridge-toolbar-chase-items", "zotero-bridge-toolbar-screen ▸",
		"zotero-bridge-menu-regenerate", "zotero-bridge-menu-synthesis", "zotero-bridge-menu-review-draft", "zotero-bridge-menu-ebhc-report",
	]);
	same(shown(collMenu, cctx).filter(x => !x.startsWith("#") && x !== "—"), [
		"zotero-bridge-menu-sync", "zotero-bridge-menu-no-ai", "zotero-bridge-menu-obsidian", "zotero-bridge-menu-notion",
		"zotero-bridge-classify-tools", "zotero-bridge-cmd-export-collection",
		"zotero-bridge-chase-tools-included", "zotero-bridge-chase-tools-import",
		"zotero-bridge-screen-tools-dedup", "zotero-bridge-screen-tools-prisma", "zotero-bridge-appraisal-tools-summary",
		"zotero-bridge-menu-regenerate", "zotero-bridge-menu-synthesis", "zotero-bridge-menu-review-draft", "zotero-bridge-menu-ebhc-report",
	]);
	// Tools: 設定… and 快速指令… always; the batch entries only while they apply
	let tools = env.menus.find(o => o.menuID === "zotero-bridge-tools").menus;
	same(tools.map(m => m.l10nID), [
		"zotero-bridge-menu-settings", "zotero-bridge-menu-palette",
		"zotero-bridge-menu-resume", "zotero-bridge-menu-stop", "zotero-bridge-menu-discard",
		"zotero-bridge-menu-ai-batch-check", "zotero-bridge-menu-ai-batch-cancel",
	]);
	let visibleTools = () => tools.filter(m => !m.onShowing || showing(m, {}).visible).map(m => m.l10nID);
	same(visibleTools(), ["zotero-bridge-menu-settings", "zotero-bridge-menu-palette"]);
	env.prefStore[P + "batch.pending"] = JSON.stringify({ action: { targets: ["obsidian"], ai: "reuse" }, remaining: ["1/A"], failed: ["1/B"], total: 2, running: false });
	env.ZB.aiBatch.readState = () => ({ batches: [{ id: "b", status: "in_progress" }] });
	same(visibleTools(), ["zotero-bridge-menu-settings", "zotero-bridge-menu-palette", "zotero-bridge-menu-resume", "zotero-bridge-menu-discard",
		"zotero-bridge-menu-ai-batch-check", "zotero-bridge-menu-ai-batch-cancel"]);
	same(showing(tools[2], {}).args, { count: 2 });
	same(env.errors, []);
});

test("gating is live: switched-off commands, empty groups and empty submenus hide without a restart", async () => {
	let env = await setup();
	let F = env.ZB.features;
	let { a, collection } = papers(env);
	let itemMenu = zbSubmenu(env, "zotero-bridge-item");
	let collMenu = zbSubmenu(env, "zotero-bridge-collection");
	let ctx = { items: [a], collectionTreeRows: [] };
	let cctx = { collectionTreeRows: [row(collection)] };
	let registered = env.menus.slice();
	assert.ok(!shown(itemMenu, ctx).includes("zotero-bridge-menu-synthesis"));
	F.setEnabled("synthesis", true);
	assert.ok(shown(itemMenu, ctx).includes("zotero-bridge-menu-synthesis"));
	F.setEnabled("screening", false);
	assert.ok(!shown(itemMenu, ctx).includes("zotero-bridge-toolbar-screen ▸"));
	assert.ok(!shown(itemMenu, ctx).includes("# zotero-bridge-toolbar-group-appraise"), "the group hides with its caption");
	// AI notes need the sync: off with it
	F.setEnabled("sync", false);
	assert.ok(!shown(itemMenu, ctx).includes("zotero-bridge-menu-regenerate"));
	// The first group that shows has no separator above it
	F.setEnabled("autoClassify", false);
	F.setEnabled("searchLinks", false);
	same(shown(itemMenu, ctx), ["# zotero-bridge-toolbar-group-ai", "zotero-bridge-menu-synthesis"]);
	// Nothing left: the whole submenu hides
	F.setEnabled("synthesis", false);
	assert.equal(showing(itemMenu, ctx).visible, false);
	// The collection submenu needs a collection (not My Library, a saved search…)
	F.applyPreset("guided");
	assert.equal(showing(collMenu, cctx).visible, true);
	assert.equal(showing(collMenu, { collectionTreeRows: [] }).visible, false);
	assert.equal(showing(collMenu, { collectionTreeRows: [{ isCollection: () => false }] }).visible, false);
	// The database search only for a literature item, as before
	let search = itemMenu.menus.find(m => m.l10nID === "zotero-bridge-search-menu");
	assert.equal(showing(search, ctx).visible, true);
	assert.equal(showing(search, { items: [new env.MockItem("note")] }).visible, false);
	// Registration never changed
	same(env.menus, registered);
	same(env.errors, []);
});

test("right-click commands act on what was right-clicked, as the old entries did", async () => {
	let env = await setup();
	env.ZB.features.applyPreset("advanced");
	let { a, b, note, collection, other } = papers(env);
	let calls = spies(env, ["main.run", "main.runSynthesis", "reviewDraft.run", "classify.run", "screening.setDecision", "screening.dedupCollection",
		"screening.generateReport", "citationChase.chaseItems", "citationChase.chaseCollection", "citationChase.importChecked",
		"bibliography.exportCollections", "appraisalForm.exportCollections", "searchLinks.showMore", "searchLinks.openTarget"]);
	let itemMenu = zbSubmenu(env, "zotero-bridge-item");
	let collMenu = zbSubmenu(env, "zotero-bridge-collection");
	let entry = (menu, l10n) => menu.menus.find(m => m.l10nID === l10n);
	let ctx = { items: [a, note, b], collectionTreeRows: [row(collection)] };
	let cctx = { collectionTreeRows: [row(collection), row(other)] };
	let fire = async (m, c) => {
		m.onCommand({}, c);
		await tick();
		return calls.pop();
	};
	same(await fire(entry(itemMenu, "zotero-bridge-menu-sync"), ctx), ["main.run", [a, note, b], { targets: ["notion", "obsidian"], ai: "missing" }]);
	same(await fire(entry(collMenu, "zotero-bridge-menu-sync"), cctx), ["main.run", [a, b, b], { targets: ["notion", "obsidian"], ai: "missing" }]);
	same(await fire(entry(itemMenu, "zotero-bridge-menu-regenerate"), ctx), ["main.run", [a, note, b], { targets: ["notion", "obsidian"], ai: "regenerate" }]);
	same(await fire(entry(itemMenu, "zotero-bridge-menu-synthesis"), ctx), ["main.runSynthesis", [a, note, b], { label: "跌倒回顧（選取）", collection: null }]);
	same(await fire(entry(collMenu, "zotero-bridge-menu-synthesis"), cctx), ["main.runSynthesis", [a, b, b], { label: "跌倒回顧、睡眠", collection }]);
	let [name, items, scope, context] = await fire(entry(collMenu, "zotero-bridge-menu-review-draft"), cctx);
	assert.equal(name, "reviewDraft.run");
	same([items, scope], [[a, b, b], { label: "跌倒回顧、睡眠", collection }]);
	assert.equal(context.collectionTreeRows.length, 2, "the menu's own context is handed on");
	same(await fire(entry(itemMenu, "zotero-bridge-classify-tools"), ctx), ["classify.run", [a, note, b]]);
	same(await fire(entry(collMenu, "zotero-bridge-classify-tools"), cctx), ["classify.run", [a, b, b]]);
	same(await fire(entry(itemMenu, "zotero-bridge-toolbar-chase-items"), ctx), ["citationChase.chaseItems", [a, note, b], collection]);
	same(await fire(entry(collMenu, "zotero-bridge-chase-tools-included"), cctx), ["citationChase.chaseCollection", collection]);
	same(await fire(entry(collMenu, "zotero-bridge-chase-tools-import"), cctx), ["citationChase.importChecked", collection]);
	same(await fire(entry(collMenu, "zotero-bridge-cmd-export-collection"), cctx), ["bibliography.exportCollections", [collection, other]]);
	same(await fire(entry(collMenu, "zotero-bridge-appraisal-tools-summary"), cctx), ["appraisalForm.exportCollections", [collection, other]]);
	// Each right-clicked review project
	entry(collMenu, "zotero-bridge-screen-tools-prisma").onCommand({}, cctx);
	await tick();
	same(calls.splice(-2), [["screening.generateReport", collection], ["screening.generateReport", other]]);
	same(await fire(entry(collMenu, "zotero-bridge-screen-tools-dedup"), { collectionTreeRows: [row(other)] }), ["screening.dedupCollection", other]);

	// 篩選所選文獻 ▸ decisions, and one entry per exclusion reason in the same submenu
	let screen = entry(itemMenu, "zotero-bridge-toolbar-screen");
	same(await fire(screen.menus.find(m => m.l10nID === "zotero-bridge-screen-ta-include"), ctx), ["screening.setDecision", [a, note, b], { stage: "ta", decision: "include" }]);
	same(await fire(screen.menus.find(m => m.l10nID === "zotero-bridge-screen-clear"), ctx), ["screening.setDecision", [a, note, b], { clear: true }]);
	let reasons = screen.menus.filter(m => m.l10nID === "zotero-bridge-cmd-screen-ft-exclude-reason");
	assert.equal(reasons.length, env.ZB.screening.MAX_MENU_REASONS);
	let configured = env.ZB.screening.config().reasons;
	same(showing(reasons[1], ctx), { visible: true, enabled: true, args: { reason: configured[1] }, classes: [] });
	assert.equal(showing(reasons[configured.length], ctx).visible, false, "no slot past the configured reasons");
	same(await fire(reasons[1], ctx), ["screening.setDecision", [a, note, b], { stage: "ft", decision: "exclude", reason: configured[1] }]);

	// 在醫學資料庫搜尋 ▸ the item's databases, PubMed similar articles, 更多資料庫…
	env.ZB.searchLinks.menuTargets = item => (item === a ? [{ name: "PubMed", url: "https://pubmed.example/?a" }, { name: "華藝", url: "https://airiti.example", copy: true }] : []);
	env.ZB.searchLinks.relatedFor = () => null;
	let search = entry(itemMenu, "zotero-bridge-search-menu");
	let slots = search.menus.filter(m => m.l10nID === "zotero-bridge-search-db");
	assert.equal(slots.length, env.ZB.searchLinks.MENU_SLOTS);
	same(showing(slots[1], ctx).args, { name: "華藝（複製標題）" });
	assert.equal(showing(slots[2], ctx).visible, false);
	assert.equal(showing(search.menus.find(m => m.l10nID === "zotero-bridge-search-related"), ctx).visible, false);
	same(await fire(slots[0], ctx), ["searchLinks.openTarget", { name: "PubMed", url: "https://pubmed.example/?a" }]);
	same(await fire(search.menus.find(m => m.l10nID === "zotero-bridge-search-more"), ctx), ["searchLinks.showMore", a]);
	same(env.errors, []);
});

test("toolbar and palette commands keep the selection messages; Tools entries run the batch commands", async () => {
	let env = await setup();
	let { ZB, descriptions } = env;
	let calls = spies(env, ["bibliography.exportCollections", "citationChase.chaseCollection", "citationChase.importChecked", "main.resumeBatch",
		"main.discardBatch", "aiBatch.check", "aiBatch.cancelAll", "status.runPass"]);
	ZB.features.applyPreset("advanced");
	let run = id => ZB.commands.execute(id, ZB.commands.fromWindow(env.win, "toolbar"));
	await run("export-collection");
	assert.equal(descriptions.pop(), "請先在左側選取分類。");
	await run("chase-included");
	assert.equal(descriptions.pop(), "請先在左側選取系統性回顧的分類（回顧專案）。");
	// Without a collection: the 「所選文獻」 note, imported into My Library
	await run("chase-import");
	same(calls.pop(), ["citationChase.importChecked", null]);
	await run("status");
	same(calls.pop(), ["status.runPass"]);
	let tools = env.menus.find(o => o.menuID === "zotero-bridge-tools").menus;
	for (let [l10n, call] of [["zotero-bridge-menu-resume", ["main.resumeBatch"]], ["zotero-bridge-menu-discard", ["main.discardBatch"]],
		["zotero-bridge-menu-ai-batch-check", ["aiBatch.check", { manual: true }]], ["zotero-bridge-menu-ai-batch-cancel", ["aiBatch.cancelAll"]]]) {
		tools.find(m => m.l10nID === l10n).onCommand({}, {});
		await tick();
		same(calls.pop(), call, l10n);
	}
	tools.find(m => m.l10nID === "zotero-bridge-menu-settings").onCommand({}, {});
	await tick();
	same(env.prefsOpened.pop(), ["zotero-bridge-prefs"]);
	same(env.errors, []);
});

// ---------- 快速指令 ----------

test("palette search: Chinese and English keywords, case- and width-insensitive, multi-word and fuzzy", async () => {
	let env = await setup();
	let C = env.ZB.commands;
	env.ZB.features.applyPreset("advanced");
	// Nothing selected: a command with variants is one result, with what to select
	let bare = C.paletteEntries(C.fromWindow(env.win, "palette"));
	same(bare.filter(e => e.command && e.command.id === "screen").map(e => [e.id, e.availability.reason]), [["screen", "items"]]);
	// One paper selected: its decisions are results of their own
	env.selection.items = [papers(env).a];
	let entries = C.paletteEntries(C.fromWindow(env.win, "palette"));
	let top = q => (C.search(entries, q)[0] || {}).id;
	assert.equal(top("分類"), "classify");
	assert.equal(top("子分類"), "classify");
	assert.equal(top("classify"), "classify");
	assert.equal(top("CLASSIFY"), "classify", "case-insensitive");
	assert.equal(top("ＰＲＩＳＭＡ"), "prisma", "full-width letters");
	assert.equal(top("prisma"), "prisma");
	assert.equal(top("流程圖"), "prisma");
	assert.equal(top("flow diagram"), "prisma");
	assert.equal(top("prsma"), "prisma", "fuzzy: a letter missing");
	assert.equal(top("評讀"), "appraisal-summary");
	assert.equal(top("CASP"), "appraisal-summary");
	assert.equal(top("jbi"), "appraisal-summary");
	assert.equal(top("obsidian sync"), "sync-obsidian", "every word must match");
	same(C.search(entries, "引文追蹤").slice(0, 2).map(e => e.id).sort(), ["chase-included", "chase-items"]);
	assert.equal(top("snowball"), "chase-items");
	assert.equal(top("文獻探討"), "review-draft");
	assert.equal(top("advisor"), "progress-report");
	assert.equal(top("儀表板"), "dashboard");
	// Variants are their own results; settings destinations too
	assert.equal(top("標題摘要 納入"), "screen-ta-include");
	assert.ok(C.search(entries, "notion").some(e => e.id === "settings:notion"));
	assert.equal(top("設定 notion"), "settings:notion");
	assert.equal(top("anthropic"), "settings:ai");
	same(C.search(entries, "api key").slice(0, 2).map(e => e.id).sort(), ["settings:ai", "settings:ncbi"]);
	same(C.search(entries, "xyzzy"), []);
	// An empty query keeps the catalog order: commands in workflow groups, settings last
	let all = C.search(entries, "  ");
	assert.equal(all.length, entries.length);
	assert.equal(all[0].id, "sync");
	assert.equal(all.at(-1).id, "settings:usage");
	// Switched-off commands are found too, after the ones that can run when they score the same
	env.ZB.features.setEnabled("synthesis", false);
	let off = C.paletteEntries(C.fromWindow(env.win, "palette"));
	let hit = C.search(off, "比較表")[0];
	assert.equal(hit.id, "synthesis");
	same(plain(hit.availability), { ok: false, reason: "off", feature: "synthesis" });
	// Normalization
	assert.equal(C.normalize("  ＡＢＣ　Ｄｅｆ "), "abc def");
	assert.equal(C.normalize("同步（⁨3⁩ 筆）"), "同步(3 筆)");
	same(env.errors, []);
});

/** Open the palette as the shortcut or a menu does; resolves with the dialog window and its view. */
async function openPalette(env) {
	let view = null;
	let dialog = await env.ZB.palette.open(env.win, { onOpen: (w, v) => { view = v; } });
	assert.ok(dialog, "the palette opened");
	return { dialog, view, doc: dialog.document };
}

function press(doc, target, key, opts = {}) {
	let ev = new doc.defaultView.KeyboardEvent("keydown", Object.assign({ key, bubbles: true, cancelable: true }, opts));
	target.dispatchEvent(ev);
	return ev;
}

test("palette window: grouped results, type to filter, arrows move, Enter runs the selected command on the current selection, Esc closes", async () => {
	let env = await setup();
	let { a, b, collection } = papers(env);
	let calls = spies(env, ["classify.run", "main.run"]);
	let { dialog, view, doc } = await openPalette(env);
	let root = doc.getElementById("zb-palette");
	let input = doc.getElementById("zb-pal-input");
	// Accessible names and roles
	assert.equal(input.getAttribute("role"), "combobox");
	assert.equal(input.getAttribute("aria-controls"), "zb-pal-list");
	assert.equal(doc.querySelector('label[for="zb-pal-input"]').textContent, "快速指令");
	assert.equal(doc.getElementById("zb-pal-list").getAttribute("role"), "listbox");
	assert.equal(doc.getElementById("zb-pal-status").getAttribute("role"), "status");
	assert.equal(doc.documentElement.getAttribute("title"), "Zotero Bridge 快速指令");
	assert.match(root.querySelector(".zb-pal-foot").textContent, /上下鍵選擇 · Enter 執行 · Esc 關閉隨時開啟：Ctrl\+Shift\+P/);
	// Empty query: grouped by workflow, settings last
	same([...root.querySelectorAll(".zb-pal-group-title")].map(t => t.textContent), ["同步", "整理", "找文獻", "篩選與評讀", "AI 輔助與寫作", "設定"]);
	assert.equal(root.querySelector('[aria-selected="true"]').getAttribute("data-zb-entry"), "sync");
	assert.equal(input.getAttribute("aria-activedescendant"), root.querySelector('[aria-selected="true"]').id);
	// Nothing selected: the item commands say what they need
	let syncRow = root.querySelector('[data-zb-entry="sync"]');
	assert.equal(syncRow.getAttribute("aria-disabled"), "true");
	assert.equal(syncRow.querySelector(".zb-pal-why").textContent, "先選取文獻");
	assert.equal(root.querySelector('[data-zb-entry="prisma"] .zb-pal-why').textContent, "先選取分類");
	assert.equal(root.querySelector('[data-zb-entry="classify"] .zb-pal-why').textContent, "先選取文獻或分類");
	assert.equal(root.querySelector('[data-zb-entry="dashboard"]').hasAttribute("aria-disabled"), false);
	assert.equal(root.querySelector('[data-zb-entry="settings:notion"] .zb-pal-name').textContent, "設定：Notion");

	// Type: 分類 → 文獻自動分類 first, with its group; arrows move and wrap
	input.value = "分類";
	input.dispatchEvent(new doc.defaultView.Event("input"));
	let options = () => [...root.querySelectorAll('[role="option"]')];
	assert.equal(options()[0].getAttribute("data-zb-entry"), "classify");
	assert.equal(options()[0].querySelector(".zb-pal-group-tag").textContent, "整理");
	assert.match(doc.getElementById("zb-pal-status").textContent, /^\d+ 個結果$/);
	press(doc, input, "ArrowDown");
	assert.equal(view.active().id, options()[1].getAttribute("data-zb-entry"));
	assert.equal(options()[1].getAttribute("aria-selected"), "true");
	press(doc, input, "ArrowUp");
	press(doc, input, "ArrowUp");
	assert.equal(view.active().id, options().at(-1).getAttribute("data-zb-entry"), "wraps to the last");
	press(doc, input, "ArrowDown");
	assert.equal(view.active().id, "classify");

	// The selection changes while the palette is open: Enter runs on the selection as it is now
	env.selection.items = [a, b];
	env.selection.collection = collection;
	let ev = press(doc, input, "Enter");
	assert.equal(ev.defaultPrevented, true);
	await tick();
	assert.equal(dialog.closed, true, "the palette closes before the command runs");
	same(calls.pop(), ["classify.run", [a, b]]);
	assert.equal(env.ZB.palette.isOpen, false);

	// Again, with the shortcut-less path: no match says so; Esc closes without running anything
	({ dialog, view, doc } = await openPalette(env));
	view.query("xyzzy");
	assert.equal(doc.querySelectorAll('[role="option"]').length, 0);
	assert.equal(doc.getElementById("zb-pal-status").textContent, "沒有符合「xyzzy」的指令。試試功能名稱或英文，例如 PRISMA、sync。");
	assert.equal(view.choose(), null);
	press(doc, doc.getElementById("zb-pal-input"), "Escape");
	assert.equal(dialog.closed, true);
	same(calls, []);
	same(env.errors, []);
});

test("palette: a switched-off result shows where to turn it on and never runs; one without a selection says what to select", async () => {
	let env = await setup();
	let calls = spies(env, ["main.runSynthesis", "screening.dedupCollection"]);
	let { dialog, view, doc } = await openPalette(env);
	view.query("比較表");
	let first = doc.querySelector('[role="option"]');
	assert.equal(first.getAttribute("data-zb-entry"), "synthesis");
	assert.equal(first.getAttribute("aria-disabled"), "true");
	assert.equal(first.getAttribute("data-zb-reason"), "off");
	let why = first.querySelector(".zb-pal-why");
	assert.match(why.textContent, /^到 設定 → 功能 打開『文獻比較表』/);
	assert.equal(first.getAttribute("aria-describedby"), why.id);
	let button = why.querySelector("button.zb-pal-open-settings");
	assert.equal(button.textContent, "打開設定");
	// Enter on it opens the settings at 功能 instead of running it
	assert.equal(view.choose(), "settings");
	assert.equal(dialog.closed, true);
	same(env.prefsOpened.pop(), ["zotero-bridge-prefs"]);
	assert.equal(env.prefStore[P + "prefs.pendingSection"], "features");
	// The button does the same
	({ dialog, view, doc } = await openPalette(env));
	view.query("比較表");
	doc.querySelector("button.zb-pal-open-settings").click();
	assert.equal(dialog.closed, true);
	same(env.prefsOpened.pop(), ["zotero-bridge-prefs"]);
	assert.equal(env.prefStore[P + "prefs.pendingSection"], "features");
	// Required switch off: name the one to turn on (AI 筆記 needs 同步)
	env.ZB.features.setEnabled("sync", false);
	({ dialog, view, doc } = await openPalette(env));
	view.query("重新產生");
	assert.match(doc.querySelector('[data-zb-entry="regenerate"] .zb-pal-why').textContent, /打開『同步到 Obsidian／Notion』/);
	// Nothing to act on: says so, stays open, runs nothing
	view.query("重複");
	assert.equal(view.active().id, "dedup");
	assert.equal(view.choose(), "collection");
	assert.equal(doc.getElementById("zb-pal-status").textContent, "找出目前分類中可能重複的文獻：先選取分類");
	assert.equal(dialog.closed, false);
	// Even if the row is chosen through runEntry directly (a stale palette), a switched-off command doesn't run
	let synthesis = env.ZB.commands.paletteEntries(env.ZB.commands.fromWindow(env.win, "palette")).find(e => e.id === "synthesis");
	assert.equal(await env.ZB.palette.runEntry(env.win, synthesis), null);
	same(calls, []);
	env.ZB.palette.close();
	same(env.errors, []);
});

test("palette: settings destinations open the Zotero Bridge pane at their section (prefs.pendingSection, read by the pane)", async () => {
	let env = await setup();
	let pending = () => env.prefStore[P + "prefs.pendingSection"];
	let { dialog, view, doc } = await openPalette(env);
	view.query("設定 notion");
	assert.equal(view.active().id, "settings:notion");
	assert.equal(doc.querySelector('[data-zb-entry="settings:notion"] .zb-pal-group-tag').textContent, "設定");
	assert.equal(view.choose(), "run");
	assert.equal(dialog.closed, true);
	same(env.prefsOpened.pop(), ["zotero-bridge-prefs"]);
	assert.equal(pending(), "notion", "set before the pane opens, so it picks it up on load");
	// Every destination is one the pane knows (sync opens the 同步 tab)
	for (let s of env.ZB.commands.SECTIONS) {
		env.ZB.commands.openSettings(s.id);
		assert.equal(pending(), s.id);
		same(env.prefsOpened.pop(), ["zotero-bridge-prefs"]);
	}
	// Plain 設定…: no section
	env.prefStore[P + "prefs.pendingSection"] = "";
	env.ZB.commands.openSettings();
	assert.equal(pending(), "");
	// A switched-off section: the reason; Enter opens that section, which the pane turns into its switch on 功能
	({ dialog, view, doc } = await openPalette(env));
	view.query("pubmed 追蹤 設定");
	assert.equal(view.active().id, "settings:pubmedWatch");
	assert.match(doc.querySelector('[data-zb-entry="settings:pubmedWatch"] .zb-pal-why').textContent, /打開『PubMed 新文獻追蹤』/);
	assert.equal(view.choose(), "settings");
	assert.equal(pending(), "pubmedWatch");
	assert.equal(dialog.closed, true);
	// The pref is declared with the other defaults (prefs.js), as on the settings-pane side
	assert.match(fs.readFileSync(path.join(ROOT, "prefs.js"), "utf8"),
		/^pref\("extensions\.zotero-bridge\.prefs\.pendingSection", ""\);$/m);
	same(env.errors, []);
});

test("palette: opened from the toolbar's first entry and the Tools menu; a second open focuses the one already open; a failure is reported", async () => {
	let env = await setup();
	let popup = env.win.document.getElementById("zotero-bridge-tb-popup");
	let first = popup.firstElementChild;
	assert.equal(first.getAttribute("data-zb-entry"), "palette");
	first.dispatchEvent(new env.win.Event("command"));
	await tick(30);
	assert.equal(env.dialogs.length, 1);
	assert.equal(env.ZB.palette.isOpen, true);
	// Tools → Zotero Bridge 快速指令…: the open palette comes to the front
	let focused = 0;
	env.dialogs[0].focus = () => focused++;
	let tools = env.menus.find(o => o.menuID === "zotero-bridge-tools").menus;
	let paletteEntry = tools.find(m => m.l10nID === "zotero-bridge-menu-palette");
	let accel = {};
	paletteEntry.onShowing({}, { setVisible() {}, menuElem: { setAttribute: (k, v) => { accel[k] = v; }, removeAttribute() {} } });
	same(accel, { acceltext: "Ctrl+Shift+P" });
	paletteEntry.onCommand({}, {});
	await tick(30);
	assert.equal(env.dialogs.length, 1, "no second window");
	assert.equal(focused, 1);
	env.ZB.palette.close();
	// A window that can't open: said in words, nothing breaks
	env.win.openDialog = () => { throw new Error("no chrome package"); };
	assert.equal(await env.ZB.palette.open(env.win), null);
	assert.equal(env.descriptions.pop(), "快速指令視窗沒有開啟（no chrome package）。可以改用工具列的 Zotero Bridge 按鈕或右鍵選單。");
	assert.equal(env.errors.length, 1, "logged for the debug output");
});

test("shortcut: Ctrl+Shift+P (⇧⌘P on macOS) opens the palette in the main window; left alone when Zotero uses P", async () => {
	let env = await setup();
	let key = (opts) => {
		let ev = new env.win.KeyboardEvent("keydown", Object.assign({ key: "P", code: "KeyP", bubbles: true, cancelable: true }, opts));
		env.win.document.body.dispatchEvent(ev);
		return ev;
	};
	assert.equal(env.ZB.palette.windowCount, 1);
	assert.equal(env.ZB.palette.shortcutLabel(), "Ctrl+Shift+P");
	assert.equal(key({ ctrlKey: true }).defaultPrevented, false, "Ctrl+P is Zotero's");
	assert.equal(key({ ctrlKey: true, shiftKey: true, altKey: true }).defaultPrevented, false);
	assert.equal(key({ metaKey: true, shiftKey: true }).defaultPrevented, false, "Cmd is not the accelerator here");
	assert.equal(key({ ctrlKey: true, shiftKey: true }).defaultPrevented, true);
	await tick(30);
	assert.equal(env.dialogs.length, 1);
	env.ZB.palette.close();
	// Another keyboard layout: the physical P key still works
	assert.equal(key({ ctrlKey: true, shiftKey: true, key: "Π" }).defaultPrevented, true);
	await tick(30);
	assert.equal(env.dialogs.length, 2);
	env.ZB.palette.close();

	// macOS: ⇧⌘P
	let mac = await setup({ mac: true });
	assert.equal(mac.ZB.palette.shortcutLabel(), "⇧⌘P");
	let ev = new mac.win.KeyboardEvent("keydown", { key: "p", code: "KeyP", metaKey: true, shiftKey: true, bubbles: true, cancelable: true });
	mac.win.document.body.dispatchEvent(ev);
	assert.equal(ev.defaultPrevented, true);
	await tick(30);
	assert.equal(mac.dialogs.length, 1);
	mac.ZB.palette.close();

	// A Zotero shortcut set to P (Ctrl/Cmd+Shift+P) wins: no listener, no accel text
	let taken = await setup({ prefs: { "extensions.zotero.keys.newItem": "p" } });
	assert.equal(taken.ZB.palette.windowCount, 0);
	assert.equal(taken.ZB.palette.shortcutLabel(), "");
	let free = new taken.win.KeyboardEvent("keydown", { key: "P", code: "KeyP", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
	taken.win.document.body.dispatchEvent(free);
	assert.equal(free.defaultPrevented, false);
	// So does a <key> in the window
	let doc = env.win.document;
	let k = doc.createElement("key");
	k.id = "key_somethingElse";
	k.setAttribute("key", "P");
	k.setAttribute("modifiers", "accel,shift");
	doc.body.append(k);
	assert.match(env.ZB.palette.shortcutConflict(env.win), /key_somethingElse/);
	assert.equal(env.ZB.palette.attach(env.win), false);
	same([...env.errors, ...mac.errors, ...taken.errors], []);
});

test("shutdown: menus unregistered, palette closed, shortcut listeners gone", async () => {
	let env = await setup();
	let { dialog } = await openPalette(env);
	let palette = env.ZB.palette;
	await vm.runInContext("shutdown()", env.context);
	same(env.unregistered.sort(), ["zotero-bridge-collection", "zotero-bridge-item", "zotero-bridge-tools"]);
	assert.equal(dialog.closed, true);
	assert.equal(palette.isOpen, false);
	assert.equal(palette.windowCount, 0);
	assert.equal(env.win.document.getElementById("zotero-bridge-tb-button"), null);
	let ev = new env.win.KeyboardEvent("keydown", { key: "P", code: "KeyP", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
	env.win.document.body.dispatchEvent(ev);
	assert.equal(ev.defaultPrevented, false, "the shortcut is Zotero's again");
	await tick(200);
	assert.equal(env.dialogs.length, 1);
	assert.equal(env.context.ZB, undefined);
	same(env.errors, []);
});
