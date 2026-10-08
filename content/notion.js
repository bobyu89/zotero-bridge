/*
 * Zotero Bridge — minimal Notion API client (Notion-Version 2025-09-03, data sources).
 * `fetch` and `sleep` are injected so the client runs both inside Zotero and in Node tests.
 */
(function (root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) {
		module.exports = api;
	}
	else {
		(root.ZB = root.ZB || {}).notion = api;
	}
})(this, function () {
	const NOTION_VERSION = "2025-09-03";
	const BASE = "https://api.notion.com/v1/";
	const CONTAINER_MARKER = "Zotero Bridge";
	const MIN_INTERVAL_MS = 340; // Notion allows ~3 requests/second per integration

	// Database schema the plugin writes to. The title property keeps whatever name the database uses.
	// Columns follow Zotero's bibliographic fields (in this order), then the plugin's own fields.
	const PROPERTY_SCHEMA = {
		"Authors": { rich_text: {} },
		"Year": { number: {} },
		"Date": { rich_text: {} },
		"Publication": { rich_text: {} },
		"Volume": { rich_text: {} },
		"Issue": { rich_text: {} },
		"Pages": { rich_text: {} },
		"Publisher": { rich_text: {} },
		"Item Type": { select: {} },
		"DOI": { url: {} },
		"URL": { url: {} },
		"Abstract": { rich_text: {} },
		"Zotero": { url: {} },
		"Obsidian": { url: {} },
		"Tags": { multi_select: {} },
		"Collections": { multi_select: {} },
		"Library": { select: {} },
		// Reading status, kept in sync with the Zotero status tag and the note's `status` (status.js).
		// A select, not a Notion "status" property: the API can't put status options into their
		// To-do / In progress / Complete groups, and a page can't be given a status option that doesn't
		// exist yet, while a select takes any value (e.g. a status the user added in Obsidian).
		"Status": { select: { options: [
			{ name: "待讀", color: "gray" },
			{ name: "閱讀中", color: "blue" },
			{ name: "已讀", color: "green" },
			{ name: "已引用", color: "purple" },
			{ name: "已刪除", color: "red" },
		] } },
		"Citation Key": { rich_text: {} },
		"Zotero Key": { rich_text: {} },
		"Summary": { rich_text: {} },
		// Full-text status (scanned.js): is the PDF a scan without a text layer?
		"Full Text": {
			select: {
				options: [
					{ name: "ok", color: "green" },
					{ name: "partial", color: "yellow" },
					{ name: "none", color: "red" },
					{ name: "no_pdf", color: "gray" },
				],
			},
		},
		// Structured data from the AI note (filter e.g. Study Design = RCT and Sample Size > 100)
		"Study Design": { select: {} },
		"Sample Size": { number: {} },
		"Evidence Level": { select: {} },
		"JBI Level": { select: {} },
		"Appraisal Tool": { select: {} },
		"Appraisal": { select: {} },
		// 文獻評讀表 (appraisal-form.js): checked once the user has verified the appraisal
		"Appraisal Verified": { checkbox: {} },
		"Population": { rich_text: {} },
		"Intervention": { rich_text: {} },
		"Comparison": { rich_text: {} },
		"Outcomes": { rich_text: {} },
		"Setting": { rich_text: {} },
		"Measures": { multi_select: {} },
		"Country": { select: {} },
		"APA": { rich_text: {} },
		"Date Added": { date: {} },
		"Last Synced": { date: {} },
	};

	// Column names for new databases (標題 is the title column). Canonical keys stay the English names
	// above: a database set up by an earlier version keeps its English columns and still works, and a
	// column is found by its stored property ID first, so renaming it in Notion doesn't break the sync.
	const PROPERTY_NAMES_ZH = {
		"Authors": "作者",
		"Year": "年份",
		"Date": "出版日期",
		"Publication": "期刊",
		"Volume": "卷",
		"Issue": "期",
		"Pages": "頁碼",
		"Publisher": "出版者",
		"Item Type": "文獻類型",
		"DOI": "DOI",
		"URL": "網址",
		"Abstract": "摘要",
		"Zotero": "Zotero 連結",
		"Obsidian": "Obsidian 連結",
		"Tags": "標籤",
		"Collections": "分類",
		"Library": "文獻庫",
		"Status": "閱讀狀態",
		"Citation Key": "引用鍵",
		"Zotero Key": "Zotero 識別碼",
		"Summary": "一句話摘要",
		"Full Text": "全文狀態",
		"Study Design": "研究設計",
		"Sample Size": "樣本數",
		"Evidence Level": "證據等級",
		"JBI Level": "JBI 證據等級",
		"Appraisal Tool": "評讀工具",
		"Appraisal": "評讀結果",
		"Appraisal Verified": "評讀已核對",
		"Population": "P 族群",
		"Intervention": "I 介入措施",
		"Comparison": "C 對照",
		"Outcomes": "O 結果指標",
		"Setting": "研究場域",
		"Measures": "測量工具",
		"Country": "國家",
		"APA": "APA 7",
		"Date Added": "加入日期",
		"Last Synced": "最後同步",
	};
	const TITLE_NAME_ZH = "標題";
	// Default title-column names Notion gives a new database; only these are offered for renaming
	const DEFAULT_TITLE_NAMES = ["Name", "Title", "名稱", "Aa Name"];

	/**
	 * Match a data source's properties to the plugin's columns. For each canonical key: the property
	 * with the stored ID, else the Chinese name, else the English name (the one with the expected type
	 * wins). The user's own columns are kept under their own names.
	 * @param {object} properties data source `properties` ({ name: { id, type } })
	 * @param {object} [stored] canonical key → property ID recorded earlier
	 * @returns {{ props: { key: type }, names: { key: name }, ids: { key: id }, titleName, titleId, english: number, chinese: number }}
	 */
	function resolveSchema(properties, stored) {
		stored = stored || {};
		let byName = new Map();
		let byId = new Map();
		let titleName = null;
		let titleId = null;
		for (let [name, def] of Object.entries(properties || {})) {
			let p = { name, id: def && def.id, type: def && def.type };
			byName.set(name, p);
			if (p.id) byId.set(p.id, p);
			if (p.type === "title") {
				titleName = name;
				titleId = p.id || "title";
			}
		}
		let props = {};
		let names = {};
		let ids = {};
		let claimed = new Set();
		let english = 0;
		let chinese = 0;
		for (let [key, def] of Object.entries(PROPERTY_SCHEMA)) {
			let want = Object.keys(def)[0];
			let zh = PROPERTY_NAMES_ZH[key];
			// A Chinese-named column of another type is the user's own (an English one of another type is
			// still ours: a database from an earlier version, reported as the wrong type)
			let byZh = byName.get(zh);
			let cands = [stored[key] && byId.get(stored[key]), byZh && (byZh.type === want || zh === key) ? byZh : null, byName.get(key)]
				.filter(p => p && p.type !== "title" && !claimed.has(p.name));
			let hit = cands.find(p => p.type === want) || cands[0];
			if (!hit) continue;
			claimed.add(hit.name);
			props[key] = hit.type;
			names[key] = hit.name;
			if (hit.id) ids[key] = hit.id;
			if (zh !== key) {
				if (hit.name === key) english++;
				else if (hit.name === zh) chinese++;
			}
		}
		for (let [name, p] of byName) {
			if (!claimed.has(name) && !(name in props)) props[name] = p.type;
		}
		return { props, names, ids, titleName, titleId, english, chinese };
	}

	/** The property name to use for a canonical key ("Zotero Key" → "Zotero 識別碼" in a Chinese database). */
	function propertyName(schema, key) {
		return (schema && schema.names && schema.names[key]) || key;
	}

	/** A page's value of a canonical property, whatever the column is called (null when absent). */
	function pageProperty(page, key, schema) {
		let props = (page && page.properties) || {};
		let name = schema && schema.names && schema.names[key];
		if (name && props[name]) return props[name];
		if (props[key]) return props[key];
		if (PROPERTY_NAMES_ZH[key] && props[PROPERTY_NAMES_ZH[key]]) return props[PROPERTY_NAMES_ZH[key]];
		let id = schema && schema.ids && schema.ids[key];
		if (id) {
			for (let v of Object.values(props)) {
				if (v && v.id === id) return v;
			}
		}
		return null;
	}

	/**
	 * What 「把 Notion 欄位改成中文」 would rename: [{ key, id, from, to }] plus `skipped` (a column
	 * already uses the Chinese name). The title column is renamed to 標題 only from Notion's default name.
	 */
	function renamePlan(schema) {
		let plan = [];
		let skipped = [];
		let taken = new Set(Object.values(schema.names || {}));
		for (let name of Object.keys(schema.props || {})) taken.add(name);
		if (schema.titleName) taken.add(schema.titleName);
		for (let [key, from] of Object.entries(schema.names || {})) {
			let to = PROPERTY_NAMES_ZH[key];
			if (!to || from === to) continue;
			let id = schema.ids && schema.ids[key];
			if (!id || taken.has(to)) {
				skipped.push({ key, from, to });
				continue;
			}
			taken.add(to);
			plan.push({ key, id, from, to });
		}
		if (schema.titleName && DEFAULT_TITLE_NAMES.includes(schema.titleName) && !taken.has(TITLE_NAME_ZH)) {
			plan.unshift({ key: "title", id: schema.titleId || "title", from: schema.titleName, to: TITLE_NAME_ZH });
		}
		plan.skipped = skipped;
		return plan;
	}

	/** Extract a Notion ID from a URL or raw ID (database URLs carry the view ID in ?v=, so ignore the query). */
	function parseNotionId(input) {
		let s = String(input || "").trim().split(/[?#]/)[0];
		// The ID must not be glued to other hex characters (slugs like "My-DB-<id>" end in hex letters)
		let re = /(?<![0-9a-f])[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}(?![0-9a-f])/gi;
		let matches = s.match(re);
		if (!matches) return null;
		let hex = matches[matches.length - 1].replace(/-/g, "").toLowerCase();
		return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
	}

	class NotionError extends Error {
		constructor(status, code, message) {
			super(`Notion API ${status}${code ? ` (${code})` : ""}: ${message}`);
			this.status = status;
			this.code = code;
		}
	}

	class NotionClient {
		/**
		 * propertyIds: optional store of the property IDs per data source ({ get(dsId) → { key: id },
		 * set(dsId, ids) }), so a column renamed in Notion is still found.
		 */
		constructor({ token, fetch, sleep, propertyIds }) {
			if (!token) throw new Error("Notion token is not set");
			this.token = token;
			this.fetch = fetch;
			this.sleep = sleep || (ms => new Promise(r => setTimeout(r, ms)));
			this.lastRequest = 0;
			this.dataSourceCache = new Map();
			this.schemas = new Map();
			this.propertyIds = propertyIds || null;
		}

		async request(method, path, body, attempt = 0) {
			let wait = this.lastRequest + MIN_INTERVAL_MS - Date.now();
			if (wait > 0) await this.sleep(wait);
			this.lastRequest = Date.now();
			let res = await this.fetch(BASE + path, {
				method,
				headers: {
					"Authorization": `Bearer ${this.token}`,
					"Notion-Version": NOTION_VERSION,
					"Content-Type": "application/json",
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			if ((res.status === 429 || res.status >= 500) && attempt < 4) {
				let retryAfter = Number(res.headers && res.headers.get && res.headers.get("Retry-After"));
				await this.sleep((retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt));
				return this.request(method, path, body, attempt + 1);
			}
			let text = await res.text();
			let json = null;
			try {
				json = text ? JSON.parse(text) : null;
			}
			catch (e) {}
			if (!res.ok) {
				throw new NotionError(res.status, json && json.code, (json && json.message) || text || res.statusText);
			}
			return json;
		}

		/** Accepts a database URL/ID (or a data source ID) and returns the data source ID. */
		async resolveDataSourceId(databaseInput) {
			let id = parseNotionId(databaseInput);
			if (!id) throw new Error(`無法從「${databaseInput}」解析出 Notion database ID`);
			if (this.dataSourceCache.has(id)) return this.dataSourceCache.get(id);
			let dsId;
			try {
				let db = await this.request("GET", `databases/${id}`);
				if (!db.data_sources || !db.data_sources.length) {
					throw new Error("這個 Notion database 沒有 data source");
				}
				dsId = db.data_sources[0].id;
			}
			catch (e) {
				if (!(e instanceof NotionError) || e.status !== 404) throw e;
				// Maybe it is already a data source ID
				await this.request("GET", `data_sources/${id}`);
				dsId = id;
			}
			this.dataSourceCache.set(id, dsId);
			return dsId;
		}

		/**
		 * The data source's columns, matched to the plugin's (resolveSchema): `props` is keyed by the
		 * canonical (English) names, `names` gives the name each one has in this database.
		 */
		async getSchema(dataSourceId) {
			let ds = await this.request("GET", `data_sources/${dataSourceId}`);
			let stored = {};
			try {
				stored = (this.propertyIds && this.propertyIds.get(dataSourceId)) || {};
			}
			catch (e) {}
			let schema = resolveSchema(ds.properties, stored);
			this.schemas.set(dataSourceId, schema);
			if (this.propertyIds && Object.keys(schema.ids).length) {
				try {
					this.propertyIds.set(dataSourceId, Object.assign({}, stored, schema.ids));
				}
				catch (e) {}
			}
			return schema;
		}

		/** The name of a canonical column in this data source (after getSchema), else the canonical name. */
		propName(dataSourceId, key) {
			return propertyName(this.schemas.get(dataSourceId), key);
		}

		/**
		 * Add the plugin's properties that are missing, with Chinese names unless the database already
		 * uses the English ones (set up by an earlier version). Never adds a second column for one that
		 * exists under either name. Returns the names it added.
		 */
		async ensureSchema(dataSourceId) {
			let schema = await this.getSchema(dataSourceId);
			let chinese = schema.chinese >= schema.english;
			let missing = {};
			for (let [key, def] of Object.entries(PROPERTY_SCHEMA)) {
				if (schema.names[key]) continue;
				// A column of the user's with that name (another type) blocks it: use the other language
				let options = chinese ? [PROPERTY_NAMES_ZH[key], key] : [key, PROPERTY_NAMES_ZH[key]];
				let name = options.find(n => !(n in schema.props) && !(n in missing) && n !== schema.titleName);
				if (name) missing[name] = def;
			}
			if (Object.keys(missing).length) {
				await this.request("PATCH", `data_sources/${dataSourceId}`, { properties: missing });
				// Record the new columns' IDs
				await this.getSchema(dataSourceId);
			}
			return Object.keys(missing);
		}

		/** Rename columns (renamePlan) by property ID. Returns the plan that was applied. */
		async renameProperties(dataSourceId, plan) {
			if (!plan || !plan.length) return [];
			let properties = {};
			for (let step of plan) properties[step.id] = { name: step.to };
			await this.request("PATCH", `data_sources/${dataSourceId}`, { properties });
			await this.getSchema(dataSourceId);
			return plan;
		}

		async findPageByZoteroKey(dataSourceId, zoteroKey) {
			let res = await this.request("POST", `data_sources/${dataSourceId}/query`, {
				filter: { property: this.propName(dataSourceId, "Zotero Key"), rich_text: { equals: zoteroKey } },
				page_size: 1,
			});
			return (res.results && res.results[0]) || null;
		}

		/** Every page whose "Zotero Key" is one of `zoteroKeys` (one query per 50 keys). */
		async findPagesByZoteroKeys(dataSourceId, zoteroKeys) {
			let pages = [];
			for (let i = 0; i < zoteroKeys.length; i += 50) {
				let filter = {
					or: zoteroKeys.slice(i, i + 50).map(key => ({ property: this.propName(dataSourceId, "Zotero Key"), rich_text: { equals: key } })),
				};
				let cursor;
				do {
					let res = await this.request("POST", `data_sources/${dataSourceId}/query`,
						Object.assign({ filter, page_size: 100 }, cursor ? { start_cursor: cursor } : {}));
					pages.push(...(res.results || []));
					cursor = res.has_more ? res.next_cursor : null;
				} while (cursor);
			}
			return pages;
		}

		/** Move a page to the Notion trash, where the user can still restore it. */
		async trashPage(pageId) {
			return this.request("PATCH", `pages/${pageId}`, { in_trash: true });
		}

		async listChildren(blockId) {
			let all = [];
			let cursor;
			do {
				let q = `blocks/${blockId}/children?page_size=100` + (cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : "");
				let res = await this.request("GET", q);
				all.push(...res.results);
				cursor = res.has_more ? res.next_cursor : null;
			} while (cursor);
			return all;
		}

		async appendChildren(blockId, children, placement) {
			let results = [];
			for (let i = 0; i < children.length; i += 100) {
				let body = { children: children.slice(i, i + 100) };
				if (i === 0 && placement) Object.assign(body, placement);
				let res = await this.request("PATCH", `blocks/${blockId}/children`, body);
				results.push(...res.results);
			}
			return results;
		}

		/** Create a page under another page (used for literature syntheses). Returns the new page. */
		async createChildPage(parentInput, title, blocks, emoji) {
			let parentId = parseNotionId(parentInput);
			if (!parentId) throw new Error(`無法從「${parentInput}」解析出 Notion 頁面 ID`);
			let page = await this.request("POST", "pages", {
				parent: { type: "page_id", page_id: parentId },
				icon: emoji ? { type: "emoji", emoji } : undefined,
				properties: { title: { title: [{ type: "text", text: { content: String(title).slice(0, 2000) } }] } },
			});
			if (blocks.length) await this.appendChildren(page.id, blocks);
			return page;
		}

		/**
		 * Replace the plugin-managed container block on a page, keeping the user's own blocks.
		 * The container is a callout whose text starts with CONTAINER_MARKER.
		 */
		async replaceManagedContainer(pageId, title, childBlocks) {
			let existing = await this.listChildren(pageId);
			let index = existing.findIndex(b => b.type === "callout"
				&& (b.callout.rich_text || []).map(r => r.plain_text).join("").startsWith(CONTAINER_MARKER));
			let placement = null;
			if (index >= 0) {
				let prev = index > 0 ? existing[index - 1] : null;
				await this.request("DELETE", `blocks/${existing[index].id}`);
				placement = prev ? { after: prev.id } : (existing.length > 1 ? { position: { type: "start" } } : null);
			}
			else if (existing.length) {
				placement = { position: { type: "start" } };
			}
			let container = {
				object: "block",
				type: "callout",
				callout: {
					rich_text: [{ type: "text", text: { content: `${CONTAINER_MARKER}｜${title}` }, annotations: { bold: true } }],
					icon: { type: "emoji", emoji: "📚" },
					color: "default",
					children: childBlocks.slice(0, 100),
				},
			};
			let created;
			try {
				created = await this.appendChildren(pageId, [container], placement);
			}
			catch (e) {
				// Older API versions reject `position`; fall back to appending at the end
				if (!(e instanceof NotionError) || e.status !== 400 || !placement || !placement.position) throw e;
				created = await this.appendChildren(pageId, [container]);
			}
			if (childBlocks.length > 100) {
				await this.appendChildren(created[0].id, childBlocks.slice(100));
			}
			return created[0].id;
		}

		/**
		 * The managed container with folded sections: `headBlocks` stay open at its top, each section
		 * becomes a toggle (in its colour) inside it. A toggle's children can't go in the same request
		 * as the container (Notion nests at most two levels per request), so the toggles follow in
		 * requests of their own. Returns { containerId, sectionIds } (sectionIds in the sections' order).
		 * @param {object[]} sections [{ title, color, children: blocks without children of their own }]
		 */
		async replaceManagedSections(pageId, title, headBlocks, sections) {
			let containerId = await this.replaceManagedContainer(pageId, title, headBlocks);
			let sectionIds = await this.appendToggles(containerId, sections || []);
			return { containerId, sectionIds };
		}

		/** Append toggles with their children under a block; returns the toggles' IDs. */
		async appendToggles(parentId, sections) {
			let toggles = sections.map(s => ({
				object: "block",
				type: "toggle",
				toggle: {
					rich_text: [{ type: "text", text: { content: String(s.title || "").slice(0, 2000) }, annotations: { bold: true } }],
					color: s.color || "default",
					children: (s.children || []).slice(0, 100),
				},
			}));
			let ids = [];
			// At most 100 toggles and about 900 blocks (Notion: 1,000) per request
			let batch = [];
			let count = 0;
			let flush = async () => {
				if (!batch.length) return;
				let res = await this.request("PATCH", `blocks/${parentId}/children`, { children: batch });
				ids.push(...((res && res.results) || []).map(r => r.id));
				batch = [];
				count = 0;
			};
			for (let t of toggles) {
				let n = 1 + t.toggle.children.length;
				if (batch.length && (batch.length >= 100 || count + n > 900)) await flush();
				batch.push(t);
				count += n;
			}
			await flush();
			for (let [i, s] of sections.entries()) {
				if ((s.children || []).length > 100 && ids[i]) await this.appendChildren(ids[i], s.children.slice(100));
			}
			return ids;
		}
	}

	// ---------- property builders ----------

	function rt(text) {
		text = String(text || "");
		if (!text) return [];
		let out = [];
		for (let i = 0; i < text.length && out.length < 100; i += 2000) {
			out.push({ type: "text", text: { content: text.slice(i, i + 2000) } });
		}
		return out;
	}

	function optionName(s) {
		// Notion select options cannot contain commas and are limited to 100 characters
		return String(s).replace(/,/g, "，").trim().slice(0, 100);
	}

	/**
	 * Build page properties, only for properties that exist in the schema with the expected type.
	 * values: { title, authors, year, date, publication, volume, issue, pages, publisher, itemType, doi,
	 *           url, abstract, zotero, obsidian, tags, collections, library, citationKey, zoteroKey,
	 *           summary, apa, dateAdded, lastSynced, study, fullText, status }
	 * fullText: full-text status of the PDF ("ok" | "partial" | "none" | "no_pdf", scanned.js)
	 * study: normalised structured data from the AI note (ZB.llm.normalizeStudyData). When it is
	 * absent the structured columns are left untouched, so a note without the JSON block doesn't
	 * wipe values from an earlier sync.
	 * appraisal: the 文獻評讀表 { verified, tool, overall } (appraisal-form.js); once verified, its tool
	 * and verdict replace the AI note's in "Appraisal Tool" / "Appraisal".
	 */
	function buildProperties(schema, v) {
		let p = {};
		// Canonical key → this database's column name (Chinese, English or renamed by the user)
		let set = (key, type, value) => {
			if (schema.props[key] === type) p[propertyName(schema, key)] = value;
		};
		if (schema.titleName) p[schema.titleName] = { title: rt(v.title || "Untitled").slice(0, 1) };
		set("Authors", "rich_text", { rich_text: rt(v.authors) });
		let year = parseInt(v.year, 10);
		set("Year", "number", { number: Number.isFinite(year) ? year : null });
		set("Date", "rich_text", { rich_text: rt(v.date) });
		set("Publication", "rich_text", { rich_text: rt(v.publication) });
		set("Volume", "rich_text", { rich_text: rt(v.volume) });
		set("Issue", "rich_text", { rich_text: rt(v.issue) });
		set("Pages", "rich_text", { rich_text: rt(v.pages) });
		set("Publisher", "rich_text", { rich_text: rt(v.publisher) });
		set("URL", "url", { url: v.url || null });
		set("Abstract", "rich_text", { rich_text: rt(v.abstract) });
		set("Date Added", "date", { date: v.dateAdded ? { start: v.dateAdded } : null });
		set("Item Type", "select", { select: v.itemType ? { name: optionName(v.itemType) } : null });
		set("DOI", "url", { url: v.doi ? `https://doi.org/${v.doi}` : null });
		set("Zotero", "url", { url: v.zotero || null });
		set("Obsidian", "url", { url: v.obsidian || null });
		let uniq = arr => [...new Set((arr || []).map(optionName).filter(Boolean))].slice(0, 100).map(name => ({ name }));
		set("Tags", "multi_select", { multi_select: uniq(v.tags) });
		set("Collections", "multi_select", { multi_select: uniq(v.collections) });
		set("Library", "select", { select: v.library ? { name: optionName(v.library) } : null });
		set("Citation Key", "rich_text", { rich_text: rt(v.citationKey) });
		set("Zotero Key", "rich_text", { rich_text: rt(v.zoteroKey) });
		set("Summary", "rich_text", { rich_text: rt(v.summary) });
		set("Full Text", "select", { select: v.fullText ? { name: optionName(v.fullText) } : null });
		let s = v.study;
		if (s) {
			let select = x => ({ select: x ? { name: optionName(x) } : null });
			set("Study Design", "select", select(s.study_design));
			set("Sample Size", "number", { number: Number.isFinite(s.sample_size) ? s.sample_size : null });
			set("Evidence Level", "select", select(s.evidence_level));
			set("JBI Level", "select", select(s.jbi_level));
			set("Appraisal Tool", "select", select(s.appraisal_tool));
			set("Appraisal", "select", select(s.appraisal_overall));
			set("Population", "rich_text", { rich_text: rt(s.population) });
			set("Intervention", "rich_text", { rich_text: rt(s.intervention) });
			set("Comparison", "rich_text", { rich_text: rt(s.comparison) });
			set("Outcomes", "rich_text", { rich_text: rt(s.outcomes) });
			set("Setting", "rich_text", { rich_text: rt(s.setting) });
			set("Measures", "multi_select", { multi_select: uniq(s.measures) });
			set("Country", "select", select(s.country));
		}
		let a = v.appraisal;
		if (a && a.verified) {
			set("Appraisal Tool", "select", { select: a.tool ? { name: optionName(a.tool) } : null });
			set("Appraisal", "select", { select: a.overall ? { name: optionName(a.overall) } : null });
		}
		set("Appraisal Verified", "checkbox", { checkbox: !!(a && a.verified) });
		// Reading status merged by status.js; left as it is when this sync doesn't include it
		if (v.status) set("Status", "select", { select: { name: optionName(v.status) } });
		set("APA", "rich_text", { rich_text: rt(v.apa) });
		set("Last Synced", "date", { date: v.lastSynced ? { start: v.lastSynced } : null });
		return p;
	}

	return {
		NOTION_VERSION, PROPERTY_SCHEMA, PROPERTY_NAMES_ZH, TITLE_NAME_ZH, CONTAINER_MARKER, parseNotionId, NotionClient, NotionError, buildProperties,
		resolveSchema, propertyName, pageProperty, renamePlan,
	};
});
