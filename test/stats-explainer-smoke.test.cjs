// 讀懂統計 through the real plugin in a mocked Zotero: the button in the PDF reader's text-selection
// popup (Zotero.Reader.registerEventListener), the AI call with a mocked fetch, the ZotMax panel's
// 統計解釋 part with its four parts, an invented number stripped with the warning, the history in the
// child note, 存到筆記 into the literature note's 「統計筆記」, 再解釋得簡單一點, the cost confirmation,
// the command, the switch (no button, no network), a missing API key, and shutdown.
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
const PLUGIN_ID = "zotero-bridge@bobyu89.github.io";

const PDF_TEXT = [
	"Exercise to prevent falls in older adults: a randomised trial",
	"Methods",
	"We randomised 240 adults aged 65 years or older to exercise or usual care.",
	"Statistical analysis",
	"Analyses followed the intention-to-treat principle. Odds ratios (OR) with 95% confidence intervals were estimated with logistic regression.",
	"Results",
	"Falls occurred in 18% of the exercise group and 26% of controls (OR 0.62, 95% CI 0.39-0.98; p = .04).",
	"References",
	"1. Someone (2020).",
].join("\n");
const SELECTION = "Falls occurred in 18% of the exercise group and 26% of controls (OR 0.62, 95% CI 0.39-0.98; p = .04).";

// The model's answer: right numbers, plus an invented NNT of 13 and a made-up 31%
const ANSWER = {
	terms: [
		{ term: "OR", what: "勝算比（odds ratio），比較兩組發生事件的勝算。", here: "OR 0.62：運動組跌倒的勝算是對照組的 0.62 倍。" },
		{ term: "95% CI", what: "信賴區間（confidence interval）。", here: "0.39 到 0.98，沒有跨過 1。" },
		{ term: "NNT", what: "需治數。", here: "大約 13 人運動就能少一人跌倒。" },
	],
	restatement: "運動組 18% 跌倒，對照組 26%，差異在統計上顯著（p = .04）。",
	clinical: "跌倒相對減少約 31%，對社區長者有意義。",
	cautions: ["信賴區間上限 0.98 很接近 1，效果可能很小。", "這段沒有寫絕對風險差。"],
};
const SIMPLER = { terms: [], restatement: "做運動的長輩比較少跌倒：100 人裡大約少 8 人。", clinical: "值得鼓勵長輩規律運動。", cautions: [] };

function makeEnv({ prefs = {}, answers = [ANSWER] } = {}) {
	let items = new Map();
	let nextID = 100;
	let panes = [];
	let errors = [];
	let opened = [];
	let listeners = [];
	let unregisteredListeners = [];
	let fetches = [];
	let confirms = [];
	let notifications = [];
	let confirmAnswer = true;
	let answerQueue = answers.slice();

	class MockItem {
		constructor(type, fields = {}) {
			this.id = nextID++;
			this.key = fields.key || `KEY${String(this.id).padStart(5, "0")}`;
			this.itemType = type;
			this.libraryID = 1;
			this.deleted = false;
			this.parentID = null;
			this.fields = fields;
			this.tags = (fields.tags || []).slice();
			this.children = [];
			this.noteHTML = "";
			this.dateAdded = "2024-05-01 08:00:00";
			this.saved = false;
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
		get attachmentText() { return Promise.resolve(this.fields.text || ""); }
		async getFilePathAsync() { return false; }
		getField(f) { return this.fields[f] || ""; }
		getCreatorsJSON() { return this.fields.creators || []; }
		getTags() { return this.tags.map(tag => ({ tag })); }
		addTag(t) { this.tags.push(t); return true; }
		getCollections() { return []; }
		getAttachments() { return this.children.filter(id => items.get(id).itemType === "attachment"); }
		getNotes() { return this.children.filter(id => items.get(id).itemType === "note"); }
		getAnnotations() { return []; }
		getNote() { return this.noteHTML; }
		setNote(h) { this.noteHTML = h; }
		getNoteTitle() { return ""; }
		async saveTx() {
			let parent = this.parentID && items.get(this.parentID);
			if (parent && !parent.children.includes(this.id)) parent.children.push(this.id);
			this.saved = true;
			return this.id;
		}
	}
	let addChild = (parent, child) => {
		child.parentID = parent.id;
		parent.children.push(child.id);
		return child;
	};

	let prefStore = Object.assign({}, prefs);
	let Zotero = {
		Prefs: {
			get: k => prefStore[k],
			set: (k, v) => { prefStore[k] = v; },
			clear: (k) => { delete prefStore[k]; },
			registerObserver: () => Symbol("o"),
			unregisterObserver: () => {},
		},
		MenuManager: { registerMenu: o => o.menuID, unregisterMenu: () => true },
		Notifier: { registerObserver: () => "obs", unregisterObserver: () => {} },
		ItemPaneManager: {
			registerSection: (o) => { panes.push(o); return o.paneID; },
			unregisterSection: () => true,
		},
		PreferencePanes: { register: async () => "pane" },
		Reader: {
			open: async (id, location) => { opened.push({ id, location: location || null }); },
			registerEventListener: (type, handler, pluginID) => { listeners.push({ type, handler, pluginID }); },
			unregisterEventListener: (type, handler) => {
				unregisteredListeners.push(type);
				listeners = listeners.filter(l => !(l.type === type && l.handler === handler));
			},
			getByTabID: id => (id === "reader-tab" ? { tabID: id, itemID: env.readerItemID } : null),
		},
		launchURL: () => {},
		getMainWindows: () => [],
		getMainWindow: () => ({ Zotero_Tabs: { selectedID: "reader-tab" } }),
		getActiveZoteroPane: () => ({ getSelectedCollections: () => [], getSelectedItems: () => [] }),
		Items: {
			get: ids => (Array.isArray(ids) ? ids.map(id => items.get(id)) : items.get(Number(ids)) || false),
			exists: id => items.has(id),
			getByLibraryAndKey: (lib, key) => [...items.values()].find(i => i.key === key) || false,
			getAll: async () => [],
		},
		Libraries: { get: () => ({ libraryType: "user", name: "My Library" }), getAll: () => [], userLibraryID: 1 },
		Groups: { getGroupIDFromLibraryID: () => null },
		Collections: { get: () => [], getByParent: () => [], getByLibrary: () => [] },
		Tags: { getID: () => false },
		Styles: { get: () => null },
		ProgressWindow: class {
			constructor() {
				this.ItemProgress = class {
					constructor() {}
					setText() {}
					setProgress() {}
					setError() {}
				};
			}
			changeHeadline() {}
			addDescription(text) { notifications.push(text); }
			show() {}
			startCloseTimer() {}
		},
		logError: (e) => { errors.push(e); },
		debug: () => {},
	};
	Zotero.Item = MockItem;

	let fetch = async (url, init) => {
		// A test can hold the answer back (env.gate) to look at the panel while the call runs
		if (env.gate) await env.gate;
		fetches.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
		let answer = answerQueue.length > 1 ? answerQueue.shift() : answerQueue[0];
		let text = typeof answer === "string" ? answer : JSON.stringify(answer);
		let json = String(url).includes("openai")
			? { model: "test-openai-model", output_text: text, usage: { input_tokens: 1500, output_tokens: 400 } }
			: { model: "test-claude-model", stop_reason: "end_turn", content: [{ type: "text", text }], usage: { input_tokens: 1500, output_tokens: 400 } };
		return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(json) };
	};

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
		setTimeout, clearTimeout,
		Services: {
			scriptloader: {
				loadSubScript: (url) => {
					let file = url.replace("file://", "");
					vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
				},
			},
			prompt: { confirm: (win, title, text) => { confirms.push(text); return confirmAnswer; } },
			logins: {
				searchLoginsAsync: async m => logins.filter(l => Object.entries(m).every(([k, v]) => l[k] === v)),
				addLoginAsync: async (l) => { logins.push(l); return l; },
				modifyLoginAsync: async (old, l) => { logins[logins.indexOf(old)] = l; },
				removeLoginAsync: async (old) => { logins.splice(logins.indexOf(old), 1); },
			},
		},
	});
	vm.runInContext(fs.readFileSync(path.join(ROOT, "bootstrap.js"), "utf8"), context, { filename: "bootstrap.js" });
	let env = {
		context, Zotero, MockItem, items, addChild, panes, errors, opened, fetches, confirms, notifications, prefStore,
		get listeners() { return listeners; },
		unregisteredListeners,
		setConfirm: (v) => { confirmAnswer = v; },
		readerItemID: null,
	};
	return env;
}

async function setup(opts = {}) {
	let vault = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-stats-"));
	let prefs = Object.assign({
		[P + "features.version"]: 3,
		[P + "feature.statsExplainer"]: true,
		[P + "obsidian.vaultPath"]: vault,
		[P + "llm.anthropicKey"]: "sk-ant-test",
	}, opts.prefs || {});
	for (let [k, v] of Object.entries(prefs)) if (v === undefined) delete prefs[k];
	let env = makeEnv(Object.assign({}, opts, { prefs }));
	await vm.runInContext(`startup({ id: "${PLUGIN_ID}", version: "0.0.0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);
	let ZB = env.context.ZB;
	// The API key moves from the old pref into the login manager at startup
	await ZB.main.readSettings();
	return Object.assign(env, { ZB, vault, section: env.panes.find(p => p.paneID === "zotero-bridge-ai-note") });
}

function paper(env) {
	let item = new env.MockItem("journalArticle", {
		title: "Exercise to prevent falls", year: "2024", citationKey: "lee2024",
		abstractNote: "Exercise reduced falls (OR 0.62).",
	});
	let pdf = env.addChild(item, new env.MockItem("attachment", { title: "Full Text PDF", text: PDF_TEXT, key: "PDFKEY01" }));
	env.readerItemID = pdf.id;
	return { item, pdf };
}

/** The literature note as a sync writes it: frontmatter with zotero_key, the managed block, 我的筆記. */
async function writeNote(env, item) {
	let file = path.join(env.vault, "lee2024.md");
	let data = { key: item.key, libraryPath: "library", title: item.getField("title"), creators: [], attachments: [], tags: [], collections: [], year: "2024", citationKey: "lee2024" };
	await fsp.writeFile(file, env.ZB.core.buildObsidianNote(null, data, { aiMarkdown: "## 一句話摘要\n運動讓跌倒變少。" }));
	return { file, data };
}

/** What the popup handler gets from the reader: params.annotation like the reader's selection. */
function popupEvent(env, pdf, text = SELECTION) {
	let doc = new JSDOM("<div id=popup></div>").window.document;
	let popup = doc.getElementById("popup");
	return {
		doc, popup,
		event: {
			type: "renderTextSelectionPopup", doc,
			reader: { itemID: pdf.id, tabID: "reader-tab" },
			params: { annotation: { text, pageLabel: "3", position: { pageIndex: 2, rects: [[10, 20, 300, 40]] }, sortIndex: "00002|000100|00100" } },
			append: (...nodes) => { for (let n of nodes) popup.append(n); },
		},
	};
}

function fire(env, event) {
	for (let l of env.listeners.filter(x => x.type === "renderTextSelectionPopup")) l.handler(event);
}

function panel(env, item) {
	let doc = new JSDOM("<div id=b></div>").window.document;
	let body = doc.getElementById("b");
	env.section.onRender({ doc, body, item, setSectionSummary: () => {} });
	return { doc, body, part: body.querySelector('[data-zb-sub="stats"]') };
}

async function until(fn, what, ms = 3000) {
	let end = Date.now() + ms;
	while (Date.now() < end) {
		if (await fn()) return;
		await new Promise(r => setTimeout(r, 10));
	}
	assert.fail(`timed out waiting for ${what}`);
}

const plain = v => JSON.parse(JSON.stringify(v));

test("the reader popup gets 「ZotMax：解釋統計」; a click explains the selection into the panel, the invented numbers removed", async () => {
	let env = await setup();
	let { ZB } = env;
	assert.equal(env.listeners.length, 1, "one reader listener");
	assert.equal(env.listeners[0].type, "renderTextSelectionPopup");
	assert.equal(env.listeners[0].pluginID, PLUGIN_ID, "registered with the plugin ID, so Zotero can drop it too");
	let { item, pdf } = paper(env);

	let { popup, event } = popupEvent(env, pdf);
	fire(env, event);
	let button = popup.querySelector("button[data-zb-stats=explain]");
	assert.ok(button, "the button in the popup");
	assert.equal(button.textContent, "ZotMax：解釋統計");
	assert.equal(button.className, "toolbar-button wide-button", "Zotero's own popup button style");
	assert.equal(button.getAttribute("data-l10n-id"), "zotero-bridge-stats-popup");
	assert.equal(plain(ZB.statsExplainer.lastSelection).text, SELECTION);

	button.click();
	await until(() => env.fetches.length === 1 && ZB.statsExplainer.loadRecord(item).entries.length === 1, "the explanation");
	// One call: fixed system block (cached), the selection and the statistical analysis excerpt
	let req = env.fetches[0];
	assert.match(req.url, /^https:\/\/api\.anthropic\.com\//);
	assert.equal(req.body.system.length, 1);
	assert.equal(req.body.system[0].text, ZB.statsExplainer.SYSTEM_PROMPT);
	assert.deepEqual(plain(req.body.system[0].cache_control), { type: "ephemeral" });
	let user = req.body.messages[0].content;
	assert.match(user, /<selection>\nFalls occurred in 18%/);
	assert.match(user, /<methods source="方法與統計分析段落的節錄">[\s\S]*intention-to-treat principle/);
	assert.doesNotMatch(user, /Someone \(2020\)/);
	assert.equal(req.headers["x-api-key"], "sk-ant-test");
	// The usage ledger
	let ledger = JSON.parse(env.prefStore[P + "usage.ledger"]);
	assert.equal(Object.values(ledger)[0].byModel["test-claude-model"].calls, 1);

	// The panel: the part after 重點, the quote, the four parts, the warnings
	let { part } = panel(env, item);
	assert.ok(part, "統計解釋 in the panel");
	let subs = [...part.parentElement.querySelectorAll("[data-zb-sub]")].map(d => d.dataset.zbSub);
	assert.deepEqual(subs.slice(0, 2), ["keyPoints", "stats"]);
	assert.equal(part.open, true);
	assert.equal(part.querySelector(".zb-sp-title").textContent, "統計解釋");
	let entry = part.querySelector("[data-zb-entry]");
	assert.match(entry.querySelector("[data-zb-selection]").textContent, /^Falls occurred in 18%/);
	assert.deepEqual([...entry.querySelectorAll("[data-zb-part] > .zb-sp-label")].map(e => e.textContent), ["這是什麼", "這段在說什麼", "臨床上代表什麼", "要注意的地方"]);
	assert.deepEqual([...entry.querySelectorAll(".zb-st-terms dt")].map(e => e.textContent), ["OR", "95% CI", "NNT"]);
	let nnt = entry.querySelectorAll(".zb-st-terms dd")[2];
	assert.equal(nnt.textContent, "需治數。 在這段裡：大約 ［數字已移除］ 人運動就能少一人跌倒。");
	assert.doesNotMatch(entry.textContent, /\b13\b|31%/, "the invented numbers are gone");
	assert.match(entry.textContent, /0\.62/, "the text's numbers stay");
	let warn = p => entry.querySelector(`[data-zb-part="${p}"] [data-zb-warning]`);
	assert.equal(warn("terms").textContent, "⚠ 這個數字不在原文裡，已移除");
	assert.equal(warn("clinical").textContent, "⚠ 這個數字不在原文裡，已移除");
	assert.equal(warn("restatement"), null);
	assert.equal(entry.querySelectorAll("[data-zb-removed]").length, 2);
	// Back to the page of the selection
	entry.querySelector("[data-zb-action=open-page]").click();
	assert.deepEqual(plain(env.opened), [{ id: pdf.id, location: { position: { pageIndex: 2, rects: [[10, 20, 300, 40]] } } }]);
	assert.equal(entry.querySelector("[data-zb-action=open-page]").textContent, "回到 PDF 第 3 頁");
	assert.deepEqual(env.errors, []);
});

test("history in the child note: newest first, at most five; the note is never one of the user's notes", async () => {
	let env = await setup();
	let { ZB } = env;
	let { item, pdf } = paper(env);
	for (let i = 1; i <= 6; i++) {
		await ZB.statsExplainer.explain({ attachmentID: pdf.id, text: `${SELECTION} #${i}`, pageLabel: String(i), pageIndex: i - 1, rects: [] });
	}
	let note = ZB.statsExplainer.getNote(item);
	assert.ok(note.tags.includes("zotero-bridge-stats"));
	assert.equal(item.getNotes().length, 1, "one child note");
	let record = ZB.statsExplainer.loadRecord(item);
	assert.equal(record.entries.length, 5);
	assert.deepEqual(plain(record.entries.map(e => e.selection.pageLabel)), ["6", "5", "4", "3", "2"]);
	// The panel: the latest open, the older ones folded
	let { part } = panel(env, item);
	assert.equal(part.querySelectorAll(".zb-st > [data-zb-entry]").length, 1);
	assert.equal(part.querySelectorAll("[data-zb-older]").length, 4);
	assert.equal([...part.querySelectorAll("[data-zb-older]")].every(d => !d.open), true);
	// Not synced as a user note, not sent to the AI
	let data = await ZB.adapter.extractItemData(item, { fullTextLimit: 0 });
	assert.deepEqual(plain(data.notes), []);
	assert.deepEqual(env.errors, []);
});

test("存到筆記 appends to the 「統計筆記」 callout outside the managed block; a re-sync keeps it", async () => {
	let env = await setup();
	let { ZB } = env;
	let { item, pdf } = paper(env);
	let { file, data } = await writeNote(env, item);
	await ZB.statsExplainer.explain({ attachmentID: pdf.id, text: SELECTION, pageLabel: "3", pageIndex: 2, rects: [] });
	let { part } = panel(env, item);
	part.querySelector("[data-zb-action=stats-save]").click();
	await until(async () => (await fsp.readFile(file, "utf8")).includes("統計筆記") && ZB.statsExplainer.loadRecord(item).entries[0].savedAt, "the note written");
	let text = await fsp.readFile(file, "utf8");
	assert.ok(text.indexOf("> [!note]- 統計筆記") > text.indexOf("%% zotero-bridge:end %%"));
	assert.match(text, /> \*\*\d{4}-\d{2}-\d{2} · p\. 3\*\* · \[回到 PDF\]\(zotero:\/\/open-pdf\/library\/items\/PDFKEY01\?page=3\)/);
	assert.match(text, /> > Falls occurred in 18%/);
	assert.match(text, /> - \*\*NNT\*\*：需治數。 在這段裡：大約 ［數字已移除］ 人/);
	// The panel says so; the button is done
	let after = panel(env, item).part;
	assert.equal(after.querySelector("[data-zb-status]").textContent, "已存到文獻筆記的「統計筆記」。");
	let save = after.querySelector("[data-zb-action=stats-save]");
	assert.equal(save.textContent, "已存到筆記");
	assert.equal(save.disabled, true);
	// A re-sync rewrites the managed block only
	let block = text.slice(text.indexOf("> [!note]- 統計筆記"));
	let resynced = ZB.core.buildObsidianNote(text, data, { aiMarkdown: "## 一句話摘要\n新的摘要。" });
	assert.match(resynced, /新的摘要/);
	assert.ok(resynced.includes(block));
	// Not synced yet: says so, writes nothing
	let other = paper(env);
	await ZB.statsExplainer.explain({ attachmentID: other.pdf.id, text: SELECTION, pageLabel: "1", pageIndex: 0, rects: [] });
	let id = ZB.statsExplainer.loadRecord(other.item).entries[0].id;
	assert.equal(await ZB.statsExplainer.saveToNote(other.item, id), undefined);
	assert.equal(panel(env, other.item).part.querySelector("[data-zb-status]").textContent, "這篇還沒同步到 Obsidian。先同步一次，再按「存到筆記」。");
	assert.deepEqual(env.errors, []);
});

test("再解釋得簡單一點: one more call, checked against the selection and the first explanation", async () => {
	let env = await setup({ answers: [ANSWER, SIMPLER] });
	let { ZB } = env;
	let { item, pdf } = paper(env);
	await ZB.statsExplainer.explain({ attachmentID: pdf.id, text: SELECTION, pageLabel: "3", pageIndex: 2, rects: [] });
	let { part } = panel(env, item);
	part.querySelector("[data-zb-action=stats-simpler]").click();
	await until(() => ZB.statsExplainer.loadRecord(item).entries[0].simpler, "the simpler version");
	assert.equal(env.fetches.length, 2);
	let req = env.fetches[1].body;
	assert.equal(req.system[0].text, ZB.statsExplainer.SYSTEM_PROMPT, "the same cached system prompt");
	assert.match(req.messages[0].content, /<previous>[\s\S]*（已移除）/);
	let simple = panel(env, item).part.querySelector("[data-zb-simpler]");
	assert.equal(simple.querySelector(".zb-sp-label").textContent, "簡單版");
	assert.match(simple.textContent, /做運動的長輩比較少跌倒：［數字已移除］ 人裡大約少 ［數字已移除］ 人/);
	assert.equal(simple.querySelector("[data-zb-warning]").textContent, "⚠ 有 2 個數字不在原文裡，已移除");
	assert.equal(panel(env, item).part.querySelector("[data-zb-action=stats-simpler]"), null, "once");
	assert.deepEqual(env.errors, []);
});

test("cost: no dialog for a small selection (the estimate shows while it runs); a dialog when set to always or above the threshold", async () => {
	let env = await setup();
	let { ZB } = env;
	let { item, pdf } = paper(env);
	let release;
	env.gate = new Promise(r => { release = r; });
	let run = ZB.statsExplainer.explain({ attachmentID: pdf.id, text: SELECTION, pageLabel: "3", pageIndex: 2, rects: [] });
	await until(() => {
		let p = panel(env, item).part;
		return p && p.querySelector("[data-zb-pending=loading] [role=status]") && /AI 解釋中…（預估約 (US\$|< US\$)/.test(p.textContent);
	}, "the inline estimate");
	let status = panel(env, item).part.querySelector("[data-zb-pending=loading] [role=status]");
	assert.equal(status.getAttribute("aria-busy"), "true");
	assert.equal(status.getAttribute("data-l10n-id"), "zotero-bridge-stats-loading-cost");
	env.gate = null;
	release();
	await run;
	assert.equal(panel(env, item).part.querySelector("[data-zb-pending]"), null, "done: the explanation instead");
	assert.equal(env.confirms.length, 0);
	// Always: asked; declined: no call
	env.prefStore[P + "statsExplainer.confirm"] = "always";
	env.setConfirm(false);
	assert.equal(await ZB.statsExplainer.explain({ attachmentID: pdf.id, text: SELECTION }), null);
	assert.equal(env.confirms.length, 1);
	assert.match(env.confirms[0], /預估費用：約 /);
	assert.equal(env.fetches.length, 1, "declined: nothing sent");
	assert.equal(panel(env, item).part.querySelector("[data-zb-pending]"), null, "and nothing pending");
	// Above a threshold the selection exceeds
	env.prefStore[P + "statsExplainer.confirm"] = "above";
	env.prefStore[P + "statsExplainer.confirmAbove"] = "0.0001";
	env.setConfirm(true);
	await ZB.statsExplainer.explain({ attachmentID: pdf.id, text: SELECTION });
	assert.equal(env.confirms.length, 2);
	assert.equal(env.fetches.length, 2);
	// Never
	env.prefStore[P + "statsExplainer.confirm"] = "never";
	await ZB.statsExplainer.explain({ attachmentID: pdf.id, text: SELECTION });
	assert.equal(env.confirms.length, 2);
	assert.deepEqual(env.errors, []);
});

test("OpenAI works the same way", async () => {
	let env = await setup({ prefs: { [P + "llm.provider"]: "openai", [P + "llm.anthropicKey"]: undefined, [P + "llm.openaiKey"]: "sk-openai" } });
	let { ZB } = env;
	let { item, pdf } = paper(env);
	await ZB.statsExplainer.explain({ attachmentID: pdf.id, text: SELECTION });
	assert.match(env.fetches[0].url, /api\.openai\.com\/v1\/responses/);
	assert.match(env.fetches[0].body.instructions, /護理研究所學生/);
	assert.equal(ZB.statsExplainer.loadRecord(item).entries[0].model, "test-openai-model");
	assert.equal(Object.values(JSON.parse(env.prefStore[P + "usage.ledger"]))[0].byModel["test-openai-model"].calls, 1);
	assert.deepEqual(env.errors, []);
});

test("no API key: a clear message in the panel with 打開設定, nothing sent", async () => {
	let env = await setup({ prefs: { [P + "llm.anthropicKey"]: undefined } });
	let { ZB } = env;
	let { item, pdf } = paper(env);
	assert.equal(await ZB.statsExplainer.explain({ attachmentID: pdf.id, text: SELECTION, pageLabel: "3" }), null);
	assert.equal(env.fetches.length, 0);
	let { part } = panel(env, item);
	let err = part.querySelector("[data-zb-error]");
	assert.equal(err.textContent, "還沒有設定 AI 的 API key，所以沒辦法解釋。到 設定 → AI 填入 Claude 或 OpenAI 的 key。");
	assert.ok(part.querySelector("[data-zb-action=stats-settings]"));
	// 知道了 clears it, and the part goes away (nothing else to show)
	part.querySelector("[data-zb-action=stats-dismiss]").click();
	assert.equal(panel(env, item).part, null);
	assert.deepEqual(env.errors, []);
});

test("switched off: no popup button, no network, no panel part; the command says where to turn it on", async () => {
	let env = await setup({ prefs: { [P + "feature.statsExplainer"]: false } });
	let { ZB } = env;
	let { item, pdf } = paper(env);
	let { popup, event } = popupEvent(env, pdf);
	fire(env, event);
	assert.equal(popup.children.length, 0, "no button");
	assert.equal(await ZB.statsExplainer.explain({ attachmentID: pdf.id, text: SELECTION }), null);
	assert.equal(env.fetches.length, 0);
	assert.equal(panel(env, item).part, null);
	assert.equal(ZB.commands.isVisible(ZB.commands.get("explain-stats")), false);
	// Needs AI 文獻筆記 too
	env.prefStore[P + "feature.statsExplainer"] = true;
	env.prefStore[P + "llm.enabled"] = false;
	fire(env, event);
	assert.equal(popup.children.length, 0);
	assert.equal(ZB.commands.isVisible(ZB.commands.get("explain-stats")), false);
	assert.deepEqual(env.errors, []);
});

test("「解釋所選統計」: the selection last made in the reader tab on screen; without one it says what to do", async () => {
	let env = await setup();
	let { ZB } = env;
	let { item, pdf } = paper(env);
	let cmd = ZB.commands.get("explain-stats");
	assert.equal(cmd.group, "ai");
	assert.deepEqual(plain(cmd.features), ["statsExplainer"]);
	assert.equal(ZB.commands.isVisible(cmd), true);
	// Nothing selected yet
	await ZB.commands.execute(cmd, ZB.commands.fromWindow(null, "palette"));
	assert.equal(env.fetches.length, 0);
	assert.match(env.notifications.at(-1), /先在 PDF 閱讀器裡選取/);
	// A selection in the reader, then the command (palette)
	fire(env, popupEvent(env, pdf).event);
	await ZB.commands.execute(cmd, ZB.commands.fromWindow(null, "palette"));
	assert.equal(env.fetches.length, 1);
	assert.equal(ZB.statsExplainer.loadRecord(item).entries[0].selection.pageLabel, "3");
	// A standalone PDF has nowhere to keep it
	let loose = new env.MockItem("attachment", { title: "Loose", text: "OR 2.0" });
	assert.equal(await ZB.statsExplainer.explain({ attachmentID: loose.id, text: "OR 2.0" }), null);
	assert.match(env.notifications.at(-1), /沒有上層文獻條目/);
	assert.equal(env.fetches.length, 1);
	assert.deepEqual(env.errors, []);
});

test("a model that ignores the format: its text shown (numbers checked), flagged", async () => {
	let env = await setup({ answers: ["這段是說運動組跌倒比較少，OR 0.62，大約少了 40%。"] });
	let { ZB } = env;
	let { item, pdf } = paper(env);
	await ZB.statsExplainer.explain({ attachmentID: pdf.id, text: SELECTION });
	let { part } = panel(env, item);
	assert.match(part.textContent, /AI 沒有照格式回答/);
	assert.match(part.querySelector('[data-zb-part="restatement"]').textContent, /OR 0\.62，大約少了 ［數字已移除］。/);
	assert.deepEqual(env.errors, []);
});

test("shutdown removes the reader listener first; a late popup event or click does nothing", async () => {
	let env = await setup();
	let { ZB } = env;
	let { pdf } = paper(env);
	let handler = env.listeners[0].handler;
	let { popup, event } = popupEvent(env, pdf);
	await vm.runInContext("shutdown()", env.context);
	assert.deepEqual(env.unregisteredListeners, ["renderTextSelectionPopup"]);
	assert.equal(env.listeners.length, 0);
	assert.equal(ZB.statsExplainer.listening, false);
	// Zotero calling the old handler anyway (as it can while disabling a plugin)
	handler(event);
	assert.equal(popup.children.length, 0);
	assert.equal(await ZB.statsExplainer.explain({ attachmentID: pdf.id, text: SELECTION }), null);
	assert.equal(env.fetches.length, 0);
	assert.deepEqual(env.errors, []);
});
