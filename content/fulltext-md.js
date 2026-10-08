/*
 * Zotero Bridge — full text as Markdown (pure functions, no Zotero globals).
 *
 *   toMarkdown       the text Zotero already extracted (PDF worker: one paragraph per line, pages
 *                    separated by \f) or markitdown's output → Markdown: hyphenation rejoined,
 *                    paragraphs, section headings, running headers/footers and page numbers dropped
 *   trimForAI        cut References / Acknowledgements / Funding / Conflict of interest before the
 *                    text goes to the AI (the real token saving)
 *   markHighlights   find the user's highlights (and verified AI quotes) in the Markdown and mark
 *                    them in place; the ones that can't be found are returned, never lost
 *   buildFullTextNote / notionChunks   the plugin-managed full-text note (Obsidian) and Notion page
 *
 * Conservative by design: a line is only dropped when it repeats at the edge of many pages or is a
 * bare page number at a page edge; a heading is only a whole line that names a known section.
 * Loaded into the plugin scope by bootstrap.js and required directly by the Node tests.
 */
(function (root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) {
		module.exports = api;
	}
	else {
		(root.ZB = root.ZB || {}).fulltextMd = api;
	}
})(this, function () {
	// Part of the cache key: bump when toMarkdown's output changes
	const VERSION = 1;

	// Known section headings. `trim`: cut before the text goes to the AI
	const SECTIONS = [
		{ id: "abstract", en: ["abstract", "summary"], zh: ["摘要", "中文摘要", "英文摘要"] },
		{ id: "background", en: ["background", "introduction", "background and aims", "introduction and background"], zh: ["前言", "緒論", "背景", "研究背景", "研究動機"] },
		{ id: "methods", en: ["methods", "method", "materials and methods", "methods and materials", "methodology", "study design", "patients and methods", "design and methods"], zh: ["研究方法", "方法", "材料與方法", "研究設計"] },
		{ id: "results", en: ["results", "findings", "results and discussion"], zh: ["結果", "研究結果"] },
		{ id: "discussion", en: ["discussion", "general discussion"], zh: ["討論"] },
		{ id: "conclusion", en: ["conclusion", "conclusions", "conclusions and implications", "implications for practice", "relevance to clinical practice"], zh: ["結論", "結論與建議", "結論與應用"] },
		{ id: "limitations", en: ["limitations", "limitation", "strengths and limitations", "study limitations", "limitations of the study"], zh: ["研究限制", "限制"] },
		{ id: "references", trim: true, en: ["references", "reference", "bibliography", "literature cited", "works cited", "reference list"], zh: ["參考文獻", "参考文献", "參考資料"] },
		{ id: "acknowledgements", trim: true, en: ["acknowledgements", "acknowledgments", "acknowledgement", "acknowledgment"], zh: ["誌謝", "致謝", "謝誌", "謝辭"] },
		{ id: "funding", trim: true, en: ["funding", "funding information", "funding sources", "sources of funding", "financial support", "funding statement"], zh: ["研究經費", "經費來源", "研究經費來源"] },
		{ id: "coi", trim: true, en: ["conflict of interest", "conflicts of interest", "conflict of interest statement", "conflicts of interest statement", "competing interests", "competing interest", "declaration of competing interest", "declaration of interest", "declarations of interest", "disclosure", "disclosures", "disclosure statement"], zh: ["利益衝突", "利益衝突聲明", "利益衝突說明"] },
	];
	const TRIM_IDS = new Set(SECTIONS.filter(s => s.trim).map(s => s.id));
	const HEADING_LOOKUP = new Map();
	for (let s of SECTIONS) {
		for (let n of s.en) HEADING_LOOKUP.set(n, s.id);
		for (let n of s.zh) HEADING_LOOKUP.set(n, s.id);
	}
	const HEADING_LABELS = {
		references: "References", acknowledgements: "Acknowledgements", funding: "Funding", coi: "Conflict of interest",
	};

	// A Funding/COI/Acknowledgements section longer than this probably swallowed body text (its next
	// heading wasn't recognised): it is not cut
	const MAX_SMALL_SECTION = 4000;
	// Tables and figures printed after the reference list (author manuscripts)
	const AFTER_REFERENCES_RE = /^\\?(?:(?:[Tt]able|TABLE|[Ff]igure|FIGURE|[Ff]ig\.|FIG\.)\s*\d|(?:[Aa]ppendix|APPENDIX|[Ss]upplementary|SUPPLEMENTARY)\b|(?:表|圖|附錄)\s*[\d一二三四五六七八九十])/u;
	// A reference list before this share of the text is probably a misread heading: not cut
	const REFERENCES_MIN_POSITION = 0.4;

	// Hyphenated prefixes that stay hyphenated when a line break splits them ("self- reported")
	const KEEP_HYPHEN = new Set([
		"self", "well", "non", "cross", "long", "short", "follow", "evidence", "nurse", "patient", "family",
		"health", "peer", "ill", "low", "high", "full", "part", "mid", "semi", "web", "home", "community",
		"user", "person", "age", "time", "school", "hospital", "work", "end", "first", "second", "third",
	]);
	// "pre- and post-test": the hyphen belongs to the first word
	const HYPHEN_STOP = new Set(["and", "or", "to", "nor", "und", "as", "but", "vs", "versus"]);

	const CJK = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}";
	const CJK_CHAR_RE = new RegExp(`[${CJK}]`, "u");
	const SENTENCE_END_RE = /[.!?:;。！？：；」』)\]）”"'’]\s*$/u;

	// ---------- headings ----------

	/** The section id of a line that is only a heading ("2. Methods", "REFERENCES", "參 考 文 獻"), else null. */
	function headingId(line) {
		let s = String(line || "").trim();
		if (!s || s.length > 80) return null;
		s = s.replace(/^\\/, "");
		// Numbering: 1. / 2.1 / II. / 一、 / 壹、 / (1)
		s = s.replace(/^(?:\(?\d{1,2}(?:\.\d{1,2})*[.)]?|[IVXivx]{1,4}[.)]|[一二三四五六七八九十]{1,3}[、.．]|[壹貳參肆伍陸柒捌玖拾]{1,3}[、.．])\s*/u, "");
		s = s.replace(/[\s:：.。]+$/u, "").trim();
		// Letter-spaced capitals "R E F E R E N C E S"
		if (/^(?:\p{L} ){3,}\p{L}$/u.test(s)) s = s.replace(/ /g, "");
		// Spaces between CJK characters that PDF extraction adds
		s = s.replace(new RegExp(`([${CJK}])\\s+(?=[${CJK}])`, "gu"), "$1");
		s = s.toLowerCase().replace(/&/g, "and").replace(/\s+/g, " ");
		return HEADING_LOOKUP.get(s) || null;
	}

	// ---------- hyphenation ----------

	/** Rejoin words split by a line break: "interven- tion" / "interven-\ntion" → "intervention". */
	function joinHyphenBreaks(text) {
		return String(text || "").replace(/(\p{L}+)[-\u00ad\u2010][ \t]*\n?[ \t]*(?=(\p{Ll}+))/gu, (all, left, right, offset, whole) => {
			// Only a break: "evidence-based" without a space stays as it is
			let gap = all.slice(left.length + 1);
			if (!gap.length && all[left.length] !== "\u00ad") return all;
			if (HYPHEN_STOP.has(right)) return all;
			if (KEEP_HYPHEN.has(left.toLowerCase())) return `${left}-`;
			return left;
		}).replace(/\u00ad/g, "");
	}

	// ---------- running headers, footers, page numbers ----------

	const PAGE_NUMBER_RE = /^(?:(?:page|p\.?|pp\.?)\s*)?[-–—]?\s*\d{1,4}\s*[-–—]?(?:\s*(?:of|\/)\s*\d{1,4})?$|^第\s*\d{1,4}\s*頁(?:\s*[,，/／]?\s*共\s*\d{1,4}\s*頁)?$|^\d{1,4}\s*\/\s*\d{1,4}$/iu;
	const EDGE_LINES = 3;
	const STAMP_RE = /https?:\/\/|www\.|downloaded|copyright|©|all rights reserved|licen[cs]e|terms and conditions|下載|版權/i;

	function edgeKey(line) {
		return line.trim().toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ");
	}

	/**
	 * Drop lines that repeat at the top or bottom of many pages (running heads, journal footers,
	 * download stamps) and bare page numbers at a page edge. pages: [[line]] (changed in place: dropped
	 * lines become null). Returns the number of dropped lines.
	 */
	function dropRunningLines(pages) {
		let removed = 0;
		if (pages.length < 2) return 0;
		let edges = pages.map((lines) => {
			let idx = lines.map((l, i) => (l.trim() ? i : -1)).filter(i => i >= 0);
			return [...new Set([...idx.slice(0, EDGE_LINES), ...idx.slice(-EDGE_LINES)])];
		});
		if (pages.length >= 3) {
			let counts = new Map();
			edges.forEach((idx, p) => {
				for (let key of new Set(idx.map(i => edgeKey(pages[p][i])))) counts.set(key, (counts.get(key) || 0) + 1);
			});
			let minPages = Math.max(3, Math.ceil(pages.length * 0.3));
			edges.forEach((idx, p) => {
				for (let i of idx) {
					let line = pages[p][i];
					if (line === null) continue;
					let t = line.trim();
					// A heading, a whole sentence (body text), or longer than a running head: kept, unless a
					// long line is plainly a stamp (download notice, licence, copyright)
					if (headingId(t) || (t.length > 60 && /[.!?。！？]$/u.test(t))) continue;
					if (t.length > 100 && !(t.length <= 250 && STAMP_RE.test(t))) continue;
					if ((counts.get(edgeKey(line)) || 0) >= minPages) {
						pages[p][i] = null;
						removed++;
					}
				}
			});
		}
		// A bare page number: only the very first or last line of a page
		edges.forEach((idx, p) => {
			let lines = pages[p];
			let live = lines.map((l, i) => (l !== null && l.trim() ? i : -1)).filter(i => i >= 0);
			for (let i of [live[0], live[live.length - 1]]) {
				if (i === undefined || lines[i] === null) continue;
				if (PAGE_NUMBER_RE.test(lines[i].trim())) {
					lines[i] = null;
					removed++;
				}
			}
		});
		return removed;
	}

	// ---------- paragraphs ----------

	/**
	 * Hard-wrapped text (pdftotext, markitdown: a paragraph runs over several lines) vs one paragraph
	 * per line (Zotero's PDF worker). In wrapped prose many lines go on in lower case (or CJK after CJK).
	 */
	function isWrapped(lines) {
		let pairs = 0;
		let goesOn = 0;
		for (let i = 0; i + 1 < lines.length; i++) {
			let a = (lines[i] || "").trim();
			let b = (lines[i + 1] || "").trim();
			if (!a || !b || /^\|/.test(a) || /^\|/.test(b)) continue;
			pairs++;
			if (/^\p{Ll}/u.test(b) || /\p{L}[-\u00ad\u2010]$/u.test(a) || (endsWithCJK(a) && startsWithCJK(b))) goesOn++;
		}
		return pairs >= 3 && goesOn / pairs >= 0.25;
	}

	function endsWithCJK(s) {
		return new RegExp(`[${CJK}]$`, "u").test(s);
	}

	function startsWithCJK(s) {
		return new RegExp(`^[${CJK}]`, "u").test(s);
	}

	/** Join two pieces of one paragraph: hyphen breaks, CJK without a space, else one space. */
	function joinPieces(a, b) {
		if (/\p{L}[-\u00ad\u2010]$/u.test(a) && /^\p{Ll}/u.test(b)) return joinHyphenBreaks(`${a}\n${b}`);
		if (endsWithCJK(a) && startsWithCJK(b)) return a + b;
		return `${a} ${b}`;
	}

	/** Does paragraph `b` (first on a new page) continue paragraph `a` (last on the previous page)? */
	function continues(a, b) {
		if (!a || !b || headingId(a) || headingId(b) || /^\|/.test(a) || /^\|/.test(b)) return false;
		if (/\p{L}[-\u00ad\u2010]$/u.test(a) && /^\p{Ll}/u.test(b)) return true;
		if (SENTENCE_END_RE.test(a)) return false;
		if (/^\p{Ll}/u.test(b)) return true;
		return endsWithCJK(a) && startsWithCJK(b) && !/^[一二三四五六七八九十壹貳參肆伍陸柒捌玖拾]+[、.．]/u.test(b);
	}

	/** Lines of one page → paragraphs (strings). */
	function pageParagraphs(lines, wrapped) {
		let out = [];
		let current = null;
		let flush = () => {
			if (current !== null && current.trim()) out.push(current.trim());
			current = null;
		};
		for (let line of lines) {
			if (line === null) continue;
			let t = line.replace(/[ \t]+/g, " ").trim();
			if (!t) {
				flush();
				continue;
			}
			// Tables (markitdown), headings: always their own block
			if (/^\|/.test(t) || headingId(t)) {
				flush();
				out.push(t);
				continue;
			}
			if (!wrapped) {
				flush();
				current = t;
				continue;
			}
			current = current === null ? t : joinPieces(current, t);
		}
		flush();
		return out;
	}

	// ---------- Markdown output ----------

	/** Keep a paragraph of source text from being read as Markdown or Obsidian syntax. */
	function escapeParagraph(p, opts) {
		let s = p;
		if (!opts.tables || !/^\|/.test(s)) {
			if (/^(?:#{1,6}\s|>|\|)/.test(s) || /^\s*(?:-{3,}|\*{3,}|_{3,}|={3,})\s*$/.test(s)) s = "\\" + s;
		}
		return s.replace(/==/g, "=\\=").replace(/%%/g, "%\\%").replace(/\[\[/g, "[\\[");
	}

	function headingText(p) {
		return p.replace(/^\\/, "").replace(/[\s:：]+$/u, "").trim();
	}

	/**
	 * Convert extracted text to Markdown.
	 * @param {string} text Zotero's full text (pages separated by \f) or markitdown's output
	 * @param {object} [opts] { source: "zotero" | "markitdown" } — markitdown's tables (| rows) are kept
	 * @returns {{ md, stats: { pages, rawChars, mdChars, removedLines, headings: [{ id, text }] } }}
	 */
	function toMarkdown(text, opts = {}) {
		let src = String(text || "").replace(/\r\n?/g, "\n").replace(/[\u200b-\u200d\u2060\ufeff]/g, "").normalize("NFC");
		let stats = { pages: 0, rawChars: src.length, mdChars: 0, removedLines: 0, headings: [] };
		if (!src.trim()) return { md: "", stats };
		let pages = src.split("\f").map(p => p.split("\n"));
		stats.pages = pages.length;
		stats.removedLines = dropRunningLines(pages);
		// markitdown (pdfminer) always wraps lines; Zotero's own text usually has one paragraph per line
		let wrapped = opts.source === "markitdown" || isWrapped(pages.flat().filter(l => l !== null));
		let paragraphs = [];
		for (let lines of pages) {
			let paras = pageParagraphs(lines, wrapped);
			if (paras.length && paragraphs.length && continues(paragraphs[paragraphs.length - 1], paras[0])) {
				paragraphs[paragraphs.length - 1] = joinPieces(paragraphs[paragraphs.length - 1], paras.shift());
			}
			paragraphs.push(...paras);
		}
		let tables = opts.source === "markitdown";
		let out = [];
		let lastHeading = null;
		for (let p of paragraphs) {
			p = joinHyphenBreaks(p.replace(/\s+/g, " "));
			let id = headingId(p);
			if (id) {
				let h = headingText(p);
				if (lastHeading === h) continue;
				lastHeading = h;
				stats.headings.push({ id, text: h });
				out.push(`## ${h}`);
				continue;
			}
			lastHeading = null;
			out.push(escapeParagraph(p, { tables }));
		}
		// Consecutive table rows stay together as one Markdown table
		let md = out.join("\n\n").replace(/(^\|[^\n]*)\n\n(?=\|)/gm, "$1\n");
		stats.mdChars = md.length;
		return { md, stats };
	}

	// ---------- trimming for the AI ----------

	/**
	 * Remove References / Acknowledgements / Funding / Conflict of interest sections (Markdown from
	 * toMarkdown). Tables and figures printed after the reference list are kept.
	 * @returns {{ md, before, after, cut: [{ id, heading, chars }] }}
	 */
	function trimForAI(md) {
		md = String(md || "");
		let lines = md.split("\n");
		let offsets = [];
		let pos = 0;
		for (let l of lines) {
			offsets.push(pos);
			pos += l.length + 1;
		}
		let heads = [];
		lines.forEach((l, i) => {
			let m = /^## (.+)$/.exec(l);
			if (m) heads.push({ i, id: headingId(m[1]), text: m[1].trim() });
		});
		let keep = lines.map(() => true);
		let cut = [];
		for (let k = 0; k < heads.length; k++) {
			let h = heads[k];
			if (!TRIM_IDS.has(h.id)) continue;
			let end = k + 1 < heads.length ? heads[k + 1].i : lines.length;
			if (h.id === "references") {
				if (offsets[h.i] < md.length * REFERENCES_MIN_POSITION) continue;
				// Tables and figures after the reference list (author manuscripts) are results: keep them
				for (let j = h.i + 1; j < end; j++) {
					if (AFTER_REFERENCES_RE.test(lines[j])) {
						end = j;
						break;
					}
				}
			}
			let chars = (end < lines.length ? offsets[end] : md.length) - offsets[h.i];
			if (h.id !== "references" && chars > MAX_SMALL_SECTION) continue;
			for (let j = h.i; j < end; j++) keep[j] = false;
			cut.push({ id: h.id, heading: h.text, chars });
		}
		let out = lines.filter((l, i) => keep[i]).join("\n").replace(/\n{3,}/g, "\n\n").trim();
		return { md: out, before: md.length, after: out.length, cut };
	}

	/** "References、Funding" for messages. */
	function describeCut(cut) {
		return [...new Set((cut || []).map(c => HEADING_LABELS[c.id] || c.heading))].join("、");
	}

	// ---------- locating highlights ----------

	const TOKEN_RE = new RegExp(`[${CJK}]|(?:(?![${CJK}])[\\p{L}\\p{M}\\p{N}])+`, "gu");
	const ELLIPSIS_RE = /\s*(?:[[(（［]\s*(?:\.\s*){3}\s*[\])）］]|[[(（［]\s*…+\s*[\])）］]|(?:\.\s*){3,}|…+|⋯+)\s*/u;
	const FUZZY_RATIO = 0.9;

	function normToken(t) {
		return t.normalize("NFKC").toLowerCase();
	}

	/** Tokens with their offsets in `s`: [{ t, start, end }]. */
	function tokenize(s) {
		let out = [];
		for (let m of String(s || "").matchAll(TOKEN_RE)) out.push({ t: normToken(m[0]), start: m.index, end: m.index + m[0].length });
		return out;
	}

	function queryTokens(text) {
		return tokenize(joinHyphenBreaks(String(text || "").replace(/[\u200b-\u200d\u2060\ufeff]/g, ""))).map(x => x.t);
	}

	function buildIndex(md) {
		let tokens = tokenize(md);
		let positions = new Map();
		tokens.forEach((x, i) => {
			let list = positions.get(x.t);
			if (list) list.push(i);
			else positions.set(x.t, [i]);
		});
		return { tokens, positions };
	}

	// LCS of q against s[from, to): [length, firstMatchedIndex, lastMatchedIndex]
	function alignWindow(q, s, from, to) {
		let n = q.length;
		let w = to - from;
		let dp = Array.from({ length: n + 1 }, () => new Uint16Array(w + 1));
		for (let i = 1; i <= n; i++) {
			for (let j = 1; j <= w; j++) {
				dp[i][j] = q[i - 1] === s[from + j - 1].t ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
			}
		}
		let first = -1;
		let last = -1;
		let i = n;
		let j = w;
		while (i > 0 && j > 0) {
			if (q[i - 1] === s[from + j - 1].t && dp[i][j] === dp[i - 1][j - 1] + 1) {
				if (last < 0) last = from + j - 1;
				first = from + j - 1;
				i--;
				j--;
			}
			else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
			else j--;
		}
		return [dp[n][w], first, last];
	}

	/**
	 * Token span [start, end] (inclusive) of q in the index, preferring matches at or after `prefer`
	 * and avoiding `taken(start, end)`; null when not found.
	 */
	function findSpan(q, index, opts = {}) {
		let n = q.length;
		if (!n) return null;
		let { tokens: s, positions } = index;
		let taken = opts.taken || (() => false);
		let prefer = opts.prefer || 0;
		let freq = t => (positions.get(t) || []).length;
		let order = q.map((t, i) => i).sort((a, b) => freq(q[a]) - freq(q[b]));
		let pick = (cands) => {
			cands = cands.filter(c => !taken(c[0], c[1]));
			if (!cands.length) return null;
			cands.sort((a, b) => ((a[0] >= prefer ? 0 : 1) - (b[0] >= prefer ? 0 : 1)) || a[0] - b[0]);
			return cands[0];
		};
		// 1) exact
		let a = order[0];
		let exact = [];
		for (let p of positions.get(q[a]) || []) {
			let start = p - a;
			if (start < 0 || start + n > s.length) continue;
			let ok = true;
			for (let k = 0; k < n && ok; k++) ok = s[start + k].t === q[k];
			if (ok) exact.push([start, start + n - 1]);
		}
		let hit = pick(exact);
		if (hit || n < 3) return hit;
		// 2) fuzzy: ≥ 90% of the tokens in order within a window of about the same length
		let need = Math.ceil(n * FUZZY_RATIO);
		let misses = n - need;
		let slack = misses + 2;
		let tried = new Set();
		let fuzzy = [];
		// Bound the work for long highlights (each window is an n × window LCS table)
		let budget = Math.max(20, Math.floor(4e6 / (n * (n + 2 * slack))));
		for (let anchor of order.slice(0, misses + 1)) {
			for (let p of positions.get(q[anchor]) || []) {
				let start = Math.max(0, p - anchor - slack);
				if (tried.has(start) || budget-- <= 0) continue;
				tried.add(start);
				let end = Math.min(s.length, p - anchor + n + slack);
				let [len, first, last] = alignWindow(q, s, start, end);
				if (len >= need) fuzzy.push([first, last]);
			}
		}
		return pick(fuzzy);
	}

	/**
	 * Locate a quote (ellipses split it into fragments that must appear in order).
	 * Returns [[startOffset, endOffset], …] in the Markdown, or null.
	 */
	function locate(text, index, opts = {}) {
		let fragments = String(text || "").split(new RegExp(ELLIPSIS_RE.source, "gu")).map(queryTokens).filter(t => t.length);
		if (!fragments.length) return null;
		let spans = [];
		let prefer = opts.prefer || 0;
		for (let frag of fragments) {
			let span = findSpan(frag, index, { prefer, taken: opts.taken });
			if (!span || (spans.length && span[0] <= spans[spans.length - 1][1])) return null;
			spans.push(span);
			prefer = span[1] + 1;
		}
		return spans;
	}

	/**
	 * Mark highlights in the Markdown.
	 * @param {string} md from toMarkdown
	 * @param {object[]} items [{ id, text, open, close }] in reading order (open/close wrap each line
	 *   segment, e.g. "==🟡" … "=="); earlier items win where two overlap
	 * @returns {{ md, located: string[], missing: object[] }}
	 */
	function markHighlights(md, items) {
		md = String(md || "");
		let index = buildIndex(md);
		let marks = [];
		let located = [];
		let missing = [];
		let taken = (a, b) => marks.some(m => a <= m.t1 && b >= m.t0);
		let prefer = 0;
		for (let item of items || []) {
			let spans = locate(item.text, index, { prefer, taken });
			if (!spans) {
				missing.push(item);
				continue;
			}
			for (let [t0, t1] of spans) marks.push({ t0, t1, start: index.tokens[t0].start, end: index.tokens[t1].end, open: item.open, close: item.close });
			located.push(item.id);
			prefer = spans[spans.length - 1][1] + 1;
		}
		// Apply from the end so earlier offsets stay valid; each line of a span is wrapped on its own
		marks.sort((a, b) => b.start - a.start);
		for (let m of marks) {
			let segment = md.slice(m.start, m.end);
			let wrapped = segment.split("\n").map((line) => {
				let lead = /^#{1,6} /.exec(line);
				let head = lead ? lead[0] : "";
				let body = line.slice(head.length);
				let t = body.trim();
				if (!t) return line;
				let at = body.indexOf(t);
				return head + body.slice(0, at) + m.open + t + m.close + body.slice(at + t.length);
			}).join("\n");
			md = md.slice(0, m.start) + wrapped + md.slice(m.end);
		}
		return { md, located, missing };
	}

	/** Is the quote in the text (same matching as markHighlights)? */
	function containsQuote(text, quote) {
		return !!locate(quote, buildIndex(text));
	}

	// ---------- the full-text note ----------

	function yaml(v) {
		return JSON.stringify(String(v));
	}

	/**
	 * The plugin-managed full-text note for Obsidian. No `zotero_key` (the vault index and Bases only
	 * look at literature notes): `fulltext_of` names the item instead.
	 * @param {object} o { zoteroKey, title, md (marked), noteLink (vault path of the literature note,
	 *   without .md), legend: [{ emoji, meaning }], aiLegend: bool, missing: [{ text, emoji, page, meaning }],
	 *   source: "built-in" | "markitdown" } — nothing time-based, so an unchanged note isn't rewritten
	 */
	function buildFullTextNote(o) {
		let fm = [
			"---",
			`fulltext_of: ${yaml(o.zoteroKey)}`,
			`fulltext_source: ${yaml(o.source || "built-in")}`,
			"---",
		].join("\n");
		let callout = [
			"> [!info] 全文・由 Zotero Bridge 產生",
			`> 每次同步都會重新產生，請不要在這裡寫字；想法寫在文獻筆記 [[${o.noteLink}|${o.noteLabel || "文獻筆記"}]]。`,
		];
		let legend = (o.legend || []).map(l => `${l.emoji} ${l.meaning}`);
		if (o.aiLegend) legend.push("🤖 底線＝AI 標的重點（僅供參考）");
		if (legend.length) callout.push(`> 劃線：${legend.join(" · ")}`);
		let parts = [fm, "", callout.join("\n"), "", `# ${o.title || "Untitled"}`, "", String(o.md || "").trim()];
		let missing = missingSection(o.missing);
		if (missing) parts.push("", missing);
		return parts.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
	}

	/** 「沒有在全文中找到位置的劃線」: highlights that couldn't be placed, so none is lost. */
	function missingSection(missing) {
		if (!missing || !missing.length) return "";
		let lines = missing.map((m) => {
			let text = String(m.text || "").replace(/\s+/g, " ").trim().replace(/==/g, "=\\=");
			let mark = m.emoji !== undefined ? `==${m.emoji}${text}==` : text;
			return `- ${mark}${m.meaning ? ` — ${m.meaning}` : ""}${m.page ? ` · p. ${m.page}` : ""}`;
		});
		return "## 沒有在全文中找到位置的劃線\n\n"
			+ "這些劃線的文字跟抽出的全文對不上（常見原因：跨頁、圖表裡的字、掃描檔），所以列在這裡。\n\n"
			+ lines.join("\n");
	}

	/**
	 * Split Notion blocks into append requests: at most `maxBlocks` per request and about `maxBytes`
	 * of JSON (Notion allows 100 blocks and 500 KB per request; CJK text is 3 bytes per character).
	 */
	function notionChunks(blocks, opts = {}) {
		let maxBlocks = opts.maxBlocks || 100;
		let maxBytes = opts.maxBytes || 400000;
		// UTF-8 size; without TextEncoder (older plugin scopes) assume the worst case, 3 bytes a character
		let encoder = typeof TextEncoder === "function" ? new TextEncoder() : null;
		let size = b => (encoder ? encoder.encode(JSON.stringify(b)).length : JSON.stringify(b).length * 3);
		let chunks = [];
		let current = [];
		let bytes = 0;
		for (let b of blocks || []) {
			let n = size(b);
			if (current.length && (current.length >= maxBlocks || bytes + n > maxBytes)) {
				chunks.push(current);
				current = [];
				bytes = 0;
			}
			current.push(b);
			bytes += n;
		}
		if (current.length) chunks.push(current);
		return chunks;
	}

	/** A short hash of a string (cache keys, "did the Notion page change"). */
	function hash(s) {
		s = String(s || "");
		let h1 = 0x811c9dc5;
		let h2 = 0x01000193;
		for (let i = 0; i < s.length; i++) {
			let c = s.charCodeAt(i);
			h1 = Math.imul(h1 ^ c, 16777619);
			h2 = Math.imul(h2 + c, 2246822519) ^ (h2 >>> 13);
		}
		return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0") + s.length.toString(16);
	}

	return {
		VERSION, SECTIONS, headingId, joinHyphenBreaks, dropRunningLines, isWrapped, toMarkdown, trimForAI, describeCut,
		tokenize, buildIndex, findSpan, locate, markHighlights, containsQuote, buildFullTextNote, missingSection,
		notionChunks, hash,
	};
});
