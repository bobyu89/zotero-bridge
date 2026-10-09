/*
 * ZotMax — bibliography export for Pandoc / Obsidian citations.
 *
 * Writes the library as CSL JSON (and optionally BibTeX) into the vault, e.g.
 * `Zotero/references.json`, so `[@citekey]` in Obsidian notes renders with
 * `pandoc --citeproc --bibliography Zotero/references.json --csl apa.csl`.
 *
 * Every entry's `id` is the citekey shown in the literature note's `citekey` frontmatter:
 * Zotero's Citation Key field, else the Better BibTeX key, else a generated key
 * `<first author><year><first title word>` (e.g. chen2024effects). Collisions get a/b/c suffixes.
 *
 * The pure helpers at the top are exported for the Node tests; the rest needs Zotero.
 */
(function (root, factory) {
	if (typeof module === "object" && module.exports) {
		module.exports = factory(require("./core.js"), globalThis, require("./apa-zh.js"));
	}
	else {
		(root.ZB = root.ZB || {}).bibliography = factory(root.ZB.core, root, root.ZB.apaZh);
	}
})(this, function (core, scope, apaZh) {
	const PREF = "extensions.zotero-bridge.";
	const MAIN_FILE = "references";
	// Built-in translator from zotero/translators (BibTeX.js header)
	const BIBTEX_TRANSLATOR_ID = "9cb70025-a888-4a29-a210-93ec52da40d4";

	// ---------- citekeys (pure) ----------

	const STOPWORDS = new Set([
		"a", "an", "the", "of", "on", "in", "and", "for", "to", "with", "at", "by", "from",
		"as", "is", "are", "into", "about", "over", "under", "between", "among", "its", "their",
	]);
	const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
	const LATIN_EXTRA = { "ß": "ss", "æ": "ae", "œ": "oe", "ø": "o", "ł": "l", "đ": "d", "ð": "d", "þ": "th", "ı": "i" };

	// Lowercase, drop accents (é → e) but keep other scripts (陳, 김), and keep only letters/digits
	function foldKeyPart(s) {
		return String(s || "")
			.normalize("NFD")
			.replace(/[\u0300-\u036f]/g, "")
			.normalize("NFC")
			.toLowerCase()
			.replace(/[ßæœøłđðþı]/g, c => LATIN_EXTRA[c])
			.replace(/[^\p{L}\p{N}]+/gu, "");
	}

	// First meaningful title word; Chinese/Japanese/Korean titles have no spaces, so take 4 characters
	function firstTitleWord(title) {
		let words = String(title || "").normalize("NFC").split(/[^\p{L}\p{N}]+/u).map(w => w.trim()).filter(Boolean);
		for (let word of words) {
			let w = foldKeyPart(word);
			if (!w || STOPWORDS.has(w) || /^\d+$/.test(w)) continue;
			return CJK_RE.test(w) ? Array.from(w).slice(0, 4).join("") : w;
		}
		return "";
	}

	function yearOf(data) {
		let m = /\d{4}/.exec(String(data.year || "") || String(data.date || ""));
		return m ? m[0] : "";
	}

	/**
	 * Generated citekey `<first author last name><year><first title word>`, e.g. chen2024effects.
	 * @param {object} data { creators, title, year|date, key }
	 */
	function generateCitekey(data) {
		let author = foldKeyPart(core.firstAuthorLastName(data));
		let key = author + yearOf(data) + firstTitleWord(data.title);
		if (!author && !firstTitleWord(data.title)) key = "";
		return key || "zotero" + foldKeyPart(data.key || "item");
	}

	// "", "a", …, "z", "aa", "ab", …
	function suffix(n) {
		let s = "";
		while (n > 0) {
			n--;
			s = String.fromCharCode(97 + (n % 26)) + s;
			n = Math.floor(n / 26);
		}
		return s;
	}

	/**
	 * Give every item a unique citekey. Uniqueness is case-insensitive (BibTeX keys are).
	 *
	 * - Explicit keys (Zotero / Better BibTeX) come first, so a generated key never renames them.
	 * - A generated key handed out before (`store`, persisted next to references.json) is kept
	 *   as long as the item exists and its base key is unchanged, so `[@lee2021effectsa]` in a
	 *   thesis never moves to another paper when the bare `lee2021effects` item is deleted.
	 * - Keys of deleted items and keys an item no longer uses are retired: never given to
	 *   another item, so an old citation fails loudly in Pandoc instead of citing the wrong work.
	 * - New collisions: the oldest item gets the bare key, later ones a, b, c…
	 * @param {Array<{id, uid, explicitKey, generatedKey, dateAdded}>} entries uid = "library/ITEMKEY"
	 * @param {{keys?: Object<uid, string>, retired?: string[]}} [store]
	 * @returns {{ keys: Map<id, string>, used: Set<string>, duplicates: string[], store }}
	 */
	function assignCitekeys(entries, store = {}) {
		let byAge = (a, b) => String(a.dateAdded || "").localeCompare(String(b.dateAdded || "")) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
		let explicit = entries.filter(e => e.explicitKey).sort(byAge);
		let generated = entries.filter(e => !e.explicitKey).sort(byAge);
		let prev = Object.assign({}, store.keys);
		let retired = new Set(store.retired || []);
		let keys = new Map();
		let used = new Set();
		let duplicates = [];
		let take = (e, key) => {
			used.add(key.toLowerCase());
			keys.set(e.id, key);
		};
		for (let e of explicit) {
			let key = uniqueKey(e.explicitKey, used);
			if (key !== e.explicitKey) duplicates.push(e.explicitKey);
			take(e, key);
		}
		let fresh = [];
		for (let e of generated) {
			let p = prev[e.uid];
			if (p && isKeyFor(p, e.generatedKey) && !used.has(p.toLowerCase())) take(e, p);
			else fresh.push(e);
		}
		// Reserved: retired keys and keys still held by items that are gone (e.g. in the trash)
		let present = new Map(entries.map(e => [e.uid, e]));
		let blocked = new Set([...retired].map(k => k.toLowerCase()));
		for (let [uid, k] of Object.entries(prev)) {
			if (!present.has(uid) || keys.get(present.get(uid).id) !== k) blocked.add(k.toLowerCase());
		}
		for (let e of fresh) {
			let key = e.generatedKey;
			for (let n = 0; used.has((key = e.generatedKey + suffix(n)).toLowerCase()) || blocked.has(key.toLowerCase()); n++);
			take(e, key);
		}
		// New store: current generated keys, items that are gone keep theirs, replaced keys retire
		let next = { keys: {}, retired: [...retired] };
		for (let [uid, k] of Object.entries(prev)) {
			if (!present.has(uid)) next.keys[uid] = k;
		}
		for (let e of entries) {
			let key = keys.get(e.id);
			if (!e.explicitKey) next.keys[e.uid] = key;
			if (prev[e.uid] && prev[e.uid] !== (e.explicitKey ? null : key) && !next.retired.includes(prev[e.uid])) {
				next.retired.push(prev[e.uid]);
			}
		}
		next.retired.sort();
		return { keys, used, duplicates, store: next };
	}

	// Was `key` generated from `base`? (base itself, or base + a/b/c… suffix)
	function isKeyFor(key, base) {
		let k = String(key).toLowerCase();
		let b = String(base).toLowerCase();
		return k.startsWith(b) && /^[a-z]*$/.test(k.slice(b.length));
	}

	function uniqueKey(base, used) {
		let n = 0;
		while (used.has((base + suffix(n)).toLowerCase())) n++;
		return base + suffix(n);
	}

	// ---------- CSL JSON / BibTeX assembly (pure) ----------

	/**
	 * Turn Zotero's CSL item into the exported entry: `id` is the citekey.
	 * Like Zotero's own citation processor (Zotero.Cite.System.retrieveItem), drop the URL of
	 * journal/newspaper/magazine articles that have pages unless `keepArticleURL`.
	 * Chinese names become full literal names and Chinese items get `language: "zh-TW"` (apa-zh.js).
	 */
	function toExportEntry(cslItem, citekey, opts = {}) {
		let entry = Object.assign({ id: citekey }, cslItem, { id: citekey, "citation-key": citekey });
		if (apaZh) entry = apaZh.adjustCSL(entry, opts.zh);
		let article = ["article-journal", "article-newspaper", "article-magazine"].includes(entry.type);
		if (!opts.keepArticleURL && article && entry.page) {
			delete entry.URL;
			delete entry.accessed;
		}
		return entry;
	}

	/** Stable file contents: entries sorted by id so a vault under git gets small diffs. */
	function buildCSLJSON(entries) {
		let sorted = entries.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		return JSON.stringify(sorted, null, "\t") + "\n";
	}

	const BIBTEX_ENTRY_RE = /^@([A-Za-z]+)\{([^,\s]*)/gm;

	/**
	 * Replace the keys the BibTeX translator generated with ours. The translator writes one
	 * entry per regular item, in the order Zotero hands them over (ascending item ID), so
	 * `keys` must be in that order. Refuses to guess if the counts differ.
	 */
	function rewriteBibTeXKeys(bib, keys) {
		let found = String(bib).match(BIBTEX_ENTRY_RE) || [];
		if (found.length !== keys.length) {
			throw new Error(`BibTeX 匯出筆數不符（${found.length} / ${keys.length}），已略過 .bib`);
		}
		let i = 0;
		return String(bib).replace(BIBTEX_ENTRY_RE, (all, type) => `@${type}{${keys[i++]}`);
	}

	function collectionFileName(name) {
		return `${MAIN_FILE}-${core.sanitizeFilename(name)}`;
	}

	// ---------- Zotero side ----------

	const STORE_FILE = ".zotero-bridge-citekeys.json";
	let keyState = null; // { storePath, result of assignCitekeys, bases: Map<id, base key> } from the last scan
	let cslCache = new Map(); // item id → { stamp, csl }
	let queue = Promise.resolve();
	let refreshQueued = false;

	function pref(key) {
		return Zotero.Prefs.get(PREF + key, true);
	}

	function itemKeyData(item) {
		return {
			key: item.key,
			title: item.getField("title"),
			year: item.getField("year"),
			date: item.getField("date"),
			creators: item.getCreatorsJSON(),
		};
	}

	async function regularItemsOfLibrary(libraryID) {
		let items = await Zotero.Items.getAll(libraryID, true);
		return items.filter(i => i.isRegularItem() && !i.deleted);
	}

	/** Every regular item in the user and group libraries: one citekey namespace for all exports. */
	async function allRegularItems() {
		let items = [];
		for (let lib of Zotero.Libraries.getAll()) {
			if (lib.libraryType !== "user" && lib.libraryType !== "group") continue;
			items.push(...await regularItemsOfLibrary(lib.libraryID));
		}
		return items;
	}

	// Generated keys handed out so far, kept in the vault so they survive restarts and other devices
	function storePath(settings) {
		if (!settings || !settings.vaultPath) return null;
		return PathUtils.join(settings.vaultPath, ...core.splitFolder(settings.defaults.obsidianFolder), STORE_FILE);
	}

	async function loadStore(path) {
		// This session's assignments are the newest (they may not be saved yet)
		if (keyState && keyState.storePath === path) return keyState.result.store;
		if (!path || !await IOUtils.exists(path)) return {};
		try {
			let store = JSON.parse(await IOUtils.readUTF8(path));
			return store && typeof store === "object" ? store : {};
		}
		catch (e) {
			Zotero.logError(e);
			return {};
		}
	}

	/** Assign citekeys to every item of every library (one namespace for all exports). */
	async function scanKeys(settings) {
		let path = storePath(settings);
		let store = await loadStore(path);
		let universe = await allRegularItems();
		let libraryPaths = new Map();
		let entries = universe.map((item) => {
			if (!libraryPaths.has(item.libraryID)) libraryPaths.set(item.libraryID, scope.ZB.adapter.libraryInfo(item.libraryID).path);
			return {
				id: item.id,
				uid: `${libraryPaths.get(item.libraryID)}/${item.key}`,
				explicitKey: scope.ZB.adapter.citationKey(item),
				generatedKey: generateCitekey(itemKeyData(item)),
				dateAdded: item.dateAdded,
			};
		});
		let result = assignCitekeys(entries, store);
		keyState = { storePath: path, result, bases: new Map(entries.map(e => [e.id, e.explicitKey || e.generatedKey])) };
		return { universe, result };
	}

	/**
	 * Citekey for one item without a Zotero/Better BibTeX key, as the export writes it; shown as
	 * the note's `citekey` frontmatter. Rescans the libraries only for new or retitled items.
	 */
	async function citekeyFor(item) {
		let explicit = scope.ZB.adapter.citationKey(item);
		if (explicit) return explicit;
		let settings = await scope.ZB.main.readSettings();
		if (!settings.vaultPath) return "";
		let base = generateCitekey(itemKeyData(item));
		let known = () => keyState && keyState.storePath === storePath(settings)
			&& keyState.bases.get(item.id) === base && keyState.result.keys.get(item.id);
		if (!known()) await scanKeys(settings);
		return known() || base;
	}

	// Zotero's CSL conversion is the slow part, so it is cached until the item changes
	async function cslFor(item) {
		let stamp = `${item.dateModified}|${item.version}`;
		let hit = cslCache.get(item.id);
		if (hit && hit.stamp === stamp) return hit.csl;
		let csl = await Zotero.Utilities.Item.itemToCSLJSON(item);
		cslCache.set(item.id, { stamp, csl });
		return csl;
	}

	async function writeIfChanged(path, text) {
		if (await IOUtils.exists(path) && await IOUtils.readUTF8(path) === text) return false;
		await IOUtils.writeUTF8(path, text, { tmpPath: path + ".tmp" });
		return true;
	}

	async function exportBibTeX(items, keyMap) {
		let sorted = items.slice().sort((a, b) => a.id - b.id);
		let translation = new Zotero.Translate.Export();
		translation.setItems(sorted.slice());
		translation.setTranslator(BIBTEX_TRANSLATOR_ID);
		translation.setDisplayOptions({ exportCharset: "UTF-8", exportNotes: false, exportFileData: false, useJournalAbbreviation: false });
		await new Promise((resolve, reject) => {
			translation.setHandler("done", (obj, worked) => (worked ? resolve() : reject(new Error("BibTeX 匯出失敗"))));
			Promise.resolve(translation.translate()).catch(reject);
		});
		return rewriteBibTeXKeys(translation.string || "", sorted.map(i => keyMap.get(i.id)));
	}

	/**
	 * Write `<name>.json` (and `<name>.bib` when enabled) for `items` (null = every item) into the vault's default
	 * Zotero folder. Citekeys always come from a scan of every library, so a collection
	 * file uses exactly the same keys as the main file.
	 */
	async function writeBibliography(items, name, settings) {
		let { universe, result } = await scanKeys(settings);
		let { keys, duplicates } = result;
		items = items || universe;
		let keepArticleURL = !!Zotero.Prefs.get("export.citePaperJournalArticleURL");
		let entries = [];
		let exported = [];
		let failed = 0;
		for (let item of items) {
			let key = keys.get(item.id);
			if (!key) continue; // not a regular item of a user/group library
			try {
				entries.push(toExportEntry(await cslFor(item), key, { keepArticleURL }));
				exported.push(item);
			}
			catch (e) {
				failed++;
				Zotero.logError(e);
			}
		}
		let dirParts = core.splitFolder(settings.defaults.obsidianFolder);
		let dir = PathUtils.join(settings.vaultPath, ...dirParts);
		await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
		await writeIfChanged(PathUtils.join(dir, name + ".json"), buildCSLJSON(entries));
		// Remember the generated keys so they never move to another item
		await writeIfChanged(storePath(settings), JSON.stringify(result.store, null, "\t") + "\n");
		let relPaths = [[...dirParts, name + ".json"].join("/")];
		let warnings = [];
		if (pref("export.bibtex")) {
			try {
				await writeIfChanged(PathUtils.join(dir, name + ".bib"), await exportBibTeX(exported, keys));
				relPaths.push([...dirParts, name + ".bib"].join("/"));
			}
			catch (e) {
				Zotero.logError(e);
				warnings.push(String(e.message || e));
			}
		}
		if (duplicates.length) warnings.push(`Zotero 裡有重複的 Citation key，後來加入的已加上 a/b/c 後綴：${[...new Set(duplicates)].join("、")}`);
		if (failed) warnings.push(`${failed} 筆無法轉換（詳見 說明 → 除錯輸出記錄）`);
		return { count: entries.length, relPaths, warnings };
	}

	async function readSettings() {
		let settings = await scope.ZB.main.readSettings();
		if (!settings.vaultPath) throw new Error("請先到 設定 → ZotMax 填入 Obsidian vault 路徑");
		return settings;
	}

	// Exports never overlap: they write the same files
	function enqueue(fn) {
		let p = queue.then(fn);
		queue = p.catch(() => {});
		return p;
	}

	function notify(headline, lines) {
		let pw = new Zotero.ProgressWindow({ closeOnClick: true });
		pw.changeHeadline(headline);
		for (let line of lines) pw.addDescription(line);
		pw.show();
		pw.startCloseTimer(lines.length > 1 ? 15000 : 8000);
	}

	function report(result) {
		return [`已匯出 ${result.count} 筆參考文獻到 ${result.relPaths.join("、")}`, ...result.warnings];
	}

	/** Tools menu: the whole library → `<folder>/references.json`. */
	function exportLibrary() {
		return enqueue(async () => {
			try {
				let settings = await readSettings();
				notify("ZotMax：參考文獻", report(await writeBibliography(null, MAIN_FILE, settings)));
			}
			catch (e) {
				Zotero.logError(e);
				notify("ZotMax：參考文獻匯出失敗", [String(e.message || e)]);
			}
		});
	}

	/** Collection menu: each selected collection (with subcollections) → `references-<name>.json`. */
	function exportCollections(collections) {
		return enqueue(async () => {
			try {
				let settings = await readSettings();
				let lines = [];
				for (let collection of collections) {
					let items = scope.ZB.adapter.itemsInCollection(collection, true);
					lines.push(...report(await writeBibliography(items, collectionFileName(collection.name), settings)));
				}
				notify("ZotMax：參考文獻", lines);
			}
			catch (e) {
				Zotero.logError(e);
				notify("ZotMax：參考文獻匯出失敗", [String(e.message || e)]);
			}
		});
	}

	/**
	 * After a sync run: refresh `references.json` when 「同步時自動更新參考文獻檔」 is on.
	 * Silent; several syncs in a row collapse into one refresh.
	 */
	function afterSync(settings) {
		if (!featureOn("bibliography") || !pref("export.autoUpdate") || !settings || !settings.vaultPath) return Promise.resolve();
		if (refreshQueued) return queue;
		refreshQueued = true;
		return enqueue(async () => {
			refreshQueued = false;
			try {
				let result = await writeBibliography(null, MAIN_FILE, settings);
				if (result.warnings.length) Zotero.debug(`ZotMax: references.json — ${result.warnings.join("; ")}`);
			}
			catch (e) {
				Zotero.logError(e);
			}
		});
	}

	// Feature switches (features.js): checked live; always on when this file runs without them (Node tests)
	function featureOn(id) {
		let f = scope.ZB && scope.ZB.features;
		return !f || f.isEnabled(id);
	}

	function shutdown() {
		keyState = null;
		cslCache.clear();
	}

	return {
		BIBTEX_TRANSLATOR_ID, MAIN_FILE,
		foldKeyPart, firstTitleWord, generateCitekey, suffix, assignCitekeys,
		toExportEntry, buildCSLJSON, rewriteBibTeXKeys, collectionFileName,
		citekeyFor, exportLibrary, exportCollections, afterSync, shutdown,
		whenIdle: () => queue,
	};
});
