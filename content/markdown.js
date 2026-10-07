/*
 * Zotero Bridge — Markdown conversions:
 *   Markdown → Notion blocks (for Notion pages)
 *   Markdown → HTML          (for the AI note stored in Zotero)
 *   HTML → Markdown          (for Zotero notes going to Obsidian/Notion)
 */
(function (root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) {
		module.exports = api;
	}
	else {
		(root.ZB = root.ZB || {}).markdown = api;
	}
})(this, function () {
	const NOTION_TEXT_LIMIT = 2000;
	const NOTION_RICH_TEXT_ITEMS = 100;
	// Obsidian 1.14 highlight color emoji → Notion background color
	const HIGHLIGHT_COLORS = {
		"🔴": "red",
		"🟠": "orange",
		"🟡": "yellow",
		"🟢": "green",
		"🔵": "blue",
		"🟣": "purple",
	};

	// ---------- Inline parsing (shared) ----------

	// Tokenize inline Markdown into [{ text, bold, italic, code, link }]
	function parseInline(src) {
		let tokens = [];
		// Underscore emphasis only at word boundaries, so snake_case stays literal
		let re = /(<u>[^<]+<\/u>)|(==[^=\n]+?==)|(`[^`]+`)|(\*\*[^*]+?\*\*|(?<![\p{L}\p{N}])__[^_]+?__(?![\p{L}\p{N}]))|(\*[^*\s][^*]*?\*|(?<![\p{L}\p{N}])_[^_\s][^_]*?_(?![\p{L}\p{N}]))|(\[\[[^\]]+\]\])|(\[[^\]]+\]\([^)\s]+\))/gu;
		let last = 0;
		let m;
		let push = (text, style = {}) => {
			if (text) tokens.push(Object.assign({ text }, style));
		};
		while ((m = re.exec(src))) {
			push(src.slice(last, m.index));
			let s = m[0];
			if (m[1]) {
				for (let t of parseInline(s.slice(3, -4))) push(t.text, Object.assign({}, t, { underline: true }));
			}
			else if (m[2]) {
				// Obsidian 1.14 colored highlight: ==🟡text==
				let inner = s.slice(2, -2);
				let color = "";
				for (let emoji of Object.keys(HIGHLIGHT_COLORS)) {
					if (inner.startsWith(emoji)) {
						color = HIGHLIGHT_COLORS[emoji];
						inner = inner.slice(emoji.length);
						break;
					}
				}
				for (let t of parseInline(inner)) push(t.text, Object.assign({}, t, { highlight: color || "yellow" }));
			}
			else if (m[3]) {
				push(s.slice(1, -1), { code: true });
			}
			else if (m[4]) {
				for (let t of parseInline(s.slice(2, -2))) push(t.text, Object.assign({}, t, { bold: true }));
			}
			else if (m[5]) {
				for (let t of parseInline(s.slice(1, -1))) push(t.text, Object.assign({}, t, { italic: true }));
			}
			else if (m[6]) {
				// [[Target|Alias]] → Alias ; [[Target]] → Target
				let inner = s.slice(2, -2);
				let alias = inner.includes("|") ? inner.split("|").slice(1).join("|") : inner;
				push(alias, { wikilink: inner.split("|")[0] });
			}
			else if (m[7]) {
				let lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(s);
				push(lm[1], { link: lm[2] });
			}
			last = m.index + s.length;
		}
		push(src.slice(last));
		return tokens;
	}

	function isWebURL(url) {
		return /^https?:\/\//i.test(url);
	}

	function chunkString(s, size) {
		let out = [];
		for (let i = 0; i < s.length; i += size) {
			let piece = s.slice(i, i + size);
			// Keep surrogate pairs together
			if (/[\ud800-\udbff]$/.test(piece) && i + size < s.length) {
				piece = s.slice(i, i + size - 1);
				i -= 1;
			}
			out.push(piece);
		}
		return out;
	}

	function toRichText(src, extraAnnotations) {
		let rich = [];
		for (let t of parseInline(src)) {
			for (let piece of chunkString(t.text, NOTION_TEXT_LIMIT)) {
				let item = { type: "text", text: { content: piece } };
				// Notion only accepts web links in rich text
				if (t.link && isWebURL(t.link)) item.text.link = { url: t.link };
				let ann = Object.assign({}, extraAnnotations || {});
				if (t.bold) ann.bold = true;
				if (t.italic) ann.italic = true;
				if (t.code) ann.code = true;
				if (t.underline) ann.underline = true;
				if (t.highlight) ann.color = `${t.highlight}_background`;
				if (Object.keys(ann).length) item.annotations = ann;
				rich.push(item);
			}
		}
		if (rich.length > NOTION_RICH_TEXT_ITEMS) {
			// Too many styled runs: fall back to plain chunks
			let plain = rich.map(r => r.text.content).join("");
			rich = chunkString(plain, NOTION_TEXT_LIMIT).map(c => ({ type: "text", text: { content: c } }));
		}
		return rich;
	}

	// ---------- Markdown → Notion blocks ----------

	function block(type, richText, extra) {
		let b = { object: "block", type };
		b[type] = Object.assign({ rich_text: richText }, extra || {});
		return b;
	}

	// Split a long rich_text into several blocks of the same type when needed
	function blocksFor(type, text, extra) {
		let rich = toRichText(text);
		let out = [];
		for (let i = 0; i < Math.max(rich.length, 1); i += NOTION_RICH_TEXT_ITEMS) {
			out.push(block(type, rich.slice(i, i + NOTION_RICH_TEXT_ITEMS), extra));
		}
		return out;
	}

	/**
	 * Convert Markdown to a flat list of Notion blocks (no nested children), so the
	 * result can always be placed inside one container block.
	 */
	function mdToNotionBlocks(md) {
		let lines = String(md || "").replace(/\r\n?/g, "\n").split("\n");
		let blocks = [];
		let para = [];
		let flushPara = () => {
			if (para.length) {
				blocks.push(...blocksFor("paragraph", para.join(" ")));
				para = [];
			}
		};
		for (let i = 0; i < lines.length; i++) {
			let line = lines[i];
			let m;
			if (/^\s*$/.test(line)) {
				flushPara();
				continue;
			}
			if ((m = /^```(\S*)\s*$/.exec(line))) {
				flushPara();
				let code = [];
				i++;
				while (i < lines.length && !/^```\s*$/.test(lines[i])) {
					code.push(lines[i]);
					i++;
				}
				let content = code.join("\n");
				let rich = chunkString(content, NOTION_TEXT_LIMIT).map(c => ({ type: "text", text: { content: c } }));
				blocks.push(block("code", rich.length ? rich : [], { language: "plain text" }));
				continue;
			}
			if (/^%%.*%%\s*$/.test(line)) {
				// Obsidian comment
				flushPara();
				continue;
			}
			if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
				flushPara();
				let level = Math.min(m[1].length, 3);
				blocks.push(...blocksFor(`heading_${level}`, m[2].trim()));
				continue;
			}
			if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
				flushPara();
				blocks.push({ object: "block", type: "divider", divider: {} });
				continue;
			}
			if ((m = /^>\s?(.*)$/.exec(line))) {
				flushPara();
				let quote = [m[1]];
				while (i + 1 < lines.length && /^>/.test(lines[i + 1])) {
					i++;
					quote.push(lines[i].replace(/^>\s?/, ""));
				}
				// Obsidian callout header: > [!type] Title
				let cm = /^\[!(\w+)\][+-]?\s*(.*)$/.exec(quote[0]);
				if (cm) {
					quote[0] = cm[2] ? `**${cm[2]}**` : "";
					if (!quote[0]) quote.shift();
				}
				let text = quote.map(l => l.replace(/ {2}$/, "")).join("\n").trim();
				blocks.push(...blocksFor("quote", text));
				continue;
			}
			if ((m = /^(\s*)[-*+]\s+\[( |x|X)\]\s+(.*)$/.exec(line))) {
				flushPara();
				blocks.push(...blocksFor("to_do", m[3], { checked: m[2] !== " " }));
				continue;
			}
			if ((m = /^(\s*)[-*+]\s+(.*)$/.exec(line))) {
				flushPara();
				let depth = Math.floor(m[1].replace(/\t/g, "  ").length / 2);
				let prefix = depth ? "◦ ".padStart(depth * 2 + 2, " ") : "";
				blocks.push(...blocksFor("bulleted_list_item", prefix + m[2]));
				continue;
			}
			if ((m = /^(\s*)\d+[.)]\s+(.*)$/.exec(line))) {
				flushPara();
				let depth = Math.floor(m[1].replace(/\t/g, "  ").length / 2);
				let prefix = depth ? "◦ ".padStart(depth * 2 + 2, " ") : "";
				blocks.push(...blocksFor(depth ? "bulleted_list_item" : "numbered_list_item", prefix + m[2]));
				continue;
			}
			if (/^\|.*\|\s*$/.test(line)) {
				// Tables: render each row as a paragraph (Notion tables can't nest in our container)
				flushPara();
				if (/^\|[\s:|-]+\|\s*$/.test(line)) continue;
				let cells = line.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
				blocks.push(...blocksFor("paragraph", cells.join(" ｜ ")));
				continue;
			}
			para.push(line.trim());
		}
		flushPara();
		return blocks;
	}

	// ---------- Markdown → HTML ----------

	function escapeHTML(s) {
		return String(s)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");
	}

	function inlineToHTML(src) {
		return parseInline(src).map((t) => {
			let h = escapeHTML(t.wikilink ? `[[${t.wikilink === t.text ? t.text : t.wikilink + "|" + t.text}]]` : t.text);
			if (t.code) h = `<code>${h}</code>`;
			if (t.highlight) h = `<mark>${h}</mark>`;
			if (t.underline) h = `<u>${h}</u>`;
			if (t.italic) h = `<em>${h}</em>`;
			if (t.bold) h = `<strong>${h}</strong>`;
			if (t.link) h = `<a href="${escapeHTML(t.link)}">${h}</a>`;
			return h;
		}).join("");
	}

	function mdToHtml(md) {
		let lines = String(md || "").replace(/\r\n?/g, "\n").split("\n");
		let out = [];
		let para = [];
		let listType = null;
		let closeList = () => {
			if (listType) {
				out.push(`</${listType}>`);
				listType = null;
			}
		};
		let flushPara = () => {
			if (para.length) {
				out.push(`<p>${para.map(inlineToHTML).join("<br>")}</p>`);
				para = [];
			}
		};
		for (let i = 0; i < lines.length; i++) {
			let line = lines[i];
			let m;
			if (/^\s*$/.test(line)) {
				flushPara();
				closeList();
				continue;
			}
			if (/^```/.test(line)) {
				flushPara();
				closeList();
				let code = [];
				i++;
				while (i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i++]);
				out.push(`<pre>${escapeHTML(code.join("\n"))}</pre>`);
				continue;
			}
			if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
				flushPara();
				closeList();
				out.push(`<h${m[1].length}>${inlineToHTML(m[2].trim())}</h${m[1].length}>`);
				continue;
			}
			if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
				flushPara();
				closeList();
				out.push("<hr>");
				continue;
			}
			if ((m = /^>\s?(.*)$/.exec(line))) {
				flushPara();
				closeList();
				let quote = [m[1]];
				while (i + 1 < lines.length && /^>/.test(lines[i + 1])) quote.push(lines[++i].replace(/^>\s?/, ""));
				out.push(`<blockquote><p>${quote.map(inlineToHTML).join("<br>")}</p></blockquote>`);
				continue;
			}
			let ul = /^\s*[-*+]\s+(.*)$/.exec(line);
			let ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
			if (ul || ol) {
				flushPara();
				let type = ul ? "ul" : "ol";
				if (listType !== type) {
					closeList();
					out.push(`<${type}>`);
					listType = type;
				}
				out.push(`<li>${inlineToHTML((ul || ol)[1])}</li>`);
				continue;
			}
			closeList();
			para.push(line.trim());
		}
		flushPara();
		closeList();
		return out.join("\n");
	}

	// ---------- HTML → Markdown ----------

	/**
	 * @param {string} html
	 * @param {function} parse - (html) => Document, e.g. s => new DOMParser().parseFromString(s, "text/html")
	 */
	function htmlToMd(html, parse) {
		let doc = parse(`<!DOCTYPE html><html><body>${html || ""}</body></html>`);
		let out = renderChildren(doc.body, { listDepth: 0 });
		// Whitespace-only text nodes between block elements leave blank-looking lines behind
		out = out.split("\n").map(l => (/^\s+$/.test(l) ? "" : l)).join("\n");
		return out.replace(/\n{3,}/g, "\n\n").trim();
	}

	function renderChildren(node, ctx) {
		let s = "";
		for (let child of node.childNodes) s += renderNode(child, ctx);
		return s;
	}

	function inlineText(node, ctx) {
		return renderChildren(node, ctx).replace(/\n+/g, " ");
	}

	function renderNode(node, ctx) {
		if (node.nodeType === 3) {
			return node.nodeValue.replace(/\s+/g, " ");
		}
		if (node.nodeType !== 1) return "";
		let tag = node.tagName.toLowerCase();
		switch (tag) {
			case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
				return `\n\n${"#".repeat(Number(tag[1]))} ${inlineText(node, ctx).trim()}\n\n`;
			case "p":
			case "div":
				return `\n\n${renderChildren(node, ctx).trim()}\n\n`;
			case "br":
				return "  \n";
			case "strong": case "b": {
				let t = inlineText(node, ctx).trim();
				return t ? `**${t}**` : "";
			}
			case "em": case "i": {
				let t = inlineText(node, ctx).trim();
				return t ? `*${t}*` : "";
			}
			case "code":
				return "`" + node.textContent + "`";
			case "u": {
				let t = inlineText(node, ctx).trim();
				return t ? `<u>${t}</u>` : "";
			}
			case "mark": {
				let t = inlineText(node, ctx).trim();
				return t ? `==${t}==` : "";
			}
			case "pre":
				return "\n\n```\n" + node.textContent.replace(/\n$/, "") + "\n```\n\n";
			case "a": {
				let href = node.getAttribute("href") || "";
				let t = inlineText(node, ctx).trim() || href;
				return href ? `[${t}](${href})` : t;
			}
			case "blockquote": {
				let inner = renderChildren(node, ctx).trim();
				return "\n\n" + inner.split("\n").map(l => (l ? `> ${l}` : ">")).join("\n") + "\n\n";
			}
			case "ul":
			case "ol": {
				let items = [];
				let n = 1;
				for (let li of node.children) {
					if (li.tagName.toLowerCase() !== "li") continue;
					let indent = "  ".repeat(ctx.listDepth);
					let marker = tag === "ol" ? `${n++}.` : "-";
					let nested = "";
					let text = "";
					for (let c of li.childNodes) {
						if (c.nodeType === 1 && /^(ul|ol)$/i.test(c.tagName)) {
							nested += renderNode(c, { listDepth: ctx.listDepth + 1 }).replace(/^\n+|\n+$/g, "") + "\n";
						}
						else {
							text += renderNode(c, ctx);
						}
					}
					items.push(`${indent}${marker} ${text.replace(/\s*\n+\s*/g, " ").trim()}` + (nested ? "\n" + nested.trimEnd() : ""));
				}
				return "\n\n" + items.join("\n") + "\n\n";
			}
			case "hr":
				return "\n\n---\n\n";
			case "img":
				return "";
			case "table": {
				let rows = [];
				for (let tr of node.querySelectorAll("tr")) {
					let cells = [...tr.children].map(td => inlineText(td, ctx).trim().replace(/\|/g, "\\|"));
					rows.push(`| ${cells.join(" | ")} |`);
					if (rows.length === 1) rows.push(`|${cells.map(() => " --- ").join("|")}|`);
				}
				return "\n\n" + rows.join("\n") + "\n\n";
			}
			default:
				return renderChildren(node, ctx);
		}
	}

	// Strip wikilink brackets for places that can't render them (Notion properties)
	function plainText(md) {
		return parseInline(String(md || "")).map(t => t.text).join("");
	}

	return { parseInline, toRichText, mdToNotionBlocks, mdToHtml, htmlToMd, plainText, chunkString, NOTION_TEXT_LIMIT };
});
