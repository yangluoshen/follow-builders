import { createServer } from 'http';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
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

    res.writeHead(200, {
      'content-type': req.url.endsWith('.json') ? 'application/json' : 'text/plain'
    });
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

async function makeHome(config = {}) {
  const home = await mkdtemp(join(tmpdir(), 'follow-builders-prepare-'));
  await mkdir(join(home, '.follow-builders'), { recursive: true });
  await writeFile(join(home, '.follow-builders', 'config.json'), JSON.stringify({
    language: 'en',
    frequency: 'daily',
    delivery: { method: 'stdout' },
    ...config
  }), 'utf-8');
  return home;
}

function runPrepare({ baseUrl, home }) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [PREPARE], {
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

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('close', status => {
      resolve({ status, stdout, stderr });
    });
  });
}

function promptRoutes() {
  return {
    '/prompts/summarize-podcast.md': 'podcast prompt',
    '/prompts/summarize-tweets.md': 'tweets prompt',
    '/prompts/summarize-blogs.md': 'blogs prompt',
    '/prompts/summarize-discovery.md': 'discovery prompt',
    '/prompts/digest-intro.md': 'digest intro',
    '/prompts/translate.md': 'translate prompt'
  };
}

test('prepare-digest includes discovery feed and discovery prompt', async t => {
  const home = await makeHome();
  t.after(() => rm(home, { recursive: true, force: true }));

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
    ...promptRoutes()
  }, async baseUrl => {
    const result = await runPrepare({ baseUrl, home });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.discovery.length, 1);
    assert.equal(payload.discovery[0].rawSourceKey, 'hn:1');
    assert.equal(payload.stats.discoveryItems, 1);
    assert.equal(payload.stats.feedGeneratedAt, '2026-05-26T00:00:00.000Z');
    assert.equal(payload.prompts.summarize_discovery, 'discovery prompt');
  });
});

test('prepare-digest reports empty discovery as no content in stats', async t => {
  const home = await makeHome();
  t.after(() => rm(home, { recursive: true, force: true }));

  await withServer({
    '/feed-x.json': JSON.stringify({ generatedAt: '2026-05-26T00:00:00.000Z', x: [] }),
    '/feed-podcasts.json': JSON.stringify({ podcasts: [] }),
    '/feed-blogs.json': JSON.stringify({ blogs: [] }),
    '/feed-discovery.json': JSON.stringify({ discovery: [] }),
    ...promptRoutes()
  }, async baseUrl => {
    const result = await runPrepare({ baseUrl, home });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(payload.discovery, []);
    assert.equal(payload.stats.podcastEpisodes, 0);
    assert.equal(payload.stats.xBuilders, 0);
    assert.equal(payload.stats.totalTweets, 0);
    assert.equal(payload.stats.blogPosts, 0);
    assert.equal(payload.stats.discoveryItems, 0);
  });
});
