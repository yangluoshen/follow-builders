#!/usr/bin/env node

import { access, copyFile, mkdir, mkdtemp, rm } from 'fs/promises';
import { constants } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { homedir, tmpdir } from 'os';
import { readConfigFile, updateConfigFile, userWorkbookPath } from './lib/follow-builders-config.js';
import { publicUrlForUnit, WORKBOOK_TEMPLATE_PATH } from './lib/univer-workbook-contract.js';
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

async function cleanupBackup(backupDir) {
  if (backupDir) await rm(backupDir, { recursive: true, force: true });
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

  let backupDir;
  let backupPath;
  let shouldRestoreBackup = false;
  if (hasWorkbook && args.force) {
    backupDir = await mkdtemp(join(tmpdir(), 'follow-builders-univer-backup-'));
    backupPath = join(backupDir, 'follow-builders.univer');
    await copyFile(workbookPath, backupPath);
  }

  try {
    if (!hasWorkbook || args.force) {
      const templatePath = join(args.skillDir, WORKBOOK_TEMPLATE_PATH);
      await mkdir(dirname(workbookPath), { recursive: true });
      shouldRestoreBackup = Boolean(backupPath);
      await copyFile(templatePath, workbookPath);
    }

    await runUniver(['inspect', 'workbook', workbookPath], { univerPath: args.univerPath });
    const syncResult = await runUniverJson(['sync', workbookPath], { univerPath: args.univerPath });
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
        await copyFile(backupPath, workbookPath);
      } catch (restoreErr) {
        err.message = `${err.message}; additionally failed to restore workbook backup: ${restoreErr.message}`;
      }
    }
    await cleanupBackup(backupDir);
    throw err;
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
