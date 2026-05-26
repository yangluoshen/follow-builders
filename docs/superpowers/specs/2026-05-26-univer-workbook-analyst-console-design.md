# Univer Workbook Analyst Console Design

## Context

The current weekly Univer sheet works functionally, but the first viewport still
reads like a styled data grid rather than a professional weekly intelligence
console. The selected design direction is the visual companion option
`C v2: Analyst Console, no frozen rows or columns`.

This spec supersedes the earlier Editorial Dashboard visual-refresh spec. The
main changes are:

- Use an analyst-console first viewport instead of a compact editorial dashboard.
- Add spreadsheet-native analysis blocks above the digest table.
- Keep the dashboard height tight so the digest rows remain visible.
- Set weekly sheets to `setFrozenRows(0)` and `setFrozenColumns(0)`.

The design must closely reproduce the approved companion mockup:

`http://localhost:51735` -> `C v2: Analyst Console, no frozen rows`

## Invariants

The workbook data model does not change.

- `raw-data` remains the append/upsert source of truth.
- `runs` remains the execution log.
- ISO week sheets remain human-facing report sheets.
- Weekly sheet rows continue to reference sorted `raw-data` rows with formulas.
- Markdown delivery remains primary and must not be blocked by workbook failures.
- No raw-data schema changes are in scope.

## Chosen Direction

Use an Analyst Console layout for each weekly sheet.

The first viewport should feel like a dense but polished operator dashboard:
filters/status controls, KPI cards, topic heat, score distribution, daily volume,
then the digest table. It should feel spreadsheet-native rather than like an
image pasted into a sheet.

The visual tone is work-focused and premium:

- quiet dark title band
- compact control strip
- strong but restrained KPI cards
- white analytical panels on a pale sheet surface
- professional table header
- score and topic color semantics
- no decorative blobs, hero treatment, or marketing-style layout

## Weekly Sheet Layout

Use columns `A:J` as the visible weekly report surface.

### Row 1: Title Band

Range: `A1:J1`

- Merge across `A1:J1`.
- Text: `<week> Follow Builders`, for example `2026-W22 Follow Builders`.
- Background: `#0F1F33`.
- Font: bold, white, about `20-22px`.
- Height target: `40-44px`.

### Row 2: Metadata Band

Range: `A2:J2`

- Merge across `A2:J2`.
- Text: `<week range> - Generated <timestamp> - <public workbook URL or local workbook>`.
- Background: `#EAF2F8`.
- Font color: `#334155`.
- Height target: `26-28px`.

### Row 3: Control Strip

Range: `A3:J3`

Render six compact control-like cells across the row. These are not interactive
filters in v1; they are professional status controls that make the sheet feel
like an analyst console.

Controls:

- `Source` -> `All`
- `Score` -> `0-100`
- `Topic` -> `All`
- `Date` -> `Week`
- `Sort` -> `Signal`
- `View` -> `Digest`

Implementation can use merged cell groups:

- `A3:B3`, `C3:D3`, `E3:F3`, `G3`, `H3:I3`, `J3`

Style:

- Sheet strip background: `#F8FAFC`.
- Each control: white fill, light border `#CBD5E1`, muted label `#475569`,
  bold value `#172033`.
- Height target: `30-34px`.

### Rows 4-5: KPI Cards

Range: `A4:J5`

Render six KPI cards, matching the companion mockup.

Cards:

- `Items`: total weekly items.
- `X`: weekly X item count.
- `Podcast`: weekly podcast item count.
- `Blog`: weekly blog item count.
- `Median`: median weekly score.
- `Low Score`: count of items below the low-score threshold.

Card colors:

- Items: `#102033`
- X: `#2563EB`
- Podcast: `#7C3AED`
- Blog: `#F59E0B`
- Median: `#0F766E`
- Low Score: `#DC2626`

Values should be formulas against `raw-data` where supported:

- `Items`: `COUNTIFS` over weekly `runDate`.
- Source counts: `COUNTIFS` over weekly `runDate` and `sourceType`.
- `Median`: median of weekly `importanceScore`, with a fallback display of
  `-` if no scores exist.
- `Low Score`: count weekly rows where score is below the implementation
  threshold. Use `<50` unless the existing scoring contract defines another
  threshold.

Height target: two rows totaling about `56-64px`.

### Rows 6-10: Analytics Panels

Range: `A6:J10`

Use three side-by-side analytical panels. Each panel should be built from real
sheet ranges, formulas, conditional formatting, and charts where supported.

Panel 1: `Topic Heat`

- Position: left panel, approximately `A6:D10`.
- Shows a compact heatmap of top topics by day or by source.
- Use formulas/helper ranges derived from weekly `raw-data` rows.
- Use static fills or conditional formatting color scale.
- Suggested colors: low `#F8FAFC`, medium `#BFDBFE`, high `#2563EB`, accent
  `#F59E0B` for notable topic spikes.

Panel 2: `Score Distribution`

- Position: center panel, approximately `E6:G10`.
- Shows score bands:
  - `80+`
  - `50-79`
  - `<50`
- Preferred rendering: conditional-formatting data bars or a horizontal bar
  chart if Univer chart rendering is stable.
- The visible values must be formula-derived from `raw-data`.
- Colors:
  - high: `#16A34A`
  - mid: `#F59E0B`
  - low: `#DC2626`

Panel 3: `Daily Volume`

- Position: right panel, approximately `H6:J10`.
- Shows item count by day for the selected ISO week.
- Preferred rendering: compact column chart.
- Fallback: styled helper cells that visually approximate the companion bars.
- Values must come from weekly `raw-data` formulas.

Panel style:

- Sheet background behind panels: `#F8FAFC`.
- Panel fill: `#FFFFFF`.
- Border: `#D8E0EA`.
- Panel titles: uppercase, `#334155`, bold, small size.
- Height target: five rows totaling about `120-140px`.

### Row 11: Digest Header

Range: `A11:J11`

Render the digest table header.

Columns:

1. `Date`
2. `Type`
3. `Source`
4. `Title`
5. `Summary`
6. `Key Points`
7. `Topics`
8. `Score`
9. `URL`
10. `contentId`

Style:

- Background: `#1F4E79`.
- Font: bold white.
- Height target: `30-34px`.

### Rows 12+: Digest Rows

Rows begin at `A12`.

Cells must be formulas/references into sorted `raw-data` row numbers, not
literal copies of the current payload. Example:

- Date: `='raw-data'!J2`
- Type: derived display formula from `raw-data!B2`
- Source: source name fallback to author name
- Title: `='raw-data'!F2`
- Summary: `='raw-data'!L2`
- Key Points: `='raw-data'!M2`
- Topics: `='raw-data'!N2`
- Score: `='raw-data'!O2`
- URL: `='raw-data'!G2`
- contentId: `='raw-data'!A2`

Style:

- Alternating row backgrounds: `#FFFFFF` and `#F8FBFF`.
- Text wraps in `Title`, `Summary`, `Key Points`, and `Topics`.
- Data rows align top.
- Type cells use source accent colors.
- Score cells use conditional formatting or static fallback fills:
  - high: green soft `#DCFCE7`
  - mid: amber soft `#FEF3C7`
  - low: red soft `#FEE2E2`
- Row height target: `44-72px`, scaling with text readability.

## Freeze Behavior

Weekly sheets must not freeze rows or columns.

- Call `setFrozenRows(0)`.
- Call `setFrozenColumns(0)`.

Reason: frozen dashboard/header rows reduce the lower visible viewport too much
in Univer, especially after adding analytics panels. The approved design keeps
context through compact layout and visual hierarchy rather than pinned rows.

`raw-data` and `runs` may keep their existing data-sheet freeze behavior.

## Column Width Targets

Use widths close to the current table but tune for the denser console:

- `A Date`: `104`
- `B Type`: `76`
- `C Source`: `150`
- `D Title`: `300`
- `E Summary`: `420`
- `F Key Points`: `340`
- `G Topics`: `170`
- `H Score`: `86`
- `I URL`: `300`
- `J contentId`: `180`

These widths should keep the first viewport close to the companion mockup while
preserving traceability columns.

## Helper Ranges And Charts

The renderer may use helper ranges when chart builders need rectangular source
data. Helper ranges should remain on the weekly sheet unless Univer supports
hidden rows/columns reliably in the current CLI. If visible, place helper data
outside the primary report surface, preferably to the right of column `J`, and
make it visually secondary.

Required helper datasets:

- Source counts by type.
- Score band counts.
- Daily volume for seven days.
- Topic heat matrix for a bounded set of top topics.

Preferred chart usage:

- Daily Volume: column chart sourced from the seven-day helper table.
- Score Distribution: bar chart or conditional-formatting data bars.
- Topic Heat: conditional formatting heatmap, because it reads as a native
  spreadsheet element.

Fallback rule: if chart insertion is unavailable or visually brittle, keep the
helper ranges and styled cell visualizations. The sheet must still closely match
the approved companion layout without chart rendering.

## Data Flow

The weekly renderer should continue to build presentation from `raw-data`.

For each run:

1. Upsert incoming items into `raw-data` by `contentId`.
2. Append a row to `runs`.
3. Read `raw-data` rows whose `runDate` falls inside the ISO week.
4. Sort by date descending, then source order `X`, `Podcast`, `Blog`, then
   published time descending, then score descending.
5. Preserve the sorted raw row numbers.
6. Render dashboard metrics and helper ranges from formulas where practical.
7. Render digest rows as formulas/references into the sorted raw row numbers.
8. Clear and redraw only bounded weekly presentation ranges.

## Template Responsibilities

`scripts/univer-template-scaffold.js` should define `_week-template` using the
same Analyst Console shell:

- Row 1 title band.
- Row 2 metadata band.
- Row 3 control strip.
- Rows 4-5 KPI cards.
- Rows 6-10 analytics panels.
- Row 11 digest header.
- Rows 12+ sample digest formatting.
- No frozen rows or columns on `_week-template`.
- Conditional formatting scaffolds for score and heatmap ranges.

The template should not depend on live LLM output.

## Renderer Responsibilities

`scripts/update-univer-workbook.js` should own the layout contract.

The renderer should:

- Redraw the weekly sheet deterministically every run.
- Apply no-freeze behavior every run so old sheets converge.
- Keep `raw-data` and `runs` contracts unchanged.
- Keep formulas pointing back to `raw-data`.
- Create or update bounded helper ranges for analytics.
- Add or update charts/conditional formatting through documented Univer APIs.
- Avoid unbounded clearing that could corrupt data sheets.
- Fall back to styled cell visualizations if chart APIs fail.

## Documentation Responsibilities

Update `SKILL.md` so future agents know:

- Weekly sheets use the Analyst Console layout.
- Weekly sheets do not freeze rows or columns.
- The first visible report surface is `A1:J`.
- `raw-data` is the source of truth.
- Dashboard metrics, helper ranges, charts, and digest rows are renderer-owned.
- LLM output should provide structured item content, not workbook layout choices.

## Acceptance Criteria

- The weekly sheet visually matches the approved `C v2` companion mockup.
- The first viewport shows title, metadata, control strip, KPI cards, analytics
  panels, table header, and at least the first digest row at 100% zoom where
  viewport height permits.
- Weekly sheets have `0` frozen rows and `0` frozen columns.
- KPI values match weekly `raw-data` rows.
- Digest rows are formula-linked to `raw-data`, not literal payload copies.
- Score cells are visually differentiated.
- Topic heat and score distribution use formulas plus conditional formatting,
  charts, or faithful styled-cell fallbacks.
- Daily volume uses a chart where stable, otherwise a faithful styled-cell
  fallback.
- `raw-data` remains append/upsert oriented and visually secondary.
- Existing script tests pass.
- A local acceptance workbook can be opened with `univer view`.
- Final visual acceptance uses Computer Use to inspect the rendered workbook
  and compare it against the approved companion intent.

## Out Of Scope

- Changing the `raw-data` schema.
- Changing Markdown or Telegram delivery formatting.
- Adding real interactive filters in the weekly sheet.
- Exporting `.xlsx`.
- Requiring remote sync during local visual acceptance.
- Letting the LLM redesign workbook layout on each run.
