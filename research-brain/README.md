# 研究大腦（Claude Code／Codex 設定檔）

把 Claude Code 或 OpenAI Codex 變成你的「研究大腦」：它能直接讀你的 Obsidian 文獻筆記、搜尋 Zotero、寫入 Notion，用一句指令完成文獻比較、研究缺口與文獻探討初稿。

```
Zotero ──(ZotMax 插件)──► Obsidian 文獻筆記 ◄──┐
   │                              Notion 資料庫   ◄──┤
   └──────────(Zotero MCP)────────────────────────► 研究大腦（Claude Code／Codex）
```

**分工**：ZotMax 插件負責「每一篇」的固定流程（書目、劃線、AI 筆記、同步），大腦負責「跨文獻」的思考。大腦先讀插件整理好的筆記，比每次重讀 PDF 快、也便宜很多。

## 檔案說明

| 檔案 | 用途 |
|---|---|
| `AGENTS.md` | 工作守則：語言、引用規則、vault 結構、不可編造文獻。Claude Code 與 Codex 共用 |
| `CLAUDE.md` | Claude Code 讀的設定，內容直接引用 `AGENTS.md` |
| `.mcp.json` | 連線設定：Zotero（本機）與 Notion |
| `.claude/commands/` | Claude Code 斜線指令（見下方） |
| `codex-config.toml` | Codex 的 Zotero 連線設定範本 |

> `.mcp.json` 和 `.claude` 是隱藏檔。macOS 在 Finder 按 `Cmd + Shift + .` 顯示；Windows 在檔案總管 →「檢視」勾選「隱藏的項目」。

## 安裝（在你自己的電腦上）

Zotero 只能從你的電腦連線，所以大腦要裝在你的電腦，不能用雲端版。

1. **先完成 ZotMax 設定**，讓 vault 裡已經有文獻筆記。
2. **開啟 Zotero 本機連線**：Zotero → 設定 → 進階 → 勾選「Allow other applications on this computer to communicate with Zotero」。使用大腦時 Zotero 要開著。
3. **安裝 uv**（執行 Zotero MCP 用）：<https://docs.astral.sh/uv/getting-started/installation/>
4. **安裝 Claude Code**：<https://code.claude.com/docs>（或改用 Codex，見下方）
5. **把這個資料夾裡的所有檔案（包含隱藏檔）複製到 Obsidian vault 的根目錄。** 如果 vault 裡的文獻資料夾不叫 `Zotero`，請同步修改 `AGENTS.md` 裡的路徑。
6. 在 vault 根目錄打開終端機，執行：

   ```bash
   claude
   ```

   第一次啟動會詢問是否使用這個專案的 MCP 伺服器，選同意。接著輸入 `/mcp`，選 `notion` 完成 Notion 登入。

## 使用

| 指令 | 做什麼 | 範例 |
|---|---|---|
| `/lit-compare` | 文獻比較表 + 主題整理 + 研究缺口 | `/lit-compare 跌倒預防` |
| `/research-gaps` | 研究缺口，並提出 PICO 研究問題 | `/research-gaps ICU 病人譫妄的非藥物介入` |
| `/lit-review-draft` | 文獻探討初稿（先給大綱讓你確認） | `/lit-review-draft 跌倒預防衛教的成效` |
| `/inbox-triage` | 列出待讀文獻與建議閱讀順序 | `/inbox-triage 碩論` |
| `/review-prisma` | 讀系統性回顧的 PRISMA 筆記：篩選進度、一致性問題、PRISMA 流程與納入研究特徵段落 | `/review-prisma 跌倒預防 SR` |

也可以直接用一般對話，例如：「把碩論分類裡 2020 年以後的 RCT 找出來，比較它們的測量工具」。

產出的筆記會存到 vault 的 `研究大腦/` 資料夾，引用會連回原本的文獻筆記。

## 使用 Codex（OpenAI）

1. 安裝 Codex CLI，並把 `codex-config.toml` 的內容加到 `~/.codex/config.toml`。
2. 在 vault 根目錄執行 `codex`。Codex 會讀 `AGENTS.md` 作為工作守則。
3. 斜線指令是 Claude Code 專用的；用 Codex 時直接說「依照 AGENTS.md 的『文獻比較表』流程，比較跌倒預防的文獻」。

> Codex 的設定格式是依第三方資料整理，尚未對照 OpenAI 官方文件驗證；Notion 連線請依 Codex 官方文件另外設定。

## 注意

- 大腦被要求**不可編造文獻**，只能引用 vault 或 Zotero 裡真實存在的文獻；找不到時會標註【待查證】。重要引用仍請自行核對。
- 大腦不會改動文獻筆記中插件管理的區塊；它的產出另外存成新筆記。
- 每次對話都會使用 API 額度或訂閱額度。
