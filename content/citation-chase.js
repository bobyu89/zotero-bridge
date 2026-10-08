/*
 * Zotero Bridge — citation searching for reviews (引文追蹤, PRISMA 2020 "other methods").
 *
 * For the included studies of a review (items tagged 篩選/全文/納入) or selected items, OpenAlex
 * (free, no key) gives the references (backward ←) and the citing works (forward →):
 *   GET /works/doi:<doi> (or pmid:<pmid>)          the seed's OpenAlex ID
 *   GET /works?filter=cited_by:<id>                 works the seed cites (its referenced_works)
 *   GET /works?filter=cites:<id>                    works citing the seed
 * with select= to limit fields, per-page=200, cursor paging with a cap, sort by citations (so a cap
 * keeps the most cited) and mailto= for the polite pool. Requests are throttled (5/s) and capped per run.
 *
 * Nothing is imported automatically: the candidates (deduplicated against the library by DOI, PMID
 * and normalized title + year) go to an Obsidian note with a task list and a CSV. The user ticks
 * (- [x]) what to add, then 「匯入引文追蹤勾選的文獻」 imports those by DOI/PMID with Zotero's
 * identifier lookup into the review collection, tagged 來源/引文追蹤, so screening.js counts them in
 * the PRISMA "other methods" column. Screening tags are left to the user.
 *
 * The helpers at the top are pure (Node tests); the rest needs Zotero.
 */
(function (root, factory) {
	if (typeof module === "object" && module.exports) {
		module.exports = factory(require("./core.js"), require("./screening.js"), require("./synthesis.js"), require("./llm.js"), globalThis);
	}
	else {
		(root.ZB = root.ZB || {}).citationChase = factory(root.ZB.core, root.ZB.screening, root.ZB.synthesis, root.ZB.llm, root);
	}
})(this, function (core, screening, synthesis, llm, scope) {
	const PREF = "extensions.zotero-bridge.";
	const API = "https://api.openalex.org";
	// Root-level fields only (OpenAlex `select` can't pick nested ones)
	const SEED_FIELDS = "id,doi,display_name,cited_by_count,referenced_works";
	const WORK_FIELDS = "id,doi,display_name,publication_year,primary_location,cited_by_count,ids,type";
	const PER_PAGE = 200;
	// OpenAlex allows more; staying at 5 requests/s leaves room for other tools on the same IP
	const MIN_INTERVAL_MS = 200;
	const DEFAULT_MAX_REQUESTS = 100;
	const DEFAULT_MAX_PER_SEED = 200;
	const MAX_RETRIES = 2;
	const SOURCE_NAME = "引文追蹤";
	const NOTE_SUFFIX = " 引文追蹤";
	const SELECTION_NAME = "所選文獻";
	const DIRECTIONS = { backward: "← 參考文獻", forward: "→ 被引用" };
	const IMPORTED_MARK = "✅ 已匯入";
	// Shorter normalized titles match too easily (same rule as screening.js)
	const MIN_TITLE_CHARS = 10;
	const MARK_START_RE = /^%% zotero-bridge:start.*%%[ \t]*$/m;
	const MARK_END_RE = /^%% zotero-bridge:end %%[ \t]*$/m;

	// ---------- identifiers (pure) ----------

	function pmidOf(value) {
		let m = /(?:^|pubmed\.ncbi\.nlm\.nih\.gov\/|PMID:\s*)(\d{1,9})\/?\s*$/i.exec(String(value || "").trim());
		return m ? m[1] : "";
	}

	/** "PMID: 123" in a Zotero item's Extra field. */
	function pmidFromExtra(extra) {
		let m = /^\s*PMID:\s*(\d{1,9})\s*$/im.exec(String(extra || ""));
		return m ? m[1] : "";
	}

	/** "https://openalex.org/W123" → "W123". */
	function openAlexKey(id) {
		let m = /(W\d+)\s*$/i.exec(String(id || ""));
		return m ? m[1].toUpperCase() : "";
	}

	// Keep the separators OpenAlex documents (filter=a:b, select=a,b) readable in the URL
	function encodeParam(v) {
		return encodeURIComponent(String(v)).replace(/%3A/gi, ":").replace(/%2C/gi, ",").replace(/%7C/gi, "|").replace(/%40/g, "@");
	}

	function query(params) {
		let parts = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")
			.map(([k, v]) => `${k}=${encodeParam(v)}`);
		return parts.length ? "?" + parts.join("&") : "";
	}

	/** The seed's own record: /works/doi:<doi> or /works/pmid:<pmid>; null without either. */
	function seedURL(seed, opts = {}) {
		let doi = screening.normalizeDOI(seed.doi);
		let pmid = pmidOf(seed.pmid);
		let id = doi ? "doi:" + encodeURIComponent(doi).replace(/%2F/gi, "/") : pmid ? "pmid:" + pmid : "";
		if (!id) return null;
		return `${API}/works/${id}${query({ select: SEED_FIELDS, mailto: opts.email })}`;
	}

	/** One page of a work list: filter=cited_by:W… (references) or cites:W… (citing works). */
	function listURL(filter, cursor, opts = {}) {
		return `${API}/works${query({
			filter, select: WORK_FIELDS, sort: "cited_by_count:desc", "per-page": opts.perPage || PER_PAGE,
			cursor: cursor || "*", mailto: opts.email,
		})}`;
	}

	function workToCandidate(work) {
		let w = work || {};
		let loc = w.primary_location || {};
		return {
			openalex: openAlexKey(w.id),
			doi: screening.normalizeDOI(w.doi),
			pmid: pmidOf(w.ids && w.ids.pmid),
			title: String(w.display_name || w.title || "").replace(/<\/?(?:i|b|sub|sup)>/gi, "").trim(),
			year: w.publication_year ? String(w.publication_year) : "",
			journal: String((loc.source && loc.source.display_name) || ""),
			citedBy: Number.isFinite(w.cited_by_count) ? w.cited_by_count : null,
			type: String(w.type || ""),
		};
	}

	// ---------- requests (pure, with injectable fetch, clock and sleep) ----------

	class RequestCapError extends Error {
		constructor(max) {
			super(`已達本次 OpenAlex 請求上限（${max} 次）`);
			this.name = "RequestCapError";
		}
	}

	/** Waits so that calls are at least `intervalMs` apart. */
	function makeThrottle(intervalMs, opts = {}) {
		let now = opts.now || (() => Date.now());
		let sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)));
		let next = 0;
		return async function wait() {
			let t = now();
			let at = Math.max(t, next);
			next = at + intervalMs;
			if (at > t) await sleep(at - t);
		};
	}

	/**
	 * OpenAlex GET with throttling, a cap on requests per run, and retries on 429/5xx/network errors
	 * (each retry counts as a request). Returns the JSON, or null for 404.
	 */
	class OpenAlexClient {
		constructor(opts = {}) {
			this.fetch = opts.fetch;
			this.email = String(opts.email || "").trim();
			this.maxRequests = opts.maxRequests || DEFAULT_MAX_REQUESTS;
			this.maxRetries = opts.maxRetries === undefined ? MAX_RETRIES : opts.maxRetries;
			this.sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)));
			this.random = opts.random || Math.random;
			this.throttle = makeThrottle(opts.interval === undefined ? MIN_INTERVAL_MS : opts.interval, { now: opts.now, sleep: this.sleep });
			this.requests = 0;
			this.log = [];
		}

		async get(url) {
			for (let attempt = 0; ; attempt++) {
				if (this.requests >= this.maxRequests) throw new RequestCapError(this.maxRequests);
				await this.throttle();
				this.requests++;
				this.log.push(url);
				let res = null;
				let error = null;
				try {
					res = await this.fetch(url, { method: "GET", headers: { Accept: "application/json" } });
				}
				catch (e) {
					error = e;
				}
				let retryable = error || res.status === 429 || res.status >= 500;
				if (retryable && attempt < this.maxRetries) {
					let requested = error ? null : llm.retryAfterMs(res);
					await this.sleep(requested === null ? llm.backoffDelay(attempt, this.random) : requested);
					continue;
				}
				if (error) throw new Error(`無法連線到 OpenAlex：${error.message || error}`);
				if (res.status === 404) return null;
				if (!res.ok) {
					let hint = res.status === 429 ? "（請求太頻繁或超過每日額度，請稍後再試）" : "";
					throw new Error(`OpenAlex 回應 ${res.status}${hint}`);
				}
				let text = await res.text();
				try {
					return JSON.parse(text);
				}
				catch (e) {
					throw new Error("OpenAlex 回應不是 JSON");
				}
			}
		}
	}

	/**
	 * Up to `cap` works of a list, following meta.next_cursor. When the run's request cap is reached
	 * after the first page, the pages so far are kept and `stopped` says why.
	 */
	async function listWorks(client, filter, cap) {
		let works = [];
		let total = null;
		let cursor = "*";
		let stopped = "";
		while (works.length < cap) {
			let json;
			try {
				json = await client.get(listURL(filter, cursor, { email: client.email, perPage: Math.min(PER_PAGE, cap) }));
			}
			catch (e) {
				if (!(e instanceof RequestCapError) || !works.length) throw e;
				stopped = e.message;
				break;
			}
			if (!json) break;
			let results = Array.isArray(json.results) ? json.results : [];
			if (total === null && json.meta && Number.isFinite(json.meta.count)) total = json.meta.count;
			works.push(...results);
			cursor = json.meta && json.meta.next_cursor;
			if (!cursor || !results.length) break;
		}
		let capped = works.length > cap || (total !== null && total > works.length && (works.length >= cap || !!stopped));
		return { works: works.slice(0, cap), total: total === null ? works.length : total, capped, stopped };
	}

	/**
	 * Look up each seed and collect its references and citing works.
	 * @param {object[]} seeds { id, label, doi, pmid }
	 * @param {object} opts { client, direction: "both"|"backward"|"forward", maxPerSeed, onProgress(i, seed) }
	 * @returns {{ reports, hits: [{ work, direction, seed }], stopped: string }}
	 */
	async function chase(seeds, opts) {
		let client = opts.client;
		let cap = opts.maxPerSeed || DEFAULT_MAX_PER_SEED;
		let wantBack = opts.direction !== "forward";
		let wantForward = opts.direction !== "backward";
		let reports = [];
		let hits = [];
		let stopped = "";
		for (let [i, seed] of seeds.entries()) {
			let report = { seed, status: "", openalex: "", backward: null, forward: null };
			reports.push(report);
			if (stopped) {
				report.status = "未查詢（已達請求上限）";
				continue;
			}
			if (opts.onProgress) opts.onProgress(i, seed);
			let url = seedURL(seed, { email: client.email });
			if (!url) {
				report.status = "沒有 DOI 或 PMID，無法查詢";
				continue;
			}
			try {
				let work = await client.get(url);
				if (!work) {
					report.status = "OpenAlex 找不到這篇";
					continue;
				}
				report.openalex = openAlexKey(work.id);
				let refs = Array.isArray(work.referenced_works) ? work.referenced_works.length : 0;
				let steps = [];
				if (wantBack) steps.push(["backward", `cited_by:${report.openalex}`, refs]);
				if (wantForward) steps.push(["forward", `cites:${report.openalex}`, work.cited_by_count || 0]);
				for (let [direction, filter, expected] of steps) {
					// Nothing to page through (saves a request)
					if (!expected) {
						report[direction] = { found: 0, total: 0, capped: false };
						continue;
					}
					let list = await listWorks(client, filter, cap);
					report[direction] = { found: list.works.length, total: list.total, capped: list.capped };
					for (let w of list.works) hits.push({ work: w, direction, seed });
					if (list.stopped) {
						stopped = list.stopped;
						break;
					}
				}
				report.status = stopped ? "部分完成（已達請求上限）" : "完成";
			}
			catch (e) {
				if (e instanceof RequestCapError) {
					stopped = e.message;
					report.status = report.openalex ? "部分完成（已達請求上限）" : "未查詢（已達請求上限）";
				}
				else {
					report.status = `失敗：${e.message || e}`;
				}
			}
		}
		return { reports, hits, stopped, requests: client.requests };
	}

	// ---------- candidates and library deduplication (pure) ----------

	function titleKeys(title, year) {
		let t = screening.normalizeTitle(title);
		let y = Number(year);
		if (t.length < MIN_TITLE_CHARS || !y) return [];
		// Online-first and print years often differ by one
		return [y - 1, y, y + 1].map(v => `${t}|${v}`);
	}

	/**
	 * Lookup tables over the library's records { id, doi, pmid, title, year, inReview }.
	 * find(candidate) → the matching record or null.
	 */
	function libraryIndex(records) {
		let doi = new Map();
		let pmid = new Map();
		let title = new Map();
		for (let r of records) {
			let d = screening.normalizeDOI(r.doi);
			if (d && !doi.has(d)) doi.set(d, r);
			let p = pmidOf(r.pmid);
			if (p && !pmid.has(p)) pmid.set(p, r);
			let t = screening.normalizeTitle(r.title);
			let y = screening.yearOf(r);
			if (t.length >= MIN_TITLE_CHARS && y && !title.has(`${t}|${y}`)) title.set(`${t}|${y}`, r);
		}
		let find = (c) => {
			if (c.doi && doi.has(c.doi)) return doi.get(c.doi);
			if (c.pmid && pmid.has(c.pmid)) return pmid.get(c.pmid);
			for (let key of titleKeys(c.title, c.year)) {
				let r = title.get(key);
				// Two different DOIs are two works (an erratum, a preprint)
				if (r && !(c.doi && screening.normalizeDOI(r.doi) && screening.normalizeDOI(r.doi) !== c.doi)) return r;
			}
			return null;
		};
		return { find };
	}

	/**
	 * One candidate per work: the directions and seeds it was found from, and whether the library
	 * (or the review itself) already has it. Sorted: new first, then found from more studies, more cited.
	 */
	function buildCandidates(hits, index) {
		let byKey = new Map();
		for (let { work, direction, seed } of hits) {
			let c = workToCandidate(work);
			let key = c.openalex || (c.doi ? "doi:" + c.doi : "") || `${screening.normalizeTitle(c.title)}|${c.year}`;
			if (!byKey.has(key)) byKey.set(key, Object.assign(c, { links: [] }));
			let entry = byKey.get(key);
			if (!entry.links.some(l => l.direction === direction && l.seed.id === seed.id)) entry.links.push({ direction, seed });
		}
		let list = [...byKey.values()];
		for (let c of list) {
			let match = index ? index.find(c) : null;
			c.inLibrary = match ? (match.inReview ? "review" : "library") : "";
			c.libraryURI = match ? match.uri || "" : "";
		}
		let seeds = c => new Set(c.links.map(l => l.seed.id)).size;
		list.sort((a, b) => (!!a.inLibrary - !!b.inLibrary) || seeds(b) - seeds(a) || (b.citedBy || 0) - (a.citedBy || 0)
			|| a.title.localeCompare(b.title));
		return list;
	}

	function candidateKey(c) {
		return c.doi ? "doi:" + c.doi : c.pmid ? "pmid:" + c.pmid : "";
	}

	// ---------- outputs (pure) ----------

	function doiURL(doi) {
		// Parentheses and spaces encoded, so the Markdown link (and the import parser) stay intact
		return "https://doi.org/" + encodeURI(doi).replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/#/g, "%23");
	}

	function mdText(s) {
		return String(s || "").replace(/\s+/g, " ").replace(/([\\`*_[\]<>|#])/g, "\\$1").trim();
	}

	function cell(v) {
		return String(v === undefined || v === null ? "" : v).replace(/\r?\n+/g, " ").replace(/\|/g, "\\|").trim();
	}

	function linksText(c) {
		let out = [];
		for (let direction of ["backward", "forward"]) {
			let seeds = c.links.filter(l => l.direction === direction).map(l => l.seed.label);
			if (seeds.length) out.push(`${direction === "backward" ? "←" : "→"} ${seeds.join("；")}`);
		}
		return out.join("　");
	}

	function idLink(c) {
		if (c.doi) return `[${mdText(c.doi)}](${doiURL(c.doi)})`;
		if (c.pmid) return `[PMID ${c.pmid}](https://pubmed.ncbi.nlm.nih.gov/${c.pmid}/)`;
		return c.openalex ? `[OpenAlex ${c.openalex}](https://openalex.org/${c.openalex})` : "";
	}

	function libraryFlag(c) {
		return c.inLibrary === "review" ? "已在本回顧" : c.inLibrary === "library" ? "已在文獻庫" : "";
	}

	/** A task-list line; candidates without a DOI or PMID can't be imported and get no checkbox. */
	function candidateLine(c, checked) {
		let parts = [
			`**${mdText(c.title) || "（無標題）"}**${c.year ? ` (${c.year})` : ""}`,
			c.journal ? `*${mdText(c.journal)}*` : "",
			c.citedBy !== null && c.citedBy !== undefined ? `被引 ${c.citedBy}` : "",
			linksText(c),
			idLink(c),
		].filter(Boolean).join("｜");
		if (!candidateKey(c)) return `- ${parts}（沒有 DOI／PMID，請手動加入）`;
		return `- [${checked ? "x" : " "}] ${parts}`;
	}

	function candidateTable(list) {
		if (!list.length) return "（沒有找到任何文獻）";
		let head = ["標題", "年份", "期刊", "被引", "方向", "來自納入研究", "DOI", "文獻庫"];
		let lines = [`| ${head.join(" | ")} |`, "|---|---|---|---:|---|---|---|---|"];
		for (let c of list) {
			let directions = ["backward", "forward"].filter(d => c.links.some(l => l.direction === d)).map(d => DIRECTIONS[d]).join("、");
			let seeds = [...new Set(c.links.map(l => l.seed.label))].join("；");
			let flag = libraryFlag(c);
			lines.push("| " + [
				cell(c.title), cell(c.year), cell(c.journal), cell(c.citedBy === null ? "" : c.citedBy), cell(directions), cell(seeds),
				c.doi ? `[${cell(c.doi)}](${doiURL(c.doi)})` : c.pmid ? `PMID ${c.pmid}` : "",
				c.libraryURI && flag ? `[${flag}](${c.libraryURI})` : flag,
			].join(" | ") + " |");
		}
		return lines.join("\n");
	}

	function seedTable(reports) {
		let count = (r) => {
			if (!r) return "—";
			return `${r.found}${r.total > r.found ? ` / ${r.total}` : ""}${r.capped ? "（已達上限）" : ""}`;
		};
		let lines = ["| 納入研究 | OpenAlex | ← 參考文獻 | → 被引用 | 狀態 |", "|---|---|---:|---:|---|"];
		for (let r of reports) {
			let name = r.seed.uri ? `[${cell(r.seed.label)}](${r.seed.uri})` : cell(r.seed.label);
			let oa = r.openalex ? `[${r.openalex}](https://openalex.org/${r.openalex})` : "";
			lines.push(`| ${name} | ${oa} | ${count(r.backward)} | ${count(r.forward)} | ${cell(r.status)} |`);
		}
		return lines.join("\n");
	}

	/**
	 * The managed part of the note.
	 * run: { reports, candidates, requests, stopped }; meta: { name, uri, generatedAt, csvPath, email, checked: Set }
	 */
	function buildChaseSection(run, meta) {
		let fresh = run.candidates.filter(c => !c.inLibrary);
		let known = run.candidates.length - fresh.length;
		let checked = meta.checked || new Set();
		let info = [
			`> [!info] 由 Zotero Bridge 依「${meta.name}」的 ${run.reports.length} 篇研究，於 ${String(meta.generatedAt || "").slice(0, 10)} 查詢 OpenAlex（${run.requests} 次請求）產生；重新產生只會覆寫這個區塊（勾選會保留）。`,
			"> " + [meta.uri ? `Zotero：[開啟分類](${meta.uri})` : "", meta.csvPath ? `CSV：\`${meta.csvPath}\`` : ""].filter(Boolean).join(" · "),
			meta.email ? "" : "> 建議在 設定 → 引文追蹤 填入 email（OpenAlex 的 polite pool，回應較穩定）。",
		].filter(line => line && line !== "> ").join("\n");
		let warn = [];
		if (run.stopped) warn.push(`> [!warning] ${run.stopped}：部分研究沒有查完。可在設定提高上限，或分批選取文獻後再查詢。`);
		if (run.reports.some(r => (r.backward && r.backward.capped) || (r.forward && r.forward.capped))) {
			warn.push("> [!note] 標示「已達上限」的研究只列出被引次數最高的部分文獻（設定 → 引文追蹤 → 每篇研究每個方向最多幾篇）。");
		}
		let list = fresh.length
			? fresh.map(c => candidateLine(c, checked.has(candidateKey(c)))).join("\n")
			: "（沒有新的候選文獻：找到的文獻都已在文獻庫中）";
		return [
			info,
			...warn,
			"## 查詢結果",
			seedTable(run.reports),
			`## 候選文獻（${fresh.length} 篇不在文獻庫中）`,
			"勾選要加入的文獻（`- [x]`），再到 Zotero 選取分類 → 右鍵 **Zotero Bridge：引文追蹤 → 匯入引文追蹤勾選的文獻**。匯入的文獻會加上標籤 `來源/引文追蹤`，請照常篩選；PRISMA 流程圖會把它們算在右側「其他方法」欄。←：該研究引用的文獻；→：引用該研究的文獻。",
			list,
			`## 總表（${run.candidates.length} 篇，其中 ${known} 篇已在文獻庫）`,
			candidateTable(run.candidates),
		].join("\n\n");
	}

	const CSV_COLUMNS = [
		["標題", c => c.title], ["年份", c => c.year], ["期刊", c => c.journal], ["被引次數", c => (c.citedBy === null ? "" : c.citedBy)],
		["方向", c => ["backward", "forward"].filter(d => c.links.some(l => l.direction === d)).map(d => DIRECTIONS[d]).join("、")],
		["來自納入研究", c => [...new Set(c.links.map(l => l.seed.label))].join("; ")],
		["DOI", c => c.doi], ["PMID", c => c.pmid], ["OpenAlex", c => (c.openalex ? `https://openalex.org/${c.openalex}` : "")],
		["文獻類型", c => c.type], ["已在文獻庫", c => libraryFlag(c)],
	];

	/** CSV with a UTF-8 BOM and CRLF line ends (Excel), like the evidence table. */
	function buildChaseCSV(candidates) {
		let lines = [CSV_COLUMNS.map(([h]) => h), ...candidates.map(c => CSV_COLUMNS.map(([, f]) => f(c)))];
		return "﻿" + lines.map(l => l.map(screening.csvCell).join(",")).join("\r\n") + "\r\n";
	}

	function frontmatterFor(run, meta) {
		return {
			title: meta.title,
			type: "citation-chase",
			zotero_collection: meta.collectionKey,
			collection_path: meta.path || meta.name,
			zotero: meta.uri || "",
			chase_seeds: run.reports.length,
			chase_candidates: run.candidates.length,
			chase_new: run.candidates.filter(c => !c.inLibrary).length,
			openalex_requests: run.requests,
			candidates_csv: meta.csvPath || "",
			last_generated: meta.generatedAt || "",
		};
	}

	// ---------- the note's checked items (pure) ----------

	/** The managed region of a note: { start, end } offsets, or null. */
	function managedRegion(text) {
		let start = MARK_START_RE.exec(text);
		let end = MARK_END_RE.exec(text);
		if (!start || !end || end.index < start.index) return null;
		return { start: start.index, end: end.index };
	}

	const CHECKED_RE = /^([ \t]*[-*+][ \t]+\[[xX]\][ \t]+)(.*)$/gm;

	function identifiersIn(line) {
		let doi = /https?:\/\/(?:dx\.)?doi\.org\/([^\s)>\]]+)/i.exec(line);
		if (doi) {
			let d = screening.normalizeDOI(doi[1]);
			if (d) return { doi: d, key: "doi:" + d };
		}
		let pmid = /pubmed\.ncbi\.nlm\.nih\.gov\/(\d{1,9})/i.exec(line);
		return pmid ? { pmid: pmid[1], key: "pmid:" + pmid[1] } : null;
	}

	/**
	 * Checked task-list items in the managed region: [{ doi | pmid, key, title, imported }].
	 * Lines outside the region, unchecked ones and lines without a DOI/PMID link are ignored.
	 */
	function parseChecked(text) {
		text = String(text || "");
		let region = managedRegion(text);
		if (!region) return [];
		let part = text.slice(region.start, region.end);
		let out = [];
		let seen = new Set();
		for (let m of part.matchAll(CHECKED_RE)) {
			let ids = identifiersIn(m[2]);
			if (!ids || seen.has(ids.key)) continue;
			seen.add(ids.key);
			let title = (/\*\*(.+?)\*\*/.exec(m[2]) || [])[1] || "";
			out.push(Object.assign(ids, { title: title.replace(/\\(.)/g, "$1"), imported: m[2].startsWith(IMPORTED_MARK) }));
		}
		return out;
	}

	/** Prefix the checked lines of these keys with 「✅ 已匯入」. */
	function markImported(text, keys) {
		let region = managedRegion(text);
		if (!region || !keys.size) return text;
		let part = text.slice(region.start, region.end).replace(CHECKED_RE, (line, box, rest) => {
			let ids = identifiersIn(rest);
			if (!ids || !keys.has(ids.key) || rest.startsWith(IMPORTED_MARK)) return line;
			return `${box}${IMPORTED_MARK} ${rest}`;
		});
		return text.slice(0, region.start) + part + text.slice(region.end);
	}

	// ---------- settings ----------

	function config() {
		let get = k => Zotero.Prefs.get(PREF + k, true);
		let num = (k, d) => {
			let n = Math.floor(Number(get(k)));
			return Number.isFinite(n) && n > 0 ? n : d;
		};
		let direction = String(get("citationChase.direction") || "both");
		return {
			email: String(get("citationChase.email") || "").trim(),
			maxRequests: num("citationChase.maxRequests", DEFAULT_MAX_REQUESTS),
			maxPerSeed: num("citationChase.maxPerSeed", DEFAULT_MAX_PER_SEED),
			direction: ["both", "backward", "forward"].includes(direction) ? direction : "both",
		};
	}

	// ---------- Zotero items ----------

	function field(item, name) {
		try {
			return item.getField(name, false, true) || "";
		}
		catch (e) {
			return "";
		}
	}

	function itemIdentity(item) {
		let lib = scope.ZB.adapter.libraryInfo(item.libraryID);
		let extra = field(item, "extra");
		let year = field(item, "year") || ((/\d{4}/.exec(field(item, "date")) || [])[0] || "");
		let title = field(item, "title");
		return {
			id: item.id,
			key: item.key,
			title,
			year,
			doi: field(item, "DOI") || ((/^\s*DOI:\s*(\S+)/im.exec(extra) || [])[1] || ""),
			pmid: pmidFromExtra(extra),
			label: synthesis.shortCitation({ creators: item.getCreatorsJSON(), title, year }),
			uri: `zotero://select/${lib.path}/items/${item.key}`,
		};
	}

	async function libraryRecords(libraryID, reviewIDs) {
		let items = await Zotero.Items.getAll(libraryID, true);
		return items.filter(i => i.isRegularItem() && !i.deleted)
			.map(i => Object.assign(itemIdentity(i), { inReview: reviewIDs.has(i.id) }));
	}

	function collectionKey(collection) {
		return collection ? `${scope.ZB.adapter.libraryInfo(collection.libraryID).path}/collections/${collection.key}` : "selection";
	}

	/** The note's path; a note of another collection with the same name keeps its file. */
	async function notePath(settings, collection) {
		let dirParts = [...core.splitFolder(settings.defaults.obsidianFolder), screening.REVIEW_FOLDER];
		let dir = PathUtils.join(settings.vaultPath, ...dirParts);
		let key = collectionKey(collection);
		let base = core.sanitizeFilename((collection ? collection.name : SELECTION_NAME) + NOTE_SUFFIX);
		let names = collection ? [base, `${base} (${collection.key})`] : [base];
		let target = null;
		for (let name of names) {
			let path = PathUtils.join(dir, name + ".md");
			let existing = (await IOUtils.exists(path)) ? await IOUtils.readUTF8(path) : null;
			let owner = existing === null ? "" : core.frontmatterScalar(core.splitFrontmatter(existing).frontmatter || "", "zotero_collection");
			target = { dir, dirParts, name, path, existing };
			if (existing === null || owner === key) break;
		}
		return target;
	}

	// The collection selected in the main window
	function activeCollection() {
		try {
			let pane = Zotero.getActiveZoteroPane();
			return (pane && pane.getSelectedCollections()[0]) || null;
		}
		catch (e) {
			return null;
		}
	}

	let busy = false;

	async function readVaultSettings(headline) {
		let ZB = scope.ZB;
		let settings;
		try {
			settings = await ZB.main.readSettings();
		}
		catch (e) {
			ZB.main.notify("Zotero Bridge 設定有誤", String(e.message || e));
			return null;
		}
		if (!settings.vaultPath) {
			ZB.main.notify(headline, "引文追蹤的候選清單存成 Obsidian 筆記：請先到 設定 → Zotero Bridge 填入 Obsidian vault 路徑。");
			return null;
		}
		return settings;
	}

	/** Citation searching from the included studies (全文納入) of a review collection. */
	async function chaseCollection(collection) {
		let ZB = scope.ZB;
		let cfg = screening.config();
		let items = ZB.adapter.itemsInCollection(collection, true);
		let seeds = items.filter(i => screening.readState(i.getTags().map(t => t.tag), cfg).ft === "include");
		if (!seeds.length) {
			ZB.main.notify("Zotero Bridge：引文追蹤", `「${collection.name}」還沒有全文納入的研究（標籤「${screening.stageTag(cfg, "ft", "include")}」）。`
				+ "\n也可以選取文獻後按右鍵 → Zotero Bridge：引文追蹤所選文獻。");
			return null;
		}
		return runChase(seeds, collection, items);
	}

	/** Citation searching from selected items; the note belongs to the selected collection, if any. */
	async function chaseItems(items, collection) {
		let ZB = scope.ZB;
		let seeds = ZB.adapter.toRegularItems(items);
		if (!seeds.length) {
			ZB.main.notify("Zotero Bridge：引文追蹤", "請先選取文獻。");
			return null;
		}
		let members = collection ? ZB.adapter.itemsInCollection(collection, true) : seeds;
		return runChase(seeds, collection || null, members);
	}

	async function runChase(seedItems, collection, reviewItems) {
		let ZB = scope.ZB;
		let headline = "Zotero Bridge：引文追蹤";
		if (busy) {
			ZB.main.notify(headline, "引文追蹤正在進行中，請等它完成。");
			return null;
		}
		let settings = await readVaultSettings(headline);
		if (!settings) return null;
		busy = true;
		let pw = new Zotero.ProgressWindow({ closeOnClick: true });
		pw.changeHeadline(headline);
		pw.show();
		let line = new pw.ItemProgress("note", `查詢 OpenAlex（${seedItems.length} 篇）…`);
		let failed = false;
		try {
			let opts = config();
			let seeds = seedItems.map(itemIdentity);
			let client = new OpenAlexClient({ fetch: (u, i) => fetch(u, i), email: opts.email, maxRequests: opts.maxRequests });
			let run = await chase(seeds, {
				client, direction: opts.direction, maxPerSeed: opts.maxPerSeed,
				onProgress: (i, seed) => {
					line.setText(`查詢 OpenAlex：${i + 1}/${seeds.length} ${seed.label}`);
					line.setProgress(Math.round(i / seeds.length * 100));
				},
			});
			let libraryID = collection ? collection.libraryID : seedItems[0].libraryID;
			let index = libraryIndex(await libraryRecords(libraryID, new Set(reviewItems.map(i => i.id))));
			run.candidates = buildCandidates(run.hits, index);

			let target = await notePath(settings, collection);
			let name = collection ? collection.name : SELECTION_NAME;
			let lib = ZB.adapter.libraryInfo(libraryID);
			let meta = {
				name,
				path: collection ? ZB.adapter.collectionPath(collection) : SELECTION_NAME,
				collectionKey: collectionKey(collection),
				uri: collection ? `zotero://select/${lib.path}/collections/${collection.key}` : "",
				generatedAt: new Date().toISOString(),
				title: `${name}：引文追蹤`,
				csvPath: [...target.dirParts, `${target.name}.csv`].join("/"),
				email: opts.email,
				checked: new Set(parseChecked(target.existing || "").map(c => c.key)),
			};
			await IOUtils.makeDirectory(target.dir, { createAncestors: true, ignoreExisting: true });
			await IOUtils.writeUTF8(PathUtils.join(target.dir, `${target.name}.csv`), buildChaseCSV(run.candidates));
			let section = buildChaseSection(run, meta);
			let text = screening.buildReviewNote(target.existing, frontmatterFor(run, meta), meta.title, section);
			if (text !== target.existing) await IOUtils.writeUTF8(target.path, text);

			let fresh = run.candidates.filter(c => !c.inLibrary).length;
			let problems = run.reports.filter(r => r.status !== "完成");
			line.setText(`找到 ${run.candidates.length} 篇，其中 ${fresh} 篇不在文獻庫（${run.requests} 次請求）`);
			pw.addDescription(`候選清單：${[...target.dirParts, target.name + ".md"].join("/")}，勾選後用「匯入引文追蹤勾選的文獻」加入 Zotero。`);
			if (problems.length) pw.addDescription(`${problems.length} 篇沒有完整查詢：${problems.slice(0, 3).map(r => `${r.seed.label}（${r.status}）`).join("；")}`);
			if (run.stopped) pw.addDescription(`⚠️ ${run.stopped}`);
			if (problems.length && problems.length === run.reports.length) {
				failed = true;
				line.setError();
			}
			else {
				line.setProgress(100);
			}
			return run;
		}
		catch (e) {
			Zotero.logError(e);
			failed = true;
			line.setText(`失敗：${e.message || e}`);
			line.setError();
			return null;
		}
		finally {
			busy = false;
			pw.startCloseTimer(failed ? 20000 : 12000);
		}
	}

	/** Look up one identifier with Zotero's translators (as 「新增條目（依識別碼）」 does) and save it. */
	async function translateIdentifier(identifier, libraryID, collections) {
		let translate = new Zotero.Translate.Search();
		translate.setIdentifier(identifier);
		let translators = await translate.getTranslators();
		if (!translators || !translators.length) throw new Error("找不到可用的轉譯器");
		translate.setTranslator(translators);
		return translate.translate({ libraryID, collections, saveAttachments: false });
	}

	/** Import the checked candidates of the note into the review collection, tagged 來源/引文追蹤. */
	async function importChecked(collection) {
		let ZB = scope.ZB;
		let headline = "Zotero Bridge：匯入引文追蹤";
		if (busy) {
			ZB.main.notify(headline, "引文追蹤正在進行中，請等它完成。");
			return null;
		}
		let settings = await readVaultSettings(headline);
		if (!settings) return null;
		let target = await notePath(settings, collection);
		let notePathText = [...target.dirParts, target.name + ".md"].join("/");
		if (target.existing === null) {
			ZB.main.notify(headline, `找不到 ${notePathText}：請先執行「引文追蹤」產生候選清單。`);
			return null;
		}
		let checked = parseChecked(target.existing).filter(c => !c.imported);
		let libraryID = collection ? collection.libraryID : Zotero.Libraries.userLibraryID;
		let reviewIDs = new Set(collection ? ZB.adapter.itemsInCollection(collection, true).map(i => i.id) : []);
		let index = libraryIndex(await libraryRecords(libraryID, reviewIDs));
		let todo = checked.filter(c => !index.find({ doi: c.doi || "", pmid: c.pmid || "", title: "", year: "" }));
		let skipped = checked.length - todo.length;
		if (!todo.length) {
			ZB.main.notify(headline, checked.length
				? `勾選的 ${checked.length} 篇都已在文獻庫中。`
				: `${notePathText} 沒有新勾選的文獻：在「候選文獻」清單勾選（- [x]）後再匯入。`);
			return { imported: 0, skipped, failed: [] };
		}
		let where = collection ? `分類「${collection.name}」` : "文獻庫";
		let ok = Services.prompt.confirm(Zotero.getMainWindow(), headline,
			`要用 DOI／PMID 查詢並匯入 ${todo.length} 篇勾選的文獻到${where}嗎？\n`
			+ (skipped ? `（另有 ${skipped} 篇已在文獻庫中，略過）\n` : "")
			+ `匯入的文獻會加上標籤「${screening.config().sourcePrefix}${SOURCE_NAME}」，篩選標籤不會變動；不會下載 PDF。`);
		if (!ok) return { imported: 0, skipped, failed: [], cancelled: true };
		busy = true;
		let pw = new Zotero.ProgressWindow({ closeOnClick: true });
		pw.changeHeadline(headline);
		pw.show();
		let line = new pw.ItemProgress("note", `匯入 ${todo.length} 篇…`);
		let tag = screening.config().sourcePrefix + SOURCE_NAME;
		let imported = new Set();
		let failed = [];
		let count = 0;
		try {
			for (let [i, c] of todo.entries()) {
				line.setText(`匯入 ${i + 1}/${todo.length}：${c.title || c.doi || c.pmid}`);
				line.setProgress(Math.round(i / todo.length * 100));
				try {
					let items = await translateIdentifier(c.doi ? { DOI: c.doi } : { PMID: c.pmid }, libraryID,
						collection ? [collection.id] : false);
					let regular = (items || []).filter(it => it && it.isRegularItem && it.isRegularItem());
					if (!regular.length) throw new Error("查不到這個識別碼");
					for (let item of regular) {
						item.addTag(tag);
						await ZB.main.saveQuietly(item);
					}
					count += regular.length;
					imported.add(c.key);
				}
				catch (e) {
					Zotero.logError(e);
					failed.push(`${c.doi || "PMID " + c.pmid}：${e.message || e}`);
				}
			}
			if (imported.size) {
				// Re-read: the user may have edited the note meanwhile
				let current = await IOUtils.readUTF8(target.path);
				let text = markImported(current, imported);
				if (text !== current) await IOUtils.writeUTF8(target.path, text);
			}
			line.setText(`已匯入 ${count} 篇${failed.length ? `，${failed.length} 篇失敗` : ""}${skipped ? `，${skipped} 篇已在文獻庫` : ""}`);
			if (failed.length) {
				line.setError();
				pw.addDescription(`失敗：${failed.slice(0, 5).join("；")}${failed.length > 5 ? `…等 ${failed.length} 篇` : ""}`);
			}
			else {
				line.setProgress(100);
			}
			if (count) pw.addDescription(`請照常篩選這些文獻（標籤「${tag}」）；PRISMA 流程圖會把它們算在「其他方法」欄。`);
		}
		catch (e) {
			Zotero.logError(e);
			failed.push(String(e.message || e));
			line.setText(`失敗：${e.message || e}`);
			line.setError();
		}
		finally {
			busy = false;
			pw.startCloseTimer(failed.length ? 20000 : 10000);
		}
		return { imported: count, skipped, failed };
	}

	// ---------- menus ----------

	function selectedCollections(context) {
		return (context.collectionTreeRows || []).filter(r => r.isCollection && r.isCollection()).map(r => r.ref);
	}

	function needCollection(fn) {
		return async (collection) => {
			if (!collection) {
				scope.ZB.main.notify("Zotero Bridge：引文追蹤", "請先在左側選取系統性回顧的分類（回顧專案）。");
				return null;
			}
			return fn(collection);
		};
	}

	/** Item, collection and Tools menu entries; returns the menu IDs to unregister. */
	function registerMenus({ pluginID, icon }) {
		let log = e => Zotero.logError(e);
		let chaseOne = needCollection(chaseCollection);
		let ids = [];
		ids.push(Zotero.MenuManager.registerMenu({
			menuID: "zotero-bridge-chase-item",
			pluginID,
			target: "main/library/item",
			menus: [{
				menuType: "menuitem",
				l10nID: "zotero-bridge-chase-items",
				icon,
				onCommand: (ev, context) => {
					chaseItems(context.items || [], activeCollection()).catch(log);
				},
			}],
		}));
		ids.push(Zotero.MenuManager.registerMenu({
			menuID: "zotero-bridge-chase-collection",
			pluginID,
			target: "main/library/collection",
			menus: [{
				menuType: "submenu",
				l10nID: "zotero-bridge-chase-collection-menu",
				icon,
				onShowing: (ev, context) => context.setVisible(selectedCollections(context).length > 0),
				menus: [
					{
						menuType: "menuitem",
						l10nID: "zotero-bridge-chase-included",
						onCommand: (ev, context) => {
							chaseOne(selectedCollections(context)[0]).catch(log);
						},
					},
					{
						menuType: "menuitem",
						l10nID: "zotero-bridge-chase-import",
						onCommand: (ev, context) => {
							needCollection(importChecked)(selectedCollections(context)[0]).catch(log);
						},
					},
				],
			}],
		}));
		ids.push(Zotero.MenuManager.registerMenu({
			menuID: "zotero-bridge-chase-tools",
			pluginID,
			target: "main/menubar/tools",
			menus: [
				{
					menuType: "menuitem",
					l10nID: "zotero-bridge-chase-tools-included",
					onCommand: () => {
						chaseOne(activeCollection()).catch(log);
					},
				},
				{
					menuType: "menuitem",
					l10nID: "zotero-bridge-chase-tools-import",
					// Without a selected collection: the 「所選文獻」 note, imported into My Library
					onCommand: () => {
						importChecked(activeCollection()).catch(log);
					},
				},
			],
		}));
		return ids.filter(Boolean);
	}

	return {
		API, SEED_FIELDS, WORK_FIELDS, PER_PAGE, MIN_INTERVAL_MS, DEFAULT_MAX_REQUESTS, DEFAULT_MAX_PER_SEED, SOURCE_NAME, IMPORTED_MARK,
		pmidOf, pmidFromExtra, openAlexKey, seedURL, listURL, workToCandidate,
		RequestCapError, makeThrottle, OpenAlexClient, listWorks, chase,
		libraryIndex, buildCandidates, candidateKey, doiURL, candidateLine, candidateTable, buildChaseSection, buildChaseCSV, frontmatterFor,
		parseChecked, markImported,
		config, chaseCollection, chaseItems, importChecked, registerMenus,
	};
});
