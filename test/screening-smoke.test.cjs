// Review screening through the real plugin in a mocked Zotero: decisions from the item menu and
// the item pane, duplicate tagging, and the PRISMA note + CSV + Notion page for a collection.
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
const PARENT_PAGE = "https://www.notion.so/ws/Reviews-22222222222222222222222222222222";

// The parts of Zotero, Gecko and the plugin scope that screening touches
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
		getCollections() { return []; }
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

// A Notion workspace with pages made of blocks: create, list, insert after a block, delete, rename
function notionMock(log) {
	let pages = new Map();
	let blockID = 0;
	let ok = json => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(json) });
	let withText = (b) => {
		let rich = b[b.type] && b[b.type].rich_text;
		if (rich) rich.forEach((r) => { r.plain_text = r.text.content; });
		return b;
	};
	let fetch = async (url, init) => {
		let p = url.replace("https://api.notion.com/v1/", "");
		let body = init.body ? JSON.parse(init.body) : undefined;
		log.push({ method: init.method, path: p, body });
		if (p === "pages" && init.method === "POST") {
			let id = `rev-${pages.size + 1}`;
			let page = { id, url: `https://www.notion.so/${id}`, parent: body.parent, title: body.properties.title.title[0].text.content, icon: body.icon, children: [] };
			pages.set(id, page);
			return ok({ id, url: page.url });
		}
		let m;
		if ((m = /^pages\/([^/]+)$/.exec(p))) {
			let page = pages.get(m[1]);
			if (!page) return { status: 404, ok: false, headers: { get: () => null }, text: async () => JSON.stringify({ code: "object_not_found", message: "gone" }) };
			if (init.method === "PATCH") page.title = body.properties.title.title[0].text.content;
			return ok({ id: page.id, url: page.url, in_trash: !!page.in_trash });
		}
		if ((m = /^blocks\/([^/]+)\/children(\?.*)?$/.exec(p))) {
			let page = pages.get(m[1]);
			if (init.method === "GET") return ok({ results: page.children, has_more: false });
			let added = body.children.map(b => withText(Object.assign({ id: `b${++blockID}` }, b)));
			let at = body.after ? page.children.findIndex(b => b.id === body.after) + 1 : page.children.length;
			page.children.splice(at, 0, ...added);
			return ok({ results: added });
		}
		if ((m = /^blocks\/([^/]+)$/.exec(p)) && init.method === "DELETE") {
			for (let page of pages.values()) page.children = page.children.filter(b => b.id !== m[1]);
			return ok({ id: m[1], in_trash: true });
		}
		return { status: 404, ok: false, headers: { get: () => null }, text: async () => JSON.stringify({ message: p }) };
	};
	return { fetch, pages };
}

async function setup(opts = {}) {
	let vault = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-screening-"));
	let log = [];
	let notion = notionMock(log);
	let env = makeEnv({
		fetch: notion.fetch,
		confirm: opts.confirm,
		prefs: Object.assign({
			"extensions.zotero-bridge.obsidian.vaultPath": vault,
			"extensions.zotero-bridge.obsidian.folder": "Zotero",
			"extensions.zotero-bridge.notion.token": "ntn_test",
			"extensions.zotero-bridge.screening.notionParent": PARENT_PAGE,
		}, opts.prefs),
	});
	await vm.runInContext(`startup({ id: "zotero-bridge@bobyu89.github.io", version: "0.0.0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);
	return Object.assign(env, { vault, log, notion });
}

function paper(env, n, fields = {}) {
	return new env.MockItem("journalArticle", Object.assign({
		key: `PAPER${String(n).padStart(3, "0")}`,
		title: `Study ${n} of fall prevention in hospitals`,
		year: "2024",
		creators: [{ firstName: "Mei", lastName: `Author${n}`, creatorType: "author" }],
		libraryCatalog: "PubMed",
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

/** The 「Zotero Bridge ▸」 submenu of the item or collection menu (commands.js, menus.js). */
function zbMenu(env, menuID) {
	return env.menus.find(m => m.menuID === menuID).menus[0];
}

/** Item menu → Zotero Bridge ▸ 篩選所選文獻 ▸ */
function itemMenu(env) {
	return entry(zbMenu(env, "zotero-bridge-item"), "zotero-bridge-toolbar-screen");
}

function entry(menu, l10nID) {
	return menu.menus.find(m => m.l10nID === l10nID);
}

// Menu commands don't return their promise; wait for the saves to land
async function settle(check) {
	for (let i = 0; i < 200 && !check(); i++) await new Promise(r => setTimeout(r, 5));
	assert.ok(check(), "timed out");
}

test("item menu and item pane set screening decisions as tags; batch selections notify", async () => {
	let env = await setup();
	let [a, b, c] = [1, 2, 3].map(n => paper(env, n));
	let menu = itemMenu(env);
	assert.equal(menu.menuType, "submenu");
	assert.equal(menu.l10nID, "zotero-bridge-toolbar-screen");
	assert.ok(zbMenu(env, "zotero-bridge-item").icon.endsWith("content/icons/bridge.svg"));

	// Batch: three items → title/abstract include
	entry(menu, "zotero-bridge-screen-ta-include").onCommand({}, { items: [a, b, c] });
	await settle(() => c.tags.includes("篩選/標題摘要/納入"));
	assert.deepEqual([a, b, c].map(i => i.tags), [["篩選/標題摘要/納入"], ["篩選/標題摘要/納入"], ["篩選/標題摘要/納入"]]);
	assert.match(env.descriptions.at(-1), /標題摘要：納入：已更新 3 篇/);

	// Full-text exclusion: one slot per reason in the same submenu (two levels below the right-click
	// entry); the slots follow the settings
	env.prefStore["extensions.zotero-bridge.screening.reasons"] = "族群不符\n研究設計不符";
	let reasons = menu.menus.filter(m => m.l10nID === "zotero-bridge-cmd-screen-ft-exclude-reason");
	assert.ok(menu.menus.every(m => m.menuType !== "submenu"), "no third level");
	assert.equal(reasons.length, env.context.ZB.screening.MAX_MENU_REASONS);
	let shown = Array.from(reasons, (r) => {
		let state = {};
		r.onShowing({}, { setVisible: v => (state.visible = v), setL10nArgs: a => (state.args = a) });
		return state;
	});
	assert.deepEqual(shown.slice(0, 3), [
		{ visible: true, args: JSON.stringify({ reason: "族群不符" }) },
		{ visible: true, args: JSON.stringify({ reason: "研究設計不符" }) },
		{ visible: false },
	]);
	reasons[1].onCommand({}, { items: [b] });
	await settle(() => b.tags.includes("篩選/全文/排除"));
	assert.deepEqual(b.tags.slice().sort(), ["篩選/全文/排除", "篩選/標題摘要/納入", "排除原因/研究設計不符"].sort());
	// Changing the decision replaces the reason
	entry(menu, "zotero-bridge-screen-ft-include").onCommand({}, { items: [b] });
	await settle(() => b.tags.includes("篩選/全文/納入"));
	assert.deepEqual(b.tags.slice().sort(), ["篩選/全文/納入", "篩選/標題摘要/納入"].sort());
	entry(menu, "zotero-bridge-screen-clear").onCommand({}, { items: [b] });
	await settle(() => !b.tags.length);
	assert.deepEqual(env.errors, []);

	// Item pane: the AI-note section shows a 篩選 row with title/abstract buttons
	let dom = new JSDOM("<div id='body'></div>");
	let doc = dom.window.document;
	let body = doc.getElementById("body");
	let section = env.panes.find(p => p.paneID === "zotero-bridge-ai-note");
	section.onRender({ doc, body, item: a, setSectionSummary: () => {} });
	let row = [...body.querySelectorAll("div")].find(d => /^篩選：/.test(d.textContent));
	assert.ok(row, "screening row");
	assert.match(row.querySelector("span").textContent, /^篩選：標題摘要：納入$/);
	let exclude = [...row.querySelectorAll("button")].find(btn => btn.textContent === "排除");
	exclude.dispatchEvent(new dom.window.Event("click"));
	await settle(() => a.tags.includes("篩選/標題摘要/排除"));
	assert.deepEqual(a.tags, ["篩選/標題摘要/排除"]);
	await settle(() => row.querySelector("span").textContent === "篩選：標題摘要：排除");
	// An undecided item still gets the row once screening is in use (the tag exists in Zotero)
	let fresh = paper(env, 9);
	let body2 = doc.createElement("div");
	section.onRender({ doc, body: body2, item: fresh, setSectionSummary: () => {} });
	assert.ok([...body2.querySelectorAll("span")].some(s => s.textContent === "篩選：尚未篩選"));
	assert.deepEqual(env.errors, []);
});

test("item pane has no screening row before any screening", async () => {
	let env = await setup();
	let item = paper(env, 1);
	let doc = new JSDOM("").window.document;
	let body = doc.createElement("div");
	env.panes[0].onRender({ doc, body, item, setSectionSummary: () => {} });
	assert.ok(![...body.querySelectorAll("span")].some(s => /^篩選：/.test(s.textContent)));
});

test("duplicates: grouped by DOI and title + year, tagged after confirmation, never merged", async () => {
	let env = await setup();
	let a = paper(env, 1, { DOI: "10.1000/ABC", abstractNote: "Abstract", dateAdded: "2024-05-02 08:00:00" });
	let b = paper(env, 2, { extra: "PMID: 1\nDOI: https://doi.org/10.1000/abc", dateAdded: "2024-05-01 08:00:00" });
	let c = paper(env, 3, { title: "Study 1 of fall prevention in hospitals.", year: "2024" });
	let d = paper(env, 4, { title: "Unrelated", year: "2020" });
	let sub = paper(env, 5, { title: "Delirium in the ICU: a cohort", year: "2022" });
	let subDup = paper(env, 6, { title: "Delirium in the ICU — a cohort", year: "2022", tags: ["篩選/標題摘要/納入"] });
	let collection = env.addCollection(1, "跌倒 SR", [a, b, c, d]);
	env.addCollection(2, "子分類", [sub, subDup], 1);
	let result = await env.context.ZB.screening.dedupCollection(collection);
	assert.deepEqual({ ...result }, { groups: 2, tagged: 3 });
	assert.equal(env.confirms.length, 1);
	assert.match(env.confirms[0], /「跌倒 SR」中找到 2 組可能重複的文獻/);
	assert.match(env.confirms[0], /「Study 1 of fall prevention in hospitals」（2024） ← 2 筆（DOI 相同、標題與年份相同）/);
	assert.match(env.confirms[0], /重覆的項目」（Duplicate Items）/);
	// The record with an abstract (a) and the screened one (subDup) are kept
	assert.deepEqual([a, b, c, d, sub, subDup].map(i => i.tags.includes("篩選/重複")), [false, true, true, false, true, false]);
	assert.equal(env.items.size, 6, "nothing merged or deleted");
	// Running again finds the same groups already tagged
	let again = await env.context.ZB.screening.dedupCollection(collection);
	assert.deepEqual({ ...again }, { groups: 2, tagged: 0 });
	assert.equal(env.confirms.length, 1);
	// Declining the confirmation tags nothing
	let env2 = await setup({ confirm: () => false });
	let x = paper(env2, 1, { DOI: "10.1000/x" });
	let y = paper(env2, 2, { DOI: "10.1000/x" });
	assert.deepEqual({ ...await env2.context.ZB.screening.dedupCollection(env2.addCollection(1, "R", [x, y])) }, { groups: 1, tagged: 0 });
	assert.deepEqual([x.tags, y.tags], [[], []]);
});

test("PRISMA note, CSV and Notion page for a collection; a rerun keeps the user's content", async () => {
	let env = await setup();
	let ZB = env.context.ZB;
	let inc1 = paper(env, 1, { tags: ["篩選/標題摘要/納入", "篩選/全文/納入", "來源/CINAHL"], DOI: "10.1000/one" });
	let inc2 = paper(env, 2, { tags: ["篩選/標題摘要/納入", "篩選/全文/納入"], libraryCatalog: "" });
	let exc = paper(env, 3, { tags: ["篩選/標題摘要/納入", "篩選/全文/排除", "排除原因/族群不符（wrong population）"] });
	let taEx = paper(env, 4, { tags: ["篩選/標題摘要/排除"] });
	let dup = paper(env, 5, { tags: ["篩選/重複"] });
	let pending = paper(env, 6, { tags: [] });
	let noReason = paper(env, 7, { tags: ["篩選/全文/排除"] });
	addAINote(env, inc1, {
		study_design: "RCT", sample_size: 120, setting: "內科病房", country: "Taiwan", population: "65 歲以上住院病人",
		intervention: "Tai chi, balance", comparison: "常規照護", outcomes: "跌倒發生率", measures: ["Morse Fall Scale"],
		evidence_level: "2", jbi_level: "1.c", appraisal_tool: "JBI Checklist for RCTs", appraisal_overall: "納入",
	});
	// inc1 already has a literature note in the vault: the evidence table links to it
	let litDir = path.join(env.vault, "Zotero", "碩論");
	fs.mkdirSync(litDir, { recursive: true });
	fs.writeFileSync(path.join(litDir, "author12024.md"), `---\ntitle: "x"\nzotero_key: "library/${inc1.key}"\n---\n# x\n`);
	let collection = env.addCollection(1, "跌倒預防 SR", [inc1, inc2, exc, taEx, dup, pending, noReason]);

	// Collection menu → Zotero Bridge ▸ 產生 PRISMA 流程圖與證據表（目前分類）
	let collMenu = zbMenu(env, "zotero-bridge-collection");
	let visible;
	collMenu.onShowing({}, { collectionTreeRows: [], setVisible: v => (visible = v) });
	assert.equal(visible, false);
	entry(collMenu, "zotero-bridge-screen-tools-prisma").onCommand({}, { collectionTreeRows: [{ isCollection: () => true, ref: collection }] });
	await ZB.main.enqueue(() => {});
	assert.deepEqual(env.errors, []);
	let line = env.progressLines.at(-1);
	assert.equal(line.error, undefined, line.text);
	assert.equal(line.text, "辨識 7 → 重複 1 → 篩選 6 → 全文評估 4 → 納入 2");
	assert.ok(env.descriptions.some(d => /⚠️ 一致性檢查有 2 項問題/.test(d)), env.descriptions.join("\n"));

	let notePath = path.join(env.vault, "Zotero", "Reviews", "跌倒預防 SR.md");
	let note = fs.readFileSync(notePath, "utf8");
	assert.match(note, /^---\ntitle: "跌倒預防 SR：篩選與 PRISMA 2020"\ntype: "review-screening"\nzotero_collection: "library\/collections\/COLL1"\n/);
	assert.match(note, /prisma_identified: 7\n/);
	assert.match(note, /prisma_included: 2\n/);
	assert.match(note, /evidence_csv: "Zotero\/Reviews\/跌倒預防 SR 證據表\.csv"\n/);
	assert.match(note, /notion: "https:\/\/www\.notion\.so\/rev-1"\n/);
	assert.match(note, /Records identified from databases and registers<br\/>\(n = 7\)<br\/>PubMed \(n = 5\)<br\/>CINAHL \(n = 1\)<br\/>未標示來源 \(n = 1\)/);
	assert.ok(note.includes("| [[Zotero/碩論/author12024\\|Author1, 2024]] | RCT | 120 | 內科病房；Taiwan | 65 歲以上住院病人 | Tai chi, balance；對照：常規照護 | 跌倒發生率 | CEBM 2；JBI 1.c | 納入（JBI Checklist for RCTs） |"));
	assert.ok(note.includes("| Author2, 2024 | （無結構化資料） |"));
	assert.match(note, /⚠️ 有全文決定，但標題摘要不是「納入」.*（1 筆）：\[Study 7 of fall prevention in hospitals\]\(zotero:\/\/select\/library\/items\/PAPER007\)/);
	assert.match(note, /ℹ️ 納入研究還沒有 AI 筆記的結構化資料.*（1 筆）：\[Study 2/);
	assert.ok(note.endsWith("%% zotero-bridge:end %%\n\n## ✍️ 我的筆記\n\n"));

	let csv = fs.readFileSync(path.join(env.vault, "Zotero", "Reviews", "跌倒預防 SR 證據表.csv"));
	assert.deepEqual([...csv.subarray(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 BOM for Excel");
	let csvLines = csv.toString("utf8").slice(1).split("\r\n");
	assert.equal(csvLines.length, 4);
	assert.ok(csvLines[1].startsWith("\"Author1, 2024\",\"Author1, Mei\",2024,Study 1 of fall prevention in hospitals,,10.1000/one,RCT,120,"), csvLines[1]);

	// Notion: a child page of the configured parent with real tables and a Mermaid diagram
	let page = env.notion.pages.get("rev-1");
	assert.deepEqual(page.parent, { type: "page_id", page_id: "22222222-2222-2222-2222-222222222222" });
	assert.equal(page.title, "PRISMA 2020：跌倒預防 SR");
	assert.equal(page.children[0].paragraph.rich_text[0].text.content, ZB.screening.NOTION_ANCHOR);
	assert.equal(page.children.at(-1).heading_2.rich_text[0].text.content, "✍️ 我的筆記");
	assert.equal(page.children.find(b => b.type === "code").code.language, "mermaid");
	assert.equal(page.children.filter(b => b.type === "table").length, 2);
	assert.doesNotMatch(JSON.stringify(page.children), /\[\[Zotero\//, "no wikilinks in Notion");
	assert.equal(env.prefStore["extensions.zotero-bridge.screening.notionPages"], JSON.stringify({ "library/collections/COLL1": "rev-1" }));

	// The user adds notes in Obsidian and Notion, then screens more and regenerates (Tools menu)
	fs.writeFileSync(notePath, note.replace("type: \"review-screening\"", "type: \"review-screening\"\nreviewer2: \"Lin\"")
		.replace("## ✍️ 我的筆記\n\n", "## ✍️ 我的筆記\n\n與第二位審查者討論\n"));
	page.children.push({ id: "user-1", type: "paragraph", paragraph: { rich_text: [{ plain_text: "我的 Notion 筆記", text: { content: "我的 Notion 筆記" } }] } });
	pending.tags.push("篩選/標題摘要/排除");
	noReason.tags.push("篩選/標題摘要/納入", "排除原因/語言不符（language）");
	env.setActiveCollection(collection);
	// Again from the toolbar button or 快速指令: the selected collection
	ZB.commands.execute("prisma");
	await ZB.main.enqueue(() => {});
	assert.deepEqual(env.errors, []);
	let note2 = fs.readFileSync(notePath, "utf8");
	assert.match(note2, /reviewer2: "Lin"/);
	assert.match(note2, /與第二位審查者討論\n$/);
	assert.match(note2, /prisma_excluded_screening: 2\n/);
	assert.match(note2, /- ✅ 計數一致，沒有發現問題。|ℹ️/);
	assert.doesNotMatch(note2, /⚠️/);
	assert.equal(note2.match(/zotero-bridge:start/g).length, 1);
	assert.equal(env.notion.pages.size, 1, "the same Notion page is updated");
	assert.equal(page.children[0].paragraph.rich_text[0].text.content, ZB.screening.NOTION_ANCHOR);
	assert.deepEqual(page.children.slice(-2).map(b => b.id === "user-1" ? "user" : b.type), ["heading_2", "user"]);
	assert.equal(page.children.filter(b => b.type === "code").length, 1, "old blocks were replaced");
	assert.match(JSON.stringify(page.children), /語言不符（language） \(n = 1\)/);
	// Blocks went in right after the anchor (no position API needed)
	assert.ok(env.log.filter(l => l.method === "PATCH" && /^blocks\/rev-1\/children$/.test(l.path)).slice(-1)[0].body.after);

	// The Notion page was deleted: a new one is made
	env.notion.pages.get("rev-1").in_trash = true;
	await ZB.screening.generateReport(collection);
	assert.equal(env.notion.pages.size, 2);
	assert.match(fs.readFileSync(notePath, "utf8"), /notion: "https:\/\/www\.notion\.so\/rev-2"\n/);
	assert.deepEqual(env.errors, []);

	// The user deleted the 「✍️ 我的筆記」 heading: nothing is guessed away, a new page is made
	let rev2 = env.notion.pages.get("rev-2");
	rev2.children = rev2.children.filter(b => b.type !== "heading_2" || !/我的筆記/.test(b.heading_2.rich_text[0].text.content));
	let before = rev2.children.length;
	await ZB.screening.generateReport(collection);
	assert.equal(env.notion.pages.size, 3);
	assert.equal(rev2.children.length, before);
	assert.deepEqual(env.errors, []);
});

test("PRISMA without a selected collection or settings explains what is missing", async () => {
	let env = await setup({ prefs: { "extensions.zotero-bridge.obsidian.vaultPath": "", "extensions.zotero-bridge.screening.notionParent": "" } });
	await env.context.ZB.commands.execute("prisma");
	assert.match(env.descriptions.at(-1), /請先在左側選取系統性回顧的分類/);
	let collection = env.addCollection(1, "R", [paper(env, 1)]);
	assert.equal(await env.context.ZB.screening.generateReport(collection), null);
	assert.match(env.descriptions.at(-1), /請先到 設定 → Zotero Bridge 填入 Obsidian vault 路徑/);
});
