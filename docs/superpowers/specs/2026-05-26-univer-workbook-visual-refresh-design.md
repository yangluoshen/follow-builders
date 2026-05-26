# Univer Workbook Visual Refresh Design

## Context

The first acceptance preview proved that the workbook update pipeline works, but the weekly sheet is not yet pleasant to read. The visible sheet still feels like a raw grid: clipped text, weak hierarchy, plain summary cells, and no meaningful use of spreadsheet presentation features beyond basic headers.

This design refresh keeps the existing data architecture:

- `raw-data` remains the append/upsert fact table.
- `runs` remains the execution log.
- Each ISO week sheet remains the human-facing report.
- Markdown delivery remains primary and must not be blocked by workbook failures.

The refresh only changes the workbook presentation scaffold and the weekly sheet renderer.

## Chosen Direction

Use an Editorial Dashboard layout for each weekly sheet.

The first viewport should read like a weekly intelligence dashboard, not a database extract. It should still be spreadsheet-native: cells, ranges, formulas or computed helper ranges, charts, conditional formatting, frozen panes, and readable tables.

## Weekly Sheet Layout

Rows 1-5 become the compact dashboard area.

- Row 1 is a dark title band showing `<week> Follow Builders`.
- Row 2 shows the date range, generated timestamp, and public workbook URL.
- Row 3 shows KPI labels at A/C/E/G/I.
- Rows 4-5 show KPI cards for total weekly items, X count, podcast count, blog count, and average score. The cards use formulas against `raw-data` where practical.

Rows 6-7 become a compact section transition.

- Row 6 introduces the daily digest table.
- Row 7 renders the table header using a strong but restrained color.
- Frozen rows should keep the dashboard context and header stable while scrolling. Weekly sheets freeze 7 top rows and 0 columns.

Rows 8 onward become the readable digest table.

- Date, Type, Source, Title, Summary, Key Points, Topics, Score, URL, and contentId remain available.
- Data cells are formulas/references into the sorted `raw-data` rows rather than hardcoded display values.
- Widths and row heights should prioritize reading `Title`, `Summary`, and `Key Points`.
- Text columns should wrap and align top.
- Row backgrounds should alternate subtly.
- Type cells should use source-specific coloring.
- Score should use conditional formatting or equivalent color treatment.
- URL and contentId can be narrower or lower-priority, while still available for traceability.

## Visual System

Use a restrained editorial palette:

- Dark navy title band: `#102033`
- X accent: `#2563EB`
- Podcast accent: `#7C3AED`
- Blog accent: `#F59E0B`
- Success/high-score green: `#16A34A` / `#DCFCE7`
- Neutral sheet background: `#F6F8FB`
- White content blocks with light borders: `#E2E8F0`

Avoid a one-note blue dashboard. Use X, podcast, blog, and score colors to create meaningful contrast.

## Spreadsheet Features To Use

The implementation should use visible workbook features rather than only cell text:

- Merged title/dashboard ranges where appropriate.
- Filled KPI blocks with strong typography.
- Conditional formatting for score color scale.
- Frozen dashboard/header rows, with no frozen columns on weekly sheets.
- Thoughtful column widths and row heights.
- Wrapped text and top alignment for digest rows.
- Subtle alternating row backgrounds.

If charts are brittle in the current CLI/runtime, the fallback is a chart-ready source mix block plus styled KPI cells. The renderer must still produce a polished weekly sheet without depending on chart rendering.

## Data Flow

The renderer should continue to build weekly presentation from `raw-data`, not from the current payload alone.

For the current ISO week:

1. Upsert incoming payload rows into `raw-data` by `contentId`.
2. Append one row to `runs`.
3. Read all `raw-data` rows whose `runDate` is in the week range.
4. Sort by date descending, then source order `X`, `Podcast`, `Blog`, then published time descending, then score descending.
5. Preserve the sorted `raw-data` row numbers and render weekly rows as formulas/references into those rows.
6. Render KPI cards as formulas against `raw-data` where practical.
7. Render the weekly sheet using the compact Editorial Dashboard layout.

This preserves history and makes weekly sheets stable across daily updates.

## Template Responsibilities

`templates/follow-builders.univer` should be rebuilt so `_week-template` reflects the new design, even though daily updates will render real week sheets directly.

The template should contain:

- `raw-data` headers and practical widths.
- `runs` headers and practical widths.
- `_week-template` with the dashboard shell, table header, sample formatting, and conditional formatting.

The repo template must remain committed but unsynced. User initialization will copy and sync it later.

## Renderer Responsibilities

`scripts/update-univer-workbook.js` should update `renderWeeklySheet` and related helpers to:

- Clear and redraw the dashboard range deterministically on each run.
- Preserve raw-data and runs contracts.
- Render dashboard metrics as formulas against `raw-data` where practical.
- Render weekly data rows as formulas/references into sorted `raw-data` rows.
- Apply dashboard/table formatting every run so old sheets converge to the new style.
- Avoid unbounded clearing that could corrupt hidden/raw sheets.

The weekly renderer should not require the LLM to decide layout. The layout contract belongs in code and `SKILL.md`.

## Documentation

Update `SKILL.md` so future agents understand:

- Weekly sheets use the Editorial Dashboard layout.
- `raw-data` is the source of truth.
- The renderer owns dashboard metrics, formula/reference rows, and table formatting.
- LLM output should focus on structured item content, not workbook layout decisions.

## Acceptance Criteria

- A copied template can be populated by one acceptance run and opened with `univer view`.
- The first viewport shows a polished dashboard, not a plain grid.
- Weekly dashboard metrics match the weekly rows.
- The digest table is readable at 100% zoom in the Univer viewer.
- Summary and key-point text are wrapped and not clipped into unreadable single-line runs.
- Score cells are visually differentiated.
- `raw-data` remains append/upsert oriented and visually secondary.
- Existing script tests pass.
- Workbook update failures remain non-blocking for Markdown delivery.

## Out Of Scope

- Changing the raw-data schema.
- Exporting `.xlsx`.
- Reworking Telegram/Markdown formatting.
- Requiring real remote sync during local visual acceptance.
- Letting the LLM freely redesign workbook layout on each daily run.
