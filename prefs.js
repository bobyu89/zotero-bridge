pref("extensions.zotero-bridge.obsidian.vaultPath", "");
pref("extensions.zotero-bridge.obsidian.vaultName", "");
pref("extensions.zotero-bridge.obsidian.folder", "Zotero");
pref("extensions.zotero-bridge.obsidian.filenameFormat", "citekey");
pref("extensions.zotero-bridge.obsidian.createBase", true);
// Rebuild <folder>/研究儀表板.md after each manual sync (content/dashboard.js)
pref("extensions.zotero-bridge.dashboard.autoUpdate", true);
// Concept hub notes (content/concepts.js): rebuild <folder>/<concepts.folder>/*.md after each manual sync;
// measures (and outcomes) from the structured data as concepts; alias groups, one per line: 跌倒 = Accidental Falls = falls;
// a custom prompt for 「為概念卡片產生 AI 綜整」 (empty = built-in)
pref("extensions.zotero-bridge.concepts.autoUpdate", true);
pref("extensions.zotero-bridge.concepts.folder", "概念");
pref("extensions.zotero-bridge.concepts.measures", true);
pref("extensions.zotero-bridge.concepts.outcomes", false);
pref("extensions.zotero-bridge.concepts.aliases", "");
pref("extensions.zotero-bridge.concepts.aiPrompt", "");
pref("extensions.zotero-bridge.includeNotes", true);
pref("extensions.zotero-bridge.images.export", true);
pref("extensions.zotero-bridge.images.sendToAI", false);
pref("extensions.zotero-bridge.notion.database", "");
pref("extensions.zotero-bridge.notion.synthesisParent", "");
// Notion column IDs per data source ({ dsId: { "Zotero Key": "<property id>", … } }), so a renamed column is still found (content/notion.js)
pref("extensions.zotero-bridge.notion.propertyIds", "{}");
// Highlight colour → meaning, in display order (JSON array of { color, meaning }; empty = built-in: 黃 重要發現, 紅 限制／疑問…) (content/core.js)
pref("extensions.zotero-bridge.annotations.colorMeanings", "");
// Full text as Markdown (content/fulltext.js): subfolder next to each literature note, the markitdown executable
// (empty = built-in conversion only), References & co. cut before the text goes to the AI, a Notion child page
pref("extensions.zotero-bridge.fullText.folder", "全文");
pref("extensions.zotero-bridge.fullText.markitdownPath", "");
pref("extensions.zotero-bridge.llm.trimReferences", true);
pref("extensions.zotero-bridge.notion.fullTextPage", false);
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
// Claude Message Batches for bulk AI notes (content/ai-batch.js): off by default; used when a manual run
// needs AI notes for at least batchThreshold items; batch.ai keeps the submitted batches across restarts
pref("extensions.zotero-bridge.llm.batchAPI", false);
pref("extensions.zotero-bridge.llm.batchThreshold", "10");
pref("extensions.zotero-bridge.batch.ai", "");
// Systematic/scoping review screening (content/screening.js): Zotero tag prefixes, exclusion
// reasons (one per line; empty = built-in list) and the Notion parent page for review pages
pref("extensions.zotero-bridge.screening.tagPrefix", "篩選/");
pref("extensions.zotero-bridge.screening.reasonPrefix", "排除原因/");
pref("extensions.zotero-bridge.screening.sourcePrefix", "來源/");
pref("extensions.zotero-bridge.screening.reasons", "");
pref("extensions.zotero-bridge.screening.notionParent", "");
// Review page per collection ("library/collections/KEY" → Notion page ID), so a rerun updates it
pref("extensions.zotero-bridge.screening.notionPages", "{}");
// PubMed new-literature watch (content/pubmed-watch.js): saved searches (JSON array), per-watch
// state (last check, PMIDs seen, queue), contact email for NCBI, PMIDs imported per watch and check,
// automatic checks every N hours, AI notes for new papers after a manual check, daily Obsidian list
pref("extensions.zotero-bridge.pubmedWatch.watches", "[]");
pref("extensions.zotero-bridge.pubmedWatch.state", "{}");
pref("extensions.zotero-bridge.pubmedWatch.email", "");
pref("extensions.zotero-bridge.pubmedWatch.maxPerWatch", "50");
pref("extensions.zotero-bridge.pubmedWatch.autoCheck", false);
pref("extensions.zotero-bridge.pubmedWatch.intervalHours", "24");
pref("extensions.zotero-bridge.pubmedWatch.runAI", false);
pref("extensions.zotero-bridge.pubmedWatch.digest", true);
// 來源/<name> tags counted as "other methods" in PRISMA 2020 (one per line or comma-separated; empty = 引文追蹤, 網站, 機構)
pref("extensions.zotero-bridge.screening.otherSources", "");
// Citation searching with OpenAlex (content/citation-chase.js): email for the polite pool, requests
// per run, works per study and direction, direction "both" | "backward" | "forward"
pref("extensions.zotero-bridge.citationChase.email", "");
pref("extensions.zotero-bridge.citationChase.maxRequests", "100");
pref("extensions.zotero-bridge.citationChase.maxPerSeed", "200");
pref("extensions.zotero-bridge.citationChase.direction", "both");
// Medical-literature search links (content/search-links.js): source order and hidden sources
// (comma-separated IDs), custom sources (JSON array of { name, url with {q}, needsAccess }), the
// library proxy prefix (EZproxy, only for sources that need institutional access) and sources it
// skips, item-menu entries, item pane links, the 「🔎 延伸搜尋」 note callout, C in the PICO string,
// MeSH suggestions from NCBI in Tools → 醫學文獻快速搜尋…
pref("extensions.zotero-bridge.searchLinks.order", "");
pref("extensions.zotero-bridge.searchLinks.disabled", "");
pref("extensions.zotero-bridge.searchLinks.custom", "[]");
pref("extensions.zotero-bridge.searchLinks.proxyPrefix", "");
pref("extensions.zotero-bridge.searchLinks.proxyExclude", "");
pref("extensions.zotero-bridge.searchLinks.menuCount", "8");
pref("extensions.zotero-bridge.searchLinks.paneLinks", true);
pref("extensions.zotero-bridge.searchLinks.noteCallout", true);
pref("extensions.zotero-bridge.searchLinks.picoComparison", false);
pref("extensions.zotero-bridge.searchLinks.meshHelper", true);
// Feature switches (content/features.js), defaults = the 研究生引導 (guided) preset. Features that had
// an enable pref before use it instead: llm.enabled, llm.batchAPI, status.enabled, apaZh.enabled,
// images.export. features.version: the one-time migrations done (0 = none yet; 1 turns everything on for
// profiles that used the plugin before the switches existed; 2 gives 進階 profiles the v0.10.0 switches:
// 全文筆記, 文獻自動分類, 工具列按鈕, AI 標重點 and AI 主題分類; 3 the v0.12.0 switches: 評讀陪練)
pref("extensions.zotero-bridge.features.version", 0);
pref("extensions.zotero-bridge.feature.sync", true);
pref("extensions.zotero-bridge.feature.bibliography", true);
pref("extensions.zotero-bridge.feature.dashboard", true);
pref("extensions.zotero-bridge.feature.concepts", true);
pref("extensions.zotero-bridge.feature.fullTextMarkdown", true);
pref("extensions.zotero-bridge.feature.searchLinks", true);
pref("extensions.zotero-bridge.feature.pubmedWatch", false);
pref("extensions.zotero-bridge.feature.citationChase", false);
pref("extensions.zotero-bridge.feature.screening", true);
pref("extensions.zotero-bridge.feature.appraisalForm", true);
pref("extensions.zotero-bridge.feature.synthesis", false);
pref("extensions.zotero-bridge.feature.reviewDraft", false);
pref("extensions.zotero-bridge.feature.ebhcReport", false);
pref("extensions.zotero-bridge.feature.progressReport", false);
pref("extensions.zotero-bridge.feature.conceptsAI", false);
pref("extensions.zotero-bridge.feature.aiHighlights", false);
pref("extensions.zotero-bridge.feature.autoClassify", true);
pref("extensions.zotero-bridge.feature.classifyAI", false);
pref("extensions.zotero-bridge.feature.toolbarButton", true);
pref("extensions.zotero-bridge.feature.appraisalCoach", false);
// Settings pane (content/preferences.js): the tab chosen last, and a section (data-zb-section ID, e.g.
// "notion") to open the next time the pane is on screen; the pane clears it once it has opened it
pref("extensions.zotero-bridge.prefs.lastTab", "features");
pref("extensions.zotero-bridge.prefs.pendingSection", "");
// 文獻自動分類 (content/classify.js): where the sub-collections go (a collection path like 碩論/文獻回顧;
// empty = the library's top level) and the parent's name; the four dimensions; topics (one per line,
// `名稱: 說明`) and rules (one per line, `子分類名稱 = 條件`); the last applied run, for 復原上次分類
pref("extensions.zotero-bridge.classify.parentPath", "");
pref("extensions.zotero-bridge.classify.parentName", "自動分類");
pref("extensions.zotero-bridge.classify.design", true);
pref("extensions.zotero-bridge.classify.topics", true);
pref("extensions.zotero-bridge.classify.rules", true);
pref("extensions.zotero-bridge.classify.pico", true);
pref("extensions.zotero-bridge.classify.topicList", "");
pref("extensions.zotero-bridge.classify.ruleList", "");
pref("extensions.zotero-bridge.classify.lastRun", "");
// The ZotMax panel in the item pane (content/sidepanel.js): which parts are open, JSON { keyPoints: true, … }
// (empty = 重點 and 動作 open, the others closed)
pref("extensions.zotero-bridge.pane.open", "{}");
