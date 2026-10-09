/*
 * ZotMax — core helpers (pure functions, no Zotero globals).
 * Loaded into the plugin scope by bootstrap.js and required directly by the Node tests.
 */
(function (root, factory) {
	if (typeof module === "object" && module.exports) {
		module.exports = factory(require("./apa-zh.js"));
	}
	else {
		(root.ZB = root.ZB || {}).core = factory(root.ZB.apaZh);
	}
})(this, function (apaZh) {
	const MARK_START = "%% zotero-bridge:start — 此區塊由 ZotMax 自動產生，重新同步時會覆寫 %%";
	const MARK_END = "%% zotero-bridge:end %%";
	const MARK_START_RE = /^%% zotero-bridge:start.*%%[ \t]*$/m;
	const MARK_END_RE = /^%% zotero-bridge:end %%[ \t]*$/m;

	// Structured data from the AI note's JSON block (same names as the JSON fields), for Bases filters
	const STUDY_KEYS = [
		"study_design", "sample_size", "evidence_level", "jbi_level", "appraisal_tool", "appraisal_overall",
		"setting", "population", "intervention", "comparison", "outcomes", "measures", "country",
	];

	// Frontmatter keys owned by the plugin; every other key is the user's and survives re-sync.
	// STUDY_KEYS are only rewritten when the sync has structured data (see buildFrontmatter).
	const MANAGED_KEYS = [
		"title", "authors", "year", "publication", "item_type", "doi", "url", "citekey",
		"zotero", "zotero_key", "library", "collections", "tags", "notion",
		...STUDY_KEYS,
		// 文獻評讀表 (appraisal-form.js): has the user verified the appraisal?
		"appraisal_verified",
		"ai_model", "ai_generated", "fulltext_truncated", "date_added", "last_synced",
		// Full-text status of the PDF (scanned.js): ok / partial / none / no_pdf
		"full_text",
		// Link to the plugin-managed full-text note (fulltext.js): "[[<folder>/全文/<name>]]"
		"fulltext",
		// Set only while the item is deleted in Zotero (markObsidianNoteDeleted); a re-sync drops them
		"zotero_deleted", "status_before_delete",
	];

	// `highlight` is the Obsidian 1.14 highlight color emoji (==🟡text==); "" = theme default.
	// Obsidian has six highlight colors, so magenta maps to purple and gray to the default.
	const COLORS = {
		"#ffd400": { name: "yellow", emoji: "🟡", highlight: "🟡", notion: "yellow_background" },
		"#ff6666": { name: "red", emoji: "🔴", highlight: "🔴", notion: "red_background" },
		"#5fb236": { name: "green", emoji: "🟢", highlight: "🟢", notion: "green_background" },
		"#2ea8e5": { name: "blue", emoji: "🔵", highlight: "🔵", notion: "blue_background" },
		"#a28ae5": { name: "purple", emoji: "🟣", highlight: "🟣", notion: "purple_background" },
		"#e56eee": { name: "magenta", emoji: "🩷", highlight: "🟣", notion: "pink_background" },
		"#f19837": { name: "orange", emoji: "🟠", highlight: "🟠", notion: "orange_background" },
		"#aaaaaa": { name: "gray", emoji: "⚪", highlight: "", notion: "gray_background" },
	};

	// Reading-status values for the Bases kanban view; only set when a note is first created
	const STATUSES = ["待讀", "閱讀中", "已讀", "已引用"];
	// Status given to the note of an item that was trashed or deleted in Zotero
	const DELETED_STATUS = "已刪除";
	const DELETED_CALLOUT = "> [!warning] 已從 Zotero 刪除";

	function colorInfo(hex) {
		return COLORS[String(hex || "").toLowerCase()] || { name: "other", emoji: "⚫", highlight: "", notion: "default" };
	}

	function sanitizeFilename(name) {
		let s = String(name || "")
			// Characters invalid on Windows/macOS or meaningful to Obsidian links
			.replace(/[\\/:*?"<>|#^[\]]/g, " ")
			.replace(/[\u0000-\u001f\u007f]/g, "")
			.replace(/\s+/g, " ")
			.trim();
		if (s.length > 120) {
			s = s.slice(0, 120).trim();
		}
		s = s.replace(/[. ]+$/, "");
		return s || "Untitled";
	}

	function creatorName(c) {
		// Chinese names in full: 陳美玲, not "陳, 美玲" (apa-zh.js)
		let zh = apaZh && apaZh.zhPersonName(c);
		if (zh) return zh;
		if (c.name) return c.name;
		return [c.lastName, c.firstName].filter(Boolean).join(", ");
	}

	function authorCreators(data) {
		let creators = data.creators || [];
		let authors = creators.filter(c => c.creatorType === "author");
		return authors.length ? authors : creators;
	}

	function authorNames(data) {
		return authorCreators(data).map(creatorName).filter(Boolean);
	}

	function firstAuthorLastName(data) {
		let c = authorCreators(data)[0];
		if (!c) return "";
		return c.lastName || c.name || "";
	}

	function noteBasename(data, format) {
		let title = data.shortTitle || data.title || "Untitled";
		let authorYearTitle = () => {
			let author = firstAuthorLastName(data);
			let head = [author, data.year].filter(Boolean).join(" ");
			return head ? `${head} - ${title}` : title;
		};
		switch (format) {
			case "title":
				return sanitizeFilename(data.title || title);
			case "authorYearTitle":
				return sanitizeFilename(authorYearTitle());
			case "citekey":
			default:
				return sanitizeFilename(data.citationKey || authorYearTitle());
		}
	}

	// "folder/sub" → ["folder", "sub"], ignoring empty and dot segments
	function splitFolder(folder) {
		return String(folder || "")
			.split(/[\\/]+/)
			.map(s => s.trim())
			.filter(s => s && s !== "." && s !== "..")
			.map(sanitizeFilename);
	}

	function zoteroSelectURI(data) {
		return `zotero://select/${data.libraryPath}/items/${data.key}`;
	}

	function annotationURI(data, attachment, annotation) {
		if (attachment.contentType === "application/pdf") {
			let params = [];
			if (/^\d+$/.test(annotation.pageLabel || "")) {
				params.push(`page=${annotation.pageLabel}`);
			}
			params.push(`annotation=${annotation.key}`);
			return `zotero://open-pdf/${data.libraryPath}/items/${attachment.key}?${params.join("&")}`;
		}
		return `zotero://select/${data.libraryPath}/items/${attachment.key}`;
	}

	function obsidianURI(vaultName, relPath) {
		let file = relPath.replace(/\.md$/i, "");
		return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(file)}`;
	}

	function tagToObsidian(tag) {
		// Obsidian tags cannot contain spaces or most punctuation
		let t = String(tag || "")
			.replace(/^#+/, "")
			.replace(/\s+/g, "-")
			.replace(/[^\p{L}\p{N}_\-/]/gu, "");
		// A tag made only of digits is not a valid Obsidian tag
		return /^[0-9/]*$/.test(t) ? "" : t;
	}

	// ---------- YAML frontmatter ----------

	function yamlScalar(v) {
		if (typeof v === "number" && Number.isFinite(v)) return String(v);
		if (typeof v === "boolean") return v ? "true" : "false";
		// JSON string syntax is valid YAML double-quoted syntax
		return JSON.stringify(String(v));
	}

	function yamlBlock(key, value) {
		if (Array.isArray(value)) {
			if (!value.length) return `${key}: []`;
			return `${key}:\n` + value.map(v => `  - ${yamlScalar(v)}`).join("\n");
		}
		return `${key}: ${yamlScalar(value)}`;
	}

	function splitFrontmatter(text) {
		let m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
		if (!m) return { frontmatter: null, body: text };
		return { frontmatter: m[1], body: text.slice(m[0].length) };
	}

	// Split frontmatter text into top-level key blocks: [{ key, text }]
	function parseFrontmatterBlocks(fm) {
		let blocks = [];
		let current = null;
		for (let line of fm.split(/\r?\n/)) {
			let m = /^([^\s#:][^:]*):(?:\s|$)/.exec(line);
			if (m && !/^\s/.test(line)) {
				current = { key: m[1].trim(), lines: [line] };
				blocks.push(current);
			}
			else if (current) {
				current.lines.push(line);
			}
			else {
				blocks.push({ key: null, lines: [line] });
			}
		}
		return blocks.map(b => ({ key: b.key, text: b.lines.join("\n") }));
	}

	// Unquoted value of a top-level scalar key ("" when missing or not a scalar)
	function frontmatterScalar(fm, key) {
		let block = parseFrontmatterBlocks(fm || "").find(b => b.key === key);
		if (!block) return "";
		let first = block.text.split(/\r?\n/)[0];
		let raw = first.slice(first.indexOf(":") + 1).trim();
		if (/^"/.test(raw)) {
			try {
				return String(JSON.parse(raw));
			}
			catch (e) {}
		}
		return raw.replace(/^'(.*)'$/, "$1");
	}

	// Replace a top-level key (or append it), keeping every other line as it is
	function setFrontmatterValue(fm, key, value) {
		let blocks = parseFrontmatterBlocks(fm || "").filter(b => b.key || b.text.trim());
		let line = yamlBlock(key, value);
		let i = blocks.findIndex(b => b.key === key);
		if (i >= 0) blocks[i] = { key, text: line };
		else blocks.push({ key, text: line });
		return blocks.map(b => b.text).join("\n");
	}

	const ZOTERO_KEY_RE = /^zotero_key:[ \t]*"?([^"\r\n]+?)"?[ \t]*\r?$/m;

	/**
	 * The `zotero_key` of a note, from its whole text or only its first bytes.
	 * Returns the key, null when the note has none, or undefined when `text` is a
	 * truncated head (`complete` false) that ends inside the frontmatter.
	 */
	function zoteroKeyFromHead(text, complete = true) {
		text = String(text || "").replace(/^\ufeff/, "");
		if (!/^---\r?\n/.test(text)) return null;
		let { frontmatter } = splitFrontmatter(text);
		if (frontmatter !== null) {
			let m = ZOTERO_KEY_RE.exec(frontmatter);
			return m ? m[1] : null;
		}
		if (complete) return null;
		// Only trust lines that end before the cut
		let m = ZOTERO_KEY_RE.exec(text.slice(0, text.lastIndexOf("\n") + 1));
		return m ? m[1] : undefined;
	}

	function buildFrontmatter(managed, existingFrontmatter) {
		let lines = [];
		for (let [key, value] of Object.entries(managed)) {
			if (value === undefined || value === null || value === "") continue;
			lines.push(yamlBlock(key, value));
		}
		if (existingFrontmatter) {
			for (let block of parseFrontmatterBlocks(existingFrontmatter)) {
				// Managed keys are replaced; structured fields only when this sync provides them
				// (even as empty), so they survive a sync whose AI note has no data block
				if (block.key && MANAGED_KEYS.includes(block.key)
					&& (!STUDY_KEYS.includes(block.key) || Object.prototype.hasOwnProperty.call(managed, block.key))) continue;
				if (!block.key && !block.text.trim()) continue;
				lines.push(block.text);
			}
		}
		return `---\n${lines.join("\n")}\n---\n`;
	}

	/** Frontmatter values for the structured data; {} when there is none (existing values are kept). */
	function studyFrontmatter(study) {
		if (!study) return {};
		let out = {};
		for (let key of STUDY_KEYS) {
			let v = study[key];
			if (key === "measures") out[key] = Array.isArray(v) ? v.filter(Boolean) : [];
			else if (key === "sample_size") out[key] = Number.isFinite(v) ? v : "";
			else out[key] = v === null || v === undefined ? "" : String(v);
		}
		return out;
	}

	/**
	 * 文獻評讀表 values (appraisal-form.js): appraisal_verified, and once verified the form's tool and
	 * verdict in place of the AI note's. {} when the sync has no form (existing values are kept).
	 */
	function appraisalFrontmatter(appraisal) {
		if (!appraisal) return {};
		let out = { appraisal_verified: !!appraisal.verified };
		if (appraisal.verified) {
			out.appraisal_tool = appraisal.tool || "";
			out.appraisal_overall = appraisal.overall || "";
		}
		return out;
	}

	function managedFrontmatter(data, opts = {}) {
		return Object.assign({
			title: data.title || "",
			authors: authorNames(data),
			year: /^\d{4}$/.test(data.year || "") ? Number(data.year) : (data.year || ""),
			publication: data.publication || "",
			item_type: data.itemType || "",
			doi: data.doi || "",
			url: data.url || "",
			citekey: data.citationKey || data.generatedCitekey || "",
			zotero: zoteroSelectURI(data),
			zotero_key: `${data.libraryPath}/${data.key}`,
			library: data.libraryName || "",
			collections: data.collections || [],
			tags: (data.tags || []).map(tagToObsidian).filter(Boolean),
			notion: opts.notionUrl || "",
		}, studyFrontmatter(opts.study), appraisalFrontmatter(opts.appraisal), {
			ai_model: opts.aiModel || "",
			ai_generated: opts.aiGeneratedAt || "",
			fulltext_truncated: opts.fullTextTruncated ? true : "",
			full_text: data.fullTextStatus || "",
			fulltext: opts.fullTextLink ? `[[${opts.fullTextLink}]]` : "",
			date_added: data.dateAdded || "",
			last_synced: opts.now || "",
		});
	}

	// ---------- Markdown body ----------

	// Nest a document's headings under a section heading: "# A" → "### A" for by=2
	function demoteHeadings(md, by) {
		let inFence = false;
		return String(md).split("\n").map((line) => {
			if (/^```/.test(line)) inFence = !inFence;
			if (inFence) return line;
			return line.replace(/^(#{1,6})(\s)/, (all, hashes, sp) => "#".repeat(Math.min(hashes.length + by, 6)) + sp);
		}).join("\n");
	}

	// ---------- colour meanings ----------

	// What each Zotero highlight colour means, in display order (settings: annotations.colorMeanings)
	const DEFAULT_COLOR_MEANINGS = [
		{ color: "#ffd400", meaning: "重要發現" },
		{ color: "#ff6666", meaning: "限制／疑問" },
		{ color: "#5fb236", meaning: "研究方法" },
		{ color: "#2ea8e5", meaning: "可引用句" },
		{ color: "#a28ae5", meaning: "定義／概念" },
		{ color: "#f19837", meaning: "待查證" },
		{ color: "#e56eee", meaning: "我的想法" },
		{ color: "#aaaaaa", meaning: "其他" },
	];
	// Annotations in a colour outside Zotero's eight
	const OTHER_COLOR_MEANING = "其他顏色";

	/**
	 * The colour → meaning list in the user's order: every one of Zotero's eight colours exactly once
	 * (missing ones appended in the default order, empty meanings filled with the default).
	 * @param {string|object[]} input the pref (JSON array of { color, meaning }) or the parsed array
	 * @returns {{ color, meaning, info }[]}
	 */
	function colorMeanings(input) {
		let list = input;
		if (typeof input === "string") {
			try {
				list = input.trim() ? JSON.parse(input) : [];
			}
			catch (e) {
				list = [];
			}
		}
		let defaults = new Map(DEFAULT_COLOR_MEANINGS.map(d => [d.color, d.meaning]));
		let out = [];
		let seen = new Set();
		for (let entry of Array.isArray(list) ? list : []) {
			let color = String((entry && entry.color) || "").toLowerCase();
			if (!defaults.has(color) || seen.has(color)) continue;
			seen.add(color);
			let meaning = String(entry.meaning || "").replace(/\s+/g, " ").trim().slice(0, 40) || defaults.get(color);
			out.push({ color, meaning, info: colorInfo(color) });
		}
		for (let d of DEFAULT_COLOR_MEANINGS) {
			if (!seen.has(d.color)) out.push({ color: d.color, meaning: d.meaning, info: colorInfo(d.color) });
		}
		return out;
	}

	/** Annotations grouped by colour meaning, in the meanings' order: [{ color, meaning, info, items: [{ att, ann }] }]. */
	function annotationGroups(data, meanings) {
		meanings = Array.isArray(meanings) && meanings.length && meanings[0].info ? meanings : colorMeanings(meanings);
		let groups = meanings.map(m => Object.assign({ items: [] }, m));
		let byColor = new Map(groups.map(g => [g.color, g]));
		let other = { color: "", meaning: OTHER_COLOR_MEANING, info: colorInfo(""), items: [] };
		for (let att of data.attachments || []) {
			for (let ann of att.annotations || []) {
				(byColor.get(String(ann.color || "").toLowerCase()) || other).items.push({ att, ann });
			}
		}
		return [...groups, other].filter(g => g.items.length);
	}

	function oneLine(text) {
		return String(text || "").replace(/\s+/g, " ").trim();
	}

	function shorten(text, max) {
		let s = oneLine(text);
		if (s.length <= max) return s;
		let cut = s.slice(0, max - 1);
		if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
		return cut.replace(/\s+\S*$/, (m) => (m.length < 15 ? "" : m)) + "…";
	}

	function highlightMark(color, text) {
		return `==${color.highlight}${oneLine(text).replace(/==/g, "=\\=")}==`;
	}

	function pageLink(data, att, ann) {
		return `[${ann.pageLabel ? `p. ${ann.pageLabel}` : "連結"}](${annotationURI(data, att, ann)})`;
	}

	/** One annotation as a compact list item (plus its comment, tags and image below it). */
	function annotationMarkdown(data, att, ann) {
		let color = colorInfo(ann.color);
		let link = pageLink(data, att, ann);
		let head;
		if (ann.type === "highlight") {
			head = String(ann.text || "").trim() ? highlightMark(color, ann.text) : `${color.emoji} *[劃線]*`;
		}
		else if (ann.type === "underline") {
			head = `${color.emoji} <u>${oneLine(ann.text)}</u>`;
		}
		else if (ann.type === "image" || ann.type === "ink") {
			head = `${color.emoji} *[${ann.type === "image" ? "圖片" : "手繪"}註記]*`;
		}
		else {
			head = `${color.emoji} *[便利貼]*`;
		}
		let out = [`- ${head} · ${link}`];
		// The rendered PNG (annotation-images.js), under the caption and before the comment
		if ((ann.type === "image" || ann.type === "ink") && ann.image && ann.image.embed) out.push(`  ![[${ann.image.embed}]]`);
		if (ann.comment) {
			for (let [i, line] of String(ann.comment).split(/\r?\n/).filter(l => l.trim()).entries()) {
				out.push(`  ${i ? "" : "💬 "}${line.trim()}`);
			}
		}
		let tags = (ann.tags || []).map(t => "#" + tagToObsidian(t)).filter(t => t.length > 1);
		if (tags.length) out.push(`  ${tags.join(" ")}`);
		return out.join("\n");
	}

	/** One meaning group's items (Markdown without the group title). */
	function annotationGroupMarkdown(data, group) {
		return group.items.map(({ att, ann }) => annotationMarkdown(data, att, ann)).join("\n");
	}

	/** Every annotation, grouped by meaning: "### 🟡 重要發現（2）" + items (for tools that want plain Markdown). */
	function annotationsMarkdown(data, meanings) {
		return annotationGroups(data, meanings)
			.map(g => `### ${groupTitle(g)}\n\n${annotationGroupMarkdown(data, g)}`).join("\n\n");
	}

	function groupTitle(g) {
		return `${g.info.emoji} ${g.meaning}（${g.items.length}）`;
	}

	/** Up to `max` of the user's highlights for the 「重點」 block: one per meaning first, in the meanings' order. */
	function topHighlights(groups, max = 3) {
		let pools = groups.map(g => g.items.filter(({ ann }) => (ann.type === "highlight" || ann.type === "underline") && oneLine(ann.text)));
		let out = [];
		for (let round = 0; out.length < max && pools.some(p => p.length > round); round++) {
			pools.forEach((pool, i) => {
				if (out.length < max && pool[round]) out.push(Object.assign({ group: groups[i] }, pool[round]));
			});
		}
		return out;
	}

	// ---------- the AI note's parts ----------

	const SUMMARY_HEADING_RE = /^#{1,6}[ \t]*一句話摘要[ \t]*$/m;
	const FINDINGS_HEADING_RE = /^#{1,6}[ \t]*主要結果[ \t]*$/m;

	/** The body of the first heading matching `re`, up to the next heading ("" when missing). */
	function aiSection(md, re) {
		let m = re.exec(md || "");
		if (!m) return "";
		let rest = md.slice(m.index + m[0].length);
		let next = /^#{1,6}\s/m.exec(rest);
		return (next ? rest.slice(0, next.index) : rest).trim();
	}

	/** The AI note's one-sentence take-away ("" without one). */
	function oneSentence(md) {
		return oneLine(aiSection(md, SUMMARY_HEADING_RE).split(/\n\s*\n/)[0]);
	}

	/** 2–3 key findings from 「主要結果」: its top-level bullets, else its first sentences. */
	function keyFindings(md, max = 3) {
		let section = aiSection(md, FINDINGS_HEADING_RE);
		if (!section) return [];
		let bullets = section.split("\n").map(l => /^[-*+][ \t]+(.+)$/.exec(l) || /^\d+[.)][ \t]+(.+)$/.exec(l)).filter(Boolean).map(m => oneLine(m[1]));
		if (bullets.length) return bullets.filter(Boolean).slice(0, max);
		let sentences = oneLine(section).split(/(?<=[。！？])|(?<=[.!?])\s+(?=[A-Z一-鿿])/u).map(oneLine).filter(Boolean);
		return sentences.slice(0, 2);
	}

	/** The AI note without its one-sentence summary (shown in 「重點」), headings one level down. */
	function aiNoteBody(md) {
		let text = String(md || "").trim();
		let m = SUMMARY_HEADING_RE.exec(text);
		if (m && oneSentence(text)) {
			let rest = text.slice(m.index + m[0].length);
			let next = /^#{1,6}\s/m.exec(rest);
			text = (text.slice(0, m.index) + (next ? rest.slice(next.index) : "")).trim();
		}
		return demoteHeadings(text, 1);
	}

	/** "RCT · N = 120 · CEBM 2 · JBI 1.c · 評讀：納入（已核對）" ("" when nothing is known). */
	function factsLine(study, appraisal) {
		let s = study || {};
		let facts = [
			s.study_design,
			Number.isFinite(s.sample_size) ? `N = ${s.sample_size}` : "",
			s.evidence_level ? `CEBM ${s.evidence_level}` : "",
			s.jbi_level ? `JBI ${s.jbi_level}` : "",
		];
		if (appraisal && appraisal.overall) {
			facts.push(`評讀：${appraisal.overall}（${appraisal.verified ? "已核對" : "待核對"}）`);
		}
		else if (s.appraisal_overall) {
			facts.push(`評讀：${s.appraisal_overall}（AI 初評）`);
		}
		return facts.filter(Boolean).join(" · ");
	}

	// ---------- the literature note: 「重點」 + folded sections ----------

	function infoMarkdown(data) {
		let rows = [];
		let authors = authorNames(data);
		if (authors.length) rows.push(`**Authors**: ${authors.join("; ")}`);
		if (data.year) rows.push(`**Year**: ${data.year}`);
		if (data.publication) rows.push(`**Publication**: ${data.publication}`);
		if (data.doi) rows.push(`**DOI**: [${data.doi}](https://doi.org/${encodeURI(data.doi)})`);
		if (data.apa) rows.push(`**APA 7**: ${data.apaMarkdown || data.apa}`);
		return rows.join("  \n");
	}

	/** Lines of a callout (`> …`) without its header line. */
	function unwrapCallout(text) {
		return String(text || "").split("\n").filter(l => !/^>\s*\[!/.test(l))
			.map(l => l.replace(/^>[ \t]?/, "")).join("\n").trim();
	}

	/**
	 * The literature note as a short 「重點」 block and folded sections in a fixed order (DESIGN.md
	 * "Literature note"): the user's own highlights by meaning, their Zotero notes and the appraisal
	 * first, then the AI parts, then reference material.
	 * @param {object} data item data from the Zotero adapter
	 * @param {object} opts { aiMarkdown, aiModel, aiGeneratedAt, study, appraisal ({ verified, tool, overall }),
	 *   appraisalMarkdown, notesMarkdown: [{ title, md }], searchCallout, notionUrl, colorMeanings,
	 *   fullTextLink (vault path of the full-text note, without .md), aiHighlights: [{ quote, why }],
	 *   target: "obsidian" | "notion", fullTextNote (Notion: a full-text child page exists) }
	 * @returns {{ keyPoints, sections: [{ id, type, title, md, color }] }} Markdown without callout markup
	 */
	function buildNoteSections(data, opts = {}) {
		let notion = opts.target === "notion";
		let groups = annotationGroups(data, opts.colorMeanings);
		let ai = opts.aiMarkdown ? String(opts.aiMarkdown).trim() : "";

		// 「重點」: what you need in a ten-second glance
		let kp = [];
		let sentence = oneSentence(ai);
		if (sentence) kp.push(`**一句話**：${sentence}`);
		let facts = factsLine(opts.study, opts.appraisal);
		if (facts) kp.push(facts);
		let findings = keyFindings(ai);
		if (findings.length) kp.push("**主要發現**\n" + findings.map(f => `- ${f}`).join("\n"));
		let top = topHighlights(groups);
		if (top.length) {
			kp.push("**我的劃線**\n" + top.map(({ att, ann, group }) => {
				let text = shorten(ann.text, 140);
				let mark = ann.type === "underline" ? `${group.info.emoji} <u>${text}</u>` : highlightMark(colorInfo(ann.color), text);
				return `- ${mark} ${group.meaning} · ${pageLink(data, att, ann)}`;
			}).join("\n"));
		}
		if (!kp.length) kp.push("還沒有 AI 筆記或劃線。在 Zotero 劃線（顏色代表的意義在設定裡）或產生 AI 筆記後重新同步，重點會整理在這裡。");
		let links = [];
		if (!notion) {
			if (opts.fullTextLink) links.push(`[[${opts.fullTextLink}|全文與劃線]]`);
			links.push(`[Zotero](${zoteroSelectURI(data)})`);
			if (opts.notionUrl) links.push(`[Notion](${opts.notionUrl})`);
		}
		else if (opts.fullTextNote) {
			links.push("全文與劃線：本頁下方的子頁面");
		}
		if (data.doi) links.push(`[DOI](https://doi.org/${encodeURI(data.doi)})`);
		kp.push(links.join(" · "));

		let sections = [];
		for (let g of groups) {
			sections.push({ id: `annotations:${g.color || "other"}`, type: "quote", title: groupTitle(g), md: annotationGroupMarkdown(data, g), color: g.info.notion });
		}
		let notes = (opts.notesMarkdown || []).filter(n => n.md && n.md.trim());
		if (notes.length) {
			sections.push({ id: "notes", type: "note", title: `我的 Zotero 筆記（${notes.length}）`, md: notes.map(n => demoteHeadings(n.md.trim(), 2)).join("\n\n---\n\n") });
		}
		if (opts.appraisalMarkdown) {
			let md = String(opts.appraisalMarkdown).trim();
			// Obsidian: the callout title names it; Notion keeps the heading (the table goes in after it)
			if (!notion) md = md.replace(/^#{1,6}[ \t]*文獻評讀表[ \t]*\n+/, "");
			sections.push({ id: "appraisal", type: "example", title: "文獻評讀表", md });
		}
		let aiHighlights = (opts.aiHighlights || []).filter(h => h && oneLine(h.quote));
		if (aiHighlights.length) {
			sections.push({
				id: "aiHighlights", type: "tip", title: "AI 標的重點（僅供參考）",
				md: "AI 從原文挑出、已核對確實在全文裡的句子；跟你自己的劃線分開，判斷還是你來做。"
					+ (opts.fullTextLink ? "在全文裡以 🤖 加底線標出。" : "") + "\n\n"
					+ aiHighlights.map(h => `- 🤖 "${oneLine(h.quote)}"${oneLine(h.why) ? ` — ${oneLine(h.why)}` : ""}`).join("\n"),
			});
		}
		if (ai) {
			let meta = [opts.aiModel, opts.aiGeneratedAt && String(opts.aiGeneratedAt).slice(0, 10)].filter(Boolean).join(" · ");
			sections.push({ id: "ai", type: "note", title: `AI 文獻筆記${meta ? `（${meta}）` : ""}`, md: aiNoteBody(ai) });
		}
		if (data.abstract && String(data.abstract).trim()) {
			sections.push({ id: "abstract", type: "info", title: "摘要（Abstract）", md: String(data.abstract).trim() });
		}
		if (opts.searchCallout) {
			let md = unwrapCallout(opts.searchCallout);
			sections.push({ id: "search", type: "search", title: "🔎 延伸搜尋", md: notion ? md.replace(/ {2}\n/g, "\n\n") : md });
		}
		sections.push({ id: "info", type: "info", title: "書目資訊", md: infoMarkdown(data) });
		return { keyPoints: kp.join("\n\n"), sections: sections.filter(s => s.md && s.md.trim()) };
	}

	/** An Obsidian callout; `folded` adds "-" so it opens closed. */
	function callout(type, title, md, folded) {
		let body = String(md || "").trim().split("\n").map(l => (l.trim() ? `> ${l}` : ">")).join("\n");
		return `> [!${type}]${folded ? "-" : ""} ${title}` + (body ? "\n" + body : "");
	}

	/**
	 * The managed block of an Obsidian literature note: 「重點」 open at the top, everything long folded below.
	 * @param {object} data item data from the Zotero adapter
	 * @param {object} opts see buildNoteSections
	 */
	function buildManagedSection(data, opts = {}) {
		let { keyPoints, sections } = buildNoteSections(data, Object.assign({}, opts, { target: "obsidian" }));
		let parts = [MARK_START, callout("abstract", "重點", keyPoints, false)];
		for (let s of sections) parts.push(callout(s.type, s.title, s.md, true));
		parts.push(MARK_END);
		return parts.join("\n\n");
	}

	const USER_SECTION = "## ✍️ 我的筆記\n\n";

	/**
	 * Build the full Obsidian note. When `existing` is given, user-owned content
	 * (frontmatter keys outside MANAGED_KEYS and everything outside the markers) is kept.
	 */
	function buildObsidianNote(existing, data, opts = {}) {
		let fmObj = managedFrontmatter(data, opts);
		let managed = buildManagedSection(data, opts);
		if (!existing) {
			// `status` is the user's to change (e.g. by dragging in the kanban), so it is only set here
			return buildFrontmatter(Object.assign({}, fmObj, { status: STATUSES[0] }), null)
				+ `\n# ${data.title || "Untitled"}\n\n`
				+ managed + "\n\n" + USER_SECTION;
		}
		let { frontmatter, body } = splitFrontmatter(existing);
		if (frontmatter && parseFrontmatterBlocks(frontmatter).some(b => b.key === "zotero_deleted")
				&& frontmatterScalar(frontmatter, "status") === DELETED_STATUS) {
			// The item came back from the Zotero trash: give the note its reading status back
			frontmatter = setFrontmatterValue(frontmatter, "status",
				frontmatterScalar(frontmatter, "status_before_delete") || STATUSES[0]);
		}
		let fm = buildFrontmatter(fmObj, frontmatter);
		let start = MARK_START_RE.exec(body);
		let end = MARK_END_RE.exec(body);
		if (start && end && end.index > start.index) {
			body = body.slice(0, start.index) + managed + body.slice(end.index + end[0].length);
		}
		else {
			// Markers were removed by the user: put a fresh managed block after the first heading
			let h1 = /^# .*$/m.exec(body);
			let at = h1 ? h1.index + h1[0].length : 0;
			body = body.slice(0, at) + "\n\n" + managed + "\n" + body.slice(at);
		}
		return fm + (body.startsWith("\n") ? body : "\n" + body);
	}

	/**
	 * Mark the note of an item that was trashed or deleted in Zotero: `status: "已刪除"` and a
	 * callout at the top of the managed block. Nothing else changes; marking twice is a no-op.
	 */
	function markObsidianNoteDeleted(text, opts = {}) {
		let { frontmatter, body } = splitFrontmatter(text);
		if (frontmatter === null) return text;
		let fm = frontmatter;
		if (!parseFrontmatterBlocks(fm).some(b => b.key === "zotero_deleted")) {
			let before = frontmatterScalar(fm, "status");
			if (before && before !== DELETED_STATUS) fm = setFrontmatterValue(fm, "status_before_delete", before);
			fm = setFrontmatterValue(fm, "zotero_deleted", opts.now || new Date().toISOString());
		}
		if (frontmatterScalar(fm, "status") !== DELETED_STATUS) fm = setFrontmatterValue(fm, "status", DELETED_STATUS);
		let start = MARK_START_RE.exec(body);
		let end = MARK_END_RE.exec(body);
		// Without the markers the user owns the whole body, so only the frontmatter changes
		if (start && end && end.index > start.index && !body.slice(start.index, end.index).includes(DELETED_CALLOUT)) {
			let date = String(opts.now || new Date().toISOString()).slice(0, 10);
			let callout = `${DELETED_CALLOUT}\n> 這篇文獻已於 ${date} 在 Zotero 移到垃圾桶或刪除，ZotMax 不會再更新這份筆記；從垃圾桶還原後重新同步即可恢復。`;
			let at = start.index + start[0].length;
			body = body.slice(0, at) + "\n\n" + callout + body.slice(at);
		}
		return `---\n${fm}\n---\n` + body;
	}

	// ---------- Obsidian Bases (1.14+) ----------

	/** A .base file listing every synced note, with a table and a reading-status kanban. */
	function buildBaseFile() {
		return [
			"filters:",
			"  and:",
			"    - file.hasProperty(\"zotero_key\")",
			"properties:",
			"  note.title:",
			"    displayName: 標題",
			"  note.authors:",
			"    displayName: 作者",
			"  note.year:",
			"    displayName: 年份",
			"  note.publication:",
			"    displayName: 期刊",
			"  note.status:",
			"    displayName: 閱讀狀態",
			"  note.collections:",
			"    displayName: 分類",
			"  note.study_design:",
			"    displayName: 研究設計",
			"  note.sample_size:",
			"    displayName: 樣本數",
			"  note.evidence_level:",
			"    displayName: 證據等級",
			"views:",
			"  - type: table",
			"    name: 文獻總表",
			"    order:",
			"      - file.name",
			"      - note.title",
			"      - note.authors",
			"      - note.year",
			"      - note.publication",
			"      - note.study_design",
			"      - note.sample_size",
			"      - note.evidence_level",
			"      - note.status",
			"      - note.collections",
			"  - type: kanban",
			"    name: 閱讀進度",
			"    groupBy:",
			"      property: note.status",
			"      direction: ASC",
			"    groupOrder:",
			...STATUSES.map(st => `      - ${st}`),
			"    order:",
			"      - note.title",
			"      - note.year",
			"      - note.authors",
			"",
		].join("\n");
	}

	// ---------- Routing ----------

	/**
	 * Pick the first rule that matches the item's library and collections.
	 * rule = { name, library: "*" | "user" | "<groupID>", collection: "" | "A/B", notionDatabase, obsidianFolder }
	 * Returns { notionDatabase, obsidianFolder, ruleName }.
	 */
	function resolveRoute(data, rules, defaults) {
		for (let rule of rules || []) {
			if (rule.enabled === false) continue;
			let lib = String(rule.library || "*");
			if (lib !== "*" && lib !== data.libraryRouteID) continue;
			let col = String(rule.collection || "").replace(/^\/+|\/+$/g, "").trim();
			if (col) {
				let hit = (data.collections || []).some(p => p === col || p.startsWith(col + "/"));
				if (!hit) continue;
			}
			return {
				ruleName: rule.name || "",
				notionDatabase: rule.notionDatabase || defaults.notionDatabase || "",
				obsidianFolder: rule.obsidianFolder || defaults.obsidianFolder || "",
			};
		}
		return {
			ruleName: "",
			notionDatabase: defaults.notionDatabase || "",
			obsidianFolder: defaults.obsidianFolder || "",
		};
	}

	function parseRules(json) {
		if (!json || !String(json).trim()) return [];
		let rules = JSON.parse(json);
		if (!Array.isArray(rules)) throw new Error("Rules must be a JSON array");
		return rules;
	}

	// Truncate long text without splitting a surrogate pair; reports whether it was cut
	function truncate(text, max) {
		text = String(text || "");
		if (!max || text.length <= max) return { text, truncated: false };
		let cut = text.slice(0, max);
		if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
		return { text: cut, truncated: true };
	}

	return {
		MARK_START, MARK_END, MANAGED_KEYS, STUDY_KEYS, COLORS,
		colorInfo, sanitizeFilename, creatorName, authorNames, firstAuthorLastName,
		noteBasename, splitFolder, demoteHeadings, zoteroSelectURI, annotationURI, obsidianURI, tagToObsidian,
		yamlScalar, splitFrontmatter, parseFrontmatterBlocks, buildFrontmatter, managedFrontmatter, studyFrontmatter, appraisalFrontmatter,
		annotationsMarkdown, buildManagedSection, buildObsidianNote, buildNoteSections, callout,
		DEFAULT_COLOR_MEANINGS, colorMeanings, annotationGroups, topHighlights, oneSentence, keyFindings, aiNoteBody, factsLine,
		resolveRoute, parseRules, truncate, buildBaseFile, STATUSES, DELETED_STATUS,
		frontmatterScalar, setFrontmatterValue, zoteroKeyFromHead, markObsidianNoteDeleted,
	};
});
