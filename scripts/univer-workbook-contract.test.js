import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PUBLIC_URL_PREFIX,
  RAW_DATA_HEADERS,
  RUNS_HEADERS,
  SHEETS,
  USER_WORKBOOK_NAME,
  WEEK_DISPLAY_HEADERS,
  WORKBOOK_SCAFFOLD_SCRIPT_PATH,
  appendWorkbookUrl,
  buildContentId,
  groupWeeklyDisplayRows,
  mapItemToRawRow,
  normalizeBlogUrl,
  publicUrlForUnit,
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

test('exports fixed workbook constants and sheet headers', () => {
  assert.equal(WORKBOOK_SCAFFOLD_SCRIPT_PATH, 'scripts/univer-template-scaffold.js');
  assert.equal(USER_WORKBOOK_NAME, 'follow-builders.univer');
  assert.equal(PUBLIC_URL_PREFIX, 'https://univer.ai/space/sheets/');
  assert.deepEqual(SHEETS, {
    rawData: 'raw-data',
    runs: 'runs',
    weekTemplate: '_week-template'
  });
  assert.deepEqual(WEEK_DISPLAY_HEADERS, [
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
});

test('normalizeBlogUrl strips hash and tracking while normalizing path', () => {
  assert.equal(
    normalizeBlogUrl('https://example.com/Posts/Hello/?utm_source=x&utm_medium=social&ref=feed#top'),
    'https://example.com/posts/hello?ref=feed'
  );
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
  assert.throws(
    () => validateItemsPayload({ items: [{
      contentId: 'tweet-1',
      sourceType: 'x',
      title: 'bad id',
      url: 'https://x.com/a/status/1',
      runDate: '2026-05-26'
    }] }),
    /items\[0\]\.contentId must start with x:/
  );
  assert.throws(
    () => validateItemsPayload({ items: [{
      contentId: 'x:1',
      sourceType: 'x',
      title: 'missing runDate',
      url: 'https://x.com/a/status/1'
    }] }),
    /items\[0\]\.runDate is required/
  );
  assert.throws(
    () => validateItemsPayload({ items: [{
      contentId: 'x:1',
      sourceType: 'x',
      title: 'bad runDate',
      url: 'https://x.com/a/status/1',
      runDate: '2026-5-6'
    }] }),
    /items\[0\]\.runDate must be YYYY-MM-DD/
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

test('mapItemToRawRow uses blank updatedAt when none is provided', () => {
  const row = mapItemToRawRow({ contentId: 'x:1' });

  assert.equal(row[19], '');
});

test('mapItemToRawRow preserves blank numeric fields instead of coercing them to zero', () => {
  const row = mapItemToRawRow({
    contentId: 'x:blank-score',
    importanceScore: '',
    likes: '',
    retweets: null,
    replies: undefined
  });

  assert.equal(row[14], '');
  assert.equal(row[15], '');
  assert.equal(row[16], '');
  assert.equal(row[17], '');
});

test('groupWeeklyDisplayRows preserves blank scores instead of coercing them to zero', () => {
  const rows = groupWeeklyDisplayRows([
    {
      contentId: 'x:blank-score',
      sourceType: 'x',
      sourceName: 'X',
      title: 'Blank score',
      importanceScore: '',
      runDate: '2026-05-26'
    }
  ]);

  assert.equal(rows[0][7], '');
});

test('groupWeeklyDisplayRows sorts and maps rows for weekly display', () => {
  const rows = groupWeeklyDisplayRows([
    { contentId: 'blog:1', sourceType: 'blog', sourceName: 'Claude Blog', title: 'Blog', summary: 'B', keyPoints: ['b'], topics: ['release'], importanceScore: 60, url: 'https://example.com/b', publishedAt: '2026-05-25T01:00:00.000Z', runDate: '2026-05-25' },
    { contentId: 'podcast:1', sourceType: 'podcast', sourceName: 'Latent Space', title: 'Podcast', summary: 'P', keyPoints: ['p'], topics: ['research'], importanceScore: 70, url: 'https://youtube.com/p', publishedAt: '2026-05-26T01:00:00.000Z', runDate: '2026-05-26' },
    { contentId: 'x:older', sourceType: 'x', sourceName: 'X', title: 'Older tweet', summary: 'Older', keyPoints: ['older'], topics: ['agents'], importanceScore: 99, url: 'https://x.com/a/status/older', publishedAt: '2026-05-26T01:00:00.000Z', runDate: '2026-05-26' },
    { contentId: 'x:tie-low', sourceType: 'x', sourceName: 'X', title: 'Tie low', summary: 'Low', keyPoints: ['low', 'detail'], topics: ['agents', 'tools'], importanceScore: 70, url: 'https://x.com/a/status/tie-low', publishedAt: '2026-05-26T02:00:00.000Z', runDate: '2026-05-26' },
    { contentId: 'x:tie-high', sourceType: 'x', sourceName: 'X', title: 'Tie high', summary: 'High', keyPoints: ['high'], topics: ['agents'], importanceScore: 90, url: 'https://x.com/a/status/tie-high', publishedAt: '2026-05-26T02:00:00.000Z', runDate: '2026-05-26' },
    { contentId: 'x:newer', sourceType: 'x', sourceName: 'X', title: 'Newer tweet', summary: 'Newer', keyPoints: ['newer'], topics: ['agents'], importanceScore: 80, url: 'https://x.com/a/status/newer', publishedAt: '2026-05-26T03:00:00.000Z', runDate: '2026-05-26' }
  ]);

  assert.deepEqual(rows.map(row => row[0]), ['2026-05-26', '2026-05-26', '2026-05-26', '2026-05-26', '2026-05-26', '2026-05-25']);
  assert.deepEqual(rows.map(row => row[1]), ['X', 'X', 'X', 'X', 'Podcast', 'Blog']);
  assert.deepEqual(rows.map(row => row[9]), ['x:newer', 'x:tie-high', 'x:tie-low', 'x:older', 'podcast:1', 'blog:1']);
  assert.deepEqual(rows[1], [
    '2026-05-26',
    'X',
    'X',
    'Tie high',
    'High',
    'high',
    'agents',
    90,
    'https://x.com/a/status/tie-high',
    'x:tie-high'
  ]);
  assert.deepEqual(rows[2], [
    '2026-05-26',
    'X',
    'X',
    'Tie low',
    'Low',
    'low\n- detail',
    'agents, tools',
    70,
    'https://x.com/a/status/tie-low',
    'x:tie-low'
  ]);
});

test('publicUrlForUnit builds public workbook URLs', () => {
  assert.equal(publicUrlForUnit('unit-1'), 'https://univer.ai/space/sheets/unit-1');
  assert.equal(publicUrlForUnit(''), null);
});

test('appendWorkbookUrl appends one link and avoids duplicates', () => {
  const once = appendWorkbookUrl('Digest body\n', 'https://univer.ai/space/sheets/unit-1');
  assert.match(once, /Univer workbook: https:\/\/univer\.ai\/space\/sheets\/unit-1/);
  const twice = appendWorkbookUrl(once, 'https://univer.ai/space/sheets/unit-1');
  assert.equal(twice.match(/Univer workbook:/g).length, 1);
  const replaced = appendWorkbookUrl(once, 'https://univer.ai/space/sheets/unit-2');
  assert.equal(replaced.match(/Univer workbook:/g).length, 1);
  assert.match(replaced, /Univer workbook: https:\/\/univer\.ai\/space\/sheets\/unit-2/);
});
