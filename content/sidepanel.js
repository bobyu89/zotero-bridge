/*
 * ZotMax — the ZotMax panel: one section of Zotero's item pane, with its own icon in the side
 * navigation, shown next to the selected item in the library and next to the PDF in the reader's side
 * pane (Zotero's ItemPaneManager sections appear in both). For an attachment or a note it shows the
 * parent item.
 *
 * Five folding parts, in this order (DESIGN.md › ZotMax panel):
 *   重點       the literature note's 「重點」 as data (core.keyPoints): the one-sentence take-away, the
 *              facts line (design · N · evidence level · appraisal verdict) and 2–3 key findings, then
 *              the links to the synced notes; the whole AI note folded underneath. Without an AI note:
 *              what it is and how to make one (or where to turn it on).
 *   我的劃線   the user's highlights grouped by colour meaning (core.annotationGroups), the first three of
 *              each; a click opens the PDF at that annotation.
 *   狀態       reading status, screening and 文獻評讀表 (their modules' rows), the 自動分類 sub-collections
 *              the item is in, and when it was last synced.
 *   動作       the item commands of the command catalog (commands.js), run with [this item] as the
 *              selection; switched-off commands hide, as in the toolbar and the right-click menus.
 *   延伸搜尋   the search links row (search-links.js).
 * 重點 and 動作 start open; what the user opens or closes is remembered (pref pane.open). Parts whose
 * features are switched off disappear.
 *
 * Live: the panel renders again when the item, its notes, annotations, tags or collections change
 * (one Notifier observer), when a feature switch or a setting it shows changes (pref observers), and
 * after a ZotMax command or sync finishes (main.run). A refresh waits while the user is typing in a
 * field of the panel (the 文獻評讀表). Its stylesheet (sidepanel.css) is added to every main window,
 * where the reader's side pane lives too. shutdown() unregisters the section, the observers and the
 * stylesheets.
 */
(function (root) {
	const PANE_ID = "zotero-bridge-ai-note";
	const STYLE_ID = "zotero-bridge-sidepanel-css";
	const HTML_NS = "http://www.w3.org/1999/xhtml";
	const PREF = "extensions.zotero-bridge.";
	// Which parts are open: JSON { keyPoints: true, highlights: false, … }; missing = the default below
	const OPEN_PREF = PREF + "pane.open";
	const SUBSECTIONS = [
		{ id: "keyPoints", open: true },
		{ id: "highlights", open: false },
		{ id: "status", open: false },
		{ id: "actions", open: true },
		{ id: "search", open: false },
	];
	// The item commands offered under 動作, in catalog order; 快速指令… comes last
	const ACTIONS = ["sync", "sync-no-ai", "regenerate", "classify", "search-item", "chase-items"];
	const SHOWN_PER_MEANING = 3;
	const QUOTE_LENGTH = 120;
	const REFRESH_DELAY_MS = 250;
	// Settings the panel shows (besides the feature switches): a change renders it again
	const WATCHED_PREFS = ["annotations.colorMeanings", "classify.parentName", "searchLinks.paneLinks", "status.tagPrefix",
		"obsidian.vaultPath", "obsidian.vaultName", "obsidian.folder", "obsidian.filenameFormat", "routing.rules"];

	// zh-TW text of the panel's Fluent messages (identical to locale/zh-TW; tests check). Shown as is
	// until Fluent translates the element (and in tests, where there is no Fluent)
	const STRINGS = {
		keyPoints: ["zotero-bridge-pane-key-points", "重點"],
		highlights: ["zotero-bridge-pane-highlights", "我的劃線"],
		status: ["zotero-bridge-pane-status", "狀態"],
		actions: ["zotero-bridge-pane-actions", "動作"],
		search: ["zotero-bridge-pane-search", "延伸搜尋"],
		findings: ["zotero-bridge-pane-findings", "主要發現"],
		fullNote: ["zotero-bridge-pane-full-note", "完整 AI 筆記"],
		fullNoteMeta: ["zotero-bridge-pane-full-note-meta", "完整 AI 筆記（{ $name }）"],
		noNote: ["zotero-bridge-pane-no-note", "這篇還沒有 AI 文獻筆記。"],
		noNoteHint: ["zotero-bridge-pane-no-note-hint", "產生時會呼叫你設定的 AI 服務（要付費），完成後同步到 Notion／Obsidian。"],
		generate: ["zotero-bridge-pane-generate", "產生 AI 筆記"],
		aiOff: ["zotero-bridge-pane-ai-off", "AI 文獻筆記目前關閉，同步時只整理書目、劃線和你的筆記。要打開：設定 → 功能。"],
		openFeatures: ["zotero-bridge-pane-open-features", "打開設定"],
		linkObsidian: ["zotero-bridge-pane-link-obsidian", "在 Obsidian 開啟筆記"],
		linkFullText: ["zotero-bridge-pane-link-fulltext", "開啟全文筆記"],
		linkNotion: ["zotero-bridge-pane-link-notion", "在 Notion 開啟"],
		noHighlights: ["zotero-bridge-pane-no-highlights", "還沒有劃線。在 PDF 上劃線，這裡會依顏色的意義分組。"],
		colors: ["zotero-bridge-pane-colors", "顏色的意義"],
		openPDF: ["zotero-bridge-pane-open-pdf", "開啟 PDF"],
		count: ["zotero-bridge-pane-count", "{ $count } 則"],
		showAll: ["zotero-bridge-pane-show-all", "全部顯示（{ $count } 則）"],
		showFewer: ["zotero-bridge-pane-show-fewer", "只顯示前幾則"],
		annImage: ["zotero-bridge-pane-ann-image", "圖片註記"],
		annInk: ["zotero-bridge-pane-ann-ink", "手繪註記"],
		annNote: ["zotero-bridge-pane-ann-note", "便利貼"],
		annHighlight: ["zotero-bridge-pane-ann-highlight", "劃線"],
		classified: ["zotero-bridge-pane-classified", "自動分類"],
		lastSynced: ["zotero-bridge-pane-last-synced", "上次同步：{ $name }"],
		notSynced: ["zotero-bridge-pane-not-synced", "還沒有同步到 Obsidian。"],
		summaryNone: ["zotero-bridge-pane-summary-none", "尚未產生"],
		summaryOff: ["zotero-bridge-pane-summary-off", "AI 筆記已關閉"],
		"cmd-sync": ["zotero-bridge-pane-cmd-sync", "同步"],
		"cmd-sync-no-ai": ["zotero-bridge-pane-cmd-sync-no-ai", "同步，不呼叫 AI"],
		"cmd-regenerate": ["zotero-bridge-pane-cmd-regenerate", "重新產生 AI 筆記"],
		"cmd-classify": ["zotero-bridge-pane-cmd-classify", "自動分類…"],
		"cmd-search-item": ["zotero-bridge-pane-cmd-search-item", "搜尋資料庫…"],
		"cmd-chase-items": ["zotero-bridge-pane-cmd-chase-items", "引文追蹤"],
		"cmd-palette": ["zotero-bridge-pane-cmd-palette", "快速指令…"],
	};

	let pluginID = null;
	let rootURI = "";
	let chromeRegistered = false;
	let paneKey = null;
	// Section bodies Zotero created (onInit): body → { refresh, itemID }
	let bodies = new Map();
	// Every rendered body → its last render props and render count (stale async results are dropped)
	let lastProps = new WeakMap();
	let renders = new WeakMap();
	// Groups opened with 「全部顯示」: "itemID:colour"
	let expanded = new Set();
	let notifierID = null;
	let prefObservers = [];
	let refreshTimer = null;
	let pending = { all: false, ids: new Set() };
	// Windows holding the stylesheet
	let windows = new Set();

	function ZB() {
		return root.ZB;
	}

	// False after shutdown(): Zotero can still call an old section's hooks (or a timer can fire)
	// while the plugin is being disabled, when root.ZB is already gone
	let live = false;
	function alive() {
		return live && !!root.ZB;
	}

	function C() {
		return root.ZB.commands;
	}

	function log(e) {
		Zotero.logError(e);
	}

	// False once the plugin is gone, so a late promise or event never reaches a missing ZB
	function featureOn(id) {
		return alive() && ZB().features.isEnabled(id);
	}

	/** An event listener that does nothing after shutdown and logs instead of throwing. */
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

	function fill(text, args) {
		return String(text).replace(/\{ \$(\w+) \}/g, (m, k) => (args && args[k] !== undefined ? String(args[k]) : m));
	}

	// ---------- DOM ----------

	function h(doc, tag, attrs = {}, ...children) {
		let el = doc.createElementNS(HTML_NS, tag);
		for (let [k, v] of Object.entries(attrs)) {
			if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v === true ? "" : String(v));
		}
		for (let c of children) {
			if (c !== null && c !== undefined) el.append(c);
		}
		return el;
	}

	/** An element showing one of STRINGS: its zh-TW text now, Fluent's translation once attached. */
	function t(doc, tag, name, args, attrs = {}) {
		let [id, text] = STRINGS[name];
		let el = h(doc, tag, attrs, fill(text, args));
		el.setAttribute("data-l10n-id", id);
		if (args) el.setAttribute("data-l10n-args", JSON.stringify(args));
		return el;
	}

	function xul(doc, tag) {
		return doc.createXULElement ? doc.createXULElement(tag) : doc.createElement(tag);
	}

	// ---------- the item ----------

	/** The literature item the panel is about: the item itself, or the parent of an attachment or note. */
	function targetItem(item) {
		let it = item;
		try {
			while (it && !it.isRegularItem() && it.parentItem) it = it.parentItem;
			return it && it.isRegularItem() ? it : null;
		}
		catch (e) {
			return null;
		}
	}

	/** The selection a command gets from the panel: this item, as from its right-click menu. */
	function selectionFor(item) {
		return C().fromContext("item", { items: [item], collectionTreeRows: [] });
	}

	function readAI(data) {
		if (!data.aiNote) return null;
		try {
			return ZB().main.readAINote(data.aiNote.html);
		}
		catch (e) {
			log(e);
			return null;
		}
	}

	function appraisalValues(data, ai) {
		try {
			let info = ZB().appraisalForm.syncInfo(data, ai);
			return info ? info.values : null;
		}
		catch (e) {
			log(e);
			return null;
		}
	}

	function localTime(iso) {
		let d = new Date(iso);
		if (!iso || isNaN(d.getTime())) return String(iso || "");
		let p = n => String(n).padStart(2, "0");
		return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
	}

	// ---------- open and closed parts ----------

	function readOpen() {
		try {
			let v = JSON.parse(Zotero.Prefs.get(OPEN_PREF, true) || "{}");
			return v && typeof v === "object" && !Array.isArray(v) ? v : {};
		}
		catch (e) {
			return {};
		}
	}

	function isOpen(id) {
		let v = readOpen()[id];
		if (typeof v === "boolean") return v;
		let s = SUBSECTIONS.find(x => x.id === id);
		return !!(s && s.open);
	}

	function setOpen(id, open) {
		if (isOpen(id) === open) return;
		let all = readOpen();
		all[id] = open;
		Zotero.Prefs.set(OPEN_PREF, JSON.stringify(all), true);
	}

	/** One folding part: a native <details> whose summary names it, with a short peek while closed. */
	function part(doc, id, peek) {
		let details = h(doc, "details", { class: "zb-sp-sub", "data-zb-sub": id, open: isOpen(id) });
		let row = h(doc, "span", { class: "zb-sp-row" }, t(doc, "span", id, null, { class: "zb-sp-title" }));
		if (peek) row.append(typeof peek === "string" ? h(doc, "span", { class: "zb-sp-peek" }, peek) : peek);
		details.append(h(doc, "summary", { class: "zb-sp-summary" }, row));
		let body = h(doc, "div", { class: "zb-sp-body" });
		details.append(body);
		listen(details, "toggle", () => setOpen(id, details.open));
		return { details, body };
	}

	// ---------- render ----------

	/**
	 * ItemPaneManager's onRender: the panel for `item` (or its parent) into `body`. Synchronous; the
	 * links and the last sync time are filled in when the note has been read (main.noteLinks).
	 */
	function render(props) {
		let { doc, body, item } = props;
		let setSummary = typeof props.setSectionSummary === "function" ? props.setSectionSummary : () => {};
		let count = (renders.get(body) || 0) + 1;
		renders.set(body, count);
		lastProps.set(body, props);
		let target = targetItem(item);
		let entry = bodies.get(body);
		if (entry) entry.itemID = target ? target.id : null;
		body.replaceChildren();
		if (!target) {
			setSummary("");
			return;
		}
		let data = ZB().adapter.paneData(target);
		let ai = readAI(data);
		let kp = ZB().core.keyPoints(data, {
			aiMarkdown: ai && ai.md,
			study: ai && ai.data,
			appraisal: appraisalValues(data, ai),
			colorMeanings: Zotero.Prefs.get(PREF + "annotations.colorMeanings", true) || "",
		});
		let ctx = { doc, body, item: target, data, ai, kp, count, setSummary };
		let panel = h(doc, "div", { class: "zb-sp", "data-zb-pane": "panel" });
		body.append(panel);
		let links = renderKeyPoints(ctx, panel);
		renderHighlights(ctx, panel);
		let synced = renderStatus(ctx, panel);
		renderActions(ctx, panel);
		renderSearch(ctx, panel);
		fillLinks(ctx, links, synced);
	}

	function summaryText(ctx, name) {
		let [id, text] = STRINGS[name];
		ctx.setSummary(text);
		let l10n = ctx.doc.l10n;
		if (!l10n || !l10n.formatValue) return;
		Promise.resolve(l10n.formatValue(id)).then((value) => {
			if (value && renders.get(ctx.body) === ctx.count) ctx.setSummary(value);
		}).catch(() => {});
	}

	// 重點
	function renderKeyPoints(ctx, panel) {
		let { doc, ai, kp } = ctx;
		let plain = s => ZB().markdown.plainText(s);
		let sentence = kp.sentence ? plain(kp.sentence) : "";
		let { details, body } = part(doc, "keyPoints", sentence);
		if (ai) {
			let summary = plain(ZB().llm.extractSummary(ai.md));
			ctx.setSummary(summary.slice(0, 80));
			if (sentence) body.append(h(doc, "p", { class: "zb-sp-lead" }, sentence));
		}
		else if (featureOn("aiNotes")) {
			summaryText(ctx, "summaryNone");
		}
		else {
			summaryText(ctx, "summaryOff");
		}
		if (kp.facts) body.append(h(doc, "p", { class: "zb-sp-facts" }, kp.facts));
		if (kp.findings.length) {
			body.append(h(doc, "div", { class: "zb-sp-findings" },
				t(doc, "p", "findings", null, { class: "zb-sp-label" }),
				h(doc, "ul", { class: "zb-sp-list" }, ...kp.findings.map(f => h(doc, "li", {}, plain(f))))));
		}
		if (ai) {
			let note = fullNote(ctx);
			if (note) body.append(note);
		}
		else if (featureOn("aiNotes")) {
			body.append(t(doc, "p", "noNote", null, { class: "zb-sp-lead" }), t(doc, "p", "noNoteHint", null, { class: "zb-sp-hint" }));
			// 「同步」 from the catalog: it generates the note when there is none
			let cmd = C().get("sync");
			if (C().isVisible(cmd)) {
				body.append(h(doc, "div", { class: "zb-sp-actions" }, commandButton(ctx, cmd, "generate")));
			}
		}
		else {
			let open = t(doc, "button", "openFeatures", null, { class: "zb-sp-link", type: "button", "data-zb-action": "open-features" });
			listen(open, "click", () => C().openSettings("ai"));
			body.append(h(doc, "p", { class: "zb-sp-hint" }, t(doc, "span", "aiOff"), " ", open));
		}
		// Filled when the literature note has been read
		let links = h(doc, "p", { class: "zb-sp-links", hidden: true, "data-zb-links": "" });
		body.append(links);
		panel.append(details);
		return links;
	}

	/** The whole AI note (without its one-sentence summary), folded; its summary names model and date. Null when empty. */
	function fullNote(ctx) {
		let { doc, ai } = ctx;
		let meta = [ai.model, ai.at && String(ai.at).slice(0, 10)].filter(Boolean).join(" · ");
		let details = h(doc, "details", { class: "zb-sp-more", "data-zb-full-note": "" });
		details.append(meta
			? t(doc, "summary", "fullNoteMeta", { name: meta })
			: t(doc, "summary", "fullNote"));
		let note = h(doc, "div", { class: "zb-sp-note" });
		let list = null;
		let blocks = ZB().markdown.mdToOutline(ZB().core.aiNoteBody(ai.md));
		// Nothing beyond the one-sentence summary
		if (!blocks.length) return null;
		for (let block of blocks) {
			if (block.type === "li") {
				if (!list) {
					list = h(doc, "ul", { class: "zb-sp-list" });
					note.append(list);
				}
				list.append(h(doc, "li", { class: block.level ? "zb-sp-li-nested" : null, style: block.level ? `--zb-level: ${block.level}` : null }, block.text));
				continue;
			}
			list = null;
			if (block.type === "h") note.append(h(doc, "p", { class: "zb-sp-note-heading" }, block.text));
			else if (block.type === "quote") note.append(h(doc, "blockquote", { class: "zb-sp-quote" }, block.text));
			else note.append(h(doc, "p", {}, block.text));
		}
		details.append(note);
		return details;
	}

	// 我的劃線
	function renderHighlights(ctx, panel) {
		let { doc, data, kp, item } = ctx;
		let total = kp.groups.reduce((n, g) => n + g.items.length, 0);
		let peekEl = total ? t(doc, "span", "count", { count: total }, { class: "zb-sp-peek" }) : null;
		let { details, body } = part(doc, "highlights", peekEl);
		details.setAttribute("data-zb-count", String(total));
		if (!total) {
			let hint = h(doc, "p", { class: "zb-sp-hint" }, t(doc, "span", "noHighlights"), " ", settingsLink(doc, "colors", "colors"));
			body.append(hint);
			let att = data.attachments[0];
			if (att) {
				let open = t(doc, "button", "openPDF", null, { type: "button", "data-zb-action": "open-pdf" });
				listen(open, "click", () => openAttachment(att.id));
				body.append(h(doc, "div", { class: "zb-sp-actions" }, open));
			}
			panel.append(details);
			return;
		}
		for (let g of kp.groups) {
			let key = `${item.id}:${g.color || "other"}`;
			let all = expanded.has(key);
			let group = h(doc, "div", { class: "zb-sp-group", "data-zb-color": g.color || "other" });
			let swatch = h(doc, "span", { class: "zb-sp-swatch", "aria-hidden": "true" });
			if (g.color) swatch.style.setProperty("--zb-swatch", g.color);
			group.append(h(doc, "p", { class: "zb-sp-group-head" },
				swatch, h(doc, "span", { class: "zb-sp-meaning" }, g.meaning),
				t(doc, "span", "count", { count: g.items.length }, { class: "zb-sp-count" })));
			let list = h(doc, "ul", { class: "zb-sp-anns" });
			for (let { att, ann } of all ? g.items : g.items.slice(0, SHOWN_PER_MEANING)) {
				list.append(h(doc, "li", {}, annotationButton(doc, att, ann)));
			}
			group.append(list);
			if (g.items.length > SHOWN_PER_MEANING) {
				let more = all
					? t(doc, "button", "showFewer", null, { class: "zb-sp-link", type: "button", "aria-expanded": "true" })
					: t(doc, "button", "showAll", { count: g.items.length }, { class: "zb-sp-link", type: "button", "aria-expanded": "false" });
				more.setAttribute("data-zb-action", "show-all");
				listen(more, "click", () => {
					if (all) expanded.delete(key);
					else expanded.add(key);
					refreshBody(ctx.body);
				});
				group.append(more);
			}
			body.append(group);
		}
		panel.append(details);
	}

	/** One annotation: its words (or what kind it is) and its page; a click opens it in the reader. */
	function annotationButton(doc, att, ann) {
		let core = ZB().core;
		let text = core.oneLine(ann.text);
		let b = h(doc, "button", { class: "zb-sp-ann", type: "button", "data-zb-annotation": ann.key });
		if ((ann.type === "highlight" || ann.type === "underline") && text) {
			b.append(h(doc, "span", { class: "zb-sp-quote-text" }, core.shorten(text, QUOTE_LENGTH)));
		}
		else {
			let kind = ann.type === "image" ? "annImage" : ann.type === "ink" ? "annInk" : ann.type === "note" || ann.type === "text" ? "annNote" : "annHighlight";
			b.append(t(doc, "span", kind, null, { class: "zb-sp-kind" }));
			let comment = core.oneLine(ann.comment);
			if (comment) b.append(" ", h(doc, "span", { class: "zb-sp-quote-text" }, core.shorten(comment, QUOTE_LENGTH)));
		}
		if (ann.pageLabel) b.append(h(doc, "span", { class: "zb-sp-page" }, `p. ${ann.pageLabel}`));
		listen(b, "click", () => openAnnotation(att.id, ann.key));
		return b;
	}

	function openAnnotation(attachmentID, annotationKey) {
		try {
			if (Zotero.Reader && typeof Zotero.Reader.open === "function") {
				return Promise.resolve(Zotero.Reader.open(attachmentID, { annotationID: annotationKey })).catch(log);
			}
		}
		catch (e) {
			log(e);
		}
		return openAttachment(attachmentID);
	}

	function openAttachment(attachmentID) {
		try {
			if (Zotero.Reader && typeof Zotero.Reader.open === "function") return Promise.resolve(Zotero.Reader.open(attachmentID)).catch(log);
			let pane = Zotero.getActiveZoteroPane();
			if (pane && pane.viewAttachment) return Promise.resolve(pane.viewAttachment(attachmentID)).catch(log);
		}
		catch (e) {
			log(e);
		}
		return Promise.resolve(null);
	}

	function settingsLink(doc, name, section) {
		let b = t(doc, "button", name, null, { class: "zb-sp-link", type: "button", "data-zb-settings": section });
		listen(b, "click", () => C().openSettings(section));
		return b;
	}

	// 狀態
	function renderStatus(ctx, panel) {
		let { doc, item } = ctx;
		let words = [];
		let safe = (fn) => {
			try {
				return fn();
			}
			catch (e) {
				log(e);
				return "";
			}
		};
		if (featureOn("status")) words.push(safe(() => ZB().status.paneSummary(item)));
		if (featureOn("screening")) words.push(safe(() => ZB().screening.paneSummary(item)));
		if (featureOn("appraisalForm")) words.push(safe(() => ZB().appraisalForm.paneSummary(item)));
		let { details, body } = part(doc, "status", words.filter(Boolean).join(" · "));
		// The rows of the modules, each only when its feature is on. A <section>, so the rows stay the
		// first <div>s that hold their own content
		let rows = h(doc, "section", { class: "zb-sp-rows", "data-zb-pane": "tools" });
		if (featureOn("status")) ZB().status.renderPaneRow(doc, rows, item);
		if (featureOn("screening")) ZB().screening.renderPaneRow(doc, rows, item);
		if (featureOn("appraisalForm")) ZB().appraisalForm.renderPaneRow(doc, rows, item);
		if (rows.childNodes.length) body.append(rows);
		if (featureOn("autoClassify")) {
			let chips = safe(() => ZB().classify.itemClassifications(item)) || [];
			if (chips.length) {
				body.append(h(doc, "div", { class: "zb-sp-classified", "data-zb-classified": "" },
					t(doc, "span", "classified", null, { class: "zb-sp-label" }),
					h(doc, "span", { class: "zb-sp-chips" }, ...chips.map(c => h(doc, "span", { class: "zb-sp-chip" }, `${c.folder}：${c.value}`)))));
			}
		}
		// Filled when the literature note has been read
		let synced = h(doc, "p", { class: "zb-sp-hint", hidden: true, "data-zb-synced": "" });
		body.append(synced);
		if (body.childNodes.length === 1) details.hidden = true;
		panel.append(details);
		return { details, synced, alone: body.childNodes.length === 1 };
	}

	// 動作
	function renderActions(ctx, panel) {
		let { doc } = ctx;
		let { details, body } = part(doc, "actions");
		let row = h(doc, "div", { class: "zb-sp-actions" });
		for (let id of ACTIONS) {
			let cmd = C().get(id);
			// Switched off: hidden, as in the toolbar menu and the right-click menus
			if (!cmd || !C().isVisible(cmd)) continue;
			// Nothing to regenerate yet: 「同步」 (and 重點's 「產生 AI 筆記」) make the first one
			if (id === "regenerate" && !ctx.ai) continue;
			row.append(commandButton(ctx, cmd, `cmd-${id}`));
		}
		row.append(commandButton(ctx, C().PALETTE, "cmd-palette"));
		body.append(row);
		panel.append(details);
	}

	/** A button for a catalog command, run on [this item]; a command with variants opens them as a menu. */
	function commandButton(ctx, cmd, name) {
		let { doc, item } = ctx;
		let b = t(doc, "button", name, null, { type: "button", "data-zb-command": cmd.id });
		if (cmd.variants) {
			b.setAttribute("aria-haspopup", "menu");
			listen(b, "click", () => openVariants(ctx, b, cmd));
			return b;
		}
		listen(b, "click", () => {
			b.disabled = true;
			b.setAttribute("aria-busy", "true");
			C().execute(cmd, selectionFor(item)).then(() => {
				if (!alive()) return;
				b.disabled = false;
				b.removeAttribute("aria-busy");
				refreshBody(ctx.body);
			});
		});
		return b;
	}

	/**
	 * The variants of a command (the databases of 在醫學資料庫搜尋) for this item: a native menu under the
	 * button in Zotero, a list of buttons below it where there is no XUL (tests).
	 */
	function openVariants(ctx, button, cmd) {
		let { doc, item } = ctx;
		let sel = selectionFor(item);
		let entries = C().variantEntries(cmd, sel);
		let run = v => C().execute(v, sel);
		if (doc.createXULElement) {
			let popup = xul(doc, "menupopup");
			popup.setAttribute("data-zb-variants", cmd.id);
			for (let v of entries) {
				if (v.separator) {
					popup.append(xul(doc, "menuseparator"));
					continue;
				}
				let mi = xul(doc, "menuitem");
				mi.setAttribute("label", v.label);
				mi.setAttribute("data-l10n-id", v.l10n);
				if (v.args) mi.setAttribute("data-l10n-args", JSON.stringify(v.args));
				listen(mi, "command", () => run(v));
				popup.append(mi);
			}
			popup.addEventListener("popuphidden", (ev) => {
				if (ev.target === popup) popup.remove();
			});
			(doc.querySelector("popupset") || doc.documentElement).append(popup);
			popup.openPopup(button, "after_start", 0, 0, false, false);
			return popup;
		}
		let open = button.nextElementSibling && button.nextElementSibling.hasAttribute("data-zb-variants");
		if (open) {
			button.nextElementSibling.remove();
			button.setAttribute("aria-expanded", "false");
			return null;
		}
		let list = h(doc, "div", { class: "zb-sp-variants", role: "group", "data-zb-variants": cmd.id });
		for (let v of entries) {
			if (v.separator) continue;
			let b = h(doc, "button", { type: "button", "data-zb-variant": v.id }, v.label);
			listen(b, "click", () => run(v));
			list.append(b);
		}
		button.after(list);
		button.setAttribute("aria-expanded", "true");
		return list;
	}

	// 延伸搜尋
	function renderSearch(ctx, panel) {
		if (!featureOn("searchLinks")) return;
		let { doc, item } = ctx;
		let { details, body } = part(doc, "search");
		ZB().searchLinks.renderPaneRow(doc, body, item);
		if (body.childNodes.length) panel.append(details);
	}

	/** The links in 重點 and the sync time in 狀態, once the literature note has been read. */
	function fillLinks(ctx, links, status) {
		let { doc, body, item, count } = ctx;
		let current = () => alive() && renders.get(body) === count;
		Promise.resolve(ZB().main.noteLinks(item)).then((info) => {
			if (!current() || !info) return;
			let link = (name, url, kind) => {
				let b = t(doc, "button", name, null, { class: "zb-sp-link", type: "button", "data-zb-link": kind });
				listen(b, "click", () => Zotero.launchURL(url));
				return b;
			};
			if (info.obsidian) links.append(link("linkObsidian", info.obsidian, "obsidian"));
			if (info.fullText) links.append(link("linkFullText", info.fullText, "fulltext"));
			if (info.notion) links.append(link("linkNotion", info.notion, "notion"));
			links.hidden = !links.childNodes.length;
			if (featureOn("sync")) {
				if (info.lastSynced) status.synced.append(t(doc, "span", "lastSynced", { name: localTime(info.lastSynced) }));
				else if (info.vault && !info.found) status.synced.append(t(doc, "span", "notSynced"));
			}
			status.synced.hidden = !status.synced.childNodes.length;
			if (status.alone && !status.synced.hidden) status.details.hidden = false;
		}).catch(log);
	}

	// ---------- the ⋯ menu in the section header ----------

	/** 快速指令… and ZotMax 設定…, under the header's ⋯ button. */
	function openMoreMenu(props = {}) {
		let anchor = props.event && (props.event.currentTarget || props.event.target);
		let doc = props.doc || (anchor && anchor.ownerDocument) || null;
		let item = targetItem(props.item);
		let sel = item ? selectionFor(item) : C().fromWindow(doc && doc.defaultView, "toolbar");
		if (!doc || !doc.createXULElement || !anchor || typeof anchor.getBoundingClientRect !== "function") {
			return C().execute(C().PALETTE, sel);
		}
		let popup = xul(doc, "menupopup");
		popup.setAttribute("data-zb-more", "");
		for (let [entry, l10n] of [[C().PALETTE, C().PALETTE.l10n], [C().SETTINGS, C().SETTINGS.toolsL10n]]) {
			let mi = xul(doc, "menuitem");
			mi.setAttribute("label", entry === C().SETTINGS ? C().SETTINGS.toolsLabel : entry.label);
			mi.setAttribute("data-l10n-id", l10n);
			mi.setAttribute("data-zb-entry", entry.id);
			listen(mi, "command", () => C().execute(entry, sel));
			popup.append(mi);
		}
		popup.addEventListener("popuphidden", (ev) => {
			if (ev.target === popup) popup.remove();
		});
		(doc.querySelector("popupset") || doc.documentElement).append(popup);
		popup.openPopup(anchor, "after_end", 0, 0, false, false);
		return popup;
	}

	// ---------- refreshing ----------

	/** While the user types in a field of the panel (the 文獻評讀表), a refresh waits for them to leave it. */
	function editing(body) {
		try {
			let a = body.ownerDocument.activeElement;
			return !!a && a !== body && body.contains(a) && /^(input|textarea|select|menulist)$/i.test(a.localName);
		}
		catch (e) {
			return false;
		}
	}

	function refreshBody(body) {
		let entry = bodies.get(body);
		if (editing(body)) {
			if (entry && !entry.waiting) {
				entry.waiting = true;
				body.addEventListener("focusout", function retry() {
					setTimeout(() => {
						if (!alive()) return;
						if (editing(body)) return;
						body.removeEventListener("focusout", retry);
						entry.waiting = false;
						refreshBody(body);
					}, 0);
				});
			}
			return;
		}
		try {
			if (entry && typeof entry.refresh === "function") {
				let r = entry.refresh();
				if (r && r.catch) r.catch(log);
				return;
			}
			let props = lastProps.get(body);
			if (props) render(props);
		}
		catch (e) {
			// A body whose window is gone
			bodies.delete(body);
			Zotero.debug(`ZotMax: panel refresh failed: ${e}`);
		}
	}

	/** Render every shown panel again (after a sync, a command, a switch). */
	function refreshAll() {
		schedule(null);
	}

	/** Refresh the panels showing these items (null: all of them), once things settle. */
	function schedule(ids) {
		if (!alive() || !bodies.size) return;
		if (ids === null) pending.all = true;
		else for (let id of ids) pending.ids.add(id);
		if (refreshTimer) return;
		refreshTimer = setTimeout(flush, REFRESH_DELAY_MS);
	}

	function flush() {
		refreshTimer = null;
		if (!alive()) return;
		let { all, ids } = pending;
		pending = { all: false, ids: new Set() };
		for (let [body, entry] of [...bodies]) {
			if (all || (entry.itemID !== null && ids.has(entry.itemID))) refreshBody(body);
		}
	}

	/** The literature item an ID of a Notifier event belongs to (null: unknown, e.g. already deleted). */
	function ownerOf(id) {
		let it = Zotero.Items.get(Number(id));
		if (!it) return null;
		let target = targetItem(it);
		return target ? target.id : null;
	}

	function onNotify(event, type, ids) {
		if (!bodies.size) return;
		let affected = new Set();
		let all = false;
		for (let raw of ids || []) {
			let id = null;
			if (type === "item") id = ownerOf(raw);
			// "itemID-tagID"
			else if (type === "item-tag") id = ownerOf(String(raw).split("-")[0]);
			// "collectionID-itemID"
			else if (type === "collection-item") id = ownerOf(String(raw).split("-")[1]);
			if (id === null) all = true;
			else affected.add(id);
		}
		schedule(all ? null : affected);
	}

	/** Observers, registered with the first section body (Zotero creates one per item pane). */
	function observe() {
		if (!notifierID && Zotero.Notifier && Zotero.Notifier.registerObserver) {
			notifierID = Zotero.Notifier.registerObserver({
				notify: (event, type, ids, extraData) => {
					if (!alive()) return;
					try {
						onNotify(event, type, ids, extraData);
					}
					catch (e) {
						log(e);
					}
				},
			}, ["item", "item-tag", "collection-item", "collection"], "zotero-bridge-panel");
		}
		if (!prefObservers.length && Zotero.Prefs.registerObserver) {
			let keys = [...ZB().features.prefKeys(), ...WATCHED_PREFS];
			prefObservers = [...new Set(keys)].map(k => Zotero.Prefs.registerObserver(PREF + k, () => schedule(null), true));
		}
	}

	function unobserve() {
		if (notifierID) {
			try {
				Zotero.Notifier.unregisterObserver(notifierID);
			}
			catch (e) {
				log(e);
			}
		}
		notifierID = null;
		for (let o of prefObservers) {
			try {
				Zotero.Prefs.unregisterObserver(o);
			}
			catch (e) {
				log(e);
			}
		}
		prefObservers = [];
		if (refreshTimer) clearTimeout(refreshTimer);
		refreshTimer = null;
		pending = { all: false, ids: new Set() };
	}

	// ---------- registration ----------

	function init(opts = {}) {
		live = true;
		pluginID = opts.pluginID || pluginID;
		rootURI = opts.rootURI || rootURI;
		chromeRegistered = !!opts.chrome;
	}

	/** The section in Zotero's item pane (and the reader's side pane); returns the key Zotero gave it. */
	function register() {
		let icon = rootURI + "content/icons/bridge.svg";
		let more = rootURI + "content/icons/more.svg";
		paneKey = Zotero.ItemPaneManager.registerSection({
			paneID: PANE_ID,
			pluginID,
			header: { l10nID: "zotero-bridge-pane-header", icon, darkIcon: icon },
			sidenav: { l10nID: "zotero-bridge-pane-sidenav", icon, darkIcon: icon },
			sectionButtons: [{
				type: "zotero-bridge-more",
				icon: more,
				darkIcon: more,
				l10nID: "zotero-bridge-pane-more",
				onClick: (props) => {
					if (!alive()) return;
					try {
						openMoreMenu(props);
					}
					catch (e) {
						log(e);
					}
				},
			}],
			onInit: ({ body, refresh }) => {
				if (!alive()) return;
				bodies.set(body, { refresh, itemID: null });
				observe();
			},
			onDestroy: ({ body }) => {
				bodies.delete(body);
			},
			onItemChange: ({ item, setEnabled }) => {
				if (!alive()) return true;
				if (setEnabled) setEnabled(!!targetItem(item));
				return true;
			},
			onRender: (props) => {
				if (!alive()) return;
				try {
					render(props);
				}
				catch (e) {
					log(e);
				}
			},
		}) || null;
		return paneKey;
	}

	function stylesheetURL() {
		return (chromeRegistered ? "chrome://zotero-bridge/" : rootURI) + "content/sidepanel.css";
	}

	/** The panel's stylesheet in a main window (the item pane and the reader's side pane live there). */
	function addStylesheet(win) {
		let doc = win && win.document;
		if (!doc || !doc.documentElement) return null;
		windows.add(win);
		let link = doc.getElementById(STYLE_ID);
		if (link) return link;
		link = doc.createElementNS(HTML_NS, "link");
		link.id = STYLE_ID;
		link.setAttribute("rel", "stylesheet");
		link.setAttribute("href", stylesheetURL());
		doc.documentElement.append(link);
		return link;
	}

	function removeStylesheet(win) {
		if (!win) return;
		windows.delete(win);
		try {
			let link = win.document && win.document.getElementById(STYLE_ID);
			if (link) link.remove();
		}
		catch (e) {}
	}

	/** Unregister the section, the observers and the stylesheets. */
	function shutdown() {
		live = false;
		if (paneKey) {
			try {
				Zotero.ItemPaneManager.unregisterSection(paneKey);
			}
			catch (e) {
				log(e);
			}
		}
		paneKey = null;
		unobserve();
		bodies.clear();
		expanded.clear();
		for (let win of [...windows]) removeStylesheet(win);
	}

	(root.ZB = root.ZB || {}).sidepanel = {
		PANE_ID, STYLE_ID, OPEN_PREF, SUBSECTIONS, ACTIONS, STRINGS,
		init, register, render, refreshAll, addStylesheet, removeStylesheet, shutdown, targetItem, openMoreMenu,
		get paneKey() { return paneKey; },
		get observing() { return { notifier: notifierID, prefs: prefObservers.length, bodies: bodies.size }; },
		get windowCount() { return windows.size; },
	};
})(this);
