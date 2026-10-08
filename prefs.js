pref("extensions.zotero-bridge.obsidian.vaultPath", "");
pref("extensions.zotero-bridge.obsidian.vaultName", "");
pref("extensions.zotero-bridge.obsidian.folder", "Zotero");
pref("extensions.zotero-bridge.obsidian.filenameFormat", "citekey");
pref("extensions.zotero-bridge.obsidian.createBase", true);
pref("extensions.zotero-bridge.includeNotes", true);
pref("extensions.zotero-bridge.images.export", true);
pref("extensions.zotero-bridge.images.sendToAI", false);
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
// Scanned PDFs without a text layer are sent to the AI as a file, up to these limits (content/scanned.js)
pref("extensions.zotero-bridge.llm.sendScannedPDF", true);
pref("extensions.zotero-bridge.llm.pdfMaxMB", "20");
pref("extensions.zotero-bridge.llm.pdfMaxPages", "100");
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
// Chinese-language items in Chinese APA 7 (content/apa-zh.js); style "thesis" (。) or "twna" (．)
pref("extensions.zotero-bridge.apaZh.enabled", true);
pref("extensions.zotero-bridge.apaZh.style", "thesis");
pref("extensions.zotero-bridge.apaZh.chineseFirst", true);
pref("extensions.zotero-bridge.batch.pending", "");
// Systematic/scoping review screening (content/screening.js): Zotero tag prefixes, exclusion
// reasons (one per line; empty = built-in list) and the Notion parent page for review pages
pref("extensions.zotero-bridge.screening.tagPrefix", "篩選/");
pref("extensions.zotero-bridge.screening.reasonPrefix", "排除原因/");
pref("extensions.zotero-bridge.screening.sourcePrefix", "來源/");
pref("extensions.zotero-bridge.screening.reasons", "");
pref("extensions.zotero-bridge.screening.notionParent", "");
// Review page per collection ("library/collections/KEY" → Notion page ID), so a rerun updates it
pref("extensions.zotero-bridge.screening.notionPages", "{}");
// 來源/<name> tags counted as "other methods" in PRISMA 2020 (one per line or comma-separated; empty = 引文追蹤, 網站, 機構)
pref("extensions.zotero-bridge.screening.otherSources", "");
// Citation searching with OpenAlex (content/citation-chase.js): email for the polite pool, requests
// per run, works per study and direction, direction "both" | "backward" | "forward"
pref("extensions.zotero-bridge.citationChase.email", "");
pref("extensions.zotero-bridge.citationChase.maxRequests", "100");
pref("extensions.zotero-bridge.citationChase.maxPerSeed", "200");
pref("extensions.zotero-bridge.citationChase.direction", "both");
