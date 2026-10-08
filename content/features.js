/*
 * Zotero Bridge — feature switches and presets.
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
	// Bumped when a later version needs another one-time migration (2: 文獻自動分類 and AI 主題分類)
	const MIGRATION_PREF = "features.version";
	const MIGRATION_VERSION = 2;

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
		{ id: "autoClassify", group: "organize", pref: "feature.autoClassify", presets: { guided: true, advanced: true }, since: 2,
			label: "文獻自動分類",
			desc: "依研究設計、PICO 和你寫的規則建議 Zotero 子分類，你勾選後才放進去，也能整批復原。" },
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
		{ id: "synthesis", group: "ai", pref: "feature.synthesis", presets: { guided: false, advanced: true }, usesAI: true, usesNetwork: true,
			label: "文獻比較表",
			desc: "選幾篇文獻，讓 AI 做比較表、主題整理和研究缺口。" },
		{ id: "reviewDraft", group: "ai", pref: "feature.reviewDraft", presets: { guided: false, advanced: true }, usesAI: true, usesNetwork: true,
			label: "文獻探討草稿",
			desc: "讓 AI 依你選的文獻寫第二章文獻探討的草稿。" },
		{ id: "ebhcReport", group: "ai", pref: "feature.ebhcReport", presets: { guided: false, advanced: true }, usesAI: true, usesNetwork: true,
			label: "實證報告草稿",
			desc: "讓 AI 依台灣護理學會 EBHC 格式寫實證健康照護報告的草稿。" },
		{ id: "progressReport", group: "ai", pref: "feature.progressReport", presets: { guided: false, advanced: true }, usesAI: true, usesNetwork: true,
			label: "進度報告",
			desc: "整理這段時間讀了什麼、篩選到哪裡、下一步，給指導教授看；可以選擇加上 AI 摘要。" },
		{ id: "conceptsAI", group: "ai", pref: "feature.conceptsAI", presets: { guided: false, advanced: true },
			usesAI: true, usesNetwork: true, requires: ["concepts"],
			label: "概念卡片 AI 綜整",
			desc: "讓 AI 為一張概念卡片寫綜整草稿，附數字查核清單。" },
		{ id: "classifyAI", group: "ai", pref: "feature.classifyAI", presets: { guided: false, advanced: true }, since: 2,
			usesAI: true, usesNetwork: true, requires: ["autoClassify", "aiNotes"],
			label: "AI 主題分類",
			desc: "自動分類時讓 AI 依標題和摘要判斷文獻屬於你列的哪些主題；執行前先告訴你篇數和預估費用。" },
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
	 * Once per profile and version, at startup.
	 * From 0 (before the switches): an install used before gets the new switches on (advanced), so
	 * nothing it did disappears; prefs that existed before keep their values. A fresh install keeps the
	 * guided defaults. Returns { preset, evidence }.
	 * From a later version (the switches existed): the switches added since then follow the profile's
	 * preset: a profile on 進階 (every earlier switch at its advanced value) gets them at their advanced
	 * value, any other profile keeps the defaults. Returns { preset, evidence: [], added }.
	 * Returns null once the profile is up to date.
	 */
	function migrate() {
		let s = store();
		let done = Number(s.get(MIGRATION_PREF)) || 0;
		if (done >= MIGRATION_VERSION) return null;
		let result;
		if (done < 1) {
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
			result = { preset: evidence.length ? "advanced" : "guided", evidence };
		}
		else {
			let earlier = FEATURES.filter(f => f.since <= done);
			let added = FEATURES.filter(f => f.since > done);
			let advanced = earlier.every(f => rawValue(f.id) === f.presets.advanced);
			if (advanced) {
				for (let f of added) {
					if (!userSet(s, f.pref)) setEnabled(f.id, f.presets.advanced);
				}
			}
			result = { preset: advanced ? "advanced" : presetOf(snapshot()), evidence: [], added: added.map(f => f.id) };
		}
		s.set(MIGRATION_PREF, MIGRATION_VERSION);
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
		PREF, MIGRATION_PREF, MIGRATION_VERSION, GROUPS, PRESETS, FEATURES, PRIOR_USE,
		setStore, get, rawValue, isEnabled, setEnabled, snapshot, restore, applyPreset, presetOf, currentPreset,
		priorUse, migrate, gateMenus, prefKeys,
	};
});
