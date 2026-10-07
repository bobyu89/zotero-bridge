/* global Zotero, window, document, ChromeUtils */
// Runs in the preferences pane scope. Inline handlers in preferences.xhtml run in the
// window scope, so the controller is attached to the window.
(function () {
	const HTML_NS = "http://www.w3.org/1999/xhtml";
	const RULES_PREF = "extensions.zotero-bridge.routing.rules";
	const PROVIDER_PREF = "extensions.zotero-bridge.llm.provider";

	function el(tag, attrs = {}, text) {
		let e = document.createElementNS(HTML_NS, tag);
		for (let [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
		if (text !== undefined) e.textContent = text;
		return e;
	}

	function readRules() {
		try {
			let rules = JSON.parse(Zotero.Prefs.get(RULES_PREF, true) || "[]");
			return Array.isArray(rules) ? rules : [];
		}
		catch (e) {
			return [];
		}
	}

	function writeRules(rules) {
		Zotero.Prefs.set(RULES_PREF, JSON.stringify(rules), true);
	}

	function libraries() {
		let out = [{ value: "*", label: "全部文獻庫" }];
		for (let lib of Zotero.Libraries.getAll()) {
			if (lib.libraryType === "user") {
				out.push({ value: "user", label: lib.name || "我的文獻庫" });
			}
			else if (lib.libraryType === "group") {
				out.push({ value: String(Zotero.Groups.getGroupIDFromLibraryID(lib.libraryID)), label: `群組：${lib.name}` });
			}
		}
		return out;
	}

	function renderRules() {
		let container = document.getElementById("zb-rules");
		if (!container) return;
		container.replaceChildren();
		let rules = readRules();
		if (!rules.length) {
			container.append(el("p", { class: "zb-empty" }, "尚無規則：所有文獻都會使用預設的 Notion 資料庫與 Obsidian 資料夾。"));
			return;
		}
		let libs = libraries();
		let table = el("table", { class: "zb-rules-table" });
		let head = el("tr");
		for (let h of ["名稱", "文獻庫", "分類路徑", "Notion 資料庫連結", "Obsidian 子資料夾", ""]) head.append(el("th", {}, h));
		table.append(head);
		rules.forEach((rule, index) => {
			let tr = el("tr");
			let save = (field, value) => {
				let all = readRules();
				all[index][field] = value;
				writeRules(all);
			};
			let input = (field, placeholder) => {
				let i = el("input", { type: "text", placeholder });
				i.value = rule[field] || "";
				i.addEventListener("input", () => save(field, i.value.trim()));
				let td = el("td");
				td.append(i);
				return td;
			};
			let select = el("select");
			for (let lib of libs) {
				let o = el("option", { value: lib.value }, lib.label);
				select.append(o);
			}
			select.value = rule.library || "*";
			select.addEventListener("change", () => save("library", select.value));
			let libTd = el("td");
			libTd.append(select);

			let del = el("button", { type: "button" }, "刪除");
			del.addEventListener("click", () => {
				let all = readRules();
				all.splice(index, 1);
				writeRules(all);
				renderRules();
			});
			let delTd = el("td");
			delTd.append(del);

			tr.append(
				input("name", "例如：碩論"),
				libTd,
				input("collection", "例如：碩論/文獻回顧"),
				input("notionDatabase", "https://www.notion.so/..."),
				input("obsidianFolder", "例如：Zotero/碩論"),
				delTd,
			);
			table.append(tr);
		});
		container.append(table);
	}

	function updateProviderBoxes() {
		let openai = Zotero.Prefs.get(PROVIDER_PREF, true) === "openai";
		let a = document.getElementById("zb-anthropic-box");
		let o = document.getElementById("zb-openai-box");
		if (a) a.hidden = openai;
		if (o) o.hidden = !openai;
	}

	let providerObserver = null;

	window.ZoteroBridgePrefs = {
		init() {
			renderRules();
			updateProviderBoxes();
			if (!providerObserver) {
				providerObserver = Zotero.Prefs.registerObserver(PROVIDER_PREF, updateProviderBoxes, true);
				window.addEventListener("unload", () => Zotero.Prefs.unregisterObserver(providerObserver), { once: true });
			}
		},

		addRule() {
			let rules = readRules();
			rules.push({ name: "", library: "*", collection: "", notionDatabase: "", obsidianFolder: "" });
			writeRules(rules);
			renderRules();
		},

		async pickVault() {
			const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
			let fp = new FilePicker();
			fp.init(window, "選擇 Obsidian vault 資料夾", fp.modeGetFolder);
			if (await fp.show() !== fp.returnOK) return;
			let input = document.getElementById("zb-vault-path");
			input.value = fp.file;
			input.dispatchEvent(new Event("input"));
		},

		loadDefaultPrompt() {
			let bridge = Zotero.ZoteroBridge;
			let ta = document.getElementById("zb-system-prompt");
			if (!bridge || !ta) return;
			ta.value = bridge.llm.DEFAULT_SYSTEM_PROMPT;
			ta.dispatchEvent(new Event("input"));
		},

		loadDefaultSynthesisPrompt() {
			let bridge = Zotero.ZoteroBridge;
			let ta = document.getElementById("zb-synthesis-prompt");
			if (!bridge || !ta) return;
			ta.value = bridge.synthesis.DEFAULT_SYNTHESIS_PROMPT;
			ta.dispatchEvent(new Event("input"));
		},

		async testNotion() {
			let status = document.getElementById("zb-notion-status");
			status.textContent = "測試中…";
			try {
				let lines = await Zotero.ZoteroBridge.main.testNotion();
				status.textContent = lines.join("\n");
			}
			catch (e) {
				status.textContent = `❌ ${e.message || e}`;
			}
		},
	};
})();
