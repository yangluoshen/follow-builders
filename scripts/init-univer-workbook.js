#!/usr/bin/env node

import { access, cp, mkdir, mkdtemp, rm } from 'fs/promises';
import { constants } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { homedir, tmpdir } from 'os';
import { readConfigFile, updateConfigFile, userWorkbookPath } from './lib/follow-builders-config.js';
import { publicUrlForUnit, WORKBOOK_SCAFFOLD_SCRIPT_PATH } from './lib/univer-workbook-contract.js';
import { runUniver, runUniverJson } from './lib/univer-command.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SKILL_DIR = join(SCRIPT_DIR, '..');

function readOptionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function parseArgs(argv) {
  const out = {
    skillDir: DEFAULT_SKILL_DIR,
    home: homedir(),
    univerPath: process.env.FOLLOW_BUILDERS_UNIVER_PATH || 'univer',
    force: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--skill-dir') {
      out.skillDir = readOptionValue(argv, i, arg);
      i += 1;
    } else if (arg === '--home') {
      out.home = readOptionValue(argv, i, arg);
      i += 1;
    } else if (arg === '--univer-path') {
      out.univerPath = readOptionValue(argv, i, arg);
      i += 1;
    } else if (arg === '--force') out.force = true;
    else if (arg === '--help') out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function extractUnitId(syncResult) {
  return syncResult.unitId || syncResult.unitID || syncResult.remoteUnitId || syncResult.status?.unitId || syncResult.status?.unitID;
}

function assertSyncSucceeded(syncResult) {
  if (syncResult?.success === false) {
    throw new Error(`univer sync failed: ${syncResult.error || JSON.stringify(syncResult)}`);
  }
}

function parseJsonOutput(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch (err) {
    throw new Error(`Could not parse ${label} JSON output: ${err.message}`);
  }
}

function assertScaffoldSucceeded(scaffoldResult) {
  if (scaffoldResult?.success !== true) {
    throw new Error(`univer scaffold failed: ${scaffoldResult?.error || JSON.stringify(scaffoldResult)}`);
  }
}

async function cleanupBackup(backupDir) {
  if (backupDir) await rm(backupDir, { recursive: true, force: true });
}

async function removePath(path) {
  await rm(path, { recursive: true, force: true });
}

async function replacePath(source, destination) {
  await rm(destination, { recursive: true, force: true });
  await cp(source, destination, { recursive: true });
}

async function backupExistingWorkbook(workbookPath) {
  const backupDir = await mkdtemp(join(tmpdir(), 'follow-builders-univer-backup-'));
  const backupPath = join(backupDir, 'follow-builders.univer');
  await replacePath(workbookPath, backupPath);
  return { backupDir, backupPath };
}

async function createScaffoldedWorkbook({ workbookPath, scaffoldPath, univerPath }) {
  await mkdir(dirname(workbookPath), { recursive: true });
  await runUniver(['new', workbookPath], { univerPath });
  const scaffoldOutput = await runUniver(['run', workbookPath, '--file', scaffoldPath], { univerPath });
  assertScaffoldSucceeded(parseJsonOutput(scaffoldOutput.stdout, 'univer run'));
  await runUniver(['inspect', 'workbook', workbookPath], { univerPath });
  await runUniver(['inspect', 'range', workbookPath, '--range', 'raw-data!A1:T1'], { univerPath });
  await runUniver(['inspect', 'range', workbookPath, '--range', 'runs!A1:M1'], { univerPath });
  await runUniver(['inspect', 'range', workbookPath, '--range', '_week-template!A1:J12'], { univerPath });
  const commitResult = await runUniverJson(
    ['commit', workbookPath, '--message', 'Initialize follow-builders workbook'],
    { univerPath }
  );
  if (commitResult.success === false || commitResult.committed === false) {
    throw new Error(`univer commit failed: ${JSON.stringify(commitResult)}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node init-univer-workbook.js [--skill-dir PATH] [--home PATH] [--univer-path PATH] [--force]');
    return;
  }

  const workbookPath = userWorkbookPath(args.home);
  const config = await readConfigFile(args.home);
  const hasWorkbook = await exists(workbookPath);
  if (!hasWorkbook && config.univer?.unitId && !args.force) {
    throw new Error('Univer workbook is missing but config already has a Univer unitId. Use an explicit reset or migration flow.');
  }

  const scaffoldPath = join(args.skillDir, WORKBOOK_SCAFFOLD_SCRIPT_PATH);
  let backupDir;
  let backupPath;
  let shouldRestoreBackup = false;
  if (hasWorkbook && args.force) {
    const backup = await backupExistingWorkbook(workbookPath);
    backupDir = backup.backupDir;
    backupPath = backup.backupPath;
  }

  try {
    if (!hasWorkbook || args.force) {
      shouldRestoreBackup = Boolean(backupPath);
      await removePath(workbookPath);
      await createScaffoldedWorkbook({
        workbookPath,
        scaffoldPath,
        univerPath: args.univerPath
      });
    } else {
      await runUniver(['inspect', 'workbook', workbookPath], { univerPath: args.univerPath });
    }

    const syncResult = await runUniverJson(['sync', workbookPath], { univerPath: args.univerPath });
    assertSyncSucceeded(syncResult);
    const unitId = extractUnitId(syncResult);
    if (!unitId) {
      throw new Error(`univer sync did not return a unitId: ${JSON.stringify(syncResult)}`);
    }
    const publicUrl = publicUrlForUnit(unitId);

    const next = await updateConfigFile(args.home, current => ({
      ...current,
      univer: {
        ...(current.univer || {}),
        enabled: true,
        workbookPath,
        unitId,
        publicUrl
      }
    }));

    await cleanupBackup(backupDir);
    console.log(JSON.stringify({ status: 'ok', workbookPath, unitId, publicUrl, config: next.univer }, null, 2));
  } catch (err) {
    if (shouldRestoreBackup) {
      try {
        await replacePath(backupPath, workbookPath);
      } catch (restoreErr) {
        err.message = `${err.message}; additionally failed to restore workbook backup: ${restoreErr.message}`;
      }
    } else if (!hasWorkbook) {
      await removePath(workbookPath);
    }
    await cleanupBackup(backupDir);
    throw err;
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
