// Research dashboard (研究儀表板): frontmatter aggregation, Markdown, Mermaid and the .base file (pure helpers)
const test = require("node:test");
const assert = require("node:assert/strict");
const d = require("../content/dashboard.js");
const core = require("../content/core.js");
const usage = require("../content/usage.js");

const NOW = new Date("2026-10-08T12:00:00Z");
// USD per million tokens
const PRICES = { "test-model": { input: 1, output: 5 } };

let nextKey = 1;
// A note's frontmatter as the plugin writes it (core.js), plus the user's reading status
function noteFM(data, opts = {}, status = "待讀") {
	let key = `K${nextKey++}`;
	let full = Object.assign({
		title: "Untitled", creators: [{ lastName: "Chen", firstName: "Mei", creatorType: "author" }],
		year: "2024", libraryPath: "library", key, collections: [], itemType: "journalArticle",
		dateAdded: "2026-01-01T00:00:00Z", fullTextStatus: "ok", doi: "10.1/x",
	}, data);
	let fm = Object.assign(core.managedFrontmatter(full, opts), status ? { status } : {});
	return core.splitFrontmatter(core.buildFrontmatter(fm, null)).frontmatter;
}

const AI = { aiModel: "test-model", aiGeneratedAt: "2026-10-01T00:00:00Z" };

function sample() {
	return [
		d.noteRecord(noteFM({ title: "RCT of hourly rounding", collections: ["碩論/跌倒", "EBP"], dateAdded: "2026-10-06T08:00:00Z" },
			Object.assign({ study: { study_design: "RCT", evidence_level: "2", jbi_level: "1c", appraisal_overall: "納入", sample_size: 120 } }, AI), "已讀"), "Zotero/a.md"),
		d.noteRecord(noteFM({ title: "Cohort of falls", collections: ["碩論/跌倒"], dateAdded: "2025-03-01T00:00:00Z", doi: "" },
			Object.assign({ study: { study_design: "Cohort", evidence_level: "3", appraisal_overall: "納入" } }, AI), "閱讀中"), "Zotero/b.md"),
		d.noteRecord(noteFM({ title: "長期照護機構跌倒預防", creators: [{ name: "陳, 美玲", creatorType: "author" }, { lastName: "林", firstName: "小華", creatorType: "author" }],
			collections: ["碩論/跌倒"], dateAdded: "2024-01-05T00:00:00Z", fullTextStatus: "none", doi: "" }), "Zotero/c.md"),
		d.noteRecord(noteFM({ title: "Scanned old paper", dateAdded: "2025-06-01T00:00:00Z", fullTextStatus: "partial", itemType: "book", doi: "" }), "Zotero/sub/d.md"),
		d.noteRecord(noteFM({ title: "Cited RCT", collections: ["EBP"], dateAdded: "2026-10-07T23:00:00Z" },
			Object.assign({ study: { study_design: "RCT", evidence_level: "10", appraisal_overall: "需更多資訊" } }, AI), "已引用"), "Zotero/e.md"),
		d.noteRecord(noteFM({ title: "Custom status", dateAdded: "2026-05-01T00:00:00Z", fullTextStatus: "no_pdf" }, AI, "略讀"), "Zotero/f.md"),
		d.noteRecord(noteFM({ title: "No status yet", dateAdded: "" }, AI, ""), "Zotero/g.md"),
		// Trashed in Zotero: not counted
		d.noteRecord(core.markObsidianNoteDeleted("---\n" + noteFM({ title: "Gone" }, AI, "已讀") + "\n---\n", { now: "2026-10-01T00:00:00Z" })
			.split("---\n")[1], "Zotero/gone.md"),
	];
}

test("parseFrontmatter: scalars, block lists, inline lists and the user's own keys", () => {
	let fm = noteFM({ title: "A \"quoted\" title", collections: ["碩論/跌倒", "EBP"] }, { study: { sample_size: 42, measures: [] } });
	let f = d.parseFrontmatter(fm + "\naliases: [one, \"two\"]\nempty:\ncssclasses:\n  - wide\n");
	assert.equal(f.title, "A \"quoted\" title");
	assert.deepEqual(f.collections, ["碩論/跌倒", "EBP"]);
	assert.deepEqual(f.authors, ["Chen, Mei"]);
	assert.equal(f.year, "2024");
	assert.equal(f.sample_size, "42");
	assert.equal(f.status, "待讀");
	assert.deepEqual(f.aliases, ["one", "two"]);
	assert.deepEqual(f.measures, []);
	assert.equal(f.empty, "");
	assert.deepEqual(f.cssclasses, ["wide"]);
	assert.equal(d.parseFrontmatter("title: 'single'").title, "single");
});

test("noteRecord: fields, AI note and structured data, deleted notes, suspect Chinese names", () => {
	let [a, , c, dd, , , g, gone] = sample();
	assert.equal(a.link, "Zotero/a");
	assert.equal(a.title, "RCT of hourly rounding");
	assert.equal(a.status, "已讀");
	assert.equal(a.hasAI, true);
	assert.equal(a.hasStudyData, true);
	assert.equal(a.evidenceLevel, "2");
	assert.equal(c.hasAI, false);
	assert.equal(c.hasStudyData, false);
	assert.deepEqual(c.suspectNames, ["陳, 美玲"]);
	assert.equal(dd.link, "Zotero/sub/d");
	assert.equal(g.status, "");
	assert.equal(gone.deleted, true);
	assert.equal(d.noteRecord("", "Zotero/無標題.md").title, "無標題");
});

test("suspectChineseNames: only Chinese items, only names that look split or romanized", () => {
	assert.deepEqual(d.suspectChineseNames("護理人員的工作壓力", ["陳美玲", "歐陽小華", "陳, 美玲", "林 小華", "王", "陳Mei", "Chen, Mei-Ling"]),
		["陳, 美玲", "林 小華", "王", "陳Mei"]);
	assert.deepEqual(d.suspectChineseNames("Nurse burnout", ["陳, 美玲"]), []);
	assert.deepEqual(d.suspectChineseNames("看護の負担", ["陳, 美玲"]), []);
});

test("aggregate: reading progress, collections, evidence, data quality, unread and new items", () => {
	let s = d.aggregate(sample(), { now: NOW });
	assert.equal(s.total, 7);
	assert.equal(s.deleted, 1);
	assert.deepEqual(s.statuses, [["待讀", 2], ["閱讀中", 1], ["已讀", 1], ["已引用", 1], ["略讀", 1], ["（未設定）", 1]]);
	assert.equal(s.read, 2);
	assert.equal(s.readPercent, 29);
	assert.deepEqual(s.collections.map(c => [c.name, c.total, c.read, c.byStatus]), [
		["碩論/跌倒", 3, 1, { 已讀: 1, 閱讀中: 1, 待讀: 1 }],
		["EBP", 2, 2, { 已讀: 1, 已引用: 1 }],
		["（未分類）", 3, 0, { 待讀: 1, 略讀: 1, "（未設定）": 1 }],
	]);
	assert.deepEqual(s.designs, [["RCT", 2], ["Cohort", 1], ["（未填）", 4]]);
	// Natural order: 2 < 3 < 10
	assert.deepEqual(s.levels, [["2", 1], ["3", 1], ["10", 1], ["（未填）", 4]]);
	assert.deepEqual(s.jbiLevels, [["1c", 1], ["（未填）", 6]]);
	assert.deepEqual(s.appraisals, [["納入", 2], ["需更多資訊", 1], ["（未填）", 4]]);
	assert.equal(s.withAI, 5);
	assert.equal(s.withStudyData, 3);
	assert.deepEqual(s.fullText, [["ok", 4], ["partial", 1], ["none", 1], ["no_pdf", 1], ["", 0]]);
	// 待讀, oldest first
	assert.deepEqual(s.unread.map(r => r.title), ["長期照護機構跌倒預防", "Scanned old paper"]);
	// Most issues first; a book without DOI is fine, a journal article is not
	assert.deepEqual(s.issues.map(x => [x.record.title, x.issues]), [
		["長期照護機構跌倒預防", ["noAI", "scanned", "noDOI", "zhNames"]],
		["Scanned old paper", ["noAI", "scanned"]],
		["Cohort of falls", ["noDOI"]],
	]);
	assert.deepEqual(s.issueCounts, { noAI: 2, scanned: 2, noDOI: 2, zhNames: 1 });
	// Last 7 days, newest first
	assert.deepEqual(s.added.map(r => r.title), ["Cited RCT", "RCT of hourly rounding"]);
	assert.equal(d.aggregate([], { now: NOW }).total, 0);
});

test("buildStatusPie: Mermaid pie of the non-empty statuses", () => {
	let pie = d.buildStatusPie([["待讀", 3], ["閱讀中", 0], ["已讀", 2], ["自訂 \"x\"", 1]]);
	assert.equal(pie, [
		"```mermaid",
		"pie showData",
		"    title 閱讀狀態",
		"    \"待讀\" : 3",
		"    \"已讀\" : 2",
		"    \"自訂 'x'\" : 1",
		"```",
	].join("\n"));
	assert.equal(d.buildStatusPie([["待讀", 0]]), "");
});

test("usageReport: this month and the two before, with totals", () => {
	let ledger = usage.recordUsage({}, { model: "test-model", usage: { input: 1000000, output: 0 } }, new Date(2026, 9, 3));
	ledger = usage.recordUsage(ledger, { model: "test-model", usage: { input: 0, output: 1000000 } }, new Date(2026, 7, 20));
	ledger = usage.recordUsage(ledger, { model: "test-model", usage: { input: 1000000, output: 0 } }, new Date(2026, 6, 20));
	ledger = usage.recordUsage(ledger, { model: "local-model", usage: { input: 10, output: 10 } }, new Date(2026, 8, 2));
	let r = d.usageReport(ledger, PRICES, { now: new Date(2026, 9, 8) });
	assert.deepEqual(r.months.map(m => [m.month, m.summary.calls]), [["2026-10", 1], ["2026-09", 1], ["2026-08", 1]]);
	assert.equal(r.total.calls, 3);
	assert.equal(r.total.unpricedCalls, 1);
	assert.ok(Math.abs(r.total.cost - 6) < 1e-9);
	let md = d.buildDashboardSection(d.aggregate([], { now: NOW }), { now: NOW, usage: r });
	assert.match(md, /\| 2026-10（本月） \| 1 \| 1,000,000 \| US\$1\.00 \|/);
	assert.match(md, /\| 2026-09 \| 1 \| 20 \| 未定價 \|/);
	assert.match(md, /本月估計費用 \*\*US\$1\.00\*\*；近 3 個月合計 3 次呼叫，約 \*\*US\$6\.00\*\*（不含未定價模型的 1 次呼叫）/);
	let none = d.buildDashboardSection(d.aggregate([], { now: NOW }), { now: NOW, usage: d.usageReport({}, PRICES, { now: NOW }) });
	assert.match(none, /近 3 個月沒有 AI 呼叫紀錄/);
});

test("projectRecord: PRISMA counts of review notes, sources of drafts", () => {
	let review = d.projectRecord(core.splitFrontmatter(core.buildFrontmatter({
		title: "跌倒：篩選與 PRISMA 2020", type: "review-screening", prisma_identified: 120, prisma_screened: 100,
		prisma_assessed: 20, prisma_included: 0, prisma_awaiting_screening: 2, prisma_awaiting_fulltext: 1, last_generated: "2026-10-01T00:00:00Z",
	}, null)).frontmatter, "Zotero/Reviews/跌倒.md");
	assert.deepEqual(review.prisma, { identified: 120, duplicates: null, screened: 100, assessed: 20, included: 0, awaiting: 3 });
	assert.equal(review.generatedAt, "2026-10-01T00:00:00Z");
	let draft = d.projectRecord("type: \"lit-review-draft\"\nsources:\n  - \"library/A\"\n  - \"library/B\"\ngenerated_at: \"2026-10-02T00:00:00Z\"", "Zotero/Drafts/文獻探討-跌倒.md");
	assert.equal(draft.sources, 2);
	assert.equal(draft.title, "文獻探討-跌倒");
	let md = d.buildDashboardSection(d.aggregate([], { now: NOW }), { now: NOW, reviews: [review], drafts: [draft] });
	assert.match(md, /- \[\[Zotero\/Reviews\/跌倒\|跌倒：篩選與 PRISMA 2020\]\]：納入 \*\*0\*\* 篇（辨識 120 → 篩選 100 → 全文評估 20）；尚待篩選 3 筆 · 更新於 2026-10-01/);
	assert.match(md, /- \[\[Zotero\/Drafts\/文獻探討-跌倒\|文獻探討-跌倒\]\]：2 篇文獻 · 產生於 2026-10-02/);
	let empty = d.buildDashboardSection(d.aggregate([], { now: NOW }), { now: NOW });
	assert.match(empty, /還沒有回顧專案/);
	assert.match(empty, /還沒有草稿/);
	assert.match(empty, /還沒有同步到 Obsidian 的文獻筆記/);
});

test("buildDashboardSection: every section, links and tables", () => {
	let stats = d.aggregate(sample(), { now: NOW });
	let md = d.buildDashboardSection(stats, { now: NOW, baseLink: "Zotero/研究儀表板.base" });
	let headings = md.split("\n").filter(l => /^## /.test(l));
	assert.deepEqual(headings, ["## 📖 閱讀進度", "## 🔬 證據概況", "## 📝 待處理清單", "## 🗂️ 回顧專案", "## 🤖 AI 用量", "## 🆕 本週新增"]);
	assert.match(md, /共 \*\*7\*\* 篇文獻，已讀完成率 \*\*29%\*\*（已讀 \+ 已引用 2 篇）。 另有 1 篇已從 Zotero 刪除/);
	assert.match(md, /\| 待讀 \| 2 \| 29% \|/);
	assert.match(md, /```mermaid\npie showData\n/);
	assert.match(md, /\| 分類 \| 篇數 \| 待讀 \| 閱讀中 \| 已讀 \| 已引用 \| 完成率 \|\n\| --- \| ---: \|/);
	assert.match(md, /\| 碩論\/跌倒 \| 3 \| 1 \| 1 \| 1 \| 0 \| 33% \|/);
	assert.match(md, /\| RCT \| 2 \|/);
	assert.match(md, /\| 1c \| 1 \|/);
	assert.match(md, /掃描檔（全文 none／partial，建議先 OCR 再產生 AI 筆記）：\*\*2\*\* 篇/);
	assert.match(md, /\| none：掃描版（沒有文字層） \| 1 \|/);
	assert.match(md, /- \[\[Zotero\/c\|長期照護機構跌倒預防\]\] — 2024-01-05 加入（已 1007 天）/);
	assert.match(md, /無 AI 筆記 2 · 掃描檔待 OCR 2 · 期刊文章缺 DOI 2 · 中文作者姓名可疑 1/);
	assert.match(md, /- ⚠️ \[\[Zotero\/c\|長期照護機構跌倒預防\]\]：無 AI 筆記、掃描檔待 OCR、期刊文章缺 DOI、中文作者姓名可疑（陳, 美玲）/);
	assert.match(md, /這 7 天新增 \*\*2\*\* 篇：\n\n- \[\[Zotero\/e\|Cited RCT\]\] — 2026-10-07 加入（已引用）/);
	assert.match(md, /Bases 檢視：\[\[Zotero\/研究儀表板\.base\|研究儀表板\.base\]\]/);
	// The deleted note is nowhere
	assert.ok(!md.includes("Gone"));
	// Link labels can't break the wikilink
	let odd = d.noteRecord(noteFM({ title: "A | B [draft]", dateAdded: "2026-10-08T00:00:00Z" }), "Zotero/odd.md");
	assert.match(d.buildDashboardSection(d.aggregate([odd], { now: NOW }), { now: NOW }), /\[\[Zotero\/odd\|A ｜ B \(draft\)\]\]/);
	// A cell with a pipe is escaped
	let piped = d.noteRecord(noteFM({ title: "x" }, { study: { study_design: "Mixed | methods" } }), "Zotero/p.md");
	assert.match(d.buildDashboardSection(d.aggregate([piped], { now: NOW }), { now: NOW }), /\| Mixed \\\| methods \| 1 \|/);
});

test("buildDashboardNote: new note, then only the managed block and two frontmatter keys change", () => {
	let first = d.buildDashboardNote(null, "SECTION ONE", { updated: "2026-10-08T00:00:00Z" });
	assert.ok(first.startsWith("---\ntype: \"research-dashboard\"\nupdated: \"2026-10-08T00:00:00Z\"\n---\n\n# 研究儀表板\n\n%% zotero-bridge:start"));
	assert.match(first, /SECTION ONE\n\n%% zotero-bridge:end %%\n\n## ✍️ 我的筆記\n\n$/);
	// The user adds a key, text above and below the block
	let edited = first
		.replace("updated:", "cssclasses:\n  - wide\nupdated:")
		.replace("# 研究儀表板\n", "# 研究儀表板\n\n我的目標：12 月前讀完 30 篇。\n")
		+ "今天讀了兩篇。\n";
	let second = d.buildDashboardNote(edited, "SECTION TWO", { updated: "2026-10-09T00:00:00Z" });
	assert.ok(!second.includes("SECTION ONE"));
	assert.match(second, /SECTION TWO/);
	assert.match(second, /cssclasses:\n {2}- wide/);
	assert.match(second, /updated: "2026-10-09T00:00:00Z"/);
	assert.match(second, /我的目標：12 月前讀完 30 篇。/);
	assert.match(second, /## ✍️ 我的筆記\n\n今天讀了兩篇。\n$/);
	assert.equal(second.split("%% zotero-bridge:start").length, 2);
	// Same input → same output
	assert.equal(d.buildDashboardNote(second, "SECTION TWO", { updated: "2026-10-09T00:00:00Z" }), second);
	// A dashboard made as Zotero Bridge (≤ 0.10): the block is replaced, not added a second time
	const asOld = text => text.split("ZotMax").join("Zotero Bridge");
	assert.match(asOld(edited), /Zotero Bridge/);
	let fromOld = d.buildDashboardNote(asOld(edited), "SECTION TWO", { updated: "2026-10-09T00:00:00Z" });
	assert.equal(fromOld.split("%% zotero-bridge:start").length, 2);
	assert.ok(!fromOld.includes("SECTION ONE"));
	assert.match(fromOld, /我的目標：12 月前讀完 30 篇。\n\n%% zotero-bridge:start — 此區塊由 ZotMax 自動產生/);
	assert.match(fromOld, /今天讀了兩篇。\n$/);
	assert.doesNotMatch(fromOld, /Zotero Bridge/);
	// Markers deleted by the user: a fresh block after the heading, their text kept
	let noMarkers = "---\ntype: research-dashboard\n---\n# 研究儀表板\n\n只有我的字\n";
	let rebuilt = d.buildDashboardNote(noMarkers, "SECTION", { updated: "u" });
	assert.match(rebuilt, /# 研究儀表板\n\n%% zotero-bridge:start[^\n]*\n\nSECTION\n\n%% zotero-bridge:end %%\n\n\n只有我的字/);
	assert.match(rebuilt, /^---\ntype: "research-dashboard"\nupdated: "u"\n---\n/);
});

test("buildDashboardBase: three views in Bases syntax", () => {
	let base = d.buildDashboardBase();
	assert.ok(!/\t/.test(base), "YAML must not contain tabs");
	assert.ok(base.endsWith("\n"));
	let views = base.split("\n").filter(l => /^ {2}- type: /.test(l));
	assert.deepEqual(views, ["  - type: table", "  - type: table", "  - type: table"]);
	assert.deepEqual(base.split("\n").filter(l => /^ {4}name: /.test(l)).map(l => l.trim()),
		["name: 證據等級表", "name: 掃描檔待 OCR", "name: 待讀（依分類）"]);
	// Global filter: the plugin's notes, minus items trashed in Zotero
	assert.match(base, /^filters:\n {2}and:\n {4}- file\.hasProperty\("zotero_key"\)\n {4}- '!file\.hasProperty\("zotero_deleted"\)'\n/);
	assert.match(base, /name: 證據等級表\n {4}filters:\n {6}and:\n {8}- file\.hasProperty\("evidence_level"\)\n {8}- 'evidence_level != ""'\n {4}groupBy:\n {6}property: note\.study_design\n {6}direction: ASC\n/);
	assert.match(base, /name: 掃描檔待 OCR\n {4}filters:\n {6}or:\n {8}- 'full_text == "none"'\n {8}- 'full_text == "partial"'\n/);
	assert.match(base, /name: 待讀（依分類）\n {4}filters:\n {6}and:\n {8}- 'status == "待讀"'\n {4}groupBy:\n {6}property: note\.collections\n/);
	// Every property shown in a view is a frontmatter key the plugin writes (or file.name)
	let shown = new Set(base.split("\n").filter(l => /^ {6}- (note|file)\./.test(l)).map(l => l.trim().slice(2)));
	for (let p of shown) {
		if (p === "file.name") continue;
		let key = p.replace(/^note\./, "");
		assert.ok(core.MANAGED_KEYS.includes(key) || key === "status", p);
	}
	// Different from the main base file
	assert.notEqual(base, core.buildBaseFile());
});
