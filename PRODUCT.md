# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

ZotMax 是 Zotero 10 的外掛（bootstrap plugin），介面跑在 Zotero 內建的 Gecko（Firefox 140）裡：設定頁（preferences.xhtml）、項目窗格區塊（Item Pane section）、右鍵／工具選單與對話框。另有一個 GitHub Pages 靜態網站（`site/`：首頁、醫學文獻快速搜尋、文獻評讀表），可在一般瀏覽器與手機上使用。

## Users

主要使用者是**台灣的護理研究生**：碩士班為主，同時是臨床護理師，課業、論文與工作排在一起。他們在 Zotero 收文獻、在 Obsidian 或 Notion 寫筆記，常見的任務有課堂報告、系統性／範圍回顧、實證健康照護（EBHC）報告、論文第二章文獻探討，以及和指導教授開會。

次要使用者是維護者本人（進階使用者）：所有功能都要開著，包括 AI 草稿與自動化。

## Product Purpose

把 Zotero 的文獻、標註與評讀結果整理到使用者自己的筆記空間（Obsidian / Notion），並在研究流程中提供工具。成功的定義是**使用者自己找到文獻、自己寫出東西，而且覺得有趣、有成就感**，工具只是讓過程比較順，不是替他們做完。

## Positioning

一般的 AI 文獻工具把「找」和「寫」都自動化；ZotMax 刻意把**找文獻與寫作留給使用者**，只在整理、追蹤、評讀等雜事上幫忙。所有功能都可以逐一開關，並有兩種預設組合：

- **研究生引導**（新使用者的預設）：自動找文獻（PubMed 追蹤、引文追蹤）與 AI 寫作（綜整、文獻回顧草稿、EBHC 報告草稿、進度報告、概念 AI 綜整、批次 AI）預設關閉。
- **進階**：全部打開。

使用者改了任何一個開關，就變成「自訂」。

## Operating Context

- Zotero 10 桌面版（Windows / macOS），設定頁在 Zotero 設定視窗裡，跟 Zotero 自己的設定頁並列；外觀要跟著 Zotero 的淺色／深色主題。
- 筆記端：Obsidian vault（Markdown、frontmatter、Bases）或 Notion 資料庫。
- 研究流程：PICO 問題 → 搜尋（PubMed、CINAHL、Cochrane、華藝等）→ 篩選（PRISMA 2020）→ 評讀（CASP / JBI）→ 整合 → 寫作 → 指導教授會議。
- AI 使用者自備 API key（Claude 或 OpenAI），要花錢，所以費用要透明。

## Capabilities and Constraints

- 介面語言：繁體中文為主（zh-TW），另有 en-US；醫學與方法學術語保留英文（PICO、MeSH、CASP、JBI、PRISMA）。
- 字串在 Fluent（`locale/*/zotero-bridge.ftl`）；設定值在 Zotero prefs（`prefs.js`）；API key 存在登入管理員，不進 prefs。
- 設定頁必須用 Zotero 的設定頁機制（XHTML fragment + `preferences.js`），不能載入外部字型或 CDN。
- 網站是純靜態 HTML/CSS/JS，不能放 API key。
- 已發布版本的 `updates.json` 項目不可更動。

## Brand Commitments

- 名稱：ZotMax，介紹時說它是「給 Zotero 的外掛」，不把 Zotero 當成產品名的一部分（[Zotero 商標規範](https://www.zotero.org/support/terms/trademark)）。外掛 ID、偏好設定、檔名等內部識別仍用 `zotero-bridge`。圖示：`content/icons/bridge.svg`。
- 語氣：像學長姐在旁邊提點，直接、溫和、不說教；不誇大 AI 能力，未驗證的就標示未驗證。

## Evidence on Hand

- 沒有使用者見證、使用數據或案例，不可捏造。
- 有實際的 CI 驗證紀錄（真實 Zotero e2e、連結檢查）。

## Product Principles

1. **找與寫留給人**：預設不替使用者找文獻、不替使用者寫作；AI 只在使用者主動打開後出現。
2. **每個功能都能關**：功能清楚分組，每個都有一句話說明它做什麼、會不會用到 AI／花錢。
3. **先自己做，再看工具**：評讀、篩選等功能以使用者的判斷為主，工具負責記錄與整理。
4. **留空間給使用者**：筆記模板、提示詞、概念頁都可以自己改。
5. **透明**：會連網、會花錢、會寫檔案的動作要說清楚。

## Accessibility & Inclusion

設定頁與網站都要可用鍵盤操作、有清楚的焦點樣式，並支援 Zotero 的字級設定與深色模式；網站要能在手機上使用。
