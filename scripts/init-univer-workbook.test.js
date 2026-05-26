import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { constants } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import test from 'node:test';
import assert from 'node:assert/strict';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const INIT = join(SCRIPT_DIR, 'init-univer-workbook.js');
const SCAFFOLD = join(SCRIPT_DIR, 'univer-template-scaffold.js');

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

async function writeFakeUniver(path, callsPath, options = {}) {
  const syncBody = options.syncBody || `echo '{"success":true,"status":{"unitID":"unit-test-1","uncommittedMutationCount":0}}'; exit 0`;
  const runBody = options.runBody || `echo '{"success":true,"sheets":["raw-data","runs","_week-template"]}'; exit 0`;
  const commitBody = options.commitBody || `echo '{"success":true,"committed":true}'; exit 0`;
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
    ${commitBody}
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

async function writeFakeWorkbookPackage(path, markerText) {
  await mkdir(join(path, 'data'), { recursive: true });
  await writeFile(join(path, 'data', 'marker.txt'), markerText, 'utf-8');
}

function parseA1Range(a1) {
  const match = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(a1);
  if (!match) throw new Error(`Unsupported A1 range: ${a1}`);
  const columnIndex = letters => letters.split('').reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) - 1;
  const startColumn = columnIndex(match[1]);
  const startRow = Number(match[2]) - 1;
  const endColumn = match[3] ? columnIndex(match[3]) : startColumn;
  const endRow = match[4] ? Number(match[4]) - 1 : startRow;
  return {
    row: startRow,
    column: startColumn,
    rowCount: endRow - startRow + 1,
    columnCount: endColumn - startColumn + 1
  };
}

class ScaffoldFakeRange {
  constructor(sheet, row, column, rowCount, columnCount) {
    Object.assign(this, { sheet, row, column, rowCount, columnCount });
  }

  clear() { return this; }
  clearContent() { return this; }
  merge() { return this; }
  setValue() { return this; }
  setValues() { return this; }
  setFontWeight() { return this; }
  setFontColor() { return this; }
  setFontSize() { return this; }
  setBackgroundColor() { return this; }
  setVerticalAlignment() { return this; }
  setHorizontalAlignment() { return this; }
  setWrap() { return this; }
  setBorder() { return this; }
  getValue() { return ''; }
  getRange() { return this; }
}

class ScaffoldFakeSheet {
  constructor(name, rows, columns, options = {}) {
    Object.assign(this, {
      name,
      rows,
      columns,
      options,
      conditionalFormattingRules: [],
      sheetId: `sheet-${name}`
    });
    if (options.noConditionalFormattingRuleGetter) {
      this.getConditionalFormattingRules = undefined;
    }
  }

  getSheetName() { return this.name; }
  getSheetId() { return this.sheetId; }
  getLastRow() { return 0; }
  getLastColumn() { return 0; }
  getMaxRows() { return this.rows; }
  getMaxColumns() { return this.columns; }
  setRowCount(value) { this.rows = value; return this; }
  setColumnCount(value) { this.columns = value; return this; }
  insertRowsAfter(_index, count) { this.rows += count; return this; }
  insertColumnsAfter(_index, count) { this.columns += count; return this; }
  setHiddenGridlines() { return this; }
  setFrozenRows() { return this; }
  setFrozenColumns() { return this; }
  setRowHeight() { return this; }
  setRowHeights() { return this; }
  setColumnWidth() { return this; }
  setColumnWidths() { return this; }
  hideColumns() { return this; }
  clearConditionalFormatRules() { this.conditionalFormattingRules = []; return this; }
  addConditionalFormattingRule(rule) { this.conditionalFormattingRules.push(rule); return this; }
  getConditionalFormattingRules() { return this.conditionalFormattingRules; }
  newConditionalFormattingRule() {
    if (this.options.partialConditionalFormattingBuilder) {
      return { build: () => ({ partial: true }) };
    }
    return undefined;
  }

  getRange(rowOrA1, column, rowCount = 1, columnCount = 1) {
    const range = typeof rowOrA1 === 'string'
      ? parseA1Range(rowOrA1)
      : { row: rowOrA1, column, rowCount, columnCount };
    if (range.row < 0 || range.column < 0 || range.row + range.rowCount > this.rows || range.column + range.columnCount > this.columns) {
      throw new Error(`${this.name} range out of bounds: ${JSON.stringify(range)} for ${this.rows}x${this.columns}`);
    }
    return new ScaffoldFakeRange(this, range.row, range.column, range.rowCount, range.columnCount);
  }
}

class ScaffoldFakeWorkbook {
  constructor(sheets = []) {
    this.sheets = sheets;
  }

  getSheetByName(name) {
    return this.sheets.find(sheet => sheet.name === name);
  }

  create(name, rows, columns) {
    const sheet = new ScaffoldFakeSheet(name, rows, columns);
    this.sheets.push(sheet);
    return sheet;
  }

  getSheets() { return this.sheets; }
  deleteSheet(sheetId) {
    this.sheets = this.sheets.filter(sheet => sheet.sheetId !== sheetId);
  }
}

async function runScaffoldWithWorkbook(workbook, enumOverrides = {}) {
  const scaffoldSource = await readFile(SCAFFOLD, 'utf-8');
  const scaffold = Function(`return ${scaffoldSource}`)();
  const previousUniverAPI = globalThis.univerAPI;
  globalThis.univerAPI = {
    Enum: {
      BorderType: { OUTSIDE: 'outside' },
      BorderStyleTypes: { THIN: 'thin' },
      ...enumOverrides
    },
    getActiveWorkbook: () => workbook
  };
  try {
    return scaffold();
  } finally {
    globalThis.univerAPI = previousUniverAPI;
  }
}

test('scaffold grows an existing narrow week template before writing helper columns', async () => {
  const weekSheet = new ScaffoldFakeSheet('_week-template', 240, 10);
  const workbook = new ScaffoldFakeWorkbook([
    new ScaffoldFakeSheet('raw-data', 1000, 20),
    new ScaffoldFakeSheet('runs', 500, 13),
    weekSheet
  ]);

  const result = await runScaffoldWithWorkbook(workbook);

  assert.equal(result.success, true, result.error);
  assert.equal(weekSheet.columns, 15);
});

test('scaffold skips conditional formatting when partial CF APIs are unavailable', async () => {
  const weekSheet = new ScaffoldFakeSheet('_week-template', 240, 15, {
    partialConditionalFormattingBuilder: true,
    noConditionalFormattingRuleGetter: true
  });
  const workbook = new ScaffoldFakeWorkbook([
    new ScaffoldFakeSheet('raw-data', 1000, 20),
    new ScaffoldFakeSheet('runs', 500, 13),
    weekSheet
  ]);

  const result = await runScaffoldWithWorkbook(workbook, { ConditionFormatValueTypeEnum: undefined });

  assert.equal(result.success, true, result.error);
  assert.equal(result.weekConditionalFormattingRules, 0);
});

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
    `inspect range ${workbookPath} --range _week-template!A1:J12`,
    `commit ${workbookPath} --message Initialize follow-builders workbook --json`,
    `sync ${workbookPath} --json`
  ]);
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

test('rejects option flags without values before using default home', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fb-init-root-'));
  const guardHome = await mkdtemp(join(tmpdir(), 'fb-init-guard-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(guardHome, { recursive: true, force: true }));

  const fakeUniver = join(root, 'fake-univer');
  await writeFakeUniver(fakeUniver, join(root, 'calls.log'));

  const result = spawnSync(process.execPath, [
    INIT,
    '--skill-dir', root,
    '--univer-path', fakeUniver,
    '--home'
  ], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: guardHome }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /--home requires a value/);
  assert.equal(await pathExists(join(guardHome, '.follow-builders')), false);
});

test('restores existing workbook when forced sync fails after overwrite', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fb-init-root-'));
  const home = await mkdtemp(join(tmpdir(), 'fb-init-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(home, { recursive: true, force: true }));

  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'scripts', 'univer-template-scaffold.js'), '() => ({ success: true })', 'utf-8');
  await mkdir(join(home, '.follow-builders'), { recursive: true });
  const workbookPath = join(home, '.follow-builders', 'follow-builders.univer');
  await writeFakeWorkbookPackage(workbookPath, 'original');

  const fakeUniver = join(root, 'fake-univer');
  await writeFakeUniver(fakeUniver, join(root, 'calls.log'), {
    syncBody: 'echo "sync failed" >&2; exit 9'
  });

  const result = spawnSync(process.execPath, [
    INIT,
    '--skill-dir', root,
    '--home', home,
    '--univer-path', fakeUniver,
    '--force'
  ], { encoding: 'utf-8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /sync failed/);
  assert.equal(await readFile(join(workbookPath, 'data', 'marker.txt'), 'utf-8'), 'original');
});

test('restores existing workbook when forced commit returns unsuccessful JSON', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fb-init-root-'));
  const home = await mkdtemp(join(tmpdir(), 'fb-init-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(home, { recursive: true, force: true }));

  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'scripts', 'univer-template-scaffold.js'), '() => ({ success: true })', 'utf-8');
  await mkdir(join(home, '.follow-builders'), { recursive: true });
  const workbookPath = join(home, '.follow-builders', 'follow-builders.univer');
  await writeFakeWorkbookPackage(workbookPath, 'original');

  const fakeUniver = join(root, 'fake-univer');
  await writeFakeUniver(fakeUniver, join(root, 'calls.log'), {
    commitBody: `echo '{"success":false,"committed":false,"error":"commit rejected"}'; exit 0`
  });

  const result = spawnSync(process.execPath, [
    INIT,
    '--skill-dir', root,
    '--home', home,
    '--univer-path', fakeUniver,
    '--force'
  ], { encoding: 'utf-8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /commit rejected/);
  assert.equal(await readFile(join(workbookPath, 'data', 'marker.txt'), 'utf-8'), 'original');
});

test('rejects unsuccessful sync JSON even when a unit id is present', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fb-init-root-'));
  const home = await mkdtemp(join(tmpdir(), 'fb-init-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(home, { recursive: true, force: true }));

  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'scripts', 'univer-template-scaffold.js'), '() => ({ success: true })', 'utf-8');

  const fakeUniver = join(root, 'fake-univer');
  await writeFakeUniver(
    fakeUniver,
    join(root, 'calls.log'),
    {
      syncBody: `echo '{"success":false,"unitId":"unit-bad","error":"sync rejected"}'; exit 0`
    }
  );

  const result = spawnSync(process.execPath, [
    INIT,
    '--skill-dir', root,
    '--home', home,
    '--univer-path', fakeUniver
  ], { encoding: 'utf-8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /univer sync failed: sync rejected/);
  assert.equal(await pathExists(join(home, '.follow-builders', 'config.json')), false);
});

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

test('restores existing workbook when forced scaffold outputs malformed JSON', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fb-init-root-'));
  const home = await mkdtemp(join(tmpdir(), 'fb-init-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(home, { recursive: true, force: true }));

  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'scripts', 'univer-template-scaffold.js'), '() => ({ success: true })', 'utf-8');
  await mkdir(join(home, '.follow-builders'), { recursive: true });
  const workbookPath = join(home, '.follow-builders', 'follow-builders.univer');
  await writeFakeWorkbookPackage(workbookPath, 'original');

  const fakeUniver = join(root, 'fake-univer');
  await writeFakeUniver(fakeUniver, join(root, 'calls.log'), {
    runBody: 'echo "not-json"; exit 0'
  });

  const result = spawnSync(process.execPath, [
    INIT,
    '--skill-dir', root,
    '--home', home,
    '--univer-path', fakeUniver,
    '--force'
  ], { encoding: 'utf-8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /Could not parse univer run JSON output/);
  assert.equal(await readFile(join(workbookPath, 'data', 'marker.txt'), 'utf-8'), 'original');
});
