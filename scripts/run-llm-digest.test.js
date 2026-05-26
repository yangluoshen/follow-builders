import { chmod, mkdtemp, rm, writeFile } from 'fs/promises';
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
writeFileSync(finalMessagePath, 'Digest delivered.');
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
  *"cd scripts && $EXPECTED_NODE_COMMAND deliver.js --file"*) ;;
  *)
    echo "prompt did not use expected Node path for deliver.js" >&2
    exit 43
    ;;
esac

case "$last" in
  *"cd scripts && node prepare-digest.js"*|*"cd scripts && node deliver.js"*)
    echo "prompt still uses bare node" >&2
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
printf 'Digest delivered.' > "$final_message_path"
`);

  const result = runDigestWithFakeCodex({
    codexPath: fakeCodex,
    home,
    extraEnv: { EXPECTED_NODE_COMMAND: shellQuote(process.execPath) }
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Fake digest from absolute Node prompt/);
});

test('delivers markdown when workbook update fails', async t => {
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
writeFileSync(itemsJsonMatch[1], JSON.stringify({
  runId: 'test-run',
  generatedAt: '2026-05-26T00:00:00.000Z',
  items: [],
  presentationHints: { weeklyThemes: [], highlightContentIds: [] }
}));
writeFileSync(finalMessagePath, 'Digest delivered.');
`);

  const result = runDigestWithFakeCodex({
    codexPath: fakeCodex,
    home,
    extraEnv: { FOLLOW_BUILDERS_UNIVER_UPDATE_PATH: '/definitely/missing/updater' }
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Digest survives workbook update failure/);
});
