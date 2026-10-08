/*
 * Zotero Bridge — AI usage ledger and cost estimates (pure functions; persistence lives in main.js).
 * Ledger: { "2026-10": { calls, input, output, cacheRead, cacheWrite, byModel: { <model>: { same counters } } } }
 * Token fields follow llm.parseUsage(): `input` is full-price input, cache reads/writes are separate;
 * cacheWrite1h (only stored when non-zero) is the part of cacheWrite written with the 1-hour TTL.
 * Calls through the Message Batches API are kept under "<model> (batch)" and priced at BATCH_DISCOUNT.
 */
(function (root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) {
		module.exports = api;
	}
	else {
		(root.ZB = root.ZB || {}).usage = api;
	}
})(this, function () {
	// USD per million tokens. Claude cache writes default to 1.25 × input (5-minute TTL) and 2 × input
	// (1-hour TTL), cache reads to 0.1 × input, unless the entry sets cacheWrite / cacheWrite1h / cacheRead.
	// OpenAI models are left unpriced on purpose (tokens are still counted).
	const DEFAULT_PRICES = {
		"claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
		"claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
		"claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
	};
	const CACHE_WRITE_FACTOR = 1.25;
	const CACHE_WRITE_1H_FACTOR = 2;
	const CACHE_READ_FACTOR = 0.1;
	// Message Batches API: every token (cache reads and writes included) at 50% of the standard price
	const BATCH_DISCOUNT = 0.5;
	const BATCH_SUFFIX = " (batch)";
	const COUNTERS = ["calls", "input", "output", "cacheRead", "cacheWrite"];
	// Counters stored only when non-zero (keeps older ledgers and their shape unchanged)
	const OPTIONAL_COUNTERS = ["cacheWrite1h"];
	const KEEP_MONTHS = 24;

	function emptyCounters() {
		return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	}

	function num(n) {
		n = Number(n);
		return Number.isFinite(n) && n > 0 ? n : 0;
	}

	function monthKey(date = new Date()) {
		return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
	}

	function isPlainObject(v) {
		return !!v && typeof v === "object" && !Array.isArray(v);
	}

	function copyCounters(target, source) {
		for (let k of COUNTERS) target[k] = num(source[k]);
		for (let k of OPTIONAL_COUNTERS) {
			if (num(source[k])) target[k] = num(source[k]);
		}
		return target;
	}

	/** Is this ledger key a Message Batches entry ("<model> (batch)")? */
	function isBatchKey(key) {
		return String(key).endsWith(BATCH_SUFFIX);
	}

	function baseModel(key) {
		return isBatchKey(key) ? String(key).slice(0, -BATCH_SUFFIX.length) : String(key);
	}

	/** Parse the stored ledger, dropping anything malformed. */
	function parseLedger(text) {
		let raw;
		try {
			raw = typeof text === "string" ? JSON.parse(text || "{}") : text;
		}
		catch (e) {
			return {};
		}
		if (!isPlainObject(raw)) return {};
		let out = {};
		for (let [month, entry] of Object.entries(raw)) {
			if (!/^\d{4}-\d{2}$/.test(month) || !isPlainObject(entry)) continue;
			let m = copyCounters(emptyCounters(), entry);
			m.byModel = {};
			for (let [model, c] of Object.entries(isPlainObject(entry.byModel) ? entry.byModel : {})) {
				if (!isPlainObject(c)) continue;
				m.byModel[model] = copyCounters(emptyCounters(), c);
			}
			out[month] = m;
		}
		return out;
	}

	/**
	 * Add one call to the ledger (returns a new ledger; the input is not modified).
	 * @param {object} call { model, usage: { input, output, cacheRead, cacheWrite, cacheWrite1h }, batch }
	 *   batch: true for a Message Batches result (recorded under "<model> (batch)", priced at half)
	 */
	function recordUsage(ledger, call, date = new Date()) {
		let out = parseLedger(JSON.stringify(ledger || {}));
		let key = monthKey(date);
		let month = out[key] || Object.assign(emptyCounters(), { byModel: {} });
		let model = String((call && call.model) || "unknown") + (call && call.batch ? BATCH_SUFFIX : "");
		let byModel = month.byModel[model] || emptyCounters();
		let u = (call && call.usage) || {};
		for (let target of [month, byModel]) {
			target.calls += 1;
			target.input += num(u.input);
			target.output += num(u.output);
			target.cacheRead += num(u.cacheRead);
			target.cacheWrite += num(u.cacheWrite);
			let write1h = Math.min(num(u.cacheWrite1h), num(u.cacheWrite));
			if (write1h) target.cacheWrite1h = num(target.cacheWrite1h) + write1h;
		}
		month.byModel[model] = byModel;
		out[key] = month;
		// Keep the pref small: only the most recent months
		let months = Object.keys(out).sort();
		for (let old of months.slice(0, Math.max(0, months.length - KEEP_MONTHS))) delete out[old];
		return out;
	}

	/** Parse the user's price table (JSON); empty or invalid → built-in table. */
	function parsePrices(text) {
		if (!text || !String(text).trim()) return { prices: DEFAULT_PRICES, error: null };
		let raw;
		try {
			raw = JSON.parse(text);
		}
		catch (e) {
			return { prices: DEFAULT_PRICES, error: `價格表不是有效的 JSON：${e.message}` };
		}
		if (!isPlainObject(raw)) return { prices: DEFAULT_PRICES, error: "價格表必須是 { \"模型\": { \"input\": 數字, \"output\": 數字 } }" };
		let prices = {};
		for (let [model, p] of Object.entries(raw)) {
			if (!isPlainObject(p)) continue;
			let input = Number(p.input);
			let output = Number(p.output);
			if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) continue;
			let entry = { input, output };
			for (let k of ["cacheRead", "cacheWrite", "cacheWrite1h"]) {
				if (p[k] !== undefined && Number.isFinite(Number(p[k])) && Number(p[k]) >= 0) entry[k] = Number(p[k]);
			}
			prices[model] = entry;
		}
		return { prices, error: null };
	}

	/**
	 * Exact match, else the longest table key the model starts with (e.g. a dated snapshot ID).
	 * A batch ledger key ("<model> (batch)") gets its model's price (see costOf's `batch`).
	 */
	function priceFor(model, prices) {
		if (!model || !prices) return null;
		model = baseModel(model);
		if (prices[model]) return prices[model];
		let best = null;
		for (let key of Object.keys(prices)) {
			if (model.startsWith(key + "-") && (!best || key.length > best.length)) best = key;
		}
		return best ? prices[best] : null;
	}

	/** Per-million prices of the cache: { read, write (5-minute TTL), write1h }. */
	function cachePrices(price) {
		return {
			read: price.cacheRead !== undefined ? price.cacheRead : price.input * CACHE_READ_FACTOR,
			write: price.cacheWrite !== undefined ? price.cacheWrite : price.input * CACHE_WRITE_FACTOR,
			write1h: price.cacheWrite1h !== undefined ? price.cacheWrite1h : price.input * CACHE_WRITE_1H_FACTOR,
		};
	}

	/**
	 * USD cost of token counts at a price entry (per million tokens).
	 * @param {boolean} [batch] Message Batches API: everything at BATCH_DISCOUNT
	 */
	function costOf(counters, price, batch = false) {
		if (!price) return null;
		let cache = cachePrices(price);
		let write1h = Math.min(num(counters.cacheWrite1h), num(counters.cacheWrite));
		let cost = (num(counters.input) * price.input
			+ num(counters.output) * price.output
			+ num(counters.cacheRead) * cache.read
			+ (num(counters.cacheWrite) - write1h) * cache.write
			+ write1h * cache.write1h) / 1e6;
		return batch ? cost * BATCH_DISCOUNT : cost;
	}

	/**
	 * What prompt caching saved on these counters (negative: cache writes cost more than they saved
	 * so far): the cached tokens at the full input price minus what they cost.
	 */
	function cacheSavings(counters, price, batch = false) {
		if (!price) return null;
		let cache = cachePrices(price);
		let write1h = Math.min(num(counters.cacheWrite1h), num(counters.cacheWrite));
		let saved = (num(counters.cacheRead) * (price.input - cache.read)
			- (num(counters.cacheWrite) - write1h) * (cache.write - price.input)
			- write1h * (cache.write1h - price.input)) / 1e6;
		return batch ? saved * BATCH_DISCOUNT : saved;
	}

	function totalTokens(c) {
		return num(c.input) + num(c.output) + num(c.cacheRead) + num(c.cacheWrite);
	}

	/**
	 * Totals for one month (or any ledger-shaped month entry).
	 * cost sums priced models only; unpricedCalls counts calls whose model has no price.
	 */
	function summarize(month, prices) {
		let s = emptyCounters();
		s.cost = 0;
		s.unpricedCalls = 0;
		s.unpricedModels = [];
		// Message Batches calls, what the batch discount saved, what prompt caching saved
		s.batchCalls = 0;
		s.batchSavings = 0;
		s.cacheSavings = 0;
		if (!month) return Object.assign(s, { tokens: 0, priced: false });
		for (let k of COUNTERS) s[k] = num(month[k]);
		for (let [model, c] of Object.entries(month.byModel || {})) {
			let price = priceFor(model, prices);
			let batch = isBatchKey(model);
			if (batch) s.batchCalls += num(c.calls);
			if (price) {
				s.cost += costOf(c, price, batch);
				if (batch) s.batchSavings += costOf(c, price) - costOf(c, price, true);
				s.cacheSavings += cacheSavings(c, price, batch);
			}
			else {
				s.unpricedCalls += num(c.calls);
				s.unpricedModels.push(model);
			}
		}
		s.tokens = totalTokens(s);
		s.priced = s.calls > s.unpricedCalls;
		return s;
	}

	/**
	 * Rough cost of `n` more calls on `model`, from the average tokens of its past calls (normal and
	 * batch calls alike). `batch`: priced for the Message Batches API.
	 * Returns null when the model is unpriced or has no history.
	 */
	function estimateCost(ledger, model, prices, n, batch = false) {
		let price = priceFor(model, prices);
		if (!price || !(n > 0)) return null;
		let total = emptyCounters();
		for (let month of Object.values(ledger || {})) {
			for (let [m, c] of Object.entries((month && month.byModel) || {})) {
				if (priceFor(m, prices) !== price) continue;
				for (let k of COUNTERS) total[k] += num(c[k]);
			}
		}
		if (!total.calls) return null;
		let avg = {};
		for (let k of ["input", "output", "cacheRead", "cacheWrite"]) avg[k] = total[k] / total.calls;
		let perCall = costOf(avg, price, batch);
		return { perCall, total: perCall * n, samples: total.calls, avgTokens: totalTokens(avg) };
	}

	function formatTokens(n) {
		return Math.round(num(n)).toLocaleString("en-US");
	}

	function formatUSD(x) {
		if (!Number.isFinite(x)) return "";
		if (x > 0 && x < 0.01) return "< US$0.01";
		return `US$${x.toFixed(2)}`;
	}

	/** One line for the progress window after an AI run. */
	function describeRun(month, prices) {
		let s = summarize(month, prices);
		if (!s.calls) return "";
		let line = `AI 用量：${s.calls} 次呼叫，輸入 ${formatTokens(s.input + s.cacheRead + s.cacheWrite)}／輸出 ${formatTokens(s.output)} tokens`;
		if (s.priced) line += `，約 ${formatUSD(s.cost)}${s.unpricedCalls ? "（部分模型未定價）" : ""}`;
		return line;
	}

	/** Lines for the settings pane ("本月 AI 用量"). */
	function describeMonth(month, prices) {
		let s = summarize(month, prices);
		if (!s.calls) return ["本月尚未呼叫 AI。"];
		let lines = [
			`呼叫次數：${s.calls}`,
			`Tokens：輸入 ${formatTokens(s.input)}${s.cacheRead || s.cacheWrite ? `（另有快取讀取 ${formatTokens(s.cacheRead)}、快取寫入 ${formatTokens(s.cacheWrite)}）` : ""}／輸出 ${formatTokens(s.output)}`,
		];
		if (s.priced) {
			lines.push(`估計費用：${formatUSD(s.cost)}${s.unpricedCalls ? `（不含未定價模型 ${s.unpricedModels.join(", ")} 的 ${s.unpricedCalls} 次呼叫）` : ""}`);
			if (s.batchCalls) lines.push(`批次 API：${s.batchCalls} 次呼叫，比一般模式省下約 ${formatUSD(s.batchSavings)}`);
			if (s.cacheRead || s.cacheWrite) {
				lines.push(s.cacheSavings >= 0 ? `提示快取：省下約 ${formatUSD(s.cacheSavings)}`
					: `提示快取：快取寫入比節省的多 ${formatUSD(-s.cacheSavings)}（之後的呼叫讀取快取才會回本）`);
			}
		}
		else {
			lines.push(`估計費用：模型 ${s.unpricedModels.join(", ")} 未定價，只顯示 tokens`);
		}
		let models = Object.entries((month && month.byModel) || {}).sort((a, b) => b[1].calls - a[1].calls);
		if (models.length > 1) {
			for (let [model, c] of models) {
				let cost = costOf(c, priceFor(model, prices), isBatchKey(model));
				let name = isBatchKey(model) ? `${baseModel(model)}（批次）` : model;
				lines.push(`　${name}：${c.calls} 次，${formatTokens(totalTokens(c))} tokens${cost === null ? "" : `，${formatUSD(cost)}`}`);
			}
		}
		return lines;
	}

	return {
		DEFAULT_PRICES, CACHE_WRITE_FACTOR, CACHE_WRITE_1H_FACTOR, CACHE_READ_FACTOR, BATCH_DISCOUNT, BATCH_SUFFIX,
		monthKey, parseLedger, recordUsage, parsePrices, priceFor, costOf, cacheSavings, isBatchKey, baseModel,
		summarize, estimateCost, formatTokens, formatUSD, describeRun, describeMonth,
	};
});
