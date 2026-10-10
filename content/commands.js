/*
 * ZotMax — the command catalog: one list of everything the plugin can be asked to do.
 *
 * Every surface is generated from it, so a command reads and behaves the same everywhere:
 *   - the toolbar button's menu (toolbar.js): every command, grouped by research workflow
 *   - the item and collection right-click menus (menus.js): one 「ZotMax ▸」 submenu each,
 *     holding the commands whose `menus` name that surface, with the same groups
 *   - the Tools menu (menus.js): 設定…, 快速指令… and the commands marked `tools` (batch entries that
 *     only show while there is something to stop, resume, discard, check or cancel)
 *   - 快速指令, the command palette (palette.js): every command plus 設定精靈… and the settings destinations
 *
 * A command: id, group, l10n (a Fluent message with a .label) and label (its zh-TW text, identical to
 * the FTL), features (switches in features.js; shown while any is on, none = always), needs (what it
 * acts on: "items", "collection", "itemsOrCollection" or null), menus (the right-click surfaces it
 * appears on: "item", "collection"), tools (also in the Tools menu), when() (an extra live
 * condition: a batch to resume, a run to undo), args() (Fluent arguments), keywords (Chinese and
 * English words people search for), and run(sel), or variants (a submenu: decisions, databases).
 *
 * sel, the selection a command runs on, comes from the surface: fromContext() for the right-click
 * menus (MenuManager's context), fromWindow() for the toolbar, the palette and the Tools menu (the
 * main window's selected items and collection). Commands keep each surface's earlier behaviour: the
 * item menu acts on the right-clicked items, the collection menu on the right-clicked collection(s),
 * the toolbar and the palette on the selection, with the plugin's usual 「請先選取文獻。」 when there is
 * nothing suitable.
 *
 * Pure catalog + functions; Zotero is only touched when a command runs or a selection is read, so
 * Node tests can require this file for the catalog and the search.
 */
(function (root, factory) {
	const api = factory(root);
	if (typeof module === "object" && module.exports) {
		module.exports = api;
	}
	else {
		(root.ZB = root.ZB || {}).commands = api;
	}
})(this, function (scope) {
	const PANE_ID = "zotero-bridge-prefs";

	const NEED_ITEMS = "請先選取文獻。";
	const NEED_REVIEW_COLLECTION = "請先在左側選取系統性回顧的分類（回顧專案）。";
	const NEED_COLLECTION = "請先在左側選取分類。";

	/** Workflow groups, in the order of the research workflow (DESIGN.md › Command catalog). */
	const GROUPS = [
		{ id: "sync", l10n: "zotero-bridge-toolbar-group-sync", label: "同步" },
		{ id: "organize", l10n: "zotero-bridge-toolbar-group-organize", label: "整理" },
		{ id: "search", l10n: "zotero-bridge-toolbar-group-search", label: "找文獻" },
		{ id: "appraise", l10n: "zotero-bridge-toolbar-group-appraise", label: "篩選與評讀" },
		{ id: "ai", l10n: "zotero-bridge-toolbar-group-ai", label: "AI 輔助與寫作" },
	];

	function ZB() {
		return scope.ZB;
	}

	function notify(text, headline = "ZotMax") {
		ZB().main.notify(headline, text);
	}

	// ---------- selections ----------

	function collectionsOfRows(rows) {
		return (rows || []).filter(r => r && r.isCollection && r.isCollection()).map(r => r.ref);
	}

	/** The collection selected in the main window (the Tools menu's and the item menu's collection). */
	function activeCollection() {
		try {
			let pane = Zotero.getActiveZoteroPane();
			return (pane && pane.getSelectedCollections && pane.getSelectedCollections()[0]) || null;
		}
		catch (e) {
			return null;
		}
	}

	/**
	 * The selection of a right-click menu (surface "item" or "collection") from MenuManager's context.
	 * Only collectionTreeRows is read: the contexts also define a collectionTreeRow that throws.
	 */
	function fromContext(surface, context) {
		context = context || {};
		let rows = context.collectionTreeRows || [];
		let collections = collectionsOfRows(rows);
		let items = surface === "item" ? (context.items || []) : [];
		let collection = collections[0] || (surface === "item" ? activeCollection() : null);
		return { surface, items, collections, collection, collectionTreeRows: rows, context };
	}

	/** The selection in a main window (surface "toolbar", "palette" or "tools"). */
	function fromWindow(win, surface = "toolbar") {
		let pane = null;
		try {
			pane = (win && win.ZoteroPane) || Zotero.getActiveZoteroPane();
		}
		catch (e) {
			pane = null;
		}
		let items = [];
		let collection = null;
		try {
			items = (pane && pane.getSelectedItems && pane.getSelectedItems()) || [];
		}
		catch (e) {
			items = [];
		}
		try {
			collection = (pane && pane.getSelectedCollections && pane.getSelectedCollections()[0]) || null;
		}
		catch (e) {
			collection = null;
		}
		// The shape MenuManager hands the context-menu entries, for the functions that read it
		let collectionTreeRows = collection ? [{ isCollection: () => true, ref: collection }] : [];
		return { surface, window: win || null, items, collections: collection ? [collection] : [], collection, collectionTreeRows, context: { items, collectionTreeRows } };
	}

	function regular(sel) {
		try {
			return ZB().adapter.toRegularItems(sel.items || []);
		}
		catch (e) {
			return [];
		}
	}

	function itemsInCollections(collections) {
		let items = [];
		for (let c of collections) items.push(...ZB().adapter.itemsInCollection(c, true));
		return items;
	}

	/** The selected literature items, or the plugin's usual message when there are none. */
	function selectedItems(sel) {
		let items = regular(sel);
		if (!items.length) notify(NEED_ITEMS);
		return items;
	}

	/**
	 * What the sync and screening commands act on: the right-clicked items as they are (the modules
	 * skip notes and attachments), a right-clicked collection's items, else the selected literature.
	 */
	function actionItems(sel) {
		if (sel.surface === "item") return sel.items;
		if (sel.surface === "collection") return itemsInCollections(sel.collections);
		return selectedItems(sel);
	}

	/** The collections a collection command acts on (the right-clicked ones, else the selected one). */
	function targetCollections(sel) {
		if (sel.surface === "collection") return sel.collections;
		return sel.collection ? [sel.collection] : [];
	}

	function itemScope(sel) {
		let cols = collectionsOfRows(sel.collectionTreeRows);
		return { label: cols.length ? cols.map(c => c.name).join("、") + "（選取）" : "選取的文獻", collection: null };
	}

	function collectionScope(sel) {
		let cols = sel.collections || [];
		return { label: cols.map(c => c.name).join("、") || "分類", collection: cols[0] || null };
	}

	/**
	 * The AI writing commands: the right-clicked items or collections as from those menus; from the
	 * toolbar or the palette, the selected items, or with no item selected the selected collection.
	 */
	function writingTarget(sel) {
		if (sel.surface === "collection") {
			return { items: itemsInCollections(sel.collections), scope: collectionScope(sel), context: sel.context };
		}
		if (sel.surface === "item") return { items: sel.items, scope: itemScope(sel), context: sel.context };
		if (!regular(sel).length && sel.collection) {
			return {
				items: ZB().adapter.itemsInCollection(sel.collection, true),
				scope: { label: sel.collection.name || "分類", collection: sel.collection },
				context: { items: [], collectionTreeRows: sel.collectionTreeRows },
			};
		}
		return { items: sel.items, scope: itemScope(sel), context: { items: sel.items, collectionTreeRows: sel.collectionTreeRows } };
	}

	// ---------- command helpers ----------

	function sync(action) {
		return (sel) => {
			let items = actionItems(sel);
			// The right-click menus always handed their items over; elsewhere nothing selected says so
			if (!items.length && sel.surface !== "item" && sel.surface !== "collection") return null;
			return ZB().main.run(items, action);
		};
	}

	function screen(change) {
		return (sel) => {
			let items = actionItems(sel);
			if (!items.length && sel.surface !== "item") return null;
			return ZB().screening.setDecision(items, change);
		};
	}

	/** Run fn on each target collection, or say which collection to select. */
	function eachCollection(fn, text = NEED_REVIEW_COLLECTION, headline) {
		return async (sel) => {
			let cols = targetCollections(sel);
			if (!cols.length) {
				notify(text, headline);
				return null;
			}
			for (let c of cols) await fn(c);
			return cols.length;
		};
	}

	function batchStatus() {
		try {
			return ZB().main.batchStatus();
		}
		catch (e) {
			return { running: false, active: false, pending: null, count: 0 };
		}
	}

	function aiBatches() {
		try {
			return ZB().aiBatch.readState().batches;
		}
		catch (e) {
			return [];
		}
	}

	function firstItem(sel) {
		return regular(sel)[0] || null;
	}

	/** 全文：排除 › one entry per exclusion reason from the screening settings. */
	function exclusionReasons() {
		let s = ZB().screening;
		return s.config().reasons.slice(0, s.MAX_MENU_REASONS);
	}

	const BOTH = ["notion", "obsidian"];

	// Keywords shared by commands of one kind
	const KW = {
		sync: ["同步", "sync", "notion", "obsidian", "筆記", "note", "匯出"],
		ai: ["ai", "人工智慧", "claude", "openai", "gpt", "llm"],
		screening: ["篩選", "screening", "screen", "prisma", "系統性回顧", "範圍回顧", "systematic review", "scoping review", "回顧專案"],
	};

	/**
	 * The catalog, in workflow order. Labels are the zh-TW text of the l10n message (test/commands
	 * checks they match the FTL), used for searching and wherever Fluent isn't available.
	 */
	const COMMANDS = [
		// ---------- 同步 ----------
		{ id: "sync", group: "sync", l10n: "zotero-bridge-menu-sync", label: "同步到 Notion + Obsidian（沒有 AI 筆記才產生）",
			features: ["sync"], needs: "items", menus: ["item", "collection"],
			keywords: [...KW.sync, "AI 筆記", "ai note", "文獻筆記", "literature note"],
			run: sync({ targets: BOTH, ai: "missing" }) },
		{ id: "sync-no-ai", group: "sync", l10n: "zotero-bridge-menu-no-ai", label: "同步但不呼叫 AI（沿用既有 AI 筆記）",
			features: ["sync"], needs: "items", menus: ["item", "collection"],
			keywords: [...KW.sync, "不用 AI", "沒有 AI", "no ai", "without ai", "免費"],
			run: sync({ targets: BOTH, ai: "reuse" }) },
		{ id: "sync-obsidian", group: "sync", l10n: "zotero-bridge-menu-obsidian", label: "只同步到 Obsidian",
			features: ["sync"], needs: "items", menus: ["item", "collection"],
			keywords: ["同步", "sync", "obsidian", "vault", "markdown"],
			run: sync({ targets: ["obsidian"], ai: "reuse" }) },
		{ id: "sync-notion", group: "sync", l10n: "zotero-bridge-menu-notion", label: "只同步到 Notion",
			features: ["sync"], needs: "items", menus: ["item", "collection"],
			keywords: ["同步", "sync", "notion", "資料庫", "database"],
			run: sync({ targets: ["notion"], ai: "reuse" }) },
		{ id: "status", group: "sync", l10n: "zotero-bridge-menu-status", label: "同步閱讀狀態",
			features: ["status"], needs: null, menus: [],
			keywords: ["閱讀狀態", "狀態", "status", "reading status", "待讀", "已讀", "閱讀中", "已引用", "read", "to read"],
			run: () => ZB().status.runPass() },
		// Resuming syncs: hidden while 「同步到 Obsidian／Notion」 is off (discarding stays possible)
		{ id: "resume", group: "sync", l10n: "zotero-bridge-menu-resume", label: "繼續未完成的 ZotMax 同步（{ $count } 筆）",
			features: ["sync"], needs: null, menus: [], tools: true,
			when: () => {
				let b = batchStatus();
				return !b.active && b.count > 0;
			},
			args: () => ({ count: batchStatus().count }),
			keywords: ["繼續", "接續", "續傳", "resume", "continue", "未完成", "失敗", "重試", "retry", "同步", "sync"],
			run: () => ZB().main.resumeBatch() },
		{ id: "stop", group: "sync", l10n: "zotero-bridge-menu-stop", label: "停止 ZotMax 同步",
			features: [], needs: null, menus: [], tools: true,
			when: () => batchStatus().running,
			keywords: ["停止", "中止", "取消", "stop", "cancel", "同步", "sync"],
			run: () => ZB().main.cancelBatch() },
		{ id: "discard", group: "sync", l10n: "zotero-bridge-menu-discard", label: "放棄未完成的 ZotMax 同步",
			features: [], needs: null, menus: [], tools: true,
			when: () => {
				let b = batchStatus();
				return !b.active && !!b.pending;
			},
			keywords: ["放棄", "清除", "discard", "clear", "未完成", "同步", "sync"],
			run: () => ZB().main.discardBatch() },

		// ---------- 整理 ----------
		{ id: "classify", group: "organize", l10n: "zotero-bridge-classify-tools", label: "文獻自動分類（所選文獻或目前分類）…",
			features: ["autoClassify"], needs: "itemsOrCollection", menus: ["item", "collection"],
			keywords: ["分類", "自動分類", "子分類", "classify", "classification", "collection", "sub-collection", "subcollection",
				"研究設計", "study design", "pico", "規則", "rules", "主題", "topic", "整理", "organize"],
			run: (sel) => {
				let items;
				if (sel.surface === "item") items = sel.items;
				else if (sel.surface === "collection") items = itemsInCollections(sel.collections);
				else items = sel.items.length ? sel.items : sel.collection ? ZB().adapter.itemsInCollection(sel.collection, true) : [];
				return ZB().classify.run(items);
			} },
		// Not gated: what was applied can always be taken back, also after the switch went off
		{ id: "classify-undo", group: "organize", l10n: "zotero-bridge-classify-undo", label: "復原上次分類",
			features: [], needs: null, menus: [],
			when: () => !!ZB().classify.readLastRun(),
			keywords: ["復原", "還原", "undo", "revert", "分類", "classify", "子分類"],
			run: () => ZB().classify.undoLast() },
		{ id: "dashboard", group: "organize", l10n: "zotero-bridge-menu-dashboard", label: "更新研究儀表板",
			features: ["dashboard"], needs: null, menus: [],
			keywords: ["儀表板", "dashboard", "進度", "progress", "待讀", "統計", "statistics", "obsidian"],
			run: () => ZB().dashboard.runFromMenu() },
		{ id: "concepts", group: "organize", l10n: "zotero-bridge-menu-concepts-update", label: "更新概念卡片",
			features: ["concepts"], needs: null, menus: [],
			keywords: ["概念", "概念卡片", "concept", "concepts", "卡片", "card", "索引", "index", "mesh", "wikilink"],
			run: () => ZB().concepts.runFromMenu() },
		{ id: "bibliography", group: "organize", l10n: "zotero-bridge-menu-export-library", label: "匯出參考文獻到 Obsidian",
			features: ["bibliography"], needs: null, menus: [],
			keywords: ["參考文獻", "references", "references.json", "bibliography", "csl", "json", "bibtex", "bib", "pandoc", "citekey", "匯出", "export", "引用", "citation", "apa"],
			run: () => ZB().bibliography.exportLibrary() },
		{ id: "export-collection", group: "organize", l10n: "zotero-bridge-cmd-export-collection", label: "匯出目前分類的參考文獻",
			features: ["bibliography"], needs: "collection", menus: ["collection"],
			keywords: ["參考文獻", "references", "bibliography", "csl", "json", "bibtex", "bib", "pandoc", "citekey", "匯出", "export", "引用", "citation"],
			run: async (sel) => {
				let cols = targetCollections(sel);
				if (!cols.length) {
					notify(NEED_COLLECTION);
					return null;
				}
				return ZB().bibliography.exportCollections(cols);
			} },
		// 中文文獻補強 (zh-meta.js): the selected items, else the selected collection's
		{ id: "zh-meta", group: "organize", l10n: "zotero-bridge-cmd-zh-meta", label: "檢查中文文獻資料（選取項目或分類）…",
			features: ["zhMeta"], needs: "itemsOrCollection", menus: ["item", "collection"],
			keywords: ["中文文獻", "中文", "補強", "檢查", "資料", "華藝", "airiti", "博碩士", "ndltd", "民國", "卷期", "頁碼", "doi", "作者", "姓名",
				"語言", "zh-tw", "apa", "metadata", "chinese", "fix", "check"],
			run: (sel) => {
				let items;
				if (sel.surface === "item") items = sel.items;
				else if (sel.surface === "collection") items = itemsInCollections(sel.collections);
				else items = regular(sel).length ? sel.items : sel.collection ? ZB().adapter.itemsInCollection(sel.collection, true) : [];
				return ZB().zhMeta.run(items);
			} },
		// Not gated: what was applied can always be taken back, also after the switch went off
		{ id: "zh-meta-undo", group: "organize", l10n: "zotero-bridge-cmd-zh-meta-undo", label: "復原上一次中文文獻修正",
			features: [], needs: null, menus: [],
			when: () => !!ZB().zhMeta.readLastRun(),
			keywords: ["復原", "還原", "undo", "revert", "中文文獻", "補強", "修正", "chinese"],
			run: () => ZB().zhMeta.undoLast() },

		// ---------- 找文獻 ----------
		{ id: "quick-search", group: "search", l10n: "zotero-bridge-search-tools", label: "醫學文獻快速搜尋…",
			features: ["searchLinks"], needs: null, menus: [],
			keywords: ["搜尋", "快速搜尋", "search", "quick search", "關鍵字", "keyword", "mesh", "pubmed", "cinahl", "cochrane", "華藝", "資料庫", "database"],
			run: () => ZB().searchLinks.quickSearch() },
		{ id: "search-item", group: "search", l10n: "zotero-bridge-search-menu", label: "在醫學資料庫搜尋",
			features: ["searchLinks"], needs: "items", menus: ["item"],
			// The item menu shows it only for a literature item, as before
			menuWhen: sel => !!firstItem(sel),
			keywords: ["搜尋", "資料庫", "search", "database", "pubmed", "cinahl", "cochrane", "embase", "華藝", "airiti", "google scholar", "相似文獻", "similar", "related"],
			variants: [
				{ id: "search-db", l10n: "zotero-bridge-search-db", label: "{ $name }", max: 8,
					list: (sel) => {
						let item = firstItem(sel);
						return item ? ZB().searchLinks.menuTargets(item).map((t, i) => ({
							key: String(i),
							args: { name: t.copy ? `${t.name}（複製標題）` : t.name },
							run: () => ZB().searchLinks.openTarget(t),
						})) : [];
					} },
				{ id: "search-related", l10n: "zotero-bridge-search-related", label: "PubMed 相似文獻", max: 1,
					keywords: ["similar articles", "related", "相似"],
					list: (sel) => {
						let item = firstItem(sel);
						let url = item ? ZB().searchLinks.relatedFor(item) : null;
						return url ? [{ key: "related", run: () => ZB().searchLinks.runtime.launch(url) }] : [];
					} },
				{ separator: true },
				{ id: "search-more", l10n: "zotero-bridge-search-more", label: "更多資料庫…",
					keywords: ["more", "更多"],
					run: (sel) => {
						let item = firstItem(sel);
						if (!item) {
							notify(NEED_ITEMS);
							return null;
						}
						return ZB().searchLinks.showMore(item);
					} },
			] },
		{ id: "pubmed-watch", group: "search", l10n: "zotero-bridge-menu-pubmed-watch", label: "檢查新文獻（PubMed 追蹤）",
			features: ["pubmedWatch"], needs: null, menus: [],
			keywords: ["pubmed", "新文獻", "追蹤", "watch", "alert", "new articles", "檢索式", "query", "訂閱"],
			run: () => ZB().pubmedWatch.runAll() },
		// chaseItems shows its own message when nothing is selected
		{ id: "chase-items", group: "search", l10n: "zotero-bridge-toolbar-chase-items", label: "引文追蹤所選文獻（OpenAlex）",
			features: ["citationChase"], needs: "items", menus: ["item"],
			keywords: ["引文追蹤", "引文", "citation", "chase", "chasing", "snowball", "滾雪球", "openalex", "參考文獻", "被引用", "cited by", "references"],
			run: sel => ZB().citationChase.chaseItems(sel.items, sel.collection) },
		{ id: "chase-included", group: "search", l10n: "zotero-bridge-chase-tools-included", label: "引文追蹤：目前分類全文納入的研究",
			features: ["citationChase"], needs: "collection", menus: ["collection"],
			keywords: ["引文追蹤", "引文", "citation", "chase", "chasing", "snowball", "滾雪球", "openalex", "納入", "included", "回顧專案"],
			run: async (sel) => {
				let c = targetCollections(sel)[0];
				if (!c) {
					notify(NEED_REVIEW_COLLECTION, "ZotMax：引文追蹤");
					return null;
				}
				return ZB().citationChase.chaseCollection(c);
			} },
		// Without a selected collection (toolbar, palette): the 「所選文獻」 note, imported into My Library
		{ id: "chase-import", group: "search", l10n: "zotero-bridge-chase-tools-import", label: "匯入引文追蹤勾選的文獻",
			features: ["citationChase"], needs: null, menus: ["collection"],
			keywords: ["引文追蹤", "citation", "chase", "匯入", "import", "勾選", "候選", "candidates", "openalex"],
			run: async (sel) => {
				let c = targetCollections(sel)[0] || null;
				if (!c && sel.surface === "collection") {
					notify(NEED_REVIEW_COLLECTION, "ZotMax：引文追蹤");
					return null;
				}
				return ZB().citationChase.importChecked(c);
			} },

		// ---------- 篩選與評讀 ----------
		{ id: "screen", group: "appraise", l10n: "zotero-bridge-toolbar-screen", label: "篩選所選文獻",
			features: ["screening"], needs: "items", menus: ["item"],
			keywords: [...KW.screening, "納入", "排除", "include", "exclude", "標題摘要", "全文", "title abstract", "full text", "決定", "decision"],
			variants: [
				{ id: "screen-ta-include", l10n: "zotero-bridge-screen-ta-include", label: "標題摘要：納入", keywords: ["include", "納入"], run: screen({ stage: "ta", decision: "include" }) },
				{ id: "screen-ta-exclude", l10n: "zotero-bridge-screen-ta-exclude", label: "標題摘要：排除", keywords: ["exclude", "排除"], run: screen({ stage: "ta", decision: "exclude" }) },
				{ id: "screen-ta-maybe", l10n: "zotero-bridge-screen-ta-maybe", label: "標題摘要：待定", keywords: ["maybe", "待定", "不確定"], run: screen({ stage: "ta", decision: "maybe" }) },
				{ separator: true },
				{ id: "screen-ft-include", l10n: "zotero-bridge-screen-ft-include", label: "全文：納入", keywords: ["include", "納入", "full text"], run: screen({ stage: "ft", decision: "include" }) },
				// Flat, one entry per reason from the settings, so the menu stays two levels deep
				{ id: "screen-ft-exclude", l10n: "zotero-bridge-cmd-screen-ft-exclude-reason", label: "全文：排除（{ $reason }）",
					keywords: ["exclude", "排除", "原因", "reason", "full text"], max: 20,
					list: () => exclusionReasons().map(reason => ({
						key: reason,
						args: { reason },
						run: screen({ stage: "ft", decision: "exclude", reason }),
					})) },
				{ id: "screen-ft-not-retrieved", l10n: "zotero-bridge-screen-ft-not-retrieved", label: "全文：無法取得全文", keywords: ["not retrieved", "無法取得", "全文"], run: screen({ stage: "ft", decision: "notRetrieved" }) },
				{ separator: true },
				{ id: "screen-duplicate", l10n: "zotero-bridge-screen-duplicate", label: "標記為重複", keywords: ["duplicate", "重複"], run: screen({ duplicate: true }) },
				{ id: "screen-clear", l10n: "zotero-bridge-screen-clear", label: "清除篩選決定", keywords: ["clear", "清除", "重設", "reset"], run: screen({ clear: true }) },
			] },
		{ id: "dedup", group: "appraise", l10n: "zotero-bridge-screen-tools-dedup", label: "找出目前分類中可能重複的文獻",
			features: ["screening"], needs: "collection", menus: ["collection"],
			keywords: ["重複", "去重", "duplicate", "duplicates", "dedup", "deduplicate", ...KW.screening],
			run: eachCollection(c => ZB().screening.dedupCollection(c)) },
		{ id: "prisma", group: "appraise", l10n: "zotero-bridge-screen-tools-prisma", label: "產生 PRISMA 流程圖與證據表（目前分類）",
			features: ["screening"], needs: "collection", menus: ["collection"],
			keywords: ["prisma", "prisma 2020", "流程圖", "flow diagram", "flowchart", "證據表", "evidence table", "篩選", "screening", "系統性回顧", "systematic review", "回顧專案"],
			run: eachCollection(c => ZB().screening.generateReport(c)) },
		{ id: "appraisal-summary", group: "appraise", l10n: "zotero-bridge-appraisal-tools-summary", label: "匯出文獻評讀總表（目前分類）",
			features: ["appraisalForm"], needs: "collection", menus: ["collection"],
			keywords: ["評讀", "評讀總表", "評讀表", "appraisal", "critical appraisal", "casp", "jbi", "品質", "quality", "kappa", "一致性", "總表", "summary"],
			// exportCollections says 「請先在左側選取分類。」 when there is none
			run: sel => ZB().appraisalForm.exportCollections(targetCollections(sel)) },
		// Disabled (not hidden) until the user answered every item themselves: blocked() says why
		{ id: "appraisal-coach", group: "appraise", l10n: "zotero-bridge-cmd-appraisal-coach", label: "評讀陪練：對照 AI",
			features: ["appraisalCoach"], needs: "items", menus: ["item"],
			keywords: [...KW.ai, "評讀陪練", "陪練", "對照", "評讀", "評讀表", "appraisal", "critical appraisal", "coach", "casp", "jbi", "compare", "second opinion", "練習"],
			blocked: sel => ZB().appraisalCoach.blockedReason(firstItem(sel)),
			run: sel => ZB().appraisalCoach.runFromCommand(sel.items) },

		// ---------- AI 輔助與寫作 ----------
		{ id: "regenerate", group: "ai", l10n: "zotero-bridge-menu-regenerate", label: "重新產生 AI 筆記並同步",
			features: ["aiNotes"], needs: "items", menus: ["item", "collection"],
			keywords: [...KW.ai, "重新產生", "regenerate", "redo", "ai 筆記", "ai note", "文獻筆記", "同步", "sync"],
			run: sync({ targets: BOTH, ai: "regenerate" }) },
		// The writing commands bring their own messages (「…至少需要 2 篇文獻。」)
		{ id: "synthesis", group: "ai", l10n: "zotero-bridge-menu-synthesis", label: "產生文獻比較表（AI）",
			features: ["synthesis"], needs: "itemsOrCollection", menus: ["item", "collection"],
			keywords: [...KW.ai, "比較表", "文獻比較", "synthesis", "comparison", "matrix", "table", "研究缺口", "gap", "主題整理", "themes"],
			run: (sel) => {
				let t = writingTarget(sel);
				return ZB().main.runSynthesis(t.items, t.scope);
			} },
		{ id: "review-draft", group: "ai", l10n: "zotero-bridge-menu-review-draft", label: "產生文獻探討草稿（AI）",
			features: ["reviewDraft"], needs: "itemsOrCollection", menus: ["item", "collection"],
			keywords: [...KW.ai, "文獻探討", "文獻回顧", "第二章", "literature review", "review draft", "草稿", "draft", "論文", "thesis", "chapter 2"],
			run: (sel) => {
				let t = writingTarget(sel);
				return ZB().reviewDraft.run(t.items, t.scope, t.context);
			} },
		{ id: "ebhc-report", group: "ai", l10n: "zotero-bridge-menu-ebhc-report", label: "產生實證健康照護報告草稿（AI）",
			features: ["ebhcReport"], needs: "itemsOrCollection", menus: ["item", "collection"],
			keywords: [...KW.ai, "實證", "實證報告", "ebhc", "ebp", "evidence-based", "evidence based", "護理學會", "twna", "報告", "report", "草稿", "draft", "pico"],
			run: (sel) => {
				let t = writingTarget(sel);
				return ZB().ebhcReport.run(t.items, t.scope, t.context);
			} },
		{ id: "progress-report", group: "ai", l10n: "zotero-bridge-menu-progress-report", label: "產生進度報告（給指導教授）",
			features: ["progressReport"], needs: null, menus: [],
			keywords: ["進度", "進度報告", "progress", "progress report", "指導教授", "advisor", "supervisor", "meeting", "會議", "meeting notes"],
			run: () => ZB().progressReport.run() },
		{ id: "concepts-ai", group: "ai", l10n: "zotero-bridge-menu-concepts-ai", label: "為概念卡片產生 AI 綜整…",
			features: ["conceptsAI"], needs: null, menus: [],
			keywords: [...KW.ai, "概念", "概念卡片", "concept", "綜整", "synthesis", "summary"],
			run: () => ZB().concepts.synthesizeFromMenu() },
		// The text selected in the PDF reader (its selection popup has the same as a button)
		{ id: "explain-stats", group: "ai", l10n: "zotero-bridge-cmd-explain-stats", label: "解釋所選統計",
			features: ["statsExplainer"], needs: null, menus: [],
			keywords: [...KW.ai, "讀懂統計", "統計", "statistics", "解釋", "explain", "odds ratio", "信賴區間", "confidence interval", "p 值", "p value", "效果量", "effect size", "pdf"],
			run: sel => ZB().statsExplainer.explainCurrentSelection(sel && sel.window) },
		// Like the Tools entries: only while batches are pending
		{ id: "ai-batch-check", group: "ai", l10n: "zotero-bridge-menu-ai-batch-check", label: "檢查 AI 批次進度",
			features: [], needs: null, menus: [], tools: true,
			when: () => aiBatches().length > 0,
			keywords: [...KW.ai, "批次", "batch", "進度", "progress", "檢查", "check", "status"],
			run: () => ZB().aiBatch.check({ manual: true }) },
		{ id: "ai-batch-cancel", group: "ai", l10n: "zotero-bridge-menu-ai-batch-cancel", label: "取消 AI 批次",
			features: [], needs: null, menus: [], tools: true,
			when: () => aiBatches().some(b => b.status !== "ended"),
			keywords: [...KW.ai, "批次", "batch", "取消", "cancel", "停止", "stop"],
			run: () => ZB().aiBatch.cancelAll() },
	];

	/** Outside the groups: the first and the last entry of the toolbar menu, and the Tools menu. */
	const PALETTE = { id: "palette", l10n: "zotero-bridge-cmd-palette", label: "快速指令…", toolsL10n: "zotero-bridge-menu-palette",
		toolsLabel: "ZotMax 快速指令…", features: [], needs: null, menus: [],
		keywords: ["快速指令", "指令", "command", "palette", "搜尋功能"],
		run: sel => ZB().palette.open(sel && sel.window) };
	const SETTINGS = { id: "settings", l10n: "zotero-bridge-toolbar-settings", label: "設定…", toolsL10n: "zotero-bridge-menu-settings",
		toolsLabel: "ZotMax 設定…", features: [], needs: null, menus: [],
		keywords: ["設定", "偏好", "settings", "preferences", "options"],
		run: () => openSettings() };
	/**
	 * 設定精靈… (setup.js): never switched off, so a new user can always get back to it. In the toolbar
	 * menu next to 設定…, in 快速指令 at the top of the 設定 group.
	 */
	const SETUP = { id: "setup-wizard", l10n: "zotero-bridge-cmd-setup-wizard", label: "設定精靈…", features: [], needs: null, menus: [],
		keywords: ["設定精靈", "精靈", "首次設定", "第一次", "入門", "開始使用", "setup", "wizard", "onboarding", "getting started", "first run"],
		run: sel => ZB().setup.open(sel && sel.window) };

	/**
	 * Settings destinations (快速指令 results 「設定：…」): the sections of the settings pane by their
	 * stable IDs (the pane's data-zb-section; "sync" is the 同步 tab); features: the switches that
	 * show the section (any of them).
	 */
	const SECTIONS = [
		{ id: "features", label: "功能", features: [], keywords: ["功能", "開關", "features", "switch", "preset", "研究生引導", "進階", "模式", "mode", "toolbar", "工具列"] },
		{ id: "sync", label: "同步", features: ["sync"], keywords: ["同步", "sync", "筆記", "notes"] },
		{ id: "obsidian", label: "Obsidian", features: ["sync"], keywords: ["obsidian", "vault", "資料夾", "folder", "檔名", "filename", "base"] },
		{ id: "notion", label: "Notion", features: ["sync", "screening", "progressReport", "synthesis"], keywords: ["notion", "token", "資料庫", "database", "欄位", "columns"] },
		{ id: "routing", label: "分流規則", features: ["sync"], keywords: ["分流", "規則", "routing", "rules", "文獻庫", "library"] },
		{ id: "autosync", label: "自動同步", features: ["sync"], keywords: ["自動同步", "auto sync", "automatic", "自動"] },
		{ id: "status", label: "閱讀狀態", features: ["status"], keywords: ["閱讀狀態", "status", "待讀", "已讀"] },
		{ id: "apaZh", label: "中文 APA", features: ["apaZh"], keywords: ["apa", "中文", "chinese", "引用格式", "citation style"] },
		{ id: "bibliography", label: "參考文獻檔", features: ["bibliography"], keywords: ["參考文獻", "references", "bibtex", "csl", "pandoc"] },
		{ id: "concepts", label: "概念卡片", features: ["concepts"], keywords: ["概念", "concept", "卡片"] },
		{ id: "fulltext", label: "全文筆記", features: ["fullTextMarkdown"], keywords: ["全文", "full text", "markdown", "markitdown", "pdf"] },
		{ id: "colors", label: "劃線顏色與意義", features: ["sync"], keywords: ["顏色", "劃線", "highlight", "color", "colour", "annotation", "標註"] },
		{ id: "classify", label: "文獻自動分類", features: ["autoClassify"], keywords: ["分類", "classify", "規則", "rules", "主題", "topics", "pico"] },
		{ id: "searchLinks", label: "醫學文獻快速搜尋", features: ["searchLinks"], keywords: ["搜尋", "search", "資料庫", "database", "ezproxy", "proxy", "mesh"] },
		{ id: "ncbi", label: "NCBI（PubMed）連線", features: ["pubmedWatch", "searchLinks"], keywords: ["ncbi", "pubmed", "api key", "email", "e-utilities"] },
		{ id: "pubmedWatch", label: "PubMed 新文獻追蹤", features: ["pubmedWatch"], keywords: ["pubmed", "追蹤", "watch", "新文獻", "檢索式"] },
		{ id: "citationChase", label: "引文追蹤", features: ["citationChase"], keywords: ["引文追蹤", "citation", "openalex"] },
		{ id: "screening", label: "篩選", features: ["screening"], keywords: ["篩選", "screening", "prisma", "排除原因", "exclusion reasons"] },
		{ id: "ai", label: "AI 服務", features: ["aiNotes", "aiBatch", "synthesis", "reviewDraft", "ebhcReport", "progressReport", "conceptsAI"],
			keywords: ["ai", "api key", "claude", "openai", "anthropic", "模型", "model", "提示詞", "prompt"] },
		{ id: "usage", label: "本月 AI 用量", features: ["aiNotes", "aiBatch", "synthesis", "reviewDraft", "ebhcReport", "progressReport", "conceptsAI"],
			keywords: ["用量", "費用", "usage", "cost", "token", "花費"] },
	];
	for (let s of SECTIONS) {
		// aiBatch → ai-batch, pubmedWatch → pubmed-watch
		s.l10n = `zotero-bridge-section-${s.id.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()}`;
	}

	const BY_ID = new Map();
	for (let c of [...COMMANDS, PALETTE, SETTINGS, SETUP]) {
		c.features = c.features || [];
		c.menus = c.menus || [];
		BY_ID.set(c.id, c);
		for (let v of c.variants || []) {
			if (v.separator) continue;
			v.parent = c;
			BY_ID.set(v.id, v);
		}
	}

	function get(id) {
		return BY_ID.get(id) || null;
	}

	function commandOf(entry) {
		return (entry && entry.parent) || entry;
	}

	// ---------- gating ----------

	/** On while any of its switches is on (none: always), like features.gateMenus. */
	function featureOn(entry) {
		let features = commandOf(entry).features;
		if (!features.length) return true;
		let F = ZB() && ZB().features;
		return !F || features.some(id => F.isEnabled(id));
	}

	/** The switch to turn on so a switched-off entry works (its own, else what it requires). */
	function featureToTurnOn(features) {
		let F = ZB() && ZB().features;
		if (!F || !features.length || features.some(id => F.isEnabled(id))) return null;
		let walk = (id, seen) => {
			if (seen.has(id)) return null;
			seen.add(id);
			if (!F.rawValue(id)) return id;
			for (let r of F.get(id).requires) {
				if (!F.isEnabled(r)) return walk(r, seen) || r;
			}
			return null;
		};
		return walk(features[0], new Set()) || features[0];
	}

	/** Shown right now (toolbar, palette): its switch is on and its condition holds. Never throws. */
	function isVisible(entry) {
		try {
			let c = commandOf(entry);
			return featureOn(c) && (!c.when || !!c.when());
		}
		catch (e) {
			if (typeof Zotero !== "undefined") Zotero.logError(e);
			return false;
		}
	}

	/** Shown in a right-click menu with this selection. */
	function isVisibleIn(entry, sel) {
		let c = commandOf(entry);
		if (!isVisible(c)) return false;
		try {
			return !c.menuWhen || !!c.menuWhen(sel);
		}
		catch (e) {
			Zotero.logError(e);
			return false;
		}
	}

	/** Has what it acts on in this selection. */
	function hasTarget(needs, sel) {
		if (!needs) return true;
		let items = regular(sel).length > 0;
		let collection = !!(sel.collection || (sel.collections && sel.collections.length));
		if (needs === "items") return items;
		if (needs === "collection") return collection;
		return items || collection;
	}

	/**
	 * Can it run right now? { ok } or { ok: false, reason: "off", feature } (switched off: which
	 * switch to turn on) or { ok: false, reason: "items" | "collection" | "itemsOrCollection" }.
	 */
	function availability(entry, sel) {
		let c = commandOf(entry);
		let feature = featureToTurnOn(c.features);
		if (feature) return { ok: false, reason: "off", feature };
		if (!hasTarget(c.needs, sel || {})) return { ok: false, reason: c.needs };
		return { ok: true };
	}

	/** Commands of a group that appear on a surface: "toolbar"/"palette" (all), "item", "collection". */
	function groupCommands(groupID, surface) {
		return COMMANDS.filter(c => c.group === groupID && (surface === "toolbar" || surface === "palette" || c.menus.includes(surface)));
	}

	/**
	 * The entries of a command with variants for a selection: static ones as they are, list ones
	 * expanded ({ id, l10n, args, label, run, variant }); separators as { separator: true }.
	 */
	function variantEntries(cmd, sel) {
		let out = [];
		for (let v of cmd.variants || []) {
			if (v.separator) {
				out.push({ separator: true });
				continue;
			}
			if (!v.list) {
				out.push({ id: v.id, l10n: v.l10n, label: v.label, args: null, run: v.run, variant: v });
				continue;
			}
			let list = [];
			try {
				list = v.list(sel).slice(0, v.max);
			}
			catch (e) {
				Zotero.logError(e);
			}
			for (let leaf of list) {
				out.push({ id: `${v.id}:${leaf.key}`, l10n: v.l10n, label: fillLabel(v.label, leaf.args), args: leaf.args || null, run: leaf.run, variant: v });
			}
		}
		return out;
	}

	function fillLabel(text, args) {
		return String(text).replace(/\{ \$(\w+) \}/g, (m, k) => (args && args[k] !== undefined ? String(args[k]) : m));
	}

	// ---------- running ----------

	/**
	 * Run a command or variant on a selection (default: the main window's); errors are logged, never
	 * thrown at the menu. Returns the command's promise. Whether it may run (switch, condition) is the
	 * surface's decision: the toolbar and the menus only show what applies, the palette checks first.
	 */
	function execute(entryOrID, sel) {
		let entry = typeof entryOrID === "string" ? get(entryOrID) : entryOrID;
		if (!entry || typeof entry.run !== "function") {
			Zotero.logError(new Error(`ZotMax: no command ${entryOrID && (entryOrID.id || entryOrID)}`));
			return Promise.resolve(null);
		}
		sel = sel || fromWindow(null, "toolbar");
		// Started right away, like the menu entries before: work a command queues keeps its place
		try {
			return Promise.resolve(entry.run(sel)).catch((e) => {
				Zotero.logError(e);
				return null;
			});
		}
		catch (e) {
			Zotero.logError(e);
			return Promise.resolve(null);
		}
	}

	const PENDING_SECTION_PREF = "extensions.zotero-bridge.prefs.pendingSection";

	/**
	 * Open Zotero's settings at the ZotMax pane, at a section (or tab) when one is named: the
	 * pane reads prefs.pendingSection when it loads, while it is open and when it is shown again, and
	 * sends a switched-off section to its switch on 功能. Returns the settings window.
	 */
	function openSettings(sectionID) {
		if (sectionID) Zotero.Prefs.set(PENDING_SECTION_PREF, sectionID, true);
		return Zotero.Utilities.Internal.openPreferences(PANE_ID);
	}

	// ---------- 快速指令: the palette's entries and search ----------

	/**
	 * Everything the palette offers for a selection: commands (variants as their own results, labelled
	 * 「parent › variant」), then 設定精靈… and the settings destinations. Conditional commands appear only while
	 * their condition holds; switched-off ones appear with the reason, so they can be found.
	 * Entry: { id, kind, group, l10n, args, label, parentL10n, parentLabel, keywords, availability, run, section, name }.
	 */
	function paletteEntries(sel) {
		let out = [];
		for (let g of GROUPS) {
			for (let c of groupCommands(g.id, "palette")) {
				let when = true;
				try {
					when = !c.when || !!c.when();
				}
				catch (e) {
					when = false;
				}
				if (!when) continue;
				let avail = availability(c, sel);
				let base = { kind: "command", group: g.id, keywords: c.keywords || [], availability: avail, command: c };
				if (!c.variants) {
					out.push(Object.assign({}, base, { id: c.id, l10n: c.l10n, args: c.args ? safeArgs(c) : null, label: c.label, run: c.run }));
					continue;
				}
				let leaves = avail.ok ? variantEntries(c, sel).filter(v => !v.separator) : [];
				if (!leaves.length) {
					// Nothing to pick yet (switched off, nothing selected): the command itself, with the reason
					out.push(Object.assign({}, base, { id: c.id, l10n: c.l10n, args: null, label: c.label, run: null }));
					continue;
				}
				for (let leaf of leaves) {
					out.push(Object.assign({}, base, {
						id: leaf.id, l10n: leaf.l10n, args: leaf.args, label: leaf.label, run: leaf.run,
						parentL10n: c.l10n, parentLabel: c.label,
						keywords: [...(c.keywords || []), ...((leaf.variant && leaf.variant.keywords) || [])],
					}));
				}
			}
		}
		// 設定精靈… first in the 設定 group: always runnable
		out.push({ id: SETUP.id, kind: "command", group: "settings", l10n: SETUP.l10n, args: null, label: SETUP.label,
			keywords: SETUP.keywords, availability: { ok: true }, command: SETUP, run: SETUP.run });
		for (let s of SECTIONS) {
			let feature = featureToTurnOn(s.features);
			out.push({
				id: `settings:${s.id}`, kind: "settings", group: "settings", section: s.id, l10n: s.l10n, args: null,
				label: `設定：${s.label}`, name: s.label,
				keywords: [...s.keywords, "設定", "settings"],
				availability: feature ? { ok: false, reason: "off", feature } : { ok: true },
				run: () => openSettings(s.id),
			});
		}
		return out;
	}

	function safeArgs(c) {
		try {
			return c.args();
		}
		catch (e) {
			return null;
		}
	}

	/** Case-, width- and space-insensitive text: NFKC folds full-width letters and punctuation. */
	function normalize(s) {
		// Fluent wraps arguments in bidi isolation marks
		return String(s || "").normalize("NFKC").replace(/[\u2068\u2069]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
	}

	/** Characters of `term` in order inside `text`: a score from the tightness of the match, else 0. */
	function subsequence(term, text) {
		let start = -1;
		let pos = -1;
		for (let ch of term) {
			pos = text.indexOf(ch, pos + 1);
			if (pos === -1) return 0;
			if (start === -1) start = pos;
		}
		let span = pos - start + 1;
		return 10 + Math.round(20 * term.length / span);
	}

	function termScore(term, text) {
		if (!text) return 0;
		if (text === term) return 100;
		if (text.startsWith(term)) return 80;
		let i = text.indexOf(term);
		if (i > 0) return /[\s(（:：/／›・,，、-]/.test(text[i - 1]) ? 70 : 60;
		return term.length > 1 ? subsequence(term, text) : 0;
	}

	/**
	 * Rank entries for a query. texts(entry) gives what to match: { label, keywords, group } (already
	 * localized where Fluent is available). Every word of the query has to match somewhere (label
	 * counts most, then keywords, then the group); a label the query covers more of ranks higher, a
	 * settings destination a little lower than a command; ties keep the catalog order, runnable before
	 * switched off. An empty query keeps everything in catalog order.
	 */
	function search(entries, query, texts = e => ({ label: e.label, keywords: e.keywords, group: "" })) {
		let terms = normalize(query).split(" ").filter(Boolean);
		if (!terms.length) return entries.slice();
		let scored = [];
		entries.forEach((entry, index) => {
			let t = texts(entry);
			let label = normalize(t.label);
			let keywords = (t.keywords || []).map(normalize);
			let group = normalize(t.group);
			let total = 0;
			let covered = 0;
			for (let term of terms) {
				let best = Math.max(
					termScore(term, label) * 3,
					...keywords.map(k => termScore(term, k) * 2),
					termScore(term, group),
				);
				if (!best) return;
				total += best;
				if (label.includes(term)) covered += term.length;
			}
			total += label ? Math.round(20 * covered / label.length) : 0;
			if (entry.kind === "settings") total *= 0.9;
			let off = entry.availability && entry.availability.reason === "off" ? 1 : 0;
			scored.push({ entry, total, off, index });
		});
		scored.sort((a, b) => b.total - a.total || a.off - b.off || a.index - b.index);
		return scored.map(s => s.entry);
	}

	return {
		PANE_ID, GROUPS, COMMANDS, PALETTE, SETTINGS, SETUP, SECTIONS, NEED_ITEMS, NEED_COLLECTION, NEED_REVIEW_COLLECTION,
		get, groupCommands, variantEntries, fillLabel,
		fromContext, fromWindow, writingTarget, actionItems,
		featureOn, featureToTurnOn, isVisible, isVisibleIn, availability, hasTarget,
		execute, openSettings, PENDING_SECTION_PREF,
		paletteEntries, normalize, search,
	};
});
