// Literature review draft through the real plugin in a mocked Zotero: the menu entry, the outline
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

const DRAFT = `# 文獻探討

## 住院病人跌倒的現況
跌倒是住院高齡病人常見的不良事件，衛教介入可使跌倒率降低 30% [S1]。長照機構的研究也觀察到跌倒率由 18.5% 降至 9.2% [S2][S1]。

## 跌倒預防衛教的成效
兩項研究的介入對象與場域不同，但結果方向一致 [S1, S2]；其中一項以 250 名病人進行 [S1, p. 5]。另有研究指出效果量為 0.5 [S9]。

## 文獻小結與研究缺口
現有研究缺乏台灣社區場域的資料，本研究將補足這個缺口 [S2]。

## 參考文獻
- Chen (2024)
`;

function notionAndClaude(log, notion) {
	let ok = json => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(json) });
	return async (url, init) => {
		let body = init.body ? JSON.parse(init.body) : undefined;
		if (url.startsWith("https://api.anthropic.com/")) {
			log.push({ api: "anthropic", headers: init.headers, body });
			return ok({ model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: DRAFT }], usage: { input_tokens: 30000, output_tokens: 6000 } });
		}
		let p = url.replace("https://api.notion.com/v1/", "");
		log.push({ api: "notion", method: init.method, path: p, body });
		if (p === "pages" && init.method === "POST") {
			notion.pages.push(body);
			return ok({ id: `draft-page-${notion.pages.length}`, url: `https://www.notion.so/draft-page-${notion.pages.length}` });
		}
		if (/^pages\/draft-page-\d+$/.test(p) && init.method === "GET") {
			return ok({ id: p.slice(6), url: `https://www.notion.so/${p.slice(6)}`, in_trash: false });
		}
		if (/^blocks\/draft-page-\d+\/children\?/.test(p)) return ok({ results: notion.children, has_more: false });
		if (/^blocks\/draft-page-\d+\/children$/.test(p)) {
			notion.children = [{ id: "container-1", type: "callout", callout: { rich_text: [{ plain_text: "Zotero Bridge｜…" }] } }];
			return ok({ results: [{ id: "container-1" }] });
		}
		if (p === "blocks/container-1" && init.method === "DELETE") return ok({});
		return { status: 404, ok: false, headers: { get: () => null }, text: async () => JSON.stringify({ message: p }) };
	};
}

test("literature review draft: menu → dialog → Claude → Obsidian (Pandoc) + references.json + Notion; re-run keeps edits", async () => {
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
			"extensions.zotero-bridge.llm.anthropicModel": "claude-opus-5-5",
		},
	});
	await vm.runInContext(`startup({ id: "zb", version: "0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);
	let ZB = env.context.ZB;

	let a = new env.MockItem("journalArticle", {
		title: "Nurse-led education and falls", year: "2024", citationKey: "chen2024",
		creators: [{ lastName: "Chen", firstName: "Mei", creatorType: "author" }],
	});
	let aiNote = new env.MockItem("note");
	aiNote.noteHTML = "<h1>🤖 AI 文獻筆記</h1><p><em>由 claude-opus-5-5 於 2026-10-01T00:00:00Z 產生（Zotero Bridge）</em></p>"
		+ "<h2>主要結果</h2><p>介入組跌倒率降低 30%。</p>"
		+ "<h2>📋 結構化資料（Zotero Bridge）</h2><pre>{\n  \"study_design\": \"RCT\",\n  \"sample_size\": 80,\n  \"evidence_level\": \"2\",\n  \"jbi_level\": \"1.c\"\n}</pre>";
	aiNote.tags = ["zotero-bridge-ai"];
	env.addChild(a, aiNote);
	// No Citation Key: the generated key export.js gives it
	let b = new env.MockItem("journalArticle", {
		title: "Exercise programmes in nursing homes", year: "2021", abstractNote: "Falls fell from 18.5% to 9.2% (p = .03).",
		creators: [{ lastName: "Lee", firstName: "A", creatorType: "author" }],
	});
	let collection = { id: 7, key: "COLL0001", name: "碩論", libraryID: 1, getChildItems: () => [a, b] };
	let collectionRow = { isCollection: () => true, ref: collection };

	// The dialog is replaced; the menu's promise is captured to wait for the run
	let asks = [];
	ZB.reviewDraft.runtime.ask = async (win, init) => {
		asks.push(JSON.parse(JSON.stringify(init)));
		return { question: "探討衛教對住院高齡病人跌倒的成效", outline: "住院病人跌倒的現況\n跌倒預防衛教的成效" };
	};
	let pending = null;
	let run = ZB.reviewDraft.run;
	ZB.reviewDraft.run = (...args) => (pending = run(...args));

	let collMenu = env.menus.find(m => m.menuID === "zotero-bridge-collection").menus[0].menus
		.find(m => m.l10nID === "zotero-bridge-menu-review-draft");
	assert.ok(collMenu, "collection menu entry");
	assert.ok(env.menus.find(m => m.menuID === "zotero-bridge-item").menus[0].menus.some(m => m.l10nID === "zotero-bridge-menu-review-draft"), "item menu entry");
	collMenu.onCommand({}, { collectionTreeRows: [collectionRow] });
	await pending;
	assert.deepEqual(env.errors, []);
	assert.deepEqual(asks, [{ name: "碩論", count: 2, outline: "", question: "" }]);

	// Cost confirmation before the call
	assert.equal(env.confirms.length, 1);
	assert.match(env.confirms[0], /將用 claude-opus-5-5 依 2 篇文獻撰寫文獻探討草稿/);
	assert.match(env.confirms[0], /預估費用：約 US\$\d+\.\d\d（輸入約 [\d,]+ tokens、輸出以約 8,000 tokens 估算；最多約 US\$\d+\.\d\d）/);
	assert.match(env.confirms[0], /其中 1 篇沒有 AI 筆記/);

	// The request: labelled sources with the study data, the outline and the research question
	let calls = log.filter(l => l.api === "anthropic");
	assert.equal(calls.length, 1);
	let req = calls[0].body;
	assert.equal(req.model, "claude-opus-5-5");
	assert.equal(req.max_tokens, 16000);
	assert.match(req.system, /^你是護理與醫學領域的學術寫作助理/);
	let user = req.messages[0].content;
	assert.match(user, /<source id="S1">\n標題：Nurse-led education and falls[\s\S]*<study_data>\n研究設計：RCT\n樣本數：80\nOxford CEBM 證據等級：2\nJBI 證據等級：1\.c\n<\/study_data>\n<ai_note>\n## 主要結果\n\n介入組跌倒率降低 30%。\n<\/ai_note>/);
	assert.doesNotMatch(user, /結構化資料（Zotero Bridge）/);
	assert.match(user, /<source id="S2">[\s\S]*<abstract>\nFalls fell from 18\.5% to 9\.2% \(p = \.03\)\.\n<\/abstract>/);
	assert.match(user, /<my_study>\n研究問題／目的：探討衛教對住院高齡病人跌倒的成效\n<\/my_study>/);
	assert.match(user, /<outline>\n1\. 住院病人跌倒的現況\n2\. 跌倒預防衛教的成效\n<\/outline>/);

	// Obsidian: Pandoc citations with the same keys as references.json
	let drafts = path.join(vault, "Zotero", "Drafts");
	let notePath = path.join(drafts, "文獻探討-碩論.md");
	let note = fs.readFileSync(notePath, "utf8");
	let refs = JSON.parse(fs.readFileSync(path.join(vault, "Zotero", "references.json"), "utf8"));
	let ids = refs.map(r => r.id).sort();
	assert.deepEqual(ids, ["chen2024", "lee2021exercise"]);
	assert.match(note, /^---\ntype: "lit-review-draft"\nscope: "碩論"\nsources:\n {2}- "library\/KEY\d+"\n {2}- "library\/KEY\d+"\ncitekeys:\n {2}- "chen2024"\n {2}- "lee2021exercise"\ngenerated_at: "[^"]+"\nmodel: "claude-opus-5-5"\nnotion: "https:\/\/www\.notion\.so\/draft-page-1"\n---\n\n# 文獻探討：碩論\n/);
	assert.match(note, /降低 30% \[@chen2024\]。長照機構的研究也觀察到跌倒率由 18\.5% 降至 9\.2% \[@lee2021exercise; @chen2024\]。/);
	assert.match(note, /結果方向一致 \[@chen2024; @lee2021exercise\]；其中一項以 250 名病人進行 \[@chen2024, p\. 5\]。另有研究指出效果量為 0\.5 【⚠️ 未知來源 S9】。/);
	assert.doesNotMatch(note, /- Chen \(2024\)/, "the model's own reference list is dropped");
	assert.doesNotMatch(note, /\[S\d/);
	assert.match(note, /## ⚠️ 查核清單\n\n> \[!warning\] 3 項需要回原文確認\n> - \*\*未知來源代號\*\*：S9/);
	assert.match(note, /> - \*\*數字\*\*：「兩項研究的介入對象與場域不同，但結果方向一致 \(Chen, 2024; Lee, 2021\)；其中一項以 250 名病人進行 \(Chen, 2024, p\. 5\)。」— 在 Chen, 2024; Lee, 2021 的 AI 筆記、摘要與劃線中找不到 250/);
	assert.match(note, /> - \*\*數字（沒有可查核的來源）\*\*：「另有研究指出效果量為 0\.5 【⚠️ 未知來源 S9】。」— 0\.5/);
	assert.match(note, /pandoc 文獻探討-碩論\.md --citeproc --bibliography \.\.\/references\.json --csl \.\.\/\.\.\/apa\.csl --lua-filter zotero-bridge-draft\.lua -o 文獻探討-碩論\.docx/);
	assert.equal(fs.readFileSync(path.join(drafts, "zotero-bridge-draft.lua"), "utf8"), ZB.reviewDraft.PANDOC_FILTER);

	// Notion: a child page of the synthesis parent with plain citations in the managed container
	assert.equal(notion.pages.length, 1);
	assert.deepEqual(notion.pages[0].parent, { type: "page_id", page_id: "22222222-2222-2222-2222-222222222222" });
	assert.equal(notion.pages[0].properties.title.title[0].text.content, "文獻探討：碩論");
	let container = log.find(l => l.path === "blocks/draft-page-1/children" && l.method === "PATCH").body.children[0];
	let text = JSON.stringify(container);
	assert.match(text, /文獻探討草稿（重新產生會覆寫/);
	assert.match(text, /跌倒率由 18\.5% 降至 9\.2% \(Lee, 2021; Chen, 2024\)/);
	assert.match(text, /查核清單/);
	assert.doesNotMatch(text, /@chen2024|\[S1/);

	// Stored per collection; usage recorded; progress window
	let store = JSON.parse(env.prefStore["extensions.zotero-bridge.reviewDraft.scopes"]);
	assert.equal(store["C:1/COLL0001"].outline, "住院病人跌倒的現況\n跌倒預防衛教的成效");
	assert.equal(store["C:1/COLL0001"].question, "探討衛教對住院高齡病人跌倒的成效");
	assert.equal(store["C:1/COLL0001"].notionPageId, "draft-page-1");
	let ledger = JSON.parse(env.prefStore["extensions.zotero-bridge.usage.ledger"]);
	assert.equal(Object.values(ledger)[0].calls, 1);
	let line = env.progressLines.find(l => /^文獻探討：碩論 — /.test(l.text));
	assert.equal(line.error, undefined, line.text);
	assert.equal(line.text, "文獻探討：碩論 — 已寫入 Notion、Obsidian（Zotero/Drafts/文獻探討-碩論.md）");
	assert.ok(env.descriptions.includes("⚠️ 查核清單有 3 項需要回原文確認（見草稿文末）。"), env.descriptions.join("\n"));
	assert.ok(env.descriptions.includes("已重新匯出 references.json（原本缺少部分引用文獻）。"));
	assert.ok(env.descriptions.some(d => /^AI 用量：1 次呼叫，輸入 30,000／輸出 6,000 tokens，約 US\$0\.24$/.test(d)), env.descriptions.join("\n"));

	// Re-run: the user's edits outside the region survive, the outline comes back, the Notion page is reused
	let edited = note
		.replace("# 文獻探討：碩論\n", "# 文獻探討：碩論\n\n我自己寫的前言。\n")
		.replace("## ✍️ 我的筆記\n\n", "## ✍️ 我的筆記\n\n口委建議補充社區研究。\n");
	fs.writeFileSync(notePath, edited);
	env.descriptions.length = 0;
	collMenu.onCommand({}, { collectionTreeRows: [collectionRow] });
	await pending;
	assert.deepEqual(env.errors, []);
	assert.deepEqual(asks[1], { name: "碩論", count: 2, outline: "住院病人跌倒的現況\n跌倒預防衛教的成效", question: "探討衛教對住院高齡病人跌倒的成效" });
	let note2 = fs.readFileSync(notePath, "utf8");
	assert.match(note2, /# 文獻探討：碩論\n\n我自己寫的前言。\n\n%% zotero-bridge:start/);
	assert.match(note2, /口委建議補充社區研究。/);
	assert.equal(note2.match(/zotero-bridge:start/g).length, 1);
	assert.equal(notion.pages.length, 1, "the stored Notion page is reused");
	assert.ok(log.some(l => l.path === "blocks/container-1" && l.method === "DELETE"), "the old container is replaced");
	assert.ok(env.descriptions.includes("references.json 已包含全部 2 篇引用文獻。"), env.descriptions.join("\n"));

	// Selected items inside the collection: their own draft, starting from the collection's outline
	let itemMenu = env.menus.find(m => m.menuID === "zotero-bridge-item").menus[0].menus
		.find(m => m.l10nID === "zotero-bridge-menu-review-draft");
	itemMenu.onCommand({}, { items: [a, b], collectionTreeRows: [collectionRow] });
	await pending;
	assert.deepEqual(env.errors, []);
	assert.deepEqual(asks[2], { name: "碩論（選取）", count: 2, outline: "住院病人跌倒的現況\n跌倒預防衛教的成效", question: "探討衛教對住院高齡病人跌倒的成效" });
	assert.ok(fs.existsSync(path.join(drafts, "文獻探討-碩論（選取）.md")));
	assert.equal(notion.pages.length, 2, "a separate Notion page for the selection");

	// Cancelled dialog: no request
	ZB.reviewDraft.runtime.ask = async () => null;
	collMenu.onCommand({}, { collectionTreeRows: [collectionRow] });
	await pending;
	assert.equal(log.filter(l => l.api === "anthropic").length, 3);

	// A single item is refused before anything is asked
	ZB.reviewDraft.runtime.ask = async () => { throw new Error("should not ask"); };
	await ZB.reviewDraft.run([a], { label: "x", collection: null }, {});
	assert.ok(env.descriptions.includes("文獻探討草稿至少需要 2 篇文獻。"));
	await vm.runInContext("shutdown()", env.context);
});
