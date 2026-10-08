const test = require("node:test");
const assert = require("node:assert/strict");
const zh = require("../content/apa-zh.js");
const core = require("../content/core.js");
const syn = require("../content/synthesis.js");
const bib = require("../content/export.js");
const { sampleItem } = require("./fixtures.cjs");

const author = (lastName, firstName = "") => ({ lastName, firstName, creatorType: "author" });
const single = name => ({ name, creatorType: "author" });

// 陳美玲、林小華… as Zotero stores them: split (陳 / 美玲) or in one field
const NAMES = ["陳美玲", "林小華", "王大明", "李志明", "張雅婷", "黃怡君", "吳家豪", "劉淑芬", "蔡建宏", "楊文華",
	"許雅雯", "鄭宗翰", "謝佩珊", "郭俊傑", "洪婉婷", "曾志偉", "邱美惠", "廖信宏", "賴雅琪", "周冠宇", "徐子涵", "蘇柏翰"];
const splitName = n => author(n[0], n.slice(1));

function article(n, overrides = {}) {
	return Object.assign({
		itemType: "journalArticle",
		title: "護理人員跌倒預防衛教之成效",
		creators: NAMES.slice(0, n).map(splitName),
		year: "2023",
		publication: "護理雜誌",
		volume: "70",
		issue: "2",
		pages: "45-56",
		doi: "10.6224/JN.202304_70(2).07",
		language: "zh-TW",
	}, overrides);
}

test("isChineseItem: the title decides, then the authors, then the language field", () => {
	assert.equal(zh.isChineseItem(article(1)), true);
	assert.equal(zh.isChineseItem(article(1, { language: "" })), true, "Han title without a language field");
	// The Airiti translator marks every item "zh", English articles included
	assert.equal(zh.isChineseItem({ title: "The Study of Second Level of People Capability Maturity Model", language: "zh", creators: [author("Chen", "Yin-Che")] }), false);
	assert.equal(zh.isChineseItem(sampleItem()), false);
	assert.equal(zh.isChineseItem({ title: "看護師の転倒予防に関する研究", creators: [] }), false, "Japanese (kana)");
	assert.equal(zh.isChineseItem({ title: "간호사의 낙상 예방", creators: [] }), false, "Korean");
	assert.equal(zh.isChineseItem({ title: "", creators: [single("陳美玲")] }), true);
	assert.equal(zh.isChineseItem({ title: "", creators: [], language: "中文" }), true);
	assert.equal(zh.isChineseItem({ title: "", creators: [], language: "zh_TW" }), true);
	assert.equal(zh.isChineseItem({ title: "", creators: [], language: "en" }), false);
	assert.equal(zh.isChineseItem(null), false);
});

test("zhPersonName: split, single-field, Western-order and Airiti-split names", () => {
	assert.equal(zh.zhPersonName(author("陳", "美玲")), "陳美玲");
	assert.equal(zh.zhPersonName(single("陳美玲")), "陳美玲", "fieldMode 1");
	assert.equal(zh.zhPersonName({ firstName: "陳", lastName: "美玲", creatorType: "author" }), "陳美玲", "split in Western order");
	assert.equal(zh.zhPersonName({ firstName: "歐陽", lastName: "志明", creatorType: "author" }), "歐陽志明", "compound surname in Western order");
	assert.equal(zh.zhPersonName(author("歐", "陽志明")), "歐陽志明", "Airiti splits after the first character");
	assert.equal(zh.zhPersonName(author("林", "陳美")), "林陳美", "a correct split is kept");
	assert.equal(zh.zhPersonName(single("陳美玲(Chen, Mei-Ling)")), "陳美玲", "English name in parentheses dropped");
	assert.equal(zh.zhPersonName(single("陳 美玲")), "陳美玲");
	assert.equal(zh.zhPersonName(single("衛生福利部")), "衛生福利部", "Chinese corporate author");
	assert.equal(zh.zhPersonName(author("Chen", "Mei-Ling")), "");
	assert.equal(zh.zhPersonName(single("World Health Organization")), "");
	assert.equal(zh.zhPersonName({ family: "陳", given: "美玲" }), "陳美玲", "CSL name");
	assert.equal(zh.zhPersonName({ literal: "林小華" }), "林小華");
});

test("core.authorNames writes Chinese names in full (frontmatter, Notion Authors)", () => {
	let data = { creators: [author("陳", "美玲"), single("林小華"), author("Smith", "John")] };
	assert.deepEqual(core.authorNames(data), ["陳美玲", "林小華", "Smith, John"]);
	assert.deepEqual(core.authorNames(sampleItem()), ["Chen, Mei", "Smith, John"], "English names unchanged");
	let fm = core.managedFrontmatter(Object.assign(sampleItem(), { creators: data.creators }), {});
	assert.deepEqual(fm.authors, ["陳美玲", "林小華", "Smith, John"]);
	// The note filename and generated citekey still use the stored last name (keys never move)
	assert.equal(core.firstAuthorLastName(data), "陳");
});

test("journal article: 1, 2, 3 and 21+ authors", () => {
	assert.equal(zh.formatReference(article(1)),
		"陳美玲（2023）。護理人員跌倒預防衛教之成效。護理雜誌，70(2)，45–56。https://doi.org/10.6224/JN.202304_70(2).07");
	assert.equal(zh.formatReference(article(2), { format: "markdown" }),
		"陳美玲、林小華（2023）。護理人員跌倒預防衛教之成效。*護理雜誌，70*(2)，45–56。https://doi.org/10.6224/JN.202304_70(2).07");
	assert.match(zh.formatReference(article(3)), /^陳美玲、林小華、王大明（2023）。/);
	let twenty = zh.formatReference(article(20));
	assert.equal(twenty.split("（2023）")[0].split("、").length, 20, "up to 20 authors: all listed");
	assert.doesNotMatch(twenty, /…/);
	let many = zh.formatReference(article(22));
	let names = many.split("（2023）")[0].split("、");
	assert.equal(names.length, 21);
	assert.deepEqual(names.slice(17), [NAMES[17], NAMES[18], "…", NAMES[21]]);
	assert.doesNotMatch(many, /&|et al\.|, /);
});

test("journal article details: 台灣護理學會 style, no volume, no DOI, titles ending in ？", () => {
	assert.equal(zh.formatReference(article(2), { style: "twna", format: "markdown" }),
		"陳美玲、林小華（2023）．護理人員跌倒預防衛教之成效．*護理雜誌，70*(2)，45–56。https://doi.org/10.6224/JN.202304_70(2).07");
	// Without a volume: the issue alone, not italic and without parentheses
	assert.equal(zh.formatReference(article(1, { volume: "", doi: "" }), { format: "markdown" }),
		"陳美玲（2023）。護理人員跌倒預防衛教之成效。*護理雜誌*，2，45–56。");
	assert.equal(zh.formatReference(article(1, { title: "護理人員是否需要衛教？", doi: "", year: "", date: "" })),
		"陳美玲（無日期）。護理人員是否需要衛教？護理雜誌，70(2)，45–56。");
	assert.equal(zh.formatReference(article(1, { doi: "https://doi.org/10.6224/JN.1", url: "https://www.airitilibrary.com/x" })),
		"陳美玲（2023）。護理人員跌倒預防衛教之成效。護理雜誌，70(2)，45–56。https://doi.org/10.6224/JN.1", "database URL left out");
	assert.equal(zh.formatReference({ itemType: "book", title: "以*星號*命名", creators: [author("陳", "美玲")], year: "2023", publisher: "華杏" }, { format: "markdown" }),
		"陳美玲（2023）。以*星號*命名。華杏。", "no italics around text that contains Markdown characters");
});

test("theses (學位論文): unpublished, Airiti and the national thesis system", () => {
	let thesis = {
		itemType: "thesis", title: "加護病房護理人員之工作壓力", creators: [author("陳", "美玲")], year: "2020",
		publisher: "國防醫學院", thesisType: "碩士論文",
	};
	assert.equal(zh.formatReference(thesis, { format: "markdown" }), "陳美玲（2020）。*加護病房護理人員之工作壓力*〔未出版之碩士論文〕。國防醫學院。");
	assert.equal(zh.formatReference(thesis, { style: "twna" }), "陳美玲（2020）．加護病房護理人員之工作壓力〔未出版之碩士論文〕．國防醫學院。");
	// Airiti: thesis type in English, DOI only in Extra
	let airiti = Object.assign({}, thesis, {
		thesisType: "Master's Thesis", extra: "DOI: 10.6832/KMU.2007.00008", libraryCatalog: "Airiti",
		url: "https://www.airitilibrary.com/Publication/alDetailedMesh1?DocID=U0011-0406200711273000",
	});
	assert.equal(zh.formatReference(airiti), "陳美玲（2020）。加護病房護理人員之工作壓力〔碩士論文，國防醫學院〕。華藝線上圖書館。https://doi.org/10.6832/KMU.2007.00008");
	let ndltd = Object.assign({}, thesis, { thesisType: "博士論文", url: "https://hdl.handle.net/11296/abc123" });
	assert.equal(zh.formatReference(ndltd), "陳美玲（2020）。加護病房護理人員之工作壓力〔博士論文，國防醫學院〕。臺灣博碩士論文知識加值系統。https://hdl.handle.net/11296/abc123");
	assert.match(zh.formatReference(Object.assign({}, thesis, { thesisType: "" })), /〔未出版之學位論文〕/);
});

test("books, chapters, web pages and items without an author", () => {
	assert.equal(zh.formatReference({ itemType: "book", title: "護理研究概論", creators: [author("王", "大明")], year: "2019", publisher: "華杏", edition: "3" }, { format: "markdown" }),
		"王大明（2019）。*護理研究概論*（第3版）。華杏。");
	assert.equal(zh.formatReference({ itemType: "book", title: "護理研究概論", creators: [{ lastName: "王", firstName: "大明", creatorType: "editor" }], year: "2019", publisher: "華杏" }),
		"王大明（主編）（2019）。護理研究概論。華杏。");
	assert.equal(zh.formatReference({
		itemType: "bookSection", title: "跌倒評估", creators: [author("李", "志明"), { lastName: "王", firstName: "大明", creatorType: "editor" }],
		year: "2019", publication: "老人護理學", pages: "101-120", publisher: "華杏",
	}, { format: "markdown" }), "李志明（2019）。跌倒評估。載於王大明（主編），*老人護理學*（頁 101–120）。華杏。");
	assert.equal(zh.formatReference({ itemType: "webpage", title: "長期照顧統計", creators: [single("衛生福利部")], publication: "衛生福利部", year: "2024", url: "https://www.mohw.gov.tw/x" }),
		"衛生福利部（2024）。長期照顧統計。https://www.mohw.gov.tw/x", "publisher = author is left out");
	assert.equal(zh.formatReference({ itemType: "report", title: "護理人力報告", creators: [], year: "2022", publisher: "台灣護理學會" }, { format: "markdown" }),
		"*護理人力報告*（2022）。台灣護理學會。");
});

test("in-text citations: 陳美玲，2023 / 陳美玲、林小華，2023 / 陳美玲等，2023", () => {
	assert.equal(zh.shortCitation(article(1)), "陳美玲，2023");
	assert.equal(zh.shortCitation(article(2)), "陳美玲、林小華，2023");
	assert.equal(zh.shortCitation(article(3)), "陳美玲等，2023");
	assert.equal(zh.shortCitation(article(22)), "陳美玲等，2023");
	assert.equal(zh.shortCitation(article(1, { year: "", date: "" })), "陳美玲，無日期");
	assert.equal(zh.shortCitation({ title: "一個很長很長很長很長的研究題目", creators: [], year: "2020" }), "一個很長很長很長很長的研…，2020");
	// synthesis.js uses it for Chinese items only
	assert.equal(syn.shortCitation(article(3)), "陳美玲等，2023");
	assert.equal(syn.shortCitation(sampleItem()), "Chen & Smith, 2024");
	let entries = [
		{ id: "S1", citation: syn.shortCitation(article(3)), data: article(3) },
		{ id: "S2", citation: syn.shortCitation(sampleItem()), data: sampleItem() },
	];
	assert.equal(syn.resolveCitations("見 [S1] 與 [S1, S2]。", entries, "plain"), "見 (陳美玲等，2023) 與 (陳美玲等，2023; Chen & Smith, 2024)。");
});

test("reference lists: Chinese first by stroke count, then English alphabetically", () => {
	let items = [
		Object.assign(sampleItem(), { apa: "Smith, J. (2020). B." }),
		Object.assign(article(1), { creators: [author("陳", "美玲")] }),
		Object.assign(sampleItem(), { apa: "Adams, K. (2021). A." }),
		Object.assign(article(1), { creators: [author("王", "大明")] }),
		Object.assign(article(1), { creators: [author("丁", "一")] }),
	];
	let refs = items.map(d => d.apa && !zh.isChineseItem(d) ? d.apa : zh.formatReference(d));
	let sorted = zh.sortReferences(refs, items);
	assert.deepEqual(sorted.map(r => r.slice(0, 3)), ["丁一（", "王大明", "陳美玲", "Ada", "Smi"]);
	// Setting off: one alphabetical list (as before)
	let plain = zh.sortReferences(refs, items, { chineseFirst: false });
	assert.deepEqual(plain.map(r => r.slice(0, 3)), ["Ada", "Smi", "丁一（", "王大明", "陳美玲"]);

	// synthesis.referenceList: Chinese APA with italics, Chinese first
	let entries = items.map((d, i) => {
		let data = Object.assign({}, d);
		if (zh.isChineseItem(data)) {
			data.apa = zh.formatReference(data);
			data.apaMarkdown = zh.formatReference(data, { format: "markdown" });
		}
		return { id: `S${i + 1}`, citation: syn.shortCitation(data), data };
	});
	let list = syn.referenceList(entries).split("\n").filter(l => l.startsWith("- "));
	assert.equal(list.length, 5);
	assert.match(list[0], /^- 丁一（2023）。護理人員跌倒預防衛教之成效。\*護理雜誌，70\*\(2\)/);
	assert.match(list[3], /^- Adams/);
	assert.match(list[4], /^- Smith/);
});

test("CSL JSON: Chinese names as full literal names, language zh-TW; English untouched", () => {
	let csl = {
		id: "http://zotero.org/users/1/items/AAAA", type: "article-journal", title: "護理人員跌倒預防衛教之成效",
		author: [{ family: "陳", given: "美玲" }, { literal: "林小華" }, { family: "美玲", given: "王" }, { family: "歐", given: "陽志明" }],
		editor: [{ family: "Smith", given: "John" }],
		language: "zh",
	};
	let frozen = JSON.parse(JSON.stringify(csl));
	let entry = bib.toExportEntry(csl, "陳2023護理人員");
	assert.deepEqual(entry.author, [{ literal: "陳美玲" }, { literal: "林小華" }, { literal: "王美玲" }, { literal: "歐陽志明" }]);
	assert.deepEqual(entry.editor, [{ family: "Smith", given: "John" }]);
	assert.equal(entry.language, "zh-TW");
	assert.equal(entry.id, "陳2023護理人員");
	assert.deepEqual(csl, frozen, "Zotero's cached CSL is not changed");
	assert.equal(bib.toExportEntry(Object.assign({}, csl, { language: "" }), "k").language, "zh-TW");
	assert.equal(bib.toExportEntry(Object.assign({}, csl, { language: "中文" }), "k").language, "zh-TW");
	assert.equal(bib.toExportEntry(Object.assign({}, csl, { language: "zh-CN" }), "k").language, "zh-CN", "explicit region kept");
	// Airiti's English articles keep their data (only the Han names would change)
	let english = { type: "article-journal", title: "Fall prevention", author: [{ family: "Chen", given: "Mei" }], language: "zh" };
	assert.deepEqual(bib.toExportEntry(english, "chen2024fall"), Object.assign({ id: "chen2024fall", "citation-key": "chen2024fall" }, english, { id: "chen2024fall" }));
	// Turned off in the settings: Zotero's data as is
	assert.deepEqual(bib.toExportEntry(csl, "k", { zh: { enabled: false } }).author, csl.author);
	assert.equal(bib.buildCSLJSON([entry]).includes("\"literal\": \"陳美玲\""), true);
});

test("citekeys of Chinese items stay as before (export.js stores them)", () => {
	let title = "護理人員跌倒預防衛教之成效";
	assert.equal(bib.generateCitekey({ creators: [author("陳", "美玲")], year: "2023", title }), "陳2023護理人員");
	assert.equal(bib.generateCitekey({ creators: [single("陳美玲")], year: "2023", title }), "陳美玲2023護理人員", "single-field name: whole name");
	assert.equal(bib.generateCitekey({ creators: [author("歐", "陽志明")], year: "2023", title }), "歐2023護理人員", "Airiti split: unchanged");
	assert.equal(bib.generateCitekey({ creators: [author("陳", "美玲")], year: "2023", title: "COVID-19 疫情下護理人員之壓力" }), "陳2023covid");
	assert.equal(bib.generateCitekey({ creators: [author("陳", "美玲")], year: "2023", title: "「護理」人員" }), "陳2023護理", "first word ends at punctuation");
	for (let key of ["陳2023護理人員", "陳美玲2023護理人員"]) assert.match(key, /^[\p{L}\p{N}_][\p{L}\p{N}]*$/u);
});
