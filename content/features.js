/*
 * ZotMax — feature switches and presets.
 *
 * Every feature has one on/off pref. Features that already had an enable pref keep it as the single
 * source of truth (llm.enabled, status.enabled, apaZh.enabled, llm.batchAPI, images.export); the
 * others use extensions.zotero-bridge.feature.<id>. Two presets set all switches at once:
 *
 *   guided   研究生引導 (new installs): finding literature and writing are left to the user, so the
 *            PubMed watch, citation chasing and the AI writing drafts start off
 *   advanced 進階: everything on
 *
 * The current preset is derived from the switches ("custom" when they match neither). Gating is
 * live: menus hide through onShowing (gateMenus), background work checks isEnabled() each time.
 *
 * Existing installs keep their behaviour: migrate() runs once at startup and, when the profile shows
 * earlier use (a vault, a Notion database, AI usage…), turns the new switches on (advanced) while the
 * prefs that existed before keep the values the user gave them (the batch API, off by default, is
 * turned on unless the user set it). A fresh profile stays on the guided defaults. Switches added in a
 * later version (features.version) are turned on for profiles already on 進階, and stay at their
 * defaults otherwise.
 *
 * Pure catalog + functions over a prefs accessor, so Node tests can require this file.
 */
(function (root, factory) {
	const api = factory(root);
	if (typeof module === "object" && module.exports) {
		module.exports = api;
	}
	else {
		(root.ZB = root.ZB || {}).features = api;
	}
})(this, function (scope) {
	const PREF = "extensions.zotero-bridge.";
	// Bumped when a later version needs another one-time migration (see MIGRATIONS)
	const MIGRATION_PREF = "features.version";
	const MIGRATION_VERSION = 4;

	const GROUPS = [
		{ id: "organize", label: "整理與同步", l10n: "zotero-bridge-feature-group-organize" },
		{ id: "search", label: "找文獻", l10n: "zotero-bridge-feature-group-search" },
		{ id: "appraise", label: "篩選與評讀", l10n: "zotero-bridge-feature-group-appraise" },
		{ id: "ai", label: "AI 輔助與寫作", l10n: "zotero-bridge-feature-group-ai" },
	];

	const PRESETS = {
		guided: {
			label: "研究生引導",
			desc: "找文獻與寫作留給你自己：自動找新文獻、引文追蹤和 AI 寫的草稿先關著，整理、評讀和搜尋連結照常幫你。",
			l10n: "zotero-bridge-preset-guided",
		},
		advanced: {
			label: "進階",
			desc: "全部打開，包括 AI 草稿、批次 API 和自動追蹤新文獻。",
			l10n: "zotero-bridge-preset-advanced",
		},
		custom: {
			label: "自訂",
			desc: "開關跟兩種模式都不完全一樣。",
			l10n: "zotero-bridge-preset-custom",
		},
	};

	/**
	 * The catalog. pref: key under extensions.zotero-bridge. (reused = it existed before the switches);
	 * presets: value per preset; usesAI: calls an AI API (costs money); usesNetwork: connects to the
	 * internet; requires: features that must be on as well; since: the features.version that added the
	 * switch (1 when absent), for the migration of profiles that already had the switches.
	 */
	const FEATURES = [
		// 整理與同步
		{ id: "sync", group: "organize", pref: "feature.sync", presets: { guided: true, advanced: true }, usesNetwork: true,
			label: "同步到 Obsidian／Notion",
			desc: "把書目、劃線、你的筆記和評讀整理進自己的筆記空間，是這個外掛的核心。設定 Notion 時會連到 Notion。" },
		{ id: "status", group: "organize", pref: "status.enabled", reused: true, presets: { guided: true, advanced: true },
			label: "閱讀狀態",
			desc: "待讀、閱讀中、已讀、已引用，在 Zotero、Notion、Obsidian 三邊保持一致。" },
		{ id: "apaZh", group: "organize", pref: "apaZh.enabled", reused: true, presets: { guided: true, advanced: true },
			label: "中文 APA",
			desc: "中文文獻改用中文 APA 7：作者全名、「等」、全形括號。不會改動 Zotero 條目。" },
		{ id: "annotationImages", group: "organize", pref: "images.export", reused: true, presets: { guided: true, advanced: true },
			label: "圖片劃線",
			desc: "PDF 上框選的圖表截圖一起放進筆記：Obsidian 存成附件，Notion 上傳成圖片。" },
		{ id: "bibliography", group: "organize", pref: "feature.bibliography", presets: { guided: true, advanced: true },
			label: "參考文獻檔",
			desc: "匯出 references.json（可加 BibTeX），寫作時用 Pandoc 或 Obsidian 外掛引用。" },
		{ id: "dashboard", group: "organize", pref: "feature.dashboard", presets: { guided: true, advanced: true },
			label: "研究儀表板",
			desc: "在 Obsidian 整理閱讀進度、待讀清單和資料缺漏。只讀 vault，不連網。" },
		{ id: "concepts", group: "organize", pref: "feature.concepts", presets: { guided: true, advanced: true },
			label: "概念卡片",
			desc: "把筆記裡的 [[概念]] 整理成卡片和索引，看得出哪些文獻談同一件事。不呼叫 AI。" },
		{ id: "fullTextMarkdown", group: "organize", pref: "feature.fullTextMarkdown", presets: { guided: true, advanced: true },
			requires: ["sync"], since: 2,
			label: "全文筆記",
			desc: "把 PDF 全文整理成 Markdown 存成一份筆記，你的劃線依顏色標在原文位置；送給 AI 的全文也改用它，省下參考文獻的 token。不呼叫 AI。" },
		{ id: "autoClassify", group: "organize", pref: "feature.autoClassify", presets: { guided: true, advanced: true }, since: 2,
			label: "文獻自動分類",
			desc: "依研究設計、PICO 和你寫的規則建議 Zotero 子分類，你勾選後才放進去，也能整批復原。" },
		{ id: "toolbarButton", group: "organize", pref: "feature.toolbarButton", presets: { guided: true, advanced: true }, since: 2,
			label: "工具列按鈕",
			desc: "在文獻清單上方的工具列放一個 ZotMax 按鈕，常用功能依研究流程分組，不必再從右鍵或工具選單找。" },
		{ id: "zhMeta", group: "organize", pref: "feature.zhMeta", presets: { guided: true, advanced: true }, since: 4,
			label: "中文文獻補強",
			desc: "檢查華藝、博碩士論文等匯入的中文文獻資料（作者拆錯、民國年、卷期頁、DOI、語言），列出建議讓你勾選後才修正，也能復原。不連網，也不呼叫 AI。" },
		// 找文獻
		{ id: "searchLinks", group: "search", pref: "feature.searchLinks", presets: { guided: true, advanced: true }, usesNetwork: true,
			label: "醫學資料庫搜尋連結",
			desc: "把題目、MeSH、PICO 帶到 PubMed、CINAHL、Cochrane、華藝等資料庫。檢索式還是你自己決定。" },
		{ id: "pubmedWatch", group: "search", pref: "feature.pubmedWatch", presets: { guided: false, advanced: true }, usesNetwork: true,
			label: "PubMed 新文獻追蹤",
			desc: "定期用你存的檢索式查 PubMed，新文獻自動匯入 Zotero。" },
		{ id: "citationChase", group: "search", pref: "feature.citationChase", presets: { guided: false, advanced: true }, usesNetwork: true,
			label: "引文追蹤",
			desc: "用 OpenAlex 找納入研究的參考文獻和引用它的文獻，列成候選清單給你勾選。" },
		// 篩選與評讀
		{ id: "screening", group: "appraise", pref: "feature.screening", presets: { guided: true, advanced: true },
			label: "篩選與 PRISMA",
			desc: "標題摘要、全文篩選記成 Zotero 標籤，產生 PRISMA 2020 流程圖與證據表。決定由你做。" },
		{ id: "appraisalForm", group: "appraise", pref: "feature.appraisalForm", presets: { guided: true, advanced: true },
			label: "文獻評讀表",
			desc: "在條目旁用 CASP、JBI 逐題評讀，存回 Zotero 並同步到筆記。關掉只是隱藏表單，已填的評讀照樣同步。" },
		// AI 輔助與寫作
		{ id: "aiNotes", group: "ai", pref: "llm.enabled", reused: true, presets: { guided: true, advanced: true },
			usesAI: true, usesNetwork: true, requires: ["sync"],
			label: "AI 文獻筆記",
			desc: "同步時請 AI 整理研讀筆記（設計、樣本、PICO、評讀初稿），引文會回原文核對。自備 API key。" },
		{ id: "aiBatch", group: "ai", pref: "llm.batchAPI", reused: true, presets: { guided: false, advanced: true },
			usesAI: true, usesNetwork: true, requires: ["aiNotes"],
			label: "批次 API",
			desc: "一次產生很多篇 AI 筆記時改用 Claude 批次 API：約半價，但最久要等 24 小時。" },
		{ id: "aiHighlights", group: "ai", pref: "feature.aiHighlights", presets: { guided: false, advanced: true },
			usesAI: true, usesNetwork: true, requires: ["aiNotes"], since: 2,
			label: "AI 標重點",
			desc: "產生 AI 筆記時順便請 AI 挑出幾句關鍵原句，核對後用跟你的劃線不同的記號標出，僅供參考。不另外呼叫 AI。" },
		{ id: "synthesis", group: "ai", pref: "feature.synthesis", presets: { guided: false, advanced: true }, usesAI: true, usesNetwork: true,
			label: "文獻比較表",
			desc: "選幾篇文獻，讓 AI 做比較表、主題整理和研究缺口。" },
		{ id: "reviewDraft", group: "ai", pref: "feature.reviewDraft", presets: { guided: false, advanced: true }, usesAI: true, usesNetwork: true,
			label: "文獻探討草稿",
			desc: "讓 AI 依你選的文獻寫第二章文獻探討的草稿。" },
		{ id: "ebhcReport", group: "ai", pref: "feature.ebhcReport", presets: { guided: false, advanced: true }, usesAI: true, usesNetwork: true,
			label: "實證報告草稿",
			desc: "讓 AI 依台灣護理學會 EBHC 格式寫實證健康照護報告的草稿。" },
		{ id: "progressReport", group: "ai", pref: "feature.progressReport", presets: { guided: false, advanced: true }, usesNetwork: true,
			label: "進度報告",
			desc: "整理這段時間讀了什麼、篩選到哪裡、下一步，給指導教授看。報告本身不用 AI；要加 AI「本期摘要」時另外勾選，產生前會先確認費用。" },
		{ id: "conceptsAI", group: "ai", pref: "feature.conceptsAI", presets: { guided: false, advanced: true },
			usesAI: true, usesNetwork: true, requires: ["concepts"],
			label: "概念卡片 AI 綜整",
			desc: "讓 AI 為一張概念卡片寫綜整草稿，附數字查核清單。" },
		{ id: "classifyAI", group: "ai", pref: "feature.classifyAI", presets: { guided: false, advanced: true }, since: 2,
			usesAI: true, usesNetwork: true, requires: ["autoClassify", "aiNotes"],
			label: "AI 主題分類",
			desc: "自動分類時讓 AI 依標題和摘要判斷文獻屬於你列的哪些主題；執行前先告訴你篇數和預估費用。" },
		{ id: "appraisalCoach", group: "ai", pref: "feature.appraisalCoach", presets: { guided: false, advanced: true }, since: 3,
			usesAI: true, usesNetwork: true, requires: ["appraisalForm", "aiNotes"],
			label: "評讀陪練",
			desc: "自己答完評讀表後，請 AI 只看原文獨立作答，列出跟你不同的題目和原文依據；要不要改由你決定。執行前先告訴你預估費用。" },
		{ id: "statsExplainer", group: "ai", pref: "feature.statsExplainer", presets: { guided: false, advanced: true }, since: 3,
			usesAI: true, usesNetwork: true, requires: ["aiNotes"],
			label: "讀懂統計",
			desc: "在 PDF 選一段文字，AI 用白話解釋裡面的統計（OR、信賴區間、p 值…）和要注意的地方；每個數字都和原文核對。" },
	];

	for (let f of FEATURES) {
		f.requires = f.requires || [];
		f.since = f.since || 1;
		// conceptsAI → concepts-ai, aiNotes → ai-notes
		let kebab = f.id.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
		f.l10n = { name: `zotero-bridge-feature-${kebab}`, desc: `zotero-bridge-feature-${kebab}-desc` };
	}
	const BY_ID = new Map(FEATURES.map(f => [f.id, f]));

	// Profile prefs that show the plugin was used before the switches existed (cheap to read)
	const PRIOR_USE = [
		["obsidian.vaultPath", v => String(v || "").trim() !== ""],
		["notion.database", v => String(v || "").trim() !== ""],
		["usage.ledger", v => !["", "{}"].includes(String(v || "").trim())],
		["routing.rules", v => !["", "[]"].includes(String(v || "").trim())],
		["pubmedWatch.watches", v => !["", "[]"].includes(String(v || "").trim())],
		["batch.pending", v => String(v || "").trim() !== ""],
		["batch.ai", v => String(v || "").trim() !== ""],
	];

	// ---------- prefs ----------

	// Tests swap in a plain object; inside Zotero this is Zotero.Prefs (global names)
	let prefs = null;

	function store() {
		if (prefs) return prefs;
		let Z = scope && scope.Zotero;
		return {
			get: key => Z.Prefs.get(PREF + key, true),
			set: (key, value) => Z.Prefs.set(PREF + key, value, true),
			hasUserValue: key => Services.prefs.prefHasUserValue(PREF + key),
		};
	}

	function setStore(s) {
		prefs = s;
	}

	function get(id) {
		let f = BY_ID.get(id);
		if (!f) throw new Error(`Unknown feature: ${id}`);
		return f;
	}

	/** The switch itself, ignoring what it requires. prefs.js defaults are the guided values. */
	function rawValue(id) {
		let f = get(id);
		let v;
		try {
			v = store().get(f.pref);
		}
		catch (e) {
			v = undefined;
		}
		return typeof v === "boolean" ? v : f.presets.guided;
	}

	/** On, and every feature it requires is on. */
	function isEnabled(id, seen = new Set()) {
		if (seen.has(id)) return false;
		seen.add(id);
		let f = get(id);
		return rawValue(id) && f.requires.every(r => isEnabled(r, seen));
	}

	function setEnabled(id, on) {
		store().set(get(id).pref, !!on);
	}

	/** id → raw switch value for every feature. */
	function snapshot() {
		return Object.fromEntries(FEATURES.map(f => [f.id, rawValue(f.id)]));
	}

	function restore(values) {
		for (let f of FEATURES) {
			if (typeof values[f.id] === "boolean" && values[f.id] !== rawValue(f.id)) setEnabled(f.id, values[f.id]);
		}
	}

	/** Set every switch to the preset's value; returns the values before, for undo. */
	function applyPreset(name) {
		if (name !== "guided" && name !== "advanced") throw new Error(`Unknown preset: ${name}`);
		let before = snapshot();
		for (let f of FEATURES) {
			if (rawValue(f.id) !== f.presets[name]) setEnabled(f.id, f.presets[name]);
		}
		return before;
	}

	/** "guided" | "advanced" when every switch matches that preset, else "custom". */
	function presetOf(values) {
		for (let name of ["guided", "advanced"]) {
			if (FEATURES.every(f => values[f.id] === f.presets[name])) return name;
		}
		return "custom";
	}

	function currentPreset() {
		return presetOf(snapshot());
	}

	/** Which of PRIOR_USE the profile shows (empty: a fresh install). */
	function priorUse(read) {
		return PRIOR_USE.filter(([key, test]) => {
			try {
				return test(read(key));
			}
			catch (e) {
				return false;
			}
		}).map(([key]) => key);
	}

	function userSet(s, key) {
		try {
			return s.hasUserValue ? !!s.hasUserValue(key) : false;
		}
		catch (e) {
			return true;
		}
	}

	/**
	 * Step 1 (the switches arrive): an install used before the switches existed gets everything on
	 * (advanced), so nothing it did disappears; prefs that existed before keep their values. A fresh
	 * install keeps the guided defaults. Returns { preset, evidence }.
	 */
	function migrateSwitches(s) {
		let evidence = priorUse(key => s.get(key));
		if (evidence.length) {
			// Written even where the default matches, so a later default change can't switch them off
			for (let f of FEATURES) {
				if (!f.reused) setEnabled(f.id, f.presets.advanced);
				// A reused pref that was off by default (the batch API) is turned on too, unless the
				// user set it themselves, so an upgrade lands on a clean 進階
				else if (f.presets.advanced !== f.presets.guided && !userSet(s, f.pref)) setEnabled(f.id, f.presets.advanced);
			}
		}
		return { preset: evidence.length ? "advanced" : "guided", evidence };
	}

	/**
	 * A later step that adds switches: a profile on 進階 (every switch from earlier versions at its
	 * advanced value) gets the new switches at their advanced value too, so it stays 進階; any other
	 * profile keeps the new switches' guided defaults. Switches the user already set are left alone.
	 * Returns true when it moved the profile along.
	 */
	function migrateNewSwitches(s, version) {
		let older = FEATURES.filter(f => f.since < version);
		if (!older.every(f => rawValue(f.id) === f.presets.advanced)) return false;
		for (let f of FEATURES.filter(x => x.since === version)) {
			// Written even where the default matches, so a later default change can't switch them off
			if (!userSet(s, f.pref)) setEnabled(f.id, f.presets.advanced);
		}
		return true;
	}

	// One-time steps, in order; MIGRATION_PREF records the last one done. Each step is its own entry,
	// so steps from different branches merge as separate lines.
	const MIGRATIONS = [
		{ version: 1, run: s => migrateSwitches(s) },
		// v0.10.0: 全文筆記, 文獻自動分類, 工具列按鈕, AI 標重點 and AI 主題分類 (every switch marked since: 2).
		// added: those switches; newSwitches: whether the profile was on 進階 and got them on
		{ version: 2, run: s => ({ added: FEATURES.filter(f => f.since === 2).map(f => f.id), newSwitches: migrateNewSwitches(s, 2) }) },
		// v0.12.0: 評讀陪練 and 讀懂統計 (every switch marked since: 3), the same way as step 2
		{ version: 3, run: s => ({ added: FEATURES.filter(f => f.since === 3).map(f => f.id), newSwitches: migrateNewSwitches(s, 3) }) },
		// v0.14.0: 中文文獻補強 (every switch marked since: 4), the same way as step 2
		{ version: 4, run: s => ({ added: FEATURES.filter(f => f.since === 4).map(f => f.id), newSwitches: migrateNewSwitches(s, 4) }) },
	];

	/**
	 * Once per profile and version, at startup: run the one-time steps this profile hasn't had yet.
	 * Returns null when there was nothing to do, else { preset, evidence, steps, added, newSwitches }
	 * (preset/evidence from step 1 when it ran, else the current preset after the later steps).
	 */
	function migrate() {
		let s = store();
		let done = Number(s.get(MIGRATION_PREF)) || 0;
		if (done >= MIGRATION_VERSION) return null;
		let result = { preset: null, evidence: [], steps: [] };
		for (let step of MIGRATIONS) {
			if (step.version <= done) continue;
			Object.assign(result, step.run(s));
			result.steps.push(step.version);
			s.set(MIGRATION_PREF, step.version);
		}
		if (!result.preset) result.preset = currentPreset();
		return result;
	}

	/**
	 * Wrap menu entries so they hide while the feature is off. Registration stays the same; an
	 * entry's own onShowing still decides when the feature is on (MenuManager reuses the elements, so
	 * an entry without one is made visible again explicitly). `id` may be a list: visible when any is on.
	 */
	function gateMenus(id, menus) {
		let ids = Array.isArray(id) ? id : [id];
		for (let i of ids) get(i);
		return menus.map((menu) => {
			let own = menu.onShowing;
			return Object.assign({}, menu, {
				onShowing: (ev, context) => {
					if (!ids.some(i => isEnabled(i))) {
						context.setVisible(false);
						return;
					}
					if (own) own(ev, context);
					else context.setVisible(true);
				},
			});
		});
	}

	/** Pref keys (under extensions.zotero-bridge.) of every switch, for observers. */
	function prefKeys() {
		return FEATURES.map(f => f.pref);
	}

	return {
		PREF, MIGRATION_PREF, MIGRATION_VERSION, MIGRATIONS, GROUPS, PRESETS, FEATURES, PRIOR_USE,
		setStore, get, rawValue, isEnabled, setEnabled, snapshot, restore, applyPreset, presetOf, currentPreset,
		priorUse, migrate, gateMenus, prefKeys,
	};
});
