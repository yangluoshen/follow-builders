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

  return `() => {
  const payload = ${JSON.stringify(payload)};
  const DISPLAY_HEADER_ROW = 14;
  const DISPLAY_DATA_ROW = DISPLAY_HEADER_ROW + 1;
  const DASHBOARD_CLEAR_ROWS = 14;
  const TABLE_CLEAR_EXTRA_ROWS = 160;
  const COLORS = {
    title: '#102033', titleSoft: '#1E3A5F', x: '#2563EB', podcast: '#7C3AED', blog: '#F59E0B', green: '#16A34A', greenSoft: '#DCFCE7', yellowSoft: '#FEF3C7', redSoft: '#FEE2E2', sheet: '#F6F8FB', card: '#FFFFFF', border: '#E2E8F0', text: '#111827', muted: '#64748B', tableHeader: '#1F4E79', tableAlt: '#F8FBFF'
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
    return Math.max(120, DISPLAY_DATA_ROW + TABLE_CLEAR_EXTRA_ROWS + rowCount + 30);
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
        const appendRow = nextAppendRow(sheet, 0);
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
    sheet.getRange(nextAppendRow(sheet, 0), 0, 1, payload.runsHeaders.length).setValues([row]);
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
    const sourceLabels = { x: 'X', podcast: 'Podcast', blog: 'Blog' };
    const sourceOrder = { x: 0, podcast: 1, blog: 2 };
    const values = sheet.getRange(1, 0, lastRow, payload.rawHeaders.length).getValues();
    return values
      .filter(row => {
        const contentId = stringValue(row[0]);
        const runDate = stringValue(row[9]);
        return contentId && runDate >= payload.weekStartDate && runDate <= payload.weekEndDate;
      })
      .sort((a, b) => {
        const dateCompare = stringValue(b[9]).localeCompare(stringValue(a[9]));
        if (dateCompare !== 0) return dateCompare;
        const sourceCompare = (sourceOrder[stringValue(a[1])] ?? 99) - (sourceOrder[stringValue(b[1])] ?? 99);
        if (sourceCompare !== 0) return sourceCompare;
        const publishedCompare = stringValue(b[7]).localeCompare(stringValue(a[7]));
        if (publishedCompare !== 0) return publishedCompare;
        return Number(b[14] || 0) - Number(a[14] || 0);
      })
      .map(row => [
        stringValue(row[9]),
        sourceLabels[stringValue(row[1])] || stringValue(row[1]),
        stringValue(row[2]) || stringValue(row[3]),
        stringValue(row[5]),
        stringValue(row[11]),
        stringValue(row[12]),
        stringValue(row[13]),
        Number.isFinite(Number(row[14])) ? Number(row[14]) : '',
        stringValue(row[6]),
        stringValue(row[0])
      ]);
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

  function truncateText(value, maxLength) {
    const text = stringValue(value).replace(/\\s+/g, ' ').trim();
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 1) + '…';
  }

  function countBySource(rows) {
    const counts = { x: 0, podcast: 0, blog: 0 };
    rows.forEach(row => {
      const source = sourceTypeFromDisplayType(row[1]);
      if (Object.prototype.hasOwnProperty.call(counts, source)) counts[source] += 1;
    });
    return counts;
  }

  function numericScores(rows) {
    return rows
      .map(row => Number(row[7]))
      .filter(value => Number.isFinite(value));
  }

  function topRow(rows, predicate) {
    const candidates = predicate ? rows.filter(predicate) : rows;
    return [...candidates].sort((a, b) => Number(b[7] || 0) - Number(a[7] || 0))[0] || null;
  }

  function highlightSummary(row) {
    if (!row) return ['No items yet', 'Waiting for the next digest update.'];
    return [
      truncateText(row[3], 88),
      truncateText(row[4] || row[5] || row[8], 150)
    ];
  }

  function scoreFill(score) {
    const value = Number(score);
    if (!Number.isFinite(value)) return COLORS.card;
    if (value >= 85) return COLORS.greenSoft;
    if (value >= 60) return COLORS.yellowSoft;
    return COLORS.redSoft;
  }

  function sourceAccent(displayType) {
    const source = sourceTypeFromDisplayType(displayType);
    if (source === 'x') return COLORS.x;
    if (source === 'podcast') return COLORS.podcast;
    if (source === 'blog') return COLORS.blog;
    return COLORS.muted;
  }

  function applyRangeBox(range, backgroundColor, fontColor) {
    range
      .setBackgroundColor(backgroundColor)
      .setFontColor(fontColor)
      .setVerticalAlignment('middle')
      .setHorizontalAlignment('left');
  }

  function renderWeeklySheet(sheet, inserted, updated, rows) {
    const headers = payload.weekHeaders;
    const counts = countBySource(rows);
    const scores = numericScores(rows);
    const averageScore = scores.length ? Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length) : '';
    const topScore = scores.length ? Math.max(...scores) : '';
    const topX = topRow(rows, row => sourceTypeFromDisplayType(row[1]) === 'x');
    const topPodcast = topRow(rows, row => sourceTypeFromDisplayType(row[1]) === 'podcast');
    const highest = topRow(rows);

    sheet.setHiddenGridlines(true);
    sheet.setFrozenRows(15);
    sheet.setFrozenColumns(2);

    sheet.getRange(0, 0, DASHBOARD_CLEAR_ROWS, headers.length).clear();
    const clearRows = Math.max(sheet.getLastRow() - DISPLAY_DATA_ROW + 1, rows.length + TABLE_CLEAR_EXTRA_ROWS, 1);
    sheet.getRange(DISPLAY_DATA_ROW, 0, clearRows, headers.length).clearContent();

    sheet.getRange('A1:J1').merge({ isForceMerge: true });
    sheet.getRange('A1').setValue(payload.sheetNames.week + ' Follow Builders');
    applyRangeBox(sheet.getRange('A1:J1'), COLORS.title, '#FFFFFF');
    sheet.getRange('A1:J1').setFontWeight('bold').setFontSize(22);

    sheet.getRange('A2:J2').merge({ isForceMerge: true });
    sheet.getRange('A2').setValue(humanDateRange() + ' · Generated ' + payload.runRecord.finishedAt + ' · ' + (payload.runRecord.publicUrl || 'Local workbook'));
    sheet.getRange('A2:J2').setBackgroundColor('#EAF2F8').setFontColor(COLORS.text).setVerticalAlignment('middle');

    sheet.getRange('A4:B5').merge({ isForceMerge: true }).setValue(rows.length);
    sheet.getRange('C4:D5').merge({ isForceMerge: true }).setValue(counts.x);
    sheet.getRange('E4:F5').merge({ isForceMerge: true }).setValue(counts.podcast);
    sheet.getRange('G4:H5').merge({ isForceMerge: true }).setValue(counts.blog);
    sheet.getRange('I4:J5').merge({ isForceMerge: true }).setValue(averageScore === '' ? '—' : averageScore);
    [
      ['A4:B5', COLORS.titleSoft],
      ['C4:D5', COLORS.x],
      ['E4:F5', COLORS.podcast],
      ['G4:H5', COLORS.blog],
      ['I4:J5', COLORS.green]
    ].forEach(([a1, color]) => {
      sheet.getRange(a1).setBackgroundColor(color).setFontColor('#FFFFFF').setFontWeight('bold').setFontSize(18).setHorizontalAlignment('center').setVerticalAlignment('middle');
    });
    sheet.getRange('A3').setValue('Items');
    sheet.getRange('C3').setValue('X');
    sheet.getRange('E3').setValue('Podcast');
    sheet.getRange('G3').setValue('Blog');
    sheet.getRange('I3').setValue('Avg Score');

    const topXSummary = highlightSummary(topX);
    const podcastSummary = highlightSummary(topPodcast);
    const highSummary = highlightSummary(highest);
    sheet.getRange('A7:C7').merge({ isForceMerge: true }).setValue('Top X');
    sheet.getRange('D7:F7').merge({ isForceMerge: true }).setValue('Top Podcast');
    sheet.getRange('G7:J7').merge({ isForceMerge: true }).setValue('Highest Score' + (topScore === '' ? '' : ' · ' + topScore));
    sheet.getRange('A8:C8').merge({ isForceMerge: true }).setValue(topXSummary[0]);
    sheet.getRange('D8:F8').merge({ isForceMerge: true }).setValue(podcastSummary[0]);
    sheet.getRange('G8:J8').merge({ isForceMerge: true }).setValue(highSummary[0]);
    sheet.getRange('A9:C10').merge({ isForceMerge: true }).setValue(topXSummary[1]);
    sheet.getRange('D9:F10').merge({ isForceMerge: true }).setValue(podcastSummary[1]);
    sheet.getRange('G9:J10').merge({ isForceMerge: true }).setValue(highSummary[1]);
    [
      ['A7:C10', COLORS.x],
      ['D7:F10', COLORS.podcast],
      ['G7:J10', COLORS.green]
    ].forEach(([a1, color]) => {
      sheet.getRange(a1).setBackgroundColor(COLORS.card).setFontColor(COLORS.text).setVerticalAlignment('top').setWrap(true);
      sheet.getRange(a1.split(':')[0]).setFontColor(color).setFontWeight('bold');
    });

    sheet.getRange('A12:J13').merge({ isForceMerge: true }).setValue('Daily Digest');
    sheet.getRange('A12:J13').setBackgroundColor(COLORS.sheet).setFontColor(COLORS.text).setFontWeight('bold').setFontSize(16).setVerticalAlignment('middle');

    sheet.getRange(DISPLAY_HEADER_ROW, 0, 1, headers.length).setValues([headers]);
    sheet
      .getRange(DISPLAY_HEADER_ROW, 0, 1, headers.length)
      .setFontWeight('bold')
      .setFontColor('#FFFFFF')
      .setBackgroundColor(COLORS.tableHeader)
      .setVerticalAlignment('middle')
      .setHorizontalAlignment('left');

    if (rows.length > 0) {
      sheet.getRange(DISPLAY_DATA_ROW, 0, rows.length, headers.length).setValues(rows);
      sheet.getRange(DISPLAY_DATA_ROW, 0, rows.length, headers.length).setVerticalAlignment('top').setHorizontalAlignment('left').setWrap(true);
      sheet.setRowHeights(DISPLAY_DATA_ROW, rows.length, 96);
      rows.forEach((row, index) => {
        const targetRow = DISPLAY_DATA_ROW + index;
        const rowFill = index % 2 === 0 ? COLORS.tableAlt : COLORS.card;
        sheet.getRange(targetRow, 0, 1, headers.length).setBackgroundColor(rowFill);
        sheet.getRange(targetRow, 1).setFontColor(sourceAccent(row[1])).setFontWeight('bold');
        sheet.getRange(targetRow, 7).setBackgroundColor(scoreFill(row[7])).setFontWeight('bold').setHorizontalAlignment('center');
      });
    }

    const widths = [104, 88, 150, 300, 430, 360, 170, 86, 330, 190];
    widths.forEach((width, index) => sheet.setColumnWidth(index, width));
    sheet.setRowHeight(0, 34);
    sheet.setRowHeight(1, 28);
    sheet.setRowHeight(2, 26);
    sheet.setRowHeight(3, 44);
    sheet.setRowHeight(4, 44);
    sheet.setRowHeight(6, 24);
    sheet.setRowHeight(7, 34);
    sheet.setRowHeight(8, 46);
    sheet.setRowHeight(9, 46);
    sheet.setRowHeight(11, 30);
    sheet.setRowHeight(12, 30);
    sheet.setRowHeight(DISPLAY_HEADER_ROW, 32);
  }

  try {
    const workbook = univerAPI.getActiveWorkbook();
    const rawSheet = ensureSheet(workbook, payload.sheetNames.rawData, 2000, payload.rawHeaders.length);
    const runsSheet = ensureSheet(workbook, payload.sheetNames.runs, 500, payload.runsHeaders.length);

    assertOrInitHeader(rawSheet, payload.rawHeaders, payload.sheetNames.rawData);
    assertOrInitHeader(runsSheet, payload.runsHeaders, payload.sheetNames.runs);
    applyDataSheetFormatting(rawSheet, payload.rawHeaders.length);
    applyDataSheetFormatting(runsSheet, payload.runsHeaders.length);

    const result = upsertRawRows(rawSheet, payload.rawRows);
    appendRunRow(runsSheet, result.inserted, result.updated);
    const weeklyRows = buildWeeklyRowsFromRaw(rawSheet);
    const weekSheet = ensureSheet(workbook, payload.sheetNames.week, weeklySheetRows(weeklyRows.length), payload.weekHeaders.length);
    renderWeeklySheet(weekSheet, result.inserted, result.updated, weeklyRows);

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
