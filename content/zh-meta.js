/*
 * ZotMax — 中文文獻補強: check the Zotero data of Chinese-language items for what breaks Chinese APA 7
 * (apa-zh.js) and Zotero's own citation styles, show it in a review window, and write back only the
 * fixes the user ticks.
 *
 * Records from 華藝 Airiti Library, 臺灣期刊論文索引, 臺灣博碩士論文知識加值系統 (NDLTD) and journal sites
 * often arrive with: several authors in one creator (「陳美玲、林小華」), names split in Western order
 * (名 陳, 姓 美玲) or with spaces (「陳 美玲」), a compound surname split after its first character
 * (歐／陽志明), Chinese and pinyin in one name; the issue written into the volume (「70(2)」, 「第70卷第2期」);
 * pages in full-width digits or with 頁／p. (「４５－５６頁」); the DOI only in Extra or the URL, or with a
 * doi.org prefix or a trailing period; the date in 民國 years (「民國112年」 = 2023); the language empty or
 * 「zh」／「中文」 instead of zh-TW; the journal in 《》 or Chinese and English together; a title with a
 * trailing period, edge spaces or half-width 「:」 between Chinese words; a thesis imported as a journal
 * article.
 *
 * analyze() turns one item's data (Zotero field names, as item.toJSON() has them) into findings:
 *   { id, field, label, problem, current, suggested, confidence: "sure" | "check", hint, changes }
 * A fix is suggested only when it is mechanical; "sure" ones start ticked, "check" ones (which part of a
 * name is the surname, what the item type is) start unticked and say why. Missing data (卷期頁, 年份,
 * 學位類別, 校名) is reported with no suggestion and where to look: nothing is looked up online in this
 * version and nothing is invented. Items that are not Chinese (apa-zh's isChineseItem: the title decides)
 * get no findings at all.
 *
 * Nothing is written without the review window: apply() writes the ticked fixes of each item in one
 * transaction and keeps what it changed (zhMeta.lastRun), so 「復原上一次中文文獻修正」 puts those
 * fields back unless they were edited again since.
 *
 * The functions down to "review window" are pure (Node tests); the rest needs Zotero.
 */
(function (root, factory) {
	if (typeof module === "object" && module.exports) {
		module.exports = factory(require("./apa-zh.js"), globalThis);
	}
	else {
		(root.ZB = root.ZB || {}).zhMeta = factory(root.ZB.apaZh, root);
	}
})(this, function (apaZh, scope) {
	const PREF = "extensions.zotero-bridge.";
	const TITLE = "ZotMax：中文文獻補強";
	const HTML_NS = "http://www.w3.org/1999/xhtml";
	const DIALOG_URL = "chrome://zotero-bridge/content/zh-meta-review.xhtml";
	const DIALOG_ROOT = "zb-zhmeta";
	const LAST_RUN_PREF = "zhMeta.lastRun";

	const HAN = /\p{Script=Han}/u;
	const LATIN = /\p{Script=Latin}/u;
	const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
	const HANGUL = /\p{Script=Hangul}/u;
	// One person's name in Han characters (· ‧ ・ in transliterated names)
	const HAN_NAME = /^[\p{Script=Han}·‧・]{2,6}$/u;
	// Between people in one creator field
	const LIST_SEP = /\s*[、;；，,／/]\s*/;

	/** Labels of the fields the review window shows. */
	const FIELD_LABELS = {
		creators: "作者", title: "篇名", publicationTitle: "期刊名", date: "日期", volume: "卷期", pages: "頁碼",
		DOI: "DOI", language: "語言", itemType: "文獻類型", thesisType: "學位類別", publisher: "校名",
	};
	const TYPE_LABELS = {
		journalArticle: "期刊文章", thesis: "學位論文", report: "報告", document: "文件", book: "書籍", bookSection: "書籍章節",
		webpage: "網頁", conferencePaper: "會議論文", manuscript: "手稿", magazineArticle: "雜誌文章", newspaperArticle: "報紙文章",
	};
	// The review window's tag: a fix it is sure about, one the user has to judge, data only the user can add
	const CONFIDENCE_LABELS = { sure: "有把握", check: "請確認", missing: "要你補上" };

	// Item types that get a DOI field in Zotero (used only without Zotero.ItemFields, i.e. in tests)
	const DOI_TYPES = new Set(["journalArticle", "conferencePaper", "preprint", "dataset", "standard", "report", "book", "bookSection", "thesis"]);
	// Types a thesis is often imported as
	const THESIS_FROM = new Set(["journalArticle", "report", "document", "book", "webpage", "manuscript"]);
	// Characters written only in traditional (Taiwan) or only in simplified Chinese, for zh-TW vs zh-CN
	const TRAD_ONLY = new Set(Array.from("護體學與醫們個會這為對發現說時關國經過還應實當動從問點樣來後進產開數將變長讓種義業間員專區語計頭電環質讀檢驗療藥衛顧壓務營養態響類網隨機設證據權級運歷參請際準認識調職論雜誌預練傷統"));
	const SIMP_ONLY = new Set(Array.from("护体学与医们个会这为对发现说时关国经过还应实当动从问点样来进产开数将变长让种义业间员专区语计头电环质读检验疗药卫顾压务营养态响类网随机设证据权级运历参请际认识调职论杂预练伤统"));

	const isSurname = s => apaZh.isSurname(s);
	const startsWithSurname = s => !!s && (apaZh.isSurname(Array.from(s)[0]) || apaZh.COMPOUND_SURNAMES.some(c => s.startsWith(c)));

	// ---------- text helpers ----------

	function str(v) {
		return v === undefined || v === null ? "" : String(v);
	}

	/** Full-width ASCII (０-９, Ａ-Ｚ, －, ～, ．, ：…) and the ideographic space → half-width. */
	function halfWidth(s) {
		return str(s).replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)).replace(/　/g, " ");
	}

	/** Spaces (also full-width) at the ends dropped and between Han characters removed: 「 陳 美玲 」 → 陳美玲. */
	function cleanHan(s) {
		return str(s).replace(/[\s　]+/g, " ").trim().replace(/(\p{Script=Han}) (?=\p{Script=Han})/gu, "$1");
	}

	function show(v) {
		let s = str(v);
		return s.trim() ? s : "（空白）";
	}

	// ---------- pages, volume, issue ----------

	/**
	 * Pages as Zotero and the APA formatter expect them: half-width digits, a hyphen between the first and
	 * last page, no 頁／p.／pp. 「４５－５６頁」 → 45-56, 「p. 45~56」 → 45-56, 「第45至56頁」 → 45-56.
	 * Returns null when the text is not a plain page range (left alone).
	 */
	function normalizePages(raw) {
		let s = halfWidth(raw).trim();
		if (!s) return null;
		s = s.replace(/^第\s*/, "")
			.replace(/^(?:頁碼|頁數|頁次|頁|pages?|pp?\.?)\s*[:：]?\s*/i, "")
			.replace(/\s*頁$/, "")
			.replace(/\s*(?:[-‐‑‒–—―−~〜]+|至|到)\s*/g, "-")
			.replace(/\s*[,，、]\s*/g, ", ")
			.trim();
		let page = "[A-Za-z]?\\d+[A-Za-z]?";
		let range = `${page}(?:-${page})?`;
		return new RegExp(`^${range}(?:, ${range})*$`).test(s) ? s : null;
	}

	/** Same pages as far as the APA output goes (hyphen or en dash, spaces around it). */
	function samePages(a, b) {
		let fold = s => str(s).trim().replace(/\s*[-–—]\s*/g, "-");
		return fold(a) === fold(b);
	}

	/**
	 * Volume and issue written together: 「70(2)」, 「70（2）」, 「第70卷第2期」, 「70卷2期」, 「Vol. 70, No. 2」.
	 * Returns { volume, issue } or null.
	 */
	function splitVolume(raw) {
		let s = halfWidth(raw).trim();
		let m = /^(\d+)\s*\(\s*(\d+(?:\s*[-/]\s*\d+)?)\s*\)$/.exec(s)
			|| /^第?\s*(\d+)\s*卷\s*[,，]?\s*第?\s*(\d+(?:\s*[-/]\s*\d+)?)\s*期$/.exec(s)
			|| /^vol\.?\s*(\d+)\s*[,，]?\s*(?:no|issue)\.?\s*(\d+(?:\s*[-/]\s*\d+)?)$/i.exec(s);
		return m ? { volume: m[1], issue: m[2].replace(/\s+/g, "") } : null;
	}

	/** 「第70卷」, 「70卷」, 「Vol. 70」, 「７０」 → 70; null when it is not a plain volume number. */
	function cleanVolume(raw) {
		let s = halfWidth(raw).trim();
		let m = /^(?:第\s*)?(\d+)\s*卷$/.exec(s) || /^vol(?:ume)?\.?\s*(\d+)$/i.exec(s) || /^(\d+)$/.exec(s);
		return m ? m[1] : null;
	}

	/** 「第2期」, 「2期」, 「No. 2」, 「(2)」, 「２」 → 2. */
	function cleanIssue(raw) {
		let s = halfWidth(raw).trim();
		let m = /^(?:第\s*)?(\d+(?:\s*[-/]\s*\d+)?)\s*期$/.exec(s) || /^(?:no|issue)\.?\s*(\d+(?:\s*[-/]\s*\d+)?)$/i.exec(s)
			|| /^\(\s*(\d+(?:\s*[-/]\s*\d+)?)\s*\)$/.exec(s) || /^(\d+(?:\s*[-/]\s*\d+)?)$/.exec(s);
		return m ? m[1].replace(/\s+/g, "") : null;
	}

	// ---------- dates ----------

	/**
	 * A date in 民國 (ROC) years → the Western date: 民國112年 → 2023, 112年4月 → 2023-04,
	 * 中華民國112年4月1日 → 2023-04-01 (sure: 年 says it is a year); 112/04/01, 112.04 → check (could be
	 * something else). Returns { year, date, sure } or null.
	 */
	function rocYear(raw) {
		let s = halfWidth(raw).trim();
		let sure = true;
		let m = /^(?:中華)?民國\s*(\d{1,3})\s*年(?:\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日)?)?$/.exec(s)
			|| /^(\d{2,3})\s*年(?:\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日)?)?$/.exec(s);
		if (!m) {
			// 112, 112/04, 99.04.01 (a bare number only with three digits)
			m = /^(\d{3})()()$/.exec(s) || /^(\d{2,3})[./-](\d{1,2})(?:[./-](\d{1,2}))?$/.exec(s);
			sure = false;
		}
		if (!m) return null;
		let roc = Number(m[1]);
		let month = m[2] ? Number(m[2]) : 0;
		let day = m[3] ? Number(m[3]) : 0;
		if (roc < 1 || roc > 200 || month > 12 || day > 31 || (m[2] && !month) || (m[3] && !day)) return null;
		let year = roc + 1911;
		let pad = n => String(n).padStart(2, "0");
		let date = String(year) + (month ? `-${pad(month)}` + (day ? `-${pad(day)}` : "") : "");
		return { year, date, sure };
	}

	// ---------- DOI ----------

	/**
	 * A DOI as the DOI field holds it: no https://doi.org/ or doi: prefix, half-width, no trailing
	 * punctuation (a closing parenthesis only when it has no opening one: airiti DOIs such as
	 * 10.6224/JN.202304_70(2).07 keep theirs). "" when it is not a DOI.
	 */
	function normalizeDOI(raw) {
		let s = halfWidth(raw).trim();
		if (/%2F|%28|%29/i.test(s)) {
			try {
				s = decodeURIComponent(s);
			}
			catch (e) {}
		}
		s = s.replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi\s*[:：]\s*|doi\s+)/i, "").trim();
		for (let i = 0; i < 5; i++) {
			let before = s;
			s = s.replace(/[.,;:。，；：、'"」』]+$/, "");
			let open = (s.match(/\(/g) || []).length;
			let close = (s.match(/\)/g) || []).length;
			if (s.endsWith(")") && close > open) s = s.slice(0, -1);
			if (s.endsWith("]") && !s.includes("[")) s = s.slice(0, -1);
			if (s === before) break;
		}
		return /^10\.\d{4,9}\/\S+$/.test(s) ? s : "";
	}

	/**
	 * A DOI the record keeps outside the DOI field: a 「DOI: …」 line in Extra (how Zotero stores it for
	 * types without the field, and how Airiti thesis records arrive), or a doi.org / …/doi/… URL.
	 * Returns { doi, source: "extra" | "url", line } or null.
	 */
	function detectDOI(data) {
		let extra = str(data.extra);
		for (let line of extra.split(/\r?\n/)) {
			let m = /^\s*DOI\s*[:：]\s*(\S+)\s*$/i.exec(line);
			let doi = m && normalizeDOI(m[1]);
			if (doi) return { doi, source: "extra", line };
		}
		let url = str(data.url).trim();
		let m = /^https?:\/\/(?:dx\.)?doi\.org\/(.+)$/i.exec(url) || /\/doi\/(?:abs\/|full\/|pdf\/)?(10\.\d{4,9}\/[^?#\s]+)/i.exec(url)
			|| /[?&]doi=(10(?:\.|%2E)[^&#\s]+)/i.exec(url);
		let doi = m && normalizeDOI(m[1]);
		return doi ? { doi, source: "url", line: "" } : null;
	}

	// ---------- language ----------

	/**
	 * The language of a text by its script: "zh" when Han characters make up a good part of the letters
	 * (a Chinese title with English terms is still Chinese), "ja" or "ko" with kana or hangul, "en" for
	 * Latin script, "" without letters.
	 */
	function guessLanguage(text) {
		let s = str(text);
		if (KANA.test(s)) return "ja";
		if (HANGUL.test(s)) return "ko";
		let han = (s.match(/\p{Script=Han}/gu) || []).length;
		let latin = (s.match(/\p{Script=Latin}/gu) || []).length;
		if (!han && !latin) return "";
		// A Han character carries about as much as a word of four or five letters
		return han * 4 >= latin ? "zh" : "en";
	}

	/** "TW" (traditional characters), "CN" (simplified) or "" (nothing tells them apart). */
	function zhVariant(text) {
		let trad = 0;
		let simp = 0;
		for (let ch of str(text)) {
			if (TRAD_ONLY.has(ch)) trad++;
			else if (SIMP_ONLY.has(ch)) simp++;
		}
		if (trad > simp) return "TW";
		if (simp > trad) return "CN";
		return "";
	}

	const GENERIC_ZH = /^(?:zh|chi|zho|cmn|chinese|中文|華語|华语|漢語|汉语|國語|国语|中文\s*chinese|chinese\s*中文)$/i;
	const TRAD_LABEL = /^(?:繁體中文|正體中文|繁中|traditional chinese|chinese \(traditional\))$/i;
	const SIMP_LABEL = /^(?:简体中文|簡體中文|简中|simplified chinese|chinese \(simplified\))$/i;

	// ---------- thesis ----------

	/**
	 * Is this record a thesis imported as something else? The NDLTD URL or catalog, or 碩士論文／博士論文／
	 * 學位論文 in the journal, publisher, Extra or title. Returns { degree: "碩士論文" | "博士論文" | "", reason }
	 * or null.
	 */
	function guessThesis(data) {
		// Not the title: an article can be about theses
		let words = [data.publicationTitle, data.publisher, data.extra].map(str).join("\n");
		let degree = degreeOf(data);
		let reason = "";
		if (/ndltd\.ncl\.edu\.tw|hdl\.handle\.net\/11296\//i.test(str(data.url))) reason = "網址是臺灣博碩士論文知識加值系統";
		else if (/臺灣博碩士|台灣博碩士|ndltd/i.test(str(data.libraryCatalog))) reason = "來源是臺灣博碩士論文知識加值系統";
		else if (/(?:碩士|博士|學位)(?:學位)?論文|master'?s thesis|doctoral dissertation|ph\.?\s*d\.?\s*dissertation/i.test(words)) {
			reason = `資料裡寫著「${degree || "學位論文"}」`;
		}
		return reason ? { degree, reason } : null;
	}

	/** 「碩士論文」 or 「博士論文」 when the record says which (journal, publisher, Extra, title, thesis type), else "". */
	function degreeOf(data) {
		let words = [data.publicationTitle, data.publisher, data.extra, data.title, data.thesisType].map(str).join("\n");
		if (/博士(?:學位)?論文|doctoral dissertation|ph\.?\s*d\.?\s*dissertation/i.test(words)) return "博士論文";
		if (/碩士(?:學位)?論文|master'?s thesis/i.test(words)) return "碩士論文";
		return "";
	}

	// ---------- creators ----------

	/**
	 * Several people in one creator: 「陳美玲、林小華」, 「陳美玲;林小華」, 「陳美玲，林小華」 (sure) or
	 * 「陳美玲 林小華」 (check: a space can also sit inside one name). Returns { names, sure } or null.
	 */
	function splitCreators(text) {
		let s = str(text).replace(/　/g, " ").trim();
		if (!HAN.test(s)) return null;
		let names = s.split(LIST_SEP).map(cleanHan).filter(Boolean);
		let sure = true;
		if (names.length < 2) {
			let words = s.split(/\s+/).filter(Boolean);
			// Every word a whole name: starts with a surname, at least two characters, not a bare surname (歐陽 志明)
			if (words.length < 2 || !words.every(w => Array.from(w).length >= 2 && startsWithSurname(w) && !apaZh.COMPOUND_SURNAMES.includes(w))) return null;
			names = words;
			sure = false;
		}
		if (!names.every(n => HAN_NAME.test(n))) return null;
		return { names, sure };
	}

	/** How a creator looks in Zotero: 「陳美玲」（單一欄位） or 姓「陳」名「美玲」. */
	function creatorText(c) {
		if (!c) return "";
		if (c.name !== undefined) return `「${str(c.name)}」（單一欄位）`;
		return `姓「${str(c.lastName)}」名「${str(c.firstName)}」`;
	}

	function creatorFinding(index, c, replacement, confidence, problem, hint) {
		return {
			id: `creators-${index}`, field: "creators", label: FIELD_LABELS.creators, problem, confidence, hint,
			current: creatorText(c), suggested: replacement.map(creatorText).join("、"),
			changes: { creator: { index, replacement } },
		};
	}

	/** At most one finding per creator; English names are left alone. */
	function analyzeCreator(c, index) {
		let single = c.name !== undefined;
		let last = str(single ? c.name : c.lastName);
		let first = single ? "" : str(c.firstName);
		if (!HAN.test(last + first)) return null;
		let type = c.creatorType || "author";
		let one = name => ({ name, creatorType: type });

		// Several people in one creator
		if (single || !first.trim()) {
			let split = splitCreators(last);
			if (split) {
				return creatorFinding(index, c, split.names.map(one), split.sure ? "sure" : "check",
					`${split.names.length} 位作者擠在同一個欄位`,
					split.sure ? "依「、」「；」「，」拆成每人一筆（單一欄位，寫完整姓名）。"
						: "用空白分開的幾個名字看起來是不同的人；如果其實是一個人的名字，就不要勾。");
			}
		}
		// Chinese and English (pinyin) in one name: keep the Chinese name
		if (LATIN.test(last + first)) {
			let runs = `${last} ${first}`.replace(/　/g, " ").replace(/(\p{Script=Han})\s+(?=\p{Script=Han})/gu, "$1")
				.match(/[\p{Script=Han}·‧・]+/gu) || [];
			if (runs.length === 1 && HAN_NAME.test(runs[0])) {
				return creatorFinding(index, c, [one(runs[0])], "check", "中文姓名和英文拼音混在一起",
					"中文 APA 只寫中文姓名；如果這位其實是外籍作者，就不要勾。");
			}
			return null;
		}
		let cl = cleanHan(last);
		let cf = cleanHan(first);
		if (single) {
			// Only a personal name: an organisation (「衛生福利部 國民健康署」) may keep its space
			if (cl !== last && HAN_NAME.test(cl)) {
				return creatorFinding(index, c, [one(cl)], "sure", "姓名中間或前後有空白", "拿掉空白，Zotero 和引用格式才會把它當成同一個姓名。");
			}
			return null;
		}
		let two = (lastName, firstName) => ({ lastName, firstName, creatorType: type });
		// Western order: 名「陳」 姓「美玲」
		if (cl && cf && isSurname(cf) && !startsWithSurname(cl)) {
			return creatorFinding(index, c, [two(cf, cl)], "sure", "姓和名前後顛倒", `「${cf}」是姓，「${cl}」是名。`);
		}
		if (cl && cf && Array.from(cf).length === 1 && isSurname(cf) && Array.from(cl).length >= 2 && startsWithSurname(cl)
			&& !apaZh.COMPOUND_SURNAMES.includes(cl)) {
			return creatorFinding(index, c, [two(cf, cl)], "check", "姓和名可能前後顛倒",
				`「${cf}」和「${cl[0]}」都可能是姓，請看原文作者寫的是「${cf}${cl}」還是「${cl}${cf}」。`);
		}
		// A compound surname split after its first character: 歐／陽志明
		if (Array.from(cl).length === 1 && Array.from(cf).length >= 2 && apaZh.COMPOUND_SURNAMES.includes(cl + Array.from(cf)[0])) {
			let rest = Array.from(cf);
			let surname = cl + rest.shift();
			return creatorFinding(index, c, [two(surname, rest.join(""))], "check", "複姓可能被拆錯",
				`「${surname}」可能是複姓，也可能姓「${cl}」名「${cf}」，請看原文。ZotMax 的中文 APA 寫完整姓名不受影響，但 Zotero 自己的引用格式（例如 Word 外掛）會用到姓。`);
		}
		// Two whole names in the two fields: 姓「陳美玲」名「林小華」
		if (Array.from(cl).length >= 2 && Array.from(cf).length >= 2 && startsWithSurname(cl) && startsWithSurname(cf)
			&& !apaZh.COMPOUND_SURNAMES.includes(cl) && !apaZh.COMPOUND_SURNAMES.includes(cf)) {
			return creatorFinding(index, c, [one(cl), one(cf)], "check", "姓和名兩欄可能是兩位作者",
				`「${cl}」和「${cf}」看起來都是完整的姓名；如果其實是同一個人，就不要勾。`);
		}
		if ((cl !== last || cf !== first) && HAN_NAME.test(cl + cf)) {
			return creatorFinding(index, c, [two(cl, cf)], "sure", "姓名中間或前後有空白", "拿掉空白，Zotero 和引用格式才會把它當成同一個姓名。");
		}
		return null;
	}

	// ---------- titles ----------

	/**
	 * Chinese text followed by its English translation: 「護理雜誌 The Journal of Nursing」,
	 * 「題目＝English title」. Returns the Chinese part, or null. minWords: Latin words the tail needs.
	 */
	function chinesePart(text, minWords) {
		let s = str(text).trim();
		let chars = Array.from(s);
		let lastHan = -1;
		chars.forEach((ch, i) => {
			if (HAN.test(ch)) lastHan = i;
		});
		if (lastHan < 0) return null;
		let end = lastHan + 1;
		while (end < chars.length && /[）」』》〉？！]/.test(chars[end])) end++;
		let head = chars.slice(0, end).join("").trim();
		let tail = chars.slice(end).join("").replace(/^[\s=＝/／|｜:：。．.，,；;-]+/, "").trim();
		if (!tail || HAN.test(tail) || !/^[A-Za-z]/.test(tail)) return null;
		if ((tail.match(/[A-Za-z]{2,}/g) || []).length < minWords) return null;
		return head;
	}

	/** Mechanical title fixes (sure): edge spaces, double spaces, half-width 「:」「,」「;」「?」 between Chinese, a trailing period. */
	function tidyTitle(raw) {
		let s = str(raw).replace(/^[\s　]+|[\s　]+$/g, "").replace(/ {2,}/g, " ");
		s = s.replace(/(\p{Script=Han}|[）」』》])\s*:\s*(?=\p{Script=Han}|[（「『《])/gu, "$1：")
			.replace(/(\p{Script=Han})\s*,\s*(?=\p{Script=Han})/gu, "$1，")
			.replace(/(\p{Script=Han})\s*;\s*(?=\p{Script=Han})/gu, "$1；")
			.replace(/(\p{Script=Han})\s*\?(?=\p{Script=Han}|$)/gu, "$1？")
			.replace(/(\p{Script=Han}|[）」』》])[。.]$/u, "$1");
		return s;
	}

	function titleFindings(data) {
		let out = [];
		let raw = str(data.title);
		if (!raw.trim()) return out;
		let tidy = tidyTitle(raw);
		if (tidy !== raw) {
			let why = [];
			if (/^[\s　]|[\s　]$/.test(raw) || / {2,}/.test(raw)) why.push("前後或中間有多餘的空白");
			if (/(\p{Script=Han}|[）」』》])[。.]$/u.test(raw.trim())) why.push("結尾多了句點（APA 會自己加）");
			if (/\p{Script=Han}\s*[:,;?]/u.test(raw)) why.push("中文之間用了半形標點");
			out.push({ id: "title", field: "title", label: FIELD_LABELS.title, problem: why.join("；") || "格式需要整理", confidence: "sure",
				current: raw, suggested: tidy, hint: "中文題目用全形標點，結尾不加句點。", changes: { fields: { title: tidy } } });
		}
		let also = out.length ? "（勾了會一併套用上一項的整理。）" : "";
		let zh = chinesePart(tidy, 3);
		if (zh && zh !== tidy) {
			out.push({ id: "title-english", field: "title", label: FIELD_LABELS.title, problem: "中文篇名後面接著英文篇名", confidence: "check",
				current: raw, suggested: zh, hint: `中文 APA 只寫中文篇名。如果英文是題目本身的一部分，就不要勾。${also}`,
				changes: { fields: { title: zh } } });
		}
		else if (/\p{Script=Han}[ 　]+\p{Script=Han}/u.test(tidy)) {
			let colon = tidy.replace(/(\p{Script=Han})[ 　]+(?=\p{Script=Han})/gu, "$1：");
			out.push({ id: "title-space", field: "title", label: FIELD_LABELS.title, problem: "中文篇名中間有空白", confidence: "check",
				current: raw, suggested: colon, hint: `空白多半是主標題和副標題的分隔，APA 用「：」連接；如果不是，就不要勾，自己在 Zotero 改。${also}`,
				changes: { fields: { title: colon } } });
		}
		return out;
	}

	function journalFindings(data) {
		let out = [];
		let raw = str(data.publicationTitle);
		if (!raw.trim()) return out;
		let s = raw.replace(/^[\s　]+|[\s　]+$/g, "");
		let m = /^[《〈「『]\s*(.+?)\s*[》〉」』]$/.exec(s);
		if (m) s = m[1];
		if (s !== raw) {
			out.push({ id: "publicationTitle", field: "publicationTitle", label: FIELD_LABELS.publicationTitle,
				problem: m ? "期刊名外面加了書名號" : "期刊名前後有空白", confidence: "sure", current: raw, suggested: s,
				hint: "期刊名只寫名稱，斜體由引用格式處理。", changes: { fields: { publicationTitle: s } } });
		}
		let also = out.length ? "（勾了會一併套用上一項的整理。）" : "";
		let zh = chinesePart(s, 2);
		if (zh && zh !== s) {
			out.push({ id: "publicationTitle-english", field: "publicationTitle", label: FIELD_LABELS.publicationTitle,
				problem: "中英文期刊名擠在一起", confidence: "check", current: raw, suggested: zh,
				hint: `中文 APA 寫中文期刊名。${also}`, changes: { fields: { publicationTitle: zh } } });
		}
		return out;
	}

	// ---------- analyze ----------

	function defaultHasField(type, field) {
		if (field === "DOI") return DOI_TYPES.has(type);
		if (["publicationTitle", "volume", "issue"].includes(field)) return ["journalArticle", "magazineArticle", "newspaperArticle"].includes(type);
		if (field === "thesisType") return type === "thesis";
		return true;
	}

	/** Is the item Chinese (apa-zh decides: the title, else the authors' names, else the language field)? */
	function isChinese(data) {
		if (!data) return false;
		return apaZh.isChineseItem({ title: data.title, creators: data.creators || [], language: data.language, publication: data.publicationTitle });
	}

	/**
	 * Everything that needs a look in one Chinese item. data: Zotero field names (itemType, title,
	 * creators [{ firstName, lastName, creatorType } | { name, creatorType }], date, volume, issue, pages,
	 * DOI, url, extra, language, publicationTitle, publisher, thesisType, libraryCatalog).
	 * opts.hasField(itemType, field): whether the type has the field (Zotero.ItemFields inside Zotero).
	 * Returns [] for items that are not Chinese.
	 */
	function analyze(data, opts = {}) {
		if (!isChinese(data)) return [];
		let hasField = opts.hasField || defaultHasField;
		let type = str(data.itemType) || "journalArticle";
		let out = [];
		let add = f => out.push(Object.assign({ label: FIELD_LABELS[f.field] || f.field, hint: "", changes: null }, f));

		// 文獻類型 first: changing it changes which fields exist
		let thesis = THESIS_FROM.has(type) ? guessThesis(data) : null;
		if (thesis) {
			let fields = thesis.degree ? { thesisType: thesis.degree } : {};
			add({ id: "itemType", field: "itemType", problem: "看起來是學位論文", confidence: "check",
				current: TYPE_LABELS[type] || type, suggested: "學位論文" + (thesis.degree ? `（${thesis.degree}）` : ""),
				hint: `${thesis.reason}。中文 APA 的學位論文寫法不同（〔碩士論文，校名〕）。學位論文沒有期刊名、卷期欄位，改了以後這些欄位會清空；校名請自己補在「大學」欄。`,
				changes: { itemType: "thesis", fields } });
		}

		(data.creators || []).forEach((c, i) => {
			let f = analyzeCreator(c, i);
			if (f) add(f);
		});
		for (let f of titleFindings(data)) add(f);
		if (type === "journalArticle" || type === "magazineArticle" || type === "newspaperArticle") {
			for (let f of journalFindings(data)) add(f);
		}

		// Date
		let date = str(data.date);
		if (!date.trim()) {
			add({ id: "date-missing", field: "date", problem: "缺年份", confidence: "check", current: "", suggested: "",
				hint: "沒有年份，APA 會寫成「無日期」。可以在 PDF 第一頁、期刊的目次或華藝的文章頁找到出版年月，直接在 Zotero 的「日期」填入。" });
		}
		else {
			let roc = rocYear(date);
			let half = halfWidth(date).trim();
			if (roc) {
				add({ id: "date", field: "date", problem: "民國年", confidence: roc.sure ? "sure" : "check", current: date, suggested: roc.date,
					hint: roc.sure ? `民國 ${roc.year - 1911} 年是西元 ${roc.year} 年；APA 寫西元年。`
						: `看起來是民國 ${roc.year - 1911} 年（西元 ${roc.year} 年），但沒有寫「年」，請確認。`,
					changes: { fields: { date: roc.date } } });
			}
			else if (!/\d{4}/.test(date) && /\d{4}/.test(half)) {
				add({ id: "date", field: "date", problem: "全形數字", confidence: "sure", current: date, suggested: half,
					hint: "全形數字的年份讀不出來，APA 會寫成「無日期」。", changes: { fields: { date: half } } });
			}
			else if (!/\d{4}/.test(half)) {
				add({ id: "date-missing", field: "date", problem: "日期裡找不到西元年", confidence: "check", current: date, suggested: "",
					hint: "APA 會寫成「無日期」。請對照 PDF 或資料庫的出版年，在 Zotero 的「日期」改成西元年（例如 2023-04）。" });
			}
		}

		// Volume and issue
		if (hasField(type, "volume")) {
			let vol = str(data.volume);
			let issue = str(data.issue);
			let split = vol.trim() ? splitVolume(vol) : null;
			if (split) {
				let clash = issue.trim() && cleanIssue(issue) !== split.issue;
				add({ id: "volume", field: "volume", problem: "期數寫進了卷數欄", confidence: clash ? "check" : "sure",
					current: `卷「${vol}」期「${issue}」`, suggested: `卷「${split.volume}」期「${split.issue}」`,
					hint: clash ? `卷數欄寫第 ${split.issue} 期，但期數欄是「${issue}」，請看原文是哪一期。` : "卷、期分開填，APA 才寫得出「70(2)」。",
					changes: { fields: { volume: split.volume, issue: split.issue } } });
			}
			else {
				let v = vol.trim() ? cleanVolume(vol) : vol;
				let n = issue.trim() ? cleanIssue(issue) : issue;
				if ((v !== null && v !== vol) || (n !== null && n !== issue)) {
					let fields = {};
					if (v !== null && v !== vol) fields.volume = v;
					if (n !== null && n !== issue) fields.issue = n;
					add({ id: "volume", field: "volume", problem: "卷期寫了「卷」「期」或全形數字", confidence: "sure",
						current: `卷「${vol}」期「${issue}」`, suggested: `卷「${fields.volume !== undefined ? fields.volume : vol}」期「${fields.issue !== undefined ? fields.issue : issue}」`,
						hint: "卷期欄只寫數字，APA 會排成「70(2)」。", changes: { fields } });
				}
			}
		}

		// Pages
		let pages = str(data.pages);
		if (pages.trim()) {
			let norm = normalizePages(pages);
			if (norm && !samePages(pages, norm)) {
				add({ id: "pages", field: "pages", problem: "頁碼寫了「頁」、全形數字或其他符號", confidence: "sure", current: pages, suggested: norm,
					hint: "頁碼只寫起訖數字，中間用連字號；APA 會排成「45–56」。", changes: { fields: { pages: norm } } });
			}
		}

		// What is missing from a journal article: reported, never filled in
		if (type === "journalArticle") {
			let missing = [];
			if (!str(data.volume).trim()) missing.push("卷數");
			if (!str(data.pages).trim()) missing.push("頁碼");
			if (missing.length) {
				add({ id: "volume-missing", field: "volume", problem: "缺卷期頁", confidence: "check", current: `沒有${missing.join("、")}`, suggested: "",
					hint: "這個版本不連網查詢，不會自己補。可以到華藝（Airiti Library）的文章頁、期刊官網的目次，或 PDF 第一頁的頁首／頁尾找到卷、期、起訖頁，直接在 Zotero 填入。" });
			}
		}

		// DOI
		if (hasField(type, "DOI")) {
			let doi = str(data.DOI);
			if (doi.trim()) {
				let norm = normalizeDOI(doi);
				if (norm && norm !== doi) {
					add({ id: "DOI", field: "DOI", problem: /^\s*(?:https?:|doi)/i.test(doi) ? "DOI 前面多了網址或「doi:」" : "DOI 多了空白、全形字或結尾標點",
						confidence: "sure", current: doi, suggested: norm, hint: "DOI 欄只寫 10. 開頭的部分，APA 會自己加上 https://doi.org/。",
						changes: { fields: { DOI: norm } } });
				}
				else if (!norm) {
					add({ id: "DOI-bad", field: "DOI", problem: "DOI 看起來不完整", confidence: "check", current: doi, suggested: "",
						hint: "DOI 是 10. 開頭、中間有「/」的一串字。可以到華藝的文章頁或期刊官網複製正確的 DOI。" });
				}
			}
			else {
				let found = detectDOI(data);
				if (found) {
					let fields = { DOI: found.doi };
					if (found.source === "extra") {
						fields.extra = str(data.extra).split(/\r?\n/).filter(l => l !== found.line).join("\n").trim();
					}
					add({ id: "DOI", field: "DOI", problem: found.source === "extra" ? "DOI 放在「其他」欄" : "DOI 只在網址裡", confidence: "sure",
						current: found.source === "extra" ? `其他：「${found.line.trim()}」` : `網址：${str(data.url).trim()}`, suggested: found.doi,
						hint: found.source === "extra" ? "移到 DOI 欄（並從「其他」欄拿掉那一行），引用格式才讀得到。" : "填進 DOI 欄，引用格式才讀得到；網址保留。",
						changes: { fields } });
				}
			}
		}

		// Thesis details
		if (type === "thesis") {
			if (!str(data.thesisType).trim()) {
				let degree = degreeOf(data);
				if (degree && hasField(type, "thesisType")) {
					add({ id: "thesisType", field: "thesisType", problem: "缺學位類別", confidence: "check", current: "", suggested: degree,
						hint: `資料裡寫著「${degree}」。APA 依學位類別寫〔碩士論文〕或〔博士論文〕。`, changes: { fields: { thesisType: degree } } });
				}
				else {
					add({ id: "thesisType", field: "thesisType", problem: "缺學位類別", confidence: "check", current: "", suggested: "",
						hint: "APA 會寫成〔學位論文〕。請在 Zotero 的「類型」欄填「碩士論文」或「博士論文」（看論文封面）。" });
				}
			}
			if (!str(data.publisher).trim()) {
				add({ id: "publisher", field: "publisher", problem: "缺校名", confidence: "check", current: "", suggested: "",
					hint: "APA 要寫學校（和系所）。請看論文封面或臺灣博碩士論文系統的頁面，填在 Zotero 的「大學」欄。" });
			}
		}

		// Language: zh-TW (or zh-CN) so Zotero's styles and references.json know the item is Chinese
		let lang = str(data.language).trim();
		if (!/^zh-(?:TW|CN|HK|MO|SG|Hant|Hans)(?:-[A-Z]{2})?$/.test(lang)) {
			let text = [data.title, data.publicationTitle, ...(data.creators || []).map(c => str(c.name) + str(c.lastName) + str(c.firstName))].map(str).join(" ");
			let variant = zhVariant(text);
			let target = variant === "CN" ? "zh-CN" : "zh-TW";
			let region = /^zh[-_](tw|cn|hk|mo|sg)$/i.exec(lang);
			let finding = null;
			if (region) finding = { confidence: "sure", suggested: `zh-${region[1].toUpperCase()}`, problem: "語言代碼寫法不標準" };
			else if (TRAD_LABEL.test(lang)) finding = { confidence: "sure", suggested: "zh-TW", problem: "語言寫成文字" };
			else if (SIMP_LABEL.test(lang)) finding = { confidence: "sure", suggested: "zh-CN", problem: "語言寫成文字" };
			else if (!lang || GENERIC_ZH.test(lang)) {
				finding = { confidence: variant === "TW" ? "sure" : "check", suggested: target, problem: lang ? "語言沒有寫地區（繁體或簡體）" : "語言欄空白" };
			}
			else if (guessLanguage(data.title) === "zh") finding = { confidence: "check", suggested: target, problem: "語言欄和篇名的語言不一致" };
			if (finding) {
				add({ id: "language", field: "language", problem: finding.problem, confidence: finding.confidence, current: lang, suggested: finding.suggested,
					hint: finding.confidence === "sure" ? `寫成 ${finding.suggested}，Zotero 的中文引用格式和匯出的參考文獻檔才認得出是中文文獻。`
						: variant === "CN" ? "篇名看起來是簡體字，所以建議 zh-CN；臺灣的文獻請自己改成 zh-TW。"
							: "從篇名看不出是繁體還是簡體；臺灣的文獻用 zh-TW。",
					changes: { fields: { language: finding.suggested } } });
			}
		}
		return out;
	}

	/**
	 * What applying these findings writes: { itemType, fields: { name: value }, creators } (itemType and
	 * creators null when unchanged). Later findings on the same field win; a creator's replacement can be
	 * several creators (a split).
	 */
	function applyChanges(data, findings) {
		let out = { itemType: null, fields: {}, creators: null };
		let replace = new Map();
		for (let f of findings) {
			let ch = f && f.changes;
			if (!ch) continue;
			if (ch.itemType && ch.itemType !== data.itemType) out.itemType = ch.itemType;
			Object.assign(out.fields, ch.fields || {});
			if (ch.creator) replace.set(ch.creator.index, ch.creator.replacement);
		}
		if (replace.size) {
			out.creators = [];
			(data.creators || []).forEach((c, i) => {
				out.creators.push(...(replace.has(i) ? replace.get(i) : [c]).map(x => Object.assign({}, x)));
			});
		}
		for (let [k, v] of Object.entries(out.fields)) {
			if (str(data[k]) === v && !out.itemType) delete out.fields[k];
		}
		return out;
	}

	/** Findings the review window starts ticked. */
	function defaultPicks(plan) {
		let picks = [];
		for (let item of plan.items) {
			for (let f of item.findings) {
				if (f.changes && f.confidence === "sure") picks.push({ libraryID: item.libraryID, key: item.key, id: f.id });
			}
		}
		return picks;
	}

	function describePicks(picks, infoCount) {
		let items = new Set(picks.map(p => `${p.libraryID}/${p.key}`)).size;
		let line = picks.length ? `已勾選 ${picks.length} 項修正，會改動 ${items} 篇文獻。` : "還沒有勾選任何修正。";
		if (infoCount) line += `另有 ${infoCount} 項資料要你自己補（不會自動填入）。`;
		return line;
	}

	// ---------- review window (DOM; pure enough for jsdom) ----------

	/**
	 * Draw the review into `root` (an HTML element of the dialog window) and wire it up.
	 * plan: { items: [{ id, key, libraryID, title, meta, findings }], clean: [{ title }] }
	 * handlers: { onApply(picks), onCancel() } — called once.
	 */
	function renderReview(doc, root, plan, handlers) {
		let el = (tag, attrs, text) => {
			let e = doc.createElementNS(HTML_NS, tag);
			for (let [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
			if (text !== undefined) e.textContent = text;
			return e;
		};
		root.replaceChildren();
		let boxes = [];
		let decided = false;
		let infoCount = 0;

		let head = el("header", { class: "zb-cl-head" });
		head.append(
			el("h1", { class: "zb-cl-title" }, "中文文獻補強：先看建議，再決定"),
			el("p", { class: "zb-cl-lead" }, "下面是 Zotero 資料裡會讓中文 APA 出錯的地方。有把握的修正已經先勾好，需要你判斷的沒有勾；按「套用勾選的修正」才會寫回 Zotero。缺的資料不會自己補，也不會連網查。之後想反悔：ZotMax 按鈕或快速指令 → 復原上一次中文文獻修正。"),
		);
		let bar = el("div", { class: "zb-cl-dims", role: "group", "aria-label": "一次調整勾選" });
		let defaults = el("button", { type: "button", class: "zb-zm-defaults" }, "只勾有把握的");
		let none = el("button", { type: "button", class: "zb-zm-none" }, "全部取消勾選");
		defaults.addEventListener("click", () => setAll(b => b.f.confidence === "sure"));
		none.addEventListener("click", () => setAll(() => false));
		bar.append(defaults, none);
		head.append(bar);

		let list = el("div", { class: "zb-cl-list", tabindex: "-1" });
		if (!plan.items.length) {
			list.append(el("p", { class: "zb-cl-empty" }, "這些中文文獻的資料看起來沒有問題，不需要修正。"));
		}
		plan.items.forEach((item, index) => {
			let section = el("section", { class: "zb-cl-item", "aria-labelledby": `zb-zm-item-${index}` });
			section.append(el("h2", { class: "zb-cl-item-title", id: `zb-zm-item-${index}` }, item.title || "（沒有篇名）"));
			if (item.meta) section.append(el("p", { class: "zb-cl-item-meta" }, item.meta));
			let ul = el("ul", { class: "zb-zm-findings" });
			item.findings.forEach((f, j) => {
				let id = `zb-zm-f-${index}-${j}`;
				let li = el("li", { class: "zb-zm-finding", "data-zb-finding": f.id, "data-confidence": f.changes ? f.confidence : "missing" });
				let row = el("div", { class: "zb-zm-row" });
				let label = el(f.changes ? "label" : "span", { class: "zb-zm-what", id: `${id}-what` });
				if (f.changes) label.setAttribute("for", id);
				label.append(el("span", { class: "zb-zm-field" }, f.label), el("span", { class: "zb-zm-problem" }, f.problem));
				let tag = el("span", { class: "zb-zm-tag" }, f.changes ? CONFIDENCE_LABELS[f.confidence] : CONFIDENCE_LABELS.missing);
				if (f.changes) {
					let box = el("input", { type: "checkbox", id, "aria-describedby": `${id}-change ${id}-why` });
					box.checked = f.confidence === "sure";
					box.addEventListener("change", update);
					boxes.push({ box, item, f });
					row.append(box, label, tag);
				}
				else {
					infoCount++;
					row.append(el("span", { class: "zb-zm-nobox", "aria-hidden": "true" }), label, tag);
				}
				li.append(row);
				if (f.changes) {
					let change = el("p", { class: "zb-zm-change", id: `${id}-change` });
					change.append(el("span", { class: "zb-zm-was" }, show(f.current)), el("span", { class: "zb-zm-arrow", "aria-label": "改成" }, " → "),
						el("span", { class: "zb-zm-now" }, show(f.suggested)));
					li.append(change);
				}
				else if (str(f.current).trim()) {
					li.append(el("p", { class: "zb-zm-change", id: `${id}-change` }, `現在：${f.current}`));
				}
				if (f.hint) li.append(el("p", { class: "zb-cl-why zb-zm-hint", id: `${id}-why` }, f.hint));
				ul.append(li);
			});
			section.append(ul);
			list.append(section);
		});
		let clean = plan.clean || [];
		if (clean.length) {
			let details = el("details", { class: "zb-cl-without" });
			details.append(el("summary", {}, `${clean.length} 篇中文文獻看起來沒有問題`));
			let ul = el("ul");
			for (let item of clean) ul.append(el("li", {}, item.title || "（沒有篇名）"));
			details.append(ul);
			list.append(details);
		}
		if (plan.skipped) list.append(el("p", { class: "zb-cl-item-note" }, `另有 ${plan.skipped} 篇不是中文文獻，沒有檢查。`));

		let foot = el("footer", { class: "zb-cl-foot" });
		let summary = el("p", { class: "zb-cl-summary", role: "status", "aria-live": "polite" });
		let cancel = el("button", { type: "button", class: "zb-cl-cancel" }, boxes.length ? "取消" : "關閉");
		let apply = el("button", { type: "button", class: "zb-cl-apply" }, "套用勾選的修正");
		cancel.addEventListener("click", () => finish(null));
		apply.addEventListener("click", () => {
			let p = picks();
			if (p.length) finish(p);
		});
		let buttons = el("div", { class: "zb-cl-buttons" });
		buttons.append(cancel, apply);
		foot.append(summary, buttons);
		if (!boxes.length) {
			defaults.disabled = true;
			none.disabled = true;
		}
		root.append(head, list, foot);
		root.addEventListener("keydown", (ev) => {
			if (ev.key === "Escape") {
				ev.preventDefault();
				finish(null);
			}
		});

		function picks() {
			return boxes.filter(b => b.box.checked).map(b => ({ libraryID: b.item.libraryID, key: b.item.key, id: b.f.id }));
		}

		function setAll(test) {
			for (let b of boxes) b.box.checked = !!test(b);
			update();
		}

		function update() {
			let current = picks();
			summary.textContent = describePicks(current, infoCount);
			apply.disabled = decided || !current.length;
		}

		function finish(result) {
			if (decided) return;
			decided = true;
			apply.disabled = true;
			cancel.disabled = true;
			if (result) handlers.onApply(result);
			else handlers.onCancel();
		}

		update();
		let first = boxes.length ? boxes[0].box : cancel;
		try {
			first.focus();
		}
		catch (e) {}
		return { picks, update, setAll, finish };
	}

	// ---------- Zotero ----------

	// The fields analyze() reads (publisher separately: the thesis 「大學」 is mapped to it)
	const FIELDS = ["title", "date", "volume", "issue", "pages", "DOI", "url", "extra", "language", "publicationTitle", "thesisType", "libraryCatalog"];

	function pref(key) {
		return Zotero.Prefs.get(PREF + key, true);
	}

	function setPref(key, value) {
		Zotero.Prefs.set(PREF + key, value, true);
	}

	function featureOn(id) {
		let f = scope.ZB && scope.ZB.features;
		return !f || f.isEnabled(id);
	}

	function notify(text, headline = TITLE) {
		scope.ZB.main.notify(headline, text);
	}

	function hasField(type, field) {
		try {
			let typeID = Zotero.ItemTypes.getID(type);
			let fieldID = Zotero.ItemFields.getID(field);
			return !!(typeID && fieldID && Zotero.ItemFields.isValidForType(fieldID, typeID));
		}
		catch (e) {
			return defaultHasField(type, field);
		}
	}

	function getField(item, field, base) {
		try {
			return str(item.getField(field, false, !!base));
		}
		catch (e) {
			return "";
		}
	}

	/** Plain copies of the creators (only the keys Zotero's JSON has). */
	function plainCreators(list) {
		return (list || []).map((c) => {
			if (c.name !== undefined || c.fieldMode === 1) return { name: str(c.name !== undefined ? c.name : c.lastName), creatorType: c.creatorType || "author" };
			return { firstName: str(c.firstName), lastName: str(c.lastName), creatorType: c.creatorType || "author" };
		});
	}

	/** The data analyze() reads, from a Zotero item. */
	function itemData(item) {
		let data = { itemType: item.itemType, creators: plainCreators(item.getCreatorsJSON()) };
		for (let f of FIELDS) data[f] = getField(item, f);
		data.publisher = getField(item, "publisher", true);
		return data;
	}

	/** Every field value of the item (to see what a change of item type cleared). */
	function allFields(item) {
		let names = [];
		try {
			let type = item.itemTypeID || Zotero.ItemTypes.getID(item.itemType);
			names = Zotero.ItemFields.getItemTypeFields(type).map(id => Zotero.ItemFields.getName(id)).filter(Boolean);
		}
		catch (e) {}
		if (!names.length) names = FIELDS;
		let out = {};
		for (let n of names) out[n] = getField(item, n);
		return out;
	}

	function snapshot(item) {
		return { itemType: item.itemType, fields: allFields(item), creators: plainCreators(item.getCreatorsJSON()) };
	}

	function metaLine(data) {
		let year = apaZh.yearOf(data) || "";
		return [year, data.publicationTitle || data.publisher, TYPE_LABELS[data.itemType] || data.itemType].map(str).filter(s => s.trim()).join(" · ");
	}

	/** The findings of one Zotero item ([] for an item that is not Chinese). */
	function findingsFor(item) {
		return analyze(itemData(item), { hasField });
	}

	/** For the ZotMax panel: how many things in this item need a look (0 when it is fine or not Chinese). */
	function paneCount(item) {
		if (!featureOn("zhMeta")) return 0;
		return findingsFor(item).length;
	}

	/** Check items: { items: [{ id, key, libraryID, title, meta, findings }], clean: [...], skipped }. */
	function buildPlan(items) {
		let plan = { items: [], clean: [], skipped: 0 };
		for (let item of items) {
			let data = itemData(item);
			if (!isChinese(data)) {
				plan.skipped++;
				continue;
			}
			let entry = { id: item.id, key: item.key, libraryID: item.libraryID, title: data.title, meta: metaLine(data), findings: analyze(data, { hasField }) };
			(entry.findings.length ? plan.items : plan.clean).push(entry);
		}
		return plan;
	}

	async function inTransaction(item, fn) {
		if (Zotero.DB && typeof Zotero.DB.executeTransaction === "function") {
			await Zotero.DB.executeTransaction(async () => {
				fn();
				await item.save();
			});
		}
		else {
			fn();
			await item.saveTx();
		}
	}

	function typeID(name) {
		return Zotero.ItemTypes ? Zotero.ItemTypes.getID(name) : name;
	}

	function readLastRun() {
		try {
			let run = JSON.parse(pref(LAST_RUN_PREF) || "null");
			return run && Array.isArray(run.items) && run.items.length ? run : null;
		}
		catch (e) {
			return null;
		}
	}

	/**
	 * Write the picked fixes. Each item is checked again first (the user may have edited it while the
	 * window was open): a fix that no longer applies, or now suggests something else, is skipped. One
	 * transaction per item. Returns { items, fixes, skipped, errors } and keeps what changed for undo.
	 */
	async function apply(plan, picks) {
		let byItem = new Map();
		for (let p of picks) {
			let k = `${p.libraryID}/${p.key}`;
			if (!byItem.has(k)) byItem.set(k, { libraryID: p.libraryID, key: p.key, ids: [] });
			byItem.get(k).ids.push(p.id);
		}
		let record = { at: new Date().toISOString(), items: [] };
		let totals = { items: 0, fixes: 0, skipped: 0, errors: [] };
		for (let { libraryID, key, ids } of byItem.values()) {
			let item = Zotero.Items.getByLibraryAndKey(libraryID, key);
			if (!item || item.deleted) {
				totals.skipped += ids.length;
				continue;
			}
			let planned = (plan.items.find(i => i.libraryID === libraryID && i.key === key) || { findings: [] }).findings;
			let data = itemData(item);
			let now = analyze(data, { hasField });
			let chosen = [];
			for (let id of ids) {
				let f = now.find(x => x.id === id && x.changes);
				let was = planned.find(x => x.id === id);
				if (f && (!was || was.suggested === f.suggested)) chosen.push(f);
				else totals.skipped++;
			}
			if (!chosen.length) continue;
			let change = applyChanges(data, chosen);
			let before = snapshot(item);
			try {
				await inTransaction(item, () => {
					if (change.itemType) item.setType(typeID(change.itemType));
					for (let [f, v] of Object.entries(change.fields)) {
						if (hasField(item.itemType, f)) item.setField(f, v);
					}
					if (change.creators) item.setCreators(change.creators);
				});
			}
			catch (e) {
				Zotero.logError(e);
				totals.errors.push(`「${data.title || key}」沒有改成：${e.message || e}`);
				continue;
			}
			let after = snapshot(item);
			let rec = { libraryID, key, title: data.title, itemType: null, fields: {}, creators: null };
			if (before.itemType !== after.itemType) rec.itemType = { before: before.itemType, after: after.itemType };
			for (let f of new Set([...Object.keys(before.fields), ...Object.keys(after.fields)])) {
				let b = str(before.fields[f]);
				let a = str(after.fields[f]);
				if (a !== b) rec.fields[f] = { before: b, after: a };
			}
			if (JSON.stringify(before.creators) !== JSON.stringify(after.creators)) rec.creators = { before: before.creators, after: after.creators };
			record.items.push(rec);
			totals.items++;
			totals.fixes += chosen.length;
		}
		if (record.items.length) {
			try {
				setPref(LAST_RUN_PREF, JSON.stringify(record));
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
		return totals;
	}

	/**
	 * 「復原上一次中文文獻修正」: put back what the last apply changed. A field (or the authors, or the item
	 * type) edited again since keeps the newer value. Returns { items, fields, kept: [text] } or null.
	 */
	async function undoLast(opts = {}) {
		let run = readLastRun();
		if (!run) {
			if (!opts.silent) notify("沒有可以復原的中文文獻修正（只能復原最後一次套用）。");
			return null;
		}
		if (!opts.silent) {
			let when = new Date(run.at);
			let stamp = isNaN(when.getTime()) ? run.at : when.toLocaleString();
			let ok = Services.prompt.confirm(Zotero.getMainWindow(), TITLE,
				`要復原 ${stamp} 的中文文獻修正嗎？\n\n會把那次改過的 ${run.items.length} 篇文獻改回原本的資料；之後你又自己改過的欄位會保留。`);
			if (!ok) return null;
		}
		let result = { items: 0, fields: 0, kept: [] };
		for (let rec of run.items) {
			let item = Zotero.Items.getByLibraryAndKey(rec.libraryID, rec.key);
			let name = rec.title || rec.key;
			if (!item || item.deleted) {
				result.kept.push(`「${name}」已經刪除`);
				continue;
			}
			let count = 0;
			try {
				await inTransaction(item, () => {
					if (rec.itemType) {
						if (item.itemType === rec.itemType.after) {
							item.setType(typeID(rec.itemType.before));
							count++;
						}
						else result.kept.push(`「${name}」的文獻類型`);
					}
					for (let [f, v] of Object.entries(rec.fields || {})) {
						if (!hasField(item.itemType, f)) continue;
						let cur = getField(item, f);
						if (cur === v.before) continue;
						if (cur === v.after) {
							item.setField(f, v.before);
							count++;
						}
						else result.kept.push(`「${name}」的${FIELD_LABELS[f] || f}`);
					}
					if (rec.creators) {
						if (JSON.stringify(plainCreators(item.getCreatorsJSON())) === JSON.stringify(rec.creators.after)) {
							item.setCreators(rec.creators.before);
							count++;
						}
						else result.kept.push(`「${name}」的作者`);
					}
				});
			}
			catch (e) {
				Zotero.logError(e);
				result.kept.push(`「${name}」（${e.message || e}）`);
				continue;
			}
			if (count) {
				result.items++;
				result.fields += count;
			}
		}
		setPref(LAST_RUN_PREF, "");
		if (!opts.silent) {
			notify(`已復原 ${result.items} 篇文獻的 ${result.fields} 處資料。`
				+ (result.kept.length ? `\n之後又改過、所以保留新值：${result.kept.slice(0, 5).join("、")}` : ""));
		}
		return result;
	}

	// ---------- review window ----------

	/** Wait for the dialog document (not the initial about:blank) to be ready. */
	function waitForDialog(win, timeoutMs = 15000) {
		return new Promise((resolve, reject) => {
			let start = Date.now();
			let check = () => {
				try {
					let doc = win.document;
					let rootEl = doc && doc.getElementById(DIALOG_ROOT);
					if (rootEl && doc.readyState === "complete") {
						resolve(rootEl);
						return;
					}
				}
				catch (e) {}
				if (win.closed || Date.now() - start > timeoutMs) {
					reject(new Error("中文文獻補強的視窗沒有開啟"));
					return;
				}
				setTimeout(check, 50);
			};
			check();
		});
	}

	/**
	 * Show the plan in the review window; resolves with the picks, or null when the user cancels or
	 * closes the window. opts.onOpen(win) is called once the window shows the plan (tests).
	 */
	async function review(plan, opts = {}) {
		let main = Zotero.getMainWindow();
		let win = main.openDialog(DIALOG_URL, "zotero-bridge-zh-meta", "chrome,dialog=no,resizable,centerscreen");
		let rootEl = await waitForDialog(win);
		return new Promise((resolve) => {
			let done = false;
			let finish = (picks) => {
				if (done) return;
				done = true;
				resolve(picks);
				try {
					if (!win.closed) win.close();
				}
				catch (e) {}
			};
			win.addEventListener("unload", () => finish(null));
			renderReview(win.document, rootEl, plan, { onApply: picks => finish(picks), onCancel: () => finish(null) });
			if (opts.onOpen) opts.onOpen(win);
		});
	}

	// ---------- run ----------

	let busy = false;

	/**
	 * Check items: analyze → review → apply. Returns { cancelled } or the apply totals, or null when the
	 * feature is off or there is nothing to check. opts: { review(plan) } for tests.
	 */
	async function run(items, opts = {}) {
		let ZB = scope.ZB;
		if (!featureOn("zhMeta")) {
			ZB.main.notifyFeatureOff("zhMeta");
			return null;
		}
		items = ZB.adapter.toRegularItems(items || []);
		if (!items.length) {
			notify("請先選取文獻，或在分類上按右鍵。");
			return null;
		}
		if (busy) {
			notify("上一次的檢查還沒結束，請先完成或關閉那個視窗。");
			return null;
		}
		busy = true;
		try {
			let plan = buildPlan(items);
			if (!plan.items.length) {
				notify(plan.clean.length
					? `檢查了 ${plan.clean.length} 篇中文文獻，資料看起來沒有問題。`
					: "選取的文獻裡沒有中文文獻（篇名有中文字的才算），沒有檢查。");
				return { cancelled: false, items: 0, fixes: 0, skipped: 0, errors: [], checked: plan.clean.length };
			}
			let picks;
			try {
				picks = await (opts.review || review)(plan);
			}
			catch (e) {
				Zotero.logError(e);
				notify(`確認視窗沒有開啟（${e.message || e}），Zotero 沒有變動。可以重新啟動 Zotero 後再試一次。`);
				return null;
			}
			if (!picks) return { cancelled: true };
			if (!picks.length) {
				notify("沒有勾選任何修正，Zotero 沒有變動。");
				return { cancelled: false, items: 0, fixes: 0, skipped: 0, errors: [] };
			}
			let result = await apply(plan, picks);
			let lines = [result.fixes ? `已修正 ${result.items} 篇文獻的 ${result.fixes} 處資料。` : "沒有改動任何資料。"];
			if (result.skipped) lines.push(`${result.skipped} 項在視窗開著時已經改過或不再適用，略過了。`);
			if (result.fixes) lines.push("想反悔：ZotMax 按鈕或快速指令 → 復原上一次中文文獻修正。");
			if (result.errors.length) lines.push(...result.errors.slice(0, 3));
			notify(lines.join("\n"));
			return Object.assign({ cancelled: false }, result);
		}
		finally {
			busy = false;
		}
	}

	return {
		DIALOG_URL, DIALOG_ROOT, LAST_RUN_PREF, FIELD_LABELS, TYPE_LABELS, CONFIDENCE_LABELS,
		halfWidth, normalizePages, splitVolume, cleanVolume, cleanIssue, rocYear, normalizeDOI, detectDOI, guessLanguage, zhVariant,
		guessThesis, degreeOf, splitCreators, analyzeCreator, tidyTitle, chinesePart, isChinese, analyze, applyChanges, defaultPicks, describePicks,
		renderReview,
		itemData, findingsFor, paneCount, buildPlan, apply, undoLast, readLastRun, review, run,
	};
});
