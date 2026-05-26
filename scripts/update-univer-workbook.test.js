import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { constants } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRunRecord, buildWorkbookRunScript } from './update-univer-workbook.js';
import { groupWeeklyDisplayRows, mapItemToRawRow } from './lib/univer-workbook-contract.js';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const UPDATE = join(SCRIPT_DIR, 'update-univer-workbook.js');

async function writeExecutable(path, text) {
  await writeFile(path, text, 'utf-8');
  await chmod(path, 0o755);
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function writeConfig(home, workbookPath, extraUniver = {}) {
  await mkdir(join(home, '.follow-builders'), { recursive: true });
  await writeFile(join(home, '.follow-builders', 'config.json'), JSON.stringify({
    univer: {
      enabled: true,
      workbookPath,
      unitId: 'unit-test-1',
      publicUrl: 'https://univer.ai/space/sheets/unit-test-1',
      ...extraUniver
    }
  }), 'utf-8');
}

async function writeFakeUniver(path, callsPath) {
  await writeExecutable(path, `#!/bin/sh
printf '%s\\n' "$*" >> "${callsPath}"
case "$1 $2" in
  "inspect workbook") echo "# workbook"; exit 0 ;;
  "inspect range") echo "| contentId |"; exit 0 ;;
  "run "*) echo '{"success":true,"inserted":2,"updated":0,"weeklyRows":2,"weekSheetName":"2026-W22"}'; exit 0 ;;
  "commit "*) echo '{"success":true,"committed":true,"status":{"uncommittedMutationCount":0}}'; exit 0 ;;
  "sync "*) echo '{"success":true,"status":{"unitID":"unit-test-1","uncommittedMutationCount":0}}'; exit 0 ;;
  *) echo "unexpected $*" >&2; exit 2 ;;
esac
`);
}

async function writeFailingRunUniver(path, callsPath) {
  await writeExecutable(path, `#!/bin/sh
printf '%s\\n' "$*" >> "${callsPath}"
case "$1 $2" in
  "inspect workbook") echo "# workbook"; exit 0 ;;
  "run "*) printf 'mutated' > "$2/sentinel.txt"; echo '{"success":false,"error":"script failed"}'; exit 0 ;;
  *) echo "unexpected $*" >&2; exit 2 ;;
esac
`);
}

async function writeCapturingUniver(path, callsPath, capturePath) {
  await writeExecutable(path, `#!/bin/sh
printf '%s\\n' "$*" >> "${callsPath}"
case "$1 $2" in
  "inspect workbook") echo "# workbook"; exit 0 ;;
  "inspect range") echo "| contentId |"; exit 0 ;;
  "run "*) cp "$4" "${capturePath}"; echo '{"success":true,"inserted":1,"updated":0,"weeklyRows":1,"weekSheetName":"2026-W22"}'; exit 0 ;;
  "commit "*) echo '{"success":true,"committed":true,"status":{"uncommittedMutationCount":0}}'; exit 0 ;;
  "sync "*) echo '{"success":true,"status":{"unitID":"unit-test-1","uncommittedMutationCount":0}}'; exit 0 ;;
  *) echo "unexpected $*" >&2; exit 2 ;;
esac
`);
}

async function writeUncommittedSyncUniver(path, callsPath) {
  await writeExecutable(path, `#!/bin/sh
printf '%s\\n' "$*" >> "${callsPath}"
case "$1 $2" in
  "inspect workbook") echo "# workbook"; exit 0 ;;
  "inspect range") echo "| contentId |"; exit 0 ;;
  "run "*) echo '{"success":true,"inserted":2,"updated":0,"weeklyRows":2,"weekSheetName":"2026-W22"}'; exit 0 ;;
  "commit "*) echo '{"success":true,"committed":true,"status":{"uncommittedMutationCount":0}}'; exit 0 ;;
  "sync "*) echo '{"success":true,"status":{"unitID":"unit-test-1","uncommittedMutationCount":1}}'; exit 0 ;;
  *) echo "unexpected $*" >&2; exit 2 ;;
esac
`);
}

async function writeFalseSyncUniver(path, callsPath) {
  await writeExecutable(path, `#!/bin/sh
printf '%s\\n' "$*" >> "${callsPath}"
case "$1 $2" in
  "inspect workbook") echo "# workbook"; exit 0 ;;
  "inspect range") echo "| contentId |"; exit 0 ;;
  "run "*) printf 'mutated' > "$2/sentinel.txt"; echo '{"success":true,"inserted":2,"updated":0,"weeklyRows":2,"weekSheetName":"2026-W22"}'; exit 0 ;;
  "commit "*) echo '{"success":true,"committed":true,"status":{"uncommittedMutationCount":0}}'; exit 0 ;;
  "sync "*) echo '{"success":false,"error":"remote sync rejected","status":{"unitID":"unit-test-1","uncommittedMutationCount":0}}'; exit 0 ;;
  *) echo "unexpected $*" >&2; exit 2 ;;
esac
`);
}

function extractGeneratedPayload(script) {
  const match = script.match(/const payload = (.*);\n  const DISPLAY_HEADER_ROW/s);
  assert.ok(match, 'generated script should embed a payload object');
  return JSON.parse(match[1]);
}

function validItemsPayload() {
  return {
    runId: 'run-1',
    generatedAt: '2026-05-26T08:00:00.000Z',
    items: [
      {
        contentId: 'x:1',
        sourceType: 'x',
        sourceName: 'X',
        title: 'Agent update',
        url: 'https://x.com/a/status/1',
        publishedAt: '2026-05-26T07:00:00.000Z',
        capturedAt: '2026-05-26T08:00:00.000Z',
        runDate: '2026-05-26',
        summary: 'A short update.',
        keyPoints: ['one'],
        topics: ['agents'],
        importanceScore: 88
      },
      {
        contentId: 'podcast:1',
        sourceType: 'podcast',
        sourceName: 'Latent Space',
        title: 'Podcast update',
        url: 'https://example.com/podcast/1',
        publishedAt: '2026-05-26T06:00:00.000Z',
        capturedAt: '2026-05-26T08:00:00.000Z',
        runDate: '2026-05-26',
        summary: 'A podcast note.',
        keyPoints: ['two'],
        topics: ['research'],
        importanceScore: 72
      }
    ]
  };
}

test('updates configured workbook and syncs it', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fb-update-home-'));
  const root = await mkdtemp(join(tmpdir(), 'fb-update-root-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(root, { recursive: true, force: true }));

  const workbookPath = join(home, '.follow-builders', 'follow-builders.univer');
  await writeConfig(home, workbookPath);
  await writeFile(workbookPath, 'workbook', 'utf-8');

  const itemsPath = join(root, 'items.json');
  const markdownPath = join(root, 'digest.md');
  await writeFile(itemsPath, JSON.stringify(validItemsPayload()), 'utf-8');
  await writeFile(markdownPath, 'digest', 'utf-8');

  const fakeUniver = join(root, 'fake-univer');
  const calls = join(root, 'calls.log');
  await writeFakeUniver(fakeUniver, calls);

  const result = spawnSync(process.execPath, [
    UPDATE,
    '--home', home,
    '--items-json', itemsPath,
    '--markdown-path', markdownPath,
    '--univer-path', fakeUniver
  ], { encoding: 'utf-8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const status = JSON.parse(result.stdout);
  assert.equal(status.status, 'ok');
  assert.equal(status.workbookPath, workbookPath);
  assert.equal(status.weekSheetName, '2026-W22');
  assert.equal(status.publicUrl, 'https://univer.ai/space/sheets/unit-test-1');
  assert.deepEqual(status.runResult, {
    success: true,
    inserted: 2,
    updated: 0,
    weeklyRows: 2,
    weekSheetName: '2026-W22'
  });
  assert.deepEqual(status.commitResult, {
    success: true,
    committed: true,
    status: { uncommittedMutationCount: 0 }
  });

  const loggedCalls = (await readFile(calls, 'utf-8')).trim().split('\n');
  assert.equal(loggedCalls[0], `inspect workbook ${workbookPath}`);
  assert.match(loggedCalls[1], new RegExp(`^run ${workbookPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} --file .+update-workbook\\.js$`));
  assert.equal(loggedCalls[2], `inspect range ${workbookPath} --range raw-data!A1:T5`);
  assert.equal(loggedCalls[3], `commit ${workbookPath} --message follow-builders 2026-W22 run-1 --json`);
  assert.equal(loggedCalls[4], `sync ${workbookPath} --json`);
});

test('malformed items JSON exits non-zero with validation message', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fb-update-home-'));
  const root = await mkdtemp(join(tmpdir(), 'fb-update-root-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(root, { recursive: true, force: true }));

  const workbookPath = join(home, '.follow-builders', 'follow-builders.univer');
  await writeConfig(home, workbookPath);
  await writeFile(workbookPath, 'workbook', 'utf-8');

  const itemsPath = join(root, 'items.json');
  await writeFile(itemsPath, JSON.stringify({
    items: [{ sourceType: 'x', title: 'Missing content id', url: 'https://x.com/a/status/1' }]
  }), 'utf-8');

  const fakeUniver = join(root, 'fake-univer');
  await writeFakeUniver(fakeUniver, join(root, 'calls.log'));

  const result = spawnSync(process.execPath, [
    UPDATE,
    '--home', home,
    '--items-json', itemsPath,
    '--univer-path', fakeUniver
  ], { encoding: 'utf-8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /contentId is required/);
});

test('rejects option flags without values before home side effects', async t => {
  const guardHome = await mkdtemp(join(tmpdir(), 'fb-update-guard-home-'));
  const root = await mkdtemp(join(tmpdir(), 'fb-update-root-'));
  t.after(() => rm(guardHome, { recursive: true, force: true }));
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [
    UPDATE,
    '--home',
    '--items-json', join(root, 'items.json')
  ], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: guardHome }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /--home requires a value/);
  assert.equal(await pathExists(join(guardHome, '.follow-builders')), false);
});

test('rejects single-dash flag-like option values before config work', async t => {
  const guardHome = await mkdtemp(join(tmpdir(), 'fb-update-guard-home-'));
  t.after(() => rm(guardHome, { recursive: true, force: true }));

  await mkdir(join(guardHome, '.follow-builders'), { recursive: true });
  await writeFile(join(guardHome, '.follow-builders', 'config.json'), '{not json', 'utf-8');

  const result = spawnSync(process.execPath, [
    UPDATE,
    '--items-json', '-x'
  ], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: guardHome }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /--items-json requires a value/);
  assert.doesNotMatch(result.stderr + result.stdout, /Could not read config/);
});

test('restores workbook directory when run script returns unsuccessful JSON before commit', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fb-update-home-'));
  const root = await mkdtemp(join(tmpdir(), 'fb-update-root-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(root, { recursive: true, force: true }));

  const workbookPath = join(home, '.follow-builders', 'follow-builders.univer');
  await writeConfig(home, workbookPath);
  await mkdir(workbookPath, { recursive: true });
  await writeFile(join(workbookPath, 'sentinel.txt'), 'original', 'utf-8');

  const itemsPath = join(root, 'items.json');
  await writeFile(itemsPath, JSON.stringify(validItemsPayload()), 'utf-8');

  const fakeUniver = join(root, 'fake-univer');
  const calls = join(root, 'calls.log');
  await writeFailingRunUniver(fakeUniver, calls);

  const result = spawnSync(process.execPath, [
    UPDATE,
    '--home', home,
    '--items-json', itemsPath,
    '--univer-path', fakeUniver
  ], { encoding: 'utf-8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /univer run failed: script failed/);
  assert.equal(await readFile(join(workbookPath, 'sentinel.txt'), 'utf-8'), 'original');
  const loggedCalls = (await readFile(calls, 'utf-8')).trim().split('\n');
  assert.equal(loggedCalls[0], `inspect workbook ${workbookPath}`);
  assert.match(loggedCalls[1], new RegExp(`^run ${workbookPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} --file .+update-workbook\\.js$`));
  assert.equal(loggedCalls.length, 2);
});

test('fails clearly when sync reports uncommitted mutations after commit', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fb-update-home-'));
  const root = await mkdtemp(join(tmpdir(), 'fb-update-root-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(root, { recursive: true, force: true }));

  const workbookPath = join(home, '.follow-builders', 'follow-builders.univer');
  await writeConfig(home, workbookPath);
  await writeFile(workbookPath, 'workbook', 'utf-8');

  const itemsPath = join(root, 'items.json');
  await writeFile(itemsPath, JSON.stringify(validItemsPayload()), 'utf-8');

  const fakeUniver = join(root, 'fake-univer');
  const calls = join(root, 'calls.log');
  await writeUncommittedSyncUniver(fakeUniver, calls);

  const result = spawnSync(process.execPath, [
    UPDATE,
    '--home', home,
    '--items-json', itemsPath,
    '--univer-path', fakeUniver
  ], { encoding: 'utf-8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /uncommitted mutations/);
  const loggedCalls = (await readFile(calls, 'utf-8')).trim().split('\n');
  assert.match(loggedCalls[3], /^commit /);
  assert.match(loggedCalls[4], /^sync /);
});

test('fails clearly without restoring workbook when sync JSON reports success false after commit', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fb-update-home-'));
  const root = await mkdtemp(join(tmpdir(), 'fb-update-root-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(root, { recursive: true, force: true }));

  const workbookPath = join(home, '.follow-builders', 'follow-builders.univer');
  await writeConfig(home, workbookPath);
  await mkdir(workbookPath, { recursive: true });
  await writeFile(join(workbookPath, 'sentinel.txt'), 'original', 'utf-8');

  const itemsPath = join(root, 'items.json');
  await writeFile(itemsPath, JSON.stringify(validItemsPayload()), 'utf-8');

  const fakeUniver = join(root, 'fake-univer');
  const calls = join(root, 'calls.log');
  await writeFalseSyncUniver(fakeUniver, calls);

  const result = spawnSync(process.execPath, [
    UPDATE,
    '--home', home,
    '--items-json', itemsPath,
    '--univer-path', fakeUniver
  ], { encoding: 'utf-8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /univer sync failed: remote sync rejected/);
  assert.equal(await readFile(join(workbookPath, 'sentinel.txt'), 'utf-8'), 'mutated');
  const loggedCalls = (await readFile(calls, 'utf-8')).trim().split('\n');
  assert.match(loggedCalls[3], /^commit /);
  assert.match(loggedCalls[4], /^sync /);
});

test('generated run record preserves original item count before dedupe', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fb-update-home-'));
  const root = await mkdtemp(join(tmpdir(), 'fb-update-root-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(root, { recursive: true, force: true }));

  const workbookPath = join(home, '.follow-builders', 'follow-builders.univer');
  await writeConfig(home, workbookPath);
  await writeFile(workbookPath, 'workbook', 'utf-8');

  const payload = validItemsPayload();
  payload.items.push({ ...payload.items[0], title: 'Last duplicate wins', summary: 'Updated duplicate' });
  const itemsPath = join(root, 'items.json');
  await writeFile(itemsPath, JSON.stringify(payload), 'utf-8');

  const capturedRunFile = join(root, 'captured-update-workbook.js');
  const fakeUniver = join(root, 'fake-univer');
  await writeCapturingUniver(fakeUniver, join(root, 'calls.log'), capturedRunFile);

  const result = spawnSync(process.execPath, [
    UPDATE,
    '--home', home,
    '--items-json', itemsPath,
    '--univer-path', fakeUniver
  ], { encoding: 'utf-8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const generated = extractGeneratedPayload(await readFile(capturedRunFile, 'utf-8'));
  assert.equal(generated.runRecord.itemsSeen, 3);
  assert.equal(generated.rawRows.length, 2);
  assert.equal(generated.rawRows[0][5], 'Last duplicate wins');
});

class FakeRange {
  constructor(sheet, row, column, rowCount = 1, columnCount = 1) {
    this.sheet = sheet;
    this.row = row;
    this.column = column;
    this.rowCount = rowCount;
    this.columnCount = columnCount;
  }

  getValues() {
    return Array.from({ length: this.rowCount }, (_, rowOffset) => (
      Array.from({ length: this.columnCount }, (_, columnOffset) => (
        this.sheet.getCell(this.row + rowOffset, this.column + columnOffset)
      ))
    ));
  }

  setValues(values) {
    values.forEach((row, rowOffset) => {
      row.forEach((value, columnOffset) => {
        this.sheet.setCell(this.row + rowOffset, this.column + columnOffset, value);
      });
    });
    return this;
  }

  setValue(value) {
    this.sheet.setCell(this.row, this.column, value);
    return this;
  }

  clearContent() {
    for (let rowOffset = 0; rowOffset < this.rowCount; rowOffset += 1) {
      for (let columnOffset = 0; columnOffset < this.columnCount; columnOffset += 1) {
        this.sheet.setCell(this.row + rowOffset, this.column + columnOffset, '');
      }
    }
    return this;
  }

  record(method, value) {
    this.sheet.formatting.push({
      method,
      value,
      row: this.row,
      column: this.column,
      rowCount: this.rowCount,
      columnCount: this.columnCount
    });
    return this;
  }

  clear() {
    this.clearContent();
    this.sheet.clearedRanges.push({
      row: this.row,
      column: this.column,
      rowCount: this.rowCount,
      columnCount: this.columnCount
    });
    return this;
  }

  merge(options = {}) {
    this.sheet.merges.push({
      row: this.row,
      column: this.column,
      rowCount: this.rowCount,
      columnCount: this.columnCount,
      options
    });
    return this;
  }

  setFontWeight(value) { return this.record('setFontWeight', value); }
  setBackgroundColor(value) { return this.record('setBackgroundColor', value); }
  setFontColor(value) { return this.record('setFontColor', value); }
  setVerticalAlignment(value) { return this.record('setVerticalAlignment', value); }
  setFontSize(value) { return this.record('setFontSize', value); }
  setHorizontalAlignment(value) { return this.record('setHorizontalAlignment', value); }
  setWrap(value) { return this.record('setWrap', value); }
}

function a1ToIndexes(a1) {
  const match = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(a1);
  if (!match) throw new Error(`Unsupported fake A1 range: ${a1}`);
  const col = text => text.split('').reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) - 1;
  const startColumn = col(match[1]);
  const startRow = Number(match[2]) - 1;
  const endColumn = match[3] ? col(match[3]) : startColumn;
  const endRow = match[4] ? Number(match[4]) - 1 : startRow;
  return {
    row: startRow,
    column: startColumn,
    rowCount: endRow - startRow + 1,
    columnCount: endColumn - startColumn + 1
  };
}

function assertMergedRange(sheet, a1) {
  const expected = a1ToIndexes(a1);
  assert.ok(
    sheet.merges.some(merge => (
      merge.row === expected.row &&
      merge.column === expected.column &&
      merge.rowCount === expected.rowCount &&
      merge.columnCount === expected.columnCount &&
      merge.options.isForceMerge === true
    )),
    `expected merged range ${a1}`
  );
}

class FakeSheet {
  constructor(name, rows, columns) {
    this.name = name;
    this.rowCapacity = rows;
    this.columnCapacity = columns;
    this.cells = new Map();
    this.formattedLastRow = -1;
    this.formatting = [];
    this.merges = [];
    this.clearedRanges = [];
    this.columnWidths = new Map();
    this.rowHeights = new Map();
    this.frozenRows = 0;
    this.frozenColumns = 0;
    this.hiddenGridlines = false;
  }

  key(row, column) {
    return `${row}:${column}`;
  }

  getCell(row, column) {
    return this.cells.get(this.key(row, column)) ?? '';
  }

  setCell(row, column, value) {
    if (value === '') this.cells.delete(this.key(row, column));
    else this.cells.set(this.key(row, column), value);
  }

  getRange(row, column, rowCount = 1, columnCount = 1) {
    if (typeof row === 'string') {
      const parsed = a1ToIndexes(row);
      this.assertRangeInBounds(parsed.row, parsed.column, parsed.rowCount, parsed.columnCount);
      return new FakeRange(this, parsed.row, parsed.column, parsed.rowCount, parsed.columnCount);
    }
    this.assertRangeInBounds(row, column, rowCount, columnCount);
    return new FakeRange(this, row, column, rowCount, columnCount);
  }

  assertRangeInBounds(row, column, rowCount, columnCount) {
    if (
      !Number.isInteger(row) ||
      !Number.isInteger(column) ||
      !Number.isInteger(rowCount) ||
      !Number.isInteger(columnCount) ||
      row < 0 ||
      column < 0 ||
      rowCount < 1 ||
      columnCount < 1
    ) {
      throw new Error(`Invalid range on ${this.name}: row=${row} column=${column} rowCount=${rowCount} columnCount=${columnCount}`);
    }
    if (row + rowCount > this.rowCapacity || column + columnCount > this.columnCapacity) {
      throw new Error(
        `Range exceeds sheet dimensions on ${this.name}: ` +
        `range row=${row} column=${column} rowCount=${rowCount} columnCount=${columnCount}, ` +
        `sheet rows=${this.rowCapacity} columns=${this.columnCapacity}`
      );
    }
  }

  getLastRow() {
    let last = -1;
    for (const key of this.cells.keys()) {
      last = Math.max(last, Number(key.split(':')[0]));
    }
    return Math.max(last, this.formattedLastRow);
  }

  markFormattedLastRow(row) {
    this.formattedLastRow = Math.max(this.formattedLastRow, row);
  }

  setFrozenRows(value) { this.frozenRows = value; return this; }
  setFrozenColumns(value) { this.frozenColumns = value; return this; }
  setHiddenGridlines(value) { this.hiddenGridlines = value; return this; }

  setColumnWidths(start, count, width) {
    for (let index = 0; index < count; index += 1) this.columnWidths.set(start + index, width);
    return this;
  }

  setColumnWidth(index, width) {
    this.columnWidths.set(index, width);
    return this;
  }

  setRowHeights(start, count, height) {
    for (let index = 0; index < count; index += 1) this.rowHeights.set(start + index, height);
    return this;
  }

  setRowHeight(index, height) {
    this.rowHeights.set(index, height);
    return this;
  }
}

class FakeWorkbook {
  constructor() {
    this.sheets = new Map();
  }

  getSheetByName(name) {
    return this.sheets.get(name) || null;
  }

  create(name, rows, columns) {
    const sheet = new FakeSheet(name, rows, columns);
    this.sheets.set(name, sheet);
    return sheet;
  }
}

function executeWorkbookRunScript(script, workbook) {
  return Function('univerAPI', `return (${script})();`)({
    getActiveWorkbook() {
      return workbook;
    }
  });
}

function runRecord(itemsSeen, runId = `run-${itemsSeen}`) {
  return buildRunRecord({
    payload: { runId },
    itemsJsonPath: '/tmp/items.json',
    markdownPath: '/tmp/digest.md',
    config: {
      univer: {
        unitId: 'unit-test-1',
        publicUrl: 'https://univer.ai/space/sheets/unit-test-1'
      }
    },
    startedAt: '2026-05-26T08:00:00.000Z',
    finishedAt: '2026-05-26T08:01:00.000Z',
    itemsSeen
  });
}

test('generated workbook-local script initializes headers, upserts raw rows, appends runs, and renders weekly rows', () => {
  const workbook = new FakeWorkbook();
  const firstItem = validItemsPayload().items[0];
  const firstRun = buildWorkbookRunScript({
    rawRows: [mapItemToRawRow(firstItem, '2026-05-26T08:01:00.000Z')],
    displayRows: groupWeeklyDisplayRows([firstItem]),
    runRecord: runRecord(1, 'run-1'),
    weekSheetName: '2026-W22'
  });

  assert.deepEqual(executeWorkbookRunScript(firstRun, workbook), {
    success: true,
    inserted: 1,
    updated: 0,
    weeklyRows: 1,
    weekSheetName: '2026-W22'
  });

  const rawSheet = workbook.getSheetByName('raw-data');
  const runsSheet = workbook.getSheetByName('runs');
  const weekSheet = workbook.getSheetByName('2026-W22');
  assert.ok(weekSheet.rowCapacity >= 176);
  assert.equal(rawSheet.getCell(0, 0), 'contentId');
  assert.equal(runsSheet.getCell(0, 0), 'runId');
  assert.equal(rawSheet.getCell(1, 0), 'x:1');
  assert.equal(rawSheet.getCell(1, 5), 'Agent update');
  assert.equal(runsSheet.getCell(1, 5), 1);
  assert.equal(runsSheet.getCell(1, 6), 0);
  assert.equal(weekSheet.getCell(14, 0), 'Date');
  assert.equal(weekSheet.getCell(15, 0), '2026-05-26');
  assert.equal(weekSheet.getCell(15, 3), 'Agent update');

  const updatedItem = { ...firstItem, title: 'Updated agent update', summary: 'New summary' };
  const secondRun = buildWorkbookRunScript({
    rawRows: [mapItemToRawRow(updatedItem, '2026-05-26T09:01:00.000Z')],
    displayRows: groupWeeklyDisplayRows([updatedItem]),
    runRecord: runRecord(2, 'run-2'),
    weekSheetName: '2026-W22'
  });

  assert.deepEqual(executeWorkbookRunScript(secondRun, workbook), {
    success: true,
    inserted: 0,
    updated: 1,
    weeklyRows: 1,
    weekSheetName: '2026-W22'
  });
  assert.equal(rawSheet.getCell(1, 5), 'Updated agent update');
  assert.equal(runsSheet.getCell(2, 5), 0);
  assert.equal(runsSheet.getCell(2, 6), 1);
  assert.equal(weekSheet.getCell(15, 3), 'Updated agent update');
});

test('generated workbook-local script renders the weekly sheet from raw-data history', () => {
  const workbook = new FakeWorkbook();
  const currentItem = validItemsPayload().items[0];
  const previousItem = {
    ...currentItem,
    contentId: 'x:previous',
    title: 'Previous day update',
    summary: 'Previous summary',
    publishedAt: '2026-05-25T07:00:00.000Z',
    runDate: '2026-05-25'
  };

  const firstRun = buildWorkbookRunScript({
    rawRows: [mapItemToRawRow(previousItem, '2026-05-25T08:01:00.000Z')],
    runRecord: runRecord(1, 'run-previous'),
    weekSheetName: '2026-W22',
    weekStartDate: '2026-05-25',
    weekEndDate: '2026-05-31'
  });
  assert.deepEqual(executeWorkbookRunScript(firstRun, workbook), {
    success: true,
    inserted: 1,
    updated: 0,
    weeklyRows: 1,
    weekSheetName: '2026-W22'
  });

  const secondRun = buildWorkbookRunScript({
    rawRows: [mapItemToRawRow(currentItem, '2026-05-26T08:01:00.000Z')],
    runRecord: runRecord(1, 'run-current'),
    weekSheetName: '2026-W22',
    weekStartDate: '2026-05-25',
    weekEndDate: '2026-05-31'
  });
  assert.deepEqual(executeWorkbookRunScript(secondRun, workbook), {
    success: true,
    inserted: 1,
    updated: 0,
    weeklyRows: 2,
    weekSheetName: '2026-W22'
  });

  const weekSheet = workbook.getSheetByName('2026-W22');
  assert.equal(weekSheet.getCell(15, 0), '2026-05-26');
  assert.equal(weekSheet.getCell(15, 3), 'Agent update');
  assert.equal(weekSheet.getCell(16, 0), '2026-05-25');
  assert.equal(weekSheet.getCell(16, 3), 'Previous day update');
});

test('generated workbook-local script renders editorial dashboard metrics and highlights', () => {
  const workbook = new FakeWorkbook();
  const [xItem, podcastItem] = validItemsPayload().items;
  const blogItem = {
    ...xItem,
    contentId: 'blog:abc123def456',
    sourceType: 'blog',
    sourceName: 'OpenAI Blog',
    title: 'Blog update',
    summary: 'A blog note.',
    keyPoints: ['three'],
    topics: ['release'],
    importanceScore: 91,
    url: 'https://example.com/blog',
    rawSourceKey: 'https://example.com/blog'
  };
  const script = buildWorkbookRunScript({
    rawRows: [
      mapItemToRawRow(xItem, '2026-05-26T08:01:00.000Z'),
      mapItemToRawRow(podcastItem, '2026-05-26T08:01:00.000Z'),
      mapItemToRawRow(blogItem, '2026-05-26T08:01:00.000Z')
    ],
    runRecord: runRecord(3, 'run-dashboard'),
    weekSheetName: '2026-W22',
    weekStartDate: '2026-05-25',
    weekEndDate: '2026-05-31'
  });

  assert.deepEqual(executeWorkbookRunScript(script, workbook), {
    success: true,
    inserted: 3,
    updated: 0,
    weeklyRows: 3,
    weekSheetName: '2026-W22'
  });

  const weekSheet = workbook.getSheetByName('2026-W22');
  assert.equal(weekSheet.hiddenGridlines, true);
  assert.equal(weekSheet.frozenRows, 15);
  assert.equal(weekSheet.frozenColumns, 2);
  assert.equal(weekSheet.getCell(0, 0), '2026-W22 Follow Builders');
  assert.match(weekSheet.getCell(1, 0), /May 25 - May 31/);
  assert.equal(weekSheet.getCell(2, 0), 'Items');
  assert.equal(weekSheet.getCell(2, 2), 'X');
  assert.equal(weekSheet.getCell(2, 4), 'Podcast');
  assert.equal(weekSheet.getCell(2, 6), 'Blog');
  assert.equal(weekSheet.getCell(2, 8), 'Avg Score');
  assert.equal(weekSheet.getCell(3, 0), 3);
  assert.equal(weekSheet.getCell(3, 2), 1);
  assert.equal(weekSheet.getCell(3, 4), 1);
  assert.equal(weekSheet.getCell(3, 6), 1);
  assert.equal(weekSheet.getCell(3, 8), 84);
  ['A4:B5', 'C4:D5', 'E4:F5', 'G4:H5', 'I4:J5'].forEach(a1 => assertMergedRange(weekSheet, a1));
  assert.equal(weekSheet.getCell(6, 0), 'Top X');
  assert.equal(weekSheet.getCell(7, 0), 'Agent update');
  assert.equal(weekSheet.getCell(6, 3), 'Top Podcast');
  assert.equal(weekSheet.getCell(7, 3), 'Podcast update');
  assert.match(weekSheet.getCell(6, 6), /Highest Score/);
  assert.equal(weekSheet.getCell(7, 6), 'Blog update');
  assert.equal(weekSheet.getCell(11, 0), 'Daily Digest');
  assert.equal(weekSheet.getCell(14, 0), 'Date');
  assert.equal(weekSheet.getCell(15, 1), 'X');
  assert.equal(weekSheet.getCell(16, 1), 'Podcast');
  assert.equal(weekSheet.getCell(17, 1), 'Blog');
  assert.equal(weekSheet.columnWidths.get(4), 430);
  assert.equal(weekSheet.rowHeights.get(15), 96);
  assert.ok(weekSheet.formatting.some(entry => entry.method === 'setBackgroundColor' && entry.value === '#102033'));
  assert.ok(weekSheet.formatting.some(entry => entry.method === 'setWrap' && entry.value === true));
});

test('generated workbook-local script appends after last non-empty key row when sheets have formatted blank rows', () => {
  const workbook = new FakeWorkbook();
  workbook.create('raw-data', 2000, 20).markFormattedLastRow(999);
  workbook.create('runs', 500, 13).markFormattedLastRow(499);
  const firstItem = validItemsPayload().items[0];
  const script = buildWorkbookRunScript({
    rawRows: [mapItemToRawRow(firstItem, '2026-05-26T08:01:00.000Z')],
    displayRows: groupWeeklyDisplayRows([firstItem]),
    runRecord: runRecord(1, 'run-1'),
    weekSheetName: '2026-W22'
  });

  assert.deepEqual(executeWorkbookRunScript(script, workbook), {
    success: true,
    inserted: 1,
    updated: 0,
    weeklyRows: 1,
    weekSheetName: '2026-W22'
  });

  const rawSheet = workbook.getSheetByName('raw-data');
  const runsSheet = workbook.getSheetByName('runs');
  assert.equal(rawSheet.getCell(1, 0), 'x:1');
  assert.equal(rawSheet.getCell(1000, 0), '');
  assert.equal(runsSheet.getCell(1, 0), 'run-1');
  assert.equal(runsSheet.getCell(500, 0), '');
});
