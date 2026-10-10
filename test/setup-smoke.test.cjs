// 設定精靈, the first-run setup wizard (content/setup.js), through the real plugin in a mocked Zotero with
// jsdom windows: when it opens by itself (fresh install, upgrade with a configured profile, already
// done), each step writing its settings only when confirmed (preset, Obsidian vault, Notion token in the
// login manager, AI key in the login manager), the skip paths writing nothing, setup.done on finish and on
// close, 試一次 through the catalog's sync-no-ai command, the command in the catalog, the toolbar menu,
// 快速指令 and the settings pane, and a shutdown that closes the window and leaves nothing behind.
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
const DONE = P + "setup.done";
const CLAUDE_KEY = "sk-ant-api03-e2eTESTkey_0123456789abcdef";
const NOTION_TOKEN = "ntn_smoke_token_0123456789";
const NOTION_DB = "https://www.notion.so/me/Literature-0123456789abcdef0123456789abcdef?v=1";

const MAIN_WINDOW = `<!DOCTYPE html><html><body>
<toolbar id="zotero-toolbar-item-tree">
	<hbox id="zotero-items-toolbar">
		<toolbarbutton id="zotero-tb-note-add" class="zotero-tb-button" tabindex="-1" type="menu"></toolbarbutton>
		<input id="zotero-tb-search">
	</hbox>
</toolbar>
</body></html>`;

const XUL_FILES = {
	"chrome://zotero-bridge/content/setup.xhtml": "setup.xhtml",
	"chrome://zotero-bridge/content/palette.xhtml": "palette.xhtml",
};

/**
 * files: path → "directory" | "regular" (IOUtils.stat); logins: the login manager's entries;
 * prefs: initial prefs (full names).
 */
function makeEnv({ prefs = {}, files = {}, logins = [] } = {}) {
	let items = new Map();
	let nextID = 100;
	let descriptions = [];
	let errors = [];
	let debug = [];
	let prefsOpened = [];
	let dialogs = [];
	let launched = [];
	let selection = { items: [], sorted: [] };

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
	let dom = new JSDOM(MAIN_WINDOW);
	let win = dom.window;
	win.document.createXULElement = tag => win.document.createElement(tag);
	win.MozXULElement = { insertFTLIfNeeded: () => {} };
	win.ZoteroPane = {
		getSelectedItems: () => selection.items,
		getSelectedCollections: () => [],
		getSortedItems: () => selection.sorted,
		getSelectedLibraryID: () => 1,
	};
	win.openDialog = (url, name, features) => {
		assert.ok(XUL_FILES[url], `unexpected window ${url}`);
		assert.match(features, /chrome/);
		let d = new JSDOM(fs.readFileSync(path.join(ROOT, "content", XUL_FILES[url]), "utf8"), { contentType: "application/xml" });
		let closed = false;
		d.window.close = () => {
			closed = true;
		};
		Object.defineProperty(d.window, "closed", { get: () => closed });
		d.window.focus = () => {};
		d.window.zbName = name;
		d.window.zbURL = url;
		dialogs.push(d.window);
		return d.window;
	};

	let Zotero = {
		isMac: false,
		Prefs: {
			get: k => prefStore[k],
			set: (k, v) => {
				prefStore[k] = v;
			},
			clear: (k) => {
				delete prefStore[k];
			},
			registerObserver: () => Symbol("o"),
			unregisterObserver: () => {},
		},
		MenuManager: { registerMenu: o => o.menuID, unregisterMenu: () => true },
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
			getAll: async () => [...items.values()],
		},
		Libraries: { userLibraryID: 1, get: () => ({ libraryType: "user", name: "My Library" }), getAll: () => [] },
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
		launchURL: (url) => { launched.push(url); },
		logError: (e) => { errors.push(e); },
		debug: (t) => { debug.push(String(t)); },
	};
	Zotero.Item = MockItem;

	let context = vm.createContext({
		Zotero, console, TextDecoder, TextEncoder, setTimeout, clearTimeout,
		IOUtils: {
			exists: async p => p in files,
			stat: async (p) => {
				if (!(p in files)) throw new Error(`NotFoundError: ${p}`);
				return { type: files[p], path: p };
			},
		},
		PathUtils: { join: (...parts) => path.posix.join(...parts), filename: p => path.basename(p) },
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
		Services: {
			scriptloader: {
				loadSubScript: (url) => {
					let file = url.replace("file://", "");
					vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
				},
			},
			prompt: { confirm: () => true },
			prefs: { prefHasUserValue: k => k in prefStore },
			// An in-memory login manager, so secrets.js stores and finds what the wizard saves
			logins: {
				searchLoginsAsync: async ({ origin, httpRealm }) => logins.filter(l => l.origin === origin && l.httpRealm === httpRealm),
				addLoginAsync: async (l) => {
					logins.push(l);
					return l;
				},
				modifyLoginAsync: async (old, l) => {
					logins.splice(logins.indexOf(old), 1, l);
				},
				removeLoginAsync: async (l) => {
					logins.splice(logins.indexOf(l), 1);
				},
			},
		},
	});
	vm.runInContext(fs.readFileSync(path.join(ROOT, "bootstrap.js"), "utf8"), context, { filename: "bootstrap.js" });
	return { context, Zotero, MockItem, prefStore, descriptions, errors, debug, prefsOpened, dialogs, launched, selection, win, logins, files };
}

async function setup(opts = {}) {
	let env = makeEnv(opts);
	let reason = opts.reason === undefined ? "" : `, ${opts.reason}`;
	await vm.runInContext(`startup({ id: ${JSON.stringify(PLUGIN_ID)}, version: "0.0.0", rootURI: ${JSON.stringify(ROOT_URI)} }${reason})`, env.context);
	env.ZB = env.context.ZB;
	return env;
}

const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(fn, what, ms = 3000) {
	let end = Date.now() + ms;
	while (Date.now() < end) {
		let v = fn();
		if (v) return v;
		await tick(10);
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** Open the wizard as the command does; resolves with the dialog, its view and document. */
async function openWizard(env) {
	let view = null;
	let dialog = await env.ZB.setup.open(env.win, { onOpen: (w, v) => { view = v; } });
	assert.ok(dialog, "the wizard opened");
	await view.ready();
	return { dialog, view, doc: dialog.document };
}

function choose(doc, id) {
	let radio = doc.getElementById(id);
	assert.ok(radio, `no ${id}`);
	radio.checked = true;
	radio.dispatchEvent(new doc.defaultView.Event("change"));
}

function type(doc, id, value) {
	let input = doc.getElementById(id);
	assert.ok(input, `no ${id}`);
	input.value = value;
	input.dispatchEvent(new doc.defaultView.Event("input"));
	input.dispatchEvent(new doc.defaultView.Event("change"));
}

/** Prefs that hold a value like this (secrets must never be among them). */
function prefsHolding(env, text) {
	return Object.entries(env.prefStore).filter(([, v]) => String(v).includes(text)).map(([k]) => k);
}

function stored(env, name) {
	return env.logins.filter(l => l.username === name).map(l => l.password);
}

function ftl(lang) {
	return fs.readFileSync(path.join(ROOT, "locale", lang, "zotero-bridge.ftl"), "utf8");
}

function ftlText(text, id) {
	let m = new RegExp(`^${id} =\\n {4}\\.label = (.+)$`, "m").exec(text) || new RegExp(`^${id} = (.+)$`, "m").exec(text);
	return m ? m[1] : null;
}

// ---------- when it opens by itself ----------

test("decide(): fresh install opens; configured profiles are marked done silently; done or no reason never opens", async () => {
	let env = await setup();
	let S = env.ZB.setup;
	assert.equal(S.ADDON_INSTALL, 5);
	assert.equal(S.decide({ reason: 5, done: false, evidence: [] }), "open");
	// An earlier install that never set anything up (APP_STARTUP, ADDON_UPGRADE)
	assert.equal(S.decide({ reason: 1, done: false, evidence: [] }), "open");
	assert.equal(S.decide({ reason: 7, done: false, evidence: [] }), "open");
	// Upgrade (or reinstall) of a configured profile: never pops up
	assert.equal(S.decide({ reason: 7, done: false, evidence: ["obsidian.vaultPath"] }), "mark-done");
	assert.equal(S.decide({ reason: 5, done: false, evidence: ["anthropicKey"] }), "mark-done");
	assert.equal(S.decide({ reason: 5, done: true, evidence: [] }), "skip");
	assert.equal(S.decide({ reason: undefined, done: false, evidence: [] }), "skip");
	assert.deepEqual(env.errors, []);
});

test("auto-open: a fresh install opens the wizard once, after the main window is ready", async () => {
	let ready;
	let env = makeEnv();
	env.Zotero.uiReadyPromise = new Promise((resolve) => {
		ready = resolve;
	});
	await vm.runInContext(`startup({ id: ${JSON.stringify(PLUGIN_ID)}, version: "0.0.0", rootURI: ${JSON.stringify(ROOT_URI)} }, 5)`, env.context);
	await tick(50);
	assert.equal(env.dialogs.length, 0, "nothing before the main window is ready");
	ready();
	// AUTO_OPEN_DELAY_MS after uiReadyPromise
	await waitFor(() => env.dialogs.length, "the wizard to open", 4000);
	let dialog = env.dialogs[0];
	assert.equal(dialog.zbURL, "chrome://zotero-bridge/content/setup.xhtml");
	assert.match(dialog.zbName, /^zotero-bridge-setup-\d+$/);
	await waitFor(() => dialog.document.querySelector(".zb-su-step"), "the first step");
	assert.equal(dialog.document.querySelector(".zb-su-step").getAttribute("data-zb-step"), "welcome");
	// Only once per session: another init does not open a second window
	await env.context.ZB.setup.init({ reason: 5, delayMs: 0 });
	assert.equal(env.dialogs.length, 1);
	assert.equal(env.prefStore[DONE], undefined, "opening alone does not mark it done");
	assert.deepEqual(env.errors, []);
	env.context.ZB.setup.close();
	assert.equal(env.prefStore[DONE], true);
});

test("auto-open: an upgrade with a configured profile never sees it and is marked done; done or no reason opens nothing", async () => {
	// A vault (features.js PRIOR_USE)
	let vault = await setup({ prefs: { [P + "obsidian.vaultPath"]: "/vault" } });
	await vault.ZB.setup.init({ reason: 7, delayMs: 0 });
	assert.equal(vault.dialogs.length, 0);
	assert.equal(vault.prefStore[DONE], true, "set silently");
	assert.ok(vault.debug.some(t => /setup wizard mark-done; configured: obsidian\.vaultPath/.test(t)));
	// Only a stored key (the login manager)
	let keyed = await setup({ logins: [{ origin: "chrome://zotero-bridge", httpRealm: "Zotero Bridge", username: "anthropicKey", password: CLAUDE_KEY }] });
	await keyed.ZB.setup.init({ reason: 5, delayMs: 0 });
	assert.equal(keyed.dialogs.length, 0);
	assert.equal(keyed.prefStore[DONE], true);
	assert.ok(!keyed.debug.some(t => t.includes(CLAUDE_KEY)), "the key is never in the debug output");
	// Already done: nothing opens, nothing is written
	let done = await setup({ prefs: { [DONE]: true } });
	let before = JSON.stringify(done.prefStore);
	await done.ZB.setup.init({ reason: 5, delayMs: 0 });
	assert.equal(done.dialogs.length, 0);
	assert.equal(JSON.stringify(done.prefStore), before);
	// Started without a reason (loaded by hand): never on its own
	let bare = await setup();
	assert.equal(await bare.ZB.setup.init({ delayMs: 0 }), null);
	await tick(30);
	assert.equal(bare.dialogs.length, 0);
	assert.equal(bare.prefStore[DONE], undefined);
	// The default is declared with the others
	assert.match(fs.readFileSync(path.join(ROOT, "prefs.js"), "utf8"), /^pref\("extensions\.zotero-bridge\.setup\.done", false\);$/m);
	assert.deepEqual([...vault.errors, ...keyed.errors, ...done.errors, ...bare.errors], []);
});

// ---------- the steps ----------

test("the whole way: 進階, Obsidian vault, Claude key, 試一次 with sync-no-ai, 完成 marks it done and closes", async () => {
	let env = await setup({ files: { "/home/me/Vault": "directory", "/home/me/Vault/.obsidian": "directory" } });
	let paper = new env.MockItem("journalArticle", { title: "Exercise and falls" });
	env.selection.items = [paper];
	let runs = [];
	env.ZB.main.run = (items, action) => {
		runs.push([items.map(i => i.id), action]);
		return Promise.resolve();
	};
	env.ZB.main.literatureNote = async item => (item === paper ? { path: "/home/me/Vault/Zotero/lee2021exercise.md", relPath: "Zotero/lee2021exercise.md" } : null);
	env.ZB.main.noteLinks = async () => ({ obsidian: "obsidian://open?vault=Vault&file=Zotero%2Flee2021exercise", notion: "", found: true, vault: true });
	let { dialog, view, doc } = await openWizard(env);
	let $ = id => doc.getElementById(id);

	// 1 歡迎: title, the step list, no 上一步／略過
	assert.equal(doc.documentElement.getAttribute("title"), "ZotMax 設定精靈");
	assert.equal(doc.querySelector(".zb-su-count").textContent, "第 1 步，共 6 步");
	assert.deepEqual([...doc.querySelectorAll(".zb-su-steps-item")].map(li => li.textContent), ["1 歡迎", "2 選模式", "3 筆記放哪裡", "4 AI（選填）", "5 試一次", "6 完成"]);
	assert.equal(doc.querySelector('[aria-current="step"]').getAttribute("data-zb-step"), "welcome");
	assert.match(doc.querySelector(".zb-su-step").textContent, /找文獻和寫作留給你/);
	assert.match(doc.querySelector(".zb-su-step").textContent, /AI 只在你自己打開/);
	assert.match(doc.querySelector(".zb-su-step").textContent, /每個功能都能關/);
	assert.equal($("zb-su-back").hidden, true);
	assert.equal($("zb-su-skip").hidden, true);
	assert.equal($("zb-su-next").textContent, "開始設定");
	assert.equal(doc.activeElement, $("zb-su-h-welcome"), "focus on the step's heading");
	$("zb-su-next").click();
	await waitFor(() => view.step() === "mode", "step 2");

	// 2 選模式: 研究生引導 checked (the profile's preset), recommended; 進階 applies the preset
	assert.equal(doc.querySelector(".zb-su-count").textContent, "第 2 步，共 6 步");
	assert.equal($("zb-su-mode-guided").checked, true);
	assert.match(doc.querySelector('label[for="zb-su-mode-guided"]').textContent, /研究生引導建議新手/);
	assert.match(doc.querySelector(".zb-su-step").textContent, /設定 → 功能/);
	choose(doc, "zb-su-mode-advanced");
	assert.equal(env.ZB.features.currentPreset(), "guided", "nothing is written before 下一步");
	assert.equal(await view.next(), true);
	assert.equal(env.ZB.features.currentPreset(), "advanced");
	assert.equal(view.status(), "已切換到「進階」。");

	// 3 筆記放哪裡: Obsidian; the folder picker; the vault check; 下一步 stores the path
	assert.equal(view.step(), "notes");
	assert.equal(doc.querySelector('[data-zb-box="obsidian"]').hidden, true, "no fields before a choice");
	assert.equal(await view.next(), false, "a choice is needed");
	assert.equal(view.status(), "先選一個，或按「略過」。");
	choose(doc, "zb-su-notes-obsidian");
	assert.equal(doc.querySelector('[data-zb-box="obsidian"]').hidden, false);
	assert.equal(doc.querySelector('[data-zb-box="notion"]').hidden, true);
	// A folder that doesn't exist: said, and 下一步 stays
	type(doc, "zb-su-vault", "/nope");
	await waitFor(() => $("zb-su-vault-check").textContent, "the vault check");
	assert.equal($("zb-su-vault-check").textContent, "找不到這個資料夾，請再選一次。");
	assert.equal($("zb-su-vault").getAttribute("aria-invalid"), "true");
	assert.equal(await view.next(), false);
	assert.equal(env.prefStore[P + "obsidian.vaultPath"], undefined);
	// Typed (or picked with 選擇資料夾…, see the next test): a vault
	assert.ok($("zb-su-vault-pick"), "a 選擇資料夾… button");
	type(doc, "zb-su-vault", "/home/me/Vault");
	await waitFor(() => /Obsidian vault/.test($("zb-su-vault-check").textContent), "the vault check");
	assert.equal($("zb-su-vault-check").textContent, "是 Obsidian vault（裡面有 .obsidian 設定資料夾）。");
	assert.equal($("zb-su-vault").hasAttribute("aria-invalid"), false);
	assert.equal(await view.next(), true);
	assert.equal(env.prefStore[P + "obsidian.vaultPath"], "/home/me/Vault");
	assert.equal(env.prefStore[P + "notion.database"], undefined, "Notion untouched");

	// 4 AI: 略過 is the prominent way; 儲存並繼續 waits for a key; a malformed key is refused
	assert.equal(view.step(), "ai");
	assert.equal($("zb-su-skip").textContent, "先不用 AI");
	assert.ok($("zb-su-skip").classList.contains("zb-su-primary"));
	assert.equal($("zb-su-next").textContent, "儲存並繼續");
	assert.equal($("zb-su-next").disabled, true);
	assert.match(doc.querySelector(".zb-su-step").textContent, /依用量付費/);
	assert.equal($("zb-su-ai-key").getAttribute("type"), "password");
	type(doc, "zb-su-ai-key", "hello");
	assert.equal($("zb-su-next").disabled, false);
	assert.equal(await view.next(), false);
	assert.equal(view.status(), "這不像 Claude 的 API key（應該是 sk-ant- 開頭）。請整段複製再貼一次。");
	assert.deepEqual(stored(env, "anthropicKey"), []);
	type(doc, "zb-su-ai-key", CLAUDE_KEY);
	assert.equal(await view.next(), true);
	assert.deepEqual(stored(env, "anthropicKey"), [CLAUDE_KEY], "the key is in the login manager");
	assert.deepEqual(prefsHolding(env, CLAUDE_KEY), [], "and in no pref");
	assert.equal(env.prefStore[P + "llm.provider"], "anthropic");
	assert.match(view.status(), /^已存好。/);

	// 5 試一次: the selected item, synced with the catalog's sync-no-ai (ai: reuse), the note shown
	assert.equal(view.step(), "try");
	assert.equal($("zb-su-try-item").textContent, "你選取的：Exercise and falls");
	assert.equal($("zb-su-try-no-target").hidden, true);
	assert.equal($("zb-su-try-run").disabled, false);
	$("zb-su-try-run").click();
	await waitFor(() => $("zb-su-try-result").getAttribute("data-zb-result"), "the sync result");
	assert.deepEqual(JSON.parse(JSON.stringify(runs)), [[[paper.id], { targets: ["notion", "obsidian"], ai: "reuse" }]]);
	assert.equal($("zb-su-try-result").textContent, "已寫入 Obsidian：Zotero/lee2021exercise.md");
	$("zb-su-try-open-obsidian").click();
	assert.deepEqual(env.launched, ["obsidian://open?vault=Vault&file=Zotero%2Flee2021exercise"]);
	assert.equal(await view.next(), true);

	// 6 完成: where things are, what is set up; 完成 marks it done and closes
	assert.equal(view.step(), "done");
	let text = doc.querySelector(".zb-su-step").textContent;
	assert.match(text, /工具列的 ZotMax 按鈕/);
	assert.match(text, /ZotMax 面板（橋形圖示）/);
	assert.match(text, /快速指令 Ctrl\+Shift\+P/);
	assert.match(text, /設定 → ZotMax/);
	assert.match(text, /搜「設定精靈」/);
	await waitFor(() => doc.querySelectorAll("#zb-su-summary li").length === 3, "the summary");
	assert.deepEqual([...doc.querySelectorAll("#zb-su-summary li")].map(li => li.textContent), ["模式：進階", "筆記：Obsidian", "AI：Claude"]);
	assert.equal($("zb-su-skip").hidden, true);
	assert.equal($("zb-su-next").textContent, "完成");
	assert.equal(env.prefStore[DONE], undefined);
	$("zb-su-next").click();
	await waitFor(() => dialog.closed, "the window to close");
	assert.equal(env.prefStore[DONE], true);
	assert.equal(env.ZB.setup.isOpen, false);
	assert.deepEqual(env.errors, []);
});

test("Obsidian: 選擇資料夾… uses the native picker; a plain folder is accepted with a note, a file is refused", async () => {
	let env = await setup({ files: { "/notes": "directory", "/notes.txt": "regular" } });
	let titles = [];
	let view = null;
	let dialog = await env.ZB.setup.open(env.win, {
		deps: { pickFolder: async (w, title) => { titles.push(title); return "/notes"; } },
		onOpen: (w, v) => { view = v; },
	});
	let doc = dialog.document;
	await view.go("notes");
	choose(doc, "zb-su-notes-obsidian");
	doc.getElementById("zb-su-vault-pick").click();
	await waitFor(() => doc.getElementById("zb-su-vault-check").textContent, "the check");
	assert.deepEqual(titles, ["選擇 Obsidian vault 資料夾"]);
	assert.equal(doc.getElementById("zb-su-vault").value, "/notes");
	assert.match(doc.getElementById("zb-su-vault-check").textContent, /^是資料夾，但裡面沒有 \.obsidian/);
	// A file instead
	type(doc, "zb-su-vault", "/notes.txt");
	await waitFor(() => /檔案/.test(doc.getElementById("zb-su-vault-check").textContent), "the file check");
	assert.equal(await view.next(), false);
	assert.equal(env.prefStore[P + "obsidian.vaultPath"], undefined);
	type(doc, "zb-su-vault", "/notes");
	assert.equal(await view.next(), true);
	assert.equal(env.prefStore[P + "obsidian.vaultPath"], "/notes");
	env.ZB.setup.close();
	assert.deepEqual(env.errors, []);
});

test("Notion: the token goes to the login manager, never to prefs; the link is checked; 測試連線 reuses main.testNotion", async () => {
	let env = await setup();
	let tests = 0;
	env.ZB.main.testNotion = async () => {
		tests++;
		// What testNotion reads: the stored token and the database pref, saved before the test
		assert.equal(await env.ZB.secrets.get("notionToken"), NOTION_TOKEN);
		assert.equal(env.prefStore[P + "notion.database"], NOTION_DB);
		return ["✅ 預設：連線成功，欄位齊全"];
	};
	let { view, doc } = await openWizard(env);
	await view.go("notes");
	choose(doc, "zb-su-notes-notion");
	assert.equal(doc.querySelector('[data-zb-box="notion"]').hidden, false);
	assert.equal(doc.getElementById("zb-su-notion-token").getAttribute("type"), "password");
	// The how-to link opens the site wizard's steps
	doc.getElementById("zb-su-notion-howto").click();
	assert.deepEqual(env.launched, ["https://bobyu89.github.io/zotero-bridge/#install"]);
	// No token
	type(doc, "zb-su-notion-database", NOTION_DB);
	assert.equal(await view.next(), false);
	assert.equal(view.status(), "請貼上 Notion integration token。");
	assert.equal(doc.getElementById("zb-su-notion-token").getAttribute("aria-invalid"), "true");
	// A link without an ID
	type(doc, "zb-su-notion-token", NOTION_TOKEN);
	type(doc, "zb-su-notion-database", "https://www.notion.so/my-page");
	assert.equal(await view.next(), false);
	assert.match(view.status(), /^這不像 Notion 資料庫連結/);
	assert.deepEqual(stored(env, "notionToken"), [], "nothing stored while the step is refused");
	assert.equal(env.prefStore[P + "notion.database"], undefined);
	// 測試連線: saves both, then shows what testNotion reports
	type(doc, "zb-su-notion-database", NOTION_DB);
	doc.getElementById("zb-su-notion-test").click();
	await waitFor(() => /連線成功/.test(doc.getElementById("zb-su-notion-result").textContent), "the test result");
	assert.equal(tests, 1);
	assert.deepEqual(stored(env, "notionToken"), [NOTION_TOKEN]);
	assert.deepEqual(prefsHolding(env, NOTION_TOKEN), [], "the token is in no pref");
	assert.equal(doc.getElementById("zb-su-notion-token").value, "", "never shown back");
	assert.equal(doc.getElementById("zb-su-notion-token-saved").textContent, "已經存了一組 token；留空就沿用。");
	// A failing test says so in words
	env.ZB.main.testNotion = async () => { throw new Error("請先填入 Notion integration token"); };
	doc.getElementById("zb-su-notion-test").click();
	await waitFor(() => /^連線失敗/.test(doc.getElementById("zb-su-notion-result").textContent), "the failure");
	// 下一步 with the stored token: the field may stay empty
	assert.equal(await view.next(), true);
	assert.equal(view.step(), "ai");
	env.ZB.setup.close();
	assert.deepEqual(env.errors, []);
});

test("略過 everywhere writes nothing but setup.done at the end; a reopened wizard starts fresh in a new window", async () => {
	let env = await setup();
	let before = JSON.stringify(env.prefStore);
	let { dialog, view, doc } = await openWizard(env);
	let names = [dialog.zbName];
	await view.next();
	// mode → notes → ai → try → done, each skipped (the AI step even with a key typed)
	for (let step of ["mode", "notes", "ai", "try"]) {
		assert.equal(view.step(), step);
		if (step === "notes") choose(doc, "zb-su-notes-obsidian");
		if (step === "mode") choose(doc, "zb-su-mode-advanced");
		if (step === "ai") type(doc, "zb-su-ai-key", CLAUDE_KEY);
		if (step === "try") {
			assert.equal(doc.getElementById("zb-su-try-no-target").hidden, false, "nowhere to sync yet");
			assert.equal(doc.getElementById("zb-su-try-run").disabled, true);
		}
		doc.getElementById("zb-su-skip").click();
		await waitFor(() => view.step() !== step, `${step} skipped`);
	}
	assert.equal(view.step(), "done");
	assert.equal(JSON.stringify(env.prefStore), before, "no pref written by skipping");
	assert.equal(env.logins.length, 0, "no secret stored by skipping");
	assert.equal(env.ZB.features.currentPreset(), "guided");
	await waitFor(() => doc.querySelectorAll("#zb-su-summary li").length === 3, "the summary");
	assert.deepEqual([...doc.querySelectorAll("#zb-su-summary li")].map(li => li.textContent), ["模式：研究生引導", "筆記：還沒設定", "AI：不使用（不花錢）"]);
	// 上一步 goes back without writing either
	await view.back();
	assert.equal(view.step(), "try");
	await view.next();
	await view.next();
	assert.equal(dialog.closed, true);
	assert.equal(env.prefStore[DONE], true);
	// Reopened right away: a fresh window name, step 1
	({ dialog, view, doc } = await openWizard(env));
	names.push(dialog.zbName);
	assert.notEqual(names[0], names[1]);
	assert.equal(view.step(), "welcome");
	// A second open brings the open one to the front instead of a new window
	let count = env.dialogs.length;
	assert.equal(await env.ZB.setup.open(env.win), dialog);
	assert.equal(env.dialogs.length, count);
	env.ZB.setup.close();
	assert.deepEqual(env.errors, []);
});

test("closing half way (Esc, or the window's close button) keeps what was confirmed and marks it done", async () => {
	let env = await setup();
	let { dialog, view, doc } = await openWizard(env);
	await view.next();
	choose(doc, "zb-su-mode-advanced");
	await view.next();
	assert.equal(view.step(), "notes");
	doc.dispatchEvent(new doc.defaultView.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
	assert.equal(dialog.closed, true);
	assert.equal(env.prefStore[DONE], true);
	assert.equal(env.ZB.features.currentPreset(), "advanced", "the confirmed step stays");
	// The window's own close button: its unload marks it done too
	delete env.prefStore[DONE];
	({ dialog, view, doc } = await openWizard(env));
	dialog.dispatchEvent(new dialog.Event("unload"));
	assert.equal(env.prefStore[DONE], true);
	assert.equal(env.ZB.setup.isOpen, false);
	assert.deepEqual(env.errors, []);
});

test("試一次: the first item in the list when nothing is selected; no items says how to add one; a failure says so", async () => {
	let env = await setup({ prefs: { [P + "obsidian.vaultPath"]: "/v" } });
	let a = new env.MockItem("journalArticle", { title: "First paper" });
	let note = new env.MockItem("note");
	env.selection.sorted = [note, a];
	env.ZB.main.run = () => Promise.reject(new Error("disk full"));
	env.ZB.main.literatureNote = async () => null;
	env.ZB.main.noteLinks = async () => ({});
	let { view, doc } = await openWizard(env);
	await view.go("try");
	assert.equal(doc.getElementById("zb-su-try-item").textContent, "清單裡的第一篇：First paper");
	// execute() logs a failed command and resolves; the wizard says nothing was written
	doc.getElementById("zb-su-try-run").click();
	await waitFor(() => doc.getElementById("zb-su-try-result").getAttribute("data-zb-result"), "the result");
	assert.equal(doc.getElementById("zb-su-try-result").textContent, "沒有寫出筆記。看看 Zotero 角落的同步視窗說了什麼，或到 設定 → 同步 檢查。");
	assert.equal(env.errors.length, 1, "the failure is logged for the debug output");
	env.errors.length = 0;
	// Select an item now and use it
	let b = new env.MockItem("journalArticle", { title: "Chosen paper" });
	env.selection.items = [b];
	doc.getElementById("zb-su-try-refresh").click();
	await waitFor(() => /Chosen paper/.test(doc.getElementById("zb-su-try-item").textContent), "the selected item");
	assert.equal(doc.getElementById("zb-su-try-item").textContent, "你選取的：Chosen paper");
	env.ZB.setup.close();
	// An empty library
	let empty = await setup({ prefs: { [P + "obsidian.vaultPath"]: "/v" } });
	let w = await openWizard(empty);
	await w.view.go("try");
	await waitFor(() => w.doc.getElementById("zb-su-try-item").textContent, "the item line");
	assert.match(w.doc.getElementById("zb-su-try-item").textContent, /^文獻庫裡還沒有文獻/);
	assert.equal(w.doc.getElementById("zb-su-try-run").disabled, true);
	empty.ZB.setup.close();
	assert.deepEqual([...env.errors, ...empty.errors], []);
});

test("checks: vault, Notion link, key format (no network)", async () => {
	let env = await setup({ files: { "/v": "directory", "/v/.obsidian": "directory", "/f": "regular", "/plain": "directory" } });
	let S = env.ZB.setup;
	let state = async p => (await S.checkVault(p)).state;
	assert.equal(await state(""), "empty");
	assert.equal(await state("/missing"), "missing");
	assert.equal(await state("/f"), "file");
	assert.equal(await state("/v"), "vault");
	assert.equal(await state("/plain"), "folder");
	assert.equal((await S.checkVault("/plain")).ok, true);
	assert.equal((await S.checkVault("/f")).ok, false);
	assert.equal(S.checkNotion({ token: "", hasToken: false, database: NOTION_DB }).error, "notionNeedToken");
	assert.equal(S.checkNotion({ token: "", hasToken: true, database: NOTION_DB }).ok, true);
	assert.equal(S.checkNotion({ token: "x", database: "https://www.notion.so/page" }).error, "notionBadDatabase");
	assert.equal(S.checkNotion({ token: " x ", database: "0123456789abcdef0123456789abcdef" }).token, "x");
	assert.equal(S.checkKey("anthropic", CLAUDE_KEY).ok, true);
	assert.equal(S.checkKey("anthropic", ` ${CLAUDE_KEY} `).key, CLAUDE_KEY, "trimmed");
	assert.equal(S.checkKey("anthropic", "sk-proj-abcdefghijklmnopqrstuvwxyz").error, "aiKeyBadClaude");
	assert.equal(S.checkKey("openai", "sk-proj-abcdefghijklmnopqrstuvwxyz").ok, true);
	assert.equal(S.checkKey("openai", CLAUDE_KEY).error, "aiKeyWrongProvider");
	assert.equal(S.checkKey("openai", "token-of-a-compatible-service", { baseURL: "http://localhost:8080/v1" }).ok, true);
	assert.equal(S.checkKey("openai", "nope").error, "aiKeyBadOpenAI");
	assert.equal(S.checkKey("anthropic", "  ").error, "empty");
	assert.deepEqual(env.errors, []);
});

// ---------- where it is offered ----------

test("設定精靈… is in the catalog (never switched off), the toolbar menu before 設定…, 快速指令's 設定 group and the settings pane", async () => {
	let env = await setup();
	let C = env.ZB.commands;
	let cmd = C.get("setup-wizard");
	assert.equal(cmd, C.SETUP);
	assert.deepEqual([...cmd.features], []);
	assert.equal(cmd.needs, null);
	assert.equal(cmd.label, "設定精靈…");
	assert.equal(ftlText(ftl("zh-TW"), cmd.l10n), cmd.label);
	assert.equal(ftlText(ftl("en-US"), cmd.l10n), "Setup Wizard…");
	// Every wizard string in both locales, zh-TW identical to the module's text
	for (let [name, [id, text]] of Object.entries(env.ZB.setup.STRINGS)) {
		assert.equal(ftlText(ftl("zh-TW"), id), text, `zh-TW ${name}`);
		assert.ok(ftlText(ftl("en-US"), id), `en-US ${name}`);
	}
	// Toolbar menu: … 設定精靈…, 設定… last
	let popup = env.win.document.getElementById("zotero-bridge-tb-popup");
	let last = popup.lastElementChild;
	assert.equal(last.getAttribute("data-zb-entry"), "settings");
	assert.equal(last.previousElementSibling.getAttribute("data-zb-entry"), "setup-wizard");
	assert.equal(last.previousElementSibling.getAttribute("data-l10n-id"), "zotero-bridge-cmd-setup-wizard");
	last.previousElementSibling.dispatchEvent(new env.win.Event("command"));
	await waitFor(() => env.dialogs.length === 1, "the wizard from the toolbar");
	assert.equal(env.dialogs[0].zbURL, "chrome://zotero-bridge/content/setup.xhtml");
	await waitFor(() => env.ZB.setup.isOpen, "open");
	env.ZB.setup.close();
	// 快速指令: first in 設定, runnable with every switch off
	for (let f of env.ZB.features.FEATURES) env.ZB.features.setEnabled(f.id, false);
	let entries = C.paletteEntries(C.fromWindow(env.win, "palette"));
	let settingsGroup = entries.filter(e => e.group === "settings");
	assert.equal(settingsGroup[0].id, "setup-wizard");
	assert.deepEqual({ ...settingsGroup[0].availability }, { ok: true });
	assert.equal(C.search(entries, "設定精靈")[0].id, "setup-wizard");
	assert.equal(C.search(entries, "setup")[0].id, "setup-wizard");
	assert.equal(C.search(entries, "wizard")[0].id, "setup-wizard");
	let view = null;
	let palette = await env.ZB.palette.open(env.win, { onOpen: (w, v) => { view = v; } });
	let groups = [...palette.document.querySelectorAll(".zb-pal-group-title")].map(t => t.textContent);
	assert.equal(groups.at(-1), "設定");
	view.query("設定精靈");
	assert.equal(view.active().id, "setup-wizard");
	assert.equal(palette.document.querySelector('[data-zb-entry="setup-wizard"] .zb-pal-group-tag').textContent, "設定");
	assert.equal(view.choose(), "run");
	await waitFor(() => env.dialogs.filter(d => d.zbURL.endsWith("setup.xhtml")).length === 2, "the wizard from 快速指令");
	await waitFor(() => env.ZB.setup.isOpen, "open");
	env.ZB.setup.close();
	// The settings pane: 「開啟設定精靈」 at the top of 功能
	let xhtml = fs.readFileSync(path.join(ROOT, "content", "preferences.xhtml"), "utf8");
	let pane = new JSDOM(`<box xmlns="http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul" xmlns:html="http://www.w3.org/1999/xhtml">${xhtml}</box>`, { contentType: "application/xml" }).window;
	let button = pane.document.getElementById("zb-open-setup");
	assert.ok(button, "the button in preferences.xhtml");
	assert.equal(button.closest("[data-zb-section]").getAttribute("data-zb-section"), "features");
	assert.equal(button.getAttribute("data-l10n-id"), "zotero-bridge-prefs-open-setup");
	assert.equal(button.textContent, ftlText(ftl("zh-TW"), "zotero-bridge-prefs-open-setup"));
	env.Zotero.ZoteroBridge = env.ZB;
	let paneScope = vm.createContext({ Zotero: env.Zotero, window: pane, document: pane.document, Event: pane.Event, setTimeout, clearTimeout });
	vm.runInContext(fs.readFileSync(path.join(ROOT, "content", "preferences.js"), "utf8"), paneScope);
	await pane.ZoteroBridgePrefs.openSetup();
	assert.equal(env.ZB.setup.isOpen, true);
	env.ZB.setup.close();
	assert.deepEqual(env.errors, []);
});

test("shutdown: the wizard window closes, nothing is marked, late callbacks touch nothing", async () => {
	let env = await setup();
	let { dialog, view, doc } = await openWizard(env);
	await view.go("notes");
	let wizard = env.ZB.setup;
	await vm.runInContext("shutdown()", env.context);
	assert.equal(dialog.closed, true);
	assert.equal(wizard.isOpen, false);
	assert.equal(env.prefStore[DONE], undefined, "Zotero quitting is not the user closing it");
	assert.equal(env.context.ZB, undefined);
	// Events after shutdown are ignored
	dialog.dispatchEvent(new dialog.Event("unload"));
	choose(doc, "zb-su-notes-obsidian");
	doc.dispatchEvent(new doc.defaultView.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	assert.equal(env.prefStore[DONE], undefined);
	assert.equal(await wizard.open(env.win), null, "a stale reference opens nothing");
	// A pending automatic opening is cancelled
	let late = makeEnv();
	await vm.runInContext(`startup({ id: ${JSON.stringify(PLUGIN_ID)}, version: "0.0.0", rootURI: ${JSON.stringify(ROOT_URI)} }, 5)`, late.context);
	await vm.runInContext("shutdown()", late.context);
	await tick(1800);
	assert.equal(late.dialogs.length, 0);
	assert.deepEqual([...env.errors, ...late.errors], []);
});
