/*
 * ZotMax — orchestration: settings, sync pipeline, menus (menus.js), auto-sync.
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

	/** A feature switch (features.js), checked live: turning a feature off needs no restart. */
	function featureOn(id) {
		return ZB.features.isEnabled(id);
	}

	/** A turned-off feature reached anyway (e.g. an old shortcut): say where to turn it on. */
	function notifyFeatureOff(id) {
		let f = ZB.features.get(id);
		notify("ZotMax", `「${f.label}」目前關閉。要使用的話：設定 → ZotMax → 功能，把它打開。`);
	}

	/** Where literature notes go (prefs only, no secrets): what the item pane needs to find a note. */
	function vaultSettings() {
		let vaultPath = String(pref("obsidian.vaultPath") || "").trim();
		return {
			vaultPath,
			vaultName: String(pref("obsidian.vaultName") || "").trim() || (vaultPath ? PathUtils.filename(vaultPath) : ""),
			filenameFormat: pref("obsidian.filenameFormat") || "citekey",
			createBase: pref("obsidian.createBase") !== false,
			includeNotes: pref("includeNotes") !== false,
			defaults: {
				obsidianFolder: pref("obsidian.folder") || "",
				notionDatabase: String(pref("notion.database") || "").trim(),
			},
			rules: ZB.core.parseRules(pref("routing.rules")),
		};
	}

	async function readSettings() {
		let provider = pref("llm.provider") === "openai" ? "openai" : "anthropic";
		let vault = vaultSettings();
		// Secrets live in the login manager (secrets.js), not in prefs
		let notionToken = await ZB.secrets.get("notionToken");
		let apiKey = await ZB.secrets.get(provider === "openai" ? "openaiKey" : "anthropicKey");
		return Object.assign(vault, {
			notionToken: String(notionToken || "").trim(),
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
				// Scanned PDFs (scanned.js): send the file itself, within these limits
				sendScannedPDF: pref("llm.sendScannedPDF") !== false,
				pdfMaxMB: Number(pref("llm.pdfMaxMB")) || 0,
				pdfMaxPages: Number(pref("llm.pdfMaxPages")) || 0,
				synthesisPrompt: pref("llm.synthesisPrompt") || "",
				// Message Batches API for runs with at least batchThreshold AI notes (ai-batch.js; Claude only)
				batchAPI: pref("llm.batchAPI") === true,
				batchThreshold: Math.max(2, Number(pref("llm.batchThreshold")) || 10),
			},
			notionSynthesisParent: String(pref("notion.synthesisParent") || "").trim(),
		});
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

	/**
	 * Save a change of our own (a reading-status tag) without auto-sync reacting to it. Zotero notifies
	 * observers before saveTx() resolves, so only that save is skipped, not the user's next edit.
	 */
	async function saveQuietly(item) {
		let had = selfModified.has(item.id);
		selfModified.add(item.id);
		try {
			await item.saveTx();
		}
		finally {
			if (!had) selfModified.delete(item.id);
		}
	}

	// ---------- AI usage ledger ----------

	function readPrices() {
		return ZB.usage.parsePrices(pref("usage.prices"));
	}

	function readLedger() {
		return ZB.usage.parseLedger(pref("usage.ledger"));
	}

	/** Add one LLM call to the monthly ledger pref and to the current run's totals (result.batch: Batches API). */
	function recordAIUsage(result, runTotals) {
		let call = { model: result.model, usage: result.usage, batch: !!result.batch };
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
		return `<h1>${AI_TITLE}</h1>\n<p><em>由 ${model} 於 ${at} 產生（ZotMax）</em></p>\n`
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
		let check = ZB.verify.verifyQuotes(parsed.md.trim(), ZB.scanned.quoteSources(data, texts));
		let summary = ZB.verify.summarize(check);
		if (summary) messages.push(summary);
		return { md: check.md, data: parsed.data, raw: parsed.found && !parsed.data ? parsed.raw : "", messages, check };
	}

	/** The user's Zotero notes as Markdown, when they are part of the sync. */
	function notesFor(settings, data) {
		return settings.includeNotes
			? data.notes.map(n => ({ title: n.title, md: ZB.markdown.htmlToMd(n.html, parseHTML) }))
			: [];
	}

	/** Options for llm.generateNote / llm.noteRequestBody (the normal and the batch path send the same). */
	function noteOptions(settings, data, notesMarkdown, promptImages, pdf) {
		return {
			systemPrompt: settings.llm.systemPrompt,
			notesMarkdown,
			fullTextTruncated: data.fullTextTruncated,
			images: pdf ? [] : promptImages,
			pdf,
			// 「AI 標重點」: the key sentences come in the same call (no extra request)
			aiHighlights: featureOn("aiHighlights"),
		};
	}

	/**
	 * 「全文筆記」 on: the item's text as Markdown (fulltext.js). With `llm` (this sync sends full text
	 * to the AI), data.fullText becomes the trimmed Markdown. Never throws; null when off or no text.
	 */
	async function prepareFullText(data, llm, messages) {
		if (!featureOn("fullTextMarkdown")) return null;
		try {
			return await ZB.fulltext.prepare(data, llm, messages);
		}
		catch (e) {
			Zotero.logError(e);
			if (messages) messages.push(`⚠️ 全文 Markdown：${e.message || e}`);
			return null;
		}
	}

	/** Save a processed AI note as the item's child note (without auto-sync reacting to it). */
	async function saveGeneratedNote(item, ai, processed) {
		// Saving a child note also reports a change of the item itself, and Zotero notifies
		// before saveTx() returns: mark the item first (the notes are checked again at flush time)
		markSelfModified(item.id);
		let saved = await ZB.adapter.saveAINote(item, aiNoteHTML(ai.md, ai.model, ai.at, processed.data, processed.raw));
		markSelfModified(saved.note.id);
		return saved;
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
			// Always judged, for the frontmatter full_text and the Notion "Full Text" column
			checkFullText: true,
		});
		let notesMarkdown = notesFor(settings, data);

		// A failing step doesn't stop the others; errors are reported together at the end
		let errors = [];
		let messages = [];
		let quoteCheck = null;
		let ai = null;
		// The full text as Markdown: the AI reads it (References and the like cut) and it becomes the full-text note
		let fullText = await prepareFullText(data, needAI ? settings.llm : null, messages);
		// PNGs of image/ink annotations, when this sync uses them (annotation-images.js)
		let images = await ZB.images.collect(data, { targets: action.targets, ai: needAI }, ctx, messages);
		// Scanned PDF: send the file itself; nothing at all to read: no AI call (scanned.js)
		let aiInput = null;
		if (needAI) {
			aiInput = await ZB.scanned.prepareAIInput(data, settings.llm, notesMarkdown, IOUtils);
			messages.push(...aiInput.messages);
			if (aiInput.skip) needAI = false;
		}
		if (needAI) {
			ctx.status("AI 產生筆記中…");
			try {
				// When the PDF itself is sent the AI sees the figures on its pages, so the annotation
				// images are only added if it has to fall back to text
				let promptImages = await ZB.images.forPrompt(images, settings.llm, ctx, messages);
				let result = await ZB.scanned.generateWithPDF(aiInput, data, notesMarkdown, pdf => ZB.llm.generateNote(settings.llm, data,
					noteOptions(settings, data, notesMarkdown, promptImages, pdf),
					(url, init) => fetch(url, init), Object.assign({ onRetry: retryStatus(ctx.status) }, ctx.retry)), messages);
				recordAIUsage(result, ctx.usage);
				let at = nowISO();
				let processed = processGeneratedNote(result.text.trim(), data);
				messages.push(...processed.messages);
				quoteCheck = processed.check;
				ai = { md: processed.md, model: result.model || settings.llm.model, at, data: processed.data };
				await saveGeneratedNote(item, ai, processed);
			}
			catch (e) {
				errors.push(`AI 筆記：${e.message || e}`);
			}
		}
		if (!ai && data.aiNote && action.ai !== "none") {
			ai = readAINote(data.aiNote.html);
			if (ai.dataError) messages.push(`⚠️ AI 子筆記的結構化資料無法讀取：${ai.dataError}`);
		}

		// 文獻評讀表 (appraisal-form.js): the saved form, else the AI note's appraisal as an unverified prefill
		let appraisal = null;
		try {
			appraisal = ZB.appraisalForm.syncInfo(data, ai);
		}
		catch (e) {
			messages.push(`⚠️ 文獻評讀表無法讀取：${e.message || e}`);
		}

		// 「AI 標重點」: only the AI's key sentences that really are in the text
		let aiHighlights = [];
		if (ai && ai.data && ai.data.highlights && featureOn("aiHighlights")) {
			aiHighlights = ZB.fulltext.verifyAIHighlights(ai.data.highlights, fullText, data);
			let dropped = ai.data.highlights.length - aiHighlights.length;
			if (dropped && needAI) messages.push(`AI 標的重點 ${ai.data.highlights.length} 句，${dropped} 句在全文中找不到，已刪除`);
		}
		let ftOptions = fullText ? ZB.fulltext.options() : null;
		let rendered = null;
		if (fullText) {
			try {
				rendered = ZB.fulltext.render(fullText, data, { colorMeanings: ftOptions.colorMeanings, aiHighlights });
			}
			catch (e) {
				Zotero.logError(e);
				messages.push(`⚠️ 全文劃線標記：${e.message || e}`);
			}
		}
		let fullTextInfo = rendered ? Object.assign({ rendered, engine: fullText.sources[0].engine }, ftOptions) : null;

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
		// Reading status merged across Zotero, Notion and Obsidian before anything is written (status.js)
		let status = await ZB.status.prepare(item, data, { settings, action, route, obsidian, ctx, messages });

		let notionUrl = null;
		if (action.targets.has("notion")) {
			ctx.status("同步到 Notion…");
			try {
				if (!route.notionDatabase) throw new Error(`沒有對應的資料庫（規則：${route.ruleName || "預設"}）`);
				notionUrl = await syncNotion(ctx.notion(settings.notionToken), route.notionDatabase, data, {
					ai, notesMarkdown, obsidianURI: obsidian && obsidian.uri, messages, images, status, appraisal, aiHighlights, fullText: fullTextInfo,
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
				await writeObsidian(obsidian, noteData, { ai, notesMarkdown, notionUrl, status, appraisal, aiHighlights, fullText: fullTextInfo, settings, messages });
				if (ctx.obsidianIndex) ctx.obsidianIndex.add(`${data.libraryPath}/${data.key}`, obsidian.path, obsidian.relParts);
			}
			catch (e) {
				errors.push(`Obsidian：${e.message || e}`);
			}
		}
		if (errors.length) throw new Error([...errors, ...messages].join("；"));
		return {
			route, notionUrl, obsidianPath: obsidian && obsidian.relPath, generated: !!ai && needAI, messages, quoteCheck,
			fullTextStats: needAI && fullText ? fullText.stats : null,
		};
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
					Zotero.debug(`ZotMax: skipped ${child}: ${e}`);
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
				Zotero.debug(`ZotMax: renamed ${entry.path} → ${to}`);
			}
			entry.path = to;
			entry.relParts = [...entry.relParts.slice(0, -1), name + ".md"];
			return name;
		}
		return null;
	}

	/** The vault path in a note's `fulltext: "[[…]]"` frontmatter ("" when none). */
	function fullTextLinkOf(text) {
		let fm = ZB.core.splitFrontmatter(text).frontmatter || "";
		let m = /^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/.exec(ZB.core.frontmatterScalar(fm, "fulltext"));
		return m ? m[1].trim() : "";
	}

	// ---------- the item pane's links to the synced notes ----------

	// What syncs in this session wrote, per item ("libraryID/KEY"): { at, obsidianPath, notionUrl }
	let syncedThisSession = new Map();

	/**
	 * Links for the item pane's ZotMax panel (sidepanel.js): the literature note in Obsidian, its
	 * full-text note, the Notion page and when the item was last synced. Read from the note's
	 * frontmatter at its usual place (or where a sync in this session wrote it); a Notion page synced
	 * without a vault is known only after a sync in this session. Never throws, never goes online.
	 * Resolves to { obsidian, fullText, notion, lastSynced, vault (a vault is set), found (a note exists) }.
	 */
	async function noteLinks(item) {
		let out = { obsidian: "", fullText: "", notion: "", lastSynced: "", vault: false, found: false };
		let session = item ? syncedThisSession.get(itemRef(item)) : null;
		if (session) {
			out.notion = session.notionUrl || "";
			out.lastSynced = session.at || "";
		}
		try {
			let settings = vaultSettings();
			if (!item || !settings.vaultPath) return out;
			out.vault = true;
			let data = ZB.adapter.paneData(item);
			let target;
			if (session && session.obsidianPath) {
				let parts = session.obsidianPath.split("/");
				target = obsidianTarget(settings, parts.slice(0, -1), parts[parts.length - 1].replace(/\.md$/i, ""));
			}
			else {
				let route = ZB.core.resolveRoute(data, settings.rules, settings.defaults);
				target = await resolveObsidianPath(settings, ZB.core.splitFolder(route.obsidianFolder), ZB.core.noteBasename(data, settings.filenameFormat), data);
			}
			if ((await noteOwner(target.path)) !== `${data.libraryPath}/${data.key}`) return out;
			let text = await IOUtils.readUTF8(target.path);
			let fm = ZB.core.splitFrontmatter(text).frontmatter || "";
			out.found = true;
			out.obsidian = target.uri;
			out.lastSynced = ZB.core.frontmatterScalar(fm, "last_synced") || out.lastSynced;
			let notion = /^notion:\s*"?([^"\n]+)"?\s*$/m.exec(fm);
			if (notion) out.notion = notion[1].trim();
			let link = fullTextLinkOf(text);
			if (link && settings.vaultName && await IOUtils.exists(PathUtils.join(settings.vaultPath, ...link.split("/").filter(Boolean)) + ".md")) {
				out.fullText = ZB.core.obsidianURI(settings.vaultName, link);
			}
		}
		catch (e) {
			Zotero.debug(`ZotMax: item pane could not read the literature note: ${e}`);
		}
		return out;
	}

	/**
	 * Where the item's literature note is, for writes outside a sync (讀懂統計's 「存到筆記」): the same
	 * lookup as noteLinks. Resolves to { path, relPath } when the note exists and belongs to the item,
	 * else null. Never goes online.
	 */
	async function literatureNote(item) {
		let settings = vaultSettings();
		if (!item || !settings.vaultPath) return null;
		let data = ZB.adapter.paneData(item);
		let session = syncedThisSession.get(itemRef(item));
		let target;
		if (session && session.obsidianPath) {
			let parts = session.obsidianPath.split("/");
			target = obsidianTarget(settings, parts.slice(0, -1), parts[parts.length - 1].replace(/\.md$/i, ""));
		}
		else {
			let route = ZB.core.resolveRoute(data, settings.rules, settings.defaults);
			target = await resolveObsidianPath(settings, ZB.core.splitFolder(route.obsidianFolder), ZB.core.noteBasename(data, settings.filenameFormat), data,
				{ index: obsidianIndexCache(settings) });
		}
		if ((await noteOwner(target.path)) !== `${data.libraryPath}/${data.key}`) return null;
		return { path: target.path, relPath: target.relPath };
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
		// The full-text note (fulltext.js) next to this one; its link goes into the note
		let previousLink = existing ? fullTextLinkOf(existing) : "";
		let fullTextLink = "";
		if (opts.fullText) {
			try {
				fullTextLink = await ZB.fulltext.writeObsidian(obsidian, data, opts.fullText.rendered, {
					folder: opts.fullText.folder, engine: opts.fullText.engine, previousLink, vaultPath: opts.settings && opts.settings.vaultPath,
				});
			}
			catch (e) {
				Zotero.logError(e);
				if (opts.messages) opts.messages.push(`⚠️ 全文筆記：${e.message || e}`);
			}
		}
		// No text this time (e.g. the PDF isn't on this computer): keep the link to the existing full-text note
		if (!fullTextLink && previousLink && featureOn("fullTextMarkdown") && opts.settings
				&& await IOUtils.exists(PathUtils.join(opts.settings.vaultPath, ...previousLink.split("/").filter(Boolean)) + ".md")) {
			fullTextLink = previousLink;
		}
		let text = ZB.core.buildObsidianNote(existing, data, {
			aiMarkdown: opts.ai && opts.ai.md,
			aiModel: opts.ai && opts.ai.model,
			aiGeneratedAt: opts.ai && opts.ai.at,
			study: opts.ai && opts.ai.data,
			fullTextTruncated: data.fullTextTruncated,
			notesMarkdown: opts.notesMarkdown,
			notionUrl,
			// 「🔎 延伸搜尋」 links (search-links.js)
			searchCallout: ZB.searchLinks.calloutFor(data, opts.ai && opts.ai.data),
			appraisalMarkdown: opts.appraisal && opts.appraisal.markdown,
			appraisal: opts.appraisal && opts.appraisal.values,
			colorMeanings: pref("annotations.colorMeanings") || "",
			aiHighlights: opts.aiHighlights,
			fullTextLink,
			now: nowISO(),
		});
		text = ZB.status.applyPlanToNote(text, opts.status);
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
			if (opts.messages) opts.messages.push("Notion 資料庫還沒有研讀欄位（研究設計／Study Design 等）：到 設定 → ZotMax 按「測試連線並補齊資料庫欄位」即可加上");
		}
		if (opts.appraisal && !schema.props["Appraisal Verified"] && !ctx.schemaHints.has(dsId + "/appraisal")) {
			ctx.schemaHints.add(dsId + "/appraisal");
			if (opts.messages) opts.messages.push("Notion 資料庫還沒有「評讀已核對」（Appraisal Verified）欄位：到 設定 → ZotMax 按「測試連線並補齊資料庫欄位」即可加上");
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
			fullText: data.fullTextStatus,
			study,
			apa: data.apa,
			status: ZB.status.notionValue(opts.status),
			appraisal: opts.appraisal && opts.appraisal.values,
			lastSynced: nowISO(),
		});
		// The page status.js already looked up while merging the reading status
		let page = opts.status && opts.status.notionPage !== undefined
			? opts.status.notionPage
			: await client.findPageByZoteroKey(dsId, zoteroKey);
		if (page) {
			page = await client.request("PATCH", `pages/${page.id}`, { properties });
		}
		else {
			page = await client.request("POST", "pages", {
				parent: { type: "data_source_id", data_source_id: dsId },
				properties,
			});
		}
		ZB.status.notionWritten(opts.status);
		// Image annotations are uploaded just before the blocks that show them are written
		let uploaded = await ZB.images.uploadToNotion(client, data, opts.images, ctx, opts.messages || []);
		// 「重點」 open at the top of the container, every other part a folded toggle (DESIGN.md "Literature note")
		let notionPage = !!(opts.fullText && opts.fullText.notionPage);
		let { keyPoints, sections } = ZB.core.buildNoteSections(uploaded.data, {
			aiMarkdown: opts.ai && opts.ai.md,
			aiModel: opts.ai && opts.ai.model,
			aiGeneratedAt: opts.ai && opts.ai.at,
			study,
			notesMarkdown: opts.notesMarkdown,
			searchCallout: ZB.searchLinks.calloutFor(data, study),
			appraisalMarkdown: opts.appraisal && opts.appraisal.notionMarkdown,
			appraisal: opts.appraisal && opts.appraisal.values,
			colorMeanings: pref("annotations.colorMeanings") || "",
			aiHighlights: opts.aiHighlights,
			target: "notion",
			fullTextNote: notionPage,
		});
		let toggles = sections.map(sec => ({
			title: sec.title,
			color: sec.color || "default",
			children: ZB.markdown.mdToNotionBlocks(sec.md, { images: uploaded.ids }),
		}));
		let { containerId, sectionIds } = await client.replaceManagedSections(page.id, "自動同步區（重新同步會覆寫，個人筆記請寫在此區塊外）",
			ZB.markdown.mdToNotionBlocks(keyPoints), toggles);
		// The form's table as a real Notion table, inside the 文獻評讀表 toggle (it can't go in with the toggle's children)
		if (opts.appraisal) {
			let at = sections.findIndex(sec => sec.id === "appraisal");
			await ZB.appraisalForm.insertNotionTable(client, at >= 0 && sectionIds[at] ? sectionIds[at] : containerId, opts.appraisal, opts.messages);
		}
		// 「全文筆記」 with the Notion option: the full text as a child page (fulltext.js; never fails the sync)
		if (notionPage) await ZB.fulltext.writeNotion(client, page.id, data, opts.fullText.rendered, opts.messages);
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

	/**
	 * Add items to the stop/resume list as failed, so 「繼續未完成的同步」 retries them (ai-batch.js:
	 * batch requests that errored, expired or were canceled). An existing record with another action
	 * is kept: targets are merged, and differing AI actions become "missing" (never a surprise regenerate).
	 */
	function addPendingFailures(refs, action) {
		if (!refs.length) return readPendingBatch();
		let targets = [...new Set(action.targets)];
		let batch = readPendingBatch() || { action: { targets, ai: action.ai }, remaining: [], failed: [], total: 0, running: false, startedAt: nowISO() };
		batch.action = {
			targets: [...new Set([...batch.action.targets, ...targets])],
			ai: batch.action.ai === action.ai ? action.ai : "missing",
		};
		for (let ref of refs) {
			if (batch.remaining.includes(ref) || batch.failed.includes(ref)) continue;
			batch.failed.push(ref);
			batch.total = (batch.total || 0) + 1;
		}
		writePendingBatch(batch);
		return batch;
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
			notify("ZotMax", "沒有未完成的同步。");
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
			notify("ZotMax", "未完成的文獻都已刪除，已清除這筆紀錄。");
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
		// The item pane's panel shows the new links and sync time (sidepanel.js)
		p.then(refreshPanel, refreshPanel);
		return p;
	}

	function refreshPanel() {
		try {
			if (ZB.sidepanel) ZB.sidepanel.refreshAll();
		}
		catch (e) {
			Zotero.logError(e);
		}
	}

	async function runNow(items, action) {
		items = ZB.adapter.toRegularItems(items);
		if (!items.length) return;
		// 「同步到 Obsidian／Notion」 off: nothing is written or sent anywhere
		if (!featureOn("sync")) {
			if (!action.silent) notifyFeatureOff("sync");
			return;
		}
		let settings;
		try {
			settings = await readSettings();
		}
		catch (e) {
			notify("ZotMax 設定有誤", String(e.message || e));
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
			if (!action.silent) notify("ZotMax", `請先到 設定 → ZotMax 填入：${missing.join("、")}`);
			return;
		}

		let willGenerate = settings.llm.enabled && (action.ai === "regenerate"
			|| (action.ai === "missing" && items.some(i => !ZB.adapter.getAINote(i))));
		if (willGenerate && !settings.llm.apiKey) {
			notify("ZotMax", "AI 筆記需要 API key：請到 設定 → ZotMax 填入，或改用「不呼叫 AI」同步。");
			return;
		}
		// Many AI notes with 「使用批次 API」 on: the user picks the Message Batches API or the normal path;
		// the batched items are synced when the batch has ended (ai-batch.js), the others below
		if (willGenerate && ZB.aiBatch.applies(aiItemCount(items, action), action, settings)) {
			let choice = confirmBatchMode(items, action, settings);
			if (!choice) return;
			if (choice === "batch") {
				items = await ZB.aiBatch.submit(items, action, settings);
				if (!items.length) return;
			}
		}
		else if (willGenerate && items.length > 5 && !action.silent) {
			let ok = Services.prompt.confirm(Zotero.getMainWindow(), "ZotMax",
				`即將為最多 ${items.length} 筆文獻呼叫 ${settings.llm.provider === "openai" ? "OpenAI" : "Claude"}（${settings.llm.model}）產生 AI 筆記，會產生 API 費用。`
				+ batchEstimate(items, action, settings) + "要繼續嗎？");
			if (!ok) return;
		}

		let pw = action.silent ? null : new Zotero.ProgressWindow({ closeOnClick: true });
		if (pw) {
			pw.changeHeadline(action.resumed ? "ZotMax：繼續未完成的同步" : "ZotMax");
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
			if (pw) pw.addDescription("要中途停止：工具 → 停止 ZotMax 同步（處理中的這篇完成後停止）");
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
				if (!clients.has(token)) clients.set(token, notionClient(token));
				return clients.get(token);
			},
			status: () => {},
			usage: { ledger: {} },
			retry: runtime.retry,
		};
		let ok = 0;
		let failures = [];
		let quotes = { total: 0, verified: 0, notFound: 0, unchecked: 0 };
		// Full text sent to the AI as trimmed Markdown (fulltext.js): characters before and after
		let trimmed = { items: 0, raw: 0, sent: 0, cut: [] };
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
				let known = syncedThisSession.get(itemRef(item)) || {};
				syncedThisSession.set(itemRef(item), {
					at: nowISO(),
					obsidianPath: result.obsidianPath || known.obsidianPath || "",
					notionUrl: result.notionUrl || known.notionUrl || "",
				});
				if (result.quoteCheck) {
					for (let k of Object.keys(quotes)) quotes[k] += result.quoteCheck[k];
				}
				if (result.fullTextStats) {
					trimmed.items++;
					trimmed.raw += result.fullTextStats.raw;
					trimmed.sent += result.fullTextStats.sent;
					trimmed.cut.push(...result.fullTextStats.cut);
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
				pw.addDescription(`要接續：工具 → 繼續未完成的 ZotMax 同步（${pendingCount(batch)} 筆${batch.failed.length ? `，含失敗 ${batch.failed.length} 筆` : ""}）`);
			}
			let trimLine = fullTextLine(trimmed);
			if (trimLine) pw.addDescription(trimLine);
			let usageLine = runUsageLine(ctx.usage);
			if (usageLine) pw.addDescription(usageLine);
			pw.startCloseTimer(failures.length || cancelled ? 15000 : 5000);
		}
		else if (failures.length) {
			notify("ZotMax 自動同步失敗", failures.slice(0, 3).join("\n"));
		}
		// 「同步時自動更新參考文獻檔」 (export.js); never throws
		if (ok) await ZB.bibliography.afterSync(settings);
		// 概念卡片 after manual runs (concepts.js), before the dashboard lists them; must never fail the sync
		if (ok && !action.silent) {
			try {
				await ZB.concepts.afterSync(settings);
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
		// 研究儀表板 after manual runs (dashboard.js); must never fail the sync
		if (ok && !action.silent) {
			try {
				await ZB.dashboard.afterSync(settings);
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
	}

	/** 「全文：送出 38,900 字（原本 52,300 字，省下 26%：References、Funding）」, or "" when nothing was trimmed. */
	function fullTextLine(t) {
		if (!t || !t.items || t.raw <= t.sent) return "";
		let fmt = n => Number(n).toLocaleString("en-US");
		let saved = Math.round((1 - t.sent / t.raw) * 100);
		let cut = ZB.fulltextMd.describeCut(t.cut);
		return `全文整理成 Markdown 後送給 AI：${fmt(t.sent)} 字（原本 ${fmt(t.raw)} 字，省下 ${saved}%${cut ? `，略過 ${cut}` : ""}）`;
	}

	/** How many of the items this run would generate an AI note for. */
	function aiItemCount(items, action) {
		return action.ai === "regenerate" ? items.length : items.filter(i => !ZB.adapter.getAINote(i)).length;
	}

	/**
	 * Rough cost for the confirm dialog, from the ledger's average tokens per call ("" when unknown).
	 * withBatch: the normal and the Message Batches estimate side by side.
	 */
	function batchEstimate(items, action, settings, withBatch = false) {
		try {
			let n = aiItemCount(items, action);
			let { prices } = readPrices();
			let est = ZB.usage.estimateCost(readLedger(), settings.llm.model, prices, n);
			if (!est) return withBatch ? "\n\n" : "";
			if (withBatch) {
				let batch = ZB.usage.estimateCost(readLedger(), settings.llm.model, prices, n, true);
				return `\n\n預估費用：一般模式約 ${ZB.usage.formatUSD(est.total)}；批次 API 約 ${ZB.usage.formatUSD(batch.total)}`
					+ `（${n} 筆，依過去 ${est.samples} 次呼叫的平均用量估算；實際費用依全文長度與快取命中而定）。\n\n`;
			}
			return `\n\n預估費用：約 ${ZB.usage.formatUSD(est.total)}（${n} 筆 × 每筆約 ${ZB.usage.formatUSD(est.perCall)}，`
				+ `依過去 ${est.samples} 次呼叫的平均用量估算；實際費用依全文長度而定）。\n\n`;
		}
		catch (e) {
			Zotero.logError(e);
			return withBatch ? "\n\n" : "";
		}
	}

	/** Confirm a large AI run with 「使用批次 API」 on: "batch", "normal" or null (cancelled). */
	function confirmBatchMode(items, action, settings) {
		let p = Services.prompt;
		let n = aiItemCount(items, action);
		let text = `即將為 ${n} 筆文獻呼叫 Claude（${settings.llm.model}）產生 AI 筆記，會產生 API 費用。\n\n`
			+ "批次 API 約半價（通常 1 小時內完成，最長 24 小時）；完成後自動寫入 AI 筆記並同步到 Notion／Obsidian，"
			+ "期間可從 工具 → 檢查 AI 批次進度 查看。一般模式立即逐篇產生。"
			+ batchEstimate(items, action, settings, true) + "要用哪一種方式？";
		// Cancel at button 1: closing the dialog also returns 1
		let flags = p.BUTTON_POS_0 * p.BUTTON_TITLE_IS_STRING + p.BUTTON_POS_1 * p.BUTTON_TITLE_CANCEL
			+ p.BUTTON_POS_2 * p.BUTTON_TITLE_IS_STRING + p.BUTTON_POS_0_DEFAULT;
		let button = p.confirmEx(Zotero.getMainWindow(), "ZotMax", text, flags,
			"批次 API（約半價）", null, "一般模式（立即產生）", null, {});
		return button === 0 ? "batch" : button === 2 ? "normal" : null;
	}

	/** Run `fn` after any sync in progress, like run() (status.js uses it for the status-only pass). */
	function enqueue(fn) {
		let p = running.then(fn);
		running = p.catch(() => {});
		return p;
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
			notify("ZotMax：刪除的文獻同步失敗", errors.slice(0, 3).join("\n"));
		}
		return counts;
	}

	async function trashNotionPages(settings, keys, errors) {
		let client = notionClient(settings.notionToken);
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
		if (!featureOn("synthesis")) {
			notifyFeatureOff("synthesis");
			return;
		}
		items = ZB.adapter.toRegularItems(items);
		if (items.length < 2) {
			notify("ZotMax", "文獻比較表至少需要 2 篇文獻。");
			return;
		}
		let settings;
		try {
			settings = await readSettings();
		}
		catch (e) {
			notify("ZotMax 設定有誤", String(e.message || e));
			return;
		}
		if (!settings.llm.apiKey) {
			notify("ZotMax", "文獻比較表需要 LLM API key：請到 設定 → ZotMax 填入。");
			return;
		}
		let extra = items.length > MAX_SYNTHESIS_ITEMS ? `（超過 ${MAX_SYNTHESIS_ITEMS} 篇，只會使用前 ${MAX_SYNTHESIS_ITEMS} 篇）` : "";
		items = items.slice(0, MAX_SYNTHESIS_ITEMS);
		let ok = Services.prompt.confirm(Zotero.getMainWindow(), "ZotMax",
			`將用 ${settings.llm.model} 比較 ${items.length} 篇文獻並產生文獻比較表${extra}，會產生一次 API 費用。要繼續嗎？`);
		if (!ok) return;

		let pw = new Zotero.ProgressWindow({ closeOnClick: true });
		pw.changeHeadline("ZotMax：文獻比較表");
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
				note.setNote(`<h1>📊 ${escapeHTML(title)}</h1>\n<p><em>由 ${escapeHTML(model)} 於 ${generatedAt} 產生（ZotMax）</em></p>\n`
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

	// ---------- Notion: clients, column IDs, 「把 Notion 欄位改成中文」 ----------

	const PROPERTY_IDS_PREF = "notion.propertyIds";

	function readPropertyIds() {
		try {
			let all = JSON.parse(pref(PROPERTY_IDS_PREF) || "{}");
			return all && typeof all === "object" && !Array.isArray(all) ? all : {};
		}
		catch (e) {
			return {};
		}
	}

	/** Column IDs per data source in a pref (notion.js resolves columns by them first); written only on change. */
	const propertyIdStore = {
		get: dsId => readPropertyIds()[dsId] || {},
		set: (dsId, ids) => {
			let all = readPropertyIds();
			let sorted = o => JSON.stringify(Object.keys(o || {}).sort().map(k => [k, o[k]]));
			if (sorted(all[dsId]) === sorted(ids)) return;
			all[dsId] = ids;
			Zotero.Prefs.set(PREF + PROPERTY_IDS_PREF, JSON.stringify(all), true);
		},
	};

	function notionClient(token) {
		return new ZB.notion.NotionClient({ token, fetch: (u, i) => fetch(u, i), propertyIds: propertyIdStore });
	}

	/** The configured databases: Map input → label. */
	function notionTargets(settings) {
		let targets = new Map();
		if (settings.defaults.notionDatabase) targets.set(settings.defaults.notionDatabase, "預設");
		for (let rule of settings.rules) {
			if (rule.notionDatabase && !targets.has(rule.notionDatabase)) targets.set(rule.notionDatabase, rule.name || "規則");
		}
		return targets;
	}

	/**
	 * Settings pane 「把 Notion 欄位改成中文」: show every database's renames first, then (after the user
	 * confirms) rename the columns by property ID. The IDs are recorded, so syncs keep finding them.
	 * Returns report lines.
	 */
	async function renameNotionColumns(win) {
		let settings = await readSettings();
		if (!settings.notionToken) throw new Error("請先填入 Notion integration token");
		let targets = notionTargets(settings);
		if (!targets.size) throw new Error("請先填入至少一個 Notion database 連結");
		let client = notionClient(settings.notionToken);
		let plans = [];
		let lines = [];
		for (let [db, label] of targets) {
			try {
				let dsId = await client.resolveDataSourceId(db);
				let plan = ZB.notion.renamePlan(await client.getSchema(dsId));
				plans.push({ dsId, label, plan });
				if (!plan.length) lines.push(`✅ ${label}：欄位已經是中文`);
				for (let skip of plan.skipped) lines.push(`⚠️ ${label}：「${skip.from}」沒有改名（已經有叫「${skip.to}」的欄位）`);
			}
			catch (e) {
				lines.push(`❌ ${label}：${e.message || e}`);
			}
		}
		let todo = plans.filter(p => p.plan.length);
		if (!todo.length) return lines;
		let text = "以下 Notion 欄位會改成中文名稱（只改名字，欄位裡的資料不變；之後同步照常寫入）：\n\n"
			+ todo.map(p => `${p.label}\n` + p.plan.map(step => `  ${step.from} → ${step.to}`).join("\n")).join("\n\n")
			+ "\n\n如果你在 Notion 的公式、篩選或其他整合用到這些欄位名稱，也要跟著改。要改名嗎？";
		if (!Services.prompt.confirm(win || Zotero.getMainWindow(), "把 Notion 欄位改成中文", text)) {
			return [...lines, "已取消，沒有改任何欄位。"];
		}
		for (let p of todo) {
			try {
				await client.renameProperties(p.dsId, p.plan);
				lines.push(`✅ ${p.label}：已改名 ${p.plan.length} 個欄位（${p.plan.map(step => step.to).join("、")}）`);
			}
			catch (e) {
				lines.push(`❌ ${p.label}：${e.message || e}`);
			}
		}
		return lines;
	}

	/** Check the token and every configured database; add missing columns. Returns report lines. */
	async function testNotion() {
		let settings = await readSettings();
		if (!settings.notionToken) throw new Error("請先填入 Notion integration token");
		let client = notionClient(settings.notionToken);
		let targets = notionTargets(settings);
		if (!targets.size) throw new Error("請先填入至少一個 Notion database 連結");
		let lines = [];
		for (let [db, label] of targets) {
			try {
				let dsId = await client.resolveDataSourceId(db);
				let added = await client.ensureSchema(dsId);
				lines.push(`✅ ${label}：連線成功${added.length ? `，已新增欄位 ${added.join("、")}` : "，欄位齊全"}`);
			}
			catch (e) {
				lines.push(`❌ ${label}：${e.message || e}`);
			}
		}
		return lines;
	}

	// ---------- menus ----------

	/**
	 * The right-click and Tools menus come from the command catalog (commands.js, menus.js); the
	 * toolbar button (toolbar.js) and 快速指令 (palette.js) from the same catalog.
	 */
	function registerMenus() {
		let icon = rootURI + "content/icons/bridge.svg";
		menuIDs = ZB.menus.register({ pluginID, icon });
	}

	/**
	 * The sync batch for the menus: running (stoppable), active (a batch runs, cancelled or not),
	 * pending (the stopped or interrupted batch record) and count (items it has left).
	 */
	function batchStatus() {
		let pending = readPendingBatch();
		return {
			running: !!currentBatch && !currentBatch.cancelled,
			active: !!currentBatch,
			pending,
			count: pendingCount(pending),
		};
	}

	// ---------- item pane: the ZotMax panel (sidepanel.js) ----------

	/** The panel's render hook, kept here for callers of ZB.main.renderPane (the e2e harness). */
	function renderPane(props) {
		return ZB.sidepanel.render(props);
	}

	// ---------- auto-sync ----------

	// Our own writes and the AI note backups never trigger a sync
	function wantsAutoSync(id) {
		return !selfModified.has(id) && !ZB.adapter.isAIHistoryNote(Zotero.Items.get(id));
	}

	function registerNotifier() {
		notifierID = Zotero.Notifier.registerObserver({
			notify: (event, type, ids, extraData) => {
				if (!pref("autoSync") || !featureOn("sync")) return;
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
		// Turned off while the timer ran: nothing goes out
		if (!featureOn("sync")) {
			archiveQueue.clear();
			autoSyncQueue.clear();
			return;
		}
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
		// Feature switches: once per profile, before anything reads them (features.js)
		try {
			let migrated = ZB.features.migrate();
			if (migrated) Zotero.debug(`ZotMax: feature switches set up (${migrated.preset}${migrated.evidence.length ? `; earlier use: ${migrated.evidence.join(", ")}` : ""})`);
		}
		catch (e) {
			Zotero.logError(e);
		}
		// Move secrets from plain prefs (earlier versions) into the login manager; readers wait for it
		ZB.secrets.migrateFromPrefs().then((names) => {
			if (names.length) Zotero.debug(`ZotMax: moved ${names.join(", ")} from prefs to the login manager`);
		}).catch(e => Zotero.logError(e));
		registerMenus();
		// The ZotMax panel in the item pane and the reader's side pane (sidepanel.js)
		ZB.sidepanel.init({ pluginID, rootURI, chrome: !!opts.chrome });
		ZB.sidepanel.register();
		registerNotifier();
		remindInterruptedBatch();
		// Automatic PubMed checks (off unless enabled in the settings)
		ZB.pubmedWatch.init();
		// Polling of AI batches submitted earlier (ai-batch.js)
		ZB.aiBatch.init();
		// 讀懂統計: the button in the PDF reader's text-selection popup (stats-explainer.js)
		ZB.statsExplainer.init({ pluginID });
	}

	// A batch still marked running at startup was cut off by Zotero quitting or crashing
	function remindInterruptedBatch() {
		let batch = readPendingBatch();
		if (!batch || !batch.running) return;
		batch.running = false;
		writePendingBatch(batch);
		(Zotero.uiReadyPromise || Promise.resolve()).then(() => {
			notify("ZotMax：上次的同步沒有完成",
				`還有 ${pendingCount(batch)} 筆文獻沒有同步。要接續：工具 → 繼續未完成的 ZotMax 同步。`);
		}).catch(e => Zotero.logError(e));
	}

	function shutdown() {
		// First: the PDF reader's listener (Zotero can still call it while the plugin is disabled)
		ZB.statsExplainer.shutdown();
		// The batch loop stops before its next item; its pref already lists what is left
		if (currentBatch) Object.assign(currentBatch, { cancelled: true, shutdown: true });
		for (let id of menuIDs) Zotero.MenuManager.unregisterMenu(id);
		menuIDs = [];
		ZB.sidepanel.shutdown();
		if (notifierID) Zotero.Notifier.unregisterObserver(notifierID);
		notifierID = null;
		if (autoSyncTimer) clearTimeout(autoSyncTimer);
		autoSyncTimer = null;
		autoSyncQueue.clear();
		archiveQueue.clear();
		ZB.bibliography.shutdown();
		ZB.pubmedWatch.shutdown();
		ZB.aiBatch.shutdown();
	}

	ZB.main = { init, shutdown, run, runSynthesis, archiveItems, cancelBatch, resumeBatch, discardBatch, readPendingBatch, batchStatus, renderPane, testNotion, readSettings, readAINote, usageReport, resetUsage, runtime,
		// Notion columns: clients that remember column IDs, and 「把 Notion 欄位改成中文」
		notionClient, renameNotionColumns,
		// for ai-batch.js: the full text as Markdown for the AI (fulltext.js)
		prepareFullText,
		// for status.js
		enqueue, notify, buildObsidianIndex, saveQuietly,
		// for sidepanel.js
		noteLinks, vaultSettings,
		// for stats-explainer.js (「存到筆記」)
		literatureNote,
		// for the modules whose features can be switched off (features.js)
		notifyFeatureOff,
		// for appraisal-form.js
		markSelfModified,
		// for review-draft.js
		recordAIUsage, runUsageLine, retryStatus,
		// for ai-batch.js
		notesFor, noteOptions, processGeneratedNote, saveGeneratedNote, addPendingFailures, itemRef };
})(this);
