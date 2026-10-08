// Feature switches and presets (content/features.js): the catalog, presets, 自訂 detection, the
// one-time migration, menu gating, and that prefs.js and both FTL files agree with the catalog.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const F = require("../content/features.js");

// A prefs store like Zotero.Prefs for keys under extensions.zotero-bridge. (undefined = no value)
function store(values = {}) {
	let data = Object.assign({}, values);
	let s = {
		data,
		writes: [],
		get: key => data[key],
		set: (key, value) => {
			data[key] = value;
			s.writes.push(key);
		},
	};
	F.setStore(s);
	return s;
}

test.afterEach(() => F.setStore(null));

test("catalog: unique IDs, known groups and requirements, both presets on every feature", () => {
	let ids = F.FEATURES.map(f => f.id);
	assert.equal(new Set(ids).size, ids.length);
	assert.equal(new Set(F.FEATURES.map(f => f.pref)).size, ids.length, "one pref per feature");
	let groups = F.GROUPS.map(g => g.id);
	for (let f of F.FEATURES) {
		assert.ok(groups.includes(f.group), `${f.id}: group ${f.group}`);
		assert.equal(typeof f.presets.guided, "boolean", f.id);
		assert.equal(typeof f.presets.advanced, "boolean", f.id);
		assert.ok(f.label && f.desc, f.id);
		for (let r of f.requires) assert.ok(ids.includes(r), `${f.id} requires unknown ${r}`);
		assert.match(f.l10n.name, /^zotero-bridge-feature-[a-z0-9-]+$/);
		assert.equal(f.l10n.desc, f.l10n.name + "-desc");
	}
	assert.ok(F.GROUPS.every(g => F.FEATURES.some(f => f.group === g.id)), "no empty group");
});

test("presets: 研究生引導 leaves finding literature and writing to the user; 進階 turns everything on", () => {
	let offInGuided = F.FEATURES.filter(f => !f.presets.guided).map(f => f.id).sort();
	assert.deepEqual(offInGuided, ["aiBatch", "aiHighlights", "citationChase", "classifyAI", "conceptsAI", "ebhcReport", "progressReport", "pubmedWatch", "reviewDraft", "synthesis"]);
	assert.ok(F.FEATURES.every(f => f.presets.advanced), "advanced: all on");
	// The features that help the user do it themselves stay on
	for (let id of ["sync", "aiNotes", "status", "apaZh", "dashboard", "concepts", "autoClassify", "toolbarButton", "bibliography", "screening", "searchLinks", "appraisalForm", "annotationImages", "fullTextMarkdown"]) {
		assert.equal(F.get(id).presets.guided, true, id);
	}
	// Every AI feature is marked, and so is every feature that goes online on its own
	for (let id of ["aiNotes", "aiBatch", "synthesis", "reviewDraft", "ebhcReport", "progressReport", "conceptsAI", "classifyAI", "aiHighlights"]) {
		assert.equal(F.get(id).usesAI, true, id);
		assert.equal(F.get(id).usesNetwork, true, id);
	}
	for (let id of ["pubmedWatch", "citationChase", "searchLinks", "sync"]) assert.equal(F.get(id).usesNetwork, true, id);
	assert.equal(F.get("dashboard").usesAI, undefined);
	assert.equal(F.get("concepts").usesAI, undefined, "concept cards without AI");
	// 文獻自動分類 itself calls no AI and goes nowhere; its AI topic dimension is a switch of its own
	assert.equal(F.get("autoClassify").usesAI, undefined);
	assert.equal(F.get("autoClassify").usesNetwork, undefined);
	assert.equal(F.get("autoClassify").group, "organize");
	assert.equal(F.get("classifyAI").group, "ai");
	assert.deepEqual(F.get("classifyAI").requires, ["autoClassify", "aiNotes"]);
	// The toolbar button: plain UI, in 整理與同步, on in both presets
	assert.equal(F.get("toolbarButton").group, "organize");
	assert.equal(F.get("toolbarButton").usesAI, undefined);
	assert.equal(F.get("toolbarButton").usesNetwork, undefined);
	assert.deepEqual(F.get("toolbarButton").requires, []);
	assert.equal(F.get("fullTextMarkdown").usesAI, undefined, "the full-text note needs no AI");
	assert.deepEqual(F.get("fullTextMarkdown").requires, ["sync"]);
	assert.deepEqual(F.get("aiHighlights").requires, ["aiNotes"], "AI key sentences come with the AI note");
});

test("reused enable prefs stay the single source of truth", () => {
	let reused = Object.fromEntries(F.FEATURES.filter(f => f.reused).map(f => [f.id, f.pref]));
	assert.deepEqual(reused, {
		status: "status.enabled", apaZh: "apaZh.enabled", annotationImages: "images.export", aiNotes: "llm.enabled", aiBatch: "llm.batchAPI",
	});
	for (let f of F.FEATURES.filter(x => !x.reused)) assert.equal(f.pref, `feature.${f.id}`);
});

test("prefs.js defaults are the 研究生引導 values, and the migration marker starts at 0", () => {
	let text = fs.readFileSync(path.join(ROOT, "prefs.js"), "utf8");
	let defaults = {};
	for (let m of text.matchAll(/^pref\("extensions\.zotero-bridge\.([^"]+)",\s*(.+)\);$/gm)) defaults[m[1]] = JSON.parse(m[2]);
	for (let f of F.FEATURES) assert.equal(defaults[f.pref], f.presets.guided, `${f.pref} default`);
	assert.equal(defaults[F.MIGRATION_PREF], 0);
});

test("isEnabled: unset prefs fall back to guided; requirements switch dependants off", () => {
	store();
	assert.equal(F.isEnabled("sync"), true);
	assert.equal(F.isEnabled("synthesis"), false);
	assert.equal(F.isEnabled("aiNotes"), true);
	let s = store({ "llm.batchAPI": true });
	assert.equal(F.isEnabled("aiBatch"), true);
	s.set("feature.sync", false);
	assert.equal(F.rawValue("aiNotes"), true, "its own switch is still on");
	assert.equal(F.isEnabled("aiNotes"), false, "but AI notes need the sync");
	assert.equal(F.isEnabled("aiBatch"), false, "and the batch API needs AI notes");
	s.set("feature.conceptsAI", true);
	s.set("feature.concepts", false);
	assert.equal(F.isEnabled("conceptsAI"), false);
	// AI 主題分類 needs both 文獻自動分類 and AI 文獻筆記 (and so the sync)
	s = store({ "feature.classifyAI": true });
	assert.equal(F.isEnabled("classifyAI"), true);
	s.set("feature.autoClassify", false);
	assert.equal(F.isEnabled("classifyAI"), false);
	s.set("feature.autoClassify", true);
	s.set("llm.enabled", false);
	assert.equal(F.isEnabled("classifyAI"), false);
	// Non-boolean junk counts as unset
	store({ "feature.synthesis": "yes" });
	assert.equal(F.isEnabled("synthesis"), false);
	assert.throws(() => F.isEnabled("nope"), /Unknown feature/);
});

test("applyPreset, currentPreset (自訂 when mixed) and restore for undo", () => {
	let s = store();
	assert.equal(F.currentPreset(), "guided", "a fresh profile");
	let before = F.applyPreset("advanced");
	assert.equal(F.currentPreset(), "advanced");
	assert.ok(F.FEATURES.every(f => F.isEnabled(f.id)));
	assert.equal(s.data["llm.batchAPI"], true, "reused prefs are written too");
	assert.equal(before.synthesis, false);
	F.setEnabled("synthesis", false);
	assert.equal(F.currentPreset(), "custom");
	F.restore(before);
	assert.equal(F.currentPreset(), "guided");
	// Applying only writes what changes
	s.writes.length = 0;
	F.applyPreset("guided");
	assert.deepEqual(s.writes, []);
	assert.equal(F.presetOf(Object.fromEntries(F.FEATURES.map(f => [f.id, f.presets.advanced]))), "advanced");
	assert.throws(() => F.applyPreset("custom"), /Unknown preset/);
});

test("migrate: a fresh profile stays guided; earlier use turns the new switches on once, reused prefs keep the user's values", () => {
	// Fresh install
	let s = store();
	assert.deepEqual(F.migrate(), { preset: "guided", evidence: [], steps: [1, 2], added: F.FEATURES.filter(f => f.since === 2).map(f => f.id), newSwitches: false });
	assert.equal(s.data[F.MIGRATION_PREF], F.MIGRATION_VERSION);
	assert.equal(F.currentPreset(), "guided");
	assert.equal(F.migrate(), null, "runs once");

	// An install from before the switches: a vault and AI usage, the batch API never turned on
	s = store({ "obsidian.vaultPath": "/vault", "usage.ledger": '{"2026-09":{}}', "llm.enabled": false });
	let result = F.migrate();
	assert.equal(result.preset, "advanced");
	assert.deepEqual(result.evidence, ["obsidian.vaultPath", "usage.ledger"]);
	for (let f of F.FEATURES.filter(x => !x.reused)) assert.equal(s.data[f.pref], true, f.pref);
	assert.equal(s.data["llm.enabled"], false, "the user's own choice is kept");
	assert.equal(s.data["llm.batchAPI"], true, "the batch API, never set by the user, is turned on");
	assert.equal(F.isEnabled("synthesis"), true);
	assert.equal(F.isEnabled("pubmedWatch"), true);
	assert.equal(F.currentPreset(), "custom", "AI notes stay off as the user set them");

	// Same install with every pref at its default: lands on a clean 進階
	s = store({ "obsidian.vaultPath": "/vault" });
	assert.equal(F.migrate().preset, "advanced");
	assert.equal(F.currentPreset(), "advanced");

	// The user turned the batch API off themselves: kept off
	s = store({ "obsidian.vaultPath": "/vault", "llm.batchAPI": false });
	s.hasUserValue = key => key in s.data;
	F.migrate();
	assert.equal(s.data["llm.batchAPI"], false, "an explicit choice is kept");
	assert.equal(F.currentPreset(), "custom");

	// Later: the user picks 研究生引導; a restart must not undo it
	F.applyPreset("guided");
	assert.equal(F.migrate(), null);
	assert.equal(F.currentPreset(), "guided");

	// Other evidence; empty defaults are not evidence
	for (let [key, value] of [["notion.database", "https://notion.so/x"], ["routing.rules", '[{"name":"a"}]'],
		["pubmedWatch.watches", '[{"query":"falls"}]'], ["batch.pending", "{}"], ["batch.ai", '{"batches":[]}']]) {
		store({ [key]: value });
		assert.equal(F.migrate().preset, "advanced", key);
	}
	store({ "obsidian.vaultPath": " ", "usage.ledger": "{}", "routing.rules": "[]", "pubmedWatch.watches": "[]", "batch.pending": "" });
	assert.equal(F.migrate().preset, "guided");
});

test("migrate to version 2: profiles already on 進階 get the new switches on, others keep the defaults", () => {
	assert.equal(F.MIGRATION_VERSION, 2);
	// One version-2 step for every switch v0.10.0 adds
	let added = F.FEATURES.filter(f => f.since === 2).map(f => f.id).sort();
	assert.deepEqual(added, ["aiHighlights", "autoClassify", "classifyAI", "fullTextMarkdown", "toolbarButton"]);
	assert.ok(F.FEATURES.filter(f => !added.includes(f.id)).every(f => f.since === 1));
	let v1Advanced = () => {
		let values = { "features.version": 1, "obsidian.vaultPath": "/vault" };
		for (let f of F.FEATURES.filter(x => x.since === 1)) values[f.pref] = f.presets.advanced;
		return values;
	};

	// On 進階 since version 1: lands on a clean 進階 again
	let s = store(v1Advanced());
	assert.equal(F.currentPreset(), "custom", "AI 主題分類 is still at its default before the migration");
	let result = F.migrate();
	assert.equal(result.preset, "advanced");
	assert.deepEqual(result.added.sort(), ["aiHighlights", "autoClassify", "classifyAI", "fullTextMarkdown", "toolbarButton"]);
	assert.equal(s.data["feature.classifyAI"], true);
	assert.equal(s.data["feature.autoClassify"], true);
	assert.equal(s.data["feature.toolbarButton"], true, "written, so a later default change can't hide it");
	assert.equal(s.data[F.MIGRATION_PREF], 2);
	assert.equal(F.currentPreset(), "advanced");
	assert.equal(F.migrate(), null, "runs once");

	// 研究生引導 since version 1: the defaults (AI 主題分類 off), nothing written but the marker
	s = store({ "features.version": 1, "obsidian.vaultPath": "/vault" });
	s.writes.length = 0;
	result = F.migrate();
	assert.equal(result.preset, "guided");
	assert.deepEqual(s.writes, [F.MIGRATION_PREF]);
	assert.equal(F.isEnabled("classifyAI"), false);
	assert.equal(F.isEnabled("autoClassify"), true);
	assert.equal(F.isEnabled("toolbarButton"), true, "the toolbar button is on by default");
	assert.equal(F.currentPreset(), "guided", "the new switches at their defaults keep 研究生引導");

	// 自訂 (one earlier switch away from 進階): defaults, still 自訂
	let custom = v1Advanced();
	custom["feature.synthesis"] = false;
	s = store(custom);
	result = F.migrate();
	assert.equal(result.preset, "custom");
	assert.equal(s.data["feature.classifyAI"], undefined);
	assert.equal(F.isEnabled("classifyAI"), false);
	assert.equal(s.data["feature.toolbarButton"], undefined);
	assert.equal(F.isEnabled("toolbarButton"), true);

	// A switch the user already set by hand is kept
	let preset = Object.assign(v1Advanced(), { "feature.classifyAI": false, "feature.toolbarButton": false });
	s = store(preset);
	s.hasUserValue = key => key in s.data;
	F.migrate();
	assert.equal(s.data["feature.classifyAI"], false);
	assert.equal(s.data["feature.toolbarButton"], false, "a hidden toolbar button stays hidden");

	// A profile from before the switches (version 0) follows the earlier evidence logic for all switches
	s = store({ "obsidian.vaultPath": "/vault" });
	assert.equal(F.migrate().preset, "advanced");
	assert.equal(s.data["feature.classifyAI"], true);
	assert.equal(s.data["feature.toolbarButton"], true);
	assert.equal(F.currentPreset(), "advanced");
	s = store();
	assert.equal(F.migrate().preset, "guided");
	assert.equal(F.isEnabled("classifyAI"), false);
	assert.equal(F.isEnabled("toolbarButton"), true);
	assert.equal(s.data[F.MIGRATION_PREF], 2);
});

test("migrate step 2: a 進階 profile gets 全文筆記 and AI 標重點 at their advanced values; others keep the guided defaults", () => {
	assert.equal(F.MIGRATION_VERSION, 2);
	assert.deepEqual(F.MIGRATIONS.map(m => m.version), [1, 2], "one entry per step, in order");
	let newOnes = F.FEATURES.filter(f => f.since === 2).map(f => f.id);
	assert.deepEqual(newOnes.sort(), ["aiHighlights", "autoClassify", "classifyAI", "fullTextMarkdown", "toolbarButton"]);
	let advancedBefore = Object.fromEntries(F.FEATURES.filter(f => f.since === 1).map(f => [f.pref, f.presets.advanced]));

	// Migrated to 進階 by version 1 (everything from then on), AI 標重點 still at its default
	let s = store(Object.assign({ [F.MIGRATION_PREF]: 1 }, advancedBefore));
	let result = F.migrate();
	assert.deepEqual(result.steps, [2], "only the new step runs");
	assert.equal(result.newSwitches, true);
	assert.equal(s.data["feature.aiHighlights"], true);
	assert.equal(F.isEnabled("fullTextMarkdown"), true);
	assert.equal(result.preset, "advanced");
	assert.equal(F.currentPreset(), "advanced", "still 進階 with the new switches");
	assert.equal(s.data[F.MIGRATION_PREF], 2);
	assert.equal(F.migrate(), null, "runs once");

	// A 研究生引導 profile at version 1: the new switches keep their guided values
	s = store({ [F.MIGRATION_PREF]: 1 });
	result = F.migrate();
	assert.equal(result.newSwitches, false);
	assert.equal(s.data["feature.aiHighlights"], undefined, "nothing written");
	assert.equal(F.currentPreset(), "guided");

	// A custom profile (one switch off) is left alone
	s = store(Object.assign({ [F.MIGRATION_PREF]: 1 }, advancedBefore, { "feature.synthesis": false }));
	assert.equal(F.migrate().newSwitches, false);
	assert.equal(F.isEnabled("aiHighlights"), false);

	// 進階, but the user already turned AI 標重點 off themselves: kept off
	s = store(Object.assign({ [F.MIGRATION_PREF]: 1 }, advancedBefore, { "feature.aiHighlights": false }));
	s.hasUserValue = key => key in s.data;
	assert.equal(F.migrate().newSwitches, true);
	assert.equal(s.data["feature.aiHighlights"], false);
});

test("gateMenus: hidden while off, the entry's own onShowing decides while on, registration unchanged", () => {
	store();
	let own = [];
	let menus = [
		{ menuType: "menuitem", l10nID: "a", onCommand: () => {} },
		{ menuType: "menuitem", l10nID: "b", onShowing: (ev, ctx) => { own.push("b"); ctx.setVisible(ctx.flag); } },
	];
	let gated = F.gateMenus("synthesis", menus);
	assert.equal(gated.length, 2);
	assert.equal(gated[0].l10nID, "a");
	assert.equal(gated[0].onCommand, menus[0].onCommand);
	assert.equal(menus[0].onShowing, undefined, "the input is not changed");
	let show = (menu, flag) => {
		let visible;
		menu.onShowing({}, { flag, setVisible: v => { visible = v; } });
		return visible;
	};
	assert.equal(show(gated[0]), false);
	assert.equal(show(gated[1], true), false);
	assert.deepEqual(own, [], "the own hook does not run while the feature is off");
	F.setEnabled("synthesis", true);
	assert.equal(show(gated[0]), true, "made visible again (MenuManager reuses the element)");
	assert.equal(show(gated[1], false), false);
	assert.equal(show(gated[1], true), true);
	// Any of several features
	let either = F.gateMenus(["pubmedWatch", "citationChase"], [{ menuType: "menuitem", l10nID: "c" }]);
	assert.equal(show(either[0]), false);
	F.setEnabled("citationChase", true);
	assert.equal(show(either[0]), true);
	assert.throws(() => F.gateMenus("nope", []), /Unknown feature/);
});

// ---------- l10n: both FTL files, the catalog and the settings pane agree ----------

function ftlMessages(locale) {
	let text = fs.readFileSync(path.join(ROOT, "locale", locale, "zotero-bridge.ftl"), "utf8");
	let messages = new Map();
	let current = null;
	for (let line of text.split("\n")) {
		let m = /^([a-z][a-z0-9-]*)\s*=\s*(.*)$/.exec(line);
		if (m) {
			current = m[1];
			messages.set(current, m[2]);
		}
		else if (current && /^\s+\S/.test(line)) {
			messages.set(current, (messages.get(current) + "\n" + line).trim());
		}
	}
	return messages;
}

test("both FTL files define the same messages", () => {
	let zh = ftlMessages("zh-TW");
	let en = ftlMessages("en-US");
	assert.deepEqual([...zh.keys()].sort(), [...en.keys()].sort());
	for (let [id, text] of [...zh, ...en]) assert.ok(text.trim(), `${id} is empty`);
});

test("every l10n ID used by the feature catalog and the settings pane exists, and zh-TW matches the fallback text", () => {
	let zh = ftlMessages("zh-TW");
	let en = ftlMessages("en-US");
	let ids = new Set();
	for (let f of F.FEATURES) {
		ids.add(f.l10n.name);
		ids.add(f.l10n.desc);
		assert.equal(zh.get(f.l10n.name), f.label, f.l10n.name);
		assert.equal(zh.get(f.l10n.desc), f.desc, f.l10n.desc);
	}
	for (let g of F.GROUPS) {
		ids.add(g.l10n);
		assert.equal(zh.get(g.l10n), g.label);
	}
	for (let p of Object.values(F.PRESETS)) {
		assert.equal(zh.get(p.l10n), p.label);
		assert.equal(zh.get(p.l10n + "-desc"), p.desc);
	}
	let pane = fs.readFileSync(path.join(ROOT, "content", "preferences.js"), "utf8")
		+ fs.readFileSync(path.join(ROOT, "content", "preferences.xhtml"), "utf8");
	for (let m of pane.matchAll(/"(zotero-bridge-[a-z0-9-]+)"/g)) ids.add(m[1]);
	for (let m of pane.matchAll(/data-l10n-id="([^"]+)"/g)) ids.add(m[1]);
	// Built from the catalog in preferences.js
	ids.add("zotero-bridge-preset-guided-desc");
	ids.add("zotero-bridge-preset-advanced-desc");
	ids.delete("zotero-bridge-prefs");
	for (let id of ids) {
		assert.ok(zh.has(id), `zh-TW lacks ${id}`);
		assert.ok(en.has(id), `en-US lacks ${id}`);
	}
	// Selector messages cover every value the pane passes
	for (let preset of ["guided", "advanced", "custom"]) assert.match(zh.get("zotero-bridge-preset-current"), new RegExp(`\\[${preset}\\]`));
	for (let id of new Set(F.FEATURES.flatMap(f => f.requires))) {
		assert.match(zh.get("zotero-bridge-feature-requires"), new RegExp(`\\[${id}\\] 要先打開「${F.get(id).label}」`));
		assert.match(en.get("zotero-bridge-feature-requires"), new RegExp(`\\[${id}\\]`));
	}
});
