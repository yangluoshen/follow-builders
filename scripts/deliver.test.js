import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { createServer } from 'node:http';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import test from 'node:test';
import assert from 'node:assert/strict';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const DELIVER = join(SCRIPT_DIR, 'deliver.js');
const CLEAN_PATH = '/usr/bin:/bin';

async function makeTempHome() {
  return mkdtemp(join(tmpdir(), 'follow-builders-deliver-test-home-'));
}

async function writeUserFile(home, relativePath, text) {
  const userDir = join(home, '.follow-builders');
  await mkdir(userDir, { recursive: true });
  await writeFile(join(userDir, relativePath), text, 'utf-8');
}

async function writeConfig(home, config) {
  await writeUserFile(home, 'config.json', `${JSON.stringify(config, null, 2)}\n`);
}

async function writeEnv(home, text) {
  await writeUserFile(home, '.env', text);
}

async function writeTelegramFetchPreload(home, apiBaseUrl) {
  const preloadPath = join(home, '.follow-builders', 'mock-telegram-fetch.cjs');
  await writeUserFile(home, 'mock-telegram-fetch.cjs', `
const telegramApiBaseUrl = ${JSON.stringify(apiBaseUrl)};
const originalFetch = globalThis.fetch;

globalThis.fetch = async function fetchWithMockedTelegram(input, init) {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname === 'api.telegram.org') {
    return originalFetch(new URL(url.pathname + url.search, telegramApiBaseUrl), init);
  }
  return originalFetch(input, init);
};
`);
  return preloadPath;
}

async function writeFastDelayPreload(home) {
  const delayCountPath = join(home, '.follow-builders', 'delay-count.txt');
  const preloadPath = join(home, '.follow-builders', 'fast-delay.cjs');
  await writeUserFile(home, 'fast-delay.cjs', `
const { writeFileSync } = require('node:fs');
const delayCountPath = ${JSON.stringify(delayCountPath)};
const originalSetTimeout = globalThis.setTimeout;
let delayCount = 0;

globalThis.setTimeout = function setTimeoutWithFastDeliveryDelay(callback, delay, ...args) {
  if (delay === 500) {
    delayCount += 1;
    return originalSetTimeout(callback, 0, ...args);
  }
  return originalSetTimeout(callback, delay, ...args);
};

process.on('exit', () => {
  writeFileSync(delayCountPath, String(delayCount));
});
`);
  return { preloadPath, delayCountPath };
}

async function runDeliver({
  home,
  message = 'Digest body',
  extraEnv = {},
  preloadModules = [],
  timeoutMs = 5000
}) {
  const childEnv = { ...process.env };
  delete childEnv.DISCORD_WEBHOOK_URL;
  delete childEnv.TELEGRAM_BOT_TOKEN;
  delete childEnv.RESEND_API_KEY;
  delete childEnv.FOLLOW_BUILDERS_TELEGRAM_API_BASE;
  delete childEnv.NODE_OPTIONS;
  const preloadArgs = preloadModules.flatMap(modulePath => [
    '--require',
    modulePath
  ]);

  return new Promise((resolve, reject) => {
    let timedOut = false;
    let killTimeout;
    const child = spawn(
      process.execPath,
      [...preloadArgs, DELIVER, '--message', message],
      {
        cwd: join(SCRIPT_DIR, '..'),
        env: {
          ...childEnv,
          ...extraEnv,
          HOME: home,
          PATH: CLEAN_PATH
        }
      }
    );
    const stdout = [];
    const stderr = [];

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    const timeout = setTimeout(() => {
      timedOut = true;
      stderr.push(`\nTimed out after ${timeoutMs}ms\n`);
      child.kill('SIGTERM');
      killTimeout = setTimeout(() => {
        child.kill('SIGKILL');
      }, 500);
    }, timeoutMs);
    child.on('error', err => {
      clearTimeout(timeout);
      clearTimeout(killTimeout);
      reject(err);
    });
    child.on('close', (status, signal) => {
      clearTimeout(timeout);
      clearTimeout(killTimeout);
      resolve({
        status,
        signal,
        stdout: stdout.join(''),
        stderr: stderr.join(''),
        timedOut
      });
    });
  });
}

async function withJsonServer(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf-8');
      let body;
      try {
        body = bodyText ? JSON.parse(bodyText) : null;
      } catch {
        res.statusCode = 400;
        res.end('Invalid JSON');
        return;
      }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler({ req, res, body, requests });
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/webhook`,
    requests,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

test('discord target posts markdown content with mentions disabled', async t => {
  const home = await makeTempHome();
  t.after(() => rm(home, { recursive: true, force: true }));

  const server = await withJsonServer(({ res }) => {
    res.statusCode = 204;
    res.end();
  });
  t.after(() => server.close());

  await writeConfig(home, { delivery: { targets: [{ method: 'discord' }] } });
  await writeEnv(home, `DISCORD_WEBHOOK_URL=${server.url}\n`);

  const result = await runDeliver({ home, message: '# Digest\nHello @everyone' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].method, 'POST');
  assert.deepEqual(server.requests[0].body, {
    content: '# Digest\nHello @everyone',
    allowed_mentions: { parse: [] }
  });
  assert.match(result.stdout, /"method":"discord"/);
  assert.match(result.stdout, /"status":"ok"/);
});

test('discord target splits long markdown into multiple webhook posts', async t => {
  const home = await makeTempHome();
  t.after(() => rm(home, { recursive: true, force: true }));

  const server = await withJsonServer(({ res }) => {
    res.statusCode = 204;
    res.end();
  });
  t.after(() => server.close());

  await writeConfig(home, { delivery: { targets: [{ method: 'discord' }] } });
  await writeEnv(home, `DISCORD_WEBHOOK_URL=${server.url}\n`);

  const longMessage = `${'a'.repeat(1800)}\n${'b'.repeat(1800)}\n${'c'.repeat(1800)}`;
  const result = await runDeliver({ home, message: longMessage });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(server.requests.length, 3);
  assert.equal(server.requests.map(request => request.body.content).join('\n'), longMessage);
  for (const request of server.requests) {
    assert.ok(request.body.content.length <= 1900);
    assert.deepEqual(request.body.allowed_mentions, { parse: [] });
  }
});

test('discord chunk delay happens only between chunks', async t => {
  const home = await makeTempHome();
  t.after(() => rm(home, { recursive: true, force: true }));

  const server = await withJsonServer(({ res }) => {
    res.statusCode = 204;
    res.end();
  });
  t.after(() => server.close());

  await writeConfig(home, { delivery: { targets: [{ method: 'discord' }] } });
  await writeEnv(home, `DISCORD_WEBHOOK_URL=${server.url}\n`);
  const { preloadPath, delayCountPath } = await writeFastDelayPreload(home);

  const longMessage = `${'a'.repeat(1800)}\n${'b'.repeat(1800)}\n${'c'.repeat(1800)}`;
  const result = await runDeliver({
    home,
    message: longMessage,
    preloadModules: [preloadPath]
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(server.requests.length, 3);
  assert.equal(await readFile(delayCountPath, 'utf-8'), '2');
});

test('legacy telegram delivery still works', async t => {
  const home = await makeTempHome();
  t.after(() => rm(home, { recursive: true, force: true }));

  const server = await withJsonServer(({ res }) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, result: {} }));
  });
  t.after(() => server.close());

  await writeConfig(home, { delivery: { method: 'telegram', chatId: 'chat-123' } });
  await writeEnv(home, 'TELEGRAM_BOT_TOKEN=test-token\n');
  const telegramApiBase = server.url.replace('/webhook', '');
  const preloadPath = await writeTelegramFetchPreload(home, telegramApiBase);

  const result = await runDeliver({
    home,
    message: 'Legacy Telegram digest',
    preloadModules: [preloadPath],
    extraEnv: {
      FOLLOW_BUILDERS_TELEGRAM_API_BASE: telegramApiBase
    }
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].url, '/sendMessage');
  assert.equal(server.requests[0].body.chat_id, 'chat-123');
  assert.equal(server.requests[0].body.text, 'Legacy Telegram digest');
  assert.match(result.stdout, /"method":"telegram"/);
});

test('telegram chunk delay happens only between chunks', async t => {
  const home = await makeTempHome();
  t.after(() => rm(home, { recursive: true, force: true }));

  const server = await withJsonServer(({ res }) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, result: {} }));
  });
  t.after(() => server.close());

  await writeConfig(home, { delivery: { method: 'telegram', chatId: 'chat-123' } });
  await writeEnv(home, 'TELEGRAM_BOT_TOKEN=test-token\n');
  const telegramApiBase = server.url.replace('/webhook', '');
  const { preloadPath, delayCountPath } = await writeFastDelayPreload(home);

  const longMessage = `${'a'.repeat(3900)}\n${'b'.repeat(3900)}`;
  const result = await runDeliver({
    home,
    message: longMessage,
    preloadModules: [preloadPath],
    extraEnv: {
      FOLLOW_BUILDERS_TELEGRAM_API_BASE: telegramApiBase
    }
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(server.requests.length, 2);
  assert.equal(await readFile(delayCountPath, 'utf-8'), '1');
});

test('one target failure does not block later targets and exits non-zero', async t => {
  const home = await makeTempHome();
  t.after(() => rm(home, { recursive: true, force: true }));

  const server = await withJsonServer(({ res }) => {
    res.statusCode = 204;
    res.end();
  });
  t.after(() => server.close());

  await writeConfig(home, {
    delivery: {
      targets: [
        { method: 'discord' },
        { method: 'telegram', chatId: 'chat-123' }
      ]
    }
  });
  await writeEnv(home, 'TELEGRAM_BOT_TOKEN=test-token\n');
  const telegramApiBase = server.url.replace('/webhook', '');
  const preloadPath = await writeTelegramFetchPreload(home, telegramApiBase);

  const result = await runDeliver({
    home,
    message: 'Partial delivery digest',
    preloadModules: [preloadPath],
    extraEnv: { FOLLOW_BUILDERS_TELEGRAM_API_BASE: telegramApiBase }
  });

  assert.equal(result.status, 1);
  assert.equal(server.requests.length, 1);

  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, 'partial_error');
  assert.deepEqual(summary.results.map(item => item.method), ['discord', 'telegram']);
  assert.equal(summary.results[0].status, 'error');
  assert.match(summary.results[0].message, /DISCORD_WEBHOOK_URL not found/);
  assert.equal(summary.results[1].status, 'ok');
});

test('mixed stdout target returns JSON-only summary without printing digest', async t => {
  const home = await makeTempHome();
  t.after(() => rm(home, { recursive: true, force: true }));

  const server = await withJsonServer(({ res }) => {
    res.statusCode = 204;
    res.end();
  });
  t.after(() => server.close());

  await writeConfig(home, {
    delivery: {
      targets: [
        { method: 'stdout' },
        { method: 'discord' }
      ]
    }
  });
  await writeEnv(home, `DISCORD_WEBHOOK_URL=${server.url}\n`);

  const result = await runDeliver({ home, message: 'Mixed delivery digest' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(server.requests.length, 1);
  assert.doesNotMatch(result.stdout, /^Mixed delivery digest\n/);

  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, 'ok');
  assert.deepEqual(summary.results.map(item => item.method), ['stdout', 'discord']);
  assert.deepEqual(summary.results.map(item => item.status), ['ok', 'ok']);
  assert.equal(summary.results[0].message, 'Digest stdout output suppressed in multi-target mode');
});

test('unsupported target method returns error summary and exits non-zero', async t => {
  const home = await makeTempHome();
  t.after(() => rm(home, { recursive: true, force: true }));

  await writeConfig(home, { delivery: { targets: [{ method: 'discod' }] } });

  const result = await runDeliver({ home, message: 'Unsupported delivery digest' });

  assert.equal(result.status, 1);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, 'error');
  assert.deepEqual(summary.results, [{
    status: 'error',
    method: 'discod',
    message: 'Unsupported delivery method: discod'
  }]);
});

test('configured target with missing method returns error instead of default stdout', async t => {
  const home = await makeTempHome();
  t.after(() => rm(home, { recursive: true, force: true }));

  await writeConfig(home, { delivery: { targets: [{}] } });

  const result = await runDeliver({ home, message: 'Malformed delivery target' });

  assert.equal(result.status, 1);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, 'error');
  assert.equal(summary.results.length, 1);
  assert.equal(summary.results[0].status, 'error');
  assert.equal(summary.results[0].method, 'unknown');
  assert.match(summary.results[0].message, /Unsupported delivery method: missing method/);
});

test('null configured target returns JSON error instead of crashing', async t => {
  const home = await makeTempHome();
  t.after(() => rm(home, { recursive: true, force: true }));

  await writeConfig(home, { delivery: { targets: [null] } });

  const result = await runDeliver({ home, message: 'Null delivery target' });

  assert.equal(result.status, 1);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, 'error');
  assert.deepEqual(summary.results, [{
    status: 'error',
    method: 'unknown',
    message: 'Unsupported delivery target: expected object'
  }]);
});

test('stdout default still prints only the digest text', async t => {
  const home = await makeTempHome();
  t.after(() => rm(home, { recursive: true, force: true }));

  const result = await runDeliver({ home, message: 'Plain digest output' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, 'Plain digest output\n');
});
