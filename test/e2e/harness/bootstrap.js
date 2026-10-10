/*
 * ZotMax end-to-end test harness: a second bootstrap plugin installed next to ZotMax
 * in a throwaway profile (test/e2e/run.sh). It waits for Zotero and the plugin, runs the checks below
 * against the real Zotero (items, PDF worker, login manager, MenuManager, Fluent, preferences window),
 * writes <workDir>/results.json and quits Zotero.
 *
 * It does nothing unless the pref extensions.zb-e2e.workDir is set, so installing it by accident in
 * a real profile is harmless. No network: Notion is never configured and the one LLM call goes to a
 * fetch stub placed in the plugin's own scope.
 */
/* global Zotero, Services, ChromeUtils, Components, IOUtils, PathUtils, Localization, CSS, dump, setTimeout, clearTimeout */

const PLUGIN_ID = "zotero-bridge@bobyu89.github.io";
const PANE_ID = "zotero-bridge-prefs";
// The settings pane's workflow tabs and the sections (data-zb-section) in each, in order
const PANE_TABS = {
	features: ["features"],
	sync: ["obsidian", "notion", "routing", "autosync", "status", "apaZh", "bibliography"],
	organize: ["fulltext", "colors", "concepts", "classify"],
	search: ["searchLinks", "ncbi", "pubmedWatch", "citationChase"],
	appraise: ["screening"],
	ai: ["ai", "usage"],
};
const E2E_PREF = "extensions.zb-e2e.";
const ZB_PREF = "extensions.zotero-bridge.";
const TEST_TIMEOUT_MS = 120000;
const TOTAL_TIMEOUT_MS = 15 * 60000;
// What counts as the plugin's own console output: its files (jar:…/zotero-bridge@….xpi!/…),
// its l10n IDs and its name
const PLUGIN_RE = /zotero-bridge@bobyu89\.github\.io|zotero-bridge-[a-z]|zotero-bridge\.ftl|Zotero ?Bridge/;
const Ci = Components.interfaces;

var workDir = "";
var messages = [];
var consoleListener = null;
var finished = false;
var results = null;

function log(text) {
	try {
		dump(`[zb-e2e] ${text}\n`);
	}
	catch (e) {}
}

function delay(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(fn, what, timeoutMs = 30000, interval = 100) {
	let end = Date.now() + timeoutMs;
	let last;
	while (Date.now() < end) {
		try {
			last = await fn();
			if (last) return last;
		}
		catch (e) {
			last = e;
		}
		await delay(interval);
	}
	throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}`
		+ (last instanceof Error ? ` (last error: ${last.message})` : ""));
}

function check(cond, message) {
	if (!cond) throw new Error(message);
}

function eq(actual, expected, message) {
	if (actual !== expected) {
		throw new Error(`${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
}

function errText(e) {
	if (!e) return String(e);
	let s = e.message ? e.message : String(e);
	if (e.stack) s += `\n${String(e.stack).split("\n").slice(0, 6).join("\n")}`;
	return s;
}

/**
 * A plain copy of a value for results.json: arrays and objects become harness-owned copies, so
 * nothing refers to a window (or the plugin's sandbox) that may be gone by the end of the run
 * ("can't access dead object"). Whatever can't be read is replaced by a note, not lost with the rest.
 */
function plain(value, depth = 0) {
	try {
		return JSON.parse(JSON.stringify(value === undefined ? null : value));
	}
	catch (e) {
		// Fall through: copy what can still be read, one value at a time
	}
	try {
		if (value === null || typeof value !== "object") return typeof value === "function" ? undefined : value;
		if (depth > 20) return "[too deep]";
		if (Array.isArray(value)) return Array.from(value, v => plain(v, depth + 1));
		let out = {};
		for (let k of Object.keys(value)) {
			try {
				out[k] = plain(value[k], depth + 1);
			}
			catch (e) {
				out[k] = `[unreadable: ${e}]`;
			}
		}
		return out;
	}
	catch (e) {
		return `[unreadable: ${e}]`;
	}
}

/** results as JSON; a test whose record can't be written is reduced to { name, ok, error }. */
function resultsJSON() {
	let out = {};
	for (let [k, v] of Object.entries(results)) {
		if (k === "tests") {
			out.tests = v.map((t) => {
				try {
					return JSON.parse(JSON.stringify(t));
				}
				catch (e) {
					return { name: t.name, ok: t.ok, error: t.error, unserializable: String(e) };
				}
			});
		}
		else {
			out[k] = plain(v);
		}
	}
	return JSON.stringify(out, null, 2);
}

// ---------- console capture ----------

function describe(msg) {
	let d = { kind: "log", text: "", source: "", stack: "", time: Date.now() };
	try {
		let se = msg.QueryInterface(Ci.nsIScriptError);
		d.text = se.errorMessage;
		d.source = se.sourceName ? `${se.sourceName}:${se.lineNumber}` : "";
		d.category = se.category;
		if (se.innerWindowID) d.innerWindowID = se.innerWindowID;
		if (se.flags & Ci.nsIScriptError.warningFlag) d.kind = "warning";
		else if (se.flags & Ci.nsIScriptError.infoFlag) d.kind = "info";
		else d.kind = "error";
		try {
			if (se.stack) d.stack = String(se.stack).split("\n").slice(0, 8).join("\n");
		}
		catch (e) {}
	}
	catch (e) {
		try {
			d.text = String(msg.message);
		}
		catch (e2) {}
	}
	return d;
}

function isPluginMessage(m) {
	return PLUGIN_RE.test(`${m.text}\n${m.source}\n${m.stack}`);
}

function pluginErrors(list, allow) {
	return list.filter(m => m.kind === "error" && isPluginMessage(m) && !(allow && allow.test(`${m.text}\n${m.source}`)));
}

function startCapture() {
	consoleListener = {
		QueryInterface: ChromeUtils.generateQI(["nsIConsoleListener"]),
		observe(msg) {
			try {
				messages.push(describe(msg));
			}
			catch (e) {}
		},
	};
	Services.console.registerListener(consoleListener);
}

function stopCapture() {
	if (!consoleListener) return;
	try {
		Services.console.unregisterListener(consoleListener);
	}
	catch (e) {}
	consoleListener = null;
}

/** Every console message so far: the console's buffer, Zotero's error list and what we captured. */
function startupMessages() {
	let early = [];
	try {
		early = Services.console.getMessageArray().map(describe);
	}
	catch (e) {}
	let zoteroErrors = [];
	try {
		zoteroErrors = Zotero.getErrors(false).map(describe);
	}
	catch (e) {}
	let seen = new Set();
	return [...early, ...zoteroErrors, ...messages].filter((m) => {
		let k = `${m.kind}|${m.text}|${m.source}`;
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
}

// ---------- helpers on the real Zotero ----------

function zb() {
	return Zotero.ZoteroBridge;
}

function mainWindow() {
	return Zotero.getMainWindow();
}

function setPref(key, value) {
	Zotero.Prefs.set(ZB_PREF + key, value, true);
}

async function dbTags(itemID) {
	return (await Zotero.DB.columnQueryAsync(
		"SELECT name FROM itemTags JOIN tags USING (tagID) WHERE itemID=?", [itemID])) || [];
}

async function createItem(type, fields, creators, tags, collectionID) {
	let item = new Zotero.Item(type);
	item.libraryID = Zotero.Libraries.userLibraryID;
	for (let [k, v] of Object.entries(fields)) item.setField(k, v);
	if (creators) item.setCreators(creators);
	for (let t of tags || []) item.addTag(t);
	if (collectionID) item.setCollections([collectionID]);
	await item.saveTx();
	return item;
}

async function listFiles(dir) {
	try {
		return await IOUtils.getChildren(dir);
	}
	catch (e) {
		return [];
	}
}

/** The vault note whose frontmatter has zotero_key "library/<key>". */
async function findNote(dir, key) {
	for (let path of await listFiles(dir)) {
		if (!path.endsWith(".md")) continue;
		let text = await IOUtils.readUTF8(path);
		if (text.includes(`zotero_key: "library/${key}"`)) return { path, text };
	}
	return null;
}

function frontmatter(text) {
	let m = /^---\n([\s\S]*?)\n---/.exec(text);
	return m ? m[1] : "";
}

function fmValue(fm, key) {
	let m = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(fm);
	return m ? m[1].trim().replace(/^"(.*)"$/, "$1") : undefined;
}

/**
 * Open the ZotMax toolbar menu as a click does, read what it shows (visible group IDs, entry
 * IDs and translated labels), close it again.
 */
async function openToolbarMenu(button) {
	let win = button.ownerGlobal;
	let popup = button.querySelector("menupopup");
	check(popup, "the toolbar button has no menupopup");
	popup.openPopup(button, "after_start", 0, 0, false, false);
	try {
		await waitFor(() => popup.state === "open", "the ZotMax toolbar menu to open", 10000);
		// Fluent translates the entries asynchronously
		await win.document.l10n.translateFragment(popup);
		let shown = el => !el.hidden;
		let groups = [...popup.querySelectorAll("[data-zb-group]")].filter(shown);
		let entries = [...popup.children].filter(el => el.hasAttribute("data-zb-entry") && shown(el));
		return {
			groups: groups.map(el => el.getAttribute("data-zb-group")),
			entries: entries.map(el => el.getAttribute("data-zb-entry")),
			labels: [...groups, ...entries].map(el => `${el.getAttribute("data-l10n-id")}: ${el.getAttribute("label") || ""}`),
			untranslated: [...groups, ...entries].filter(el => !(el.getAttribute("label") || "").trim()).map(el => el.getAttribute("data-l10n-id")),
		};
	}
	finally {
		popup.hidePopup();
		await waitFor(() => popup.state === "closed", "the ZotMax toolbar menu to close", 10000);
	}
}

const ctx = { l10nSourceErrors: [] };

// ---------- tests ----------

const TESTS = [
	{
		name: "ZotMax is installed and enabled (AddonManager)",
		async fn(d) {
			const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
			let addon = await AddonManager.getAddonByID(PLUGIN_ID);
			check(addon, `AddonManager does not know ${PLUGIN_ID}: the .xpi in <profile>/extensions was not picked up at startup`);
			Object.assign(d, {
				id: addon.id, name: addon.name, version: addon.version, isActive: addon.isActive, userDisabled: addon.userDisabled,
				appDisabled: addon.appDisabled, scope: addon.scope, type: addon.type,
			});
			check(addon.type === "extension", `add-on type is ${addon.type}, not "extension"`);
			check(addon.isActive, `the plugin is installed but not active (userDisabled=${addon.userDisabled}, appDisabled=${addon.appDisabled}, `
				+ `softDisabled=${addon.softDisabled}); appDisabled usually means Zotero rejected manifest.json (strict_min_version/strict_max_version)`);
			eq(addon.version, ctx.expectedVersion, "installed plugin version differs from manifest.json");
			// The display name is ZotMax; the ID stays the one earlier versions (Zotero Bridge) installed
			// under, so they update in place and keep their settings and keys
			eq(addon.name, "ZotMax", "add-on name (manifest.json name)");
			eq(addon.id, "zotero-bridge@bobyu89.github.io", "add-on ID");
		},
		// Startup errors are judged by "no plugin errors in the console during startup" (against the baseline)
		allowUnattributed: ["uncaught exception: undefined", "uncaught exception: undefined"],
	},
	{
		name: "Zotero.ZoteroBridge is set and has every module",
		async fn(d) {
			await waitFor(() => zb(), "Zotero.ZoteroBridge (set at the end of bootstrap.js startup(); "
				+ "if it never appears startup() threw — see the plugin errors)", 60000);
			let ZB = zb();
			eq(ZB.version, ctx.expectedVersion, "ZB.version (from bootstrap startup's version param)");
			const MODULES = {
				apaZh: ["formatReference", "isChineseItem", "options"],
				appraisalTools: ["getTool", "toolsForDesign", "findToolByName", "summarize", "toMarkdownTable", "toCSV", "toJSON", "fromJSON"],
				core: ["buildObsidianNote", "resolveRoute", "buildBaseFile", "buildNoteSections", "colorMeanings"],
				markdown: ["htmlToMd", "mdToHtml"],
				notion: ["NotionClient", "resolveSchema", "renamePlan", "pageProperty"],
				llm: ["generateNote", "extractStudyData"],
				synthesis: [],
				verify: ["verifyQuotes"],
				scanned: ["classifyFullText", "prepareAIInput", "countChars"],
				fulltextMd: ["toMarkdown", "trimForAI", "markHighlights", "buildFullTextNote", "notionChunks"],
				usage: ["recordUsage"],
				secrets: ["get", "set", "clear", "migrateFromPrefs", "createStore", "geckoBackend"],
				adapter: ["extractItemData", "paneData", "saveAINote", "getAINote", "toRegularItems"],
				fulltext: ["prepare", "render", "verifyAIHighlights", "writeObsidian", "writeNotion", "runMarkitdown"],
				bibliography: ["exportLibrary", "exportCollections", "citekeyFor", "afterSync"],
				images: ["collect"],
				status: ["runPass", "prepare", "setItemStatus"],
				reviewDraft: ["run"],
				screening: ["setDecision", "generateReport", "dedupCollection"],
				pubmedWatch: ["init", "shutdown", "runAll"],
				dashboard: ["update", "afterSync", "runFromMenu"],
				concepts: ["update", "afterSync", "dashboardSection", "runFromMenu", "synthesizeFromMenu"],
				classify: ["parseRules", "evaluate", "parseTopics", "suggest", "defaultPicks", "planApply", "apply", "undoLast", "readLastRun", "review", "renderReview", "run"],
				citationChase: ["chaseCollection", "chaseItems", "importChecked"],
				searchLinks: ["buildTarget", "itemTargets", "noteCallout", "calloutFor", "renderPaneRow", "quickSearch", "menuTargets", "relatedFor", "showMore", "openTarget"],
				aiBatch: ["submit", "check", "cancelAll", "init", "shutdown", "batchParams", "parseResults"],
				ebhcReport: ["run", "askOptions", "processReport", "buildReportNote"],
				appraisalForm: ["renderPaneRow", "syncInfo", "saveRecord", "stateFor", "exportSummary", "exportCollections"],
				appraisalCoach: ["readiness", "buildPrompt", "parseResponse", "verifyItems", "compare", "decide", "summaryLine", "run", "runFromCommand", "renderRowButton", "renderFormSection", "blockedReason"],
				progressReport: ["run", "askOptions", "logStatusChange", "latestReport"],
				features: ["isEnabled", "rawValue", "applyPreset", "currentPreset", "snapshot", "restore", "migrate", "gateMenus"],
				commands: ["get", "execute", "fromWindow", "fromContext", "isVisible", "availability", "paletteEntries", "search", "normalize", "openSettings"],
				menus: ["register", "buildEntries", "toolsEntries"],
				palette: ["open", "close", "render", "localize", "localizeStrings", "waitForDialog", "attach", "detach", "shutdown", "shortcutLabel"],
				setup: ["init", "shutdown", "open", "close", "render", "decide", "evidence", "checkVault", "checkNotion", "checkKey", "findItem"],
				toolbar: ["init", "add", "remove", "shutdown", "update"],
				sidepanel: ["init", "register", "render", "refreshAll", "addStylesheet", "removeStylesheet", "shutdown", "targetItem"],
				statsExplainer: ["init", "register", "shutdown", "explain", "explainCurrentSelection", "simplify", "saveToNote", "paneView", "renderPane", "onSelectionPopup", "methodsExcerpt", "checkExplanation", "appendStatsNote"],
				main: ["init", "shutdown", "run", "readSettings", "renderPane", "noteLinks", "saveQuietly", "renameNotionColumns", "notionClient", "prepareFullText", "batchStatus"],
			};
			let missing = [];
			for (let [mod, fns] of Object.entries(MODULES)) {
				if (!ZB[mod]) {
					missing.push(`ZB.${mod}`);
					continue;
				}
				for (let fn of fns) {
					if (typeof ZB[mod][fn] !== "function") missing.push(`ZB.${mod}.${fn}()`);
				}
			}
			d.modules = Object.keys(ZB).sort();
			check(!missing.length, `missing in the plugin scope: ${missing.join(", ")} (a content/*.js file failed to load, or bootstrap.js SCRIPTS is out of date)`);
			// Let startup's async work settle (secrets migration, the interrupted-batch reminder)
			await delay(3000);
		},
		// Still part of startup (it waits for startup() to finish): the l10n-registration errors can
		// arrive here instead of in the first test; the startup test judges them against the baseline
		allowUnattributed: ["uncaught exception: undefined", "uncaught exception: undefined"],
	},
	{
		name: "no plugin errors in the console during startup",
		async fn(d) {
			let all = startupMessages();
			let errors = all.filter(m => m.kind === "error");
			let errs = pluginErrors(all);
			d.consoleErrors = errors.slice(0, 10);
			d.pluginWarnings = all.filter(m => m.kind === "warning" && isPluginMessage(m)).slice(0, 20);
			check(!errs.length, `the plugin logged ${errs.length} error(s) while starting: `
				+ errs.slice(0, 3).map(m => `${m.text} (${m.source})`).join(" | "));
			// Errors without a source can't be attributed: compare with Zotero started without the plugin
			let baseline = null;
			try {
				baseline = JSON.parse(await IOUtils.readUTF8(PathUtils.join(workDir, "baseline.json")));
				let reg = baseline.diag && baseline.diag.registerMockSource;
				ctx.l10nSourceErrors = Array.isArray(reg) ? reg : [];
				// Sometimes the mock registration logs nothing within the wait, yet the same Zotero shows
				// the cause: re-translating its main window rejects with `undefined`. Registering the
				// plugin's l10n source re-translates the window, and that rejection then surfaces as
				// "uncaught exception: undefined" (no source, so it can't be ours)
				if (!ctx.l10nSourceErrors.length && baseline.diag && baseline.diag.translateRoots === "rejected: undefined") {
					ctx.l10nSourceErrors = ["uncaught exception: undefined"];
				}
				d.baselineDiagnostics = baseline.diag;
			}
			catch (e) {
				d.baseline = `no baseline.json (${e.message || e})`;
			}
			if (baseline) {
				let known = new Set(baseline.errors.map(m => m.text));
				d.baselineErrors = baseline.errors.map(m => m.text);
				// Zotero without the plugin logs these as soon as any l10n source is registered, which
				// Zotero.Plugins.registerLocales() does for every plugin with a locale/ folder
				// (as often as one registration logs them: the plugin's source is registered once at startup)
				let allowance = ctx.l10nSourceErrors.slice();
				d.explainedByL10nSourceRegistration = [];
				let extra = errors.filter((m) => {
					if (isPluginMessage(m) || known.has(m.text)) return false;
					let i = allowance.indexOf(m.text);
					if (i === -1) return true;
					allowance.splice(i, 1);
					d.explainedByL10nSourceRegistration.push(m.text);
					return false;
				});
				d.notInBaseline = extra;
				check(!extra.length, `console error(s) at startup that Zotero without the plugin does not log: `
					+ extra.slice(0, 3).map(m => `${m.text} (${m.source || "no source"})`).join(" | "));
			}
		},
	},
	{
		name: "menus are registered with Zotero.MenuManager",
		needs: ["Zotero.ZoteroBridge is set and has every module"],
		async fn(d) {
			let manager = Zotero.MenuManager && Zotero.MenuManager._menuManager;
			check(manager && Array.isArray(manager.options), "cannot read Zotero.MenuManager registrations (_menuManager.options) — MenuManager API changed?");
			let mine = manager.options.filter(o => o.pluginID === PLUGIN_ID);
			// One registration per menu, generated from the command catalog (content/commands.js, menus.js)
			const EXPECTED = {
				"zotero-bridge-item": "main/library/item",
				"zotero-bridge-collection": "main/library/collection",
				"zotero-bridge-tools": "main/menubar/tools",
			};
			d.registered = mine.map(o => `${o.menuID} → ${o.target}`);
			let problems = [];
			for (let [id, target] of Object.entries(EXPECTED)) {
				let full = CSS.escape(`${PLUGIN_ID}-${id}`);
				let opt = mine.find(o => o.menuID === full || o.menuID === id);
				if (!opt) problems.push(`${id} not registered (registerMenu() returned false — see "MenuAPI:" warnings in zotero.log)`);
				else if (opt.target !== target) problems.push(`${id} has target ${opt.target}, expected ${target}`);
			}
			let unexpected = mine.filter(o => !Object.keys(EXPECTED).some(id => o.menuID === id || o.menuID === CSS.escape(`${PLUGIN_ID}-${id}`)));
			if (unexpected.length) problems.push(`registrations besides the three menus: ${unexpected.map(o => o.menuID).join(", ")}`);
			// The right-click menus: one 「ZotMax ▸」 submenu each; at most two levels below it
			for (let id of ["zotero-bridge-item", "zotero-bridge-collection"]) {
				let opt = mine.find(o => o.menuID === id || o.menuID === CSS.escape(`${PLUGIN_ID}-${id}`));
				if (!opt) continue;
				if (opt.menus.length !== 1 || opt.menus[0].menuType !== "submenu" || opt.menus[0].l10nID !== "zotero-bridge-menu") {
					problems.push(`${id}: not one ZotMax submenu (${opt.menus.map(m => m.l10nID || m.menuType).join(", ")})`);
					continue;
				}
				for (let child of opt.menus[0].menus) {
					if ((child.menus || []).some(m => m.menuType === "submenu")) problems.push(`${id}: ${child.l10nID} has a third level`);
				}
			}
			// The Tools menu: settings, 快速指令, and the batch entries (shown only while they apply)
			let tools = mine.find(o => o.target === "main/menubar/tools");
			d.tools = tools ? tools.menus.map(m => m.l10nID) : [];
			let toolsWant = ["zotero-bridge-menu-settings", "zotero-bridge-menu-palette", "zotero-bridge-menu-resume", "zotero-bridge-menu-stop",
				"zotero-bridge-menu-discard", "zotero-bridge-menu-ai-batch-check", "zotero-bridge-menu-ai-batch-cancel"];
			if (JSON.stringify(d.tools) !== JSON.stringify(toolsWant)) problems.push(`Tools menu entries ${JSON.stringify(d.tools)}, expected ${JSON.stringify(toolsWant)}`);
			check(!problems.length, problems.join("; "));
			// Every l10n ID used by the menus, for the Fluent check
			ctx.l10n = ctx.l10n || new Map();
			let walk = (menus) => {
				for (let m of menus || []) {
					if (m.l10nID) ctx.l10n.set(m.l10nID, m.l10nArgs || null);
					walk(m.menus);
				}
			};
			for (let o of mine) walk(o.menus);
			d.l10nIDs = ctx.l10n.size;
		},
	},
	{
		name: "preferences pane is registered",
		needs: ["Zotero.ZoteroBridge is set and has every module"],
		async fn(d) {
			let pane = (Zotero.PreferencePanes.pluginPanes || []).find(p => p.id === PANE_ID);
			check(pane, `Zotero.PreferencePanes has no pane "${PANE_ID}" (register() in bootstrap startup failed)`);
			// Zotero keeps a plain-text label as rawLabel (label is for Fluent IDs); accept either
			// (older/newer Zotero versions differ in the property name, so fall back to any field holding it)
			let label = pane.rawLabel || pane.label || Object.values(pane).find(v => typeof v == "string" && v == "ZotMax");
			d.paneKeys = Object.keys(pane).map(String);
			Object.assign(d, { pluginID: pane.pluginID, src: pane.src, scripts: Array.from(pane.scripts || [], String), label: String(label), rawLabel: String(pane.rawLabel), l10nLabel: String(pane.label) });
			eq(pane.pluginID, PLUGIN_ID, "pane pluginID");
			eq(label, "ZotMax", "pane label (the settings sidebar entry)");
			check(/content\/preferences\.xhtml$/.test(pane.src), `pane src is ${pane.src}`);
			check((pane.scripts || []).some(s => /content\/preferences\.js$/.test(s)), "pane scripts do not include content/preferences.js");
		},
	},
	{
		name: "item pane section is registered",
		needs: ["Zotero.ZoteroBridge is set and has every module"],
		async fn(d) {
			let data = Zotero.ItemPaneManager.customSectionData;
			let mine = Array.from(data.options || []).filter(o => o.pluginID === PLUGIN_ID);
			d.sections = mine.map(o => String(o.paneID));
			eq(mine.length, 1, "number of item pane sections registered by the plugin");
			let section = mine[0];
			check(/zotero-bridge-ai-note$/.test(section.paneID), `unexpected paneID ${section.paneID}`);
			check(typeof section.onRender === "function", "section has no onRender hook");
			check(section.header && section.header.l10nID, "section header has no l10nID");
			check(section.sidenav && section.sidenav.l10nID, "section sidenav has no l10nID");
			ctx.paneKey = section.paneID;
			ctx.l10n = ctx.l10n || new Map();
			ctx.l10n.set(section.header.l10nID, null);
			ctx.l10n.set(section.sidenav.l10nID, null);
		},
	},
	{
		name: "Fluent strings resolve for every l10n ID (en-US and zh-TW)",
		needs: ["menus are registered with Zotero.MenuManager", "item pane section is registered"],
		async fn(d) {
			// Also every message the plugin ships, so zh-TW can't silently miss one
			let root = await Zotero.Plugins.getRootURI(PLUGIN_ID);
			let ftl = await Zotero.File.getResourceAsync(root + "locale/en-US/zotero-bridge.ftl");
			for (let m of ftl.matchAll(/^([a-z][a-z0-9-]*)\s*=/gm)) {
				if (!ctx.l10n.has(m[1])) ctx.l10n.set(m[1], null);
			}
			let ids = [...ctx.l10n.keys()];
			let args = { count: 3, reason: "E2E", name: "E2E", preset: "guided", req: "sync", color: "yellow", feature: "E2E", query: "E2E", shortcut: "E2E", error: "E2E" };
			let report = {};
			let problems = [];
			for (let locale of ["en-US", "zh-TW"]) {
				let l10n;
				try {
					l10n = new Localization(["zotero-bridge.ftl"], false, undefined, [locale]);
				}
				catch (e) {
					problems.push(`new Localization(…, ["${locale}"]) failed: ${e}`);
					continue;
				}
				let msgs = await l10n.formatMessages(ids.map(id => ({ id, args })));
				let missing = [];
				let oldName = [];
				ids.forEach((id, i) => {
					let m = msgs[i];
					let text = m && (m.value || (m.attributes || []).map(a => a.value).join(""));
					if (!text || !text.trim()) missing.push(id);
					else if (/Zotero Bridge/.test(text)) oldName.push(id);
				});
				report[locale] = { checked: ids.length, missing, oldName };
				if (missing.length) problems.push(`${locale}: no text for ${missing.join(", ")}`);
				if (oldName.length) problems.push(`${locale}: the old name Zotero Bridge shows in ${oldName.join(", ")}`);
				let [label] = await l10n.formatMessages([{ id: "zotero-bridge-menu-settings" }]);
				report[locale].sample = label && label.attributes && label.attributes[0] && String(label.attributes[0].value);
				if (!/^ZotMax /.test(report[locale].sample || "")) problems.push(`${locale}: Tools menu settings entry is ${JSON.stringify(report[locale].sample)}, expected it to start with ZotMax`);
			}
			// The main window must have the FTL linked (bootstrap onMainWindowLoad)
			let doc = mainWindow().document;
			let link = doc.querySelector('link[rel="localization"][href="zotero-bridge.ftl"]');
			if (!link) problems.push("main window has no <link rel=\"localization\" href=\"zotero-bridge.ftl\"> (onMainWindowLoad did not run insertFTLIfNeeded)");
			let docMsgs = await doc.l10n.formatMessages(ids.map(id => ({ id, args })));
			let docMissing = ids.filter((id, i) => !docMsgs[i]);
			if (docMissing.length) problems.push(`main window document.l10n cannot format ${docMissing.join(", ")}`);
			d.locales = report;
			check(!problems.length, problems.join("; "));
		},
	},
	{
		name: "menus render with translated labels (MenuManager.updateMenuPopup)",
		needs: ["menus are registered with Zotero.MenuManager"],
		async fn(d) {
			let win = mainWindow();
			let doc = win.document;
			let rendered = {};
			let problems = [];
			for (let target of ["main/library/item", "main/library/collection", "main/menubar/tools"]) {
				let popup = doc.createXULElement("menupopup");
				(doc.querySelector("popupset") || doc.documentElement).append(popup);
				try {
					Zotero.MenuManager.updateMenuPopup(popup, target, {
						getContext: () => ({ items: [], collectionTreeRows: [], tabType: "library", tabSubType: undefined }),
						tabType: "library",
						skipGrouping: true,
					});
					// Open the submenus as Gecko does (popupshowing builds their entries): the 「ZotMax ▸」
					// submenu, then the variant submenus inside it (篩選, 在醫學資料庫搜尋)
					let opened = new Set();
					for (let round = 0; round < 3; round++) {
						for (let sub of popup.querySelectorAll("menupopup")) {
							if (opened.has(sub)) continue;
							opened.add(sub);
							sub.dispatchEvent(new win.Event("popupshowing"));
						}
					}
					d.submenusOpened = (d.submenusOpened || 0) + opened.size;
					let ours = [...popup.querySelectorAll("[data-l10n-id]")].filter(e => e.dataset.l10nId.startsWith("zotero-bridge-"));
					// Labels with variables get their args in onShowing; give them some here
					for (let el of ours) {
						if (!el.dataset.l10nArgs) el.dataset.l10nArgs = JSON.stringify({ count: 3, reason: "E2E", name: "E2E" });
					}
					await doc.l10n.translateFragment(popup);
					rendered[target] = ours.map(e => `${e.dataset.l10nId}: ${e.getAttribute("label")}`);
					if (!ours.length) problems.push(`${target}: no ZotMax menu elements were created`);
					// The submenus' entries were built too: group captions and commands from the catalog
					if (target !== "main/menubar/tools" && !ours.some(e => e.dataset.l10nId === "zotero-bridge-toolbar-group-sync")) {
						problems.push(`${target}: the ZotMax submenu built no entries when it opened`);
					}
					for (let el of ours) {
						if (!(el.getAttribute("label") || "").trim()) problems.push(`${target}: ${el.dataset.l10nId} has no label after translation`);
					}
				}
				finally {
					popup.remove();
				}
			}
			d.rendered = rendered;
			check(!problems.length, problems.join("; "));
		},
	},
	{
		name: "toolbar button in the main window: place, label, icon, size, translated menu, keyboard, switch",
		needs: ["Zotero.ZoteroBridge is set and has every module"],
		async fn(d) {
			let win = mainWindow();
			let doc = win.document;
			let T = zb().toolbar;
			let button = await waitFor(() => doc.getElementById(T.BUTTON_ID),
				"the ZotMax toolbar button (bootstrap onMainWindowLoad → ZB.toolbar.add)", 10000);
			eq(doc.querySelectorAll("#" + T.BUTTON_ID).length, 1, "toolbar buttons in the main window");
			d.parent = button.parentNode && button.parentNode.id;
			eq(d.parent, "zotero-items-toolbar", "the toolbar holding the button");
			eq(button.previousElementSibling && button.previousElementSibling.id, "zotero-tb-note-add", "the button's neighbour on the left");
			eq(button.getAttribute("aria-label"), "ZotMax", "aria-label");
			eq(button.getAttribute("tooltiptext"), "ZotMax", "tooltiptext");
			eq(button.getAttribute("type"), "menu", "button type");
			check(button.classList.contains("zotero-tb-button"), "the button lacks Zotero's zotero-tb-button class");
			check(!button.hidden, "the button is hidden although 工具列按鈕 is on");
			// toolbar.css is applied: the plugin's icon, at the size of Zotero's own buttons
			d.listStyleImage = win.getComputedStyle(button).listStyleImage;
			check(/bridge\.svg/.test(d.listStyleImage), `list-style-image is ${d.listStyleImage} (is content/toolbar.css loaded?)`);
			let note = doc.getElementById("zotero-tb-note-add");
			let size = (el) => {
				let r = el.getBoundingClientRect();
				return `${Math.round(r.width)}x${Math.round(r.height)}`;
			};
			d.size = size(button);
			d.noteAddSize = size(note);
			eq(d.size, d.noteAddSize, "button size (width x height) compared with Zotero's 新增筆記 menu button");
			let icon = button.querySelector(".toolbarbutton-icon");
			let noteIcon = note.querySelector(".toolbarbutton-icon");
			if (icon && noteIcon) {
				d.iconSize = size(icon);
				eq(d.iconSize, size(noteIcon), "icon size compared with 新增筆記");
			}
			// The menu as a click opens it: labelled groups, every entry translated, 設定… last
			let menu = await openToolbarMenu(button);
			d.menu = menu.labels;
			check(menu.groups.length > 0, "no group shows in the toolbar menu");
			check(!menu.untranslated.length, `toolbar menu entries without a label: ${menu.untranslated.join(", ")}`);
			eq(menu.entries[menu.entries.length - 1], "settings", "last entry of the toolbar menu");
			eq(menu.entries[0], "palette", "first entry of the toolbar menu (快速指令…)");
			// Keyboard: Zotero's arrow-key row continues from 新增筆記 to the button and back
			note.focus();
			note.dispatchEvent(new win.KeyboardEvent("keydown", { key: Zotero.arrowNextKey, bubbles: true, cancelable: true }));
			eq(doc.activeElement && doc.activeElement.id, T.BUTTON_ID, "focus after ArrowNext on 新增筆記");
			button.dispatchEvent(new win.KeyboardEvent("keydown", { key: Zotero.arrowPreviousKey, bubbles: true, cancelable: true }));
			eq(doc.activeElement && doc.activeElement.id, "zotero-tb-note-add", "focus after ArrowPrevious on the button");
			note.blur();
			// The 工具列按鈕 switch hides it live
			try {
				zb().features.setEnabled("toolbarButton", false);
				await waitFor(() => button.hidden, "the button to hide with 工具列按鈕 off", 5000);
			}
			finally {
				Zotero.Prefs.clear(ZB_PREF + "feature.toolbarButton", true);
			}
			await waitFor(() => !button.hidden, "the button to come back with 工具列按鈕 on", 5000);
		},
	},
	{
		name: "快速指令 opens from chrome://zotero-bridge/, finds 分類 first, closes with Esc; Ctrl/Cmd+Shift+P opens it",
		needs: ["Zotero.ZoteroBridge is set and has every module"],
		timeout: 60000,
		async fn(d) {
			let P = zb().palette;
			let win = mainWindow();
			let dialog = null;
			try {
				let view = null;
				dialog = await P.open(win, { onOpen: (w, v) => {
					view = v;
				} });
				check(dialog && view, "ZB.palette.open() did not show the palette (see the plugin errors)");
				let doc = dialog.document;
				d.url = doc.documentURI;
				eq(doc.documentURI, P.DIALOG_URL, "palette window URL");
				await waitFor(() => /ZotMax/.test(doc.title), "the palette window title to name ZotMax", 10000);
				d.title = String(doc.title);
				let root = doc.getElementById(P.DIALOG_ROOT);
				// palette.css is applied (registered chrome package)
				d.rootDisplay = dialog.getComputedStyle(root).display;
				eq(d.rootDisplay, "flex", "display of #zb-palette (is palette.css loaded?)");
				let input = doc.getElementById("zb-pal-input");
				eq(input.getAttribute("role"), "combobox", "role of the search field");
				check(doc.querySelector('label[for="zb-pal-input"]'), "the search field has no label");
				d.groups = [...root.querySelectorAll(".zb-pal-group-title")].map(t => t.textContent);
				check(d.groups.length >= 5, `group titles: ${JSON.stringify(d.groups)}`);
				// Type 分類 as a user does
				input.focus();
				input.value = "分類";
				input.dispatchEvent(new dialog.Event("input", { bubbles: true }));
				let options = [...root.querySelectorAll('[role="option"]')];
				d.results = options.slice(0, 5).map(o => `${o.getAttribute("data-zb-entry")}: ${o.querySelector(".zb-pal-name").textContent}`);
				check(options.length > 0, "no results for 分類");
				eq(options[0].getAttribute("data-zb-entry"), "classify", "first result for 分類");
				eq(options[0].getAttribute("aria-selected"), "true", "the first result is the active one");
				eq(input.getAttribute("aria-activedescendant"), options[0].id, "aria-activedescendant");
				check(!/\{ ?\$/.test(root.textContent), "a Fluent placeholder shows in the palette");
				// Esc closes it, running nothing
				input.dispatchEvent(new dialog.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
				await waitFor(() => dialog.closed, "the palette to close on Esc", 10000);
				check(!P.isOpen, "ZB.palette.isOpen after Esc");
				// The shortcut is registered in the main window, and opens the palette
				d.shortcut = P.shortcutLabel();
				eq(d.shortcut, Zotero.isMac ? "⇧⌘P" : "Ctrl+Shift+P", "shortcut");
				check(P.windowCount >= 1, "no main window listens for the shortcut");
				win.focus();
				win.document.documentElement.dispatchEvent(new win.KeyboardEvent("keydown", {
					key: "P", code: "KeyP", shiftKey: true, ctrlKey: !Zotero.isMac, metaKey: !!Zotero.isMac, bubbles: true, cancelable: true,
				}));
				await waitFor(() => P.isOpen, "the shortcut to open the palette", 10000);
				P.close();
			}
			finally {
				P.close();
				if (dialog && !dialog.closed) dialog.close();
			}
		},
	},
	{
		name: "secrets round-trip through the real login manager (and OS key store)",
		needs: ["Zotero.ZoteroBridge is set and has every module"],
		async fn(d) {
			let S = zb().secrets;
			const SECRET = "ntn_e2e_secret_value_123";
			// Is the OS key store usable here? (gnome-keyring is started by test/e2e/run.sh when possible)
			let ks = Zotero.OSKeyStore;
			let usable = false;
			if (ks && ks.available) {
				try {
					usable = ks.isEncrypted(await ks.encrypt("probe"));
				}
				catch (e) {
					d.keyStoreError = String(e.message || e);
				}
			}
			ctx.keyStoreUsable = usable;
			d.osKeyStore = ks ? (usable ? "usable" : "present but unusable") : "missing (Zotero.OSKeyStore undefined)";
			if (ctx.expectKeyStore) {
				check(usable, `the OS key store should work in this run (gnome-keyring was started) but Zotero.OSKeyStore.encrypt failed: ${d.keyStoreError || "not available"}`);
			}

			await S.clear("notionToken");
			eq(await S.get("notionToken"), "", "notionToken after clear()");
			await S.set("notionToken", SECRET);
			eq(await S.get("notionToken"), SECRET, "notionToken read back after set()");
			let logins = (await Services.logins.searchLoginsAsync({ origin: S.ORIGIN, httpRealm: S.REALM }))
				.filter(l => l.username === "notionToken");
			eq(logins.length, 1, `logins under ${S.ORIGIN} for notionToken`);
			let stored = logins[0].password;
			if (usable) {
				check(ks.isEncrypted(stored), "the OS key store works but the login manager holds the secret unencrypted");
				check(!stored.includes(SECRET), "encrypted login still contains the plaintext");
				d.storage = "login manager, encrypted with Zotero.OSKeyStore";
			}
			else {
				// Documented fallback (secrets.js encode()): keep it in the login manager unencrypted
				eq(stored, SECRET, "fallback without an OS key store: the login manager should hold the value as is");
				d.storage = "login manager, unencrypted (documented fallback without an OS key store)";
			}
			check(!Zotero.Prefs.get(ZB_PREF + "notion.token", true), "the secret leaked into prefs (extensions.zotero-bridge.notion.token)");
			// A fresh store (no cache) reads it from the login manager
			let fresh = S.createStore(S.geckoBackend());
			eq(await fresh.get("notionToken"), SECRET, "a new store (no cache) reading the login manager");
			await S.clear("notionToken");
			eq(await S.createStore(S.geckoBackend()).get("notionToken"), "", "after clear(), a new store");
			let left = (await Services.logins.searchLoginsAsync({ origin: S.ORIGIN, httpRealm: S.REALM }))
				.filter(l => l.username === "notionToken");
			eq(left.length, 0, "logins left after clear()");

			// Migration of a secret from an old plain pref (versions before 0.3)
			Zotero.Prefs.set(ZB_PREF + "llm.openaiKey", "sk-e2e-old-pref", true);
			let migrated = await S.createStore(S.geckoBackend()).migrateFromPrefs();
			check(migrated.includes("openaiKey"), `migrateFromPrefs() returned ${JSON.stringify(migrated)}`);
			check(!Zotero.Prefs.get(ZB_PREF + "llm.openaiKey", true), "old pref llm.openaiKey not cleared after migration");
			eq(await S.createStore(S.geckoBackend()).get("openaiKey"), "sk-e2e-old-pref", "openaiKey after migration");
			await S.clear("openaiKey");
		},
	},
	{
		name: "create items with PDF attachments in the real library",
		needs: ["Zotero.ZoteroBridge is set and has every module"],
		async fn(d) {
			let collection = new Zotero.Collection();
			collection.libraryID = Zotero.Libraries.userLibraryID;
			collection.name = "E2E Review";
			await collection.saveTx();
			ctx.collection = collection;
			let english = await createItem("journalArticle", {
				title: "Exercise and falls", date: "2021", publicationTitle: "Geriatric Nursing",
				volume: "42", issue: "3", pages: "100-110", DOI: "10.1016/j.gerinurse.2021.01.001",
				abstractNote: "Exercise programmes reduce falls in older adults.", language: "en",
			}, [
				{ lastName: "Lee", firstName: "Anna", creatorType: "author" },
				{ lastName: "陳", firstName: "美玲", creatorType: "author" },
			], ["falls", "nursing", "狀態/閱讀中 📖"], collection.id);
			let chinese = await createItem("journalArticle", {
				title: "護理人員跌倒預防衛教之成效", date: "2023", language: "zh",
				publicationTitle: "護理雜誌", volume: "70", issue: "2", pages: "45-56", DOI: "10.6224/JN.202304_70(2).07",
			}, [
				{ lastName: "陳", firstName: "美玲", creatorType: "author" },
				{ name: "林小華", creatorType: "author" },
				{ lastName: "歐", firstName: "陽志明", creatorType: "author" },
			], ["跌倒"], collection.id);
			let book = await createItem("book", {
				title: "Nursing research methods", date: "2019", publisher: "Example Press",
			}, [{ lastName: "Smith", firstName: "John", creatorType: "author" }], [], collection.id);
			let extra1 = await createItem("journalArticle", { title: "Balance training in nursing homes", date: "2020" },
				[{ lastName: "Wong", firstName: "Kim", creatorType: "author" }], [], collection.id);
			let extra2 = await createItem("journalArticle", { title: "Hip protectors: a cohort study", date: "2018" },
				[{ lastName: "Garcia", firstName: "Ana", creatorType: "author" }], [], collection.id);

			let note = new Zotero.Item("note");
			note.libraryID = english.libraryID;
			note.parentID = english.id;
			note.setNote("<p><strong>E2E child note</strong>: balance training matters.</p>");
			await note.saveTx();

			let fixtures = PathUtils.join(workDir, "fixtures");
			let textPDF = await Zotero.Attachments.importFromFile({ file: PathUtils.join(fixtures, "text.pdf"), parentItemID: english.id });
			let scanPDF = await Zotero.Attachments.importFromFile({ file: PathUtils.join(fixtures, "scan.pdf"), parentItemID: chinese.id });
			check(textPDF && textPDF.isPDFAttachment(), "text.pdf was not imported as a PDF attachment");
			check(scanPDF && scanPDF.isPDFAttachment(), "scan.pdf was not imported as a PDF attachment");
			Object.assign(ctx, { english, chinese, book, extra1, extra2, note, textPDF, scanPDF });
			d.items = { english: english.key, chinese: chinese.key, book: book.key, textPDF: textPDF.key, scanPDF: scanPDF.key };
		},
	},
	{
		name: "full-text status from the real PDF worker (ZB.scanned via ZB.adapter)",
		needs: ["create items with PDF attachments in the real library"],
		async fn(d) {
			let A = zb().adapter;
			let expect = [["english", "ok"], ["chinese", "none"], ["book", "no_pdf"]];
			let problems = [];
			for (let [name, status] of expect) {
				let data = await A.extractItemData(ctx[name], { checkFullText: true });
				let src = data.fullTextSource;
				d[name] = { status: data.fullTextStatus, chars: src && src.chars, pages: src && src.pages };
				if (data.fullTextStatus !== status) {
					problems.push(`${name}: fullTextStatus ${data.fullTextStatus}, expected ${status} (source: ${JSON.stringify(d[name])})`);
				}
			}
			// The PDF worker itself, for the record
			let text = await Zotero.PDFWorker.getFullText(ctx.textPDF.id, 1);
			d.pdfWorker = { textPDF: { chars: zb().scanned.countChars(text.text), totalPages: text.totalPages } };
			if (d.english.pages !== 1) problems.push(`text.pdf page count ${d.english.pages}, expected 1 (Zotero.Fulltext.getPages / PDFWorker)`);
			check(!problems.length, problems.join("; "));
		},
	},
	{
		name: "sync to Obsidian writes notes, frontmatter, .base and Chinese APA (ZB.main.run, ai: none)",
		needs: ["create items with PDF attachments in the real library"],
		async fn(d) {
			let vault = PathUtils.join(workDir, "vault");
			await IOUtils.makeDirectory(vault, { createAncestors: true, ignoreExisting: true });
			ctx.vault = vault;
			ctx.noteDir = PathUtils.join(vault, "Zotero");
			setPref("obsidian.vaultPath", vault);
			setPref("export.bibtex", true);
			// A red highlight on the text PDF: coloured in place in the full-text note (fulltext.js)
			let highlight = new Zotero.Item("annotation");
			// The library first: the annotation setters look the parent attachment up by library and key
			highlight.libraryID = ctx.textPDF.libraryID;
			highlight.parentID = ctx.textPDF.id;
			highlight.annotationType = "highlight";
			highlight.annotationText = "The intervention reduced the rate of falls by thirty percent compared with usual care.";
			highlight.annotationColor = "#ff6666";
			highlight.annotationPageLabel = "1";
			highlight.annotationSortIndex = "00000|000500|00300";
			highlight.annotationPosition = JSON.stringify({ pageIndex: 0, rects: [[40, 600, 420, 610]] });
			await highlight.saveTx();
			ctx.highlight = highlight;
			let items = [ctx.english, ctx.chinese, ctx.book, ctx.extra1, ctx.extra2];
			await zb().main.run(items, { targets: ["obsidian"], ai: "none" });
			let problems = [];
			let notes = {};
			for (let name of ["english", "chinese", "book", "extra1", "extra2"]) {
				let n = await findNote(ctx.noteDir, ctx[name].key);
				if (!n) {
					problems.push(`no note with zotero_key "library/${ctx[name].key}" (${name}) in ${ctx.noteDir}`);
					continue;
				}
				notes[name] = n;
			}
			check(!problems.length, problems.join("; ") + `; files: ${(await listFiles(ctx.noteDir)).map(p => PathUtils.filename(p)).join(", ")}`);
			ctx.notes = notes;
			let fm = name => frontmatter(notes[name].text);
			let expectFM = (name, key, want) => {
				let got = fmValue(fm(name), key);
				if (got !== want) problems.push(`${name} note: ${key} is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
			};
			expectFM("english", "zotero_key", `library/${ctx.english.key}`);
			expectFM("english", "status", "閱讀中");
			expectFM("english", "full_text", "ok");
			expectFM("chinese", "full_text", "none");
			expectFM("book", "full_text", "no_pdf");
			expectFM("chinese", "citekey", "陳2023護理人員");
			expectFM("english", "citekey", "lee2021exercise");
			expectFM("chinese", "status", "待讀");
			let en = notes.english.text;
			let zh = notes.chinese.text;
			if (!/^> \*\*APA 7\*\*: 陳美玲、林小華、歐陽志明（2023）。護理人員跌倒預防衛教之成效。\*護理雜誌，70\*\(2\)，45–56。https:\/\/doi\.org\/10\.6224\/JN\.202304_70\(2\)\.07$/m.test(zh)) {
				problems.push(`Chinese APA line wrong: ${(/^.*APA 7.*$/m.exec(zh) || ["(no APA line)"])[0]}`);
			}
			if (!/^authors:\n {2}- "陳美玲"\n {2}- "林小華"\n {2}- "歐陽志明"$/m.test(zh)) problems.push("Chinese note authors are not the full names 陳美玲, 林小華, 歐陽志明");
			// English item: Zotero's own citeproc APA (with a Chinese co-author)
			if (!/^> \*\*APA 7\*\*: Lee, A\., & 陳/m.test(en)) {
				problems.push(`English APA line (Zotero citeproc) wrong: ${(/^.*APA 7.*$/m.exec(en) || ["(no APA line)"])[0]}`);
			}
			if (!en.includes("E2E child note")) problems.push("English note does not contain the child note text");
			// The compact layout: 「重點」 first in the managed block, the highlight under its colour's meaning
			if (!/%% zotero-bridge:start[^\n]*%%\n\n> \[!abstract\] 重點\n/.test(en)) problems.push("English note has no 「重點」 block at the top of the managed region");
			if (!/^> \[!quote\]- 🔴 限制／疑問（1）\n> - ==🔴The intervention reduced the rate of falls by thirty percent compared with usual care\.== · \[p\. 1\]/m.test(en)) {
				problems.push("English note does not list the red highlight under 限制／疑問");
			}
			// The full-text note next to it (全文筆記 is on in 研究生引導), with the highlight coloured in place
			let fullTextPath = PathUtils.join(ctx.noteDir, "全文", PathUtils.filename(notes.english.path));
			if (!(await IOUtils.exists(fullTextPath))) {
				problems.push(`no full-text note ${fullTextPath}; files in 全文: ${(await listFiles(PathUtils.join(ctx.noteDir, "全文"))).map(p => PathUtils.filename(p)).join(", ")}`);
			}
			else {
				let ft = await IOUtils.readUTF8(fullTextPath);
				d.fullTextHead = ft.slice(0, 600);
				if (!ft.includes(`fulltext_of: "library/${ctx.english.key}"`)) problems.push("full-text note lacks fulltext_of");
				if (/zotero_key:/.test(ft)) problems.push("full-text note has a zotero_key (it would be indexed as a literature note)");
				if (!/==🔴The intervention reduced the rate of falls by thirty percent compared with usual care==/.test(ft)) {
					problems.push(`full-text note does not colour the highlight in place: ${(/^.*thirty percent.*$/m.exec(ft) || ["(sentence not found)"])[0]}`);
				}
				if (!en.includes(`fulltext: "[[Zotero/全文/${PathUtils.filename(notes.english.path).replace(/\.md$/, "")}]]"`)) problems.push("English note does not link to its full-text note");
			}
			if (await IOUtils.exists(PathUtils.join(ctx.noteDir, "全文", PathUtils.filename(notes.chinese.path)))) {
				problems.push("a full-text note was written for the scanned PDF (no text layer)");
			}
			if (!/^tags:\n(?: {2}- .*\n)*? {2}- "?falls"?$/m.test(fm("english") + "\n")) problems.push("English note frontmatter tags do not include falls");
			if (!/^collections:\n {2}- "?E2E Review"?$/m.test(fm("english"))) problems.push("English note frontmatter collections do not include E2E Review");
			let base = PathUtils.join(ctx.noteDir, "Zotero 文獻庫.base");
			if (!(await IOUtils.exists(base))) problems.push(`no Obsidian Bases file ${base}`);
			else if (!(await IOUtils.readUTF8(base)).includes("zotero_key")) problems.push("the .base file does not filter on zotero_key");
			d.files = (await listFiles(ctx.noteDir)).map(p => PathUtils.filename(p));
			d.englishFrontmatter = fm("english");
			d.chineseAPA = (/^.*APA 7.*$/m.exec(zh) || [""])[0];
			d.englishAPA = (/^.*APA 7.*$/m.exec(en) || [""])[0];
			eq(zb().main.readPendingBatch(), null, "pending batch after a completed run");
			check(!problems.length, problems.join("; "));
		},
	},
	{
		name: "reading status is written to the real Zotero item (ZB.status)",
		needs: ["sync to Obsidian writes notes, frontmatter, .base and Chinese APA (ZB.main.run, ai: none)"],
		async fn(d) {
			// The first sync gave the Chinese item (no status tag) the default status
			let zhTags = await dbTags(ctx.chinese.id);
			d.chineseTagsAfterSync = zhTags;
			check(zhTags.includes("狀態/待讀"), `after the sync the Chinese item should have the tag 狀態/待讀 in the database, has ${JSON.stringify(zhTags)}`);
			// Mark the English note as read in Obsidian, then run the status pass (Tools menu)
			let path = ctx.notes.english.path;
			let text = await IOUtils.readUTF8(path);
			let edited = text.replace(/^status:.*$/m, "status: \"已讀\"");
			check(edited !== text, "could not find status: in the English note");
			await IOUtils.writeUTF8(path, edited);
			let counts = await zb().status.runPass();
			d.counts = counts;
			check(counts && counts.zotero >= 1, `ZB.status.runPass() updated ${counts && counts.zotero} Zotero items, expected at least 1 (counts ${JSON.stringify(counts)})`);
			let tags = await dbTags(ctx.english.id);
			d.englishTags = tags;
			check(tags.includes("狀態/已讀 ✅"), `the English item should have the tag "狀態/已讀 ✅" in the database, has ${JSON.stringify(tags)}`);
			check(!tags.includes("狀態/閱讀中 📖"), "the old status tag 狀態/閱讀中 📖 was not removed");
		},
	},
	{
		name: "bibliography export writes references.json (itemToCSLJSON) and references.bib",
		needs: ["sync to Obsidian writes notes, frontmatter, .base and Chinese APA (ZB.main.run, ai: none)"],
		async fn(d) {
			await zb().bibliography.exportLibrary();
			let path = PathUtils.join(ctx.noteDir, "references.json");
			check(await IOUtils.exists(path), `${path} was not written`);
			let entries = JSON.parse(await IOUtils.readUTF8(path));
			check(Array.isArray(entries), "references.json is not a JSON array");
			let regular = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true)).filter(i => i.isRegularItem() && !i.deleted);
			eq(entries.length, regular.length, "entries in references.json vs regular items in the library");
			let ids = entries.map(e => e.id);
			d.ids = ids;
			let en = entries.find(e => e.id === "lee2021exercise");
			check(en, `no entry with id lee2021exercise (ids: ${ids.join(", ")})`);
			eq(en.type, "article-journal", "CSL type of the English article");
			eq(en.title, "Exercise and falls", "CSL title");
			eq(en["citation-key"], "lee2021exercise", "citation-key");
			check(Array.isArray(en.author) && en.author[0].family === "Lee", `CSL author ${JSON.stringify(en.author)}`);
			check(en.DOI === "10.1016/j.gerinurse.2021.01.001", `CSL DOI ${en.DOI}`);
			let zh = entries.find(e => e.id === "陳2023護理人員");
			check(zh, `no entry for the Chinese item (陳2023護理人員) — the citekey must match the note's citekey`);
			d.chineseEntry = zh;
			let bib = PathUtils.join(ctx.noteDir, "references.bib");
			check(await IOUtils.exists(bib), "references.bib was not written (export.bibtex on; Zotero's BibTeX translator)");
			let bibText = await IOUtils.readUTF8(bib);
			check(/@article\{lee2021exercise,/.test(bibText), `references.bib has no @article{lee2021exercise, … (starts: ${bibText.slice(0, 200)})`);
		},
	},
	{
		name: "screening decisions on real items and the PRISMA note (ZB.screening)",
		needs: ["sync to Obsidian writes notes, frontmatter, .base and Chinese APA (ZB.main.run, ai: none)"],
		async fn(d) {
			let S = zb().screening;
			let cfg = S.config();
			let set = (items, change) => S.setDecision(items, change, { silent: true });
			eq(await set([ctx.english, ctx.chinese, ctx.extra1], { stage: "ta", decision: "include" }), 3, "items changed by TA include");
			eq(await set([ctx.book], { stage: "ta", decision: "exclude" }), 1, "items changed by TA exclude");
			eq(await set([ctx.extra2], { duplicate: true }), 1, "items marked duplicate");
			eq(await set([ctx.english, ctx.chinese], { stage: "ft", decision: "include" }), 2, "items changed by FT include");
			eq(await set([ctx.extra1], { stage: "ft", decision: "exclude", reason: S.DEFAULT_REASONS[0] }), 1, "items changed by FT exclude");
			let tagInclude = S.stageTag(cfg, "ta", "include");
			let tags = await dbTags(ctx.english.id);
			check(tags.includes(tagInclude), `English item lacks ${tagInclude} in the database (${JSON.stringify(tags)})`);
			let reasonTag = S.reasonTag(cfg, S.DEFAULT_REASONS[0]);
			check((await dbTags(ctx.extra1.id)).includes(reasonTag), `extra1 lacks the reason tag ${reasonTag}`);

			let out = await S.generateReport(ctx.collection);
			check(out, "generateReport() returned null (settings or empty collection?)");
			d.counts = out.result.counts;
			d.outputs = out.outputs;
			check(!out.errors.length, `generateReport errors: ${out.errors.join("; ")}`);
			let c = out.result.counts;
			eq(c.identified, 5, "PRISMA records identified");
			eq(c.duplicates, 1, "PRISMA duplicates");
			eq(c.included, 2, "PRISMA included");
			let reviewDir = PathUtils.join(ctx.noteDir, "Reviews");
			let note = PathUtils.join(reviewDir, "E2E Review.md");
			check(await IOUtils.exists(note), `PRISMA note ${note} not written (files: ${(await listFiles(reviewDir)).map(p => PathUtils.filename(p)).join(", ")})`);
			let text = await IOUtils.readUTF8(note);
			check(text.includes("```mermaid"), "PRISMA note has no mermaid flow diagram");
			check(text.includes("PRISMA"), "PRISMA note does not mention PRISMA");
			check(await IOUtils.exists(PathUtils.join(reviewDir, "E2E Review 證據表.csv")), "evidence table CSV not written");
		},
	},
	{
		name: "auto-sync reacts to an item change through Zotero.Notifier",
		needs: ["sync to Obsidian writes notes, frontmatter, .base and Chinese APA (ZB.main.run, ai: none)"],
		timeout: 60000,
		async fn(d) {
			// With a Notion token set, auto-sync would also try Notion (no database configured here)
			eq(await zb().secrets.get("notionToken"), "", "notionToken left over from an earlier test");
			setPref("autoSync", true);
			try {
				ctx.book.setField("abstractNote", "E2E auto-sync marker 4711.");
				await ctx.book.saveTx();
				let start = Date.now();
				await waitFor(async () => {
					let n = await findNote(ctx.noteDir, ctx.book.key);
					return n && n.text.includes("E2E auto-sync marker 4711.");
				}, "the book's Obsidian note to contain the new abstract (auto-sync fires 8 s after the change)", 40000, 500);
				d.seconds = Math.round((Date.now() - start) / 1000);
			}
			finally {
				setPref("autoSync", false);
			}
		},
	},
	{
		name: "AI note through the plugin's fetch with a stubbed Claude API (no network)",
		needs: ["sync to Obsidian writes notes, frontmatter, .base and Chinese APA (ZB.main.run, ai: none)"],
		async fn(d) {
			let ZB = zb();
			let pluginGlobal = Components.utils.getGlobalForObject(ZB.main.run);
			let realFetch = pluginGlobal.fetch;
			let calls = [];
			const KEY = "sk-ant-e2e-fake-key";
			// Headings of the built-in note template (llm.js): the item pane summary is the 一句話摘要 section
			const AI_MD = "## 一句話摘要\nE2E stubbed summary sentence.\n\n## 研究設計\n- Randomised trial.";
			let stub = async (url, init) => {
				calls.push({ url: String(url), apiKey: init && init.headers && init.headers["x-api-key"] });
				if (!String(url).startsWith("https://api.anthropic.com/")) throw new Error(`unexpected network call to ${url}`);
				return new pluginGlobal.Response(JSON.stringify({
					model: "e2e-model", stop_reason: "end_turn",
					content: [{ type: "text", text: AI_MD }],
					usage: { input_tokens: 1000, output_tokens: 200 },
				}), { status: 200, headers: { "content-type": "application/json" } });
			};
			Object.defineProperty(pluginGlobal, "fetch", { value: stub, writable: true, configurable: true });
			check(pluginGlobal.fetch === stub, "could not replace fetch in the plugin scope");
			let retry = ZB.main.runtime.retry;
			ZB.main.runtime.retry = { maxRetries: 0 };
			try {
				await ZB.secrets.set("anthropicKey", KEY);
				setPref("llm.provider", "anthropic");
				await ZB.main.run([ctx.english], { targets: ["obsidian"], ai: "regenerate" });
			}
			finally {
				Object.defineProperty(pluginGlobal, "fetch", { value: realFetch, writable: true, configurable: true });
				ZB.main.runtime.retry = retry;
				await ZB.secrets.clear("anthropicKey");
			}
			d.calls = calls;
			eq(calls.length, 1, "fetch calls");
			eq(calls[0].apiKey, KEY, "x-api-key sent (read from the login manager)");
			let note = ZB.adapter.getAINote(ctx.english);
			check(note, "no AI child note (tag zotero-bridge-ai) was saved under the item");
			check(note.getNote().includes("E2E stubbed summary sentence."), "AI child note does not contain the generated text");
			check((await dbTags(note.id)).includes("zotero-bridge-ai"), "AI note lacks the zotero-bridge-ai tag in the database");
			let n = await findNote(ctx.noteDir, ctx.english.key);
			check(n && n.text.includes("E2E stubbed summary sentence."), "Obsidian note does not contain the AI note");
			eq(fmValue(frontmatter(n.text), "ai_model"), "e2e-model", "ai_model frontmatter");
			ctx.aiNote = note;
		},
		// Without an OS key store, secrets.js logs the encryption failure before falling back (documented)
		get allow() {
			return ctx.keyStoreUsable ? null : /os-keystore|OSKeyStore|key store|鑰匙圈/i;
		},
	},
	{
		name: "item pane section renders (renderPane in the main window and the real item pane)",
		needs: ["item pane section is registered", "AI note through the plugin's fetch with a stubbed Claude API (no network)"],
		async fn(d) {
			let win = mainWindow();
			let doc = win.document;
			// The hook itself, on a real document and item
			let body = doc.createElement("div");
			let summary = null;
			zb().main.renderPane({ doc, body, item: ctx.english, setSectionSummary: (s) => {
				summary = s;
			} });
			check(body.textContent.includes("E2E stubbed summary sentence."), `renderPane() output lacks the AI note: ${body.textContent.slice(0, 200)}`);
			check(summary && summary.includes("E2E stubbed summary"), `setSectionSummary got ${JSON.stringify(summary)}`);
			check(body.querySelectorAll("button").length >= 2, "renderPane() made no action buttons");
			// The panel's stylesheet is in the main window (sidepanel.css)
			check(doc.getElementById("zotero-bridge-sidepanel-css"), "no #zotero-bridge-sidepanel-css in the main window");
			// The real item pane: select the item and wait for the section to render
			await win.ZoteroPane.selectItem(ctx.english.id);
			let section = await waitFor(() => [...doc.querySelectorAll("item-pane-custom-section")].find(e => e.dataset.pane === ctx.paneKey),
				`<item-pane-custom-section data-pane="${ctx.paneKey}"> in the item pane`, 20000);
			// The ZotMax icon in the item pane's side navigation
			let details = section.closest("item-details");
			let sidenav = (details && details.querySelector("item-pane-sidenav")) || doc.querySelector("#zotero-item-pane item-pane-sidenav");
			d.sidenavPanes = sidenav ? [...sidenav.querySelectorAll("[data-pane]")].map(e => String(e.dataset.pane)) : null;
			check(sidenav && [...sidenav.querySelectorAll("[data-pane]")].some(e => e.dataset.pane === ctx.paneKey), `no ZotMax button in the item pane's side navigation (panes: ${JSON.stringify(d.sidenavPanes)})`);
			if (details && details.scrollToPane) details.scrollToPane(ctx.paneKey, "instant");
			await waitFor(() => section.textContent.includes("E2E stubbed summary sentence."),
				"the plugin's item pane section to render the AI note", 20000);
			d.sectionText = section.textContent.replace(/\s+/g, " ").slice(0, 200);
			let part = id => section.querySelector(`[data-zb-sub="${id}"]`);
			check(part("keyPoints") && part("keyPoints").textContent.includes("E2E stubbed summary sentence."), "重點 does not show the take-away");
			check(part("actions"), "no 動作 part");
			d.commands = [...part("actions").querySelectorAll("button[data-zb-command]")].map(b => String(b.dataset.zbCommand));
			check(d.commands.includes("sync-no-ai") && d.commands.includes("palette"), `動作 commands ${JSON.stringify(d.commands)}`);
			// The red highlight of the sync test, under 我的劃線
			d.highlights = String(part("highlights") && part("highlights").dataset.zbCount);
			eq(d.highlights, "1", "highlights counted in 我的劃線");
			// The literature note the earlier sync wrote: its link, once read
			await waitFor(() => section.querySelector("[data-zb-link=obsidian]"), "在 Obsidian 開啟筆記 in 重點", 20000);
			// A button runs its catalog command on this item: 同步，不呼叫 AI (Obsidian only, no Notion configured)
			let before = (await findNote(ctx.noteDir, ctx.english.key)).text;
			let beforeSynced = fmValue(frontmatter(before), "last_synced");
			await delay(1100);
			part("actions").querySelector("button[data-zb-command=sync-no-ai]").click();
			// Runs are queued: an empty run resolves after it
			await delay(200);
			await zb().main.run([], {});
			let after = (await findNote(ctx.noteDir, ctx.english.key)).text;
			d.lastSynced = { before: String(beforeSynced), after: String(fmValue(frontmatter(after), "last_synced")) };
			check(d.lastSynced.after && d.lastSynced.after !== d.lastSynced.before, `the click did not sync the item (last_synced ${JSON.stringify(d.lastSynced)})`);
			// …and the panel refreshed with the sync time
			let fresh = () => [...doc.querySelectorAll("item-pane-custom-section")].find(e => e.dataset.pane === ctx.paneKey);
			await waitFor(() => {
				let line = fresh() && fresh().querySelector("[data-zb-synced]");
				return line && !line.hidden;
			}, "the last sync time under 狀態", 20000);
		},
	},
	{
		name: "the ZotMax panel is in the reader's side pane next to the PDF",
		needs: ["item pane section renders (renderPane in the main window and the real item pane)"],
		timeout: 90000,
		async fn(d) {
			let win = mainWindow();
			let doc = win.document;
			let reader = await Zotero.Reader.open(ctx.textPDF.id);
			check(reader, "Zotero.Reader.open returned nothing");
			let tabID = reader.tabID;
			d.tabID = String(tabID);
			try {
				await waitFor(() => win.Zotero_Tabs && win.Zotero_Tabs.selectedID === tabID, "the reader tab to be selected", 30000);
				let pane = doc.getElementById("zotero-context-pane");
				check(pane, "no #zotero-context-pane in the main window");
				// A collapsed side pane is opened, as the user would
				try {
					let splitter = doc.getElementById("zotero-context-splitter");
					d.collapsed = !!(splitter && splitter.getAttribute("state") === "collapsed");
					if (d.collapsed && win.ZoteroContextPane && win.ZoteroContextPane.togglePane) win.ZoteroContextPane.togglePane();
				}
				catch (e) {
					d.toggleError = String(e);
				}
				let section = await waitFor(() => [...pane.querySelectorAll("item-pane-custom-section")].find(e => e.dataset.pane === ctx.paneKey),
					`<item-pane-custom-section data-pane="${ctx.paneKey}"> in the reader's side pane`, 30000);
				let sidenavs = [...pane.querySelectorAll("item-pane-sidenav")];
				d.sidenavPanes = sidenavs.map(n => [...n.querySelectorAll("[data-pane]")].map(e => String(e.dataset.pane)));
				check(sidenavs.some(n => [...n.querySelectorAll("[data-pane]")].some(e => e.dataset.pane === ctx.paneKey)), `no ZotMax button in the reader's side navigation (${JSON.stringify(d.sidenavPanes)})`);
				let details = section.closest("item-details");
				if (details && details.scrollToPane) details.scrollToPane(ctx.paneKey, "instant");
				// The PDF's parent item: its AI note
				await waitFor(() => {
					let kp = section.querySelector('[data-zb-sub="keyPoints"]');
					return kp && kp.textContent.includes("E2E stubbed summary sentence.");
				}, "the panel to show the parent item's 重點 in the reader", 30000);
				d.sectionText = section.textContent.replace(/\s+/g, " ").slice(0, 200);
			}
			finally {
				try {
					win.Zotero_Tabs.close(tabID);
				}
				catch (e) {
					d.closeError = String(e);
				}
			}
		},
	},
	{
		name: "評讀陪練: the coach compares an AI's answers from text.pdf with the form and records 保留我的判斷 (stubbed Claude API)",
		needs: ["AI note through the plugin's fetch with a stubbed Claude API (no network)"],
		async fn(d) {
			let ZB = zb();
			let AF = ZB.appraisalForm;
			let T = ZB.appraisalTools;
			let pluginGlobal = Components.utils.getGlobalForObject(ZB.main.run);
			let realFetch = pluginGlobal.fetch;
			let calls = [];
			const KEY = "sk-ant-e2e-fake-key";
			// The user's own appraisal: every closed CASP RCT item, item 7 answered 否
			let answers = {};
			for (let item of ZB.appraisalCoach.closedItems("casp-rct")) answers[item.id] = { answer: "是", note: "", source: "human" };
			answers["7"] = { answer: "否", note: "E2E own note", source: "human" };
			// The AI: the same except item 7, with a sentence that is in text.pdf (make-fixtures.mjs)
			const QUOTE = "The intervention reduced the rate of falls by thirty percent compared with usual care.";
			let aiItems = Object.keys(answers).map(id => ({ id, answer: "是", reason: `E2E reason ${id}`, quotes: [] }));
			aiItems.find(i => i.id === "7").quotes = [{ text: QUOTE, page: "1" }];
			let stub = async (url, init) => {
				let body = JSON.parse(init.body);
				calls.push({ url: String(url), system: body.system ? body.system.length : 0, user: String(body.messages[0].content) });
				if (!String(url).startsWith("https://api.anthropic.com/")) throw new Error(`unexpected network call to ${url}`);
				return new pluginGlobal.Response(JSON.stringify({
					model: "e2e-model", stop_reason: "end_turn",
					content: [{ type: "text", text: JSON.stringify({ items: aiItems }) }],
					usage: { input_tokens: 2000, output_tokens: 400 },
				}), { status: 200, headers: { "content-type": "application/json" } });
			};
			let retry = ZB.main.runtime.retry;
			let formNote = null;
			try {
				setPref("feature.appraisalCoach", true);
				check(ZB.appraisalCoach.enabled(), "評讀陪練 should be on (it needs 文獻評讀表 and AI 文獻筆記)");
				let saved = await AF.saveRecord(ctx.english, T.normalizeRecord({ tool: "casp-rct", answers, overall: "納入" }));
				formNote = saved.note;
				AF._paneState.delete(ctx.english.id);
				d.blocked = String(ZB.appraisalCoach.blockedReason(ctx.english));
				eq(d.blocked, "", "blockedReason with every item answered");
				Object.defineProperty(pluginGlobal, "fetch", { value: stub, writable: true, configurable: true });
				ZB.main.runtime.retry = { maxRetries: 0 };
				await ZB.secrets.set("anthropicKey", KEY);
				setPref("llm.provider", "anthropic");
				let confirmText = "";
				let run = await ZB.appraisalCoach.run(ctx.english, { confirm: (text) => {
					confirmText = String(text);
					return true;
				} });
				d.confirm = confirmText.slice(0, 200);
				check(run, "run() returned nothing (cancelled or failed; see the plugin errors)");
				d.summary = String(ZB.appraisalCoach.summaryText(run));
			}
			finally {
				Object.defineProperty(pluginGlobal, "fetch", { value: realFetch, writable: true, configurable: true });
				ZB.main.runtime.retry = retry;
				await ZB.secrets.clear("anthropicKey");
			}
			d.calls = calls.map(c => ({ url: c.url, system: c.system, userChars: c.user.length }));
			eq(calls.length, 1, "fetch calls");
			check(calls[0].system === 2, `system blocks: ${calls[0].system}, expected the instructions and the checklist`);
			check(calls[0].user.includes("falls by thirty percent"), "the request lacks text.pdf's full text");
			check(!calls[0].user.includes("E2E own note"), "the user's note went into the request");
			eq(d.summary, "13 題中 12 題一致，1 題不同（一致 92%）", "summary");
			let stored = () => AF.readNoteHTML(AF.getFormNote(ctx.english).getNote());
			let item7 = stored().coach[0].items.find(i => i.id === "7");
			d.item7 = { user: String(item7.user), ai: String(item7.ai), quotes: item7.quotes.length, page: Number(item7.quotes[0] && item7.quotes[0].page) || 0 };
			eq(d.item7.quotes, 1, "the quote from text.pdf is verified");
			eq(d.item7.page, 1, "the quote's PDF page");

			// The form in the real item pane document: exactly item 7 listed, then 「保留我的判斷」
			let doc = mainWindow().document;
			let body = doc.createElement("div");
			ZB.main.renderPane({ doc, body, item: ctx.english, setSectionSummary: () => {} });
			let section = body.querySelector("[data-zb-coach]");
			check(section, "no 評讀陪練 results in the open form");
			let listed = [...section.children].filter(e => e.hasAttribute("data-zb-coach-item")).map(e => String(e.getAttribute("data-zb-coach-item")));
			d.listed = listed;
			eq(JSON.stringify(listed), JSON.stringify(["7"]), "items listed as different");
			let keep = section.querySelector('[data-zb-coach-item="7"] [data-zb-coach-decide="kept"]');
			check(keep, "no 保留我的判斷 button");
			keep.click();
			await waitFor(() => {
				let it = stored().coach[0].items.find(i => i.id === "7");
				return it && it.decision === "kept";
			}, "the decision in the note JSON", 10000);
			let after = stored();
			d.decision = { decision: String(after.coach[0].items.find(i => i.id === "7").decision), answer: String(after.answers["7"].answer) };
			eq(d.decision.answer, "否", "保留我的判斷 keeps the user's answer");
			d.line = String(ZB.appraisalCoach.summaryLine(after));
			eq(d.line, "評讀陪練：一致 12/13，修改 0 題", "synced line");
			let ledger = JSON.parse(Zotero.Prefs.get(ZB_PREF + "usage.ledger", true) || "{}");
			let month = ledger[ZB.usage.monthKey()];
			d.ledgerModels = month ? Object.keys(month.byModel || {}) : [];
			check(d.ledgerModels.includes("e2e-model"), `no usage ledger entry for e2e-model (${JSON.stringify(d.ledgerModels)})`);
			// Leave the item as it was for the tests after this one
			AF._paneState.delete(ctx.english.id);
			if (formNote) await formNote.eraseTx();
			Zotero.Prefs.clear(ZB_PREF + "feature.appraisalCoach", true);
		},
		get allow() {
			return ctx.keyStoreUsable ? null : /os-keystore|OSKeyStore|key store|鑰匙圈/i;
		},
	},
	{
		name: "讀懂統計: a selection of text.pdf explained in the reader's panel with a stubbed AI; the invented number is removed",
		needs: ["the ZotMax panel is in the reader's side pane next to the PDF"],
		timeout: 90000,
		async fn(d) {
			let ZB = zb();
			let S = ZB.statsExplainer;
			let win = mainWindow();
			let doc = win.document;
			// The selection: a sentence of text.pdf as the PDF worker reads it
			let full = await Zotero.PDFWorker.getFullText(ctx.textPDF.id, 1);
			const SENTENCE = "The intervention reduced the rate of falls by thirty percent compared with usual care.";
			check(String(full.text).replace(/\s+/g, " ").includes(SENTENCE), "text.pdf does not contain the sentence to select");
			// The stub's answer: no number is in the selection or text.pdf, so 30% and 0.7 are invented
			const ANSWER = JSON.stringify({
				terms: [{ term: "rate of falls", what: "跌倒率", here: "下降 30%，相當於 rate ratio 0.7" }],
				restatement: "介入讓跌倒率下降三成。",
				clinical: "對社區長者有意義。",
				cautions: ["這段沒有寫信賴區間。"],
			});
			let pluginGlobal = Components.utils.getGlobalForObject(ZB.main.run);
			let realFetch = pluginGlobal.fetch;
			let calls = [];
			let stub = async (url) => {
				calls.push(String(url));
				if (!String(url).startsWith("https://api.anthropic.com/")) throw new Error(`unexpected network call to ${url}`);
				return new pluginGlobal.Response(JSON.stringify({
					model: "e2e-model", stop_reason: "end_turn",
					content: [{ type: "text", text: ANSWER }],
					usage: { input_tokens: 800, output_tokens: 200 },
				}), { status: 200, headers: { "content-type": "application/json" } });
			};
			let before = {
				on: Zotero.Prefs.get(ZB_PREF + "feature.statsExplainer", true),
				confirm: Zotero.Prefs.get(ZB_PREF + "statsExplainer.confirm", true),
			};
			Object.defineProperty(pluginGlobal, "fetch", { value: stub, writable: true, configurable: true });
			let retry = ZB.main.runtime.retry;
			ZB.main.runtime.retry = { maxRetries: 0 };
			let reader = null;
			try {
				await ZB.secrets.set("anthropicKey", "sk-ant-e2e-fake-key");
				setPref("llm.provider", "anthropic");
				setPref("feature.statsExplainer", true);
				setPref("statsExplainer.confirm", "never");
				d.listening = !!S.listening;
				check(S.listening, "the reader listener is not registered (Zotero.Reader.registerEventListener)");
				reader = await Zotero.Reader.open(ctx.textPDF.id);
				check(reader, "Zotero.Reader.open returned nothing");
				await waitFor(() => win.Zotero_Tabs && win.Zotero_Tabs.selectedID === reader.tabID, "the reader tab to be selected", 30000);
				// The popup event as the reader dispatches it, through Zotero's own dispatcher when it has one
				let holder = doc.createElement("div");
				let event = {
					type: "renderTextSelectionPopup", reader, doc,
					params: { annotation: { text: SENTENCE, pageLabel: "1", position: { pageIndex: 0, rects: [[72, 700, 500, 712]] } } },
					append: (...nodes) => holder.append(...nodes),
				};
				d.dispatch = typeof Zotero.Reader._dispatchEvent === "function" ? "Zotero.Reader._dispatchEvent" : "onSelectionPopup";
				if (d.dispatch === "Zotero.Reader._dispatchEvent") Zotero.Reader._dispatchEvent(event);
				else S.onSelectionPopup(event);
				let button = holder.querySelector("button[data-zb-stats=explain]");
				check(button, "no 「ZotMax：解釋統計」 button in the popup");
				d.buttonText = String(button.textContent);
				button.click();
				await waitFor(() => S.loadRecord(ctx.english).entries.length > 0, "the explanation saved in the child note", 30000);
				eq(calls.length, 1, "fetch calls");
				let entry = S.loadRecord(ctx.english).entries[0];
				d.removed = entry.removed.terms;
				d.here = String(entry.explanation.terms[0].here);
				check(!/30|0\.7/.test(d.here), `the invented numbers stayed: ${d.here}`);
				check(d.here.includes(S.REMOVED), `no removal marker: ${d.here}`);
				// The reader's side pane shows it under 統計解釋
				let pane = doc.getElementById("zotero-context-pane");
				let section = await waitFor(() => [...pane.querySelectorAll("item-pane-custom-section")].find(e => e.dataset.pane === ctx.paneKey),
					"the ZotMax section in the reader's side pane", 30000);
				let part = await waitFor(() => section.querySelector('[data-zb-sub="stats"] [data-zb-entry]') && section.querySelector('[data-zb-sub="stats"]'),
					"統計解釋 in the reader's side pane", 30000);
				d.partText = part.textContent.replace(/\s+/g, " ").slice(0, 300);
				check(part.querySelector("[data-zb-removed]"), "no removed-number marker in the panel");
				check(part.querySelector("[data-zb-warning]"), "no 「這個數字不在原文裡」 warning in the panel");
				check(!/30%/.test(part.textContent), "the panel shows the invented 30%");
				// 存到筆記: the literature note of the earlier sync gets the 「統計筆記」 callout
				await S.saveToNote(ctx.english, entry.id);
				let note = await findNote(ctx.noteDir, ctx.english.key);
				check(note && note.text.includes("[!note]- 統計筆記"), "存到筆記 did not write the 「統計筆記」 callout");
				check(note.text.indexOf("統計筆記") > note.text.indexOf("%% zotero-bridge:end %%"), "the callout is inside the managed block");
			}
			finally {
				Object.defineProperty(pluginGlobal, "fetch", { value: realFetch, writable: true, configurable: true });
				ZB.main.runtime.retry = retry;
				await ZB.secrets.clear("anthropicKey");
				setPref("feature.statsExplainer", before.on === undefined ? false : before.on);
				setPref("statsExplainer.confirm", before.confirm || "above");
				if (reader) {
					try {
						win.Zotero_Tabs.close(reader.tabID);
					}
					catch (e) {
						d.closeError = String(e);
					}
				}
			}
		},
		get allow() {
			return ctx.keyStoreUsable ? null : /os-keystore|OSKeyStore|key store|鑰匙圈/i;
		},
	},
	{
		name: "文獻自動分類 by rules and heuristics creates real sub-collections; undo removes exactly them (ZB.classify)",
		needs: ["create items with PDF attachments in the real library"],
		async fn(d) {
			let C = zb().classify;
			let libraryID = Zotero.Libraries.userLibraryID;
			// Rules and the study-design guess only: no AI, no network
			setPref("classify.ruleList", "跌倒 = title:falls OR tag:跌倒\n中文文獻 = language:zh\n近年 = year>=2020");
			setPref("classify.topics", false);
			setPref("classify.pico", false);
			let topLevel = name => Zotero.Collections.getByLibrary(libraryID).filter(c => !c.deleted && c.name === name);
			let child = (parent, name) => parent && Zotero.Collections.getByParent(parent.id).find(c => !c.deleted && c.name === name);
			// Members straight from the database (collectionItems), not from the objects' caches
			let members = async (collection) => {
				let ids = await Zotero.DB.columnQueryAsync("SELECT itemID FROM collectionItems WHERE collectionID=?", [collection.id]);
				return Zotero.Items.get(ids || []).map(i => i.key).sort();
			};
			let same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
			let reviewBefore = await members(ctx.collection);
			try {
				check(!topLevel("自動分類").length, "a collection 自動分類 already exists before the test");
				let items = [ctx.english, ctx.chinese, ctx.book, ctx.extra1, ctx.extra2];
				let plan = await C.suggest(items, { ui: { confirmAI: () => "skip", status: () => {} } });
				check(plan && Array.isArray(plan.items), `suggest() returned ${JSON.stringify(plan)}`);
				d.notes = plain(plan.notes);
				let picks = C.defaultPicks(plan);
				d.picks = picks.map(p => `${p.itemKey} → ${p.dimension}/${p.value}`);
				let want = [
					`${ctx.english.key} → rule/跌倒`, `${ctx.english.key} → rule/近年`,
					`${ctx.chinese.key} → rule/跌倒`, `${ctx.chinese.key} → rule/中文文獻`, `${ctx.chinese.key} → rule/近年`,
					`${ctx.extra1.key} → rule/近年`, `${ctx.extra2.key} → design/Cohort`,
				].sort();
				check(same(d.picks.slice().sort(), want), `pre-checked suggestions ${JSON.stringify(d.picks)}, expected ${JSON.stringify(want)}`);

				let result = await C.apply(plan, picks);
				d.apply = result;
				eq(result.errors.length, 0, `apply() errors: ${result.errors.join("; ")}`);
				eq(result.added, 7, "memberships added");
				eq(result.created, 7, "collections created (自動分類, 規則, 跌倒, 中文文獻, 近年, 研究設計, Cohort)");
				let parent = topLevel("自動分類");
				eq(parent.length, 1, "top-level collections named 自動分類");
				let rules = child(parent[0], "規則");
				let design = child(parent[0], "研究設計");
				check(rules && design, `folders under 自動分類: ${Zotero.Collections.getByParent(parent[0].id).map(c => c.name).join(", ")}`);
				let expect = {
					"跌倒": [ctx.english.key, ctx.chinese.key],
					"中文文獻": [ctx.chinese.key],
					"近年": [ctx.english.key, ctx.chinese.key, ctx.extra1.key],
				};
				let problems = [];
				for (let [name, keys] of Object.entries(expect)) {
					let c = child(rules, name);
					if (!c) {
						problems.push(`no 自動分類/規則/${name}`);
						continue;
					}
					let got = await members(c);
					if (!same(got, keys.slice().sort())) problems.push(`規則/${name} holds ${JSON.stringify(got)}, expected ${JSON.stringify(keys.slice().sort())}`);
				}
				let cohort = child(design, "Cohort");
				if (!cohort) problems.push("no 自動分類/研究設計/Cohort");
				else if (!same(await members(cohort), [ctx.extra2.key])) problems.push(`研究設計/Cohort holds ${JSON.stringify(await members(cohort))}`);
				check(!problems.length, problems.join("; "));
				check(same(await members(ctx.collection), reviewBefore), "the user's collection E2E Review changed");
				let last = C.readLastRun();
				check(last && last.libraries.length === 1 && last.libraries[0].created.length === 7, `classify.lastRun ${JSON.stringify(last)}`);

				// Again: everything is reused, nothing added, the undo record stays
				let again = await C.apply(await C.suggest(items, { ui: { confirmAI: () => "skip", status: () => {} } }), picks);
				d.again = again;
				eq(again.created, 0, "collections created by a second identical run");
				eq(again.added, 0, "memberships added by a second identical run");
				eq(again.already, 7, "picks already in place on the second run");
				eq(topLevel("自動分類").length, 1, "top-level 自動分類 after the second run");
				check(same(C.readLastRun(), last), "a run that changed nothing replaced the undo record");

				// 復原上次分類
				let undo = await C.undoLast({ silent: true });
				d.undo = undo;
				check(undo, "undoLast() returned null");
				eq(undo.removed, 7, "memberships removed by undo");
				eq(undo.deleted, 7, "collections deleted by undo");
				eq(undo.kept.length, 0, `collections kept by undo: ${undo.kept.join(", ")}`);
				eq(topLevel("自動分類").length, 0, "top-level 自動分類 after undo");
				let left = await Zotero.DB.valueQueryAsync("SELECT COUNT(*) FROM collections WHERE collectionName IN ('自動分類', '規則', '研究設計', '跌倒', '中文文獻', '近年', 'Cohort')");
				eq(Number(left), 0, "collections with the run's names left in the database");
				check(same(await members(ctx.collection), reviewBefore), "the user's collection E2E Review changed after undo");
				for (let name of ["english", "chinese", "extra1", "extra2"]) {
					check(!ctx[name].deleted, `${name} was deleted`);
				}
				eq(C.readLastRun(), null, "classify.lastRun after undo");
			}
			finally {
				if (C.readLastRun()) await C.undoLast({ silent: true });
				for (let key of ["classify.ruleList", "classify.topics", "classify.pico"]) Zotero.Prefs.clear(ZB_PREF + key, true);
			}
		},
	},
	{
		name: "文獻自動分類 review window opens from chrome://zotero-bridge/ and 取消 writes nothing",
		needs: ["文獻自動分類 by rules and heuristics creates real sub-collections; undo removes exactly them (ZB.classify)"],
		timeout: 60000,
		async fn(d) {
			let C = zb().classify;
			setPref("classify.ruleList", "跌倒 = title:falls");
			setPref("classify.topics", false);
			let win = null;
			try {
				let plan = await C.suggest([ctx.english, ctx.extra2], { ui: { confirmAI: () => "skip", status: () => {} } });
				let opened = null;
				let result = C.review(plan, { onOpen: (w) => {
					opened = w;
				} });
				win = await waitFor(() => opened, "the review window (chrome://zotero-bridge/content/classify-review.xhtml) to show the plan", 30000);
				let doc = win.document;
				d.url = doc.documentURI;
				eq(doc.documentURI, C.DIALOG_URL, "review window URL");
				let root = doc.getElementById(C.DIALOG_ROOT);
				let boxes = root.querySelectorAll("input[type=checkbox]");
				d.checkboxes = boxes.length;
				check(boxes.length >= 2, `only ${boxes.length} checkbox(es) in the review window`);
				d.summary = root.querySelector(".zb-cl-summary").textContent;
				check(/^已勾選 \d+ 項/.test(d.summary), `summary line: ${d.summary}`);
				d.titles = [...root.querySelectorAll(".zb-cl-item-title")].map(h => h.textContent);
				check(d.titles.includes("Exercise and falls"), `item titles: ${JSON.stringify(d.titles)}`);
				// classify-review.css is applied (registered chrome package)
				d.rootDisplay = win.getComputedStyle(root).display;
				eq(d.rootDisplay, "flex", "display of #zb-classify (is classify-review.css loaded?)");
				root.querySelector(".zb-cl-cancel").click();
				eq(await result, null, "review() result after 取消");
				await waitFor(() => win.closed, "the review window to close after 取消", 10000);
				eq(Zotero.Collections.getByLibrary(Zotero.Libraries.userLibraryID).filter(c => !c.deleted && c.name === "自動分類").length, 0, "collections named 自動分類 after 取消");
				eq(C.readLastRun(), null, "classify.lastRun after 取消");
			}
			finally {
				if (win && !win.closed) win.close();
				for (let key of ["classify.ruleList", "classify.topics"]) Zotero.Prefs.clear(ZB_PREF + key, true);
			}
		},
	},
	{
		name: "設定精靈 opens from its command, points Obsidian at a vault, syncs one item (試一次, no AI), 完成 sets setup.done and closes it",
		needs: ["create items with PDF attachments in the real library"],
		timeout: 120000,
		async fn(d) {
			let ZBm = zb();
			let S = ZBm.setup;
			let C = ZBm.commands;
			let win = mainWindow();
			let before = {
				vaultPath: Zotero.Prefs.get(ZB_PREF + "obsidian.vaultPath", true),
				done: Zotero.Prefs.get(ZB_PREF + "setup.done", true),
				features: ZBm.features.snapshot(),
			};
			// test/e2e/run.sh sets setup.done in user.js, so the wizard did not open by itself over the tests
			d.doneAtStart = before.done;
			eq(before.done, true, "extensions.zotero-bridge.setup.done at the start (user.js)");
			check(!S.isOpen, "the setup wizard opened by itself during the e2e run");
			let vault = PathUtils.join(workDir, "vault-setup");
			await IOUtils.makeDirectory(PathUtils.join(vault, ".obsidian"), { createAncestors: true, ignoreExisting: true });
			let setupWindows = () => {
				let out = [];
				let all = Services.wm.getEnumerator(null);
				while (all.hasMoreElements()) {
					let w = all.getNext();
					try {
						if (w.document.documentURI === S.DIALOG_URL && !w.closed) out.push(w);
					}
					catch (e) {}
				}
				return out;
			};
			let dialog = null;
			try {
				Zotero.Prefs.set(ZB_PREF + "setup.done", false, true);
				await win.ZoteroPane.selectItem(ctx.english.id);
				// The command, as 快速指令 and the toolbar menu run it
				let cmd = C.get("setup-wizard");
				check(cmd && !cmd.features.length, "the catalog has no ungated setup-wizard command");
				C.execute(cmd, C.fromWindow(win, "palette"));
				dialog = await waitFor(() => setupWindows()[0], `the setup wizard window (${S.DIALOG_URL})`, 30000);
				let doc = dialog.document;
				let root = await waitFor(() => doc.querySelector("#zb-setup .zb-su-step") && doc.getElementById(S.DIALOG_ROOT), "the wizard's first step", 15000);
				d.rootDisplay = dialog.getComputedStyle(root).display;
				eq(d.rootDisplay, "flex", "display of #zb-setup (is setup.css loaded?)");
				d.title = String(doc.title);
				check(/ZotMax/.test(d.title), `wizard title ${d.title}`);
				check(!/\{ ?\$/.test(root.textContent), "a Fluent placeholder shows in the wizard");
				let step = () => {
					let el = doc.querySelector(".zb-su-step");
					return el && el.getAttribute("data-zb-step");
				};
				let $ = id => doc.getElementById(id);
				let advance = async (buttonID, to) => {
					$(buttonID).click();
					await waitFor(() => step() === to, `the wizard step ${to} (after #${buttonID}; status: ${$("zb-su-status") && $("zb-su-status").textContent})`, 30000);
				};
				d.steps = [step()];
				eq(step(), "welcome", "first step");
				await advance("zb-su-next", "mode");
				d.steps.push(step());
				// Keep the profile's preset: 下一步 with the radio the wizard checked writes nothing new
				await advance("zb-su-next", "notes");
				d.steps.push(step());
				$("zb-su-notes-obsidian").click();
				let vaultInput = $("zb-su-vault");
				let obsidianBox = doc.querySelector('[data-zb-box="obsidian"]');
				d.afterObsidian = { checked: !!$("zb-su-notes-obsidian").checked, boxHidden: obsidianBox ? !!obsidianBox.hidden : "none", input: !!vaultInput };
				check(vaultInput && obsidianBox && !obsidianBox.hidden, `the Obsidian fields did not show after choosing Obsidian (${JSON.stringify(d.afterObsidian)})`);
				vaultInput.value = vault;
				vaultInput.dispatchEvent(new dialog.Event("change", { bubbles: true }));
				d.vaultCheck = await waitFor(() => $("zb-su-vault-check").getAttribute("data-zb-state"), "the vault check", 10000);
				eq(d.vaultCheck, "vault", "vault check of a folder with .obsidian (real IOUtils)");
				await advance("zb-su-next", "ai");
				d.steps.push(step());
				eq(Zotero.Prefs.get(ZB_PREF + "obsidian.vaultPath", true), vault, "obsidian.vaultPath after 下一步");
				// AI: skipped (nothing stored, nothing spent)
				await advance("zb-su-skip", "try");
				d.steps.push(step());
				let itemLine = await waitFor(() => $("zb-su-try-item").textContent, "the item to try", 10000);
				d.item = itemLine;
				check(itemLine.includes("Exercise and falls"), `the wizard picked ${JSON.stringify(itemLine)}, not the selected e2e item`);
				await waitFor(() => !$("zb-su-try-run").disabled, "「同步這一篇」 to be enabled", 10000);
				$("zb-su-try-run").click();
				d.result = await waitFor(() => $("zb-su-try-result").getAttribute("data-zb-result"), "the 試一次 sync to finish", 90000);
				d.resultText = $("zb-su-try-result").textContent;
				eq(d.result, "ok", `試一次 result (${d.resultText})`);
				let note = await findNote(PathUtils.join(vault, "Zotero"), ctx.english.key);
				check(note, `no literature note for the e2e item in ${PathUtils.join(vault, "Zotero")}`);
				d.note = PathUtils.filename(note.path);
				check(d.resultText.includes(d.note.replace(/\.md$/, "")), `the result line does not name the note: ${d.resultText}`);
				check($("zb-su-try-open-obsidian"), "no 「在 Obsidian 開啟」 button after the sync");
				await advance("zb-su-next", "done");
				d.steps.push(step());
				d.summary = [...doc.querySelectorAll("#zb-su-summary li")].map(li => li.textContent);
				eq(Zotero.Prefs.get(ZB_PREF + "setup.done", true), false, "setup.done before 完成");
				$("zb-su-next").click();
				await waitFor(() => dialog.closed, "the wizard window to close after 完成", 10000);
				eq(Zotero.Prefs.get(ZB_PREF + "setup.done", true), true, "setup.done after 完成");
				check(!S.isOpen, "ZB.setup.isOpen after 完成");
				eq(setupWindows().length, 0, "setup wizard windows after 完成");
			}
			finally {
				if (dialog && !dialog.closed) dialog.close();
				if (before.vaultPath) setPref("obsidian.vaultPath", before.vaultPath);
				else Zotero.Prefs.clear(ZB_PREF + "obsidian.vaultPath", true);
				setPref("setup.done", true);
				ZBm.features.restore(before.features);
			}
		},
	},
	{
		name: "control: Zotero's own preferences window opens and closes cleanly",
		timeout: 60000,
		async fn(d) {
			// Same steps as the next test, on a built-in pane: console errors seen here come from Zotero
			let from = messages.length;
			let win = Zotero.Utilities.Internal.openPreferences("zotero-prefpane-general");
			try {
				let pane = await waitFor(() => win.Zotero_Preferences && win.Zotero_Preferences.panes
					&& win.Zotero_Preferences.panes.get("zotero-prefpane-general"), "the general pane", 30000);
				await waitFor(() => pane.loaded, "the general pane to load", 30000);
				d.innerWindowID = win.windowGlobalChild && win.windowGlobalChild.innerWindowId;
			}
			finally {
				win.close();
			}
			await delay(1000);
			ctx.prefsControlErrors = messages.slice(from).filter(m => m.kind === "error").map(m => m.text);
			d.errors = ctx.prefsControlErrors;
		},
	},
	{
		name: "preferences pane opens and renders",
		needs: ["preferences pane is registered"],
		timeout: 90000,
		async fn(d) {
			let t0 = Date.now();
			let mark = (what) => {
				d.marks = d.marks || [];
				d.marks.push(`${what} +${Date.now() - t0} ms`);
			};
			await zb().secrets.set("notionToken", "ntn_e2e_prefs_pane");
			mark("secret set");
			let win = Zotero.Utilities.Internal.openPreferences(PANE_ID);
			mark("openPreferences returned");
			try {
				let pane = await waitFor(() => win.Zotero_Preferences && win.Zotero_Preferences.panes
					&& win.Zotero_Preferences.panes.get(PANE_ID), `the preferences window to know pane ${PANE_ID}`, 30000);
				mark("pane known");
				await waitFor(() => pane.loaded, `pane ${PANE_ID} to load (Zotero_Preferences._loadPane)`, 30000);
				mark("pane loaded");
				let c = pane.container;
				d.headings = [...c.querySelectorAll("h2")].map(h => h.textContent);
				let problems = [];
				for (let id of ["zb-anthropic-key", "zb-openai-key", "zb-notion-token", "zb-vault-path", "zb-rules", "zb-usage", "zb-provider"]) {
					if (!c.querySelector(`#${id}`)) problems.push(`#${id} missing`);
				}
				check(!problems.length, `pane markup: ${problems.join(", ")}`);
				// One h2 per section; the sections now sit in workflow tabs (all of them in the DOM)
				let sectionCount = Object.values(PANE_TABS).flat().length;
				eq(d.headings.length, sectionCount, "section headings rendered");
				check(win.ZoteroBridgePrefs && typeof win.ZoteroBridgePrefs.init === "function",
					"window.ZoteroBridgePrefs missing: content/preferences.js did not run in the pane scope");
				// onload="ZoteroBridgePrefs.init()" ran: rules list, usage text and the stored secret
				await waitFor(() => c.querySelector("#zb-rules").children.length > 0, "#zb-rules to be filled by ZoteroBridgePrefs.init()", 10000);
				await waitFor(() => c.querySelector("#zb-notion-token").value === "ntn_e2e_prefs_pane",
					"#zb-notion-token to show the stored secret (loadSecrets)", 10000);
				check(c.querySelector("#zb-usage").textContent.trim(), "#zb-usage is empty (renderUsage)");
				// preference="…" binding
				await waitFor(() => c.querySelector("#zb-vault-path").value === ctx.vault, "#zb-vault-path to show the vault pref", 10000);
				let untranslated = [...c.querySelectorAll("[data-l10n-id]")].filter(e => !e.textContent.trim() && !e.getAttribute("label"));
				d.untranslated = untranslated.map(e => e.dataset.l10nId);
				check(!untranslated.length, `untranslated l10n elements: ${d.untranslated.join(", ")}`);
				// 劃線顏色與意義: one row per Zotero colour (ZoteroBridgePrefs.init); 全文筆記 shows in 研究生引導
				await waitFor(() => c.querySelectorAll("#zb-colors > li").length === 8, "#zb-colors to list Zotero's 8 highlight colours", 10000);
				d.colorRows = [...c.querySelectorAll("#zb-colors > li input")].map(i => i.value);
				eq(d.colorRows[0], "重要發現", "first colour meaning (yellow)");
				let fullTextBox = c.querySelector('groupbox[data-zb-feature="fullTextMarkdown"]');
				check(fullTextBox && !fullTextBox.hasAttribute("hidden"), "全文筆記 is on in 研究生引導: its settings section should show");
				let anthropicBox = c.querySelector("#zb-anthropic-box");
				check(anthropicBox && !anthropicBox.hidden, "provider anthropic: #zb-anthropic-box should be visible");
				// 功能: one switch per feature, the preset of this fresh profile, and progressive disclosure
				let F = zb().features;
				let switches = c.querySelectorAll("#zb-features input[type=checkbox]");
				eq(switches.length, F.FEATURES.length, "feature switches in #zb-features");
				let guidedRadio = c.querySelector("#zb-preset-guided");
				check(guidedRadio && guidedRadio.checked, "a fresh profile should show 研究生引導 as the current preset");
				let chaseBox = c.querySelector('groupbox[data-zb-feature="citationChase"]');
				check(chaseBox && chaseBox.hasAttribute("hidden"), "引文追蹤 is off in 研究生引導: its settings section should be hidden");
				let chaseSwitch = c.querySelector("#zb-feature-citationChase");
				chaseSwitch.click();
				await waitFor(() => F.rawValue("citationChase") === true && !chaseBox.hasAttribute("hidden"),
					"turning 引文追蹤 on in the pane to show its section", 5000);
				check(!guidedRadio.checked, "after changing one switch the preset is no longer 研究生引導 (自訂)");
				chaseSwitch.click();
				await waitFor(() => F.rawValue("citationChase") === false && chaseBox.hasAttribute("hidden"),
					"turning 引文追蹤 off again to hide its section", 5000);
				d.featureHeading = (c.querySelector("[data-l10n-id=zotero-bridge-features-heading]") || {}).textContent;

				// Workflow tabs: the tablist renders, every section is in exactly one tab, and only the selected panel shows
				let root = c.querySelector("#zotero-bridge-prefs");
				let api = win.ZoteroBridgePrefs;
				let display = node => win.getComputedStyle(node).display;
				let shown = node => !!node && node.getBoundingClientRect().height > 0;
				let selectedTab = () => (c.querySelector("[role=tablist] [role=tab][aria-selected=true]") || { getAttribute: () => null }).getAttribute("data-zb-tab");
				let tabs = [...c.querySelectorAll("[role=tablist] [role=tab]")];
				d.tabs = tabs.map(t => t.textContent);
				eq(JSON.stringify(tabs.map(t => t.getAttribute("data-zb-tab"))), JSON.stringify(Object.keys(PANE_TABS)), "tabs in the tablist");
				check(tabs.every(t => t.textContent.trim()), `a tab without a label: ${JSON.stringify(d.tabs)}`);
				check(shown(c.querySelector("[role=tablist]")), "the tablist is not rendered");
				let tabProblems = [];
				for (let [tab, ids] of Object.entries(PANE_TABS)) {
					let panel = c.querySelector(`#zb-panel-${tab}`);
					if (!panel || panel.getAttribute("role") !== "tabpanel") {
						tabProblems.push(`#zb-panel-${tab} missing`);
						continue;
					}
					let got = [...panel.querySelectorAll("[data-zb-section]")].map(n => n.getAttribute("data-zb-section"));
					if (JSON.stringify(got) !== JSON.stringify(ids)) tabProblems.push(`${tab} holds ${JSON.stringify(got)}`);
				}
				for (let g of c.querySelectorAll("groupbox")) {
					if (!g.closest("[role=tabpanel]") || !g.getAttribute("data-zb-section")) tabProblems.push(`a groupbox outside the tabs: ${g.textContent.trim().slice(0, 30)}`);
				}
				check(!tabProblems.length, `tabs: ${tabProblems.join("; ")}`);
				eq(selectedTab(), "features", "tab selected in a fresh profile");
				check(display(c.querySelector("#zb-panel-features")) !== "none", "the 功能 panel should show");
				eq(display(c.querySelector("#zb-panel-sync")), "none", "display of a panel that isn't selected (is preferences.css loaded?)");
				check(typeof api.showSection === "function", "ZoteroBridgePrefs.showSection missing");

				// showSection: every section that is on can be reached, in its tab, on screen
				check(api.showSection("notion"), "showSection(\"notion\") returned false");
				eq(selectedTab(), "sync", "tab after showSection(\"notion\")");
				let notionBox = c.querySelector('[data-zb-section="notion"]');
				check(shown(notionBox), "the Notion section should be rendered after showSection");
				check(notionBox.classList.contains("zb-flash"), "the Notion section should be highlighted after showSection");
				eq(display(c.querySelector("#zb-panel-features")), "none", "display of the 功能 panel after showSection(\"notion\")");
				let unreachable = [];
				d.reachable = [];
				for (let s of api.sections()) {
					if (!s.visible) continue;
					api.showSection(s.id);
					let node = c.querySelector(`[data-zb-section="${s.id}"]`);
					if (selectedTab() !== s.tab || !shown(node)) unreachable.push(`${s.id} (tab ${selectedTab()})`);
					else d.reachable.push(s.id);
				}
				check(!unreachable.length, `sections showSection() did not bring on screen: ${unreachable.join(", ")}`);
				check(d.reachable.length >= 12, `only ${d.reachable.length} sections are on in 研究生引導`);
				// A section of a switched-off feature leads to its switch in 功能
				check(api.showSection("citationChase"), "showSection(\"citationChase\") returned false");
				eq(selectedTab(), "features", "tab after showSection on a switched-off section");
				let notice = c.querySelector("#zb-section-notice");
				check(notice && c.querySelector('.zb-feature[data-feature="citationChase"]').contains(notice), "no note under the 引文追蹤 switch");
				d.notice = notice.textContent;
				d.focusAfterOff = win.document.activeElement && win.document.activeElement.id;
				// prefs.pendingSection, set while the pane is open
				setPref("prefs.pendingSection", "screening");
				await waitFor(() => selectedTab() === "appraise", "prefs.pendingSection \"screening\" to open the 篩選與評讀 tab", 5000);
				eq(Zotero.Prefs.get(ZB_PREF + "prefs.pendingSection", true), "", "prefs.pendingSection after the pane opened it");

				// Search: matches from every tab, highlighted; Esc brings the tabs back
				api.selectTab("features");
				let box = c.querySelector("#zb-search");
				let found = () => Array.from(api.sections()).filter(s => s.visible
					&& !c.querySelector(`[data-zb-section="${s.id}"]`).classList.contains("zb-search-miss")).map(s => s.id);
				box.focus();
				box.value = "Notion";
				box.dispatchEvent(new win.Event("input"));
				check(root.classList.contains("zb-searching"), "typing in the search box should start a search");
				d.searchNotion = found();
				check(d.searchNotion.includes("notion"), `search 「Notion」 found ${JSON.stringify(d.searchNotion)}`);
				check(shown(notionBox), "the Notion section (another tab) should be rendered while searching");
				check(!shown(c.querySelector("[role=tablist]")), "the tabs step aside while searching");
				d.searchStatus = c.querySelector("#zb-search-status").textContent;
				check(d.searchStatus.trim(), "#zb-search-status is empty during a search");
				let registry = win.CSS && win.CSS.highlights;
				d.cssHighlights = !!registry;
				d.highlightRanges = registry && registry.get("zb-search") ? registry.get("zb-search").size : c.querySelectorAll(".zb-hit").length;
				check(d.highlightRanges > 0, "no highlighted matches for 「Notion」");
				box.value = "分類";
				box.dispatchEvent(new win.Event("input"));
				d.searchClassify = found();
				check(d.searchClassify.includes("classify"), `search 「分類」 found ${JSON.stringify(d.searchClassify)}`);
				check(shown(c.querySelector('[data-zb-section="classify"]')), "the 文獻自動分類 section should be rendered while searching");
				check(!shown(c.querySelector('[data-zb-section="autosync"]')), "自動同步 doesn't match 「分類」 and should be hidden");
				box.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
				eq(box.value, "", "search box after Esc");
				check(!root.classList.contains("zb-searching"), "Esc should end the search");
				eq(selectedTab(), "features", "tab after Esc");
				eq(display(c.querySelector("#zb-panel-sync")), "none", "display of the 同步 panel after Esc");
				// A key typed just before closing (the pane saves 600 ms after the last keystroke)
				let key = c.querySelector("#zb-openai-key");
				key.value = "sk-e2e-typed-then-closed";
				key.dispatchEvent(new win.Event("input"));
			}
			finally {
				d.innerWindowID = win.windowGlobalChild && win.windowGlobalChild.innerWindowId;
				mark("closing");
				win.close();
				mark("closed");
				await zb().secrets.clear("notionToken");
				mark("secret cleared");
			}
			await delay(1000);
			eq(await zb().secrets.get("openaiKey"), "sk-e2e-typed-then-closed",
				"openaiKey typed just before the window closed (the pane's unload handler should save it)");
			await zb().secrets.clear("openaiKey");
			// The pane's pref observers must be gone with the window
			let from = messages.length;
			setPref("llm.provider", "openai");
			setPref("llm.provider", "anthropic");
			setPref("usage.prices", "{}");
			Zotero.Prefs.clear(ZB_PREF + "usage.prices", true);
			// …and the observers on the feature switches and the pending section
			setPref("feature.synthesis", true);
			Zotero.Prefs.clear(ZB_PREF + "feature.synthesis", true);
			setPref("prefs.pendingSection", "notion");
			Zotero.Prefs.clear(ZB_PREF + "prefs.pendingSection", true);
			Zotero.Prefs.clear(ZB_PREF + "prefs.lastTab", true);
			await delay(500);
			let dead = messages.slice(from).filter(m => m.kind === "error");
			check(!dead.length, `changing prefs after the settings window closed logged: ${dead.map(m => m.text).join(" | ")} (pref observers of the closed pane are still registered)`);
		},
		get allow() {
			return ctx.keyStoreUsable ? null : /os-keystore|OSKeyStore|key store|鑰匙圈/i;
		},
		// Errors Zotero's own preferences window logs as well (control test above)
		get allowUnattributed() {
			return ctx.prefsControlErrors || [];
		},
	},
	{
		name: "Zotero's own settings search finds sections in every tab of the pane",
		needs: ["preferences pane opens and renders"],
		timeout: 90000,
		async fn(d) {
			let win = Zotero.Utilities.Internal.openPreferences(PANE_ID);
			try {
				let pane = await waitFor(() => win.Zotero_Preferences && win.Zotero_Preferences.panes
					&& win.Zotero_Preferences.panes.get(PANE_ID), `the preferences window to know pane ${PANE_ID}`, 30000);
				await waitFor(() => pane.loaded && win.ZoteroBridgePrefs, `pane ${PANE_ID} to load`, 30000);
				let c = pane.container;
				let root = c.querySelector("#zotero-bridge-prefs");
				let field = win.document.getElementById("prefs-search");
				check(field, "Zotero's settings search field #prefs-search not found");
				let shown = node => !!node && node.getBoundingClientRect().height > 0;
				let search = (text) => {
					field.value = text;
					field.dispatchEvent(new win.Event("command"));
				};
				// Control: a term no pane has. Zotero loads every pane for it; what that logs is Zotero's
				let from = messages.length;
				search("zqzqxx");
				await waitFor(() => c.classList.contains("hidden-by-search"), "Zotero's search to hide our pane for a term it lacks", 30000);
				check(root.classList.contains("zb-global-search"), "the pane should know Zotero's search is active");
				await delay(500);
				ctx.globalSearchControlErrors = messages.slice(from).filter(m => m.kind === "error" && !m.source && !m.stack).map(m => m.text);
				// 「Notion」: our pane shows, with the 同步 tab's Notion section on screen although 功能 is the selected tab
				win.ZoteroBridgePrefs.selectTab("features");
				search("Notion");
				await waitFor(() => !c.classList.contains("hidden-by-search") && !c.hidden, "Zotero's search to show our pane for 「Notion」", 30000);
				check(root.classList.contains("zb-global-search"), "zb-global-search missing while Zotero's search has text");
				let notion = c.querySelector('[data-zb-section="notion"]');
				d.notionShown = shown(notion);
				check(d.notionShown, "the Notion section (同步 tab) is not on screen during Zotero's search");
				check(!shown(c.querySelector(".zb-nav")), "our search box and tabs should step aside during Zotero's search");
				eq(win.getComputedStyle(c.querySelector("#zb-panel-ai")).display !== "none", true, "an unselected panel's display during Zotero's search");
				// Clearing Zotero's search brings our tabs back
				search("");
				await waitFor(() => !root.classList.contains("zb-global-search"), "the tabs to come back after Zotero's search is cleared", 10000);
				eq(win.getComputedStyle(c.querySelector("#zb-panel-ai")).display, "none", "an unselected panel's display after Zotero's search");
			}
			finally {
				d.innerWindowID = win.windowGlobalChild && win.windowGlobalChild.innerWindowId;
				win.close();
			}
			await delay(500);
		},
		// Errors Zotero's own panes log when its search loads them all (the control step above), and Zotero's own window
		get allowUnattributed() {
			return [...(ctx.globalSearchControlErrors || []), ...(ctx.prefsControlErrors || [])];
		},
	},
	{
		name: "feature presets gate menus and the item pane live (研究生引導 hides, 進階 shows)",
		needs: ["menus are registered with Zotero.MenuManager"],
		async fn(d) {
			let ZB = zb();
			let F = ZB.features;
			// The one-time migration ran at startup; this profile had no earlier use, so 研究生引導
			d.migration = Zotero.Prefs.get(ZB_PREF + "features.version", true);
			eq(d.migration, F.MIGRATION_VERSION, "features.version after startup (ZB.features.migrate())");
			d.startPreset = F.currentPreset();
			eq(d.startPreset, "guided", "preset of a fresh profile");
			let mine = Zotero.MenuManager._menuManager.options.filter(o => o.pluginID === PLUGIN_ID);
			let find = (l10nID) => {
				let found = null;
				let walk = (menus) => {
					for (let m of menus || []) {
						if (found) return;
						if (m.l10nID === l10nID) found = m;
						else walk(m.menus);
					}
				};
				for (let o of mine) walk(o.menus);
				return found;
			};
			// Off in 研究生引導, on in 進階 (features.js); none of these has its own onShowing condition
			// (entries of the item and collection menus' 「ZotMax ▸」 submenus, from content/commands.js)
			const GATED = [
				"zotero-bridge-menu-synthesis", "zotero-bridge-menu-review-draft", "zotero-bridge-menu-ebhc-report",
				"zotero-bridge-toolbar-chase-items", "zotero-bridge-chase-tools-included", "zotero-bridge-chase-tools-import",
				"zotero-bridge-cmd-appraisal-coach",
			];
			// On in both presets
			const ALWAYS = ["zotero-bridge-menu-sync", "zotero-bridge-menu-regenerate", "zotero-bridge-classify-tools", "zotero-bridge-toolbar-screen",
				"zotero-bridge-screen-tools-dedup", "zotero-bridge-screen-tools-prisma", "zotero-bridge-appraisal-tools-summary", "zotero-bridge-cmd-export-collection"];
			// What a menu's onShowing decides, with the context MenuManager would pass
			let visibility = (menu) => {
				let visible = null;
				menu.onShowing({}, {
					items: [], collectionTreeRows: [], menuElem: null,
					setVisible: (v) => {
						visible = !!v;
					},
					setEnabled() {}, setL10nArgs() {}, setIcon() {},
				});
				return visible;
			};
			// The toolbar menu's entries (content/toolbar.js), off in 研究生引導 / on in both
			const TOOLBAR_GATED = ["pubmed-watch", "chase-items", "chase-included", "chase-import", "synthesis", "review-draft",
				"ebhc-report", "progress-report", "concepts-ai", "appraisal-coach"];
			const TOOLBAR_ALWAYS = ["palette", "sync", "sync-no-ai", "sync-obsidian", "sync-notion", "status", "classify", "dashboard", "concepts",
				"bibliography", "export-collection", "quick-search", "search-item", "screen", "dedup", "prisma", "appraisal-summary", "regenerate", "settings"];
			let button = mainWindow().document.getElementById(ZB.toolbar.BUTTON_ID);
			let before = F.snapshot();
			let problems = [];
			if (!button) problems.push("no ZotMax toolbar button in the main window");
			d.visible = {};
			d.toolbar = {};
			try {
				for (let [preset, gatedVisible] of [["guided", false], ["advanced", true], ["guided", false]]) {
					F.applyPreset(preset);
					eq(F.currentPreset(), preset, `currentPreset() after applyPreset("${preset}")`);
					let seen = {};
					for (let id of [...GATED, ...ALWAYS]) {
						let m = find(id);
						if (!m) {
							problems.push(`${id}: not registered`);
							continue;
						}
						if (typeof m.onShowing !== "function") {
							problems.push(`${id}: no onShowing hook (features.gateMenus)`);
							continue;
						}
						let want = GATED.includes(id) ? gatedVisible : true;
						let got = visibility(m);
						seen[id] = got;
						if (got !== want) problems.push(`${preset}: ${id} setVisible(${got}), expected ${want}`);
					}
					d.visible[preset] = seen;
					// The toolbar menu follows the same switches, opened as a click opens it
					if (button) {
						let menu = await openToolbarMenu(button);
						d.toolbar[preset] = menu.entries;
						let groupsWant = ["sync", "organize", "search", "appraise", "ai"];
						if (JSON.stringify(menu.groups) !== JSON.stringify(groupsWant)) {
							problems.push(`${preset}: toolbar menu groups ${JSON.stringify(menu.groups)}, expected ${JSON.stringify(groupsWant)}`);
						}
						for (let id of [...TOOLBAR_GATED, ...TOOLBAR_ALWAYS]) {
							let want = TOOLBAR_GATED.includes(id) ? gatedVisible : true;
							let got = menu.entries.includes(id);
							if (got !== want) problems.push(`${preset}: toolbar menu entry ${id} ${got ? "shown" : "hidden"}, expected ${want ? "shown" : "hidden"}`);
						}
					}
				}
				// One switch away from a preset is 自訂
				F.setEnabled("synthesis", true);
				eq(F.currentPreset(), "custom", "currentPreset() with one switch changed");
				// The item pane drops the rows of features that are off, without a restart
				if (ctx.english) {
					let doc = mainWindow().document;
					let render = () => {
						let body = doc.createElement("div");
						ZB.main.renderPane({ doc, body, item: ctx.english, setSectionSummary: () => {} });
						return body;
					};
					check(render().querySelector("[data-zb-appraisal]"), "with 文獻評讀表 on, the item pane should show its row");
					F.setEnabled("appraisalForm", false);
					check(!render().querySelector("[data-zb-appraisal]"), "with 文獻評讀表 off, the item pane should not show its row");
				}
				// A toolbar group whose features are all off hides with its label
				if (button) {
					F.setEnabled("appraisalForm", false);
					F.setEnabled("screening", false);
					let menu = await openToolbarMenu(button);
					d.toolbar.custom = menu.groups;
					check(!menu.groups.includes("appraise"), `toolbar menu groups with 篩選 and 評讀表 off: ${JSON.stringify(menu.groups)}`);
				}
				// The PubMed watch timer only runs while the feature is on (no watches are saved: nothing is fetched)
				setPref("pubmedWatch.autoCheck", true);
				F.applyPreset("advanced");
				await waitFor(() => ZB.pubmedWatch.timerActive, "the PubMed timer to start when the feature is turned on", 5000);
				F.applyPreset("guided");
				await waitFor(() => !ZB.pubmedWatch.timerActive, "the PubMed timer to stop when the feature is turned off", 5000);
			}
			finally {
				Zotero.Prefs.clear(ZB_PREF + "pubmedWatch.autoCheck", true);
				F.restore(before);
			}
			check(!problems.length, problems.join("; "));
		},
	},
	{
		name: "disable/enable cycle: shutdown() cleans up, startup() registers again",
		needs: ["menus are registered with Zotero.MenuManager"],
		timeout: 60000,
		async fn(d) {
			const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
			let addon = await AddonManager.getAddonByID(PLUGIN_ID);
			let before = zb();
			let count = () => Zotero.MenuManager._menuManager.options.filter(o => o.pluginID === PLUGIN_ID).length;
			let menus = count();
			eq(menus, 3, "menu registrations before the cycle (item, collection, Tools)");
			// An open 快速指令 window goes with the plugin, and so does an open 設定精靈
			let palette = await before.palette.open(mainWindow());
			check(palette, "the palette did not open before the cycle");
			let wizard = await before.setup.open(mainWindow());
			check(wizard, "the setup wizard did not open before the cycle");
			await addon.disable();
			await waitFor(() => !Zotero.ZoteroBridge, "Zotero.ZoteroBridge to be deleted by shutdown()", 20000);
			await waitFor(() => count() === 0, "the plugin's menus to be unregistered", 10000);
			check(!(Zotero.ItemPaneManager.customSectionData.options || []).some(o => o.pluginID === PLUGIN_ID), "item pane section still registered after shutdown");
			check(!mainWindow().document.querySelector('link[href="zotero-bridge.ftl"]'), "FTL link still in the main window after shutdown (onMainWindowUnload)");
			check(!mainWindow().document.getElementById("zotero-bridge-tb-button"), "toolbar button still in the main window after shutdown");
			check(!mainWindow().document.getElementById("zotero-bridge-tb-popup"), "toolbar menu still in the main window after shutdown");
			check(!mainWindow().document.getElementById("zotero-bridge-toolbar-css"), "toolbar stylesheet still in the main window after shutdown");
			check(!mainWindow().document.getElementById("zotero-bridge-sidepanel-css"), "ZotMax panel stylesheet still in the main window after shutdown");
			await waitFor(() => palette.closed, "the 快速指令 window to close at shutdown", 10000);
			await waitFor(() => wizard.closed, "the 設定精靈 window to close at shutdown", 10000);
			eq(Zotero.Prefs.get(ZB_PREF + "setup.done", true), true, "setup.done after the cycle");
			// The shortcut went with it: Ctrl/Cmd+Shift+P opens nothing
			let win = mainWindow();
			win.document.documentElement.dispatchEvent(new win.KeyboardEvent("keydown", {
				key: "P", code: "KeyP", shiftKey: true, ctrlKey: !Zotero.isMac, metaKey: !!Zotero.isMac, bubbles: true, cancelable: true,
			}));
			await delay(1000);
			let paletteWindows = [];
			let all = Services.wm.getEnumerator(null);
			while (all.hasMoreElements()) {
				let w = all.getNext();
				try {
					if (w.document.documentURI === "chrome://zotero-bridge/content/palette.xhtml") paletteWindows.push(w);
				}
				catch (e) {}
			}
			eq(paletteWindows.length, 0, "palette windows after shutdown and the shortcut");
			await addon.enable();
			await waitFor(() => Zotero.ZoteroBridge && Zotero.ZoteroBridge !== before, "a new Zotero.ZoteroBridge after enable()", 20000);
			await waitFor(() => count() === menus, `${menus} menus registered again`, 10000);
			await waitFor(() => (Zotero.ItemPaneManager.customSectionData.options || []).some(o => o.pluginID === PLUGIN_ID),
				"item pane section registered again", 10000);
			await waitFor(() => mainWindow().document.querySelector('link[href="zotero-bridge.ftl"]'), "FTL link back in the main window", 10000);
			await waitFor(() => mainWindow().document.getElementById("zotero-bridge-tb-button"), "toolbar button back in the main window", 10000);
			eq(mainWindow().document.querySelectorAll("#zotero-bridge-tb-button").length, 1, "toolbar buttons after the cycle");
			eq(mainWindow().document.querySelectorAll("#zotero-bridge-toolbar-css").length, 1, "toolbar stylesheets after the cycle");
			eq(mainWindow().document.querySelectorAll("#zotero-bridge-sidepanel-css").length, 1, "ZotMax panel stylesheets after the cycle");
			d.menus = menus;
		},
		// disable() and enable() each rebuild Zotero's plugin l10n source (see the startup test)
		get allowUnattributed() {
			return [...ctx.l10nSourceErrors, ...ctx.l10nSourceErrors];
		},
	},
];

// ---------- runner ----------

async function runTest(t, passed) {
	let rec = { name: t.name, ok: true, ms: 0, error: "", details: {}, startedAt: Date.now() };
	results.tests.push(rec);
	let missing = (t.needs || []).filter(n => !passed.has(n));
	if (missing.length) {
		rec.ok = false;
		rec.skipped = true;
		rec.error = `not run: needs ${missing.map(n => `"${n}"`).join(", ")}`;
		log(`SKIP ${t.name}`);
		return;
	}
	log(`RUN  ${t.name}`);
	let start = Date.now();
	let from = messages.length;
	let timer;
	try {
		await Promise.race([
			t.fn(rec.details),
			new Promise((resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`test timed out after ${(t.timeout || TEST_TIMEOUT_MS) / 1000} s`)), t.timeout || TEST_TIMEOUT_MS);
			}),
		]);
	}
	catch (e) {
		rec.ok = false;
		rec.error = errText(e);
	}
	finally {
		clearTimeout(timer);
	}
	// Console messages arrive asynchronously
	await delay(200);
	let during = messages.slice(from);
	let errs = pluginErrors(during, t.allow);
	if (errs.length) {
		rec.pluginErrors = errs;
		if (rec.ok) {
			rec.ok = false;
			rec.error = `the plugin logged ${errs.length} error(s) during this test: `
				+ errs.slice(0, 3).map(m => `${m.text} (${m.source})`).join(" | ");
		}
	}
	let allowed = t.allow ? during.filter(m => m.kind === "error" && isPluginMessage(m) && t.allow.test(`${m.text}\n${m.source}`)) : [];
	if (allowed.length) rec.allowedErrors = allowed;
	let otherErrors = during.filter(m => m.kind === "error" && !isPluginMessage(m));
	if (otherErrors.length) rec.otherConsoleErrors = otherErrors.slice(0, 10);
	// An error without a source (a promise rejected with undefined, a failed Fluent translation) can't
	// be attributed; Zotero without the plugin logs none (baseline), so count it against the test
	// allowUnattributed lists texts that may occur, once per entry
	let allowance = (t.allowUnattributed || []).slice();
	let unattributed = otherErrors.filter((m) => {
		if (m.source || m.stack) return false;
		let i = allowance.indexOf(m.text);
		if (i === -1) return true;
		allowance.splice(i, 1);
		return false;
	});
	if (unattributed.length && rec.ok) {
		rec.ok = false;
		rec.error = `console error(s) without a source during this test (e.g. a rejected promise or a failed Fluent translation): `
			+ unattributed.slice(0, 3).map(m => m.text).join(" | ");
	}
	rec.ms = Date.now() - start;
	// Copy the details while their windows are still open: a value from a window closed later would
	// make results.json unwritable ("can't access dead object")
	for (let k of ["details", "pluginErrors", "allowedErrors", "otherConsoleErrors"]) {
		if (rec[k] === undefined) continue;
		try {
			rec[k] = JSON.parse(JSON.stringify(rec[k]));
		}
		catch (e) {
			let copy = plain(rec[k]);
			rec[k] = copy && typeof copy === "object" ? copy : { unserializable: String(e) };
		}
	}
	if (rec.ok) passed.add(t.name);
	log(`${rec.ok ? "PASS" : "FAIL"} ${t.name} (${rec.ms} ms)${rec.ok ? "" : `\n       ${rec.error.split("\n")[0]}`}`);
}

async function finish(reason) {
	if (finished) return;
	finished = true;
	results.finishedAt = new Date().toISOString();
	results.reason = reason;
	results.ok = reason === "done" && results.tests.length > 0 && results.tests.every(t => t.ok);
	results.allPluginMessages = plain(messages.filter(isPluginMessage).slice(-100));
	try {
		await IOUtils.writeUTF8(PathUtils.join(workDir, "results.json"), resultsJSON());
		log(`results written (${results.ok ? "all passed" : "FAILED"}: ${reason})`);
	}
	catch (e) {
		log(`could not write results: ${e}`);
	}
	stopCapture();
	// Force: an "attempt" quit can be vetoed by quit-application-requested observers
	setTimeout(() => {
		try {
			Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
		}
		catch (e) {
			log(`quit failed: ${e}`);
		}
	}, 1000);
}

async function main() {
	let deadline = setTimeout(() => {
		results.tests.push({ name: "harness deadline", ok: false, error: `the whole run exceeded ${TOTAL_TIMEOUT_MS / 60000} min` });
		finish("timeout");
	}, TOTAL_TIMEOUT_MS);
	try {
		await Zotero.initializationPromise;
		await Zotero.uiReadyPromise;
		results.zoteroVersion = Zotero.version;
		results.platform = `${Services.appinfo.OS} ${Services.appinfo.XPCOMABI}`;
		results.gecko = Services.appinfo.platformVersion;
		results.locale = Services.locale.appLocaleAsBCP47;
		log(`Zotero ${Zotero.version} (Gecko ${Services.appinfo.platformVersion}) ready`);
		let passed = new Set();
		for (let t of TESTS) {
			if (finished) return;
			await runTest(t, passed);
		}
		clearTimeout(deadline);
		await finish("done");
	}
	catch (e) {
		results.tests.push({ name: "harness", ok: false, error: errText(e) });
		clearTimeout(deadline);
		await finish("harness error");
	}
}

/** Zotero without the plugin: record the console errors of a plain startup, then quit. */
async function baseline() {
	try {
		await Zotero.initializationPromise;
		await Zotero.uiReadyPromise;
		await delay(10000);
		let errors = startupMessages().filter(m => m.kind === "error");
		// Without the plugin: does the main window's re-translation fail, and what does registering an
		// l10n source log (Zotero.Plugins.registerLocales does that for every plugin with locale files)?
		let diag = {};
		let win = Zotero.getMainWindow();
		try {
			await win.document.l10n.translateRoots();
			diag.translateRoots = "ok";
		}
		catch (e) {
			diag.translateRoots = `rejected: ${e}`;
		}
		let from = messages.length;
		try {
			let reg = win.L10nRegistry.getInstance();
			let src = win.L10nFileSource.createMock("zb-e2e-baseline", "app", Services.locale.availableLocales,
				"zb-e2e-baseline:{locale}/", Services.locale.availableLocales.map(l => ({ path: `zb-e2e-baseline:${l}/x.ftl`, source: "zb-e2e-x = x\n" })));
			reg.registerSources([src]);
			// What it logs arrives asynchronously, after a varying delay (a fixed 1.5 s wait sometimes
			// missed it): wait up to 10 s for the first error, then give any that follow a moment to land
			let logged = () => messages.slice(from).filter(m => m.kind === "error");
			let start = Date.now();
			while (!logged().length && Date.now() - start < 10000) await delay(100);
			diag.registerMockSourceWaitMs = Date.now() - start;
			if (logged().length) await delay(1000);
			diag.registerMockSource = logged().map(m => m.text);
		}
		catch (e) {
			diag.registerMockSource = `threw ${e}`;
		}
		await IOUtils.writeUTF8(PathUtils.join(workDir, "baseline.json"),
			JSON.stringify({ zoteroVersion: Zotero.version, errors, diag }, null, 2));
		log(`baseline: ${errors.length} console error(s) without the plugin; ${JSON.stringify(diag)}`);
	}
	catch (e) {
		log(`baseline failed: ${errText(e)}`);
	}
	finished = true;
	stopCapture();
	Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
}

function install() {}

function startup({ id, version }) {
	workDir = Services.prefs.getStringPref(E2E_PREF + "workDir", "");
	if (!workDir) return;
	startCapture();
	ctx.expectedVersion = Services.prefs.getStringPref(E2E_PREF + "expectedVersion", "");
	ctx.expectKeyStore = Services.prefs.getBoolPref(E2E_PREF + "expectKeyStore", false);
	results = { harness: `${id} ${version}`, startedAt: new Date().toISOString(), tests: [] };
	let mode = Services.prefs.getStringPref(E2E_PREF + "mode", "test");
	log(`harness started (${mode}), work dir ${workDir}`);
	if (mode === "baseline") baseline();
	else main();
}

function shutdown() {
	stopCapture();
}

function uninstall() {}
