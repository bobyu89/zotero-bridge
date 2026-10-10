// 回報問題 and 試用回饋 (content/report.js), the pure parts: scrub() (the privacy-critical part: Windows,
// macOS and Linux paths, user names in paths, emails, tokens, URLs, IDs, quoted titles, the profile's own
// names), buildEnv(), the URLs and their length cap, and the GitHub issue forms in .github/ISSUE_TEMPLATE
// (they parse, have the keys GitHub requires, and the field IDs the plugin fills in exist).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const R = require("../content/report.js");
const F = require("../content/features.js");

const ROOT = path.join(__dirname, "..");
const TEMPLATE_DIR = path.join(ROOT, ".github", "ISSUE_TEMPLATE");

/** No fragment of `secrets` survives in `text`. */
function leaksNone(text, secrets) {
	for (let s of secrets) assert.ok(!text.includes(s), `${JSON.stringify(s)} leaked in ${JSON.stringify(text)}`);
}

// ---------- scrub: paths ----------

test("scrub: Windows paths, with spaces in folder and file names, forward slashes, JSON-escaped, %APPDATA%, UNC", () => {
	let cases = [
		["Could not open C:\\Users\\Bob Chen\\Documents\\Obsidian Vault\\Zotero\\Smith 2020 - Falls in elders.md at line 3",
			["Bob", "Chen", "Obsidian Vault", "Smith", "2020", "Falls", "elders"], "Could not open [路徑] at line 3"],
		["C:/Users/bob/AppData/Roaming/Zotero/Zotero/Profiles/abcd1234.default/prefs.js", ["bob", "abcd1234", "Profiles"], "[路徑]"],
		["{\"path\":\"C:\\\\Users\\\\bob\\\\vault\\\\note.md\"}", ["bob", "vault", "note"], null],
		["%APPDATA%\\Zotero\\Profiles\\x7.default\\zotero.sqlite", ["APPDATA", "x7.default"], "[路徑]"],
		["\\\\fileserver\\share\\research\\cohort data.xlsx missing", ["fileserver", "share", "research", "cohort"], "[路徑] missing"],
		["D:\\論文\\第二章 文獻探討.docx 寫入失敗", ["論文", "第二章", "文獻探討"], "[路徑] 寫入失敗"],
	];
	for (let [input, secrets, expected] of cases) {
		let out = R.scrub(input);
		leaksNone(out, secrets);
		if (expected) assert.equal(out, expected);
	}
});

test("scrub: macOS and Linux paths, home folders, ~/, user names inside them; words around are kept", () => {
	let cases = [
		["NotFoundError: /Users/Bob Yu/Library/Application Support/Zotero/Profiles/x.default/zotero.sqlite is missing",
			["Bob", "Yu", "Application Support", "x.default"], "NotFoundError: [路徑] is missing"],
		["/Users/alice/My Vault/Chen 2021 pain study.pdf could not be read", ["alice", "Vault", "Chen", "pain"], "[路徑] could not be read"],
		["/home/alice/.zotero/zotero/x.default/ and ~/Zotero/storage/ABCD1234/paper.pdf", ["alice", "ABCD1234", "paper"], null],
		["path=/Volumes/USB/thesis/data.sav", ["USB", "thesis", "data"], "path=[路徑]"],
		["(/mnt/c/Users/bob/vault)", ["bob", "vault"], "([路徑])"],
		["/tmp/zb-e2e/vault-setup/Zotero", ["zb-e2e", "vault-setup"], "[路徑]"],
	];
	for (let [input, secrets, expected] of cases) {
		let out = R.scrub(input);
		leaksNone(out, secrets);
		if (expected) assert.equal(out, expected);
	}
});

test("scrub: relative paths and document names go; ordinary slashes and Chinese stay", () => {
	leaksNone(R.scrub("Zotero/全文/Lin 2019 跌倒.md"), ["全文", "Lin", "跌倒"]);
	leaksNone(R.scrub("wrote Smith2020-falls.md and references.bib"), ["Smith2020", "falls", "references"]);
	assert.equal(R.scrub("標題/摘要：納入 and/or 1/2, N = 120/240"), "標題/摘要：納入 and/or 1/2, N = 120/240");
	assert.equal(R.scrub("Notion API 400: validation_error"), "Notion API 400: validation_error");
	assert.equal(R.scrub("TypeError: can't access property \"title\", item is undefined"), "TypeError: can't access property \"title\", item is undefined");
});

// ---------- scrub: URLs, emails, tokens, IDs ----------

test("scrub: URLs keep only a known API host; the plugin's own files keep their name and position", () => {
	assert.equal(R.scrub("GET https://api.notion.com/v1/databases/0123456789abcdef0123456789abcdef/query?filter=x failed"),
		"GET https://api.notion.com/… failed");
	assert.equal(R.scrub("https://example.edu/private/thesis?token=abc"), "[網址]");
	assert.equal(R.scrub("proxy http://ezproxy.mylib.edu.tw:8080/login?url=x"), "proxy [網址]");
	let creds = R.scrub("https://bob:hunter2@api.openai.com/v1/chat/completions");
	assert.equal(creds, "https://api.openai.com/…");
	leaksNone(R.scrub("open obsidian://open?vault=My%20Thesis&file=Smith%202020"), ["Thesis", "Smith"]);
	leaksNone(R.scrub("zotero://select/library/items/ABCD1234"), ["ABCD1234"]);
	assert.equal(R.scrub("at jar:file:///C:/Users/bob/AppData/Roaming/Zotero/Profiles/x/extensions/zotero-bridge@bobyu89.github.io.xpi!/content/main.js:123:5"),
		"at main.js:123:5");
	// A file URL that isn't the plugin: gone
	assert.equal(R.scrub("file:///Users/bob/vault/Lin%202019.md failed."), "[路徑] failed.");
	// Gecko's and Zotero's own files say nothing about the user
	assert.equal(R.scrub("chrome://zotero/content/xpcom/http.js:200"), "chrome://zotero/content/xpcom/http.js:200");
	leaksNone(R.scrub("data:text/plain;base64,U2VjcmV0IG5vdGVz"), ["U2VjcmV0"]);
});

test("scrub: emails go (the plugin ID is kept), tokens and secrets go", () => {
	assert.equal(R.scrub("mail bob.chen@ntu.edu.tw about zotero-bridge@bobyu89.github.io"), "mail [email] about zotero-bridge@bobyu89.github.io");
	let tokens = [
		"ntn_123456789012345678901234567890abcdefABCDEF",
		"secret_ABCDEFGHIJ1234567890abcdefghij",
		"sk-ant-api03-e2eTESTkey_0123456789abcdef",
		"sk-proj-abcdefghijklmnopqrstuvwxyz012345",
		"sk-abcdefghijklmnopqrstuv",
		"ghp_abcdefghijklmnopqrstuvwxyz0123456789",
		"AIzaSyA-1234567890abcdefghij",
	];
	for (let t of tokens) {
		let out = R.scrub(`key was ${t}.`);
		leaksNone(out, [t, t.slice(-12)]);
		assert.match(out, /\[token\]/);
	}
	leaksNone(R.scrub("Authorization: Bearer abcdef.ghijk-123456"), ["abcdef", "ghijk"]);
	leaksNone(R.scrub("x-api-key: 0a1b2c3d4e5f; api_key=supersecret123&tool=zb password='p@ss word'"), ["0a1b2c3d4e5f", "supersecret123", "p@ss"]);
	// Not a secret: an ordinary sentence with the word token
	assert.equal(R.scrub("SyntaxError: unexpected token: }"), "SyntaxError: unexpected token: }");
});

test("scrub: Notion IDs, UUIDs and long keys go; short words and error names stay", () => {
	assert.equal(R.scrub("Could not find database with ID: 0123456789abcdef0123456789abcdef."), "Could not find database with ID: [ID].");
	assert.equal(R.scrub("page 01234567-89ab-cdef-0123-456789abcdef not found"), "page [ID] not found");
	leaksNone(R.scrub("ncbi key 0123abcd4567efgh8901ijkl2345"), ["0123abcd4567efgh8901ijkl2345"]);
	assert.equal(R.scrub("NS_ERROR_FILE_ACCESS_DENIED"), "NS_ERROR_FILE_ACCESS_DENIED");
	assert.equal(R.scrub("zotero-bridge-cmd-report-issue"), "zotero-bridge-cmd-report-issue");
});

test("scrub: quoted text (titles, names, column names) goes unless it is a plain identifier", () => {
	assert.equal(R.scrub("Could not find \"Effects of exercise on falls in older adults\""), "Could not find \"…\"");
	assert.equal(R.scrub("同步「護理人員的職場霸凌經驗：質性研究」失敗"), "同步「…」失敗");
	assert.equal(R.scrub("Notion property “研究設計” is missing"), "Notion property “…” is missing");
	assert.equal(R.scrub("collection 'Falls RCTs' not found"), "collection '…' not found");
	assert.equal(R.scrub("pref \"obsidian.vaultPath\" is empty"), "pref \"obsidian.vaultPath\" is empty");
	assert.equal(R.scrub("can't read 'foo' of undefined"), "can't read 'foo' of undefined");
});

test("scrub: the profile's own names (vault, user name, collections) go wherever they appear; product names stay", () => {
	let known = ["My Thesis Vault", "alice", "跌倒預防", "Zotero", "Obsidian", "ab"];
	let out = R.scrub("vault My Thesis Vault of alice (alicex) in 跌倒預防; Zotero and Obsidian ab", { known });
	assert.equal(out, "vault [已隱藏] of [已隱藏] (alicex) in [已隱藏]; Zotero and Obsidian ab");
	// Case-insensitive for ASCII names
	assert.equal(R.scrub("ALICE wrote", { known }), "[已隱藏] wrote");
});

test("scrub: whitespace collapses, length is capped without cutting a placeholder, odd input is safe and fast", () => {
	assert.equal(R.scrub("a\n\n  b\tc"), "a b c");
	assert.equal(R.scrub(null), "");
	assert.equal(R.scrub(undefined), "");
	assert.equal(R.scrub(42), "42");
	let long = R.scrub("x".repeat(1000));
	assert.equal(long.length, 241);
	assert.ok(long.endsWith("…"));
	let cut = R.scrub(`${"y ".repeat(118)}/Users/bob/vault/a.md tail`, { max: 240 });
	assert.ok(!/[\uE000\uE001]/.test(cut), "no private-use marker left");
	leaksNone(cut, ["bob", "vault"]);
	// Markers in the input can't be used to pull parked text back out
	assert.equal(R.scrub("\uE0000\uE001 C:\\Users\\bob"), "0 [路徑]");
	let start = Date.now();
	R.scrub("/a b".repeat(5000));
	R.scrub("C:\\a b c d e f g h ".repeat(800));
	R.scrub(`"${"word ".repeat(2000)}`);
	R.scrub("\\\\srv\\" + "w ".repeat(3000));
	assert.ok(Date.now() - start < 1000, "no catastrophic backtracking");
});

// ---------- the environment text ----------

function envInfo(over = {}) {
	return Object.assign({
		version: "0.14.0", zotero: "10.0.3", os: "Windows 11 10.0", locale: "zh-TW",
		preset: "guided", base: "guided", on: [], off: [],
		obsidian: true, notion: false, ai: { configured: true, provider: "anthropic" },
		setupDone: true, items: 250, errors: [], known: [],
	}, over);
}

test("presetDiff: guided, advanced, custom against the nearest preset", () => {
	let guided = Object.fromEntries(F.FEATURES.map(f => [f.id, f.presets.guided]));
	let advanced = Object.fromEntries(F.FEATURES.map(f => [f.id, f.presets.advanced]));
	assert.deepEqual(R.presetDiff(F.FEATURES, guided), { preset: "guided", base: "guided", on: [], off: [] });
	assert.deepEqual(R.presetDiff(F.FEATURES, advanced), { preset: "advanced", base: "advanced", on: [], off: [] });
	let custom = Object.assign({}, guided, { synthesis: true, sync: false });
	assert.deepEqual(R.presetDiff(F.FEATURES, custom), { preset: "custom", base: "guided", on: ["synthesis"], off: ["sync"] });
	let nearAdvanced = Object.assign({}, advanced, { pubmedWatch: false });
	assert.deepEqual(R.presetDiff(F.FEATURES, nearAdvanced), { preset: "custom", base: "advanced", on: [], off: ["pubmedWatch"] });
});

test("buildEnv: every field, yes/no for the note targets and AI, the library as a bucket, no errors", () => {
	let env = R.buildEnv(envInfo());
	assert.equal(env, [
		"ZotMax：0.14.0",
		"Zotero：10.0.3",
		"系統：Windows 11 10.0",
		"語言：zh-TW",
		"模式：研究生引導",
		"和模式不同的開關：無",
		"筆記：Obsidian 有設定，Notion 沒有",
		"AI：有設定（Claude）",
		"設定精靈：已完成",
		"文獻數：100–1000",
		"最近的 ZotMax 錯誤：沒有",
	].join("\n"));
	let custom = R.buildEnv(envInfo({ preset: "custom", base: "advanced", on: ["synthesis"], off: ["pubmedWatch", "sync"], notion: true, obsidian: false,
		ai: { configured: false, provider: "openai" }, setupDone: false, items: null, os: "", version: undefined }));
	assert.match(custom, /^ZotMax：不明$/m);
	assert.match(custom, /^系統：不明$/m);
	assert.match(custom, /^模式：自訂（最接近進階）$/m);
	assert.match(custom, /^和模式不同的開關：多開 synthesis；關掉 pubmedWatch、sync$/m);
	assert.match(custom, /^筆記：Obsidian 沒有，Notion 有設定$/m);
	assert.match(custom, /^AI：沒有設定$/m);
	assert.match(custom, /^設定精靈：沒完成$/m);
	assert.match(custom, /^文獻數：不明$/m);
	assert.match(R.buildEnv(envInfo({ ai: { configured: true, provider: "openai" } })), /^AI：有設定（OpenAI）$/m);
	// Switch IDs come from the catalog; anything else is dropped
	assert.doesNotMatch(R.buildEnv(envInfo({ on: ["../../etc", "a b", "statsExplainer"] })), /etc|a b/);
	assert.deepEqual([0, 99, 100, 1000, 1001, -1, NaN, null].map(R.bucket), ["<100", "<100", "100–1000", "100–1000", ">1000", "不明", "不明", "不明"]);
});

test("buildEnv: the last five ZotMax errors, newest first, as file:line + scrubbed message; nothing private", () => {
	let errors = [];
	for (let i = 1; i <= 7; i++) {
		errors.push({ text: `Error ${i}: could not write C:\\Users\\bob\\My Vault\\Lin ${i}.md for bob.chen@ntu.edu.tw with ntn_abcdefghijklmnop${i}`,
			source: `jar:file:///C:/Users/bob/AppData/Roaming/Zotero/Profiles/p/extensions/zotero-bridge@bobyu89.github.io.xpi!/content/main.js`, line: 100 + i });
	}
	errors.push({ text: "TypeError: x is undefined (in My Thesis Vault)", source: "file:///Users/bob/private.js", line: 3 });
	let env = R.buildEnv(envInfo({ errors, known: ["My Thesis Vault"] }));
	leaksNone(env, ["bob", "Vault", "Lin ", "ntu.edu.tw", "ntn_", "private.js", "Profiles", "Thesis"]);
	let lines = env.split("\n");
	let head = lines.findIndex(l => l.startsWith("最近的 ZotMax 錯誤"));
	assert.ok(head > 0);
	let listed = lines.slice(head + 1);
	assert.equal(listed.length, 5, "the last five");
	assert.equal(listed[0], "1. TypeError: x is undefined (in [已隱藏])", "newest first; a non-plugin file has no position");
	assert.equal(listed[1], "2. [main.js:107] Error 7: could not write [路徑] for [email] with [token]");
	assert.match(listed[4], /^5\. \[main\.js:104\] Error 4:/);
});

test("fileLine and pickErrors: only the plugin's (or Gecko's) file names; ZotMax errors only, warnings left out", () => {
	assert.equal(R.fileLine("jar:file:///C:/x/zotero-bridge@bobyu89.github.io.xpi!/content/report.js", 12), "report.js:12");
	assert.equal(R.fileLine("chrome://zotero-bridge/content/setup.js", 0), "setup.js");
	assert.equal(R.fileLine("chrome://zotero/content/xpcom/db.js", 5), "db.js:5");
	assert.equal(R.fileLine("file:///Users/bob/Thesis%20draft.html", 1), "");
	assert.equal(R.fileLine("", 1), "");
	let messages = [
		{ text: "a", source: "chrome://zotero/content/x.js", kind: "error" },
		{ text: "ZotMax: sync failed", source: "", kind: "error" },
		{ text: "w", source: "jar:file:///p/zotero-bridge@bobyu89.github.io.xpi!/content/main.js", kind: "warning" },
		...Array.from({ length: 6 }, (_, i) => ({ text: `e${i}`, source: "jar:file:///p/zotero-bridge@bobyu89.github.io.xpi!/content/main.js", line: i, kind: "error" })),
	];
	assert.deepEqual(R.pickErrors(messages).map(m => m.text), ["e1", "e2", "e3", "e4", "e5"]);
	assert.deepEqual(R.pickErrors(messages.slice(0, 3)).map(m => m.text), ["ZotMax: sync failed"]);
	assert.deepEqual(R.pickErrors(null), []);
});

// ---------- URLs ----------

test("reportURL: issues/new?template=bug.yml&env=<the env text>; the env shown is exactly what is in the URL", () => {
	let r = R.reportURL(envInfo());
	assert.ok(r.url.startsWith("https://github.com/bobyu89/zotero-bridge/issues/new?template=bug.yml&env="), r.url);
	let u = new URL(r.url);
	assert.equal(u.searchParams.get("template"), "bug.yml");
	assert.equal(u.searchParams.get(R.FIELDS.env), r.env);
	assert.equal(r.env, R.buildEnv(envInfo()));
	assert.equal(r.dropped, 0);
});

test("reportURL: at most 6000 characters; older errors are dropped first and said so, then the text is cut", () => {
	let errors = Array.from({ length: 5 }, (_, i) => ({ text: `E${i} ${"資料庫連線失敗 ".repeat(40)}`, source: "chrome://zotero-bridge/content/main.js", line: i }));
	let r = R.reportURL(envInfo({ errors }));
	assert.ok(r.url.length <= R.MAX_URL, `${r.url.length}`);
	assert.ok(r.dropped > 0 && r.dropped < 5, `dropped ${r.dropped}`);
	assert.match(r.env, new RegExp(`（另有 ${r.dropped} 則較舊的錯誤，網址放不下）`));
	assert.match(r.env, /\[main\.js:4\] E4/, "the newest error stays");
	assert.doesNotMatch(r.env, /\[main\.js:0\] E0/, "the oldest goes first");
	assert.equal(new URL(r.url).searchParams.get("env"), r.env);
	// A tiny limit: everything goes, then the text is cut to fit
	let tiny = R.reportURL(envInfo({ errors }), { max: 400 });
	assert.ok(tiny.url.length <= 400, `${tiny.url.length}`);
	assert.ok(tiny.env.endsWith("…"));
	assert.equal(new URL(tiny.url).searchParams.get("env"), tiny.env);
});

test("feedbackURL: template=feedback.yml with the version line and the mode", () => {
	let r = R.feedbackURL({ version: "0.14.0", zotero: "10.0.3", preset: "advanced" });
	let u = new URL(r.url);
	assert.equal(u.origin + u.pathname, "https://github.com/bobyu89/zotero-bridge/issues/new");
	assert.equal(u.searchParams.get("template"), "feedback.yml");
	assert.equal(u.searchParams.get("version"), "ZotMax 0.14.0 · Zotero 10.0.3");
	assert.equal(u.searchParams.get("preset"), "進階");
	assert.equal(new URL(R.feedbackURL({ preset: "custom" }).url).searchParams.get("preset"), "自訂");
	assert.equal(new URL(R.feedbackURL({}).url).searchParams.get("version"), "ZotMax 不明 · Zotero 不明");
});

// ---------- the issue forms ----------

/**
 * A small YAML reader for the subset the issue forms use: block maps and lists, "- key: value" items,
 * plain, single- and double-quoted scalars, flow lists of scalars, | block scalars, true/false and
 * integers. Anything outside that subset (a plain scalar with ": ", a tab, a bad indent) throws, so a
 * template GitHub would reject fails here too.
 */
function parseYAML(src) {
	assert.ok(!/\t/.test(src), "no tabs in YAML");
	let lines = src.replace(/\r/g, "").split("\n");
	let i = 0;
	let indentOf = l => /^ */.exec(l)[0].length;
	let blank = l => !l.trim() || /^\s*#/.test(l);
	let skip = () => {
		while (i < lines.length && blank(lines[i])) i++;
	};
	let isItem = t => t === "-" || t.startsWith("- ");
	function splitFlow(s) {
		let out = [];
		let cur = "";
		let quote = null;
		for (let ch of s) {
			if (quote) {
				cur += ch;
				if (ch === quote) quote = null;
			}
			else if (ch === "\"" || ch === "'") {
				quote = ch;
				cur += ch;
			}
			else if (ch === ",") {
				out.push(cur);
				cur = "";
			}
			else cur += ch;
		}
		out.push(cur);
		return out;
	}
	function scalar(v, line) {
		v = v.trim();
		if (v === "") return null;
		if (v.startsWith("\"")) {
			assert.ok(v.endsWith("\""), `line ${line}: unterminated string`);
			return JSON.parse(v);
		}
		if (v.startsWith("'")) {
			assert.ok(v.endsWith("'"), `line ${line}: unterminated string`);
			return v.slice(1, -1).replace(/''/g, "'");
		}
		if (v.startsWith("[")) {
			assert.ok(v.endsWith("]"), `line ${line}: unterminated flow list`);
			let inner = v.slice(1, -1).trim();
			return inner ? splitFlow(inner).map(x => scalar(x, line)) : [];
		}
		assert.ok(!/^[{&*!%@`|>?]/.test(v), `line ${line}: a plain scalar can't start with ${v[0]}`);
		v = v.replace(/\s+#.*$/, "");
		assert.ok(!/:\s/.test(v) && !v.endsWith(":"), `line ${line}: ": " inside a plain scalar: ${v}`);
		if (v === "true") return true;
		if (v === "false") return false;
		if (/^-?\d+$/.test(v)) return Number(v);
		return v;
	}
	function blockScalar(indent) {
		let out = [];
		let inner = null;
		while (i < lines.length) {
			let l = lines[i];
			if (!l.trim()) {
				out.push("");
				i++;
				continue;
			}
			let li = indentOf(l);
			if (li <= indent) break;
			if (inner === null) inner = li;
			assert.ok(li >= inner, `line ${i + 1}: block scalar indentation`);
			out.push(l.slice(inner));
			i++;
		}
		while (out.length && out[out.length - 1] === "") out.pop();
		return out.join("\n") + "\n";
	}
	function value(rest, indent) {
		if (rest === undefined || !rest.trim()) {
			skip();
			if (i < lines.length && (indentOf(lines[i]) > indent || (indentOf(lines[i]) === indent && isItem(lines[i].trim())))) return block();
			return null;
		}
		if (/^[|>][-+]?$/.test(rest.trim())) return blockScalar(indent);
		return scalar(rest, i);
	}
	function map(indent) {
		let out = {};
		for (;;) {
			skip();
			if (i >= lines.length) break;
			let l = lines[i];
			let li = indentOf(l);
			if (li < indent || (li === indent && isItem(l.trim()))) break;
			assert.equal(li, indent, `line ${i + 1}: indentation`);
			let m = /^([^:"'#][^:]*?):(?:\s+(.*))?$/.exec(l.trim());
			assert.ok(m, `line ${i + 1}: not a key: ${l.trim()}`);
			let key = m[1].trim();
			assert.ok(!(key in out), `line ${i + 1}: duplicate key ${key}`);
			i++;
			out[key] = value(m[2], indent);
		}
		return out;
	}
	function list(indent) {
		let out = [];
		for (;;) {
			skip();
			if (i >= lines.length) break;
			let l = lines[i];
			if (indentOf(l) !== indent || !isItem(l.trim())) break;
			let rest = l.trim().slice(1).trim();
			if (!rest) {
				i++;
				out.push(block());
				continue;
			}
			if (/^[^"'[{][^:]*:(\s|$)/.test(rest)) {
				// "- key: value": a map whose keys line up with this one
				lines[i] = " ".repeat(indent + 2) + rest;
				out.push(map(indent + 2));
				continue;
			}
			i++;
			out.push(scalar(rest, i));
		}
		return out;
	}
	function block() {
		skip();
		let l = lines[i];
		return isItem(l.trim()) ? list(indentOf(l)) : map(indentOf(l));
	}
	let result = block();
	skip();
	assert.equal(i, lines.length, `line ${i + 1}: not parsed`);
	return result;
}

function template(name) {
	return parseYAML(fs.readFileSync(path.join(TEMPLATE_DIR, name), "utf8"));
}

/** What GitHub's issue form schema requires (docs: Syntax for issue forms / GitHub's form schema). */
function checkForm(form, file) {
	for (let k of ["name", "description", "body"]) assert.ok(form[k], `${file}: ${k}`);
	assert.ok(Array.isArray(form.body) && form.body.length, `${file}: body`);
	let ids = new Set();
	for (let el of form.body) {
		assert.ok(["markdown", "textarea", "input", "dropdown", "checkboxes", "upload"].includes(el.type), `${file}: type ${el.type}`);
		assert.ok(el.attributes && typeof el.attributes === "object", `${file}: attributes`);
		if (el.type === "markdown") {
			assert.ok(typeof el.attributes.value === "string" && el.attributes.value.trim(), `${file}: markdown value`);
			assert.equal(el.id, undefined, `${file}: markdown has no id`);
			continue;
		}
		assert.ok(typeof el.attributes.label === "string" && el.attributes.label.trim(), `${file}: label`);
		assert.match(String(el.id), /^[A-Za-z0-9_-]+$/, `${file}: id ${el.id}`);
		assert.ok(!ids.has(el.id), `${file}: duplicate id ${el.id}`);
		ids.add(el.id);
		if (el.type === "dropdown") {
			let opts = el.attributes.options;
			assert.ok(Array.isArray(opts) && opts.length && new Set(opts).size === opts.length, `${file}: ${el.id} options`);
			assert.ok(opts.every(o => typeof o === "string" && !/^(none|n\/a)$/i.test(o)), `${file}: ${el.id} option text`);
		}
		if (el.type === "checkboxes") {
			assert.ok(Array.isArray(el.attributes.options) && el.attributes.options.every(o => o && typeof o.label === "string"), `${file}: ${el.id} options`);
		}
	}
	return ids;
}

function field(form, id) {
	return form.body.find(el => el.id === id);
}

test("issue forms: bug.yml parses, has GitHub's required keys, and the env field the plugin fills in", () => {
	let bug = template("bug.yml");
	let ids = checkForm(bug, "bug.yml");
	assert.equal(bug.name, "回報問題");
	assert.ok(ids.has(R.FIELDS.env), "the env field the URL fills in");
	let env = field(bug, R.FIELDS.env);
	assert.equal(env.type, "textarea", "prefilled fields must be text fields");
	assert.equal(env.attributes.render, "text", "env shows as a code block, never as Markdown");
	assert.equal(R.TEMPLATES.bug, "bug.yml");
	for (let id of ["steps", "actual", "expected", "screenshots"]) assert.equal(field(bug, id).type, "textarea", id);
	assert.equal(field(bug, "actual").validations.required, true);
	assert.match(bug.body[0].attributes.value, /公開/);
	assert.match(bug.body[0].attributes.value, /病人/);
});

test("issue forms: feedback.yml is a short questionnaire; only usefulness is required; version and preset are fillable text fields", () => {
	let fb = template("feedback.yml");
	let ids = checkForm(fb, "feedback.yml");
	assert.equal(fb.name, "試用回饋");
	for (let id of [R.FIELDS.version, R.FIELDS.preset]) {
		assert.ok(ids.has(id), id);
		assert.equal(field(fb, id).type, "input", `${id} must be a text field to be prefilled`);
	}
	let required = fb.body.filter(el => el.validations && el.validations.required).map(el => el.id);
	assert.deepEqual(required, ["usefulness"]);
	assert.deepEqual(field(fb, "usefulness").attributes.options.map(o => o[0]), ["5", "4", "3", "2", "1"]);
	let stuck = field(fb, "setup-stuck").attributes.options;
	// The 6 steps of the 設定精靈, in order, + 其他
	let STEPS = ["歡迎", "選模式", "筆記放哪裡", "AI（選填）", "試一次", "完成"];
	assert.deepEqual(stuck.slice(1, 7), STEPS.map((s, i) => `${i + 1} ${s}`));
	assert.equal(stuck.at(-1), "其他");
	assert.deepEqual(field(fb, "features").attributes.options.map(o => o.label), [
		"同步到 Obsidian／Notion", "側邊面板（ZotMax 面板）", "快速指令", "閱讀狀態", "文獻自動分類", "評讀表", "篩選／PRISMA",
		"中文文獻補強", "AI 筆記", "評讀陪練", "讀懂統計", "其他",
	]);
	for (let id of ["setup-finished", "confusing", "remove", "keep-using", "comments"]) assert.ok(ids.has(id), id);
	assert.match(fb.body[0].attributes.value, /未發表/);
	assert.match(fb.body[0].attributes.value, /病人/);
	// About five minutes: a handful of questions
	assert.ok(fb.body.filter(el => el.type !== "markdown").length <= 12);
});

test("issue forms: config.yml allows blank issues and links the site's install wizard", () => {
	let config = template("config.yml");
	assert.equal(config.blank_issues_enabled, true);
	assert.equal(config.contact_links.length, 1);
	let link = config.contact_links[0];
	for (let k of ["name", "url", "about"]) assert.ok(link[k], k);
	assert.equal(link.url, "https://bobyu89.github.io/zotero-bridge/#install");
	// The parser itself refuses what GitHub would
	assert.throws(() => parseYAML("name: a: b\n"));
	assert.throws(() => parseYAML("a: 1\na: 2\n"));
	assert.deepEqual(parseYAML("a:\n  - x: 1\n    y: \"q\"\n  - z\nb: |\n  l1\n  l2\nc: [\"p\", q]\n"), { a: [{ x: 1, y: "q" }, "z"], b: "l1\nl2\n", c: ["p", "q"] });
});

test("the site links both forms (without environment details)", () => {
	let html = fs.readFileSync(path.join(ROOT, "site", "index.html"), "utf8");
	assert.ok(html.includes("https://github.com/bobyu89/zotero-bridge/issues/new?template=bug.yml\""));
	assert.ok(html.includes("https://github.com/bobyu89/zotero-bridge/issues/new?template=feedback.yml\""));
});
