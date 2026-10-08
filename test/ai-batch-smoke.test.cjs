// Bulk AI notes through the Claude Message Batches API (content/ai-batch.js), driven through the real
// plugin in a mocked Zotero with a mocked Batches API: confirm (batch vs normal) → one batch created
// with the normal request bodies → Zotero restarts while it is in progress → polling resumes → ended →
// results: AI notes saved, usage at batch prices, items synced to Obsidian, failures listed for the
// normal retry; cancel from the Tools menu; a batch that cannot be created falls back to the normal path.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");
const { AI_MD } = require("./fixtures.cjs");

const ROOT = path.join(__dirname, "..");
const ROOT_URI = "file://" + ROOT + "/";

// What the model returns: the note and the JSON block
const AI_RESPONSE = AI_MD + `
\`\`\`json
{"study_design": "RCT", "sample_size": 120, "setting": "內科病房", "population": "住院病人",
 "intervention": "衛教", "comparison": "常規照護", "outcomes": "跌倒發生率", "measures": ["Morse Fall Scale"],
 "evidence_level": "2", "jbi_level": "1.c", "appraisal_tool": "JBI Checklist for Randomized Controlled Trials",
 "appraisal_overall": "納入", "country": "Taiwan"}
\`\`\`
`;

// Gecko login manager (Services.logins) backed by an array; lookups return the stored objects
function loginManagerMock(initial = []) {
	let logins = [...initial];
	let same = (a, b) => a.origin === b.origin && a.httpRealm === b.httpRealm && a.username === b.username;
	return {
		logins,
		searchLoginsAsync: async match => logins.filter(l => Object.entries(match).every(([k, v]) => l[k] === v)),
		addLoginAsync: async (login) => {
			if (logins.some(l => same(l, login))) throw new Error("This login already exists.");
			logins.push(login);
			return login;
		},
		modifyLoginAsync: async (old, login) => {
			let i = logins.indexOf(old);
			if (i < 0) throw new Error("No matching logins");
			logins[i] = login;
		},
		removeLoginAsync: async (old) => {
			let i = logins.indexOf(old);
			if (i < 0) throw new Error("No matching logins");
			logins.splice(i, 1);
		},
	};
}

function LoginInfo(origin, formActionOrigin, httpRealm, username, password) {
	Object.assign(this, { origin, formActionOrigin, httpRealm, username, password });
}

// `timers`, when given, collects the plugin's long setTimeout callbacks (auto-sync debounce,
// self-modified expiry) so a test can fire them itself
function makeEnv({ prefs, fetch, logins = [], confirm = () => true, confirmEx = () => 1, timers }) {
	let items = new Map();
	let observers = [];
	let nextID = 100;
	let menus = [];
	let progressLines = [];
	let descriptions = [];
	let errors = [];
	let panes = [];
	let translations = [];

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
			this.annotations = [];
			this.noteHTML = "";
			this.dateAdded = fields.dateAdded || "2024-05-01 08:00:00";
			this.dateModified = fields.dateModified || "2024-05-02 08:00:00";
			this.version = 0;
			items.set(this.id, this);
		}
		get parentItem() { return this.parentID ? items.get(this.parentID) : undefined; }
		isRegularItem() { return !["note", "attachment", "annotation"].includes(this.itemType); }
		isNote() { return this.itemType === "note"; }
		isFileAttachment() { return this.itemType === "attachment"; }
		isPDFAttachment() { return this.itemType === "attachment"; }
		get attachmentContentType() { return "application/pdf"; }
		get attachmentText() { return Promise.resolve(this.fields.fulltext || ""); }
		getField(f) { return this.fields[f] || ""; }
		getCreatorsJSON() { return this.fields.creators || []; }
		getTags() { return this.tags.map(tag => ({ tag })); }
		addTag(t) { this.tags.push(t); }
		removeTag(t) { this.tags = this.tags.filter(x => x !== t); }
		getCollections() { return this.fields.collectionIDs || []; }
		getAttachments() { return this.children.filter(id => items.get(id).itemType === "attachment"); }
		getNotes() { return this.children.filter(id => items.get(id).itemType === "note"); }
		getAnnotations() { return this.annotations; }
		getNote() { return this.noteHTML; }
		setNote(h) { this.noteHTML = h; }
		getNoteTitle() { return "note"; }
		getItemTypeIconName() { return this.itemType; }
		addToCollection(id) { this.collectionsAdded = (this.collectionsAdded || []).concat(id); }
		addRelatedItem(item) { this.related = (this.related || []).concat(item.key); }
		async saveTx() {
			if (this.parentID && !items.get(this.parentID).children.includes(this.id)) {
				items.get(this.parentID).children.push(this.id);
			}
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
		MenuManager: {
			registerMenu: (opts) => { menus.push(opts); return opts.menuID; },
			unregisterMenu: () => true,
		},
		Notifier: {
			registerObserver: (ref, types) => { observers.push({ ref, types }); return "obs"; },
			unregisterObserver: () => { observers.length = 0; },
		},
		ItemPaneManager: {
			registerSection: (opts) => { panes.push(opts); return opts.paneID; },
			unregisterSection: () => true,
		},
		PreferencePanes: { register: async () => "pane" },
		getMainWindows: () => [],
		getMainWindow: () => ({}),
		Items: {
			get: ids => (Array.isArray(ids) ? ids.map(id => items.get(id)) : items.get(ids)),
			exists: id => items.has(id),
			getByLibraryAndKey: (libraryID, key) => [...items.values()].find(i => i.libraryID === libraryID && i.key === key) || false,
			// Top-level items not in the trash (annotations aren't modelled here)
			getAll: async (libraryID, onlyTopLevel) => [...items.values()]
				.filter(i => i.libraryID === libraryID && !i.deleted && (!onlyTopLevel || !i.parentID)),
		},
		Item: function (type) { return new MockItem(type); },
		Libraries: {
			get: () => ({ libraryType: "user", name: "My Library" }),
			getAll: () => [{ libraryID: 1, libraryType: "user", name: "My Library" }],
		},
		Utilities: {
			Item: {
				// Stand-in for Zotero's CSL conversion: the id is the item URI, as in Zotero
				itemToCSLJSON: item => ({
					id: `http://zotero.org/users/1/items/${item.key}`,
					type: "article-journal",
					title: item.fields.title,
					author: (item.fields.creators || []).map(c => ({ family: c.lastName, given: c.firstName })),
					issued: { "date-parts": [[Number(item.fields.year)]] },
					page: item.fields.pages,
					URL: "https://example.org/" + item.key,
				}),
			},
		},
		Translate: {
			Export: class {
				constructor() { this.handlers = {}; translations.push(this); }
				setItems(list) { this.items = list; }
				setTranslator(id) { this.translatorID = id; }
				setDisplayOptions(o) { this.displayOptions = o; }
				setHandler(type, fn) { this.handlers[type] = fn; }
				async translate() {
					// Like Zotero's ItemGetter: ascending item ID, one entry per regular item
					this.items.sort((a, b) => a.id - b.id);
					this.string = "\n" + this.items.map(i => `@article{${i.key.toLowerCase()}_bibtex,\n\ttitle = {${i.fields.title}},\n}`).join("\n\n") + "\n";
					this.handlers.done(this, true);
				}
			},
		},
		Groups: { getGroupIDFromLibraryID: () => null },
		Collections: {
			get: (ids) => {
				let all = { 7: { name: "碩論", parentID: null }, 8: { name: "文獻回顧", parentID: 7 } };
				return Array.isArray(ids) ? ids.map(id => all[id]) : all[ids];
			},
			getByParent: () => [],
		},
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
			addDescription(t) {
				this.description = t;
				descriptions.push(t);
			}
			show() {}
			startCloseTimer() {}
		},
		logError: (e) => { errors.push(e); },
		debug: () => {},
	};
	// Zotero.Item is used with `new`
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
			return { path: p, type: st.isDirectory() ? "directory" : st.isFile() ? "regular" : "other", size: st.size };
		},
		move: async (from, to, opts = {}) => {
			if (opts.noOverwrite && fs.existsSync(to)) throw new Error("NoModificationAllowedError: " + to);
			await fsp.rename(from, to);
		},
	};
	let PathUtils = { join: (...parts) => path.join(...parts), filename: p => path.basename(p), parent: p => path.dirname(p) };

	let loginManager = loginManagerMock(logins);
	let context = vm.createContext({
		Zotero, IOUtils, PathUtils, fetch, console, TextDecoder,
		Components: {
			// `new Components.Constructor(cid, iface, "init")` returns the nsILoginInfo constructor
			Constructor: function (cid, iface, init) {
				assert.equal(cid, "@mozilla.org/login-manager/loginInfo;1");
				assert.equal(init, "init");
				return LoginInfo;
			},
			interfaces: { nsILoginInfo: {} },
		},
		DOMParser: new JSDOM("").window.DOMParser,
		// Short waits (Notion rate limiting) run for real
		setTimeout: timers ? (fn, ms) => (ms >= 8000 ? timers.push({ fn, ms }) : setTimeout(fn, ms)) : setTimeout,
		clearTimeout: timers ? (id) => (typeof id === "number" ? timers[id - 1].cleared = true : clearTimeout(id)) : clearTimeout,
		Services: {
			scriptloader: {
				loadSubScript: (url) => {
					let file = url.replace("file://", "");
					vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
				},
			},
			prompt: {
				confirm: (win, title, text) => confirm(text),
				// nsIPromptService: the button constants and confirmEx (returns the button pressed)
				BUTTON_POS_0: 1, BUTTON_POS_1: 256, BUTTON_POS_2: 65536, BUTTON_POS_0_DEFAULT: 0,
				BUTTON_TITLE_IS_STRING: 127, BUTTON_TITLE_CANCEL: 2,
				confirmEx: (win, title, text, flags, b0, b1, b2) => confirmEx(text, [b0, b1, b2]),
			},
			logins: loginManager,
		},
	});
	vm.runInContext(fs.readFileSync(path.join(ROOT, "bootstrap.js"), "utf8"), context, { filename: "bootstrap.js" });
	return { context, Zotero, MockItem, addChild, menus, progressLines, descriptions, items, prefStore, errors, panes, loginManager, translations, observers };
}

const BATCHES = "https://api.anthropic.com/v1/messages/batches";
const RESULTS = BATCHES + "/msgbatch_01/results";

// The Claude API: /v1/messages (normal path) and the Message Batches endpoints. `api.outcomes` maps a
// custom_id to the result written once the batch has ended; `api.createStatus` (e.g. 400) fails creation.
function claudeMock(log) {
	let api = { status: "in_progress", created: null, outcomes: {}, createStatus: 200, canceled: false };
	let message = (extra = {}) => Object.assign({
		id: "msg_x", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn",
		content: [{ type: "text", text: AI_RESPONSE }],
		usage: { input_tokens: 2000, output_tokens: 3000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
	}, extra);
	let json = (status, obj) => ({ status, ok: status < 300, statusText: "", headers: { get: () => null }, text: async () => JSON.stringify(obj) });
	let info = () => {
		let total = api.created ? api.created.requests.length : 0;
		let ended = api.status === "ended";
		let counts = { processing: ended ? 0 : total, succeeded: 0, errored: 0, canceled: 0, expired: 0 };
		if (ended) {
			for (let r of api.created.requests) counts[(api.outcomes[r.custom_id] || { type: "canceled" }).type]++;
		}
		return {
			id: "msgbatch_01", type: "message_batch", processing_status: api.status, request_counts: counts,
			created_at: "2026-10-08T01:00:00Z", expires_at: "2026-10-09T01:00:00Z", ended_at: ended ? "2026-10-08T01:20:00Z" : null,
			cancel_initiated_at: api.canceled ? "2026-10-08T01:05:00Z" : null, results_url: ended ? RESULTS : null,
		};
	};
	let fetch = async (url, init) => {
		let body = init.body ? JSON.parse(init.body) : undefined;
		log.push({ url, method: init.method, body, headers: init.headers });
		if (url === "https://api.anthropic.com/v1/messages") return json(200, message());
		if (url === BATCHES && init.method === "POST") {
			if (api.createStatus !== 200) return json(api.createStatus, { type: "error", error: { type: "invalid_request_error", message: "bad batch" } });
			api.created = body;
			return json(200, info());
		}
		if (url === BATCHES + "/msgbatch_01" && init.method === "GET") return json(200, info());
		if (url === BATCHES + "/msgbatch_01/cancel" && init.method === "POST") {
			api.canceled = true;
			api.status = "canceling";
			return json(200, info());
		}
		if (url === RESULTS && init.method === "GET") {
			let lines = api.created.requests.map((r) => {
				let o = api.outcomes[r.custom_id] || { type: "canceled" };
				let result = o.type === "succeeded" ? { type: "succeeded", message: message(o.message) } : o;
				return JSON.stringify({ custom_id: r.custom_id, result });
			});
			// Results come in any order
			return { status: 200, ok: true, headers: { get: () => null }, text: async () => lines.reverse().join("\n") + "\n" };
		}
		return json(404, { type: "error", error: { type: "not_found_error", message: url } });
	};
	return { fetch, api, message };
}

const creators = [{ lastName: "Chen", creatorType: "author" }];

// a–e need an AI note, f has nothing to read, g already has its AI note (same keys in every Zotero start)
function addItems(env, names = ["a", "b", "c", "d", "e", "f", "g"]) {
	let items = {};
	for (let k of names) {
		items[k] = new env.MockItem("journalArticle", {
			title: `Paper ${k}`, year: "2024", citationKey: `key${k}`, creators, key: `KEY${k.toUpperCase()}`,
			abstractNote: k === "f" ? "" : `Abstract ${k}: falls decreased in the intervention group.`,
		});
	}
	if (items.g) {
		let note = new env.MockItem("note");
		note.noteHTML = "<h1>🤖 AI 文獻筆記</h1>\n<p><em>由 claude-opus-5-5 於 2026-01-01T00:00:00Z 產生（Zotero Bridge）</em></p>\n<h2>一句話摘要</h2>\n<p>舊的筆記</p>";
		note.tags = ["zotero-bridge-ai"];
		env.addChild(items.g, note);
	}
	return items;
}

function prefsFor(vault, extra = {}) {
	return Object.assign({
		"extensions.zotero-bridge.obsidian.vaultPath": vault,
		"extensions.zotero-bridge.obsidian.folder": "Zotero",
		"extensions.zotero-bridge.obsidian.filenameFormat": "citekey",
		"extensions.zotero-bridge.obsidian.createBase": false,
		"extensions.zotero-bridge.dashboard.autoUpdate": false,
		"extensions.zotero-bridge.concepts.autoUpdate": false,
		"extensions.zotero-bridge.notion.token": "",
		"extensions.zotero-bridge.routing.rules": "[]",
		"extensions.zotero-bridge.llm.enabled": true,
		"extensions.zotero-bridge.llm.provider": "anthropic",
		"extensions.zotero-bridge.llm.anthropicKey": "sk-ant-test",
		"extensions.zotero-bridge.llm.anthropicModel": "claude-opus-5-5",
		"extensions.zotero-bridge.llm.fullTextLimit": "1000",
		"extensions.zotero-bridge.llm.batchAPI": true,
		"extensions.zotero-bridge.llm.batchThreshold": "3",
		// Two earlier calls averaging 10,000 input + 2,000 output tokens = $0.08 per call
		"extensions.zotero-bridge.usage.ledger": JSON.stringify({
			"2020-01": { calls: 2, input: 20000, output: 4000, byModel: { "claude-opus-5-5": { calls: 2, input: 20000, output: 4000 } } },
		}),
	}, extra);
}

async function start(env) {
	await vm.runInContext(`startup({ id: "zb", version: "0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);
	return env.context.ZB;
}

// The plugin's poll timers (the shorter ones are auto-sync / self-modified expiries)
const pollTimers = timers => timers.filter(t => t.ms >= 60000 && !t.cleared && !t.fired);

async function fire(timer) {
	timer.fired = true;
	await timer.fn();
}

function toolsEntry(env, l10nID) {
	let menu = env.menus.find(m => m.menuID === "zotero-bridge-ai-batch-tools");
	return menu.menus.find(m => m.l10nID === l10nID);
}

function visible(env, l10nID) {
	let state = true;
	toolsEntry(env, l10nID).onShowing({}, { setVisible: (v) => { state = v; } });
	return state;
}

const aiNoteOf = (env, item) => env.Zotero.Items.get(item.getNotes()).find(n => n.tags.includes("zotero-bridge-ai"));
const pending = env => JSON.parse(env.prefStore["extensions.zotero-bridge.batch.pending"] || "null");
const stored = env => JSON.parse(env.prefStore["extensions.zotero-bridge.batch.ai"] || "null");

test("AI batch: confirm, one batch with the normal requests, restart while in progress, results applied and synced", async () => {
	let vault = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-batch-"));
	let log = [];
	let claude = claudeMock(log);
	let timers = [];
	let confirms = [];
	let env = makeEnv({
		fetch: claude.fetch, timers, prefs: prefsFor(vault),
		confirmEx: (text, buttons) => {
			confirms.push({ text, buttons });
			return 0;
		},
	});
	let ZB = await start(env);
	assert.equal(env.menus.at(-1).menuID, "zotero-bridge-ai-batch-tools");
	assert.equal(visible(env, "zotero-bridge-menu-ai-batch-check"), false);
	assert.equal(visible(env, "zotero-bridge-menu-ai-batch-cancel"), false);
	let items = addItems(env);
	await ZB.main.run(Object.values(items), { targets: ["obsidian"], ai: "missing" });

	// The choice, with the normal and the batch estimate
	assert.equal(confirms.length, 1);
	assert.deepEqual(confirms[0].buttons, ["批次 API（約半價）", null, "一般模式（立即產生）"]);
	assert.match(confirms[0].text, /即將為 6 筆文獻呼叫 Claude（claude-opus-5-5）產生 AI 筆記/);
	assert.match(confirms[0].text, /預估費用：一般模式約 US\$0\.48；批次 API 約 US\$0\.24（6 筆，依過去 2 次呼叫的平均用量估算/);

	// One batch, no single calls; f (nothing to read) and g (has its note) went through the normal loop
	assert.equal(log.filter(l => l.url === "https://api.anthropic.com/v1/messages").length, 0);
	let creates = log.filter(l => l.url === BATCHES);
	assert.equal(creates.length, 1);
	assert.equal(creates[0].method, "POST");
	assert.equal(creates[0].headers["x-api-key"], "sk-ant-test");
	assert.equal(creates[0].headers["anthropic-version"], "2023-06-01");
	assert.equal(creates[0].headers["anthropic-beta"], undefined, "no server-side fallback in a batch");
	let requests = creates[0].body.requests;
	assert.deepEqual(requests.map(r => r.custom_id), ["1-KEYA", "1-KEYB", "1-KEYC", "1-KEYD", "1-KEYE"]);
	for (let r of requests) {
		assert.equal(r.params.model, "claude-opus-5-5");
		assert.equal(r.params.fallbacks, undefined);
		assert.deepEqual(r.params.system.at(-1).cache_control, { type: "ephemeral", ttl: "1h" });
		assert.equal(r.params.system.at(-1).text, ZB.llm.STUDY_DATA_PROMPT);
		assert.deepEqual(r.params.system, requests[0].params.system, "the same cached prefix for every item");
	}
	assert.match(requests[2].params.messages[0].content, /標題：Paper c[\s\S]*Abstract c: falls decreased/);
	assert.deepEqual(fs.readdirSync(path.join(vault, "Zotero")).sort(), ["keyf.md", "keyg.md"]);
	assert.match(env.progressLines.find(l => /已送出 AI 批次/.test(l.text)).text, /已送出 AI 批次：5 筆（約半價）/);
	assert.ok(env.descriptions.some(d => /通常 1 小時內完成（最長 24 小時）/.test(d)));
	assert.deepEqual(env.errors, []);

	// Persisted: batch id, item refs, created time
	let saved = stored(env).batches;
	assert.equal(saved.length, 1);
	assert.equal(saved[0].id, "msgbatch_01");
	assert.equal(saved[0].createdAt, "2026-10-08T01:00:00Z");
	assert.deepEqual(saved[0].action, { targets: ["obsidian"], ai: "missing" });
	assert.deepEqual(saved[0].requests.map(r => [r.id, r.ref, r.title]), ["a", "b", "c", "d", "e"].map(k => [`1-KEY${k.toUpperCase()}`, `1/KEY${k.toUpperCase()}`, `Paper ${k}`]));
	assert.match(saved[0].requests[0].notes.join(), /沒有 PDF 全文/);
	assert.equal(pending(env), null, "the run itself finished");
	assert.deepEqual(pollTimers(timers).map(t => t.ms), [120000], "first poll after 2 minutes");
	assert.equal(visible(env, "zotero-bridge-menu-ai-batch-check"), true);
	assert.equal(visible(env, "zotero-bridge-menu-ai-batch-cancel"), true);

	// Tools → 檢查 AI 批次進度
	await toolsEntry(env, "zotero-bridge-menu-ai-batch-check").onCommand();
	assert.match(env.descriptions.at(-1), /^AI 批次（5 筆，.* 送出）：處理中，已完成 0／5，已等待 \d+/);

	// Zotero quits while the batch is in progress: the timer is cleared, the pref keeps the batch
	await vm.runInContext("shutdown()", env.context);
	assert.deepEqual(pollTimers(timers), []);
	assert.equal(stored(env).batches[0].id, "msgbatch_01");

	// Next start: polling resumes
	let timers2 = [];
	let confirms2 = [];
	let env2 = makeEnv({
		fetch: claude.fetch, timers: timers2, prefs: env.prefStore, logins: env.loginManager.logins,
		confirmEx: (text) => {
			confirms2.push(text);
			return 2;
		},
	});
	let ZB2 = await start(env2);
	let items2 = addItems(env2);
	assert.deepEqual(pollTimers(timers2).map(t => t.ms), [60000], "soon after startup");
	await fire(pollTimers(timers2)[0]);
	assert.deepEqual(pollTimers(timers2).map(t => t.ms), [180000], "still in progress: next poll in 3 minutes");

	// The batch ends: two notes, an error, a refusal (no fallback in a batch) and an expired request
	claude.api.status = "ended";
	claude.api.outcomes = {
		"1-KEYA": { type: "succeeded", message: { usage: { input_tokens: 2000, output_tokens: 3000, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0 } } },
		"1-KEYB": { type: "succeeded", message: { usage: { input_tokens: 2000, output_tokens: 3000, cache_read_input_tokens: 0, cache_creation_input_tokens: 4000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 4000 } } } },
		"1-KEYC": { type: "errored", error: { type: "error", error: { type: "api_error", message: "Internal server error" } } },
		"1-KEYD": { type: "succeeded", message: { stop_reason: "refusal", stop_details: { category: "bio" }, content: [] } },
		"1-KEYE": { type: "expired" },
	};
	log.length = 0;
	await fire(pollTimers(timers2)[0]);
	assert.deepEqual(env2.errors, []);
	assert.deepEqual(log.map(l => `${l.method} ${l.url}`), [`GET ${BATCHES}/msgbatch_01`, `GET ${RESULTS}`]);
	assert.equal(log[1].headers["x-api-key"], "sk-ant-test");

	// AI notes saved like the normal path's: structured data, quote check, the model line
	for (let k of ["a", "b"]) {
		let note = aiNoteOf(env2, items2[k]);
		assert.ok(note, k);
		assert.match(note.noteHTML, /^<h1>🤖 AI 文獻筆記<\/h1>\n<p><em>由 claude-opus-5-5 於 .* 產生（Zotero Bridge）<\/em><\/p>/);
		assert.match(note.noteHTML, /<h2>📋 結構化資料（Zotero Bridge）<\/h2>\n<pre>\{\n {2}&quot;study_design&quot;: &quot;RCT&quot;/);
		// Quote verification: no full text here, so the quote is flagged as not checkable
		assert.match(note.noteHTML, /Falls decreased by 30%&quot; \(p\. 5\) ⚠️ 無全文可查證/);
	}
	for (let k of ["c", "d", "e"]) assert.equal(aiNoteOf(env2, items2[k]), undefined, k);
	let lineOf = title => env2.progressLines.find(l => l.text.startsWith(title + " — ") || l.text === title);
	assert.match(lineOf("Paper a").text, /沒有 PDF 全文[\s\S]*可引用句/);
	assert.equal(lineOf("Paper c").error, true);
	assert.match(lineOf("Paper c").text, /AI 筆記：批次請求失敗（api_error: Internal server error）/);
	assert.match(lineOf("Paper d").text, /AI 筆記：Claude 拒絕處理這篇文獻（bio）/);
	assert.match(lineOf("Paper e").text, /AI 筆記：批次超過 24 小時/);
	assert.ok(env2.descriptions.includes("AI 批次：成功 2 筆，失敗 3 筆"), env2.descriptions.join("\n"));
	// a: (2,000 × $4 + 3,000 × $20 + 4,000 × $0.20) / 2; b: (2,000 × $4 + 3,000 × $20 + 4,000 × $8 (1-hour write)) / 2
	assert.ok(env2.descriptions.includes("AI 用量：2 次呼叫，輸入 12,000／輸出 6,000 tokens，約 US$0.08"), env2.descriptions.join("\n"));

	// Usage ledger at batch prices
	let month = JSON.parse(env2.prefStore["extensions.zotero-bridge.usage.ledger"])[ZB2.usage.monthKey()];
	assert.deepEqual(month.byModel["claude-opus-5-5 (batch)"], { calls: 2, input: 4000, output: 6000, cacheRead: 4000, cacheWrite: 4000, cacheWrite1h: 4000 });
	let report = ZB2.main.usageReport();
	assert.equal(report[2], "估計費用：US$0.08");
	assert.equal(report[3], "批次 API：2 次呼叫，比一般模式省下約 US$0.08");
	assert.match(report[4], /^提示快取：/);

	// Synced to Obsidian with the new notes (ai: "reuse")
	assert.deepEqual(fs.readdirSync(path.join(vault, "Zotero")).sort(), ["keya.md", "keyb.md", "keyf.md", "keyg.md"]);
	let text = fs.readFileSync(path.join(vault, "Zotero", "keya.md"), "utf8");
	assert.match(text, /^ai_model: "claude-opus-5-5"$/m);
	assert.match(text, /^study_design: "RCT"$/m);
	assert.match(text, /\[\[Fall prevention\]\]/);

	// Failures listed for 「繼續未完成的同步」; the batch is gone, polling stops
	let retry = pending(env2);
	assert.deepEqual(retry.action, { targets: ["obsidian"], ai: "missing" });
	assert.deepEqual(retry.remaining, []);
	assert.deepEqual(retry.failed, ["1/KEYC", "1/KEYD", "1/KEYE"]);
	assert.equal(retry.running, false);
	assert.equal(env2.prefStore["extensions.zotero-bridge.batch.ai"], "");
	assert.deepEqual(pollTimers(timers2), []);
	assert.equal(visible(env2, "zotero-bridge-menu-ai-batch-check"), false);

	// Retry on the normal path (chosen in the dialog): the same requests, with the server-side fallback
	log.length = 0;
	await ZB2.main.resumeBatch();
	assert.equal(confirms2.length, 1);
	assert.match(confirms2[0], /即將為 3 筆文獻呼叫 Claude/);
	let calls = log.filter(l => l.url === "https://api.anthropic.com/v1/messages");
	assert.equal(calls.length, 3);
	assert.equal(log.filter(l => l.url.startsWith(BATCHES)).length, 0);
	for (let call of calls) {
		assert.equal(call.body.fallbacks, "default");
		assert.equal(call.headers["anthropic-beta"], "server-side-fallback-2026-07-01");
		// The batch request for this item was the same body, adjusted only for the Batches API
		let id = `1-KEY${/標題：Paper (\w)/.exec(call.body.messages[0].content)[1].toUpperCase()}`;
		assert.deepEqual(requests.find(r => r.custom_id === id).params, JSON.parse(JSON.stringify(ZB2.aiBatch.batchParams(call.body))));
	}
	for (let k of ["c", "d", "e"]) assert.ok(aiNoteOf(env2, items2[k]), k);
	assert.equal(pending(env2), null);
	assert.deepEqual(env2.errors, []);
	await vm.runInContext("shutdown()", env2.context);
});

test("AI batch: cancel from the Tools menu; finished results are kept, the rest goes to the retry list", async () => {
	let vault = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-batch-"));
	let log = [];
	let claude = claudeMock(log);
	let timers = [];
	let confirms = [];
	let env = makeEnv({
		fetch: claude.fetch, timers, prefs: prefsFor(vault, { "extensions.zotero-bridge.usage.ledger": "{}" }),
		confirm: (text) => {
			confirms.push(text);
			return true;
		},
		confirmEx: () => 0,
	});
	let ZB = await start(env);
	let items = addItems(env, ["a", "b", "c"]);
	await ZB.main.run(Object.values(items), { targets: ["obsidian"], ai: "regenerate" });
	assert.equal(log.filter(l => l.url === BATCHES).length, 1);
	assert.equal(stored(env).batches[0].requests.length, 3);

	await toolsEntry(env, "zotero-bridge-menu-ai-batch-cancel").onCommand();
	assert.match(confirms.at(-1), /要取消 1 個 AI 批次（3 筆）嗎？/);
	assert.ok(log.some(l => l.method === "POST" && l.url === BATCHES + "/msgbatch_01/cancel"));
	assert.equal(stored(env).batches[0].status, "canceling");
	assert.match(env.descriptions.at(-1), /已要求取消/);

	// Ended after the cancel: one result had finished, two were canceled
	claude.api.status = "ended";
	claude.api.outcomes = { "1-KEYA": { type: "succeeded" }, "1-KEYB": { type: "canceled" }, "1-KEYC": { type: "canceled" } };
	let timer = pollTimers(timers).at(-1);
	assert.equal(timer.ms, 120000);
	await fire(timer);
	assert.ok(aiNoteOf(env, items.a));
	assert.ok(fs.existsSync(path.join(vault, "Zotero", "keya.md")));
	assert.equal(aiNoteOf(env, items.b), undefined);
	assert.deepEqual(pending(env).failed, ["1/KEYB", "1/KEYC"]);
	assert.deepEqual(pending(env).action, { targets: ["obsidian"], ai: "regenerate" });
	assert.match(env.progressLines.find(l => l.text.startsWith("Paper b — ")).text, /批次已取消/);
	assert.equal(stored(env), null);
	assert.deepEqual(env.errors, []);
	await vm.runInContext("shutdown()", env.context);
});

test("AI batch: below the threshold, with the setting off or when the batch cannot be created, the normal path runs", async () => {
	let vault = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-batch-"));
	let log = [];
	let claude = claudeMock(log);
	let asked = 0;
	let env = makeEnv({
		fetch: claude.fetch, timers: [], prefs: prefsFor(vault, { "extensions.zotero-bridge.usage.ledger": "{}" }),
		confirmEx: () => {
			asked++;
			return 0;
		},
	});
	let ZB = await start(env);
	let items = addItems(env, ["a", "b", "c"]);
	// Two AI notes: below the threshold of 3
	await ZB.main.run([items.a, items.b], { targets: ["obsidian"], ai: "missing" });
	assert.equal(asked, 0);
	assert.equal(log.filter(l => l.url === "https://api.anthropic.com/v1/messages").length, 2);

	// Creation fails (HTTP 400): the items go through the normal path in the same run
	log.length = 0;
	claude.api.createStatus = 400;
	await ZB.main.run(Object.values(items), { targets: ["obsidian"], ai: "regenerate" });
	assert.equal(asked, 1);
	assert.equal(log.filter(l => l.url === BATCHES).length, 1);
	assert.equal(log.filter(l => l.url === "https://api.anthropic.com/v1/messages").length, 3);
	assert.ok(env.descriptions.some(d => /⚠️ 批次 API：Claude 批次 API 400: bad batch；3 筆改用一般模式/.test(d)), env.descriptions.join("\n"));
	assert.equal(stored(env), null);

	// Setting off: never asked
	env.prefStore["extensions.zotero-bridge.llm.batchAPI"] = false;
	log.length = 0;
	await ZB.main.run(Object.values(items), { targets: ["obsidian"], ai: "regenerate" });
	assert.equal(asked, 1);
	assert.equal(log.filter(l => l.url.startsWith(BATCHES)).length, 0);
	// OpenAI: never batched
	env.prefStore["extensions.zotero-bridge.llm.batchAPI"] = true;
	assert.equal(ZB.aiBatch.applies(10, {}, { llm: { enabled: true, batchAPI: true, provider: "openai", batchThreshold: 3 } }), false);
	assert.equal(ZB.aiBatch.applies(10, { silent: true }, { llm: { enabled: true, batchAPI: true, provider: "anthropic", batchThreshold: 3 } }), false);
	assert.equal(ZB.aiBatch.applies(3, {}, { llm: { enabled: true, batchAPI: true, provider: "anthropic", batchThreshold: 3 } }), true);
	await vm.runInContext("shutdown()", env.context);
});
