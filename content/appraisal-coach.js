/*
 * ZotMax — 評讀陪練 (appraisal coach): 先自己做，再看 AI.
 *
 * Once the user has answered every closed item of a CASP/JBI form themselves, 「對照 AI」 asks an AI to
 * appraise the same paper with the same checklist, from the paper alone: the prompt holds the
 * instructions, the checklist (both cacheable system blocks) and the paper's text, never the user's
 * answers or notes. The plugin, not the AI, then compares: only the items where the AI answered
 * differently are listed, each with the AI's reason and its quotes, checked against the full text
 * (verify.js; unverifiable quotes are dropped, an item left without one is marked 低可信). The user
 * decides per item: 保留我的判斷 or 改成 AI 的答案 (the only way an answer changes), with an optional
 * 為什麼. Every run is kept in the form's JSON (record.coach); the synced appraisal gets one line
 * (「評讀陪練：一致 9/12，修改 1 題」), never the AI's answers.
 *
 * The functions down to "Zotero" are pure (Node tests); the rest needs Zotero and the 文獻評讀表
 * (appraisal-form.js), which calls renderRowButton / renderFormSection / summaryLine.
 */
(function (root, factory) {
	if (typeof module === "object" && module.exports) {
		module.exports = factory(require("./appraisal-tools.js"), require("./verify.js"), require("./usage.js"), require("./review-draft.js"), globalThis);
	}
	else {
		(root.ZB = root.ZB || {}).appraisalCoach = factory(root.ZB.appraisalTools, root.ZB.verify, root.ZB.usage, root.ZB.reviewDraft, root);
	}
})(this, function (tools, verify, usage, reviewDraft, scope) {
	const FEATURE = "appraisalCoach";
	const TITLE = "ZotMax：評讀陪練";
	// Runs kept in the form's JSON (the latest is shown)
	const MAX_RUNS = 5;
	const MAX_QUOTES = 2;
	// A quote shorter than this (words, or CJK characters) proves nothing: dropped like an unverifiable one
	const MIN_QUOTE_TOKENS = 4;
	const MAX_REASON = 600;
	const MAX_QUOTE = 600;
	// Output budget for the estimate: a short JSON entry per item (plus thinking), at most the 16000-token limit
	const OUTPUT_BASE = 600;
	const OUTPUT_PER_ITEM = 250;
	const MAX_OUTPUT_TOKENS = 16000;
	const LOW_CONFIDENCE = "低可信（無原文佐證）";
	const HTML_NS = "http://www.w3.org/1999/xhtml";

	const INSTRUCTIONS = `你是護理與醫學研究方法的評讀助教。一位研究生已經自己用一份嚴格評讀工具（CASP 或 JBI）評讀了一篇文獻；現在請你「只根據提供的原文」，獨立評讀同一份工具的每一題，作為對照。你看不到研究生的答案，也不要猜測他們怎麼答。

作答規則：
- answer：每題只能是「是」「否」「不清楚」「不適用」其中之一（CASP 的 Yes／No／Can't tell 依序對應 是／否／不清楚）。
- 只依據 <paper> 裡的原文判斷。原文沒有報告的，答「不清楚」；不要用一般常識或其他研究補上。
- reason：1–2 句繁體中文，說明你依據原文的哪些內容判斷；研究方法術語保留英文（如 allocation concealment、ITT）。
- quotes：1–2 句支持這個判斷的原文，必須從 <paper> 逐字照抄（保留原文語言，不要翻譯、改寫、合併或補字）；可以只抄一句中連續的一段，但至少 8 個英文字或 15 個中文字。找不到可以引用的原文時，quotes 給空陣列，不要編造。
- page：原文有標示頁碼時填頁碼，否則填空字串。
- 系統提供的每一題都要作答，id 照抄題號。

只輸出一個 JSON 物件，前後不要有其他文字或程式碼區塊標記，格式如下（內容只是格式示範）：
{"items":[{"id":"1","answer":"是","reason":"研究對象、介入、對照與主要結果在前言最後一段都有界定。","quotes":[{"text":"The aim of this trial was to evaluate the effect of a nurse-led education programme on falls","page":"2"}]}]}`;

	// ---------- the checklist (pure) ----------

	/** The closed items of a tool (open-ended "what are the results" items are not compared). */
	function closedItems(tool) {
		tool = tools.getTool(tool);
		return tool ? tool.items.filter(i => !i.open) : [];
	}

	/**
	 * Can the user ask for the AI's answers? Only once every closed item has an answer of their own:
	 * an AI 初評 answer counts once they confirmed it (clicked it, or ticked 我已核對).
	 * { ready, missing: [ids], unconfirmed: [ids], reason }
	 */
	function readiness(record) {
		let tool = record && tools.getTool(record.tool);
		if (!tool) return { ready: false, missing: [], unconfirmed: [], reason: "先選一份評讀工具並自己評讀，才能對照 AI。" };
		let answers = tools.normalizeAnswers(record.answers);
		let missing = [];
		let unconfirmed = [];
		for (let item of closedItems(tool)) {
			let a = answers[item.id];
			if (!a || !a.answer) missing.push(item.id);
			else if (a.source === "ai" && !record.verified) unconfirmed.push(item.id);
		}
		let parts = [];
		if (missing.length) parts.push(`第 ${missing.join("、")} 題還沒答`);
		if (unconfirmed.length) parts.push(`第 ${unconfirmed.join("、")} 題是 AI 初評帶入、還沒確認（點一下你的答案就算確認）`);
		let ready = !parts.length;
		return { ready, missing, unconfirmed, reason: ready ? "" : `先自己答完每一題，才能對照 AI：${parts.join("；")}。` };
	}

	// ---------- the prompt (pure) ----------

	function checklistBlock(tool) {
		let lines = closedItems(tool).map(i => `- ${i.id}. ${i.text}｜${i.textEn}${i.hint ? `｜看什麼：${i.hint}` : ""}`);
		return [
			"<checklist>",
			`評讀工具：${tool.name}（${tool.nameZh}）`,
			"題目（題號. 中文意譯｜English cue｜看什麼）：",
			...lines,
			"</checklist>",
		].join("\n");
	}

	/**
	 * The coach prompt. paper: { title, year, text, source: "fulltext" | "abstract", truncated, trimmed, why }.
	 * Returns { system: [instructions, checklist] (the same for every paper appraised with this tool, so
	 * Claude caches them), user (the paper and the item IDs only), ids }. The user's answers are never
	 * passed in, so they can't end up in the prompt.
	 */
	function buildPrompt(tool, paper) {
		tool = tools.getTool(tool);
		if (!tool) throw new Error("沒有這份評讀工具");
		let ids = closedItems(tool).map(i => i.id);
		let notes = [];
		if (paper.source === "fulltext") {
			if (paper.trimmed) notes.push("（全文已整理成 Markdown；參考文獻、誌謝、經費與利益衝突等段落已省略）");
			if (paper.truncated) notes.push("（全文過長，以下只有前段；沒提供的部分請勿推測，相關題目答「不清楚」）");
		}
		else {
			notes.push("（這篇沒有可用的全文，以下只有摘要：摘要沒有報告的，答「不清楚」）");
		}
		let meta = [paper.title ? `標題：${paper.title}` : "", paper.year ? `年份：${paper.year}` : ""].filter(Boolean);
		let user = [
			"<paper>",
			...meta,
			...notes,
			"",
			String(paper.text || "").trim(),
			"</paper>",
			"",
			`請依系統指示，只根據 <paper> 的原文逐題作答以下 ${ids.length} 題：${ids.join(", ")}。只輸出 JSON。`,
		].join("\n");
		return { system: [INSTRUCTIONS, checklistBlock(tool)], user, ids };
	}

	/** Rough cost: { inputTokens, expected, max } (USD; null when the model is unpriced). */
	function estimateCost(prompt, model, prices) {
		let inputTokens = prompt.system.reduce((n, s) => n + reviewDraft.estimateTokens(s), 0) + reviewDraft.estimateTokens(prompt.user);
		let output = Math.min(MAX_OUTPUT_TOKENS, OUTPUT_BASE + OUTPUT_PER_ITEM * prompt.ids.length);
		let price = usage.priceFor(model, prices);
		if (!price) return { inputTokens, expected: null, max: null };
		return {
			inputTokens,
			expected: usage.costOf({ input: inputTokens, output }, price),
			max: usage.costOf({ input: inputTokens, output: MAX_OUTPUT_TOKENS }, price),
		};
	}

	// ---------- the AI's answer (pure) ----------

	/** The JSON in a model's answer: code fences, prose around it and trailing commas are tolerated. */
	function parseJSON(text) {
		let s = String(text || "").trim();
		let fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
		if (fence) s = fence[1].trim();
		try {
			return JSON.parse(s);
		}
		catch (e) {}
		let starts = [s.indexOf("{"), s.indexOf("[")].filter(i => i >= 0);
		if (!starts.length) throw new Error("AI 的回覆裡沒有 JSON");
		let start = Math.min(...starts);
		let end = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
		if (end <= start) throw new Error("AI 的回覆裡沒有完整的 JSON");
		return JSON.parse(s.slice(start, end + 1).replace(/,\s*([}\]])/g, "$1"));
	}

	function cleanText(v, max) {
		let s = typeof v === "string" ? v : (v === undefined || v === null ? "" : String(v));
		s = s.replace(/\s+/g, " ").trim();
		return s.length > max ? s.slice(0, max - 1) + "…" : s;
	}

	/** "Q4a", "4(a)", "4 a.", "第 4a 題" → "4a" */
	function normalizeID(v) {
		return String(v === undefined || v === null ? "" : v).toLowerCase()
			.replace(/^\s*(?:q(?:uestion)?|item|第)\s*/, "").replace(/\s*題\s*$/, "")
			.replace(/[\s.()（）:：、]/g, "");
	}

	function quoteList(v) {
		let list = Array.isArray(v) ? v : (v ? [v] : []);
		let out = [];
		for (let q of list) {
			let text = cleanText(q && typeof q === "object" ? (q.text || q.quote) : q, MAX_QUOTE).replace(/^["“「『]+|["”」』]+$/g, "").trim();
			if (!text) continue;
			out.push({ text, page: cleanText(q && typeof q === "object" ? q.page : "", 20) });
		}
		return out;
	}

	/**
	 * The AI's answers for the tool's closed items. Accepts { items: [...] }, a bare array, or an object
	 * keyed by item ID. Unknown IDs and answers outside the answer set are reported, never guessed.
	 * Returns { items: { id: { answer, reason, quotes: [{ text, page }] } }, missing: [ids], unknownIDs, invalid: [ids] }.
	 * Throws when there is no JSON at all.
	 */
	function parseResponse(text, tool) {
		let obj = parseJSON(text);
		let entries;
		if (Array.isArray(obj)) entries = obj;
		else if (obj && Array.isArray(obj.items)) entries = obj.items;
		else if (obj && typeof obj === "object") entries = Object.entries(obj).map(([id, v]) => Object.assign({ id }, v && typeof v === "object" ? v : { answer: v }));
		else throw new Error("AI 的回覆不是逐題的 JSON");
		let byKey = new Map(closedItems(tool).map(i => [normalizeID(i.id), i.id]));
		let items = {};
		let unknownIDs = [];
		let invalid = [];
		for (let e of entries) {
			if (!e || typeof e !== "object") continue;
			let raw = e.id !== undefined ? e.id : (e.item !== undefined ? e.item : e.question);
			let id = byKey.get(normalizeID(raw));
			if (!id) {
				if (raw !== undefined && raw !== null && String(raw).trim()) unknownIDs.push(String(raw));
				continue;
			}
			if (items[id]) continue;
			let answer = tools.normalizeAnswer(e.answer);
			if (!answer) {
				if (!invalid.includes(id)) invalid.push(id);
				continue;
			}
			items[id] = { answer, reason: cleanText(e.reason || e.rationale || "", MAX_REASON), quotes: quoteList(e.quotes || e.quote || e.evidence).slice(0, MAX_QUOTES) };
		}
		let missing = closedItems(tool).map(i => i.id).filter(id => !items[id]);
		return { items, missing, unknownIDs, invalid };
	}

	// ---------- quotes against the full text (pure) ----------

	/**
	 * Index the texts a quote may come from. sources: { texts: [string], pages: [{ key, pages: [string] }] }
	 * (texts: the full text as sent and as extracted, the abstract; pages: each PDF's text per page, to
	 * find where a verified quote is).
	 */
	function makeChecker(sources) {
		let indexes = ((sources && sources.texts) || []).filter(t => t && String(t).trim()).map(t => verify.buildIndex(String(t)));
		let pageIndexes = [];
		for (let src of (sources && sources.pages) || []) {
			(src.pages || []).forEach((text, i) => {
				if (text && String(text).trim()) pageIndexes.push({ key: src.key, page: i + 1, lazy: String(text), index: null });
			});
		}
		return {
			found: q => verify.tokenize(q).length >= MIN_QUOTE_TOKENS && indexes.some(ix => verify.quoteInIndex(q, ix)),
			page(q) {
				for (let p of pageIndexes) {
					if (!p.index) p.index = verify.buildIndex(p.lazy);
					if (verify.quoteInIndex(q, p.index)) return { page: p.page, attachmentKey: p.key };
				}
				return null;
			},
		};
	}

	/**
	 * Keep the quotes that really are in the text (with the PDF page where they are, when it can be
	 * found); an item left without one is marked lowConfidence. Returns { items, dropped, kept }.
	 */
	function verifyItems(items, sources) {
		let check = makeChecker(sources);
		let out = {};
		let dropped = 0;
		let kept = 0;
		for (let [id, a] of Object.entries(items || {})) {
			let quotes = [];
			for (let q of a.quotes || []) {
				if (!check.found(q.text)) {
					dropped++;
					continue;
				}
				let at = check.page(q.text);
				let v = { text: q.text };
				if (at) Object.assign(v, at);
				else if (q.page) v.pageGiven = q.page;
				quotes.push(v);
				kept++;
			}
			out[id] = Object.assign({}, a, { quotes, lowConfidence: !quotes.length });
		}
		return { items: out, dropped, kept };
	}

	// ---------- comparing and recording (pure) ----------

	/**
	 * The plugin's comparison: per closed item the user's answer, the AI's and whether they agree
	 * (null when the AI didn't answer). { items, compared, agreed, disagreed, missing }
	 */
	function compare(tool, answers, aiItems) {
		let a = tools.normalizeAnswers(answers);
		let items = [];
		let compared = 0;
		let agreed = 0;
		let missing = [];
		for (let item of closedItems(tool)) {
			let user = (a[item.id] && a[item.id].answer) || "";
			let ai = aiItems[item.id];
			if (!ai || !user) {
				if (!ai) missing.push(item.id);
				items.push({ id: item.id, user, ai: ai ? ai.answer : "", reason: ai ? ai.reason : "", quotes: ai ? ai.quotes : [], lowConfidence: ai ? ai.lowConfidence : false, agree: null });
				continue;
			}
			compared++;
			let agree = ai.answer === user;
			if (agree) agreed++;
			let entry = { id: item.id, user, ai: ai.answer, reason: ai.reason, quotes: ai.quotes, lowConfidence: !!ai.lowConfidence, agree };
			if (!agree) Object.assign(entry, { decision: "", why: "", decidedAt: "" });
			items.push(entry);
		}
		return { items, compared, agreed, disagreed: compared - agreed, missing };
	}

	/** One stored run: what was asked, of whom, what came back (verified) and, later, the user's decisions. */
	function buildRun({ tool, model, provider, at, source, truncated, dropped, comparison, unknownIDs, invalid }) {
		return {
			at: at || new Date().toISOString(),
			model: model || "",
			provider: provider || "",
			tool: tools.getTool(tool).id,
			source: source || "fulltext",
			truncated: !!truncated,
			dropped: dropped || 0,
			compared: comparison.compared,
			agreed: comparison.agreed,
			missing: comparison.missing,
			ignored: [...(unknownIDs || []), ...(invalid || []).map(id => `${id}（答案不在選項內）`)],
			items: comparison.items,
		};
	}

	function latestRun(record) {
		let runs = record && Array.isArray(record.coach) ? record.coach : [];
		return runs.length ? runs[runs.length - 1] : null;
	}

	function disagreements(run) {
		return ((run && run.items) || []).filter(i => i.agree === false);
	}

	/** 「12 題中 9 題一致，3 題不同（一致 75%）」 */
	function summaryText(run) {
		if (!run) return "";
		if (!run.compared) return "沒有可以比對的題目。";
		let pct = Math.round(run.agreed / run.compared * 100);
		let diff = run.compared - run.agreed;
		let text = diff ? `${run.compared} 題中 ${run.agreed} 題一致，${diff} 題不同（一致 ${pct}%）`
			: `${run.compared} 題全部一致（一致 ${pct}%）`;
		if (run.missing && run.missing.length) text += `；AI 沒有回答第 ${run.missing.join("、")} 題`;
		return text;
	}

	/** The synced line (Obsidian, Notion, the child note): 「評讀陪練：一致 9/12，修改 1 題」; "" without a run. */
	function summaryLine(record) {
		let run = latestRun(record);
		if (!run || !run.compared) return "";
		let diff = disagreements(run);
		let changed = diff.filter(i => i.decision === "changed").length;
		let pending = diff.filter(i => !i.decision).length;
		return `評讀陪練：一致 ${run.agreed}/${run.compared}，修改 ${changed} 題${pending ? `，${pending} 題尚未決定` : ""}`;
	}

	/** Add a run to a record (a copy), keeping the last MAX_RUNS. */
	function addRun(record, run) {
		let out = JSON.parse(JSON.stringify(record));
		out.coach = [...(Array.isArray(out.coach) ? out.coach : []), run].slice(-MAX_RUNS);
		return out;
	}

	/**
	 * The user's decision on a disagreement of the latest run (a copy of the record): "kept" leaves the
	 * answer as it is, "changed" takes the AI's answer (the note stays the user's). Returns the record.
	 */
	function decide(record, id, decision, why, now = new Date()) {
		if (decision !== "kept" && decision !== "changed") throw new Error(`Unknown decision: ${decision}`);
		let out = JSON.parse(JSON.stringify(record));
		let run = latestRun(out);
		let entry = run && run.items.find(i => i.id === String(id) && i.agree === false);
		if (!entry) throw new Error(`第 ${id} 題不在這次對照的差異裡`);
		entry.decision = decision;
		entry.why = cleanText(why || "", MAX_REASON);
		entry.decidedAt = now.toISOString();
		if (decision === "changed") {
			let prev = (out.answers && out.answers[entry.id]) || {};
			out.answers = out.answers || {};
			out.answers[entry.id] = { answer: entry.ai, note: prev.note || "", source: "human" };
		}
		return out;
	}

	// ---------- Zotero ----------

	function ZB() {
		return scope.ZB;
	}

	function enabled() {
		let F = alive() && ZB().features;
		return !!F && F.isEnabled(FEATURE);
	}

	function log(e) {
		try {
			Zotero.logError(e);
		}
		catch (x) {}
	}

	// False once the plugin has shut down (ZB is gone): late events and promises then do nothing
	function alive() {
		return !!(scope.ZB && scope.ZB.appraisalCoach);
	}

	/** An event listener of the form's coach parts: nothing after shutdown, errors logged (like sidepanel.js). */
	function listen(el, type, fn) {
		el.addEventListener(type, (ev) => {
			if (!alive()) return;
			try {
				fn(ev);
			}
			catch (e) {
				log(e);
			}
		});
	}

	/** Why the command can't run on this item yet ("" when it can). */
	function blockedReason(item) {
		if (!item) return "";
		try {
			return readiness(ZB().appraisalForm.stateFor(item).record).reason;
		}
		catch (e) {
			log(e);
			return "";
		}
	}

	/**
	 * The paper as the AI gets it: the full text (as the AI note gets it: Markdown with the references
	 * cut when 全文筆記 is on, within the full-text limit), else the abstract with the reason why.
	 */
	async function paperFor(item, settings, messages) {
		let z = ZB();
		let limit = Number(settings.llm.fullTextLimit) || 0;
		let data = await z.adapter.extractItemData(item, limit > 0 ? { fullTextLimit: limit } : { checkFullText: true });
		let prepared = limit > 0 ? await z.main.prepareFullText(data, settings.llm, messages) : null;
		let full = limit > 0 && !!data.fullText && String(data.fullText).trim() && data.fullTextStatus !== "none";
		let sources = (data.fullTextSources || []).filter(s => s && s.text);
		let why = "";
		if (!full) {
			if (limit <= 0) why = "設定裡「全文最多送出字元數」是 0";
			else if (data.fullTextStatus === "none") why = "PDF 是掃描版，沒有文字層";
			else why = "沒有可讀的 PDF 全文";
		}
		return {
			title: data.title || "",
			year: data.year || "",
			source: full ? "fulltext" : (String(data.abstract || "").trim() ? "abstract" : "none"),
			text: full ? data.fullText : data.abstract,
			truncated: full && !!data.fullTextTruncated,
			trimmed: full && data.fullTextFormat === "markdown" && !!data.fullTextTrimmed,
			why,
			check: {
				texts: [full ? data.fullText : "", ...sources.map(s => s.text), ...((prepared && prepared.sources) || []).map(s => s.md), data.abstract],
				pages: sources.map(s => ({ key: s.key, pages: String(s.text).split("\f") })),
			},
		};
	}

	function confirmText(settings, tool, paper, prompt) {
		let lines = [
			`評讀陪練會把這篇的${paper.source === "fulltext" ? "全文" : "摘要"}和「${tool.nameZh}」的 ${prompt.ids.length} 題送給 ${settings.llm.model}，請它只根據原文逐題作答。你的答案和評析不會送出，比對差異的是 ZotMax，不是 AI。`,
		];
		if (paper.source === "abstract") lines.push(`⚠️ 只能用摘要對照（${paper.why}）：AI 的判斷會比較粗，很多題可能只能答「不清楚」。`);
		else if (paper.trimmed) lines.push("全文已省略參考文獻、誌謝等段落。");
		try {
			let est = estimateCost(prompt, settings.llm.model, usage.parsePrices(Zotero.Prefs.get("extensions.zotero-bridge.usage.prices", true)).prices);
			lines.push(est.expected === null
				? `輸入約 ${usage.formatTokens(est.inputTokens)} tokens（這個模型沒有價格資料，無法估算費用）。`
				: `預估費用：約 ${usage.formatUSD(est.expected)}（輸入約 ${usage.formatTokens(est.inputTokens)} tokens；最多約 ${usage.formatUSD(est.max)}）。`);
		}
		catch (e) {
			log(e);
		}
		lines.push("", "會先儲存目前的評讀表。要繼續嗎？");
		return lines.join("\n");
	}

	function redraw(st) {
		if (!alive()) return;
		try {
			if (st && typeof st.coachRedraw === "function") st.coachRedraw();
		}
		catch (e) {
			log(e);
		}
	}

	function say(st, text) {
		if (st) st.coachMessage = text;
		redraw(st);
	}

	/**
	 * Run the coach for one item (after a cost confirmation). Saves the run into the form's child note
	 * and opens the form at the results. Returns the run, or null (cancelled, not ready, failed).
	 * opts.confirm(text) replaces the cost dialog (the e2e harness; Services.prompt.confirm otherwise).
	 */
	async function run(item, opts = {}) {
		let z = ZB();
		if (!enabled()) {
			z.main.notifyFeatureOff(FEATURE);
			return null;
		}
		if (!item || !item.isRegularItem || !item.isRegularItem()) {
			z.main.notify(TITLE, "請先選取文獻。");
			return null;
		}
		let AF = z.appraisalForm;
		let st = AF.stateFor(item);
		if (st.coachBusy) return null;
		let ready = readiness(st.record);
		if (!ready.ready) {
			st.expanded = true;
			say(st, ready.reason);
			z.main.notify(TITLE, ready.reason);
			return null;
		}
		let settings;
		try {
			settings = await z.main.readSettings();
		}
		catch (e) {
			z.main.notify("ZotMax 設定有誤", String(e.message || e));
			return null;
		}
		if (!settings.llm.apiKey) {
			let text = "評讀陪練要呼叫 AI 服務，但還沒有 API key：請到 設定 → ZotMax → AI 填入 Claude 或 OpenAI 的 API key。";
			say(st, text);
			z.main.notify(TITLE, text);
			return null;
		}
		let tool = tools.getTool(st.record.tool);
		let messages = [];
		let paper = await paperFor(item, settings, messages);
		if (paper.source === "none") {
			let text = `這篇沒有可讀的全文（${paper.why}），也沒有摘要，AI 無從對照。`;
			say(st, text);
			z.main.notify(TITLE, text);
			return null;
		}
		let prompt = buildPrompt(tool, paper);
		let text = confirmText(settings, tool, paper, prompt);
		let ok = typeof opts.confirm === "function" ? opts.confirm(text) : Services.prompt.confirm(Zotero.getMainWindow(), TITLE, text);
		if (!ok) return null;

		// The answers compared are the ones on screen now; saved together with the run
		let snapshot = JSON.parse(JSON.stringify(st.record));
		st.coachBusy = true;
		st.coachMessage = "";
		st.expanded = true;
		redraw(st);
		let pw = new Zotero.ProgressWindow({ closeOnClick: true });
		pw.changeHeadline(TITLE);
		pw.show();
		let line = new pw.ItemProgress("note", `AI 正在讀「${shortTitle(item)}」並逐題作答（${prompt.ids.length} 題）…`);
		try {
			let runTotals = { ledger: {} };
			let result = await z.llm.generateText(settings.llm, prompt.system, prompt.user, (u, i) => fetch(u, i),
				Object.assign({ onRetry: z.main.retryStatus(s => line.setText(s)) }, z.main.runtime.retry));
			z.main.recordAIUsage(result, runTotals);
			let parsed = parseResponse(result.text, tool);
			let checked = verifyItems(parsed.items, paper.check);
			let comparison = compare(tool, snapshot.answers, checked.items);
			let r = buildRun({
				tool, model: result.model || settings.llm.model, provider: result.provider || settings.llm.provider,
				source: paper.source, truncated: paper.truncated, dropped: checked.dropped, comparison,
				unknownIDs: parsed.unknownIDs, invalid: parsed.invalid,
			});
			let saved = await AF.saveRecord(item, addRun(st.record, r));
			st.record = saved.record;
			st.saved = true;
			st.dirty = false;
			st.message = "";
			line.setText(`評讀陪練：${summaryText(r)}`);
			line.setProgress(100);
			pw.addDescription(comparison.disagreed
				? "不同的題目列在條目窗格的「文獻評讀表」裡：看過 AI 的理由與原文後，由你決定保留或修改。"
				: "每一題都跟你一致。AI 的答案只是另一個角度；一致的題目也值得回原文再確認一次。");
			if (checked.dropped) pw.addDescription(`原文核對不到，已略過 ${checked.dropped} 句 AI 引文。`);
			let usageLine = z.main.runUsageLine(runTotals);
			if (usageLine) pw.addDescription(usageLine);
			pw.startCloseTimer(comparison.disagreed ? 15000 : 8000);
			return r;
		}
		catch (e) {
			log(e);
			line.setText(`失敗：${e.message || e}`);
			line.setError();
			pw.startCloseTimer(20000);
			st.coachMessage = `對照失敗：${e.message || e}。評讀表沒有改變。`;
			return null;
		}
		finally {
			st.coachBusy = false;
			redraw(st);
			refreshPanels();
		}
	}

	function shortTitle(item) {
		let t = String(item.getField("title") || "");
		return t.length > 40 ? t.slice(0, 39) + "…" : t;
	}

	function refreshPanels() {
		if (!alive()) return;
		try {
			let sp = ZB().sidepanel;
			if (sp && typeof sp.refreshAll === "function") sp.refreshAll();
		}
		catch (e) {
			log(e);
		}
	}

	/** Command catalog: the first selected literature item. */
	function runFromCommand(items) {
		let item = ZB().adapter.toRegularItems(items || [])[0];
		if (!item) {
			ZB().main.notify("ZotMax", "請先選取文獻。");
			return Promise.resolve(null);
		}
		return run(item);
	}

	async function record(item, st, id, decision, why) {
		if (!alive()) return;
		try {
			let saved = await ZB().appraisalForm.saveRecord(item, decide(st.record, id, decision, why));
			st.record = saved.record;
			st.saved = true;
			st.dirty = false;
			if (st.coachWhy) delete st.coachWhy[id];
			st.coachMessage = decision === "changed" ? `第 ${id} 題已改成 AI 的答案，評讀表已儲存。` : `第 ${id} 題保留你的判斷，已記錄。`;
		}
		catch (e) {
			log(e);
			st.coachMessage = `沒有存到：${e.message || e}`;
		}
		redraw(st);
	}

	// ---------- the form (DOM) ----------

	function h(doc, tag, attrs = {}, ...children) {
		let el = doc.createElementNS(HTML_NS, tag);
		for (let [k, v] of Object.entries(attrs)) {
			if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v === true ? "" : String(v));
		}
		for (let c of children) {
			if (c !== null && c !== undefined && c !== "") el.append(c);
		}
		return el;
	}

	/** 「對照 AI」: disabled (with the reason as its tooltip) until every closed item is the user's own. */
	function coachButton(doc, item, st, onRun) {
		let ready = readiness(st.record);
		let b = h(doc, "button", { type: "button", "data-zb-action": "coach", style: "padding: 0 8px;" }, st.coachBusy ? "對照中…" : "對照 AI");
		if (st.coachBusy) {
			b.disabled = true;
			b.setAttribute("aria-busy", "true");
		}
		else if (!ready.ready) {
			b.disabled = true;
			b.title = ready.reason;
		}
		else {
			b.title = "評讀陪練：請 AI 只看原文逐題作答，再列出跟你不同的題目（會先告訴你預估費用）";
		}
		listen(b, "click", () => {
			if (b.disabled) return;
			onRun();
			Promise.resolve(run(item)).catch(log);
		});
		return b;
	}

	/** The 文獻評讀表 row in the panel's 狀態: 「對照 AI」 next to 「開啟評讀表」. */
	function renderRowButton(doc, row, item, st, draw) {
		if (!enabled()) return;
		st.coachRedraw = draw;
		// The open form has its own, in its action row
		if (st.expanded) return;
		row.append(coachButton(doc, item, st, () => {
			st.expanded = true;
		}));
	}

	function quoteRow(doc, item, q) {
		let text = `「${q.text}」`;
		if (q.attachmentKey && q.page) {
			let b = h(doc, "button", { type: "button", class: "zb-sp-ann", "data-zb-coach-quote": "", title: "在 PDF 開到這一頁" },
				h(doc, "span", { class: "zb-sp-quote-text" }, text), h(doc, "span", { class: "zb-sp-page" }, `p. ${q.page}`));
			listen(b, "click", () => {
				try {
					let att = Zotero.Items.getByLibraryAndKey(item.libraryID, q.attachmentKey);
					if (att && Zotero.Reader && typeof Zotero.Reader.open === "function") {
						Promise.resolve(Zotero.Reader.open(att.id, { pageIndex: q.page - 1 })).catch(log);
					}
				}
				catch (e) {
					log(e);
				}
			});
			return h(doc, "li", {}, b);
		}
		return h(doc, "li", { "data-zb-coach-quote": "" }, h(doc, "span", { class: "zb-sp-quote-text" }, text),
			q.pageGiven ? h(doc, "span", { class: "zb-sp-page" }, `p. ${q.pageGiven}（AI 標示）`) : null);
	}

	function itemText(tool, id) {
		let it = tool.items.find(i => i.id === id);
		return it ? `${it.id}. ${it.text}` : id;
	}

	function quotes(doc, item, entry) {
		if (!entry.quotes || !entry.quotes.length) return null;
		return h(doc, "ul", { class: "zb-sp-anns" }, ...entry.quotes.map(q => quoteRow(doc, item, q)));
	}

	function disagreementBlock(doc, item, st, tool, entry) {
		let box = h(doc, "div", { "data-zb-coach-item": entry.id, style: "display: flex; flex-direction: column; gap: 4px; padding: 6px 0; border-top: 1px solid var(--fill-quinary, rgba(0, 0, 0, 0.1));" });
		box.append(h(doc, "p", { class: "zb-sp-label" }, itemText(tool, entry.id)));
		let answers = h(doc, "p", {}, "你的答案：", h(doc, "strong", { "data-zb-coach-user": "" }, entry.user), "　AI 的答案：",
			h(doc, "strong", { "data-zb-coach-ai": "" }, entry.ai));
		if (entry.lowConfidence) answers.append(" ", h(doc, "span", { class: "zb-sp-chip", "data-zb-coach-low": "" }, LOW_CONFIDENCE));
		box.append(answers);
		if (entry.reason) box.append(h(doc, "p", { class: "zb-sp-hint" }, `AI 的理由：${entry.reason}`));
		let q = quotes(doc, item, entry);
		if (q) box.append(q);
		if (entry.decision) {
			let when = String(entry.decidedAt || "").slice(0, 10);
			let what = entry.decision === "changed" ? `已改成 AI 的答案（${when}）` : `你保留了自己的判斷（${when}）`;
			box.append(h(doc, "p", { class: "zb-sp-hint", "data-zb-coach-decision": entry.decision }, what + (entry.why ? `：${entry.why}` : "")));
			return box;
		}
		st.coachWhy = st.coachWhy || {};
		let label = h(doc, "label", { style: "display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px;" }, h(doc, "span", { class: "zb-sp-hint" }, "為什麼（選填）"));
		let why = h(doc, "input", { type: "text", "data-zb-coach-why": entry.id, style: "flex: 1; min-width: 8em;" });
		why.value = st.coachWhy[entry.id] || "";
		listen(why, "input", () => {
			st.coachWhy[entry.id] = why.value;
		});
		label.append(why);
		box.append(label);
		let row = h(doc, "div", { class: "zb-sp-actions" });
		for (let [decision, text] of [["kept", "保留我的判斷"], ["changed", "改成 AI 的答案"]]) {
			let b = h(doc, "button", { type: "button", "data-zb-coach-decide": decision }, text);
			listen(b, "click", () => {
				for (let x of row.querySelectorAll("button")) x.disabled = true;
				Promise.resolve(record(item, st, entry.id, decision, why.value)).catch(log);
			});
			row.append(b);
		}
		box.append(row);
		return box;
	}

	/**
	 * Inside the open form: 「對照 AI」 in its action row, then the latest run's results (only the items
	 * where the AI answered differently; the agreements folded underneath, for transparency).
	 */
	function renderFormSection(doc, panel, actions, item, st, draw) {
		if (!enabled()) return;
		st.coachRedraw = draw;
		actions.append(coachButton(doc, item, st, () => {}));
		let section = h(doc, "section", { "data-zb-coach": "", "aria-live": "polite", style: "display: flex; flex-direction: column; gap: 4px; margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--fill-quinary, rgba(0, 0, 0, 0.1));" });
		let ready = readiness(st.record);
		let lastRun = latestRun(st.record);
		let tool = lastRun && tools.getTool(lastRun.tool);
		if (!lastRun && !st.coachBusy && !st.coachMessage) {
			section.append(h(doc, "p", { class: "zb-sp-hint", "data-zb-coach-hint": "" }, ready.ready
				? "評讀陪練：你已答完每一題。「對照 AI」會請 AI 只看原文獨立作答，再列出跟你不同的題目；要不要改由你決定。"
				: ready.reason));
			panel.append(section);
			return;
		}
		if (st.coachBusy) section.append(h(doc, "p", { class: "zb-sp-hint", role: "status" }, "AI 正在讀原文、逐題作答，通常要等半分鐘到一分鐘…"));
		if (st.coachMessage) section.append(h(doc, "p", { "data-zb-coach-message": "", role: "status" }, st.coachMessage));
		if (lastRun && tool) {
			let date = String(lastRun.at || "").slice(0, 10);
			section.append(h(doc, "p", { class: "zb-sp-label" }, `評讀陪練（${[date, lastRun.model].filter(Boolean).join(" · ")}）`));
			section.append(h(doc, "p", { "data-zb-coach-summary": "" }, summaryText(lastRun)));
			section.append(h(doc, "p", { class: "zb-sp-hint" }, "AI 只讀了原文，沒有看到你的答案；它的答案是另一個角度，不是標準答案。"));
			if (lastRun.source === "abstract") section.append(h(doc, "p", { class: "zb-sp-hint" }, "這次只用摘要對照，AI 的判斷比較粗。"));
			if (lastRun.dropped) section.append(h(doc, "p", { class: "zb-sp-hint", "data-zb-coach-dropped": "" }, `原文核對不到，已略過 ${lastRun.dropped} 句 AI 引文。`));
			if (lastRun.tool !== (tools.getTool(st.record.tool) || {}).id) section.append(h(doc, "p", { class: "zb-sp-hint" }, "這次對照用的是另一份評讀工具；換回來或重新對照才會一致。"));
			let diff = disagreements(lastRun);
			for (let entry of diff) section.append(disagreementBlock(doc, item, st, tool, entry));
			let same = lastRun.items.filter(i => i.agree === true);
			if (same.length) {
				let more = h(doc, "details", { class: "zb-sp-more", "data-zb-coach-agreed": "" }, h(doc, "summary", {}, `一致的題目（${same.length} 題）`));
				let list = h(doc, "div", { style: "display: flex; flex-direction: column; gap: 4px; margin-top: 4px;" });
				for (let entry of same) {
					let row = h(doc, "div", { "data-zb-coach-item": entry.id },
						h(doc, "p", {}, `${itemText(tool, entry.id)}：${entry.user}`, entry.lowConfidence ? " " : "",
							entry.lowConfidence ? h(doc, "span", { class: "zb-sp-chip" }, LOW_CONFIDENCE) : null));
					if (entry.reason) row.append(h(doc, "p", { class: "zb-sp-hint" }, `AI 的理由：${entry.reason}`));
					let q = quotes(doc, item, entry);
					if (q) row.append(q);
					list.append(row);
				}
				more.append(list);
				section.append(more);
			}
		}
		panel.append(section);
	}

	return {
		FEATURE, MAX_RUNS, MIN_QUOTE_TOKENS, LOW_CONFIDENCE, INSTRUCTIONS,
		// pure
		closedItems, readiness, checklistBlock, buildPrompt, estimateCost, parseJSON, normalizeID, parseResponse,
		makeChecker, verifyItems, compare, buildRun, latestRun, disagreements, summaryText, summaryLine, addRun, decide,
		// Zotero
		enabled, blockedReason, paperFor, run, runFromCommand, renderRowButton, renderFormSection,
	};
});
