pref("extensions.zotero-bridge.obsidian.vaultPath", "");
pref("extensions.zotero-bridge.obsidian.vaultName", "");
pref("extensions.zotero-bridge.obsidian.folder", "Zotero");
pref("extensions.zotero-bridge.obsidian.filenameFormat", "citekey");
pref("extensions.zotero-bridge.obsidian.createBase", true);
pref("extensions.zotero-bridge.includeNotes", true);
pref("extensions.zotero-bridge.notion.database", "");
pref("extensions.zotero-bridge.notion.synthesisParent", "");
pref("extensions.zotero-bridge.routing.rules", "[]");
pref("extensions.zotero-bridge.llm.enabled", true);
pref("extensions.zotero-bridge.llm.provider", "anthropic");
pref("extensions.zotero-bridge.llm.anthropicModel", "claude-opus-5-5");
pref("extensions.zotero-bridge.llm.effort", "medium");
pref("extensions.zotero-bridge.llm.openaiModel", "gpt-5.5");
pref("extensions.zotero-bridge.llm.openaiBaseURL", "");
pref("extensions.zotero-bridge.llm.fullTextLimit", "150000");
pref("extensions.zotero-bridge.llm.systemPrompt", "");
pref("extensions.zotero-bridge.llm.synthesisPrompt", "");
pref("extensions.zotero-bridge.autoSync", false);
// Reading status: Zotero tag <prefix><status>, Notion "Status" column, Obsidian `status` (status.js)
pref("extensions.zotero-bridge.status.enabled", true);
pref("extensions.zotero-bridge.status.tagPrefix", "狀態/");
pref("extensions.zotero-bridge.status.tagEmoji", true);
// Last synced status per item, only used when no Obsidian vault is configured
pref("extensions.zotero-bridge.status.synced", "{}");
// API keys and the Notion token are kept in the login manager (content/secrets.js), not here
pref("extensions.zotero-bridge.usage.ledger", "{}");
pref("extensions.zotero-bridge.usage.prices", "");
pref("extensions.zotero-bridge.export.autoUpdate", false);
pref("extensions.zotero-bridge.export.bibtex", false);
pref("extensions.zotero-bridge.batch.pending", "");
