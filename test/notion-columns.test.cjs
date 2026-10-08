// Notion columns in Chinese (content/notion.js): new databases get Chinese names, existing databases keep
// working (columns found by stored ID, the old English or the new Chinese name, never duplicated), the
// rename plan and the PATCH that renames by property ID; plus the toggles of the folded sections.
const test = require("node:test");
const assert = require("node:assert/strict");
const notion = require("../content/notion.js");

const ZH = notion.PROPERTY_NAMES_ZH;

function response(status, json) {
	return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, text: async () => JSON.stringify(json) };
}

/** A data source whose properties live in `props` ({ name: { id, type } }); PATCHes add or rename columns. */
function dataSource(props) {
	let calls = [];
	let nextID = 1;
	let fetch = async (url, init) => {
		let path = url.replace("https://api.notion.com/v1/", "");
		let body = init.body ? JSON.parse(init.body) : undefined;
		calls.push({ method: init.method, path, body });
		if (path === "data_sources/ds" && init.method === "GET") return response(200, { properties: JSON.parse(JSON.stringify(props)) });
		if (path === "data_sources/ds" && init.method === "PATCH") {
			for (let [key, def] of Object.entries(body.properties)) {
				let existing = Object.entries(props).find(([name, p]) => name === key || p.id === key);
				if (existing && def.name) {
					delete props[existing[0]];
					props[def.name] = existing[1];
				}
				else if (!existing) {
					props[key] = { id: `new${nextID++}`, type: Object.keys(def)[0] };
				}
			}
			return response(200, {});
		}
		if (path === "data_sources/ds/query") return response(200, { results: [], has_more: false });
		if (/^blocks\/[^/]+\/children$/.test(path)) return response(200, { results: (body.children || []).map((c, i) => ({ id: `${path.split("/")[1]}-c${calls.length}-${i}` })) });
		return response(404, { message: path });
	};
	return { props, calls, fetch };
}

function englishDatabase() {
	let props = { Name: { id: "title", type: "title" } };
	let i = 0;
	for (let [name, def] of Object.entries(notion.PROPERTY_SCHEMA)) props[name] = { id: `p${i++}`, type: Object.keys(def)[0] };
	return props;
}

function store(initial = {}) {
	let data = JSON.parse(JSON.stringify(initial));
	return { data, get: ds => data[ds] || {}, set: (ds, ids) => { data[ds] = ids; } };
}

test("every column the plugin creates has a Chinese name; DOI, URL-like terms and the PICO letters stay as the norm", () => {
	assert.deepEqual(Object.keys(ZH).sort(), Object.keys(notion.PROPERTY_SCHEMA).sort());
	assert.equal(new Set(Object.values(ZH)).size, Object.keys(ZH).length, "no two columns share a name");
	assert.equal(ZH.Authors, "作者");
	assert.equal(ZH.Year, "年份");
	assert.equal(ZH.Publication, "期刊");
	assert.equal(ZH.DOI, "DOI");
	assert.equal(ZH.Status, "閱讀狀態");
	assert.equal(ZH["Study Design"], "研究設計");
	assert.equal(ZH["Evidence Level"], "證據等級");
	assert.equal(ZH["JBI Level"], "JBI 證據等級");
	assert.equal(ZH.Collections, "分類");
	assert.equal(ZH.Tags, "標籤");
	assert.equal(ZH.Zotero, "Zotero 連結");
	assert.equal(ZH["Last Synced"], "最後同步");
	assert.equal(ZH.Population, "P 族群");
	assert.equal(notion.TITLE_NAME_ZH, "標題");
});

test("resolveSchema: by stored ID first, then the Chinese name, then the English name; the expected type wins; the user's columns stay", () => {
	let props = {
		"標題": { id: "title", type: "title" },
		"作者": { id: "a1", type: "rich_text" },
		"Year": { id: "y1", type: "number" },
		// Renamed by the user in Notion: only the stored ID finds it
		"出刊年": { id: "pub1", type: "rich_text" },
		// A Chinese-named column of the user's with another type, and the plugin's English one
		"研究設計": { id: "u1", type: "rich_text" },
		"Study Design": { id: "sd1", type: "select" },
		"我的評分": { id: "m1", type: "number" },
	};
	let s = notion.resolveSchema(props, { Publication: "pub1" });
	assert.equal(s.titleName, "標題");
	assert.equal(s.names.Authors, "作者");
	assert.equal(s.names.Year, "Year");
	assert.equal(s.names.Publication, "出刊年");
	assert.equal(s.names["Study Design"], "Study Design", "the select column, not the user's text column");
	assert.equal(s.props["Study Design"], "select");
	assert.equal(s.props["研究設計"], "rich_text", "the user's own column keeps its name");
	assert.equal(s.props["我的評分"], "number");
	assert.equal(s.ids.Publication, "pub1");
	assert.equal(s.props.Status, undefined);
	assert.equal(notion.propertyName(s, "Authors"), "作者");
	assert.equal(notion.propertyName(s, "Status"), "Status", "unknown: the canonical name");
	// buildProperties writes under each database's own names
	let built = notion.buildProperties(s, { title: "T", authors: "Chen", year: "2024", publication: "JAN", study: { study_design: "RCT", measures: [] } });
	assert.deepEqual(Object.keys(built).sort(), ["Study Design", "Year", "作者", "出刊年", "標題"].sort());
	assert.deepEqual(built["出刊年"], { rich_text: [{ type: "text", text: { content: "JAN" } }] });
	// Reading a page's value whatever the column is called
	let page = { properties: { "閱讀狀態": { id: "st", type: "select", select: { name: "已讀" } }, "Zotero 識別碼": { id: "zk", rich_text: [] } } };
	assert.equal(notion.pageProperty(page, "Status").select.name, "已讀");
	assert.equal(notion.pageProperty({ properties: { "我的狀態欄": { id: "st", select: { name: "閱讀中" } } } }, "Status", { names: {}, ids: { Status: "st" } }).select.name, "閱讀中");
	assert.equal(notion.pageProperty(null, "Status"), null);
});

test("ensureSchema: a new database gets Chinese columns; an English one gets the missing columns in English; nothing is duplicated", async () => {
	// New database: only the title column
	let fresh = dataSource({ Name: { id: "title", type: "title" } });
	let ids = store();
	let client = new notion.NotionClient({ token: "t", fetch: fresh.fetch, sleep: async () => {}, propertyIds: ids });
	let added = await client.ensureSchema("ds");
	assert.deepEqual(added, Object.keys(notion.PROPERTY_SCHEMA).map(k => ZH[k]));
	let patch = fresh.calls.find(c => c.method === "PATCH");
	assert.deepEqual(patch.body.properties["閱讀狀態"], notion.PROPERTY_SCHEMA.Status);
	assert.ok(!("Authors" in patch.body.properties));
	assert.equal(Object.keys(ids.data.ds).length, Object.keys(notion.PROPERTY_SCHEMA).length, "every column's ID recorded");
	assert.deepEqual(await client.ensureSchema("ds"), [], "second run: nothing to add");
	// The page filter uses the database's own column name
	await client.findPageByZoteroKey("ds", "library/K");
	assert.equal(fresh.calls.at(-1).body.filter.property, "Zotero 識別碼");

	// A database set up by an earlier version, missing two newer columns: they come in English
	let props = englishDatabase();
	delete props["Appraisal Verified"];
	delete props["Full Text"];
	let old = dataSource(props);
	let c2 = new notion.NotionClient({ token: "t", fetch: old.fetch, sleep: async () => {} });
	assert.deepEqual(await c2.ensureSchema("ds"), ["Full Text", "Appraisal Verified"]);
	await c2.findPageByZoteroKey("ds", "library/K");
	assert.equal(old.calls.at(-1).body.filter.property, "Zotero Key");

	// A user column already called 作者 (another type) blocks the Chinese name: the English one is used
	let mixed = dataSource({ Name: { id: "title", type: "title" }, "作者": { id: "u", type: "people" } });
	let c3 = new notion.NotionClient({ token: "t", fetch: mixed.fetch, sleep: async () => {} });
	await c3.ensureSchema("ds");
	assert.equal(mixed.props["作者"].type, "people", "the user's column untouched");
	let s3 = await c3.getSchema("ds");
	// Resolution takes the matching type (rich_text) over the user's people column
	assert.equal(s3.props.Authors, "rich_text");
	assert.equal(s3.names.Authors, "Authors");
});

test("renamePlan and renameProperties: English columns renamed by ID after the plan is shown; IDs recorded", async () => {
	let props = englishDatabase();
	props["Tags"] = { id: "tg", type: "multi_select" };
	// Already Chinese, and a user column already called 標籤 blocks one rename
	props["作者"] = props.Authors;
	delete props.Authors;
	props["標籤"] = { id: "mine", type: "rich_text" };
	let db = dataSource(props);
	let ids = store();
	let client = new notion.NotionClient({ token: "t", fetch: db.fetch, sleep: async () => {}, propertyIds: ids });
	let yearID = props.Year.id;
	let plan = notion.renamePlan(await client.getSchema("ds"));
	assert.deepEqual(plan[0], { key: "title", id: "title", from: "Name", to: "標題" });
	assert.ok(!plan.some(p => p.key === "Authors"), "already Chinese");
	assert.ok(!plan.some(p => p.key === "DOI"), "same name in both");
	assert.deepEqual(plan.skipped, [{ key: "Tags", from: "Tags", to: "標籤" }]);
	assert.deepEqual(plan.find(p => p.key === "Zotero Key"), { key: "Zotero Key", id: props["Zotero Key"].id, from: "Zotero Key", to: "Zotero 識別碼" });
	db.calls.length = 0;
	await client.renameProperties("ds", plan);
	let patch = db.calls.find(c => c.method === "PATCH");
	assert.equal(patch.path, "data_sources/ds");
	assert.deepEqual(patch.body.properties[yearID], { name: "年份" }, "renamed by property ID");
	assert.ok(Object.values(patch.body.properties).every(v => Object.keys(v).join() === "name"), "names only, no type changes");
	// Afterwards the plugin finds every column under its new name, and writes there
	let after = await client.getSchema("ds");
	assert.equal(after.names.Year, "年份");
	assert.equal(after.names.Tags, "Tags", "the blocked one stays English");
	assert.equal(after.titleName, "標題");
	assert.deepEqual(notion.renamePlan(after).map(p => p.key), [], "nothing left to rename");
	assert.equal(ids.data.ds.Year, yearID);
	assert.deepEqual(await client.renameProperties("ds", []), []);
});

test("appendToggles: folded sections as coloured toggles; long sections continue in the toggle; requests stay within Notion's limits", async () => {
	let db = dataSource({});
	let client = new notion.NotionClient({ token: "t", fetch: db.fetch, sleep: async () => {} });
	let para = n => Array.from({ length: n }, (_, i) => ({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: `p${i}` } }] } }));
	let sections = [
		{ title: "🟡 重要發現（2）", color: "yellow_background", children: para(2) },
		{ title: "AI 文獻筆記", children: para(250) },
		...Array.from({ length: 8 }, (_, i) => ({ title: `s${i}`, children: para(99) })),
	];
	let ids = await client.appendToggles("container-1", sections);
	assert.equal(ids.length, sections.length);
	let appends = db.calls.filter(c => c.method === "PATCH" && c.path === "blocks/container-1/children");
	assert.ok(appends.length >= 2, "split before 1,000 blocks");
	for (let a of appends) {
		assert.ok(a.body.children.length <= 100);
		assert.ok(a.body.children.reduce((n, t) => n + 1 + t.toggle.children.length, 0) <= 900);
	}
	let first = appends[0].body.children[0];
	assert.equal(first.type, "toggle");
	assert.equal(first.toggle.color, "yellow_background");
	assert.deepEqual(first.toggle.rich_text[0], { type: "text", text: { content: "🟡 重要發現（2）" }, annotations: { bold: true } });
	assert.equal(appends[0].body.children[1].toggle.color, "default");
	assert.equal(appends[0].body.children[1].toggle.children.length, 100);
	let rest = db.calls.filter(c => c.path === `blocks/${ids[1]}/children`);
	assert.deepEqual(rest.map(c => c.body.children.length), [100, 50], "the rest of a long section, 100 at a time");
});
