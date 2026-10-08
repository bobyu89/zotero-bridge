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
- **中文文獻用中文 APA**：中文期刊、學位論文自動改用中文 APA 7（`陳美玲、林小華（2023）。題目。護理雜誌，70(2)，45–56。`、內文「陳美玲等，2023」），中文文獻可排在英文前（見[中文文獻與中文 APA](#中文文獻與中文-apa)）。
- **分流規則**：例如「群組文獻庫 → 團隊 Notion DB」、「我的文獻庫／碩論 → 碩論 DB + `Zotero/碩論` 資料夾」。
- **雙向連結**：Notion 頁面有 `Obsidian` 欄位（`obsidian://` 連結）；Obsidian 筆記的 frontmatter 有 `notion` 連結，也有開回 Zotero 的連結；每條劃線都能點回 PDF 的原位置。
- **圖片劃線（表格、圖）**：在 PDF 閱讀器框選的圖片劃線與手繪註記，會連同 Zotero 產生的截圖一起同步：Obsidian 嵌入筆記、Notion 成為圖片區塊；也可以讓 Claude 讀這些截圖（見[圖片劃線](#圖片劃線表格圖)）。
- **重新同步不會蓋掉你的內容**：
  - Obsidian：只覆寫 `%% zotero-bridge:start %%` 到 `%% zotero-bridge:end %%` 之間的區塊；你自己加的 frontmatter 欄位（例如 `status`、`aliases`）和區塊外的內容都會保留。
  - Notion：只替換標題為「📚 Zotero Bridge｜…」的那個 callout 區塊，頁面上的其他內容保留。
  - 改了 Citation key 或標題：插件靠 frontmatter 的 `zotero_key` 找到原本的筆記，直接改檔名並更新，不會多出一份新筆記。你把筆記移到預設／規則資料夾底下的其他子資料夾也找得到（之後會留在那裡，不會被搬回去）。新檔名已被另一篇文獻使用時，改用 `檔名 (條目KEY)`。
- **跨文獻比較表**：選多篇文獻或整個分類 → AI 讀各篇的 AI 筆記（沒有的改用摘要與劃線），產生文獻比較表、主題整理、方法學品質、研究缺口。引文由 Zotero 書目轉換（不讓 AI 自己寫參考文獻），Obsidian 版會連回各篇文獻筆記，並附 APA 7 參考文獻。同時存成 Notion 頁面（含真正的表格）、Obsidian 筆記和 Zotero 獨立筆記。
- **實證健康照護報告草稿**：依台灣護理學會 A 類實證健康照護綜整文章的架構，把納入研究寫成報告草稿：PICO 表、搜尋策略、PRISMA 流程圖與證據表由插件依你的資料產生，AI 撰寫敘述與逐篇評讀（沿用 AI 筆記的嚴格評讀），附查核清單與評分項目自我檢核（見[實證健康照護報告草稿](#實證健康照護報告草稿)）。
- **系統性／範圍回顧篩選（PRISMA 2020）**：在 Zotero 用右鍵或右側面板標記標題摘要與全文的納入／排除（排除原因可自訂），找出可能重複的文獻，一鍵產生 PRISMA 2020 計數、Mermaid 流程圖與納入研究的證據表（Obsidian 筆記 + Excel 可開的 CSV，可選 Notion 頁面），並檢查計數是否一致（見[系統性／範圍回顧篩選](#系統性範圍回顧篩選)）。
- **PubMed 新文獻追蹤**：儲存 PubMed 檢索式（可用 MeSH），手動或定期把新發表的文獻匯入指定的 Zotero 分類（用 Zotero 內建匯入器，書目完整、不會重複匯入），並在 Obsidian 產生每日新文獻清單（見[PubMed 新文獻追蹤](#pubmed-新文獻追蹤)）。
- **研究儀表板**：Obsidian 裡的一頁 `研究儀表板.md` 總覽閱讀進度（Mermaid 圓餅圖、各分類完成率）、研究設計與證據等級分布、待讀最久與資料待補的文獻、回顧專案的 PRISMA 納入篇數、AI 用量與本週新增；另有 `研究儀表板.base` 的證據等級表、掃描檔待 OCR、依分類的待讀清單（見[研究儀表板](#研究儀表板)）。
- **引文追蹤（Citation searching）**：從納入研究用 OpenAlex（免費、不需 API key）查參考文獻與引用它的文獻，和文獻庫比對去重後列成 Obsidian 勾選清單與 CSV；勾選的再一鍵匯入 Zotero，PRISMA 流程圖自動加上「其他方法」欄（見[引文追蹤](#引文追蹤citation-searching)）。
- **醫學文獻快速搜尋**：內建 PubMed、Cochrane、CINAHL、Embase、Google Scholar、華藝、臺灣博碩士論文等 21 個資料庫（可自訂）。條目右鍵「在醫學資料庫搜尋」一鍵找這篇（有 PMID 直接開啟、PubMed 相似文獻）；右側面板與 Obsidian／Notion 筆記附上搜尋連結、MeSH 連結和由 AI 筆記 PICO 組成的檢索式；工具選單輸入關鍵字即可選資料庫開啟，英文關鍵字會建議 MeSH 主題詞，檢索式可存成 PubMed 追蹤。可設定學校的 EZproxy 前綴（見[醫學文獻快速搜尋](#醫學文獻快速搜尋)）。
- **Zotero 內直接看 AI 筆記**：條目右側面板新增「AI 文獻筆記」區塊，顯示摘要與重點，並有「同步」「重新產生」按鈕。
- **批次同步可中途停止、之後接續**：同步很多篇時可以從工具選單停止；Zotero 關閉或當掉也不會從頭來過，失敗的文獻可以一鍵重試。
- **閱讀狀態三邊同步**：在 Zotero（標籤）、Notion（`Status` 欄位）或 Obsidian（看板拖曳）任一邊改閱讀狀態，下次同步時另外兩邊會跟著改（見[閱讀狀態同步](#閱讀狀態同步)）。
- **自動同步（選用）**：條目、劃線或筆記變更後，自動同步到兩邊。自動同步不會呼叫 AI。
  - 條目移到 Zotero 垃圾桶或刪除時：Notion 頁面移到 Notion 的垃圾桶；Obsidian 筆記**不會刪除**，只把 `status` 改成「已刪除」，並在自動同步區塊最上方加一段提示。從 Zotero 垃圾桶還原後再同步，筆記會恢復原本的閱讀狀態（Notion 會建立新頁面，舊頁面留在 Notion 垃圾桶）。
- **參考文獻檔（Pandoc）**：把文獻庫匯出成 vault 裡的 `Zotero/references.json`（CSL JSON），條目 id 就是筆記的 `citekey`。在 Obsidian 用 `[@citekey]` 寫論文，再用 Pandoc 產生 APA 7 的 Word 檔（見[下方說明](#在-obsidian-寫論文並用-pandoc-產生-apa-word)）。

## 安裝（從 GitHub 下載）

> 🧭 **第一次安裝？用 [安裝精靈](https://bobyu89.github.io/zotero-bridge/) 一步一步完成**：依你的電腦、AI 服務商、同步目的地（Notion／Obsidian）調整步驟，每步打勾確認，進度會記住。
>
> 🔎 要找文獻：[醫學文獻快速搜尋](https://bobyu89.github.io/zotero-bridge/search.html)（PubMed、CINAHL、Cochrane、華藝、臺灣博碩士論文…一次開啟，含 PICO 檢索式產生器）。

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
- **大量產生 AI 筆記時使用批次 API**（預設關閉，只適用 Claude）：一次要替很多篇（預設 10 篇以上）產生 AI 筆記時，可改用約半價的批次 API，見[省錢：批次 API 與提示快取](#省錢批次-api-與提示快取)。
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

### 省錢：批次 API 與提示快取

一次替 20–60 篇產生 AI 筆記時，有兩個省錢機制（都只適用 Claude）：

**提示快取（prompt caching，自動，不用設定）**

- 每篇筆記的請求開頭都一樣：筆記模板（system prompt，含嚴格評讀規則）＋結構化資料（JSON）的說明，合計約數千 tokens。外掛把這段標成可快取，**每篇文獻的書目、摘要、全文、註記、PDF、圖片都放在快取點之後**，所以連續產生多篇時，後面幾篇的開頭改用快取讀取計費（Claude Opus 5.5 為一般輸入的 5%，其他模型多為 10%）；第一次寫入快取要多付 25%（5 分鐘快取）。
- 快取約 5 分鐘內有效（每次讀取會重新計時），逐篇產生時通常一路命中。文獻比較表、文獻探討草稿等其他 Claude 呼叫也會快取各自的 system prompt。
- 開頭太短不會被快取（沒有錯誤，也不會多收費）：最短長度依模型而定，Claude Opus 5.5／Sonnet 5.5 為 512 tokens，較舊的模型 1024–4096 tokens（例如 Haiku 4.5 要 4096）。內建模板夠長；若自訂一個很短的模板又用舊模型，可能就不會快取。
- 「本月 AI 用量」會顯示快取讀取／寫入的 tokens 與「提示快取：省下約 US$…」。

**批次 API（Message Batches，設定 → AI 文獻筆記 → 「大量產生 AI 筆記時使用批次 API（約半價，最長 24 小時）」，預設關閉）**

- 開啟後，手動同步時若需要產生 AI 筆記的文獻達門檻（預設 10 篇，可在設定調整），確認視窗會同時列出**一般模式與批次 API 的預估費用**，讓你選「批次 API（約半價）」「一般模式（立即產生）」或取消。
- 選批次：外掛把每篇的請求（與一般模式送出的內容相同，含掃描版 PDF 與圖片劃線）打包成一個批次送出，**所有 tokens（含快取讀寫）都是一般價格的 50%**。不需要 AI 的文獻（已有 AI 筆記、沒有內容可讀）照常立即同步。
- 批次通常 1 小時內完成，最長 24 小時。外掛每 2–5 分鐘自動檢查一次；**Zotero 關閉也沒關係**，批次記在設定裡，下次開啟會繼續檢查。
- 完成後：成功的文獻依一般流程寫入 AI 子筆記（結構化資料、可引用句查證），記入用量（批次價格），再自動「同步但不呼叫 AI」到 Notion／Obsidian，並跳出通知。
- 失敗的文獻（請求錯誤、超過 24 小時、取消、模型拒絕處理）會列在進度視窗，並加入「中途停止與接續」的清單：**工具 → 繼續未完成的 Zotero Bridge 同步** 會用一般模式重試（一般模式在模型拒絕時可改由建議模型處理，批次 API 不支援這個 fallback）。
- **工具 → 檢查 AI 批次進度**：立即查詢並顯示每個批次的進度（已完成幾篇、等了多久、最晚何時結束）。
- **工具 → 取消 AI 批次**：已完成的仍會寫入；尚未處理的不收費，列入接續清單。
- 批次請求使用 1 小時的快取（Anthropic 文件建議，因為批次可能超過 5 分鐘），寫入費為一般輸入的 2 倍（再打五折）；批次中的快取命中是盡力而為，不保證。
- **OpenAI 不支援**：選 OpenAI 時一律用一般模式（OpenAI 也有自動的提示快取，外掛不需設定）。
- 「本月 AI 用量」會分開列出「批次 API：N 次呼叫，比一般模式省下約 US$…」，模型明細標示「（批次）」。

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

### 文獻探討草稿

把一個分類（或選取的文獻）寫成論文「文獻探討」章節的**草稿**，引文直接是 Pandoc 格式，可以轉成 APA 7 的 Word 檔。

1. 在分類上按右鍵（或選取 2 篇以上的文獻），選 **產生文獻探討草稿（AI）**。
2. 在對話框填：
   - **研究問題／目的**：用在最後一節「文獻小結與研究缺口」，說明你的研究要回應哪些缺口。
   - **主題大綱**：每行一個小節，依論文章節順序；留空則由 AI 自行歸納 3–6 個主題。
   兩欄都會記在這個分類，下次重新產生時自動帶出（在分類裡選取部分文獻時，第一次會沿用分類的大綱）。
3. 確認預估費用後送出（一次 API 呼叫；費用依篇數與筆記長度而定，會記入「本月 AI 用量」）。
4. 產出：
   - **Obsidian**：`Zotero/Drafts/文獻探討-<分類>.md`。引文是 `[@citekey]`、`[@a; @b]`，citekey 和 `references.json`、各篇文獻筆記的 `citekey` 相同；文末有「⚠️ 查核清單」與可直接複製的「Pandoc 指令」。產生時會檢查 `references.json`，缺少引用的文獻就自動重新匯出。
   - **Notion**：設定了「文獻比較表的 Notion 父頁面」時，建立子頁面，引文是一般文字（例如 (Chen & Smith, 2024)），附 APA 參考文獻與查核清單；重新產生時更新同一頁。
5. 轉成 Word：在 `Zotero/Drafts` 資料夾開終端機，執行筆記裡的指令，例如

   ```bash
   pandoc 文獻探討-碩論.md --citeproc --bibliography ../references.json --csl ../../apa.csl --lua-filter zotero-bridge-draft.lua -o 文獻探討-碩論.docx
   ```

   `apa.csl` 放在 vault 根目錄（見下方〈在 Obsidian 寫論文並用 Pandoc 產生 APA Word〉）。`zotero-bridge-draft.lua` 由插件放在同一資料夾，轉檔時略過 `%%` 標記、提示框、查核清單、指令與「我的筆記」。

**AI 怎麼寫、插件怎麼把關**

- 優先使用各篇的 AI 文獻筆記（含研究設計、樣本數、證據等級、嚴格評讀結果）；沒有 AI 筆記的文獻改用摘要與劃線。先替各篇產生 AI 筆記，草稿會好很多。
- AI 只能用 `[S1]`、`[S2]` 代號引用，由插件換成真正的 citekey，AI 不會自己寫作者、年份或參考文獻。清單外的代號（例如 `[S9]`）不會被刪掉，而是在草稿中標成 **【⚠️ 未知來源 S9】** 並列入查核清單。
- 草稿裡的數字（樣本數、百分比、p 值、效應量）會和所引用文獻的 AI 筆記、結構化資料、摘要與劃線比對；找不到的句子列在「⚠️ 查核清單」，插件不會改動內文。比對的不是 PDF 全文，所以「沒列出」不等於「正確」。
- **重新產生**只會覆寫 `%% zotero-bridge:start %%` 到 `%% zotero-bridge:end %%` 之間；標記外你自己加的段落、「✍️ 我的筆記」和自訂的 frontmatter 欄位都會保留。要修改草稿內容，請複製到標記外或你的論文檔再改。

> ⚠️ **這是草稿，不是可以直接交出去的文獻探討。** AI 可能誤解研究結果、把結論套到錯誤的文獻、遺漏重要研究或寫出過度概括的句子；查核清單只能抓到部分數字問題。每一句話、每個數字與每個引用都必須對照原文確認，並改寫成你自己的論述（也請遵守學校對 AI 使用的規定）。

### 實證健康照護報告草稿

依台灣護理學會「實證健康照護」A 類綜整文章的架構，把納入的研究寫成一份**實證報告草稿**（Obsidian 筆記，引文是 Pandoc 格式，可轉 Word；可選 Notion 頁面）。

1. 在分類上按右鍵（或選取要評讀的文獻），選 **Zotero Bridge → 產生實證健康照護報告草稿（AI）**。
   - 分類裡有篩選標籤（見下方〈系統性／範圍回顧篩選〉）時，只用**全文納入**的研究；還沒有全文納入的研究會先提醒你。
   - A 類文章重在「少而精、逐篇深度評讀」，撰寫指引的理想組合是 1 篇系統性回顧 + 2 篇 RCT。
2. 在對話框填（會記在這個分類，下次自動帶出）：
   - **案例情境**：病人的年齡、診斷、治療狀況，以及病人實際說的話（用「」）。AI 只會引用這裡的病人原話，不會自己編造；沒有原話的地方會標〔待補〕。
   - **PICO**：各篇 AI 筆記的 PICO 一致時自動帶入；不一致的欄位留空，並列出各篇的寫法供參考。
   - **問題類型**：治療／預後／診斷／病因（傷害）／質性；決定用 Oxford CEBM 2011 的哪一欄判定證據等級。
   - **文獻搜尋**：分類有篩選標籤時，資料庫與篇數、「搜尋結果與篩選」由 PRISMA 2020 計數帶入（每次重新計算）；有 PubMed 追蹤匯入這個分類時，帶入它的檢索式；都沒有時，依 PICO 組一個檢索式，標明「尚未實際檢索」。限制條件與搜尋日期請自己填。
3. 確認預估費用後送出（一次 API 呼叫，記入「本月 AI 用量」）。
4. 產出 `Zotero/Drafts/實證報告-<分類>.md`（frontmatter `type: ebhc-report`），依序為：題目、中英文摘要、前言、方法（一、形成臨床提問與 **表一 PICO 關鍵字表**；二、文獻搜尋：資料庫、檢索式、限制條件、搜尋日期、篩選結果與 **圖一 PRISMA 流程圖**；三、文獻評讀：**表二 證據表** 與逐篇評讀）、證據綜整、臨床應用（套用到你的案例：病人價值觀、臨床情境、可行性）、結論與建議、參考文獻，文末是「⚠️ 查核清單」「📋 評分項目自我檢核」與 Pandoc 指令。轉 Word 的方式同文獻探討草稿（`--lua-filter zotero-bridge-ebhc.lua`；流程圖在 Word 裡會換成「請插入圖一」的提示，請從 Obsidian 匯出圖片後貼上）。

**哪些是插件做的、哪些是 AI 寫的**

- **插件依你的資料產生、不經 AI**：表一（PICO；同義字與 MeSH 欄留〔待補〕）、搜尋策略、PRISMA 計數與流程圖、表二證據表（研究設計、樣本數、CEBM 證據等級、評讀工具、整體評讀、主要發現，取自各篇 AI 筆記的結構化資料與一句話摘要）、參考文獻（中文文獻用中文 APA）。
- **AI 撰寫敘述**：只能用 `[S1]`、`[S2]` 代號引用，由插件換成 citekey；逐篇評讀沿用各篇 AI 筆記裡的嚴格評讀（JBI 或 CASP 清單逐題結果），不能自己增刪題目或改答案；資料沒有的數字、病人原話或參數一律寫〔待補〕；整體證據要說明確定性與限制，不可誇大。
- **查核清單**：數字和所引用文獻的 AI 筆記、摘要、劃線比對（摘要不放引用，改和全部文獻比對；你在對話框填的數字與插件算出的篇數視為有出處）；另外檢查缺少的章節、沒有逐篇評讀的文獻、PICO 缺項（例如 C）、資料庫是否含 Cochrane Library 與 PubMed、是否有 PRISMA 圖、評讀工具是否為撰寫指引要求的 CASP、問題類型與 CEBM 欄位、摘要與全文字數（粗估）、評讀者分工等。
- **評分項目自我檢核**：把撰寫指引的配分項目（題目 5、摘要 13、前言 5、PICO 10、文獻搜尋 20、文獻評讀 25、結論與建議 12、參考文獻 5）各自對應到草稿的段落與查核結果。**這不是評分**，也不代表能通過審查。

結構、各節寫法與配分整理自「A 類實證健康照護綜整文章發表準則暨撰寫指引（1141020 修訂版）」與已發表範例的寫作指南；學會的準則、評讀工具版本與評分表會更新，**請以台灣護理學會最新公告為準**。

> ⚠️ **這是草稿，不是可以直接投稿或繳交的實證報告。** 評讀結果來自 AI 筆記，可能答錯題或漏掉方法學問題；AI 可能誤解結果、把結論套到錯誤的文獻，或寫出過度概括的建議。每一題評讀、每個數字、每個引用都必須對照原文確認，搜尋策略與篇數要和你實際的搜尋紀錄一致，並以學會最新準則（含指定的評讀工具版本）重新檢查格式。也請遵守課程或期刊對 AI 使用的規定。

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
- 流程圖是新的 systematic review 版本。標籤為 `來源/引文追蹤`、`來源/網站`、`來源/機構` 的文獻（可在設定的「其他方法的來源」修改）算在右側「其他方法」（Identification of studies via other methods）欄：Records identified from（Citation searching、Websites、Organisations）→ Reports sought for retrieval → Reports not retrieved → Reports assessed → Reports excluded（各原因）→ 與左欄合計的 Studies included；frontmatter 另有 `prisma_other_identified`、`prisma_other_included` 等。這一欄沒有標題摘要篩選，直接給全文決定不會出現警告；若有重複或標題摘要排除，會多一個「Records excluded」框讓數字對得起來（PRISMA 範本沒有這個框，可自行刪除）。同時有資料庫來源標籤（例如 `來源/CINAHL`）的文獻算在左欄。插件無法分辨同一研究的多篇報告，「Studies included」與「Reports of included studies」顯示相同數字，需要時請手動修改。
- 計數是依標籤計算，請在投稿前對照一致性檢查確認。

### PubMed 新文獻追蹤

把常用的 PubMed 檢索式存起來，插件會定期查詢「上次檢查之後新加入 PubMed」的文獻，匯入 Zotero，並列成 Obsidian 清單讓你快速瀏覽。適合追蹤碩論主題的最新研究。

**1. 設定**：設定 → Zotero Bridge → **PubMed 新文獻追蹤** → 「新增追蹤」，填入：

| 欄位 | 說明 |
|---|---|
| 名稱 | 例如「跌倒預防」，會成為標籤 `追蹤/跌倒預防` |
| PubMed 檢索式 | 和 PubMed 網站一樣的完整語法，例如 `("Accidental Falls"[Mesh]) AND nurs*[tiab]`；可以先在 PubMed 網站調好再貼上 |
| 存到 Zotero 分類 | 留空 = `📥 新文獻/<名稱>`；可以填 `碩論/新文獻` 這類路徑，沒有的分類會自動建立 |
| 第一次檢查回溯天數 | 第一次檢查要匯入最近幾天加入 PubMed 的文獻（預設 30 天）；之後只查上次檢查以後的 |
| 只要出版日期在此之後（選填） | 例如 `2020` 或 `2023/01/01`，等於在檢索式加上出版日期限制 |

按「測試檢索式」可以看到符合篇數、最近幾天新增的篇數，以及 PubMed 怎麼解讀你的檢索式（拼錯的 MeSH 詞或欄位會顯示警告）。

同一區還有：
- **Email**：NCBI 要求程式附上聯絡信箱（只送給 NCBI）。建議填寫。
- **NCBI API key**（選填）：在 NCBI 帳號設定的 API Key Management 建立。沒有 key 時每秒最多查詢 3 次，有 key 為 10 次；插件會自動控制速度。key 存在 Zotero 的密碼管理員，不會寫進設定檔。
- **每個追蹤每次最多匯入**（預設 50 篇，最多 200）：超過的文獻排隊（最多 500 篇），下次檢查時繼續匯入。
- **自動檢查**（預設關閉）：Zotero 啟動約 2 分鐘後，以及之後每小時看一次，距離上次檢查超過設定的時數（預設 24 小時）的追蹤才會查詢。所以一天開關 Zotero 很多次也不會重複查詢。
- **每日新文獻清單**（預設開啟）、**手動檢查後產生 AI 筆記**（預設關閉，見下方）。

**2. 檢查**：工具 → **檢查新文獻（PubMed 追蹤）**（或設定頁的「立即檢查全部」）。進度視窗列出每個追蹤找到幾篇、新匯入幾篇、幾篇已在文獻庫。自動檢查不顯示進度視窗，有新文獻或發生錯誤時才跳出通知。

**3. 匯入的文獻**：
- 用 Zotero 內建的 PubMed 匯入器建立條目（和工具列「魔術棒」輸入 PMID 一樣），作者、期刊、卷期、摘要、DOI 都完整；Extra 欄會有 `PMID: …`。為了自動執行時不下載檔案，不會附加 PDF，需要時可以在條目上按右鍵，用 Zotero 的「尋找全文」（Find Full Text）取得。
- 加上標籤 `新文獻`、`追蹤/<名稱>`、`來源/PubMed`（`來源/` 前綴跟著系統性回顧篩選的設定，PRISMA 計數會算進 PubMed 來源）。看完後可以在標籤選擇器刪掉 `新文獻` 標籤，或改閱讀狀態。
- **不會重複匯入**：文獻庫已有相同 PMID（Extra）或相同 DOI 的條目時略過（算在「已在文獻庫」）；插件也會記得每個追蹤看過的 PMID，所以匯入後被你移到垃圾桶的文獻不會再回來。兩個追蹤找到同一篇時只匯入一次（標籤是第一個追蹤的）。
- 單篇匯入失敗時略過並在下次檢查重試，連續 3 次失敗就放棄（進度視窗會列出 PMID，可以用魔術棒手動加入）。某個追蹤的檢索式有誤或連不上 PubMed 時，該追蹤顯示錯誤、下次從原本的時間點重查，其他追蹤照常進行。

**4. Obsidian 每日清單**：有新文獻時寫入 `<預設子資料夾>/新文獻/YYYY-MM-DD.md`，依追蹤分段，每篇一行待辦項目：標題、期刊、年份，以及 Zotero（`zotero://select` 直接跳到條目）、DOI、PubMed 連結。同一天再檢查時只會加入新的文獻，**已勾選的項目和你在 `%% zotero-bridge:start/end %%` 區塊外寫的筆記都會保留**。

**5. AI 筆記（選用）**：勾選「手動檢查後為新文獻產生 AI 筆記並同步」後，手動檢查完會用一般的同步流程為新文獻產生 AI 筆記並同步到 Notion／Obsidian（超過 5 篇會先顯示費用預估並詢問）。**自動檢查一律不呼叫 AI**；開了「自動同步」時，新文獻會沿用一般的自動同步（不含 AI）。

注意：
- 依「加入 PubMed 的日期」（Entrez Date）查詢，所以晚一點才被收錄的舊文獻也會出現；只想要近年的研究請填「只要出版日期在此之後」。
- 匯入一律存到「我的文獻庫」。
- 檢索式改了之後，下次檢查仍從上次檢查的時間點開始；想重新回溯，可以刪掉這個追蹤再新增一次。
### 引文追蹤（Citation searching）

PRISMA 2020 要求報告「其他方法」找到的文獻，最常見的是引文追蹤：查納入研究的參考文獻（往回，backward）與引用它們的文獻（往前，forward）。插件用 [OpenAlex](https://openalex.org)（免費、不需 API key）查詢，**只列出候選清單，不會自動匯入**。

**1. 查詢**：全文篩選有了「全文：納入」之後，在回顧專案的分類上按右鍵 → **Zotero Bridge：引文追蹤 → 引文追蹤：全文納入的研究（OpenAlex）**（或先選取分類，再用 工具 → 引文追蹤：目前分類全文納入的研究）。也可以選取幾篇文獻 → 右鍵 → **Zotero Bridge：引文追蹤所選文獻（OpenAlex）**；左側有選分類時清單屬於該分類，沒有時存成「所選文獻 引文追蹤.md」。

- 以 DOI（或 Extra 欄的 `PMID: …`）找到該研究在 OpenAlex 的資料，再查它引用的文獻與引用它的文獻；兩者都沒有的研究會標示「沒有 DOI 或 PMID，無法查詢」。
- 查詢在背景進行（每秒最多 5 次請求），進度視窗顯示目前查到第幾篇，不會卡住 Zotero。每次最多 100 次請求，每篇研究每個方向最多 200 篇（依被引次數由高到低）；超過時會在筆記標示「已達上限」。可在 設定 → 引文追蹤（OpenAlex）調整，也可以只查往回或往前。
- 建議在設定填入 email：OpenAlex 會把帶 email 的請求放到回應較穩定的 polite pool（email 只會送給 OpenAlex）。
- CI 實測 2026-10-08：不需 API key 仍可使用；OpenAlex 的回應標頭顯示每個 IP 每天 1000 次請求的免費額度（插件每次最多 100 次）。用到的查詢方式（`works/doi:`、`works/pmid:`、`filter=cites:`／`cited_by:`、`select=`、`sort=cited_by_count:desc`、`per-page=200`、cursor 分頁、`mailto=`）都實際連線驗證過。

**2. 候選清單**：`Zotero/Reviews/<分類名稱> 引文追蹤.md`
- **查詢結果**：每篇納入研究找到幾篇參考文獻／被引文獻、有沒有查詢失敗
- **候選文獻**：不在文獻庫中的文獻，一篇一行的勾選清單（標題、年份、期刊、被引次數、← 來自哪篇研究的參考文獻／→ 引用了哪篇研究、DOI 連結）；同一篇從多篇研究找到只列一次，排在前面
- **總表**：全部找到的文獻，最後一欄標示「已在本回顧」或「已在文獻庫」（以 DOI、PMID，或標題＋年份（前後一年內）比對；兩筆 DOI 不同時不會因標題相同而視為同一篇）
- 同時產生 `<分類名稱> 引文追蹤.csv`（Excel 可直接開啟）
- 重新查詢只覆寫 `%% zotero-bridge:start %%` 區塊，已勾選的項目會保留勾選；「✍️ 我的筆記」不會被動到。

**3. 匯入勾選的文獻**：在 Obsidian 把要加入的文獻勾選（`- [x]`），回到 Zotero 選取分類 → 右鍵 **Zotero Bridge：引文追蹤 → 匯入引文追蹤勾選的文獻**（或 工具 → 匯入引文追蹤勾選的文獻）。
- 用 Zotero 內建的「依識別碼新增」（DOI／PMID）查詢書目資料，存進該分類，加上標籤 `來源/引文追蹤`；**不會加任何篩選標籤**，也不會下載 PDF（之後可用 Zotero 的「尋找可用的 PDF」）。
- 已在文獻庫中的會略過；匯入成功的那一行會加上「✅ 已匯入」，下次不會重複匯入。查不到的會列在進度視窗，可以手動加入。
- 只讀取插件區塊內勾選的項目；沒有 DOI／PMID 的候選文獻沒有勾選框，請手動加入。

**4. 篩選與 PRISMA**：匯入的文獻照常篩選（可直接給全文決定）。產生 PRISMA 流程圖時，`來源/引文追蹤` 的文獻會算在右側「其他方法」欄（Citation searching），納入的研究也會出現在證據表。網站、機構等其他來源的文獻請自行加上 `來源/網站`、`來源/機構` 標籤。

注意：OpenAlex 的資料並不完整（尤其是中文期刊與較舊的文獻），引文追蹤的結果請搭配原文參考文獻列表確認。

### 醫學文獻快速搜尋

把常用的醫學資料庫做成一鍵搜尋連結，不用每次開資料庫、貼題名或重打關鍵字。連結出現在四個地方：

**1. 條目右鍵 → 在醫學資料庫搜尋**：用這篇文獻找它在各資料庫的紀錄（找全文、看被引用、確認收錄）。
- PubMed：有 PMID（Extra 欄的 `PMID: …`）直接開啟該篇；沒有時用 DOI（`10.xxxx/…[doi]`），再沒有就用題名的每個字（`Hospital[ti] AND nurse[ti] AND staffing[ti] …`，最多 10 個字）。整句題名加引號（`"題名"[ti]`）在 PubMed 只比對片語索引，實測連原文題名都找不到，所以不用。
- Europe PMC 用 PMID／DOI／題名；CINAHL 用 `TI "題名"`；其他資料庫用加引號的題名。
- **PubMed 相似文獻**（有 PMID 時）：PubMed 的 Similar articles。
- 選單只列前 8 個（可在設定改成更少）；其他在「**更多資料庫…**」清單，選一個開啟後會回到清單，可以連續開好幾個，按取消結束。
- 中文題名只找中文與跨語言的資料庫（華藝、博碩士論文、國圖期刊、Google Scholar），排在前面。

**2. 條目右側面板**：「AI 文獻筆記」區塊最上方有一列搜尋連結（PubMed、Cochrane、CINAHL、Google Scholar…，以及相似文獻）。這篇有 AI 筆記且有 PICO 資料時，下一列是 **PICO 檢索連結**（PubMed、CINAHL、Google Scholar）和「複製檢索式」按鈕。

**3. Obsidian／Notion 文獻筆記**：自動同步區塊的書目資訊下方多一個收合的 `> [!search]- 🔎 延伸搜尋`：
- **找這篇**：PubMed、Cochrane、CINAHL、Google Scholar、Europe PMC 等連結（只放能直接帶入檢索詞的資料庫）
- **相似文獻**：PubMed Similar articles（有 PMID 時）
- **MeSH**：從 PubMed 匯入的條目會帶 MeSH 標籤（例如 `Accidental Falls`），每個主題詞連到 MeSH Database 與 PubMed 的 `"主題詞"[Mesh]` 搜尋（`Humans`、`Aged` 這類檢查標籤會略過）
- **PICO 檢索式**：由 AI 筆記的研讀欄位組成 `P AND I AND O`（設定可加入 C），同一欄的多個詞用 OR。檢索式以文字顯示（可直接複製），並附 PubMed、CINAHL、Google Scholar 連結。AI 筆記的 PICO 欄位是中文（術語保留英文），所以英文檢索式只取各欄裡的英文詞；沒有英文詞的欄位會列出來提醒你補（可以用下面的快速搜尋查 MeSH）。另有「原文詞彙」版本（中文照原樣），連到 Google Scholar。

  Notion 頁面也有這一段（顯示成引言區塊，連結可以點）。不想要時在設定取消勾選，下次同步就會移除。

**4. 工具 → 醫學文獻快速搜尋…**：輸入關鍵字（中文或英文；不同概念用逗號分隔，例如 `fall prevention, older adults`），出現資料庫清單，選一個就開啟，開啟後會回到清單。
- **英文關鍵字**：先向 NCBI 查 MeSH 主題詞建議（每個概念一次），例如 `falls, older adults` 組成 `("Accidental Falls"[Mesh] OR falls[tiab]) AND ("Frail Elderly"[Mesh] OR "Aged"[Mesh] OR "older adults"[tiab])`（CI 實測的結果），清單第一項就是用這個檢索式開 PubMed；也可以「複製 PubMed 檢索式」，或「**存成 PubMed 新文獻追蹤**」（輸入名稱後加進[PubMed 新文獻追蹤](#pubmed-新文獻追蹤)，之後自動匯入新文獻）。MeSH 查詢使用 PubMed 新文獻追蹤設定的 Email 與 NCBI API key，速率限制相同；查不到時改用原本的關鍵字。
- **中文關鍵字**：華藝、博碩士論文、國圖期刊、衛福部／國健署排在前面，英文資料庫在後（建議改用英文關鍵字）。
- MeSH 建議只是起點：請到 MeSH Database 看定義（Scope Note）與樹狀結構，確認主題詞真的符合你的概念。NCBI 的 MeSH 資料庫要所有字都出現在同一個主題詞紀錄裡才找得到，所以「`fall prevention`」這種「主題＋目的」的片語常查不到（實測：沒有建議），改用核心詞（`falls`）就會對到 `Accidental Falls`。

#### 資料庫清單

每個網址都由 GitHub Actions 實際連線測試（`.github/workflows/link-check.yml`，每週一次，也可以手動執行；結果在該次執行的摘要與 `link-check-report` 附件）。「CI 實測 2026-10-08」：**OK**＝有搜尋結果頁（開首頁的資料庫＝首頁可開）；**需登入**＝轉到訂閱資料庫的登入頁（預期，在校內網路或經 EZproxy 才進得去）；**被擋**＝網站擋掉雲端主機的自動連線，無法自動判斷，在一般瀏覽器通常正常。「網址格式」：**實測可帶入檢索詞**＝測試時看到檢索詞與結果數；**常見公開格式**＝網站長期使用的搜尋網址，但測試被擋；**依圖書館指南範例格式**＝EBSCO 官方的直接連結格式（測試會先轉到登入頁，看不到結果）；**開首頁＋複製檢索詞**＝沒有公開搜尋網址，開首頁並把檢索詞（或題名）複製到剪貼簿，貼上即可。

| ID | 資料庫 | 需機構權限 | 網址格式 | CI 實測 2026-10-08 | 搜尋網址 |
|---|---|---|---|---|---|
| `pubmed` | PubMed（預設 Best Match 排序） | 否 | 實測可帶入檢索詞 | OK | `https://pubmed.ncbi.nlm.nih.gov/?term={q}`；單篇 `…/<PMID>/`；相似文獻 `…/?linkname=pubmed_pubmed&from_uid=<PMID>`（都實測過） |
| `pubmed-cq` | PubMed Clinical Queries | 否 | 實測可帶入檢索詞 | OK | `https://pubmed.ncbi.nlm.nih.gov/clinical/?term={q}` |
| `mesh` | MeSH Database | 否 | 實測可帶入檢索詞 | OK | `https://www.ncbi.nlm.nih.gov/mesh/?term={q}` |
| `cochrane` | Cochrane Library | 否（全文部分需訂閱） | 實測可帶入檢索詞 | OK | `https://www.cochranelibrary.com/search?…searchText={q}`（Liferay 搜尋參數；實測顯示「1087 Cochrane Reviews matching …」） |
| `cinahl` | CINAHL（EBSCOhost） | 是 | 依圖書館指南範例格式 | 需登入 | `https://search.ebscohost.com/login.aspx?direct=true&db=rzh&bquery={q}&type=1&searchMode=And&site=ehost-live`（EBSCO 接受這個連結，依 IP／帳號驗證後才進入搜尋） |
| `embase` | Embase | 是 | 開首頁＋複製檢索詞 | 需登入 | `https://www.embase.com/` |
| `scholar` | Google Scholar | 否 | 實測可帶入檢索詞 | OK（常被擋） | `https://scholar.google.com/scholar?hl=zh-TW&q={q}` |
| `europepmc` | Europe PMC | 否 | 常見公開格式 | 被擋 | `https://europepmc.org/search?query={q}`（「找這篇」的 `EXT_ID:…`、`DOI:"…"`、`TITLE:"…"` 語法經 Europe PMC API 實測可找到該篇） |
| `semantic` | Semantic Scholar | 否 | 常見公開格式 | 被擋 | `https://www.semanticscholar.org/search?q={q}` |
| `trip` | TRIP Database | 否（Pro 功能需註冊） | 實測可帶入檢索詞 | OK | `https://www.tripdatabase.com/Searchresult?criteria={q}` |
| `jbi` | JBI EBP Database（Ovid） | 是 | 開首頁＋複製檢索詞 | 需登入 | `https://ovidsp.ovid.com/ovidweb.cgi?T=JS&NEWS=N&PAGE=main&D=jbi` |
| `clinicaltrials` | ClinicalTrials.gov | 否 | 實測可帶入檢索詞 | OK | `https://clinicaltrials.gov/search?term={q}` |
| `ictrp` | WHO ICTRP | 否 | 開首頁＋複製檢索詞 | OK | `https://trialsearch.who.int/`（`?SearchAll=` 雖然能帶入，但只找完全相符的片語：實測 1 筆，搜尋框 186 筆，所以不用） |
| `uptodate` | UpToDate | 是 | 實測可帶入檢索詞 | OK | `https://www.uptodate.com/contents/search?search={q}`（結果清單免登入，內文需訂閱） |
| `airiti` | 華藝線上圖書館 | 否（全文多需訂閱） | 開首頁＋複製檢索詞 | OK | `https://www.airitilibrary.com/`（搜尋後的網址是含時間戳記的 JSON，沒有固定格式） |
| `ndltd` | 臺灣博碩士論文知識加值系統 | 否 | 開首頁＋複製檢索詞（網址含連線代碼與驗證碼，沒有固定的搜尋網址） | OK | `https://ndltd.ncl.edu.tw/` |
| `ncl-periodicals` | 國家圖書館期刊文獻資訊網 | 否 | 開首頁＋複製檢索詞 | 被擋（不接受境外連線） | `https://tpl.ncl.edu.tw/` |
| `guideline-pdf` | Google 指引 PDF | 否 | 常見公開格式 | 被擋 | `https://www.google.com/search?q={q} (guideline OR 指引 OR 指南) filetype:pdf` |
| `tw-gov` | 衛福部／國健署（Google 站內搜尋） | 否 | 常見公開格式 | 被擋 | `https://www.google.com/search?q={q} site:mohw.gov.tw OR site:hpa.gov.tw` |
| `nice` | NICE | 否 | 實測可帶入檢索詞 | OK | `https://www.nice.org.uk/search?q={q}` |
| `cdc` | CDC | 否 | 實測可帶入檢索詞 | OK | `https://search.cdc.gov/search/?query={q}` |

`{q}` 是 URL 編碼後的檢索詞（中文、引號、括號、`[Mesh]` 都會編碼）。連結裡只有檢索詞，不會帶入你的 email、API key 或其他資料。CINAHL 預設是 CINAHL Plus with Full Text（資料庫代碼 `rzh`）；學校訂的是 CINAHL Complete 時，用下面的自訂資料庫把 `cinahl` 改成 `db=ccm`。學校改用新版 EBSCO 介面（research.ebsco.com）時，這個舊介面連結可能會轉到登入頁；最穩的作法是在 EBSCO 搜尋一次後用「分享 → 永久連結」複製網址，把檢索詞換成 `{q}` 存成自訂資料庫。

#### 設定（設定 → Zotero Bridge → 醫學文獻快速搜尋）

- **資料庫順序**：ID 以逗號分隔，列在前面的優先（右鍵選單、面板、筆記都依此順序），例如 `pubmed, cinahl, cochrane, airiti, scholar`。
- **隱藏的資料庫**：例如 `embase, uptodate`（學校沒有訂閱的可以隱藏）。設定頁下方會列出所有 ID 與目前狀態，設定有錯時也會顯示在那裡。
- **自訂資料庫**（JSON 陣列）：`name` 名稱、`url` 網址（`{q}` 會換成檢索詞；沒有 `{q}` 的網址會開啟並複製檢索詞）、`needsAccess` 是否需要機構權限（`true` 才會套用代理）。選填：`id`（用內建 ID 可以改內建資料庫，例如換 CINAHL 的資料庫代碼）、`query`（檢索詞的外框，例如 `"{q} AND nursing"`）、`find: true`（也用來「找這篇」）、`lang`（`zh`／`en`／`any`）。

  ```json
  [
    { "name": "學校館藏查詢", "url": "https://<學校的館藏系統>/search?q={q}", "needsAccess": false },
    { "id": "cinahl", "url": "https://search.ebscohost.com/login.aspx?direct=true&db=ccm&bquery={q}&type=1&site=ehost-live" }
  ]
  ```
- **圖書館代理伺服器前綴（EZproxy）**：預設空白。填了之後，**只有需要機構權限的資料庫**（CINAHL、Embase、JBI、UpToDate 與 `needsAccess: true` 的自訂資料庫）會經由代理開啟，在校外也能用學校帳號登入；不想經代理的資料庫填在「不套用代理的資料庫 ID」。前綴的形式通常是 `https://<代理伺服器>/login?url=`（也支援 `…?qurl=` 與含 `{url}` 的前綴）。怎麼找自己學校的前綴：
  1. 到學校圖書館網站找「校外連線」「遠端存取」「校外使用電子資源」的說明頁，通常會寫代理伺服器的網址；
  2. 或在校外從圖書館的「電子資料庫」清單點一個資料庫（例如 CINAHL），看網址列：若是 `https://xxx.yyy.edu.tw/login?url=https://search.ebscohost.com/…`，前綴就是 `https://xxx.yyy.edu.tw/login?url=`；
  3. 學校若用 VPN 或 OpenAthens 等其他方式（網址裡沒有 `login?url=`），這欄留空，連上 VPN 後直接用連結即可。不確定時請問圖書館。
- **右鍵選單最多列出幾個**（1–8）、**右側面板的搜尋連結**、**筆記的「🔎 延伸搜尋」**、**PICO 包含對照組（C）**（預設不含：C 常是「常規照護」，加進檢索式會漏掉很多文獻）、**MeSH 建議**（預設開啟；關掉就不會連 NCBI）。

範例：
- 寫實證報告找證據：工具 → 醫學文獻快速搜尋… → `pressure injury, repositioning` → 先開 PubMed（MeSH 檢索式），再從清單開 Cochrane、CINAHL、TRIP，最後把檢索式存成 PubMed 追蹤。
- 中文文獻：工具 → 醫學文獻快速搜尋… → `壓力性損傷 翻身` → 選「華藝線上圖書館」，在開啟的頁面貼上（Ctrl+V／⌘V）；再選「臺灣博碩士論文知識加值系統」。
- 讀到一篇好研究：在 Obsidian 筆記展開「🔎 延伸搜尋」→ 點 PICO 的 PubMed 連結找同主題的研究，或點「相似文獻」。

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

### 研究儀表板

在 Obsidian 預設子資料夾（例如 `Zotero/`）產生 `研究儀表板.md`，一頁看完整個研究的進度。只用 Obsidian 內建功能（Mermaid 圖、Bases、連結），不需要 Dataview 或其他社群外掛。

- **怎麼更新**：**工具 → 更新研究儀表板**；預設每次手動同步完成後也會自動更新（自動同步不會）。不想自動更新：設定 → Obsidian，取消勾選「手動同步後更新『研究儀表板』筆記」。更新只讀 vault 裡筆記的 frontmatter，不連網、不呼叫 AI、不花 token。
- **內容**：
  - 📖 **閱讀進度**：各閱讀狀態篇數與比例、已讀完成率（已讀 + 已引用）、Mermaid 圓餅圖、各分類的待讀／閱讀中／已讀／已引用與完成率（一篇在多個分類時每個分類都會計入）
  - 🔬 **證據概況**：研究設計、證據等級（CEBM 與 JBI）、嚴格評讀整體結果的分布；有幾篇還沒有 AI 筆記或結構化研讀資料；全文狀態（`none`／`partial` 是掃描檔，建議先 OCR）
  - 📝 **待處理清單**：待讀最久的 10 篇（依加入 Zotero 的日期）；資料品質待補的文獻：沒有 AI 筆記、掃描檔、期刊文章缺 DOI、中文文獻的作者姓名可疑（例如「陳, 美玲」、只有一個字、中英混雜，通常是 Zotero 裡的作者欄位要修正）
  - 🗂️ **回顧專案**：`Reviews/` 裡的 PRISMA 筆記（納入篇數、辨識 → 篩選 → 全文評估、尚待篩選）與 `Drafts/` 裡的文獻探討草稿（篇數、產生日期），點連結就能開啟
  - 🤖 **AI 用量**：本月與前兩個月的呼叫次數、tokens 與估計費用（與 設定 → 本月 AI 用量 同一份紀錄）
  - 🆕 **本週新增**：最近 7 天加入的文獻
- **你的內容不會被覆寫**：只會改寫 `%% zotero-bridge:start %%` 到 `%% zotero-bridge:end %%` 之間的區塊；在區塊上方寫研究目標、在「✍️ 我的筆記」底下寫進度紀錄、自己加的 frontmatter 都會保留。
- **`研究儀表板.base`**（勾選「建立 Zotero 文獻庫.base」時一併建立，需要 Obsidian 1.14 以上）：
  - 「證據等級表」：有 `evidence_level` 的文獻，依研究設計分組，列出樣本數、CEBM／JBI 等級、評讀結果、國家
  - 「掃描檔待 OCR」：`full_text` 是 `none` 或 `partial` 的文獻
  - 「待讀（依分類）」：`status` 是待讀的文獻，依 `collections` 分組（同時在多個分類的文獻可能會另成一組）
  - 這個檔案只在不存在時建立，之後不會覆寫，你可以自由修改檢視；想恢復預設就刪掉它，下次更新儀表板時會重新建立。也可以在任何筆記用 `![[研究儀表板.base#證據等級表]]` 嵌入其中一個檢視。

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
- `apa.csl` 會用英文 APA 規則排版中文文獻（例如 `et al.`、`&`）。學校要求中文文獻用中文格式時，交件前請調整中文文獻，見[中文文獻與中文 APA](#中文文獻與中文-apa)。

### 5.（選用）在 Obsidian 預覽參考文獻

安裝社群外掛 **Pandoc Reference List**，在外掛設定填入 `Zotero/references.json` 的完整路徑與 `apa.csl`。側欄會即時列出目前這份筆記引用的文獻（APA 格式），方便邊寫邊檢查 citekey 有沒有打錯。這個外掛也會用到上面安裝的 Pandoc。

## 中文文獻與中文 APA

華藝（Airiti Library）、台灣護理學會《護理雜誌》、碩博士論文等中文文獻，會自動改用中文 APA 7 格式，不再出現 `陳, 美.`、`et al.`、`&`。設定 → Zotero Bridge → **中文文獻與中文 APA** 可以關閉或調整。Zotero 裡的條目資料不會被修改。

### 哪些文獻算中文

- **標題含中文字**（且沒有日文假名、韓文）→ 中文文獻。
- 標題是英文 → 英文文獻，即使「語言」欄位是 `zh`：華藝的 Zotero 匯入器會把所有文獻（包含英文論文）都標成 `zh`，所以不以語言欄位為準。
- 沒有標題時，看作者是不是中文姓名，再看「語言」欄位（`zh`、`zh-TW`、`中文`、`Chinese`…）。

### 格式

| 類型 | 輸出（筆記裡的期刊名稱、卷數、書名與論文名稱是斜體） |
|---|---|
| 期刊，1 位作者 | 陳美玲（2023）。護理人員跌倒預防衛教之成效。*護理雜誌，70*(2)，45–56。https://doi.org/10.6224/JN.xxxx |
| 期刊，2–20 位作者 | 陳美玲、林小華、王大明（2023）。題目。*護理雜誌，70*(2)，45–56。 |
| 期刊，21 位以上 | 前 19 位、…、最後一位：陳美玲、林小華、…、蘇柏翰（2023）。… |
| 期刊沒有卷數 | 陳美玲（2023）。題目。*護理雜誌*，2，45–56。（期數不加括號、不用斜體） |
| 碩博士論文（未出版） | 陳美玲（2020）。*題目*〔未出版之碩士論文〕。國防醫學院。 |
| 碩博士論文（資料庫） | 陳美玲（2020）。*題目*〔碩士論文，國防醫學院〕。華藝線上圖書館。https://doi.org/… |
| 書籍 | 王大明（2019）。*護理研究概論*（第3版）。華杏。 |
| 編輯書 | 王大明（主編）（2019）。*書名*。華杏。 |
| 書中章節 | 李志明（2019）。章名。載於王大明（主編），*老人護理學*（頁 101–120）。華杏。 |
| 網頁、報告 | 衛生福利部（2024）。*長期照顧統計*。https://…（出版者與作者相同時省略） |
| 沒有作者／日期 | *報告名稱*（2022）。出版者。／ 陳美玲（無日期）。… |

- **內文引用**（文獻比較表）：1 位（陳美玲，2023）、2 位（陳美玲、林小華，2023）、3 位以上（陳美玲等，2023）；21 位以上一樣只寫第一位加「等」。英文文獻維持（Chen et al., 2023）。
- **學位論文**：網址來自華藝或「臺灣博碩士論文知識加值系統」（`hdl.handle.net/11296/…`）、或有 DOI（華藝的論文常把 DOI 放在「其他」欄的 `DOI: …`，也會讀取）時，用資料庫版本；否則用「未出版之碩士論文」。學位從「論文類型」判斷（碩士／Master's、博士／Doctoral）。
- 期刊文章只附 DOI，不附華藝等資料庫的網址（APA 7 的規則）。
- **標點**：預設「。」分隔各部分，與多數學校的 APA 7 中文指引相同；投稿台灣護理學會期刊時可改成「．」分隔（`陳美玲（2023）．題目．護理雜誌，70(2)，45–56。`）。
- **作者姓名**：寫成完整姓名（陳美玲）。Zotero 裡的中文姓名有幾種存法，都會處理：分成姓／名兩欄（陳／美玲）、單一欄位（陳美玲）、被當成英文姓名而前後顛倒（名欄「陳」、姓欄「美玲」）、華藝匯入把複姓拆錯（歐／陽志明 → 歐陽志明），以及姓名後面附的英文拼音 `陳美玲(Chen, Mei-Ling)`。

### 用在哪裡

- Obsidian 文獻筆記的「APA 7」（含斜體）與 frontmatter `authors`（`陳美玲`，不再是 `陳, 美玲`）
- Notion 的 `APA` 欄位（純文字，沒有斜體）與 `Authors` 欄位
- 文獻比較表的引文與「參考文獻」
- `references.json`（見下方 Pandoc）

**中文文獻排在英文前**（預設開啟）：文獻比較表的參考文獻先列中文（依作者姓名筆畫，由少到多），再列英文（依字母），這是台灣護理期刊與學位論文的慣例。關閉時全部依字母排序。

citekey 和筆記檔名不受影響：自動產生的 citekey 仍然用 Zotero 裡的「姓」欄（例如 `陳2023護理人員`；單一欄位的姓名是 `陳美玲2023護理人員`），已經用在論文裡的 citekey 不會改變。

### Pandoc 與 references.json

匯出的 `references.json` 裡，中文姓名寫成完整姓名（CSL 的 `"literal": "陳美玲"`），中文文獻加上 `"language": "zh-TW"`（已經指定 `zh-CN` 等地區的保留原值）。原因：APA 的 CSL 樣式在內文只顯示「姓」，姓／名分開的中文姓名（`"family": "陳", "given": "美玲"`）在 Pandoc 會變成 `(陳 & 林, 2022)`，參考文獻是 `陳美玲., & 林小華.`；寫成完整姓名才會是：

| | Pandoc 3 + 官方 `apa.csl` |
|---|---|
| 內文 | `(陳美玲 et al., 2023)`、`陳美玲 et al. (2023)` |
| 參考文獻 | `陳美玲, 林小華, & 歐陽志明. (2023). 護理人員跌倒預防衛教之成效. 護理雜誌, 70(2), 45–56. https://doi.org/…` |

姓名正確了，但標點與用語仍是英文規則（`et al.`、`&`、半形括號與句點），而且中文文獻會排在英文文獻後面。

目前沒有 Pandoc 能用的中文 APA 樣式：[Zotero 中文社群的樣式](https://github.com/zotero-chinese/styles)（CC BY-SA 3.0）用 CSL-M 的「依語言切換版面」（`<layout locale="zh">`），只有 Zotero 能用；Pandoc 內建的 citeproc 不支援 CSL-M，只會用最後一個（英文）版面（見 [citeproc 更新紀錄](https://github.com/jgm/citeproc/blob/master/CHANGELOG.md)）。所以本插件沒有附 CSL 檔。交稿前建議：

1. 英文文獻用 Pandoc 產生的結果。
2. 中文文獻改用本插件產生的中文 APA：從文獻筆記的「APA 7」或文獻比較表的「參考文獻」複製（Obsidian 閱讀模式複製會保留斜體），放在參考文獻最前面，並把內文的 `et al.` 改成「等」、`&` 改成「、」。

### 格式依據與限制

依下列台灣 APA 7 中文指引整理（各校與期刊細節不同，例如省略號寫法、學位論文用〔〕或（）、是否加學校所在地，**請以學校或投稿期刊的最新規定為準**）：

- 台灣護理學會「APA 第七版參考文獻快速指引」（[2022.01.25 版](https://www.twna.org.tw/WebUploadFiles/DocFiles/2004_2022_0125APA7_.pdf)、[2023.02.13 版](https://www.act.e-twna.org.tw/JudWeb/CFile/P/APA%E7%AC%AC%E4%B8%83%E7%89%88%E5%8F%83%E8%80%83%E6%96%87%E7%8D%BB%E7%AF%84%E4%BE%8B_1120213.pdf)）：期刊格式「作者（年）．標題．期刊名稱，卷(期)，起訖頁數。DOI」，期刊名與卷數斜體，無卷數時只列期數且不用斜體；20 位以內作者全列，21 位以上列前 19 位與最後一位
- 台大醫院護理部[《台大護理雜誌》參考文獻範例 APA 第七版](https://www.ntuh.gov.tw/ckfinder_file/nurse/files/%E5%8F%B0%E5%A4%A7%E8%AD%B7%E7%90%86%E9%9B%9C%E8%AA%8C%E8%88%87%E7%A0%94%E7%A9%B6%E8%A8%88%E7%95%AB/4_APA%E7%AC%AC%E4%B8%83%E7%89%88%E5%8F%83%E8%80%83%E6%96%87%E7%8D%BB%E7%AF%84%E4%BE%8B.pdf)（配合台灣護理學會規定修正）
- 國立臺東大學[APA 第七版參考文獻範例](https://wcse.nttu.edu.tw/var/file/23/1023/img/1847/899277546.pdf)、國立臺中教育大學[論文參考文獻第七版 APA 格式](https://he.ntcu.edu.tw/storage/media/vCShXPhRj15VZG7gxUM75HY2ZPhHRs7u3SPvfNxi.pdf)（中文文獻在前、外文在後）、德育護理健康學院圖書館[APA 第七版常用之格式規範](https://lib.dyhu.edu.tw/var/file/15/1015/img/431/943464994.pdf)
- 學位論文的〔未出版之碩士論文〕與〔碩士論文，學校〕。資料庫名稱 寫法：參考大學 APA 7 中文指引常見的形式（台灣護理學會範例另有「（未發表的碩士論文）．城市：學校系所。」的寫法）

尚未處理：《護理雜誌》投稿須知要求的中文文獻英譯、翻譯書（列在中文之後、英文之前）、同姓作者的內文區分。

## 和 Notero 一起用？

可以並存，但**不要讓兩者寫入同一個 Notion 資料庫**，否則同一篇文獻會出現兩頁。建議改用本插件的分流規則取代 Notero。

## 注意事項

- API key 和 Notion token 存在 Zotero 的密碼管理員（與 Zotero 同步帳號的 API key 相同機制；作業系統鑰匙圈可用時會再加密），不會寫進 profile 的 `prefs.js`。舊版存在 `prefs.js` 的金鑰會在啟動時自動搬移並從 `prefs.js` 刪除。
- 已經 AI 處理過的條目，AI 筆記存在 Zotero 子筆記（標籤 `zotero-bridge-ai`）。你可以直接在 Zotero 修改，下次同步會沿用修改後的內容。
- 重新產生前的舊版 AI 筆記存成另一則子筆記（標籤 `zotero-bridge-ai-history`），只留在 Zotero：不會同步到 Notion／Obsidian，也不會送給 AI。不需要時可以直接刪除。
- Notion 的 API 速率限制約每秒 3 次，同步大量文獻時會比較慢。

## 🔎 醫學文獻快速搜尋（網頁）

**[bobyu89.github.io/zotero-bridge/search.html](https://bobyu89.github.io/zotero-bridge/search.html)**：不用安裝，手機也能用。輸入一次檢索詞，按資料庫就在新分頁開啟搜尋結果；「全部開啟」一次開一組（護理實證常用、免費資源、中文文獻、臨床指引、臨床試驗登錄）。

- **PICO 檢索式產生器**：P、I、C（選填）、O 各填同義詞（逗號或換行分隔）與 MeSH 主題詞，產生 PubMed 版（`[tiab]`／`[Mesh]`，可加出版年、語言、RCT／系統性回顧／指引、排除只有動物的研究）、CINAHL 版（`TI`／`AB`／`MH "…+"`）和一般版（Google Scholar、中文資料庫），一鍵複製或「在 PubMed 執行」。
- **中文檢索詞**：偵測到中文時，中文資料庫排到最前面，並提示常見護理詞的英文關鍵字（只是對照提示，不是翻譯）。
- **校外連線（EZproxy）**：填入學校圖書館的前綴（例如 `https://（學校的 EZproxy 網址）/login?url=`），標示 🔒 需權限的資料庫（CINAHL、Embase、JBI EBP、UpToDate）會經由學校登入開啟。不知道前綴請問圖書館，或從圖書館網站進入資料庫後看網址列。
- **已存檢索**：檢索詞與 PICO 存在這台裝置的瀏覽器，可匯出／匯入 JSON 換電腦使用。無痕視窗不能儲存時會提醒你先匯出。
- 本頁不會把檢索詞送到任何伺服器，只是開啟各資料庫的搜尋網址。

各資料庫的搜尋網址都在 GitHub Actions 實際連線測試過（2026-10-08，之後每週自動重測；和外掛共用的資料庫用同一個網址）。**確定**＝實測帶得進檢索詞的搜尋網址；**推測**＝要先登入、無法實測到結果頁，開啟時也會複製檢索詞，沒帶入就直接貼上；**首頁**＝網站沒有可靠的搜尋網址（需要登入、學校代碼或 session），開首頁並複製檢索詞。「CI 實測」：OK＝有結果頁（首頁類＝首頁可開）；需登入＝轉到訂閱資料庫的登入頁（預期）；被擋＝網站擋掉雲端主機的自動連線，無法自動判斷，在一般瀏覽器通常正常。打不開或沒帶入檢索詞，請到 [Issues](https://github.com/bobyu89/zotero-bridge/issues) 回報。

| 分組 | 資料庫 | 狀態 | CI 實測 2026-10-08 | 權限 |
|---|---|---|---|---|
| 英文資料庫 | PubMed、MeSH Database | 確定 | OK | 免費 |
| | Google Scholar | 確定 | OK（常被擋） | 免費 |
| | Europe PMC、Semantic Scholar | 確定 | 被擋 | 免費 |
| | CINAHL（EBSCO，CINAHL Plus `db=rzh` 直接連結，和外掛相同） | 推測 | 需登入 | 需機構權限 |
| | Embase | 首頁 | 需登入 | 需機構權限 |
| 實證與指引 | Cochrane Library（和外掛相同的搜尋網址） | 確定 | OK | 摘要免費、全文需訂閱 |
| | TRIP Database、NICE、CDC | 確定 | OK | 免費 |
| | UpToDate | 確定 | OK（結果清單免登入） | 需機構權限 |
| | Google 指引 PDF（加上 `guideline filetype:pdf`） | 確定 | 被擋 | 免費 |
| | JBI EBP Database（Ovid） | 首頁 | 需登入 | 需機構權限 |
| 中文資料庫 | 華藝線上圖書館 | 首頁 | OK | 摘要免費、全文需訂閱 |
| | 臺灣博碩士論文知識加值系統 | 首頁 | OK | 免費 |
| | 國家圖書館期刊文獻資訊網 | 首頁 | 被擋（不接受境外連線） | 免費 |
| 臨床試驗登錄 | ClinicalTrials.gov | 確定 | OK | 免費 |
| | WHO ICTRP | 首頁 | OK | 免費 |

CINAHL 的「在 CINAHL 執行」會用 EBSCO 的直接連結開啟 PICO 檢索式（同時複製）；學校訂的是 CINAHL Complete（`db=ccm`）或改用新版 EBSCO 介面時可能沒有帶入，貼上即可。

完整網址列在頁面最下方的「網址格式與狀態」。

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
| `content/usage.js` | AI 用量月報、價格表與費用估算（快取讀寫倍率、批次折扣） |
| `content/ai-batch.js` | 批次 API（Message Batches）：大量 AI 筆記打包送出、custom_id、輪詢與重新啟動後續查、結果 JSONL 解析與套用、取消 |
| `content/notion.js` | Notion API（2025-09-03，data sources） |
| `content/status.js` | 閱讀狀態在 Zotero 標籤、Notion Status、Obsidian `status` 之間的合併與同步 |
| `content/core.js` | Obsidian 筆記組裝、frontmatter 合併、分流規則 |
| `content/markdown.js` | Markdown ⇄ Notion blocks ⇄ HTML |
| `content/synthesis.js` | 跨文獻比較表：提示詞、引文轉換、APA 參考文獻 |
| `content/export.js` | 參考文獻檔匯出（CSL JSON／BibTeX）與 citekey 產生 |
| `content/screening.js` | 系統性／範圍回顧篩選：篩選標籤、找重複、PRISMA 2020 計數與一致性檢查、Mermaid 流程圖、證據表（Obsidian／CSV／Notion） |
| `content/pubmed-watch.js` | PubMed 新文獻追蹤：E-utilities 查詢（速率限制）、去重、用 Zotero 匯入器匯入、自動檢查、Obsidian 每日清單 |
| `content/citation-chase.js` | 引文追蹤：OpenAlex 往回／往前查詢（節流、請求上限、分頁）、與文獻庫比對去重、Obsidian 勾選清單與 CSV、依 DOI／PMID 匯入勾選的文獻 |
| `content/search-links.js` | 醫學文獻快速搜尋：資料庫目錄與搜尋網址、EZproxy、找這篇／相似文獻、PICO 與 MeSH 檢索式、筆記的「🔎 延伸搜尋」、MeSH 建議（經 pubmed-watch.js 的 NCBI 連線） |
| `content/annotation-images.js` | 圖片劃線與手繪註記：取得 Zotero 截圖、複製到 vault、上傳到 Notion、傳給 Claude |
| `research-brain/` | Claude Code／Codex 研究大腦設定檔 |
| `site/index.html` | 安裝精靈網頁（GitHub Pages） |
| `site/search.html` | 醫學文獻快速搜尋網頁（GitHub Pages） |
| `test/live/check-links.mjs` | 外部服務連線檢查（link-check workflow；不在 `npm test` 內） |

### 外部服務連線檢查（link-check）

開發環境連不到 PubMed、OpenAlex 和各資料庫，所以 `.github/workflows/link-check.yml` 在 GitHub Actions 上實際連線檢查（每週一自動執行；修改 `content/search-links.js`、`pubmed-watch.js`、`citation-chase.js`、`site/search.html` 時也會跑；GitHub → Actions → **link-check** → **Run workflow** 可手動執行）：

- `test/live/check-links.mjs` 用插件與網頁的資料庫清單（`search-links.js` 與 `search.html` 的 `window.ZBSearch`）組出每個搜尋網址，以 `fall prevention older adults`（中文資料庫用 `跌倒 預防`）實際開啟：一般 HTTP 連線（跟隨轉址、20 秒逾時、每個網站之間暫停）加上無頭 Chromium，判斷是搜尋結果頁（看得到檢索詞與結果數）、首頁、登入頁、被擋（Cloudflare、captcha、Google 的機器人檢查）或壞掉（404、網址格式錯誤）。不確定的資料庫還會試其他網址寫法，開首頁的資料庫會在網站的搜尋框實際輸入，看搜尋後的網址能不能當成固定格式。
- NCBI E-utilities：用插件自己的函式組網址、解析回應，確認 `esearchresult.count／idlist／querytranslation／errorlist／warninglist`、`esummary` 的 `uids／title／fulljournalname／pubdate／articleids／authors`、MeSH 的 `ds_meshterms／ds_meshui／ds_scopenote` 都還在。
- OpenAlex：引文追蹤用到的每個參數，最後用 `chase()` 對一篇常被引用的護理研究（Aiken et al., 2002, JAMA）實際跑一次。
- 結果表格在該次執行的摘要，也上傳成 `link-check-report` 附件（`report.md`、`report.json`）。只有明確壞掉（404、網址錯誤、NCBI／OpenAlex 欄位不符）才會失敗；擋雲端主機的網站標成「被擋（無法判斷）」，不算失敗。

### 真實 Zotero 測試（e2e）

`npm test` 用的是模擬的 Zotero；`.github/workflows/e2e.yml` 則在 GitHub Actions 上把建置好的 `.xpi` 裝進**真正的 Zotero 10**（Linux 版、當下最新的正式版，下載後快取；目前是 10.0.6）跑一次。每次 push、PR 都會自動執行；要手動跑：GitHub → Actions → **e2e** → **Run workflow**。

做法：`test/e2e/run.sh` 建立全新的 Zotero 設定檔，把插件和測試用的小插件（`test/e2e/harness/`）放進 `<profile>/extensions/`，在 Xvfb 下啟動 Zotero（另開一個已解鎖的 gnome-keyring，讓作業系統鑰匙圈可用）。Zotero 會啟動兩次：先**不裝插件**記下 Zotero 本身在主控台的錯誤（`baseline.json`），再裝插件執行檢查；測試插件在 Zotero 裡依序檢查以下項目，把結果寫進 `results.json` 後關閉 Zotero。結果表格會出現在該次 Actions 的摘要；失敗時另外上傳 `results.json`、Zotero 除錯記錄 `zotero.log` 和測試用的 vault。

- 插件已安裝並啟用，`Zotero.ZoteroBridge` 與所有模組都載入；啟動時主控台沒有插件的錯誤，也沒有「不裝插件時不會出現」的錯誤
- 右鍵／工具選單（MenuManager）、設定頁、條目窗格區塊都有註冊；所有 Fluent 字串在 en-US 與 zh-TW 都找得到，選單實際產生後有文字
- API key／token 經由真正的密碼管理員存取，並確認有用作業系統鑰匙圈加密；舊版設定的搬移
- 在真的文獻庫建立條目（含中文作者、子筆記、標籤、分類）與 PDF 附件（有文字層的 PDF 與純圖片的「掃描檔」），由 Zotero 的 PDF worker 判斷全文狀態 `ok`／`none`／`no_pdf`
- 同步到 Obsidian（不呼叫 AI）：筆記、frontmatter（`zotero_key`、`status`、`full_text`、`citekey`）、`.base` 檔、中文 APA 與 Zotero citeproc 產生的英文 APA
- 閱讀狀態寫回 Zotero 標籤；參考文獻檔 `references.json`（Zotero 的 `itemToCSLJSON`）與 `references.bib`（Zotero 的 BibTeX translator）
- 篩選決定寫到條目標籤，產生 PRISMA 筆記與證據表 CSV
- 自動同步（Zotero.Notifier）；AI 筆記（只把插件內的 `fetch` 換成假的 Claude 回應，不連網）
- 條目窗格區塊實際顯示 AI 筆記；設定頁能開啟、內容與設定值、已存的 token 都正確顯示，關閉後剛輸入的 key 有存下、不留下失效的監聽
- 停用再啟用插件：選單、區塊、FTL 都會清掉再註冊回來

不會連到 Notion 或任何 AI 服務。Zotero 10.0.6 每註冊一次外掛的語系檔就會在主控台記一筆 `uncaught exception: undefined`（不裝插件時一樣會發生，由 baseline 驗證），這一筆不算插件的錯誤。

發布新版本：修改 `manifest.json` 的 `version` → `npm run build` → 推送到 `main`，GitHub Actions 會自動建立 Release，Zotero 會自動更新。
