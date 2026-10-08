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
function menuEntry(env, l10nID) {
	let found = null;
	let walk = (list) => {
		for (let m of list || []) {
			if (found) return;
			if (m.l10nID === l10nID) found = m;
			else walk(m.menus);
		}
	};
	for (let o of env.menus) walk(o.menus);
	assert.ok(found, `no menu entry ${l10nID}`);
	return found;
}

function visible(menu, context = {}) {
	let v = null;
	menu.onShowing({}, Object.assign({ items: [], collectionTreeRows: [], setVisible: (x) => { v = x; }, setL10nArgs() {} }, context));
	return v;
}

const GATED_IN_GUIDED = {
	"zotero-bridge-menu-synthesis": "synthesis",
	"zotero-bridge-menu-review-draft": "reviewDraft",
	"zotero-bridge-menu-ebhc-report": "ebhcReport",
	"zotero-bridge-menu-pubmed-watch": "pubmedWatch",
	"zotero-bridge-chase-items": "citationChase",
	"zotero-bridge-chase-tools-included": "citationChase",
	"zotero-bridge-menu-progress-report": "progressReport",
	"zotero-bridge-menu-concepts-ai": "conceptsAI",
};

test("a fresh profile starts in 研究生引導: the gated menus hide, and come back with 進階 without a restart", async () => {
	let env = await setup();
	let F = env.ZB.features;
	assert.equal(env.prefStore[P + "features.version"], 1, "the migration ran once at startup");
	assert.equal(F.currentPreset(), "guided");
	let registered = env.menus.map(o => o.menuID);
	for (let [id, feature] of Object.entries(GATED_IN_GUIDED)) {
		assert.equal(visible(menuEntry(env, id)), false, `${id} (${feature}) in guided`);
	}
	for (let id of ["zotero-bridge-menu-sync", "zotero-bridge-menu-regenerate", "zotero-bridge-search-tools", "zotero-bridge-screen-tools-dedup",
		"zotero-bridge-menu-dashboard", "zotero-bridge-menu-concepts-update", "zotero-bridge-menu-export-library", "zotero-bridge-appraisal-tools-summary",
		"zotero-bridge-menu-status"]) {
		assert.equal(visible(menuEntry(env, id)), true, `${id} in guided`);
	}
	// The item submenu shows (sync is on); the separator before the AI writing entries does not
	let itemMenu = env.menus.find(o => o.menuID === "zotero-bridge-item").menus[0];
	assert.equal(visible(itemMenu), true);
	let separator = itemMenu.menus.find(m => m.menuType === "separator" && m.onShowing && !m.l10nID && itemMenu.menus.indexOf(m) > 5);
	assert.equal(visible(separator), false);

	F.applyPreset("advanced");
	for (let id of Object.keys(GATED_IN_GUIDED)) assert.equal(visible(menuEntry(env, id)), true, `${id} in advanced`);
	assert.equal(visible(separator), true);
	// An entry's own condition still applies: the collection submenu needs a selected collection
	let collMenu = env.menus.find(o => o.menuID === "zotero-bridge-collection").menus[0];
	assert.equal(visible(collMenu), false);
	assert.equal(visible(collMenu, { collectionTreeRows: [{ isCollection: () => true, ref: {} }] }), true);
	let chaseColl = menuEntry(env, "zotero-bridge-chase-collection-menu");
	assert.equal(visible(chaseColl), false, "no collection selected");

	// Everything the item and collection submenus offer switched off: the submenu itself hides
	F.applyPreset("guided");
	F.setEnabled("sync", false);
	assert.equal(visible(itemMenu), false);
	assert.equal(visible(collMenu, { collectionTreeRows: [{ isCollection: () => true, ref: {} }] }), false);
	assert.equal(visible(menuEntry(env, "zotero-bridge-menu-regenerate")), false, "AI notes need the sync");
	F.setEnabled("synthesis", true);
	assert.equal(visible(itemMenu), true);
	assert.equal(visible(separator), false, "no sync entries above it");
	// Registration never changed
	assert.deepEqual(env.menus.map(o => o.menuID), registered);
	assert.deepEqual(env.errors, []);
});

test("an install used before the switches keeps everything: migrated to 進階 for the new switches, once", async () => {
	let vault = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-features-"));
	let env = await setup({ [P + "obsidian.vaultPath"]: vault, [P + "llm.batchAPI"]: true });
	let F = env.ZB.features;
	assert.equal(F.currentPreset(), "advanced");
	for (let id of Object.keys(GATED_IN_GUIDED)) assert.equal(visible(menuEntry(env, id)), true, id);
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
	for (let text of env.descriptions) assert.match(text, /目前關閉。要使用的話：設定 → Zotero Bridge → 功能，把它打開。/);

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
	note.noteHTML = "<h1>🤖 AI 文獻筆記</h1><p><em>由 m 於 2026-10-01T00:00:00Z 產生（Zotero Bridge）</em></p><h2>一句話摘要</h2><p>衛教降低跌倒。</p>";
	item.children.push(note.id);
	let doc = new JSDOM("<div id=b></div>").window.document;
	let body = doc.getElementById("b");
	let summary = null;
	let render = (it = item) => env.panes[0].onRender({ doc, body, item: it, setSectionSummary: (s) => { summary = s; } });

	render();
	assert.ok(body.querySelector("section[data-zb-pane=tools]"), "tool rows grouped above the note");
	assert.ok(body.querySelector("[data-zb-appraisal]"));
	assert.match(body.textContent, /閱讀狀態：/);
	assert.match(body.textContent, /衛教降低跌倒。/);
	assert.deepEqual([...body.querySelectorAll("button")].map(b => b.textContent).filter(t => /同步|重新/.test(t)), ["同步到 Notion + Obsidian", "重新產生"]);

	F.setEnabled("appraisalForm", false);
	F.setEnabled("status", false);
	F.setEnabled("searchLinks", false);
	F.setEnabled("screening", false);
	F.setEnabled("aiNotes", false);
	render();
	assert.equal(body.querySelector("[data-zb-appraisal]"), null);
	assert.equal(body.querySelector("section[data-zb-pane=tools]"), null, "no empty tools block");
	assert.doesNotMatch(body.textContent, /閱讀狀態：/);
	assert.match(body.textContent, /衛教降低跌倒。/, "an existing AI note is still shown");
	assert.deepEqual([...body.querySelectorAll("button")].map(b => b.textContent), ["同步到 Notion + Obsidian"]);

	let fresh = new env.MockItem("journalArticle", { title: "New" });
	render(fresh);
	assert.equal(summary, "AI 筆記已關閉");
	assert.match(body.textContent, /AI 文獻筆記目前關閉/);
	assert.deepEqual([...body.querySelectorAll("button")].map(b => b.textContent), ["同步到 Notion + Obsidian"]);
	F.setEnabled("sync", false);
	render(fresh);
	assert.equal(body.querySelectorAll("button").length, 0);
	F.setEnabled("sync", true);
	F.setEnabled("aiNotes", true);
	render(fresh);
	assert.equal(summary, "尚未產生");
	assert.deepEqual([...body.querySelectorAll("button")].map(b => b.textContent), ["產生 AI 筆記並同步"]);
	assert.deepEqual(env.errors, []);
});

// ---------- settings pane ----------

const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

/** The real preferences.xhtml, wrapped the way Zotero parses a plugin pane (XUL default namespace). */
function paneDOM() {
	let xhtml = fs.readFileSync(path.join(ROOT, "content", "preferences.xhtml"), "utf8");
	return new JSDOM(`<box xmlns="${XUL_NS}" xmlns:html="http://www.w3.org/1999/xhtml">${xhtml}</box>`, { contentType: "application/xml" });
}

function openPane(env) {
	let { window } = paneDOM();
	let paneScope = vm.createContext({ Zotero: env.Zotero, window, document: window.document, Event: window.Event, setTimeout, clearTimeout });
	vm.runInContext(fs.readFileSync(path.join(ROOT, "content", "preferences.js"), "utf8"), paneScope);
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

	// Observers: the pane's own (provider, usage, search sources, one per switch) go with the pane root's unload
	assert.equal(env.observerCount() - pluginObservers, 7 + F.FEATURES.length);
	doc.getElementById("zotero-bridge-prefs").dispatchEvent(new window.Event("unload"));
	assert.equal(env.observerCount(), pluginObservers);
	env.Zotero.Prefs.set(P + "feature.synthesis", true);
	assert.deepEqual(env.errors, []);
});
