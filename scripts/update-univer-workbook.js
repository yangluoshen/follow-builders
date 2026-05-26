#!/usr/bin/env node

import { access, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { constants } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { homedir, tmpdir } from 'os';
import { randomUUID } from 'crypto';
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

function readOptionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function parseArgs(argv) {
  const out = {
    home: homedir(),
    markdownPath: '',
    univerPath: process.env.FOLLOW_BUILDERS_UNIVER_PATH || 'univer'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--home') {
      out.home = readOptionValue(argv, i, arg);
      i += 1;
    } else if (arg === '--items-json') {
      out.itemsJsonPath = readOptionValue(argv, i, arg);
      i += 1;
    } else if (arg === '--markdown-path') {
      out.markdownPath = readOptionValue(argv, i, arg);
      i += 1;
    } else if (arg === '--univer-path') {
      out.univerPath = readOptionValue(argv, i, arg);
      i += 1;
    } else if (arg === '--help') {
      out.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!out.help && !out.itemsJsonPath) {
    throw new Error('--items-json is required');
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

export function isoWeekName(value = new Date()) {
  const input = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(input.getTime())) {
    throw new Error(`Invalid date for ISO week: ${value}`);
  }
  const date = new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function dedupeItemsByContentId(items) {
  const byId = new Map();
  for (const item of items) {
    byId.set(item.contentId, item);
  }
  return [...byId.values()];
}

export function buildRunRecord({
  payload,
  itemsJsonPath,
  markdownPath,
  config,
  startedAt,
  finishedAt,
  itemsSeen
}) {
  const unitId = config.univer?.unitId || '';
  const publicUrl = config.univer?.publicUrl || publicUrlForUnit(unitId) || '';
  return {
    runId: payload.runId || `run-${finishedAt}-${randomUUID()}`,
    startedAt,
    finishedAt,
    status: 'ok',
    itemsSeen,
    markdownPath: markdownPath || '',
    itemsJsonPath,
    syncStatus: 'pending',
    unitId,
    publicUrl,
    errorSummary: ''
  };
}

function parseJsonOutput(stdout, label) {
  try {
    return JSON.parse(stdout.trim());
  } catch (err) {
    throw new Error(`Could not parse ${label} JSON output: ${err.message}`);
  }
}

function normalizeRows(rows, width) {
  return rows.map(row => {
    const next = row.slice(0, width);
    while (next.length < width) next.push('');
    return next;
  });
}

export function buildWorkbookRunScript({ rawRows, displayRows, runRecord, weekSheetName }) {
  const payload = {
    rawHeaders: RAW_DATA_HEADERS,
    runsHeaders: RUNS_HEADERS,
    weekHeaders: WEEK_DISPLAY_HEADERS,
    rawRows: normalizeRows(rawRows, RAW_DATA_HEADERS.length),
    displayRows: normalizeRows(displayRows, WEEK_DISPLAY_HEADERS.length),
    runRecord,
    sheetNames: {
      rawData: SHEETS.rawData,
      runs: SHEETS.runs,
      week: weekSheetName
    }
  };

  return `() => {
  const payload = ${JSON.stringify(payload)};
  const DISPLAY_HEADER_ROW = 14;
  const DISPLAY_DATA_ROW = DISPLAY_HEADER_ROW + 1;

  function stringValue(value) {
    if (value === null || value === undefined) return '';
    return String(value);
  }

  function headerValues(sheet, count) {
    return sheet.getRange(0, 0, 1, count).getValues()[0].map(stringValue);
  }

  function isBlankHeader(values) {
    return values.every(value => value === '');
  }

  function sameHeader(actual, expected) {
    return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
  }

  function ensureSheet(workbook, name, rows, columns) {
    return workbook.getSheetByName(name) || workbook.create(name, rows, columns);
  }

  function setHeader(sheet, headers) {
    sheet.getRange(0, 0, 1, headers.length).setValues([headers]);
    sheet
      .getRange(0, 0, 1, headers.length)
      .setFontWeight('bold')
      .setBackgroundColor('#17324D')
      .setFontColor('#FFFFFF')
      .setVerticalAlignment('middle');
  }

  function assertOrInitHeader(sheet, headers, sheetName) {
    const actual = headerValues(sheet, headers.length);
    if (isBlankHeader(actual)) {
      setHeader(sheet, headers);
      return;
    }
    if (!sameHeader(actual, headers)) {
      throw new Error(sheetName + ' headers do not match expected contract: ' + JSON.stringify(actual));
    }
    setHeader(sheet, headers);
  }

  function nextAppendRow(sheet) {
    return Math.max(sheet.getLastRow() + 1, 1);
  }

  function existingRawRowIndex(sheet) {
    const lastRow = sheet.getLastRow();
    const index = new Map();
    if (lastRow < 1) return index;
    const values = sheet.getRange(1, 0, lastRow, 1).getValues();
    values.forEach((row, offset) => {
      const contentId = stringValue(row[0]);
      if (contentId) index.set(contentId, offset + 1);
    });
    return index;
  }

  function upsertRawRows(sheet, rows) {
    const rowIndex = existingRawRowIndex(sheet);
    let inserted = 0;
    let updated = 0;
    rows.forEach(row => {
      const contentId = stringValue(row[0]);
      if (!contentId) throw new Error('raw row contentId is required');
      if (rowIndex.has(contentId)) {
        sheet.getRange(rowIndex.get(contentId), 0, 1, payload.rawHeaders.length).setValues([row]);
        updated += 1;
      } else {
        const appendRow = nextAppendRow(sheet);
        sheet.getRange(appendRow, 0, 1, payload.rawHeaders.length).setValues([row]);
        rowIndex.set(contentId, appendRow);
        inserted += 1;
      }
    });
    return { inserted, updated };
  }

  function appendRunRow(sheet, inserted, updated) {
    const run = payload.runRecord;
    const row = [
      run.runId,
      run.startedAt,
      run.finishedAt,
      run.status,
      run.itemsSeen,
      inserted,
      updated,
      run.markdownPath,
      run.itemsJsonPath,
      run.syncStatus,
      run.unitId,
      run.publicUrl,
      run.errorSummary
    ];
    sheet.getRange(nextAppendRow(sheet), 0, 1, payload.runsHeaders.length).setValues([row]);
  }

  function applyDataSheetFormatting(sheet, width) {
    sheet.setFrozenRows(1);
    sheet.setFrozenColumns(1);
    sheet.setHiddenGridlines(false);
    sheet.setColumnWidths(0, width, 140);
    sheet.setColumnWidth(5, 280);
    sheet.setColumnWidth(6, 320);
    sheet.setColumnWidth(10, 360);
    sheet.setColumnWidth(11, 360);
    sheet.setColumnWidth(12, 260);
  }

  function renderWeeklySheet(sheet, inserted, updated) {
    const rows = payload.displayRows;
    const headers = payload.weekHeaders;
    sheet.setHiddenGridlines(true);
    sheet.setFrozenRows(15);
    sheet.setFrozenColumns(2);

    sheet.getRange(0, 0, 13, headers.length).clearContent();
    sheet.getRange(0, 0).setValue(payload.sheetNames.week + ' Follow Builders');
    sheet
      .getRange(0, 0, 1, headers.length)
      .setFontWeight('bold')
      .setFontSize(18)
      .setFontColor('#0F172A')
      .setBackgroundColor('#EAF2F8');

    sheet.getRange(1, 0, 7, 2).setValues([
      ['Generated at', payload.runRecord.finishedAt],
      ['Items in update', rows.length],
      ['Inserted raw rows', inserted],
      ['Updated raw rows', updated],
      ['Public URL', payload.runRecord.publicUrl],
      ['Run ID', payload.runRecord.runId],
      ['Source order', 'X, Podcast, Blog']
    ]);
    sheet
      .getRange(1, 0, 7, 2)
      .setBackgroundColor('#F8FAFC')
      .setVerticalAlignment('middle');
    sheet.getRange(1, 0, 7, 1).setFontWeight('bold').setFontColor('#334155');

    sheet.getRange(DISPLAY_HEADER_ROW, 0, 1, headers.length).setValues([headers]);
    sheet
      .getRange(DISPLAY_HEADER_ROW, 0, 1, headers.length)
      .setFontWeight('bold')
      .setFontColor('#FFFFFF')
      .setBackgroundColor('#1F4E79')
      .setVerticalAlignment('middle');

    const clearRows = Math.max(sheet.getLastRow() - DISPLAY_DATA_ROW + 1, rows.length, 1);
    sheet.getRange(DISPLAY_DATA_ROW, 0, clearRows, headers.length).clearContent();
    if (rows.length > 0) {
      sheet.getRange(DISPLAY_DATA_ROW, 0, rows.length, headers.length).setValues(rows);
      sheet
        .getRange(DISPLAY_DATA_ROW, 0, rows.length, headers.length)
        .setVerticalAlignment('top')
        .setHorizontalAlignment('left');
      sheet.setRowHeights(DISPLAY_DATA_ROW, rows.length, 76);
    }

    const widths = [110, 90, 160, 280, 360, 320, 180, 80, 300, 180];
    widths.forEach((width, index) => sheet.setColumnWidth(index, width));
    sheet.setRowHeight(0, 34);
    sheet.setRowHeight(DISPLAY_HEADER_ROW, 30);
  }

  try {
    const workbook = univerAPI.getActiveWorkbook();
    const rawSheet = ensureSheet(workbook, payload.sheetNames.rawData, 2000, payload.rawHeaders.length);
    const runsSheet = ensureSheet(workbook, payload.sheetNames.runs, 500, payload.runsHeaders.length);
    const weekSheet = ensureSheet(workbook, payload.sheetNames.week, Math.max(120, payload.displayRows.length + 30), payload.weekHeaders.length);

    assertOrInitHeader(rawSheet, payload.rawHeaders, payload.sheetNames.rawData);
    assertOrInitHeader(runsSheet, payload.runsHeaders, payload.sheetNames.runs);
    applyDataSheetFormatting(rawSheet, payload.rawHeaders.length);
    applyDataSheetFormatting(runsSheet, payload.runsHeaders.length);

    const result = upsertRawRows(rawSheet, payload.rawRows);
    appendRunRow(runsSheet, result.inserted, result.updated);
    renderWeeklySheet(weekSheet, result.inserted, result.updated);

    return {
      success: true,
      inserted: result.inserted,
      updated: result.updated,
      weeklyRows: payload.displayRows.length,
      weekSheetName: payload.sheetNames.week
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}`;
}

async function readItemsPayload(path) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf-8'));
  } catch (err) {
    throw new Error(`Could not read items JSON: ${err.message}`);
  }
  const payload = validateItemsPayload(parsed);
  return {
    ...payload,
    items: dedupeItemsByContentId(payload.items)
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
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
  if (!workbookPath) {
    throw new Error('Univer workbook is not initialized. Run scripts/init-univer-workbook.js first.');
  }
  if (!(await exists(workbookPath))) {
    throw new Error(`Configured Univer workbook does not exist: ${workbookPath}`);
  }

  const payload = await readItemsPayload(args.itemsJsonPath);
  const generatedAt = payload.generatedAt || startedAt;
  const weekSheetName = isoWeekName(generatedAt);
  const finishedAt = new Date().toISOString();
  const rawRows = payload.items.map(item => mapItemToRawRow(item, finishedAt));
  const displayRows = groupWeeklyDisplayRows(payload.items);
  const runRecord = buildRunRecord({
    payload,
    itemsJsonPath: args.itemsJsonPath,
    markdownPath: args.markdownPath,
    config,
    startedAt,
    finishedAt,
    itemsSeen: payload.items.length
  });

  let tempDir;
  try {
    tempDir = await mkdtemp(join(tmpdir(), 'follow-builders-univer-update-'));
    const runFile = join(tempDir, 'update-workbook.js');
    await writeFile(runFile, buildWorkbookRunScript({ rawRows, displayRows, runRecord, weekSheetName }), 'utf-8');

    await runUniver(['inspect', 'workbook', workbookPath], { univerPath: args.univerPath });
    const runOutput = await runUniver(['run', workbookPath, '--file', runFile], { univerPath: args.univerPath });
    const runResult = parseJsonOutput(runOutput.stdout, 'univer run');
    if (runResult.success !== true) {
      throw new Error(`univer run failed: ${runResult.error || JSON.stringify(runResult)}`);
    }
    await runUniver(['inspect', 'range', workbookPath, '--range', 'raw-data!A1:T5'], { univerPath: args.univerPath });
    const syncResult = await runUniverJson(['sync', workbookPath], { univerPath: args.univerPath });
    const publicUrl = config.univer?.publicUrl || publicUrlForUnit(config.univer?.unitId) || '';

    console.log(JSON.stringify({
      status: 'ok',
      workbookPath,
      weekSheetName,
      publicUrl,
      runResult,
      syncResult
    }, null, 2));
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
