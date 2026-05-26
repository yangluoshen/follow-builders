() => {
  const RAW_DATA_HEADERS = [
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
  ];
  const RUNS_HEADERS = [
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
  ];
  const WEEK_DISPLAY_HEADERS = [
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
  ];
  const SHEET_NAMES = ['raw-data', 'runs', '_week-template'];
  const WEEK_HEADER_ROW = 10;
  const WEEK_DATA_START_ROW = WEEK_HEADER_ROW + 1;
  const HELPER_COLUMN = 11;
  const HELPER_WIDTH = 4;
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
    heatLow: '#F8FAFC',
    heatMedium: '#BFDBFE',
    heatHigh: '#2563EB',
    heatAccent: '#F59E0B'
  };

  function ensureSheet(workbook, name, rows, columns) {
    return workbook.getSheetByName(name) || workbook.create(name, rows, columns);
  }

  function sheetRowCapacity(sheet) {
    if (typeof sheet.getMaxRows !== 'function') return null;
    const value = Number(sheet.getMaxRows());
    return Number.isFinite(value) ? value : null;
  }

  function sheetColumnCapacity(sheet) {
    if (Number.isFinite(Number(sheet.columnCapacity))) return Number(sheet.columnCapacity);
    if (typeof sheet.getMaxColumns !== 'function') return null;
    const value = Number(sheet.getMaxColumns());
    return Number.isFinite(value) ? value : null;
  }

  function ensureSheetRows(sheet, requiredRows, sheetName) {
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
    throw new Error(sheetName + ' requires at least ' + requiredRows + ' rows; current sheet has ' + currentRows + ' rows and cannot be expanded');
  }

  function ensureSheetColumns(sheet, requiredColumns, sheetName) {
    const currentColumns = sheetColumnCapacity(sheet);
    if (currentColumns === null || currentColumns >= requiredColumns) return;
    if (typeof sheet.setColumnCount === 'function') {
      sheet.setColumnCount(requiredColumns);
      return;
    }
    if (typeof sheet.insertColumnsAfter === 'function') {
      sheet.insertColumnsAfter(currentColumns - 1, requiredColumns - currentColumns);
      return;
    }
    throw new Error(sheetName + ' requires at least ' + requiredColumns + ' columns; current sheet has ' + currentColumns + ' columns and cannot be expanded');
  }

  function stringValue(value) {
    if (value === null || value === undefined) return '';
    return String(value);
  }

  function clearScaffoldArea(sheet, rows, columns) {
    sheet.getRange(0, 0, rows, columns).clear();
    if (typeof sheet.clearConditionalFormatRules === 'function') {
      try {
        sheet.clearConditionalFormatRules();
      } catch {
        // Conditional formatting is decorative; stale rules should not block scaffold initialization.
      }
    }
  }

  function styleHeader(range, backgroundColor) {
    range
      .setFontWeight('bold')
      .setFontColor('#FFFFFF')
      .setBackgroundColor(backgroundColor)
      .setVerticalAlignment('middle');
  }

  function setOutsideBorder(range) {
    if (typeof range.setBorder === 'function' && univerAPI.Enum?.BorderType && univerAPI.Enum?.BorderStyleTypes) {
      range.setBorder(univerAPI.Enum.BorderType.OUTSIDE, univerAPI.Enum.BorderStyleTypes.THIN, COLORS.border);
    }
  }

  function setColumnWidths(sheet, startColumn, columnCount, width) {
    if (typeof sheet.setColumnWidths === 'function') {
      sheet.setColumnWidths(startColumn, columnCount, width);
      return;
    }
    for (let offset = 0; offset < columnCount; offset += 1) {
      sheet.setColumnWidth(startColumn + offset, width);
    }
  }

  function addConditionalFormattingRule(sheet, configure) {
    if (typeof sheet.newConditionalFormattingRule !== 'function' || typeof sheet.addConditionalFormattingRule !== 'function') return false;
    try {
      const builder = sheet.newConditionalFormattingRule();
      if (!builder) return false;
      const rule = configure(builder);
      if (!rule) return false;
      sheet.addConditionalFormattingRule(rule);
      return true;
    } catch {
      return false;
    }
  }

  function applyScoreConditionalFormatting(sheet) {
    const scoreRange = sheet.getRange(WEEK_DATA_START_ROW, 7, 80, 1);
    addConditionalFormattingRule(sheet, builder => {
      if (
        typeof builder.whenNumberGreaterThanOrEqualTo !== 'function' ||
        typeof builder.setBackground !== 'function' ||
        typeof builder.setFontColor !== 'function' ||
        typeof builder.setBold !== 'function' ||
        typeof builder.setRanges !== 'function' ||
        typeof builder.build !== 'function'
      ) return null;
      return builder
        .whenNumberGreaterThanOrEqualTo(80)
        .setBackground(COLORS.greenSoft)
        .setFontColor('#166534')
        .setBold(true)
        .setRanges([scoreRange.getRange()])
        .build();
    });
    addConditionalFormattingRule(sheet, builder => {
      if (
        typeof builder.whenNumberLessThan !== 'function' ||
        typeof builder.setBackground !== 'function' ||
        typeof builder.setFontColor !== 'function' ||
        typeof builder.setBold !== 'function' ||
        typeof builder.setRanges !== 'function' ||
        typeof builder.build !== 'function'
      ) return null;
      return builder
        .whenNumberLessThan(50)
        .setBackground(COLORS.redSoft)
        .setFontColor('#991B1B')
        .setBold(true)
        .setRanges([scoreRange.getRange()])
        .build();
    });
  }

  function applyAnalyticsConditionalFormatting(sheet) {
    const numberValueType = univerAPI.Enum?.ConditionFormatValueTypeEnum?.num;
    if (!numberValueType) return;
    addConditionalFormattingRule(sheet, builder => {
      if (typeof builder.setDataBar !== 'function' || typeof builder.setRanges !== 'function' || typeof builder.build !== 'function') return null;
      return builder
        .setDataBar({
          min: { type: numberValueType, value: 0 },
          max: { type: numberValueType, value: 100 },
          positiveColor: COLORS.x,
          nativeColor: COLORS.lowScore,
          isGradient: true,
          isShowValue: true
        })
        .setRanges([sheet.getRange('F7:F9').getRange()])
        .build();
    });

    addConditionalFormattingRule(sheet, builder => {
      if (typeof builder.setColorScale !== 'function' || typeof builder.setRanges !== 'function' || typeof builder.build !== 'function') return null;
      return builder
        .setColorScale([
          { index: 0, color: COLORS.heatLow, value: { type: numberValueType, value: 0 } },
          { index: 1, color: COLORS.heatMedium, value: { type: numberValueType, value: 2 } },
          { index: 2, color: COLORS.heatHigh, value: { type: numberValueType, value: 5 } }
        ])
        .setRanges([sheet.getRange('B7:D9').getRange()])
        .build();
    });
  }

  function conditionalFormattingRuleCount(sheet) {
    if (typeof sheet.getConditionalFormattingRules !== 'function') return 0;
    try {
      const rules = sheet.getConditionalFormattingRules();
      return Array.isArray(rules) ? rules.length : 0;
    } catch {
      return 0;
    }
  }

  function applyDataSheet(sheet, headers, widths) {
    sheet.getRange(0, 0, 1, headers.length).clear();
    sheet.getRange(0, 0, 1, headers.length).setValues([headers]);
    styleHeader(sheet.getRange(0, 0, 1, headers.length), '#17324D');
    sheet.setFrozenRows(1);
    sheet.setFrozenColumns(1);
    sheet.setHiddenGridlines(false);
    sheet.setRowHeight(0, 30);
    widths.forEach((width, index) => sheet.setColumnWidth(index, width));
  }

  function applyWeekTemplate(sheet) {
    clearScaffoldArea(sheet, 240, HELPER_COLUMN + HELPER_WIDTH);
    sheet.setHiddenGridlines(true);
    sheet.setFrozenRows(0);
    sheet.setFrozenColumns(0);

    sheet.getRange('A1:J1').merge({ isForceMerge: true });
    sheet.getRange('A1').setValue('Follow Builders Weekly Digest');
    sheet.getRange('A1:J1').setBackgroundColor(COLORS.title).setFontColor('#FFFFFF').setFontWeight('bold').setFontSize(22).setVerticalAlignment('middle').setHorizontalAlignment('left');

    sheet.getRange('A2:J2').merge({ isForceMerge: true }).setValue('Week range - Generated timestamp - Public workbook URL');
    sheet.getRange('A2:J2').setBackgroundColor(COLORS.metadata).setFontColor(COLORS.panelText).setVerticalAlignment('middle');

    sheet.getRange('A3:J3').setBackgroundColor(COLORS.sheet);
    sheet.getRange('A3:J3').setValues([['Source', 'All', 'Score', '0-100', 'Topic', 'All', 'Date -> Week', 'Sort', 'Signal', 'View -> Digest']]);
    ['A3:B3', 'C3:D3', 'E3:F3', 'G3', 'H3:I3', 'J3'].forEach(a1 => {
      sheet.getRange(a1).setBackgroundColor(COLORS.card).setFontColor(COLORS.muted).setVerticalAlignment('middle');
      setOutsideBorder(sheet.getRange(a1));
    });
    ['B3', 'D3', 'F3', 'G3', 'I3', 'J3'].forEach(a1 => sheet.getRange(a1).setFontWeight('bold').setFontColor(COLORS.text));

    const kpiBlocks = [
      { label: 'Items', value: "=COUNTIFS('raw-data'!J:J,\">=<weekStart>\",'raw-data'!J:J,\"<=<weekEnd>\")", cardRange: 'A4:B5', labelRange: 'A4:B4', valueRange: 'A5:B5', labelCell: 'A4', valueCell: 'A5', color: COLORS.titleSoft },
      { label: 'X', value: "=COUNTIFS('raw-data'!J:J,\">=<weekStart>\",'raw-data'!J:J,\"<=<weekEnd>\",'raw-data'!B:B,\"x\")", cardRange: 'C4:D5', labelRange: 'C4:D4', valueRange: 'C5:D5', labelCell: 'C4', valueCell: 'C5', color: COLORS.x },
      { label: 'Podcast', value: "=COUNTIFS('raw-data'!J:J,\">=<weekStart>\",'raw-data'!J:J,\"<=<weekEnd>\",'raw-data'!B:B,\"podcast\")", cardRange: 'E4:F5', labelRange: 'E4:F4', valueRange: 'E5:F5', labelCell: 'E4', valueCell: 'E5', color: COLORS.podcast },
      { label: 'Blog', value: "=COUNTIFS('raw-data'!J:J,\">=<weekStart>\",'raw-data'!J:J,\"<=<weekEnd>\",'raw-data'!B:B,\"blog\")", cardRange: 'G4:H5', labelRange: 'G4:H4', valueRange: 'G5:H5', labelCell: 'G4', valueCell: 'G5', color: COLORS.blog },
      { label: 'Median', value: "=IFERROR(MEDIAN(FILTER('raw-data'!O:O,'raw-data'!J:J>=<weekStart>,'raw-data'!J:J<=<weekEnd>)),\"-\")", cardRange: 'I4:I5', labelRange: 'I4:I4', valueRange: 'I5:I5', labelCell: 'I4', valueCell: 'I5', color: COLORS.median },
      { label: 'Low Score', value: "=COUNTIFS('raw-data'!J:J,\">=<weekStart>\",'raw-data'!J:J,\"<=<weekEnd>\",'raw-data'!O:O,\"<50\")", cardRange: 'J4:J5', labelRange: 'J4:J4', valueRange: 'J5:J5', labelCell: 'J4', valueCell: 'J5', color: COLORS.lowScore }
    ];
    kpiBlocks.forEach(block => {
      if (block.labelRange.includes(':')) sheet.getRange(block.labelRange).merge({ isForceMerge: true });
      if (block.valueRange.includes(':')) sheet.getRange(block.valueRange).merge({ isForceMerge: true });
      sheet.getRange(block.labelCell).setValue(block.label);
      sheet.getRange(block.valueCell).setValue(block.value);
      sheet.getRange(block.cardRange).setBackgroundColor(block.color).setFontColor('#FFFFFF').setFontWeight('bold').setHorizontalAlignment('center').setVerticalAlignment('middle');
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
      ['AI agents', '=L17', '=M17', '=N17'],
      ['Open models', '=L18', '=M18', '=N18'],
      ['Research', '=L19', '=M19', '=N19']
    ]);
    sheet.getRange('B10:D10').setValues([['X', 'Podcast', 'Blog']]);
    sheet.getRange('A7:D10').setFontSize(10).setVerticalAlignment('middle');
    sheet.getRange('E7:G9').setValues([
      ['80+', '=M3', 'High'],
      ['50-79', '=M4', 'Medium'],
      ['<50', '=M5', 'Low']
    ]);
    sheet.getRange('E7:G9').setFontSize(10).setVerticalAlignment('middle');
    sheet.getRange('H7:J10').setValues([
      ['Mon', '=M8', ''],
      ['Tue', '=M9', ''],
      ['Wed', '=M10', ''],
      ['Thu-Sun', '=SUM(M11:M14)', '']
    ]);
    sheet.getRange('H7:J10').setFontSize(10).setVerticalAlignment('middle');

    sheet.getRange('L1').setValue('helper');
    sheet.getRange('L2:M5').setValues([
      ['score band', 'count'],
      ['80+', "=COUNTIFS('raw-data'!O:O,\">=80\")"],
      ['50-79', "=COUNTIFS('raw-data'!O:O,\">=50\",'raw-data'!O:O,\"<80\")"],
      ['<50', "=COUNTIFS('raw-data'!O:O,\"<50\")"]
    ]);
    sheet.getRange('L7:M14').setValues([
      ['daily volume', 'items'],
      ['=<weekStart>+0', "=COUNTIFS('raw-data'!J:J,L8)"],
      ['=<weekStart>+1', "=COUNTIFS('raw-data'!J:J,L9)"],
      ['=<weekStart>+2', "=COUNTIFS('raw-data'!J:J,L10)"],
      ['=<weekStart>+3', "=COUNTIFS('raw-data'!J:J,L11)"],
      ['=<weekStart>+4', "=COUNTIFS('raw-data'!J:J,L12)"],
      ['=<weekStart>+5', "=COUNTIFS('raw-data'!J:J,L13)"],
      ['=<weekStart>+6', "=COUNTIFS('raw-data'!J:J,L14)"]
    ]);
    sheet.getRange('L16:O19').setValues([
      ['topic heat', 'x', 'podcast', 'blog'],
      ['AI agents', "=COUNTIFS('raw-data'!N:N,\"*AI agents*\",'raw-data'!B:B,\"x\")", "=COUNTIFS('raw-data'!N:N,\"*AI agents*\",'raw-data'!B:B,\"podcast\")", "=COUNTIFS('raw-data'!N:N,\"*AI agents*\",'raw-data'!B:B,\"blog\")"],
      ['Open models', "=COUNTIFS('raw-data'!N:N,\"*Open models*\",'raw-data'!B:B,\"x\")", "=COUNTIFS('raw-data'!N:N,\"*Open models*\",'raw-data'!B:B,\"podcast\")", "=COUNTIFS('raw-data'!N:N,\"*Open models*\",'raw-data'!B:B,\"blog\")"],
      ['Research', "=COUNTIFS('raw-data'!N:N,\"*Research*\",'raw-data'!B:B,\"x\")", "=COUNTIFS('raw-data'!N:N,\"*Research*\",'raw-data'!B:B,\"podcast\")", "=COUNTIFS('raw-data'!N:N,\"*Research*\",'raw-data'!B:B,\"blog\")"]
    ]);
    sheet.getRange('L1:O19').setBackgroundColor(COLORS.sheet).setFontColor(COLORS.muted).setFontSize(9);
    if (typeof sheet.hideColumns === 'function') sheet.hideColumns(HELPER_COLUMN, HELPER_WIDTH);

    sheet.getRange(WEEK_HEADER_ROW, 0, 1, WEEK_DISPLAY_HEADERS.length).setValues([WEEK_DISPLAY_HEADERS]);
    styleHeader(sheet.getRange(WEEK_HEADER_ROW, 0, 1, WEEK_DISPLAY_HEADERS.length), COLORS.tableHeader);

    const widths = [104, 76, 150, 300, 420, 340, 170, 86, 300, 180];
    widths.forEach((width, index) => sheet.setColumnWidth(index, width));
    setColumnWidths(sheet, HELPER_COLUMN, HELPER_WIDTH, 120);
    sheet.setRowHeight(0, 42);
    sheet.setRowHeight(1, 28);
    sheet.setRowHeight(2, 34);
    sheet.setRowHeights(3, 2, 32);
    sheet.setRowHeights(5, 5, 28);
    sheet.setRowHeight(WEEK_HEADER_ROW, 32);
    sheet.setRowHeights(WEEK_DATA_START_ROW, 80, 64);
    sheet.getRange(WEEK_DATA_START_ROW, 0, 80, WEEK_DISPLAY_HEADERS.length).setVerticalAlignment('top').setHorizontalAlignment('left').setWrap(true);
    sheet.getRange(WEEK_DATA_START_ROW, 0, 80, WEEK_DISPLAY_HEADERS.length).setBackgroundColor(COLORS.tableAlt);
    sheet.getRange(WEEK_DATA_START_ROW, 7, 80, 1).setFontWeight('bold').setHorizontalAlignment('center');

    applyAnalyticsConditionalFormatting(sheet);
    applyScoreConditionalFormatting(sheet);
  }

  try {
    const workbook = univerAPI.getActiveWorkbook();
    const rawSheet = ensureSheet(workbook, 'raw-data', 1000, RAW_DATA_HEADERS.length);
    const runsSheet = ensureSheet(workbook, 'runs', 500, RUNS_HEADERS.length);
    const weekSheet = ensureSheet(workbook, '_week-template', 240, HELPER_COLUMN + HELPER_WIDTH);
    ensureSheetRows(weekSheet, 240, '_week-template');
    ensureSheetColumns(weekSheet, HELPER_COLUMN + HELPER_WIDTH, '_week-template');

    applyDataSheet(rawSheet, RAW_DATA_HEADERS, [
      190,
      110,
      160,
      160,
      150,
      280,
      320,
      190,
      190,
      120,
      360,
      360,
      280,
      220,
      120,
      90,
      90,
      90,
      220,
      190
    ]);
    applyDataSheet(runsSheet, RUNS_HEADERS, [
      260,
      190,
      190,
      100,
      100,
      110,
      110,
      300,
      300,
      120,
      220,
      320,
      320
    ]);
    applyWeekTemplate(weekSheet);

    const allowedSheetNames = new Set(SHEET_NAMES);
    const bootstrapSheetNames = new Set(['Sheet1', 'Sheet 1', 'sheet1']);
    workbook.getSheets().forEach(sheet => {
      const sheetName = sheet.getSheetName();
      const isBlankBootstrapSheet =
        bootstrapSheetNames.has(sheetName) &&
        (
          (sheet.getLastRow() < 0 && sheet.getLastColumn() < 0) ||
          (sheet.getLastRow() === 0 && sheet.getLastColumn() === 0 && !stringValue(sheet.getRange(0, 0).getValue()))
        );
      if (!allowedSheetNames.has(sheetName) && isBlankBootstrapSheet) {
        workbook.deleteSheet(sheet.getSheetId());
      }
    });

    return {
      success: true,
      sheets: workbook.getSheets().map(sheet => sheet.getSheetName()),
      rawHeaderColumns: RAW_DATA_HEADERS.length,
      runsHeaderColumns: RUNS_HEADERS.length,
      weekHeaderRow: WEEK_HEADER_ROW,
      weekConditionalFormattingRules: conditionalFormattingRuleCount(weekSheet)
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
};
