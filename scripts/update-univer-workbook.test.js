import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { constants } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import test from 'node:test';
import assert from 'node:assert/strict';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const UPDATE = join(SCRIPT_DIR, 'update-univer-workbook.js');

async function writeExecutable(path, text) {
  await writeFile(path, text, 'utf-8');
  await chmod(path, 0o755);
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function writeConfig(home, workbookPath, extraUniver = {}) {
  await mkdir(join(home, '.follow-builders'), { recursive: true });
  await writeFile(join(home, '.follow-builders', 'config.json'), JSON.stringify({
    univer: {
      enabled: true,
      workbookPath,
      unitId: 'unit-test-1',
      publicUrl: 'https://univer.ai/space/sheets/unit-test-1',
      ...extraUniver
    }
  }), 'utf-8');
}

async function writeFakeUniver(path, callsPath) {
  await writeExecutable(path, `#!/bin/sh
printf '%s\\n' "$*" >> "${callsPath}"
case "$1 $2" in
  "inspect workbook") echo "# workbook"; exit 0 ;;
  "inspect range") echo "| contentId |"; exit 0 ;;
  "run "*) echo '{"success":true,"inserted":2,"updated":0,"weeklyRows":2,"weekSheetName":"2026-W22"}'; exit 0 ;;
  "sync "*) echo '{"success":true,"status":{"unitID":"unit-test-1"}}'; exit 0 ;;
  *) echo "unexpected $*" >&2; exit 2 ;;
esac
`);
}

function validItemsPayload() {
  return {
    runId: 'run-1',
    generatedAt: '2026-05-26T08:00:00.000Z',
    items: [
      {
        contentId: 'x:1',
        sourceType: 'x',
        sourceName: 'X',
        title: 'Agent update',
        url: 'https://x.com/a/status/1',
        publishedAt: '2026-05-26T07:00:00.000Z',
        capturedAt: '2026-05-26T08:00:00.000Z',
        runDate: '2026-05-26',
        summary: 'A short update.',
        keyPoints: ['one'],
        topics: ['agents'],
        importanceScore: 88
      },
      {
        contentId: 'podcast:1',
        sourceType: 'podcast',
        sourceName: 'Latent Space',
        title: 'Podcast update',
        url: 'https://example.com/podcast/1',
        publishedAt: '2026-05-26T06:00:00.000Z',
        capturedAt: '2026-05-26T08:00:00.000Z',
        runDate: '2026-05-26',
        summary: 'A podcast note.',
        keyPoints: ['two'],
        topics: ['research'],
        importanceScore: 72
      }
    ]
  };
}

test('updates configured workbook and syncs it', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fb-update-home-'));
  const root = await mkdtemp(join(tmpdir(), 'fb-update-root-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(root, { recursive: true, force: true }));

  const workbookPath = join(home, '.follow-builders', 'follow-builders.univer');
  await writeConfig(home, workbookPath);
  await writeFile(workbookPath, 'workbook', 'utf-8');

  const itemsPath = join(root, 'items.json');
  const markdownPath = join(root, 'digest.md');
  await writeFile(itemsPath, JSON.stringify(validItemsPayload()), 'utf-8');
  await writeFile(markdownPath, 'digest', 'utf-8');

  const fakeUniver = join(root, 'fake-univer');
  const calls = join(root, 'calls.log');
  await writeFakeUniver(fakeUniver, calls);

  const result = spawnSync(process.execPath, [
    UPDATE,
    '--home', home,
    '--items-json', itemsPath,
    '--markdown-path', markdownPath,
    '--univer-path', fakeUniver
  ], { encoding: 'utf-8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const status = JSON.parse(result.stdout);
  assert.equal(status.status, 'ok');
  assert.equal(status.workbookPath, workbookPath);
  assert.equal(status.weekSheetName, '2026-W22');
  assert.equal(status.publicUrl, 'https://univer.ai/space/sheets/unit-test-1');
  assert.deepEqual(status.runResult, {
    success: true,
    inserted: 2,
    updated: 0,
    weeklyRows: 2,
    weekSheetName: '2026-W22'
  });

  const loggedCalls = (await readFile(calls, 'utf-8')).trim().split('\n');
  assert.equal(loggedCalls[0], `inspect workbook ${workbookPath}`);
  assert.match(loggedCalls[1], new RegExp(`^run ${workbookPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} --file .+update-workbook\\.js$`));
  assert.equal(loggedCalls[2], `inspect range ${workbookPath} --range raw-data!A1:T5`);
  assert.equal(loggedCalls[3], `sync ${workbookPath} --json`);
});

test('malformed items JSON exits non-zero with validation message', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fb-update-home-'));
  const root = await mkdtemp(join(tmpdir(), 'fb-update-root-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(root, { recursive: true, force: true }));

  const workbookPath = join(home, '.follow-builders', 'follow-builders.univer');
  await writeConfig(home, workbookPath);
  await writeFile(workbookPath, 'workbook', 'utf-8');

  const itemsPath = join(root, 'items.json');
  await writeFile(itemsPath, JSON.stringify({
    items: [{ sourceType: 'x', title: 'Missing content id', url: 'https://x.com/a/status/1' }]
  }), 'utf-8');

  const fakeUniver = join(root, 'fake-univer');
  await writeFakeUniver(fakeUniver, join(root, 'calls.log'));

  const result = spawnSync(process.execPath, [
    UPDATE,
    '--home', home,
    '--items-json', itemsPath,
    '--univer-path', fakeUniver
  ], { encoding: 'utf-8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /contentId is required/);
});

test('rejects option flags without values before home side effects', async t => {
  const guardHome = await mkdtemp(join(tmpdir(), 'fb-update-guard-home-'));
  const root = await mkdtemp(join(tmpdir(), 'fb-update-root-'));
  t.after(() => rm(guardHome, { recursive: true, force: true }));
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [
    UPDATE,
    '--home',
    '--items-json', join(root, 'items.json')
  ], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: guardHome }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /--home requires a value/);
  assert.equal(await pathExists(join(guardHome, '.follow-builders')), false);
});
