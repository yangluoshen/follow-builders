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
  const COLORS = {
    title: '#102033', titleSoft: '#1E3A5F', x: '#2563EB', podcast: '#7C3AED', blog: '#F59E0B', green: '#16A34A', greenSoft: '#DCFCE7', yellowSoft: '#FEF3C7', redSoft: '#FEE2E2', sheet: '#F6F8FB', card: '#FFFFFF', border: '#E2E8F0', text: '#111827', muted: '#64748B', tableHeader: '#1F4E79', tableAlt: '#F8FBFF'
  };

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
    sheet.getRange('A1:J1').setBackgroundColor(COLORS.title).setFontColor('#FFFFFF').setFontWeight('bold').setFontSize(22).setVerticalAlignment('middle');

    sheet.getRange('A2:J2').merge({ isForceMerge: true }).setValue('Week range · Generated timestamp · Public workbook URL');
    sheet.getRange('A2:J2').setBackgroundColor('#EAF2F8').setFontColor(COLORS.text).setVerticalAlignment('middle');

    sheet.getRange('A3').setValue('Items');
    sheet.getRange('C3').setValue('X');
    sheet.getRange('E3').setValue('Podcast');
    sheet.getRange('G3').setValue('Blog');
    sheet.getRange('I3').setValue('Avg Score');

    sheet.getRange('A4:B5').merge({ isForceMerge: true }).setValue('0');
    sheet.getRange('C4:D5').merge({ isForceMerge: true }).setValue('0');
    sheet.getRange('E4:F5').merge({ isForceMerge: true }).setValue('0');
    sheet.getRange('G4:H5').merge({ isForceMerge: true }).setValue('0');
    sheet.getRange('I4:J5').merge({ isForceMerge: true }).setValue('-');
    [
      ['A4:B5', COLORS.titleSoft],
      ['C4:D5', COLORS.x],
      ['E4:F5', COLORS.podcast],
      ['G4:H5', COLORS.blog],
      ['I4:J5', COLORS.green]
    ].forEach(([a1, color]) => {
      sheet.getRange(a1).setBackgroundColor(color).setFontColor('#FFFFFF').setFontWeight('bold').setFontSize(18).setHorizontalAlignment('center').setVerticalAlignment('middle');
    });

    sheet.getRange('A7:C7').merge({ isForceMerge: true }).setValue('Top X');
    sheet.getRange('D7:F7').merge({ isForceMerge: true }).setValue('Top Podcast');
    sheet.getRange('G7:J7').merge({ isForceMerge: true }).setValue('Highest Score');
    sheet.getRange('A8:C10').merge({ isForceMerge: true }).setValue('Highlight content appears here');
    sheet.getRange('D8:F10').merge({ isForceMerge: true }).setValue('Highlight content appears here');
    sheet.getRange('G8:J10').merge({ isForceMerge: true }).setValue('Highlight content appears here');
    sheet.getRange('A7:J10').setBackgroundColor(COLORS.card).setFontColor(COLORS.text).setVerticalAlignment('top').setWrap(true);
    sheet.getRange('A7').setFontColor(COLORS.x).setFontWeight('bold');
    sheet.getRange('D7').setFontColor(COLORS.podcast).setFontWeight('bold');
    sheet.getRange('G7').setFontColor(COLORS.green).setFontWeight('bold');

    sheet.getRange('A12:J13').merge({ isForceMerge: true }).setValue('Daily Digest');
    sheet.getRange('A12:J13').setBackgroundColor(COLORS.sheet).setFontColor(COLORS.text).setFontWeight('bold').setFontSize(16).setVerticalAlignment('middle');

    sheet.getRange(WEEK_HEADER_ROW, 0, 1, WEEK_DISPLAY_HEADERS.length).setValues([WEEK_DISPLAY_HEADERS]);
    styleHeader(sheet.getRange(WEEK_HEADER_ROW, 0, 1, WEEK_DISPLAY_HEADERS.length), COLORS.tableHeader);

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
    sheet.setRowHeight(WEEK_HEADER_ROW, 32);
    sheet.setRowHeights(WEEK_DATA_START_ROW, 80, 96);
    sheet.getRange(WEEK_DATA_START_ROW, 0, 80, WEEK_DISPLAY_HEADERS.length).setVerticalAlignment('top').setWrap(true);

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
