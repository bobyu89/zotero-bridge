/*
 * ZotMax — 快速指令, the command palette.
 *
 * A small window (content/palette.xhtml, served from chrome://zotero-bridge/ like the classify review)
 * with a search field over the command catalog (commands.js) and the settings destinations: type to
 * filter by label and keywords (Chinese or English, case- and width-insensitive, substring and simple
 * fuzzy matching), ArrowUp/ArrowDown to move, Enter to run, Esc to close. Every result shows its group;
 * one that can't run says why: switched off (「到 設定 → 功能 打開『X』」, Enter or the button opens the
 * settings at that switch) or nothing to act on (「先選取文獻」…). Switched-off commands are listed so they can be
 * found, but never run. A command runs on the main window's selection at the moment it is chosen.
 *
 * Opened from the toolbar menu's first entry, Tools → ZotMax 快速指令…, and Ctrl+Shift+P
 * (⇧⌘P on macOS) in the main window. Zotero 10 and Firefox 140 bind neither on any platform (Firefox's
 * private window is a browser shortcut, not part of Zotero); attach() checks Zotero's configurable
 * shortcuts (Ctrl/Cmd+Shift+letter) and the window's <key> elements first and leaves the key alone when
 * something there uses P.
 *
 * Always available: the palette is core navigation; the 「工具列按鈕」 switch only hides the button.
 * Lifecycle: attach(win)/detach(win) with the main windows (bootstrap.js), shutdown() closes the
 * window and removes every key listener.
 */
(function (root) {
	const DIALOG_URL = "chrome://zotero-bridge/content/palette.xhtml";
	const DIALOG_ROOT = "zb-palette";
	const DIALOG_NAME = "zotero-bridge-palette";
	let openCount = 0;
	const HTML_NS = "http://www.w3.org/1999/xhtml";
	// Zotero's configurable shortcuts (Ctrl+Shift+key, Cmd+Shift+key on macOS): extensions.zotero.keys.*
	const ZOTERO_KEYS = ["saveToZotero", "newItem", "newNote", "library", "quicksearch", "copySelectedItemCitationsToClipboard",
		"copySelectedItemsToClipboard", "sync", "toggleAllRead", "toggleRead", "showTabsMenu"];
	const SHORTCUT_KEY = "P";

	// zh-TW text of the palette's own Fluent messages (identical to locale/zh-TW; tests check)
	const STRINGS = {
		title: ["zotero-bridge-palette-title", "ZotMax 快速指令"],
		inputLabel: ["zotero-bridge-palette-input-label", "快速指令"],
		placeholder: ["zotero-bridge-palette-placeholder", "輸入功能名稱，例如：分類、PRISMA、sync"],
		listLabel: ["zotero-bridge-palette-list-label", "指令與設定"],
		keys: ["zotero-bridge-palette-keys", "上下鍵選擇 · Enter 執行 · Esc 關閉"],
		shortcut: ["zotero-bridge-palette-shortcut", "隨時開啟：{ $shortcut }"],
		count: ["zotero-bridge-palette-count", "{ $count } 個結果"],
		empty: ["zotero-bridge-palette-empty", "沒有符合「{ $query }」的指令。試試功能名稱或英文，例如 PRISMA、sync。"],
		off: ["zotero-bridge-palette-off", "到 設定 → 功能 打開『{ $feature }』"],
		openSettings: ["zotero-bridge-palette-open-settings", "打開設定"],
		items: ["zotero-bridge-palette-needs-items", "先選取文獻"],
		collection: ["zotero-bridge-palette-needs-collection", "先選取分類"],
		itemsOrCollection: ["zotero-bridge-palette-needs-either", "先選取文獻或分類"],
		groupSettings: ["zotero-bridge-palette-group-settings", "設定"],
		settingsEntry: ["zotero-bridge-palette-settings-entry", "設定：{ $name }"],
		error: ["zotero-bridge-palette-error", "快速指令視窗沒有開啟（{ $error }）。可以改用工具列的 ZotMax 按鈕或右鍵選單。"],
	};

	let current = null;
	// window → keydown listener
	let attached = new Map();
	let shortcutOn = false;

	function ZB() {
		return root.ZB;
	}

	function C() {
		return root.ZB.commands;
	}

	function log(e) {
		Zotero.logError(e);
	}

	function isMac() {
		return typeof Zotero !== "undefined" && !!Zotero.isMac;
	}

	// ---------- the shortcut ----------

	/** Ctrl+Shift+P, or ⇧⌘P on macOS. */
	function isShortcut(ev) {
		if (!ev || ev.defaultPrevented || !ev.shiftKey || ev.altKey) return false;
		let accel = isMac() ? ev.metaKey && !ev.ctrlKey : ev.ctrlKey && !ev.metaKey;
		if (!accel) return false;
		return ev.code === "KeyP" || String(ev.key || "").toUpperCase() === SHORTCUT_KEY;
	}

	/** What already uses Ctrl/Cmd+Shift+P in this window, or null. */
	function shortcutConflict(win) {
		for (let name of ZOTERO_KEYS) {
			let v = null;
			try {
				v = Zotero.Prefs.get("extensions.zotero.keys." + name, true);
			}
			catch (e) {
				v = null;
			}
			if (typeof v === "string" && v.toUpperCase() === SHORTCUT_KEY) return `Zotero shortcut keys.${name}`;
		}
		let doc = win && win.document;
		if (doc && doc.querySelectorAll) {
			for (let k of doc.querySelectorAll("key")) {
				let key = (k.getAttribute("key") || "").toUpperCase();
				let mods = (k.getAttribute("modifiers") || "").toLowerCase();
				if (key === SHORTCUT_KEY && /accel|control|meta/.test(mods) && /shift/.test(mods) && !/alt/.test(mods)) return `<key id="${k.id}">`;
			}
		}
		return null;
	}

	function shortcutLabel() {
		if (!shortcutOn) return "";
		return isMac() ? "⇧⌘P" : "Ctrl+Shift+P";
	}

	/** Listen for the shortcut in a main window (once; again after detach()). Returns true when listening. */
	function attach(win) {
		if (!win || !win.addEventListener) return false;
		detach(win);
		let conflict = shortcutConflict(win);
		if (conflict) {
			Zotero.debug(`ZotMax: Ctrl/Cmd+Shift+P is taken (${conflict}); 快速指令 has no shortcut in this window`);
			return false;
		}
		let onKeyDown = (ev) => {
			if (!isShortcut(ev)) return;
			ev.preventDefault();
			ev.stopPropagation();
			open(win).catch(log);
		};
		win.addEventListener("keydown", onKeyDown);
		attached.set(win, onKeyDown);
		shortcutOn = true;
		return true;
	}

	function detach(win) {
		let fn = attached.get(win);
		if (!fn) return;
		try {
			win.removeEventListener("keydown", fn);
		}
		catch (e) {}
		attached.delete(win);
		if (!attached.size) shortcutOn = false;
	}

	// ---------- texts ----------

	function argsKey(id, args) {
		return args ? `${id} ${JSON.stringify(args)}` : id;
	}

	/** Fluent arguments that mark where each { $name } of a message goes. */
	function markers(text) {
		let args = {};
		for (let m of String(text).matchAll(/\{ \$(\w+) \}/g)) args[m[1]] = `§${m[1]}§`;
		return Object.keys(args).length ? args : undefined;
	}

	function fill(text, args) {
		return String(text).replace(/\{ \$(\w+) \}/g, (m, k) => (args && args[k] !== undefined ? String(args[k]) : m));
	}

	/**
	 * Localized texts for the palette, from the main window's Fluent (it carries zotero-bridge.ftl);
	 * the zh-TW catalog text where Fluent isn't there. Returns { label(entry), group(entry), feature(id),
	 * string(name, args) }.
	 */
	async function localize(doc, entries) {
		let F = ZB().features;
		let wanted = new Map();
		let want = (id, args, attr) => wanted.set(argsKey(id, args), { id, args: args || undefined, attr });
		for (let e of entries) {
			want(e.l10n, e.args, e.kind === "settings" ? null : "label");
			if (e.parentL10n) want(e.parentL10n, null, "label");
			if (e.availability && e.availability.feature) want(F.get(e.availability.feature).l10n.name, null, null);
		}
		for (let g of C().GROUPS) want(g.l10n, null, "label");
		let found = new Map();
		let l10n = doc && doc.l10n;
		if (l10n && l10n.formatMessages) {
			let keys = [...wanted.keys()];
			try {
				let msgs = await l10n.formatMessages(keys.map(k => ({ id: wanted.get(k).id, args: wanted.get(k).args })));
				keys.forEach((k, i) => {
					let m = msgs[i];
					if (!m) return;
					let w = wanted.get(k);
					let text = w.attr ? ((m.attributes || []).find(a => a.name === w.attr) || {}).value : m.value;
					if (text && String(text).trim()) found.set(k, String(text));
				});
			}
			catch (e) {
				log(e);
			}
			// The palette's own messages, formatted with markers where their arguments go
			let names = Object.keys(STRINGS);
			try {
				let values = await l10n.formatValues(names.map(n => ({ id: STRINGS[n][0], args: markers(STRINGS[n][1]) })));
				names.forEach((n, i) => {
					if (values[i]) found.set(`string:${n}`, values[i]);
				});
			}
			catch (e) {
				log(e);
			}
		}
		let get = (id, args, fallback) => found.get(argsKey(id, args)) || fallback;
		let string = (name, args) => {
			let raw = found.get(`string:${name}`);
			if (raw) return raw.replace(/\u2068?§(\w+)§\u2069?/g, (m, k) => (args && args[k] !== undefined ? String(args[k]) : ""));
			return fill(STRINGS[name][1], args);
		};
		let label = (e) => {
			if (e.kind === "settings") return string("settingsEntry", { name: get(e.l10n, null, e.name) });
			let own = get(e.l10n, e.args, C().fillLabel(e.label, e.args));
			return e.parentL10n ? `${get(e.parentL10n, null, e.parentLabel)} › ${own}` : own;
		};
		let group = (e) => {
			if (e.kind === "settings") return string("groupSettings");
			let g = C().GROUPS.find(x => x.id === e.group);
			return g ? get(g.l10n, null, g.label) : "";
		};
		let feature = id => get(F.get(id).l10n.name, null, F.get(id).label);
		return { label, group, feature, string };
	}

	// ---------- rendering ----------

	/**
	 * Draw the palette into `rootEl` and wire the keyboard. opts: entries (commands.paletteEntries),
	 * texts (localize()), shortcut (label or ""), onRun(entry), onSettings(entry), onClose(). Returns
	 * { input, list, query(text), results(), active(), move(delta), choose() } for tests.
	 */
	function render(doc, rootEl, opts) {
		let { entries, texts, onRun, onSettings, onClose } = opts;
		let h = (tag, attrs = {}, ...children) => {
			let el = doc.createElementNS(HTML_NS, tag);
			for (let [k, v] of Object.entries(attrs)) {
				if (v !== null && v !== undefined) el.setAttribute(k, v);
			}
			for (let c of children) el.append(c);
			return el;
		};
		rootEl.replaceChildren();
		// The window's title (a XUL window takes it from its root's title attribute)
		try {
			doc.title = texts.string("title");
			if (doc.documentElement) doc.documentElement.setAttribute("title", texts.string("title"));
		}
		catch (e) {}
		let input = h("input", {
			id: "zb-pal-input", class: "zb-pal-input", type: "search", role: "combobox", autocomplete: "off", spellcheck: "false",
			"aria-autocomplete": "list", "aria-expanded": "true", "aria-controls": "zb-pal-list", "aria-describedby": "zb-pal-status",
			placeholder: texts.string("placeholder"),
		});
		let head = h("div", { class: "zb-pal-head" },
			h("label", { class: "zb-pal-title", for: "zb-pal-input" }, texts.string("inputLabel")),
			input);
		let list = h("ul", { id: "zb-pal-list", class: "zb-pal-list", role: "listbox", "aria-label": texts.string("listLabel") });
		let status = h("p", { id: "zb-pal-status", class: "zb-pal-status", role: "status", "aria-live": "polite" });
		let foot = h("p", { class: "zb-pal-foot" }, texts.string("keys"));
		if (opts.shortcut) foot.append(h("span", { class: "zb-pal-accel" }, texts.string("shortcut", { shortcut: opts.shortcut })));
		rootEl.append(head, h("div", { class: "zb-pal-body" }, list), h("div", { class: "zb-pal-bottom" }, status, foot));

		let results = entries.slice();
		let active = 0;
		let options = [];

		let reasonText = (e) => {
			let a = e.availability || { ok: true };
			if (a.ok) return "";
			if (a.reason === "off") return texts.string("off", { feature: texts.feature(a.feature) });
			return texts.string(a.reason);
		};

		let option = (e, index, withGroup) => {
			let id = `zb-pal-opt-${index}`;
			let why = reasonText(e);
			let li = h("li", {
				id, role: "option", class: "zb-pal-option", "aria-selected": "false",
				"aria-disabled": e.availability && !e.availability.ok ? "true" : null,
				"data-zb-entry": e.id,
				"data-zb-reason": e.availability && !e.availability.ok ? e.availability.reason : null,
			});
			let name = h("span", { class: "zb-pal-name" }, texts.label(e));
			let line = h("span", { class: "zb-pal-line" }, name);
			if (withGroup) line.append(h("span", { class: "zb-pal-group-tag" }, texts.group(e)));
			li.append(line);
			if (why) {
				let note = h("span", { class: "zb-pal-why", id: `${id}-why` }, why);
				li.setAttribute("aria-describedby", `${id}-why`);
				if (e.availability.reason === "off") {
					// Enter on the row does the same; the button is for the mouse
					let button = h("button", { class: "zb-pal-open-settings", type: "button", tabindex: "-1", "aria-hidden": "true" }, texts.string("openSettings"));
					button.addEventListener("click", (ev) => {
						ev.stopPropagation();
						onSettings(e);
					});
					note.append(" ", button);
				}
				li.append(note);
			}
			li.addEventListener("mousemove", () => {
				if (active !== index) setActive(index, false);
			});
			li.addEventListener("click", () => {
				setActive(index, false);
				choose();
			});
			return li;
		};

		function draw() {
			list.replaceChildren();
			options = [];
			let q = input.value.trim();
			if (!q) {
				// Grouped in workflow order, settings last
				let groups = [];
				for (let e of results) {
					let last = groups[groups.length - 1];
					if (!last || last.id !== e.group) groups.push({ id: e.group, entries: [e] });
					else last.entries.push(e);
				}
				for (let g of groups) {
					let titleID = `zb-pal-group-${g.id}`;
					let ul = h("ul", { role: "group", class: "zb-pal-group-list", "aria-labelledby": titleID });
					for (let e of g.entries) {
						let li = option(e, options.length, false);
						options.push(li);
						ul.append(li);
					}
					list.append(h("li", { role: "presentation", class: "zb-pal-group" },
						h("span", { id: titleID, class: "zb-pal-group-title" }, texts.group(g.entries[0])), ul));
				}
				status.textContent = "";
			}
			else {
				results.forEach((e) => {
					let li = option(e, options.length, true);
					options.push(li);
					list.append(li);
				});
				status.textContent = results.length ? texts.string("count", { count: results.length }) : texts.string("empty", { query: q });
			}
			setActive(results.length ? 0 : -1, true);
		}

		function setActive(index, scroll) {
			if (options[active]) options[active].setAttribute("aria-selected", "false");
			active = index;
			let el = options[active];
			if (!el) {
				input.removeAttribute("aria-activedescendant");
				return;
			}
			el.setAttribute("aria-selected", "true");
			input.setAttribute("aria-activedescendant", el.id);
			if (scroll && el.scrollIntoView) {
				try {
					el.scrollIntoView({ block: "nearest" });
				}
				catch (e) {}
			}
		}

		function move(delta) {
			if (!results.length) return;
			let n = results.length;
			setActive(((active + delta) % n + n) % n, true);
		}

		/**
		 * Enter: run it; switched off: open the settings at 功能; nothing to act on: say so. Checked
		 * again against the selection as it is now (opts.recheck), which may have changed since opening.
		 */
		function choose() {
			let e = results[active];
			if (!e) return null;
			let a = (opts.recheck ? opts.recheck(e) : e.availability) || { ok: true };
			if (a.ok) {
				onRun(e);
				return "run";
			}
			if (a.reason === "off") {
				onSettings(e);
				return "settings";
			}
			status.textContent = `${texts.label(e)}：${reasonText(Object.assign({}, e, { availability: a }))}`;
			return a.reason;
		}

		function query(text) {
			input.value = text;
			let q = text.trim();
			results = q ? C().search(entries, q, e => ({ label: texts.label(e), keywords: [e.label, e.parentLabel, ...e.keywords].filter(Boolean), group: texts.group(e) })) : entries.slice();
			draw();
		}

		input.addEventListener("input", () => query(input.value));
		doc.addEventListener("keydown", (ev) => {
			let k = ev.key;
			if (k === "Escape") onClose();
			else if (k === "ArrowDown") move(1);
			else if (k === "ArrowUp") move(-1);
			else if (k === "PageDown") move(Math.min(5, results.length - 1 - active) || 0);
			else if (k === "PageUp") move(-Math.min(5, active) || 0);
			else if (k === "Enter" && !(ev.target && ev.target.localName === "button")) choose();
			else return;
			ev.preventDefault();
			ev.stopPropagation();
		});
		draw();
		try {
			input.focus();
		}
		catch (e) {}
		return { input, list, status, query, move, choose, results: () => results, active: () => results[active] || null };
	}

	// ---------- the window ----------

	/** Wait for the dialog document (not the initial about:blank) to be ready. */
	function waitForDialog(win, timeoutMs = 15000) {
		return new Promise((resolve, reject) => {
			let start = Date.now();
			let check = () => {
				try {
					let doc = win.document;
					let rootEl = doc && doc.getElementById(DIALOG_ROOT);
					if (rootEl && doc.readyState === "complete") {
						resolve(rootEl);
						return;
					}
				}
				catch (e) {}
				if (win.closed || Date.now() - start > timeoutMs) {
					reject(new Error("快速指令視窗沒有開啟"));
					return;
				}
				setTimeout(check, 50);
			};
			check();
		});
	}

	function close() {
		let win = current;
		current = null;
		try {
			if (win && !win.closed) win.close();
		}
		catch (e) {}
	}

	function focusInput(win) {
		try {
			win.focus();
			let input = win.document.getElementById("zb-pal-input");
			if (input) {
				input.focus();
				if (input.select) input.select();
			}
		}
		catch (e) {}
	}

	/**
	 * Open 快速指令 for a main window (default: the most recent one); an open palette comes to the
	 * front instead. opts.onOpen(dialogWindow, view) is called once it shows the results (tests).
	 * Resolves with the dialog window, or null when it could not open.
	 */
	async function open(win, opts = {}) {
		win = win || Zotero.getMainWindow();
		if (current && !current.closed) {
			focusInput(current);
			return current;
		}
		let entries = C().paletteEntries(C().fromWindow(win, "palette"));
		let texts = await localize(win && win.document, entries);
		let dialog;
		try {
			// A fresh window name each time: reopening right after Esc must not get the closing window
			// back from Gecko (it would close under us: "快速指令視窗沒有開啟")
			dialog = win.openDialog(DIALOG_URL, `${DIALOG_NAME}-${++openCount}`, "chrome,dialog=no,resizable,centerscreen");
			current = dialog;
			let rootEl = await waitForDialog(dialog);
			if (current !== dialog) return null;
			let view = render(dialog.document, rootEl, {
				entries, texts, shortcut: shortcutLabel(),
				recheck: e => (e.kind === "settings" ? e.availability : C().availability(e.command, C().fromWindow(win, "palette"))),
				onClose: close,
				// Switched off: a command opens 功能; a section opens itself and the pane shows its switch
				onSettings: (entry) => {
					close();
					C().openSettings(entry && entry.kind === "settings" ? entry.section : "features");
				},
				onRun: (entry) => {
					close();
					runEntry(win, entry);
				},
			});
			if (opts.onOpen) opts.onOpen(dialog, view);
			return dialog;
		}
		catch (e) {
			log(e);
			if (current === dialog) current = null;
			ZB().main.notify("ZotMax", texts.string("error", { error: e.message || e }));
			return null;
		}
	}

	/** Run a palette result on the main window's selection as it is now; never one that can't run. */
	function runEntry(win, entry) {
		if (entry.kind === "settings") {
			try {
				return Promise.resolve(entry.run());
			}
			catch (e) {
				log(e);
				return Promise.resolve(null);
			}
		}
		let sel = C().fromWindow(win, "palette");
		if (!entry.run || !C().availability(entry.command, sel).ok) return Promise.resolve(null);
		return C().execute({ id: entry.id, run: entry.run }, sel);
	}

	function shutdown() {
		close();
		for (let win of [...attached.keys()]) detach(win);
	}

	(root.ZB = root.ZB || {}).palette = {
		DIALOG_URL, DIALOG_ROOT, STRINGS, ZOTERO_KEYS,
		open, close, render, localize, runEntry, attach, detach, shutdown, isShortcut, shortcutConflict, shortcutLabel,
		get isOpen() { return !!(current && !current.closed); },
		get windowCount() { return attached.size; },
	};
})(this);
