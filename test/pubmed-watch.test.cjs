// PubMed new-literature watch: the pure helpers (settings, E-utilities URLs and responses,
// throttling, candidates, the Obsidian digest note).
const test = require("node:test");
const assert = require("node:assert/strict");
const pw = require("../content/pubmed-watch.js");

const FALLS = '("Accidental Falls"[Mesh]) AND nurs*[tiab]';

test("parseWatches fills in defaults and reports invalid watches without throwing", () => {
	let { watches, errors } = pw.parseWatches(JSON.stringify([
		{ name: "跌倒預防", query: FALLS },
		{ id: "w2", name: "壓傷", query: "pressure ulcer[tiab]", collection: "碩論/壓傷", days: "7", since: "2020-1", enabled: false },
		{ name: "", query: "x" },
		{ name: "括號", query: "(falls AND nurs*" },
		{ name: "引號", query: '"falls AND nurs*' },
		{ name: "跌倒預防", query: "duplicate name" },
		{ name: "日期", query: "x", since: "去年" },
	]));
	assert.deepEqual(watches, [
		{ id: "跌倒預防", name: "跌倒預防", query: FALLS, collection: "📥 新文獻/跌倒預防", days: 30, since: "", enabled: true },
		{ id: "w2", name: "壓傷", query: "pressure ulcer[tiab]", collection: "碩論/壓傷", days: 7, since: "2020/01", enabled: false },
	]);
	assert.equal(errors.length, 5);
	assert.match(errors[0], /第 3 筆：沒有名稱/);
	assert.match(errors[1], /括號：檢索式的括號不成對/);
	assert.match(errors[2], /引號：檢索式的引號不成對/);
	assert.match(errors[3], /跌倒預防：名稱重複/);
	assert.match(errors[4], /日期：出版日期起始「去年」看不懂/);

	assert.deepEqual(pw.parseWatches("not json").watches, []);
	assert.match(pw.parseWatches("not json").errors[0], /不是有效的 JSON/);
	assert.match(pw.parseWatches("{}").errors[0], /必須是 JSON 陣列/);
	assert.deepEqual(pw.parseWatches(""), { watches: [], errors: [] });
	// A slash in the name stays inside one collection level
	assert.equal(pw.defaultCollection("ICU/CCU"), "📥 新文獻/ICU／CCU");
	assert.equal(pw.normalizeWatch({ name: "a", query: "b", days: 99999 }, 0).watch.days, 3650);
});

test("watchTerm adds the publication-date filter in PubMed syntax", () => {
	assert.equal(pw.watchTerm({ query: FALLS, since: "" }), FALLS);
	assert.equal(pw.watchTerm({ query: FALLS, since: "2020/01/05" }),
		`(${FALLS}) AND ("2020/01/05"[dp] : "3000"[dp])`);
	assert.equal(pw.normalizeSince("2023.1.5"), "2023/01/05");
	assert.equal(pw.normalizeSince("2023"), "2023");
});

test("searchWindow: first check looks back `days`, later checks start the day before the last check", () => {
	let now = new Date("2026-10-08T03:00:00Z");
	assert.deepEqual(pw.searchWindow({ days: 30 }, null, now), { mindate: "2026/09/08", maxdate: "2026/10/08" });
	// Taipei 09:00 on Oct 8 is still Oct 7 in Eastern time: the window starts Oct 6 (UTC date − 1)
	assert.deepEqual(pw.searchWindow({ days: 30 }, "2026-10-07T01:00:00.000Z", now), { mindate: "2026/10/06", maxdate: "2026/10/08" });
	// A broken or future last check falls back to `days`
	assert.deepEqual(pw.searchWindow({ days: 7 }, "garbage", now), { mindate: "2026/10/01", maxdate: "2026/10/08" });
	assert.deepEqual(pw.searchWindow({ days: 7 }, "2027-01-01T00:00:00Z", now), { mindate: "2026/10/01", maxdate: "2026/10/08" });
});

test("E-utilities URLs carry db, term, JSON mode, the Entrez-date window and tool/email/api_key", () => {
	let url = new URL(pw.esearchURL(FALLS, { mindate: "2026/09/08", maxdate: "2026/10/08" }, { email: "me@example.com" }));
	assert.equal(url.origin + url.pathname, "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi");
	assert.deepEqual(Object.fromEntries(url.searchParams), {
		db: "pubmed", term: FALLS, retmode: "json", retmax: "500", sort: "pub_date",
		datetype: "edat", mindate: "2026/09/08", maxdate: "2026/10/08", tool: "zotero-bridge", email: "me@example.com",
	});
	// Counting only: no sort, relative date window
	url = new URL(pw.esearchURL("x", { retmax: 0, reldate: 7 }, { apiKey: "KEY" }));
	assert.deepEqual(Object.fromEntries(url.searchParams), {
		db: "pubmed", term: "x", retmode: "json", retmax: "0", datetype: "edat", reldate: "7", tool: "zotero-bridge", api_key: "KEY",
	});
	url = new URL(pw.esummaryURL(["1", "2"], { email: "me@example.com", apiKey: "KEY" }));
	assert.equal(url.pathname, "/entrez/eutils/esummary.fcgi");
	assert.deepEqual(Object.fromEntries(url.searchParams), {
		db: "pubmed", id: "1,2", retmode: "json", tool: "zotero-bridge", email: "me@example.com", api_key: "KEY",
	});
});

test("parseESearch and parseESummary read NCBI's JSON; errors are thrown", () => {
	let r = pw.parseESearch({ esearchresult: {
		count: "3", idlist: ["3", "2", "x"], querytranslation: "\"accidental falls\"[MeSH Terms]",
		warninglist: { phrasesignored: ["and"], quotedphrasesnotfound: [], outputmessages: ["No items found."] },
		errorlist: { phrasesnotfound: ["nursx"], fieldsnotfound: ["[tiabx]"] },
	} });
	assert.deepEqual(r, {
		count: 3, ids: ["3", "2"], translation: "\"accidental falls\"[MeSH Terms]",
		warnings: ["找不到詞彙：nursx", "找不到欄位：[tiabx]", "忽略的詞：and", "No items found."],
	});
	assert.throws(() => pw.parseESearch({ esearchresult: { ERROR: "Invalid query" } }), /PubMed 檢索式有誤：Invalid query/);
	assert.throws(() => pw.parseESearch({ error: "API rate limit exceeded" }), /API rate limit exceeded/);
	assert.throws(() => pw.parseESearch({}), /無法辨識/);

	let s = pw.parseESummary({ result: {
		uids: ["11", "12", "13"],
		11: { uid: "11", title: "Falls  in\nwards.", fulljournalname: "Journal of Nursing", source: "J Nurs", pubdate: "2026 Oct 1",
			articleids: [{ idtype: "pubmed", value: "11" }, { idtype: "doi", value: "10.1000/ABC" }], authors: [{ name: "Chen M" }] },
		12: { uid: "12", title: "No DOI id", source: "Nurse Educ", pubdate: "", epubdate: "2025 Dec 3", elocationid: "doi: 10.2000/xyz." },
		13: { uid: "13", error: "cannot get document summary" },
	} });
	assert.deepEqual(s, [
		{ pmid: "11", title: "Falls in wards.", journal: "Journal of Nursing", year: "2026", doi: "10.1000/ABC", authors: ["Chen M"] },
		{ pmid: "12", title: "No DOI id", journal: "Nurse Educ", year: "2025", doi: "10.2000/xyz", authors: [] },
	]);
});

test("createThrottle keeps requests at most 3 per second (10 with an API key)", async () => {
	for (let [rate, minGap] of [[3, 334], [10, 100]]) {
		let clock = 1000;
		let starts = [];
		let t = pw.createThrottle(rate, { now: () => clock, sleep: async (ms) => { clock += ms; } });
		await Promise.all(Array.from({ length: 5 }, () => t.wait().then(() => starts.push(clock))));
		assert.equal(t.count, 5);
		for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= minGap, `${rate}/s: ${starts}`);
		// In any one-second window, no more than `rate` requests start
		for (let s of starts) assert.ok(starts.filter(x => x >= s && x < s + 1000).length <= rate);
	}
});

test("planCandidates: queued and retried PMIDs first, seen ones skipped, the rest queued", () => {
	let plan = pw.planCandidates({ seen: ["1", "5"], queue: ["9"], retry: { 8: 1 } }, ["1", "2", "3", "9", "4", "5"], 3);
	assert.deepEqual(plan, { batch: ["9", "8", "2"], queue: ["3", "4"], dropped: 0 });
	assert.deepEqual(pw.planCandidates({}, ["1", "1"], 50), { batch: ["1"], queue: [], dropped: 0 });
});

test("pmidFromExtra and normalizeDOI match exactly", () => {
	assert.equal(pw.pmidFromExtra("PMCID: PMC1\nPMID: 12345678"), "12345678");
	assert.equal(pw.pmidFromExtra("PMID: 12345678 (old)"), "");
	assert.equal(pw.pmidFromExtra(""), "");
	assert.equal(pw.normalizeDOI("https://doi.org/10.1000/ABC "), "10.1000/abc");
	assert.equal(pw.normalizeDOI("doi: 10.1/X"), "10.1/x");
});

test("describeResult summarizes a watch for the progress window", () => {
	assert.equal(pw.describeResult({ name: "跌倒", found: 12, imported: [{}, {}], existing: 3, failed: ["1"], gaveUp: [], queued: 4 }),
		"跌倒：找到 12 篇，新匯入 2 篇，已在文獻庫 3 篇，匯入失敗 1 篇（下次再試），4 篇留待下次");
	assert.equal(pw.describeResult({ name: "跌倒", error: "PubMed 連線失敗（HTTP 500）" }), "跌倒：失敗 — PubMed 連線失敗（HTTP 500）");
});

test("buildDigestNote creates the day's note, then merges new papers and keeps checked boxes and notes", () => {
	let entry = (pmid, extra = {}) => Object.assign({
		pmid, title: `Paper ${pmid}`, journal: "J Nurs", year: "2026", doi: `10.1/${pmid}`, zotero: `zotero://select/library/items/K${pmid}`,
	}, extra);
	let note = pw.buildDigestNote(null, "2026-10-08", [{ name: "跌倒預防", entries: [entry("1"), entry("2", { doi: "", journal: "" })] }]);
	assert.match(note, /^---\ntype: "pubmed-digest"\ndate: "2026-10-08"\ntags:\n  - "新文獻"\n---\n/);
	assert.match(note, /^# 新文獻 2026-10-08$/m);
	assert.match(note, /^%% zotero-bridge:start.*%%$/m);
	assert.ok(note.includes("## 跌倒預防\n\n- [ ] **Paper 1** — *J Nurs* (2026) · [Zotero](zotero://select/library/items/K1) · [DOI](https://doi.org/10.1/1) · [PubMed](https://pubmed.ncbi.nlm.nih.gov/1/)\n"
		+ "- [ ] **Paper 2** — (2026) · [Zotero](zotero://select/library/items/K2) · [PubMed](https://pubmed.ncbi.nlm.nih.gov/2/)\n\n%% zotero-bridge:end %%"), note);
	assert.match(note, /## ✍️ 我的筆記\n\n$/);

	// The user ticks a box and writes notes; a later check the same day adds papers
	let edited = note.replace("- [ ] **Paper 1**", "- [x] **Paper 1**") + "Paper 1 看起來適合文獻探討。\n";
	let merged = pw.buildDigestNote(edited, "2026-10-08", [
		{ name: "跌倒預防", entries: [entry("1"), entry("3")] },
		{ name: "壓傷", entries: [entry("4")] },
	]);
	assert.ok(merged.includes("- [x] **Paper 1**"));
	assert.equal(merged.match(/Paper 1\*\*/g).length, 1);
	assert.ok(merged.includes("pubmed.ncbi.nlm.nih.gov/2/)\n- [ ] **Paper 3**"));
	assert.ok(merged.includes("## 壓傷\n\n- [ ] **Paper 4**"));
	assert.ok(merged.endsWith("Paper 1 看起來適合文獻探討。\n"));
	assert.equal(pw.buildDigestNote(merged, "2026-10-08", [{ name: "壓傷", entries: [entry("4")] }]), merged);
	// A digest made as Zotero Bridge (≤ 0.10): merged in place, ticks kept, the marker renamed
	const asOld = text => text.split("ZotMax").join("Zotero Bridge");
	assert.match(asOld(edited), /此區塊由 Zotero Bridge 自動產生/);
	let fromOld = pw.buildDigestNote(asOld(edited), "2026-10-08", [{ name: "跌倒預防", entries: [entry("3")] }]);
	assert.equal(fromOld.match(/zotero-bridge:start/g).length, 1);
	assert.ok(fromOld.includes("- [x] **Paper 1**"));
	assert.ok(fromOld.includes("- [ ] **Paper 3**"));
	assert.ok(fromOld.endsWith("Paper 1 看起來適合文獻探討。\n"));
	assert.match(fromOld, /^%% zotero-bridge:start — 此區塊由 ZotMax 自動產生/m);
	assert.doesNotMatch(fromOld, /Zotero Bridge/);

	// Markers deleted by the user: a fresh block at the end, their text untouched
	let bare = pw.buildDigestNote("# 我的清單\n\n手寫內容", "2026-10-08", [{ name: "壓傷", entries: [entry("5")] }]);
	assert.ok(bare.startsWith("# 我的清單\n\n手寫內容\n\n%% zotero-bridge:start"));
	assert.ok(bare.includes("## 壓傷\n\n- [ ] **Paper 5**"));
});
