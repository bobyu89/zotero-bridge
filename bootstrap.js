/* global Zotero, Services */
var ZB;
// chrome://zotero-bridge/content/ (the review dialog of 文獻自動分類, content/classify-review.xhtml)
var chromeHandle = null;

const SCRIPTS = ["apa-zh.js", "appraisal-tools.js", "core.js", "markdown.js", "notion.js", "llm.js", "synthesis.js", "verify.js", "scanned.js", "usage.js", "secrets.js", "zotero-adapter.js", "export.js", "annotation-images.js", "status.js", "review-draft.js", "screening.js", "pubmed-watch.js", "dashboard.js", "citation-chase.js", "search-links.js", "ebhc-report.js", "ai-batch.js", "appraisal-form.js", "progress-report.js", "concepts.js", "classify.js", "features.js", "toolbar.js", "main.js"];

function install() {}

function registerChrome(rootURI) {
	try {
		let aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
			.getService(Components.interfaces.amIAddonManagerStartup);
		let manifestURI = Services.io.newURI(rootURI + "manifest.json");
		chromeHandle = aomStartup.registerChrome(manifestURI, [["content", "zotero-bridge", "content/"]]);
	}
	catch (e) {
		// Only the review dialog needs it; everything else keeps working
		chromeHandle = null;
		if (typeof Zotero !== "undefined" && Zotero.debug) Zotero.debug(`Zotero Bridge: could not register chrome://zotero-bridge/: ${e}`);
	}
}

async function startup({ id, version, rootURI }) {
	registerChrome(rootURI);
	for (let file of SCRIPTS) {
		Services.scriptloader.loadSubScript(rootURI + "content/" + file);
	}
	// Exposed so the preferences pane (a separate scope) can call testNotion()
	Zotero.ZoteroBridge = ZB;
	ZB.version = version;
	ZB.main.init({ id, rootURI });
	// The toolbar button (toolbar.js) loads its stylesheet from chrome:// when that is registered
	ZB.toolbar.init({ rootURI, chrome: !!chromeHandle });
	await Zotero.PreferencePanes.register({
		pluginID: id,
		id: "zotero-bridge-prefs",
		label: "Zotero Bridge",
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
	// The Zotero Bridge button in the items toolbar
	if (ZB && ZB.toolbar) ZB.toolbar.add(window);
}

function onMainWindowUnload({ window }) {
	if (ZB && ZB.toolbar) ZB.toolbar.remove(window);
	window.document.querySelector('[href="zotero-bridge.ftl"]')?.remove();
}

function shutdown() {
	if (ZB && ZB.main) ZB.main.shutdown();
	for (let win of Zotero.getMainWindows()) {
		onMainWindowUnload({ window: win });
	}
	// Windows that are no longer listed as main windows but still hold the button
	if (ZB && ZB.toolbar) ZB.toolbar.shutdown();
	delete Zotero.ZoteroBridge;
	ZB = undefined;
	if (chromeHandle) {
		chromeHandle.destruct();
		chromeHandle = null;
	}
}

function uninstall() {}
