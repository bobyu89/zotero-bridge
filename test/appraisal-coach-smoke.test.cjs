// 評讀陪練 through the real plugin in a mocked Zotero (the environment is copied from appraisal-smoke): 「對照 AI」
// disabled until the user answered every item, the cost confirm (cancel = no request), the request (the paper,
// never the user's answers; Claude and OpenAI), only the disagreements listed with verified quotes, 保留／改成
// recorded in the form's JSON, the usage ledger, the synced line, and the switch off / no API key cases.
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

const FULL_TEXT = [
	"Nurse-led education and falls: a randomised controlled trial",
	"## Methods",
	"Patients aged 65 years or older were randomly assigned to the intervention or the control group using a computer-generated sequence.",
	"Allocation was concealed in sealed opaque envelopes prepared by an independent statistician.",
	"\f",
	"## Results",
	"All randomised participants were analysed in the groups to which they were assigned, following the intention-to-treat principle.",
	"Outcome assessors were not blinded to group allocation because of the nature of the intervention.",
	"The intervention reduced the rate of falls by thirty percent compared with usual care.",
].join("\n");

function makeEnv({ prefs, fetch, confirm = () => true }) {
	let items = new Map();
	let nextID = 100;
	let progressLines = [];
	let descriptions = [];
	let errors = [];
	let panes = [];
	let confirms = [];
	let opened = [];
	let notifications = [];

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
			this.dateAdded = "2024-05-01 08:00:00";
			this.dateModified = "2024-05-02 08:00:00";
			items.set(this.id, this);
		}
		get parentItem() { return this.parentID ? items.get(this.parentID) : undefined; }
		isRegularItem() { return !["note", "attachment", "annotation"].includes(this.itemType); }
		isNote() { return this.itemType === "note"; }
		isFileAttachment() { return this.itemType === "attachment"; }
		isPDFAttachment() { return this.itemType === "attachment"; }
		get attachmentContentType() { return "application/pdf"; }
		get attachmentText() { return Promise.resolve(this.fields.fulltext || ""); }
		async getFilePathAsync() { return false; }
		getAnnotations() { return []; }
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
		MenuManager: { registerMenu: o => o.menuID, unregisterMenu: () => true },
		Notifier: { registerObserver: () => "obs", unregisterObserver: () => {} },
		ItemPaneManager: { registerSection: (o) => { panes.push(o); return o.paneID; }, unregisterSection: () => true },
		PreferencePanes: { register: async () => "pane" },
		getMainWindows: () => [],
		getMainWindow: () => ({}),
		getActiveZoteroPane: () => null,
		launchURL: () => {},
		Reader: { open: async (id, location) => { opened.push({ id, location }); } },
		Items: {
			get: ids => (Array.isArray(ids) ? ids.map(id => items.get(id)) : items.get(ids)),
			getAll: async () => [...items.values()],
			getByLibraryAndKey: (libraryID, key) => [...items.values()].find(i => i.libraryID === libraryID && i.key === key) || false,
			exists: id => items.has(id),
		},
		Libraries: {
			userLibraryID: 1,
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
			changeHeadline(h) { notifications.push(h); }
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
			prompt: { confirm: (win, title, text) => { confirms.push(text); return confirm(text); } },
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
	return { context, MockItem, addChild, items, progressLines, descriptions, errors, panes, confirms, opened, prefStore, notifications };
}

async function until(fn, what, ms = 3000) {
	let end = Date.now() + ms;
	while (Date.now() < end) {
		if (fn()) return;
		await new Promise(r => setTimeout(r, 5));
	}
	throw new Error(`timed out waiting for ${what}`);
}

// The AI's own appraisal, from the paper alone: it differs from the user on item 3 (with a real quote) and
// on item 5 (with an invented one); the rest agrees with the user's answers below
const USER = { 1: "是", 2: "是", 3: "否", "4a": "否", "4b": "否", "4c": "否", 5: "是", 6: "是", 7: "是", 8: "是", 9: "不清楚", 10: "是", 11: "不適用" };
function aiAnswer() {
	let items = Object.entries(USER).map(([id, answer]) => ({ id, answer, reason: `第 ${id} 題的理由。`, quotes: [] }));
	items.find(i => i.id === "3").answer = "是";
	items.find(i => i.id === "3").reason = "所有隨機分派的受試者都依原分組分析（ITT）。";
	items.find(i => i.id === "3").quotes = [{ text: "All randomised participants were analysed in the groups to which they were assigned", page: "5" }];
	items.find(i => i.id === "5").answer = "否";
	items.find(i => i.id === "5").quotes = [{ text: "Baseline characteristics differed markedly between the two groups", page: "4" }];
	items.find(i => i.id === "2").quotes = [{ text: "Allocation was concealed in sealed opaque envelopes", page: "" }];
	return "```json\n" + JSON.stringify({ items }) + "\n```";
}

function claudeMock(calls, text = aiAnswer()) {
	return async (url, init) => {
		calls.push({ url, init, body: JSON.parse(init.body) });
		if (!url.startsWith("https://api.anthropic.com/")) throw new Error(`unexpected ${url}`);
		return {
			status: 200, ok: true, headers: { get: () => null },
			text: async () => JSON.stringify({ model: "test-model", stop_reason: "end_turn", content: [{ type: "text", text }], usage: { input_tokens: 5000, output_tokens: 800 } }),
		};
	};
}

async function setup({ fetch, confirm, prefs = {} } = {}) {
	let env = makeEnv({
		fetch, confirm,
		prefs: Object.assign({ [P + "features.version"]: 3, [P + "feature.appraisalCoach"]: true, [P + "obsidian.createBase"]: false, [P + "llm.fullTextLimit"]: "150000" }, prefs),
	});
	await vm.runInContext(`startup({ id: "zb", version: "0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);
	let ZB = env.context.ZB;
	await ZB.secrets.set("anthropicKey", "sk-ant-test");
	let paper = new env.MockItem("journalArticle", {
		title: "Nurse-led education and falls: a randomised controlled trial", year: "2024",
		abstractNote: "A randomised trial of nurse-led education.", creators: [{ lastName: "Chen", creatorType: "author" }],
	});
	let pdf = new env.MockItem("attachment", { title: "Full Text PDF", fulltext: FULL_TEXT, key: "PDFKEY01" });
	env.addChild(paper, pdf);
	let doc = new JSDOM("<div id=b></div>").window.document;
	let body = doc.getElementById("b");
	let render = () => env.panes[0].onRender({ doc, body, item: paper, setSectionSummary: () => {} });
	render();
	let row = () => body.querySelector("[data-zb-appraisal]");
	return { env, ZB, paper, pdf, doc, body, render, row };
}

function answerAll(row, answers = USER) {
	for (let [id, a] of Object.entries(answers)) row().querySelector(`[data-zb-item="${id}"] [data-zb-answer="${a}"][data-zb-reviewer="A"]`).click();
}

function chooseCASP(s) {
	let select = s.row().querySelector("select");
	select.value = "casp-rct";
	select.dispatchEvent(new s.doc.defaultView.Event("change"));
}

test("評讀陪練: disabled until every item is the user's own → confirm (cancel sends nothing) → only the disagreements → 保留／改成 recorded", async () => {
	let calls = [];
	let answerConfirm = false;
	let s = await setup({ fetch: claudeMock(calls), confirm: () => answerConfirm });
	let { env, ZB, row } = s;
	// The row in 狀態: 「對照 AI」 next to 「開啟評讀表」, disabled with the reason
	let rowButton = row().querySelector('[data-zb-action="coach"]');
	assert.ok(rowButton, "the row has 對照 AI");
	assert.equal(rowButton.disabled, true);
	assert.match(rowButton.title, /^先自己答完每一題/);
	row().querySelector('[data-zb-action="toggle"]').click();
	chooseCASP(s);
	let coach = () => row().querySelector('[data-zb-action="coach"]');
	assert.equal(row().querySelectorAll('[data-zb-action="coach"]').length, 1, "the open form has its own, in its action row");
	assert.equal(coach().disabled, true);
	assert.match(row().querySelector("[data-zb-coach-hint]").textContent, /^先自己答完每一題，才能對照 AI：第 1、2、3/);
	// Half-way: still disabled
	answerAll(row, { 1: "是", 2: "是" });
	assert.equal(coach().disabled, true);
	assert.match(coach().title, /第 3、4a/);
	answerAll(row, Object.fromEntries(Object.entries(USER).slice(2)));
	assert.equal(coach().disabled, false, "every item answered");
	assert.match(row().querySelector("[data-zb-coach-hint]").textContent, /你已答完每一題/);
	let note = row().querySelector('[data-zb-note="3"]');
	note.value = "流失 10% 未做 ITT（MY-OWN-NOTE）";
	note.dispatchEvent(new s.doc.defaultView.Event("input"));
	// The command says why it can't run yet, from anywhere; the catalog entry is the same
	assert.equal(ZB.commands.get("appraisal-coach").blocked({ items: [s.paper] }), "");

	// Cancel at the cost confirm: nothing is sent, nothing saved
	coach().click();
	await until(() => env.confirms.length === 1, "the confirm");
	await new Promise(r => setTimeout(r, 20));
	assert.equal(calls.length, 0, "cancelled: no request");
	assert.match(env.confirms[0], /評讀陪練會把這篇的全文和「CASP 隨機對照試驗評讀表（2024 版）」的 13 題送給 /);
	assert.match(env.confirms[0], /你的答案和評析不會送出，比對差異的是 ZotMax，不是 AI/);
	assert.match(env.confirms[0], /(預估費用：約 (< )?US\$|沒有價格資料)/);
	assert.match(env.confirms[0], /會先儲存目前的評讀表。要繼續嗎？$/);
	assert.equal(ZB.appraisalForm.getFormNote(s.paper), null);

	// Confirm: one request, the paper and the item IDs only
	answerConfirm = true;
	coach().click();
	await until(() => ZB.appraisalForm.getFormNote(s.paper) && !ZB.appraisalForm.stateFor(s.paper).coachBusy, "the run to finish");
	assert.deepEqual(env.errors, []);
	assert.equal(calls.length, 1);
	let req = calls[0];
	assert.equal(req.url, "https://api.anthropic.com/v1/messages");
	assert.equal(req.init.headers["x-api-key"], "sk-ant-test");
	assert.equal(req.body.system.length, 2, "instructions + checklist");
	assert.deepEqual(req.body.system[1].cache_control, { type: "ephemeral" }, "the checklist ends the cached prefix");
	assert.match(req.body.system[1].text, /^<checklist>/);
	let user = req.body.messages[0].content;
	assert.match(user, /Allocation was concealed in sealed opaque envelopes/);
	assert.match(user, /逐題作答以下 13 題/);
	assert.doesNotMatch(JSON.stringify(req.body), /MY-OWN-NOTE|你的答案|"answer":"否"/, "the user's answers and notes never go out");

	// Results: only the two disagreements, with the summary; agreements folded
	let section = () => row().querySelector("[data-zb-coach]");
	assert.equal(section().querySelector("[data-zb-coach-summary]").textContent, "13 題中 11 題一致，2 題不同（一致 85%）");
	let blocks = () => [...section().children].filter(e => e.hasAttribute("data-zb-coach-item"));
	assert.deepEqual(blocks().map(b => b.getAttribute("data-zb-coach-item")), ["3", "5"]);
	let b3 = blocks()[0];
	assert.match(b3.textContent, /^3\. 所有進入研究的受試者在研究結束時是否都有交代？/);
	assert.equal(b3.querySelector("[data-zb-coach-user]").textContent, "否");
	assert.equal(b3.querySelector("[data-zb-coach-ai]").textContent, "是");
	assert.match(b3.textContent, /AI 的理由：所有隨機分派的受試者都依原分組分析（ITT）。/);
	let quote = b3.querySelector("button[data-zb-coach-quote]");
	assert.match(quote.textContent, /^「All randomised participants were analysed/);
	assert.match(quote.textContent, /p\. 2$/, "the PDF page where the quote is, not the AI's claim");
	assert.equal(b3.querySelector("[data-zb-coach-low]"), null);
	let b5 = blocks()[1];
	assert.equal(b5.querySelector("[data-zb-coach-low]").textContent, "低可信（無原文佐證）");
	assert.equal(b5.querySelector("[data-zb-coach-quote]"), null, "the invented quote is gone");
	assert.equal(section().querySelector("[data-zb-coach-dropped]").textContent, "原文核對不到，已略過 1 句 AI 引文。");
	let agreed = section().querySelector("[data-zb-coach-agreed]");
	assert.equal(agreed.querySelector("summary").textContent, "一致的題目（11 題）");
	assert.equal(agreed.querySelectorAll("[data-zb-coach-item]").length, 11);
	assert.doesNotMatch(section().textContent, /正確/, "never calls the AI's answer correct");
	// The quote opens the PDF at its page
	quote.click();
	await until(() => env.opened.length, "the reader to open");
	assert.deepEqual(JSON.parse(JSON.stringify(env.opened[0])), { id: s.pdf.id, location: { pageIndex: 1 } });

	// Stored: the run in the form's JSON, the user's answers untouched; a ledger entry
	let stored = () => ZB.appraisalForm.readNoteHTML(ZB.appraisalForm.getFormNote(s.paper).getNote());
	let run = stored().coach[0];
	assert.equal(run.model, "test-model");
	assert.equal(run.provider, "anthropic");
	assert.equal(run.tool, "casp-rct");
	assert.equal(run.source, "fulltext");
	assert.equal(run.dropped, 1);
	assert.deepEqual([run.compared, run.agreed], [13, 11]);
	let i3 = run.items.find(i => i.id === "3");
	assert.deepEqual([i3.user, i3.ai, i3.decision, i3.lowConfidence], ["否", "是", "", false]);
	assert.deepEqual(JSON.parse(JSON.stringify(i3.quotes)), [{ text: "All randomised participants were analysed in the groups to which they were assigned", page: 2, attachmentKey: "PDFKEY01" }]);
	assert.equal(run.items.find(i => i.id === "2").quotes.length, 1, "an agreement keeps its verified quote too");
	assert.equal(stored().answers["3"].answer, "否");
	assert.equal(stored().answers["3"].note, "流失 10% 未做 ITT（MY-OWN-NOTE）", "unsaved edits were saved with the run");
	let ledger = JSON.parse(env.prefStore[P + "usage.ledger"]);
	let month = Object.values(ledger)[0];
	assert.equal(month.calls, 1);
	assert.equal(month.byModel["test-model"].input, 5000);
	assert.ok(env.progressLines.some(l => l.text === "評讀陪練：13 題中 11 題一致，2 題不同（一致 85%）"));
	assert.ok(env.descriptions.includes("原文核對不到，已略過 1 句 AI 引文。"));

	// 保留我的判斷 with a reason, then 改成 AI 的答案
	let why = blocks()[0].querySelector("[data-zb-coach-why]");
	why.value = "流失者沒有納入分析";
	why.dispatchEvent(new s.doc.defaultView.Event("input"));
	blocks()[0].querySelector('[data-zb-coach-decide="kept"]').click();
	await until(() => stored().coach[0].items.find(i => i.id === "3").decision === "kept", "the decision to be saved");
	await until(() => blocks()[0].querySelector("[data-zb-coach-decision]"), "the form to show the decision");
	let k = stored().coach[0].items.find(i => i.id === "3");
	assert.equal(k.why, "流失者沒有納入分析");
	assert.match(k.decidedAt, /^\d{4}-\d{2}-\d{2}T/);
	assert.equal(stored().answers["3"].answer, "否", "kept: the user's answer stays");
	assert.match(blocks()[0].querySelector("[data-zb-coach-decision]").textContent, /^你保留了自己的判斷（\d{4}-\d{2}-\d{2}）：流失者沒有納入分析$/);
	assert.equal(blocks()[0].querySelector("[data-zb-coach-decide]"), null, "decided: no more buttons");
	blocks()[1].querySelector('[data-zb-coach-decide="changed"]').click();
	await until(() => stored().coach[0].items.find(i => i.id === "5").decision === "changed", "the change to be saved");
	await until(() => blocks()[1].querySelector("[data-zb-coach-decision]"), "the form to show the change");
	assert.deepEqual(JSON.parse(JSON.stringify(stored().answers["5"])), { answer: "否", note: "", source: "human" });
	assert.equal(row().querySelector('[data-zb-item="5"] [aria-pressed="true"]').textContent, "否", "the form shows the new answer");
	assert.equal(ZB.appraisalCoach.summaryLine(stored()), "評讀陪練：一致 11/13，修改 1 題");
	assert.match(ZB.appraisalForm.getFormNote(s.paper).getNote(), /<p>評讀陪練：一致 11\/13，修改 1 題<\/p>/);
	let synced = ZB.appraisalForm.syncInfo({ appraisalNote: { html: ZB.appraisalForm.getFormNote(s.paper).getNote() } }, null);
	assert.match(synced.markdown, /\n\n評讀陪練：一致 11\/13，修改 1 題/);
	assert.match(synced.notionMarkdown, /評讀陪練：一致 11\/13，修改 1 題/);
	assert.deepEqual(env.errors, []);
	await vm.runInContext("shutdown()", env.context);
});

test("評讀陪練: switched off → no button, no section, no request; no API key → a clear message, no request", async () => {
	let calls = [];
	let s = await setup({ fetch: claudeMock(calls) });
	let { env, ZB, row } = s;
	row().querySelector('[data-zb-action="toggle"]').click();
	chooseCASP(s);
	answerAll(row);
	assert.ok(row().querySelector('[data-zb-action="coach"]'));

	// No API key
	await ZB.secrets.clear("anthropicKey");
	row().querySelector('[data-zb-action="coach"]').click();
	await until(() => row().querySelector("[data-zb-coach-message]"), "the message");
	assert.match(row().querySelector("[data-zb-coach-message]").textContent, /還沒有 API key：請到 設定 → ZotMax → AI 填入/);
	assert.equal(env.confirms.length, 0, "no cost confirm without a key");
	assert.equal(calls.length, 0);

	// Off: the form loses the button and the section; the command and run() go nowhere
	ZB.features.setEnabled("appraisalCoach", false);
	s.render();
	row().querySelector('[data-zb-action="toggle"]').click();
	assert.equal(row().querySelector('[data-zb-action="coach"]'), null);
	assert.equal(row().querySelector("[data-zb-coach]"), null);
	assert.equal(ZB.commands.isVisible(ZB.commands.get("appraisal-coach")), false);
	assert.equal(await ZB.appraisalCoach.run(s.paper), null);
	assert.equal(calls.length, 0);
	// 文獻評讀表 off takes it along
	ZB.features.setEnabled("appraisalCoach", true);
	ZB.features.setEnabled("appraisalForm", false);
	assert.equal(ZB.appraisalCoach.enabled(), false);
	assert.deepEqual(env.errors, []);
	await vm.runInContext("shutdown()", env.context);
});

test("評讀陪練: OpenAI through the Responses API; without full text the abstract, said so; a malformed answer changes nothing", async () => {
	let calls = [];
	let reply = aiAnswer();
	let fetch = async (url, init) => {
		calls.push({ url, body: JSON.parse(init.body) });
		return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ model: "test-openai", status: "completed", output_text: reply, usage: { input_tokens: 3000, output_tokens: 500 } }) };
	};
	let s = await setup({ fetch, prefs: { [P + "llm.provider"]: "openai", [P + "llm.fullTextLimit"]: "0" } });
	let { env, ZB, row } = s;
	await ZB.secrets.set("openaiKey", "sk-openai-test");
	row().querySelector('[data-zb-action="toggle"]').click();
	chooseCASP(s);
	answerAll(row);
	let r = await ZB.appraisalCoach.run(s.paper);
	assert.ok(r);
	assert.equal(calls[0].url, "https://api.openai.com/v1/responses");
	assert.match(calls[0].body.instructions, /^你是護理與醫學研究方法的評讀助教[\s\S]*<checklist>/);
	assert.match(calls[0].body.input, /這篇沒有可用的全文，以下只有摘要/);
	assert.doesNotMatch(calls[0].body.input, /Allocation was concealed/);
	assert.match(env.confirms[0], /只能用摘要對照（設定裡「全文最多送出字元數」是 0）/);
	assert.equal(r.source, "abstract");
	assert.equal(r.provider, "openai");
	// Quotes are still checked against the PDF's text (it was only not sent): the invented one is dropped
	assert.equal(r.dropped, 1);
	assert.equal(r.items.find(i => i.id === "3").quotes[0].page, 2);
	assert.equal(r.items.find(i => i.id === "5").lowConfidence, true);
	assert.match(row().querySelector("[data-zb-coach]").textContent, /這次只用摘要對照/);
	assert.equal(JSON.parse(env.prefStore[P + "usage.ledger"])[Object.keys(JSON.parse(env.prefStore[P + "usage.ledger"]))[0]].calls, 1);

	// A malformed answer: an error message, the stored form unchanged
	let before = ZB.appraisalForm.getFormNote(s.paper).getNote();
	reply = "Sorry, I can't help with that.";
	assert.equal(await ZB.appraisalCoach.run(s.paper), null);
	assert.equal(ZB.appraisalForm.getFormNote(s.paper).getNote(), before);
	assert.match(row().querySelector("[data-zb-coach-message]").textContent, /^對照失敗：AI 的回覆裡沒有 JSON。評讀表沒有改變。$/);
	assert.equal(env.errors.length, 1, "logged");
	await vm.runInContext("shutdown()", env.context);
});
