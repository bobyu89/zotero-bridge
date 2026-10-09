// Feature switches through the real plugin in a mocked Zotero: the one-time migration at startup,
// menus hidden live through onShowing, the item pane rows, background work and network calls of
// switched-off features, and the settings pane's 功能 section built from the real preferences.xhtml.
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

// The parts of Zotero, Gecko and the plugin scope these paths touch (copied from dashboard-smoke), with
// pref observers that fire like Zotero's, and timers collected instead of run
function makeEnv({ prefs, fetch }) {
	let items = new Map();
	let nextID = 100;
	let menus = [];
	let panes = [];
	let progressLines = [];
	let descriptions = [];
	let errors = [];
	let timers = [];

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
		getCollections() { return []; }
		getAttachments() { return []; }
		getNotes() { return this.children.filter(id => items.get(id).itemType === "note"); }
		getNote() { return this.noteHTML; }
		setNote(h) { this.noteHTML = h; }
		getItemTypeIconName() { return this.itemType; }
		async saveTx() { return this.id; }
	}

	let prefStore = Object.assign({}, prefs);
	let observers = new Map();
	let observerCount = () => [...observers.values()].reduce((n, list) => n + list.length, 0);
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
		MenuManager: { registerMenu: (o) => { menus.push(o); return o.menuID; }, unregisterMenu: () => true },
		Notifier: { registerObserver: () => "obs", unregisterObserver: () => {} },
		ItemPaneManager: { registerSection: (o) => { panes.push(o); return o.paneID; }, unregisterSection: () => true },
		PreferencePanes: { register: async () => "pane" },
		getMainWindows: () => [],
		getMainWindow: () => ({}),
		getActiveZoteroPane: () => ({ getSelectedCollections: () => [] }),
		Items: {
			get: ids => (Array.isArray(ids) ? ids.map(id => items.get(id)) : items.get(ids)),
			exists: id => items.has(id),
			getByLibraryAndKey: () => false,
			getAll: async () => [],
		},
		Libraries: { get: () => ({ libraryType: "user", name: "My Library" }), getAll: () => [] },
		Groups: { getGroupIDFromLibraryID: () => null },
		Collections: { get: ids => (Array.isArray(ids) ? [] : null), getByParent: () => [] },
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
		getChildren: async p => (await fsp.readdir(p)).map(name => path.join(p, name)),
		stat: async (p) => {
			let st = await fsp.stat(p);
			return { type: st.isDirectory() ? "directory" : "regular", size: st.size };
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
		// Long timers (PubMed checks, AI batch polling, auto-sync) are collected, short ones run
		setTimeout: (fn, ms) => {
			if (ms >= 1000) {
				timers.push({ fn, ms, cleared: false });
				return timers.length;
			}
			return setTimeout(fn, ms);
		},
		clearTimeout: (id) => {
			if (typeof id === "number" && timers[id - 1]) timers[id - 1].cleared = true;
			else clearTimeout(id);
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
	return { context, Zotero, MockItem, items, menus, panes, progressLines, descriptions, errors, prefStore, timers, observerCount };
}

// Every network request is recorded and fails: a switched-off feature must make none
async function setup(prefs = {}) {
	let requests = [];
	let fetch = async (url) => {
		requests.push(String(url));
		throw new Error(`unexpected request ${url}`);
	};
	let env = makeEnv({ fetch, prefs });
	await vm.runInContext(`startup({ id: "zotero-bridge@bobyu89.github.io", version: "0.0.0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);
	return Object.assign(env, { requests, ZB: env.context.ZB });
}

/** The registered menu entry with this l10n ID (first match, any depth). */
function visible(menu, context = {}) {
	let v = null;
	menu.onShowing({}, Object.assign({ items: [], collectionTreeRows: [], setVisible: (x) => { v = x; }, setL10nArgs() {}, setEnabled() {} }, context));
	return v;
}

/** The 「ZotMax ▸」 submenu of the item or collection menu (commands.js, menus.js). */
function zbMenu(env, menuID) {
	return env.menus.find(o => o.menuID === menuID).menus[0];
}

/**
 * Where a catalog command shows right now: the toolbar button and 快速指令 (the catalog), and the
 * item and collection submenus it belongs to. Returns one boolean per surface.
 */
function shownOn(env, id, context) {
	let C = env.ZB.commands;
	let cmd = C.get(id);
	let out = { toolbar: C.isVisible(cmd) };
	for (let [surface, menuID] of [["item", "zotero-bridge-item"], ["collection", "zotero-bridge-collection"]]) {
		if (!cmd.menus.includes(surface)) continue;
		let entry = zbMenu(env, menuID).menus.find(m => m.l10nID === cmd.l10n);
		assert.ok(entry, `${id} in ${menuID}`);
		out[surface] = visible(entry, context);
	}
	return out;
}

function allShown(env, id, context) {
	return Object.values(shownOn(env, id, context)).every(Boolean);
}

function noneShown(env, id, context) {
	return Object.values(shownOn(env, id, context)).every(v => !v);
}

// Off in 研究生引導, on in 進階: command → its switch
const GATED_IN_GUIDED = {
	"synthesis": "synthesis",
	"review-draft": "reviewDraft",
	"ebhc-report": "ebhcReport",
	"pubmed-watch": "pubmedWatch",
	"chase-items": "citationChase",
	"chase-included": "citationChase",
	"chase-import": "citationChase",
	"progress-report": "progressReport",
	"concepts-ai": "conceptsAI",
};

// On in both
const ON_IN_GUIDED = ["sync", "sync-no-ai", "regenerate", "quick-search", "search-item", "dedup", "prisma", "dashboard", "concepts", "bibliography",
	"export-collection", "appraisal-summary", "status", "classify", "screen"];

test("a fresh profile starts in 研究生引導: the gated commands hide everywhere, and come back with 進階 without a restart", async () => {
	let env = await setup();
	let F = env.ZB.features;
	assert.equal(env.prefStore[P + "features.version"], F.MIGRATION_VERSION, "the migrations ran once at startup");
	assert.equal(F.currentPreset(), "guided");
	let registered = env.menus.map(o => o.menuID);
	let paper = new env.MockItem("journalArticle", { title: "A" });
	let ctx = { items: [paper], collectionTreeRows: [{ isCollection: () => true, ref: {} }] };
	for (let [id, feature] of Object.entries(GATED_IN_GUIDED)) assert.ok(noneShown(env, id, ctx), `${id} (${feature}) in guided`);
	for (let id of ON_IN_GUIDED) assert.ok(allShown(env, id, ctx), `${id} in guided`);
	// The item submenu shows; the collection submenu needs a selected collection
	let itemMenu = zbMenu(env, "zotero-bridge-item");
	let collMenu = zbMenu(env, "zotero-bridge-collection");
	assert.equal(visible(itemMenu, ctx), true);
	assert.equal(visible(collMenu), false);
	assert.equal(visible(collMenu, ctx), true);

	F.applyPreset("advanced");
	for (let id of Object.keys(GATED_IN_GUIDED)) assert.ok(allShown(env, id, ctx), `${id} in advanced`);
	for (let id of ON_IN_GUIDED) assert.ok(allShown(env, id, ctx), `${id} in advanced`);

	// Everything the item submenu offers switched off: the submenu itself hides
	F.applyPreset("guided");
	for (let id of ["sync", "autoClassify", "searchLinks", "screening"]) F.setEnabled(id, false);
	assert.equal(visible(itemMenu, ctx), false);
	assert.ok(noneShown(env, "regenerate", ctx), "AI notes need the sync");
	F.setEnabled("synthesis", true);
	assert.equal(visible(itemMenu, ctx), true);
	// The collection submenu still has 評讀總表 and 參考文獻
	assert.equal(visible(collMenu, ctx), true);
	F.setEnabled("appraisalForm", false);
	F.setEnabled("bibliography", false);
	F.setEnabled("synthesis", false);
	assert.equal(visible(collMenu, ctx), false);
	// Registration never changed
	assert.deepEqual(env.menus.map(o => o.menuID), registered);
	assert.deepEqual(env.errors, []);
});

test("an install used before the switches keeps everything: migrated to 進階 for the new switches, once", async () => {
	let vault = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-features-"));
	let env = await setup({ [P + "obsidian.vaultPath"]: vault, [P + "llm.batchAPI"]: true });
	let F = env.ZB.features;
	assert.equal(F.currentPreset(), "advanced");
	for (let id of Object.keys(GATED_IN_GUIDED)) assert.ok(allShown(env, id, { items: [new env.MockItem("journalArticle")], collectionTreeRows: [{ isCollection: () => true, ref: {} }] }), id);
	// The user goes back to 研究生引導; the next start keeps it
	F.applyPreset("guided");
	let next = await setup(env.prefStore);
	assert.equal(next.ZB.features.currentPreset(), "guided");
});

test("switched-off features do no background work and make no network calls", async () => {
	let vault = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-features-"));
	let env = await setup({
		[P + "obsidian.vaultPath"]: vault,
		[P + "obsidian.folder"]: "Zotero",
		[P + "features.version"]: 1,
		[P + "export.autoUpdate"]: true,
		[P + "pubmedWatch.autoCheck"]: true,
		[P + "pubmedWatch.watches"]: JSON.stringify([{ id: "w1", name: "falls", query: "falls", enabled: true }]),
		[P + "pubmedWatch.email"]: "nurse@example.com",
	});
	let { ZB } = env;
	let F = ZB.features;
	assert.equal(F.currentPreset(), "guided", "already migrated: the defaults stay");
	// PubMed automatic checks: no timer while the feature is off…
	assert.equal(ZB.pubmedWatch.timerActive, false);
	assert.equal(await ZB.pubmedWatch.runAll({ auto: true }), null);
	// …and turning it on starts one without a restart (pref observer); off stops it
	F.setEnabled("pubmedWatch", true);
	assert.equal(ZB.pubmedWatch.timerActive, true);
	F.setEnabled("pubmedWatch", false);
	assert.equal(ZB.pubmedWatch.timerActive, false);

	// Writing features reached anyway (an old shortcut): a message, no AI call
	let a = new env.MockItem("journalArticle", { title: "A" });
	let b = new env.MockItem("journalArticle", { title: "B" });
	await ZB.main.runSynthesis([a, b], { label: "x" });
	await ZB.reviewDraft.run([a, b], { label: "x" }, {});
	await ZB.ebhcReport.run([a, b], { label: "x" }, {});
	await ZB.progressReport.run();
	await ZB.concepts.synthesizeFromMenu();
	await ZB.citationChase.chaseItems([a]);
	await ZB.pubmedWatch.runAll();
	assert.equal(env.descriptions.length, 7);
	for (let text of env.descriptions) assert.match(text, /目前關閉。要使用的話：設定 → ZotMax → 功能，把它打開。/);

	// After a manual sync: the dashboard, concept cards and references.json are skipped when off
	F.setEnabled("dashboard", false);
	F.setEnabled("concepts", false);
	F.setEnabled("bibliography", false);
	F.setEnabled("searchLinks", false);
	await ZB.main.run([a], { targets: ["obsidian"], ai: "none" });
	let files = await fsp.readdir(path.join(vault, "Zotero"));
	assert.ok(files.some(f => f.endsWith(".md")), "the note itself is written");
	assert.ok(!files.includes("研究儀表板.md"), files.join(", "));
	assert.ok(!files.includes("references.json"), files.join(", "));
	assert.ok(!files.includes("概念"), files.join(", "));
	let note = fs.readFileSync(path.join(vault, "Zotero", files.find(f => f.endsWith(".md") && f !== "研究儀表板.md")), "utf8");
	assert.doesNotMatch(note, /延伸搜尋/, "no search callout with the search links off");

	// With the sync off nothing is written or sent, and auto-sync has nothing to do
	F.setEnabled("sync", false);
	let before = env.descriptions.length;
	await ZB.main.run([b], { targets: ["obsidian", "notion"], ai: "missing" });
	assert.match(env.descriptions[before], /「同步到 Obsidian／Notion」目前關閉/);
	assert.equal((await fsp.readdir(path.join(vault, "Zotero"))).filter(f => f.endsWith(".md")).length, 1);
	await ZB.main.run([b], { targets: ["obsidian"], ai: "none", silent: true });
	assert.equal(env.descriptions.length, before + 1, "silent runs stay silent");
	assert.deepEqual(env.requests, []);
	assert.deepEqual(env.errors, []);
});

test("item pane: rows and actions follow the switches; the note stays readable", async () => {
	let env = await setup({ [P + "features.version"]: 1 });
	let { ZB } = env;
	let F = ZB.features;
	let item = new env.MockItem("journalArticle", { title: "Falls", DOI: "10.1/x" });
	let note = new env.MockItem("note");
	note.parentID = item.id;
	note.tags = ["zotero-bridge-ai"];
	note.noteHTML = "<h1>🤖 AI 文獻筆記</h1><p><em>由 m 於 2026-10-01T00:00:00Z 產生（ZotMax）</em></p><h2>一句話摘要</h2><p>衛教降低跌倒。</p>";
	item.children.push(note.id);
	let doc = new JSDOM("<div id=b></div>").window.document;
	let body = doc.getElementById("b");
	let summary = null;
	let render = (it = item) => env.panes[0].onRender({ doc, body, item: it, setSectionSummary: (s) => { summary = s; } });

	let sub = id => body.querySelector(`[data-zb-sub="${id}"]`);
	// The 動作 part: catalog commands run on this item, switched-off ones hidden; 快速指令… always last
	let commands = () => [...sub("actions").querySelectorAll("button[data-zb-command]")].map(b => b.dataset.zbCommand);
	let keyPointCommands = () => [...sub("keyPoints").querySelectorAll("button[data-zb-command]")].map(b => b.dataset.zbCommand);

	render();
	assert.ok(sub("status").querySelector("section[data-zb-pane=tools]"), "tool rows grouped under 狀態");
	assert.ok(body.querySelector("[data-zb-appraisal]"));
	assert.match(sub("status").textContent, /閱讀狀態：/);
	assert.match(sub("keyPoints").textContent, /衛教降低跌倒。/);
	// 研究生引導: 引文追蹤 is off
	assert.deepEqual(commands(), ["sync", "sync-no-ai", "regenerate", "classify", "search-item", "palette"]);
	assert.ok(sub("search"), "延伸搜尋 with the search links");

	F.setEnabled("appraisalForm", false);
	F.setEnabled("status", false);
	F.setEnabled("searchLinks", false);
	F.setEnabled("screening", false);
	F.setEnabled("aiNotes", false);
	render();
	assert.equal(body.querySelector("[data-zb-appraisal]"), null);
	assert.equal(body.querySelector("section[data-zb-pane=tools]"), null, "no empty tools block");
	assert.equal(sub("status").hidden, true, "狀態 has nothing to show");
	assert.equal(sub("search"), null);
	assert.doesNotMatch(body.textContent, /閱讀狀態：/);
	assert.match(sub("keyPoints").textContent, /衛教降低跌倒。/, "an existing AI note is still shown");
	assert.deepEqual(commands(), ["sync", "sync-no-ai", "classify", "palette"]);

	let fresh = new env.MockItem("journalArticle", { title: "New" });
	render(fresh);
	assert.equal(summary, "AI 筆記已關閉");
	assert.match(sub("keyPoints").textContent, /AI 文獻筆記目前關閉/);
	assert.ok(sub("keyPoints").querySelector("[data-zb-action=open-features]"), "a way to the switch");
	assert.deepEqual(keyPointCommands(), []);
	assert.deepEqual(commands(), ["sync", "sync-no-ai", "classify", "palette"]);
	F.setEnabled("sync", false);
	render(fresh);
	assert.deepEqual(commands(), ["classify", "palette"]);
	F.setEnabled("sync", true);
	F.setEnabled("aiNotes", true);
	render(fresh);
	assert.equal(summary, "尚未產生");
	assert.match(sub("keyPoints").textContent, /這篇還沒有 AI 文獻筆記。/);
	assert.deepEqual(keyPointCommands(), ["sync"], "「產生 AI 筆記」 is the catalog's 同步");
	assert.equal(sub("keyPoints").querySelector("button[data-zb-command]").textContent, "產生 AI 筆記");
	// Nothing to regenerate yet
	assert.deepEqual(commands(), ["sync", "sync-no-ai", "classify", "palette"]);
	assert.deepEqual(env.errors, []);
});

// ---------- settings pane ----------

const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

/** The real preferences.xhtml, wrapped the way Zotero parses a plugin pane (XUL default namespace). */
function paneDOM() {
	let xhtml = fs.readFileSync(path.join(ROOT, "content", "preferences.xhtml"), "utf8");
	return new JSDOM(`<box xmlns="${XUL_NS}" xmlns:html="http://www.w3.org/1999/xhtml">${xhtml}</box>`, { contentType: "application/xml" });
}

/** prepare(window) runs before init(): Zotero's settings search field, scroll and highlight stubs. */
function openPane(env, prepare) {
	let { window } = paneDOM();
	let paneScope = vm.createContext({ Zotero: env.Zotero, window, document: window.document, Event: window.Event, setTimeout, clearTimeout });
	vm.runInContext(fs.readFileSync(path.join(ROOT, "content", "preferences.js"), "utf8"), paneScope);
	if (prepare) prepare(window);
	window.ZoteroBridgePrefs.init();
	return window;
}

test("settings pane: presets, switches, 自訂, undo and progressive disclosure from the real markup", async () => {
	let env = await setup();
	let F = env.ZB.features;
	let pluginObservers = env.observerCount();
	let window = openPane(env);
	let doc = window.document;
	let $ = sel => doc.querySelector(sel);
	let hidden = sel => $(sel).hasAttribute("hidden");
	let status = () => $(".zb-preset-status").textContent;

	// One switch per feature, grouped, with a label, a description and the cost/network markers
	let switches = [...doc.querySelectorAll("#zb-features input[type=checkbox]")];
	assert.equal(switches.length, F.FEATURES.length);
	assert.deepEqual([...doc.querySelectorAll(".zb-feature-group h3")].map(h => h.textContent), ["整理與同步", "找文獻", "篩選與評讀", "AI 輔助與寫作"]);
	for (let f of F.FEATURES) {
		let input = $(`#zb-feature-${f.id}`);
		let label = $(`label[for="zb-feature-${f.id}"]`);
		assert.equal(label.textContent, f.label);
		assert.equal(label.getAttribute("data-l10n-id"), f.l10n.name);
		assert.equal($(`#zb-feature-${f.id}-desc`).textContent, f.desc);
		assert.match(input.getAttribute("aria-describedby"), new RegExp(`zb-feature-${f.id}-desc`));
		let row = input.closest(".zb-feature");
		assert.equal(!!row.querySelector(".zb-tag-ai"), !!f.usesAI, f.id);
		assert.equal(!!row.querySelector(".zb-tag-network"), !!f.usesNetwork, f.id);
		assert.equal(input.checked, f.presets.guided, f.id);
	}
	assert.equal($("#zb-preset-guided").checked, true);
	assert.equal($("#zb-preset-advanced").checked, false);
	assert.equal($(".zb-preset-status span").textContent, "目前：研究生引導");
	assert.equal($(".zb-preset-status span").getAttribute("data-l10n-id"), "zotero-bridge-preset-current");
	assert.ok(hidden(".zb-undo"));
	assert.match($("#zb-preset-guided-desc").textContent, /找文獻與寫作留給你自己/);

	// Sections of switched-off features are folded away
	let sectionHidden = feature => doc.querySelector(`[data-zb-feature="${feature}"]`).hasAttribute("hidden");
	assert.equal(sectionHidden("citationChase"), true);
	assert.equal(sectionHidden("pubmedWatch"), true);
	assert.equal(sectionHidden("pubmedWatch searchLinks"), false, "NCBI settings serve the search links too");
	assert.equal(sectionHidden("aiBatch"), true);
	assert.equal(sectionHidden("synthesis"), true);
	assert.equal(sectionHidden("screening"), false);
	let headings = [...doc.getElementsByTagNameNS("http://www.w3.org/1999/xhtml", "h2")];
	let visibleHeadings = () => headings.filter(h => !h.closest("[hidden]")).length;
	let guidedHeadings = visibleHeadings();
	let allHeadings = headings.length;
	assert.ok(guidedHeadings <= allHeadings - 2, `${guidedHeadings} of ${allHeadings}`);
	// Expert options start folded
	let more = [...doc.getElementsByTagNameNS("http://www.w3.org/1999/xhtml", "details")];
	assert.ok(more.length >= 4);
	assert.ok(more.every(d => !d.hasAttribute("open") && d.firstElementChild.localName === "summary"));

	// 進階 turns everything on and offers an undo
	let advanced = $("#zb-preset-advanced");
	advanced.checked = true;
	advanced.dispatchEvent(new window.Event("change"));
	assert.equal(F.currentPreset(), "advanced");
	assert.ok(switches.every(s => s.checked));
	assert.equal(env.prefStore[P + "llm.batchAPI"], true);
	assert.match(status(), /已切換到「進階」。/);
	assert.equal(hidden(".zb-undo"), false);
	assert.equal(visibleHeadings(), allHeadings);
	assert.equal(sectionHidden("citationChase"), false);
	$(".zb-undo").click();
	assert.equal(F.currentPreset(), "guided");
	assert.match(status(), /目前：研究生引導/);
	assert.ok(hidden(".zb-undo"));
	assert.equal(sectionHidden("citationChase"), true);
	assert.equal(doc.activeElement, $("#zb-preset-guided"), "focus back in the preset group");

	// One switch by hand: 自訂, no preset selected, its section shows
	$("#zb-feature-citationChase").click();
	assert.equal(env.prefStore[P + "feature.citationChase"], true);
	assert.equal(F.currentPreset(), "custom");
	assert.equal($("#zb-preset-guided").checked, false);
	assert.equal($("#zb-preset-advanced").checked, false);
	assert.match(status(), /目前：自訂/);
	assert.equal(sectionHidden("citationChase"), false);

	// A switch changed elsewhere (another window, a preset) shows up through the pref observers
	env.Zotero.Prefs.set(P + "feature.citationChase", false);
	assert.equal($("#zb-feature-citationChase").checked, false);
	assert.equal(F.currentPreset(), "guided");
	assert.equal($("#zb-preset-guided").checked, true);

	// Requirements: with the sync off, AI notes (and the batch API) can't work; the switch says why
	$("#zb-feature-sync").click();
	let ai = $("#zb-feature-aiNotes");
	assert.equal(ai.disabled, true);
	assert.equal(ai.checked, true, "its own setting is kept");
	assert.equal($("#zb-feature-aiNotes-req").textContent, "要先打開「同步到 Obsidian／Notion」才會生效。");
	assert.equal($("#zb-feature-aiNotes-req").getAttribute("data-l10n-id"), "zotero-bridge-feature-requires");
	assert.equal(JSON.parse($("#zb-feature-aiNotes-req").getAttribute("data-l10n-args")).req, "sync");
	assert.equal(hidden("#zb-feature-aiNotes-req"), false);
	assert.equal(sectionHidden("sync"), true);
	$("#zb-feature-sync").click();
	assert.equal(ai.disabled, false);
	assert.ok(hidden("#zb-feature-aiNotes-req"));

	// Every pref binding of the old pane is still there (minus the switches that moved to 功能)
	for (let pref of ["llm.provider", "obsidian.vaultPath", "notion.database", "autoSync", "status.tagPrefix", "apaZh.style", "export.autoUpdate",
		"concepts.autoUpdate", "searchLinks.proxyPrefix", "pubmedWatch.email", "pubmedWatch.autoCheck", "citationChase.email", "screening.reasons",
		"llm.batchThreshold", "llm.synthesisPrompt", "usage.prices", "dashboard.autoUpdate", "images.sendToAI"]) {
		assert.ok(doc.querySelector(`[preference="${P}${pref}"]`), pref);
	}
	for (let f of F.FEATURES) assert.equal(doc.querySelector(`[preference="${P}${f.pref}"]`), null, `${f.pref}: only the 功能 switch binds it`);

	// Observers: the pane's own (provider, usage, search sources, one per switch, the pending section) go with the pane root's unload
	assert.equal(env.observerCount() - pluginObservers, 8 + F.FEATURES.length);
	doc.getElementById("zotero-bridge-prefs").dispatchEvent(new window.Event("unload"));
	assert.equal(env.observerCount(), pluginObservers);
	env.Zotero.Prefs.set(P + "feature.synthesis", true);
	assert.deepEqual(env.errors, []);
});

test("settings pane: 劃線顏色與意義 rows edit, reorder and reset the colour meanings; 全文筆記 shows with its switch", async () => {
	let env = await setup();
	let window = openPane(env);
	let doc = window.document;
	let rows = () => [...doc.querySelectorAll("#zb-colors > li")];
	let meanings = () => [...env.ZB.core.colorMeanings(env.prefStore[P + "annotations.colorMeanings"] || "")].map(m => `${m.color} ${m.meaning}`);
	assert.equal(rows().length, 8);
	let first = rows()[0];
	assert.equal(first.querySelector(".zb-color-name").textContent, "黃色");
	assert.equal(first.querySelector(".zb-color-name").getAttribute("data-l10n-id"), "zotero-bridge-color-name");
	assert.equal(first.querySelector("input").value, "重要發現");
	assert.equal(first.querySelector("input").getAttribute("aria-labelledby"), first.querySelector(".zb-color-name").id);
	assert.equal(first.querySelector(".zb-color-swatch").style.backgroundColor, "rgb(255, 212, 0)");
	assert.equal(first.querySelectorAll("button")[0].disabled, true, "the first row can't move up");
	assert.equal(rows()[7].querySelectorAll("button")[1].disabled, true, "the last row can't move down");

	// Rename red, then move it to the top
	let red = rows()[1].querySelector("input");
	red.value = "研究缺口";
	red.dispatchEvent(new window.Event("input"));
	assert.equal(meanings()[1], "#ff6666 研究缺口");
	rows()[1].querySelectorAll("button")[0].click();
	assert.deepEqual(meanings().slice(0, 2), ["#ff6666 研究缺口", "#ffd400 重要發現"]);
	assert.equal(rows()[0].querySelector("input").value, "研究缺口");
	assert.equal(doc.activeElement && doc.activeElement.id, "zb-color-down-0", "focus stays on the moved row (up is disabled at the top)");
	// Restore defaults
	window.ZoteroBridgePrefs.resetColorMeanings();
	assert.equal(env.prefStore[P + "annotations.colorMeanings"], "");
	assert.equal(rows()[0].querySelector("input").value, "重要發現");

	// 全文筆記: on in 研究生引導, its section follows the switch
	let section = doc.querySelector('[data-zb-feature="fullTextMarkdown"]');
	assert.equal(section.hasAttribute("hidden"), false);
	let input = doc.querySelector("#zb-feature-fullTextMarkdown");
	input.checked = false;
	input.dispatchEvent(new window.Event("change"));
	assert.equal(section.hasAttribute("hidden"), true);
	assert.ok(doc.querySelector('[data-l10n-id="zotero-bridge-notion-rename"]'), "the rename button is in the Notion section");
	await vm.runInContext("shutdown()", env.context);
});

// ---------- settings pane: workflow tabs, search and showSection ----------

const HTML_NS = "http://www.w3.org/1999/xhtml";
// The section IDs other code links to (the toolbar's command palette); "sync" is the 同步 tab itself
const SECTION_IDS = ["features", "sync", "obsidian", "notion", "routing", "autosync", "status", "apaZh", "bibliography", "concepts",
	"fulltext", "colors", "classify", "searchLinks", "ncbi", "pubmedWatch", "citationChase", "screening", "ai", "usage"];
const TAB_SECTIONS = {
	features: ["features"],
	sync: ["obsidian", "notion", "routing", "autosync", "status", "apaZh", "bibliography"],
	organize: ["fulltext", "colors", "concepts", "classify"],
	search: ["searchLinks", "ncbi", "pubmedWatch", "citationChase"],
	appraise: ["screening"],
	ai: ["ai", "usage"],
};
const tick = () => new Promise(r => setTimeout(r, 0));

/** The pane with stubs for what jsdom lacks: scrolling, CSS highlights and Zotero's settings search field. */
function openNavPane(env) {
	let scrolled = [];
	let highlights = new Map();
	let window = openPane(env, (w) => {
		w.Element.prototype.scrollIntoView = function (opts) {
			scrolled.push({ node: this, opts });
		};
		w.CSS = { highlights };
		w.Highlight = class {
			constructor(...ranges) {
				this.ranges = ranges;
			}
		};
		let field = w.document.createElementNS(HTML_NS, "input");
		field.id = "prefs-search";
		w.document.documentElement.prepend(field);
	});
	let doc = window.document;
	let $ = sel => doc.querySelector(sel);
	let section = id => $(`[data-zb-section="${id}"]`);
	let panel = tab => $(`#zb-panel-${tab}`);
	let selectedTab = () => $("[role=tab][aria-selected=true]").getAttribute("data-zb-tab");
	let selectedPanels = () => [...doc.querySelectorAll("[role=tabpanel].is-selected")].map(p => p.getAttribute("data-zb-tab"));
	let key = (target, k) => target.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
	let type = (text) => {
		let input = $("#zb-search");
		input.value = text;
		input.dispatchEvent(new window.Event("input"));
	};
	// Sections the search shows: not switched off, not filtered out, in a panel that isn't filtered out
	let found = () => [...doc.querySelectorAll("[data-zb-section]")]
		.filter(s => !s.hasAttribute("hidden") && !s.classList.contains("zb-search-miss") && !s.closest("[role=tabpanel]").classList.contains("zb-search-miss"))
		.map(s => s.getAttribute("data-zb-section"));
	return { window, doc, $, section, panel, selectedTab, selectedPanels, key, type, found, scrolled, highlights };
}

test("settings pane: every section has a known ID in exactly one workflow tab; ARIA tabs work by keyboard and the last tab is remembered", async () => {
	let env = await setup();
	let pluginObservers = env.observerCount();
	let p = openNavPane(env);
	let { doc, $ } = p;

	// Every groupbox is a section with a known, unique ID, in exactly one tab panel
	let groupboxes = [...doc.getElementsByTagNameNS(XUL_NS, "groupbox")];
	assert.equal(groupboxes.length, 19);
	let ids = groupboxes.map(g => g.getAttribute("data-zb-section"));
	assert.deepEqual([...new Set(ids)].length, ids.length, "section IDs are unique");
	for (let g of groupboxes) {
		let id = g.getAttribute("data-zb-section");
		assert.ok(SECTION_IDS.includes(id), `unknown section ID ${id}`);
		let panel = g.closest("[role=tabpanel]");
		assert.ok(panel, `${id} is in no tab`);
		assert.equal(panel.parentNode.closest("[role=tabpanel]"), null, `${id} is in nested tabs`);
		assert.ok(TAB_SECTIONS[panel.getAttribute("data-zb-tab")].includes(id), `${id} is in the ${panel.getAttribute("data-zb-tab")} tab`);
		// Keywords for both searches (ours and Zotero's own), English and Chinese
		let keywords = g.querySelector("[data-search-strings-raw]").getAttribute("data-search-strings-raw");
		assert.match(keywords, /[A-Za-z]/, id);
		assert.match(keywords, /[一-鿿]/, id);
	}
	for (let [tab, sections] of Object.entries(TAB_SECTIONS)) {
		assert.deepEqual([...p.panel(tab).querySelectorAll("[data-zb-section]")].map(s => s.getAttribute("data-zb-section")), sections, tab);
	}
	assert.deepEqual(SECTION_IDS.filter(id => !p.section(id)), ["sync"], "only the 同步 tab ID is not a section");
	assert.deepEqual(window_sections(p), ids);

	// The tablist: 功能 first, ARIA wiring, one tab in the tab order
	let tabs = [...doc.querySelectorAll("[role=tablist] [role=tab]")];
	assert.deepEqual(tabs.map(t => t.textContent), ["功能", "同步", "整理", "找文獻", "篩選與評讀", "AI"]);
	assert.equal($("[role=tablist]").getAttribute("data-l10n-id"), "zotero-bridge-prefs-tabs");
	for (let t of tabs) {
		let panel = doc.getElementById(t.getAttribute("aria-controls"));
		assert.equal(panel.getAttribute("role"), "tabpanel");
		assert.equal(panel.getAttribute("aria-labelledby"), t.id);
		assert.equal(t.getAttribute("data-l10n-id"), `zotero-bridge-prefs-tab-${t.getAttribute("data-zb-tab")}`);
	}
	assert.equal(p.selectedTab(), "features", "a fresh profile opens on 功能");
	assert.deepEqual(p.selectedPanels(), ["features"]);
	assert.deepEqual(tabs.map(t => t.getAttribute("tabindex")), ["0", "-1", "-1", "-1", "-1", "-1"]);
	// Inactive panels are hidden by a class, never [hidden]: Zotero's own settings search skips [hidden] text
	assert.ok([...doc.querySelectorAll("[role=tabpanel]")].every(panel => !panel.hasAttribute("hidden")));

	// Click, then the arrow keys (selection follows focus), Home and End
	$("#zb-tab-sync").click();
	assert.equal(p.selectedTab(), "sync");
	assert.deepEqual(p.selectedPanels(), ["sync"]);
	assert.equal(env.prefStore[P + "prefs.lastTab"], "sync");
	assert.equal(doc.activeElement, $("#zb-tab-sync"));
	p.key($("#zb-tab-sync"), "ArrowRight");
	assert.equal(p.selectedTab(), "organize");
	assert.equal(doc.activeElement, $("#zb-tab-organize"));
	assert.deepEqual(tabs.map(t => t.getAttribute("tabindex")), ["-1", "-1", "0", "-1", "-1", "-1"]);
	p.key(doc.activeElement, "ArrowLeft");
	p.key(doc.activeElement, "ArrowLeft");
	assert.equal(p.selectedTab(), "features");
	p.key(doc.activeElement, "ArrowLeft");
	assert.equal(p.selectedTab(), "ai", "← on the first tab wraps to the last");
	p.key(doc.activeElement, "Home");
	assert.equal(p.selectedTab(), "features");
	p.key(doc.activeElement, "End");
	assert.equal(p.selectedTab(), "ai");
	assert.equal(env.prefStore[P + "prefs.lastTab"], "ai");
	p.key(doc.activeElement, "a");
	assert.equal(p.selectedTab(), "ai", "other keys leave the tabs alone");
	window_unload(p);
	assert.equal(env.observerCount(), pluginObservers, "pref observers left after unload");

	// The next time the pane opens, on the tab chosen last; an unknown tab falls back to 功能
	env.Zotero.Prefs.set(P + "prefs.lastTab", "organize");
	let again = openNavPane(env);
	assert.equal(again.selectedTab(), "organize");
	assert.deepEqual(again.selectedPanels(), ["organize"]);
	window_unload(again);
	env.Zotero.Prefs.set(P + "prefs.lastTab", "gone");
	let fallback = openNavPane(env);
	assert.equal(fallback.selectedTab(), "features");
	window_unload(fallback);
	assert.equal(env.observerCount(), pluginObservers);
	assert.deepEqual(env.errors, []);
});

function window_sections(p) {
	return Array.from(p.window.ZoteroBridgePrefs.sections(), s => s.id);
}

function window_unload(p) {
	p.doc.getElementById("zotero-bridge-prefs").dispatchEvent(new p.window.Event("unload"));
}

test("settings pane: a tab whose features are all off says which and leads to 功能", async () => {
	let env = await setup();
	let F = env.ZB.features;
	let p = openNavPane(env);
	let empty = tab => p.panel(tab).querySelector(".zb-panel-empty");
	// 研究生引導: every tab has something (AI 文獻筆記 is on)
	for (let tab of Object.keys(TAB_SECTIONS)) assert.equal(empty(tab).hasAttribute("hidden"), true, tab);
	F.setEnabled("aiNotes", false);
	let box = empty("ai");
	assert.equal(box.hasAttribute("hidden"), false);
	assert.equal(box.getAttribute("no-highlight"), "true");
	let text = box.querySelector("p");
	assert.equal(text.getAttribute("data-l10n-id"), "zotero-bridge-prefs-tab-empty");
	assert.match(text.textContent, /^這一頁的功能都關著：AI 文獻筆記、批次 API、文獻比較表、文獻探討草稿、實證報告草稿、進度報告、概念卡片 AI 綜整。/);
	assert.equal(JSON.parse(text.getAttribute("data-l10n-args")).features.split("、")[0], "AI 文獻筆記");
	p.window.ZoteroBridgePrefs.selectTab("ai");
	let go = box.querySelector("button");
	assert.equal(go.textContent, "前往「功能」");
	go.click();
	assert.equal(p.selectedTab(), "features");
	assert.equal(p.doc.activeElement, p.$("#zb-tab-features"));
	F.setEnabled("synthesis", true);
	assert.equal(box.hasAttribute("hidden"), true, "one AI feature on: the tab shows its settings again");
	window_unload(p);
	assert.deepEqual(env.errors, []);
});

test("settings pane: showSection opens a section's tab, scrolls to it, highlights and focuses it; a switched-off one leads to its switch", async () => {
	let env = await setup();
	let F = env.ZB.features;
	let p = openNavPane(env);
	let { doc, $ } = p;
	let api = p.window.ZoteroBridgePrefs;

	assert.equal(api.showSection("notion"), true);
	assert.equal(p.selectedTab(), "sync");
	assert.equal(p.scrolled.at(-1).node, p.section("notion"));
	assert.equal(p.scrolled.at(-1).opts.block, "start");
	assert.ok(p.section("notion").classList.contains("zb-flash"));
	let heading = p.section("notion").getElementsByTagNameNS(HTML_NS, "h2")[0];
	assert.equal(doc.activeElement, heading, "focus on the section's heading");
	assert.equal(heading.getAttribute("tabindex"), "-1");
	assert.equal(env.prefStore[P + "prefs.lastTab"], "sync");
	// The next one takes the highlight
	api.showSection("classify");
	assert.equal(p.selectedTab(), "organize");
	assert.ok(p.section("classify").classList.contains("zb-flash"));
	assert.ok(!p.section("notion").classList.contains("zb-flash"));
	// A tab ID opens the tab; unknown IDs do nothing
	assert.equal(api.showSection("sync"), true);
	assert.equal(p.selectedTab(), "sync");
	assert.equal(doc.activeElement, $("#zb-tab-sync"));
	assert.equal(api.showSection("nope"), false);
	assert.equal(p.selectedTab(), "sync");

	// 引文追蹤 is off in 研究生引導: 功能, its switch highlighted and focused, one line on where its settings go
	assert.equal(p.section("citationChase").hasAttribute("hidden"), true);
	assert.equal(api.showSection("citationChase"), true);
	assert.equal(p.selectedTab(), "features");
	let row = $('.zb-feature[data-feature="citationChase"]');
	let input = $("#zb-feature-citationChase");
	assert.ok(row.classList.contains("zb-flash"));
	assert.equal(p.scrolled.at(-1).node, row);
	assert.equal(doc.activeElement, input);
	let note = $("#zb-section-notice");
	assert.ok(row.contains(note));
	assert.equal(note.querySelector("span").textContent, "「引文追蹤（OpenAlex）」的設定在「找文獻」分頁，打開這個功能後才會出現。");
	assert.equal(note.querySelector("span").getAttribute("data-l10n-id"), "zotero-bridge-prefs-section-off");
	assert.deepEqual(JSON.parse(note.querySelector("span").getAttribute("data-l10n-args")), { section: "引文追蹤（OpenAlex）", tab: "找文獻" });
	assert.match(input.getAttribute("aria-describedby"), /zb-section-notice/);
	let go = note.querySelector("button");
	assert.equal(go.hasAttribute("hidden"), true, "no way there until the feature is on");
	// Turning it on: the line says so and offers the way to its settings
	input.click();
	assert.equal(F.rawValue("citationChase"), true);
	assert.equal(note.querySelector("span").textContent, "已打開。「引文追蹤（OpenAlex）」的設定在「找文獻」分頁。");
	assert.equal(go.hasAttribute("hidden"), false);
	assert.equal(go.textContent, "前往設定");
	go.click();
	assert.equal(p.selectedTab(), "search");
	assert.ok(p.section("citationChase").classList.contains("zb-flash"));
	assert.equal($("#zb-section-notice"), null, "the line goes once it was used");
	assert.equal(input.getAttribute("aria-describedby"), "zb-feature-citationChase-desc zb-feature-citationChase-req");

	// 全文筆記 is on but needs the sync: the sync switch is the one to turn on
	F.setEnabled("sync", false);
	assert.equal(p.section("fulltext").hasAttribute("hidden"), true);
	api.showSection("fulltext");
	assert.equal(doc.activeElement, $("#zb-feature-sync"));
	assert.ok($('.zb-feature[data-feature="sync"]').classList.contains("zb-flash"));
	assert.match($("#zb-section-notice span").textContent, /「全文筆記」的設定在「整理」分頁/);
	// …and a section with several features points at the first that is off
	F.setEnabled("sync", true);
	F.setEnabled("aiNotes", false);
	api.showSection("usage");
	assert.equal(doc.activeElement, $("#zb-feature-aiNotes"));
	assert.equal(doc.querySelectorAll("#zb-section-notice").length, 1, "one line at a time");
	window_unload(p);
	assert.deepEqual(env.errors, []);
});

test("settings pane: prefs.pendingSection opens a section once the pane is on screen, then clears", async () => {
	let env = await setup();
	// Asked for before the pane loaded
	env.Zotero.Prefs.set(P + "prefs.pendingSection", "screening");
	let p = openNavPane(env);
	await tick();
	assert.equal(p.selectedTab(), "appraise");
	assert.ok(p.section("screening").classList.contains("zb-flash"));
	assert.equal(env.prefStore[P + "prefs.pendingSection"], "");
	// Asked for while the pane is open
	env.Zotero.Prefs.set(P + "prefs.pendingSection", "bibliography");
	await tick();
	assert.equal(p.selectedTab(), "sync");
	assert.equal(env.prefStore[P + "prefs.pendingSection"], "");
	// While Zotero shows another pane, ours is in a hidden container: it waits for "showing"
	let root = p.$("#zotero-bridge-prefs");
	root.parentNode.setAttribute("hidden", "true");
	env.Zotero.Prefs.set(P + "prefs.pendingSection", "ncbi");
	await tick();
	assert.equal(p.selectedTab(), "sync");
	assert.equal(env.prefStore[P + "prefs.pendingSection"], "ncbi");
	root.parentNode.removeAttribute("hidden");
	root.dispatchEvent(new p.window.Event("showing"));
	await tick();
	assert.equal(p.selectedTab(), "search");
	assert.equal(env.prefStore[P + "prefs.pendingSection"], "");
	window_unload(p);
	// After unload the observer is gone: nothing happens, nothing throws
	env.Zotero.Prefs.set(P + "prefs.pendingSection", "ai");
	await tick();
	assert.equal(env.prefStore[P + "prefs.pendingSection"], "ai");
	assert.deepEqual(env.errors, []);
});

test("settings pane: search filters every tab in Chinese and English, highlights matches, and Esc brings the tabs back", async () => {
	let env = await setup();
	let F = env.ZB.features;
	let p = openNavPane(env);
	let { doc, $ } = p;
	let root = $("#zotero-bridge-prefs");
	let status = $("#zb-search-status");
	assert.equal(status.getAttribute("role"), "status");
	assert.equal($("#zb-search").getAttribute("type"), "search");
	assert.equal($(`[for="zb-search"]`).textContent, "找設定");
	assert.equal($(".zb-nav").getAttribute("no-highlight"), "true", "Zotero's own search skips our search box and tabs");
	assert.equal(p.selectedTab(), "features");

	// English, any case or width, finds sections in other tabs
	p.type("Notion");
	assert.ok(root.classList.contains("zb-searching"));
	let notion = p.found();
	assert.ok(notion.includes("notion") && notion.includes("fulltext") && notion.includes("features"), notion.join(", "));
	assert.ok(!notion.includes("concepts") && !notion.includes("usage"), notion.join(", "));
	assert.equal(p.panel("sync").classList.contains("zb-search-miss"), false);
	assert.equal(p.section("ncbi").classList.contains("zb-search-miss"), true);
	assert.equal(status.textContent, `找到 ${notion.length} 個設定區塊。按 Esc 回到分頁。`);
	assert.equal(status.getAttribute("data-l10n-id"), "zotero-bridge-prefs-search-found");
	// Each text match is a CSS highlight range over exactly the matched words
	let ranges = p.highlights.get("zb-search").ranges;
	assert.ok(ranges.length >= 5);
	assert.ok(ranges.every(r => r.toString().toLowerCase() === "notion"), ranges.map(r => r.toString()).join("|"));
	assert.ok(ranges.some(r => p.section("notion").contains(r.startContainer)));
	p.type("ｎｏｔｉｏｎ");
	assert.deepEqual(p.found(), notion, "full-width and lower case find the same");
	assert.equal(p.selectedTab(), "features", "searching doesn't change the tab");

	// Chinese
	p.type("分類");
	let classify = p.found();
	assert.ok(classify.includes("classify") && classify.includes("routing"), classify.join(", "));
	assert.ok(!classify.includes("autosync") && !classify.includes("usage"), classify.join(", "));
	// Several words: every one must be in the section
	p.type("PubMed email");
	assert.ok(p.found().includes("ncbi"));
	assert.ok(!p.found().includes("obsidian"));
	// A label kept in an attribute (XUL checkbox): the element is marked
	p.type("bibtex");
	assert.deepEqual(p.found(), ["features", "bibliography"]);
	let checkbox = [...p.section("bibliography").getElementsByTagNameNS(XUL_NS, "checkbox")].find(c => /BibTeX/.test(c.getAttribute("label")));
	assert.ok(checkbox.classList.contains("zb-hit"));
	// English keywords only: the section shows without a highlight
	p.type("deduplication");
	assert.deepEqual(p.found(), ["screening"]);
	// A match inside folded options opens them for the search, and Esc folds them again
	p.type("不套用代理");
	assert.deepEqual(p.found(), ["searchLinks"]);
	let details = p.section("searchLinks").getElementsByTagNameNS(HTML_NS, "details")[0];
	assert.equal(details.open, true);
	// Nothing
	p.type("zzzz");
	assert.deepEqual(p.found(), []);
	assert.equal(status.textContent, "沒有符合「zzzz」的設定。換個說法試試，例如英文名稱：Notion、PubMed、API key。");
	assert.equal(status.getAttribute("data-l10n-id"), "zotero-bridge-prefs-search-none");
	assert.equal($("#zb-search-off").hasAttribute("hidden"), true);

	// A match in a switched-off feature: named, and a button to its switch
	p.type("snowballing");
	assert.deepEqual(p.found(), []);
	let off = $("#zb-search-off");
	assert.equal(off.hasAttribute("hidden"), false);
	assert.equal(off.querySelector("span").textContent, "關著的功能裡也有：");
	assert.deepEqual([...off.querySelectorAll("button")].map(b => b.textContent), ["引文追蹤（OpenAlex）"]);
	// The switch turned on elsewhere: the open search updates
	F.setEnabled("citationChase", true);
	assert.deepEqual(p.found(), ["citationChase"]);
	F.setEnabled("citationChase", false);
	off.querySelector("button").click();
	assert.equal($("#zb-search").value, "", "following a result ends the search");
	assert.ok(!root.classList.contains("zb-searching"));
	assert.equal(p.selectedTab(), "features");
	assert.equal(doc.activeElement, $("#zb-feature-citationChase"));

	// Esc: back to the tab that was open, nothing left marked
	$("#zb-tab-organize").click();
	p.type("不套用代理");
	assert.equal(details.open, true);
	p.type("bibtex");
	let esc = new p.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
	$("#zb-search").dispatchEvent(esc);
	assert.equal(esc.defaultPrevented, true);
	assert.equal($("#zb-search").value, "");
	assert.ok(!root.classList.contains("zb-searching"));
	assert.equal(p.selectedTab(), "organize");
	assert.deepEqual(p.selectedPanels(), ["organize"]);
	assert.equal(doc.querySelectorAll(".zb-search-miss, .zb-hit").length, 0);
	assert.equal(details.open, false, "options the search unfolded are folded again");
	assert.equal(p.highlights.has("zb-search"), false);
	assert.equal(status.textContent, "");
	assert.equal(status.hasAttribute("data-l10n-id"), false);
	// Esc in an empty box is left to the window
	let esc2 = new p.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
	$("#zb-search").dispatchEvent(esc2);
	assert.equal(esc2.defaultPrevented, false);
	// Clearing the box by hand is the same as Esc; the API does the same
	p.type("notion");
	p.type("");
	assert.ok(!root.classList.contains("zb-searching"));
	p.window.ZoteroBridgePrefs.search("分類");
	assert.ok(p.found().includes("classify"));
	p.window.ZoteroBridgePrefs.search("");
	assert.equal(doc.querySelectorAll(".zb-search-miss").length, 0);
	window_unload(p);
	assert.deepEqual(env.errors, []);
});

test("settings pane: while Zotero's own settings search has text, every tab shows and ours steps aside", async () => {
	let env = await setup();
	let p = openNavPane(env);
	let { $ } = p;
	let root = $("#zotero-bridge-prefs");
	let field = $("#prefs-search");
	let removed = [];
	let remove = field.removeEventListener.bind(field);
	field.removeEventListener = (type, fn, opts) => {
		removed.push(type);
		return remove(type, fn, opts);
	};
	p.type("notion");
	// Zotero's search field fires "command" after typing
	field.value = "notion";
	field.dispatchEvent(new p.window.Event("command"));
	assert.ok(root.classList.contains("zb-global-search"));
	assert.ok(!root.classList.contains("zb-searching"), "our own search ends");
	assert.equal($("#zb-search").value, "");
	assert.equal(p.doc.querySelectorAll(".zb-search-miss").length, 0);
	// Zotero's search walks the text and skips [hidden]: text in tabs that aren't selected must not be hidden by us
	let heading = p.section("classify").getElementsByTagNameNS(HTML_NS, "h2")[0];
	assert.equal(heading.closest("[hidden]"), null);
	assert.equal(p.selectedTab(), "features");
	field.value = "";
	field.dispatchEvent(new p.window.Event("command"));
	assert.ok(!root.classList.contains("zb-global-search"));
	// Zotero clears the field without an event when another pane is chosen, and sends "showing" when ours comes back
	field.value = "PubMed";
	root.dispatchEvent(new p.window.Event("showing"));
	assert.ok(root.classList.contains("zb-global-search"));
	field.value = "";
	root.dispatchEvent(new p.window.Event("showing"));
	assert.ok(!root.classList.contains("zb-global-search"));
	window_unload(p);
	assert.deepEqual(removed.sort(), ["command", "input"], "the listeners on Zotero's field go with the pane");
	assert.deepEqual(env.errors, []);
});
