// Evidence-based health care report through the real plugin in a mocked Zotero: the menu entries, the
// dialog prefilled from the AI notes' PICO, the collection's PRISMA screening tags and its PubMed watch,
// the cost confirmation, the Claude request, the Obsidian note (evidence table, PRISMA figure, Pandoc
// citations, checklists), references.json, the Notion page, and a re-run that keeps the user's edits.
// dialog, the Claude request, the Obsidian note with Pandoc citations, references.json, the Notion
// page, and a re-run that keeps the user's edits and reuses the outline and the Notion page.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const ROOT_URI = "file://" + ROOT + "/";
const PARENT = "https://www.notion.so/Research-22222222222222222222222222222222";

// The parts of Zotero, Gecko and the plugin scope that a draft touches
function makeEnv({ prefs, fetch }) {
	let items = new Map();
	let nextID = 100;
	let progressLines = [];
	let descriptions = [];
	let errors = [];
	let menus = [];
	let confirms = [];

	class MockItem {
		constructor(type, fields = {}) {
			this.id = nextID++;
			this.key = fields.key || `KEY${this.id}`;
			this.itemType = type;
			this.libraryID = 1;
			this.deleted = false;
			this.parentID = null;
			this.fields = fields;
			this.tags = [];
			this.children = [];
			this.noteHTML = "";
			this.version = 1;
			this.dateAdded = fields.dateAdded || "2024-05-01 08:00:00";
			this.dateModified = "2024-05-02 08:00:00";
			items.set(this.id, this);
		}
		get parentItem() { return this.parentID ? items.get(this.parentID) : undefined; }
		isRegularItem() { return !["note", "attachment", "annotation"].includes(this.itemType); }
		isNote() { return this.itemType === "note"; }
		isFileAttachment() { return this.itemType === "attachment"; }
		getField(f) { return this.fields[f] || ""; }
		getCreatorsJSON() { return this.fields.creators || []; }
		getTags() { return this.tags.map(tag => ({ tag })); }
		addTag(t) { this.tags.push(t); }
		getCollections() { return []; }
		getAttachments() { return this.children.filter(id => items.get(id).itemType === "attachment"); }
		getNotes() { return this.children.filter(id => items.get(id).itemType === "note"); }
		getNote() { return this.noteHTML; }
		getNoteTitle() { return "note"; }
		getItemTypeIconName() { return this.itemType; }
	}
	function addChild(parent, child) {
		child.parentID = parent.id;
		parent.children.push(child.id);
	}

	let prefStore = Object.assign({}, prefs);
	let Zotero = {
		Prefs: { get: k => prefStore[k], set: (k, v) => { prefStore[k] = v; }, clear: (k) => { delete prefStore[k]; } },
		MenuManager: { registerMenu: (o) => { menus.push(o); return o.menuID; }, unregisterMenu: () => true },
		Notifier: { registerObserver: () => "obs", unregisterObserver: () => {} },
		ItemPaneManager: { registerSection: o => o.paneID, unregisterSection: () => true },
		PreferencePanes: { register: async () => "pane" },
		getMainWindows: () => [],
		getMainWindow: () => ({}),
		Items: {
			get: ids => (Array.isArray(ids) ? ids.map(id => items.get(id)) : items.get(ids)),
			getAll: async () => [...items.values()],
			getByLibraryAndKey: (libraryID, key) => [...items.values()].find(i => i.libraryID === libraryID && i.key === key) || false,
		},
		Libraries: {
			get: () => ({ libraryType: "user", name: "My Library" }),
			getAll: () => [{ libraryID: 1, libraryType: "user", name: "My Library" }],
		},
		Groups: { getGroupIDFromLibraryID: () => null },
		Collections: { get: ids => (Array.isArray(ids) ? [] : null), getByParent: () => [] },
		Styles: { get: () => null },
		Utilities: {
			Item: {
				itemToCSLJSON: async item => ({
					type: "article-journal",
					title: item.getField("title"),
					author: item.getCreatorsJSON().map(c => ({ family: c.lastName, given: c.firstName || "" })),
					issued: { "date-parts": [[Number(item.getField("year"))]] },
				}),
			},
		},
		ProgressWindow: class {
			constructor() {
				this.ItemProgress = class {
					constructor(icon, text) { this.text = text; progressLines.push(this); }
					setText(t) { this.text = t; }
					setProgress(p) { this.progress = p; }
					setError() { this.error = true; }
				};
			}
			changeHeadline() {}
			addDescription(t) { descriptions.push(t); }
			show() {}
			startCloseTimer() {}
		},
		logError: (e) => { errors.push(e); },
		debug: () => {},
	};
	Zotero.Item = MockItem;

	let IOUtils = {
		exists: async p => fs.existsSync(p),
		readUTF8: async p => fsp.readFile(p, "utf8"),
		writeUTF8: async (p, t) => fsp.writeFile(p, t, "utf8"),
		makeDirectory: async p => fsp.mkdir(p, { recursive: true }),
		read: async (p, opts = {}) => {
			let buf = await fsp.readFile(p);
			return new Uint8Array(opts.maxBytes == null ? buf : buf.subarray(0, opts.maxBytes));
		},
		getChildren: async p => (await fsp.readdir(p)).map(name => path.join(p, name)),
		stat: async (p) => {
			let st = await fsp.stat(p);
			return { type: st.isDirectory() ? "directory" : "regular", size: st.size };
		},
	};
	let PathUtils = { join: (...parts) => path.join(...parts), filename: p => path.basename(p), parent: p => path.dirname(p) };
	let logins = [];
	let globals = {
		Zotero, IOUtils, PathUtils, fetch, console, TextDecoder, TextEncoder,
		Components: {
			Constructor: function () {
				return function (origin, formActionOrigin, httpRealm, username, password) {
					Object.assign(this, { origin, httpRealm, username, password });
				};
			},
			interfaces: { nsILoginInfo: {} },
		},
		DOMParser: new JSDOM("").window.DOMParser,
		setTimeout, clearTimeout,
		Services: {
			scriptloader: {
				loadSubScript: (url) => {
					let file = url.replace("file://", "");
					vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
				},
			},
			prompt: { confirm: (win, title, text) => { confirms.push(text); return true; } },
			logins: {
				searchLoginsAsync: async m => logins.filter(l => Object.entries(m).every(([k, v]) => l[k] === v)),
				addLoginAsync: async (l) => { logins.push(l); return l; },
				modifyLoginAsync: async (old, l) => { logins[logins.indexOf(old)] = l; },
				removeLoginAsync: async (old) => { logins.splice(logins.indexOf(old), 1); },
			},
		},
	};
	let context = vm.createContext(globals);
	vm.runInContext(fs.readFileSync(path.join(ROOT, "bootstrap.js"), "utf8"), context, { filename: "bootstrap.js" });
	return { context, MockItem, addChild, progressLines, descriptions, errors, menus, confirms, prefStore };
}

const REPORT = `## 題目
住院高齡病人接受跌倒預防衛教是否能降低跌倒？
Does Fall Prevention Education Reduce Falls in Older Inpatients?

## 中文摘要
**形成臨床提問**：病人擔心夜間再跌倒。
**文獻搜尋的方法與分析**：搜尋 PubMed 與 Cochrane，最後納入 2 篇。
**文獻的品質評讀**：統合分析 RR = 0.72。
**結論與建議**：建議衛教。
關鍵詞：跌倒、衛教、住院病人

## 英文摘要
**Ask an answerable question (PICO)**: Falls in older inpatients.

## 前言
臨床上病人問：「我晚上起來上廁所，要怎麼做才不會再跌倒？」因而引發作者動機 [S2]。

## 形成臨床提問
78 歲陳先生，依據實證護理五大步驟，形成一個可回答的問題。

## 文獻的品質評讀
評讀工具沿用各篇 AI 筆記。

### [S1] 系統性回顧與統合分析
**主要研究成果**：RR = 0.72，95% CI 0.61–0.85。

### [S2] 隨機對照試驗
| 評讀項目 | 評讀結果 | 評析根據 |
|---|---|---|
| 是否真正隨機分派 | 是 | 電腦亂數分派 |
**主要研究成果**：跌倒率降低 30%；追蹤 18 個月共 333 人。

## 證據綜整
兩篇結果一致 [S1, S2]。

## 臨床應用
由受訓護理師於入院時衛教 [S2]。

## 結論與建議
故本文臨床建議可教導病人夜間如廁前按鈴 [S2]。
`;

function notionAndClaude(log, notion) {
	let ok = json => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(json) });
	return async (url, init) => {
		let body = init.body ? JSON.parse(init.body) : undefined;
		if (url.startsWith("https://api.anthropic.com/")) {
			log.push({ api: "anthropic", body });
			return ok({ model: "test-model", stop_reason: "end_turn", content: [{ type: "text", text: REPORT }], usage: { input_tokens: 20000, output_tokens: 7000 } });
		}
		let p = url.replace("https://api.notion.com/v1/", "");
		log.push({ api: "notion", method: init.method, path: p, body });
		if (p === "pages" && init.method === "POST") {
			notion.pages.push(body);
			return ok({ id: `ebhc-page-${notion.pages.length}`, url: `https://www.notion.so/ebhc-page-${notion.pages.length}` });
		}
		if (/^pages\/ebhc-page-\d+$/.test(p) && init.method === "GET") {
			return ok({ id: p.slice(6), url: `https://www.notion.so/${p.slice(6)}`, in_trash: false });
		}
		if (/^blocks\/ebhc-page-\d+\/children\?/.test(p)) return ok({ results: notion.children, has_more: false });
		if (/^blocks\/ebhc-page-\d+\/children$/.test(p)) {
			notion.children = [{ id: "container-1", type: "callout", callout: { rich_text: [{ plain_text: "Zotero Bridge｜…" }] } }];
			return ok({ results: [{ id: "container-1" }] });
		}
		if (p === "blocks/container-1" && init.method === "DELETE") return ok({});
		return { status: 404, ok: false, headers: { get: () => null }, text: async () => JSON.stringify({ message: p }) };
	};
}

function aiNote(env, parent, sections, data) {
	let note = new env.MockItem("note");
	note.noteHTML = "<h1>🤖 AI 文獻筆記</h1><p><em>由 test-model 於 2026-10-01T00:00:00Z 產生（Zotero Bridge）</em></p>"
		+ sections + `<h2>📋 結構化資料（Zotero Bridge）</h2><pre>${JSON.stringify(data, null, 2)}</pre>`;
	note.tags = ["zotero-bridge-ai"];
	env.addChild(parent, note);
}

test("EBHC report: menu → dialog prefilled from PICO, PRISMA tags and the PubMed watch → Claude → Obsidian + references.json + Notion; re-run keeps edits", async () => {
	let vault = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-vault-"));
	let log = [];
	let notion = { pages: [], children: [] };
	let env = makeEnv({
		fetch: notionAndClaude(log, notion),
		prefs: {
			"extensions.zotero-bridge.obsidian.vaultPath": vault,
			"extensions.zotero-bridge.obsidian.folder": "Zotero",
			"extensions.zotero-bridge.notion.token": "ntn_test",
			"extensions.zotero-bridge.notion.synthesisParent": PARENT,
			"extensions.zotero-bridge.llm.enabled": true,
			"extensions.zotero-bridge.llm.provider": "anthropic",
			"extensions.zotero-bridge.llm.anthropicKey": "sk-ant-test",
			"extensions.zotero-bridge.llm.anthropicModel": "test-model",
			"extensions.zotero-bridge.usage.prices": JSON.stringify({ "test-model": { input: 5, output: 25 } }),
			"extensions.zotero-bridge.pubmedWatch.watches": JSON.stringify([{ name: "跌倒", query: "falls[Mesh] AND \"patient education\"[tiab]", collection: "跌倒實證" }]),
		},
	});
	await vm.runInContext(`startup({ id: "zb", version: "0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);
	let ZB = env.context.ZB;

	let chen = new env.MockItem("journalArticle", {
		title: "Nurse-led education and falls: a randomized controlled trial", year: "2024", citationKey: "chen2024",
		creators: [{ lastName: "Chen", firstName: "Mei", creatorType: "author" }],
	});
	chen.tags = ["篩選/全文/納入", "來源/PubMed"];
	aiNote(env, chen, "<h2>一句話摘要</h2><p>護理師主導衛教使跌倒率降低 30%。</p><h2>主要結果</h2><p>介入組跌倒率降低 30%。</p>"
		+ "<h2>嚴格評讀</h2><ul><li>評讀工具：JBI Checklist for Randomized Controlled Trials</li><li>整體評價：納入 — 品質良好</li></ul>"
		+ "<h2>證據等級</h2><p>Oxford CEBM 2011 Level 2。</p>", {
		study_design: "RCT", sample_size: 120, population: "65 歲以上住院病人", intervention: "護理師主導跌倒預防衛教", comparison: "常規照護",
		outcomes: "跌倒發生率", evidence_level: "2", appraisal_tool: "JBI Checklist for Randomized Controlled Trials", appraisal_overall: "納入",
	});
	let wang = new env.MockItem("journalArticle", {
		title: "Fall prevention education for inpatients: a meta-analysis", year: "2022", citationKey: "wang2022fall",
		abstractNote: "Pooled RR = 0.72 (95% CI 0.61–0.85).", creators: [{ lastName: "Wang", firstName: "Li", creatorType: "author" }],
	});
	wang.tags = ["篩選/全文/納入", "來源/Cochrane"];
	aiNote(env, wang, "<h2>一句話摘要</h2><p>統合分析顯示衛教降低跌倒風險。</p>", {
		study_design: "meta-analysis", sample_size: 2400, population: "65歲以上住院病人", intervention: "跌倒預防衛教", comparison: "常規照護",
		outcomes: "跌倒發生率", evidence_level: "1", appraisal_tool: "CASP Systematic Review Checklist", appraisal_overall: "納入",
	});
	let lee = new env.MockItem("journalArticle", { title: "Falls in nursing homes", year: "2021", creators: [{ lastName: "Lee", creatorType: "author" }] });
	lee.tags = ["篩選/全文/排除", "排除原因/族群不符（wrong population）", "來源/PubMed"];
	let dup = new env.MockItem("journalArticle", { title: "Falls in nursing homes (duplicate)", year: "2021", creators: [{ lastName: "Lee", creatorType: "author" }] });
	dup.tags = ["篩選/重複", "來源/PubMed"];
	let collection = { id: 7, key: "COLL0001", name: "跌倒實證", libraryID: 1, getChildItems: () => [chen, wang, lee, dup] };
	let collectionRow = { isCollection: () => true, ref: collection };

	let asks = [];
	let answer = init => Object.assign({}, init, {
		scenario: "78 歲陳先生因肺炎住院，夜間曾跌倒一次。病人問：「我晚上起來上廁所，要怎麼做才不會再跌倒？」",
		intervention: "跌倒預防衛教", limits: "2015–2025 年；限 SR 與 RCT", searchDate: "2026 年 9 月 30 日",
	});
	ZB.ebhcReport.runtime.ask = async (win, init) => {
		asks.push(JSON.parse(JSON.stringify(init)));
		let a = answer(init);
		delete a.name;
		delete a.count;
		delete a.hints;
		return a;
	};
	let pending = null;
	let run = ZB.ebhcReport.run;
	ZB.ebhcReport.run = (...args) => (pending = run(...args));

	let entryOf = menuID => env.menus.find(m => m.menuID === menuID).menus[0].menus.find(m => m.l10nID === "zotero-bridge-menu-ebhc-report");
	let collMenu = entryOf("zotero-bridge-collection");
	assert.ok(collMenu, "collection menu entry");
	assert.ok(entryOf("zotero-bridge-item"), "item menu entry");
	collMenu.onCommand({}, { collectionTreeRows: [collectionRow] });
	await pending;
	assert.deepEqual(env.errors, []);

	// The dialog: only the full-text included studies; consistent PICO fields; PRISMA and the watch
	assert.equal(asks.length, 1);
	let init = asks[0];
	assert.equal(init.name, "跌倒實證");
	assert.equal(init.count, 2);
	assert.equal(init.population, "65歲以上住院病人", "the strongest study's wording when all agree");
	assert.equal(init.intervention, "");
	assert.match(init.hints.intervention, /^各篇不一致，未自動帶入：跌倒預防衛教／護理師主導跌倒預防衛教$/);
	assert.equal(init.comparison, "常規照護");
	assert.equal(init.outcomes, "跌倒發生率");
	assert.equal(init.questionType, "therapy");
	assert.equal(init.databases, "PubMed（n = 3）、Cochrane（n = 1）");
	assert.equal(init.query, "falls[Mesh] AND \"patient education\"[tiab]");
	assert.equal(init.hints.query, "已帶入：PubMed 追蹤「跌倒」的檢索式。");
	assert.equal(init.screening, "資料庫與登錄庫共搜尋 4 篇（PubMed（n = 3）、Cochrane（n = 1）），排除重複文獻 1 篇，閱讀標題與摘要篩選 3 篇，排除 0 篇，全文評估 3 篇，排除 1 篇（族群不符（wrong population） 1 篇），最後納入 2 篇進行評讀。");
	assert.equal(init.scenario, "");

	// Cost confirmation
	assert.equal(env.confirms.length, 1);
	assert.match(env.confirms[0], /將用 test-model 依 2 篇文獻撰寫實證健康照護報告草稿/);
	assert.match(env.confirms[0], /預估費用：約 US\$\d+\.\d\d（輸入約 [\d,]+ tokens、輸出以約 8,000 tokens 估算；最多約 US\$\d+\.\d\d）/);

	// The request: the strongest study is S1; appraisal and study data up front; scenario, PICO, search
	let calls = log.filter(l => l.api === "anthropic");
	assert.equal(calls.length, 1);
	let req = calls[0].body;
	assert.equal(req.model, "test-model");
	assert.match(req.system, /^你是臺灣護理實證健康照護（EBHC）的寫作助理/);
	let user = req.messages[0].content;
	assert.match(user, /<source id="S1">\n標題：Fall prevention education for inpatients: a meta-analysis/);
	assert.match(user, /<source id="S2">\n標題：Nurse-led education and falls[\s\S]*<appraisal_from_ai_note>\n## 嚴格評讀\n\n- 評讀工具：JBI Checklist for Randomized Controlled Trials/);
	assert.doesNotMatch(user, /Falls in nursing homes/, "excluded studies are not sent");
	assert.match(user, /<clinical_scenario>\n78 歲陳先生/);
	assert.match(user, /<pico>\n問題類型：治療／介入（Therapy）\nP（族群／問題（Patient／Problem））：65歲以上住院病人\nI（介入措施（Intervention））：跌倒預防衛教\n/);
	assert.match(user, /<search_summary>\n資料庫：PubMed（n = 3）、Cochrane（n = 1）\n檢索式：falls\[Mesh\][\s\S]*搜尋日期：2026 年 9 月 30 日\n搜尋結果與篩選：資料庫與登錄庫共搜尋 4 篇/);
	assert.match(user, /<evidence_summary>\n納入 2 篇：系統性回顧與統合分析 1 篇、隨機對照試驗（RCT） 1 篇；原始研究樣本數合計 120 人（1 篇有報告樣本數）；/);

	// Obsidian
	let drafts = path.join(vault, "Zotero", "Drafts");
	let notePath = path.join(drafts, "實證報告-跌倒實證.md");
	let note = fs.readFileSync(notePath, "utf8");
	assert.match(note, /^---\ntype: "ebhc-report"\nscope: "跌倒實證"\nquestion_type: "therapy"\nsources:\n {2}- "library\/KEY\d+"\n {2}- "library\/KEY\d+"\ncitekeys:\n {2}- "wang2022fall"\n {2}- "chen2024"\ngenerated_at: "[^"]+"\nmodel: "test-model"\nnotion: "https:\/\/www\.notion\.so\/ebhc-page-1"\n---\n\n# 實證報告：跌倒實證\n/);
	assert.match(note, /\| \[@wang2022fall\] \| 系統性回顧與統合分析 \| 2400 \| Level 1 \| CASP Systematic Review Checklist \| 納入 \| 統合分析顯示衛教降低跌倒風險。 \|/);
	assert.match(note, /\| \[@chen2024\] \| 隨機對照試驗（RCT） \| 120 \| Level 2 \| JBI Checklist for Randomized Controlled Trials \| 納入 \| 護理師主導衛教使跌倒率降低 30%。 \|/);
	assert.match(note, /- \*\*檢索式（布林邏輯 AND／OR）\*\*：PubMed 追蹤「跌倒」的檢索式\n\n```text\nfalls\[Mesh\] AND "patient education"\[tiab\]\n```/);
	assert.match(note, /- \*\*搜尋結果與篩選\*\*：資料庫與登錄庫共搜尋 4 篇/);
	assert.equal(note.match(/資料庫與登錄庫共搜尋 4 篇/g).length, 1, "the PRISMA sentence once");
	assert.match(note, /```mermaid\nflowchart TD[\s\S]*Reports excluded \(n = 1\):<br\/>族群不符（wrong population） \(n = 1\)/);
	assert.match(note, /\n#### @wang2022fall 系統性回顧與統合分析\n/);
	assert.match(note, /兩篇結果一致 \[@wang2022fall; @chen2024\]。/);
	assert.match(note, /> - \*\*數字\*\*：「\*\*主要研究成果\*\*：跌倒率降低 30%；追蹤 18 個月共 333 人。」— 在 Chen, 2024 的 AI 筆記、摘要與劃線中找不到 18、333/);
	assert.match(note, /> - \*\*評讀工具\*\*：Chen, 2024 的 AI 筆記使用 JBI Checklist for Randomized Controlled Trials/);
	assert.doesNotMatch(note, /沒有 PRISMA 流程圖/);
	assert.match(note, /## 📋 評分項目自我檢核/);
	assert.match(note, /--lua-filter zotero-bridge-ebhc\.lua -o 實證報告-跌倒實證\.docx/);
	assert.doesNotMatch(note, /\[S\d/);
	assert.equal(fs.readFileSync(path.join(drafts, "zotero-bridge-ebhc.lua"), "utf8"), ZB.ebhcReport.PANDOC_FILTER);
	let refs = JSON.parse(fs.readFileSync(path.join(vault, "Zotero", "references.json"), "utf8"));
	assert.ok(["chen2024", "wang2022fall"].every(k => refs.some(r => r.id === k)), "references.json has the cited keys");

	// Notion: a child page with plain citations in the managed container
	assert.equal(notion.pages.length, 1);
	assert.equal(notion.pages[0].properties.title.title[0].text.content, "實證報告：跌倒實證");
	let container = JSON.stringify(log.find(l => l.path === "blocks/ebhc-page-1/children" && l.method === "PATCH").body.children[0]);
	assert.match(container, /實證健康照護報告草稿（重新產生會覆寫/);
	assert.match(container, /兩篇結果一致 \(Wang, 2022; Chen, 2024\)/);
	assert.doesNotMatch(container, /@chen2024|\[S1/);

	// Stored per collection; usage recorded; progress window
	let store = JSON.parse(env.prefStore["extensions.zotero-bridge.ebhcReport.scopes"]);
	assert.match(store["C:1/COLL0001"].scenario, /^78 歲陳先生/);
	assert.equal(store["C:1/COLL0001"].notionPageId, "ebhc-page-1");
	let ledger = JSON.parse(env.prefStore["extensions.zotero-bridge.usage.ledger"]);
	assert.equal(Object.values(ledger)[0].calls, 1);
	let line = env.progressLines.find(l => /^實證報告：跌倒實證 — /.test(l.text));
	assert.equal(line.error, undefined, line.text);
	assert.equal(line.text, "實證報告：跌倒實證 — 已寫入 Notion、Obsidian（Zotero/Drafts/實證報告-跌倒實證.md）");
	assert.ok(env.descriptions.some(d => /^⚠️ 查核清單有 \d+ 項需要確認（見報告文末）。$/.test(d)), env.descriptions.join("\n"));
	assert.ok(env.descriptions.some(d => /^AI 用量：1 次呼叫，輸入 20,000／輸出 7,000 tokens/.test(d)), env.descriptions.join("\n"));

	// Re-run: the user's edits outside the region survive, the answers come back, the Notion page is reused
	fs.writeFileSync(notePath, note.replace("# 實證報告：跌倒實證\n", "# 實證報告：跌倒實證\n\n我自己寫的前言。\n")
		.replace("## ✍️ 我的筆記\n\n", "## ✍️ 我的筆記\n\n老師建議補充本土文獻。\n"));
	collMenu.onCommand({}, { collectionTreeRows: [collectionRow] });
	await pending;
	assert.deepEqual(env.errors, []);
	assert.match(asks[1].scenario, /^78 歲陳先生/);
	assert.equal(asks[1].intervention, "跌倒預防衛教");
	let note2 = fs.readFileSync(notePath, "utf8");
	assert.match(note2, /# 實證報告：跌倒實證\n\n我自己寫的前言。\n\n%% zotero-bridge:start/);
	assert.match(note2, /老師建議補充本土文獻。/);
	assert.equal(note2.match(/zotero-bridge:start/g).length, 1);
	assert.equal(notion.pages.length, 1, "the stored Notion page is reused");

	// Cancelled dialog: no request
	ZB.ebhcReport.runtime.ask = async () => null;
	collMenu.onCommand({}, { collectionTreeRows: [collectionRow] });
	await pending;
	assert.equal(log.filter(l => l.api === "anthropic").length, 2);

	// A screened collection without full-text inclusions is refused before anything is asked
	ZB.ebhcReport.runtime.ask = async () => { throw new Error("should not ask"); };
	let empty = { id: 8, key: "COLL0002", name: "尚未篩完", libraryID: 1, getChildItems: () => [lee, dup] };
	collMenu.onCommand({}, { collectionTreeRows: [{ isCollection: () => true, ref: empty }] });
	await pending;
	assert.ok(env.descriptions.some(d => /^「尚未篩完」還沒有全文納入的研究/.test(d)), env.descriptions.join("\n"));
	assert.deepEqual(env.errors, []);
	await vm.runInContext("shutdown()", env.context);
});
