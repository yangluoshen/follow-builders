import { createHash } from 'crypto';

export const WORKBOOK_SCAFFOLD_SCRIPT_PATH = 'scripts/univer-template-scaffold.js';
export const USER_WORKBOOK_NAME = 'follow-builders.univer';
export const PUBLIC_URL_PREFIX = 'https://univer.ai/space/sheets/';

export const SHEETS = Object.freeze({
  rawData: 'raw-data',
  runs: 'runs',
  weekTemplate: '_week-template'
});

export const RAW_DATA_HEADERS = Object.freeze([
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

export const RUNS_HEADERS = Object.freeze([
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

export const WEEK_DISPLAY_HEADERS = Object.freeze([
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

const SOURCE_LABELS = Object.freeze({
  x: 'X',
  podcast: 'Podcast',
  blog: 'Blog'
});

const SOURCE_ORDER = Object.freeze({
  x: 0,
  podcast: 1,
  blog: 2
});

export function normalizeBlogUrl(url) {
  const parsed = new URL(url);
  parsed.hash = '';
  for (const key of [...parsed.searchParams.keys()]) {
    if (key.toLowerCase().startsWith('utm_')) parsed.searchParams.delete(key);
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '').toLowerCase();
  return parsed.toString();
}

export function buildContentId(item) {
  if (item.contentId) return item.contentId;
  if (item.sourceType === 'x' && item.id) return `x:${item.id}`;
  if (item.sourceType === 'podcast' && item.guid) return `podcast:${item.guid}`;
  if (item.sourceType === 'blog' && item.url) {
    return `blog:${createHash('sha256').update(normalizeBlogUrl(item.url)).digest('hex').slice(0, 12)}`;
  }
  throw new Error('Cannot build contentId: unsupported item identity');
}

function toListText(value) {
  if (Array.isArray(value)) return value.map(String).join('\n- ');
  return value ? String(value) : '';
}

function toTopicText(value) {
  if (Array.isArray(value)) return value.map(String).join(', ');
  return value ? String(value) : '';
}

function requireString(value, label) {
  if (!value || typeof value !== 'string') throw new Error(`${label} is required`);
}

function requireContentIdForSource(item, index) {
  const requiredPrefix = {
    x: 'x:',
    podcast: 'podcast:',
    blog: 'blog:'
  }[item.sourceType];
  if (requiredPrefix && !item.contentId.startsWith(requiredPrefix)) {
    throw new Error(`items[${index}].contentId must start with ${requiredPrefix}`);
  }
}

function requireDateOnly(value, label) {
  requireString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must be YYYY-MM-DD`);
}

export function validateItemsPayload(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('items payload must be an object');
  if (!Array.isArray(payload.items)) throw new Error('items payload must include items array');
  payload.items.forEach((item, index) => {
    requireString(item.contentId, `items[${index}].contentId`);
    requireString(item.sourceType, `items[${index}].sourceType`);
    requireString(item.title, `items[${index}].title`);
    requireString(item.url, `items[${index}].url`);
    requireDateOnly(item.runDate, `items[${index}].runDate`);
    if (!['x', 'podcast', 'blog'].includes(item.sourceType)) {
      throw new Error(`items[${index}].sourceType must be x, podcast, or blog`);
    }
    requireContentIdForSource(item, index);
  });
  return payload;
}

export function mapItemToRawRow(item, updatedAt = item.updatedAt || '') {
  return [
    item.contentId,
    item.sourceType || '',
    item.sourceName || '',
    item.authorName || '',
    item.authorHandle || '',
    item.title || '',
    item.url || '',
    item.publishedAt || '',
    item.capturedAt || '',
    item.runDate || '',
    item.textExcerpt || '',
    item.summary || '',
    toListText(item.keyPoints),
    toTopicText(item.topics),
    Number.isFinite(Number(item.importanceScore)) ? Number(item.importanceScore) : '',
    Number.isFinite(Number(item.likes)) ? Number(item.likes) : '',
    Number.isFinite(Number(item.retweets)) ? Number(item.retweets) : '',
    Number.isFinite(Number(item.replies)) ? Number(item.replies) : '',
    item.rawSourceKey || '',
    updatedAt
  ];
}

export function groupWeeklyDisplayRows(items) {
  return [...items]
    .sort((a, b) => {
      const dateCompare = String(b.runDate || '').localeCompare(String(a.runDate || ''));
      if (dateCompare !== 0) return dateCompare;
      const sourceCompare = (SOURCE_ORDER[a.sourceType] ?? 99) - (SOURCE_ORDER[b.sourceType] ?? 99);
      if (sourceCompare !== 0) return sourceCompare;
      const publishedCompare = String(b.publishedAt || '').localeCompare(String(a.publishedAt || ''));
      if (publishedCompare !== 0) return publishedCompare;
      return Number(b.importanceScore || 0) - Number(a.importanceScore || 0);
    })
    .map(item => [
      item.runDate || '',
      SOURCE_LABELS[item.sourceType] || item.sourceType || '',
      item.sourceName || item.authorName || '',
      item.title || '',
      item.summary || '',
      toListText(item.keyPoints),
      toTopicText(item.topics),
      Number.isFinite(Number(item.importanceScore)) ? Number(item.importanceScore) : '',
      item.url || '',
      item.contentId || ''
    ]);
}

export function appendWorkbookUrl(markdown, publicUrl) {
  if (!publicUrl) return markdown;
  const line = `Univer workbook: ${publicUrl}`;
  const workbookLinePattern = /^Univer workbook: .*$/m;
  if (workbookLinePattern.test(markdown)) {
    return markdown.replace(workbookLinePattern, line);
  }
  return `${markdown.trimEnd()}\n\n${line}\n`;
}

export function publicUrlForUnit(unitId) {
  if (!unitId) return null;
  return `${PUBLIC_URL_PREFIX}${unitId}`;
}
