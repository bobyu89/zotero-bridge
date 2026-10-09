/*
 * ZotMax — concept hub notes (概念卡片) in Obsidian.
 *
 * The AI literature notes list 3–8 reusable concepts as [[概念]] links under 「關鍵概念」 (llm.js).
 * This module scans the plugin's literature notes (only their %% zotero-bridge:start/end %% region),
 * optionally adds the measures / outcomes from their frontmatter, normalizes the names (NFKC, so
 * full-width → half-width; case; spaces and hyphens; the user's alias list) and writes:
 *   - `<folder>/概念/<概念>.md` per concept: `aliases` in the frontmatter (so every spelling of the
 *     link resolves to the card), MeSH and PubMed links (search-links.js), a table of the papers that
 *     mention it, the concepts it co-occurs with and counts — all inside the managed region. A
 *     definition placeholder and 「✍️ 我的筆記」 stay the user's; notes are never deleted.
 *   - `<folder>/概念/概念索引.md`: every concept by frequency and a Mermaid graph of the top 15 and
 *     their co-occurrence.
 * Rebuilt from the Tools menu and after manual syncs (no network, no AI). Optionally an AI synthesis
 * per concept (Tools menu): the papers are labelled [S1]… by synthesis.js, numbers are checked like
 * review-draft.js, and the result goes into its own 「AI 綜整（草稿）」 block, which a rebuild keeps.
 *
 * The helpers at the top are pure (Node tests); the rest needs Zotero.
 */
(function (root, factory) {
	if (typeof module === "object" && module.exports) {
		module.exports = factory(require("./core.js"), require("./dashboard.js"), require("./synthesis.js"),
			require("./review-draft.js"), require("./search-links.js"), require("./usage.js"), globalThis);
	}
	else {
		(root.ZB = root.ZB || {}).concepts = factory(root.ZB.core, root.ZB.dashboard, root.ZB.synthesis,
			root.ZB.reviewDraft, root.ZB.searchLinks, root.ZB.usage, root);
	}
})(this, function (core, dashboard, synthesis, reviewDraft, searchLinks, usage, scope) {
	const PREF = "extensions.zotero-bridge.";
	const DEFAULT_FOLDER = "概念";
	const INDEX_NAME = "概念索引";
	const TITLE = "ZotMax：概念卡片";
	const TYPES = { concept: "概念", measure: "測量工具", outcome: "結果指標" };
	const TYPE_ORDER = [TYPES.concept, TYPES.measure, TYPES.outcome];
	const MAX_COOCCUR = 10;
	const MAX_GRAPH_NODES = 15;
	const MAX_GRAPH_EDGES = 30;
	const MAX_INDEX_ROWS = 500;
	const MAX_SUMMARY = 120;
	const MAX_NAME = 80;
	const MAX_CHOICES = 30;
	const MAX_AI_SOURCES = 30;
	const DASHBOARD_TOP = 10;
	const HEAD_BYTES = 8192;
	const USER_SECTION = "## ✍️ 我的筆記\n\n";
	const DEFINITION_SECTION = "## 📖 我的定義\n\n> [!note] 用自己的話寫下這個概念的定義與出處（例如概念分析、理論或量表手冊）；這一段由你維護，ZotMax 不會覆寫。";
	const MARK_START_RE = /^%% zotero-bridge:start.*%%[ \t]*$/m;
	const MARK_END_RE = /^%% zotero-bridge:end %%[ \t]*$/m;
	const AI_START = "%% zotero-bridge:concept-ai:start — AI 綜整由 ZotMax 產生，重新產生時會覆寫；要保留修改請複製到區塊外 %%";
	const AI_END = "%% zotero-bridge:concept-ai:end %%";
	const AI_START_RE = /^%% zotero-bridge:concept-ai:start.*%%[ \t]*$/m;
	const AI_END_RE = /^%% zotero-bridge:concept-ai:end %%[ \t]*$/m;
	const AI_HEADING = "AI 綜整（草稿）";
	const KEY_CONCEPTS_RE = /^(#{1,6})[ \t]*(?:🔑[ \t]*)?(?:關鍵概念|key concepts?)(?![A-Za-z]).*$/imu;
	const SUMMARY_RE = /^(#{1,6})[ \t]*一句話摘要[ \t]*$/m;
	const NOT_REPORTED_RE = /^(?:n\/?a|null|none|無|不適用|未報告|文中未報告|not reported)$/i;

	const DEFAULT_CONCEPT_PROMPT = `你是護理與醫學領域的研究助理，負責針對一個「概念」整合多篇文獻中與它有關的內容，寫成概念綜整草稿，放在研究生 Obsidian 的概念卡片中，供撰寫概念定義與文獻探討時參考。

寫作規則：
- 使用臺灣學術繁體中文；醫學、統計與研究方法術語保留英文。
- 引用只能使用提供的代號 [S1]、[S2]…，放在所支持的句子末尾、句號之前；同時引用多篇寫成 [S1, S3]。不要寫作者姓名或年份，也不要自行列出參考文獻（系統會轉換成引文與 APA 7 參考文獻）。
- 每個實證陳述都要標註代號；數字（樣本數、百分比、p 值、效應量、信賴區間）只能照抄提供資料中的數值並標註來源代號。
- 只根據提供的內容撰寫，聚焦在這個概念；資料不足時寫「現有文獻未報告」，不得編造研究、數據或定義。
- 不要使用表格，不要加前言或結語說明。

輸出格式（標題必須完全一致）：
## 定義與內涵
（各文獻如何定義或操作化這個概念；定義不一致時並列比較）

## 測量方式
（使用的量表或指標與其信效度；沒有就寫「現有文獻未報告」）

## 相關因素與介入
## 研究結果的一致與分歧
## 研究缺口
`;

	// ---------- names (pure) ----------

	function cleanName(raw) {
		return String(raw === undefined || raw === null ? "" : raw).normalize("NFKC").replace(/\s+/g, " ").trim();
	}

	/** The comparison key: NFKC (full-width → half-width), lower case, hyphens/underscores/spaces as one space. */
	function conceptKey(raw) {
		return cleanName(raw).toLowerCase().replace(/[\s\-‐-―_]+/g, " ").trim();
	}

	/**
	 * The alias list from the settings, one group per line: `跌倒 = Accidental Falls = falls`. The first
	 * name is the card's name. Returns { map: Map<key, { key, name }>, groups: [{ name, names }], errors }.
	 */
	function parseAliases(text) {
		let map = new Map();
		let groups = [];
		let errors = [];
		for (let line of String(text || "").split(/\r?\n/)) {
			line = line.normalize("NFKC").trim();
			if (!line || line.startsWith("#") || line.startsWith("//")) continue;
			let names = [...new Set(line.split("=").map(cleanName).filter(Boolean))];
			if (names.length < 2) {
				errors.push(`別名設定「${line}」至少要有兩個名稱，用 = 分隔`);
				continue;
			}
			let group = { key: conceptKey(names[0]), name: names[0], names };
			for (let n of names) {
				let k = conceptKey(n);
				if (map.has(k) && map.get(k).key !== group.key) {
					errors.push(`「${n}」同時出現在兩組別名中，使用第一組（${map.get(k).name}）`);
					continue;
				}
				map.set(k, group);
			}
			groups.push(group);
		}
		return { map, groups, errors };
	}

	function isChinese(s) {
		return /[㐀-鿿豈-﫿]/.test(String(s || ""));
	}

	// ---------- literature notes (pure) ----------

	/**
	 * The text between the plugin's markers ("" when the markers are missing: then the user owns the body).
	 * The literature note keeps its parts in callouts: their "> " is taken off and each callout's title
	 * line becomes a top-level heading, so a section never runs on into the next callout.
	 */
	function managedRegion(text) {
		let body = core.splitFrontmatter(String(text || "")).body;
		let start = MARK_START_RE.exec(body);
		let end = MARK_END_RE.exec(body);
		if (!start || !end || end.index < start.index) return "";
		return body.slice(start.index + start[0].length, end.index).split("\n").map((line) => {
			let m = /^>[ \t]?\[![\w-]+\][+-]?[ \t]*(.*)$/.exec(line);
			if (m) return `# ${m[1]}`;
			return line.replace(/^>[ \t]?/, "");
		}).join("\n");
	}

	/** The body of the first heading matching `re` up to the next heading of the same or a higher level (fences skipped). */
	function headingSection(md, re) {
		let m = re.exec(md);
		if (!m) return null;
		let level = m[1].length;
		let out = [];
		let inFence = false;
		for (let line of md.slice(m.index + m[0].length).split("\n")) {
			if (/^\s*```/.test(line)) inFence = !inFence;
			let h = !inFence && /^(#{1,6})\s/.exec(line);
			if (h && h[1].length <= level) break;
			out.push(line);
		}
		return out.join("\n");
	}

	/** Targets of [[links]] (not ![[embeds]]): "[[A|label]]" → "A", "[[A#part]]" → "A". */
	function wikilinkTargets(md) {
		let out = [];
		for (let m of String(md || "").matchAll(/(?<!!)\[\[([^\]\n]+?)\]\]/g)) {
			let target = m[1].split("|")[0].replace(/\\$/, "").split("#")[0].trim();
			if (target) out.push(target);
		}
		return out;
	}

	/** The [[concepts]] under 「關鍵概念」 in a literature note's managed region. */
	function keyConcepts(text) {
		let section = headingSection(managedRegion(text), KEY_CONCEPTS_RE);
		return section === null ? [] : [...new Set(wikilinkTargets(section))];
	}

	/** The AI note's 「一句話摘要」 ("" without one): the 「重點」 block's 一句話, or the heading in older notes. */
	function oneLineSummary(text) {
		let region = managedRegion(text);
		let line = /^\*\*一句話\*\*[：:][ \t]*(.+)$/m.exec(region);
		if (line) return line[1].replace(/\s+/g, " ").trim();
		let section = headingSection(region, SUMMARY_RE);
		if (section === null) return "";
		let first = section.trim().split(/\n\s*\n/)[0] || "";
		return first.replace(/\s+/g, " ").trim();
	}

	function asList(v) {
		if (Array.isArray(v)) return v;
		return v ? [String(v)] : [];
	}

	function asText(v) {
		return Array.isArray(v) ? v.join(", ") : String(v === undefined || v === null ? "" : v).trim();
	}

	/** "跌倒發生率、跌倒自我效能" → ["跌倒發生率", "跌倒自我效能"] (short items only; "not reported" dropped). */
	function splitOutcomes(text) {
		return [...new Set(String(text || "").split(/\s*[、，,;；\n]\s*/).map(cleanName)
			.filter(s => s && s.length <= 40 && !NOT_REPORTED_RE.test(s)))];
	}

	/**
	 * One literature note: { relPath, link, title, year, design, level, summary, zoteroKey, deleted, mentions }.
	 * mentions: [{ name, type }] from 「關鍵概念」 and, with opts.measures / opts.outcomes, the frontmatter.
	 */
	function paperRecord(text, relPath, opts = {}) {
		let fm = dashboard.parseFrontmatter(core.splitFrontmatter(String(text || "")).frontmatter || "");
		let name = String(relPath).split("/").pop().replace(/\.md$/i, "");
		let status = asText(fm.status);
		let mentions = keyConcepts(text).map(n => ({ name: n, type: TYPES.concept }));
		if (opts.measures !== false) {
			for (let m of asList(fm.measures)) {
				if (cleanName(m) && !NOT_REPORTED_RE.test(cleanName(m))) mentions.push({ name: m, type: TYPES.measure });
			}
		}
		if (opts.outcomes) {
			for (let o of splitOutcomes(asText(fm.outcomes))) mentions.push({ name: o, type: TYPES.outcome });
		}
		return {
			relPath,
			link: String(relPath).replace(/\.md$/i, ""),
			name,
			title: asText(fm.title) || name,
			year: asText(fm.year),
			design: asText(fm.study_design),
			level: asText(fm.evidence_level),
			zoteroKey: asText(fm.zotero_key),
			deleted: status === core.DELETED_STATUS || !!fm.zotero_deleted,
			summary: oneLineSummary(text),
			mentions,
		};
	}

	// ---------- concepts (pure) ----------

	function byCount(a, b) {
		return b.papers.length - a.papers.length || a.name.localeCompare(b.name, "zh-Hant");
	}

	function byYearDesc(a, b) {
		return (Number(b.year) || 0) - (Number(a.year) || 0) || a.title.localeCompare(b.title);
	}

	/**
	 * Group the papers' mentions into concepts.
	 * @param {object[]} papers paperRecord()s (deleted ones are skipped)
	 * @param {object} opts { aliases: parseAliases() }
	 * @returns {{ concepts, byKey, papers }} concepts by paper count; each
	 *   { key, name, types, aliases, variants, papers (by year, newest first), cooccur: [{ concept, count }] }
	 */
	function collectConcepts(papers, opts = {}) {
		let aliasMap = (opts.aliases && opts.aliases.map) || new Map();
		let byKey = new Map();
		let live = papers.filter(p => !p.deleted).sort((a, b) => a.relPath.localeCompare(b.relPath));
		let paperKeys = new Map();
		for (let paper of live) {
			let keys = new Set();
			for (let { name, type } of paper.mentions) {
				let display = cleanName(name);
				let k = conceptKey(display);
				if (!k) continue;
				let group = aliasMap.get(k);
				let key = group ? group.key : k;
				let c = byKey.get(key);
				if (!c) {
					c = { key, fixedName: group ? group.name : "", types: new Set(), variants: new Map(), rawTargets: new Set(), papers: [], paperSet: new Set(), group };
					byKey.set(key, c);
				}
				c.types.add(type);
				c.variants.set(display, (c.variants.get(display) || 0) + 1);
				c.rawTargets.add(String(name).trim());
				if (!c.paperSet.has(paper.relPath)) {
					c.paperSet.add(paper.relPath);
					c.papers.push(paper);
				}
				keys.add(key);
			}
			paperKeys.set(paper.relPath, keys);
		}
		let concepts = [...byKey.values()].map((c) => {
			// The most used spelling (the first one seen on a tie), unless the alias list names the card
			let name = c.fixedName || [...c.variants].sort((a, b) => b[1] - a[1])[0][0];
			if (name.length > MAX_NAME) name = name.slice(0, MAX_NAME).trim();
			let names = [...c.variants.keys(), ...c.rawTargets, ...(c.group ? c.group.names : [])];
			let aliases = [];
			for (let n of names) {
				if (n !== name && !aliases.includes(n)) aliases.push(n);
			}
			return {
				key: c.key,
				name,
				types: TYPE_ORDER.filter(t => c.types.has(t)),
				aliases,
				variants: [...c.variants.keys()],
				papers: c.papers.sort(byYearDesc),
				cooccur: [],
			};
		});
		let index = new Map(concepts.map(c => [c.key, c]));
		let pairs = new Map();
		for (let keys of paperKeys.values()) {
			let list = [...keys];
			for (let i = 0; i < list.length; i++) {
				for (let j = 0; j < list.length; j++) {
					if (i === j) continue;
					let m = pairs.get(list[i]) || new Map();
					m.set(list[j], (m.get(list[j]) || 0) + 1);
					pairs.set(list[i], m);
				}
			}
		}
		for (let c of concepts) {
			c.cooccur = [...(pairs.get(c.key) || new Map())].map(([k, count]) => ({ concept: index.get(k), count }))
				.sort((a, b) => b.count - a.count || byCount(a.concept, b.concept));
		}
		concepts.sort(byCount);
		return { concepts, byKey: index, papers: live };
	}

	/**
	 * File names for the cards, in `folderParts` (vault-relative): sanitized, unique without regard to
	 * case, never the index note's name. Sets fileName, relPath and link on each concept.
	 */
	function assignFiles(concepts, folderParts) {
		let used = new Set([INDEX_NAME.toLowerCase()]);
		for (let c of concepts) {
			let base = core.sanitizeFilename(c.name);
			let name = base;
			if (used.has(name.toLowerCase())) name = `${base} (${c.types[0] || TYPES.concept})`;
			for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n})`;
			used.add(name.toLowerCase());
			c.fileName = name + ".md";
			c.link = [...folderParts, name].join("/");
			c.relPath = c.link + ".md";
			// A link spelled like the name but not a valid file name still resolves through `aliases`
			if (name !== c.name && !c.aliases.includes(c.name)) c.aliases.unshift(c.name);
		}
		return concepts;
	}

	// ---------- Markdown (pure) ----------

	function cell(v) {
		return String(v === undefined || v === null ? "" : v).replace(/\r?\n+/g, " ").replace(/\|/g, "\\|").trim();
	}

	function label(text, max = 80) {
		let s = String(text || "").replace(/\s+/g, " ").trim();
		if (s.length > max) s = s.slice(0, max - 1) + "…";
		return s.replace(/\|/g, "｜").replace(/\[/g, "(").replace(/\]/g, ")");
	}

	/** [[target|text]]; inTable escapes the pipe. */
	function wikilink(target, text, inTable = false) {
		let l = label(text);
		if (!l || l === target) return `[[${target}]]`;
		return `[[${target}${inTable ? "\\|" : "|"}${l}]]`;
	}

	function mdLink(text, url) {
		return `[${String(text).replace(/[[\]]/g, " ").replace(/\s+/g, " ").trim()}](${url})`;
	}

	function shorten(s, max) {
		s = String(s || "").replace(/\s+/g, " ").trim();
		return s.length > max ? s.slice(0, max - 1) + "…" : s;
	}

	/** The English name to look up (the name, else an English alias), or "". */
	function englishName(concept) {
		return [concept.name, ...concept.aliases].find(n => !isChinese(n) && /[A-Za-z]{2}/.test(n)) || "";
	}

	/**
	 * Search links for a card: MeSH and PubMed for an English name, Google Scholar for a Chinese one.
	 * cfg: searchLinks.normalizeConfig() (sources the user turned off are left out).
	 */
	function searchLine(concept, cfg) {
		if (!searchLinks || !cfg) return "";
		let links = [];
		let en = englishName(concept);
		if (en) {
			if (searchLinks.findSource(cfg, "mesh")) links.push(mdLink(`MeSH：${en}`, searchLinks.meshLookupURL(en)));
			let pubmed = searchLinks.findSource(cfg, "pubmed");
			if (pubmed) links.push(mdLink("PubMed 搜尋", searchLinks.buildTarget(pubmed, `"${en}"[tiab]`, cfg).url));
		}
		let zh = [concept.name, ...concept.aliases].find(isChinese);
		let scholar = searchLinks.findSource(cfg, "scholar");
		if (scholar && (zh || en)) links.push(mdLink(`Google Scholar：${zh || en}`, searchLinks.buildTarget(scholar, zh || en, cfg).url));
		return links.length ? `🔎 ${links.join(" · ")}` : "";
	}

	function yearRange(papers) {
		let years = papers.map(p => Number(p.year)).filter(y => Number.isFinite(y) && y > 0);
		if (!years.length) return "";
		let lo = Math.min(...years);
		let hi = Math.max(...years);
		return lo === hi ? String(lo) : `${lo}–${hi}`;
	}

	/** The managed region of a card. meta: { indexLink, cfg, total } */
	function buildConceptSection(concept, meta = {}) {
		let parts = [];
		parts.push("> [!info] 概念卡片：由 ZotMax 依文獻筆記「關鍵概念」的連結"
			+ (concept.types.some(t => t !== TYPES.concept) ? "與研讀資料（測量工具／結果指標）" : "")
			+ "整理；重新整理：ZotMax 按鈕或快速指令 → 更新概念卡片（手動同步後也會自動更新）。這個區塊以外的內容不會被覆寫。");
		let facts = [
			`**類型**：${concept.types.join("、") || TYPES.concept}`,
			`**文獻數**：${concept.papers.length}`,
		];
		let years = yearRange(concept.papers);
		if (years) facts.push(`**年份**：${years}`);
		if (concept.aliases.length) facts.push(`**別名**：${concept.aliases.join("、")}`);
		parts.push(facts.join(" · "));
		let search = searchLine(concept, meta.cfg);
		if (search) parts.push(search);
		parts.push(`## 📚 提到這個概念的文獻（${concept.papers.length}）`);
		parts.push([
			"| 文獻 | 年份 | 研究設計 | 證據等級 | 一句話摘要 |",
			"| --- | ---: | --- | --- | --- |",
			...concept.papers.map(p => `| ${wikilink(p.link, p.title, true)} | ${cell(p.year)} | ${cell(p.design)} | ${cell(p.level)} | ${cell(shorten(p.summary, MAX_SUMMARY))} |`),
		].join("\n"));
		parts.push("## 🔗 常一起出現的概念");
		let co = concept.cooccur.slice(0, MAX_COOCCUR);
		parts.push(co.length
			? co.map(({ concept: c, count }) => `- ${wikilink(c.link, c.name)}（${count} 篇）`).join("\n")
				+ (concept.cooccur.length > MAX_COOCCUR ? `\n\n（另有 ${concept.cooccur.length - MAX_COOCCUR} 個概念未列出）` : "")
			: "沒有和其他概念一起出現在同一篇文獻。");
		if (meta.indexLink) parts.push(`← ${wikilink(meta.indexLink, INDEX_NAME)}`);
		return parts.join("\n\n");
	}

	/** The managed region of a card no paper mentions any more (the note itself is kept). */
	function buildOrphanSection(meta = {}) {
		return [
			"> [!info] 概念卡片：由 ZotMax 整理。目前沒有文獻筆記提到這個概念（可能已改名、合併到別名，或文獻已刪除）；"
				+ "這份筆記不會被刪除，不需要時可以自行刪除。",
			meta.indexLink ? `← ${wikilink(meta.indexLink, INDEX_NAME)}` : "",
		].filter(Boolean).join("\n\n");
	}

	function replaceManaged(body, block) {
		let start = MARK_START_RE.exec(body);
		let end = MARK_END_RE.exec(body);
		if (start && end && end.index > start.index) {
			return body.slice(0, start.index) + block + body.slice(end.index + end[0].length);
		}
		// No markers (a note of the user's, or they were removed): a fresh block after the first heading
		let h1 = /^# .*$/m.exec(body);
		let at = h1 ? h1.index + h1[0].length : 0;
		return body.slice(0, at) + "\n\n" + block + "\n" + body.slice(at);
	}

	/**
	 * A note with a managed region. `fields` are frontmatter values (undefined = leave as is); every
	 * other key and everything outside the markers is kept. `updated` only changes when something else
	 * did, so an unchanged card is not rewritten. meta: { title, intro, now }
	 */
	function buildManagedNote(existing, fields, section, meta = {}) {
		let block = `${core.MARK_START}\n\n${section}\n\n${core.MARK_END}`;
		let now = meta.now || new Date().toISOString();
		let defined = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
		if (existing === null || existing === undefined) {
			return core.buildFrontmatter(Object.assign({}, defined, { updated: now }), null)
				+ `\n# ${meta.title}\n\n` + (meta.intro ? meta.intro + "\n\n" : "") + block + "\n\n" + USER_SECTION;
		}
		let { frontmatter, body } = core.splitFrontmatter(existing);
		let fm = frontmatter || "";
		for (let [k, v] of Object.entries(defined)) fm = core.setFrontmatterValue(fm, k, v);
		body = replaceManaged(body, block);
		body = body.startsWith("\n") ? body : "\n" + body;
		let make = u => `---\n${core.setFrontmatterValue(fm, "updated", u)}\n---\n` + body;
		let kept = frontmatter === null ? "" : core.frontmatterScalar(frontmatter, "updated");
		if (kept && make(kept) === existing) return existing;
		return make(now);
	}

	/** Aliases for the frontmatter: the user's first, then the card's. */
	function mergedAliases(existing, aliases) {
		let fm = existing ? core.splitFrontmatter(existing).frontmatter : null;
		let mine = fm ? asList(dashboard.parseFrontmatter(fm).aliases) : [];
		let out = [];
		for (let a of [...mine, ...aliases]) {
			if (a && !out.includes(a)) out.push(a);
		}
		return out;
	}

	/** A card. meta: { indexLink, cfg, now } */
	function buildConceptNote(existing, concept, meta = {}) {
		let aliases = mergedAliases(existing, concept.aliases);
		return buildManagedNote(existing, {
			type: "concept",
			concept: concept.name,
			concept_types: concept.types,
			papers: concept.papers.length,
			aliases: aliases.length ? aliases : undefined,
		}, buildConceptSection(concept, meta), { title: concept.name, intro: DEFINITION_SECTION, now: meta.now });
	}

	function mermaidLabel(s) {
		return String(s).replace(/"/g, "#quot;").replace(/[\r\n]+/g, " ");
	}

	/**
	 * Mermaid graph of the most cited concepts and how often they co-occur ("" for none). Concepts are
	 * boxes, measures stadiums, outcomes hexagons; at most MAX_GRAPH_EDGES edges, strongest first.
	 */
	function buildMermaid(concepts, max = MAX_GRAPH_NODES) {
		let top = concepts.slice(0, max);
		if (!top.length) return "";
		let ids = new Map(top.map((c, i) => [c.key, `c${i + 1}`]));
		let shape = (c, text) => {
			let t = `"${mermaidLabel(text)}"`;
			if (c.types[0] === TYPES.measure) return `([${t}])`;
			if (c.types[0] === TYPES.outcome) return `{{${t}}}`;
			return `[${t}]`;
		};
		let lines = ["```mermaid", "graph LR"];
		for (let c of top) lines.push(`    ${ids.get(c.key)}${shape(c, `${c.name}（${c.papers.length}）`)}`);
		let edges = [];
		for (let c of top) {
			for (let { concept: o, count } of c.cooccur) {
				if (ids.has(o.key) && ids.get(c.key) < ids.get(o.key)) edges.push({ a: c, b: o, count });
			}
		}
		let order = c => Number(ids.get(c.key).slice(1));
		edges.sort((x, y) => y.count - x.count || order(x.a) - order(y.a) || order(x.b) - order(y.b));
		for (let e of edges.slice(0, MAX_GRAPH_EDGES)) lines.push(`    ${ids.get(e.a.key)} ---|${e.count}| ${ids.get(e.b.key)}`);
		lines.push("```");
		return lines.join("\n");
	}

	/** The managed region of 概念索引. */
	function buildIndexSection(result, meta = {}) {
		let { concepts, papers } = result;
		let parts = ["> [!info] 由 ZotMax 依文獻筆記的「關鍵概念」連結（與研讀資料的測量工具／結果指標）整理；"
			+ "重新整理：ZotMax 按鈕或快速指令 → 更新概念卡片（手動同步後也會自動更新）。這個區塊以外的內容不會被覆寫。"];
		if (meta.aliasErrors && meta.aliasErrors.length) {
			parts.push("> [!warning] 別名設定有問題\n" + meta.aliasErrors.map(e => `> - ${e}`).join("\n"));
		}
		if (!concepts.length) {
			parts.push("還沒有概念：產生 AI 文獻筆記後，「關鍵概念」中的雙中括號連結會整理成概念卡片。");
			return parts.join("\n\n");
		}
		let withConcepts = papers.filter(p => p.mentions.length).length;
		parts.push(`共 **${concepts.length}** 個概念，來自 **${withConcepts}** 篇文獻筆記。`);
		parts.push(`## 🕸️ 前 ${Math.min(MAX_GRAPH_NODES, concepts.length)} 個概念與共同出現`);
		parts.push(buildMermaid(concepts));
		parts.push("括號內是文獻數，連線上的數字是兩個概念出現在同一篇文獻的篇數。方框＝概念、圓角＝測量工具、六角形＝結果指標。");
		parts.push("## 📊 依出現次數");
		let rows = concepts.slice(0, MAX_INDEX_ROWS).map(c => `| ${wikilink(c.link, c.name, true)} | ${cell(c.types.join("、"))} | ${c.papers.length} | `
			+ `${c.cooccur.slice(0, 3).map(o => wikilink(o.concept.link, o.concept.name, true)).join("、")} |`);
		parts.push(["| 概念 | 類型 | 文獻數 | 常一起出現 |", "| --- | --- | ---: | --- |", ...rows].join("\n")
			+ (concepts.length > MAX_INDEX_ROWS ? `\n\n（另有 ${concepts.length - MAX_INDEX_ROWS} 個概念未列出）` : ""));
		return parts.join("\n\n");
	}

	function buildIndexNote(existing, result, meta = {}) {
		return buildManagedNote(existing, { type: "concept-index", concepts: result.concepts.length },
			buildIndexSection(result, meta), { title: INDEX_NAME, now: meta.now });
	}

	/** 「🧠 熱門概念」 for the dashboard (dashboard.js). top: [{ name, link, papers }] by count. */
	function buildDashboardSection(top, meta = {}) {
		let parts = ["## 🧠 熱門概念"];
		if (!top.length) {
			parts.push("還沒有概念卡片：ZotMax 按鈕或快速指令 → 更新概念卡片（AI 文獻筆記「關鍵概念」中的雙中括號連結會整理成概念卡片）。");
			return parts.join("\n\n");
		}
		parts.push(`${meta.indexLink ? wikilink(meta.indexLink, INDEX_NAME) + "：" : ""}共 ${meta.total || top.length} 個概念；文獻數最多的 ${Math.min(DASHBOARD_TOP, top.length)} 個：`);
		parts.push(top.slice(0, DASHBOARD_TOP).map(c => `${wikilink(c.link, c.name)}（${c.papers}）`).join(" · "));
		return parts.join("\n\n");
	}

	// ---------- AI synthesis (pure) ----------

	/**
	 * The prompt for one concept over its papers (synthesis.js labels them [S1]…).
	 * sources: [{ data, aiMarkdown, study, annotationsText }]
	 */
	function buildConceptPrompt(concept, sources, opts = {}) {
		let names = [concept.name, ...concept.aliases.slice(0, 8)];
		return synthesis.buildSynthesisPrompt(
			sources.map(src => Object.assign({}, src, { extra: reviewDraft.studyDataLines(src.study) })),
			{
				systemPrompt: (opts.systemPrompt && opts.systemPrompt.trim()) || DEFAULT_CONCEPT_PROMPT,
				blocks: [`<concept>\n名稱：${concept.name}\n${names.length > 1 ? `其他寫法：${names.slice(1).join("、")}\n` : ""}類型：${concept.types.join("、")}\n</concept>`],
				closing: `請依照系統指示，聚焦在「${concept.name}」撰寫概念綜整草稿。`,
			});
	}

	function issueCount(issues) {
		return issues.numbers.length + issues.unknown.length + (issues.truncated ? 1 : 0) + (issues.noCitations ? 1 : 0);
	}

	/**
	 * The model's answer → { md, obsidian, issues } (issues as review-draft.js reports them: numbers not
	 * found in the cited sources, unknown labels, uncited sources, a cut-off answer, no citations at all).
	 * @param {Map<string,string>} texts source id → reviewDraft.sourceText()
	 * @param {object} linkTargets source id → literature note link
	 */
	function processConceptDraft(text, entries, texts, linkTargets = {}) {
		let { md, truncated } = reviewDraft.cleanDraft(text);
		let unknown = [];
		let obsidian = synthesis.resolveCitations(md, entries, "obsidian", linkTargets, { flagUnknown: true, unknown });
		let uncited = reviewDraft.uncitedEntries(md, entries);
		return {
			md, obsidian,
			issues: {
				numbers: reviewDraft.checkNumbers(md, entries, texts),
				unknown: [...new Set(unknown)],
				uncited,
				truncated,
				noCitations: uncited.length === entries.length,
			},
		};
	}

	/** The 「AI 綜整（草稿）」 block. draft: processConceptDraft(); meta: { model, generatedAt } */
	function buildAIBlock(draft, entries, meta = {}) {
		let count = issueCount(draft.issues);
		// The wording is review-draft.js's; a card has no Pandoc step
		let lines = reviewDraft.issueLines(draft.issues, entries).map(l => l.replace("，Pandoc 不會轉換", ""));
		let check = [
			"### ⚠️ 查核清單",
			"",
			count ? `> [!warning] ${count} 項需要回原文確認` : "> [!success] 需要查核的數字都能在所引用文獻的筆記或摘要中找到",
			...lines.map(l => `> - ${l}`),
			">",
			"> 數字只和各篇的 AI 筆記、結構化資料、摘要與劃線比對，不是 PDF 全文；系統只列出問題，沒有修改內容。",
		].join("\n");
		return [
			AI_START,
			`## 🤖 ${AI_HEADING}`,
			`> [!warning] AI 草稿：由 ${meta.model || "AI"} 於 ${String(meta.generatedAt || "").slice(0, 10)} 依 ${entries.length} 篇文獻的 AI 筆記產生；`
				+ "引用已轉為筆記連結，使用前請回原文確認。重新產生會覆寫這個區塊。",
			core.demoteHeadings(draft.obsidian.trim(), 1),
			core.demoteHeadings(synthesis.referenceList(entries), 1),
			check,
			AI_END,
		].join("\n\n");
	}

	/** Put the AI block into a card: replace the old one, else after the managed region (else before 我的筆記, else at the end). */
	function insertAIBlock(text, block, meta = {}) {
		let { frontmatter, body } = core.splitFrontmatter(String(text || ""));
		let start = AI_START_RE.exec(body);
		let end = AI_END_RE.exec(body);
		if (start && end && end.index > start.index) {
			body = body.slice(0, start.index) + block + body.slice(end.index + end[0].length);
		}
		else {
			let mark = MARK_END_RE.exec(body);
			let user = /^## ✍️ 我的筆記[ \t]*$/m.exec(body);
			if (mark) {
				let at = mark.index + mark[0].length;
				body = body.slice(0, at) + "\n\n" + block + body.slice(at);
			}
			else if (user) {
				body = body.slice(0, user.index) + block + "\n\n" + body.slice(user.index);
			}
			else {
				body = body.replace(/\s*$/, "") + "\n\n" + block + "\n";
			}
		}
		if (frontmatter === null) return body;
		let fm = meta.generatedAt ? core.setFrontmatterValue(frontmatter, "ai_synthesis", meta.generatedAt) : frontmatter;
		return `---\n${fm}\n---\n` + body;
	}

	// ---------- vault (needs Zotero) ----------

	function pref(key) {
		return Zotero.Prefs.get(PREF + key, true);
	}

	function readOptions() {
		return {
			folder: String(pref("concepts.folder") || "").trim() || DEFAULT_FOLDER,
			measures: pref("concepts.measures") !== false,
			outcomes: pref("concepts.outcomes") === true,
			aliases: parseAliases(pref("concepts.aliases")),
		};
	}

	function folderParts(settings, options = readOptions()) {
		return [...core.splitFolder(settings.defaults.obsidianFolder), ...core.splitFolder(options.folder)];
	}

	function searchConfig() {
		try {
			return searchLinks.readConfig();
		}
		catch (e) {
			Zotero.logError(e);
			return searchLinks.normalizeConfig({});
		}
	}

	/** Every synced item's literature note (its first copy), via main.js's vault index. */
	async function scanPapers(settings, options) {
		let index = await scope.ZB.main.buildObsidianIndex(settings);
		let papers = [];
		for (let entries of index.values()) {
			let entry = entries[0];
			try {
				papers.push(paperRecord(await IOUtils.readUTF8(entry.path), entry.relParts.join("/"), options));
			}
			catch (e) {
				Zotero.debug(`ZotMax: concepts skipped ${entry.path}: ${e}`);
			}
		}
		return papers;
	}

	async function readHead(path) {
		let bytes = await IOUtils.read(path, { maxBytes: HEAD_BYTES });
		let text = new TextDecoder().decode(bytes).replace(/^﻿/, "");
		if (bytes.length >= HEAD_BYTES && core.splitFrontmatter(text).frontmatter === null) text = await IOUtils.readUTF8(path);
		return dashboard.parseFrontmatter(core.splitFrontmatter(text).frontmatter || "");
	}

	/** The .md files in the concept folder (no subfolders): [{ path, name }]. */
	async function folderNotes(dir) {
		let children;
		try {
			children = await IOUtils.getChildren(dir);
		}
		catch (e) {
			return [];
		}
		return children.map(path => ({ path, name: PathUtils.filename(path) }))
			.filter(f => !f.name.startsWith(".") && /\.md$/i.test(f.name));
	}

	async function writeIfChanged(path, text, existing) {
		if (text === existing) return false;
		await IOUtils.writeUTF8(path, text);
		return true;
	}

	/**
	 * Rebuild every card and the index. Nothing is written while there are no concepts and no cards yet.
	 * Returns { concepts, papers, relPath (index), folderParts, written, orphans, aliasErrors } or null without a vault.
	 */
	async function update(settings, opts = {}) {
		if (!settings || !settings.vaultPath) return null;
		let options = readOptions();
		let parts = folderParts(settings, options);
		let dir = PathUtils.join(settings.vaultPath, ...parts);
		let now = (opts.now || new Date()).toISOString();
		let result = collectConcepts(await scanPapers(settings, options), { aliases: options.aliases });
		assignFiles(result.concepts, parts);
		let existingFiles = await folderNotes(dir);
		let indexLink = [...parts, INDEX_NAME].join("/");
		let out = { concepts: result.concepts, papers: result.papers, relPath: indexLink + ".md", folderParts: parts, written: 0, orphans: 0, aliasErrors: options.aliases.errors };
		if (!result.concepts.length && !existingFiles.length) return out;
		await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
		let cfg = searchConfig();
		let planned = new Set(result.concepts.map(c => c.fileName.toLowerCase()));
		for (let c of result.concepts) {
			let path = PathUtils.join(dir, c.fileName);
			try {
				let existing = (await IOUtils.exists(path)) ? await IOUtils.readUTF8(path) : null;
				if (await writeIfChanged(path, buildConceptNote(existing, c, { indexLink, cfg, now }), existing)) out.written++;
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
		// Cards no paper mentions any more: say so in their managed region, never delete them
		for (let f of existingFiles) {
			if (planned.has(f.name.toLowerCase()) || f.name.toLowerCase() === (INDEX_NAME + ".md").toLowerCase()) continue;
			try {
				let existing = await IOUtils.readUTF8(f.path);
				let fm = dashboard.parseFrontmatter(core.splitFrontmatter(existing).frontmatter || "");
				if (asText(fm.type) !== "concept" || !MARK_START_RE.test(existing)) continue;
				out.orphans++;
				let text = buildManagedNote(existing, { papers: 0 }, buildOrphanSection({ indexLink }), { now });
				if (await writeIfChanged(f.path, text, existing)) out.written++;
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
		let indexPath = PathUtils.join(dir, INDEX_NAME + ".md");
		let existingIndex = (await IOUtils.exists(indexPath)) ? await IOUtils.readUTF8(indexPath) : null;
		if (await writeIfChanged(indexPath, buildIndexNote(existingIndex, result, { now, aliasErrors: options.aliases.errors }), existingIndex)) out.written++;
		return out;
	}

	/** After a manual sync run (main.js): rebuild when 「同步後更新概念卡片」 is on. Never throws. */
	async function afterSync(settings) {
		try {
			if (!featureOn("concepts") || pref("concepts.autoUpdate") === false || !settings || !settings.vaultPath) return null;
			return await update(settings);
		}
		catch (e) {
			Zotero.logError(e);
			return null;
		}
	}

	/** 「🧠 熱門概念」 for the dashboard, from the cards' frontmatter only. Never throws. */
	async function dashboardSection(settings) {
		try {
			if (!settings || !settings.vaultPath) return "";
			let parts = folderParts(settings);
			let top = [];
			for (let f of await folderNotes(PathUtils.join(settings.vaultPath, ...parts))) {
				let fm = await readHead(f.path);
				let papers = Number(asText(fm.papers)) || 0;
				if (asText(fm.type) !== "concept" || papers < 1) continue;
				let name = f.name.replace(/\.md$/i, "");
				top.push({ name: asText(fm.concept) || name, link: [...parts, name].join("/"), papers });
			}
			top.sort((a, b) => b.papers - a.papers || a.name.localeCompare(b.name, "zh-Hant"));
			return buildDashboardSection(top, { indexLink: top.length ? [...parts, INDEX_NAME].join("/") : "", total: top.length });
		}
		catch (e) {
			Zotero.logError(e);
			return "";
		}
	}

	function notify(text) {
		scope.ZB.main.notify(TITLE, text);
	}

	async function settingsOrNotify() {
		let settings;
		try {
			settings = await scope.ZB.main.readSettings();
		}
		catch (e) {
			scope.ZB.main.notify("ZotMax 設定有誤", String(e.message || e));
			return null;
		}
		if (!settings.vaultPath) {
			notify("請先到 設定 → ZotMax 填入 Obsidian vault 路徑。");
			return null;
		}
		return settings;
	}

	/** Tools menu: rebuild now (after any sync in progress) and report. */
	function runFromMenu() {
		return scope.ZB.main.enqueue(async () => {
			let settings = await settingsOrNotify();
			if (!settings) return null;
			try {
				let result = await update(settings);
				if (!result.concepts.length) {
					notify("文獻筆記中還沒有概念：產生 AI 文獻筆記後，「關鍵概念」中的雙中括號連結會整理成概念卡片。"
						+ (result.orphans ? `（既有的 ${result.orphans} 張概念卡片已標示為沒有文獻提到）` : ""));
					return result;
				}
				let top = result.concepts.slice(0, 3).map(c => `${c.name}（${c.papers.length}）`).join("、");
				notify(`已更新 ${result.concepts.length} 張概念卡片（${result.written} 個檔案有變更），索引：${result.relPath}。最常見：${top}。`
					+ (result.aliasErrors.length ? `⚠️ 別名設定：${result.aliasErrors[0]}` : ""));
				return result;
			}
			catch (e) {
				Zotero.logError(e);
				notify(`更新失敗：${e.message || e}`);
				return null;
			}
		});
	}

	/** "library/KEY" / "groups/ID/KEY" → the Zotero item (null when gone). */
	function itemForKey(zoteroKey) {
		let m = /^(?:library|groups\/(\d+))\/([A-Z0-9]+)$/i.exec(String(zoteroKey || ""));
		if (!m) return null;
		let libraryID = m[1] ? Zotero.Groups.getLibraryIDFromGroupID(Number(m[1])) : Zotero.Libraries.userLibraryID;
		let item = libraryID ? Zotero.Items.getByLibraryAndKey(libraryID, m[2]) : null;
		return item && !item.deleted ? item : null;
	}

	function confirmText(settings, prompt, concept, sources, extra) {
		let lines = [`將用 ${settings.llm.model} 依 ${sources.length} 篇文獻${extra}為「${concept.name}」產生 AI 綜整，會產生一次 API 費用。`];
		try {
			let est = reviewDraft.estimateDraftCost(prompt.system, prompt.user, settings.llm.model, usage.parsePrices(pref("usage.prices")).prices);
			lines.push(est.expected === null
				? `輸入約 ${usage.formatTokens(est.inputTokens)} tokens（這個模型沒有價格資料，無法估算費用）。`
				: `預估費用：約 ${usage.formatUSD(est.expected)}（輸入約 ${usage.formatTokens(est.inputTokens)} tokens；最多約 ${usage.formatUSD(est.max)}）。`);
		}
		catch (e) {
			Zotero.logError(e);
		}
		let withoutAI = sources.filter(s => !s.aiMarkdown).length;
		if (withoutAI) lines.push(`其中 ${withoutAI} 篇沒有 AI 筆記，會改用摘要與劃線。`);
		lines.push("", "結果寫入概念卡片的「AI 綜整（草稿）」區塊（重新產生會覆寫這個區塊）。要繼續嗎？");
		return lines.join("\n");
	}

	/** Tools menu: pick one of the most cited concepts, confirm the cost, then generate after any sync in progress. */
	async function synthesizeFromMenu() {
		let ZB = scope.ZB;
		// 「概念卡片 AI 綜整」 off (the 研究生引導 preset): no AI call
		if (!featureOn("conceptsAI")) {
			ZB.main.notifyFeatureOff("conceptsAI");
			return null;
		}
		let settings = await settingsOrNotify();
		if (!settings) return null;
		if (!settings.llm.apiKey) {
			notify("AI 綜整需要 LLM API key：請到 設定 → ZotMax 填入。");
			return null;
		}
		let result;
		try {
			result = await ZB.main.enqueue(() => update(settings));
		}
		catch (e) {
			Zotero.logError(e);
			notify(`無法更新概念卡片：${e.message || e}`);
			return null;
		}
		let choices = result.concepts.filter(c => c.papers.length >= 2).slice(0, MAX_CHOICES);
		if (!choices.length) {
			notify("AI 綜整需要至少 2 篇文獻提到同一個概念；先為更多文獻產生 AI 筆記，或在設定中用別名合併同義的概念。");
			return null;
		}
		let win = Zotero.getMainWindow();
		let selected = { value: 0 };
		let labels = choices.map(c => `${c.name}（${c.papers.length} 篇${c.types[0] !== TYPES.concept ? `，${c.types[0]}` : ""}）`);
		if (!Services.prompt.select(win, TITLE, "要為哪個概念產生 AI 綜整？（依文獻數排序）", labels, selected)) return null;
		let concept = choices[selected.value];
		if (!concept) return null;
		let extra = concept.papers.length > MAX_AI_SOURCES ? `（超過 ${MAX_AI_SOURCES} 篇，只使用最新的 ${MAX_AI_SOURCES} 篇）` : "";
		let sources = [];
		for (let paper of concept.papers.slice(0, MAX_AI_SOURCES)) {
			let item = itemForKey(paper.zoteroKey);
			if (!item) continue;
			let data = await ZB.adapter.extractItemData(item, { fullTextLimit: 0 });
			let note = data.aiNote ? ZB.main.readAINote(data.aiNote.html) : null;
			sources.push({
				item, data, paper,
				aiMarkdown: note ? note.md : "",
				study: note ? note.data : null,
				annotationsText: ZB.llm.formatAnnotationsForPrompt(data),
			});
		}
		if (sources.length < 2) {
			notify(`「${concept.name}」在 Zotero 中找得到的文獻不到 2 篇（文獻可能已刪除）。`);
			return null;
		}
		let prompt = buildConceptPrompt(concept, sources, { systemPrompt: pref("concepts.aiPrompt") });
		if (!Services.prompt.confirm(win, "ZotMax", confirmText(settings, prompt, concept, sources, extra))) return null;
		return ZB.main.enqueue(() => generate(settings, concept, sources, prompt));
	}

	async function generate(settings, concept, sources, prompt) {
		let ZB = scope.ZB;
		let entries = prompt.entries;
		let pw = new Zotero.ProgressWindow({ closeOnClick: true });
		pw.changeHeadline(TITLE);
		pw.show();
		let line = new pw.ItemProgress("note", `AI 綜整「${concept.name}」中（${entries.length} 篇）…`);
		try {
			let runTotals = { ledger: {} };
			let result = await ZB.llm.generateText(settings.llm, prompt.system, prompt.user, (u, i) => fetch(u, i),
				Object.assign({ onRetry: ZB.main.retryStatus(s => line.setText(s)) }, ZB.main.runtime.retry));
			ZB.main.recordAIUsage(result, runTotals);
			let texts = new Map(sources.map((src, i) => [entries[i].id, reviewDraft.sourceText(src)]));
			let linkTargets = Object.fromEntries(sources.map((src, i) => [entries[i].id, src.paper.link]));
			let draft = processConceptDraft(result.text, entries, texts, linkTargets);
			let generatedAt = new Date().toISOString();
			let block = buildAIBlock(draft, entries, { model: result.model || settings.llm.model, generatedAt });
			let path = PathUtils.join(settings.vaultPath, ...concept.relPath.split("/"));
			// The card was written by update() just before; rebuild it if it went missing meanwhile
			let existing = (await IOUtils.exists(path)) ? await IOUtils.readUTF8(path)
				: buildConceptNote(null, concept, { indexLink: [...concept.link.split("/").slice(0, -1), INDEX_NAME].join("/"), cfg: searchConfig() });
			await IOUtils.writeUTF8(path, insertAIBlock(existing, block, { generatedAt }));
			line.setText(`${concept.name} — 已寫入 ${concept.relPath}`);
			line.setProgress(100);
			let count = issueCount(draft.issues);
			pw.addDescription(count ? `⚠️ 查核清單有 ${count} 項需要回原文確認（見概念卡片的 AI 綜整）。` : "數字查核：沒有發現對不上的數字；仍請回原文確認。");
			let usageLine = ZB.main.runUsageLine(runTotals);
			if (usageLine) pw.addDescription(usageLine);
			pw.startCloseTimer(count ? 20000 : 10000);
			return { draft, relPath: concept.relPath, entries };
		}
		catch (e) {
			Zotero.logError(e);
			line.setText(`失敗：${e.message || e}`);
			line.setError();
			pw.startCloseTimer(20000);
			return null;
		}
	}

	// Feature switches (features.js): checked live; always on when this file runs without them (Node tests)
	function featureOn(id) {
		let f = scope.ZB && scope.ZB.features;
		return !f || f.isEnabled(id);
	}

	return {
		DEFAULT_CONCEPT_PROMPT, INDEX_NAME, TYPES, AI_HEADING,
		cleanName, conceptKey, parseAliases, managedRegion, headingSection, wikilinkTargets, keyConcepts, oneLineSummary,
		splitOutcomes, paperRecord, collectConcepts, assignFiles, searchLine, buildConceptSection, buildOrphanSection,
		buildManagedNote, buildConceptNote, buildMermaid, buildIndexSection, buildIndexNote, buildDashboardSection,
		buildConceptPrompt, processConceptDraft, buildAIBlock, insertAIBlock,
		readOptions, update, afterSync, dashboardSection, runFromMenu, synthesizeFromMenu,
	};
});
