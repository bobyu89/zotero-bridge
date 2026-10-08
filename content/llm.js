/*
 * Zotero Bridge — LLM step: turns a Zotero item into a structured literature note.
 * Providers: Anthropic (Claude Messages API) and OpenAI (Responses API).
 * Raw HTTP is used because the plugin runs in Zotero's privileged sandbox without a module bundler.
 */
(function (root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) {
		module.exports = api;
	}
	else {
		(root.ZB = root.ZB || {}).llm = api;
	}
})(this, function () {
	const DEFAULT_MODELS = {
		anthropic: "claude-opus-5-5",
		openai: "gpt-5.5",
	};

	const SUMMARY_HEADING = "一句話摘要";

	const DEFAULT_SYSTEM_PROMPT = `你是護理與醫學領域的研究助理，負責把一篇文獻整理成結構化的「文獻筆記」，供研究生在 Obsidian 與 Notion 中閱讀與建立知識連結。

寫作規則：
- 使用繁體中文；醫學、統計與研究方法術語保留英文（例如 randomized controlled trial、odds ratio、95% CI）。
- 只根據提供的書目資料、摘要、全文、註記與筆記撰寫；資料中沒有的資訊寫「文中未報告」，不要推測或編造數據、作者、頁碼或參考文獻。
- 數據要具體：樣本數、效應量、p 值、信賴區間照原文寫出。
- 引用使用者的劃線或全文時，標示頁碼（例如 p. 5）。
- 「關鍵概念」用 Obsidian 雙中括號 [[概念]] 標記 3–8 個可跨文獻重複使用的概念，名稱用通用寫法（例如 [[Self-efficacy]]、[[Fall prevention]]）。
- 不要使用表格；不要輸出 APA 參考文獻（系統會由 Zotero 自動產生）；不要加前言或結語，直接輸出 Markdown。

輸出格式（標題必須完全一致）：
## ${SUMMARY_HEADING}
（一句話，60 字以內）

## 研究背景與目的

## 研究設計與方法
- 研究設計：
- 場域與樣本：
- 介入／暴露：
- 測量工具（含信效度）：
- 統計分析：

## 主要結果

## 作者結論

## 研究限制
- 作者自述：
- 批判性評讀：

## 證據等級
（依 Oxford CEBM 或 JBI Levels of Evidence，說明理由）

## 對我的研究的啟發

## 關鍵概念

## 可引用的句子
`;

	function formatAnnotationsForPrompt(data) {
		let lines = [];
		for (let att of data.attachments || []) {
			for (let ann of att.annotations || []) {
				let page = ann.pageLabel ? `p. ${ann.pageLabel}` : "";
				let text = ann.text ? `「${ann.text}」` : `[${ann.type}]`;
				let comment = ann.comment ? ` — 使用者評註：${ann.comment}` : "";
				lines.push(`- ${page} ${text}${comment}`.replace(/\s+/g, " ").trim());
			}
		}
		return lines.join("\n");
	}

	/**
	 * @param {object} data - item data from the Zotero adapter (may include fullText)
	 * @param {object} opts - { systemPrompt, notesMarkdown: [{title, md}], fullTextTruncated }
	 */
	function buildPrompt(data, opts = {}) {
		let meta = [
			`標題：${data.title || ""}`,
			`作者：${(data.creators || []).map(c => c.name || [c.lastName, c.firstName].filter(Boolean).join(", ")).join("; ")}`,
			`年份：${data.year || ""}`,
			`期刊／出處：${data.publication || ""}`,
			`文獻類型：${data.itemType || ""}`,
			data.doi ? `DOI：${data.doi}` : "",
			data.tags && data.tags.length ? `使用者標籤：${data.tags.join(", ")}` : "",
		].filter(Boolean).join("\n");

		let sections = [`<metadata>\n${meta}\n</metadata>`];
		if (data.abstract) sections.push(`<abstract>\n${data.abstract}\n</abstract>`);
		let anns = formatAnnotationsForPrompt(data);
		if (anns) sections.push(`<user_annotations>\n${anns}\n</user_annotations>`);
		let notes = (opts.notesMarkdown || []).map(n => n.md).filter(Boolean).join("\n\n---\n\n");
		if (notes) sections.push(`<user_notes>\n${notes}\n</user_notes>`);
		if (data.fullText) {
			let note = opts.fullTextTruncated ? "（全文過長，以下只提供前段內容；後段未提供的部分請勿推測）\n" : "";
			sections.push(`<fulltext>\n${note}${data.fullText}\n</fulltext>`);
		}
		else {
			sections.push("（沒有可用的全文，只能依據書目資料、摘要與註記撰寫；無法判斷的欄位寫「文中未報告」。）");
		}
		sections.push("請依照系統指示的格式輸出這篇文獻的結構化筆記。");
		return {
			system: (opts.systemPrompt && opts.systemPrompt.trim()) || DEFAULT_SYSTEM_PROMPT,
			user: sections.join("\n\n"),
		};
	}

	async function readJSON(res) {
		let text = await res.text();
		try {
			return text ? JSON.parse(text) : {};
		}
		catch (e) {
			return { raw: text };
		}
	}

	// ---------- HTTP: retries ----------

	// Transient statuses worth retrying (529 = Anthropic "overloaded"). 400/401/403/404 and refusals are final.
	const RETRY_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
	const MAX_RETRIES = 4;
	const BACKOFF_BASE_MS = 1000;
	const BACKOFF_MAX_MS = 30000;
	// A server-requested delay longer than this is ignored in favor of normal backoff
	const MAX_RETRY_AFTER_MS = 60000;

	function defaultSleep(ms) {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	function header(res, name) {
		let h = res && res.headers;
		if (!h) return null;
		let v = typeof h.get === "function" ? h.get(name) : h[name];
		return v === undefined ? null : v;
	}

	/** Delay requested by `retry-after-ms` or `retry-after` (seconds or HTTP date), in ms; null if absent/unusable. */
	function retryAfterMs(res, now = Date.now()) {
		let ms = Number.parseFloat(header(res, "retry-after-ms"));
		if (!Number.isFinite(ms)) {
			let value = header(res, "retry-after");
			if (value !== null && String(value).trim() !== "") {
				let secs = Number(value);
				if (Number.isFinite(secs)) {
					ms = secs * 1000;
				}
				else {
					let date = Date.parse(value);
					if (Number.isFinite(date)) ms = Math.max(0, date - now);
				}
			}
		}
		if (!Number.isFinite(ms) || ms < 0 || ms > MAX_RETRY_AFTER_MS) return null;
		return Math.round(ms);
	}

	/** Exponential backoff for retry number `attempt` (0-based), reduced by up to 25% jitter. */
	function backoffDelay(attempt, random = Math.random) {
		let base = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
		return Math.round(base * (1 - 0.25 * random()));
	}

	/**
	 * POST with retries on transient HTTP statuses and network errors.
	 * @param {object} opts { sleep, maxRetries, random, onRetry({ attempt, maxRetries, delay, status, error }) }
	 * @returns {Promise<{ res, json, retries }>} the final response (which may still be an error status)
	 */
	async function postWithRetry(fetch, url, init, opts = {}) {
		let sleep = opts.sleep || defaultSleep;
		let maxRetries = opts.maxRetries === undefined ? MAX_RETRIES : opts.maxRetries;
		let random = opts.random || Math.random;
		for (let attempt = 0; ; attempt++) {
			let res = null;
			let json = null;
			let error = null;
			try {
				res = await fetch(url, init);
				json = await readJSON(res);
			}
			catch (e) {
				// fetch rejects (TypeError) when the network fails or the connection drops mid-body
				error = e;
			}
			let retryable = error ? true : RETRY_STATUSES.has(res.status);
			if (!retryable || attempt >= maxRetries) {
				if (error) throw error;
				return { res, json, retries: attempt };
			}
			let requested = error ? null : retryAfterMs(res);
			let delay = requested === null ? backoffDelay(attempt, random) : requested;
			if (opts.onRetry) {
				try {
					opts.onRetry({ attempt: attempt + 1, maxRetries, delay, status: error ? null : res.status, error });
				}
				catch (e) {}
			}
			await sleep(delay);
		}
	}

	function httpError(label, res, json, retries) {
		let msg = (json.error && json.error.message) || json.raw || res.statusText;
		let err = new Error(`${label} ${res.status}: ${msg}${retries ? `（已重試 ${retries} 次）` : ""}`);
		err.status = res.status;
		return err;
	}

	// ---------- HTTP: token usage ----------

	function count(n) {
		return Number.isFinite(n) && n > 0 ? n : 0;
	}

	/**
	 * Normalize token usage to { input, output, cacheRead, cacheWrite }. `input` counts full-price input only:
	 * Claude's input_tokens already excludes cache reads/writes; OpenAI's input_tokens includes cached_tokens.
	 */
	function parseUsage(provider, json) {
		let u = (json && json.usage) || {};
		if (provider === "openai") {
			let cached = count(u.input_tokens_details && u.input_tokens_details.cached_tokens);
			return {
				input: Math.max(0, count(u.input_tokens) - cached),
				output: count(u.output_tokens),
				cacheRead: cached,
				cacheWrite: 0,
			};
		}
		return {
			input: count(u.input_tokens),
			output: count(u.output_tokens),
			cacheRead: count(u.cache_read_input_tokens),
			cacheWrite: count(u.cache_creation_input_tokens),
		};
	}

	// ---------- providers ----------

	async function callAnthropic({ apiKey, model, effort, system, user, fetch, retry }) {
		let { res, json, retries } = await postWithRetry(fetch, "https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
				// Re-run on Anthropic's recommended model if a safety classifier declines
				"anthropic-beta": "server-side-fallback-2026-07-01",
				"anthropic-dangerous-direct-browser-access": "true",
			},
			body: JSON.stringify({
				model: model || DEFAULT_MODELS.anthropic,
				max_tokens: 16000,
				fallbacks: "default",
				output_config: { effort: effort || "medium" },
				system,
				messages: [{ role: "user", content: user }],
			}),
		}, retry);
		if (!res.ok) throw httpError("Claude API", res, json, retries);
		// A refusal is a final answer (HTTP 200), never retried
		if (json.stop_reason === "refusal") {
			let cat = json.stop_details && json.stop_details.category;
			throw new Error(`Claude 拒絕處理這篇文獻${cat ? `（${cat}）` : ""}`);
		}
		let text = (json.content || []).filter(b => b.type === "text").map(b => b.text).join("");
		if (!text.trim()) throw new Error("Claude 沒有回傳內容");
		if (json.stop_reason === "max_tokens") {
			text += "\n\n> ⚠️ 輸出達到長度上限，內容可能不完整。";
		}
		// json.model names the model that answered (it differs from the request after a server-side fallback)
		return { text, model: json.model || model, provider: "anthropic", usage: parseUsage("anthropic", json), retries };
	}

	async function callOpenAI({ apiKey, model, system, user, fetch, baseURL, retry }) {
		let base = (baseURL || "https://api.openai.com/v1").replace(/\/+$/, "");
		let { res, json, retries } = await postWithRetry(fetch, `${base}/responses`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"authorization": `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model: model || DEFAULT_MODELS.openai,
				instructions: system,
				input: user,
			}),
		}, retry);
		if (!res.ok) throw httpError("OpenAI API", res, json, retries);
		let text = typeof json.output_text === "string" ? json.output_text : "";
		if (!text) {
			for (let item of json.output || []) {
				if (item.type !== "message") continue;
				for (let c of item.content || []) {
					if (c.type === "output_text") text += c.text;
					if (c.type === "refusal") throw new Error(`OpenAI 拒絕處理：${c.refusal}`);
				}
			}
		}
		if (!text.trim()) throw new Error("OpenAI 沒有回傳內容");
		if (json.status === "incomplete") {
			text += "\n\n> ⚠️ 輸出未完成，內容可能不完整。";
		}
		return { text, model: json.model || model, provider: "openai", usage: parseUsage("openai", json), retries };
	}

	/**
	 * Run one system + user prompt on the configured provider.
	 * @param {object} [opts] retry options for postWithRetry: { sleep, maxRetries, random, onRetry }
	 * @returns {Promise<{ text, model, provider, usage: { input, output, cacheRead, cacheWrite }, retries }>}
	 */
	async function generateText(settings, system, user, fetch, opts = {}) {
		if (!settings.apiKey) throw new Error("尚未設定 LLM API key");
		let common = { apiKey: settings.apiKey, model: settings.model, system, user, fetch, retry: opts };
		if (settings.provider === "openai") {
			return callOpenAI(Object.assign(common, { baseURL: settings.baseURL }));
		}
		return callAnthropic(Object.assign(common, { effort: settings.effort }));
	}

	async function generateNote(settings, data, opts, fetch, callOpts) {
		let { system, user } = buildPrompt(data, opts);
		return generateText(settings, system, user, fetch, callOpts);
	}

	/** Pull the one-line summary out of the generated note (for the Notion "Summary" property). */
	function extractSummary(md) {
		let re = new RegExp(`^#{1,6}\\s*${SUMMARY_HEADING}\\s*$`, "m");
		let m = re.exec(md || "");
		let rest = m ? md.slice(m.index + m[0].length) : (md || "");
		let next = /^#{1,6}\s/m.exec(rest);
		let section = (next ? rest.slice(0, next.index) : rest).trim();
		return section.split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim().slice(0, 2000);
	}

	return {
		DEFAULT_MODELS, DEFAULT_SYSTEM_PROMPT, buildPrompt, formatAnnotationsForPrompt,
		callAnthropic, callOpenAI, generateText, generateNote, extractSummary,
		RETRY_STATUSES, MAX_RETRIES, postWithRetry, retryAfterMs, backoffDelay, parseUsage,
	};
});
