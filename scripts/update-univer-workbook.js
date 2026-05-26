#!/usr/bin/env node

import { access, cp, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
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
  mapItemToRawRow,
  publicUrlForUnit,
  validateItemsPayload
} from './lib/univer-workbook-contract.js';
import { runUniver, runUniverJson } from './lib/univer-command.js';

function readOptionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('-')) {
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

export function isoWeekDateRange(value = new Date()) {
  const input = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(input.getTime())) {
    throw new Error(`Invalid date for ISO week: ${value}`);
  }
  const start = new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()));
  const day = start.getUTCDay() || 7;
  start.setUTCDate(start.getUTCDate() + 1 - day);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10)
  };
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

function buildCommitMessage(weekSheetName, runRecord) {
  return `follow-builders ${weekSheetName} ${runRecord.runId}`;
}

function getUncommittedMutationCount(syncResult) {
  const value = syncResult?.uncommittedMutationCount ?? syncResult?.status?.uncommittedMutationCount;
  if (value === undefined || value === null || value === '') return 0;
  const count = Number(value);
  if (!Number.isFinite(count)) {
    throw new Error(`univer sync returned invalid uncommittedMutationCount: ${value}`);
  }
  return count;
}

function assertNoUncommittedMutations(syncResult) {
  const count = getUncommittedMutationCount(syncResult);
  if (count !== 0) {
    throw new Error(`univer sync reported ${count} uncommitted mutations after commit`);
  }
}

function assertSyncSucceeded(syncResult) {
  if (syncResult?.success === false) {
    throw new Error(`univer sync failed: ${syncResult.error || JSON.stringify(syncResult)}`);
  }
}

async function backupWorkbook(workbookPath, tempDir) {
  const backupPath = join(tempDir, 'workbook-backup.univer');
  await rm(backupPath, { recursive: true, force: true });
  await cp(workbookPath, backupPath, { recursive: true });
  return backupPath;
}

async function restoreWorkbook(backupPath, workbookPath) {
  await rm(workbookPath, { recursive: true, force: true });
  await cp(backupPath, workbookPath, { recursive: true });
}

function normalizeRows(rows, width) {
  return rows.map(row => {
    const next = row.slice(0, width);
    while (next.length < width) next.push('');
    return next;
  });
}

export function buildWorkbookRunScript({ rawRows, displayRows = [], runRecord, weekSheetName, weekStartDate = '', weekEndDate = '' }) {
  const payload = {
    rawHeaders: RAW_DATA_HEADERS,
    runsHeaders: RUNS_HEADERS,
    weekHeaders: WEEK_DISPLAY_HEADERS,
    rawRows: normalizeRows(rawRows, RAW_DATA_HEADERS.length),
    displayRows: normalizeRows(displayRows, WEEK_DISPLAY_HEADERS.length),
    runRecord,
    weekStartDate,
    weekEndDate,
    sheetNames: {
      rawData: SHEETS.rawData,
      runs: SHEETS.runs,
      week: weekSheetName
    }
  };

  return `async () => {
  const payload = ${JSON.stringify(payload)};
  const DISPLAY_HEADER_ROW = 10;
  const DISPLAY_DATA_ROW = DISPLAY_HEADER_ROW + 1;
  const DASHBOARD_CLEAR_ROWS = 18;
  const TABLE_CLEAR_EXTRA_ROWS = 180;
  const HELPER_COLUMN = 11;
  const HELPER_WIDTH = 4;
  const LOW_SCORE_THRESHOLD = 50;
  const COLORS = {
    title: '#0F1F33',
    titleSoft: '#102033',
    x: '#2563EB',
    podcast: '#7C3AED',
    blog: '#F59E0B',
    median: '#0F766E',
    lowScore: '#DC2626',
    green: '#16A34A',
    greenSoft: '#DCFCE7',
    yellowSoft: '#FEF3C7',
    redSoft: '#FEE2E2',
    sheet: '#F8FAFC',
    metadata: '#EAF2F8',
    card: '#FFFFFF',
    border: '#D8E0EA',
    controlBorder: '#CBD5E1',
    text: '#172033',
    panelText: '#334155',
    muted: '#475569',
    tableHeader: '#1F4E79',
    tableAlt: '#F8FBFF',
    heatLow: '#DBEAFE',
    heatMedium: '#60A5FA',
    heatHigh: '#1D4ED8',
    heatAccent: '#F59E0B'
  };

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

  function weeklySheetRows(rowCount) {
    return Math.max(140, DISPLAY_DATA_ROW + TABLE_CLEAR_EXTRA_ROWS + rowCount + 30);
  }

  function weeklySheetColumns() {
    return HELPER_COLUMN + HELPER_WIDTH;
  }

  function sheetRowCapacity(sheet) {
    if (typeof sheet.getMaxRows !== 'function') return null;
    const value = Number(sheet.getMaxRows());
    return Number.isFinite(value) ? value : null;
  }

  function assertSheetRowsCanFit(sheet, requiredRows, sheetName = payload.sheetNames.week, purpose = 'Analyst Console weekly rendering') {
    const currentRows = sheetRowCapacity(sheet);
    if (currentRows === null || currentRows >= requiredRows) return;
    if (typeof sheet.setRowCount === 'function') return;
    if (typeof sheet.insertRowsAfter === 'function') return;
    throw new Error(
      sheetName + ' requires at least ' + requiredRows +
      ' rows for ' + purpose + '; current sheet has ' +
      currentRows + ' rows and cannot be expanded'
    );
  }

  function ensureSheetRows(sheet, requiredRows, sheetName = payload.sheetNames.week, purpose = 'Analyst Console weekly rendering') {
    const currentRows = sheetRowCapacity(sheet);
    if (currentRows === null || currentRows >= requiredRows) return;
    if (typeof sheet.setRowCount === 'function') {
      sheet.setRowCount(requiredRows);
      return;
    }
    if (typeof sheet.insertRowsAfter === 'function') {
      sheet.insertRowsAfter(currentRows - 1, requiredRows - currentRows);
      return;
    }
    throw new Error(
      sheetName + ' requires at least ' + requiredRows +
      ' rows for ' + purpose + '; current sheet has ' +
      currentRows + ' rows and cannot be expanded'
    );
  }

  function sheetColumnCapacity(sheet) {
    if (Number.isFinite(Number(sheet.columnCapacity))) return Number(sheet.columnCapacity);
    if (typeof sheet.getMaxColumns !== 'function') return null;
    const value = Number(sheet.getMaxColumns());
    return Number.isFinite(value) ? value : null;
  }

  function assertSheetColumnsCanFit(sheet, requiredColumns, sheetName = payload.sheetNames.week, purpose = 'Analyst Console helper ranges') {
    const currentColumns = sheetColumnCapacity(sheet);
    if (currentColumns === null || currentColumns >= requiredColumns) return;
    if (typeof sheet.setColumnCount === 'function') return;
    if (typeof sheet.insertColumnsAfter === 'function') return;
    throw new Error(
      sheetName + ' requires at least ' + requiredColumns +
      ' columns for ' + purpose + '; current sheet has ' +
      currentColumns + ' columns and cannot be expanded'
    );
  }

  function ensureSheetColumns(sheet, requiredColumns, sheetName = payload.sheetNames.week, purpose = 'Analyst Console helper ranges') {
    const currentColumns = sheetColumnCapacity(sheet);
    if (currentColumns === null) return;
    if (currentColumns >= requiredColumns) return;
    if (typeof sheet.setColumnCount === 'function') {
      sheet.setColumnCount(requiredColumns);
      return;
    }
    if (typeof sheet.insertColumnsAfter === 'function') {
      sheet.insertColumnsAfter(currentColumns - 1, requiredColumns - currentColumns);
      return;
    }
    throw new Error(
      sheetName + ' requires at least ' + requiredColumns +
      ' columns for ' + purpose + '; current sheet has ' +
      currentColumns + ' columns and cannot be expanded'
    );
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

  function lastNonEmptyRowInColumn(sheet, column, startRow) {
    const currentColumns = sheetColumnCapacity(sheet);
    if (currentColumns !== null && currentColumns <= column) return startRow - 1;
    const lastRow = sheet.getLastRow();
    if (lastRow < startRow) return startRow - 1;
    const values = sheet.getRange(startRow, column, lastRow - startRow + 1, 1).getValues();
    let lastNonEmpty = startRow - 1;
    values.forEach((row, offset) => {
      if (stringValue(row[0])) lastNonEmpty = startRow + offset;
    });
    return lastNonEmpty;
  }

  function nextAppendRow(sheet, keyColumn) {
    return Math.max(lastNonEmptyRowInColumn(sheet, keyColumn, 1) + 1, 1);
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

  function planRawUpserts(sheet, rows) {
    const rowIndex = sheet ? existingRawRowIndex(sheet) : new Map();
    const operations = [];
    let nextInsertRow = sheet ? nextAppendRow(sheet, 0) : 1;
    let inserted = 0;
    let updated = 0;
    let requiredRows = 1;
    rows.forEach(row => {
      const contentId = stringValue(row[0]);
      if (!contentId) throw new Error('raw row contentId is required');
      if (rowIndex.has(contentId)) {
        const targetRow = rowIndex.get(contentId);
        operations.push({ targetRow, row });
        requiredRows = Math.max(requiredRows, targetRow + 1);
        updated += 1;
      } else {
        const targetRow = nextInsertRow;
        operations.push({ targetRow, row });
        rowIndex.set(contentId, targetRow);
        requiredRows = Math.max(requiredRows, targetRow + 1);
        nextInsertRow += 1;
        inserted += 1;
      }
    });
    return { inserted, updated, operations, requiredRows };
  }

  function upsertRawRows(sheet, rows, plan = planRawUpserts(sheet, rows)) {
    plan.operations.forEach(operation => {
      sheet.getRange(operation.targetRow, 0, 1, payload.rawHeaders.length).setValues([operation.row]);
    });
    return { inserted: plan.inserted, updated: plan.updated };
  }

  function appendRunRow(sheet, inserted, updated, targetRow = nextAppendRow(sheet, 0)) {
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
    sheet.getRange(targetRow, 0, 1, payload.runsHeaders.length).setValues([row]);
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

  function buildWeeklyRowsFromRaw(sheet) {
    if (!payload.weekStartDate || !payload.weekEndDate) return payload.displayRows;
    const lastRow = lastNonEmptyRowInColumn(sheet, 0, 1);
    if (lastRow < 1) return [];
    const sourceOrder = { x: 0, podcast: 1, blog: 2 };
    const values = sheet.getRange(1, 0, lastRow, payload.rawHeaders.length).getValues();
    return values
      .map((row, index) => ({ row, rawRowNumber: index + 2 }))
      .filter(row => {
        const contentId = stringValue(row.row[0]);
        const runDate = stringValue(row.row[9]);
        return contentId && runDate >= payload.weekStartDate && runDate <= payload.weekEndDate;
      })
      .sort((a, b) => {
        const dateCompare = stringValue(b.row[9]).localeCompare(stringValue(a.row[9]));
        if (dateCompare !== 0) return dateCompare;
        const sourceCompare = (sourceOrder[stringValue(a.row[1])] ?? 99) - (sourceOrder[stringValue(b.row[1])] ?? 99);
        if (sourceCompare !== 0) return sourceCompare;
        const publishedCompare = stringValue(b.row[7]).localeCompare(stringValue(a.row[7]));
        if (publishedCompare !== 0) return publishedCompare;
        return Number(b.row[14] || 0) - Number(a.row[14] || 0);
      })
      .map(({ row, rawRowNumber }) => ({
        rawRowNumber,
        sourceType: stringValue(row[1]),
        score: stringValue(row[14]) === '' || !Number.isFinite(Number(row[14])) ? '' : Number(row[14])
      }));
  }

  function projectedWeeklyRowCount(rawSheet) {
    if (!payload.weekStartDate || !payload.weekEndDate) return payload.displayRows.length;
    const rowsByContentId = new Map();
    if (rawSheet) {
      const lastRow = lastNonEmptyRowInColumn(rawSheet, 0, 1);
      if (lastRow >= 1) {
        const currentColumns = sheetColumnCapacity(rawSheet);
        const readableColumns = currentColumns === null ? payload.rawHeaders.length : Math.min(payload.rawHeaders.length, Math.max(1, currentColumns));
        const values = rawSheet.getRange(1, 0, lastRow, readableColumns).getValues();
        values.forEach(row => {
          const contentId = stringValue(row[0]);
          if (contentId) rowsByContentId.set(contentId, row);
        });
      }
    }
    payload.rawRows.forEach(row => {
      const contentId = stringValue(row[0]);
      if (contentId) rowsByContentId.set(contentId, row);
    });
    let count = 0;
    rowsByContentId.forEach(row => {
      const runDate = stringValue(row[9]);
      if (runDate >= payload.weekStartDate && runDate <= payload.weekEndDate) count += 1;
    });
    return count;
  }

  function rawFormula(column, rowNumber) {
    return "='raw-data'!" + column + rowNumber;
  }

  function scoreFormula(rowNumber) {
    const cell = "'raw-data'!O" + rowNumber;
    return '=IF(' + cell + '="","",' + cell + ')';
  }

  function sourceTypeFormula(rowNumber) {
    const cell = "'raw-data'!B" + rowNumber;
    return '=IF(' + cell + '="x","X",IF(' + cell + '="podcast","Podcast",IF(' + cell + '="blog","Blog",' + cell + ')))';
  }

  function sourceFormula(rowNumber) {
    return '=IF(\\'raw-data\\'!C' + rowNumber + '<>"",\\'raw-data\\'!C' + rowNumber + ',\\'raw-data\\'!D' + rowNumber + ')';
  }

  function weeklyDisplayRow(row) {
    if (Array.isArray(row)) return row;
    const rawRow = row.rawRowNumber;
    return [
      rawFormula('J', rawRow),
      sourceTypeFormula(rawRow),
      sourceFormula(rawRow),
      rawFormula('F', rawRow),
      rawFormula('L', rawRow),
      rawFormula('M', rawRow),
      rawFormula('N', rawRow),
      scoreFormula(rawRow),
      rawFormula('G', rawRow),
      rawFormula('A', rawRow)
    ];
  }

  function dashboardFormula(sourceType) {
    if (!payload.weekStartDate || !payload.weekEndDate) return '';
    const base = "'raw-data'!J:J,\\\">=" + payload.weekStartDate + "\\",'raw-data'!J:J,\\\"<=" + payload.weekEndDate + "\\\"";
    if (!sourceType) return '=COUNTIFS(' + base + ')';
    return '=COUNTIFS(' + base + ",'raw-data'!B:B,\\\"" + sourceType + "\\\")";
  }

  function weekDateCriteria() {
    if (!payload.weekStartDate || !payload.weekEndDate) return '';
    return "'raw-data'!J:J,\\\">=" + payload.weekStartDate + "\\\",'raw-data'!J:J,\\\"<=" + payload.weekEndDate + "\\\"";
  }

  function medianScoreFormula() {
    if (!payload.weekStartDate || !payload.weekEndDate) return '';
    return '=IF(COUNT(H12:H2000)>0,MEDIAN(H12:H2000),"-")';
  }

  function lowScoreFormula() {
    const criteria = weekDateCriteria();
    if (!criteria) return '';
    return '=COUNTIFS(' + criteria + ",\\'raw-data\\'!O:O,\\\"<" + LOW_SCORE_THRESHOLD + "\\\")";
  }

  function scoreBandFormula(label) {
    const criteria = weekDateCriteria();
    if (!criteria) return '';
    if (label === '80+') return '=COUNTIFS(' + criteria + ",\\'raw-data\\'!O:O,\\\">=80\\\")";
    if (label === '50-79') return '=COUNTIFS(' + criteria + ",\\'raw-data\\'!O:O,\\\">=50\\\",\\'raw-data\\'!O:O,\\\"<80\\\")";
    return '=COUNTIFS(' + criteria + ",\\'raw-data\\'!O:O,\\\"<50\\\")";
  }

  function dateAddFormula(offset) {
    if (!payload.weekStartDate) return '';
    return '=TEXT(DATEVALUE("' + payload.weekStartDate + '")+' + offset + ',"yyyy-mm-dd")';
  }

  function dailyVolumeFormula(offset) {
    if (!payload.weekStartDate) return '';
    const dateFormula = 'TEXT(DATEVALUE("' + payload.weekStartDate + '")+' + offset + ',"yyyy-mm-dd")';
    return '=COUNTIFS(\\'raw-data\\'!J:J,' + dateFormula + ')';
  }

  function normalizeTopic(value) {
    return stringValue(value).trim().toLowerCase();
  }

  function splitTopics(value) {
    return stringValue(value)
      .split(',')
      .map(topic => topic.trim())
      .filter(Boolean);
  }

  function topTopicsFromRaw(rawSheet, limit) {
    const lastRow = lastNonEmptyRowInColumn(rawSheet, 0, 1);
    if (lastRow < 1) return [];
    const values = rawSheet.getRange(1, 0, lastRow, payload.rawHeaders.length).getValues();
    const counts = new Map();
    values.forEach(row => {
      const runDate = stringValue(row[9]);
      if (payload.weekStartDate && runDate < payload.weekStartDate) return;
      if (payload.weekEndDate && runDate > payload.weekEndDate) return;
      splitTopics(row[13]).forEach(topic => {
        const key = normalizeTopic(topic);
        if (!key) return;
        const current = counts.get(key) || { label: topic, count: 0 };
        current.count += 1;
        counts.set(key, current);
      });
    });
    return [...counts.values()]
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
      .slice(0, limit)
      .map(entry => entry.label);
  }

  function topicSourceCountsFromRaw(rawSheet, topics) {
    const counts = new Map();
    topics.forEach(topic => counts.set(normalizeTopic(topic), { x: 0, podcast: 0, blog: 0 }));
    const lastRow = lastNonEmptyRowInColumn(rawSheet, 0, 1);
    if (lastRow < 1) return counts;
    const values = rawSheet.getRange(1, 0, lastRow, payload.rawHeaders.length).getValues();
    values.forEach(row => {
      const runDate = stringValue(row[9]);
      if (payload.weekStartDate && runDate < payload.weekStartDate) return;
      if (payload.weekEndDate && runDate > payload.weekEndDate) return;
      const source = sourceTypeFromDisplayType(row[1]);
      if (!['x', 'podcast', 'blog'].includes(source)) return;
      splitTopics(row[13]).forEach(topic => {
        const entry = counts.get(normalizeTopic(topic));
        if (entry) entry[source] += 1;
      });
    });
    return counts;
  }

  function topicCountFormula(topic, sourceType) {
    if (!topic || topic === '-' || !payload.weekStartDate || !payload.weekEndDate) return '';
    const escaped = String(topic)
      .replace(/~/g, '~~')
      .replace(/\\*/g, '~*')
      .replace(/\\?/g, '~?')
      .replace(/"/g, '""');
    const base = weekDateCriteria() + ",\\'raw-data\\'!N:N,\\\"*" + escaped + "*\\\"";
    if (!sourceType) return '=COUNTIFS(' + base + ')';
    return '=COUNTIFS(' + base + ",\\'raw-data\\'!B:B,\\\"" + sourceType + "\\\")";
  }

  function sourceTypeFromDisplayType(value) {
    const normalized = stringValue(value).toLowerCase();
    if (normalized === 'x') return 'x';
    if (normalized === 'podcast') return 'podcast';
    if (normalized === 'blog') return 'blog';
    return normalized;
  }

  function shortDate(dateText) {
    const parts = stringValue(dateText).split('-');
    if (parts.length !== 3) return stringValue(dateText);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = months[Number(parts[1]) - 1] || parts[1];
    return month + ' ' + Number(parts[2]);
  }

  function humanDateRange() {
    if (!payload.weekStartDate || !payload.weekEndDate) return payload.sheetNames.week;
    return shortDate(payload.weekStartDate) + ' - ' + shortDate(payload.weekEndDate);
  }

  function countBySource(rows) {
    const counts = { x: 0, podcast: 0, blog: 0 };
    rows.forEach(row => {
      const source = sourceTypeFromDisplayType(row[1]);
      if (Object.prototype.hasOwnProperty.call(counts, source)) counts[source] += 1;
    });
    return counts;
  }

  function scoreFill(score) {
    if (score === '' || score === null || score === undefined) return COLORS.card;
    const value = Number(score);
    if (!Number.isFinite(value)) return COLORS.card;
    if (value >= 80) return COLORS.greenSoft;
    if (value >= 50) return COLORS.yellowSoft;
    return COLORS.redSoft;
  }

  function sourceAccent(displayType) {
    const source = sourceTypeFromDisplayType(displayType);
    if (source === 'x') return COLORS.x;
    if (source === 'podcast') return COLORS.podcast;
    if (source === 'blog') return COLORS.blog;
    return COLORS.muted;
  }

  function setOutsideBorder(range) {
    if (typeof range.setBorder !== 'function') return range;
    return range.setBorder(univerAPI.Enum.BorderType.OUTSIDE, univerAPI.Enum.BorderStyleTypes.THIN, COLORS.border);
  }

  function clearWeeklyFormatting(sheet) {
    if (typeof sheet.clearConditionalFormatRules === 'function') sheet.clearConditionalFormatRules();
  }

  function clearWeeklyMerges(sheet, rowCount) {
    const range = sheet.getRange(0, 0, rowCount, weeklySheetColumns());
    if (typeof range.breakApart === 'function') {
      range.breakApart();
      return;
    }
    if (typeof range.unmerge === 'function') {
      range.unmerge();
      return;
    }
    if (typeof range.unMerge === 'function') {
      range.unMerge();
    }
  }

  function clearWeeklyDirectFormatting(sheet, rowCount) {
    const range = sheet.getRange(0, 0, rowCount, weeklySheetColumns());
    if (typeof range.clearFormat === 'function') range.clearFormat();
  }

  function applyScoreConditionalFormatting(sheet, rowCount) {
    if (typeof sheet.newConditionalFormattingRule !== 'function' || typeof sheet.addConditionalFormattingRule !== 'function') return;
    const scoreRange = sheet.getRange(DISPLAY_DATA_ROW, 7, Math.max(rowCount, 1), 1);
    const highRule = sheet
      .newConditionalFormattingRule()
      .whenNumberGreaterThanOrEqualTo(80)
      .setBackground(COLORS.greenSoft)
      .setFontColor('#166534')
      .setBold(true)
      .setRanges([scoreRange.getRange()])
      .build();
    sheet.addConditionalFormattingRule(highRule);
    const lowRule = sheet
      .newConditionalFormattingRule()
      .whenNumberLessThan(LOW_SCORE_THRESHOLD)
      .setBackground(COLORS.redSoft)
      .setFontColor('#991B1B')
      .setBold(true)
      .setRanges([scoreRange.getRange()])
      .build();
    sheet.addConditionalFormattingRule(lowRule);
  }

  function applyAnalyticsConditionalFormatting(sheet) {
    return sheet;
  }

  async function resetCharts(sheet) {
    try {
      if (typeof sheet.getCharts !== 'function' && typeof sheet.removeChart !== 'function') return;
      if (typeof sheet.getCharts !== 'function' || typeof sheet.removeChart !== 'function') {
        throw new Error('incomplete chart cleanup API');
      }
      const charts = await sheet.getCharts();
      for (const chart of charts) {
        await sheet.removeChart(chart);
      }
    } catch (err) {
      throw new Error('Could not remove stale charts from ' + payload.sheetNames.week + ': ' + err.message);
    }
  }

  async function insertDailyVolumeChart(sheet) {
    // Charts rendered as overlay artifacts in Univer; the sheet-native bars are the stable primary view.
    return false;
  }

  function renderDailyVolumeFallback(sheet) {
    sheet.getRange('H7:J10').setValues([
      ['Mon', 'Tue', 'Wed'],
      ['=M8', '=M9', '=M10'],
      ['=M11', '=M12', '=SUM(M13:M14)'],
      ['Thu', 'Fri', 'Sat/Sun']
    ]);
    sheet.getRange('H7:J10').setFontSize(10).setVerticalAlignment('middle');
    sheet.getRange('H7:J7').setFontWeight('bold').setFontColor(COLORS.panelText).setHorizontalAlignment('center');
    sheet.getRange('H10:J10').setFontWeight('bold').setFontColor(COLORS.panelText).setHorizontalAlignment('center');
    sheet.getRange('H8:J9')
      .setBackgroundColor(COLORS.x)
      .setFontColor(COLORS.x)
      .setHorizontalAlignment('center')
      .setVerticalAlignment('middle');
  }

  function a1ToCell(a1) {
    const match = /^([A-Z]+)(\\d+)$/.exec(a1);
    if (!match) throw new Error('Unsupported A1 cell: ' + a1);
    const column = match[1].split('').reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) - 1;
    return { row: Number(match[2]) - 1, column };
  }

  function setA1Value(sheet, a1, value) {
    const parsed = a1ToCell(a1);
    sheet.getRange(parsed.row, parsed.column).setValue(value);
  }

  async function renderWeeklySheet(sheet, inserted, updated, rows, rawSheet) {
    const headers = payload.weekHeaders;
    const displayRows = rows.map(weeklyDisplayRow);
    const topics = topTopicsFromRaw(rawSheet, 3);
    while (topics.length < 3) topics.push('-');
    const topicCounts = topicSourceCountsFromRaw(rawSheet, topics);
    ensureSheetColumns(sheet, weeklySheetColumns());

    sheet.setHiddenGridlines(true);
    sheet.setFrozenRows(0);
    sheet.setFrozenColumns(0);
    clearWeeklyFormatting(sheet);
    await resetCharts(sheet);

    const staleClearRows = Math.max(sheet.getLastRow() - DISPLAY_DATA_ROW + 1, rows.length + TABLE_CLEAR_EXTRA_ROWS, 1);
    const maxRows = sheetRowCapacity(sheet);
    const clearRows = maxRows === null ? staleClearRows : Math.min(staleClearRows, Math.max(0, maxRows - DISPLAY_DATA_ROW));
    const mergeClearRows = Math.max(DASHBOARD_CLEAR_ROWS, DISPLAY_DATA_ROW + clearRows);
    const surfaceClearRows = maxRows === null ? mergeClearRows : Math.min(mergeClearRows, maxRows);
    clearWeeklyMerges(sheet, surfaceClearRows);
    clearWeeklyDirectFormatting(sheet, surfaceClearRows);
    sheet.getRange(0, 0, DASHBOARD_CLEAR_ROWS, headers.length).clear();
    sheet.getRange(0, HELPER_COLUMN, DASHBOARD_CLEAR_ROWS + 24, HELPER_WIDTH).clear();
    if (clearRows > 0) sheet.getRange(DISPLAY_DATA_ROW, 0, clearRows, headers.length).clearContent();

    sheet.getRange('A1:J1').merge({ isForceMerge: true });
    sheet.getRange('A1').setValue(payload.sheetNames.week + ' Follow Builders');
    sheet.getRange('A1:J1')
      .setBackgroundColor(COLORS.title)
      .setFontColor('#FFFFFF')
      .setFontWeight('bold')
      .setFontSize(22)
      .setVerticalAlignment('middle')
      .setHorizontalAlignment('left');

    sheet.getRange('A2:J2').merge({ isForceMerge: true });
    sheet.getRange('A2').setValue(humanDateRange() + ' - Generated ' + payload.runRecord.finishedAt + ' - ' + (payload.runRecord.publicUrl || 'Local workbook'));
    sheet.getRange('A2:J2')
      .setBackgroundColor(COLORS.metadata)
      .setFontColor(COLORS.panelText)
      .setVerticalAlignment('middle');

    sheet.getRange('A3:J3').setBackgroundColor(COLORS.sheet);
    sheet.getRange('A3:J3').setValues([['Source', 'All', 'Score', '0-100', 'Topic', 'All', 'Date\\nWeek', 'Sort', 'Signal', 'View\\nDigest']]);
    ['A3:B3', 'C3:D3', 'E3:F3', 'G3', 'H3:I3', 'J3'].forEach(a1 => {
      sheet.getRange(a1)
        .setBackgroundColor(COLORS.card)
        .setFontColor(COLORS.muted)
        .setFontSize(9)
        .setWrap(true)
        .setHorizontalAlignment('center')
        .setVerticalAlignment('middle');
      setOutsideBorder(sheet.getRange(a1));
    });
    sheet.getRange('B3').setFontWeight('bold').setFontColor(COLORS.text);
    sheet.getRange('D3').setFontWeight('bold').setFontColor(COLORS.text);
    sheet.getRange('F3').setFontWeight('bold').setFontColor(COLORS.text);
    sheet.getRange('G3').setFontWeight('bold').setFontColor(COLORS.text);
    sheet.getRange('I3').setFontWeight('bold').setFontColor(COLORS.text);
    sheet.getRange('J3').setFontWeight('bold').setFontColor(COLORS.text);

    const sourceCounts = countBySource(rows);
    const kpiBlocks = [
      { label: 'Items', value: dashboardFormula() || rows.length, cardRange: 'A4:B5', labelRange: 'A4:B4', valueRange: 'A5:B5', labelCell: 'A4', valueCell: 'A5', color: COLORS.titleSoft },
      { label: 'X', value: dashboardFormula('x') || sourceCounts.x, cardRange: 'C4:D5', labelRange: 'C4:D4', valueRange: 'C5:D5', labelCell: 'C4', valueCell: 'C5', color: COLORS.x },
      { label: 'Podcast', value: dashboardFormula('podcast') || sourceCounts.podcast, cardRange: 'E4:F5', labelRange: 'E4:F4', valueRange: 'E5:F5', labelCell: 'E4', valueCell: 'E5', color: COLORS.podcast },
      { label: 'Blog', value: dashboardFormula('blog') || sourceCounts.blog, cardRange: 'G4:H5', labelRange: 'G4:H4', valueRange: 'G5:H5', labelCell: 'G4', valueCell: 'G5', color: COLORS.blog },
      { label: 'Median', value: medianScoreFormula() || '-', cardRange: 'I4:I5', labelRange: 'I4:I4', valueRange: 'I5:I5', labelCell: 'I4', valueCell: 'I5', color: COLORS.median },
      { label: 'Low Score', value: lowScoreFormula() || 0, cardRange: 'J4:J5', labelRange: 'J4:J4', valueRange: 'J5:J5', labelCell: 'J4', valueCell: 'J5', color: COLORS.lowScore }
    ];
    kpiBlocks.forEach(block => {
      if (block.labelRange.includes(':')) sheet.getRange(block.labelRange).merge({ isForceMerge: true });
      if (block.valueRange.includes(':')) sheet.getRange(block.valueRange).merge({ isForceMerge: true });
      setA1Value(sheet, block.labelCell, block.label.toUpperCase());
      setA1Value(sheet, block.valueCell, block.value);
      sheet.getRange(block.cardRange)
        .setBackgroundColor(block.color)
        .setFontColor('#FFFFFF')
        .setFontWeight('bold')
        .setHorizontalAlignment('center')
        .setVerticalAlignment('middle');
      sheet.getRange(block.labelRange).setFontSize(9);
      sheet.getRange(block.valueRange).setFontSize(18).setFontWeight('bold');
      if (typeof sheet.getRange(block.cardRange).setBorder === 'function') {
        sheet.getRange(block.cardRange).setBorder(univerAPI.Enum.BorderType.OUTSIDE, univerAPI.Enum.BorderStyleTypes.THIN, COLORS.sheet);
      }
    });

    sheet.getRange('A6:D10').setBackgroundColor(COLORS.card);
    sheet.getRange('E6:G10').setBackgroundColor(COLORS.card);
    sheet.getRange('H6:J10').setBackgroundColor(COLORS.card);
    ['A6:D10', 'E6:G10', 'H6:J10'].forEach(a1 => setOutsideBorder(sheet.getRange(a1)));
    sheet.getRange('A6').setValue('TOPIC HEAT');
    sheet.getRange('E6').setValue('SCORE DISTRIBUTION');
    sheet.getRange('H6').setValue('DAILY VOLUME');
    sheet.getRange('A6:J6').setFontWeight('bold').setFontColor(COLORS.panelText).setFontSize(10);

    sheet.getRange('A7:D9').setValues([
      [topics[0], '=M17', '=N17', '=O17'],
      [topics[1], '=M18', '=N18', '=O18'],
      [topics[2], '=M19', '=N19', '=O19']
    ]);
    sheet.getRange('B10:D10').setValues([['X', 'Podcast', 'Blog']]);
    sheet.getRange('A7:D10').setFontSize(10).setVerticalAlignment('middle');
    sheet.getRange('A7:A9').setFontColor(COLORS.panelText).setFontWeight('bold');
    sheet.getRange('B10:D10').setFontColor(COLORS.muted).setFontWeight('bold').setHorizontalAlignment('center');
    const heatColumns = ['x', 'podcast', 'blog'];
    topics.forEach((topic, rowIndex) => {
      const entry = topicCounts.get(normalizeTopic(topic)) || { x: 0, podcast: 0, blog: 0 };
      const maxCount = Math.max(entry.x, entry.podcast, entry.blog);
      heatColumns.forEach((source, columnIndex) => {
        const count = entry[source] || 0;
        const fill = count === 0 ? COLORS.heatLow : (count === maxCount ? COLORS.heatHigh : COLORS.heatMedium);
        sheet.getRange(6 + rowIndex, 1 + columnIndex)
          .setBackgroundColor(fill)
          .setFontColor(fill)
          .setHorizontalAlignment('center')
          .setVerticalAlignment('middle');
      });
    });

    sheet.getRange('E7:G9').setValues([
      ['80+', '=M3', '=M3'],
      ['50-79', '=M4', '=M4'],
      ['<50', '=M5', '=M5']
    ]);
    sheet.getRange('E7:G9').setFontSize(10).setVerticalAlignment('middle');
    sheet.getRange('E7:E9').setFontColor(COLORS.panelText).setFontWeight('bold');
    [
      { row: 6, fill: COLORS.green, countColor: '#166534' },
      { row: 7, fill: COLORS.heatAccent, countColor: '#92400E' },
      { row: 8, fill: COLORS.lowScore, countColor: '#991B1B' }
    ].forEach(bar => {
      sheet.getRange(bar.row, 5)
        .setBackgroundColor(bar.fill)
        .setFontColor(bar.fill)
        .setHorizontalAlignment('center')
        .setVerticalAlignment('middle');
      sheet.getRange(bar.row, 6)
        .setFontColor(bar.countColor)
        .setFontWeight('bold')
        .setHorizontalAlignment('center');
    });

    sheet.getRange('L1').setValue('helper');
    sheet.getRange('L2:M4').setValues([
      ['score band', 'count'],
      ['80+', scoreBandFormula('80+')],
      ['50-79', scoreBandFormula('50-79')]
    ]);
    sheet.getRange('L5:M5').setValues([['<50', scoreBandFormula('<50')]]);
    sheet.getRange('L7:M14').setValues([
      ['daily volume', 'items'],
      [dateAddFormula(0), dailyVolumeFormula(0)],
      [dateAddFormula(1), dailyVolumeFormula(1)],
      [dateAddFormula(2), dailyVolumeFormula(2)],
      [dateAddFormula(3), dailyVolumeFormula(3)],
      [dateAddFormula(4), dailyVolumeFormula(4)],
      [dateAddFormula(5), dailyVolumeFormula(5)],
      [dateAddFormula(6), dailyVolumeFormula(6)]
    ]);
    sheet.getRange('L16:O19').setValues([
      ['topic heat', 'x', 'podcast', 'blog'],
      [topics[0], topicCountFormula(topics[0], 'x'), topicCountFormula(topics[0], 'podcast'), topicCountFormula(topics[0], 'blog')],
      [topics[1], topicCountFormula(topics[1], 'x'), topicCountFormula(topics[1], 'podcast'), topicCountFormula(topics[1], 'blog')],
      [topics[2], topicCountFormula(topics[2], 'x'), topicCountFormula(topics[2], 'podcast'), topicCountFormula(topics[2], 'blog')]
    ]);
    sheet.getRange('L1:O19').setBackgroundColor('#F8FAFC').setFontColor(COLORS.muted).setFontSize(9);
    if (typeof sheet.hideColumns === 'function') sheet.hideColumns(HELPER_COLUMN, HELPER_WIDTH);

    sheet.getRange(DISPLAY_HEADER_ROW, 0, 1, headers.length).setValues([headers]);
    sheet.getRange(DISPLAY_HEADER_ROW, 0, 1, headers.length)
      .setFontWeight('bold')
      .setFontColor('#FFFFFF')
      .setBackgroundColor(COLORS.tableHeader)
      .setVerticalAlignment('middle')
      .setHorizontalAlignment('left');

    if (displayRows.length > 0) {
      sheet.getRange(DISPLAY_DATA_ROW, 0, displayRows.length, headers.length).setValues(displayRows);
      sheet.getRange(DISPLAY_DATA_ROW, 0, displayRows.length, headers.length)
        .setVerticalAlignment('top')
        .setHorizontalAlignment('left')
        .setWrap(true);
      sheet.setRowHeights(DISPLAY_DATA_ROW, displayRows.length, 64);
      rows.forEach((row, index) => {
        const targetRow = DISPLAY_DATA_ROW + index;
        const rowFill = index % 2 === 0 ? COLORS.tableAlt : COLORS.card;
        sheet.getRange(targetRow, 0, 1, headers.length).setBackgroundColor(rowFill);
        sheet.getRange(targetRow, 1).setFontColor(sourceAccent(Array.isArray(row) ? row[1] : row.sourceType)).setFontWeight('bold');
        sheet.getRange(targetRow, 7).setBackgroundColor(scoreFill(Array.isArray(row) ? row[7] : row.score)).setFontWeight('bold').setHorizontalAlignment('center');
      });
    }

    const widths = [78, 58, 118, 220, 260, 220, 120, 62, 150, 86];
    widths.forEach((width, index) => sheet.setColumnWidth(index, width));
    sheet.setColumnWidths(HELPER_COLUMN, HELPER_WIDTH, 120);
    sheet.setRowHeight(0, 42);
    sheet.setRowHeight(1, 28);
    sheet.setRowHeight(2, 26);
    sheet.setRowHeight(3, 24);
    sheet.setRowHeight(4, 34);
    sheet.setRowHeights(5, 5, 28);
    sheet.setRowHeight(DISPLAY_HEADER_ROW, 32);

    applyAnalyticsConditionalFormatting(sheet);
    applyScoreConditionalFormatting(sheet, displayRows.length);
    await insertDailyVolumeChart(sheet);
    renderDailyVolumeFallback(sheet);
  }

  try {
    const workbook = univerAPI.getActiveWorkbook();
    const existingRawSheet = workbook.getSheetByName(payload.sheetNames.rawData);
    const existingRunsSheet = workbook.getSheetByName(payload.sheetNames.runs);
    const existingWeekSheet = workbook.getSheetByName(payload.sheetNames.week);
    const rawPlan = planRawUpserts(existingRawSheet, payload.rawRows);
    const runAppendRow = existingRunsSheet ? nextAppendRow(existingRunsSheet, 0) : 1;
    if (existingRawSheet) {
      assertSheetColumnsCanFit(existingRawSheet, payload.rawHeaders.length, payload.sheetNames.rawData, 'raw-data upsert');
      assertSheetRowsCanFit(existingRawSheet, rawPlan.requiredRows, payload.sheetNames.rawData, 'raw-data upsert');
    }
    if (existingRunsSheet) {
      assertSheetColumnsCanFit(existingRunsSheet, payload.runsHeaders.length, payload.sheetNames.runs, 'run append');
      assertSheetRowsCanFit(existingRunsSheet, runAppendRow + 1, payload.sheetNames.runs, 'run append');
    }

    const expectedWeeklyRows = projectedWeeklyRowCount(existingRawSheet);
    const requiredWeeklyRows = weeklySheetRows(expectedWeeklyRows);
    const requiredWeeklyColumns = weeklySheetColumns();
    if (existingWeekSheet) {
      assertSheetRowsCanFit(existingWeekSheet, requiredWeeklyRows);
      assertSheetColumnsCanFit(existingWeekSheet, requiredWeeklyColumns);
    }

    const rawSheet = ensureSheet(workbook, payload.sheetNames.rawData, Math.max(2000, rawPlan.requiredRows), payload.rawHeaders.length);
    const runsSheet = ensureSheet(workbook, payload.sheetNames.runs, Math.max(500, runAppendRow + 1), payload.runsHeaders.length);
    const weekSheet = ensureSheet(workbook, payload.sheetNames.week, requiredWeeklyRows, requiredWeeklyColumns);
    ensureSheetColumns(rawSheet, payload.rawHeaders.length, payload.sheetNames.rawData, 'raw-data upsert');
    ensureSheetRows(rawSheet, rawPlan.requiredRows, payload.sheetNames.rawData, 'raw-data upsert');
    ensureSheetColumns(runsSheet, payload.runsHeaders.length, payload.sheetNames.runs, 'run append');
    ensureSheetRows(runsSheet, runAppendRow + 1, payload.sheetNames.runs, 'run append');
    ensureSheetRows(weekSheet, requiredWeeklyRows);
    ensureSheetColumns(weekSheet, requiredWeeklyColumns);

    assertOrInitHeader(rawSheet, payload.rawHeaders, payload.sheetNames.rawData);
    assertOrInitHeader(runsSheet, payload.runsHeaders, payload.sheetNames.runs);
    applyDataSheetFormatting(rawSheet, payload.rawHeaders.length);
    applyDataSheetFormatting(runsSheet, payload.runsHeaders.length);

    const result = upsertRawRows(rawSheet, payload.rawRows, rawPlan);
    appendRunRow(runsSheet, result.inserted, result.updated, runAppendRow);
    const weeklyRows = buildWeeklyRowsFromRaw(rawSheet);
    ensureSheetRows(weekSheet, weeklySheetRows(weeklyRows.length));
    await renderWeeklySheet(weekSheet, result.inserted, result.updated, weeklyRows, rawSheet);

    return {
      success: true,
      inserted: result.inserted,
      updated: result.updated,
      weeklyRows: weeklyRows.length,
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
    originalItems: payload.items,
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
  const originalItemsSeen = Array.isArray(payload.originalItems) ? payload.originalItems.length : payload.items.length;
  const generatedAt = payload.generatedAt || startedAt;
  const weekSheetName = isoWeekName(generatedAt);
  const weekRange = isoWeekDateRange(generatedAt);
  const finishedAt = new Date().toISOString();
  const rawRows = payload.items.map(item => mapItemToRawRow(item, finishedAt));
  const runRecord = buildRunRecord({
    payload,
    itemsJsonPath: args.itemsJsonPath,
    markdownPath: args.markdownPath,
    config,
    startedAt,
    finishedAt,
    itemsSeen: originalItemsSeen
  });

  let tempDir;
  try {
    tempDir = await mkdtemp(join(tmpdir(), 'follow-builders-univer-update-'));
    const runFile = join(tempDir, 'update-workbook.js');
    await writeFile(runFile, buildWorkbookRunScript({
      rawRows,
      runRecord,
      weekSheetName,
      weekStartDate: weekRange.startDate,
      weekEndDate: weekRange.endDate
    }), 'utf-8');

    await runUniver(['inspect', 'workbook', workbookPath], { univerPath: args.univerPath });
    const backupPath = await backupWorkbook(workbookPath, tempDir);
    let runResult;
    let commitResult;
    let committed = false;
    try {
      const runOutput = await runUniver(['run', workbookPath, '--file', runFile], { univerPath: args.univerPath });
      runResult = parseJsonOutput(runOutput.stdout, 'univer run');
      if (runResult.success !== true) {
        throw new Error(`univer run failed: ${runResult.error || JSON.stringify(runResult)}`);
      }
      await runUniver(['inspect', 'range', workbookPath, '--range', 'raw-data!A1:T5'], { univerPath: args.univerPath });
      commitResult = await runUniverJson(
        ['commit', workbookPath, '--message', buildCommitMessage(weekSheetName, runRecord)],
        { univerPath: args.univerPath }
      );
      if (commitResult.success === false || commitResult.committed === false) {
        throw new Error(`univer commit failed: ${JSON.stringify(commitResult)}`);
      }
      committed = true;
    } catch (err) {
      if (!committed) {
        await restoreWorkbook(backupPath, workbookPath);
      }
      throw err;
    }
    const syncResult = await runUniverJson(['sync', workbookPath], { univerPath: args.univerPath });
    assertSyncSucceeded(syncResult);
    assertNoUncommittedMutations(syncResult);
    const publicUrl = config.univer?.publicUrl || publicUrlForUnit(config.univer?.unitId) || '';

    console.log(JSON.stringify({
      status: 'ok',
      workbookPath,
      weekSheetName,
      publicUrl,
      runResult,
      commitResult,
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
