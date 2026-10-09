// PubMed new-literature watch through the real plugin in a mocked Zotero: E-utilities requests
// (parameters, throttling), dedup against the library, import via Zotero.Translate.Search into a
// created collection with tags, per-watch state, the Obsidian digest, automatic checks and timers.
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
const NOW = new Date("2026-10-08T03:00:00Z");
const FALLS = '("Accidental Falls"[Mesh]) AND nurs*[tiab]';
const P = "extensions.zotero-bridge.";
// Values from the plugin's sandbox are other-realm objects: compare their JSON
const same = (actual, expected, message) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)), message);

// What PubMed knows: PMID → metadata
const PUBMED = {
	1001: { title: "Already in the library by PMID", doi: "10.1000/a1001" },
	1002: { title: "Hourly rounding and falls", doi: "10.1000/a1002" },
	1003: { title: "Already in the library by DOI", doi: "10.1000/A1003" },
	1004: { title: "Bed alarms in older inpatients", doi: "10.1000/a1004" },
	1006: { title: "A later paper", doi: "" },
	2001: { title: "Pressure injury bundles", doi: "10.2000/b2001" },
	2002: { title: "Translator fails for this one", doi: "10.2000/b2002" },
};

// The parts of Zotero, Gecko and the plugin scope that the watch touches
function makeEnv({ prefs, fetch }) {
	let items = new Map();
	let collections = new Map();
	let nextID = 100;
	let nextCollectionID = 1;
	let menus = [];
	let progressLines = [];
	let descriptions = [];
	let headlines = [];
	let errors = [];
	let translateCalls = [];
	let failingPMIDs = new Set();
	let timers = { set: 0, cleared: 0, live: new Set() };
	let prefObservers = new Map();

	class MockItem {
		constructor(type, fields = {}) {
			this.id = nextID++;
			this.key = fields.key || `KEY${this.id}`;
			this.itemType = type;
			this.libraryID = 1;
			this.deleted = false;
			this.fields = fields;
			this.tags = (fields.tags || []).slice();
			this.collections = [];
			this.saved = 0;
			items.set(this.id, this);
		}
		isRegularItem() { return !["note", "attachment", "annotation"].includes(this.itemType); }
		getField(f) { return this.fields[f] || ""; }
		getCreatorsJSON() { return []; }
		getTags() { return this.tags.map(tag => ({ tag })); }
		addTag(t) {
			if (this.tags.includes(t)) return false;
			this.tags.push(t);
			return true;
		}
		removeTag(t) { this.tags = this.tags.filter(x => x !== t); }
		getCollections() { return this.collections.slice(); }
		addToCollection(id) { if (!this.collections.includes(id)) this.collections.push(id); }
		getAttachments() { return []; }
		getNotes() { return []; }
		getItemTypeIconName() { return this.itemType; }
		async saveTx() { this.saved++; return this.id; }
	}

	class MockCollection {
		constructor({ name, libraryID, parentID } = {}) {
			Object.assign(this, { name, libraryID, parentID: parentID || null, deleted: false });
		}
		async saveTx() {
			if (!this.id) {
				this.id = nextCollectionID++;
				this.key = `COLL${this.id}`;
				collections.set(this.id, this);
			}
			return this.id;
		}
	}

	// search.js: field conditions (aliases of 'field'), joinMode any; "contains" is case-insensitive
	class MockSearch {
		constructor() { this.conditions = []; this.join = "all"; }
		addCondition(name, op, value) {
			if (name === "joinMode") this.join = op;
			else this.conditions.push({ name, op, value });
		}
		async search() {
			let test = (item, c) => {
				let v = String(item.fields[c.name] || "").toLowerCase();
				if (c.op === "contains") return v.includes(String(c.value).toLowerCase());
				if (c.op === "is") return v === String(c.value).toLowerCase();
				throw new Error(`operator ${c.op}`);
			};
			return [...items.values()]
				.filter(i => i.libraryID === this.libraryID && i.isRegularItem())
				.filter(i => (this.join === "any" ? this.conditions.some(c => test(i, c)) : this.conditions.every(c => test(i, c))))
				.map(i => i.id);
		}
	}

	// translate.js: Zotero.Translate.Search with setIdentifier({ PMID }) (lookup.js passes arrays of PMIDs)
	class MockTranslateSearch {
		setIdentifier(identifier) { this.identifier = identifier; }
		async getTranslators() { return [{ label: "PubMed" }]; }
		setTranslator(t) { this.translators = t; }
		async translate(opts) {
			translateCalls.push({ identifier: this.identifier, opts, translators: this.translators.map(t => t.label) });
			let pmids = [].concat(this.identifier.PMID);
			return pmids.filter(p => !failingPMIDs.has(p)).map((p) => {
				let meta = PUBMED[p];
				let item = new MockItem("journalArticle", {
					title: meta.title, DOI: meta.doi, extra: `PMID: ${p}`, publicationTitle: "Journal of Nursing", date: "2026-10",
				});
				item.libraryID = opts.libraryID;
				for (let id of opts.collections || []) item.addToCollection(id);
				return item;
			});
		}
	}

	let prefStore = Object.assign({}, prefs);
	let Zotero = {
		Prefs: {
			get: k => prefStore[k],
			set: (k, v) => {
				prefStore[k] = v;
				for (let fn of prefObservers.get(k) || []) fn();
			},
			clear: (k) => { delete prefStore[k]; },
			registerObserver: (name, fn) => {
				prefObservers.set(name, [...(prefObservers.get(name) || []), fn]);
				return Symbol(name);
			},
			unregisterObserver: (sym) => { prefObservers.delete(sym.description); },
		},
		MenuManager: { registerMenu: (o) => { menus.push(o); return o.menuID; }, unregisterMenu: () => true },
		Notifier: { registerObserver: () => "obs", unregisterObserver: () => {} },
		ItemPaneManager: { registerSection: o => o.paneID, unregisterSection: () => true },
		PreferencePanes: { register: async () => "pane" },
		getMainWindows: () => [],
		getMainWindow: () => ({}),
		Items: {
			get: ids => (Array.isArray(ids) ? ids.map(id => items.get(id)) : items.get(ids)),
			exists: id => items.has(id),
			getByLibraryAndKey: () => false,
		},
		Libraries: { userLibraryID: 1, get: () => ({ libraryType: "user", name: "My Library" }), getAll: () => [] },
		Groups: { getGroupIDFromLibraryID: () => null },
		Collections: {
			get: id => collections.get(id),
			getByLibrary: libraryID => [...collections.values()].filter(c => c.libraryID === libraryID && !c.parentID),
			getByParent: id => [...collections.values()].filter(c => c.parentID === id),
		},
		Collection: MockCollection,
		Search: MockSearch,
		Translate: { Search: MockTranslateSearch },
		Tags: { getID: () => false },
		ProgressWindow: class {
			constructor() {
				this.ItemProgress = class {
					constructor(icon, text) { this.text = text; progressLines.push(this); }
					setText(t) { this.text = t; }
					setProgress(p) { this.progress = p; }
					setError() { this.error = true; }
				};
			}
			changeHeadline(h) { headlines.push(h); }
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
	};
	let PathUtils = { join: (...parts) => path.join(...parts), filename: p => path.basename(p), parent: p => path.dirname(p) };
	let logins = [];
	let context = vm.createContext({
		Zotero, IOUtils, PathUtils, fetch, console, TextDecoder, TextEncoder, URLSearchParams,
		Components: {
			Constructor: function () {
				return function (origin, formActionOrigin, httpRealm, username, password) {
					Object.assign(this, { origin, httpRealm, username, password });
				};
			},
			interfaces: { nsILoginInfo: {} },
		},
		DOMParser: new JSDOM("").window.DOMParser,
		// Timers are counted so the test can check that shutdown clears them; they fire quickly
		setTimeout: (fn, ms) => {
			timers.set++;
			let h = setTimeout(() => {
				timers.live.delete(h);
				fn();
			}, Math.min(ms, 5));
			timers.live.add(h);
			return h;
		},
		clearTimeout: (h) => {
			if (timers.live.delete(h)) timers.cleared++;
			clearTimeout(h);
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
				searchLoginsAsync: async m => logins.filter(l => Object.entries(m).every(([k, v]) => l[k] === v)),
				addLoginAsync: async (l) => { logins.push(l); return l; },
				modifyLoginAsync: async (old, l) => { logins[logins.indexOf(old)] = l; },
				removeLoginAsync: async (old) => { logins.splice(logins.indexOf(old), 1); },
			},
		},
	});
	vm.runInContext(fs.readFileSync(path.join(ROOT, "bootstrap.js"), "utf8"), context, { filename: "bootstrap.js" });
	return {
		context, Zotero, MockItem, items, collections, menus, progressLines, descriptions, headlines, errors, translateCalls,
		failingPMIDs, timers, prefStore,
	};
}

// NCBI E-utilities: ESearch answers from `searches` (term → PMIDs), ESummary from PUBMED
function eutilsMock(log, searches, opts = {}) {
	let json = (status, body) => ({ status, ok: status < 400, text: async () => JSON.stringify(body) });
	return async (url) => {
		let u = new URL(url);
		let params = Object.fromEntries(u.searchParams);
		log.push({ tool: u.pathname.split("/").pop(), params, at: Date.now() });
		if (opts.rateLimitOnce && !opts.limited) {
			opts.limited = true;
			return json(429, { error: "API rate limit exceeded", count: "4" });
		}
		if (u.pathname.endsWith("/esearch.fcgi")) {
			if (params.term.includes("BROKEN")) return json(200, { esearchresult: { ERROR: "Invalid query syntax" } });
			let ids = searches[params.term] || [];
			if (params.retmax === "0") return json(200, { esearchresult: { count: String(ids.length * 10), idlist: [], querytranslation: `translated(${params.term})` } });
			return json(200, { esearchresult: { count: String(ids.length), idlist: ids.slice(0, Number(params.retmax)) } });
		}
		if (u.pathname.endsWith("/esummary.fcgi")) {
			let uids = params.id.split(",");
			let result = { uids };
			for (let id of uids) {
				let m = PUBMED[id];
				result[id] = { uid: id, title: m.title, fulljournalname: "Journal of Nursing", pubdate: "2026 Oct",
					articleids: m.doi ? [{ idtype: "doi", value: m.doi }] : [] };
			}
			return json(200, { header: {}, result });
		}
		return json(404, { error: "unknown" });
	};
}

async function setup({ prefs = {}, searches = {}, fetchOpts } = {}) {
	let vault = await fsp.mkdtemp(path.join(os.tmpdir(), "zb-pubmed-"));
	let log = [];
	let env = makeEnv({
		fetch: eutilsMock(log, searches, fetchOpts),
		prefs: Object.assign({
			[P + "obsidian.vaultPath"]: vault,
			[P + "obsidian.folder"]: "Zotero",
			[P + "pubmedWatch.email"]: "nurse@example.com",
			[P + "pubmedWatch.watches"]: JSON.stringify([
				{ id: "falls", name: "跌倒預防", query: FALLS },
				{ id: "pi", name: "壓傷", query: "pressure injury[tiab]", collection: "碩論/壓傷", since: "2020" },
			]),
		}, prefs),
	});
	await vm.runInContext(`startup({ id: "zotero-bridge@bobyu89.github.io", version: "0.0.0", rootURI: ${JSON.stringify(ROOT_URI)} })`, env.context);
	let watch = env.context.ZB.pubmedWatch;
	let sleeps = [];
	watch.runtime.now = () => new Date(NOW);
	watch.runtime.sleep = async (ms) => { sleeps.push(ms); };
	return Object.assign(env, { vault, log, watch, sleeps, ZB: env.context.ZB });
}

function state(env) {
	return JSON.parse(env.prefStore[P + "pubmedWatch.state"] || "{}");
}

const PI_TERM = `(pressure injury[tiab]) AND ("2020"[dp] : "3000"[dp])`;

test("檢查新文獻 checks every watch: throttled E-utilities calls, dedup, import into new collections with tags, digest", async () => {
	let env = await setup({ searches: { [FALLS]: ["1001", "1002", "1003", "1004"], [PI_TERM]: ["1004", "2001", "2002"] } });
	// Already in the library: PMID 1001 in Extra (next to a look-alike PMID), and 1003's DOI in other case
	new env.MockItem("journalArticle", { title: "Old", extra: "PMID: 10010" });
	new env.MockItem("journalArticle", { title: "Old 1001", extra: "PMCID: PMC9\nPMID: 1001" });
	new env.MockItem("journalArticle", { title: "Old 1003", DOI: "10.1000/a1003" });
	env.failingPMIDs.add("2002");

	// 檢查新文獻（PubMed 追蹤） from the toolbar button or 快速指令 (commands.js)
	let C = env.context.ZB.commands;
	assert.equal(C.get("pubmed-watch").l10n, "zotero-bridge-menu-pubmed-watch");
	C.execute("pubmed-watch");
	// A second request while the menu's check runs joins it
	let { results, digest, requests } = await env.watch.runAll();
	assert.ok(env.descriptions.includes("正在檢查新文獻，請稍候。"));

	// --- requests: the first-check window, NCBI's identification parameters, and the rate limit
	let calls = env.log.slice(0, 4);
	same(calls.map(c => c.tool), ["esearch.fcgi", "esummary.fcgi", "esearch.fcgi", "esummary.fcgi"]);
	same(calls[0].params, {
		db: "pubmed", term: FALLS, retmode: "json", retmax: "500", sort: "pub_date",
		datetype: "edat", mindate: "2026/09/08", maxdate: "2026/10/08", tool: "zotero-bridge", email: "nurse@example.com",
	});
	same(calls[1].params, { db: "pubmed", id: "1001,1002,1003,1004", retmode: "json", tool: "zotero-bridge", email: "nurse@example.com" });
	assert.equal(calls[2].params.term, PI_TERM);
	// Watch 2 asks only about what watch 1 hasn't seen (1004 is in watch 2's own list, so it is looked up)
	assert.equal(calls[3].params.id, "1004,2001,2002");
	assert.ok(env.log.slice(0, 4).every(c => !("api_key" in c.params)));
	// One throttle wait per E-utilities call and per translator run, ~1/3 s apart without a key
	assert.ok(env.sleeps.length >= 6, String(env.sleeps));
	assert.ok(env.sleeps.every(ms => ms > 300 && ms <= 360), String(env.sleeps));

	// --- import through Zotero's translators, metadata only, into the created collections
	let [falls, pi] = results;
	let coll = name => [...env.collections.values()].find(c => c.name === name);
	same([...env.collections.values()].map(c => [c.name, c.parentID && env.collections.get(c.parentID).name]),
		[["📥 新文獻", null], ["跌倒預防", "📥 新文獻"], ["碩論", null], ["壓傷", "碩論"]]);
	same(env.translateCalls.map(c => c.identifier), [
		{ PMID: ["1002", "1004"] }, { PMID: ["2001", "2002"] }, { PMID: "2002" },
	]);
	same(env.translateCalls[0].opts, { libraryID: 1, collections: [coll("跌倒預防").id], saveAttachments: false });
	same(env.translateCalls[0].translators, ["PubMed"]);

	same(falls.imported.map(e => e.pmid), ["1002", "1004"]);
	assert.equal(falls.existing, 2);
	assert.equal(falls.found, 4);
	same(pi.imported.map(e => e.pmid), ["2001"]);
	assert.equal(pi.existing, 1, "1004 was imported by the first watch");
	same(pi.failed, ["2002"]);
	let byPMID = pmid => [...env.items.values()].filter(i => env.watch.pmidFromExtra(i.fields.extra) === pmid);
	for (let pmid of ["1001", "1002", "1003", "1004", "2001"]) assert.equal(byPMID(pmid).length + (pmid === "1003" ? 1 : 0), 1, pmid);
	let item1002 = byPMID("1002")[0];
	same(item1002.tags, ["新文獻", "追蹤/跌倒預防", "來源/PubMed"]);
	same(item1002.collections, [coll("跌倒預防").id]);
	assert.equal(item1002.saved, 1);
	same(byPMID("2001")[0].tags, ["新文獻", "追蹤/壓傷", "來源/PubMed"]);

	// --- per-watch state: last check, PMIDs seen, the failed one kept for a retry
	let st = state(env);
	assert.equal(st.falls.lastCheck, NOW.toISOString());
	same(st.falls.seen.sort(), ["1001", "1002", "1003", "1004"]);
	same(st.pi.retry, { 2002: 1 });

	// --- progress window and the Obsidian digest
	assert.ok(env.headlines.includes("Zotero Bridge：PubMed 新文獻追蹤"));
	let lines = env.progressLines.map(l => l.text);
	assert.ok(lines.includes("跌倒預防：找到 4 篇，新匯入 2 篇，已在文獻庫 2 篇"), lines.join("\n"));
	assert.ok(lines.includes("壓傷：找到 3 篇，新匯入 1 篇，已在文獻庫 1 篇，匯入失敗 1 篇（下次再試）"), lines.join("\n"));
	let date = env.watch.localDate(NOW);
	assert.equal(digest, `Zotero/新文獻/${date}.md`);
	assert.ok(env.descriptions.includes(`已列在 Obsidian：Zotero/新文獻/${date}.md`), env.descriptions.join("\n"));
	let note = fs.readFileSync(path.join(env.vault, "Zotero", "新文獻", `${date}.md`), "utf8");
	assert.ok(note.includes(`## 跌倒預防\n\n- [ ] **Hourly rounding and falls** — *Journal of Nursing* (2026) · [Zotero](zotero://select/library/items/${item1002.key}) · [DOI](https://doi.org/10.1000/a1002) · [PubMed](https://pubmed.ncbi.nlm.nih.gov/1002/)`), note);
	assert.ok(note.includes("## 壓傷\n\n- [ ] **Pressure injury bundles**"), note);
	assert.ok(!note.includes("1001/") && !note.includes("2002/"));
	same(env.errors.filter(e => !/2002|Translator/.test(String(e))), []);
	assert.ok(requests.length >= 4);

	// --- second check the same day: window from the day before, nothing imported twice, retry succeeds
	env.failingPMIDs.clear();
	fs.writeFileSync(path.join(env.vault, "Zotero", "新文獻", `${date}.md`), note.replace("- [ ] **Hourly", "- [x] **Hourly") + "我的筆記\n");
	env.translateCalls.length = 0;
	let searches2 = { [FALLS]: ["1006", "1002", "1004"], [PI_TERM]: ["2001"] };
	let log2 = [];
	env.watch.runtime.fetch = eutilsMock(log2, searches2);
	let second = await env.watch.runAll();
	same(log2[0].params.mindate, "2026/10/07");
	same(log2[1].params.id, "1006", "seen PMIDs are not looked up again");
	same(env.translateCalls.map(c => c.identifier), [{ PMID: "1006" }, { PMID: "2002" }]);
	same(second.results.map(r => r.imported.map(e => e.pmid)), [["1006"], ["2002"]]);
	same(state(env).pi.retry, {});
	assert.equal([...env.collections.values()].length, 4, "collections are reused");
	let merged = fs.readFileSync(path.join(env.vault, "Zotero", "新文獻", `${date}.md`), "utf8");
	assert.ok(merged.includes("- [x] **Hourly rounding and falls**"));
	assert.ok(merged.includes("- [ ] **A later paper** — *Journal of Nursing* (2026) · [Zotero]"));
	assert.ok(!merged.includes("[DOI](https://doi.org/)"));
	assert.ok(merged.includes("pubmed.ncbi.nlm.nih.gov/2002/"));
	assert.ok(merged.endsWith("我的筆記\n"));
	assert.equal(merged.match(/pubmed\.ncbi\.nlm\.nih\.gov\/1002\//g).length, 1);
	vm.runInContext("shutdown()", env.context);
});

test("API key from the login manager raises the rate to 10/s; per-run limit queues the rest; trashed imports stay out", async () => {
	let ids = ["1001", "1002", "1003", "1004", "1006"];
	let env = await setup({
		prefs: {
			[P + "pubmedWatch.maxPerWatch"]: "2",
			[P + "pubmedWatch.digest"]: false,
			[P + "pubmedWatch.watches"]: JSON.stringify([{ id: "falls", name: "跌倒預防", query: FALLS }]),
		},
		searches: { [FALLS]: ids },
		fetchOpts: { rateLimitOnce: true },
	});
	await env.ZB.secrets.set("ncbiKey", "ncbi-123");
	let { results } = await env.watch.runAll();
	assert.equal(env.prefStore[P + "pubmedWatch.apiKey"], undefined, "the key never lands in prefs");
	assert.equal(env.log[0].params.api_key, "ncbi-123");
	// HTTP 429 once: waited and asked again
	assert.equal(env.log[0].params.term, env.log[1].params.term);
	assert.ok(env.sleeps.includes(1000));
	assert.ok(env.sleeps.filter(ms => ms !== 1000).every(ms => ms > 90 && ms <= 130), String(env.sleeps));
	same(results[0].imported.map(e => e.pmid), ["1001", "1002"]);
	assert.equal(results[0].queued, 3);
	same(state(env).falls.queue, ["1003", "1004", "1006"]);
	assert.ok(env.progressLines.some(l => /3 篇留待下次/.test(l.text)));
	assert.equal(fs.existsSync(path.join(env.vault, "Zotero", "新文獻")), false, "digest off");

	// The user trashes 1001; the next check continues the queue and never re-imports it
	let trashed = [...env.items.values()].find(i => i.fields.extra === "PMID: 1001");
	trashed.deleted = true;
	env.log.length = 0;
	let next = await env.watch.runAll();
	same(next.results[0].imported.map(e => e.pmid), ["1003", "1004"]);
	same(state(env).falls.queue, ["1006"]);
	let third = await env.watch.runAll();
	same(third.results[0].imported.map(e => e.pmid), ["1006"]);
	assert.equal([...env.items.values()].filter(i => i.fields.extra === "PMID: 1001").length, 1);
	vm.runInContext("shutdown()", env.context);
});

test("a failing watch is reported and keeps its last check; the others still run", async () => {
	let env = await setup({
		prefs: { [P + "pubmedWatch.email"]: "", [P + "pubmedWatch.watches"]: JSON.stringify([
			{ id: "bad", name: "壞的", query: "BROKEN[tiab]" },
			{ id: "falls", name: "跌倒預防", query: FALLS },
			{ id: "off", name: "停用", query: "x", enabled: false },
		]) },
		searches: { [FALLS]: ["1002"] },
	});
	let { results } = await env.watch.runAll();
	same(results.map(r => r.id), ["bad", "falls"]);
	assert.equal(results[0].error, "PubMed 檢索式有誤：Invalid query syntax");
	assert.equal(state(env).bad, undefined);
	assert.equal(state(env).falls.lastCheck, NOW.toISOString());
	let bad = env.progressLines.find(l => l.text.startsWith("壞的"));
	assert.ok(bad.error);
	assert.equal(bad.text, "壞的：失敗 — PubMed 檢索式有誤：Invalid query syntax");
	assert.ok(!("email" in env.log[0].params));
	assert.ok(env.descriptions.some(d => /建議在設定填入 Email/.test(d)));

	// Nothing configured
	env.prefStore[P + "pubmedWatch.watches"] = "[]";
	await env.watch.runAll();
	assert.match(env.descriptions.at(-1), /還沒有要檢查的追蹤/);
	vm.runInContext("shutdown()", env.context);
});

test("AI notes for new papers: only after a manual check and only when enabled, through main.run", async () => {
	let env = await setup({
		prefs: { [P + "pubmedWatch.runAI"]: true, [P + "pubmedWatch.watches"]: JSON.stringify([{ id: "falls", name: "跌倒預防", query: FALLS }]) },
		searches: { [FALLS]: ["1002"] },
	});
	let runs = [];
	env.ZB.main.run = async (items, action) => { runs.push({ items, action }); };
	let { results } = await env.watch.runAll();
	assert.equal(runs.length, 1);
	same(runs[0].items, [results[0].imported[0].item]);
	same(JSON.parse(JSON.stringify(runs[0].action)), { targets: ["notion", "obsidian"], ai: "missing" });

	// Unattended: no AI, no progress window, a short notification of what came in
	env.prefStore[P + "pubmedWatch.state"] = "{}";
	[...env.items.values()].forEach((i) => { i.libraryID = 9; });
	let lines = env.progressLines.length;
	await env.watch.runAll({ auto: true });
	assert.equal(runs.length, 1);
	assert.equal(env.progressLines.length, lines);
	assert.match(env.descriptions.at(-1), /跌倒預防：找到 1 篇，新匯入 1 篇/);
	vm.runInContext("shutdown()", env.context);
});

test("automatic checks: no timer while off; when on, due watches run unattended; shutdown clears timers", async () => {
	let env = await setup({
		prefs: { [P + "pubmedWatch.watches"]: JSON.stringify([{ id: "falls", name: "跌倒預防", query: FALLS }]) },
		searches: { [FALLS]: ["1002"] },
	});
	assert.equal(env.watch.timerActive, false, "off by default: no timer at all");
	same(env.watch.dueWatches(NOW), ["falls"]);
	// Turning it on in the settings starts the timer (the startup delay is shortened by the mock)
	env.Zotero.Prefs.set(P + "pubmedWatch.autoCheck", true);
	assert.equal(env.watch.timerActive, true);
	for (let i = 0; i < 200 && !state(env).falls; i++) await new Promise(r => setTimeout(r, 5));
	assert.equal(state(env).falls.lastCheck, NOW.toISOString());
	assert.equal(env.translateCalls.length, 1);
	same(env.watch.dueWatches(NOW), [], "checked within the interval");
	same(env.watch.dueWatches(new Date(NOW.getTime() + 25 * 3600 * 1000)), ["falls"]);
	// Still ticking (hourly), but nothing is due: no more requests
	let requests = env.log.length;
	await new Promise(r => setTimeout(r, 30));
	assert.equal(env.log.length, requests);
	assert.equal(env.watch.timerActive, true);

	vm.runInContext("shutdown()", env.context);
	assert.equal(env.watch.timerActive, false);
	assert.equal(env.timers.live.size, 0, "no timer left after shutdown");
	assert.ok(env.timers.cleared >= 1);
	// The observer is gone too: changing the pref after shutdown starts nothing
	env.Zotero.Prefs.set(P + "pubmedWatch.autoCheck", false);
	env.Zotero.Prefs.set(P + "pubmedWatch.autoCheck", true);
	assert.equal(env.watch.timerActive, false);
});

test("settings pane: add, edit and delete watches; test a query against PubMed", async () => {
	let env = await setup({ prefs: { [P + "pubmedWatch.watches"]: "[]" }, searches: { [FALLS]: ["1", "2", "3"] } });
	let { window } = new JSDOM(`<div><input id="zb-ncbi-key" type="password"><div id="zb-pubmed-watches"></div></div>`);
	let doc = window.document;
	env.watch.renderPrefs(doc);
	assert.match(doc.getElementById("zb-pubmed-watches").textContent, /尚未設定追蹤/);
	env.watch.addWatch();
	env.watch.renderPrefs(doc);
	let box = doc.querySelector(".zb-watch");
	let inputs = box.querySelectorAll("input[type=text], textarea");
	assert.equal(inputs.length, 5);
	let type = (el, v) => {
		el.value = v;
		el.dispatchEvent(new window.Event("input"));
	};
	type(inputs[0], "跌倒預防");
	assert.equal(box.querySelector("strong").textContent, "跌倒預防");
	type(inputs[1], FALLS);
	type(inputs[3], "14");
	let saved = JSON.parse(env.prefStore[P + "pubmedWatch.watches"]);
	assert.equal(saved.length, 1);
	assert.match(saved[0].id, /^w/);
	same(Object.assign({}, saved[0], { id: "" }), { id: "", name: "跌倒預防", query: FALLS, collection: "", days: "14", since: "", enabled: true });
	same(env.watch.readWatches().watches[0].collection, "📥 新文獻/跌倒預防");

	let [testButton, deleteButton] = box.querySelectorAll("button");
	testButton.dispatchEvent(new window.Event("click"));
	let status = box.querySelector("pre");
	for (let i = 0; i < 100 && !/符合/.test(status.textContent); i++) await new Promise(r => setTimeout(r, 5));
	assert.equal(status.textContent, `✅ 符合 30 篇；最近 14 天加入 PubMed 的有 30 篇（第一次檢查會匯入這些，每次最多 50 篇）\nPubMed 解讀為：translated(${FALLS})`);
	same(env.log.map(c => [c.params.retmax, c.params.reldate]), [["0", undefined], ["0", "14"]]);

	let checkbox = box.querySelector("input[type=checkbox]");
	checkbox.checked = false;
	checkbox.dispatchEvent(new window.Event("change"));
	assert.equal(JSON.parse(env.prefStore[P + "pubmedWatch.watches"])[0].enabled, false);
	deleteButton.dispatchEvent(new window.Event("click"));
	same(JSON.parse(env.prefStore[P + "pubmedWatch.watches"]), []);
	assert.match(doc.getElementById("zb-pubmed-watches").textContent, /尚未設定追蹤/);
	vm.runInContext("shutdown()", env.context);
});
