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

	window.ZoteroBridgePrefs = {
		init() {
			let hasFeatures = renderFeatures();
			renderRules();
			renderWatches();
			renderSearchSources();
			updateProviderBoxes();
			renderUsage();
			loadSecrets();
			if (!hasFeatures) applyDisclosure();
			if (!observers) {
				let F = featureAPI();
				observers = [
					Zotero.Prefs.registerObserver(PROVIDER_PREF, updateProviderBoxes, true),
					...USAGE_PREFS.map(p => Zotero.Prefs.registerObserver(p, renderUsage, true)),
					...SEARCH_PREFS.map(p => Zotero.Prefs.registerObserver(p, renderSearchSources, true)),
					// The switches can change elsewhere too (another settings window, a preset): one observer each
					...(hasFeatures && F ? F.prefKeys().map(k => Zotero.Prefs.registerObserver(ZB_PREF + k, updateFeatures, true)) : []),
				];
				// Zotero sends "unload" to the pane's root element, then nukes this script's sandbox: a
				// listener on the window would be dead by the time the window's own unload event fires
				// (leaving the pref observers registered and unsaved keys unsaved)
				let root = document.getElementById("zotero-bridge-prefs") || window;
				root.addEventListener("unload", () => {
					flushSecrets();
					observers.forEach(o => Zotero.Prefs.unregisterObserver(o));
					observers = null;
				}, { once: true });
			}
		},

		renderUsage,

		resetUsage() {
			let bridge = Zotero.ZoteroBridge;
			if (!bridge) return;
			if (!Services.prompt.confirm(window, "Zotero Bridge", "要清除所有 AI 用量統計嗎？（批次產生前的費用預估也會一併重新累計）")) return;
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
