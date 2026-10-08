/*
 * Zotero Bridge — reading status kept the same in Zotero, Notion and Obsidian.
 *
 * Each side holds the status its own way:
 *   Zotero    exactly one tag "<prefix><status>", e.g. "狀態/已讀 ✅" (prefix and emoji are settings)
 *   Notion    the "Status" select column
 *   Obsidian  the note's `status` frontmatter (dragging a card in the Bases kanban changes it)
 *
 * The value last written to every side is remembered in one place per item: the note's
 * `status_synced` frontmatter, or the `status.synced` pref when no vault is configured. On each
 * sync a side whose value differs from it was changed by the user and wins; if several sides were
 * changed to different values, the fixed priority Obsidian > Zotero > Notion decides and the
 * conflict is reported. Timestamps can't decide it: Notion's last_edited_time, the note's mtime and
 * Zotero's dateModified change with any edit (and with the plugin's own writes), not only the status.
 * Auto-sync is the exception: it runs seconds after a change in Zotero, so there Zotero comes first.
 *
 * The helpers at the top are pure (Node tests); the rest needs Zotero.
 */
(function (root, factory) {
	if (typeof module === "object" && module.exports) {
		module.exports = factory(require("./core.js"), globalThis);
	}
	else {
		(root.ZB = root.ZB || {}).status = factory(root.ZB.core, root);
	}
})(this, function (core, scope) {
	const PREF = "extensions.zotero-bridge.";
	const DEFAULT_PREFIX = "狀態/";
	const DEFAULT_STATUS = core.STATUSES[0];
	const DELETED = core.DELETED_STATUS;
	// Conflict priority, highest first
	const SIDES = ["obsidian", "zotero", "notion"];
	// Auto-sync runs right after a change in Zotero, so Zotero's status is the latest one
	const AUTO_SYNC_PRIORITY = ["zotero", "obsidian", "notion"];
	const SIDE_NAMES = { obsidian: "Obsidian", zotero: "Zotero", notion: "Notion" };
	// Zotero shows a tag that contains an emoji in the items list, next to the title.
	// 待讀 has none so unread items stay uncluttered.
	const TAG_EMOJI = { "閱讀中": "📖", "已讀": "✅", "已引用": "📝" };
	const EMOJI_EDGE_RE = /^[\s\p{Extended_Pictographic}️‍]+|[\s\p{Extended_Pictographic}️‍]+$/gu;

	// ---------- pure helpers ----------

	/** Trimmed status; "" for none and for 已刪除, which only the plugin sets (for trashed items). */
	function cleanStatus(v) {
		let s = String(v === undefined || v === null ? "" : v).trim();
		return s === DELETED ? "" : s;
	}

	function tagFor(status, opts = {}) {
		let emoji = opts.emoji !== false && TAG_EMOJI[status];
		return (opts.prefix || DEFAULT_PREFIX) + status + (emoji ? " " + emoji : "");
	}

	/** The status in a tag ("狀態/已讀 ✅" → "已讀"), or "" when it isn't a status tag. */
	function tagStatus(tag, prefix = DEFAULT_PREFIX) {
		tag = String(tag || "");
		if (!prefix || !tag.startsWith(prefix)) return "";
		return tag.slice(prefix.length).replace(EMOJI_EDGE_RE, "").trim();
	}

	function isStatusTag(tag, prefix) {
		return !!tagStatus(tag, prefix);
	}

	/**
	 * The item's status from its tags. Several status tags (e.g. a colored tag added with its
	 * number key next to the old one) resolve to the one that differs from `base`, then to the
	 * one furthest along the reading order.
	 */
	function zoteroStatus(tags, opts = {}, base = "") {
		let values = [...new Set((tags || []).map(t => tagStatus(t, opts.prefix || DEFAULT_PREFIX)).filter(Boolean))];
		if (values.length <= 1) return values[0] || "";
		let fresh = values.filter(v => v !== base);
		let pool = fresh.length ? fresh : values;
		let rank = v => core.STATUSES.indexOf(v);
		pool.sort((a, b) => rank(b) - rank(a) || a.localeCompare(b));
		return pool[0];
	}

	/** True when the tags aren't exactly one status tag for `value`. */
	function zoteroNeedsWrite(tags, value, opts = {}) {
		let own = (tags || []).filter(t => isStatusTag(t, opts.prefix || DEFAULT_PREFIX));
		return !(own.length === 1 && tagStatus(own[0], opts.prefix || DEFAULT_PREFIX) === value);
	}

	/**
	 * Merge the sides' statuses against the last synced value.
	 * values: { obsidian, zotero, notion } — a missing (undefined) side isn't part of this sync;
	 * "" means the side has no status yet and takes the result. `priority` orders the sides for conflicts.
	 * Returns { value, source, conflict: null | { values: {side: status}, winner }, writes: [sides] }.
	 */
	function mergeStatus({ base, values, priority = SIDES }) {
		base = cleanStatus(base);
		let present = priority.filter(s => values[s] !== undefined && values[s] !== null);
		let changed = present.filter(s => cleanStatus(values[s]) && cleanStatus(values[s]) !== base);
		let distinct = [...new Set(changed.map(s => cleanStatus(values[s])))];
		let value;
		let source;
		let conflict = null;
		if (!distinct.length) {
			value = base || DEFAULT_STATUS;
			source = base ? "base" : "default";
		}
		else {
			// `changed` is in priority order, so its first side wins a conflict
			source = changed[0];
			value = cleanStatus(values[source]);
			if (distinct.length > 1) {
				conflict = { values: Object.fromEntries(changed.map(s => [s, cleanStatus(values[s])])), winner: source };
			}
		}
		let writes = present.filter(s => String(values[s]).trim() !== value);
		return { value, source, conflict, writes };
	}

	function describeConflict(conflict) {
		let list = Object.entries(conflict.values).map(([s, v]) => `${SIDE_NAMES[s]}「${v}」`).join("、");
		return `⚠️ 閱讀狀態衝突：${list} → 採用 ${SIDE_NAMES[conflict.winner]}「${conflict.values[conflict.winner]}」`;
	}

	/** Status and last-synced value of a note's text; a note marked deleted counts with its old status. */
	function noteStatus(text) {
		let fm = text === null || text === undefined ? null : core.splitFrontmatter(String(text)).frontmatter;
		if (fm === null) return { value: "", base: "" };
		let value = core.frontmatterScalar(fm, "status");
		if (value === DELETED && core.parseFrontmatterBlocks(fm).some(b => b.key === "zotero_deleted")) {
			// A sync gives the restored item's note this status back (core.buildObsidianNote)
			value = core.frontmatterScalar(fm, "status_before_delete");
		}
		return { value, base: core.frontmatterScalar(fm, "status_synced") };
	}

	/** Set `status` (and `status_synced` with recordBase) in a note; nothing else changes. */
	function applyToNote(text, value, recordBase) {
		let { frontmatter, body } = core.splitFrontmatter(text);
		if (frontmatter === null || !value) return text;
		let fm = frontmatter;
		if (core.frontmatterScalar(fm, "status") !== value) fm = core.setFrontmatterValue(fm, "status", value);
		if (recordBase && core.frontmatterScalar(fm, "status_synced") !== value) fm = core.setFrontmatterValue(fm, "status_synced", value);
		return fm === frontmatter ? text : `---\n${fm}\n---\n` + body;
	}

	/** The page's "Status" select value ("" when empty). */
	function notionStatus(page) {
		let p = page && page.properties && page.properties.Status;
		return (p && p.select && p.select.name) || "";
	}

	// ---------- settings ----------

	function config() {
		let get = k => Zotero.Prefs.get(PREF + k, true);
		return {
			enabled: get("status.enabled") !== false,
			prefix: String(get("status.tagPrefix") || "").trim() || DEFAULT_PREFIX,
			emoji: get("status.tagEmoji") !== false,
		};
	}

	// Last synced values for setups without a vault: { "library/KEY": "已讀" }
	function readPrefBases() {
		try {
			let all = JSON.parse(Zotero.Prefs.get(PREF + "status.synced", true) || "{}");
			return all && typeof all === "object" && !Array.isArray(all) ? all : {};
		}
		catch (e) {
			return {};
		}
	}

	function writePrefBases(changes) {
		let all = readPrefBases();
		let dirty = false;
		for (let [key, value] of Object.entries(changes)) {
			if (all[key] !== value) {
				all[key] = value;
				dirty = true;
			}
		}
		if (dirty) Zotero.Prefs.set(PREF + "status.synced", JSON.stringify(all), true);
	}

	// ---------- Zotero tags ----------

	/** Leave exactly one status tag on the item. A separate save is needed; returns whether it changed. */
	function setItemStatus(item, value, cfg) {
		let tags = item.getTags().map(t => t.tag);
		if (!value || !zoteroNeedsWrite(tags, value, cfg)) return false;
		for (let tag of tags) {
			if (isStatusTag(tag, cfg.prefix)) item.removeTag(tag);
		}
		item.addTag(tagFor(value, cfg));
		return true;
	}

	// ---------- per-item sync (main.js syncItem) ----------

	/**
	 * Merge the status before syncItem writes anything; returns the plan syncNotion and writeObsidian
	 * apply (null when status sync is off). The Zotero tag is written here. `data.tags` loses the
	 * status tags, which the Notion Status column and the `status` frontmatter carry instead.
	 * opts: { settings, action, route, obsidian, ctx, messages }
	 */
	async function prepare(item, data, opts) {
		let cfg = config();
		if (!cfg.enabled) return null;
		let { settings, action, route, obsidian, ctx, messages } = opts;
		let key = `${data.libraryPath}/${data.key}`;
		let tags = data.tags || [];
		data.tags = tags.filter(t => !isStatusTag(t, cfg.prefix));
		let plan = { key, values: {}, value: "", complete: true, pending: new Set(), baseInNote: !!settings.vaultPath, base: "" };
		try {
			if (settings.vaultPath) {
				let text = obsidian && (await IOUtils.exists(obsidian.path)) ? await IOUtils.readUTF8(obsidian.path) : null;
				let note = noteStatus(text);
				plan.base = note.base;
				// A new note is created with the result
				if (action.targets.has("obsidian")) plan.values.obsidian = note.value;
				else plan.complete = false;
			}
			else {
				plan.base = readPrefBases()[key] || "";
			}
			if (settings.notionToken && route.notionDatabase) {
				if (action.targets.has("notion")) await readNotion(plan, settings, route, ctx, messages);
				else plan.complete = false;
			}
			plan.values.zotero = zoteroStatus(tags, cfg, plan.base);
			let result = mergeStatus({ base: plan.base, values: plan.values, priority: action.silent ? AUTO_SYNC_PRIORITY : SIDES });
			plan.value = result.value;
			if (result.conflict) {
				messages.push(describeConflict(result.conflict));
				// Auto-sync has no progress window
				if (action.silent) scope.ZB.main.notify("Zotero Bridge：閱讀狀態衝突", `${data.title || data.key}\n${describeConflict(result.conflict)}`);
			}
			else if (plan.base && result.source !== "base") messages.push(`閱讀狀態 → ${result.value}（來自 ${SIDE_NAMES[result.source]}）`);
			if (zoteroNeedsWrite(tags, result.value, cfg)) {
				try {
					// Not a change for auto-sync to react to
					if (setItemStatus(item, result.value, cfg)) await scope.ZB.main.saveQuietly(item);
				}
				catch (e) {
					plan.complete = false;
					messages.push(`⚠️ 閱讀狀態無法寫入 Zotero：${e.message || e}`);
				}
			}
			if (result.writes.includes("notion")) plan.pending.add("notion");
			settle(plan);
		}
		catch (e) {
			Zotero.logError(e);
			messages.push(`⚠️ 閱讀狀態：${e.message || e}`);
			return null;
		}
		return plan;
	}

	async function readNotion(plan, settings, route, ctx, messages) {
		try {
			let client = ctx.notion(settings.notionToken);
			let dsId = await client.resolveDataSourceId(route.notionDatabase);
			let schema = ctx.schemaCache.get(dsId);
			if (!schema) {
				schema = await client.getSchema(dsId);
				// Same rule as syncNotion: a database without our columns gets them there first
				if (schema.props["Zotero Key"]) ctx.schemaCache.set(dsId, schema);
			}
			if (schema.props.Status && schema.props.Status !== "select") {
				if (!ctx.schemaHints.has("status:" + dsId)) {
					ctx.schemaHints.add("status:" + dsId);
					messages.push("Notion 資料庫的 Status 欄位不是「單選（select）」類型，閱讀狀態不會同步到 Notion：把它改名後按「測試連線並補齊資料庫欄位」");
				}
				return;
			}
			if (!schema.props["Zotero Key"]) {
				// First sync into this database: syncNotion adds the columns (Status too) and creates the page
				plan.notionPage = null;
				plan.values.notion = "";
				return;
			}
			if (!schema.props.Status) {
				if (!ctx.schemaHints.has("status:" + dsId)) {
					ctx.schemaHints.add("status:" + dsId);
					messages.push("Notion 資料庫還沒有 Status 欄位：到 設定 → Zotero Bridge 按「測試連線並補齊資料庫欄位」即可加上");
				}
				return;
			}
			plan.notionPage = await client.findPageByZoteroKey(dsId, plan.key);
			plan.values.notion = notionStatus(plan.notionPage);
		}
		catch (e) {
			// syncNotion runs into the same error and reports it
			plan.complete = false;
		}
	}

	/** Remember the result once every side holds it (in the pref; the note's copy is written by writeObsidian). */
	function settle(plan) {
		if (plan.baseInNote || !plan.complete || plan.pending.size || plan.base === plan.value) return;
		writePrefBases({ [plan.key]: plan.value });
		plan.base = plan.value;
	}

	/** The status syncNotion writes to the page ("" when Notion isn't part of this status sync). */
	function notionValue(plan) {
		return plan && plan.values.notion !== undefined ? plan.value : "";
	}

	/** syncNotion wrote the page. */
	function notionWritten(plan) {
		if (!plan) return;
		plan.pending.delete("notion");
		settle(plan);
	}

	/** writeObsidian: the note text with the merged status (and the last synced value once all sides have it). */
	function applyPlanToNote(text, plan) {
		if (!plan || plan.values.obsidian === undefined) return text;
		return applyToNote(text, plan.value, plan.complete && !plan.pending.size);
	}

	// ---------- item pane ----------

	/** A "閱讀狀態" picker at the top of the plugin's item pane section; changing it sets the Zotero tag. */
	function renderPaneRow(doc, body, item) {
		let cfg = config();
		if (!cfg.enabled || !item || !item.isRegularItem()) return;
		let current = zoteroStatus(item.getTags().map(t => t.tag), cfg);
		let values = ["", ...core.STATUSES];
		if (current && !values.includes(current)) values.push(current);
		let row = doc.createElement("div");
		row.setAttribute("style", "display: flex; align-items: center; gap: 6px; margin: 2px 0 6px;");
		let label = doc.createElement("span");
		label.textContent = "閱讀狀態：";
		row.append(label);
		let pick = (value) => {
			if (!value || value === current) return;
			current = value;
			// Auto-sync (when on) takes the change to Notion and Obsidian; otherwise the next sync does
			if (setItemStatus(item, value, cfg)) item.saveTx().catch(e => Zotero.logError(e));
		};
		if (typeof doc.createXULElement === "function") {
			let list = doc.createXULElement("menulist");
			for (let v of values) list.appendItem(v || "（未設定）", v);
			list.addEventListener("command", () => pick(list.value));
			row.append(list);
			body.append(row);
			list.value = current;
			return;
		}
		let select = doc.createElement("select");
		for (let v of values) {
			let option = doc.createElement("option");
			option.value = v;
			option.textContent = v || "（未設定）";
			select.append(option);
		}
		select.value = current;
		select.addEventListener("change", () => pick(select.value));
		row.append(select);
		body.append(row);
	}

	// ---------- Tools → 同步閱讀狀態 ----------

	/** Status-only pass over every synced item: no AI, no page or note rewrites beyond the status. */
	function runPass() {
		return scope.ZB.main.enqueue(() => runPassNow());
	}

	async function runPassNow() {
		let ZB = scope.ZB;
		let cfg = config();
		let settings;
		try {
			settings = await ZB.main.readSettings();
		}
		catch (e) {
			ZB.main.notify("Zotero Bridge 設定有誤", String(e.message || e));
			return null;
		}
		if (!cfg.enabled) {
			ZB.main.notify("Zotero Bridge", "閱讀狀態同步已關閉：到 設定 → Zotero Bridge → 閱讀狀態 開啟。");
			return null;
		}
		if (!settings.vaultPath && !settings.notionToken) {
			ZB.main.notify("Zotero Bridge", "請先到 設定 → Zotero Bridge 填入 Obsidian vault 路徑或 Notion integration token。");
			return null;
		}
		let pw = new Zotero.ProgressWindow({ closeOnClick: true });
		pw.changeHeadline("Zotero Bridge：同步閱讀狀態");
		pw.show();
		let line = new pw.ItemProgress("", "讀取文獻…");
		let counts = { checked: 0, zotero: 0, notion: 0, obsidian: 0, conflicts: 0 };
		let errors = [];
		let conflictLines = 0;
		let databases = new Map();
		try {
			// Trashed items are left alone: their notes stay 已刪除 and their Notion pages in the trash
			let items = [];
			for (let lib of Zotero.Libraries.getAll()) {
				if (lib.libraryType !== "user" && lib.libraryType !== "group") continue;
				items.push(...(await Zotero.Items.getAll(lib.libraryID, true)).filter(i => i.isRegularItem() && !i.deleted));
			}
			line.setText("讀取 Obsidian 筆記…");
			let index = settings.vaultPath ? await ZB.main.buildObsidianIndex(settings) : null;
			let client = settings.notionToken
				? new ZB.notion.NotionClient({ token: settings.notionToken, fetch: (u, i) => fetch(u, i) })
				: null;
			let prefBases = {};
			let storedBases = index ? {} : readPrefBases();
			let n = 0;
			for (let item of items) {
				n++;
				if (n % 20 === 1) line.setText(`檢查閱讀狀態… ${n}/${items.length}`);
				let title = item.getField("title") || item.key;
				try {
					let r = await passItem(item, { settings, cfg, index, client, databases, prefBases, storedBases, errors });
					if (!r) continue;
					counts.checked++;
					for (let side of ["zotero", "notion", "obsidian"]) {
						if (r.wrote[side]) counts[side]++;
					}
					if (r.conflict) {
						counts.conflicts++;
						if (conflictLines++ < 30) new pw.ItemProgress(item.getItemTypeIconName(), `${title} — ${describeConflict(r.conflict)}`);
					}
				}
				catch (e) {
					errors.push(`${title}：${e.message || e}`);
				}
			}
			if (Object.keys(prefBases).length) writePrefBases(prefBases);
			line.setText(`已檢查 ${counts.checked} 筆已同步的文獻`);
			line.setProgress(100);
		}
		catch (e) {
			errors.push(String(e.message || e));
			line.setText(`失敗：${e.message || e}`);
			line.setError();
		}
		for (let hint of new Set([...databases.values()].map(db => db.hint).filter(Boolean))) pw.addDescription(hint);
		let updated = [["Zotero", counts.zotero], ["Notion", counts.notion], ["Obsidian", counts.obsidian]].filter(([, c]) => c);
		pw.addDescription(`閱讀狀態：檢查 ${counts.checked} 筆，`
			+ (updated.length ? `更新 ${updated.map(([s, c]) => `${s} ${c} 筆`).join("、")}` : "三邊都一致")
			+ (counts.conflicts ? `；衝突 ${counts.conflicts} 筆（依 Obsidian > Zotero > Notion 採用）` : "")
			+ (errors.length ? `；失敗 ${errors.length} 筆（詳見 說明 → 除錯輸出記錄）` : ""));
		errors.forEach(e => Zotero.logError(new Error(e)));
		pw.startCloseTimer(errors.length || counts.conflicts ? 15000 : 5000);
		return counts;
	}

	/** The route's Notion database for the pass: every page with a Zotero Key, read once (100 per query). */
	async function passDatabase(databases, client, input) {
		if (databases.has(input)) return databases.get(input);
		let db = { pages: new Map(), usable: false, error: null };
		databases.set(input, db);
		try {
			let dsId = await client.resolveDataSourceId(input);
			let schema = await client.getSchema(dsId);
			if (schema.props["Zotero Key"] !== "rich_text") return db;
			if (schema.props.Status !== "select") {
				db.hint = schema.props.Status
					? "Notion 資料庫的 Status 欄位不是「單選（select）」類型，閱讀狀態不會同步到 Notion：把它改名後按「測試連線並補齊資料庫欄位」"
					: "Notion 資料庫還沒有 Status 欄位：到 設定 → Zotero Bridge 按「測試連線並補齊資料庫欄位」即可加上";
				return db;
			}
			db.usable = true;
			let cursor = null;
			do {
				let res = await client.request("POST", `data_sources/${dsId}/query`, Object.assign({
					filter: { property: "Zotero Key", rich_text: { is_not_empty: true } },
					page_size: 100,
				}, cursor ? { start_cursor: cursor } : {}));
				for (let page of res.results || []) {
					let key = ((page.properties && page.properties["Zotero Key"] && page.properties["Zotero Key"].rich_text) || [])
						.map(r => r.plain_text !== undefined ? r.plain_text : (r.text && r.text.content) || "").join("");
					if (key && !db.pages.has(key)) db.pages.set(key, page);
				}
				cursor = res.has_more ? res.next_cursor : null;
			} while (cursor);
		}
		catch (e) {
			db.error = e;
		}
		return db;
	}

	async function passItem(item, { settings, cfg, index, client, databases, prefBases, storedBases, errors }) {
		let ZB = scope.ZB;
		let lib = ZB.adapter.libraryInfo(item.libraryID);
		let key = `${lib.path}/${item.key}`;
		let values = {};
		let complete = true;
		let base = "";
		// Obsidian: the item's note, as the normal sync would pick it
		let note = null;
		if (index) {
			let entries = index.get(key) || [];
			if (entries.length) {
				let basename = ZB.core.noteBasename({
					title: item.getField("title"), shortTitle: item.getField("shortTitle"), year: item.getField("year"),
					citationKey: ZB.adapter.citationKey(item), creators: item.getCreatorsJSON(),
				}, settings.filenameFormat);
				let name = e => e.relParts[e.relParts.length - 1].replace(/\.md$/i, "");
				let entry = entries.find(e => name(e) === basename || name(e) === `${basename} (${item.key})`) || entries[0];
				let text = await IOUtils.readUTF8(entry.path);
				let parsed = noteStatus(text);
				note = { path: entry.path, text };
				values.obsidian = parsed.value;
				base = parsed.base;
			}
		}
		else {
			base = storedBases[key] || "";
		}
		// Notion: the page in the item's route database
		let page = null;
		if (client) {
			let data = {
				libraryRouteID: lib.routeID,
				collections: Zotero.Collections.get(item.getCollections()).map(ZB.adapter.collectionPath),
			};
			let route = ZB.core.resolveRoute(data, settings.rules, settings.defaults);
			if (route.notionDatabase) {
				let db = await passDatabase(databases, client, route.notionDatabase);
				if (db.error) {
					complete = false;
					if (!db.reported) {
						db.reported = true;
						errors.push(`Notion：${db.error.message || db.error}`);
					}
				}
				page = db.usable ? db.pages.get(key) || null : null;
				if (page) values.notion = notionStatus(page);
			}
		}
		// Only items synced before (a note or a Notion page) take part
		if (!note && !page) return null;
		let tags = item.getTags().map(t => t.tag);
		values.zotero = zoteroStatus(tags, cfg, base);
		let result = mergeStatus({ base, values });
		let wrote = {};
		if (setItemStatus(item, result.value, cfg)) {
			await ZB.main.saveQuietly(item);
			wrote.zotero = true;
		}
		if (page && result.writes.includes("notion")) {
			try {
				await client.request("PATCH", `pages/${page.id}`, {
					properties: ZB.notion.buildProperties({ props: { Status: "select" } }, { status: result.value }),
				});
				wrote.notion = true;
			}
			catch (e) {
				complete = false;
				errors.push(`${item.getField("title") || item.key}：Notion：${e.message || e}`);
			}
		}
		if (note) {
			let text = applyToNote(note.text, result.value, complete);
			if (text !== note.text) {
				await IOUtils.writeUTF8(note.path, text);
				// Writing only status_synced (first pass after an upgrade) isn't counted as a change
				if (result.writes.includes("obsidian")) wrote.obsidian = true;
			}
		}
		else if (!index && complete && base !== result.value) {
			prefBases[key] = result.value;
		}
		return { value: result.value, conflict: result.conflict, wrote };
	}

	return {
		DEFAULT_PREFIX, SIDES, AUTO_SYNC_PRIORITY, TAG_EMOJI,
		cleanStatus, tagFor, tagStatus, isStatusTag, zoteroStatus, zoteroNeedsWrite, mergeStatus, describeConflict,
		noteStatus, applyToNote, notionStatus,
		config, setItemStatus, prepare, notionValue, notionWritten, applyPlanToNote, renderPaneRow, runPass,
	};
});
