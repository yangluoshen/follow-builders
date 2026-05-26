#!/usr/bin/env node

// ============================================================================
// Follow Builders - LLM Cron Digest Runner
// ============================================================================
// Runs the digest preparation workflow through a non-interactive Codex agent,
// then handles workbook side effects and delivery in this wrapper.
//
// Usage:
//   node run-llm-digest.js --agent codex
//
// The wrapper owns cron-safe process execution, logs, workbook side effects,
// and delivery. Codex owns only the content remix artifact preparation.
// ============================================================================

import { spawn } from 'child_process';
import { access, appendFile, mkdir, readFile, writeFile } from 'fs/promises';
import { constants } from 'fs';
import { delimiter, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { appendWorkbookUrl, validateItemsPayload } from './lib/univer-workbook-contract.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = join(SCRIPT_DIR, '..');
const USER_DIR = join(homedir(), '.follow-builders');
const CONFIG_PATH = join(USER_DIR, 'config.json');
const LOG_DIR = join(USER_DIR, 'logs');

function usage() {
  return `Usage: node run-llm-digest.js [--agent codex] [--codex-path /path/to/codex]

Options:
  --agent          Agent runtime to use. Only "codex" is supported.
  --codex-path     Absolute path to the codex executable. Can also be set with
                   FOLLOW_BUILDERS_CODEX_PATH or CODEX_BIN.
  --codex-sandbox  Codex sandbox mode: workspace-write or danger-full-access.
                   Defaults to config cron.codexSandbox or workspace-write.
  --help           Show this help text.
`;
}

function parseArgs(argv) {
  const parsed = {
    agent: null,
    codexPath: process.env.FOLLOW_BUILDERS_CODEX_PATH || process.env.CODEX_BIN || null,
    codexSandbox: process.env.FOLLOW_BUILDERS_CODEX_SANDBOX || null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }

    if (arg === '--agent') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) {
        throw new Error('--agent requires a value');
      }
      parsed.agent = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith('--agent=')) {
      parsed.agent = arg.slice('--agent='.length);
      continue;
    }

    if (arg === '--codex-path') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) {
        throw new Error('--codex-path requires a value');
      }
      parsed.codexPath = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith('--codex-path=')) {
      parsed.codexPath = arg.slice('--codex-path='.length);
      continue;
    }

    if (arg === '--codex-sandbox') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) {
        throw new Error('--codex-sandbox requires a value');
      }
      parsed.codexSandbox = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith('--codex-sandbox=')) {
      parsed.codexSandbox = arg.slice('--codex-sandbox='.length);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

async function readConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`Could not read config: ${err.message}`);
  }
}

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

async function isExecutable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findOnPath(command) {
  const paths = (process.env.PATH || '').split(delimiter).filter(Boolean);
  for (const dir of paths) {
    const candidate = join(dir, command);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

async function resolveCodexPath(configuredPath) {
  if (configuredPath) {
    if (!(await isExecutable(configuredPath))) {
      throw new Error(`Codex executable is not available or not executable: ${configuredPath}`);
    }
    return configuredPath;
  }

  const onPath = await findOnPath('codex');
  if (onPath) return onPath;

  throw new Error(
    'Could not find codex on PATH. Set FOLLOW_BUILDERS_CODEX_PATH or pass --codex-path.'
  );
}

async function assertScriptDependencies() {
  const dotenvPath = join(SCRIPT_DIR, 'node_modules', 'dotenv', 'package.json');
  try {
    await access(dotenvPath, constants.R_OK);
  } catch {
    throw new Error(
      'Missing scripts dependencies. Run "cd scripts && npm install" before using LLM cron.'
    );
  }
}

function redact(text, config = {}) {
  if (!text) return text;

  let output = text;
  const delivery = config.delivery || {};
  const knownSecrets = [
    process.env.TELEGRAM_BOT_TOKEN,
    process.env.RESEND_API_KEY,
    delivery.chatId,
    delivery.email
  ].filter(Boolean);

  for (const secret of knownSecrets) {
    output = output.split(String(secret)).join('[redacted]');
  }

  output = output.replace(/\b\d{7,}:[A-Za-z0-9_-]{20,}\b/g, '[redacted:telegram-token]');
  output = output.replace(/\bre_[A-Za-z0-9_-]{16,}\b/g, '[redacted:resend-key]');

  return output;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function prependPathEntry(entry, pathValue = '') {
  const existingEntries = String(pathValue).split(delimiter).filter(Boolean);
  const dedupedEntries = existingEntries.filter(existing => existing !== entry);
  return [entry, ...dedupedEntries].join(delimiter);
}

function buildChildEnv(baseEnv = process.env, nodePath = process.execPath) {
  const nodeBinDir = dirname(nodePath);
  return {
    ...baseEnv,
    PATH: prependPathEntry(nodeBinDir, baseEnv.PATH || '')
  };
}

function buildPrompt(digestPath, itemsJsonPath, nodePath = process.execPath) {
  const nodeCommand = shellQuote(nodePath);

  return `Run the Follow Builders digest workflow for a non-interactive cron job.

Workflow:
1. From the repository root, run: cd scripts && ${nodeCommand} prepare-digest.js
2. Parse the JSON output from prepare-digest.js. Use only that JSON as source material.
3. If stats.podcastEpisodes, stats.xBuilders, and stats.blogPosts are all 0, write this exact digest text to ${digestPath}: No new updates from your builders today. Check back tomorrow!
4. Otherwise, remix the content into a concise, human-readable digest:
   - Follow prompts.digest_intro, prompts.summarize_podcast, prompts.summarize_tweets, prompts.summarize_blogs, and prompts.translate from the JSON.
   - Respect config.language exactly: en, zh, or bilingual.
   - Include original source URLs for every summarized item.
   - Do not include feed JSON, transcripts, prompt text, stats, implementation notes, or tool traces in the digest.
   - Do not browse the web, visit URLs, search, or call APIs other than the local scripts named here.
   - Do not invent content. If a content item has no URL, omit it.
5. Write only the final digest markdown text to ${digestPath}.
6. Write the structured workbook items JSON to ${itemsJsonPath}.
   Use this exact top-level JSON shape:
   {
     "runId": "<stable run id or generatedAt timestamp>",
     "generatedAt": "<ISO timestamp>",
     "items": [
       {
         "contentId": "x:<tweet id> | podcast:<guid> | blog:<stable url hash if known>",
         "sourceType": "x | podcast | blog",
         "sourceName": "<X, podcast name, or blog name>",
         "authorName": "<builder or author name>",
         "authorHandle": "<X handle if any>",
         "title": "<human-readable title>",
         "url": "<source URL>",
         "publishedAt": "<ISO timestamp or empty string>",
         "capturedAt": "<ISO timestamp>",
         "runDate": "<YYYY-MM-DD>",
         "textExcerpt": "<short excerpt, not full transcript>",
         "summary": "<AI summary>",
         "keyPoints": ["<point>"],
         "topics": ["<topic>"],
         "importanceScore": 0,
         "likes": 0,
         "retweets": 0,
         "replies": 0,
         "rawSourceKey": "<tweet id, podcast guid, or blog URL>"
       }
     ],
     "presentationHints": { "weeklyThemes": [], "highlightContentIds": [] }
   }

Constraints:
- Do not install packages, run npm install, run npm ci, edit repository files, or change user config.
- Delivery is handled by the wrapper.
- Do not run deliver.js, Telegram/email delivery, or any delivery command/API.
- Only run prepare-digest.js, write the digest markdown file, write the workbook items JSON file, and return status.
- If any required command fails, do not try to repair the environment. Reply with "Digest failed: <short reason>".

Final response requirements:
- Reply with a one-line status only, such as "Digest prepared." or "Digest failed: <short reason>".
- Do not paste the digest, raw JSON, transcripts, secrets, chat IDs, or logs in the final response.`;
}

function resolveCodexSandbox(value) {
  const sandbox = value || 'workspace-write';
  const supported = new Set(['workspace-write', 'danger-full-access']);
  if (!supported.has(sandbox)) {
    throw new Error(
      `Unsupported Codex sandbox: ${sandbox}. Use workspace-write or danger-full-access.`
    );
  }
  return sandbox;
}

function buildCodexArgs({
  digestPath,
  itemsJsonPath,
  finalMessagePath,
  codexConfigProfile,
  codexSandbox
}) {
  const args = [
    '--ask-for-approval',
    'never',
    'exec',
    '--cd',
    SKILL_DIR,
    '--skip-git-repo-check',
    '--ephemeral',
    '--sandbox',
    codexSandbox,
    '--add-dir',
    USER_DIR,
    '--output-last-message',
    finalMessagePath,
    '--color',
    'never'
  ];

  if (codexConfigProfile) {
    args.push('--profile', codexConfigProfile);
  }

  args.push(buildPrompt(digestPath, itemsJsonPath));
  return args;
}

async function runCodex({
  codexPath,
  args,
  config,
  logPath,
  digestPath,
  itemsJsonPath,
  finalMessagePath,
  codexSandbox
}) {
  const startedAt = new Date();
  const child = spawn(codexPath, args, {
    cwd: SKILL_DIR,
    env: buildChildEnv(),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const stdout = [];
  const stderr = [];

  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));

  const result = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });

  const finishedAt = new Date();
  const log = [
    `Follow Builders LLM cron run`,
    `startedAt=${startedAt.toISOString()}`,
    `finishedAt=${finishedAt.toISOString()}`,
    `codexPath=${codexPath}`,
    `codexSandbox=${codexSandbox}`,
    `digestPath=${digestPath}`,
    `itemsJsonPath=${itemsJsonPath}`,
    `finalMessagePath=${finalMessagePath}`,
    `exitCode=${result.code}`,
    `signal=${result.signal || ''}`,
    '',
    '--- stdout ---',
    Buffer.concat(stdout).toString('utf-8'),
    '',
    '--- stderr ---',
    Buffer.concat(stderr).toString('utf-8'),
    ''
  ].join('\n');

  await writeFile(logPath, redact(log, config), 'utf-8');

  if (result.code !== 0) {
    throw new Error(`Codex failed with exit code ${result.code}. See ${logPath}`);
  }
}

async function assertDigestFile(path) {
  let text;
  try {
    text = await readFile(path, 'utf-8');
  } catch (err) {
    throw new Error(`Codex did not create the digest file: ${err.message}`);
  }

  if (!text.trim()) {
    throw new Error('Codex created an empty digest file');
  }

  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    throw new Error('Digest file appears to contain JSON instead of a human-readable digest');
  }
}

function isWorkbookItemsOnlyFailure(message) {
  return /\b(workbook|univer|items?\s+json|workbook items)\b/i.test(message) &&
    !/\b(prepare-digest|prepare digest|markdown|digest file|digest markdown|digest text)\b/i.test(message);
}

async function assertFinalMessage(path, { config = {}, logPath = null } = {}) {
  let text = '';
  try {
    text = await readFile(path, 'utf-8');
  } catch {
    return;
  }

  if (/^\s*digest failed\b/i.test(text)) {
    const message = text.trim();
    if (isWorkbookItemsOnlyFailure(message)) {
      if (logPath) {
        await appendFile(logPath, `workbookUpdateError=${redact(message, config)}\n`, 'utf-8')
          .catch(() => {});
      }
      return;
    }
    throw new Error(message);
  }
}

async function assertItemsJsonFile(path) {
  let text;
  try {
    text = await readFile(path, 'utf-8');
  } catch (err) {
    throw new Error(`Codex did not create the workbook items JSON file: ${err.message}`);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    throw new Error(`Codex created invalid workbook items JSON: ${err.message}`);
  }

  if (!payload || !Array.isArray(payload.items)) {
    throw new Error('Workbook items JSON must contain a top-level items array');
  }

  validateItemsPayload(payload);
  return payload;
}

async function runWorkbookUpdate({ config, digestPath, itemsJsonPath, logPath }) {
  if (config.univer?.enabled === false || !config.univer?.workbookPath) {
    await appendFile(
      logPath,
      '\n--- workbook update ---\nskipped=univer workbook not configured\n',
      'utf-8'
    );
    return;
  }

  const startedAt = new Date();
  const updaterPath = process.env.FOLLOW_BUILDERS_UNIVER_UPDATE_PATH ||
    join(SCRIPT_DIR, 'update-univer-workbook.js');
  const args = [
    updaterPath,
    '--items-json',
    itemsJsonPath,
    '--markdown-path',
    digestPath
  ];
  const child = spawn(process.execPath, args, {
    cwd: SKILL_DIR,
    env: buildChildEnv(),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const stdout = [];
  const stderr = [];

  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));

  const result = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  const finishedAt = new Date();
  const log = [
    '',
    '--- workbook update ---',
    `startedAt=${startedAt.toISOString()}`,
    `finishedAt=${finishedAt.toISOString()}`,
    `updaterPath=${updaterPath}`,
    `itemsJsonPath=${itemsJsonPath}`,
    `digestPath=${digestPath}`,
    `exitCode=${result.code}`,
    `signal=${result.signal || ''}`,
    '',
    '--- workbook stdout ---',
    Buffer.concat(stdout).toString('utf-8'),
    '',
    '--- workbook stderr ---',
    Buffer.concat(stderr).toString('utf-8'),
    ''
  ].join('\n');

  await appendFile(logPath, redact(log, config), 'utf-8');

  if (result.code !== 0) {
    if (result.signal) {
      throw new Error(`Workbook update failed with signal ${result.signal}. See ${logPath}`);
    }
    throw new Error(`Workbook update failed with exit code ${result.code}. See ${logPath}`);
  }
}

async function runWorkbookSideEffects({ config, digestPath, itemsJsonPath, logPath }) {
  await assertItemsJsonFile(itemsJsonPath);
  await runWorkbookUpdate({ config, digestPath, itemsJsonPath, logPath });
}

async function runDelivery({ config, digestPath, logPath }) {
  if ((config.delivery?.method || 'stdout') === 'stdout') {
    console.log(await readFile(digestPath, 'utf-8'));
    return;
  }

  const startedAt = new Date();
  const deliverPath = process.env.FOLLOW_BUILDERS_DELIVER_PATH || join(SCRIPT_DIR, 'deliver.js');
  const child = spawn(process.execPath, [deliverPath, '--file', digestPath], {
    cwd: SKILL_DIR,
    env: buildChildEnv(),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const stdout = [];
  const stderr = [];

  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));

  const result = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  const finishedAt = new Date();
  const log = [
    '',
    '--- delivery ---',
    `startedAt=${startedAt.toISOString()}`,
    `finishedAt=${finishedAt.toISOString()}`,
    `deliverPath=${deliverPath}`,
    `digestPath=${digestPath}`,
    `exitCode=${result.code}`,
    `signal=${result.signal || ''}`,
    '',
    '--- delivery stdout ---',
    Buffer.concat(stdout).toString('utf-8'),
    '',
    '--- delivery stderr ---',
    Buffer.concat(stderr).toString('utf-8'),
    ''
  ].join('\n');

  await appendFile(logPath, redact(log, config), 'utf-8');

  if (result.signal) {
    throw new Error(`Delivery failed with signal ${result.signal}. See ${logPath}`);
  }
  if (result.code !== 0) {
    throw new Error(`Delivery failed with exit code ${result.code}. See ${logPath}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  await mkdir(LOG_DIR, { recursive: true });

  const runId = timestampSlug();
  const digestPath = join(LOG_DIR, `llm-digest-${runId}.md`);
  const itemsJsonPath = join(LOG_DIR, `llm-digest-${runId}.items.json`);
  const finalMessagePath = join(LOG_DIR, `llm-digest-${runId}.final.txt`);
  const logPath = join(LOG_DIR, `llm-digest-${runId}.log`);
  let config = {};

  try {
    config = await readConfig();
    const agent = args.agent || config.cron?.agent || 'codex';
    if (agent !== 'codex') {
      throw new Error(`Unsupported LLM cron agent: ${agent}. Only "codex" is supported.`);
    }
    await assertScriptDependencies();

    const codexSandbox = resolveCodexSandbox(args.codexSandbox || config.cron?.codexSandbox);
    const codexArgs = buildCodexArgs({
      digestPath,
      itemsJsonPath,
      finalMessagePath,
      codexConfigProfile: config.cron?.codexProfile,
      codexSandbox
    });

    await writeFile(
      logPath,
      [
        `Follow Builders LLM cron run`,
        `startedAt=${new Date().toISOString()}`,
        `agent=codex`,
        `digestPath=${digestPath}`,
        `itemsJsonPath=${itemsJsonPath}`,
        `finalMessagePath=${finalMessagePath}`,
        ''
      ].join('\n'),
      'utf-8'
    );

    const codexPath = await resolveCodexPath(args.codexPath);
    await appendFile(
      logPath,
      [
        `codexPath=${codexPath}`,
        `codexSandbox=${codexSandbox}`,
        `command=${codexPath} ${codexArgs.slice(0, -1).join(' ')} [prompt omitted]`,
        ''
      ].join('\n'),
      'utf-8'
    );

    await runCodex({
      codexPath,
      args: codexArgs,
      config,
      logPath,
      digestPath,
      itemsJsonPath,
      finalMessagePath,
      codexSandbox
    });
    await assertDigestFile(digestPath);
    await assertFinalMessage(finalMessagePath, { config, logPath });
    await runWorkbookSideEffects({ config, digestPath, itemsJsonPath, logPath }).catch(async err => {
      const lines = [
        `workbookUpdateError=${redact(err.stack || err.message, config)}`
      ];
      if (config.univer?.publicUrl) {
        lines.push('workbookUpdateWarning=remote workbook may not include latest data; appended public URL may be stale');
      }
      await appendFile(logPath, `${lines.join('\n')}\n`, 'utf-8');
    });

    if (config.univer?.publicUrl) {
      const digest = await readFile(digestPath, 'utf-8');
      const digestWithWorkbookUrl = appendWorkbookUrl(digest, config.univer.publicUrl);
      if (digestWithWorkbookUrl !== digest) {
        await writeFile(digestPath, digestWithWorkbookUrl, 'utf-8');
      }
    }

    await runDelivery({ config, digestPath, logPath });
    if ((config.delivery?.method || 'stdout') === 'stdout') {
      return;
    }

    console.log(JSON.stringify({
      status: 'ok',
      agent: 'codex',
      message: 'LLM digest workflow completed',
      digestFile: digestPath,
      log: logPath
    }));
  } catch (err) {
    await appendFile(
      logPath,
      `error=${redact(err.stack || err.message, config)}\n`,
      'utf-8'
    ).catch(() => {});

    if (!err.message.includes(logPath)) {
      err.message = `${err.message}. See ${logPath}`;
    }
    throw err;
  }
}

main().catch(err => {
  console.log(JSON.stringify({
    status: 'error',
    agent: 'codex',
    message: err.message
  }));
  process.exit(1);
});
