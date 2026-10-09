// Concept hub notes (概念卡片) through the real plugin in a mocked Zotero: built after a manual sync and
// from the toolbar button or 快速指令, user content kept, cards never deleted, never failing a sync, the dashboard's
// 熱門概念 section, and the per-concept AI synthesis (request shape, [S#] citations, ledger).
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

// The parts of Zotero, Gecko and the plugin scope that a sync and the dashboard touch (copied from dashboard-smoke)
function makeEnv({ prefs, fetch, confirm = () => true, select = () => 0 }) {
	let items = new Map();
	let nextID = 100;
	let menus = [];
	let panes = [];
	let progressLines = [];
	let descriptions = [];
	let errors = [];
	let saves = [];
	let confirms = [];
	let selects = [];
	let knownTags = new Set();

	class MockItem {
		constructor(type, fields = {}) {
			this.id = nextID++;
			this.key = fields.key || `KEY${this.id}`;
			this.itemType = type;
			this.libraryID = 1;
			this.deleted = false;
			this.parentID = null;
			this.fields = fields;
			this.tags = (fields.tags || []).slice();
			this.children = [];
			this.noteHTML = "";
			this.dateAdded = fields.dateAdded || "2024-05-01 08:00:00";
			items.set(this.id, this);
		}
		get parentItem() { return this.parentID ? items.get(this.parentID) : undefined; }
		isRegularItem() { return !["note", "attachment", "annotation"].includes(this.itemType); }
		isNote() { return this.itemType === "note"; }
		getField(f) { return this.fields[f] || ""; }
		getCreatorsJSON() { return this.fields.creators || []; }
		getTags() { return this.tags.map(tag => ({ tag })); }
		addTag(t) {
			if (this.tags.includes(t)) return false;
			this.tags.push(t);
			return true;
		}
		removeTag(t) {
			let had = this.tags.includes(t);
			this.tags = this.tags.filter(x => x !== t);
			return had;
		}
		getCollections() { return (this.fields.collectionIDs || []).slice(); }
		getAttachments() { return this.children.filter(id => items.get(id).itemType === "attachment"); }
		getNotes() { return this.children.filter(id => items.get(id).itemType === "note"); }
		getNote() { return this.noteHTML; }
		setNote(h) { this.noteHTML = h; }
		getItemTypeIconName() { return this.itemType; }
		async saveTx() {
			saves.push(this.id);
			for (let t of this.tags) knownTags.add(t);
			return this.id;
		}
	}

	let collections = new Map();
	let prefStore = Object.assign({}, prefs);
	let activeCollection = null;
	let Zotero = {
		Prefs: { get: k => prefStore[k], set: (k, v) => { prefStore[k] = v; }, clear: (k) => { delete prefStore[k]; } },
		MenuManager: { registerMenu: (o) => { menus.push(o); return o.menuID; }, unregisterMenu: () => true },
		Notifier: { registerObserver: () => "obs", unregisterObserver: () => {} },
		ItemPaneManager: { registerSection: (o) => { panes.push(o); return o.paneID; }, unregisterSection: () => true },
		PreferencePanes: { register: async () => "pane" },
		getMainWindows: () => [],
		getMainWindow: () => ({}),
		// zoteroPane.js: getSelectedCollections()
		getActiveZoteroPane: () => ({ getSelectedCollections: () => (activeCollection ? [activeCollection] : []) }),
		Items: {
			get: ids => (Array.isArray(ids) ? ids.map(id => items.get(id)) : items.get(ids)),
			exists: id => items.has(id),
			getByLibraryAndKey: (libraryID, key) => [...items.values()].find(i => i.libraryID === libraryID && i.key === key) || false,
			getAll: async () => [],
		},
		Libraries: { userLibraryID: 1, get: () => ({ libraryType: "user", name: "My Library" }), getAll: () => [] },
		Groups: { getGroupIDFromLibraryID: () => null },
		Collections: {
			get: ids => (Array.isArray(ids) ? ids.map(id => collections.get(id)) : collections.get(ids)),
			getByParent: id => [...collections.values()].filter(c => c.parentID === id),
		},
		// tags.js: getID(name) → tagID, or false when no item has ever had the tag
		Tags: { getID: name => (knownTags.has(name) ? 1 : false) },
		Styles: { get: () => null },
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

	function addCollection(id, name, members, parentID = null) {
		let c = {
			id, key: `COLL${id}`, name, libraryID: 1, parentID,
			getChildItems: () => members.map(i => items.get(i.id)).filter(i => !i.deleted),
		};
		collections.set(id, c);
		return c;
	}

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
		move: async (from, to) => fsp.rename(from, to),
	};
	let PathUtils = { join: (...parts) => path.join(...parts), filename: p => path.basename(p), parent: p => path.dirname(p) };
	let logins = [];
	let context = vm.createContext({
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
		// Notion's rate limiting waits for real; keep the test fast
		setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
		clearTimeout,
		Services: {
			scriptloader: {
				loadSubScript: (url) => {
					let file = url.replace("file://", "");
					vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
				},
			},
			prompt: {
				confirm: (win, title, text) => { confirms.push(text); return confirm(text); },
				// Services.prompt.select: the chosen index goes into out.value; null = cancel
				select: (win, title, text, labels, out) => {
					selects.push({ text, labels });
					let i = select(labels);
					if (i === null) return false;
					out.value = i;
					return true;
				},
			},
			logins: {
				searchLoginsAsync: async m => logins.filter(l => Object.entries(m).every(([k, v]) => l[k] === v)),
				addLoginAsync: async (l) => { logins.push(l); return l; },
				modifyLoginAsync: async (old, l) => { logins[logins.indexOf(old)] = l; },
				removeLoginAsync: async (old) => { logins.splice(logins.indexOf(old), 1); },
			},
		},
	});
	vm.runInContext(fs.readFileSync(path.join(ROOT, "bootstrap.js"), "utf8"), context, { filename: "bootstrap.js" });
	return {
		context, MockItem, items, menus, panes, progressLines, descriptions, errors, saves, confirms, selects, prefStore, addCollection,
		setActiveCollection: (c) => { activeCollection = c; },
	};
}

const AI_ANSWER = `## 定義與內涵
自我效能是相信自己能完成特定行為的信念 [S1]。

## 測量方式
多以量表測量，介入後分數提升 12.5 分 [S1]，另一研究為 40 分 [S2]。

## 研究缺口
缺少長期追蹤 [S7]。

## 參考文獻
- 不應出現
`;

function claude(log) {
	let ok = json => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(json) });
	return async (url, init) => {
		let body = init && init.body ? JSON.parse(init.body) : undefined;
		log.push({ url, body, headers: init && init.headers });
		if (url.startsWith("https://api.anthropic.com/")) {
			return ok({ model: "test-model", stop_reason: "end_turn", content: [{ type: "text", text: AI_ANSWER }], usage: { input_tokens: 20000, output_tokens: 3000 } });
		}
		throw new Error(`unexpected request ${url}`);
	};
}

async function setup(opts = {}) {
	let vault = opts.vault === null ? "" : await fsp.mkdtemp(path.join(os.tmpdir(), "zb-concepts-"));
	let requests = [];
	let env = makeEnv({
		fetch: claude(requests),
		select: opts.select,
		confirm: opts.confirm,
		prefs: Object.assign({
			"extensions.zotero-bridge.obsidian.vaultPath": vault,
			"extensions.zotero-bridge.obsidian.folder": "Zotero",
			"extensions.zotero-bridge.obsidian.createBase": false,
			"extensions.zotero-bridge.llm.provider": "anthropic",
			"extensions.zotero-bridge.llm.anthropicModel": "test-model",
			"extensions.zotero-bridge.usage.prices": JSON.stringify({ "test-model": { input: 1, output: 5 } }),
		}, opts.prefs),
	});
	await vm.runInContext(`startup({ id: "zotero-bridge@bobyu89.github.io", version: "0.0.0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);
	return Object.assign(env, { vault, requests });
}

function paper(env, n, fields = {}) {
	return new env.MockItem("journalArticle", Object.assign({
		key: `PAPER${String(n).padStart(3, "0")}`,
		title: `Study ${n} of fall prevention`,
		year: String(2020 + n),
		citationKey: `author${n}`,
		creators: [{ firstName: "Mei", lastName: `Author${n}`, creatorType: "author" }],
	}, fields));
}

// The AI note as main.js stores it, with 關鍵概念 links and the structured-data block
function addAINote(env, item, concepts, study, extra = "") {
	let ZB = env.context.ZB;
	let note = new env.MockItem("note", { tags: ["zotero-bridge-ai"] });
	note.parentID = item.id;
	item.children.push(note.id);
	note.setNote(`<h1>🤖 AI 文獻筆記</h1>\n<p><em>由 test-model 於 2026-10-01T00:00:00Z 產生（Zotero Bridge）</em></p>\n`
		+ ZB.markdown.mdToHtml(`## 一句話摘要\n\n${item.fields.title} 的摘要。\n\n## 主要結果\n\n${extra || "沒有差異。"}\n\n## 關鍵概念\n\n`
			+ concepts.map(c => `- [[${c}]]：說明`).join("\n")
			+ `\n\n${ZB.llm.studyDataBlock(ZB.llm.normalizeStudyData(study))}`));
	return note;
}

function library(env) {
	let a = paper(env, 1);
	addAINote(env, a, ["Self-efficacy", "Fall prevention", "跌倒"], { study_design: "RCT", evidence_level: "2", measures: ["Morse Fall Scale"] }, "自我效能分數提升 12.5 分。");
	let b = paper(env, 2, { title: "長期照護機構住民跌倒預防" });
	addAINote(env, b, ["self efficacy", "Accidental Falls"], { study_design: "cohort", measures: ["Morse Fall Scale"] });
	let c = paper(env, 3);
	addAINote(env, c, ["自我效能"], {});
	let d = paper(env, 4);
	return [a, b, c, d];
}

function conceptDir(env) {
	return path.join(env.vault, "Zotero", "概念");
}

function read(env, name) {
	return fs.readFileSync(path.join(conceptDir(env), name), "utf8");
}

/** 更新概念卡片 and 為概念卡片產生 AI 綜整… as the toolbar button and 快速指令 run them (commands.js). */
function tools(env) {
	let C = env.context.ZB.commands;
	assert.deepEqual([C.get("concepts").l10n, C.get("concepts-ai").l10n], ["zotero-bridge-menu-concepts-update", "zotero-bridge-menu-concepts-ai"]);
	assert.deepEqual([C.get("concepts").group, C.get("concepts-ai").group], ["organize", "ai"]);
	return {
		update: { onCommand: () => C.execute("concepts") },
		ai: { onCommand: () => C.execute("concepts-ai") },
	};
}

async function settle(check) {
	for (let i = 0; i < 400 && !check(); i++) await new Promise(r => setTimeout(r, 5));
	assert.ok(check(), "timed out");
}

test("a manual sync writes the cards and the index; the dashboard links them; 快速指令 or the toolbar rebuilds keeping the user's text", async () => {
	let env = await setup();
	let ZB = env.context.ZB;
	let items = library(env);
	await ZB.main.run(items, { targets: ["obsidian"], ai: "reuse" });
	assert.deepEqual(env.errors, []);

	assert.deepEqual(fs.readdirSync(conceptDir(env)).sort(), [
		"Accidental Falls.md", "Fall prevention.md", "Morse Fall Scale.md", "Self-efficacy.md", "概念索引.md", "自我效能.md", "跌倒.md",
	]);
	let se = read(env, "Self-efficacy.md");
	assert.match(se, /^---\ntype: "concept"\nconcept: "Self-efficacy"\nconcept_types:\n {2}- "概念"\npapers: 2\naliases:\n {2}- "self efficacy"\nupdated: "[^"]+"\n---\n\n# Self-efficacy\n\n## 📖 我的定義\n/);
	assert.match(se, /\| \[\[Zotero\/author2\\\|長期照護機構住民跌倒預防\]\] \| 2022 \| cohort \| {2}\| 長期照護機構住民跌倒預防 的摘要。 \|\n\| \[\[Zotero\/author1\\\|Study 1 of fall prevention\]\] \| 2021 \| RCT \| 2 \| Study 1 of fall prevention 的摘要。 \|/);
	assert.match(se, /\[MeSH：Self-efficacy\]\(https:\/\/www\.ncbi\.nlm\.nih\.gov\/mesh\/\?term=Self-efficacy\)/);
	assert.match(se, /- \[\[Zotero\/概念\/Morse Fall Scale\|Morse Fall Scale\]\]（2 篇）/);
	assert.match(read(env, "Morse Fall Scale.md"), /concept_types:\n {2}- "測量工具"\npapers: 2/);
	let index = read(env, "概念索引.md");
	assert.match(index, /共 \*\*6\*\* 個概念，來自 \*\*3\*\* 篇文獻筆記。/);
	// Measures are drawn as stadiums; equal counts by name
	assert.match(index, /```mermaid\ngraph LR\n {4}c1\(\["Morse Fall Scale（2）"\]\)\n {4}c2\["Self-efficacy（2）"\]\n/);
	assert.match(index, /\n {4}c1 ---\|2\| c2\n/);
	// Every link in the cards and the index points to an existing note
	for (let name of fs.readdirSync(conceptDir(env))) {
		for (let [, target] of read(env, name).matchAll(/\[\[([^|\]\\]+)[\\|\]]/g)) {
			assert.ok(fs.existsSync(path.join(env.vault, target + ".md")), `${name} → ${target}`);
		}
	}
	// The dashboard (written after the cards) lists the top concepts and links the index
	let dashboard = fs.readFileSync(path.join(env.vault, "Zotero", "研究儀表板.md"), "utf8");
	assert.match(dashboard, /## 🧠 熱門概念\n\n\[\[Zotero\/概念\/概念索引\|概念索引\]\]：共 6 個概念；文獻數最多的 6 個：\n\n\[\[Zotero\/概念\/Morse Fall Scale\|Morse Fall Scale\]\]（2） · \[\[Zotero\/概念\/Self-efficacy\|Self-efficacy\]\]（2）/);

	// The user writes a definition and notes; aliases merge 自我效能 into Self-efficacy and the falls together
	let sePath = path.join(conceptDir(env), "Self-efficacy.md");
	fs.writeFileSync(sePath, se.replace(/> \[!note\] 用自己的話.*\n/, "Bandura 的定義。\n") + "我的想法。\n");
	let mine = path.join(conceptDir(env), "我的概念.md");
	fs.writeFileSync(mine, "# 我的概念\n\n自己寫的。\n");
	env.prefStore["extensions.zotero-bridge.concepts.aliases"] = "Self-efficacy = 自我效能\n跌倒 = Accidental Falls = falls";
	let before = env.descriptions.length;
	tools(env).update.onCommand();
	await settle(() => env.descriptions.length > before);
	assert.match(env.descriptions.at(-1), /^已更新 4 張概念卡片（\d+ 個檔案有變更），索引：Zotero\/概念\/概念索引\.md。最常見：Self-efficacy（3）、/);
	let again = fs.readFileSync(sePath, "utf8");
	assert.match(again, /papers: 3\naliases:\n {2}- "self efficacy"\n {2}- "自我效能"\n/);
	assert.match(again, /Bandura 的定義。\n/);
	assert.match(again, /我的想法。\n$/);
	assert.match(again, /\[\[Zotero\/author3\\\|Study 3 of fall prevention\]\] \| 2023/);
	assert.match(read(env, "跌倒.md"), /aliases:\n {2}- "Accidental Falls"\n {2}- "falls"\n/);
	// Cards no paper uses any more are kept and say so; the user's own note is untouched
	for (let gone of ["自我效能.md", "Accidental Falls.md"]) {
		let text = read(env, gone);
		assert.match(text, /papers: 0\n/);
		assert.match(text, /目前沒有文獻筆記提到這個概念/);
	}
	assert.equal(fs.readFileSync(mine, "utf8"), "# 我的概念\n\n自己寫的。\n");
	// Nothing changed: nothing is rewritten
	let stamp = fs.statSync(sePath).mtimeMs;
	before = env.descriptions.length;
	tools(env).update.onCommand();
	await settle(() => env.descriptions.length > before);
	assert.match(env.descriptions.at(-1), /（0 個檔案有變更）/);
	assert.equal(fs.statSync(sePath).mtimeMs, stamp);
	assert.deepEqual(env.requests, []);
	assert.deepEqual(env.errors, []);
});

test("only manual runs with the setting on build cards, and a failing concept update never fails the sync", async () => {
	let env = await setup({ prefs: { "extensions.zotero-bridge.dashboard.autoUpdate": false } });
	let ZB = env.context.ZB;
	let [a, b] = library(env);
	// Auto-sync is silent: no cards
	await ZB.main.run([a], { targets: ["obsidian"], ai: "reuse", silent: true });
	assert.ok(!fs.existsSync(conceptDir(env)));
	// Setting off
	env.prefStore["extensions.zotero-bridge.concepts.autoUpdate"] = false;
	await ZB.main.run([a], { targets: ["obsidian"], ai: "reuse" });
	assert.ok(!fs.existsSync(conceptDir(env)));
	// Other folder; no measures
	env.prefStore["extensions.zotero-bridge.concepts.autoUpdate"] = true;
	env.prefStore["extensions.zotero-bridge.concepts.folder"] = "Concepts/卡片";
	env.prefStore["extensions.zotero-bridge.concepts.measures"] = false;
	await ZB.main.run([a], { targets: ["obsidian"], ai: "reuse" });
	assert.deepEqual(fs.readdirSync(path.join(env.vault, "Zotero", "Concepts", "卡片")).sort(),
		["Fall prevention.md", "Self-efficacy.md", "概念索引.md", "跌倒.md"]);
	assert.deepEqual(env.errors, []);

	// The folder can't be written (a file in its place): logged, the sync still succeeds
	env.prefStore["extensions.zotero-bridge.concepts.folder"] = "blocked";
	fs.writeFileSync(path.join(env.vault, "Zotero", "blocked"), "not a folder");
	await ZB.main.run([b], { targets: ["obsidian"], ai: "reuse" });
	assert.ok(fs.existsSync(path.join(env.vault, "Zotero", "author2.md")));
	assert.equal(env.errors.length, 1);
	assert.match(env.descriptions.at(-1), /^完成 1 筆$/);
	// Even if the module itself throws, main.js catches it
	ZB.concepts.afterSync = async () => { throw new Error("boom"); };
	await ZB.main.run([b], { targets: ["obsidian"], ai: "reuse" });
	assert.equal(env.errors.length, 2);
	assert.equal(env.errors[1].message, "boom");
	assert.match(env.descriptions.at(-1), /^完成 1 筆$/);
	assert.deepEqual(env.requests, []);
});

test("no concepts yet: nothing is written; the command says so; without a vault it asks for one", async () => {
	let env = await setup({ prefs: { "extensions.zotero-bridge.concepts.measures": false } });
	let ZB = env.context.ZB;
	let d = paper(env, 4);
	await ZB.main.run([d], { targets: ["obsidian"], ai: "reuse" });
	assert.ok(!fs.existsSync(conceptDir(env)));
	let dashboard = fs.readFileSync(path.join(env.vault, "Zotero", "研究儀表板.md"), "utf8");
	assert.match(dashboard, /## 🧠 熱門概念\n\n還沒有概念卡片：Zotero Bridge 按鈕或快速指令 → 更新概念卡片/);
	let before = env.descriptions.length;
	tools(env).update.onCommand();
	await settle(() => env.descriptions.length > before);
	assert.match(env.descriptions.at(-1), /文獻筆記中還沒有概念/);
	assert.ok(!fs.existsSync(conceptDir(env)));

	let none = await setup({ vault: null });
	before = none.descriptions.length;
	tools(none).update.onCommand();
	await settle(() => none.descriptions.length > before);
	assert.match(none.descriptions.at(-1), /請先到 設定 → Zotero Bridge 填入 Obsidian vault 路徑/);
	assert.deepEqual(env.errors, []);
	assert.deepEqual(none.errors, []);
});

test("AI synthesis for a concept: pick from the most cited, cost confirm, [S#] request, card block with links, number check and ledger", async () => {
	let picked = [];
	let env = await setup({
		select: (labels) => {
			picked.push(labels);
			return labels.findIndex(l => l.startsWith("Self-efficacy"));
		},
		prefs: { "extensions.zotero-bridge.concepts.aliases": "Self-efficacy = 自我效能" },
	});
	let ZB = env.context.ZB;
	await env.context.ZB.secrets.set("anthropicKey", "sk-ant-test");
	let items = library(env);
	await ZB.main.run(items, { targets: ["obsidian"], ai: "reuse" });
	let sePath = path.join(conceptDir(env), "Self-efficacy.md");
	fs.writeFileSync(sePath, fs.readFileSync(sePath, "utf8") + "我的想法。\n");

	await tools(env).ai.onCommand();
	await settle(() => env.requests.length > 0 && env.progressLines.some(l => /已寫入/.test(l.text)));
	// Only concepts with at least 2 papers, most cited first
	assert.deepEqual([...picked[0]], ["Self-efficacy（3 篇）", "Morse Fall Scale（2 篇，測量工具）"]);
	assert.match(env.confirms.at(-1), /^將用 test-model 依 3 篇文獻為「Self-efficacy」產生 AI 綜整，會產生一次 API 費用。\n預估費用：約 US\$/);

	assert.equal(env.requests.length, 1);
	let req = env.requests[0];
	assert.equal(req.url, "https://api.anthropic.com/v1/messages");
	assert.equal(req.headers["x-api-key"], "sk-ant-test");
	assert.equal(req.body.model, "test-model");
	let system = req.body.system.map(b => b.text).join("\n");
	assert.match(system, /引用只能使用提供的代號 \[S1\]、\[S2\]/);
	let content = req.body.messages[0].content;
	let user = typeof content === "string" ? content : content.map(x => x.text || "").join("\n");
	assert.match(user, /^以下是 3 篇文獻（代號 S1、S2、S3）。/);
	// Newest first: S1 = Study 3, S2 = the long-term care study, S3 = Study 1 (its AI note and study data)
	assert.match(user, /<source id="S1">\n標題：Study 3 of fall prevention/);
	assert.match(user, /<source id="S3">\n標題：Study 1 of fall prevention\n年份：2021\n[\s\S]*<study_data>\n研究設計：RCT[\s\S]*自我效能分數提升 12\.5 分。/);
	assert.match(user, /<concept>\n名稱：Self-efficacy\n其他寫法：self efficacy、自我效能\n類型：概念\n<\/concept>/);

	let card = fs.readFileSync(sePath, "utf8");
	assert.match(card, /ai_synthesis: "[^"]+"\n/);
	assert.match(card, /%% zotero-bridge:end %%\n\n%% zotero-bridge:concept-ai:start[^\n]*\n\n## 🤖 AI 綜整（草稿）\n\n> \[!warning\] AI 草稿：由 test-model 於/);
	assert.match(card, /### 定義與內涵\n自我效能是相信自己能完成特定行為的信念 \[\[Zotero\/author3\|Author3, 2023\]\]。/);
	// The Chinese-titled item is cited in Chinese APA (apa-zh.js)
	assert.match(card, /另一研究為 40 分 \[\[Zotero\/author2\|Author2, M\.，2022\]\]。/);
	assert.match(card, /缺少長期追蹤 【⚠️ 未知來源 S7】。/);
	assert.doesNotMatch(card, /不應出現/);
	assert.match(card, /### 參考文獻\n/);
	assert.match(card, /> \[!warning\] 2 項需要回原文確認/);
	// 12.5 is in Study 1's note, but the sentence cites S1 (Study 3)
	assert.match(card, /中找不到 12\.5、40\n/);
	assert.doesNotMatch(card, /Pandoc/);
	assert.match(card, /concept-ai:end %%\n\n## ✍️ 我的筆記\n\n我的想法。\n$/);
	assert.match(env.descriptions.join("\n"), /查核清單有 2 項需要回原文確認/);
	// The ledger has the call
	let ledger = JSON.parse(env.prefStore["extensions.zotero-bridge.usage.ledger"]);
	let month = Object.values(ledger)[0];
	assert.equal(month.byModel["test-model"].calls, 1);
	assert.equal(month.byModel["test-model"].output, 3000);

	// A rebuild keeps the AI block
	await ZB.concepts.update(await ZB.main.readSettings());
	assert.match(fs.readFileSync(sePath, "utf8"), /## 🤖 AI 綜整（草稿）[\s\S]*我的想法。\n$/);

	// Cancelled at the list or at the cost: no request
	let cancelled = await setup({ select: () => null });
	await cancelled.context.ZB.secrets.set("anthropicKey", "sk-ant-test");
	await cancelled.context.ZB.main.run(library(cancelled), { targets: ["obsidian"], ai: "reuse" });
	await cancelled.context.ZB.concepts.synthesizeFromMenu();
	assert.equal(cancelled.selects.length, 1);
	let noCost = await setup({ confirm: () => false });
	await noCost.context.ZB.secrets.set("anthropicKey", "sk-ant-test");
	await noCost.context.ZB.main.run(library(noCost), { targets: ["obsidian"], ai: "reuse" });
	await noCost.context.ZB.concepts.synthesizeFromMenu();
	assert.equal(noCost.confirms.length, 1);
	assert.deepEqual([cancelled.requests, noCost.requests], [[], []]);
	assert.deepEqual([env.errors, cancelled.errors, noCost.errors], [[], [], []]);
});

test("AI synthesis needs an API key and two papers on one concept", async () => {
	let env = await setup();
	let before = env.descriptions.length;
	tools(env).ai.onCommand();
	await settle(() => env.descriptions.length > before);
	assert.match(env.descriptions.at(-1), /AI 綜整需要 LLM API key/);
	await env.context.ZB.secrets.set("anthropicKey", "sk-ant-test");
	let a = paper(env, 1);
	addAINote(env, a, ["Only once"], {});
	await env.context.ZB.main.run([a], { targets: ["obsidian"], ai: "reuse" });
	before = env.descriptions.length;
	await env.context.ZB.concepts.synthesizeFromMenu();
	assert.ok(env.descriptions.length > before);
	assert.match(env.descriptions.at(-1), /AI 綜整需要至少 2 篇文獻提到同一個概念/);
	assert.deepEqual(env.selects, []);
	assert.deepEqual(env.requests, []);
	assert.deepEqual(env.errors, []);
});
