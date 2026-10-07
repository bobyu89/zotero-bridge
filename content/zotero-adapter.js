/*
 * Zotero Bridge — reads Zotero items into plain data objects and stores the AI note.
 * Runs only inside Zotero (uses the Zotero global).
 */
(function (root) {
	const ZB = root.ZB;
	const AI_NOTE_TAG = "zotero-bridge-ai";

	function libraryInfo(libraryID) {
		let lib = Zotero.Libraries.get(libraryID);
		if (lib && lib.libraryType === "group") {
			let groupID = Zotero.Groups.getGroupIDFromLibraryID(libraryID);
			return { path: `groups/${groupID}`, routeID: String(groupID), name: lib.name };
		}
		return { path: "library", routeID: "user", name: (lib && lib.name) || "My Library" };
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

	function getAINote(item) {
		for (let note of Zotero.Items.get(item.getNotes())) {
			if (isAINote(note)) return note;
		}
		return null;
	}

	/**
	 * @param {Zotero.Item} item regular item
	 * @param {object} opts { fullTextLimit: number|0 (0 = don't read full text) }
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
			tags: item.getTags().map(t => t.tag).filter(t => t !== AI_NOTE_TAG),
			collections: Zotero.Collections.get(item.getCollections()).map(collectionPath),
			// dateAdded is "YYYY-MM-DD HH:MM:SS" in UTC
			dateAdded: item.dateAdded ? item.dateAdded.replace(" ", "T") + "Z" : "",
			apa: apaReference(item),
			attachments: [],
			notes: [],
			aiNote: null,
			fullText: null,
		};

		let fullTexts = [];
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
			if (opts.fullTextLimit && (att.isPDFAttachment() || att.attachmentContentType === "application/epub+zip"
					|| att.attachmentContentType === "text/html")) {
				try {
					let text = await att.attachmentText;
					if (text) fullTexts.push(text);
				}
				catch (e) {
					Zotero.debug(`Zotero Bridge: could not read full text of ${att.key}: ${e}`);
				}
			}
		}
		if (fullTexts.length) {
			let t = ZB.core.truncate(fullTexts.join("\n\n"), opts.fullTextLimit);
			data.fullText = t.text;
			data.fullTextTruncated = t.truncated;
		}

		for (let note of Zotero.Items.get(item.getNotes())) {
			if (isAINote(note)) {
				data.aiNote = { key: note.key, html: note.getNote() };
			}
			else {
				data.notes.push({ key: note.key, title: note.getNoteTitle(), html: note.getNote() });
			}
		}
		return data;
	}

	/** Create or overwrite the AI note under the item. */
	async function saveAINote(item, html) {
		let note = getAINote(item);
		if (!note) {
			note = new Zotero.Item("note");
			note.libraryID = item.libraryID;
			note.parentID = item.id;
			note.addTag(AI_NOTE_TAG);
		}
		note.setNote(html);
		await note.saveTx();
		return note;
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
		AI_NOTE_TAG, libraryInfo, collectionPath, toRegularItems, extractItemData,
		saveAINote, getAINote, isAINote, itemsInCollection, listLibraries,
	};
})(this);
