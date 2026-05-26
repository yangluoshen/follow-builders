# Source Expansion Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fourth central discovery feed for selected official, HN, GitHub Trending, Reddit, and Product Hunt sources, then let the Codex digest agent decide which candidates enter Markdown delivery and the Univer workbook.

**Architecture:** Keep deterministic fetching and editorial judgment separate. `scripts/generate-feed.js` gathers and normalizes discovery candidates into `feed-discovery.json`; `scripts/prepare-digest.js` passes candidates and prompts to Codex; `scripts/run-llm-digest.js` asks Codex to select, summarize, and write workbook items; the existing wrapper validates items, updates Univer, appends the workbook URL, and delivers Markdown.

**Tech Stack:** Node.js ESM, built-in `node:test`, GitHub Actions, RSS/Atom parsing via focused local helpers, existing Univer workbook contract.

---

## File Structure

- Create `scripts/lib/discovery-feed.js`
  - Owns discovery parsing, normalization, filtering, scoring hints, dedupe keys, and `fetchDiscoveryContent`.
  - Exports pure helpers for unit tests.
- Create `scripts/discovery-feed.test.js`
  - Tests RSS/Atom parsing, HN normalization, GitHub Trending parsing, filtering, dedupe, and fetch orchestration with fake fetch.
- Modify `config/default-sources.json`
  - Adds `discovery_sources` with the approved official and community/product sources.
- Modify `scripts/generate-feed.js`
  - Adds `--discovery-only`, `feed-discovery.json`, `seenDiscovery`, and default all-feeds discovery generation.
- Modify `.github/workflows/generate-feed.yml`
  - Adds workflow dispatch option `discovery-only`.
  - Commits `feed-discovery.json`.
- Modify `scripts/prepare-digest.js`
  - Fetches `feed-discovery.json`.
  - Adds `discovery`, `stats.discoveryItems`, and `prompts.summarize_discovery`.
  - Supports env URL overrides for testability.
- Create `scripts/prepare-digest.test.js`
  - Tests the prepare payload through a local HTTP server.
- Create `prompts/summarize-discovery.md`
  - Tells the agent how to judge discovery candidates.
- Modify `prompts/digest-intro.md`
  - Adds the optional `DISCOVERY` section and no-fabrication rules for discovery.
- Modify `scripts/run-llm-digest.js`
  - Updates the non-interactive Codex prompt for discovery, empty-run logic, and workbook item schema.
- Modify `scripts/run-llm-digest.test.js`
  - Verifies Codex prompt includes discovery behavior and still forbids delivery side effects.
- Modify `scripts/lib/univer-workbook-contract.js`
  - Accepts `sourceType: "discovery"`, builds `discovery:<hash>` IDs, and sorts after Blog.
- Modify `scripts/univer-workbook-contract.test.js`
  - Tests discovery IDs, validation, weekly labels, and sort order.
- Modify `scripts/update-univer-workbook.js`
  - Renders Discovery rows and a dashboard Discovery count.
- Modify `scripts/update-univer-workbook.test.js`
  - Tests generated workbook-local script behavior with discovery rows.
- Modify `README.md`, `README.zh-CN.md`, and `SKILL.md`
  - Documents Discovery sources and updates counts/behavior.

---

### Task 1: Discovery Parsing, Normalization, and Filtering Library

**Files:**
- Create: `scripts/lib/discovery-feed.js`
- Create: `scripts/discovery-feed.test.js`

- [ ] **Step 1: Write failing parser and filter tests**

Create `scripts/discovery-feed.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  discoveryStateKey,
  fetchDiscoveryContent,
  isAiRelated,
  normalizeHtmlReleaseNotePage,
  normalizeDiscoveryUrl,
  normalizeHnAlgoliaHit,
  normalizeHnItem,
  parseAtomEntries,
  parseGitHubTrending,
  shouldExcludeGithubRepo
} from './lib/discovery-feed.js';

test('parseAtomEntries normalizes Product Hunt Atom entries', () => {
  const xml = `<?xml version="1.0"?>
  <feed xmlns="http://www.w3.org/2005/Atom">
    <entry>
      <id>tag:www.producthunt.com,2005:Post/1155711</id>
      <published>2026-05-25T12:49:34-07:00</published>
      <updated>2026-05-26T07:17:16-07:00</updated>
      <link rel="alternate" type="text/html" href="https://www.producthunt.com/products/parrot-speech-to-text-api?utm_source=x"/>
      <title>Parrot Speech-to-text API</title>
      <content type="html">&lt;p&gt;Fast, accurate STT for production-grade voice agents&lt;/p&gt;</content>
      <author><name>maker</name></author>
    </entry>
  </feed>`;

  const [entry] = parseAtomEntries(xml, {
    sourceKind: 'producthunt',
    sourceName: 'Product Hunt AI Featured'
  });

  assert.equal(entry.source, 'discovery');
  assert.equal(entry.sourceKind, 'producthunt');
  assert.equal(entry.sourceName, 'Product Hunt AI Featured');
  assert.equal(entry.title, 'Parrot Speech-to-text API');
  assert.equal(entry.url, 'https://www.producthunt.com/products/parrot-speech-to-text-api');
  assert.equal(entry.author, 'maker');
  assert.equal(entry.rawSourceKey, 'tag:www.producthunt.com,2005:Post/1155711');
  assert.match(entry.summary, /production-grade voice agents/);
});

test('parseAtomEntries normalizes Reddit Atom entries', () => {
  const xml = `<?xml version="1.0"?>
  <feed xmlns="http://www.w3.org/2005/Atom">
    <entry>
      <id>t3_agent123</id>
      <published>2026-05-25T07:38:57+00:00</published>
      <link href="https://www.reddit.com/r/AI_Agents/comments/agent123/example/"/>
      <title>After 6 months of running AI agents in production</title>
      <content type="html">&lt;div&gt;&lt;p&gt;Memory, observability, cost tracking, and loop detection matter more than framework choice.&lt;/p&gt;&lt;/div&gt;</content>
      <author><name>/u/builder</name></author>
    </entry>
  </feed>`;

  const [entry] = parseAtomEntries(xml, {
    sourceKind: 'reddit',
    sourceName: 'r/AI_Agents'
  });

  assert.equal(entry.sourceKind, 'reddit');
  assert.equal(entry.url, 'https://www.reddit.com/r/AI_Agents/comments/agent123/example');
  assert.equal(entry.author, '/u/builder');
  assert.equal(entry.rawSourceKey, 't3_agent123');
  assert.match(entry.summary, /observability/);
});

test('normalizeHnAlgoliaHit maps HN search results with score and comments', () => {
  const item = normalizeHnAlgoliaHit({
    objectID: '41234567',
    title: 'Show HN: An MCP debugger for coding agents',
    url: 'https://example.com/mcp-debugger?utm_source=hn',
    author: 'hnuser',
    created_at: '2026-05-26T00:00:00.000Z',
    points: 128,
    num_comments: 37
  }, { sourceName: 'HN Algolia LLM' });

  assert.equal(item.sourceKind, 'hn');
  assert.equal(item.sourceName, 'HN Algolia LLM');
  assert.equal(item.url, 'https://example.com/mcp-debugger');
  assert.equal(item.metadata.score, 128);
  assert.equal(item.metadata.comments, 37);
  assert.deepEqual(item.metadata.tags, ['agent', 'mcp']);
  assert.equal(item.rawSourceKey, 'hn:41234567');
});

test('normalizeHnItem maps Firebase top story items', () => {
  const item = normalizeHnItem({
    id: 41230000,
    title: 'LLM inference cost lessons from production',
    url: 'https://example.com/llm-costs',
    by: 'builder',
    time: 1780000000,
    score: 240,
    descendants: 81
  }, { sourceName: 'HN Top Stories', rank: 4 });

  assert.equal(item.rawSourceKey, 'hn:41230000');
  assert.equal(item.metadata.rank, 4);
  assert.equal(item.metadata.score, 240);
  assert.equal(item.metadata.comments, 81);
  assert.equal(item.publishedAt, '2026-05-28T20:26:40.000Z');
});

test('normalizeHtmlReleaseNotePage emits content-hash candidates for Anthropic docs pages', () => {
  const html = `
  <html>
    <head><title>Claude Code release notes - Anthropic</title></head>
    <body>
      <main>
        <h1>Claude Code release notes</h1>
        <h2>May 26, 2026</h2>
        <p>Added a new planning mode and improved MCP server reliability for coding agents.</p>
      </main>
    </body>
  </html>`;

  const item = normalizeHtmlReleaseNotePage(html, {
    sourceName: 'Anthropic Claude Code Release Notes',
    sourceKind: 'official',
    url: 'https://docs.anthropic.com/en/release-notes/claude-code',
    capturedAt: '2026-05-26T00:00:00.000Z'
  });

  assert.equal(item.sourceKind, 'official');
  assert.equal(item.title, 'Claude Code release notes');
  assert.equal(item.url, 'https://docs.anthropic.com/en/release-notes/claude-code');
  assert.match(item.summary, /MCP server reliability/);
  assert.match(item.rawSourceKey, /^https:\/\/docs\.anthropic\.com\/en\/release-notes\/claude-code#[a-f0-9]{12}$/);
});

test('parseGitHubTrending extracts and filters repositories', () => {
  const html = `
  <article class="Box-row">
    <h2><a href="/owner/agent-runtime"> owner / agent-runtime </a></h2>
    <p>Runtime for LLM agents with MCP tools and durable workflows</p>
    <span itemprop="programmingLanguage">TypeScript</span>
    <a href="/owner/agent-runtime/stargazers"> 1,234 </a>
  </article>
  <article class="Box-row">
    <h2><a href="/list/awesome-ai"> list / awesome-ai </a></h2>
    <p>Awesome list of AI links</p>
  </article>`;

  const items = parseGitHubTrending(html, { capturedAt: '2026-05-26T00:00:00.000Z' });

  assert.equal(items.length, 1);
  assert.equal(items[0].sourceKind, 'github_trending');
  assert.equal(items[0].title, 'owner/agent-runtime');
  assert.equal(items[0].url, 'https://github.com/owner/agent-runtime');
  assert.equal(items[0].metadata.rank, 1);
  assert.equal(items[0].metadata.language, 'TypeScript');
  assert.equal(items[0].metadata.stars, 1234);
});

test('AI filters accept relevant terms and reject low-signal repos', () => {
  assert.equal(isAiRelated('Durable workflow memory for LLM agents using MCP tools'), true);
  assert.equal(isAiRelated('A CSS color palette generator'), false);
  assert.equal(shouldExcludeGithubRepo({ name: 'awesome-ai', description: 'awesome links' }), true);
  assert.equal(shouldExcludeGithubRepo({ name: 'agent-runtime', description: 'production agent runtime' }), false);
});

test('fetchDiscoveryContent merges sources, dedupes state, and records non-fatal errors', async () => {
  const responses = new Map([
    ['https://example.com/feed.xml', {
      ok: true,
      text: async () => `<?xml version="1.0"?><feed><entry><id>official-1</id><published>2026-05-26T00:00:00Z</published><link href="https://example.com/agents"/><title>Agents update</title><content>New agent tools</content></entry></feed>`
    }],
    ['https://hn.algolia.com/api/v1/search_by_date?query=LLM&tags=story', {
      ok: true,
      json: async () => ({ hits: [{ objectID: '1', title: 'LLM agent evals', url: 'https://example.com/evals', points: 90, num_comments: 12, created_at: '2026-05-26T00:00:00Z' }] })
    }],
    ['https://broken.example.com/feed', {
      ok: false,
      status: 503,
      text: async () => ''
    }]
  ]);
  const fetchImpl = async url => responses.get(url);
  const state = { seenDiscovery: {} };
  const errors = [];

  const items = await fetchDiscoveryContent([
    { name: 'Official Feed', kind: 'official', type: 'atom', url: 'https://example.com/feed.xml' },
    { name: 'HN Algolia LLM', kind: 'hn', type: 'hn_algolia', url: 'https://hn.algolia.com/api/v1/search_by_date?query=LLM&tags=story' },
    { name: 'Broken', kind: 'official', type: 'atom', url: 'https://broken.example.com/feed' }
  ], state, errors, { fetchImpl, now: new Date('2026-05-26T01:00:00Z') });

  assert.equal(items.length, 2);
  assert.equal(Object.keys(state.seenDiscovery).length, 2);
  assert.match(errors.join('\n'), /Discovery: Failed to fetch Broken: HTTP 503/);
  assert.equal(discoveryStateKey(items[0]).startsWith('discovery:'), true);
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
cd scripts && npm test -- discovery-feed.test.js
```

Expected: fail with an import error because `scripts/lib/discovery-feed.js` does not exist.

- [ ] **Step 3: Implement the discovery library**

Create `scripts/lib/discovery-feed.js` with these exported functions and constants:

```js
import { createHash } from 'crypto';

export const DISCOVERY_LOOKBACK_HOURS = 72;
export const MAX_DISCOVERY_PER_SOURCE = 3;
export const MAX_DISCOVERY_CANDIDATES = 20;

const AI_KEYWORDS = [
  'ai', 'agent', 'agents', 'agentic', 'llm', 'llms', 'mcp', 'rag',
  'claude', 'openai', 'gpt', 'gemini', 'deepmind', 'hugging face',
  'model', 'models', 'inference', 'eval', 'evals', 'cursor',
  'copilot', 'coding agent', 'workflow', 'tool use', 'memory',
  'observability', 'reasoning', 'multimodal', 'voice agent'
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
  const tagMatch = block.match(new RegExp(`<${tag}[^>]*>`, 'i'));
  if (!tagMatch) return '';
  const attrMatch = tagMatch[0].match(new RegExp(`${attr}="([^"]+)"`, 'i'));
  return attrMatch ? decodeEntities(attrMatch[1]) : '';
}

function isoOrBlank(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : date.toISOString();
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
  return AI_KEYWORDS.some(keyword => normalized.includes(keyword));
}

function keywordTags(text = '') {
  const normalized = String(text).toLowerCase();
  const tags = [];
  if (/\bagents?\b|agentic|tool use|workflow/.test(normalized)) tags.push('agent');
  if (/\bmcp\b/.test(normalized)) tags.push('mcp');
  if (/\bllms?\b|gpt|claude|gemini|model/.test(normalized)) tags.push('llm');
  if (/eval|benchmark/.test(normalized)) tags.push('eval');
  if (/inference|gpu|cuda|vllm|llama\.cpp/.test(normalized)) tags.push('inference');
  if (/coding|developer|copilot|cursor|code/.test(normalized)) tags.push('developer-tools');
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
    const href =
      attrValue(block, 'link', 'href') ||
      tagValue(block, 'link');
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

export function normalizeHtmlReleaseNotePage(html, { sourceName, sourceKind = 'official', url, capturedAt = new Date().toISOString() }) {
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
  if (GITHUB_EXCLUDED_PREFIXES.some(prefix => name.startsWith(prefix))) return true;
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
    const href = hrefMatch[1];
    const repoPath = href.replace(/^\/+/, '').trim();
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

function stableHash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
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
    .filter(item => item.url && item.title)
    .filter(item => source.kind === 'official' || isAiRelated(`${item.title} ${item.summary}`))
    .filter(item => withinLookback(item, now))
    .slice(0, source.maxItems || MAX_DISCOVERY_PER_SOURCE);
}

export async function fetchDiscoveryContent(sources, state, errors, { fetchImpl = fetch, now = new Date() } = {}) {
  if (!state.seenDiscovery) state.seenDiscovery = {};
  const results = [];
  for (const source of sources || []) {
    try {
      let candidates = [];
      if (['atom', 'rss'].includes(source.type)) {
        const res = await fetchImpl(source.url, { headers: { 'User-Agent': 'FollowBuilders/1.0' }, signal: AbortSignal.timeout?.(30000) });
        if (!res?.ok) throw new Error(`HTTP ${res?.status || 'unknown'}`);
        const xml = await res.text();
        candidates = source.type === 'rss'
          ? parseRssItems(xml, { sourceKind: source.kind, sourceName: source.name })
          : parseAtomEntries(xml, { sourceKind: source.kind, sourceName: source.name });
      } else if (source.type === 'hn_algolia') {
        const res = await fetchImpl(source.url, { headers: { 'User-Agent': 'FollowBuilders/1.0' }, signal: AbortSignal.timeout?.(30000) });
        if (!res?.ok) throw new Error(`HTTP ${res?.status || 'unknown'}`);
        const json = await res.json();
        candidates = (json.hits || []).map(hit => normalizeHnAlgoliaHit(hit, { sourceName: source.name }));
      } else if (source.type === 'github_trending') {
        const res = await fetchImpl(source.url, { headers: { 'User-Agent': 'FollowBuilders/1.0' }, signal: AbortSignal.timeout?.(30000) });
        if (!res?.ok) throw new Error(`HTTP ${res?.status || 'unknown'}`);
        candidates = parseGitHubTrending(await res.text(), { capturedAt: now.toISOString() });
      } else if (source.type === 'html_release_notes') {
        const res = await fetchImpl(source.url, { headers: { 'User-Agent': 'FollowBuilders/1.0' }, signal: AbortSignal.timeout?.(30000) });
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
        state.seenDiscovery[key] = now.getTime();
        results.push(item);
      }
    } catch (err) {
      errors.push(`Discovery: Failed to fetch ${source.name}: ${err.message}`);
    }
  }
  return results
    .sort((a, b) => Number(b.metadata?.score || 0) - Number(a.metadata?.score || 0))
    .slice(0, MAX_DISCOVERY_CANDIDATES);
}
```

- [ ] **Step 4: Run the library tests**

Run:

```bash
cd scripts && npm test -- discovery-feed.test.js
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/discovery-feed.js scripts/discovery-feed.test.js
git commit -m "feat: add discovery feed parsing helpers"
```

---

### Task 2: Discovery Source Config and Feed Generation

**Files:**
- Modify: `config/default-sources.json`
- Modify: `scripts/generate-feed.js`
- Modify: `.github/workflows/generate-feed.yml`
- Test: `scripts/discovery-feed.test.js`

- [ ] **Step 1: Add source config**

Add this top-level key after `blogs` in `config/default-sources.json`:

```json
  "discovery_sources": [
    {
      "name": "OpenAI News",
      "kind": "official",
      "type": "rss",
      "url": "https://openai.com/news/rss.xml",
      "maxItems": 3
    },
    {
      "name": "Google DeepMind Blog",
      "kind": "official",
      "type": "rss",
      "url": "https://deepmind.google/blog/rss.xml",
      "maxItems": 3
    },
    {
      "name": "Hugging Face Blog",
      "kind": "official",
      "type": "rss",
      "url": "https://huggingface.co/blog/feed.xml",
      "maxItems": 3
    },
    {
      "name": "Anthropic API Release Notes",
      "kind": "official",
      "type": "html_release_notes",
      "url": "https://docs.anthropic.com/en/release-notes/api",
      "maxItems": 1
    },
    {
      "name": "Anthropic Claude Code Release Notes",
      "kind": "official",
      "type": "html_release_notes",
      "url": "https://docs.anthropic.com/en/release-notes/claude-code",
      "maxItems": 1
    },
    {
      "name": "Anthropic Claude Apps Release Notes",
      "kind": "official",
      "type": "html_release_notes",
      "url": "https://docs.anthropic.com/en/release-notes/claude-apps",
      "maxItems": 1
    },
    {
      "name": "HN Algolia AI",
      "kind": "hn",
      "type": "hn_algolia",
      "url": "https://hn.algolia.com/api/v1/search_by_date?query=AI&tags=story",
      "maxItems": 3
    },
    {
      "name": "HN Algolia LLM",
      "kind": "hn",
      "type": "hn_algolia",
      "url": "https://hn.algolia.com/api/v1/search_by_date?query=LLM&tags=story",
      "maxItems": 3
    },
    {
      "name": "GitHub Trending Daily",
      "kind": "github_trending",
      "type": "github_trending",
      "url": "https://github.com/trending?since=daily",
      "maxItems": 5
    },
    {
      "name": "r/AI_Agents",
      "kind": "reddit",
      "type": "atom",
      "url": "https://www.reddit.com/r/AI_Agents/top/.rss?t=week",
      "maxItems": 3
    },
    {
      "name": "Product Hunt AI Featured",
      "kind": "producthunt",
      "type": "atom",
      "url": "https://www.producthunt.com/feed?category=artificial-intelligence",
      "maxItems": 3
    },
    {
      "name": "Product Hunt Developer Tools",
      "kind": "producthunt",
      "type": "atom",
      "url": "https://www.producthunt.com/feed?category=developer-tools",
      "maxItems": 3
    }
  ],
```

The Anthropic sources use `html_release_notes`, not Atom/RSS. Their dedupe key includes a content hash so page-level release-note changes can emit a new candidate without repeating the same page every day.

- [ ] **Step 2: Modify state handling in `scripts/generate-feed.js`**

Import the discovery helper near the top:

```js
import { fetchDiscoveryContent } from "./lib/discovery-feed.js";
```

Update `loadState()` fallback and migration so every returned state includes `seenDiscovery`:

```js
return { seenTweets: {}, seenVideos: {}, seenArticles: {}, seenDiscovery: {} };
```

Inside the existing parsed-state branch:

```js
if (!state.seenArticles) state.seenArticles = {};
if (!state.seenDiscovery) state.seenDiscovery = {};
```

Update `saveState()` to prune `seenDiscovery` after 14 days:

```js
const discoveryCutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
for (const [id, ts] of Object.entries(state.seenDiscovery || {})) {
  if (ts < discoveryCutoff) delete state.seenDiscovery[id];
}
```

- [ ] **Step 3: Add `--discovery-only` and default discovery run**

In `main()`, add:

```js
const discoveryOnly = args.includes("--discovery-only");
```

Replace the run booleans with:

```js
const anyOnly = tweetsOnly || podcastsOnly || blogsOnly || discoveryOnly;
const runTweets = tweetsOnly || !anyOnly;
const runPodcasts = podcastsOnly || !anyOnly;
const runBlogs = blogsOnly || !anyOnly;
const runDiscovery = discoveryOnly || !anyOnly;
```

After blog feed generation and before `saveState(state)`, add:

```js
if (runDiscovery && sources.discovery_sources && sources.discovery_sources.length > 0) {
  console.error("Fetching discovery content...");
  const discovery = await fetchDiscoveryContent(
    sources.discovery_sources,
    state,
    errors,
  );
  console.error(`  Found ${discovery.length} discovery candidate(s)`);

  const discoveryFeed = {
    generatedAt: new Date().toISOString(),
    lookbackHours: 72,
    discovery,
    stats: { discoveryItems: discovery.length },
    errors:
      errors.filter((e) => e.startsWith("Discovery")).length > 0
        ? errors.filter((e) => e.startsWith("Discovery"))
        : undefined,
  };
  await writeFile(
    join(SCRIPT_DIR, "..", "feed-discovery.json"),
    JSON.stringify(discoveryFeed, null, 2),
  );
  console.error(`  feed-discovery.json: ${discovery.length} candidates`);
}
```

- [ ] **Step 4: Update workflow**

In `.github/workflows/generate-feed.yml`, add `discovery-only` to the `workflow_dispatch.inputs.mode.options` list:

```yaml
          - discovery-only
```

Update the commit step:

```bash
git add feed-x.json feed-podcasts.json feed-blogs.json feed-discovery.json state-feed.json
```

- [ ] **Step 5: Run tests and smoke generation**

Run:

```bash
cd scripts && npm test -- discovery-feed.test.js
```

Expected: pass.

Run:

```bash
cd scripts && node generate-feed.js --discovery-only
```

Expected: creates or updates `feed-discovery.json` without requiring `X_BEARER_TOKEN` or `POD2TXT_API_KEY`. Non-fatal discovery source errors may appear in the JSON, but the command should exit 0.

- [ ] **Step 6: Commit**

```bash
git add config/default-sources.json scripts/generate-feed.js .github/workflows/generate-feed.yml feed-discovery.json state-feed.json
git commit -m "feat: generate discovery feed"
```

---

### Task 3: Prepare Digest Payload and Discovery Prompt

**Files:**
- Modify: `scripts/prepare-digest.js`
- Create: `scripts/prepare-digest.test.js`
- Create: `prompts/summarize-discovery.md`
- Modify: `prompts/digest-intro.md`

- [ ] **Step 1: Write failing prepare-digest test**

Create `scripts/prepare-digest.test.js`:

```js
import { createServer } from 'http';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

const SCRIPT_DIR = new URL('.', import.meta.url).pathname;
const PREPARE = join(SCRIPT_DIR, 'prepare-digest.js');

async function withServer(routes, fn) {
  const server = createServer((req, res) => {
    const body = routes[req.url];
    if (body === undefined) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': req.url.endsWith('.json') ? 'application/json' : 'text/plain' });
    res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('prepare-digest includes discovery feed and discovery prompt', async t => {
  const home = await mkdtemp(join(tmpdir(), 'follow-builders-prepare-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.follow-builders'), { recursive: true });
  await writeFile(join(home, '.follow-builders', 'config.json'), JSON.stringify({
    language: 'en',
    frequency: 'daily',
    delivery: { method: 'stdout' }
  }), 'utf-8');

  await withServer({
    '/feed-x.json': JSON.stringify({ x: [] }),
    '/feed-podcasts.json': JSON.stringify({ podcasts: [] }),
    '/feed-blogs.json': JSON.stringify({ blogs: [] }),
    '/feed-discovery.json': JSON.stringify({
      generatedAt: '2026-05-26T00:00:00.000Z',
      discovery: [{
        source: 'discovery',
        sourceKind: 'hn',
        sourceName: 'HN Algolia LLM',
        title: 'LLM evals for coding agents',
        url: 'https://example.com/evals',
        publishedAt: '2026-05-26T00:00:00.000Z',
        summary: 'A practical evaluation setup',
        metadata: { score: 90, comments: 12, tags: ['agent', 'eval'] },
        rawSourceKey: 'hn:1'
      }]
    }),
    '/prompts/summarize-podcast.md': 'podcast prompt',
    '/prompts/summarize-tweets.md': 'tweets prompt',
    '/prompts/summarize-blogs.md': 'blogs prompt',
    '/prompts/summarize-discovery.md': 'discovery prompt',
    '/prompts/digest-intro.md': 'digest intro',
    '/prompts/translate.md': 'translate prompt'
  }, async baseUrl => {
    const result = spawnSync(process.execPath, [PREPARE], {
      cwd: join(SCRIPT_DIR, '..'),
      env: {
        ...process.env,
        HOME: home,
        FOLLOW_BUILDERS_FEED_X_URL: `${baseUrl}/feed-x.json`,
        FOLLOW_BUILDERS_FEED_PODCASTS_URL: `${baseUrl}/feed-podcasts.json`,
        FOLLOW_BUILDERS_FEED_BLOGS_URL: `${baseUrl}/feed-blogs.json`,
        FOLLOW_BUILDERS_FEED_DISCOVERY_URL: `${baseUrl}/feed-discovery.json`,
        FOLLOW_BUILDERS_PROMPTS_BASE: `${baseUrl}/prompts`
      },
      encoding: 'utf-8'
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.discovery.length, 1);
    assert.equal(payload.stats.discoveryItems, 1);
    assert.equal(payload.prompts.summarize_discovery, 'discovery prompt');
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
cd scripts && npm test -- prepare-digest.test.js
```

Expected: fail because `prepare-digest.js` does not fetch discovery or `summarize-discovery.md`.

- [ ] **Step 3: Update `prepare-digest.js`**

Replace feed URL constants with env-overridable constants:

```js
const FEED_X_URL = process.env.FOLLOW_BUILDERS_FEED_X_URL || 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json';
const FEED_PODCASTS_URL = process.env.FOLLOW_BUILDERS_FEED_PODCASTS_URL || 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-podcasts.json';
const FEED_BLOGS_URL = process.env.FOLLOW_BUILDERS_FEED_BLOGS_URL || 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-blogs.json';
const FEED_DISCOVERY_URL = process.env.FOLLOW_BUILDERS_FEED_DISCOVERY_URL || 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-discovery.json';

const PROMPTS_BASE = process.env.FOLLOW_BUILDERS_PROMPTS_BASE || 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/prompts';
```

Add `summarize-discovery.md` to `PROMPT_FILES`:

```js
  'summarize-discovery.md',
```

Fetch all four feeds:

```js
const [feedX, feedPodcasts, feedBlogs, feedDiscovery] = await Promise.all([
  fetchJSON(FEED_X_URL),
  fetchJSON(FEED_PODCASTS_URL),
  fetchJSON(FEED_BLOGS_URL),
  fetchJSON(FEED_DISCOVERY_URL)
]);
```

Add the non-fatal error:

```js
if (!feedDiscovery) errors.push('Could not fetch discovery feed');
```

Add payload content:

```js
discovery: feedDiscovery?.discovery || [],
```

Add stats:

```js
discoveryItems: feedDiscovery?.discovery?.length || 0,
feedGeneratedAt: feedX?.generatedAt || feedPodcasts?.generatedAt || feedBlogs?.generatedAt || feedDiscovery?.generatedAt || null
```

- [ ] **Step 4: Add discovery prompt**

Create `prompts/summarize-discovery.md`:

```markdown
# Discovery Summary Prompt

You are judging discovery candidates for an AI builders digest. Discovery items can be official updates, HN discussions, GitHub Trending repositories, Reddit discussions, or Product Hunt launches.

For each candidate, decide whether it is worth including. Include only items that help an AI builder understand a meaningful product, research, infrastructure, agent, model, or workflow signal.

For included items:
- State why a builder should care in 1-3 sentences.
- Identify the signal type: official update, community discussion, trending project, Reddit discussion, or product launch.
- Mention concrete technical or workflow implications.
- Preserve the original URL from the JSON.
- Use metadata such as score, comments, rank, sourceKind, and tags as hints only.

Omit:
- Generic marketing copy with no builder relevance.
- Duplicate coverage of the same underlying announcement.
- Low-signal Product Hunt launches.
- Reddit anecdotes that are mostly speculation, complaints, or career anxiety.
- GitHub repositories that are awesome lists, courses, prompt collections, or empty wrappers.

Never browse the web. Use only the discovery JSON.
```

- [ ] **Step 5: Update digest intro**

In `prompts/digest-intro.md`, change the content order to:

```markdown
1. X / TWITTER section — list each builder with new posts
2. OFFICIAL BLOGS section — list each blog post from AI company blogs (OpenAI, Anthropic, etc.)
3. DISCOVERY section — list selected discovery items from official updates, HN, GitHub, Reddit, and Product Hunt
4. PODCASTS section — list each podcast with new episodes
```

Add this section after Blog post formatting:

```markdown
### Discovery formatting
- Include only discovery items the agent judged worth surfacing.
- Use the source name and item title in the heading.
- Clearly label the signal type when useful: official update, community signal, trending project, Reddit discussion, or product launch.
- Include the direct URL from the JSON `url` field.
- Keep each discovery item concise: why it matters, what changed, and whether to read, try, or track it.
```

Update mandatory links:

```markdown
- Discovery: the direct item URL from the JSON `url` field
```

Update no-fabrication:

```markdown
- Only include content that came from the feed JSON (blogs, podcasts, tweets, and discovery)
```

- [ ] **Step 6: Run tests**

Run:

```bash
cd scripts && npm test -- prepare-digest.test.js
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add scripts/prepare-digest.js scripts/prepare-digest.test.js prompts/summarize-discovery.md prompts/digest-intro.md
git commit -m "feat: include discovery in digest preparation"
```

---

### Task 4: Codex Runner Prompt and Workbook Item Contract

**Files:**
- Modify: `scripts/run-llm-digest.js`
- Modify: `scripts/run-llm-digest.test.js`

- [ ] **Step 1: Add failing prompt test**

In `scripts/run-llm-digest.test.js`, add a case after the existing absolute Node prompt test:

```js
test('Codex prompt treats discovery as agent-judged candidate material', async t => {
  const home = await makeTempHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const fakeCodex = join(home, 'fake-codex');

  await writeExecutable(fakeCodex, `#!/bin/sh
last=
final_message_path=
previous=
for arg do
  if [ "$previous" = "--output-last-message" ]; then
    final_message_path="$arg"
  fi
  last="$arg"
  previous="$arg"
done

case "$last" in
  *"stats.discoveryItems"*"discovery candidates"*"prompts.summarize_discovery"*"sourceType"*"discovery"*"contentId"*"discovery:<stable"*) ;;
  *)
    echo "prompt did not include discovery judgment and workbook instructions" >&2
    exit 47
    ;;
esac

case "$last" in
  *"podcastEpisodes, stats.xBuilders, stats.blogPosts, and stats.discoveryItems are all 0"*) ;;
  *)
    echo "prompt did not update empty-run logic for discovery" >&2
    exit 48
    ;;
esac

digest_path="$(printf '%s\\n' "$last" | sed -n 's/^5\\. Write only the final digest markdown text to \\(.*\\)\\.$/\\1/p')"
items_json_path="$(printf '%s\\n' "$last" | sed -n 's/^6\\. Write the structured workbook items JSON to \\(.*\\)\\.$/\\1/p')"
printf 'Discovery-aware digest' > "$digest_path"
printf '{"runId":"test-run","generatedAt":"2026-05-26T00:00:00.000Z","items":[],"presentationHints":{"weeklyThemes":[],"highlightContentIds":[]}}' > "$items_json_path"
printf 'Digest prepared.' > "$final_message_path"
`);

  const result = runDigestWithFakeCodex({ codexPath: fakeCodex, home });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Discovery-aware digest/);
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
cd scripts && npm test -- run-llm-digest.test.js
```

Expected: fail with `prompt did not include discovery judgment and workbook instructions`.

- [ ] **Step 3: Update `buildPrompt()` in `scripts/run-llm-digest.js`**

Change empty-run step 3:

```js
3. If stats.podcastEpisodes, stats.xBuilders, stats.blogPosts, and stats.discoveryItems are all 0, write this exact digest text to ${digestPath}: No new updates from your builders today. Check back tomorrow!
```

Update the remix instruction:

```js
   - Follow prompts.digest_intro, prompts.summarize_podcast, prompts.summarize_tweets, prompts.summarize_blogs, prompts.summarize_discovery, and prompts.translate from the JSON.
   - Treat discovery candidates as candidate material. Select only items worth surfacing to AI builders.
   - Do not write omitted discovery candidates to the workbook items JSON.
```

Update the workbook schema content ID and source type lines:

```js
         "contentId": "x:<tweet id> | podcast:<guid> | blog:<stable url hash if known> | discovery:<stable hash or source id>",
         "sourceType": "x | podcast | blog | discovery",
         "sourceName": "<X, podcast name, blog name, or discovery source name>",
```

Update raw source key:

```js
         "rawSourceKey": "<tweet id, podcast guid, blog URL, or discovery rawSourceKey>"
```

Add this after the schema block:

```js
Discovery workbook rules:
- Only selected discovery items should appear in items.
- For discovery items, set contentId to "discovery:" plus a stable source id or normalized URL hash.
- Preserve sourceKind context in topics or keyPoints when helpful, but keep sourceType exactly "discovery".
```

- [ ] **Step 4: Run runner tests**

Run:

```bash
cd scripts && npm test -- run-llm-digest.test.js
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/run-llm-digest.js scripts/run-llm-digest.test.js
git commit -m "feat: teach llm runner discovery workflow"
```

---

### Task 5: Workbook Contract Accepts Discovery Items

**Files:**
- Modify: `scripts/lib/univer-workbook-contract.js`
- Modify: `scripts/univer-workbook-contract.test.js`

- [ ] **Step 1: Add failing contract tests**

In `scripts/univer-workbook-contract.test.js`, extend the content ID test:

```js
assert.equal(
  buildContentId({ sourceType: 'discovery', url: 'https://example.com/Agent?utm_source=x#top' }),
  'discovery:5fd4253a55a3'
);
```

Add a discovery validation assertion inside `validateItemsPayload rejects malformed payloads`:

```js
assert.throws(
  () => validateItemsPayload({ items: [{
    contentId: 'blog:wrong',
    sourceType: 'discovery',
    title: 'bad discovery id',
    url: 'https://example.com/item',
    runDate: '2026-05-26'
  }] }),
  /items\[0\]\.contentId must start with discovery:/
);
```

Add a valid discovery payload assertion:

```js
assert.doesNotThrow(() => validateItemsPayload({
  runId: 'run-1',
  generatedAt: '2026-05-26T00:00:00.000Z',
  items: [{
    contentId: 'discovery:hn-1',
    sourceType: 'discovery',
    sourceName: 'HN Algolia LLM',
    title: 'LLM evals for agents',
    url: 'https://example.com/evals',
    publishedAt: '2026-05-26T01:00:00.000Z',
    capturedAt: '2026-05-26T02:00:00.000Z',
    runDate: '2026-05-26',
    textExcerpt: 'excerpt',
    summary: 'summary',
    keyPoints: ['point'],
    topics: ['agents'],
    importanceScore: 75
  }]
}));
```

In `groupWeeklyDisplayRows sorts and maps rows for weekly display`, add a discovery item:

```js
{ contentId: 'discovery:1', sourceType: 'discovery', sourceName: 'HN', title: 'Discovery', summary: 'D', keyPoints: ['d'], topics: ['agents'], importanceScore: 85, url: 'https://example.com/d', publishedAt: '2026-05-26T00:30:00.000Z', runDate: '2026-05-26' },
```

Update expectations so Discovery sorts after Blog on the same date:

```js
assert.deepEqual(rows.map(row => row[1]), ['X', 'X', 'X', 'X', 'Podcast', 'Discovery', 'Blog']);
```

- [ ] **Step 2: Run the failing contract tests**

Run:

```bash
cd scripts && npm test -- univer-workbook-contract.test.js
```

Expected: fail because discovery is not a supported source type.

- [ ] **Step 3: Update workbook contract**

In `scripts/lib/univer-workbook-contract.js`, add:

```js
function normalizeContentUrl(url) {
  const parsed = new URL(url);
  parsed.hash = '';
  for (const key of [...parsed.searchParams.keys()]) {
    if (key.toLowerCase().startsWith('utm_')) parsed.searchParams.delete(key);
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '').toLowerCase();
  return parsed.toString();
}
```

Use `normalizeContentUrl()` inside `normalizeBlogUrl()` to preserve current behavior:

```js
export function normalizeBlogUrl(url) {
  return normalizeContentUrl(url);
}
```

Add discovery to `buildContentId()`:

```js
if (item.sourceType === 'discovery' && item.url) {
  return `discovery:${createHash('sha256').update(normalizeContentUrl(item.url)).digest('hex').slice(0, 12)}`;
}
```

Add labels and order:

```js
const SOURCE_LABELS = Object.freeze({
  x: 'X',
  podcast: 'Podcast',
  blog: 'Blog',
  discovery: 'Discovery'
});

const SOURCE_ORDER = Object.freeze({
  x: 0,
  podcast: 1,
  blog: 2,
  discovery: 3
});
```

Add required prefix:

```js
discovery: 'discovery:'
```

Update allowed source types:

```js
if (!['x', 'podcast', 'blog', 'discovery'].includes(item.sourceType)) {
  throw new Error(`items[${index}].sourceType must be x, podcast, blog, or discovery`);
}
```

- [ ] **Step 4: Run contract tests**

Run:

```bash
cd scripts && npm test -- univer-workbook-contract.test.js
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/univer-workbook-contract.js scripts/univer-workbook-contract.test.js
git commit -m "feat: allow discovery workbook items"
```

---

### Task 6: Univer Weekly Rendering Includes Discovery

**Files:**
- Modify: `scripts/update-univer-workbook.js`
- Modify: `scripts/update-univer-workbook.test.js`

- [ ] **Step 1: Add failing workbook script test**

In `scripts/update-univer-workbook.test.js`, add a focused assertion near existing generated script tests:

```js
test('generated workbook-local script renders discovery source labels and dashboard count', async () => {
  const script = buildWorkbookRunScript({
    rawRows: [
      ['discovery:hn-1', 'discovery', 'HN Algolia LLM', 'hnuser', '', 'LLM evals for agents', 'https://example.com/evals', '2026-05-26T01:00:00.000Z', '2026-05-26T02:00:00.000Z', '2026-05-26', 'excerpt', 'summary', 'point', 'agents', 75, 0, 0, 0, 'hn:1', '2026-05-26T02:00:00.000Z']
    ],
    runRecord: {
      runId: 'run-1',
      startedAt: '2026-05-26T02:00:00.000Z',
      finishedAt: '2026-05-26T02:01:00.000Z',
      status: 'ok',
      itemsSeen: 1,
      itemsInserted: 1,
      itemsUpdated: 0,
      markdownPath: '/tmp/digest.md',
      itemsJsonPath: '/tmp/items.json',
      syncStatus: '',
      unitId: '',
      publicUrl: '',
      errorSummary: ''
    },
    weekSheetName: '2026-W22',
    weekStartDate: '2026-05-25',
    weekEndDate: '2026-05-31'
  });

  assert.match(script, /discovery/);
  assert.match(script, /Discovery/);
  assert.match(script, /dashboardFormula\('discovery'\)/);
  assert.match(script, /source === 'discovery'/);
});
```

- [ ] **Step 2: Run the failing update tests**

Run:

```bash
cd scripts && npm test -- update-univer-workbook.test.js
```

Expected: fail because the generated script does not include Discovery labels, colors, or dashboard count.

- [ ] **Step 3: Update generated workbook script source handling**

In `scripts/update-univer-workbook.js`, update the generated script sections.

Add a color:

```js
discovery: '#0F766E',
```

Update source order:

```js
const sourceOrder = { x: 0, podcast: 1, blog: 2, discovery: 3 };
```

Update source type formula:

```js
return '=IF(' + cell + '="x","X",IF(' + cell + '="podcast","Podcast",IF(' + cell + '="blog","Blog",IF(' + cell + '="discovery","Discovery",' + cell + '))))';
```

Update `sourceTypeFromDisplayType()`:

```js
if (normalized === 'discovery') return 'discovery';
```

Update `countBySource()`:

```js
const counts = { x: 0, podcast: 0, blog: 0, discovery: 0 };
```

Update `sourceAccent()`:

```js
if (source === 'discovery') return COLORS.discovery;
```

Update KPI blocks so Discovery has a first-viewport dashboard count. Keep the existing 10-column layout by replacing the two one-column Median/Low Score cards with a two-column Discovery card:

```js
const kpiBlocks = [
  { label: 'Items', value: dashboardFormula() || rows.length, cardRange: 'A4:B5', labelRange: 'A4:B4', valueRange: 'A5:B5', labelCell: 'A4', valueCell: 'A5', color: COLORS.titleSoft },
  { label: 'X', value: dashboardFormula('x') || sourceCounts.x, cardRange: 'C4:D5', labelRange: 'C4:D4', valueRange: 'C5:D5', labelCell: 'C4', valueCell: 'C5', color: COLORS.x },
  { label: 'Podcast', value: dashboardFormula('podcast') || sourceCounts.podcast, cardRange: 'E4:F5', labelRange: 'E4:F4', valueRange: 'E5:F5', labelCell: 'E4', valueCell: 'E5', color: COLORS.podcast },
  { label: 'Blog', value: dashboardFormula('blog') || sourceCounts.blog, cardRange: 'G4:H5', labelRange: 'G4:H4', valueRange: 'G5:H5', labelCell: 'G4', valueCell: 'G5', color: COLORS.blog },
  { label: 'Discovery', value: dashboardFormula('discovery') || sourceCounts.discovery, cardRange: 'I4:J5', labelRange: 'I4:J4', valueRange: 'I5:J5', labelCell: 'I4', valueCell: 'I5', color: COLORS.discovery }
];
```

Leave topic heat helper tables at X/Podcast/Blog for this implementation.

- [ ] **Step 4: Run update tests**

Run:

```bash
cd scripts && npm test -- update-univer-workbook.test.js
```

Expected: pass.

- [ ] **Step 5: Run all workbook tests**

Run:

```bash
cd scripts && npm test -- univer-workbook-contract.test.js update-univer-workbook.test.js
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/update-univer-workbook.js scripts/update-univer-workbook.test.js
git commit -m "feat: render discovery in workbook"
```

---

### Task 7: Documentation and Skill Source Counts

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `SKILL.md`

- [ ] **Step 1: Update README default sources**

In `README.md`, add a `Discovery Sources` subsection after Official Blogs:

```markdown
### Discovery Sources
- OpenAI News
- Google DeepMind Blog
- Hugging Face Blog
- Hacker News Top Stories and Algolia searches for AI/LLM
- GitHub Trending Daily
- r/AI_Agents top weekly posts
- Product Hunt AI and Developer Tools feeds

Discovery sources are candidate feeds. The agent decides which items are worth including before writing the digest or workbook.
```

In `README.zh-CN.md`, add the equivalent:

```markdown
### Discovery 来源
- OpenAI News
- Google DeepMind Blog
- Hugging Face Blog
- Hacker News Top Stories 以及 AI/LLM Algolia 搜索
- GitHub Trending Daily
- r/AI_Agents 周榜热门帖
- Product Hunt AI 和 Developer Tools feeds

Discovery 来源只是候选内容。最终是否进入摘要和工作簿，由 agent 判断。
```

- [ ] **Step 2: Update SKILL messaging**

In `SKILL.md`, update the introduction text so it says the system tracks builders across X/Twitter, official blogs, podcasts, and discovery sources.

Update any "blogs, podcasts, and tweets" phrase in digest instructions to "blogs, podcasts, tweets, and discovery candidates" where it refers to source material.

- [ ] **Step 3: Verify docs references**

Run:

```bash
rg -n "Discovery|discovery|feed-discovery|blogs, podcasts, and tweets|blogs, podcasts, tweets" README.md README.zh-CN.md SKILL.md prompts scripts
```

Expected: references use the new discovery terminology where relevant, and no instruction says the agent may invent discovery content.

- [ ] **Step 4: Commit**

```bash
git add README.md README.zh-CN.md SKILL.md
git commit -m "docs: document discovery sources"
```

---

### Task 8: Final Verification

**Files:**
- Verify only.

- [ ] **Step 1: Run all script tests**

Run:

```bash
cd scripts && npm test
```

Expected: all tests pass.

- [ ] **Step 2: Run discovery-only feed generation**

Run:

```bash
cd scripts && node generate-feed.js --discovery-only
```

Expected: command exits 0 and writes `feed-discovery.json` with:

```json
{
  "generatedAt": "...",
  "lookbackHours": 72,
  "discovery": [],
  "stats": {
    "discoveryItems": 0
  }
}
```

The `discovery` array may contain candidates. Non-fatal errors may be present as `errors`.

- [ ] **Step 3: Inspect generated discovery feed**

Run:

```bash
jq '{generatedAt, lookbackHours, stats, sample: (.discovery[0:5] | map({sourceKind, sourceName, title, url, rawSourceKey}))}' feed-discovery.json
```

Expected: JSON prints valid normalized candidates or an empty sample. Each sampled item has a non-empty `sourceKind`, `sourceName`, `title`, `url`, and `rawSourceKey`.

- [ ] **Step 4: Run prepare-digest with current feeds**

Run:

```bash
cd scripts && node prepare-digest.js > /tmp/follow-builders-prepare.json
jq '{stats, discoveryCount: (.discovery|length), hasDiscoveryPrompt: (.prompts.summarize_discovery != null)}' /tmp/follow-builders-prepare.json
```

Expected: `hasDiscoveryPrompt` is `true`, `stats.discoveryItems` equals `discoveryCount`, and existing `x`, `podcasts`, and `blogs` fields remain present.

- [ ] **Step 5: Check git diff**

Run:

```bash
git status --short
git log --oneline -8
```

Expected: only intentional generated feed/state changes remain uncommitted if Task 8 produced new feed data after prior commits. Commit them if they are part of the feature branch:

```bash
git add feed-discovery.json state-feed.json
git commit -m "chore: refresh discovery feed"
```

---

## Self-Review Checklist

- Spec coverage:
  - Separate `feed-discovery.json`: Tasks 1-2.
  - Approved sources: Task 2.
  - Agent judgment before digest/workbook: Tasks 3-4.
  - Univer workbook selected discovery rows: Tasks 5-6.
  - Telegram/email wrapper remains owner of delivery: Task 4 keeps delivery prohibition.
  - Product Hunt Atom feeds, no page scrape: Tasks 1-2.
  - Community quotas and filters: Tasks 1-4.
- Deferred-detail scan:
  - No unresolved marker strings or deferred implementation instructions.
  - Every code-changing task includes concrete code snippets and commands.
- Type consistency:
  - Discovery feed field is `discovery`.
  - Stats field is `stats.discoveryItems`.
  - Prompt key is `prompts.summarize_discovery`.
  - Workbook source type is exactly `discovery`.
  - Discovery workbook IDs start with `discovery:`.
