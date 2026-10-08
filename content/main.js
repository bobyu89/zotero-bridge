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
				}, (url, init) => fetch(url, init), Object.assign({ onRetry: retryStatus(ctx.status) }, ctx.retry));
				recordAIUsage(result, ctx.usage);
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
			usage: { ledger: {} },
			retry: runtime.retry,
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
			let usageLine = runUsageLine(ctx.usage);
			if (usageLine) pw.addDescription(usageLine);
			pw.startCloseTimer(failures.length ? 15000 : 5000);
		}
		else if (failures.length) {
			notify("Zotero Bridge 自動同步失敗", failures.slice(0, 3).join("\n"));
		}
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
					for (let [i, src] of sources.entries()) {
						let route = ZB.core.resolveRoute(src.data, settings.rules, settings.defaults);
						let target = await resolveObsidianPath(settings, ZB.core.splitFolder(route.obsidianFolder),
							ZB.core.noteBasename(src.data, settings.filenameFormat), src.data);
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
			menus: [{
				menuType: "menuitem",
				l10nID: "zotero-bridge-menu-settings",
				onCommand: () => Zotero.Utilities.Internal.openPreferences("zotero-bridge-prefs"),
			}],
		});
		menuIDs = [itemMenu, collectionMenu, toolsMenu].filter(Boolean);
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
		let { md, model, at } = readAINote(note.getNote());
		let summary = ZB.markdown.plainText(ZB.llm.extractSummary(md));
		setSectionSummary(summary.slice(0, 80));
		if (model || at) body.append(el("div", [model, at && at.slice(0, 10)].filter(Boolean).join(" · "), "font-size: 0.9em; color: var(--fill-secondary); margin-bottom: 4px;"));
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
		// Move secrets from plain prefs (earlier versions) into the login manager; readers wait for it
		ZB.secrets.migrateFromPrefs().then((names) => {
			if (names.length) Zotero.debug(`Zotero Bridge: moved ${names.join(", ")} from prefs to the login manager`);
		}).catch(e => Zotero.logError(e));
		registerMenus();
		registerItemPane();
		registerNotifier();
	}

	function shutdown() {
		for (let id of menuIDs) Zotero.MenuManager.unregisterMenu(id);
		menuIDs = [];
		if (paneID) Zotero.ItemPaneManager.unregisterSection(paneID);
		paneID = null;
		if (notifierID) Zotero.Notifier.unregisterObserver(notifierID);
		notifierID = null;
		if (autoSyncTimer) clearTimeout(autoSyncTimer);
	}

	ZB.main = { init, shutdown, run, runSynthesis, renderPane, testNotion, readSettings, readAINote, usageReport, resetUsage, runtime };
})(this);
