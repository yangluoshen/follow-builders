import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

const SCRIPT_DIR = new URL('.', import.meta.url).pathname;
const INIT = join(SCRIPT_DIR, 'init-univer-workbook.js');

async function writeExecutable(path, text) {
  await writeFile(path, text, 'utf-8');
  await chmod(path, 0o755);
}

test('initializes workbook from template and saves public URL', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fb-init-root-'));
  const home = await mkdtemp(join(tmpdir(), 'fb-init-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(home, { recursive: true, force: true }));

  await mkdir(join(root, 'templates'), { recursive: true });
  await writeFile(join(root, 'templates', 'follow-builders.univer'), 'template', 'utf-8');

  const fakeUniver = join(root, 'fake-univer');
  await writeExecutable(fakeUniver, `#!/bin/sh
case "$1 $2" in
  "inspect workbook") echo "# workbook"; exit 0 ;;
  "sync "*) echo '{"success":true,"unitId":"unit-test-1"}'; exit 0 ;;
  *) echo "unexpected $*" >&2; exit 2 ;;
esac
`);

  const result = spawnSync(process.execPath, [
    INIT,
    '--skill-dir', root,
    '--home', home,
    '--univer-path', fakeUniver
  ], { encoding: 'utf-8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const config = JSON.parse(await readFile(join(home, '.follow-builders', 'config.json'), 'utf-8'));
  assert.equal(config.univer.unitId, 'unit-test-1');
  assert.equal(config.univer.publicUrl, 'https://univer.ai/space/sheets/unit-test-1');
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
