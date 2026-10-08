// Claude Message Batches for bulk AI notes (content/ai-batch.js) and prompt caching (content/llm.js):
// request building, custom_id encoding, results parsing, cost math, the stored state.
const test = require("node:test");
const assert = require("node:assert/strict");
const llm = require("../content/llm.js");
const usage = require("../content/usage.js");
const batch = require("../content/ai-batch.js");
const { AI_MD, sampleItem } = require("./fixtures.cjs");

const SETTINGS = { provider: "anthropic", apiKey: "k", model: "claude-opus-5-5", effort: "high" };

// The body the normal path posts to /v1/messages for this note
async function normalBody(data, opts) {
	let sent = null;
	let fetch = async (url, init) => {
		sent = { url, init, body: JSON.parse(init.body) };
		return {
			status: 200, ok: true, headers: { get: () => null },
			text: async () => JSON.stringify({ model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: AI_MD }] }),
		};
	};
	await llm.generateNote(SETTINGS, data, opts, fetch);
	return sent;
}

// ---------- request building ----------

test("prompt caching: one breakpoint at the end of the shared system prefix, the item after it", () => {
	let body = llm.noteRequestBody(SETTINGS, sampleItem({ fullText: "FULL TEXT" }), { notesMarkdown: [{ md: "my note" }] });
	assert.deepEqual(body.system, [
		{ type: "text", text: llm.DEFAULT_SYSTEM_PROMPT },
		{ type: "text", text: llm.STUDY_DATA_PROMPT, cache_control: { type: "ephemeral" } },
	]);
	// Everything item-specific is in the user message, after the breakpoint, without markers
	let user = body.messages[0].content;
	assert.match(user, /標題：Effects of nurse-led[\s\S]*my note[\s\S]*FULL TEXT/);
	assert.doesNotMatch(JSON.stringify(body.system), /Effects of nurse-led|FULL TEXT/);
	assert.doesNotMatch(JSON.stringify(body.messages), /cache_control/);
	// The cached prefix is byte-identical for two different items (custom template too)
	let other = llm.noteRequestBody(SETTINGS, sampleItem({ title: "Another paper", fullText: "OTHER" }), {});
	assert.deepEqual(other.system, body.system);
	let custom = llm.noteRequestBody(SETTINGS, sampleItem(), { systemPrompt: "我的模板" });
	assert.deepEqual(custom.system.map(b => b.text), ["我的模板", llm.STUDY_DATA_PROMPT]);
	assert.equal(custom.system.filter(b => b.cache_control).length, 1);

	// Scanned PDF and image annotations: document/image blocks are item content, after the breakpoint
	let pdf = { data: "JVBERi0=", filename: "scan.pdf", pages: 3 };
	let withPdf = llm.noteRequestBody(SETTINGS, sampleItem(), { pdf });
	assert.equal(withPdf.messages[0].content[0].type, "document");
	assert.equal(withPdf.messages[0].content[1].type, "text");
	let images = [{ label: "圖 1", mediaType: "image/png", data: "iVBORw0=" }];
	let withImages = llm.noteRequestBody(SETTINGS, sampleItem(), { images });
	assert.deepEqual(withImages.messages[0].content.map(b => b.type), ["text", "image", "text"]);
	// OpenAI never gets image blocks or cache markers
	assert.equal(typeof llm.notePrompt({ provider: "openai" }, sampleItem(), { images }).user, "string");

	// Other Claude calls (synthesis, review draft) cache their system prompt too; none without one
	assert.deepEqual(llm.anthropicSystem("s"), [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }]);
	assert.equal(llm.anthropicSystem(""), undefined);
	assert.equal(llm.anthropicBody({ system: "", user: "u" }).system, undefined);
});

test("a batch request is the normal request body, changed only where the Batches API differs", async () => {
	let variants = [
		[sampleItem({ fullText: "FULL TEXT" }), { notesMarkdown: [{ md: "note" }], fullTextTruncated: true }],
		[sampleItem(), { pdf: { data: "JVBERi0=", filename: "scan.pdf", pages: 3 } }],
		[sampleItem(), { images: [{ label: "圖 1", mediaType: "image/png", data: "iVBORw0=" }] }],
		[sampleItem(), { systemPrompt: "我的模板" }],
	];
	for (let [data, opts] of variants) {
		let sent = await normalBody(data, opts);
		let params = batch.batchParams(llm.noteRequestBody(SETTINGS, data, opts));
		// Only `fallbacks` (rejected in a batch) and the cache TTL (1 hour, as the docs suggest for batches) differ
		let expected = JSON.parse(JSON.stringify(sent.body));
		delete expected.fallbacks;
		expected.system[expected.system.length - 1].cache_control = { type: "ephemeral", ttl: "1h" };
		assert.deepEqual(params, expected);
		assert.equal(params.stream, undefined);
		assert.equal(sent.body.fallbacks, "default", "the normal path keeps the server-side fallback");
		assert.equal(sent.init.headers["anthropic-beta"], "server-side-fallback-2026-07-01");
	}
	// The batch is created without the fallback beta header (its parameter is not accepted there)
	let h = llm.anthropicHeaders("k", { fallback: false });
	assert.equal(h["anthropic-beta"], undefined);
	assert.equal(h["anthropic-version"], "2023-06-01");
	assert.equal(h["x-api-key"], "k");
	// The input body is not modified
	let body = llm.noteRequestBody(SETTINGS, sampleItem(), {});
	batch.batchParams(body);
	assert.equal(body.fallbacks, "default");
	assert.deepEqual(body.system[1].cache_control, { type: "ephemeral" });
});

// ---------- custom_id ----------

test("custom_id: item refs encoded within ^[a-zA-Z0-9_-]{1,64}$, unique, decodable", () => {
	assert.equal(batch.encodeCustomId("1/ABCD1234"), "1-ABCD1234");
	assert.equal(batch.encodeCustomId("12345/ZZZZ9999"), "12345-ZZZZ9999");
	assert.equal(batch.decodeCustomId("1-ABCD1234"), "1/ABCD1234");
	for (let ref of ["1/AB_C", "2/A.B", "3/中文", "4/a-b"]) {
		let id = batch.encodeCustomId(ref);
		assert.match(id, batch.CUSTOM_ID_RE, ref);
		assert.equal(batch.decodeCustomId(id), ref);
	}
	assert.equal(batch.encodeCustomId("1/" + "K".repeat(70)), null, "too long");
	assert.equal(batch.encodeCustomId("1/😀"), null, "outside the BMP");
	let ids = batch.assignCustomIds(["1/AAAA1111", "1/" + "K".repeat(70), "1/AAAA1111", "2/BBBB2222"]);
	assert.deepEqual(ids, ["1-AAAA1111", "n1", "n2", "2-BBBB2222"]);
	assert.equal(new Set(ids).size, ids.length);
	for (let id of ids) assert.match(id, batch.CUSTOM_ID_RE);
});

// ---------- results ----------

const succeeded = (id, message) => JSON.stringify({ custom_id: id, result: { type: "succeeded", message } });

test("results .jsonl: succeeded, errored, canceled and expired, in any order", () => {
	let ok = {
		id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn",
		content: [{ type: "thinking", thinking: "" }, { type: "text", text: AI_MD }],
		usage: { input_tokens: 900, output_tokens: 3000, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0 },
	};
	let text = [
		JSON.stringify({ custom_id: "1-CCCC", result: { type: "errored", error: { type: "error", error: { type: "invalid_request_error", message: "messages: too long" } } } }),
		"",
		succeeded("1-AAAA", ok),
		"not json",
		JSON.stringify({ custom_id: "1-DDDD", result: { type: "canceled" } }),
		JSON.stringify({ custom_id: "1-EEEE", result: { type: "expired" } }),
		JSON.stringify({ nothing: true }),
		succeeded("1-FFFF", { model: "claude-opus-5-5", stop_reason: "refusal", stop_details: { category: "bio" }, content: [] }),
		succeeded("1-GGGG", Object.assign({}, ok, { stop_reason: "max_tokens" })),
		succeeded("1-HHHH", { stop_reason: "end_turn", content: [] }),
	].join("\r\n");
	let { results, invalid } = batch.parseResults(text);
	assert.equal(invalid, 2);
	assert.deepEqual(results.map(r => [r.customId, r.type]), [
		["1-CCCC", "errored"], ["1-AAAA", "succeeded"], ["1-DDDD", "canceled"], ["1-EEEE", "expired"],
		["1-FFFF", "succeeded"], ["1-GGGG", "succeeded"], ["1-HHHH", "succeeded"],
	]);
	let by = new Map(results.map(r => [r.customId, batch.interpretResult(r, "claude-opus-5-5")]));
	// Succeeded: read exactly like a Messages response
	assert.deepEqual(by.get("1-AAAA"), { ok: true, text: AI_MD, model: "claude-opus-5-5", provider: "anthropic", usage: { input: 900, output: 3000, cacheRead: 4000, cacheWrite: 0 } });
	assert.deepEqual(by.get("1-AAAA"), Object.assign({ ok: true }, llm.readAnthropicMessage(ok, "claude-opus-5-5")));
	// Refusal and empty answers fail with the normal path's messages; max_tokens is marked
	assert.deepEqual(by.get("1-FFFF"), { ok: false, error: "Claude 拒絕處理這篇文獻（bio）" });
	assert.deepEqual(by.get("1-HHHH"), { ok: false, error: "Claude 沒有回傳內容" });
	assert.match(by.get("1-GGGG").text, /輸出達到長度上限/);
	assert.deepEqual(by.get("1-CCCC"), { ok: false, error: "批次請求失敗（invalid_request_error: messages: too long）" });
	assert.match(by.get("1-DDDD").error, /批次已取消/);
	assert.match(by.get("1-EEEE").error, /超過 24 小時/);
	assert.match(batch.interpretResult(undefined).error, /沒有這筆的結果/);
	assert.deepEqual(batch.parseResults(""), { results: [], invalid: 0 });
});

// ---------- cost math ----------

test("usage: 1-hour cache writes, batch pricing and the savings report", () => {
	let { prices } = usage.parsePrices("");
	let opus = prices["claude-opus-5-5"];
	// parseUsage keeps the 1-hour part of the cache writes (batch requests use the 1-hour TTL)
	let u = llm.parseUsage("anthropic", { usage: {
		input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 0, cache_creation_input_tokens: 5000,
		cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 5000 },
	} });
	assert.deepEqual(u, { input: 1000, output: 2000, cacheRead: 0, cacheWrite: 5000, cacheWrite1h: 5000 });
	assert.deepEqual(llm.parseUsage("anthropic", { usage: { input_tokens: 1, cache_creation: { ephemeral_1h_input_tokens: 0 } } }),
		{ input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, "no cacheWrite1h field without 1-hour writes");

	// Docs: 5-minute writes 1.25 × input, 1-hour writes 2 × input, reads at the table's rate (Opus $0.20)
	assert.equal(usage.CACHE_WRITE_FACTOR, 1.25);
	assert.equal(usage.CACHE_WRITE_1H_FACTOR, 2);
	assert.equal(usage.BATCH_DISCOUNT, 0.5);
	let c = { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 3e6, cacheWrite1h: 1e6 };
	let standard = 4 + 20 + 0.2 + 2e6 * 4 * 1.25 / 1e6 + 1e6 * 4 * 2 / 1e6;
	assert.ok(Math.abs(usage.costOf(c, opus) - standard) < 1e-9);
	// Batch: every token at half price, cache reads and writes included
	assert.ok(Math.abs(usage.costOf(c, opus, true) - standard / 2) < 1e-9);
	assert.equal(usage.costOf({ input: 1e6, output: 1e6 }, opus, true), 12);
	// Cache savings: reads saved (input − read), writes cost (write − input)
	assert.ok(Math.abs(usage.cacheSavings({ cacheRead: 1e6 }, opus) - 3.8) < 1e-9);
	assert.ok(Math.abs(usage.cacheSavings({ cacheWrite: 1e6 }, opus) + 1) < 1e-9);
	assert.ok(Math.abs(usage.cacheSavings({ cacheWrite: 1e6, cacheWrite1h: 1e6 }, opus) + 4) < 1e-9);
	assert.ok(Math.abs(usage.cacheSavings({ cacheRead: 1e6 }, opus, true) - 1.9) < 1e-9);
	// A user price entry may set the 1-hour write price
	assert.deepEqual(usage.parsePrices('{"m": {"input": 1, "output": 2, "cacheWrite1h": 3}}').prices.m, { input: 1, output: 2, cacheWrite1h: 3 });

	// Ledger: batch calls kept apart under "<model> (batch)", priced at half
	let oct = new Date(2026, 9, 8);
	let l = usage.recordUsage({}, { model: "claude-opus-5-5", usage: { input: 100000, output: 20000 } }, oct);
	l = usage.recordUsage(l, { model: "claude-opus-5-5", usage: { input: 100000, output: 20000, cacheRead: 100000, cacheWrite: 10000, cacheWrite1h: 10000 }, batch: true }, oct);
	let month = l["2026-10"];
	assert.deepEqual(Object.keys(month.byModel), ["claude-opus-5-5", "claude-opus-5-5 (batch)"]);
	assert.deepEqual(month.byModel["claude-opus-5-5 (batch)"], { calls: 1, input: 100000, output: 20000, cacheRead: 100000, cacheWrite: 10000, cacheWrite1h: 10000 });
	assert.equal(month.cacheWrite1h, 10000);
	assert.deepEqual(usage.parseLedger(JSON.stringify(l)), l, "round-trips");
	assert.equal(usage.priceFor("claude-opus-5-5 (batch)", prices), opus);
	assert.ok(usage.isBatchKey("claude-opus-5-5 (batch)") && !usage.isBatchKey("claude-opus-5-5"));
	let s = usage.summarize(month, prices);
	// normal 0.4 + 0.4; batch (0.4 + 0.4 + 0.02 + 0.08) / 2
	assert.ok(Math.abs(s.cost - (0.8 + 0.9 / 2)) < 1e-9);
	assert.equal(s.batchCalls, 1);
	assert.ok(Math.abs(s.batchSavings - 0.9 / 2) < 1e-9);
	// cache: (100,000 × 3.8 − 10,000 × 4) / 1e6 / 2
	assert.ok(Math.abs(s.cacheSavings - 0.17) < 1e-9);
	assert.deepEqual(usage.describeMonth(month, prices), [
		"呼叫次數：2",
		"Tokens：輸入 200,000（另有快取讀取 100,000、快取寫入 10,000）／輸出 40,000",
		"估計費用：US$1.25",
		"批次 API：1 次呼叫，比一般模式省下約 US$0.45",
		"提示快取：省下約 US$0.17",
		"　claude-opus-5-5：1 次，120,000 tokens，US$0.80",
		"　claude-opus-5-5（批次）：1 次，230,000 tokens，US$0.45",
	]);
	let writesOnly = usage.recordUsage({}, { model: "claude-opus-5-5", usage: { input: 1000, cacheWrite: 1e6 } }, oct)["2026-10"];
	assert.match(usage.describeMonth(writesOnly, prices)[3], /^提示快取：快取寫入比節省的多 US\$1\.00/);

	// Estimates: the same average tokens, at the normal or the batch price
	let normal = usage.estimateCost(l, "claude-opus-5-5", prices, 10);
	let batched = usage.estimateCost(l, "claude-opus-5-5", prices, 10, true);
	assert.equal(normal.samples, 2, "batch calls count as samples too");
	assert.ok(Math.abs(batched.total - normal.total / 2) < 1e-9);
});

// ---------- state, polling, chunks ----------

test("stored batches: malformed entries dropped; poll delays; status line; chunks within the limits", () => {
	let good = {
		id: "msgbatch_1", createdAt: "2026-10-08T01:00:00Z", expiresAt: "2026-10-09T01:00:00Z", model: "claude-opus-5-5",
		action: { targets: ["obsidian"], ai: "missing" }, status: "in_progress", counts: null,
		requests: [{ id: "1-AAAA", ref: "1/AAAA", title: "A", pdf: false }],
	};
	assert.deepEqual(batch.parseState(JSON.stringify({ batches: [good, { id: "" }, { id: "x", requests: [{}], action: { targets: [] } }, null] })), { batches: [good] });
	assert.deepEqual(batch.parseState("not json"), { batches: [] });
	assert.deepEqual(batch.parseState(""), { batches: [] });
	assert.deepEqual(batch.parseState(undefined), { batches: [] });

	assert.deepEqual([0, 1, 2, 3, 10].map(n => batch.pollDelay(n) / 60000), [2, 3, 4, 5, 5]);
	assert.ok(batch.STARTUP_DELAY_MS < batch.POLL_MIN_MS);

	let line = batch.describeBatch(Object.assign({}, good, { counts: { processing: 0, succeeded: 0, errored: 0, canceled: 0, expired: 0 } }), new Date("2026-10-08T01:14:00Z"));
	assert.match(line, /^AI 批次（1 筆，\d+\/\d+ \d\d:\d\d 送出）：處理中，已完成 0／1，已等待 14 分鐘，最晚 .* 結束$/);
	let later = batch.describeBatch(Object.assign({}, good, { status: "ended", counts: { succeeded: 1, errored: 2, canceled: 0, expired: 0 } }), new Date("2026-10-08T02:30:00Z"));
	assert.match(later, /已結束，已完成 3／1（成功 1、失敗 2），已等待 1 小時 30 分$/);

	let reqs = Array.from({ length: 5 }, (_, i) => ({ custom_id: `n${i}`, params: { x: "y".repeat(100) } }));
	assert.deepEqual(batch.chunkRequests(reqs).map(c => c.length), [5]);
	assert.deepEqual(batch.chunkRequests(reqs, 300).map(c => c.length), [2, 2, 1]);
	assert.deepEqual(batch.chunkRequests(reqs, Infinity, 2).map(c => c.length), [2, 2, 1]);
	assert.deepEqual(batch.chunkRequests([{ custom_id: "big", params: { x: "y".repeat(1000) } }], 10).map(c => c.length), [1], "an oversized request still gets its own batch");
	assert.equal(batch.MAX_REQUESTS, 100000);
	assert.ok(batch.MAX_BATCH_BYTES < 256 * 1024 * 1024);
});
