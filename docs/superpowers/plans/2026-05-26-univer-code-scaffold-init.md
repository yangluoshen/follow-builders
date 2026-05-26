# Univer Code Scaffold Initialization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the checked-in `.univer` template with an initialization-only code scaffold that builds the user's workbook through `univer new` and `univer run`.

**Architecture:** `scripts/univer-template-scaffold.js` becomes the only workbook scaffold source. `scripts/init-univer-workbook.js` creates, scaffolds, commits, syncs, and records the user workbook during setup; daily update paths continue to require an existing initialized workbook and never run the scaffold.

**Tech Stack:** Node.js ESM, built-in `node:test`, `univer` CLI, JSON config in `~/.follow-builders/config.json`, public workbook verification through `univer inspect` / `pipe out`.

---

## File Structure

- Modify `scripts/lib/univer-workbook-contract.js`
  - Remove the checked-in workbook template constant.
  - Add `WORKBOOK_SCAFFOLD_SCRIPT_PATH = 'scripts/univer-template-scaffold.js'`.
  - Keep sheet/header/public URL contracts unchanged.

- Modify `scripts/univer-workbook-contract.test.js`
  - Assert the scaffold script path instead of `templates/follow-builders.univer`.

- Modify `scripts/init-univer-workbook.js`
  - Replace copy-template behavior with `univer new`, `univer run --file scripts/univer-template-scaffold.js`, workbook-visible verification, `univer commit`, and `univer sync`.
  - Preserve existing no-overwrite and `--force` backup/restore behavior.

- Modify `scripts/init-univer-workbook.test.js`
  - Replace fake template package setup with fake `univer new/run/commit/sync` assertions.
  - Add explicit coverage that an existing workbook does not run scaffold without `--force`.
  - Add explicit coverage that failed scaffold/sync restores an existing workbook during `--force`.

- Modify `scripts/update-univer-workbook.test.js`
  - Add a guard assertion that daily update never calls `univer new` or `scripts/univer-template-scaffold.js`.

- Remove `templates/follow-builders.univer`
  - Delete the repo-stored workbook template directory/package.

- Modify `SKILL.md`
  - Replace copy-template setup instructions with `node scripts/init-univer-workbook.js`.
  - Document that scaffold runs only during initialization or `--force`, never during daily digest.

- Modify `README.md` and `README.zh-CN.md`
  - Update Univer setup text from "copies template" to "creates workbook and runs scaffold".

- Modify older docs that still describe the checked-in template:
  - `docs/superpowers/specs/2026-05-26-univer-workbook-output-design.md`
  - `docs/superpowers/specs/2026-05-26-univer-workbook-visual-refresh-design.md`
  - `docs/superpowers/plans/2026-05-26-univer-workbook-output.md`
  - `docs/superpowers/plans/2026-05-26-univer-workbook-visual-refresh.md`
  - Mark the old template-copy statements as superseded by the code scaffold initialization spec.

---

### Task 1: Update The Workbook Contract

**Files:**
- Modify: `scripts/lib/univer-workbook-contract.js`
- Modify: `scripts/univer-workbook-contract.test.js`

- [ ] **Step 1: Write the failing path assertion**

In `scripts/univer-workbook-contract.test.js`, replace the template path assertion with:

```javascript
import {
  WORKBOOK_SCAFFOLD_SCRIPT_PATH,
  USER_WORKBOOK_NAME
} from './lib/univer-workbook-contract.js';

test('workbook initialization uses code scaffold path', () => {
  assert.equal(WORKBOOK_SCAFFOLD_SCRIPT_PATH, 'scripts/univer-template-scaffold.js');
  assert.equal(USER_WORKBOOK_NAME, 'follow-builders.univer');
});
```

Remove any import or assertion for `WORKBOOK_TEMPLATE_PATH`.

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
cd scripts && node --test univer-workbook-contract.test.js
```

Expected: FAIL because `WORKBOOK_SCAFFOLD_SCRIPT_PATH` is not exported.

- [ ] **Step 3: Update the contract module**

In `scripts/lib/univer-workbook-contract.js`, replace:

```javascript
export const WORKBOOK_TEMPLATE_PATH = 'templates/follow-builders.univer';
```

with:

```javascript
export const WORKBOOK_SCAFFOLD_SCRIPT_PATH = 'scripts/univer-template-scaffold.js';
```

Leave `USER_WORKBOOK_NAME`, `PUBLIC_URL_PREFIX`, headers, sheet names, and mapping helpers unchanged.

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
cd scripts && node --test univer-workbook-contract.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add scripts/lib/univer-workbook-contract.js scripts/univer-workbook-contract.test.js
git commit -m "refactor: point workbook contract to scaffold script"
```

---

### Task 2: Convert Init Script To Code Scaffold

**Files:**
- Modify: `scripts/init-univer-workbook.js`
- Modify: `scripts/init-univer-workbook.test.js`

- [ ] **Step 1: Rewrite the primary init test for new users**

In `scripts/init-univer-workbook.test.js`, replace the template-copy assertions in
`initializes workbook from template and saves public URL` with a new test named:

```javascript
test('initializes workbook from code scaffold and saves public URL', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fb-init-root-'));
  const home = await mkdtemp(join(tmpdir(), 'fb-init-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(home, { recursive: true, force: true }));

  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'scripts', 'univer-template-scaffold.js'), '() => ({ success: true })', 'utf-8');

  const fakeUniver = join(root, 'fake-univer');
  const calls = join(root, 'calls.log');
  await writeFakeUniver(fakeUniver, calls);

  const result = spawnSync(process.execPath, [
    INIT,
    '--skill-dir', root,
    '--home', home,
    '--univer-path', fakeUniver
  ], { encoding: 'utf-8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const workbookPath = join(home, '.follow-builders', 'follow-builders.univer');
  const config = JSON.parse(await readFile(join(home, '.follow-builders', 'config.json'), 'utf-8'));
  assert.equal(config.univer.enabled, true);
  assert.equal(config.univer.workbookPath, workbookPath);
  assert.equal(config.univer.unitId, 'unit-test-1');
  assert.equal(config.univer.publicUrl, 'https://univer.ai/space/sheets/unit-test-1');
  assert.deepEqual((await readFile(calls, 'utf-8')).trim().split('\n'), [
    `new ${workbookPath} --name Follow Builders`,
    `run ${workbookPath} --file ${join(root, 'scripts', 'univer-template-scaffold.js')}`,
    `inspect workbook ${workbookPath}`,
    `inspect range ${workbookPath} --range raw-data!A1:T1`,
    `inspect range ${workbookPath} --range runs!A1:M1`,
    `inspect range ${workbookPath} --range _week-template!A1:J7`,
    `commit ${workbookPath} --message Initialize follow-builders workbook --json`,
    `sync ${workbookPath} --json`
  ]);
});
```

- [ ] **Step 2: Update the fake univer helper**

Change `writeFakeUniver` in `scripts/init-univer-workbook.test.js` so it supports
the new lifecycle:

```javascript
async function writeFakeUniver(
  path,
  callsPath,
  options = {}
) {
  const syncBody = options.syncBody || `echo '{"success":true,"status":{"unitID":"unit-test-1","uncommittedMutationCount":0}}'; exit 0`;
  const runBody = options.runBody || `echo '{"success":true,"sheets":["raw-data","runs","_week-template"]}'; exit 0`;
  await writeExecutable(path, `#!/bin/sh
printf '%s\\n' "$*" >> "${callsPath}"
case "$1" in
  new)
    mkdir -p "$2"
    echo "new" > "$2/.fake-workbook-marker"
    exit 0
    ;;
  run)
    ${runBody}
    ;;
  inspect)
    echo "# workbook"
    exit 0
    ;;
  commit)
    echo '{"success":true,"committed":true}'
    exit 0
    ;;
  sync)
    ${syncBody}
    ;;
  *)
    echo "unexpected $*" >&2
    exit 2
    ;;
esac
`);
}
```

- [ ] **Step 3: Run the focused init tests and verify they fail**

Run:

```bash
cd scripts && node --test init-univer-workbook.test.js
```

Expected: FAIL because `scripts/init-univer-workbook.js` still imports `WORKBOOK_TEMPLATE_PATH` and copies a template.

- [ ] **Step 4: Update init imports and helpers**

In `scripts/init-univer-workbook.js`:

Remove `WORKBOOK_TEMPLATE_PATH` from imports and import `WORKBOOK_SCAFFOLD_SCRIPT_PATH`:

```javascript
import { publicUrlForUnit, WORKBOOK_SCAFFOLD_SCRIPT_PATH } from './lib/univer-workbook-contract.js';
```

Add JSON parsing for `univer run` output:

```javascript
function parseJsonOutput(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch (err) {
    throw new Error(`Could not parse ${label} JSON output: ${err.message}`);
  }
}
```

Add scaffold result validation:

```javascript
function assertScaffoldSucceeded(scaffoldResult) {
  if (scaffoldResult?.success !== true) {
    throw new Error(`univer scaffold failed: ${scaffoldResult?.error || JSON.stringify(scaffoldResult)}`);
  }
}
```

- [ ] **Step 5: Add code scaffold creation helpers**

In `scripts/init-univer-workbook.js`, replace `replacePath(source, destination)`
usage for template copying with these helpers:

```javascript
async function removePath(path) {
  await rm(path, { recursive: true, force: true });
}

async function backupExistingWorkbook(workbookPath) {
  const backupDir = await mkdtemp(join(tmpdir(), 'follow-builders-univer-backup-'));
  const backupPath = join(backupDir, 'follow-builders.univer');
  await replacePath(workbookPath, backupPath);
  return { backupDir, backupPath };
}

async function createScaffoldedWorkbook({ workbookPath, scaffoldPath, univerPath }) {
  await mkdir(dirname(workbookPath), { recursive: true });
  await runUniver(['new', workbookPath, '--name', 'Follow Builders'], { univerPath });
  const scaffoldOutput = await runUniver(['run', workbookPath, '--file', scaffoldPath], { univerPath });
  assertScaffoldSucceeded(parseJsonOutput(scaffoldOutput.stdout, 'univer run'));
  await runUniver(['inspect', 'workbook', workbookPath], { univerPath });
  await runUniver(['inspect', 'range', workbookPath, '--range', 'raw-data!A1:T1'], { univerPath });
  await runUniver(['inspect', 'range', workbookPath, '--range', 'runs!A1:M1'], { univerPath });
  await runUniver(['inspect', 'range', workbookPath, '--range', '_week-template!A1:J7'], { univerPath });
  const commitResult = await runUniverJson(
    ['commit', workbookPath, '--message', 'Initialize follow-builders workbook'],
    { univerPath }
  );
  if (commitResult.success === false || commitResult.committed === false) {
    throw new Error(`univer commit failed: ${JSON.stringify(commitResult)}`);
  }
}
```

Keep the existing `replacePath` helper because backup restore still needs it.

- [ ] **Step 6: Replace the main initialization branch**

In `main()` of `scripts/init-univer-workbook.js`, use this lifecycle:

```javascript
const scaffoldPath = join(args.skillDir, WORKBOOK_SCAFFOLD_SCRIPT_PATH);
let backupDir;
let backupPath;
let shouldRestoreBackup = false;

if (hasWorkbook && args.force) {
  const backup = await backupExistingWorkbook(workbookPath);
  backupDir = backup.backupDir;
  backupPath = backup.backupPath;
}

try {
  if (!hasWorkbook || args.force) {
    shouldRestoreBackup = Boolean(backupPath);
    await removePath(workbookPath);
    await createScaffoldedWorkbook({
      workbookPath,
      scaffoldPath,
      univerPath: args.univerPath
    });
  } else {
    await runUniver(['inspect', 'workbook', workbookPath], { univerPath: args.univerPath });
  }

  const syncResult = await runUniverJson(['sync', workbookPath], { univerPath: args.univerPath });
  assertSyncSucceeded(syncResult);
  const unitId = extractUnitId(syncResult);
  if (!unitId) {
    throw new Error(`univer sync did not return a unitId: ${JSON.stringify(syncResult)}`);
  }
  const publicUrl = publicUrlForUnit(unitId);

  const next = await updateConfigFile(args.home, current => ({
    ...current,
    univer: {
      ...(current.univer || {}),
      enabled: true,
      workbookPath,
      unitId,
      publicUrl
    }
  }));

  await cleanupBackup(backupDir);
  console.log(JSON.stringify({ status: 'ok', workbookPath, unitId, publicUrl, config: next.univer }, null, 2));
} catch (err) {
  if (shouldRestoreBackup) {
    try {
      await replacePath(backupPath, workbookPath);
    } catch (restoreErr) {
      err.message = `${err.message}; additionally failed to restore workbook backup: ${restoreErr.message}`;
    }
  } else if (!hasWorkbook) {
    await removePath(workbookPath);
  }
  await cleanupBackup(backupDir);
  throw err;
}
```

This is the required boundary: scaffold only runs when the workbook is new or `--force` is passed.

- [ ] **Step 7: Run focused init tests and fix exact call expectations**

Run:

```bash
cd scripts && node --test init-univer-workbook.test.js
```

Expected: PASS after adjusting any existing test names and fake helper call signatures to the new lifecycle.

- [ ] **Step 8: Commit**

Run:

```bash
git add scripts/init-univer-workbook.js scripts/init-univer-workbook.test.js
git commit -m "feat: initialize univer workbook from scaffold code"
```

---

### Task 3: Preserve Existing Workbook And Force Safety Tests

**Files:**
- Modify: `scripts/init-univer-workbook.test.js`

- [ ] **Step 1: Update the existing-workbook test**

Replace the old `uses existing workbook without recopying when force is not set`
expectations with:

```javascript
test('uses existing workbook without running scaffold when force is not set', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fb-init-root-'));
  const home = await mkdtemp(join(tmpdir(), 'fb-init-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(home, { recursive: true, force: true }));

  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'scripts', 'univer-template-scaffold.js'), '() => ({ success: true })', 'utf-8');
  await mkdir(join(home, '.follow-builders'), { recursive: true });
  const workbookPath = join(home, '.follow-builders', 'follow-builders.univer');
  await writeFakeWorkbookPackage(workbookPath, 'existing');

  const fakeUniver = join(root, 'fake-univer');
  const calls = join(root, 'calls.log');
  await writeFakeUniver(fakeUniver, calls);

  const result = spawnSync(process.execPath, [
    INIT,
    '--skill-dir', root,
    '--home', home,
    '--univer-path', fakeUniver
  ], { encoding: 'utf-8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(await readFile(join(workbookPath, 'data', 'marker.txt'), 'utf-8'), 'existing');
  assert.deepEqual((await readFile(calls, 'utf-8')).trim().split('\n'), [
    `inspect workbook ${workbookPath}`,
    `sync ${workbookPath} --json`
  ]);
});
```

- [ ] **Step 2: Add a failed scaffold restore test**

Add:

```javascript
test('restores existing workbook when forced scaffold fails after overwrite', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fb-init-root-'));
  const home = await mkdtemp(join(tmpdir(), 'fb-init-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(home, { recursive: true, force: true }));

  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'scripts', 'univer-template-scaffold.js'), '() => ({ success: false })', 'utf-8');
  await mkdir(join(home, '.follow-builders'), { recursive: true });
  const workbookPath = join(home, '.follow-builders', 'follow-builders.univer');
  await writeFakeWorkbookPackage(workbookPath, 'original');

  const fakeUniver = join(root, 'fake-univer');
  await writeFakeUniver(fakeUniver, join(root, 'calls.log'), {
    runBody: `echo '{"success":false,"error":"scaffold rejected"}'; exit 0`
  });

  const result = spawnSync(process.execPath, [
    INIT,
    '--skill-dir', root,
    '--home', home,
    '--univer-path', fakeUniver,
    '--force'
  ], { encoding: 'utf-8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /scaffold rejected/);
  assert.equal(await readFile(join(workbookPath, 'data', 'marker.txt'), 'utf-8'), 'original');
});
```

- [ ] **Step 3: Keep and adapt the failed sync restore test**

Keep the current sync failure restore test, but remove template package setup and
make its fake `syncBody` fail:

```javascript
await writeFakeUniver(fakeUniver, join(root, 'calls.log'), {
  syncBody: 'echo "sync failed" >&2; exit 9'
});
```

Expected assertion remains:

```javascript
assert.equal(await readFile(join(workbookPath, 'data', 'marker.txt'), 'utf-8'), 'original');
```

- [ ] **Step 4: Run focused init tests**

Run:

```bash
cd scripts && node --test init-univer-workbook.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add scripts/init-univer-workbook.test.js
git commit -m "test: cover scaffold init safety paths"
```

---

### Task 4: Guard Daily Update Against Scaffold Execution

**Files:**
- Modify: `scripts/update-univer-workbook.test.js`

- [ ] **Step 1: Add an update-path guard assertion**

In the existing `updates configured workbook and syncs it` test in
`scripts/update-univer-workbook.test.js`, after reading `loggedCalls`, add:

```javascript
assert.equal(loggedCalls.some(call => call.startsWith(`new ${workbookPath}`)), false);
assert.equal(loggedCalls.some(call => call.includes('univer-template-scaffold.js')), false);
```

If the test uses a differently named call list, add the same assertions to the
test that verifies the normal daily update call sequence.

- [ ] **Step 2: Run the focused update tests**

Run:

```bash
cd scripts && node --test update-univer-workbook.test.js
```

Expected: PASS.

- [ ] **Step 3: Commit**

Run:

```bash
git add scripts/update-univer-workbook.test.js
git commit -m "test: ensure daily update does not scaffold workbook"
```

---

### Task 5: Remove The Checked-In Workbook Template

**Files:**
- Delete: `templates/follow-builders.univer`

- [ ] **Step 1: Remove the template package**

Run:

```bash
rm -rf templates/follow-builders.univer
```

- [ ] **Step 2: Verify no contract code references the deleted path**

Run:

```bash
rg -n "templates/follow-builders\\.univer|WORKBOOK_TEMPLATE_PATH" scripts
```

Expected: no output.

- [ ] **Step 3: Commit**

Run:

```bash
git add -A templates scripts
git commit -m "chore: remove checked-in univer workbook template"
```

---

### Task 6: Update Skill And User Documentation

**Files:**
- Modify: `SKILL.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`

- [ ] **Step 1: Update `SKILL.md` initialization instructions**

Replace copy-template language with this contract text:

````markdown
The initial workbook is built from code, not copied from a repo `.univer`
template. During setup, run:

```bash
cd ${CLAUDE_SKILL_DIR}/scripts && node init-univer-workbook.js
```

The init script creates `~/.follow-builders/follow-builders.univer` with
`univer new`, runs `${CLAUDE_SKILL_DIR}/scripts/univer-template-scaffold.js`
with `univer run --file`, commits the initialized workbook, syncs it, then
stores `univer.unitId` and
`https://univer.ai/space/sheets/<unit-id>` in
`~/.follow-builders/config.json`.

The scaffold script is initialization-only. Do not run it from daily digest,
cron, `run-llm-digest.js`, or `update-univer-workbook.js`; daily updates must
only mutate the already initialized workbook.
````

- [ ] **Step 2: Update README setup wording**

In `README.md`, replace:

```markdown
Initialization copies `templates/follow-builders.univer`, runs `univer sync`,
and stores the returned `unitId` plus public Univer URL in your local config.
```

with:

```markdown
Initialization creates `~/.follow-builders/follow-builders.univer` with
`univer new`, applies `scripts/univer-template-scaffold.js` with
`univer run --file`, commits the initialized workbook, runs `univer sync`, and
stores the returned `unitId` plus public Univer URL in your local config.
The scaffold runs only during setup or explicit reinitialization, not during
daily digest updates.
```

- [ ] **Step 3: Update Chinese README setup wording**

In `README.zh-CN.md`, replace the equivalent copy-template sentence with:

```markdown
初始化会通过 `univer new` 创建
`~/.follow-builders/follow-builders.univer`，再用
`univer run --file scripts/univer-template-scaffold.js` 应用初始布局，
随后提交本地 workbook、执行 `univer sync`，并把返回的 `unitId` 和公开
URL 写入本地配置。scaffold 只在 setup 或显式重新初始化时执行，日常摘要
更新不会执行 scaffold。
```

- [ ] **Step 4: Verify no user-facing docs still claim template copy is current**

Run:

```bash
rg -n "copies `templates/follow-builders\\.univer`|Copy `templates/follow-builders\\.univer`|复制 `templates/follow-builders\\.univer`|repo template|checked-in.*template" SKILL.md README.md README.zh-CN.md
```

Expected: no output for current instructions. Historical docs under `docs/superpowers` are handled in Task 7.

- [ ] **Step 5: Commit**

Run:

```bash
git add SKILL.md README.md README.zh-CN.md
git commit -m "docs: document code scaffold workbook setup"
```

---

### Task 7: Update Historical Planning Docs To Avoid Drift

**Files:**
- Modify: `docs/superpowers/specs/2026-05-26-univer-workbook-output-design.md`
- Modify: `docs/superpowers/specs/2026-05-26-univer-workbook-visual-refresh-design.md`
- Modify: `docs/superpowers/plans/2026-05-26-univer-workbook-output.md`
- Modify: `docs/superpowers/plans/2026-05-26-univer-workbook-visual-refresh.md`

- [ ] **Step 1: Add a supersession note to the older output spec**

Near the top of `docs/superpowers/specs/2026-05-26-univer-workbook-output-design.md`, add:

```markdown
> Supersession note, 2026-05-26: checked-in
> `templates/follow-builders.univer` has been replaced by code scaffold
> initialization. The current setup flow uses `univer new` plus
> `univer run --file scripts/univer-template-scaffold.js`; daily updates still
> do not rebuild the workbook layout.
```

- [ ] **Step 2: Replace older template lifecycle bullets**

In the same spec, replace the bullets that say the repo stores an unsynced
template and user setup copies it with bullets saying:

```markdown
- The repo stores workbook initialization as code in
  `scripts/univer-template-scaffold.js`.
- User setup creates a blank workbook with `univer new`, runs the scaffold once,
  commits the initialized workbook, then runs `univer sync`.
```

- [ ] **Step 3: Add a supersession note to the visual refresh spec**

Near the top of `docs/superpowers/specs/2026-05-26-univer-workbook-visual-refresh-design.md`, add:

```markdown
> Supersession note, 2026-05-26: `_week-template` is still defined by the
> scaffold script, but the repo no longer stores a checked-in `.univer`
> template. Setup builds the user workbook from code.
```

- [ ] **Step 4: Add supersession notes to older implementation plans**

Near the top of each older plan file, add:

```markdown
> Supersession note, 2026-05-26: steps that create, copy, or commit
> `templates/follow-builders.univer` are obsolete. Use the code scaffold
> initialization plan instead.
```

- [ ] **Step 5: Verify historical references are either removed or marked superseded**

Run:

```bash
rg -n "templates/follow-builders\\.univer|repo template|checked-in.*template" docs/superpowers
```

Expected: matches are acceptable only inside supersession notes or explicitly historical sections.

- [ ] **Step 6: Commit**

Run:

```bash
git add docs/superpowers
git commit -m "docs: mark univer template plan as superseded"
```

---

### Task 8: Run Full Verification And New-User Acceptance

**Files:**
- No planned source edits.

- [ ] **Step 1: Run all script tests**

Run:

```bash
cd scripts && npm test
```

Expected: all tests pass.

- [ ] **Step 2: Run whitespace diff check**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 3: Run isolated new-user acceptance with fake sync**

Use a temporary HOME and fake only `sync`, while delegating `new`, `run`,
`inspect`, and `commit` to the real `univer` CLI:

```bash
REAL_UNIVER=$(command -v univer)
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/follow-builders-code-scaffold-acceptance.XXXXXX")
HOME_DIR="$ROOT/home"
mkdir -p "$HOME_DIR"
FAKE_UNIVER="$ROOT/fake-univer"
CALLS="$ROOT/univer-calls.log"
cat > "$FAKE_UNIVER" <<SH
#!/bin/sh
printf '%s\\n' "\$*" >> "$CALLS"
if [ "\$1" = "sync" ]; then
  echo '{"success":true,"unitId":"acceptance-code-scaffold-unit","status":{"unitID":"acceptance-code-scaffold-unit","uncommittedMutationCount":0}}'
  exit 0
fi
exec "$REAL_UNIVER" "\$@"
SH
chmod +x "$FAKE_UNIVER"

node scripts/init-univer-workbook.js --home "$HOME_DIR" --univer-path "$FAKE_UNIVER"
WB="$HOME_DIR/.follow-builders/follow-builders.univer"
univer inspect workbook "$WB"
univer inspect range "$WB" --range 'raw-data!A1:T1'
univer inspect range "$WB" --range 'runs!A1:M1'
univer inspect range "$WB" --range '_week-template!A1:J7'
cat "$HOME_DIR/.follow-builders/config.json"
cat "$CALLS"
```

Expected:

- `config.json` contains `acceptance-code-scaffold-unit`.
- `raw-data`, `runs`, and `_week-template` are visible.
- `CALLS` contains `new`, `run ... scripts/univer-template-scaffold.js`, `commit`, and `sync`.

- [ ] **Step 4: Run one daily update against the accepted workbook**

Create a small `items.json`, run:

```bash
node scripts/update-univer-workbook.js \
  --home "$HOME_DIR" \
  --univer-path "$FAKE_UNIVER" \
  --items-json "$ROOT/items.json" \
  --markdown-path "$ROOT/digest.md"
```

Then verify:

```bash
univer inspect range "$WB" --range 'raw-data!A1:T5'
univer inspect range "$WB" --range 'runs!A1:M3'
univer pipe out "$WB" --range '2026-W22!A4:J10' --type formula --format tsv
cat "$CALLS"
```

Expected:

- `raw-data` includes inserted rows.
- `runs` includes the update row.
- Weekly sheet formulas reference `raw-data`.
- No call in `CALLS` after the initial setup contains `new` or
  `univer-template-scaffold.js`.

- [ ] **Step 5: Final status**

Run:

```bash
git status --short
```

Expected: no uncommitted changes.

---

## Self-Review Checklist

- Spec coverage:
  - Removes checked-in template: Task 5.
  - Initializes through `univer new` and `univer run`: Task 2.
  - Runs scaffold only during init or `--force`: Tasks 2, 3, 4, and 8.
  - Preserves existing workbook unless `--force`: Task 3.
  - Updates docs and prevents drift: Tasks 6 and 7.
  - Acceptance with temporary HOME: Task 8.
- Placeholder scan: no unresolved placeholder language or open-ended implementation steps.
- Type consistency: the plan uses `WORKBOOK_SCAFFOLD_SCRIPT_PATH` consistently and keeps existing `USER_WORKBOOK_NAME`, sheet names, and header constants unchanged.
