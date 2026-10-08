/* global Zotero, Services */
var ZB;

const SCRIPTS = ["core.js", "markdown.js", "notion.js", "llm.js", "synthesis.js", "verify.js", "usage.js", "secrets.js", "zotero-adapter.js", "export.js", "main.js"];

function install() {}

async function startup({ id, version, rootURI }) {
	for (let file of SCRIPTS) {
		Services.scriptloader.loadSubScript(rootURI + "content/" + file);
	}
	// Exposed so the preferences pane (a separate scope) can call testNotion()
	Zotero.ZoteroBridge = ZB;
	ZB.version = version;
	ZB.main.init({ id, rootURI });
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
}

function onMainWindowUnload({ window }) {
	window.document.querySelector('[href="zotero-bridge.ftl"]')?.remove();
}

function shutdown() {
	if (ZB && ZB.main) ZB.main.shutdown();
	for (let win of Zotero.getMainWindows()) {
		onMainWindowUnload({ window: win });
	}
	delete Zotero.ZoteroBridge;
	ZB = undefined;
}

function uninstall() {}
