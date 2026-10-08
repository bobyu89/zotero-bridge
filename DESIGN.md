---
name: Zotero Bridge
description: Zotero 10 外掛的設定頁、項目窗格與工具列按鈕：在 Zotero 自己的視窗裡，像學長姐的提點一樣安靜、清楚。
colors:
  # The plugin defines no colors of its own: every value is one of Zotero's theme variables, so light
  # and dark themes come for free. Hex values are Zotero's light theme, for reference only.
  text: "var(--fill-primary)"
  text-muted: "var(--fill-secondary)"
  line: "var(--fill-quinary)"
  tint: "var(--fill-senary)"
  surface: "var(--material-background)"
  accent: "var(--color-accent)"
  marker-ai: "var(--accent-orange)"
  marker-network: "var(--accent-blue)"
typography:
  body:
    fontFamily: "inherit (Zotero's UI font)"
    fontSize: "1em (follows Zotero's font size setting)"
    fontWeight: 400
    lineHeight: 1.4
  section-title:
    fontSize: "Zotero's h2"
    fontWeight: 600
  group-title:
    fontSize: "1em"
    fontWeight: 600
  label:
    fontSize: "1em"
    fontWeight: 600
  hint:
    fontSize: "0.92em"
    fontWeight: 400
    lineHeight: 1.4
  marker:
    fontSize: "0.85em"
    fontWeight: 400
rounded:
  sm: "4px"
  md: "6px"
spacing:
  "1": "0.25em"
  "2": "0.5em"
  "3": "0.75em"
  "4": "1em"
  "5": "1.5em"
components:
  preset-option:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "0.5em 0.75em"
  preset-option-selected:
    backgroundColor: "{colors.tint}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
  feature-row:
    textColor: "{colors.text}"
    padding: "0.5em 0"
  marker-tag:
    textColor: "{colors.text-muted}"
    rounded: "{rounded.sm}"
    padding: "0 0.45em"
  more-summary:
    textColor: "{colors.text-muted}"
  toolbar-button:
    # Zotero's own `.zotero-tb-button` rules in #zotero-items-toolbar (a menu button); the plugin sets only the 20px icon
    textColor: "{colors.text-muted}"
    rounded: "5px"
    width: "40px"
    height: "28px"
  toolbar-menu-caption:
    textColor: "{colors.text-muted}"
    fontWeight: 600
---

# Design System: Zotero Bridge

## Overview

**Creative North Star: "The Senior's Margin Note"（學長姐的邊註）**

The plugin lives inside someone else's house: Zotero's settings window, item pane and main toolbar. It never brings its own world. It borrows Zotero's typeface, colors, controls and spacing, and spends its one signature move on honesty: every feature says in one line what it does, and small markers say plainly when something calls an AI that costs money or goes online. The tone is a senior classmate leaning over to point at the right switch: direct, warm, never a sales pitch.

The surface is **Operate** mode. A nursing graduate student opens settings to get one thing done (connect the vault, add an API key, turn a feature on) and leaves. The page is a working settings pane first; density is moderate, scanning beats reading, and nothing moves unless state changes.

**Key Characteristics:**
- Zotero's own CSS variables for every color, so light and dark themes and high contrast follow automatically.
- Sizes in `em`, so Zotero's font-size setting scales the whole pane.
- Progressive disclosure twice over: sections of a switched-off feature disappear, and expert options sit behind a closed `<details>`.
- Standard controls only: native checkboxes, radios, buttons, XUL menulists. No custom switches, no modals; the only window of the plugin's own is the 文獻自動分類 review, opened on request.
- Traditional Chinese copy; method terms (PICO, MeSH, CASP, JBI, PRISMA) stay in English.

## Colors

A restrained, borrowed palette: neutral fills from Zotero, its accent for selection and focus, and two hues used only as small dots on markers.

### Primary
- **Zotero Accent** (`--color-accent`): the selected preset's border, focus rings. Never decoration.

### Neutral
- **Ink** (`--fill-primary`): labels, feature names, body text.
- **Pencil** (`--fill-secondary`): descriptions, hints, the preset status line, folded summaries. Meets 4.5:1 on Zotero's backgrounds.
- **Hairline** (`--fill-quinary`): dividers between feature rows and around preset options, marker borders, the item pane's tools divider.
- **Wash** (`--fill-senary`): hover and the selected preset's background.
- **Page** (`--material-background`): preset option background.

### Marker hues
- **Cost Orange** (`--accent-orange`): the dot on 「AI・要付費」.
- **Network Blue** (`--accent-blue`): the dot on 「連網」.

### Named Rules
**The Words-First Rule.** A marker's meaning is in its words; the colored dot only helps scanning. Never color text with the marker hues (they fail contrast), and never rely on the dot alone.

**The Borrowed Palette Rule.** No hex values in the plugin's CSS except as `var()` fallbacks. If Zotero has a variable for it, use it.

## Typography

**Body Font:** Zotero's UI font (inherited; no web fonts, no CDNs).

**Character:** one family, weight does the work. 600 for names and titles, 400 for everything else, a slightly smaller size for help text.

### Hierarchy
- **Section title** (Zotero's `h2`, inside `<label>`): one per settings section, as in Zotero's own panes.
- **Group title** (600, 1em, hairline below): 整理與同步／找文獻／篩選與評讀／AI 輔助與寫作, and subsections inside 「AI 服務」.
- **Label** (600, 1em): feature names, preset names.
- **Body** (400, 1em): control labels and Zotero's own `description`.
- **Hint** (400, 0.92em, line-height 1.4, Pencil): feature descriptions, preset descriptions, requirement notes. Measure capped at 46em.
- **Marker** (400, 0.85em): the cost and network tags.

### Named Rules
**The One-Line Rule.** Each feature gets exactly one sentence of description. If it needs two, the second belongs in the README.

## Layout

Single column, the width of Zotero's settings content area. The 功能 block caps its text and rows at 46em so lines stay readable on wide windows. Spacing runs on a 0.25em step scale (0.25, 0.5, 0.75, 1, 1.5em): tight inside a row (0.25–0.5em), 0.5em between rows with a hairline, 1.5em above each feature group. Preset options sit side by side on wide panes and stack when narrower than about 32em (CSS grid `auto-fit, minmax(16em, 1fr)`).

Section order follows the feature groups: 功能 → Obsidian → Notion → 分流規則 → 自動同步 → 劃線顏色與意義 → 全文筆記 → 閱讀狀態 → 中文 APA → 參考文獻檔 → 概念卡片 → 文獻自動分類 → 醫學文獻快速搜尋 → NCBI → PubMed 追蹤 → 引文追蹤 → 篩選 → AI 服務 → 本月 AI 用量.

In the item pane (no stylesheet available), the same rhythm is applied inline: the per-item tool rows (each with its own 2px/6px margins) sit in one block with a hairline below, then the AI note; actions sit in a wrapping row with a 6px gap.

## Elevation & Depth

Flat. Depth comes from hairlines and the wash tint, never shadows; Zotero's own panes are flat and the plugin matches them.

### Named Rules
**The Flat-By-Default Rule.** No `box-shadow` anywhere. A selected or hovered thing changes border color or background tint.

## Shapes

Gently rounded: 6px on preset options, 4px on markers, the PubMed watch boxes and focus outlines of summaries. Feature rows have no box at all, only hairlines between them; cards are not the container here.

## Components

### Preset options (研究生引導／進階)
- **Shape:** 6px radius, 1px Hairline border, Page background, 0.5em × 0.75em padding.
- **Content:** a native radio, the preset name (Label), one Hint sentence. The whole option is the radio's `<label>`.
- **Selected:** border turns Zotero Accent, background Wash (`:has(input:checked)`).
- **Hover:** Wash background, 150ms ease-out (none with reduced motion).
- **Focus:** a 2px Accent outline around the whole option (the radio's own outline is suppressed).
- **自訂:** not a choice: when the switches match neither preset, no radio is checked and the status line says 「目前：自訂」.
- **After choosing:** the status line says 「已切換到「…」。」 with a 「復原」 button that restores the previous switches; focus returns to the preset group.

### Feature row
- **Layout:** native checkbox, then the name (a `<label for>`), markers, one-line description, and a requirement note when blocked.
- **Separators:** a Hairline between rows; none inside a row.
- **Blocked (a required feature is off):** the checkbox is disabled but keeps its own value; the name turns Pencil; the note says 「要先打開「…」才會生效。」 and is wired with `aria-describedby`.

### Marker tags
- **Style:** 0.85em text in Pencil, 1px Hairline border, 4px radius, a 0.5em dot (Cost Orange or Network Blue).
- **Vocabulary:** 「AI・要付費」 for anything that calls an AI API, 「連網」 for anything that goes online on its own.

### Folded options (`.zb-more`)
- **Style:** a native `<details>`; the `<summary>` names what is inside (「更多搜尋設定：資料庫順序、隱藏、自訂資料庫」), Pencil until hovered or open.
- **Focus:** 2px Accent outline, 4px radius.

### Colour meaning rows (劃線顏色與意義)
- **Layout:** an ordered list, one row per Zotero colour: a 0.9em swatch (the annotation colour itself, set inline as data, with a Hairline ring so light colours stay visible on any theme), the colour name in Pencil, the meaning as a text input (labelled by the name), then 「上移」「下移」 buttons. Rows share the feature-row rhythm: hairline between rows, no boxes.
- **Order is meaning:** the list order is the order of the note's highlight groups and of the picks in 「重點」, so reordering is a first-class action, not a drag handle. Buttons at the ends are disabled; focus stays on the moved row.
- **Words-first:** the swatch never carries the meaning alone; the colour name and the meaning are always text.

### Full-text options (全文筆記)
- One lead sentence (what the note is and that it is rebuilt), the subfolder field, two checkboxes (trim before the AI; the Notion child page with its cost in API calls), and markitdown folded in a `.zb-more` with an honest hint: what it helps with (tables, forms) and what it doesn't do (headings, OCR).

### Section disclosure
- Every settings section (and sub-block) carries `data-zb-feature="<feature IDs>"`; it shows while any of those features is on and comes back the moment one is turned on. Sections that serve several features list them all (the NCBI block serves PubMed watch and search links).

### Live validation (`.zb-validate`)
- Under a textarea the plugin parses (文獻自動分類's rules and topics): what the parser makes of it, in Pencil at 0.92em, announced with `role="status"` and wired to the textarea with `aria-describedby`.
- **Error:** the words carry it (「第 3 行：少了右括號 )」), set in Ink at 600; the textarea gets `aria-invalid="true"` and an Ink border. No red text (it fails contrast on the dark theme), no icons.

### Review window (文獻自動分類, `classify-review.xhtml`)
The one place the plugin opens a window of its own: a non-modal Zotero dialog, because the user has to look over many items before anything is written. It uses the same borrowed palette and spacing as the settings pane (`classify-review.css`).
- **Head** (Zotero's sidepane material, Hairline below): a 600 title, one Pencil sentence that says the judgement is the user's and that nothing is removed, the target (「放在：我的文獻庫 › 自動分類」), notes about skipped dimensions as a plain list, then one row per dimension with its name (600), a count and 「全選」「全不選」 buttons.
- **List** (scrolls): one block per item, Hairline between blocks, the title in 600 and year · journal in Pencil. Suggestions sit in a two-column grid per dimension: the dimension name in Pencil on the left, native checkboxes on the right, each with the value (600 when ticked, Pencil 400 when not) and its source and confidence in Pencil (「規則推測・高｜標題有「randomized」」). Items without suggestions fold into one `<details>`.
- **Foot** (sidepane material, Hairline above): the live count as a `role="status"` line (「已勾選 12 項：會建立 4 個子分類，加入 10 筆」), then 「取消」 and 「套用」 (600). Esc cancels; a decision disables both buttons.
- **Focus:** the first checkbox gets focus; 2px Accent outlines on checkboxes, buttons and the folded list's summary.

### Toolbar button (`content/toolbar.js`, `toolbar.css`)
The one way into every command without hunting through context and Tools menus. It is a guest in Zotero's own toolbar, so it borrows everything and adds only its icon.
- **Place:** the items toolbar (`#zotero-items-toolbar`, above the item list), right after Zotero's 「新增筆記」: that row holds the buttons that act on the selected items, before the search box. Not the tab bar (window-level: tabs, sync) and not the collections toolbar.
- **Shape and states:** a XUL `toolbarbutton` with Zotero's `zotero-tb-button` class, `type="menu"` and a dropmarker, so size (40 × 28px), 5px radius, hover (Hairline fill), active and open (`--fill-quarternary`), disabled and the focus ring are Zotero's own rules. `toolbar.css` sets only the icon: `bridge.svg` as `list-style-image`, filled with `currentColor` through `-moz-context-properties`, drawn at Zotero's 20px. No colors of its own, so light, dark and high-contrast themes follow the neighbouring buttons.
- **Name:** tooltip and `aria-label` 「Zotero Bridge」 (the product name, the same in every language); no visible text, like its neighbours.
- **Keyboard:** Zotero's toolbar is one arrow-key row (`tabindex="-1"` on every button); the button joins it: ArrowRight from 「新增筆記」 reaches it, ArrowLeft goes back, Tab goes on to the search box. Enter, Space and ArrowDown open the menu.
- **Menu:** groups in the order of the research workflow, each under a caption (Label weight 600, Pencil; a XUL `menucaption`, never clickable): 同步 → 整理 → 找文獻 → 篩選與評讀 → AI 輔助與寫作, separated by native separators, then 「設定…」 always last. Entry labels reuse the context and Tools menu strings where they fit, so a command reads the same everywhere. No icons in the menu: the button carries the only one.
- **Live:** checked each time the menu opens: entries of switched-off features hide, conditional entries (繼續／停止同步, 復原上次分類, 檢查 AI 批次進度) appear only when there is something to do, and a group with nothing left hides with its caption. The switch 「工具列按鈕」 hides the button itself without a restart.
- **Selection:** commands act on the items selected in the list; collection commands (找重複, PRISMA, 評讀總表, 引文追蹤納入研究) on the collection selected on the left; with nothing suitable selected they say so in the same words as the existing commands (「請先選取文獻。」).

### Item pane section
- **Tools block:** status, screening, search links and appraisal rows, each only when its feature is on, inside a `<section>` with a Hairline below.
- **Note:** model and date in Pencil at 0.9em, study facts in 600, headings 600 with more space above (10px) than below (2px), quotes with a 2px Hairline at the inline start.
- **Empty and off states:** 「這篇文獻還沒有 AI 文獻筆記。」 plus a Hint on cost; with AI notes off, one Hint saying where to turn it on.

## Literature note (Obsidian and Notion)

The synced literature note is a **Read** surface: the reader came back to a paper to find its point. The column is the user's vault theme; the plugin only decides structure, order and what is said once.

**North star: the ten-second glance.** Everything needed to remember a paper sits in one open callout at the top; everything long is folded below in a fixed, predictable order, so the eye learns where things are.

### Structure (inside `%% zotero-bridge:start/end %%`)
1. **`> [!abstract] 重點`** (open). In this order, each part only when it exists:
   - **一句話**：the AI note's one-sentence summary.
   - One facts line: `design · N = … · CEBM … · JBI … · 評讀：… （已核對／待核對／AI 初評）` (a verified appraisal form wins over the AI's verdict).
   - **主要發現**：the first 2–3 top-level bullets of the AI note's 「主要結果」 (or its first two sentences).
   - **我的劃線**：up to three of the user's highlights, one per colour meaning first, in the meanings' order, each shortened to 140 characters with its meaning and page link.
   - A links line: full-text note, Zotero, Notion, DOI.
   - Empty state: one sentence saying what will appear here and how (highlight in Zotero, or generate the AI note).
2. **Folded callouts** (`> [!type]- title`), fixed order, own words before the AI's, reference material last:
   1. one `[!quote]-` per colour meaning with annotations, titled `🟡 重要發現（n）` (list items: highlight, page link; comment, image and tags indented under it)
   2. `[!note]- 我的 Zotero 筆記（n）`
   3. `[!example]- 文獻評讀表`
   4. `[!tip]- AI 標的重點（僅供參考）`: verified AI quotes, marked 🤖
   5. `[!note]- AI 文獻筆記（model · date）`: the full AI note without its summary, headings one level down
   6. `[!info]- 摘要（Abstract）`
   7. `[!search]- 🔎 延伸搜尋`
   8. `[!info]- 書目資訊` (authors, year, publication, DOI, APA 7)
3. Sections without content are left out; nothing is said twice (the summary and the Zotero/Notion links live only in 重點; the full text is linked, never embedded).

### Notion
The managed container keeps the same order: 重點 as open blocks at its top, each folded section a **toggle**; highlight-group toggles take their colour's background (`yellow_background`…), the others stay default. Toggles go in their own requests (Notion nests two levels per request); 文獻評讀表's real table is inserted inside its toggle.

### Full-text note
`<note folder>/全文/<same name>.md`: frontmatter `fulltext_of` (never `zotero_key`, so indexes and Bases skip it), a two-line `[!info]` callout saying it is rebuilt on every sync and linking back, then the paper as Markdown. The user's highlights are `==🟡…==` in place (same colour mapping as the note); verified AI quotes are `🤖<u>…</u>` (underline, visibly secondary to colour, and it survives the Notion conversion as an underline). Highlights that can't be placed are listed at the end, never dropped.

### Named Rules
**The Ten-Second Rule.** If a reader needs to unfold anything to learn what the paper found and whether it is any good, 重點 is missing something.

**The Own-Words-First Rule.** The user's highlights, notes and appraisal come before anything the AI wrote; AI content is labelled as such and folded.

**The Preserve Rule.** Layout changes happen only between the markers; the user's text, 「✍️ 我的筆記」 and their frontmatter keys survive every re-sync, including the first re-sync into a new layout.

## Do's and Don'ts

### Do:
- **Do** take every color from Zotero's variables (`--fill-*`, `--material-*`, `--color-accent`, `--accent-*`), with a fallback in `var()`.
- **Do** write each feature as name + one sentence, and add 「AI・要付費」 or 「連網」 whenever it applies.
- **Do** give every control a visible label and a 2px Accent focus outline.
- **Do** keep l10n IDs in both `locale/zh-TW` and `locale/en-US`, with the zh-TW fallback text identical to the catalog in `content/features.js`.
- **Do** hide a switched-off feature's settings instead of disabling them in place.

### Don't:
- **Don't** load fonts, images or scripts from outside the plugin.
- **Don't** use shadows, gradients, or colored side stripes.
- **Don't** invent controls: no custom toggle switches, no modals for settings, no restyled toolbar buttons (the toolbar button uses Zotero's own class and states).
- **Don't** use emoji as icons in new UI; existing item-pane rows keep theirs.
- **Don't** describe AI features as finding literature or writing for the user without saying the draft must be checked.
