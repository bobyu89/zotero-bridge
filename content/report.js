/*
 * ZotMax — 回報問題 and 試用回饋: the GitHub issue forms (.github/ISSUE_TEMPLATE/bug.yml, feedback.yml),
 * opened in the browser with what can be filled in already.
 *
 *   回報問題…  a native confirm shows the exact environment text first (「在瀏覽器開啟 GitHub」, 「複製」,
 *             取消), then opens issues/new?template=bug.yml&env=<text>: an issue form prefills a field
 *             from the query parameter named after the field's id.
 *   試用回饋…  the same for the one-week trial questionnaire: issues/new?template=feedback.yml with the
 *             version and the mode (研究生引導／進階／自訂) filled in.
 *
 * The environment text says how ZotMax is set up, never what is in it: versions, OS, locale, the mode
 * and the switches that differ from it, whether Obsidian / Notion / an AI key are configured (yes or
 * no: no paths, names, IDs or keys), setup.done, the library size as a bucket, and the last ZotMax
 * errors from the error console, each passed through scrub() (paths, URLs, emails, tokens, IDs,
 * quoted text and the profile's own names removed). Pure parts (scrub, buildEnv, reportURL,
 * feedbackURL, pickErrors, presetDiff) are exported for the Node tests; the rest touches Zotero only
 * when a command runs.
 *
 * Lifecycle: nothing to set up. A late callback after shutdown (bootstrap.js drops ZB) does nothing
 * (alive()).
 */
(function (root, factory) {
	const api = factory(root);
	if (typeof module === "object" && module.exports) {
		module.exports = api;
	}
	else {
		(root.ZB = root.ZB || {}).report = api;
	}
})(this, function (scope) {
	const REPO_URL = "https://github.com/bobyu89/zotero-bridge";
	const ISSUE_URL = REPO_URL + "/issues/new";
	const TEMPLATES = { bug: "bug.yml", feedback: "feedback.yml" };
	// The issue form fields the plugin fills (their `id` in the YAML)
	const FIELDS = { env: "env", version: "version", preset: "preset" };
	const PLUGIN_ID = "zotero-bridge@bobyu89.github.io";
	const PREF = "extensions.zotero-bridge.";
	// GitHub answers 414 above about 8 KB; stay well below
	const MAX_URL = 6000;
	const MAX_ERRORS = 5;
	const MAX_ERROR_CHARS = 240;
	const MAX_SCRUB_INPUT = 4000;
	const PRESET_LABELS = { guided: "研究生引導", advanced: "進階", custom: "自訂" };
	const PROVIDER_NAMES = { anthropic: "Claude", openai: "OpenAI" };

	// zh-TW text of the dialogs' Fluent messages (identical to locale/zh-TW; tests check)
	const STRINGS = {
		reportTitle: ["zotero-bridge-report-title", "回報問題"],
		reportLead: ["zotero-bridge-report-lead", "會在瀏覽器打開 ZotMax 在 GitHub 的「回報問題」表單，並填好下面的環境資訊。你做了什麼、發生了什麼事，要請你自己寫。"],
		reportPrivacy: ["zotero-bridge-report-privacy", "需要 GitHub 帳號（免費）。GitHub 上的回報是公開的：不會送出文獻內容、筆記、API key 或電腦裡的路徑，送出前也還能在 GitHub 上修改。"],
		reportEnv: ["zotero-bridge-report-env", "會填入的環境資訊："],
		open: ["zotero-bridge-report-open", "在瀏覽器開啟 GitHub"],
		copy: ["zotero-bridge-report-copy", "複製"],
		copied: ["zotero-bridge-report-copied", "已複製環境資訊，可以貼到 GitHub 表單的「環境」欄。"],
		feedbackTitle: ["zotero-bridge-feedback-title", "試用回饋"],
		feedbackLead: ["zotero-bridge-feedback-lead", "會在瀏覽器打開 ZotMax 在 GitHub 的試用問卷，大約 5 分鐘，只有「整體來說有沒有用」必填。"],
		feedbackPrivacy: ["zotero-bridge-feedback-privacy", "需要 GitHub 帳號（免費）。問卷回覆是公開的：請不要寫進未發表的研究資料或病人資訊。"],
		feedbackFill: ["zotero-bridge-feedback-fill", "會幫你填入："],
		failed: ["zotero-bridge-report-failed", "沒有打開 GitHub（{ $error }）。也可以直接到 github.com/bobyu89/zotero-bridge/issues 回報。"],
	};

	// Hosts whose name says nothing about the user: kept (without path or query) in error messages
	const KNOWN_HOSTS = new Set(["api.notion.com", "notion.so", "www.notion.so", "api.anthropic.com", "api.openai.com",
		"eutils.ncbi.nlm.nih.gov", "pubmed.ncbi.nlm.nih.gov", "www.ncbi.nlm.nih.gov", "api.openalex.org", "api.crossref.org",
		"doi.org", "github.com", "api.github.com", "raw.githubusercontent.com", "bobyu89.github.io", "www.zotero.org", "api.zotero.org"]);
	// Never treated as one of the profile's own names (they would wipe the product's words)
	const KNOWN_STOP = new Set(["zotero", "zotmax", "obsidian", "notion", "zotero-bridge", "error", "errors", "default"]);
	// Plugin sources a file position may name
	const SOURCE_RE = /([\w.-]+\.(?:m?js|jsm|xhtml|html|css|ftl))$/;

	const P = {
		path: "[路徑]",
		file: "[檔案]",
		url: "[網址]",
		link: "[連結]",
		email: "[email]",
		token: "[token]",
		id: "[ID]",
		hidden: "[已隱藏]",
	};

	let self = null;

	function ZB() {
		return scope.ZB;
	}

	// False after shutdown (bootstrap.js drops ZB): a late promise must not reach a missing ZB
	function alive() {
		return !!(scope && scope.ZB && scope.ZB.report === self);
	}

	// ---------- scrub: the privacy-critical part ----------

	function escapeRE(s) {
		return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}

	function basename(p) {
		let parts = String(p || "").split(/[\\/]+/).filter(Boolean);
		return parts.length ? parts[parts.length - 1] : "";
	}

	/** The profile's own values worth removing: long enough, not a product word, longest first. */
	function knownValues(list) {
		let out = new Set();
		for (let v of list || []) {
			v = String(v == null ? "" : v).trim();
			if (v.length < 3 || KNOWN_STOP.has(v.toLowerCase())) continue;
			out.add(v);
		}
		return [...out].sort((a, b) => b.length - a.length);
	}

	/** A URL in an error message: a plugin source keeps its file name, a known API host its name, the rest goes. */
	function scrubURL(u) {
		let lower = u.toLowerCase();
		let pos = (/(?::\d+){1,2}$/.exec(u) || [""])[0];
		if (/^(?:jar:)?file:/.test(lower)) {
			let bare = u.slice(0, u.length - pos.length);
			let m = SOURCE_RE.exec(bare);
			if (/zotero-bridge/.test(lower) && /\/content\//.test(bare) && m) return m[1] + pos;
			return P.path;
		}
		if (/^(?:chrome|resource):\/\//.test(lower)) {
			let bare = u.slice(0, u.length - pos.length).replace(/[?#].*$/, "");
			// Gecko's and Zotero's own files say nothing about the user
			return bare + pos;
		}
		let m = /^https?:\/\/([^/?#]*)(.*)$/i.exec(u);
		if (m) {
			let host = m[1].replace(/^.*@/, "").replace(/:\d+$/, "").toLowerCase();
			if (KNOWN_HOSTS.has(host)) return `${lower.startsWith("https") ? "https" : "http"}://${host}${m[2] && m[2] !== "/" ? "/…" : ""}`;
			return P.url;
		}
		return P.link;
	}

	/**
	 * Remove from one line of text whatever could identify the user or their research: the profile's
	 * own values (opts.known: vault path and name, user name, data directory…), URLs (a plugin source
	 * keeps its file name, a known API host its name), emails, tokens (ntn_, secret_, sk-, Bearer,
	 * key=value), Windows, UNC, macOS and Linux paths (also with spaces), relative paths, document file
	 * names, Notion IDs and other long IDs, and quoted text that isn't a plain identifier. Whitespace
	 * collapses; opts.max (default MAX_ERROR_CHARS) caps the length.
	 */
	function scrub(text, opts = {}) {
		let s = String(text == null ? "" : text);
		if (s.length > MAX_SCRUB_INPUT) s = s.slice(0, MAX_SCRUB_INPUT);
		// What was already decided is parked as a private-use marker, so later rules can't touch it
		let parked = [];
		let park = (value) => {
			parked.push(value);
			return `\uE000${parked.length - 1}\uE001`;
		};
		s = s.replace(/[\uE000\uE001]/g, "");

		// The profile's own values (before anything else changes their shape)
		for (let v of knownValues(opts.known)) {
			let ascii = /^[\x20-\x7e]+$/.test(v);
			let re = ascii ? new RegExp(`(?<![A-Za-z0-9_])${escapeRE(v)}(?![A-Za-z0-9_])`, "gi") : new RegExp(escapeRE(v), "g");
			s = s.replace(re, () => park(P.hidden));
		}
		// URLs (and data: URIs)
		s = s.replace(/\b(?:jar:)?[a-z][a-z0-9+.-]{1,30}:\/\/[^\s"'<>`()[\]{}「」（）]+/gi, (m) => {
			let tail = (/[.,;:!?]+$/.exec(m) || [""])[0];
			let url = m.slice(0, m.length - tail.length);
			// "…/main.js:12:5" stays a position, not punctuation
			if (/:\d+$/.test(m)) {
				url = m;
				tail = "";
			}
			return park(scrubURL(url)) + tail;
		});
		s = s.replace(/\b(?:data|blob|mailto):[^\s"'<>]+/gi, () => park(P.link));
		// Emails (the plugin's own ID is one in form only)
		s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, m => (m.toLowerCase() === PLUGIN_ID ? m : park(P.email)));
		// Tokens and secrets
		s = s.replace(/\bBearer\s+[^\s"'<>,;]+/gi, () => `Bearer ${park(P.token)}`);
		s = s.replace(/\b(?:ntn_|secret_|sk-ant-|sk-proj-|sk-|ghp_|gho_|ghs_|ghu_|github_pat_|xox[abprs]-|AIza|pk_live_|rk_live_)[A-Za-z0-9_-]{6,}/g, () => park(P.token));
		s = s.replace(/\b(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|password|passwd|secret|authorization|x-api-key)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&"']{6,})/gi,
			(m, k, sep) => `${k}${sep}${park(P.token)}`);
		// Windows paths: drive letters and %VARIABLES%, separators / or \ (also doubled, as in JSON);
		// spaces only inside a folder name that another separator follows
		const seg = "[^\\\\/\\s\"'<>|*?]+(?: +[^\\\\/\\s\"'<>|*?]+)*";
		// The last part: a file name with spaces when it ends in an extension, else up to the next space
		const last = `(?:${seg}\\.[A-Za-z0-9]{1,6}(?![\\p{L}\\p{N}_])|[^\\\\/\\s"'<>|*?,;)）」]*)`;
		s = s.replace(new RegExp(`(?<![\\p{L}\\p{N}_])(?:[A-Za-z]:|%[A-Za-z_]+%)[\\\\/]+(?:${seg}[\\\\/]+)*${last}`, "gu"), () => park(P.path));
		// UNC paths: \\server\share\…
		s = s.replace(new RegExp(`\\\\\\\\[^\\\\\\s"'<>|]+[\\\\/]+(?:${seg}[\\\\/]+)*${last}`, "gu"), () => park(P.path));
		// macOS and Linux paths, ~/…; not "and/or" or 標題/摘要 (a letter before the slash)
		const pseg = "[^/\\s\"'<>|]+(?: +[^/\\s\"'<>|]+)*";
		const plast = `(?:${pseg}\\.[A-Za-z0-9]{1,6}(?![\\p{L}\\p{N}_])|[^/\\s"'<>|,;)）」]+)`;
		s = s.replace(new RegExp(`(?<![\\p{L}\\p{N}_.~\\\\/-])~?/+(?:${pseg}/+)*${plast}`, "gu"), () => park(P.path));
		// Relative paths with two or more folders (Zotero/全文/x.md)
		s = s.replace(/(?<![\p{L}\p{N}_.~\\/-])(?:[^\s/\\"'<>|:\uE000\uE001]+[/\\]){2,}[^\s/\\"'<>|:,;)）」\uE000\uE001]*/gu, () => park(P.path));
		// Documents and data files by name (a paper, a note, a spreadsheet)
		s = s.replace(/[^\s"'<>|/\\\uE000\uE001]*\.(?:md|pdf|base|canvas|bib|ris|docx?|xlsx?|pptx?|csv|tsv|txt|rtf|odt|epub|sqlite|json|sav|dta|html?)(?![\p{L}\p{N}_])/giu, () => park(P.file));
		// Notion IDs, UUIDs and other long identifiers (keys, item IDs of other services)
		s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, () => park(P.id));
		s = s.replace(/\b[0-9a-f]{32}\b/gi, () => park(P.id));
		s = s.replace(/(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}(?![A-Za-z0-9_-])/g, () => park(P.hidden));
		// Quoted text: titles, names, column names. A plain identifier ("foo", "obsidian.vaultPath") stays.
		let quoted = (m, open, body, close) => (/^[A-Za-z_$][\w$.-]{0,40}$/.test(body) || /^(?:\uE000\d+\uE001)?$/.test(body) ? m : `${open}…${close}`);
		s = s.replace(/(")([^"\n]{1,300})(")/g, quoted);
		s = s.replace(/(“)([^”\n]{1,300})(”)/g, quoted);
		s = s.replace(/(‘)([^’\n]{1,300})(’)/g, quoted);
		s = s.replace(/(「)([^」\n]{1,300})(」)/g, quoted);
		s = s.replace(/(『)([^』\n]{1,300})(』)/g, quoted);
		s = s.replace(/(《)([^》\n]{1,300})(》)/g, quoted);
		// Single quotes only as quotes, never the apostrophe of "can't"
		s = s.replace(/(?<![\p{L}\p{N}])(')([^'\n]{1,300})(')(?![\p{L}\p{N}])/gu, quoted);

		s = s.replace(/\s+/g, " ").trim();
		let max = opts.max === undefined ? MAX_ERROR_CHARS : opts.max;
		let out = s;
		if (max && out.length > max) {
			out = out.slice(0, max);
			// Never leave half a marker
			out = out.replace(/\uE000\d*$/, "").trimEnd() + "…";
		}
		return out.replace(/\uE000(\d+)\uE001/g, (m, i) => parked[Number(i)]).replace(/[\uE000\uE001]/g, "");
	}

	// ---------- the environment text ----------

	/** Library size as a bucket: no count of anyone's papers. */
	function bucket(n) {
		if (typeof n !== "number" || !isFinite(n) || n < 0) return "不明";
		if (n < 100) return "<100";
		if (n <= 1000) return "100–1000";
		return ">1000";
	}

	/**
	 * The mode and how the switches differ from it: { preset, base, on, off }. preset: guided,
	 * advanced or custom; base: the preset compared with (custom: the nearest one); on/off: switch IDs
	 * that are on although base has them off, and the reverse.
	 */
	function presetDiff(features, values) {
		let diffs = name => features.filter(f => values[f.id] !== f.presets[name]);
		let guided = diffs("guided");
		let advanced = diffs("advanced");
		let preset = !guided.length ? "guided" : !advanced.length ? "advanced" : "custom";
		let base = preset === "custom" ? (advanced.length < guided.length ? "advanced" : "guided") : preset;
		let list = base === "guided" ? guided : advanced;
		return {
			preset, base,
			on: list.filter(f => values[f.id]).map(f => f.id),
			off: list.filter(f => !values[f.id]).map(f => f.id),
		};
	}

	/** A plugin file position from a console message's source: "main.js:123", or "" for anything else. */
	function fileLine(source, line) {
		let s = String(source || "").replace(/[?#].*$/, "");
		let lower = s.toLowerCase();
		// Only the plugin's own files and Gecko's or Zotero's (chrome://, resource://): never a user's file
		if (!/zotero-bridge/.test(lower) && !/^(?:chrome|resource):\/\//.test(lower)) return "";
		let m = SOURCE_RE.exec(s.replace(/(?::\d+){1,2}$/, ""));
		if (!m) return "";
		return line ? `${m[1]}:${line}` : m[1];
	}

	/**
	 * The ZotMax errors among console messages ({ text, source, line, kind }, oldest first): its files
	 * or its name; warnings and info left out. The last `max`, oldest first.
	 */
	function pickErrors(messages, max = MAX_ERRORS) {
		let mine = (messages || []).filter((m) => {
			if (!m || (m.kind && m.kind !== "error")) return false;
			return /zotero-bridge/i.test(String(m.source || "")) || /ZotMax|zotero-bridge|Zotero Bridge/.test(String(m.text || ""));
		});
		return mine.slice(-max);
	}

	function yes(v) {
		return v ? "有設定" : "沒有";
	}

	/**
	 * The environment text, line by line (fixed zh-TW labels: it is read by the maintainer). info:
	 * { version, zotero, os, locale, preset, base, on, off, obsidian, notion, ai: { configured,
	 * provider }, setupDone, items, errors: [{ text, source, line }] (oldest first), dropped, known }.
	 * Every value from outside the catalog goes through scrub().
	 */
	function buildEnv(info = {}) {
		let short = v => scrub(v, { max: 80 }) || "不明";
		let ids = list => (list || []).filter(id => /^[A-Za-z][A-Za-z0-9]*$/.test(String(id)));
		let lines = [
			`ZotMax：${short(info.version)}`,
			`Zotero：${short(info.zotero)}`,
			`系統：${short(info.os)}`,
			`語言：${short(info.locale)}`,
		];
		let preset = PRESET_LABELS[info.preset] ? info.preset : "custom";
		let base = PRESET_LABELS[info.base] && info.base !== "custom" ? info.base : "guided";
		lines.push(preset === "custom" ? `模式：自訂（最接近${PRESET_LABELS[base]}）` : `模式：${PRESET_LABELS[preset]}`);
		let on = ids(info.on);
		let off = ids(info.off);
		let parts = [];
		if (on.length) parts.push(`多開 ${on.join("、")}`);
		if (off.length) parts.push(`關掉 ${off.join("、")}`);
		lines.push(`和模式不同的開關：${parts.length ? parts.join("；") : "無"}`);
		lines.push(`筆記：Obsidian ${yes(info.obsidian)}，Notion ${yes(info.notion)}`);
		let ai = info.ai || {};
		lines.push(ai.configured ? `AI：有設定（${PROVIDER_NAMES[ai.provider] || "其他"}）` : "AI：沒有設定");
		lines.push(`設定精靈：${info.setupDone ? "已完成" : "沒完成"}`);
		lines.push(`文獻數：${bucket(info.items)}`);
		let errors = (info.errors || []).slice(-MAX_ERRORS);
		if (!errors.length) {
			lines.push("最近的 ZotMax 錯誤：沒有");
		}
		else {
			lines.push("最近的 ZotMax 錯誤（已移除路徑、網址、email、token 與引號裡的文字）：");
			// Newest first
			errors.slice().reverse().forEach((e, i) => {
				let where = fileLine(e.source, e.line);
				let text = scrub(e.text, { known: info.known }) || "（沒有訊息）";
				lines.push(`${i + 1}. ${where ? `[${where}] ` : ""}${text}`);
			});
		}
		if (info.dropped) lines.push(`（另有 ${Number(info.dropped) || 0} 則較舊的錯誤，網址放不下）`);
		return lines.join("\n");
	}

	function issueURL(template, fields) {
		let q = [`template=${encodeURIComponent(template)}`];
		for (let [k, v] of Object.entries(fields || {})) q.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
		return `${ISSUE_URL}?${q.join("&")}`;
	}

	/**
	 * The 回報問題 URL for this environment, at most opts.max characters: older errors go first, then
	 * (never in practice) the text is cut. { url, env, dropped } — env is exactly the text in the URL.
	 */
	function reportURL(info = {}, opts = {}) {
		let max = opts.max || MAX_URL;
		let errors = (info.errors || []).slice(-MAX_ERRORS);
		let url;
		let env;
		for (let keep = errors.length; keep >= 0; keep--) {
			let dropped = errors.length - keep;
			env = buildEnv(Object.assign({}, info, { errors: errors.slice(dropped), dropped }));
			url = issueURL(TEMPLATES.bug, { [FIELDS.env]: env });
			if (url.length <= max) return { url, env, dropped };
		}
		// Still too long: cut the text (whole characters) until it fits
		let lo = 0;
		let hi = env.length;
		while (lo < hi) {
			let mid = Math.ceil((lo + hi) / 2);
			if (issueURL(TEMPLATES.bug, { [FIELDS.env]: env.slice(0, mid) + "…" }).length <= max) lo = mid;
			else hi = mid - 1;
		}
		env = env.slice(0, lo) + "…";
		return { url: issueURL(TEMPLATES.bug, { [FIELDS.env]: env }), env, dropped: errors.length };
	}

	/** The 試用回饋 URL: the version line and the mode filled in. { url, version, preset } */
	function feedbackURL(info = {}) {
		let version = `ZotMax ${scrub(info.version, { max: 40 }) || "不明"} · Zotero ${scrub(info.zotero, { max: 40 }) || "不明"}`;
		let preset = PRESET_LABELS[info.preset] || PRESET_LABELS.custom;
		return { url: issueURL(TEMPLATES.feedback, { [FIELDS.version]: version, [FIELDS.preset]: preset }), version, preset };
	}

	// ---------- reading the profile (Zotero) ----------

	function pref(key) {
		try {
			return Zotero.Prefs.get(PREF + key, true);
		}
		catch (e) {
			return undefined;
		}
	}

	async function hasSecret(name) {
		try {
			return !!String((await ZB().secrets.get(name)) || "").trim();
		}
		catch (e) {
			return false;
		}
	}

	async function osName() {
		try {
			if (typeof Zotero.getOSVersion === "function") {
				let v = await Zotero.getOSVersion();
				if (v) return String(v);
			}
		}
		catch (e) {}
		try {
			return `${Services.sysinfo.getProperty("name")} ${Services.sysinfo.getProperty("version")}`;
		}
		catch (e) {}
		return String(Zotero.platform || "");
	}

	/** Regular items in My Library (not notes, attachments, annotations or the trash). */
	async function itemCount() {
		let libraryID = Zotero.Libraries.userLibraryID;
		try {
			if (Zotero.DB && Zotero.DB.valueQueryAsync) {
				let n = await Zotero.DB.valueQueryAsync("SELECT COUNT(*) FROM items JOIN itemTypes USING (itemTypeID) WHERE libraryID=? "
					+ "AND typeName NOT IN ('note', 'attachment', 'annotation') AND itemID NOT IN (SELECT itemID FROM deletedItems)", [libraryID]);
				if (typeof n === "number") return n;
			}
		}
		catch (e) {}
		try {
			let all = await Zotero.Items.getAll(libraryID, true);
			return ZB().adapter.toRegularItems(all || []).length;
		}
		catch (e) {
			return null;
		}
	}

	/** The console's errors as plain records, oldest first. */
	function consoleMessages() {
		let out = [];
		let list = [];
		try {
			list = Services.console.getMessageArray() || [];
		}
		catch (e) {
			return out;
		}
		let Ci = Components.interfaces;
		for (let msg of list) {
			try {
				let se = msg.QueryInterface(Ci.nsIScriptError);
				let kind = se.flags & Ci.nsIScriptError.warningFlag ? "warning" : se.flags & Ci.nsIScriptError.infoFlag ? "info" : "error";
				out.push({ text: se.errorMessage, source: se.sourceName, line: se.lineNumber, kind });
			}
			catch (e) {
				// A plain console message (no source): not an error
			}
		}
		return out;
	}

	/** The profile's own names, removed from error messages wherever they appear. */
	function knownNames() {
		let out = [];
		let add = (v) => {
			v = String(v == null ? "" : v).trim();
			if (v) out.push(v);
		};
		let vault = pref("obsidian.vaultPath");
		add(vault);
		add(basename(vault));
		add(pref("obsidian.vaultName"));
		add(pref("notion.database"));
		try {
			for (let r of JSON.parse(pref("routing.rules") || "[]")) {
				for (let k of ["name", "collection", "notionDatabase", "obsidianFolder"]) add(r && r[k]);
			}
		}
		catch (e) {}
		for (let k of ["homeDir", "profileDir", "tempDir"]) {
			try {
				add(PathUtils[k]);
				if (k === "homeDir") add(basename(PathUtils[k]));
			}
			catch (e) {}
		}
		try {
			add(Zotero.DataDirectory.dir);
		}
		catch (e) {}
		try {
			add(Services.env.get("USER"));
			add(Services.env.get("USERNAME"));
		}
		catch (e) {}
		try {
			for (let c of Zotero.Collections.getByLibrary(Zotero.Libraries.userLibraryID, true).slice(0, 500)) add(c.name);
		}
		catch (e) {}
		return out;
	}

	/** Everything buildEnv() needs, read from the profile. */
	async function gather() {
		let F = ZB().features;
		let diff = presetDiff(F.FEATURES, F.snapshot());
		let provider = pref("llm.provider") === "openai" ? "openai" : "anthropic";
		let notionDB = !!String(pref("notion.database") || "").trim();
		let [notionToken, aiKey, os, items] = await Promise.all([
			notionDB ? hasSecret("notionToken") : false,
			hasSecret(provider === "openai" ? "openaiKey" : "anthropicKey"),
			osName(),
			itemCount(),
		]);
		return Object.assign(diff, {
			version: ZB().version || "",
			zotero: Zotero.version || "",
			os,
			locale: Zotero.locale || "",
			obsidian: !!String(pref("obsidian.vaultPath") || "").trim(),
			notion: notionDB && notionToken,
			ai: { configured: aiKey, provider },
			setupDone: pref("setup.done") === true,
			items,
			errors: pickErrors(consoleMessages()),
			known: knownNames(),
		});
	}

	// ---------- the commands ----------

	/**
	 * What the dialog and the browser act on; tests replace them. confirm() → "open" | "copy" | "cancel"
	 * (a native confirm: the primary button, 取消, and 「複製」 when given).
	 */
	const runtime = {
		confirm(win, title, text, buttons) {
			let p = Services.prompt;
			let flags = p.BUTTON_POS_0 * p.BUTTON_TITLE_IS_STRING + p.BUTTON_POS_1 * p.BUTTON_TITLE_CANCEL + p.BUTTON_POS_0_DEFAULT;
			if (buttons.copy) flags += p.BUTTON_POS_2 * p.BUTTON_TITLE_IS_STRING;
			// Closing the dialog also answers 1 (取消)
			let b = p.confirmEx(win, title, text, flags, buttons.open, null, buttons.copy || null, null, {});
			return b === 0 ? "open" : b === 2 ? "copy" : "cancel";
		},
		launch: url => Zotero.launchURL(url),
		copy: text => Zotero.Utilities.Internal.copyTextToClipboard(text),
	};

	function mainWindow(win) {
		try {
			return Zotero.getMainWindow() || win || null;
		}
		catch (e) {
			return win || null;
		}
	}

	async function localize() {
		let main = mainWindow();
		return ZB().palette.localizeStrings(main && main.document, STRINGS);
	}

	function failed(string, e) {
		Zotero.logError(e);
		if (alive()) ZB().main.notify("ZotMax", string("failed", { error: (e && e.message) || e }));
	}

	/**
	 * 回報問題…: show the environment text, then open the bug form with it. win: the window the dialog
	 * belongs to (the main window, or the settings window). Resolves to { action, url, env } or null.
	 */
	async function reportIssue(win, opts = {}) {
		if (!alive()) return null;
		let string = await localize();
		if (!alive()) return null;
		try {
			let info = await gather();
			if (!alive()) return null;
			let r = reportURL(info);
			let body = `${string("reportLead")}\n\n${string("reportPrivacy")}\n\n${string("reportEnv")}\n\n${r.env}`;
			let note = "";
			// 「複製」 closes a native dialog: show it again (a few times at most) so GitHub can still be opened
			for (let i = 0; i < 5; i++) {
				let choice = runtime.confirm(win || mainWindow(), string("reportTitle"), note + body, { open: string("open"), copy: string("copy") });
				if (!alive()) return null;
				if (choice === "copy") {
					runtime.copy(r.env);
					note = `${string("copied")}\n\n`;
					continue;
				}
				if (choice !== "open") return { action: "cancel", url: r.url, env: r.env };
				runtime.launch(r.url);
				return { action: "open", url: r.url, env: r.env };
			}
			return { action: "cancel", url: r.url, env: r.env };
		}
		catch (e) {
			failed(string, e);
			return null;
		}
	}

	/** 試用回饋…: say what the questionnaire is, then open it with the version and mode filled in. */
	async function trialFeedback(win) {
		if (!alive()) return null;
		let string = await localize();
		if (!alive()) return null;
		try {
			let r = feedbackURL({ version: ZB().version, zotero: Zotero.version, preset: ZB().features.currentPreset() });
			let body = `${string("feedbackLead")}\n\n${string("feedbackPrivacy")}\n\n${string("feedbackFill")}\n${r.version}\n${r.preset}`;
			let choice = runtime.confirm(win || mainWindow(), string("feedbackTitle"), body, { open: string("open") });
			if (!alive()) return null;
			if (choice !== "open") return { action: "cancel", url: r.url };
			runtime.launch(r.url);
			return { action: "open", url: r.url };
		}
		catch (e) {
			failed(string, e);
			return null;
		}
	}

	self = {
		REPO_URL, ISSUE_URL, TEMPLATES, FIELDS, MAX_URL, MAX_ERRORS, STRINGS, PRESET_LABELS,
		scrub, bucket, presetDiff, fileLine, pickErrors, buildEnv, issueURL, reportURL, feedbackURL,
		gather, knownNames, reportIssue, trialFeedback, runtime,
	};
	return self;
});
