/*
 * ZotMax — critical appraisal checklists (文獻評讀表): the catalog of CASP and JBI tools and
 * pure helpers (summary counts, Markdown tables, CSV, AI-note parsing, Cohen's kappa).
 *
 * No Zotero or DOM dependencies. Works as:
 *   - require("./appraisal-tools.js") in Node (tests)
 *   - ZB.appraisalTools in the plugin (bootstrap.js loads it before the modules that use it)
 *   - window.ZBAppraisalTools when a web page loads it with <script>
 *
 * The item texts are short zh-TW paraphrases written for this plugin, not the official wording;
 * `textEn` is a short English cue. Always appraise with the official form (`source`) at hand and
 * cite it. CASP checklists: © CASP, CC BY-NC-SA. JBI checklists: © JBI, free to use with attribution.
 */
(function (root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) {
		module.exports = api;
	}
	else {
		// The plugin scope has ZB (created by the scripts loaded before) or Zotero; a web page has neither
		if (root.ZB || typeof root.Zotero !== "undefined") (root.ZB = root.ZB || {}).appraisalTools = api;
		root.ZBAppraisalTools = api;
	}
})(this || globalThis, function () {
	const ANSWERS = ["是", "否", "不清楚", "不適用"];
	// Overall judgement, the same words as the AI note's 整體評價 (llm.js APPRAISAL_VERDICTS)
	const VERDICTS = ["納入", "排除", "需更多資訊"];
	// study_design values of the AI note's structured data (llm.js STUDY_DESIGNS)
	const DESIGNS = [
		"RCT", "quasi-experimental", "cohort", "case-control", "cross-sectional", "qualitative",
		"mixed methods", "systematic review", "meta-analysis", "scoping review", "guideline", "other",
	];
	// Traffic-light cells for the cross-study matrix (Obsidian / Notion) and plain symbols (Word)
	const ICONS = { 是: "✅", 否: "❌", 不清楚: "❓", 不適用: "➖" };
	const MISSING_ICON = "⬜";
	const PLAIN_ICONS = { 是: "✓", 否: "✗", 不清楚: "?", 不適用: "–" };
	const PLAIN_MISSING = " ";
	const TABLE_HEAD = ["評讀項目", "評讀結果", "評析根據"];

	const CASP_TOOLS_URL = "https://casp-uk.net/casp-tools-checklists/";
	const CASP_LICENSE = "© CASP（Critical Appraisal Skills Programme），CC BY-NC-SA 4.0（2024 版；舊版 PDF 標示 3.0）：非商業使用、標示出處、相同方式分享";
	const JBI_TOOLS_URL = "https://jbi.global/critical-appraisal-tools";
	const JBI_LICENSE = "© JBI（Joanna Briggs Institute），可免費用於評讀，使用時標示出處並引用官方工具";
	const NOT_VERIFIED = "未連線核對：題數與題序依插件 AI 筆記提示（llm.js）及既有知識整理，請以官方表單為準";

	const CASP_RCT_SECTIONS = {
		A: "Section A：研究設計是否有效（Is the basic study design valid for an RCT?）",
		B: "Section B：研究方法是否嚴謹（Was the study methodologically sound?）",
		C: "Section C：結果為何（What are the results?）",
		D: "Section D：結果能否應用於本地（Will the results help locally?）",
	};
	const CASP_3 = {
		A: "Section A：研究結果是否有效（Are the results valid?）",
		B: "Section B：結果為何（What are the results?）",
		C: "Section C：結果能否應用於本地（Will the results help locally?）",
	};
	const JBI_RCT_DOMAINS = {
		sel: "Internal validity：選樣與分派相關偏差（selection and allocation）",
		admin: "Internal validity：介入執行相關偏差（administration of intervention）",
		meas: "Internal validity：結果評估與測量相關偏差（assessment and measurement of outcomes）",
		ret: "Internal validity：受試者保留相關偏差（participant retention）",
		stat: "Statistical conclusion validity：統計結論效度",
	};

	// [id, section, text (zh-TW paraphrase), textEn (short cue), hint, open?]
	function items(rows, sections) {
		return rows.map(([id, section, text, textEn, hint, open]) => {
			let item = { id: String(id), text, textEn, hint };
			if (section) item.section = sections ? sections[section] : section;
			if (open) item.open = true;
			return item;
		});
	}

	const TOOLS = [
		{
			id: "casp-rct",
			family: "CASP",
			name: "CASP Checklist: For Randomised Controlled Trials (RCTs) (2024)",
			nameZh: "CASP 隨機對照試驗評讀表（2024 版）",
			version: "2024",
			designs: ["RCT"],
			source: "https://casp-uk.net/casp-checklists/CASP-checklist-randomised-controlled-trials-RCT-2024.pdf",
			license: CASP_LICENSE,
			verification: "2024 版：Section A–D、第 1–3 題、第 4 題盲化 (a)–(c)、第 10–11 題經網路搜尋摘要比對；其餘題目依 2020 版結構（題號相同），未連線開啟官方 PDF 逐字核對",
			items: items([
				[1, "A", "研究是否針對一個明確聚焦的問題（PICO）？", "Clearly focused research question", "族群、介入、對照與結果指標是否清楚界定"],
				[2, "A", "受試者是否被隨機分派到各介入組？", "Randomised allocation", "隨機方法（電腦亂數、區塊隨機）與分派順序的隱匿方式"],
				[3, "A", "所有進入研究的受試者在研究結束時是否都有交代？", "All participants accounted for", "流失人數與原因、是否依原分組分析（ITT）、是否提早終止"],
				["4a", "B", "受試者是否不知道自己接受的介入（設盲）？", "Participants blinded", "受試者盲化的方式；無法盲化時說明是否為此類介入的固有限制"],
				["4b", "B", "執行介入的研究人員是否設盲？", "Investigators / care providers blinded", "提供介入的人員是否知道分組"],
				["4c", "B", "評估或分析結果的人員是否設盲？", "Outcome assessors / analysts blinded", "結果評估者、資料分析者是否知道分組"],
				[5, "B", "研究開始時各組是否相似？", "Groups similar at baseline", "基本屬性表、重要預後因子與組間比較的 p 值"],
				[6, "B", "除實驗介入外，各組是否接受相同程度的照護？", "Same level of care apart from the intervention", "共同的標準照護、共同介入或干擾因子"],
				[7, "C", "介入成效是否完整報告？", "Effects reported comprehensively", "事前登錄的主要與次要結果是否都有報告、檢定力分析、效應值"],
				[8, "C", "介入成效的估計精確度是否有報告？", "Precision of the effect estimate reported", "95% 信賴區間、p 值"],
				[9, "C", "實驗介入的益處是否大於害處與成本？", "Benefits outweigh harms and costs", "不良事件、副作用、成本"],
				[10, "D", "結果能否應用於本地族群或你的情境？", "Applicable to the local population / context", "研究族群與場域和本地病人的差異"],
				[11, "D", "實驗介入是否比現有介入對你照護的人更有價值？", "Greater value than existing interventions", "所需時間、經費、訓練；可否由現有措施轉移資源"],
			], CASP_RCT_SECTIONS),
			verdicts: VERDICTS.slice(),
		},
		{
			id: "casp-sr",
			family: "CASP",
			name: "CASP Systematic Review Checklist (2018)",
			nameZh: "CASP 系統性回顧評讀表（2018 版）",
			version: "2018",
			designs: ["systematic review", "meta-analysis"],
			source: CASP_TOOLS_URL,
			license: CASP_LICENSE,
			verification: NOT_VERIFIED,
			items: items([
				[1, "A", "回顧是否針對一個明確聚焦的問題？", "Clearly focused question", "族群、介入或暴露、結果指標是否明確"],
				[2, "A", "作者是否尋找適當類型的文獻？", "Right type of papers", "納入的研究設計是否適合回答回顧問題"],
				[3, "A", "重要且相關的研究是否都已納入？", "All important, relevant studies included", "資料庫數量、引文追蹤、灰色文獻、語言限制、專家聯繫"],
				[4, "A", "作者是否充分評估納入研究的品質？", "Quality of included studies assessed", "偏差風險工具（如 Cochrane RoB）與評讀方式"],
				[5, "A", "若合併結果，合併是否合理？", "Reasonable to combine results", "研究間結果是否相似、異質性（I²）與效應模式"],
				[6, "B", "回顧的整體結果為何？", "Overall results", "主要結果的效應值（OR、RR、SMD）", true],
				[7, "B", "結果的精確度如何？", "Precision of the results", "95% 信賴區間", true],
				[8, "C", "結果能否應用於本地族群？", "Applicable to the local population", "本地病人與研究族群的差異"],
				[9, "C", "是否考量所有重要的結果？", "All important outcomes considered", "對病人、決策者與政策重要的結果"],
				[10, "C", "益處是否值得其害處與成本？", "Benefits worth harms and costs", "即使回顧未說明，也要思考"],
			], CASP_3),
			verdicts: VERDICTS.slice(),
		},
		{
			id: "casp-cohort",
			family: "CASP",
			name: "CASP Cohort Study Checklist (2018)",
			nameZh: "CASP 世代研究評讀表（2018 版）",
			version: "2018",
			designs: ["cohort"],
			source: CASP_TOOLS_URL,
			license: CASP_LICENSE,
			verification: NOT_VERIFIED,
			items: items([
				[1, "A", "研究是否針對一個明確聚焦的問題？", "Clearly focused issue", "族群、危險因子或介入、結果指標是否明確"],
				[2, "A", "世代的招募方式是否可接受？", "Cohort recruited acceptably", "選樣偏差、樣本是否代表目標族群"],
				[3, "A", "暴露的測量是否準確以減少偏差？", "Exposure accurately measured", "主觀或客觀測量、是否經效度驗證、各組方式相同"],
				[4, "A", "結果的測量是否準確以減少偏差？", "Outcome accurately measured", "測量工具效度、結果評估者是否設盲"],
				["5a", "A", "作者是否辨識所有重要的干擾因子？", "Important confounders identified", "作者遺漏的干擾因子"],
				["5b", "A", "作者是否在設計或分析中處理干擾因子？", "Confounders taken into account", "限制、配對、分層、多變項迴歸、敏感度分析"],
				["6a", "A", "受試者的追蹤是否夠完整？", "Follow-up complete enough", "流失率、流失者與留存者是否不同"],
				["6b", "A", "受試者的追蹤時間是否夠長？", "Follow-up long enough", "結果發生所需的時間"],
				[7, "B", "研究結果為何？", "Results of the study", "主要結果、效應值（RR、HR）", true],
				[8, "B", "結果的精確度如何？", "Precision of the results", "95% 信賴區間", true],
				[9, "B", "你相信這些結果嗎？", "Results believable", "效應大小、偏差、機率或干擾能否解釋結果"],
				[10, "C", "結果能否應用於本地族群？", "Applicable to the local population", "研究族群與本地病人的差異"],
				[11, "C", "結果是否與其他現有證據一致？", "Fits with other available evidence", "與其他研究的比較"],
				[12, "C", "研究對實務的意涵為何？", "Implications for practice", "觀察性研究的證據強度與臨床決策", true],
			], CASP_3),
			verdicts: VERDICTS.slice(),
		},
		{
			id: "casp-case-control",
			family: "CASP",
			name: "CASP Case Control Study Checklist (2018)",
			nameZh: "CASP 病例對照研究評讀表（2018 版）",
			version: "2018",
			designs: ["case-control"],
			source: CASP_TOOLS_URL,
			license: CASP_LICENSE,
			verification: NOT_VERIFIED,
			items: items([
				[1, "A", "研究是否針對一個明確聚焦的問題？", "Clearly focused issue", "族群、危險因子、結果與研究目的是否明確"],
				[2, "A", "作者是否以適當的方法回答問題？", "Appropriate method", "病例對照設計是否適合此問題（如罕見疾病）"],
				[3, "A", "病例的招募方式是否可接受？", "Cases recruited acceptably", "病例定義、代表性、是否有足夠樣本"],
				[4, "A", "對照組的選取方式是否可接受？", "Controls selected acceptably", "對照是否代表同一母群體、配對方式、樣本數"],
				[5, "A", "暴露的測量是否準確以減少偏差？", "Exposure accurately measured", "回憶偏差、病例與對照的測量方式是否相同"],
				["6a", "A", "除暴露外，各組是否受到相同對待？", "Groups treated equally", "測量程序與資料收集是否一致"],
				["6b", "A", "作者是否在設計或分析中處理可能的干擾因子？", "Confounders taken into account", "配對、分層、多變項分析"],
				[7, "B", "效應有多大？", "Size of the effect", "OR 與主要結果", true],
				[8, "B", "效應估計的精確度如何？", "Precision of the estimate", "95% 信賴區間", true],
				[9, "B", "你相信這些結果嗎？", "Results believable", "偏差、機率或干擾能否解釋結果"],
				[10, "C", "結果能否應用於本地族群？", "Applicable to the local population", "研究族群與本地病人的差異"],
				[11, "C", "結果是否與其他現有證據一致？", "Fits with other available evidence", "與其他研究的比較"],
			], CASP_3),
			verdicts: VERDICTS.slice(),
		},
		{
			id: "casp-qualitative",
			family: "CASP",
			name: "CASP Qualitative Studies Checklist (2018)",
			nameZh: "CASP 質性研究評讀表（2018 版）",
			version: "2018",
			designs: ["qualitative"],
			source: CASP_TOOLS_URL,
			license: CASP_LICENSE,
			verification: NOT_VERIFIED,
			items: items([
				[1, "A", "研究目的是否清楚陳述？", "Clear statement of aims", "研究目的、重要性與相關性"],
				[2, "A", "質性方法是否適當？", "Qualitative methodology appropriate", "是否在探討參與者的經驗或觀點"],
				[3, "A", "研究設計是否適合達成研究目的？", "Research design appropriate", "作者是否說明選擇此設計（如現象學、紮根理論）的理由"],
				[4, "A", "招募策略是否適合研究目的？", "Recruitment strategy appropriate", "參與者如何選取、為何適合、未參與者"],
				[5, "A", "資料收集方式是否能回答研究問題？", "Data collection addressed the issue", "訪談方式、場域、資料飽和"],
				[6, "A", "研究者與參與者的關係是否充分考量？", "Researcher–participant relationship considered", "研究者反身性、角色與潛在偏差"],
				[7, "B", "是否考量倫理議題？", "Ethical issues considered", "倫理審查、知情同意、保密"],
				[8, "B", "資料分析是否夠嚴謹？", "Data analysis sufficiently rigorous", "分析過程、主題如何產生、矛盾資料、引文支持"],
				[9, "B", "研究發現是否清楚陳述？", "Clear statement of findings", "可信度策略（三角校正、參與者檢核）"],
				[10, "C", "這個研究的價值為何？", "Value of the research", "對現有知識與實務的貢獻、可移轉性", true],
			], CASP_3),
			verdicts: VERDICTS.slice(),
		},
		{
			id: "casp-diagnostic",
			family: "CASP",
			name: "CASP Diagnostic Study Checklist (2018)",
			nameZh: "CASP 診斷性研究評讀表（2018 版）",
			version: "2018",
			designs: ["diagnostic accuracy"],
			source: CASP_TOOLS_URL,
			license: CASP_LICENSE,
			verification: NOT_VERIFIED,
			items: items([
				[1, "A", "研究問題是否清楚？", "Clear question", "族群、待測檢驗、參考標準與結果"],
				[2, "A", "是否與適當的參考標準比較？", "Appropriate reference standard", "參考標準是否為最佳可得的黃金標準"],
				[3, "A", "所有受試者是否都接受待測檢驗與參考標準？", "All received both tests", "部分驗證偏差（verification bias）"],
				[4, "A", "待測檢驗結果是否可能受參考標準結果影響？", "Test results influenced by the reference standard", "判讀者是否設盲、判讀順序"],
				[5, "A", "受測族群的疾病狀態是否清楚描述？", "Disease status clearly described", "疾病嚴重度、症狀、共病"],
				[6, "A", "檢驗的執行方法是否描述得足以重複？", "Test methods described in detail", "操作步驟、閾值、判讀者"],
				[7, "B", "結果為何？", "Results", "敏感度、特異度、概似比", true],
				[8, "B", "結果的確定程度如何？", "How sure are we about the results", "95% 信賴區間、機率與偏差", true],
				[9, "C", "結果能否應用於你的病人或目標族群？", "Applicable to your patients", "族群與場域的差異"],
				[10, "C", "這項檢驗能否在你的病人或族群中執行？", "Test applicable in your setting", "資源、技術、成本"],
				[11, "C", "是否考量對個人或族群重要的所有結果？", "All important outcomes considered", "偽陽性與偽陰性的後果"],
				[12, "C", "使用這項檢驗對你的病人會有什麼影響？", "Impact of using the test", "臨床決策與照護的改變", true],
			], CASP_3),
			verdicts: VERDICTS.slice(),
		},
		{
			id: "jbi-rct",
			family: "JBI",
			name: "JBI Critical Appraisal Tool for the Assessment of Risk of Bias for Randomized Controlled Trials (2023)",
			nameZh: "JBI 隨機對照試驗偏差風險評讀工具（2023 修訂版）",
			version: "2023",
			designs: ["RCT"],
			source: JBI_TOOLS_URL,
			reference: "Barker, T. H., et al. (2023). The revised JBI critical appraisal tool for the assessment of risk of bias for randomized controlled trials. JBI Evidence Synthesis, 21(3), 494–506. https://doi.org/10.11124/JBIES-22-00430",
			license: JBI_LICENSE,
			verification: "13 題與題序同插件 AI 筆記提示（llm.js）；2023 修訂版的出處經網路搜尋確認，偏差領域分組依既有知識整理，未連線核對",
			items: items([
				[1, "sel", "是否真正隨機分派受試者？", "True randomization", "隨機序列的產生方式（電腦亂數、亂數表）"],
				[2, "sel", "分派至各組的過程是否隱匿？", "Allocation concealment", "中央分派、不透明密封信封"],
				[3, "sel", "各組在基準期是否相似？", "Groups similar at baseline", "基本屬性與預後因子的組間比較"],
				[4, "admin", "受試者是否不知道自己的分組？", "Participants blind to assignment", "安慰劑、假介入；無法盲化時說明"],
				[5, "admin", "執行介入的人員是否不知道分組？", "Those delivering treatment blind", "介入提供者是否知情"],
				[6, "admin", "除介入外，各組是否接受相同的對待？", "Groups treated identically other than the intervention", "共同照護、共同介入"],
				[7, "meas", "結果評估者是否不知道分組？", "Outcome assessors blind", "評估者盲化（逐一結果判斷）"],
				[8, "meas", "各組的結果測量方式是否相同？", "Outcomes measured the same way", "相同工具、時間點與程序"],
				[9, "meas", "結果的測量是否可信（reliable）？", "Outcomes measured reliably", "工具信度、評估者間一致性"],
				[10, "ret", "追蹤是否完整？若否，各組追蹤的差異是否充分描述與分析？", "Follow-up complete or differences described and analyzed", "流失率與原因、組間差異"],
				[11, "stat", "受試者是否依原隨機分組分析（ITT）？", "Analyzed in the groups randomized (ITT)", "意向治療分析、缺失值處理"],
				[12, "stat", "統計分析是否適當？", "Appropriate statistical analysis", "檢定方法、假設、校正"],
				[13, "stat", "試驗設計是否適當？偏離標準 RCT（個別隨機、平行組）之處是否在執行與分析中處理？", "Appropriate trial design; deviations accounted for", "群集、交叉設計等的處理"],
			], JBI_RCT_DOMAINS),
			verdicts: VERDICTS.slice(),
		},
		{
			id: "jbi-quasi",
			family: "JBI",
			name: "JBI Checklist for Quasi-Experimental Studies (non-randomized experimental studies)",
			nameZh: "JBI 類實驗研究評讀表",
			version: "2017",
			designs: ["quasi-experimental"],
			source: JBI_TOOLS_URL,
			license: JBI_LICENSE,
			verification: "9 題與題序同插件 AI 筆記提示（llm.js，2017 版）；未連線核對 JBI 之後的修訂版",
			items: items([
				[1, "", "是否清楚區分「因」（介入）與「果」（結果）？", "Cause and effect clear", "時間順序、介入在結果之前"],
				[2, "", "比較的受試者是否相似？", "Participants in comparisons similar", "基本屬性、選樣方式"],
				[3, "", "除介入外，比較的受試者是否接受相似的照護？", "Similar treatment/care other than the intervention", "共同介入、照護差異"],
				[4, "", "是否有對照組？", "Control group", "獨立對照組；單組前後測答否"],
				[5, "", "介入前後是否多次測量結果？", "Multiple pre and post measurements", "時間序列、前測次數"],
				[6, "", "追蹤是否完整？若否，差異是否充分描述與分析？", "Follow-up complete or differences described", "流失率與原因"],
				[7, "", "比較的受試者結果測量方式是否相同？", "Outcomes measured the same way", "相同工具與時間點"],
				[8, "", "結果的測量是否可信？", "Outcomes measured reliably", "工具信效度、評估者訓練"],
				[9, "", "統計分析是否適當？", "Appropriate statistical analysis", "前後測比較方法、干擾因子校正"],
			]),
			verdicts: VERDICTS.slice(),
		},
		{
			id: "jbi-cohort",
			family: "JBI",
			name: "JBI Checklist for Cohort Studies",
			nameZh: "JBI 世代研究評讀表",
			version: "2017",
			designs: ["cohort"],
			source: JBI_TOOLS_URL,
			license: JBI_LICENSE,
			verification: "11 題與題序同插件 AI 筆記提示（llm.js）；未連線核對",
			items: items([
				[1, "", "兩組是否相似且來自同一母群體？", "Groups similar and from the same population", "招募來源與條件"],
				[2, "", "兩組的暴露測量方式是否相同？", "Exposures measured similarly", "相同工具與程序"],
				[3, "", "暴露的測量是否有效且可信？", "Exposure measured validly and reliably", "工具信效度"],
				[4, "", "是否辨識干擾因子？", "Confounding factors identified", "列出的干擾因子"],
				[5, "", "是否說明處理干擾因子的策略？", "Strategies to deal with confounders", "配對、分層、多變項分析"],
				[6, "", "研究開始時受試者是否尚未發生結果？", "Free of the outcome at the start", "排除已有結果者"],
				[7, "", "結果的測量是否有效且可信？", "Outcomes measured validly and reliably", "工具、資料來源"],
				[8, "", "追蹤時間是否有報告且足以讓結果發生？", "Follow-up time reported and sufficient", "追蹤期間"],
				[9, "", "追蹤是否完整？若否，流失原因是否描述與探討？", "Follow-up complete or reasons explored", "流失率與原因"],
				[10, "", "是否採取策略處理追蹤不完整？", "Strategies for incomplete follow-up", "敏感度分析、插補"],
				[11, "", "統計分析是否適當？", "Appropriate statistical analysis", "存活分析、迴歸模型"],
			]),
			verdicts: VERDICTS.slice(),
		},
		{
			id: "jbi-case-control",
			family: "JBI",
			name: "JBI Checklist for Case Control Studies",
			nameZh: "JBI 病例對照研究評讀表",
			version: "2017",
			designs: ["case-control"],
			source: JBI_TOOLS_URL,
			license: JBI_LICENSE,
			verification: "10 題與題序同插件 AI 筆記提示（llm.js）；未連線核對",
			items: items([
				[1, "", "除疾病有無外，兩組是否可比較？", "Groups comparable other than disease", "族群來源、基本屬性"],
				[2, "", "病例與對照是否適當配對？", "Cases and controls matched appropriately", "配對變項"],
				[3, "", "辨識病例與對照的標準是否相同？", "Same criteria to identify cases and controls", "診斷標準"],
				[4, "", "暴露的測量是否標準、有效且可信？", "Exposure measured in a standard, valid and reliable way", "工具、紀錄來源"],
				[5, "", "病例與對照的暴露測量方式是否相同？", "Exposure measured the same way for cases and controls", "訪談者是否盲化"],
				[6, "", "是否辨識干擾因子？", "Confounding factors identified", "列出的干擾因子"],
				[7, "", "是否說明處理干擾因子的策略？", "Strategies to deal with confounders", "配對、多變項分析"],
				[8, "", "結果評估是否標準、有效且可信？", "Outcomes assessed in a standard, valid and reliable way", "結果定義"],
				[9, "", "關注的暴露期間是否夠長而有意義？", "Exposure period long enough", "暴露時間"],
				[10, "", "統計分析是否適當？", "Appropriate statistical analysis", "條件式邏輯斯迴歸、OR"],
			]),
			verdicts: VERDICTS.slice(),
		},
		{
			id: "jbi-cross-sectional",
			family: "JBI",
			name: "JBI Checklist for Analytical Cross Sectional Studies",
			nameZh: "JBI 分析性橫斷性研究評讀表",
			version: "2017",
			designs: ["cross-sectional", "mixed methods"],
			source: JBI_TOOLS_URL,
			license: JBI_LICENSE,
			verification: "8 題與題序同插件 AI 筆記提示（llm.js）；未連線核對",
			items: items([
				[1, "", "樣本的納入條件是否明確？", "Inclusion criteria clearly defined", "納入與排除條件"],
				[2, "", "研究對象與場域是否詳細描述？", "Subjects and setting described in detail", "人口學特徵、地點、時間"],
				[3, "", "暴露的測量是否有效且可信？", "Exposure measured validly and reliably", "工具信效度"],
				[4, "", "是否以客觀、標準的準則測量狀況？", "Objective, standard criteria for the condition", "診斷或分類標準"],
				[5, "", "是否辨識干擾因子？", "Confounding factors identified", "列出的干擾因子"],
				[6, "", "是否說明處理干擾因子的策略？", "Strategies to deal with confounders", "多變項分析、分層"],
				[7, "", "結果的測量是否有效且可信？", "Outcomes measured validly and reliably", "量表信效度（Cronbach's α）"],
				[8, "", "統計分析是否適當？", "Appropriate statistical analysis", "迴歸模型、校正"],
			]),
			verdicts: VERDICTS.slice(),
		},
		{
			id: "jbi-prevalence",
			family: "JBI",
			name: "JBI Checklist for Prevalence Studies",
			nameZh: "JBI 盛行率研究評讀表",
			version: "2017",
			designs: ["cross-sectional"],
			source: JBI_TOOLS_URL,
			license: JBI_LICENSE,
			verification: NOT_VERIFIED,
			items: items([
				[1, "", "抽樣架構是否適合目標族群？", "Sample frame appropriate", "抽樣架構涵蓋的族群"],
				[2, "", "研究對象的抽樣方式是否適當？", "Participants sampled appropriately", "隨機或連續抽樣"],
				[3, "", "樣本數是否足夠？", "Adequate sample size", "樣本數計算"],
				[4, "", "研究對象與場域是否詳細描述？", "Subjects and setting described in detail", "人口學特徵、場域"],
				[5, "", "資料分析是否充分涵蓋所辨識的樣本？", "Sufficient coverage of the identified sample", "各子群的回應差異"],
				[6, "", "是否以有效的方法辨識狀況？", "Valid methods to identify the condition", "診斷標準"],
				[7, "", "所有受試者的狀況是否以標準且可信的方式測量？", "Condition measured in a standard, reliable way", "測量程序一致"],
				[8, "", "統計分析是否適當？", "Appropriate statistical analysis", "盛行率與信賴區間"],
				[9, "", "回應率是否足夠？若否，低回應率是否適當處理？", "Adequate response rate", "回應率與未回應者比較"],
			]),
			verdicts: VERDICTS.slice(),
		},
		{
			id: "jbi-qualitative",
			family: "JBI",
			name: "JBI Checklist for Qualitative Research",
			nameZh: "JBI 質性研究評讀表",
			version: "2017",
			designs: ["qualitative", "mixed methods"],
			source: JBI_TOOLS_URL,
			license: JBI_LICENSE,
			verification: "10 題與題序同插件 AI 筆記提示（llm.js）；未連線核對",
			items: items([
				[1, "", "哲學觀點與研究方法論是否一致？", "Philosophical perspective congruent with methodology", "典範與方法論的對應"],
				[2, "", "方法論與研究問題或目的是否一致？", "Methodology congruent with research question", "研究問題適合的方法論"],
				[3, "", "方法論與資料收集方法是否一致？", "Methodology congruent with data collection", "訪談、觀察等方法"],
				[4, "", "方法論與資料呈現及分析是否一致？", "Methodology congruent with data analysis", "分析方法"],
				[5, "", "方法論與結果詮釋是否一致？", "Methodology congruent with interpretation", "詮釋方式"],
				[6, "", "是否說明研究者的文化或理論立場？", "Researcher's cultural or theoretical location stated", "研究者背景"],
				[7, "", "是否處理研究者對研究的影響及研究對研究者的影響？", "Researcher influence addressed", "反身性"],
				[8, "", "參與者及其聲音是否充分呈現？", "Participants' voices represented", "引文"],
				[9, "", "研究是否符合倫理，並有倫理審查核准的證據？", "Ethical and approved", "IRB 核准"],
				[10, "", "結論是否源自資料的分析或詮釋？", "Conclusions flow from the data", "結論與資料的連結"],
			]),
			verdicts: VERDICTS.slice(),
		},
		{
			id: "jbi-sr",
			family: "JBI",
			name: "JBI Checklist for Systematic Reviews and Research Syntheses",
			nameZh: "JBI 系統性回顧與研究綜整評讀表",
			version: "2017",
			designs: ["systematic review", "meta-analysis", "scoping review"],
			source: JBI_TOOLS_URL,
			license: JBI_LICENSE,
			verification: "11 題與題序同插件 AI 筆記提示（llm.js）；未連線核對",
			items: items([
				[1, "", "回顧問題是否清楚明確？", "Review question clearly stated", "PICO 或 PCC"],
				[2, "", "納入條件是否適合回顧問題？", "Inclusion criteria appropriate", "研究設計、族群、介入"],
				[3, "", "搜尋策略是否適當？", "Appropriate search strategy", "關鍵字、MeSH、布林邏輯"],
				[4, "", "搜尋的資料庫與來源是否足夠？", "Adequate sources and resources", "資料庫數量、灰色文獻"],
				[5, "", "評讀研究的標準是否適當？", "Appropriate criteria for appraising studies", "評讀工具"],
				[6, "", "是否由兩位以上評讀者獨立評讀？", "Appraisal by two or more reviewers independently", "獨立評讀、歧見處理"],
				[7, "", "是否有減少資料萃取錯誤的方法？", "Methods to minimize data extraction errors", "雙人萃取"],
				[8, "", "合併研究的方法是否適當？", "Appropriate methods to combine studies", "統合分析模式、異質性"],
				[9, "", "是否評估出版偏差的可能性？", "Publication bias assessed", "漏斗圖、Egger test"],
				[10, "", "政策或實務建議是否有資料支持？", "Recommendations supported by the data", "結論與證據的一致性"],
				[11, "", "對未來研究的具體建議是否適當？", "Appropriate directives for new research", "研究缺口"],
			]),
			verdicts: VERDICTS.slice(),
		},
		{
			id: "jbi-case-report",
			family: "JBI",
			name: "JBI Checklist for Case Reports",
			nameZh: "JBI 個案報告評讀表",
			version: "2017",
			designs: ["case report", "other"],
			source: JBI_TOOLS_URL,
			license: JBI_LICENSE,
			verification: NOT_VERIFIED,
			items: items([
				[1, "", "病人的人口學特徵是否清楚描述？", "Demographic characteristics described", "年齡、性別、背景"],
				[2, "", "病人的病史是否清楚描述並以時間軸呈現？", "History described as a timeline", "病程時間軸"],
				[3, "", "病人就診時的臨床狀況是否清楚描述？", "Clinical condition on presentation described", "症狀、徵象"],
				[4, "", "診斷檢查或評估方法及結果是否清楚描述？", "Diagnostic tests and results described", "檢查與結果"],
				[5, "", "介入或治療程序是否清楚描述？", "Intervention / treatment described", "措施內容"],
				[6, "", "介入後的臨床狀況是否清楚描述？", "Post-intervention condition described", "結果"],
				[7, "", "是否辨識並描述不良或非預期事件？", "Adverse or unanticipated events described", "不良事件"],
				[8, "", "個案報告是否提供可借鏡的經驗？", "Takeaway lessons provided", "臨床啟示"],
			]),
			verdicts: VERDICTS.slice(),
		},
		{
			id: "jbi-text-opinion",
			family: "JBI",
			name: "JBI Checklist for Text and Opinion",
			nameZh: "JBI 文本與專家意見評讀表",
			version: "2017",
			designs: ["guideline", "other"],
			source: JBI_TOOLS_URL,
			license: JBI_LICENSE,
			verification: NOT_VERIFIED + "；臨床指引建議改用 AGREE II（未內建）",
			items: items([
				[1, "", "意見的來源是否清楚指明？", "Source of the opinion clearly identified", "作者、機構"],
				[2, "", "意見來源在該專業領域是否具有地位？", "Source has standing in the field", "專業資歷"],
				[3, "", "意見是否以相關族群的利益為核心？", "Interests of the population central", "以病人或族群為中心"],
				[4, "", "所陳述的立場是否為分析的結果，且邏輯是否清楚？", "Position results from an analytical process", "論證過程"],
				[5, "", "是否引用現有文獻？", "Reference to the extant literature", "文獻支持"],
				[6, "", "與文獻或來源不一致之處是否有合理辯護？", "Incongruence with the literature defended", "反面證據的處理"],
			]),
			verdicts: VERDICTS.slice(),
		},
	];

	const BY_ID = new Map(TOOLS.map(t => [t.id, t]));

	function getTool(id) {
		if (id && typeof id === "object" && id.items) return id;
		return BY_ID.get(String(id || "")) || null;
	}

	function normDesign(design) {
		return String(design || "").trim().toLowerCase().replace(/[_\s]+/g, " ").replace(/case control/, "case-control");
	}

	/** Tools for a study design (STUDY_DESIGNS in llm.js), best first: CASP before JBI (TWNA prefers CASP). */
	function toolsForDesign(design) {
		let d = normDesign(design);
		if (d === "rct" || /random/.test(d)) d = "rct";
		else if (/quasi/.test(d)) d = "quasi-experimental";
		let hits = TOOLS.filter(t => t.designs.some(x => normDesign(x) === d));
		let rank = t => (t.family === "CASP" ? 0 : 1);
		return hits.map((t, i) => ({ t, i })).sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i).map(x => x.t);
	}

	// Words in a checklist name → the tool's design key
	const NAME_PATTERNS = [
		[/random|\brcts?\b|隨機/, "rct"],
		[/quasi|non-?randomi[sz]ed experimental|類實驗/, "quasi"],
		[/systematic|meta-?analys|research synthes|系統性回顧|統合分析/, "sr"],
		[/case[\s-]*control|病例對照/, "case-control"],
		[/cohort|世代/, "cohort"],
		[/prevalence|盛行率/, "prevalence"],
		[/cross[\s-]*sectional|橫斷/, "cross-sectional"],
		[/qualitative|質性/, "qualitative"],
		[/diagnos|診斷/, "diagnostic"],
		[/case report|個案報告/, "case-report"],
		[/text and opinion|opinion|專家意見/, "text-opinion"],
	];
	const KEY_TO_ID = {
		CASP: { rct: "casp-rct", sr: "casp-sr", cohort: "casp-cohort", "case-control": "casp-case-control", qualitative: "casp-qualitative", diagnostic: "casp-diagnostic" },
		JBI: {
			rct: "jbi-rct", quasi: "jbi-quasi", sr: "jbi-sr", cohort: "jbi-cohort", "case-control": "jbi-case-control", prevalence: "jbi-prevalence",
			"cross-sectional": "jbi-cross-sectional", qualitative: "jbi-qualitative", "case-report": "jbi-case-report", "text-opinion": "jbi-text-opinion",
		},
	};

	/**
	 * The tool an AI note's appraisal_tool (or any free-text checklist name) refers to; null when
	 * none fits (e.g. MMAT, AGREE II). Without "CASP" or "JBI" in the name, JBI is assumed (the
	 * plugin's prompt asks for JBI by default) unless only CASP has such a checklist.
	 */
	function findToolByName(name) {
		let s = String(name || "").trim();
		if (!s) return null;
		let exact = getTool(s.toLowerCase()) || TOOLS.find(t => t.name.toLowerCase() === s.toLowerCase() || t.nameZh === s);
		if (exact) return exact;
		let low = s.toLowerCase();
		if (/\bmmat\b|agree|amstar|rob ?2|robins|grade|newcastle|strobe|consort|prisma/.test(low)) return null;
		let family = /\bcasp\b|critical appraisal skills/.test(low) ? "CASP"
			: /\bjbi\b|joanna briggs/.test(low) ? "JBI" : "";
		let key = null;
		for (let [re, k] of NAME_PATTERNS) {
			if (re.test(low)) {
				key = k;
				break;
			}
		}
		if (!key) return null;
		let id = family ? KEY_TO_ID[family][key] : (KEY_TO_ID.JBI[key] || KEY_TO_ID.CASP[key]);
		return getTool(id);
	}

	// ---------- answers ----------

	const ANSWER_ALIASES = [
		[/^(是|yes|y|符合|有)$/i, "是"],
		[/^(否|no|n|不符合|無)$/i, "否"],
		[/^(不清楚|不明確|無法判斷|不確定|unclear|can'?t tell|cannot tell|unknown|\?)$/i, "不清楚"],
		[/^(不適用|n\/?a|not applicable|na)$/i, "不適用"],
	];

	/** One of ANSWERS for a loose answer word ("Yes", "Can't tell", "不明確"…), or "". */
	function normalizeAnswer(v) {
		let s = String(v === undefined || v === null ? "" : v).trim().replace(/^\*+|\*+$/g, "").trim();
		if (ANSWERS.includes(s)) return s;
		for (let [re, a] of ANSWER_ALIASES) if (re.test(s)) return a;
		return "";
	}

	function normalizeVerdict(v) {
		let s = String(v || "").trim();
		return VERDICTS.includes(s) ? s : "";
	}

	/**
	 * Clean an answers map: { itemId: { answer, note, source? } }. A bare string value is taken as the
	 * answer. Entries with neither answer nor note are dropped; unknown answers become "".
	 */
	function normalizeAnswers(answers) {
		let out = {};
		if (!answers || typeof answers !== "object") return out;
		for (let [id, v] of Object.entries(answers)) {
			let entry = typeof v === "string" ? { answer: v } : (v && typeof v === "object" ? v : {});
			let answer = normalizeAnswer(entry.answer);
			let note = String(entry.note === undefined || entry.note === null ? "" : entry.note).trim();
			if (!answer && !note) continue;
			let clean = { answer, note };
			if (entry.source === "ai" || entry.source === "human") clean.source = entry.source;
			out[String(id)] = clean;
		}
		return out;
	}

	function scoredItems(tool) {
		return tool.items.filter(i => !i.open);
	}

	/**
	 * Counts over the tool's scored items (open-ended "what are the results" items are left out):
	 * { counts: {是,否,不清楚,不適用}, total, answered, percentYes, missing }
	 * percentYes = 是 ÷ (answered − 不適用) × 100, rounded; null when nothing applicable is answered.
	 */
	function summarize(tool, answers) {
		tool = getTool(tool);
		let counts = { 是: 0, 否: 0, 不清楚: 0, 不適用: 0 };
		let missing = [];
		let answered = 0;
		let a = normalizeAnswers(answers);
		for (let item of tool ? scoredItems(tool) : []) {
			let v = a[item.id] && a[item.id].answer;
			if (v) {
				counts[v]++;
				answered++;
			}
			else {
				missing.push(item.id);
			}
		}
		let total = tool ? scoredItems(tool).length : 0;
		let applicable = answered - counts.不適用;
		return { counts, total, answered, percentYes: applicable > 0 ? Math.round(counts.是 / applicable * 100) : null, missing };
	}

	/** One line: "是 8／否 2／不清楚 1／不適用 0（共 11 題，已答 11 題）". */
	function describeSummary(s) {
		return ANSWERS.map(a => `${a} ${s.counts[a]}`).join("／") + `（共 ${s.total} 題，已答 ${s.answered} 題`
			+ (s.percentYes === null ? "" : `，「是」占 ${s.percentYes}%`) + "）";
	}

	function cell(v) {
		return String(v === undefined || v === null ? "" : v).replace(/\r?\n+/g, " ").replace(/\|/g, "\\|").trim();
	}

	function itemLabel(item) {
		return `${item.id}. ${item.text}`;
	}

	/**
	 * The TWNA-style appraisal table 「評讀項目 | 評讀結果 | 評析根據」.
	 * opts: { includeNotes (default true; false drops the 評析根據 column), sections (group rows),
	 *   empty: text for an unanswered item (default "（未評）") }
	 */
	function toMarkdownTable(tool, answers, opts = {}) {
		tool = getTool(tool);
		if (!tool) return "";
		let notes = opts.includeNotes !== false;
		let empty = opts.empty === undefined ? "（未評）" : opts.empty;
		let head = notes ? TABLE_HEAD : TABLE_HEAD.slice(0, 2);
		let lines = [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`];
		let a = normalizeAnswers(answers);
		let section = null;
		for (let item of tool.items) {
			if (opts.sections && item.section && item.section !== section) {
				section = item.section;
				lines.push(`| **${cell(section)}** |${notes ? "  |  |" : "  |"}`);
			}
			let entry = a[item.id] || {};
			let row = [cell(itemLabel(item)), cell(entry.answer) || (item.open && entry.note ? "（見評析）" : empty)];
			if (notes) row.push(cell(entry.note));
			lines.push(`| ${row.join(" | ")} |`);
		}
		return lines.join("\n");
	}

	// ---------- CSV ----------

	function csvCell(v) {
		let s = String(v === undefined || v === null ? "" : v);
		// A cell starting with = + - @ would run as a formula in Excel
		if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(?:\.\d+)?$/.test(s)) s = "'" + s;
		return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, "\"\"")}"` : s;
	}

	/**
	 * CSV with a UTF-8 BOM and CRLF line ends (Excel opens the Chinese text correctly).
	 * rows: arrays (the first row is the header) or objects (their keys, in first-seen order, are the header).
	 */
	function toCSV(rows) {
		rows = rows || [];
		let lines;
		if (rows.length && !Array.isArray(rows[0])) {
			let keys = [];
			for (let r of rows) for (let k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
			lines = [keys, ...rows.map(r => keys.map(k => r[k]))];
		}
		else {
			lines = rows;
		}
		return "﻿" + lines.map(l => l.map(csvCell).join(",")).join("\r\n") + "\r\n";
	}

	/** One CSV row per item: the long format used by the collection summary. */
	function csvRows(tool, answers, extra = {}) {
		tool = getTool(tool);
		let a = normalizeAnswers(answers);
		return (tool ? tool.items : []).map(item => Object.assign({}, extra.before || {}, {
			評讀工具: tool.name,
			題號: item.id,
			評讀項目: item.text,
			評讀結果: (a[item.id] && a[item.id].answer) || "",
			評析根據: (a[item.id] && a[item.id].note) || "",
		}, typeof extra.after === "function" ? extra.after(item) : (extra.after || {})));
	}

	// ---------- JSON ----------

	const FORMAT = "zotero-bridge-appraisal";
	const MAX_COACH_RUNS = 5;

	function isoDate(v) {
		let m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v || ""));
		return m ? m[1] : "";
	}

	/**
	 * A complete appraisal record (what the Zotero child note and the web page store):
	 * { format, version, tool, answers, overall, overallNote, verified, verifiedAt, reviewer,
	 *   dual, answersB, overallB, reviewerB, aiTool, updatedAt, coach? }
	 */
	function normalizeRecord(obj) {
		let r = obj && typeof obj === "object" ? obj : {};
		let tool = getTool(r.tool || r.toolId);
		let out = {
			format: FORMAT,
			version: 1,
			tool: tool ? tool.id : (r.tool ? String(r.tool) : null),
			answers: normalizeAnswers(r.answers),
			overall: normalizeVerdict(r.overall),
			overallNote: String(r.overallNote || "").trim(),
			verified: r.verified === true,
			verifiedAt: r.verified === true ? isoDate(r.verifiedAt) : "",
			reviewer: String(r.reviewer || "").trim(),
			dual: r.dual === true,
			answersB: normalizeAnswers(r.answersB),
			overallB: normalizeVerdict(r.overallB),
			reviewerB: String(r.reviewerB || "").trim(),
			aiTool: String(r.aiTool || "").trim(),
			updatedAt: String(r.updatedAt || ""),
		};
		// 評讀陪練 runs (appraisal-coach.js), kept as plain JSON; only present when there are any
		let coach = Array.isArray(r.coach) ? r.coach.filter(x => x && typeof x === "object" && !Array.isArray(x)) : [];
		if (coach.length) out.coach = JSON.parse(JSON.stringify(coach.slice(-MAX_COACH_RUNS)));
		return out;
	}

	function looksLikeRecord(obj) {
		return !!obj && typeof obj === "object" && ("answers" in obj || obj.format === FORMAT);
	}

	/** JSON text for a record, or for a bare answers map ({ itemId: { answer, note } }). */
	function toJSON(recordOrAnswers, space = 2) {
		let r = normalizeRecord(looksLikeRecord(recordOrAnswers) ? recordOrAnswers : { answers: recordOrAnswers });
		return JSON.stringify(r, null, space);
	}

	/** A normalized record from JSON text (or an object); a bare answers map becomes { tool: null, answers }. Throws on bad JSON. */
	function fromJSON(input) {
		let obj = typeof input === "string" ? JSON.parse(input) : input;
		if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("評讀表資料不是 JSON 物件");
		return normalizeRecord(looksLikeRecord(obj) ? obj : { answers: obj });
	}

	// ---------- the AI note's 嚴格評讀 section ----------

	const AI_HEADING = "嚴格評讀";

	/** The 嚴格評讀 section of a Markdown note (without its heading), or "". */
	function aiSection(md, heading = AI_HEADING) {
		let text = String(md || "");
		let re = new RegExp(`^(#{1,6})\\s*${heading}\\s*$`, "m");
		let m = re.exec(text);
		if (!m) return "";
		let after = text.slice(m.index + m[0].length);
		let next = new RegExp(`^#{1,${m[1].length}}\\s`, "m").exec(after);
		return (next ? after.slice(0, next.index) : after).trim();
	}

	const ANSWER_WORD = "(不適用|不清楚|不明確|無法判斷|是|否|Yes|No|Unclear|Can'?t tell|N\\/A|NA|Not applicable)";
	const ITEM_RE = /^\s*(?:[-*+]\s+)?(?:Q\s*)?(\d{1,2})\s*(?:\(?([a-cA-C])\)?)?\s*[.)、．:：]\s*(.+)$/;
	const SEP_RE = /^\s*(?:[—–－]+|-{1,2}|[:：])\s*/;

	/** "（題目）：是 — 理由" → { answer, note, text }; answer "" when none is found. */
	function splitAnswer(rest) {
		let re = new RegExp(`[：:]\\s*\\**\\s*${ANSWER_WORD}\\s*\\**(?=\\s|$|[—–－(（,，;；。-])`, "gi");
		let m;
		while ((m = re.exec(rest))) {
			let answer = normalizeAnswer(m[1]);
			if (!answer) continue;
			let note = rest.slice(m.index + m[0].length).replace(SEP_RE, "").trim();
			return { answer, note, text: rest.slice(0, m.index).trim() };
		}
		return { answer: "", note: "", text: rest.trim() };
	}

	/**
	 * Parse the AI note's 嚴格評讀 section:
	 * { toolName, tool, items: [{ id, number, letter, seq, text, answer, note }], overall, overallNote }
	 * Item numbers that restart (a list split by section headings) continue the running sequence.
	 */
	function parseAIAppraisal(md) {
		let section = aiSection(md);
		let out = { toolName: "", tool: null, items: [], overall: "", overallNote: "" };
		if (!section) return out;
		let seq = 0;
		let lastRaw = 0;
		let lastN = 0;
		let offset = 0;
		for (let raw of section.split("\n")) {
			let line = raw.replace(/\*\*/g, "").trim();
			if (!line) continue;
			let m;
			if ((m = /評讀工具\s*[：:]\s*(.+)$/.exec(line))) {
				out.toolName = m[1].trim();
				continue;
			}
			if ((m = /整體(?:評價|評讀|判斷)\s*[：:]\s*(納入|排除|需更多資訊)\s*(.*)$/.exec(line))) {
				out.overall = m[1];
				out.overallNote = m[2].replace(SEP_RE, "").trim();
				continue;
			}
			if ((m = ITEM_RE.exec(line))) {
				let number = Number(m[1]);
				let letter = (m[2] || "").toLowerCase();
				let parts = splitAnswer(m[3]);
				if (!parts.answer && !/[：:]/.test(m[3])) continue;
				// A list restarted at 1 after a section heading: keep counting from the last number
				if (seq && (letter ? number < lastRaw : number <= lastRaw)) offset = lastN;
				// …unless the line goes on with the absolute numbering (4b after a restarted "1. 4(a)")
				else if (offset && (number === lastN || number === lastN + 1)) offset = 0;
				let n = number + offset;
				lastRaw = number;
				lastN = n;
				seq++;
				out.items.push({ id: letter ? `${n}${letter}` : String(n), number: n, letter, seq, text: parts.text, answer: parts.answer, note: parts.note });
			}
		}
		out.tool = findToolByName(out.toolName);
		return out;
	}

	/**
	 * Answers for `tool` from a parsed AI appraisal (source "ai"). Only when the AI used the same
	 * tool: by position when the counts agree, otherwise by item number; unmatched items stay empty.
	 */
	function answersFromAI(parsed, tool) {
		tool = getTool(tool);
		let out = {};
		if (!tool || !parsed || !parsed.tool || parsed.tool.id !== tool.id) return out;
		let list = parsed.items.filter(i => i.answer || i.note);
		let byPosition = parsed.items.length === tool.items.length;
		tool.items.forEach((item, k) => {
			let hit = byPosition ? parsed.items[k] : list.find(i => i.id === item.id);
			if (!hit || (!hit.answer && !hit.note)) return;
			out[item.id] = { answer: hit.answer, note: hit.note, source: "ai" };
		});
		return out;
	}

	// ---------- two reviewers: Cohen's kappa ----------

	/**
	 * Cohen's κ for paired categorical answers [[a, b], …] (pairs with a missing answer are skipped):
	 *   p_o = agreements ÷ n;  p_e = Σ_k (n_A,k ÷ n)(n_B,k ÷ n);  κ = (p_o − p_e) ÷ (1 − p_e)
	 * κ is null when n = 0, or when p_e = 1 (both reviewers used one same answer throughout).
	 */
	function cohenKappa(pairs) {
		let valid = (pairs || []).filter(([a, b]) => normalizeAnswer(a) && normalizeAnswer(b)).map(([a, b]) => [normalizeAnswer(a), normalizeAnswer(b)]);
		let n = valid.length;
		if (!n) return { n: 0, agree: 0, po: null, pe: null, kappa: null };
		let agree = valid.filter(([a, b]) => a === b).length;
		let po = agree / n;
		let pe = 0;
		for (let k of ANSWERS) {
			let pa = valid.filter(([a]) => a === k).length / n;
			let pb = valid.filter(([, b]) => b === k).length / n;
			pe += pa * pb;
		}
		let kappa = pe >= 1 ? null : (po - pe) / (1 - pe);
		return { n, agree, po, pe, kappa };
	}

	/** Answer pairs (reviewer A, reviewer B) over the tool's scored items. */
	function answerPairs(tool, answersA, answersB) {
		tool = getTool(tool);
		let a = normalizeAnswers(answersA);
		let b = normalizeAnswers(answersB);
		return (tool ? scoredItems(tool) : []).map(item => [(a[item.id] || {}).answer || "", (b[item.id] || {}).answer || ""]);
	}

	function kappa(tool, answersA, answersB) {
		return cohenKappa(answerPairs(tool, answersA, answersB));
	}

	/** Landis & Koch (1977) labels. */
	function kappaLabel(k) {
		if (k === null || k === undefined || !Number.isFinite(k)) return "無法計算";
		if (k < 0) return "低於隨機一致";
		if (k <= 0.20) return "輕微一致";
		if (k <= 0.40) return "尚可";
		if (k <= 0.60) return "中等一致";
		if (k <= 0.80) return "高度一致";
		return "幾乎完全一致";
	}

	function formatKappa(r) {
		if (!r || !r.n) return "—（沒有雙方都作答的題目）";
		let po = `一致率 ${Math.round(r.po * 100)}%（${r.agree}/${r.n}）`;
		if (r.kappa === null) return `κ 無法計算（雙方答案沒有變異）；${po}`;
		return `κ = ${r.kappa.toFixed(2)}（${kappaLabel(r.kappa)}）；${po}`;
	}

	/** Items where both reviewers answered differently: [{ id, text, a, b }]. */
	function disagreements(tool, answersA, answersB) {
		tool = getTool(tool);
		let a = normalizeAnswers(answersA);
		let b = normalizeAnswers(answersB);
		let out = [];
		for (let item of tool ? scoredItems(tool) : []) {
			let x = (a[item.id] || {}).answer || "";
			let y = (b[item.id] || {}).answer || "";
			if (x && y && x !== y) out.push({ id: item.id, text: item.text, a: x, b: y });
		}
		return out;
	}

	// ---------- traffic-light matrix ----------

	/**
	 * Studies × items for one tool. studies: [{ label, answers, overall, verified }].
	 * opts: { plain: ✓ ✗ ? – instead of emoji (Word) }
	 */
	function trafficLightMatrix(tool, studies, opts = {}) {
		tool = getTool(tool);
		if (!tool) return "";
		let icons = opts.plain ? PLAIN_ICONS : ICONS;
		let missing = opts.plain ? PLAIN_MISSING : MISSING_ICON;
		let head = ["文獻", ...tool.items.map(i => i.id), "整體評價", "核對"];
		let lines = [`| ${head.join(" | ")} |`, `|${head.map(() => ":---:").join("|")}|`];
		for (let s of studies || []) {
			let a = normalizeAnswers(s.answers);
			let cells = tool.items.map(i => (a[i.id] && a[i.id].answer ? icons[a[i.id].answer] : missing));
			lines.push(`| ${[cell(s.label), ...cells, cell(s.overall) || "—", s.verified ? "已核對" : "未核對"].join(" | ")} |`);
		}
		return lines.join("\n");
	}

	function legend(opts = {}) {
		let icons = opts.plain ? PLAIN_ICONS : ICONS;
		return ANSWERS.map(a => `${icons[a]} ${a}`).join("　") + `　${opts.plain ? "（空白）" : MISSING_ICON} 未評`;
	}

	return {
		ANSWERS, VERDICTS, DESIGNS, TOOLS, ICONS, PLAIN_ICONS, MISSING_ICON, TABLE_HEAD, FORMAT, AI_HEADING,
		getTool, toolsForDesign, findToolByName,
		normalizeAnswer, normalizeVerdict, normalizeAnswers, summarize, describeSummary, toMarkdownTable, itemLabel,
		csvCell, toCSV, csvRows, normalizeRecord, toJSON, fromJSON,
		aiSection, parseAIAppraisal, answersFromAI,
		cohenKappa, answerPairs, kappa, kappaLabel, formatKappa, disagreements,
		trafficLightMatrix, legend,
	};
});
