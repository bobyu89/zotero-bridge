// Medical-literature search links (content/search-links.js): URL builders, proxy, custom sources,
// "find this paper", PICO and MeSH helpers, the Obsidian/Notion callout and the MeSH lookup.
const test = require("node:test");
const assert = require("node:assert/strict");
const sl = require("../content/search-links.js");
const pubmedWatch = require("../content/pubmed-watch.js");
const core = require("../content/core.js");
const markdown = require("../content/markdown.js");
const { sampleItem } = require("./fixtures.cjs");

const PROXY = "https://ezproxy.example.edu.tw/login?url=";

function target(id, q, raw = {}) {
	let cfg = sl.normalizeConfig(raw);
	return sl.buildTarget(sl.findSource(cfg, id), q, cfg);
}

test("queries are fully encoded: Chinese, quotes, brackets, parentheses, Boolean operators", () => {
	assert.equal(sl.encodeQuery("跌倒 預防"), "%E8%B7%8C%E5%80%92%20%E9%A0%90%E9%98%B2");
	assert.equal(sl.encodeQuery(`("Accidental Falls"[Mesh] OR fall*[tiab]) AND nurs*`),
		"%28%22Accidental%20Falls%22%5BMesh%5D%20OR%20fall%2A%5Btiab%5D%29%20AND%20nurs%2A");
	assert.equal(sl.encodeQuery("it's! & co=1 #x"), "it%27s%21%20%26%20co%3D1%20%23x");
	// Every reserved character is escaped, so the URL never ends a Markdown link or adds a parameter
	assert.doesNotMatch(sl.encodeQuery(`a (b) [c] "d" 'e' !*&=?#/`), /[()[\]"'!*&=?#/ ]/);
	assert.equal(sl.fillTemplate("https://x.org/?a={q}&b={q}", "a b"), "https://x.org/?a=a%20b&b=a%20b");
});

test("every built-in source builds the expected URL", () => {
	let q = "fall prevention";
	let e = "fall%20prevention";
	let expected = {
		"pubmed": `https://pubmed.ncbi.nlm.nih.gov/?term=${e}`,
		"pubmed-cq": `https://pubmed.ncbi.nlm.nih.gov/clinical/?term=${e}`,
		"mesh": `https://www.ncbi.nlm.nih.gov/mesh/?term=${e}`,
		"cinahl": `https://search.ebscohost.com/login.aspx?direct=true&db=rzh&bquery=${e}&type=1&searchMode=And&site=ehost-live`,
		"embase": "https://www.embase.com/",
		"scholar": `https://scholar.google.com/scholar?hl=zh-TW&q=${e}`,
		"europepmc": `https://europepmc.org/search?query=${e}`,
		"semantic": `https://www.semanticscholar.org/search?q=${e}`,
		"trip": `https://www.tripdatabase.com/Searchresult?criteria=${e}`,
		"jbi": "https://ovidsp.ovid.com/ovidweb.cgi?T=JS&NEWS=N&PAGE=main&D=jbi",
		"clinicaltrials": `https://clinicaltrials.gov/search?term=${e}`,
		"ictrp": "https://trialsearch.who.int/",
		"uptodate": `https://www.uptodate.com/contents/search?search=${e}`,
		"airiti": "https://www.airitilibrary.com/",
		"ndltd": "https://ndltd.ncl.edu.tw/",
		"ncl-periodicals": "https://tpl.ncl.edu.tw/",
		"guideline-pdf": `https://www.google.com/search?q=${sl.encodeQuery("fall prevention (guideline OR 指引 OR 指南) filetype:pdf")}`,
		"tw-gov": `https://www.google.com/search?q=${sl.encodeQuery("fall prevention site:mohw.gov.tw OR site:hpa.gov.tw")}`,
		"nice": `https://www.nice.org.uk/search?q=${e}`,
		"cdc": `https://search.cdc.gov/search/?query=${e}`,
	};
	let cfg = sl.normalizeConfig({});
	assert.equal(cfg.sources.length, sl.BUILTIN.length);
	for (let s of cfg.sources) {
		let t = sl.buildTarget(s, q, cfg);
		if (s.id === "cochrane") {
			assert.match(t.url, /^https:\/\/www\.cochranelibrary\.com\/search\?.*_searchText=fall%20prevention$/);
			continue;
		}
		assert.equal(t.url, expected[s.id], s.id);
		assert.equal(t.copy, !s.url, s.id);
		assert.ok(s.name && s.desc && sl.CHECK_LABELS[s.check], s.id);
		// Copy-only sources open their start page, and the query (with any wrapper) goes to the clipboard
		if (t.copy) assert.equal(t.query, q);
	}
	assert.equal(target("guideline-pdf", "跌倒").query, "跌倒 (guideline OR 指引 OR 指南) filetype:pdf");
	assert.deepEqual(cfg.sources.filter(s => s.needsAccess).map(s => s.id), ["cinahl", "embase", "jbi", "uptodate"]);
});

test("the library proxy wraps only sources that need institutional access", () => {
	let raw = { proxyPrefix: PROXY };
	let cinahl = target("cinahl", "falls", raw);
	assert.equal(cinahl.url, PROXY + "https://search.ebscohost.com/login.aspx?direct=true&db=rzh&bquery=falls&type=1&searchMode=And&site=ehost-live");
	assert.equal(cinahl.proxied, true);
	assert.equal(sl.sourceLabel(cinahl), "CINAHL（經圖書館代理）");
	assert.equal(target("embase", "falls", raw).url, PROXY + "https://www.embase.com/");
	assert.equal(target("pubmed", "falls", raw).url, "https://pubmed.ncbi.nlm.nih.gov/?term=falls");
	assert.equal(target("scholar", "falls", raw).proxied, false);
	// Per-source opt-out
	assert.equal(target("uptodate", "falls", Object.assign({ proxyExclude: "UpToDate, jbi" }, raw)).url, "https://www.uptodate.com/contents/search?search=falls");
	// Without a prefix: plain links, labelled as needing access
	let plain = target("cinahl", "falls");
	assert.equal(plain.proxied, false);
	assert.equal(sl.sourceLabel(plain), "CINAHL（需機構權限）");
	assert.equal(sl.sourceLabel(target("jbi", "falls")), "JBI EBP Database（需機構權限，開首頁＋複製檢索詞）");
	// qurl= takes the encoded URL; {url} is replaced; a bad prefix is reported and ignored
	assert.equal(sl.wrapProxy("https://a.org/?x=1&y=2", "https://p.edu/login?qurl="), "https://p.edu/login?qurl=https%3A%2F%2Fa.org%2F%3Fx%3D1%26y%3D2");
	assert.equal(sl.wrapProxy("https://a.org/", "https://p.edu/go/{url}"), "https://p.edu/go/https%3A%2F%2Fa.org%2F");
	let bad = sl.normalizeConfig({ proxyPrefix: "ezproxy.example.edu.tw" });
	assert.equal(bad.proxyPrefix, "");
	assert.match(bad.errors[0], /代理伺服器前綴必須是 http/);
	assert.equal(sl.wrapProxy("https://a.org/", "javascript:alert(1)"), "https://a.org/");
});

test("custom sources, overrides of built-ins, order and hidden sources", () => {
	let cfg = sl.normalizeConfig({
		custom: JSON.stringify([
			{ name: "學校館藏", url: "https://lib.example.edu.tw/search?q={q}&lang=zh", needsAccess: true },
			{ name: "內部指引平台", url: "https://guide.example.org/" },
			// CINAHL Complete instead of CINAHL Plus with Full Text
			{ id: "cinahl", url: "https://search.ebscohost.com/login.aspx?direct=true&db=ccm&bquery={q}&site=ehost-live" },
			{ name: "", url: "https://x.org/{q}" },
			{ name: "壞網址", url: "ftp://x.org/{q}" },
		]),
		order: "airiti, custom-2, cinahl, nosuch",
		disabled: "embase uptodate",
		proxyPrefix: PROXY,
	});
	assert.deepEqual(cfg.sources.slice(0, 4).map(s => s.id), ["airiti", "custom-2", "cinahl", "pubmed"]);
	assert.ok(!cfg.sources.some(s => s.id === "embase" || s.id === "uptodate"));
	assert.equal(cfg.all.find(s => s.id === "embase").enabled, false);
	assert.deepEqual(cfg.errors, [
		"自訂資料庫第 4 筆沒有名稱（name）",
		"壞網址：網址必須以 http:// 或 https:// 開頭",
		"順序設定中找不到的資料庫 ID：nosuch",
	]);
	let school = sl.findSource(cfg, "custom-1");
	assert.equal(school.name, "學校館藏");
	assert.equal(school.lang, "zh");
	assert.equal(sl.buildTarget(school, "壓力性損傷", cfg).url,
		PROXY + "https://lib.example.edu.tw/search?q=%E5%A3%93%E5%8A%9B%E6%80%A7%E6%90%8D%E5%82%B7&lang=zh");
	let guide = sl.buildTarget(sl.findSource(cfg, "custom-2"), "falls", cfg);
	assert.deepEqual([guide.url, guide.copy, guide.query], ["https://guide.example.org/", true, "falls"]);
	let cinahl = sl.buildTarget(sl.findSource(cfg, "cinahl"), "falls", cfg);
	assert.equal(cinahl.url, PROXY + "https://search.ebscohost.com/login.aspx?direct=true&db=ccm&bquery=falls&site=ehost-live");
	assert.equal(sl.findSource(cfg, "cinahl").needsAccess, true, "the override keeps the other fields");
	// Settings pane listing
	let lines = sl.describeSources(cfg);
	assert.match(lines[0], /^⚠️ 自訂資料庫第 4 筆/);
	assert.ok(lines.includes(`embase｜Embase（已隱藏，需機構權限，開首頁＋複製檢索詞，CI 實測 ${sl.CI_DATE}：需登入）`));
	assert.ok(lines.includes("custom-1｜學校館藏（需機構權限，自訂）"));
	assert.ok(lines.includes(`cochrane｜Cochrane Library（實測可帶入檢索詞，CI 實測 ${sl.CI_DATE}：OK）`));
	// A built-in with a URL from the settings drops the live-check result
	assert.ok(lines.includes("cinahl｜CINAHL（需機構權限，依圖書館指南範例格式）"));
	// Broken JSON keeps the built-ins
	let broken = sl.normalizeConfig({ custom: "[{" });
	assert.equal(broken.sources.length, sl.BUILTIN.length);
	assert.match(broken.errors[0], /不是有效的 JSON/);
	assert.match(sl.normalizeConfig({ custom: "{}" }).errors[0], /必須是 JSON 陣列/);
	// Menu count is clamped to the menu slots
	assert.equal(sl.normalizeConfig({ menuCount: "20" }).menuCount, 8);
	assert.equal(sl.normalizeConfig({ menuCount: "3" }).menuCount, 3);
	assert.equal(sl.normalizeConfig({ menuCount: "" }).menuCount, 8);
	assert.equal(sl.normalizeConfig({ menuCount: "0" }).menuCount, 1);
});

test("find this paper: PMID opens the record, DOI and title searches per database", () => {
	let cfg = sl.normalizeConfig({});
	let info = sl.itemInfo({ title: "Nurse-led “fall” prevention: a <i>cluster</i> RCT.", DOI: "https://doi.org/10.1000/ABC(12)", extra: "Original: x\nPMID: 31234567" });
	assert.deepEqual(info, { title: "Nurse-led fall prevention: a cluster RCT", doi: "10.1000/abc(12)", pmid: "31234567", chinese: false });
	let ts = sl.itemTargets(cfg, info);
	let by = Object.fromEntries(ts.map(t => [t.id, t]));
	assert.deepEqual(ts.map(t => t.id), ["pubmed", "cochrane", "cinahl", "embase", "scholar", "europepmc", "semantic", "airiti", "ndltd", "ncl-periodicals"]);
	assert.equal(by.pubmed.url, "https://pubmed.ncbi.nlm.nih.gov/31234567/");
	assert.equal(by.pubmed.record, true);
	assert.equal(by.europepmc.url, "https://europepmc.org/search?query=EXT_ID%3A31234567%20AND%20SRC%3AMED");
	assert.equal(by.scholar.query, '"Nurse-led fall prevention: a cluster RCT"');
	assert.equal(by.cinahl.query, 'TI "Nurse-led fall prevention: a cluster RCT"');
	assert.equal(by.embase.copy, true);
	assert.equal(by.embase.query, "Nurse-led fall prevention: a cluster RCT", "copied without quotes");
	// DOI only
	let doi = Object.fromEntries(sl.itemTargets(cfg, sl.itemInfo({ title: "T", DOI: "10.1/x" })).map(t => [t.id, t]));
	assert.equal(doi.pubmed.url, "https://pubmed.ncbi.nlm.nih.gov/?term=10.1%2Fx%5Bdoi%5D");
	assert.equal(doi.europepmc.query, 'DOI:"10.1/x"');
	// Title only: each title word in the PubMed title field (a quoted whole title finds nothing in PubMed)
	let title = sl.itemTargets(cfg, sl.itemInfo({ title: "Hand hygiene [compliance] in ICU" }));
	assert.equal(title[0].query, "Hand[ti] AND hygiene[ti] AND compliance[ti] AND ICU[ti]");
	assert.equal(title[0].url, "https://pubmed.ncbi.nlm.nih.gov/?term=Hand%5Bti%5D%20AND%20hygiene%5Bti%5D%20AND%20compliance%5Bti%5D%20AND%20ICU%5Bti%5D");
	assert.equal(sl.titleWords("Hospital nurse staffing and patient mortality, nurse burnout, and job dissatisfaction"),
		"Hospital[ti] AND nurse[ti] AND staffing[ti] AND patient[ti] AND mortality[ti] AND burnout[ti] AND job[ti] AND dissatisfaction[ti]");
	assert.equal(sl.titleWords("Nurse-led fall prevention for older adults' falls: an RCT"), "Nurse-led[ti] AND fall[ti] AND prevention[ti] AND older[ti] AND adults[ti] AND falls[ti] AND RCT[ti]");
	assert.equal(sl.titleWords("word ".repeat(3) + Array.from({ length: 20 }, (_, i) => `term${i}`).join(" ")).split(" AND ").length, 10, "capped");
	// Nothing long enough to search: the quoted title
	assert.equal(sl.findQuery(sl.findSource(cfg, "pubmed"), { title: "Qi", doi: "", pmid: "" }).query, '"Qi"[ti]');
	assert.equal(sl.itemTargets(cfg, sl.itemInfo({})).length, 0);
	// A DOI in Extra counts too
	assert.equal(sl.itemInfo({ title: "x", extra: "DOI: 10.5/Y" }).doi, "10.5/y");
	assert.equal(sl.relatedURL("31234567"), "https://pubmed.ncbi.nlm.nih.gov/?linkname=pubmed_pubmed&from_uid=31234567");
	assert.equal(sl.relatedURL("abc"), "");
	// Very long titles are cut at a word boundary
	assert.ok(sl.cleanTitle("word ".repeat(100)).length <= 300);
});

test("Chinese titles and queries go to Chinese sources first", () => {
	let cfg = sl.normalizeConfig({});
	let zh = sl.itemTargets(cfg, sl.itemInfo({ title: "護理人員跌倒預防衛教之成效：「隨機」對照試驗" }));
	assert.deepEqual(zh.map(t => t.id), ["airiti", "ndltd", "ncl-periodicals", "scholar"]);
	assert.equal(zh[0].query, "護理人員跌倒預防衛教之成效： 隨機 對照試驗");
	assert.equal(zh[3].url, "https://scholar.google.com/scholar?hl=zh-TW&q=" + sl.encodeQuery('"護理人員跌倒預防衛教之成效： 隨機 對照試驗"'));
	// …but a PMID still finds the PubMed record
	assert.deepEqual(sl.itemTargets(cfg, sl.itemInfo({ title: "中文題名", extra: "PMID: 999" })).map(t => t.id), ["pubmed", "airiti", "ndltd", "ncl-periodicals", "scholar"]);

	assert.equal(sl.isChinese("壓力性損傷 pressure injury"), true);
	assert.equal(sl.isChinese("pressure injury"), false);
	let routed = sl.routeSources(cfg.sources, "壓力性損傷").map(s => s.id);
	assert.deepEqual(routed.slice(0, 6), ["airiti", "ndltd", "ncl-periodicals", "tw-gov", "scholar", "guideline-pdf"]);
	assert.equal(routed.length, cfg.sources.length, "English sources are still offered");
	let en = sl.routeSources(cfg.sources, "pressure injury").map(s => s.id);
	assert.equal(en[0], "pubmed");
	assert.deepEqual(en.slice(-4), ["airiti", "ndltd", "ncl-periodicals", "tw-gov"]);

	// Tools menu entries
	let zhEntries = sl.quickEntries(cfg, "壓力性損傷", null);
	assert.equal(zhEntries[0].label, "華藝線上圖書館（開首頁＋複製檢索詞）");
	assert.ok(!zhEntries.some(e => e.kind === "watch"), "no PubMed watch for a Chinese query");
	let enEntries = sl.quickEntries(cfg, "pressure injury", { query: '("Pressure Ulcer"[Mesh] OR "pressure injury"[tiab])' });
	assert.equal(enEntries[0].label, 'PubMed（MeSH 檢索式）：("Pressure Ulcer"[Mesh] OR "pressure injury"[tiab])');
	assert.equal(enEntries[0].target.url, "https://pubmed.ncbi.nlm.nih.gov/?term=%28%22Pressure%20Ulcer%22%5BMesh%5D%20OR%20%22pressure%20injury%22%5Btiab%5D%29");
	assert.equal(enEntries[1].target.url, "https://pubmed.ncbi.nlm.nih.gov/?term=pressure%20injury");
	assert.deepEqual(enEntries.slice(-2).map(e => [e.kind, e.text || e.query]), [
		["copy", '("Pressure Ulcer"[Mesh] OR "pressure injury"[tiab])'],
		["watch", '("Pressure Ulcer"[Mesh] OR "pressure injury"[tiab])'],
	]);
	assert.deepEqual(sl.quickEntries(cfg, "falls", null).at(-1), { kind: "watch", label: "💾 存成 PubMed 新文獻追蹤…", query: "falls" });
});

test("PICO search string: P AND I AND O, English words for PubMed, the fields as written for Chinese sources", () => {
	assert.deepEqual(sl.picoTerms("跌倒發生率、跌倒自我效能; fall rate / falls"), ["跌倒發生率", "跌倒自我效能", "fall rate", "falls"]);
	assert.deepEqual(sl.picoTerms("usual care vs. nurse-led education"), ["usual care", "nurse-led education"]);
	assert.deepEqual(sl.picoTerms("未報告"), []);
	assert.deepEqual(sl.picoTerms(null), []);
	assert.deepEqual(sl.englishPhrases("護理師主導 fall prevention 衛教（N = 120）"), ["fall prevention"]);
	assert.deepEqual(sl.englishPhrases("ICU 病人"), ["ICU"]);

	let study = {
		population: "65 歲以上住院病人（older inpatients）",
		intervention: "護理師主導 fall prevention education、exercise",
		comparison: "常規照護 usual care",
		outcomes: "跌倒發生率、fall self-efficacy",
	};
	let pico = sl.picoQuery(study);
	assert.equal(pico.en, '"older inpatients" AND ("fall prevention education" OR exercise) AND "fall self-efficacy"');
	assert.equal(pico.all, '65 歲以上住院病人 older inpatients AND (護理師主導 fall prevention education OR exercise) AND (跌倒發生率 OR "fall self-efficacy")');
	assert.deepEqual(pico.skipped, []);
	assert.deepEqual(pico.blocks.map(b => b.key), ["P", "I", "O"]);
	// With C
	let withC = sl.picoQuery(study, { includeC: true });
	assert.equal(withC.en, '"older inpatients" AND ("fall prevention education" OR exercise) AND "usual care" AND "fall self-efficacy"');
	// Only Chinese (the usual AI note): no English string, the fields as written
	let zh = sl.picoQuery({ population: "住院病人", intervention: "衛教", comparison: "常規照護", outcomes: "跌倒發生率、跌倒自我效能" });
	assert.equal(zh.en, "");
	assert.equal(zh.all, "住院病人 AND 衛教 AND (跌倒發生率 OR 跌倒自我效能)");
	assert.deepEqual(zh.skipped, ["P（族群）", "I（介入）", "O（結果）"]);
	// Partly English
	let part = sl.picoQuery({ population: "ICU nurses", intervention: "正念減壓", outcomes: "burnout" });
	assert.equal(part.en, '"ICU nurses" AND burnout');
	assert.deepEqual(part.skipped, ["I（介入）"]);
	assert.equal(sl.picoQuery({ study_design: "RCT", population: null }), null);
	assert.equal(sl.picoQuery(null), null);
	// Brackets and quotes in the fields never break the query
	assert.equal(sl.picoQuery({ population: 'adults (≥ 18) "with" [diabetes]' }).en, '(adults OR "with diabetes")');
});

test("MeSH-like tags; MeSH helper parsing and query building", () => {
	assert.deepEqual(sl.meshTerms(["*Accidental Falls/prevention & control", "Humans", "Aged", "Accidental Falls", "狀態/待讀", "來源/PubMed",
		"Nursing Staff, Hospital", "important", "新文獻", "zotero-bridge-ai", "Quality of Life", "A", "Patient Education as Topic", "Hospitals", "Exercise", "Inpatients"]),
	["Accidental Falls", "Nursing Staff, Hospital", "Quality of Life", "Patient Education as Topic", "Hospitals", "Exercise"]);
	assert.equal(sl.meshLookupURL("Nursing Staff, Hospital"), "https://www.ncbi.nlm.nih.gov/mesh/?term=Nursing%20Staff%2C%20Hospital");

	assert.deepEqual(sl.meshConcepts("fall prevention, older adults; (nurse-led) AND hospital, fall prevention"), ["fall prevention", "older adults", "nurse-led", "hospital"]);
	let parsed = sl.parseMeshSummary({
		result: {
			uids: ["68000058", "67000001", "68000059", "68000058b"],
			"68000058": { uid: "68000058", ds_meshui: "D000058", ds_meshterms: ["Accidental Falls", "Falls, Accidental"], ds_scopenote: "Falls due to slipping." },
			"67000001": { uid: "67000001", ds_meshui: "C000001", ds_meshterms: ["Some Chemical"] },
			"68000059": { uid: "68000059", ds_meshui: "D000059", ds_meshterms: ["Accidental Falls"] },
			"68000058b": { error: "cannot get document summary" },
		},
	});
	assert.deepEqual(parsed, [{ uid: "68000058", ui: "D000058", heading: "Accidental Falls", scopeNote: "Falls due to slipping." }]);
	assert.throws(() => sl.parseMeshSummary({ error: "API rate limit exceeded" }), /MeSH：API rate limit exceeded/);
	assert.equal(sl.buildMeshQuery([
		{ concept: "fall prevention", headings: [{ heading: "Accidental Falls" }] },
		{ concept: "nurs*", headings: [] },
		{ concept: "older adults", headings: [{ heading: "Aged" }, { heading: "Aged, 80 and over" }] },
	]), '("Accidental Falls"[Mesh] OR "fall prevention"[tiab]) AND (nurs*[tiab]) AND ("Aged"[Mesh] OR "Aged, 80 and over"[Mesh] OR "older adults"[tiab])');
});

test("MeSH helper calls NCBI through pubmed-watch's client (tool, email, API key, throttle)", async () => {
	let log = [];
	let oldFetch = pubmedWatch.runtime.fetch;
	let oldSleep = pubmedWatch.runtime.sleep;
	pubmedWatch.runtime.sleep = async () => {};
	pubmedWatch.runtime.fetch = async (url) => {
		log.push(url);
		let u = new URL(url);
		let json;
		if (u.pathname.endsWith("esearch.fcgi")) {
			json = { esearchresult: { count: "1", idlist: u.searchParams.get("term") === "fall prevention" ? ["68000058"] : [] } };
		}
		else {
			json = { result: { uids: ["68000058"], "68000058": { ds_meshui: "D000058", ds_meshterms: ["Accidental Falls"] } } };
		}
		return { status: 200, ok: true, text: async () => JSON.stringify(json) };
	};
	try {
		let r = await sl.suggestMesh("fall prevention, qzx", { ncbi: { email: "nurse@example.com", apiKey: "k123" } });
		assert.equal(r.query, '("Accidental Falls"[Mesh] OR "fall prevention"[tiab]) AND (qzx[tiab])');
		assert.deepEqual(r.blocks.map(b => [b.concept, b.headings.map(h => h.heading)]), [["fall prevention", ["Accidental Falls"]], ["qzx", []]]);
		assert.equal(log.length, 3, "esearch + esummary, then esearch with no hits");
		let first = new URL(log[0]);
		assert.equal(first.origin + first.pathname, "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi");
		assert.deepEqual(Object.fromEntries(first.searchParams), {
			db: "mesh", term: "fall prevention", retmode: "json", retmax: "5", tool: "zotero-bridge", email: "nurse@example.com", api_key: "k123",
		});
		assert.equal(new URL(log[1]).searchParams.get("id"), "68000058");
		assert.equal(new URL(log[1]).searchParams.get("db"), "mesh");
		assert.deepEqual(r.requests, log);
	}
	finally {
		pubmedWatch.runtime.fetch = oldFetch;
		pubmedWatch.runtime.sleep = oldSleep;
	}
});

test("Obsidian callout: find links, similar articles, MeSH, PICO; Notion keeps the links", () => {
	let cfg = sl.normalizeConfig({ proxyPrefix: PROXY });
	let data = {
		title: "Nurse-led fall prevention",
		doi: "10.1/x",
		extra: "PMID: 123456",
		tags: ["*Accidental Falls/prevention & control", "Humans", "狀態/待讀"],
	};
	let study = { population: "older inpatients", intervention: "護理師主導衛教", outcomes: "falls、跌倒自我效能" };
	let callout = sl.noteCallout(data, study, cfg);
	let lines = callout.split("\n");
	assert.equal(lines[0], "> [!search]- 🔎 延伸搜尋");
	assert.ok(lines.every(l => l.startsWith("> ")), "one callout");
	assert.equal(lines[1], "> **找這篇**：[PubMed](https://pubmed.ncbi.nlm.nih.gov/123456/) · [Cochrane Library](" + target("cochrane", '"Nurse-led fall prevention"').url + ") · "
		+ `[CINAHL](${PROXY}https://search.ebscohost.com/login.aspx?direct=true&db=rzh&bquery=TI%20%22Nurse-led%20fall%20prevention%22&type=1&searchMode=And&site=ehost-live) · `
		+ "[Google Scholar](https://scholar.google.com/scholar?hl=zh-TW&q=%22Nurse-led%20fall%20prevention%22) · [Europe PMC](https://europepmc.org/search?query=EXT_ID%3A123456%20AND%20SRC%3AMED)  ");
	assert.equal(lines[2], "> **相似文獻**：[PubMed Similar articles](https://pubmed.ncbi.nlm.nih.gov/?linkname=pubmed_pubmed&from_uid=123456)  ");
	assert.equal(lines[3], "> **MeSH**：[Accidental Falls](https://www.ncbi.nlm.nih.gov/mesh/?term=Accidental%20Falls)（[PubMed](https://pubmed.ncbi.nlm.nih.gov/?term=%22Accidental%20Falls%22%5BMesh%5D)）  ");
	assert.equal(lines[4], '> **PICO 檢索式**：`"older inpatients" AND falls`  ');
	assert.equal(lines[5], "> ↳ [PubMed](https://pubmed.ncbi.nlm.nih.gov/?term=%22older%20inpatients%22%20AND%20falls) · "
		+ `[CINAHL](${PROXY}https://search.ebscohost.com/login.aspx?direct=true&db=rzh&bquery=%22older%20inpatients%22%20AND%20falls&type=1&searchMode=And&site=ehost-live) · `
		+ "[Google Scholar](https://scholar.google.com/scholar?hl=zh-TW&q=%22older%20inpatients%22%20AND%20falls)  ");
	assert.equal(lines[6], "> *I（介入） 沒有英文詞彙，未列入；可用 工具 → 醫學文獻快速搜尋… 查 MeSH*  ");
	assert.equal(lines[7], "> **PICO（原文詞彙）**：`\"older inpatients\" AND 護理師主導衛教 AND (falls OR 跌倒自我效能)`  ");
	assert.equal(lines[8], "> ↳ [Google Scholar](https://scholar.google.com/scholar?hl=zh-TW&q=" + sl.encodeQuery('"older inpatients" AND 護理師主導衛教 AND (falls OR 跌倒自我效能)') + ")");
	assert.equal(lines.length, 9);

	// Notion: the callout becomes a quote whose links stay links
	let blocks = markdown.mdToNotionBlocks(callout);
	assert.equal(blocks.length, 1);
	assert.equal(blocks[0].type, "quote");
	let rich = blocks[0].quote.rich_text;
	assert.equal(rich[0].text.content, "🔎 延伸搜尋");
	let links = rich.filter(r => r.text.link).map(r => r.text.link.url);
	assert.equal(links.length, 12);
	assert.ok(links.includes("https://pubmed.ncbi.nlm.nih.gov/123456/"));
	assert.ok(links.every(u => /^https:\/\/\S+$/.test(u) && !/[()"]/.test(u)), links.join("\n"));
	assert.ok(rich.some(r => r.annotations && r.annotations.code && r.text.content === '"older inpatients" AND falls'));

	// Turned off; nothing to link
	assert.equal(sl.noteCallout(data, study, sl.normalizeConfig({ noteCallout: false })), "");
	assert.equal(sl.noteCallout({}, null, cfg), "");
	// Without PubMed (hidden): no record / similar / MeSH-PubMed links, and the copy-only sources never appear
	let noPubmed = sl.noteCallout(data, null, sl.normalizeConfig({ disabled: "pubmed" }));
	assert.doesNotMatch(noPubmed, /pubmed\.ncbi/);
	assert.match(noPubmed, /\[Accidental Falls\]\(https:\/\/www\.ncbi\.nlm\.nih\.gov\/mesh\/\?term=Accidental%20Falls\)$/);
	assert.doesNotMatch(sl.noteCallout({ title: "中文題名" }, null, cfg), /airiti|ndltd|embase/);
});

test("the callout sits in the managed region after the info callout, and a heavy one stays within Notion's limits", () => {
	let cfg = sl.normalizeConfig({});
	let data = Object.assign(sampleItem(), { extra: "PMID: 1", tags: Array.from({ length: 20 }, (_, i) => `Heading Number ${i}`) });
	let study = { population: "a b, c d, e f, g h", intervention: "i j, k l, m n, o p", comparison: "q r", outcomes: "s t, u v, w x, y z" };
	let callout = sl.noteCallout(data, study, cfg);
	let note = core.buildObsidianNote(null, data, { searchCallout: callout, now: "2026-10-08T00:00:00Z" });
	let region = note.slice(note.indexOf("%% zotero-bridge:start"), note.indexOf("%% zotero-bridge:end %%"));
	assert.ok(region.includes("> [!info] 書目資訊"));
	assert.ok(region.indexOf("> [!search]- 🔎 延伸搜尋") > region.indexOf("> [!info] 書目資訊"));
	// Re-syncing replaces it, never duplicates it; without it the region has none
	let again = core.buildObsidianNote(note, data, { searchCallout: callout, now: "2026-10-09T00:00:00Z" });
	assert.equal(again.match(/\[!search\]/g).length, 1);
	assert.doesNotMatch(core.buildObsidianNote(note, data, { now: "2026-10-09T00:00:00Z" }), /\[!search\]/);
	let blocks = markdown.mdToNotionBlocks(callout);
	for (let b of blocks) {
		assert.ok(b.quote.rich_text.length <= 100);
		assert.ok(b.quote.rich_text.filter(r => r.text.link).length >= 10, "links survive (no plain-text fallback)");
	}
});
