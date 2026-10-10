// site/index.html 安裝精靈: steps per choice, the hand-off to the in-Zotero 首次設定精靈, copy buttons,
// and progress storage (v2 key, v1 migration, blocked storage), loaded in jsdom.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM, VirtualConsole } = require("jsdom");

const HTML = fs.readFileSync(path.join(__dirname, "..", "site", "index.html"), "utf8");
const V1 = "zotero-bridge-wizard-v1", V2 = "zotero-bridge-wizard-v2";

function load({ storage = true, seed = {} } = {}) {
	const errors = [];
	const vc = new VirtualConsole();
	vc.on("jsdomError", e => errors.push(e.message));
	const dom = new JSDOM(HTML, {
		url: "https://bobyu89.github.io/zotero-bridge/",
		runScripts: "dangerously",
		virtualConsole: vc,
		beforeParse(win) {
			if (!storage) Object.defineProperty(win, "localStorage", { get() { throw new Error("SecurityError"); } });
			else for (const [k, v] of Object.entries(seed)) win.localStorage.setItem(k, v);
		}
	});
	const win = dom.window, doc = win.document;
	const ids = () => [...doc.querySelectorAll(".step")].filter(s => !s.hidden).map(s => s.dataset.id);
	const railTitles = () => [...doc.querySelectorAll("#railList button .t")].map(t => t.textContent);
	const pick = (name, value) => { const r = doc.querySelector(`input[name=${name}][value=${value}]`); r.checked = true; r.dispatchEvent(new win.Event("change", { bubbles: true })); };
	return { win, doc, errors, ids, railTitles, pick };
}

test("wizard loads without script errors and starts at 選擇你的環境", () => {
	const { errors, ids, win } = load();
	assert.deepEqual(errors, []);
	assert.deepEqual(ids(), ["choose"]);
	assert.equal(JSON.parse(win.localStorage.getItem(V2)).v, 2);
});

test("steps follow the chosen note tool and AI provider", () => {
	const { railTitles, pick } = load();
	assert.deepEqual(railTitles(), ["選擇你的環境", "下載 ZotMax", "準備 Obsidian vault", "準備 Notion", "申請 API 金鑰", "裝進 Zotero", "首次設定精靈", "開始使用"]);
	pick("dest", "obsidian");
	assert.deepEqual(railTitles(), ["選擇你的環境", "下載 ZotMax", "準備 Obsidian vault", "申請 API 金鑰", "裝進 Zotero", "首次設定精靈", "開始使用"]);
	pick("dest", "notion"); pick("ai", "none");
	assert.deepEqual(railTitles(), ["選擇你的環境", "下載 ZotMax", "準備 Notion", "裝進 Zotero", "首次設定精靈", "開始使用"]);
});

test("install step hands off to the in-Zotero 首次設定精靈; the manual setup stays as a fallback", () => {
	const { doc } = load();
	const install = doc.querySelector('.step[data-id="install"]');
	assert.match(install.textContent, /裝好後 Zotero 會自動打開 ZotMax 的首次設定精靈，接下來在那裡選模式、指定筆記位置、試同步一篇/);
	assert.match(install.textContent, /Install Plugin From File…/);
	assert.match(install.textContent, /拖進這個視窗/);
	const setup = doc.querySelector('.step[data-id="setup"]');
	assert.equal(setup.querySelector("details#manual > summary").textContent, "精靈沒有出現？手動設定");
	assert.match(setup.textContent, /設定精靈…/);
	assert.match(setup.textContent, /測試連線並補齊資料庫欄位/);
	const done = doc.querySelector('.step[data-id="done"]');
	for (const word of ["橋形圖示", "快速指令", "評讀陪練", "讀懂統計"]) assert.match(done.textContent, new RegExp(word));
});

test("every URL the user needs has a copy button; the .xpi comes from the latest release", () => {
	const { doc } = load();
	const copies = [...doc.querySelectorAll("[data-copy]")].map(b => b.dataset.copy);
	for (const url of ["https://github.com/bobyu89/zotero-bridge/releases/latest", "https://obsidian.md/download", "https://www.notion.so/profile/integrations", "https://console.anthropic.com", "https://platform.openai.com/api-keys"]) assert.ok(copies.includes(url), url);
	for (const b of doc.querySelectorAll("[data-copy]")) assert.match(b.getAttribute("aria-label"), /^複製/);
	assert.equal(doc.querySelector('.step[data-id="download"] a.btn.act').getAttribute("href"), "https://github.com/bobyu89/zotero-bridge/releases/latest");
});

test("checks are native checkboxes inside a fieldset with a legend", () => {
	const { doc } = load();
	for (const c of doc.querySelectorAll(".step input[type=checkbox]")) {
		assert.ok(c.id, "checkbox has an id");
		assert.ok(c.closest("label"), c.id);
		assert.equal(c.closest("fieldset.check").querySelector("legend").textContent, "打勾確認", c.id);
	}
});

test("progress persists under the v2 key", () => {
	const first = load();
	first.pick("dest", "obsidian");
	const box = first.doc.getElementById("k-zotero");
	box.checked = true; box.dispatchEvent(new first.win.Event("change", { bubbles: true }));
	first.doc.getElementById("nextBtn").click();
	const saved = first.win.localStorage.getItem(V2);
	assert.deepEqual(JSON.parse(saved), { v: 2, step: "download", os: JSON.parse(saved).os, dest: "obsidian", ai: "anthropic", checks: { "k-zotero": true } });
	const again = load({ seed: { [V2]: saved } });
	assert.deepEqual(again.ids(), ["download"]);
	assert.equal(again.doc.getElementById("k-zotero").checked, true);
	assert.match(again.doc.getElementById("heroCta").textContent, /繼續安裝：第 2 步 下載 ZotMax/);
});

test("v1 progress: keeps the three choices, drops old steps and checks, removes the v1 key", () => {
	const { win, doc, ids, errors } = load({ seed: { [V1]: JSON.stringify({ step: 5, os: "mac", dest: "notion", ai: "none", checks: { c1a: true } }) } });
	assert.deepEqual(errors, []);
	assert.deepEqual(ids(), ["choose"]);
	assert.equal(doc.getElementById("app").dataset.dest, "notion");
	assert.equal(doc.getElementById("app").dataset.os, "mac");
	assert.equal(doc.getElementById("app").dataset.ai, "none");
	assert.equal(doc.getElementById("migNote").hidden, false);
	assert.equal(win.localStorage.getItem(V1), null);
	assert.deepEqual(JSON.parse(win.localStorage.getItem(V2)).checks, {});
});

test("broken or blocked storage does not break the wizard", () => {
	const bad = load({ seed: { [V2]: "{not json", [V1]: "nope" } });
	assert.deepEqual(bad.errors, []);
	assert.deepEqual(bad.ids(), ["choose"]);
	const odd = load({ seed: { [V2]: JSON.stringify({ v: 2, step: "gone", dest: "dropbox", ai: 3, checks: { "k-xpi": "yes" } }) } });
	assert.deepEqual(odd.ids(), ["choose"]);
	assert.equal(odd.doc.getElementById("app").dataset.dest, "both");
	const blocked = load({ storage: false });
	assert.deepEqual(blocked.errors, []);
	assert.equal(blocked.doc.getElementById("noStore").hidden, false);
	blocked.doc.getElementById("nextBtn").click();
	assert.deepEqual(blocked.ids(), ["download"]);
});
