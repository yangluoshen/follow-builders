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
  const WEEK_HEADER_ROW = 14;
  const WEEK_DATA_START_ROW = WEEK_HEADER_ROW + 1;

  function ensureSheet(workbook, name, rows, columns) {
    return workbook.getSheetByName(name) || workbook.create(name, rows, columns);
  }

  function stringValue(value) {
    if (value === null || value === undefined) return '';
    return String(value);
  }

  function clearScaffoldArea(sheet, rows, columns) {
    sheet.getRange(0, 0, rows, columns).clear();
    if (sheet.clearConditionalFormatRules) sheet.clearConditionalFormatRules();
  }

  function styleHeader(range, backgroundColor) {
    range
      .setFontWeight('bold')
      .setFontColor('#FFFFFF')
      .setBackgroundColor(backgroundColor)
      .setVerticalAlignment('middle');
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
    clearScaffoldArea(sheet, 240, WEEK_DISPLAY_HEADERS.length);
    sheet.setHiddenGridlines(true);
    sheet.setFrozenRows(15);
    sheet.setFrozenColumns(2);

    sheet.getRange('A1:J1').merge({ isForceMerge: true });
    sheet.getRange('A1').setValue('Follow Builders Weekly Digest');
    sheet
      .getRange('A1:J1')
      .setFontWeight('bold')
      .setFontSize(18)
      .setFontColor('#0F172A')
      .setBackgroundColor('#EAF2F8')
      .setVerticalAlignment('middle');

    sheet.getRange('A3:B10').setValues([
      ['Week', ''],
      ['Generated at', ''],
      ['Items in update', ''],
      ['Inserted raw rows', ''],
      ['Updated raw rows', ''],
      ['Public URL', ''],
      ['Run ID', ''],
      ['Source order', 'X, Podcast, Blog']
    ]);
    sheet
      .getRange('A3:B10')
      .setBackgroundColor('#F8FAFC')
      .setVerticalAlignment('middle');
    sheet.getRange('A3:A10').setFontWeight('bold').setFontColor('#334155');

    sheet.getRange(WEEK_HEADER_ROW, 0, 1, WEEK_DISPLAY_HEADERS.length).setValues([WEEK_DISPLAY_HEADERS]);
    styleHeader(sheet.getRange(WEEK_HEADER_ROW, 0, 1, WEEK_DISPLAY_HEADERS.length), '#1F4E79');

    const widths = [110, 90, 160, 280, 360, 320, 180, 80, 300, 180];
    widths.forEach((width, index) => sheet.setColumnWidth(index, width));
    sheet.setRowHeight(0, 36);
    sheet.setRowHeight(WEEK_HEADER_ROW, 30);
    sheet.setRowHeights(WEEK_DATA_START_ROW, 80, 76);
    sheet.getRange(WEEK_DATA_START_ROW, 0, 80, WEEK_DISPLAY_HEADERS.length).setVerticalAlignment('top');

    const scoreRange = sheet.getRange('H16:H200');
    const rule = sheet
      .newConditionalFormattingRule()
      .setColorScale([
        {
          index: 0,
          color: '#F8696B',
          value: { type: univerAPI.Enum.ConditionFormatValueTypeEnum.num, value: 0 }
        },
        {
          index: 1,
          color: '#FFEB84',
          value: { type: univerAPI.Enum.ConditionFormatValueTypeEnum.num, value: 50 }
        },
        {
          index: 2,
          color: '#63BE7B',
          value: { type: univerAPI.Enum.ConditionFormatValueTypeEnum.num, value: 100 }
        }
      ])
      .setRanges([scoreRange.getRange()])
      .build();
    sheet.addConditionalFormattingRule(rule);
  }

  try {
    const workbook = univerAPI.getActiveWorkbook();
    const rawSheet = ensureSheet(workbook, 'raw-data', 1000, RAW_DATA_HEADERS.length);
    const runsSheet = ensureSheet(workbook, 'runs', 500, RUNS_HEADERS.length);
    const weekSheet = ensureSheet(workbook, '_week-template', 240, WEEK_DISPLAY_HEADERS.length);

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
      weekConditionalFormattingRules: weekSheet.getConditionalFormattingRules().length
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
};
