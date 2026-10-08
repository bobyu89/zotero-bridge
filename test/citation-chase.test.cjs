// Citation searching (OpenAlex) for reviews: URLs, throttling, request cap, paging, deduplication
// against the library, the candidate note and CSV, checked-item parsing, and the PRISMA 2020
// "other methods" column in screening.js (pure helpers)
const test = require("node:test");
const assert = require("node:assert/strict");
const cc = require("../content/citation-chase.js");
const s = require("../content/screening.js");
const core = require("../content/core.js");
const { work, openAlexMock } = require("./openalex-mock.cjs");

// A fake clock: sleep() advances time instead of waiting
function clock() {
	let t = 0;
	let sleeps = [];
	return { now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; }, sleeps, get t() { return t; } };
}

function client(fetch, opts = {}) {
	let c = clock();
	return Object.assign(new cc.OpenAlexClient(Object.assign({ fetch, email: "me@example.com", now: c.now, sleep: c.sleep, random: () => 0 }, opts)), { clock: c });
}

test("OpenAlex URLs: doi:/pmid: lookups, cited_by:/cites: lists with select, sort, per-page, cursor and mailto", () => {
	assert.equal(cc.seedURL({ doi: "https://doi.org/10.1016/S0021-9258(19)52451-6" }, { email: "me@example.com" }),
		"https://api.openalex.org/works/doi:10.1016/s0021-9258(19)52451-6?select=id,doi,display_name,cited_by_count,referenced_works&mailto=me@example.com");
	assert.equal(cc.seedURL({ doi: "", pmid: "29456894" }), "https://api.openalex.org/works/pmid:29456894?select=id,doi,display_name,cited_by_count,referenced_works");
	assert.equal(cc.seedURL({ doi: "not a doi" }), null);
	assert.equal(cc.listURL("cites:W2741809807", "*", { email: "me@example.com" }),
		"https://api.openalex.org/works?filter=cites:W2741809807&select=id,doi,display_name,publication_year,primary_location,cited_by_count,ids,type"
		+ "&sort=cited_by_count:desc&per-page=200&cursor=*&mailto=me@example.com");
	assert.match(cc.listURL("cited_by:W1", "IlsxNj=", { perPage: 50 }), /&per-page=50&cursor=IlsxNj%3D$/);
	assert.equal(cc.openAlexKey("https://openalex.org/W2741809807"), "W2741809807");
	assert.equal(cc.pmidOf("https://pubmed.ncbi.nlm.nih.gov/29456894"), "29456894");
	assert.equal(cc.pmidFromExtra("tex.x: 1\nPMID: 123\nPMCID: PMC9"), "123");
	assert.deepEqual(cc.workToCandidate(work(7, { doi: "https://doi.org/10.5555/W7", ids: { pmid: "https://pubmed.ncbi.nlm.nih.gov/777" }, display_name: "A <i>title</i>" })), {
		openalex: "W7", doi: "10.5555/w7", pmid: "777", title: "A title", year: "2020", journal: "Journal of Nursing", citedBy: 7, type: "article",
	});
});

test("throttle keeps requests 200 ms apart (5 per second) without blocking", async () => {
	let c = clock();
	let wait = cc.makeThrottle(cc.MIN_INTERVAL_MS, c);
	let times = [];
	for (let i = 0; i < 5; i++) {
		await wait();
		times.push(c.t);
	}
	assert.deepEqual(times, [0, 200, 400, 600, 800]);
	assert.equal(cc.MIN_INTERVAL_MS, 200);
	// Time already passed counts
	c.sleeps.length = 0;
	await c.sleep(1000);
	c.sleeps.length = 0;
	await wait();
	assert.deepEqual(c.sleeps, []);

	// The client throttles every request, retries included
	let api = openAlexMock({ works: [work(1)] }, { fail: (url, n) => (n === 1 ? { status: 429, ok: false, headers: { get: k => (k === "retry-after" ? "1" : null) }, text: async () => "{}" } : undefined) });
	let cl = client(api.fetch);
	let w = await cl.get(cc.seedURL({ doi: "10.5555/w1" }));
	assert.equal(w.id, "https://openalex.org/W1");
	assert.equal(cl.requests, 2, "the retry counts as a request");
	assert.deepEqual(cl.clock.sleeps, [1000], "Retry-After honoured; the throttle needed no extra wait");
});

test("client: 404 is null, errors are clear, the request cap stops a run", async () => {
	let api = openAlexMock({ works: [] });
	let cl = client(api.fetch);
	assert.equal(await cl.get(cc.seedURL({ doi: "10.5555/none" })), null);
	let down = client(async () => { throw new TypeError("NetworkError when attempting to fetch resource."); });
	await assert.rejects(down.get("https://api.openalex.org/works/W1"), /無法連線到 OpenAlex：NetworkError/);
	assert.equal(down.requests, 3, "two retries");
	let limited = client(async () => ({ status: 429, ok: false, headers: { get: () => null }, text: async () => "{}" }), { maxRetries: 0 });
	await assert.rejects(limited.get("https://api.openalex.org/works/W1"), /OpenAlex 回應 429（請求太頻繁或超過每日額度/);
	let capped = client(api.fetch, { maxRequests: 1 });
	await capped.get("https://api.openalex.org/works/W1");
	await assert.rejects(capped.get("https://api.openalex.org/works/W1"), cc.RequestCapError);
	assert.equal(capped.requests, 1);
});

test("paging: cursor pages up to the per-study cap, most cited first", async () => {
	let citing = Array.from({ length: 450 }, (_, i) => work(1000 + i));
	let api = openAlexMock({ works: [work(1)], citing: { W1: citing } });
	let cl = client(api.fetch);
	let list = await cc.listWorks(cl, "cites:W1", 300);
	assert.equal(list.works.length, 300);
	assert.equal(list.total, 450);
	assert.equal(list.capped, true);
	assert.equal(cl.requests, 2, "two pages of 200");
	assert.equal(list.works[0].id, "https://openalex.org/W1449");
	assert.match(api.log[1], /cursor=p1/);
	// A short list: one page, not capped
	let few = await cc.listWorks(client(openAlexMock({ citing: { W1: citing.slice(0, 3) } }).fetch), "cites:W1", 300);
	assert.deepEqual([few.works.length, few.total, few.capped], [3, 3, false]);
	// Small cap: per-page follows it
	let api2 = openAlexMock({ citing: { W1: citing } });
	let small = await cc.listWorks(client(api2.fetch), "cites:W1", 50);
	assert.equal(small.works.length, 50);
	assert.match(api2.log[0], /per-page=50/);
	assert.equal(api2.log.length, 1);
});

test("chase: both directions per seed, skips empty lists, reports missing IDs and the request cap", async () => {
	let w1 = work(1, { referenced_works: ["https://openalex.org/W11", "https://openalex.org/W12"], cited_by_count: 1 });
	let w2 = work(2, { doi: null, ids: { openalex: "https://openalex.org/W2", pmid: "https://pubmed.ncbi.nlm.nih.gov/222" }, cited_by_count: 0 });
	let db = {
		works: [w1, w2],
		refs: { W1: [work(11), work(12)], W2: [work(11)] },
		citing: { W1: [work(21)] },
	};
	w2.referenced_works = ["https://openalex.org/W11"];
	let seeds = [
		{ id: 1, label: "Chen, 2024", doi: "10.5555/w1" },
		{ id: 2, label: "Lin, 2023", doi: "", pmid: "222" },
		{ id: 3, label: "Wang, 2022", doi: "" },
		{ id: 4, label: "Lee, 2021", doi: "10.5555/missing" },
	];
	let api = openAlexMock(db);
	let cl = client(api.fetch);
	let progress = [];
	let run = await cc.chase(seeds, { client: cl, direction: "both", maxPerSeed: 100, onProgress: i => progress.push(i) });
	assert.deepEqual(run.reports.map(r => r.status), ["完成", "完成", "沒有 DOI 或 PMID，無法查詢", "OpenAlex 找不到這篇"]);
	assert.deepEqual(run.reports[0].backward, { found: 2, total: 2, capped: false });
	assert.deepEqual(run.reports[1].forward, { found: 0, total: 0, capped: false }, "cited_by_count 0: no request");
	assert.equal(run.hits.length, 4);
	assert.deepEqual(run.hits.map(h => [h.work.id.slice(-3), h.direction, h.seed.id]), [
		["W12", "backward", 1], ["W11", "backward", 1], ["W21", "forward", 1], ["W11", "backward", 2],
	]);
	// 1 + 2 for W1, 1 + 1 for W2, 1 for the missing one
	assert.equal(run.requests, 6);
	assert.deepEqual(progress, [0, 1, 2, 3]);
	assert.ok(api.log.every(u => u.includes("mailto=me@example.com")));

	// Only backward
	let back = await cc.chase(seeds.slice(0, 1), { client: client(openAlexMock(db).fetch), direction: "backward" });
	assert.equal(back.reports[0].forward, null);
	assert.ok(back.hits.every(h => h.direction === "backward"));

	// The cap: the first seed is done, the second only partly, the rest not queried
	let tight = await cc.chase(seeds, { client: client(openAlexMock(db).fetch, { maxRequests: 4 }), direction: "both" });
	assert.deepEqual(tight.reports.map(r => r.status), ["完成", "部分完成（已達請求上限）", "未查詢（已達請求上限）", "未查詢（已達請求上限）"]);
	assert.match(tight.stopped, /已達本次 OpenAlex 請求上限（4 次）/);
	assert.equal(tight.requests, 4);

	// A failing seed doesn't stop the others
	let flaky = openAlexMock(db, { fail: url => (url.includes("doi:10.5555/w1") ? { status: 500, ok: false, headers: { get: () => null }, text: async () => "{}" } : undefined) });
	let partial = await cc.chase(seeds.slice(0, 2), { client: client(flaky.fetch), direction: "both" });
	assert.match(partial.reports[0].status, /^失敗：OpenAlex 回應 500/);
	assert.equal(partial.reports[1].status, "完成");
});

test("candidates: merged per work, deduplicated against the library by DOI, PMID and title + year", () => {
	let seedA = { id: 1, label: "Chen, 2024" };
	let seedB = { id: 2, label: "Lin, 2023" };
	let hits = [
		{ work: work(11, { cited_by_count: 50 }), direction: "backward", seed: seedA },
		{ work: work(11, { cited_by_count: 50 }), direction: "backward", seed: seedB },
		{ work: work(11, { cited_by_count: 50 }), direction: "backward", seed: seedB },
		{ work: work(12, { doi: "https://doi.org/10.5555/KNOWN" }), direction: "forward", seed: seedA },
		{ work: work(13, { ids: { pmid: "https://pubmed.ncbi.nlm.nih.gov/313" } }), direction: "backward", seed: seedA },
		{ work: work(14, { doi: null, display_name: "Fall prevention bundles: a cluster RCT", publication_year: 2019 }), direction: "forward", seed: seedB },
		{ work: work(15, { cited_by_count: 900 }), direction: "forward", seed: seedA },
		{ work: work(16, { doi: "https://doi.org/10.5555/erratum", display_name: "Fall prevention bundles: a cluster RCT", publication_year: 2019 }), direction: "forward", seed: seedA },
	];
	let index = cc.libraryIndex([
		{ id: 100, doi: "10.5555/known", title: "x", year: "2010", inReview: true, uri: "zotero://select/library/items/K" },
		{ id: 101, doi: "", pmid: "313", title: "y", year: "2011", inReview: false },
		// Online-first 2020 in Zotero, 2019 in OpenAlex: still the same paper
		{ id: 102, doi: "10.5555/bundles", title: "Fall Prevention Bundles — a Cluster RCT.", date: "2020-01-05", inReview: false },
	]);
	let list = cc.buildCandidates(hits, index);
	assert.deepEqual(list.map(c => [c.openalex, c.inLibrary]), [
		// New first; then found from more studies, more cited
		["W11", ""], ["W15", ""], ["W16", ""], ["W14", "library"], ["W13", "library"], ["W12", "review"],
	]);
	assert.deepEqual(list[0].links.map(l => [l.direction, l.seed.id]), [["backward", 1], ["backward", 2]], "found from two studies, listed once");
	assert.equal(list.find(c => c.openalex === "W12").libraryURI, "zotero://select/library/items/K");
	// W16 has the same title and year as library item 102 but a different DOI: a different work
	assert.equal(list.find(c => c.openalex === "W16").inLibrary, "");
});

function sampleRun() {
	let seedA = { id: 1, label: "Chen, 2024", uri: "zotero://select/library/items/A" };
	let seedB = { id: 2, label: "Lin, 2023" };
	let hits = [
		{ work: work(11, { display_name: "Tai chi [pilot] | balance *and* falls", cited_by_count: 50, doi: "https://doi.org/10.1016/S0021-9258(19)52451-6" }), direction: "backward", seed: seedA },
		{ work: work(12, { doi: null, ids: { pmid: "https://pubmed.ncbi.nlm.nih.gov/1212" } }), direction: "forward", seed: seedB },
		{ work: work(13, { doi: null }), direction: "forward", seed: seedB },
		{ work: work(14, { doi: "https://doi.org/10.5555/known" }), direction: "backward", seed: seedB },
	];
	let candidates = cc.buildCandidates(hits, cc.libraryIndex([{ id: 9, doi: "10.5555/known", title: "", year: "", inReview: true }]));
	return {
		reports: [
			{ seed: seedA, status: "完成", openalex: "W1", backward: { found: 1, total: 1, capped: false }, forward: { found: 0, total: 0, capped: false } },
			{ seed: seedB, status: "完成", openalex: "W2", backward: { found: 1, total: 1, capped: false }, forward: { found: 2, total: 812, capped: true } },
		],
		candidates, requests: 7, stopped: "",
	};
}

test("note: task list of new candidates, full table with the library flag, checks kept on regeneration", () => {
	let run = sampleRun();
	let meta = { name: "跌倒預防 SR", uri: "zotero://select/library/collections/C1", generatedAt: "2026-10-08T00:00:00Z", csvPath: "Zotero/Reviews/跌倒預防 SR 引文追蹤.csv", email: "" };
	let section = cc.buildChaseSection(run, Object.assign({ checked: new Set(["pmid:1212"]) }, meta));
	assert.match(section, /^> \[!info\] 由 Zotero Bridge 依「跌倒預防 SR」的 2 篇研究，於 2026-10-08 查詢 OpenAlex（7 次請求）產生/);
	assert.match(section, /建議在 設定 → 引文追蹤 填入 email/);
	assert.match(section, /標示「已達上限」的研究只列出被引次數最高的部分文獻/);
	assert.ok(section.includes("| Lin, 2023 | [W2](https://openalex.org/W2) | 1 | 2 / 812（已達上限） | 完成 |"));
	assert.ok(section.includes("| [Chen, 2024](zotero://select/library/items/A) |"));
	assert.ok(section.includes("## 候選文獻（3 篇不在文獻庫中）"));
	assert.ok(section.includes("- [ ] **Tai chi \\[pilot\\] \\| balance \\*and\\* falls** (2020)｜*Journal of Nursing*｜被引 50｜← Chen, 2024｜"
		+ "[10.1016/s0021-9258(19)52451-6](https://doi.org/10.1016/s0021-9258%2819%2952451-6)"), section);
	assert.ok(section.includes("- [x] **Work 12 on nurse-led fall prevention** (2020)｜*Journal of Nursing*｜被引 12｜→ Lin, 2023｜[PMID 1212](https://pubmed.ncbi.nlm.nih.gov/1212/)"));
	assert.match(section, /^- \*\*Work 13 on nurse-led fall prevention\*\* .*\[OpenAlex W13\]\(https:\/\/openalex\.org\/W13\)（沒有 DOI／PMID，請手動加入）$/m);
	assert.ok(section.includes("## 總表（4 篇，其中 1 篇已在文獻庫）"));
	assert.ok(section.includes("| Work 14 on nurse-led fall prevention | 2020 | Journal of Nursing | 14 | ← 參考文獻 | Lin, 2023 | [10.5555/known](https://doi.org/10.5555/known) | 已在本回顧 |"));
	assert.ok(!/^- \[ \] \*\*Work 14/m.test(section), "already in the library: not a candidate");

	// The whole note through screening.buildReviewNote: the checked items survive a rerun
	let fm = cc.frontmatterFor(run, Object.assign({ title: "跌倒預防 SR：引文追蹤", collectionKey: "library/collections/C1" }, meta));
	assert.equal(fm.chase_new, 3);
	let note = s.buildReviewNote(null, fm, fm.title, section);
	assert.match(note, /^---\ntitle: "跌倒預防 SR：引文追蹤"\ntype: "citation-chase"\n/);
	let edited = note.replace("- [ ] **Tai chi", "- [x] **Tai chi").replace("## ✍️ 我的筆記\n\n", "## ✍️ 我的筆記\n\n- [x] [outside](https://doi.org/10.5555/outside)\n");
	let checked = cc.parseChecked(edited);
	assert.deepEqual(checked.map(c => c.key), ["doi:10.1016/s0021-9258(19)52451-6", "pmid:1212"], "only the managed region counts");
	assert.equal(checked[0].title, "Tai chi [pilot] | balance *and* falls");
	let again = cc.buildChaseSection(run, Object.assign({}, meta, { checked: new Set(checked.map(c => c.key)) }));
	let rerun = s.buildReviewNote(edited, fm, fm.title, again);
	assert.match(rerun, /^- \[x\] \*\*Tai chi/m);
	assert.match(rerun, /^- \[x\] \*\*Work 12/m);
	assert.match(rerun, /- \[x\] \[outside\]/, "the user's notes are kept");
});

test("checked items: imported ones are marked and skipped next time; unchecked and ID-less lines ignored", () => {
	let text = [
		"# R", "", core.MARK_START, "",
		"- [x] **A** (2020)｜[10.5555/a](https://doi.org/10.5555/a)",
		"- [X] **B**｜[PMID 22](https://pubmed.ncbi.nlm.nih.gov/22/)",
		"- [ ] **C**｜[10.5555/c](https://doi.org/10.5555/c)",
		"- [x] **D** without link",
		"  * [x] **E**｜[x](http://dx.doi.org/10.5555/E)",
		"- [x] **A again**｜[10.5555/a](https://doi.org/10.5555/A)",
		"", core.MARK_END, "",
	].join("\n");
	let checked = cc.parseChecked(text);
	assert.deepEqual(checked.map(c => [c.key, c.title, c.imported]), [
		["doi:10.5555/a", "A", false], ["pmid:22", "B", false], ["doi:10.5555/e", "E", false],
	]);
	let marked = cc.markImported(text, new Set(["doi:10.5555/a", "pmid:22"]));
	assert.match(marked, /^- \[x\] ✅ 已匯入 \*\*A\*\* \(2020\)/m);
	assert.match(marked, /^- \[X\] ✅ 已匯入 \*\*B\*\*/m);
	assert.match(marked, /^ {2}\* \[x\] \*\*E\*\*/m);
	assert.deepEqual(cc.parseChecked(marked).map(c => c.imported), [true, true, false]);
	assert.equal(cc.markImported(marked, new Set(["doi:10.5555/a"])), marked, "marked once");
	assert.deepEqual(cc.parseChecked("- [x] [a](https://doi.org/10.5555/a)"), [], "no managed region");
});

test("CSV: BOM, CRLF, one row per candidate with direction, studies and the library flag", () => {
	let csv = cc.buildChaseCSV(sampleRun().candidates);
	assert.ok(csv.startsWith("﻿標題,年份,期刊,被引次數,方向,來自納入研究,DOI,PMID,OpenAlex,文獻類型,已在文獻庫\r\n"));
	let lines = csv.slice(1).trimEnd().split("\r\n");
	assert.equal(lines.length, 5);
	assert.equal(lines[1], "Tai chi [pilot] | balance *and* falls,2020,Journal of Nursing,50,← 參考文獻,\"Chen, 2024\",10.1016/s0021-9258(19)52451-6,,https://openalex.org/W11,article,");
	assert.match(lines[4], /,10\.5555\/known,,https:\/\/openalex\.org\/W14,article,已在本回顧$/);
});

// ---------- PRISMA 2020: other methods (screening.js) ----------

let nextID = 1;
function rec(tags, extra = {}) {
	let id = nextID++;
	return Object.assign({ id, key: `KEY${id}`, title: `Paper ${id}`, year: "2024", tags, catalog: "PubMed", uri: `zotero://select/library/items/KEY${id}` }, extra);
}

const T = { taIn: "篩選/標題摘要/納入", taEx: "篩選/標題摘要/排除", ftIn: "篩選/全文/納入", ftEx: "篩選/全文/排除", ftNR: "篩選/全文/無法取得", dup: "篩選/重複" };

test("PRISMA: 來源/引文追蹤, 網站, 機構 records go to the other-methods column; the totals add up", () => {
	let records = [
		rec([T.taIn, T.ftIn]),
		rec([T.taIn, T.ftEx, "排除原因/" + s.DEFAULT_REASONS[0]]),
		rec([T.taEx]),
		rec([T.dup]),
		// Other methods: straight to full text is fine (no title/abstract stage in the template)
		rec([T.ftIn, "來源/引文追蹤"]),
		rec([T.taIn, T.ftIn, "來源/引文追蹤"]),
		rec([T.ftEx, "排除原因/" + s.DEFAULT_REASONS[3], "來源/引文追蹤"]),
		rec([T.ftNR, "來源/網站"]),
		rec([T.taEx, "來源/引文追蹤"]),
		rec([T.dup, "來源/機構"]),
		rec(["來源/引文追蹤"]),
		rec([T.taIn, "來源/網站"]),
		// Found in a database too: counted there
		rec([T.taEx, "來源/引文追蹤", "來源/CINAHL"]),
	];
	let result = s.computePrisma(records, s.normalizeConfig({}));
	assert.deepEqual({ ...result.counts }, {
		identified: 5, duplicates: 1, screened: 4, taExcluded: 2, taPending: 0,
		sought: 2, notRetrieved: 0, assessed: 2, ftExcluded: 1, ftPending: 0, included: 1,
	});
	assert.deepEqual({ ...result.other.counts }, {
		identified: 8, duplicates: 1, screened: 7, taExcluded: 1, taPending: 1,
		sought: 5, notRetrieved: 1, assessed: 4, ftExcluded: 1, ftPending: 1, included: 2,
	});
	assert.deepEqual(result.other.sources, [["引文追蹤", 5], ["網站", 2], ["機構", 1]]);
	assert.deepEqual(result.other.reasons, [[s.DEFAULT_REASONS[3], 1]]);
	assert.deepEqual(result.sources, [["PubMed", 4], ["CINAHL", 1], ["引文追蹤", 1]]);
	assert.equal(result.totalIncluded, 3);
	assert.equal(result.included.length, 3);
	assert.deepEqual(s.checkCounts(result.other.counts, result.other.reasons), []);
	assert.ok(!result.issues.some(i => i.code === "ftWithoutTA"), "no warning for other-method records without a title/abstract decision");
	assert.ok(!result.issues.some(i => i.code === "countMismatch"));
	assert.equal(result.issues.find(i => i.code === "taPending").records.length, 1);

	// Without such records nothing changes
	let plain = s.computePrisma(records.slice(0, 4), s.normalizeConfig({}));
	assert.equal(plain.other, null);
	assert.equal(plain.totalIncluded, 1);
	assert.doesNotMatch(s.buildMermaid(plain), /other/);

	// The list is a setting
	assert.deepEqual(s.parseSourceList("引文追蹤, 灰色文獻，專家推薦\n"), ["引文追蹤", "灰色文獻", "專家推薦"]);
	let custom = s.computePrisma(records, s.normalizeConfig({ otherSources: ["網站"] }));
	assert.equal(custom.other.counts.identified, 2);
	assert.equal(custom.counts.identified, 11);
	assert.deepEqual(s.normalizeConfig({ otherSources: [] }).otherSources, s.DEFAULT_OTHER_SOURCES);
});

test("PRISMA Mermaid and counts table: the right-hand column for other methods", () => {
	let records = [
		rec([T.taIn, T.ftIn]),
		rec([T.ftIn, "來源/引文追蹤"]),
		rec([T.ftEx, "排除原因/" + s.DEFAULT_REASONS[0], "來源/引文追蹤"]),
		rec([T.taEx, "來源/網站"]),
		rec([T.ftNR, "來源/灰色文獻"]),
	];
	let result = s.computePrisma(records, s.normalizeConfig({ otherSources: ["引文追蹤", "網站", "灰色文獻"] }));
	let mermaid = s.buildMermaid(result);
	assert.ok(mermaid.includes('    otherIdentified["Records identified from:<br/>Citation searching (n = 2)<br/>灰色文獻 (n = 1)<br/>Websites (n = 1)"]'), mermaid);
	assert.ok(mermaid.includes('    otherRemoved["Records excluded (n = 1)"]'));
	assert.ok(mermaid.includes('    otherSought["Reports sought for retrieval<br/>(n = 3)"]'));
	assert.ok(mermaid.includes('    otherNotRetrieved["Reports not retrieved<br/>(n = 1)"]'));
	assert.ok(mermaid.includes(`    otherExcluded["Reports excluded (n = 1):<br/>${s.DEFAULT_REASONS[0]} (n = 1)"]`));
	assert.ok(mermaid.includes('    included["Studies included in review<br/>(n = 2)<br/>Reports of included studies (n = 2)"]'));
	assert.ok(mermaid.includes('    identified["Records identified from databases and registers<br/>(n = 1)<br/>PubMed (n = 1)"]'));
	for (let edge of ["otherIdentified --> otherRemoved", "otherIdentified --> otherSought", "otherSought --> otherNotRetrieved",
		"otherSought --> otherAssessed", "otherAssessed --> otherExcluded", "otherAssessed --> included"]) {
		assert.ok(mermaid.includes(`    ${edge}\n`) || mermaid.endsWith(`    ${edge}`), edge);
	}
	// Nodes sit in the template's rows (identification / screening)
	let ident = mermaid.slice(mermaid.indexOf("subgraph identification"), mermaid.indexOf("subgraph screening"));
	assert.match(ident, /otherIdentified\[/);
	let screen = mermaid.slice(mermaid.indexOf("subgraph screening"), mermaid.indexOf("subgraph includedStage"));
	assert.match(screen, /otherAssessed\[/);

	let table = s.countsTable(result);
	assert.ok(table.includes("| 其他方法 | Records identified from other methods（引文追蹤、網站等） | 4 |"));
	assert.ok(table.includes("|  | └ 引文追蹤（Citation searching） | 2 |"));
	assert.ok(table.includes("|  | └ 灰色文獻 | 1 |"));
	assert.ok(table.includes("| 其他方法 | Reports sought for retrieval | 3 |"));
	assert.ok(table.includes("| 納入 | Studies included in review | 2 |"));
	assert.ok(table.includes("|  | └ 資料庫與登錄庫／其他方法 | 1／1 |"));
	let fm = s.frontmatterFor(result, { title: "t", collectionKey: "k", name: "n" });
	assert.equal(fm.prisma_included, 2);
	assert.equal(fm.prisma_other_identified, 4);
	assert.equal(fm.prisma_other_included, 1);
	assert.equal(s.frontmatterFor(s.computePrisma(records.slice(0, 1)), { title: "t" }).prisma_other_identified, undefined);
	// Pending other-method records are dashed like the left column
	let pending = s.computePrisma([rec(["來源/引文追蹤"]), rec([T.taIn, "來源/引文追蹤"])]);
	let pm = s.buildMermaid(pending);
	assert.match(pm, /otherTaPending\["Records awaiting screening<br\/>\(n = 1\)"\]:::pending/);
	assert.match(pm, /otherFtPending\["Reports awaiting assessment<br\/>\(n = 1\)"\]:::pending/);
	assert.match(pm, /classDef pending/);
	assert.doesNotMatch(pm, /otherRemoved/);
});
