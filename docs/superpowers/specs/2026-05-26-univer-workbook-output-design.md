# Univer Workbook Output Design

Date: 2026-05-26

## Goal

Add a Univer workbook output to Follow Builders while preserving the existing
Markdown digest as the primary Telegram-friendly delivery format.

The workbook should make captured builder content easier to read, review, and
accumulate over time. It should also keep data and presentation separate so the
workbook can grow into richer weekly reports without making historical content
fragile.

## Decisions

- Markdown remains the main delivered output.
- The workbook is a long-lived local `.univer` file at
  `~/.follow-builders/follow-builders.univer`.
- The repo stores an unsynced workbook template at
  `templates/follow-builders.univer`.
- The template must be scaffolded and locally committed with `univer commit`,
  but not synced. User setup copies it and runs `univer sync` once.
- The first sync produces a `unit-id`; the public URL is
  `https://univer.ai/space/sheets/<unit-id>`.
- The public URL is stored in config and appended to the Markdown digest when
  available.
- Daily runs update and sync the user's workbook copy. They do not rebuild the
  workbook layout and do not edit the repo template.
- Univer failures must not block Markdown delivery.

## Workbook Lifecycle

### Template Creation

The repo template is created once by running `univer new`, scaffolding workbook
layout, styles, formulas, conditional formatting, charts, and required sheets,
then committing the local workbook state with `univer commit`.

The committed template must remain unsynced. This ensures user setup can copy
the template and run `univer sync` directly without needing another local commit
step.

Template path:

```text
templates/follow-builders.univer
```

### User Initialization

During `setup follow builders`, if the user workbook does not exist:

1. Copy `templates/follow-builders.univer` to
   `~/.follow-builders/follow-builders.univer`.
2. Run `univer inspect workbook` on the copied workbook to verify that it is
   workbook-visible and readable.
3. Run `univer sync ~/.follow-builders/follow-builders.univer`.
4. Read the resulting `unit-id`.
5. Save this config:

```json
{
  "univer": {
    "enabled": true,
    "workbookPath": "~/.follow-builders/follow-builders.univer",
    "unitId": "<unit-id>",
    "publicUrl": "https://univer.ai/space/sheets/<unit-id>"
  }
}
```

Daily runs use the stored `publicUrl` directly.

## Workbook Structure

The workbook has a fixed contract. The contract should be documented in
`SKILL.md` so future agent runs do not drift.

Required sheets:

- `raw-data`: the single fact table for all captured content.
- `runs`: append-only operational history.
- Weekly sheets named by ISO week, such as `2026-W22`.
- A reusable weekly template sheet may exist if needed for creating future week
  sheets with the same layout.

Daily updates may edit data rows and current weekly display areas. They must not
change fixed schemas, top-level layout anchors, chart anchors, formula-zone
structure, or repo template state.

## Data Model

### `raw-data`

`raw-data` is a single append-oriented fact table. It is not split by week.

Each captured content item has one row:

- X content: one row per tweet.
- Podcast content: one row per episode.
- Blog content: one row per article.

Rows are keyed by stable `contentId`:

- X: `x:<tweetId>`
- Podcast: `podcast:<guid>`
- Blog: `blog:<normalized-url-hash>`

Daily updates upsert by `contentId`. If a content ID exists, mutable fields are
updated in place. If it does not exist, the row is appended. The sheet does not
need reverse chronological maintenance.

Core columns:

```text
contentId
sourceType
sourceName
authorName
authorHandle
title
url
publishedAt
capturedAt
runDate
textExcerpt
summary
keyPoints
topics
importanceScore
likes
retweets
replies
rawSourceKey
updatedAt
```

`raw-data` stores normalized fields, truncated excerpts, AI summaries, key
points, topics, scores, and URLs. It does not store full podcast transcripts or
full blog bodies.

### `runs`

`runs` records every digest execution, even when content items are deduplicated.

Core columns:

```text
runId
startedAt
finishedAt
status
itemsSeen
itemsInserted
itemsUpdated
markdownPath
itemsJsonPath
syncStatus
unitId
publicUrl
errorSummary
```

## LLM Outputs

The LLM cron flow produces two artifacts:

- `digest.md`: human-readable Markdown for delivery.
- `items.json`: structured companion data consumed by the Univer updater.

The workbook updater must not parse Markdown. It consumes `items.json` and the
original feed context.

`items.json` includes one entry per content item, including `contentId`,
normalized metadata, AI summary fields, topics, and `importanceScore`.

The LLM may include presentation hints such as weekly themes, top topics, or
recommended highlights. These hints are advisory. The deterministic updater
still owns workbook mutation and must respect the workbook contract.

## Weekly Sheet Design

Each week has one sheet named by ISO week, for example `2026-W22`.

Weekly sheets have two major regions.

### Weekly Summary

The top fixed region, roughly rows 1-12, contains:

- Week date range.
- Last updated timestamp.
- Total captured records.
- Counts by `sourceType`.
- High-importance item count.
- Top authors.
- Top topics.
- Public Univer URL.
- Small charts or visual summaries where useful.

Summary metrics should use formulas that reference `raw-data` where practical.
Verified formula families include `COUNTIF`, `COUNTIFS`, `SUMIF`, `SUMIFS`,
`XLOOKUP`, and `INDEX/MATCH`.

Dynamic array formulas such as `FILTER` should not be required for core display
logic because local verification showed `FILTER` returning `#CALC!` in the
current Univer CLI environment.

### Daily Content Display

The content display starts below the fixed summary region, for example around row
15. It is a materialized reading view generated from `raw-data`.

The display is grouped by day:

- Dates are sorted descending, newest first.
- Each date group has a visible group header row.
- Within a date, content is sorted by source type in this order:
  `X -> Podcast -> Blog`.
- Within a source type, sort by published time descending, then by importance
  score if needed.

Visible columns are optimized for reading:

```text
Date
Type
Source
Title
Summary
Key Points
Topics
Score
URL
contentId
```

The `contentId` column may be narrow or hidden, but it must remain present for
traceability back to `raw-data`.

Daily updates refresh only the allowed current-week display area and supporting
summary data. They preserve existing layout, formulas, formatting, column
widths, chart anchors, and conditional formatting.

## Daily Run Flow

1. Run `prepare-digest.js` to fetch feed content and prompts.
2. Run the LLM digest step to write `digest.md` and `items.json`.
3. Validate `items.json` schema.
4. Open the configured user workbook path.
5. Verify required sheets and headers through workbook-visible reads.
6. Upsert `raw-data` by `contentId`.
7. Append one row to `runs`.
8. Create the current weekly sheet from the template if it does not exist.
9. Refresh the current weekly sheet display area from `raw-data`.
10. Verify changed workbook-visible state with `inspect`, `pipe out`, or `run`
    readback.
11. Run `univer sync`.
12. Append `publicUrl` to the Markdown digest when configured.
13. Deliver Markdown through the existing `deliver.js` path.

## Error Handling

- Markdown delivery is the primary path.
- If `items.json` fails but Markdown succeeds, deliver Markdown and skip workbook
  update.
- If workbook update fails, log the error and continue Markdown delivery.
- If `univer sync` fails, keep local workbook changes and continue Markdown
  delivery. The old public URL may still be appended, but logs must indicate
  that the remote workbook may not include the latest data.
- If `raw-data` or `runs` headers do not match the contract, stop workbook
  mutation to avoid corrupting history.
- If the user workbook is missing and config has no existing `unitId`, initialize
  from the repo template.
- If the user workbook is missing but config already has `unitId` and
  `publicUrl`, do not silently overwrite the remote binding. Record an error and
  require an explicit reset or migration path.

## Univer CLI Rules

All workbook operations must use public Univer CLI surfaces:

- `univer inspect workbook`
- `univer inspect range`
- `univer pipe out`
- `univer pipe in`
- `univer run --file`
- `univer status`
- `univer sync`
- `univer view --no-open --json` when human visual review helps

Do not read, patch, unzip, rezip, or inspect `.univer` package internals. Treat
workbook-visible state as the source of truth.

## Testing Strategy

### Node Tests

Cover:

- `contentId` generation for X, podcast, and blog content.
- `items.json` schema validation.
- `raw-data` upsert behavior.
- Same-day duplicate handling.
- Weekly grouping and sorting: date descending, then `X -> Podcast -> Blog`.
- Markdown URL append behavior.

### Univer CLI Integration Tests

Use a temporary workbook or a copied template. Verify only through public CLI
reads.

Cover:

- Template workbook can be inspected.
- Required sheets exist.
- Required headers match the contract.
- Upsert writes expected `raw-data` rows.
- `runs` appends one row per execution.
- Weekly sheet exists.
- Weekly display contains expected date groups and item rows.
- Key summary formulas calculate.

### Manual Or Environment-Dependent Checks

Remote `univer sync` may require real account state. Treat it as an integration
or manual validation step when necessary, and avoid polluting a real user remote
in unit tests.

Before claiming the feature complete:

- Run script tests.
- Run workbook integration checks against a temporary user home.
- Verify workbook-visible state with `inspect` or `pipe out`.
- If a visual report changed materially, use `univer view --no-open --json` for
  human review.

## Documentation Updates

Update `SKILL.md` with a `Univer Workbook Output` section that records:

- Template path and required template state: committed, unsynced.
- User workbook path.
- Config keys.
- Workbook sheets and schemas.
- Daily update allowed and forbidden regions.
- Deduplication rules.
- Weekly sheet grouping and sorting rules.
- Sync behavior and public URL handling.
- Failure behavior: workbook failure must not block Markdown.

Update README files to mention the local Univer workbook output after the design
is implemented.
