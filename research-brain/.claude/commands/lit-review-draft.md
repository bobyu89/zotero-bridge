---
description: 文獻探討初稿：依主題整合多篇文獻的論述段落
argument-hint: <章節主題，例如：跌倒預防衛教的成效>
---

為碩士論文撰寫「$ARGUMENTS」的文獻探討初稿。

規則：
- 以主題組織段落，整合多篇文獻的發現、比較其差異與限制；不要逐篇摘要。
- 每個論點都要有引用，只能引用 vault 或 Zotero 裡真實存在的文獻；不確定的地方標註【待查證】。
- 引用寫成 Pandoc 格式 `[@citekey]`（多篇 `[@a; @b]`，頁碼 `[@a, p. 5]`），citekey 取自文獻筆記 frontmatter 的 `citekey`，和 `Zotero/references.json` 相同，轉 Word 時才會變成 APA 引文；不要自己編 citekey。
- 數字（樣本數、百分比、p 值、效應量）只能照抄文獻筆記或原文，並逐一核對；對不上的列在文末「⚠️ 查核清單」，不要自行修正或推測。
- 學術寫作語氣，繁體中文，術語保留英文；避免空泛的形容詞與 AI 腔。

步驟：
1. 先列出段落大綱（3–6 個小節）與每節要用的文獻，讓我確認。
2. 我確認後再寫完整內文，文末依序加「⚠️ 查核清單」與 `## 參考文獻`（放在最後，Pandoc 會在這個標題下產生 APA 7 列表）。
3. 存成 `研究大腦/<今天日期> 文獻探討初稿 - $ARGUMENTS.md`，並附上轉 Word 的指令（在 vault 根目錄）：`pandoc "研究大腦/<檔名>.md" --citeproc --bibliography Zotero/references.json --csl apa.csl -o 文獻探討.docx`。

Zotero 裡也可以直接產生同樣格式的草稿：在分類上按右鍵 → ZotMax → 產生文獻探討草稿（AI），存在 `Zotero/Drafts/文獻探討-<分類>.md`。那份檔案 `%% zotero-bridge:start/end %%` 之間的內容重新產生時會被覆寫；要在它的基礎上修改，請寫在標記外或另存新檔。
