/*
 * Zotero Bridge — image and ink annotations: the PNG Zotero renders for each one is copied into
 * the Obsidian vault, uploaded to Notion (File Upload API) and, if enabled, shown to Claude.
 * The pure helpers are required directly by the Node tests; the rest uses the Zotero globals.
 * A missing image never fails a sync: the annotation keeps its caption and comment.
 */
(function (root, factory) {
	const api = factory(root);
	if (typeof module === "object" && module.exports) {
		module.exports = api;
	}
	else {
		(root.ZB = root.ZB || {}).images = api;
	}
})(this, function (root) {
	const PREF = "extensions.zotero-bridge.";
	const IMAGE_TYPES = ["image", "ink"];
	// Subfolder of the note's folder that holds the copied PNGs
	const FOLDER = "attachments";
	// Zotero item and annotation keys (8 characters from 2-9 and A-Z), safe in file names
	const KEY_RE = /^[0-9A-Z]{8}$/;
	// Single-part limit of the Notion File Upload API (free workspaces allow 5 MiB per file)
	const NOTION_MAX_BYTES = 20 * 1024 * 1024;
	// Same pacing as NotionClient.request (~3 requests/second)
	const NOTION_INTERVAL_MS = 340;
	// Claude: at most 5 MB per image once base64-encoded (the strictest platform limit), 8000 px per
	// side, and more than 20 images per request tightens the size limit; keep the request well under 32 MB
	const AI_MAX_BYTES = 3.75 * 1024 * 1024;
	const AI_MAX_PIXELS = 8000;
	const AI_MAX_IMAGES = 20;
	const AI_MAX_TOTAL_BYTES = 15 * 1024 * 1024;

	// ---------- pure helpers ----------

	function isImageAnnotation(ann) {
		return !!ann && IMAGE_TYPES.includes(ann.type);
	}

	/** File name of an annotation's PNG in the vault: "<itemKey>-<annotationKey>.png". */
	function imageFileName(itemKey, annotationKey) {
		return `${itemKey}-${annotationKey}.png`;
	}

	/**
	 * Vault-relative path for `![[...]]`, from the note's folder parts. A folder the user named with
	 * characters that end a wikilink falls back to the bare file name, which is unique in the vault.
	 */
	function embedPath(folderParts, fileName) {
		if (folderParts.some(p => /[[\]|#^]/.test(p))) return fileName;
		return [...folderParts, FOLDER, fileName].join("/");
	}

	/**
	 * Files in the attachments folder that the plugin wrote for this item and whose annotation is gone.
	 * Only names of the exact form "<itemKey>-<annotationKey>.png" are considered, so the user's own
	 * files (and other items' images) are never touched.
	 */
	function staleImageFiles(fileNames, itemKey, keepAnnotationKeys) {
		let keep = new Set(keepAnnotationKeys || []);
		return (fileNames || []).filter((name) => {
			let m = /^([0-9A-Z]{8})-([0-9A-Z]{8})\.png$/.exec(name);
			return !!m && m[1] === itemKey && !keep.has(m[2]);
		});
	}

	/** Copy of the item data where `imageFor(ann)` (when not null) is set as `ann.image`. */
	function withImages(data, imageFor) {
		return Object.assign({}, data, {
			attachments: (data.attachments || []).map(att => Object.assign({}, att, {
				annotations: (att.annotations || []).map((ann) => {
					let image = isImageAnnotation(ann) ? imageFor(ann) : null;
					return image ? Object.assign({}, ann, { image }) : ann;
				}),
			})),
		});
	}

	/** Width and height from a PNG's IHDR chunk; null when the bytes are not a PNG. */
	function pngSize(bytes) {
		let sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
		if (!bytes || bytes.length < 24 || sig.some((b, i) => bytes[i] !== b)) return null;
		let u32 = i => ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
		return { width: u32(16), height: u32(20) };
	}

	const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

	function base64(bytes) {
		let out = [];
		let i = 0;
		for (; i + 2 < bytes.length; i += 3) {
			let n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
			out.push(B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]);
		}
		if (i < bytes.length) {
			let n = (bytes[i] << 16) | ((i + 1 < bytes.length ? bytes[i + 1] : 0) << 8);
			out.push(B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=") + "=");
		}
		return out.join("");
	}

	/** A multipart/form-data body with one file field, as Notion's /send endpoint expects. */
	function multipartBody(boundary, fieldName, fileName, contentType, bytes) {
		let enc = new TextEncoder();
		let head = enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\n`
			+ `Content-Type: ${contentType}\r\n\r\n`);
		let tail = enc.encode(`\r\n--${boundary}--\r\n`);
		let body = new Uint8Array(head.length + bytes.length + tail.length);
		body.set(head, 0);
		body.set(bytes, head.length);
		body.set(tail, head.length + bytes.length);
		return body;
	}

	/** Text shown to the LLM right before an annotation's image. */
	function promptLabel(ann, n) {
		let what = ann.type === "ink" ? "手繪註記" : "圖片劃線";
		let page = ann.pageLabel ? `p. ${ann.pageLabel}` : "";
		let comment = ann.comment ? `使用者評註：${ann.comment}` : "";
		return [`[${what} ${n}]`, page, comment].filter(Boolean).join(" — ");
	}

	/**
	 * Pick the images to send with the prompt, within Claude's limits.
	 * entries: [{ annotation, bytes }] → { images: [{ label, mediaType, data }], skipped }
	 */
	function selectPromptImages(entries) {
		let images = [];
		let skipped = 0;
		let total = 0;
		for (let e of entries) {
			let size = pngSize(e.bytes);
			if (!size || images.length >= AI_MAX_IMAGES || e.bytes.length > AI_MAX_BYTES
					|| total + e.bytes.length > AI_MAX_TOTAL_BYTES || size.width > AI_MAX_PIXELS || size.height > AI_MAX_PIXELS) {
				skipped++;
				continue;
			}
			total += e.bytes.length;
			images.push({ label: promptLabel(e.annotation, images.length + 1), mediaType: "image/png", data: base64(e.bytes) });
		}
		return { images, skipped };
	}

	// ---------- Zotero side ----------

	function prefs() {
		let get = key => Zotero.Prefs.get(PREF + key, true);
		return { export: get("images.export") !== false, sendToAI: get("images.sendToAI") === true };
	}

	// Per-run state, kept on the sync context: attachments already rendered, one-time messages
	function runState(ctx) {
		if (!ctx.annotationImages) ctx.annotationImages = { rendered: new Set(), notified: new Set() };
		return ctx.annotationImages;
	}

	function notifyOnce(ctx, id, messages, text) {
		let state = runState(ctx);
		if (state.notified.has(id)) return;
		state.notified.add(id);
		messages.push(text);
	}

	// Render the PDF's image/ink annotations that have no cached PNG yet (xpcom/pdfWorker/manager.js)
	async function renderAttachment(attachmentID) {
		let renderer = [Zotero.PDFWorker, Zotero.PDFRenderer]
			.find(r => r && typeof r.renderAttachmentAnnotations === "function");
		if (!renderer) return;
		try {
			await renderer.renderAttachmentAnnotations(attachmentID, true);
		}
		catch (e) {
			Zotero.debug(`Zotero Bridge: could not render annotations of attachment ${attachmentID}: ${e}`);
		}
	}

	/** Path of the annotation's PNG in Zotero's cache, rendering it first if needed; null if unavailable. */
	async function cachedImagePath(libraryID, attachmentKey, annotationKey, ctx) {
		try {
			if (!Zotero.Annotations || typeof Zotero.Annotations.getCacheImagePath !== "function") return null;
			let path = Zotero.Annotations.getCacheImagePath({ libraryID, key: annotationKey });
			if (await IOUtils.exists(path)) return path;
			let attachment = Zotero.Items.getByLibraryAndKey(libraryID, attachmentKey);
			let state = runState(ctx);
			if (attachment && !state.rendered.has(attachment.id)) {
				// One render per attachment and run covers all of its missing images
				state.rendered.add(attachment.id);
				await renderAttachment(attachment.id);
			}
			return (await IOUtils.exists(path)) ? path : null;
		}
		catch (e) {
			Zotero.debug(`Zotero Bridge: no image for annotation ${annotationKey}: ${e}`);
			return null;
		}
	}

	/**
	 * Find the PNG of every image/ink annotation of the item, when this sync needs them.
	 * need: { targets: Set, ai: boolean }. Returns null when images are not used in this sync,
	 * otherwise { entries: [{ attachment, annotation, name, path }], export, sendToAI }.
	 */
	async function collect(data, need, ctx, messages) {
		try {
			return await collectImages(data, need, ctx, messages);
		}
		catch (e) {
			Zotero.logError(e);
			return null;
		}
	}

	async function collectImages(data, need, ctx, messages) {
		let p = prefs();
		let targets = need.targets || new Set();
		let wanted = (p.export && (targets.has("obsidian") || targets.has("notion"))) || (p.sendToAI && need.ai);
		if (!wanted) return null;
		let entries = [];
		for (let att of data.attachments || []) {
			for (let ann of att.annotations || []) {
				if (!isImageAnnotation(ann) || !KEY_RE.test(ann.key || "")) continue;
				entries.push({ attachment: att, annotation: ann, name: imageFileName(data.key, ann.key), path: null, bytes: null });
			}
		}
		let missing = 0;
		for (let e of entries) {
			e.path = await cachedImagePath(data.libraryID, e.attachment.key, e.annotation.key, ctx);
			if (!e.path) missing++;
		}
		if (missing) messages.push(`⚠️ ${missing} 個圖片劃線無法產生圖片（保留評註）`);
		return { entries, export: p.export, sendToAI: p.sendToAI };
	}

	async function entryBytes(e) {
		if (!e.bytes) e.bytes = await IOUtils.read(e.path);
		return e.bytes;
	}

	async function sameBytes(path, bytes) {
		if (!(await IOUtils.exists(path))) return false;
		let old = await IOUtils.read(path);
		return old.length === bytes.length && old.every((b, i) => b === bytes[i]);
	}

	/**
	 * Copy the PNGs next to the note (<note folder>/attachments/<itemKey>-<annotationKey>.png; written
	 * only when the content changed), remove this item's PNGs whose annotation was deleted, and
	 * return the item data with `ann.image.embed` set for the note's `![[...]]` embeds.
	 */
	async function writeToVault(obsidian, data, images, messages) {
		if (!images || !images.export) return data;
		let dir = PathUtils.join(obsidian.dir, FOLDER);
		let folderParts = obsidian.relParts.slice(0, -1);
		let embeds = new Map();
		let failed = 0;
		for (let e of images.entries) {
			let dest = PathUtils.join(dir, e.name);
			try {
				if (e.path) {
					let bytes = await entryBytes(e);
					if (!(await sameBytes(dest, bytes))) {
						await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
						await IOUtils.write(dest, bytes);
					}
					embeds.set(e.annotation.key, embedPath(folderParts, e.name));
				}
				else if (await IOUtils.exists(dest)) {
					// Zotero couldn't render it this time: keep showing the copy from an earlier sync
					embeds.set(e.annotation.key, embedPath(folderParts, e.name));
				}
			}
			catch (err) {
				failed++;
				Zotero.logError(err);
			}
		}
		try {
			let children = (await IOUtils.exists(dir)) ? await IOUtils.getChildren(dir) : [];
			let stale = staleImageFiles(children.map(c => PathUtils.filename(c)), data.key, images.entries.map(e => e.annotation.key));
			for (let name of stale) {
				await IOUtils.remove(PathUtils.join(dir, name));
			}
		}
		catch (err) {
			Zotero.logError(err);
		}
		if (failed) messages.push(`⚠️ ${failed} 張圖片無法寫入 Obsidian`);
		return withImages(data, ann => (embeds.has(ann.key) ? { embed: embeds.get(ann.key) } : null));
	}

	function notionAPI() {
		return (root && root.ZB && root.ZB.notion) || require("./notion.js");
	}

	// POST a multipart body with the client's credentials and pacing (NotionClient.request only sends JSON)
	async function sendMultipart(client, path, body, boundary, attempt = 0) {
		let notion = notionAPI();
		let wait = client.lastRequest + NOTION_INTERVAL_MS - Date.now();
		if (wait > 0) await client.sleep(wait);
		client.lastRequest = Date.now();
		let res = await client.fetch("https://api.notion.com/v1/" + path, {
			method: "POST",
			headers: {
				"Authorization": `Bearer ${client.token}`,
				"Notion-Version": notion.NOTION_VERSION,
				"Content-Type": `multipart/form-data; boundary=${boundary}`,
			},
			body,
		});
		// 429 means nothing was received, so sending again is safe
		if (res.status === 429 && attempt < 3) {
			let retryAfter = Number(res.headers && res.headers.get && res.headers.get("Retry-After"));
			await client.sleep(retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
			return sendMultipart(client, path, body, boundary, attempt + 1);
		}
		let text = await res.text();
		let json = null;
		try {
			json = text ? JSON.parse(text) : null;
		}
		catch (e) {}
		if (!res.ok) {
			throw new notion.NotionError(res.status, json && json.code, (json && json.message) || text || res.statusText);
		}
		return json;
	}

	/** Upload one file (single part) and return its file_upload ID, to attach right away. */
	async function uploadFile(client, fileName, contentType, bytes) {
		let upload = await client.request("POST", "file_uploads", { mode: "single_part", filename: fileName, content_type: contentType });
		let boundary = "ZoteroBridge" + Math.random().toString(16).slice(2) + Date.now().toString(16);
		let sent = await sendMultipart(client, `file_uploads/${upload.id}/send`,
			multipartBody(boundary, "file", fileName, contentType, bytes), boundary);
		if (sent && sent.status && sent.status !== "uploaded") {
			throw new Error(`Notion file upload ${upload.id}: ${sent.status}`);
		}
		return upload.id;
	}

	/**
	 * Upload the PNGs for this sync's Notion page. Uploads that aren't attached expire after an hour,
	 * so they are made just before the page's blocks are written, on every sync.
	 * Returns { data (with ann.image.embed = file name), ids: { fileName: file_upload ID } }.
	 */
	async function uploadToNotion(client, data, images, ctx, messages) {
		let ids = {};
		if (!images || !images.export) return { data, ids };
		let entries = images.entries.filter(e => e.path);
		if (!entries.length) return { data, ids };
		if (typeof TextEncoder !== "function" || typeof Uint8Array !== "function") {
			notifyOnce(ctx, "notion-upload", messages, "⚠️ 這個 Zotero 版本無法上傳檔案到 Notion，圖片劃線只同步評註");
			return { data, ids };
		}
		let failed = 0;
		for (let i = 0; i < entries.length; i++) {
			let e = entries[i];
			try {
				let bytes = await entryBytes(e);
				if (bytes.length > NOTION_MAX_BYTES) {
					failed++;
					continue;
				}
				ids[e.name] = await uploadFile(client, e.name, "image/png", bytes);
			}
			catch (err) {
				Zotero.logError(err);
				// Usually the same for every file (permissions, workspace limits): don't retry the rest
				failed += entries.length - i;
				break;
			}
		}
		if (failed) messages.push(`⚠️ ${failed} 張圖片無法上傳到 Notion（保留評註）`);
		return { data: withImages(data, ann => (ids[imageFileName(data.key, ann.key)] ? { embed: imageFileName(data.key, ann.key) } : null)), ids };
	}

	/** Images for the LLM prompt (setting 「AI 也看圖片劃線」, Claude only); undefined when none. */
	async function forPrompt(images, llm, ctx, messages) {
		if (!images || !images.sendToAI) return undefined;
		let entries = images.entries.filter(e => e.path);
		if (!entries.length) return undefined;
		if (llm.provider === "openai") {
			notifyOnce(ctx, "ai-openai", messages, "圖片劃線只會傳給 Claude，OpenAI 模式下只送評註");
			return undefined;
		}
		let loaded = [];
		for (let e of entries) {
			try {
				loaded.push({ annotation: e.annotation, bytes: await entryBytes(e) });
			}
			catch (err) {
				Zotero.logError(err);
			}
		}
		let { images: picked, skipped } = selectPromptImages(loaded);
		if (skipped) messages.push(`⚠️ ${skipped} 張圖片劃線太大或太多，沒有傳給 AI`);
		return picked.length ? picked : undefined;
	}

	return {
		FOLDER, NOTION_MAX_BYTES, AI_MAX_IMAGES,
		isImageAnnotation, imageFileName, embedPath, staleImageFiles, withImages, pngSize, base64,
		multipartBody, promptLabel, selectPromptImages,
		collect, writeToVault, uploadFile, uploadToNotion, forPrompt,
	};
});
