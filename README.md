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
- **跨文獻比較表**：選多篇文獻或整個分類 → AI 讀各篇的 AI 筆記（沒有的改用摘要與劃線），產生文獻比較表、主題整理、方法學品質、研究缺口。引文由 Zotero 書目轉換（不讓 AI 自己寫參考文獻），Obsidian 版會連回各篇文獻筆記，並附 APA 7 參考文獻。同時存成 Notion 頁面（含真正的表格）、Obsidian 筆記和 Zotero 獨立筆記。
- **Zotero 內直接看 AI 筆記**：條目右側面板新增「AI 文獻筆記」區塊，顯示摘要與重點，並有「同步」「重新產生」按鈕。
- **自動同步（選用）**：條目、劃線或筆記變更後，自動同步到兩邊。自動同步不會呼叫 AI。

## 安裝（從 GitHub 下載）

1. 到 GitHub 的 **[Releases 頁面](https://github.com/bobyu89/zotero-bridge/releases)**，下載最新版 `zotero-bridge-x.y.z.xpi`
   - 用 Firefox 下載時，請在連結上按右鍵 →「另存連結」，不要直接點開，否則 Firefox 會嘗試把它當成自己的擴充功能安裝
2. Zotero → 工具 → 插件 → 右上角齒輪 → **Install Plugin From File…** → 選擇 `.xpi`
3. Zotero → 設定 → **Zotero Bridge**，依下列步驟設定

之後有新版本時，Zotero 會自動從 GitHub 檢查並更新（工具 → 插件 → 齒輪 → Check for Updates 也可以手動檢查）。

> 需要 Zotero 10；Obsidian 建議 1.14 以上（彩色劃線與 Bases 看板）。

### 1. Notion

1. 到 <https://www.notion.so/profile/integrations> 建立一個 **Internal integration**，複製 token（`ntn_` 開頭）
2. 在 Notion 建立一個資料庫（可以是空白的 Table）。右上角 `•••` → **Connections** → 加入剛剛的 integration
3. 複製資料庫連結（`https://www.notion.so/...`），貼到「預設資料庫連結」或分流規則
4. 按 **測試連線並補齊資料庫欄位**，插件會用 Zotero 的書目欄位當作資料庫表頭，自動建立以下欄位：

   | 類別 | 欄位 |
   |---|---|
   | 書目資料 | 標題（沿用資料庫原本的標題欄）、`Authors`、`Year`、`Date`、`Publication`、`Volume`、`Issue`、`Pages`、`Publisher`、`Item Type`、`DOI`、`URL`、`Abstract` |
   | 整理用 | `Tags`、`Collections`、`Library`、`Citation Key`、`APA`、`Summary`（AI 一句話摘要） |
   | 連結與同步 | `Zotero`、`Obsidian`、`Zotero Key`、`Date Added`、`Last Synced` |

   > 請不要改這些欄位的名稱，插件是靠名稱寫入的；改名後會再建立一個新的同名欄位。你可以自由新增自己的欄位（例如「閱讀狀態」、「評分」），插件不會動它們。

### 2. Obsidian

- **Vault 資料夾路徑**：選擇 vault 的根目錄
- **預設子資料夾**：例如 `Zotero`
- **檔名格式**：建議用 Citation key。Zotero 10 有內建 Citation Key 欄位；有裝 Better BibTeX 也會讀取。
- **Bases 總表**：預設會在子資料夾建立 `Zotero 文獻庫.base`（只建立一次，之後不會覆寫你的修改）

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

### 文獻比較表

1. 選取 2 篇以上的文獻（或在分類上按右鍵），選 **產生文獻比較表（AI）**。
2. 產出位置：
   - Obsidian：`Zotero/文獻比較/文獻比較：<分類>（N 篇） <日期時間>.md`
   - Zotero：獨立筆記（標籤 `zotero-bridge-synthesis`），放在該分類並關聯所有來源文獻
   - Notion：在設定填入「文獻比較表的 Notion 父頁面」後，建立成該頁面的子頁面（父頁面也要分享給 integration）
3. 建議先替各篇產生 AI 筆記，比較表會更完整。一次最多 60 篇，每次會產生一次 API 費用。
4. 比較表的格式可以在設定的「文獻比較表模板」修改。

### 在 Zotero 裡看 AI 筆記

選取一篇文獻，右側面板的「AI 文獻筆記」區塊會顯示一句話摘要與各段重點；收合時標題列會顯示摘要。還沒有 AI 筆記時，可以直接按「產生 AI 筆記並同步」。

選「同步到兩邊」但只設定了其中一邊時，沒設定的那邊會自動略過。某一步失敗（例如 AI 逾時）時，其他步驟照常完成，錯誤會顯示在進度視窗與 `說明 → 除錯輸出記錄`。

### Obsidian 1.14 搭配功能

- **彩色劃線**：Zotero 的劃線顏色會轉成 Obsidian 1.14 的彩色 highlight，例如 `==🟡Falls decreased by 30%==`。Zotero 的洋紅色對應紫色，灰色對應主題預設色（Obsidian 只有六種顏色）。同步到 Notion 時也會轉成對應的背景色。
- **Bases 文獻總表**（`Zotero 文獻庫.base`，核心外掛 Bases，不需要 Dataview）：
  - 「文獻總表」：表格，列出標題、作者、年份、期刊、閱讀狀態、分類
  - 「閱讀進度」：1.14 新增的看板（kanban），依 `status` 分成 待讀／閱讀中／已讀／已引用。把卡片拖到別欄就會改筆記的 `status`，重新同步也不會被覆寫
- **Graph view**：AI 筆記裡的 `[[Fall prevention]]` 等關鍵概念會把相關文獻自動串起來

## 和 Notero 一起用？

可以並存，但**不要讓兩者寫入同一個 Notion 資料庫**，否則同一篇文獻會出現兩頁。建議改用本插件的分流規則取代 Notero。

## 注意事項

- API key 和 Notion token 以明碼存在 Zotero 設定檔（profile 的 `prefs.js`）中，請勿分享該檔案。
- 已經 AI 處理過的條目，AI 筆記存在 Zotero 子筆記（標籤 `zotero-bridge-ai`）。你可以直接在 Zotero 修改，下次同步會沿用修改後的內容。
- Notion 的 API 速率限制約每秒 3 次，同步大量文獻時會比較慢。

## 🧠 研究大腦（Claude Code／Codex）

[`research-brain/`](research-brain/) 是給 Obsidian vault 用的 Claude Code／Codex 設定檔：接上 Zotero 與 Notion，用斜線指令完成跨文獻的工作。插件負責「每一篇」的固定流程，大腦負責「跨文獻」的思考。

- `/lit-compare 跌倒預防`：文獻比較表、主題整理、研究缺口
- `/research-gaps`：研究缺口與 PICO 研究問題
- `/lit-review-draft`：文獻探討初稿
- `/inbox-triage`：待讀文獻與建議閱讀順序

安裝請看 [研究大腦說明](research-brain/README.md)。

## 開發

```bash
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
| `content/synthesis.js` | 跨文獻比較表：提示詞、引文轉換、APA 參考文獻 |
| `research-brain/` | Claude Code／Codex 研究大腦設定檔 |

發布新版本：修改 `manifest.json` 的 `version` → `npm run build` → 推送到 `main`，GitHub Actions 會自動建立 Release，Zotero 會自動更新。
