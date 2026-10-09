/*
 * ZotMax — Chinese-language references in Chinese APA 7, as Taiwanese nursing journals
 * and theses write them:
 *
 *   陳美玲、林小華（2023）。題目。*護理雜誌，70*(2)，45–56。https://doi.org/10.6224/JN...
 *   陳美玲（2020）。*題目*〔未出版之碩士論文〕。國防醫學院。
 *   in-text: (陳美玲，2023) (陳美玲、林小華，2023) (陳美玲等，2023)
 *
 * Full names without separators, 「、」 between authors (no "&"), 「等」 instead of "et al.",
 * full-width （年）, 「。」 between parts (「．」 in the 台灣護理學會 journal style), journal name
 * and volume in italics, issue in half-width parentheses. 21 or more authors: the first 19,
 * 「…」 and the last. Zotero's item data is never changed.
 *
 * Pure functions (Node tests require this file); the options come from the Zotero prefs when
 * running inside Zotero. Loaded first by bootstrap.js: core.js, synthesis.js and export.js use it.
 */
(function (root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) {
		module.exports = api;
	}
	else {
		(root.ZB = root.ZB || {}).apaZh = api;
	}
})(this, function () {
	const PREF = "extensions.zotero-bridge.apaZh.";
	const DEFAULTS = {
		// Chinese APA for Chinese-language items (notes, Notion, synthesis, references.json names)
		enabled: true,
		// "thesis": 「。」 between parts (most university APA 7 guides);
		// "twna": 「．」 between parts, 「。」 at the end (台灣護理學會 APA 7 快速指引)
		style: "thesis",
		// Plugin-generated reference lists: Chinese references (by stroke count) before English ones
		chineseFirst: true,
	};

	const HAN_RE = /\p{Script=Han}/u;
	const KANA_HANGUL_RE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
	const LATIN_RE = /\p{Script=Latin}/u;
	// A personal or corporate name written only in Han characters (· ‧ ・ in transliterated names)
	const HAN_NAME_RE = /^[\p{Script=Han}·‧・]+$/u;
	const ZH_LANG_RE = /^(?:zh|chi|zho|cmn)(?:$|[-_])|chinese|中文|華語|华语|漢語|汉语|國語|国语/i;
	const TERMINAL_RE = /[。．.？！?!]$/;

	// Compound surnames (traditional and simplified), longest match first
	const COMPOUND_SURNAMES = [
		"歐陽", "司馬", "諸葛", "上官", "東方", "皇甫", "尉遲", "公孫", "慕容", "長孫", "宇文", "司徒",
		"夏侯", "軒轅", "令狐", "鍾離", "端木", "張簡", "范姜", "張廖",
		"欧阳", "诸葛", "东方", "尉迟", "公孙", "长孙", "轩辕", "钟离", "张简", "张廖",
	];
	// Common single-character surnames in Taiwan (plus simplified forms), for spotting names that
	// were split in Western order ("陳 美玲" → firstName 陳, lastName 美玲)
	const SURNAMES = new Set(Array.from(
		"陳林黃張李王吳劉蔡楊許鄭謝郭洪曾邱廖賴周徐蘇葉莊呂江何蕭羅高簡朱鍾施游詹沈彭胡余盧潘顏梁趙柯翁魏"
		+ "方孫戴范宋鄧杜侯曹薛傅丁溫紀蔣歐藍連唐馬董石卓程姚康馮古姜湯汪白田涂鄒巫尤鐘龔嚴韓黎阮袁童陸金錢邵"
		+ "陈黄张刘杨许郑谢赖苏叶庄吕萧罗钟卢颜赵孙邓温纪蒋欧蓝连冯汤邹龚严韩陆钱"
	));

	function options(over) {
		let o = Object.assign({}, DEFAULTS);
		if (typeof Zotero !== "undefined" && Zotero.Prefs) {
			for (let key of Object.keys(DEFAULTS)) {
				let v = Zotero.Prefs.get(PREF + key, true);
				if (v !== undefined && v !== null && v !== "") o[key] = v;
			}
		}
		return Object.assign(o, over);
	}

	// ---------- detection ----------

	function isChineseText(s) {
		s = String(s || "");
		return HAN_RE.test(s) && !KANA_HANGUL_RE.test(s);
	}

	function isSurname(s) {
		return SURNAMES.has(s) || COMPOUND_SURNAMES.includes(s);
	}

	// "陳美玲(Chen, Mei-Ling)" → "陳美玲"; "陳 美玲" → "陳美玲"
	function cleanNamePart(s) {
		return String(s || "")
			.replace(/\s*[(（][^)）]*[)）]\s*/g, (all, i, str) => (HAN_RE.test(str.slice(0, i)) ? "" : all))
			.replace(/(\p{Script=Han})\s+(?=\p{Script=Han})/gu, "$1")
			.trim();
	}

	/**
	 * The full name of a creator written in Han characters ("陳美玲"), or "" for other names.
	 * Handles a single-field name ({ name }), the usual split (lastName 陳, firstName 美玲) and a
	 * name split in Western order (firstName 陳, lastName 美玲).
	 */
	function zhPersonName(c) {
		if (!c) return "";
		if (c.name !== undefined || c.literal !== undefined) {
			let name = cleanNamePart(c.name !== undefined ? c.name : c.literal);
			return HAN_NAME_RE.test(name) ? name : "";
		}
		let last = cleanNamePart(c.lastName !== undefined ? c.lastName : c.family);
		let first = cleanNamePart(c.firstName !== undefined ? c.firstName : c.given);
		let full = last + first;
		if (!full || !HAN_NAME_RE.test(full)) return "";
		if (last && first && isSurname(first) && !isSurname(last) && !SURNAMES.has(last[0])
			&& !COMPOUND_SURNAMES.some(s => last.startsWith(s))) {
			return first + last;
		}
		return full;
	}

	/**
	 * Is this a Chinese-language item? The title decides: Han characters (and no kana/hangul) →
	 * Chinese; a Latin-script title → not Chinese even when the language field says "zh" (the
	 * Airiti translator marks every item "zh"). Without a title: the authors' names, then the
	 * language field (zh, zh-TW, 中文, Chinese…).
	 * @param {object} data { title, creators, language, publication }
	 */
	function isChineseItem(data) {
		if (!data) return false;
		let title = String(data.title || "");
		if (HAN_RE.test(title)) return !KANA_HANGUL_RE.test(title);
		if (LATIN_RE.test(title)) return false;
		let creators = data.creators || [];
		if (creators.length) return creators.some(c => !!zhPersonName(c));
		return ZH_LANG_RE.test(String(data.language || "").trim()) || isChineseText(data.publication);
	}

	// ---------- pieces ----------

	function initials(given) {
		return String(given || "").trim().split(/\s+/).filter(Boolean)
			.map(part => part.split("-").map(p => (p ? p[0].toUpperCase() + "." : "")).join("-"))
			.join(" ");
	}

	// Display name of one creator in a Chinese reference
	function referenceName(c) {
		let zh = zhPersonName(c);
		if (zh) return zh;
		if (c.name) return c.name;
		let given = initials(c.firstName);
		return [c.lastName, given].filter(Boolean).join(", ");
	}

	function displayNames(creators) {
		return creators.map(referenceName).filter(Boolean);
	}

	// 陳美玲、林小華、…、王大明 (APA 7: 21 or more authors → the first 19, an ellipsis and the last)
	function joinAuthors(names) {
		if (names.length >= 21) names = [...names.slice(0, 19), "…", names[names.length - 1]];
		return names.join("、");
	}

	function yearOf(data) {
		let m = /\d{4}/.exec(String(data.year || "")) || /\d{4}/.exec(String(data.date || ""));
		return m ? m[0] : "";
	}

	function pageRange(pages) {
		return String(pages || "").trim().replace(/\s*[-‐‑‒–—~～]+\s*/g, "–");
	}

	function bareDOI(doi) {
		return String(doi || "").trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, "");
	}

	// DOI field, else a "DOI: …" line in Extra (Airiti thesis records keep it there)
	function doiOf(data) {
		let doi = bareDOI(data.doi);
		if (!doi) {
			let m = /^\s*DOI:\s*(\S+)/im.exec(String(data.extra || ""));
			if (m) doi = bareDOI(m[1]);
		}
		return doi ? `https://doi.org/${doi}` : "";
	}

	const DATABASES = [
		{ re: /airiti/i, name: "華藝線上圖書館" },
		{ re: /ndltd\.ncl\.edu\.tw|hdl\.handle\.net\/11296\/|臺灣博碩士|台灣博碩士/i, name: "臺灣博碩士論文知識加值系統" },
	];

	function databaseOf(data) {
		let hay = `${data.url || ""} ${data.libraryCatalog || ""}`;
		let db = DATABASES.find(d => d.re.test(hay));
		return db ? db.name : "";
	}

	function degreeOf(type) {
		let t = String(type || "");
		if (/博士|doctor|dissertation|ph\.?\s*d/i.test(t)) return "博士";
		if (/碩士|master/i.test(t)) return "碩士";
		return "學位";
	}

	function editionOf(edition) {
		let e = String(edition || "").trim();
		if (!e) return "";
		let n = /^(\d+)(?:st|nd|rd|th)?(?:\s*(?:ed\.?|edition))?$/i.exec(e);
		if (n) return n[1] === "1" ? "" : `（第${n[1]}版）`;
		return `（${e.replace(/^[（(]|[)）]$/g, "")}）`;
	}

	// ---------- references ----------

	/**
	 * A Chinese APA 7 reference.
	 * @param {object} data extractItemData() fields, plus optional thesisType, edition, extra, libraryCatalog
	 * @param {object} [opts] { format: "text" | "markdown", style: "thesis" | "twna" }
	 */
	function formatReference(data, opts = {}) {
		let o = options(opts);
		let md = o.format === "markdown";
		let sep = o.style === "twna" ? "．" : "。";
		// No backslash escapes (the Notion converter in markdown.js has none): a text that
		// contains * or _ is left upright rather than breaking the emphasis
		let esc = s => String(s);
		let ital = s => (s ? (md && !/[*_]/.test(s) ? `*${s}*` : String(s)) : "");
		let plain = s => (s ? String(s) : "");

		let type = data.itemType || "";
		let creators = data.creators || [];
		let authors = creators.filter(c => c.creatorType === "author");
		let editors = creators.filter(c => c.creatorType === "editor");
		let editorsAsAuthors = false;
		if (!authors.length && editors.length && type !== "bookSection" && type !== "conferencePaper") {
			authors = editors;
			editorsAsAuthors = true;
		}
		if (!authors.length) {
			authors = creators.filter(c => !["editor", "translator", "seriesEditor", "reviewedAuthor", "bookAuthor"].includes(c.creatorType));
		}
		let year = yearOf(data) || "無日期";
		let title = String(data.title || "").trim();
		let doi = doiOf(data);
		let url = String(data.url || "").trim();
		let pages = pageRange(data.pages);
		let publisher = String(data.publisher || "").trim();
		let publication = String(data.publication || "").trim();

		let titleEl;
		let els = [];
		let link = "";
		switch (type) {
			case "journalArticle": {
				titleEl = plain(title);
				let vol = String(data.volume || "").trim();
				let issue = String(data.issue || "").trim();
				let src = vol ? ital(`${publication}，${vol}`) + (issue ? `(${esc(issue)})` : "")
					: ital(publication) + (issue ? `，${esc(issue)}` : "");
				if (pages) src += `，${esc(pages)}`;
				if (publication || vol) els.push(src);
				link = doi;
				break;
			}
			case "book": {
				titleEl = ital(title) + editionOf(data.edition);
				if (publisher) els.push(plain(publisher));
				link = doi;
				break;
			}
			case "bookSection":
			case "conferencePaper": {
				titleEl = plain(title);
				let eds = joinAuthors(displayNames(editors));
				let inBook = publication ? ital(publication) + (pages ? `（頁 ${esc(pages)}）` : "") : "";
				if (eds || inBook) els.push(`載於${eds ? `${plain(eds)}（主編），` : ""}${inBook}`);
				if (publisher) els.push(plain(publisher));
				link = doi || (type === "conferencePaper" ? url : "");
				break;
			}
			case "thesis": {
				let degree = degreeOf(data.thesisType);
				let db = databaseOf(data);
				link = doi || url;
				if (link || db) {
					titleEl = ital(title) + `〔${degree}論文${publisher ? `，${plain(publisher)}` : ""}〕`;
					if (db) els.push(db);
				}
				else {
					titleEl = ital(title) + `〔未出版之${degree}論文〕`;
					if (publisher) els.push(plain(publisher));
				}
				break;
			}
			case "magazineArticle":
			case "newspaperArticle":
			case "encyclopediaArticle":
			case "dictionaryEntry":
			case "blogPost":
			case "forumPost": {
				titleEl = plain(title);
				if (publication) els.push(ital(publication) + (pages ? `，${esc(pages)}` : ""));
				link = doi || url;
				break;
			}
			default: {
				// Stand-alone works: reports, web pages, documents, datasets…
				titleEl = ital(title);
				let source = publication || publisher;
				// APA: the site or publisher is left out when it is the author
				if (source && !authors.some(c => referenceName(c) === source)) els.push(plain(source));
				link = doi || url;
			}
		}

		let names = joinAuthors(displayNames(authors));
		let head;
		if (names) {
			head = `${plain(names)}${editorsAsAuthors ? "（主編）" : ""}（${year}）`;
		}
		else {
			// No author: the title moves to the author position
			head = `${titleEl}（${year}）`;
			titleEl = "";
		}
		let parts = [head, titleEl, ...els].filter(Boolean);
		let out = "";
		parts.forEach((p, i) => {
			let last = i === parts.length - 1;
			let bare = p.replace(/[*_]+$/, "");
			out += p + (TERMINAL_RE.test(bare) ? "" : (last ? "。" : sep));
		});
		return out + link;
	}

	// ---------- in-text ----------

	/** In-text author/year: 陳美玲，2023 / 陳美玲、林小華，2023 / 陳美玲等，2023 */
	function shortCitation(data) {
		let creators = data.creators || [];
		let authors = creators.filter(c => c.creatorType === "author");
		if (!authors.length) authors = creators.filter(c => c.creatorType === "editor");
		if (!authors.length) authors = creators;
		let names = displayNames(authors);
		let who;
		if (!names.length) {
			let t = Array.from(String(data.title || "無題名").trim());
			who = t.length > 12 ? t.slice(0, 12).join("") + "…" : t.join("");
		}
		else if (names.length === 1) who = names[0];
		else if (names.length === 2) who = `${names[0]}、${names[1]}`;
		else who = `${names[0]}等`;
		return `${who}，${yearOf(data) || "無日期"}`;
	}

	// ---------- reference lists ----------

	let zhCollator = null;
	function compareZh(a, b) {
		// zh-TW sorts by stroke count in ICU (Firefox and Node)
		if (!zhCollator) zhCollator = new Intl.Collator("zh-TW");
		return zhCollator.compare(a, b);
	}

	const sortKey = s => String(s).replace(/[*\\]/g, "");

	/**
	 * Sort a reference list. Chinese first (by stroke count), then the rest alphabetically when
	 * `chineseFirst`; otherwise everything alphabetically as before.
	 * @param {string[]} refs formatted references
	 * @param {object[]} datas the item data of each reference (same order)
	 */
	function sortReferences(refs, datas, opts) {
		let o = options(opts);
		let en = (a, b) => sortKey(a).localeCompare(sortKey(b), "en");
		if (!o.chineseFirst) return refs.slice().sort(en);
		let zh = [];
		let other = [];
		refs.forEach((r, i) => (isChineseItem(datas[i]) ? zh : other).push(r));
		return [...zh.sort((a, b) => compareZh(sortKey(a), sortKey(b))), ...other.sort(en)];
	}

	// ---------- CSL JSON (references.json) ----------

	const isNameObject = v => v && typeof v === "object" && !Array.isArray(v)
		&& ("family" in v || "given" in v || "literal" in v);

	/**
	 * Chinese names in a CSL JSON item become `literal` full names ({ literal: "陳美玲" }), so
	 * citeproc never shortens them to the surname: with family/given, APA styles cite
	 * "(陳, 2023)" in the text; a literal name gives "(陳美玲, 2023)" and "陳美玲" in the list.
	 * Chinese items without a specific language get `language: "zh-TW"`.
	 * Returns a new object; the input (Zotero's cached CSL) is not changed.
	 */
	function adjustCSL(entry, opts) {
		if (!entry || !options(opts).enabled) return entry;
		let out = Object.assign({}, entry);
		let allNames = [];
		for (let [key, value] of Object.entries(entry)) {
			if (!Array.isArray(value) || !value.length || !value.every(isNameObject)) continue;
			out[key] = value.map((n) => {
				allNames.push(n);
				let zh = zhPersonName(n);
				return zh ? { literal: zh } : n;
			});
		}
		let lang = String(entry.language || "").trim();
		let chinese = isChineseItem({ title: entry.title, creators: allNames, language: lang, publication: entry["container-title"] });
		if (chinese && (!lang || /^zh$/i.test(lang) || (ZH_LANG_RE.test(lang) && !/^zh[-_]/i.test(lang)))) {
			out.language = "zh-TW";
		}
		return out;
	}

	return {
		DEFAULTS, options,
		isChineseText, isChineseItem, zhPersonName, referenceName, joinAuthors,
		formatReference, shortCitation, sortReferences, adjustCSL,
	};
});
