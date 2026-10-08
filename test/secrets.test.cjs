const test = require("node:test");
const assert = require("node:assert/strict");
const secrets = require("../content/secrets.js");

// Mimics Services.logins: lookups return copies, and modify/remove match by identity fields, like Gecko
function loginManager(initial = []) {
	let store = initial.map(l => Object.assign({}, l));
	let key = l => [l.origin, l.httpRealm, l.username].join("\u0000");
	let ops = [];
	return {
		store,
		ops,
		async searchLoginsAsync(match) {
			ops.push("search");
			return store.filter(l => Object.entries(match).every(([k, v]) => l[k] === v)).map(l => Object.assign({}, l));
		},
		async addLoginAsync(login) {
			ops.push("add");
			if (store.some(l => key(l) === key(login))) throw new Error("This login already exists.");
			store.push(Object.assign({}, login));
		},
		async modifyLoginAsync(old, login) {
			ops.push("modify");
			let i = store.findIndex(l => key(l) === key(old) && l.password === old.password);
			if (i < 0) throw new Error("No matching logins");
			store[i] = Object.assign({}, login);
		},
		async removeLoginAsync(old) {
			ops.push("remove");
			let i = store.findIndex(l => key(l) === key(old) && l.password === old.password);
			if (i < 0) throw new Error("No matching logins");
			store.splice(i, 1);
		},
	};
}

function makeBackend({ prefs = {}, logins = [], keyStore = null } = {}) {
	let prefStore = Object.assign({}, prefs);
	let errors = [];
	let lm = loginManager(logins);
	let backend = {
		logins: lm,
		newLogin: (origin, httpRealm, username, password) => ({ origin, formActionOrigin: null, httpRealm, username, password }),
		keyStore,
		prefs: { get: k => prefStore[k], clear: (k) => { delete prefStore[k]; } },
		log: e => errors.push(e),
	};
	return { backend, prefStore, lm, errors };
}

const login = (username, password) => ({ origin: "chrome://zotero-bridge", formActionOrigin: null, httpRealm: "Zotero Bridge", username, password });

test("migrateFromPrefs copies plain prefs into the login manager, then clears them", async () => {
	let { backend, prefStore, lm } = makeBackend({
		prefs: {
			"extensions.zotero-bridge.llm.anthropicKey": " sk-ant-1 ",
			"extensions.zotero-bridge.llm.openaiKey": "",
			"extensions.zotero-bridge.notion.token": "ntn_1",
			"extensions.zotero-bridge.notion.database": "keep me",
		},
	});
	let store = secrets.createStore(backend);
	let migrated = await store.migrateFromPrefs();
	assert.deepEqual(migrated.sort(), ["anthropicKey", "notionToken"]);
	assert.deepEqual(prefStore, { "extensions.zotero-bridge.notion.database": "keep me" }, "secret prefs cleared, even empty ones");
	assert.deepEqual(lm.store.map(l => [l.origin, l.httpRealm, l.username, l.password]).sort(), [
		["chrome://zotero-bridge", "Zotero Bridge", "anthropicKey", "sk-ant-1"],
		["chrome://zotero-bridge", "Zotero Bridge", "notionToken", "ntn_1"],
	]);
	assert.equal(await store.get("anthropicKey"), "sk-ant-1");
	assert.equal(await store.get("openaiKey"), "");
	// Running again is a no-op
	assert.deepEqual(await store.migrateFromPrefs(), []);
	assert.equal(lm.store.length, 2);
});

test("a pref left by an older version overwrites the stored login", async () => {
	let { backend, prefStore, lm } = makeBackend({
		prefs: { "extensions.zotero-bridge.llm.openaiKey": "sk-new" },
		logins: [login("openaiKey", "sk-old")],
	});
	let store = secrets.createStore(backend);
	await store.migrateFromPrefs();
	assert.deepEqual(lm.store.map(l => l.password), ["sk-new"]);
	assert.equal(prefStore["extensions.zotero-bridge.llm.openaiKey"], undefined);
});

test("a failed write keeps the pref so nothing is lost", async () => {
	let { backend, prefStore, errors } = makeBackend({ prefs: { "extensions.zotero-bridge.notion.token": "ntn_1" } });
	backend.logins.addLoginAsync = async () => { throw new Error("key4.db is read-only"); };
	let store = secrets.createStore(backend);
	assert.deepEqual(await store.migrateFromPrefs(), []);
	assert.equal(prefStore["extensions.zotero-bridge.notion.token"], "ntn_1");
	assert.match(errors[0].message, /read-only/);
	assert.equal(await store.get("notionToken"), "", "readers are not blocked by the failure");
});

test("get waits for a migration in progress", async () => {
	let { backend } = makeBackend({ prefs: { "extensions.zotero-bridge.llm.anthropicKey": "sk-ant-1" } });
	let release;
	let gate = new Promise(r => { release = r; });
	let add = backend.logins.addLoginAsync;
	backend.logins.addLoginAsync = async (l) => {
		await gate;
		return add(l);
	};
	let store = secrets.createStore(backend);
	store.migrateFromPrefs();
	let value = store.get("anthropicKey");
	release();
	assert.equal(await value, "sk-ant-1");
});

test("set adds, modifies and clears one login per secret", async () => {
	let { backend, lm } = makeBackend();
	let store = secrets.createStore(backend);
	await store.set("notionToken", "  ntn_a ");
	assert.deepEqual(lm.store.map(l => l.password), ["ntn_a"]);
	await store.set("notionToken", "ntn_b");
	assert.deepEqual(lm.store.map(l => l.password), ["ntn_b"]);
	assert.ok(lm.ops.includes("modify"));
	// Concurrent saves don't create duplicates
	await Promise.all([store.set("openaiKey", "1"), store.set("openaiKey", "2"), store.set("openaiKey", "3")]);
	assert.deepEqual(lm.store.filter(l => l.username === "openaiKey").map(l => l.password), ["3"]);
	assert.equal(await store.get("openaiKey"), "3");
	await store.clear("notionToken");
	await store.set("openaiKey", "");
	assert.deepEqual(lm.store, []);
	assert.equal(await store.get("notionToken"), "");
	await assert.rejects(store.get("password"), /Unknown secret/);
	await assert.rejects(store.set("other", "x"), /Unknown secret/);
});

test("get reads logins written outside the cache and removes duplicate entries on write", async () => {
	let { backend, lm } = makeBackend({ logins: [login("anthropicKey", "a1"), login("anthropicKey", "a2"), login("x", "other")] });
	// Only the plugin's origin/realm counts
	lm.store.push({ origin: "chrome://zotero", httpRealm: "Zotero Bridge", username: "notionToken", password: "nope" });
	let store = secrets.createStore(backend);
	assert.equal(await store.get("anthropicKey"), "a1");
	assert.equal(await store.get("notionToken"), "");
	await store.set("anthropicKey", "a3");
	assert.deepEqual(lm.store.filter(l => l.username === "anthropicKey").map(l => l.password), ["a3"]);
});

test("values are encrypted with the OS keystore when available", async () => {
	let keyStore = {
		available: true,
		isEncrypted: v => v.startsWith("oskv1:"),
		encrypt: async v => "oskv1:" + Buffer.from(v).toString("base64"),
		decrypt: async v => Buffer.from(v.slice(6), "base64").toString(),
	};
	let { backend, lm } = makeBackend({ keyStore, prefs: { "extensions.zotero-bridge.llm.anthropicKey": "sk-ant-1" } });
	let store = secrets.createStore(backend);
	await store.migrateFromPrefs();
	assert.match(lm.store[0].password, /^oskv1:/);
	assert.notEqual(lm.store[0].password, "sk-ant-1");
	// A fresh store (new session) decrypts what is stored
	let again = secrets.createStore(backend);
	assert.equal(await again.get("anthropicKey"), "sk-ant-1");
	// Plaintext entries (keystore unusable when saved) still read back
	lm.store.push(login("notionToken", "ntn_plain"));
	assert.equal(await again.get("notionToken"), "ntn_plain");
});

test("keystore failures: write falls back to plaintext, unreadable values give a clear error", async () => {
	let keyStore = {
		available: true,
		isEncrypted: v => v.startsWith("oskv1:"),
		encrypt: async () => { throw new Error("no Secret Service"); },
		decrypt: async () => { throw new Error("locked"); },
	};
	let { backend, lm, errors } = makeBackend({ keyStore, logins: [login("openaiKey", "oskv1:xxx")] });
	let store = secrets.createStore(backend);
	await store.set("notionToken", "ntn_1");
	assert.equal(lm.store.find(l => l.username === "notionToken").password, "ntn_1");
	assert.match(errors[0].message, /Secret Service/);
	await assert.rejects(store.get("openaiKey"), /無法解密已儲存的 OpenAI API key/);
	// Not cached: a later read retries
	keyStore.decrypt = async () => "sk-ok";
	assert.equal(await store.get("openaiKey"), "sk-ok");
	// keyStore present but unavailable → plaintext without trying
	keyStore.available = false;
	keyStore.encrypt = async () => assert.fail("should not encrypt");
	await store.set("anthropicKey", "a");
	assert.equal(lm.store.find(l => l.username === "anthropicKey").password, "a");
});

test("geckoBackend builds nsILoginInfo the way Zotero's sync code does", () => {
	let constructed = [];
	global.Components = {
		interfaces: { nsILoginInfo: "nsILoginInfo" },
		Constructor: function (cid, iface, init) {
			constructed.push([cid, iface, init]);
			return function (...args) { this.args = args; };
		},
	};
	global.Services = { logins: { tag: "logins" } };
	global.Zotero = { OSKeyStore: { tag: "ks" }, Prefs: { get: () => "v", clear: () => {} }, logError: () => {} };
	try {
		let b = secrets.geckoBackend();
		assert.deepEqual(constructed, [["@mozilla.org/login-manager/loginInfo;1", "nsILoginInfo", "init"]]);
		assert.deepEqual(b.newLogin("chrome://zotero-bridge", "Zotero Bridge", "notionToken", "t").args,
			["chrome://zotero-bridge", null, "Zotero Bridge", "notionToken", "t", "", ""]);
		assert.equal(b.logins, global.Services.logins);
		assert.equal(b.keyStore, global.Zotero.OSKeyStore);
	}
	finally {
		delete global.Components;
		delete global.Services;
		delete global.Zotero;
	}
});
