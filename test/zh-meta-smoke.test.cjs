// 中文文獻補強 through the real plugin in a mocked Zotero: the command opens the review window (the real
// zh-meta-review.xhtml in jsdom) with sure fixes ticked and check-level ones not, missing data without a
// checkbox; 套用勾選的修正 writes only what is ticked, in a transaction; 取消 and Esc write nothing; English
// items are never touched; 復原上一次中文文獻修正 puts the fields back but keeps what the user edited since.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const ROOT_URI = "file://" + ROOT + "/";
const P = "extensions.zotero-bridge.";

// The parts of Zotero the module touches (shaped like classify-smoke's), with items that can be edited
// (setField, setCreators, setType) and saved inside Zotero.DB.executeTransaction
function makeEnv(prefs = {}) {
	let items = new Map();
	let nextID = 100;
	let menus = [];
	let descriptions = [];
	let errors = [];
	let saves = [];
	let transactions = 0;
	let confirms = [];
	let dialogs = [];
	let inTransaction = false;

	// Fields per item type (just what the tests use)
	const TYPE_FIELDS = {
		journalArticle: ["title", "date", "volume", "issue", "pages", "DOI", "url", "extra", "language", "publicationTitle", "libraryCatalog"],
		thesis: ["title", "date", "url", "extra", "language", "thesisType", "university", "libraryCatalog"],
	};

	class MockItem {
		constructor(type, fields = {}, creators = []) {
			this.id = nextID++;
			this.key = fields.key || `KEY${this.id}`;
			delete fields.key;
			this.itemType = type;
			this.libraryID = 1;
			this.deleted = false;
			this.parentID = null;
			this.fields = Object.assign({}, fields);
			this.creators = creators.map(c => Object.assign({}, c));
			this.tags = [];
			items.set(this.id, this);
		}
		get parentItem() { return undefined; }
		isRegularItem() { return !["note", "attachment", "annotation"].includes(this.itemType); }
		getField(f, unformatted, base) {
			if (base && f === "publisher" && this.itemType === "thesis") return this.fields.university || "";
			return (TYPE_FIELDS[this.itemType] || []).includes(f) ? (this.fields[f] || "") : "";
		}
		setField(f, v) {
			if (!(TYPE_FIELDS[this.itemType] || []).includes(f)) throw new Error(`'${f}' is not a valid field for type ${this.itemType}`);
			this.fields[f] = v;
		}
		setType(type) {
			// Like Zotero: fields the new type doesn't have are cleared
			for (let f of Object.keys(this.fields)) {
				if (!(TYPE_FIELDS[type] || []).includes(f)) delete this.fields[f];
			}
			this.itemType = type;
		}
		getCreatorsJSON() { return this.creators.map(c => Object.assign({}, c)); }
		setCreators(list) { this.creators = list.map(c => Object.assign({}, c)); }
		getTags() { return []; }
		getAttachments() { return []; }
		getNotes() { return []; }
		getCollections() { return []; }
		async save() {
			assert.ok(inTransaction, "save() inside a transaction");
			saves.push(this.id);
			return this.id;
		}
		async saveTx() { saves.push(this.id); return this.id; }
	}

	let prefStore = Object.assign({}, prefs);
	let selectedItems = [];
	let mainWindow = {
		openDialog(url, name, features) {
			assert.equal(url, "chrome://zotero-bridge/content/zh-meta-review.xhtml");
			assert.match(features, /chrome/);
			let dom = new JSDOM(fs.readFileSync(path.join(ROOT, "content", "zh-meta-review.xhtml"), "utf8"), { contentType: "application/xml" });
			dialogs.push(dom.window);
			return dom.window;
		},
	};
	let Zotero = {
		Prefs: {
			get: k => prefStore[k],
			set: (k, v) => { prefStore[k] = v; },
			clear: (k) => { delete prefStore[k]; },
			registerObserver: () => Symbol("observer"),
			unregisterObserver: () => {},
		},
		MenuManager: { registerMenu: (o) => { menus.push(o); return o.menuID; }, unregisterMenu: () => true },
		Notifier: { registerObserver: () => "obs", unregisterObserver: () => {} },
		ItemPaneManager: { registerSection: o => o.paneID, unregisterSection: () => true },
		PreferencePanes: { register: async () => "pane" },
		DB: {
			executeTransaction: async (fn) => {
				transactions++;
				inTransaction = true;
				try {
					return await fn();
				}
				finally {
					inTransaction = false;
				}
			},
		},
		ItemTypes: { getID: name => (TYPE_FIELDS[name] ? name : false) },
		ItemFields: {
			getID: name => name,
			isValidForType: (field, type) => (TYPE_FIELDS[type] || []).includes(field),
			getItemTypeFields: type => TYPE_FIELDS[type] || [],
			getName: id => id,
		},
		getMainWindows: () => [],
		getMainWindow: () => mainWindow,
		getActiveZoteroPane: () => ({ getSelectedCollections: () => [], getSelectedItems: () => selectedItems }),
		Items: {
			get: ids => (Array.isArray(ids) ? ids.map(id => items.get(id)) : items.get(ids)),
			getByLibraryAndKey: (libraryID, key) => [...items.values()].find(i => i.libraryID === libraryID && i.key === key) || false,
			getAll: async () => [],
		},
		Libraries: { userLibraryID: 1, get: () => ({ libraryType: "user", name: "我的文獻庫" }), getAll: () => [] },
		Groups: { getGroupIDFromLibraryID: () => null },
		Collections: { get: () => [], getByLibrary: () => [], getByParent: () => [] },
		Tags: { getID: () => false },
		Styles: { get: () => null },
		ProgressWindow: class {
			constructor() {
				this.ItemProgress = class {
					setText() {}
					setProgress() {}
					setError() {}
				};
			}
			changeHeadline() {}
			addDescription(t) { descriptions.push(t); }
			show() {}
			close() {}
			startCloseTimer() {}
		},
		logError: (e) => { errors.push(e); },
		debug: () => {},
	};
	Zotero.Item = MockItem;
	// Mock items keep the item type as a name; the module asks Zotero.ItemTypes for the ID it passes to setType
	let PathUtils = { join: (...parts) => path.join(...parts), filename: p => path.basename(p), parent: p => path.dirname(p) };
	let context = vm.createContext({
		Zotero, PathUtils, IOUtils: {}, fetch: async (url) => { throw new Error(`unexpected request ${url}`); }, console, TextDecoder, TextEncoder,
		Components: {
			Constructor: function () {
				return function () {};
			},
			interfaces: { nsILoginInfo: {} },
		},
		DOMParser: new JSDOM("").window.DOMParser,
		setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
		clearTimeout,
		Services: {
			scriptloader: {
				loadSubScript: (url) => {
					let file = url.replace("file://", "");
					vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
				},
			},
			prompt: { confirm: (win, title, text) => { confirms.push(text); return true; } },
			logins: { searchLoginsAsync: async () => [], addLoginAsync: async l => l, modifyLoginAsync: async () => {}, removeLoginAsync: async () => {} },
		},
	});
	vm.runInContext(fs.readFileSync(path.join(ROOT, "bootstrap.js"), "utf8"), context, { filename: "bootstrap.js" });
	return {
		context, Zotero, MockItem, items, menus, descriptions, errors, saves, confirms, dialogs, prefStore,
		transactions: () => transactions,
		setSelectedItems: (list) => { selectedItems = list; },
	};
}

async function setup(prefs = {}) {
	let env = makeEnv(Object.assign({ [P + "features.version"]: 3 }, prefs));
	await vm.runInContext(`startup({ id: "zotero-bridge@bobyu89.github.io", version: "0.0.0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);
	let ZB = env.context.ZB;
	// The messy record of the e2e test, an English one with messy fields, and a clean Chinese one
	let messy = new env.MockItem("journalArticle", {
		key: "MESSY", title: "護理人員跌倒預防衛教之成效", date: "民國112年", publicationTitle: "護理雜誌", volume: "70(2)",
		pages: "４５－５６頁", extra: "DOI: 10.6224/JN.202304_70(2).07", language: "",
	}, [{ name: "陳美玲、林小華", creatorType: "author" }, { lastName: "歐", firstName: "陽志明", creatorType: "author" }]);
	let english = new env.MockItem("journalArticle", {
		key: "ENGLISH", title: "Exercise and falls", date: "民國112年", pages: "45~56", language: "zh", extra: "DOI: 10.1016/j.x.2021.01.001",
	}, [{ name: "陳美玲、林小華", creatorType: "author" }]);
	let tidy = new env.MockItem("journalArticle", {
		key: "TIDY", title: "加護病房護理人員之睡眠品質", date: "2020", publicationTitle: "長庚護理", volume: "31", issue: "1", pages: "1-12",
		DOI: "10.3966/102673012020033101001", language: "zh-TW",
	}, [{ lastName: "王", firstName: "大明", creatorType: "author" }]);
	return Object.assign(env, { ZB, messy, english, tidy });
}

const plain = v => JSON.parse(JSON.stringify(v));

/** The review window once it shows the plan. */
async function openedDialog(env, count = 1) {
	for (let i = 0; i < 400; i++) {
		let win = env.dialogs[count - 1];
		if (win && win.document.querySelector(".zb-cl-apply")) return win.document.getElementById("zb-zhmeta");
		await new Promise(r => setTimeout(r, 5));
	}
	throw new Error("the review window never showed the plan");
}

const box = (root, id) => root.querySelector(`[data-zb-finding="${id}"] input[type=checkbox]`);

test("the command opens the review: sure fixes ticked, check-level not, missing data without a checkbox; English and clean items listed apart", async () => {
	let env = await setup();
	let C = env.ZB.commands;
	env.setSelectedItems([env.messy, env.english, env.tidy]);
	let running = C.execute("zh-meta", C.fromWindow(null, "toolbar"));
	let root = await openedDialog(env);
	let doc = root.ownerDocument;
	assert.equal(doc.documentElement.getAttribute("title"), "中文文獻補強");
	assert.ok(root.classList.contains("zb-classify"), "borrows the 文獻自動分類 window's stylesheet");
	assert.equal(root.querySelector(".zb-cl-title").textContent, "中文文獻補強：先看建議，再決定");
	assert.match(root.querySelector(".zb-cl-lead").textContent, /不會連網查/);
	let titles = [...root.querySelectorAll(".zb-cl-item-title")].map(h => h.textContent);
	assert.deepEqual(titles, ["護理人員跌倒預防衛教之成效"], "only the item with findings");
	assert.equal(root.querySelector(".zb-cl-item-meta").textContent, "護理雜誌 · 期刊文章", "no Western year to show yet");
	let rows = [...root.querySelectorAll(".zb-zm-finding")].map(li => [li.dataset.zbFinding, li.dataset.confidence, !!li.querySelector("input"), li.querySelector("input") ? li.querySelector("input").checked : null]);
	assert.deepEqual(rows, [
		["creators-0", "sure", true, true],
		["creators-1", "check", true, false],
		["date", "sure", true, true],
		["volume", "sure", true, true],
		["pages", "sure", true, true],
		["DOI", "sure", true, true],
		["language", "sure", true, true],
	]);
	let pages = root.querySelector('[data-zb-finding="pages"]');
	assert.equal(pages.querySelector(".zb-zm-field").textContent, "頁碼");
	assert.equal(pages.querySelector(".zb-zm-was").textContent, "４５－５６頁");
	assert.equal(pages.querySelector(".zb-zm-now").textContent, "45-56");
	assert.equal(pages.querySelector(".zb-zm-tag").textContent, "有把握");
	assert.equal(root.querySelector('[data-zb-finding="creators-1"] .zb-zm-tag').textContent, "請確認");
	// Each checkbox is labelled by its field and problem and described by the change and the why
	let b = box(root, "pages");
	assert.equal(root.querySelector(`label[for="${b.id}"]`).textContent, "頁碼頁碼寫了「頁」、全形數字或其他符號");
	for (let id of b.getAttribute("aria-describedby").split(" ")) assert.ok(doc.getElementById(id), id);
	assert.equal(doc.activeElement, box(root, "creators-0"), "focus on the first checkbox");
	// The clean Chinese item folds away; the English one is only counted
	assert.equal(root.querySelector(".zb-cl-without summary").textContent, "1 篇中文文獻看起來沒有問題");
	assert.match(root.textContent, /另有 1 篇不是中文文獻，沒有檢查。/);
	assert.equal(root.querySelector(".zb-cl-summary").textContent, "已勾選 6 項修正，會改動 1 篇文獻。");
	assert.equal(root.querySelector(".zb-cl-summary").getAttribute("role"), "status");
	// 全部取消勾選 → nothing to apply; 只勾有把握的 → back to the defaults
	root.querySelector(".zb-zm-none").click();
	assert.equal(root.querySelector(".zb-cl-summary").textContent, "還沒有勾選任何修正。");
	assert.equal(root.querySelector(".zb-cl-apply").disabled, true);
	root.querySelector(".zb-zm-defaults").click();
	assert.equal(root.querySelector(".zb-cl-summary").textContent, "已勾選 6 項修正，會改動 1 篇文獻。");

	// Untick the pages, tick the compound surname, apply
	box(root, "pages").click();
	box(root, "creators-1").click();
	assert.equal(root.querySelector(".zb-cl-summary").textContent, "已勾選 6 項修正，會改動 1 篇文獻。");
	root.querySelector(".zb-cl-apply").click();
	let result = await running;
	assert.equal(result.cancelled, false);
	assert.equal(result.items, 1);
	assert.equal(result.fixes, 6);
	let m = env.messy;
	assert.deepEqual(plain(m.fields), {
		title: "護理人員跌倒預防衛教之成效", date: "2023", publicationTitle: "護理雜誌", volume: "70", issue: "2",
		pages: "４５－５６頁", extra: "", DOI: "10.6224/JN.202304_70(2).07", language: "zh-TW",
	}, "pages unticked: unchanged");
	assert.deepEqual(plain(m.creators), [
		{ name: "陳美玲", creatorType: "author" }, { name: "林小華", creatorType: "author" }, { lastName: "歐陽", firstName: "志明", creatorType: "author" },
	]);
	assert.deepEqual(env.saves, [m.id], "only the reviewed item was saved");
	assert.equal(env.transactions(), 1, "one transaction for the item");
	// The English item and the clean one: untouched
	assert.equal(env.english.fields.pages, "45~56");
	assert.equal(env.english.fields.date, "民國112年");
	assert.equal(env.english.creators[0].name, "陳美玲、林小華");
	assert.match(env.descriptions.at(-1), /已修正 1 篇文獻的 6 處資料。/);
	assert.match(env.descriptions.at(-1), /復原上一次中文文獻修正/);
	// The undo record and the command that uses it
	let last = env.ZB.zhMeta.readLastRun();
	assert.equal(last.items.length, 1);
	assert.deepEqual(plain(last.items[0].fields.date), { before: "民國112年", after: "2023" });
	assert.equal(last.items[0].fields.pages, undefined);
	assert.ok(C.isVisible(C.get("zh-meta-undo")));
	assert.deepEqual(env.errors, []);
});

test("取消, Esc and closing the window write nothing", async () => {
	let env = await setup();
	let before = plain(env.messy.fields);
	let running = env.ZB.zhMeta.run([env.messy]);
	let root = await openedDialog(env);
	root.querySelector(".zb-cl-cancel").click();
	assert.deepEqual(plain(await running), { cancelled: true });
	running = env.ZB.zhMeta.run([env.messy]);
	root = await openedDialog(env, 2);
	root.dispatchEvent(new root.ownerDocument.defaultView.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	assert.deepEqual(plain(await running), { cancelled: true });
	assert.deepEqual(plain(env.messy.fields), before);
	assert.deepEqual(env.saves, []);
	assert.equal(env.ZB.zhMeta.readLastRun(), null);
	assert.ok(!env.ZB.commands.isVisible(env.ZB.commands.get("zh-meta-undo")), "nothing to undo");
});

test("nothing to fix or nothing Chinese: a message, no window; switched off: says where to turn it on", async () => {
	let env = await setup();
	let r = await env.ZB.zhMeta.run([env.tidy]);
	assert.equal(r.checked, 1);
	assert.equal(env.dialogs.length, 0);
	assert.match(env.descriptions.at(-1), /檢查了 1 篇中文文獻，資料看起來沒有問題。/);
	await env.ZB.zhMeta.run([env.english]);
	assert.match(env.descriptions.at(-1), /沒有中文文獻/);
	await env.ZB.zhMeta.run([]);
	assert.match(env.descriptions.at(-1), /請先選取文獻/);
	env.ZB.features.setEnabled("zhMeta", false);
	assert.equal(await env.ZB.zhMeta.run([env.messy]), null);
	assert.match(env.descriptions.at(-1), /「中文文獻補強」目前關閉/);
	assert.equal(env.ZB.zhMeta.paneCount(env.messy), 0, "the panel stays quiet while it is off");
	assert.equal(env.dialogs.length, 0);
});

test("復原上一次中文文獻修正 restores every field, the authors and the item type; a field edited since keeps its new value", async () => {
	let env = await setup();
	let Z = env.ZB.zhMeta;
	let m = env.messy;
	let originalFields = plain(m.fields);
	let originalCreators = plain(m.creators);
	// Everything ticked (as if the user ticked the check-level one too)
	let result = await Z.run([m], { review: async plan => plan.items[0].findings.filter(f => f.changes).map(f => ({ libraryID: 1, key: m.key, id: f.id })) });
	assert.equal(result.fixes, 7);
	assert.equal(m.fields.pages, "45-56");
	// The user fixes the date by hand afterwards
	m.fields.date = "2023-04";
	let undo = await Z.undoLast();
	assert.match(env.confirms.at(-1), /要復原 .* 的中文文獻修正嗎？/);
	assert.equal(undo.items, 1);
	assert.deepEqual(plain(m.creators), originalCreators);
	assert.deepEqual(plain(m.fields), Object.assign({}, originalFields, { date: "2023-04", DOI: "", issue: "" }), "back as it was, except the date edited since");
	assert.deepEqual(plain(undo.kept), ["「護理人員跌倒預防衛教之成效」的日期"]);
	assert.match(env.descriptions.at(-1), /之後又改過、所以保留新值/);
	assert.equal(Z.readLastRun(), null);
	assert.equal(await Z.undoLast(), null);
	assert.match(env.descriptions.at(-1), /沒有可以復原的中文文獻修正/);

	// A thesis imported as a journal article: the type changes, the journal field goes, undo brings both back
	let t = new env.MockItem("journalArticle", { key: "THESIS", title: "加護病房護理人員之睡眠品質", date: "2020", publicationTitle: "國防醫學院護理研究所碩士論文",
		volume: "1", pages: "1-120", url: "https://hdl.handle.net/11296/abc", language: "zh-TW" }, [{ name: "王大明", creatorType: "author" }]);
	let before = plain(t.fields);
	await Z.run([t], { review: async () => [{ libraryID: 1, key: "THESIS", id: "itemType" }] });
	assert.equal(t.itemType, "thesis");
	assert.equal(t.fields.thesisType, "碩士論文");
	assert.equal(t.fields.publicationTitle, undefined, "cleared with the type change, as Zotero does");
	await Z.undoLast({ silent: true });
	assert.equal(t.itemType, "journalArticle");
	assert.deepEqual(plain(t.fields), before);
	assert.deepEqual(env.errors, []);
});

test("a fix that no longer applies when 套用 is pressed (the item was edited meanwhile) is skipped", async () => {
	let env = await setup();
	let m = env.messy;
	let result = await env.ZB.zhMeta.run([m], { review: async (plan) => {
		// While the window is open the user fixes the pages and changes the date in Zotero
		m.fields.pages = "45-56";
		m.fields.date = "民國111年";
		return env.ZB.zhMeta.defaultPicks(plan);
	} });
	assert.equal(result.skipped, 2, "pages (gone) and the date (now suggests another year)");
	assert.equal(m.fields.date, "民國111年");
	assert.equal(m.fields.language, "zh-TW");
	assert.match(env.descriptions.at(-1), /2 項在視窗開著時已經改過或不再適用，略過了。/);
});
