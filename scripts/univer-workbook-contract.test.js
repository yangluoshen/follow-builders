import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RAW_DATA_HEADERS,
  RUNS_HEADERS,
  appendWorkbookUrl,
  buildContentId,
  groupWeeklyDisplayRows,
  mapItemToRawRow,
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

test('groupWeeklyDisplayRows sorts dates descending and sources X, Podcast, Blog', () => {
  const rows = groupWeeklyDisplayRows([
    { contentId: 'blog:1', sourceType: 'blog', sourceName: 'Claude Blog', title: 'Blog', summary: 'B', keyPoints: ['b'], topics: ['release'], importanceScore: 60, url: 'https://example.com/b', publishedAt: '2026-05-25T01:00:00.000Z', runDate: '2026-05-25' },
    { contentId: 'podcast:1', sourceType: 'podcast', sourceName: 'Latent Space', title: 'Podcast', summary: 'P', keyPoints: ['p'], topics: ['research'], importanceScore: 70, url: 'https://youtube.com/p', publishedAt: '2026-05-26T01:00:00.000Z', runDate: '2026-05-26' },
    { contentId: 'x:1', sourceType: 'x', sourceName: 'X', title: 'Tweet', summary: 'X', keyPoints: ['x'], topics: ['agents'], importanceScore: 90, url: 'https://x.com/a/status/1', publishedAt: '2026-05-26T02:00:00.000Z', runDate: '2026-05-26' }
  ]);
  assert.deepEqual(rows.map(row => row[0]), ['2026-05-26', '2026-05-26', '2026-05-25']);
  assert.deepEqual(rows.map(row => row[1]), ['X', 'Podcast', 'Blog']);
});

test('appendWorkbookUrl appends one link and avoids duplicates', () => {
  const once = appendWorkbookUrl('Digest body\n', 'https://univer.ai/space/sheets/unit-1');
  assert.match(once, /Univer workbook: https:\/\/univer\.ai\/space\/sheets\/unit-1/);
  const twice = appendWorkbookUrl(once, 'https://univer.ai/space/sheets/unit-1');
  assert.equal(twice.match(/Univer workbook:/g).length, 1);
});
