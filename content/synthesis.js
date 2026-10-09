/*
 * ZotMax — cross-paper synthesis: a comparison table, themes and research gaps
 * built from several items' AI notes. Sources are referred to as [S1], [S2]… in the
 * prompt and turned into Obsidian links / APA-style citations afterwards, so the model
 * never has to (and cannot) invent references.
 */
(function (root, factory) {
	if (typeof module === "object" && module.exports) {
		module.exports = factory(require("./apa-zh.js"));
	}
	else {
		(root.ZB = root.ZB || {}).synthesis = factory(root.ZB.apaZh);
	}
})(this, function (apaZh) {
	const MAX_CHARS_PER_SOURCE = 8000;

	const DEFAULT_SYNTHESIS_PROMPT = `你是護理與醫學領域的研究助理，負責把多篇文獻整理成「文獻比較與綜合分析」，供研究生撰寫碩士論文的文獻探討。

寫作規則：
- 使用繁體中文；醫學、統計與研究方法術語保留英文。
- 每篇文獻以代號 [S1]、[S2]… 引用，代號必須來自提供的清單；不要寫作者姓名或年份，也不要自行列出參考文獻（系統會自動轉換成引文並附上 APA 7 參考文獻）。
- 只根據提供的內容撰寫；沒有的資訊寫「未報告」，不要推測或編造數據。
- 比較表每一列一篇文獻，第一欄填代號（例如 [S1]）；表格儲存格內不要換行。

輸出格式（標題必須完全一致）：
## 綜合摘要
（3–5 句，說明這批文獻整體在回答什麼問題、主要發現與一致性）

## 文獻比較表
| 文獻 | 研究設計 | 樣本與場域 | 介入／暴露 | 測量工具 | 主要結果 | 證據等級 |
|---|---|---|---|---|---|---|

## 主題整理
（3–6 個主題，每個主題用 ### 小標，說明各文獻的共識與分歧，並以 [S#] 標註出處）

## 方法學品質與限制

## 研究缺口
（條列尚未被回答的問題、族群、場域或方法上的不足）

## 對我的研究的建議
`;

	/** APA-style in-text author/year: "Chen, 2024", "Chen & Smith, 2024", "Chen et al., 2024". */
	function shortCitation(data) {
		// Chinese-language items: 陳美玲，2024 / 陳美玲、林小華，2024 / 陳美玲等，2024 (apa-zh.js)
		if (apaZh && apaZh.options().enabled && apaZh.isChineseItem(data)) return apaZh.shortCitation(data);
		let creators = (data.creators || []).filter(c => c.creatorType === "author");
		if (!creators.length) creators = data.creators || [];
		let names = creators.map(c => c.lastName || c.name || "").filter(Boolean);
		let who;
		if (!names.length) who = (data.title || "Untitled").split(/\s+/).slice(0, 4).join(" ");
		else if (names.length === 1) who = names[0];
		else if (names.length === 2) who = `${names[0]} & ${names[1]}`;
		else who = `${names[0]} et al.`;
		return `${who}, ${data.year || "n.d."}`;
	}

	/**
	 * @param {object[]} sources - [{ data, aiMarkdown, annotationsText }] in display order
	 * @returns {{ system, user, entries }} entries: [{ id: "S1", citation, data, truncated }]
	 */
	function buildSynthesisPrompt(sources, opts = {}) {
		let entries = [];
		let blocks = [];
		sources.forEach((src, i) => {
			let id = `S${i + 1}`;
			let d = src.data;
			let body = src.aiMarkdown
				? `<ai_note>\n${src.aiMarkdown}\n</ai_note>`
				: [
					d.abstract ? `<abstract>\n${d.abstract}\n</abstract>` : "",
					src.annotationsText ? `<user_annotations>\n${src.annotationsText}\n</user_annotations>` : "",
				].filter(Boolean).join("\n") || "（沒有摘要或筆記，只有書目資料）";
			let truncated = body.length > MAX_CHARS_PER_SOURCE;
			if (truncated) body = body.slice(0, MAX_CHARS_PER_SOURCE) + "\n（內容過長，已截斷）";
			// citekey: the key export.js writes to references.json (Pandoc [@citekey], review-draft.js)
			entries.push({ id, citation: shortCitation(d), citekey: d.citationKey || d.generatedCitekey || "", data: d, truncated });
			blocks.push([
				`<source id="${id}">`,
				`標題：${d.title || ""}`,
				`年份：${d.year || ""}`,
				`期刊／出處：${d.publication || ""}`,
				// Optional extra lines (review-draft.js: the AI note's structured data)
				src.extra || "",
				body,
				"</source>",
			].filter(Boolean).join("\n"));
		});
		let user = [
			`以下是 ${entries.length} 篇文獻（代號 ${entries.map(e => e.id).join("、")}）。`,
			...blocks,
			opts.focus ? `分析重點：${opts.focus}` : "",
			...(opts.blocks || []),
			opts.closing || "請依照系統指示的格式輸出文獻比較與綜合分析。",
		].filter(Boolean).join("\n\n");
		return {
			system: (opts.systemPrompt && opts.systemPrompt.trim()) || DEFAULT_SYNTHESIS_PROMPT,
			user,
			entries,
		};
	}

	// One source label with an optional page locator: "S1", "S1, p. 5", "S2，pp. 3–4"
	const LABEL_SRC = "S\\d+(?:\\s*[,，]\\s*pp?\\.\\s*[\\p{L}\\p{N}]+(?:[-–][\\p{L}\\p{N}]+)?)?";
	const GROUP_SRC = `\\[(${LABEL_SRC}(?:\\s*[,，、;；]\\s*${LABEL_SRC})*)\\]`;
	// A run of label groups: [S1] / [S1, S3] / [S1][S2] / [S1] [S2] count as one citation
	const CITATION_RE = new RegExp(`${GROUP_SRC}(?:[ \\t]?${GROUP_SRC})*`, "giu");
	const GROUP_RE = new RegExp(GROUP_SRC, "giu");

	/** The labels of one citation run: [{ id: "S1", locator: "p. 5" }] (ids upper-case). */
	function parseCitation(text) {
		let out = [];
		for (let [, inner] of String(text).matchAll(GROUP_RE)) {
			for (let m of inner.matchAll(/S(\d+)(?:\s*[,，]\s*(pp?)\.\s*([\p{L}\p{N}]+(?:[-–][\p{L}\p{N}]+)?))?/giu)) {
				out.push({ id: `S${m[1]}`, locator: m[2] ? `${m[2].toLowerCase()}. ${m[3]}` : "" });
			}
		}
		return out;
	}

	/**
	 * Replace [S1] / [S1, S3] / [S1][S2] / [S1, p. 5] markers.
	 * mode "obsidian": [[note|Chen, 2024]] links (pipe escaped inside table rows)
	 * mode "plain": (Chen, 2024; Lee, 2023)
	 * mode "pandoc": [@chen2024; @lee2023] with the entries' citekeys (review-draft.js)
	 * opts.flagUnknown: a label not in `entries` (or, for Pandoc, without a citekey) becomes a visible
	 *   【⚠️ …】 marker instead of being left as is or dropped; opts.unknown collects those ids.
	 */
	function resolveCitations(md, entries, mode, linkTargets = {}, opts = {}) {
		let byId = new Map(entries.map(e => [e.id.toUpperCase(), e]));
		return String(md || "").split("\n").map((line) => {
			let inTable = /^\s*\|.*\|\s*$/.test(line);
			return line.replace(CITATION_RE, (all) => {
				let labels = parseCitation(all);
				let found = [];
				let missing = [];
				for (let l of labels) {
					let e = byId.get(l.id);
					if (e && (mode !== "pandoc" || e.citekey)) found.push({ e, locator: l.locator });
					else missing.push(e ? `${l.id}（${e.citation} 沒有 citekey）` : l.id);
				}
				if (opts.unknown) opts.unknown.push(...missing);
				let flag = opts.flagUnknown && missing.length ? `【⚠️ 未知來源 ${missing.join("、")}】` : "";
				if (!found.length) return flag || all;
				let withLocator = (text, locator) => (locator ? `${text}, ${locator}` : text);
				let out;
				if (mode === "pandoc") {
					out = `[${found.map(f => withLocator("@" + f.e.citekey, f.locator)).join("; ")}]`;
				}
				else if (mode === "obsidian") {
					let sep = inTable ? "\\|" : "|";
					out = found.map(({ e, locator }) => {
						let target = linkTargets[e.id];
						return target ? `[[${target}${sep}${withLocator(e.citation, locator)}]]` : `(${withLocator(e.citation, locator)})`;
					}).join("; ");
				}
				else {
					out = `(${found.map(f => withLocator(f.e.citation, f.locator)).join("; ")})`;
				}
				return out + flag;
			});
		}).join("\n");
	}

	/**
	 * APA reference list from Zotero's citeproc output (Chinese APA for Chinese items), sorted
	 * alphabetically as APA requires; Chinese references first (by stroke count) when 「中文文獻排在英文前」.
	 */
	function referenceList(entries) {
		let refs = entries.map(e => e.data.apaMarkdown || e.data.apa || `${e.citation}. ${e.data.title || ""}`.trim());
		refs = apaZh ? apaZh.sortReferences(refs, entries.map(e => e.data)) : refs.sort((a, b) => a.localeCompare(b, "en"));
		return "## 參考文獻\n\n" + refs.map(r => `- ${r}`).join("\n");
	}

	function yamlScalar(v) {
		return JSON.stringify(String(v));
	}

	/**
	 * Obsidian note for a synthesis.
	 * meta: { title, scope, model, generatedAt, notionUrl, linkTargets }
	 */
	function buildSynthesisNote(md, entries, meta) {
		let fm = [
			"---",
			`title: ${yamlScalar(meta.title)}`,
			"type: \"literature-synthesis\"",
			`scope: ${yamlScalar(meta.scope || "")}`,
			"sources:",
			...entries.map(e => `  - ${yamlScalar(`${e.data.libraryPath}/${e.data.key}`)}`),
			`ai_model: ${yamlScalar(meta.model || "")}`,
			`ai_generated: ${yamlScalar(meta.generatedAt || "")}`,
			meta.notionUrl ? `notion: ${yamlScalar(meta.notionUrl)}` : null,
			"tags:",
			"  - \"文獻比較\"",
			"---",
		].filter(l => l !== null).join("\n");
		let truncated = entries.filter(e => e.truncated).map(e => e.citation);
		let parts = [
			fm,
			`# ${meta.title}`,
			`> [!info] 由 ${meta.model || "AI"} 依 ${entries.length} 篇文獻產生；文獻代號已轉換為引文與筆記連結。` +
				(truncated.length ? `\n> 以下文獻內容過長、只使用了前段：${truncated.join("; ")}` : ""),
			resolveCitations(md, entries, "obsidian", meta.linkTargets || {}).trim(),
			referenceList(entries),
			"## ✍️ 我的筆記\n",
		];
		return parts.join("\n\n");
	}

	/** Markdown for Notion / Zotero (plain citations, no wikilinks). */
	function buildSynthesisPlain(md, entries) {
		return resolveCitations(md, entries, "plain").trim() + "\n\n" + referenceList(entries);
	}

	return {
		DEFAULT_SYNTHESIS_PROMPT, MAX_CHARS_PER_SOURCE,
		shortCitation, buildSynthesisPrompt, resolveCitations, parseCitation, CITATION_RE, referenceList,
		buildSynthesisNote, buildSynthesisPlain,
	};
});
