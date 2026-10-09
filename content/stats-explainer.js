/*
 * ZotMax — 讀懂統計 (feature statsExplainer): select a passage in the PDF reader, choose
 * 「ZotMax：解釋統計」 in Zotero's text-selection popup, and the ZotMax panel explains the statistics in
 * it for a nursing graduate student: 這是什麼 (each statistic or term), 這段在說什麼 (a plain restatement),
 * 臨床上代表什麼 and 要注意的地方.
 *
 *   reader     Zotero.Reader.registerEventListener("renderTextSelectionPopup", handler, pluginID) adds
 *              the button (Zotero's own `toolbar-button wide-button`, like 「Add to Note」); the
 *              listener is removed first thing at shutdown. The last selection is remembered so the
 *              catalog command 「解釋所選統計」 can explain it too.
 *   one call   system: fixed instructions (the same for every call, sent as a cacheable block); user:
 *              the selection, the paper's Methods / Statistical analysis excerpt from the full text as
 *              Markdown (fulltext.js / fulltext-md.js; the abstract when there is none) and design · N
 *              from the AI note for orientation. The answer is JSON.
 *   numbers    every number in the answer must appear in the selection or the excerpt that was sent
 *              (checkExplanation); the others are replaced by 「［數字已移除］」 and the panel says
 *              「⚠ 這個數字不在原文裡，已移除」. The model is told not to calculate anything new; only 0
 *              and 1 (the null values of a difference and a ratio) are allowed without a source.
 *   storage    the item's child note (tag zotero-bridge-stats): a readable copy plus the record as
 *              JSON, the last MAX_HISTORY explanations newest first, so it persists and syncs with
 *              Zotero. It is never synced as one of the user's notes or sent to the AI.
 *   存到筆記   appends the explanation to a folded 「統計筆記」 callout in the literature note, outside the
 *              %% zotero-bridge %% markers: the user's part of the note, which a re-sync never rewrites.
 *   簡單一點   one follow-up call that rewrites the explanation more simply; checked the same way
 *              against the selection and the already-checked explanation.
 *   cost       pref statsExplainer.confirm: "above" (default: a dialog only above
 *              statsExplainer.confirmAbove US$, otherwise the estimate shows inline while it runs),
 *              "always" or "never". Every call goes into the usage ledger (main.recordAIUsage).
 *
 * The functions down to "Zotero" are pure (Node tests); the rest needs Zotero.
 */
(function (root, factory) {
	if (typeof module === "object" && module.exports) {
		module.exports = factory(require("./fulltext-md.js"), globalThis);
	}
	else {
		(root.ZB = root.ZB || {}).statsExplainer = factory(root.ZB.fulltextMd, root);
	}
})(this, function (fulltextMd, scope) {
	const PREF = "extensions.zotero-bridge.";
	const FEATURE = "statsExplainer";
	const NOTE_TAG = "zotero-bridge-stats";
	const FORMAT = "zotero-bridge-stats";
	const NOTE_TITLE = "📊 統計解釋";
	const DATA_HEADING = "📋 統計解釋資料（ZotMax）";
	const CALLOUT_TITLE = "統計筆記";
	const POPUP_EVENT = "renderTextSelectionPopup";
	const HTML_NS = "http://www.w3.org/1999/xhtml";
	const MAX_HISTORY = 5;
	const MAX_SELECTION = 4000;
	const MAX_METHODS = 6000;
	const MAX_ABSTRACT = 3000;
	const MAX_TERMS = 8;
	const MAX_CAUTIONS = 6;
	const MAX_FIELD = 1500;
	const MAX_RECTS = 16;
	const EXPECTED_OUTPUT_TOKENS = 1200;
	const DEFAULT_CONFIRM_ABOVE = 0.05;
	// The reader's last selection is used by 「解釋所選統計」 for this long
	const SELECTION_TTL_MS = 30 * 60 * 1000;
	// What replaces a number that is in neither the selection nor the excerpt
	const REMOVED = "［數字已移除］";
	// Allowed without a source: the null values of a difference (0) and of a ratio (1)
	const ALLOWED_CONSTANTS = new Set(["0", "1"]);
	const PARTS = ["terms", "restatement", "clinical", "cautions"];
	const MARK_START_RE = /^%% zotero-bridge:start.*%%[ \t]*$/m;
	const MARK_END_RE = /^%% zotero-bridge:end %%[ \t]*$/m;
	const CALLOUT_RE = /^>[ \t]*\[!\w+\][-+]?[ \t]*統計筆記[ \t]*$/;
	const CALLOUT_INTRO = "ZotMax「讀懂統計」存下的解釋，新的加在最下面。這一段在同步區塊之外，是你的：重新同步不會改它，可以直接補上自己的理解。";

	const SYSTEM_PROMPT = `你是陪護理研究生讀論文的學長姐，專長是把論文裡的統計講清楚。使用者在 PDF 上選了一段文字，請解釋這段文字裡的統計。

讀者是台灣的護理研究所學生（多半也是臨床護理師）：學過統計但不熟。用繁體中文；統計術語第一次出現時附上英文（例如「勝算比（odds ratio, OR）」「信賴區間（confidence interval, CI）」）。語氣像學長姐在旁邊提點：直接、溫和、不說教。你的工作是解釋，不是評判這篇論文好不好，也不是替使用者下結論。

你會收到：
- <selection>：使用者選的原文。
- <methods>：論文「方法／統計分析」段落的節錄；沒有全文時改給 <abstract> 摘要。用來理解這些數字是怎麼算出來的。
- <study>：研究設計與樣本數，來自另一份 AI 筆記，只供你理解脈絡，不要引用它的數字。

數字的規則（最重要）：
1. 你寫出的每一個數字，都必須原樣出現在 <selection> 或 <methods>／<abstract> 裡，照原文的寫法（原文寫 1.8 就寫 1.8，寫 30% 就寫 30%，寫 .001 就寫 .001）。外掛會逐一核對，找不到的數字會被刪掉。
2. 不要計算新的數字：不要自己算 NNT、ARR、RRR、百分比變化、換算單位或四捨五入，也不要補上原文沒有的數值、顯著水準、效果量門檻或常模。需要時用文字說明怎麼算，例如「NNT 是兩組風險差的倒數，可以用原文兩組的發生率自己算算看」。
3. 唯一的例外是 0 和 1：說明信賴區間有沒有跨過 0（差值）或 1（比值）時可以寫。
4. 數字一律用阿拉伯數字，不要寫成中文數字。
5. 原文沒寫的事（例如是不是 intention-to-treat、有沒有校正多重比較、用了哪種檢定）就說「這段沒有寫」或「方法段落沒有提到」，不要猜。

輸出：只輸出一個 JSON 物件，前後不要有其他文字，也不要放在程式碼區塊裡。格式：
{
  "terms": [
    { "term": "原文裡出現的統計量或術語，例如 OR、RR、HR、CI、p 值、ITT、Cohen's d、Hedges' g、I²、NNT、SD、SMD", "what": "這是什麼：一兩句白話定義", "here": "在這段裡：它的值是多少、代表什麼（只用原文的數字）" }
  ],
  "restatement": "這段在說什麼：用白話把整段重說一次，2 到 4 句",
  "clinical": "臨床上代表什麼：對照顧病人的意義，一兩句；效果小或不確定也要老實說",
  "cautions": ["要注意的地方，一點一句"]
}

terms 依在原文出現的順序，只列原文真的有的統計量或術語，最多 ${MAX_TERMS} 個。cautions 0 到 5 點，只寫這段真的適用的，例如：信賴區間跨過 1 或 0（沒有統計上的顯著差異）、信賴區間很寬（估計不精確）、統計上顯著但效果很小、做了很多比較（多重比較）、per-protocol 和 intention-to-treat 的差別、只報相對風險沒報絕對風險、次要結果或事後分析。沒有就給空陣列。`;

	const SIMPLER_REQUEST = `使用者看完上面的解釋還是覺得難。請用更簡單的說法再解釋一次：句子更短、少用術語（非用不可時馬上用一句白話說明），可以用臨床照護的例子或生活比喻幫忙理解。輸出格式和數字規則完全相同：每個數字都必須出現在 <selection> 或 <previous> 裡，不要計算新的數字。`;

	// zh-TW text of the Fluent messages this module shows (identical to locale/zh-TW; tests check)
	const STRINGS = {
		popup: ["zotero-bridge-stats-popup", "ZotMax：解釋統計"],
		terms: ["zotero-bridge-stats-terms", "這是什麼"],
		restatement: ["zotero-bridge-stats-restatement", "這段在說什麼"],
		clinical: ["zotero-bridge-stats-clinical", "臨床上代表什麼"],
		cautions: ["zotero-bridge-stats-cautions", "要注意的地方"],
		here: ["zotero-bridge-stats-here", "在這段裡："],
		removedOne: ["zotero-bridge-stats-removed", "⚠ 這個數字不在原文裡，已移除"],
		removedMany: ["zotero-bridge-stats-removed-many", "⚠ 有 { $count } 個數字不在原文裡，已移除"],
		loading: ["zotero-bridge-stats-loading", "AI 解釋中…"],
		loadingCost: ["zotero-bridge-stats-loading-cost", "AI 解釋中…（預估約 { $name }）"],
		loadingSimpler: ["zotero-bridge-stats-loading-simpler", "換個簡單的說法中…"],
		save: ["zotero-bridge-stats-save", "存到筆記"],
		saved: ["zotero-bridge-stats-saved", "已存到筆記"],
		simpler: ["zotero-bridge-stats-simpler", "再解釋得簡單一點"],
		simplerTitle: ["zotero-bridge-stats-simpler-title", "簡單版"],
		openPage: ["zotero-bridge-stats-open-page", "回到 PDF 第 { $name } 頁"],
		openPDF: ["zotero-bridge-stats-open-pdf", "回到 PDF 原文"],
		hint: ["zotero-bridge-stats-hint", "AI 的解釋只是提點：每個數字都和原文核對過，判讀還是以原文為準。"],
		noTerms: ["zotero-bridge-stats-no-terms", "這段沒有找到統計量。"],
		noKey: ["zotero-bridge-stats-no-key", "還沒有設定 AI 的 API key，所以沒辦法解釋。到 設定 → AI 填入 Claude 或 OpenAI 的 key。"],
		openSettings: ["zotero-bridge-stats-open-settings", "打開設定"],
		failed: ["zotero-bridge-stats-failed", "解釋失敗：{ $error }"],
		badFormat: ["zotero-bridge-stats-bad-format", "AI 沒有照格式回答，下面是它的原話（數字一樣核對過）。"],
		dismiss: ["zotero-bridge-stats-dismiss", "知道了"],
		savedTo: ["zotero-bridge-stats-saved-to", "已存到文獻筆記的「統計筆記」。"],
		noVault: ["zotero-bridge-stats-no-vault", "還沒設定 Obsidian vault，沒地方存：設定 → 同步 → Obsidian。"],
		notSynced: ["zotero-bridge-stats-not-synced", "這篇還沒同步到 Obsidian。先同步一次，再按「存到筆記」。"],
		saveFailed: ["zotero-bridge-stats-save-failed", "存到筆記失敗：{ $error }"],
	};

	// ---------- text helpers (pure) ----------

	function oneLine(s) {
		return String(s === undefined || s === null ? "" : s).replace(/\s+/g, " ").trim();
	}

	function shorten(s, max) {
		s = oneLine(s);
		return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
	}

	function clip(s, max) {
		s = String(s || "").trim();
		return s.length <= max ? s : s.slice(0, max).trimEnd() + "…";
	}

	function escapeHTML(s) {
		return String(s === undefined || s === null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	}

	function decodeEntities(s) {
		return s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
			.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
			.replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&");
	}

	// ---------- the Methods / Statistical analysis excerpt (pure) ----------

	// A paragraph that starts the statistics part of the methods
	const STATS_PARAGRAPH_RE = /^\\?(?:\(?\d{1,2}(?:\.\d{1,2})*[.)]?\s*)?(?:statistical analys[ie]s|statistical methods?|statistics|data analys[ie]s|analytic(?:al)? (?:strategy|approach)|analysis plan|統計分析|資料分析|統計方法|資料處理與分析)(?![a-z])/i;

	function paragraphs(text) {
		return String(text || "").split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
	}

	/** Paragraphs up to `max` characters (the last one cut with …). */
	function fit(paras, max) {
		let out = [];
		let used = 0;
		for (let p of paras) {
			if (used >= max) break;
			let room = max - used;
			out.push(p.length <= room ? p : p.slice(0, Math.max(0, room - 1)).trimEnd() + "…");
			used += Math.min(p.length, room) + 2;
		}
		return out;
	}

	/**
	 * The part of the paper's Markdown (fulltext-md.toMarkdown: known sections as "## " headings) that
	 * says how the numbers were produced: the Statistical analysis paragraphs of the methods (with the
	 * start of the methods — design, participants — when there is room), else the methods from the
	 * top, else a statistics paragraph found anywhere. Returns { text, kind: "statistics" | "methods" | "" }.
	 */
	function methodsExcerpt(md, max = MAX_METHODS) {
		let sections = [];
		let current = { id: null, lines: [] };
		sections.push(current);
		for (let line of String(md || "").split("\n")) {
			let m = /^## (.+)$/.exec(line);
			if (m) {
				current = { id: fulltextMd.headingId(m[1]), lines: [] };
				sections.push(current);
				continue;
			}
			current.lines.push(line);
		}
		let methods = paragraphs(sections.filter(s => s.id === "methods").map(s => s.lines.join("\n")).join("\n\n"));
		let start = methods.findIndex(p => STATS_PARAGRAPH_RE.test(p));
		if (start >= 0) {
			let stats = fit(methods.slice(start), max);
			let used = stats.reduce((n, p) => n + p.length + 2, 0);
			let lead = start > 0 && max - used > 400 ? fit(methods.slice(0, start), max - used - 4) : [];
			let parts = lead.length ? [...lead, "…", ...stats] : stats;
			return { text: parts.join("\n\n"), kind: "statistics" };
		}
		if (methods.length) return { text: fit(methods, max).join("\n\n"), kind: "methods" };
		// Headings the conversion didn't recognise: a statistics paragraph anywhere in the text
		let all = paragraphs(String(md || "").replace(/^## .*$/gm, ""));
		let i = all.findIndex(p => STATS_PARAGRAPH_RE.test(p));
		if (i >= 0) return { text: fit(all.slice(i), Math.min(max, 3000)).join("\n\n"), kind: "statistics" };
		return { text: "", kind: "" };
	}

	// ---------- prompts (pure) ----------

	function studyLine(study) {
		if (!study) return "";
		let parts = [];
		if (study.study_design) parts.push(`研究設計：${study.study_design}`);
		if (study.sample_size) parts.push(`樣本數：${study.sample_size}`);
		return parts.join("；");
	}

	/**
	 * The one call: { system (parts, the same every time: cacheable), user, sources }. sources are the
	 * texts every number of the answer must come from (the selection and the excerpt that was sent).
	 * input: { selection, methods, methodsKind, abstract, study, title }
	 */
	function buildPrompt(input) {
		let selection = clip(input.selection, MAX_SELECTION);
		let parts = [];
		if (input.title) parts.push(`<paper>${oneLine(input.title)}</paper>`);
		let study = studyLine(input.study);
		if (study) parts.push(`<study>${study}（來自 AI 文獻筆記，只供理解脈絡）</study>`);
		parts.push(`<selection>\n${selection}\n</selection>`);
		let sources = [selection];
		let methods = String(input.methods || "").trim();
		let abstract = clip(input.abstract, MAX_ABSTRACT);
		if (methods) {
			let label = input.methodsKind === "statistics" ? "方法與統計分析段落的節錄" : "方法段落的節錄";
			parts.push(`<methods source="${label}">\n${methods}\n</methods>`);
			sources.push(methods);
		}
		else if (abstract) {
			parts.push(`<abstract>\n${abstract}\n</abstract>`);
			sources.push(abstract);
		}
		else {
			parts.push("（沒有全文也沒有摘要可以參考，只能依據選取的文字解釋。）");
		}
		parts.push("請依系統指示，用 JSON 解釋 <selection> 裡的統計。");
		return { system: [SYSTEM_PROMPT], user: parts.join("\n\n"), sources };
	}

	/** An explanation as plain text (the follow-up's <previous>, and a source for its number check). */
	function explanationText(ex) {
		ex = normalizeExplanation(ex);
		let lines = [];
		for (let t of ex.terms) lines.push(`- ${t.term}：${t.what}${t.here ? ` 在這段裡：${t.here}` : ""}`);
		if (ex.restatement) lines.push(`這段在說什麼：${ex.restatement}`);
		if (ex.clinical) lines.push(`臨床上代表什麼：${ex.clinical}`);
		for (let c of ex.cautions) lines.push(`要注意：${c}`);
		return lines.join("\n");
	}

	/** 「再解釋得簡單一點」: the same system prompt (cached), the selection and the checked explanation. */
	function buildSimplerPrompt(entry) {
		let selection = clip(entry.selection && entry.selection.text, MAX_SELECTION);
		let previous = explanationText(entry.explanation).split(REMOVED).join("（已移除）");
		return {
			system: [SYSTEM_PROMPT],
			user: `<selection>\n${selection}\n</selection>\n\n<previous>\n${previous}\n</previous>\n\n${SIMPLER_REQUEST}`,
			sources: [selection, previous],
		};
	}

	// ---------- the answer (pure) ----------

	function emptyExplanation() {
		return { terms: [], restatement: "", clinical: "", cautions: [] };
	}

	function field(obj, keys) {
		for (let k of keys) {
			if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
		}
		return undefined;
	}

	function cleanText(v) {
		if (v === undefined || v === null) return "";
		if (Array.isArray(v)) return clip(v.map(cleanText).filter(Boolean).join(" "), MAX_FIELD);
		if (typeof v === "object") return "";
		return clip(String(v).replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n"), MAX_FIELD);
	}

	function cleanList(v) {
		if (v === undefined || v === null || v === "") return [];
		if (!Array.isArray(v)) v = String(v).split(/\n+/).map(s => s.replace(/^\s*(?:[-*•・]|\d+[.)、])\s*/, ""));
		return v.map(cleanText).filter(Boolean);
	}

	/** Any reasonable shape → { terms: [{ term, what, here }], restatement, clinical, cautions: [] }. */
	function normalizeExplanation(obj) {
		if (!obj || typeof obj !== "object") return emptyExplanation();
		let rawTerms = field(obj, ["terms", "這是什麼", "statistics", "stats"]);
		if (rawTerms && !Array.isArray(rawTerms) && typeof rawTerms === "object") {
			rawTerms = Object.entries(rawTerms).map(([term, what]) => (typeof what === "object" ? Object.assign({ term }, what) : { term, what }));
		}
		let terms = (Array.isArray(rawTerms) ? rawTerms : typeof rawTerms === "string" ? [rawTerms] : []).map((t) => {
			if (typeof t === "string") return { term: cleanText(t), what: "", here: "" };
			if (typeof t !== "object" || t === null) return { term: "", what: "", here: "" };
			return {
				term: cleanText(field(t, ["term", "name", "名稱", "術語", "統計量"])),
				what: cleanText(field(t, ["what", "meaning", "definition", "explain", "這是什麼", "說明"])),
				here: cleanText(field(t, ["here", "in_this_text", "inThisText", "value", "在這段裡", "這段的意思"])),
			};
		}).filter(t => t.term || t.what || t.here).slice(0, MAX_TERMS);
		return {
			terms,
			restatement: cleanText(field(obj, ["restatement", "summary", "plain", "這段在說什麼"])),
			clinical: cleanText(field(obj, ["clinical", "clinical_meaning", "clinicalMeaning", "臨床上代表什麼", "臨床意義"])),
			cautions: cleanList(field(obj, ["cautions", "caveats", "warnings", "notes", "要注意的地方", "注意"])).slice(0, MAX_CAUTIONS),
		};
	}

	/** Close what a cut-off JSON text left open (strings, objects, arrays) so it can be parsed. */
	function repairJSON(text) {
		let s = String(text || "");
		let stack = [];
		let inString = false;
		let escaped = false;
		for (let ch of s) {
			if (inString) {
				if (escaped) escaped = false;
				else if (ch === "\\") escaped = true;
				else if (ch === "\"") inString = false;
				continue;
			}
			if (ch === "\"") inString = true;
			else if (ch === "{" || ch === "[") stack.push(ch);
			else if (ch === "}" || ch === "]") stack.pop();
		}
		// A cut-off escape (a lone backslash) is dropped
		if (inString) s = (escaped ? s.slice(0, -1) : s) + "\"";
		// A dangling key, colon or comma at the cut
		s = s.replace(/,\s*"[^"]*"\s*:?\s*$/, "").replace(/[,:]\s*$/, "");
		for (let open of stack.reverse()) s += open === "{" ? "}" : "]";
		return s;
	}

	function tryJSON(text) {
		try {
			let v = JSON.parse(text);
			return v && typeof v === "object" && !Array.isArray(v) ? v : null;
		}
		catch (e) {
			return null;
		}
	}

	const CUT_OFF_RE = /\n*>\s*⚠️\s*輸出(?:達到長度上限|未完成)[^\n]*\s*$/;

	/**
	 * The model's answer → { ok, truncated, error, explanation }. Tolerates code fences, prose around the
	 * object, trailing commas, an answer cut off mid-way (repaired; what is there is kept) and Chinese
	 * keys. Not JSON at all: ok false and the text as 這段在說什麼 (it is number-checked like the rest).
	 */
	function parseResponse(text) {
		let raw = String(text || "");
		let truncated = CUT_OFF_RE.test(raw);
		raw = raw.replace(CUT_OFF_RE, "").trim();
		let body = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();
		let start = body.indexOf("{");
		let obj = tryJSON(body);
		if (!obj && start >= 0) {
			let end = body.lastIndexOf("}");
			let slice = end > start ? body.slice(start, end + 1) : body.slice(start);
			obj = tryJSON(slice.replace(/,\s*([}\]])/g, "$1"))
				|| tryJSON(repairJSON(body.slice(start)).replace(/,\s*([}\]])/g, "$1"));
			if (obj && !(end > start && tryJSON(slice.replace(/,\s*([}\]])/g, "$1")))) truncated = true;
		}
		if (!obj) {
			let ex = emptyExplanation();
			ex.restatement = cleanText(body.replace(/[{}[\]"]/g, " "));
			return { ok: false, truncated, error: "AI 沒有照格式回答", explanation: ex };
		}
		let explanation = normalizeExplanation(obj);
		let empty = !explanation.terms.length && !explanation.restatement && !explanation.clinical && !explanation.cautions.length;
		return { ok: !empty, truncated, error: empty ? "AI 的回答是空的" : "", explanation };
	}

	// ---------- the number check (pure) ----------

	// One character → one character, so positions in the normalised text are positions in the original.
	// Superscript and subscript digits stay letters: they are notation (I², log₁₀), not reported values
	const NUMERAL_MAP = new Map([
		..."０１２３４５６７８９".split("").map((c, i) => [c, String(i)]),
		["．", "."], ["％", "%"],
	]);
	// Decimal points other than "." (the Lancet's middle dot, PDF extraction's look-alikes): only between digits
	const DECIMAL_DOTS = new Set(["·", "∙", "⋅", "•", "․"]);

	/** Full-width digits as ASCII, "1·8" as "1.8"; the length never changes. */
	function normalizeNumerals(text) {
		// UTF-16 code units: every mapped character is one, so positions stay the same
		let res = String(text || "").split("").map(c => (NUMERAL_MAP.has(c) ? NUMERAL_MAP.get(c) : c));
		for (let i = 1; i < res.length - 1; i++) {
			if (DECIMAL_DOTS.has(res[i]) && /\d/.test(res[i - 1]) && /\d/.test(res[i + 1])) res[i] = ".";
		}
		return res.join("");
	}

	// 1,234.5 · 1.8 · 95 · .001 (APA's p = .001); not the tail of a longer number
	const NUMBER_RE = /(?<![\d.])(?:\d{1,3}(?:,\d{3})+(?![\d,])(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)/g;

	/** "1,234.50" → "1234.5", ".001" → "0.001", "007" → "7"; null when it isn't a number. */
	function canonicalNumber(raw) {
		let s = String(raw).replace(/,/g, "");
		if (s.startsWith(".")) s = "0" + s;
		let n = Number(s);
		return Number.isFinite(n) ? String(n) : null;
	}

	/** Every number in a text: [{ raw, value, index }] (value canonical; signs are not part of it). */
	function extractNumbers(text) {
		let norm = normalizeNumerals(text);
		let out = [];
		for (let m of norm.matchAll(NUMBER_RE)) {
			let value = canonicalNumber(m[0]);
			if (value !== null) out.push({ raw: String(text).slice(m.index, m.index + m[0].length), value, index: m.index, length: m[0].length });
		}
		return out;
	}

	/** The canonical values of every number in these texts. */
	function numberSet(texts) {
		let set = new Set();
		for (let t of texts || []) {
			for (let n of extractNumbers(t)) set.add(n.value);
		}
		return set;
	}

	/**
	 * Replace every number of `text` that is not in `allowed` (nor 0 or 1) by REMOVED, together with a
	 * % right after it. Returns { text, removed: [raw…] }.
	 */
	function stripNumbers(text, allowed) {
		text = String(text || "");
		let out = "";
		let at = 0;
		let removed = [];
		for (let n of extractNumbers(text)) {
			if (n.index < at) continue;
			if (allowed.has(n.value) || ALLOWED_CONSTANTS.has(n.value)) continue;
			let end = n.index + n.length;
			let pct = /^\s?[%％]/.exec(text.slice(end));
			if (pct) end += pct[0].length;
			out += text.slice(at, n.index) + REMOVED;
			removed.push(text.slice(n.index, end));
			at = end;
		}
		return { text: out + text.slice(at), removed };
	}

	/**
	 * Check an explanation against the texts that were sent: every number not found in them is
	 * removed. Returns { explanation, removed: { terms, restatement, clinical, cautions }, total }.
	 */
	function checkExplanation(explanation, sources) {
		let allowed = numberSet(sources);
		let ex = normalizeExplanation(explanation);
		let removed = { terms: 0, restatement: 0, clinical: 0, cautions: 0 };
		let check = (part, s) => {
			let r = stripNumbers(s, allowed);
			removed[part] += r.removed.length;
			return r.text;
		};
		let out = {
			terms: ex.terms.map(t => ({ term: check("terms", t.term), what: check("terms", t.what), here: check("terms", t.here) })),
			restatement: check("restatement", ex.restatement),
			clinical: check("clinical", ex.clinical),
			cautions: ex.cautions.map(c => check("cautions", c)),
		};
		let total = PARTS.reduce((n, p) => n + removed[p], 0);
		return { explanation: out, removed, total };
	}

	// ---------- the record in the child note (pure) ----------

	function normalizeRemoved(r) {
		let out = {};
		for (let p of PARTS) out[p] = Math.max(0, Math.floor(Number(r && r[p]) || 0));
		return out;
	}

	function normalizeSelection(s) {
		s = s || {};
		let pageIndex = Number.isInteger(s.pageIndex) && s.pageIndex >= 0 ? s.pageIndex : null;
		let rects = Array.isArray(s.rects) ? s.rects.filter(r => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite)).slice(0, MAX_RECTS) : [];
		return {
			text: clip(s.text, MAX_SELECTION),
			pageLabel: oneLine(s.pageLabel).slice(0, 20),
			pageIndex,
			rects,
			attachmentKey: /^[A-Z0-9]{8}$/.test(String(s.attachmentKey || "")) ? s.attachmentKey : "",
		};
	}

	function normalizeAnswer(a) {
		return {
			at: oneLine(a && a.at),
			model: oneLine(a && a.model).slice(0, 100),
			explanation: normalizeExplanation(a && a.explanation),
			removed: normalizeRemoved(a && a.removed),
		};
	}

	function normalizeEntry(e) {
		if (!e || typeof e !== "object") return null;
		let base = normalizeAnswer(e);
		let entry = Object.assign({
			id: oneLine(e.id).slice(0, 40) || `s${Date.parse(base.at) || 0}`,
			selection: normalizeSelection(e.selection),
			context: ["statistics", "methods", "abstract", "none"].includes(e.context) ? e.context : "none",
			parseError: oneLine(e.parseError).slice(0, 200),
			savedAt: oneLine(e.savedAt),
			simpler: e.simpler ? normalizeAnswer(e.simpler) : null,
		}, base);
		return entry.selection.text ? entry : null;
	}

	function emptyRecord() {
		return { format: FORMAT, version: 1, entries: [] };
	}

	function normalizeRecord(r) {
		let entries = (r && Array.isArray(r.entries) ? r.entries : []).map(normalizeEntry).filter(Boolean).slice(0, MAX_HISTORY);
		return { format: FORMAT, version: 1, entries };
	}

	/** A new explanation first; only the last MAX_HISTORY are kept. */
	function addEntry(record, entry) {
		let r = normalizeRecord(record);
		r.entries = [normalizeEntry(entry), ...r.entries.filter(e => e.id !== entry.id)].filter(Boolean).slice(0, MAX_HISTORY);
		return r;
	}

	function updateEntry(record, id, patch) {
		let r = normalizeRecord(record);
		r.entries = r.entries.map(e => (e.id === id ? normalizeEntry(Object.assign({}, e, patch)) : e)).filter(Boolean);
		return r;
	}

	function pageWords(selection) {
		return selection && selection.pageLabel ? `p. ${selection.pageLabel}` : "";
	}

	/** One explanation as Markdown lines (no callout markup). link: where 「回到 PDF」 goes ("" = none). */
	function entryMarkdown(entry, link = "") {
		entry = normalizeEntry(entry);
		if (!entry) return "";
		let ex = entry.explanation;
		let head = [String(entry.at).slice(0, 10), pageWords(entry.selection)].filter(Boolean).join(" · ");
		let lines = [`**${head || "統計解釋"}**${link ? ` · [回到 PDF](${link})` : ""}`, ""];
		lines.push(...entry.selection.text.split(/\n+/).map(l => `> ${l}`), "");
		if (ex.terms.length) {
			lines.push("**這是什麼**");
			for (let t of ex.terms) lines.push(`- **${oneLine(t.term)}**：${oneLine(t.what)}${t.here ? ` 在這段裡：${oneLine(t.here)}` : ""}`);
			lines.push("");
		}
		if (ex.restatement) lines.push(`**這段在說什麼**：${oneLine(ex.restatement)}`, "");
		if (ex.clinical) lines.push(`**臨床上代表什麼**：${oneLine(ex.clinical)}`, "");
		if (ex.cautions.length) {
			lines.push("**要注意的地方**");
			for (let c of ex.cautions) lines.push(`- ${oneLine(c)}`);
			lines.push("");
		}
		if (entry.simpler && entry.simpler.explanation.restatement) {
			lines.push(`**簡單版**：${oneLine(entry.simpler.explanation.restatement)}${entry.simpler.explanation.clinical ? ` ${oneLine(entry.simpler.explanation.clinical)}` : ""}`, "");
		}
		let total = PARTS.reduce((n, p) => n + entry.removed[p], 0);
		lines.push(`*AI 解釋（${[entry.model, String(entry.at).slice(0, 10)].filter(Boolean).join(" · ")}），數字已和原文核對${total ? `；${total} 個不在原文裡的數字已移除` : ""}。*`);
		return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
	}

	function calloutLines(md) {
		return String(md || "").split("\n").map(l => (l.trim() ? `> ${l}` : ">"));
	}

	/** [start, end) of the managed %% zotero-bridge %% block, or null. */
	function managedRange(text) {
		let start = MARK_START_RE.exec(text);
		let end = MARK_END_RE.exec(text);
		if (!start || !end || end.index <= start.index) return null;
		return [start.index, end.index + end[0].length];
	}

	/**
	 * Append one explanation (entryMarkdown) to the literature note's 「統計筆記」 callout. The callout is
	 * looked for, and created, only outside the managed block (core.buildObsidianNote keeps everything
	 * outside it on every re-sync): appended at its end when it exists, else a new folded callout at
	 * the end of the note (under 「✍️ 我的筆記」 when that is the last part, as it usually is).
	 */
	function appendStatsNote(text, md) {
		text = String(text || "");
		let block = calloutLines(md);
		let lines = text.split("\n");
		let range = managedRange(text);
		let offset = 0;
		let found = -1;
		for (let i = 0; i < lines.length; i++) {
			let inside = range && offset >= range[0] && offset < range[1];
			if (!inside && CALLOUT_RE.test(lines[i])) {
				found = i;
				break;
			}
			offset += lines[i].length + 1;
		}
		if (found >= 0) {
			let end = found + 1;
			while (end < lines.length && /^>/.test(lines[end])) end++;
			lines.splice(end, 0, ">", "> ---", ">", ...block);
			return lines.join("\n");
		}
		let callout = [`> [!note]- ${CALLOUT_TITLE}`, `> ${CALLOUT_INTRO}`, ">", ...block].join("\n");
		let body = text.replace(/\s*$/, "");
		return (body ? body + "\n\n" : "") + callout + "\n";
	}

	/** zotero://open-pdf link to the page of the selection (core.annotationURI's form). */
	function pdfLink(libraryPath, selection) {
		if (!selection || !selection.attachmentKey) return "";
		let page = /^\d+$/.test(selection.pageLabel || "") ? selection.pageLabel
			: Number.isInteger(selection.pageIndex) ? String(selection.pageIndex + 1) : "";
		return `zotero://open-pdf/${libraryPath}/items/${selection.attachmentKey}${page ? `?page=${page}` : ""}`;
	}

	/** HTML of the child note: a readable copy of each explanation and the record as JSON. */
	function noteHTML(record, meta = {}) {
		let r = normalizeRecord(record);
		let parts = [`<h1>${NOTE_TITLE}</h1>`,
			`<p><em>ZotMax「讀懂統計」最近 ${MAX_HISTORY} 次的解釋，最新的在最上面${meta.title ? ` · ${escapeHTML(meta.title)}` : ""}。在 ZotMax 面板查看；這份筆記不會同步成你的筆記，也不會送給 AI。</em></p>`];
		for (let e of r.entries) {
			let ex = e.explanation;
			parts.push(`<h2>${escapeHTML([String(e.at).slice(0, 10), pageWords(e.selection)].filter(Boolean).join(" · ") || "統計解釋")}</h2>`);
			parts.push(`<blockquote><p>${escapeHTML(e.selection.text)}</p></blockquote>`);
			if (ex.terms.length) {
				parts.push("<p><strong>這是什麼</strong></p>", `<ul>${ex.terms.map(t => `<li><strong>${escapeHTML(t.term)}</strong>：${escapeHTML(t.what)}${t.here ? ` 在這段裡：${escapeHTML(t.here)}` : ""}</li>`).join("")}</ul>`);
			}
			if (ex.restatement) parts.push(`<p><strong>這段在說什麼</strong>：${escapeHTML(ex.restatement)}</p>`);
			if (ex.clinical) parts.push(`<p><strong>臨床上代表什麼</strong>：${escapeHTML(ex.clinical)}</p>`);
			if (ex.cautions.length) parts.push("<p><strong>要注意的地方</strong></p>", `<ul>${ex.cautions.map(c => `<li>${escapeHTML(c)}</li>`).join("")}</ul>`);
			if (e.simpler && e.simpler.explanation.restatement) parts.push(`<p><strong>簡單版</strong>：${escapeHTML(e.simpler.explanation.restatement)}</p>`);
		}
		parts.push(`<h2>${DATA_HEADING}</h2>`, `<pre>${escapeHTML(JSON.stringify(r, null, 1))}</pre>`);
		return parts.join("\n");
	}

	/** The record in a child note's JSON block (null when there is none or it is broken). */
	function readNoteHTML(html) {
		let blocks = [...String(html || "").matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/gi)].map(m => decodeEntities(m[1]));
		for (let text of blocks.reverse()) {
			let obj = tryJSON(text);
			if (obj && obj.format === FORMAT) return normalizeRecord(obj);
		}
		return null;
	}

	/** Ask before the call? mode "always" | "above" (cost over `threshold` US$; unpriced: no) | "never". */
	function needsConfirm(mode, cost, threshold) {
		if (mode === "always") return true;
		if (mode === "never") return false;
		let limit = Number(threshold);
		if (!Number.isFinite(limit) || limit < 0) limit = DEFAULT_CONFIRM_ABOVE;
		return Number.isFinite(cost) && cost > limit;
	}

	/** Rough tokens: one per CJK character, one per four other characters (review-draft's estimate). */
	function estimateTokens(text) {
		let s = Array.isArray(text) ? text.join("\n") : String(text || "");
		let cjk = (s.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length;
		return Math.ceil(cjk + (s.length - cjk) / 4);
	}

	/** { inputTokens, cost (US$, null when the model is unpriced) } of one call. */
	function estimateCall(prompt, model, prices, usage) {
		let inputTokens = estimateTokens(prompt.system) + estimateTokens(prompt.user);
		let price = usage.priceFor(model, prices);
		return { inputTokens, cost: price ? usage.costOf({ input: inputTokens, output: EXPECTED_OUTPUT_TOKENS }, price) : null };
	}

	// ---------- Zotero ----------

	let pluginID = null;
	let live = false;
	let listener = null;
	// The reader's last text selection, for 「解釋所選統計」
	let lastSelection = null;
	// itemID → what the panel shows besides the saved explanations: { status: "loading" | "error", selection, estimate, message, action }
	let pending = new Map();
	// `${itemID}:${entryID}` → "simpler" | "save" while it runs
	let busy = new Map();
	// itemID → { entryID, name, args } after 存到筆記
	let notes = new Map();
	// Test hooks: confirm(text) instead of Services.prompt.confirm
	const runtime = { confirm: null };

	function ZB() {
		return scope.ZB;
	}

	function alive() {
		return live && !!scope.ZB;
	}

	function log(e) {
		try {
			Zotero.logError(e);
		}
		catch (x) {}
	}

	function pref(key) {
		return Zotero.Prefs.get(PREF + key, true);
	}

	/** The switch, checked live; false after shutdown. */
	function featureOn() {
		let f = alive() && scope.ZB.features;
		return !!f && f.isEnabled(FEATURE);
	}

	function notify(text) {
		ZB().main.notify("ZotMax：讀懂統計", text);
	}

	function refresh() {
		if (!alive()) return;
		try {
			if (ZB() && ZB().sidepanel) ZB().sidepanel.refreshAll();
		}
		catch (e) {
			log(e);
		}
	}

	/** The literature item of an attachment (or the item itself); null for a standalone PDF. */
	function targetItem(item) {
		let it = item;
		try {
			while (it && !it.isRegularItem() && it.parentItem) it = it.parentItem;
			return it && it.isRegularItem() ? it : null;
		}
		catch (e) {
			return null;
		}
	}

	function getNote(item) {
		if (!item || !item.isRegularItem || !item.isRegularItem()) return null;
		for (let note of Zotero.Items.get(item.getNotes())) {
			if (note && note.getTags().some(t => t.tag === NOTE_TAG)) return note;
		}
		return null;
	}

	function loadRecord(item) {
		let note = getNote(item);
		return (note && readNoteHTML(note.getNote())) || emptyRecord();
	}

	/** Save the record as the item's child note (created on first use), quietly for auto-sync. */
	async function saveRecord(item, record) {
		let note = getNote(item);
		if (!note) {
			note = new Zotero.Item("note");
			note.libraryID = item.libraryID;
			note.parentID = item.id;
			note.addTag(NOTE_TAG);
		}
		note.setNote(noteHTML(record, { title: item.getField("title") }));
		ZB().main.markSelfModified(item.id);
		if (note.id) await ZB().main.saveQuietly(note);
		else await note.saveTx();
		ZB().main.markSelfModified(note.id);
		return note;
	}

	function libraryPath(item) {
		try {
			let lib = Zotero.Libraries.get(item.libraryID);
			if (lib && lib.libraryType === "group") return `groups/${Zotero.Groups.getGroupIDFromLibraryID(item.libraryID)}`;
		}
		catch (e) {}
		return "library";
	}

	/** Plain data from the reader's selection (its objects live in the reader's compartment). */
	function plainPosition(position) {
		try {
			let p = JSON.parse(JSON.stringify(position || {}));
			return {
				pageIndex: Number.isInteger(p.pageIndex) ? p.pageIndex : null,
				rects: Array.isArray(p.rects) ? p.rects.slice(0, MAX_RECTS) : [],
			};
		}
		catch (e) {
			return { pageIndex: null, rects: [] };
		}
	}

	// ---------- the reader's text-selection popup ----------

	/**
	 * renderTextSelectionPopup: { reader, doc (the reader's document), params: { annotation: { text,
	 * pageLabel, position } }, append }. append() must be called synchronously. Nothing while the switch
	 * is off.
	 */
	function onSelectionPopup(event) {
		if (!alive() || !featureOn()) return;
		let { reader, doc, params, append } = event || {};
		let ann = params && params.annotation;
		let text = ann && oneLine(ann.text);
		if (!text || !doc || typeof append !== "function") return;
		let position = plainPosition(ann.position);
		let selection = {
			attachmentID: reader && reader.itemID,
			tabID: reader && reader.tabID,
			text: String(ann.text),
			pageLabel: String(ann.pageLabel || ""),
			pageIndex: position.pageIndex,
			rects: position.rects,
			at: Date.now(),
		};
		lastSelection = selection;
		let [id, label] = STRINGS.popup;
		let button = doc.createElement("button");
		button.className = "toolbar-button wide-button";
		button.setAttribute("data-zb-stats", "explain");
		button.setAttribute("data-l10n-id", id);
		button.textContent = label;
		listen(button, "click", () => explain(selection));
		append(button);
		// The reader's document has no ZotMax strings: the main window translates the label
		try {
			let l10n = Zotero.getMainWindow().document.l10n;
			if (l10n && l10n.formatValue) {
				Promise.resolve(l10n.formatValue(id)).then((v) => {
					if (alive() && v) button.textContent = v;
				}).catch(() => {});
			}
		}
		catch (e) {}
	}

	/** The reader listener; returns whether Zotero has the API. */
	function register() {
		if (listener) return true;
		let R = Zotero.Reader;
		if (!R || typeof R.registerEventListener !== "function") {
			Zotero.debug("ZotMax: Zotero.Reader.registerEventListener is missing; 讀懂統計 only through the command");
			return false;
		}
		listener = (event) => {
			if (!alive()) return;
			try {
				onSelectionPopup(event);
			}
			catch (e) {
				log(e);
			}
		};
		R.registerEventListener(POPUP_EVENT, listener, pluginID);
		return true;
	}

	function init(opts = {}) {
		live = true;
		pluginID = opts.pluginID || pluginID;
		register();
	}

	/** Remove the reader listener first, then forget everything. */
	function shutdown() {
		live = false;
		if (listener) {
			try {
				Zotero.Reader.unregisterEventListener(POPUP_EVENT, listener);
			}
			catch (e) {
				log(e);
			}
		}
		listener = null;
		lastSelection = null;
		pending.clear();
		busy.clear();
		notes.clear();
	}

	// ---------- explaining ----------

	/** Methods excerpt (or abstract), title and design · N from the AI note, for the prompt. */
	async function paperContext(item) {
		let data = await ZB().adapter.extractItemData(item, { fullTextLimit: 0, checkFullText: true });
		let md = "";
		if (ZB().features.isEnabled("fullTextMarkdown")) {
			try {
				let prepared = await ZB().fulltext.prepare(data, null, null);
				md = prepared ? prepared.sources.map(s => s.md).join("\n\n") : "";
			}
			catch (e) {
				log(e);
			}
		}
		if (!md) {
			md = (data.fullTextSources || []).filter(s => s.text && s.text.trim()).map(s => fulltextMd.toMarkdown(s.text).md).join("\n\n");
		}
		let excerpt = methodsExcerpt(md);
		let study = null;
		if (data.aiNote) {
			try {
				study = ZB().main.readAINote(data.aiNote.html).data;
			}
			catch (e) {
				log(e);
			}
		}
		return {
			title: data.title,
			methods: excerpt.text,
			methodsKind: excerpt.kind,
			abstract: data.abstract || "",
			study,
			context: excerpt.text ? excerpt.kind : data.abstract ? "abstract" : "none",
		};
	}

	function confirmDialog(text) {
		if (runtime.confirm) return runtime.confirm(text);
		return Services.prompt.confirm(Zotero.getMainWindow(), "ZotMax：讀懂統計", text);
	}

	/** Estimate, and ask first when the settings say so. Returns the estimate, or null when declined. */
	function checkCost(prompt, settings, what) {
		let usage = ZB().usage;
		let est;
		try {
			est = estimateCall(prompt, settings.llm.model, usage.parsePrices(pref("usage.prices")).prices, usage);
		}
		catch (e) {
			log(e);
			est = { inputTokens: 0, cost: null };
		}
		let mode = String(pref("statsExplainer.confirm") || "above");
		let threshold = Number(pref("statsExplainer.confirmAbove"));
		if (!needsConfirm(mode, est.cost, threshold)) return est;
		let cost = est.cost === null
			? `輸入約 ${usage.formatTokens(est.inputTokens)} tokens（這個模型沒有價格資料，無法估算費用）。`
			: `預估費用：約 ${usage.formatUSD(est.cost)}（輸入約 ${usage.formatTokens(est.inputTokens)} tokens）。`;
		let text = `將用 ${settings.llm.model} ${what}，會產生一次 API 費用。\n\n${cost}\n\n要繼續嗎？（確認的時機可以在 設定 → AI → 讀懂統計 調整）`;
		return confirmDialog(text) ? est : null;
	}

	function setPending(itemID, state) {
		if (!alive()) return;
		if (state) pending.set(itemID, state);
		else pending.delete(itemID);
		refresh();
	}

	/** Open the panel's 統計解釋 part and bring the ZotMax section into view (best effort). */
	function reveal() {
		try {
			let S = ZB().sidepanel;
			let open = {};
			try {
				open = JSON.parse(Zotero.Prefs.get(S.OPEN_PREF, true) || "{}") || {};
			}
			catch (e) {
				open = {};
			}
			if (open.stats === false) {
				open.stats = true;
				Zotero.Prefs.set(S.OPEN_PREF, JSON.stringify(open), true);
			}
			let key = S.paneKey;
			for (let win of Zotero.getMainWindows ? Zotero.getMainWindows() : []) {
				for (let details of win.document.querySelectorAll("item-details")) {
					if (key && typeof details.scrollToPane === "function") details.scrollToPane(key, "smooth");
				}
			}
		}
		catch (e) {
			Zotero.debug(`ZotMax: could not reveal the panel: ${e}`);
		}
	}

	function newID() {
		return `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
	}

	/**
	 * Explain a selection ({ attachmentID, text, pageLabel, pageIndex, rects }) of a PDF: the result
	 * goes into the item's child note and the panel. Resolves to the new entry, or null.
	 */
	async function explain(sel) {
		if (!alive()) return null;
		if (!featureOn()) {
			ZB().main.notifyFeatureOff(FEATURE);
			return null;
		}
		let att = sel && sel.attachmentID ? Zotero.Items.get(sel.attachmentID) : null;
		let item = targetItem(att);
		if (!item) {
			notify("這個 PDF 沒有上層文獻條目，解釋沒地方存。先在 Zotero 為它建立上層條目（右鍵 → 建立上層條目），再選一次。");
			return null;
		}
		let text = String((sel && sel.text) || "").trim();
		if (!text) {
			notify("先在 PDF 上選一段文字。");
			return null;
		}
		let selection = normalizeSelection({ text, pageLabel: sel.pageLabel, pageIndex: sel.pageIndex, rects: sel.rects, attachmentKey: att.key });
		reveal();
		// Only this run may change what the panel shows for it (a second selection replaces it)
		let run = {};
		let show = (state) => {
			let now = pending.get(item.id);
			if (now && now.run !== run) return;
			setPending(item.id, state && Object.assign({ run }, state));
		};
		setPending(item.id, { run, status: "loading", selection });
		let settings = await ZB().main.readSettings();
		if (!alive()) return null;
		if (!settings.llm.apiKey) {
			show({ status: "error", selection, message: ["noKey"], action: "settings" });
			return null;
		}
		let input;
		try {
			input = await paperContext(item);
		}
		catch (e) {
			log(e);
			let abstract = item.getField("abstractNote") || "";
			input = { title: item.getField("title"), methods: "", abstract, study: null, context: abstract ? "abstract" : "none" };
		}
		if (!alive()) return null;
		let prompt = buildPrompt(Object.assign({ selection: text }, input));
		let est = checkCost(prompt, settings, "解釋這段文字裡的統計");
		if (!est) {
			show(null);
			return null;
		}
		show({ status: "loading", selection, estimate: est });
		try {
			let result = await ZB().llm.generateText(settings.llm, prompt.system, prompt.user, (u, i) => fetch(u, i), Object.assign({}, ZB().main.runtime.retry));
			if (!alive()) return null;
			ZB().main.recordAIUsage(result);
			let parsed = parseResponse(result.text);
			let checked = checkExplanation(parsed.explanation, prompt.sources);
			let entry = normalizeEntry({
				id: newID(), at: new Date().toISOString(), model: result.model || settings.llm.model,
				selection, context: input.context, explanation: checked.explanation, removed: checked.removed,
				parseError: parsed.ok ? "" : parsed.error,
			});
			await saveRecord(item, addEntry(loadRecord(item), entry));
			if (!alive()) return entry;
			show(null);
			return entry;
		}
		catch (e) {
			log(e);
			if (alive()) show({ status: "error", selection, message: ["failed", { error: String(e.message || e) }] });
			return null;
		}
	}

	/** 「解釋所選統計」: the selection last seen in the reader tab that is showing now. */
	function explainCurrentSelection(win) {
		if (!featureOn()) {
			ZB().main.notifyFeatureOff(FEATURE);
			return Promise.resolve(null);
		}
		let reader = null;
		try {
			let w = win || Zotero.getMainWindow();
			let tabID = w && w.Zotero_Tabs && w.Zotero_Tabs.selectedID;
			reader = tabID && Zotero.Reader.getByTabID ? Zotero.Reader.getByTabID(tabID) : null;
		}
		catch (e) {
			reader = null;
		}
		let sel = lastSelection;
		let fresh = sel && Date.now() - sel.at < SELECTION_TTL_MS;
		if (!reader || !fresh || (reader.itemID !== sel.attachmentID)) {
			notify("先在 PDF 閱讀器裡選取一段含統計數字的文字，再執行一次；也可以直接按選取框裡的「ZotMax：解釋統計」。");
			return Promise.resolve(null);
		}
		return explain(sel);
	}

	function findEntry(item, entryID) {
		let record = loadRecord(item);
		return { record, entry: record.entries.find(e => e.id === entryID) || null };
	}

	/** 「再解釋得簡單一點」: one follow-up call, checked against the selection and the first explanation. */
	async function simplify(item, entryID) {
		if (!alive() || !featureOn()) return null;
		let { entry } = findEntry(item, entryID);
		if (!entry) return null;
		let key = `${item.id}:${entryID}`;
		if (busy.has(key)) return null;
		let settings = await ZB().main.readSettings();
		if (!alive()) return null;
		if (!settings.llm.apiKey) {
			setPending(item.id, { status: "error", selection: entry.selection, message: ["noKey"], action: "settings" });
			return null;
		}
		let prompt = buildSimplerPrompt(entry);
		if (!checkCost(prompt, settings, "用更簡單的說法再解釋一次")) return null;
		busy.set(key, "simpler");
		refresh();
		try {
			let result = await ZB().llm.generateText(settings.llm, prompt.system, prompt.user, (u, i) => fetch(u, i), Object.assign({}, ZB().main.runtime.retry));
			if (!alive()) return null;
			ZB().main.recordAIUsage(result);
			let parsed = parseResponse(result.text);
			let checked = checkExplanation(parsed.explanation, prompt.sources);
			let simpler = { at: new Date().toISOString(), model: result.model || settings.llm.model, explanation: checked.explanation, removed: checked.removed };
			await saveRecord(item, updateEntry(loadRecord(item), entryID, { simpler }));
			return simpler;
		}
		catch (e) {
			log(e);
			if (alive()) notes.set(item.id, { entryID, name: "failed", args: { error: String(e.message || e) } });
			return null;
		}
		finally {
			busy.delete(key);
			if (alive()) refresh();
		}
	}

	/** 「存到筆記」: append to the literature note's 「統計筆記」 callout (outside the managed block). */
	async function saveToNote(item, entryID) {
		if (!alive()) return null;
		let { entry } = findEntry(item, entryID);
		if (!entry) return null;
		let key = `${item.id}:${entryID}`;
		if (busy.has(key)) return null;
		let say = (name, args) => {
			if (!alive()) return;
			notes.set(item.id, { entryID, name, args: args || null });
			refresh();
		};
		if (!ZB().main.vaultSettings().vaultPath) return say("noVault");
		busy.set(key, "save");
		refresh();
		try {
			let target = await ZB().main.literatureNote(item);
			if (!alive()) return null;
			if (!target) return say("notSynced");
			let md = entryMarkdown(entry, pdfLink(libraryPath(item), entry.selection));
			// After any sync in progress, so the two never write the note at the same time
			await ZB().main.enqueue(async () => {
				let text = await IOUtils.readUTF8(target.path);
				await IOUtils.writeUTF8(target.path, appendStatsNote(text, md));
			});
			if (!alive()) return null;
			await saveRecord(item, updateEntry(loadRecord(item), entryID, { savedAt: new Date().toISOString() }));
			say("savedTo");
			return target;
		}
		catch (e) {
			log(e);
			say("saveFailed", { error: String(e.message || e) });
			return null;
		}
		finally {
			busy.delete(key);
			if (alive()) refresh();
		}
	}

	function openSelection(item, selection) {
		try {
			let att = selection.attachmentKey ? Zotero.Items.getByLibraryAndKey(item.libraryID, selection.attachmentKey) : null;
			if (!att) return Promise.resolve(null);
			let location = selection.rects.length && Number.isInteger(selection.pageIndex)
				? { position: { pageIndex: selection.pageIndex, rects: selection.rects } }
				: Number.isInteger(selection.pageIndex) ? { pageIndex: selection.pageIndex } : null;
			return Promise.resolve(location ? Zotero.Reader.open(att.id, location) : Zotero.Reader.open(att.id)).catch(log);
		}
		catch (e) {
			log(e);
			return Promise.resolve(null);
		}
	}

	// ---------- the panel's 統計解釋 part (sidepanel.js draws the folding part) ----------

	function fill(text, args) {
		return String(text).replace(/\{ \$(\w+) \}/g, (m, k) => (args && args[k] !== undefined ? String(args[k]) : m));
	}

	function h(doc, tag, attrs = {}, ...children) {
		let el = doc.createElementNS(HTML_NS, tag);
		for (let [k, v] of Object.entries(attrs)) {
			if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v === true ? "" : String(v));
		}
		for (let c of children) {
			if (c !== null && c !== undefined) el.append(c);
		}
		return el;
	}

	function t(doc, tag, name, args, attrs = {}) {
		let [id, text] = STRINGS[name];
		let el = h(doc, tag, attrs, fill(text, args));
		el.setAttribute("data-l10n-id", id);
		if (args) el.setAttribute("data-l10n-args", JSON.stringify(args));
		return el;
	}

	/** An event listener that does nothing after shutdown and logs instead of throwing (sidepanel's listen). */
	function listen(el, type, fn) {
		el.addEventListener(type, (ev) => {
			if (!alive()) return;
			try {
				let r = fn(ev);
				if (r && typeof r.catch === "function") r.catch(log);
			}
			catch (e) {
				log(e);
			}
		});
	}

	/** Text with every REMOVED marker as its own quiet span (the words say what happened). */
	function checkedText(doc, tag, text, attrs = {}) {
		let el = h(doc, tag, attrs);
		let pieces = String(text || "").split(REMOVED);
		pieces.forEach((p, i) => {
			if (i) el.append(h(doc, "span", { class: "zb-st-removed", "data-zb-removed": "" }, REMOVED));
			if (p) el.append(p);
		});
		return el;
	}

	function removedLine(doc, count) {
		if (!count) return null;
		return count === 1
			? t(doc, "p", "removedOne", null, { class: "zb-st-warning", "data-zb-warning": "" })
			: t(doc, "p", "removedMany", { count }, { class: "zb-st-warning", "data-zb-warning": "" });
	}

	/** The four parts of an explanation. */
	function renderExplanation(doc, answer) {
		let ex = answer.explanation;
		let wrap = h(doc, "div", { class: "zb-st-parts" });
		let section = (part, ...content) => {
			let s = h(doc, "section", { class: "zb-st-part", "data-zb-part": part }, t(doc, "p", part, null, { class: "zb-sp-label" }), ...content);
			let w = removedLine(doc, answer.removed[part]);
			if (w) s.append(w);
			wrap.append(s);
		};
		if (ex.terms.length) {
			let list = h(doc, "dl", { class: "zb-st-terms" });
			for (let term of ex.terms) {
				list.append(checkedText(doc, "dt", term.term));
				let dd = checkedText(doc, "dd", term.what);
				if (term.here) {
					let here = checkedText(doc, "span", term.here, { class: "zb-st-here" });
					here.prepend(t(doc, "span", "here", null, { class: "zb-st-here-label" }));
					dd.append(" ", here);
				}
				list.append(dd);
			}
			section("terms", list);
		}
		else {
			section("terms", t(doc, "p", "noTerms", null, { class: "zb-sp-hint" }));
		}
		if (ex.restatement) section("restatement", checkedText(doc, "p", ex.restatement));
		if (ex.clinical) section("clinical", checkedText(doc, "p", ex.clinical));
		if (ex.cautions.length) section("cautions", h(doc, "ul", { class: "zb-sp-list" }, ...ex.cautions.map(c => checkedText(doc, "li", c))));
		return wrap;
	}

	function quote(doc, item, selection) {
		let q = h(doc, "blockquote", { class: "zb-sp-quote zb-st-quote", "data-zb-selection": "" }, shorten(selection.text, 600));
		let link = selection.pageLabel
			? t(doc, "button", "openPage", { name: selection.pageLabel }, { class: "zb-sp-link", type: "button", "data-zb-action": "open-page" })
			: t(doc, "button", "openPDF", null, { class: "zb-sp-link", type: "button", "data-zb-action": "open-page" });
		listen(link, "click", () => openSelection(item, selection));
		return h(doc, "div", { class: "zb-st-source" }, q, selection.attachmentKey ? h(doc, "p", { class: "zb-st-page" }, link) : null);
	}

	function entryBlock(doc, item, entry) {
		let block = h(doc, "article", { class: "zb-st-entry", "data-zb-entry": entry.id });
		block.append(quote(doc, item, entry.selection));
		if (entry.parseError) block.append(t(doc, "p", "badFormat", null, { class: "zb-sp-hint" }));
		block.append(renderExplanation(doc, entry));
		let key = `${item.id}:${entry.id}`;
		let running = busy.get(key);
		if (entry.simpler) {
			let simple = h(doc, "section", { class: "zb-st-simpler", "data-zb-simpler": "" }, t(doc, "p", "simplerTitle", null, { class: "zb-sp-label" }));
			simple.append(renderExplanation(doc, entry.simpler));
			block.append(simple);
		}
		else if (running === "simpler") {
			block.append(t(doc, "p", "loadingSimpler", null, { class: "zb-sp-hint", role: "status", "aria-busy": "true" }));
		}
		let meta = [entry.model, String(entry.at).slice(0, 10)].filter(Boolean).join(" · ");
		block.append(h(doc, "p", { class: "zb-sp-hint" }, t(doc, "span", "hint"), meta ? ` ${meta}` : ""));
		let actions = h(doc, "div", { class: "zb-sp-actions" });
		let save = entry.savedAt
			? t(doc, "button", "saved", null, { type: "button", disabled: true, "data-zb-action": "stats-save" })
			: t(doc, "button", "save", null, { type: "button", "data-zb-action": "stats-save" });
		if (running === "save") {
			save.disabled = true;
			save.setAttribute("aria-busy", "true");
		}
		listen(save, "click", () => saveToNote(item, entry.id));
		actions.append(save);
		if (!entry.simpler) {
			let simpler = t(doc, "button", "simpler", null, { type: "button", "data-zb-action": "stats-simpler" });
			if (running) {
				simpler.disabled = true;
				if (running === "simpler") simpler.setAttribute("aria-busy", "true");
			}
			listen(simpler, "click", () => simplify(item, entry.id));
			actions.append(simpler);
		}
		block.append(actions);
		let note = notes.get(item.id);
		if (note && note.entryID === entry.id) {
			block.append(t(doc, "p", note.name, note.args, { class: note.name === "savedTo" ? "zb-sp-hint" : "zb-st-error", role: "status", "data-zb-status": note.name }));
		}
		return block;
	}

	function pendingBlock(doc, item, p) {
		let block = h(doc, "article", { class: "zb-st-entry", "data-zb-pending": p.status });
		block.append(quote(doc, item, p.selection));
		if (p.status === "loading") {
			let cost = p.estimate && Number.isFinite(p.estimate.cost) ? ZB().usage.formatUSD(p.estimate.cost) : "";
			block.append(cost
				? t(doc, "p", "loadingCost", { name: cost }, { class: "zb-sp-hint", role: "status", "aria-busy": "true" })
				: t(doc, "p", "loading", null, { class: "zb-sp-hint", role: "status", "aria-busy": "true" }));
			return block;
		}
		let [name, args] = p.message || ["failed", { error: "" }];
		block.append(t(doc, "p", name, args || null, { class: "zb-st-error", role: "alert", "data-zb-error": name }));
		let actions = h(doc, "div", { class: "zb-sp-actions" });
		if (p.action === "settings") {
			let open = t(doc, "button", "openSettings", null, { type: "button", "data-zb-action": "stats-settings" });
			listen(open, "click", () => ZB().commands.openSettings("ai"));
			actions.append(open);
		}
		let dismiss = t(doc, "button", "dismiss", null, { type: "button", "data-zb-action": "stats-dismiss" });
		listen(dismiss, "click", () => setPending(item.id, null));
		actions.append(dismiss);
		block.append(actions);
		return block;
	}

	/** What the panel part needs: null when there is nothing to show (the part is left out). */
	function paneView(item) {
		if (!item || !featureOn()) return null;
		let record = loadRecord(item);
		let p = pending.get(item.id) || null;
		if (!record.entries.length && !p) return null;
		let latest = p ? p.selection : record.entries[0].selection;
		return { record, pending: p, peek: shorten(latest.text, 60) };
	}

	/** Fill the part's body: what is running (or failed), the latest explanation, older ones folded. */
	function renderPane(doc, body, item, view = paneView(item)) {
		if (!view) return;
		let wrap = h(doc, "div", { class: "zb-st", "data-zb-stats": "" });
		if (view.pending) wrap.append(pendingBlock(doc, item, view.pending));
		view.record.entries.forEach((entry, i) => {
			let block = entryBlock(doc, item, entry);
			if (i === 0 && !view.pending) {
				wrap.append(block);
				return;
			}
			let more = h(doc, "details", { class: "zb-sp-more", "data-zb-older": entry.id });
			more.append(h(doc, "summary", {}, [String(entry.at).slice(0, 10), shorten(entry.selection.text, 40)].filter(Boolean).join(" · ")));
			more.append(block);
			wrap.append(more);
		});
		body.append(wrap);
	}

	return {
		FEATURE, NOTE_TAG, FORMAT, NOTE_TITLE, CALLOUT_TITLE, POPUP_EVENT, MAX_HISTORY, REMOVED, SYSTEM_PROMPT, STRINGS, runtime,
		// pure
		methodsExcerpt, buildPrompt, buildSimplerPrompt, explanationText, parseResponse, repairJSON, normalizeExplanation,
		normalizeNumerals, extractNumbers, canonicalNumber, numberSet, stripNumbers, checkExplanation,
		normalizeRecord, addEntry, updateEntry, entryMarkdown, appendStatsNote, pdfLink, noteHTML, readNoteHTML,
		needsConfirm, estimateTokens, estimateCall,
		// Zotero
		init, register, shutdown, explain, explainCurrentSelection, simplify, saveToNote, loadRecord, getNote,
		paneView, renderPane, onSelectionPopup,
		get listening() { return !!listener; },
		get lastSelection() { return lastSelection; },
	};
});
