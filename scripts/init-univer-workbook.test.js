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

async function writeFakeUniver(path, callsPath, options = {}) {
  const syncBody = options.syncBody || `echo '{"success":true,"status":{"unitID":"unit-test-1","uncommittedMutationCount":0}}'; exit 0`;
  const runBody = options.runBody || `echo '{"success":true,"sheets":["raw-data","runs","_week-template"]}'; exit 0`;
  const commitBody = options.commitBody || `echo '{"success":true,"committed":true}'; exit 0`;
  await writeExecutable(path, `#!/bin/sh
printf '%s\\n' "$*" >> "${callsPath}"
case "$1" in
  new)
    mkdir -p "$2"
    echo "new" > "$2/.fake-workbook-marker"
    exit 0
    ;;
  run)
    ${runBody}
    ;;
  inspect)
    echo "# workbook"
    exit 0
    ;;
  commit)
    ${commitBody}
    ;;
  sync)
    ${syncBody}
    ;;
  *)
    echo "unexpected $*" >&2
    exit 2
    ;;
esac
`);
}

async function writeFakeWorkbookPackage(path, markerText) {
  await mkdir(join(path, 'data'), { recursive: true });
  await writeFile(join(path, 'data', 'marker.txt'), markerText, 'utf-8');
}

test('initializes workbook from code scaffold and saves public URL', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fb-init-root-'));
  const home = await mkdtemp(join(tmpdir(), 'fb-init-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(home, { recursive: true, force: true }));

  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'scripts', 'univer-template-scaffold.js'), '() => ({ success: true })', 'utf-8');

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
  const config = JSON.parse(await readFile(join(home, '.follow-builders', 'config.json'), 'utf-8'));
  assert.equal(config.univer.enabled, true);
  assert.equal(config.univer.workbookPath, workbookPath);
  assert.equal(config.univer.unitId, 'unit-test-1');
  assert.equal(config.univer.publicUrl, 'https://univer.ai/space/sheets/unit-test-1');
  assert.deepEqual((await readFile(calls, 'utf-8')).trim().split('\n'), [
    `new ${workbookPath} --name Follow Builders`,
    `run ${workbookPath} --file ${join(root, 'scripts', 'univer-template-scaffold.js')}`,
    `inspect workbook ${workbookPath}`,
    `inspect range ${workbookPath} --range raw-data!A1:T1`,
    `inspect range ${workbookPath} --range runs!A1:M1`,
    `inspect range ${workbookPath} --range _week-template!A1:J7`,
    `commit ${workbookPath} --message Initialize follow-builders workbook --json`,
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

  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'scripts', 'univer-template-scaffold.js'), '() => ({ success: true })', 'utf-8');
  await mkdir(join(home, '.follow-builders'), { recursive: true });
  const workbookPath = join(home, '.follow-builders', 'follow-builders.univer');
  await writeFakeWorkbookPackage(workbookPath, 'original');

  const fakeUniver = join(root, 'fake-univer');
  await writeFakeUniver(fakeUniver, join(root, 'calls.log'), {
    syncBody: 'echo "sync failed" >&2; exit 9'
  });

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

test('restores existing workbook when forced commit returns unsuccessful JSON', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fb-init-root-'));
  const home = await mkdtemp(join(tmpdir(), 'fb-init-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(home, { recursive: true, force: true }));

  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'scripts', 'univer-template-scaffold.js'), '() => ({ success: true })', 'utf-8');
  await mkdir(join(home, '.follow-builders'), { recursive: true });
  const workbookPath = join(home, '.follow-builders', 'follow-builders.univer');
  await writeFakeWorkbookPackage(workbookPath, 'original');

  const fakeUniver = join(root, 'fake-univer');
  await writeFakeUniver(fakeUniver, join(root, 'calls.log'), {
    commitBody: `echo '{"success":false,"committed":false,"error":"commit rejected"}'; exit 0`
  });

  const result = spawnSync(process.execPath, [
    INIT,
    '--skill-dir', root,
    '--home', home,
    '--univer-path', fakeUniver,
    '--force'
  ], { encoding: 'utf-8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /commit rejected/);
  assert.equal(await readFile(join(workbookPath, 'data', 'marker.txt'), 'utf-8'), 'original');
});

test('rejects unsuccessful sync JSON even when a unit id is present', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fb-init-root-'));
  const home = await mkdtemp(join(tmpdir(), 'fb-init-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(home, { recursive: true, force: true }));

  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'scripts', 'univer-template-scaffold.js'), '() => ({ success: true })', 'utf-8');

  const fakeUniver = join(root, 'fake-univer');
  await writeFakeUniver(
    fakeUniver,
    join(root, 'calls.log'),
    {
      syncBody: `echo '{"success":false,"unitId":"unit-bad","error":"sync rejected"}'; exit 0`
    }
  );

  const result = spawnSync(process.execPath, [
    INIT,
    '--skill-dir', root,
    '--home', home,
    '--univer-path', fakeUniver
  ], { encoding: 'utf-8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /univer sync failed: sync rejected/);
  assert.equal(await pathExists(join(home, '.follow-builders', 'config.json')), false);
});

test('uses existing workbook without running scaffold when force is not set', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fb-init-root-'));
  const home = await mkdtemp(join(tmpdir(), 'fb-init-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(home, { recursive: true, force: true }));

  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'scripts', 'univer-template-scaffold.js'), '() => ({ success: true })', 'utf-8');
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

test('restores existing workbook when forced scaffold fails after overwrite', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fb-init-root-'));
  const home = await mkdtemp(join(tmpdir(), 'fb-init-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(home, { recursive: true, force: true }));

  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'scripts', 'univer-template-scaffold.js'), '() => ({ success: false })', 'utf-8');
  await mkdir(join(home, '.follow-builders'), { recursive: true });
  const workbookPath = join(home, '.follow-builders', 'follow-builders.univer');
  await writeFakeWorkbookPackage(workbookPath, 'original');

  const fakeUniver = join(root, 'fake-univer');
  await writeFakeUniver(fakeUniver, join(root, 'calls.log'), {
    runBody: `echo '{"success":false,"error":"scaffold rejected"}'; exit 0`
  });

  const result = spawnSync(process.execPath, [
    INIT,
    '--skill-dir', root,
    '--home', home,
    '--univer-path', fakeUniver,
    '--force'
  ], { encoding: 'utf-8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /scaffold rejected/);
  assert.equal(await readFile(join(workbookPath, 'data', 'marker.txt'), 'utf-8'), 'original');
});

test('restores existing workbook when forced scaffold outputs malformed JSON', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fb-init-root-'));
  const home = await mkdtemp(join(tmpdir(), 'fb-init-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(home, { recursive: true, force: true }));

  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'scripts', 'univer-template-scaffold.js'), '() => ({ success: true })', 'utf-8');
  await mkdir(join(home, '.follow-builders'), { recursive: true });
  const workbookPath = join(home, '.follow-builders', 'follow-builders.univer');
  await writeFakeWorkbookPackage(workbookPath, 'original');

  const fakeUniver = join(root, 'fake-univer');
  await writeFakeUniver(fakeUniver, join(root, 'calls.log'), {
    runBody: 'echo "not-json"; exit 0'
  });

  const result = spawnSync(process.execPath, [
    INIT,
    '--skill-dir', root,
    '--home', home,
    '--univer-path', fakeUniver,
    '--force'
  ], { encoding: 'utf-8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /Could not parse univer run JSON output/);
  assert.equal(await readFile(join(workbookPath, 'data', 'marker.txt'), 'utf-8'), 'original');
});
