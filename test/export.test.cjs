const test = require("node:test");
const assert = require("node:assert/strict");
const bib = require("../content/export.js");

const author = (lastName, firstName = "") => ({ lastName, firstName, creatorType: "author" });

test("generateCitekey: first author + year + first meaningful title word", () => {
	assert.equal(bib.generateCitekey({ creators: [author("Chen", "Mei")], year: "2024", title: "Effects of nurse-led education on falls" }), "chen2024effects");
	assert.equal(bib.generateCitekey({ creators: [author("Chen")], year: "2024", title: "The effects of education" }), "chen2024effects", "leading stopwords skipped");
	assert.equal(bib.generateCitekey({ creators: [author("Müller")], date: "March 2019", title: "Über Pflege" }), "muller2019uber", "accents folded, year from date");
	assert.equal(bib.generateCitekey({ creators: [author("van der Berg")], year: "2020", title: "Self-efficacy" }), "vanderberg2020self");
	assert.equal(bib.generateCitekey({ creators: [author("O'Brien")], year: "2021", title: "2019 novel coronavirus" }), "obrien2021novel", "numbers-only words skipped");
	assert.equal(bib.generateCitekey({ creators: [{ name: "World Health Organization", creatorType: "author" }], year: "2020", title: "Nursing report" }),
		"worldhealthorganization2020nursing");
	// Editors stand in when there is no author (same rule as the note filename's author)
	assert.equal(bib.generateCitekey({ creators: [{ lastName: "Lee", creatorType: "editor" }], year: "2018", title: "Handbook" }), "lee2018handbook");
	// Chinese: keep the characters, take the first four of the title
	assert.equal(bib.generateCitekey({ creators: [author("陳", "美玲")], year: "2023", title: "護理人員跌倒預防衛教之成效" }), "陳2023護理人員");
	assert.equal(bib.generateCitekey({ creators: [], year: "2023", title: "Untitled work" }), "2023untitled");
	assert.equal(bib.generateCitekey({ creators: [], year: "2023", title: "", key: "AB12CD34" }), "zoteroab12cd34");
	assert.equal(bib.generateCitekey({ creators: [author("Chen")], title: "Falls" }), "chenfalls", "no year");
});

test("generated keys are valid Pandoc citekeys", () => {
	for (let title of ["Effects", "護理", "Ça va", "A/B testing: (a) review"]) {
		let key = bib.generateCitekey({ creators: [author("D'Angelo")], year: "2022", title });
		assert.match(key, /^[\p{L}\p{N}_][\p{L}\p{N}]*$/u, key);
	}
});

test("suffix sequence", () => {
	assert.deepEqual([0, 1, 2, 26, 27, 28].map(bib.suffix), ["", "a", "b", "z", "aa", "ab"]);
});

test("assignCitekeys: explicit keys win, oldest keeps the bare key, a/b/c for the rest", () => {
	let entries = [
		{ id: 5, explicitKey: "", generatedKey: "chen2024effects", dateAdded: "2024-03-01 00:00:00" },
		{ id: 3, explicitKey: "", generatedKey: "chen2024effects", dateAdded: "2024-01-01 00:00:00" },
		{ id: 9, explicitKey: "", generatedKey: "chen2024effects", dateAdded: "2024-02-01 00:00:00" },
		{ id: 7, explicitKey: "chen2024effects", generatedKey: "x", dateAdded: "2025-01-01 00:00:00" },
		{ id: 8, explicitKey: "Lee2020", generatedKey: "y", dateAdded: "2020-01-01 00:00:00" },
		{ id: 2, explicitKey: "lee2020", generatedKey: "z", dateAdded: "2021-01-01 00:00:00" },
		{ id: 4, explicitKey: "", generatedKey: "wang2019care", dateAdded: "2019-01-01 00:00:00" },
	];
	entries = entries.map(e => Object.assign({ uid: `library/K${e.id}` }, e));
	let { keys, duplicates } = bib.assignCitekeys(entries);
	assert.equal(keys.get(7), "chen2024effects", "explicit key is never renamed for a generated one");
	assert.equal(keys.get(3), "chen2024effectsa");
	assert.equal(keys.get(9), "chen2024effectsb");
	assert.equal(keys.get(5), "chen2024effectsc");
	assert.equal(keys.get(8), "Lee2020");
	assert.equal(keys.get(2), "lee2020a", "collisions are case-insensitive (BibTeX)");
	assert.equal(keys.get(4), "wang2019care");
	assert.deepEqual(duplicates, ["lee2020"]);
	// Input order doesn't matter
	let again = bib.assignCitekeys(entries.slice().reverse()).keys;
	assert.deepEqual([...again.entries()].sort(), [...keys.entries()].sort());
	// A suffixed key that already exists as a real key is skipped
	let tricky = bib.assignCitekeys([
		{ id: 1, explicitKey: "kim2020a", dateAdded: "2" },
		{ id: 2, explicitKey: "", generatedKey: "kim2020", dateAdded: "1" },
		{ id: 3, explicitKey: "", generatedKey: "kim2020", dateAdded: "3" },
	]).keys;
	assert.deepEqual([tricky.get(1), tricky.get(2), tricky.get(3)], ["kim2020a", "kim2020", "kim2020b"]);
});

test("assignCitekeys: keys handed out before stay with their item (store)", () => {
	let A = { id: 1, uid: "library/A", explicitKey: "", generatedKey: "lee2021effects", dateAdded: "2021" };
	let B = { id: 2, uid: "library/B", explicitKey: "", generatedKey: "lee2021effects", dateAdded: "2022" };
	let first = bib.assignCitekeys([A, B]);
	assert.deepEqual(first.store, { keys: { "library/A": "lee2021effects", "library/B": "lee2021effectsa" }, retired: [] });

	// A is deleted: B must not become the bare key (a thesis citing [@lee2021effects] meant A)
	let C = { id: 3, uid: "library/C", explicitKey: "", generatedKey: "lee2021effects", dateAdded: "2023" };
	let second = bib.assignCitekeys([B, C], first.store);
	assert.equal(second.keys.get(2), "lee2021effectsa");
	assert.equal(second.keys.get(3), "lee2021effectsb", "a deleted item's key is not reused");
	assert.equal(second.store.keys["library/A"], "lee2021effects", "kept in case A comes back from the trash");

	// A restored from the trash gets its key back
	let third = bib.assignCitekeys([A, B, C], second.store);
	assert.deepEqual([1, 2, 3].map(id => third.keys.get(id)), ["lee2021effects", "lee2021effectsa", "lee2021effectsb"]);

	// B retitled → new key; its old key is retired and never handed to another item
	let B2 = Object.assign({}, B, { generatedKey: "lee2021sleep" });
	let D = { id: 4, uid: "library/D", explicitKey: "", generatedKey: "lee2021effects", dateAdded: "2024" };
	let fourth = bib.assignCitekeys([A, B2, C, D], third.store);
	assert.equal(fourth.keys.get(2), "lee2021sleep");
	assert.equal(fourth.keys.get(4), "lee2021effectsc");
	assert.deepEqual(fourth.store.retired, ["lee2021effectsa"]);

	// C gets a Zotero Citation Key: explicit wins, its generated key retires
	let C2 = Object.assign({}, C, { explicitKey: "leeSleep" });
	let fifth = bib.assignCitekeys([A, B2, C2, D], fourth.store);
	assert.equal(fifth.keys.get(3), "leeSleep");
	assert.equal(fifth.keys.get(4), "lee2021effectsc");
	assert.deepEqual(fifth.store.retired, ["lee2021effectsa", "lee2021effectsb"]);
	assert.equal(fifth.store.keys["library/C"], undefined);

	// A user-set key that collides with a stored generated key wins; the generated one moves on
	let E = { id: 5, uid: "library/E", explicitKey: "lee2021effects", generatedKey: "x", dateAdded: "2025" };
	let sixth = bib.assignCitekeys([A, E], fifth.store);
	assert.equal(sixth.keys.get(5), "lee2021effects");
	assert.notEqual(sixth.keys.get(1), "lee2021effects");
	assert.ok(sixth.store.retired.includes("lee2021effects"));
});

test("toExportEntry: id is the citekey; article URLs dropped like Zotero's citation processor", () => {
	let csl = { id: "http://zotero.org/users/1/items/AAA", type: "article-journal", title: "T", page: "1-10", URL: "https://x", accessed: { "date-parts": [[2024]] }, DOI: "10.1/x" };
	let entry = bib.toExportEntry(csl, "chen2024effects");
	assert.equal(Object.keys(entry)[0], "id");
	assert.equal(entry.id, "chen2024effects");
	assert.equal(entry["citation-key"], "chen2024effects");
	assert.equal(entry.URL, undefined);
	assert.equal(entry.accessed, undefined);
	assert.equal(entry.DOI, "10.1/x");
	assert.equal(csl.id, "http://zotero.org/users/1/items/AAA", "input not mutated");
	assert.equal(bib.toExportEntry(csl, "k", { keepArticleURL: true }).URL, "https://x");
	assert.equal(bib.toExportEntry({ type: "webpage", URL: "https://w", page: "3" }, "k").URL, "https://w");
	assert.equal(bib.toExportEntry({ type: "article-journal", URL: "https://w" }, "k").URL, "https://w", "no pages: keep URL");
});

test("buildCSLJSON: sorted by id, valid JSON array, trailing newline", () => {
	let text = bib.buildCSLJSON([{ id: "wang2019", type: "book" }, { id: "chen2024", type: "book" }]);
	assert.ok(text.endsWith("\n"));
	let parsed = JSON.parse(text);
	assert.deepEqual(parsed.map(e => e.id), ["chen2024", "wang2019"]);
	assert.equal(bib.buildCSLJSON([]), "[]\n");
});

test("rewriteBibTeXKeys replaces translator keys in order and refuses on a count mismatch", () => {
	let input = "\n@article{chen_effects_2024,\n\ttitle = {Effects},\n}\n\n@book{who_nursing_2020,\n\ttitle = {Nursing},\n}\n";
	let out = bib.rewriteBibTeXKeys(input, ["chen2024effects", "who2020nursing"]);
	assert.match(out, /^@article\{chen2024effects,$/m);
	assert.match(out, /^@book\{who2020nursing,$/m);
	assert.match(out, /title = \{Effects\}/);
	assert.throws(() => bib.rewriteBibTeXKeys(input, ["only-one"]), /筆數不符/);
});

test("collection file name is filesystem-safe", () => {
	assert.equal(bib.collectionFileName("碩論/文獻回顧"), "references-碩論 文獻回顧");
});
