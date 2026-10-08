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
		study: llm.normalizeStudyData({ study_design: "RCT", sample_size: 120, measures: ["Morse Fall Scale"] }),
		status: "已讀",
	});
	assert.deepEqual(all.Status, { select: { name: "已讀" } });
	// Without a status (not merged in this sync) the column is left alone
	assert.equal(notion.buildProperties(full, { title: "T" }).Status, undefined);
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

test("NotionClient finds pages by many Zotero keys in batches and moves them to the trash", async () => {
	let calls = [];
	let fetch = async (url, init) => {
		let path = url.replace("https://api.notion.com/v1/", "");
		let body = init.body ? JSON.parse(init.body) : undefined;
		calls.push({ method: init.method, path, body });
		if (path === "data_sources/ds-1/query") {
			let keys = body.filter.or.map(f => f.rich_text.equals);
			// Two result pages for the first batch
			if (keys[0] === "library/K0" && !body.start_cursor) return response(200, { results: [{ id: "p0" }], has_more: true, next_cursor: "c2" });
			return response(200, { results: keys.includes("library/K60") ? [{ id: "p60" }] : [{ id: "p1" }], has_more: false });
		}
		if (path.startsWith("pages/")) return response(200, { id: path.slice(6), in_trash: body.in_trash });
		return response(404, { message: path });
	};
	let client = new notion.NotionClient({ token: "t", fetch, sleep: noSleep });
	let keys = Array.from({ length: 70 }, (_, i) => `library/K${i}`);
	let pages = await client.findPagesByZoteroKeys("ds-1", keys);
	assert.deepEqual(pages.map(p => p.id), ["p0", "p1", "p60"]);
	let queries = calls.filter(c => c.path === "data_sources/ds-1/query");
	assert.equal(queries.length, 3);
	assert.equal(queries[0].body.filter.or.length, 50);
	assert.deepEqual(queries[0].body.filter.or[0], { property: "Zotero Key", rich_text: { equals: "library/K0" } });
	assert.equal(queries[1].body.start_cursor, "c2");
	assert.equal(queries[2].body.filter.or.length, 20);

	await client.trashPage("p0");
	assert.deepEqual(calls.at(-1), { method: "PATCH", path: "pages/p0", body: { in_trash: true } });
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
	// Prompt caching: one breakpoint, on the last system block (template + JSON instructions); the
	// item is in the user message after it
	assert.deepEqual(sent.body.system, [
		{ type: "text", text: llm.DEFAULT_SYSTEM_PROMPT },
		{ type: "text", text: llm.STUDY_DATA_PROMPT, cache_control: { type: "ephemeral" } },
	]);
	assert.equal(typeof sent.body.messages[0].content, "string");
	assert.doesNotMatch(JSON.stringify(sent.body.messages), /cache_control/);
	assert.match(sent.body.messages[0].content, /標題：Effects of nurse-led/);
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
	// The template, then the plugin's JSON instructions (the same for every item, ahead of it)
	assert.equal(sent.body.instructions, llm.DEFAULT_SYSTEM_PROMPT + "\n\n" + llm.STUDY_DATA_PROMPT);
	assert.equal(sent.body.input.includes(llm.STUDY_DATA_PROMPT), false);
	assert.equal(r.text, "## 一句話摘要\nOK");
});

test("extractSummary returns the one-line summary section", () => {
	assert.equal(llm.extractSummary(AI_MD), "護理師主導衛教可降低住院病人跌倒率 30%（[[Fall prevention]]）。");
	assert.equal(llm.extractSummary("no headings here\n\nsecond"), "no headings here");
});

// ---------- structured data, critical appraisal ----------

const STUDY_JSON = `{
  "study_design": "randomized controlled trial",
  "sample_size": "N = 1,204",
  "setting": "台灣某醫學中心內科病房",
  "population": "65 歲以上住院病人",
  "intervention": "護理師主導衛教",
  "comparison": "文中未報告",
  "outcomes": "跌倒發生率",
  "measures": ["Morse Fall Scale", "morse fall scale", "FES-I"],
  "evidence_level": "Level 2",
  "jbi_level": "Level 1.c",
  "appraisal_tool": "JBI Checklist for Randomized Controlled Trials",
  "appraisal_overall": "Include",
  "country": "Taiwan"
}`;

test("buildProperties fills the structured columns and leaves them alone without data", () => {
	let props = Object.fromEntries(Object.entries(notion.PROPERTY_SCHEMA).map(([k, v]) => [k, Object.keys(v)[0]]));
	let schema = { titleName: null, props };
	let study = llm.normalizeStudyData(JSON.parse(STUDY_JSON));
	let p = notion.buildProperties(schema, { study });
	assert.deepEqual(p["Study Design"], { select: { name: "RCT" } });
	assert.deepEqual(p["Sample Size"], { number: 1204 });
	assert.deepEqual(p["Evidence Level"], { select: { name: "2" } });
	assert.deepEqual(p["JBI Level"], { select: { name: "1.c" } });
	assert.deepEqual(p["Appraisal Tool"], { select: { name: "JBI Checklist for Randomized Controlled Trials" } });
	assert.deepEqual(p.Appraisal, { select: { name: "納入" } });
	assert.equal(p.Population.rich_text[0].text.content, "65 歲以上住院病人");
	assert.deepEqual(p.Comparison, { rich_text: [] }, "not-reported placeholders are stored empty");
	assert.deepEqual(p.Measures, { multi_select: [{ name: "Morse Fall Scale" }, { name: "FES-I" }] });
	assert.deepEqual(p.Country, { select: { name: "Taiwan" } });
	let none = notion.buildProperties(schema, { study: null });
	for (let name of ["Study Design", "Sample Size", "Measures", "Appraisal", "Population"]) {
		assert.equal(none[name], undefined, `${name} untouched without structured data`);
	}
	let empty = notion.buildProperties(schema, { study: llm.normalizeStudyData({}) });
	assert.deepEqual(empty["Study Design"], { select: null });
	assert.deepEqual(empty["Sample Size"], { number: null });
	assert.deepEqual(empty.Measures, { multi_select: [] });
});

test("normalizeStudyData maps designs, numbers, levels and verdicts to canonical values", () => {
	let n = x => llm.normalizeStudyData(x);
	assert.equal(n({ study_design: "RCT" }).study_design, "RCT");
	assert.equal(n({ study_design: "Mixed-Methods" }).study_design, "mixed methods");
	assert.equal(n({ study_design: "systematic review and meta-analysis" }).study_design, "meta-analysis");
	assert.equal(n({ study_design: "non-randomized controlled trial" }).study_design, "quasi-experimental");
	assert.equal(n({ study_design: "單組前後測" }).study_design, "quasi-experimental");
	assert.equal(n({ study_design: "prospective cohort study" }).study_design, "cohort");
	assert.equal(n({ study_design: "descriptive phenomenology" }).study_design, "qualitative");
	assert.equal(n({ study_design: "case report" }).study_design, "other");
	assert.equal(n({ study_design: null }).study_design, "");
	assert.equal(n({ sample_size: 85.0 }).sample_size, 85);
	assert.equal(n({ sample_size: "未報告" }).sample_size, null);
	assert.equal(n({ sample_size: -3 }).sample_size, null);
	assert.equal(n({ evidence_level: 3 }).evidence_level, "3");
	assert.equal(n({ evidence_level: "CEBM 2011 Level 4" }).evidence_level, "4");
	assert.equal(n({ evidence_level: "不適用" }).evidence_level, "");
	assert.equal(n({ evidence_level: "Level IV" }).evidence_level, "4");
	assert.equal(n({ evidence_level: "ii" }).evidence_level, "2");
	assert.equal(n({ evidence_level: "invalid" }).evidence_level, "");
	assert.equal(n({ jbi_level: "JBI Level 2.d" }).jbi_level, "2.d");
	assert.equal(n({ appraisal_overall: "seek further info" }).appraisal_overall, "需更多資訊");
	assert.equal(n({ appraisal_overall: "排除" }).appraisal_overall, "排除");
	assert.deepEqual(n({ measures: "Barthel Index；SF-36、SF-36" }).measures, ["Barthel Index", "SF-36"]);
	assert.equal(n({ population: ["older adults", "caregivers"] }).population, "older adults; caregivers");
	assert.deepEqual(Object.keys(n({})), llm.STUDY_FIELDS);
	assert.equal(n(null), null);
	assert.equal(n([1]), null);
	assert.equal(llm.hasStudyData(n({})), false);
	assert.equal(llm.hasStudyData(n({ measures: ["X"] })), true);
});

test("extractStudyData strips the final json block and parses it", () => {
	let md = `${AI_MD}\n\`\`\`json\n${STUDY_JSON}\n\`\`\`\n`;
	let r = llm.extractStudyData(md);
	assert.equal(r.found, true);
	assert.equal(r.error, "");
	assert.equal(r.md, AI_MD.trimEnd());
	assert.equal(r.data.study_design, "RCT");
	assert.equal(r.data.sample_size, 1204);
	assert.equal(r.data.appraisal_overall, "納入");

	// A heading the model added anyway, and the "output cut off" notice after the block, are handled
	let withHeading = `## 一句話摘要\nx\n\n---\n\n## 結構化資料（JSON）\n\n\`\`\`json\n{"study_design": "cohort",}\n\`\`\`\n\n> ⚠️ 輸出達到長度上限，內容可能不完整。`;
	let h = llm.extractStudyData(withHeading);
	assert.equal(h.md, "## 一句話摘要\nx\n\n> ⚠️ 輸出達到長度上限，內容可能不完整。");
	assert.equal(h.data.study_design, "cohort", "trailing comma tolerated");
});

test("extractStudyData is tolerant: missing, invalid and truncated blocks", () => {
	let missing = llm.extractStudyData(AI_MD);
	assert.deepEqual([missing.found, missing.data, missing.error, missing.md], [false, null, "", AI_MD]);

	let invalid = llm.extractStudyData("## 一句話摘要\nx\n\n```json\n{ study_design: RCT }\n```");
	assert.equal(invalid.found, true);
	assert.equal(invalid.data, null);
	assert.match(invalid.error, /JSON 格式錯誤/);
	assert.equal(invalid.md, "## 一句話摘要\nx");
	assert.equal(invalid.raw, "{ study_design: RCT }");

	let truncated = llm.extractStudyData("## 一句話摘要\nx\n\n```json\n{\"study_design\": \"RCT\", \"sample\n\n> ⚠️ 輸出達到長度上限，內容可能不完整。");
	assert.equal(truncated.md, "## 一句話摘要\nx\n\n> ⚠️ 輸出達到長度上限，內容可能不完整。");
	assert.equal(truncated.data, null);
	assert.match(truncated.error, /不完整/);

	// Other code blocks are not mistaken for the data block
	let code = "## 統計分析\n```\nlm(y ~ x)\n```\n\n## 一句話摘要\nx";
	assert.equal(llm.extractStudyData(code).found, false);
	assert.equal(llm.extractStudyData(code).md, code);
});

test("studyDataBlock round-trips through the stored-note format (plain ``` under the heading)", () => {
	let data = llm.normalizeStudyData(JSON.parse(STUDY_JSON));
	let block = llm.studyDataBlock(data);
	assert.ok(block.startsWith(`## ${llm.STUDY_DATA_HEADING}\n\n\`\`\`json\n{\n  "study_design": "RCT"`));
	// What htmlToMd gives back for <h2> + <pre>: the language tag is gone
	let stored = `${AI_MD.trim()}\n\n${block.replace("```json", "```")}`;
	let r = llm.extractStudyData(stored);
	assert.equal(r.md, AI_MD.trim());
	assert.deepEqual(r.data, data);
	// Invalid JSON is stored raw so the user can fix it in Zotero
	assert.equal(llm.studyDataBlock(null, "{ broken"), `## ${llm.STUDY_DATA_HEADING}\n\n\`\`\`json\n{ broken\n\`\`\``);
	assert.equal(llm.studyDataBlock(null, ""), "");
	let broken = llm.extractStudyData(`x\n\n## ${llm.STUDY_DATA_HEADING}\n\n\`\`\`\n{ broken\n\`\`\``);
	assert.equal(broken.md, "x");
	assert.match(broken.error, /JSON/);
});

test("the note prompt asks for critical appraisal, verbatim quotes and the JSON block", () => {
	let { system, user } = llm.buildPrompt(sampleItem({ fullText: "FULL" }), {});
	assert.match(system, /^## 嚴格評讀$/m);
	assert.match(system, /是／否／不清楚／不適用/);
	assert.match(system, /納入／排除／需更多資訊/);
	assert.match(system, /JBI Checklist for Randomized Controlled Trials/);
	assert.match(system, /官方原文逐題轉述為繁體中文/);
	assert.match(system, /逐字照抄/);
	assert.match(system, /^## 可引用的句子$/m);
	// The JSON instructions follow the template in the system prompt (the cached prefix, the same for
	// every item), also with a custom template; the user message holds only this item and ends with
	// the request for the JSON block
	let { systemParts } = llm.buildPrompt(sampleItem({ fullText: "FULL" }), {});
	assert.deepEqual(systemParts, [system, llm.STUDY_DATA_PROMPT]);
	for (let field of llm.STUDY_FIELDS) assert.match(systemParts[1], new RegExp(`"${field}"`));
	assert.ok(!user.includes(llm.STUDY_DATA_PROMPT));
	assert.ok(user.indexOf("JSON 資料區塊") > user.indexOf("</fulltext>"));
	let custom = llm.buildPrompt(sampleItem(), { systemPrompt: "my template" });
	assert.equal(custom.system, "my template");
	assert.deepEqual(custom.systemParts, ["my template", llm.STUDY_DATA_PROMPT]);
	// The example in the prompt is itself valid, parseable data
	let example = llm.extractStudyData(llm.STUDY_DATA_PROMPT.slice(llm.STUDY_DATA_PROMPT.indexOf("```json")));
	assert.equal(example.error, "");
	assert.equal(example.data.study_design, "RCT");
});
