const test = require("node:test");
const assert = require("node:assert/strict");
const status = require("../content/status.js");
const core = require("../content/core.js");
const notion = require("../content/notion.js");

const merge = (base, values) => status.mergeStatus({ base, values });

test("mergeStatus: nothing changed keeps the last synced value and writes nothing", () => {
	let r = merge("已讀", { obsidian: "已讀", zotero: "已讀", notion: "已讀" });
	assert.deepEqual(r, { value: "已讀", source: "base", conflict: null, writes: [] });
});

test("mergeStatus: the one side that changed wins and is written to the other two", () => {
	for (let side of ["obsidian", "zotero", "notion"]) {
		let values = { obsidian: "待讀", zotero: "待讀", notion: "待讀" };
		values[side] = "閱讀中";
		let r = merge("待讀", values);
		assert.equal(r.value, "閱讀中", side);
		assert.equal(r.source, side);
		assert.equal(r.conflict, null);
		assert.deepEqual(r.writes, ["obsidian", "zotero", "notion"].filter(s => s !== side));
	}
});

test("mergeStatus: several sides changed to the same value is not a conflict", () => {
	let r = merge("待讀", { obsidian: "已讀", zotero: "待讀", notion: "已讀" });
	assert.equal(r.value, "已讀");
	assert.equal(r.conflict, null);
	assert.deepEqual(r.writes, ["zotero"]);
});

test("mergeStatus: different changes are a conflict decided by Obsidian > Zotero > Notion", () => {
	let r = merge("待讀", { obsidian: "已讀", zotero: "待讀", notion: "閱讀中" });
	assert.equal(r.value, "已讀");
	assert.deepEqual(r.conflict, { values: { obsidian: "已讀", notion: "閱讀中" }, winner: "obsidian" });
	assert.deepEqual(r.writes, ["zotero", "notion"]);
	assert.equal(status.describeConflict(r.conflict), "⚠️ 閱讀狀態衝突：Obsidian「已讀」、Notion「閱讀中」 → 採用 Obsidian「已讀」");

	r = merge("待讀", { obsidian: "待讀", zotero: "已引用", notion: "閱讀中" });
	assert.equal(r.value, "已引用");
	assert.equal(r.conflict.winner, "zotero");
	assert.deepEqual(r.writes, ["obsidian", "notion"]);

	r = merge("待讀", { obsidian: "已讀", zotero: "已引用", notion: "閱讀中" });
	assert.equal(r.value, "已讀");
	assert.deepEqual(Object.keys(r.conflict.values), ["obsidian", "zotero", "notion"]);

	// Auto-sync runs right after a change in Zotero: Zotero first
	r = status.mergeStatus({ base: "待讀", values: { obsidian: "已讀", zotero: "已引用", notion: "待讀" }, priority: status.AUTO_SYNC_PRIORITY });
	assert.equal(r.value, "已引用");
	assert.equal(r.conflict.winner, "zotero");
	assert.deepEqual(r.writes, ["obsidian", "notion"]);
});

test("mergeStatus: no last synced value (items from earlier versions) never overwrites the user's status with 待讀", () => {
	// The note kept the user's status; Zotero has no tag yet and Notion no Status value
	let r = merge("", { obsidian: "已讀", zotero: "", notion: "" });
	assert.equal(r.value, "已讀");
	assert.equal(r.source, "obsidian");
	assert.equal(r.conflict, null);
	assert.deepEqual(r.writes, ["zotero", "notion"]);
	// Same with only Notion knowing a status (e.g. no vault)
	assert.equal(merge(undefined, { zotero: "", notion: "已引用" }).value, "已引用");
	// Nothing anywhere: a new item starts as 待讀
	r = merge("", { obsidian: "", zotero: "", notion: "" });
	assert.deepEqual(r, { value: "待讀", source: "default", conflict: null, writes: ["obsidian", "zotero", "notion"] });
	// Disagreement without a last synced value is a conflict too
	r = merge("", { obsidian: "閱讀中", zotero: "已讀", notion: "" });
	assert.equal(r.value, "閱讀中");
	assert.equal(r.conflict.winner, "obsidian");
});

test("mergeStatus: an empty side takes the result; a side not in this sync is never written", () => {
	let r = merge("已讀", { obsidian: "已讀", zotero: "" });
	assert.equal(r.value, "已讀");
	assert.deepEqual(r.writes, ["zotero"], "notion isn't part of this sync");
	r = merge("已讀", { zotero: "閱讀中" });
	assert.deepEqual(r, { value: "閱讀中", source: "zotero", conflict: null, writes: [] });
	// Whitespace around a value is not a change
	r = merge("已讀", { obsidian: " 已讀 ", zotero: "已讀" });
	assert.equal(r.source, "base");
	assert.deepEqual(r.writes, []);
});

test("mergeStatus: 已刪除 is never taken from a side or given to a live item", () => {
	let r = merge("已讀", { obsidian: "已刪除", zotero: "已讀", notion: "已讀" });
	assert.equal(r.value, "已讀");
	assert.deepEqual(r.writes, ["obsidian"]);
	r = merge("已刪除", { obsidian: "", zotero: "", notion: "已刪除" });
	assert.equal(r.value, "待讀");
	r = merge("已刪除", { obsidian: "已讀", zotero: "" });
	assert.equal(r.value, "已讀");
	assert.equal(status.cleanStatus("已刪除"), "");
	assert.equal(status.cleanStatus(null), "");
});

test("status tags: prefix, emoji and several tags at once", () => {
	assert.equal(status.tagFor("已讀"), "狀態/已讀 ✅");
	assert.equal(status.tagFor("待讀"), "狀態/待讀", "no emoji for unread items");
	assert.equal(status.tagFor("已讀", { emoji: false }), "狀態/已讀");
	assert.equal(status.tagFor("略讀", { prefix: "status/" }), "status/略讀");
	assert.equal(status.tagStatus("狀態/已讀 ✅"), "已讀");
	assert.equal(status.tagStatus("狀態/已讀"), "已讀");
	assert.equal(status.tagStatus("狀態/📖 閱讀中"), "閱讀中");
	assert.equal(status.tagStatus("狀態/"), "");
	assert.equal(status.tagStatus("已讀"), "", "no prefix, not a status tag");
	assert.equal(status.tagStatus("status/已讀", "status/"), "已讀");
	let tags = ["fall prevention", "狀態/已讀 ✅", "zotero-bridge-ai"];
	assert.equal(status.zoteroStatus(tags), "已讀");
	assert.equal(status.zoteroStatus(["fall prevention"]), "");
	// A second status tag (e.g. a colored tag toggled with its number key): the new one counts
	assert.equal(status.zoteroStatus(["狀態/已讀 ✅", "狀態/閱讀中 📖"], {}, "已讀"), "閱讀中");
	assert.equal(status.zoteroStatus(["狀態/待讀", "狀態/已讀 ✅"], {}, "待讀"), "已讀");
	// Neither is the last synced value: the one further along the reading order
	assert.equal(status.zoteroStatus(["狀態/閱讀中 📖", "狀態/已引用 📝"], {}, ""), "已引用");
	assert.equal(status.zoteroNeedsWrite(["狀態/已讀"], "已讀"), false, "a tag without the emoji is kept as is");
	assert.equal(status.zoteroNeedsWrite(["狀態/已讀 ✅", "狀態/閱讀中 📖"], "閱讀中"), true, "two tags become one");
	assert.equal(status.zoteroNeedsWrite([], "待讀"), true);
});

test("setItemStatus leaves exactly one status tag and keeps the others", () => {
	let item = {
		tags: ["fall prevention", "狀態/待讀", "狀態/已讀 ✅"],
		getTags() { return this.tags.map(tag => ({ tag, type: 0 })); },
		removeTag(t) { this.tags = this.tags.filter(x => x !== t); },
		addTag(t) { this.tags.push(t); },
	};
	let cfg = { prefix: "狀態/", emoji: true };
	assert.equal(status.setItemStatus(item, "閱讀中", cfg), true);
	assert.deepEqual(item.tags, ["fall prevention", "狀態/閱讀中 📖"]);
	assert.equal(status.setItemStatus(item, "閱讀中", cfg), false);
	assert.equal(status.setItemStatus(item, "", cfg), false);
});

test("noteStatus and applyToNote only touch the status keys", () => {
	let note = "---\ntitle: \"A\"\nstatus: 已讀\nstatus_synced: \"閱讀中\"\naliases:\n  - x\n---\n\n# A\n\nbody\n";
	assert.deepEqual(status.noteStatus(note), { value: "已讀", base: "閱讀中" });
	assert.deepEqual(status.noteStatus(null), { value: "", base: "" });
	assert.deepEqual(status.noteStatus("# no frontmatter"), { value: "", base: "" });
	let out = status.applyToNote(note, "已讀", true);
	assert.equal(out, note.replace('status_synced: "閱讀中"', 'status_synced: "已讀"'));
	assert.equal(status.applyToNote(out, "已讀", true), out, "no change, same text");
	out = status.applyToNote(note, "已引用", false);
	assert.match(out, /^status: "已引用"$/m);
	assert.match(out, /^status_synced: "閱讀中"$/m, "last synced value kept until every side has the result");
	assert.match(out, /\n---\n\n# A\n\nbody\n$/);
	// Added at the end of the frontmatter when missing
	assert.match(status.applyToNote("---\ntitle: \"A\"\n---\nbody", "待讀", true), /^---\ntitle: "A"\nstatus: "待讀"\nstatus_synced: "待讀"\n---\nbody$/);
	assert.equal(status.applyToNote("no frontmatter", "已讀", true), "no frontmatter");
});

test("a note marked deleted counts with its status from before the deletion", () => {
	let note = "---\nzotero_key: \"library/A\"\nstatus: \"已讀\"\nstatus_synced: \"已讀\"\n---\n\n# A\n\n" + core.MARK_START + "\n" + core.MARK_END + "\n";
	let marked = core.markObsidianNoteDeleted(note, { now: "2026-10-01T00:00:00Z" });
	assert.match(marked, /^status: "已刪除"$/m);
	assert.deepEqual(status.noteStatus(marked), { value: "已讀", base: "已讀" });
	// A note that says 已刪除 without being marked by the plugin: not a status to sync
	assert.equal(merge("已讀", { obsidian: status.noteStatus("---\nstatus: 已刪除\n---\n").value, zotero: "已讀" }).value, "已讀");
});

test("Notion: Status is a select column with the reading statuses and 已刪除", () => {
	let options = notion.PROPERTY_SCHEMA.Status.select.options.map(o => o.name);
	assert.deepEqual(options, [...core.STATUSES, core.DELETED_STATUS]);
	assert.equal(status.notionStatus({ properties: { Status: { id: "x", type: "select", select: { name: "已讀", color: "green" } } } }), "已讀");
	assert.equal(status.notionStatus({ properties: { Status: { type: "select", select: null } } }), "");
	assert.equal(status.notionStatus(null), "");
	let props = notion.buildProperties({ props: { Status: "select" } }, { status: "略讀,快速" });
	assert.deepEqual(props, { Status: { select: { name: "略讀，快速" } } });
	assert.deepEqual(notion.buildProperties({ props: { Status: "status" } }, { status: "已讀" }), {}, "not written into a Notion status-type column");
	assert.equal(status.notionValue(null), "");
	assert.equal(status.notionValue({ values: { zotero: "已讀" }, value: "已讀" }), "", "Notion not in this sync");
	assert.equal(status.notionValue({ values: { notion: "" }, value: "已讀" }), "已讀");
});
