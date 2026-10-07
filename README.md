# Zotero Bridge

Zotero 10 插件：**用 Claude 或 OpenAI 把文獻整理成結構化筆記，連同書目、PDF 註記和 Zotero 筆記一起同步到 Notion 與 Obsidian**。可以依「文獻庫／分類」分流到不同的 Notion 資料庫與 Obsidian 資料夾（Notero 做不到的部分）。

```
Zotero（管理文獻、閱讀、劃線）
   │  右鍵 → Zotero Bridge
   ▼
LLM（Claude / OpenAI）讀「書目 + 摘要 + 全文 + 你的劃線與筆記」→ 結構化文獻筆記
   │  存回 Zotero 子筆記（下次同步不再花 token）
   ├──► Notion：依規則寫入對應資料庫（一篇一頁，欄位可排序／篩選）
   └──► Obsidian：依規則寫入對應資料夾（[[關鍵概念]] 自動形成知識連結）
```

## 功能

- **AI 文獻筆記**：固定格式，包含一句話摘要、背景與目的、設計與方法（樣本、工具信效度、統計）、主要結果、作者結論、研究限制、證據等級、對我研究的啟發、關鍵概念 `[[ ]]`、可引用句。模板可以在設定裡改。
- **APA 7 引文由 Zotero 產生**：使用內建 CSL 引文處理器，不讓 LLM 編造參考文獻。
- **分流規則**：例如「群組文獻庫 → 團隊 Notion DB」、「我的文獻庫／碩論 → 碩論 DB + `Zotero/碩論` 資料夾」。
- **雙向連結**：Notion 頁面有 `Obsidian` 欄位（`obsidian://` 連結）；Obsidian 筆記的 frontmatter 有 `notion` 連結，也有開回 Zotero 的連結；每條劃線都能點回 PDF 的原位置。
- **重新同步不會蓋掉你的內容**：
  - Obsidian：只覆寫 `%% zotero-bridge:start %%` 到 `%% zotero-bridge:end %%` 之間的區塊；你自己加的 frontmatter 欄位（例如 `status`、`aliases`）和區塊外的內容都會保留。
  - Notion：只替換標題為「📚 Zotero Bridge｜…」的那個 callout 區塊，頁面上的其他內容保留。
- **自動同步（選用）**：條目、劃線或筆記變更後，自動同步到兩邊。自動同步不會呼叫 AI。

## 安裝

1. 下載 [`dist/zotero-bridge-0.1.0.xpi`](dist/zotero-bridge-0.1.0.xpi)
2. Zotero → 工具 → 插件 → 右上角齒輪 → **Install Plugin From File…** → 選擇 `.xpi`
3. Zotero → 設定 → **Zotero Bridge**，依下列步驟設定

> 需要 Zotero 10。

### 1. Notion

1. 到 <https://www.notion.so/profile/integrations> 建立一個 **Internal integration**，複製 token（`ntn_` 開頭）
2. 在 Notion 建立一個資料庫（可以是空白的 Table）。右上角 `•••` → **Connections** → 加入剛剛的 integration
3. 複製資料庫連結（`https://www.notion.so/...`），貼到「預設資料庫連結」或分流規則
4. 按 **測試連線並補齊資料庫欄位**，插件會自動建立以下欄位：
   `Authors, Year, Publication, Item Type, DOI, Zotero, Obsidian, Tags, Collections, Library, Citation Key, Zotero Key, Summary, APA, Last Synced`

### 2. Obsidian

- **Vault 資料夾路徑**：選擇 vault 的根目錄
- **預設子資料夾**：例如 `Zotero`
- **檔名格式**：建議用 Citation key。Zotero 10 有內建 Citation Key 欄位；有裝 Better BibTeX 也會讀取。

### 3. AI（擇一）

| 服務商 | API key 取得處 | 預設模型 |
|---|---|---|
| Anthropic（Claude） | <https://console.anthropic.com> | `claude-opus-5-5`（可調 effort：low～max） |
| OpenAI（GPT／Codex） | <https://platform.openai.com> | `gpt-5.5` |

- 要用 API key，**ChatGPT／Claude 的訂閱方案不能直接用在這裡**，API 另外計費。
- 「Codex」系列是寫程式專用模型。整理文獻用一般模型效果較好，所以預設 `gpt-5.5`；想用 Codex 模型可以自行填入模型名稱。
- **全文最多送出字元數**：預設 150,000 字元。超過會截斷，筆記的 frontmatter 會標記 `fulltext_truncated: true`，也會告訴 LLM 後段沒有提供。設成 0 表示只送摘要與註記，較省錢。
- 一次替超過 5 篇文獻產生 AI 筆記前會先跳出確認視窗。

### 4. 分流規則（選用）

由上往下比對，**第一條符合的規則生效**；欄位留空時用預設值。

| 名稱 | 文獻庫 | 分類路徑 | Notion 資料庫 | Obsidian 子資料夾 |
|---|---|---|---|---|
| 碩論 | 我的文獻庫 | `碩論` | 碩論 DB 連結 | `Zotero/碩論` |
| 實驗室 | 群組：XX Lab | （空白） | 實驗室 DB 連結 | `Zotero/Lab` |
| 其他 | 全部文獻庫 | （空白） | （空白 = 預設） | `Zotero/Inbox` |

分類路徑會包含子分類，例如 `碩論` 會比對到 `碩論/文獻回顧`。

## 使用

在條目上按右鍵 → **Zotero Bridge**：

| 選項 | 說明 |
|---|---|
| 同步到 Notion + Obsidian（沒有 AI 筆記才產生） | 日常使用 |
| 重新產生 AI 筆記並同步 | 讀完、劃完線之後重新整理（會覆寫 AI 子筆記） |
| 同步但不呼叫 AI | 只更新書目、劃線與筆記，不花 token |
| 只同步到 Obsidian ／ 只同步到 Notion | |

在分類上按右鍵 → **Zotero Bridge：同步整個分類**（含子分類）。

選「同步到兩邊」但只設定了其中一邊時，沒設定的那邊會自動略過。某一步失敗（例如 AI 逾時）時，其他步驟照常完成，錯誤會顯示在進度視窗與 `說明 → 除錯輸出記錄`。

### Obsidian 推薦搭配

- **Graph view**：AI 筆記裡的 `[[Fall prevention]]` 等關鍵概念會把相關文獻自動串起來
- **Dataview**：用 frontmatter 建立文獻總表

````markdown
```dataview
TABLE year, publication, citekey
FROM "Zotero/碩論"
SORT year DESC
```
````

## 和 Notero 一起用？

可以並存，但**不要讓兩者寫入同一個 Notion 資料庫**，否則同一篇文獻會出現兩頁。建議改用本插件的分流規則取代 Notero。

## 注意事項

- API key 和 Notion token 以明碼存在 Zotero 設定檔（profile 的 `prefs.js`）中，請勿分享該檔案。
- 已經 AI 處理過的條目，AI 筆記存在 Zotero 子筆記（標籤 `zotero-bridge-ai`）。你可以直接在 Zotero 修改，下次同步會沿用修改後的內容。
- Notion 的 API 速率限制約每秒 3 次，同步大量文獻時會比較慢。

## 開發

```bash
cd zotero-bridge
npm install
npm test         # 單元測試 + 模擬 Zotero 環境的整合測試
npm run build    # 產生 dist/zotero-bridge-<version>.xpi
```

| 檔案 | 用途 |
|---|---|
| `bootstrap.js` | 插件生命週期、載入腳本、註冊設定頁 |
| `content/main.js` | 同步流程、右鍵選單、自動同步 |
| `content/zotero-adapter.js` | 讀取 Zotero 條目、註記、全文、APA；存 AI 筆記 |
| `content/llm.js` | 筆記模板、Claude／OpenAI API |
| `content/notion.js` | Notion API（2025-09-03，data sources） |
| `content/core.js` | Obsidian 筆記組裝、frontmatter 合併、分流規則 |
| `content/markdown.js` | Markdown ⇄ Notion blocks ⇄ HTML |
