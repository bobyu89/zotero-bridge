// 文獻評讀表 through the real plugin in a mocked Zotero: the item pane form prefilled from the AI note,
// answer clicks, tool switch, notes, two reviewers, 我已核對, the quiet save as a child note, the sync to
// Obsidian (section + frontmatter) and Notion (properties + a real table block), and the collection
// summary (評讀總表 note, CSV, Word Markdown) from the collection menu.
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
const DB = "https://www.notion.so/ws/Default-11111111111111111111111111111111";

// The parts of Zotero, Gecko and the plugin scope that the form, a sync and the summary touch
function makeEnv({ prefs, fetch }) {
	let items = new Map();
	let nextID = 100;
	let progressLines = [];
	let descriptions = [];
	let errors = [];
	let menus = [];
	let panes = [];
	let confirms = [];
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
			this.tags = [];
			this.children = [];
			this.noteHTML = "";
			this.saves = 0;
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
		removeTag(t) { this.tags = this.tags.filter(x => x !== t); }
		getCollections() { return []; }
		getAttachments() { return this.children.filter(id => items.get(id).itemType === "attachment"); }
		getNotes() { return this.children.filter(id => items.get(id).itemType === "note"); }
		getNote() { return this.noteHTML; }
		setNote(h) { this.noteHTML = h; }
		getNoteTitle() { return "note"; }
		getItemTypeIconName() { return this.itemType; }
		async saveTx() {
			this.saves++;
			if (this.parentID && !items.get(this.parentID).children.includes(this.id)) items.get(this.parentID).children.push(this.id);
			return this.id;
		}
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
		ItemPaneManager: { registerSection: (o) => { panes.push(o); return o.paneID; }, unregisterSection: () => true },
		PreferencePanes: { register: async () => "pane" },
		getMainWindows: () => [],
		getMainWindow: () => ({}),
		getActiveZoteroPane: () => null,
		launchURL: (u) => { launched.push(u); },
		Items: {
			get: ids => (Array.isArray(ids) ? ids.map(id => items.get(id)) : items.get(ids)),
			getAll: async () => [...items.values()],
			getByLibraryAndKey: (libraryID, key) => [...items.values()].find(i => i.libraryID === libraryID && i.key === key) || false,
			exists: id => items.has(id),
		},
		Libraries: {
			get: () => ({ libraryType: "user", name: "My Library" }),
			getAll: () => [{ libraryID: 1, libraryType: "user", name: "My Library" }],
		},
		Groups: { getGroupIDFromLibraryID: () => null },
		Collections: { get: ids => (Array.isArray(ids) ? [] : null), getByParent: () => [] },
		Tags: { getID: () => false },
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
		move: async (a, b) => fsp.rename(a, b),
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
	return { context, MockItem, addChild, items, progressLines, descriptions, errors, menus, panes, confirms, launched, prefStore };
}

// Notion: one data source with the plugin's full schema, pages by Zotero key, and the managed container
function notionMock(log, state) {
	let ok = json => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(json) });
	return async (url, init) => {
		let body = init.body ? JSON.parse(init.body) : undefined;
		let p = url.replace("https://api.notion.com/v1/", "");
		log.push({ method: init.method, path: p, body });
		if (p.startsWith("databases/")) return ok({ data_sources: [{ id: "ds-1" }] });
		if (p === "data_sources/ds-1" && init.method === "GET") {
			let props = { Name: { type: "title" } };
			for (let [k, v] of Object.entries(require("../content/notion.js").PROPERTY_SCHEMA)) props[k] = { type: Object.keys(v)[0] };
			return ok({ properties: props });
		}
		if (p === "data_sources/ds-1/query") {
			let keys = body.filter.or ? body.filter.or.map(f => f.rich_text.equals) : [body.filter.rich_text.equals];
			return ok({ results: keys.filter(k => state.pages.has(k)).map(k => state.pages.get(k)), has_more: false });
		}
		if (p === "pages" && init.method === "POST") {
			let id = `page-${state.pages.size + 1}`;
			let page = { id, url: `https://www.notion.so/${id}`, properties: body.properties };
			state.pages.set(body.properties["Zotero Key"].rich_text[0].text.content, page);
			return ok(page);
		}
		let m = /^pages\/([^/?]+)$/.exec(p);
		if (m) {
			let page = [...state.pages.values()].find(pg => pg.id === m[1]);
			if (body && body.properties) Object.assign(page.properties, body.properties);
			return ok(page);
		}
		if (/^blocks\/page-\d+\/children\?/.test(p)) return ok({ results: [], has_more: false });
		if ((m = /^blocks\/(page-\d+)\/children$/.exec(p))) {
			let id = `container-${m[1]}`;
			// The container's children as Notion lists them back (with ids and plain_text)
			state.containers[id] = body.children[0].callout.children.map((b, i) => {
				let copy = JSON.parse(JSON.stringify(b));
				for (let r of (copy[copy.type] && copy[copy.type].rich_text) || []) r.plain_text = r.text.content;
				return Object.assign({ id: `${id}-b${i}` }, copy);
			});
			return ok({ results: [{ id }] });
		}
		if ((m = /^blocks\/(container-page-\d+)\/children\?/.exec(p))) return ok({ results: state.containers[m[1]] || [], has_more: false });
		if ((m = /^blocks\/(container-page-\d+)\/children$/.exec(p))) {
			state.appended.push({ container: m[1], body });
			return ok({ results: body.children.map((b, i) => ({ id: `t${i}` })) });
		}
		return { status: 404, ok: false, headers: { get: () => null }, text: async () => JSON.stringify({ message: p }) };
	};
}

const JBI_SECTION = `<h2>嚴格評讀</h2><ul><li>評讀工具：JBI Checklist for Randomized Controlled Trials</li></ul><ol>
<li>是否真正隨機分派：是 — 電腦亂數分派</li><li>分派是否隱匿：不清楚 — 未說明</li><li>基準期是否相似：是 — 兩組 p &gt; .05</li>
<li>受試者是否設盲：否 — 衛教無法盲化</li><li>執行介入者是否設盲：否</li><li>各組照護是否相同：是</li><li>評估者是否設盲：不清楚</li>
<li>測量方式是否相同：是</li><li>測量是否可信：是</li><li>追蹤是否完整：是 — 流失 5%</li><li>是否 ITT：是</li><li>統計是否適當：是</li><li>設計是否適當：是</li></ol>
<ul><li>整體評價：納入 — 偏差風險低</li></ul>`;

function aiNote(env, parent, sections, data) {
	let note = new env.MockItem("note");
	note.noteHTML = "<h1>🤖 AI 文獻筆記</h1><p><em>由 test-model 於 2026-10-01T00:00:00Z 產生（Zotero Bridge）</em></p>"
		+ sections + `<h2>📋 結構化資料（Zotero Bridge）</h2><pre>${JSON.stringify(data, null, 2)}</pre>`;
	note.tags = ["zotero-bridge-ai"];
	env.addChild(parent, note);
	return note;
}

test("文獻評讀表: pane prefilled from the AI note → answers, B reviewer, 我已核對 → quiet save → sync → collection summary", async () => {
	let vault = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-vault-"));
	let log = [];
	let state = { pages: new Map(), containers: {}, appended: [] };
	let env = makeEnv({
		fetch: notionMock(log, state),
		prefs: {
			"extensions.zotero-bridge.obsidian.vaultPath": vault,
			"extensions.zotero-bridge.obsidian.folder": "Zotero",
			"extensions.zotero-bridge.obsidian.createBase": false,
			"extensions.zotero-bridge.notion.token": "ntn_test",
			"extensions.zotero-bridge.notion.database": DB,
			"extensions.zotero-bridge.llm.enabled": false,
		},
	});
	await vm.runInContext(`startup({ id: "zb", version: "0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);
	let ZB = env.context.ZB;
	assert.equal(typeof ZB.appraisalTools.getTool, "function", "appraisal-tools.js is loaded as ZB.appraisalTools");

	let chen = new env.MockItem("journalArticle", {
		title: "Nurse-led education and falls: a randomized controlled trial", year: "2024", citationKey: "chen2024",
		creators: [{ lastName: "Chen", firstName: "Mei", creatorType: "author" }],
	});
	let chenAI = aiNote(env, chen, "<h2>一句話摘要</h2><p>護理師主導衛教使跌倒率降低 30%。</p>" + JBI_SECTION, {
		study_design: "RCT", sample_size: 120, appraisal_tool: "JBI Checklist for Randomized Controlled Trials", appraisal_overall: "納入",
	});
	let aiHTML = chenAI.noteHTML;
	let lee = new env.MockItem("journalArticle", {
		title: "Fall prevention in nursing homes", year: "2021", citationKey: "lee2021", creators: [{ lastName: "Lee", creatorType: "author" }],
	});
	aiNote(env, lee, "<h2>一句話摘要</h2><p>衛教有效。</p>" + JBI_SECTION.replace("不清楚 — 未說明", "是 — 中央分派"), {
		study_design: "RCT", sample_size: 80, appraisal_tool: "JBI Checklist for Randomized Controlled Trials", appraisal_overall: "納入",
	});
	let wu = new env.MockItem("journalArticle", { title: "Falls survey", year: "2020", citationKey: "wu2020", creators: [{ lastName: "Wu", creatorType: "author" }] });

	// ---- Item pane: the 文獻評讀表 row inside the AI note section ----
	let doc = new JSDOM("<div id=b></div>").window.document;
	let body = doc.getElementById("b");
	let render = item => env.panes[0].onRender({ doc, body, item, setSectionSummary: () => {} });
	render(chen);
	let row = () => body.querySelector("[data-zb-appraisal]");
	assert.match(row().textContent, /文獻評讀表：AI 初評，尚未核對（未儲存） · JBI 隨機對照試驗偏差風險評讀工具（2023 修訂版） · 已答 13\/13 · 納入/);
	let action = name => row().querySelector(`[data-zb-action="${name}"]`);
	let answerButton = (id, answer, reviewer = "A") => row().querySelector(`[data-zb-item="${id}"] [data-zb-answer="${answer}"][data-zb-reviewer="${reviewer}"]`);
	let pressed = (id, reviewer = "A") => [...row().querySelectorAll(`[data-zb-item="${id}"] [data-zb-reviewer="${reviewer}"]`)].filter(b => b.getAttribute("aria-pressed") === "true").map(b => b.textContent);
	action("toggle").click();
	// Prefilled from the AI note, marked as AI
	assert.equal(row().querySelector("select").value, "jbi-rct");
	assert.deepEqual(pressed("1"), ["是"]);
	assert.deepEqual(pressed("2"), ["不清楚"]);
	assert.equal(row().querySelector('[data-zb-item="1"] span').textContent, "AI");
	assert.equal(row().querySelector('[data-zb-note="1"]').value, "電腦亂數分派");
	assert.match(row().textContent, /JBI Critical Appraisal Tool for the Assessment of Risk of Bias for Randomized Controlled Trials \(2023\)/);
	assert.match(row().textContent, /題目為中文意譯，非官方原文/);
	row().querySelector("a").click();
	assert.deepEqual(env.launched, ["https://jbi.global/critical-appraisal-tools"]);

	// Switch to CASP (TWNA prefers it): items start empty, the verdict is kept; no confirm without own answers
	let select = row().querySelector("select");
	select.value = "casp-rct";
	select.dispatchEvent(new doc.defaultView.Event("change"));
	assert.equal(env.confirms.length, 0);
	assert.equal(row().querySelector("select").value, "casp-rct");
	assert.equal(row().querySelectorAll("[data-zb-item]").length, 13);
	assert.deepEqual(pressed("1"), []);
	assert.match(row().textContent, /Section A：研究設計是否有效/);

	// Answer every CASP item, with notes on some
	let answers = { 1: "是", 2: "是", 3: "否", "4a": "否", "4b": "否", "4c": "是", 5: "是", 6: "是", 7: "是", 8: "是", 9: "不清楚", 10: "是", 11: "不適用" };
	for (let [id, a] of Object.entries(answers)) answerButton(id, a).click();
	assert.deepEqual(pressed("3"), ["否"]);
	assert.equal(row().querySelector('[data-zb-item="3"] span').textContent, "✓");
	let note = (id, text) => {
		let input = row().querySelector(`[data-zb-note="${id}"]`);
		input.value = text;
		input.dispatchEvent(new doc.defaultView.Event("input"));
	};
	note("2", "電腦亂數分派，信封保密");
	note("3", "流失 25%，未做 ITT");
	note("overall", "研究品質尚可");
	// Clicking the chosen answer again clears it; click again to set it back
	answerButton("9", "不清楚").click();
	assert.deepEqual(pressed("9"), []);
	answerButton("9", "不清楚").click();
	assert.match(row().querySelector("[data-zb-summary]").textContent, /^是 8／否 3／不清楚 1／不適用 1（共 13 題，已答 13 題，「是」占 67%）$/);
	assert.match(row().textContent, /有尚未儲存的修改/);

	// Reviewer B on a few items
	let dual = row().querySelector('[data-zb-action="dual"]');
	dual.checked = true;
	dual.dispatchEvent(new doc.defaultView.Event("change"));
	for (let [id, a] of Object.entries({ 1: "是", 2: "否", 3: "否", "4a": "否" })) answerButton(id, a, "B").click();
	assert.match(row().textContent, /評讀者一致性：κ = 0\.50（中等一致）；一致率 75%（3\/4）/);

	// Overall verdict and 我已核對
	let selects = row().querySelectorAll("select");
	selects[1].value = "需更多資訊";
	selects[1].dispatchEvent(new doc.defaultView.Event("change"));
	let verified = row().querySelector('[data-zb-action="verified"]');
	verified.checked = true;
	verified.dispatchEvent(new doc.defaultView.Event("change"));
	assert.match(row().textContent, /我已核對（逐題確認 AI 初評與評析根據）：\d{4}-\d{2}-\d{2}/);

	// ---- Save: a child note, quietly (item and note marked as our own change), AI note untouched ----
	let marked = [];
	let mark = ZB.main.markSelfModified;
	ZB.main.markSelfModified = (...ids) => {
		marked.push(...ids);
		return mark(...ids);
	};
	action("save").click();
	await new Promise(r => setTimeout(r, 20));
	ZB.main.markSelfModified = mark;
	assert.deepEqual(env.errors, []);
	let formNote = env.context.Zotero.Items.get(chen.getNotes()).find(n => n.tags.includes("zotero-bridge-appraisal"));
	assert.ok(formNote, "child note with the tag");
	assert.equal(formNote.parentID, chen.id);
	assert.ok(marked.includes(chen.id) && marked.includes(formNote.id), "the save is quiet for auto-sync");
	assert.equal(chenAI.noteHTML, aiHTML, "the AI note is never overwritten");
	assert.match(formNote.noteHTML, /^<h1>📝 文獻評讀表<\/h1>/);
	assert.match(formNote.noteHTML, /<td>3\. 所有進入研究的受試者在研究結束時是否都有交代？<\/td><td>否<\/td><td>流失 25%，未做 ITT<\/td>/);
	let saved = ZB.appraisalForm.readNoteHTML(formNote.noteHTML);
	assert.equal(saved.tool, "casp-rct");
	assert.equal(saved.verified, true);
	assert.match(saved.verifiedAt, /^\d{4}-\d{2}-\d{2}$/);
	assert.equal(saved.overall, "需更多資訊");
	assert.equal(saved.overallNote, "研究品質尚可");
	assert.equal(saved.dual, true);
	assert.deepEqual(JSON.parse(JSON.stringify(saved.answers["2"])), { answer: "是", note: "電腦亂數分派，信封保密", source: "human" });
	assert.equal(saved.answersB["2"].answer, "否");
	assert.match(row().textContent, /已儲存為子筆記「📝 文獻評讀表」/);
	// Saving again updates the same note
	action("save").click();
	await new Promise(r => setTimeout(r, 20));
	assert.equal(env.context.Zotero.Items.get(chen.getNotes()).filter(n => n.tags.includes("zotero-bridge-appraisal")).length, 1);
	// A fresh render reads the saved form
	render(chen);
	assert.match(row().textContent, /文獻評讀表：已核對（\d{4}-\d{2}-\d{2}） · CASP 隨機對照試驗評讀表（2024 版） · 已答 13\/13 · 需更多資訊/);
	// The form note is not a user note: not in the item data's notes
	let data = await ZB.adapter.extractItemData(chen, {});
	assert.equal(data.notes.length, 0);
	assert.equal(data.appraisalNote.key, formNote.key);

	// ---- Sync: Obsidian and Notion ----
	await ZB.main.run([chen, lee], { targets: ["notion", "obsidian"], ai: "reuse" });
	assert.deepEqual(env.errors, []);
	let chenMd = fs.readFileSync(path.join(vault, "Zotero", "chen2024.md"), "utf8");
	assert.match(chenMd, /\nappraisal_tool: "CASP Checklist: For Randomised Controlled Trials \(RCTs\) \(2024\)"\n/);
	assert.match(chenMd, /\nappraisal_overall: "需更多資訊"\n/);
	assert.match(chenMd, /\nappraisal_verified: true\n/);
	assert.match(chenMd, /\n## 文獻評讀表\n\n> \[!success\] 已核對（\d{4}-\d{2}-\d{2}）\n/);
	assert.match(chenMd, /\| 3\. 所有進入研究的受試者在研究結束時是否都有交代？ \| 否 \| 流失 25%，未做 ITT \|/);
	assert.match(chenMd, /\*\*整體評價\*\*：需更多資訊 — 研究品質尚可/);
	assert.match(chenMd, /\*\*雙人評讀\*\*：評讀者 A／B；κ = 0\.50/);
	assert.doesNotMatch(chenMd, /## Zotero Notes/, "the form note is not synced as a user note");
	let leeMd = fs.readFileSync(path.join(vault, "Zotero", "lee2021.md"), "utf8");
	assert.match(leeMd, /\nappraisal_tool: "JBI Checklist for Randomized Controlled Trials"\n/);
	assert.match(leeMd, /\nappraisal_verified: false\n/);
	assert.match(leeMd, /## 文獻評讀表\n\n> \[!warning\] AI 初評，尚未核對\n> 評讀工具：\[JBI Critical Appraisal Tool/);
	assert.match(leeMd, /\| 2\. 分派至各組的過程是否隱匿？ \| 是 \| 中央分派 \|/);

	let chenPage = state.pages.get(`library/${chen.key}`);
	assert.deepEqual(chenPage.properties["Appraisal Verified"], { checkbox: true });
	assert.deepEqual(chenPage.properties["Appraisal Tool"], { select: { name: "CASP Checklist: For Randomised Controlled Trials (RCTs) (2024)" } });
	assert.deepEqual(chenPage.properties.Appraisal, { select: { name: "需更多資訊" } });
	let leePage = state.pages.get(`library/${lee.key}`);
	assert.deepEqual(leePage.properties["Appraisal Verified"], { checkbox: false });
	assert.deepEqual(leePage.properties["Appraisal Tool"], { select: { name: "JBI Checklist for Randomized Controlled Trials" } });
	// The table: a real table block right after the status callout under 「文獻評讀表」
	let blocks = state.containers[`container-${chenPage.id}`];
	let heading = blocks.findIndex(b => b.type === "heading_2" && b.heading_2.rich_text.map(r => r.plain_text).join("") === "文獻評讀表");
	assert.ok(heading > 0);
	assert.doesNotMatch(JSON.stringify(blocks), /評讀項目 ｜/, "no paragraph rows for the table");
	let append = state.appended.find(a => a.container === `container-${chenPage.id}`);
	assert.equal(append.body.after, blocks[heading + 1].id);
	assert.equal(append.body.children[0].type, "table");
	assert.equal(append.body.children[0].table.children.length, 14);
	assert.equal(state.appended.length, 2, "one table per page");

	// ---- Collection summary from the collection menu ----
	let collection = { id: 7, key: "COLL0001", name: "跌倒實證", libraryID: 1, getChildItems: () => [chen, lee, wu] };
	let menu = env.menus.find(m => m.menuID === "zotero-bridge-appraisal-collection").menus[0];
	assert.equal(menu.l10nID, "zotero-bridge-appraisal-summary");
	let visible;
	menu.onShowing({}, { collectionTreeRows: [{ isCollection: () => true, ref: collection }], setVisible: (v) => { visible = v; } });
	assert.equal(visible, true);
	menu.onCommand({}, { collectionTreeRows: [{ isCollection: () => true, ref: collection }] });
	await ZB.main.run([], {});
	assert.deepEqual(env.errors, []);
	let dir = path.join(vault, "Zotero", "Reviews");
	let summary = fs.readFileSync(path.join(dir, "跌倒實證 評讀總表.md"), "utf8");
	assert.match(summary, /^---\ntitle: "跌倒實證：文獻評讀總表"\ntype: "appraisal-summary"\nzotero_collection: "1\/COLL0001"/);
	assert.match(summary, /\nappraisal_verified: 1\nappraisal_unverified: 1\n/);
	assert.match(summary, /\| 已核對（研究者確認） \| 1 \|\n\| 尚未核對（AI 初評或評讀中） \| 1 \|\n\| 沒有評讀資料 \| 1 \|/);
	assert.match(summary, /\| \[\[Zotero\/chen2024\\\|Chen, 2024\]\] \| ✅ \| ✅ \| ❌ \| ❌ \| ❌ \| ✅ \| ✅ \| ✅ \| ✅ \| ✅ \| ❓ \| ✅ \| ➖ \| 需更多資訊 \| 已核對 \|/);
	assert.match(summary, /\| \[\[Zotero\/lee2021\\\|Lee, 2021\]\] \| ✅ \| ✅ \| ✅ \| ❌ \| ❌ \| ✅ \| ❓ \| ✅ \| ✅ \| ✅ \| ✅ \| ✅ \| ✅ \| 納入 \| 未核對 \|/);
	assert.match(summary, /## 各篇評讀表[\s\S]*### \[\[Zotero\/chen2024\\\|Chen, 2024\]\]\n\n> \[!success\]/);
	assert.match(summary, /\| \*\*合計\*\* \| {2}\| 4 \| 3 \| 75% \| 0\.50 \| 中等一致 \|/);
	assert.match(summary, /## 沒有評讀資料的文獻\n\n- Wu, 2020/);
	assert.match(summary, /pandoc "跌倒實證 評讀總表（Word）\.md" -o "跌倒實證 評讀總表\.docx"/);
	let csv = fs.readFileSync(path.join(dir, "跌倒實證 評讀總表.csv"), "utf8");
	assert.ok(csv.startsWith("﻿文獻,標題,評讀工具,題號"));
	assert.equal(csv.split("\r\n").length, 1 + 13 + 13 + 1 + 1);
	let word = fs.readFileSync(path.join(dir, "跌倒實證 評讀總表（Word）.md"), "utf8");
	assert.match(word, /^# 跌倒實證：文獻評讀總表\n/);
	assert.doesNotMatch(word, /\[\[|\[!/);
	let line = env.progressLines.find(l => /^跌倒實證：/.test(l.text));
	assert.equal(line.text, "跌倒實證：3 篇（已核對 1、尚未核對 1、沒有評讀 1）");
	assert.ok(env.descriptions.includes("⚠️ 1 篇仍是 AI 初評或評讀中，尚未核對。"), env.descriptions.join("\n"));

	// Re-run keeps the user's text in the summary
	fs.writeFileSync(path.join(dir, "跌倒實證 評讀總表.md"), summary.replace("## ✍️ 我的筆記\n\n", "## ✍️ 我的筆記\n\n第二位評讀者為指導教授。\n"));
	menu.onCommand({}, { collectionTreeRows: [{ isCollection: () => true, ref: collection }] });
	await ZB.main.run([], {});
	let summary2 = fs.readFileSync(path.join(dir, "跌倒實證 評讀總表.md"), "utf8");
	assert.match(summary2, /第二位評讀者為指導教授。/);
	assert.equal(summary2.match(/zotero-bridge:start/g).length, 1);

	// Tools menu entry and the Fluent IDs
	let tools = env.menus.find(m => m.menuID === "zotero-bridge-appraisal-tools").menus[0];
	assert.equal(tools.l10nID, "zotero-bridge-appraisal-tools-summary");
	for (let lang of ["zh-TW", "en-US"]) {
		let ftl = fs.readFileSync(path.join(ROOT, "locale", lang, "zotero-bridge.ftl"), "utf8");
		for (let id of ["zotero-bridge-appraisal-summary", "zotero-bridge-appraisal-tools-summary"]) assert.match(ftl, new RegExp(`^${id} =\\n {4}\\.label = .+$`, "m"), `${lang} ${id}`);
	}
	await vm.runInContext("shutdown()", env.context);
});

test("文獻評讀表: changing the tool after own answers asks first; discard reloads; screening and EBHC use the verified form", async () => {
	let env = makeEnv({ fetch: async () => { throw new Error("no network"); }, prefs: { "extensions.zotero-bridge.llm.enabled": false } });
	await vm.runInContext(`startup({ id: "zb", version: "0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);
	let ZB = env.context.ZB;
	let item = new env.MockItem("journalArticle", { title: "Qualitative study of fear of falling", year: "2023", creators: [{ lastName: "Lin", creatorType: "author" }] });
	aiNote(env, item, "<h2>一句話摘要</h2><p>害怕跌倒的經驗。</p>", { study_design: "qualitative", appraisal_tool: null });
	let doc = new JSDOM("<div id=b></div>").window.document;
	let body = doc.getElementById("b");
	env.panes[0].onRender({ doc, body, item, setSectionSummary: () => {} });
	let row = () => body.querySelector("[data-zb-appraisal]");
	assert.match(row().textContent, /文獻評讀表：尚未評讀/);
	row().querySelector('[data-zb-action="toggle"]').click();
	// No AI appraisal: the tool comes from study_design (CASP first)
	assert.equal(row().querySelector("select").value, "casp-qualitative");
	row().querySelector('[data-zb-item="1"] [data-zb-answer="是"]').click();
	// Switching now asks; declining keeps everything
	let prompt = env.context.Services.prompt;
	prompt.confirm = () => false;
	let select = row().querySelector("select");
	select.value = "jbi-qualitative";
	select.dispatchEvent(new doc.defaultView.Event("change"));
	assert.equal(row().querySelector("select").value, "casp-qualitative");
	assert.equal(row().querySelector('[data-zb-item="1"] [aria-pressed="true"]').textContent, "是");
	// Discard: back to the stored state (nothing saved yet)
	row().querySelector('[data-zb-action="discard"]').click();
	await new Promise(r => setTimeout(r, 0));
	assert.equal(row().querySelector('[data-zb-item="1"] [aria-pressed="true"]'), null);
	assert.equal(row().querySelector('[data-zb-action="discard"]'), null);

	// A verified form for the screening evidence table and the EBHC report
	let record = ZB.appraisalTools.normalizeRecord({ tool: "jbi-qualitative", answers: { 1: "是" }, overall: "排除", verified: true, verifiedAt: "2026-10-08" });
	await ZB.appraisalForm.saveRecord(item, record);
	let study = { study_design: "qualitative", appraisal_tool: "CASP Qualitative Checklist", appraisal_overall: "納入" };
	assert.deepEqual(JSON.parse(JSON.stringify(ZB.appraisalForm.overrideStudyForItem(item, study))),
		Object.assign({}, study, { appraisal_tool: "JBI Checklist for Qualitative Research", appraisal_overall: "排除" }));
	let data = await ZB.adapter.extractItemData(item, {});
	let src = ZB.appraisalForm.applyToSource({ data, aiMarkdown: ZB.main.readAINote(data.aiNote.html).md, study });
	assert.match(src.aiMarkdown, /## 嚴格評讀\n- 評讀工具：JBI Checklist for Qualitative Research（研究者已逐題核對，2026-10-08）/);
	assert.deepEqual(env.errors, []);
	await vm.runInContext("shutdown()", env.context);
});
