/*
 * Zotero Bridge — the toolbar button in Zotero's main window.
 *
 * One menu button in the items toolbar (#zotero-items-toolbar), right after Zotero's own 「新增筆記」
 * button: the toolbar whose buttons act on the selected items, before the search box. It reuses
 * Zotero's own toolbar button classes, so size, hover, active, focus ring and dropmarker match the
 * buttons next to it (content/toolbar.css only adds the icon).
 *
 * Clicking it opens the plugin's commands grouped by research workflow (同步／整理／找文獻／篩選與評讀／
 * AI 輔助與寫作), then 設定…. Every entry calls the function the existing right-click or Tools menu
 * entry calls, on the main window's current selection (and the selected collection where the
 * collection commands expect one). Visibility is decided each time the menu opens: entries of
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

	const NEED_ITEMS = "請先選取文獻。";
	const NEED_REVIEW_COLLECTION = "請先在左側選取系統性回顧的分類（回顧專案）。";

	let rootURI = "";
	let chromeRegistered = false;
	// window → { observer, onKeyDown, toolbar }
	let windows = new Map();

	function ZB() {
		return root.ZB;
	}

	function log(e) {
		Zotero.logError(e);
	}

	function featureOn(id) {
		return ZB().features.isEnabled(id);
	}

	function notify(text, headline = "Zotero Bridge") {
		ZB().main.notify(headline, text);
	}

	// ---------- the selection in the window the button lives in ----------

	function selection(win) {
		let pane = (win && win.ZoteroPane) || Zotero.getActiveZoteroPane();
		let items = [];
		let collection = null;
		try {
			items = (pane && pane.getSelectedItems && pane.getSelectedItems()) || [];
		}
		catch (e) {
			items = [];
		}
		try {
			collection = (pane && pane.getSelectedCollections && pane.getSelectedCollections()[0]) || null;
		}
		catch (e) {
			collection = null;
		}
		// The shape MenuManager hands the context-menu entries, for the functions that read it
		let collectionTreeRows = collection ? [{ isCollection: () => true, ref: collection }] : [];
		return { items, collection, collectionTreeRows };
	}

	/** The selected items, or the message the plugin shows when there are none. */
	function selectedItems(sel) {
		let items = ZB().adapter.toRegularItems(sel.items);
		if (!items.length) notify(NEED_ITEMS);
		return items;
	}

	function needCollection(sel, fn, text = NEED_REVIEW_COLLECTION, headline) {
		if (!sel.collection) {
			notify(text, headline);
			return null;
		}
		return fn(sel.collection);
	}

	/**
	 * The AI writing commands: the selected items as from the item menu (main.js itemScope), or with no
	 * item selected the selected collection as from the collection menu (main.js collectionScope).
	 */
	function writingTarget(sel) {
		let regular = ZB().adapter.toRegularItems(sel.items);
		if (!regular.length && sel.collection) {
			return {
				items: ZB().adapter.itemsInCollection(sel.collection, true),
				scope: { label: sel.collection.name || "分類", collection: sel.collection },
				context: { items: [], collectionTreeRows: sel.collectionTreeRows },
			};
		}
		return {
			items: sel.items,
			scope: { label: sel.collection ? `${sel.collection.name}（選取）` : "選取的文獻", collection: null },
			context: { items: sel.items, collectionTreeRows: sel.collectionTreeRows },
		};
	}

	function sync(action) {
		return (sel) => {
			let items = selectedItems(sel);
			return items.length ? ZB().main.run(items, action) : null;
		};
	}

	function screen(change) {
		return (sel) => {
			let items = selectedItems(sel);
			return items.length ? ZB().screening.setDecision(items, change) : null;
		};
	}

	function pendingBatch() {
		try {
			return ZB().main.readPendingBatch();
		}
		catch (e) {
			return null;
		}
	}

	// ---------- the menu ----------

	const BOTH = ["notion", "obsidian"];

	/**
	 * Groups in research-workflow order. Entry: id, l10nID (existing menu IDs where they fit), feature
	 * (hidden while off; none: always), when (an extra live condition), args (Fluent arguments),
	 * command(selection) or submenu (entries of the same shape).
	 */
	const GROUPS = [
		{ id: "sync", l10nID: "zotero-bridge-toolbar-group-sync", entries: [
			{ id: "sync", l10nID: "zotero-bridge-toolbar-sync", feature: "sync", command: sync({ targets: BOTH, ai: "missing" }) },
			{ id: "sync-no-ai", l10nID: "zotero-bridge-menu-no-ai", feature: "sync", command: sync({ targets: BOTH, ai: "reuse" }) },
			{ id: "sync-obsidian", l10nID: "zotero-bridge-menu-obsidian", feature: "sync", command: sync({ targets: ["obsidian"], ai: "reuse" }) },
			{ id: "sync-notion", l10nID: "zotero-bridge-menu-notion", feature: "sync", command: sync({ targets: ["notion"], ai: "reuse" }) },
			{ id: "status", l10nID: "zotero-bridge-menu-status", feature: "status", command: () => ZB().status.runPass() },
			// Like the Tools menu: resume while a stopped or failed batch is left and none runs, stop while one runs
			{ id: "resume", l10nID: "zotero-bridge-menu-resume", feature: "sync",
				when: () => {
					let b = pendingBatch();
					return !!b && !b.running;
				},
				args: () => {
					let b = pendingBatch();
					return { count: b ? b.remaining.length + b.failed.length : 0 };
				},
				command: () => ZB().main.resumeBatch() },
			{ id: "stop", l10nID: "zotero-bridge-menu-stop",
				when: () => {
					let b = pendingBatch();
					return !!b && !!b.running;
				},
				command: () => ZB().main.cancelBatch() },
		] },
		{ id: "organize", l10nID: "zotero-bridge-toolbar-group-organize", entries: [
			{ id: "classify", l10nID: "zotero-bridge-classify-tools", feature: "autoClassify",
				// Like the Tools entry: the selected items, else the selected collection
				command: (sel) => {
					let items = sel.items.length ? sel.items : sel.collection ? ZB().adapter.itemsInCollection(sel.collection, true) : [];
					return ZB().classify.run(items);
				} },
			// Not gated, like the Tools entry: what was applied can always be taken back
			{ id: "classify-undo", l10nID: "zotero-bridge-classify-undo", when: () => !!ZB().classify.readLastRun(), command: () => ZB().classify.undoLast() },
			{ id: "dashboard", l10nID: "zotero-bridge-menu-dashboard", feature: "dashboard", command: () => ZB().dashboard.runFromMenu() },
			{ id: "concepts", l10nID: "zotero-bridge-menu-concepts-update", feature: "concepts", command: () => ZB().concepts.runFromMenu() },
			{ id: "bibliography", l10nID: "zotero-bridge-menu-export-library", feature: "bibliography", command: () => ZB().bibliography.exportLibrary() },
		] },
		{ id: "search", l10nID: "zotero-bridge-toolbar-group-search", entries: [
			{ id: "quick-search", l10nID: "zotero-bridge-search-tools", feature: "searchLinks", command: () => ZB().searchLinks.quickSearch() },
			{ id: "pubmed-watch", l10nID: "zotero-bridge-menu-pubmed-watch", feature: "pubmedWatch", command: () => ZB().pubmedWatch.runAll() },
			// chaseItems shows its own message when nothing is selected
			{ id: "chase-items", l10nID: "zotero-bridge-toolbar-chase-items", feature: "citationChase",
				command: sel => ZB().citationChase.chaseItems(sel.items, sel.collection) },
			{ id: "chase-included", l10nID: "zotero-bridge-chase-tools-included", feature: "citationChase",
				command: sel => needCollection(sel, c => ZB().citationChase.chaseCollection(c), NEED_REVIEW_COLLECTION, "Zotero Bridge：引文追蹤") },
			// Without a selected collection: the 「所選文獻」 note, imported into My Library (as from the Tools menu)
			{ id: "chase-import", l10nID: "zotero-bridge-chase-tools-import", feature: "citationChase",
				command: sel => ZB().citationChase.importChecked(sel.collection) },
		] },
		{ id: "appraise", l10nID: "zotero-bridge-toolbar-group-appraise", entries: [
			{ id: "screen", l10nID: "zotero-bridge-toolbar-screen", feature: "screening", submenu: [
				{ id: "screen-ta-include", l10nID: "zotero-bridge-screen-ta-include", command: screen({ stage: "ta", decision: "include" }) },
				{ id: "screen-ta-exclude", l10nID: "zotero-bridge-screen-ta-exclude", command: screen({ stage: "ta", decision: "exclude" }) },
				{ id: "screen-ta-maybe", l10nID: "zotero-bridge-screen-ta-maybe", command: screen({ stage: "ta", decision: "maybe" }) },
				{ separator: true },
				{ id: "screen-ft-include", l10nID: "zotero-bridge-screen-ft-include", command: screen({ stage: "ft", decision: "include" }) },
				// Filled with the exclusion reasons from the settings each time it opens
				{ id: "screen-ft-exclude", l10nID: "zotero-bridge-screen-ft-exclude", reasons: true },
				{ id: "screen-ft-not-retrieved", l10nID: "zotero-bridge-screen-ft-not-retrieved", command: screen({ stage: "ft", decision: "notRetrieved" }) },
				{ separator: true },
				{ id: "screen-duplicate", l10nID: "zotero-bridge-screen-duplicate", command: screen({ duplicate: true }) },
				{ id: "screen-clear", l10nID: "zotero-bridge-screen-clear", command: screen({ clear: true }) },
			] },
			{ id: "dedup", l10nID: "zotero-bridge-screen-tools-dedup", feature: "screening",
				command: sel => needCollection(sel, c => ZB().screening.dedupCollection(c)) },
			{ id: "prisma", l10nID: "zotero-bridge-screen-tools-prisma", feature: "screening",
				command: sel => needCollection(sel, c => ZB().screening.generateReport(c)) },
			{ id: "appraisal-summary", l10nID: "zotero-bridge-appraisal-tools-summary", feature: "appraisalForm",
				command: sel => needCollection(sel, c => ZB().appraisalForm.exportSummary(c), "請先在左側選取分類。") },
		] },
		{ id: "ai", l10nID: "zotero-bridge-toolbar-group-ai", entries: [
			{ id: "regenerate", l10nID: "zotero-bridge-menu-regenerate", feature: "aiNotes", command: sync({ targets: BOTH, ai: "regenerate" }) },
			// The writing commands bring their own messages (「…至少需要 2 篇文獻。」)
			{ id: "synthesis", l10nID: "zotero-bridge-menu-synthesis", feature: "synthesis",
				command: (sel) => {
					let t = writingTarget(sel);
					return ZB().main.runSynthesis(t.items, t.scope);
				} },
			{ id: "review-draft", l10nID: "zotero-bridge-menu-review-draft", feature: "reviewDraft",
				command: (sel) => {
					let t = writingTarget(sel);
					return ZB().reviewDraft.run(t.items, t.scope, t.context);
				} },
			{ id: "ebhc-report", l10nID: "zotero-bridge-menu-ebhc-report", feature: "ebhcReport",
				command: (sel) => {
					let t = writingTarget(sel);
					return ZB().ebhcReport.run(t.items, t.scope, t.context);
				} },
			{ id: "progress-report", l10nID: "zotero-bridge-menu-progress-report", feature: "progressReport", command: () => ZB().progressReport.run() },
			{ id: "concepts-ai", l10nID: "zotero-bridge-menu-concepts-ai", feature: "conceptsAI", command: () => ZB().concepts.synthesizeFromMenu() },
			// Like the Tools entry: only while batches are pending
			{ id: "ai-batch-check", l10nID: "zotero-bridge-menu-ai-batch-check",
				when: () => ZB().aiBatch.readState().batches.length > 0,
				command: () => ZB().aiBatch.check({ manual: true }) },
		] },
	];

	const SETTINGS = { id: "settings", l10nID: "zotero-bridge-toolbar-settings",
		command: () => Zotero.Utilities.Internal.openPreferences("zotero-bridge-prefs") };

	function entryVisible(entry) {
		try {
			return (!entry.feature || featureOn(entry.feature)) && (!entry.when || !!entry.when());
		}
		catch (e) {
			log(e);
			return false;
		}
	}

	function allEntries() {
		return [...GROUPS.flatMap(g => g.entries), SETTINGS];
	}

	function findEntry(id) {
		let walk = list => list.reduce((found, e) => found || (e.id === id ? e : e.submenu ? walk(e.submenu) : null), null);
		return walk(allEntries());
	}

	function run(win, entry) {
		Promise.resolve()
			.then(() => entry.command(selection(win)))
			.catch(log);
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

	function menuitem(doc, win, entry) {
		let el = xul(doc, "menuitem");
		el.setAttribute("data-zb-entry", entry.id);
		setL10n(el, entry.l10nID);
		el.addEventListener("command", () => run(win, entry));
		return el;
	}

	/** A group's label: a XUL menucaption where Gecko defines it, else a disabled item styled the same. */
	function caption(doc, win, group) {
		let hasCaption = !!(win.customElements && win.customElements.get && win.customElements.get("menucaption"));
		let el = xul(doc, hasCaption ? "menucaption" : "menuitem");
		if (!hasCaption) el.setAttribute("disabled", "true");
		el.classList.add("zotero-bridge-tb-caption");
		el.setAttribute("data-zb-group", group.id);
		setL10n(el, group.l10nID);
		return el;
	}

	function buildEntry(doc, win, entry) {
		if (entry.separator) return xul(doc, "menuseparator");
		if (entry.reasons) {
			let menu = xul(doc, "menu");
			menu.setAttribute("data-zb-entry", entry.id);
			setL10n(menu, entry.l10nID);
			let popup = xul(doc, "menupopup");
			popup.addEventListener("popupshowing", (ev) => {
				if (ev.target === popup) fillReasons(doc, win, popup);
			});
			menu.append(popup);
			return menu;
		}
		if (entry.submenu) {
			let menu = xul(doc, "menu");
			menu.setAttribute("data-zb-entry", entry.id);
			setL10n(menu, entry.l10nID);
			let popup = xul(doc, "menupopup");
			for (let child of entry.submenu) popup.append(buildEntry(doc, win, child));
			menu.append(popup);
			return menu;
		}
		return menuitem(doc, win, entry);
	}

	/** 全文：排除 › one item per exclusion reason from the screening settings (as in the item menu). */
	function fillReasons(doc, win, popup) {
		popup.replaceChildren();
		let screening = ZB().screening;
		let reasons = screening.config().reasons.slice(0, screening.MAX_MENU_REASONS);
		for (let reason of reasons) {
			let el = xul(doc, "menuitem");
			el.setAttribute("data-zb-reason", reason);
			setL10n(el, "zotero-bridge-screen-reason", { reason });
			el.addEventListener("command", () => run(win, { command: screen({ stage: "ft", decision: "exclude", reason }) }));
			popup.append(el);
		}
	}

	function buildPopup(doc, win) {
		let popup = xul(doc, "menupopup");
		popup.id = POPUP_ID;
		for (let group of GROUPS) {
			let sep = xul(doc, "menuseparator");
			sep.setAttribute("data-zb-group-separator", group.id);
			popup.append(sep, caption(doc, win, group));
			for (let entry of group.entries) {
				let el = buildEntry(doc, win, entry);
				el.setAttribute("data-zb-group-entry", group.id);
				popup.append(el);
			}
		}
		let sep = xul(doc, "menuseparator");
		sep.setAttribute("data-zb-group-separator", "settings");
		popup.append(sep, menuitem(doc, win, SETTINGS));
		popup.addEventListener("popupshowing", (ev) => {
			if (ev.target === popup) update(popup);
		});
		return popup;
	}

	/**
	 * Show what applies right now: entries whose feature is on and whose condition holds; a group
	 * without any (label and separator) hides; the first visible group has no separator above it.
	 * Returns the visible group IDs.
	 */
	function update(popup) {
		let shown = [];
		for (let group of GROUPS) {
			let any = false;
			for (let entry of group.entries) {
				let el = popup.querySelector(`[data-zb-entry="${entry.id}"]`);
				if (!el) continue;
				let visible = entryVisible(entry);
				el.hidden = !visible;
				if (visible && entry.args) setL10n(el, entry.l10nID, entry.args());
				any = any || visible;
			}
			popup.querySelector(`[data-zb-group="${group.id}"]`).hidden = !any;
			popup.querySelector(`[data-zb-group-separator="${group.id}"]`).hidden = !any || !shown.length;
			if (any) shown.push(group.id);
		}
		popup.querySelector('[data-zb-group-separator="settings"]').hidden = !shown.length;
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
			Zotero.debug(`Zotero Bridge: no #${TOOLBAR_ID} in this window; toolbar button not added`);
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
		button.setAttribute("tooltiptext", "Zotero Bridge");
		button.setAttribute("aria-label", "Zotero Bridge");
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
		BUTTON_ID, POPUP_ID, STYLE_ID, SWITCH_PREF, GROUPS, SETTINGS,
		init, add, remove, shutdown, update, selection, writingTarget, findEntry, entryVisible,
		get windowCount() { return windows.size; },
	};
})(this);
