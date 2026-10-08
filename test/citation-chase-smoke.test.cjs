// Citation searching through the real plugin in a mocked Zotero: OpenAlex lookups for the included
// studies of a review, the Obsidian candidate note + CSV, importing the checked candidates with
// Zotero's identifier lookup (Zotero.Translate.Search), and the PRISMA "other methods" column.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");
const { work, openAlexMock } = require("./openalex-mock.cjs");

const ROOT = path.join(__dirname, "..");
const ROOT_URI = "file://" + ROOT + "/";

// The parts of Zotero, Gecko and the plugin scope that citation searching touches (from screening-smoke)
function makeEnv({ prefs, fetch, confirm = () => true, lookup = {} }) {
	let items = new Map();
	let nextID = 100;
	let menus = [];
	let progressLines = [];
	let descriptions = [];
	let errors = [];
	let confirms = [];
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
			this.tags = (fields.tags || []).slice();
			this.children = [];
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
		getAttachments() { return []; }
		getNotes() { return []; }
		getNote() { return ""; }
		async saveTx() { return this.id; }
	}

	let collections = new Map();
	let prefStore = Object.assign({}, prefs);
	let activeCollection = null;
	let Zotero = {
		Prefs: { get: k => prefStore[k], set: (k, v) => { prefStore[k] = v; }, clear: (k) => { delete prefStore[k]; } },
		MenuManager: { registerMenu: (o) => { menus.push(o); return o.menuID; }, unregisterMenu: () => true },
		Notifier: { registerObserver: () => "obs", unregisterObserver: () => {} },
		ItemPaneManager: { registerSection: o => o.paneID, unregisterSection: () => true },
		PreferencePanes: { register: async () => "pane" },
		getMainWindows: () => [],
		getMainWindow: () => ({}),
		getActiveZoteroPane: () => ({ getSelectedCollections: () => (activeCollection ? [activeCollection] : []) }),
		Items: {
			get: ids => (Array.isArray(ids) ? ids.map(id => items.get(id)) : items.get(ids)),
			exists: id => items.has(id),
			getByLibraryAndKey: (libraryID, key) => [...items.values()].find(i => i.libraryID === libraryID && i.key === key) || false,
			// items.js: getAll(libraryID, onlyTopLevel, includeDeleted, asIDs)
			getAll: async (libraryID, onlyTopLevel) => [...items.values()].filter(i => i.libraryID === libraryID && (!onlyTopLevel || !i.parentID)),
		},
		Libraries: { userLibraryID: 1, get: () => ({ libraryType: "user", name: "My Library" }), getAll: () => [] },
		Groups: { getGroupIDFromLibraryID: () => null },
		Collections: {
			get: ids => (Array.isArray(ids) ? ids.map(id => collections.get(id)) : collections.get(ids)),
			getByParent: id => [...collections.values()].filter(c => c.parentID === id),
		},
		Tags: { getID: () => false },
		Styles: { get: () => null },
		// translate.js: Zotero.Translate.Search — setIdentifier({ DOI | PMID }), getTranslators(),
		// setTranslator(translators), translate({ libraryID, collections, saveAttachments }) → saved items
		Translate: {
			Search: class {
				setIdentifier(identifier) { this.identifier = identifier; }
				async getTranslators() { return [{ label: "DOI Content Negotiation" }, { label: "Crossref REST" }]; }
				setTranslator(t) { this.translators = t; }
				async translate(opts) {
					translations.push({ identifier: this.identifier, opts, translators: this.translators.length });
					let id = this.identifier.DOI || this.identifier.PMID;
					let found = lookup[id];
					if (!found) throw new Error("No items returned from any translator");
					let item = new MockItem("journalArticle", Object.assign({}, found));
					item.libraryID = opts.libraryID;
					for (let cid of opts.collections || []) collections.get(cid).members.push(item);
					return [item];
				}
			},
		},
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
			id, key: `COLL${id}`, name, libraryID: 1, parentID, members: members.slice(),
			getChildItems() { return this.members.map(i => items.get(i.id)).filter(i => !i.deleted); },
		};
		collections.set(id, c);
		return c;
	}

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
		read: async p => new Uint8Array(await fsp.readFile(p)),
		move: async (from, to) => fsp.rename(from, to),
	};
	let PathUtils = { join: (...parts) => path.join(...parts), filename: p => path.basename(p), parent: p => path.dirname(p) };
	let context = vm.createContext({
		Zotero, IOUtils, PathUtils, fetch, console, TextDecoder, TextEncoder, URL,
		Components: {
			Constructor: function () {
				return function (origin, formActionOrigin, httpRealm, username, password) {
					Object.assign(this, { origin, httpRealm, username, password });
				};
			},
			interfaces: { nsILoginInfo: {} },
		},
		DOMParser: new JSDOM("").window.DOMParser,
		// The 200 ms throttle and retry backoff wait for real; keep the test fast
		setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 2)),
		clearTimeout,
		Services: {
			scriptloader: {
				loadSubScript: (url) => {
					let file = url.replace("file://", "");
					vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
				},
			},
			prompt: { confirm: (win, title, text) => { confirms.push(text); return confirm(text); } },
			logins: { searchLoginsAsync: async () => [], addLoginAsync: async l => l, modifyLoginAsync: async () => {}, removeLoginAsync: async () => {} },
		},
	});
	vm.runInContext(fs.readFileSync(path.join(ROOT, "bootstrap.js"), "utf8"), context, { filename: "bootstrap.js" });
	return {
		context, MockItem, items, menus, progressLines, descriptions, errors, confirms, translations, prefStore, addCollection,
		setActiveCollection: (c) => { activeCollection = c; },
	};
}

// Two included studies: W1 (by DOI) cites W11, W12 and is cited by W21; W2 (by PMID) cites W11
function openAlexDB() {
	return {
		works: [
			work(1, { doi: "https://doi.org/10.5555/w1", cited_by_count: 1, referenced_works: ["https://openalex.org/W11", "https://openalex.org/W12"] }),
			work(2, { doi: null, ids: { openalex: "https://openalex.org/W2", pmid: "https://pubmed.ncbi.nlm.nih.gov/222" }, cited_by_count: 0, referenced_works: ["https://openalex.org/W11"] }),
		],
		refs: {
			W1: [work(11, { display_name: "Exercise for preventing falls in older people", cited_by_count: 800 }), work(12, { doi: "https://doi.org/10.5555/KNOWN" })],
			W2: [work(11, { display_name: "Exercise for preventing falls in older people", cited_by_count: 800 })],
		},
		citing: { W1: [work(21, { display_name: "Nurse-led bundles: a follow-up", publication_year: 2025, doi: "https://doi.org/10.5555/w21(a)" })] },
	};
}

async function setup(opts = {}) {
	let vault = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-chase-"));
	let api = openAlexMock(opts.db || openAlexDB(), { fail: opts.fail });
	let env = makeEnv({
		fetch: api.fetch,
		confirm: opts.confirm,
		lookup: opts.lookup || {},
		prefs: Object.assign({
			"extensions.zotero-bridge.obsidian.vaultPath": vault,
			"extensions.zotero-bridge.obsidian.folder": "Zotero",
			"extensions.zotero-bridge.citationChase.email": "nurse@example.com",
		}, opts.prefs),
	});
	await vm.runInContext(`startup({ id: "zotero-bridge@bobyu89.github.io", version: "0.0.0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);
	return Object.assign(env, { vault, api });
}

function paper(env, n, fields = {}) {
	return new env.MockItem("journalArticle", Object.assign({
		key: `PAPER${String(n).padStart(3, "0")}`,
		title: `Study ${n} of fall prevention in hospitals`,
		year: "2024",
		creators: [{ firstName: "Mei", lastName: `Author${n}`, creatorType: "author" }],
	}, fields));
}

function review(env) {
	let inc1 = paper(env, 1, { DOI: "10.5555/W1", tags: ["篩選/標題摘要/納入", "篩選/全文/納入"] });
	let inc2 = paper(env, 2, { extra: "PMID: 222", tags: ["篩選/全文/納入"] });
	let exc = paper(env, 3, { DOI: "10.5555/w3", tags: ["篩選/標題摘要/排除"] });
	// Elsewhere in the library already
	let known = paper(env, 4, { DOI: "10.5555/known", title: "Known paper" });
	let collection = env.addCollection(1, "跌倒預防 SR", [inc1, inc2, exc]);
	return { inc1, inc2, exc, known, collection };
}

function menu(env, menuID) {
	return env.menus.find(m => m.menuID === menuID);
}

async function settle(check) {
	for (let i = 0; i < 400 && !check(); i++) await new Promise(r => setTimeout(r, 5));
	assert.ok(check(), "timed out");
}

const NOTE = ["Zotero", "Reviews", "跌倒預防 SR 引文追蹤.md"];
const LOOKUP = {
	"10.5555/w11": { title: "Exercise for preventing falls in older people", DOI: "10.5555/w11", year: "2019" },
	"10.5555/w21(a)": { title: "Nurse-led bundles: a follow-up", DOI: "10.5555/w21(a)", year: "2025" },
};

test("chase from the collection menu, tick candidates, import them, then PRISMA counts them as other methods", async () => {
	let answer = true;
	let env = await setup({ lookup: LOOKUP, confirm: () => answer });
	let ZB = env.context.ZB;
	let { inc1, collection } = review(env);

	// Collection menu → Zotero Bridge：引文追蹤 → 引文追蹤：全文納入的研究
	let coll = menu(env, "zotero-bridge-chase-collection").menus[0];
	assert.equal(coll.l10nID, "zotero-bridge-chase-collection-menu");
	let visible;
	coll.onShowing({}, { collectionTreeRows: [], setVisible: v => (visible = v) });
	assert.equal(visible, false);
	let notePath = path.join(env.vault, ...NOTE);
	coll.menus.find(m => m.l10nID === "zotero-bridge-chase-included").onCommand({}, { collectionTreeRows: [{ isCollection: () => true, ref: collection }] });
	await settle(() => fs.existsSync(notePath) && env.progressLines.at(-1).progress === 100);
	assert.deepEqual(env.errors, []);
	assert.equal(env.progressLines.at(-1).text, "找到 3 篇，其中 2 篇不在文獻庫（5 次請求）");
	// W1: lookup + references + citing; W2 by PMID: lookup + references (no citing works)
	assert.deepEqual(env.api.log.map(u => new URL(u).pathname + " " + (new URL(u).searchParams.get("filter") || "")), [
		"/works/doi:10.5555/w1 ", "/works cited_by:W1", "/works cites:W1", "/works/pmid:222 ", "/works cited_by:W2",
	]);
	assert.ok(env.api.log.every(u => new URL(u).searchParams.get("mailto") === "nurse@example.com"));

	let note = fs.readFileSync(notePath, "utf8");
	assert.match(note, /^---\ntitle: "跌倒預防 SR：引文追蹤"\ntype: "citation-chase"\nzotero_collection: "library\/collections\/COLL1"\n/);
	assert.match(note, /chase_new: 2\n/);
	assert.match(note, /candidates_csv: "Zotero\/Reviews\/跌倒預防 SR 引文追蹤\.csv"\n/);
	assert.ok(note.includes("- [ ] **Exercise for preventing falls in older people** (2020)｜*Journal of Nursing*｜被引 800｜← Author1, 2024；Author2, 2024｜[10.5555/w11](https://doi.org/10.5555/w11)"), note);
	assert.ok(note.includes("- [ ] **Nurse-led bundles: a follow-up** (2025)｜*Journal of Nursing*｜被引 21｜→ Author1, 2024｜[10.5555/w21(a)](https://doi.org/10.5555/w21%28a%29)"));
	assert.ok(note.includes("| Work 12 on nurse-led fall prevention | 2020 | Journal of Nursing | 12 | ← 參考文獻 | Author1, 2024 | [10.5555/known](https://doi.org/10.5555/known) | [已在文獻庫](zotero://select/library/items/PAPER004) |"));
	assert.ok(note.endsWith("%% zotero-bridge:end %%\n\n## ✍️ 我的筆記\n\n"));
	let csv = fs.readFileSync(path.join(env.vault, "Zotero", "Reviews", "跌倒預防 SR 引文追蹤.csv"), "utf8");
	assert.equal(csv.split("\r\n").length, 5, "header + 3 rows + trailing newline");

	// The user ticks two candidates (and a DOI Zotero can't resolve) and imports from the Tools menu
	fs.writeFileSync(notePath, note.replace(/- \[ \] (\*\*Exercise|\*\*Nurse-led)/g, "- [x] $1")
		.replace("## ✍️ 我的筆記\n\n", "## ✍️ 我的筆記\n\n跟指導教授討論\n")
		.replace("%% zotero-bridge:end %%", "- [x] **Ghost**｜[x](https://doi.org/10.5555/ghost)\n%% zotero-bridge:end %%"));
	env.setActiveCollection(collection);
	let tools = menu(env, "zotero-bridge-chase-tools").menus;
	assert.deepEqual(Array.from(tools, m => m.l10nID), ["zotero-bridge-chase-tools-included", "zotero-bridge-chase-tools-import"]);
	tools[1].onCommand({}, {});
	await settle(() => env.translations.length === 3 && /失敗/.test(env.progressLines.at(-1).text));
	assert.match(env.confirms[0], /要用 DOI／PMID 查詢並匯入 3 篇勾選的文獻到分類「跌倒預防 SR」嗎？/);
	assert.match(env.confirms[0], /標籤「來源\/引文追蹤」，篩選標籤不會變動；不會下載 PDF/);
	assert.deepEqual(JSON.parse(JSON.stringify(env.translations.map(t => [t.identifier, t.opts, t.translators]))), [
		[{ DOI: "10.5555/w11" }, { libraryID: 1, collections: [1], saveAttachments: false }, 2],
		[{ DOI: "10.5555/w21(a)" }, { libraryID: 1, collections: [1], saveAttachments: false }, 2],
		[{ DOI: "10.5555/ghost" }, { libraryID: 1, collections: [1], saveAttachments: false }, 2],
	]);
	let line = env.progressLines.at(-1);
	assert.equal(line.text, "已匯入 2 篇，1 篇失敗");
	assert.equal(line.error, true);
	assert.match(env.descriptions.join("\n"), /失敗：10\.5555\/ghost：No items returned from any translator/);
	let imported = collection.members.slice(3);
	assert.deepEqual(imported.map(i => [i.fields.title, i.tags]), [
		["Exercise for preventing falls in older people", ["來源/引文追蹤"]],
		["Nurse-led bundles: a follow-up", ["來源/引文追蹤"]],
	]);
	let after = fs.readFileSync(notePath, "utf8");
	assert.match(after, /^- \[x\] ✅ 已匯入 \*\*Exercise/m);
	assert.match(after, /^- \[x\] ✅ 已匯入 \*\*Nurse-led/m);
	assert.match(after, /^- \[x\] \*\*Ghost/m);
	assert.match(after, /跟指導教授討論/);
	env.errors.length = 0;

	// Importing again: the imported ones are skipped; declining the confirmation does nothing
	answer = false;
	let again = await ZB.citationChase.importChecked(collection);
	assert.equal(again.cancelled, true);
	assert.match(env.confirms.at(-1), /匯入 1 篇勾選的文獻/);
	assert.equal(env.translations.length, 3);

	// Screen the imports: one included at full text, one excluded at title/abstract
	imported[0].tags.push("篩選/全文/納入");
	imported[1].tags.push("篩選/標題摘要/排除");
	let report = await ZB.screening.generateReport(collection);
	assert.deepEqual({ ...report.result.other.counts }, {
		identified: 2, duplicates: 0, screened: 2, taExcluded: 1, taPending: 0,
		sought: 1, notRetrieved: 0, assessed: 1, ftExcluded: 0, ftPending: 0, included: 1,
	});
	let prisma = fs.readFileSync(path.join(env.vault, "Zotero", "Reviews", "跌倒預防 SR.md"), "utf8");
	assert.match(prisma, /otherIdentified\["Records identified from:<br\/>Citation searching \(n = 2\)"\]/);
	assert.match(prisma, /included\["Studies included in review<br\/>\(n = 3\)/);
	assert.match(prisma, /prisma_included: 3\n/);
	assert.match(prisma, /prisma_other_identified: 2\n/);
	assert.match(env.progressLines.at(-1).text, /｜其他方法：辨識 2 → 全文評估 1 → 納入 1（共納入 3）$/);
	assert.ok(fs.readFileSync(path.join(env.vault, "Zotero", "Reviews", "跌倒預防 SR.md"), "utf8").includes("Exercise for preventing falls"), "evidence table lists the new study");

	// Chasing again (Tools menu): the imports are now in the review; ticks and notes stay
	tools[0].onCommand({}, {});
	await settle(() => /chase_new: 0/.test(fs.readFileSync(notePath, "utf8")));
	let rerun = fs.readFileSync(notePath, "utf8");
	assert.ok(rerun.includes("| [已在本回顧](zotero://select/library/items/"), "imported candidates are flagged");
	assert.match(rerun, /（沒有新的候選文獻：找到的文獻都已在文獻庫中）/);
	assert.match(rerun, /跟指導教授討論/);
	assert.equal(rerun.match(/zotero-bridge:start/g).length, 1);
	assert.deepEqual(env.errors, []);
	assert.ok(inc1.tags.length === 2, "seeds untouched");
});

test("selected items without a collection, OpenAlex failures, the request cap and missing settings", async () => {
	// OpenAlex down for one study: the others still produce a note
	let env = await setup({
		prefs: { "extensions.zotero-bridge.citationChase.direction": "backward", "extensions.zotero-bridge.citationChase.email": "" },
		fail: url => (url.includes("pmid:222") ? new TypeError("NetworkError") : undefined),
	});
	let { inc1, inc2 } = review(env);
	let itemMenu = menu(env, "zotero-bridge-chase-item").menus[0];
	assert.equal(itemMenu.menuType, "menuitem");
	assert.ok(itemMenu.icon.endsWith("content/icons/bridge.svg"));
	itemMenu.onCommand({}, { items: [inc1, inc2] });
	let notePath = path.join(env.vault, "Zotero", "Reviews", "所選文獻 引文追蹤.md");
	await settle(() => fs.existsSync(notePath) && env.progressLines.at(-1).progress === 100);
	let note = fs.readFileSync(notePath, "utf8");
	assert.match(note, /zotero_collection: "selection"/);
	assert.ok(note.includes("| [Author2, 2024](zotero://select/library/items/PAPER002) |  | — | — | 失敗：無法連線到 OpenAlex：NetworkError |"));
	assert.match(note, /建議在 設定 → 引文追蹤 填入 email/);
	assert.ok(env.api.log.every(u => !u.includes("cites:")), "backward only");
	assert.ok(env.api.log.every(u => !u.includes("mailto=")));
	assert.match(env.descriptions.join("\n"), /1 篇沒有完整查詢：Author2, 2024（失敗：無法連線到 OpenAlex：NetworkError）/);
	// Import with no collection selected reads the same note and saves into My Library
	await env.context.ZB.citationChase.importChecked(null);
	assert.match(env.descriptions.at(-1), /所選文獻 引文追蹤\.md 沒有新勾選的文獻/);

	// The request cap
	let capped = await setup({ prefs: { "extensions.zotero-bridge.citationChase.maxRequests": "2" } });
	let r = review(capped);
	let run = await capped.context.ZB.citationChase.chaseCollection(r.collection);
	assert.equal(capped.api.log.length, 2);
	assert.match(run.stopped, /已達本次 OpenAlex 請求上限（2 次）/);
	assert.match(capped.descriptions.join("\n"), /⚠️ 已達本次 OpenAlex 請求上限（2 次）/);
	let cappedNote = fs.readFileSync(path.join(capped.vault, ...NOTE), "utf8");
	assert.match(cappedNote, /> \[!warning\] 已達本次 OpenAlex 請求上限（2 次）：部分研究沒有查完/);

	// No included studies; no vault; no collection selected
	let bare = await setup({});
	let c = bare.addCollection(1, "空的回顧", [paper(bare, 1)]);
	assert.equal(await bare.context.ZB.citationChase.chaseCollection(c), null);
	assert.match(bare.descriptions.at(-1), /「空的回顧」還沒有全文納入的研究（標籤「篩選\/全文\/納入」）/);
	menu(bare, "zotero-bridge-chase-tools").menus[0].onCommand({}, {});
	await settle(() => /請先在左側選取系統性回顧的分類/.test(bare.descriptions.at(-1)));
	let noVault = await setup({ prefs: { "extensions.zotero-bridge.obsidian.vaultPath": "" } });
	let nv = review(noVault);
	assert.equal(await noVault.context.ZB.citationChase.chaseCollection(nv.collection), null);
	assert.match(noVault.descriptions.at(-1), /請先到 設定 → Zotero Bridge 填入 Obsidian vault 路徑/);
	assert.equal(noVault.api.log.length, 0);
	assert.equal(await noVault.context.ZB.citationChase.importChecked(nv.collection), null);
	// Import before any chase
	let fresh = await setup({});
	assert.equal(await fresh.context.ZB.citationChase.importChecked(review(fresh).collection), null);
	assert.match(fresh.descriptions.at(-1), /找不到 Zotero\/Reviews\/跌倒預防 SR 引文追蹤\.md：請先執行「引文追蹤」/);
});
