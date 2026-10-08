const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../content/core.js");
const { sampleItem, AI_MD } = require("./fixtures.cjs");

test("sanitizeFilename strips invalid characters and trailing dots", () => {
	assert.equal(core.sanitizeFilename('A/B: C*? "D" <E> | #F ^G [H].'), "A B C D E F G H");
	assert.equal(core.sanitizeFilename(""), "Untitled");
	assert.equal(core.sanitizeFilename("x".repeat(200)).length, 120);
});

test("noteBasename formats", () => {
	let d = sampleItem();
	assert.equal(core.noteBasename(d, "citekey"), "chen2024effects");
	assert.equal(core.noteBasename(d, "authorYearTitle"),
		"Chen 2024 - Effects of nurse-led education on fall prevention a randomized controlled trial");
	assert.equal(core.noteBasename(sampleItem({ citationKey: "" }), "citekey"),
		core.noteBasename(d, "authorYearTitle"));
	assert.equal(core.noteBasename(d, "title").startsWith("Effects of nurse-led"), true);
});

test("authorNames prefers authors over editors", () => {
	assert.deepEqual(core.authorNames(sampleItem()), ["Chen, Mei", "Smith, John"]);
	assert.deepEqual(core.authorNames(sampleItem({ creators: [{ name: "WHO", creatorType: "editor" }] })), ["WHO"]);
});

test("URIs for user and group libraries", () => {
	let d = sampleItem();
	assert.equal(core.zoteroSelectURI(d), "zotero://select/library/items/ABCD1234");
	let g = sampleItem({ libraryPath: "groups/42" });
	assert.equal(core.zoteroSelectURI(g), "zotero://select/groups/42/items/ABCD1234");
	let att = d.attachments[0];
	assert.equal(core.annotationURI(d, att, att.annotations[0]),
		"zotero://open-pdf/library/items/PDF00001?page=5&annotation=ANN00001");
	// Non-numeric page labels are not passed as page numbers
	assert.equal(core.annotationURI(d, att, att.annotations[1]),
		"zotero://open-pdf/library/items/PDF00001?annotation=ANN00002");
	assert.equal(core.obsidianURI("My Vault", "Zotero/碩論/chen2024.md"),
		"obsidian://open?vault=My%20Vault&file=Zotero%2F%E7%A2%A9%E8%AB%96%2Fchen2024");
});

test("tagToObsidian makes valid tags", () => {
	assert.equal(core.tagToObsidian("fall prevention"), "fall-prevention");
	assert.equal(core.tagToObsidian("#跌倒/預防"), "跌倒/預防");
	assert.equal(core.tagToObsidian("2024"), "");
	assert.equal(core.tagToObsidian("a.b,c"), "abc");
});

test("new Obsidian note has frontmatter, managed block and user section", () => {
	let text = core.buildObsidianNote(null, sampleItem(), {
		aiMarkdown: AI_MD, aiModel: "claude-opus-5-5", notionUrl: "https://www.notion.so/abc", now: "2026-10-07T00:00:00Z",
	});
	let { frontmatter, body } = core.splitFrontmatter(text);
	assert.match(frontmatter, /^title: "Effects of nurse-led/m);
	assert.match(frontmatter, /^authors:\n {2}- "Chen, Mei"\n {2}- "Smith, John"$/m);
	assert.match(frontmatter, /^year: 2024$/m);
	assert.match(frontmatter, /^tags:\n {2}- "fall-prevention"\n {2}- "RCT"$/m);
	assert.match(frontmatter, /^notion: "https:\/\/www\.notion\.so\/abc"$/m);
	assert.match(frontmatter, /^zotero_key: "library\/ABCD1234"$/m);
	assert.doesNotMatch(frontmatter, /^fulltext_truncated/m);
	assert.match(body, /^# Effects of nurse-led/m);
	assert.match(body, /## 🤖 AI 文獻筆記/);
	assert.match(body, /\[\[Fall prevention\]\]/);
	assert.match(body, /^### 一句話摘要$/m, "AI note headings nest under the section heading");
	// Obsidian 1.14 colored highlight
	assert.match(body, /> ==🟡Falls decreased by 30%==\n> — \[p\. 5\]\(zotero:\/\/open-pdf\/library\/items\/PDF00001\?page=5&annotation=ANN00001\)/);
	assert.match(frontmatter, /^status: "待讀"$/m);
	assert.match(body, /💬 key result {2}\nsecond line/);
	assert.match(body, /#result/);
	assert.match(body, /\*\[便利貼\]\*/);
	assert.match(body, /\*\[圖片註記\]\*/);
	assert.match(body, /\*\*APA 7\*\*: Chen, M\./);
	assert.ok(body.trimEnd().endsWith("## ✍️ 我的筆記"));
});

test("re-sync keeps user content and user frontmatter keys, replaces managed parts", () => {
	let first = core.buildObsidianNote(null, sampleItem(), { aiMarkdown: "## 一句話摘要\nold summary" });
	// User edits: adds a frontmatter key, writes notes, adds a line above the managed block
	let edited = first
		.replace("---\n", "---\nstatus: \"reading\"\naliases:\n  - \"Chen RCT\"\n")
		.replace("# Effects", "# Effects")
		+ "我覺得這篇的樣本數偏小。\n\n- [[Self-efficacy]] 可以連到另一篇\n";
	edited = edited.replace(/(# Effects[^\n]*\n)/, "$1\n使用者在上方寫的字\n");
	let second = core.buildObsidianNote(edited, sampleItem({ title: "New title", tags: ["new tag"] }), {
		aiMarkdown: "## 一句話摘要\nnew summary",
	});
	let { frontmatter, body } = core.splitFrontmatter(second);
	assert.match(frontmatter, /^status: "reading"$/m);
	assert.match(frontmatter, /^aliases:\n {2}- "Chen RCT"$/m);
	assert.match(frontmatter, /^title: "New title"$/m);
	assert.match(frontmatter, /^tags:\n {2}- "new-tag"$/m);
	assert.equal((frontmatter.match(/^title:/gm) || []).length, 1);
	assert.match(body, /new summary/);
	assert.doesNotMatch(body, /old summary/);
	assert.match(body, /使用者在上方寫的字/);
	assert.match(body, /我覺得這篇的樣本數偏小。/);
	assert.match(body, /\[\[Self-efficacy\]\] 可以連到另一篇/);
	assert.equal((body.match(/zotero-bridge:start/g) || []).length, 1);
	// Idempotent
	let third = core.buildObsidianNote(second, sampleItem({ title: "New title", tags: ["new tag"] }), {
		aiMarkdown: "## 一句話摘要\nnew summary",
	});
	assert.equal(third, second);
});

test("highlights: multi-line, magenta/gray mapping, underline", () => {
	let d = sampleItem();
	d.attachments[0].annotations = [
		{ key: "A", type: "highlight", text: "line one\nline == two", color: "#e56eee", pageLabel: "1" },
		{ key: "B", type: "highlight", text: "gray", color: "#aaaaaa", pageLabel: "2" },
		{ key: "C", type: "underline", text: "under", color: "#2ea8e5", pageLabel: "3" },
	];
	let md = core.annotationsMarkdown(d);
	assert.match(md, /^> ==🟣line one==\n> ==🟣line =\\= two==$/m);
	assert.match(md, /^> ==gray==$/m);
	assert.match(md, /^> 🔵 <u>under<\/u>$/m);
});

test("status is set on creation only and kept afterwards", () => {
	let first = core.buildObsidianNote(null, sampleItem(), {});
	let moved = first.replace('status: "待讀"', 'status: "已讀"');
	let again = core.buildObsidianNote(moved, sampleItem(), {});
	assert.match(again, /^status: "已讀"$/m);
	assert.equal((again.match(/^status:/gm) || []).length, 1);
});

test("buildBaseFile has a table and a status kanban", () => {
	let base = core.buildBaseFile();
	assert.match(base, /^ {4}- file\.hasProperty\("zotero_key"\)$/m);
	assert.match(base, /^ {2}- type: table$/m);
	assert.match(base, /^ {2}- type: kanban\n {4}name: 閱讀進度\n {4}groupBy:\n {6}property: note\.status\n {6}direction: ASC$/m);
	assert.match(base, /groupOrder:\n {6}- 待讀\n {6}- 閱讀中\n {6}- 已讀\n {6}- 已引用/);
	// Structured-data columns in the table view
	assert.match(base, /^ {2}note\.study_design:\n {4}displayName: 研究設計$/m);
	assert.match(base, /- note\.publication\n {6}- note\.study_design\n {6}- note\.sample_size\n {6}- note\.evidence_level\n/);
});

const STUDY = {
	study_design: "RCT", sample_size: 120, setting: "內科病房", population: "65 歲以上住院病人",
	intervention: "護理師主導衛教", comparison: "", outcomes: "跌倒發生率", measures: ["Morse Fall Scale", "FES-I"],
	evidence_level: "2", jbi_level: "1.c", appraisal_tool: "JBI Checklist for Randomized Controlled Trials",
	appraisal_overall: "納入", country: "Taiwan",
};

test("structured data goes into frontmatter for Bases filters", () => {
	let text = core.buildObsidianNote(null, sampleItem(), { aiMarkdown: AI_MD, study: STUDY });
	let { frontmatter } = core.splitFrontmatter(text);
	assert.match(frontmatter, /^study_design: "RCT"$/m);
	assert.match(frontmatter, /^sample_size: 120$/m, "a number, so Bases can filter sample_size > 100");
	assert.match(frontmatter, /^evidence_level: "2"$/m);
	assert.match(frontmatter, /^jbi_level: "1\.c"$/m);
	assert.match(frontmatter, /^appraisal_tool: "JBI Checklist for Randomized Controlled Trials"$/m);
	assert.match(frontmatter, /^appraisal_overall: "納入"$/m);
	assert.match(frontmatter, /^population: "65 歲以上住院病人"$/m);
	assert.match(frontmatter, /^measures:\n {2}- "Morse Fall Scale"\n {2}- "FES-I"$/m);
	assert.match(frontmatter, /^country: "Taiwan"$/m);
	assert.doesNotMatch(frontmatter, /^comparison:/m, "empty values are left out");
	for (let key of core.STUDY_KEYS) assert.ok(core.MANAGED_KEYS.includes(key));
});

test("structured frontmatter: updated with new data, kept when a sync has none", () => {
	let first = core.buildObsidianNote(null, sampleItem(), { study: STUDY });
	// A sync whose AI note has no data block keeps the earlier values
	let kept = core.buildObsidianNote(first, sampleItem(), {});
	assert.match(kept, /^study_design: "RCT"$/m);
	assert.match(kept, /^measures:\n {2}- "Morse Fall Scale"/m);
	// New data replaces old values; fields now empty are removed
	let changed = core.buildObsidianNote(first, sampleItem(), {
		study: Object.assign({}, STUDY, { study_design: "cohort", sample_size: null, measures: [], country: "" }),
	});
	let fm = core.splitFrontmatter(changed).frontmatter;
	assert.match(fm, /^study_design: "cohort"$/m);
	assert.doesNotMatch(fm, /^sample_size:/m);
	assert.doesNotMatch(fm, /^country:/m);
	assert.match(fm, /^measures: \[\]$/m);
	assert.equal((fm.match(/^study_design:/gm) || []).length, 1);
	// Idempotent
	assert.equal(core.buildObsidianNote(changed, sampleItem(), {
		study: Object.assign({}, STUDY, { study_design: "cohort", sample_size: null, measures: [], country: "" }),
	}), changed);
});

test("re-sync when the user deleted the markers re-inserts the managed block", () => {
	let text = "---\ntitle: \"x\"\nmine: 1\n---\n\n# Title\n\nmy text\n";
	let out = core.buildObsidianNote(text, sampleItem(), {});
	assert.match(out, /^mine: 1$/m);
	assert.match(out, /# Title\n\n%% zotero-bridge:start/);
	assert.match(out, /my text/);
});

test("resolveRoute picks first matching rule by library and collection", () => {
	let rules = [
		{ name: "disabled", library: "*", enabled: false, notionDatabase: "DB0" },
		{ name: "group", library: "42", notionDatabase: "DB1", obsidianFolder: "Group" },
		{ name: "thesis", library: "user", collection: "碩論", notionDatabase: "DB2", obsidianFolder: "Thesis" },
		{ name: "fallback-folder", library: "*", obsidianFolder: "Other" },
	];
	let defaults = { notionDatabase: "DEFAULT", obsidianFolder: "Zotero" };
	assert.deepEqual(core.resolveRoute(sampleItem(), rules, defaults),
		{ ruleName: "thesis", notionDatabase: "DB2", obsidianFolder: "Thesis" });
	assert.deepEqual(core.resolveRoute(sampleItem({ libraryRouteID: "42" }), rules, defaults),
		{ ruleName: "group", notionDatabase: "DB1", obsidianFolder: "Group" });
	// Collection prefix must match whole path segments
	assert.equal(core.resolveRoute(sampleItem({ collections: ["碩論2"] }), rules, defaults).ruleName, "fallback-folder");
	assert.deepEqual(core.resolveRoute(sampleItem({ collections: [] }), rules, defaults),
		{ ruleName: "fallback-folder", notionDatabase: "DEFAULT", obsidianFolder: "Other" });
	assert.deepEqual(core.resolveRoute(sampleItem(), [], defaults),
		{ ruleName: "", notionDatabase: "DEFAULT", obsidianFolder: "Zotero" });
});

test("parseRules validates JSON", () => {
	assert.deepEqual(core.parseRules(""), []);
	assert.deepEqual(core.parseRules("[]"), []);
	assert.throws(() => core.parseRules("{}"));
});

test("demoteHeadings skips code fences", () => {
	assert.equal(core.demoteHeadings("# A\n```\n# not a heading\n```\n###### F", 2), "### A\n```\n# not a heading\n```\n###### F");
});

test("splitFolder drops traversal segments", () => {
	assert.deepEqual(core.splitFolder("../Zotero//碩論/./x"), ["Zotero", "碩論", "x"]);
});

test("truncate keeps surrogate pairs intact", () => {
	assert.deepEqual(core.truncate("ab😀c", 3), { text: "ab", truncated: true });
	assert.deepEqual(core.truncate("abc", 10), { text: "abc", truncated: false });
});
