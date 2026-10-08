const test = require("node:test");
const assert = require("node:assert/strict");
const llm = require("../content/llm.js");
const usage = require("../content/usage.js");

function response(status, json, headers = {}) {
	return {
		status,
		ok: status >= 200 && status < 300,
		statusText: String(status),
		headers: { get: k => (headers[k] === undefined ? null : headers[k]) },
		text: async () => (typeof json === "string" ? json : JSON.stringify(json)),
	};
}

const CLAUDE_OK = {
	model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: "## 一句話摘要\nOK" }],
	usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 40, cache_creation_input_tokens: 10 },
};
const settings = { provider: "anthropic", apiKey: "k", model: "claude-opus-5-5" };

// fetch that replays a script of responses (or thrown errors)
function scripted(steps) {
	let calls = 0;
	let fetch = async () => {
		let step = steps[Math.min(calls++, steps.length - 1)];
		if (step instanceof Error) throw step;
		return step;
	};
	return { fetch, calls: () => calls };
}

test("retryAfterMs reads retry-after-ms, seconds and HTTP dates, and ignores unusable values", () => {
	let now = Date.parse("2026-10-08T00:00:00Z");
	assert.equal(llm.retryAfterMs(response(429, {}, { "retry-after-ms": "1500" }), now), 1500);
	assert.equal(llm.retryAfterMs(response(429, {}, { "retry-after-ms": "1500", "retry-after": "9" }), now), 1500, "ms header wins");
	assert.equal(llm.retryAfterMs(response(429, {}, { "retry-after": "3" }), now), 3000);
	assert.equal(llm.retryAfterMs(response(429, {}, { "retry-after": "0" }), now), 0);
	assert.equal(llm.retryAfterMs(response(503, {}, { "retry-after": "Thu, 08 Oct 2026 00:00:05 GMT" }), now), 5000);
	assert.equal(llm.retryAfterMs(response(503, {}, { "retry-after": "Wed, 07 Oct 2026 00:00:00 GMT" }), now), 0, "past date = now");
	assert.equal(llm.retryAfterMs(response(429, {}, { "retry-after": "soon" }), now), null);
	assert.equal(llm.retryAfterMs(response(429, {}, { "retry-after": "3600" }), now), null, "too long → normal backoff");
	assert.equal(llm.retryAfterMs(response(429, {}, {}), now), null);
	assert.equal(llm.retryAfterMs({ headers: { "retry-after": "2" } }, now), 2000, "plain-object headers");
});

test("backoffDelay doubles up to a cap with up to 25% jitter", () => {
	assert.deepEqual([0, 1, 2, 3].map(a => llm.backoffDelay(a, () => 0)), [1000, 2000, 4000, 8000]);
	assert.equal(llm.backoffDelay(10, () => 0), 30000);
	assert.equal(llm.backoffDelay(0, () => 1), 750);
	for (let i = 0; i < 50; i++) {
		let d = llm.backoffDelay(2);
		assert.ok(d >= 3000 && d <= 4000, String(d));
	}
});

test("transient statuses are retried with backoff, then succeed", async () => {
	for (let status of [408, 409, 429, 500, 502, 503, 504, 529]) {
		let { fetch, calls } = scripted([response(status, { error: { message: "busy" } }), response(200, CLAUDE_OK)]);
		let sleeps = [];
		let retries = [];
		let r = await llm.generateText(settings, "s", "u", fetch, {
			sleep: async ms => sleeps.push(ms), random: () => 0, onRetry: info => retries.push(info),
		});
		assert.equal(calls(), 2, `status ${status}`);
		assert.deepEqual(sleeps, [1000]);
		assert.equal(retries[0].status, status);
		assert.equal(retries[0].attempt, 1);
		assert.equal(retries[0].maxRetries, 4);
		assert.equal(r.retries, 1);
		assert.equal(r.text, "## 一句話摘要\nOK");
	}
});

test("gives up after 4 retries and reports the last error", async () => {
	let { fetch, calls } = scripted([response(529, { error: { type: "overloaded_error", message: "Overloaded" } })]);
	let sleeps = [];
	await assert.rejects(
		llm.generateText(settings, "s", "u", fetch, { sleep: async ms => sleeps.push(ms), random: () => 0 }),
		(e) => {
			assert.equal(e.message, "Claude API 529: Overloaded（已重試 4 次）");
			assert.equal(e.status, 529);
			return true;
		},
	);
	assert.equal(calls(), 5);
	assert.deepEqual(sleeps, [1000, 2000, 4000, 8000]);
});

test("retry-after headers override the backoff", async () => {
	let { fetch } = scripted([
		response(429, {}, { "retry-after": "7" }),
		response(503, {}, { "retry-after-ms": "120" }),
		response(200, CLAUDE_OK),
	]);
	let sleeps = [];
	await llm.generateText(settings, "s", "u", fetch, { sleep: async ms => sleeps.push(ms), random: () => 0 });
	assert.deepEqual(sleeps, [7000, 120]);
});

test("client errors and refusals are not retried", async () => {
	for (let status of [400, 401, 403, 404]) {
		let { fetch, calls } = scripted([response(status, { error: { message: "nope" } })]);
		let sleeps = [];
		await assert.rejects(llm.generateText(settings, "s", "u", fetch, { sleep: async ms => sleeps.push(ms) }),
			new RegExp(`^Error: Claude API ${status}: nope$`));
		assert.equal(calls(), 1);
		assert.deepEqual(sleeps, []);
	}
	let { fetch, calls } = scripted([response(200, { stop_reason: "refusal", stop_details: { category: "bio" }, content: [] })]);
	await assert.rejects(llm.generateText(settings, "s", "u", fetch, { sleep: async () => assert.fail("slept") }), /拒絕.*bio/);
	assert.equal(calls(), 1);
	let openai = scripted([response(200, { output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] })]);
	await assert.rejects(llm.generateText({ provider: "openai", apiKey: "k" }, "s", "u", openai.fetch, {}), /OpenAI 拒絕處理：no/);
	assert.equal(openai.calls(), 1);
});

test("network errors are retried, and rethrown when retries run out", async () => {
	let net = new TypeError("NetworkError when attempting to fetch resource.");
	let { fetch, calls } = scripted([net, response(200, CLAUDE_OK)]);
	let seen = [];
	let r = await llm.generateText(settings, "s", "u", fetch, { sleep: async () => {}, onRetry: i => seen.push(i) });
	assert.equal(calls(), 2);
	assert.equal(seen[0].status, null);
	assert.equal(seen[0].error, net);
	assert.equal(r.text, "## 一句話摘要\nOK");

	let down = scripted([net]);
	await assert.rejects(llm.generateText(settings, "s", "u", down.fetch, { sleep: async () => {}, maxRetries: 2 }), e => e === net);
	assert.equal(down.calls(), 3);

	// A body that fails mid-read counts as a network error too
	let broken = { status: 200, ok: true, headers: { get: () => null }, text: async () => { throw net; } };
	let midBody = scripted([broken, response(200, CLAUDE_OK)]);
	await llm.generateText(settings, "s", "u", midBody.fetch, { sleep: async () => {} });
	assert.equal(midBody.calls(), 2);
});

test("generateText returns normalized token usage for both providers", async () => {
	let r = await llm.generateText(settings, "s", "u", scripted([response(200, CLAUDE_OK)]).fetch);
	assert.deepEqual(r.usage, { input: 1200, output: 300, cacheRead: 40, cacheWrite: 10 });
	assert.equal(r.model, "claude-opus-5-5");
	assert.equal(r.provider, "anthropic");
	assert.equal(r.retries, 0);

	let openai = response(200, {
		model: "gpt-5.5", status: "completed", output_text: "OK",
		usage: { input_tokens: 900, input_tokens_details: { cached_tokens: 100 }, output_tokens: 250, total_tokens: 1150 },
	});
	let o = await llm.generateText({ provider: "openai", apiKey: "k", model: "gpt-5.5" }, "s", "u", scripted([openai]).fetch);
	assert.deepEqual(o.usage, { input: 800, output: 250, cacheRead: 100, cacheWrite: 0 });
	assert.equal(o.provider, "openai");

	// Missing or junk usage → zeros, never NaN
	assert.deepEqual(llm.parseUsage("anthropic", {}), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	assert.deepEqual(llm.parseUsage("openai", { usage: { input_tokens: "x", output_tokens: -5 } }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("ledger records calls per month and per model without mutating its input", () => {
	let oct = new Date(2026, 9, 8);
	let nov = new Date(2026, 10, 1);
	assert.equal(usage.monthKey(oct), "2026-10");
	let empty = {};
	let l1 = usage.recordUsage(empty, { model: "claude-opus-5-5", usage: { input: 1000, output: 200, cacheRead: 5, cacheWrite: 0 } }, oct);
	assert.deepEqual(empty, {});
	let l2 = usage.recordUsage(l1, { model: "claude-opus-5-5", usage: { input: 3000, output: 800 } }, oct);
	let l3 = usage.recordUsage(l2, { model: "gpt-5.5", usage: { input: 500, output: 100 } }, oct);
	let l4 = usage.recordUsage(l3, { model: "claude-opus-5-5", usage: { input: 1, output: 1 } }, nov);
	assert.deepEqual(l1["2026-10"].byModel["claude-opus-5-5"], { calls: 1, input: 1000, output: 200, cacheRead: 5, cacheWrite: 0 });
	assert.deepEqual(l3["2026-10"], {
		calls: 3, input: 4500, output: 1100, cacheRead: 5, cacheWrite: 0,
		byModel: {
			"claude-opus-5-5": { calls: 2, input: 4000, output: 1000, cacheRead: 5, cacheWrite: 0 },
			"gpt-5.5": { calls: 1, input: 500, output: 100, cacheRead: 0, cacheWrite: 0 },
		},
	});
	assert.equal(l4["2026-11"].calls, 1);
	assert.equal(l4["2026-10"].calls, 3);
	// Round-trips through the pref string; junk is dropped
	assert.deepEqual(usage.parseLedger(JSON.stringify(l4)), l4);
	assert.deepEqual(usage.parseLedger("not json"), {});
	assert.deepEqual(usage.parseLedger('{"bad":1,"2026-10":{"calls":"2","input":-1,"byModel":{"m":{"calls":1}}}}'),
		{ "2026-10": { calls: 2, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, byModel: { m: { calls: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } } });
	// Only the most recent 24 months are kept
	let many = {};
	for (let i = 0; i < 30; i++) many = usage.recordUsage(many, { model: "m", usage: {} }, new Date(2024, i, 1));
	assert.equal(Object.keys(many).length, 24);
	assert.ok(!many["2024-01"]);
	assert.ok(many["2026-06"]);
});

test("prices: defaults, user table, prefix match and cost math", () => {
	let { prices } = usage.parsePrices("");
	assert.deepEqual(prices["claude-opus-5-5"], { input: 4, output: 20, cacheRead: 0.2 });
	assert.deepEqual(prices["claude-sonnet-5-5"], { input: 2, output: 10, cacheRead: 0.2 });
	assert.deepEqual(prices["claude-haiku-4-5"], { input: 1, output: 5, cacheRead: 0.1 });
	assert.ok(!Object.keys(prices).some(m => /gpt|codex|^o\d/.test(m)), "OpenAI models are not priced");
	assert.equal(usage.priceFor("gpt-5.5", prices), null);
	assert.equal(usage.priceFor("claude-haiku-4-5-20251001", prices), prices["claude-haiku-4-5"], "dated snapshot");
	assert.equal(usage.priceFor("claude-opus-5", prices), null, "no loose prefix match");

	// 1M input × $4 + 0.5M output × $20 + 1M cache reads × $0.2 + 1M cache writes × 1.25 × $4
	assert.equal(usage.costOf({ input: 1e6, output: 5e5, cacheRead: 1e6, cacheWrite: 1e6 }, prices["claude-opus-5-5"]), 4 + 10 + 0.2 + 5);
	assert.equal(usage.costOf({ input: 1e6 }, null), null);

	let custom = usage.parsePrices('{"gpt-5.5": {"input": 1.5, "output": 6}, "bad": {"input": "x"}, "neg": {"input": -1, "output": 1}}');
	assert.equal(custom.error, null);
	assert.deepEqual(custom.prices, { "gpt-5.5": { input: 1.5, output: 6 } });
	assert.equal(usage.costOf({ input: 1e6, cacheRead: 1e6 }, custom.prices["gpt-5.5"]), 1.5 + 0.15, "cache reads default to 0.1 × input");
	let broken = usage.parsePrices("{oops");
	assert.equal(broken.prices, usage.DEFAULT_PRICES);
	assert.match(broken.error, /JSON/);
	assert.match(usage.parsePrices("[1]").error, /價格表/);
});

test("summaries, run line and settings-pane lines", () => {
	let { prices } = usage.parsePrices("");
	let oct = new Date(2026, 9, 8);
	let ledger = usage.recordUsage({}, { model: "claude-opus-5-5", usage: { input: 100000, output: 20000 } }, oct);
	ledger = usage.recordUsage(ledger, { model: "claude-sonnet-5-5", usage: { input: 50000, output: 10000 } }, oct);
	let month = ledger["2026-10"];
	let s = usage.summarize(month, prices);
	// opus 0.4 + 0.4, sonnet 0.1 + 0.1
	assert.ok(Math.abs(s.cost - 1.0) < 1e-9);
	assert.equal(s.tokens, 180000);
	assert.equal(usage.describeRun(month, prices), "AI 用量：2 次呼叫，輸入 150,000／輸出 30,000 tokens，約 US$1.00");
	assert.deepEqual(usage.describeMonth(month, prices), [
		"呼叫次數：2",
		"Tokens：輸入 150,000／輸出 30,000",
		"估計費用：US$1.00",
		"　claude-opus-5-5：1 次，120,000 tokens，US$0.80",
		"　claude-sonnet-5-5：1 次，60,000 tokens，US$0.20",
	]);

	// OpenAI only: tokens, no dollar figure
	let gpt = usage.recordUsage({}, { model: "gpt-5.5", usage: { input: 1000, output: 10 } }, oct)["2026-10"];
	assert.equal(usage.describeRun(gpt, prices), "AI 用量：1 次呼叫，輸入 1,000／輸出 10 tokens");
	assert.match(usage.describeMonth(gpt, prices)[2], /gpt-5\.5 未定價，只顯示 tokens/);
	// Mixed: priced part only, flagged
	let mixed = usage.recordUsage(ledger, { model: "gpt-5.5", usage: { input: 1 } }, oct)["2026-10"];
	assert.match(usage.describeRun(mixed, prices), /約 US\$1\.00（部分模型未定價）$/);
	assert.match(usage.describeMonth(mixed, prices)[2], /不含未定價模型 gpt-5\.5 的 1 次呼叫/);

	assert.equal(usage.describeRun(undefined, prices), "");
	assert.deepEqual(usage.describeMonth(undefined, prices), ["本月尚未呼叫 AI。"]);
	assert.equal(usage.formatUSD(0.004), "< US$0.01");
	assert.equal(usage.formatUSD(0), "US$0.00");
	assert.equal(usage.formatUSD(12.345), "US$12.35");
});

test("estimateCost averages past calls of the model across months", () => {
	let { prices } = usage.parsePrices("");
	let l = usage.recordUsage({}, { model: "claude-opus-5-5", usage: { input: 8000, output: 1000 } }, new Date(2026, 8, 1));
	l = usage.recordUsage(l, { model: "claude-opus-5-5-20260901", usage: { input: 12000, output: 3000 } }, new Date(2026, 9, 1));
	l = usage.recordUsage(l, { model: "claude-sonnet-5-5", usage: { input: 1e6, output: 1e6 } }, new Date(2026, 9, 1));
	let est = usage.estimateCost(l, "claude-opus-5-5", prices, 10);
	// average 10,000 in + 2,000 out = $0.04 + $0.04 per call
	assert.equal(est.samples, 2);
	assert.ok(Math.abs(est.perCall - 0.08) < 1e-9);
	assert.ok(Math.abs(est.total - 0.8) < 1e-9);
	assert.equal(est.avgTokens, 12000);
	assert.equal(usage.estimateCost(l, "claude-haiku-4-5", prices, 10), null, "no history");
	assert.equal(usage.estimateCost(l, "gpt-5.5", prices, 10), null, "unpriced");
	assert.equal(usage.estimateCost(l, "claude-opus-5-5", prices, 0), null);
});
