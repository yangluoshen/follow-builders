import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { constants } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRunRecord, buildWorkbookRunScript } from './update-univer-workbook.js';
import { RAW_DATA_HEADERS, RUNS_HEADERS, groupWeeklyDisplayRows, mapItemToRawRow } from './lib/univer-workbook-contract.js';

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
  assert.ok(!loggedCalls.includes(`new ${workbookPath}`));
  assert.ok(!loggedCalls.some(call => call.includes('univer-template-scaffold.js')));
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

class FakeConditionalFormattingRuleBuilder {
  constructor(sheet) {
    this.sheet = sheet;
    this.config = { ranges: [] };
  }

  setRanges(ranges) {
    this.config.ranges = ranges;
    return this;
  }

  setDataBar(config) {
    this.config.type = 'dataBar';
    this.config.dataBar = config;
    return this;
  }

  setColorScale(config) {
    this.config.type = 'colorScale';
    this.config.colorScale = config;
    return this;
  }

  whenNumberGreaterThanOrEqualTo(value) {
    this.config.predicate = { type: 'numberGreaterThanOrEqualTo', value };
    return this;
  }

  whenNumberLessThan(value) {
    this.config.predicate = { type: 'numberLessThan', value };
    return this;
  }

  setBackground(value) {
    this.config.background = value;
    return this;
  }

  setFontColor(value) {
    this.config.fontColor = value;
    return this;
  }

  setBold(value) {
    this.config.bold = value;
    return this;
  }

  build() {
    return {
      cfId: `cf-${this.sheet.conditionalFormattingRules.length + 1}`,
      ...this.config
    };
  }
}

class FakeChartBuilder {
  constructor(sheet) {
    this.sheet = sheet;
    this.config = {};
  }

  setChartType(value) {
    this.config.chartType = value;
    return this;
  }

  addRange(value) {
    this.config.range = value;
    return this;
  }

  setPosition(row, column, rowOffset, columnOffset) {
    this.config.position = { row, column, rowOffset, columnOffset };
    return this;
  }

  setWidth(value) {
    this.config.width = value;
    return this;
  }

  setHeight(value) {
    this.config.height = value;
    return this;
  }

  setOptions(path, value) {
    if (!this.config.options) this.config.options = {};
    this.config.options[path] = value;
    return this;
  }

  build() {
    return { ...this.config };
  }
}

class FakeChart {
  constructor(id, info) {
    this.id = id;
    this.info = info;
  }

  getChartId() {
    return this.id;
  }

  getRange() {
    return this.info.range;
  }

  getSeriesData() {
    return [];
  }

  getCategoryData() {
    return [];
  }
}

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

  getValue() {
    return this.sheet.getCell(this.row, this.column);
  }

  getRange() {
    return {
      startRow: this.row,
      startColumn: this.column,
      endRow: this.row + this.rowCount - 1,
      endColumn: this.column + this.columnCount - 1
    };
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
    for (let rowOffset = 0; rowOffset < this.rowCount; rowOffset += 1) {
      for (let columnOffset = 0; columnOffset < this.columnCount; columnOffset += 1) {
        this.sheet.setCellFormat(this.row + rowOffset, this.column + columnOffset, method, value);
      }
    }
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

  breakApart() {
    this.sheet.merges = this.sheet.merges.filter(merge => {
      const mergeEndRow = merge.row + merge.rowCount - 1;
      const mergeEndColumn = merge.column + merge.columnCount - 1;
      const rangeEndRow = this.row + this.rowCount - 1;
      const rangeEndColumn = this.column + this.columnCount - 1;
      return (
        merge.row > rangeEndRow ||
        mergeEndRow < this.row ||
        merge.column > rangeEndColumn ||
        mergeEndColumn < this.column
      );
    });
    return this.record('breakApart', true);
  }

  setFontWeight(value) { return this.record('setFontWeight', value); }
  setBackgroundColor(value) { return this.record('setBackgroundColor', value); }
  setFontColor(value) { return this.record('setFontColor', value); }
  setVerticalAlignment(value) { return this.record('setVerticalAlignment', value); }
  setFontSize(value) { return this.record('setFontSize', value); }
  setHorizontalAlignment(value) { return this.record('setHorizontalAlignment', value); }
  setWrap(value) { return this.record('setWrap', value); }
  setBorder(type, style, color) { return this.record('setBorder', { type, style, color }); }
  setFontFamily(value) { return this.record('setFontFamily', value); }
  setNumberFormats(value) { return this.record('setNumberFormats', value); }
  clearFormat() {
    this.sheet.formatting.push({
      method: 'clearFormat',
      value: true,
      row: this.row,
      column: this.column,
      rowCount: this.rowCount,
      columnCount: this.columnCount
    });
    for (let rowOffset = 0; rowOffset < this.rowCount; rowOffset += 1) {
      for (let columnOffset = 0; columnOffset < this.columnCount; columnOffset += 1) {
        this.sheet.clearCellFormats(this.row + rowOffset, this.column + columnOffset);
      }
    }
    return this;
  }
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

function assertRuleIncludesRange(rule, a1) {
  assert.ok(rule, `expected conditional formatting rule for ${a1}`);
  assert.ok(Array.isArray(rule.ranges), `expected conditional formatting rule ranges for ${a1}`);
  assert.ok(
    rule.ranges.some(range => {
      const expected = a1ToIndexes(a1);
      return (
        range.startRow === expected.row &&
        range.startColumn === expected.column &&
        range.endRow === expected.row + expected.rowCount - 1 &&
        range.endColumn === expected.column + expected.columnCount - 1
      );
    }),
    `expected conditional formatting rule to include ${a1}`
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
    this.cellFormats = new Map();
    this.frozenRows = 0;
    this.frozenColumns = 0;
    this.hiddenGridlines = false;
    this.conditionalFormattingRules = [];
    this.charts = [];
    this.hiddenColumns = [];
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

  formatKey(row, column, method) {
    return `${row}:${column}:${method}`;
  }

  setCellFormat(row, column, method, value) {
    this.cellFormats.set(this.formatKey(row, column, method), value);
  }

  clearCellFormats(row, column) {
    const prefix = `${row}:${column}:`;
    for (const key of Array.from(this.cellFormats.keys())) {
      if (key.startsWith(prefix)) this.cellFormats.delete(key);
    }
  }

  getCellFormat(row, column, method) {
    return this.cellFormats.get(this.formatKey(row, column, method));
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
  getMaxRows() { return this.rowCapacity; }
  setRowCount(value) { this.rowCapacity = value; return this; }
  getMaxColumns() { return this.columnCapacity; }
  setColumnCount(value) { this.columnCapacity = value; return this; }

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

  newConditionalFormattingRule() {
    return new FakeConditionalFormattingRuleBuilder(this);
  }

  addConditionalFormattingRule(rule) {
    this.conditionalFormattingRules.push(rule);
    return this;
  }

  getConditionalFormattingRules() {
    return this.conditionalFormattingRules;
  }

  clearConditionalFormatRules() {
    this.conditionalFormattingRules = [];
    return this;
  }

  newChart() {
    return new FakeChartBuilder(this);
  }

  async insertChart(chartInfo) {
    const chart = new FakeChart(`chart-${this.charts.length + 1}`, chartInfo);
    this.charts.push(chart);
    return chart;
  }

  getCharts() {
    return this.charts;
  }

  async removeChart(chart) {
    this.charts = this.charts.filter(item => item !== chart);
    return true;
  }

  hideColumns(columnIndex, numColumns) {
    this.hiddenColumns.push({ columnIndex, numColumns });
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

async function executeWorkbookRunScript(script, workbook) {
  return await Function('univerAPI', `return (${script})();`)({
    Enum: {
      BorderType: { ALL: 'ALL', OUTSIDE: 'OUTSIDE', INSIDE: 'INSIDE', NONE: 'NONE' },
      BorderStyleTypes: { THIN: 'THIN' },
      ChartType: { Column: 'Column', Bar: 'Bar' },
      ConditionFormatValueTypeEnum: { num: 'num', min: 'min', max: 'max' }
    },
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

test('generated workbook-local script initializes headers, upserts raw rows, appends runs, and renders weekly rows', async () => {
  const workbook = new FakeWorkbook();
  const firstItem = validItemsPayload().items[0];
  const firstRun = buildWorkbookRunScript({
    rawRows: [mapItemToRawRow(firstItem, '2026-05-26T08:01:00.000Z')],
    displayRows: groupWeeklyDisplayRows([firstItem]),
    runRecord: runRecord(1, 'run-1'),
    weekSheetName: '2026-W22',
    weekStartDate: '2026-05-25',
    weekEndDate: '2026-05-31'
  });

  assert.deepEqual(await executeWorkbookRunScript(firstRun, workbook), {
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
  assert.equal(weekSheet.frozenRows, 0);
  assert.equal(weekSheet.frozenColumns, 0);
  assert.equal(weekSheet.getCell(10, 0), 'Date');
  assert.equal(weekSheet.getCell(11, 0), "='raw-data'!J2");
  assert.equal(weekSheet.getCell(11, 3), "='raw-data'!F2");
  assert.equal(weekSheet.getCell(11, 7), '=IF(\'raw-data\'!O2="","",\'raw-data\'!O2)');

  const updatedItem = { ...firstItem, title: 'Updated agent update', summary: 'New summary' };
  const secondRun = buildWorkbookRunScript({
    rawRows: [mapItemToRawRow(updatedItem, '2026-05-26T09:01:00.000Z')],
    displayRows: groupWeeklyDisplayRows([updatedItem]),
    runRecord: runRecord(2, 'run-2'),
    weekSheetName: '2026-W22',
    weekStartDate: '2026-05-25',
    weekEndDate: '2026-05-31'
  });

  assert.deepEqual(await executeWorkbookRunScript(secondRun, workbook), {
    success: true,
    inserted: 0,
    updated: 1,
    weeklyRows: 1,
    weekSheetName: '2026-W22'
  });
  assert.equal(rawSheet.getCell(1, 5), 'Updated agent update');
  assert.equal(runsSheet.getCell(2, 5), 0);
  assert.equal(runsSheet.getCell(2, 6), 1);
  assert.equal(weekSheet.getCell(11, 3), "='raw-data'!F2");
  assert.equal(weekSheet.getCell(11, 7), '=IF(\'raw-data\'!O2="","",\'raw-data\'!O2)');
});

test('generated workbook-local script keeps first viewport controls, KPIs, and table widths compact', async () => {
  const workbook = new FakeWorkbook();
  const [firstItem, secondItem] = validItemsPayload().items;
  const script = buildWorkbookRunScript({
    rawRows: [
      mapItemToRawRow(firstItem, '2026-05-26T08:01:00.000Z'),
      mapItemToRawRow(secondItem, '2026-05-26T08:01:00.000Z')
    ],
    displayRows: groupWeeklyDisplayRows([firstItem, secondItem]),
    runRecord: runRecord(2, 'run-viewport'),
    weekSheetName: '2026-W22',
    weekStartDate: '2026-05-25',
    weekEndDate: '2026-05-31'
  });

  assert.deepEqual(await executeWorkbookRunScript(script, workbook), {
    success: true,
    inserted: 2,
    updated: 0,
    weeklyRows: 2,
    weekSheetName: '2026-W22'
  });

  const weekSheet = workbook.getSheetByName('2026-W22');
  assert.deepEqual(weekSheet.getRange('A3:J3').getValues()[0], [
    'Source', 'All', 'Score', '0-100', 'Topic', 'All', 'Date\nWeek', 'Sort', 'Signal', 'View\nDigest'
  ]);
  assert.deepEqual(weekSheet.getRange('A4:J4').getValues()[0], [
    'ITEMS', '', 'X', '', 'PODCAST', '', 'BLOG', '', 'MEDIAN', 'LOW SCORE'
  ]);
  assert.equal(weekSheet.getCell(4, 8), '=IF(COUNT(H12:H2000)>0,MEDIAN(H12:H2000),"-")');
  assert.doesNotMatch(weekSheet.getCell(4, 8), /VALUE\(/);
  assert.doesNotMatch(weekSheet.getCell(4, 8), /O:O|J:J|O2:O|J2:J/);
  assert.equal(weekSheet.getCell(4, 9), '=COUNTIFS(\'raw-data\'!J:J,">=2026-05-25",\'raw-data\'!J:J,"<=2026-05-31",\'raw-data\'!O:O,"<50")');

  const visibleWidths = Array.from({ length: 10 }, (_, index) => weekSheet.columnWidths.get(index));
  assert.deepEqual(visibleWidths, [78, 58, 118, 220, 260, 220, 120, 62, 150, 86]);
  assert.ok(visibleWidths.reduce((sum, width) => sum + width, 0) <= 1380);
  assert.ok(weekSheet.columnWidths.get(8) <= 160, 'URL column should not dominate the viewport');
  assert.ok(weekSheet.columnWidths.get(9) <= 90, 'contentId should be visually secondary');
  assert.equal(weekSheet.rowHeights.get(2), 26);
  assert.equal(weekSheet.rowHeights.get(3), 24);
  assert.equal(weekSheet.rowHeights.get(4), 34);
  assert.equal(weekSheet.getCellFormat(3, 0, 'setFontSize'), 9);
  assert.equal(weekSheet.getCellFormat(3, 0, 'setFontColor'), '#FFFFFF');
  assert.equal(weekSheet.getCellFormat(4, 0, 'setFontSize'), 18);
});

test('generated workbook-local script renders the weekly sheet from raw-data history', async () => {
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
  assert.deepEqual(await executeWorkbookRunScript(firstRun, workbook), {
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
  assert.deepEqual(await executeWorkbookRunScript(secondRun, workbook), {
    success: true,
    inserted: 1,
    updated: 0,
    weeklyRows: 2,
    weekSheetName: '2026-W22'
  });

  const weekSheet = workbook.getSheetByName('2026-W22');
  assert.equal(weekSheet.getCell(11, 0), "='raw-data'!J3");
  assert.equal(weekSheet.getCell(11, 1), '=IF(\'raw-data\'!B3="x","X",IF(\'raw-data\'!B3="podcast","Podcast",IF(\'raw-data\'!B3="blog","Blog",\'raw-data\'!B3)))');
  assert.equal(weekSheet.getCell(11, 7), '=IF(\'raw-data\'!O3="","",\'raw-data\'!O3)');
  assert.equal(weekSheet.getCell(11, 3), "='raw-data'!F3");
  assert.equal(weekSheet.getCell(12, 0), "='raw-data'!J2");
  assert.equal(weekSheet.getCell(12, 7), '=IF(\'raw-data\'!O2="","",\'raw-data\'!O2)');
  assert.equal(weekSheet.getCell(12, 3), "='raw-data'!F2");
});

test('generated workbook-local script expands existing old weekly sheets before rendering dashboard', async () => {
  const workbook = new FakeWorkbook();
  workbook.create('2026-W22', 120, 10);
  const firstItem = validItemsPayload().items[0];
  const script = buildWorkbookRunScript({
    rawRows: [mapItemToRawRow(firstItem, '2026-05-26T08:01:00.000Z')],
    displayRows: groupWeeklyDisplayRows([firstItem]),
    runRecord: runRecord(1, 'run-old-week-sheet'),
    weekSheetName: '2026-W22',
    weekStartDate: '2026-05-25',
    weekEndDate: '2026-05-31'
  });

  assert.deepEqual(await executeWorkbookRunScript(script, workbook), {
    success: true,
    inserted: 1,
    updated: 0,
    weeklyRows: 1,
    weekSheetName: '2026-W22'
  });

  const weekSheet = workbook.getSheetByName('2026-W22');
  assert.ok(weekSheet.rowCapacity >= 176);
  assert.equal(weekSheet.getCell(0, 0), '2026-W22 Follow Builders');
  assert.equal(weekSheet.frozenRows, 0);
  assert.equal(weekSheet.frozenColumns, 0);
  assert.equal(weekSheet.getCell(10, 0), 'Date');
  assert.equal(weekSheet.getCell(11, 3), "='raw-data'!F2");
  assert.ok(weekSheet.columnCapacity >= 15);
  assert.equal(weekSheet.getCell(0, 11), 'helper');
  assert.equal(weekSheet.getCell(6, 11), 'daily volume');
  assert.ok(weekSheet.hiddenColumns.some(entry => entry.columnIndex === 11 && entry.numColumns >= 4));
  assert.ok(weekSheet.charts.some(chart => chart.info.chartType === 'Column' && chart.info.range === 'L7:M14'));
});

test('generated workbook-local script removes stale weekly dashboard merges before repainting analyst panels', async () => {
  const workbook = new FakeWorkbook();
  const weekSheet = workbook.create('2026-W22', 220, 19);
  weekSheet.getRange('A6:J6').merge({ isForceMerge: true }).setValue('Daily Digest');
  const firstItem = validItemsPayload().items[0];
  const script = buildWorkbookRunScript({
    rawRows: [mapItemToRawRow(firstItem, '2026-05-26T08:01:00.000Z')],
    displayRows: groupWeeklyDisplayRows([firstItem]),
    runRecord: runRecord(1, 'run-stale-merge-week-sheet'),
    weekSheetName: '2026-W22',
    weekStartDate: '2026-05-25',
    weekEndDate: '2026-05-31'
  });

  assert.deepEqual(await executeWorkbookRunScript(script, workbook), {
    success: true,
    inserted: 1,
    updated: 0,
    weeklyRows: 1,
    weekSheetName: '2026-W22'
  });

  assert.ok(!weekSheet.merges.some(merge => (
    merge.row === 5 &&
    merge.column === 0 &&
    merge.rowCount === 1 &&
    merge.columnCount === 10
  )));
  assert.equal(weekSheet.getCell(5, 0), 'TOPIC HEAT');
  assert.equal(weekSheet.getCell(5, 4), 'SCORE DISTRIBUTION');
  assert.equal(weekSheet.getCell(5, 7), 'DAILY VOLUME');
  assert.ok(weekSheet.formatting.some(entry => entry.method === 'breakApart' && entry.row === 0 && entry.column === 0));
});

test('generated workbook-local script fails clearly when narrow weekly sheet cannot grow helper columns', async () => {
  const workbook = new FakeWorkbook();
  const fixedSheet = workbook.create('2026-W22', 220, 10);
  fixedSheet.setColumnCount = undefined;
  fixedSheet.insertColumnsAfter = undefined;
  const firstItem = validItemsPayload().items[0];
  const script = buildWorkbookRunScript({
    rawRows: [mapItemToRawRow(firstItem, '2026-05-26T08:01:00.000Z')],
    displayRows: groupWeeklyDisplayRows([firstItem]),
    runRecord: runRecord(1, 'run-fixed-narrow-week-sheet'),
    weekSheetName: '2026-W22',
    weekStartDate: '2026-05-25',
    weekEndDate: '2026-05-31'
  });

  assert.deepEqual(await executeWorkbookRunScript(script, workbook), {
    success: false,
    error: '2026-W22 requires at least 15 columns for Analyst Console helper ranges; current sheet has 10 columns and cannot be expanded'
  });

  assert.equal(fixedSheet.getCell(0, 11), '');
  assert.equal(fixedSheet.charts.length, 0);
  assert.equal(workbook.getSheetByName('raw-data'), null);
  assert.equal(workbook.getSheetByName('runs'), null);
});

test('generated workbook-local script fails clearly before mutation when short weekly sheet cannot grow rows', async () => {
  const workbook = new FakeWorkbook();
  const fixedSheet = workbook.create('2026-W22', 120, 19);
  fixedSheet.setRowCount = undefined;
  fixedSheet.insertRowsAfter = undefined;
  const firstItem = validItemsPayload().items[0];
  const script = buildWorkbookRunScript({
    rawRows: [mapItemToRawRow(firstItem, '2026-05-26T08:01:00.000Z')],
    displayRows: groupWeeklyDisplayRows([firstItem]),
    runRecord: runRecord(1, 'run-fixed-short-week-sheet'),
    weekSheetName: '2026-W22',
    weekStartDate: '2026-05-25',
    weekEndDate: '2026-05-31'
  });

  assert.deepEqual(await executeWorkbookRunScript(script, workbook), {
    success: false,
    error: '2026-W22 requires at least 222 rows for Analyst Console weekly rendering; current sheet has 120 rows and cannot be expanded'
  });

  assert.equal(fixedSheet.getCell(0, 0), '');
  assert.equal(workbook.getSheetByName('raw-data'), null);
  assert.equal(workbook.getSheetByName('runs'), null);
});

test('generated workbook-local script preflights weekly rows from existing raw-data history before mutation', async () => {
  const workbook = new FakeWorkbook();
  const fixedSheet = workbook.create('2026-W22', 225, 15);
  fixedSheet.setRowCount = undefined;
  fixedSheet.insertRowsAfter = undefined;
  const rawSheet = workbook.create('raw-data', 2000, 20);
  const runsSheet = workbook.create('runs', 500, 13);
  const baseItem = validItemsPayload().items[0];
  const originalRawRowCount = 9;
  Array.from({ length: originalRawRowCount }, (_, index) => {
    rawSheet.getRange(index + 1, 0, 1, 20).setValues([mapItemToRawRow({
      ...baseItem,
      contentId: `existing:${index}`,
      title: `Existing ${index}`,
      runDate: '2026-05-26'
    }, '2026-05-26T07:01:00.000Z')]);
  });
  runsSheet.getRange(1, 0).setValue('run-existing');
  const firstItem = { ...baseItem, contentId: 'incoming:new' };
  const script = buildWorkbookRunScript({
    rawRows: [mapItemToRawRow(firstItem, '2026-05-26T08:01:00.000Z')],
    displayRows: groupWeeklyDisplayRows([firstItem]),
    runRecord: runRecord(1, 'run-fixed-history-week-sheet'),
    weekSheetName: '2026-W22',
    weekStartDate: '2026-05-25',
    weekEndDate: '2026-05-31'
  });

  assert.deepEqual(await executeWorkbookRunScript(script, workbook), {
    success: false,
    error: '2026-W22 requires at least 231 rows for Analyst Console weekly rendering; current sheet has 225 rows and cannot be expanded'
  });

  assert.equal(rawSheet.getCell(10, 0), '');
  assert.equal(runsSheet.getCell(2, 0), '');
});

test('generated workbook-local script does not grow raw or runs before weekly row preflight failure', async () => {
  const workbook = new FakeWorkbook();
  const fixedSheet = workbook.create('2026-W22', 225, 15);
  fixedSheet.setRowCount = undefined;
  fixedSheet.insertRowsAfter = undefined;
  const rawSheet = workbook.create('raw-data', 10, 20);
  const runsSheet = workbook.create('runs', 2, 13);
  const baseItem = validItemsPayload().items[0];
  Array.from({ length: 9 }, (_, index) => {
    rawSheet.getRange(index + 1, 0, 1, 20).setValues([mapItemToRawRow({
      ...baseItem,
      contentId: `existing:${index}`,
      title: `Existing ${index}`,
      runDate: '2026-05-26'
    }, '2026-05-26T07:01:00.000Z')]);
  });
  runsSheet.getRange(1, 0).setValue('run-existing');
  const script = buildWorkbookRunScript({
    rawRows: [mapItemToRawRow({ ...baseItem, contentId: 'incoming:new' }, '2026-05-26T08:01:00.000Z')],
    displayRows: [],
    runRecord: runRecord(1, 'run-weekly-fails-before-raw-growth'),
    weekSheetName: '2026-W22',
    weekStartDate: '2026-05-25',
    weekEndDate: '2026-05-31'
  });

  assert.deepEqual(await executeWorkbookRunScript(script, workbook), {
    success: false,
    error: '2026-W22 requires at least 231 rows for Analyst Console weekly rendering; current sheet has 225 rows and cannot be expanded'
  });

  assert.equal(rawSheet.rowCapacity, 10);
  assert.equal(runsSheet.rowCapacity, 2);
  assert.equal(rawSheet.getCell(10, 0), '');
  assert.equal(runsSheet.getCell(2, 0), '');
});

test('generated workbook-local script preflights full raw-data before writing any raw or run rows', async () => {
  const workbook = new FakeWorkbook();
  workbook.create('2026-W22', 240, 15);
  const rawSheet = workbook.create('raw-data', 2, 20);
  const runsSheet = workbook.create('runs', 500, 13);
  rawSheet.setRowCount = undefined;
  rawSheet.insertRowsAfter = undefined;
  const [firstItem, secondItem] = validItemsPayload().items;
  rawSheet.getRange(0, 0, 1, RAW_DATA_HEADERS.length).setValues([RAW_DATA_HEADERS]);
  rawSheet.getRange(1, 0, 1, 20).setValues([mapItemToRawRow({
    ...firstItem,
    contentId: 'existing:1',
    title: 'Existing raw row'
  }, '2026-05-26T07:01:00.000Z')]);
  runsSheet.getRange(1, 0).setValue('run-existing');
  const script = buildWorkbookRunScript({
    rawRows: [
      mapItemToRawRow({ ...firstItem, contentId: 'incoming:1' }, '2026-05-26T08:01:00.000Z'),
      mapItemToRawRow({ ...secondItem, contentId: 'incoming:2' }, '2026-05-26T08:01:00.000Z')
    ],
    displayRows: [],
    runRecord: runRecord(2, 'run-full-raw'),
    weekSheetName: '2026-W22',
    weekStartDate: '2026-05-25',
    weekEndDate: '2026-05-31'
  });

  assert.deepEqual(await executeWorkbookRunScript(script, workbook), {
    success: false,
    error: 'raw-data requires at least 4 rows for raw-data upsert; current sheet has 2 rows and cannot be expanded'
  });

  assert.equal(rawSheet.getCell(1, 0), 'existing:1');
  assert.equal(rawSheet.getCell(1, 5), 'Existing raw row');
  assert.equal(rawSheet.getCell(2, 0), '');
  assert.equal(runsSheet.getCell(2, 0), '');
});

test('generated workbook-local script preflights full runs sheet before writing raw rows', async () => {
  const workbook = new FakeWorkbook();
  workbook.create('2026-W22', 240, 15);
  const rawSheet = workbook.create('raw-data', 2000, 20);
  const runsSheet = workbook.create('runs', 2, 13);
  runsSheet.setRowCount = undefined;
  runsSheet.insertRowsAfter = undefined;
  runsSheet.getRange(0, 0, 1, RUNS_HEADERS.length).setValues([RUNS_HEADERS]);
  runsSheet.getRange(1, 0).setValue('run-existing');
  const firstItem = validItemsPayload().items[0];
  const script = buildWorkbookRunScript({
    rawRows: [mapItemToRawRow(firstItem, '2026-05-26T08:01:00.000Z')],
    displayRows: groupWeeklyDisplayRows([firstItem]),
    runRecord: runRecord(1, 'run-full-runs'),
    weekSheetName: '2026-W22',
    weekStartDate: '2026-05-25',
    weekEndDate: '2026-05-31'
  });

  assert.deepEqual(await executeWorkbookRunScript(script, workbook), {
    success: false,
    error: 'runs requires at least 3 rows for run append; current sheet has 2 rows and cannot be expanded'
  });

  assert.equal(rawSheet.getCell(1, 0), '');
  assert.equal(runsSheet.getCell(1, 0), 'run-existing');
  assert.equal(runsSheet.getCell(2, 0), '');
});

test('generated workbook-local script preflights narrow raw-data columns before weekly side effects', async () => {
  const workbook = new FakeWorkbook();
  const weekSheet = workbook.create('2026-W22', 120, 10);
  const rawSheet = workbook.create('raw-data', 2000, 10);
  const runsSheet = workbook.create('runs', 500, 13);
  rawSheet.setColumnCount = undefined;
  rawSheet.insertColumnsAfter = undefined;
  const firstItem = validItemsPayload().items[0];
  const script = buildWorkbookRunScript({
    rawRows: [mapItemToRawRow(firstItem, '2026-05-26T08:01:00.000Z')],
    displayRows: groupWeeklyDisplayRows([firstItem]),
    runRecord: runRecord(1, 'run-narrow-raw-before-weekly'),
    weekSheetName: '2026-W22',
    weekStartDate: '2026-05-25',
    weekEndDate: '2026-05-31'
  });

  assert.deepEqual(await executeWorkbookRunScript(script, workbook), {
    success: false,
    error: 'raw-data requires at least 20 columns for raw-data upsert; current sheet has 10 columns and cannot be expanded'
  });

  assert.equal(weekSheet.rowCapacity, 120);
  assert.equal(weekSheet.columnCapacity, 10);
  assert.equal(weekSheet.getCell(0, 0), '');
  assert.equal(rawSheet.getCell(1, 0), '');
  assert.equal(runsSheet.getCell(1, 0), '');
});

test('generated workbook-local script accepts fixed 15-column weekly sheets for L through O helpers', async () => {
  const workbook = new FakeWorkbook();
  const fixedSheet = workbook.create('2026-W22', 240, 15);
  fixedSheet.setColumnCount = undefined;
  fixedSheet.insertColumnsAfter = undefined;
  const firstItem = validItemsPayload().items[0];
  const script = buildWorkbookRunScript({
    rawRows: [mapItemToRawRow(firstItem, '2026-05-26T08:01:00.000Z')],
    displayRows: groupWeeklyDisplayRows([firstItem]),
    runRecord: runRecord(1, 'run-fixed-15-column-week-sheet'),
    weekSheetName: '2026-W22',
    weekStartDate: '2026-05-25',
    weekEndDate: '2026-05-31'
  });

  assert.deepEqual(await executeWorkbookRunScript(script, workbook), {
    success: true,
    inserted: 1,
    updated: 0,
    weeklyRows: 1,
    weekSheetName: '2026-W22'
  });

  assert.equal(fixedSheet.columnCapacity, 15);
  assert.equal(fixedSheet.getCell(0, 11), 'helper');
  assert.equal(fixedSheet.getCell(15, 14), 'blog');
  assert.ok(fixedSheet.hiddenColumns.some(entry => entry.columnIndex === 11 && entry.numColumns === 4));
  assert.ok(fixedSheet.charts.some(chart => chart.info.chartType === 'Column' && chart.info.range === 'L7:M14'));
});

test('generated workbook-local script renders visible daily volume fallback when chart APIs are unavailable', async () => {
  const workbook = new FakeWorkbook();
  const weekSheet = workbook.create('2026-W22', 220, 19);
  weekSheet.newChart = undefined;
  weekSheet.insertChart = undefined;
  const firstItem = validItemsPayload().items[0];
  const script = buildWorkbookRunScript({
    rawRows: [mapItemToRawRow(firstItem, '2026-05-26T08:01:00.000Z')],
    displayRows: groupWeeklyDisplayRows([firstItem]),
    runRecord: runRecord(1, 'run-chartless-week-sheet'),
    weekSheetName: '2026-W22',
    weekStartDate: '2026-05-25',
    weekEndDate: '2026-05-31'
  });

  assert.deepEqual(await executeWorkbookRunScript(script, workbook), {
    success: true,
    inserted: 1,
    updated: 0,
    weeklyRows: 1,
    weekSheetName: '2026-W22'
  });

  assert.equal(weekSheet.charts.length, 0);
  assert.deepEqual(weekSheet.getRange('H7:J10').getValues(), [
    ['Date', 'Items', ''],
    ['=TEXT(DATEVALUE("2026-05-25")+0,"yyyy-mm-dd")', '=COUNTIFS(\'raw-data\'!J:J,TEXT(DATEVALUE("2026-05-25")+0,"yyyy-mm-dd"))', ''],
    ['=TEXT(DATEVALUE("2026-05-25")+1,"yyyy-mm-dd")', '=COUNTIFS(\'raw-data\'!J:J,TEXT(DATEVALUE("2026-05-25")+1,"yyyy-mm-dd"))', ''],
    ['=TEXT(DATEVALUE("2026-05-25")+2,"yyyy-mm-dd")', '=COUNTIFS(\'raw-data\'!J:J,TEXT(DATEVALUE("2026-05-25")+2,"yyyy-mm-dd"))', '']
  ]);
  assert.equal(weekSheet.getCell(6, 11), 'daily volume');
  assert.equal(weekSheet.getCell(7, 11), '=TEXT(DATEVALUE("2026-05-25")+0,"yyyy-mm-dd")');
  assert.ok(weekSheet.hiddenColumns.some(entry => entry.columnIndex === 11 && entry.numColumns >= 4));
});

test('generated workbook-local script renders visible daily volume fallback when chart insertion fails', async () => {
  const workbook = new FakeWorkbook();
  const weekSheet = workbook.create('2026-W22', 220, 15);
  weekSheet.insertChart = async () => {
    throw new Error('chart service rejected insert');
  };
  const firstItem = validItemsPayload().items[0];
  const script = buildWorkbookRunScript({
    rawRows: [mapItemToRawRow(firstItem, '2026-05-26T08:01:00.000Z')],
    displayRows: groupWeeklyDisplayRows([firstItem]),
    runRecord: runRecord(1, 'run-chart-insert-fails'),
    weekSheetName: '2026-W22',
    weekStartDate: '2026-05-25',
    weekEndDate: '2026-05-31'
  });

  assert.deepEqual(await executeWorkbookRunScript(script, workbook), {
    success: true,
    inserted: 1,
    updated: 0,
    weeklyRows: 1,
    weekSheetName: '2026-W22'
  });

  assert.equal(weekSheet.charts.length, 0);
  assert.equal(weekSheet.getCell(6, 7), 'Date');
  assert.equal(weekSheet.getCell(7, 7), '=TEXT(DATEVALUE("2026-05-25")+0,"yyyy-mm-dd")');
  assert.equal(weekSheet.getCell(7, 8), '=COUNTIFS(\'raw-data\'!J:J,TEXT(DATEVALUE("2026-05-25")+0,"yyyy-mm-dd"))');
});

test('generated workbook-local script renders visible daily volume fallback when chart reset listing fails', async () => {
  const workbook = new FakeWorkbook();
  const weekSheet = workbook.create('2026-W22', 220, 15);
  weekSheet.getCharts = () => {
    throw new Error('chart list failed');
  };
  const firstItem = validItemsPayload().items[0];
  const script = buildWorkbookRunScript({
    rawRows: [mapItemToRawRow(firstItem, '2026-05-26T08:01:00.000Z')],
    displayRows: groupWeeklyDisplayRows([firstItem]),
    runRecord: runRecord(1, 'run-chart-list-fails'),
    weekSheetName: '2026-W22',
    weekStartDate: '2026-05-25',
    weekEndDate: '2026-05-31'
  });

  assert.deepEqual(await executeWorkbookRunScript(script, workbook), {
    success: true,
    inserted: 1,
    updated: 0,
    weeklyRows: 1,
    weekSheetName: '2026-W22'
  });

  assert.equal(weekSheet.charts.length, 0);
  assert.equal(weekSheet.getCell(6, 7), 'Date');
  assert.equal(weekSheet.getCell(7, 7), '=TEXT(DATEVALUE("2026-05-25")+0,"yyyy-mm-dd")');
  assert.equal(weekSheet.getCell(7, 8), '=COUNTIFS(\'raw-data\'!J:J,TEXT(DATEVALUE("2026-05-25")+0,"yyyy-mm-dd"))');
});

test('generated workbook-local script renders visible daily volume fallback when chart removal fails', async () => {
  const workbook = new FakeWorkbook();
  const weekSheet = workbook.create('2026-W22', 220, 15);
  weekSheet.charts.push(new FakeChart('chart-existing', { chartType: 'Column', range: 'L7:M14' }));
  weekSheet.removeChart = async () => {
    throw new Error('chart removal failed');
  };
  const firstItem = validItemsPayload().items[0];
  const script = buildWorkbookRunScript({
    rawRows: [mapItemToRawRow(firstItem, '2026-05-26T08:01:00.000Z')],
    displayRows: groupWeeklyDisplayRows([firstItem]),
    runRecord: runRecord(1, 'run-chart-remove-fails'),
    weekSheetName: '2026-W22',
    weekStartDate: '2026-05-25',
    weekEndDate: '2026-05-31'
  });

  assert.deepEqual(await executeWorkbookRunScript(script, workbook), {
    success: true,
    inserted: 1,
    updated: 0,
    weeklyRows: 1,
    weekSheetName: '2026-W22'
  });

  assert.equal(weekSheet.charts.length, 1);
  assert.equal(weekSheet.getCell(6, 7), 'Date');
  assert.equal(weekSheet.getCell(7, 7), '=TEXT(DATEVALUE("2026-05-25")+0,"yyyy-mm-dd")');
  assert.equal(weekSheet.getCell(7, 8), '=COUNTIFS(\'raw-data\'!J:J,TEXT(DATEVALUE("2026-05-25")+0,"yyyy-mm-dd"))');
});

test('generated workbook-local script renders analyst console formulas, panels, and raw-data references', async () => {
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

  assert.deepEqual(await executeWorkbookRunScript(script, workbook), {
    success: true,
    inserted: 3,
    updated: 0,
    weeklyRows: 3,
    weekSheetName: '2026-W22'
  });

  const weekSheet = workbook.getSheetByName('2026-W22');
  assert.equal(weekSheet.hiddenGridlines, true);
  assert.equal(weekSheet.frozenRows, 0);
  assert.equal(weekSheet.frozenColumns, 0);
  assert.equal(weekSheet.getCell(0, 0), '2026-W22 Follow Builders');
  assert.match(weekSheet.getCell(1, 0), /May 25 - May 31/);

  assert.equal(weekSheet.getCell(2, 0), 'Source');
  assert.equal(weekSheet.getCell(2, 1), 'All');
  assert.equal(weekSheet.getCell(2, 2), 'Score');
  assert.equal(weekSheet.getCell(2, 3), '0-100');
  assert.equal(weekSheet.getCell(2, 4), 'Topic');
  assert.equal(weekSheet.getCell(2, 5), 'All');
  assert.equal(weekSheet.getCell(2, 6), 'Date\nWeek');
  assert.equal(weekSheet.getCell(2, 7), 'Sort');
  assert.equal(weekSheet.getCell(2, 8), 'Signal');
  assert.equal(weekSheet.getCell(2, 9), 'View\nDigest');

  assert.equal(weekSheet.getCell(3, 0), 'ITEMS');
  assert.equal(weekSheet.getCell(4, 0), '=COUNTIFS(\'raw-data\'!J:J,">=2026-05-25",\'raw-data\'!J:J,"<=2026-05-31")');
  assert.equal(weekSheet.getCell(3, 2), 'X');
  assert.equal(weekSheet.getCell(4, 2), '=COUNTIFS(\'raw-data\'!J:J,">=2026-05-25",\'raw-data\'!J:J,"<=2026-05-31",\'raw-data\'!B:B,"x")');
  assert.equal(weekSheet.getCell(3, 4), 'PODCAST');
  assert.equal(weekSheet.getCell(4, 4), '=COUNTIFS(\'raw-data\'!J:J,">=2026-05-25",\'raw-data\'!J:J,"<=2026-05-31",\'raw-data\'!B:B,"podcast")');
  assert.equal(weekSheet.getCell(3, 6), 'BLOG');
  assert.equal(weekSheet.getCell(4, 6), '=COUNTIFS(\'raw-data\'!J:J,">=2026-05-25",\'raw-data\'!J:J,"<=2026-05-31",\'raw-data\'!B:B,"blog")');
  assert.equal(weekSheet.getCell(3, 8), 'MEDIAN');
  assert.equal(weekSheet.getCell(4, 8), '=IF(COUNT(H12:H2000)>0,MEDIAN(H12:H2000),"-")');
  assert.doesNotMatch(weekSheet.getCell(4, 8), /VALUE\(/);
  assert.doesNotMatch(weekSheet.getCell(4, 8), /O:O|J:J|O2:O|J2:J/);
  assert.equal(weekSheet.getCell(3, 9), 'LOW SCORE');
  assert.equal(weekSheet.getCell(4, 9), '=COUNTIFS(\'raw-data\'!J:J,">=2026-05-25",\'raw-data\'!J:J,"<=2026-05-31",\'raw-data\'!O:O,"<50")');

  assert.equal(weekSheet.getCell(5, 0), 'TOPIC HEAT');
  assert.equal(weekSheet.getCell(5, 4), 'SCORE DISTRIBUTION');
  assert.equal(weekSheet.getCell(5, 7), 'DAILY VOLUME');
  assert.equal(weekSheet.getCell(6, 4), '80+');
  assert.equal(weekSheet.getCell(7, 4), '50-79');
  assert.equal(weekSheet.getCell(8, 4), '<50');
  assert.equal(weekSheet.getCell(10, 0), 'Date');
  assert.equal(weekSheet.getCell(11, 0), "='raw-data'!J2");
  assert.equal(weekSheet.getCell(11, 1), '=IF(\'raw-data\'!B2="x","X",IF(\'raw-data\'!B2="podcast","Podcast",IF(\'raw-data\'!B2="blog","Blog",\'raw-data\'!B2)))');
  assert.equal(weekSheet.getCell(12, 1), '=IF(\'raw-data\'!B3="x","X",IF(\'raw-data\'!B3="podcast","Podcast",IF(\'raw-data\'!B3="blog","Blog",\'raw-data\'!B3)))');
  assert.equal(weekSheet.getCell(13, 1), '=IF(\'raw-data\'!B4="x","X",IF(\'raw-data\'!B4="podcast","Podcast",IF(\'raw-data\'!B4="blog","Blog",\'raw-data\'!B4)))');

  assert.equal(weekSheet.getCell(0, 11), 'helper');
  assert.equal(weekSheet.getCell(1, 11), 'score band');
  assert.equal(weekSheet.getCell(6, 11), 'daily volume');
  assert.equal(weekSheet.getCell(15, 11), 'topic heat');
  assert.ok(weekSheet.hiddenColumns.some(entry => entry.columnIndex === 11 && entry.numColumns >= 4));

  assert.equal(weekSheet.getCell(2, 11), '80+');
  assert.equal(weekSheet.getCell(2, 12), '=COUNTIFS(\'raw-data\'!J:J,">=2026-05-25",\'raw-data\'!J:J,"<=2026-05-31",\'raw-data\'!O:O,">=80")');
  assert.equal(weekSheet.getCell(3, 11), '50-79');
  assert.equal(weekSheet.getCell(3, 12), '=COUNTIFS(\'raw-data\'!J:J,">=2026-05-25",\'raw-data\'!J:J,"<=2026-05-31",\'raw-data\'!O:O,">=50",\'raw-data\'!O:O,"<80")');
  assert.equal(weekSheet.getCell(4, 11), '<50');
  assert.equal(weekSheet.getCell(4, 12), '=COUNTIFS(\'raw-data\'!J:J,">=2026-05-25",\'raw-data\'!J:J,"<=2026-05-31",\'raw-data\'!O:O,"<50")');
  assert.deepEqual(
    Array.from({ length: 7 }, (_, index) => [
      weekSheet.getCell(7 + index, 11),
      weekSheet.getCell(7 + index, 12)
    ]),
    Array.from({ length: 7 }, (_, index) => [
      `=TEXT(DATEVALUE("2026-05-25")+${index},"yyyy-mm-dd")`,
      `=COUNTIFS('raw-data'!J:J,TEXT(DATEVALUE("2026-05-25")+${index},"yyyy-mm-dd"))`
    ])
  );
  assert.deepEqual(weekSheet.getRange('L16:O19').getValues(), [
    ['topic heat', 'x', 'podcast', 'blog'],
    ['agents', '=COUNTIFS(\'raw-data\'!J:J,">=2026-05-25",\'raw-data\'!J:J,"<=2026-05-31",\'raw-data\'!N:N,"*agents*",\'raw-data\'!B:B,"x")', '=COUNTIFS(\'raw-data\'!J:J,">=2026-05-25",\'raw-data\'!J:J,"<=2026-05-31",\'raw-data\'!N:N,"*agents*",\'raw-data\'!B:B,"podcast")', '=COUNTIFS(\'raw-data\'!J:J,">=2026-05-25",\'raw-data\'!J:J,"<=2026-05-31",\'raw-data\'!N:N,"*agents*",\'raw-data\'!B:B,"blog")'],
    ['release', '=COUNTIFS(\'raw-data\'!J:J,">=2026-05-25",\'raw-data\'!J:J,"<=2026-05-31",\'raw-data\'!N:N,"*release*",\'raw-data\'!B:B,"x")', '=COUNTIFS(\'raw-data\'!J:J,">=2026-05-25",\'raw-data\'!J:J,"<=2026-05-31",\'raw-data\'!N:N,"*release*",\'raw-data\'!B:B,"podcast")', '=COUNTIFS(\'raw-data\'!J:J,">=2026-05-25",\'raw-data\'!J:J,"<=2026-05-31",\'raw-data\'!N:N,"*release*",\'raw-data\'!B:B,"blog")'],
    ['research', '=COUNTIFS(\'raw-data\'!J:J,">=2026-05-25",\'raw-data\'!J:J,"<=2026-05-31",\'raw-data\'!N:N,"*research*",\'raw-data\'!B:B,"x")', '=COUNTIFS(\'raw-data\'!J:J,">=2026-05-25",\'raw-data\'!J:J,"<=2026-05-31",\'raw-data\'!N:N,"*research*",\'raw-data\'!B:B,"podcast")', '=COUNTIFS(\'raw-data\'!J:J,">=2026-05-25",\'raw-data\'!J:J,"<=2026-05-31",\'raw-data\'!N:N,"*research*",\'raw-data\'!B:B,"blog")']
  ]);

  const scoreDistributionRule = weekSheet.conditionalFormattingRules.find(rule => rule.type === 'dataBar');
  assertRuleIncludesRange(scoreDistributionRule, 'F7:F9');
  const topicHeatRule = weekSheet.conditionalFormattingRules.find(rule => rule.type === 'colorScale');
  assertRuleIncludesRange(topicHeatRule, 'B7:D9');
  const dailyVolumeChart = weekSheet.charts.find(chart => chart.info.chartType === 'Column' && chart.info.range === 'L7:M14');
  assert.ok(dailyVolumeChart, 'expected daily volume column chart from L7:M14');
  assert.deepEqual(dailyVolumeChart.info.position, { row: 5, column: 7, rowOffset: 0, columnOffset: 0 });
  assert.equal(dailyVolumeChart.info.width, 300);
  assert.equal(dailyVolumeChart.info.height, 128);

  assert.notEqual(weekSheet.getCell(5, 0), 'Daily Digest');
  assert.notEqual(weekSheet.getCell(6, 0), 'Date');
  assert.equal(weekSheet.columnWidths.get(4), 260);
  assert.equal(weekSheet.rowHeights.get(11), 64);
  assert.ok(weekSheet.formatting.some(entry => entry.method === 'setBackgroundColor' && entry.value === '#0F1F33'));
  assert.ok(weekSheet.formatting.some(entry => entry.method === 'setWrap' && entry.value === true));
});

test('generated workbook-local script clears stale direct formatting before repainting weekly sheet', async () => {
  const workbook = new FakeWorkbook();
  const weekSheet = workbook.create('2026-W22', 240, 15);
  weekSheet.markFormattedLastRow(60);
  weekSheet.getRange(50, 9).setValue('stale');
  weekSheet.getRange(50, 9).setBackgroundColor('#BADBAD').setFontColor('#101010');
  const firstItem = validItemsPayload().items[0];
  const script = buildWorkbookRunScript({
    rawRows: [mapItemToRawRow(firstItem, '2026-05-26T08:01:00.000Z')],
    displayRows: groupWeeklyDisplayRows([firstItem]),
    runRecord: runRecord(1, 'run-stale-format-week-sheet'),
    weekSheetName: '2026-W22',
    weekStartDate: '2026-05-25',
    weekEndDate: '2026-05-31'
  });

  assert.deepEqual(await executeWorkbookRunScript(script, workbook), {
    success: true,
    inserted: 1,
    updated: 0,
    weeklyRows: 1,
    weekSheetName: '2026-W22'
  });

  assert.equal(weekSheet.getCell(50, 9), '');
  assert.equal(weekSheet.getCellFormat(50, 9, 'setBackgroundColor'), undefined);
  assert.equal(weekSheet.getCellFormat(50, 9, 'setFontColor'), undefined);
  assert.ok(weekSheet.formatting.some(entry => entry.method === 'clearFormat' && entry.row === 0 && entry.column === 0));
});

test('generated workbook-local script applies static score fills at analyst score band boundaries', async () => {
  const workbook = new FakeWorkbook();
  const baseItem = validItemsPayload().items[0];
  const rows = [
    { contentId: 'score:80', importanceScore: 80, title: 'Score 80' },
    { contentId: 'score:50', importanceScore: 50, title: 'Score 50' },
    { contentId: 'score:49', importanceScore: 49, title: 'Score 49' }
  ].map(item => mapItemToRawRow({
    ...baseItem,
    ...item,
    sourceType: 'x',
    runDate: '2026-05-26'
  }, '2026-05-26T08:01:00.000Z'));
  const script = buildWorkbookRunScript({
    rawRows: rows,
    displayRows: [],
    runRecord: runRecord(3, 'run-score-boundaries'),
    weekSheetName: '2026-W22',
    weekStartDate: '2026-05-25',
    weekEndDate: '2026-05-31'
  });

  assert.deepEqual(await executeWorkbookRunScript(script, workbook), {
    success: true,
    inserted: 3,
    updated: 0,
    weeklyRows: 3,
    weekSheetName: '2026-W22'
  });

  const weekSheet = workbook.getSheetByName('2026-W22');
  assert.equal(weekSheet.getCellFormat(11, 7, 'setBackgroundColor'), '#DCFCE7');
  assert.equal(weekSheet.getCellFormat(12, 7, 'setBackgroundColor'), '#FEF3C7');
  assert.equal(weekSheet.getCellFormat(13, 7, 'setBackgroundColor'), '#FEE2E2');
});

test('generated workbook-local script preserves blank raw scores in weekly score formulas', async () => {
  const workbook = new FakeWorkbook();
  const blankScoreItem = {
    ...validItemsPayload().items[0],
    contentId: 'x:blank-score',
    title: 'Blank score update',
    importanceScore: ''
  };
  const script = buildWorkbookRunScript({
    rawRows: [mapItemToRawRow(blankScoreItem, '2026-05-26T08:01:00.000Z')],
    displayRows: [],
    runRecord: runRecord(1, 'run-blank-score'),
    weekSheetName: '2026-W22',
    weekStartDate: '2026-05-25',
    weekEndDate: '2026-05-31'
  });

  assert.deepEqual(await executeWorkbookRunScript(script, workbook), {
    success: true,
    inserted: 1,
    updated: 0,
    weeklyRows: 1,
    weekSheetName: '2026-W22'
  });

  const rawSheet = workbook.getSheetByName('raw-data');
  const weekSheet = workbook.getSheetByName('2026-W22');
  assert.equal(rawSheet.getCell(1, 14), '');
  assert.equal(weekSheet.getCell(11, 7), '=IF(\'raw-data\'!O2="","",\'raw-data\'!O2)');
  assert.equal(weekSheet.getCellFormat(11, 7, 'setBackgroundColor'), '#FFFFFF');
});

test('generated workbook-local script escapes topic wildcards and leaves placeholder topic formulas blank', async () => {
  const workbook = new FakeWorkbook();
  const specialTopicItem = {
    ...validItemsPayload().items[0],
    topics: ['agent*eval?~tilde'],
    importanceScore: 88
  };
  const script = buildWorkbookRunScript({
    rawRows: [mapItemToRawRow(specialTopicItem, '2026-05-26T08:01:00.000Z')],
    runRecord: runRecord(1, 'run-special-topic'),
    weekSheetName: '2026-W22',
    weekStartDate: '2026-05-25',
    weekEndDate: '2026-05-31'
  });

  assert.deepEqual(await executeWorkbookRunScript(script, workbook), {
    success: true,
    inserted: 1,
    updated: 0,
    weeklyRows: 1,
    weekSheetName: '2026-W22'
  });

  const weekSheet = workbook.getSheetByName('2026-W22');
  const escapedTopicFormula = '=COUNTIFS(\'raw-data\'!J:J,">=2026-05-25",\'raw-data\'!J:J,"<=2026-05-31",\'raw-data\'!N:N,"*agent~*eval~?~~tilde*",\'raw-data\'!B:B,"x")';
  assert.equal(weekSheet.getCell(6, 0), 'agent*eval?~tilde');
  assert.equal(weekSheet.getCell(6, 1), escapedTopicFormula);
  assert.equal(weekSheet.getCell(7, 0), '-');
  assert.equal(weekSheet.getCell(7, 1), '');
  assert.equal(weekSheet.getCell(7, 2), '');
  assert.equal(weekSheet.getCell(7, 3), '');
  assert.equal(weekSheet.getCell(15, 11), 'topic heat');
  assert.equal(weekSheet.getCell(16, 11), 'agent*eval?~tilde');
  assert.equal(weekSheet.getCell(16, 12), escapedTopicFormula);
  assert.deepEqual(weekSheet.getRange('L18:O19').getValues(), [
    ['-', '', '', ''],
    ['-', '', '', '']
  ]);
});

test('generated workbook-local script appends after last non-empty key row when sheets have formatted blank rows', async () => {
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

  assert.deepEqual(await executeWorkbookRunScript(script, workbook), {
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
