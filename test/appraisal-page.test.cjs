// site/appraisal.html (文獻評讀表): rendering with a stub checklist catalog, answering, summary, Markdown/CSV/Word output,
// Cohen's kappa, saved appraisals (storage round trip + no-storage fallback) and links from the other pages, loaded in jsdom.
// The catalog (content/appraisal-tools.js, window.ZBAppraisalTools) is inlined in place of <script src="appraisal-tools.js">:
// test/fixtures/appraisal-tools.fixture.js always, and the real catalog too when it exists (interface-level checks only).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const SITE = path.join(ROOT, "site");
const HTML = fs.readFileSync(path.join(SITE, "appraisal.html"), "utf8");
const FIXTURE = path.join(__dirname, "fixtures", "appraisal-tools.fixture.js");
// ZB_APPRAISAL_TOOLS=<file> runs the real-catalog test against another implementation of the interface
const REAL = process.env.ZB_APPRAISAL_TOOLS ? path.resolve(process.env.ZB_APPRAISAL_TOOLS) : path.join(ROOT, "content", "appraisal-tools.js");
const TAG = '<script src="appraisal-tools.js"></script>';

function withCatalog(file) {
	assert.ok(HTML.includes(TAG), "page loads appraisal-tools.js from the same folder");
	if (file === null) return HTML.replace(TAG, "");
	const src = fs.readFileSync(file, "utf8");
	assert.ok(!src.includes("</script"), "catalog can be inlined");
	return HTML.replace(TAG, () => "<script>" + src + "</script>");
}

function load({ catalog = FIXTURE, storage = true, confirm = true, seed = null } = {}) {
	const errors = [];
	const vc = new VirtualConsole();
	vc.on("jsdomError", e => errors.push(e.message));
	const dom = new JSDOM(withCatalog(catalog), {
		url: "https://bobyu89.github.io/zotero-bridge/appraisal.html",
		runScripts: "dangerously",
		virtualConsole: vc,
		beforeParse(win) {
			win.confirm = () => confirm;
			if (!storage) Object.defineProperty(win, "localStorage", { get() { throw new Error("SecurityError"); } });
			else if (seed) for (const [k, v] of Object.entries(seed)) win.localStorage.setItem(k, v);
		}
	});
	const win = dom.window;
	const A = win.ZBAppraisal;
	const out = { copied: [], rich: [], downloads: [], printed: 0 };
	if (A) {
		A.copyText = t => { out.copied.push(t); return Promise.resolve(true); };
		A.copyRich = (html, text) => { out.rich.push({ html, text }); return Promise.resolve("html"); };
		A.download = (name, content, type) => { out.downloads.push({ name, content, type }); return true; };
		A.print = () => { out.printed++; };
	}
	return { win, doc: win.document, A, T: win.ZBAppraisalTools, out, errors };
}

const deq = (actual, expected, msg) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, msg);
const input = (win, el, value) => { el.value = value; el.dispatchEvent(new win.Event("input", { bubbles: true })); };
const change = (win, el, value) => { el.value = value; el.dispatchEvent(new win.Event("change", { bubbles: true })); };
const tick = () => new Promise(r => setTimeout(r, 0));
const answer = (doc, item, val, who = "A") => doc.querySelector(`#items button[data-who="${who}"][data-item="${item}"][data-val="${val}"]`).click();
const pressed = (doc, item, who = "A") => [...doc.querySelectorAll(`#items button[data-who="${who}"][data-item="${item}"][aria-pressed="true"]`)].map(b => b.dataset.val);
const stored = win => JSON.parse(win.localStorage.getItem("zb-appraisal-v1"));

test("page loads with the fixture catalog, without script errors", () => {
	const { A, T, doc, errors } = load();
	deq(errors, []);
	assert.ok(T && A);
	for (const fn of ["kappa", "normalizeAppraisals", "mergeAppraisals", "markdownFor", "csvFor", "wordHtml", "trafficGroups"]) assert.equal(typeof A[fn], "function", fn);
	assert.equal(doc.getElementById("noCatalog").hidden, true);
	// a blank paper is ready; design options come from the catalog
	assert.equal(doc.querySelectorAll("#paperList li").length, 1);
	deq([...doc.querySelectorAll("#f-design option")].map(o => o.value), ["", "RCT", "qualitative"]);
	assert.equal(doc.querySelector('#f-design option[value="RCT"]').textContent, "隨機對照試驗（RCT）");
	// first tool's items, with section headings, A buttons for every answer and a 評析根據 box
	assert.equal(doc.getElementById("f-tool").value, "casp-rct-stub");
	assert.equal(doc.querySelectorAll("#items li.item").length, 4);
	deq([...doc.querySelectorAll("#items li.sec")].map(l => l.textContent), ["A. 研究設計是否有效？", "B. 研究方法是否可靠？", "C. 結果是什麼？"]);
	deq([...doc.querySelectorAll('#items li.item[data-item="q1"] button[data-who="A"]')].map(b => b.textContent), ["是", "否", "不清楚", "不適用"]);
	assert.equal(doc.querySelectorAll("#items textarea").length, 4);
	assert.equal(doc.querySelector('label[for="note-q1"]').textContent, "第 1 題評析根據");
	// tool link + license
	assert.equal(doc.getElementById("toolSrc").href, "https://casp-uk.net/casp-tools-checklists/");
	assert.match(doc.getElementById("toolLic").textContent, /CC BY-NC-SA 4\.0/);
	assert.match(doc.getElementById("progLine").textContent, /已答 0／4 題/);
	// verdict choices come from the tool
	deq([...doc.querySelectorAll("#verdict button")].map(b => b.textContent), ["納入", "排除", "需更多資訊"]);
});

test("hint toggle, missing hints, English text", () => {
	const { doc } = load();
	const hb = doc.querySelector('#items button[data-hint="q1"]');
	assert.equal(doc.getElementById("hint-q1").hidden, true);
	hb.click();
	assert.equal(doc.getElementById("hint-q1").hidden, false);
	assert.equal(hb.getAttribute("aria-expanded"), "true");
	hb.click();
	assert.equal(doc.getElementById("hint-q1").hidden, true);
	assert.equal(doc.querySelector('#items button[data-hint="q3"]'), null, "empty hint → no button");
	assert.match(doc.querySelector('#items li.item[data-item="q2"] .en').textContent, /randomised/);
});

test("design picks the recommended tool; tool switch asks before clearing answers", () => {
	const { win, doc, A } = load();
	change(win, doc.getElementById("f-design"), "qualitative");
	assert.equal(doc.getElementById("f-tool").value, "jbi-qual-stub");
	assert.equal(doc.querySelectorAll("#items li.item").length, 3);
	assert.equal(doc.querySelector("#f-tool optgroup").label, "建議：質性研究");
	assert.equal(doc.getElementById("toolSrc").href, "https://jbi.global/critical-appraisal-tools");
	assert.equal(doc.getElementById("toolNote").hidden, true);

	// answered → changing design only suggests
	answer(doc, "j1", "是");
	change(win, doc.getElementById("f-design"), "RCT");
	assert.equal(doc.getElementById("f-tool").value, "jbi-qual-stub");
	assert.equal(doc.getElementById("toolNote").hidden, false);
	assert.match(doc.getElementById("toolNote").textContent, /建議使用：CASP 隨機對照試驗（測試用）/);

	// override via select → confirm → answers cleared
	change(win, doc.getElementById("f-tool"), "casp-rct-stub");
	assert.equal(A.state().current.toolId, "casp-rct-stub");
	deq(A.state().current.answers, {});
	assert.equal(doc.querySelectorAll("#items li.item").length, 4);

	// declined confirm keeps the tool and answers
	const second = load({ confirm: false });
	answer(second.doc, "q1", "否");
	change(second.win, second.doc.getElementById("f-tool"), "jbi-qual-stub");
	assert.equal(second.doc.getElementById("f-tool").value, "casp-rct-stub");
	assert.equal(second.A.state().current.answers.q1.answer, "否");
});

test("answering: toggle, notes, progress, summary and traffic light", () => {
	const { win, doc, A, T } = load();
	input(win, doc.getElementById("f-author"), "Chen et al.");
	input(win, doc.getElementById("f-year"), "2023");
	input(win, doc.getElementById("f-title"), "Exercise | falls");
	answer(doc, "q1", "是");
	answer(doc, "q2", "否");
	answer(doc, "q3", "不清楚");
	deq(pressed(doc, "q1"), ["是"]);
	answer(doc, "q1", "是"); // same button again clears
	deq(pressed(doc, "q1"), []);
	answer(doc, "q1", "是");
	input(win, doc.getElementById("note-q2"), "信封法，\n未說明分派隱匿");
	const cur = A.state().current;
	deq(cur.answers, { q1: { answer: "是", note: "" }, q2: { answer: "否", note: "信封法，\n未說明分派隱匿" }, q3: { answer: "不清楚", note: "" } });

	const s = T.summarize(T.getTool("casp-rct-stub"), cur.answers);
	assert.equal(s.answered, 3);
	assert.match(doc.getElementById("progLine").textContent, /已答 3／4 題/);
	assert.match(doc.getElementById("progLine").textContent, /是 1・否 1・不清楚 1・不適用 0/);
	assert.match(doc.getElementById("progLine").textContent, new RegExp(`「是」比例 ${s.percentYes}%`));
	assert.equal(doc.querySelectorAll("#progBar i").length, 3);

	// note-only item keeps the note when the answer is cleared
	input(win, doc.getElementById("note-q4"), "MD = 1.2");
	answer(doc, "q4", "是"); answer(doc, "q4", "是");
	deq(A.state().current.answers.q4, { answer: "", note: "MD = 1.2" });

	// list entry and traffic light
	assert.equal(doc.querySelector("#paperList li.cur .nm").textContent, "Chen et al.（2023）");
	assert.match(doc.querySelector("#paperList li.cur .sub").textContent, /3\/4 題/);
	deq([...doc.querySelectorAll("#paperList li.cur .mini i")].map(i => i.className), ["yes", "no", "unclear", ""]);
	doc.querySelector('#verdict button[data-verdict="納入"]').click();
	const row = doc.querySelector('#traffic tr.cur');
	deq([...row.querySelectorAll(".dot")].map(d => d.className), ["dot yes", "dot no", "dot unclear", "dot"]);
	deq([...row.querySelectorAll(".dot")].map(d => d.textContent), ["✓", "✗", "?", ""]);
	assert.equal(row.querySelector(".vtag").textContent, "納入");
	assert.equal(doc.querySelector("#traffic h3 span").textContent, "CASP 隨機對照試驗（測試用）");
});

test("traffic-light summary groups papers by tool", () => {
	const { win, doc, A } = load();
	input(win, doc.getElementById("f-author"), "RCT one");
	answer(doc, "q1", "是");
	doc.getElementById("newBtn").click();
	input(win, doc.getElementById("f-author"), "Qual one");
	change(win, doc.getElementById("f-design"), "qualitative");
	answer(doc, "j3", "不適用");
	doc.getElementById("newBtn").click();
	input(win, doc.getElementById("f-author"), "Qual two");
	assert.equal(A.state().current.toolId, "jbi-qual-stub", "new paper starts with the last tool/design");
	const groups = A.trafficGroups(A.state().list);
	deq(groups.map(g => [g.toolId, g.papers.map(p => p.label)]), [["casp-rct-stub", ["RCT one"]], ["jbi-qual-stub", ["Qual two", "Qual one"]]]);
	assert.equal(doc.querySelectorAll("#traffic table").length, 2);
	assert.equal(doc.querySelectorAll('#traffic .tgroup[data-tool="jbi-qual-stub"] tbody tr').length, 2);
	deq([...doc.querySelectorAll('#traffic .tgroup[data-tool="jbi-qual-stub"] th.q')].map(t => t.textContent), ["Q1", "Q2", "Q3"]);
	// clicking a paper in the summary opens it
	doc.querySelector('#traffic .tgroup[data-tool="casp-rct-stub"] button[data-open]').click();
	assert.equal(A.state().current.author, "RCT one");
	assert.equal(doc.getElementById("f-author").value, "RCT one");
	deq(pressed(doc, "q1"), ["是"]);
});

test("Markdown, CSV (UTF-8 BOM), Word HTML and print output", async () => {
	const { win, doc, A, T, out } = load();
	input(win, doc.getElementById("f-author"), "Lin");
	input(win, doc.getElementById("f-year"), "2024");
	input(win, doc.getElementById("f-title"), "Tai chi, falls");
	change(win, doc.getElementById("f-level"), "Level 2");
	input(win, doc.getElementById("f-reviewer"), "王小明");
	answer(doc, "q1", "是");
	answer(doc, "q2", "否");
	input(win, doc.getElementById("note-q2"), 'said "sealed"');
	doc.querySelector('#verdict button[data-verdict="排除"]').click();
	const cur = A.state().current;

	doc.getElementById("copyMdBtn").click();
	await tick();
	const md = out.copied.at(-1);
	assert.ok(md.startsWith("**Lin (2024). Tai chi, falls**\n"), md);
	assert.ok(md.includes(T.toMarkdownTable(T.getTool("casp-rct-stub"), cur.answers, { includeNotes: true })));
	assert.match(md, /評讀工具：CASP 隨機對照試驗（測試用）（CASP RCT \(stub\)）｜證據等級：Level 2/);
	assert.match(md, /整體判定：排除｜評讀者：王小明/);
	doc.getElementById("withNotes").checked = false;
	doc.getElementById("copyMdBtn").click();
	assert.ok(out.copied.at(-1).includes(T.toMarkdownTable(T.getTool("casp-rct-stub"), cur.answers, { includeNotes: false })));
	assert.match(doc.getElementById("toast").textContent, /Markdown/);

	doc.getElementById("csvBtn").click();
	const csv = out.downloads.at(-1);
	assert.match(csv.name, /^appraisal-Lin-2024\.csv$/);
	assert.match(csv.type, /text\/csv;charset=utf-8/);
	assert.equal(csv.content.charCodeAt(0), 0xFEFF);
	const lines = csv.content.slice(1).split("\r\n");
	assert.equal(lines.length, 5);
	assert.ok(lines[0].startsWith("作者,年份,篇名,研究設計,證據等級,評讀工具,題號,段落,評讀項目,評讀結果,評析根據"));
	assert.ok(lines[2].includes('"Tai chi, falls"'));
	assert.ok(lines[2].includes('否,"said ""sealed"""'));
	assert.equal(csv.content, "﻿" + T.toCSV(A.csvRows([cur])));

	// Word: bordered 3-column table, escaped, with section rows; plain-text fallback is tab separated
	doc.getElementById("copyWordBtn").click();
	await tick();
	const w = out.rich.at(-1);
	assert.match(w.html, /<th[^>]*>評讀項目<\/th><th[^>]*>評讀結果<\/th><th[^>]*>評析根據<\/th>/);
	assert.match(w.html, /border:1px solid #000/);
	assert.match(w.html, /said &quot;sealed&quot;/);
	assert.match(w.html, /<td colspan="3"[^>]*><b>A\. 研究設計是否有效？<\/b>/);
	assert.ok(w.text.split("\n").includes("2. 受試者是否隨機分派到各組？\t否\tsaid \"sealed\""));
	assert.match(doc.getElementById("toast").textContent, /Word/);

	// print: current paper only; "print all" adds the traffic-light summary
	doc.getElementById("printBtn").click();
	assert.equal(out.printed, 1);
	assert.equal(doc.querySelectorAll("#printArea section").length, 1);
	assert.match(doc.getElementById("printArea").textContent, /評析根據/);
	doc.getElementById("newBtn").click();
	doc.getElementById("printAllBtn").click();
	assert.equal(out.printed, 2);
	assert.equal(doc.querySelectorAll("#printArea section").length, 3);
	assert.match(doc.querySelector("#printArea h1").textContent, /燈號總覽/);
	assert.match(HTML, /@media print \{[\s\S]*body > \*:not\(#printArea\) \{ display: none !important; \}/);

	doc.getElementById("csvAllBtn").click();
	assert.equal(out.downloads.at(-1).content.slice(1).split("\r\n").length, 1 + 4 + 4);
});

test("copy for Word: ClipboardItem with text/html, falls back to plain text", async () => {
	// the page's own copyRich (load() replaces it with a recorder)
	const dom = new JSDOM(withCatalog(FIXTURE), { url: "https://bobyu89.github.io/zotero-bridge/appraisal.html", runScripts: "dangerously" });
	const win = dom.window;
	const writes = [];
	let fail = false;
	win.ClipboardItem = class { constructor(data) { this.types = Object.keys(data); } };
	Object.defineProperty(win.navigator, "clipboard", { configurable: true, value: {
		write: items => { writes.push(items[0].types); return fail ? Promise.reject(new Error("denied")) : Promise.resolve(); },
		writeText: t => { writes.push(["plain:" + t]); return Promise.resolve(); }
	} });
	assert.equal(await win.ZBAppraisal.copyRich("<b>x</b>", "x"), "html");
	deq(writes.at(-1), ["text/html", "text/plain"]);
	fail = true;
	assert.equal(await win.ZBAppraisal.copyRich("<b>y</b>", "y"), "text");
	deq(writes.at(-1), ["plain:y"]);
	// no Clipboard API at all
	delete win.ClipboardItem;
	Object.defineProperty(win.navigator, "clipboard", { configurable: true, value: undefined });
	assert.equal(await win.ZBAppraisal.copyRich("<b>z</b>", "z"), false);
});

test("Cohen's kappa: formula, edge cases and dual-reviewer UI", () => {
	const { win, doc, A } = load();
	// textbook 2x2 example: 20 yes/yes, 5 yes/no, 10 no/yes, 15 no/no → po .70, pe .50, κ .40
	const pairs = [].concat(Array(20).fill(["是", "是"]), Array(5).fill(["是", "否"]), Array(10).fill(["否", "是"]), Array(15).fill(["否", "否"]));
	const k = A.kappa(pairs);
	assert.equal(k.n, 50); assert.equal(k.agree, 35);
	assert.ok(Math.abs(k.po - 0.7) < 1e-12 && Math.abs(k.pe - 0.5) < 1e-12 && Math.abs(k.kappa - 0.4) < 1e-12);
	// unanswered pairs are ignored; perfect agreement on one category → κ undefined (pe = 1)
	deq(A.kappa([["是", ""], ["", "否"]]), { n: 0, agree: 0, po: null, pe: null, kappa: null });
	assert.equal(A.kappa([["是", "是"], ["是", "是"]]).kappa, null);
	assert.equal(A.kappa([["是", "是"], ["否", "否"]]).kappa, 1);
	assert.ok(A.kappa([["是", "否"], ["否", "是"]]).kappa < 0);
	assert.equal(A.interpretKappa(0.64), "高度一致");
	assert.equal(A.interpretKappa(0.1), "輕微一致");
	assert.equal(A.interpretKappa(-0.2), "比機率還差");

	// UI: B rows appear only in dual mode; disagreements highlighted
	assert.equal(doc.querySelector('#items li.item[data-item="q1"] .ans.b').hidden, true);
	assert.equal(doc.getElementById("kBox").hidden, true);
	const dual = doc.getElementById("f-dual");
	dual.checked = true; dual.dispatchEvent(new win.Event("change"));
	assert.equal(doc.querySelector('#items li.item[data-item="q1"] .ans.b').hidden, false);
	assert.equal(doc.getElementById("dualBox").hidden, false);
	assert.match(doc.getElementById("kBox").textContent, /都作答的題目出現後/);
	// A: 是 是 否 不清楚 / B: 是 否 否 不清楚 → po .75, pe 5/16, κ = .4375/.6875 ≈ 0.64
	[["q1", "是"], ["q2", "是"], ["q3", "否"], ["q4", "不清楚"]].forEach(([i, v]) => answer(doc, i, v, "A"));
	[["q1", "是"], ["q2", "否"], ["q3", "否"], ["q4", "不清楚"]].forEach(([i, v]) => answer(doc, i, v, "B"));
	deq(pressed(doc, "q2", "B"), ["否"]);
	const kb = doc.getElementById("kBox").textContent;
	assert.match(kb, /κ = 0\.64（高度一致）/);
	assert.match(kb, /一致 3 題（75%）；p_o = 0\.750，p_e = 0\.313；1 題不一致/);
	assert.match(kb, /κ = \(p_o − p_e\) ÷ \(1 − p_e\)/);
	deq([...doc.querySelectorAll("#items li.item.disagree")].map(l => l.dataset.item), ["q2"]);
	assert.equal(doc.querySelector('#items li.item[data-item="q2"] .distag').hidden, false);
	deq(A.disagreements(A.state().current), ["q2"]);
	// traffic light: κ column and an outlined dot for the disagreement; pooled κ line
	assert.ok(doc.querySelector('#traffic tr.cur .dot.off'));
	assert.equal(doc.querySelector("#traffic tr.cur td:last-child").textContent, "0.64");
	assert.match(doc.getElementById("pooledKappa").textContent, /1 篇、4 題）：一致率 75%，κ = 0\.64/);
	// CSV carries reviewer B's answers
	input(win, doc.getElementById("f-reviewerB"), "B 君");
	const row = A.csvRows([A.state().current])[2];
	assert.equal(row[12], "否"); assert.equal(row[13], "B 君");
	// turning dual off hides the highlights
	dual.checked = false; dual.dispatchEvent(new win.Event("change"));
	assert.equal(doc.querySelectorAll("#items li.item.disagree").length, 0);
	assert.equal(doc.getElementById("kBox").hidden, true);
});

test("saved appraisals: storage round trip, duplicate, delete, export/import JSON", () => {
	const first = load();
	let { win, doc, A, out } = first;
	input(win, doc.getElementById("f-author"), "Wu");
	input(win, doc.getElementById("f-reviewer"), "王小明");
	answer(doc, "q1", "是");
	input(win, doc.getElementById("note-q1"), "PICO 清楚");
	let list = stored(win);
	assert.equal(list.length, 1);
	assert.equal(list[0].author, "Wu");
	deq(list[0].answers, { q1: { answer: "是", note: "PICO 清楚" } });
	assert.equal(win.localStorage.getItem("zb-appraisal-current"), list[0].id);
	assert.equal(win.localStorage.getItem("zb-appraisal-reviewer"), "王小明");

	// duplicate → new id, "(複本)", answers copied, opened
	doc.querySelector("#paperList button[data-dup]").click();
	list = stored(win);
	assert.equal(list.length, 2);
	assert.notEqual(list[0].id, list[1].id);
	assert.equal(list[1].title, "（複本）");
	deq(list[1].answers, list[0].answers);
	assert.equal(A.state().current.id, list[1].id);

	// a new page in the same origin restores the list and the open paper
	const seed = { "zb-appraisal-v1": JSON.stringify(list), "zb-appraisal-current": list[0].id, "zb-appraisal-reviewer": "王小明" };
	const second = load({ seed });
	({ win, doc, A, out } = second);
	assert.equal(doc.querySelectorAll("#paperList li").length, 2);
	assert.equal(doc.getElementById("f-author").value, "Wu");
	assert.equal(doc.getElementById("note-q1").value, "PICO 清楚");
	deq(pressed(doc, "q1"), ["是"]);
	doc.getElementById("newBtn").click();
	assert.equal(doc.getElementById("f-reviewer").value, "王小明", "reviewer name remembered for new papers");

	// export
	doc.getElementById("exportBtn").click();
	const exp = JSON.parse(out.downloads.at(-1).content);
	assert.equal(exp.app, "zotero-bridge-appraisal");
	assert.equal(exp.appraisals.length, 3);

	// delete the open one
	const before = A.state().current.id;
	doc.querySelector(`#paperList button[data-del="${before}"]`).click();
	assert.equal(stored(win).length, 2);
	assert.ok(!stored(win).some(a => a.id === before));

	// import: merge by id, junk filtered, answers sanitised
	const incoming = { app: "zotero-bridge-appraisal", version: 1, appraisals: [
		{ ...exp.appraisals[1], author: "Wu (updated)" },
		{ id: "imp1", toolId: "jbi-qual-stub", author: "Lee", answers: { j1: { answer: "是", note: "ok" }, j2: { answer: "maybe" }, j3: "x" } },
		{ bogus: true }, { toolId: 3 }
	] };
	assert.equal(A.importText(JSON.stringify(incoming)), 2);
	list = stored(win);
	assert.equal(list.length, 3);
	assert.ok(list.some(a => a.author === "Wu (updated)"));
	deq(list.find(a => a.id === "imp1").answers, { j1: { answer: "是", note: "ok" } });
	assert.equal(A.state().current.id, exp.appraisals[1].id);
	assert.match(doc.getElementById("toast").textContent, /已匯入 2 篇（新增 1 篇）/);
	deq(A.normalizeAppraisals("nope"), []);

	// deleting the last paper leaves a fresh blank one
	const only = load({ seed: { "zb-appraisal-v1": JSON.stringify([list[0]]) } });
	only.doc.querySelector("#paperList button[data-del]").click();
	assert.equal(stored(only.win).length, 1);
	assert.notEqual(stored(only.win)[0].id, list[0].id);

	// importing into an untouched page replaces the blank placeholder
	const fresh = load();
	fresh.A.importText(JSON.stringify(incoming));
	assert.equal(fresh.A.state().list.length, 2);
});

test("unknown tool in saved data: warning, data kept", () => {
	const seed = { "zb-appraisal-v1": JSON.stringify([{ id: "x1", toolId: "gone-tool", author: "Old", answers: { z1: { answer: "是", note: "n" } } }]) };
	const { doc, A, errors } = load({ seed });
	deq(errors, []);
	assert.equal(doc.getElementById("toolNote").hidden, false);
	assert.match(doc.getElementById("toolNote").textContent, /gone-tool/);
	assert.equal(doc.querySelectorAll("#items li.item").length, 0);
	assert.match(doc.querySelector("#traffic h3").textContent, /找不到的工具：gone-tool/);
	assert.equal(A.state().current.answers.z1.note, "n");
});

test("works without localStorage (private mode): warns and keeps appraisals in memory", () => {
	const { win, doc, A, errors } = load({ storage: false });
	deq(errors, []);
	assert.equal(A.store.ok, false);
	assert.equal(doc.getElementById("storeWarn").hidden, false);
	input(win, doc.getElementById("f-author"), "Mem");
	answer(doc, "q1", "否");
	doc.getElementById("newBtn").click();
	assert.equal(doc.querySelectorAll("#paperList li").length, 2);
	doc.querySelector("#paperList li:nth-child(2) button[data-open]").click();
	assert.equal(doc.getElementById("f-author").value, "Mem");
	deq(pressed(doc, "q1"), ["否"]);
});

test("missing catalog: explains instead of failing", () => {
	const { doc, errors } = load({ catalog: null });
	deq(errors, []);
	assert.equal(doc.getElementById("noCatalog").hidden, false);
	assert.equal(doc.getElementById("layout").hidden, true);
});

test("install wizard and search page link to the appraisal page; Pages deploy copies the catalog", () => {
	const index = fs.readFileSync(path.join(SITE, "index.html"), "utf8");
	const search = fs.readFileSync(path.join(SITE, "search.html"), "utf8");
	assert.match(index, /<a [^>]*href="appraisal\.html"[^>]*>📋 文獻評讀表<\/a>/);
	assert.match(search, /<a [^>]*href="appraisal\.html"[^>]*>📋 文獻評讀表/);
	assert.match(HTML, /<a href="search\.html">🔎 醫學文獻快速搜尋<\/a>/);
	assert.match(HTML, /<a href="\.\/">← Zotero Bridge 安裝精靈<\/a>/);
	const wf = fs.readFileSync(path.join(ROOT, ".github", "workflows", "pages.yml"), "utf8");
	assert.match(wf, /- "content\/appraisal-tools\.js"/);
	assert.match(wf, /cp content\/appraisal-tools\.js site\/appraisal-tools\.js[\s\S]*upload-pages-artifact/);
	assert.match(fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8"), /^site\/appraisal-tools\.js$/m);
});

test("real catalog (content/appraisal-tools.js): page works with every tool", { skip: !fs.existsSync(REAL) && "content/appraisal-tools.js not present yet" }, async () => {
	const { win, doc, A, T, out, errors } = load({ catalog: REAL });
	deq(errors, []);
	assert.ok(T, "real catalog sets window.ZBAppraisalTools");
	assert.ok(Array.isArray(T.ANSWERS) && T.ANSWERS.length >= 2);
	assert.ok(Array.isArray(T.TOOLS) && T.TOOLS.length >= 1);
	assert.equal(doc.getElementById("noCatalog").hidden, true);
	const designs = [...doc.querySelectorAll("#f-design option")].map(o => o.value).filter(Boolean);
	assert.ok(designs.length >= 1);
	for (const d of designs) {
		const rec = T.toolsForDesign(d);
		change(win, doc.getElementById("f-design"), d);
		if (rec.length) assert.equal(doc.getElementById("f-tool").value, rec[0].id, d);
	}
	for (const tool of T.TOOLS) {
		assert.equal(typeof tool.id, "string");
		assert.ok(Array.isArray(tool.items) && tool.items.length, tool.id);
		doc.getElementById("newBtn").click();
		change(win, doc.getElementById("f-tool"), tool.id);
		assert.equal(A.state().current.toolId, tool.id);
		assert.equal(doc.querySelectorAll("#items li.item").length, tool.items.length, tool.id);
		if (tool.source) assert.equal(doc.getElementById("toolSrc").href, new win.URL(tool.source).href, tool.id);
		// answer every closed item with the first answer; open items (e.g. CASP "what are the results?")
		// have no answer buttons and don't count in the summary
		const closed = tool.items.filter(it => !it.open);
		for (const it of tool.items.filter(it => it.open)) {
			assert.equal(doc.querySelector(`#items li.item[data-item="${it.id}"] .seg`), null, `${tool.id} open item ${it.id}`);
		}
		for (const it of closed) answer(doc, it.id, T.ANSWERS[0]);
		const s = T.summarize(tool, A.state().current.answers);
		assert.equal(s.answered, closed.length, tool.id);
		assert.equal(s.total, closed.length, tool.id);
		assert.match(doc.getElementById("progLine").textContent, new RegExp(`已答 ${closed.length}／${closed.length} 題`));
		doc.getElementById("copyMdBtn").click();
		await tick();
		assert.ok(out.copied.at(-1).includes(T.toMarkdownTable(tool, A.state().current.answers, { includeNotes: true })), tool.id);
		doc.getElementById("csvBtn").click();
		assert.equal(out.downloads.at(-1).content.charCodeAt(0), 0xFEFF);
		assert.equal(out.downloads.at(-1).content.charCodeAt(1) === 0xFEFF, false, "single BOM");
		deq([...doc.querySelectorAll("#verdict button")].map(b => b.textContent), tool.verdicts && tool.verdicts.length ? [...tool.verdicts] : ["納入", "排除", "需更多資訊"], tool.id);
	}
	assert.equal(doc.querySelectorAll("#traffic table").length, T.TOOLS.length);
});
