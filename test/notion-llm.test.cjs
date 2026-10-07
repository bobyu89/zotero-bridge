const test = require("node:test");
const assert = require("node:assert/strict");
const notion = require("../content/notion.js");
const llm = require("../content/llm.js");
const { sampleItem, AI_MD } = require("./fixtures.cjs");

const noSleep = async () => {};

function response(status, json, headers = {}) {
	return {
		status,
		ok: status >= 200 && status < 300,
		statusText: String(status),
		headers: { get: k => headers[k] },
		text: async () => JSON.stringify(json),
	};
}

test("parseNotionId reads database URLs and ignores the view id", () => {
	let id = "0123456789abcdef0123456789abcdef";
	let view = "fedcba9876543210fedcba9876543210";
	let dashed = "01234567-89ab-cdef-0123-456789abcdef";
	assert.equal(notion.parseNotionId(`https://www.notion.so/ws/My-DB-${id}?v=${view}`), dashed);
	assert.equal(notion.parseNotionId(id), dashed);
	assert.equal(notion.parseNotionId(dashed), dashed);
	assert.equal(notion.parseNotionId(`https://www.notion.so/Deadbeef-${id}`), dashed);
	assert.equal(notion.parseNotionId("nope"), null);
});

test("buildProperties only writes properties that exist with the right type", () => {
	let schema = { titleName: "Name", props: { Name: "title", Year: "number", Tags: "multi_select", DOI: "rich_text" } };
	let p = notion.buildProperties(schema, { title: "T", year: "2024", tags: ["a,b", "a,b", "c"], doi: "10.1/x" });
	assert.deepEqual(Object.keys(p).sort(), ["Name", "Tags", "Year"]);
	assert.equal(p.Year.number, 2024);
	assert.deepEqual(p.Tags.multi_select, [{ name: "a，b" }, { name: "c" }]);
	assert.equal(notion.buildProperties(schema, { year: "n.d." }).Year.number, null);
	let full = { titleName: "Title", props: Object.fromEntries(Object.entries(notion.PROPERTY_SCHEMA).map(([k, v]) => [k, Object.keys(v)[0]])) };
	full.props.Title = "title";
	let all = notion.buildProperties(full, {
		title: "T", volume: "12", issue: "3", pages: "45-67", publisher: "Wiley", url: "https://x.y",
		abstract: "a".repeat(2500), date: "2024-03-01", dateAdded: "2024-05-01T08:00:00Z",
	});
	assert.equal(all.Volume.rich_text[0].text.content, "12");
	assert.equal(all.Pages.rich_text[0].text.content, "45-67");
	assert.equal(all.Publisher.rich_text[0].text.content, "Wiley");
	assert.equal(all.URL.url, "https://x.y");
	assert.deepEqual(all.Abstract.rich_text.map(r => r.text.content.length), [2000, 500]);
	assert.deepEqual(all["Date Added"].date, { start: "2024-05-01T08:00:00Z" });
	// Every schema column is filled by buildProperties
	assert.deepEqual(Object.keys(all).filter(k => k !== "Title").sort(), Object.keys(notion.PROPERTY_SCHEMA).sort());
});

test("NotionClient: resolve data source, upsert flow and container replacement", async () => {
	let calls = [];
	let pageChildren = [
		{ id: "user-1", type: "paragraph", paragraph: { rich_text: [{ plain_text: "my note" }] } },
		{ id: "old-container", type: "callout", callout: { rich_text: [{ plain_text: "Zotero Bridge｜自動同步區" }] } },
		{ id: "user-2", type: "paragraph", paragraph: { rich_text: [{ plain_text: "more" }] } },
	];
	let fetch = async (url, init) => {
		let path = url.replace("https://api.notion.com/v1/", "");
		let body = init.body ? JSON.parse(init.body) : undefined;
		calls.push({ method: init.method, path, body, headers: init.headers });
		if (path.startsWith("databases/")) return response(200, { data_sources: [{ id: "ds-1" }] });
		if (path === "data_sources/ds-1" && init.method === "GET") {
			return response(200, { properties: { Name: { type: "title" }, Authors: { type: "rich_text" } } });
		}
		if (path === "data_sources/ds-1" && init.method === "PATCH") return response(200, {});
		if (path.startsWith("blocks/page-1/children?")) return response(200, { results: pageChildren, has_more: false });
		if (path === "blocks/old-container") return response(200, {});
		if (path === "blocks/page-1/children") return response(200, { results: [{ id: "new-container" }] });
		if (path === "blocks/new-container/children") return response(200, { results: [] });
		return response(404, { code: "object_not_found", message: path });
	};
	let client = new notion.NotionClient({ token: "secret", fetch, sleep: noSleep });
	let ds = await client.resolveDataSourceId("https://www.notion.so/x-0123456789abcdef0123456789abcdef?v=1");
	assert.equal(ds, "ds-1");
	assert.equal(calls[0].headers["Notion-Version"], "2025-09-03");
	assert.equal(calls[0].headers.Authorization, "Bearer secret");

	let added = await client.ensureSchema(ds);
	assert.ok(added.includes("Zotero Key"));
	assert.ok(!added.includes("Authors"));
	let patch = calls.find(c => c.method === "PATCH" && c.path === "data_sources/ds-1");
	assert.deepEqual(patch.body.properties["Zotero Key"], { rich_text: {} });

	let blocks = Array.from({ length: 150 }, (_, i) => ({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: String(i) } }] } }));
	let id = await client.replaceManagedContainer("page-1", "title", blocks);
	assert.equal(id, "new-container");
	assert.ok(calls.some(c => c.method === "DELETE" && c.path === "blocks/old-container"));
	let append = calls.find(c => c.method === "PATCH" && c.path === "blocks/page-1/children");
	assert.equal(append.body.after, "user-1", "container stays where it was");
	assert.equal(append.body.children[0].callout.children.length, 100);
	let rest = calls.find(c => c.path === "blocks/new-container/children");
	assert.equal(rest.body.children.length, 50);
});

test("NotionClient retries 429 and reports API errors", async () => {
	let n = 0;
	let fetch = async () => {
		n++;
		if (n === 1) return response(429, {}, { "Retry-After": "1" });
		return response(400, { code: "validation_error", message: "bad" });
	};
	let client = new notion.NotionClient({ token: "t", fetch, sleep: noSleep });
	await assert.rejects(client.request("GET", "x"), /Notion API 400 \(validation_error\): bad/);
	assert.equal(n, 2);
});

test("replaceManagedContainer falls back to append when position is rejected", async () => {
	let bodies = [];
	let fetch = async (url, init) => {
		let path = url.replace("https://api.notion.com/v1/", "");
		if (path.startsWith("blocks/p/children?")) {
			return response(200, { results: [{ id: "u", type: "paragraph", paragraph: { rich_text: [] } }], has_more: false });
		}
		let body = JSON.parse(init.body);
		bodies.push(body);
		if (body.position) return response(400, { code: "validation_error", message: "position" });
		return response(200, { results: [{ id: "c" }] });
	};
	let client = new notion.NotionClient({ token: "t", fetch, sleep: noSleep });
	assert.equal(await client.replaceManagedContainer("p", "t", []), "c");
	assert.deepEqual(bodies.map(b => !!b.position), [true, false]);
});

test("buildPrompt includes metadata, annotations, notes and full text", () => {
	let d = sampleItem({ fullText: "FULL TEXT BODY" });
	let { system, user } = llm.buildPrompt(d, { notesMarkdown: [{ md: "my zotero note" }], fullTextTruncated: true });
	assert.equal(system, llm.DEFAULT_SYSTEM_PROMPT);
	assert.match(user, /標題：Effects of nurse-led/);
	assert.match(user, /作者：Chen, Mei; Smith, John; Editor, Ann/);
	assert.match(user, /- p\. 5 「Falls decreased by 30%」 — 使用者評註：key result second line/);
	assert.match(user, /my zotero note/);
	assert.match(user, /<fulltext>\n（全文過長/);
	let noFull = llm.buildPrompt(sampleItem(), { systemPrompt: "custom" });
	assert.equal(noFull.system, "custom");
	assert.match(noFull.user, /沒有可用的全文/);
});

test("callAnthropic sends the expected request and reads text blocks", async () => {
	let sent;
	let fetch = async (url, init) => {
		sent = { url, init, body: JSON.parse(init.body) };
		return response(200, {
			model: "claude-opus-5-5",
			stop_reason: "end_turn",
			content: [{ type: "thinking", thinking: "" }, { type: "text", text: AI_MD }],
		});
	};
	let r = await llm.generateNote({ provider: "anthropic", apiKey: "k", model: "claude-opus-5-5", effort: "high" }, sampleItem(), {}, fetch);
	assert.equal(sent.url, "https://api.anthropic.com/v1/messages");
	assert.equal(sent.init.headers["x-api-key"], "k");
	assert.equal(sent.init.headers["anthropic-version"], "2023-06-01");
	assert.equal(sent.init.headers["anthropic-beta"], "server-side-fallback-2026-07-01");
	assert.equal(sent.body.model, "claude-opus-5-5");
	assert.equal(sent.body.fallbacks, "default");
	assert.deepEqual(sent.body.output_config, { effort: "high" });
	assert.equal(sent.body.thinking, undefined);
	assert.equal(r.text, AI_MD);
});

test("callAnthropic surfaces refusals and API errors", async () => {
	let refusal = async () => response(200, { stop_reason: "refusal", stop_details: { category: "bio" }, content: [] });
	await assert.rejects(llm.generateNote({ provider: "anthropic", apiKey: "k" }, sampleItem(), {}, refusal), /拒絕.*bio/);
	let error = async () => response(401, { error: { message: "invalid x-api-key" } });
	await assert.rejects(llm.generateNote({ provider: "anthropic", apiKey: "k" }, sampleItem(), {}, error), /Claude API 401: invalid x-api-key/);
	await assert.rejects(llm.generateNote({ provider: "anthropic", apiKey: "" }, sampleItem(), {}, error), /API key/);
});

test("callOpenAI uses the Responses API", async () => {
	let sent;
	let fetch = async (url, init) => {
		sent = { url, init, body: JSON.parse(init.body) };
		return response(200, {
			model: "gpt-5.5",
			status: "completed",
			output: [
				{ type: "reasoning", summary: [] },
				{ type: "message", content: [{ type: "output_text", text: "## 一句話摘要\nOK" }] },
			],
		});
	};
	let r = await llm.generateNote({ provider: "openai", apiKey: "sk", model: "" }, sampleItem(), {}, fetch);
	assert.equal(sent.url, "https://api.openai.com/v1/responses");
	assert.equal(sent.init.headers.authorization, "Bearer sk");
	assert.equal(sent.body.model, "gpt-5.5");
	assert.equal(sent.body.instructions, llm.DEFAULT_SYSTEM_PROMPT);
	assert.equal(r.text, "## 一句話摘要\nOK");
});

test("extractSummary returns the one-line summary section", () => {
	assert.equal(llm.extractSummary(AI_MD), "護理師主導衛教可降低住院病人跌倒率 30%（[[Fall prevention]]）。");
	assert.equal(llm.extractSummary("no headings here\n\nsecond"), "no headings here");
});
