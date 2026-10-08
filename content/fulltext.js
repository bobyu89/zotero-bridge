/*
 * Zotero Bridge — the full text as Markdown (feature fullTextMarkdown): conversion with a per-attachment
 * cache, optional markitdown, the plugin-managed full-text note in Obsidian (the user's highlights
 * coloured in place, verified AI quotes marked differently) and, when enabled, a Notion child page.
 * The text conversion itself is pure (fulltext-md.js); this file uses the Zotero globals.
 * A failing step never fails a sync: markitdown falls back to the built-in conversion, and the full
 * text is simply left out when it can't be produced.
 */
(function (root, factory) {
	const api = factory(root);
	if (typeof module === "object" && module.exports) {
		module.exports = api;
	}
	else {
		(root.ZB = root.ZB || {}).fulltext = api;
	}
})(this, function (root) {
	const PREF = "extensions.zotero-bridge.";
	const DEFAULT_FOLDER = "全文";
	// markitdown: give up after this long, or once stdout grows past this many characters
	const MARKITDOWN_TIMEOUT_MS = 120000;
	const MARKITDOWN_MAX_CHARS = 8 * 1024 * 1024;
	// Notion child page title; also how an earlier one is found on the literature page
	const NOTION_PAGE_PREFIX = "全文：";
	// Test hook: { subprocess } replaces Subprocess.sys.mjs
	const runtime = {};

	function ZB() {
		return root.ZB;
	}

	function pref(key) {
		return Zotero.Prefs.get(PREF + key, true);
	}

	/** The settings this module reads. */
	function options() {
		return {
			folder: ZB().core.sanitizeFilename(String(pref("fullText.folder") || "").trim() || DEFAULT_FOLDER),
			markitdownPath: String(pref("fullText.markitdownPath") || "").trim(),
			trimReferences: pref("llm.trimReferences") !== false,
			notionPage: pref("notion.fullTextPage") === true,
			colorMeanings: ZB().core.colorMeanings(pref("annotations.colorMeanings") || ""),
		};
	}

	// ---------- cache (one JSON file per attachment in the Zotero data directory) ----------

	function cacheDir() {
		try {
			let base = Zotero.DataDirectory && Zotero.DataDirectory.dir;
			return base ? PathUtils.join(base, "zotero-bridge", "fulltext") : null;
		}
		catch (e) {
			return null;
		}
	}

	function cacheFile(name) {
		let dir = cacheDir();
		return dir ? PathUtils.join(dir, name.replace(/[^\w.-]/g, "_") + ".json") : null;
	}

	async function readCache(name) {
		let file = cacheFile(name);
		if (!file) return null;
		try {
			if (!(await IOUtils.exists(file))) return null;
			return JSON.parse(await IOUtils.readUTF8(file));
		}
		catch (e) {
			return null;
		}
	}

	async function writeCache(name, record) {
		let file = cacheFile(name);
		if (!file) return;
		try {
			await IOUtils.makeDirectory(cacheDir(), { createAncestors: true, ignoreExisting: true });
			await IOUtils.writeUTF8(file, JSON.stringify(record));
		}
		catch (e) {
			Zotero.debug(`Zotero Bridge: could not write the full-text cache ${file}: ${e}`);
		}
	}

	async function fileStamp(path) {
		if (!path) return { mtime: 0, size: 0 };
		try {
			let st = await IOUtils.stat(path);
			return { mtime: Number(st.lastModified) || 0, size: Number(st.size) || 0 };
		}
		catch (e) {
			return { mtime: 0, size: 0 };
		}
	}

	// ---------- markitdown ----------

	function subprocessModule() {
		if (runtime.subprocess) return runtime.subprocess;
		return ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs").Subprocess;
	}

	function lastLines(text, n = 3) {
		return String(text || "").trim().split(/\r?\n/).filter(Boolean).slice(-n).join(" ").slice(0, 300);
	}

	/**
	 * Run `markitdown <file>` and return its stdout. Throws on a missing executable, a non-zero exit,
	 * a timeout or output past the size cap (the process is killed).
	 */
	async function runMarkitdown(exe, file, opts = {}) {
		let Subprocess = subprocessModule();
		let timeoutMs = opts.timeoutMs || MARKITDOWN_TIMEOUT_MS;
		let maxChars = opts.maxChars || MARKITDOWN_MAX_CHARS;
		let command = exe;
		// A bare name ("markitdown") is looked up on PATH; Subprocess needs an absolute path
		if (!/[\\/]/.test(command)) command = await Subprocess.pathSearch(command);
		let proc = await Subprocess.call({
			command,
			arguments: [file],
			// Python writes UTF-8 to the pipe on every platform
			environment: { PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
			environmentAppend: true,
			stderr: "pipe",
		});
		let out = "";
		let err = "";
		let tooBig = false;
		let drain = async (pipe, onChunk) => {
			try {
				let s;
				while ((s = await pipe.readString())) onChunk(s);
			}
			catch (e) {}
		};
		let timer = null;
		let timedOut = false;
		let timeout = new Promise((resolve) => {
			timer = setTimeout(() => {
				timedOut = true;
				resolve(null);
			}, timeoutMs);
		});
		let finished = Promise.all([
			drain(proc.stdout, (s) => {
				if (tooBig) return;
				out += s;
				if (out.length > maxChars) {
					tooBig = true;
					proc.kill();
				}
			}),
			proc.stderr ? drain(proc.stderr, (s) => {
				err = (err + s).slice(-4000);
			}) : null,
		]).then(() => proc.wait());
		let result = await Promise.race([finished, timeout]);
		clearTimeout(timer);
		if (timedOut) {
			try {
				await proc.kill();
			}
			catch (e) {}
			throw new Error(`markitdown 超過 ${Math.round(timeoutMs / 1000)} 秒沒有完成`);
		}
		if (tooBig) throw new Error(`markitdown 輸出超過 ${Math.round(maxChars / 1024 / 1024)} MB`);
		if (!result || result.exitCode !== 0) {
			throw new Error(`markitdown 結束代碼 ${result ? result.exitCode : "?"}${err.trim() ? `：${lastLines(err)}` : ""}`);
		}
		if (!out.trim()) throw new Error("markitdown 沒有輸出任何文字");
		return out;
	}

	// ---------- conversion ----------

	/**
	 * One attachment's Markdown, from the cache when the file, its text and the settings are unchanged.
	 * markitdown runs only for a local PDF and only when its path is set; when it fails, the built-in
	 * conversion is used and the failure is remembered for this file (no retry on every sync).
	 * @returns {Promise<{ md, engine, stats, note }>} note: why markitdown wasn't used ("" when it was, or wasn't asked for)
	 */
	async function convertSource(source, libraryID, opts) {
		let F = ZB().fulltextMd;
		let stamp = await fileStamp(source.path);
		let textHash = F.hash(source.text || "");
		let wantMarkitdown = !!(opts.markitdownPath && source.isPDF && source.path);
		let name = `${libraryID}-${source.key}`;
		let cached = await readCache(name);
		let fresh = cached && cached.v === F.VERSION && cached.mtime === stamp.mtime && cached.size === stamp.size
			&& cached.textHash === textHash && typeof cached.md === "string";
		// A failure remembered in the cache is not reported again on every sync
		if (fresh) {
			if (!wantMarkitdown && cached.engine === "built-in" && !cached.markitdownPath) return Object.assign(cached, { note: "" });
			if (wantMarkitdown && cached.markitdownPath === opts.markitdownPath) return Object.assign(cached, { note: "" });
		}
		let record = { v: F.VERSION, key: source.key, mtime: stamp.mtime, size: stamp.size, textHash, engine: "built-in", markitdownPath: "", note: "" };
		if (wantMarkitdown) {
			record.markitdownPath = opts.markitdownPath;
			try {
				let out = await runMarkitdown(opts.markitdownPath, source.path, opts);
				let converted = F.toMarkdown(out, { source: "markitdown" });
				if (converted.md.trim()) {
					Object.assign(record, { engine: "markitdown", md: converted.md, stats: converted.stats });
				}
				else {
					record.note = "markitdown 沒有讀到文字";
				}
			}
			catch (e) {
				record.note = String(e.message || e);
				Zotero.debug(`Zotero Bridge: markitdown failed for ${source.key}, using the built-in conversion: ${record.note}`);
			}
		}
		if (record.engine !== "markitdown") {
			let converted = F.toMarkdown(source.text || "", { source: "zotero" });
			Object.assign(record, { md: converted.md, stats: converted.stats });
		}
		await writeCache(name, record);
		return record;
	}

	/**
	 * Convert the item's text attachments (adapter: data.fullTextSources). When the AI gets full text
	 * this sync (data.fullText set by the adapter), it gets the Markdown instead: with References and
	 * the like cut (option), truncated to fullTextLimit as before. Returns null when there is no text.
	 * @returns {Promise<{ sources: [{ key, title, md, engine }], stats: { raw, sent, cut } | null, messages }>}
	 */
	async function prepare(data, llm, messages) {
		let S = ZB().scanned;
		let F = ZB().fulltextMd;
		let opts = options();
		let usable = (data.fullTextSources || []).filter(s => (s.text && s.text.trim()) || (s.isPDF && s.path && opts.markitdownPath))
			.filter(s => S.classifySource(s) !== "none" || (opts.markitdownPath && s.isPDF && s.path));
		if (!usable.length) return null;
		let sources = [];
		for (let s of usable) {
			let rec = await convertSource(s, data.libraryID, opts);
			if (rec.note && messages) messages.push(`⚠️ markitdown 轉換失敗，改用內建轉換（${rec.note}）`);
			if (rec.md && rec.md.trim()) sources.push({ key: s.key, title: s.title, md: rec.md, engine: rec.engine });
		}
		if (!sources.length) return null;
		let result = { sources, stats: null };
		// The AI's copy: only when this sync sends full text (fullTextLimit > 0 and an AI note to write)
		let limit = (llm && llm.fullTextLimit) || 0;
		if (limit > 0 && data.fullText && data.fullTextStatus !== "none") {
			let raw = (data.fullTextSources || []).reduce((n, s) => n + String(s.text || "").length, 0);
			let cut = [];
			let parts = sources.map((s) => {
				if (!opts.trimReferences) return s.md;
				let t = F.trimForAI(s.md);
				cut.push(...t.cut);
				return t.md;
			});
			let t = ZB().core.truncate(parts.join("\n\n---\n\n"), limit);
			data.fullText = t.text;
			data.fullTextTruncated = t.truncated;
			data.fullTextFormat = "markdown";
			data.fullTextTrimmed = cut.length > 0;
			result.stats = { raw: Math.min(raw, limit), rawTotal: raw, sent: t.text.length, cut };
		}
		return result;
	}

	// ---------- highlights in the full text ----------

	/**
	 * The AI's key sentences that really are in the text (verify.js matching against the full text,
	 * else the abstract); the others are dropped. Returns [{ quote, why }].
	 */
	function verifyAIHighlights(highlights, prepared, data) {
		let V = ZB().verify;
		let texts = [...((prepared && prepared.sources) || []).map(s => s.md), data && data.fullTextStatus !== "none" ? data.fullText : "", data && data.abstract]
			.filter(t => t && String(t).trim());
		if (!texts.length) return [];
		let indexes = texts.map(t => V.buildIndex(t));
		return (highlights || []).filter(h => h && h.quote && indexes.some(ix => V.quoteInIndex(h.quote, ix)));
	}

	/**
	 * The full text with the user's highlights (by colour) and the verified AI quotes marked.
	 * @returns {{ md, missing: [{ text, emoji, meaning, page }], legend: [{ emoji, meaning }], aiMarked }}
	 */
	function render(prepared, data, opts = {}) {
		let core = ZB().core;
		let F = ZB().fulltextMd;
		let meanings = core.colorMeanings(opts.colorMeanings || "");
		let meaningOf = new Map(meanings.map(m => [m.color, m.meaning]));
		let used = new Map();
		let missing = [];
		let aiLeft = (opts.aiHighlights || []).map((h, i) => ({ id: `ai:${i}`, text: h.quote, open: "🤖<u>", close: "</u>" }));
		let aiMarked = 0;
		let multi = prepared.sources.length > 1;
		let parts = prepared.sources.map((source) => {
			let att = (data.attachments || []).find(a => a.key === source.key);
			let anns = ((att && att.annotations) || []).filter(a => (a.type === "highlight" || a.type === "underline") && String(a.text || "").trim());
			let items = anns.map(a => ({ id: a.key, text: a.text, open: `==${core.colorInfo(a.color).highlight}`, close: "==", ann: a }));
			let marked = F.markHighlights(source.md, [...items, ...aiLeft]);
			let located = new Set(marked.located);
			for (let item of items) {
				let info = core.colorInfo(item.ann.color);
				let meaning = meaningOf.get(String(item.ann.color || "").toLowerCase()) || "其他顏色";
				if (located.has(item.id)) used.set(info.emoji + meaning, { emoji: info.emoji, meaning, order: meanings.findIndex(m => m.meaning === meaning) });
				else missing.push({ text: item.ann.text, emoji: info.highlight, meaning, page: item.ann.pageLabel || "" });
			}
			aiMarked += aiLeft.filter(i => located.has(i.id)).length;
			aiLeft = aiLeft.filter(i => !located.has(i.id));
			return multi ? `---\n\n**附件：${source.title || source.key}**\n\n${marked.md}` : marked.md;
		});
		let legend = [...used.values()].sort((a, b) => (a.order < 0 ? 99 : a.order) - (b.order < 0 ? 99 : b.order));
		return { md: parts.join("\n\n"), missing, legend: legend.map(({ emoji, meaning }) => ({ emoji, meaning })), aiMarked };
	}

	// ---------- Obsidian ----------

	/** Where the full-text note of a literature note goes: <note folder>/<folder>/<same file name>. */
	function obsidianTarget(obsidian, folder) {
		let name = obsidian.relParts[obsidian.relParts.length - 1];
		let relParts = [...obsidian.relParts.slice(0, -1), folder, name];
		return {
			dir: PathUtils.join(obsidian.dir, folder),
			path: PathUtils.join(obsidian.dir, folder, name),
			link: relParts.join("/").replace(/\.md$/i, ""),
		};
	}

	/**
	 * Write (or leave unchanged) the full-text note next to the literature note. `previousLink` is the
	 * note's earlier `fulltext` link: when the literature note was renamed, the old full-text note
	 * (only ours: it names this item in `fulltext_of`) is removed. Returns the new note's vault link.
	 */
	async function writeObsidian(obsidian, data, rendered, opts = {}) {
		let F = ZB().fulltextMd;
		let target = obsidianTarget(obsidian, opts.folder || DEFAULT_FOLDER);
		let zoteroKey = `${data.libraryPath}/${data.key}`;
		let text = F.buildFullTextNote({
			zoteroKey,
			title: data.title,
			md: rendered.md,
			noteLink: obsidian.relPath.replace(/\.md$/i, ""),
			noteLabel: "文獻筆記",
			legend: rendered.legend,
			aiLegend: rendered.aiMarked > 0,
			missing: rendered.missing,
			source: opts.engine || "built-in",
		});
		await IOUtils.makeDirectory(target.dir, { createAncestors: true, ignoreExisting: true });
		let existing = (await IOUtils.exists(target.path)) ? await IOUtils.readUTF8(target.path) : null;
		if (existing !== null && !isOurs(existing, zoteroKey)) {
			// A note of the user's with that name: never overwrite it
			throw new Error(`「${target.link}.md」不是 Zotero Bridge 產生的全文筆記，沒有覆寫`);
		}
		if (existing !== text) await IOUtils.writeUTF8(target.path, text);
		if (opts.previousLink && opts.previousLink !== target.link && opts.vaultPath) {
			let old = PathUtils.join(opts.vaultPath, ...opts.previousLink.split("/").filter(Boolean)) + ".md";
			try {
				if (old !== target.path && (await IOUtils.exists(old)) && isOurs(await IOUtils.readUTF8(old), zoteroKey)) await IOUtils.remove(old);
			}
			catch (e) {
				Zotero.debug(`Zotero Bridge: could not remove the old full-text note ${old}: ${e}`);
			}
		}
		return target.link;
	}

	function isOurs(text, zoteroKey) {
		let fm = ZB().core.splitFrontmatter(String(text || "")).frontmatter || "";
		return ZB().core.frontmatterScalar(fm, "fulltext_of") === zoteroKey;
	}

	// ---------- Notion ----------

	/** The Markdown of the Notion child page (same marks; the callout says it is rebuilt each sync). */
	function notionMarkdown(rendered) {
		let F = ZB().fulltextMd;
		let legend = rendered.legend.map(l => `${l.emoji} ${l.meaning}`);
		if (rendered.aiMarked) legend.push("🤖 底線＝AI 標的重點（僅供參考）");
		let head = "> [!info] 全文・由 Zotero Bridge 產生\n> 每次同步會整頁重建，請不要在這裡寫字，想法寫在上一層的文獻頁面。"
			+ (legend.length ? `\n> 劃線：${legend.join(" · ")}` : "");
		let missing = F.missingSection(rendered.missing);
		return [head, rendered.md, missing].filter(Boolean).join("\n\n");
	}

	/**
	 * The full text as a child page of the literature page. Rebuilt only when its content changed;
	 * the earlier child page goes to the Notion trash, so there is never more than one.
	 * Returns the child page ID (null on failure; the reason goes to `messages`).
	 */
	async function writeNotion(client, pageId, data, rendered, messages) {
		let F = ZB().fulltextMd;
		let md = notionMarkdown(rendered);
		let h = F.hash(md);
		let cacheName = `notion-${data.libraryID}-${data.key}`;
		try {
			let cached = await readCache(cacheName);
			let children = await client.listChildren(pageId);
			let earlier = children.filter(b => b.type === "child_page" && b.child_page
				&& (String(b.child_page.title || "").startsWith(NOTION_PAGE_PREFIX) || (cached && b.id === cached.childId)));
			if (cached && cached.hash === h && cached.pageId === pageId && earlier.some(b => b.id === cached.childId)) return cached.childId;
			for (let b of earlier) await client.trashPage(b.id);
			let title = `${NOTION_PAGE_PREFIX}${data.shortTitle || data.title || "Untitled"}`.slice(0, 200);
			let page = await client.request("POST", "pages", {
				parent: { type: "page_id", page_id: pageId },
				icon: { type: "emoji", emoji: "📄" },
				properties: { title: { title: [{ type: "text", text: { content: title } }] } },
			});
			for (let chunk of F.notionChunks(ZB().markdown.mdToNotionBlocks(md))) {
				await client.request("PATCH", `blocks/${page.id}/children`, { children: chunk });
			}
			await writeCache(cacheName, { pageId, childId: page.id, hash: h });
			return page.id;
		}
		catch (e) {
			if (messages) messages.push(`⚠️ Notion 全文頁：${e.message || e}`);
			return null;
		}
	}

	return {
		DEFAULT_FOLDER, NOTION_PAGE_PREFIX, MARKITDOWN_TIMEOUT_MS, MARKITDOWN_MAX_CHARS, runtime,
		options, cacheDir, runMarkitdown, convertSource, prepare, verifyAIHighlights, render, obsidianTarget,
		writeObsidian, notionMarkdown, writeNotion,
	};
});
