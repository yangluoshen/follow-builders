# Univer Workbook Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a long-lived Univer workbook output that stores raw captured content, renders weekly human-readable sheets, syncs to a public Univer URL, and preserves Markdown as the primary Telegram delivery format.

**Architecture:** Keep workbook data contracts in small Node modules, use Codex only to generate Markdown plus a structured `items.json`, and use deterministic scripts to initialize and update `.univer` files through public `univer` CLI commands. The repo ships a committed, unsynced workbook template; user setup copies it, syncs once, and daily runs only edit the user's workbook copy.

**Tech Stack:** Node.js ESM, built-in `node:test`, existing `codex` runner, `univer` CLI, JSON config in `~/.follow-builders/config.json`.

---

## File Structure

- Create `scripts/lib/follow-builders-config.js`
  - Reads and writes `~/.follow-builders/config.json`.
  - Owns user-dir paths so runner, init, and updater do not duplicate path logic.

- Create `scripts/lib/univer-workbook-contract.js`
  - Exports workbook sheet names, headers, config defaults, stable content ID generation, item payload validation, raw row mapping, weekly grouping, and Markdown URL appending.
  - Contains no `univer` calls.

- Create `scripts/lib/univer-command.js`
  - Thin `child_process.spawn` wrapper for `univer`.
  - Treats non-zero exits as failures and returns stdout/stderr cleanly.

- Create `scripts/init-univer-workbook.js`
  - Copies `templates/follow-builders.univer` to `~/.follow-builders/follow-builders.univer`.
  - Runs `univer inspect workbook`, then `univer sync`.
  - Extracts `unitId`, writes `config.univer.publicUrl`.

- Create `scripts/update-univer-workbook.js`
  - Reads `items.json`.
  - Ensures user workbook exists or initializes it when no existing unit binding is present.
  - Generates a temporary `univer run` script that upserts `raw-data`, appends `runs`, and refreshes the current weekly sheet display area.
  - Verifies workbook-visible state and runs `univer sync`.

- Create `scripts/univer-template-scaffold.js`
  - Workbook-local `univer run` scaffold used to build `templates/follow-builders.univer`.
  - Creates `raw-data`, `runs`, `_week-template`, and an initial weekly sheet with layout, formatting, formulas, and conditional formatting.

- Add `templates/follow-builders.univer`
  - Created by `univer new`, `univer run --file scripts/univer-template-scaffold.js`, then `univer commit`.
  - Must be committed locally and unsynced.

- Modify `scripts/run-llm-digest.js`
  - Adds an `itemsJsonPath` artifact.
  - Prompts Codex to write both Markdown and structured JSON.
  - Calls `update-univer-workbook.js` before delivery.
  - Appends configured public URL to Markdown before delivery.
  - Keeps workbook failures non-blocking.

- Modify `scripts/run-llm-digest.test.js`
  - Updates fake Codex tests for the new `items.json` requirement.
  - Adds fallback behavior tests for workbook update failure.

- Modify `scripts/package.json`
  - Runs all `*.test.js` files.

- Create `scripts/univer-workbook-contract.test.js`
  - Unit tests for pure contract functions.

- Create `scripts/update-univer-workbook.test.js`
  - Unit tests with a fake `univer` executable for runner/update behavior that should not require a real remote sync.

- Modify `config/config-schema.json`
  - Adds `univer` config object.

- Modify `SKILL.md`
  - Adds the workbook contract, initialization workflow, daily update constraints, sync behavior, and failure handling.

- Modify `README.md` and `README.zh-CN.md`
  - Documents the local Univer workbook output and public URL.

---

### Task 1: Add Contract And Pure Helpers

**Files:**
- Create: `scripts/lib/univer-workbook-contract.js`
- Create: `scripts/univer-workbook-contract.test.js`
- Modify: `scripts/package.json`

- [ ] **Step 1: Write failing tests for content IDs, schema validation, grouping, and Markdown URL append**

Create `scripts/univer-workbook-contract.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RAW_DATA_HEADERS,
  RUNS_HEADERS,
  appendWorkbookUrl,
  buildContentId,
  groupWeeklyDisplayRows,
  mapItemToRawRow,
  validateItemsPayload
} from './lib/univer-workbook-contract.js';

test('exports fixed raw-data and runs headers', () => {
  assert.deepEqual(RAW_DATA_HEADERS, [
    'contentId',
    'sourceType',
    'sourceName',
    'authorName',
    'authorHandle',
    'title',
    'url',
    'publishedAt',
    'capturedAt',
    'runDate',
    'textExcerpt',
    'summary',
    'keyPoints',
    'topics',
    'importanceScore',
    'likes',
    'retweets',
    'replies',
    'rawSourceKey',
    'updatedAt'
  ]);
  assert.deepEqual(RUNS_HEADERS, [
    'runId',
    'startedAt',
    'finishedAt',
    'status',
    'itemsSeen',
    'itemsInserted',
    'itemsUpdated',
    'markdownPath',
    'itemsJsonPath',
    'syncStatus',
    'unitId',
    'publicUrl',
    'errorSummary'
  ]);
});

test('buildContentId creates stable ids for each source type', () => {
  assert.equal(buildContentId({ sourceType: 'x', id: '2058609058714968194' }), 'x:2058609058714968194');
  assert.equal(buildContentId({ sourceType: 'podcast', guid: 'episode-guid' }), 'podcast:episode-guid');
  assert.equal(
    buildContentId({ sourceType: 'blog', url: 'https://example.com/Posts/Hello?utm_source=x#top' }),
    'blog:2a0963351a95'
  );
});

test('validateItemsPayload rejects malformed payloads', () => {
  assert.throws(
    () => validateItemsPayload({ items: [{ sourceType: 'x', title: 'missing id' }] }),
    /items\[0\]\.contentId is required/
  );
  assert.doesNotThrow(() => validateItemsPayload({
    runId: 'run-1',
    generatedAt: '2026-05-26T00:00:00.000Z',
    items: [{
      contentId: 'x:1',
      sourceType: 'x',
      sourceName: 'X',
      title: 'A tweet',
      url: 'https://x.com/a/status/1',
      publishedAt: '2026-05-26T01:00:00.000Z',
      capturedAt: '2026-05-26T02:00:00.000Z',
      runDate: '2026-05-26',
      textExcerpt: 'excerpt',
      summary: 'summary',
      keyPoints: ['point'],
      topics: ['agents'],
      importanceScore: 80
    }]
  }));
});

test('mapItemToRawRow aligns item fields to RAW_DATA_HEADERS', () => {
  const row = mapItemToRawRow({
    contentId: 'x:1',
    sourceType: 'x',
    sourceName: 'X',
    authorName: 'Ada',
    authorHandle: 'ada',
    title: 'Title',
    url: 'https://x.com/ada/status/1',
    publishedAt: '2026-05-26T01:00:00.000Z',
    capturedAt: '2026-05-26T02:00:00.000Z',
    runDate: '2026-05-26',
    textExcerpt: 'excerpt',
    summary: 'summary',
    keyPoints: ['one', 'two'],
    topics: ['agents', 'tools'],
    importanceScore: 88,
    likes: 10,
    retweets: 2,
    replies: 3,
    rawSourceKey: 'tweet:1',
    updatedAt: '2026-05-26T03:00:00.000Z'
  });
  assert.equal(row.length, RAW_DATA_HEADERS.length);
  assert.equal(row[0], 'x:1');
  assert.equal(row[12], 'one\n- two');
  assert.equal(row[13], 'agents, tools');
  assert.equal(row[14], 88);
});

test('groupWeeklyDisplayRows sorts dates descending and sources X, Podcast, Blog', () => {
  const rows = groupWeeklyDisplayRows([
    { contentId: 'blog:1', sourceType: 'blog', sourceName: 'Claude Blog', title: 'Blog', summary: 'B', keyPoints: ['b'], topics: ['release'], importanceScore: 60, url: 'https://example.com/b', publishedAt: '2026-05-25T01:00:00.000Z', runDate: '2026-05-25' },
    { contentId: 'podcast:1', sourceType: 'podcast', sourceName: 'Latent Space', title: 'Podcast', summary: 'P', keyPoints: ['p'], topics: ['research'], importanceScore: 70, url: 'https://youtube.com/p', publishedAt: '2026-05-26T01:00:00.000Z', runDate: '2026-05-26' },
    { contentId: 'x:1', sourceType: 'x', sourceName: 'X', title: 'Tweet', summary: 'X', keyPoints: ['x'], topics: ['agents'], importanceScore: 90, url: 'https://x.com/a/status/1', publishedAt: '2026-05-26T02:00:00.000Z', runDate: '2026-05-26' }
  ]);
  assert.deepEqual(rows.map(row => row[0]), ['2026-05-26', '2026-05-26', '2026-05-25']);
  assert.deepEqual(rows.map(row => row[1]), ['X', 'Podcast', 'Blog']);
});

test('appendWorkbookUrl appends one link and avoids duplicates', () => {
  const once = appendWorkbookUrl('Digest body\n', 'https://univer.ai/space/sheets/unit-1');
  assert.match(once, /Univer workbook: https:\/\/univer\.ai\/space\/sheets\/unit-1/);
  const twice = appendWorkbookUrl(once, 'https://univer.ai/space/sheets/unit-1');
  assert.equal(twice.match(/Univer workbook:/g).length, 1);
});
```

- [ ] **Step 2: Run the tests and verify they fail because the module does not exist**

Run:

```bash
cd scripts && node --test univer-workbook-contract.test.js
```

Expected:

```text
ERR_MODULE_NOT_FOUND
```

- [ ] **Step 3: Implement the contract module**

Create `scripts/lib/univer-workbook-contract.js`:

```javascript
import { createHash } from 'crypto';

export const WORKBOOK_TEMPLATE_PATH = 'templates/follow-builders.univer';
export const USER_WORKBOOK_NAME = 'follow-builders.univer';
export const PUBLIC_URL_PREFIX = 'https://univer.ai/space/sheets/';

export const SHEETS = Object.freeze({
  rawData: 'raw-data',
  runs: 'runs',
  weekTemplate: '_week-template'
});

export const RAW_DATA_HEADERS = Object.freeze([
  'contentId',
  'sourceType',
  'sourceName',
  'authorName',
  'authorHandle',
  'title',
  'url',
  'publishedAt',
  'capturedAt',
  'runDate',
  'textExcerpt',
  'summary',
  'keyPoints',
  'topics',
  'importanceScore',
  'likes',
  'retweets',
  'replies',
  'rawSourceKey',
  'updatedAt'
]);

export const RUNS_HEADERS = Object.freeze([
  'runId',
  'startedAt',
  'finishedAt',
  'status',
  'itemsSeen',
  'itemsInserted',
  'itemsUpdated',
  'markdownPath',
  'itemsJsonPath',
  'syncStatus',
  'unitId',
  'publicUrl',
  'errorSummary'
]);

export const WEEK_DISPLAY_HEADERS = Object.freeze([
  'Date',
  'Type',
  'Source',
  'Title',
  'Summary',
  'Key Points',
  'Topics',
  'Score',
  'URL',
  'contentId'
]);

const SOURCE_LABELS = Object.freeze({
  x: 'X',
  podcast: 'Podcast',
  blog: 'Blog'
});

const SOURCE_ORDER = Object.freeze({
  x: 0,
  podcast: 1,
  blog: 2
});

export function normalizeBlogUrl(url) {
  const parsed = new URL(url);
  parsed.hash = '';
  for (const key of [...parsed.searchParams.keys()]) {
    if (key.toLowerCase().startsWith('utm_')) parsed.searchParams.delete(key);
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '').toLowerCase();
  return parsed.toString();
}

export function buildContentId(item) {
  if (item.contentId) return item.contentId;
  if (item.sourceType === 'x' && item.id) return `x:${item.id}`;
  if (item.sourceType === 'podcast' && item.guid) return `podcast:${item.guid}`;
  if (item.sourceType === 'blog' && item.url) {
    return `blog:${createHash('sha256').update(normalizeBlogUrl(item.url)).digest('hex').slice(0, 12)}`;
  }
  throw new Error('Cannot build contentId: unsupported item identity');
}

function toListText(value) {
  if (Array.isArray(value)) return value.map(String).join('\n- ');
  return value ? String(value) : '';
}

function toTopicText(value) {
  if (Array.isArray(value)) return value.map(String).join(', ');
  return value ? String(value) : '';
}

function requireString(value, label) {
  if (!value || typeof value !== 'string') throw new Error(`${label} is required`);
}

export function validateItemsPayload(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('items payload must be an object');
  if (!Array.isArray(payload.items)) throw new Error('items payload must include items array');
  payload.items.forEach((item, index) => {
    requireString(item.contentId, `items[${index}].contentId`);
    requireString(item.sourceType, `items[${index}].sourceType`);
    requireString(item.title, `items[${index}].title`);
    requireString(item.url, `items[${index}].url`);
    if (!['x', 'podcast', 'blog'].includes(item.sourceType)) {
      throw new Error(`items[${index}].sourceType must be x, podcast, or blog`);
    }
  });
  return payload;
}

export function mapItemToRawRow(item, updatedAt = item.updatedAt || new Date().toISOString()) {
  return [
    item.contentId,
    item.sourceType || '',
    item.sourceName || '',
    item.authorName || '',
    item.authorHandle || '',
    item.title || '',
    item.url || '',
    item.publishedAt || '',
    item.capturedAt || '',
    item.runDate || '',
    item.textExcerpt || '',
    item.summary || '',
    toListText(item.keyPoints),
    toTopicText(item.topics),
    Number.isFinite(Number(item.importanceScore)) ? Number(item.importanceScore) : '',
    Number.isFinite(Number(item.likes)) ? Number(item.likes) : '',
    Number.isFinite(Number(item.retweets)) ? Number(item.retweets) : '',
    Number.isFinite(Number(item.replies)) ? Number(item.replies) : '',
    item.rawSourceKey || '',
    updatedAt
  ];
}

export function groupWeeklyDisplayRows(items) {
  return [...items]
    .sort((a, b) => {
      const dateCompare = String(b.runDate || '').localeCompare(String(a.runDate || ''));
      if (dateCompare !== 0) return dateCompare;
      const sourceCompare = (SOURCE_ORDER[a.sourceType] ?? 99) - (SOURCE_ORDER[b.sourceType] ?? 99);
      if (sourceCompare !== 0) return sourceCompare;
      const publishedCompare = String(b.publishedAt || '').localeCompare(String(a.publishedAt || ''));
      if (publishedCompare !== 0) return publishedCompare;
      return Number(b.importanceScore || 0) - Number(a.importanceScore || 0);
    })
    .map(item => [
      item.runDate || '',
      SOURCE_LABELS[item.sourceType] || item.sourceType || '',
      item.sourceName || item.authorName || '',
      item.title || '',
      item.summary || '',
      toListText(item.keyPoints),
      toTopicText(item.topics),
      Number.isFinite(Number(item.importanceScore)) ? Number(item.importanceScore) : '',
      item.url || '',
      item.contentId || ''
    ]);
}

export function appendWorkbookUrl(markdown, publicUrl) {
  if (!publicUrl) return markdown;
  const line = `Univer workbook: ${publicUrl}`;
  if (markdown.includes(line)) return markdown;
  return `${markdown.trimEnd()}\n\n${line}\n`;
}

export function publicUrlForUnit(unitId) {
  if (!unitId) return null;
  return `${PUBLIC_URL_PREFIX}${unitId}`;
}
```

- [ ] **Step 4: Update the test script to run all tests**

Modify `scripts/package.json`:

```json
{
  "name": "follow-builders-scripts",
  "version": "1.0.0",
  "description": "Scripts for Follow Builders skill — feed generation, digest preparation, delivery",
  "type": "module",
  "scripts": {
    "generate-feed": "node generate-feed.js",
    "prepare-digest": "node prepare-digest.js",
    "llm-digest": "node run-llm-digest.js --agent codex",
    "test": "node --test *.test.js"
  },
  "dependencies": {
    "dotenv": "^16.4.0",
    "proper-lockfile": "^4.1.0"
  }
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
cd scripts && npm test
```

Expected:

```text
# pass
```

- [ ] **Step 6: Commit**

```bash
git add scripts/package.json scripts/lib/univer-workbook-contract.js scripts/univer-workbook-contract.test.js
git commit -m "feat: add univer workbook contract"
```

---

### Task 2: Add Config And Univer Command Helpers

**Files:**
- Create: `scripts/lib/follow-builders-config.js`
- Create: `scripts/lib/univer-command.js`
- Create: `scripts/univer-command.test.js`

- [ ] **Step 1: Write failing tests for config paths and command wrapper behavior**

Create `scripts/univer-command.test.js`:

```javascript
import { chmod, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  configPath,
  defaultUserDir,
  readConfigFile,
  updateConfigFile,
  userWorkbookPath
} from './lib/follow-builders-config.js';
import { runUniver } from './lib/univer-command.js';

async function writeExecutable(path, text) {
  await writeFile(path, text, 'utf-8');
  await chmod(path, 0o755);
}

test('config helpers use the provided home directory', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fb-config-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  assert.equal(defaultUserDir(home), join(home, '.follow-builders'));
  assert.equal(configPath(home), join(home, '.follow-builders', 'config.json'));
  assert.equal(userWorkbookPath(home), join(home, '.follow-builders', 'follow-builders.univer'));

  await updateConfigFile(home, current => ({
    ...current,
    language: 'en',
    univer: { enabled: true, unitId: 'unit-1' }
  }));
  const saved = JSON.parse(await readFile(configPath(home), 'utf-8'));
  assert.equal(saved.univer.unitId, 'unit-1');
  assert.equal((await readConfigFile(home)).language, 'en');
});

test('runUniver returns stdout for successful commands', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fb-univer-bin-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = join(dir, 'univer');
  await writeExecutable(fake, '#!/bin/sh\nprintf "ok:$*"\n');

  const result = await runUniver(['inspect', 'workbook', './book.univer'], { univerPath: fake });
  assert.equal(result.stdout, 'ok:inspect workbook ./book.univer');
});

test('runUniver throws with stderr on failure', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fb-univer-bin-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = join(dir, 'univer');
  await writeExecutable(fake, '#!/bin/sh\necho "bad command" >&2\nexit 9\n');

  await assert.rejects(
    () => runUniver(['sync', './book.univer'], { univerPath: fake }),
    /univer sync .* failed with exit code 9: bad command/
  );
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
cd scripts && node --test univer-command.test.js
```

Expected:

```text
ERR_MODULE_NOT_FOUND
```

- [ ] **Step 3: Implement config helper**

Create `scripts/lib/follow-builders-config.js`:

```javascript
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

export function defaultUserDir(home = homedir()) {
  return join(home, '.follow-builders');
}

export function configPath(home = homedir()) {
  return join(defaultUserDir(home), 'config.json');
}

export function userWorkbookPath(home = homedir()) {
  return join(defaultUserDir(home), 'follow-builders.univer');
}

export async function readConfigFile(home = homedir()) {
  try {
    return JSON.parse(await readFile(configPath(home), 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`Could not read config: ${err.message}`);
  }
}

export async function writeConfigFile(config, home = homedir()) {
  await mkdir(defaultUserDir(home), { recursive: true });
  await writeFile(configPath(home), `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

export async function updateConfigFile(home, updater) {
  const current = await readConfigFile(home);
  const next = await updater(current);
  await writeConfigFile(next, home);
  return next;
}
```

- [ ] **Step 4: Implement `univer` command wrapper**

Create `scripts/lib/univer-command.js`:

```javascript
import { spawn } from 'child_process';

export function runUniver(args, options = {}) {
  const univerPath = options.univerPath || process.env.FOLLOW_BUILDERS_UNIVER_PATH || 'univer';
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;

  return new Promise((resolve, reject) => {
    const child = spawn(univerPath, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];

    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', code => {
      const out = Buffer.concat(stdout).toString('utf-8');
      const err = Buffer.concat(stderr).toString('utf-8');
      if (code !== 0) {
        reject(new Error(`univer ${args.join(' ')} failed with exit code ${code}: ${err.trim() || out.trim()}`));
        return;
      }
      resolve({ stdout: out, stderr: err });
    });
  });
}

export async function runUniverJson(args, options = {}) {
  const result = await runUniver([...args, '--json'], options);
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(`Could not parse univer JSON output for ${args.join(' ')}: ${err.message}`);
  }
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
cd scripts && npm test
```

Expected:

```text
# pass
```

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/follow-builders-config.js scripts/lib/univer-command.js scripts/univer-command.test.js
git commit -m "feat: add univer command helpers"
```

---

### Task 3: Add Workbook Initialization Script

**Files:**
- Create: `scripts/init-univer-workbook.js`
- Create: `scripts/init-univer-workbook.test.js`
- Modify: `config/config-schema.json`

- [ ] **Step 1: Write failing tests for initialization**

Create `scripts/init-univer-workbook.test.js`:

```javascript
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

const SCRIPT_DIR = new URL('.', import.meta.url).pathname;
const INIT = join(SCRIPT_DIR, 'init-univer-workbook.js');

async function writeExecutable(path, text) {
  await writeFile(path, text, 'utf-8');
  await chmod(path, 0o755);
}

test('initializes workbook from template and saves public URL', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fb-init-root-'));
  const home = await mkdtemp(join(tmpdir(), 'fb-init-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(home, { recursive: true, force: true }));

  await mkdir(join(root, 'templates'), { recursive: true });
  await writeFile(join(root, 'templates', 'follow-builders.univer'), 'template', 'utf-8');

  const fakeUniver = join(root, 'fake-univer');
  await writeExecutable(fakeUniver, `#!/bin/sh
case "$1 $2" in
  "inspect workbook") echo "# workbook"; exit 0 ;;
  "sync "*) echo '{"success":true,"unitId":"unit-test-1"}'; exit 0 ;;
  *) echo "unexpected $*" >&2; exit 2 ;;
esac
`);

  const result = spawnSync(process.execPath, [
    INIT,
    '--skill-dir', root,
    '--home', home,
    '--univer-path', fakeUniver
  ], { encoding: 'utf-8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const config = JSON.parse(await readFile(join(home, '.follow-builders', 'config.json'), 'utf-8'));
  assert.equal(config.univer.unitId, 'unit-test-1');
  assert.equal(config.univer.publicUrl, 'https://univer.ai/space/sheets/unit-test-1');
});

test('does not overwrite an existing remote binding when workbook is missing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fb-init-root-'));
  const home = await mkdtemp(join(tmpdir(), 'fb-init-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(home, { recursive: true, force: true }));

  await mkdir(join(home, '.follow-builders'), { recursive: true });
  await writeFile(join(home, '.follow-builders', 'config.json'), JSON.stringify({
    univer: { unitId: 'existing', publicUrl: 'https://univer.ai/space/sheets/existing' }
  }), 'utf-8');

  const result = spawnSync(process.execPath, [
    INIT,
    '--skill-dir', root,
    '--home', home
  ], { encoding: 'utf-8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /workbook is missing but config already has a Univer unitId/);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
cd scripts && node --test init-univer-workbook.test.js
```

Expected:

```text
MODULE_NOT_FOUND
```

- [ ] **Step 3: Implement `init-univer-workbook.js`**

Create `scripts/init-univer-workbook.js`:

```javascript
#!/usr/bin/env node

import { access, copyFile, mkdir } from 'fs/promises';
import { constants } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { readConfigFile, updateConfigFile, userWorkbookPath } from './lib/follow-builders-config.js';
import { publicUrlForUnit, WORKBOOK_TEMPLATE_PATH } from './lib/univer-workbook-contract.js';
import { runUniver, runUniverJson } from './lib/univer-command.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SKILL_DIR = join(SCRIPT_DIR, '..');

function parseArgs(argv) {
  const out = {
    skillDir: DEFAULT_SKILL_DIR,
    home: homedir(),
    univerPath: process.env.FOLLOW_BUILDERS_UNIVER_PATH || 'univer',
    force: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--skill-dir') out.skillDir = argv[++i];
    else if (arg === '--home') out.home = argv[++i];
    else if (arg === '--univer-path') out.univerPath = argv[++i];
    else if (arg === '--force') out.force = true;
    else if (arg === '--help') out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function extractUnitId(syncResult) {
  return syncResult.unitId || syncResult.unitID || syncResult.remoteUnitId || syncResult.status?.unitId;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node init-univer-workbook.js [--skill-dir PATH] [--home PATH] [--univer-path PATH] [--force]');
    return;
  }

  const workbookPath = userWorkbookPath(args.home);
  const config = await readConfigFile(args.home);
  const hasWorkbook = await exists(workbookPath);
  if (!hasWorkbook && config.univer?.unitId && !args.force) {
    throw new Error('Univer workbook is missing but config already has a Univer unitId. Use an explicit reset or migration flow.');
  }

  if (!hasWorkbook || args.force) {
    const templatePath = join(args.skillDir, WORKBOOK_TEMPLATE_PATH);
    await mkdir(dirname(workbookPath), { recursive: true });
    await copyFile(templatePath, workbookPath);
  }

  await runUniver(['inspect', 'workbook', workbookPath], { univerPath: args.univerPath });
  const syncResult = await runUniverJson(['sync', workbookPath], { univerPath: args.univerPath });
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

  console.log(JSON.stringify({ status: 'ok', workbookPath, unitId, publicUrl, config: next.univer }, null, 2));
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
```

- [ ] **Step 4: Extend the config schema**

Modify `config/config-schema.json` and add this sibling property under top-level `properties`:

```json
"univer": {
  "type": "object",
  "description": "Local Univer workbook output configuration",
  "properties": {
    "enabled": {
      "type": "boolean",
      "default": true,
      "description": "Whether daily runs should update the Univer workbook"
    },
    "workbookPath": {
      "type": "string",
      "description": "Path to the user's long-lived .univer workbook"
    },
    "unitId": {
      "type": "string",
      "description": "Remote Univer workbook unit id created by first sync"
    },
    "publicUrl": {
      "type": "string",
      "description": "Public Univer workbook URL"
    }
  }
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
cd scripts && npm test
```

Expected:

```text
# pass
```

- [ ] **Step 6: Commit**

```bash
git add scripts/init-univer-workbook.js scripts/init-univer-workbook.test.js config/config-schema.json
git commit -m "feat: initialize univer workbook"
```

---

### Task 4: Add Workbook Update Script

**Files:**
- Create: `scripts/update-univer-workbook.js`
- Create: `scripts/update-univer-workbook.test.js`

- [ ] **Step 1: Write failing tests for update orchestration and graceful failure**

Create `scripts/update-univer-workbook.test.js`:

```javascript
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

const SCRIPT_DIR = new URL('.', import.meta.url).pathname;
const UPDATE = join(SCRIPT_DIR, 'update-univer-workbook.js');

async function writeExecutable(path, text) {
  await writeFile(path, text, 'utf-8');
  await chmod(path, 0o755);
}

function sampleItems() {
  return {
    runId: 'run-1',
    generatedAt: '2026-05-26T02:00:00.000Z',
    items: [{
      contentId: 'x:1',
      sourceType: 'x',
      sourceName: 'X',
      authorName: 'Ada',
      authorHandle: 'ada',
      title: 'Tweet title',
      url: 'https://x.com/ada/status/1',
      publishedAt: '2026-05-26T01:00:00.000Z',
      capturedAt: '2026-05-26T02:00:00.000Z',
      runDate: '2026-05-26',
      textExcerpt: 'excerpt',
      summary: 'summary',
      keyPoints: ['point'],
      topics: ['agents'],
      importanceScore: 80
    }]
  };
}

test('runs inspect, run, inspect, and sync against configured workbook', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fb-update-home-'));
  const dir = await mkdtemp(join(tmpdir(), 'fb-update-bin-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const workbookPath = join(home, '.follow-builders', 'follow-builders.univer');
  await mkdir(join(home, '.follow-builders'), { recursive: true });
  await writeFile(workbookPath, 'workbook', 'utf-8');
  await writeFile(join(home, '.follow-builders', 'config.json'), JSON.stringify({
    univer: { enabled: true, workbookPath, unitId: 'unit-1', publicUrl: 'https://univer.ai/space/sheets/unit-1' }
  }), 'utf-8');
  const itemsPath = join(dir, 'items.json');
  await writeFile(itemsPath, JSON.stringify(sampleItems()), 'utf-8');
  const callsPath = join(dir, 'calls.log');

  const fakeUniver = join(dir, 'univer');
  await writeExecutable(fakeUniver, `#!/bin/sh
echo "$*" >> ${callsPath}
case "$1" in
  inspect) echo "# ok"; exit 0 ;;
  run) echo '{"success":true,"inserted":1,"updated":0,"weeklyRows":1}'; exit 0 ;;
  sync) echo '{"success":true,"unitId":"unit-1"}'; exit 0 ;;
  *) echo "unexpected $*" >&2; exit 2 ;;
esac
`);

  const result = spawnSync(process.execPath, [
    UPDATE,
    '--home', home,
    '--items-json', itemsPath,
    '--markdown-path', join(dir, 'digest.md'),
    '--univer-path', fakeUniver
  ], { encoding: 'utf-8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const calls = await readFile(callsPath, 'utf-8');
  assert.match(calls, /inspect workbook/);
  assert.match(calls, /run .*--file/);
  assert.match(calls, /sync/);
  assert.match(result.stdout, /"status": "ok"/);
});

test('exits non-zero for malformed items JSON', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fb-update-home-'));
  const dir = await mkdtemp(join(tmpdir(), 'fb-update-bin-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const itemsPath = join(dir, 'bad-items.json');
  await writeFile(itemsPath, JSON.stringify({ items: [{ sourceType: 'x' }] }), 'utf-8');

  const result = spawnSync(process.execPath, [
    UPDATE,
    '--home', home,
    '--items-json', itemsPath
  ], { encoding: 'utf-8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /contentId is required/);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
cd scripts && node --test update-univer-workbook.test.js
```

Expected:

```text
MODULE_NOT_FOUND
```

- [ ] **Step 3: Implement update script**

Create `scripts/update-univer-workbook.js` with this complete content:

```javascript
#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { homedir } from 'os';
import { readConfigFile } from './lib/follow-builders-config.js';
import {
  RAW_DATA_HEADERS,
  RUNS_HEADERS,
  SHEETS,
  WEEK_DISPLAY_HEADERS,
  groupWeeklyDisplayRows,
  mapItemToRawRow,
  publicUrlForUnit,
  validateItemsPayload
} from './lib/univer-workbook-contract.js';
import { runUniver, runUniverJson } from './lib/univer-command.js';

function parseArgs(argv) {
  const out = {
    home: homedir(),
    univerPath: process.env.FOLLOW_BUILDERS_UNIVER_PATH || 'univer'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--home') out.home = argv[++i];
    else if (arg === '--items-json') out.itemsJsonPath = argv[++i];
    else if (arg === '--markdown-path') out.markdownPath = argv[++i];
    else if (arg === '--univer-path') out.univerPath = argv[++i];
    else if (arg === '--help') out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!out.help && !out.itemsJsonPath) throw new Error('--items-json is required');
  return out;
}

function isoWeekName(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function buildRunRecord({ runId, startedAt, finishedAt, status, payload, markdownPath, itemsJsonPath, syncStatus, unitId, publicUrl, errorSummary }) {
  return [
    runId,
    startedAt,
    finishedAt,
    status,
    payload.items.length,
    0,
    0,
    markdownPath || '',
    itemsJsonPath || '',
    syncStatus || '',
    unitId || '',
    publicUrl || '',
    errorSummary || ''
  ];
}

function buildWorkbookRunScript({ payload, rawRows, displayRows, runRecord, weekSheetName }) {
  return `() => {
  const workbook = univerAPI.getActiveWorkbook();
  const rawHeaders = ${JSON.stringify(RAW_DATA_HEADERS)};
  const runsHeaders = ${JSON.stringify(RUNS_HEADERS)};
  const displayHeaders = ${JSON.stringify(WEEK_DISPLAY_HEADERS)};
  const rawRows = ${JSON.stringify(rawRows)};
  const displayRows = ${JSON.stringify(displayRows)};
  const runRecord = ${JSON.stringify(runRecord)};
  const weekSheetName = ${JSON.stringify(weekSheetName)};

  function ensureSheet(name, rows, cols) {
    return workbook.getSheetByName(name) || workbook.create(name, rows, cols);
  }

  function assertHeaders(sheet, expected) {
    const range = sheet.getRange(0, 0, 1, expected.length);
    const actual = range.getValues()[0];
    const empty = actual.every(value => value === null || value === '');
    if (empty) {
      range.setValues([expected]);
      return;
    }
    for (let i = 0; i < expected.length; i += 1) {
      if (actual[i] !== expected[i]) {
        throw new Error(sheet.getSheetName() + ' header mismatch at column ' + (i + 1) + ': expected ' + expected[i] + ', got ' + actual[i]);
      }
    }
  }

  function lastDataRow(sheet) {
    const last = sheet.getLastRow();
    return Number.isFinite(last) ? last : 0;
  }

  const raw = ensureSheet(${JSON.stringify(SHEETS.rawData)}, 5000, rawHeaders.length);
  const runs = ensureSheet(${JSON.stringify(SHEETS.runs)}, 1000, runsHeaders.length);
  const week = ensureSheet(weekSheetName, 500, displayHeaders.length + 4);

  assertHeaders(raw, rawHeaders);
  assertHeaders(runs, runsHeaders);

  const rawLast = Math.max(lastDataRow(raw), 0);
  const existing = new Map();
  if (rawLast >= 1) {
    const values = raw.getRange(1, 0, rawLast, rawHeaders.length).getValues();
    values.forEach((row, index) => {
      if (row[0]) existing.set(row[0], index + 1);
    });
  }

  let inserted = 0;
  let updated = 0;
  for (const row of rawRows) {
    const rowIndex = existing.get(row[0]);
    if (rowIndex === undefined) {
      const target = Math.max(lastDataRow(raw) + 1, 1);
      raw.getRange(target, 0, 1, rawHeaders.length).setValues([row]);
      existing.set(row[0], target);
      inserted += 1;
    } else {
      raw.getRange(rowIndex, 0, 1, rawHeaders.length).setValues([row]);
      updated += 1;
    }
  }

  const runRow = [...runRecord];
  runRow[5] = inserted;
  runRow[6] = updated;
  const nextRunRow = Math.max(lastDataRow(runs) + 1, 1);
  runs.getRange(nextRunRow, 0, 1, runsHeaders.length).setValues([runRow]);

  week.getRange('A1').setValue('AI Builders Digest');
  week.getRange('A2').setValue(weekSheetName);
  week.getRange('A4').setValue('Total items');
  week.getRange('B4').setValue(displayRows.length);
  week.getRange('A5').setValue('Last updated');
  week.getRange('B5').setValue(new Date().toISOString());
  week.getRange(14, 0, 1, displayHeaders.length).setValues([displayHeaders]);
  week.getRange(15, 0, 400, displayHeaders.length).clearContent();
  if (displayRows.length > 0) {
    week.getRange(15, 0, displayRows.length, displayHeaders.length).setValues(displayRows);
  }
  week.setFrozenRows(15);
  week.setColumnWidth(0, 100);
  week.setColumnWidth(1, 90);
  week.setColumnWidth(2, 160);
  week.setColumnWidth(3, 260);
  week.setColumnWidth(4, 360);
  week.setColumnWidth(5, 320);
  week.setColumnWidth(6, 180);
  week.setColumnWidth(7, 80);
  week.setColumnWidth(8, 260);
  week.setColumnWidth(9, 180);
  week.getRange(14, 0, 1, displayHeaders.length).setFontWeight('bold').setBackgroundColor('#E8F0FE');

  return {
    success: true,
    inserted,
    updated,
    weeklyRows: displayRows.length,
    weekSheetName
  };
}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node update-univer-workbook.js --items-json PATH [--markdown-path PATH] [--home PATH] [--univer-path PATH]');
    return;
  }

  const startedAt = new Date().toISOString();
  const config = await readConfigFile(args.home);
  if (config.univer?.enabled === false) {
    console.log(JSON.stringify({ status: 'skipped', reason: 'univer disabled' }, null, 2));
    return;
  }
  const workbookPath = config.univer?.workbookPath;
  if (!workbookPath || !existsSync(workbookPath)) {
    throw new Error('Univer workbook is not initialized');
  }

  const payload = validateItemsPayload(JSON.parse(await readFile(args.itemsJsonPath, 'utf-8')));
  const updatedAt = new Date().toISOString();
  const rawRows = payload.items.map(item => mapItemToRawRow(item, updatedAt));
  const displayRows = groupWeeklyDisplayRows(payload.items);
  const weekSheetName = isoWeekName(new Date(payload.generatedAt || Date.now()));
  const runRecord = buildRunRecord({
    runId: payload.runId || `run-${Date.now()}`,
    startedAt,
    finishedAt: updatedAt,
    status: 'ok',
    payload,
    markdownPath: args.markdownPath,
    itemsJsonPath: args.itemsJsonPath,
    syncStatus: 'pending',
    unitId: config.univer?.unitId,
    publicUrl: config.univer?.publicUrl,
    errorSummary: ''
  });

  const tempDir = await mkdtemp(join(tmpdir(), 'follow-builders-univer-update-'));
  try {
    const runFile = join(tempDir, 'update-workbook.js');
    await writeFile(runFile, buildWorkbookRunScript({ payload, rawRows, displayRows, runRecord, weekSheetName }), 'utf-8');
    await runUniver(['inspect', 'workbook', workbookPath], { univerPath: args.univerPath });
    const runOutput = await runUniver(['run', workbookPath, '--file', runFile], { univerPath: args.univerPath });
    const runResult = JSON.parse(runOutput.stdout);
    await runUniver(['inspect', 'range', workbookPath, '--range', `${SHEETS.rawData}!A1:T5`], { univerPath: args.univerPath });
    const syncResult = await runUniverJson(['sync', workbookPath], { univerPath: args.univerPath });
    const unitId = syncResult.unitId || syncResult.unitID || config.univer?.unitId;
    console.log(JSON.stringify({
      status: 'ok',
      workbookPath,
      weekSheetName,
      publicUrl: config.univer?.publicUrl || publicUrlForUnit(unitId),
      runResult,
      syncResult
    }, null, 2));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
```

- [ ] **Step 4: Run tests**

Run:

```bash
cd scripts && npm test
```

Expected:

```text
# pass
```

- [ ] **Step 5: Commit**

```bash
git add scripts/update-univer-workbook.js scripts/update-univer-workbook.test.js
git commit -m "feat: update univer workbook"
```

---

### Task 5: Generate And Commit The Workbook Template

**Files:**
- Create: `scripts/univer-template-scaffold.js`
- Create: `templates/follow-builders.univer`
- Modify: `.gitignore`

- [ ] **Step 1: Add `.superpowers/` to `.gitignore`**

Modify `.gitignore`:

```gitignore
scripts/node_modules/
.env
*.log
.DS_Store
.superpowers/
```

- [ ] **Step 2: Create scaffold script for the template**

Create `scripts/univer-template-scaffold.js`:

```javascript
() => {
  const workbook = univerAPI.getActiveWorkbook();
  const rawHeaders = [
    'contentId', 'sourceType', 'sourceName', 'authorName', 'authorHandle',
    'title', 'url', 'publishedAt', 'capturedAt', 'runDate', 'textExcerpt',
    'summary', 'keyPoints', 'topics', 'importanceScore', 'likes', 'retweets',
    'replies', 'rawSourceKey', 'updatedAt'
  ];
  const runsHeaders = [
    'runId', 'startedAt', 'finishedAt', 'status', 'itemsSeen', 'itemsInserted',
    'itemsUpdated', 'markdownPath', 'itemsJsonPath', 'syncStatus', 'unitId',
    'publicUrl', 'errorSummary'
  ];
  const weekHeaders = [
    'Date', 'Type', 'Source', 'Title', 'Summary', 'Key Points', 'Topics',
    'Score', 'URL', 'contentId'
  ];

  function getOrCreate(name, rows, cols) {
    return workbook.getSheetByName(name) || workbook.create(name, rows, cols);
  }

  function styleHeader(sheet, colCount) {
    sheet.getRange(0, 0, 1, colCount)
      .setFontWeight('bold')
      .setFontColor('#202124')
      .setBackgroundColor('#E8F0FE')
      .setVerticalAlignment('middle');
    sheet.setFrozenRows(1);
    sheet.setHiddenGridlines(false);
  }

  const first = workbook.getSheets()[0];
  first.setName('raw-data');
  first.getRange(0, 0, 1, rawHeaders.length).setValues([rawHeaders]);
  styleHeader(first, rawHeaders.length);
  first.setColumnWidth(0, 180);
  first.setColumnWidth(5, 280);
  first.setColumnWidth(10, 320);
  first.setColumnWidth(11, 320);
  first.setColumnWidth(12, 300);

  const runs = getOrCreate('runs', 1000, runsHeaders.length);
  runs.getRange(0, 0, 1, runsHeaders.length).setValues([runsHeaders]);
  styleHeader(runs, runsHeaders.length);
  runs.setColumnWidth(0, 180);
  runs.setColumnWidth(12, 320);

  const weekTemplate = getOrCreate('_week-template', 500, weekHeaders.length + 4);
  weekTemplate.getRange('A1').setValue('AI Builders Digest');
  weekTemplate.getRange('A2').setValue('Week Template');
  weekTemplate.getRange('A4').setValue('Total items');
  weekTemplate.getRange('A5').setValue('Last updated');
  weekTemplate.getRange(14, 0, 1, weekHeaders.length).setValues([weekHeaders]);
  weekTemplate.getRange('A1:J1').merge();
  weekTemplate.getRange('A1:J1').setFontWeight('bold').setFontSize(18).setBackgroundColor('#174EA6').setFontColor('#FFFFFF');
  weekTemplate.getRange(14, 0, 1, weekHeaders.length).setFontWeight('bold').setBackgroundColor('#E8F0FE');
  weekTemplate.setFrozenRows(15);
  weekTemplate.setColumnWidth(0, 100);
  weekTemplate.setColumnWidth(1, 90);
  weekTemplate.setColumnWidth(2, 160);
  weekTemplate.setColumnWidth(3, 260);
  weekTemplate.setColumnWidth(4, 360);
  weekTemplate.setColumnWidth(5, 320);
  weekTemplate.setColumnWidth(6, 180);
  weekTemplate.setColumnWidth(7, 80);
  weekTemplate.setColumnWidth(8, 260);
  weekTemplate.setColumnWidth(9, 180);

  const rulesBefore = weekTemplate.getConditionalFormattingRules().length;
  const scoreRange = weekTemplate.getRange('H16:H415');
  const rule = weekTemplate
    .newConditionalFormattingRule()
    .setColorScale([
      { index: 0, color: '#FCE8E6', value: { type: univerAPI.Enum.ConditionFormatValueTypeEnum.num, value: 0 } },
      { index: 1, color: '#FEF7E0', value: { type: univerAPI.Enum.ConditionFormatValueTypeEnum.num, value: 50 } },
      { index: 2, color: '#E6F4EA', value: { type: univerAPI.Enum.ConditionFormatValueTypeEnum.num, value: 100 } }
    ])
    .setRanges([scoreRange.getRange()])
    .build();
  weekTemplate.addConditionalFormattingRule(rule);

  return {
    success: true,
    sheets: workbook.getSheets().map(sheet => sheet.getSheetName()),
    conditionalRulesAdded: weekTemplate.getConditionalFormattingRules().length - rulesBefore
  };
}
```

- [ ] **Step 3: Build the template workbook**

Run:

```bash
rm -rf templates/follow-builders.univer
mkdir -p templates
univer new templates/follow-builders.univer --json
univer run templates/follow-builders.univer --file scripts/univer-template-scaffold.js
univer inspect workbook templates/follow-builders.univer
univer inspect range templates/follow-builders.univer --range 'raw-data!A1:T1'
univer commit templates/follow-builders.univer --message "scaffold follow builders workbook" --json
univer status templates/follow-builders.univer
```

Expected:

```text
raw-data, runs, and _week-template are visible in inspect workbook.
raw-data!A1:T1 contains the fixed header.
status shows no uncommitted local mutations after commit.
```

- [ ] **Step 4: Verify the template is not synced**

Run:

```bash
univer status templates/follow-builders.univer
```

Expected:

```text
The status must not show a remote synced binding for this repo template.
```

If the template has been synced, discard it and rebuild from Step 3 with a fresh path.

- [ ] **Step 5: Commit**

```bash
git add .gitignore scripts/univer-template-scaffold.js templates/follow-builders.univer
git commit -m "feat: add univer workbook template"
```

---

### Task 6: Modify The LLM Cron Runner

**Files:**
- Modify: `scripts/run-llm-digest.js`
- Modify: `scripts/run-llm-digest.test.js`

- [ ] **Step 1: Update tests for `items.json` and workbook failure isolation**

Modify the fake Codex in `scripts/run-llm-digest.test.js` so it parses both artifact paths:

```javascript
const digestMatch = prompt.match(/^5\\. Write only the final digest markdown text to (.*)\\.$/m);
const itemsMatch = prompt.match(/^6\\. Write the structured workbook items JSON to (.*)\\.$/m);
if (!digestMatch || !itemsMatch) {
  console.error('Could not find digest or items path in prompt');
  process.exit(2);
}

writeFileSync(digestMatch[1], 'Fake digest from cron-safe Codex shim');
writeFileSync(itemsMatch[1], JSON.stringify({ runId: 'fake-run', generatedAt: new Date().toISOString(), items: [] }));
writeFileSync(finalMessagePath, 'Digest delivered.');
```

Add a new test:

```javascript
test('delivers markdown when workbook update fails', async t => {
  const home = await makeTempHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const fakeCodex = join(home, 'fake-codex');

  await writeExecutable(fakeCodex, `#!/bin/sh
last=
final_message_path=
previous=
for arg do
  if [ "$previous" = "--output-last-message" ]; then final_message_path="$arg"; fi
  last="$arg"
  previous="$arg"
done
digest_path="$(printf '%s\\n' "$last" | sed -n 's/^5\\. Write only the final digest markdown text to \\(.*\\)\\.$/\\1/p')"
items_path="$(printf '%s\\n' "$last" | sed -n 's/^6\\. Write the structured workbook items JSON to \\(.*\\)\\.$/\\1/p')"
printf 'Digest survives workbook failure' > "$digest_path"
printf '{"runId":"fake","generatedAt":"2026-05-26T00:00:00.000Z","items":[]}' > "$items_path"
printf 'Digest delivered.' > "$final_message_path"
`);

  const result = runDigestWithFakeCodex({
    codexPath: fakeCodex,
    home,
    extraEnv: { FOLLOW_BUILDERS_UNIVER_UPDATE_PATH: '/definitely/missing/updater' }
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Digest survives workbook failure/);
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
cd scripts && node --test run-llm-digest.test.js
```

Expected:

```text
At least one test fails because the prompt does not include items JSON yet.
```

- [ ] **Step 3: Add `itemsJsonPath` and prompt instructions**

Modify `scripts/run-llm-digest.js`:

- Change `buildPrompt(digestPath, nodePath = process.execPath)` to `buildPrompt(digestPath, itemsJsonPath, nodePath = process.execPath)`.
- Insert this in the prompt after the Markdown output instruction:

```text
6. Write the structured workbook items JSON to ${itemsJsonPath}.
   The JSON must have this exact top-level shape:
   {
     "runId": "<stable run id or generatedAt timestamp>",
     "generatedAt": "<ISO timestamp>",
     "items": [
       {
         "contentId": "x:<tweet id> | podcast:<guid> | blog:<stable url hash if known>",
         "sourceType": "x | podcast | blog",
         "sourceName": "<X, podcast name, or blog name>",
         "authorName": "<builder or author name>",
         "authorHandle": "<X handle if any>",
         "title": "<human-readable title>",
         "url": "<source URL>",
         "publishedAt": "<ISO timestamp or empty string>",
         "capturedAt": "<ISO timestamp>",
         "runDate": "<YYYY-MM-DD>",
         "textExcerpt": "<short excerpt, not full transcript>",
         "summary": "<AI summary>",
         "keyPoints": ["<point>"],
         "topics": ["<topic>"],
         "importanceScore": 0,
         "likes": 0,
         "retweets": 0,
         "replies": 0,
         "rawSourceKey": "<tweet id, podcast guid, or blog URL>"
       }
     ],
     "presentationHints": {
       "weeklyThemes": [],
       "highlightContentIds": []
     }
   }
```

- Renumber delivery instruction to Step 7.
- Change `buildCodexArgs` to accept `itemsJsonPath`.
- In `main`, create:

```javascript
const itemsJsonPath = join(LOG_DIR, `llm-digest-${runId}.items.json`);
```

- Include `itemsJsonPath` in the initial log.

- [ ] **Step 4: Add items JSON assertion and workbook update call**

Add to `scripts/run-llm-digest.js`:

```javascript
async function assertItemsJsonFile(path) {
  let text;
  try {
    text = await readFile(path, 'utf-8');
  } catch (err) {
    throw new Error(`Codex did not create the workbook items JSON file: ${err.message}`);
  }
  const parsed = JSON.parse(text);
  if (!parsed || !Array.isArray(parsed.items)) {
    throw new Error('Workbook items JSON must include an items array');
  }
}

async function runWorkbookUpdate({ config, digestPath, itemsJsonPath, logPath }) {
  if (config.univer?.enabled === false) return;
  const updaterPath = process.env.FOLLOW_BUILDERS_UNIVER_UPDATE_PATH || join(SCRIPT_DIR, 'update-univer-workbook.js');
  const child = spawn(process.execPath, [
    updaterPath,
    '--items-json',
    itemsJsonPath,
    '--markdown-path',
    digestPath
  ], {
    cwd: SKILL_DIR,
    env: buildChildEnv(),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  const result = await new Promise(resolve => {
    child.on('close', code => resolve({ code }));
    child.on('error', err => resolve({ code: 1, error: err }));
  });
  await appendFile(logPath, [
    '',
    '--- workbook update ---',
    Buffer.concat(stdout).toString('utf-8'),
    Buffer.concat(stderr).toString('utf-8'),
    result.error ? result.error.stack || result.error.message : '',
    ''
  ].join('\n'), 'utf-8');
}
```

After `assertFinalMessage(finalMessagePath);`, add:

```javascript
await assertItemsJsonFile(itemsJsonPath);
await runWorkbookUpdate({ config, digestPath, itemsJsonPath, logPath }).catch(err =>
  appendFile(logPath, `workbookUpdateError=${redact(err.stack || err.message, config)}\n`, 'utf-8')
);
```

Then append the public URL before delivery/stdout:

```javascript
if (config.univer?.publicUrl) {
  const digestText = await readFile(digestPath, 'utf-8');
  await writeFile(digestPath, appendWorkbookUrl(digestText, config.univer.publicUrl), 'utf-8');
}
```

Import `appendWorkbookUrl` from `./lib/univer-workbook-contract.js`.

- [ ] **Step 5: Run tests**

Run:

```bash
cd scripts && npm test
```

Expected:

```text
# pass
```

- [ ] **Step 6: Commit**

```bash
git add scripts/run-llm-digest.js scripts/run-llm-digest.test.js
git commit -m "feat: emit workbook items from llm digest"
```

---

### Task 7: Document Workbook Contract In Skill And READMEs

**Files:**
- Modify: `SKILL.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`

- [ ] **Step 1: Add workbook setup to onboarding config example**

In `SKILL.md`, extend the config JSON example in the onboarding section with:

```json
"univer": {
  "enabled": true,
  "workbookPath": "~/.follow-builders/follow-builders.univer",
  "unitId": "",
  "publicUrl": ""
},
```

- [ ] **Step 2: Add a `Univer Workbook Output` section to `SKILL.md`**

Insert this section before `Content Delivery — Digest Run`:

```markdown
## Univer Workbook Output

The Markdown digest remains the primary delivery format. In addition, Follow
Builders maintains a long-lived Univer workbook for readable history and weekly
review.

### Workbook Template

The repo ships `templates/follow-builders.univer`. This template must be:

- scaffolded with `raw-data`, `runs`, and `_week-template`
- locally committed with `univer commit`
- not synced to a remote unit

Do not edit `.univer` package internals. Use only public `univer` commands.

### User Initialization

During setup, initialize the user workbook:

```bash
cd ${CLAUDE_SKILL_DIR}/scripts
node init-univer-workbook.js
```

This copies the template to `~/.follow-builders/follow-builders.univer`, runs
`univer sync`, stores `univer.unitId`, and stores:

```text
https://univer.ai/space/sheets/<unit-id>
```

### Workbook Contract

`raw-data` is the only fact table. It is append-oriented and keyed by
`contentId`.

`runs` is append-only run history.

Weekly sheets are display layers named by ISO week, such as `2026-W22`.

Daily updates may edit:

- `raw-data` rows
- new `runs` rows
- the current weekly sheet display area
- current weekly helper summary values

Daily updates must not change:

- `raw-data` header order
- `runs` header order
- weekly top layout anchors
- chart anchors
- formula-zone structure
- the repo template workbook

### Sorting And Deduplication

Each X tweet is one row. Each podcast episode is one row. Each blog article is
one row.

Stable IDs:

- X: `x:<tweetId>`
- Podcast: `podcast:<guid>`
- Blog: `blog:<normalized-url-hash>`

Weekly displays group dates newest first. Within a day, sort sources:

```text
X -> Podcast -> Blog
```

### Failure Behavior

Workbook update or sync failure must not block Markdown delivery. Keep the local
workbook mutation when sync fails and let the next run retry. If the old public
URL exists, it may still be appended to Markdown, but logs must mention that the
remote workbook may not include the latest data.
```

- [ ] **Step 3: Update README English**

In `README.md`, add a section after `Scheduled LLM Cron`:

```markdown
## Univer Workbook History

Follow Builders can maintain a local Univer workbook alongside the Markdown
digest. Markdown remains the primary Telegram-friendly output. The workbook is a
long-lived `~/.follow-builders/follow-builders.univer` file that stores raw
captured content in `raw-data`, run history in `runs`, and weekly human-readable
review sheets.

During setup, the skill copies `templates/follow-builders.univer`, runs
`univer sync`, and stores the public workbook URL:

```text
https://univer.ai/space/sheets/<unit-id>
```

Daily digest runs update the local workbook and sync it. If workbook sync fails,
Markdown delivery still continues.
```

- [ ] **Step 4: Update README Chinese**

In `README.zh-CN.md`, add the equivalent section:

```markdown
## Univer 工作簿历史

Follow Builders 可以在 Markdown 摘要之外维护一个本地 Univer 工作簿。
Markdown 仍然是适合 Telegram 的主输出；工作簿是长期存在的
`~/.follow-builders/follow-builders.univer`，其中 `raw-data` 保存原始内容记录，
`runs` 保存运行历史，每周一个可读的周报子表。

初始化时，skill 会复制 `templates/follow-builders.univer`，执行 `univer sync`，
并保存公开访问 URL：

```text
https://univer.ai/space/sheets/<unit-id>
```

每日 digest 会更新本地工作簿并同步。即使工作簿同步失败，Markdown 投递也会继续。
```

- [ ] **Step 5: Run documentation checks**

Run:

```bash
rg -n "Univer Workbook|Univer 工作簿|templates/follow-builders.univer|raw-data|runs" SKILL.md README.md README.zh-CN.md
```

Expected:

```text
All three files mention the workbook output and template path.
```

- [ ] **Step 6: Commit**

```bash
git add SKILL.md README.md README.zh-CN.md
git commit -m "docs: document univer workbook output"
```

---

### Task 8: End-To-End Verification

**Files:**
- No source files should be created in this task unless verification exposes a defect.

- [ ] **Step 1: Run the full Node test suite**

Run:

```bash
cd scripts && npm test
```

Expected:

```text
# pass
```

- [ ] **Step 2: Verify the template through public Univer reads**

Run:

```bash
univer inspect workbook templates/follow-builders.univer
univer inspect range templates/follow-builders.univer --range 'raw-data!A1:T1'
univer inspect range templates/follow-builders.univer --range 'runs!A1:M1'
univer inspect range templates/follow-builders.univer --range '_week-template!A1:J16'
```

Expected:

```text
The required sheets and headers are visible. No command fails.
```

- [ ] **Step 3: Run initializer against a temporary home with fake or real sync**

For fake sync:

```bash
TMP_HOME="$(mktemp -d)"
FAKE_DIR="$(mktemp -d)"
cat > "$FAKE_DIR/univer" <<'SH'
#!/bin/sh
case "$1" in
  inspect) echo "# workbook"; exit 0 ;;
  sync) echo '{"success":true,"unitId":"unit-e2e"}'; exit 0 ;;
  *) echo "unexpected $*" >&2; exit 2 ;;
esac
SH
chmod +x "$FAKE_DIR/univer"
node scripts/init-univer-workbook.js --home "$TMP_HOME" --univer-path "$FAKE_DIR/univer"
jq '.univer' "$TMP_HOME/.follow-builders/config.json"
```

Expected:

```json
{
  "enabled": true,
  "workbookPath": "<tmp>/.follow-builders/follow-builders.univer",
  "unitId": "unit-e2e",
  "publicUrl": "https://univer.ai/space/sheets/unit-e2e"
}
```

- [ ] **Step 4: Run updater against a copied workbook**

Run:

```bash
TMP_HOME="$(mktemp -d)"
mkdir -p "$TMP_HOME/.follow-builders"
cp -R templates/follow-builders.univer "$TMP_HOME/.follow-builders/follow-builders.univer"
cat > "$TMP_HOME/.follow-builders/config.json" <<JSON
{
  "univer": {
    "enabled": true,
    "workbookPath": "$TMP_HOME/.follow-builders/follow-builders.univer",
    "unitId": "local-test",
    "publicUrl": "https://univer.ai/space/sheets/local-test"
  }
}
JSON
cat > "$TMP_HOME/items.json" <<JSON
{
  "runId": "e2e-run",
  "generatedAt": "2026-05-26T00:00:00.000Z",
  "items": [
    {
      "contentId": "x:e2e",
      "sourceType": "x",
      "sourceName": "X",
      "authorName": "Ada",
      "authorHandle": "ada",
      "title": "E2E tweet",
      "url": "https://x.com/ada/status/e2e",
      "publishedAt": "2026-05-26T01:00:00.000Z",
      "capturedAt": "2026-05-26T02:00:00.000Z",
      "runDate": "2026-05-26",
      "textExcerpt": "excerpt",
      "summary": "summary",
      "keyPoints": ["point"],
      "topics": ["agents"],
      "importanceScore": 90
    }
  ]
}
JSON
node scripts/update-univer-workbook.js --home "$TMP_HOME" --items-json "$TMP_HOME/items.json"
univer inspect range "$TMP_HOME/.follow-builders/follow-builders.univer" --range 'raw-data!A1:T3'
univer inspect range "$TMP_HOME/.follow-builders/follow-builders.univer" --range '2026-W22!A15:J18'
```

Expected:

```text
raw-data contains x:e2e.
2026-W22 display contains E2E tweet.
```

- [ ] **Step 5: Run cron wrapper with fake Codex**

Run:

```bash
cd scripts && npm test -- run-llm-digest.test.js
```

Expected:

```text
The fake Codex tests pass, including workbook failure isolation.
```

- [ ] **Step 6: Inspect git state before completion**

Run:

```bash
git status --short
```

Expected:

```text
No unexpected untracked files except intentional local scratch directories outside the repo.
```
