// Literature review draft (content/review-draft.js): citations, number checks, outline store, Pandoc paths
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { JSDOM } = require("jsdom");
const rd = require("../content/review-draft.js");
const syn = require("../content/synthesis.js");
const { sampleItem } = require("./fixtures.cjs");

const chen = sampleItem();
const lee = sampleItem({
	key: "EFGH5678", title: "Exercise and falls in nursing homes", year: "2021", citationKey: "", generatedCitekey: "lee2021exercise",
	creators: [{ lastName: "Lee", firstName: "A", creatorType: "author" }],
	apa: "Lee, A. (2021). Exercise and falls in nursing homes. Geriatric Nursing.",
	abstract: "Falls decreased from 18.5% to 9.2% (p = .03) among １２０４ residents.",
	attachments: [],
});
const nokey = sampleItem({ key: "IJKL9012", citationKey: "", year: "2019", creators: [{ lastName: "Wang", creatorType: "author" }], apa: "", attachments: [] });

const SOURCES = [
	{
		data: chen,
		aiMarkdown: "## 主要結果\n介入組跌倒率降低 30%（OR = 0.45, 95% CI 0.30–0.68）。",
		study: { study_design: "RCT", sample_size: 120, evidence_level: "2", jbi_level: "1.c", measures: ["Morse Fall Scale"], appraisal_overall: "納入", country: "Taiwan" },
	},
	{ data: lee, aiMarkdown: "", annotationsText: "- p. 4 「effect size d = 0.62」" },
];

function prompt(sources = SOURCES, opts = {}) {
	return rd.buildReviewPrompt(sources, opts);
}

function texts(p, sources = SOURCES) {
	return new Map(sources.map((s, i) => [p.entries[i].id, rd.sourceText(s)]));
}

test("buildReviewPrompt reuses the synthesis labels and adds study data, outline and research question", () => {
	let p = prompt(SOURCES, { outline: ["跌倒的現況", "衛教介入的成效"], question: "探討衛教對跌倒的成效" });
	assert.equal(p.system, rd.DEFAULT_REVIEW_PROMPT.trim());
	assert.deepEqual(p.entries.map(e => [e.id, e.citekey, e.citation]), [
		["S1", "chen2024effects", "Chen & Smith, 2024"],
		["S2", "lee2021exercise", "Lee, 2021"],
	]);
	assert.match(p.user, /<source id="S1">[\s\S]*<study_data>\n研究設計：RCT\n樣本數：120\n測量工具：Morse Fall Scale\nOxford CEBM 證據等級：2\nJBI 證據等級：1\.c\n嚴格評讀結論：納入\n國家：Taiwan\n<\/study_data>\n<ai_note>/);
	assert.match(p.user, /<source id="S2">[\s\S]*<abstract>[\s\S]*<user_annotations>/);
	assert.match(p.user, /<my_study>\n研究問題／目的：探討衛教對跌倒的成效\n<\/my_study>/);
	assert.match(p.user, /<outline>\n1\. 跌倒的現況\n2\. 衛教介入的成效\n<\/outline>/);
	assert.match(p.user, /請依照系統指示撰寫文獻探討草稿。$/);
	assert.doesNotMatch(p.user, /文獻比較與綜合分析/);
	let empty = prompt(SOURCES, {});
	assert.match(empty.user, /<outline>（未提供：請自行歸納 3–6 個主題）<\/outline>/);
	assert.match(empty.user, /研究問題／目的：（未提供/);
	// The synthesis prompt itself is unchanged
	assert.match(syn.buildSynthesisPrompt(SOURCES).user, /請依照系統指示的格式輸出文獻比較與綜合分析。$/);
	assert.doesNotMatch(syn.buildSynthesisPrompt(SOURCES).user, /study_data/);
});

test("labels → Pandoc citations: single, grouped, adjacent, page locators", () => {
	let { entries } = prompt();
	let md = "衛教有效 [S1]。兩篇一致 [S1, S2]，也見於 [S2；S1] 與 [S1][S2] 及 [S2] [S1]。頁碼 [S1, p. 5]、[S2，pp. 3–4; S1]。小寫 [s2]。";
	let out = syn.resolveCitations(md, entries, "pandoc");
	assert.equal(out, "衛教有效 [@chen2024effects]。兩篇一致 [@chen2024effects; @lee2021exercise]，也見於 [@lee2021exercise; @chen2024effects]"
		+ " 與 [@chen2024effects; @lee2021exercise] 及 [@lee2021exercise; @chen2024effects]。頁碼 [@chen2024effects, p. 5]、"
		+ "[@lee2021exercise, pp. 3–4; @chen2024effects]。小寫 [@lee2021exercise]。");
	let plain = syn.resolveCitations(md, entries, "plain");
	assert.match(plain, /^衛教有效 \(Chen & Smith, 2024\)。兩篇一致 \(Chen & Smith, 2024; Lee, 2021\)/);
	assert.match(plain, /頁碼 \(Chen & Smith, 2024, p\. 5\)/);
	// Not a source label
	assert.equal(syn.resolveCitations("[Sample] [S] [1]", entries, "pandoc"), "[Sample] [S] [1]");
});

test("unknown labels and sources without a citekey are flagged, never dropped", () => {
	let p = prompt([...SOURCES, { data: nokey }]);
	let unknown = [];
	let out = syn.resolveCitations("A [S9]. B [S1, S9]. C [S3].", p.entries, "pandoc", {}, { flagUnknown: true, unknown });
	assert.equal(out, "A 【⚠️ 未知來源 S9】. B [@chen2024effects]【⚠️ 未知來源 S9】. C 【⚠️ 未知來源 S3（Wang, 2019 沒有 citekey）】.");
	assert.deepEqual(unknown, ["S9", "S9", "S3（Wang, 2019 沒有 citekey）"]);
	// Plain citations don't need a citekey
	assert.equal(syn.resolveCitations("C [S3, S9].", p.entries, "plain", {}, { flagUnknown: true }), "C (Wang, 2019)【⚠️ 未知來源 S9】.");
	// Without the option the synthesis keeps its old behaviour
	assert.equal(syn.resolveCitations("A [S9].", p.entries, "plain"), "A [S9].");
});

test("cleanDraft drops the H1, an outer fence, a reference list and the truncation notice", () => {
	let r = rd.cleanDraft("```markdown\n# 文獻探討\n\n## 一\n內容 [S1]。\n\n## 參考文獻\n- Chen (2024)\n```");
	assert.deepEqual(r, { md: "## 一\n內容 [S1]。", truncated: false });
	let t = rd.cleanDraft("# 一\n內容。\n\n# 二\n更多。\n\n> ⚠️ 輸出達到長度上限，內容可能不完整。");
	assert.deepEqual(t, { md: "## 一\n內容。\n\n## 二\n更多。", truncated: true });
});

test("numbers are checked against the cited sources' notes, study data, abstract and highlights", () => {
	let p = prompt();
	let md = [
		"## 現況",
		"衛教可降低跌倒率 30% [S1]。介入組 OR 為 0.45 [S1]，樣本 120 人 [S1]。",
		"長照機構 1,204 名住民的跌倒率由 18.5% 降至 9.2%，p = 0.03 [S2]。效果量 d = 0.62 [S2]。",
		"",
		"另一研究納入 250 人 [S1, p. 5]。跌倒率為 35%。",
		"",
		"## 小結",
		"共 12 篇研究中有 2 篇在 2020 年以後發表，皆使用 SF-36 與 95% CI 報告 [S1]。COVID-19 期間 [S2]。",
		"",
		"效果量 0.8 未標註來源。",
	].join("\n");
	let flagged = rd.checkNumbers(md, p.entries, texts(p));
	assert.deepEqual(flagged.map(f => [f.sentence, f.missing, f.ids]), [
		["另一研究納入 250 人 [S1, p. 5]。", ["250"], ["S1"]],
		// No citation of its own: checked against the paragraph's (S1), where 35% isn't found
		["跌倒率為 35%。", ["35%"], ["S1"]],
		["效果量 0.8 未標註來源。", ["0.8"], []],
	]);
	// A number from the wrong source is flagged too
	let wrong = rd.checkNumbers("跌倒率降低 30% [S2]。", p.entries, texts(p));
	assert.deepEqual(wrong.map(f => f.missing), [["30%"]]);
});

test("extractNumbers normalises full-width digits, thousands separators and leading-dot decimals", () => {
	assert.deepEqual(rd.extractNumbers("Ｎ＝１２０，p < .05，1,204 人，3.50％，SF-36，EQ5D").map(n => [n.raw, n.value, n.percent]), [
		["120", "120", false], [".05", "0.05", false], ["1,204", "1204", false], ["3.50", "3.5", true],
	]);
});

test("processDraft returns the Pandoc and plain versions and the checklist", () => {
	let p = prompt();
	let r = rd.processDraft("# 文獻探討\n\n## 一\n降低 30% [S1]，另有 40% [S9]。\n\n> ⚠️ 輸出未完成，內容可能不完整。", p.entries, texts(p));
	assert.equal(r.pandoc, "## 一\n降低 30% [@chen2024effects]，另有 40% 【⚠️ 未知來源 S9】。");
	assert.equal(r.plain, "## 一\n降低 30% (Chen & Smith, 2024)，另有 40% 【⚠️ 未知來源 S9】。");
	assert.deepEqual(r.issues.unknown, ["S9"]);
	assert.equal(r.issues.truncated, true);
	assert.deepEqual(r.issues.uncited.map(e => e.id), ["S2"]);
	assert.equal(r.issues.noCitations, false);
	let lines = rd.issueLines(r.issues, p.entries);
	assert.match(lines[0], /^\*\*輸出不完整\*\*/);
	assert.match(lines[1], /^\*\*未知來源代號\*\*：S9/);
	assert.match(lines[2], /^\*\*數字\*\*：「降低 30% \(Chen & Smith, 2024\)，另有 40% 【⚠️ 未知來源 S9】。」— 在 Chen & Smith, 2024 的 AI 筆記、摘要與劃線中找不到 40%$/);
	assert.match(lines[3], /^\*\*未引用的文獻\*\*（僅供參考）：Lee, 2021$/);
	let none = rd.processDraft("## 一\n沒有引用。", p.entries, texts(p));
	assert.equal(none.issues.noCitations, true);
});

test("outline: parsed per line, stored per scope, reused for the selection inside a collection", () => {
	assert.deepEqual(rd.parseOutline("  ## 現況\n\n- 介入成效\n• 測量工具\n第四節 研究缺口  \n"), ["現況", "介入成效", "測量工具", "第四節 研究缺口"]);
	assert.deepEqual(rd.parseStore("not json"), {});
	assert.deepEqual(rd.parseStore("[1]"), {});
	let col = { id: 7, key: "COLL0001", libraryID: 1, name: "碩論" };
	let byCollection = rd.draftScope({ label: "碩論", collection: col }, [col]);
	assert.deepEqual(byCollection, { key: "C:1/COLL0001", fallback: null, name: "碩論" });
	let bySelection = rd.draftScope({ label: "碩論（選取）", collection: null }, [col]);
	assert.deepEqual(bySelection, { key: "S:1/COLL0001", fallback: "C:1/COLL0001", name: "碩論（選取）" });
	assert.deepEqual(rd.draftScope({ label: "選取的文獻", collection: null }, []), { key: "S:selection", fallback: null, name: "選取的文獻" });

	let store = rd.updateStore({}, byCollection.key, { outline: "現況\n介入", question: "Q" }, "2026-10-01T00:00:00Z");
	store = rd.updateStore(store, byCollection.key, { notionPageId: "page-1" }, "2026-10-02T00:00:00Z");
	assert.deepEqual(store[byCollection.key], { outline: "現況\n介入", question: "Q", notionPageId: "page-1", updatedAt: "2026-10-02T00:00:00Z" });
	let reread = rd.parseStore(JSON.stringify(store));
	assert.equal(rd.scopeEntry(reread, [bySelection.key, bySelection.fallback]).outline, "現況\n介入");
	assert.deepEqual(rd.scopeEntry(reread, ["S:selection", null]), {});
	// Only the most recently used scopes are kept
	let many = {};
	for (let i = 0; i < 60; i++) many = rd.updateStore(many, `C:1/K${i}`, { outline: String(i) }, `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`);
	assert.equal(Object.keys(many).length, 50);
	assert.ok(many["C:1/K59"] && !many["C:1/K0"]);
});

test("Pandoc paths are relative to the Drafts folder", () => {
	assert.equal(rd.relativePath(["Zotero", "Drafts"], ["Zotero", "references.json"]), "../references.json");
	assert.equal(rd.relativePath(["Zotero", "Drafts"], ["apa.csl"]), "../../apa.csl");
	assert.equal(rd.relativePath(["Drafts"], ["references.json"]), "../references.json");
	assert.equal(rd.relativePath(["A", "B", "Drafts"], ["apa.csl"]), "../../../apa.csl");

	let p = rd.draftPaths(["Zotero"], "碩論");
	assert.equal(p.relPath, "Zotero/Drafts/文獻探討-碩論.md");
	assert.equal(p.command, "pandoc 文獻探討-碩論.md --citeproc --bibliography ../references.json --csl ../../apa.csl --lua-filter zotero-bridge-draft.lua -o 文獻探討-碩論.docx");
	let root = rd.draftPaths([], "碩論");
	assert.equal(root.relPath, "Drafts/文獻探討-碩論.md");
	assert.match(root.command, /--bibliography \.\.\/references\.json --csl \.\.\/apa\.csl /);
	let spaced = rd.draftPaths(["My Vault/Lit"], "碩論 A/B");
	assert.deepEqual(spaced.dirParts, ["My Vault/Lit", "Drafts"]);
	assert.match(spaced.command, /^pandoc "文獻探討-碩論 A B\.md" .* -o "文獻探討-碩論 A B\.docx"$/);
});

function draftFor(md) {
	let p = prompt();
	return { p, result: rd.processDraft(md, p.entries, texts(p)) };
}

const META = {
	title: "文獻探討：碩論", scope: "碩論", model: "claude-opus-5-5", generatedAt: "2026-10-08T01:02:03Z",
	question: "探討衛教\n對跌倒的成效", paths: rd.draftPaths(["Zotero"], "碩論"), withoutAI: ["Lee, 2021"], truncatedSources: [],
};

test("buildDraftNote: frontmatter, managed region, checklist; re-running keeps the user's edits", () => {
	let { p, result } = draftFor("## 一\n降低 30% [S1]，另有 99% [S2]。");
	let note = rd.buildDraftNote(null, result, p.entries, META);
	assert.match(note, /^---\ntype: "lit-review-draft"\nscope: "碩論"\nsources:\n {2}- "library\/ABCD1234"\n {2}- "library\/EFGH5678"\ncitekeys:\n {2}- "chen2024effects"\n {2}- "lee2021exercise"\ngenerated_at: "2026-10-08T01:02:03Z"\nmodel: "claude-opus-5-5"\n---\n\n# 文獻探討：碩論\n\n%% zotero-bridge:start/);
	assert.match(note, /研究問題／目的：探討衛教 對跌倒的成效/);
	assert.match(note, /沒有 AI 筆記、改用摘要與劃線的文獻：Lee, 2021/);
	assert.match(note, /## 一\n降低 30% \[@chen2024effects\]，另有 99% \[@lee2021exercise\]。/);
	assert.match(note, /## 參考文獻\n\n::: \{#refs\}\n:::\n\n> \[!abstract\]- 引用對照/);
	assert.match(note, /> - `@chen2024effects`：Chen, M\., & Smith, J\. \(2024\)/);
	assert.match(note, /## ⚠️ 查核清單\n\n> \[!warning\] 1 項需要回原文確認\n> - \*\*數字\*\*：「降低 30% \(Chen & Smith, 2024\)，另有 99% \(Lee, 2021\)。」— 在 Chen & Smith, 2024; Lee, 2021 的 AI 筆記、摘要與劃線中找不到 99%$/m);
	assert.match(note, /```bash\npandoc 文獻探討-碩論\.md --citeproc --bibliography \.\.\/references\.json --csl \.\.\/\.\.\/apa\.csl --lua-filter zotero-bridge-draft\.lua -o 文獻探討-碩論\.docx\n```/);
	assert.match(note, /%% zotero-bridge:end %%\n\n## ✍️ 我的筆記\n\n$/);

	// The user edits outside the region and adds a frontmatter key
	let edited = note
		.replace("model: \"claude-opus-5-5\"\n", "model: \"claude-opus-5-5\"\nchapter: 2\n")
		.replace("# 文獻探討：碩論\n", "# 文獻探討：碩論\n\n我在標記前加的引言。\n")
		.replace("## ✍️ 我的筆記\n\n", "## ✍️ 我的筆記\n\n我自己的段落 [@chen2024effects]。\n");
	let again = draftFor("## 二\n全新內容 [S2]。");
	let note2 = rd.buildDraftNote(edited, again.result, again.p.entries, Object.assign({}, META, { generatedAt: "2026-10-09T00:00:00Z", notionUrl: "https://www.notion.so/x" }));
	assert.match(note2, /^chapter: 2$/m);
	assert.match(note2, /^generated_at: "2026-10-09T00:00:00Z"$/m);
	assert.match(note2, /^notion: "https:\/\/www\.notion\.so\/x"$/m);
	assert.match(note2, /我在標記前加的引言。\n\n%% zotero-bridge:start/);
	assert.match(note2, /我自己的段落 \[@chen2024effects\]。/);
	assert.match(note2, /## 二\n全新內容 \[@lee2021exercise\]。/);
	assert.doesNotMatch(note2, /## 一\n/);
	assert.match(note2, /> \[!success\]/);
	assert.equal(note2.match(/zotero-bridge:start/g).length, 1);

	// Markers deleted by the user: a fresh region after the H1, nothing of theirs removed
	let noMarkers = "---\ntype: \"lit-review-draft\"\n---\n\n# 文獻探討：碩論\n\n我的版本。\n";
	let note3 = rd.buildDraftNote(noMarkers, again.result, again.p.entries, META);
	assert.match(note3, /# 文獻探討：碩論\n\n%% zotero-bridge:start[\s\S]*%% zotero-bridge:end %%\n\n\n我的版本。\n$/);
});

test("buildDraftPlain: (Author, year) citations, APA list and the checklist for Notion", () => {
	let { p, result } = draftFor("## 一\n降低 30% [S1, S2]。");
	let plain = rd.buildDraftPlain(result, p.entries, META);
	assert.match(plain, /^> AI 產生的文獻探討草稿（claude-opus-5-5，2026-10-08，2 篇文獻）/);
	assert.match(plain, /## 一\n降低 30% \(Chen & Smith, 2024; Lee, 2021\)。/);
	assert.match(plain, /## 參考文獻\n\n- Chen, M\., & Smith, J\. \(2024\)[\s\S]*\n- Lee, A\. \(2021\)/);
	assert.match(plain, /## ⚠️ 查核清單\n\n- 草稿中需要查核的數字都能在所引用文獻的筆記或摘要中找到。/);
	assert.doesNotMatch(plain, /@chen|\[S1|\[!/);
});

test("cost estimate: input from the prompt length, output at ~8000 and at most 16000 tokens", () => {
	assert.equal(rd.estimateTokens("文獻探討abcdefgh"), 6);
	let est = rd.estimateDraftCost("系統", "x".repeat(4000), "claude-opus-5-5", { "claude-opus-5-5": { input: 4, output: 20 } });
	assert.equal(est.inputTokens, 1002);
	assert.ok(Math.abs(est.expected - (1002 * 4 + 8000 * 20) / 1e6) < 1e-12);
	assert.ok(Math.abs(est.max - (1002 * 4 + 16000 * 20) / 1e6) < 1e-12);
	assert.deepEqual(rd.estimateDraftCost("a", "b", "gpt-5.5", { "claude-opus-5-5": { input: 4, output: 20 } }), { inputTokens: 2, expected: null, max: null });
});

test("outline dialog: a modal <dialog> on the main window, or two prompts as a fallback", async () => {
	let dom = new JSDOM("<!doctype html><body></body>");
	let win = dom.window;
	win.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
	win.HTMLDialogElement.prototype.close = function (rv) {
		this.removeAttribute("open");
		this.returnValue = rv || "";
		this.dispatchEvent(new win.Event("close"));
	};
	global.Zotero = { logError: (e) => { throw e; } };
	let pending = rd.askOptions(win, { name: "碩論", count: 3, question: "舊問題", outline: "現況\n成效" });
	let dialog = win.document.querySelector("dialog");
	assert.ok(dialog.open);
	assert.match(dialog.textContent, /文獻探討草稿：碩論（3 篇）/);
	let [q, o] = dialog.querySelectorAll("textarea");
	assert.equal(q.value, "舊問題");
	assert.equal(o.value, "現況\n成效");
	o.value = "現況\r\n成效\r\n缺口\r\n";
	q.value = " 新問題 ";
	[...dialog.querySelectorAll("button")].find(b => /下一步/.test(b.textContent)).click();
	assert.deepEqual(await pending, { question: "新問題", outline: "現況\n成效\n缺口" });
	assert.equal(win.document.querySelector("dialog"), null, "removed after closing");

	let cancelled = rd.askOptions(win, { name: "碩論", count: 3 });
	[...win.document.querySelectorAll("button")].find(b => b.textContent === "取消").click();
	assert.equal(await cancelled, null);

	// No modal dialogs: Services.prompt, sections separated by 「；」
	let asked = [];
	global.Services = {
		prompt: {
			prompt: (w, title, text, value) => {
				asked.push([text, value.value]);
				value.value = asked.length === 1 ? "研究問題" : "現況；成效; 缺口";
				return true;
			},
		},
	};
	let noDialog = { document: { createElementNS: () => ({}) } };
	assert.deepEqual(await rd.askOptions(noDialog, { question: "Q", outline: "a\nb" }), { question: "研究問題", outline: "現況\n成效\n缺口" });
	assert.deepEqual(asked.map(a => a[1]), ["Q", "a；b"]);
	global.Services.prompt.prompt = () => false;
	assert.equal(await rd.askOptions(noDialog, {}), null);
	delete global.Services;
	delete global.Zotero;
});

let hasPandoc = false;
try {
	execFileSync("pandoc", ["--version"], { stdio: "ignore" });
	hasPandoc = true;
}
catch (e) {}

test("the note converts with pandoc --citeproc and the Lua filter", { skip: !hasPandoc && "pandoc is not installed" }, () => {
	let vault = fs.mkdtempSync(path.join(os.tmpdir(), "zb-pandoc-"));
	let dir = path.join(vault, "Zotero", "Drafts");
	fs.mkdirSync(dir, { recursive: true });
	let { p, result } = draftFor("## 現況\n降低 30% [S1][S2]，頁碼 [S1, p. 5]，未知 [S9]。");
	let note = rd.buildDraftNote(null, result, p.entries, META).replace("## ✍️ 我的筆記\n\n", "## ✍️ 我的筆記\n\n私人筆記內容\n");
	fs.writeFileSync(path.join(dir, META.paths.fileName), note);
	fs.writeFileSync(path.join(dir, rd.FILTER_FILE), rd.PANDOC_FILTER);
	fs.writeFileSync(path.join(vault, "Zotero", "references.json"), JSON.stringify([
		{ id: "chen2024effects", type: "article-journal", title: "Effects", author: [{ family: "Chen", given: "Mei" }, { family: "Smith", given: "John" }], issued: { "date-parts": [[2024]] } },
		{ id: "lee2021exercise", type: "article-journal", title: "Exercise", author: [{ family: "Lee", given: "A" }], issued: { "date-parts": [[2021]] } },
	]));
	// The command from the note, minus apa.csl (not available offline; Pandoc's default style)
	let args = META.paths.command.split(" ").slice(1).filter((a, i, all) => a !== "--csl" && all[i - 1] !== "--csl");
	let out = execFileSync("pandoc", [...args.slice(0, args.indexOf("-o")), "-t", "plain", "--wrap=none"], { cwd: dir, encoding: "utf8" });
	assert.match(out, /降低 30% \(Chen and Smith 2024; Lee 2021\)/);
	assert.match(out, /頁碼 \(Chen and Smith 2024, 5\)/);
	assert.match(out, /【⚠️ 未知來源 S9】/);
	assert.match(out, /參考文獻\n\nChen, Mei, and John Smith\. 2024\. “Effects\.”\n\nLee, A\. 2021\. “Exercise\.”\n*$/);
	assert.doesNotMatch(out, /%%|查核清單|Pandoc 指令|引用對照|AI 產生的文獻探討草稿|私人筆記/);
});
