# Univer Code Scaffold Initialization Design

Date: 2026-05-26

## Goal

Replace the repository-stored `.univer` workbook template with a code-only
initialization flow. Follow Builders should build a user's initial Univer
workbook by creating a blank workbook and running the committed scaffold script,
instead of copying `templates/follow-builders.univer`.

The main reason is maintainability: workbook layout, schemas, formulas, and
styles are easier to review, diff, test, and evolve when the scaffold is code.

## Decisions

- Completely remove `templates/follow-builders.univer` from the repository.
- Keep `scripts/univer-template-scaffold.js` as the single source of truth for
  the initial workbook scaffold.
- Rename is not required. The existing script path may remain even though it no
  longer builds a checked-in template file.
- User setup creates the long-lived workbook at
  `~/.follow-builders/follow-builders.univer`.
- User setup runs the scaffold only during initialization or explicit
  reinitialization with `--force`.
- Daily scheduled digest runs must never run the scaffold script.
- Daily scheduled digest runs must never call `univer new` for an existing
  configured workbook.
- Daily scheduled digest runs only use `scripts/update-univer-workbook.js` to
  upsert `raw-data`, append `runs`, refresh the current week sheet, commit, and
  sync.

## Initialization Flow

When `scripts/init-univer-workbook.js` runs and the user workbook does not
exist:

1. Create `~/.follow-builders/` if needed.
2. Run `univer new ~/.follow-builders/follow-builders.univer --name "Follow Builders"`.
3. Run
   `univer run ~/.follow-builders/follow-builders.univer --file scripts/univer-template-scaffold.js`.
4. Parse the `univer run` result and require `success: true`.
5. Verify workbook-visible structure with public CLI reads:
   - `univer inspect workbook`
   - `univer inspect range ... --range raw-data!A1:T1`
   - `univer inspect range ... --range runs!A1:M1`
   - `univer inspect range ... --range _week-template!A1:J7`
6. Commit the initialized workbook with
   `univer commit --message "Initialize follow-builders workbook"`.
7. Run `univer sync`.
8. Extract the returned `unitId`.
9. Save `config.univer.enabled`, `config.univer.workbookPath`,
   `config.univer.unitId`, and
   `config.univer.publicUrl = https://univer.ai/space/sheets/<unit-id>`.

The initialized workbook is therefore locally committed and synced before setup
finishes.

## Existing Workbook Behavior

If the workbook already exists and `--force` is not set:

- Do not run `univer new`.
- Do not run `scripts/univer-template-scaffold.js`.
- Do not overwrite workbook contents.
- Run `univer inspect workbook` to verify the configured workbook is readable.
- Run `univer sync` and update `unitId` / `publicUrl` if sync returns a unit id.

If the workbook is missing but config already contains `univer.unitId`, setup
must continue to fail unless the user explicitly passes `--force`. This avoids
accidentally replacing a workbook that was moved or mounted elsewhere.

## Force Reinitialization

When `--force` is passed:

1. If an existing workbook path exists, move or copy it to a temporary backup.
2. Remove the target workbook path.
3. Run the normal code scaffold initialization flow.
4. If any step before successful sync/config write fails, restore the backup.
5. If initialization succeeds, delete the temporary backup.

This preserves the current safety behavior while replacing copy-template with
new-plus-run scaffold.

## Daily Update Boundary

The scaffold script is an initialization-only tool. It must not be called from:

- `scripts/update-univer-workbook.js`
- `scripts/run-llm-digest.js`
- cron setup commands
- any daily scheduled digest path

Daily updates assume a workbook already exists and is initialized. If
`config.univer.workbookPath` is missing or the workbook path does not exist, the
daily updater should fail its workbook side effect and let Markdown delivery
continue through the existing non-blocking error path. It should not silently
create or scaffold a new workbook during a scheduled digest.

## Repository Structure

Remove:

```text
templates/follow-builders.univer
```

Keep:

```text
scripts/univer-template-scaffold.js
```

Update references in:

- `scripts/init-univer-workbook.js`
- `scripts/init-univer-workbook.test.js`
- `scripts/lib/univer-workbook-contract.js`
- `scripts/univer-workbook-contract.test.js`
- `SKILL.md`
- `README.md`
- `README.zh-CN.md`
- Existing design and implementation docs when they still describe a checked-in
  workbook template.

## Testing Strategy

Tests should verify the new lifecycle without real remote sync:

- Fake `univer` records calls and delegates workbook-visible reads/writes to the
  real CLI where practical.
- Init tests assert `univer new`, `univer run`, `inspect`, `commit`, and `sync`
  are called in the expected order for a new user.
- Init tests assert no template file is copied or required.
- Existing-workbook tests assert scaffold is not run without `--force`.
- Force tests assert a failed scaffold or failed sync restores the previous
  workbook.
- Update tests assert daily update does not run `univer new` or the scaffold
  script.
- Acceptance uses a temporary HOME so real `~/.follow-builders` remains
  untouched.

## Acceptance Criteria

- The repository no longer contains `templates/follow-builders.univer`.
- A new user setup creates a workbook from code using `univer new` and
  `univer run --file scripts/univer-template-scaffold.js`.
- The initialized workbook visibly contains `raw-data`, `runs`, and
  `_week-template` with the expected headers/layout.
- The initialized workbook is committed and synced before config is written.
- `config.json` stores the returned unit id and public URL.
- Existing workbooks are not overwritten unless `--force` is passed.
- Daily update and cron flows never run the scaffold script.
- Workbook initialization failures restore prior workbook data when `--force`
  was replacing an existing workbook.
- Markdown delivery remains non-blocking when daily workbook update fails.

## Out Of Scope

- Changing the `raw-data` schema.
- Changing weekly sheet visual design beyond what the existing scaffold already
  defines.
- Exporting `.xlsx`.
- Migrating existing user workbooks automatically.
- Running real remote sync in local automated tests.
