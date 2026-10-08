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
- **圖片劃線（表格、圖）**：在 PDF 閱讀器框選的圖片劃線與手繪註記，會連同 Zotero 產生的截圖一起同步：Obsidian 嵌入筆記、Notion 成為圖片區塊；也可以讓 Claude 讀這些截圖（見[圖片劃線](#圖片劃線表格圖)）。
- **重新同步不會蓋掉你的內容**：
  - Obsidian：只覆寫 `%% zotero-bridge:start %%` 到 `%% zotero-bridge:end %%` 之間的區塊；你自己加的 frontmatter 欄位（例如 `status`、`aliases`）和區塊外的內容都會保留。
  - Notion：只替換標題為「📚 Zotero Bridge｜…」的那個 callout 區塊，頁面上的其他內容保留。
  - 改了 Citation key 或標題：插件靠 frontmatter 的 `zotero_key` 找到原本的筆記，直接改檔名並更新，不會多出一份新筆記。你把筆記移到預設／規則資料夾底下的其他子資料夾也找得到（之後會留在那裡，不會被搬回去）。新檔名已被另一篇文獻使用時，改用 `檔名 (條目KEY)`。
- **跨文獻比較表**：選多篇文獻或整個分類 → AI 讀各篇的 AI 筆記（沒有的改用摘要與劃線），產生文獻比較表、主題整理、方法學品質、研究缺口。引文由 Zotero 書目轉換（不讓 AI 自己寫參考文獻），Obsidian 版會連回各篇文獻筆記，並附 APA 7 參考文獻。同時存成 Notion 頁面（含真正的表格）、Obsidian 筆記和 Zotero 獨立筆記。
- **系統性／範圍回顧篩選（PRISMA 2020）**：在 Zotero 用右鍵或右側面板標記標題摘要與全文的納入／排除（排除原因可自訂），找出可能重複的文獻，一鍵產生 PRISMA 2020 計數、Mermaid 流程圖與納入研究的證據表（Obsidian 筆記 + Excel 可開的 CSV，可選 Notion 頁面），並檢查計數是否一致（見[系統性／範圍回顧篩選](#系統性範圍回顧篩選)）。
- **Zotero 內直接看 AI 筆記**：條目右側面板新增「AI 文獻筆記」區塊，顯示摘要與重點，並有「同步」「重新產生」按鈕。
- **批次同步可中途停止、之後接續**：同步很多篇時可以從工具選單停止；Zotero 關閉或當掉也不會從頭來過，失敗的文獻可以一鍵重試。
- **閱讀狀態三邊同步**：在 Zotero（標籤）、Notion（`Status` 欄位）或 Obsidian（看板拖曳）任一邊改閱讀狀態，下次同步時另外兩邊會跟著改（見[閱讀狀態同步](#閱讀狀態同步)）。
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
   | 整理用 | `Status`（閱讀狀態，單選：待讀／閱讀中／已讀／已引用／已刪除）、`Tags`、`Collections`、`Library`、`Citation Key`、`APA`、`Summary`（AI 一句話摘要） |
   | 研讀欄位（AI） | `Study Design`（選項：RCT、quasi-experimental、cohort、case-control、cross-sectional、qualitative、mixed methods、systematic review、meta-analysis、scoping review、guideline、other）、`Sample Size`（數字）、`Evidence Level`（Oxford CEBM 2011，1–5）、`JBI Level`、`Appraisal Tool`、`Appraisal`（納入／排除／需更多資訊）、`Population`、`Intervention`、`Comparison`、`Outcomes`、`Setting`、`Measures`（多選：測量工具）、`Country` |
   | 連結與同步 | `Zotero`、`Obsidian`、`Zotero Key`、`Date Added`、`Last Synced` |

   > 請不要改這些欄位的名稱，插件是靠名稱寫入的；改名後會再建立一個新的同名欄位。你可以自由新增自己的欄位（例如「評分」），插件不會動它們。
   >
   > 已經在用的資料庫：再按一次「測試連線並補齊資料庫欄位」，就會加上新的研讀欄位與 `Status` 欄位。AI 筆記沒有結構化資料（例如舊的筆記）時，研讀欄位維持原值不會被清空。

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
- **AI 也看圖片劃線**（預設關閉）：把圖片劃線與手繪註記的截圖一起傳給 Claude，見[圖片劃線](#圖片劃線表格圖)。
- 一次替超過 5 篇文獻產生 AI 筆記前會先跳出確認視窗；有用量紀錄時會附上預估費用（依過去呼叫的平均 tokens 估算；掃描版 PDF 直接傳給 AI 時用量大得多，預估可能偏低，見[掃描版 PDF](#掃描版-pdf沒有文字層)）。
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

### 掃描版 PDF（沒有文字層）

舊文獻、圖書館掃描或部分出版社的 PDF 只是一張張頁面影像，Zotero 讀不到文字。以前這種文獻的 AI 筆記只靠摘要寫成，看起來卻像讀過全文；現在插件會先判斷每篇文獻的全文狀況：

| `full_text`（Obsidian）／「Full Text」（Notion） | 意思 | 判斷方式 |
|---|---|---|
| `ok` | 有全文 | PDF（或 EPUB、網頁快照）有文字層 |
| `partial` | 部分掃描 | 平均每頁不到 600 個字元（不含空白），通常是大部分頁面為掃描影像 |
| `none` | 掃描版（沒有文字層） | 平均每頁不到 100 個字元：完全沒有文字，或只有出版社的下載浮水印 |
| `no_pdf` | 沒有 PDF | 沒有 PDF／EPUB／網頁快照附件，或檔案不在這台電腦上 |

- 頁數取自 Zotero 的全文索引；還沒建索引的 PDF 由 Zotero 的 PDF 工具讀頁數。讀不到頁數時，只有幾乎完全沒有文字（少於 20 字元）才判為 `none`。一篇文獻有多個附件時取最好的那個（例如本文有文字、補充資料是掃描檔 → `ok`）。
- 每次同步都會更新 `full_text` 與 Notion 的「Full Text」欄位（由插件管理，手動修改會被覆寫），可以在 Obsidian Bases 或 Notion 篩選出需要處理的掃描檔。舊的 Notion 資料庫按設定裡的「測試連線並補齊資料庫欄位」即可加上這個欄位。
- 產生 AI 筆記時，進度視窗會在該篇顯示 ⚠️，例如「掃描版 PDF（沒有文字層），AI 只讀了摘要與劃線」或「沒有 PDF 全文，AI 只讀了摘要」。
- **掃描版 PDF 直接傳給 AI 讀**（設定，預設開啟）：`none` 或 `partial` 的 PDF 會把檔案本身傳給 AI，由 AI 看每一頁的影像（Claude；OpenAI 官方 API 也支援，使用自訂 API base URL 時不傳）。上限 20 MB、100 頁（低於 Claude API 的 32 MB 請求上限與 200k context 模型的 100 頁上限），超過就改用摘要與劃線並在進度視窗說明；上限可在 Zotero 的進階設定（Config Editor）修改 `extensions.zotero-bridge.llm.pdfMaxMB`、`extensions.zotero-bridge.llm.pdfMaxPages`。API 仍拒絕這份 PDF 時（例如頁數超過模型上限），會自動改用摘要與劃線重跑一次。
  - **比較耗 token**：每一頁都會轉成影像送給 AI 計費，比只送文字貴得多，頁數越多越明顯。批次確認視窗的預估費用是依過去呼叫的平均用量估算，遇到掃描檔可能**低估**。
  - AI 讀的是頁面影像，插件沒有文字可以比對，所以「可引用的句子」中在摘要與劃線裡也找不到的句子會標 ⚠️ 無全文可查證（不是 ✅ 也不是「未在全文中找到」），請自行對照原文。
- **比較省錢的做法是讓 PDF 有文字層**：用 OCR 工具（例如 [OCRmyPDF](https://ocrmypdf.readthedocs.io/)：`ocrmypdf --language eng+chi_tra 掃描.pdf 輸出.pdf`，或 Adobe Acrobat 的「辨識文字」）處理後放回 Zotero 取代原檔，或從出版社／資料庫重新下載有文字的版本。Zotero 重新建立全文索引後（必要時在附件上按右鍵 → 重新索引項目），再「重新產生 AI 筆記」即可。
- **沒有東西可讀就不呼叫 AI**：沒有全文、沒有傳 PDF、沒有摘要，也沒有劃線或筆記時，插件會略過這篇的 AI 筆記（進度視窗顯示原因），避免 AI 只憑標題編出內容；Notion／Obsidian 仍照常同步。
- 「全文最多送出字元數」設成 0 時，表示你選擇不送全文，插件也不會傳 PDF，也不顯示上述提示。

### 圖片劃線（表格、圖）

護理研究的主要結果常在表格和圖裡。在 Zotero 的 PDF 閱讀器用「選取區域」框選表格或圖（圖片劃線），或用手繪工具畫記（手繪註記），同步時會一起帶出截圖：

- **Obsidian**：截圖存到筆記所在資料夾底下的 `attachments/`，檔名是 `<條目KEY>-<註記KEY>.png`（例如 `Zotero/attachments/ABCD2345-EFGH6789.png`），依劃線順序嵌入筆記的 Annotations 區（`![[...]]`）：上方是顏色標記與頁碼連結，下方是你的評註。內容沒變時不會重寫檔案。用條目 KEY 命名，所以改了 citekey 或標題，截圖也不用改名。
- **刪除註記**：在 Zotero 刪掉圖片劃線後再同步到 Obsidian，對應的截圖會從 `attachments/` 刪除。插件只刪「這篇文獻的 `條目KEY-註記KEY.png`」格式的檔案，你自己放在 `attachments/` 的圖片和其他文獻的截圖都不會動；關閉「匯出圖片劃線」後也不會再刪任何檔案。把筆記搬到別的資料夾後，舊資料夾 `attachments/` 裡的截圖不會跟著搬，可以自行刪除。
- **Notion**：截圖用 Notion 的檔案上傳 API 上傳，成為自動同步區裡的圖片區塊。上傳的檔案若沒有馬上放進頁面，一小時後就會失效，而自動同步區每次同步都會整個重建，所以**每次同步到 Notion 都會重新上傳**（每張圖多 2 次 API 請求）。單一檔案上限 20 MB（Notion 免費方案為 5 MB）；上傳失敗時頁面照常同步，只是少了圖片，進度視窗會顯示 ⚠️。
- **截圖從哪來**：Zotero 會快取每個圖片／手繪註記的截圖。沒有快取時（例如在另一台電腦劃的線剛同步過來），插件會請 Zotero 當場從 PDF 產生；產生不了（例如這台電腦沒有 PDF 檔）時，進度視窗會顯示 ⚠️，筆記保留顏色、頁碼與評註（Obsidian 裡上次同步的截圖會繼續沿用）。
- **AI 也看圖片劃線**（設定 → AI 文獻筆記，預設關閉）：產生 AI 筆記時把截圖一起傳給 Claude，讓它讀表格裡的數字。每張圖都會增加 token 用量；一次最多 20 張，單張超過約 3.7 MB 或 8000 像素的會略過。OpenAI 模式不會送圖片。不論是否開啟，圖片劃線的評註文字都會送給 AI。
- **不想要截圖**：設定 → Obsidian 取消「匯出圖片劃線」，就和以前一樣只有文字說明。

### 文獻比較表

1. 選取 2 篇以上的文獻（或在分類上按右鍵），選 **產生文獻比較表（AI）**。
2. 產出位置：
   - Obsidian：`Zotero/文獻比較/文獻比較：<分類>（N 篇） <日期時間>.md`
   - Zotero：獨立筆記（標籤 `zotero-bridge-synthesis`），放在該分類並關聯所有來源文獻
   - Notion：在設定填入「文獻比較表的 Notion 父頁面」後，建立成該頁面的子頁面（父頁面也要分享給 integration）
3. 建議先替各篇產生 AI 筆記，比較表會更完整。一次最多 60 篇，每次會產生一次 API 費用。
4. 比較表的格式可以在設定的「文獻比較表模板」修改。

### 系統性／範圍回顧篩選

做 systematic review 或 scoping review 時，可以直接在 Zotero 篩選，再產生 PRISMA 2020 流程圖與證據表。一個回顧專案就是一個 Zotero 分類（含子分類），把各資料庫匯出的文獻都匯入這個分類。

**1. 標記資料庫來源（選用）**：匯入時替文獻加上標籤 `來源/PubMed`、`來源/CINAHL`…（可以在匯入後全選該批文獻，拖到左下角標籤選擇器的標籤上）。沒有來源標籤時，使用條目的「圖書館目錄」（Library Catalog）欄位（從 PubMed 匯入的就是「PubMed」）。

**2. 找重複**：在分類上按右鍵 → **Zotero Bridge：系統性回顧篩選 → 找出可能重複的文獻並標記**。比對 DOI，再比對「標題（忽略大小寫、標點、重音）＋年份」；兩筆有不同 DOI 的不會因為標題相同而被當成重複（例如勘誤）。確認後，每組保留一筆（優先保留已篩選、有 DOI、有摘要、有附件、較早加入的），其餘加上標籤 `篩選/重複`。插件**不會合併或刪除條目**；要合併請用 Zotero 左側的「重覆的項目」（Duplicate Items）。合併後 Records identified 會跟著減少，建議 PRISMA 計數定案後再合併，或保留標記不合併。標錯了直接刪掉標籤即可。

**3. 篩選**：選取一篇或多篇文獻 → 右鍵 → **Zotero Bridge：篩選（系統性／範圍回顧）**：

| 選項 | 標籤 |
|---|---|
| 標題摘要：納入／排除／待定 | `篩選/標題摘要/納入`、`篩選/標題摘要/排除`、`篩選/標題摘要/待定` |
| 全文：納入 | `篩選/全文/納入` |
| 全文：排除（選擇原因） | `篩選/全文/排除` ＋ `排除原因/<原因>` |
| 全文：無法取得全文 | `篩選/全文/無法取得`（PRISMA 的 Reports not retrieved） |
| 標記為重複／清除篩選決定 | `篩選/重複`／移除以上所有篩選標籤 |

- 以最新的決定為準：設定全文決定時會一併記為「標題摘要：納入」；改成「標題摘要：排除」時會移除全文決定與排除原因。每篇只保留一個排除原因（PRISMA 每篇只計一個主要原因）。
- 逐篇看摘要時，右側面板「AI 文獻筆記」區塊最上方有一列「篩選：…」，顯示目前的決定，並有「納入／排除／待定」按鈕（標題摘要階段）。開始篩選後所有文獻都會顯示這一列。
- 因為是標籤，可以用左下角標籤選擇器篩出「還沒篩的」「全文納入的」，也可以替標籤指定顏色、用數字鍵快速標記（用數字鍵加標籤時舊的決定不會自動移除，同一階段有兩個決定的文獻會列在一致性檢查中）。
- 篩選標籤不會觸發自動同步（避免一次標幾百篇就同步幾百次）；下次同步時標籤才會帶到 Notion 與 Obsidian。
- 排除原因在 設定 → 系統性／範圍回顧篩選 修改（一行一個；內建：族群不符、介入不符、結果指標不符、研究設計不符、非全文／研討會摘要、語言不符、重複發表）。標籤前綴也可以改；改了之後舊標籤不會自動改名。

**4. 產生 PRISMA 流程圖與證據表**：在分類上按右鍵 → **Zotero Bridge：系統性回顧篩選 → 產生 PRISMA 流程圖與證據表**（或先選取分類，再用 工具 → 產生 PRISMA 流程圖與證據表（目前分類））。產出：

- Obsidian：`Zotero/Reviews/<分類名稱>.md`
  - **PRISMA 2020 計數**：Records identified（各資料庫分列）、Duplicate records removed、Records screened、Records excluded、Reports sought for retrieval、Reports not retrieved、Reports assessed for eligibility、Reports excluded（各原因分列）、Studies included in review；frontmatter 也有 `prisma_identified`、`prisma_included` 等數字
  - **PRISMA 2020 流程圖**：Mermaid 圖（Obsidian 直接顯示），還沒篩完的會以虛線框標出
  - **一致性檢查**：例如有全文決定但標題摘要不是納入、全文排除但沒有原因、有多個原因、重複文獻卻有篩選決定、同時有衝突的決定；每項列出文獻並可點回 Zotero
  - **證據表**：每篇全文納入的研究一列（研究設計、樣本數、場域／國家、族群、介入／對照、結果指標、證據等級、JBI 評讀），資料來自各篇 AI 筆記的結構化資料，文獻欄連回文獻筆記。還沒有 AI 筆記的研究欄位留空並列在一致性檢查中：先對納入的文獻執行同步產生 AI 筆記，再重新產生。
- CSV：`Zotero/Reviews/<分類名稱> 證據表.csv`（UTF-8 BOM，Excel 直接開啟不會亂碼），欄位比筆記多（作者、標題、期刊、DOI、對照、測量工具、評讀工具…），方便整理成論文的表格。
- Notion（選用）：在設定填入「PRISMA 頁面的 Notion 父頁面」（留空時使用文獻比較表的父頁面）後，建立成該頁面的子頁面，含真正的表格與 Mermaid 流程圖。

重新產生時只覆寫 `%% zotero-bridge:start %%` 到 `%% zotero-bridge:end %%` 之間與插件的 frontmatter 欄位；你寫在區塊外與「✍️ 我的筆記」的內容會保留。Notion 頁面也一樣：只替換最上方提示文字到「✍️ 我的筆記」標題之間的內容，同一個分類一直更新同一頁（頁面被刪除時會建立新頁）。

注意：
- 同一篇文獻在 Zotero 只有一組標籤，放在兩個回顧專案的分類裡會共用篩選決定；兩個回顧需要各自的決定時，請用不同的文獻庫（例如群組文獻庫）。
- 流程圖是新的 systematic review、只檢索資料庫與登錄庫（databases and registers）的版本；有其他來源（引文追蹤、網站）時，請依 PRISMA 2020 範本自行補上右側的欄位。插件無法分辨同一研究的多篇報告，「Studies included」與「Reports of included studies」顯示相同數字，需要時請手動修改。
- 計數是依標籤計算，請在投稿前對照一致性檢查確認。

### 在 Zotero 裡看 AI 筆記

選取一篇文獻，右側面板的「AI 文獻筆記」區塊會顯示一句話摘要與各段重點；收合時標題列會顯示摘要。還沒有 AI 筆記時，可以直接按「產生 AI 筆記並同步」。區塊最上方的「閱讀狀態」選單可以直接改這篇的閱讀狀態。

### 閱讀狀態同步

閱讀狀態（待讀／閱讀中／已讀／已引用）在三個地方都看得到，哪邊方便就在哪邊改：

| 地方 | 存在哪裡 | 怎麼改 |
|---|---|---|
| Zotero | 標籤 `狀態/已讀 ✅`（每篇只留一個） | 右側面板「AI 文獻筆記」區塊的「閱讀狀態」選單，或直接改標籤 |
| Notion | `Status` 欄位（單選） | 在資料庫改 Status |
| Obsidian | frontmatter 的 `status` | 在「閱讀進度」看板拖曳卡片，或直接改 `status` |

- **什麼時候同步**：每次一般同步（手動、批次、自動同步）都會比對三邊。自動同步只在 Zotero 有變更時觸發，所以在 Notion／Obsidian 改的狀態會在下一次同步時帶回；想一次更新全部，用 **工具 → 同步閱讀狀態**：只比對、更新已同步過的文獻的閱讀狀態（不呼叫 AI、不改筆記其他內容、不新增 Notion 頁面）。
- **以哪邊為準**：插件會記住上次三邊一致的狀態（Obsidian 筆記的 `status_synced`；沒有設定 Obsidian 時記在 Zotero 設定裡）。只有一邊改過時，以那一邊為準；同一篇在不同地方改成不同狀態時，依 **Obsidian > Zotero > Notion** 採用，並在進度視窗顯示「⚠️ 閱讀狀態衝突」。自動同步是在 Zotero 一有變更就執行，所以自動同步時改以 Zotero 優先（並跳出提示）。沒辦法用修改時間判斷誰比較新：Notion 頁面、筆記檔案和 Zotero 條目的修改時間在改任何內容時都會更新，不只是改狀態。
- **舊版同步過的文獻**：第一次同步時以 Obsidian 筆記原本的 `status` 為準（例如你在看板拖到「已讀」的不會被改回「待讀」），再補上 Zotero 標籤和 Notion 的 Status。
- **只同步到 Obsidian／只同步到 Notion** 時，沒有選的那邊不會更新，下次一般同步再補上。
- **已刪除**：移到 Zotero 垃圾桶的文獻不會被狀態同步恢復；Obsidian 的「已刪除」狀態只由插件設定，在其他地方改成「已刪除」不會同步出去。
- **Zotero 標籤**：前綴可以在 設定 → 閱讀狀態 修改（改了之後舊標籤不會自動改名）。標籤含 emoji 時（預設：閱讀中 📖、已讀 ✅、已引用 📝；待讀不加），Zotero 會把 emoji 顯示在條目清單的標題旁，一眼就看得出讀到哪。也可以在左下角標籤選擇器對狀態標籤按右鍵 → **指定顏色**，之後選取文獻按數字鍵就能加上該狀態；同時有兩個狀態標籤時，插件同步時會留下新加的那個。
- **Notion 為什麼用「單選」而不是 Notion 的「狀態」欄位類型**：Notion API 無法把選項放進「待處理／進行中／完成」分組，頁面也不能填入還不存在的狀態選項；單選則可以接受任何值（例如你在 Obsidian 自訂的狀態）。資料庫原本就有名為 `Status` 的「狀態」類型欄位時，插件不會動它，進度視窗會提示你改名後再按「測試連線並補齊資料庫欄位」。
- 不想同步閱讀狀態：設定 → 閱讀狀態，取消勾選即可（Zotero 不會再加標籤）。

選「同步到兩邊」但只設定了其中一邊時，沒設定的那邊會自動略過。某一步失敗（例如 AI 逾時）時，其他步驟照常完成，錯誤會顯示在進度視窗與 `說明 → 除錯輸出記錄`。

### Obsidian 1.14 搭配功能

- **彩色劃線**：Zotero 的劃線顏色會轉成 Obsidian 1.14 的彩色 highlight，例如 `==🟡Falls decreased by 30%==`。Zotero 的洋紅色對應紫色，灰色對應主題預設色（Obsidian 只有六種顏色）。同步到 Notion 時也會轉成對應的背景色。
- **Bases 文獻總表**（`Zotero 文獻庫.base`，核心外掛 Bases，不需要 Dataview）：
  - 「文獻總表」：表格，列出標題、作者、年份、期刊、研究設計、樣本數、證據等級、閱讀狀態、分類
  - 「閱讀進度」：1.14 新增的看板（kanban），依 `status` 分成 待讀／閱讀中／已讀／已引用。把卡片拖到別欄就會改筆記的 `status`，下次同步時 Zotero 標籤與 Notion 的 Status 也會跟著改（見[閱讀狀態同步](#閱讀狀態同步)）
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
- `/review-prisma`：讀系統性回顧的 PRISMA 筆記，檢查篩選進度並寫 PRISMA 流程與納入研究特徵的段落

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
| `content/scanned.js` | 掃描版 PDF：全文狀態判斷（`full_text`）、傳 PDF 給 AI、沒有內容時略過 AI |
| `content/secrets.js` | API key／Notion token 存取（Gecko 密碼管理員） |
| `content/usage.js` | AI 用量月報、價格表與費用估算 |
| `content/notion.js` | Notion API（2025-09-03，data sources） |
| `content/status.js` | 閱讀狀態在 Zotero 標籤、Notion Status、Obsidian `status` 之間的合併與同步 |
| `content/core.js` | Obsidian 筆記組裝、frontmatter 合併、分流規則 |
| `content/markdown.js` | Markdown ⇄ Notion blocks ⇄ HTML |
| `content/synthesis.js` | 跨文獻比較表：提示詞、引文轉換、APA 參考文獻 |
| `content/export.js` | 參考文獻檔匯出（CSL JSON／BibTeX）與 citekey 產生 |
| `content/screening.js` | 系統性／範圍回顧篩選：篩選標籤、找重複、PRISMA 2020 計數與一致性檢查、Mermaid 流程圖、證據表（Obsidian／CSV／Notion） |
| `content/annotation-images.js` | 圖片劃線與手繪註記：取得 Zotero 截圖、複製到 vault、上傳到 Notion、傳給 Claude |
| `research-brain/` | Claude Code／Codex 研究大腦設定檔 |
| `site/index.html` | 安裝精靈網頁（GitHub Pages） |

發布新版本：修改 `manifest.json` 的 `version` → `npm run build` → 推送到 `main`，GitHub Actions 會自動建立 Release，Zotero 會自動更新。
