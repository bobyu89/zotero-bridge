/*
 * ZotMax — the right-click and Tools menus, generated from the command catalog (commands.js).
 *
 *   item menu        one 「ZotMax ▸」 submenu: the commands for the selected items, in the
 *                    catalog's workflow groups (a caption per group, separators between groups)
 *   collection menu  one 「ZotMax ▸」 submenu: the commands for the selected collection
 *   Tools menu       ZotMax 設定…, ZotMax 快速指令…, and the batch entries (stop, resume,
 *                    discard a sync batch; check or cancel AI batches) only while they apply
 *
 * Commands with variants (篩選 decisions, databases) are a submenu inside their group, so nothing is
 * more than two levels below the right-click entry. Everything is decided live in onShowing: entries
 * of switched-off features hide, a group with nothing left hides with its caption and separator, and
 * a submenu with nothing in it hides. Registration never changes, so turning a switch on or off needs
 * no restart; register() returns the menu IDs main.js unregisters at shutdown. Every onCommand returns the
 * command's promise (MenuManager ignores it; tests wait for it).
 */
(function (root) {
	const ITEM_MENU = "zotero-bridge-item";
	const COLLECTION_MENU = "zotero-bridge-collection";
	const TOOLS_MENU = "zotero-bridge-tools";
	const TARGETS = { item: "main/library/item", collection: "main/library/collection" };
	const CAPTION_CLASS = "zotero-bridge-caption";

	function C() {
		return root.ZB.commands;
	}

	function log(e) {
		Zotero.logError(e);
	}

	/** Groups shown in a menu right now (their IDs, in order). */
	function visibleGroups(surface, sel) {
		return C().GROUPS.filter(g => C().groupCommands(g.id, surface).some(c => C().isVisibleIn(c, sel))).map(g => g.id);
	}

	function menuVisible(surface, context) {
		let sel = C().fromContext(surface, context);
		// The collection menu needs a collection (not My Library, a saved search, the trash…)
		if (surface === "collection" && !sel.collections.length) return false;
		return visibleGroups(surface, sel).length > 0;
	}

	function args(entry) {
		try {
			return entry.args ? entry.args() : null;
		}
		catch (e) {
			log(e);
			return null;
		}
	}

	/** onShowing for an entry: visibility, Fluent arguments. */
	function showing(surface, decide) {
		return (ev, context) => {
			let sel = C().fromContext(surface, context);
			let result = false;
			try {
				result = decide(sel, context);
			}
			catch (e) {
				log(e);
			}
			context.setVisible(!!result);
		};
	}

	function commandEntry(surface, cmd) {
		return {
			menuType: "menuitem",
			l10nID: cmd.l10n,
			onShowing: showing(surface, (sel, context) => {
				let visible = C().isVisibleIn(cmd, sel);
				let a = visible && args(cmd);
				if (a) context.setL10nArgs(JSON.stringify(a));
				return visible;
			}),
			onCommand: (ev, context) => C().execute(cmd, C().fromContext(surface, context)),
		};
	}

	/** A command with variants: a submenu; list variants get `max` slots filled when it opens. */
	function variantSubmenu(surface, cmd) {
		let menus = [];
		for (let v of cmd.variants) {
			if (v.separator) {
				menus.push({ menuType: "separator" });
				continue;
			}
			if (!v.list) {
				menus.push({
					menuType: "menuitem",
					l10nID: v.l10n,
					onCommand: (ev, context) => C().execute(v, C().fromContext(surface, context)),
				});
				continue;
			}
			let leafAt = (i, context) => {
				try {
					return v.list(C().fromContext(surface, context)).slice(0, v.max)[i] || null;
				}
				catch (e) {
					log(e);
					return null;
				}
			};
			for (let i = 0; i < v.max; i++) {
				menus.push({
					menuType: "menuitem",
					l10nID: v.l10n,
					onShowing: (ev, context) => {
						let leaf = leafAt(i, context);
						context.setVisible(!!leaf);
						if (leaf && leaf.args) context.setL10nArgs(JSON.stringify(leaf.args));
					},
					onCommand: (ev, context) => {
						let leaf = leafAt(i, context);
						return leaf ? C().execute(leaf, C().fromContext(surface, context)) : null;
					},
				});
			}
		}
		return {
			menuType: "submenu",
			l10nID: cmd.l10n,
			onShowing: showing(surface, sel => C().isVisibleIn(cmd, sel)),
			menus,
		};
	}

	/** The entries of a 「ZotMax ▸」 submenu: per group a separator, a caption, the commands. */
	function buildEntries(surface) {
		let menus = [];
		for (let g of C().GROUPS) {
			let commands = C().groupCommands(g.id, surface);
			if (!commands.length) continue;
			// Between groups; none above the first group that shows
			menus.push({
				menuType: "separator",
				onShowing: showing(surface, (sel) => {
					let shown = visibleGroups(surface, sel);
					return shown.includes(g.id) && shown[0] !== g.id;
				}),
			});
			// The group's name: never a command (disabled), styled as a caption by toolbar.css
			menus.push({
				menuType: "menuitem",
				l10nID: g.l10n,
				onShowing: (ev, context) => {
					let sel = C().fromContext(surface, context);
					context.setVisible(visibleGroups(surface, sel).includes(g.id));
					context.setEnabled(false);
					let el = context.menuElem;
					if (el && el.classList) el.classList.add(CAPTION_CLASS);
				},
			});
			for (let cmd of commands) menus.push(cmd.variants ? variantSubmenu(surface, cmd) : commandEntry(surface, cmd));
		}
		return menus;
	}

	function submenu(surface, icon) {
		return {
			menuType: "submenu",
			l10nID: "zotero-bridge-menu",
			icon,
			onShowing: (ev, context) => {
				let visible = false;
				try {
					visible = menuVisible(surface, context);
				}
				catch (e) {
					log(e);
				}
				context.setVisible(visible);
			},
			menus: buildEntries(surface),
		};
	}

	/** The shortcut shown next to 快速指令… (palette.js), when it is registered. */
	function setAccel(context) {
		let el = context.menuElem;
		let label = root.ZB.palette && root.ZB.palette.shortcutLabel();
		if (!el || !el.setAttribute) return;
		if (label) el.setAttribute("acceltext", label);
		else if (el.removeAttribute) el.removeAttribute("acceltext");
	}

	function toolsEntries() {
		let { SETTINGS, PALETTE } = C();
		let menus = [
			{
				menuType: "menuitem",
				l10nID: SETTINGS.toolsL10n,
				onCommand: () => C().execute(SETTINGS, C().fromWindow(null, "tools")),
			},
			{
				menuType: "menuitem",
				l10nID: PALETTE.toolsL10n,
				onShowing: (ev, context) => {
					context.setVisible(true);
					setAccel(context);
				},
				onCommand: () => C().execute(PALETTE, C().fromWindow(Zotero.getMainWindow(), "tools")),
			},
		];
		for (let cmd of C().COMMANDS.filter(c => c.tools)) {
			menus.push({
				menuType: "menuitem",
				l10nID: cmd.l10n,
				onShowing: (ev, context) => {
					let visible = C().isVisible(cmd);
					context.setVisible(visible);
					let a = visible && args(cmd);
					if (a) context.setL10nArgs(JSON.stringify(a));
				},
				onCommand: () => C().execute(cmd, C().fromWindow(null, "tools")),
			});
		}
		return menus;
	}

	/** Register the three menus; returns the IDs to unregister. */
	function register({ pluginID, icon }) {
		let ids = [
			Zotero.MenuManager.registerMenu({ menuID: ITEM_MENU, pluginID, target: TARGETS.item, menus: [submenu("item", icon)] }),
			Zotero.MenuManager.registerMenu({ menuID: COLLECTION_MENU, pluginID, target: TARGETS.collection, menus: [submenu("collection", icon)] }),
			Zotero.MenuManager.registerMenu({ menuID: TOOLS_MENU, pluginID, target: "main/menubar/tools", menus: toolsEntries() }),
		];
		return ids.filter(Boolean);
	}

	(root.ZB = root.ZB || {}).menus = {
		ITEM_MENU, COLLECTION_MENU, TOOLS_MENU, CAPTION_CLASS,
		register, buildEntries, toolsEntries, visibleGroups, menuVisible,
	};
})(this);
