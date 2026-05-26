import { chmod, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  configPath,
  defaultUserDir,
  readConfigFile,
  updateConfigFile,
  userWorkbookPath
} from './lib/follow-builders-config.js';
import { runUniver } from './lib/univer-command.js';

async function writeExecutable(path, text) {
  await writeFile(path, text, 'utf-8');
  await chmod(path, 0o755);
}

test('config helpers use the provided home directory', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fb-config-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  assert.equal(defaultUserDir(home), join(home, '.follow-builders'));
  assert.equal(configPath(home), join(home, '.follow-builders', 'config.json'));
  assert.equal(userWorkbookPath(home), join(home, '.follow-builders', 'follow-builders.univer'));

  await updateConfigFile(home, current => ({
    ...current,
    language: 'en',
    univer: { enabled: true, unitId: 'unit-1' }
  }));
  const saved = JSON.parse(await readFile(configPath(home), 'utf-8'));
  assert.equal(saved.univer.unitId, 'unit-1');
  assert.equal((await readConfigFile(home)).language, 'en');
});

test('runUniver returns stdout for successful commands', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fb-univer-bin-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = join(dir, 'univer');
  await writeExecutable(fake, '#!/bin/sh\nprintf "ok:$*"\n');

  const result = await runUniver(['inspect', 'workbook', './book.univer'], { univerPath: fake });
  assert.equal(result.stdout, 'ok:inspect workbook ./book.univer');
});

test('runUniver throws with stderr on failure', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fb-univer-bin-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = join(dir, 'univer');
  await writeExecutable(fake, '#!/bin/sh\necho "bad command" >&2\nexit 9\n');

  await assert.rejects(
    () => runUniver(['sync', './book.univer'], { univerPath: fake }),
    /univer sync .* failed with exit code 9: bad command/
  );
});
