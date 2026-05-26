import { createHash } from 'crypto';

export const DISCOVERY_LOOKBACK_HOURS = 72;
export const MAX_DISCOVERY_PER_SOURCE = 3;
export const MAX_DISCOVERY_CANDIDATES = 20;

const AI_KEYWORDS = [
  'ai',
  'agent',
  'agents',
  'agentic',
  'llm',
  'llms',
  'mcp',
  'rag',
  'claude',
  'openai',
  'gpt',
  'gemini',
  'deepmind',
  'hugging face',
  'model',
  'models',
  'inference',
  'eval',
  'evals',
  'cursor',
  'copilot',
  'coding agent',
  'workflow',
  'tool use',
  'memory',
  'observability',
  'reasoning',
  'multimodal',
  'voice agent'
];

const GITHUB_EXCLUDED_PREFIXES = ['awesome-', 'course-', 'courses-', 'prompt-list'];

function decodeEntities(value = '') {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripHtml(value = '') {
  return decodeEntities(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tagValue(block, tag) {
  const cdata = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i'));
  if (cdata) return decodeEntities(cdata[1].trim());
  const plain = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return plain ? decodeEntities(plain[1].trim()) : '';
}

function attrValue(block, tag, attr) {
  const tagRegex = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  let tagMatch;
  while ((tagMatch = tagRegex.exec(block)) !== null) {
    const attrMatch = tagMatch[0].match(new RegExp(`${attr}="([^"]+)"`, 'i'));
    if (attrMatch) return decodeEntities(attrMatch[1]);
  }
  return '';
}

function isoOrBlank(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : date.toISOString();
}

function stableHash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

export function normalizeDiscoveryUrl(url) {
  const parsed = new URL(url);
  parsed.hash = '';
  for (const key of [...parsed.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (lower.startsWith('utm_') || lower === 'ref' || lower === 'fbclid' || lower === 'gclid') {
      parsed.searchParams.delete(key);
    }
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString();
}

export function isAiRelated(text = '') {
  const normalized = String(text).toLowerCase();
  return AI_KEYWORDS.some((keyword) => {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(normalized);
  });
}

function keywordTags(text = '') {
  const normalized = String(text).toLowerCase();
  const tags = [];
  if (/\bagents?\b|agentic|tool use|workflow/.test(normalized)) tags.push('agent');
  if (/\bmcp\b/.test(normalized)) tags.push('mcp');
  if (/\bllms?\b|gpt|claude|gemini|model/.test(normalized)) tags.push('llm');
  if (/eval|benchmark/.test(normalized)) tags.push('eval');
  if (/inference|gpu|cuda|vllm|llama\.cpp/.test(normalized)) tags.push('inference');
  if (/developer tools?|copilot|cursor|code assistant/.test(normalized)) tags.push('developer-tools');
  return [...new Set(tags)];
}

function discoveryItem(fields) {
  const text = `${fields.title || ''} ${fields.summary || ''}`;
  return {
    source: 'discovery',
    sourceKind: fields.sourceKind,
    sourceName: fields.sourceName,
    title: fields.title || 'Untitled',
    url: fields.url ? normalizeDiscoveryUrl(fields.url) : '',
    publishedAt: fields.publishedAt || '',
    author: fields.author || '',
    summary: fields.summary || '',
    metadata: {
      score: fields.score || 0,
      comments: fields.comments || 0,
      rank: fields.rank || 0,
      tags: fields.tags || keywordTags(text),
      ...fields.metadata
    },
    rawSourceKey: fields.rawSourceKey
  };
}

export function parseAtomEntries(xml, { sourceKind, sourceName }) {
  const entries = [];
  const entryRegex = /<entry\b[\s\S]*?<\/entry>/gi;
  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const block = match[0];
    const id = tagValue(block, 'id');
    const title = stripHtml(tagValue(block, 'title'));
    const summary = stripHtml(tagValue(block, 'summary') || tagValue(block, 'content'));
    const href = attrValue(block, 'link', 'href') || tagValue(block, 'link');
    if (!href || !title) continue;
    entries.push(discoveryItem({
      sourceKind,
      sourceName,
      title,
      url: href,
      publishedAt: isoOrBlank(tagValue(block, 'published') || tagValue(block, 'updated')),
      author: stripHtml(tagValue(block, 'name')),
      summary,
      rawSourceKey: id || href
    }));
  }
  return entries;
}

export function parseRssItems(xml, { sourceKind, sourceName }) {
  const items = [];
  const itemRegex = /<item\b[\s\S]*?<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[0];
    const guid = tagValue(block, 'guid');
    const title = stripHtml(tagValue(block, 'title'));
    const link = tagValue(block, 'link');
    const summary = stripHtml(tagValue(block, 'description') || tagValue(block, 'content:encoded'));
    if (!link || !title) continue;
    items.push(discoveryItem({
      sourceKind,
      sourceName,
      title,
      url: link,
      publishedAt: isoOrBlank(tagValue(block, 'pubDate') || tagValue(block, 'dc:date')),
      author: stripHtml(tagValue(block, 'author') || tagValue(block, 'dc:creator')),
      summary,
      rawSourceKey: guid || link
    }));
  }
  return items;
}

export function normalizeHnAlgoliaHit(hit, { sourceName }) {
  return discoveryItem({
    sourceKind: 'hn',
    sourceName,
    title: hit.title || hit.story_title || 'Untitled HN item',
    url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
    publishedAt: isoOrBlank(hit.created_at),
    author: hit.author || '',
    summary: hit.title || hit.story_title || '',
    score: hit.points || 0,
    comments: hit.num_comments || 0,
    rawSourceKey: `hn:${hit.objectID}`
  });
}

export function normalizeHnItem(item, { sourceName, rank = 0 }) {
  return discoveryItem({
    sourceKind: 'hn',
    sourceName,
    title: item.title || 'Untitled HN item',
    url: item.url || `https://news.ycombinator.com/item?id=${item.id}`,
    publishedAt: item.time ? new Date(item.time * 1000).toISOString() : '',
    author: item.by || '',
    summary: item.title || '',
    score: item.score || 0,
    comments: item.descendants || 0,
    rank,
    rawSourceKey: `hn:${item.id}`
  });
}

export function normalizeHtmlReleaseNotePage(html, {
  sourceName,
  sourceKind = 'official',
  url,
  capturedAt = new Date().toISOString()
}) {
  const h1 = stripHtml((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '');
  const title = h1 || stripHtml((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || sourceName);
  const main = (html.match(/<main[^>]*>([\s\S]*?)<\/main>/i) || html.match(/<article[^>]*>([\s\S]*?)<\/article>/i) || [null, html])[1];
  const summary = stripHtml(main).slice(0, 700);
  const hash = stableHash(summary);
  return discoveryItem({
    sourceKind,
    sourceName,
    title,
    url,
    publishedAt: capturedAt,
    author: 'Anthropic',
    summary,
    rawSourceKey: `${normalizeDiscoveryUrl(url)}#${hash}`
  });
}

export function shouldExcludeGithubRepo(repo) {
  const name = String(repo.name || '').toLowerCase();
  const description = String(repo.description || '').toLowerCase();
  if (GITHUB_EXCLUDED_PREFIXES.some((prefix) => name.startsWith(prefix))) return true;
  if (/awesome|curated list|course|tutorial collection|prompt list/.test(`${name} ${description}`)) return true;
  return false;
}

export function parseGitHubTrending(html, { capturedAt = new Date().toISOString() } = {}) {
  const items = [];
  const articleRegex = /<article\b[\s\S]*?<\/article>/gi;
  let match;
  let rank = 0;
  while ((match = articleRegex.exec(html)) !== null) {
    const block = match[0];
    const hrefMatch = block.match(/<h2[\s\S]*?<a[^>]+href="([^"]+)"[\s\S]*?<\/a>/i);
    if (!hrefMatch) continue;
    const repoPath = hrefMatch[1].replace(/^\/+/, '').trim();
    const title = repoPath.replace(/\s+/g, '');
    const name = title.split('/').at(-1) || title;
    const description = stripHtml((block.match(/<p[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || '');
    const language = stripHtml((block.match(/itemprop="programmingLanguage"[^>]*>([\s\S]*?)<\/span>/i) || [])[1] || '');
    const starsText = stripHtml((block.match(/href="[^"]+\/stargazers"[\s\S]*?>([\s\S]*?)<\/a>/i) || [])[1] || '0');
    const stars = Number(starsText.replace(/[^\d]/g, '')) || 0;
    const repo = { name, description };
    if (shouldExcludeGithubRepo(repo)) continue;
    if (!isAiRelated(`${title} ${description}`)) continue;
    rank += 1;
    items.push(discoveryItem({
      sourceKind: 'github_trending',
      sourceName: 'GitHub Trending Daily',
      title,
      url: `https://github.com/${title}`,
      publishedAt: capturedAt,
      author: title.split('/')[0],
      summary: description,
      rank,
      rawSourceKey: `github:${title.toLowerCase()}`,
      metadata: { language, stars }
    }));
  }
  return items;
}

export function discoveryStateKey(item) {
  return `discovery:${item.rawSourceKey || stableHash(item.url || item.title)}`;
}

function withinLookback(item, now) {
  if (!item.publishedAt) return true;
  const cutoff = now.getTime() - DISCOVERY_LOOKBACK_HOURS * 60 * 60 * 1000;
  return new Date(item.publishedAt).getTime() >= cutoff;
}

function filterCandidates(items, source, now) {
  return items
    .filter((item) => item.url && item.title)
    .filter((item) => source.kind === 'official' || isAiRelated(`${item.title} ${item.summary}`))
    .filter((item) => withinLookback(item, now))
    .slice(0, source.maxItems || MAX_DISCOVERY_PER_SOURCE);
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  return undefined;
}

export async function fetchDiscoveryContent(sources, state, errors, {
  fetchImpl = fetch,
  now = new Date()
} = {}) {
  if (!state.seenDiscovery) state.seenDiscovery = {};
  const candidatesForReturn = [];
  const pendingKeys = new Set();
  for (const source of sources || []) {
    try {
      let candidates = [];
      if (['atom', 'rss'].includes(source.type)) {
        const res = await fetchImpl(source.url, {
          headers: { 'User-Agent': 'FollowBuilders/1.0' },
          signal: timeoutSignal(30000)
        });
        if (!res?.ok) throw new Error(`HTTP ${res?.status || 'unknown'}`);
        const xml = await res.text();
        candidates = source.type === 'rss'
          ? parseRssItems(xml, { sourceKind: source.kind, sourceName: source.name })
          : parseAtomEntries(xml, { sourceKind: source.kind, sourceName: source.name });
      } else if (source.type === 'hn_algolia') {
        const res = await fetchImpl(source.url, {
          headers: { 'User-Agent': 'FollowBuilders/1.0' },
          signal: timeoutSignal(30000)
        });
        if (!res?.ok) throw new Error(`HTTP ${res?.status || 'unknown'}`);
        const json = await res.json();
        candidates = (json.hits || []).map((hit) => normalizeHnAlgoliaHit(hit, { sourceName: source.name }));
      } else if (source.type === 'hn_top') {
        const res = await fetchImpl(source.url, {
          headers: { 'User-Agent': 'FollowBuilders/1.0' },
          signal: timeoutSignal(30000)
        });
        if (!res?.ok) throw new Error(`HTTP ${res?.status || 'unknown'}`);
        const ids = await res.json();
        const itemIds = Array.isArray(ids) ? ids.slice(0, source.inspectItems || 30) : [];
        const itemBaseUrl = source.itemBaseUrl || 'https://hacker-news.firebaseio.com/v0/item';
        const items = [];
        for (let index = 0; index < itemIds.length; index += 1) {
          const itemRes = await fetchImpl(`${itemBaseUrl}/${itemIds[index]}.json`, {
            headers: { 'User-Agent': 'FollowBuilders/1.0' },
            signal: timeoutSignal(15000)
          });
          if (!itemRes?.ok) continue;
          const item = await itemRes.json();
          if (item) items.push(normalizeHnItem(item, { sourceName: source.name, rank: index + 1 }));
        }
        candidates = items;
      } else if (source.type === 'github_trending') {
        const res = await fetchImpl(source.url, {
          headers: { 'User-Agent': 'FollowBuilders/1.0' },
          signal: timeoutSignal(30000)
        });
        if (!res?.ok) throw new Error(`HTTP ${res?.status || 'unknown'}`);
        candidates = parseGitHubTrending(await res.text(), { capturedAt: now.toISOString() });
      } else if (source.type === 'html_release_notes') {
        const res = await fetchImpl(source.url, {
          headers: { 'User-Agent': 'FollowBuilders/1.0' },
          signal: timeoutSignal(30000)
        });
        if (!res?.ok) throw new Error(`HTTP ${res?.status || 'unknown'}`);
        candidates = [normalizeHtmlReleaseNotePage(await res.text(), {
          sourceName: source.name,
          sourceKind: source.kind,
          url: source.url,
          capturedAt: now.toISOString()
        })];
      }
      for (const item of filterCandidates(candidates, source, now)) {
        const key = discoveryStateKey(item);
        if (state.seenDiscovery[key]) continue;
        if (pendingKeys.has(key)) continue;
        pendingKeys.add(key);
        candidatesForReturn.push({ key, item });
      }
    } catch (err) {
      errors.push(`Discovery: Failed to fetch ${source.name}: ${err.message}`);
    }
  }
  const selected = candidatesForReturn
    .sort((a, b) => Number(b.item.metadata?.score || 0) - Number(a.item.metadata?.score || 0))
    .slice(0, MAX_DISCOVERY_CANDIDATES);

  for (const { key } of selected) {
    state.seenDiscovery[key] = now.getTime();
  }

  return selected.map(({ item }) => item);
}
