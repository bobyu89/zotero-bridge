const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const md = require("../content/markdown.js");
const core = require("../content/core.js");
const { sampleItem, AI_MD } = require("./fixtures.cjs");

const parse = html => new JSDOM(html).window.document;

test("parseInline handles styles, links and wikilinks", () => {
	let t = md.parseInline("a **b** *c* `d` [e](https://x.y) [[F|G]] [[H]] snake_case_name");
	assert.deepEqual(t.map(x => x.text), ["a ", "b", " ", "c", " ", "d", " ", "e", " ", "G", " ", "H", " snake_case_name"]);
	assert.equal(t[1].bold, true);
	assert.equal(t[3].italic, true);
	assert.equal(t[5].code, true);
	assert.equal(t[7].link, "https://x.y");
	assert.equal(t[9].wikilink, "F");
});

test("toRichText drops non-web links and chunks long text", () => {
	let rich = md.toRichText("[p. 5](zotero://open-pdf/x) and [doi](https://doi.org/1)");
	assert.equal(rich[0].text.content, "p. 5");
	assert.equal(rich[0].text.link, undefined);
	assert.equal(rich[2].text.link.url, "https://doi.org/1");
	let long = md.toRichText("x".repeat(4500));
	assert.deepEqual(long.map(r => r.text.content.length), [2000, 2000, 500]);
});

test("mdToNotionBlocks converts the managed section to flat blocks", () => {
	let blocks = md.mdToNotionBlocks(core.buildManagedSection(sampleItem(), { aiMarkdown: AI_MD }));
	let types = blocks.map(b => b.type);
	assert.ok(!types.includes(undefined));
	// Obsidian %% comments %% are dropped
	assert.ok(!blocks.some(b => JSON.stringify(b).includes("zotero-bridge:start")));
	assert.equal(blocks[0].type, "quote"); // the [!info] callout
	assert.equal(blocks[0].quote.rich_text[0].text.content, "書目資訊");
	assert.ok(types.includes("heading_2"));
	assert.ok(types.includes("bulleted_list_item"));
	let nested = blocks.find(b => b.type === "bulleted_list_item" && b.bulleted_list_item.rich_text[0].text.content.includes("子項目"));
	assert.match(nested.bulleted_list_item.rich_text[0].text.content, /^\s+◦ 子項目$/);
	for (let b of blocks) {
		assert.equal(b[b.type].children, undefined, "blocks must be flat");
		for (let r of b[b.type].rich_text || []) {
			assert.ok(r.text.content.length <= 2000);
		}
	}
	// Wikilinks become plain text in Notion
	assert.ok(!JSON.stringify(blocks).includes("[["));
});

test("mdToNotionBlocks handles code, dividers, todos and tables", () => {
	let blocks = md.mdToNotionBlocks("```js\nlet a = 1;\n```\n\n---\n\n- [x] done\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n1. one\n2. two\n\n#### deep");
	assert.deepEqual(blocks.map(b => b.type),
		["code", "divider", "to_do", "paragraph", "paragraph", "numbered_list_item", "numbered_list_item", "heading_3"]);
	assert.equal(blocks[2].to_do.checked, true);
	assert.equal(blocks[3].paragraph.rich_text[0].text.content, "a ｜ b");
});

test("mdToHtml → htmlToMd round-trips the AI note", () => {
	let html = md.mdToHtml(AI_MD);
	assert.match(html, /<h2>一句話摘要<\/h2>/);
	assert.match(html, /\[\[Health education\|衛教\]\]/);
	assert.match(html, /<blockquote>/);
	let back = md.htmlToMd(html, parse);
	assert.doesNotMatch(back, /^[ \t]+$/m, "no whitespace-only lines");
	assert.match(back, /^## 一句話摘要$/m);
	assert.match(back, /\[\[Fall prevention\]\]/);
	assert.match(back, /\[\[Health education\|衛教\]\]/);
	assert.match(back, /^- 研究設計：randomized controlled trial$/m);
	assert.match(back, /^> "Falls decreased by 30%" \(p\. 5\)$/m);
	// Stable after one more round
	assert.equal(md.htmlToMd(md.mdToHtml(back), parse), back);
});

test("htmlToMd converts a typical Zotero note", () => {
	let html = `<div data-schema-version="9"><h1>My note</h1><p>Text with <strong>bold</strong>, <em>it</em> and <a href="https://a.b">link</a>.</p><ul><li>one<ul><li>nested</li></ul></li><li>two</li></ul><ol><li>first</li></ol><blockquote><p>quoted</p></blockquote><p><span class="citation" data-citation="x">(Chen, 2024)</span></p></div>`;
	let out = md.htmlToMd(html, parse);
	assert.equal(out, [
		"# My note",
		"",
		"Text with **bold**, *it* and [link](https://a.b).",
		"",
		"- one",
		"  - nested",
		"- two",
		"",
		"1. first",
		"",
		"> quoted",
		"",
		"(Chen, 2024)",
	].join("\n"));
});

test("plainText strips markdown", () => {
	assert.equal(md.plainText("護理師 **衛教** [[Fall prevention]] [[A|B]]"), "護理師 衛教 Fall prevention B");
});
