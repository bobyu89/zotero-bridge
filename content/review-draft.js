/*
 * Zotero Bridge — literature review draft (文獻探討草稿).
 *
 * One LLM call over several items' AI notes (or abstracts + highlights), the user's outline and
 * research question. Sources are labelled [S1], [S2]… by synthesis.js, so the model never writes a
 * reference itself; the labels then become
 *   - Pandoc citations `[@citekey]` / `[@a; @b]` with the keys export.js writes to references.json,
 *     in an Obsidian note `<folder>/Drafts/文獻探討-<name>.md` ready for `pandoc --citeproc`;
 *   - plain (Author, year) citations on a Notion page.
 * Numbers in the draft are checked against the cited sources' notes; sentences whose numbers are
 * not found are listed in a ⚠️ checklist, never changed. Re-running replaces only the
 * `%% zotero-bridge:start/end %%` region of the note and the managed container of the Notion page.
 *
 * The pure helpers at the top are exported for the Node tests; the rest needs Zotero.
 */
(function (root, factory) {
	if (typeof module === "object" && module.exports) {
		module.exports = factory(require("./core.js"), require("./synthesis.js"), require("./verify.js"), require("./usage.js"), globalThis);
	}
	else {
		(root.ZB = root.ZB || {}).reviewDraft = factory(root.ZB.core, root.ZB.synthesis, root.ZB.verify, root.ZB.usage, root);
	}
})(this, function (core, synthesis, verify, usage, root) {
	const PREF = "extensions.zotero-bridge.";
	// { "<scope key>": { outline, question, notionPageId, updatedAt } }
	const STORE_PREF = "reviewDraft.scopes";
	const MAX_STORED_SCOPES = 50;
	const MAX_ITEMS = 60;
	const DRAFTS_FOLDER = "Drafts";
	const REFERENCES_FILE = "references.json";
	const FILTER_FILE = "zotero-bridge-draft.lua";
	const DIALOG_TITLE = "Zotero Bridge：文獻探討草稿";
	const CHECK_HEADING = "⚠️ 查核清單";
	const PANDOC_HEADING = "Pandoc 指令";
	const USER_SECTION = "## ✍️ 我的筆記\n\n";
	const NOTION_CONTAINER_TITLE = "文獻探討草稿（重新產生會覆寫，修改請寫在此區塊外）";
	const MARK_START = "%% zotero-bridge:start — 此區塊由 Zotero Bridge 自動產生，重新產生草稿時會覆寫 %%";
	const MARK_START_RE = /^%% zotero-bridge:start.*%%[ \t]*$/m;
	const MARK_END_RE = /^%% zotero-bridge:end %%[ \t]*$/m;
	// Output budget for the cost estimate: llm.js asks Claude for at most 16000 tokens (thinking included)
	const EXPECTED_OUTPUT_TOKENS = 8000;
	const MAX_OUTPUT_TOKENS = 16000;

	const DEFAULT_REVIEW_PROMPT = `你是護理與醫學領域的學術寫作助理，依據提供的文獻資料，為研究生撰寫碩士論文「文獻探討」章節的草稿。

寫作規則：
- 使用臺灣學術繁體中文；醫學、統計與研究方法術語保留英文，或第一次出現時以「中文（English）」呈現。
- 以主題組織論述、整合多篇文獻：比較與對照研究結果，說明結果是否一致及可能原因（族群、場域、介入方式、測量工具、研究設計的差異），並評論證據品質（研究設計、樣本、證據等級、嚴格評讀結果與限制）。
- 不要逐篇摘要，也不要寫成「[S1] 指出…；[S2] 指出…」的流水帳；每段以論點開頭，再用多篇文獻支持或對照。
- 引用只能使用提供的代號 [S1]、[S2]…，放在所支持的子句或句子末尾、句號之前；同時引用多篇寫成 [S1, S3]；需要頁碼寫成 [S1, p. 5]。不要寫作者姓名、年份或「等人」，不要把代號當作句子主詞，也不要自行列出參考文獻（系統會轉換成 Pandoc 引文與 APA 7 參考文獻）。
- 每個實證陳述都要標註代號；沒有文獻支持的推論，寫明是研究者的觀點。
- 數字（樣本數、百分比、p 值、效應量、信賴區間）只能照抄提供資料中的數值並標註來源代號；資料中沒有的數字不要寫，不要四捨五入或換算。
- 不得編造研究、作者、數據或結論；資料不足時寫「現有文獻尚未報告」。
- 最後一節歸納研究缺口（族群、場域、介入、測量或方法上的不足），並說明使用者的研究如何回應這些缺口。
- 避免空泛形容詞與套語（例如「至關重要」「綜上所述」「值得注意的是」）；每段 150–300 字。
- 只輸出 Markdown 標題與段落：不要使用表格、條列或粗體，不要加前言或結語說明。

輸出格式：
- 每一節用「## 節標題」。使用者提供大綱時，依大綱的順序與文字作為節標題（可在節內用「### 小標」細分）；大綱沒有涵蓋研究缺口時，最後加一節「## 文獻小結與研究缺口」。
- 沒有大綱時，自行歸納 3–6 個主題，最後一節為「## 文獻小結與研究缺口」。
- 不要輸出「文獻探討」總標題，也不要輸出參考文獻。
`;

	// ---------- prompt (pure) ----------

	const STUDY_LABELS = [
		["study_design", "研究設計"], ["sample_size", "樣本數"], ["setting", "場域"], ["population", "對象"],
		["intervention", "介入／暴露"], ["comparison", "對照"], ["outcomes", "結果指標"], ["measures", "測量工具"],
		["evidence_level", "Oxford CEBM 證據等級"], ["jbi_level", "JBI 證據等級"], ["appraisal_tool", "評讀工具"],
		["appraisal_overall", "嚴格評讀結論"], ["country", "國家"],
	];

	/** The AI note's structured data (llm.js normalizeStudyData) as labelled lines; "" when none. */
	function studyDataLines(study) {
		if (!study) return "";
		let lines = [];
		for (let [key, label] of STUDY_LABELS) {
			let v = study[key];
			if (Array.isArray(v)) v = v.join("; ");
			if (v === null || v === undefined || v === "") continue;
			lines.push(`${label}：${v}`);
		}
		return lines.length ? `<study_data>\n${lines.join("\n")}\n</study_data>` : "";
	}

	/** Outline text from the dialog → section titles (one per line; Markdown bullets and #s removed). */
	function parseOutline(text) {
		return String(text || "").split(/\r?\n/)
			.map(l => l.replace(/^\s*(?:#{1,6}\s+|[-*•]\s+)/, "").trim())
			.filter(Boolean)
			.slice(0, 30);
	}

	/**
	 * @param {object[]} sources [{ data, aiMarkdown, study, annotationsText }]
	 * @param {object} opts { outline: string[], question, systemPrompt }
	 * @returns {{ system, user, entries }} entries as synthesis.buildSynthesisPrompt (with citekey)
	 */
	function buildReviewPrompt(sources, opts = {}) {
		let outline = opts.outline || [];
		let question = String(opts.question || "").trim();
		return synthesis.buildSynthesisPrompt(
			sources.map(src => Object.assign({}, src, { extra: studyDataLines(src.study) })),
			{
				systemPrompt: (opts.systemPrompt && opts.systemPrompt.trim()) || DEFAULT_REVIEW_PROMPT,
				blocks: [
					`<my_study>\n研究問題／目的：${question || "（未提供；最後一節請依文獻歸納研究缺口與後續研究方向）"}\n</my_study>`,
					outline.length
						? `<outline>\n${outline.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n</outline>\n請依這個大綱的順序與文字作為各節標題（## 節標題）。`
						: "<outline>（未提供：請自行歸納 3–6 個主題）</outline>",
				],
				closing: "請依照系統指示撰寫文獻探討草稿。",
			});
	}

	/** Rough token count for the cost estimate (CJK ≈ 1 token per character, other text ≈ 4 characters per token). */
	function estimateTokens(text) {
		let s = String(text || "");
		let cjk = (s.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length;
		return Math.ceil(cjk + (s.length - cjk) / 4);
	}

	/**
	 * Cost of one draft at the price table: { inputTokens, expected, max } in USD, or null when the
	 * model is unpriced (expected: ~8000 output tokens; max: the 16000-token output limit).
	 */
	function estimateDraftCost(system, user, model, prices) {
		let price = usage.priceFor(model, prices);
		let inputTokens = estimateTokens(system) + estimateTokens(user);
		if (!price) return { inputTokens, expected: null, max: null };
		return {
			inputTokens,
			expected: usage.costOf({ input: inputTokens, output: EXPECTED_OUTPUT_TOKENS }, price),
			max: usage.costOf({ input: inputTokens, output: MAX_OUTPUT_TOKENS }, price),
		};
	}

	// ---------- the model's answer (pure) ----------

	const TRUNCATED_RE = /^>\s*⚠️\s*輸出(?:達到長度上限|未完成).*$/m;

	/** Tidy the model output: no outer code fence, no "文獻探討" H1, no reference list; H1 sections → H2. */
	function cleanDraft(text) {
		let md = String(text || "").replace(/\r\n?/g, "\n").trim();
		let truncated = TRUNCATED_RE.test(md);
		md = md.replace(TRUNCATED_RE, "").trim();
		let fence = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i.exec(md);
		if (fence) md = fence[1].trim();
		md = md.replace(/^#\s+.*文獻探討.*\n+/, "");
		if (!/^##\s/m.test(md)) md = md.replace(/^#\s/gm, "## ");
		let refs = /^#{1,6}\s*(?:參考文獻|參考資料|references?|reference list|bibliography)\s*$/im.exec(md);
		if (refs) md = md.slice(0, refs.index);
		return { md: md.trim(), truncated };
	}

	// ---------- number check (pure) ----------

	// Numbers in text already passed through verify.normalizeForMatch (NFKC + lower case, so full-width
	// digits are ASCII and "SF-36" / "COVID-19" became "sf36" / "covid19", which the look-behind skips)
	const NUMBER_RE = /(?<![a-z\u00c0-\u024f\d.]|[a-z\u00c0-\u024f][-\u2010\u2011\u2013])(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?!\d)|(?<![a-z\u00c0-\u024f\d])\.\d+/gu;

	function canonicalNumber(raw) {
		let s = String(raw).replace(/,/g, "");
		if (s.startsWith(".")) s = "0" + s;
		let n = Number(s);
		return Number.isFinite(n) ? String(n) : s;
	}

	/** Every number in a text: [{ raw, value, percent }] (value is canonical: "0.05", "1234"). */
	function extractNumbers(text) {
		let s = verify.normalizeForMatch(text);
		let out = [];
		for (let m of s.matchAll(NUMBER_RE)) {
			let after = s.slice(m.index + m[0].length, m.index + m[0].length + 16);
			out.push({ raw: m[0], value: canonicalNumber(m[0]), percent: /^\s*%/.test(after), after });
		}
		return out;
	}

	/** Numbers in the draft worth checking: not years ("2020 年"), counts of studies, the "95" of 95% CI, or small integers. */
	function checkableNumbers(text) {
		return extractNumbers(text).filter((n) => {
			let integer = !/[.]/.test(n.raw);
			if (n.percent && /^\s*%\s*(?:ci\b|信賴區間|confidence)/.test(n.after)) return false;
			if (integer && !n.percent) {
				if (Number(n.value) < 10) return false;
				if (/^\s*(?:年|個?年代|篇|項研究|個研究|個主題|節|章)/.test(n.after)) return false;
			}
			return true;
		});
	}

	/** Everything a source's numbers may legitimately come from: bibliographic data, AI note, study data, abstract, highlights. */
	function sourceText(src) {
		let d = src.data || {};
		let parts = [d.title, d.year, d.date, d.publication, src.aiMarkdown, studyDataLines(src.study), d.abstract, src.annotationsText];
		for (let att of d.attachments || []) {
			for (let ann of att.annotations || []) parts.push(ann.text, ann.comment);
		}
		return parts.filter(Boolean).join("\n");
	}

	// Not global: .test() must not carry lastIndex over to the shared global CITATION_RE
	const HAS_CITATION_RE = new RegExp(synthesis.CITATION_RE.source, "iu");

	function stripCitations(text) {
		return String(text).replace(synthesis.CITATION_RE, " ");
	}

	/** Paragraphs of body text (headings, fences and blank lines separate them; each list item or table row is its own). */
	function paragraphs(md) {
		let out = [];
		let current = [];
		let inFence = false;
		let flush = () => {
			if (current.length) out.push(current.join(" "));
			current = [];
		};
		for (let line of String(md || "").split("\n")) {
			if (/^\s*```/.test(line)) {
				flush();
				inFence = !inFence;
				continue;
			}
			if (inFence) continue;
			if (!line.trim() || /^#{1,6}\s/.test(line) || /^%%.*%%\s*$/.test(line)) {
				flush();
				continue;
			}
			if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line) || /^\s*\|/.test(line)) flush();
			current.push(line.trim());
			if (/^\s*\|/.test(line)) flush();
		}
		flush();
		return out;
	}

	function citedIds(text, known) {
		let ids = [];
		for (let m of String(text).matchAll(synthesis.CITATION_RE)) {
			for (let l of synthesis.parseCitation(m[0])) {
				if (known.has(l.id) && !ids.includes(l.id)) ids.push(l.id);
			}
		}
		return ids;
	}

	/**
	 * Sentences whose numbers don't occur in the sources they cite. A sentence without its own
	 * citation is checked against the citations of its paragraph; ids is empty when there is no
	 * known source to check against (no citation, or only unknown labels).
	 * @param {Map<string, string>} texts source id → text (sourceText)
	 * @returns {Array<{ sentence, missing: string[], ids: string[] }>} ids empty = no citation at all
	 */
	function checkNumbers(md, entries, texts) {
		let known = new Set(entries.map(e => e.id));
		let numberSets = new Map();
		let numbersOf = (id) => {
			if (!numberSets.has(id)) numberSets.set(id, new Set(extractNumbers(texts.get(id) || "").map(n => n.value)));
			return numberSets.get(id);
		};
		let flagged = [];
		for (let para of paragraphs(md)) {
			let paraIds = citedIds(para, known);
			for (let sentence of para.split(/(?<=[。！？!?])/)) {
				if (!sentence.trim()) continue;
				let numbers = checkableNumbers(stripCitations(sentence));
				if (!numbers.length) continue;
				// A sentence with its own citation (even an unknown label) is checked against that alone
				let ids = HAS_CITATION_RE.test(sentence) ? citedIds(sentence, known) : paraIds;
				let missing = numbers.filter(n => !ids.some(id => numbersOf(id).has(n.value)));
				if (missing.length) {
					flagged.push({
						sentence: sentence.trim(),
						missing: [...new Set(missing.map(n => n.raw + (n.percent ? "%" : "")))],
						ids,
					});
				}
			}
		}
		return flagged;
	}

	/** Entries the draft never cites. */
	function uncitedEntries(md, entries) {
		let cited = new Set(citedIds(md, new Set(entries.map(e => e.id))));
		return entries.filter(e => !cited.has(e.id));
	}

	/**
	 * Everything derived from the model's answer.
	 * @param {Map<string,string>} texts source id → sourceText()
	 * @returns {{ md, pandoc, plain, issues: { numbers, unknown, uncited, truncated, noCitations } }}
	 */
	function processDraft(text, entries, texts) {
		let { md, truncated } = cleanDraft(text);
		let unknown = [];
		let pandoc = synthesis.resolveCitations(md, entries, "pandoc", {}, { flagUnknown: true, unknown });
		let plain = synthesis.resolveCitations(md, entries, "plain", {}, { flagUnknown: true });
		let uncited = uncitedEntries(md, entries);
		return {
			md, pandoc, plain,
			issues: {
				numbers: checkNumbers(md, entries, texts),
				unknown: [...new Set(unknown)],
				uncited,
				truncated,
				noCitations: uncited.length === entries.length,
			},
		};
	}

	function issueCount(issues) {
		return issues.numbers.length + issues.unknown.length + (issues.truncated ? 1 : 0) + (issues.noCitations ? 1 : 0);
	}

	function shorten(s, max = 160) {
		s = String(s).replace(/\s+/g, " ").trim();
		return s.length > max ? s.slice(0, max - 1) + "…" : s;
	}

	/** The checklist as Markdown list items (without the leading "- "). */
	function issueLines(issues, entries) {
		let byId = new Map(entries.map(e => [e.id, e]));
		let lines = [];
		if (issues.truncated) lines.push("**輸出不完整**：AI 輸出達到長度上限，最後一節可能被截斷；可減少文獻篇數或縮短大綱後重新產生。");
		if (issues.noCitations) lines.push("**沒有任何引用**：草稿沒有使用 [S#] 代號，所有論點都需要自行補上引用。");
		for (let id of issues.unknown) {
			lines.push(`**未知來源代號**：${id}（草稿中標為【⚠️ 未知來源】，Pandoc 不會轉換；請刪除或改成正確的文獻）`);
		}
		for (let f of issues.numbers) {
			let sentence = shorten(synthesis.resolveCitations(f.sentence, entries, "plain", {}, { flagUnknown: true }));
			if (f.ids.length) {
				let who = f.ids.map(id => byId.get(id).citation).join("; ");
				lines.push(`**數字**：「${sentence}」— 在 ${who} 的 AI 筆記、摘要與劃線中找不到 ${f.missing.join("、")}`);
			}
			else {
				lines.push(`**數字（沒有可查核的來源）**：「${sentence}」— ${f.missing.join("、")}`);
			}
		}
		if (issues.uncited.length && !issues.noCitations) {
			lines.push(`**未引用的文獻**（僅供參考）：${issues.uncited.map(e => e.citation).join("; ")}`);
		}
		return lines;
	}

	const CHECK_CAVEAT = "數字只和各篇的 AI 筆記、結構化資料、摘要與劃線比對，不是 PDF 全文；論述是否忠於原文、引用是否放對位置，仍需逐篇回原文確認。系統只列出問題，沒有修改草稿內容。";

	function checklistObsidian(issues, entries) {
		let lines = issueLines(issues, entries);
		let count = issueCount(issues);
		let head = count
			? `> [!warning] ${count} 項需要回原文確認`
			: "> [!success] 草稿中需要查核的數字都能在所引用文獻的筆記或摘要中找到";
		return [`## ${CHECK_HEADING}`, "", head, ...lines.map(l => `> - ${l}`), ">", `> ${CHECK_CAVEAT}`].join("\n");
	}

	function checklistPlain(issues, entries) {
		let lines = issueLines(issues, entries);
		return [`## ${CHECK_HEADING}`, "",
			...(lines.length ? lines.map(l => `- ${l}`) : ["- 草稿中需要查核的數字都能在所引用文獻的筆記或摘要中找到。"]),
			"", CHECK_CAVEAT].join("\n");
	}

	// ---------- Obsidian note and Pandoc (pure) ----------

	/** Relative path from a folder (parts) to a file (parts), with "/" separators. */
	function relativePath(fromDirParts, toParts) {
		let i = 0;
		while (i < fromDirParts.length && i < toParts.length - 1 && fromDirParts[i] === toParts[i]) i++;
		return [...Array(fromDirParts.length - i).fill(".."), ...toParts.slice(i)].join("/");
	}

	function shellQuote(s) {
		return /^[\p{L}\p{N}._\/@+-]+$/u.test(s) ? s : `"${String(s).replace(/(["\\$`])/g, "\\$1")}"`;
	}

	/**
	 * Where the draft goes and how Pandoc reaches the bibliography from there.
	 * @param {string[]} folderParts the vault's default Zotero folder (references.json lives there)
	 */
	function draftPaths(folderParts, name) {
		let base = `文獻探討-${core.sanitizeFilename(name)}`;
		let dirParts = [...folderParts, DRAFTS_FOLDER];
		let referencesRel = relativePath(dirParts, [...folderParts, REFERENCES_FILE]);
		// apa.csl in the vault root, as the README's Pandoc section says
		let cslRel = relativePath(dirParts, ["apa.csl"]);
		let fileName = base + ".md";
		return {
			dirParts,
			fileName,
			relPath: [...dirParts, fileName].join("/"),
			referencesRel,
			cslRel,
			docx: base + ".docx",
			command: `pandoc ${shellQuote(fileName)} --citeproc --bibliography ${shellQuote(referencesRel)} --csl ${shellQuote(cslRel)}`
				+ ` --lua-filter ${FILTER_FILE} -o ${shellQuote(base + ".docx")}`,
		};
	}

	// Drops what is only meant for Obsidian when the draft is converted to Word
	const PANDOC_FILTER = `-- Zotero Bridge：把文獻探討草稿轉成 Word 時，略過 Obsidian 註解（%% … %%）、提示框（> [!info] …）
-- 以及「${CHECK_HEADING}」「${PANDOC_HEADING}」「我的筆記」各節。這個檔案由插件產生，重新產生草稿時會覆寫。
local SKIP = { "查核清單", "${PANDOC_HEADING}", "我的筆記" }

local function skipped(text)
  for _, word in ipairs(SKIP) do
    if text:find(word, 1, true) then return true end
  end
  return false
end

function Pandoc(doc)
  local out = {}
  local skipLevel = nil
  for _, b in ipairs(doc.blocks) do
    if b.t == "Header" then
      if skipLevel and b.level <= skipLevel then skipLevel = nil end
      if not skipLevel and skipped(pandoc.utils.stringify(b)) then skipLevel = b.level end
    end
    if not skipLevel then
      local text = pandoc.utils.stringify(b)
      local comment = (b.t == "Para" or b.t == "Plain") and text:sub(1, 2) == "%%"
      local callout = b.t == "BlockQuote" and text:sub(1, 2) == "[!"
      if not comment and not callout then table.insert(out, b) end
    end
  end
  doc.blocks = out
  return doc
end
`;

	function pandocSection(paths) {
		return [
			`## ${PANDOC_HEADING}`,
			"",
			`在這份筆記所在的資料夾（\`${paths.dirParts.join("/")}\`）開啟終端機執行：`,
			"",
			"```bash",
			paths.command,
			"```",
			"",
			`- \`${paths.referencesRel}\`：Zotero → 工具 → 匯出參考文獻到 Obsidian 產生；產生草稿時插件已檢查過，缺少引用的文獻會自動重新匯出。`,
			`- \`${paths.cslRel}\`：APA 7 樣式檔，放在 vault 根目錄（見 README「在 Obsidian 寫論文並用 Pandoc 產生 APA Word」）。`,
			`- \`${FILTER_FILE}\`：插件放在同一資料夾，轉檔時略過 %% 標記、提示框、查核清單、本節與「我的筆記」；不加 \`--lua-filter\` 也能轉，只是 Word 會多出這些內容。`,
		].join("\n");
	}

	function referenceCallout(entries) {
		let rows = entries.map(e => ({
			key: e.citekey,
			ref: e.data.apa || `${e.citation}. ${e.data.title || ""}`.trim(),
		})).sort((a, b) => a.ref.localeCompare(b.ref, "en"));
		return ["> [!abstract]- 引用對照（citekey → APA 7；Word 版的參考文獻由 Pandoc 產生）",
			...rows.map(r => `> - ${r.key ? `\`@${r.key}\`` : "（沒有 citekey）"}：${r.ref}`)].join("\n");
	}

	function oneLine(s) {
		return String(s || "").replace(/\s+/g, " ").trim();
	}

	/**
	 * The plugin-managed region: info callout, draft (Pandoc citations), reference placeholder for
	 * citeproc, citekey → APA list, checklist, Pandoc command.
	 * meta: { model, generatedAt, question, paths, withoutAI: [citation], truncatedSources: [citation] }
	 */
	function buildManagedRegion(result, entries, meta) {
		let info = [
			"> [!info] AI 產生的文獻探討草稿（不可直接當作定稿）",
			`> 由 ${meta.model || "AI"} 依 ${entries.length} 篇文獻於 ${String(meta.generatedAt || "").slice(0, 10)} 產生。研究問題／目的：${oneLine(meta.question) || "（未提供）"}`,
			"> 每個論點、數字與引用都必須回原文確認（見文末「⚠️ 查核清單」）。引文是 Pandoc 格式 `[@citekey]`，轉成 Word 時才會變成 APA 引文。要修改內容請複製到標記外或論文檔：重新產生時，這個區塊會被覆寫。",
		];
		if (meta.withoutAI && meta.withoutAI.length) info.push(`> 沒有 AI 筆記、改用摘要與劃線的文獻：${meta.withoutAI.join("; ")}`);
		if (meta.truncatedSources && meta.truncatedSources.length) info.push(`> 內容過長、只使用前段的文獻：${meta.truncatedSources.join("; ")}`);
		return [
			MARK_START,
			info.join("\n"),
			result.pandoc.trim(),
			"## 參考文獻\n\n::: {#refs}\n:::",
			referenceCallout(entries),
			checklistObsidian(result.issues, entries),
			pandocSection(meta.paths),
			core.MARK_END,
		].join("\n\n");
	}

	/**
	 * The Obsidian note. With `existing`, only the managed region and the plugin's frontmatter keys
	 * change; the user's own text and keys stay.
	 * meta: buildManagedRegion's, plus { title, scope, notionUrl }
	 */
	function buildDraftNote(existing, result, entries, meta) {
		let managedKeys = [
			["type", "lit-review-draft"],
			["scope", meta.scope || ""],
			["sources", entries.map(e => `${e.data.libraryPath}/${e.data.key}`)],
			["citekeys", entries.map(e => e.citekey).filter(Boolean)],
			["generated_at", meta.generatedAt || ""],
			["model", meta.model || ""],
		];
		if (meta.notionUrl) managedKeys.push(["notion", meta.notionUrl]);
		let region = buildManagedRegion(result, entries, meta);
		let frontmatter = existing ? core.splitFrontmatter(existing).frontmatter : null;
		let body = existing ? core.splitFrontmatter(existing).body : null;
		let fm = managedKeys.reduce((acc, [k, v]) => core.setFrontmatterValue(acc, k, v), frontmatter || "");
		if (body === null) {
			body = `\n# ${meta.title}\n\n${region}\n\n${USER_SECTION}`;
		}
		else {
			let start = MARK_START_RE.exec(body);
			let end = MARK_END_RE.exec(body);
			if (start && end && end.index > start.index) {
				body = body.slice(0, start.index) + region + body.slice(end.index + end[0].length);
			}
			else {
				// Markers removed by the user: a fresh region after the first heading
				let h1 = /^# .*$/m.exec(body);
				let at = h1 ? h1.index + h1[0].length : 0;
				body = body.slice(0, at) + "\n\n" + region + "\n" + body.slice(at);
			}
			if (!body.startsWith("\n")) body = "\n" + body;
		}
		return `---\n${fm}\n---\n${body}`;
	}

	/** Markdown for Notion: plain (Author, year) citations, the checklist and the APA reference list. */
	function buildDraftPlain(result, entries, meta) {
		return [
			`> AI 產生的文獻探討草稿（${meta.model || "AI"}，${String(meta.generatedAt || "").slice(0, 10)}，${entries.length} 篇文獻）。每個論點、數字與引用都必須回原文確認。`
				+ (oneLine(meta.question) ? `研究問題／目的：${oneLine(meta.question)}` : ""),
			result.plain.trim(),
			synthesis.referenceList(entries),
			checklistPlain(result.issues, entries),
		].join("\n\n");
	}

	// ---------- outline store (pure) ----------

	function parseStore(text) {
		try {
			let obj = JSON.parse(text || "{}");
			if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
			let out = {};
			for (let [k, v] of Object.entries(obj)) {
				if (v && typeof v === "object" && !Array.isArray(v)) out[k] = v;
			}
			return out;
		}
		catch (e) {
			return {};
		}
	}

	/** The saved entry for the first key that has one (e.g. this selection, then its collection); {} if none. */
	function scopeEntry(store, keys) {
		for (let key of keys) {
			if (key && store[key]) return store[key];
		}
		return {};
	}

	/** New store with `patch` merged into `key`; only the most recently used scopes are kept. */
	function updateStore(store, key, patch, now = new Date().toISOString()) {
		let out = Object.assign({}, store);
		out[key] = Object.assign({}, out[key], patch, { updatedAt: now });
		let keys = Object.keys(out).sort((a, b) => String(out[b].updatedAt || "").localeCompare(String(out[a].updatedAt || "")));
		for (let old of keys.slice(MAX_STORED_SCOPES)) delete out[old];
		return out;
	}

	/**
	 * Store key, fallback key and display name for a menu scope. A collection run is keyed by the
	 * collection; selected items by the collection they were selected in (falling back to that
	 * collection's outline the first time).
	 */
	function draftScope(scope, selectedCollections = []) {
		let ref = c => `${c.libraryID}/${c.key || c.id}`;
		if (scope && scope.collection) {
			return { key: `C:${ref(scope.collection)}`, fallback: null, name: scope.label || scope.collection.name };
		}
		let col = selectedCollections[0];
		return {
			key: col ? `S:${ref(col)}` : "S:selection",
			fallback: col ? `C:${ref(col)}` : null,
			name: (scope && scope.label) || "選取的文獻",
		};
	}

	// ---------- Zotero side ----------

	// Test hook: { ask } replaces the outline dialog
	let runtime = {};

	function pref(key) {
		return Zotero.Prefs.get(PREF + key, true);
	}

	function readStore() {
		return parseStore(pref(STORE_PREF));
	}

	function saveScope(key, patch) {
		try {
			Zotero.Prefs.set(PREF + STORE_PREF, JSON.stringify(updateStore(readStore(), key, patch)), true);
		}
		catch (e) {
			Zotero.logError(e);
		}
	}

	function notify(text) {
		root.ZB.main.notify("Zotero Bridge：文獻探討草稿", text);
	}

	const HTML_NS = "http://www.w3.org/1999/xhtml";

	/**
	 * The outline dialog: an HTML <dialog> on the main window with the research question and a
	 * multi-line outline. Resolves { question, outline } or null (cancelled). Falls back to two
	 * Services.prompt fields (sections separated by 「；」) where a modal <dialog> can't be shown.
	 */
	function askOptions(win, init) {
		let doc = win && win.document;
		let dialog = null;
		try {
			dialog = doc.createElementNS(HTML_NS, "dialog");
		}
		catch (e) {}
		if (!dialog || typeof dialog.showModal !== "function") return Promise.resolve(askWithPrompts(win, init));
		return new Promise((resolve) => {
			let el = (tag, style, text) => {
				let e = doc.createElementNS(HTML_NS, tag);
				if (style) e.setAttribute("style", style);
				if (text !== undefined) e.textContent = text;
				return e;
			};
			let field = (label, hint, value, rows, placeholder) => {
				let wrap = el("label", "display: block; margin: 10px 0 0;");
				wrap.append(el("div", "font-weight: 600;", label), el("div", "opacity: 0.75; font-size: 0.92em; margin: 2px 0 4px;", hint));
				let area = el("textarea", "width: 100%; box-sizing: border-box; font: inherit; resize: vertical;");
				area.setAttribute("rows", String(rows));
				if (placeholder) area.setAttribute("placeholder", placeholder);
				area.value = value || "";
				wrap.append(area);
				return { wrap, area };
			};
			dialog.setAttribute("style", "width: min(640px, 92vw); padding: 16px 18px; border: 1px solid rgba(128,128,128,0.5); border-radius: 8px; background: Canvas; color: CanvasText; font: message-box;");
			let question = field("研究問題／目的", "會用在最後一節（研究缺口與本研究）。", init.question, 3,
				"例如：探討護理師主導衛教對住院高齡病人跌倒預防的成效");
			let outline = field("主題大綱（每行一個小節，可留空讓 AI 自行歸納）", "依你的論文章節順序；會存成這個分類的預設，下次重新產生沿用。", init.outline, 8,
				"例如：\n住院病人跌倒的現況與影響\n跌倒預防衛教介入的成效\n測量工具與評估指標\n文獻小結與研究缺口");
			let buttons = el("div", "display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px;");
			let cancel = el("button", "", "取消");
			let ok = el("button", "font-weight: 600;", "下一步（確認費用）");
			for (let b of [cancel, ok]) b.setAttribute("type", "button");
			buttons.append(cancel, ok);
			dialog.append(
				el("div", "font-size: 1.15em; font-weight: 600;", `文獻探討草稿：${init.name}（${init.count} 篇）`),
				question.wrap, outline.wrap, buttons);
			cancel.addEventListener("click", () => dialog.close("cancel"));
			ok.addEventListener("click", () => dialog.close("ok"));
			dialog.addEventListener("close", () => {
				let result = dialog.returnValue === "ok"
					? { question: question.area.value.trim(), outline: outline.area.value.replace(/\r\n?/g, "\n").trim() }
					: null;
				dialog.remove();
				resolve(result);
			}, { once: true });
			(doc.body || doc.documentElement).append(dialog);
			try {
				dialog.showModal();
			}
			catch (e) {
				Zotero.logError(e);
			}
			if (!dialog.open) {
				dialog.remove();
				resolve(askWithPrompts(win, init));
			}
		});
	}

	function askWithPrompts(win, init) {
		let question = { value: init.question || "" };
		if (!Services.prompt.prompt(win, DIALOG_TITLE, "研究問題／目的（用在最後一節：研究缺口與本研究）", question, null, {})) return null;
		let outline = { value: parseOutline(init.outline).join("；") };
		if (!Services.prompt.prompt(win, DIALOG_TITLE, "主題大綱：各小節以「；」分隔，可留空讓 AI 自行歸納", outline, null, {})) return null;
		return { question: question.value.trim(), outline: outline.value.split(/[；;]/).map(s => s.trim()).filter(Boolean).join("\n") };
	}

	function confirmText(settings, prompt, sources, extra) {
		let withoutAI = sources.filter(s => !s.aiMarkdown).length;
		let lines = [
			`將用 ${settings.llm.model} 依 ${sources.length} 篇文獻${extra}撰寫文獻探討草稿，會產生一次 API 費用。`,
		];
		try {
			let est = estimateDraftCost(prompt.system, prompt.user, settings.llm.model, usage.parsePrices(pref("usage.prices")).prices);
			lines.push(est.expected === null
				? `輸入約 ${usage.formatTokens(est.inputTokens)} tokens（這個模型沒有價格資料，無法估算費用）。`
				: `預估費用：約 ${usage.formatUSD(est.expected)}（輸入約 ${usage.formatTokens(est.inputTokens)} tokens、輸出以約 ${usage.formatTokens(EXPECTED_OUTPUT_TOKENS)} tokens 估算；最多約 ${usage.formatUSD(est.max)}）。`);
		}
		catch (e) {
			Zotero.logError(e);
		}
		if (withoutAI) lines.push(`其中 ${withoutAI} 篇沒有 AI 筆記，會改用摘要與劃線；先產生 AI 筆記可提高草稿品質。`);
		lines.push("", "要繼續嗎？");
		return lines.join("\n");
	}

	function selectedCollections(context) {
		return ((context && context.collectionTreeRows) || []).filter(r => r.isCollection && r.isCollection()).map(r => r.ref);
	}

	/**
	 * Menu entry (items or a collection): ask for the outline, confirm the cost, then generate after
	 * any sync in progress.
	 * @param {object} scope { label, collection } as main.js builds it
	 */
	async function run(items, scope, context) {
		let ZB = root.ZB;
		items = ZB.adapter.toRegularItems(items);
		if (items.length < 2) {
			notify("文獻探討草稿至少需要 2 篇文獻。");
			return;
		}
		let settings;
		try {
			settings = await ZB.main.readSettings();
		}
		catch (e) {
			notify(`設定有誤：${e.message || e}`);
			return;
		}
		if (!settings.llm.apiKey) {
			notify("文獻探討草稿需要 LLM API key：請到 設定 → Zotero Bridge 填入。");
			return;
		}
		if (!settings.vaultPath && !(settings.notionToken && settings.notionSynthesisParent)) {
			notify("請先在設定填入 Obsidian vault 路徑（Pandoc 版草稿），或 Notion token 與「文獻比較表的 Notion 父頁面」。");
			return;
		}
		let extra = items.length > MAX_ITEMS ? `（超過 ${MAX_ITEMS} 篇，只使用前 ${MAX_ITEMS} 篇）` : "";
		items = items.slice(0, MAX_ITEMS);
		let where = draftScope(scope, selectedCollections(context));
		let saved = scopeEntry(readStore(), [where.key, where.fallback]);
		let win = Zotero.getMainWindow();
		let answer = await (runtime.ask || askOptions)(win, {
			name: where.name, count: items.length, outline: saved.outline || "", question: saved.question || "",
		});
		if (!answer) return;
		saveScope(where.key, { outline: answer.outline || "", question: answer.question || "" });

		let sources = [];
		for (let item of items) {
			let data = await ZB.adapter.extractItemData(item, { fullTextLimit: 0 });
			let note = data.aiNote ? ZB.main.readAINote(data.aiNote.html) : null;
			sources.push({
				item, data,
				aiMarkdown: note ? note.md : "",
				study: note ? note.data : null,
				annotationsText: ZB.llm.formatAnnotationsForPrompt(data),
			});
		}
		let prompt = buildReviewPrompt(sources, { outline: parseOutline(answer.outline), question: answer.question });
		if (!Services.prompt.confirm(win, "Zotero Bridge", confirmText(settings, prompt, sources, extra))) return;
		return ZB.main.enqueue(() => generate(sources, prompt, settings, where, answer));
	}

	async function writeIfChanged(path, text) {
		if (await IOUtils.exists(path) && await IOUtils.readUTF8(path) === text) return false;
		await IOUtils.writeUTF8(path, text);
		return true;
	}

	/** Make sure references.json has every cited key (export.js); returns a line for the progress window. */
	async function ensureReferences(settings, folderParts, entries) {
		let path = PathUtils.join(settings.vaultPath, ...folderParts, REFERENCES_FILE);
		let ids = new Set();
		if (await IOUtils.exists(path)) {
			try {
				for (let e of JSON.parse(await IOUtils.readUTF8(path))) ids.add(e.id);
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
		let keys = entries.map(e => e.citekey).filter(Boolean);
		if (ids.size && keys.every(k => ids.has(k))) return `${REFERENCES_FILE} 已包含全部 ${keys.length} 篇引用文獻。`;
		await root.ZB.bibliography.exportLibrary();
		return `已重新匯出 ${REFERENCES_FILE}（原本缺少部分引用文獻）。`;
	}

	/** Notion: the stored page for this scope (unless deleted) or a new child page of the synthesis parent. */
	async function writeNotion(settings, where, title, markdown, saved) {
		let ZB = root.ZB;
		let client = new ZB.notion.NotionClient({ token: settings.notionToken, fetch: (u, i) => fetch(u, i) });
		let page = null;
		if (saved.notionPageId) {
			try {
				let p = await client.request("GET", `pages/${saved.notionPageId}`);
				if (p && !p.in_trash && !p.archived) page = p;
			}
			catch (e) {
				if (!(e.status === 404 || e.status === 400)) throw e;
			}
		}
		if (!page) page = await client.createChildPage(settings.notionSynthesisParent, title, [], "📝");
		await client.replaceManagedContainer(page.id, NOTION_CONTAINER_TITLE, ZB.markdown.mdToNotionBlocks(markdown));
		saveScope(where.key, { notionPageId: page.id });
		return page.url || "";
	}

	async function generate(sources, prompt, settings, where, answer) {
		let ZB = root.ZB;
		let entries = prompt.entries;
		let title = `文獻探討：${where.name}`;
		let pw = new Zotero.ProgressWindow({ closeOnClick: true });
		pw.changeHeadline(DIALOG_TITLE);
		pw.show();
		let line = new pw.ItemProgress("note", `AI 撰寫文獻探討草稿中（${entries.length} 篇）…可能需要幾分鐘`);
		try {
			let runTotals = { ledger: {} };
			let result = await ZB.llm.generateText(settings.llm, prompt.system, prompt.user, (u, i) => fetch(u, i),
				Object.assign({ onRetry: ZB.main.retryStatus(s => line.setText(s)) }, ZB.main.runtime.retry));
			ZB.main.recordAIUsage(result, runTotals);
			let texts = new Map(sources.map((src, i) => [entries[i].id, sourceText(src)]));
			let draft = processDraft(result.text, entries, texts);
			let meta = {
				title,
				scope: where.name,
				model: result.model || settings.llm.model,
				generatedAt: new Date().toISOString(),
				question: answer.question,
				withoutAI: entries.filter((e, i) => !sources[i].aiMarkdown).map(e => e.citation),
				truncatedSources: entries.filter(e => e.truncated).map(e => e.citation),
			};
			let outputs = [];
			let errors = [];
			let notes = [];

			if (settings.notionToken && settings.notionSynthesisParent) {
				line.setText("寫入 Notion…");
				try {
					let saved = scopeEntry(readStore(), [where.key]);
					meta.notionUrl = await writeNotion(settings, where, title, buildDraftPlain(draft, entries, meta), saved);
					outputs.push("Notion");
				}
				catch (e) {
					errors.push(`Notion：${e.message || e}`);
				}
			}

			if (settings.vaultPath) {
				line.setText("寫入 Obsidian…");
				try {
					let folderParts = core.splitFolder(settings.defaults.obsidianFolder);
					meta.paths = draftPaths(folderParts, where.name);
					let dir = PathUtils.join(settings.vaultPath, ...meta.paths.dirParts);
					await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
					let path = PathUtils.join(dir, meta.paths.fileName);
					let existing = (await IOUtils.exists(path)) ? await IOUtils.readUTF8(path) : null;
					await IOUtils.writeUTF8(path, buildDraftNote(existing, draft, entries, meta));
					await writeIfChanged(PathUtils.join(dir, FILTER_FILE), PANDOC_FILTER);
					outputs.push(`Obsidian（${meta.paths.relPath}）`);
					let missingKeys = entries.filter(e => !e.citekey).map(e => e.citation);
					if (missingKeys.length) notes.push(`⚠️ 沒有 citekey 的文獻（Pandoc 無法引用）：${missingKeys.join("; ")}`);
					try {
						notes.push(await ensureReferences(settings, folderParts, entries));
					}
					catch (e) {
						Zotero.logError(e);
						notes.push(`⚠️ 無法更新 ${REFERENCES_FILE}：${e.message || e}；請手動執行 工具 → 匯出參考文獻到 Obsidian`);
					}
				}
				catch (e) {
					errors.push(`Obsidian：${e.message || e}`);
				}
			}
			else {
				notes.push("沒有設定 Obsidian vault：只寫入 Notion（Pandoc 版草稿需要 vault）。");
			}

			line.setText(`${title} — 已寫入 ${outputs.join("、") || "（無）"}`);
			if (errors.length) {
				line.setError();
				errors.forEach(e => Zotero.logError(new Error(e)));
				pw.addDescription(errors.join("\n"));
			}
			else {
				line.setProgress(100);
			}
			let count = issueCount(draft.issues);
			pw.addDescription(count ? `⚠️ 查核清單有 ${count} 項需要回原文確認（見草稿文末）。` : "數字查核：沒有發現對不上的數字；仍請回原文確認。");
			for (let n of notes) pw.addDescription(n);
			let usageLine = ZB.main.runUsageLine(runTotals);
			if (usageLine) pw.addDescription(usageLine);
			pw.startCloseTimer(errors.length || count ? 20000 : 10000);
			return { draft, meta, outputs, errors };
		}
		catch (e) {
			Zotero.logError(e);
			line.setText(`失敗：${e.message || e}`);
			line.setError();
			pw.startCloseTimer(20000);
			return null;
		}
	}

	return {
		DEFAULT_REVIEW_PROMPT, STORE_PREF, FILTER_FILE, PANDOC_FILTER, MAX_ITEMS,
		studyDataLines, parseOutline, buildReviewPrompt, estimateTokens, estimateDraftCost,
		cleanDraft, extractNumbers, checkableNumbers, sourceText, checkNumbers, uncitedEntries, processDraft,
		issueLines, relativePath, draftPaths, buildManagedRegion, buildDraftNote, buildDraftPlain,
		parseStore, scopeEntry, updateStore, draftScope,
		askOptions, askWithPrompts, run, runtime,
	};
});
