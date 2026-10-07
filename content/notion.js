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
	const PROPERTY_SCHEMA = {
		"Authors": { rich_text: {} },
		"Year": { number: {} },
		"Publication": { rich_text: {} },
		"Item Type": { select: {} },
		"DOI": { url: {} },
		"Zotero": { url: {} },
		"Obsidian": { url: {} },
		"Tags": { multi_select: {} },
		"Collections": { multi_select: {} },
		"Library": { select: {} },
		"Citation Key": { rich_text: {} },
		"Zotero Key": { rich_text: {} },
		"Summary": { rich_text: {} },
		"APA": { rich_text: {} },
		"Last Synced": { date: {} },
	};

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
		constructor({ token, fetch, sleep }) {
			if (!token) throw new Error("Notion token is not set");
			this.token = token;
			this.fetch = fetch;
			this.sleep = sleep || (ms => new Promise(r => setTimeout(r, ms)));
			this.lastRequest = 0;
			this.dataSourceCache = new Map();
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

		async getSchema(dataSourceId) {
			let ds = await this.request("GET", `data_sources/${dataSourceId}`);
			let props = {};
			let titleName = null;
			for (let [name, def] of Object.entries(ds.properties || {})) {
				props[name] = def.type;
				if (def.type === "title") titleName = name;
			}
			return { props, titleName };
		}

		/** Add the plugin's properties that are missing. Returns the names it added. */
		async ensureSchema(dataSourceId) {
			let { props } = await this.getSchema(dataSourceId);
			let missing = {};
			for (let [name, def] of Object.entries(PROPERTY_SCHEMA)) {
				if (!props[name]) missing[name] = def;
			}
			if (Object.keys(missing).length) {
				await this.request("PATCH", `data_sources/${dataSourceId}`, { properties: missing });
			}
			return Object.keys(missing);
		}

		async findPageByZoteroKey(dataSourceId, zoteroKey) {
			let res = await this.request("POST", `data_sources/${dataSourceId}/query`, {
				filter: { property: "Zotero Key", rich_text: { equals: zoteroKey } },
				page_size: 1,
			});
			return (res.results && res.results[0]) || null;
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
	 * values: { title, authors, year, publication, itemType, doi, zotero, obsidian, tags, collections,
	 *           library, citationKey, zoteroKey, summary, apa, lastSynced }
	 */
	function buildProperties(schema, v) {
		let p = {};
		let set = (name, type, value) => {
			if (schema.props[name] === type) p[name] = value;
		};
		if (schema.titleName) p[schema.titleName] = { title: rt(v.title || "Untitled").slice(0, 1) };
		set("Authors", "rich_text", { rich_text: rt(v.authors) });
		let year = parseInt(v.year, 10);
		set("Year", "number", { number: Number.isFinite(year) ? year : null });
		set("Publication", "rich_text", { rich_text: rt(v.publication) });
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
		set("APA", "rich_text", { rich_text: rt(v.apa) });
		set("Last Synced", "date", { date: v.lastSynced ? { start: v.lastSynced } : null });
		return p;
	}

	return { NOTION_VERSION, PROPERTY_SCHEMA, CONTAINER_MARKER, parseNotionId, NotionClient, NotionError, buildProperties };
});
