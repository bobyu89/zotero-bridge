/*
 * Zotero Bridge — core helpers (pure functions, no Zotero globals).
 * Loaded into the plugin scope by bootstrap.js and required directly by the Node tests.
 */
(function (root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) {
		module.exports = api;
	}
	else {
		(root.ZB = root.ZB || {}).core = api;
	}
})(this, function () {
	const MARK_START = "%% zotero-bridge:start — 此區塊由 Zotero Bridge 自動產生，重新同步時會覆寫 %%";
	const MARK_END = "%% zotero-bridge:end %%";
	const MARK_START_RE = /^%% zotero-bridge:start.*%%[ \t]*$/m;
	const MARK_END_RE = /^%% zotero-bridge:end %%[ \t]*$/m;

	// Frontmatter keys owned by the plugin; every other key is the user's and survives re-sync
	const MANAGED_KEYS = [
		"title", "authors", "year", "publication", "item_type", "doi", "url", "citekey",
		"zotero", "zotero_key", "library", "collections", "tags", "notion",
		"ai_model", "ai_generated", "fulltext_truncated", "date_added", "last_synced",
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
				if (block.key && MANAGED_KEYS.includes(block.key)) continue;
				if (!block.key && !block.text.trim()) continue;
				lines.push(block.text);
			}
		}
		return `---\n${lines.join("\n")}\n---\n`;
	}

	function managedFrontmatter(data, opts = {}) {
		return {
			title: data.title || "",
			authors: authorNames(data),
			year: /^\d{4}$/.test(data.year || "") ? Number(data.year) : (data.year || ""),
			publication: data.publication || "",
			item_type: data.itemType || "",
			doi: data.doi || "",
			url: data.url || "",
			citekey: data.citationKey || "",
			zotero: zoteroSelectURI(data),
			zotero_key: `${data.libraryPath}/${data.key}`,
			library: data.libraryName || "",
			collections: data.collections || [],
			tags: (data.tags || []).map(tagToObsidian).filter(Boolean),
			notion: opts.notionUrl || "",
			ai_model: opts.aiModel || "",
			ai_generated: opts.aiGeneratedAt || "",
			fulltext_truncated: opts.fullTextTruncated ? true : "",
			date_added: data.dateAdded || "",
			last_synced: opts.now || "",
		};
	}

	// ---------- Markdown body ----------

	function quoteLines(text) {
		return String(text).split(/\r?\n/).map(l => (l ? `> ${l}` : ">")).join("\n");
	}

	// Nest a document's headings under a section heading: "# A" → "### A" for by=2
	function demoteHeadings(md, by) {
		let inFence = false;
		return String(md).split("\n").map((line) => {
			if (/^```/.test(line)) inFence = !inFence;
			if (inFence) return line;
			return line.replace(/^(#{1,6})(\s)/, (all, hashes, sp) => "#".repeat(Math.min(hashes.length + by, 6)) + sp);
		}).join("\n");
	}

	function annotationMarkdown(data, attachment, ann) {
		let color = colorInfo(ann.color);
		let page = ann.pageLabel ? `p. ${ann.pageLabel}` : "link";
		let link = `[${page}](${annotationURI(data, attachment, ann)})`;
		let out = [];
		if (ann.type === "highlight") {
			// Obsidian 1.14 colored highlight, one per line (a highlight can't span lines)
			let lines = String(ann.text || "").split(/\r?\n/).filter(l => l.trim())
				.map(l => `==${color.highlight}${l.trim().replace(/==/g, "=\\=")}==`);
			out.push(quoteLines(lines.join("\n") || `${color.emoji} *[劃線]*`));
			out.push(`> — ${link}`);
		}
		else if (ann.type === "underline") {
			out.push(quoteLines(`${color.emoji} <u>${ann.text || ""}</u>`));
			out.push(`> — ${link}`);
		}
		else if (ann.type === "image" || ann.type === "ink") {
			out.push(`> ${color.emoji} *[${ann.type === "image" ? "圖片" : "手繪"}註記]* — ${link}`);
		}
		else {
			out.push(`> ${color.emoji} *[便利貼]* — ${link}`);
		}
		if (ann.comment) {
			out.push("");
			out.push(`💬 ${ann.comment.replace(/\r?\n/g, "  \n")}`);
		}
		if (ann.tags && ann.tags.length) {
			out.push("");
			out.push(ann.tags.map(t => "#" + tagToObsidian(t)).filter(t => t.length > 1).join(" "));
		}
		return out.join("\n");
	}

	function annotationsMarkdown(data) {
		let sections = [];
		for (let att of data.attachments || []) {
			if (!att.annotations || !att.annotations.length) continue;
			let parts = [`### ${att.title || "Attachment"}`];
			for (let ann of att.annotations) {
				parts.push(annotationMarkdown(data, att, ann));
			}
			sections.push(parts.join("\n\n"));
		}
		return sections.join("\n\n");
	}

	function infoCallout(data, opts = {}) {
		let rows = [];
		let authors = authorNames(data);
		if (authors.length) rows.push(`**Authors**: ${authors.join("; ")}`);
		if (data.year) rows.push(`**Year**: ${data.year}`);
		if (data.publication) rows.push(`**Publication**: ${data.publication}`);
		if (data.doi) rows.push(`**DOI**: [${data.doi}](https://doi.org/${encodeURI(data.doi)})`);
		rows.push(`**Zotero**: [開啟](${zoteroSelectURI(data)})`);
		if (opts.notionUrl) rows.push(`**Notion**: [開啟](${opts.notionUrl})`);
		if (data.apa) rows.push(`**APA 7**: ${data.apa}`);
		return "> [!info] 書目資訊\n" + rows.map(r => `> ${r}`).join("  \n");
	}

	/**
	 * @param {object} data item data from the Zotero adapter
	 * @param {object} opts { aiMarkdown, notesMarkdown: [{title, md}], notionUrl }
	 */
	function buildManagedSection(data, opts = {}) {
		let parts = [MARK_START, infoCallout(data, opts)];
		if (opts.aiMarkdown) {
			parts.push("## 🤖 AI 文獻筆記\n\n" + demoteHeadings(opts.aiMarkdown.trim(), 1));
		}
		if (data.abstract) {
			parts.push("## Abstract\n\n" + data.abstract.trim());
		}
		let ann = annotationsMarkdown(data);
		if (ann) {
			parts.push("## Annotations\n\n" + ann);
		}
		let notes = (opts.notesMarkdown || []).filter(n => n.md && n.md.trim());
		if (notes.length) {
			parts.push("## Zotero Notes\n\n" + notes.map(n => demoteHeadings(n.md.trim(), 2)).join("\n\n---\n\n"));
		}
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
			let callout = `${DELETED_CALLOUT}\n> 這篇文獻已於 ${date} 在 Zotero 移到垃圾桶或刪除，Zotero Bridge 不會再更新這份筆記；從垃圾桶還原後重新同步即可恢復。`;
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
			"views:",
			"  - type: table",
			"    name: 文獻總表",
			"    order:",
			"      - file.name",
			"      - note.title",
			"      - note.authors",
			"      - note.year",
			"      - note.publication",
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
		MARK_START, MARK_END, MANAGED_KEYS, COLORS,
		colorInfo, sanitizeFilename, creatorName, authorNames, firstAuthorLastName,
		noteBasename, splitFolder, demoteHeadings, zoteroSelectURI, annotationURI, obsidianURI, tagToObsidian,
		yamlScalar, splitFrontmatter, parseFrontmatterBlocks, buildFrontmatter, managedFrontmatter,
		annotationsMarkdown, buildManagedSection, buildObsidianNote,
		resolveRoute, parseRules, truncate, buildBaseFile, STATUSES, DELETED_STATUS,
		frontmatterScalar, setFrontmatterValue, zoteroKeyFromHead, markObsidianNoteDeleted,
	};
});
