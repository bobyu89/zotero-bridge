/* global Zotero, Services */
var ZB;
// chrome://zotero-bridge/content/ (the review dialog of 文獻自動分類, content/classify-review.xhtml,
// the 快速指令 window, content/palette.xhtml, and the 設定精靈 window, content/setup.xhtml)
var chromeHandle = null;

const SCRIPTS = ["apa-zh.js", "appraisal-tools.js", "core.js", "markdown.js", "notion.js", "llm.js", "synthesis.js", "verify.js", "fulltext-md.js", "scanned.js", "usage.js", "secrets.js", "zotero-adapter.js", "fulltext.js", "export.js", "annotation-images.js", "status.js", "review-draft.js", "screening.js", "pubmed-watch.js", "dashboard.js", "citation-chase.js", "search-links.js", "ebhc-report.js", "ai-batch.js", "appraisal-coach.js", "appraisal-form.js", "progress-report.js", "concepts.js", "classify.js", "stats-explainer.js", "features.js", "commands.js", "menus.js", "palette.js", "setup.js", "toolbar.js", "sidepanel.js", "main.js"];

function install() {}

function registerChrome(rootURI) {
	try {
		let aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
			.getService(Components.interfaces.amIAddonManagerStartup);
		let manifestURI = Services.io.newURI(rootURI + "manifest.json");
		chromeHandle = aomStartup.registerChrome(manifestURI, [["content", "zotero-bridge", "content/"]]);
	}
	catch (e) {
		// Only the review dialog, 快速指令 and 設定精靈 need it; everything else keeps working
		chromeHandle = null;
		if (typeof Zotero !== "undefined" && Zotero.debug) Zotero.debug(`ZotMax: could not register chrome://zotero-bridge/: ${e}`);
	}
}

// reason: the add-on manager's BOOTSTRAP_REASONS value (ADDON_INSTALL on a new install); the setup
// wizard (setup.js) decides from it and the profile whether to open by itself
async function startup({ id, version, rootURI }, reason) {
	registerChrome(rootURI);
	for (let file of SCRIPTS) {
		Services.scriptloader.loadSubScript(rootURI + "content/" + file);
	}
	// Exposed so the preferences pane (a separate scope) can call testNotion()
	Zotero.ZoteroBridge = ZB;
	ZB.version = version;
	// The ZotMax panel (sidepanel.js) loads its stylesheet from chrome:// when that is registered
	ZB.main.init({ id, rootURI, chrome: !!chromeHandle, reason });
	// The toolbar button (toolbar.js) loads its stylesheet from chrome:// when that is registered
	ZB.toolbar.init({ rootURI, chrome: !!chromeHandle });
	await Zotero.PreferencePanes.register({
		pluginID: id,
		id: "zotero-bridge-prefs",
		label: "ZotMax",
		image: rootURI + "content/icons/bridge.svg",
		src: rootURI + "content/preferences.xhtml",
		scripts: [rootURI + "content/preferences.js"],
		stylesheets: [rootURI + "content/preferences.css"],
	});
	for (let win of Zotero.getMainWindows()) {
		onMainWindowLoad({ window: win });
	}
}

function onMainWindowLoad({ window }) {
	window.MozXULElement.insertFTLIfNeeded("zotero-bridge.ftl");
	// The ZotMax panel's stylesheet (item pane and the reader's side pane)
	if (ZB && ZB.sidepanel) ZB.sidepanel.addStylesheet(window);
	// The ZotMax button in the items toolbar
	if (ZB && ZB.toolbar) ZB.toolbar.add(window);
	// Ctrl+Shift+P (⇧⌘P) opens 快速指令
	if (ZB && ZB.palette) ZB.palette.attach(window);
}

function onMainWindowUnload({ window }) {
	if (ZB && ZB.sidepanel) ZB.sidepanel.removeStylesheet(window);
	if (ZB && ZB.toolbar) ZB.toolbar.remove(window);
	if (ZB && ZB.palette) ZB.palette.detach(window);
	window.document.querySelector('[href="zotero-bridge.ftl"]')?.remove();
}

function shutdown() {
	if (ZB && ZB.main) ZB.main.shutdown();
	for (let win of Zotero.getMainWindows()) {
		onMainWindowUnload({ window: win });
	}
	// Windows that are no longer listed as main windows but still hold the button or the shortcut;
	// the 快速指令 and 設定精靈 windows close
	if (ZB && ZB.toolbar) ZB.toolbar.shutdown();
	if (ZB && ZB.palette) ZB.palette.shutdown();
	if (ZB && ZB.setup) ZB.setup.shutdown();
	delete Zotero.ZoteroBridge;
	ZB = undefined;
	if (chromeHandle) {
		chromeHandle.destruct();
		chromeHandle = null;
	}
}

function uninstall() {}
