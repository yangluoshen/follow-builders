import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { constants } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import test from 'node:test';
import assert from 'node:assert/strict';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const INIT = join(SCRIPT_DIR, 'init-univer-workbook.js');

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

async function writeFakeUniver(path, callsPath, syncBody = `echo '{"success":true,"status":{"unitID":"unit-test-1"}}'; exit 0`) {
  await writeExecutable(path, `#!/bin/sh
printf '%s\\n' "$*" >> "${callsPath}"
case "$1 $2" in
  "inspect workbook") echo "# workbook"; exit 0 ;;
  "sync "*) ${syncBody} ;;
  *) echo "unexpected $*" >&2; exit 2 ;;
esac
`);
}

async function writeFakeWorkbookPackage(path, markerText) {
  await mkdir(join(path, 'data'), { recursive: true });
  await writeFile(join(path, 'data', 'marker.txt'), markerText, 'utf-8');
}

test('initializes workbook from template and saves public URL', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fb-init-root-'));
  const home = await mkdtemp(join(tmpdir(), 'fb-init-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(home, { recursive: true, force: true }));

  await mkdir(join(root, 'templates'), { recursive: true });
  await writeFakeWorkbookPackage(join(root, 'templates', 'follow-builders.univer'), 'template');

  const fakeUniver = join(root, 'fake-univer');
  const calls = join(root, 'calls.log');
  await writeFakeUniver(fakeUniver, calls);

  const result = spawnSync(process.execPath, [
    INIT,
    '--skill-dir', root,
    '--home', home,
    '--univer-path', fakeUniver
  ], { encoding: 'utf-8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const workbookPath = join(home, '.follow-builders', 'follow-builders.univer');
  assert.equal(await readFile(join(workbookPath, 'data', 'marker.txt'), 'utf-8'), 'template');
  const config = JSON.parse(await readFile(join(home, '.follow-builders', 'config.json'), 'utf-8'));
  assert.equal(config.univer.unitId, 'unit-test-1');
  assert.equal(config.univer.publicUrl, 'https://univer.ai/space/sheets/unit-test-1');
  assert.deepEqual((await readFile(calls, 'utf-8')).trim().split('\n'), [
    `inspect workbook ${workbookPath}`,
    `sync ${workbookPath} --json`
  ]);
});

test('does not overwrite an existing remote binding when workbook is missing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fb-init-root-'));
  const home = await mkdtemp(join(tmpdir(), 'fb-init-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(home, { recursive: true, force: true }));

  await mkdir(join(home, '.follow-builders'), { recursive: true });
  await writeFile(join(home, '.follow-builders', 'config.json'), JSON.stringify({
    univer: { unitId: 'existing', publicUrl: 'https://univer.ai/space/sheets/existing' }
  }), 'utf-8');

  const result = spawnSync(process.execPath, [
    INIT,
    '--skill-dir', root,
    '--home', home
  ], { encoding: 'utf-8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /workbook is missing but config already has a Univer unitId/);
});

test('rejects option flags without values before using default home', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fb-init-root-'));
  const guardHome = await mkdtemp(join(tmpdir(), 'fb-init-guard-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(guardHome, { recursive: true, force: true }));

  await mkdir(join(root, 'templates'), { recursive: true });
  await writeFakeWorkbookPackage(join(root, 'templates', 'follow-builders.univer'), 'template');

  const fakeUniver = join(root, 'fake-univer');
  await writeFakeUniver(fakeUniver, join(root, 'calls.log'));

  const result = spawnSync(process.execPath, [
    INIT,
    '--skill-dir', root,
    '--univer-path', fakeUniver,
    '--home'
  ], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: guardHome }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /--home requires a value/);
  assert.equal(await pathExists(join(guardHome, '.follow-builders')), false);
});

test('restores existing workbook when forced sync fails after overwrite', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fb-init-root-'));
  const home = await mkdtemp(join(tmpdir(), 'fb-init-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(home, { recursive: true, force: true }));

  await mkdir(join(root, 'templates'), { recursive: true });
  await writeFakeWorkbookPackage(join(root, 'templates', 'follow-builders.univer'), 'replacement');
  await mkdir(join(home, '.follow-builders'), { recursive: true });
  const workbookPath = join(home, '.follow-builders', 'follow-builders.univer');
  await writeFakeWorkbookPackage(workbookPath, 'original');

  const fakeUniver = join(root, 'fake-univer');
  await writeFakeUniver(fakeUniver, join(root, 'calls.log'), 'echo "sync failed" >&2; exit 9');

  const result = spawnSync(process.execPath, [
    INIT,
    '--skill-dir', root,
    '--home', home,
    '--univer-path', fakeUniver,
    '--force'
  ], { encoding: 'utf-8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /sync failed/);
  assert.equal(await readFile(join(workbookPath, 'data', 'marker.txt'), 'utf-8'), 'original');
});

test('uses existing workbook without recopying when force is not set', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fb-init-root-'));
  const home = await mkdtemp(join(tmpdir(), 'fb-init-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(home, { recursive: true, force: true }));

  await mkdir(join(root, 'templates'), { recursive: true });
  await writeFakeWorkbookPackage(join(root, 'templates', 'follow-builders.univer'), 'template');
  await mkdir(join(home, '.follow-builders'), { recursive: true });
  const workbookPath = join(home, '.follow-builders', 'follow-builders.univer');
  await writeFakeWorkbookPackage(workbookPath, 'existing');

  const fakeUniver = join(root, 'fake-univer');
  const calls = join(root, 'calls.log');
  await writeFakeUniver(fakeUniver, calls);

  const result = spawnSync(process.execPath, [
    INIT,
    '--skill-dir', root,
    '--home', home,
    '--univer-path', fakeUniver
  ], { encoding: 'utf-8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(await readFile(join(workbookPath, 'data', 'marker.txt'), 'utf-8'), 'existing');
  assert.deepEqual((await readFile(calls, 'utf-8')).trim().split('\n'), [
    `inspect workbook ${workbookPath}`,
    `sync ${workbookPath} --json`
  ]);
});
