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

- **AI 文獻筆記**：固定格式，包含一句話摘要、背景與目的、設計與方法（樣本、工具信效度、統計）、主要結果、作者結論、研究限制、嚴格評讀、證據等級、對我研究的啟發、關鍵概念 `[[ ]]`、可引用句。模板可以在設定裡改。
- **嚴格評讀（critical appraisal）**：AI 依研究設計選對應的 JBI 清單（RCT、quasi-experimental、cohort、case-control、analytical cross-sectional、qualitative、systematic review；也可用 CASP），逐題回答 是／否／不清楚／不適用 並附一句理由，最後給整體評價（納入／排除／需更多資訊），可直接用在實證報告的文獻評讀。題目以官方清單為準，請對照原版清單確認。
- **研讀欄位（結構化資料）**：AI 同時輸出研究設計、樣本數、場域、PICO、測量工具、證據等級（Oxford CEBM 2011 與 JBI）、評讀工具與結果、國家，寫入 Notion 欄位與 Obsidian frontmatter，可以直接篩選，例如「Study Design = RCT 且 Sample Size > 100」。這些資料也存在 Zotero AI 子筆記最後的「📋 結構化資料」區塊，之後不呼叫 AI 的同步也會沿用；你可以直接在 Zotero 修改那段 JSON。這段 JSON 不會出現在 Obsidian／Notion 的內文。即使改用自訂模板，插件仍會要求 AI 附上這段資料。
- **可引用句查證**：產生筆記後，「可引用的句子」每一句都會和全文、摘要與你的劃線比對（忽略大小寫、彎引號、PDF 換行斷字、中文字間空白；省略號 … 前後分段比對；九成以上的字依序相符即算找到）。找到的標 ✅，找不到的標 ⚠️ 未在全文中找到；沒有全文時標 ⚠️ 無全文可查證。進度視窗會顯示查證結果。
- **APA 7 引文由 Zotero 產生**：使用內建 CSL 引文處理器，不讓 LLM 編造參考文獻。
- **分流規則**：例如「群組文獻庫 → 團隊 Notion DB」、「我的文獻庫／碩論 → 碩論 DB + `Zotero/碩論` 資料夾」。
- **雙向連結**：Notion 頁面有 `Obsidian` 欄位（`obsidian://` 連結）；Obsidian 筆記的 frontmatter 有 `notion` 連結，也有開回 Zotero 的連結；每條劃線都能點回 PDF 的原位置。
- **重新同步不會蓋掉你的內容**：
  - Obsidian：只覆寫 `%% zotero-bridge:start %%` 到 `%% zotero-bridge:end %%` 之間的區塊；你自己加的 frontmatter 欄位（例如 `status`、`aliases`）和區塊外的內容都會保留。
  - Notion：只替換標題為「📚 Zotero Bridge｜…」的那個 callout 區塊，頁面上的其他內容保留。
  - 改了 Citation key 或標題：插件靠 frontmatter 的 `zotero_key` 找到原本的筆記，直接改檔名並更新，不會多出一份新筆記。你把筆記移到預設／規則資料夾底下的其他子資料夾也找得到（之後會留在那裡，不會被搬回去）。新檔名已被另一篇文獻使用時，改用 `檔名 (條目KEY)`。
- **跨文獻比較表**：選多篇文獻或整個分類 → AI 讀各篇的 AI 筆記（沒有的改用摘要與劃線），產生文獻比較表、主題整理、方法學品質、研究缺口。引文由 Zotero 書目轉換（不讓 AI 自己寫參考文獻），Obsidian 版會連回各篇文獻筆記，並附 APA 7 參考文獻。同時存成 Notion 頁面（含真正的表格）、Obsidian 筆記和 Zotero 獨立筆記。
- **Zotero 內直接看 AI 筆記**：條目右側面板新增「AI 文獻筆記」區塊，顯示摘要與重點，並有「同步」「重新產生」按鈕。
- **批次同步可中途停止、之後接續**：同步很多篇時可以從工具選單停止；Zotero 關閉或當掉也不會從頭來過，失敗的文獻可以一鍵重試。
- **自動同步（選用）**：條目、劃線或筆記變更後，自動同步到兩邊。自動同步不會呼叫 AI。
  - 條目移到 Zotero 垃圾桶或刪除時：Notion 頁面移到 Notion 的垃圾桶；Obsidian 筆記**不會刪除**，只把 `status` 改成「已刪除」，並在自動同步區塊最上方加一段提示。從 Zotero 垃圾桶還原後再同步，筆記會恢復原本的閱讀狀態（Notion 會建立新頁面，舊頁面留在 Notion 垃圾桶）。
- **參考文獻檔（Pandoc）**：把文獻庫匯出成 vault 裡的 `Zotero/references.json`（CSL JSON），條目 id 就是筆記的 `citekey`。在 Obsidian 用 `[@citekey]` 寫論文，再用 Pandoc 產生 APA 7 的 Word 檔（見[下方說明](#在-obsidian-寫論文並用-pandoc-產生-apa-word)）。

## 安裝（從 GitHub 下載）

> 🧭 **第一次安裝？用 [安裝精靈](https://bobyu89.github.io/zotero-bridge/) 一步一步完成**：依你的電腦、AI 服務商、同步目的地（Notion／Obsidian）調整步驟，每步打勾確認，進度會記住。

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
   | 研讀欄位（AI） | `Study Design`（選項：RCT、quasi-experimental、cohort、case-control、cross-sectional、qualitative、mixed methods、systematic review、meta-analysis、scoping review、guideline、other）、`Sample Size`（數字）、`Evidence Level`（Oxford CEBM 2011，1–5）、`JBI Level`、`Appraisal Tool`、`Appraisal`（納入／排除／需更多資訊）、`Population`、`Intervention`、`Comparison`、`Outcomes`、`Setting`、`Measures`（多選：測量工具）、`Country` |
   | 連結與同步 | `Zotero`、`Obsidian`、`Zotero Key`、`Date Added`、`Last Synced` |

   > 請不要改這些欄位的名稱，插件是靠名稱寫入的；改名後會再建立一個新的同名欄位。你可以自由新增自己的欄位（例如「閱讀狀態」、「評分」），插件不會動它們。
   >
   > 已經在用的資料庫：再按一次「測試連線並補齊資料庫欄位」，就會加上新的研讀欄位。AI 筆記沒有結構化資料（例如舊的筆記）時，研讀欄位維持原值不會被清空。

### 2. Obsidian

- **Vault 資料夾路徑**：選擇 vault 的根目錄
- **預設子資料夾**：例如 `Zotero`
- **檔名格式**：建議用 Citation key。Zotero 10 有內建 Citation Key 欄位；有裝 Better BibTeX 也會讀取。
- **Bases 總表**：預設會在子資料夾建立 `Zotero 文獻庫.base`（只建立一次，之後不會覆寫你的修改）。想要新版的欄位（研究設計、樣本數、證據等級）可以刪掉舊檔，下次同步會重新建立。
- **研讀欄位的 frontmatter**：`study_design`、`sample_size`（數字）、`evidence_level`、`jbi_level`、`appraisal_tool`、`appraisal_overall`、`setting`、`population`、`intervention`、`comparison`、`outcomes`、`measures`（清單）、`country` 由插件管理，有新的結構化資料時會覆寫；請不要用這些名稱存自己的資料。

### 3. AI（擇一）

| 服務商 | API key 取得處 | 預設模型 |
|---|---|---|
| Anthropic（Claude） | <https://console.anthropic.com> | `claude-opus-5-5`（可調 effort：low～max） |
| OpenAI（GPT／Codex） | <https://platform.openai.com> | `gpt-5.5` |

- 要用 API key，**ChatGPT／Claude 的訂閱方案不能直接用在這裡**，API 另外計費。
- 「Codex」系列是寫程式專用模型。整理文獻用一般模型效果較好，所以預設 `gpt-5.5`；想用 Codex 模型可以自行填入模型名稱。
- **全文最多送出字元數**：預設 150,000 字元。超過會截斷，筆記的 frontmatter 會標記 `fulltext_truncated: true`，也會告訴 LLM 後段沒有提供。設成 0 表示只送摘要與註記，較省錢。
- 一次替超過 5 篇文獻產生 AI 筆記前會先跳出確認視窗；有用量紀錄時會附上預估費用（依過去呼叫的平均 tokens 估算）。
- API 暫時忙碌或網路中斷（HTTP 408／409／429／500／502／503／504、Claude 的 529 overloaded）會自動重試最多 4 次，間隔以指數退避並遵守伺服器的 `retry-after`；金鑰錯誤（401）、請求錯誤（400）或模型拒絕處理不會重試。
- **本月 AI 用量**：設定頁顯示本月呼叫次數、tokens 與估計費用（美元），可重設；每次 AI 執行後，進度視窗也會顯示一行用量摘要。價格表（每百萬 tokens 美元）內建 `claude-opus-5-5` $4／$20、`claude-sonnet-5-5` $2／$10、`claude-haiku-4-5` $1／$5，可以在設定修改；OpenAI 模型沒有內建價格，只顯示 tokens（可自行加入價格）。估計值僅供參考，實際金額以服務商帳單為準。

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
| 重新產生 AI 筆記並同步 | 讀完、劃完線之後重新整理（會覆寫 AI 子筆記；舊內容先另存成「🤖 AI 文獻筆記（舊版 日期）」子筆記） |
| 同步但不呼叫 AI | 只更新書目、劃線與筆記，不花 token |
| 只同步到 Obsidian ／ 只同步到 Notion | |

在分類上按右鍵 → **Zotero Bridge：同步整個分類**（含子分類）。

### 中途停止與接續

一次同步多篇文獻時，進度會逐篇記錄下來：

- **停止**：選單列 **工具 → 停止 Zotero Bridge 同步**。正在處理的那一篇完成後才停（不會留下寫到一半的筆記），還沒處理的文獻會記下來。
- **接續**：**工具 → 繼續未完成的 Zotero Bridge 同步（N 筆）**，用原本的選項（同步目的地、AI 設定）處理剩下的文獻；上次失敗的文獻也會一起重試。
- **Zotero 關閉或當掉**：下次開啟 Zotero 會提醒你還有幾筆沒同步，一樣從工具選單接續。
- **不想接續**：**工具 → 放棄未完成的 Zotero Bridge 同步**。

開始新的多篇同步時，會取代上一次未完成的紀錄。單篇同步和自動同步不會記錄。

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
  - 「文獻總表」：表格，列出標題、作者、年份、期刊、研究設計、樣本數、證據等級、閱讀狀態、分類
  - 「閱讀進度」：1.14 新增的看板（kanban），依 `status` 分成 待讀／閱讀中／已讀／已引用。把卡片拖到別欄就會改筆記的 `status`，重新同步也不會被覆寫
- **Graph view**：AI 筆記裡的 `[[Fall prevention]]` 等關鍵概念會把相關文獻自動串起來

## 在 Obsidian 寫論文並用 Pandoc 產生 APA Word

### 1. 匯出參考文獻檔

| 方式 | 產出 |
|---|---|
| Zotero → 工具 → **匯出參考文獻到 Obsidian** | `<vault>/Zotero/references.json`：我的文獻庫和群組文獻庫的所有文獻 |
| 在分類上按右鍵 → **Zotero Bridge：匯出此分類的參考文獻** | `Zotero/references-<分類名稱>.json`：該分類（含子分類），citekey 和主檔相同 |
| 設定 → 參考文獻檔 → 勾選 **同步時自動更新參考文獻檔** | 每次同步後自動更新 `references.json`，內容沒變就不寫入 |

- 檔案放在 Obsidian 的「預設子資料夾」（例如 `Zotero`）。
- 主檔包含整個文獻庫，而不只是已同步成筆記的文獻：Pandoc 只會列出內文真的有引用的文獻，多出來的條目不影響結果；還沒建立筆記的文獻也能直接引用，不會漏掉。
- 需要 BibTeX（例如寫 LaTeX）時，勾選「同時匯出 references.bib」，會用 Zotero 內建的 BibTeX 匯出器產生同名 `.bib`，citekey 一樣。

**citekey 從哪裡來**：每篇文獻的 `id` 和文獻筆記 frontmatter 的 `citekey` 相同，依序使用：

1. Zotero 10 的 **Citation Key** 欄位
2. Better BibTeX 的 citekey（有安裝時）
3. 都沒有時自動產生：第一作者姓氏 + 年份 + 標題第一個字（略過 the、a、of 等），例如 `chen2024effects`；中文取標題前四個字，例如 `陳2023護理人員`。撞名時，較晚加入 Zotero 的文獻加上 a、b、c，例如 `chen2024effectsa`。

自動產生的 citekey 會記在 `Zotero/.zotero-bridge-citekeys.json`，之後不會變動；文獻刪除後，它的 citekey 也不會轉給別篇，避免論文引用到錯的文獻（Pandoc 會提示找不到引用）。修改第一作者、年份或標題第一個字時，會換成新的 citekey。論文要長期引用的文獻，建議直接在 Zotero 填 Citation Key 欄位。

### 2. 安裝 Pandoc 與 APA 7 樣式

1. 安裝 Pandoc（2.11 以上，內建 `--citeproc`）：<https://pandoc.org/installing.html>
2. 從官方 CSL 樣式庫下載 APA 7 樣式 [`apa.csl`](https://github.com/citation-style-language/styles/blob/master/apa.csl)（[直接下載](https://raw.githubusercontent.com/citation-style-language/styles/master/apa.csl)），放在 vault 根目錄

### 3. 在 Obsidian 引用

| 寫法 | APA 7 輸出 |
|---|---|
| `[@chen2024effects]` | (Chen, 2024) |
| `[@chen2024effects, p. 5]` | (Chen, 2024, p. 5) |
| `@chen2024effects` | Chen (2024)：敘述式引用，放在句子裡 |
| `[@chen2024effects; @lee2021sleep]` | (Chen, 2024; Lee, 2021) |

citekey 可以從文獻筆記的 `citekey` 欄位複製。Pandoc 會把參考文獻列表放在文件最後，所以在論文最後寫一個 `# 參考文獻` 標題即可。

### 4. 產生 Word 檔

在 vault 根目錄開終端機執行：

```bash
pandoc 論文.md --citeproc --bibliography Zotero/references.json --csl apa.csl -o 論文.docx
```

- 想套用學校的字型、行距與邊界：先準備一份格式正確的 Word 檔，加上 `--reference-doc 範本.docx`。
- 論文檔裡的 `[[內部連結]]` Pandoc 不會轉換，交稿用的檔案請改成一般文字。
- `apa.csl` 會用英文 APA 規則排版中文文獻（例如 `et al.`、`&`）。學校要求中文文獻用中文格式時，交件前請手動調整中文文獻。

### 5.（選用）在 Obsidian 預覽參考文獻

安裝社群外掛 **Pandoc Reference List**，在外掛設定填入 `Zotero/references.json` 的完整路徑與 `apa.csl`。側欄會即時列出目前這份筆記引用的文獻（APA 格式），方便邊寫邊檢查 citekey 有沒有打錯。這個外掛也會用到上面安裝的 Pandoc。

## 和 Notero 一起用？

可以並存，但**不要讓兩者寫入同一個 Notion 資料庫**，否則同一篇文獻會出現兩頁。建議改用本插件的分流規則取代 Notero。

## 注意事項

- API key 和 Notion token 存在 Zotero 的密碼管理員（與 Zotero 同步帳號的 API key 相同機制；作業系統鑰匙圈可用時會再加密），不會寫進 profile 的 `prefs.js`。舊版存在 `prefs.js` 的金鑰會在啟動時自動搬移並從 `prefs.js` 刪除。
- 已經 AI 處理過的條目，AI 筆記存在 Zotero 子筆記（標籤 `zotero-bridge-ai`）。你可以直接在 Zotero 修改，下次同步會沿用修改後的內容。
- 重新產生前的舊版 AI 筆記存成另一則子筆記（標籤 `zotero-bridge-ai-history`），只留在 Zotero：不會同步到 Notion／Obsidian，也不會送給 AI。不需要時可以直接刪除。
- Notion 的 API 速率限制約每秒 3 次，同步大量文獻時會比較慢。

## 🧠 研究大腦（Claude Code／Codex）

[`research-brain/`](research-brain/) 是給 Obsidian vault 用的 Claude Code／Codex 設定檔：接上 Zotero 與 Notion，用斜線指令完成跨文獻的工作。插件負責「每一篇」的固定流程，大腦負責「跨文獻」的思考。

- `/lit-compare 跌倒預防`：文獻比較表、主題整理、研究缺口
- `/research-gaps`：研究缺口與 PICO 研究問題
- `/lit-review-draft`：文獻探討初稿
- `/inbox-triage`：待讀文獻與建議閱讀順序

安裝請看 [研究大腦說明](research-brain/README.md)。

## Zotero 升級時

Zotero 現在大約每幾個月就出一個大版本（8 → 9 → 10）。插件宣告支援到 **Zotero 10.x**；Zotero 11 推出時，Zotero 會先把插件停用，直到確認相容為止。

確認方式（維護者）：
1. 在 Zotero 11 beta 上安裝插件，照[安裝精靈](https://bobyu89.github.io/zotero-bridge/)第 7 步試跑一篇文獻、一次文獻比較表。
2. 沒有問題就執行 `npm run compat -- 11.*`，把 `manifest.json` 與 `updates.json` 推到 `main`。已安裝的使用者會自動恢復啟用，不用發新版。
3. 有問題就修正後發新版。

依 Zotero 官方規定，相容版本最多只能宣告到「目前已測試的大版本」（例如 `10.*`），不能預先宣告未來版本。

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
| `content/llm.js` | 筆記模板、嚴格評讀與結構化資料的提示詞、JSON 區塊解析、Claude／OpenAI API（重試、token 用量） |
| `content/verify.js` | 可引用句查證（與全文、劃線比對） |
| `content/secrets.js` | API key／Notion token 存取（Gecko 密碼管理員） |
| `content/usage.js` | AI 用量月報、價格表與費用估算 |
| `content/notion.js` | Notion API（2025-09-03，data sources） |
| `content/core.js` | Obsidian 筆記組裝、frontmatter 合併、分流規則 |
| `content/markdown.js` | Markdown ⇄ Notion blocks ⇄ HTML |
| `content/synthesis.js` | 跨文獻比較表：提示詞、引文轉換、APA 參考文獻 |
| `content/export.js` | 參考文獻檔匯出（CSL JSON／BibTeX）與 citekey 產生 |
| `research-brain/` | Claude Code／Codex 研究大腦設定檔 |
| `site/index.html` | 安裝精靈網頁（GitHub Pages） |

發布新版本：修改 `manifest.json` 的 `version` → `npm run build` → 推送到 `main`，GitHub Actions 會自動建立 Release，Zotero 會自動更新。
