/*
 * Zotero Bridge end-to-end test harness: a second bootstrap plugin installed next to Zotero Bridge
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
 * Open the Zotero Bridge toolbar menu as a click does, read what it shows (visible group IDs, entry
 * IDs and translated labels), close it again.
 */
async function openToolbarMenu(button) {
	let win = button.ownerGlobal;
	let popup = button.querySelector("menupopup");
	check(popup, "the toolbar button has no menupopup");
	popup.openPopup(button, "after_start", 0, 0, false, false);
	try {
		await waitFor(() => popup.state === "open", "the Zotero Bridge toolbar menu to open", 10000);
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
		await waitFor(() => popup.state === "closed", "the Zotero Bridge toolbar menu to close", 10000);
	}
}

const ctx = { l10nSourceErrors: [] };

// ---------- tests ----------

const TESTS = [
	{
		name: "Zotero Bridge is installed and enabled (AddonManager)",
		async fn(d) {
			const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
			let addon = await AddonManager.getAddonByID(PLUGIN_ID);
			check(addon, `AddonManager does not know ${PLUGIN_ID}: the .xpi in <profile>/extensions was not picked up at startup`);
			Object.assign(d, {
				version: addon.version, isActive: addon.isActive, userDisabled: addon.userDisabled,
				appDisabled: addon.appDisabled, scope: addon.scope, type: addon.type,
			});
			check(addon.type === "extension", `add-on type is ${addon.type}, not "extension"`);
			check(addon.isActive, `the plugin is installed but not active (userDisabled=${addon.userDisabled}, appDisabled=${addon.appDisabled}, `
				+ `softDisabled=${addon.softDisabled}); appDisabled usually means Zotero rejected manifest.json (strict_min_version/strict_max_version)`);
			eq(addon.version, ctx.expectedVersion, "installed plugin version differs from manifest.json");
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
				adapter: ["extractItemData", "saveAINote", "getAINote", "toRegularItems"],
				fulltext: ["prepare", "render", "verifyAIHighlights", "writeObsidian", "writeNotion", "runMarkitdown"],
				bibliography: ["exportLibrary", "exportCollections", "citekeyFor", "afterSync"],
				images: ["collect"],
				status: ["runPass", "prepare", "setItemStatus"],
				reviewDraft: ["run"],
				screening: ["setDecision", "generateReport", "registerMenus"],
				pubmedWatch: ["init", "shutdown", "runAll", "registerMenus"],
				dashboard: ["update", "afterSync", "registerMenus"],
				concepts: ["update", "afterSync", "dashboardSection", "synthesizeFromMenu", "registerMenus"],
				classify: ["parseRules", "evaluate", "parseTopics", "suggest", "defaultPicks", "planApply", "apply", "undoLast", "readLastRun", "review", "renderReview", "run", "registerMenus"],
				citationChase: ["chaseCollection", "chaseItems", "importChecked", "registerMenus"],
				searchLinks: ["buildTarget", "itemTargets", "noteCallout", "calloutFor", "renderPaneRow", "quickSearch", "registerMenus"],
				aiBatch: ["submit", "check", "cancelAll", "init", "shutdown", "registerMenus", "batchParams", "parseResults"],
				ebhcReport: ["run", "askOptions", "processReport", "buildReportNote"],
				appraisalForm: ["renderPaneRow", "syncInfo", "saveRecord", "exportSummary", "registerMenus"],
				progressReport: ["run", "askOptions", "logStatusChange", "latestReport", "registerMenus"],
				features: ["isEnabled", "rawValue", "applyPreset", "currentPreset", "snapshot", "restore", "migrate", "gateMenus"],
				toolbar: ["init", "add", "remove", "shutdown", "update"],
				main: ["init", "shutdown", "run", "readSettings", "renderPane", "saveQuietly", "renameNotionColumns", "notionClient", "prepareFullText"],
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
			const EXPECTED = {
				"zotero-bridge-item": "main/library/item",
				"zotero-bridge-collection": "main/library/collection",
				"zotero-bridge-tools": "main/menubar/tools",
				"zotero-bridge-export-tools": "main/menubar/tools",
				"zotero-bridge-export-collection": "main/library/collection",
				"zotero-bridge-screening-item": "main/library/item",
				"zotero-bridge-screening-collection": "main/library/collection",
				"zotero-bridge-screening-tools": "main/menubar/tools",
				"zotero-bridge-pubmed-watch-tools": "main/menubar/tools",
				"zotero-bridge-dashboard-tools": "main/menubar/tools",
				"zotero-bridge-concepts-tools": "main/menubar/tools",
				"zotero-bridge-chase-item": "main/library/item",
				"zotero-bridge-chase-collection": "main/library/collection",
				"zotero-bridge-chase-tools": "main/menubar/tools",
				"zotero-bridge-search-item": "main/library/item",
				"zotero-bridge-search-tools": "main/menubar/tools",
				"zotero-bridge-ai-batch-tools": "main/menubar/tools",
				"zotero-bridge-appraisal-collection": "main/library/collection",
				"zotero-bridge-appraisal-tools": "main/menubar/tools",
				"zotero-bridge-progress-report-tools": "main/menubar/tools",
				"zotero-bridge-classify-item": "main/library/item",
				"zotero-bridge-classify-collection": "main/library/collection",
				"zotero-bridge-classify-tools": "main/menubar/tools",
			};
			d.registered = mine.map(o => `${o.menuID} → ${o.target}`);
			let problems = [];
			for (let [id, target] of Object.entries(EXPECTED)) {
				let full = CSS.escape(`${PLUGIN_ID}-${id}`);
				let opt = mine.find(o => o.menuID === full || o.menuID === id);
				if (!opt) problems.push(`${id} not registered (registerMenu() returned false — see "MenuAPI:" warnings in zotero.log)`);
				else if (opt.target !== target) problems.push(`${id} has target ${opt.target}, expected ${target}`);
			}
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
			Object.assign(d, { pluginID: pane.pluginID, src: pane.src, scripts: pane.scripts, label: pane.label });
			eq(pane.pluginID, PLUGIN_ID, "pane pluginID");
			check(/content\/preferences\.xhtml$/.test(pane.src), `pane src is ${pane.src}`);
			check((pane.scripts || []).some(s => /content\/preferences\.js$/.test(s)), "pane scripts do not include content/preferences.js");
		},
	},
	{
		name: "item pane section is registered",
		needs: ["Zotero.ZoteroBridge is set and has every module"],
		async fn(d) {
			let data = Zotero.ItemPaneManager.customSectionData;
			let mine = (data.options || []).filter(o => o.pluginID === PLUGIN_ID);
			d.sections = mine.map(o => o.paneID);
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
			let args = { count: 3, reason: "E2E", name: "E2E", preset: "guided", req: "sync", color: "yellow" };
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
				ids.forEach((id, i) => {
					let m = msgs[i];
					let text = m && (m.value || (m.attributes || []).map(a => a.value).join(""));
					if (!text || !text.trim()) missing.push(id);
				});
				report[locale] = { checked: ids.length, missing };
				if (missing.length) problems.push(`${locale}: no text for ${missing.join(", ")}`);
				if (locale === "zh-TW") {
					let [label] = await l10n.formatMessages([{ id: "zotero-bridge-menu-settings" }]);
					report[locale].sample = label && label.attributes && label.attributes[0] && label.attributes[0].value;
				}
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
					let ours = [...popup.querySelectorAll("[data-l10n-id]")].filter(e => e.dataset.l10nId.startsWith("zotero-bridge-"));
					// Labels with variables get their args in onShowing; give them some here
					for (let el of ours) {
						if (!el.dataset.l10nArgs) el.dataset.l10nArgs = JSON.stringify({ count: 3, reason: "E2E", name: "E2E" });
					}
					await doc.l10n.translateFragment(popup);
					rendered[target] = ours.map(e => `${e.dataset.l10nId}: ${e.getAttribute("label")}`);
					if (!ours.length) problems.push(`${target}: no Zotero Bridge menu elements were created`);
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
				"the Zotero Bridge toolbar button (bootstrap onMainWindowLoad → ZB.toolbar.add)", 10000);
			eq(doc.querySelectorAll("#" + T.BUTTON_ID).length, 1, "toolbar buttons in the main window");
			d.parent = button.parentNode && button.parentNode.id;
			eq(d.parent, "zotero-items-toolbar", "the toolbar holding the button");
			eq(button.previousElementSibling && button.previousElementSibling.id, "zotero-tb-note-add", "the button's neighbour on the left");
			eq(button.getAttribute("aria-label"), "Zotero Bridge", "aria-label");
			eq(button.getAttribute("tooltiptext"), "Zotero Bridge", "tooltiptext");
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
			// The real item pane: select the item and wait for the section to render
			await win.ZoteroPane.selectItem(ctx.english.id);
			let section = await waitFor(() => [...doc.querySelectorAll("item-pane-custom-section")].find(e => e.dataset.pane === ctx.paneKey),
				`<item-pane-custom-section data-pane="${ctx.paneKey}"> in the item pane`, 20000);
			let details = section.closest("item-details");
			if (details && details.scrollToPane) details.scrollToPane(ctx.paneKey, "instant");
			await waitFor(() => section.textContent.includes("E2E stubbed summary sentence."),
				"the plugin's item pane section to render the AI note", 20000);
			d.sectionText = section.textContent.replace(/\s+/g, " ").slice(0, 200);
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
				d.notes = plan.notes;
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
				let found = () => api.sections().filter(s => s.visible
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
			const GATED = [
				"zotero-bridge-menu-synthesis", "zotero-bridge-menu-review-draft", "zotero-bridge-menu-ebhc-report",
				"zotero-bridge-menu-pubmed-watch", "zotero-bridge-chase-items", "zotero-bridge-chase-tools-included",
				"zotero-bridge-menu-progress-report", "zotero-bridge-menu-concepts-ai",
			];
			// On in both presets
			const ALWAYS = ["zotero-bridge-menu-sync", "zotero-bridge-search-tools", "zotero-bridge-screen-tools-dedup",
				"zotero-bridge-menu-dashboard", "zotero-bridge-menu-concepts-update", "zotero-bridge-classify-items", "zotero-bridge-classify-tools"];
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
				"ebhc-report", "progress-report", "concepts-ai"];
			const TOOLBAR_ALWAYS = ["sync", "sync-no-ai", "sync-obsidian", "sync-notion", "status", "classify", "dashboard", "concepts",
				"bibliography", "quick-search", "screen", "dedup", "prisma", "appraisal-summary", "regenerate", "settings"];
			let button = mainWindow().document.getElementById(ZB.toolbar.BUTTON_ID);
			let before = F.snapshot();
			let problems = [];
			if (!button) problems.push("no Zotero Bridge toolbar button in the main window");
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
			await addon.disable();
			await waitFor(() => !Zotero.ZoteroBridge, "Zotero.ZoteroBridge to be deleted by shutdown()", 20000);
			await waitFor(() => count() === 0, "the plugin's menus to be unregistered", 10000);
			check(!(Zotero.ItemPaneManager.customSectionData.options || []).some(o => o.pluginID === PLUGIN_ID), "item pane section still registered after shutdown");
			check(!mainWindow().document.querySelector('link[href="zotero-bridge.ftl"]'), "FTL link still in the main window after shutdown (onMainWindowUnload)");
			check(!mainWindow().document.getElementById("zotero-bridge-tb-button"), "toolbar button still in the main window after shutdown");
			check(!mainWindow().document.getElementById("zotero-bridge-tb-popup"), "toolbar menu still in the main window after shutdown");
			check(!mainWindow().document.getElementById("zotero-bridge-toolbar-css"), "toolbar stylesheet still in the main window after shutdown");
			await addon.enable();
			await waitFor(() => Zotero.ZoteroBridge && Zotero.ZoteroBridge !== before, "a new Zotero.ZoteroBridge after enable()", 20000);
			await waitFor(() => count() === menus, `${menus} menus registered again`, 10000);
			await waitFor(() => (Zotero.ItemPaneManager.customSectionData.options || []).some(o => o.pluginID === PLUGIN_ID),
				"item pane section registered again", 10000);
			await waitFor(() => mainWindow().document.querySelector('link[href="zotero-bridge.ftl"]'), "FTL link back in the main window", 10000);
			await waitFor(() => mainWindow().document.getElementById("zotero-bridge-tb-button"), "toolbar button back in the main window", 10000);
			eq(mainWindow().document.querySelectorAll("#zotero-bridge-tb-button").length, 1, "toolbar buttons after the cycle");
			eq(mainWindow().document.querySelectorAll("#zotero-bridge-toolbar-css").length, 1, "toolbar stylesheets after the cycle");
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
	if (rec.ok) passed.add(t.name);
	log(`${rec.ok ? "PASS" : "FAIL"} ${t.name} (${rec.ms} ms)${rec.ok ? "" : `\n       ${rec.error.split("\n")[0]}`}`);
}

async function finish(reason) {
	if (finished) return;
	finished = true;
	results.finishedAt = new Date().toISOString();
	results.reason = reason;
	results.ok = reason === "done" && results.tests.length > 0 && results.tests.every(t => t.ok);
	results.allPluginMessages = messages.filter(isPluginMessage).slice(-100);
	try {
		await IOUtils.writeUTF8(PathUtils.join(workDir, "results.json"), JSON.stringify(results, null, 2));
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
