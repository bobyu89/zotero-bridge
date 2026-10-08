/*
 * Zotero Bridge — reads Zotero items into plain data objects and stores the AI note.
 * Runs only inside Zotero (uses the Zotero global).
 */
(function (root) {
	const ZB = root.ZB;
	const AI_NOTE_TAG = "zotero-bridge-ai";
	// Earlier versions of the AI note, kept when it is regenerated; never synced or sent to the LLM
	const AI_HISTORY_TAG = "zotero-bridge-ai-history";

	function libraryInfo(libraryID) {
		let lib = Zotero.Libraries.get(libraryID);
		if (lib && lib.libraryType === "group") {
			let groupID = Zotero.Groups.getGroupIDFromLibraryID(libraryID);
			return { path: `groups/${groupID}`, routeID: String(groupID), name: lib.name };
		}
		return { path: "library", routeID: "user", name: (lib && lib.name) || "My Library" };
	}

	/** "library/KEY" or "groups/ID/KEY", as written to Notion and Obsidian; null if the library is gone. */
	function zoteroKeyFor(libraryID, key) {
		if (!key || !Zotero.Libraries.get(libraryID)) return null;
		return `${libraryInfo(libraryID).path}/${key}`;
	}

	function collectionPath(collection) {
		let parts = [];
		let c = collection;
		while (c) {
			parts.unshift(c.name);
			c = c.parentID ? Zotero.Collections.get(c.parentID) : null;
		}
		return parts.join("/");
	}

	/** Map any selection (attachments, notes, annotations) to unique top-level regular items. */
	function toRegularItems(items) {
		let seen = new Map();
		for (let item of items || []) {
			let it = item;
			while (it && !it.isRegularItem() && it.parentItem) it = it.parentItem;
			if (it && it.isRegularItem() && !it.deleted) seen.set(it.id, it);
		}
		return [...seen.values()];
	}

	function safeField(item, field) {
		try {
			return item.getField(field, false, true) || "";
		}
		catch (e) {
			return "";
		}
	}

	function citationKey(item) {
		let key = safeField(item, "citationKey");
		if (key) return key;
		try {
			// Better BibTeX, if installed
			let bbt = Zotero.BetterBibTeX && Zotero.BetterBibTeX.KeyManager.get(item.id);
			if (bbt && bbt.citationKey) return bbt.citationKey;
		}
		catch (e) {}
		return "";
	}

	function apaReference(item) {
		try {
			let style = Zotero.Styles.get("http://www.zotero.org/styles/apa");
			if (!style) return "";
			let engine = style.getCiteProc("en-US", "text");
			return Zotero.Cite.makeFormattedBibliographyOrCitationList(engine, [item], "text").trim();
		}
		catch (e) {
			Zotero.logError(e);
			return "";
		}
	}

	function isAINote(note) {
		return note.getTags().some(t => t.tag === AI_NOTE_TAG);
	}

	function isAIHistoryNote(item) {
		return !!item && item.isNote() && item.getTags().some(t => t.tag === AI_HISTORY_TAG);
	}

	function getAINote(item) {
		for (let note of Zotero.Items.get(item.getNotes())) {
			if (isAINote(note)) return note;
		}
		return null;
	}

	function hasTextLayerType(att) {
		return att.isPDFAttachment() || att.attachmentContentType === "application/epub+zip"
			|| att.attachmentContentType === "text/html";
	}

	/**
	 * Read one attachment's text and what is needed to judge it (scanned.classifyFullText):
	 * { key, title, filename, isPDF, path (false when the file isn't on this computer), text, chars, pages }
	 */
	async function readFullTextSource(att) {
		let isPDF = att.isPDFAttachment();
		let path = false;
		try {
			path = await att.getFilePathAsync();
		}
		catch (e) {}
		let text = "";
		try {
			text = (await att.attachmentText) || "";
		}
		catch (e) {
			Zotero.debug(`Zotero Bridge: could not read full text of ${att.key}: ${e}`);
		}
		let pages = 0;
		if (isPDF) {
			// Page count of an indexed PDF (fulltextItems.totalPages); a scan without any text is never indexed
			try {
				let row = Zotero.Fulltext && await Zotero.Fulltext.getPages(att.id);
				pages = (row && Number(row.total)) || 0;
			}
			catch (e) {}
			if (!pages && path && Zotero.PDFWorker) {
				// Not indexed: extracting just the first page returns the total page count
				try {
					pages = Number((await Zotero.PDFWorker.getFullText(att.id, 1)).totalPages) || 0;
				}
				catch (e) {
					Zotero.debug(`Zotero Bridge: could not count the pages of ${att.key}: ${e}`);
				}
			}
		}
		return {
			key: att.key,
			title: att.getField("title") || "",
			filename: att.attachmentFilename || "",
			isPDF,
			path: path || false,
			hasFile: !!path,
			text,
			chars: ZB.scanned.countChars(text),
			pages,
		};
	}

	/**
	 * @param {Zotero.Item} item regular item
	 * @param {object} opts { fullTextLimit: number|0 (0 = don't read full text),
	 *   checkFullText: classify the full text (data.fullTextStatus) even when it isn't sent }
	 */
	async function extractItemData(item, opts = {}) {
		let lib = libraryInfo(item.libraryID);
		let data = {
			id: item.id,
			key: item.key,
			libraryID: item.libraryID,
			libraryPath: lib.path,
			libraryRouteID: lib.routeID,
			libraryName: lib.name,
			itemType: item.itemType,
			title: safeField(item, "title"),
			shortTitle: safeField(item, "shortTitle"),
			creators: item.getCreatorsJSON(),
			date: safeField(item, "date"),
			year: safeField(item, "year"),
			publication: safeField(item, "publicationTitle"),
			volume: safeField(item, "volume"),
			issue: safeField(item, "issue"),
			pages: safeField(item, "pages"),
			publisher: safeField(item, "publisher"),
			doi: safeField(item, "DOI"),
			url: safeField(item, "url"),
			abstract: safeField(item, "abstractNote"),
			citationKey: citationKey(item),
			tags: item.getTags().map(t => t.tag).filter(t => t !== AI_NOTE_TAG && t !== AI_HISTORY_TAG),
			collections: Zotero.Collections.get(item.getCollections()).map(collectionPath),
			// dateAdded is "YYYY-MM-DD HH:MM:SS" in UTC
			dateAdded: item.dateAdded ? item.dateAdded.replace(" ", "T") + "Z" : "",
			apa: apaReference(item),
			attachments: [],
			notes: [],
			aiNote: null,
			fullText: null,
		};
		if (!data.citationKey && ZB.bibliography) {
			// The key the bibliography export (export.js) uses, shown as the note's `citekey`
			try {
				data.generatedCitekey = await ZB.bibliography.citekeyFor(item);
			}
			catch (e) {
				Zotero.logError(e);
			}
		}

		let fullTexts = [];
		let sources = [];
		for (let att of Zotero.Items.get(item.getAttachments())) {
			if (!att.isFileAttachment()) continue;
			let annotations = att.getAnnotations()
				.slice()
				.sort((a, b) => String(a.annotationSortIndex).localeCompare(String(b.annotationSortIndex)))
				.map(a => ({
					key: a.key,
					type: a.annotationType,
					text: a.annotationText || "",
					comment: a.annotationComment || "",
					color: a.annotationColor || "",
					pageLabel: a.annotationPageLabel || "",
					tags: a.getTags().map(t => t.tag),
				}));
			data.attachments.push({
				key: att.key,
				title: att.getField("title") || att.attachmentFilename || "Attachment",
				contentType: att.attachmentContentType,
				annotations,
			});
			if ((opts.fullTextLimit || opts.checkFullText) && hasTextLayerType(att)) {
				let source = await readFullTextSource(att);
				sources.push(source);
				if (opts.fullTextLimit && source.text) fullTexts.push(source.text);
			}
		}
		if (fullTexts.length) {
			let t = ZB.core.truncate(fullTexts.join("\n\n"), opts.fullTextLimit);
			data.fullText = t.text;
			data.fullTextTruncated = t.truncated;
		}
		if (opts.fullTextLimit || opts.checkFullText) {
			// "ok" | "partial" | "none" | "no_pdf" (scanned.js); fullTextSource is the attachment it describes
			let check = ZB.scanned.classifyFullText(sources);
			data.fullTextStatus = check.status;
			data.fullTextSource = check.source && Object.assign({}, check.source, { text: undefined });
		}

		for (let note of Zotero.Items.get(item.getNotes())) {
			if (isAINote(note)) {
				data.aiNote = { key: note.key, html: note.getNote() };
			}
			else if (isAIHistoryNote(note)) {
				continue;
			}
			else {
				data.notes.push({ key: note.key, title: note.getNoteTitle(), html: note.getNote() });
			}
		}
		return data;
	}

	function localStamp(date) {
		let p = n => String(n).padStart(2, "0");
		return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
	}

	/**
	 * Create or overwrite the AI note under the item. The content being replaced is first kept
	 * as a separate child note ("🤖 AI 文獻筆記（舊版 <date>）", tag AI_HISTORY_TAG).
	 * Returns { note, history } (history is null when there was nothing to keep).
	 */
	async function saveAINote(item, html) {
		let note = getAINote(item);
		let history = null;
		if (!note) {
			note = new Zotero.Item("note");
			note.libraryID = item.libraryID;
			note.parentID = item.id;
			note.addTag(AI_NOTE_TAG);
		}
		else {
			let old = note.getNote();
			if (old && old !== html) {
				// dateModified is "YYYY-MM-DD HH:MM:SS" in UTC: when the old version was last written
				let when = note.dateModified ? new Date(note.dateModified.replace(" ", "T") + "Z") : new Date();
				if (isNaN(when.getTime())) when = new Date();
				history = new Zotero.Item("note");
				history.libraryID = item.libraryID;
				history.parentID = item.id;
				history.addTag(AI_HISTORY_TAG);
				history.setNote(ZB.markdown.retitleNoteHTML(old, `🤖 AI 文獻筆記（舊版 ${localStamp(when)}）`));
				// If the backup can't be saved, the old note is not overwritten either
				await history.saveTx();
			}
		}
		note.setNote(html);
		await note.saveTx();
		return { note, history };
	}

	function itemsInCollection(collection, includeSubcollections) {
		let items = collection.getChildItems(false);
		if (includeSubcollections) {
			for (let child of Zotero.Collections.getByParent(collection.id, true)) {
				items.push(...child.getChildItems(false));
			}
		}
		return toRegularItems(items);
	}

	function listLibraries() {
		return Zotero.Libraries.getAll()
			.filter(lib => lib.libraryType === "user" || lib.libraryType === "group")
			.map(lib => {
				let info = libraryInfo(lib.libraryID);
				return { routeID: info.routeID, name: info.name };
			});
	}

	ZB.adapter = {
		AI_NOTE_TAG, AI_HISTORY_TAG, libraryInfo, zoteroKeyFor, collectionPath, toRegularItems, extractItemData, citationKey,
		saveAINote, getAINote, isAINote, isAIHistoryNote, itemsInCollection, listLibraries,
	};
})(this);
