---
description: 系統性／範圍回顧：讀 PRISMA 筆記，檢查篩選進度並寫 PRISMA 流程與納入研究特徵
argument-hint: <回顧的分類名稱，例如：跌倒預防 SR>
---

針對系統性／範圍回顧「$ARGUMENTS」整理 PRISMA 2020 結果。

1. 讀 `Zotero/Reviews/$ARGUMENTS.md`（找不到時列出 `Zotero/Reviews/` 中 `type: review-screening` 的筆記讓我選）。所有數字只用筆記 frontmatter 的 `prisma_*` 與「PRISMA 2020 計數」表，不可自行推算。
2. 先回報篩選進度：`last_generated` 的日期、`prisma_awaiting_screening` 與 `prisma_awaiting_fulltext` 是否為 0、「一致性檢查」中的 ⚠️ 項目。有未完成或 ⚠️ 時，提醒我在 Zotero 修正篩選標籤後重新產生（分類右鍵 → Zotero Bridge：系統性回顧篩選 → 產生 PRISMA 流程圖與證據表），並說明下面的段落是暫定版。
3. 產出：
   - `## Study selection`：PRISMA 2020 流程的論文段落（繁體中文，術語保留英文），依序寫出 records identified（各資料庫）、duplicates removed、records screened／excluded、reports sought／not retrieved、reports assessed、reports excluded（逐項原因與篇數）、studies included，並註明「詳見圖 1 PRISMA 2020 流程圖」
   - `## 納入研究特徵`：依筆記的證據表歸納研究設計、國家、場域、族群、介入、結果指標與證據等級／JBI 評讀的分布，引用用 `[[筆記路徑|作者, 年份]]`（取自證據表的連結）；證據表欄位空白的研究標註「尚無 AI 筆記資料」，不可補寫
   - `## 待辦`：還需要完成的篩選、缺 AI 筆記的納入研究
4. 存成 `研究大腦/<今天日期> PRISMA - $ARGUMENTS.md`，frontmatter 加上 `type: prisma-summary` 與 `source: "Zotero/Reviews/$ARGUMENTS.md"`。不要修改 `Zotero/Reviews/` 裡的筆記。
