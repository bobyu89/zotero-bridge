/*
 * Zotero Bridge — LLM step: turns a Zotero item into a structured literature note.
 * Providers: Anthropic (Claude Messages API) and OpenAI (Responses API).
 * Raw HTTP is used because the plugin runs in Zotero's privileged sandbox without a module bundler.
 */
(function (root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) {
		module.exports = api;
	}
	else {
		(root.ZB = root.ZB || {}).llm = api;
	}
})(this, function () {
	const DEFAULT_MODELS = {
		anthropic: "claude-opus-5-5",
		openai: "gpt-5.5",
	};

	const SUMMARY_HEADING = "一句話摘要";
	const APPRAISAL_HEADING = "嚴格評讀";

	// Values allowed for study_design (the JSON block) and the Notion "Study Design" select
	const STUDY_DESIGNS = [
		"RCT", "quasi-experimental", "cohort", "case-control", "cross-sectional", "qualitative",
		"mixed methods", "systematic review", "meta-analysis", "scoping review", "guideline", "other",
	];
	const APPRAISAL_VERDICTS = ["納入", "排除", "需更多資訊"];
	// Field order of the structured data (also the order of the stored JSON)
	const STUDY_FIELDS = [
		"study_design", "sample_size", "setting", "population", "intervention", "comparison", "outcomes",
		"measures", "evidence_level", "jbi_level", "appraisal_tool", "appraisal_overall", "country",
	];
	// Heading above the JSON kept in the Zotero AI note; removed again when the note is read back
	const STUDY_DATA_HEADING = "📋 結構化資料（Zotero Bridge）";

	// Plugin-owned: always appended to the user message (also with a custom template), because
	// the Notion columns and Obsidian properties are filled from this block.
	const STUDY_DATA_PROMPT = `最後，在筆記的最末端另外輸出一個 \`\`\`json 程式碼區塊，內容是這篇文獻的結構化資料（系統會把它寫入 Notion 欄位與 Obsidian 屬性，並從筆記中移除）。區塊前不要加標題，區塊後不要再有任何文字。格式如下（數值只是格式示範，請依這篇文獻填寫）：
\`\`\`json
{
  "study_design": "RCT",
  "sample_size": 120,
  "setting": "台灣某醫學中心內科病房",
  "population": "65 歲以上住院病人",
  "intervention": "護理師主導跌倒預防衛教",
  "comparison": "常規照護",
  "outcomes": "跌倒發生率、跌倒自我效能",
  "measures": ["Morse Fall Scale", "Falls Efficacy Scale-International"],
  "evidence_level": "2",
  "jbi_level": "1.c",
  "appraisal_tool": "JBI Checklist for Randomized Controlled Trials",
  "appraisal_overall": "納入",
  "country": "Taiwan"
}
\`\`\`
欄位規則：
- study_design：只能是 ${STUDY_DESIGNS.map(d => `"${d}"`).join("、")} 其中之一；系統性回顧含統合分析填 "meta-analysis"，單組前後測填 "quasi-experimental"。
- sample_size：最終納入分析的總人數（整數，不加引號）；質性研究填受訪人數，系統性回顧／統合分析填合併的總受試者數；未報告填 null。
- setting、population、intervention、comparison、outcomes：各一個簡短字串（繁體中文，術語保留英文，60 字以內）；不適用或文中未報告填 null。
- measures：測量工具名稱的陣列，用原文名稱（例如 "Morse Fall Scale"）；沒有填 []。
- evidence_level：Oxford CEBM 2011 Levels of Evidence 的等級，只填 "1"～"5" 的字串（治療效益問題：RCT 的系統性回顧 "1"、RCT "2"、非隨機對照 cohort／追蹤研究 "3"、case series／case-control／歷史對照 "4"、機轉推論 "5"）；不適用（例如質性研究）填 null。
- jbi_level：JBI Levels of Evidence 的等級字串，例如 "1.c"、"2.d"、"3.c"、"4.b"；質性研究用 JBI Levels of Evidence for Meaningfulness（例如 "3"）；無法判斷填 null。
- appraisal_tool：「${APPRAISAL_HEADING}」使用的清單英文官方名稱；沒有評讀填 null。
- appraisal_overall：只能是 ${APPRAISAL_VERDICTS.map(v => `"${v}"`).join("、")} 其中之一，與「${APPRAISAL_HEADING}」的整體評價一致；沒有評讀填 null。
- country：研究執行的國家（英文國名，例如 "Taiwan"、"United States"）；多國研究填 "Multinational"；未報告填 null。
- 使用標準 JSON：雙引號、不加註解、不要尾隨逗號。`;

	const DEFAULT_SYSTEM_PROMPT = `你是護理與醫學領域的研究助理，負責把一篇文獻整理成結構化的「文獻筆記」，供研究生在 Obsidian 與 Notion 中閱讀與建立知識連結，並用於碩士論文與實證護理（EBP）報告。

寫作規則：
- 使用繁體中文；醫學、統計與研究方法術語保留英文（例如 randomized controlled trial、odds ratio、95% CI）。
- 只根據提供的書目資料、摘要、全文、註記與筆記撰寫；資料中沒有的資訊寫「文中未報告」，不要推測或編造數據、作者、頁碼或參考文獻。
- 數據要具體：樣本數、效應量、p 值、信賴區間照原文寫出。
- 引用使用者的劃線或全文時，標示頁碼（例如 p. 5）。
- 「關鍵概念」用 Obsidian 雙中括號 [[概念]] 標記 3–8 個可跨文獻重複使用的概念，名稱用通用寫法（例如 [[Self-efficacy]]、[[Fall prevention]]）。
- 「可引用的句子」必須逐字照抄全文或摘要裡的原句（保留原文語言，不要翻譯、改寫或合併句子；省略的部分用 … 表示），系統會自動與全文比對查證。
- 不要使用表格；不要輸出 APA 參考文獻（系統會由 Zotero 自動產生）；不要加前言或結語，直接輸出 Markdown。

輸出格式（標題必須完全一致）：
## ${SUMMARY_HEADING}
（一句話，60 字以內）

## 研究背景與目的

## 研究設計與方法
- 研究設計：
- 場域與樣本：
- 介入／暴露：
- 測量工具（含信效度）：
- 統計分析：

## 主要結果

## 作者結論

## 研究限制
- 作者自述：
- 其他限制：

## ${APPRAISAL_HEADING}
- 評讀工具：（依研究設計選擇下方對應的 JBI 清單，寫出英文官方名稱；也可改用對應的 CASP checklist）
1. （題目）：是／否／不清楚／不適用 — （一句理由，引用文中證據）
2. …
- 整體評價：納入／排除／需更多資訊 — （一句理由）

## 證據等級
（分別給出 Oxford CEBM 2011 與 JBI Levels of Evidence 的等級，並說明理由）

## 對我的研究的啟發

## 關鍵概念

## 可引用的句子
（3–5 句，每句一行：- "原文句子" (p. 頁碼) — 一句中文說明）

嚴格評讀規則：
- 依研究設計選一份清單：RCT → JBI Checklist for Randomized Controlled Trials；quasi-experimental（含單組前後測）→ JBI Checklist for Quasi-Experimental Studies；cohort → JBI Checklist for Cohort Studies；case-control → JBI Checklist for Case Control Studies；analytical cross-sectional → JBI Checklist for Analytical Cross Sectional Studies；qualitative → JBI Checklist for Qualitative Research；systematic review／meta-analysis → JBI Checklist for Systematic Reviews and Research Syntheses。其他設計用最接近的官方工具（例如描述性盛行率調查 → JBI Checklist for Prevalence Studies、mixed methods → MMAT 2018、臨床指引 → AGREE II）；scoping review 通常不做方法學品質評讀，寫「不適用」並說明。
- 題目必須是所選官方清單的題目，依官方原文逐題轉述為繁體中文，題數與順序與官方版本一致，不可自行增刪或合併題目。下方列出常用 JBI 清單的題目大意供對照，實際用字以官方原文為準。
- 每題只能回答「是」「否」「不清楚」「不適用」其中之一，後面接一句理由；資料不足時答「不清楚」，不要推測。
- 整體評價只能是「納入」「排除」「需更多資訊」其中之一。

常用 JBI 清單題目大意：
- RCT（13 題）：1 是否真正隨機分派；2 分派是否隱匿（allocation concealment）；3 各組基準期特性是否相似；4 受試者是否對分組設盲；5 執行介入者是否設盲；6 除介入外各組是否接受相同照護；7 結果評估者是否設盲；8 各組結果測量方式是否相同；9 結果測量是否可信（reliable）；10 追蹤是否完整，若否，各組追蹤差異是否充分描述與分析；11 受試者是否依原隨機分組分析（intention-to-treat）；12 統計分析是否適當；13 試驗設計是否適當，偏離標準 RCT 設計（個別隨機、平行組）之處是否在執行與分析中處理。
- Quasi-experimental（9 題）：1 是否清楚區分「因」與「果」；2 比較的受試者是否相似；3 除介入外，比較的受試者是否接受相似照護；4 是否有對照組；5 介入前後是否多次測量結果；6 追蹤是否完整，若否，差異是否充分描述與分析；7 比較的受試者結果測量方式是否相同；8 結果測量是否可信；9 統計分析是否適當。
- Cohort（11 題）：1 兩組是否相似且來自同一母群體；2 暴露測量方式是否相同；3 暴露測量是否有效且可信；4 是否辨識干擾因子；5 是否說明處理干擾因子的策略；6 研究開始時受試者是否尚未發生結果；7 結果測量是否有效且可信；8 追蹤時間是否有報告且足以讓結果發生；9 追蹤是否完整，若否，流失原因是否描述與探討；10 是否採取策略處理追蹤不完整；11 統計分析是否適當。
- Case-control（10 題）：1 除疾病有無外，兩組是否可比較；2 病例與對照是否適當配對；3 辨識病例與對照的標準是否相同；4 暴露測量是否標準、有效且可信；5 病例與對照的暴露測量方式是否相同；6 是否辨識干擾因子；7 是否說明處理干擾因子的策略；8 結果評估是否標準、有效且可信；9 關注的暴露期間是否足夠長而有意義；10 統計分析是否適當。
- Analytical cross-sectional（8 題）：1 樣本納入條件是否明確；2 研究對象與場域是否詳細描述；3 暴露測量是否有效且可信；4 是否以客觀、標準的準則測量狀況；5 是否辨識干擾因子；6 是否說明處理干擾因子的策略；7 結果測量是否有效且可信；8 統計分析是否適當。
- Qualitative（10 題）：1 哲學觀點與研究方法論是否一致；2 方法論與研究問題或目的是否一致；3 方法論與資料收集方法是否一致；4 方法論與資料呈現及分析是否一致；5 方法論與結果詮釋是否一致；6 是否說明研究者的文化或理論立場；7 是否處理研究者對研究的影響及研究對研究者的影響；8 參與者及其聲音是否充分呈現；9 研究是否符合倫理並有倫理審查核准的證據；10 結論是否源自資料的分析或詮釋。
- Systematic review（11 題）：1 回顧問題是否清楚明確；2 納入條件是否適合回顧問題；3 搜尋策略是否適當；4 搜尋的資料庫與來源是否足夠；5 評讀研究的標準是否適當；6 是否由兩位以上評讀者獨立評讀；7 是否有減少資料萃取錯誤的方法；8 合併研究的方法是否適當；9 是否評估出版偏差的可能性；10 政策或實務建議是否有資料支持；11 對未來研究的具體建議是否適當。
`;

	function formatAnnotationsForPrompt(data) {
		let lines = [];
		for (let att of data.attachments || []) {
			for (let ann of att.annotations || []) {
				let page = ann.pageLabel ? `p. ${ann.pageLabel}` : "";
				let text = ann.text ? `「${ann.text}」` : `[${ann.type}]`;
				let comment = ann.comment ? ` — 使用者評註：${ann.comment}` : "";
				lines.push(`- ${page} ${text}${comment}`.replace(/\s+/g, " ").trim());
			}
		}
		return lines.join("\n");
	}

	/**
	 * @param {object} data - item data from the Zotero adapter (may include fullText)
	 * @param {object} opts - { systemPrompt, notesMarkdown: [{title, md}], fullTextTruncated }
	 */
	function buildPrompt(data, opts = {}) {
		let meta = [
			`標題：${data.title || ""}`,
			`作者：${(data.creators || []).map(c => c.name || [c.lastName, c.firstName].filter(Boolean).join(", ")).join("; ")}`,
			`年份：${data.year || ""}`,
			`期刊／出處：${data.publication || ""}`,
			`文獻類型：${data.itemType || ""}`,
			data.doi ? `DOI：${data.doi}` : "",
			data.tags && data.tags.length ? `使用者標籤：${data.tags.join(", ")}` : "",
		].filter(Boolean).join("\n");

		let sections = [`<metadata>\n${meta}\n</metadata>`];
		if (data.abstract) sections.push(`<abstract>\n${data.abstract}\n</abstract>`);
		let anns = formatAnnotationsForPrompt(data);
		if (anns) sections.push(`<user_annotations>\n${anns}\n</user_annotations>`);
		let notes = (opts.notesMarkdown || []).map(n => n.md).filter(Boolean).join("\n\n---\n\n");
		if (notes) sections.push(`<user_notes>\n${notes}\n</user_notes>`);
		if (data.fullText) {
			let note = opts.fullTextTruncated ? "（全文過長，以下只提供前段內容；後段未提供的部分請勿推測）\n" : "";
			sections.push(`<fulltext>\n${note}${data.fullText}\n</fulltext>`);
		}
		else {
			sections.push("（沒有可用的全文，只能依據書目資料、摘要與註記撰寫；無法判斷的欄位寫「文中未報告」。）");
		}
		sections.push(STUDY_DATA_PROMPT);
		sections.push("請依照系統指示的格式輸出這篇文獻的結構化筆記，並在最後附上 JSON 資料區塊。");
		return {
			system: (opts.systemPrompt && opts.systemPrompt.trim()) || DEFAULT_SYSTEM_PROMPT,
			user: sections.join("\n\n"),
		};
	}

	async function readJSON(res) {
		let text = await res.text();
		try {
			return text ? JSON.parse(text) : {};
		}
		catch (e) {
			return { raw: text };
		}
	}

	async function callAnthropic({ apiKey, model, effort, system, user, fetch }) {
		let res = await fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
				// Re-run on Anthropic's recommended model if a safety classifier declines
				"anthropic-beta": "server-side-fallback-2026-07-01",
				"anthropic-dangerous-direct-browser-access": "true",
			},
			body: JSON.stringify({
				model: model || DEFAULT_MODELS.anthropic,
				max_tokens: 16000,
				fallbacks: "default",
				output_config: { effort: effort || "medium" },
				system,
				messages: [{ role: "user", content: user }],
			}),
		});
		let json = await readJSON(res);
		if (!res.ok) {
			let msg = (json.error && json.error.message) || json.raw || res.statusText;
			throw new Error(`Claude API ${res.status}: ${msg}`);
		}
		if (json.stop_reason === "refusal") {
			let cat = json.stop_details && json.stop_details.category;
			throw new Error(`Claude 拒絕處理這篇文獻${cat ? `（${cat}）` : ""}`);
		}
		let text = (json.content || []).filter(b => b.type === "text").map(b => b.text).join("");
		if (!text.trim()) throw new Error("Claude 沒有回傳內容");
		if (json.stop_reason === "max_tokens") {
			text += "\n\n> ⚠️ 輸出達到長度上限，內容可能不完整。";
		}
		return { text, model: json.model || model };
	}

	async function callOpenAI({ apiKey, model, system, user, fetch, baseURL }) {
		let base = (baseURL || "https://api.openai.com/v1").replace(/\/+$/, "");
		let res = await fetch(`${base}/responses`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"authorization": `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model: model || DEFAULT_MODELS.openai,
				instructions: system,
				input: user,
			}),
		});
		let json = await readJSON(res);
		if (!res.ok) {
			let msg = (json.error && json.error.message) || json.raw || res.statusText;
			throw new Error(`OpenAI API ${res.status}: ${msg}`);
		}
		let text = typeof json.output_text === "string" ? json.output_text : "";
		if (!text) {
			for (let item of json.output || []) {
				if (item.type !== "message") continue;
				for (let c of item.content || []) {
					if (c.type === "output_text") text += c.text;
					if (c.type === "refusal") throw new Error(`OpenAI 拒絕處理：${c.refusal}`);
				}
			}
		}
		if (!text.trim()) throw new Error("OpenAI 沒有回傳內容");
		if (json.status === "incomplete") {
			text += "\n\n> ⚠️ 輸出未完成，內容可能不完整。";
		}
		return { text, model: json.model || model };
	}

	/** Run one system + user prompt on the configured provider. */
	async function generateText(settings, system, user, fetch) {
		if (!settings.apiKey) throw new Error("尚未設定 LLM API key");
		let common = { apiKey: settings.apiKey, model: settings.model, system, user, fetch };
		if (settings.provider === "openai") {
			return callOpenAI(Object.assign(common, { baseURL: settings.baseURL }));
		}
		return callAnthropic(Object.assign(common, { effort: settings.effort }));
	}

	async function generateNote(settings, data, opts, fetch) {
		let { system, user } = buildPrompt(data, opts);
		return generateText(settings, system, user, fetch);
	}

	/** Pull the one-line summary out of the generated note (for the Notion "Summary" property). */
	function extractSummary(md) {
		let re = new RegExp(`^#{1,6}\\s*${SUMMARY_HEADING}\\s*$`, "m");
		let m = re.exec(md || "");
		let rest = m ? md.slice(m.index + m[0].length) : (md || "");
		let next = /^#{1,6}\s/m.exec(rest);
		let section = (next ? rest.slice(0, next.index) : rest).trim();
		return section.split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim().slice(0, 2000);
	}

	// ---------- structured data (the ```json block at the end of the note) ----------

	// Placeholders models use for "not reported"; stored as empty so filters don't see them as values
	const NOT_REPORTED = new Set([
		"", "null", "none", "n/a", "na", "nr", "-", "—", "not reported", "not applicable", "unknown", "unclear",
		"未報告", "文中未報告", "不適用", "無", "未知", "不清楚", "未提及",
	]);

	function cleanString(v, max = 500) {
		if (v === null || v === undefined || typeof v === "boolean") return "";
		if (Array.isArray(v)) v = v.map(x => cleanString(x, max)).filter(Boolean).join("; ");
		else if (typeof v === "object") return "";
		let s = String(v).replace(/\s+/g, " ").trim();
		return NOT_REPORTED.has(s.toLowerCase()) ? "" : s.slice(0, max);
	}

	const designKey = s => s.toLowerCase().replace(/[\s_-]+/g, " ").trim();
	const DESIGN_BY_KEY = new Map(STUDY_DESIGNS.map(d => [designKey(d), d]));
	// Checked in order, so the more specific designs win ("systematic review and meta-analysis")
	const DESIGN_PATTERNS = [
		[/meta[\s-]?analy|統合分析|後設分析/i, "meta-analysis"],
		[/scoping|範域/i, "scoping review"],
		[/systematic|umbrella|系統性(文獻)?回顧/i, "systematic review"],
		[/mixed|混合/i, "mixed methods"],
		[/guideline|指引/i, "guideline"],
		[/quasi|non[\s-]?randomi[sz]ed|pre[\s-]?(and[\s-]?)?post|before[\s-]and[\s-]after|類實驗|前後測/i, "quasi-experimental"],
		[/\brcts?\b|randomi[sz]ed|隨機/i, "RCT"],
		[/case[\s-]?control|病例對照/i, "case-control"],
		[/cohort|longitudinal|世代|縱貫/i, "cohort"],
		[/cross[\s-]?sectional|survey|橫斷|橫斷面|調查/i, "cross-sectional"],
		[/qualitative|phenomenolog|grounded theory|ethnograph|質性|現象學|紮根/i, "qualitative"],
	];

	function normalizeDesign(v) {
		let s = cleanString(v);
		if (!s) return "";
		let exact = DESIGN_BY_KEY.get(designKey(s));
		if (exact) return exact;
		for (let [re, design] of DESIGN_PATTERNS) {
			if (re.test(s)) return design;
		}
		return "other";
	}

	function normalizeSampleSize(v) {
		if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
		let s = cleanString(v).replace(/(\d)[,，\s](?=\d{3}\b)/g, "$1");
		let m = /\d+/.exec(s);
		return m ? Number(m[0]) : null;
	}

	// Oxford CEBM 2011: "1"–"5" ("Level 2", 2, "Level II" and "CEBM 2011 level 2" all become "2")
	function normalizeEvidenceLevel(v) {
		let s = cleanString(v).replace(/\b(?:19|20)\d\d\b/g, "");
		let m = /[1-5]/.exec(s);
		if (m) return m[0];
		let roman = /(?:^|level\s*)(iv|v|i{1,3})(?![a-z])/i.exec(s);
		return roman ? String(["i", "ii", "iii", "iv", "v"].indexOf(roman[1].toLowerCase()) + 1) : "";
	}

	function normalizeJBILevel(v) {
		return cleanString(v, 40).replace(/^(?:jbi\s*)?(?:level\s*(?:of\s*evidence\s*)?)?[:：]?\s*/i, "");
	}

	function normalizeVerdict(v) {
		let s = cleanString(v, 100);
		if (!s) return "";
		if (/需更多|更多資訊|further|seek|more info/i.test(s)) return "需更多資訊";
		if (/排除|exclude/i.test(s)) return "排除";
		if (/納入|include/i.test(s)) return "納入";
		return s;
	}

	function normalizeMeasures(v) {
		let list = Array.isArray(v) ? v : (typeof v === "string" ? v.split(/[;；、\n]/) : []);
		let seen = new Set();
		let out = [];
		for (let item of list) {
			let s = cleanString(item, 100);
			if (!s || seen.has(s.toLowerCase())) continue;
			seen.add(s.toLowerCase());
			out.push(s);
		}
		return out.slice(0, 30);
	}

	/** Canonical structured data (every STUDY_FIELDS key present), or null when `obj` isn't an object. */
	function normalizeStudyData(obj) {
		if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
		return {
			study_design: normalizeDesign(obj.study_design),
			sample_size: normalizeSampleSize(obj.sample_size),
			setting: cleanString(obj.setting),
			population: cleanString(obj.population),
			intervention: cleanString(obj.intervention),
			comparison: cleanString(obj.comparison),
			outcomes: cleanString(obj.outcomes),
			measures: normalizeMeasures(obj.measures),
			evidence_level: normalizeEvidenceLevel(obj.evidence_level),
			jbi_level: normalizeJBILevel(obj.jbi_level),
			appraisal_tool: cleanString(obj.appraisal_tool, 100),
			appraisal_overall: normalizeVerdict(obj.appraisal_overall),
			country: cleanString(obj.country, 100),
		};
	}

	function parseJSONLenient(text) {
		try {
			return JSON.parse(text);
		}
		catch (e) {}
		// Common model slips: prose around the object, trailing commas
		let start = text.indexOf("{");
		let end = text.lastIndexOf("}");
		if (start < 0 || end <= start) throw new Error("找不到 JSON 物件");
		return JSON.parse(text.slice(start, end + 1).replace(/,\s*([}\]])/g, "$1"));
	}

	function looksLikeStudyData(body) {
		if (!/^\s*\{/.test(body)) return false;
		try {
			let obj = parseJSONLenient(body);
			return !!obj && typeof obj === "object" && STUDY_FIELDS.some(k => k in obj);
		}
		catch (e) {
			return false;
		}
	}

	const DATA_HEADING_RE = /^#{1,6}\s+.*(結構化資料|json|structured data|study data)/i;

	/**
	 * Find the structured-data block in a note (the model's final ```json block, or the
	 * <pre> stored in the Zotero AI note, which reads back as a plain ``` block under
	 * STUDY_DATA_HEADING), parse it and remove it from the Markdown.
	 * @returns {{ md, data, raw, found, error }} data is normalised or null; error is "" when fine
	 */
	function extractStudyData(md) {
		let text = String(md || "");
		let lines = text.split("\n");
		let blocks = [];
		let open = -1;
		let lang = "";
		for (let i = 0; i < lines.length; i++) {
			let m = /^\s*```+\s*([\w-]*)\s*$/.exec(lines[i]);
			if (!m) continue;
			if (open < 0) {
				open = i;
				lang = m[1].toLowerCase();
			}
			else if (!m[1]) {
				blocks.push({ open, close: i, lang });
				open = -1;
			}
		}
		if (open >= 0) blocks.push({ open, close: -1, lang });

		let headingBefore = (b) => {
			for (let i = b.open - 1; i >= 0; i--) {
				if (!lines[i].trim()) continue;
				return DATA_HEADING_RE.test(lines[i]);
			}
			return false;
		};
		let block = null;
		for (let k = blocks.length - 1; k >= 0 && !block; k--) {
			let b = blocks[k];
			let body = lines.slice(b.open + 1, b.close < 0 ? lines.length : b.close).join("\n");
			if (b.lang === "json" || (!b.lang && (headingBefore(b) || looksLikeStudyData(body)))) block = b;
		}
		if (!block) return { md: text, data: null, raw: "", found: false, error: "" };

		let bodyLines = lines.slice(block.open + 1, block.close < 0 ? lines.length : block.close);
		let after = block.close < 0 ? [] : lines.slice(block.close + 1);
		if (block.close < 0) {
			// A truncated block swallows the "⚠️ output was cut off" notice; keep that notice
			let cut = bodyLines.findIndex(l => /^>\s*⚠️/.test(l));
			if (cut >= 0) {
				after = bodyLines.slice(cut);
				bodyLines = bodyLines.slice(0, cut);
			}
		}
		let before = lines.slice(0, block.open);
		let popBlank = () => {
			while (before.length && !before[before.length - 1].trim()) before.pop();
		};
		popBlank();
		if (before.length && DATA_HEADING_RE.test(before[before.length - 1])) before.pop();
		popBlank();
		if (before.length && /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(before[before.length - 1])) before.pop();
		popBlank();
		let rest = after.join("\n").trim();
		let cleaned = before.join("\n") + (rest ? "\n\n" + rest : "");

		let raw = bodyLines.join("\n").trim();
		let data = null;
		let error = "";
		try {
			data = normalizeStudyData(parseJSONLenient(raw));
			if (!data) error = "JSON 不是物件";
		}
		catch (e) {
			error = `JSON 格式錯誤（${e.message || e}）`;
		}
		if (block.close < 0) error = "JSON 區塊不完整，輸出可能被截斷" + (data ? "（已盡量讀取）" : "");
		return { md: cleaned, data, raw, found: true, error };
	}

	/** True when at least one field has a value. */
	function hasStudyData(data) {
		return !!data && STUDY_FIELDS.some((k) => {
			let v = data[k];
			return Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined && v !== "";
		});
	}

	/**
	 * Markdown appended to the AI note stored in Zotero, so a later sync without AI can read the
	 * data back. `raw` is stored instead when the model's JSON could not be parsed, so the user can fix it.
	 */
	function studyDataBlock(data, raw) {
		let json = data ? JSON.stringify(Object.fromEntries(STUDY_FIELDS.map(k => [k, data[k]])), null, 2) : String(raw || "").trim();
		if (!json) return "";
		return `## ${STUDY_DATA_HEADING}\n\n\`\`\`json\n${json}\n\`\`\``;
	}

	return {
		DEFAULT_MODELS, DEFAULT_SYSTEM_PROMPT, buildPrompt, formatAnnotationsForPrompt,
		callAnthropic, callOpenAI, generateText, generateNote, extractSummary,
		STUDY_FIELDS, STUDY_DESIGNS, APPRAISAL_VERDICTS, STUDY_DATA_HEADING, STUDY_DATA_PROMPT, APPRAISAL_HEADING,
		normalizeStudyData, extractStudyData, hasStudyData, studyDataBlock,
	};
});
