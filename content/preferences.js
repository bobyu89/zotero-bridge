/* global Zotero, window, document, ChromeUtils, Services */
// Runs in the preferences pane scope. Inline handlers in preferences.xhtml run in the
// window scope, so the controller is attached to the window.
(function () {
	const HTML_NS = "http://www.w3.org/1999/xhtml";
	const RULES_PREF = "extensions.zotero-bridge.routing.rules";
	const PROVIDER_PREF = "extensions.zotero-bridge.llm.provider";
	const USAGE_PREFS = ["extensions.zotero-bridge.usage.ledger", "extensions.zotero-bridge.usage.prices"];
	// Password inputs → secrets.js names. These are not bound with preference= (they never touch prefs.js)
	const SECRET_INPUTS = {
		"zb-anthropic-key": "anthropicKey",
		"zb-openai-key": "openaiKey",
		"zb-notion-token": "notionToken",
		"zb-ncbi-key": "ncbiKey",
	};
	const SAVE_DELAY_MS = 600;

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

	// ---------- secrets (login manager via Zotero.ZoteroBridge.secrets) ----------

	let pendingSaves = new Map(); // input id → { timer, save }
	let inflightSaves = new Set();

	function secretStatus(text) {
		try {
			let status = document.getElementById("zb-secrets-status");
			if (status) status.textContent = text;
		}
		catch (e) {
			// The pane may already be closed when a save made on unload finishes
		}
	}

	function saveSecret(input, name) {
		let pending = pendingSaves.get(input.id);
		if (pending) clearTimeout(pending.timer);
		pendingSaves.delete(input.id);
		let p = Zotero.ZoteroBridge.secrets.set(name, input.value)
			.then(() => secretStatus(""))
			.catch((e) => {
				Zotero.logError(e);
				secretStatus(`❌ 無法儲存：${e.message || e}`);
			});
		inflightSaves.add(p);
		p.finally(() => inflightSaves.delete(p));
		return p;
	}

	/** Save anything typed but not yet stored (before testing Notion, or when the pane closes). */
	function flushSecrets() {
		for (let [id, pending] of [...pendingSaves]) {
			clearTimeout(pending.timer);
			pending.save();
			pendingSaves.delete(id);
		}
		return Promise.all([...inflightSaves]);
	}

	async function loadSecrets() {
		let bridge = Zotero.ZoteroBridge;
		if (!bridge || !bridge.secrets) return;
		for (let [id, name] of Object.entries(SECRET_INPUTS)) {
			let input = document.getElementById(id);
			if (!input || input.dataset.zbBound) continue;
			input.dataset.zbBound = "1";
			let edited = false;
			input.addEventListener("input", () => {
				edited = true;
				let pending = pendingSaves.get(id);
				if (pending) clearTimeout(pending.timer);
				let save = () => saveSecret(input, name);
				pendingSaves.set(id, { timer: setTimeout(save, SAVE_DELAY_MS), save });
			});
			input.addEventListener("change", () => saveSecret(input, name));
			try {
				let value = await bridge.secrets.get(name);
				// Don't overwrite what the user started typing while the stored value loaded
				if (!edited) input.value = value;
			}
			catch (e) {
				secretStatus(`❌ ${e.message || e}`);
			}
		}
	}

	// ---------- AI usage ----------

	function renderUsage() {
		let el = document.getElementById("zb-usage");
		let bridge = Zotero.ZoteroBridge;
		if (!el || !bridge) return;
		try {
			el.textContent = bridge.main.usageReport().join("\n");
		}
		catch (e) {
			el.textContent = `❌ ${e.message || e}`;
		}
	}

	let observers = null;

	// PubMed watches: the list is drawn by pubmed-watch.js
	function renderWatches() {
		let bridge = Zotero.ZoteroBridge;
		if (bridge && bridge.pubmedWatch) bridge.pubmedWatch.renderPrefs(document);
	}

	// Medical-literature search sources: IDs and problems with the settings (search-links.js)
	const SEARCH_PREFS = ["order", "disabled", "custom", "proxyPrefix"].map(k => `extensions.zotero-bridge.searchLinks.${k}`);

	function renderSearchSources() {
		let bridge = Zotero.ZoteroBridge;
		let pre = document.getElementById("zb-search-sources");
		if (!pre || !bridge || !bridge.searchLinks) return;
		try {
			pre.textContent = "資料庫 ID｜名稱：\n" + bridge.searchLinks.describeSources(bridge.searchLinks.readConfig()).join("\n");
		}
		catch (e) {
			pre.textContent = `❌ ${e.message || e}`;
		}
	}

	// ---------- 文獻自動分類: live validation of the rule and topic lists (classify.js) ----------

	/** Show what the parser makes of a textarea under it; errors name the line. */
	function validateList(textareaID, statusID, parse, describeOK) {
		let bridge = Zotero.ZoteroBridge;
		let ta = document.getElementById(textareaID);
		let status = document.getElementById(statusID);
		if (!ta || !status || !bridge || !bridge.classify) return;
		let { errors, ok } = parse(bridge.classify, ta.value);
		let lines = errors.length ? bridge.classify.describeErrors(errors) : [describeOK(ok)];
		status.textContent = lines.join("\n");
		status.classList.toggle("is-error", errors.length > 0);
		if (errors.length) ta.setAttribute("aria-invalid", "true");
		else ta.removeAttribute("aria-invalid");
	}

	const CLASSIFY_LISTS = [
		["zb-classify-rules", "zb-classify-rules-status", (C, text) => {
			let r = C.parseRules(text);
			return { errors: r.errors, ok: r.rules.length };
		}, n => (n ? `${n} 條規則，格式都正確。` : "還沒有規則。")],
		["zb-classify-topics", "zb-classify-topics-status", (C, text) => {
			let r = C.parseTopics(text);
			return { errors: r.errors, ok: r.topics.length };
		}, n => (n ? `${n} 個主題。` : "還沒有主題。")],
	];

	function setupClassify() {
		for (let [taID, statusID, parse, describeOK] of CLASSIFY_LISTS) {
			let ta = document.getElementById(taID);
			if (!ta) continue;
			let run = () => {
				try {
					validateList(taID, statusID, parse, describeOK);
				}
				catch (e) {
					// The pane may already be closed
				}
			};
			if (!ta.dataset.zbBound) {
				ta.dataset.zbBound = "1";
				ta.addEventListener("input", run);
			}
			// The bound pref fills the textarea after the pane loads: validate again then
			run();
			setTimeout(run, 0);
		}
	}

	// ---------- 劃線顏色與意義 (core.colorMeanings) ----------

	const COLOR_PREF = "extensions.zotero-bridge.annotations.colorMeanings";
	// Fallback names until Fluent translates zotero-bridge-color-name
	const COLOR_NAMES = { yellow: "黃色", red: "紅色", green: "綠色", blue: "藍色", purple: "紫色", magenta: "洋紅", orange: "橘色", gray: "灰色" };

	function readColorMeanings() {
		let bridge = Zotero.ZoteroBridge;
		return bridge.core.colorMeanings(Zotero.Prefs.get(COLOR_PREF, true) || "");
	}

	function writeColorMeanings(list) {
		Zotero.Prefs.set(COLOR_PREF, JSON.stringify(list.map(m => ({ color: m.color, meaning: m.meaning }))), true);
	}

	/** One row per Zotero colour: swatch, name, its meaning, and buttons to move it up or down. */
	function renderColorMeanings(focusID) {
		let list = document.getElementById("zb-colors");
		let bridge = Zotero.ZoteroBridge;
		if (!list || !bridge || !bridge.core) return;
		list.replaceChildren();
		let meanings = readColorMeanings();
		let defaults = new Map(bridge.core.DEFAULT_COLOR_MEANINGS.map(d => [d.color, d.meaning]));
		let move = (from, to) => {
			let all = readColorMeanings();
			let [m] = all.splice(from, 1);
			all.splice(to, 0, m);
			writeColorMeanings(all);
			renderColorMeanings(`zb-color-${to < from ? "up" : "down"}-${to}`);
		};
		meanings.forEach((m, i) => {
			let row = el("li", { class: "zb-color" });
			let swatch = el("span", { class: "zb-color-swatch", "aria-hidden": "true" });
			// The annotation colour itself (Zotero's data), not a theme colour
			swatch.style.backgroundColor = m.color;
			let nameID = `zb-color-name-${i}`;
			let name = el("span", { class: "zb-color-name", id: nameID });
			setL10n(name, "zotero-bridge-color-name", COLOR_NAMES[m.info.name] || m.info.name, { color: m.info.name });
			let input = el("input", { type: "text", id: `zb-color-${i}`, maxlength: "40", "aria-labelledby": nameID, placeholder: defaults.get(m.color) || "" });
			input.value = m.meaning;
			input.addEventListener("input", () => {
				let all = readColorMeanings();
				all[i].meaning = input.value.trim();
				writeColorMeanings(all);
			});
			let up = el("button", { type: "button", class: "zb-color-move", id: `zb-color-up-${i}`, "aria-describedby": nameID });
			setL10n(up, "zotero-bridge-color-up", "上移");
			up.disabled = i === 0;
			up.addEventListener("click", () => move(i, i - 1));
			let down = el("button", { type: "button", class: "zb-color-move", id: `zb-color-down-${i}`, "aria-describedby": nameID });
			setL10n(down, "zotero-bridge-color-down", "下移");
			down.disabled = i === meanings.length - 1;
			down.addEventListener("click", () => move(i, i + 1));
			row.append(swatch, name, input, up, down);
			list.append(row);
		});
		// Keep keyboard focus on the moved row (a disabled button at the end hands it to the other one)
		let target = focusID && document.getElementById(focusID);
		if (target && target.disabled) target = document.getElementById(focusID.replace(/-(up|down)-/, (all, d) => (d === "up" ? "-down-" : "-up-")));
		if (target) target.focus();
	}

	// ---------- 功能: presets and feature switches (features.js) ----------

	const ZB_PREF = "extensions.zotero-bridge.";
	// The rendered controls: { inputs, rows, reqs: Map feature ID → element, radios: Map preset → input, current, undo }
	let featureUI = null;
	// After choosing a preset: { applied: preset name, before: switch values } until the next manual change
	let undoState = null;
	// While a preset or an undo writes the switches: their observers wait for the last one
	let applying = false;

	function featureAPI() {
		let bridge = Zotero.ZoteroBridge;
		return bridge && bridge.features;
	}

	function setHidden(node, hidden) {
		// An attribute, not the property: XUL and HTML elements both honour it
		if (hidden) node.setAttribute("hidden", "true");
		else node.removeAttribute("hidden");
	}

	/**
	 * A Fluent message (zotero-bridge.ftl) on a leaf element, with the zh-TW text as the fallback until
	 * Fluent translates it. Unchanged id and args leave the element alone, so Fluent's text stays.
	 */
	function setL10n(node, id, fallback, args) {
		let json = args ? JSON.stringify(args) : null;
		if (node.getAttribute("data-l10n-id") === id && node.getAttribute("data-l10n-args") === json) return;
		node.textContent = fallback;
		node.setAttribute("data-l10n-id", id);
		if (json) node.setAttribute("data-l10n-args", json);
		else node.removeAttribute("data-l10n-args");
	}

	function l10nEl(tag, attrs, id, fallback) {
		let node = el(tag, attrs);
		setL10n(node, id, fallback);
		return node;
	}

	/** Sections marked data-zb-feature="<IDs>" show while any of those features is on. */
	function applyDisclosure() {
		let F = featureAPI();
		if (!F) return;
		let root = document.getElementById("zotero-bridge-prefs") || document;
		for (let node of root.querySelectorAll("[data-zb-feature]")) {
			let ids = node.getAttribute("data-zb-feature").split(/\s+/).filter(Boolean);
			setHidden(node, !ids.some((id) => {
				try {
					return F.isEnabled(id);
				}
				catch (e) {
					return true;
				}
			}));
		}
		// Tabs left empty, an open search and the note under a switch follow the sections
		updatePanels();
	}

	const PRESET_STATUS = {
		guided: "目前：研究生引導",
		advanced: "目前：進階",
		custom: "目前：自訂（開關跟兩種模式都不完全一樣）",
	};

	function renderFeatures() {
		let container = document.getElementById("zb-features");
		let F = featureAPI();
		if (!container || !F) return false;
		container.replaceChildren();
		let ui = { inputs: new Map(), rows: new Map(), reqs: new Map(), radios: new Map() };

		let presets = el("div", { class: "zb-presets", role: "radiogroup" });
		setL10n(presets, "zotero-bridge-preset-group", "");
		presets.setAttribute("aria-label", "模式");
		for (let name of ["guided", "advanced"]) {
			let p = F.PRESETS[name];
			let radio = el("input", { type: "radio", name: "zb-preset", value: name, id: `zb-preset-${name}`, "aria-describedby": `zb-preset-${name}-desc` });
			radio.addEventListener("change", () => {
				if (radio.checked) choosePreset(name);
			});
			let text = el("span", { class: "zb-preset-text" });
			text.append(
				l10nEl("span", { class: "zb-preset-name" }, p.l10n, p.label),
				l10nEl("span", { class: "zb-preset-desc", id: `zb-preset-${name}-desc` }, `${p.l10n}-desc`, p.desc),
			);
			let label = el("label", { class: "zb-preset", for: `zb-preset-${name}` });
			label.append(radio, text);
			presets.append(label);
			ui.radios.set(name, radio);
		}
		let status = el("p", { class: "zb-preset-status" });
		// Announced when a preset is applied or the switches turn it into 自訂
		ui.current = el("span", { role: "status" });
		ui.undo = l10nEl("button", { type: "button", class: "zb-undo" }, "zotero-bridge-preset-undo", "復原");
		ui.undo.addEventListener("click", undoPreset);
		status.append(ui.current, ui.undo);
		container.append(presets, status);

		for (let group of F.GROUPS) {
			let section = el("section", { class: "zb-feature-group", "aria-labelledby": `zb-feature-group-${group.id}` });
			section.append(l10nEl("h3", { id: `zb-feature-group-${group.id}` }, group.l10n, group.label));
			for (let f of F.FEATURES.filter(x => x.group === group.id)) {
				let id = `zb-feature-${f.id}`;
				let input = el("input", { type: "checkbox", id, "aria-describedby": `${id}-desc ${id}-req` });
				input.addEventListener("change", () => {
					// A manual change ends the chance to undo the preset
					undoState = null;
					F.setEnabled(f.id, input.checked);
					// The pref observer redraws too; this covers a pane without observers
					updateFeatures();
				});
				let head = el("div", { class: "zb-feature-head" });
				head.append(l10nEl("label", { class: "zb-feature-name", for: id }, f.l10n.name, f.label));
				if (f.usesAI) head.append(l10nEl("span", { class: "zb-tag zb-tag-ai" }, "zotero-bridge-feature-tag-ai", "AI・要付費"));
				if (f.usesNetwork) head.append(l10nEl("span", { class: "zb-tag zb-tag-network" }, "zotero-bridge-feature-tag-network", "連網"));
				let req = el("p", { class: "zb-feature-req", id: `${id}-req` });
				setHidden(req, true);
				let body = el("div", { class: "zb-feature-body" });
				body.append(head, l10nEl("p", { class: "zb-feature-desc", id: `${id}-desc` }, f.l10n.desc, f.desc), req);
				let row = el("div", { class: "zb-feature", "data-feature": f.id });
				row.append(input, body);
				section.append(row);
				ui.inputs.set(f.id, input);
				ui.rows.set(f.id, row);
				ui.reqs.set(f.id, req);
			}
			container.append(section);
		}
		featureUI = ui;
		updateFeatures();
		return true;
	}

	/** Switch states, the preset indicator and the disclosed sections, from the prefs. */
	function updateFeatures() {
		let F = featureAPI();
		if (!F || applying) return;
		if (featureUI) {
			for (let f of F.FEATURES) {
				let input = featureUI.inputs.get(f.id);
				let blockedBy = f.requires.find(r => !F.isEnabled(r));
				input.checked = F.rawValue(f.id);
				input.disabled = !!blockedBy;
				featureUI.rows.get(f.id).classList.toggle("is-blocked", !!blockedBy);
				let req = featureUI.reqs.get(f.id);
				setHidden(req, !blockedBy);
				if (blockedBy) setL10n(req, "zotero-bridge-feature-requires", `要先打開「${F.get(blockedBy).label}」才會生效。`, { req: blockedBy });
			}
			let preset = F.currentPreset();
			for (let [name, radio] of featureUI.radios) radio.checked = name === preset;
			let justApplied = undoState && undoState.applied === preset;
			if (!justApplied) undoState = null;
			if (justApplied) {
				setL10n(featureUI.current, "zotero-bridge-preset-applied", `已切換到「${F.PRESETS[preset].label}」。`, { preset });
			}
			else {
				setL10n(featureUI.current, "zotero-bridge-preset-current", PRESET_STATUS[preset], { preset });
			}
			setHidden(featureUI.undo, !justApplied);
		}
		applyDisclosure();
	}

	function choosePreset(name) {
		let F = featureAPI();
		if (!F) return;
		applying = true;
		try {
			undoState = { applied: name, before: F.applyPreset(name) };
		}
		finally {
			applying = false;
		}
		updateFeatures();
	}

	function undoPreset() {
		let F = featureAPI();
		if (!F || !undoState) return;
		let before = undoState.before;
		undoState = null;
		applying = true;
		try {
			F.restore(before);
		}
		finally {
			applying = false;
		}
		updateFeatures();
		// The undo button is hidden now: keep keyboard focus in the preset group
		let target = featureUI && ([...featureUI.radios.values()].find(r => r.checked) || featureUI.radios.get("guided"));
		if (target) target.focus();
	}

	// ---------- tabs, search and showSection (DESIGN.md → Settings pane structure) ----------

	// The tab chosen last, and a section an opener asks for before (or while) the pane is open
	const LAST_TAB_PREF = "extensions.zotero-bridge.prefs.lastTab";
	const PENDING_PREF = "extensions.zotero-bridge.prefs.pendingSection";
	const FIRST_TAB = "features";
	const FLASH_MS = 2000;
	const HIGHLIGHT = "zb-search";
	// Text the search skips: form values, hidden blocks, the search box and tabs themselves
	const SKIP_VISIBLE = "input, textarea, select, script, style, [hidden], [no-highlight]";
	const SKIP_OFF = "input, textarea, select, script, style, [no-highlight]";

	// { root, tabs: [button], panels: Map tab ID → panel, empties: Map tab ID → empty state, sections,
	//   search, status, off, zSearch: Zotero's own settings search field, timers, hits, flashed }
	let nav = null;
	// While our search is active: { query, opened: <details> we opened to show a match }
	let searchState = null;
	// While Zotero's own settings search (top of the window) has text
	let globalSearch = false;
	// The line under a switch after showSection() on a section whose feature is off
	let notice = null;

	function attr(node, name) {
		return node.getAttribute(name) || "";
	}

	function later(fn, ms = 0) {
		if (!nav) return null;
		let timers = nav.timers;
		let handle = setTimeout(() => {
			timers.delete(handle);
			try {
				fn();
			}
			catch (e) {
				// The pane may already be closed
			}
		}, ms);
		timers.add(handle);
		return handle;
	}

	function cancel(handle) {
		if (!handle) return;
		clearTimeout(handle);
		if (nav) nav.timers.delete(handle);
	}

	function reducedMotion() {
		try {
			return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		}
		catch (e) {
			return true;
		}
	}

	function tabOf(section) {
		let panel = section.closest("[role=tabpanel]");
		return panel ? attr(panel, "data-zb-tab") : "";
	}

	function sectionID(section) {
		return attr(section, "data-zb-section");
	}

	function findSection(id) {
		return nav && nav.sections.find(s => sectionID(s) === id);
	}

	function sectionTitle(section) {
		let h = section.getElementsByTagNameNS(HTML_NS, "h2")[0];
		return (h && h.textContent.trim()) || sectionID(section);
	}

	/** The tab's own text: Fluent's translation once it ran. */
	function tabLabel(id) {
		let tab = nav && nav.tabs.find(t => attr(t, "data-zb-tab") === id);
		return tab ? tab.textContent.trim() : id;
	}

	/** A switch's name as the 功能 tab shows it (translated), else the catalog's. */
	function featureLabel(id) {
		let row = featureUI && featureUI.rows.get(id);
		let name = row && row.querySelector(".zb-feature-name");
		if (name && name.textContent.trim()) return name.textContent.trim();
		try {
			return featureAPI().get(id).label;
		}
		catch (e) {
			return id;
		}
	}

	function listSeparator() {
		return /^(zh|ja)/i.test(String(Zotero.locale || "zh")) ? "、" : ", ";
	}

	function selectTab(id, { focus = false, store = true } = {}) {
		if (!nav) return false;
		let tab = nav.tabs.find(t => attr(t, "data-zb-tab") === id);
		if (!tab) return false;
		for (let t of nav.tabs) {
			let on = t === tab;
			t.setAttribute("aria-selected", on ? "true" : "false");
			t.setAttribute("tabindex", on ? "0" : "-1");
			let panel = nav.panels.get(attr(t, "data-zb-tab"));
			if (panel) panel.classList.toggle("is-selected", on);
		}
		nav.current = id;
		if (store) {
			try {
				Zotero.Prefs.set(LAST_TAB_PREF, id, true);
			}
			catch (e) {}
		}
		if (focus) tab.focus();
		return true;
	}

	/** ARIA tabs: ← → move and select (selection follows focus), Home and End jump to the ends. */
	function onTabKey(event) {
		let i = nav ? nav.tabs.indexOf(event.target) : -1;
		if (i < 0) return;
		let n = nav.tabs.length;
		let to = { ArrowRight: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, Home: 0, End: n - 1 }[event.key];
		if (to === undefined) return;
		event.preventDefault();
		selectTab(attr(nav.tabs[to], "data-zb-tab"), { focus: true });
	}

	/** A tab whose sections are all switched off says so and points to 功能, instead of showing nothing. */
	function updatePanels() {
		if (!nav) return;
		for (let [id, panel] of nav.panels) {
			let box = nav.empties.get(id);
			if (!box) continue;
			let sections = [...panel.querySelectorAll("[data-zb-section]")];
			let empty = sections.length > 0 && sections.every(s => s.hasAttribute("hidden"));
			setHidden(box, !empty);
			if (!empty) continue;
			let ids = [...new Set(sections.flatMap(s => attr(s, "data-zb-feature").split(/\s+/).filter(Boolean)))];
			let features = ids.map(featureLabel).join(listSeparator());
			setL10n(box.firstElementChild, "zotero-bridge-prefs-tab-empty",
				`這一頁的功能都關著：${features}。到「功能」打開其中一個，它的設定就會出現在這裡。`, { features });
		}
		if (searchState) runSearch(searchState.query);
		updateNotice();
	}

	// ----- showSection -----

	function flash(node) {
		if (!nav) return;
		if (nav.flashed && nav.flashed !== node) nav.flashed.classList.remove("zb-flash");
		cancel(nav.flashTimer);
		node.classList.add("zb-flash");
		nav.flashed = node;
		nav.flashTimer = later(() => {
			node.classList.remove("zb-flash");
			if (nav && nav.flashed === node) nav.flashed = null;
		}, FLASH_MS);
	}

	/** Scroll to a section or switch row, highlight it briefly and move keyboard focus there. */
	function reveal(node, focusTarget) {
		if (typeof node.scrollIntoView === "function") {
			node.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
		}
		flash(node);
		if (focusTarget && typeof focusTarget.focus === "function") {
			try {
				focusTarget.focus({ preventScroll: true });
			}
			catch (e) {}
		}
	}

	/** The switch to turn on for a hidden section: the first one that is off, or what it needs first. */
	function switchFor(section) {
		let F = featureAPI();
		let ids = attr(section, "data-zb-feature").split(/\s+/).filter(Boolean);
		if (!F || !ids.length) return ids[0] || null;
		let id = ids.find((i) => {
			try {
				return !F.rawValue(i);
			}
			catch (e) {
				return false;
			}
		}) || ids[0];
		// A switch that needs another one off (AI 主題分類 needs 文獻自動分類): point at that one
		for (let seen = new Set(); !seen.has(id); seen.add(id)) {
			let next = null;
			try {
				next = F.get(id).requires.find(r => !F.isEnabled(r));
			}
			catch (e) {}
			if (!next) break;
			id = next;
		}
		return id;
	}

	function clearNotice() {
		if (!notice) return;
		notice.el.remove();
		if (notice.describedBy === null) notice.input.removeAttribute("aria-describedby");
		else notice.input.setAttribute("aria-describedby", notice.describedBy);
		notice = null;
	}

	function updateNotice() {
		if (!notice) return;
		let open = !notice.section.hasAttribute("hidden");
		let args = { section: sectionTitle(notice.section), tab: tabLabel(tabOf(notice.section)) };
		if (open) {
			setL10n(notice.text, "zotero-bridge-prefs-section-ready", `已打開。「${args.section}」的設定在「${args.tab}」分頁。`, args);
		}
		else {
			setL10n(notice.text, "zotero-bridge-prefs-section-off", `「${args.section}」的設定在「${args.tab}」分頁，打開這個功能後才會出現。`, args);
		}
		setHidden(notice.go, !open);
	}

	/** A section of a switched-off feature: the 功能 tab, that switch highlighted, one line on where the settings go. */
	function showSwitch(section) {
		selectTab(FIRST_TAB);
		let id = switchFor(section);
		let row = id && featureUI && featureUI.rows.get(id);
		let input = id && featureUI && featureUI.inputs.get(id);
		if (!row || !input) {
			let box = findSection(FIRST_TAB);
			if (box) reveal(box);
			return true;
		}
		let p = el("p", { class: "zb-feature-note", id: "zb-section-notice" });
		let text = el("span");
		let go = l10nEl("button", { type: "button", class: "zb-notice-go" }, "zotero-bridge-prefs-section-go", "前往設定");
		let target = sectionID(section);
		go.addEventListener("click", () => showSection(target));
		p.append(text, go);
		row.querySelector(".zb-feature-body").append(p);
		notice = { el: p, text, go, section, input, describedBy: input.getAttribute("aria-describedby") };
		input.setAttribute("aria-describedby", `${notice.describedBy || ""} zb-section-notice`.trim());
		updateNotice();
		reveal(row, input);
		return true;
	}

	/**
	 * Open a section by its data-zb-section ID (or a tab by its ID): its tab, scrolled to and highlighted
	 * for a moment. A section hidden because its feature is off opens the 功能 tab at that switch instead.
	 */
	function showSection(id) {
		if (!nav) return false;
		id = String(id || "");
		let section = findSection(id);
		if (!section && !nav.panels.has(id)) return false;
		if (searchState) endSearch();
		clearNotice();
		if (!section) {
			selectTab(id);
			reveal(nav.panels.get(id), nav.tabs.find(t => attr(t, "data-zb-tab") === id));
			return true;
		}
		if (section.hasAttribute("hidden")) return showSwitch(section);
		selectTab(tabOf(section));
		let heading = section.getElementsByTagNameNS(HTML_NS, "h2")[0];
		if (heading) heading.setAttribute("tabindex", "-1");
		reveal(section, heading);
		return true;
	}

	function paneShown() {
		let parent = nav && nav.root.parentNode;
		return !(parent && typeof parent.closest === "function" && parent.closest("[hidden]"));
	}

	/**
	 * prefs.pendingSection: set by whoever opens the settings window. Zotero loads a pane while its
	 * container is still hidden and resets the scroll position right after showing it, so the
	 * section opens on the next turn after the pane is visible ("showing").
	 */
	function consumePending() {
		if (!nav || !paneShown()) return;
		let id = "";
		try {
			id = String(Zotero.Prefs.get(PENDING_PREF, true) || "");
		}
		catch (e) {}
		if (!id) return;
		try {
			Zotero.Prefs.set(PENDING_PREF, "", true);
		}
		catch (e) {}
		later(() => showSection(id));
	}

	// ----- search -----

	/** Case-, width- (全形／半形) and accent-insensitive text, and where each folded character came from. */
	function fold(text) {
		let out = "";
		let start = [];
		let end = [];
		for (let i = 0; i < text.length;) {
			let ch = String.fromCodePoint(text.codePointAt(i));
			let f = ch.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
			for (let k = 0; k < f.length; k++) {
				start.push(i);
				end.push(i + ch.length);
			}
			out += f;
			i += ch.length;
		}
		return { out, start, end };
	}

	function terms(query) {
		return fold(String(query || "")).out.split(/\s+/).filter(Boolean);
	}

	/** What a section says: its text, the labels XUL keeps in attributes, and its keywords. */
	function searchable(section, skip) {
		let parts = [];
		let walker = document.createTreeWalker(section, 4 /* NodeFilter.SHOW_TEXT */);
		for (let node; (node = walker.nextNode());) {
			let parent = node.parentNode;
			if (!node.nodeValue.trim() || !parent || parent.closest(skip)) continue;
			parts.push({ node, text: node.nodeValue });
		}
		for (let node of section.querySelectorAll("[label], label[value], [data-search-strings-raw]")) {
			if (node.closest(skip)) continue;
			let target = node.localName === "menuitem" ? (node.closest("menulist") || node) : node;
			if (node.localName === "label" && node.hasAttribute("value")) parts.push({ el: target, text: attr(node, "value") });
			if (node.hasAttribute("label") && node.localName !== "label") parts.push({ el: target, text: attr(node, "label") });
			// Zotero's own settings search reads the same keywords (comma-separated, English and Chinese)
			if (node.hasAttribute("data-search-strings-raw")) parts.push({ text: attr(node, "data-search-strings-raw") });
		}
		return parts.map(p => Object.assign(p, { folded: fold(p.text) }));
	}

	function clearHighlights() {
		try {
			if (window.CSS && window.CSS.highlights) window.CSS.highlights.delete(HIGHLIGHT);
		}
		catch (e) {}
		if (!nav) return;
		for (let node of nav.hits) node.classList.remove("zb-hit");
		nav.hits = [];
	}

	/** Matches in text: CSS highlights where Gecko has them, else the element; labels kept in attributes: the element. */
	function paint(ranges, elements) {
		let registry = window.CSS && window.CSS.highlights;
		if (ranges.length && registry && typeof window.Highlight === "function") {
			registry.set(HIGHLIGHT, new window.Highlight(...ranges));
		}
		else {
			for (let r of ranges) elements.add(r.startContainer.parentNode);
		}
		for (let node of elements) {
			if (!node || !node.classList) continue;
			node.classList.add("zb-hit");
			nav.hits.push(node);
		}
	}

	/** A match folded inside <details>: open it for the search, and close it again afterwards. */
	function unfold(node) {
		let details = node && node.closest && node.closest("details");
		if (!details || details.open) return;
		let summary = details.firstElementChild;
		if (summary && summary.localName === "summary" && summary.contains(node)) return;
		details.open = true;
		searchState.opened.add(details);
	}

	function clearL10n(node) {
		node.removeAttribute("data-l10n-id");
		node.removeAttribute("data-l10n-args");
		node.textContent = "";
	}

	/** Filter every tab at once: matching sections show under their tab's name, the rest fold away. */
	function runSearch(query) {
		if (!nav) return;
		let words = terms(query);
		clearHighlights();
		if (!words.length) {
			endSearch({ keepValue: true });
			return;
		}
		if (!searchState) searchState = { opened: new Set() };
		searchState.query = query;
		nav.root.classList.add("zb-searching");
		let shown = [];
		let off = [];
		let ranges = [];
		let elements = new Set();
		for (let section of nav.sections) {
			let isOff = section.hasAttribute("hidden");
			let parts = searchable(section, isOff ? SKIP_OFF : SKIP_VISIBLE);
			let all = parts.map(p => p.folded.out).join("\n");
			let match = words.every(w => all.includes(w));
			section.classList.toggle("zb-search-miss", !match);
			if (!match) continue;
			if (isOff) {
				off.push(section);
				continue;
			}
			shown.push(section);
			for (let p of parts) {
				for (let w of words) {
					for (let at = p.folded.out.indexOf(w); at !== -1; at = p.folded.out.indexOf(w, at + w.length)) {
						if (p.node) {
							let range = document.createRange();
							range.setStart(p.node, p.folded.start[at]);
							range.setEnd(p.node, p.folded.end[at + w.length - 1]);
							ranges.push(range);
							unfold(p.node.parentNode);
						}
						else if (p.el) {
							elements.add(p.el);
							unfold(p.el);
						}
					}
				}
			}
		}
		for (let panel of nav.panels.values()) {
			let any = [...panel.querySelectorAll("[data-zb-section]")].some(s => shown.includes(s));
			panel.classList.toggle("zb-search-miss", !any);
		}
		paint(ranges, elements);

		if (shown.length) {
			setL10n(nav.status, "zotero-bridge-prefs-search-found", `找到 ${shown.length} 個設定區塊。按 Esc 回到分頁。`, { count: shown.length });
		}
		else {
			setL10n(nav.status, "zotero-bridge-prefs-search-none", `沒有符合「${query.trim()}」的設定。換個說法試試，例如英文名稱：Notion、PubMed、API key。`, { query: query.trim() });
		}
		// Sections of switched-off features: named, each a button to its switch
		nav.off.replaceChildren();
		setHidden(nav.off, !off.length);
		if (off.length) {
			nav.off.append(l10nEl("span", {}, "zotero-bridge-prefs-search-off", "關著的功能裡也有："));
			for (let section of off) {
				let button = el("button", { type: "button" }, sectionTitle(section));
				let id = sectionID(section);
				button.addEventListener("click", () => showSection(id));
				nav.off.append(button);
			}
		}
	}

	/** Back to the tabs, as they were before the search. */
	function endSearch({ keepValue = false } = {}) {
		if (!nav) return;
		clearHighlights();
		if (searchState) {
			for (let details of searchState.opened) details.open = false;
		}
		searchState = null;
		nav.root.classList.remove("zb-searching");
		for (let node of [...nav.root.querySelectorAll(".zb-search-miss")]) node.classList.remove("zb-search-miss");
		clearL10n(nav.status);
		nav.off.replaceChildren();
		setHidden(nav.off, true);
		if (!keepValue) nav.search.value = "";
	}

	function onSearchKey(event) {
		if (event.key !== "Escape" || !nav.search.value) return;
		event.preventDefault();
		event.stopPropagation();
		endSearch();
	}

	/**
	 * Zotero's own search at the top of the settings window matches text in every pane, including
	 * ours, but only highlights what is on screen. While it has text, every tab's sections show (and
	 * our search box and tabs step aside); clearing it brings the tabs back.
	 */
	function syncGlobalSearch() {
		if (!nav) return;
		let on = false;
		try {
			on = !!(nav.zSearch && String(nav.zSearch.value || "").trim());
		}
		catch (e) {}
		if (on === globalSearch) return;
		globalSearch = on;
		if (on && searchState) endSearch();
		nav.root.classList.toggle("zb-global-search", on);
	}

	function onShowing() {
		syncGlobalSearch();
		consumePending();
	}

	/** Wire the tablist, the search box and the sections; false for a pane without them. */
	function setupNav() {
		if (nav) return true;
		let root = document.getElementById("zotero-bridge-prefs");
		let tablist = root && root.querySelector("[role=tablist]");
		let search = root && root.querySelector("#zb-search");
		if (!tablist || !search) return false;
		nav = {
			root, search,
			tabs: [...tablist.querySelectorAll("[role=tab]")],
			panels: new Map(),
			empties: new Map(),
			sections: [...root.querySelectorAll("[data-zb-section]")],
			status: root.querySelector("#zb-search-status"),
			off: root.querySelector("#zb-search-off"),
			zSearch: document.getElementById("prefs-search"),
			timers: new Set(),
			hits: [],
			flashed: null,
			flashTimer: null,
			current: null,
		};
		for (let panel of root.querySelectorAll("[role=tabpanel]")) {
			let id = attr(panel, "data-zb-tab");
			nav.panels.set(id, panel);
			// Shown when every section of this tab is switched off
			let box = el("div", { class: "zb-panel-empty", "no-highlight": "true" });
			let go = l10nEl("button", { type: "button" }, "zotero-bridge-prefs-tab-empty-go", "前往「功能」");
			go.addEventListener("click", () => selectTab(FIRST_TAB, { focus: true }));
			box.append(el("p"), go);
			setHidden(box, true);
			let title = panel.querySelector(".zb-panel-title");
			if (title) title.after(box);
			else panel.prepend(box);
			nav.empties.set(id, box);
		}
		for (let tab of nav.tabs) {
			tab.addEventListener("click", () => selectTab(attr(tab, "data-zb-tab"), { focus: true }));
		}
		tablist.addEventListener("keydown", onTabKey);
		search.addEventListener("input", () => runSearch(search.value));
		search.addEventListener("keydown", onSearchKey);
		root.addEventListener("showing", onShowing);
		if (nav.zSearch) {
			nav.zSearch.addEventListener("command", syncGlobalSearch);
			nav.zSearch.addEventListener("input", syncGlobalSearch);
		}
		let last = "";
		try {
			last = String(Zotero.Prefs.get(LAST_TAB_PREF, true) || "");
		}
		catch (e) {}
		selectTab(nav.panels.has(last) ? last : FIRST_TAB, { store: false });
		updatePanels();
		syncGlobalSearch();
		return true;
	}

	/** On unload: Zotero's search field outlives the pane when the plugin is turned off with the window open. */
	function teardownNav() {
		if (!nav) return;
		if (nav.zSearch) {
			nav.zSearch.removeEventListener("command", syncGlobalSearch);
			nav.zSearch.removeEventListener("input", syncGlobalSearch);
		}
		for (let handle of nav.timers) clearTimeout(handle);
		clearHighlights();
		nav = null;
		searchState = null;
		notice = null;
		globalSearch = false;
	}

	window.ZoteroBridgePrefs = {
		init() {
			let hasFeatures = renderFeatures();
			renderRules();
			renderWatches();
			renderSearchSources();
			setupClassify();
			renderColorMeanings();
			updateProviderBoxes();
			renderUsage();
			loadSecrets();
			if (!hasFeatures) applyDisclosure();
			// Tabs and search (after the switches, whose names the empty tabs list)
			let hasNav = setupNav();
			if (!observers) {
				let F = featureAPI();
				observers = [
					Zotero.Prefs.registerObserver(PROVIDER_PREF, updateProviderBoxes, true),
					...USAGE_PREFS.map(p => Zotero.Prefs.registerObserver(p, renderUsage, true)),
					...SEARCH_PREFS.map(p => Zotero.Prefs.registerObserver(p, renderSearchSources, true)),
					// The switches can change elsewhere too (another settings window, a preset): one observer each
					...(hasFeatures && F ? F.prefKeys().map(k => Zotero.Prefs.registerObserver(ZB_PREF + k, updateFeatures, true)) : []),
					// A section asked for while the pane is already open
					...(hasNav ? [Zotero.Prefs.registerObserver(PENDING_PREF, consumePending, true)] : []),
				];
				// Zotero sends "unload" to the pane's root element, then nukes this script's sandbox: a
				// listener on the window would be dead by the time the window's own unload event fires
				// (leaving the pref observers registered and unsaved keys unsaved)
				let root = document.getElementById("zotero-bridge-prefs") || window;
				root.addEventListener("unload", () => {
					flushSecrets();
					observers.forEach(o => Zotero.Prefs.unregisterObserver(o));
					observers = null;
					teardownNav();
				}, { once: true });
			}
			// A section asked for before the pane loaded (opens once the pane is on screen)
			if (hasNav) consumePending();
		},

		/** Open a settings section by its data-zb-section ID (or a tab by its ID); false when there is none. */
		showSection,

		/** Select a tab: features, sync, organize, search, appraise, ai. */
		selectTab(id) {
			return selectTab(String(id || ""), { focus: false });
		},

		/** Filter all tabs as the search box does ("" goes back to the tabs). */
		search(query) {
			if (!nav) return;
			nav.search.value = String(query || "");
			runSearch(nav.search.value);
		},

		/** [{ id, tab, title, visible }] for every section, in pane order. */
		sections() {
			return nav ? nav.sections.map(s => ({ id: sectionID(s), tab: tabOf(s), title: sectionTitle(s), visible: !s.hasAttribute("hidden") })) : [];
		},

		renderUsage,

		resetUsage() {
			let bridge = Zotero.ZoteroBridge;
			if (!bridge) return;
			if (!Services.prompt.confirm(window, "ZotMax", "要清除所有 AI 用量統計嗎？（批次產生前的費用預估也會一併重新累計）")) return;
			bridge.main.resetUsage();
			renderUsage();
		},

		loadDefaultPrices() {
			let bridge = Zotero.ZoteroBridge;
			let ta = document.getElementById("zb-prices");
			if (!bridge || !ta) return;
			ta.value = JSON.stringify(bridge.usage.DEFAULT_PRICES, null, 2);
			ta.dispatchEvent(new Event("input"));
		},

		addWatch() {
			let bridge = Zotero.ZoteroBridge;
			if (!bridge) return;
			bridge.pubmedWatch.addWatch();
			renderWatches();
		},

		async checkWatchesNow() {
			let bridge = Zotero.ZoteroBridge;
			if (!bridge) return;
			await flushSecrets();
			await bridge.pubmedWatch.runAll();
			renderWatches();
		},

		addRule() {
			let rules = readRules();
			rules.push({ name: "", library: "*", collection: "", notionDatabase: "", obsidianFolder: "" });
			writeRules(rules);
			renderRules();
		},

		/** 「開啟設定精靈」 at the top of 功能: the wizard window (setup.js), over the main window. */
		openSetup() {
			let bridge = Zotero.ZoteroBridge;
			if (!bridge || !bridge.setup) return null;
			return bridge.setup.open(Zotero.getMainWindow());
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

		loadDefaultReasons() {
			let bridge = Zotero.ZoteroBridge;
			let ta = document.getElementById("zb-screening-reasons");
			if (!bridge || !ta) return;
			ta.value = bridge.screening.DEFAULT_REASONS.join("\n");
			ta.dispatchEvent(new Event("input"));
		},

		loadDefaultSynthesisPrompt() {
			let bridge = Zotero.ZoteroBridge;
			let ta = document.getElementById("zb-synthesis-prompt");
			if (!bridge || !ta) return;
			ta.value = bridge.synthesis.DEFAULT_SYNTHESIS_PROMPT;
			ta.dispatchEvent(new Event("input"));
		},

		resetColorMeanings() {
			Zotero.Prefs.set(COLOR_PREF, "", true);
			renderColorMeanings();
		},

		async pickMarkitdown() {
			const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
			let fp = new FilePicker();
			fp.init(window, "選擇 markitdown 執行檔", fp.modeOpen);
			if (await fp.show() !== fp.returnOK) return;
			let input = document.getElementById("zb-markitdown-path");
			input.value = fp.file;
			input.dispatchEvent(new Event("input"));
		},

		/** 「把 Notion 欄位改成中文」: main.js lists the renames and asks before changing anything. */
		async renameNotionColumns() {
			let status = document.getElementById("zb-notion-status");
			status.textContent = "讀取 Notion 欄位中…";
			try {
				await flushSecrets();
				let lines = await Zotero.ZoteroBridge.main.renameNotionColumns(window);
				status.textContent = lines.join("\n");
			}
			catch (e) {
				status.textContent = `❌ ${e.message || e}`;
			}
		},

		async testNotion() {
			let status = document.getElementById("zb-notion-status");
			status.textContent = "測試中…";
			try {
				await flushSecrets();
				let lines = await Zotero.ZoteroBridge.main.testNotion();
				status.textContent = lines.join("\n");
			}
			catch (e) {
				status.textContent = `❌ ${e.message || e}`;
			}
		},
	};
})();
