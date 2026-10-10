// 回報問題… and 試用回饋… (content/report.js) through the real plugin in a mocked Zotero with jsdom windows:
// both commands in the catalog (never switched off), in the toolbar menu above 設定精靈…, in 快速指令's 設定
// group and at the foot of 設定 → 功能; 回報問題 shows the environment text before anything happens
// (複製 copies it, 取消 opens nothing) and opens the bug form with exactly that text, read from a
// configured profile without its paths, names, IDs or keys; 試用回饋 opens the questionnaire with the
// version and the mode; after shutdown nothing runs.
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
const CLAUDE_KEY = "sk-ant-api03-e2eTESTkey_0123456789abcdef";
const NOTION_TOKEN = "ntn_smoke_token_0123456789abcdef";
const NOTION_DB = "https://www.notion.so/alice/Literature-0123456789abcdef0123456789abcdef?v=1";
const VAULT = "/Users/alice/Documents/My Thesis Vault";
const XPI = "jar:file:///Users/alice/Library/Application%20Support/Zotero/Profiles/ab12.default/extensions/zotero-bridge@bobyu89.github.io.xpi!/content/";

const MAIN_WINDOW = `<!DOCTYPE html><html><body>
<toolbar id="zotero-toolbar-item-tree">
	<hbox id="zotero-items-toolbar">
		<toolbarbutton id="zotero-tb-note-add" class="zotero-tb-button" tabindex="-1" type="menu"></toolbarbutton>
		<input id="zotero-tb-search">
	</hbox>
</toolbar>
</body></html>`;

// nsIPromptService's constants, as Gecko defines them
const PROMPT = { BUTTON_POS_0: 1, BUTTON_POS_1: 256, BUTTON_POS_2: 65536, BUTTON_TITLE_IS_STRING: 127, BUTTON_TITLE_CANCEL: 2, BUTTON_POS_0_DEFAULT: 0 };

/**
 * prefs: initial prefs (full names); logins: the login manager; console: messages in the error console
 * ({ text, source, line, flags }); answers: what confirmEx answers, in turn (0 open, 1 cancel, 2 copy).
 */
function makeEnv({ prefs = {}, logins = [], console: consoleMessages = [], answers = [], items = 0 } = {}) {
	let errors = [];
	let launched = [];
	let copied = [];
	let prompts = [];
	let dialogs = [];
	let prefStore = Object.assign({}, prefs);
	let dom = new JSDOM(MAIN_WINDOW);
	let win = dom.window;
	win.document.createXULElement = tag => win.document.createElement(tag);
	win.MozXULElement = { insertFTLIfNeeded: () => {} };
	win.ZoteroPane = { getSelectedItems: () => [], getSelectedCollections: () => [], getSortedItems: () => [], getSelectedLibraryID: () => 1 };
	win.openDialog = (url, name) => {
		let file = { "chrome://zotero-bridge/content/palette.xhtml": "palette.xhtml", "chrome://zotero-bridge/content/setup.xhtml": "setup.xhtml" }[url];
		assert.ok(file, `unexpected window ${url}`);
		let d = new JSDOM(fs.readFileSync(path.join(ROOT, "content", file), "utf8"), { contentType: "application/xml" });
		let closed = false;
		d.window.close = () => {
			closed = true;
		};
		Object.defineProperty(d.window, "closed", { get: () => closed });
		d.window.focus = () => {};
		d.window.zbURL = url;
		d.window.zbName = name;
		dialogs.push(d.window);
		return d.window;
	};
	let library = Array.from({ length: items }, (_, i) => ({ id: i + 1, deleted: false, isRegularItem: () => true }));

	let Zotero = {
		isMac: false,
		version: "10.0.3",
		locale: "zh-TW",
		platform: "MacIntel",
		getOSVersion: async () => "macOS 15.1",
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
		Items: { get: () => null, exists: () => false, getByLibraryAndKey: () => false, getAll: async () => library },
		Libraries: { userLibraryID: 1, get: () => ({ libraryType: "user", name: "My Library" }), getAll: () => [] },
		Collections: { get: () => null, getByParent: () => [], getByLibrary: () => [{ name: "跌倒預防 RCT" }] },
		DataDirectory: { dir: "/Users/alice/Zotero" },
		Utilities: {
			Internal: {
				openPreferences: () => ({ closed: false }),
				copyTextToClipboard: (t) => {
					copied.push(t);
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
			addDescription() {}
			show() {}
			startCloseTimer() {}
		},
		launchURL: (url) => {
			launched.push(url);
		},
		logError: (e) => {
			errors.push(e);
		},
		debug: () => {},
	};

	let SCRIPT_ERROR = { warningFlag: 1, infoFlag: 8 };
	let context = vm.createContext({
		Zotero, console, TextDecoder, TextEncoder, setTimeout, clearTimeout, URL,
		IOUtils: { exists: async () => false, stat: async (p) => { throw new Error(`NotFoundError: ${p}`); } },
		PathUtils: { join: (...parts) => path.posix.join(...parts), filename: p => path.basename(p), homeDir: "/Users/alice", profileDir: "/Users/alice/Library/Application Support/Zotero/Profiles/ab12.default" },
		fetch: async (url) => {
			throw new Error(`unexpected request ${url}`);
		},
		Components: {
			Constructor: function () {
				return function (origin, formActionOrigin, httpRealm, username, password) {
					Object.assign(this, { origin, httpRealm, username, password });
				};
			},
			interfaces: { nsILoginInfo: {}, nsIScriptError: SCRIPT_ERROR },
		},
		DOMParser: new JSDOM("").window.DOMParser,
		Services: {
			scriptloader: {
				loadSubScript: (url) => {
					let file = url.replace("file://", "");
					vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
				},
			},
			prompt: Object.assign({
				confirm: () => true,
				confirmEx: (parent, title, text, flags, b0, b1, b2) => {
					let answer = answers.length ? answers.shift() : 1;
					prompts.push({ parent, title, text, flags, buttons: [b0, b1, b2] });
					if (typeof answer === "function") return answer();
					return answer;
				},
			}, PROMPT),
			prefs: { prefHasUserValue: k => k in prefStore },
			env: { get: k => ({ USER: "alice" })[k] || "" },
			console: {
				getMessageArray: () => consoleMessages.map(m => ({
					QueryInterface(iface) {
						if (iface !== SCRIPT_ERROR || m.plain) throw new Error("NS_NOINTERFACE");
						return { errorMessage: m.text, sourceName: m.source || "", lineNumber: m.line || 0, flags: m.flags || 0 };
					},
				})),
			},
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
	return { context, Zotero, prefStore, errors, launched, copied, prompts, dialogs, win, answers };
}

async function setup(opts = {}) {
	let env = makeEnv(opts);
	await vm.runInContext(`startup({ id: ${JSON.stringify(PLUGIN_ID)}, version: "0.14.0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);
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

function ftl(lang) {
	return fs.readFileSync(path.join(ROOT, "locale", lang, "zotero-bridge.ftl"), "utf8");
}

function ftlText(text, id) {
	let m = new RegExp(`^${id} =\\n {4}\\.label = (.+)$`, "m").exec(text) || new RegExp(`^${id} = (.+)$`, "m").exec(text);
	return m ? m[1] : null;
}

/** A configured profile: a vault, Notion, a Claude key, routing rules, and ZotMax errors in the console. */
function configured(extra = {}) {
	return Object.assign({
		prefs: {
			[P + "obsidian.vaultPath"]: VAULT,
			[P + "notion.database"]: NOTION_DB,
			[P + "routing.rules"]: JSON.stringify([{ name: "論文", library: "*", collection: "Falls Review", notionDatabase: "", obsidianFolder: "Thesis Notes" }]),
			[P + "setup.done"]: true,
		},
		logins: [
			{ origin: "chrome://zotero-bridge", httpRealm: "Zotero Bridge", username: "anthropicKey", password: CLAUDE_KEY },
			{ origin: "chrome://zotero-bridge", httpRealm: "Zotero Bridge", username: "notionToken", password: NOTION_TOKEN },
		],
		console: [
			{ text: "some other add-on failed", source: "chrome://other/content/x.js", line: 1 },
			{ text: `NotFoundError: Could not open the file at ${VAULT}/Zotero/Lin 2019 跌倒.md`, source: XPI + "main.js", line: 412 },
			{ text: `Notion API 401: unauthorized for ${NOTION_TOKEN} on database 0123456789abcdef0123456789abcdef`, source: XPI + "notion.js", line: 88 },
			{ text: "ZotMax: classify failed in Falls Review", source: "", line: 0 },
			{ text: "a warning", source: XPI + "main.js", line: 2, flags: 1 },
			{ text: "a plain console line", plain: true },
		],
		items: 250,
	}, extra);
}

// ---------- the catalog and where the commands are offered ----------

test("回報問題… and 試用回饋… are catalog commands, never switched off, labels identical to the FTL", async () => {
	let env = await setup();
	let C = env.ZB.commands;
	assert.deepEqual([...C.HELP.map(c => c.id)], ["report-issue", "trial-feedback"]);
	for (let [id, zh, en] of [["report-issue", "回報問題…", "Report a Problem…"], ["trial-feedback", "試用回饋…", "Trial Feedback…"]]) {
		let c = C.get(id);
		assert.ok(c && C.HELP.includes(c), id);
		assert.deepEqual([...c.features], []);
		assert.equal(c.needs, null);
		assert.deepEqual([...c.menus], []);
		assert.equal(c.label, zh);
		assert.equal(ftlText(ftl("zh-TW"), c.l10n), zh);
		assert.equal(ftlText(ftl("en-US"), c.l10n), en);
		assert.ok(c.keywords.some(k => /[一-鿿]/.test(k)) && c.keywords.some(k => /^[\x20-\x7e]+$/.test(k)), `${id}: Chinese and English keywords`);
		assert.equal(C.COMMANDS.includes(c), false, "outside the workflow groups, like 設定精靈…");
	}
	// The dialogs' strings in both locales, zh-TW identical to the module
	for (let [name, [id, text]] of Object.entries(env.ZB.report.STRINGS)) {
		assert.equal(ftlText(ftl("zh-TW"), id), text, `zh-TW ${name}`);
		assert.ok(ftlText(ftl("en-US"), id), `en-US ${name}`);
	}
	assert.deepEqual(env.errors, []);
});

test("toolbar menu: 回報問題… and 試用回饋… above 設定精靈… and 設定…, shown with every switch off", async () => {
	let env = await setup();
	for (let f of env.ZB.features.FEATURES) env.ZB.features.setEnabled(f.id, false);
	let popup = env.win.document.getElementById("zotero-bridge-tb-popup");
	popup.dispatchEvent(new env.win.Event("popupshowing"));
	let tail = [...popup.children].slice(-6).map(el => (el.localName === "menuseparator" ? "|" : el.getAttribute("data-zb-entry")));
	assert.deepEqual(tail, ["|", "report-issue", "trial-feedback", "|", "setup-wizard", "settings"]);
	for (let id of ["report-issue", "trial-feedback"]) {
		let el = popup.querySelector(`[data-zb-entry="${id}"]`);
		assert.equal(el.hidden, false);
		assert.equal(el.getAttribute("data-l10n-id"), env.ZB.commands.get(id).l10n);
		assert.equal(el.hasAttribute("data-zb-group-entry"), false);
	}
	// Choosing it runs the command: the dialog (cancelled here) opens nothing
	popup.querySelector('[data-zb-entry="report-issue"]').dispatchEvent(new env.win.Event("command"));
	await waitFor(() => env.prompts.length === 1, "the 回報問題 dialog");
	assert.equal(env.prompts[0].title, "回報問題");
	assert.deepEqual(env.launched, []);
	assert.deepEqual(env.errors, []);
});

test("快速指令: both right after 設定精靈… in the 設定 group, runnable with every switch off, found in Chinese and English", async () => {
	let env = await setup({ answers: [0] });
	let C = env.ZB.commands;
	for (let f of env.ZB.features.FEATURES) env.ZB.features.setEnabled(f.id, false);
	let entries = C.paletteEntries(C.fromWindow(env.win, "palette"));
	let settings = entries.filter(e => e.group === "settings");
	assert.deepEqual([...settings.slice(0, 3).map(e => e.id)], ["setup-wizard", "report-issue", "trial-feedback"]);
	for (let e of settings.slice(1, 3)) assert.deepEqual({ ...e.availability }, { ok: true });
	assert.equal(C.search(entries, "回報")[0].id, "report-issue");
	assert.equal(C.search(entries, "bug")[0].id, "report-issue");
	assert.equal(C.search(entries, "問題")[0].id, "report-issue");
	assert.equal(C.search(entries, "回饋")[0].id, "trial-feedback");
	assert.equal(C.search(entries, "feedback")[0].id, "trial-feedback");
	// Run from the palette: the questionnaire opens
	let view = null;
	let palette = await env.ZB.palette.open(env.win, { onOpen: (w, v) => { view = v; } });
	view.query("試用回饋");
	assert.equal(view.active().id, "trial-feedback");
	assert.equal(palette.document.querySelector('[data-zb-entry="trial-feedback"] .zb-pal-group-tag').textContent, "設定");
	assert.equal(view.choose(), "run");
	await waitFor(() => env.launched.length === 1, "the questionnaire to open");
	assert.match(env.launched[0], /^https:\/\/github\.com\/bobyu89\/zotero-bridge\/issues\/new\?template=feedback\.yml&/);
	assert.deepEqual(env.errors, []);
});

test("settings pane: 回報問題… and 試用回饋… at the foot of 功能 run the commands with the settings window", async () => {
	let env = await setup({ answers: [1, 0] });
	let xhtml = fs.readFileSync(path.join(ROOT, "content", "preferences.xhtml"), "utf8");
	let pane = new JSDOM(`<box xmlns="http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul" xmlns:html="http://www.w3.org/1999/xhtml">${xhtml}</box>`, { contentType: "application/xml" }).window;
	let features = pane.document.querySelector('[data-zb-section="features"]');
	let links = pane.document.getElementById("zb-report-links");
	assert.ok(links && features.contains(links));
	assert.equal(links.previousElementSibling.id, "zb-features", "after the switches");
	for (let [id, l10n] of [["zb-report-issue", "zotero-bridge-prefs-report-issue"], ["zb-trial-feedback", "zotero-bridge-prefs-trial-feedback"]]) {
		let button = pane.document.getElementById(id);
		assert.equal(button.getAttribute("data-l10n-id"), l10n);
		assert.equal(button.textContent, ftlText(ftl("zh-TW"), l10n));
		assert.ok(ftlText(ftl("en-US"), l10n));
		assert.equal(button.getAttribute("aria-describedby"), "zb-report-hint");
	}
	let hint = pane.document.getElementById("zb-report-hint");
	assert.equal(hint.textContent, ftlText(ftl("zh-TW"), hint.getAttribute("data-l10n-id")));
	env.Zotero.ZoteroBridge = env.ZB;
	let paneScope = vm.createContext({ Zotero: env.Zotero, window: pane, document: pane.document, Event: pane.Event, setTimeout, clearTimeout });
	vm.runInContext(fs.readFileSync(path.join(ROOT, "content", "preferences.js"), "utf8"), paneScope);
	let cancelled = await pane.ZoteroBridgePrefs.reportIssue();
	assert.equal(cancelled.action, "cancel");
	assert.equal(env.prompts[0].parent, pane, "the dialog belongs to the settings window");
	let opened = await pane.ZoteroBridgePrefs.trialFeedback();
	assert.equal(opened.action, "open");
	assert.equal(env.launched.length, 1);
	assert.deepEqual(env.errors, []);
});

// ---------- 回報問題: what is shown, copied and sent ----------

test("回報問題: the dialog shows the exact environment text; 複製 copies it and shows the dialog again; then GitHub opens with it", async () => {
	let env = await setup(configured({ answers: [2, 0] }));
	// A configured profile from before the switches is on 進階 (features.js migrate)
	assert.equal(env.ZB.features.currentPreset(), "advanced");
	let result = await env.ZB.commands.execute("report-issue", env.ZB.commands.fromWindow(env.win, "toolbar"));
	assert.equal(result.action, "open");
	assert.equal(env.prompts.length, 2);
	let [first, second] = env.prompts;
	assert.equal(first.title, "回報問題");
	assert.equal(first.parent, env.win);
	assert.deepEqual(first.buttons, ["在瀏覽器開啟 GitHub", null, "複製"]);
	assert.equal(first.flags, PROMPT.BUTTON_POS_0 * PROMPT.BUTTON_TITLE_IS_STRING + PROMPT.BUTTON_POS_1 * PROMPT.BUTTON_TITLE_CANCEL
		+ PROMPT.BUTTON_POS_2 * PROMPT.BUTTON_TITLE_IS_STRING);
	assert.ok(first.text.includes(result.env), "the dialog shows the text that goes into the URL");
	assert.match(first.text, /不會送出文獻內容、筆記、API key 或電腦裡的路徑/);
	assert.match(first.text, /需要 GitHub 帳號/);
	assert.deepEqual(env.copied, [result.env]);
	assert.ok(second.text.startsWith("已複製環境資訊"), second.text.slice(0, 30));
	assert.deepEqual(env.launched, [result.url]);
	let u = new URL(result.url);
	assert.equal(u.origin + u.pathname, "https://github.com/bobyu89/zotero-bridge/issues/new");
	assert.equal(u.searchParams.get("template"), "bug.yml");
	assert.equal(u.searchParams.get("env"), result.env);
	assert.ok(result.url.length <= 6000);

	let env1 = result.env;
	for (let line of ["ZotMax：0.14.0", "Zotero：10.0.3", "系統：macOS 15.1", "語言：zh-TW", "模式：進階", "和模式不同的開關：無",
		"筆記：Obsidian 有設定，Notion 有設定", "AI：有設定（Claude）", "設定精靈：已完成", "文獻數：100–1000"]) {
		assert.ok(env1.split("\n").includes(line), `${line} in\n${env1}`);
	}
	// The three ZotMax errors, newest first, no warnings, no other add-on
	let errors = env1.split("\n").filter(l => /^\d+\. /.test(l));
	assert.equal(errors.length, 3, env1);
	assert.equal(errors[0], "1. ZotMax: classify failed in [已隱藏]");
	assert.equal(errors[1], "2. [notion.js:88] Notion API 401: unauthorized for [token] on database [ID]");
	assert.equal(errors[2], "3. [main.js:412] NotFoundError: Could not open the file at [已隱藏][路徑]");
	// Nothing of the profile: paths, user name, vault, Notion, key, collection and rule names
	for (let secret of [VAULT, "alice", "My Thesis Vault", "Thesis", "Lin 2019", "跌倒", NOTION_TOKEN, "ntn_", "0123456789abcdef", CLAUDE_KEY, "sk-ant",
		"Falls Review", "Literature", "Profiles", "ab12", "other add-on", "a warning"]) {
		assert.ok(!result.url.includes(encodeURIComponent(secret)) && !result.url.includes(secret), `${secret} in the URL`);
		assert.ok(!first.text.includes(secret), `${secret} in the dialog`);
	}
	assert.deepEqual(env.errors, []);
});

test("回報問題: 取消 (or closing the dialog) opens and copies nothing; a fresh profile says so plainly", async () => {
	let env = await setup({ answers: [1] });
	let result = await env.ZB.report.reportIssue(env.win);
	assert.equal(result.action, "cancel");
	assert.deepEqual(env.launched, []);
	assert.deepEqual(env.copied, []);
	let lines = result.env.split("\n");
	for (let line of ["筆記：Obsidian 沒有，Notion 沒有", "AI：沒有設定", "設定精靈：沒完成", "文獻數：<100", "最近的 ZotMax 錯誤：沒有", "模式：研究生引導"]) {
		assert.ok(lines.includes(line), `${line} in\n${result.env}`);
	}
	// A custom mode names the switches that differ
	env.answers.push(1);
	env.ZB.features.setEnabled("synthesis", true);
	let custom = await env.ZB.report.reportIssue(env.win);
	assert.ok(custom.env.split("\n").includes("模式：自訂（最接近研究生引導）"), custom.env);
	assert.ok(custom.env.split("\n").includes("和模式不同的開關：多開 synthesis"), custom.env);
	assert.deepEqual(env.errors, []);
});

test("試用回饋: the dialog says what it is and what is filled in; GitHub opens with the version and the mode", async () => {
	let env = await setup(configured({ answers: [0] }));
	env.ZB.features.applyPreset("advanced");
	let result = await env.ZB.commands.execute("trial-feedback", env.ZB.commands.fromWindow(env.win, "toolbar"));
	assert.equal(result.action, "open");
	let [prompt] = env.prompts;
	assert.equal(prompt.title, "試用回饋");
	assert.deepEqual(prompt.buttons, ["在瀏覽器開啟 GitHub", null, null], "no 複製: nothing worth copying");
	assert.match(prompt.text, /大約 5 分鐘/);
	assert.match(prompt.text, /未發表的研究資料或病人資訊/);
	assert.match(prompt.text, /ZotMax 0\.14\.0 · Zotero 10\.0\.3/);
	assert.match(prompt.text, /進階/);
	let u = new URL(env.launched[0]);
	assert.equal(u.searchParams.get("template"), "feedback.yml");
	assert.equal(u.searchParams.get("version"), "ZotMax 0.14.0 · Zotero 10.0.3");
	assert.equal(u.searchParams.get("preset"), "進階");
	assert.equal(u.searchParams.get("env"), null, "no environment details in the questionnaire");
	assert.deepEqual(env.errors, []);
});

test("a failure is reported in words, not thrown; after shutdown nothing runs, also from a dialog still open", async () => {
	let env = await setup({ answers: [() => {
		throw new Error("prompt service gone");
	}] });
	let notified = [];
	env.ZB.main.notify = (h, t) => notified.push(t);
	assert.equal(await env.ZB.report.reportIssue(env.win), null);
	assert.equal(notified.length, 1);
	assert.match(notified[0], /^沒有打開 GitHub（prompt service gone）/);
	assert.equal(env.errors.length, 1);

	// Zotero shuts the plugin down while the dialog is open: the answer opens nothing
	let late = await setup({ answers: [() => {
		vm.runInContext("shutdown()", late.context);
		return 0;
	}] });
	let report = late.ZB.report;
	assert.equal(await report.reportIssue(late.win), null);
	assert.deepEqual(late.launched, []);
	assert.equal(late.context.ZB, undefined);
	// A stale reference does nothing
	assert.equal(await report.reportIssue(late.win), null);
	assert.equal(await report.trialFeedback(late.win), null);
	assert.equal(late.prompts.length, 1);
	assert.deepEqual(late.errors, []);
});
