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
  parseRssItems,
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

test('parseRssItems normalizes official RSS items', () => {
  const xml = `<?xml version="1.0"?>
  <rss>
    <channel>
      <item>
        <guid>openai-news-1</guid>
        <title><![CDATA[New agent tools for builders]]></title>
        <link>https://openai.com/news/agent-tools?utm_source=rss#top</link>
        <pubDate>Tue, 26 May 2026 12:00:00 GMT</pubDate>
        <description><![CDATA[OpenAI released new workflow tools for agent builders.]]></description>
        <dc:creator>OpenAI</dc:creator>
      </item>
    </channel>
  </rss>`;

  const [item] = parseRssItems(xml, {
    sourceKind: 'official',
    sourceName: 'OpenAI News'
  });

  assert.equal(item.sourceKind, 'official');
  assert.equal(item.sourceName, 'OpenAI News');
  assert.equal(item.title, 'New agent tools for builders');
  assert.equal(item.url, 'https://openai.com/news/agent-tools');
  assert.equal(item.publishedAt, '2026-05-26T12:00:00.000Z');
  assert.equal(item.author, 'OpenAI');
  assert.equal(item.rawSourceKey, 'openai-news-1');
  assert.match(item.summary, /workflow tools/);
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
  assert.equal(isAiRelated('Tailwind CSS components'), false);
  assert.equal(isAiRelated('SQLite maintenance tools'), false);
  assert.equal(isAiRelated('Email template builder'), false);
  assert.equal(isAiRelated('AI coding agent debugger'), true);
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

test('fetchDiscoveryContent inspects HN top stories and keeps AI-related items', async () => {
  const responses = new Map([
    ['https://hacker-news.firebaseio.com/v0/topstories.json', {
      ok: true,
      json: async () => [101, 102, 103]
    }],
    ['https://hacker-news.firebaseio.com/v0/item/101.json', {
      ok: true,
      json: async () => ({
        id: 101,
        title: 'SQLite query planner notes',
        url: 'https://example.com/sqlite',
        by: 'dbuser',
        time: 1780000000,
        score: 200,
        descendants: 30
      })
    }],
    ['https://hacker-news.firebaseio.com/v0/item/102.json', {
      ok: true,
      json: async () => ({
        id: 102,
        title: 'Show HN: Production monitor for AI agents',
        url: 'https://example.com/agent-monitor',
        by: 'builder',
        time: 1780000001,
        score: 180,
        descendants: 22
      })
    }],
    ['https://hacker-news.firebaseio.com/v0/item/103.json', {
      ok: true,
      json: async () => ({
        id: 103,
        title: 'LLM inference debugging in real workloads',
        url: 'https://example.com/llm-debug',
        by: 'mlops',
        time: 1780000002,
        score: 90,
        descendants: 11
      })
    }]
  ]);
  const fetchImpl = async url => responses.get(url);
  const state = { seenDiscovery: {} };
  const errors = [];

  const items = await fetchDiscoveryContent([
    {
      name: 'HN Top Stories',
      kind: 'hn',
      type: 'hn_top',
      url: 'https://hacker-news.firebaseio.com/v0/topstories.json',
      maxItems: 3,
      inspectItems: 3
    }
  ], state, errors, { fetchImpl, now: new Date('2026-05-29T00:00:00Z') });

  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Show HN: Production monitor for AI agents');
  assert.equal(items[0].metadata.rank, 2);
  assert.equal(items[1].title, 'LLM inference debugging in real workloads');
  assert.deepEqual(errors, []);
});

test('fetchDiscoveryContent marks only returned globally capped items as seen', async () => {
  const hits = Array.from({ length: 24 }, (_, index) => ({
    objectID: String(index + 1),
    title: `LLM agent eval ${index + 1}`,
    url: `https://example.com/evals-${index + 1}`,
    points: 100 - index,
    num_comments: index,
    created_at: '2026-05-26T00:00:00Z'
  }));
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ hits })
  });
  const state = { seenDiscovery: {} };
  const errors = [];

  const items = await fetchDiscoveryContent([
    {
      name: 'HN Algolia LLM',
      kind: 'hn',
      type: 'hn_algolia',
      url: 'https://hn.algolia.com/api/v1/search_by_date?query=LLM&tags=story',
      maxItems: 24
    }
  ], state, errors, { fetchImpl, now: new Date('2026-05-26T01:00:00Z') });

  assert.equal(items.length, 20);
  assert.equal(Object.keys(state.seenDiscovery).length, 20);
  assert.deepEqual(errors, []);
});
