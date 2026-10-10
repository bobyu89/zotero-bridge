// The ZotMax panel (content/sidepanel.js) through the real plugin in a mocked Zotero: the section it
// registers, its five parts for an item with an AI note, highlights, status, screening, appraisal and
// 自動分類 sub-collections, the empty states, live gating, the catalog commands run on [this item],
// an attachment shown as its parent, remembered open parts, refreshes on Notifier events, the links
// read from the literature note, and a shutdown that leaves nothing registered.
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
const P = "extensions.zotero-bridge.";

// Copied from features-smoke (pref observers that fire like Zotero's, long timers collected), plus
// attachments with annotations, collections with parents, a Notifier that keeps its observers, the
// reader and launchURL recorded, and one main window for the stylesheet
function makeEnv({ prefs, fetch }) {
	let items = new Map();
	let collections = new Map();
	let nextID = 100;
	let menus = [];
	let panes = [];
	let unregistered = [];
	let notifiers = new Map();
	let errors = [];
	let timers = [];
	let opened = [];
	let launched = [];

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
			this.collections = [];
			this.noteHTML = "";
			this.dateAdded = "2024-05-01 08:00:00";
			items.set(this.id, this);
		}
		get parentItem() { return this.parentID ? items.get(this.parentID) : undefined; }
		get parentItemID() { return this.parentID; }
		isRegularItem() { return !["note", "attachment", "annotation"].includes(this.itemType); }
		isNote() { return this.itemType === "note"; }
		isAttachment() { return this.itemType === "attachment"; }
		isFileAttachment() { return this.itemType === "attachment"; }
		isPDFAttachment() { return this.itemType === "attachment"; }
		get attachmentContentType() { return "application/pdf"; }
		get attachmentFilename() { return "paper.pdf"; }
		get annotationType() { return this.fields.type; }
		get annotationText() { return this.fields.text || ""; }
		get annotationComment() { return this.fields.comment || ""; }
		get annotationColor() { return this.fields.color || ""; }
		get annotationPageLabel() { return this.fields.page || ""; }
		get annotationSortIndex() { return this.fields.sort || "0"; }
		getField(f) { return this.fields[f] || ""; }
		getCreatorsJSON() { return this.fields.creators || []; }
		getTags() { return this.tags.map(tag => ({ tag })); }
		addTag(t) { this.tags.push(t); return true; }
		removeTag(t) { this.tags = this.tags.filter(x => x !== t); return true; }
		getCollections() { return this.collections.slice(); }
		getAttachments() { return this.children.filter(id => items.get(id).itemType === "attachment"); }
		getNotes() { return this.children.filter(id => items.get(id).itemType === "note"); }
		getAnnotations() { return this.children.map(id => items.get(id)).filter(i => i.itemType === "annotation"); }
		getNote() { return this.noteHTML; }
		setNote(h) { this.noteHTML = h; }
		getNoteTitle() { return ""; }
		getItemTypeIconName() { return this.itemType; }
		async saveTx() { return this.id; }
	}
	let addChild = (parent, child) => {
		child.parentID = parent.id;
		parent.children.push(child.id);
		return child;
	};
	let addCollection = (id, name, parentID = null) => {
		let c = { id, key: `COL${id}`, name, parentID, libraryID: 1, deleted: false, getChildItems: () => [] };
		collections.set(id, c);
		return c;
	};

	let prefStore = Object.assign({}, prefs);
	let observers = new Map();
	let observerCount = () => [...observers.values()].reduce((n, list) => n + list.length, 0);
	let Zotero = {
		Prefs: {
			get: k => prefStore[k],
			set: (k, v) => {
				prefStore[k] = v;
				for (let o of observers.get(k) || []) o.fn();
			},
			clear: (k) => {
				delete prefStore[k];
				for (let o of observers.get(k) || []) o.fn();
			},
			registerObserver: (name, fn) => {
				let o = { fn, symbol: Symbol(name) };
				observers.set(name, [...(observers.get(name) || []), o]);
				return o.symbol;
			},
			unregisterObserver: (symbol) => {
				for (let [name, list] of observers) observers.set(name, list.filter(o => o.symbol !== symbol));
			},
		},
		MenuManager: { registerMenu: (o) => { menus.push(o); return o.menuID; }, unregisterMenu: () => true },
		Notifier: {
			registerObserver: (ref, types, name) => {
				let id = `obs-${name}`;
				notifiers.set(id, { ref, types, name });
				return id;
			},
			unregisterObserver: (id) => { notifiers.delete(id); },
		},
		ItemPaneManager: {
			registerSection: (o) => { panes.push(o); return o.paneID; },
			unregisterSection: (id) => { unregistered.push(id); return true; },
		},
		PreferencePanes: { register: async () => "pane" },
		Reader: { open: async (id, location) => { opened.push({ id, location: location || null }); } },
		launchURL: (url) => { launched.push(url); },
		getMainWindows: () => [],
		getMainWindow: () => ({}),
		getActiveZoteroPane: () => ({ getSelectedCollections: () => [] }),
		Items: {
			get: ids => (Array.isArray(ids) ? ids.map(id => items.get(id)) : items.get(Number(ids)) || false),
			exists: id => items.has(id),
			getByLibraryAndKey: () => false,
			getAll: async () => [],
		},
		Libraries: { get: () => ({ libraryType: "user", name: "My Library" }), getAll: () => [] },
		Groups: { getGroupIDFromLibraryID: () => null },
		Collections: {
			get: ids => (Array.isArray(ids) ? ids.map(id => collections.get(id)).filter(Boolean) : collections.get(ids) || false),
			getByParent: id => [...collections.values()].filter(c => c.parentID === id),
			getByLibrary: () => [...collections.values()].filter(c => !c.parentID),
		},
		Tags: { getID: () => false },
		Styles: { get: () => null },
		ProgressWindow: class {
			constructor() {
				this.ItemProgress = class {
					constructor(icon, text) { this.text = text; }
					setText(t) { this.text = t; }
					setProgress() {}
					setError() {}
				};
			}
			changeHeadline() {}
			addDescription() {}
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
		move: async (from, to) => fsp.rename(from, to),
	};
	let PathUtils = { join: (...parts) => path.join(...parts), filename: p => path.basename(p), parent: p => path.dirname(p) };
	let context = vm.createContext({
		Zotero, IOUtils, PathUtils, fetch, console, TextDecoder, TextEncoder,
		Components: {
			Constructor: function () {
				return function () {};
			},
			interfaces: { nsILoginInfo: {} },
		},
		DOMParser: new JSDOM("").window.DOMParser,
		setTimeout: (fn, ms) => {
			if (ms >= 1000) {
				timers.push({ fn, ms, cleared: false });
				return timers.length;
			}
			return setTimeout(fn, ms);
		},
		clearTimeout: (id) => {
			if (typeof id === "number" && timers[id - 1]) timers[id - 1].cleared = true;
			else clearTimeout(id);
		},
		Services: {
			scriptloader: {
				loadSubScript: (url) => {
					let file = url.replace("file://", "");
					vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
				},
			},
			prompt: { confirm: () => true },
			logins: {
				searchLoginsAsync: async () => [],
				addLoginAsync: async l => l,
				modifyLoginAsync: async () => {},
				removeLoginAsync: async () => {},
			},
		},
	});
	vm.runInContext(fs.readFileSync(path.join(ROOT, "bootstrap.js"), "utf8"), context, { filename: "bootstrap.js" });
	return { context, Zotero, MockItem, items, addChild, addCollection, menus, panes, unregistered, notifiers, errors, prefStore, timers, observerCount, opened, launched };
}

async function setup(prefs = {}, opts = {}) {
	let env = makeEnv({ fetch: async (url) => { throw new Error(`unexpected request ${url}`); }, prefs });
	if (opts.window) {
		let dom = new JSDOM("<!doctype html><html><body></body></html>");
		dom.window.MozXULElement = { insertFTLIfNeeded: () => {} };
		env.window = dom.window;
		env.Zotero.getMainWindows = () => [dom.window];
	}
	await vm.runInContext(`startup({ id: "zotero-bridge@bobyu89.github.io", version: "0.0.0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);
	return Object.assign(env, { ZB: env.context.ZB, section: env.panes.find(p => p.paneID === "zotero-bridge-ai-note") });
}

const AI_HTML = "<h1>🤖 AI 文獻筆記</h1><p><em>由 test-model 於 2026-10-01T00:00:00Z 產生（ZotMax）</em></p>"
	+ "<h2>一句話摘要</h2><p>護理師主導的衛教讓住院跌倒少了三成。</p>"
	+ "<h2>主要結果</h2><ul><li>跌倒率 RR 0.70</li><li>受傷跌倒減少</li><li>住院天數無差異</li><li>第四點不顯示</li></ul>"
	+ "<h2>研究限制</h2><p>單一醫院。</p>"
	+ "<h2>📋 結構化資料（ZotMax）</h2><pre>" + JSON.stringify({ study_design: "RCT", sample_size: 120, evidence_level: "2", appraisal_overall: "納入" }, null, 2) + "</pre>";

/** A paper with an AI note, a PDF with highlights in three colours, status and screening tags, and 自動分類 sub-collections. */
function richPaper(env) {
	let item = new env.MockItem("journalArticle", {
		title: "Nurse-led fall prevention", year: "2024", citationKey: "chen2024",
		creators: [{ lastName: "Chen", creatorType: "author" }],
		tags: ["狀態/已讀", "篩選/標題摘要/納入"],
	});
	let note = new env.MockItem("note");
	note.noteHTML = AI_HTML;
	note.tags = ["zotero-bridge-ai"];
	env.addChild(item, note);
	let pdf = env.addChild(item, new env.MockItem("attachment", { title: "Full Text PDF" }));
	let ann = (fields) => env.addChild(pdf, new env.MockItem("annotation", fields));
	let yellow = ["First finding", "Second finding", "Third finding", "Fourth finding"].map((text, i) => ann({ type: "highlight", text, color: "#ffd400", page: String(i + 1), sort: `0000${i}` }));
	let red = ann({ type: "highlight", text: "Single site only", color: "#ff6666", page: "7", sort: "00010" });
	let image = ann({ type: "image", color: "#2ea8e5", page: "3", sort: "00005", comment: "Figure 2: forest plot" });
	let root = env.addCollection(1, "自動分類");
	let design = env.addCollection(2, "研究設計", 1);
	env.addCollection(3, "RCT", 2);
	let level = env.addCollection(4, "證據等級", 1);
	env.addCollection(5, "CEBM 2", 4);
	env.addCollection(9, "碩論");
	item.collections = [5, 3, 9];
	return { item, note, pdf, yellow, red, image, root, design, level };
}

function dom() {
	let doc = new JSDOM("<div id=b></div>").window.document;
	return { doc, body: doc.getElementById("b") };
}

async function until(fn, what, ms = 2000) {
	let end = Date.now() + ms;
	while (Date.now() < end) {
		if (fn()) return;
		await new Promise(r => setTimeout(r, 10));
	}
	assert.fail(`timed out waiting for ${what}`);
}

// Values from the plugin's realm (vm context), compared as plain data
const plain = v => JSON.parse(JSON.stringify(v));
const sub = (body, id) => body.querySelector(`[data-zb-sub="${id}"]`);
const commands = body => [...sub(body, "actions").querySelectorAll("button[data-zb-command]")].map(b => b.dataset.zbCommand);

test("registers one ZotMax section: icon in the side navigation, header ⋯ button, enabled for items, attachments and notes", async () => {
	let env = await setup();
	let { section } = env;
	assert.equal(env.panes.length, 1);
	assert.equal(section.pluginID, "zotero-bridge@bobyu89.github.io");
	assert.equal(section.header.l10nID, "zotero-bridge-pane-header");
	assert.equal(section.sidenav.l10nID, "zotero-bridge-pane-sidenav");
	assert.match(section.sidenav.icon, /content\/icons\/bridge\.svg$/);
	assert.equal(section.sidenav.darkIcon, section.sidenav.icon);
	assert.equal(section.sectionButtons.length, 1);
	assert.match(section.sectionButtons[0].icon, /content\/icons\/more\.svg$/);
	assert.ok(fs.existsSync(path.join(ROOT, "content", "icons", "more.svg")));
	let { item, pdf, note } = richPaper(env);
	let enabled = (it) => {
		let v = null;
		section.onItemChange({ item: it, setEnabled: (x) => { v = x; }, tabType: "reader" });
		return v;
	};
	assert.equal(enabled(item), true);
	assert.equal(enabled(pdf), true, "the PDF in the reader: its parent item");
	assert.equal(enabled(note), true);
	let standalone = new env.MockItem("attachment", { title: "Loose PDF" });
	assert.equal(enabled(standalone), false, "a standalone PDF has no literature item");
	// The header and side navigation say ZotMax in both languages
	for (let lang of ["zh-TW", "en-US"]) {
		let ftl = fs.readFileSync(path.join(ROOT, "locale", lang, "zotero-bridge.ftl"), "utf8");
		assert.match(ftl, /^zotero-bridge-pane-header =\n {4}\.label = ZotMax$/m, lang);
		assert.match(ftl, /^zotero-bridge-pane-sidenav =\n {4}\.tooltiptext = ZotMax$/m, lang);
		assert.match(ftl, /^zotero-bridge-pane-more =\n {4}\.tooltiptext = .+$/m, lang);
	}
	assert.deepEqual(env.errors, []);
});

test("every panel string is in both FTL files, zh-TW identical to the fallback text", async () => {
	let env = await setup();
	let text = lang => fs.readFileSync(path.join(ROOT, "locale", lang, "zotero-bridge.ftl"), "utf8");
	let zh = text("zh-TW");
	let en = text("en-US");
	for (let [name, [id, value]] of Object.entries(env.ZB.sidepanel.STRINGS)) {
		let m = new RegExp(`^${id} = (.+)$`, "m").exec(zh);
		assert.ok(m, `zh-TW ${id}`);
		assert.equal(m[1], value, `zh-TW ${name}`);
		assert.match(en, new RegExp(`^${id} = \\S`, "m"), `en-US ${id}`);
	}
});

test("an item with everything: 重點, 我的劃線, 狀態, 動作 and 延伸搜尋, from the same data as the note's 重點", async () => {
	let env = await setup({ [P + "features.version"]: 1 });
	let { ZB } = env;
	ZB.features.applyPreset("advanced");
	let { item, yellow, red } = richPaper(env);
	let { doc, body } = dom();
	let summary = null;
	env.section.onRender({ doc, body, item, setSectionSummary: (s) => { summary = s; } });

	assert.deepEqual([...body.querySelectorAll("[data-zb-sub]")].map(d => d.dataset.zbSub), ["keyPoints", "highlights", "status", "actions", "search"]);
	assert.deepEqual([...body.querySelectorAll("[data-zb-sub]")].map(d => d.open), [true, false, false, true, false], "重點 and 動作 open by default");
	assert.equal(summary, "護理師主導的衛教讓住院跌倒少了三成。");

	// 重點: the note's own parts (core.keyPoints)
	let kp = sub(body, "keyPoints");
	assert.equal(kp.querySelector("summary .zb-sp-title").textContent, "重點");
	assert.equal(kp.querySelector(".zb-sp-lead").textContent, "護理師主導的衛教讓住院跌倒少了三成。");
	assert.equal(kp.querySelector(".zb-sp-facts").textContent, "RCT · N = 120 · CEBM 2 · 評讀：納入（AI 初評）");
	assert.deepEqual([...kp.querySelectorAll(".zb-sp-findings li")].map(li => li.textContent), ["跌倒率 RR 0.70", "受傷跌倒減少", "住院天數無差異"]);
	let data = ZB.adapter.paneData(item);
	let ai = ZB.main.readAINote(data.aiNote.html);
	let parts = ZB.core.keyPoints(data, { aiMarkdown: ai.md, study: ai.data, appraisal: null });
	assert.equal(kp.querySelector(".zb-sp-facts").textContent, parts.facts);
	assert.match(ZB.core.buildNoteSections(data, { aiMarkdown: ai.md, study: ai.data }).keyPoints, /\*\*一句話\*\*：護理師主導的衛教讓住院跌倒少了三成。/);
	let full = kp.querySelector("[data-zb-full-note]");
	assert.equal(full.open, false, "the whole AI note is folded");
	assert.equal(full.querySelector("summary").textContent, "完整 AI 筆記（test-model · 2026-10-01）");
	assert.match(full.textContent, /單一醫院/);
	assert.doesNotMatch(full.textContent, /護理師主導/, "the take-away is said once");

	// 我的劃線: by colour meaning, in the meanings' order, three per meaning
	let hl = sub(body, "highlights");
	assert.equal(hl.dataset.zbCount, "6");
	assert.equal(hl.querySelector("summary .zb-sp-peek").textContent, "6 則");
	let groups = [...hl.querySelectorAll(".zb-sp-group")];
	assert.deepEqual(groups.map(g => g.querySelector(".zb-sp-meaning").textContent), ["重要發現", "限制／疑問", "可引用句"]);
	assert.deepEqual(groups.map(g => g.querySelector(".zb-sp-count").textContent), ["4 則", "1 則", "1 則"]);
	assert.equal(groups[0].querySelector(".zb-sp-swatch").style.getPropertyValue("--zb-swatch"), "#ffd400");
	assert.deepEqual([...groups[0].querySelectorAll(".zb-sp-ann")].map(b => b.textContent), ["First findingp. 1", "Second findingp. 2", "Third findingp. 3"]);
	assert.equal(groups[2].querySelector(".zb-sp-ann").textContent, "圖片註記 Figure 2: forest plotp. 3");
	// A click opens the PDF at that annotation
	groups[1].querySelector(".zb-sp-ann").click();
	assert.deepEqual(plain(env.opened), [{ id: red.parentID, location: { annotationID: red.key } }]);
	// 「全部顯示」 shows the fourth yellow one
	let more = groups[0].querySelector("[data-zb-action=show-all]");
	assert.equal(more.textContent, "全部顯示（4 則）");
	more.click();
	let yellowNow = [...sub(body, "highlights").querySelector('[data-zb-color="#ffd400"]').querySelectorAll(".zb-sp-ann")];
	assert.equal(yellowNow.length, 4);
	assert.equal(yellowNow[3].dataset.zbAnnotation, yellow[3].key);

	// 狀態: the modules' rows, 自動分類 chips, a peek while closed
	let st = sub(body, "status");
	// The AI note's appraisal prefills the form (appraisal-form.js), not yet checked by the user
	assert.equal(st.querySelector("summary .zb-sp-peek").textContent, "已讀 · 標題摘要：納入 · AI 初評，尚未核對 · 納入");
	assert.match(st.textContent, /閱讀狀態：/);
	assert.ok([...st.querySelectorAll("span")].some(s => s.textContent === "篩選：標題摘要：納入"), "screening row");
	assert.match(st.querySelector("[data-zb-appraisal]").textContent, /文獻評讀表：AI 初評，尚未核對/);
	assert.deepEqual([...st.querySelectorAll(".zb-sp-chip")].map(c => c.textContent), ["研究設計：RCT", "證據等級：CEBM 2"]);
	assert.doesNotMatch(st.textContent, /碩論/, "only the 自動分類 sub-collections");

	// 動作: the catalog's item commands (進階: all on), then 快速指令…
	assert.deepEqual(commands(body), ["sync", "sync-no-ai", "regenerate", "classify", "search-item", "chase-items", "appraisal-coach", "palette"]);
	assert.deepEqual([...sub(body, "actions").querySelectorAll("button")].map(b => b.textContent),
		["同步", "同步，不呼叫 AI", "重新產生 AI 筆記", "自動分類…", "搜尋資料庫…", "引文追蹤", "對照 AI", "快速指令…"]);
	// 評讀陪練 waits for the user's own answers (here only the AI's 初評): disabled, the reason as its tooltip
	let coach = sub(body, "actions").querySelector("button[data-zb-command=appraisal-coach]");
	assert.equal(coach.disabled, true);
	assert.match(coach.title, /^先自己答完每一題，才能對照 AI：/);
	assert.equal(coach.getAttribute("data-l10n-id"), "zotero-bridge-pane-cmd-appraisal-coach-blocked");
	assert.equal(JSON.parse(coach.getAttribute("data-l10n-args")).reason, coach.title);
	for (let b of sub(body, "actions").querySelectorAll("button")) assert.ok(b.getAttribute("data-l10n-id").startsWith("zotero-bridge-pane-cmd-"));

	// 延伸搜尋: the search links row
	assert.ok(sub(body, "search").querySelector("a[data-source=pubmed]"));
	assert.deepEqual(env.errors, []);
});

test("empty states: no AI note (switch on or off), no highlights, nothing in 狀態", async () => {
	let env = await setup({ [P + "features.version"]: 1 });
	let F = env.ZB.features;
	let item = new env.MockItem("journalArticle", { title: "Bare" });
	let pdf = env.addChild(item, new env.MockItem("attachment", { title: "PDF" }));
	let { doc, body } = dom();
	let summary;
	let render = () => env.section.onRender({ doc, body, item, setSectionSummary: (s) => { summary = s; } });

	render();
	let kp = sub(body, "keyPoints");
	assert.equal(summary, "尚未產生");
	assert.deepEqual([...kp.querySelectorAll("p")].map(p => p.textContent).slice(0, 2),
		["這篇還沒有 AI 文獻筆記。", "產生時會呼叫你設定的 AI 服務（要付費），完成後同步到 Notion／Obsidian。"]);
	let generate = kp.querySelector("button[data-zb-command=sync]");
	assert.equal(generate.textContent, "產生 AI 筆記");
	assert.equal(kp.querySelector(".zb-sp-facts"), null);
	assert.equal(kp.querySelector("[data-zb-full-note]"), null);
	let hl = sub(body, "highlights");
	assert.equal(hl.dataset.zbCount, "0");
	assert.equal(hl.querySelector(".zb-sp-peek"), null);
	assert.match(hl.textContent, /還沒有劃線。在 PDF 上劃線，這裡會依顏色的意義分組。/);
	assert.ok(hl.querySelector('[data-zb-settings="colors"]'), "a way to the colour meanings");
	hl.querySelector("[data-zb-action=open-pdf]").click();
	assert.deepEqual(plain(env.opened), [{ id: pdf.id, location: null }]);

	F.setEnabled("aiNotes", false);
	render();
	assert.equal(summary, "AI 筆記已關閉");
	assert.match(sub(body, "keyPoints").textContent, /AI 文獻筆記目前關閉，同步時只整理書目、劃線和你的筆記。要打開：設定 → 功能。/);
	assert.equal(sub(body, "keyPoints").querySelector("button[data-zb-command]"), null);
	let opened = [];
	env.ZB.commands.openSettings = (id) => { opened.push(id); };
	sub(body, "keyPoints").querySelector("[data-zb-action=open-features]").click();
	assert.deepEqual(opened, ["ai"]);

	// 狀態 with nothing to show hides
	for (let id of ["status", "screening", "appraisalForm", "autoClassify"]) F.setEnabled(id, false);
	render();
	assert.equal(sub(body, "status").hidden, true);
	assert.deepEqual(env.errors, []);
});

test("switches hide rows and commands live: the panel renders again when a switch changes", async () => {
	let env = await setup({ [P + "features.version"]: 1 });
	let F = env.ZB.features;
	F.applyPreset("advanced");
	let { item } = richPaper(env);
	let { doc, body } = dom();
	let props = { doc, body, item, setSectionSummary: () => {} };
	let refreshes = 0;
	env.section.onInit({ body, refresh: () => { refreshes++; env.section.onRender(props); } });
	env.section.onRender(props);
	assert.ok([...sub(body, "status").querySelectorAll("span")].some(s => /^篩選：/.test(s.textContent)));
	assert.ok(commands(body).includes("chase-items"));

	F.setEnabled("screening", false);
	F.setEnabled("citationChase", false);
	F.setEnabled("searchLinks", false);
	await until(() => refreshes > 0, "a refresh after the switches changed");
	assert.equal(refreshes, 1, "one refresh for several switches");
	assert.ok(![...sub(body, "status").querySelectorAll("span")].some(s => /^篩選：/.test(s.textContent)), "screening row gone");
	assert.doesNotMatch(sub(body, "status").querySelector(".zb-sp-peek").textContent, /標題摘要/);
	assert.deepEqual(commands(body), ["sync", "sync-no-ai", "regenerate", "classify", "appraisal-coach", "palette"]);
	assert.equal(sub(body, "search"), null);

	F.setEnabled("autoClassify", false);
	await until(() => refreshes > 1, "a refresh after 文獻自動分類 went off");
	assert.equal(sub(body, "status").querySelector(".zb-sp-chip"), null);
	assert.ok(!commands(body).includes("classify"));
	assert.deepEqual(env.errors, []);
});

test("動作 runs the catalog command with [this item]; an attachment acts for its parent; variants open as a list", async () => {
	let env = await setup({ [P + "features.version"]: 1 });
	let C = env.ZB.commands;
	let { item, pdf } = richPaper(env);
	let { doc, body } = dom();
	let refreshed = 0;
	let calls = [];
	C.get("sync-no-ai").run = (sel) => {
		calls.push(sel);
		return Promise.resolve("done");
	};
	// The reader's side pane hands the PDF; the panel is about its parent
	let props = { doc, body, item: pdf, setSectionSummary: () => {} };
	env.section.onInit({ body, refresh: () => { refreshed++; } });
	env.section.onRender(props);
	let button = sub(body, "actions").querySelector("button[data-zb-command=sync-no-ai]");
	button.click();
	assert.equal(button.disabled, true, "busy while it runs");
	assert.equal(button.getAttribute("aria-busy"), "true");
	await until(() => refreshed > 0, "the panel to refresh after the command");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].surface, "item");
	assert.deepEqual(plain(calls[0].items.map(i => i.id)), [item.id]);
	assert.equal(button.disabled, false);

	// 搜尋資料庫…: the catalog's variants (the item's databases) as buttons where there is no XUL menu
	let search = sub(body, "actions").querySelector("button[data-zb-command=search-item]");
	assert.equal(search.getAttribute("aria-haspopup"), "menu");
	search.click();
	let list = sub(body, "actions").querySelector("[data-zb-variants=search-item]");
	assert.ok(list, "variants shown");
	let entries = C.variantEntries(C.get("search-item"), C.fromContext("item", { items: [item], collectionTreeRows: [] })).filter(v => !v.separator);
	assert.deepEqual([...list.querySelectorAll("button")].map(b => b.textContent), plain(entries.map(v => v.label)));
	assert.ok(entries.length > 3);
	list.querySelector("button").click();
	assert.equal(env.launched.length, 1, "the first database opened");
	search.click();
	assert.equal(sub(body, "actions").querySelector("[data-zb-variants]"), null, "a second click closes the list");

	// 快速指令… opens the palette (C.PALETTE)
	let paletteCalls = 0;
	env.ZB.palette.open = async () => { paletteCalls++; };
	sub(body, "actions").querySelector("button[data-zb-command=palette]").click();
	await until(() => paletteCalls === 1, "the palette");
	// The header's ⋯ button without a XUL menu falls back to 快速指令
	env.section.sectionButtons[0].onClick({ doc, body, item });
	await until(() => paletteCalls === 2, "the palette from ⋯");
	assert.deepEqual(env.errors, []);
});

test("open and closed parts are remembered in a pref", async () => {
	let env = await setup();
	let { item } = richPaper(env);
	let { doc, body } = dom();
	let render = () => env.section.onRender({ doc, body, item, setSectionSummary: () => {} });
	render();
	assert.equal(env.prefStore[P + "pane.open"], undefined, "rendering writes nothing");
	let hl = sub(body, "highlights");
	hl.open = true;
	await until(() => env.prefStore[P + "pane.open"], "the toggle to be saved");
	sub(body, "actions").open = false;
	await until(() => JSON.parse(env.prefStore[P + "pane.open"]).actions === false, "動作 closed saved");
	assert.deepEqual(JSON.parse(env.prefStore[P + "pane.open"]), { highlights: true, actions: false });
	render();
	assert.deepEqual([...body.querySelectorAll("[data-zb-sub]")].map(d => d.open), [true, true, false, false, false]);
	// Declared with the other defaults
	assert.match(fs.readFileSync(path.join(ROOT, "prefs.js"), "utf8"), /^pref\("extensions\.zotero-bridge\.pane\.open", "\{\}"\);$/m);
	assert.deepEqual(env.errors, []);
});

test("Notifier: the panel refreshes when its item, notes, annotations, tags or collections change, not for other items", async () => {
	let env = await setup();
	let { item, note, yellow } = richPaper(env);
	let other = new env.MockItem("journalArticle", { title: "Other" });
	let { doc, body } = dom();
	let refreshed = 0;
	assert.equal([...env.notifiers.values()].filter(n => n.name === "zotero-bridge-panel").length, 0, "nothing observed before a pane exists");
	env.section.onInit({ body, refresh: () => { refreshed++; } });
	env.section.onRender({ doc, body, item, setSectionSummary: () => {} });
	let panel = env.notifiers.get("obs-zotero-bridge-panel");
	assert.ok(panel, "observer registered with the first pane");
	assert.deepEqual(plain(panel.types), ["item", "item-tag", "collection-item", "collection"]);
	let fire = async (event, type, ids) => {
		let before = refreshed;
		panel.ref.notify(event, type, ids, {});
		await new Promise(r => setTimeout(r, 400));
		return refreshed - before;
	};
	assert.equal(await fire("modify", "item", [other.id]), 0, "another item");
	assert.equal(await fire("modify", "item", [yellow[0].id]), 1, "an annotation of its PDF");
	assert.equal(await fire("modify", "item", [note.id, item.id]), 1, "its AI note and itself: one refresh");
	assert.equal(await fire("add", "item-tag", [`${item.id}-7`]), 1, "a tag");
	assert.equal(await fire("add", "collection-item", [`3-${item.id}`]), 1, "a collection");
	assert.equal(await fire("add", "collection-item", [`3-${other.id}`]), 0);
	assert.equal(await fire("delete", "item", [99999]), 1, "an item that is gone: refresh to be safe");
	// After any sync (main.run) every panel refreshes
	await env.ZB.main.run([], {});
	await until(() => refreshed > 5, "a refresh after a run");
	// A body Zotero destroyed is left alone
	env.section.onDestroy({ body });
	let n = refreshed;
	panel.ref.notify("modify", "item", [item.id], {});
	await new Promise(r => setTimeout(r, 400));
	assert.equal(refreshed, n);
	assert.deepEqual(env.errors, []);
});

test("links and the last sync time come from the literature note in the vault", async () => {
	let vault = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-panel-vault-"));
	let env = await setup({ [P + "obsidian.vaultPath"]: vault, [P + "obsidian.folder"]: "Zotero", [P + "obsidian.filenameFormat"]: "citekey" });
	let { item } = richPaper(env);
	let { doc, body } = dom();
	let render = () => env.section.onRender({ doc, body, item, setSectionSummary: () => {} });

	// Not synced yet
	render();
	await until(() => !sub(body, "status").querySelector("[data-zb-synced]").hidden, "the sync line");
	assert.equal(sub(body, "status").querySelector("[data-zb-synced]").textContent, "還沒有同步到 Obsidian。");
	assert.equal(body.querySelector("[data-zb-links]").hidden, true);

	await fsp.mkdir(path.join(vault, "Zotero", "全文"), { recursive: true });
	await fsp.writeFile(path.join(vault, "Zotero", "chen2024.md"), `---\nzotero_key: "library/${item.key}"\nnotion: "https://www.notion.so/page-1"\nfulltext: "[[Zotero/全文/chen2024]]"\nlast_synced: "2026-10-01T08:00:00Z"\n---\n`);
	await fsp.writeFile(path.join(vault, "Zotero", "全文", "chen2024.md"), "---\nfulltext_of: x\n---\n");
	render();
	await until(() => !body.querySelector("[data-zb-links]").hidden, "the links");
	let links = [...body.querySelectorAll("[data-zb-link]")];
	assert.deepEqual(links.map(l => [l.dataset.zbLink, l.textContent]), [["obsidian", "在 Obsidian 開啟筆記"], ["fulltext", "開啟全文筆記"], ["notion", "在 Notion 開啟"]]);
	assert.ok(sub(body, "keyPoints").contains(links[0]), "in 重點, like the note's links line");
	let local = new Date("2026-10-01T08:00:00Z");
	let p = n => String(n).padStart(2, "0");
	assert.equal(sub(body, "status").querySelector("[data-zb-synced]").textContent,
		`上次同步：${local.getFullYear()}-${p(local.getMonth() + 1)}-${p(local.getDate())} ${p(local.getHours())}:${p(local.getMinutes())}`);
	links[0].click();
	links[2].click();
	assert.deepEqual(env.launched, [`obsidian://open?vault=${encodeURIComponent(path.basename(vault))}&file=${encodeURIComponent("Zotero/chen2024")}`, "https://www.notion.so/page-1"]);
	// A stale render's links never land in a newer one
	render();
	render();
	await until(() => !body.querySelector("[data-zb-links]").hidden, "the links again");
	assert.equal(body.querySelectorAll("[data-zb-link]").length, 3);
	assert.deepEqual(env.errors, []);
});

test("shutdown: the section, the Notifier and pref observers and the stylesheet are gone", async () => {
	let env = await setup({}, { window: true });
	let link = env.window.document.getElementById("zotero-bridge-sidepanel-css");
	assert.ok(link, "stylesheet added to the main window");
	assert.match(link.getAttribute("href"), /content\/sidepanel\.css$/);
	assert.ok(fs.existsSync(path.join(ROOT, "content", "sidepanel.css")));
	let { item } = richPaper(env);
	let { doc, body } = dom();
	let before = env.observerCount();
	env.section.onInit({ body, refresh: () => {} });
	env.section.onRender({ doc, body, item, setSectionSummary: () => {} });
	assert.ok(env.observerCount() > before, "pref observers for the switches");
	assert.ok(env.notifiers.has("obs-zotero-bridge-panel"));
	await vm.runInContext("shutdown()", env.context);
	assert.deepEqual(env.unregistered, ["zotero-bridge-ai-note"]);
	assert.equal(env.notifiers.has("obs-zotero-bridge-panel"), false);
	assert.equal(env.observerCount(), 0, "no pref observer left");
	assert.equal(env.window.document.getElementById("zotero-bridge-sidepanel-css"), null);
	assert.deepEqual(env.errors, []);
});

test("狀態: a Chinese item whose data needs a look gets one line and a button that opens 中文文獻補強; quiet otherwise", async () => {
	let env = await setup({ [P + "features.version"]: 1 });
	let F = env.ZB.features;
	let messy = new env.MockItem("journalArticle", {
		title: "護理人員跌倒預防衛教之成效", date: "民國112年", publicationTitle: "護理雜誌", volume: "70(2)", pages: "４５－５６頁", language: "",
		creators: [{ name: "陳美玲、林小華", creatorType: "author" }],
	});
	let { doc, body } = dom();
	let render = item => env.section.onRender({ doc, body, item, setSectionSummary: () => {} });
	render(messy);
	let status = sub(body, "status");
	assert.equal(status.hidden, false);
	let line = status.querySelector("[data-zb-zhmeta]");
	assert.ok(line, "the 中文資料 line");
	assert.equal(line.dataset.zbZhmeta, "5");
	let label = line.querySelector("span");
	assert.equal(label.textContent, "中文資料：5 個地方要檢查");
	assert.equal(label.getAttribute("data-l10n-id"), "zotero-bridge-pane-zh-meta");
	assert.deepEqual(JSON.parse(label.getAttribute("data-l10n-args")), { count: 5 });
	assert.match(status.querySelector(".zb-sp-peek").textContent, /中文資料：5 個地方要檢查/, "visible while 狀態 is closed");
	let calls = [];
	env.ZB.zhMeta.run = async (items) => {
		calls.push(items.map(i => i.id));
		return { cancelled: true };
	};
	let button = line.querySelector("button[data-zb-action=zh-meta]");
	assert.equal(button.textContent, "檢查並修正…");
	button.click();
	assert.deepEqual(plain(calls), [[messy.id]]);
	assert.equal(button.getAttribute("aria-busy"), "true");
	await until(() => !button.hasAttribute("aria-busy"), "the button to come back");

	// Quiet: a clean Chinese item, an English item, the switch off
	for (let item of [
		new env.MockItem("journalArticle", { title: "加護病房護理人員之睡眠品質", date: "2020", publicationTitle: "長庚護理", volume: "31", issue: "1", pages: "1-12", language: "zh-TW",
			creators: [{ lastName: "王", firstName: "大明", creatorType: "author" }] }),
		new env.MockItem("journalArticle", { title: "Exercise and falls", date: "民國112年", pages: "45~56", creators: [{ name: "陳美玲、林小華", creatorType: "author" }] }),
	]) {
		render(item);
		assert.equal(body.querySelector("[data-zb-zhmeta]"), null);
		assert.doesNotMatch(body.textContent, /中文資料/);
	}
	F.setEnabled("zhMeta", false);
	render(messy);
	assert.equal(body.querySelector("[data-zb-zhmeta]"), null);
	assert.deepEqual(env.errors, []);
});
