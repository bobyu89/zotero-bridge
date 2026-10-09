// Advisor progress report (進度報告): period, status log, PRISMA snapshots, goals, words, the note and Pandoc (pure helpers)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const pr = require("../content/progress-report.js");
const core = require("../content/core.js");

// Local noon, so the local day is the same in every time zone
const day = s => new Date(`${s}T12:00:00`);

test("period: since the last report, else the last 14 days; dialog values normalized", () => {
	assert.deepEqual(pr.defaultPeriod(day("2026-10-08"), "2026-09-24"), { start: "2026-09-24", end: "2026-10-08", fromLastReport: true });
	assert.deepEqual(pr.defaultPeriod(day("2026-10-08"), ""), { start: "2026-09-25", end: "2026-10-08", fromLastReport: false });
	// A report from today (re-run) or the future is not "the last report"
	assert.equal(pr.defaultPeriod(day("2026-10-08"), "2026-10-08").start, "2026-09-25");
	assert.equal(pr.defaultPeriod(day("2026-10-08"), "garbage").start, "2026-09-25");
	assert.deepEqual(pr.normalizePeriod("2026-10-08", "2026-10-01"), { start: "2026-10-01", end: "2026-10-08" });
	assert.deepEqual(pr.normalizePeriod("", "2026-10-08"), { start: "2026-09-25", end: "2026-10-08" });
	assert.deepEqual(pr.normalizePeriod("2026-02-30x", "", day("2026-03-10")), { start: "2026-02-25", end: "2026-03-10" });
	assert.equal(pr.previousReportDate(["2026-09-10", "2026-10-08", "2026-09-24", "bad", "2026-09-24"], "2026-10-08"), "2026-09-24");
	assert.equal(pr.previousReportDate([], "2026-10-08"), "");
	assert.equal(pr.addDays("2026-03-01", -1), "2026-02-28");
	assert.equal(pr.toLocalDay("2026-10-01"), "2026-10-01");
	assert.equal(pr.toLocalDay(""), "");
	assert.equal(pr.toLocalDay("not a date"), "");
	// Zotero's UTC "YYYY-MM-DD HH:MM:SS" and ISO times become the local day
	let t = new Date(Date.UTC(2026, 9, 1, 12, 0, 0));
	assert.equal(pr.toLocalDay("2026-10-01 12:00:00"), pr.localDate(t));
	assert.equal(pr.toLocalDay(t.toISOString()), pr.localDate(t));
	let period = { start: "2026-09-24", end: "2026-10-08" };
	assert.ok(pr.inPeriod("2026-09-24", period));
	assert.ok(pr.inPeriod("2026-10-08", period));
	assert.ok(!pr.inPeriod("2026-10-09", period));
	assert.ok(!pr.inPeriod("", period));
});

test("status log: append, de-duplicate, cap per item, by age and in total; malformed pref text is ignored", () => {
	let log = {};
	let r = pr.appendStatusLog(log, "library/A", "待讀", "閱讀中", "2026-10-01");
	assert.equal(r.changed, true);
	assert.deepEqual(r.log, { "library/A": [{ date: "2026-10-01", from: "待讀", to: "閱讀中" }] });
	assert.deepEqual(log, {}, "the input is not changed");
	log = r.log;
	// The same change seen again (item pane, then the next sync) is not added twice
	assert.equal(pr.appendStatusLog(log, "library/A", "待讀", "閱讀中", "2026-10-02").changed, false);
	// Nothing for no status, no change, no key or a bad date
	for (let args of [["library/A", "已讀", "", "2026-10-02"], ["library/A", "已讀", "已讀", "2026-10-02"], ["", "待讀", "已讀", "2026-10-02"], ["library/A", "待讀", "已讀", "yesterday"]]) {
		assert.equal(pr.appendStatusLog(log, ...args).changed, false, args.join(","));
	}
	log = pr.appendStatusLog(log, "library/A", "閱讀中", "已讀", "2026-10-03").log;
	assert.equal(log["library/A"].length, 2);

	// Per item: only the newest maxPerItem
	let many = {};
	let statuses = ["待讀", "閱讀中"];
	for (let i = 0; i < 30; i++) many = pr.appendStatusLog(many, "library/B", statuses[i % 2], statuses[(i + 1) % 2], "2026-10-01").log;
	assert.equal(many["library/B"].length, pr.LOG_LIMITS.maxPerItem);
	// In total: the newest entries are kept, each item's order unchanged
	let total = {};
	let limits = { maxPerItem: 20, maxEntries: 3, maxAgeDays: 730 };
	total = pr.appendStatusLog(total, "library/C", "待讀", "閱讀中", "2026-09-01", limits).log;
	total = pr.appendStatusLog(total, "library/D", "待讀", "已讀", "2026-09-02", limits).log;
	total = pr.appendStatusLog(total, "library/C", "閱讀中", "已讀", "2026-09-03", limits).log;
	total = pr.appendStatusLog(total, "library/E", "待讀", "已引用", "2026-09-04", limits).log;
	assert.deepEqual(total, {
		"library/D": [{ date: "2026-09-02", from: "待讀", to: "已讀" }],
		"library/C": [{ date: "2026-09-03", from: "閱讀中", to: "已讀" }],
		"library/E": [{ date: "2026-09-04", from: "待讀", to: "已引用" }],
	});
	// By age
	let old = pr.capStatusLog({ "library/F": [{ date: "2023-01-01", from: "待讀", to: "已讀" }], "library/G": [{ date: "2026-10-01", from: "待讀", to: "已讀" }] }, "2026-10-08");
	assert.deepEqual(Object.keys(old), ["library/G"]);

	assert.deepEqual(pr.parseStatusLog("not json"), {});
	assert.deepEqual(pr.parseStatusLog("[1,2]"), {});
	assert.deepEqual(pr.parseStatusLog(JSON.stringify({
		"library/A": [{ date: "2026-10-01", from: "待讀", to: "已讀" }, { date: "bad", to: "已讀" }, null, { date: "2026-10-02", from: "已讀" }],
		"library/B": "nope",
	})), { "library/A": [{ date: "2026-10-01", from: "待讀", to: "已讀" }] });
});

test("reading changes in the period: the last change counts, from the status before the period's first change", () => {
	let log = {
		"library/A": [{ date: "2026-09-20", from: "", to: "待讀" }, { date: "2026-09-26", from: "待讀", to: "閱讀中" }, { date: "2026-10-02", from: "閱讀中", to: "已讀" }],
		"library/B": [{ date: "2026-09-30", from: "待讀", to: "已讀" }, { date: "2026-10-05", from: "已讀", to: "閱讀中" }],
		"library/C": [{ date: "2026-09-01", from: "待讀", to: "已讀" }],
		"library/D": [{ date: "2026-10-07", from: "已讀", to: "已引用" }],
	};
	assert.deepEqual(pr.readingChanges(log, { start: "2026-09-24", end: "2026-10-08" }), [
		{ key: "library/D", date: "2026-10-07", from: "已讀", to: "已引用" },
		{ key: "library/A", date: "2026-10-02", from: "待讀", to: "已讀" },
	]);
});

test("PRISMA snapshot and the change since the previous report", () => {
	let fm = core.splitFrontmatter(core.buildFrontmatter({
		title: "跌倒：篩選與 PRISMA 2020", type: "review-screening", prisma_identified: 40, prisma_screened: 35, prisma_assessed: 10,
		prisma_included: 6, prisma_awaiting_screening: 3, prisma_awaiting_fulltext: 0, last_generated: "2026-10-01T00:00:00Z",
	}, null)).frontmatter;
	let review = pr.reviewRecord(fm, "Zotero/Reviews/跌倒.md");
	assert.deepEqual(review, {
		relPath: "Zotero/Reviews/跌倒.md", link: "Zotero/Reviews/跌倒", name: "跌倒", title: "跌倒：篩選與 PRISMA 2020",
		identified: 40, screened: 35, assessed: 10, included: 6, awaitingScreening: 3, awaitingFulltext: 0, generatedAt: "2026-10-01T00:00:00Z",
	});
	let fresh = pr.reviewRecord("title: 新回顧\nprisma_identified: 12", "Zotero/Reviews/新.md");
	let snapshot = pr.prismaSnapshot([review]);
	assert.deepEqual(snapshot["Zotero/Reviews/跌倒.md"], { identified: 40, screened: 35, assessed: 10, included: 6, awaitingScreening: 3, awaitingFulltext: 0 });
	// The snapshot survives JSON (the history pref)
	let prev = JSON.parse(JSON.stringify({ "Zotero/Reviews/跌倒.md": { identified: 30, screened: 30, assessed: 10, included: 4, awaitingScreening: 8, awaitingFulltext: null } }));
	let rows = pr.diffPrisma([review, fresh], prev);
	assert.deepEqual(rows[0].delta, { identified: 10, screened: 5, assessed: 0, included: 2, awaitingScreening: -5, awaitingFulltext: null });
	assert.equal(rows[1].previous, null);
	assert.deepEqual(rows[1].delta, { identified: null, screened: null, assessed: null, included: null, awaitingScreening: null, awaitingFulltext: null });
	let md = pr.buildSections({ reviews: rows, hasSnapshot: true }, { reading: false, writing: false, pubmed: false, goals: false });
	assert.match(md, /^## 系統性回顧進度\n\n- \[\[Zotero\/Reviews\/跌倒\|跌倒：篩選與 PRISMA 2020\]\]：辨識 40（\+10） → 篩選 35（\+5） → 全文評估 10 → 納入 6（\+2）；尚待篩選：標題摘要 3\n/);
	assert.match(md, /- \[\[Zotero\/Reviews\/新\|新回顧\]\]：辨識 12；沒有待篩選的文獻（上次報告後新增的回顧）/);
	// First report: no deltas, a note that there is nothing to compare
	let first = pr.buildSections({ reviews: pr.diffPrisma([review], null), hasSnapshot: false }, { reading: false, writing: false, pubmed: false, goals: false });
	assert.match(first, /辨識 40 → 篩選 35 → 全文評估 10 → 納入 6；/);
	assert.match(first, /這是第一份報告/);

	// History: one entry per date, newest kept, the previous one found by date
	let h = pr.updateHistory([], { date: "2026-09-24", prisma: prev, drafts: {} });
	h = pr.updateHistory(h, { date: "2026-10-08", prisma: snapshot, drafts: {} });
	h = pr.updateHistory(h, { date: "2026-10-08", prisma: {}, drafts: { a: 1 } });
	assert.deepEqual(h.map(x => x.date), ["2026-09-24", "2026-10-08"]);
	assert.deepEqual(h[1].drafts, { a: 1 });
	assert.equal(pr.previousEntry(h, "2026-10-08").date, "2026-09-24");
	assert.equal(pr.previousEntry(h, "2026-09-24"), null);
	let capped = [];
	for (let i = 1; i <= 30; i++) capped = pr.updateHistory(capped, { date: `2026-01-${String(i).padStart(2, "0")}`, prisma: {}, drafts: {} }, 24);
	assert.equal(capped.length, 24);
	assert.equal(capped[0].date, "2026-01-07");
	assert.deepEqual(pr.parseHistory("{oops"), []);
	assert.deepEqual(pr.parseHistory(JSON.stringify([{ date: "x" }, { date: "2026-10-01", prisma: [], drafts: null }])), [{ date: "2026-10-01", prisma: {}, drafts: {} }]);
});

test("drafts: only the user's own text counts (no frontmatter, plugin regions, comments, headings or citations)", () => {
	let note = [
		"---", "type: \"lit-review-draft\"", "generated_at: \"2026-10-02T00:00:00Z\"", "---", "",
		"# 文獻探討：跌倒", "",
		core.MARK_START, "AI 產生的草稿很長很長很長。", core.MARK_END, "",
		"## ✍️ 我的筆記", "",
		"跌倒預防很重要 [@chen2024]，見 [[Zotero/Chen 2024|Chen 的研究]]。",
		"%% 私人備註不算 %%",
		"Falls are common in older inpatients.",
		"```", "code is not counted", "```",
	].join("\n");
	assert.equal(pr.countWords("跌倒預防 fall prevention 2024"), 4 + 3);
	assert.equal(pr.countWords(pr.userText(note)), "跌倒預防很重要見".length + "Chen的研究".replace(/Chen/, "").length + 1 + 6);
	let d = pr.draftRecord(note, "Zotero/Drafts/文獻探討-跌倒.md", new Date(2026, 9, 5, 9).getTime());
	assert.equal(d.modified, "2026-10-05");
	assert.equal(d.generatedAt, "2026-10-02T00:00:00Z");
	assert.equal(d.link, "Zotero/Drafts/文獻探討-跌倒");
	assert.equal(d.words, pr.countWords(pr.userText(note)));
	let md = pr.buildSections({ writing: { total: 2, updated: [Object.assign({}, d, { wordsDelta: 300, generatedInPeriod: true })] } }, { reading: false, reviews: false, pubmed: false, goals: false });
	assert.match(md, new RegExp(`- \\[\\[Zotero/Drafts/文獻探討-跌倒\\|文獻探討-跌倒\\]\\]：修改於 2026-10-05，草稿產生於 \\d{4}-\\d{2}-\\d{2} · 我的文字約 ${d.words} 字（\\+300）`));
	assert.match(md, /Drafts 共 2 份，本期更新 \*\*1\*\* 份。/);
});

test("PubMed digest summary: papers per watch and how many were ticked", () => {
	let text = "---\ntype: \"pubmed-digest\"\n---\n# 新文獻 2026-10-01\n\n%% zotero-bridge:start — x %%\n\n## 跌倒預防\n\n- [ ] **A** · [PubMed](https://pubmed.ncbi.nlm.nih.gov/1/)\n- [x] **B** · [PubMed](https://pubmed.ncbi.nlm.nih.gov/2/)\n\n## 壓傷\n\n- [ ] **C**\n\n%% zotero-bridge:end %%\n\n## ✍️ 我的筆記\n\n- [ ] not counted\n";
	assert.deepEqual(pr.digestSummary(text), [{ name: "跌倒預防", total: 2, checked: 1 }, { name: "壓傷", total: 1, checked: 0 }]);
	assert.deepEqual(pr.digestSummary(""), []);
});

test("goals: dialog lines, the previous report's 下次目標 carried over with the user's check marks", () => {
	assert.deepEqual(pr.parseLines("- 完成第二章\n2. 篩選 50 篇\n\n- [ ] 問老師\n（未填寫）"), ["完成第二章", "篩選 50 篇", "問老師"]);
	let previous = "# 進度報告\n\n### 下次目標\n\n- [ ] 完成第二章初稿\n- [x] 篩選 50 篇\n- [ ] 完成第二章初稿\n\n### 其他\n\n- [ ] 不是目標\n";
	assert.deepEqual(pr.extractSection(previous, "下次目標"), "- [ ] 完成第二章初稿\n- [x] 篩選 50 篇\n- [ ] 完成第二章初稿");
	assert.equal(pr.extractSection(previous, "沒有這節"), "");
	assert.deepEqual(pr.carryOverGoals(previous, ""), [{ text: "完成第二章初稿", done: false }, { text: "篩選 50 篇", done: true }]);
	// Rebuilding today's report keeps what the user ticked there
	let current = "### 上次目標回顧\n\n- [x] 完成第二章初稿\n- [ ] 篩選 50 篇\n";
	assert.deepEqual(pr.carryOverGoals(previous, current), [{ text: "完成第二章初稿", done: true }, { text: "篩選 50 篇", done: false }]);
	assert.deepEqual(pr.carryOverGoals("", current), []);
	// A section ends at the plugin's end marker
	assert.equal(pr.extractSection("### 下次目標\n\n- [ ] a\n%% zotero-bridge:end %%\n- [ ] b", "下次目標"), "- [ ] a");

	let md = pr.buildSections({ goals: { hasPrevious: true, previous: [{ text: "完成第二章初稿", done: true }], questions: ["樣本數怎麼估？"], next: [] } },
		{ reading: false, reviews: false, writing: false, pubmed: false });
	assert.equal(md, "## 問題與下次目標\n\n### 上次目標回顧\n\n- [x] 完成第二章初稿\n\n### 本次想討論的問題\n\n1. 樣本數怎麼估？\n\n### 下次目標\n\n（未填寫）");
	// Placeholders don't come back as goals or questions
	assert.deepEqual(pr.parseLines(pr.extractSection(md, "下次目標")), []);
	assert.deepEqual(pr.parseChecklist(pr.extractSection(md, "下次目標")), []);
	assert.deepEqual(pr.parseLines(pr.extractSection(md, "本次想討論的問題")), ["樣本數怎麼估？"]);
});

const PERIOD = { start: "2026-09-24", end: "2026-10-08" };
const PATHS = pr.reportPaths(["Zotero"], "2026-10-08", "");

function facts() {
	return {
		reading: {
			finished: [{ key: "library/A", link: "Zotero/Chen 2024 - Falls", title: "Falls [RCT] | 2024", from: "待讀", to: "已讀", date: "2026-10-02" }],
			added: [{ link: "Zotero/Lee 2025 - Exercise", title: "Exercise", date: "2026-10-01", status: "待讀" }],
			aiNotes: [],
			appraisals: [{ link: "Zotero/Chen 2024 - Falls", title: "Falls", date: "2026-10-03", tool: "JBI RCT", overall: "納入" }],
			logSince: true,
		},
		reviews: [], hasSnapshot: false,
		writing: { total: 0, updated: [] },
		pubmed: { days: [{ date: "2026-10-01", link: "Zotero/新文獻/2026-10-01", groups: [{ name: "跌倒預防", total: 3, checked: 1 }] }], total: 3, checked: 1 },
		goals: { hasPrevious: false, previous: [], questions: ["樣本數怎麼估？"], next: [{ text: "完成第二章初稿", done: false }] },
	};
}

test("the note: managed region rebuilt, the user's text and keys kept; plain text and Notion versions", () => {
	let sections = pr.buildSections(facts(), {});
	assert.match(sections, /^## 本期閱讀\n\n讀完 \*\*1\*\* 篇 · 新加入 \*\*1\*\* 篇 · AI 文獻筆記 \*\*0\*\* 篇 · 完成核對的嚴格評讀 \*\*1\*\* 篇/);
	assert.match(sections, /- \[\[Zotero\/Chen 2024 - Falls\|Falls \(RCT\) ｜ 2024\]\] — 待讀 → 已讀（2026-10-02）/);
	assert.match(sections, /- \[\[Zotero\/Chen 2024 - Falls\|Falls\]\] — JBI RCT，整體：納入，2026-10-03 核對/);
	assert.match(sections, /本期 PubMed|PubMed 追蹤本期匯入 \*\*3\*\* 篇（勾選看過 1 篇）：\n\n- \[\[Zotero\/新文獻\/2026-10-01\|2026-10-01\]\]：跌倒預防 3 篇/);
	assert.match(sections, /### 上次目標回顧\n\n這是第一份報告。/);
	assert.doesNotMatch(sections, /閱讀狀態的變更從安裝/);
	let noLog = facts();
	noLog.reading.logSince = false;
	assert.match(pr.buildSections(noLog, {}), /> \[!note\] 閱讀狀態的變更從安裝這一版之後才開始記錄/);
	// Sections can be left out
	assert.deepEqual(pr.buildSections(facts(), { reading: false, reviews: false, writing: false, pubmed: false }).split("\n")[0], "## 問題與下次目標");

	let meta = { date: "2026-10-08", period: PERIOD, previous: { date: "2026-09-24", link: "Zotero/進度報告/2026-09-24" }, generatedAt: "2026-10-08T04:00:00Z", paths: PATHS };
	let region = pr.buildRegion(sections, null, meta);
	let note = pr.buildReportNote(null, region, meta);
	assert.match(note, /^---\ntype: "advisor-progress-report"\ndate: "2026-10-08"\nperiod_start: "2026-09-24"\nperiod_end: "2026-10-08"\nprevious_report: "2026-09-24"\ngenerated_at: "2026-10-08T04:00:00Z"\n---\n\n# 進度報告 2026-10-08\n\n%% zotero-bridge:start/);
	assert.match(note, /> \[!info\] 報告期間 2026-09-24 至 2026-10-08（上次報告：\[\[Zotero\/進度報告\/2026-09-24\|2026-09-24\]\]）。由 ZotMax 於 2026-10-08 依 Zotero 與 vault 的資料產生，沒有使用 AI。/);
	assert.match(note, /pandoc 2026-10-08\.md -f markdown\+wikilinks_title_after_pipe --lua-filter zotero-bridge-report\.lua -o 進度報告-2026-10-08\.docx/);
	assert.match(note, /%% zotero-bridge:end %%\n\n## ✍️ 我的筆記\n\n$/);

	// The user writes above and below the region and adds a key; a rebuild keeps all of it
	let edited = note.replace("---\n\n# 進度報告", "tags: [\"會議\"]\n---\n\n# 進度報告").replace("# 進度報告 2026-10-08\n", "# 進度報告 2026-10-08\n\n會議時間：10/9 14:00\n")
		+ "老師說要先確認樣本數。\n";
	let f2 = facts();
	f2.reading.finished = [];
	let meta2 = Object.assign({}, meta, { generatedAt: "2026-10-08T09:00:00Z", model: "test-model", notionUrl: "https://www.notion.so/p" });
	let summary = { text: "本期讀完 1 篇。", unsupported: ["7"], truncated: false, model: "test-model" };
	let again = pr.buildReportNote(edited, pr.buildRegion(pr.buildSections(f2, {}), summary, meta2), meta2);
	assert.match(again, /^---\ntype: "advisor-progress-report"[\s\S]*generated_at: "2026-10-08T09:00:00Z"\ntags: \["會議"\]\nai_model: "test-model"\nnotion: "https:\/\/www\.notion\.so\/p"\n---\n/);
	assert.match(again, /# 進度報告 2026-10-08\n\n會議時間：10\/9 14:00\n\n%% zotero-bridge:start/);
	assert.match(again, /## ✍️ 我的筆記\n\n老師說要先確認樣本數。\n$/);
	assert.equal(again.split("%% zotero-bridge:start").length, 2);
	assert.match(again, /讀完 \*\*0\*\* 篇/);
	assert.match(again, /## 本期摘要（AI 整理）\n\n本期讀完 1 篇。\n\n> \[!note\] 由 test-model 依本報告列出的事實整理[\s\S]*> ⚠️ 摘要中的數字 7 在報告資料中找不到/);
	assert.match(again, /「本期摘要」由 AI 依這些資料整理/);
	// A report made as Zotero Bridge (≤ 0.10): rebuilt in place, the old name gone from the region
	const asOld = text => text.split("ZotMax").join("Zotero Bridge");
	assert.match(asOld(edited), /由 Zotero Bridge 於 2026-10-08/);
	let fromOld = pr.buildReportNote(asOld(edited), pr.buildRegion(pr.buildSections(f2, {}), summary, meta2), meta2);
	assert.equal(fromOld.split("%% zotero-bridge:start").length, 2);
	assert.match(fromOld, /會議時間：10\/9 14:00\n\n%% zotero-bridge:start — 此區塊由 ZotMax 自動產生/);
	assert.match(fromOld, /## ✍️ 我的筆記\n\n老師說要先確認樣本數。\n$/);
	assert.doesNotMatch(fromOld, /Zotero Bridge/);
	// Markers removed by the user: a fresh region after the title, nothing lost
	let noMarkers = again.replace(/%% zotero-bridge:start[\s\S]*%% zotero-bridge:end %%/, "我把區塊刪了");
	let rebuilt = pr.buildReportNote(noMarkers, region, meta);
	assert.match(rebuilt, /# 進度報告 2026-10-08\n\n%% zotero-bridge:start[\s\S]*%% zotero-bridge:end %%\n\n\n會議時間/);
	assert.match(rebuilt, /我把區塊刪了/);

	// Plain text for LINE/Email: no link syntax, bold or callouts
	let plain = pr.buildPlainReport(sections, summary, meta);
	assert.match(plain, /^進度報告 2026-10-08\n報告期間：2026-09-24 至 2026-10-08\n\n【本期摘要】\n本期讀完 1 篇。\n\n【本期閱讀】\n\n讀完 1 篇 · 新加入 1 篇/);
	assert.match(plain, /■ 讀完（狀態改為已讀／已引用）\n\n・Falls \(RCT\) ｜ 2024 — 待讀 → 已讀（2026-10-02）/);
	assert.match(plain, /・2026-10-01：跌倒預防 3 篇/);
	assert.match(plain, /■ 下次目標\n\n☐ 完成第二章初稿/);
	assert.doesNotMatch(plain, /\[\[|\*\*|%%|\[!/);
	let notionMd = pr.buildNotionMarkdown(sections, null, meta);
	assert.doesNotMatch(notionMd, /\[\[/);
	assert.match(notionMd, /- Falls \(RCT\) ｜ 2024 — 待讀 → 已讀/);
});

test("AI paragraph: prompt from the facts only; numbers not in the facts are flagged", () => {
	let factsText = pr.toPlainText(pr.buildSections(facts(), {}));
	let p = pr.buildSummaryPrompt(factsText, PERIOD);
	assert.equal(p.system, pr.SUMMARY_PROMPT);
	assert.match(p.system, /只能使用 <facts> 裡的事實與數字，不得加入新的研究發現/);
	assert.match(p.user, /^<period>2026-09-24 至 2026-10-08<\/period>\n<facts>\n【本期閱讀】[\s\S]*樣本數怎麼估？[\s\S]*<\/facts>\n\n請依照系統指示撰寫本期摘要。$/);
	let out = pr.processSummary("```\n## 本期摘要\n- 本期讀完 **1** 篇文獻，追蹤匯入 3 篇，另完成 12 篇評讀。\n```", factsText);
	assert.deepEqual(out, { text: "本期讀完 1 篇文獻，追蹤匯入 3 篇，另完成 12 篇評讀。", unsupported: ["12"], truncated: false });
	assert.equal(pr.processSummary("一段。\n> ⚠️ 輸出達到長度上限，內容可能不完整", factsText).truncated, true);
	let est = pr.estimateSummaryCost(p, "test-model", { "test-model": { input: 1, output: 5 } });
	assert.ok(est.inputTokens > 100);
	assert.ok(est.expected > 0 && est.max > est.expected);
	assert.equal(pr.estimateSummaryCost(p, "unpriced-model", {}).expected, null);
});

test("Pandoc: a reference .docx from Drafts is used when there is one", () => {
	assert.equal(pr.pickReferenceDoc(["文獻探討-跌倒.md", "論文範本.docx", "~$論文範本.docx"]), "論文範本.docx");
	assert.equal(pr.pickReferenceDoc(["x.docx", "reference.docx"]), "reference.docx");
	assert.equal(pr.pickReferenceDoc(["文獻探討-跌倒.docx"]), "");
	let p = pr.reportPaths(["Zotero"], "2026-10-08", "論文範本.docx");
	assert.equal(p.command, "pandoc 2026-10-08.md -f markdown+wikilinks_title_after_pipe --lua-filter zotero-bridge-report.lua --reference-doc ../Drafts/論文範本.docx -o 進度報告-2026-10-08.docx");
	assert.equal(p.relPath, "Zotero/進度報告/2026-10-08.md");
});

let hasPandoc = false;
try {
	execFileSync("pandoc", ["--version"], { stdio: "ignore" });
	hasPandoc = true;
}
catch (e) {}

test("the report converts with Pandoc and the Lua filter", { skip: !hasPandoc && "pandoc is not installed" }, () => {
	let dir = fs.mkdtempSync(path.join(os.tmpdir(), "zb-report-pandoc-"));
	let meta = { date: "2026-10-08", period: PERIOD, previous: { date: "2026-09-24", link: "Zotero/進度報告/2026-09-24" }, generatedAt: "2026-10-08T04:00:00Z", paths: PATHS };
	let summary = { text: "本期讀完 1 篇。", unsupported: [], truncated: false, model: "test-model" };
	let note = pr.buildReportNote(null, pr.buildRegion(pr.buildSections(facts(), {}), summary, meta), meta) + "私人筆記內容\n";
	fs.writeFileSync(path.join(dir, PATHS.fileName), note);
	fs.writeFileSync(path.join(dir, pr.FILTER_FILE), pr.PANDOC_FILTER);
	let args = PATHS.command.split(" ").slice(1);
	let out = execFileSync("pandoc", [...args.slice(0, args.indexOf("-o")), "-t", "plain", "--wrap=none"], { cwd: dir, encoding: "utf8" });
	assert.match(out, /本期摘要（AI 整理）\n\n本期讀完 1 篇。/);
	assert.match(out, /Falls \(RCT\) ｜ 2024 — 待讀 → 已讀（2026-10-02）/);
	assert.match(out, /2026-10-01：跌倒預防 3 篇/);
	assert.match(out, /☐ 完成第二章初稿/);
	assert.doesNotMatch(out, /%%|\[\[|Pandoc 指令|我的筆記|私人筆記|報告期間 2026|\[!note\]|由 test-model/);
	// And the Word file itself
	execFileSync("pandoc", args, { cwd: dir });
	assert.ok(fs.statSync(path.join(dir, PATHS.docx)).size > 1000);
});
