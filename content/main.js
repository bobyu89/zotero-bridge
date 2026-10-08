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
	// Items trashed or deleted in Zotero: zotero key → item ID (null once the item is gone)
	let archiveQueue = new Map();
	// Item IDs we just wrote ourselves (AI notes), so auto-sync doesn't react to them
	let selfModified = new Set();
	let running = Promise.resolve();
	// Test hook: extra options for LLM calls (e.g. { sleep } to skip retry delays)
	let runtime = { retry: {} };

	function pref(key) {
		return Zotero.Prefs.get(PREF + key, true);
	}

	async function readSettings() {
		let vaultPath = String(pref("obsidian.vaultPath") || "").trim();
		let provider = pref("llm.provider") === "openai" ? "openai" : "anthropic";
		// Secrets live in the login manager (secrets.js), not in prefs
		let notionToken = await ZB.secrets.get("notionToken");
		let apiKey = await ZB.secrets.get(provider === "openai" ? "openaiKey" : "anthropicKey");
		return {
			vaultPath,
			vaultName: String(pref("obsidian.vaultName") || "").trim() || (vaultPath ? PathUtils.filename(vaultPath) : ""),
			filenameFormat: pref("obsidian.filenameFormat") || "citekey",
			createBase: pref("obsidian.createBase") !== false,
			includeNotes: pref("includeNotes") !== false,
			notionToken: String(notionToken || "").trim(),
			defaults: {
				obsidianFolder: pref("obsidian.folder") || "",
				notionDatabase: String(pref("notion.database") || "").trim(),
			},
			rules: ZB.core.parseRules(pref("routing.rules")),
			llm: {
				enabled: pref("llm.enabled") !== false,
				provider,
				apiKey: String(apiKey || "").trim(),
				model: String(pref(provider === "openai" ? "llm.openaiModel" : "llm.anthropicModel") || "").trim()
					|| ZB.llm.DEFAULT_MODELS[provider],
				effort: pref("llm.effort") || "medium",
				baseURL: String(pref("llm.openaiBaseURL") || "").trim(),
				systemPrompt: pref("llm.systemPrompt") || "",
				fullTextLimit: Number(pref("llm.fullTextLimit")) || 0,
				synthesisPrompt: pref("llm.synthesisPrompt") || "",
			},
			notionSynthesisParent: String(pref("notion.synthesisParent") || "").trim(),
		};
	}

	function parseHTML(html) {
		return new DOMParser().parseFromString(html, "text/html");
	}

	function nowISO() {
		return new Date().toISOString();
	}

	function markSelfModified(...ids) {
		for (let id of ids) {
			selfModified.add(id);
			setTimeout(() => selfModified.delete(id), AUTO_SYNC_DELAY_MS * 2);
		}
	}

	// ---------- AI usage ledger ----------

	function readPrices() {
		return ZB.usage.parsePrices(pref("usage.prices"));
	}

	function readLedger() {
		return ZB.usage.parseLedger(pref("usage.ledger"));
	}

	/** Add one LLM call to the monthly ledger pref and to the current run's totals. */
	function recordAIUsage(result, runTotals) {
		let call = { model: result.model, usage: result.usage };
		try {
			Zotero.Prefs.set(PREF + "usage.ledger", JSON.stringify(ZB.usage.recordUsage(readLedger(), call)), true);
		}
		catch (e) {
			Zotero.logError(e);
		}
		if (runTotals) runTotals.ledger = ZB.usage.recordUsage(runTotals.ledger, call);
	}

	/** One-line summary of the AI calls in this run (empty if none). */
	function runUsageLine(runTotals) {
		let month = runTotals && Object.values(runTotals.ledger)[0];
		return month ? ZB.usage.describeRun(month, readPrices().prices) : "";
	}

	function retryStatus(status) {
		return ({ attempt, maxRetries, delay, status: code }) => {
			status(`AI 服務暫時無法使用（${code || "連線錯誤"}），${Math.max(1, Math.round(delay / 1000))} 秒後重試（${attempt}/${maxRetries}）…`);
		};
	}

	/** Settings pane: lines for "本月 AI 用量". */
	function usageReport() {
		let { prices, error } = readPrices();
		let lines = ZB.usage.describeMonth(readLedger()[ZB.usage.monthKey()], prices);
		if (error) lines.push(`⚠️ ${error}（改用內建價格表）`);
		return lines;
	}

	function resetUsage() {
		Zotero.Prefs.set(PREF + "usage.ledger", "{}", true);
	}

	// ---------- AI note ----------

	// The structured data goes last, as a heading + <pre> (both survive Zotero's note editor),
	// so a later sync without AI can fill the Notion columns and frontmatter from it
	function aiNoteHTML(md, model, at, data, raw) {
		let block = data || raw ? ZB.llm.studyDataBlock(data, raw) : "";
		return `<h1>${AI_TITLE}</h1>\n<p><em>由 ${model} 於 ${at} 產生（Zotero Bridge）</em></p>\n`
			+ ZB.markdown.mdToHtml(block ? `${md}\n\n${block}` : md);
	}

	// Read back an AI note written by aiNoteHTML (the user may have edited it in Zotero).
	// The structured-data block is removed from `md` and returned as `data`.
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
		let parsed = ZB.llm.extractStudyData(md);
		return { md: parsed.md.trim(), model, at, data: parsed.data, dataError: parsed.found ? parsed.error : "" };
	}

	/**
	 * Post-process a freshly generated note: take out the JSON block and verify the quotes.
	 * Returns { md, data, raw, messages } — messages are short notes for the progress window.
	 */
	function processGeneratedNote(text, data) {
		let messages = [];
		let parsed = ZB.llm.extractStudyData(text);
		if (!parsed.found) messages.push("⚠️ AI 沒有輸出結構化資料（JSON），研讀欄位留空");
		else if (parsed.error) messages.push(`⚠️ 結構化資料：${parsed.error}`);
		let texts = [data.abstract];
		for (let att of data.attachments || []) {
			for (let ann of att.annotations || []) texts.push(ann.text);
		}
		let check = ZB.verify.verifyQuotes(parsed.md.trim(), { fullText: data.fullText, texts });
		let summary = ZB.verify.summarize(check);
		if (summary) messages.push(summary);
		return { md: check.md, data: parsed.data, raw: parsed.found && !parsed.data ? parsed.raw : "", messages, check };
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
		let messages = [];
		let quoteCheck = null;
		let ai = null;
		// PNGs of image/ink annotations, when this sync uses them (annotation-images.js)
		let images = await ZB.images.collect(data, { targets: action.targets, ai: needAI }, ctx, messages);
		if (needAI) {
			ctx.status("AI 產生筆記中…");
			try {
				let result = await ZB.llm.generateNote(settings.llm, data, {
					systemPrompt: settings.llm.systemPrompt,
					notesMarkdown,
					fullTextTruncated: data.fullTextTruncated,
					images: await ZB.images.forPrompt(images, settings.llm, ctx, messages),
				}, (url, init) => fetch(url, init), Object.assign({ onRetry: retryStatus(ctx.status) }, ctx.retry));
				recordAIUsage(result, ctx.usage);
				let at = nowISO();
				let processed = processGeneratedNote(result.text.trim(), data);
				messages.push(...processed.messages);
				quoteCheck = processed.check;
				ai = { md: processed.md, model: result.model || settings.llm.model, at, data: processed.data };
				// Saving a child note also reports a change of the item itself, and Zotero notifies
				// before saveTx() returns: mark the item first (the notes are checked again at flush time)
				markSelfModified(item.id);
				let saved = await ZB.adapter.saveAINote(item, aiNoteHTML(ai.md, ai.model, at, processed.data, processed.raw));
				markSelfModified(saved.note.id);
			}
			catch (e) {
				errors.push(`AI 筆記：${e.message || e}`);
			}
		}
		if (!ai && data.aiNote && action.ai !== "none") {
			ai = readAINote(data.aiNote.html);
			if (ai.dataError) messages.push(`⚠️ AI 子筆記的結構化資料無法讀取：${ai.dataError}`);
		}

		let route = ZB.core.resolveRoute(data, settings.rules, settings.defaults);
		let folderParts = ZB.core.splitFolder(route.obsidianFolder);
		let basename = ZB.core.noteBasename(data, settings.filenameFormat);
		let obsidian = null;
		if (settings.vaultPath) {
			// A changed citekey/title renames the existing note, but only when this run writes Obsidian
			obsidian = await resolveObsidianPath(settings, folderParts, basename, data, {
				index: ctx.obsidianIndex, rename: action.targets.has("obsidian"),
			});
		}

		let notionUrl = null;
		if (action.targets.has("notion")) {
			ctx.status("同步到 Notion…");
			try {
				if (!route.notionDatabase) throw new Error(`沒有對應的資料庫（規則：${route.ruleName || "預設"}）`);
				notionUrl = await syncNotion(ctx.notion(settings.notionToken), route.notionDatabase, data, {
					ai, notesMarkdown, obsidianURI: obsidian && obsidian.uri, messages, images,
				}, ctx);
			}
			catch (e) {
				errors.push(`Notion：${e.message || e}`);
			}
		}

		if (action.targets.has("obsidian")) {
			ctx.status("寫入 Obsidian…");
			try {
				let noteData = await ZB.images.writeToVault(obsidian, data, images, messages);
				await writeObsidian(obsidian, noteData, { ai, notesMarkdown, notionUrl });
				if (ctx.obsidianIndex) ctx.obsidianIndex.add(`${data.libraryPath}/${data.key}`, obsidian.path, obsidian.relParts);
			}
			catch (e) {
				errors.push(`Obsidian：${e.message || e}`);
			}
		}
		if (errors.length) throw new Error([...errors, ...messages].join("；"));
		return { route, notionUrl, obsidianPath: obsidian && obsidian.relPath, generated: !!ai && needAI, messages, quoteCheck };
	}

	// ---------- Obsidian note lookup ----------

	// Enough for the plugin's frontmatter up to zotero_key unless the author list is very long
	const HEAD_BYTES = 4096;
	const MAX_FOLDER_DEPTH = 16;

	/** The zotero_key in a note's frontmatter (null if none), reading only its head when that suffices. */
	async function readZoteroKey(path) {
		let bytes = await IOUtils.read(path, { maxBytes: HEAD_BYTES });
		let key = ZB.core.zoteroKeyFromHead(new TextDecoder().decode(bytes), bytes.length < HEAD_BYTES);
		if (key !== undefined) return key;
		return ZB.core.zoteroKeyFromHead(await IOUtils.readUTF8(path));
	}

	// null: no such file; "": a note without zotero_key; otherwise the item that owns it
	async function noteOwner(path) {
		if (!(await IOUtils.exists(path))) return null;
		return (await readZoteroKey(path)) || "";
	}

	/** Folders the plugin writes notes to (default and rule folders), minus those inside another one. */
	function pluginFolders(settings) {
		let all = [settings.defaults.obsidianFolder, ...settings.rules.map(r => r.obsidianFolder).filter(Boolean)]
			.map(f => ZB.core.splitFolder(f));
		let within = (a, b) => b.length <= a.length && b.every((part, i) => part === a[i]);
		return all.filter((a, i) => !all.some((b, j) => j !== i && within(a, b) && (b.length < a.length || j < i)));
	}

	function addIndexEntry(index, key, path, relParts) {
		let list = index.get(key) || [];
		if (!list.some(e => e.path === path)) list.push({ path, relParts });
		index.set(key, list);
	}

	/** zotero_key → [{ path, relParts }] for every .md file under the plugin folders (recursively). */
	async function buildObsidianIndex(settings) {
		let index = new Map();
		let visit = async (dir, relParts) => {
			let children;
			try {
				children = await IOUtils.getChildren(dir);
			}
			catch (e) {
				return; // the folder doesn't exist yet
			}
			for (let child of children) {
				let name = PathUtils.filename(child);
				// .obsidian, .trash and other hidden folders
				if (name.startsWith(".")) continue;
				try {
					if (/\.md$/i.test(name)) {
						let key = await readZoteroKey(child);
						if (key) addIndexEntry(index, key, child, [...relParts, name]);
					}
					else if (relParts.length < MAX_FOLDER_DEPTH && (await IOUtils.stat(child)).type === "directory") {
						await visit(child, [...relParts, name]);
					}
				}
				catch (e) {
					Zotero.debug(`Zotero Bridge: skipped ${child}: ${e}`);
				}
			}
		};
		for (let parts of pluginFolders(settings)) {
			await visit(PathUtils.join(settings.vaultPath, ...parts), parts);
		}
		return index;
	}

	/** The vault index for one run: built on first use, then kept up to date with the notes the run writes. */
	function obsidianIndexCache(settings) {
		let index = null;
		return {
			async get() {
				if (!index) index = await buildObsidianIndex(settings);
				return index;
			},
			add(key, path, relParts) {
				if (index) addIndexEntry(index, key, path, relParts);
			},
		};
	}

	function obsidianTarget(settings, folderParts, name) {
		let relParts = [...folderParts, name + ".md"];
		let relPath = relParts.join("/");
		return {
			dir: PathUtils.join(settings.vaultPath, ...folderParts),
			path: PathUtils.join(settings.vaultPath, ...relParts),
			relParts,
			relPath,
			uri: settings.vaultName ? ZB.core.obsidianURI(settings.vaultName, relPath) : "",
		};
	}

	/**
	 * Find the item's note. Usually it is <folder>/<basename>.md, or "<basename> (KEY).md" when
	 * another item has that name. Otherwise (citekey or title changed, or the user moved the note)
	 * it is looked up by zotero_key in opts.index and, with opts.rename, renamed in its folder.
	 * Without an existing note, returns where a new one goes.
	 */
	async function resolveObsidianPath(settings, folderParts, basename, data, opts = {}) {
		let zoteroKey = `${data.libraryPath}/${data.key}`;
		let altName = `${basename} (${data.key})`;
		let dir = PathUtils.join(settings.vaultPath, ...folderParts);
		let owner = await noteOwner(PathUtils.join(dir, basename + ".md"));
		if (owner === zoteroKey) return obsidianTarget(settings, folderParts, basename);
		if (owner && (await noteOwner(PathUtils.join(dir, altName + ".md"))) === zoteroKey) {
			return obsidianTarget(settings, folderParts, altName);
		}
		if (opts.index) {
			let notes = (await opts.index.get()).get(zoteroKey) || [];
			let fileName = n => n.relParts[n.relParts.length - 1].replace(/\.md$/i, "");
			let found = notes.find(n => fileName(n) === basename || fileName(n) === altName) || notes[0];
			if (found) {
				let name = fileName(found);
				if (opts.rename && name !== basename && name !== altName) {
					name = (await renameNote(found, basename, altName, zoteroKey)) || name;
				}
				return obsidianTarget(settings, found.relParts.slice(0, -1), name);
			}
		}
		// A new note: two items with the same citekey/title must not overwrite each other
		return obsidianTarget(settings, folderParts, owner ? altName : basename);
	}

	/** Rename an indexed note to its new basename in the same folder; returns the new name or null. */
	async function renameNote(entry, basename, altName, zoteroKey) {
		let dir = PathUtils.parent(entry.path);
		for (let name of [basename, altName]) {
			let to = PathUtils.join(dir, name + ".md");
			let owner = await noteOwner(to);
			// Taken by another item, or by a note of the user's
			if (owner !== null && owner !== zoteroKey) continue;
			if (owner === null) {
				try {
					await IOUtils.move(entry.path, to, { noOverwrite: true });
				}
				catch (e) {
					Zotero.logError(e);
					return null;
				}
				Zotero.debug(`Zotero Bridge: renamed ${entry.path} → ${to}`);
			}
			entry.path = to;
			entry.relParts = [...entry.relParts.slice(0, -1), name + ".md"];
			return name;
		}
		return null;
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
			study: opts.ai && opts.ai.data,
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
		let study = opts.ai && opts.ai.data;
		if (study && !schema.props["Study Design"] && !ctx.schemaHints.has(dsId)) {
			// Databases set up before these columns existed: adding them is the user's call
			ctx.schemaHints.add(dsId);
			if (opts.messages) opts.messages.push("Notion 資料庫還沒有研讀欄位（Study Design 等）：到 設定 → Zotero Bridge 按「測試連線並補齊資料庫欄位」即可加上");
		}
		let zoteroKey = `${data.libraryPath}/${data.key}`;
		let properties = ZB.notion.buildProperties(schema, {
			title: data.title,
			authors: ZB.core.authorNames(data).join("; "),
			year: data.year,
			date: data.date,
			publication: data.publication,
			volume: data.volume,
			issue: data.issue,
			pages: data.pages,
			publisher: data.publisher,
			itemType: data.itemType,
			doi: data.doi,
			url: data.url,
			abstract: data.abstract,
			dateAdded: data.dateAdded,
			zotero: ZB.core.zoteroSelectURI(data),
			obsidian: opts.obsidianURI,
			tags: data.tags,
			collections: data.collections,
			library: data.libraryName,
			citationKey: data.citationKey,
			zoteroKey,
			summary: opts.ai ? ZB.markdown.plainText(ZB.llm.extractSummary(opts.ai.md)) : "",
			study,
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
		// Image annotations are uploaded just before the blocks that show them are written
		let uploaded = await ZB.images.uploadToNotion(client, data, opts.images, ctx, opts.messages || []);
		let md = ZB.core.buildManagedSection(uploaded.data, {
			aiMarkdown: opts.ai && opts.ai.md,
			notesMarkdown: opts.notesMarkdown,
		});
		let blocks = ZB.markdown.mdToNotionBlocks(md, { images: uploaded.ids });
		await client.replaceManagedContainer(page.id, "自動同步區（重新同步會覆寫，個人筆記請寫在此區塊外）", blocks);
		return page.url;
	}

	// ---------- batch state: stop and resume ----------

	// Manual runs of more than one item keep their unfinished items in a pref, so a batch that was
	// stopped, interrupted (Zotero quit or crashed) or had failures can be resumed later.
	// { action: { targets, ai }, remaining: ["libraryID/KEY"], failed: [...], total, running, startedAt }
	const BATCH_PREF = "batch.pending";
	let currentBatch = null;

	function itemRef(item) {
		return `${item.libraryID}/${item.key}`;
	}

	function readPendingBatch() {
		try {
			let batch = JSON.parse(pref(BATCH_PREF) || "null");
			if (!batch || !Array.isArray(batch.remaining) || !Array.isArray(batch.failed)) return null;
			return batch.remaining.length + batch.failed.length ? batch : null;
		}
		catch (e) {
			return null;
		}
	}

	function writePendingBatch(batch) {
		try {
			Zotero.Prefs.set(PREF + BATCH_PREF, batch ? JSON.stringify(batch) : "", true);
		}
		catch (e) {
			Zotero.logError(e);
		}
	}

	function pendingCount(batch) {
		return batch ? batch.remaining.length + batch.failed.length : 0;
	}

	/** Tools menu: stop the running batch after the item in progress. */
	function cancelBatch() {
		if (!currentBatch || currentBatch.cancelled) return false;
		currentBatch.cancelled = true;
		currentBatch.onCancel();
		return true;
	}

	/** Tools menu: sync the items a stopped, interrupted or partly failed batch left over. */
	function resumeBatch() {
		let batch = readPendingBatch();
		if (!batch) {
			notify("Zotero Bridge", "沒有未完成的同步。");
			return Promise.resolve();
		}
		let items = [];
		for (let ref of [...batch.remaining, ...batch.failed]) {
			let slash = ref.indexOf("/");
			let item = Zotero.Items.getByLibraryAndKey(Number(ref.slice(0, slash)), ref.slice(slash + 1));
			if (item && !item.deleted) items.push(item);
		}
		if (!items.length) {
			writePendingBatch(null);
			notify("Zotero Bridge", "未完成的文獻都已刪除，已清除這筆紀錄。");
			return Promise.resolve();
		}
		return run(items, { targets: batch.action.targets, ai: batch.action.ai, resumed: true });
	}

	/** Tools menu: forget the unfinished batch. */
	function discardBatch() {
		writePendingBatch(null);
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
			settings = await readSettings();
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
				`即將為最多 ${items.length} 筆文獻呼叫 ${settings.llm.provider === "openai" ? "OpenAI" : "Claude"}（${settings.llm.model}）產生 AI 筆記，會產生 API 費用。`
				+ batchEstimate(items, action, settings) + "要繼續嗎？");
			if (!ok) return;
		}

		let pw = action.silent ? null : new Zotero.ProgressWindow({ closeOnClick: true });
		if (pw) {
			pw.changeHeadline(action.resumed ? "Zotero Bridge：繼續未完成的同步" : "Zotero Bridge");
			pw.show();
		}
		// Only manual batches are tracked; auto-sync runs again on the next change anyway
		let batch = null;
		if (!action.silent && (items.length > 1 || action.resumed)) {
			batch = {
				action: { targets: [...action.targets], ai: action.ai },
				remaining: items.map(itemRef),
				failed: [],
				total: items.length,
				running: true,
				startedAt: nowISO(),
			};
			writePendingBatch(batch);
			if (pw) pw.addDescription("要中途停止：工具 → 停止 Zotero Bridge 同步（處理中的這篇完成後停止）");
		}
		let stopLine = null;
		currentBatch = batch && {
			cancelled: false,
			onCancel() {
				if (pw && !stopLine) {
					stopLine = new pw.ItemProgress("", "正在停止…（處理中的這篇完成後停止）");
				}
			},
		};
		let clients = new Map();
		let ctx = {
			schemaCache: new Map(),
			schemaHints: new Set(),
			obsidianIndex: settings.vaultPath ? obsidianIndexCache(settings) : null,
			notion(token) {
				if (!clients.has(token)) clients.set(token, new ZB.notion.NotionClient({ token, fetch: (u, i) => fetch(u, i) }));
				return clients.get(token);
			},
			status: () => {},
			usage: { ledger: {} },
			retry: runtime.retry,
		};
		let ok = 0;
		let failures = [];
		let quotes = { total: 0, verified: 0, notFound: 0, unchecked: 0 };
		let cancelled = false;
		for (let item of items) {
			if (currentBatch && currentBatch.cancelled) {
				cancelled = true;
				break;
			}
			let title = item.getField("title") || item.key;
			let line = pw ? new pw.ItemProgress(item.getItemTypeIconName(), title) : null;
			ctx.status = (s) => {
				if (line) line.setText(`${title} — ${s}`);
			};
			try {
				let result = await syncItem(item, action, settings, ctx);
				ok++;
				if (result.quoteCheck) {
					for (let k of Object.keys(quotes)) quotes[k] += result.quoteCheck[k];
				}
				if (line) {
					line.setText(result.messages.length ? `${title} — ${result.messages.join("；")}` : title);
					line.setProgress(100);
				}
			}
			catch (e) {
				Zotero.logError(e);
				failures.push(`${title}：${e.message || e}`);
				if (batch) batch.failed.push(itemRef(item));
				if (line) {
					line.setText(`${title} — ${e.message || e}`);
					line.setError();
				}
			}
			if (batch) {
				batch.remaining.splice(batch.remaining.indexOf(itemRef(item)), 1);
				writePendingBatch(batch);
			}
		}
		let stoppedByShutdown = !!(currentBatch && currentBatch.shutdown);
		currentBatch = null;
		if (stopLine) {
			stopLine.setText("已停止");
			stopLine.setProgress(100);
		}
		if (batch) {
			// Stopped by the plugin shutting down (Zotero quitting, plugin update): remind at next start
			batch.running = stoppedByShutdown;
			writePendingBatch(pendingCount(batch) ? batch : null);
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
			let quoteSummary = items.length > 1 ? ZB.verify.summarize(quotes) : "";
			pw.addDescription(`完成 ${ok} 筆${failures.length ? `，失敗 ${failures.length} 筆（詳見 說明 → 除錯輸出記錄）` : ""}`
				+ (cancelled ? `，未處理 ${batch.remaining.length} 筆` : "")
				+ (quoteSummary ? `；${quoteSummary}` : ""));
			if (batch && pendingCount(batch)) {
				pw.addDescription(`要接續：工具 → 繼續未完成的 Zotero Bridge 同步（${pendingCount(batch)} 筆${batch.failed.length ? `，含失敗 ${batch.failed.length} 筆` : ""}）`);
			}
			let usageLine = runUsageLine(ctx.usage);
			if (usageLine) pw.addDescription(usageLine);
			pw.startCloseTimer(failures.length || cancelled ? 15000 : 5000);
		}
		else if (failures.length) {
			notify("Zotero Bridge 自動同步失敗", failures.slice(0, 3).join("\n"));
		}
		// 「同步時自動更新參考文獻檔」 (export.js); never throws
		if (ok) await ZB.bibliography.afterSync(settings);
	}

	/** Rough cost for the confirm dialog, from the ledger's average tokens per call ("" when unknown). */
	function batchEstimate(items, action, settings) {
		try {
			let n = action.ai === "regenerate" ? items.length : items.filter(i => !ZB.adapter.getAINote(i)).length;
			let est = ZB.usage.estimateCost(readLedger(), settings.llm.model, readPrices().prices, n);
			if (!est) return "";
			return `\n\n預估費用：約 ${ZB.usage.formatUSD(est.total)}（${n} 筆 × 每筆約 ${ZB.usage.formatUSD(est.perCall)}，`
				+ `依過去 ${est.samples} 次呼叫的平均用量估算；實際費用依全文長度而定）。\n\n`;
		}
		catch (e) {
			Zotero.logError(e);
			return "";
		}
	}

	function notify(headline, text) {
		let pw = new Zotero.ProgressWindow({ closeOnClick: true });
		pw.changeHeadline(headline);
		pw.addDescription(text);
		pw.show();
		pw.startCloseTimer(10000);
	}

	// ---------- deleted items ----------

	/**
	 * Items trashed or deleted in Zotero: move their Notion pages to the Notion trash and mark their
	 * Obsidian notes as deleted (the files are kept). `keys` are zotero keys as written to Notion and
	 * Obsidian ("library/KEY", "groups/ID/KEY"). Runs after any sync in progress; returns counts.
	 */
	function archiveItems(keys) {
		let p = running.then(() => archiveNow(keys));
		running = p.catch(() => {});
		return p;
	}

	async function archiveNow(keys) {
		keys = [...new Set((keys || []).filter(k => typeof k === "string" && k))];
		let counts = { notion: 0, obsidian: 0 };
		if (!keys.length) return counts;
		let settings;
		try {
			settings = await readSettings();
		}
		catch (e) {
			Zotero.logError(e);
			return counts;
		}
		let errors = [];
		if (settings.notionToken) {
			try {
				counts.notion = await trashNotionPages(settings, keys, errors);
			}
			catch (e) {
				errors.push(`Notion：${e.message || e}`);
			}
		}
		if (settings.vaultPath) {
			try {
				counts.obsidian = await markObsidianNotesDeleted(settings, keys);
			}
			catch (e) {
				errors.push(`Obsidian：${e.message || e}`);
			}
		}
		if (errors.length) {
			errors.forEach(e => Zotero.logError(new Error(e)));
			notify("Zotero Bridge：刪除的文獻同步失敗", errors.slice(0, 3).join("\n"));
		}
		return counts;
	}

	async function trashNotionPages(settings, keys, errors) {
		let client = new ZB.notion.NotionClient({ token: settings.notionToken, fetch: (u, i) => fetch(u, i) });
		// A deleted item's collections (and so its route) are unknown: look in every configured database
		let databases = new Set([settings.defaults.notionDatabase, ...settings.rules.map(r => r.notionDatabase)].filter(Boolean));
		let dataSources = new Set();
		for (let db of databases) {
			try {
				dataSources.add(await client.resolveDataSourceId(db));
			}
			catch (e) {
				errors.push(`Notion：${e.message || e}`);
			}
		}
		let count = 0;
		for (let dsId of dataSources) {
			try {
				// A database the plugin never wrote to has no "Zotero Key" column and none of our pages
				let schema = await client.getSchema(dsId);
				if (schema.props["Zotero Key"] !== "rich_text") continue;
				for (let page of await client.findPagesByZoteroKeys(dsId, keys)) {
					await client.trashPage(page.id);
					count++;
				}
			}
			catch (e) {
				errors.push(`Notion：${e.message || e}`);
			}
		}
		return count;
	}

	async function markObsidianNotesDeleted(settings, keys) {
		let index = await buildObsidianIndex(settings);
		let now = nowISO();
		let count = 0;
		for (let key of keys) {
			for (let { path } of index.get(key) || []) {
				let text = await IOUtils.readUTF8(path);
				let marked = ZB.core.markObsidianNoteDeleted(text, { now });
				if (marked !== text) {
					await IOUtils.writeUTF8(path, marked);
					count++;
				}
			}
		}
		return count;
	}

	// ---------- cross-paper synthesis ----------

	const MAX_SYNTHESIS_ITEMS = 60;

	function stamp(date = new Date()) {
		let p = n => String(n).padStart(2, "0");
		return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}${p(date.getMinutes())}`;
	}

	/**
	 * Compare several items: one LLM call over their AI notes (or abstracts + highlights),
	 * written to Obsidian, Notion (under a chosen parent page) and a Zotero standalone note.
	 * @param {object} scope { label, collection }
	 */
	function runSynthesis(items, scope) {
		let p = running.then(() => runSynthesisNow(items, scope));
		running = p.catch(() => {});
		return p;
	}

	async function runSynthesisNow(items, scope) {
		items = ZB.adapter.toRegularItems(items);
		if (items.length < 2) {
			notify("Zotero Bridge", "文獻比較表至少需要 2 篇文獻。");
			return;
		}
		let settings;
		try {
			settings = await readSettings();
		}
		catch (e) {
			notify("Zotero Bridge 設定有誤", String(e.message || e));
			return;
		}
		if (!settings.llm.apiKey) {
			notify("Zotero Bridge", "文獻比較表需要 LLM API key：請到 設定 → Zotero Bridge 填入。");
			return;
		}
		let extra = items.length > MAX_SYNTHESIS_ITEMS ? `（超過 ${MAX_SYNTHESIS_ITEMS} 篇，只會使用前 ${MAX_SYNTHESIS_ITEMS} 篇）` : "";
		items = items.slice(0, MAX_SYNTHESIS_ITEMS);
		let ok = Services.prompt.confirm(Zotero.getMainWindow(), "Zotero Bridge",
			`將用 ${settings.llm.model} 比較 ${items.length} 篇文獻並產生文獻比較表${extra}，會產生一次 API 費用。要繼續嗎？`);
		if (!ok) return;

		let pw = new Zotero.ProgressWindow({ closeOnClick: true });
		pw.changeHeadline("Zotero Bridge：文獻比較表");
		pw.show();
		let line = new pw.ItemProgress("note", `讀取 ${items.length} 篇文獻…`);
		try {
			let sources = [];
			let withoutAI = 0;
			for (let item of items) {
				let data = await ZB.adapter.extractItemData(item, { fullTextLimit: 0 });
				let aiMarkdown = data.aiNote ? readAINote(data.aiNote.html).md : "";
				if (!aiMarkdown) withoutAI++;
				sources.push({ item, data, aiMarkdown, annotationsText: ZB.llm.formatAnnotationsForPrompt(data) });
			}
			let { system, user, entries } = ZB.synthesis.buildSynthesisPrompt(sources, {
				systemPrompt: settings.llm.synthesisPrompt,
			});
			line.setText(`AI 分析 ${items.length} 篇文獻中…（可能需要一兩分鐘）`);
			let runTotals = { ledger: {} };
			let result = await ZB.llm.generateText(settings.llm, system, user, (u, i) => fetch(u, i),
				Object.assign({ onRetry: retryStatus(s => line.setText(s)) }, runtime.retry));
			recordAIUsage(result, runTotals);
			let md = result.text.trim();
			let model = result.model || settings.llm.model;
			let generatedAt = new Date().toISOString();
			let title = `文獻比較：${scope.label}（${items.length} 篇）`;
			let outputs = [];
			let errors = [];

			let notionUrl = "";
			if (settings.notionToken && settings.notionSynthesisParent) {
				line.setText("建立 Notion 頁面…");
				try {
					let client = new ZB.notion.NotionClient({ token: settings.notionToken, fetch: (u, i) => fetch(u, i) });
					let blocks = ZB.markdown.mdToNotionBlocks(ZB.synthesis.buildSynthesisPlain(md, entries), { tables: true });
					let page = await client.createChildPage(settings.notionSynthesisParent, `${title} ${stamp()}`, blocks, "📊");
					notionUrl = page.url;
					outputs.push("Notion");
				}
				catch (e) {
					errors.push(`Notion：${e.message || e}`);
				}
			}

			if (settings.vaultPath) {
				line.setText("寫入 Obsidian…");
				try {
					// Link each source to its literature note when that note exists in the vault
					let linkTargets = {};
					let index = obsidianIndexCache(settings);
					for (let [i, src] of sources.entries()) {
						let route = ZB.core.resolveRoute(src.data, settings.rules, settings.defaults);
						let target = await resolveObsidianPath(settings, ZB.core.splitFolder(route.obsidianFolder),
							ZB.core.noteBasename(src.data, settings.filenameFormat), src.data, { index });
						if (await IOUtils.exists(target.path)) linkTargets[entries[i].id] = target.relPath.replace(/\.md$/i, "");
					}
					let dir = PathUtils.join(settings.vaultPath, ...ZB.core.splitFolder(settings.defaults.obsidianFolder), "文獻比較");
					await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
					let path = PathUtils.join(dir, `${ZB.core.sanitizeFilename(title)} ${stamp()}.md`);
					await IOUtils.writeUTF8(path, ZB.synthesis.buildSynthesisNote(md, entries, {
						title, scope: scope.label, model, generatedAt, notionUrl, linkTargets,
					}));
					outputs.push("Obsidian");
				}
				catch (e) {
					errors.push(`Obsidian：${e.message || e}`);
				}
			}

			line.setText("存入 Zotero…");
			try {
				let note = new Zotero.Item("note");
				note.libraryID = items[0].libraryID;
				note.setNote(`<h1>📊 ${escapeHTML(title)}</h1>\n<p><em>由 ${escapeHTML(model)} 於 ${generatedAt} 產生（Zotero Bridge）</em></p>\n`
					+ ZB.markdown.mdToHtml(ZB.synthesis.buildSynthesisPlain(md, entries)));
				note.addTag("zotero-bridge-synthesis");
				if (scope.collection && scope.collection.libraryID === note.libraryID) note.addToCollection(scope.collection.id);
				for (let item of items) {
					if (item.libraryID === note.libraryID) note.addRelatedItem(item);
				}
				await note.saveTx();
				selfModified.add(note.id);
				setTimeout(() => selfModified.delete(note.id), AUTO_SYNC_DELAY_MS * 2);
				outputs.push("Zotero 筆記");
			}
			catch (e) {
				errors.push(`Zotero：${e.message || e}`);
			}

			line.setText(`${title} — 已寫入 ${outputs.join("、") || "（無）"}`);
			if (errors.length) {
				line.setError();
				errors.forEach(e => Zotero.logError(new Error(e)));
				pw.addDescription(errors.join("\n"));
			}
			else {
				line.setProgress(100);
			}
			if (withoutAI) pw.addDescription(`其中 ${withoutAI} 篇沒有 AI 筆記，改用摘要與劃線；先產生 AI 筆記可提高比較表品質。`);
			let usageLine = runUsageLine(runTotals);
			if (usageLine) pw.addDescription(usageLine);
			if (settings.notionToken && !settings.notionSynthesisParent) {
				pw.addDescription("想同步到 Notion：請在設定填入「文獻比較表的 Notion 父頁面」。");
			}
			pw.startCloseTimer(errors.length ? 20000 : 10000);
		}
		catch (e) {
			Zotero.logError(e);
			line.setText(`失敗：${e.message || e}`);
			line.setError();
			pw.startCloseTimer(20000);
		}
	}

	function escapeHTML(s) {
		return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	}

	// ---------- settings-pane helpers ----------

	/** Check the token and every configured database; add missing columns. Returns report lines. */
	async function testNotion() {
		let settings = await readSettings();
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

	function buildMenus(getItems, getScope) {
		let menus = ITEM_ACTIONS.map((entry) => {
			if (entry.separator) return { menuType: "separator" };
			return {
				menuType: "menuitem",
				l10nID: entry.l10nID,
				onCommand: (ev, context) => {
					run(getItems(context), entry.action).catch(e => Zotero.logError(e));
				},
			};
		});
		menus.push({ menuType: "separator" }, {
			menuType: "menuitem",
			l10nID: "zotero-bridge-menu-synthesis",
			onCommand: (ev, context) => {
				runSynthesis(getItems(context), getScope(context)).catch(e => Zotero.logError(e));
			},
		});
		return menus;
	}

	function selectedCollections(context) {
		return (context.collectionTreeRows || []).filter(r => r.isCollection && r.isCollection()).map(r => r.ref);
	}

	function itemScope(context) {
		let rows = selectedCollections(context);
		return { label: rows.length ? rows.map(c => c.name).join("、") + "（選取）" : "選取的文獻", collection: null };
	}

	function collectionScope(context) {
		let cols = selectedCollections(context);
		return { label: cols.map(c => c.name).join("、") || "分類", collection: cols[0] || null };
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
				menus: buildMenus(context => context.items || [], itemScope),
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
				menus: buildMenus(collectionItems, collectionScope),
			}],
		});
		let toolsMenu = Zotero.MenuManager.registerMenu({
			menuID: "zotero-bridge-tools",
			pluginID,
			target: "main/menubar/tools",
			menus: [
				{
					menuType: "menuitem",
					l10nID: "zotero-bridge-menu-settings",
					onCommand: () => Zotero.Utilities.Internal.openPreferences("zotero-bridge-prefs"),
				},
				{
					menuType: "menuitem",
					l10nID: "zotero-bridge-menu-stop",
					onShowing: (ev, context) => context.setVisible(!!currentBatch && !currentBatch.cancelled),
					onCommand: () => cancelBatch(),
				},
				{
					menuType: "menuitem",
					l10nID: "zotero-bridge-menu-resume",
					onShowing: (ev, context) => {
						let count = currentBatch ? 0 : pendingCount(readPendingBatch());
						context.setVisible(count > 0);
						if (count) context.setL10nArgs(JSON.stringify({ count }));
					},
					onCommand: () => resumeBatch().catch(e => Zotero.logError(e)),
				},
				{
					menuType: "menuitem",
					l10nID: "zotero-bridge-menu-discard",
					onShowing: (ev, context) => context.setVisible(!currentBatch && !!readPendingBatch()),
					onCommand: () => discardBatch(),
				},
			],
		});
		menuIDs = [itemMenu, collectionMenu, toolsMenu].filter(Boolean);
		// Bibliography export (export.js): Tools menu + collection context menu
		menuIDs.push(...ZB.bibliography.registerMenus({ pluginID, icon }));
	}

	// ---------- item pane: AI note section ----------

	let paneID = null;
	let paneRefresh = new WeakMap();

	function renderPane({ doc, body, item, setSectionSummary }) {
		body.replaceChildren();
		let el = (tag, text, style) => {
			let e = doc.createElement(tag);
			if (text !== undefined) e.textContent = text;
			if (style) e.setAttribute("style", style);
			return e;
		};
		let button = (label, action) => {
			let b = el("button", label, "margin: 4px 6px 4px 0;");
			b.addEventListener("click", () => {
				run([item], action).then(() => {
					let refresh = paneRefresh.get(body);
					if (refresh) refresh();
				}).catch(e => Zotero.logError(e));
			});
			return b;
		};
		let note = item && item.isRegularItem() ? ZB.adapter.getAINote(item) : null;
		let actions = el("div");
		if (!note) {
			setSectionSummary("尚未產生");
			body.append(el("p", "這篇文獻還沒有 AI 文獻筆記。", "margin: 4px 0; color: var(--fill-secondary);"));
			actions.append(button("產生 AI 筆記並同步", { targets: ["notion", "obsidian"], ai: "missing" }));
			body.append(actions);
			return;
		}
		let { md, model, at, data } = readAINote(note.getNote());
		let summary = ZB.markdown.plainText(ZB.llm.extractSummary(md));
		setSectionSummary(summary.slice(0, 80));
		if (model || at) body.append(el("div", [model, at && at.slice(0, 10)].filter(Boolean).join(" · "), "font-size: 0.9em; color: var(--fill-secondary); margin-bottom: 4px;"));
		if (data) {
			let facts = [
				data.study_design,
				Number.isFinite(data.sample_size) ? `N = ${data.sample_size}` : "",
				data.evidence_level ? `CEBM ${data.evidence_level}` : "",
				data.jbi_level ? `JBI ${data.jbi_level}` : "",
				data.appraisal_overall ? `評讀：${data.appraisal_overall}` : "",
				data.country,
			].filter(Boolean);
			if (facts.length) body.append(el("div", facts.join(" · "), "font-weight: 600; margin-bottom: 4px;"));
		}
		for (let block of ZB.markdown.mdToOutline(md)) {
			if (block.type === "h") {
				body.append(el("div", block.text, "font-weight: 600; margin: 8px 0 2px;"));
			}
			else if (block.type === "li") {
				body.append(el("div", "• " + block.text, `margin: 1px 0 1px ${0.8 + block.level}em; text-indent: -0.8em;`));
			}
			else if (block.type === "quote") {
				body.append(el("div", block.text, "margin: 2px 0; padding-left: 8px; border-inline-start: 3px solid var(--fill-quinary); font-style: italic;"));
			}
			else {
				body.append(el("div", block.text, "margin: 2px 0;"));
			}
		}
		actions.append(
			button("同步到 Notion + Obsidian", { targets: ["notion", "obsidian"], ai: "reuse" }),
			button("重新產生", { targets: ["notion", "obsidian"], ai: "regenerate" }),
		);
		body.append(actions);
	}

	function registerItemPane() {
		let icon = rootURI + "content/icons/bridge.svg";
		paneID = Zotero.ItemPaneManager.registerSection({
			paneID: "zotero-bridge-ai-note",
			pluginID,
			header: { l10nID: "zotero-bridge-pane-header", icon },
			sidenav: { l10nID: "zotero-bridge-pane-sidenav", icon },
			onInit: ({ body, refresh }) => {
				paneRefresh.set(body, refresh);
			},
			onItemChange: ({ item, setEnabled }) => {
				setEnabled(!!item && item.isRegularItem());
				return true;
			},
			onRender: renderPane,
		}) || null;
	}

	// ---------- auto-sync ----------

	// Our own writes and the AI note backups never trigger a sync
	function wantsAutoSync(id) {
		return !selfModified.has(id) && !ZB.adapter.isAIHistoryNote(Zotero.Items.get(id));
	}

	function registerNotifier() {
		notifierID = Zotero.Notifier.registerObserver({
			notify: (event, type, ids, extraData) => {
				if (!pref("autoSync")) return;
				if (event === "add" || event === "modify") {
					for (let id of ids) {
						if (wantsAutoSync(id)) autoSyncQueue.add(id);
					}
				}
				else if (event === "trash") {
					for (let id of ids) {
						let item = Zotero.Items.get(id);
						if (!item) continue;
						if (item.isRegularItem()) {
							let key = ZB.adapter.zoteroKeyFor(item.libraryID, item.key);
							if (key) archiveQueue.set(key, id);
						}
						// A trashed note or attachment changes what its parent item shows
						else if (wantsAutoSync(id)) {
							autoSyncQueue.add(id);
						}
					}
				}
				else if (event === "delete") {
					// The items are gone by now; Zotero passes { libraryID, key } per ID. Child items
					// (notes, annotations) can't be told apart and simply match no page or note.
					for (let id of ids) {
						let info = extraData && extraData[id];
						let key = info && ZB.adapter.zoteroKeyFor(info.libraryID, info.key);
						if (key) archiveQueue.set(key, null);
					}
				}
				if (!autoSyncQueue.size && !archiveQueue.size) return;
				if (autoSyncTimer) clearTimeout(autoSyncTimer);
				autoSyncTimer = setTimeout(flushAutoSync, AUTO_SYNC_DELAY_MS);
			},
		}, ["item"], "zotero-bridge");
	}

	function flushAutoSync() {
		autoSyncTimer = null;
		// Skip trashed items that were restored before the timer fired
		let archive = [...archiveQueue].filter(([, id]) => {
			let item = id !== null && Zotero.Items.get(id);
			return !item || item.deleted;
		}).map(([key]) => key);
		archiveQueue.clear();
		// Checked again here: Zotero reports a new note before saveTx() returns its ID to us
		let items = Zotero.Items.get([...autoSyncQueue].filter(id => Zotero.Items.exists(id) && wantsAutoSync(id)));
		autoSyncQueue.clear();
		if (archive.length) archiveItems(archive).catch(e => Zotero.logError(e));
		// Auto-sync never spends LLM tokens: it reuses the stored AI note
		if (items.length) run(items, { targets: ["notion", "obsidian"], ai: "reuse", silent: true }).catch(e => Zotero.logError(e));
	}

	// ---------- lifecycle ----------

	function init(opts) {
		pluginID = opts.id;
		rootURI = opts.rootURI;
		// Move secrets from plain prefs (earlier versions) into the login manager; readers wait for it
		ZB.secrets.migrateFromPrefs().then((names) => {
			if (names.length) Zotero.debug(`Zotero Bridge: moved ${names.join(", ")} from prefs to the login manager`);
		}).catch(e => Zotero.logError(e));
		registerMenus();
		registerItemPane();
		registerNotifier();
		remindInterruptedBatch();
	}

	// A batch still marked running at startup was cut off by Zotero quitting or crashing
	function remindInterruptedBatch() {
		let batch = readPendingBatch();
		if (!batch || !batch.running) return;
		batch.running = false;
		writePendingBatch(batch);
		(Zotero.uiReadyPromise || Promise.resolve()).then(() => {
			notify("Zotero Bridge：上次的同步沒有完成",
				`還有 ${pendingCount(batch)} 筆文獻沒有同步。要接續：工具 → 繼續未完成的 Zotero Bridge 同步。`);
		}).catch(e => Zotero.logError(e));
	}

	function shutdown() {
		// The batch loop stops before its next item; its pref already lists what is left
		if (currentBatch) Object.assign(currentBatch, { cancelled: true, shutdown: true });
		for (let id of menuIDs) Zotero.MenuManager.unregisterMenu(id);
		menuIDs = [];
		if (paneID) Zotero.ItemPaneManager.unregisterSection(paneID);
		paneID = null;
		if (notifierID) Zotero.Notifier.unregisterObserver(notifierID);
		notifierID = null;
		if (autoSyncTimer) clearTimeout(autoSyncTimer);
		autoSyncTimer = null;
		autoSyncQueue.clear();
		archiveQueue.clear();
		ZB.bibliography.shutdown();
	}

	ZB.main = { init, shutdown, run, runSynthesis, archiveItems, cancelBatch, resumeBatch, discardBatch, readPendingBatch, renderPane, testNotion, readSettings, readAINote, usageReport, resetUsage, runtime };
})(this);
