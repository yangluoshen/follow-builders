import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

export function defaultUserDir(home = homedir()) {
  return join(home, '.follow-builders');
}

export function configPath(home = homedir()) {
  return join(defaultUserDir(home), 'config.json');
}

export function userWorkbookPath(home = homedir()) {
  return join(defaultUserDir(home), 'follow-builders.univer');
}

export async function readConfigFile(home = homedir()) {
  try {
    return JSON.parse(await readFile(configPath(home), 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`Could not read config: ${err.message}`);
  }
}

export async function writeConfigFile(config, home = homedir()) {
  await mkdir(defaultUserDir(home), { recursive: true });
  await writeFile(configPath(home), `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

export async function updateConfigFile(home, updater) {
  const current = await readConfigFile(home);
  const next = await updater(current);
  await writeConfigFile(next, home);
  return next;
}
