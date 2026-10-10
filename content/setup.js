/*
 * ZotMax — 設定精靈, the first-run setup wizard.
 *
 * A small window (content/setup.xhtml, served from chrome://zotero-bridge/ like 快速指令) that takes a
 * new user from "just installed" to "first literature note synced" without the settings pane:
 *
 *   1 歡迎        what ZotMax does and its stance, in plain words
 *   2 選模式      研究生引導 or 進階 (features.js applyPreset)
 *   3 筆記放哪裡  Obsidian (folder picker, a check that it is a folder and looks like a vault),
 *                 Notion (token into the login manager, database link, 「測試連線」 = main.testNotion)
 *   4 AI（選填）  provider and key (secrets.js); the key is only checked for its format: no call that
 *                 costs money just to test it, and the key is never shown back or logged
 *   5 試一次      sync one item with the catalog's sync-no-ai command (costs nothing), show the note
 *   6 完成        where things are: toolbar button, ZotMax panel, 快速指令, 設定 → ZotMax
 *
 * Every step writes its settings the moment the user confirms it (下一步), so closing half way keeps
 * what was done; 略過 and 上一步 write nothing. Finishing or closing the window (Esc, the window's own
 * close button) sets extensions.zotero-bridge.setup.done; the wizard can be opened again at any time
 * from 快速指令 (「設定精靈…」), the toolbar menu and 設定 → 功能.
 *
 * Opens by itself once, after the main window is ready (uiReadyPromise), on a profile that has never
 * finished it and has nothing configured yet (decide()): a fresh install (ADDON_INSTALL) or a profile
 * that installed earlier without setting anything up. A profile that is already configured (a vault,
 * a Notion database, a stored key, earlier use) never sees it pop up: setup.done is set silently.
 * Started without a reason (tests that load the plugin by hand) it never opens on its own.
 *
 * Lifecycle: init({ reason }) from main.init, shutdown() from bootstrap.js closes the window; after
 * shutdown no callback touches the plugin (alive()).
 */
(function (root) {
	const DIALOG_URL = "chrome://zotero-bridge/content/setup.xhtml";
	const DIALOG_ROOT = "zb-setup";
	const DIALOG_NAME = "zotero-bridge-setup";
	const PREF = "extensions.zotero-bridge.";
	const DONE_PREF = "setup.done";
	// Bootstrap reasons (Firefox's BOOTSTRAP_REASONS); only ADDON_INSTALL is named in decide()
	const ADDON_INSTALL = 5;
	// After the main window is ready: let Zotero finish drawing before a window of ours appears
	const AUTO_OPEN_DELAY_MS = 1500;
	const SITE_URL = "https://bobyu89.github.io/zotero-bridge/#install";
	const HTML_NS = "http://www.w3.org/1999/xhtml";
	const STEPS = ["welcome", "mode", "notes", "ai", "try", "done"];
	// Secrets whose presence means the profile is already set up (secrets.js names)
	const CONFIG_SECRETS = ["notionToken", "anthropicKey", "openaiKey"];
	const KEY_NAMES = { anthropic: "anthropicKey", openai: "openaiKey" };
	const PROVIDER_NAMES = { anthropic: "Claude", openai: "OpenAI" };

	// zh-TW text of the wizard's Fluent messages (identical to locale/zh-TW; tests check)
	const STRINGS = {
		title: ["zotero-bridge-setup-title", "ZotMax 設定精靈"],
		stepCount: ["zotero-bridge-setup-step-count", "第 { $count } 步，共 6 步"],
		stepsLabel: ["zotero-bridge-setup-steps-label", "設定步驟"],
		step_welcome: ["zotero-bridge-setup-step-welcome", "歡迎"],
		step_mode: ["zotero-bridge-setup-step-mode", "選模式"],
		step_notes: ["zotero-bridge-setup-step-notes", "筆記放哪裡"],
		step_ai: ["zotero-bridge-setup-step-ai", "AI（選填）"],
		step_try: ["zotero-bridge-setup-step-try", "試一次"],
		step_done: ["zotero-bridge-setup-step-done", "完成"],
		back: ["zotero-bridge-setup-back", "上一步"],
		next: ["zotero-bridge-setup-next", "下一步"],
		skip: ["zotero-bridge-setup-skip", "略過"],
		start: ["zotero-bridge-setup-start", "開始設定"],
		finish: ["zotero-bridge-setup-finish", "完成"],
		foot: ["zotero-bridge-setup-foot", "Esc 關閉。做過的設定都會留著，之後在快速指令搜「設定精靈」就能再打開。"],
		saving: ["zotero-bridge-setup-saving", "儲存中…"],
		saveFailed: ["zotero-bridge-setup-save-failed", "沒有存成功：{ $error }"],
		error: ["zotero-bridge-setup-error", "設定精靈沒有開啟（{ $error }）。可以改到 設定 → ZotMax 設定。"],

		welcomeTitle: ["zotero-bridge-setup-welcome-title", "歡迎使用 ZotMax"],
		welcomeLead: ["zotero-bridge-setup-welcome-lead", "ZotMax 是給 Zotero 的外掛：把你收的文獻、PDF 劃線、筆記和評讀，整理進你自己的 Obsidian 或 Notion。"],
		welcomeFind: ["zotero-bridge-setup-welcome-find", "找文獻和寫作留給你，它只幫忙整理、追蹤和評讀這些雜事。"],
		welcomeAI: ["zotero-bridge-setup-welcome-ai", "AI 只在你自己打開、填了 API key 之後才會出現。"],
		welcomeSwitch: ["zotero-bridge-setup-welcome-switch", "每個功能都能關，之後在 設定 → ZotMax 隨時改。"],
		welcomeTime: ["zotero-bridge-setup-welcome-time", "接下來大約 3 分鐘：選模式、接上筆記工具、AI（選填），最後同步一篇看看。每一步都能略過。"],

		modeTitle: ["zotero-bridge-setup-mode-title", "選一個起點"],
		modeLead: ["zotero-bridge-setup-mode-lead", "兩種模式差在一開始打開哪些功能。之後可在 設定 → 功能 改，也能逐項開關。"],
		modeRecommended: ["zotero-bridge-setup-mode-recommended", "建議新手"],
		modeGuided: ["zotero-bridge-preset-guided", "研究生引導"],
		modeGuidedDesc: ["zotero-bridge-preset-guided-desc", "找文獻與寫作留給你自己：自動找新文獻、引文追蹤和 AI 寫的草稿先關著，整理、評讀和搜尋連結照常幫你。"],
		modeAdvanced: ["zotero-bridge-preset-advanced", "進階"],
		modeAdvancedDesc: ["zotero-bridge-preset-advanced-desc", "全部打開，包括 AI 草稿、批次 API 和自動追蹤新文獻。"],
		modeCustomName: ["zotero-bridge-preset-custom", "自訂"],
		modeCustom: ["zotero-bridge-setup-mode-custom", "你現在的開關是「自訂」；兩個都不選，就維持原樣。"],
		modeSaved: ["zotero-bridge-setup-mode-saved", "已切換到「{ $name }」。"],

		notesTitle: ["zotero-bridge-setup-notes-title", "筆記要放在哪裡？"],
		notesLead: ["zotero-bridge-setup-notes-lead", "同步時，每篇文獻會變成一份筆記，放在你選的地方。"],
		notesObsidian: ["zotero-bridge-setup-notes-obsidian", "Obsidian"],
		notesObsidianDesc: ["zotero-bridge-setup-notes-obsidian-desc", "筆記是電腦裡的 Markdown 檔，放在你的 vault 資料夾。"],
		notesNotion: ["zotero-bridge-setup-notes-notion", "Notion"],
		notesNotionDesc: ["zotero-bridge-setup-notes-notion-desc", "每篇文獻是 Notion 資料庫裡的一頁，同步時要連網。"],
		notesBoth: ["zotero-bridge-setup-notes-both", "兩個都要"],
		notesBothDesc: ["zotero-bridge-setup-notes-both-desc", "Obsidian 和 Notion 一起更新。"],
		notesNone: ["zotero-bridge-setup-notes-none", "先不用"],
		notesNoneDesc: ["zotero-bridge-setup-notes-none-desc", "之後在 設定 → 同步 再接上。"],
		notesChoose: ["zotero-bridge-setup-notes-choose", "先選一個，或按「略過」。"],
		notesSaved: ["zotero-bridge-setup-notes-saved", "筆記位置已儲存。"],
		vaultLabel: ["zotero-bridge-setup-vault-label", "Obsidian vault 資料夾"],
		vaultHint: ["zotero-bridge-setup-vault-hint", "就是你在 Obsidian 用「開啟資料夾作為 vault」打開的那個資料夾；筆記會放在裡面的「{ $name }」子資料夾。"],
		vaultPick: ["zotero-bridge-setup-vault-pick", "選擇資料夾…"],
		vaultPickTitle: ["zotero-bridge-setup-vault-pick-title", "選擇 Obsidian vault 資料夾"],
		vaultEmpty: ["zotero-bridge-setup-vault-empty", "還沒選資料夾。"],
		vaultMissing: ["zotero-bridge-setup-vault-missing", "找不到這個資料夾，請再選一次。"],
		vaultFile: ["zotero-bridge-setup-vault-file", "這是檔案，不是資料夾。請選 vault 的資料夾。"],
		vaultOK: ["zotero-bridge-setup-vault-ok", "是 Obsidian vault（裡面有 .obsidian 設定資料夾）。"],
		vaultFolder: ["zotero-bridge-setup-vault-folder", "是資料夾，但裡面沒有 .obsidian。還沒在 Obsidian 打開過的話，之後打開一次就好，筆記照樣會寫進去。"],
		notionLead: ["zotero-bridge-setup-notion-lead", "Notion 要準備三樣：一個 integration 的 token、一個資料庫，並讓這個 integration 可以用那個資料庫。"],
		notionStep1: ["zotero-bridge-setup-notion-step1", "到 notion.so/profile/integrations 建立一個 Internal integration，複製 token（ntn_ 開頭）。"],
		notionStep2: ["zotero-bridge-setup-notion-step2", "在 Notion 建立一個資料庫（空白的 Table 就可以），右上角 ••• → Connections → 加入剛剛的 integration。"],
		notionStep3: ["zotero-bridge-setup-notion-step3", "複製資料庫的連結，貼到下面。"],
		notionHowto: ["zotero-bridge-setup-notion-howto", "看網站上有圖的步驟"],
		notionToken: ["zotero-bridge-setup-notion-token", "Integration token"],
		notionTokenSaved: ["zotero-bridge-setup-notion-token-saved", "已經存了一組 token；留空就沿用。"],
		notionDatabase: ["zotero-bridge-setup-notion-database", "資料庫連結"],
		notionTest: ["zotero-bridge-setup-notion-test", "測試連線"],
		notionTesting: ["zotero-bridge-setup-notion-testing", "測試中…"],
		notionTestHint: ["zotero-bridge-setup-notion-test-hint", "測試會先存下 token 和連結，並在資料庫補上 ZotMax 需要的欄位。"],
		notionNeedToken: ["zotero-bridge-setup-notion-need-token", "請貼上 Notion integration token。"],
		notionBadDatabase: ["zotero-bridge-setup-notion-bad-database", "這不像 Notion 資料庫連結：裡面要有一段 32 碼的 ID。在 Notion 打開資料庫，複製網址貼上就可以。"],
		notionFailed: ["zotero-bridge-setup-notion-failed", "連線失敗：{ $error }"],

		aiTitle: ["zotero-bridge-setup-ai-title", "AI 文獻筆記（選填）"],
		aiLead: ["zotero-bridge-setup-ai-lead", "同步時可以請 AI 先替每篇寫一份研讀筆記：研究設計、樣本、PICO、評讀初稿，你再自己核對。"],
		aiCost: ["zotero-bridge-setup-ai-cost", "要用你自己的 API key，依用量付費，錢直接付給 Anthropic 或 OpenAI；ChatGPT／Claude 的訂閱方案不能用在這裡。"],
		aiOptional: ["zotero-bridge-setup-ai-optional", "完全不用 AI 也可以：同步、劃線整理、評讀表都照常運作。不確定就先略過。"],
		aiProvider: ["zotero-bridge-setup-ai-provider", "服務商"],
		aiClaude: ["zotero-bridge-setup-ai-claude", "Claude（Anthropic）"],
		aiOpenAI: ["zotero-bridge-setup-ai-openai", "OpenAI"],
		aiKey: ["zotero-bridge-setup-ai-key", "API key"],
		aiKeyWhereClaude: ["zotero-bridge-setup-ai-key-where-claude", "到 console.anthropic.com 建立，sk-ant- 開頭。"],
		aiKeyWhereOpenAI: ["zotero-bridge-setup-ai-key-where-openai", "到 platform.openai.com 建立，sk- 開頭。"],
		aiKeySaved: ["zotero-bridge-setup-ai-key-saved", "已經存了一組 { $name } 的 key；留空就沿用。"],
		aiKeyBadClaude: ["zotero-bridge-setup-ai-key-bad-claude", "這不像 Claude 的 API key（應該是 sk-ant- 開頭）。請整段複製再貼一次。"],
		aiKeyBadOpenAI: ["zotero-bridge-setup-ai-key-bad-openai", "這不像 OpenAI 的 API key（應該是 sk- 開頭）。請整段複製再貼一次。"],
		aiKeyWrongProvider: ["zotero-bridge-setup-ai-key-wrong-provider", "這看起來是 Claude 的 key：服務商請選 Claude（Anthropic）。"],
		aiSkip: ["zotero-bridge-setup-ai-skip", "先不用 AI"],
		aiSave: ["zotero-bridge-setup-ai-save", "儲存並繼續"],
		aiSaved: ["zotero-bridge-setup-ai-saved", "已存好。key 能不能用，要等第一次產生 AI 筆記才知道；這裡不會為了測試花你的錢。"],

		tryTitle: ["zotero-bridge-setup-try-title", "同步一篇看看"],
		tryLead: ["zotero-bridge-setup-try-lead", "用一篇文獻試一次。這次不呼叫 AI，不花錢。"],
		trySelected: ["zotero-bridge-setup-try-selected", "你選取的：{ $name }"],
		tryFirst: ["zotero-bridge-setup-try-first", "清單裡的第一篇：{ $name }"],
		tryRefresh: ["zotero-bridge-setup-try-refresh", "改用目前選取的文獻"],
		tryRun: ["zotero-bridge-setup-try-run", "同步這一篇"],
		tryRunning: ["zotero-bridge-setup-try-running", "同步中…"],
		tryNoItems: ["zotero-bridge-setup-try-no-items", "文獻庫裡還沒有文獻。先在 Zotero 加一篇（例如用瀏覽器的 Zotero Connector 存一篇），再按「改用目前選取的文獻」。"],
		tryNoTarget: ["zotero-bridge-setup-try-no-target", "還沒設定筆記放哪裡，所以沒地方同步。按「上一步」接上 Obsidian 或 Notion，或先略過。"],
		tryWroteObsidian: ["zotero-bridge-setup-try-wrote-obsidian", "已寫入 Obsidian：{ $name }"],
		tryOpenObsidian: ["zotero-bridge-setup-try-open-obsidian", "在 Obsidian 開啟"],
		tryWroteNotion: ["zotero-bridge-setup-try-wrote-notion", "已同步到 Notion。"],
		tryOpenNotion: ["zotero-bridge-setup-try-open-notion", "在 Notion 開啟"],
		tryNothing: ["zotero-bridge-setup-try-nothing", "沒有寫出筆記。看看 Zotero 角落的同步視窗說了什麼，或到 設定 → 同步 檢查。"],
		tryFailed: ["zotero-bridge-setup-try-failed", "同步失敗：{ $error }"],

		doneTitle: ["zotero-bridge-setup-done-title", "設定好了"],
		doneLead: ["zotero-bridge-setup-done-lead", "之後在 Zotero 裡，從這幾個地方用 ZotMax："],
		doneToolbar: ["zotero-bridge-setup-done-toolbar", "工具列的 ZotMax 按鈕（文獻清單上方，「新增筆記」右邊）：所有功能依研究流程分組。"],
		doneToolbarOff: ["zotero-bridge-setup-done-toolbar-off", "工具列的 ZotMax 按鈕目前關著，要用的話到 設定 → 功能 打開「工具列按鈕」。"],
		donePanel: ["zotero-bridge-setup-done-panel", "右側的 ZotMax 面板（橋形圖示）：選一篇文獻，就看得到重點、你的劃線和常用動作。"],
		donePalette: ["zotero-bridge-setup-done-palette", "快速指令 { $shortcut }：輸入功能名稱就找得到，例如「PRISMA」、「分類」。"],
		donePaletteMenu: ["zotero-bridge-setup-done-palette-menu", "快速指令（工具列按鈕選單的第一項）：輸入功能名稱就找得到，例如「PRISMA」、「分類」。"],
		doneSettings: ["zotero-bridge-setup-done-settings", "設定 → ZotMax：每個功能的細項設定。"],
		doneReopen: ["zotero-bridge-setup-done-reopen", "想再跑一次設定精靈：在快速指令搜「設定精靈」，或從工具列按鈕選單選「設定精靈…」。"],
		doneSummary: ["zotero-bridge-setup-done-summary", "目前的設定"],
		summaryMode: ["zotero-bridge-setup-summary-mode", "模式：{ $name }"],
		summaryNotes: ["zotero-bridge-setup-summary-notes", "筆記：{ $name }"],
		summaryNotesNone: ["zotero-bridge-setup-summary-notes-none", "筆記：還沒設定"],
		summaryAI: ["zotero-bridge-setup-summary-ai", "AI：{ $name }"],
		summaryAINone: ["zotero-bridge-setup-summary-ai-none", "AI：不使用（不花錢）"],
		openSettings: ["zotero-bridge-setup-open-settings", "打開 ZotMax 設定"],
	};

	let live = false;
	let current = null;
	let openCount = 0;
	let autoTried = false;
	let autoTimer = null;

	function ZB() {
		return root.ZB;
	}

	function C() {
		return root.ZB.commands;
	}

	// False after shutdown(): a late promise, timer or window event must not reach a missing ZB
	function alive() {
		return live && !!root.ZB;
	}

	function log(e) {
		Zotero.logError(e);
	}

	function pref(key) {
		try {
			return Zotero.Prefs.get(PREF + key, true);
		}
		catch (e) {
			return undefined;
		}
	}

	function setPref(key, value) {
		Zotero.Prefs.set(PREF + key, value, true);
	}

	function isDone() {
		return pref(DONE_PREF) === true;
	}

	function markDone() {
		try {
			setPref(DONE_PREF, true);
		}
		catch (e) {
			log(e);
		}
	}

	// ---------- the automatic first opening ----------

	/**
	 * What shows this profile is already set up: the prefs of features.js PRIOR_USE (a vault, a Notion
	 * database, AI usage, routing rules, PubMed watches, batches) and stored secrets. A secret that
	 * can't be read (the OS key store refuses) still counts: something was stored.
	 */
	async function evidence() {
		let found = ZB().features.priorUse(key => pref(key));
		for (let name of CONFIG_SECRETS) {
			try {
				if (String((await ZB().secrets.get(name)) || "").trim()) found.push(name);
			}
			catch (e) {
				found.push(name);
			}
		}
		return found;
	}

	/**
	 * "open" | "mark-done" | "skip". Not started by the add-on manager (no reason): skip. Done once:
	 * skip. Something configured (an upgrade, a reinstall over a used profile): mark it done, silently.
	 * Otherwise (ADDON_INSTALL on a fresh profile, or an earlier install that never set anything up): open.
	 */
	function decide({ reason, done, evidence: found }) {
		if (typeof reason !== "number") return "skip";
		if (done) return "skip";
		if (found && found.length) return "mark-done";
		return "open";
	}

	async function autoOpen(reason) {
		if (!alive() || autoTried) return null;
		autoTried = true;
		let found = await evidence();
		if (!alive()) return null;
		let decision = decide({ reason, done: isDone(), evidence: found });
		Zotero.debug(`ZotMax: setup wizard ${decision}${reason === ADDON_INSTALL ? " (new install)" : ""}${found.length ? `; configured: ${found.join(", ")}` : ""}`);
		if (decision === "mark-done") markDone();
		if (decision !== "open") return null;
		let win = Zotero.getMainWindow();
		if (!win) return null;
		return open(win, { auto: true });
	}

	/** At startup (main.init): opens the wizard once, after the main window is ready, when decide() says so. */
	function init(opts = {}) {
		live = true;
		autoTried = false;
		let reason = opts.reason;
		if (typeof reason !== "number") return null;
		let ready = Zotero.uiReadyPromise || Promise.resolve();
		return ready.then(() => new Promise((resolve) => {
			if (!alive()) {
				resolve(null);
				return;
			}
			autoTimer = setTimeout(() => {
				autoTimer = null;
				resolve(autoOpen(reason).catch((e) => {
					if (alive()) log(e);
					return null;
				}));
			}, opts.delayMs === undefined ? AUTO_OPEN_DELAY_MS : opts.delayMs);
		})).catch((e) => {
			if (alive()) log(e);
			return null;
		});
	}

	// ---------- checks (shared with tests) ----------

	/** Is this a folder, and does it look like an Obsidian vault? { state: empty|missing|file|vault|folder, ok, path } */
	async function checkVault(path) {
		path = String(path || "").trim();
		let out = state => ({ state, ok: state === "vault" || state === "folder", path });
		if (!path) return out("empty");
		let info;
		try {
			info = await IOUtils.stat(path);
		}
		catch (e) {
			return out("missing");
		}
		if (!info || info.type !== "directory") return out("file");
		let dot = null;
		try {
			dot = await IOUtils.stat(PathUtils.join(path, ".obsidian"));
		}
		catch (e) {
			dot = null;
		}
		return out(dot && dot.type === "directory" ? "vault" : "folder");
	}

	/**
	 * The Notion fields: a token (typed, or one stored already) and a database link with an ID
	 * (notion.js parseNotionId, what the sync uses). { ok, token, database } or { ok: false, error, field }.
	 */
	function checkNotion({ token, hasToken, database }) {
		let t = String(token || "").trim();
		let db = String(database || "").trim();
		if (!t && !hasToken) return { ok: false, error: "notionNeedToken", field: "token" };
		if (!ZB().notion.parseNotionId(db)) return { ok: false, error: "notionBadDatabase", field: "database" };
		return { ok: true, token: t, database: db };
	}

	/**
	 * The format of an API key (no network: a test call would cost money). OpenAI-compatible services
	 * (a base URL is set) use keys of their own, so only an obvious Claude key is refused there.
	 * { ok, key } or { ok: false, error }.
	 */
	function checkKey(provider, key, opts = {}) {
		key = String(key || "").trim();
		if (!key) return { ok: false, error: "empty" };
		if (provider === "openai") {
			if (/^sk-ant-/.test(key)) return { ok: false, error: "aiKeyWrongProvider" };
			if (opts.baseURL) return /\s/.test(key) ? { ok: false, error: "aiKeyBadOpenAI" } : { ok: true, key };
			return /^sk-[\w-]{16,}$/.test(key) ? { ok: true, key } : { ok: false, error: "aiKeyBadOpenAI" };
		}
		return /^sk-ant-[\w-]{16,}$/.test(key) ? { ok: true, key } : { ok: false, error: "aiKeyBadClaude" };
	}

	// ---------- what the steps act on ----------

	function defaultDeps() {
		return {
			/** The native folder picker (Zotero's FilePicker, as the settings pane's 選擇資料夾…). */
			async pickFolder(win, title) {
				let CU = (win && win.ChromeUtils) || root.ChromeUtils;
				const { FilePicker } = CU.importESModule("chrome://zotero/content/modules/filePicker.mjs");
				let fp = new FilePicker();
				fp.init(win, title, fp.modeGetFolder);
				if (await fp.show() !== fp.returnOK) return null;
				return fp.file;
			},
			checkVault,
			secrets: ZB().secrets,
			testNotion: () => ZB().main.testNotion(),
			launch: url => Zotero.launchURL(url),
			findItem,
			runSync: item => C().execute(C().get("sync-no-ai"), C().fromContext("item", { items: [item], collectionTreeRows: [] })),
			noteLinks: item => ZB().main.noteLinks(item),
			literatureNote: item => ZB().main.literatureNote(item),
			openSettings: section => C().openSettings(section),
			shortcut: () => (ZB().palette ? ZB().palette.shortcutLabel() : ""),
		};
	}

	/**
	 * The item to try: the literature item selected in the main window, else the first one in the item
	 * list on screen, else the first in the library. Resolves to { item, source: "selected" | "first" } or null.
	 */
	async function findItem(win) {
		let sel = C().fromWindow(win, "palette");
		let selected = ZB().adapter.toRegularItems(sel.items || []);
		if (selected.length) return { item: selected[0], source: "selected" };
		let pane = (win && win.ZoteroPane) || null;
		try {
			let sorted = pane && pane.getSortedItems ? pane.getSortedItems() : [];
			let first = ZB().adapter.toRegularItems(sorted || [])[0];
			if (first) return { item: first, source: "first" };
		}
		catch (e) {}
		try {
			let libraryID = (pane && pane.getSelectedLibraryID && pane.getSelectedLibraryID()) || Zotero.Libraries.userLibraryID;
			let all = await Zotero.Items.getAll(libraryID, true);
			let first = ZB().adapter.toRegularItems(all || [])[0];
			if (first) return { item: first, source: "first" };
		}
		catch (e) {}
		return null;
	}

	/** Where a sync can write now: { obsidian, notion } (a vault path; a database and a stored token). */
	async function targets(deps) {
		let notion = false;
		if (String(pref("notion.database") || "").trim()) {
			try {
				notion = !!String((await deps.secrets.get("notionToken")) || "").trim();
			}
			catch (e) {
				notion = false;
			}
		}
		return { obsidian: !!String(pref("obsidian.vaultPath") || "").trim(), notion };
	}

	async function hasSecret(deps, name) {
		try {
			return !!String((await deps.secrets.get(name)) || "").trim();
		}
		catch (e) {
			return false;
		}
	}

	// ---------- texts ----------

	/** string(name, args): the main window's Fluent (it carries zotero-bridge.ftl), else the zh-TW text. */
	async function localize(doc) {
		return ZB().palette.localizeStrings(doc, STRINGS);
	}

	function fallbackString(name, args) {
		return String(STRINGS[name][1]).replace(/\{ \$(\w+) \}/g, (m, k) => (args && args[k] !== undefined ? String(args[k]) : m));
	}

	// ---------- rendering ----------

	/**
	 * Draw the wizard into `rootEl`. opts: string (localize()), win (the main window), deps
	 * (defaultDeps(), overridable for tests), onClose() (Esc), onFinish() (完成), onOpenSettings().
	 * Returns { step(), go(name), next(), skip(), back(), status(), busy() } for tests; next/skip/back
	 * resolve when the step's writes are done.
	 */
	function render(doc, rootEl, opts) {
		let string = opts.string || fallbackString;
		let deps = Object.assign(defaultDeps(), opts.deps || {});
		let win = opts.win || null;
		let F = ZB().features;
		let h = (tag, attrs = {}, ...children) => {
			let el = doc.createElementNS(HTML_NS, tag);
			for (let [k, v] of Object.entries(attrs)) {
				if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v === true ? "" : v);
			}
			for (let c of children) {
				if (c !== null && c !== undefined) el.append(c);
			}
			return el;
		};
		let t = (name, args) => string(name, args);
		let listen = (el, type, fn) => {
			el.addEventListener(type, (ev) => {
				if (!alive()) return;
				try {
					let r = fn(ev);
					if (r && r.catch) r.catch(log);
				}
				catch (e) {
					log(e);
				}
			});
		};

		rootEl.replaceChildren();
		try {
			doc.title = t("title");
			if (doc.documentElement) doc.documentElement.setAttribute("title", t("title"));
		}
		catch (e) {}

		// ---------- frame: head (title, step count, step list), body, bottom (status, buttons, keys) ----------

		let count = h("p", { class: "zb-su-count", id: "zb-su-count" });
		let stepList = h("ol", { class: "zb-su-steps", "aria-label": t("stepsLabel") });
		let stepItems = new Map();
		STEPS.forEach((name, i) => {
			let li = h("li", { class: "zb-su-steps-item", "data-zb-step": name },
				h("span", { class: "zb-su-steps-num", "aria-hidden": "true" }, String(i + 1)), " ", t(`step_${name}`));
			stepItems.set(name, li);
			stepList.append(li);
		});
		let head = h("div", { class: "zb-su-head" },
			h("div", { class: "zb-su-head-line" }, h("p", { class: "zb-su-title" }, t("title")), count),
			stepList);
		let body = h("div", { class: "zb-su-body" });
		let status = h("p", { id: "zb-su-status", class: "zb-su-status", role: "status", "aria-live": "polite" });
		let backButton = h("button", { type: "button", id: "zb-su-back", class: "zb-su-back" }, t("back"));
		let skipButton = h("button", { type: "button", id: "zb-su-skip", class: "zb-su-skip" }, t("skip"));
		let nextButton = h("button", { type: "button", id: "zb-su-next", class: "zb-su-next zb-su-primary" }, t("next"));
		let actions = h("div", { class: "zb-su-actions" }, backButton, h("span", { class: "zb-su-spacer" }), skipButton, nextButton);
		let foot = h("p", { class: "zb-su-foot" }, t("foot"));
		rootEl.append(head, body, h("div", { class: "zb-su-bottom" }, status, actions, foot));

		let state = { index: 0, busy: false, view: null };

		function say(text, kind) {
			status.textContent = text || "";
			status.classList.toggle("is-error", kind === "error");
		}

		function setBusy(on) {
			state.busy = on;
			for (let b of [backButton, skipButton, nextButton]) {
				if (on) b.setAttribute("aria-busy", "true");
				else b.removeAttribute("aria-busy");
			}
			backButton.disabled = on || state.index === 0;
			skipButton.disabled = on;
			nextButton.disabled = on || !!(state.view && state.view.nextDisabled && state.view.nextDisabled());
		}

		function heading(id, name) {
			return h("h1", { id, class: "zb-su-heading", tabindex: "-1" }, t(name));
		}

		/** A native radio as the whole option (DESIGN.md › Preset options). */
		function option(group, value, nameText, descText, extra) {
			let id = `zb-su-${group}-${value}`;
			let radio = h("input", { type: "radio", name: `zb-su-${group}`, value, id, "aria-describedby": `${id}-desc` });
			let label = h("label", { class: "zb-su-option", for: id }, radio,
				h("span", { class: "zb-su-option-text" },
					h("span", { class: "zb-su-option-name" }, nameText, extra || null),
					h("span", { class: "zb-su-option-desc", id: `${id}-desc` }, descText)));
			return { radio, label };
		}

		function checked(name) {
			let r = body.querySelector(`input[name="zb-su-${name}"]:checked`);
			return r ? r.value : null;
		}

		function invalid(input, on) {
			if (!input) return;
			if (on) input.setAttribute("aria-invalid", "true");
			else input.removeAttribute("aria-invalid");
		}

		// ---------- the steps ----------

		let views = {
			welcome() {
				let el = h("section", { class: "zb-su-step", "data-zb-step": "welcome", "aria-labelledby": "zb-su-h-welcome" },
					heading("zb-su-h-welcome", "welcomeTitle"),
					h("p", { class: "zb-su-lead" }, t("welcomeLead")),
					h("ul", { class: "zb-su-points" },
						h("li", {}, t("welcomeFind")),
						h("li", {}, t("welcomeAI")),
						h("li", {}, t("welcomeSwitch"))),
					h("p", { class: "zb-su-hint" }, t("welcomeTime")));
				return { el, nextLabel: "start", skip: false, next: async () => true };
			},

			mode() {
				let preset = F.currentPreset();
				let guided = option("mode", "guided", t("modeGuided"), t("modeGuidedDesc"),
					h("span", { class: "zb-su-tag" }, t("modeRecommended")));
				let advanced = option("mode", "advanced", t("modeAdvanced"), t("modeAdvancedDesc"));
				if (preset === "guided") guided.radio.checked = true;
				else if (preset === "advanced") advanced.radio.checked = true;
				let el = h("section", { class: "zb-su-step", "data-zb-step": "mode", "aria-labelledby": "zb-su-h-mode" },
					heading("zb-su-h-mode", "modeTitle"),
					h("p", { class: "zb-su-lead" }, t("modeLead")),
					h("div", { class: "zb-su-options", role: "radiogroup", "aria-labelledby": "zb-su-h-mode" }, guided.label, advanced.label),
					preset === "custom" ? h("p", { class: "zb-su-hint" }, t("modeCustom")) : null);
				return {
					el,
					async next() {
						let name = checked("mode");
						if (!name) return true;
						if (F.currentPreset() !== name) F.applyPreset(name);
						say(t("modeSaved", { name: t(name === "guided" ? "modeGuided" : "modeAdvanced") }));
						return true;
					},
				};
			},

			notes() {
				let vaultPath = String(pref("obsidian.vaultPath") || "").trim();
				let database = String(pref("notion.database") || "").trim();
				let opts4 = [
					option("notes", "obsidian", t("notesObsidian"), t("notesObsidianDesc")),
					option("notes", "notion", t("notesNotion"), t("notesNotionDesc")),
					option("notes", "both", t("notesBoth"), t("notesBothDesc")),
					option("notes", "none", t("notesNone"), t("notesNoneDesc")),
				];
				let initial = vaultPath && database ? "both" : vaultPath ? "obsidian" : database ? "notion" : null;
				for (let o of opts4) if (o.radio.value === initial) o.radio.checked = true;

				// Obsidian
				let vaultInput = h("input", { type: "text", id: "zb-su-vault", class: "zb-su-input", autocomplete: "off", spellcheck: "false",
					"aria-describedby": "zb-su-vault-hint zb-su-vault-check" });
				vaultInput.value = vaultPath;
				let pick = h("button", { type: "button", id: "zb-su-vault-pick" }, t("vaultPick"));
				let vaultCheck = h("p", { id: "zb-su-vault-check", class: "zb-su-check", role: "status", "aria-live": "polite" });
				let lastCheck = null;
				let runCheck = async () => {
					let path = vaultInput.value;
					let result = await deps.checkVault(path);
					if (!alive() || vaultInput.value !== path) return result;
					lastCheck = result;
					vaultCheck.setAttribute("data-zb-state", result.state);
					let words = { empty: "vaultEmpty", missing: "vaultMissing", file: "vaultFile", vault: "vaultOK", folder: "vaultFolder" };
					vaultCheck.textContent = t(words[result.state]);
					vaultCheck.classList.toggle("is-error", !result.ok && result.state !== "empty");
					invalid(vaultInput, !result.ok && result.state !== "empty");
					return result;
				};
				listen(vaultInput, "change", runCheck);
				listen(pick, "click", async () => {
					let path = await deps.pickFolder(doc.defaultView, t("vaultPickTitle"));
					if (!path || !alive()) return;
					vaultInput.value = path;
					await runCheck();
				});
				let obsidianBox = h("fieldset", { class: "zb-su-box", "data-zb-box": "obsidian" },
					h("legend", {}, t("notesObsidian")),
					h("label", { class: "zb-su-label", for: "zb-su-vault" }, t("vaultLabel")),
					h("div", { class: "zb-su-row" }, vaultInput, pick),
					h("p", { class: "zb-su-hint", id: "zb-su-vault-hint" }, t("vaultHint", { name: pref("obsidian.folder") || "Zotero" })),
					vaultCheck);

				// Notion
				let tokenInput = h("input", { type: "password", id: "zb-su-notion-token", class: "zb-su-input", autocomplete: "off", placeholder: "ntn_…",
					"aria-describedby": "zb-su-notion-token-saved" });
				let tokenSaved = h("p", { class: "zb-su-hint", id: "zb-su-notion-token-saved" });
				let hasToken = false;
				let tokenReady = hasSecret(deps, "notionToken").then((has) => {
					if (!alive()) return;
					hasToken = has;
					tokenSaved.textContent = has ? t("notionTokenSaved") : "";
				});
				let dbInput = h("input", { type: "text", id: "zb-su-notion-database", class: "zb-su-input", autocomplete: "off", spellcheck: "false",
					placeholder: "https://www.notion.so/…" });
				dbInput.value = database;
				let test = h("button", { type: "button", id: "zb-su-notion-test" }, t("notionTest"));
				let testResult = h("pre", { id: "zb-su-notion-result", class: "zb-su-result", role: "status", "aria-live": "polite" });
				let howto = h("button", { type: "button", class: "zb-su-link", id: "zb-su-notion-howto" }, t("notionHowto"));
				listen(howto, "click", () => deps.launch(SITE_URL));
				let notionBox = h("fieldset", { class: "zb-su-box", "data-zb-box": "notion" },
					h("legend", {}, t("notesNotion")),
					h("p", { class: "zb-su-hint" }, t("notionLead")),
					h("ol", { class: "zb-su-howto" }, h("li", {}, t("notionStep1")), h("li", {}, t("notionStep2")), h("li", {}, t("notionStep3"))),
					h("p", { class: "zb-su-hint" }, howto),
					h("label", { class: "zb-su-label", for: "zb-su-notion-token" }, t("notionToken")),
					tokenInput, tokenSaved,
					h("label", { class: "zb-su-label", for: "zb-su-notion-database" }, t("notionDatabase")),
					dbInput,
					h("div", { class: "zb-su-row" }, test, h("span", { class: "zb-su-hint" }, t("notionTestHint"))),
					testResult);

				let show = () => {
					let c = checked("notes");
					obsidianBox.hidden = !(c === "obsidian" || c === "both");
					notionBox.hidden = !(c === "notion" || c === "both");
				};
				for (let o of opts4) listen(o.radio, "change", show);

				async function saveNotion() {
					let check = checkNotion({ token: tokenInput.value, hasToken, database: dbInput.value });
					invalid(tokenInput, check.field === "token");
					invalid(dbInput, check.field === "database");
					if (!check.ok) {
						say(t(check.error), "error");
						(check.field === "token" ? tokenInput : dbInput).focus();
						return false;
					}
					// The token goes to the login manager (secrets.js), never to prefs
					if (check.token) {
						await deps.secrets.set("notionToken", check.token);
						tokenInput.value = "";
						hasToken = true;
						tokenSaved.textContent = t("notionTokenSaved");
					}
					setPref("notion.database", check.database);
					return true;
				}

				listen(test, "click", async () => {
					if (state.busy) return;
					setBusy(true);
					test.disabled = true;
					test.setAttribute("aria-busy", "true");
					testResult.textContent = t("notionTesting");
					try {
						if (!(await saveNotion())) {
							testResult.textContent = "";
							return;
						}
						say("");
						let lines = await deps.testNotion();
						if (!alive()) return;
						testResult.textContent = (lines || []).join("\n");
					}
					catch (e) {
						if (!alive()) return;
						testResult.textContent = t("notionFailed", { error: e.message || e });
					}
					finally {
						if (alive()) {
							test.disabled = false;
							test.removeAttribute("aria-busy");
							setBusy(false);
						}
					}
				});

				let el = h("section", { class: "zb-su-step", "data-zb-step": "notes", "aria-labelledby": "zb-su-h-notes" },
					heading("zb-su-h-notes", "notesTitle"),
					h("p", { class: "zb-su-lead" }, t("notesLead")),
					h("div", { class: "zb-su-options", role: "radiogroup", "aria-labelledby": "zb-su-h-notes" }, ...opts4.map(o => o.label)),
					obsidianBox, notionBox);
				show();
				let ready = Promise.all([tokenReady, vaultPath ? runCheck() : null]).catch(log);
				return {
					el,
					ready,
					async next() {
						await tokenReady;
						let c = checked("notes");
						if (!c) {
							say(t("notesChoose"), "error");
							return false;
						}
						if (c === "none") return true;
						if (c === "obsidian" || c === "both") {
							let result = lastCheck && lastCheck.path === vaultInput.value.trim() ? lastCheck : await runCheck();
							if (!result.ok) {
								say(t(result.state === "empty" ? "vaultEmpty" : result.state === "file" ? "vaultFile" : "vaultMissing"), "error");
								vaultInput.focus();
								return false;
							}
						}
						// Notion first: its check can still refuse, and then nothing is written
						if ((c === "notion" || c === "both") && !(await saveNotion())) return false;
						if (c === "obsidian" || c === "both") setPref("obsidian.vaultPath", vaultInput.value.trim());
						say(t("notesSaved"));
						return true;
					},
				};
			},

			ai() {
				let provider = pref("llm.provider") === "openai" ? "openai" : "anthropic";
				let claude = h("input", { type: "radio", name: "zb-su-provider", value: "anthropic", id: "zb-su-provider-anthropic" });
				let openai = h("input", { type: "radio", name: "zb-su-provider", value: "openai", id: "zb-su-provider-openai" });
				(provider === "openai" ? openai : claude).checked = true;
				let keyInput = h("input", { type: "password", id: "zb-su-ai-key", class: "zb-su-input", autocomplete: "off",
					"aria-describedby": "zb-su-ai-where zb-su-ai-saved" });
				let where = h("p", { class: "zb-su-hint", id: "zb-su-ai-where" });
				let saved = h("p", { class: "zb-su-hint", id: "zb-su-ai-saved" });
				let chosen = () => (openai.checked ? "openai" : "anthropic");
				let refresh = () => {
					let p = chosen();
					where.textContent = t(p === "openai" ? "aiKeyWhereOpenAI" : "aiKeyWhereClaude");
					keyInput.setAttribute("placeholder", p === "openai" ? "sk-…" : "sk-ant-…");
					saved.textContent = "";
					hasSecret(deps, KEY_NAMES[p]).then((has) => {
						if (alive() && chosen() === p) saved.textContent = has ? t("aiKeySaved", { name: PROVIDER_NAMES[p] }) : "";
					});
					invalid(keyInput, false);
					setBusy(state.busy);
				};
				listen(claude, "change", refresh);
				listen(openai, "change", refresh);
				listen(keyInput, "input", () => setBusy(state.busy));
				let el = h("section", { class: "zb-su-step", "data-zb-step": "ai", "aria-labelledby": "zb-su-h-ai" },
					heading("zb-su-h-ai", "aiTitle"),
					h("p", { class: "zb-su-lead" }, t("aiLead")),
					h("ul", { class: "zb-su-points" }, h("li", {}, t("aiCost")), h("li", {}, t("aiOptional"))),
					h("fieldset", { class: "zb-su-box" },
						h("legend", {}, t("aiProvider")),
						h("div", { class: "zb-su-row", role: "radiogroup", "aria-label": t("aiProvider") },
							h("label", { class: "zb-su-radio", for: "zb-su-provider-anthropic" }, claude, t("aiClaude")),
							h("label", { class: "zb-su-radio", for: "zb-su-provider-openai" }, openai, t("aiOpenAI"))),
						h("label", { class: "zb-su-label", for: "zb-su-ai-key" }, t("aiKey")),
						keyInput, where, saved));
				refresh();
				return {
					el,
					// 略過 is the prominent way on: 儲存並繼續 waits for a key
					skipLabel: "aiSkip",
					skipPrimary: true,
					nextLabel: "aiSave",
					nextDisabled: () => !keyInput.value.trim(),
					async next() {
						let p = chosen();
						let check = checkKey(p, keyInput.value, { baseURL: String(pref("llm.openaiBaseURL") || "").trim() });
						if (check.error === "empty") return true;
						if (!check.ok) {
							invalid(keyInput, true);
							say(t(check.error), "error");
							keyInput.focus();
							return false;
						}
						invalid(keyInput, false);
						// The key goes to the login manager (secrets.js), never to prefs or the debug output
						await deps.secrets.set(KEY_NAMES[p], check.key);
						keyInput.value = "";
						setPref("llm.provider", p);
						say(t("aiSaved"));
						return true;
					},
				};
			},

			try() {
				let lead = h("p", { class: "zb-su-lead" }, t("tryLead"));
				let which = h("p", { class: "zb-su-item", id: "zb-su-try-item" });
				let refreshButton = h("button", { type: "button", id: "zb-su-try-refresh" }, t("tryRefresh"));
				let run = h("button", { type: "button", id: "zb-su-try-run", class: "zb-su-primary" }, t("tryRun"));
				let result = h("p", { id: "zb-su-try-result", class: "zb-su-check", role: "status", "aria-live": "polite" });
				let links = h("div", { class: "zb-su-row", id: "zb-su-try-links" });
				let picked = null;
				let where = { obsidian: false, notion: false };
				let pickItem = async () => {
					picked = await deps.findItem(win);
					if (!alive()) return;
					which.replaceChildren();
					if (picked) {
						let title = "";
						try {
							title = picked.item.getField("title") || picked.item.key;
						}
						catch (e) {
							title = "";
						}
						which.textContent = t(picked.source === "selected" ? "trySelected" : "tryFirst", { name: title });
					}
					else {
						which.textContent = t("tryNoItems");
					}
					run.disabled = !picked || !(where.obsidian || where.notion);
				};
				listen(refreshButton, "click", pickItem);
				listen(run, "click", async () => {
					if (!picked || state.busy) return;
					let item = picked.item;
					setBusy(true);
					run.disabled = true;
					run.setAttribute("aria-busy", "true");
					links.replaceChildren();
					result.classList.remove("is-error");
					result.textContent = t("tryRunning");
					try {
						await deps.runSync(item);
						if (!alive()) return;
						let lines = [];
						let note = where.obsidian ? await deps.literatureNote(item) : null;
						let found = await deps.noteLinks(item);
						if (!alive()) return;
						if (note) lines.push(t("tryWroteObsidian", { name: note.relPath || note.path }));
						if (found && found.notion) lines.push(t("tryWroteNotion"));
						result.textContent = lines.length ? lines.join("\n") : t("tryNothing");
						result.setAttribute("data-zb-result", lines.length ? "ok" : "none");
						if (found && found.obsidian) {
							let b = h("button", { type: "button", id: "zb-su-try-open-obsidian" }, t("tryOpenObsidian"));
							listen(b, "click", () => deps.launch(found.obsidian));
							links.append(b);
						}
						if (found && found.notion) {
							let b = h("button", { type: "button", id: "zb-su-try-open-notion" }, t("tryOpenNotion"));
							listen(b, "click", () => deps.launch(found.notion));
							links.append(b);
						}
					}
					catch (e) {
						if (!alive()) return;
						result.classList.add("is-error");
						result.textContent = t("tryFailed", { error: e.message || e });
						result.setAttribute("data-zb-result", "failed");
					}
					finally {
						if (alive()) {
							run.removeAttribute("aria-busy");
							run.disabled = false;
							setBusy(false);
						}
					}
				});
				let noTarget = h("p", { class: "zb-su-check is-error", id: "zb-su-try-no-target" }, t("tryNoTarget"));
				noTarget.hidden = true;
				let el = h("section", { class: "zb-su-step", "data-zb-step": "try", "aria-labelledby": "zb-su-h-try" },
					heading("zb-su-h-try", "tryTitle"), lead, noTarget, which,
					h("div", { class: "zb-su-row" }, run, refreshButton), result, links);
				run.disabled = true;
				let ready = targets(deps).then((w) => {
					if (!alive()) return null;
					where = w;
					noTarget.hidden = w.obsidian || w.notion;
					return pickItem();
				});
				return { el, ready, next: async () => true };
			},

			done() {
				let shortcut = deps.shortcut();
				let toolbarOn = F.isEnabled("toolbarButton");
				let summary = h("ul", { class: "zb-su-summary", id: "zb-su-summary" });
				let settingsButton = h("button", { type: "button", id: "zb-su-open-settings" }, t("openSettings"));
				listen(settingsButton, "click", () => {
					if (opts.onOpenSettings) opts.onOpenSettings();
				});
				let el = h("section", { class: "zb-su-step", "data-zb-step": "done", "aria-labelledby": "zb-su-h-done" },
					heading("zb-su-h-done", "doneTitle"),
					h("p", { class: "zb-su-lead" }, t("doneLead")),
					h("ul", { class: "zb-su-points zb-su-places" },
						h("li", {}, t(toolbarOn ? "doneToolbar" : "doneToolbarOff")),
						h("li", {}, t("donePanel")),
						h("li", {}, shortcut ? t("donePalette", { shortcut }) : t("donePaletteMenu")),
						h("li", {}, t("doneSettings")),
						h("li", {}, t("doneReopen"))),
					h("h2", { class: "zb-su-subheading", id: "zb-su-summary-title" }, t("doneSummary")),
					summary,
					h("div", { class: "zb-su-row" }, settingsButton));
				summary.setAttribute("aria-labelledby", "zb-su-summary-title");
				let ready = (async () => {
					let preset = F.currentPreset();
					let mode = t(preset === "guided" ? "modeGuided" : preset === "advanced" ? "modeAdvanced" : "modeCustomName");
					let w = await targets(deps);
					let provider = pref("llm.provider") === "openai" ? "openai" : "anthropic";
					let key = await hasSecret(deps, KEY_NAMES[provider]);
					if (!alive()) return;
					let notes = [w.obsidian ? "Obsidian" : "", w.notion ? "Notion" : ""].filter(Boolean).join(" + ");
					summary.replaceChildren(
						h("li", {}, t("summaryMode", { name: mode })),
						h("li", {}, notes ? t("summaryNotes", { name: notes }) : t("summaryNotesNone")),
						h("li", {}, key ? t("summaryAI", { name: PROVIDER_NAMES[provider] }) : t("summaryAINone")));
				})();
				return { el, ready, nextLabel: "finish", skip: false, next: async () => true, last: true };
			},
		};

		function show(index) {
			state.index = index;
			let name = STEPS[index];
			let view = views[name]();
			state.view = view;
			body.replaceChildren(view.el);
			say("");
			count.textContent = t("stepCount", { count: index + 1 });
			for (let [step, li] of stepItems) {
				let i = STEPS.indexOf(step);
				li.classList.toggle("is-current", i === index);
				li.classList.toggle("is-done", i < index);
				if (i === index) li.setAttribute("aria-current", "step");
				else li.removeAttribute("aria-current");
			}
			backButton.hidden = index === 0;
			skipButton.hidden = view.skip === false;
			skipButton.textContent = t(view.skipLabel || "skip");
			skipButton.classList.toggle("zb-su-primary", !!view.skipPrimary);
			nextButton.textContent = t(view.nextLabel || "next");
			nextButton.classList.toggle("zb-su-primary", !view.skipPrimary);
			setBusy(false);
			try {
				body.scrollTop = 0;
				let h1 = view.el.querySelector(".zb-su-heading");
				if (h1) h1.focus();
			}
			catch (e) {}
			return view.ready || Promise.resolve();
		}

		async function next() {
			if (state.busy || !alive()) return false;
			let view = state.view;
			setBusy(true);
			say(t("saving"));
			let ok = false;
			try {
				ok = await view.next();
			}
			catch (e) {
				log(e);
				if (alive()) say(t("saveFailed", { error: e.message || e }), "error");
				ok = false;
			}
			if (!alive()) return false;
			setBusy(false);
			if (!ok) {
				if (status.textContent === t("saving")) say("");
				return false;
			}
			if (view.last) {
				if (opts.onFinish) opts.onFinish();
				return true;
			}
			// What the step said it saved stays visible on the next step
			let said = status.classList.contains("is-error") || status.textContent === t("saving") ? "" : status.textContent;
			await show(state.index + 1);
			if (said) say(said);
			return true;
		}

		function skip() {
			if (state.busy || state.index >= STEPS.length - 1) return Promise.resolve(false);
			return show(state.index + 1).then(() => true);
		}

		function back() {
			if (state.busy || state.index === 0) return Promise.resolve(false);
			return show(state.index - 1).then(() => true);
		}

		listen(nextButton, "click", next);
		listen(skipButton, "click", skip);
		listen(backButton, "click", back);
		listen(doc, "keydown", (ev) => {
			if (ev.key === "Escape") {
				ev.preventDefault();
				ev.stopPropagation();
				if (opts.onClose) opts.onClose();
				return;
			}
			// Enter in a text field confirms the step, as 下一步 does
			let target = ev.target;
			if (ev.key === "Enter" && target && target.localName === "input" && (target.type === "text" || target.type === "password")) {
				ev.preventDefault();
				if (!nextButton.disabled) next();
			}
		});

		let first = show(0);
		return {
			step: () => STEPS[state.index],
			go: name => show(Math.max(0, STEPS.indexOf(name))),
			next, skip, back,
			ready: () => first,
			view: () => state.view,
			status: () => status.textContent,
			busy: () => state.busy,
		};
	}

	// ---------- the window ----------

	function close({ done = true } = {}) {
		let win = current;
		current = null;
		if (done && alive()) markDone();
		try {
			if (win && !win.closed) win.close();
		}
		catch (e) {}
	}

	/**
	 * Open the wizard for a main window (default: the most recent one); an open wizard comes to the
	 * front instead. opts.onOpen(dialogWindow, view) once it shows its first step (tests); opts.deps
	 * replaces what the steps act on (tests). Resolves with the dialog window, or null.
	 */
	async function open(win, opts = {}) {
		if (!alive()) return null;
		win = win || Zotero.getMainWindow();
		if (current && !current.closed) {
			try {
				current.focus();
			}
			catch (e) {}
			return current;
		}
		let string = await localize(win && win.document);
		if (!alive()) return null;
		let dialog;
		try {
			// A fresh window name each time, so reopening right after closing never gets the closing window
			dialog = win.openDialog(DIALOG_URL, `${DIALOG_NAME}-${++openCount}`, "chrome,dialog=no,resizable,centerscreen");
			current = dialog;
			let rootEl = await ZB().palette.waitForDialog(dialog, { root: DIALOG_ROOT, what: "設定精靈視窗沒有開啟" });
			if (current !== dialog || !alive()) return null;
			// The window's own close button: closed means done (it can be opened again any time)
			dialog.addEventListener("unload", () => {
				if (current !== dialog) return;
				current = null;
				if (alive()) markDone();
			});
			let view = render(dialog.document, rootEl, {
				string, win, deps: opts.deps,
				onClose: () => close(),
				onFinish: () => close(),
				onOpenSettings: () => {
					close();
					C().openSettings();
				},
			});
			if (opts.onOpen) opts.onOpen(dialog, view);
			return dialog;
		}
		catch (e) {
			log(e);
			if (current === dialog) current = null;
			try {
				if (dialog && !dialog.closed) dialog.close();
			}
			catch (e2) {}
			if (alive()) ZB().main.notify("ZotMax", string("error", { error: e.message || e }));
			return null;
		}
	}

	/** Closes the window without marking anything (Zotero quitting is not the user closing it). */
	function shutdown() {
		live = false;
		if (autoTimer) clearTimeout(autoTimer);
		autoTimer = null;
		close({ done: false });
	}

	(root.ZB = root.ZB || {}).setup = {
		DIALOG_URL, DIALOG_ROOT, DONE_PREF, STEPS, STRINGS, ADDON_INSTALL, SITE_URL,
		init, shutdown, open, close, render, decide, evidence, checkVault, checkNotion, checkKey, findItem,
		get isOpen() { return !!(current && !current.closed); },
	};
})(this);
