/*
 * Zotero Bridge — quote verification (pure functions, no Zotero globals).
 * Checks each line of the AI note's 「可引用的句子」 section against the item's full text
 * and annotation texts, and marks it ✅ (found) or ⚠️ (not found / nothing to check against).
 *
 * Matching is token based: both sides are normalised (NFKC, case, curly quotes, PDF line-break
 * hyphenation, ligatures) and split into words; each CJK character is its own token, so spaces
 * or line breaks that PDF extraction puts between Chinese characters don't matter. A quote
 * matches when all its tokens occur contiguously, or when ≥ 90% of them occur in order inside
 * a source window of about the quote's length. Ellipses split a quote into fragments that
 * must each match, in order.
 */
(function (root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) {
		module.exports = api;
	}
	else {
		(root.ZB = root.ZB || {}).verify = api;
	}
})(this, function () {
	const QUOTES_HEADING = "可引用的句子";
	const MARK_VERIFIED = "✅";
	const MARK_NOT_FOUND = "⚠️ 未在全文中找到";
	const MARK_NO_FULLTEXT = "⚠️ 無全文可查證";
	const FUZZY_RATIO = 0.9;

	const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
	// Hyphen-like characters PDFs use inside words or at line ends (incl. soft hyphen); the en dash
	// and minus sign are included because models often swap them for "-" ("Mann–Whitney")
	const HYPHENS = "\\-\u00ad\u2010\u2011\u2012\u2013\u2212";
	const ELLIPSIS_RE = /\s*(?:[[(（［]\s*(?:\.\s*){3}\s*[\])）］]|[[(（［]\s*…+\s*[\])）］]|(?:\.\s*){3,}|…+|⋯+)\s*/u;

	/** Normalise text for comparison; the result is lower-case and has no hyphenation or apostrophes. */
	function normalizeForMatch(text) {
		let s = String(text || "").normalize("NFKC");
		// Zero-width characters and BOMs that PDF text layers sometimes contain
		s = s.replace(/[\u200b-\u200d\u2060\ufeff]/g, "");
		// Line-break hyphenation: "interven-\ntion" (or "interven- tion" once lines were joined)
		// → "intervention"; applied to both sides, so a real "pre- and post-test" still matches itself
		s = s.replace(new RegExp(`(\\p{L})[${HYPHENS}]\\s+(?=\\p{L})`, "gu"), "$1");
		s = s.replace(/\u00ad/g, "");
		// Intra-word hyphens are dropped on both sides, so "evidence-based" ≡ "evidence-\nbased"
		s = s.replace(new RegExp(`(\\p{L})[${HYPHENS}](?=\\p{L})`, "gu"), "$1");
		// Apostrophes (straight and curly) vanish: "patients’" ≡ "patients'" ≡ "patients"
		s = s.replace(/(\p{L})['’‘`´ʼ](?=\p{L}|\s|$)/gu, "$1");
		return s.toLowerCase();
	}

	/** Split normalised text into tokens: words/numbers, and single CJK characters. */
	function tokenize(text) {
		let s = normalizeForMatch(text).replace(CJK_RE, " $& ");
		return s.match(/[\p{L}\p{M}\p{N}]+/gu) || [];
	}

	/** Pre-compute the token positions of a source text, for repeated lookups. */
	function buildIndex(text) {
		let tokens = tokenize(text);
		let positions = new Map();
		tokens.forEach((t, i) => {
			let list = positions.get(t);
			if (list) list.push(i);
			else positions.set(t, [i]);
		});
		return { tokens, positions };
	}

	// Longest common subsequence length of a and b[from, to)
	function lcsLength(a, b, from, to) {
		let prev = new Array(a.length + 1).fill(0);
		let cur = new Array(a.length + 1).fill(0);
		for (let j = from; j < to; j++) {
			for (let i = 1; i <= a.length; i++) {
				cur[i] = a[i - 1] === b[j] ? prev[i - 1] + 1 : Math.max(prev[i], cur[i - 1]);
			}
			[prev, cur] = [cur, prev];
		}
		return prev[a.length];
	}

	/**
	 * Find quote tokens in an indexed source, starting at token position `from`.
	 * Returns -1 when not found; otherwise a position later fragments must not precede (the end of
	 * an exact match, or just past the approximate start of a fuzzy one).
	 */
	function findTokens(q, index, from = 0) {
		let n = q.length;
		if (!n) return from;
		let { tokens: s, positions } = index;
		let freq = t => (positions.get(t) || []).length;
		let need = n < 3 ? n : Math.ceil(n * FUZZY_RATIO);
		let misses = n - need;
		// Rarest quote tokens first: at least one of any (misses + 1) quote tokens is matched,
		// so anchoring on those positions finds every candidate window.
		let order = q.map((t, i) => i).sort((a, b) => freq(q[a]) - freq(q[b]));

		// 1) exact, contiguous match
		let j = order[0];
		for (let p of positions.get(q[j]) || []) {
			let start = p - j;
			if (start < from || start + n > s.length) continue;
			let ok = true;
			for (let k = 0; k < n && ok; k++) ok = s[start + k] === q[k];
			if (ok) return start + n;
		}
		if (!misses) return -1;

		// 2) fuzzy: ≥ 90% of the quote's tokens, in order, within a window of similar length
		let slack = misses + 2;
		let tried = new Set();
		let best = -1;
		// The fuzzy match's exact end is unknown, so report where the quote roughly starts:
		// a following ellipsis fragment then only has to come after that point.
		for (let a of order.slice(0, misses + 1)) {
			for (let p of positions.get(q[a]) || []) {
				let start = Math.max(from, p - a - slack);
				if (tried.has(start) || p < from) continue;
				tried.add(start);
				let end = Math.min(s.length, p - a + n + slack);
				if (lcsLength(q, s, start, end) >= need) {
					let at = Math.max(from, p - a) + 1;
					if (best < 0 || at < best) best = at;
					break;
				}
			}
		}
		return best;
	}

	/** Split a quote at ellipses ("...", "…", "[...]", "(…)") into fragments. */
	function splitOnEllipsis(quote) {
		return String(quote || "").split(new RegExp(ELLIPSIS_RE.source, "gu")).map(s => s.trim()).filter(Boolean);
	}

	/**
	 * Is `quote` in the indexed source? Every ellipsis fragment must be found, in order.
	 * @param {string} quote
	 * @param {{tokens, positions}} index from buildIndex()
	 */
	function quoteInIndex(quote, index) {
		let fragments = splitOnEllipsis(quote).map(tokenize).filter(t => t.length);
		if (!fragments.length) return false;
		let from = 0;
		for (let frag of fragments) {
			let end = findTokens(frag, index, from);
			if (end < 0) return false;
			from = end;
		}
		return true;
	}

	/** Convenience: is `quote` in `text`? (builds the index each call) */
	function containsQuote(text, quote) {
		return quoteInIndex(quote, buildIndex(text));
	}

	const QUOTE_PAIRS = [["“", "”"], ["\"", "\""], ["「", "」"], ["『", "』"], ["„", "“"], ["«", "»"]];

	/** The longest quoted span on a line (the quote itself; shorter spans are usually terms in the comment). */
	function extractQuote(line) {
		let best = null;
		for (let [open, close] of QUOTE_PAIRS) {
			let i = 0;
			while ((i = line.indexOf(open, i)) >= 0) {
				let j = line.indexOf(close, i + open.length);
				if (j < 0) break;
				let span = line.slice(i + open.length, j);
				if (span.trim() && (!best || span.length > best.length)) best = span;
				i = j + close.length;
			}
		}
		// A straight double quote opening and a curly one closing (or vice versa)
		if (!best) {
			let m = /["“]([^"“”]+)["”]/.exec(line);
			if (m) best = m[1];
		}
		return best;
	}

	const OLD_MARK_RE = new RegExp(`\\s*(?:${MARK_VERIFIED}|⚠️ (?:未在全文中找到|無全文可查證))\\s*$`, "u");

	function stripMark(line) {
		return line.replace(OLD_MARK_RE, "");
	}

	/** Locate the quotes section: { start, end } line indexes (end exclusive), or null. */
	function findQuotesSection(lines) {
		let headingRe = new RegExp(`^(#{1,6})\\s*${QUOTES_HEADING}\\s*$`);
		let start = -1;
		let level = 0;
		let inFence = false;
		for (let i = 0; i < lines.length; i++) {
			let fence = /^\s*```/.test(lines[i]);
			// A code block (e.g. a leftover JSON block) ends the section
			if (start >= 0 && fence) return { start, end: i };
			if (fence) inFence = !inFence;
			if (inFence || fence) continue;
			let m;
			if (start < 0) {
				if ((m = headingRe.exec(lines[i].trim()))) {
					start = i + 1;
					level = m[1].length;
				}
			}
			else if ((m = /^(#{1,6})\s/.exec(lines[i])) && m[1].length <= level) {
				return { start, end: i };
			}
		}
		return start >= 0 ? { start, end: lines.length } : null;
	}

	/**
	 * Verify and mark every quoted line in the 「可引用的句子」 section.
	 * @param {string} md - the AI note
	 * @param {object} sources - { fullText: string|null, texts: string[] } (texts = annotations, abstract…)
	 * @returns {{ md, total, verified, notFound, unchecked, hasFullText }}
	 *   notFound: quotes missing although full text was available; unchecked: no full text and not
	 *   found in the other texts.
	 */
	function verifyQuotes(md, sources = {}) {
		let result = { md: String(md || ""), total: 0, verified: 0, notFound: 0, unchecked: 0, hasFullText: false };
		let lines = result.md.split("\n");
		let section = findQuotesSection(lines);
		if (!section) return result;
		let fullText = sources.fullText && String(sources.fullText).trim() ? String(sources.fullText) : "";
		result.hasFullText = !!fullText;
		let indexes = [fullText, ...(sources.texts || [])]
			.filter(t => t && String(t).trim())
			.map(t => buildIndex(t));
		for (let i = section.start; i < section.end; i++) {
			let line = stripMark(lines[i]);
			let quote = extractQuote(line);
			if (!quote || !tokenize(quote).length) continue;
			result.total++;
			let mark;
			if (indexes.some(ix => quoteInIndex(quote, ix))) {
				result.verified++;
				mark = MARK_VERIFIED;
			}
			else if (fullText) {
				result.notFound++;
				mark = MARK_NOT_FOUND;
			}
			else {
				result.unchecked++;
				mark = MARK_NO_FULLTEXT;
			}
			lines[i] = `${line.replace(/\s+$/, "")} ${mark}`;
		}
		result.md = lines.join("\n");
		return result;
	}

	/** One-line summary for the progress window, or "" when there was nothing to check. */
	function summarize(r) {
		if (!r || !r.total) return "";
		let parts = [];
		if (r.verified) parts.push(`${MARK_VERIFIED} ${r.verified}`);
		if (r.notFound) parts.push(`⚠️ ${r.notFound} 句未在全文中找到`);
		if (r.unchecked) parts.push(`⚠️ ${r.unchecked} 句無全文可查證`);
		return `可引用句 ${r.total} 句：${parts.join("、")}`;
	}

	return {
		QUOTES_HEADING, MARK_VERIFIED, MARK_NOT_FOUND, MARK_NO_FULLTEXT, FUZZY_RATIO,
		normalizeForMatch, tokenize, buildIndex, findTokens, splitOnEllipsis, quoteInIndex, containsQuote,
		extractQuote, stripMark, findQuotesSection, verifyQuotes, summarize,
	};
});
