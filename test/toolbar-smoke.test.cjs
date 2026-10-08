// The Zotero Bridge toolbar button (content/toolbar.js) through the real plugin in a mocked Zotero and a
// jsdom main window: added on load and for windows open at startup, removed on unload and shutdown
// (no element, stylesheet, key handler or pref observer left), the menu's groups and entries for each
// preset with live hiding, the commands calling the existing functions on the current selection, the
// messages when nothing suitable is selected, and keyboard focus within Zotero's toolbar row.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const ROOT_URI = "file://" + ROOT + "/";
const P = "extensions.zotero-bridge.";

// Zotero's items toolbar as zoteroPane.xhtml lays it out (the parts the button touches)
const MAIN_WINDOW = `<!DOCTYPE html><html><body>
<toolbar id="zotero-toolbar-item-tree">
	<hbox id="zotero-items-toolbar">
		<toolbarbutton id="zotero-tb-add" class="zotero-tb-button" tabindex="-1" type="menu"></toolbarbutton>
		<toolbarbutton id="zotero-tb-lookup" class="zotero-tb-button" tabindex="-1"></toolbarbutton>
		<toolbarbutton id="zotero-tb-attachment-add" class="zotero-tb-button" tabindex="-1" type="menu"></toolbarbutton>
		<toolbarbutton id="zotero-tb-note-add" class="zotero-tb-button" tabindex="-1" type="menu"></toolbarbutton>
		<spacer flex="1"></spacer>
		<input id="zotero-tb-search">
		<toolbarbutton id="zotero-tb-toggle-item-pane-stacked" class="zotero-tb-button" tabindex="-1"></toolbarbutton>
	</hbox>
</toolbar>
<button id="zotero-tb-collections-search"></button>
</body></html>`;

function makeWindow(selection) {
	let dom = new JSDOM(MAIN_WINDOW);
	let win = dom.window;
	win.document.createXULElement = tag => win.document.createElement(tag);
	win.MozXULElement = { insertFTLIfNeeded: () => {} };
	win.ZoteroPane = {
		getSelectedItems: () => selection.items,
		getSelectedCollections: () => (selection.collection ? [selection.collection] : []),
	};
	return win;
}

// The parts of Zotero, Gecko and the plugin scope startup touches (as in features-smoke)
function makeEnv({ prefs = {}, windows = [] } = {}) {
	let items = new Map();
	let nextID = 100;
	let descriptions = [];
	let errors = [];
	let timers = [];
	let opened = [];

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
	let Zotero = {
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
		MenuManager: { registerMenu: o => o.menuID, unregisterMenu: () => true },
		Notifier: { registerObserver: () => "obs", unregisterObserver: () => {} },
		ItemPaneManager: { registerSection: o => o.paneID, unregisterSection: () => true },
		PreferencePanes: { register: async () => "pane" },
		getMainWindows: () => windows,
		getMainWindow: () => windows[0] || {},
		getActiveZoteroPane: () => (windows[0] && windows[0].ZoteroPane) || { getSelectedCollections: () => [] },
		Items: {
			get: ids => (Array.isArray(ids) ? ids.map(id => items.get(id)) : items.get(ids)),
			exists: id => items.has(id),
			getByLibraryAndKey: () => false,
			getAll: async () => [],
		},
		Libraries: { get: () => ({ libraryType: "user", name: "My Library" }), getAll: () => [] },
		Collections: { get: () => null, getByParent: () => [] },
		Utilities: { Internal: { openPreferences: (id) => { opened.push(id); } } },
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

	let logins = [];
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
		// Long timers (PubMed checks, AI batch polling) are collected, short ones run
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
				searchLoginsAsync: async m => logins.filter(l => Object.entries(m).every(([k, v]) => l[k] === v)),
				addLoginAsync: async (l) => { logins.push(l); return l; },
				modifyLoginAsync: async (old, l) => { logins[logins.indexOf(old)] = l; },
				removeLoginAsync: async (old) => { logins.splice(logins.indexOf(old), 1); },
			},
		},
	});
	vm.runInContext(fs.readFileSync(path.join(ROOT, "bootstrap.js"), "utf8"), context, { filename: "bootstrap.js" });
	let observersOf = name => (observers.get(name) || []).length;
	return { context, Zotero, MockItem, prefStore, descriptions, errors, opened, observersOf };
}

async function setup(opts = {}) {
	let selection = { items: [], collection: null };
	let win = makeWindow(selection);
	let env = makeEnv({ prefs: opts.prefs, windows: [win] });
	await vm.runInContext(`startup({ id: "zotero-bridge@bobyu89.github.io", version: "0.0.0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);
	return Object.assign(env, { win, doc: win.document, selection, ZB: env.context.ZB });
}

/** Open the button's menu (what Gecko does when the button is clicked) and read what it shows. */
function openMenu(env) {
	let popup = env.doc.getElementById("zotero-bridge-tb-popup");
	popup.dispatchEvent(new env.win.Event("popupshowing"));
	let shown = el => !el.hidden;
	let groups = [...popup.querySelectorAll("[data-zb-group]")].filter(shown).map(el => el.getAttribute("data-zb-group"));
	let entries = {};
	for (let el of popup.children) {
		if (!el.hasAttribute("data-zb-group-entry") || el.hidden) continue;
		let g = el.getAttribute("data-zb-group-entry");
		(entries[g] = entries[g] || []).push(el.getAttribute("data-zb-entry"));
	}
	let separators = [...popup.querySelectorAll("menuseparator[data-zb-group-separator]")].filter(shown)
		.map(el => el.getAttribute("data-zb-group-separator"));
	return { popup, groups, entries, separators };
}

function command(env, entryID) {
	let el = env.doc.querySelector(`#zotero-bridge-tb-popup [data-zb-entry="${entryID}"]`);
	assert.ok(el, `no entry ${entryID}`);
	el.dispatchEvent(new env.win.Event("command"));
	// Commands run on the next microtask
	return new Promise(resolve => setTimeout(resolve, 10));
}

// Values made in the plugin's vm context: compared by content (items as their IDs)
function plain(v) {
	return JSON.parse(JSON.stringify(v, (k, x) => (x && typeof x === "object" && "itemType" in x ? `item:${x.id}` : x)));
}

function same(actual, expected) {
	assert.deepEqual(plain(actual), plain(expected));
}

function key(env, target, keyName, opts = {}) {
	let ev = new env.win.KeyboardEvent("keydown", Object.assign({ key: keyName, bubbles: true, cancelable: true }, opts));
	target.dispatchEvent(ev);
	return ev;
}

const GUIDED = {
	sync: ["sync", "sync-no-ai", "sync-obsidian", "sync-notion", "status"],
	organize: ["classify", "dashboard", "concepts", "bibliography"],
	search: ["quick-search"],
	appraise: ["screen", "dedup", "prisma", "appraisal-summary"],
	ai: ["regenerate"],
};

test("the button is added to the items toolbar at startup, removed on unload and shutdown, leaving nothing behind", async () => {
	let env = await setup();
	let { doc, win } = env;
	let button = doc.getElementById("zotero-bridge-tb-button");
	assert.ok(button, "button added for the window open at startup");
	assert.equal(button.parentNode.id, "zotero-items-toolbar");
	assert.equal(button.previousElementSibling.id, "zotero-tb-note-add", "right after Zotero's 新增筆記, before the search box");
	assert.equal(button.className, "zotero-tb-button", "Zotero's own toolbar button class: same size and states");
	assert.equal(button.getAttribute("type"), "menu");
	assert.equal(button.getAttribute("wantdropmarker"), "true");
	assert.equal(button.getAttribute("tabindex"), "-1", "in Zotero's arrow-key row like its neighbours");
	assert.equal(button.getAttribute("tooltiptext"), "Zotero Bridge");
	assert.equal(button.getAttribute("aria-label"), "Zotero Bridge");
	assert.equal(button.hidden, false);
	let css = doc.getElementById("zotero-bridge-toolbar-css");
	assert.equal(css.getAttribute("rel"), "stylesheet");
	assert.equal(css.getAttribute("href"), ROOT_URI + "content/toolbar.css", "no chrome registration in this mock: the add-on's own URI");
	assert.ok(fs.existsSync(path.join(ROOT, "content", "toolbar.css")));
	assert.match(fs.readFileSync(path.join(ROOT, "content", "toolbar.css"), "utf8"), /url\("icons\/bridge\.svg"\)/);
	assert.equal(env.ZB.toolbar.windowCount, 1);
	assert.equal(env.observersOf(P + "feature.toolbarButton"), 1);

	// Unload, load again: one button, one stylesheet, one observer
	vm.runInContext("onMainWindowUnload({ window: this.__win })", Object.assign(env.context, { __win: win }));
	assert.equal(doc.getElementById("zotero-bridge-tb-button"), null);
	assert.equal(doc.getElementById("zotero-bridge-toolbar-css"), null);
	assert.equal(env.ZB.toolbar.windowCount, 0);
	assert.equal(env.observersOf(P + "feature.toolbarButton"), 0);
	vm.runInContext("onMainWindowLoad({ window: this.__win })", env.context);
	vm.runInContext("onMainWindowLoad({ window: this.__win })", env.context);
	assert.equal(doc.querySelectorAll("#zotero-bridge-tb-button").length, 1);
	assert.equal(doc.querySelectorAll("#zotero-bridge-toolbar-css").length, 1);
	assert.equal(env.observersOf(P + "feature.toolbarButton"), 1);

	// A main window opened later gets its own
	let second = makeWindow({ items: [], collection: null });
	env.context.__win2 = second;
	vm.runInContext("onMainWindowLoad({ window: this.__win2 })", env.context);
	assert.ok(second.document.getElementById("zotero-bridge-tb-button"));
	assert.equal(env.ZB.toolbar.windowCount, 2);

	// Shutdown (disable, update, quit): gone from every window, including one Zotero no longer lists
	let toolbarZB = env.ZB.toolbar;
	await vm.runInContext("shutdown()", env.context);
	for (let d of [doc, second.document]) {
		assert.equal(d.getElementById("zotero-bridge-tb-button"), null);
		assert.equal(d.getElementById("zotero-bridge-tb-popup"), null);
		assert.equal(d.getElementById("zotero-bridge-toolbar-css"), null);
	}
	assert.equal(toolbarZB.windowCount, 0);
	assert.equal(env.observersOf(P + "feature.toolbarButton"), 0);
	// The key handler went with it: ArrowRight on 新增筆記 is Zotero's again
	let note = doc.getElementById("zotero-tb-note-add");
	note.focus();
	let ev = key(env, note, "ArrowRight");
	assert.equal(ev.defaultPrevented, false);
	assert.equal(doc.activeElement, note);
	assert.deepEqual(env.errors, []);
});

test("a window without Zotero's items toolbar gets no button and no error", async () => {
	let env = await setup();
	let bare = new JSDOM("<!DOCTYPE html><html><body></body></html>").window;
	bare.MozXULElement = { insertFTLIfNeeded: () => {} };
	env.context.__bare = bare;
	vm.runInContext("onMainWindowLoad({ window: this.__bare })", env.context);
	assert.equal(bare.document.getElementById("zotero-bridge-tb-button"), null);
	vm.runInContext("onMainWindowUnload({ window: this.__bare })", env.context);
	assert.deepEqual(env.errors, []);
});

test("menu: groups in workflow order with labels, settings last; guided and advanced show what is on", async () => {
	let env = await setup();
	let F = env.ZB.features;
	assert.equal(F.currentPreset(), "guided");
	let { popup, groups, entries, separators } = openMenu(env);
	assert.deepEqual(groups, ["sync", "organize", "search", "appraise", "ai"]);
	assert.deepEqual(entries, GUIDED);
	assert.deepEqual(separators, ["organize", "search", "appraise", "ai", "settings"], "no separator above the first group");
	// Group labels come from Fluent (both locales)
	let captions = [...popup.querySelectorAll(".zotero-bridge-tb-caption")];
	assert.deepEqual(captions.map(c => c.getAttribute("data-l10n-id")), [
		"zotero-bridge-toolbar-group-sync", "zotero-bridge-toolbar-group-organize", "zotero-bridge-toolbar-group-search",
		"zotero-bridge-toolbar-group-appraise", "zotero-bridge-toolbar-group-ai",
	]);
	// Without a menucaption element (jsdom) the label is a disabled item: never a command
	assert.ok(captions.every(c => c.getAttribute("disabled") === "true"));
	let last = popup.lastElementChild;
	assert.equal(last.getAttribute("data-zb-entry"), "settings");
	assert.equal(last.getAttribute("data-l10n-id"), "zotero-bridge-toolbar-settings");
	// Existing labels reused where they fit
	let l10n = id => popup.querySelector(`[data-zb-entry="${id}"]`).getAttribute("data-l10n-id");
	assert.equal(l10n("sync-obsidian"), "zotero-bridge-menu-obsidian");
	assert.equal(l10n("classify"), "zotero-bridge-classify-tools");
	assert.equal(l10n("quick-search"), "zotero-bridge-search-tools");
	assert.equal(l10n("prisma"), "zotero-bridge-screen-tools-prisma");
	assert.equal(l10n("synthesis"), "zotero-bridge-menu-synthesis");
	// No icons in the menu: the button carries the plugin's icon
	assert.equal(popup.querySelectorAll("[image], [icon]").length, 0);

	// 進階: everything, without reopening the window
	F.applyPreset("advanced");
	({ groups, entries } = openMenu(env));
	assert.deepEqual(groups, ["sync", "organize", "search", "appraise", "ai"]);
	assert.deepEqual(entries.search, ["quick-search", "pubmed-watch", "chase-items", "chase-included", "chase-import"]);
	assert.deepEqual(entries.ai, ["regenerate", "synthesis", "review-draft", "ebhc-report", "progress-report", "concepts-ai"]);
	assert.deepEqual(entries.sync, GUIDED.sync, "resume and stop only with a batch");
	assert.deepEqual(entries.organize, GUIDED.organize, "undo only after a run");

	// A group whose entries are all off hides with its label and separator
	F.setEnabled("screening", false);
	F.setEnabled("appraisalForm", false);
	F.setEnabled("sync", false);
	F.setEnabled("status", false);
	({ groups, entries, separators } = openMenu(env));
	assert.deepEqual(groups, ["organize", "search", "ai"]);
	assert.equal(entries.appraise, undefined);
	assert.deepEqual(entries.ai, ["synthesis", "review-draft", "ebhc-report", "progress-report", "concepts-ai"], "AI notes need the sync");
	assert.deepEqual(separators, ["search", "ai", "settings"], "the first visible group has no separator above it");
	assert.equal(popup.querySelector('[data-zb-group="appraise"]').hidden, true);
	assert.equal(popup.querySelector('[data-zb-group-separator="appraise"]').hidden, true);
	assert.deepEqual(env.errors, []);
});

test("conditional entries follow the state: resume or stop a batch, undo a classification, AI batches", async () => {
	let env = await setup();
	let { ZB, Zotero } = env;
	let { entries } = openMenu(env);
	assert.ok(!entries.sync.includes("resume") && !entries.sync.includes("stop"));
	// A stopped batch with items left: resume, with the count
	Zotero.Prefs.set(P + "batch.pending", JSON.stringify({ action: { targets: ["obsidian"], ai: "reuse" }, remaining: ["1/A", "1/B"], failed: ["1/C"], total: 3, running: false }));
	({ entries } = openMenu(env));
	assert.deepEqual(entries.sync.slice(-1), ["resume"]);
	let resume = env.doc.querySelector('[data-zb-entry="resume"]');
	assert.deepEqual(JSON.parse(resume.getAttribute("data-l10n-args")), { count: 3 });
	// Resuming syncs: hidden with the sync switched off, as in the Tools menu
	ZB.features.setEnabled("sync", false);
	({ entries } = openMenu(env));
	assert.equal(entries.sync.includes("resume"), false);
	ZB.features.setEnabled("sync", true);
	// A running batch: stop
	Zotero.Prefs.set(P + "batch.pending", JSON.stringify({ action: { targets: ["obsidian"], ai: "reuse" }, remaining: ["1/A"], failed: [], total: 1, running: true }));
	({ entries } = openMenu(env));
	assert.deepEqual(entries.sync.slice(-1), ["stop"]);
	// A classification to undo: shown even with 文獻自動分類 off (as in the Tools menu)
	Zotero.Prefs.set(P + "classify.lastRun", JSON.stringify({ at: "2026-10-01", libraries: [] }));
	ZB.features.setEnabled("autoClassify", false);
	({ entries } = openMenu(env));
	assert.deepEqual(entries.organize, ["classify-undo", "dashboard", "concepts", "bibliography"]);
	// AI batches pending: 檢查 AI 批次進度
	ZB.aiBatch.readState = () => ({ batches: [{ id: "b1", status: "in_progress" }] });
	({ entries } = openMenu(env));
	assert.deepEqual(entries.ai, ["regenerate", "ai-batch-check"]);
	assert.deepEqual(env.errors, []);
});

test("the 工具列按鈕 switch hides and shows the button live", async () => {
	let env = await setup();
	let button = env.doc.getElementById("zotero-bridge-tb-button");
	assert.equal(button.hidden, false);
	env.ZB.features.setEnabled("toolbarButton", false);
	assert.equal(button.hidden, true);
	// Hidden: the arrow keys skip it
	let note = env.doc.getElementById("zotero-tb-note-add");
	note.focus();
	key(env, note, "ArrowRight");
	assert.equal(env.doc.activeElement, note);
	env.ZB.features.applyPreset("advanced");
	assert.equal(button.hidden, false);
	// Switched off before the window opens: added hidden
	let env2 = await setup({ prefs: { [P + "feature.toolbarButton"]: false, [P + "features.version"]: 2 } });
	assert.equal(env2.doc.getElementById("zotero-bridge-tb-button").hidden, true);
});

test("commands call the existing functions with the main window's selection", async () => {
	let env = await setup();
	let { ZB, MockItem, selection } = env;
	ZB.features.applyPreset("advanced");
	let calls = [];
	let spy = name => (...args) => {
		calls.push([name, ...args]);
		return Promise.resolve();
	};
	ZB.main.run = spy("run");
	ZB.main.runSynthesis = spy("runSynthesis");
	ZB.classify.run = spy("classify.run");
	ZB.screening.dedupCollection = spy("dedupCollection");
	ZB.screening.setDecision = spy("setDecision");
	ZB.citationChase.chaseItems = spy("chaseItems");
	ZB.reviewDraft.run = spy("reviewDraft.run");
	ZB.status.runPass = spy("status.runPass");
	let a = new MockItem("journalArticle", { title: "A" });
	let b = new MockItem("journalArticle", { title: "B" });
	let pdf = new MockItem("attachment");
	pdf.parentID = a.id;
	let collection = { id: 7, name: "跌倒回顧", libraryID: 1 };
	ZB.adapter.itemsInCollection = (c, sub) => (c === collection && sub ? [a, b] : []);

	selection.items = [a, pdf, b];
	selection.collection = collection;
	await command(env, "sync");
	same(calls.pop(), ["run", [a, b], { targets: ["notion", "obsidian"], ai: "missing" }]);
	await command(env, "sync-obsidian");
	same(calls.pop(), ["run", [a, b], { targets: ["obsidian"], ai: "reuse" }]);
	await command(env, "regenerate");
	same(calls.pop(), ["run", [a, b], { targets: ["notion", "obsidian"], ai: "regenerate" }]);
	await command(env, "status");
	same(calls.pop(), ["status.runPass"]);
	await command(env, "classify");
	same(calls.pop(), ["classify.run", [a, pdf, b]]);
	await command(env, "dedup");
	same(calls.pop(), ["dedupCollection", collection]);
	await command(env, "chase-items");
	same(calls.pop(), ["chaseItems", [a, pdf, b], collection]);
	// Selected items: the item menu's scope (the collection only names where they were picked)
	await command(env, "synthesis");
	same(calls.pop(), ["runSynthesis", [a, pdf, b], { label: "跌倒回顧（選取）", collection: null }]);
	await command(env, "screen-ta-include");
	same(calls.pop(), ["setDecision", [a, b], { stage: "ta", decision: "include" }]);

	// 全文：排除 › the reasons from the screening settings
	let reasons = env.doc.querySelector('[data-zb-entry="screen-ft-exclude"] > menupopup');
	reasons.dispatchEvent(new env.win.Event("popupshowing"));
	let first = reasons.firstElementChild;
	assert.ok(first, "exclusion reasons listed");
	let reason = first.getAttribute("data-zb-reason");
	assert.equal(first.getAttribute("data-l10n-id"), "zotero-bridge-screen-reason");
	assert.deepEqual(JSON.parse(first.getAttribute("data-l10n-args")), { reason });
	assert.equal(reasons.children.length, Math.min(ZB.screening.config().reasons.length, ZB.screening.MAX_MENU_REASONS));
	first.dispatchEvent(new env.win.Event("command"));
	await new Promise(resolve => setTimeout(resolve, 10));
	same(calls.pop(), ["setDecision", [a, b], { stage: "ft", decision: "exclude", reason }]);

	// Only a collection selected: the collection commands' items and scope
	selection.items = [];
	await command(env, "classify");
	same(calls.pop(), ["classify.run", [a, b]]);
	await command(env, "synthesis");
	same(calls.pop(), ["runSynthesis", [a, b], { label: "跌倒回顧", collection }]);
	await command(env, "review-draft");
	let [name, items, scope, context] = calls.pop();
	assert.equal(name, "reviewDraft.run");
	same(items, [a, b]);
	assert.equal(scope.collection, collection);
	assert.equal(context.collectionTreeRows[0].ref, collection);
	assert.equal(context.collectionTreeRows[0].isCollection(), true);

	await command(env, "settings");
	assert.deepEqual(env.opened, ["zotero-bridge-prefs"]);
	assert.deepEqual(env.errors, []);
});

test("nothing suitable selected: the plugin's usual message, and nothing runs", async () => {
	let env = await setup();
	let { ZB, descriptions } = env;
	let calls = [];
	ZB.main.run = (...args) => { calls.push(args); return Promise.resolve(); };
	ZB.screening.setDecision = (...args) => { calls.push(args); return Promise.resolve(); };
	ZB.screening.generateReport = (...args) => { calls.push(args); return Promise.resolve(); };
	ZB.appraisalForm.exportSummary = (...args) => { calls.push(args); return Promise.resolve(); };
	// An attachment without a parent is no literature item
	let loose = new env.MockItem("attachment");
	env.selection.items = [loose];
	await command(env, "sync");
	assert.equal(descriptions.pop(), "請先選取文獻。");
	await command(env, "screen-clear");
	assert.equal(descriptions.pop(), "請先選取文獻。");
	await command(env, "prisma");
	assert.equal(descriptions.pop(), "請先在左側選取系統性回顧的分類（回顧專案）。");
	await command(env, "appraisal-summary");
	assert.equal(descriptions.pop(), "請先在左側選取分類。");
	// The existing functions' own messages where they already have one
	env.selection.items = [];
	await command(env, "classify");
	assert.equal(descriptions.pop(), "請先選取文獻，或在分類上按右鍵。");
	assert.deepEqual(calls, []);
	assert.deepEqual(env.errors, []);
});

test("keyboard: the arrow keys reach the button from 新增筆記 and back; Tab goes on to the search box", async () => {
	let env = await setup();
	let { doc } = env;
	let note = doc.getElementById("zotero-tb-note-add");
	let button = doc.getElementById("zotero-bridge-tb-button");
	let search = doc.getElementById("zotero-tb-search");
	note.focus();
	let ev = key(env, note, "ArrowRight");
	assert.equal(doc.activeElement, button);
	assert.equal(ev.defaultPrevented, true);
	// The last button in the row
	key(env, button, "ArrowRight");
	assert.equal(doc.activeElement, button);
	key(env, button, "ArrowLeft");
	assert.equal(doc.activeElement, note);
	key(env, note, "ArrowRight");
	key(env, button, "Tab");
	assert.equal(doc.activeElement, search);
	// Shift+Tab: like Zotero's own buttons in this row, to the collection search
	let clicked = 0;
	doc.getElementById("zotero-tb-collections-search").addEventListener("click", () => clicked++);
	button.focus();
	key(env, button, "Tab", { shiftKey: true });
	assert.equal(clicked, 1);
	// Keys that open the menu stay the button's own
	for (let k of ["Enter", " ", "ArrowDown"]) assert.equal(key(env, button, k).defaultPrevented, false, k);
	// Other buttons in the row are left to Zotero
	assert.equal(key(env, doc.getElementById("zotero-tb-add"), "ArrowRight").defaultPrevented, false);
});
