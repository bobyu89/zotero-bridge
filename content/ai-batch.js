/*
 * Zotero Bridge — bulk AI notes through the Claude Message Batches API (約半價，最長 24 小時).
 *
 * With 「大量產生 AI 筆記時使用批次 API」 on, a manual run that needs AI notes for at least
 * llm.batchThreshold items (Claude only) can send them as one Message Batch instead of one call per
 * item. Each request is the body the normal path sends (llm.noteRequestBody, the same builder), with
 * only what the Batches API needs changed (batchParams). The batch is kept in a pref so it survives
 * restarts and is polled every 2–5 minutes. When it has ended, every succeeded result goes through
 * the normal post-processing (processGeneratedNote: JSON block, quote verification; the AI child
 * note; the usage ledger at batch prices) and the items are synced with ai: "reuse". Results that
 * errored, expired, were canceled or refused are put into the stop/resume list (batch.pending), so
 * 「繼續未完成的 Zotero Bridge 同步」 retries them on the normal path.
 *
 *   extensions.zotero-bridge.batch.ai   { batches: [{ id, createdAt, expiresAt, model, action,
 *                                          status, counts, checkedAt, requests: [{ id, ref, title, pdf, notes, done }] }] }
 *
 * Message Batches facts used here (Claude API docs): POST /v1/messages/batches { requests: [{ custom_id,
 * params }] }; custom_id matches ^[a-zA-Z0-9_-]{1,64}$ and is unique in the batch; at most 100,000
 * requests or 256 MB per batch; processing_status in_progress → canceling → ended; results (.jsonl at
 * results_url, any order, one { custom_id, result: { type: succeeded | errored | canceled | expired } }
 * per line) once ended, kept for 29 days; a batch expires after 24 hours; every token costs 50% of the
 * standard price, cache reads and writes included; `fallbacks` (server-side fallback) and `stream` are
 * not accepted in a batch. Cache hits in a batch are best-effort; the docs suggest the 1-hour cache TTL.
 *
 * The helpers at the top are pure (Node tests); the rest needs Zotero.
 */
(function (root, factory) {
	if (typeof module === "object" && module.exports) {
		module.exports = factory(require("./llm.js"), globalThis);
	}
	else {
		(root.ZB = root.ZB || {}).aiBatch = factory(root.ZB.llm, root);
	}
})(this, function (llm, scope) {
	const PREF = "extensions.zotero-bridge.";
	const STATE_PREF = "batch.ai";
	const API = "https://api.anthropic.com/v1/messages/batches";
	const CUSTOM_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
	const MAX_REQUESTS = 100000;
	// The API limit is 256 MB per batch; stay clear of it (JSON length ≈ bytes for base64 PDFs)
	const MAX_BATCH_BYTES = 200 * 1024 * 1024;
	// Polling: soon after startup, then every 2, 3, 4 and at most 5 minutes
	const STARTUP_DELAY_MS = 60 * 1000;
	const POLL_MIN_MS = 2 * 60 * 1000;
	const POLL_STEP_MS = 60 * 1000;
	const POLL_MAX_MS = 5 * 60 * 1000;
	const RESULTS_DAYS = 29;

	// ---------- pure helpers ----------

	/**
	 * custom_id for an item ref "libraryID/KEY": letters and digits kept, "/" → "-", any other
	 * character → "_" + 4 hex digits. null when the result would not fit the API's 64 characters.
	 */
	function encodeCustomId(ref) {
		let out = "";
		for (let ch of String(ref)) {
			if (/[A-Za-z0-9]/.test(ch)) out += ch;
			else if (ch === "/") out += "-";
			else {
				let code = ch.codePointAt(0);
				if (code > 0xffff) return null;
				out += "_" + code.toString(16).padStart(4, "0");
			}
		}
		return CUSTOM_ID_RE.test(out) ? out : null;
	}

	function decodeCustomId(id) {
		return String(id).replace(/_([0-9a-f]{4})|-/g, (m, hex) => (hex ? String.fromCharCode(parseInt(hex, 16)) : "/"));
	}

	/**
	 * Unique custom_ids for the item refs, in order: the encoded ref, or "n<index>" when that is
	 * too long or taken (the stored requests map custom_id → ref either way).
	 */
	function assignCustomIds(refs) {
		let used = new Set();
		return refs.map((ref, i) => {
			let id = encodeCustomId(ref);
			if (!id || used.has(id)) id = `n${i}`;
			while (used.has(id)) id += "x";
			used.add(id);
			return id;
		});
	}

	/**
	 * A Messages request body (llm.anthropicBody) as Batches `params`: without the parameters a batch
	 * rejects (fallbacks, stream, speed), and with the 1-hour cache TTL, which the docs suggest for
	 * batches (they can take longer than the 5-minute cache lifetime). Everything else is unchanged.
	 */
	function batchParams(body) {
		let params = JSON.parse(JSON.stringify(body));
		delete params.fallbacks;
		delete params.stream;
		delete params.speed;
		let ttl = (block) => {
			if (block && block.cache_control) block.cache_control = Object.assign({}, block.cache_control, { ttl: "1h" });
		};
		if (Array.isArray(params.system)) params.system.forEach(ttl);
		for (let m of params.messages || []) {
			if (Array.isArray(m.content)) m.content.forEach(ttl);
		}
		return params;
	}

	/**
	 * Split request entries ({ custom_id, params }) into batches within the API limits.
	 * @returns {Array<Array>} the entries per batch, in order
	 */
	function chunkRequests(requests, maxBytes = MAX_BATCH_BYTES, maxCount = MAX_REQUESTS) {
		let chunks = [];
		let current = [];
		let size = 0;
		for (let r of requests) {
			let n = JSON.stringify(r).length + 1;
			if (current.length && (size + n > maxBytes || current.length >= maxCount)) {
				chunks.push(current);
				current = [];
				size = 0;
			}
			current.push(r);
			size += n;
		}
		if (current.length) chunks.push(current);
		return chunks;
	}

	/**
	 * Parse the .jsonl results file: one { customId, type, message, error } per valid line.
	 * Blank lines are skipped; unreadable lines are counted in `invalid`.
	 */
	function parseResults(text) {
		let results = [];
		let invalid = 0;
		for (let line of String(text || "").split(/\r?\n/)) {
			if (!line.trim()) continue;
			let obj;
			try {
				obj = JSON.parse(line);
			}
			catch (e) {
				invalid++;
				continue;
			}
			let r = obj && obj.result;
			if (!obj || typeof obj.custom_id !== "string" || !r || typeof r.type !== "string") {
				invalid++;
				continue;
			}
			results.push({ customId: obj.custom_id, type: r.type, message: r.message || null, error: r.error || null });
		}
		return { results, invalid };
	}

	/** Error text of an errored result (the standard error shape: { type: "error", error: { type, message } }). */
	function errorText(error) {
		let e = (error && error.error) || error || {};
		let type = e.type && e.type !== "error" ? e.type : "";
		return [type, e.message].filter(Boolean).join(": ") || "未知錯誤";
	}

	/**
	 * One result as the normal path would see it: { ok: true, text, model, usage } through the same
	 * reader as a Messages response (refusals, empty answers and max_tokens handled identically),
	 * or { ok: false, error } — a message for the progress window, never thrown.
	 */
	function interpretResult(result, model) {
		if (!result) return { ok: false, error: "批次沒有這筆的結果" };
		if (result.type === "succeeded") {
			try {
				return Object.assign({ ok: true }, llm.readAnthropicMessage(result.message, model));
			}
			catch (e) {
				return { ok: false, error: e.message || String(e) };
			}
		}
		if (result.type === "errored") return { ok: false, error: `批次請求失敗（${errorText(result.error)}）` };
		if (result.type === "canceled") return { ok: false, error: "批次已取消，這筆沒有處理" };
		if (result.type === "expired") return { ok: false, error: "批次超過 24 小時，這筆沒有處理" };
		return { ok: false, error: `批次結果類型不明（${result.type}）` };
	}

	/** Delay before poll number `n` (0-based): 2, 3, 4, then every 5 minutes. */
	function pollDelay(n) {
		return Math.min(POLL_MIN_MS + Math.max(0, n) * POLL_STEP_MS, POLL_MAX_MS);
	}

	/** The stored state, dropping anything malformed. */
	function parseState(text) {
		let raw;
		try {
			raw = typeof text === "string" ? JSON.parse(text || "null") : text;
		}
		catch (e) {
			raw = null;
		}
		let batches = raw && Array.isArray(raw.batches) ? raw.batches : [];
		return {
			batches: batches.filter(b => b && typeof b.id === "string" && b.id && Array.isArray(b.requests)
				&& b.requests.every(r => r && typeof r.id === "string" && typeof r.ref === "string")
				&& b.action && Array.isArray(b.action.targets)),
		};
	}

	function minutesBetween(from, to) {
		let ms = Date.parse(to) - Date.parse(from);
		return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 60000)) : null;
	}

	function localTime(iso) {
		let d = new Date(iso);
		if (!Number.isFinite(d.getTime())) return "";
		let pad = n => String(n).padStart(2, "0");
		return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
	}

	const STATUS_LABELS = { in_progress: "處理中", canceling: "取消中", ended: "已結束" };

	/** One status line for a stored batch. */
	function describeBatch(batch, now = new Date()) {
		let total = batch.requests.length;
		let c = batch.counts || {};
		let finished = (c.succeeded || 0) + (c.errored || 0) + (c.canceled || 0) + (c.expired || 0);
		let parts = [`AI 批次（${total} 筆，${localTime(batch.createdAt)} 送出）：${STATUS_LABELS[batch.status] || "已送出"}`];
		if (batch.counts) {
			let failed = (c.errored || 0) + (c.canceled || 0) + (c.expired || 0);
			parts.push(`已完成 ${finished}／${total}${failed ? `（成功 ${c.succeeded || 0}、失敗 ${failed}）` : ""}`);
		}
		let waited = minutesBetween(batch.createdAt, now.toISOString());
		if (waited !== null) parts.push(waited >= 60 ? `已等待 ${Math.floor(waited / 60)} 小時 ${waited % 60} 分` : `已等待 ${waited} 分鐘`);
		if (batch.expiresAt && batch.status !== "ended") parts.push(`最晚 ${localTime(batch.expiresAt)} 結束`);
		return parts.join("，");
	}

	// ---------- Zotero side ----------

	let timer = null;
	let stopped = true;
	let polls = 0;
	let checking = null;
	// Test hook: { now, fetch, retry }
	let runtime = {
		now: () => new Date(),
		fetch: (url, init) => fetch(url, init),
		retry: null,
	};

	function pref(key) {
		return Zotero.Prefs.get(PREF + key, true);
	}

	function readState() {
		return parseState(pref(STATE_PREF));
	}

	function writeState(state) {
		try {
			Zotero.Prefs.set(PREF + STATE_PREF, state.batches.length ? JSON.stringify(state) : "", true);
		}
		catch (e) {
			Zotero.logError(e);
		}
	}

	/** Change one stored batch (by id) and save; returns the updated batch or null. */
	function updateBatch(id, fn) {
		let state = readState();
		let batch = state.batches.find(b => b.id === id);
		if (!batch) return null;
		fn(batch);
		writeState(state);
		return batch;
	}

	function removeBatch(id) {
		let state = readState();
		state.batches = state.batches.filter(b => b.id !== id);
		writeState(state);
	}

	function retryOpts() {
		return Object.assign({}, runtime.retry || (scope.ZB.main && scope.ZB.main.runtime.retry) || {});
	}

	async function apiKey() {
		return String((await scope.ZB.secrets.get("anthropicKey")) || "").trim();
	}

	async function api(method, url, key, body) {
		let { res, json, retries } = await llm.postWithRetry(runtime.fetch, url, {
			method,
			headers: llm.anthropicHeaders(key, { fallback: false }),
			body: body === undefined ? undefined : JSON.stringify(body),
		}, retryOpts());
		if (!res.ok) throw llm.httpError("Claude 批次 API", res, json, retries);
		return json;
	}

	/** The results file as text (GET results_url, retried like every API call). */
	async function fetchResults(url, key) {
		let text = "";
		// postWithRetry reads JSON; a .jsonl body is handed over as a JSON string instead
		let fetch = async (u, init) => {
			let res = await runtime.fetch(u, init);
			let body = await res.text();
			if (res.ok) text = body;
			return { status: res.status, ok: res.ok, statusText: res.statusText, headers: res.headers, text: async () => (res.ok ? "{}" : body) };
		};
		let { res, json, retries } = await llm.postWithRetry(fetch, url, {
			method: "GET",
			headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
		}, retryOpts());
		if (!res.ok) throw llm.httpError("Claude 批次結果", res, json, retries);
		return text;
	}

	/** Does the batch path apply to a run that needs `count` AI notes? */
	function applies(count, action, settings) {
		let l = settings && settings.llm;
		return !!l && l.enabled && l.batchAPI && l.provider === "anthropic" && !action.silent
			&& count >= (l.batchThreshold || 10);
	}

	function needsAI(item, action) {
		return action.ai === "regenerate" || (action.ai === "missing" && !scope.ZB.adapter.getAINote(item));
	}

	/**
	 * What the normal path would send for this item (syncItem: data, notes, annotation images, the
	 * scanned PDF), as Batches params; null when there is nothing to read (the normal sync skips the AI).
	 */
	async function prepare(item, settings, ctx) {
		let ZB = scope.ZB;
		let data = await ZB.adapter.extractItemData(item, { fullTextLimit: settings.llm.fullTextLimit, checkFullText: true });
		let notesMarkdown = ZB.main.notesFor(settings, data);
		let messages = [];
		// The same Markdown full text the normal path sends (fulltext.js, when 「全文筆記」 is on)
		await ZB.main.prepareFullText(data, settings.llm, messages);
		let images = await ZB.images.collect(data, { targets: new Set(), ai: true }, ctx, messages);
		let aiInput = await ZB.scanned.prepareAIInput(data, settings.llm, notesMarkdown, IOUtils);
		messages.push(...aiInput.messages);
		if (aiInput.skip) return null;
		let promptImages = await ZB.images.forPrompt(images, settings.llm, ctx, messages);
		let body = ZB.llm.noteRequestBody(settings.llm, data, ZB.main.noteOptions(settings, data, notesMarkdown, promptImages, aiInput.pdf));
		return { params: batchParams(body), pdf: !!aiInput.pdf, messages };
	}

	/**
	 * Send the items that need an AI note as Message Batches. Returns the items the normal loop still
	 * has to sync: those that need no AI, have nothing to read, or could not be batched.
	 */
	async function submit(items, action, settings) {
		let ZB = scope.ZB;
		let pw = new Zotero.ProgressWindow({ closeOnClick: true });
		pw.changeHeadline("Zotero Bridge：AI 批次");
		pw.show();
		let line = new pw.ItemProgress("", "準備 AI 批次…");
		let ctx = {};
		let rest = [];
		let entries = [];
		for (let item of items) {
			if (!needsAI(item, action)) {
				rest.push(item);
				continue;
			}
			try {
				let prepared = await prepare(item, settings, ctx);
				if (!prepared) {
					rest.push(item);
					continue;
				}
				entries.push(Object.assign({ item, ref: ZB.main.itemRef(item) }, prepared));
				line.setText(`準備 AI 批次…（${entries.length} 筆）`);
			}
			catch (e) {
				Zotero.logError(e);
				rest.push(item);
			}
		}
		if (!entries.length) {
			line.setText("沒有可送出的文獻，改用一般模式");
			line.setProgress(100);
			pw.startCloseTimer(5000);
			return items;
		}
		let ids = assignCustomIds(entries.map(e => e.ref));
		entries.forEach((e, i) => { e.id = ids[i]; });
		let key = settings.llm.apiKey;
		let sent = 0;
		let errors = [];
		let byId = new Map(entries.map(e => [e.id, e]));
		for (let chunk of chunkRequests(entries.map(e => ({ custom_id: e.id, params: e.params })))) {
			let chunkEntries = chunk.map(r => byId.get(r.custom_id));
			try {
				let created = await api("POST", API, key, { requests: chunk });
				if (!created || typeof created.id !== "string") throw new Error("批次 API 沒有回傳批次 ID");
				let state = readState();
				state.batches.push({
					id: created.id,
					createdAt: created.created_at || runtime.now().toISOString(),
					expiresAt: created.expires_at || "",
					model: settings.llm.model,
					action: { targets: [...action.targets], ai: action.ai },
					status: created.processing_status || "in_progress",
					counts: created.request_counts || null,
					checkedAt: runtime.now().toISOString(),
					requests: chunkEntries.map(e => ({
						id: e.id, ref: e.ref, title: e.item.getField("title") || e.item.key, pdf: e.pdf, notes: e.messages,
					})),
				});
				writeState(state);
				sent += chunkEntries.length;
			}
			catch (e) {
				Zotero.logError(e);
				errors.push(e.message || String(e));
				rest.push(...chunkEntries.map(x => x.item));
			}
		}
		// Keep the original order for the normal loop
		let order = new Map(items.map((it, i) => [it, i]));
		rest.sort((a, b) => order.get(a) - order.get(b));
		if (sent) {
			line.setText(`已送出 AI 批次：${sent} 筆（約半價）`);
			line.setProgress(100);
			pw.addDescription("通常 1 小時內完成（最長 24 小時）；完成後會自動寫入 AI 筆記並同步，Zotero 關閉後下次開啟會繼續檢查。"
				+ "進度：工具 → 檢查 AI 批次進度");
			polls = 0;
			schedule(pollDelay(0));
		}
		else {
			line.setText("AI 批次送出失敗");
			line.setError();
		}
		if (errors.length) pw.addDescription(`⚠️ 批次 API：${errors[0]}；${rest.length} 筆改用一般模式`);
		pw.startCloseTimer(errors.length ? 15000 : 8000);
		return rest;
	}

	// ---------- polling ----------

	function schedule(ms) {
		if (timer) clearTimeout(timer);
		timer = !stopped && readState().batches.length ? setTimeout(tick, ms) : null;
	}

	async function tick() {
		timer = null;
		try {
			await check({ auto: true });
		}
		catch (e) {
			Zotero.logError(e);
		}
		schedule(pollDelay(++polls));
	}

	/** Poll every stored batch; ended ones are applied. One check at a time. */
	function check(opts = {}) {
		if (!checking) {
			checking = checkNow(opts).finally(() => {
				checking = null;
			});
		}
		return checking;
	}

	async function checkNow(opts) {
		let state = readState();
		if (!state.batches.length) {
			if (opts.manual) scope.ZB.main.notify("Zotero Bridge：AI 批次", "目前沒有處理中的 AI 批次。");
			return [];
		}
		let key = await apiKey();
		let lines = [];
		for (let stored of state.batches) {
			if (stopped) break;
			let batch = stored;
			try {
				let info = await api("GET", `${API}/${encodeURIComponent(stored.id)}`, key);
				batch = updateBatch(stored.id, (b) => {
					b.status = info.processing_status || b.status;
					b.counts = info.request_counts || b.counts;
					b.resultsUrl = info.results_url || b.resultsUrl || "";
					b.endedAt = info.ended_at || b.endedAt || "";
					b.checkedAt = runtime.now().toISOString();
				}) || stored;
				if (batch.status === "ended") {
					await finish(batch, key);
					lines.push(`${describeBatch(batch, runtime.now())}；結果已寫入`);
					continue;
				}
			}
			catch (e) {
				Zotero.logError(e);
				if (e.status === 404 || tooOld(stored)) {
					// Gone (another workspace or key, or results past their 29 days): retry on the normal path
					giveUp(stored, `找不到 AI 批次 ${stored.id}（${e.message || e}）`);
					lines.push(`⚠️ 找不到 AI 批次，${stored.requests.length} 筆已列入「繼續未完成的同步」`);
					continue;
				}
				lines.push(`${describeBatch(batch, runtime.now())}；⚠️ 無法查詢（${e.message || e}）`);
				continue;
			}
			lines.push(describeBatch(batch, runtime.now()));
		}
		if (opts.manual) scope.ZB.main.notify("Zotero Bridge：AI 批次進度", lines.join("\n"));
		return lines;
	}

	function tooOld(batch) {
		let age = Date.parse(runtime.now().toISOString()) - Date.parse(batch.createdAt);
		return Number.isFinite(age) && age > RESULTS_DAYS * 24 * 3600 * 1000;
	}

	function giveUp(batch, reason) {
		removeBatch(batch.id);
		let refs = batch.requests.filter(r => !r.done).map(r => r.ref);
		scope.ZB.main.enqueue(() => scope.ZB.main.addPendingFailures(refs, batch.action)).catch(e => Zotero.logError(e));
		scope.ZB.main.notify("Zotero Bridge：AI 批次", `${reason}。要重試：工具 → 繼續未完成的 Zotero Bridge 同步。`);
	}

	function getItem(ref) {
		let slash = ref.indexOf("/");
		let item = Zotero.Items.getByLibraryAndKey(Number(ref.slice(0, slash)), ref.slice(slash + 1));
		return item && !item.deleted ? item : null;
	}

	/**
	 * An ended batch: download the results, write the AI notes (as the normal path does), sync those
	 * items, and list the rest for 「繼續未完成的同步」.
	 */
	async function finish(batch, key) {
		let ZB = scope.ZB;
		let text = batch.resultsUrl ? await fetchResults(batch.resultsUrl, key) : "";
		let { results, invalid } = parseResults(text);
		if (invalid) Zotero.debug(`Zotero Bridge: ${invalid} unreadable line(s) in the results of ${batch.id}`);
		let byId = new Map(results.map(r => [r.customId, r]));
		let pw = new Zotero.ProgressWindow({ closeOnClick: true });
		pw.changeHeadline("Zotero Bridge：AI 批次完成");
		pw.show();
		// Notes are written between sync runs, never during one
		let outcome = await ZB.main.enqueue(() => applyResults(batch, byId, pw));
		if (stopped) return outcome;
		removeBatch(batch.id);
		let usageLine = ZB.main.runUsageLine(outcome.usage);
		pw.addDescription(`AI 批次：成功 ${outcome.ok.length} 筆${outcome.failed.length ? `，失敗 ${outcome.failed.length} 筆` : ""}`
			+ (outcome.gone ? `，${outcome.gone} 筆已刪除` : ""));
		if (outcome.failed.length) pw.addDescription("要重試失敗的文獻（一般模式）：工具 → 繼續未完成的 Zotero Bridge 同步");
		if (usageLine) pw.addDescription(usageLine);
		pw.startCloseTimer(outcome.failed.length ? 20000 : 10000);
		// Sync the new notes like 「同步但不呼叫 AI」, then list the failures (after the run, which keeps
		// its own stop/resume record)
		if (outcome.ok.length) {
			try {
				await ZB.main.run(outcome.ok, { targets: batch.action.targets, ai: "reuse" });
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
		if (outcome.failed.length) {
			await ZB.main.enqueue(() => ZB.main.addPendingFailures(outcome.failed, batch.action));
		}
		return outcome;
	}

	async function applyResults(batch, byId, pw) {
		let ZB = scope.ZB;
		let settings = await ZB.main.readSettings();
		let usage = { ledger: {} };
		let ok = [];
		let failed = [];
		let gone = 0;
		for (let req of batch.requests) {
			if (stopped) break;
			let item = getItem(req.ref);
			if (!item) {
				gone++;
				continue;
			}
			if (req.done) {
				ok.push(item);
				continue;
			}
			let title = req.title || req.ref;
			let line = new pw.ItemProgress(item.getItemTypeIconName(), title);
			let result = interpretResult(byId.get(req.id), batch.model);
			let messages = (req.notes || []).slice();
			try {
				if (!result.ok) throw new Error(result.error);
				let data = await ZB.adapter.extractItemData(item, { fullTextLimit: settings.llm.fullTextLimit, checkFullText: true });
				await ZB.main.prepareFullText(data, settings.llm, null);
				// What the AI read when the request was built (scanned.generateWithPDF sets this)
				data.aiReadPDF = !!req.pdf;
				ZB.main.recordAIUsage({ model: result.model, usage: result.usage, batch: true }, usage);
				let processed = ZB.main.processGeneratedNote(result.text.trim(), data);
				messages.push(...processed.messages);
				let at = runtime.now().toISOString();
				await ZB.main.saveGeneratedNote(item, { md: processed.md, model: result.model || batch.model, at, data: processed.data }, processed);
				updateBatch(batch.id, (b) => {
					let r = b.requests.find(x => x.id === req.id);
					if (r) r.done = true;
				});
				ok.push(item);
				line.setText(messages.length ? `${title} — ${messages.join("；")}` : title);
				line.setProgress(100);
			}
			catch (e) {
				failed.push(req.ref);
				line.setText(`${title} — AI 筆記：${e.message || e}`);
				line.setError();
			}
		}
		return { ok, failed, gone, usage };
	}

	// ---------- cancel ----------

	/** Tools menu: cancel every batch still in progress (results already done are kept). */
	async function cancelAll() {
		let state = readState();
		let open = state.batches.filter(b => b.status !== "ended");
		if (!open.length) {
			scope.ZB.main.notify("Zotero Bridge：AI 批次", "目前沒有處理中的 AI 批次。");
			return 0;
		}
		let n = open.reduce((sum, b) => sum + b.requests.length, 0);
		if (!Services.prompt.confirm(Zotero.getMainWindow(), "Zotero Bridge",
			`要取消 ${open.length} 個 AI 批次（${n} 筆）嗎？\n\n已經完成的文獻仍會寫入筆記並同步；尚未處理的不收費，`
			+ "會列入「繼續未完成的 Zotero Bridge 同步」，之後可用一般模式重試。")) return 0;
		let key = await apiKey();
		let canceled = 0;
		let errors = [];
		for (let b of open) {
			try {
				let info = await api("POST", `${API}/${encodeURIComponent(b.id)}/cancel`, key, undefined);
				updateBatch(b.id, (x) => {
					x.status = info.processing_status || "canceling";
					x.counts = info.request_counts || x.counts;
				});
				canceled++;
			}
			catch (e) {
				Zotero.logError(e);
				errors.push(e.message || String(e));
			}
		}
		scope.ZB.main.notify("Zotero Bridge：AI 批次", errors.length ? `⚠️ 無法取消：${errors[0]}`
			: "已要求取消；批次結束後會寫入已完成的筆記，其餘列入「繼續未完成的同步」。");
		// Canceling takes a moment: look again soon
		polls = 0;
		schedule(pollDelay(0));
		return canceled;
	}

	// ---------- menu, lifecycle ----------

	function registerMenus({ pluginID }) {
		let id = Zotero.MenuManager.registerMenu({
			menuID: "zotero-bridge-ai-batch-tools",
			pluginID,
			target: "main/menubar/tools",
			menus: [
				{
					menuType: "menuitem",
					l10nID: "zotero-bridge-menu-ai-batch-check",
					onShowing: (ev, context) => context.setVisible(readState().batches.length > 0),
					onCommand: () => check({ manual: true }).catch(e => Zotero.logError(e)),
				},
				{
					menuType: "menuitem",
					l10nID: "zotero-bridge-menu-ai-batch-cancel",
					onShowing: (ev, context) => context.setVisible(readState().batches.some(b => b.status !== "ended")),
					onCommand: () => cancelAll().catch(e => Zotero.logError(e)),
				},
			],
		});
		return [id].filter(Boolean);
	}

	function init() {
		stopped = false;
		polls = 0;
		// Batches submitted before the last restart: polling resumes
		schedule(STARTUP_DELAY_MS);
	}

	function shutdown() {
		stopped = true;
		if (timer) clearTimeout(timer);
		timer = null;
	}

	return {
		API, CUSTOM_ID_RE, MAX_REQUESTS, MAX_BATCH_BYTES, STARTUP_DELAY_MS, POLL_MIN_MS, POLL_MAX_MS, STATE_PREF,
		encodeCustomId, decodeCustomId, assignCustomIds, batchParams, chunkRequests, parseResults, interpretResult,
		pollDelay, parseState, describeBatch,
		runtime, applies, submit, check, cancelAll, readState, registerMenus, init, shutdown,
		get timerActive() { return !!timer; },
	};
});
