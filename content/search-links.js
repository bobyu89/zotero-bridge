/*
 * Zotero Bridge — quick medical-literature search links (醫學文獻快速搜尋).
 *
 * A catalog of databases with a search-URL template each ({q} = the URL-encoded query). Databases
 * without a public GET search URL (Embase, JBI/Ovid, WHO ICTRP, 華藝, 博碩士論文, 國圖期刊) open
 * their start page and the query is copied to the clipboard instead. Sources that need institutional
 * access can go through the library's proxy (EZproxy `…/login?url=`). The links are used in:
 *   - the item context menu 「在醫學資料庫搜尋」 (find this paper; PubMed similar articles)
 *   - the item pane (a row of links, plus PICO search links when the AI note has PICO data)
 *   - the Obsidian/Notion literature note (a collapsed callout 「🔎 延伸搜尋」)
 *   - Tools → 醫學文獻快速搜尋… (keywords → databases; English keywords get MeSH suggestions from
 *     NCBI E-utilities through pubmed-watch.js, and the query can be saved as a PubMed watch)
 *
 *   extensions.zotero-bridge.searchLinks.order / .disabled      comma-separated source IDs
 *   extensions.zotero-bridge.searchLinks.custom                 [{ id?, name, url, needsAccess, query?, find?, lang? }]
 *   extensions.zotero-bridge.searchLinks.proxyPrefix / .proxyExclude
 *
 * Only the query ever goes into a URL. The helpers at the top are pure (Node tests); the rest needs Zotero.
 */
(function (root, factory) {
	if (typeof module === "object" && module.exports) {
		module.exports = factory(require("./pubmed-watch.js"), globalThis);
	}
	else {
		(root.ZB = root.ZB || {}).searchLinks = factory(root.ZB.pubmedWatch, root);
	}
})(this, function (pubmedWatch, scope) {
	const PREF = "extensions.zotero-bridge.";
	const TITLE = "醫學文獻快速搜尋";
	// Menu slots in the item context menu (the menu is registered once; the rest via 「更多資料庫…」)
	const MENU_SLOTS = 8;
	const PANE_COUNT = 6;
	const NOTE_FIND_COUNT = 5;
	const MAX_MESH_TAGS = 6;
	const MAX_MESH_CONCEPTS = 4;
	const MAX_TITLE = 300;
	const PICO_FIELDS = [
		{ key: "P", field: "population", label: "族群" },
		{ key: "I", field: "intervention", label: "介入" },
		{ key: "C", field: "comparison", label: "對照" },
		{ key: "O", field: "outcomes", label: "結果" },
	];
	const PICO_EN_SOURCES = ["pubmed", "cinahl", "scholar"];
	const PICO_ALL_SOURCES = ["scholar", "airiti"];

	// check: how sure the URL pattern is (README table) — "common": widely used public format;
	// "guide": the format from university library guides; "assumed": from memory, unverified;
	// "copy": no reliable GET search URL, the start page opens and the query is copied.
	// find: how "find this paper" searches here ("pubmed", "europepmc", "cinahl", "title"; false = not offered)
	// lang: "en", "zh" or "any" — Chinese queries list the "zh" sources first
	const BUILTIN = [
		{ id: "pubmed", name: "PubMed", desc: "MEDLINE 生物醫學文獻（預設 Best Match 排序）", url: "https://pubmed.ncbi.nlm.nih.gov/?term={q}", lang: "en", find: "pubmed", check: "common" },
		{ id: "pubmed-cq", name: "PubMed Clinical Queries", desc: "依臨床問題類別（治療、診斷、病因、預後）過濾的 PubMed", url: "https://pubmed.ncbi.nlm.nih.gov/clinical/?term={q}", lang: "en", check: "assumed" },
		{ id: "mesh", name: "MeSH Database", desc: "查醫學主題詞（MeSH）的定義、同義詞與樹狀結構", url: "https://www.ncbi.nlm.nih.gov/mesh/?term={q}", lang: "en", check: "common" },
		{ id: "cochrane", name: "Cochrane Library", desc: "Cochrane 系統性回顧與臨床試驗（CENTRAL）", url: "https://www.cochranelibrary.com/search?p_p_id=scolarissearchresultsportlet_WAR_scolarissearchresults&p_p_lifecycle=0&_scolarissearchresultsportlet_WAR_scolarissearchresults_searchType=basic&_scolarissearchresultsportlet_WAR_scolarissearchresults_searchBy=6&_scolarissearchresultsportlet_WAR_scolarissearchresults_searchText={q}", lang: "en", find: "title", check: "assumed" },
		{ id: "cinahl", name: "CINAHL", desc: "護理與健康相關文獻（EBSCOhost；預設 CINAHL Plus with Full Text，資料庫代碼 rzh）", url: "https://search.ebscohost.com/login.aspx?direct=true&db=rzh&bquery={q}&type=1&searchMode=And&site=ehost-live", needsAccess: true, lang: "en", find: "cinahl", check: "guide" },
		{ id: "embase", name: "Embase", desc: "Elsevier 生物醫學與藥學文獻", home: "https://www.embase.com/", needsAccess: true, lang: "en", find: "title", check: "copy" },
		{ id: "scholar", name: "Google Scholar", desc: "跨學科學術搜尋（中英文皆可）", url: "https://scholar.google.com/scholar?hl=zh-TW&q={q}", lang: "any", find: "title", check: "common" },
		{ id: "europepmc", name: "Europe PMC", desc: "PubMed 加上 PMC 全文、預印本與專利", url: "https://europepmc.org/search?query={q}", lang: "en", find: "europepmc", check: "common" },
		{ id: "semantic", name: "Semantic Scholar", desc: "AI 輔助的學術搜尋，可看引用脈絡", url: "https://www.semanticscholar.org/search?q={q}", lang: "en", find: "title", check: "common" },
		{ id: "trip", name: "TRIP Database", desc: "實證醫學資源：臨床指引、系統性回顧、證據摘要", url: "https://www.tripdatabase.com/Searchresult?criteria={q}", lang: "en", check: "assumed" },
		{ id: "jbi", name: "JBI EBP Database", desc: "JBI 證據摘要與實證護理建議（Ovid）", home: "https://ovidsp.ovid.com/ovidweb.cgi?T=JS&NEWS=N&PAGE=main&D=jbi", needsAccess: true, lang: "en", check: "copy" },
		{ id: "clinicaltrials", name: "ClinicalTrials.gov", desc: "美國 NIH 臨床試驗登錄", url: "https://clinicaltrials.gov/search?term={q}", lang: "en", check: "common" },
		{ id: "ictrp", name: "WHO ICTRP", desc: "WHO 國際臨床試驗登錄平台", home: "https://trialsearch.who.int/", lang: "en", check: "copy" },
		{ id: "uptodate", name: "UpToDate", desc: "臨床決策支援（需機構訂閱）", url: "https://www.uptodate.com/contents/search?search={q}", needsAccess: true, lang: "en", check: "assumed" },
		{ id: "airiti", name: "華藝線上圖書館", desc: "Airiti Library：臺灣與華文期刊、學位論文（全文多需機構訂閱）", home: "https://www.airitilibrary.com/", lang: "zh", find: "title", check: "copy" },
		{ id: "ndltd", name: "臺灣博碩士論文知識加值系統", desc: "國家圖書館的臺灣博碩士論文", home: "https://ndltd.ncl.edu.tw/", lang: "zh", find: "title", check: "copy" },
		{ id: "ncl-periodicals", name: "國家圖書館期刊文獻資訊網", desc: "臺灣期刊論文索引", home: "https://tpl.ncl.edu.tw/", lang: "zh", find: "title", check: "copy" },
		{ id: "guideline-pdf", name: "Google 指引 PDF", desc: "用 Google 找臨床指引 PDF（filetype:pdf）", url: "https://www.google.com/search?q={q}", query: "{q} (guideline OR 指引 OR 指南) filetype:pdf", lang: "any", check: "common" },
		{ id: "tw-gov", name: "衛福部／國健署", desc: "用 Google 站內搜尋 mohw.gov.tw、hpa.gov.tw 的指引與公告", url: "https://www.google.com/search?q={q}", query: "{q} site:mohw.gov.tw OR site:hpa.gov.tw", lang: "zh", check: "common" },
		{ id: "nice", name: "NICE", desc: "英國 NICE 臨床指引", url: "https://www.nice.org.uk/search?q={q}", lang: "en", check: "common" },
		{ id: "cdc", name: "CDC", desc: "美國疾病管制與預防中心", url: "https://search.cdc.gov/search/?query={q}", lang: "en", check: "assumed" },
	];

	const CHECK_LABELS = {
		common: "常見公開格式",
		guide: "依圖書館指南範例格式",
		assumed: "推測格式，未驗證",
		copy: "開首頁＋複製檢索詞",
	};

	// MeSH check tags and publication-type tags that say nothing about the topic
	const MESH_STOP = new Set([
		"humans", "animals", "female", "male", "adult", "aged", "aged, 80 and over", "middle aged", "young adult",
		"adolescent", "child", "child, preschool", "infant", "infant, newborn", "pregnancy", "retrospective studies",
		"prospective studies", "cross-sectional studies", "surveys and questionnaires", "treatment outcome",
		"cohort studies", "follow-up studies", "risk factors", "time factors",
	]);

	// ---------- encoding and URLs (pure) ----------

	/** encodeURIComponent plus !'()* — parentheses would end a Markdown link early. */
	function encodeQuery(q) {
		return encodeURIComponent(String(q)).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
	}

	function fillTemplate(template, q) {
		return String(template).split("{q}").join(encodeQuery(q));
	}

	function isChinese(text) {
		return /[㐀-鿿豈-﫿]/.test(String(text || ""));
	}

	function validProxy(prefix) {
		return /^https?:\/\/\S+$/i.test(String(prefix || "").trim());
	}

	/**
	 * Put a URL behind the library proxy: `…/login?url=` + URL (EZproxy's usual form), `…qurl=` + the
	 * encoded URL, or a prefix with a {url} placeholder. An empty or invalid prefix leaves the URL as is.
	 */
	function wrapProxy(url, prefix) {
		prefix = String(prefix || "").trim();
		if (!validProxy(prefix)) return url;
		if (prefix.includes("{url}")) return prefix.split("{url}").join(encodeURIComponent(url));
		if (/[?&]qurl=$/i.test(prefix)) return prefix + encodeURIComponent(url);
		return prefix + url;
	}

	// ---------- configuration (pure) ----------

	function parseIDList(text) {
		return [...new Set(String(text || "").split(/[\s,，、;；]+/).map(s => s.trim().toLowerCase()).filter(Boolean))];
	}

	function slug(name, index) {
		let s = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
		return `custom-${s || index + 1}`;
	}

	/**
	 * The custom-sources pref (JSON array) → { sources, overrides, errors }. A source with the `id` of
	 * a built-in one changes that one (e.g. another EBSCO database code for CINAHL).
	 */
	function parseCustom(text) {
		let list;
		try {
			list = typeof text === "string" ? JSON.parse(text.trim() || "[]") : (text || []);
		}
		catch (e) {
			return { sources: [], overrides: {}, errors: [`自訂資料庫不是有效的 JSON：${e.message}`] };
		}
		if (!Array.isArray(list)) return { sources: [], overrides: {}, errors: ["自訂資料庫必須是 JSON 陣列"] };
		let builtinIDs = new Set(BUILTIN.map(s => s.id));
		let sources = [];
		let overrides = {};
		let errors = [];
		list.forEach((raw, i) => {
			if (!raw || typeof raw !== "object") {
				errors.push(`自訂資料庫第 ${i + 1} 筆不是物件`);
				return;
			}
			let id = String(raw.id || "").trim().toLowerCase();
			let url = String(raw.url || "").trim();
			let name = String(raw.name || "").trim();
			let label = name || id || `第 ${i + 1} 筆`;
			if (url && !/^https?:\/\//i.test(url)) {
				errors.push(`${label}：網址必須以 http:// 或 https:// 開頭`);
				return;
			}
			let fields = {};
			if (name) fields.name = name;
			if (url) {
				if (url.includes("{q}")) {
					fields.url = url;
					fields.home = undefined;
				}
				else {
					fields.home = url;
					fields.url = undefined;
				}
			}
			if (raw.needsAccess !== undefined) fields.needsAccess = raw.needsAccess === true;
			if (raw.query !== undefined) fields.query = String(raw.query || "") || undefined;
			if (raw.desc !== undefined) fields.desc = String(raw.desc || "");
			if (raw.find !== undefined) fields.find = raw.find ? (typeof raw.find === "string" ? raw.find : "title") : false;
			if (raw.lang !== undefined) fields.lang = ["en", "zh", "any"].includes(raw.lang) ? raw.lang : "any";
			if (id && builtinIDs.has(id)) {
				overrides[id] = Object.assign(overrides[id] || {}, fields);
				return;
			}
			if (!name) {
				errors.push(`自訂資料庫第 ${i + 1} 筆沒有名稱（name）`);
				return;
			}
			if (!url) {
				errors.push(`${name}：沒有網址（url，用 {q} 代表檢索詞）`);
				return;
			}
			sources.push(Object.assign({
				id: id || slug(name, i),
				desc: "自訂資料庫",
				needsAccess: false,
				lang: isChinese(name) ? "zh" : "any",
				find: false,
				check: fields.url ? "custom" : "copy",
				custom: true,
			}, fields));
		});
		let seen = new Set(BUILTIN.map(s => s.id));
		sources = sources.filter((s) => {
			if (seen.has(s.id)) {
				errors.push(`${s.name}：ID「${s.id}」重複`);
				return false;
			}
			seen.add(s.id);
			return true;
		});
		return { sources, overrides, errors };
	}

	/**
	 * Raw pref values → the configuration: `all` (every source in order, `enabled` flag on each),
	 * `sources` (the enabled ones), proxy settings and the switches.
	 */
	function normalizeConfig(raw = {}) {
		let custom = parseCustom(raw.custom === undefined ? "[]" : raw.custom);
		let errors = custom.errors.slice();
		let base = BUILTIN.map(s => Object.assign({}, s, custom.overrides[s.id] || {}, { builtin: true }));
		let all = [...base, ...custom.sources];
		let byID = new Map(all.map(s => [s.id, s]));
		let order = parseIDList(raw.order);
		let unknown = order.filter(id => !byID.has(id));
		if (unknown.length) errors.push(`順序設定中找不到的資料庫 ID：${unknown.join(", ")}`);
		let ordered = [...order.filter(id => byID.has(id)).map(id => byID.get(id)), ...all.filter(s => !order.includes(s.id))];
		let disabled = new Set(parseIDList(raw.disabled));
		for (let s of ordered) s.enabled = !disabled.has(s.id);
		let proxyPrefix = String(raw.proxyPrefix || "").trim();
		if (proxyPrefix && !validProxy(proxyPrefix)) {
			errors.push("圖書館代理伺服器前綴必須是 http(s):// 開頭的網址（例如 https://ezproxy.example.edu.tw/login?url=），目前不會套用");
			proxyPrefix = "";
		}
		let count = Number(raw.menuCount);
		let menuCount = raw.menuCount === "" || raw.menuCount === null || raw.menuCount === undefined || !Number.isFinite(count)
			? MENU_SLOTS : Math.min(MENU_SLOTS, Math.max(1, Math.round(count)));
		return {
			all: ordered,
			sources: ordered.filter(s => s.enabled),
			errors,
			proxyPrefix,
			proxyExclude: new Set(parseIDList(raw.proxyExclude)),
			menuCount,
			paneLinks: raw.paneLinks !== false,
			noteCallout: raw.noteCallout !== false,
			picoComparison: raw.picoComparison === true,
			meshHelper: raw.meshHelper !== false,
		};
	}

	function findSource(cfg, id) {
		return cfg.sources.find(s => s.id === id) || null;
	}

	/**
	 * Where a query goes in one source: { id, name, url, copy, query, needsAccess, proxied }.
	 * `copy` = the source has no search URL: open its start page and copy `query`.
	 */
	function buildTarget(source, q, cfg = {}) {
		let query = String(q || "").trim();
		if (source.query) query = source.query.split("{q}").join(query).trim();
		let copy = !source.url;
		let url = copy ? source.home : fillTemplate(source.url, query);
		let proxied = false;
		if (source.needsAccess && cfg.proxyPrefix && !(cfg.proxyExclude && cfg.proxyExclude.has(source.id))) {
			url = wrapProxy(url, cfg.proxyPrefix);
			proxied = true;
		}
		return { id: source.id, name: source.name, desc: source.desc || "", url, copy, query, needsAccess: !!source.needsAccess, proxied };
	}

	/** Chinese queries: Chinese sources first, then the "any" ones, then the English ones; otherwise Chinese last. */
	function routeSources(sources, q) {
		let rank = isChinese(q)
			? { zh: 0, any: 1, en: 2 }
			: { en: 0, any: 0, zh: 1 };
		return sources.map((s, i) => ({ s, i, r: rank[s.lang] === undefined ? 1 : rank[s.lang] }))
			.sort((a, b) => a.r - b.r || a.i - b.i)
			.map(x => x.s);
	}

	function sourceLabel(t) {
		let notes = [];
		if (t.needsAccess) notes.push(t.proxied ? "經圖書館代理" : "需機構權限");
		if (t.copy) notes.push("開首頁＋複製檢索詞");
		return notes.length ? `${t.name}（${notes.join("，")}）` : t.name;
	}

	// ---------- items (pure) ----------

	function pmidFromExtra(extra) {
		return pubmedWatch ? pubmedWatch.pmidFromExtra(extra) : ((/^\s*PMID:\s*(\d+)\s*$/im.exec(String(extra || "")) || [])[1] || "");
	}

	function cleanDOI(doi) {
		let d = pubmedWatch ? pubmedWatch.normalizeDOI(doi) : String(doi || "").trim().toLowerCase();
		return /^10\.\S+\/\S+$/.test(d) ? d : "";
	}

	function cleanTitle(title) {
		let t = String(title || "")
			.replace(/<[^>]+>/g, "")
			.replace(/["“”„«»「」『』]/g, " ")
			.replace(/\s+/g, " ")
			.replace(/[\s.。]+$/, "")
			.trim();
		return t.length > MAX_TITLE ? t.slice(0, MAX_TITLE).replace(/\s+\S*$/, "") : t;
	}

	/** What "find this paper" uses: { title, doi, pmid, chinese } from item fields ({ title, doi/DOI, extra }). */
	function itemInfo(fields = {}) {
		let extra = fields.extra || "";
		let doi = cleanDOI(fields.doi || fields.DOI || ((/^\s*DOI:\s*(\S+)/im.exec(extra) || [])[1] || ""));
		let title = cleanTitle(fields.title);
		return { title, doi, pmid: pmidFromExtra(extra), chinese: isChinese(title) };
	}

	function quoted(s) {
		return `"${s}"`;
	}

	/** The query (or record URL) for finding one paper in a source; null when the source can't. */
	function findQuery(source, info) {
		let title = info.title;
		switch (source.find) {
			case "pubmed":
				if (info.pmid) return { url: `https://pubmed.ncbi.nlm.nih.gov/${info.pmid}/`, query: info.pmid };
				if (info.doi) return { query: `${info.doi}[doi]` };
				return title ? { query: `${quoted(title)}[ti]` } : null;
			case "europepmc":
				if (info.pmid) return { query: `EXT_ID:${info.pmid} AND SRC:MED` };
				if (info.doi) return { query: `DOI:${quoted(info.doi)}` };
				return title ? { query: `TITLE:${quoted(title)}` } : null;
			case "cinahl":
				return title ? { query: `TI ${quoted(title)}` } : null;
			case "title":
				if (title) return { query: source.url ? quoted(title) : title };
				return info.doi ? { query: info.doi } : null;
			default:
				return null;
		}
	}

	/**
	 * "Find this paper" targets for an item, in catalog order. A Chinese title is only looked up in the
	 * Chinese and multilingual sources (Chinese ones first); PubMed and the like still get the PMID.
	 */
	function itemTargets(cfg, info) {
		let out = [];
		for (let source of routeSources(cfg.sources, info.chinese ? info.title : "")) {
			if (info.chinese && source.lang === "en" && !(source.find === "pubmed" && info.pmid)) continue;
			let f = findQuery(source, info);
			if (!f) continue;
			let t = buildTarget(source, f.query, cfg);
			if (f.url) t = Object.assign(t, { url: f.url, copy: false, record: true });
			out.push(t);
		}
		// The PubMed record (known PMID) is the surest hit: always first
		return [...out.filter(t => t.record), ...out.filter(t => !t.record)];
	}

	function relatedURL(pmid) {
		return /^\d+$/.test(String(pmid || "")) ? `https://pubmed.ncbi.nlm.nih.gov/?linkname=pubmed_pubmed&from_uid=${pmid}` : "";
	}

	// ---------- MeSH tags and PICO (pure) ----------

	/** Tags that look like MeSH headings (PubMed imports add them): "*Accidental Falls/prevention & control" → "Accidental Falls". */
	function meshTerms(tags, max = MAX_MESH_TAGS) {
		let out = [];
		let seen = new Set();
		for (let tag of tags || []) {
			let t = String(tag || "").replace(/^\*/, "").split("/")[0].trim();
			if (!/^[A-Z][A-Za-z0-9 ,'()-]{2,80}$/.test(t)) continue;
			let k = t.toLowerCase();
			if (MESH_STOP.has(k) || seen.has(k)) continue;
			seen.add(k);
			out.push(t);
			if (out.length >= max) break;
		}
		return out;
	}

	function meshLookupURL(term) {
		return `https://www.ncbi.nlm.nih.gov/mesh/?term=${encodeQuery(term)}`;
	}

	/** One PICO field → its terms (split at punctuation; brackets and quotes removed). */
	function picoTerms(text) {
		let s = String(text === null || text === undefined ? "" : text).replace(/[`"“”「」『』()（）[\]【】{}]/g, " ");
		return [...new Set(s.split(/\s*(?:[、，,;；／/|]|\s(?:and|or|vs\.?|versus)\s)\s*/i)
			.map(t => t.replace(/\s+/g, " ").trim().slice(0, 60))
			.filter(t => t && !/^(?:n\/?a|null|none|未報告|不適用|無)$/i.test(t)))].slice(0, 4);
	}

	/** English phrases inside a (possibly Chinese) term: "護理師主導 fall prevention 衛教" → ["fall prevention"]. */
	function englishPhrases(term) {
		let out = [];
		for (let m of String(term).matchAll(/[A-Za-z][A-Za-z0-9'’-]*(?:\s+[A-Za-z0-9][A-Za-z0-9'’-]*)*/g)) {
			let p = m[0].trim();
			if (p.length >= 3 || /^[A-Z]{2,}$/.test(p)) out.push(p);
		}
		return out;
	}

	function enTerm(p) {
		return /[\s-]/.test(p) ? quoted(p) : p;
	}

	function block(terms) {
		return terms.length > 1 ? `(${terms.join(" OR ")})` : terms[0];
	}

	/**
	 * A PICO search string from the AI note's structured data: P AND I AND O (and C when asked).
	 * `en` uses only the English words in each field (fields without any are left out and listed in
	 * `skipped`); `all` uses the fields as written (Chinese included), for 華藝 or Google Scholar.
	 * Returns null when the note has no PICO data.
	 */
	function picoQuery(study, opts = {}) {
		if (!study) return null;
		let blocks = [];
		for (let f of PICO_FIELDS) {
			if (f.key === "C" && !opts.includeC) continue;
			let terms = picoTerms(study[f.field]);
			if (!terms.length) continue;
			let en = [...new Set(terms.flatMap(englishPhrases))].slice(0, 4);
			blocks.push({ key: f.key, label: f.label, terms, en });
		}
		if (!blocks.length) return null;
		let enBlocks = blocks.filter(b => b.en.length);
		let all = blocks.map(b => block(b.terms.map(t => (/\s/.test(t) && !isChinese(t) ? quoted(t) : t)))).join(" AND ");
		let en = enBlocks.map(b => block(b.en.map(enTerm))).join(" AND ");
		return {
			blocks,
			en,
			all,
			skipped: blocks.filter(b => !b.en.length).map(b => `${b.key}（${b.label}）`),
		};
	}

	// ---------- MeSH helper (pure parts) ----------

	/** "fall prevention, older adults" → ["fall prevention", "older adults"] (also split at AND). */
	function meshConcepts(q) {
		return [...new Set(String(q || "").split(/\s*(?:[,;，；、]|\bAND\b)\s*/)
			.map(s => s.replace(/[()"]/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean))].slice(0, MAX_MESH_CONCEPTS);
	}

	/** ESummary (db=mesh) JSON → [{ uid, ui, heading, scopeNote }] for descriptors (ui D…). */
	function parseMeshSummary(json) {
		if (json && json.error) throw new Error(`MeSH：${json.error}`);
		let r = json && json.result;
		if (!r) throw new Error("MeSH 回傳的資料無法辨識");
		let out = [];
		let seen = new Set();
		for (let uid of r.uids || []) {
			let d = r[uid];
			if (!d || d.error) continue;
			let ui = String(d.ds_meshui || "");
			let heading = String((d.ds_meshterms || [])[0] || "").trim();
			if (!heading || (ui && !/^D\d+/.test(ui)) || seen.has(heading.toLowerCase())) continue;
			seen.add(heading.toLowerCase());
			out.push({ uid: String(uid), ui, heading, scopeNote: String(d.ds_scopenote || "").trim() });
		}
		return out;
	}

	function tiab(concept) {
		let c = String(concept).trim();
		return /\s/.test(c) ? `${quoted(c)}[tiab]` : `${c}[tiab]`;
	}

	/** [{ concept, headings }] → ("Heading"[Mesh] OR concept[tiab]) AND (…) */
	function buildMeshQuery(blocks) {
		return (blocks || []).filter(b => b.concept).map((b) => {
			let parts = [...(b.headings || []).map(h => `${quoted(h.heading || h)}[Mesh]`), tiab(b.concept)];
			return `(${parts.join(" OR ")})`;
		}).join(" AND ");
	}

	// ---------- Tools menu entries (pure) ----------

	/**
	 * The quick-search list: [{ kind: "open"|"copy"|"watch", label, target?, text?, query? }].
	 * With a MeSH query, PubMed with that query comes first, then copy / save-as-watch entries.
	 */
	function quickEntries(cfg, q, mesh) {
		let entries = [];
		let pubmed = findSource(cfg, "pubmed");
		let meshQuery = mesh && mesh.query;
		if (meshQuery && pubmed) {
			entries.push({ kind: "open", label: `PubMed（MeSH 檢索式）：${meshQuery.length > 90 ? meshQuery.slice(0, 89) + "…" : meshQuery}`, target: buildTarget(pubmed, meshQuery, cfg) });
		}
		for (let s of routeSources(cfg.sources, q)) {
			let t = buildTarget(s, q, cfg);
			entries.push({ kind: "open", label: sourceLabel(t), target: t });
		}
		if (meshQuery) entries.push({ kind: "copy", label: "📋 複製 PubMed 檢索式（MeSH）", text: meshQuery });
		if (pubmedWatch && !isChinese(q)) {
			entries.push({ kind: "watch", label: "💾 存成 PubMed 新文獻追蹤…", query: meshQuery || q });
		}
		return entries;
	}

	// ---------- Obsidian / Notion callout (pure) ----------

	function linkText(s) {
		return String(s).replace(/[[\]]/g, " ").replace(/\s+/g, " ").trim();
	}

	function mdLink(text, url) {
		return `[${linkText(text)}](${url})`;
	}

	function codeSpan(s) {
		return "`" + String(s).replace(/`/g, "'") + "`";
	}

	/**
	 * The collapsed callout 「🔎 延伸搜尋」 for the managed region of a literature note: links to find
	 * this paper, PubMed similar articles, MeSH links for MeSH-like tags, and the PICO search string
	 * (text to copy + links). Copy-only sources are left out (a note can't copy). "" when turned off
	 * or when there is nothing to link. Notion shows it as a quote whose links stay links.
	 * @param {object} data item data ({ title, doi, extra, tags })
	 * @param {object} study the AI note's structured data (PICO fields) or null
	 */
	function noteCallout(data, study, cfg) {
		if (!cfg || !cfg.noteCallout) return "";
		let info = itemInfo(data || {});
		let rows = [];
		let find = itemTargets(cfg, info).filter(t => !t.copy).slice(0, NOTE_FIND_COUNT);
		if (find.length) rows.push(`**找這篇**：${find.map(t => mdLink(t.name, t.url)).join(" · ")}`);
		if (info.pmid && findSource(cfg, "pubmed")) rows.push(`**相似文獻**：${mdLink("PubMed Similar articles", relatedURL(info.pmid))}`);
		let pubmed = findSource(cfg, "pubmed");
		let mesh = meshTerms((data && data.tags) || []);
		if (mesh.length) {
			rows.push("**MeSH**：" + mesh.map((m) => {
				let more = pubmed ? `（${mdLink("PubMed", buildTarget(pubmed, `${quoted(m)}[Mesh]`, cfg).url)}）` : "";
				return mdLink(m, meshLookupURL(m)) + more;
			}).join(" · "));
		}
		let pico = picoQuery(study, { includeC: cfg.picoComparison });
		if (pico) {
			let links = (ids, query) => ids.map(id => findSource(cfg, id)).filter(Boolean)
				.map(s => buildTarget(s, query, cfg)).filter(t => !t.copy)
				.map(t => mdLink(t.name, t.url)).join(" · ");
			if (pico.en) {
				rows.push(`**PICO 檢索式**：${codeSpan(pico.en)}`);
				let l = links(PICO_EN_SOURCES, pico.en);
				if (l) rows.push(`↳ ${l}`);
				if (pico.skipped.length) rows.push(`*${pico.skipped.join("、")} 沒有英文詞彙，未列入；可用 工具 → 醫學文獻快速搜尋… 查 MeSH*`);
			}
			if (pico.all !== pico.en) {
				rows.push(`**PICO（原文詞彙）**：${codeSpan(pico.all)}`);
				let l = links(PICO_ALL_SOURCES, pico.all);
				if (l) rows.push(`↳ ${l}`);
			}
		}
		if (!rows.length) return "";
		return "> [!search]- 🔎 延伸搜尋\n" + rows.map(r => `> ${r}`).join("  \n");
	}

	/** Settings pane: one line per source. */
	function describeSources(cfg) {
		let lines = cfg.all.map((s) => {
			let flags = [s.enabled ? "" : "已隱藏", s.needsAccess ? "需機構權限" : "", s.custom ? "自訂" : CHECK_LABELS[s.check] || ""].filter(Boolean);
			return `${s.id}｜${s.name}${flags.length ? `（${flags.join("，")}）` : ""}`;
		});
		return [...cfg.errors.map(e => `⚠️ ${e}`), ...lines];
	}

	// ---------- Zotero ----------

	let runtime = {
		launch: url => Zotero.launchURL(url),
		copy: text => Zotero.Utilities.Internal.copyTextToClipboard(text),
	};

	function pref(key) {
		return Zotero.Prefs.get(PREF + key, true);
	}

	function readConfig() {
		return normalizeConfig({
			order: pref("searchLinks.order"),
			disabled: pref("searchLinks.disabled"),
			custom: pref("searchLinks.custom"),
			proxyPrefix: pref("searchLinks.proxyPrefix"),
			proxyExclude: pref("searchLinks.proxyExclude"),
			menuCount: pref("searchLinks.menuCount"),
			paneLinks: pref("searchLinks.paneLinks"),
			noteCallout: pref("searchLinks.noteCallout"),
			picoComparison: pref("searchLinks.picoComparison"),
			meshHelper: pref("searchLinks.meshHelper"),
		});
	}

	function field(item, name) {
		try {
			return item.getField(name, false, true) || "";
		}
		catch (e) {
			return "";
		}
	}

	function infoForItem(item) {
		return itemInfo({ title: field(item, "title"), doi: field(item, "DOI"), extra: field(item, "extra") });
	}

	function notify(text) {
		scope.ZB.main.notify(`Zotero Bridge：${TITLE}`, text);
	}

	/** Open a target; copy-only sources first copy the query to the clipboard. */
	function openTarget(t) {
		if (t.copy && t.query) {
			try {
				runtime.copy(t.query);
				notify(`${t.name} 沒有可直接帶入檢索詞的網址：已複製「${t.query}」，請在開啟的頁面貼上（Ctrl+V／⌘V）。`);
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
		runtime.launch(t.url);
	}

	/** For the Obsidian/Notion note (main.js); never throws. */
	function calloutFor(data, study) {
		try {
			return noteCallout(data, study, readConfig());
		}
		catch (e) {
			Zotero.logError(e);
			return "";
		}
	}

	function aiStudy(item) {
		try {
			let note = scope.ZB.adapter.getAINote(item);
			return note ? scope.ZB.main.readAINote(note.getNote()).data : null;
		}
		catch (e) {
			Zotero.logError(e);
			return null;
		}
	}

	/** Item pane: a row of search links for the item, and PICO search links when the AI note has PICO. */
	function renderPaneRow(doc, body, item) {
		if (!item || !item.isRegularItem || !item.isRegularItem()) return;
		let cfg;
		try {
			cfg = readConfig();
		}
		catch (e) {
			Zotero.logError(e);
			return;
		}
		if (!cfg.paneLinks) return;
		let info = infoForItem(item);
		let targets = itemTargets(cfg, info).slice(0, PANE_COUNT);
		if (info.pmid && findSource(cfg, "pubmed")) {
			targets.push({ id: "related", name: "相似文獻", desc: "PubMed Similar articles", url: relatedURL(info.pmid), copy: false });
		}
		let pico = picoQuery(aiStudy(item), { includeC: cfg.picoComparison });
		if (!targets.length && !pico) return;
		let row = (label) => {
			let r = doc.createElement("div");
			r.setAttribute("style", "display: flex; flex-wrap: wrap; align-items: center; gap: 2px 6px; margin: 2px 0 6px;");
			let l = doc.createElement("span");
			l.textContent = label;
			r.append(l);
			return r;
		};
		let link = (t) => {
			let a = doc.createElement("a");
			a.textContent = t.name;
			a.setAttribute("href", t.url);
			a.setAttribute("title", [t.desc, t.copy ? `開啟首頁並複製「${t.query}」` : t.query].filter(Boolean).join("\n"));
			a.setAttribute("style", "cursor: pointer;");
			a.dataset.source = t.id;
			a.addEventListener("click", (ev) => {
				ev.preventDefault();
				openTarget(t);
			});
			return a;
		};
		if (targets.length) {
			let r = row("🔎 搜尋：");
			for (let t of targets) r.append(link(t));
			body.append(r);
		}
		if (pico) {
			let query = pico.en || pico.all;
			let ids = pico.en ? PICO_EN_SOURCES : PICO_ALL_SOURCES;
			let r = row(pico.en ? "PICO：" : "PICO（原文詞彙）：");
			for (let s of ids.map(id => findSource(cfg, id)).filter(Boolean)) r.append(link(buildTarget(s, query, cfg)));
			let b = doc.createElement("button");
			b.textContent = "複製檢索式";
			b.title = query;
			b.setAttribute("style", "padding: 0 6px;");
			b.addEventListener("click", () => {
				try {
					runtime.copy(query);
				}
				catch (e) {
					Zotero.logError(e);
				}
			});
			r.append(b);
			body.append(r);
		}
	}

	/** Pick from a list until the user cancels; `entries` are { label, run }. */
	async function pickLoop(text, entries) {
		let win = Zotero.getMainWindow();
		let picked = [];
		for (;;) {
			let sel = { value: 0 };
			if (!Services.prompt.select(win, TITLE, text, entries.map(e => e.label), sel)) break;
			let entry = entries[sel.value];
			if (!entry) break;
			picked.push(entry.label);
			await entry.run();
		}
		return picked;
	}

	/** Context menu 「更多資料庫…」: every source that can look for this paper. */
	function showMore(item) {
		let cfg = readConfig();
		let info = infoForItem(item);
		let entries = itemTargets(cfg, info).map(t => ({ label: sourceLabel(t), run: () => openTarget(t) }));
		if (info.pmid && findSource(cfg, "pubmed")) {
			entries.push({ label: "PubMed 相似文獻", run: () => runtime.launch(relatedURL(info.pmid)) });
		}
		if (!entries.length) {
			notify("這篇文獻沒有標題、DOI 或 PMID，無法搜尋。");
			return Promise.resolve([]);
		}
		return pickLoop(`在醫學資料庫搜尋：${info.title || info.doi || info.pmid}\n選一個開啟；開啟後會回到這個清單，按取消結束。`, entries);
	}

	/** MeSH suggestions for English keywords, through pubmed-watch.js's NCBI client (throttled, email/API key). */
	async function suggestMesh(q, opts = {}) {
		let pw = pubmedWatch;
		let ncbi = opts.ncbi || await pw.ncbiSettings();
		let ctx = { throttle: pw.createThrottle(ncbi.apiKey ? 10 : 3, { sleep: pw.runtime.sleep }), requests: [] };
		let blocks = [];
		for (let concept of meshConcepts(q)) {
			let search = pw.parseESearch(await pw.getJSON(pw.eutilsURL("esearch", { db: "mesh", term: concept, retmode: "json", retmax: 5 }, ncbi), ctx));
			let headings = search.ids.length
				? parseMeshSummary(await pw.getJSON(pw.eutilsURL("esummary", { db: "mesh", id: search.ids.join(","), retmode: "json" }, ncbi), ctx)).slice(0, 3)
				: [];
			blocks.push({ concept, headings });
		}
		return { blocks, query: buildMeshQuery(blocks), requests: ctx.requests };
	}

	function describeMesh(mesh) {
		return mesh.blocks.map(b => `${b.concept} → ${b.headings.length ? b.headings.map(h => h.heading).join("、") : "（沒有對應的 MeSH，只用關鍵字）"}`).join("\n");
	}

	async function saveWatch(query, q) {
		let win = Zotero.getMainWindow();
		let name = { value: String(q).slice(0, 40) };
		if (!Services.prompt.prompt(win, TITLE, `PubMed 檢索式：\n${query}\n\n追蹤名稱（會成為標籤「追蹤/名稱」）：`, name, null, { value: false })) return null;
		let watchName = String(name.value || "").trim();
		if (!watchName) return null;
		scope.ZB.pubmedWatch.addWatch({ name: watchName, query });
		notify(`已新增 PubMed 追蹤「${watchName}」。到 設定 → Zotero Bridge → PubMed 新文獻追蹤 可以測試或調整；工具 → 檢查新文獻（PubMed 追蹤）立即匯入。`);
		return watchName;
	}

	/** Tools → 醫學文獻快速搜尋…: keywords → (MeSH suggestions) → pick databases to open. */
	async function quickSearch() {
		let win = Zotero.getMainWindow();
		let input = { value: "" };
		if (!Services.prompt.prompt(win, TITLE, "輸入關鍵字（中文或英文；不同概念用逗號分隔，例如：fall prevention, older adults）：", input, null, { value: false })) return null;
		let q = String(input.value || "").replace(/\s+/g, " ").trim();
		if (!q) return null;
		let cfg = readConfig();
		let chinese = isChinese(q);
		let mesh = null;
		let lines = [];
		if (!chinese && cfg.meshHelper) {
			try {
				mesh = await suggestMesh(q);
				lines.push(`MeSH 建議：\n${describeMesh(mesh)}`);
			}
			catch (e) {
				Zotero.logError(e);
				lines.push(`MeSH 查詢失敗（${e.message || e}），改用原本的關鍵字。`);
			}
		}
		if (chinese) lines.push("中文關鍵字：中文資料庫排在前面；英文資料庫建議改用英文關鍵字。");
		lines.push("選一個開啟；開啟後會回到這個清單，按取消結束。");
		let entries = quickEntries(cfg, q, mesh).map(e => Object.assign(e, {
			run: async () => {
				if (e.kind === "open") openTarget(e.target);
				else if (e.kind === "copy") runtime.copy(e.text);
				else if (e.kind === "watch") await saveWatch(e.query, q);
			},
		}));
		let picked = await pickLoop(lines.join("\n\n"), entries);
		return { query: q, mesh, picked };
	}

	function contextItem(context) {
		return ((context && context.items) || []).find(i => i && i.isRegularItem && i.isRegularItem()) || null;
	}

	/** Item context menu 「在醫學資料庫搜尋」 and Tools → 醫學文獻快速搜尋…; returns the menu IDs. */
	function registerMenus({ pluginID, icon }) {
		let targetsFor = (context) => {
			let item = contextItem(context);
			if (!item) return { cfg: null, targets: [], info: null };
			let cfg = readConfig();
			let info = infoForItem(item);
			return { cfg, info, targets: itemTargets(cfg, info) };
		};
		let slots = Array.from({ length: MENU_SLOTS }, (_, i) => ({
			menuType: "menuitem",
			l10nID: "zotero-bridge-search-db",
			onShowing: (ev, context) => {
				let { cfg, targets } = targetsFor(context);
				let t = cfg && i < cfg.menuCount ? targets[i] : null;
				context.setVisible(!!t);
				if (t) context.setL10nArgs(JSON.stringify({ name: t.copy ? `${t.name}（複製標題）` : t.name }));
			},
			onCommand: (ev, context) => {
				let { targets } = targetsFor(context);
				if (targets[i]) openTarget(targets[i]);
			},
		}));
		let ids = [];
		ids.push(Zotero.MenuManager.registerMenu({
			menuID: "zotero-bridge-search-item",
			pluginID,
			target: "main/library/item",
			menus: [{
				menuType: "submenu",
				l10nID: "zotero-bridge-search-menu",
				icon,
				onShowing: (ev, context) => context.setVisible(!!contextItem(context)),
				menus: [
					...slots,
					{
						menuType: "menuitem",
						l10nID: "zotero-bridge-search-related",
						onShowing: (ev, context) => {
							let { cfg, info } = targetsFor(context);
							context.setVisible(!!(info && info.pmid && findSource(cfg, "pubmed")));
						},
						onCommand: (ev, context) => {
							let { info } = targetsFor(context);
							if (info && info.pmid) runtime.launch(relatedURL(info.pmid));
						},
					},
					{ menuType: "separator" },
					{
						menuType: "menuitem",
						l10nID: "zotero-bridge-search-more",
						onCommand: (ev, context) => {
							let item = contextItem(context);
							if (item) showMore(item).catch(e => Zotero.logError(e));
						},
					},
				],
			}],
		}));
		ids.push(Zotero.MenuManager.registerMenu({
			menuID: "zotero-bridge-search-tools",
			pluginID,
			target: "main/menubar/tools",
			menus: [{
				menuType: "menuitem",
				l10nID: "zotero-bridge-search-tools",
				onCommand: () => quickSearch().catch(e => Zotero.logError(e)),
			}],
		}));
		return ids.filter(Boolean);
	}

	return {
		BUILTIN, CHECK_LABELS, MENU_SLOTS, PANE_COUNT, PICO_FIELDS,
		encodeQuery, fillTemplate, isChinese, wrapProxy, validProxy, parseIDList, parseCustom, normalizeConfig, findSource,
		buildTarget, routeSources, sourceLabel, itemInfo, cleanTitle, findQuery, itemTargets, relatedURL,
		meshTerms, meshLookupURL, picoTerms, englishPhrases, picoQuery, meshConcepts, parseMeshSummary, buildMeshQuery,
		quickEntries, noteCallout, describeSources,
		runtime, readConfig, openTarget, calloutFor, renderPaneRow, showMore, suggestMesh, quickSearch, registerMenus,
	};
});
