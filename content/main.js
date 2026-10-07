/*
 * Zotero Bridge — orchestration: settings, sync pipeline, menus, auto-sync.
 */
(function (root) {
	const ZB = root.ZB;
	const PREF = "extensions.zotero-bridge.";
	const AI_TITLE = "🤖 AI 文獻筆記";
	const AUTO_SYNC_DELAY_MS = 8000;

	let pluginID = null;
	let rootURI = null;
	let menuIDs = [];
	let notifierID = null;
	let autoSyncTimer = null;
	let autoSyncQueue = new Set();
	// Item IDs we just wrote ourselves (AI notes), so auto-sync doesn't react to them
	let selfModified = new Set();
	let running = Promise.resolve();

	function pref(key) {
		return Zotero.Prefs.get(PREF + key, true);
	}

	function readSettings() {
		let vaultPath = String(pref("obsidian.vaultPath") || "").trim();
		let provider = pref("llm.provider") === "openai" ? "openai" : "anthropic";
		return {
			vaultPath,
			vaultName: String(pref("obsidian.vaultName") || "").trim() || (vaultPath ? PathUtils.filename(vaultPath) : ""),
			filenameFormat: pref("obsidian.filenameFormat") || "citekey",
			createBase: pref("obsidian.createBase") !== false,
			includeNotes: pref("includeNotes") !== false,
			notionToken: String(pref("notion.token") || "").trim(),
			defaults: {
				obsidianFolder: pref("obsidian.folder") || "",
				notionDatabase: String(pref("notion.database") || "").trim(),
			},
			rules: ZB.core.parseRules(pref("routing.rules")),
			llm: {
				enabled: pref("llm.enabled") !== false,
				provider,
				apiKey: String(pref(provider === "openai" ? "llm.openaiKey" : "llm.anthropicKey") || "").trim(),
				model: String(pref(provider === "openai" ? "llm.openaiModel" : "llm.anthropicModel") || "").trim()
					|| ZB.llm.DEFAULT_MODELS[provider],
				effort: pref("llm.effort") || "medium",
				baseURL: String(pref("llm.openaiBaseURL") || "").trim(),
				systemPrompt: pref("llm.systemPrompt") || "",
				fullTextLimit: Number(pref("llm.fullTextLimit")) || 0,
			},
		};
	}

	function parseHTML(html) {
		return new DOMParser().parseFromString(html, "text/html");
	}

	function nowISO() {
		return new Date().toISOString();
	}

	// ---------- AI note ----------

	function aiNoteHTML(md, model, at) {
		return `<h1>${AI_TITLE}</h1>\n<p><em>由 ${model} 於 ${at} 產生（Zotero Bridge）</em></p>\n${ZB.markdown.mdToHtml(md)}`;
	}

	// Read back an AI note written by aiNoteHTML (the user may have edited it in Zotero)
	function readAINote(html) {
		let md = ZB.markdown.htmlToMd(html, parseHTML);
		let model = "";
		let at = "";
		md = md.replace(/^#\s*🤖.*\n+/, "");
		md = md.replace(/^\*由 (.+?) 於 (.+?) 產生.*\*\s*\n+/, (all, m, t) => {
			model = m;
			at = t;
			return "";
		});
		return { md: md.trim(), model, at };
	}

	// ---------- per-item pipeline ----------

	async function syncItem(item, action, settings, ctx) {
		let needAI = false;
		if (settings.llm.enabled && action.ai !== "none") {
			let existing = ZB.adapter.getAINote(item);
			needAI = action.ai === "regenerate" || (action.ai === "missing" && !existing);
		}
		let data = await ZB.adapter.extractItemData(item, {
			fullTextLimit: needAI ? settings.llm.fullTextLimit : 0,
		});
		let notesMarkdown = settings.includeNotes
			? data.notes.map(n => ({ title: n.title, md: ZB.markdown.htmlToMd(n.html, parseHTML) }))
			: [];

		// A failing step doesn't stop the others; errors are reported together at the end
		let errors = [];
		let ai = null;
		if (needAI) {
			ctx.status("AI 產生筆記中…");
			try {
				let result = await ZB.llm.generateNote(settings.llm, data, {
					systemPrompt: settings.llm.systemPrompt,
					notesMarkdown,
					fullTextTruncated: data.fullTextTruncated,
				}, (url, init) => fetch(url, init));
				let at = nowISO();
				ai = { md: result.text.trim(), model: result.model || settings.llm.model, at };
				let note = await ZB.adapter.saveAINote(item, aiNoteHTML(ai.md, ai.model, at));
				selfModified.add(note.id);
				setTimeout(() => selfModified.delete(note.id), AUTO_SYNC_DELAY_MS * 2);
			}
			catch (e) {
				errors.push(`AI 筆記：${e.message || e}`);
			}
		}
		if (!ai && data.aiNote && action.ai !== "none") {
			ai = readAINote(data.aiNote.html);
		}

		let route = ZB.core.resolveRoute(data, settings.rules, settings.defaults);
		let folderParts = ZB.core.splitFolder(route.obsidianFolder);
		let basename = ZB.core.noteBasename(data, settings.filenameFormat);
		let obsidian = null;
		if (settings.vaultPath) {
			obsidian = await resolveObsidianPath(settings, folderParts, basename, data);
		}

		let notionUrl = null;
		if (action.targets.has("notion")) {
			ctx.status("同步到 Notion…");
			try {
				if (!route.notionDatabase) throw new Error(`沒有對應的資料庫（規則：${route.ruleName || "預設"}）`);
				notionUrl = await syncNotion(ctx.notion(settings.notionToken), route.notionDatabase, data, {
					ai, notesMarkdown, obsidianURI: obsidian && obsidian.uri,
				}, ctx);
			}
			catch (e) {
				errors.push(`Notion：${e.message || e}`);
			}
		}

		if (action.targets.has("obsidian")) {
			ctx.status("寫入 Obsidian…");
			try {
				await writeObsidian(obsidian, data, { ai, notesMarkdown, notionUrl });
			}
			catch (e) {
				errors.push(`Obsidian：${e.message || e}`);
			}
		}
		if (errors.length) throw new Error(errors.join("；"));
		return { route, notionUrl, obsidianPath: obsidian && obsidian.relPath, generated: !!ai && needAI };
	}

	async function resolveObsidianPath(settings, folderParts, basename, data) {
		let zoteroKey = `${data.libraryPath}/${data.key}`;
		let dir = PathUtils.join(settings.vaultPath, ...folderParts);
		let name = basename;
		let path = PathUtils.join(dir, name + ".md");
		// Two items with the same citekey/title must not overwrite each other
		if (await IOUtils.exists(path)) {
			let text = await IOUtils.readUTF8(path);
			let fm = ZB.core.splitFrontmatter(text).frontmatter || "";
			let m = /^zotero_key:\s*"?([^"\n]+)"?\s*$/m.exec(fm);
			if (m && m[1] !== zoteroKey) {
				name = `${basename} (${data.key})`;
				path = PathUtils.join(dir, name + ".md");
			}
		}
		let relPath = [...folderParts, name + ".md"].join("/");
		return {
			dir, path, relPath,
			uri: settings.vaultName ? ZB.core.obsidianURI(settings.vaultName, relPath) : "",
		};
	}

	async function writeObsidian(obsidian, data, opts) {
		await IOUtils.makeDirectory(obsidian.dir, { createAncestors: true, ignoreExisting: true });
		let existing = (await IOUtils.exists(obsidian.path)) ? await IOUtils.readUTF8(obsidian.path) : null;
		let notionUrl = opts.notionUrl;
		if (!notionUrl && existing) {
			// Keep the Notion link from an earlier sync when this run doesn't touch Notion
			let fm = ZB.core.splitFrontmatter(existing).frontmatter || "";
			let m = /^notion:\s*"?([^"\n]+)"?\s*$/m.exec(fm);
			if (m) notionUrl = m[1];
		}
		let text = ZB.core.buildObsidianNote(existing, data, {
			aiMarkdown: opts.ai && opts.ai.md,
			aiModel: opts.ai && opts.ai.model,
			aiGeneratedAt: opts.ai && opts.ai.at,
			fullTextTruncated: data.fullTextTruncated,
			notesMarkdown: opts.notesMarkdown,
			notionUrl,
			now: nowISO(),
		});
		if (text !== existing) {
			await IOUtils.writeUTF8(obsidian.path, text);
		}
	}

	// Create the Obsidian Bases overview (table + reading-status kanban) once; never overwrite it
	async function ensureBaseFile(settings) {
		if (!settings.vaultPath || !settings.createBase) return;
		let dir = PathUtils.join(settings.vaultPath, ...ZB.core.splitFolder(settings.defaults.obsidianFolder));
		let path = PathUtils.join(dir, "Zotero 文獻庫.base");
		if (await IOUtils.exists(path)) return;
		await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
		await IOUtils.writeUTF8(path, ZB.core.buildBaseFile());
	}

	async function syncNotion(client, databaseInput, data, opts, ctx) {
		let dsId = await client.resolveDataSourceId(databaseInput);
		let schema = ctx.schemaCache.get(dsId);
		if (!schema) {
			schema = await client.getSchema(dsId);
			if (!schema.props["Zotero Key"]) {
				// First sync into this database: add the plugin's columns
				await client.ensureSchema(dsId);
				schema = await client.getSchema(dsId);
			}
			ctx.schemaCache.set(dsId, schema);
		}
		let zoteroKey = `${data.libraryPath}/${data.key}`;
		let properties = ZB.notion.buildProperties(schema, {
			title: data.title,
			authors: ZB.core.authorNames(data).join("; "),
			year: data.year,
			publication: data.publication,
			itemType: data.itemType,
			doi: data.doi,
			zotero: ZB.core.zoteroSelectURI(data),
			obsidian: opts.obsidianURI,
			tags: data.tags,
			collections: data.collections,
			library: data.libraryName,
			citationKey: data.citationKey,
			zoteroKey,
			summary: opts.ai ? ZB.markdown.plainText(ZB.llm.extractSummary(opts.ai.md)) : "",
			apa: data.apa,
			lastSynced: nowISO(),
		});
		let page = await client.findPageByZoteroKey(dsId, zoteroKey);
		if (page) {
			page = await client.request("PATCH", `pages/${page.id}`, { properties });
		}
		else {
			page = await client.request("POST", "pages", {
				parent: { type: "data_source_id", data_source_id: dsId },
				properties,
			});
		}
		let md = ZB.core.buildManagedSection(data, {
			aiMarkdown: opts.ai && opts.ai.md,
			notesMarkdown: opts.notesMarkdown,
		});
		let blocks = ZB.markdown.mdToNotionBlocks(md);
		await client.replaceManagedContainer(page.id, "自動同步區（重新同步會覆寫，個人筆記請寫在此區塊外）", blocks);
		return page.url;
	}

	// ---------- batch runner ----------

	/**
	 * @param {Zotero.Item[]} items
	 * @param {object} action { targets: ["notion","obsidian"], ai: "missing"|"regenerate"|"reuse"|"none", silent }
	 */
	function run(items, action) {
		// Serialize runs so manual and automatic syncs never interleave
		let p = running.then(() => runNow(items, action));
		running = p.catch(() => {});
		return p;
	}

	async function runNow(items, action) {
		items = ZB.adapter.toRegularItems(items);
		if (!items.length) return;
		let settings;
		try {
			settings = readSettings();
		}
		catch (e) {
			notify("Zotero Bridge 設定有誤", String(e.message || e));
			return;
		}
		action = Object.assign({}, action, { targets: new Set(action.targets) });
		// Skip a destination that isn't configured; complain only if nothing is left
		let missing = [];
		if (action.targets.has("notion") && !settings.notionToken) {
			action.targets.delete("notion");
			missing.push("Notion integration token");
		}
		if (action.targets.has("obsidian") && !settings.vaultPath) {
			action.targets.delete("obsidian");
			missing.push("Obsidian vault 路徑");
		}
		if (!action.targets.size) {
			if (!action.silent) notify("Zotero Bridge", `請先到 設定 → Zotero Bridge 填入：${missing.join("、")}`);
			return;
		}

		let willGenerate = settings.llm.enabled && (action.ai === "regenerate"
			|| (action.ai === "missing" && items.some(i => !ZB.adapter.getAINote(i))));
		if (willGenerate && !settings.llm.apiKey) {
			notify("Zotero Bridge", "AI 筆記需要 API key：請到 設定 → Zotero Bridge 填入，或改用「不呼叫 AI」同步。");
			return;
		}
		if (willGenerate && items.length > 5 && !action.silent) {
			let ok = Services.prompt.confirm(Zotero.getMainWindow(), "Zotero Bridge",
				`即將為最多 ${items.length} 筆文獻呼叫 ${settings.llm.provider === "openai" ? "OpenAI" : "Claude"}（${settings.llm.model}）產生 AI 筆記，會產生 API 費用。要繼續嗎？`);
			if (!ok) return;
		}

		let pw = action.silent ? null : new Zotero.ProgressWindow({ closeOnClick: true });
		if (pw) {
			pw.changeHeadline("Zotero Bridge");
			pw.show();
		}
		let clients = new Map();
		let ctx = {
			schemaCache: new Map(),
			notion(token) {
				if (!clients.has(token)) clients.set(token, new ZB.notion.NotionClient({ token, fetch: (u, i) => fetch(u, i) }));
				return clients.get(token);
			},
			status: () => {},
		};
		let ok = 0;
		let failures = [];
		for (let item of items) {
			let title = item.getField("title") || item.key;
			let line = pw ? new pw.ItemProgress(item.getItemTypeIconName(), title) : null;
			ctx.status = (s) => {
				if (line) line.setText(`${title} — ${s}`);
			};
			try {
				await syncItem(item, action, settings, ctx);
				ok++;
				if (line) {
					line.setText(title);
					line.setProgress(100);
				}
			}
			catch (e) {
				Zotero.logError(e);
				failures.push(`${title}：${e.message || e}`);
				if (line) {
					line.setText(`${title} — ${e.message || e}`);
					line.setError();
				}
			}
		}
		if (action.targets.has("obsidian") && ok) {
			try {
				await ensureBaseFile(settings);
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
		if (pw) {
			pw.addDescription(`完成 ${ok} 筆${failures.length ? `，失敗 ${failures.length} 筆（詳見 說明 → 除錯輸出記錄）` : ""}`);
			pw.startCloseTimer(failures.length ? 15000 : 5000);
		}
		else if (failures.length) {
			notify("Zotero Bridge 自動同步失敗", failures.slice(0, 3).join("\n"));
		}
	}

	function notify(headline, text) {
		let pw = new Zotero.ProgressWindow({ closeOnClick: true });
		pw.changeHeadline(headline);
		pw.addDescription(text);
		pw.show();
		pw.startCloseTimer(10000);
	}

	// ---------- settings-pane helpers ----------

	/** Check the token and every configured database; add missing columns. Returns report lines. */
	async function testNotion() {
		let settings = readSettings();
		if (!settings.notionToken) throw new Error("請先填入 Notion integration token");
		let client = new ZB.notion.NotionClient({ token: settings.notionToken, fetch: (u, i) => fetch(u, i) });
		let targets = new Map();
		if (settings.defaults.notionDatabase) targets.set(settings.defaults.notionDatabase, "預設");
		for (let rule of settings.rules) {
			if (rule.notionDatabase && !targets.has(rule.notionDatabase)) targets.set(rule.notionDatabase, rule.name || "規則");
		}
		if (!targets.size) throw new Error("請先填入至少一個 Notion database 連結");
		let lines = [];
		for (let [db, label] of targets) {
			try {
				let dsId = await client.resolveDataSourceId(db);
				let added = await client.ensureSchema(dsId);
				lines.push(`✅ ${label}：連線成功${added.length ? `，已新增欄位 ${added.join(", ")}` : "，欄位齊全"}`);
			}
			catch (e) {
				lines.push(`❌ ${label}：${e.message || e}`);
			}
		}
		return lines;
	}

	// ---------- menus ----------

	const ITEM_ACTIONS = [
		{ l10nID: "zotero-bridge-menu-sync", action: { targets: ["notion", "obsidian"], ai: "missing" } },
		{ l10nID: "zotero-bridge-menu-regenerate", action: { targets: ["notion", "obsidian"], ai: "regenerate" } },
		{ l10nID: "zotero-bridge-menu-no-ai", action: { targets: ["notion", "obsidian"], ai: "reuse" } },
		{ separator: true },
		{ l10nID: "zotero-bridge-menu-obsidian", action: { targets: ["obsidian"], ai: "reuse" } },
		{ l10nID: "zotero-bridge-menu-notion", action: { targets: ["notion"], ai: "reuse" } },
	];

	function buildMenus(getItems) {
		return ITEM_ACTIONS.map((entry) => {
			if (entry.separator) return { menuType: "separator" };
			return {
				menuType: "menuitem",
				l10nID: entry.l10nID,
				onCommand: (ev, context) => {
					run(getItems(context), entry.action).catch(e => Zotero.logError(e));
				},
			};
		});
	}

	function collectionItems(context) {
		let rows = context.collectionTreeRows || [];
		let items = [];
		for (let row of rows) {
			if (row.isCollection && row.isCollection()) {
				items.push(...ZB.adapter.itemsInCollection(row.ref, true));
			}
		}
		return items;
	}

	function registerMenus() {
		let icon = rootURI + "content/icons/bridge.svg";
		let itemMenu = Zotero.MenuManager.registerMenu({
			menuID: "zotero-bridge-item",
			pluginID,
			target: "main/library/item",
			menus: [{
				menuType: "submenu",
				l10nID: "zotero-bridge-menu",
				icon,
				menus: buildMenus(context => context.items || []),
			}],
		});
		let collectionMenu = Zotero.MenuManager.registerMenu({
			menuID: "zotero-bridge-collection",
			pluginID,
			target: "main/library/collection",
			menus: [{
				menuType: "submenu",
				l10nID: "zotero-bridge-menu-collection",
				icon,
				onShowing: (ev, context) => {
					let rows = context.collectionTreeRows || [];
					context.setVisible(rows.some(r => r.isCollection && r.isCollection()));
				},
				menus: buildMenus(collectionItems),
			}],
		});
		let toolsMenu = Zotero.MenuManager.registerMenu({
			menuID: "zotero-bridge-tools",
			pluginID,
			target: "main/menubar/tools",
			menus: [{
				menuType: "menuitem",
				l10nID: "zotero-bridge-menu-settings",
				onCommand: () => Zotero.Utilities.Internal.openPreferences("zotero-bridge-prefs"),
			}],
		});
		menuIDs = [itemMenu, collectionMenu, toolsMenu].filter(Boolean);
	}

	// ---------- auto-sync ----------

	function registerNotifier() {
		notifierID = Zotero.Notifier.registerObserver({
			notify: (event, type, ids) => {
				if (!pref("autoSync")) return;
				if (!["add", "modify"].includes(event)) return;
				for (let id of ids) {
					if (selfModified.has(id)) continue;
					autoSyncQueue.add(id);
				}
				if (!autoSyncQueue.size) return;
				if (autoSyncTimer) clearTimeout(autoSyncTimer);
				autoSyncTimer = setTimeout(flushAutoSync, AUTO_SYNC_DELAY_MS);
			},
		}, ["item"], "zotero-bridge");
	}

	function flushAutoSync() {
		autoSyncTimer = null;
		let items = Zotero.Items.get([...autoSyncQueue].filter(id => Zotero.Items.exists(id)));
		autoSyncQueue.clear();
		// Auto-sync never spends LLM tokens: it reuses the stored AI note
		run(items, { targets: ["notion", "obsidian"], ai: "reuse", silent: true }).catch(e => Zotero.logError(e));
	}

	// ---------- lifecycle ----------

	function init(opts) {
		pluginID = opts.id;
		rootURI = opts.rootURI;
		registerMenus();
		registerNotifier();
	}

	function shutdown() {
		for (let id of menuIDs) Zotero.MenuManager.unregisterMenu(id);
		menuIDs = [];
		if (notifierID) Zotero.Notifier.unregisterObserver(notifierID);
		notifierID = null;
		if (autoSyncTimer) clearTimeout(autoSyncTimer);
	}

	ZB.main = { init, shutdown, run, testNotion, readSettings, readAINote };
})(this);
