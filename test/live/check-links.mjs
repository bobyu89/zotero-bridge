#!/usr/bin/env node
/*
 * Live check of the external services ZotMax depends on (run by .github/workflows/link-check.yml;
 * not part of `npm test`, it needs the open internet).
 *
 *   1. Every entry of both search catalogs — content/search-links.js (plugin) and site/search.html
 *      (window.ZBSearch, loaded in jsdom) — is opened with a sample query: plain fetch (redirects
 *      followed, cookies kept, browser-like headers, 20 s timeout) and, when Playwright is installed,
 *      a headless Chromium render. Each is classified: search results page / homepage / login /
 *      blocked from CI / broken. Alternative URL shapes are probed for the uncertain sources.
 *   2. NCBI E-utilities (esearch/esummary, db=pubmed and db=mesh) through the plugin's own URL
 *      builders and parsers, asserting the exact JSON fields the code reads.
 *   3. OpenAlex (works/doi:, works/pmid:, filter=cites:/cited_by:, select=, sort=, cursor paging,
 *      mailto) through citation-chase.js's URL builders, client and chase().
 *
 * Output: <out>/report.md (also appended to $GITHUB_STEP_SUMMARY) and <out>/report.json.
 * Exit code 1 only on clear breakage: HTTP 404/410, malformed URL, unknown host, or a field/param
 * mismatch in NCBI/OpenAlex. Sites that block datacenter IPs are "blocked from CI (inconclusive)".
 *
 *   node test/live/check-links.mjs [--out dir] [--only id,id] [--no-browser] [--no-alt] [--skip-catalog] [--skip-api]
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const searchLinks = require(path.join(ROOT, "content", "search-links.js"));
const pubmedWatch = require(path.join(ROOT, "content", "pubmed-watch.js"));
const citationChase = require(path.join(ROOT, "content", "citation-chase.js"));

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const opt = (name, def) => {
	let i = args.indexOf(name);
	return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const OUT = path.resolve(opt("--out", path.join(ROOT, "link-check-out")));
const ONLY = new Set(String(opt("--only", "")).split(",").map(s => s.trim()).filter(Boolean));
const TODAY = new Date().toISOString().slice(0, 10);

const QUERY_EN = "fall prevention older adults";
const QUERY_ZH = "跌倒 預防";
// Widely cited nursing paper: Aiken et al. 2002, JAMA, "Hospital nurse staffing and patient mortality…"
const TEST_PMID = "12387650";
const TEST_DOI = "10.1001/jama.288.16.1987";
const CONTACT = process.env.LINKCHECK_EMAIL || "zotero-bridge-link-check@example.org";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const TIMEOUT_MS = 20000;
const DELAY_MS = 1500;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

function cookieHeader(jar, url) {
	let host = new URL(url).hostname;
	let out = [];
	for (let [domain, cookies] of jar) {
		if (host === domain || host.endsWith("." + domain)) for (let [k, v] of cookies) out.push(`${k}=${v}`);
	}
	return out.join("; ");
}

function storeCookies(jar, url, res) {
	let list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
	for (let c of list) {
		let [pair, ...attrs] = c.split(";");
		let eq = pair.indexOf("=");
		if (eq < 1) continue;
		let domain = new URL(url).hostname;
		for (let a of attrs) {
			let m = /^\s*domain=\.?(.+)$/i.exec(a);
			if (m) domain = m[1].trim().toLowerCase();
		}
		if (!jar.has(domain)) jar.set(domain, new Map());
		jar.get(domain).set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
	}
}

/** GET with manual redirects (chain recorded), a cookie jar and browser-like headers. */
async function fetchTrace(url, { accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", maxBytes = 3e6 } = {}) {
	let jar = new Map();
	let chain = [];
	let current = url;
	let started = Date.now();
	for (let hop = 0; hop < 12; hop++) {
		let res;
		try {
			let headers = {
				"User-Agent": UA,
				Accept: accept,
				"Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
				"Upgrade-Insecure-Requests": "1",
			};
			let cookie = cookieHeader(jar, current);
			if (cookie) headers.Cookie = cookie;
			res = await fetch(current, { redirect: "manual", headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
		}
		catch (e) {
			let cause = e.cause || {};
			let code = cause.code || e.name || "";
			return { url, finalUrl: current, chain, status: 0, error: `${code} ${cause.message || e.message || e}`.trim(), errorCode: code, ms: Date.now() - started, headers: {}, body: "" };
		}
		storeCookies(jar, current, res);
		chain.push({ url: current, status: res.status });
		let loc = res.headers.get("location");
		if (res.status >= 300 && res.status < 400 && loc) {
			try {
				current = new URL(loc, current).toString();
			}
			catch (e) {
				return { url, finalUrl: current, chain, status: res.status, error: `bad Location: ${loc}`, ms: Date.now() - started, headers: {}, body: "" };
			}
			continue;
		}
		let headers = Object.fromEntries([...res.headers].map(([k, v]) => [k.toLowerCase(), v]));
		let body = "";
		try {
			let buf = Buffer.from(await res.arrayBuffer());
			body = buf.subarray(0, maxBytes).toString("utf8");
		}
		catch (e) {
			return { url, finalUrl: current, chain, status: res.status, error: `body: ${e.message || e}`, ms: Date.now() - started, headers, body: "" };
		}
		return { url, finalUrl: current, chain, status: res.status, headers, body, ms: Date.now() - started };
	}
	return { url, finalUrl: current, chain, status: 0, error: "too many redirects", ms: Date.now() - started, headers: {}, body: "" };
}

async function getJSON(url) {
	let r;
	// Retry network errors, 429 and 5xx (NCBI/OpenAlex hiccups are not breakage)
	for (let attempt = 0; attempt < 3; attempt++) {
		r = await fetchTrace(url, { accept: "application/json" });
		if (r.status && r.status !== 429 && r.status < 500) break;
		await sleep(2000 * (attempt + 1));
	}
	let json = null;
	let parseError = "";
	if (r.body) {
		try {
			json = JSON.parse(r.body);
		}
		catch (e) {
			parseError = e.message;
		}
	}
	return { ...r, json, parseError };
}

// ---------------------------------------------------------------------------------------------
// Browser (optional)
// ---------------------------------------------------------------------------------------------

let browser = null;
async function startBrowser() {
	if (flag("--no-browser")) return null;
	try {
		const { chromium } = await import("playwright");
		browser = await chromium.launch({ headless: true });
		log(`browser: Chromium ${browser.version()}`);
		return browser;
	}
	catch (e) {
		log(`browser: not available (${String(e.message || e).split("\n")[0]}); plain fetch only`);
		return null;
	}
}

async function render(url) {
	if (!browser) return null;
	let ctx = await browser.newContext({ userAgent: UA, locale: "zh-TW", viewport: { width: 1280, height: 900 } });
	let page = await ctx.newPage();
	let started = Date.now();
	try {
		let res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
		await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
		await sleep(1500);
		let data = await page.evaluate(() => ({
			title: document.title || "",
			text: (document.body && document.body.innerText || "").slice(0, 300000),
			inputs: [...document.querySelectorAll("input, textarea")].map(i => i.value || "").filter(Boolean).slice(0, 50),
			passwords: document.querySelectorAll("input[type=password]").length,
		}));
		let html = (await page.content()).slice(0, 3e6);
		return { status: res ? res.status() : 0, finalUrl: page.url(), html, ...data, ms: Date.now() - started };
	}
	catch (e) {
		return { status: 0, finalUrl: page.url(), error: String(e.message || e).split("\n")[0], ms: Date.now() - started, html: "", text: "", inputs: [], title: "" };
	}
	finally {
		await ctx.close().catch(() => {});
	}
}

/**
 * Type the query into the site's own search box and submit: the URL the site lands on shows
 * whether it has a GET search URL (for the sources that only open their homepage).
 */
async function discover(home, query) {
	if (!browser) return null;
	let ctx = await browser.newContext({ userAgent: UA, locale: "zh-TW", viewport: { width: 1280, height: 900 } });
	let page = await ctx.newPage();
	try {
		await page.goto(home, { waitUntil: "domcontentloaded", timeout: 30000 });
		await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
		let selectors = [
			"input[type=search]:visible",
			"input[name*=search i]:visible", "input[id*=search i]:visible", "input[placeholder*=search i]:visible",
			"input[name*=query i]:visible", "input[name*=keyword i]:visible", "input[name=q]:visible",
			"input[placeholder*=搜尋]:visible", "input[placeholder*=查詢]:visible", "input[placeholder*=檢索]:visible", "input[placeholder*=關鍵]:visible",
			"input[type=text]:visible",
		].map(sel => sel.replace(":visible", ":not([type=checkbox]):not([type=radio]):not([type=hidden]):visible"));
		let box = null;
		for (let sel of selectors) {
			let loc = page.locator(sel).first();
			if (await loc.count().catch(() => 0)) {
				box = { sel, loc };
				break;
			}
		}
		if (!box) return { error: "no search box found", finalUrl: page.url() };
		let before = page.url();
		await box.loc.fill(query, { timeout: 5000 });
		await Promise.all([
			page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {}),
			box.loc.press("Enter"),
		]);
		await page.waitForURL(u => String(u) !== before, { timeout: 15000 }).catch(() => {});
		await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
		await sleep(1500);
		let pages = ctx.pages();
		let target = pages[pages.length - 1];
		let finalUrl = target.url();
		let text = await target.evaluate(() => (document.body && document.body.innerText || "").slice(0, 200000)).catch(() => "");
		let title = await target.title().catch(() => "");
		let enc = encodeURIComponent(query.split(" ")[0]);
		let inUrl = finalUrl.includes(enc) || decodeURIComponentSafe(finalUrl).includes(query.split(" ")[0]);
		return { selector: box.sel, finalUrl, title, inUrl, changed: finalUrl !== before, evidence: evidence(query, text, null) };
	}
	catch (e) {
		return { error: String(e.message || e).split("\n")[0], finalUrl: page.url() };
	}
	finally {
		await ctx.close().catch(() => {});
	}
}

function decodeURIComponentSafe(s) {
	try {
		return decodeURIComponent(s);
	}
	catch (e) {
		return s;
	}
}

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------

const VERDICTS = {
	"ok-search": { rank: 0, label: "✅ OK search page" },
	"ok-echo": { rank: 1, label: "✅ OK (query echoed, no result-count marker)" },
	"ok-home": { rank: 1, label: "✅ OK homepage (copy query, expected)" },
	"login-expected": { rank: 2, label: "🔐 needs login (expected)" },
	"login": { rank: 3, label: "⚠️ login wall (unexpected)" },
	"homepage": { rank: 4, label: "⚠️ homepage / query dropped" },
	"unclear": { rank: 5, label: "❔ loaded, query not found" },
	"blocked": { rank: 6, label: "🚧 blocked from CI (inconclusive)" },
	"timeout": { rank: 7, label: "⏱️ timeout / server error (inconclusive)" },
	"broken": { rank: 8, label: "❌ broken", fail: true },
};

// Result markers per source (raw HTML or rendered text)
const HINTS = {
	"pubmed": /class="results-amount"|class="docsum-title"|search-results-chunk/,
	"pubmed-cq": /clinical-queries|results-amount|Clinical Study Categories|clinical-results/i,
	"mesh": /class="rslt"|class="rprt"|Items:\s*\d|MeSH Unique ID|Search results/i,
	"cochrane": /search-results-section|class="search-results|result-title|Cochrane Reviews\s*\(\d/i,
	"scholar": /class="gs_ri"|class="gs_r gs_or|id="gs_res_ccl/,
	"europepmc": /\bresults?\b[\s\S]{0,40}\d|\d[\d,]*\s+results?/i,
	"semantic": /cl-paper-row|data-test-id="result-page"|data-test-id="search-result/i,
	"trip": /class="result|search-result|Results\s*\(\d|\d[\d,]*\s+results?/i,
	"clinicaltrials": /\d[\d,]*\s+Stud(?:y|ies)\s+found|Showing\s+\d|studies found|results-header/i,
	"nice": /results? for|SearchResults|search-result|\d[\d,]*\s+results?/i,
	"cdc": /search results|results for|\d[\d,]*\s+results?|class="result/i,
	"google": /id="search"|id="rso"|class="g\b/,
	"uptodate": /search-results|searchResults|class="search-result/i,
	"airiti": /search-?result|\d[\d,]*\s*筆|共\s*[\d,]+/i,
	"ictrp": /records? for|\d[\d,]*\s+records?|GridView|search-results/i,
	"embase": /search-results|results-list/i,
	"cinahl": /resultListControl|result-list|class="record-formats/i,
};

const COUNT_RE = /\b\d[\d,.]*\s+(?:results?|studies|records|hits|items|matches|documents|articles|reviews|trials|papers|publications)\b|\b(?:of|about)\s+[\d,]+\s+results?\b|\bresults?\s+for\b|共\s*[\d,]+\s*筆|[\d,]+\s*筆資料|找到\s*[\d,]+/i;
const LOGIN_URL_RE = /(?:^|[./_-])(?:login|logon|signin|sign-in|sso|authenticate|authorize|openathens|shibboleth|wayf|idp|cas)(?:[./_?-]|$)/i;
const PASSWORD_RE = /<input[^>]+type=["']?password/i;

function hintKey(id, url) {
	let host = "";
	try {
		host = new URL(url).hostname;
	}
	catch (e) {}
	if (/google\./.test(host) && !/scholar/.test(host)) return "google";
	return { "ctgov": "clinicaltrials", "gguide": "google", "guideline-pdf": "google", "tw-gov": "google", "tpi": "ncl-periodicals" }[id] || id;
}

function visibleText(html) {
	return String(html || "")
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
		.replace(/\s+/g, " ");
}

function titleOf(html) {
	let m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || "");
	return m ? visibleText(m[1]).trim().slice(0, 120) : "";
}

function inputValues(html) {
	return [...String(html || "").matchAll(/<input[^>]*\svalue=["']([^"']*)["']/gi)].map(m => m[1]);
}

function echoed(q, { text = "", inputs = [], title = "" }) {
	let needle = /[一-鿿]/.test(q) ? "跌倒" : "fall prevention";
	let hay = [text, title, ...inputs].join(" \n ").toLowerCase();
	return hay.includes(needle) || hay.includes(needle.replace(" ", "+"));
}

function blockedReason(r, text) {
	let h = r.headers || {};
	let body = String(r.body || r.html || "").slice(0, 400000);
	let url = r.finalUrl || "";
	if (h["cf-mitigated"]) return `Cloudflare challenge (cf-mitigated: ${h["cf-mitigated"]})`;
	if (/<title>\s*Just a moment\.\.\.|cf-browser-verification|cf_chl_opt|Attention Required! \| Cloudflare|challenges\.cloudflare\.com\/turnstile/i.test(body)) return "Cloudflare challenge";
	if (/google\.[a-z.]+\/(?:sorry|httpservice\/retry\/enablejs)/.test(url) || /\/httpservice\/retry\/enablejs|If you're having trouble accessing Google Search|請按這裡|Please click <a[^>]*>here<\/a> if you are not redirected/i.test(body)) return "Google JavaScript/bot interstitial";
	if (/google\.[a-z.]+\/sorry\//.test(url) || /unusual traffic from your computer network|detected unusual traffic/i.test(body)) return "Google \"unusual traffic\" / captcha";
	if (/Incapsula incident|_Incapsula_Resource/i.test(body)) return "Imperva/Incapsula";
	if (/errors\.edgesuite\.net|Access Denied[\s\S]{0,600}Reference #/i.test(body)) return "Akamai \"Access Denied\"";
	if (/aws-waf-token|awswaf/i.test(body) && (r.status === 202 || r.status === 403 || r.status === 405)) return "AWS WAF challenge";
	if (/px-captcha|perimeterx/i.test(body)) return "PerimeterX captcha";
	if (/(?:verify (?:that )?you are (?:a )?human|are you a robot|bot detection|請證明您不是機器人)/i.test(text || body)) return "captcha / bot check";
	if (r.status === 403 || r.status === 429 || r.status === 401) return `HTTP ${r.status}`;
	if (r.status === 503 && /cloudflare/i.test(h.server || "")) return "Cloudflare 503";
	return "";
}

function isHomeUrl(finalUrl, home) {
	try {
		let u = new URL(finalUrl);
		if ((u.pathname === "/" || u.pathname === "") && !u.search) return true;
		if (home) {
			let h = new URL(home);
			return u.hostname === h.hostname && u.pathname.replace(/\/+$/, "") === h.pathname.replace(/\/+$/, "") && !u.search;
		}
	}
	catch (e) {}
	return false;
}

/**
 * One observation (fetch or render) → { code, why }.
 * entry: { kind: "search"|"home", needsAccess, query, key, home }
 */
function classify(entry, r, via) {
	if (!r) return null;
	if (r.error && !r.status) {
		if (/ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED/i.test(r.error)) return { code: "broken", why: `${via}: host not found (${r.error})` };
		if (/timeout|Timeout|ETIMEDOUT|AbortError/i.test(r.error)) return { code: "timeout", why: `${via}: ${r.error}` };
		return { code: "timeout", why: `${via}: ${r.error}` };
	}
	let html = r.body !== undefined ? r.body : r.html;
	let text = r.text !== undefined && r.text ? r.text : visibleText(html);
	let title = r.title || titleOf(html);
	let inputs = r.inputs || inputValues(html);
	let finalUrl = r.finalUrl || entry.url;
	let echo = entry.kind === "search" && echoed(entry.query, { text, inputs, title });
	let hint = HINTS[entry.key];
	let marker = (hint && (hint.test(html || "") || hint.test(text))) || COUNT_RE.test(text);
	let u = (() => {
		try {
			return new URL(finalUrl);
		}
		catch (e) {
			return null;
		}
	})();
	let loginUrl = u && LOGIN_URL_RE.test(u.hostname + u.pathname) && !(entry.key === "cinahl" && /search\.ebscohost\.com$/.test(u.hostname) && /\/login\.aspx$/i.test(u.pathname) && !PASSWORD_RE.test(html || "") && !r.passwords);
	// Many sites carry a sign-in box in the header: only a page titled as a login page counts
	let loginForm = (PASSWORD_RE.test(html || "") || r.passwords > 0) && (/log\s?in|log\s?on|sign\s?in|登入|帳號|welcome to ovid/i.test(title) || !text.trim() || text.length < 3000);
	let at = `${via}: HTTP ${r.status}${finalUrl !== entry.url ? ` → ${short(finalUrl)}` : ""}${title ? ` 「${title.slice(0, 70)}」` : ""}`;

	if (r.status === 404 || r.status === 410) return { code: "broken", why: `${at} (not found)` };
	let ev = evidence(entry.query, text, hint);
	if (r.status >= 200 && r.status < 300 && entry.kind === "search" && echo && marker && !loginForm) return { code: "ok-search", why: `${at}; query echoed + result marker${ev}` };
	let blocked = blockedReason(r, text);
	if (blocked) return { code: "blocked", why: `${at}; ${blocked}` };
	if (loginUrl || (loginForm && !echo)) return { code: entry.needsAccess ? "login-expected" : "login", why: `${at}; ${loginUrl ? "login URL" : "password field"}` };
	if (r.status >= 500) return { code: "timeout", why: `${at} (server error)` };
	if (r.status >= 400) return { code: "broken", why: `${at}` };
	if (entry.kind === "home") return { code: entry.needsAccess ? "login-expected" : "ok-home", why: `${at}${entry.needsAccess ? "; host responds (subscription site)" : ""}` };
	if (echo) return { code: "ok-echo", why: `${at}; query echoed, no result-count marker${ev}` };
	if (entry.needsAccess) return { code: "login-expected", why: `${at}; host responds, query not shown (subscription site)` };
	if (isHomeUrl(finalUrl, entry.home)) return { code: "homepage", why: `${at}; redirected to the homepage` };
	return { code: "unclear", why: `${at}; query not found in page${ev}` };
}

/** Short quotes from the page: where the query appears and the first result-count marker. */
function evidence(q, text, hint) {
	let t = String(text || "").replace(/\s+/g, " ");
	let out = [];
	let needle = /[一-鿿]/.test(q) ? "跌倒" : "fall prevention";
	let i = t.toLowerCase().indexOf(needle);
	if (i >= 0) out.push(`echo「${t.slice(Math.max(0, i - 40), i + 70).trim()}」`);
	let m = COUNT_RE.exec(t) || (hint && hint.exec(t));
	if (m) out.push(`marker「${t.slice(Math.max(0, m.index - 50), m.index + m[0].length + 50).trim()}」`);
	return out.length ? "; " + out.join("; ") : "";
}

function short(url, n = 90) {
	url = String(url || "");
	return url.length > n ? url.slice(0, n - 1) + "…" : url;
}

function combine(a, b) {
	let list = [a, b].filter(Boolean);
	list.sort((x, y) => VERDICTS[x.code].rank - VERDICTS[y.code].rank);
	let best = list[0];
	// A page that merely lacks the query, next to a bot wall seen by the other client, is a bot wall
	if (best.code === "unclear" && list.some(x => x.code === "blocked")) best = list.find(x => x.code === "blocked");
	// A 404 from the plain fetch is decisive unless the rendered page found the results (SPA routes)
	return { code: best.code, why: list.map(x => x.why).join(" | ") };
}

function wellFormed(entry) {
	let problems = [];
	let u;
	try {
		u = new URL(entry.url);
	}
	catch (e) {
		return [`not a URL: ${e.message}`];
	}
	if (u.protocol !== "https:") problems.push(`protocol ${u.protocol}`);
	if (/[{}]/.test(entry.url)) problems.push("unfilled {placeholder}");
	if (/\s/.test(entry.url)) problems.push("unencoded whitespace");
	if (entry.kind === "search") {
		let enc = encodeURIComponent(entry.query.split(" ")[0]);
		if (!entry.url.includes(enc) && !entry.url.includes(entry.query.split(" ")[0])) problems.push("query missing from URL");
	}
	return problems;
}

// ---------------------------------------------------------------------------------------------
// Catalogs
// ---------------------------------------------------------------------------------------------

function pluginEntries() {
	let cfg = searchLinks.normalizeConfig({});
	return cfg.all.map((s) => {
		let query = s.lang === "zh" ? QUERY_ZH : QUERY_EN;
		let t = searchLinks.buildTarget(s, query, cfg);
		return {
			catalog: "plugin", id: s.id, name: s.name, kind: t.copy ? "home" : "search", needsAccess: !!s.needsAccess,
			query: t.copy ? query : t.query.includes(query) ? query : t.query, url: t.url, home: s.home || "",
			label: searchLinks.CHECK_LABELS[s.check] || s.check, key: hintKey(s.id, t.url),
		};
	});
}

async function siteEntries() {
	const { JSDOM, VirtualConsole } = await import("jsdom");
	let html = fs.readFileSync(path.join(ROOT, "site", "search.html"), "utf8");
	let vc = new VirtualConsole();
	let dom = new JSDOM(html, { url: "https://bobyu89.github.io/zotero-bridge/search.html", runScripts: "dangerously", virtualConsole: vc });
	let Z = dom.window.ZBSearch;
	let out = Z.SOURCES.map((s) => {
		let query = s.group === "zh" ? QUERY_ZH : QUERY_EN;
		let r = Z.buildUrl(s, query, "");
		let kind = s.status === "home" || !s.search ? "home" : "search";
		return {
			catalog: "site", id: s.id, name: s.name, kind, needsAccess: s.access === "inst",
			query, url: r.url, home: s.home, label: { sure: "確定", guess: "推測", home: "首頁" }[s.status] || s.status,
			key: hintKey(s.id, r.url),
		};
	});
	dom.window.close();
	return out;
}

// Alternative URL shapes for uncertain sources: evidence for a fix if the catalog URL fails
const ALTERNATIVES = {
	"pubmed-cq": ["https://pubmed.ncbi.nlm.nih.gov/clinical/?term={q}&clinical_study_category=therapy_broad"],
	"cochrane": [
		"https://www.cochranelibrary.com/advanced-search?q={q}",
		"https://www.cochranelibrary.com/search?q={q}",
		"https://www.cochranelibrary.com/en/search?q={q}",
	],
	"cinahl": [
		"https://search.ebscohost.com/login.aspx?direct=true&db=rzh&bquery={q}&type=1&searchMode=And&site=ehost-live",
		"https://search.ebscohost.com/login.aspx?direct=true&scope=site&db=rzh&bquery={q}&type=0&site=ehost-live",
		"https://research.ebsco.com/",
	],
	"embase": ["https://www.embase.com/search/results?query={q}"],
	"trip": [
		"https://www.tripdatabase.com/Searchresult?criteria={q}",
		"https://www.tripdatabase.com/search?criteria={q}",
	],
	"uptodate": ["https://www.uptodate.com/contents/search?search={q}&searchType=PLAIN_TEXT"],
	"nice": ["https://www.nice.org.uk/search?q={q}", "https://www.nice.org.uk/guidance/published?q={q}"],
	"cdc": [
		"https://search.cdc.gov/search/?query={q}",
		"https://www.cdc.gov/search/?query={q}",
		"https://www.cdc.gov/search/index.html?query={q}",
	],
	"ictrp": ["https://trialsearch.who.int/?SearchAll={q}", "https://trialsearch.who.int/Default.aspx?SearchAll={q}"],
	"airiti": [
		"https://www.airitilibrary.com/Search/alldb?SearchText={q}",
		"https://www.airitilibrary.com/Search/Articles?SearchText={q}",
		"https://www.airitilibrary.com/Article/Search?SearchText={q}",
	],
	"ndltd": ["https://ndltd.ncl.edu.tw/cgi-bin/gs32/gsweb.cgi?o=dnclcdr&s=&searchstr={q}"],
	"ncl-periodicals": ["https://tpl.ncl.edu.tw/NclService/SearchResult?keyword={q}"],
	"jbi": ["https://ovidsp.ovid.com/ovidweb.cgi?T=JS&NEWS=N&PAGE=main&D=jbi"],
};

// ---------------------------------------------------------------------------------------------
// Running the catalog checks
// ---------------------------------------------------------------------------------------------

const probeCache = new Map();
// Homepage-only sources whose own search box is tried in the browser
const DISCOVER = new Set(["airiti", "ndltd", "ncl-periodicals", "ictrp", "cochrane"]);

async function probe(entry) {
	let cacheKey = `${entry.kind}|${entry.needsAccess}|${entry.url}`;
	if (probeCache.has(cacheKey)) return { ...probeCache.get(cacheKey), cached: true };
	let problems = wellFormed(entry);
	if (problems.length && problems.some(p => /not a URL|placeholder|query missing|protocol/.test(p))) {
		let res = { code: "broken", why: `malformed URL: ${problems.join(", ")}`, fetch: null, render: null };
		probeCache.set(cacheKey, res);
		return res;
	}
	let f = await fetchTrace(entry.url);
	let cf = classify(entry, f, "fetch");
	let rr = null;
	let cr = null;
	if (browser && !(cf && cf.code === "ok-search")) {
		rr = await render(entry.url);
		cr = classify(entry, rr, "browser");
	}
	let v = combine(cf, cr);
	let res = {
		...v,
		fetch: { status: f.status, finalUrl: f.finalUrl, chain: f.chain.map(c => `${c.status} ${short(c.url, 120)}`), error: f.error || "", title: titleOf(f.body), server: (f.headers || {}).server || "", ms: f.ms },
		render: rr ? { status: rr.status, finalUrl: rr.finalUrl, title: rr.title, error: rr.error || "", textSample: String(rr.text || "").replace(/\s+/g, " ").slice(0, 300), ms: rr.ms } : null,
	};
	probeCache.set(cacheKey, res);
	await sleep(DELAY_MS);
	return res;
}

function suggestion(entry, res, alts) {
	let good = (alts || []).filter(a => ["ok-search", "ok-echo"].includes(a.code));
	switch (res.code) {
		case "broken":
			if (/malformed/.test(res.why)) return "Fix the URL template in the catalog.";
			if (/host not found/.test(res.why)) return "The host does not resolve: the site moved to another domain?";
			return good.length ? `Use the working shape: \`${good[0].template}\`` : "The path is gone: open the site, run a search and copy the results-page URL (query → {q}); until then use homepage + copy.";
		case "homepage":
		case "unclear":
			if (entry.kind === "home") return "";
			return good.length ? `Query parameter not honoured; this shape worked: \`${good[0].template}\`` : "Query parameter not honoured (or JS-only search): downgrade to 推測 / homepage + copy unless verified in a browser.";
		case "login":
			return "Free source ended on a login page: check whether the search now needs an account; consider homepage + copy.";
		case "blocked":
			return "Site blocks datacenter IPs/bots — verify manually in a browser; keep the current label.";
		case "timeout":
			return "Re-run; if persistent the host may be down or blocking.";
		default:
			return "";
	}
}

async function runCatalogs(report) {
	let plugin = pluginEntries();
	let site = await siteEntries();
	let entries = [...plugin, ...site].filter(e => !ONLY.size || ONLY.has(e.id));
	for (let e of entries) {
		log(`[${e.catalog}] ${e.id}: ${short(e.url, 110)}`);
		let res = await probe(e);
		let alts = [];
		if (!flag("--no-alt") && ALTERNATIVES[e.key] && !["ok-search"].includes(res.code)) {
			for (let template of ALTERNATIVES[e.key]) {
				let q = e.query;
				let url = searchLinks.fillTemplate(template, q);
				let alt = { ...e, url, kind: template.includes("{q}") ? "search" : "home" };
				let r = await probe(alt);
				alts.push({ template, url, code: r.code, why: r.why });
				log(`    alt ${VERDICTS[r.code].label}  ${short(url, 100)}\n        ${short(r.why, 400)}`);
			}
		}
		let found = null;
		if (browser && e.kind === "home" && !e.needsAccess && DISCOVER.has(e.key)) {
			let key = `discover|${e.home}|${e.query}`;
			if (!probeCache.has(key)) probeCache.set(key, await discover(e.home || e.url, e.query));
			found = probeCache.get(key);
			if (found) log(`    discover: ${found.error || `${found.inUrl ? "query in URL" : "query not in URL"} → ${found.finalUrl} ${found.evidence || ""}`}`);
		}
		let row = { ...e, ...res, label_verdict: VERDICTS[res.code].label, alts, discovered: found, fix: "" };
		row.fix = suggestion(e, res, alts);
		report.catalog.push(row);
		log(`  → ${VERDICTS[res.code].label}  ${short(res.why, 400)}`);
		if (res.code === "login-expected" && res.fetch && res.fetch.chain.length > 1) log(`    chain: ${res.fetch.chain.join(" → ")}`);
	}
}

// Plugin links built outside the catalogs: the PubMed record, Similar articles, find-this-paper queries
async function runExtraLinks(report) {
	let cfg = searchLinks.normalizeConfig({});
	let info = searchLinks.itemInfo({ title: "Hospital nurse staffing and patient mortality, nurse burnout, and job dissatisfaction", doi: TEST_DOI, extra: "" });
	let byId = id => searchLinks.findSource(cfg, id);
	let checks = [
		{ id: "pubmed-record", name: "PubMed record …/<PMID>/", kind: "search", url: `https://pubmed.ncbi.nlm.nih.gov/${TEST_PMID}/`, query: "Hospital nurse staffing", key: "pubmed-record" },
		{ id: "pubmed-related", name: "PubMed Similar articles (relatedURL)", kind: "search", url: searchLinks.relatedURL(TEST_PMID), query: "fall prevention", key: "pubmed" },
		{ id: "pubmed-doi", name: "PubMed find by DOI ([doi])", kind: "search", url: searchLinks.buildTarget(byId("pubmed"), searchLinks.findQuery(byId("pubmed"), info).query, cfg).url, query: "Hospital nurse staffing", key: "pubmed-record" },
		{ id: "pubmed-title", name: "PubMed find by title ([ti])", kind: "search", url: searchLinks.buildTarget(byId("pubmed"), searchLinks.findQuery(byId("pubmed"), { ...info, doi: "" }).query, cfg).url, query: "Hospital nurse staffing", key: "pubmed-record" },
		{ id: "mesh-lookup", name: "MeSH lookup (meshLookupURL)", kind: "search", url: searchLinks.meshLookupURL("Accidental Falls"), query: "Accidental Falls", key: "mesh" },
		{ id: "pubmed-mesh", name: "PubMed \"Heading\"[Mesh] search", kind: "search", url: searchLinks.buildTarget(byId("pubmed"), "\"Accidental Falls\"[Mesh]", cfg).url, query: "Accidental Falls", key: "pubmed" },
	];
	for (let c of checks) {
		let f = await fetchTrace(c.url);
		let text = visibleText(f.body);
		let echo = text.toLowerCase().includes(c.query.toLowerCase()) || titleOf(f.body).toLowerCase().includes(c.query.toLowerCase());
		let ok = f.status >= 200 && f.status < 300 && echo;
		let extra = "";
		if (c.id === "pubmed-related") {
			ok = f.status >= 200 && f.status < 300 && /from_uid=12387650|Similar articles|linkname=pubmed_pubmed/i.test(f.body) && /results-amount|docsum-title/.test(f.body);
			extra = ok ? "results list for Similar articles" : "";
		}
		if (c.id === "pubmed-doi" || c.id === "pubmed-title") {
			// PubMed jumps straight to the record when exactly one paper matches
			let single = new RegExp(`/${TEST_PMID}/?$`).test(new URL(f.finalUrl).pathname) || f.body.includes(`data-article-pmid="${TEST_PMID}"`) || new RegExp(`<strong class="current-id"[^>]*>${TEST_PMID}<`).test(f.body);
			ok = f.status >= 200 && f.status < 300 && single;
			let count = (/<span class="value">([\d,]+)<\/span>\s*results/.exec(f.body) || [])[1];
			let first = (/data-article-id="(\d+)"/.exec(f.body) || /data-chunk-ids="(\d+)/.exec(f.body) || [])[1];
			if (!single && count && f.body.includes(`/${TEST_PMID}/`)) ok = true;
			extra = single ? `resolves to PMID ${TEST_PMID}` : `${count || "?"} results${f.body.includes(`/${TEST_PMID}/`) ? `, PMID ${TEST_PMID} listed` : ", target not listed"}${first ? `; first ${first}` : ""}`;
		}
		report.extra.push({ ...c, status: f.status, finalUrl: f.finalUrl, ok, why: `${f.error || ""} HTTP ${f.status}; ${titleOf(f.body)} ${extra}`.trim() });
		log(`[extra] ${c.id}: ${ok ? "OK" : "CHECK"} HTTP ${f.status} ${short(f.finalUrl)}`);
		await sleep(800);
	}
	// PubMed "find by title": which title query shapes find the paper (esearch count and whether the PMID is in it)
	let title = info.title;
	let variants = [
		["plugin findQuery (title words [ti])", searchLinks.findQuery(byId("pubmed"), { ...info, doi: "" }).query],
		["no punctuation: \"title\"[ti]", `"${title.replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/\s+/g, " ").trim()}"[ti]`],
		["unquoted title[ti]", `${title}[ti]`],
		["words AND [ti]", title.replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter(w => w.length > 2 && !/^(?:and|the|for|with|of)$/i.test(w)).map(w => `${w}[ti]`).join(" AND ")],
		["plain title (ATM)", title],
	];
	for (let [label, term] of variants) {
		let r = await getJSON(pubmedWatch.esearchURL(term, { retmax: 20 }, {}));
		let p = r.json && r.json.esearchresult ? pubmedWatch.parseESearch(r.json) : { count: "?", ids: [], warnings: [] };
		let hit = p.ids.includes(TEST_PMID);
		report.extra.push({ id: "pubmed-title-variant", name: `PubMed title search: ${label}`, url: term, status: r.status, ok: hit, why: `\`${short(term, 120)}\` → count ${p.count}${hit ? `, PMID ${TEST_PMID} found` : ", target not found"}${p.warnings.length ? `; ${p.warnings.join(" / ")}` : ""}` });
		log(`[extra] pubmed title ${label}: count ${p.count} hit=${hit} ${p.warnings.join(" / ")}`);
		await sleep(400);
	}
	// Europe PMC "find this paper" query syntax (EXT_ID / DOI / TITLE) through its REST API
	let epmc = byId("europepmc");
	let queries = [
		searchLinks.findQuery(epmc, { ...info, pmid: TEST_PMID }).query,
		searchLinks.findQuery(epmc, info).query,
		searchLinks.findQuery(epmc, { ...info, doi: "" }).query,
	];
	for (let q of queries) {
		let url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=json&pageSize=3&query=${encodeURIComponent(q)}`;
		let r = await getJSON(url);
		let hits = r.json && Number(r.json.hitCount);
		let first = r.json && r.json.resultList && r.json.resultList.result && r.json.resultList.result[0];
		let ok = r.status === 200 && hits >= 1 && first && String(first.pmid) === TEST_PMID;
		report.extra.push({ id: "europepmc-find", name: `Europe PMC query \`${q.slice(0, 60)}\``, url, status: r.status, ok, why: `hitCount ${hits}; first PMID ${first && first.pmid}` });
		log(`[extra] europepmc ${q}: ${ok ? "OK" : "CHECK"} hits=${hits}`);
		await sleep(500);
	}
}

// ---------------------------------------------------------------------------------------------
// API checks
// ---------------------------------------------------------------------------------------------

function makeSuite(name) {
	let suite = { name, checks: [] };
	suite.check = async (title, fn) => {
		let rec = { title, ok: false, warn: false, details: [] };
		let note = s => rec.details.push(String(s));
		let warn = (s) => {
			rec.warn = true;
			rec.details.push("⚠️ " + s);
		};
		try {
			await fn({ note, warn });
			rec.ok = true;
		}
		catch (e) {
			rec.ok = false;
			rec.details.push("❌ " + (e.message || e));
		}
		suite.checks.push(rec);
		log(`[${name}] ${rec.ok ? (rec.warn ? "WARN" : "OK") : "FAIL"} ${title}${rec.details.length ? "\n      " + rec.details.join("\n      ") : ""}`);
		await sleep(400);
	};
	return suite;
}

function expect(cond, msg) {
	if (!cond) throw new Error(msg);
}

function typeOf(v) {
	return Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
}

function requireFields(obj, spec, where) {
	let missing = [];
	for (let [k, t] of Object.entries(spec)) {
		if (!obj || !(k in obj)) missing.push(`${k} (missing)`);
		else if (t && !t.split("|").includes(typeOf(obj[k]))) missing.push(`${k} (is ${typeOf(obj[k])}, code expects ${t})`);
	}
	if (missing.length) throw new Error(`${where}: ${missing.join(", ")}`);
}

async function runNCBI(report) {
	let s = makeSuite("NCBI E-utilities");
	report.api.push(s);
	let ncbi = { email: process.env.NCBI_EMAIL || "" };
	let pmids = [];

	await s.check("esearch db=pubmed (watch search: datetype=edat, mindate/maxdate, sort=pub_date, retmax)", async ({ note }) => {
		let win = pubmedWatch.searchWindow ? pubmedWatch.searchWindow({ days: 365 }, null, new Date()) : null;
		let url = pubmedWatch.esearchURL(QUERY_EN, { retmax: 20, ...(win || { reldate: 365 }) }, ncbi);
		note(`\`${url.replace(/^https:\/\/eutils\.ncbi\.nlm\.nih\.gov\/entrez\/eutils\//, "…/")}\``);
		let r = await getJSON(url);
		expect(r.status === 200, `HTTP ${r.status} ${r.error || ""}`);
		expect(r.json, `not JSON: ${r.parseError}`);
		let er = r.json.esearchresult;
		expect(er && typeof er === "object", "esearchresult missing");
		requireFields(er, { count: "string|number", idlist: "array", querytranslation: "string" }, "esearchresult");
		expect(er.idlist.every(id => /^\d+$/.test(String(id))), "idlist has non-numeric ids");
		let parsed = pubmedWatch.parseESearch(r.json);
		expect(parsed.count > 0 && parsed.ids.length > 0, `parseESearch → count ${parsed.count}, ${parsed.ids.length} ids`);
		pmids = parsed.ids;
		note(`count ${parsed.count}, ${parsed.ids.length} ids; querytranslation: ${String(er.querytranslation).slice(0, 160)}`);
		note(`esearchresult keys: ${Object.keys(er).join(", ")}`);
	});

	await s.check("sort=pub_date is honoured (ids newest first by sortpubdate)", async ({ note, warn }) => {
		expect(pmids.length >= 3, "no ids from the previous check");
		let r = await getJSON(pubmedWatch.esummaryURL(pmids.slice(0, 20), ncbi));
		expect(r.status === 200 && r.json && r.json.result, `HTTP ${r.status}`);
		let dates = r.json.result.uids.map(u => String(r.json.result[u].sortpubdate || "")).filter(Boolean);
		let inversions = dates.filter((d, i) => i && d > dates[i - 1]).length;
		note(`sortpubdate sequence: ${dates.slice(0, 6).join(", ")} …`);
		if (inversions > Math.ceil(dates.length * 0.2)) warn(`${inversions}/${dates.length} out of order — sort=pub_date may be ignored`);
	});

	await s.check("esearch retmax=0 + reldate (watch test button: count only)", async ({ note }) => {
		let r = await getJSON(pubmedWatch.esearchURL(QUERY_EN, { retmax: 0, reldate: 30 }, ncbi));
		expect(r.status === 200 && r.json, `HTTP ${r.status}`);
		let p = pubmedWatch.parseESearch(r.json);
		expect(Number.isFinite(p.count), "count not numeric");
		expect(p.ids.length === 0, `retmax=0 returned ${p.ids.length} ids`);
		note(`count in the last 30 days: ${p.count}`);
	});

	await s.check("esearch warnings/errors (errorlist / warninglist keys the code reads)", async ({ note, warn }) => {
		let known = ["phrasesnotfound", "phrasesignored", "fieldsnotfound", "quotedphrasesnotfound", "outputmessages"];
		let r = await getJSON(pubmedWatch.esearchURL("fall prevention xqzvwjkplm[tiab] AND \"zzqxv vvqzz\" AND nurse[zzfield]", { retmax: 5 }, ncbi));
		expect(r.status === 200 && r.json && r.json.esearchresult, `HTTP ${r.status}`);
		let er = r.json.esearchresult;
		let lists = { errorlist: er.errorlist, warninglist: er.warninglist };
		let seen = [];
		for (let [name, list] of Object.entries(lists)) {
			if (!list) continue;
			for (let [k, v] of Object.entries(list)) {
				seen.push(`${name}.${k}=${JSON.stringify(v).slice(0, 80)}`);
				if (!known.includes(k)) warn(`${name}.${k} is not read by parseESearch`);
			}
		}
		note(seen.join("; ") || "no errorlist/warninglist");
		expect(er.errorlist || er.warninglist, "neither errorlist nor warninglist present for a query with unknown terms");
		let p = pubmedWatch.parseESearch(r.json);
		expect(p.warnings.length > 0, "parseESearch produced no warnings");
		note(`parseESearch warnings: ${p.warnings.join(" / ")}`);
	});

	await s.check("esearch with an empty term → ERROR (parseESearch throws)", async ({ note }) => {
		let url = pubmedWatch.eutilsURL("esearch", { db: "pubmed", term: "", retmode: "json" }, ncbi);
		let r = await getJSON(url);
		note(`HTTP ${r.status}; body: ${String(r.body).replace(/\s+/g, " ").slice(0, 200)}`);
		expect(r.json, "not JSON");
		let threw = "";
		try {
			pubmedWatch.parseESearch(r.json);
		}
		catch (e) {
			threw = e.message;
		}
		expect(threw, "parseESearch did not report the error");
		note(`parseESearch: ${threw}`);
	});

	await s.check(`esummary db=pubmed (PMID ${TEST_PMID}: fields read by parseESummary)`, async ({ note }) => {
		let r = await getJSON(pubmedWatch.esummaryURL([TEST_PMID, ...pmids.slice(0, 2)], ncbi));
		expect(r.status === 200 && r.json, `HTTP ${r.status}`);
		let res = r.json.result;
		expect(res && Array.isArray(res.uids), "result.uids missing");
		let d = res[TEST_PMID];
		requireFields(d, { title: "string", fulljournalname: "string", source: "string", pubdate: "string", epubdate: "string", sortpubdate: "string", elocationid: "string", articleids: "array", authors: "array" }, `result["${TEST_PMID}"]`);
		requireFields(d.articleids[0], { idtype: "string", value: "string" }, "articleids[0]");
		requireFields(d.authors[0], { name: "string" }, "authors[0]");
		let parsed = pubmedWatch.parseESummary(r.json).find(x => x.pmid === TEST_PMID);
		expect(parsed.doi.toLowerCase() === TEST_DOI, `doi ${parsed.doi} ≠ ${TEST_DOI}`);
		expect(parsed.year === "2002", `year ${parsed.year}`);
		expect(/JAMA/i.test(parsed.journal), `journal ${parsed.journal}`);
		expect(parsed.authors[0] === "Aiken LH", `first author ${parsed.authors[0]}`);
		note(`parseESummary → ${JSON.stringify({ ...parsed, authors: parsed.authors.slice(0, 2) })}`);
		note(`record keys: ${Object.keys(d).join(", ")}`);
	});

	let meshIds = [];
	await s.check("esearch db=mesh (MeSH helper)", async ({ note }) => {
		let r = await getJSON(pubmedWatch.eutilsURL("esearch", { db: "mesh", term: "accidental falls", retmode: "json", retmax: 5 }, ncbi));
		expect(r.status === 200 && r.json, `HTTP ${r.status}`);
		let p = pubmedWatch.parseESearch(r.json);
		expect(p.ids.length > 0, "no MeSH ids");
		meshIds = p.ids;
		note(`ids ${p.ids.join(",")}; translation ${String(p.translation).slice(0, 160)}`);
	});

	await s.check("esummary db=mesh: ds_meshterms / ds_meshui / ds_scopenote (parseMeshSummary)", async ({ note }) => {
		expect(meshIds.length, "no ids from esearch");
		let r = await getJSON(pubmedWatch.eutilsURL("esummary", { db: "mesh", id: [...new Set([...meshIds, "68000058"])].join(","), retmode: "json" }, ncbi));
		expect(r.status === 200 && r.json && r.json.result, `HTTP ${r.status}`);
		let d = r.json.result["68000058"];
		expect(d, "result[\"68000058\"] missing");
		note(`record keys: ${Object.keys(d).join(", ")}`);
		requireFields(d, { ds_meshterms: "array", ds_meshui: "string", ds_scopenote: "string" }, "result[\"68000058\"]");
		expect(d.ds_meshui === "D000058", `ds_meshui ${d.ds_meshui}`);
		expect(d.ds_meshterms[0] === "Accidental Falls", `ds_meshterms[0] = ${JSON.stringify(d.ds_meshterms[0])} (the code takes [0] as the heading)`);
		let parsed = searchLinks.parseMeshSummary(r.json);
		expect(parsed.some(h => h.heading === "Accidental Falls" && h.ui === "D000058" && h.scopeNote), "parseMeshSummary did not return Accidental Falls with its scope note");
		note(`parseMeshSummary → ${parsed.map(h => `${h.heading} (${h.ui})`).join("; ")}`);
	});

	await s.check("suggestMesh() end to end (\"falls, older adults\")", async ({ note, warn }) => {
		let mesh = await searchLinks.suggestMesh("falls, older adults", { ncbi });
		note(searchLinks.buildMeshQuery(mesh.blocks));
		note(`${mesh.requests.length} requests`);
		let heads = mesh.blocks.map(b => b.headings.map(h => h.heading));
		expect(mesh.blocks.length === 2, `${mesh.blocks.length} concept blocks`);
		if (!heads[0].includes("Accidental Falls")) warn(`"falls" → ${heads[0].join(", ") || "none"} (Accidental Falls expected)`);
		let other = await searchLinks.suggestMesh("fall prevention, pressure ulcer, nurse-led", { ncbi });
		note(`"fall prevention, pressure ulcer, nurse-led" → ${other.blocks.map(b => `${b.concept}: ${b.headings.map(h => h.heading).join("/") || "—"}`).join("; ")}`);
		if (!heads[1].includes("Aged")) warn(`"older adults" → ${heads[1].join(", ") || "none"} (Aged expected)`);
	});
}

async function runOpenAlex(report) {
	let s = makeSuite("OpenAlex");
	report.api.push(s);
	const SEED = citationChase;
	let opts = { email: CONTACT };
	let seed = null;

	let seedFields = ["id", "doi", "display_name", "cited_by_count", "referenced_works"];
	let workFields = ["id", "doi", "display_name", "publication_year", "primary_location", "cited_by_count", "ids", "type"];

	await s.check(`works/doi:${TEST_DOI} with select= and mailto=`, async ({ note, warn }) => {
		let url = SEED.seedURL({ doi: TEST_DOI }, opts);
		note(`\`${url}\``);
		let r = await getJSON(url);
		expect(r.status === 200, `HTTP ${r.status} ${String(r.body).slice(0, 200)}`);
		expect(r.json, "not JSON");
		requireFields(r.json, { id: "string", doi: "string", display_name: "string", cited_by_count: "number", referenced_works: "array" }, "work");
		let extra = Object.keys(r.json).filter(k => !seedFields.includes(k));
		if (extra.length) warn(`select= ignored? extra fields: ${extra.join(", ")}`);
		expect(r.json.doi.toLowerCase() === `https://doi.org/${TEST_DOI}`, `doi ${r.json.doi}`);
		seed = r.json;
		note(`${citationChase.openAlexKey(r.json.id)}: cited_by_count ${r.json.cited_by_count}, ${r.json.referenced_works.length} referenced works`);
		let rl = Object.entries(r.headers || {}).filter(([k]) => /ratelimit|x-api|credits/i.test(k)).map(([k, v]) => `${k}: ${v}`);
		if (rl.length) note(`headers: ${rl.join("; ")}`);
	});

	await s.check(`works/pmid:${TEST_PMID} resolves to the same work`, async ({ note }) => {
		let url = SEED.seedURL({ pmid: TEST_PMID }, opts);
		let r = await getJSON(url);
		expect(r.status === 200 && r.json, `HTTP ${r.status}`);
		expect(seed && r.json.id === seed.id, `${r.json.id} ≠ ${seed && seed.id}`);
		note(`\`${url}\` → ${r.json.id}`);
	});

	let key = () => citationChase.openAlexKey(seed && seed.id);
	let firstPage = null;

	await s.check("filter=cited_by:W… (references) with select=, sort=cited_by_count:desc, per-page, cursor=*", async ({ note, warn }) => {
		expect(key(), "no seed");
		let url = SEED.listURL(`cited_by:${key()}`, "*", { email: CONTACT, perPage: 10 });
		note(`\`${url}\``);
		let r = await getJSON(url);
		expect(r.status === 200 && r.json, `HTTP ${r.status} ${String(r.body).slice(0, 300)}`);
		requireFields(r.json, { meta: "object", results: "array" }, "response");
		requireFields(r.json.meta, { count: "number", next_cursor: "string|null" }, "meta");
		expect(r.json.results.length > 0, "no results");
		let w = r.json.results[0];
		requireFields(w, { id: "string", display_name: "string", cited_by_count: "number", ids: "object", primary_location: "object|null", publication_year: "number|null", type: "string", doi: "string|null" }, "results[0]");
		let extra = Object.keys(w).filter(k => !workFields.includes(k));
		if (extra.length) warn(`select= ignored? extra fields: ${extra.join(", ")}`);
		let counts = r.json.results.map(x => x.cited_by_count);
		expect(counts.every((c, i) => !i || c <= counts[i - 1]), `not sorted by cited_by_count desc: ${counts.join(",")}`);
		let diff = Math.abs(r.json.meta.count - seed.referenced_works.length);
		if (diff > 2) warn(`meta.count ${r.json.meta.count} vs referenced_works ${seed.referenced_works.length}`);
		let c = citationChase.workToCandidate(w);
		note(`meta.count ${r.json.meta.count}; cited_by_count ${counts.slice(0, 5).join(",")}…; next_cursor ${String(r.json.meta.next_cursor).slice(0, 20)}…`);
		note(`workToCandidate → ${JSON.stringify(c).slice(0, 300)}`);
		expect(c.openalex && c.title, "workToCandidate lost id/title");
		let withPmid = r.json.results.filter(x => x.ids && x.ids.pmid);
		if (withPmid.length) {
			expect(citationChase.workToCandidate(withPmid[0]).pmid, `ids.pmid ${withPmid[0].ids.pmid} not parsed`);
			note(`ids.pmid example: ${withPmid[0].ids.pmid}`);
		}
		else warn("no result with ids.pmid on this page");
		let withSource = r.json.results.filter(x => x.primary_location && x.primary_location.source && x.primary_location.source.display_name);
		if (!withSource.length) warn("no primary_location.source.display_name on this page");
		firstPage = r.json;
	});

	await s.check("cursor paging (meta.next_cursor → page 2 has different works)", async ({ note }) => {
		expect(firstPage && firstPage.meta.next_cursor, "no next_cursor on page 1 (fewer than one page of references?)");
		let r = await getJSON(SEED.listURL(`cited_by:${key()}`, firstPage.meta.next_cursor, { email: CONTACT, perPage: 10 }));
		expect(r.status === 200 && r.json, `HTTP ${r.status}`);
		let ids1 = new Set(firstPage.results.map(w => w.id));
		let overlap = r.json.results.filter(w => ids1.has(w.id)).length;
		expect(r.json.results.length > 0 && overlap === 0, `page 2: ${r.json.results.length} works, ${overlap} repeated`);
		note(`page 2: ${r.json.results.length} works, no overlap`);
	});

	await s.check("filter=cites:W… (citing works)", async ({ note, warn }) => {
		let url = SEED.listURL(`cites:${key()}`, "*", { email: CONTACT, perPage: 5 });
		let r = await getJSON(url);
		expect(r.status === 200 && r.json && r.json.meta, `HTTP ${r.status}`);
		let n = r.json.meta.count;
		expect(n > 100, `meta.count ${n}`);
		let ratio = n / Math.max(1, seed.cited_by_count);
		if (ratio < 0.8 || ratio > 1.2) warn(`cites: count ${n} vs cited_by_count ${seed.cited_by_count}`);
		note(`meta.count ${n} (cited_by_count ${seed.cited_by_count}); top: ${r.json.results.slice(0, 2).map(w => `${w.display_name.slice(0, 50)} (${w.cited_by_count})`).join("; ")}`);
	});

	await s.check("per-page=200 (PER_PAGE) is accepted", async ({ note }) => {
		let r = await getJSON(SEED.listURL(`cites:${key()}`, "*", { email: CONTACT }));
		expect(r.status === 200 && r.json, `HTTP ${r.status} ${String(r.body).slice(0, 200)}`);
		expect(r.json.results.length === 200 || r.json.results.length === r.json.meta.count, `${r.json.results.length} results`);
		note(`${r.json.results.length} results; meta.per_page ${r.json.meta.per_page}`);
	});

	await s.check("chase() end to end with OpenAlexClient (fetch, throttle, cap)", async ({ note }) => {
		let client = new citationChase.OpenAlexClient({ fetch: (u, init) => fetch(u, init), email: CONTACT, maxRequests: 12 });
		let run = await citationChase.chase([{ id: 1, label: "Aiken 2002", doi: TEST_DOI }], { client, maxPerSeed: 30 });
		let rep = run.reports[0];
		note(`status ${rep.status}; backward ${JSON.stringify(rep.backward)}; forward ${JSON.stringify(rep.forward)}; ${run.requests} requests`);
		expect(rep.status === "完成", `status ${rep.status}`);
		expect(rep.backward.found > 0 && rep.forward.found > 0, "no works found");
		let cands = run.hits.map(h => citationChase.workToCandidate(h.work));
		let titles = cands.filter(c => c.title).length;
		let journals = cands.filter(c => c.journal).length;
		let pm = cands.filter(c => c.pmid).length;
		note(`${cands.length} candidates: ${titles} with title, ${journals} with journal, ${pm} with PMID`);
		expect(titles === cands.length, "candidates without a title");
	});
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

function cell(s) {
	return String(s === undefined || s === null ? "" : s).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function catalogTable(rows) {
	let lines = [
		"| ID | 名稱 | 標示 | 類型 | HTTP | 最後網址 | 判定 | 說明 / 建議修正 |",
		"|---|---|---|---|---|---|---|---|",
	];
	for (let r of rows) {
		let http = [r.fetch && r.fetch.status, r.render && r.render.status].filter(x => x !== undefined && x !== null).join(" / ");
		let fin = (r.render && r.render.finalUrl) || (r.fetch && r.fetch.finalUrl) || r.url;
		let alt = r.alts && r.alts.length ? "<br>alt: " + r.alts.map(a => `${VERDICTS[a.code].label.split(" ")[0]} \`${cell(short(a.template, 80))}\``).join("<br>alt: ") : "";
		let d = r.discovered;
		if (d) alt += `<br>search box → ${d.error ? cell(d.error) : `${d.inUrl ? "query in URL" : "query NOT in URL"}: \`${cell(short(d.finalUrl, 160))}\` ${cell(d.evidence || "")}`}`;
		lines.push(`| \`${r.id}\` | ${cell(r.name)} | ${cell(r.label)}${r.needsAccess ? " 🔒" : ""} | ${r.kind} | ${cell(http)} | ${cell(short(fin, 70))} | ${VERDICTS[r.code].label} | ${cell(short(r.why, 260))}${r.fix ? `<br>**→ ${cell(r.fix)}**` : ""}${alt} |`);
	}
	return lines.join("\n");
}

function renderReport(report) {
	let out = [`# Live link check — ${TODAY}`, ""];
	out.push(`Queries: \`${QUERY_EN}\` (English sources), \`${QUERY_ZH}\` (Chinese sources). Browser render: ${report.browser || "no (fetch only)"}. Runner: ${process.env.RUNNER_OS || process.platform} ${process.env.GITHUB_RUN_ID ? `run ${process.env.GITHUB_RUN_ID}` : ""}`, "");
	let fails = report.failures;
	out.push(fails.length ? `**${fails.length} failure(s):**\n\n${fails.map(f => `- ${f}`).join("\n")}` : "**No clear breakage.**", "");
	let counts = {};
	for (let r of report.catalog) counts[r.code] = (counts[r.code] || 0) + 1;
	if (report.catalog.length) out.push("Verdicts: " + Object.entries(counts).map(([k, n]) => `${VERDICTS[k].label} × ${n}`).join(" · "), "");
	for (let [cat, title] of [["plugin", "Plugin catalog (content/search-links.js)"], ["site", "Web page catalog (site/search.html)"]]) {
		let rows = report.catalog.filter(r => r.catalog === cat);
		if (!rows.length) continue;
		out.push(`## ${title}`, "", catalogTable(rows), "");
	}
	if (report.extra.length) {
		out.push("## Plugin item links (record, similar articles, find-this-paper)", "", "| Check | HTTP | Result | Details |", "|---|---|---|---|");
		for (let e of report.extra) out.push(`| ${cell(e.name)} | ${e.status} | ${e.ok ? "✅" : "⚠️"} | ${cell(short(e.why, 200))} |`);
		out.push("");
	}
	for (let s of report.api) {
		out.push(`## ${s.name}`, "", "| Check | Result | Details |", "|---|---|---|");
		for (let c of s.checks) out.push(`| ${cell(c.title)} | ${c.ok ? (c.warn ? "⚠️ OK with warnings" : "✅ OK") : "❌ FAIL"} | ${cell(c.details.join("<br>"))} |`);
		out.push("");
	}
	out.push("Legend: ✅ OK · 🔐 needs login (expected for subscription databases) · 🚧 blocked from CI (datacenter IP / bot wall — inconclusive, check by hand) · ⚠️ needs a look · ❌ clear breakage (fails the job).");
	return out.join("\n");
}

// ---------------------------------------------------------------------------------------------

async function main() {
	fs.mkdirSync(OUT, { recursive: true });
	let report = { date: TODAY, catalog: [], extra: [], api: [], failures: [], browser: "" };
	if (!flag("--skip-catalog")) {
		let b = await startBrowser();
		report.browser = b ? `Chromium ${b.version()}` : "";
		try {
			await runCatalogs(report);
			await runExtraLinks(report);
		}
		finally {
			if (browser) await browser.close().catch(() => {});
		}
	}
	if (!flag("--skip-api")) {
		await runNCBI(report);
		await runOpenAlex(report);
	}
	for (let r of report.catalog) if (VERDICTS[r.code].fail) report.failures.push(`[${r.catalog}] \`${r.id}\`: ${short(r.why, 200)}`);
	for (let s of report.api) for (let c of s.checks) if (!c.ok) report.failures.push(`${s.name}: ${c.title} — ${c.details.filter(d => d.startsWith("❌")).join(" ")}`);
	let md = renderReport(report);
	fs.writeFileSync(path.join(OUT, "report.md"), md);
	fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, (k, v) => (k === "check" ? undefined : v), 2));
	if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
	log("\n" + md);
	if (report.failures.length) {
		console.error(`\n${report.failures.length} failure(s)`);
		process.exitCode = 1;
	}
}

main().catch((e) => {
	console.error(e);
	process.exitCode = 2;
});
