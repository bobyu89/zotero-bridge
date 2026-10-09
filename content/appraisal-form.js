/*
 * Zotero Bridge — 文獻評讀表 (appraisal form): the interactive checklist in the item pane, its child
 * note, sync to Obsidian and Notion, and the collection summary (評讀總表).
 *
 * The form is prefilled from the AI note's 嚴格評讀 section (AI 初評) and saved as its own child note
 * (tag zotero-bridge-appraisal: a readable table plus a JSON block), so the AI note is never
 * overwritten. Once the user ticks 「我已核對」, the form's tool and overall verdict replace the AI
 * values in Obsidian, Notion, the screening evidence table and the EBHC report.
 *
 * The checklists and pure helpers are in appraisal-tools.js. The functions down to "Zotero" are
 * pure (Node tests); the rest needs Zotero.
 */
(function (root, factory) {
	if (typeof module === "object" && module.exports) {
		module.exports = factory(require("./appraisal-tools.js"), require("./core.js"), require("./markdown.js"), require("./synthesis.js"), globalThis);
	}
	else {
		(root.ZB = root.ZB || {}).appraisalForm = factory(root.ZB.appraisalTools, root.ZB.core, root.ZB.markdown, root.ZB.synthesis, root);
	}
})(this, function (tools, core, markdown, synthesis, scope) {
	const NOTE_TAG = "zotero-bridge-appraisal";
	const NOTE_TITLE = "📝 文獻評讀表";
	const DATA_HEADING = "📋 評讀表資料（Zotero Bridge）";
	const SECTION_HEADING = "文獻評讀表";
	const AI_HEADING = tools.AI_HEADING;
	const REVIEW_FOLDER = "Reviews";
	const USER_HEADING = "✍️ 我的筆記";
	const DEFAULT_TOOL = "casp-rct";
	const HTML_NS = "http://www.w3.org/1999/xhtml";
	const MARK_START_RE = /^%% zotero-bridge:start.*%%[ \t]*$/m;
	const MARK_END_RE = /^%% zotero-bridge:end %%[ \t]*$/m;
	const KAPPA_FORMULA = "Cohen's κ = (p_o − p_e) ÷ (1 − p_e)；p_o 為兩位評讀者答案相同的題目比例，p_e = Σ（A 選該答案的比例 × B 選該答案的比例），依「是／否／不清楚／不適用」四類計算，只計入雙方都作答的題目（不含開放式題目）。總計 κ 合併所有文獻的題目計算。解讀依 Landis & Koch（1977）：≤ 0.20 輕微、0.21–0.40 尚可、0.41–0.60 中等、0.61–0.80 高度、> 0.80 幾乎完全一致。";

	// ---------- records (pure) ----------

	function clone(record) {
		return tools.normalizeRecord(JSON.parse(JSON.stringify(record)));
	}

	function hasContent(record) {
		return !!record && (Object.values(record.answers || {}).some(a => a.answer || a.note) || !!record.overall);
	}

	/** "verified" | "human" (someone has answered) | "ai" (only the AI's prefill) */
	function statusOf(record) {
		if (record.verified) return "verified";
		return Object.values(record.answers || {}).some(a => a.source !== "ai") ? "human" : "ai";
	}

	function statusText(record) {
		let s = statusOf(record);
		if (s === "verified") return `已核對${record.verifiedAt ? `（${record.verifiedAt}）` : ""}`;
		return s === "human" ? "評讀中，尚未核對" : "AI 初評，尚未核對";
	}

	function today(date = new Date()) {
		let p = n => String(n).padStart(2, "0");
		return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
	}

	/** The tool to start with: the AI note's appraisal_tool, else the best tool for its study_design. */
	function defaultTool(aiData, parsed) {
		return (parsed && parsed.tool)
			|| tools.findToolByName(aiData && aiData.appraisal_tool)
			|| tools.toolsForDesign(aiData && aiData.study_design)[0]
			|| tools.getTool(DEFAULT_TOOL);
	}

	/**
	 * A record prefilled from the AI note (its 嚴格評讀 section and structured data). Items are only
	 * prefilled when the AI used the chosen tool; the overall verdict is always taken over.
	 */
	function prefill(aiMd, aiData, toolId) {
		let parsed = tools.parseAIAppraisal(aiMd || "");
		let tool = tools.getTool(toolId) || defaultTool(aiData, parsed);
		let same = parsed.tool && parsed.tool.id === tool.id;
		return tools.normalizeRecord({
			tool: tool.id,
			answers: tools.answersFromAI(parsed, tool),
			overall: parsed.overall || (aiData && aiData.appraisal_overall) || "",
			overallNote: same ? parsed.overallNote : "",
			aiTool: parsed.toolName || (aiData && aiData.appraisal_tool) || "",
		});
	}

	/** Fill the record's unanswered items from the AI note (same tool only). */
	function mergeAI(record, aiMd) {
		let parsed = tools.parseAIAppraisal(aiMd || "");
		let ai = tools.answersFromAI(parsed, record.tool);
		let out = clone(record);
		for (let [id, a] of Object.entries(ai)) {
			if (!out.answers[id] || !out.answers[id].answer) out.answers[id] = a;
		}
		if (!out.overall && parsed.overall) out.overall = parsed.overall;
		return out;
	}

	// ---------- the child note (pure) ----------

	function escapeHTML(s) {
		return String(s === undefined || s === null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	}

	function overallLine(record) {
		return record.overall ? `${record.overall}${record.overallNote ? ` — ${record.overallNote}` : ""}` : "（未判定）";
	}

	function dualLines(record, tool) {
		if (!record.dual) return [];
		let k = tools.kappa(tool, record.answers, record.answersB);
		let diff = tools.disagreements(tool, record.answers, record.answersB);
		return [
			`**雙人評讀**：評讀者 A${record.reviewer ? `（${record.reviewer}）` : ""}／B${record.reviewerB ? `（${record.reviewerB}）` : ""}；${tools.formatKappa(k)}`
				+ (record.overallB ? `；B 的整體評價：${record.overallB}` : ""),
			diff.length ? `不一致的題目：${diff.map(d => `${d.id}（A ${d.a}／B ${d.b}）`).join("、")}` : "",
		].filter(Boolean);
	}

	/** HTML of the child note: a readable table and the record as JSON (read back by readNoteHTML). */
	function noteHTML(record, meta = {}) {
		let tool = tools.getTool(record.tool);
		let parts = [`<h1>${NOTE_TITLE}</h1>`];
		let status = statusText(record);
		parts.push(`<p><em>${escapeHTML(status)}${meta.title ? ` · ${escapeHTML(meta.title)}` : ""}（Zotero Bridge；在條目窗格「AI 文獻筆記 → 文獻評讀表」編輯）</em></p>`);
		if (tool) {
			parts.push(`<p>評讀工具：<a href="${escapeHTML(tool.source)}">${escapeHTML(tool.name)}</a>（${escapeHTML(tool.license)}）</p>`);
			parts.push(markdown.mdToHtml(tools.toMarkdownTable(tool, record.answers)));
			parts.push(`<p>${escapeHTML(tools.describeSummary(tools.summarize(tool, record.answers)))}</p>`);
		}
		parts.push(`<p><strong>整體評價</strong>：${escapeHTML(overallLine(record))}</p>`);
		if (tool && record.dual) {
			parts.push("<h2>評讀者 B</h2>", markdown.mdToHtml(tools.toMarkdownTable(tool, record.answersB, { includeNotes: false })));
			parts.push(markdown.mdToHtml(dualLines(record, tool).join("\n\n")));
		}
		parts.push(`<h2>${DATA_HEADING}</h2>`, `<pre>${escapeHTML(tools.toJSON(record))}</pre>`);
		return parts.join("\n");
	}

	function decodeEntities(s) {
		return s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
			.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
			.replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&");
	}

	/** The record stored in a child note's JSON block (null when there is none or it is broken). */
	function readNoteHTML(html) {
		let blocks = [...String(html || "").matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/gi)].map(m => decodeEntities(m[1]));
		for (let text of blocks.reverse()) {
			try {
				let obj = JSON.parse(text);
				if (obj && obj.format === tools.FORMAT) return tools.fromJSON(obj);
			}
			catch (e) {}
		}
		return null;
	}

	// ---------- sync: Obsidian, Notion, other reports (pure) ----------

	/** The 「文獻評讀表」 section of a literature note. opts.notion: without the table (inserted as a real table block). */
	function sectionMarkdown(record, opts = {}) {
		let tool = tools.getTool(record.tool);
		if (!tool) return "";
		let verified = record.verified;
		let callout = [
			`> [!${verified ? "success" : "warning"}] ${statusText(record)}`,
			`> 評讀工具：[${tool.name}](${tool.source})｜${tools.describeSummary(tools.summarize(tool, record.answers))}`,
		];
		if (!verified) callout.push("> 請在 Zotero 條目窗格「AI 文獻筆記 → 文獻評讀表」逐題核對，勾選「我已核對」後儲存。");
		let parts = [`## ${SECTION_HEADING}`, callout.join("\n")];
		if (!opts.notion) parts.push(tools.toMarkdownTable(tool, record.answers));
		parts.push(`**整體評價**：${overallLine(record)}`);
		parts.push(...dualLines(record, tool));
		return parts.join("\n\n");
	}

	/** The form for a sync: the saved child note, else the AI note's prefill; null when neither has answers. */
	function recordFor(data, ai) {
		let saved = data && data.appraisalNote ? readNoteHTML(data.appraisalNote.html) : null;
		if (saved && tools.getTool(saved.tool)) return { record: saved, saved: true };
		if (ai && ai.md) {
			let record = prefill(ai.md, ai.data);
			if (Object.keys(record.answers).length) return { record, saved: false };
		}
		return null;
	}

	/**
	 * What a sync writes for the form (null: nothing):
	 * { record, tool, verified, saved, markdown, notionMarkdown, tableMarkdown,
	 *   values: { verified, tool, overall } } — `values` feed the frontmatter and Notion columns
	 */
	function syncInfo(data, ai) {
		let found = recordFor(data, ai);
		if (!found) return null;
		let { record } = found;
		let tool = tools.getTool(record.tool);
		return {
			record,
			tool,
			verified: record.verified,
			saved: found.saved,
			markdown: sectionMarkdown(record),
			notionMarkdown: sectionMarkdown(record, { notion: true }),
			tableMarkdown: tools.toMarkdownTable(tool, record.answers),
			values: { verified: record.verified, tool: tool.name, overall: record.overall },
		};
	}

	/** Structured data with the verified form's tool and verdict (unchanged when not verified or no data). */
	function overrideStudy(study, record) {
		if (!study || !record || !record.verified) return study;
		let tool = tools.getTool(record.tool);
		return Object.assign({}, study, {
			appraisal_tool: tool ? tool.name : study.appraisal_tool,
			appraisal_overall: record.overall || study.appraisal_overall,
		});
	}

	/** The verified form in the AI note's own 「嚴格評讀」 format (for the EBHC report prompt). */
	function appraisalSection(record) {
		let tool = tools.getTool(record.tool);
		return [
			`## ${AI_HEADING}`,
			`- 評讀工具：${tool.name}（研究者已逐題核對${record.verifiedAt ? `，${record.verifiedAt}` : ""}）`,
			"",
			tools.toMarkdownTable(tool, record.answers),
			"",
			`- 整體評價：${overallLine(record)}`,
		].join("\n");
	}

	/** Replace (or add) the 嚴格評讀 section of a Markdown note. */
	function replaceAppraisalSection(md, section) {
		let text = String(md || "");
		let m = new RegExp(`^(#{1,6})\\s*${AI_HEADING}\\s*$`, "m").exec(text);
		if (!m) return (text.trim() ? text.trim() + "\n\n" : "") + section;
		let after = text.slice(m.index + m[0].length);
		let next = new RegExp(`^#{1,${m[1].length}}\\s`, "m").exec(after);
		let end = next ? m.index + m[0].length + next.index : text.length;
		return text.slice(0, m.index) + section + (next ? "\n\n" + text.slice(end) : "");
	}

	/**
	 * EBHC report hook: a source { data, aiMarkdown, study } whose item has a verified form gets the
	 * form as its 嚴格評讀 section and the form's tool and verdict in its structured data.
	 */
	function applyToSource(src) {
		let record = src && src.data && src.data.appraisalNote ? readNoteHTML(src.data.appraisalNote.html) : null;
		if (!record || !record.verified || !tools.getTool(record.tool)) return src;
		src.aiMarkdown = replaceAppraisalSection(src.aiMarkdown, appraisalSection(record));
		src.study = overrideStudy(src.study, record);
		src.appraisalVerified = true;
		return src;
	}

	// ---------- collection summary (pure) ----------

	function cell(v) {
		return String(v === undefined || v === null ? "" : v).replace(/\r?\n+/g, " ").replace(/\|/g, "\\|").trim();
	}

	function shellQuote(s) {
		return /^[\p{L}\p{N}._\/@+-]+$/u.test(s) ? s : `"${String(s).replace(/(["\\$`])/g, "\\$1")}"`;
	}

	/** Summary file names in `dirParts` for base name `base` (e.g. "跌倒實證 評讀總表"). */
	function summaryPaths(dirParts, base) {
		let word = `${base}（Word）.md`;
		let docx = `${base}.docx`;
		return {
			dirParts,
			note: `${base}.md`,
			csv: `${base}.csv`,
			word,
			docx,
			command: `pandoc ${shellQuote(word)} -o ${shellQuote(docx)}`,
		};
	}

	/** Entries grouped by tool, in catalog order: [{ tool, entries }]. */
	function byTool(entries) {
		let groups = [];
		for (let tool of tools.TOOLS) {
			let list = entries.filter(e => e.record && e.record.tool === tool.id);
			if (list.length) groups.push({ tool, entries: list });
		}
		return groups;
	}

	function counts(entries) {
		let withForm = entries.filter(e => e.record);
		let verdicts = Object.fromEntries(tools.VERDICTS.map(v => [v, withForm.filter(e => e.record.overall === v).length]));
		return {
			total: entries.length,
			appraised: withForm.length,
			verified: withForm.filter(e => e.record.verified).length,
			unverified: withForm.filter(e => !e.record.verified).length,
			none: entries.length - withForm.length,
			verdicts,
		};
	}

	/** Cohen's κ per study with two reviewers, the pooled κ and the disagreements. */
	function agreement(entries) {
		let rows = [];
		let pooled = [];
		let disagreements = [];
		for (let e of entries) {
			if (!e.record || !e.record.dual) continue;
			let tool = tools.getTool(e.record.tool);
			let pairs = tools.answerPairs(tool, e.record.answers, e.record.answersB);
			let k = tools.cohenKappa(pairs);
			pooled.push(...pairs);
			rows.push({ entry: e, tool, kappa: k });
			for (let d of tools.disagreements(tool, e.record.answers, e.record.answersB)) disagreements.push(Object.assign({ entry: e }, d));
		}
		return { rows, overall: tools.cohenKappa(pooled), disagreements };
	}

	function kappaCells(k) {
		if (!k.n) return ["0", "0", "—", "—", "無法計算"];
		return [String(k.n), String(k.agree), `${Math.round(k.po * 100)}%`, k.kappa === null ? "—" : k.kappa.toFixed(2), tools.kappaLabel(k.kappa)];
	}

	function itemKey(tool) {
		return tool.items.map(i => `${i.id} = ${i.text}`).join("；");
	}

	/**
	 * The summary's content. entries: [{ citation, title, link, record (or null), source: "form"|"ai"|"none" }].
	 * opts.word: Word/Pandoc version (no callouts, wikilinks or emoji); meta: { name, generatedAt, uri, paths }
	 */
	function summaryBody(entries, meta, opts = {}) {
		let word = !!opts.word;
		let c = counts(entries);
		let label = e => (!word && e.link ? `[[${e.link}\\|${cell(e.citation)}]]` : cell(e.citation));
		let out = [];
		if (!word) {
			out.push([
				`> [!info] 由 Zotero Bridge 依分類「${meta.name}」的 ${c.total} 篇文獻於 ${String(meta.generatedAt || "").slice(0, 10)} 產生；重新產生只會覆寫這個區塊。`,
				meta.uri ? `> Zotero：[開啟分類](${meta.uri})` + (meta.paths ? ` · CSV：\`${meta.paths.csv}\` · Word 版：\`${meta.paths.word}\`` : "") : "",
				"> 「AI 初評」是 AI 筆記的評讀結果，尚未經研究者核對；請在 Zotero 條目窗格的文獻評讀表逐題確認後勾選「我已核對」。",
			].filter(Boolean).join("\n"));
		}
		else {
			out.push(`依 Zotero 分類「${meta.name}」的 ${c.total} 篇文獻產生（${String(meta.generatedAt || "").slice(0, 10)}）。標示「AI 初評」者尚未經研究者核對。`);
		}

		out.push("## 評讀概況", [
			"| 項目 | 篇數 |", "|---|---:|",
			`| 文獻 | ${c.total} |`,
			`| 已核對（研究者確認） | ${c.verified} |`,
			`| 尚未核對（AI 初評或評讀中） | ${c.unverified} |`,
			`| 沒有評讀資料 | ${c.none} |`,
			...tools.VERDICTS.map(v => `| 整體評價：${v} | ${c.verdicts[v]} |`),
		].join("\n"));
		let groups = byTool(entries);
		if (groups.length) out.push("評讀工具：" + groups.map(g => `${g.tool.name} ${g.entries.length} 篇`).join("；"));

		out.push("## 評讀燈號總表", tools.legend({ plain: word }));
		if (!groups.length) out.push("（還沒有任何評讀資料）");
		for (let g of groups) {
			out.push(`### ${g.tool.name}（${g.entries.length} 篇）`);
			out.push(tools.trafficLightMatrix(g.tool, g.entries.map(e => ({
				// trafficLightMatrix escapes the | itself
				label: word ? e.citation : (e.link ? `[[${e.link}|${e.citation}]]` : e.citation),
				answers: e.record.answers, overall: e.record.overall, verified: e.record.verified,
			})), { plain: word }));
			out.push(word ? `題號：${itemKey(g.tool)}` : `> [!note]- 題號對照\n> ${itemKey(g.tool)}`);
		}

		out.push("## 各篇評讀表");
		for (let e of entries.filter(x => x.record)) {
			let tool = tools.getTool(e.record.tool);
			out.push(`### ${label(e)}`);
			let status = `${statusText(e.record)}｜評讀工具：${tool.name}｜${tools.describeSummary(tools.summarize(tool, e.record.answers))}`;
			out.push(word ? status : `> [!${e.record.verified ? "success" : "warning"}] ${status}`);
			out.push(tools.toMarkdownTable(tool, e.record.answers));
			out.push(`**整體評價**：${overallLine(e.record)}`);
		}

		let ag = agreement(entries);
		if (ag.rows.length) {
			out.push("## 雙人評讀一致性（Cohen's κ）", KAPPA_FORMULA);
			let head = "| 文獻 | 評讀工具 | 雙方作答題數 | 一致題數 | 一致率 | κ | 解讀 |";
			out.push([head, "|---|---|---:|---:|---:|---:|---|",
				...ag.rows.map(r => `| ${label(r.entry)} | ${cell(r.tool.name)} | ${kappaCells(r.kappa).join(" | ")} |`),
				`| **合計** |  | ${kappaCells(ag.overall).join(" | ")} |`].join("\n"));
			out.push("### 不一致的題目");
			out.push(ag.disagreements.length
				? ag.disagreements.map(d => `- ${word ? cell(d.entry.citation) : label(d.entry)}：${d.id}. ${d.text}（A ${d.a}／B ${d.b}）`).join("\n")
				: "- 兩位評讀者的答案完全一致。");
		}

		let none = entries.filter(e => !e.record);
		if (none.length) {
			out.push("## 沒有評讀資料的文獻", none.map(e => `- ${label(e)}`).join("\n")
				+ "\n\n先產生 AI 筆記（含嚴格評讀），或在條目窗格的文獻評讀表自行評讀。");
		}
		if (!word && meta.paths) {
			out.push("## Pandoc 指令", [
				`在 \`${meta.paths.dirParts.join("/")}\` 資料夾開啟終端機執行，把 Word 版轉成 .docx：`,
				"",
				"```bash",
				meta.paths.command,
				"```",
			].join("\n"));
		}
		return out.join("\n\n");
	}

	/** CSV (UTF-8 BOM): one row per study × item. */
	function summaryCSV(entries) {
		let rows = [];
		for (let e of entries) {
			if (!e.record) {
				rows.push({ 文獻: e.citation, 標題: e.title || "", 評讀工具: "", 題號: "", 評讀項目: "", 評讀結果: "", 評析根據: "", 評讀者B: "", 整體評價: "", 核對狀態: "沒有評讀資料", 核對日期: "" });
				continue;
			}
			let r = e.record;
			let b = r.dual ? r.answersB : {};
			rows.push(...tools.csvRows(r.tool, r.answers, {
				before: { 文獻: e.citation, 標題: e.title || "" },
				after: item => ({
					評讀者B: (b[item.id] && b[item.id].answer) || "",
					整體評價: r.overall,
					核對狀態: statusText(r),
					核對日期: r.verifiedAt,
				}),
			}));
		}
		return tools.toCSV(rows);
	}

	function summaryFrontmatter(entries, meta) {
		let c = counts(entries);
		return {
			title: meta.title,
			type: "appraisal-summary",
			zotero_collection: meta.collectionKey,
			collection_path: meta.path || meta.name,
			zotero: meta.uri || "",
			studies: c.total,
			appraisal_verified: c.verified,
			appraisal_unverified: c.unverified,
			appraisal_csv: meta.paths ? [...meta.paths.dirParts, meta.paths.csv].join("/") : "",
			appraisal_word: meta.paths ? [...meta.paths.dirParts, meta.paths.word].join("/") : "",
			last_generated: meta.generatedAt || "",
		};
	}

	/**
	 * The whole summary note. With `existing`, only the plugin's frontmatter keys and the
	 * %% zotero-bridge:start/end %% block change.
	 */
	function buildSummaryNote(existing, fm, title, section) {
		let block = `${core.MARK_START}\n\n${section}\n\n${core.MARK_END}`;
		if (!existing) {
			return core.buildFrontmatter(Object.assign({}, fm, { tags: ["文獻評讀"] }), null)
				+ `\n# ${title}\n\n${block}\n\n## ${USER_HEADING}\n\n`;
		}
		let { frontmatter, body } = core.splitFrontmatter(existing);
		let f = frontmatter || "";
		for (let [key, value] of Object.entries(fm)) {
			if (value === "" || value === null || value === undefined) continue;
			f = core.setFrontmatterValue(f, key, value);
		}
		let start = MARK_START_RE.exec(body);
		let end = MARK_END_RE.exec(body);
		if (start && end && end.index > start.index) {
			body = body.slice(0, start.index) + block + body.slice(end.index + end[0].length);
		}
		else {
			let h1 = /^# .*$/m.exec(body);
			let at = h1 ? h1.index + h1[0].length : 0;
			body = body.slice(0, at) + "\n\n" + block + "\n" + body.slice(at);
		}
		return `---\n${f}\n---\n` + (body.startsWith("\n") ? body : "\n" + body);
	}

	function wordDocument(entries, meta) {
		return `# ${meta.title}\n\n${summaryBody(entries, meta, { word: true })}\n`;
	}

	// ---------- Zotero ----------

	function ZB() {
		return scope.ZB;
	}

	function getFormNote(item) {
		if (!item || !item.isRegularItem || !item.isRegularItem()) return null;
		for (let note of Zotero.Items.get(item.getNotes())) {
			if (note && note.getTags().some(t => t.tag === NOTE_TAG)) return note;
		}
		return null;
	}

	function loadRecord(item) {
		let note = getFormNote(item);
		let record = note ? readNoteHTML(note.getNote()) : null;
		return record && tools.getTool(record.tool) ? record : null;
	}

	function aiFor(item) {
		let note = ZB().adapter.getAINote(item);
		if (!note) return { md: "", data: null };
		try {
			let ai = ZB().main.readAINote(note.getNote());
			return { md: ai.md, data: ai.data };
		}
		catch (e) {
			Zotero.logError(e);
			return { md: "", data: null };
		}
	}

	/** The saved form, else the AI prefill (possibly empty). */
	function initialRecord(item) {
		let saved = loadRecord(item);
		if (saved) return { record: saved, saved: true };
		let ai = aiFor(item);
		return { record: prefill(ai.md, ai.data), saved: false };
	}

	/**
	 * Save the form as the item's child note (created on first save). Quiet: auto-sync doesn't react to
	 * it (the item and the note are marked as our own change); the next sync takes it to Notion/Obsidian.
	 */
	async function saveRecord(item, record) {
		let r = tools.normalizeRecord(Object.assign({}, record, { updatedAt: new Date().toISOString() }));
		let note = getFormNote(item);
		if (!note) {
			note = new Zotero.Item("note");
			note.libraryID = item.libraryID;
			note.parentID = item.id;
			note.addTag(NOTE_TAG);
		}
		note.setNote(noteHTML(r, { title: item.getField("title") }));
		// Saving a child note also reports a change of its parent, before saveTx() returns
		ZB().main.markSelfModified(item.id);
		if (note.id) await ZB().main.saveQuietly(note);
		else await note.saveTx();
		ZB().main.markSelfModified(note.id);
		return { note, record: r };
	}

	// ---------- item pane ----------

	// item.id → { expanded, record, saved, dirty, message }
	let paneState = new Map();

	function el(doc, tag, text, style) {
		let e = doc.createElementNS(HTML_NS, tag);
		if (text !== undefined && text !== null) e.textContent = text;
		if (style) e.setAttribute("style", style);
		return e;
	}

	function makeSelect(doc, options, current, onChange) {
		if (typeof doc.createXULElement === "function") {
			let list = doc.createXULElement("menulist");
			for (let o of options) list.appendItem(o.label, o.value);
			list.addEventListener("command", () => onChange(list.value));
			// The value is set once the list is in the document
			setTimeout(() => {
				list.value = current;
			}, 0);
			list.value = current;
			return list;
		}
		let select = el(doc, "select");
		for (let o of options) {
			let option = el(doc, "option", o.label);
			option.value = o.value;
			select.append(option);
		}
		select.value = current;
		select.addEventListener("change", () => onChange(select.value));
		return select;
	}

	function stateFor(item) {
		let st = paneState.get(item.id);
		if (!st) {
			st = { expanded: false, record: null, saved: false, dirty: false, message: "" };
			paneState.set(item.id, st);
		}
		if (!st.record) {
			let init = initialRecord(item);
			st.record = init.record;
			st.saved = init.saved;
			st.dirty = false;
		}
		return st;
	}

	function rowStatus(st) {
		if (!st.saved && !hasContent(st.record)) return "尚未評讀";
		let tool = tools.getTool(st.record.tool);
		let s = tools.summarize(tool, st.record.answers);
		return `${statusText(st.record)}${st.saved ? "" : "（未儲存）"} · ${tool ? tool.nameZh : ""} · 已答 ${s.answered}/${s.total}`
			+ (st.record.overall ? ` · ${st.record.overall}` : "");
	}

	/** 「文獻評讀表」 row in the plugin's item pane section, expanding to the whole form. */
	function renderPaneRow(doc, body, item) {
		if (!item || !item.isRegularItem || !item.isRegularItem()) return;
		// A fresh render reads the stored form again, unless there are unsaved edits
		let kept = paneState.get(item.id);
		if (kept && !kept.dirty) kept.record = null;
		let wrap = el(doc, "div", null, "margin: 2px 0 6px;");
		wrap.setAttribute("data-zb-appraisal", "");
		body.append(wrap);
		let draw = () => {
			let st = stateFor(item);
			wrap.replaceChildren();
			let row = el(doc, "div", null, "display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px;");
			row.append(el(doc, "span", `文獻評讀表：${rowStatus(st)}`));
			let toggle = el(doc, "button", st.expanded ? "收合" : "開啟評讀表", "padding: 0 6px;");
			toggle.setAttribute("data-zb-action", "toggle");
			toggle.addEventListener("click", () => {
				st.expanded = !st.expanded;
				draw();
			});
			row.append(toggle);
			wrap.append(row);
			if (st.expanded) wrap.append(renderForm(doc, item, st, draw));
		};
		draw();
	}

	const BADGE_STYLE = "font-size: 0.8em; padding: 0 4px; border-radius: 3px; margin-inline-end: 4px;";

	function renderForm(doc, item, st, redraw) {
		let r = st.record;
		let tool = tools.getTool(r.tool) || tools.getTool(DEFAULT_TOOL);
		let panel = el(doc, "div", null, "margin: 4px 0 8px; padding: 6px; border: 1px solid var(--fill-quinary, #ccc); border-radius: 4px;");
		let change = (fn) => {
			fn();
			st.dirty = true;
			st.message = "";
			redraw();
		};

		// Tool
		let toolRow = el(doc, "div", null, "display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 4px;");
		toolRow.append(el(doc, "span", "評讀工具："));
		let options = tools.TOOLS.map(t => ({ value: t.id, label: `${t.family}｜${t.nameZh}` }));
		toolRow.append(makeSelect(doc, options, tool.id, (id) => {
			if (id === tool.id) return;
			let answered = Object.values(r.answers).some(a => a.source !== "ai" && a.answer);
			if (answered && !Services.prompt.confirm(Zotero.getMainWindow(), "Zotero Bridge", "換評讀工具會清除目前逐題的答案（AI 初評會依新工具重新帶入）。要繼續嗎？")) {
				redraw();
				return;
			}
			let ai = aiFor(item);
			change(() => {
				let next = prefill(ai.md, ai.data, id);
				next.dual = r.dual;
				next.reviewer = r.reviewer;
				next.reviewerB = r.reviewerB;
				st.record = next;
			});
		}));
		panel.append(toolRow);
		let link = el(doc, "a", "官方表單", "cursor: pointer; text-decoration: underline;");
		link.setAttribute("href", tool.source);
		link.addEventListener("click", (ev) => {
			ev.preventDefault();
			try {
				Zotero.launchURL(tool.source);
			}
			catch (e) {
				Zotero.logError(e);
			}
		});
		let info = el(doc, "div", null, "font-size: 0.85em; color: var(--fill-secondary); margin-bottom: 4px;");
		info.append(el(doc, "span", `${tool.name} · `), link, el(doc, "span", ` · ${tool.license}`));
		panel.append(info);
		if (tool.verification) panel.append(el(doc, "div", `題目為中文意譯，非官方原文；${tool.verification}。`, "font-size: 0.8em; color: var(--fill-secondary); margin-bottom: 4px;"));

		// Legend and the second reviewer toggle
		let opts = el(doc, "div", null, "display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin: 4px 0;");
		let aiBadge = el(doc, "span", "AI", BADGE_STYLE + "background: #fde7c8; color: #8a4b00;");
		let okBadge = el(doc, "span", "✓", BADGE_STYLE + "background: #d6f0d6; color: #1d6b1d;");
		let legend = el(doc, "span", null, "font-size: 0.85em;");
		legend.append(aiBadge, "AI 初評（尚未確認） ", okBadge, "已確認");
		opts.append(legend);
		let dualLabel = el(doc, "label", null, "font-size: 0.9em;");
		let dualBox = el(doc, "input");
		dualBox.setAttribute("type", "checkbox");
		dualBox.setAttribute("data-zb-action", "dual");
		dualBox.checked = r.dual;
		dualBox.addEventListener("change", () => change(() => {
			r.dual = dualBox.checked;
		}));
		dualLabel.append(dualBox, " 雙人評讀（評讀者 B）");
		opts.append(dualLabel);
		panel.append(opts);

		// Items
		let section = null;
		for (let item0 of tool.items) {
			if (item0.section && item0.section !== section) {
				section = item0.section;
				panel.append(el(doc, "div", section, "font-weight: 600; margin: 8px 0 2px;"));
			}
			let box = el(doc, "div", null, "margin: 4px 0; padding-bottom: 4px; border-bottom: 1px dotted var(--fill-quinary, #ddd);");
			box.setAttribute("data-zb-item", item0.id);
			let head = el(doc, "div");
			let a = r.answers[item0.id] || { answer: "", note: "" };
			if (a.answer && a.source === "ai" && !r.verified) head.append(el(doc, "span", "AI", BADGE_STYLE + "background: #fde7c8; color: #8a4b00;"));
			else if (a.answer) head.append(el(doc, "span", "✓", BADGE_STYLE + "background: #d6f0d6; color: #1d6b1d;"));
			let label = el(doc, "span", `${item0.id}. ${item0.text}`);
			label.title = `${item0.textEn}${item0.hint ? ` — ${item0.hint}` : ""}`;
			head.append(label);
			if (item0.open) head.append(el(doc, "span", "（開放式題目：在評析根據寫下結果）", "font-size: 0.85em; color: var(--fill-secondary);"));
			box.append(head);
			if (item0.hint) box.append(el(doc, "div", `看什麼：${item0.hint}`, "font-size: 0.8em; color: var(--fill-secondary); margin: 1px 0 2px;"));
			let buttons = (reviewer) => {
				let answers = reviewer === "B" ? r.answersB : r.answers;
				let current = (answers[item0.id] || {}).answer || "";
				let line = el(doc, "div", null, "display: flex; flex-wrap: wrap; align-items: center; gap: 3px;");
				if (r.dual) line.append(el(doc, "span", reviewer === "B" ? "B：" : "A：", "font-size: 0.85em; min-width: 1.5em;"));
				for (let word of tools.ANSWERS) {
					let b = el(doc, "button", word, "padding: 0 6px;" + (current === word ? " font-weight: 700; outline: 2px solid var(--accent-blue, #2e6fdb);" : ""));
					b.setAttribute("data-zb-answer", word);
					b.setAttribute("data-zb-reviewer", reviewer);
					b.setAttribute("aria-pressed", current === word ? "true" : "false");
					b.addEventListener("click", () => change(() => {
						let prev = answers[item0.id] || { answer: "", note: "" };
						// Clicking the chosen answer again clears it
						let answer = prev.answer === word && prev.source !== "ai" ? "" : word;
						answers[item0.id] = { answer, note: prev.note || "", source: "human" };
					}));
					line.append(b);
				}
				return line;
			};
			box.append(buttons("A"));
			let note = el(doc, "input", null, "width: 100%; box-sizing: border-box; margin-top: 2px;");
			note.setAttribute("type", "text");
			note.setAttribute("placeholder", "評析根據（引用文中的方法或數字）");
			note.setAttribute("data-zb-note", item0.id);
			note.value = a.note || "";
			note.addEventListener("input", () => {
				let prev = r.answers[item0.id] || { answer: "", note: "" };
				r.answers[item0.id] = { answer: prev.answer || "", note: note.value, source: "human" };
				st.dirty = true;
			});
			box.append(note);
			if (r.dual) box.append(buttons("B"));
			panel.append(box);
		}

		// Overall verdict
		let overall = el(doc, "div", null, "display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 8px 0 4px;");
		overall.append(el(doc, "span", "整體評價：", "font-weight: 600;"));
		let verdicts = [{ value: "", label: "（未判定）" }, ...tool.verdicts.map(v => ({ value: v, label: v }))];
		overall.append(makeSelect(doc, verdicts, r.overall, v => change(() => {
			r.overall = v;
		})));
		let overallNote = el(doc, "input", null, "flex: 1; min-width: 8em;");
		overallNote.setAttribute("type", "text");
		overallNote.setAttribute("placeholder", "理由");
		overallNote.setAttribute("data-zb-note", "overall");
		overallNote.value = r.overallNote || "";
		overallNote.addEventListener("input", () => {
			r.overallNote = overallNote.value;
			st.dirty = true;
		});
		overall.append(overallNote);
		panel.append(overall);
		if (r.dual) {
			let ob = el(doc, "div", null, "display: flex; align-items: center; gap: 6px; margin: 2px 0 4px;");
			ob.append(el(doc, "span", "評讀者 B 整體評價："));
			ob.append(makeSelect(doc, verdicts, r.overallB, v => change(() => {
				r.overallB = v;
			})));
			panel.append(ob);
		}

		// Summary
		let s = tools.summarize(tool, r.answers);
		let summary = el(doc, "div", tools.describeSummary(s), "font-size: 0.9em; margin: 4px 0;");
		summary.setAttribute("data-zb-summary", "");
		panel.append(summary);
		if (r.dual) panel.append(el(doc, "div", `評讀者一致性：${tools.formatKappa(tools.kappa(tool, r.answers, r.answersB))}`, "font-size: 0.9em; margin: 2px 0;"));

		// Verified
		let vLabel = el(doc, "label", null, "display: block; margin: 6px 0;");
		let vBox = el(doc, "input");
		vBox.setAttribute("type", "checkbox");
		vBox.setAttribute("data-zb-action", "verified");
		vBox.checked = r.verified;
		vBox.addEventListener("change", () => change(() => {
			r.verified = vBox.checked;
			r.verifiedAt = vBox.checked ? today() : "";
		}));
		vLabel.append(vBox, ` 我已核對（逐題確認 AI 初評與評析根據）${r.verified && r.verifiedAt ? `：${r.verifiedAt}` : ""}`);
		panel.append(vLabel);
		if (!r.verified && s.missing.length && Object.keys(r.answers).length) {
			panel.append(el(doc, "div", `尚未作答：第 ${s.missing.join("、")} 題`, "font-size: 0.85em; color: var(--fill-secondary);"));
		}

		// Actions
		let actions = el(doc, "div", null, "display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px;");
		let action = (label, name, fn) => {
			let b = el(doc, "button", label, "padding: 0 8px;");
			b.setAttribute("data-zb-action", name);
			b.addEventListener("click", () => {
				Promise.resolve().then(fn).catch((e) => {
					Zotero.logError(e);
					st.message = `❌ ${e.message || e}`;
					redraw();
				});
			});
			actions.append(b);
		};
		let save = async () => {
			let { record } = await saveRecord(item, st.record);
			st.record = record;
			st.saved = true;
			st.dirty = false;
			st.message = "✅ 已儲存為子筆記「📝 文獻評讀表」；下次同步會更新 Notion 與 Obsidian。";
			redraw();
		};
		action("儲存評讀表", "save", save);
		action("儲存並同步", "save-sync", async () => {
			await save();
			await ZB().main.run([item], { targets: ["notion", "obsidian"], ai: "reuse" });
			st.message = "✅ 已儲存並同步。";
			redraw();
		});
		action("帶入 AI 初評（只填空白題）", "merge-ai", () => {
			change(() => {
				st.record = mergeAI(st.record, aiFor(item).md);
			});
		});
		if (st.dirty) {
			action("放棄修改", "discard", () => {
				st.record = null;
				st.message = "";
				redraw();
			});
		}
		panel.append(actions);
		if (st.message || st.dirty) {
			let msg = el(doc, "div", st.message || "有尚未儲存的修改。", "font-size: 0.9em; margin-top: 4px;");
			msg.setAttribute("data-zb-message", "");
			panel.append(msg);
		}
		return panel;
	}

	// ---------- sync helpers (Zotero) ----------

	/** Notion: put the form's table (a real table block) under the 「文獻評讀表」 heading in the managed container. */
	async function insertNotionTable(client, containerId, info, messages) {
		if (!info || !containerId) return;
		let blocks = markdown.mdToNotionBlocks(info.tableMarkdown, { tables: true }).filter(b => b.type === "table");
		if (!blocks.length) return;
		let text = b => ((b[b.type] && b[b.type].rich_text) || []).map(r => r.plain_text || (r.text && r.text.content) || "").join("");
		try {
			let children = await client.listChildren(containerId);
			let k = children.findIndex(b => /^heading_/.test(b.type) && text(b).trim() === SECTION_HEADING);
			let after = k >= 0 ? children[Math.min(k + 1, children.length - 1)] : null;
			try {
				await client.appendChildren(containerId, blocks, after ? { after: after.id } : undefined);
			}
			catch (e) {
				if (!after) throw e;
				await client.appendChildren(containerId, blocks);
			}
		}
		catch (e) {
			if (messages) messages.push(`⚠️ Notion 文獻評讀表：${e.message || e}`);
			else throw e;
		}
	}

	/** Screening evidence table hook: the item's verified form overrides the AI note's appraisal. */
	function overrideStudyForItem(item, study) {
		try {
			return overrideStudy(study, loadRecord(item));
		}
		catch (e) {
			Zotero.logError(e);
			return study;
		}
	}

	// ---------- collection summary (Zotero) ----------

	function collectionKey(collection) {
		return `${collection.libraryID}/${collection.key}`;
	}

	async function summaryTarget(settings, collection) {
		let dirParts = [...core.splitFolder(settings.defaults.obsidianFolder), REVIEW_FOLDER];
		let dir = PathUtils.join(settings.vaultPath, ...dirParts);
		let key = collectionKey(collection);
		let base = core.sanitizeFilename(collection.name);
		let target = null;
		for (let name of [`${base} 評讀總表`, `${base} (${collection.key}) 評讀總表`]) {
			let path = PathUtils.join(dir, name + ".md");
			let existing = (await IOUtils.exists(path)) ? await IOUtils.readUTF8(path) : null;
			let owner = existing === null ? "" : core.frontmatterScalar(core.splitFrontmatter(existing).frontmatter || "", "zotero_collection");
			target = { dir, path, existing, paths: summaryPaths(dirParts, name), name };
			if (existing === null || owner === key) break;
		}
		return target;
	}

	function summaryItems(collection) {
		let z = ZB();
		let items = z.adapter.itemsInCollection(collection, true);
		// A screened review: only the studies included at full text
		try {
			let cfg = z.screening.config();
			let states = items.map(i => z.screening.readState(i.getTags().map(t => t.tag), cfg));
			if (states.some(s => s.ft === "include")) return items.filter((_, k) => states[k].ft === "include");
		}
		catch (e) {
			Zotero.logError(e);
		}
		return items;
	}

	function entryFor(item, index) {
		let z = ZB();
		let data = {
			creators: item.getCreatorsJSON(),
			title: item.getField("title"),
			year: item.getField("year"),
			language: item.getField("language"),
		};
		let saved = loadRecord(item);
		let record = saved;
		if (!record) {
			let ai = aiFor(item);
			let pre = ai.md ? prefill(ai.md, ai.data) : null;
			record = pre && hasContent(pre) && Object.keys(pre.answers).length ? pre : null;
		}
		let link = "";
		if (index) {
			let lib = z.adapter.libraryInfo(item.libraryID);
			let entries = index.get(`${lib.path}/${item.key}`) || [];
			if (entries.length) link = entries[0].relParts.join("/").replace(/\.md$/i, "");
		}
		return { item, citation: synthesis.shortCitation(data), title: data.title, link, record, source: saved ? "form" : record ? "ai" : "none" };
	}

	function exportSummary(collection) {
		return ZB().main.enqueue(() => exportSummaryNow(collection));
	}

	async function exportSummaryNow(collection) {
		let z = ZB();
		let headline = "Zotero Bridge：文獻評讀總表";
		let settings;
		try {
			settings = await z.main.readSettings();
		}
		catch (e) {
			z.main.notify("Zotero Bridge 設定有誤", String(e.message || e));
			return null;
		}
		if (!settings.vaultPath) {
			z.main.notify(headline, "請先到 設定 → Zotero Bridge 填入 Obsidian vault 路徑。");
			return null;
		}
		let items = summaryItems(collection);
		if (!items.length) {
			z.main.notify(headline, `「${collection.name}」裡沒有文獻。`);
			return null;
		}
		let pw = new Zotero.ProgressWindow({ closeOnClick: true });
		pw.changeHeadline(headline);
		pw.show();
		let line = new pw.ItemProgress("note", `讀取「${collection.name}」的 ${items.length} 篇文獻…`);
		try {
			let index = await z.main.buildObsidianIndex(settings);
			let entries = items.map(i => entryFor(i, index))
				.sort((a, b) => a.citation.localeCompare(b.citation, "en") || String(a.title).localeCompare(String(b.title)));
			let target = await summaryTarget(settings, collection);
			let lib = z.adapter.libraryInfo(collection.libraryID);
			let meta = {
				name: collection.name,
				path: z.adapter.collectionPath(collection),
				collectionKey: collectionKey(collection),
				uri: `zotero://select/${lib.path}/collections/${collection.key}`,
				generatedAt: new Date().toISOString(),
				title: `${collection.name}：文獻評讀總表`,
				paths: target.paths,
			};
			await IOUtils.makeDirectory(target.dir, { createAncestors: true, ignoreExisting: true });
			let text = buildSummaryNote(target.existing, summaryFrontmatter(entries, meta), meta.title, summaryBody(entries, meta));
			if (text !== target.existing) await IOUtils.writeUTF8(target.path, text);
			await IOUtils.writeUTF8(PathUtils.join(target.dir, target.paths.csv), summaryCSV(entries));
			await IOUtils.writeUTF8(PathUtils.join(target.dir, target.paths.word), wordDocument(entries, meta));
			let c = counts(entries);
			line.setText(`${collection.name}：${c.total} 篇（已核對 ${c.verified}、尚未核對 ${c.unverified}、沒有評讀 ${c.none}）`);
			line.setProgress(100);
			pw.addDescription(`已寫入 Obsidian：${[...target.paths.dirParts, target.paths.note].join("/")}、CSV、Word 版 Markdown`);
			if (c.unverified) pw.addDescription(`⚠️ ${c.unverified} 篇仍是 AI 初評或評讀中，尚未核對。`);
			pw.startCloseTimer(10000);
			return { entries, counts: c, target };
		}
		catch (e) {
			Zotero.logError(e);
			line.setText(`失敗：${e.message || e}`);
			line.setError();
			pw.startCloseTimer(20000);
			return null;
		}
	}

	// ---------- 評讀總表 for collections (commands.js) ----------

	/** The summary of each collection; with none, says which to select. */
	async function exportCollections(collections) {
		if (!collections.length) {
			ZB().main.notify("Zotero Bridge", "請先在左側選取分類。");
			return;
		}
		for (let c of collections) await exportSummary(c);
	}

	return {
		NOTE_TAG, NOTE_TITLE, DATA_HEADING, SECTION_HEADING, KAPPA_FORMULA, REVIEW_FOLDER,
		// pure
		hasContent, statusOf, statusText, prefill, mergeAI, noteHTML, readNoteHTML, sectionMarkdown, recordFor, syncInfo,
		overrideStudy, appraisalSection, replaceAppraisalSection, applyToSource,
		summaryPaths, counts, agreement, summaryBody, summaryCSV, summaryFrontmatter, buildSummaryNote, wordDocument,
		// Zotero
		getFormNote, loadRecord, initialRecord, saveRecord, renderPaneRow, insertNotionTable, overrideStudyForItem,
		exportSummary, exportCollections,
		_paneState: paneState,
	};
});
