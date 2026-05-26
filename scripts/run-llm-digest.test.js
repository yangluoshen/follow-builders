import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

const SCRIPT_DIR = new URL('.', import.meta.url).pathname;
const RUNNER = join(SCRIPT_DIR, 'run-llm-digest.js');
const CLEAN_PATH = '/usr/bin:/bin';

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function makeTempHome() {
  return mkdtemp(join(tmpdir(), 'follow-builders-test-home-'));
}

function runDigestWithFakeCodex({ codexPath, home, extraEnv = {} }) {
  return spawnSync(
    process.execPath,
    [RUNNER, '--agent', 'codex', '--codex-path', codexPath],
    {
      cwd: join(SCRIPT_DIR, '..'),
      env: {
        ...process.env,
        ...extraEnv,
        HOME: home,
        PATH: CLEAN_PATH
      },
      encoding: 'utf-8'
    }
  );
}

async function writeExecutable(path, text) {
  await writeFile(path, text, 'utf-8');
  await chmod(path, 0o755);
}

async function writeConfig(home, config) {
  const userDir = join(home, '.follow-builders');
  await mkdir(userDir, { recursive: true });
  await writeFile(join(userDir, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
}

async function readRunLog(home) {
  const logDir = join(home, '.follow-builders', 'logs');
  const [logFile] = (await readdir(logDir)).filter(file => file.endsWith('.log'));
  return readFile(join(logDir, logFile), 'utf-8');
}

test('starts a Codex npm-style shim when cron PATH does not include Node', async t => {
  const home = await makeTempHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const fakeCodex = join(home, 'fake-codex.js');

  await writeExecutable(fakeCodex, `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');

const args = process.argv.slice(2);
let finalMessagePath = null;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--output-last-message') finalMessagePath = args[i + 1];
}

const prompt = args.at(-1);
const digestMatch = prompt.match(/^5\\. Write only the final digest markdown text to (.*)\\.$/m);
const itemsJsonMatch = prompt.match(/^6\\. Write the structured workbook items JSON to (.*)\\.$/m);
if (!digestMatch || !itemsJsonMatch) {
  console.error('Could not find digest and items JSON paths in prompt');
  process.exit(2);
}

writeFileSync(digestMatch[1], 'Fake digest from cron-safe Codex shim');
writeFileSync(itemsJsonMatch[1], JSON.stringify({
  runId: 'test-run',
  generatedAt: '2026-05-26T00:00:00.000Z',
  items: [],
  presentationHints: { weeklyThemes: [], highlightContentIds: [] }
}));
writeFileSync(finalMessagePath, 'Digest prepared.');
`);

  const result = runDigestWithFakeCodex({ codexPath: fakeCodex, home });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Fake digest from cron-safe Codex shim/);
});

test('asks Codex to run local scripts through the current Node executable', async t => {
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
  *"cd scripts && $EXPECTED_NODE_COMMAND prepare-digest.js"*) ;;
  *)
    echo "prompt did not use expected Node path for prepare-digest.js" >&2
    exit 42
    ;;
esac

case "$last" in
  *"deliver.js"*)
    echo "prompt should not run deliver.js" >&2
    exit 43
    ;;
  *)
    ;;
esac

case "$last" in
  *"cd scripts && node prepare-digest.js"*)
    echo "prompt still uses bare node for prepare-digest.js" >&2
    exit 44
    ;;
esac

digest_path="$(printf '%s\\n' "$last" | sed -n 's/^5\\. Write only the final digest markdown text to \\(.*\\)\\.$/\\1/p')"
items_json_path="$(printf '%s\\n' "$last" | sed -n 's/^6\\. Write the structured workbook items JSON to \\(.*\\)\\.$/\\1/p')"
if [ -z "$digest_path" ] || [ -z "$items_json_path" ]; then
  echo "prompt did not include digest and items JSON output paths" >&2
  exit 45
fi

printf 'Fake digest from absolute Node prompt' > "$digest_path"
printf '{"runId":"test-run","generatedAt":"2026-05-26T00:00:00.000Z","items":[],"presentationHints":{"weeklyThemes":[],"highlightContentIds":[]}}' > "$items_json_path"
printf 'Digest prepared.' > "$final_message_path"
`);

  const result = runDigestWithFakeCodex({
    codexPath: fakeCodex,
    home,
    extraEnv: { EXPECTED_NODE_COMMAND: shellQuote(process.execPath) }
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Fake digest from absolute Node prompt/);
});

test('missing items JSON does not block markdown stdout delivery', async t => {
  const home = await makeTempHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const fakeCodex = join(home, 'fake-codex.js');

  await writeExecutable(fakeCodex, `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');

const args = process.argv.slice(2);
let finalMessagePath = null;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--output-last-message') finalMessagePath = args[i + 1];
}

const prompt = args.at(-1);
const digestMatch = prompt.match(/^5\\. Write only the final digest markdown text to (.*)\\.$/m);
const itemsJsonMatch = prompt.match(/^6\\. Write the structured workbook items JSON to (.*)\\.$/m);
if (!digestMatch || !itemsJsonMatch) {
  console.error('Could not find digest and items JSON paths in prompt');
  process.exit(2);
}

writeFileSync(digestMatch[1], 'Digest survives workbook update failure');
writeFileSync(finalMessagePath, 'Digest prepared.');
`);

  const result = runDigestWithFakeCodex({
    codexPath: fakeCodex,
    home
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Digest survives workbook update failure/);
  const log = await readRunLog(home);
  assert.match(log, /workbookUpdateError=.*Codex did not create the workbook items JSON file/s);
});

test('malformed items JSON does not block markdown stdout delivery', async t => {
  const home = await makeTempHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const fakeCodex = join(home, 'fake-codex.js');

  await writeExecutable(fakeCodex, `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');

const args = process.argv.slice(2);
let finalMessagePath = null;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--output-last-message') finalMessagePath = args[i + 1];
}

const prompt = args.at(-1);
const digestMatch = prompt.match(/^5\\. Write only the final digest markdown text to (.*)\\.$/m);
const itemsJsonMatch = prompt.match(/^6\\. Write the structured workbook items JSON to (.*)\\.$/m);
if (!digestMatch || !itemsJsonMatch) {
  console.error('Could not find digest and items JSON paths in prompt');
  process.exit(2);
}

writeFileSync(digestMatch[1], 'Digest survives malformed workbook items');
writeFileSync(itemsJsonMatch[1], JSON.stringify({
  runId: 'test-run',
  generatedAt: '2026-05-26T00:00:00.000Z',
  items: [{ sourceType: 'x', title: 'missing required fields' }],
  presentationHints: { weeklyThemes: [], highlightContentIds: [] }
}));
writeFileSync(finalMessagePath, 'Digest prepared.');
`);

  const result = runDigestWithFakeCodex({ codexPath: fakeCodex, home });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Digest survives malformed workbook items/);
  const log = await readRunLog(home);
  assert.match(log, /workbookUpdateError=.*items\[0\]\.contentId is required/s);
});

test('configured workbook updater is invoked and does not block markdown delivery on failure', async t => {
  const home = await makeTempHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const fakeCodex = join(home, 'fake-codex.js');
  const fakeUpdater = join(home, 'fake-updater.js');
  const updaterCalls = join(home, 'updater-calls.txt');

  await writeConfig(home, {
    delivery: { method: 'stdout' },
    univer: {
      enabled: true,
      workbookPath: join(home, '.follow-builders', 'follow-builders.univer')
    }
  });

  await writeExecutable(fakeCodex, `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');

const args = process.argv.slice(2);
let finalMessagePath = null;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--output-last-message') finalMessagePath = args[i + 1];
}

const prompt = args.at(-1);
const digestMatch = prompt.match(/^5\\. Write only the final digest markdown text to (.*)\\.$/m);
const itemsJsonMatch = prompt.match(/^6\\. Write the structured workbook items JSON to (.*)\\.$/m);
if (!digestMatch || !itemsJsonMatch) {
  console.error('Could not find digest and items JSON paths in prompt');
  process.exit(2);
}

writeFileSync(digestMatch[1], 'Digest survives failing configured updater');
writeFileSync(itemsJsonMatch[1], JSON.stringify({
  runId: 'test-run',
  generatedAt: '2026-05-26T00:00:00.000Z',
  items: [],
  presentationHints: { weeklyThemes: [], highlightContentIds: [] }
}));
writeFileSync(finalMessagePath, 'Digest prepared.');
`);

  await writeExecutable(fakeUpdater, `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
appendFileSync(process.env.UPDATER_CALLS_PATH, process.argv.slice(2).join(' ') + '\\n');
process.exit(9);
`);

  const result = runDigestWithFakeCodex({
    codexPath: fakeCodex,
    home,
    extraEnv: {
      FOLLOW_BUILDERS_UNIVER_UPDATE_PATH: fakeUpdater,
      UPDATER_CALLS_PATH: updaterCalls
    }
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Digest survives failing configured updater/);
  const calls = await readFile(updaterCalls, 'utf-8');
  assert.match(calls, /--items-json .* --markdown-path /);
});

test('public workbook URL is appended before non-stdout delivery', async t => {
  const home = await makeTempHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const fakeCodex = join(home, 'fake-codex.js');
  const fakeDeliver = join(home, 'fake-deliver.js');
  const deliveredText = join(home, 'delivered.txt');
  const publicUrl = 'https://univer.ai/space/sheets/unit-test-1';

  await writeConfig(home, {
    delivery: { method: 'telegram', chatId: 'chat' },
    univer: { publicUrl }
  });

  await writeExecutable(fakeCodex, `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');

const args = process.argv.slice(2);
let finalMessagePath = null;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--output-last-message') finalMessagePath = args[i + 1];
}

const prompt = args.at(-1);
const digestMatch = prompt.match(/^5\\. Write only the final digest markdown text to (.*)\\.$/m);
const itemsJsonMatch = prompt.match(/^6\\. Write the structured workbook items JSON to (.*)\\.$/m);
if (!digestMatch || !itemsJsonMatch) {
  console.error('Could not find digest and items JSON paths in prompt');
  process.exit(2);
}

writeFileSync(digestMatch[1], 'Digest for Telegram delivery');
writeFileSync(itemsJsonMatch[1], JSON.stringify({
  runId: 'test-run',
  generatedAt: '2026-05-26T00:00:00.000Z',
  items: [],
  presentationHints: { weeklyThemes: [], highlightContentIds: [] }
}));
writeFileSync(finalMessagePath, 'Digest prepared.');
`);

  await writeExecutable(fakeDeliver, `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require('node:fs');
const fileArgIndex = process.argv.indexOf('--file');
if (fileArgIndex === -1) process.exit(3);
writeFileSync(process.env.DELIVERED_TEXT_PATH, readFileSync(process.argv[fileArgIndex + 1], 'utf-8'));
`);

  const result = runDigestWithFakeCodex({
    codexPath: fakeCodex,
    home,
    extraEnv: {
      FOLLOW_BUILDERS_DELIVER_PATH: fakeDeliver,
      DELIVERED_TEXT_PATH: deliveredText
    }
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const text = await readFile(deliveredText, 'utf-8');
  assert.match(text, /Digest for Telegram delivery/);
  assert.match(text, new RegExp(`Univer workbook: ${publicUrl}`));
});
