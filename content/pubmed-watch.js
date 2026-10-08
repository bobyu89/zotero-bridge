/*
 * Zotero Bridge — PubMed new-literature watch (新文獻追蹤).
 *
 * Saved PubMed searches (full PubMed syntax, MeSH included) are run against NCBI E-utilities:
 * ESearch (retmode=json, datetype=edat, mindate/maxdate since the last check) for the PMIDs, then
 * ESummary (retmode=json) for the DOI, title and journal. Each PMID that is not yet in the library
 * (PMID in Extra or the same DOI) is imported with Zotero's own search translators — the same
 * Zotero.Translate.Search + setIdentifier({ PMID }) path as the magic wand (lookup.js) — into the
 * watch's collection, tagged 新文獻, 追蹤/<watch name> and 來源/PubMed. Every request follows the
 * NCBI usage rules: tool and email parameters, an optional API key, at most 3 requests per second
 * (10 with the key). New papers are also listed in a daily Obsidian note <folder>/新文獻/<date>.md.
 *
 *   extensions.zotero-bridge.pubmedWatch.watches   [{ id, name, query, collection, days, since, enabled }]
 *   extensions.zotero-bridge.pubmedWatch.state     { watchID: { lastCheck, seen, queue, retry } }
 *
 * The helpers at the top are pure (Node tests); the rest needs Zotero.
 */
(function (root, factory) {
	if (typeof module === "object" && module.exports) {
		module.exports = factory(require("./core.js"), globalThis);
	}
	else {
		(root.ZB = root.ZB || {}).pubmedWatch = factory(root.ZB.core, root);
	}
})(this, function (core, scope) {
	const PREF = "extensions.zotero-bridge.";
	const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/";
	const TOOL = "zotero-bridge";
	const NEW_TAG = "新文獻";
	const WATCH_TAG_PREFIX = "追蹤/";
	const SOURCE = "PubMed";
	const DEFAULT_COLLECTION_ROOT = "📥 新文獻";
	const DIGEST_FOLDER = "新文獻";
	const DEFAULT_DAYS = 30;
	const DEFAULT_MAX = 50;
	const MAX_PER_WATCH = 200;
	// PMIDs fetched per ESearch; candidates beyond the per-run limit wait in the watch's queue
	const QUEUE_LIMIT = 500;
	// PMIDs remembered per watch, so a paper the user trashed is not imported again
	const SEEN_LIMIT = 2000;
	// IDs per ESummary GET and per translator run (lookup.js batches up to 200 PMIDs)
	const SUMMARY_CHUNK = 200;
	const IMPORT_CHUNK = 50;
	const MAX_ATTEMPTS = 3;
	const DAY_MS = 24 * 3600 * 1000;
	const STARTUP_DELAY_MS = 2 * 60 * 1000;
	const TICK_MS = 60 * 60 * 1000;
	const USER_HEADING = "✍️ 我的筆記";
	const MARK_START = "%% zotero-bridge:start — 此區塊由 Zotero Bridge 自動產生；同一天再次檢查時會加入新文獻，已勾選的項目會保留 %%";
	const MARK_START_RE = /^%% zotero-bridge:start.*%%[ \t]*$/m;
	const MARK_END_RE = /^%% zotero-bridge:end %%[ \t]*$/m;

	// ---------- watches (pure) ----------

	function clampInt(v, min, max, dflt) {
		let n = Math.round(Number(v));
		if (v === "" || v === null || v === undefined || !Number.isFinite(n)) return dflt;
		return Math.min(max, Math.max(min, n));
	}

	function defaultCollection(name) {
		return `${DEFAULT_COLLECTION_ROOT}/${String(name || "").replace(/\//g, "／").trim()}`;
	}

	/** "YYYY", "YYYY/MM" or "YYYY/MM/DD" (also with - or .) → "YYYY/MM/DD"-style PubMed date, or "" */
	function normalizeSince(v) {
		let m = /^\s*(\d{4})(?:[-/.](\d{1,2}))?(?:[-/.](\d{1,2}))?\s*$/.exec(String(v || ""));
		if (!m) return "";
		return [m[1], m[2] && m[2].padStart(2, "0"), m[3] && m[3].padStart(2, "0")].filter(Boolean).join("/");
	}

	/** One watch from the settings, with defaults; problems are returned as messages, not thrown. */
	function normalizeWatch(w, index) {
		let errors = [];
		let name = String((w && w.name) || "").trim();
		let query = String((w && w.query) || "").trim();
		let label = name || `第 ${index + 1} 筆`;
		if (!name) errors.push(`${label}：沒有名稱`);
		if (!query) errors.push(`${label}：沒有 PubMed 檢索式`);
		let open = (query.match(/\(/g) || []).length;
		let close = (query.match(/\)/g) || []).length;
		if (open !== close) errors.push(`${label}：檢索式的括號不成對（「(」${open} 個、「)」${close} 個）`);
		if ((query.match(/"/g) || []).length % 2) errors.push(`${label}：檢索式的引號不成對`);
		let sinceRaw = String((w && w.since) || "").trim();
		let since = normalizeSince(sinceRaw);
		if (sinceRaw && !since) errors.push(`${label}：出版日期起始「${sinceRaw}」看不懂（請用 2020 或 2020/01/01）`);
		return {
			watch: {
				id: String((w && w.id) || name || `watch-${index + 1}`),
				name,
				query,
				collection: String((w && w.collection) || "").trim() || defaultCollection(name),
				days: clampInt(w && w.days, 1, 3650, DEFAULT_DAYS),
				since,
				enabled: !w || w.enabled !== false,
			},
			errors,
		};
	}

	/** The watches pref (a JSON array) → { watches, errors }. Invalid watches are left out. */
	function parseWatches(text) {
		let list;
		try {
			list = typeof text === "string" ? JSON.parse(text.trim() || "[]") : text;
		}
		catch (e) {
			return { watches: [], errors: [`追蹤清單不是有效的 JSON：${e.message}`] };
		}
		if (!Array.isArray(list)) return { watches: [], errors: ["追蹤清單必須是 JSON 陣列"] };
		let watches = [];
		let errors = [];
		let ids = new Set();
		list.forEach((w, i) => {
			let r = normalizeWatch(w, i);
			if (r.errors.length) {
				errors.push(...r.errors);
				return;
			}
			if (ids.has(r.watch.id)) {
				errors.push(`${r.watch.name}：名稱重複（每個追蹤需要不同的名稱）`);
				return;
			}
			ids.add(r.watch.id);
			watches.push(r.watch);
		});
		return { watches, errors };
	}

	/** The ESearch term: the user's query, plus the publication-date filter when one is set. */
	function watchTerm(watch) {
		let term = String(watch.query || "").trim();
		if (!watch.since) return term;
		return `(${term}) AND ("${watch.since}"[dp] : "3000"[dp])`;
	}

	// ---------- E-utilities requests (pure) ----------

	/** YYYY/MM/DD in UTC. PubMed's Entrez dates are US Eastern dates, never ahead of the UTC date. */
	function ncbiDate(date) {
		let d = new Date(date);
		let p = n => String(n).padStart(2, "0");
		return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}`;
	}

	/**
	 * The Entrez-date window for a check: from the day before the last check (the Eastern-time date
	 * can be a day behind ours, and the window is inclusive) or `days` back on the first check, to today.
	 */
	function searchWindow(watch, lastCheck, now) {
		let to = new Date(now);
		let from = lastCheck ? new Date(new Date(lastCheck).getTime() - DAY_MS) : new Date(to.getTime() - watch.days * DAY_MS);
		if (isNaN(from.getTime()) || from > to) from = new Date(to.getTime() - watch.days * DAY_MS);
		return { mindate: ncbiDate(from), maxdate: ncbiDate(to) };
	}

	function eutilsURL(tool, params, ncbi = {}) {
		let q = new URLSearchParams();
		for (let [k, v] of Object.entries(params)) {
			if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
		}
		// NCBI usage rules: identify the tool and a contact email; the API key raises the rate limit
		q.set("tool", TOOL);
		if (ncbi.email) q.set("email", ncbi.email);
		if (ncbi.apiKey) q.set("api_key", ncbi.apiKey);
		return `${EUTILS}${tool}.fcgi?${q.toString()}`;
	}

	function esearchURL(term, opts = {}, ncbi = {}) {
		return eutilsURL("esearch", {
			db: "pubmed",
			term,
			retmode: "json",
			retmax: opts.retmax === undefined ? QUEUE_LIMIT : opts.retmax,
			sort: opts.retmax === 0 ? undefined : "pub_date",
			datetype: opts.mindate || opts.reldate ? "edat" : undefined,
			mindate: opts.mindate,
			maxdate: opts.maxdate,
			reldate: opts.reldate,
		}, ncbi);
	}

	function esummaryURL(pmids, ncbi = {}) {
		return eutilsURL("esummary", { db: "pubmed", id: pmids.join(","), retmode: "json" }, ncbi);
	}

	/** ESearch JSON → { count, ids, translation, warnings }; an error reported by NCBI is thrown. */
	function parseESearch(json) {
		if (json && json.error) throw new Error(`PubMed：${json.error}`);
		let r = json && json.esearchresult;
		if (!r) throw new Error("PubMed 回傳的資料無法辨識");
		if (r.ERROR) throw new Error(`PubMed 檢索式有誤：${r.ERROR}`);
		let warnings = [];
		let lists = [r.errorlist, r.warninglist].filter(Boolean);
		for (let list of lists) {
			for (let p of list.phrasesnotfound || []) warnings.push(`找不到詞彙：${p}`);
			for (let p of list.phrasesignored || []) warnings.push(`忽略的詞：${p}`);
			for (let p of list.fieldsnotfound || []) warnings.push(`找不到欄位：${p}`);
			for (let p of list.quotedphrasesnotfound || []) warnings.push(`找不到片語：${p}`);
			for (let p of list.outputmessages || []) warnings.push(String(p));
		}
		return {
			count: Number(r.count) || 0,
			ids: (r.idlist || []).map(String).filter(id => /^\d+$/.test(id)),
			translation: r.querytranslation || "",
			warnings,
		};
	}

	/** ESummary JSON → [{ pmid, title, journal, year, doi, authors }] in the order of `uids`. */
	function parseESummary(json) {
		if (json && json.error) throw new Error(`PubMed：${json.error}`);
		let r = json && json.result;
		if (!r) throw new Error("PubMed 摘要資料無法辨識");
		let out = [];
		for (let uid of r.uids || []) {
			let d = r[uid];
			if (!d || d.error) continue;
			let doi = "";
			for (let a of d.articleids || []) {
				if (a.idtype === "doi" && a.value) doi = a.value;
			}
			if (!doi) doi = (/\bdoi:\s*(10\.\S+?)\.?(?:\s|$)/i.exec(d.elocationid || "") || [])[1] || "";
			out.push({
				pmid: String(uid),
				title: String(d.title || "").replace(/\s+/g, " ").trim(),
				journal: String(d.fulljournalname || d.source || "").trim(),
				year: (/\d{4}/.exec(d.pubdate || d.epubdate || d.sortpubdate || "") || [""])[0],
				doi,
				authors: (d.authors || []).map(a => a.name).filter(Boolean),
			});
		}
		return out;
	}

	/**
	 * At most `perSecond` requests per second: each wait() resolves no sooner than 1/perSecond
	 * after the previous one started (with a small margin). Shared by all requests of one check.
	 */
	function createThrottle(perSecond, opts = {}) {
		let now = opts.now || (() => Date.now());
		let sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)));
		let gap = Math.ceil(1000 / perSecond) + (opts.margin === undefined ? 20 : opts.margin);
		let next = 0;
		let chain = Promise.resolve();
		let count = 0;
		function wait() {
			let p = chain.then(async () => {
				let delay = next - now();
				if (delay > 0) await sleep(delay);
				next = now() + gap;
				count++;
			});
			chain = p.catch(() => {});
			return p;
		}
		return { wait, gap, get count() { return count; } };
	}

	// ---------- candidates and dedup (pure) ----------

	/**
	 * What to look at in this check: PMIDs left over from earlier checks first (the queue, then
	 * those to retry), then the new search results; anything already seen is skipped. Returns the
	 * PMIDs for this run (at most `max`) and those that wait for the next check.
	 */
	function planCandidates(state, ids, max) {
		let seen = new Set(state.seen || []);
		let all = [];
		let added = new Set();
		for (let id of [...(state.queue || []), ...Object.keys(state.retry || {}), ...ids]) {
			id = String(id);
			if (seen.has(id) || added.has(id)) continue;
			added.add(id);
			all.push(id);
		}
		return { batch: all.slice(0, max), queue: all.slice(max, max + QUEUE_LIMIT), dropped: Math.max(0, all.length - max - QUEUE_LIMIT) };
	}

	/** PMID from an item's Extra field ("PMID: 12345678"), or "". */
	function pmidFromExtra(extra) {
		return (/^\s*PMID:\s*(\d+)\s*$/im.exec(String(extra || "")) || [])[1] || "";
	}

	function normalizeDOI(doi) {
		return String(doi || "").trim().toLowerCase()
			.replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//, "")
			.replace(/^doi:\s*/, "");
	}

	function watchTag(watch) {
		return WATCH_TAG_PREFIX + watch.name;
	}

	function collectionParts(path) {
		return String(path || "").split("/").map(s => s.trim()).filter(Boolean);
	}

	/** One-line result for the progress window. */
	function describeResult(r) {
		if (r.error) return `${r.name}：失敗 — ${r.error}`;
		let parts = [`找到 ${r.found} 篇`, `新匯入 ${r.imported.length} 篇`];
		if (r.existing) parts.push(`已在文獻庫 ${r.existing} 篇`);
		if (r.failed.length) parts.push(`匯入失敗 ${r.failed.length} 篇（下次再試）`);
		if (r.gaveUp.length) parts.push(`放棄 ${r.gaveUp.length} 篇（PMID ${r.gaveUp.join(", ")}）`);
		if (r.queued) parts.push(`${r.queued} 篇留待下次`);
		return `${r.name}：${parts.join("，")}`;
	}

	// ---------- Obsidian digest (pure) ----------

	function digestLine(e) {
		let title = String(e.title || `PMID ${e.pmid}`).replace(/\s+/g, " ").trim();
		let meta = [e.journal ? `*${e.journal}*` : "", e.year ? `(${e.year})` : ""].filter(Boolean).join(" ");
		let links = [];
		if (e.zotero) links.push(`[Zotero](${e.zotero})`);
		if (e.doi) links.push(`[DOI](https://doi.org/${e.doi})`);
		links.push(`[PubMed](https://pubmed.ncbi.nlm.nih.gov/${e.pmid}/)`);
		return `- [ ] **${title}**${meta ? ` — ${meta}` : ""} · ${links.join(" · ")}`;
	}

	// The managed region as [{ name, lines }], reading back what an earlier run wrote (lines verbatim)
	function parseDigestRegion(text) {
		let groups = [];
		for (let line of String(text || "").split("\n")) {
			let h = /^##\s+(.+?)\s*$/.exec(line);
			if (h) {
				groups.push({ name: h[1], lines: [] });
			}
			else if (/^\s*-\s/.test(line) && groups.length) {
				groups[groups.length - 1].lines.push(line);
			}
		}
		return groups;
	}

	function linePMID(line) {
		return (/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/.exec(line) || [])[1] || "";
	}

	/**
	 * The day's digest note. `groups` is [{ name, entries }] from this check. With `existing`, the
	 * plugin's region keeps its lines (and their checkboxes) and gains the papers it doesn't list
	 * yet; everything outside the region is the user's.
	 */
	function buildDigestNote(existing, date, groups) {
		let body = existing || "";
		let start = existing ? MARK_START_RE.exec(body) : null;
		let end = existing ? MARK_END_RE.exec(body) : null;
		let hasRegion = start && end && end.index > start.index;
		let old = hasRegion ? parseDigestRegion(body.slice(start.index + start[0].length, end.index)) : [];
		let listed = new Set(old.flatMap(g => g.lines.map(linePMID)).filter(Boolean));
		let merged = old.map(g => ({ name: g.name, lines: g.lines.slice() }));
		for (let g of groups) {
			let lines = [];
			for (let e of g.entries) {
				if (listed.has(e.pmid)) continue;
				listed.add(e.pmid);
				lines.push(digestLine(e));
			}
			if (!lines.length) continue;
			let target = merged.find(m => m.name === g.name);
			if (target) target.lines.push(...lines);
			else merged.push({ name: g.name, lines });
		}
		let section = merged.map(g => `## ${g.name}\n\n${g.lines.join("\n")}`).join("\n\n");
		let block = `${MARK_START}\n\n${section}\n\n%% zotero-bridge:end %%`;
		if (!existing) {
			return core.buildFrontmatter({ type: "pubmed-digest", date, tags: [NEW_TAG] }, null)
				+ `\n# 新文獻 ${date}\n\n勾選看過的文獻；要細讀的在 Zotero 改閱讀狀態或標為篩選納入。\n\n${block}\n\n## ${USER_HEADING}\n\n`;
		}
		if (hasRegion) return body.slice(0, start.index) + block + body.slice(end.index + end[0].length);
		// The markers were removed: add a fresh block at the end
		return body.replace(/\s*$/, "\n\n") + block + "\n";
	}

	function localDate(date = new Date()) {
		let p = n => String(n).padStart(2, "0");
		return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
	}

	// ---------- settings and state ----------

	let runtime = {
		fetch: (url, init) => scope.fetch(url, init),
		sleep: ms => new Promise(r => setTimeout(r, ms)),
		now: () => new Date(),
	};

	function pref(key) {
		return Zotero.Prefs.get(PREF + key, true);
	}

	function config() {
		return {
			email: String(pref("pubmedWatch.email") || "").trim(),
			max: clampInt(pref("pubmedWatch.maxPerWatch"), 1, MAX_PER_WATCH, DEFAULT_MAX),
			autoCheck: pref("pubmedWatch.autoCheck") === true,
			intervalHours: clampInt(pref("pubmedWatch.intervalHours"), 1, 24 * 30, 24),
			runAI: pref("pubmedWatch.runAI") === true,
			digest: pref("pubmedWatch.digest") !== false,
		};
	}

	function readWatches() {
		return parseWatches(pref("pubmedWatch.watches") || "[]");
	}

	function readState() {
		try {
			let s = JSON.parse(pref("pubmedWatch.state") || "{}");
			return s && typeof s === "object" && !Array.isArray(s) ? s : {};
		}
		catch (e) {
			return {};
		}
	}

	function writeWatchState(id, st) {
		let all = readState();
		all[id] = st;
		Zotero.Prefs.set(PREF + "pubmedWatch.state", JSON.stringify(all), true);
	}

	async function ncbiSettings() {
		let apiKey = "";
		try {
			apiKey = String((await scope.ZB.secrets.get("ncbiKey")) || "").trim();
		}
		catch (e) {
			Zotero.logError(e);
		}
		return { email: config().email, apiKey };
	}

	// ---------- requests ----------

	async function getJSON(url, ctx) {
		for (let attempt = 0; ; attempt++) {
			await ctx.throttle.wait();
			ctx.requests.push(url);
			let res = await runtime.fetch(url, { method: "GET", headers: { Accept: "application/json" } });
			let text = await res.text();
			// Over the rate limit (another program with the same IP or key): wait and try again
			if (res.status === 429 && attempt < 2) {
				await runtime.sleep(1000 * (attempt + 1));
				continue;
			}
			if (!res.ok) throw new Error(`PubMed 連線失敗（HTTP ${res.status}）`);
			try {
				return JSON.parse(text);
			}
			catch (e) {
				throw new Error("PubMed 回傳的資料無法讀取");
			}
		}
	}

	async function summaries(pmids, ctx) {
		let out = new Map();
		for (let i = 0; i < pmids.length; i += SUMMARY_CHUNK) {
			let chunk = pmids.slice(i, i + SUMMARY_CHUNK);
			for (let rec of parseESummary(await getJSON(esummaryURL(chunk, ctx.ncbi), ctx))) out.set(rec.pmid, rec);
		}
		return out;
	}

	// ---------- Zotero: library, collections, import ----------

	function field(item, name) {
		try {
			return item.getField(name, false, true) || "";
		}
		catch (e) {
			return "";
		}
	}

	function itemPMID(item) {
		return pmidFromExtra(field(item, "extra"));
	}

	function itemDOI(item) {
		return normalizeDOI(field(item, "DOI") || ((/^\s*DOI:\s*(\S+)/im.exec(field(item, "extra")) || [])[1] || ""));
	}

	/** A regular item already in the library with this PMID (in Extra) or DOI, or null. */
	async function findExisting(libraryID, pmid, doi) {
		let s = new Zotero.Search();
		s.libraryID = libraryID;
		s.addCondition("joinMode", "any");
		s.addCondition("extra", "contains", `PMID: ${pmid}`);
		doi = normalizeDOI(doi);
		if (doi) s.addCondition("DOI", "contains", doi);
		let ids = await s.search();
		for (let item of Zotero.Items.get(ids || [])) {
			if (!item || item.deleted || !item.isRegularItem()) continue;
			// "PMID: 123" also matches "PMID: 1234", and DOI "contains" also matches longer DOIs
			if (itemPMID(item) === pmid || (doi && itemDOI(item) === doi)) return item;
		}
		return null;
	}

	/** The collection at `path` ("📥 新文獻/跌倒"), creating the missing levels. */
	async function ensureCollection(libraryID, path) {
		let parent = null;
		for (let name of collectionParts(path)) {
			let siblings = parent ? Zotero.Collections.getByParent(parent.id) : Zotero.Collections.getByLibrary(libraryID);
			let found = siblings.find(c => c.name === name && !c.deleted);
			if (!found) {
				found = new Zotero.Collection({ name, libraryID, parentID: parent ? parent.id : undefined });
				await found.saveTx();
			}
			parent = found;
		}
		return parent;
	}

	/** Run Zotero's search translators (as the magic wand does) for some PMIDs; returns the new items. */
	async function translatePMIDs(pmids, libraryID, collectionID, ctx) {
		await ctx.throttle.wait();
		let translate = new Zotero.Translate.Search();
		translate.setIdentifier({ PMID: pmids.length === 1 ? pmids[0] : pmids });
		let translators = await translate.getTranslators();
		if (!translators || !translators.length) throw new Error("找不到 PubMed 匯入器（translator）");
		translate.setTranslator(translators);
		return (await translate.translate({
			libraryID,
			collections: collectionID ? [collectionID] : false,
			// Metadata only: the check runs unattended and should not download files
			saveAttachments: false,
		})) || [];
	}

	/**
	 * Import PMIDs in chunks; a chunk that fails or leaves some PMIDs out is retried one PMID at a
	 * time. Returns { items: Map(pmid → item), failed: [pmid], errors: [message] }.
	 */
	async function importPMIDs(pmids, records, libraryID, collectionID, ctx) {
		let items = new Map();
		let errors = [];
		let match = (newItems, wanted) => {
			for (let item of newItems) {
				if (!item || !item.isRegularItem || !item.isRegularItem()) continue;
				let pmid = itemPMID(item);
				if (!pmid || !wanted.includes(pmid)) {
					let doi = itemDOI(item);
					pmid = doi ? wanted.find(p => normalizeDOI(records.get(p) && records.get(p).doi) === doi) : "";
					if (!pmid && wanted.length === 1) pmid = wanted[0];
				}
				if (pmid && !items.has(pmid)) items.set(pmid, item);
			}
		};
		for (let i = 0; i < pmids.length; i += IMPORT_CHUNK) {
			let chunk = pmids.slice(i, i + IMPORT_CHUNK);
			try {
				match(await translatePMIDs(chunk, libraryID, collectionID, ctx), chunk);
			}
			catch (e) {
				Zotero.logError(e);
				if (chunk.length === 1) errors.push(`PMID ${chunk[0]}：${e.message || e}`);
			}
			if (chunk.length === 1) continue;
			for (let pmid of chunk.filter(p => !items.has(p))) {
				try {
					match(await translatePMIDs([pmid], libraryID, collectionID, ctx), [pmid]);
				}
				catch (e) {
					Zotero.logError(e);
					errors.push(`PMID ${pmid}：${e.message || e}`);
				}
			}
		}
		return { items, failed: pmids.filter(p => !items.has(p)), errors };
	}

	async function tagItem(item, watch, collectionID, sourceTag) {
		for (let tag of [NEW_TAG, watchTag(watch), sourceTag]) item.addTag(tag);
		if (collectionID && !item.getCollections().includes(collectionID)) item.addToCollection(collectionID);
		// Quietly: auto-sync already reacts to the new item itself
		await scope.ZB.main.saveQuietly(item);
	}

	function sourceTag() {
		let prefix = scope.ZB.screening ? scope.ZB.screening.config().sourcePrefix : "來源/";
		return prefix + SOURCE;
	}

	/** Check one watch: search, dedup, import. Never throws; the result says what happened. */
	async function checkWatch(watch, ctx) {
		let result = { id: watch.id, name: watch.name, found: 0, imported: [], existing: 0, failed: [], gaveUp: [], queued: 0, warnings: [], error: "" };
		let state = Object.assign({ seen: [], queue: [], retry: {} }, readState()[watch.id] || {});
		let startedAt = runtime.now();
		try {
			let win = searchWindow(watch, state.lastCheck, startedAt);
			let search = parseESearch(await getJSON(esearchURL(watchTerm(watch), win, ctx.ncbi), ctx));
			result.found = search.count;
			result.warnings = search.warnings;
			if (search.count > search.ids.length) {
				result.warnings.push(`符合 ${search.count} 篇，只取最新的 ${search.ids.length} 篇；請縮小檢索式`);
			}
			let plan = planCandidates(state, search.ids, ctx.max);
			result.queued = plan.queue.length;
			let records = plan.batch.length ? await summaries(plan.batch, ctx) : new Map();
			let seen = new Set(state.seen);
			let toImport = [];
			for (let pmid of plan.batch) {
				let rec = records.get(pmid) || { pmid, doi: "" };
				if (await findExisting(ctx.libraryID, pmid, rec.doi)) {
					result.existing++;
					seen.add(pmid);
				}
				else {
					toImport.push(pmid);
				}
			}
			let retry = {};
			if (toImport.length) {
				let collection = await ensureCollection(ctx.libraryID, watch.collection);
				let imported = await importPMIDs(toImport, records, ctx.libraryID, collection && collection.id, ctx);
				for (let [pmid, item] of imported.items) {
					try {
						await tagItem(item, watch, collection && collection.id, ctx.sourceTag);
					}
					catch (e) {
						Zotero.logError(e);
						result.warnings.push(`PMID ${pmid} 已匯入，但加標籤失敗：${e.message || e}`);
					}
					seen.add(pmid);
					let rec = records.get(pmid) || {};
					result.imported.push({
						pmid,
						item,
						title: field(item, "title") || rec.title || "",
						journal: field(item, "publicationTitle") || rec.journal || "",
						year: (/\d{4}/.exec(field(item, "date")) || [])[0] || rec.year || "",
						doi: field(item, "DOI") || rec.doi || "",
						zotero: `zotero://select/${scope.ZB.adapter.libraryInfo(item.libraryID).path}/items/${item.key}`,
					});
				}
				for (let pmid of imported.failed) {
					let attempts = ((state.retry || {})[pmid] || 0) + 1;
					if (attempts >= MAX_ATTEMPTS) {
						result.gaveUp.push(pmid);
						seen.add(pmid);
					}
					else {
						retry[pmid] = attempts;
						result.failed.push(pmid);
					}
				}
				result.warnings.push(...imported.errors.slice(0, 3));
			}
			writeWatchState(watch.id, {
				lastCheck: startedAt.toISOString(),
				seen: [...seen].slice(-SEEN_LIMIT),
				queue: plan.queue,
				retry,
			});
		}
		catch (e) {
			Zotero.logError(e);
			result.error = String(e.message || e);
		}
		return result;
	}

	// ---------- digest note ----------

	async function writeDigest(settings, results, now) {
		let groups = results.filter(r => r.imported.length).map(r => ({ name: r.name, entries: r.imported }));
		if (!groups.length || !settings.vaultPath) return "";
		let parts = [...core.splitFolder(settings.defaults.obsidianFolder), DIGEST_FOLDER];
		let dir = PathUtils.join(settings.vaultPath, ...parts);
		let date = localDate(now);
		let path = PathUtils.join(dir, `${date}.md`);
		await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
		let existing = (await IOUtils.exists(path)) ? await IOUtils.readUTF8(path) : null;
		let text = buildDigestNote(existing, date, groups);
		if (text !== existing) await IOUtils.writeUTF8(path, text);
		return [...parts, `${date}.md`].join("/");
	}

	// ---------- running ----------

	let checking = null;

	/**
	 * Check the watches now. opts: { auto } (unattended: no progress window unless something was
	 * imported or failed, and never any AI), { only: [watch IDs] }.
	 */
	function runAll(opts = {}) {
		if (checking) {
			if (!opts.auto) scope.ZB.main.notify("Zotero Bridge：PubMed 追蹤", "正在檢查新文獻，請稍候。");
			return checking;
		}
		checking = runAllNow(opts).finally(() => {
			checking = null;
		});
		return checking;
	}

	async function runAllNow(opts) {
		let ZB = scope.ZB;
		let headline = "Zotero Bridge：PubMed 新文獻追蹤";
		let cfg = config();
		let { watches, errors: configErrors } = readWatches();
		watches = watches.filter(w => w.enabled && (!opts.only || opts.only.includes(w.id)));
		if (!watches.length) {
			if (!opts.auto) {
				ZB.main.notify(headline, configErrors.length
					? `追蹤清單有誤：${configErrors.slice(0, 3).join("；")}`
					: "還沒有要檢查的追蹤：請到 設定 → Zotero Bridge → PubMed 新文獻追蹤 新增。");
			}
			return { results: [], digest: "" };
		}
		let ncbi = await ncbiSettings();
		let ctx = {
			ncbi,
			max: cfg.max,
			libraryID: Zotero.Libraries.userLibraryID,
			throttle: createThrottle(ncbi.apiKey ? 10 : 3, { sleep: runtime.sleep }),
			requests: [],
			sourceTag: sourceTag(),
		};
		let pw = null;
		let lines = new Map();
		if (!opts.auto) {
			pw = new Zotero.ProgressWindow({ closeOnClick: true });
			pw.changeHeadline(headline);
			pw.show();
			for (let w of watches) lines.set(w.id, new pw.ItemProgress("journalArticle", `${w.name}：等待中…`));
		}
		let results = [];
		for (let w of watches) {
			let line = lines.get(w.id);
			if (line) line.setText(`${w.name}：檢查 PubMed 中…`);
			let r = await checkWatch(w, ctx);
			results.push(r);
			if (line) {
				line.setText(describeResult(r));
				if (r.error) line.setError();
				else line.setProgress(100);
			}
		}
		let imported = results.flatMap(r => r.imported);
		let failed = results.filter(r => r.error || r.failed.length);
		let digest = "";
		let notes = [];
		if (imported.length && cfg.digest) {
			try {
				let settings = await ZB.main.readSettings();
				digest = await writeDigest(settings, results, runtime.now());
				if (digest) notes.push(`已列在 Obsidian：${digest}`);
			}
			catch (e) {
				Zotero.logError(e);
				notes.push(`Obsidian 新文獻清單寫入失敗：${e.message || e}`);
			}
		}
		let warnings = results.flatMap(r => r.warnings.map(w => `${r.name}：${w}`));
		if (configErrors.length) warnings.unshift(...configErrors.map(e => `設定：${e}`));
		if (!ncbi.email) notes.push("建議在設定填入 Email：NCBI 要求程式附上聯絡信箱，遇到問題時才會先通知而不是直接封鎖。");

		let aiItems = imported.map(e => e.item);
		if (pw) {
			pw.addDescription(`共新匯入 ${imported.length} 篇` + (failed.length ? `，${failed.length} 個追蹤有問題（詳見 說明 → 除錯輸出記錄）` : ""));
			for (let n of [...warnings.slice(0, 5), ...notes]) pw.addDescription(n);
			if (aiItems.length && cfg.runAI) pw.addDescription("接著為新文獻產生 AI 筆記並同步…");
			pw.startCloseTimer(failed.length || warnings.length ? 20000 : 10000);
		}
		else if (imported.length || failed.length) {
			ZB.main.notify(headline, [
				...results.filter(r => r.imported.length || r.error || r.failed.length).map(describeResult),
				...notes.filter(n => !n.startsWith("建議")),
			].join("\n"));
		}
		// AI notes cost money: only after a manual check, through the normal sync (with its cost confirm)
		if (aiItems.length && cfg.runAI && !opts.auto) {
			try {
				await ZB.main.run(aiItems, { targets: ["notion", "obsidian"], ai: "missing" });
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
		return { results, digest, requests: ctx.requests };
	}

	// ---------- automatic checks ----------

	// A timer exists only while automatic checks are on; the pref observer starts and stops it
	let timer = null;
	let stopped = true;
	let prefObservers = [];

	function schedule(ms) {
		if (timer) clearTimeout(timer);
		timer = !stopped && config().autoCheck ? setTimeout(tick, ms) : null;
	}

	/** Watches whose last check is older than the interval (or that were never checked). */
	function dueWatches(now) {
		let cfg = config();
		let state = readState();
		return readWatches().watches.filter((w) => {
			if (!w.enabled) return false;
			let last = state[w.id] && Date.parse(state[w.id].lastCheck);
			return !last || now.getTime() - last >= cfg.intervalHours * 3600 * 1000;
		}).map(w => w.id);
	}

	async function tick() {
		timer = null;
		try {
			if (config().autoCheck && !checking) {
				let due = dueWatches(runtime.now());
				if (due.length) await runAll({ auto: true, only: due });
			}
		}
		catch (e) {
			Zotero.logError(e);
		}
		schedule(TICK_MS);
	}

	function init() {
		stopped = false;
		// Soon after startup, then hourly; each watch is checked when its interval has passed
		schedule(STARTUP_DELAY_MS);
		if (Zotero.Prefs.registerObserver) {
			prefObservers.push(Zotero.Prefs.registerObserver(PREF + "pubmedWatch.autoCheck", () => schedule(STARTUP_DELAY_MS), true));
		}
	}

	function shutdown() {
		stopped = true;
		if (timer) clearTimeout(timer);
		timer = null;
		for (let o of prefObservers) Zotero.Prefs.unregisterObserver(o);
		prefObservers = [];
	}

	// ---------- settings pane ----------

	/** "測試檢索式": total hits, hits in the first-check window, PubMed's reading of the query. */
	async function testQuery(rawWatch) {
		let { watch, errors } = normalizeWatch(rawWatch, 0);
		if (!watch.query) throw new Error("請先輸入 PubMed 檢索式");
		let ncbi = await ncbiSettings();
		let ctx = { ncbi, throttle: createThrottle(ncbi.apiKey ? 10 : 3, { sleep: runtime.sleep }), requests: [] };
		let term = watchTerm(watch);
		let all = parseESearch(await getJSON(esearchURL(term, { retmax: 0 }, ncbi), ctx));
		let recent = parseESearch(await getJSON(esearchURL(term, { retmax: 0, reldate: watch.days }, ncbi), ctx));
		return [
			...errors.filter(e => !/沒有名稱/.test(e)).map(e => `⚠️ ${e}`),
			`✅ 符合 ${all.count} 篇；最近 ${watch.days} 天加入 PubMed 的有 ${recent.count} 篇（第一次檢查會匯入這些，每次最多 ${config().max} 篇）`,
			all.translation ? `PubMed 解讀為：${all.translation}` : "",
			...all.warnings.map(w => `⚠️ ${w}`),
		].filter(Boolean);
	}

	function newWatchID() {
		return `w${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
	}

	function readRawWatches() {
		try {
			let list = JSON.parse(pref("pubmedWatch.watches") || "[]");
			return Array.isArray(list) ? list : [];
		}
		catch (e) {
			return [];
		}
	}

	function writeRawWatches(list) {
		Zotero.Prefs.set(PREF + "pubmedWatch.watches", JSON.stringify(list), true);
	}

	function addWatch() {
		let list = readRawWatches();
		list.push({ id: newWatchID(), name: "", query: "", collection: "", days: DEFAULT_DAYS, since: "", enabled: true });
		writeRawWatches(list);
	}

	/** The watch list in the settings pane: one block per watch, saved as you type. */
	function renderPrefs(doc) {
		let container = doc.getElementById("zb-pubmed-watches");
		if (!container) return;
		const HTML_NS = "http://www.w3.org/1999/xhtml";
		let el = (tag, attrs = {}, text) => {
			let e = doc.createElementNS(HTML_NS, tag);
			for (let [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
			if (text !== undefined) e.textContent = text;
			return e;
		};
		container.replaceChildren();
		let list = readRawWatches();
		let state = readState();
		if (!list.length) {
			container.append(el("p", { class: "zb-empty" }, "尚未設定追蹤。按「新增追蹤」加入一個 PubMed 檢索式。"));
			return;
		}
		let { errors } = parseWatches(list);
		list.forEach((w, index) => {
			if (!w.id) w.id = w.name || newWatchID();
			let save = (key, value) => {
				let all = readRawWatches();
				if (!all[index]) return;
				all[index][key] = value;
				if (!all[index].id) all[index].id = w.id;
				writeRawWatches(all);
			};
			let box = el("div", { class: "zb-watch" });
			let row = (label, input) => {
				let r = el("div", { class: "zb-watch-row" });
				r.append(el("label", {}, label), input);
				box.append(r);
				return input;
			};
			let title = el("strong", {}, w.name || "（未命名）");
			let text = (key, placeholder, tag = "input") => {
				let i = el(tag, tag === "input" ? { type: "text", placeholder } : { rows: "2", placeholder });
				i.value = w[key] === undefined ? "" : String(w[key]);
				i.addEventListener("input", () => {
					save(key, key === "days" ? i.value.trim() : i.value);
					if (key === "name") title.textContent = i.value.trim() || "（未命名）";
				});
				return i;
			};
			let enabled = el("input", { type: "checkbox" });
			enabled.checked = w.enabled !== false;
			enabled.addEventListener("change", () => save("enabled", enabled.checked));
			let head = el("div", { class: "zb-watch-head" });
			let st = state[w.id];
			head.append(enabled, title,
				el("span", { class: "zb-hint" }, st && st.lastCheck ? `上次檢查：${new Date(st.lastCheck).toLocaleString()}` : "尚未檢查"));
			box.append(head);
			row("名稱：", text("name", "例如：跌倒預防"));
			row("PubMed 檢索式：", text("query", '例如：("Accidental Falls"[Mesh]) AND nurs*[tiab]', "textarea"));
			row("存到 Zotero 分類：", text("collection", defaultCollection(w.name || "名稱")));
			row("第一次檢查回溯天數：", text("days", String(DEFAULT_DAYS)));
			row("只要出版日期在此之後（選填）：", text("since", "例如：2020 或 2023/01/01"));
			let status = el("pre", { class: "zb-status" });
			let actions = el("div", { class: "zb-watch-row" });
			let test = el("button", { type: "button" }, "測試檢索式");
			test.addEventListener("click", () => {
				status.textContent = "查詢 PubMed 中…";
				testQuery(readRawWatches()[index] || w)
					.then((lines) => { status.textContent = lines.join("\n"); })
					.catch((e) => { status.textContent = `❌ ${e.message || e}`; });
			});
			let del = el("button", { type: "button" }, "刪除");
			del.addEventListener("click", () => {
				let all = readRawWatches();
				all.splice(index, 1);
				writeRawWatches(all);
				renderPrefs(doc);
			});
			actions.append(test, del);
			box.append(actions, status);
			container.append(box);
		});
		if (errors.length) container.append(el("pre", { class: "zb-status" }, errors.map(e => `⚠️ ${e}`).join("\n")));
	}

	// ---------- menu ----------

	function registerMenus({ pluginID }) {
		let id = Zotero.MenuManager.registerMenu({
			menuID: "zotero-bridge-pubmed-watch-tools",
			pluginID,
			target: "main/menubar/tools",
			menus: [{
				menuType: "menuitem",
				l10nID: "zotero-bridge-menu-pubmed-watch",
				onCommand: () => runAll().catch(e => Zotero.logError(e)),
			}],
		});
		return [id].filter(Boolean);
	}

	return {
		NEW_TAG, WATCH_TAG_PREFIX, DEFAULT_COLLECTION_ROOT, DIGEST_FOLDER, DEFAULT_DAYS, DEFAULT_MAX, QUEUE_LIMIT, EUTILS,
		STARTUP_DELAY_MS, TICK_MS,
		defaultCollection, normalizeSince, normalizeWatch, parseWatches, watchTerm, ncbiDate, searchWindow,
		esearchURL, esummaryURL, parseESearch, parseESummary, createThrottle, planCandidates, pmidFromExtra, normalizeDOI,
		describeResult, digestLine, buildDigestNote, localDate,
		runtime, config, readWatches, readState, findExisting, ensureCollection, checkWatch, runAll, dueWatches,
		init, shutdown, testQuery, addWatch, renderPrefs, registerMenus,
		get timerActive() { return !!timer; },
	};
});
