/*
 * ZotMax — evidence-based health care report draft (實證健康照護報告草稿).
 *
 * Drafts a report in the structure of the Taiwan Nurses Association (台灣護理學會) EBHC
 * synthesis article (A 類實證健康照護綜整文章): 題目, 中英文摘要, 前言, 方法 (PICO, 文獻搜尋,
 * 文獻評讀), 證據綜整, 臨床應用, 結論與建議, 參考文獻. The structure, the per-study appraisal
 * layout and the score allocation follow the twna-ebhc-report writing guide (see README).
 *
 * One LLM call writes the narrative only. Everything that can be built from data is built by the
 * plugin, not the model:
 *   - the PICO keyword table (from the dialog),
 *   - the search strategy and the PRISMA mini-summary with its flow diagram (screening.js counts of
 *     the collection; the query of a PubMed watch for it, or a PICO search string from search-links.js),
 *   - the evidence table (design, N, Oxford CEBM 2011 level, appraisal tool and verdict, key finding)
 *     from each study's AI-note structured data,
 *   - the references (Pandoc [@citekey] with the keys of references.json; Chinese APA via apa-zh.js),
 *   - the ⚠️ checklist (review-draft.js number check plus EBHC-specific checks) and a self-check
 *     mapping each scoring item to the section that addresses it (not a score).
 * The model cites with [S#] labels only (synthesis.js), so it never writes a reference itself.
 * Re-running replaces only the `%% zotero-bridge:start/end %%` region of the note and the managed
 * container of the Notion page.
 *
 * The pure helpers at the top are exported for the Node tests; the rest needs Zotero.
 */
(function (root, factory) {
	if (typeof module === "object" && module.exports) {
		module.exports = factory(require("./core.js"), require("./synthesis.js"), require("./usage.js"), require("./review-draft.js"),
			require("./screening.js"), require("./search-links.js"), require("./pubmed-watch.js"), require("./llm.js"), require("./apa-zh.js"), globalThis);
	}
	else {
		let ZB = root.ZB;
		ZB.ebhcReport = factory(ZB.core, ZB.synthesis, ZB.usage, ZB.reviewDraft, ZB.screening, ZB.searchLinks, ZB.pubmedWatch, ZB.llm, ZB.apaZh, root);
	}
})(this, function (core, synthesis, usage, reviewDraft, screening, searchLinks, pubmedWatch, llm, apaZh, root) {
	const PREF = "extensions.zotero-bridge.";
	// { "<scope key>": { scenario, population, …, notionPageId, updatedAt } } (review-draft.js store helpers)
	const STORE_PREF = "ebhcReport.scopes";
	const MAX_ITEMS = 12;
	const DRAFTS_FOLDER = "Drafts";
	const REFERENCES_FILE = "references.json";
	const FILTER_FILE = "zotero-bridge-ebhc.lua";
	const FILE_PREFIX = "實證報告-";
	const DIALOG_TITLE = "ZotMax：實證健康照護報告草稿";
	const CHECK_HEADING = "⚠️ 查核清單";
	const SCORE_HEADING = "📋 評分項目自我檢核";
	const PANDOC_HEADING = "Pandoc 指令";
	const USER_SECTION = "## ✍️ 我的筆記\n\n";
	const NOTION_CONTAINER_TITLE = "實證健康照護報告草稿（重新產生會覆寫，修改請寫在此區塊外）";
	const MARK_START = "%% zotero-bridge:start — 此區塊由 ZotMax 自動產生，重新產生報告時會覆寫 %%";
	const MARK_START_RE = /^%% zotero-bridge:start.*%%[ \t]*$/m;
	const MARK_END_RE = /^%% zotero-bridge:end %%[ \t]*$/m;
	const TODO = "〔待補";
	// TWNA A 類 limits (characters, rough count)
	const ABSTRACT_LIMIT = 1200;
	const BODY_LIMIT = 6000;

	const QUESTION_TYPES = [
		{ id: "therapy", label: "治療／介入（Therapy）" },
		{ id: "prognosis", label: "預後（Prognosis）" },
		{ id: "diagnosis", label: "診斷（Diagnosis）" },
		{ id: "etiology", label: "病因／傷害（Etiology／Harm）" },
		{ id: "qualitative", label: "質性／意義（Qualitative／Meaning）" },
	];

	// Oxford CEBM 2011 Levels of Evidence, the column for each question type (for the prompt)
	const CEBM_COLUMNS = {
		therapy: "治療效益（Does this intervention help?）：Level 1 隨機對照試驗的系統性回顧或 n-of-1 試驗；Level 2 隨機對照試驗或效果極顯著的觀察性研究；Level 3 非隨機對照的世代／追蹤研究；Level 4 病例系列、病例對照或歷史對照研究；Level 5 機轉推論。",
		prognosis: "預後（What will happen if we do not add a therapy?）：Level 1 起始世代研究（inception cohort）的系統性回顧；Level 2 起始世代研究；Level 3 世代研究或隨機對照試驗的對照組；Level 4 病例系列、病例對照或品質不佳的預後世代研究；Level 5 不適用。",
		diagnosis: "診斷（Is this diagnostic test accurate?）：Level 1 採一致參考標準且盲化的橫斷性研究之系統性回顧；Level 2 採一致參考標準且盲化的個別橫斷性研究；Level 3 非連續收案或參考標準不一致的研究；Level 4 病例對照研究或參考標準不佳／不獨立；Level 5 機轉推論。",
		etiology: "傷害（What are the harms?）：Level 1 隨機對照試驗、巢式病例對照或效果極顯著的觀察性研究之系統性回顧；Level 2 個別隨機對照試驗或效果極顯著的觀察性研究；Level 3 非隨機對照的世代／追蹤研究；Level 4 病例系列、病例對照或歷史對照研究；Level 5 機轉推論。",
		qualitative: "質性問題：Oxford CEBM 2011 沒有質性研究的等級，改用 JBI Levels of Evidence for Meaningfulness，並說明理由。",
	};

	const DESIGN_ZH = {
		"meta-analysis": "系統性回顧與統合分析",
		"systematic review": "系統性回顧",
		"scoping review": "範域回顧",
		RCT: "隨機對照試驗（RCT）",
		"quasi-experimental": "類實驗研究",
		cohort: "世代研究",
		"case-control": "病例對照研究",
		"cross-sectional": "橫斷性研究",
		qualitative: "質性研究",
		"mixed methods": "混合方法研究",
		guideline: "臨床指引",
		other: "其他",
	};
	const DESIGN_RANK = ["meta-analysis", "systematic review", "RCT", "quasi-experimental", "cohort", "case-control",
		"cross-sectional", "qualitative", "mixed methods", "scoping review", "guideline", "other"];
	const REVIEW_DESIGNS = new Set(["meta-analysis", "systematic review"]);

	const PICO_KEYS = [
		{ key: "population", letter: "P", label: "族群／問題（Patient／Problem）" },
		{ key: "intervention", letter: "I", label: "介入措施（Intervention）" },
		{ key: "comparison", letter: "C", label: "對照（Comparison）" },
		{ key: "outcomes", letter: "O", label: "結果（Outcome）" },
	];

	const DEFAULT_EBHC_PROMPT = `你是臺灣護理實證健康照護（EBHC）的寫作助理，依據提供的文獻資料、臨床案例情境與 PICO，為護理人員撰寫台灣護理學會「實證健康照護綜整文章」（A 類）格式的報告草稿。PICO 關鍵字表、文獻搜尋策略、PRISMA 流程、證據表與參考文獻由系統另外產生，你只撰寫下列各節的敘述。

寫作規則：
- 使用臺灣學術繁體中文；術語保留英文，或第一次出現時寫「中文（English）」並寫出縮寫全名。描述文獻結果用「研究結果顯示…」「文獻指出…」；分析與建議用「本文…」「筆者…」；不要用「本研究」。
- 引用只能使用提供的代號 [S1]、[S2]…，放在所支持的子句或句子末尾、句號之前；同時引用多篇寫成 [S1, S3]；需要頁碼寫成 [S1, p. 5]。不要寫作者姓名、年份或「等人」，不要自行列出參考文獻（系統會轉換成 Pandoc 引文與 APA 7 參考文獻）。中文摘要與英文摘要依格式不放引用代號；其餘各節的每個實證陳述都要標註代號。
- 數字（樣本數、百分比、效應值、95% CI、p 值、I²、NNT）只能照抄提供資料中的數值並標註來源代號；資料中沒有的數字不要寫，不要四捨五入、換算或自行計算（包括 NNT）。效應值、95% CI 與 p 值盡量三者並列；資料缺少其中任何一項時，寫「〔待補：回原文確認 95% CI〕」這類標記，不可推測。
- 不得編造研究、作者、數據、病人對話或臨床情境。病人說的話只能引用使用者提供的案例情境原文（用「」）；案例情境沒有病人原話時，寫「〔待補：病人實際說的話〕」。前言的流行病學數據若提供的文獻沒有，寫「〔待補：盛行率與臨床負擔的統計數據及出處〕」，不要憑常識補數字。
- 文獻評讀只根據各篇的 AI 筆記（「嚴格評讀」逐題結果、證據等級與結構化資料）：沿用該篇使用的評讀工具與題目，逐題轉成評讀表，不要自行增刪題目或改變答案；筆記沒有評讀或資訊不足時，評讀結果寫「不清楚」，評析根據寫「〔待補：AI 筆記未提供，請依全文評讀〕」。評析根據要引用文中的具體方法或數字，不可只寫「是」或「符合」；「否」或「不清楚」要說明對研究品質的影響（例如盲化不可行是此類介入的固有限制）。
- 證據等級採 Oxford CEBM 2011，依本報告的問題類型判斷；AI 筆記的等級是依治療效益問題判定，問題類型不同時要說明並標示「〔待確認〕」。
- 整體證據與建議要誠實：說明結果的一致性、精確度、偏差風險與間接性（研究族群、場域與本案例的差異），給出整體證據確定性（高／中／低／極低，參考 GRADE 精神）並說明理由；證據不足時明說「現有證據不足以支持…」，不要誇大效果。必須說明副作用或不良事件（文獻未報告時寫明未報告）與需注意的族群。
- 臨床建議要可操作（誰執行、對象與時機、方法、頻率、每次時間、持續期間、如何衛教推廣），但介入的頻率、時間與劑量只能取自文獻；文獻沒有的參數寫「〔待補〕」。
- 表格儲存格內不要換行。避免空泛套語（例如「至關重要」「綜上所述」「值得注意的是」）。

輸出格式：只輸出下列 ## 標題與內容，標題文字必須完全一致並依此順序；不要輸出 # 總標題、PICO 表、搜尋策略、證據表或參考文獻。

## 題目
（第一行中文題目、第二行英文題目；用問句反映 PICO，中英文一致，例如「〔族群〕使用〔介入措施〕是否能〔改善結果〕？」）

## 中文摘要
**形成臨床提問**：…
**文獻搜尋的方法與分析**：…（只用提供的搜尋資料：資料庫、限制條件、搜尋與納入篇數）
**文獻的品質評讀**：…（評讀工具、各篇 Oxford CEBM 2011 證據等級、主要效應值）
**結論與建議**：…
關鍵詞：3–5 個，以「、」分隔
（全段 1,200 字以內，不放引用代號）

## 英文摘要
**Ask an answerable question (PICO)**: …
**The Method and Analysis of Literature Review**: …
**Critical Appraisal**: …
**Conclusions and Recommendations**: …
**Key Words**: …
（內容與數值和中文摘要一致）

## 前言
（四段：臨床情境觸發（引用案例情境中病人的話）→ 背景與重要性 → 現行處置的局限 → 本文動機與目的；最後一句寫「故本文以此形成臨床問題，探討〔族群〕使用〔介入措施〕是否可〔結果〕。」）

## 形成臨床提問
（依案例情境描述病人（年齡、診斷、治療狀況、病人的話），以「依據實證護理五大步驟，形成一個可回答的問題」銜接，寫出問題類型，並以 P、I、C、O 各一句呈現；系統會在這一節後面附上 PICO 關鍵字表）

## 文獻的品質評讀
（先一段說明評讀工具與 Oxford CEBM 2011 證據等級的判定方式；系統會在這一節前面附上證據表。接著每篇文獻一個小節，依代號順序，小節標題寫成「### [S1] 研究設計」，每節依序包含：
**可信度快速評估**：三句，分別回答研究對象能否代表本案例、結果是否在不同情境被重複驗證、應用於臨床最可能在哪個環節失敗。
評讀表：| 評讀項目 | 評讀結果 | 評析根據 |（題目來自該篇 AI 筆記的評讀清單）
**主要研究成果**：效應值 + 95% CI + p 值（有統合分析時加上 I² 與固定／隨機效應模型）
**證據等級**：Oxford CEBM 2011 Level X 與一句理由
**引用信心**：【高信心】、【中信心】或【低信心】與一句理由）

## 證據綜整
（整合各篇結果的一致與差異、效益與傷害、整體證據確定性與理由、證據的限制）

## 臨床應用
（把證據套用到案例情境：病人的價值觀與偏好、臨床情境與資源、在臺灣的可行性與文化接受度、可操作的照護建議、副作用與需注意的族群、追蹤評值的指標）

## 結論與建議
（結論摘要；具體臨床建議，用「故本文臨床建議可…」的句型；應用限制，以「惟…」銜接；未來研究建議）
`;

	// The model's sections, in output order; `match` finds a heading the model reworded
	const MODEL_SECTIONS = [
		{ key: "title", heading: "題目", match: /^(?:中英文)?題目/ },
		{ key: "abstractZh", heading: "中文摘要", match: /中文摘要/ },
		{ key: "abstractEn", heading: "英文摘要", match: /英文摘要|english\s+abstract|^abstract/i },
		{ key: "intro", heading: "前言", match: /^前言|背景/ },
		{ key: "question", heading: "形成臨床提問", match: /臨床提問|臨床問題|pico/i },
		{ key: "appraisal", heading: "文獻的品質評讀", match: /評讀/ },
		{ key: "synthesis", heading: "證據綜整", match: /綜整|^結果/ },
		{ key: "application", heading: "臨床應用", match: /臨床應用|應用/ },
		{ key: "conclusion", heading: "結論與建議", match: /結論/ },
	];

	// Score allocation of the TWNA A 類 writing guide (twna-ebhc-report skill, 發表準則暨撰寫指引 1141020 修訂版)
	const SCORING = [
		{ id: "title", item: "中英文題目", points: 5, where: "題目", focus: "中英文題目一致；以問句反映 PICO" },
		{ id: "abstract", item: "摘要", points: 13, where: "中文摘要、英文摘要", focus: "四小節齊全；效應值 + 95% CI + p 值；關鍵詞 3–5 個；各 1,200 字以內；中英文內容與數值一致" },
		{ id: "intro", item: "前言", points: 5, where: "前言", focus: "臨床情境（病人原話）→ 背景與重要性（附數據與出處）→ 現況與差距 → 動機與目的" },
		{ id: "pico", item: "方法：形成臨床提問（PICO）", points: 10, where: "方法 一、形成臨床提問（含表一）", focus: "病人案例描述；問題類型；P、I、C、O 完整（C 不可漏、O 為可測量的指標）；中英文關鍵字、同義字與 MeSH" },
		{ id: "search", item: "方法：文獻搜尋的方法與分析", points: 20, where: "方法 二、文獻搜尋的方法與分析（含圖一）", focus: "資料庫（至少 Cochrane Library、PubMed；護理主題加 CINAHL；本土資料庫）與搜尋日期；布林邏輯檢索式；限制條件與理由；PRISMA 流程圖與各層排除原因；最高證據等級優先（理想為 1 篇 SR + 2 篇 RCT）" },
		{ id: "appraisal", item: "方法：文獻的品質評讀", points: 25, where: "方法 三、文獻的品質評讀（含表二）", focus: "每篇逐題完整評讀（依現行準則的評讀工具版本）；評析引用文中具體內容；效應值三元組；Oxford CEBM 2011 證據等級；評讀者分工與意見不一致的處理" },
		{ id: "conclusion", item: "結論與建議", points: 12, where: "結果：證據綜整、臨床應用、結論與建議", focus: "結論摘要與成效數值；可操作的建議（誰、何時、如何、頻率、多久）；副作用與禁忌；應用限制；未來研究建議" },
		{ id: "references", item: "參考文獻", points: 5, where: "參考文獻", focus: "APA 第 7 版；中文文獻不加英譯；內文引用與參考文獻一致" },
	];

	// ---------- prefill (pure) ----------

	function text(v) {
		return v === null || v === undefined ? "" : String(v).trim();
	}

	function sameKey(s) {
		return text(s).normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
	}

	/**
	 * PICO for the dialog from the studies' structured data. A field is prefilled only when every
	 * study that has it says the same thing (ignoring case, spaces and punctuation); otherwise it is
	 * left empty and the distinct values are returned in `variants` for the dialog's hint.
	 * @param {object[]} studies AI-note structured data (null for a study without one)
	 * @returns {{ fields, consistent, variants }} keyed by population / intervention / comparison / outcomes
	 */
	function picoPrefill(studies) {
		let fields = {};
		let consistent = {};
		let variants = {};
		for (let { key } of PICO_KEYS) {
			let values = [];
			let seen = new Set();
			for (let s of studies || []) {
				let v = text(s && s[key]);
				if (!v || seen.has(sameKey(v))) continue;
				seen.add(sameKey(v));
				values.push(v);
			}
			consistent[key] = values.length === 1;
			fields[key] = values.length === 1 ? values[0] : "";
			variants[key] = values.length > 1 ? values : [];
		}
		return { fields, consistent, variants };
	}

	/** "qualitative" when every study with a design is qualitative; otherwise "therapy". */
	function guessQuestionType(studies) {
		let designs = (studies || []).map(s => text(s && s.study_design)).filter(Boolean);
		return designs.length && designs.every(d => d === "qualitative") ? "qualitative" : "therapy";
	}

	function questionTypeLabel(id) {
		let t = QUESTION_TYPES.find(q => q.id === id);
		return t ? t.label : QUESTION_TYPES[0].label;
	}

	/** Watches that feed this collection: same collection path, or their 追蹤/<name> tag on its items. */
	function matchWatches(watches, collectionPath, itemTags = []) {
		let tags = new Set(itemTags);
		let path = text(collectionPath);
		return (watches || []).filter(w => (path && text(w.collection) === path) || tags.has(pubmedWatch.WATCH_TAG_PREFIX + w.name));
	}

	function databasesFromPrisma(prisma) {
		if (!prisma) return "";
		let named = prisma.sources.filter(([s]) => s !== screening.NO_SOURCE);
		let list = named.map(([s, n]) => `${s}（n = ${n}）`);
		if (prisma.other) list.push(...prisma.other.sources.filter(([s]) => s !== screening.NO_SOURCE).map(([s, n]) => `${s}（其他方法，n = ${n}）`));
		return list.join("、");
	}

	/** The PRISMA 2020 counts as one sentence in the style of TWNA reports. */
	function prismaSentence(prisma) {
		if (!prisma) return "";
		let c = prisma.counts;
		let src = databasesFromPrisma(prisma);
		let parts = [`資料庫與登錄庫共搜尋 ${c.identified} 篇${src ? `（${src}）` : ""}`, `排除重複文獻 ${c.duplicates} 篇`,
			`閱讀標題與摘要篩選 ${c.screened} 篇，排除 ${c.taExcluded} 篇`];
		if (c.taPending) parts.push(`尚有 ${c.taPending} 篇未完成標題摘要篩選`);
		parts.push(`全文評估 ${c.assessed} 篇${c.notRetrieved ? `（另有 ${c.notRetrieved} 篇無法取得全文）` : ""}`);
		let reasons = prisma.reasons.map(([r, n]) => `${r} ${n} 篇`).join("、");
		parts.push(`排除 ${c.ftExcluded} 篇${reasons ? `（${reasons}）` : ""}`);
		if (c.ftPending) parts.push(`尚有 ${c.ftPending} 篇未完成全文評估`);
		if (prisma.other) parts.push(`另以其他方法（引文追蹤等）找到 ${prisma.other.counts.identified} 篇，納入 ${prisma.other.counts.included} 篇`);
		parts.push(`最後納入 ${prisma.totalIncluded === undefined ? c.included : prisma.totalIncluded} 篇進行評讀`);
		return parts.join("，") + "。";
	}

	/**
	 * Search details for the dialog: databases and the screening summary from the collection's
	 * PRISMA counts (screening.js), the query from the PubMed watches for it (pubmed-watch.js), or else
	 * a PICO search string (search-links.js) marked as not yet run.
	 * @returns {{ databases, query, queryNote, limits, searchDate, screening }}
	 */
	function searchPrefill({ prisma = null, watches = [], pico = {} } = {}) {
		let databases = databasesFromPrisma(prisma);
		let query = "";
		let queryNote = "";
		let limits = "";
		if (watches.length) {
			query = watches.map(w => pubmedWatch.watchTerm(w)).join("\n");
			queryNote = `PubMed 追蹤「${watches.map(w => w.name).join("」「")}」的檢索式`;
			if (!databases) databases = "PubMed";
			let since = watches.map(w => w.since).filter(Boolean);
			if (since.length) limits = `出版日期：${since.join("／")} 起（PubMed 追蹤設定）`;
		}
		else {
			let q = searchLinks.picoQuery(pico, {});
			if (q) {
				query = q.en || q.all;
				queryNote = "依 PICO 自動組成（尚未實際檢索；請在各資料庫加上 MeSH 與同義字後執行）";
			}
		}
		return { databases, query, queryNote, limits, searchDate: "", screening: prismaSentence(prisma) };
	}

	/**
	 * The dialog's initial values: what was saved for this scope wins, except the screening summary,
	 * which is recounted from the PRISMA tags every time.
	 */
	function dialogInit(saved, derived) {
		saved = saved || {};
		let pick = key => (text(saved[key]) ? saved[key] : (derived[key] || ""));
		let init = {};
		for (let key of ["scenario", "population", "intervention", "comparison", "outcomes", "questionType", "databases", "query", "limits", "searchDate", "screening"]) {
			init[key] = pick(key);
		}
		if (derived.prismaLive) init.screening = derived.screening;
		if (!QUESTION_TYPES.some(q => q.id === init.questionType)) init.questionType = "therapy";
		return init;
	}

	// ---------- sources and the evidence table (pure) ----------

	function levelRank(study) {
		let n = Number(text(study && study.evidence_level));
		return n >= 1 && n <= 5 ? n : 9;
	}

	function designRank(study) {
		let i = DESIGN_RANK.indexOf(text(study && study.study_design));
		return i < 0 ? DESIGN_RANK.length : i;
	}

	/** Highest evidence first (CEBM level, then design), newest first: S1 is the strongest study. */
	function orderSources(sources) {
		return sources.map((s, i) => ({ s, i })).sort((a, b) => levelRank(a.s.study) - levelRank(b.s.study)
			|| designRank(a.s.study) - designRank(b.s.study)
			|| Number(b.s.data.year || 0) - Number(a.s.data.year || 0)
			|| a.i - b.i).map(x => x.s);
	}

	/** One heading's section ("## 嚴格評讀") out of a note: { section, rest }. */
	function takeSection(md, heading) {
		let re = new RegExp(`^(#{1,6})\\s*${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
		let m = re.exec(md || "");
		if (!m) return { section: "", rest: md || "" };
		let after = md.slice(m.index + m[0].length);
		let next = new RegExp(`^#{1,${m[1].length}}\\s`, "m").exec(after);
		let end = next ? m.index + m[0].length + next.index : md.length;
		return { section: md.slice(m.index, end).trim(), rest: (md.slice(0, m.index) + md.slice(end)).trim() };
	}

	/**
	 * The prompt: synthesis.js labels, each source's structured data and its appraisal sections up
	 * front (so a long note's truncation can't cut them off), the scenario, PICO, CEBM column and
	 * search summary.
	 * @param {object[]} sources [{ data, aiMarkdown, study, annotationsText }] in label order
	 * @param {object} opts { answer, evidenceSummary, systemPrompt }
	 */
	function buildEbhcPrompt(sources, opts = {}) {
		let a = opts.answer || {};
		let prepared = sources.map((src) => {
			let md = src.aiMarkdown || "";
			let appraisal = takeSection(md, llm.APPRAISAL_HEADING);
			let level = takeSection(appraisal.rest, "證據等級");
			let kept = [appraisal.section, level.section].filter(Boolean).join("\n\n");
			return Object.assign({}, src, {
				aiMarkdown: kept ? level.rest : md,
				extra: [reviewDraft.studyDataLines(src.study), kept ? `<appraisal_from_ai_note>\n${kept}\n</appraisal_from_ai_note>` : ""].filter(Boolean).join("\n"),
			});
		});
		let pico = PICO_KEYS.map(p => `${p.letter}（${p.label}）：${text(a[p.key]) || "（未提供）"}`).join("\n");
		let type = QUESTION_TYPES.some(q => q.id === a.questionType) ? a.questionType : "therapy";
		let search = [
			`資料庫：${text(a.databases) || "（未提供）"}`,
			`檢索式：${text(a.query) || "（未提供）"}`,
			`限制條件：${text(a.limits) || "（未提供）"}`,
			`搜尋日期：${text(a.searchDate) || "（未提供）"}`,
			`搜尋結果與篩選：${text(a.screening) || "（未提供）"}`,
		].join("\n");
		return synthesis.buildSynthesisPrompt(prepared, {
			systemPrompt: (opts.systemPrompt && opts.systemPrompt.trim()) || DEFAULT_EBHC_PROMPT,
			blocks: [
				`<clinical_scenario>\n${text(a.scenario) || "（未提供：前言與形成臨床提問的病人描述與病人原話請寫〔待補〕）"}\n</clinical_scenario>`,
				`<pico>\n問題類型：${questionTypeLabel(type)}\n${pico}\n</pico>`,
				`<cebm_2011>\n${CEBM_COLUMNS[type]}\n</cebm_2011>`,
				`<search_summary>\n${search}\n</search_summary>`,
				opts.evidenceSummary ? `<evidence_summary>\n${opts.evidenceSummary}\n</evidence_summary>` : "",
			].filter(Boolean),
			closing: "請依照系統指示的標題與順序撰寫實證健康照護報告草稿。",
		});
	}

	/** Evidence-table rows from the sources' structured data (the plugin's, not the model's). */
	function evidenceRows(sources, entries) {
		return sources.map((src, i) => {
			let s = src.study || {};
			let finding = src.aiMarkdown ? llm.extractSummary(src.aiMarkdown) : "";
			return {
				id: entries[i].id,
				hasData: !!src.study,
				design: text(s.study_design),
				n: Number.isFinite(s.sample_size) ? s.sample_size : null,
				level: text(s.evidence_level),
				jbi: text(s.jbi_level),
				tool: text(s.appraisal_tool),
				overall: text(s.appraisal_overall),
				finding,
				hasNote: !!src.aiMarkdown,
			};
		});
	}

	function cell(v) {
		return String(v === undefined || v === null ? "" : v).replace(/\r?\n+/g, " ").replace(/\|/g, "\\|").trim();
	}

	function designLabel(design) {
		return design ? (DESIGN_ZH[design] || design) : "";
	}

	/** Markdown evidence table; the first column is the [S#] label (resolved to a citation later). */
	function evidenceTable(rows) {
		let head = ["文獻", "研究設計", "樣本數（N）", "證據等級（Oxford CEBM 2011）", "評讀工具", "整體評讀", "主要發現（AI 筆記一句話摘要）"];
		let lines = [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`];
		for (let r of rows) {
			lines.push("| " + [
				`[${r.id}]`,
				r.hasData ? cell(designLabel(r.design)) || "未報告" : "（無結構化資料）",
				r.n === null ? "未報告" : String(r.n),
				r.level ? `Level ${r.level}` : "未判定",
				cell(r.tool) || "（未評讀）",
				cell(r.overall) || "—",
				cell(r.finding) || (r.hasNote ? "—" : "（沒有 AI 筆記）"),
			].join(" | ") + " |");
		}
		return lines.join("\n");
	}

	/** Counts by design and the sum of N over primary studies (a review's pooled N may already include them). */
	function evidenceSummary(rows) {
		let byDesign = new Map();
		for (let r of rows) {
			let d = designLabel(r.design) || "未報告設計";
			byDesign.set(d, (byDesign.get(d) || 0) + 1);
		}
		let primary = rows.filter(r => !REVIEW_DESIGNS.has(r.design));
		let withN = primary.filter(r => r.n !== null);
		let parts = [`納入 ${rows.length} 篇：${[...byDesign].map(([d, n]) => `${d} ${n} 篇`).join("、")}`];
		if (withN.length) {
			parts.push(`原始研究樣本數合計 ${withN.reduce((s, r) => s + r.n, 0)} 人（${withN.length} 篇有報告樣本數${withN.length < primary.length ? `，${primary.length - withN.length} 篇未報告` : ""}）`);
		}
		if (rows.some(r => REVIEW_DESIGNS.has(r.design))) parts.push("系統性回顧的合併樣本可能已包含其他納入的原始研究，請勿直接相加");
		return parts.join("；") + "。";
	}

	// ---------- tables and blocks built by the plugin (pure) ----------

	/** Table 1: PICO with the English words found in each field; synonyms and MeSH are left to fill in. */
	function picoTable(answer) {
		let lines = ["| PICO | 內容 | 英文關鍵字 | 同義字 | MeSH Terms |", "|---|---|---|---|---|"];
		for (let p of PICO_KEYS) {
			let v = text(answer[p.key]);
			let en = [...new Set(searchLinks.picoTerms(v).flatMap(searchLinks.englishPhrases))];
			lines.push("| " + [
				`${p.letter}：${p.label}`,
				cell(v) || `${TODO}${p.letter === "C" ? "：對照組（例如常規照護）" : ""}〕`,
				cell(en.join("; ")) || `${TODO}〕`,
				`${TODO}〕`,
				`${TODO}〕`,
			].join(" | ") + " |");
		}
		return lines.join("\n");
	}

	/** The search strategy block (方法 二). */
	function searchBlock(search) {
		let s = search || {};
		let lines = [
			`- **資料庫**：${text(s.databases) || `${TODO}：資料庫（至少 Cochrane Library、PubMed；護理主題加 CINAHL；本土資料庫如華藝）〕`}`,
			`- **搜尋日期**：${text(s.searchDate) || `${TODO}：搜尋截止日期〕`}`,
			`- **限制條件**：${text(s.limits) || `${TODO}：年份、語言、文獻類型（例如限 SR 與 RCT）及理由〕`}`,
			`- **檢索式（布林邏輯 AND／OR）**${s.queryNote ? `：${s.queryNote}` : ""}`,
		];
		let out = lines.join("\n");
		out += text(s.query) ? `\n\n\`\`\`text\n${text(s.query)}\n\`\`\`` : `\n\n${TODO}：各資料庫實際使用的檢索式〕`;
		out += `\n\n- **搜尋結果與篩選**：${text(s.screening) || `${TODO}：各階段篇數與排除原因〕`}`;
		return out;
	}

	/** PRISMA mini-summary and figure 1 (Mermaid; the Lua filter replaces it with a placeholder in Word). */
	function prismaBlock(prisma) {
		if (!prisma) {
			return `> [!warning] 這個分類沒有篩選標籤，無法自動產生 PRISMA 流程圖\n> 請補上圖一（搜尋文獻及篩選流程圖）：可用 ZotMax 的「篩選（PRISMA 2020）」標記各篇，或自行繪製，並寫出各階段篇數與排除原因。`;
		}
		return [
			"**圖一　搜尋文獻及篩選流程圖（PRISMA 2020）**",
			"```mermaid\n" + screening.buildMermaid(prisma) + "\n```",
		].join("\n\n");
	}

	// ---------- the model's answer (pure) ----------

	function demote(md, levels = 1) {
		let inFence = false;
		return String(md || "").split("\n").map((line) => {
			if (/^\s*```/.test(line)) inFence = !inFence;
			if (inFence) return line;
			let m = /^(#{1,6})(\s.*)$/.exec(line);
			return m ? "#".repeat(Math.min(6, m[1].length + levels)) + m[2] : line;
		}).join("\n");
	}

	/**
	 * The model's ## sections by key (MODEL_SECTIONS). An unknown ## heading stays inside the section
	 * before it as a ### subsection; text before the first heading goes to `preamble`.
	 * @returns {{ sections: Object<string,string>, order: string[], truncated }}
	 */
	function splitSections(text) {
		let { md, truncated } = reviewDraft.cleanDraft(text);
		let sections = {};
		let order = [];
		let current = "preamble";
		let buf = { preamble: [] };
		let inFence = false;
		for (let line of md.split("\n")) {
			if (/^\s*```/.test(line)) inFence = !inFence;
			let h = !inFence && /^##\s+(.+?)\s*#*\s*$/.exec(line);
			if (h) {
				let title = h[1].replace(/[*_]/g, "").trim();
				let found = MODEL_SECTIONS.find(s => !(s.key in buf) && s.match.test(title));
				if (found) {
					current = found.key;
					buf[current] = [];
					order.push(current);
					continue;
				}
				line = "#" + line;
			}
			buf[current].push(line);
		}
		for (let [key, lines] of Object.entries(buf)) sections[key] = lines.join("\n").trim();
		return { sections, order, truncated };
	}

	// Not global: .test() must not carry lastIndex over to the shared global CITATION_RE
	const HAS_CITATION_RE = new RegExp(synthesis.CITATION_RE.source, "iu");

	/** For the number check only: lines under a heading that cites [S#] count as citing it. */
	function propagateHeadingCitations(md) {
		let labels = "";
		let inFence = false;
		return String(md || "").split("\n").map((line) => {
			if (/^\s*```/.test(line)) {
				inFence = !inFence;
				return line;
			}
			if (inFence) return line;
			let h = /^#{1,6}\s+(.*)$/.exec(line);
			if (h) {
				labels = (h[1].match(synthesis.CITATION_RE) || []).join("");
				return line;
			}
			if (!labels || !line.trim() || HAS_CITATION_RE.test(line)) return line;
			return `${line} ${labels}`;
		}).join("\n");
	}

	function numberValues(s) {
		return new Set(reviewDraft.extractNumbers(s).map(n => n.value));
	}

	/**
	 * Numbers not found where they should come from (review-draft.js checkNumbers). Abstract
	 * sentences carry no citations, so they are checked against all sources together; numbers the
	 * user typed (scenario, PICO, search) or the plugin counted (PRISMA, N) are accepted everywhere.
	 */
	function checkReportNumbers(sections, entries, texts, contextText) {
		let allowed = numberValues(contextText);
		let allSources = new Set();
		for (let t of texts.values()) for (let v of numberValues(t)) allSources.add(v);
		let valueOf = raw => (reviewDraft.extractNumbers(raw.replace(/%$/, ""))[0] || { value: raw }).value;
		let keep = (flagged, extra) => flagged.map(f => Object.assign({}, f, {
			missing: f.missing.filter(m => !allowed.has(valueOf(m)) && !(extra && extra.has(valueOf(m)))),
		})).filter(f => f.missing.length);
		let abstracts = ["abstractZh", "abstractEn"].map(k => sections[k] || "").join("\n\n");
		let body = MODEL_SECTIONS.filter(s => !["abstractZh", "abstractEn"].includes(s.key))
			.map(s => sections[s.key] || "").join("\n\n");
		let fromBody = keep(reviewDraft.checkNumbers(propagateHeadingCitations(body), entries, texts));
		let fromAbstract = keep(reviewDraft.checkNumbers(abstracts, entries, texts), allSources)
			.map(f => (f.ids.length ? f : Object.assign(f, { ids: entries.map(e => e.id) })));
		return [...fromAbstract, ...fromBody];
	}

	/** Entries without their own appraisal subsection (a heading citing them in 文獻的品質評讀). */
	function missingAppraisals(appraisalMd, entries) {
		let cited = new Set();
		for (let line of String(appraisalMd || "").split("\n")) {
			if (!/^#{1,6}\s/.test(line)) continue;
			for (let m of line.matchAll(synthesis.CITATION_RE)) {
				for (let l of synthesis.parseCitation(m[0])) cited.add(l.id);
			}
		}
		return entries.filter(e => !cited.has(e.id));
	}

	/** Rough length: CJK characters plus Latin words (TWNA counts 字). */
	function roughLength(md) {
		let s = String(md || "").split("\n").filter(l => !/^\s*\|/.test(l) && !/^#{1,6}\s/.test(l)).join("\n")
			.replace(synthesis.CITATION_RE, "").replace(/[*_`>#]/g, "");
		let cjk = (s.match(/\p{Script=Han}/gu) || []).length;
		let words = (s.replace(/\p{Script=Han}/gu, " ").match(/[A-Za-z0-9]+(?:[.'’-][A-Za-z0-9]+)*/g) || []).length;
		return cjk + words;
	}

	const BODY_KEYS = ["intro", "question", "appraisal", "synthesis", "application", "conclusion"];

	/**
	 * EBHC-specific checks: [{ level: "warn"|"info", code, text }]. These are reminders, not errors:
	 * the report still has to be checked against the current TWNA guidelines.
	 * input: { sections, entries, rows, answer, prisma, search, missingSections, missingAppraisal, withoutAI }
	 */
	function ebhcChecks(input) {
		let out = [];
		let add = (code, level, t) => out.push({ code, level, text: t });
		let a = input.answer || {};
		let rows = input.rows || [];
		let byId = new Map((input.entries || []).map(e => [e.id, e]));
		let who = ids => ids.map(id => (byId.get(id) ? byId.get(id).citation : id)).join("; ");
		for (let key of input.missingSections || []) {
			let s = MODEL_SECTIONS.find(x => x.key === key);
			add("missingSection", "warn", `**AI 沒有輸出「${s ? s.heading : key}」一節**：請重新產生，或自行補寫。`);
		}
		if ((input.missingAppraisal || []).length) {
			add("missingAppraisal", "warn", `**缺少逐篇評讀**：${input.missingAppraisal.map(e => e.citation).join("; ")} 沒有自己的評讀小節（評讀占 25 分，每篇都要逐題完整評讀）。`);
		}
		if (rows.length < 2) add("fewStudies", "warn", `**納入篇數**：只有 ${rows.length} 篇；撰寫指引要求至少 2 篇，且須含可得的最高證據等級。`);
		if (rows.length > 5) add("manyStudies", "info", `**納入篇數**：${rows.length} 篇。A 類綜整文章重在「少而精、逐篇深度評讀」，理想組合為 1 篇 SR + 2 篇 RCT。`);
		if (rows.length && !rows.some(r => REVIEW_DESIGNS.has(r.design))) {
			add("noReview", "info", "**沒有系統性回顧**：若這個問題已有相關的 SR／統合分析，必須納入（最高證據等級優先）。");
		}
		if ((input.withoutAI || []).length) {
			add("withoutAI", "warn", `**沒有 AI 筆記**：${input.withoutAI.join("; ")}；評讀與證據表缺資料，請先產生 AI 筆記或自行逐題評讀。`);
		}
		let noLevel = rows.filter(r => !r.level).map(r => r.id);
		if (noLevel.length) add("noLevel", "warn", `**證據等級未判定**：${who(noLevel)}。`);
		let type = a.questionType || "therapy";
		if (type !== "therapy" && rows.some(r => r.level)) {
			add("cebmColumn", "warn", `**證據等級欄位**：AI 筆記的 Oxford CEBM 2011 等級是依「治療效益」判定，本報告的問題類型是「${questionTypeLabel(type)}」，請依 CEBM 2011 對應的欄位重新確認表二的等級。`);
		}
		let tools = rows.filter(r => r.tool && !/casp/i.test(r.tool)).map(r => r.id);
		if (tools.length) {
			add("tool", "warn", `**評讀工具**：${who(tools)} 的 AI 筆記使用 ${[...new Set(rows.filter(r => tools.includes(r.id)).map(r => r.tool))].join("、")}；撰寫指引以最新版 CASP 為準（例如 RCT 2024 版、SR 2018 版）。請依現行發表準則確認評讀工具，並以官方清單逐題重新評讀。`);
		}
		if (!text(a.scenario)) add("noScenario", "warn", "**沒有案例情境**：前言與形成臨床提問的病人描述都是〔待補〕。");
		else if (!/[「『“"]/.test(a.scenario)) add("noQuote", "info", "**案例情境沒有病人原話**：範例文章都以病人實際說的話（用「」）帶出臨床問題；AI 不會自己編造，相關位置標為〔待補〕。");
		for (let p of PICO_KEYS) {
			if (!text(a[p.key])) add("pico", "warn", `**PICO 缺 ${p.letter}**：${p.label}未填${p.letter === "C" ? "（C 是常見的失分處）" : ""}。`);
		}
		let dbs = text(a.databases);
		if (!dbs) add("noDatabases", "warn", "**沒有搜尋資料庫**：方法二需要列出資料庫、搜尋日期與各資料庫的檢索式。");
		else {
			let missing = [[/cochrane/i, "Cochrane Library"], [/pubmed|medline/i, "PubMed"]].filter(([re]) => !re.test(dbs)).map(([, n]) => n);
			if (missing.length) add("databases", "warn", `**資料庫**：沒有看到 ${missing.join("、")}（撰寫指引要求至少 Cochrane Library 與 PubMed）。`);
			if (!/cinahl/i.test(dbs)) add("cinahl", "info", "**資料庫**：護理主題建議加上 CINAHL；本土文獻可加華藝（Airiti）。");
		}
		if (!text(a.searchDate)) add("searchDate", "info", "**搜尋日期**：請補上各資料庫的搜尋截止日期。");
		if (input.search && /尚未實際檢索/.test(input.search.queryNote || "") && text(a.query) === text(input.search.query)) {
			add("autoQuery", "warn", "**檢索式是依 PICO 自動組成的**，還沒有在資料庫實際執行；請改成實際使用的檢索式（含 MeSH、同義字與布林邏輯）。");
		}
		if (!input.prisma) add("noPrisma", "warn", "**沒有 PRISMA 流程圖**：請補圖一，並寫出各階段篇數與排除原因。");
		else if (input.prisma.counts.taPending || input.prisma.counts.ftPending) {
			add("prismaPending", "warn", "**篩選尚未完成**：PRISMA 計數中還有待篩選的文獻，圖一與搜尋結果的數字之後會變動。");
		}
		let s = input.sections || {};
		let zh = roughLength(s.abstractZh);
		if (zh > ABSTRACT_LIMIT) add("abstractLength", "warn", `**中文摘要過長**：約 ${zh} 字（上限 ${ABSTRACT_LIMIT} 字）。`);
		let en = roughLength(s.abstractEn);
		if (en > ABSTRACT_LIMIT) add("abstractLength", "warn", `**英文摘要過長**：約 ${en} 字（上限 ${ABSTRACT_LIMIT} 字）。`);
		let body = roughLength(BODY_KEYS.map(k => s[k] || "").join("\n"));
		if (body > BODY_LIMIT) add("bodyLength", "warn", `**全文過長**：正文約 ${body} 字（不含摘要、表格與參考文獻，上限 ${BODY_LIMIT} 字；粗估）。`);
		let todos = (BODY_KEYS.concat(["title", "abstractZh", "abstractEn"]).map(k => s[k] || "").join("\n").match(/〔待補/g) || []).length;
		if (todos) add("todos", "info", `**待補標記**：AI 撰寫的段落中有 ${todos} 處〔待補…〕，請依原文或實際搜尋紀錄補上。`);
		let zhRefs = (input.entries || []).filter(e => apaZh && apaZh.isChineseItem(e.data));
		if (zhRefs.length) {
			add("chineseRefs", "info", `**中文文獻**：${zhRefs.map(e => e.citation).join("; ")}。Word 版參考文獻由 Pandoc 產生，中文文獻不符中文 APA（例如 et al.、&）；請以「引用對照」中的中文 APA 替換，並把內文的 et al. 改成「等」。`);
		}
		add("appraisers", "info", "**評讀者分工**：請補上評讀者人數、資歷與意見不一致時的處理方式（例如由第三位實證師資仲裁）。");
		return out;
	}

	/**
	 * Everything derived from the model's answer.
	 * @param {Map<string,string>} texts source id → reviewDraft.sourceText()
	 * @param {object} ctx { answer, rows, prisma, search, contextText, withoutAI }
	 */
	function processReport(textOut, entries, texts, ctx = {}) {
		let { sections, truncated } = splitSections(textOut);
		let modelMd = MODEL_SECTIONS.map(s => sections[s.key] || "").join("\n\n");
		let unknown = [];
		synthesis.resolveCitations(modelMd, entries, "pandoc", {}, { flagUnknown: true, unknown });
		let uncited = reviewDraft.uncitedEntries(modelMd, entries);
		let missingSections = MODEL_SECTIONS.filter(s => !text(sections[s.key])).map(s => s.key);
		let missingAppraisal = text(sections.appraisal) ? missingAppraisals(sections.appraisal, entries) : [];
		let issues = {
			numbers: checkReportNumbers(sections, entries, texts, ctx.contextText || ""),
			unknown: [...new Set(unknown)],
			uncited,
			truncated,
			noCitations: uncited.length === entries.length,
		};
		let checks = ebhcChecks(Object.assign({}, ctx, { sections, entries, missingSections, missingAppraisal }));
		return { sections, issues, checks, missingSections, missingAppraisal };
	}

	function issueCount(report) {
		let i = report.issues;
		return i.numbers.length + i.unknown.length + (i.truncated ? 1 : 0) + (i.noCitations ? 1 : 0)
			+ report.checks.filter(c => c.level === "warn").length;
	}

	// ---------- assembling the report (pure) ----------

	function placeholder(key) {
		let s = MODEL_SECTIONS.find(x => x.key === key);
		return `${TODO}：AI 沒有輸出「${s.heading}」，請自行補寫〕`;
	}

	/**
	 * The report body in TWNA order, still with [S#] labels: the model's sections around the
	 * plugin's PICO table, search strategy, PRISMA figure and evidence table.
	 * parts: { report (processReport), answer, rows, search, prisma }
	 */
	function assembleBody(parts) {
		let s = parts.report.sections;
		let get = key => text(s[key]) || placeholder(key);
		// The live PRISMA sentence once: as the screening result, or after the user's own wording of it
		let live = prismaSentence(parts.prisma);
		let typed = text(parts.answer.screening);
		let screeningText = typed || live;
		let prismaLine = live && typed && typed !== live ? `\n\n依篩選標籤重新計算的 PRISMA 2020 計數：${live}` : "";
		return [
			"## 題目", get("title"),
			"## 中文摘要", get("abstractZh"),
			"## 英文摘要", get("abstractEn"),
			"## 前言", demote(get("intro")),
			"## 方法",
			"### 一、形成臨床提問（PICO）", demote(get("question")),
			`**表一　PICO 與檢索關鍵字**（插件依對話框的 PICO 產生；問題類型：${questionTypeLabel(parts.answer.questionType)}）`,
			picoTable(parts.answer),
			"> [!tip] 同義字與 MeSH Terms 請自行補上：可用 ZotMax 按鈕或快速指令 → 醫學文獻快速搜尋… 取得 MeSH 建議，或查 NCBI MeSH Database。",
			"### 二、文獻搜尋的方法與分析",
			searchBlock(Object.assign({}, parts.answer, {
				screening: screeningText,
				queryNote: parts.search && text(parts.answer.query) === text(parts.search.query) ? parts.search.queryNote : "",
			})) + prismaLine,
			prismaBlock(parts.prisma),
			"### 三、文獻的品質評讀",
			"**表二　納入文獻證據表**（插件依各篇 AI 筆記的結構化資料產生）",
			evidenceTable(parts.rows),
			evidenceSummary(parts.rows),
			demote(get("appraisal")),
			"## 結果：證據綜整", demote(get("synthesis")),
			"## 臨床應用", demote(get("application")),
			"## 結論與建議", demote(get("conclusion")),
		].join("\n\n");
	}

	/** Pandoc text: a heading's lone citation becomes in-text (`@key` → "Chen (2024)"). */
	function toPandoc(md, entries) {
		let out = synthesis.resolveCitations(md, entries, "pandoc", {}, { flagUnknown: true });
		return out.replace(/^(#{1,6}\s+(?:.*?\s)?)\[(@[^\];,\s]+)\]/gm, "$1$2");
	}

	function checkLines(report, entries) {
		return [...reviewDraft.issueLines(report.issues, entries), ...report.checks.map(c => (c.level === "info" ? `ℹ️ ${c.text}` : c.text))];
	}

	const CHECK_CAVEAT = "數字只和各篇的 AI 筆記、結構化資料、摘要與劃線（以及你在對話框填的內容）比對，不是 PDF 全文；評讀、論述與引用是否忠於原文，仍需逐篇回原文確認。系統只列出問題，沒有修改內容。";

	function checklistObsidian(report, entries) {
		let lines = checkLines(report, entries);
		let count = issueCount(report);
		let head = count
			? `> [!warning] ${count} 項需要確認（ℹ️ 為提醒）`
			: "> [!success] 沒有發現需要警示的問題；ℹ️ 為提醒";
		return [`## ${CHECK_HEADING}`, "", head, ...lines.map(l => `> - ${l}`), ">", `> ${CHECK_CAVEAT}`].join("\n");
	}

	function checklistPlain(report, entries) {
		let lines = checkLines(report, entries);
		return [`## ${CHECK_HEADING}`, "", ...(lines.length ? lines.map(l => `- ${l}`) : ["- 沒有發現需要警示的問題。"]), "", CHECK_CAVEAT].join("\n");
	}

	const SCORE_CHECKS = {
		title: ["missingSection:title"],
		abstract: ["missingSection:abstractZh", "missingSection:abstractEn", "abstractLength"],
		intro: ["missingSection:intro", "noScenario", "noQuote"],
		pico: ["missingSection:question", "pico", "noScenario"],
		search: ["noDatabases", "databases", "autoQuery", "noPrisma", "prismaPending", "fewStudies", "noReview", "searchDate"],
		appraisal: ["missingSection:appraisal", "missingAppraisal", "tool", "noLevel", "cebmColumn", "withoutAI", "appraisers"],
		conclusion: ["missingSection:synthesis", "missingSection:application", "missingSection:conclusion"],
		references: ["chineseRefs"],
	};

	/**
	 * The scoring self-check: each scoring item of the writing guide, the section of this draft that
	 * addresses it, what to check, and the related checklist findings. Not a score.
	 */
	function scoringChecklist(report) {
		let codes = new Map();
		for (let c of report.checks) {
			if (!codes.has(c.code)) codes.set(c.code, c.level);
		}
		for (let key of report.missingSections || []) codes.set(`missingSection:${key}`, "warn");
		let total = SCORING.reduce((n, s) => n + s.points, 0);
		let lines = ["| 評分項目（配分） | 本草稿對應段落 | 自我檢核重點 | 草稿狀態 |", "|---|---|---|---|"];
		for (let s of SCORING) {
			let related = SCORE_CHECKS[s.id].filter(c => codes.has(c));
			let warn = related.some(c => codes.get(c) === "warn");
			let status = warn ? "⚠️ 見查核清單" : related.length ? "ℹ️ 見查核清單" : "✅ 草稿已涵蓋（仍需人工確認）";
			lines.push(`| ${s.item}（${s.points} 分） | ${s.where} | ${s.focus} | ${status} |`);
		}
		return [
			`## ${SCORE_HEADING}`,
			"",
			"> [!note] 對照撰寫指引的配分檢查每一項由哪一節負責；這不是評分，也不代表通過審查。",
			`> 配分取自「A 類實證健康照護綜整文章發表準則暨撰寫指引（1141020 修訂版）」的整理，列出的項目合計 ${total} 分；投稿前請以台灣護理學會最新公告的準則與評分表為準。`,
			"",
			...lines,
		].join("\n");
	}

	// ---------- Obsidian note, Notion and Pandoc (pure) ----------

	function shellQuote(s) {
		return /^[\p{L}\p{N}._\/@+-]+$/u.test(s) ? s : `"${String(s).replace(/(["\\$`])/g, "\\$1")}"`;
	}

	/** Where the report goes and how Pandoc reaches the bibliography from there. */
	function reportPaths(folderParts, name) {
		let base = FILE_PREFIX + core.sanitizeFilename(name);
		let dirParts = [...folderParts, DRAFTS_FOLDER];
		let referencesRel = reviewDraft.relativePath(dirParts, [...folderParts, REFERENCES_FILE]);
		let cslRel = reviewDraft.relativePath(dirParts, ["apa.csl"]);
		let fileName = base + ".md";
		return {
			dirParts, fileName, referencesRel, cslRel,
			relPath: [...dirParts, fileName].join("/"),
			docx: base + ".docx",
			command: `pandoc ${shellQuote(fileName)} --citeproc --bibliography ${shellQuote(referencesRel)} --csl ${shellQuote(cslRel)}`
				+ ` --lua-filter ${FILTER_FILE} -o ${shellQuote(base + ".docx")}`,
		};
	}

	// Drops what is only meant for Obsidian when the report is converted to Word
	const PANDOC_FILTER = `-- ZotMax：把實證健康照護報告草稿轉成 Word 時，略過 Obsidian 註解（%% … %%）、提示框（> [!info] …）、
-- 「${CHECK_HEADING}」「${SCORE_HEADING}」「${PANDOC_HEADING}」「我的筆記」各節，並把 Mermaid 流程圖換成插圖提示。
-- 這個檔案由插件產生，重新產生報告時會覆寫。
local SKIP = { "查核清單", "評分項目自我檢核", "${PANDOC_HEADING}", "我的筆記" }

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
      if b.t == "CodeBlock" and b.classes:includes("mermaid") then
        table.insert(out, pandoc.Para({ pandoc.Str("〔圖一：請在 Obsidian 把 PRISMA 流程圖匯出成圖片後插入這裡〕") }))
      elseif not comment and not callout then
        table.insert(out, b)
      end
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
			`- \`${paths.referencesRel}\`：ZotMax 按鈕或快速指令 → 匯出參考文獻到 Obsidian 產生；產生報告時插件已檢查過，缺少引用的文獻會自動重新匯出。`,
			`- \`${paths.cslRel}\`：APA 7 樣式檔，放在 vault 根目錄（見 README「在 Obsidian 寫論文並用 Pandoc 產生 APA Word」）。`,
			`- \`${FILTER_FILE}\`：插件放在同一資料夾，轉檔時略過 %% 標記、提示框、查核清單、評分自我檢核、本節與「我的筆記」，並把 PRISMA 流程圖換成插圖提示。`,
		].join("\n");
	}

	function sortedReferences(entries) {
		let refs = entries.map(e => e.data.apaMarkdown || e.data.apa || `${e.citation}. ${e.data.title || ""}`.trim());
		let order = refs.map((r, i) => i);
		if (apaZh) {
			let sorted = apaZh.sortReferences(refs, entries.map(e => e.data));
			order = sorted.map(r => refs.indexOf(r));
		}
		else {
			order.sort((a, b) => refs[a].localeCompare(refs[b], "en"));
		}
		return order.map(i => ({ entry: entries[i], ref: refs[i] }));
	}

	function referenceCallout(entries) {
		return ["> [!abstract]- 引用對照（citekey → APA 7；中文文獻為中文 APA。Word 版的參考文獻由 Pandoc 產生）",
			...sortedReferences(entries).map(({ entry, ref }) => `> - ${entry.citekey ? `\`@${entry.citekey}\`` : "（沒有 citekey）"}：${ref}`)].join("\n");
	}

	function oneLine(s) {
		return String(s || "").replace(/\s+/g, " ").trim();
	}

	function infoCallout(entries, meta) {
		let info = [
			"> [!info] AI 產生的實證健康照護報告草稿（不可直接當作定稿）",
			`> 由 ${meta.model || "AI"} 依 ${entries.length} 篇文獻於 ${String(meta.generatedAt || "").slice(0, 10)} 產生；格式依台灣護理學會 A 類實證健康照護綜整文章撰寫指引整理，投稿前請以學會最新公告的發表準則為準。`,
			`> 問題類型：${questionTypeLabel(meta.answer.questionType)}。PICO 表、搜尋策略、PRISMA 流程圖與證據表由插件依你的資料產生；其餘敘述由 AI 撰寫，每個論點、數字、評讀結果與引用都必須回原文確認（見文末「⚠️ 查核清單」）。`,
			"> 引文是 Pandoc 格式 `[@citekey]`，轉成 Word 時才會變成 APA 引文。要修改內容請複製到標記外或另存：重新產生時，這個區塊會被覆寫。",
		];
		if (meta.withoutAI && meta.withoutAI.length) info.push(`> 沒有 AI 筆記、改用摘要與劃線的文獻：${meta.withoutAI.join("; ")}`);
		if (meta.truncatedSources && meta.truncatedSources.length) info.push(`> 內容過長、只使用前段的文獻：${meta.truncatedSources.join("; ")}`);
		return info.join("\n");
	}

	/**
	 * The plugin-managed region of the Obsidian note.
	 * meta: { model, generatedAt, answer, rows, search, prisma, paths, withoutAI, truncatedSources }
	 */
	function buildManagedRegion(report, entries, meta) {
		let body = assembleBody({ report, answer: meta.answer, rows: meta.rows, search: meta.search, prisma: meta.prisma });
		return [
			MARK_START,
			infoCallout(entries, meta),
			toPandoc(body, entries).trim(),
			"## 參考文獻\n\n::: {#refs}\n:::",
			referenceCallout(entries),
			checklistObsidian(report, entries),
			scoringChecklist(report),
			pandocSection(meta.paths),
			core.MARK_END,
		].join("\n\n");
	}

	/**
	 * The Obsidian note. With `existing`, only the managed region and the plugin's frontmatter keys
	 * change; the user's own text and keys stay.
	 * meta: buildManagedRegion's, plus { title, scope, notionUrl }
	 */
	function buildReportNote(existing, report, entries, meta) {
		let managedKeys = [
			["type", "ebhc-report"],
			["scope", meta.scope || ""],
			["question_type", meta.answer.questionType || "therapy"],
			["sources", entries.map(e => `${e.data.libraryPath}/${e.data.key}`)],
			["citekeys", entries.map(e => e.citekey).filter(Boolean)],
			["generated_at", meta.generatedAt || ""],
			["model", meta.model || ""],
		];
		if (meta.notionUrl) managedKeys.push(["notion", meta.notionUrl]);
		let region = buildManagedRegion(report, entries, meta);
		let split = existing ? core.splitFrontmatter(existing) : { frontmatter: null, body: null };
		let fm = managedKeys.reduce((acc, [k, v]) => core.setFrontmatterValue(acc, k, v), split.frontmatter || "");
		let body = split.body;
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

	/** Markdown for Notion: plain (Author, year) citations, APA references (Chinese APA), checklists. */
	function buildReportPlain(report, entries, meta) {
		let body = assembleBody({ report, answer: meta.answer, rows: meta.rows, search: meta.search, prisma: meta.prisma });
		return [
			`> AI 產生的實證健康照護報告草稿（${meta.model || "AI"}，${String(meta.generatedAt || "").slice(0, 10)}，${entries.length} 篇文獻）。每個論點、數字、評讀結果與引用都必須回原文確認；格式請以台灣護理學會最新公告的發表準則為準。`,
			synthesis.resolveCitations(body, entries, "plain", {}, { flagUnknown: true }).trim(),
			synthesis.referenceList(entries),
			checklistPlain(report, entries),
			scoringChecklist(report),
		].join("\n\n");
	}

	// ---------- Zotero side ----------

	// Test hook: { ask } replaces the dialog
	let runtime = {};

	function pref(key) {
		return Zotero.Prefs.get(PREF + key, true);
	}

	function readStore() {
		return reviewDraft.parseStore(pref(STORE_PREF));
	}

	function saveScope(key, patch) {
		try {
			Zotero.Prefs.set(PREF + STORE_PREF, JSON.stringify(reviewDraft.updateStore(readStore(), key, patch)), true);
		}
		catch (e) {
			Zotero.logError(e);
		}
	}

	function notify(t) {
		root.ZB.main.notify("ZotMax：實證健康照護報告", t);
	}

	const HTML_NS = "http://www.w3.org/1999/xhtml";

	const DIALOG_FIELDS = [
		{ group: "臨床問題" },
		{ key: "scenario", label: "案例情境", rows: 5, hint: "病人的年齡、診斷、治療狀況，以及病人實際說的話（用「」）。AI 只會引用這裡的病人原話，不會自己編造。",
			placeholder: "例如：65 歲陳先生，第二型糖尿病，此次因足部傷口入院。病人問護理師：「傷口一直好不了，有沒有什麼方法可以好得快一點？」" },
		{ key: "population", label: "P 族群／問題", rows: 1 },
		{ key: "intervention", label: "I 介入措施", rows: 1 },
		{ key: "comparison", label: "C 對照", rows: 1, placeholder: "例如：常規照護" },
		{ key: "outcomes", label: "O 結果指標", rows: 1, placeholder: "具體、可測量，例如：傷口癒合率、癒合時間" },
		{ key: "questionType", label: "問題類型", select: QUESTION_TYPES },
		{ group: "文獻搜尋（已由 PRISMA 篩選標籤或 PubMed 追蹤帶入時可直接修改）" },
		{ key: "databases", label: "資料庫", rows: 2, placeholder: "例如：Cochrane Library、PubMed、Embase、CINAHL、華藝" },
		{ key: "query", label: "檢索式（布林邏輯）", rows: 3 },
		{ key: "limits", label: "限制條件", rows: 2, placeholder: "例如：2015–2025 年；英文與中文；限系統性回顧與隨機對照試驗" },
		{ key: "searchDate", label: "搜尋日期", rows: 1, placeholder: "例如：2026 年 9 月 30 日" },
		{ key: "screening", label: "搜尋結果與篩選", rows: 3, placeholder: "例如：共搜尋 120 篇，排除重複 10 篇……最後納入 1 篇 SR 及 2 篇 RCT" },
	];

	/**
	 * The dialog: an HTML <dialog> on the main window (review-draft.js's approach). Resolves the
	 * answer object or null (cancelled); falls back to Services.prompt fields where a modal
	 * <dialog> can't be shown.
	 * init: dialogInit() values plus { name, count, hints: { key: text } }
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
			let el = (tag, style, content) => {
				let e = doc.createElementNS(HTML_NS, tag);
				if (style) e.setAttribute("style", style);
				if (content !== undefined) e.textContent = content;
				return e;
			};
			let inputs = {};
			let body = el("div", "max-height: 70vh; overflow-y: auto; padding-right: 4px;");
			for (let f of DIALOG_FIELDS) {
				if (f.group) {
					body.append(el("div", "font-weight: 600; margin: 14px 0 0; border-bottom: 1px solid rgba(128,128,128,0.4);", f.group));
					continue;
				}
				let wrap = el("label", "display: block; margin: 8px 0 0;");
				wrap.append(el("div", "font-weight: 600;", f.label));
				let hint = [f.hint, init.hints && init.hints[f.key]].filter(Boolean).join(" ");
				if (hint) wrap.append(el("div", "opacity: 0.75; font-size: 0.92em; margin: 2px 0 4px;", hint));
				let input;
				if (f.select) {
					input = el("select", "font: inherit;");
					for (let o of f.select) {
						let opt = el("option", "", o.label);
						opt.setAttribute("value", o.id);
						input.append(opt);
					}
				}
				else {
					input = el("textarea", "width: 100%; box-sizing: border-box; font: inherit; resize: vertical;");
					input.setAttribute("rows", String(f.rows || 2));
					if (f.placeholder) input.setAttribute("placeholder", f.placeholder);
				}
				input.value = init[f.key] || "";
				inputs[f.key] = input;
				wrap.append(input);
				body.append(wrap);
			}
			dialog.setAttribute("style", "width: min(720px, 94vw); padding: 16px 18px; border: 1px solid rgba(128,128,128,0.5); border-radius: 8px; background: Canvas; color: CanvasText; font: message-box;");
			let buttons = el("div", "display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px;");
			let cancel = el("button", "", "取消");
			let ok = el("button", "font-weight: 600;", "下一步（確認費用）");
			for (let b of [cancel, ok]) b.setAttribute("type", "button");
			buttons.append(cancel, ok);
			dialog.append(el("div", "font-size: 1.15em; font-weight: 600;", `實證健康照護報告草稿：${init.name}（${init.count} 篇）`), body, buttons);
			cancel.addEventListener("click", () => dialog.close("cancel"));
			ok.addEventListener("click", () => dialog.close("ok"));
			dialog.addEventListener("close", () => {
				let result = null;
				if (dialog.returnValue === "ok") {
					result = {};
					for (let [key, input] of Object.entries(inputs)) result[key] = String(input.value || "").replace(/\r\n?/g, "\n").trim();
				}
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
		let answer = Object.assign({}, init);
		delete answer.name;
		delete answer.count;
		delete answer.hints;
		let scenario = { value: init.scenario || "" };
		if (!Services.prompt.prompt(win, DIALOG_TITLE, "案例情境（病人的狀況與病人實際說的話）", scenario, null, {})) return null;
		answer.scenario = scenario.value.trim();
		let pico = { value: PICO_KEYS.map(p => init[p.key] || "").join("｜") };
		if (!Services.prompt.prompt(win, DIALOG_TITLE, "PICO：依序填 P｜I｜C｜O（以「｜」分隔）", pico, null, {})) return null;
		let parts = pico.value.split(/[｜|]/).map(s => s.trim());
		PICO_KEYS.forEach((p, i) => { answer[p.key] = parts[i] || ""; });
		try {
			let selected = { value: Math.max(0, QUESTION_TYPES.findIndex(q => q.id === init.questionType)) };
			if (Services.prompt.select(win, DIALOG_TITLE, "問題類型", QUESTION_TYPES.map(q => q.label), selected)) {
				answer.questionType = QUESTION_TYPES[selected.value].id;
			}
		}
		catch (e) {}
		return answer;
	}

	function selectedCollections(context) {
		return ((context && context.collectionTreeRows) || []).filter(r => r.isCollection && r.isCollection()).map(r => r.ref);
	}

	/** The collection's PRISMA counts (null without any screening tag) and the watches feeding it. */
	function collectionContext(collection) {
		let ZB = root.ZB;
		let out = { prisma: null, watches: [], records: [] };
		if (!collection) return out;
		try {
			let cfg = screening.config();
			let records = ZB.adapter.itemsInCollection(collection, true).map(screening.itemRecord);
			out.records = records;
			if (records.some(r => screening.hasDecision(screening.readState(r.tags, cfg)))) out.prisma = screening.computePrisma(records, cfg);
			out.watches = matchWatches(pubmedWatch.readWatches().watches, ZB.adapter.collectionPath(collection), records.flatMap(r => r.tags));
		}
		catch (e) {
			Zotero.logError(e);
		}
		return out;
	}

	function confirmText(settings, prompt, sources, extra) {
		let withoutAI = sources.filter(s => !s.aiMarkdown).length;
		let lines = [`將用 ${settings.llm.model} 依 ${sources.length} 篇文獻${extra}撰寫實證健康照護報告草稿，會產生一次 API 費用。`];
		try {
			let est = reviewDraft.estimateDraftCost(prompt.system, prompt.user, settings.llm.model, usage.parsePrices(pref("usage.prices")).prices);
			lines.push(est.expected === null
				? `輸入約 ${usage.formatTokens(est.inputTokens)} tokens（這個模型沒有價格資料，無法估算費用）。`
				: `預估費用：約 ${usage.formatUSD(est.expected)}（輸入約 ${usage.formatTokens(est.inputTokens)} tokens、輸出以約 8,000 tokens 估算；最多約 ${usage.formatUSD(est.max)}）。`);
		}
		catch (e) {
			Zotero.logError(e);
		}
		if (withoutAI) lines.push(`其中 ${withoutAI} 篇沒有 AI 筆記（沒有嚴格評讀與結構化資料）；先產生 AI 筆記，評讀與證據表才有內容。`);
		if (sources.length > 5) lines.push(`A 類綜整文章建議少而精（理想為 1 篇 SR + 2 篇 RCT），${sources.length} 篇的報告會很長，可能超過輸出長度上限。`);
		lines.push("", "要繼續嗎？");
		return lines.join("\n");
	}

	/**
	 * Menu entry (items or a collection). A collection with screening tags reports its full-text
	 * included studies; selected items report themselves (the collection they were selected in
	 * still supplies the search strategy).
	 * @param {object} scope { label, collection } as main.js builds it
	 */
	async function run(items, scope, context) {
		let ZB = root.ZB;
		// 「實證報告草稿」 off (the 研究生引導 preset): no AI call
		if (ZB.features && !ZB.features.isEnabled("ebhcReport")) {
			ZB.main.notifyFeatureOff("ebhcReport");
			return null;
		}
		let collection = (scope && scope.collection) || selectedCollections(context)[0] || null;
		let ctx = collectionContext(collection);
		items = ZB.adapter.toRegularItems(items);
		if (scope && scope.collection && ctx.prisma) {
			let included = new Set(ctx.prisma.included.map(r => r.id));
			items = items.filter(i => included.has(i.id));
			if (!items.length) {
				notify(`「${scope.collection.name}」還沒有全文納入的研究（篩選/全文/納入）。請先完成篩選，或選取要評讀的文獻後從條目右鍵產生。`);
				return;
			}
		}
		if (!items.length) {
			notify("請先選取要評讀的文獻（理想為 1 篇 SR + 2 篇 RCT）。");
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
			notify("實證健康照護報告草稿需要 LLM API key：請到 設定 → ZotMax 填入。");
			return;
		}
		if (!settings.vaultPath && !(settings.notionToken && settings.notionSynthesisParent)) {
			notify("請先在設定填入 Obsidian vault 路徑（Pandoc 版報告），或 Notion token 與「文獻比較表的 Notion 父頁面」。");
			return;
		}
		let extra = items.length > MAX_ITEMS ? `（超過 ${MAX_ITEMS} 篇，只使用前 ${MAX_ITEMS} 篇）` : "";
		items = items.slice(0, MAX_ITEMS);

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
			// A verified 文獻評讀表 replaces the AI note's appraisal (appraisal-form.js)
			ZB.appraisalForm.applyToSource(sources[sources.length - 1]);
		}
		sources = orderSources(sources);

		let where = reviewDraft.draftScope(scope, selectedCollections(context));
		let saved = reviewDraft.scopeEntry(readStore(), [where.key, where.fallback]);
		let pico = picoPrefill(sources.map(s => s.study));
		let picoNow = {};
		for (let p of PICO_KEYS) picoNow[p.key] = text(saved[p.key]) || pico.fields[p.key];
		let search = searchPrefill({ prisma: ctx.prisma, watches: ctx.watches, pico: picoNow });
		let derived = Object.assign({}, pico.fields, search, { questionType: guessQuestionType(sources.map(s => s.study)), prismaLive: !!ctx.prisma });
		let hints = {};
		for (let p of PICO_KEYS) {
			if (pico.variants[p.key].length) hints[p.key] = `各篇不一致，未自動帶入：${pico.variants[p.key].slice(0, 4).join("／")}`;
			else if (pico.fields[p.key] && !text(saved[p.key])) hints[p.key] = "已由各篇 AI 筆記的 PICO 帶入。";
		}
		if (ctx.prisma) hints.screening = "依這個分類的篩選標籤（PRISMA 2020）重新計算。";
		if (search.queryNote && !text(saved.query)) hints.query = `已帶入：${search.queryNote}。`;
		let win = Zotero.getMainWindow();
		let answer = await (runtime.ask || askOptions)(win, Object.assign(dialogInit(saved, derived), { name: where.name, count: sources.length, hints }));
		if (!answer) return;
		if (!QUESTION_TYPES.some(q => q.id === answer.questionType)) answer.questionType = "therapy";
		let toSave = {};
		for (let f of DIALOG_FIELDS) if (f.key) toSave[f.key] = answer[f.key] || "";
		saveScope(where.key, toSave);

		let entriesProbe = synthesis.buildSynthesisPrompt(sources, {}).entries;
		let rows = evidenceRows(sources, entriesProbe);
		let summary = evidenceSummary(rows);
		let prompt = buildEbhcPrompt(sources, { answer, evidenceSummary: summary });
		if (!Services.prompt.confirm(win, "ZotMax", confirmText(settings, prompt, sources, extra))) return;
		return ZB.main.enqueue(() => generate(sources, prompt, settings, where, { answer, rows, summary, search, prisma: ctx.prisma }));
	}

	async function writeIfChanged(path, content) {
		if (await IOUtils.exists(path) && await IOUtils.readUTF8(path) === content) return false;
		await IOUtils.writeUTF8(path, content);
		return true;
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
		if (!page) page = await client.createChildPage(settings.notionSynthesisParent, title, [], "🩺");
		await client.replaceManagedContainer(page.id, NOTION_CONTAINER_TITLE, ZB.markdown.mdToNotionBlocks(markdown));
		saveScope(where.key, { notionPageId: page.id });
		return page.url || "";
	}

	/** Numbers the user typed or the plugin counted: accepted by the number check. */
	function contextText(answer, summary, prisma) {
		return [...DIALOG_FIELDS.filter(f => f.key).map(f => answer[f.key]), summary, prismaSentence(prisma)].filter(Boolean).join("\n");
	}

	async function generate(sources, prompt, settings, where, job) {
		let ZB = root.ZB;
		let entries = prompt.entries;
		let title = `實證報告：${where.name}`;
		let pw = new Zotero.ProgressWindow({ closeOnClick: true });
		pw.changeHeadline(DIALOG_TITLE);
		pw.show();
		let line = new pw.ItemProgress("note", `AI 撰寫實證健康照護報告草稿中（${entries.length} 篇）…可能需要幾分鐘`);
		try {
			let runTotals = { ledger: {} };
			let result = await ZB.llm.generateText(settings.llm, prompt.system, prompt.user, (u, i) => fetch(u, i),
				Object.assign({ onRetry: ZB.main.retryStatus(s => line.setText(s)) }, ZB.main.runtime.retry));
			ZB.main.recordAIUsage(result, runTotals);
			let texts = new Map(sources.map((src, i) => [entries[i].id, reviewDraft.sourceText(src)]));
			let withoutAI = entries.filter((e, i) => !sources[i].aiMarkdown).map(e => e.citation);
			let report = processReport(result.text, entries, texts, {
				answer: job.answer, rows: job.rows, prisma: job.prisma, search: job.search, withoutAI,
				contextText: contextText(job.answer, job.summary, job.prisma),
			});
			let meta = {
				title,
				scope: where.name,
				model: result.model || settings.llm.model,
				generatedAt: new Date().toISOString(),
				answer: job.answer, rows: job.rows, search: job.search, prisma: job.prisma,
				withoutAI,
				truncatedSources: entries.filter(e => e.truncated).map(e => e.citation),
			};
			let outputs = [];
			let errors = [];
			let notes = [];

			if (settings.notionToken && settings.notionSynthesisParent) {
				line.setText("寫入 Notion…");
				try {
					let saved = reviewDraft.scopeEntry(readStore(), [where.key]);
					meta.notionUrl = await writeNotion(settings, where, title, buildReportPlain(report, entries, meta), saved);
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
					meta.paths = reportPaths(folderParts, where.name);
					let dir = PathUtils.join(settings.vaultPath, ...meta.paths.dirParts);
					await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
					let path = PathUtils.join(dir, meta.paths.fileName);
					let existing = (await IOUtils.exists(path)) ? await IOUtils.readUTF8(path) : null;
					await IOUtils.writeUTF8(path, buildReportNote(existing, report, entries, meta));
					await writeIfChanged(PathUtils.join(dir, FILTER_FILE), PANDOC_FILTER);
					outputs.push(`Obsidian（${meta.paths.relPath}）`);
					let missingKeys = entries.filter(e => !e.citekey).map(e => e.citation);
					if (missingKeys.length) notes.push(`⚠️ 沒有 citekey 的文獻（Pandoc 無法引用）：${missingKeys.join("; ")}`);
					try {
						notes.push(await reviewDraft.ensureReferences(settings, folderParts, entries));
					}
					catch (e) {
						Zotero.logError(e);
						notes.push(`⚠️ 無法更新 ${REFERENCES_FILE}：${e.message || e}；請手動執行 ZotMax 按鈕或快速指令 → 匯出參考文獻到 Obsidian`);
					}
				}
				catch (e) {
					errors.push(`Obsidian：${e.message || e}`);
				}
			}
			else {
				notes.push("沒有設定 Obsidian vault：只寫入 Notion（Pandoc 版報告需要 vault）。");
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
			let count = issueCount(report);
			pw.addDescription(count ? `⚠️ 查核清單有 ${count} 項需要確認（見報告文末）。` : "查核清單沒有警示；仍請逐項回原文確認。");
			for (let n of notes) pw.addDescription(n);
			let usageLine = ZB.main.runUsageLine(runTotals);
			if (usageLine) pw.addDescription(usageLine);
			pw.startCloseTimer(errors.length || count ? 20000 : 10000);
			return { report, meta, outputs, errors };
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
		DEFAULT_EBHC_PROMPT, STORE_PREF, FILTER_FILE, PANDOC_FILTER, MAX_ITEMS, QUESTION_TYPES, CEBM_COLUMNS, SCORING, MODEL_SECTIONS,
		picoPrefill, guessQuestionType, matchWatches, prismaSentence, searchPrefill, dialogInit,
		orderSources, takeSection, buildEbhcPrompt, evidenceRows, evidenceTable, evidenceSummary,
		picoTable, searchBlock, prismaBlock, splitSections, propagateHeadingCitations, checkReportNumbers, missingAppraisals,
		roughLength, ebhcChecks, processReport, issueCount, assembleBody, toPandoc, scoringChecklist,
		reportPaths, buildManagedRegion, buildReportNote, buildReportPlain,
		askOptions, askWithPrompts, run, runtime,
	};
});
