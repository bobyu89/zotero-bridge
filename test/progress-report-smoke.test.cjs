// Advisor progress report through the real plugin in a mocked Zotero: the status log from syncs and
// the item pane, the command → dialog → the report note (reading, PRISMA change, drafts, PubMed,
// carried-over goals), the optional AI paragraph (request shape, cost confirm, usage ledger), the
// clipboard text, the Notion page, the dashboard link, and a same-day rebuild that keeps the user's edits.
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

// The parts of Zotero, Gecko and the plugin scope that a sync and the report touch (copied from dashboard-smoke)
function makeEnv({ prefs, fetch, confirm = () => true }) {
	let items = new Map();
	let nextID = 100;
	let menus = [];
	let progressLines = [];
	let descriptions = [];
	let errors = [];
	let confirms = [];
	let prompts = [];
	let clipboard = [];
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
			let parent = this.parentID && items.get(this.parentID);
			if (parent && !parent.children.includes(this.id)) parent.children.push(this.id);
			for (let t of this.tags) knownTags.add(t);
			return this.id;
		}
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
		getActiveZoteroPane: () => ({ getSelectedCollections: () => [] }),
		Items: {
			get: ids => (Array.isArray(ids) ? ids.map(id => items.get(id)) : items.get(ids)),
			exists: id => items.has(id),
			getByLibraryAndKey: (libraryID, key) => [...items.values()].find(i => i.libraryID === libraryID && i.key === key) || false,
			getAll: async () => [],
		},
		Libraries: { userLibraryID: 1, get: () => ({ libraryType: "user", name: "My Library" }), getAll: () => [] },
		Groups: { getGroupIDFromLibraryID: () => null, getLibraryIDFromGroupID: () => null },
		Collections: { get: ids => (Array.isArray(ids) ? [] : null), getByParent: () => [] },
		Tags: { getID: name => (knownTags.has(name) ? 1 : false) },
		Styles: { get: () => null },
		Utilities: { Internal: { copyTextToClipboard: (t) => { clipboard.push(t); } } },
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
			return { type: st.isDirectory() ? "directory" : "regular", size: st.size, lastModified: st.mtimeMs };
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
				prompt: (win, title, text, value) => {
					prompts.push([text, value.value]);
					value.value = prompts.length === 1 ? "問題一；問題二" : "目標一";
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
	return { context, MockItem, items, menus, progressLines, descriptions, errors, confirms, prompts, clipboard, prefStore };
}

const SUMMARY = "本期讀完 1 篇文獻，系統性回顧納入 6 篇、尚待篩選 3 篇，PubMed 追蹤匯入 2 篇。";

function services(log, notion) {
	let ok = json => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(json) });
	return async (url, init) => {
		let body = init.body ? JSON.parse(init.body) : undefined;
		if (url.startsWith("https://api.anthropic.com/")) {
			log.push({ api: "anthropic", body });
			return ok({ model: "test-model", stop_reason: "end_turn", content: [{ type: "text", text: SUMMARY }], usage: { input_tokens: 3000, output_tokens: 400 } });
		}
		let p = url.replace("https://api.notion.com/v1/", "");
		log.push({ api: "notion", method: init.method, path: p, body });
		if (p === "pages" && init.method === "POST") {
			notion.pages.push(body);
			return ok({ id: `report-page-${notion.pages.length}`, url: `https://www.notion.so/report-page-${notion.pages.length}` });
		}
		if (/^pages\/report-page-\d+$/.test(p) && init.method === "GET") {
			return ok({ id: p.slice(6), url: `https://www.notion.so/${p.slice(6)}`, in_trash: false });
		}
		if (/^blocks\/report-page-\d+\/children\?/.test(p)) return ok({ results: notion.children, has_more: false });
		if (/^blocks\/report-page-\d+\/children$/.test(p)) {
			notion.children = [{ id: "container-1", type: "callout", callout: { rich_text: [{ plain_text: "ZotMax｜…" }] } }];
			return ok({ results: [{ id: "container-1" }] });
		}
		if (p === "blocks/container-1" && init.method === "DELETE") return ok({});
		return { status: 404, ok: false, headers: { get: () => null }, text: async () => JSON.stringify({ message: p }) };
	};
}

async function setup(opts = {}) {
	let vault = opts.vault === null ? "" : await fsp.mkdtemp(path.join(os.tmpdir(), "zb-report-"));
	let log = [];
	let notion = { pages: [], children: [] };
	let env = makeEnv({
		fetch: services(log, notion),
		confirm: opts.confirm,
		prefs: Object.assign({
			"extensions.zotero-bridge.obsidian.vaultPath": vault,
			"extensions.zotero-bridge.obsidian.folder": "Zotero",
			"extensions.zotero-bridge.llm.provider": "anthropic",
			"extensions.zotero-bridge.llm.anthropicKey": "sk-ant-test",
			"extensions.zotero-bridge.llm.anthropicModel": "test-model",
			"extensions.zotero-bridge.notion.token": "ntn_test",
			"extensions.zotero-bridge.notion.synthesisParent": PARENT,
			// Off in the 研究生引導 preset (features.js); on here, also for a profile without a vault
			"extensions.zotero-bridge.feature.progressReport": true,
		}, opts.prefs),
	});
	await vm.runInContext(`startup({ id: "zotero-bridge@bobyu89.github.io", version: "0.0.0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);
	return Object.assign(env, { vault, log, notion, ZB: env.context.ZB });
}

function localDate(d) {
	let p = n => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// Local noon `n` days from today
function noon(n) {
	let d = new Date();
	return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 12, 0, 0);
}
// "YYYY-MM-DD HH:MM:SS" in UTC, as Zotero stores dateAdded
function zoteroDate(date) {
	return date.toISOString().slice(0, 19).replace("T", " ");
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

function addAINote(env, item, at) {
	let ZB = env.ZB;
	let note = new env.MockItem("note", { tags: ["zotero-bridge-ai"] });
	note.parentID = item.id;
	item.children.push(note.id);
	note.setNote(`<h1>🤖 AI 文獻筆記</h1>\n<p><em>由 test-model 於 ${at} 產生（ZotMax）</em></p>\n`
		+ ZB.markdown.mdToHtml(`## 一句話摘要\n\nA summary.\n\n${ZB.llm.studyDataBlock(ZB.llm.normalizeStudyData({ study_design: "RCT" }))}`));
}

/** 產生進度報告（給指導教授） as the toolbar button and 快速指令 run it (commands.js). */
function toolsEntry(env) {
	let C = env.ZB.commands;
	assert.equal(C.get("progress-report").l10n, "zotero-bridge-menu-progress-report");
	assert.equal(C.get("progress-report").group, "ai");
	return { onCommand: () => C.execute("progress-report") };
}

// Run the command (toolbar, 快速指令) and wait for the whole run (dialog, enqueue, generate)
async function runMenu(env) {
	let pr = env.ZB.progressReport;
	let pending = null;
	let run = pr.run;
	pr.run = (...args) => (pending = run(...args));
	toolsEntry(env).onCommand();
	pr.run = run;
	return pending;
}

function reviewNote(ZB, counts) {
	return ZB.screening.buildReviewNote(null, Object.assign({
		title: "跌倒：篩選與 PRISMA 2020", type: "review-screening", last_generated: "2026-10-01T00:00:00Z",
	}, counts), "跌倒：篩選與 PRISMA 2020", "section");
}

test("progress report: status log → menu → dialog → note, AI paragraph, clipboard, Notion, dashboard; same-day rebuild keeps edits", async () => {
	let env = await setup();
	let ZB = env.ZB;
	let pr = ZB.progressReport;
	let day0 = localDate(noon(-7));
	let today = localDate(noon(0));
	let dir = path.join(env.vault, "Zotero");

	// Three papers: one added two days ago with an AI note from yesterday and a verified appraisal form today
	let a = paper(env, 1, { dateAdded: zoteroDate(noon(-2)) });
	addAINote(env, a, noon(-1).toISOString());
	let record = ZB.appraisalTools.normalizeRecord({ tool: "jbi-rct", answers: { 1: "是" }, overall: "納入", verified: true, verifiedAt: today });
	await ZB.appraisalForm.saveRecord(a, record);
	let b = paper(env, 2, { dateAdded: zoteroDate(noon(-30)) });
	let c = paper(env, 3, { dateAdded: zoteroDate(noon(-400)) });
	await ZB.main.run([a, b, c], { targets: ["obsidian"], ai: "reuse" });
	assert.deepEqual(env.errors, []);
	// A first sync records no change (there was no earlier status)
	assert.equal(env.prefStore["extensions.zotero-bridge.progressReport.statusLog"], undefined);
	fs.mkdirSync(path.join(dir, "Reviews"));
	fs.writeFileSync(path.join(dir, "Reviews", "跌倒.md"), reviewNote(ZB, {
		prisma_identified: 30, prisma_screened: 30, prisma_assessed: 10, prisma_included: 4, prisma_awaiting_screening: 8, prisma_awaiting_fulltext: 0,
	}));
	fs.mkdirSync(path.join(dir, "Drafts"));
	let draftPath = path.join(dir, "Drafts", "文獻探討-跌倒.md");
	fs.writeFileSync(draftPath, "---\ntype: \"lit-review-draft\"\ngenerated_at: \"2026-01-02T00:00:00Z\"\n---\n\n# 文獻探討：跌倒\n\n%% zotero-bridge:start — x %%\nAI 草稿不算字數。\n%% zotero-bridge:end %%\n\n## ✍️ 我的筆記\n\n跌倒預防。\n");

	// First report, a week ago: no previous report, the last 14 days
	pr.runtime.now = () => noon(-7);
	let asks = [];
	pr.runtime.ask = async (win, init) => {
		asks.push(JSON.parse(JSON.stringify(init)));
		return Object.assign({}, init, { questions: "樣本數怎麼估？", goals: "完成第二章初稿\n篩選完 20 篇", ai: false, copy: false, notion: false });
	};
	let first = await runMenu(env);
	assert.deepEqual(env.errors, []);
	assert.ok(first, env.descriptions.join("\n") + env.progressLines.map(l => l.text).join("\n"));
	assert.equal(first.relPath, `Zotero/進度報告/${day0}.md`);
	assert.deepEqual(asks[0], {
		period: { start: localDate(noon(-20)), end: day0 }, previousDate: "",
		sections: { reading: true, reviews: true, writing: true, pubmed: true, goals: true },
		questions: "", goals: "", aiAvailable: true, copy: true, notion: false, notionAvailable: true,
	});
	assert.equal(env.confirms.length, 0, "no AI, no cost confirm");
	assert.equal(env.clipboard.length, 0);
	assert.ok(!env.log.length, "no request");

	// During the week: Obsidian marks paper 2 as read (logged by the next sync), more screening, more writing, a PubMed digest
	pr.runtime.now = () => noon(0);
	let notePath = path.join(dir, "Author2 2024 - Study 2 of fall prevention in hospitals.md");
	fs.writeFileSync(notePath, fs.readFileSync(notePath, "utf8").replace("status: \"待讀\"", "status: \"已讀\""));
	await ZB.main.run([b], { targets: ["obsidian"], ai: "reuse" });
	let statusLog = JSON.parse(env.prefStore["extensions.zotero-bridge.progressReport.statusLog"]);
	assert.deepEqual(statusLog, { "library/PAPER002": [{ date: today, from: "待讀", to: "已讀" }] });
	// The item pane picker logs at once; the next sync seeing the same change adds nothing
	let { window } = new JSDOM("<body></body>");
	let body = window.document.body;
	ZB.status.renderPaneRow(window.document, body, c);
	let select = body.querySelector("select");
	select.value = "閱讀中";
	select.dispatchEvent(new window.Event("change"));
	statusLog = JSON.parse(env.prefStore["extensions.zotero-bridge.progressReport.statusLog"]);
	assert.deepEqual(statusLog["library/PAPER003"], [{ date: today, from: "待讀", to: "閱讀中" }]);
	await ZB.main.run([c], { targets: ["obsidian"], ai: "reuse" });
	assert.equal(JSON.parse(env.prefStore["extensions.zotero-bridge.progressReport.statusLog"])["library/PAPER003"].length, 1);

	fs.writeFileSync(path.join(dir, "Reviews", "跌倒.md"), reviewNote(ZB, {
		prisma_identified: 40, prisma_screened: 35, prisma_assessed: 10, prisma_included: 6, prisma_awaiting_screening: 3, prisma_awaiting_fulltext: 1,
	}));
	fs.appendFileSync(draftPath, "研究缺口在社區。\n");
	fs.mkdirSync(path.join(dir, "新文獻"));
	fs.writeFileSync(path.join(dir, "新文獻", `${today}.md`), ZB.pubmedWatch.buildDigestNote(null, today, [{ name: "跌倒預防", entries: [{ pmid: "1", title: "T1" }, { pmid: "2", title: "T2" }] }]));
	fs.writeFileSync(path.join(dir, "新文獻", `${localDate(noon(-30))}.md`), ZB.pubmedWatch.buildDigestNote(null, "old", [{ name: "舊的", entries: [{ pmid: "9", title: "Old" }] }]));

	// Second report today: since the first, with the AI paragraph, clipboard and Notion
	pr.runtime.ask = async (win, init) => {
		asks.push(JSON.parse(JSON.stringify(init)));
		return Object.assign({}, init, { questions: "收案場域要選哪一家醫院？", goals: "完成第三章研究方法", ai: true, copy: true, notion: true });
	};
	let second = await runMenu(env);
	assert.deepEqual(env.errors, []);
	assert.equal(asks[1].previousDate, day0);
	assert.deepEqual(asks[1].period, { start: day0, end: today });
	assert.equal(asks[1].goals, "");

	// Cost confirm, then one request with the report's facts only
	assert.equal(env.confirms.length, 1);
	assert.match(env.confirms[0], /^將用 test-model 依報告中的資料寫一段「本期摘要」，會產生一次 API 費用。\n輸入約 [\d,]+ tokens（這個模型沒有價格資料，無法估算費用）。/);
	let calls = env.log.filter(l => l.api === "anthropic");
	assert.equal(calls.length, 1);
	let req = calls[0].body;
	assert.equal(req.model, "test-model");
	assert.equal(req.system.length, 1);
	assert.equal(req.system[0].text, pr.SUMMARY_PROMPT);
	let user = req.messages[0].content;
	assert.equal(typeof user, "string");
	assert.match(user, new RegExp(`^<period>${day0} 至 ${today}</period>\\n<facts>\\n【本期閱讀】`));
	assert.match(user, /・Study 2 of fall prevention in hospitals — 待讀 → 已讀/);
	assert.match(user, /辨識 40（\+10） → 篩選 35（\+5） → 全文評估 10 → 納入 6（\+2）；尚待篩選：標題摘要 3、全文 1/);
	assert.match(user, /1\. 收案場域要選哪一家醫院？/);
	assert.doesNotMatch(user, /\[\[|zotero-bridge:start|Pandoc/);
	let ledger = JSON.parse(env.prefStore["extensions.zotero-bridge.usage.ledger"]);
	assert.equal(Object.values(ledger)[0].calls, 1);

	let reportPath = path.join(dir, "進度報告", `${today}.md`);
	assert.equal(second.relPath, `Zotero/進度報告/${today}.md`);
	let note = fs.readFileSync(reportPath, "utf8");
	assert.match(note, new RegExp(`^---\\ntype: "advisor-progress-report"\\ndate: "${today}"\\nperiod_start: "${day0}"\\nperiod_end: "${today}"\\nprevious_report: "${day0}"\\ngenerated_at: "[^"]+"\\nai_model: "test-model"\\nnotion: "https://www\\.notion\\.so/report-page-1"\\n---\\n\\n# 進度報告 ${today}\\n`));
	assert.match(note, new RegExp(`（上次報告：\\[\\[Zotero/進度報告/${day0}\\|${day0}\\]\\]）`));
	assert.match(note, new RegExp(`## 本期摘要（AI 整理）\\n\\n${SUMMARY}\\n\\n> \\[!note\\] 由 test-model 依本報告列出的事實整理`));
	assert.doesNotMatch(note, /在報告資料中找不到/);
	assert.match(note, /讀完 \*\*1\*\* 篇 · 新加入 \*\*1\*\* 篇 · AI 文獻筆記 \*\*1\*\* 篇 · 完成核對的嚴格評讀 \*\*1\*\* 篇/);
	assert.match(note, new RegExp(`- \\[\\[Zotero/Author2 2024 - Study 2 of fall prevention in hospitals\\|Study 2 of fall prevention in hospitals\\]\\] — 待讀 → 已讀（${today}）`));
	assert.match(note, new RegExp(`### 新加入的文獻\\n\\n- \\[\\[Zotero/Author1 2024 - Study 1 of fall prevention in hospitals\\|Study 1 of fall prevention in hospitals\\]\\] — ${localDate(noon(-2))} 加入（待讀）`));
	assert.match(note, new RegExp(`### AI 文獻筆記\\n\\n- \\[\\[Zotero/Author1 2024[^\\]]*\\]\\] — ${localDate(noon(-1))} 產生`));
	assert.match(note, new RegExp(`### 完成核對的嚴格評讀\\n\\n- \\[\\[Zotero/Author1 2024[^\\]]*\\]\\] — JBI[^，]*，整體：納入，${today} 核對`));
	assert.doesNotMatch(note, /閱讀狀態的變更從安裝/);
	assert.match(note, /- \[\[Zotero\/Reviews\/跌倒\|跌倒：篩選與 PRISMA 2020\]\]：辨識 40（\+10） → 篩選 35（\+5） → 全文評估 10 → 納入 6（\+2）；尚待篩選：標題摘要 3、全文 1\n/);
	assert.match(note, /- \[\[Zotero\/Drafts\/文獻探討-跌倒\|文獻探討-跌倒\]\]：修改於 \d{4}-\d{2}-\d{2} · 我的文字約 11 字（\+7）/);
	assert.match(note, new RegExp(`PubMed 追蹤本期匯入 \\*\\*2\\*\\* 篇（勾選看過 0 篇）：\\n\\n- \\[\\[Zotero/新文獻/${today}\\|${today}\\]\\]：跌倒預防 2 篇\\n`));
	assert.doesNotMatch(note, /舊的/);
	assert.match(note, /### 上次目標回顧\n\n- \[ \] 完成第二章初稿\n- \[ \] 篩選完 20 篇\n\n### 本次想討論的問題\n\n1\. 收案場域要選哪一家醫院？\n\n### 下次目標\n\n- \[ \] 完成第三章研究方法\n/);
	assert.match(note, /pandoc .* --lua-filter zotero-bridge-report\.lua -o /);
	assert.equal(fs.readFileSync(path.join(dir, "進度報告", pr.FILTER_FILE), "utf8"), pr.PANDOC_FILTER);

	// Clipboard: the plain-text version
	assert.equal(env.clipboard.length, 1);
	assert.equal(env.clipboard[0], second.plain);
	assert.match(env.clipboard[0], new RegExp(`^進度報告 ${today}\\n報告期間：${day0} 至 ${today}\\n\\n【本期摘要】\\n${SUMMARY}\\n\\n【本期閱讀】`));
	assert.doesNotMatch(env.clipboard[0], /\[\[|\*\*|%%/);

	// Notion: a child page of the synthesis parent, links as text
	assert.equal(env.notion.pages.length, 1);
	assert.deepEqual(env.notion.pages[0].parent, { type: "page_id", page_id: "22222222-2222-2222-2222-222222222222" });
	assert.equal(env.notion.pages[0].properties.title.title[0].text.content, `進度報告 ${today}`);
	let container = JSON.stringify(env.log.find(l => l.path === "blocks/report-page-1/children" && l.method === "PATCH").body.children[0]);
	assert.match(container, /進度報告（重新產生會覆寫/);
	assert.match(container, /Study 2 of fall prevention in hospitals — 待讀 → 已讀/);
	assert.doesNotMatch(container, /\[\[/);

	// History snapshots for the next report; progress window
	let history = JSON.parse(env.prefStore["extensions.zotero-bridge.progressReport.history"]);
	assert.deepEqual(history.map(h => h.date), [day0, today]);
	assert.equal(history[1].prisma["Zotero/Reviews/跌倒.md"].included, 6);
	assert.equal(history[1].drafts["Zotero/Drafts/文獻探討-跌倒.md"], 11);
	assert.equal(history[1].notionPageId, "report-page-1");
	let line = env.progressLines.find(l => l.text.startsWith(`進度報告 ${today} — `));
	assert.equal(line.text, `進度報告 ${today} — 已寫入 Obsidian（Zotero/進度報告/${today}.md）、Notion`);
	assert.ok(env.descriptions.includes("已複製純文字版，可以直接貼到 LINE 或 Email。"), env.descriptions.join("\n"));
	assert.ok(env.descriptions.some(d => /^AI 用量：1 次呼叫/.test(d)), env.descriptions.join("\n"));

	// The dashboard (rebuilt after the report) links to it
	let dashboard = fs.readFileSync(path.join(dir, "研究儀表板.md"), "utf8");
	assert.match(dashboard, new RegExp(`> 最新進度報告（給指導教授）：\\[\\[Zotero/進度報告/${today}\\|${today}\\]\\]`));

	// The user ticks a goal, edits the next goals and writes notes; a rebuild today keeps it all
	let edited = note.replace("- [ ] 完成第二章初稿", "- [x] 完成第二章初稿")
		.replace("- [ ] 完成第三章研究方法\n", "- [ ] 完成第三章研究方法\n- [ ] 預約計畫書口試\n")
		.replace(/## ✍️ 我的筆記\n\n$/, "## ✍️ 我的筆記\n\n老師建議先做前驅研究。\n");
	fs.writeFileSync(reportPath, edited);
	pr.runtime.ask = async (win, init) => {
		asks.push(JSON.parse(JSON.stringify(init)));
		return Object.assign({}, init, { ai: false, copy: false });
	};
	await runMenu(env);
	assert.deepEqual(env.errors, []);
	assert.deepEqual(asks[2].period, { start: day0, end: today });
	assert.equal(asks[2].previousDate, day0);
	assert.equal(asks[2].questions, "收案場域要選哪一家醫院？");
	assert.equal(asks[2].goals, "完成第三章研究方法\n預約計畫書口試");
	assert.equal(asks[2].notion, true, "the last choice is remembered");
	let again = fs.readFileSync(reportPath, "utf8");
	assert.equal(again.split("%% zotero-bridge:start").length, 2);
	assert.match(again, /### 上次目標回顧\n\n- \[x\] 完成第二章初稿\n- \[ \] 篩選完 20 篇\n/);
	assert.match(again, /### 下次目標\n\n- \[ \] 完成第三章研究方法\n- \[ \] 預約計畫書口試\n/);
	assert.match(again, /## ✍️ 我的筆記\n\n老師建議先做前驅研究。\n$/);
	assert.doesNotMatch(again, /本期摘要/);
	assert.match(again, /\nai_model: ""\n/);
	// Still compared with the report before today; the Notion page is reused
	assert.match(again, /辨識 40（\+10）/);
	assert.equal(env.notion.pages.length, 1);
	assert.equal(env.log.filter(l => l.api === "anthropic").length, 1);
});

test("cancelling the cost confirm still writes the report; the prompt fallback; no vault", async () => {
	let env = await setup({ confirm: () => false });
	let ZB = env.ZB;
	let pr = ZB.progressReport;
	pr.runtime.ask = async (win, init) => Object.assign({}, init, { ai: true, copy: false, notion: false, sections: { reading: false, pubmed: false } });
	let result = await runMenu(env);
	assert.deepEqual(env.errors, []);
	assert.equal(env.confirms.length, 1);
	assert.equal(env.log.length, 0);
	assert.equal(result.summary, null);
	assert.ok(env.descriptions.includes("已取消 AI 摘要，報告不含「本期摘要」。"));
	let note = fs.readFileSync(path.join(env.vault, result.relPath), "utf8");
	assert.doesNotMatch(note, /## 本期閱讀|## 新文獻追蹤|本期摘要/);
	assert.match(note, /## 系統性回顧進度\n\n還沒有回顧專案/);
	assert.match(note, /### 上次目標回顧\n\n這是第一份報告。/);
	assert.deepEqual(JSON.parse(env.prefStore["extensions.zotero-bridge.progressReport.options"]).sections,
		{ reading: false, reviews: true, writing: true, pubmed: false, goals: true });

	// Without a modal <dialog>: two prompts, everything else from the defaults
	let init = { period: { start: "2026-10-01", end: "2026-10-08" }, sections: { reading: true }, questions: "Q1\nQ2", goals: "", copy: true, notion: true, notionAvailable: false };
	let answer = await pr.askOptions({ document: { createElementNS: () => ({}) } }, init);
	assert.deepEqual(JSON.parse(JSON.stringify(answer)), {
		period: { start: "2026-10-01", end: "2026-10-08" }, sections: { reading: true }, questions: "問題一\n問題二", goals: "目標一", ai: false, copy: true, notion: false,
	});
	assert.deepEqual(env.prompts.map(p => p[1]), ["Q1；Q2", ""]);

	let noVault = await setup({ vault: null });
	let before = noVault.descriptions.length;
	noVault.ZB.progressReport.runtime.ask = async () => { throw new Error("the dialog must not open"); };
	assert.equal(await runMenu(noVault), null);
	assert.match(noVault.descriptions[before], /請先到 設定 → ZotMax 填入 Obsidian vault 路徑/);
	assert.deepEqual(noVault.errors, []);
});
