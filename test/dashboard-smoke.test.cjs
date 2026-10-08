// Research dashboard through the real plugin in a mocked Zotero: rebuilt after a manual sync and
// from the Tools menu, user content and .base files kept, never failing a sync.
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

// The parts of Zotero, Gecko and the plugin scope that a sync and the dashboard touch (copied from screening-smoke)
function makeEnv({ prefs, fetch, confirm = () => true }) {
	let items = new Map();
	let nextID = 100;
	let menus = [];
	let panes = [];
	let progressLines = [];
	let descriptions = [];
	let errors = [];
	let saves = [];
	let confirms = [];
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
		Libraries: { get: () => ({ libraryType: "user", name: "My Library" }), getAll: () => [] },
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
			prompt: { confirm: (win, title, text) => { confirms.push(text); return confirm(text); } },
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
		context, MockItem, items, menus, panes, progressLines, descriptions, errors, saves, confirms, prefStore, addCollection,
		setActiveCollection: (c) => { activeCollection = c; },
	};
}

async function setup(opts = {}) {
	let vault = opts.vault === null ? "" : await fsp.mkdtemp(path.join(os.tmpdir(), "zb-dashboard-"));
	// The dashboard never goes online; any request is a failure
	let requests = [];
	let fetch = async (url) => {
		requests.push(url);
		throw new Error(`unexpected request ${url}`);
	};
	let env = makeEnv({
		fetch,
		prefs: Object.assign({
			"extensions.zotero-bridge.obsidian.vaultPath": vault,
			"extensions.zotero-bridge.obsidian.folder": "Zotero",
		}, opts.prefs),
	});
	await vm.runInContext(`startup({ id: "zotero-bridge@bobyu89.github.io", version: "0.0.0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);
	return Object.assign(env, { vault, requests });
}

// "YYYY-MM-DD HH:MM:SS" in UTC, as Zotero stores dateAdded
function zoteroDate(daysAgo) {
	return new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 19).replace("T", " ");
}

function paper(env, n, fields = {}) {
	return new env.MockItem("journalArticle", Object.assign({
		key: `PAPER${String(n).padStart(3, "0")}`,
		title: `Study ${n} of fall prevention in hospitals`,
		year: "2024",
		DOI: `10.1000/${n}`,
		creators: [{ firstName: "Mei", lastName: `Author${n}`, creatorType: "author" }],
	}, fields));
}

// The AI note as main.js stores it: heading, byline, the note, then the structured-data block
function addAINote(env, item, study) {
	let ZB = env.context.ZB;
	let note = new env.MockItem("note", { tags: ["zotero-bridge-ai"] });
	note.parentID = item.id;
	item.children.push(note.id);
	note.setNote(`<h1>🤖 AI 文獻筆記</h1>\n<p><em>由 test-model 於 2026-10-01T00:00:00Z 產生（Zotero Bridge）</em></p>\n`
		+ ZB.markdown.mdToHtml(`## 一句話摘要\n\nA summary.\n\n${ZB.llm.studyDataBlock(ZB.llm.normalizeStudyData(study))}`));
	return note;
}

function library(env) {
	env.addCollection(1, "碩論", []);
	env.addCollection(2, "跌倒", [], 1);
	let a = paper(env, 1, { collectionIDs: [2], dateAdded: zoteroDate(2) });
	addAINote(env, a, { study_design: "RCT", sample_size: 120, evidence_level: "2", appraisal_overall: "納入" });
	let b = paper(env, 2, {
		title: "長期照護機構住民跌倒預防之成效", DOI: "", collectionIDs: [2], dateAdded: "2024-01-05 00:00:00",
		creators: [{ name: "王", creatorType: "author" }, { lastName: "陳", firstName: "美玲", creatorType: "author" }],
	});
	let c = paper(env, 3, { DOI: "", dateAdded: "2025-02-01 00:00:00" });
	return [a, b, c];
}

function dashboardPath(env) {
	return path.join(env.vault, "Zotero", "研究儀表板.md");
}

function toolsEntry(env) {
	let menu = env.menus.find(m => m.menuID === "zotero-bridge-dashboard-tools");
	assert.equal(menu.target, "main/menubar/tools");
	return menu.menus[0];
}

async function settle(check) {
	for (let i = 0; i < 400 && !check(); i++) await new Promise(r => setTimeout(r, 5));
	assert.ok(check(), "timed out");
}

test("a manual sync writes the dashboard and its .base; the Tools menu rebuilds it keeping the user's content", async () => {
	let env = await setup();
	let ZB = env.context.ZB;
	let items = library(env);
	await ZB.main.run(items, { targets: ["obsidian"], ai: "reuse" });
	assert.deepEqual(env.errors, []);

	let text = fs.readFileSync(dashboardPath(env), "utf8");
	assert.match(text, /^---\ntype: "research-dashboard"\nupdated: "[^"]+"\n---\n\n# 研究儀表板\n\n%% zotero-bridge:start/);
	assert.match(text, /共 \*\*3\*\* 篇文獻，已讀完成率 \*\*0%\*\*/);
	assert.match(text, /```mermaid\npie showData\n {4}title 閱讀狀態\n {4}"待讀" : 3\n```/);
	assert.match(text, /\| 碩論\/跌倒 \| 2 \| 2 \| 0 \| 0 \| 0 \| 0% \|/);
	assert.match(text, /\| （未分類） \| 1 \|/);
	assert.match(text, /\| RCT \| 1 \|/);
	assert.match(text, /有 AI 文獻筆記：\*\*1\*\* 篇；沒有：\*\*2\*\* 篇/);
	// Oldest unread first, with links to the notes
	let unread = text.slice(text.indexOf("### 待讀最久"), text.indexOf("### ⚠️ 資料品質"));
	assert.deepEqual([...unread.matchAll(/\[\[([^|\]]+)\|/g)].map(m => m[1]), [
		"Zotero/王 2024 - 長期照護機構住民跌倒預防之成效",
		"Zotero/Author3 2024 - Study 3 of fall prevention in hospitals",
		"Zotero/Author1 2024 - Study 1 of fall prevention in hospitals",
	]);
	assert.match(text, /中文作者姓名可疑（王）/);
	assert.match(text, /無 AI 筆記 2 · 掃描檔待 OCR 0 · 期刊文章缺 DOI 2 · 中文作者姓名可疑 1/);
	assert.match(text, /這 7 天新增 \*\*1\*\* 篇：\n\n- \[\[Zotero\/Author1 2024 - Study 1 of fall prevention in hospitals\|Study 1 of fall prevention in hospitals\]\]/);
	assert.match(text, /近 3 個月沒有 AI 呼叫紀錄/);
	assert.match(text, /還沒有回顧專案/);
	// Every linked note exists
	for (let [, target] of text.matchAll(/\[\[([^|\]]+)[|\]]/g)) {
		assert.ok(fs.existsSync(path.join(env.vault, target.endsWith(".base") ? target : target + ".md")), target);
	}
	let basePath = path.join(env.vault, "Zotero", "研究儀表板.base");
	assert.equal(fs.readFileSync(basePath, "utf8"), ZB.dashboard.buildDashboardBase());
	assert.ok(fs.existsSync(path.join(env.vault, "Zotero", "Zotero 文獻庫.base")));

	// The user writes in the note and edits the .base; a review, a draft and AI usage appear
	fs.writeFileSync(dashboardPath(env), text.replace("# 研究儀表板\n", "# 研究儀表板\n\n我的目標：12 月前讀完。\n") + "今天的心得。\n");
	fs.writeFileSync(basePath, "views:\n  - type: table\n    name: 我改過的\n");
	fs.mkdirSync(path.join(env.vault, "Zotero", "Reviews"));
	fs.writeFileSync(path.join(env.vault, "Zotero", "Reviews", "跌倒.md"), ZB.screening.buildReviewNote(null, {
		title: "跌倒：篩選與 PRISMA 2020", type: "review-screening", prisma_identified: 40, prisma_screened: 35,
		prisma_assessed: 10, prisma_included: 6, prisma_awaiting_screening: 0, prisma_awaiting_fulltext: 0, last_generated: "2026-10-01T00:00:00Z",
	}, "跌倒：篩選與 PRISMA 2020", "section"));
	fs.mkdirSync(path.join(env.vault, "Zotero", "Drafts"));
	fs.writeFileSync(path.join(env.vault, "Zotero", "Drafts", "文獻探討-跌倒.md"),
		"---\ntype: \"lit-review-draft\"\nsources:\n  - \"library/PAPER001\"\n  - \"library/PAPER002\"\ngenerated_at: \"2026-10-02T00:00:00Z\"\n---\n\n# 文獻探討：跌倒\n");
	let ledger = ZB.usage.recordUsage({}, { model: "test-model", usage: { input: 1000000, output: 0 } });
	env.prefStore["extensions.zotero-bridge.usage.ledger"] = JSON.stringify(ledger);
	env.prefStore["extensions.zotero-bridge.usage.prices"] = JSON.stringify({ "test-model": { input: 1, output: 5 } });
	// Reading progress changed in Obsidian
	let notePath = path.join(env.vault, "Zotero", "Author1 2024 - Study 1 of fall prevention in hospitals.md");
	fs.writeFileSync(notePath, fs.readFileSync(notePath, "utf8").replace("status: \"待讀\"", "status: \"已讀\""));

	let before = env.descriptions.length;
	toolsEntry(env).onCommand();
	await settle(() => env.descriptions.length > before);
	assert.match(env.descriptions.at(-1), /^已更新 Zotero\/研究儀表板\.md：3 篇文獻，已讀完成率 33%，待讀 2 篇，2 篇有資料品質問題。$/);
	let again = fs.readFileSync(dashboardPath(env), "utf8");
	assert.match(again, /# 研究儀表板\n\n我的目標：12 月前讀完。\n/);
	assert.match(again, /## ✍️ 我的筆記\n\n今天的心得。\n$/);
	assert.equal(again.split("%% zotero-bridge:start").length, 2);
	assert.match(again, /"已讀" : 1/);
	assert.match(again, /- \[\[Zotero\/Reviews\/跌倒\|跌倒：篩選與 PRISMA 2020\]\]：納入 \*\*6\*\* 篇（辨識 40 → 篩選 35 → 全文評估 10） · 更新於 2026-10-01/);
	assert.match(again, /- \[\[Zotero\/Drafts\/文獻探討-跌倒\|文獻探討-跌倒\]\]：2 篇文獻 · 產生於 2026-10-02/);
	assert.match(again, /（本月） \| 1 \| 1,000,000 \| US\$1\.00 \|/);
	// The user's .base is never overwritten
	assert.equal(fs.readFileSync(basePath, "utf8"), "views:\n  - type: table\n    name: 我改過的\n");
	assert.deepEqual(env.requests, []);
	assert.deepEqual(env.errors, []);
});

test("only manual runs with the setting on rebuild it, and a failing dashboard never fails the sync", async () => {
	let env = await setup();
	let ZB = env.context.ZB;
	let [a, b] = library(env);
	// Auto-sync is silent: no dashboard
	await ZB.main.run([a], { targets: ["obsidian"], ai: "reuse", silent: true });
	assert.ok(fs.existsSync(path.join(env.vault, "Zotero", "Author1 2024 - Study 1 of fall prevention in hospitals.md")));
	assert.ok(!fs.existsSync(dashboardPath(env)));
	// Setting off
	env.prefStore["extensions.zotero-bridge.dashboard.autoUpdate"] = false;
	await ZB.main.run([a], { targets: ["obsidian"], ai: "reuse" });
	assert.ok(!fs.existsSync(dashboardPath(env)));
	// The Bases setting off: the note but no .base files
	env.prefStore["extensions.zotero-bridge.dashboard.autoUpdate"] = true;
	env.prefStore["extensions.zotero-bridge.obsidian.createBase"] = false;
	await ZB.main.run([a], { targets: ["obsidian"], ai: "reuse" });
	assert.ok(fs.existsSync(dashboardPath(env)));
	assert.ok(!fs.existsSync(path.join(env.vault, "Zotero", "研究儀表板.base")));
	assert.ok(!/Bases 檢視/.test(fs.readFileSync(dashboardPath(env), "utf8")));
	assert.deepEqual(env.errors, []);

	// The dashboard can't be written (a folder in its place): logged, the sync still succeeds
	fs.rmSync(dashboardPath(env));
	fs.mkdirSync(dashboardPath(env));
	await ZB.main.run([b], { targets: ["obsidian"], ai: "reuse" });
	assert.ok(fs.existsSync(path.join(env.vault, "Zotero", "王 2024 - 長期照護機構住民跌倒預防之成效.md")));
	assert.equal(env.errors.length, 1);
	assert.match(env.descriptions.at(-1), /^完成 1 筆$/);
	// Even if the dashboard module itself throws, main.js catches it
	ZB.dashboard.afterSync = async () => { throw new Error("boom"); };
	await ZB.main.run([b], { targets: ["obsidian"], ai: "reuse" });
	assert.equal(env.errors.length, 2);
	assert.equal(env.errors[1].message, "boom");
	assert.match(env.descriptions.at(-1), /^完成 1 筆$/);
	assert.deepEqual(env.requests, []);
});

test("Tools menu without a vault asks for the vault path", async () => {
	let env = await setup({ vault: null });
	let before = env.descriptions.length;
	toolsEntry(env).onCommand();
	await settle(() => env.descriptions.length > before);
	assert.match(env.descriptions.at(-1), /請先到 設定 → Zotero Bridge 填入 Obsidian vault 路徑/);
	assert.deepEqual(env.errors, []);
});
