/*
 * ZotMax — the toolbar button in Zotero's main window.
 *
 * One menu button in the items toolbar (#zotero-items-toolbar), right after Zotero's own 「新增筆記」
 * button: the toolbar whose buttons act on the selected items, before the search box. It reuses
 * Zotero's own toolbar button classes, so size, hover, active, focus ring and dropmarker match the
 * buttons next to it (content/toolbar.css only adds the icon).
 *
 * Clicking it opens 快速指令… first, then every command of the command catalog (commands.js) grouped
 * by research workflow (同步／整理／找文獻／篩選與評讀／AI 輔助與寫作), then 回報問題… and 試用回饋…, 設定精靈… and 設定…. The right-click menus
 * (menus.js) and the palette (palette.js) come from the same catalog, so an entry reads and acts the
 * same everywhere; here it acts on the main window's current selection (and the selected collection
 * where a collection command expects one). Visibility is decided each time the menu opens: entries of
 * switched-off features (features.js) and entries that are conditional (a batch to resume, a run to
 * undo) hide, and a group with nothing left hides with its label.
 *
 * Lifecycle (bootstrap.js): add(window) on every main window load and for the windows open at
 * startup, remove(window) on unload and at shutdown. The feature switch 「工具列按鈕」 hides the button
 * live.
 */
(function (root) {
	const BUTTON_ID = "zotero-bridge-tb-button";
	const POPUP_ID = "zotero-bridge-tb-popup";
	const STYLE_ID = "zotero-bridge-toolbar-css";
	const HTML_NS = "http://www.w3.org/1999/xhtml";
	const SWITCH_PREF = "extensions.zotero-bridge.feature.toolbarButton";
	// Zotero's own toolbar items around the button (zoteroPane.xhtml)
	const AFTER_ID = "zotero-tb-note-add";
	const TOOLBAR_ID = "zotero-items-toolbar";

	let rootURI = "";
	let chromeRegistered = false;
	// window → { observer, onKeyDown, toolbar }
	let windows = new Map();

	function ZB() {
		return root.ZB;
	}

	function C() {
		return root.ZB.commands;
	}

	function log(e) {
		Zotero.logError(e);
	}

	function featureOn(id) {
		return ZB().features.isEnabled(id);
	}

	/** The selection in the window the button lives in (commands.js fromWindow). */
	function selection(win) {
		return C().fromWindow(win, "toolbar");
	}

	function run(win, entry) {
		C().execute(entry, selection(win));
	}

	// ---------- DOM ----------

	function xul(doc, tag) {
		return doc.createXULElement ? doc.createXULElement(tag) : doc.createElement(tag);
	}

	function setL10n(el, id, args) {
		let doc = el.ownerDocument;
		if (doc.l10n && doc.l10n.setAttributes) doc.l10n.setAttributes(el, id, args);
		else {
			el.setAttribute("data-l10n-id", id);
			if (args) el.setAttribute("data-l10n-args", JSON.stringify(args));
		}
	}

	function menuitem(doc, win, entry, l10nID = entry.l10n, args = null) {
		let el = xul(doc, "menuitem");
		el.setAttribute("data-zb-entry", entry.id);
		setL10n(el, l10nID, args);
		el.addEventListener("command", () => run(win, entry));
		return el;
	}

	/** A group's label: a XUL menucaption where Gecko defines it, else a disabled item styled the same. */
	function caption(doc, win, group) {
		let hasCaption = !!(win.customElements && win.customElements.get && win.customElements.get("menucaption"));
		let el = xul(doc, hasCaption ? "menucaption" : "menuitem");
		if (!hasCaption) el.setAttribute("disabled", "true");
		el.classList.add("zotero-bridge-tb-caption", "zotero-bridge-caption");
		el.setAttribute("data-zb-group", group.id);
		setL10n(el, group.l10n);
		return el;
	}

	/**
	 * A command with variants (篩選 decisions, databases): a submenu, filled again each time it opens
	 * so the list variants (exclusion reasons, the item's databases) follow the settings and selection.
	 */
	function variantMenu(doc, win, cmd) {
		let menu = xul(doc, "menu");
		menu.setAttribute("data-zb-entry", cmd.id);
		setL10n(menu, cmd.l10n);
		let popup = xul(doc, "menupopup");
		let fill = () => {
			popup.replaceChildren();
			for (let v of C().variantEntries(cmd, selection(win))) {
				if (v.separator) {
					popup.append(xul(doc, "menuseparator"));
					continue;
				}
				let el = menuitem(doc, win, v, v.l10n, v.args);
				if (v.args) el.setAttribute("data-zb-variant", v.variant.id);
				popup.append(el);
			}
		};
		fill();
		popup.addEventListener("popupshowing", (ev) => {
			if (ev.target === popup) fill();
		});
		menu.append(popup);
		return menu;
	}

	function buildPopup(doc, win) {
		let popup = xul(doc, "menupopup");
		popup.id = POPUP_ID;
		// 快速指令… first: the way to everything below by typing
		let palette = menuitem(doc, win, C().PALETTE);
		popup.append(palette);
		let paletteSep = xul(doc, "menuseparator");
		paletteSep.setAttribute("data-zb-palette-separator", "true");
		popup.append(paletteSep);
		for (let group of C().GROUPS) {
			let sep = xul(doc, "menuseparator");
			sep.setAttribute("data-zb-group-separator", group.id);
			popup.append(sep, caption(doc, win, group));
			for (let cmd of C().groupCommands(group.id, "toolbar")) {
				let el = cmd.variants ? variantMenu(doc, win, cmd) : menuitem(doc, win, cmd);
				el.setAttribute("data-zb-group-entry", group.id);
				popup.append(el);
			}
		}
		let sep = xul(doc, "menuseparator");
		sep.setAttribute("data-zb-group-separator", "settings");
		// 回報問題… and 試用回饋… (report.js), then 設定精靈… (always there, so it can be found again), then 設定… last
		let helpSep = xul(doc, "menuseparator");
		helpSep.setAttribute("data-zb-help-separator", "true");
		popup.append(sep, ...C().HELP.map(entry => menuitem(doc, win, entry)), helpSep, menuitem(doc, win, C().SETUP), menuitem(doc, win, C().SETTINGS));
		popup.addEventListener("popupshowing", (ev) => {
			if (ev.target === popup) update(popup);
		});
		return popup;
	}

	/**
	 * Show what applies right now: entries whose feature is on and whose condition holds; a group
	 * without any (label and separator) hides; the first visible group has no separator above it (快速指令…
	 * has its own). Returns the visible group IDs.
	 */
	function update(popup) {
		let shown = [];
		for (let group of C().GROUPS) {
			let any = false;
			for (let cmd of C().groupCommands(group.id, "toolbar")) {
				let el = popup.querySelector(`[data-zb-entry="${cmd.id}"]`);
				if (!el) continue;
				let visible = C().isVisible(cmd);
				el.hidden = !visible;
				if (visible && cmd.args) {
					try {
						setL10n(el, cmd.l10n, cmd.args());
					}
					catch (e) {
						log(e);
					}
				}
				any = any || visible;
			}
			popup.querySelector(`[data-zb-group="${group.id}"]`).hidden = !any;
			popup.querySelector(`[data-zb-group-separator="${group.id}"]`).hidden = !any || !shown.length;
			if (any) shown.push(group.id);
		}
		// The shortcut next to 快速指令… (palette.js), when it is registered
		let palette = popup.querySelector('[data-zb-entry="palette"]');
		let accel = ZB().palette && ZB().palette.shortcutLabel();
		if (palette) {
			if (accel) palette.setAttribute("acceltext", accel);
			else palette.removeAttribute("acceltext");
		}
		return shown;
	}

	function applySwitch(button) {
		button.hidden = !featureOn("toolbarButton");
	}

	function stylesheetURL() {
		return (chromeRegistered ? "chrome://zotero-bridge/" : rootURI) + "content/toolbar.css";
	}

	/** Keyboard: Zotero moves focus across its toolbar with the arrow keys; take the button into that row. */
	function keyHandler(doc, button) {
		return (ev) => {
			let next = (typeof Zotero.arrowNextKey === "string" && Zotero.arrowNextKey) || "ArrowRight";
			let previous = (typeof Zotero.arrowPreviousKey === "string" && Zotero.arrowPreviousKey) || "ArrowLeft";
			// Ctrl/Alt/Cmd+Tab belong to the window, as in Zotero's own handler
			if (ev.key === "Tab" && (ev.ctrlKey || ev.altKey || ev.metaKey)) return;
			let target = null;
			if (ev.target && ev.target.id === AFTER_ID) {
				// Zotero ends the row at 新增筆記; the button continues it
				if (ev.key !== next || button.hidden) return;
				target = button;
			}
			else if (ev.target === button) {
				if (ev.key === previous) target = doc.getElementById(AFTER_ID);
				else if (ev.key === "Tab" && !ev.shiftKey) target = doc.getElementById("zotero-tb-search");
				else if (ev.key === "Tab") {
					// Shift+Tab as from Zotero's own buttons in this row: to the collection search
					let search = doc.getElementById("zotero-tb-collections-search");
					if (search) search.click();
				}
				// The last button in the row: ArrowNext stays; anything else (Enter, Space, ArrowDown opens the menu) is the button's own
				else if (ev.key !== next) return;
			}
			else {
				return;
			}
			if (target) target.focus();
			ev.preventDefault();
			ev.stopPropagation();
		};
	}

	// ---------- lifecycle ----------

	function init(opts = {}) {
		rootURI = opts.rootURI || rootURI;
		chromeRegistered = !!opts.chrome;
	}

	/** Add the button to a main window (once; again after remove()). Returns the button or null. */
	function add(win) {
		if (!win || !win.document) return null;
		let doc = win.document;
		let toolbar = doc.getElementById(TOOLBAR_ID);
		if (!toolbar) {
			Zotero.debug(`ZotMax: no #${TOOLBAR_ID} in this window; toolbar button not added`);
			return null;
		}
		remove(win);
		if (!doc.getElementById(STYLE_ID)) {
			let link = doc.createElementNS(HTML_NS, "link");
			link.id = STYLE_ID;
			link.setAttribute("rel", "stylesheet");
			link.setAttribute("href", stylesheetURL());
			doc.documentElement.append(link);
		}
		let button = xul(doc, "toolbarbutton");
		button.id = BUTTON_ID;
		button.className = "zotero-tb-button";
		// Like Zotero's buttons in this row: focus moves with the arrow keys (keyHandler), not Tab
		button.setAttribute("tabindex", "-1");
		button.setAttribute("type", "menu");
		button.setAttribute("wantdropmarker", "true");
		// The product name, the same in every language
		button.setAttribute("tooltiptext", "ZotMax");
		button.setAttribute("aria-label", "ZotMax");
		button.append(buildPopup(doc, win));
		let after = doc.getElementById(AFTER_ID);
		if (after && after.parentNode === toolbar) after.after(button);
		else toolbar.append(button);
		applySwitch(button);

		let onKeyDown = keyHandler(doc, button);
		toolbar.addEventListener("keydown", onKeyDown);
		let observer = null;
		if (Zotero.Prefs.registerObserver) {
			observer = Zotero.Prefs.registerObserver(SWITCH_PREF, () => applySwitch(button), true);
		}
		windows.set(win, { toolbar, onKeyDown, observer });
		return button;
	}

	/** Take the button, its stylesheet, key handler and pref observer out of a window. */
	function remove(win) {
		if (!win) return;
		let state = windows.get(win);
		if (state) {
			state.toolbar.removeEventListener("keydown", state.onKeyDown);
			if (state.observer && Zotero.Prefs.unregisterObserver) Zotero.Prefs.unregisterObserver(state.observer);
			windows.delete(win);
		}
		let doc = win.document;
		if (!doc) return;
		let button = doc.getElementById(BUTTON_ID);
		if (button) button.remove();
		let link = doc.getElementById(STYLE_ID);
		if (link) link.remove();
	}

	/** Every window still holding the button (after shutdown: none). */
	function shutdown() {
		for (let win of [...windows.keys()]) remove(win);
	}

	(root.ZB = root.ZB || {}).toolbar = {
		BUTTON_ID, POPUP_ID, STYLE_ID, SWITCH_PREF,
		init, add, remove, shutdown, update, selection,
		get windowCount() { return windows.size; },
	};
})(this);
