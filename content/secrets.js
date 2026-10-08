/*
 * Zotero Bridge — API keys and the Notion token, kept in the Gecko login manager instead of prefs.js.
 * Follows Zotero's own API-key storage (Zotero.Sync.Data.Local in xpcom/sync/syncLocal.js): one
 * nsILoginInfo per secret under a chrome:// origin, the value encrypted with Zotero.OSKeyStore
 * (Keychain / DPAPI / libsecret) when that is usable.
 * The backend is injected so the module also runs in Node tests.
 */
(function (root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) {
		module.exports = api;
	}
	else {
		(root.ZB = root.ZB || {}).secrets = api;
	}
})(this, function () {
	const ORIGIN = "chrome://zotero-bridge";
	const REALM = "Zotero Bridge";
	const PREF_PREFIX = "extensions.zotero-bridge.";
	// name → the plain pref that held it in earlier versions (migrated once, then cleared)
	const SECRETS = {
		anthropicKey: { pref: "llm.anthropicKey", label: "Claude API key" },
		openaiKey: { pref: "llm.openaiKey", label: "OpenAI API key" },
		notionToken: { pref: "notion.token", label: "Notion integration token" },
		// PubMed new-literature watch (pubmed-watch.js); never stored as a pref, the name only serves migration
		ncbiKey: { pref: "pubmedWatch.apiKey", label: "NCBI API key" },
	};

	function checkName(name) {
		if (!Object.prototype.hasOwnProperty.call(SECRETS, name)) throw new Error(`Unknown secret: ${name}`);
	}

	/**
	 * @param {object} backend
	 *   logins:   { searchLoginsAsync, addLoginAsync, modifyLoginAsync, removeLoginAsync } (Services.logins)
	 *   newLogin: (origin, httpRealm, username, password) => nsILoginInfo
	 *   keyStore: optional Zotero.OSKeyStore-like { available, isEncrypted, encrypt, decrypt }
	 *   prefs:    { get(fullName), clear(fullName) } for migration
	 *   log:      optional error logger
	 */
	function createStore(backend) {
		let cache = new Map();
		let ready = Promise.resolve();
		// Writes run one at a time so two quick saves can't both add a login
		let writes = Promise.resolve();
		let log = backend.log || (() => {});

		async function findLogins(name) {
			let logins = await backend.logins.searchLoginsAsync({ origin: ORIGIN, httpRealm: REALM });
			return (logins || []).filter(l => l.username === name);
		}

		async function encode(value) {
			let ks = backend.keyStore;
			if (ks && ks.available) {
				try {
					return await ks.encrypt(value);
				}
				catch (e) {
					// The OS keystore can be unusable (e.g. no Secret Service on Linux); the login manager
					// still keeps the value out of prefs.js
					log(e);
				}
			}
			return value;
		}

		async function decode(stored, name) {
			let ks = backend.keyStore;
			if (ks && ks.isEncrypted && ks.isEncrypted(stored)) {
				try {
					return await ks.decrypt(stored);
				}
				catch (e) {
					log(e);
					throw new Error(`無法解密已儲存的 ${SECRETS[name].label}（作業系統鑰匙圈無法使用）。請到 設定 → Zotero Bridge 重新輸入。`);
				}
			}
			return stored;
		}

		function write(name, value) {
			let run = writes.then(async () => {
				value = String(value || "").trim();
				let [old, ...extra] = await findLogins(name);
				for (let dup of extra) await backend.logins.removeLoginAsync(dup);
				if (!value) {
					if (old) await backend.logins.removeLoginAsync(old);
					cache.set(name, "");
					return;
				}
				let login = backend.newLogin(ORIGIN, REALM, name, await encode(value));
				if (old) {
					await backend.logins.modifyLoginAsync(old, login);
				}
				else {
					await backend.logins.addLoginAsync(login);
				}
				cache.set(name, value);
			});
			writes = run.catch(() => {});
			return run;
		}

		async function get(name) {
			checkName(name);
			await ready;
			await writes;
			if (cache.has(name)) return cache.get(name);
			let [login] = await findLogins(name);
			let value = login ? await decode(login.password, name) : "";
			cache.set(name, value);
			return value;
		}

		async function set(name, value) {
			checkName(name);
			await ready;
			await write(name, value);
		}

		async function clear(name) {
			return set(name, "");
		}

		/**
		 * Copy secrets still stored as plain prefs into the login manager, then clear the prefs.
		 * A pref is cleared only after its value was stored. Returns the names migrated.
		 */
		function migrateFromPrefs() {
			let run = (async () => {
				let migrated = [];
				for (let [name, { pref }] of Object.entries(SECRETS)) {
					let full = PREF_PREFIX + pref;
					let value;
					try {
						value = String(backend.prefs.get(full) || "").trim();
					}
					catch (e) {
						log(e);
						continue;
					}
					if (!value) {
						// An empty user value still sits in prefs.js; drop it
						try {
							backend.prefs.clear(full);
						}
						catch (e) {}
						continue;
					}
					try {
						// The pref is newer than any stored login (only an older plugin version writes it)
						await write(name, value);
						backend.prefs.clear(full);
						migrated.push(name);
					}
					catch (e) {
						log(e);
					}
				}
				return migrated;
			})();
			// get()/set() wait for the migration so nothing reads a half-migrated state
			ready = run.then(() => {}, () => {});
			return run;
		}

		return { get, set, clear, migrateFromPrefs, get ready() { return ready; } };
	}

	/** Backend for the Zotero/Gecko environment. */
	function geckoBackend() {
		/* global Components, Services, Zotero */
		let LoginInfo = new Components.Constructor("@mozilla.org/login-manager/loginInfo;1",
			Components.interfaces.nsILoginInfo, "init");
		return {
			logins: Services.logins,
			newLogin: (origin, realm, username, password) => new LoginInfo(origin, null, realm, username, password, "", ""),
			keyStore: Zotero.OSKeyStore || null,
			prefs: {
				get: name => Zotero.Prefs.get(name, true),
				clear: name => Zotero.Prefs.clear(name, true),
			},
			log: e => Zotero.logError(e),
		};
	}

	let defaultStore = null;
	function store() {
		if (!defaultStore) defaultStore = createStore(geckoBackend());
		return defaultStore;
	}

	// Async wrappers: a login manager that can't be reached rejects instead of throwing during startup
	return {
		ORIGIN, REALM, SECRETS, createStore, geckoBackend,
		get: async name => store().get(name),
		set: async (name, value) => store().set(name, value),
		clear: async name => store().clear(name),
		migrateFromPrefs: async () => store().migrateFromPrefs(),
	};
});
