# Discord Multi-Channel Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Discord webhook delivery and allow one digest run to deliver independently to multiple configured targets.

**Architecture:** Keep `scripts/deliver.js` as the single delivery entrypoint. Add small delivery helpers in that file, normalize legacy and new config into a target list, then send each target independently and summarize results. Update onboarding/docs so users are guided by the agent to create a Discord webhook and never need to hand-edit config.

**Tech Stack:** Node.js ESM, built-in `node:test`, built-in `node:http`, `dotenv`, JSON Schema, Markdown docs.

---

## File Structure

- Modify `scripts/deliver.js`: add `splitMessage`, `normalizeDeliveryTargets`, `sendDiscord`, per-target dispatch, and result aggregation.
- Create `scripts/deliver.test.js`: isolated CLI tests using temporary `HOME`, fake local HTTP servers, and child processes.
- Modify `config/config-schema.json`: add `discord` and `delivery.targets` while preserving legacy delivery fields.
- Modify `scripts/run-llm-digest.js`: update prompt text and stdout shortcut so multi-target non-stdout delivery uses `deliver.js`.
- Modify `scripts/run-llm-digest.test.js`: update assertions for generalized delivery wording and add coverage for `delivery.targets`.
- Modify `SKILL.md`: add Discord webhook onboarding, multi-channel config handling, and settings-change commands.
- Modify `README.md` and `README.zh-CN.md`: document agent-led Discord setup and multi-channel delivery.

## Task 1: Add Delivery CLI Tests for Discord and Multi-Target Behavior

**Files:**
- Create: `scripts/deliver.test.js`
- Read: `scripts/deliver.js`

- [ ] **Step 1: Create failing tests**

Create `scripts/deliver.test.js` with this content:

```js
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { createServer } from 'http';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

const SCRIPT_DIR = new URL('.', import.meta.url).pathname;
const DELIVER = join(SCRIPT_DIR, 'deliver.js');
const CLEAN_PATH = '/usr/bin:/bin';

async function makeTempHome() {
  return mkdtemp(join(tmpdir(), 'follow-builders-deliver-test-home-'));
}

async function writeUserFile(home, relativePath, text) {
  const userDir = join(home, '.follow-builders');
  await mkdir(userDir, { recursive: true });
  await writeFile(join(userDir, relativePath), text, 'utf-8');
}

async function writeConfig(home, config) {
  await writeUserFile(home, 'config.json', `${JSON.stringify(config, null, 2)}\n`);
}

async function writeEnv(home, text) {
  await writeUserFile(home, '.env', text);
}

function runDeliver({ home, message = 'Digest body', extraEnv = {} }) {
  return spawnSync(
    process.execPath,
    [DELIVER, '--message', message],
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

async function withJsonServer(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf-8');
      const body = bodyText ? JSON.parse(bodyText) : null;
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler({ req, res, body, requests });
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/webhook`,
    requests,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

test('discord target posts markdown content with mentions disabled', async t => {
  const home = await makeTempHome();
  t.after(() => rm(home, { recursive: true, force: true }));

  const server = await withJsonServer(({ res }) => {
    res.statusCode = 204;
    res.end();
  });
  t.after(() => server.close());

  await writeConfig(home, { delivery: { targets: [{ method: 'discord' }] } });
  await writeEnv(home, `DISCORD_WEBHOOK_URL=${server.url}\n`);

  const result = runDeliver({ home, message: '# Digest\nHello @everyone' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].method, 'POST');
  assert.deepEqual(server.requests[0].body, {
    content: '# Digest\nHello @everyone',
    allowed_mentions: { parse: [] }
  });
  assert.match(result.stdout, /"method":"discord"/);
  assert.match(result.stdout, /"status":"ok"/);
});

test('discord target splits long markdown into multiple webhook posts', async t => {
  const home = await makeTempHome();
  t.after(() => rm(home, { recursive: true, force: true }));

  const server = await withJsonServer(({ res }) => {
    res.statusCode = 204;
    res.end();
  });
  t.after(() => server.close());

  await writeConfig(home, { delivery: { targets: [{ method: 'discord' }] } });
  await writeEnv(home, `DISCORD_WEBHOOK_URL=${server.url}\n`);

  const longMessage = `${'a'.repeat(1800)}\n${'b'.repeat(1800)}\n${'c'.repeat(1800)}`;
  const result = runDeliver({ home, message: longMessage });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(server.requests.length, 3);
  for (const request of server.requests) {
    assert.ok(request.body.content.length <= 1900);
    assert.deepEqual(request.body.allowed_mentions, { parse: [] });
  }
});

test('legacy telegram delivery still works', async t => {
  const home = await makeTempHome();
  t.after(() => rm(home, { recursive: true, force: true }));

  const server = await withJsonServer(({ res }) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, result: {} }));
  });
  t.after(() => server.close());

  await writeConfig(home, { delivery: { method: 'telegram', chatId: 'chat-123' } });
  await writeEnv(home, 'TELEGRAM_BOT_TOKEN=test-token\n');

  const result = runDeliver({
    home,
    message: 'Legacy Telegram digest',
    extraEnv: { FOLLOW_BUILDERS_TELEGRAM_API_BASE: server.url.replace('/webhook', '') }
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].body.chat_id, 'chat-123');
  assert.equal(server.requests[0].body.text, 'Legacy Telegram digest');
  assert.match(result.stdout, /"method":"telegram"/);
});

test('one target failure does not block later targets and exits non-zero', async t => {
  const home = await makeTempHome();
  t.after(() => rm(home, { recursive: true, force: true }));

  const server = await withJsonServer(({ res }) => {
    res.statusCode = 204;
    res.end();
  });
  t.after(() => server.close());

  await writeConfig(home, {
    delivery: {
      targets: [
        { method: 'discord' },
        { method: 'telegram', chatId: 'chat-123' }
      ]
    }
  });
  await writeEnv(home, 'TELEGRAM_BOT_TOKEN=test-token\n');

  const result = runDeliver({
    home,
    message: 'Partial delivery digest',
    extraEnv: { FOLLOW_BUILDERS_TELEGRAM_API_BASE: server.url.replace('/webhook', '') }
  });

  assert.equal(result.status, 1);
  assert.equal(server.requests.length, 1);

  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, 'partial_error');
  assert.deepEqual(summary.results.map(item => item.method), ['discord', 'telegram']);
  assert.equal(summary.results[0].status, 'error');
  assert.match(summary.results[0].message, /DISCORD_WEBHOOK_URL not found/);
  assert.equal(summary.results[1].status, 'ok');
});

test('stdout default still prints only the digest text', async t => {
  const home = await makeTempHome();
  t.after(() => rm(home, { recursive: true, force: true }));

  const result = runDeliver({ home, message: 'Plain digest output' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, 'Plain digest output\n');
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
cd scripts && npm test -- deliver.test.js
```

Expected:

- FAIL because `scripts/deliver.js` does not yet support `delivery.targets`.
- FAIL because `discord` is not implemented.
- The stdout default test should pass.

- [ ] **Step 3: Commit failing tests**

```bash
git add scripts/deliver.test.js
git commit -m "test: cover discord multi-channel delivery"
```

## Task 2: Implement Discord and Multi-Target Delivery

**Files:**
- Modify: `scripts/deliver.js`
- Test: `scripts/deliver.test.js`

- [ ] **Step 1: Replace the delivery implementation**

In `scripts/deliver.js`, make these focused changes:

- Update the header comments to include Discord and multi-target delivery.
- Add `sleep`, `splitMessage`, `normalizeDeliveryTargets`, `readErrorBody`, `sendDiscord`, and `sendTarget`.
- Update Telegram to use `splitMessage` and a configurable API base for tests.
- Replace the single `switch (delivery.method)` in `main()` with per-target iteration and summary output.

Use this implementation shape:

```js
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function splitMessage(text, maxLen) {
  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen * 0.5) splitAt = maxLen;

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
    if (remaining.startsWith('\n')) remaining = remaining.slice(1);
  }

  return chunks;
}

function normalizeDeliveryTargets(delivery) {
  if (Array.isArray(delivery?.targets) && delivery.targets.length > 0) {
    return delivery.targets;
  }
  if (delivery?.method) return [delivery];
  return [{ method: 'stdout' }];
}

async function readErrorBody(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}
```

Update Telegram:

```js
async function sendTelegram(text, botToken, chatId) {
  const chunks = splitMessage(text, 4000);
  const apiBase = process.env.FOLLOW_BUILDERS_TELEGRAM_API_BASE || `https://api.telegram.org/bot${botToken}`;

  for (const chunk of chunks) {
    const res = await fetch(
      `${apiBase}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        })
      }
    );

    if (!res.ok) {
      const err = await readErrorBody(res);
      if (err.description && err.description.includes("can't parse")) {
        const retry = await fetch(
          `${apiBase}/sendMessage`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: chunk,
              disable_web_page_preview: true
            })
          }
        );
        if (!retry.ok) {
          const retryErr = await readErrorBody(retry);
          throw new Error(`Telegram API error: ${retryErr.description || retryErr.message || JSON.stringify(retryErr)}`);
        }
      } else {
        throw new Error(`Telegram API error: ${err.description || err.message || JSON.stringify(err)}`);
      }
    }

    if (chunks.length > 1) await sleep(500);
  }
}
```

Add Discord:

```js
async function sendDiscord(text, webhookUrl) {
  const chunks = splitMessage(text, 1900);

  for (const chunk of chunks) {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: chunk,
        allowed_mentions: { parse: [] }
      })
    });

    if (!res.ok) {
      const err = await readErrorBody(res);
      throw new Error(`Discord webhook error: ${err.message || err.description || JSON.stringify(err)}`);
    }

    if (chunks.length > 1) await sleep(500);
  }
}
```

Add target dispatch:

```js
async function sendTarget(target, digestText) {
  switch (target.method) {
    case 'telegram': {
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = target.chatId;
      if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN not found in .env');
      if (!chatId) throw new Error('delivery.chatId not found in config.json');
      await sendTelegram(digestText, botToken, chatId);
      return { method: 'telegram', status: 'ok', message: 'Digest sent to Telegram' };
    }

    case 'discord': {
      const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
      if (!webhookUrl) throw new Error('DISCORD_WEBHOOK_URL not found in .env');
      await sendDiscord(digestText, webhookUrl);
      return { method: 'discord', status: 'ok', message: 'Digest sent to Discord' };
    }

    case 'email': {
      const apiKey = process.env.RESEND_API_KEY;
      const toEmail = target.email;
      if (!apiKey) throw new Error('RESEND_API_KEY not found in .env');
      if (!toEmail) throw new Error('delivery.email not found in config.json');
      await sendEmail(digestText, apiKey, toEmail);
      return { method: 'email', status: 'ok', message: `Digest sent to ${toEmail}` };
    }

    case 'stdout':
    default:
      console.log(digestText);
      return { method: 'stdout', status: 'ok', message: 'Digest printed to stdout' };
  }
}
```

Update `main()` result handling:

```js
const delivery = config.delivery || { method: 'stdout' };
const targets = normalizeDeliveryTargets(delivery);
const digestText = await getDigestText();

if (!digestText || digestText.trim().length === 0) {
  console.log(JSON.stringify({ status: 'skipped', reason: 'Empty digest text' }));
  return;
}

const singleStdout = targets.length === 1 && (targets[0].method || 'stdout') === 'stdout';
const results = [];

for (const target of targets) {
  try {
    results.push(await sendTarget(target, digestText));
  } catch (err) {
    results.push({
      method: target.method || 'stdout',
      status: 'error',
      message: err.message
    });
  }
}

if (singleStdout) return;

const failures = results.filter(result => result.status === 'error');
console.log(JSON.stringify({
  status: failures.length === 0 ? 'ok' : failures.length === results.length ? 'error' : 'partial_error',
  results
}));

if (failures.length > 0) process.exit(1);
```

- [ ] **Step 2: Run delivery tests**

Run:

```bash
cd scripts && npm test -- deliver.test.js
```

Expected: all `deliver.test.js` tests PASS.

- [ ] **Step 3: Run all script tests**

Run:

```bash
cd scripts && npm test
```

Expected: existing tests may fail only on wording or stdout shortcut assumptions that Task 4 will address. `deliver.test.js` should remain PASS.

- [ ] **Step 4: Commit implementation**

```bash
git add scripts/deliver.js scripts/deliver.test.js
git commit -m "feat: add discord multi-channel delivery"
```

## Task 3: Update Config Schema for Discord Targets

**Files:**
- Modify: `config/config-schema.json`
- Test: `scripts/deliver.test.js`

- [ ] **Step 1: Update schema**

In `config/config-schema.json`, update `delivery.properties.method.enum` to:

```json
["stdout", "telegram", "discord", "email"]
```

Update its description to:

```json
"Delivery method: stdout (terminal/agent), telegram (bot message), discord (webhook), email (via Resend)"
```

Add `targets` under `delivery.properties`:

```json
"targets": {
  "type": "array",
  "description": "Optional multi-channel delivery targets. When present, targets overrides legacy delivery.method.",
  "items": {
    "type": "object",
    "properties": {
      "method": {
        "type": "string",
        "enum": ["stdout", "telegram", "discord", "email"],
        "description": "Delivery target method"
      },
      "chatId": {
        "type": "string",
        "description": "Telegram chat ID (only for telegram method)"
      },
      "email": {
        "type": "string",
        "description": "Email address to send digest to (only for email method)"
      }
    },
    "required": ["method"]
  }
}
```

- [ ] **Step 2: Add schema validation smoke test**

Append this test to `scripts/deliver.test.js`:

```js
test('config schema allows discord and delivery targets', async () => {
  const schemaPath = join(SCRIPT_DIR, '..', 'config', 'config-schema.json');
  const schema = JSON.parse(await readFile(schemaPath, 'utf-8'));

  assert.ok(schema.properties.delivery.properties.method.enum.includes('discord'));
  assert.ok(schema.properties.delivery.properties.targets);
  assert.deepEqual(
    schema.properties.delivery.properties.targets.items.properties.method.enum,
    ['stdout', 'telegram', 'discord', 'email']
  );
});
```

- [ ] **Step 3: Run tests**

Run:

```bash
cd scripts && npm test -- deliver.test.js
```

Expected: PASS.

- [ ] **Step 4: Commit schema update**

```bash
git add config/config-schema.json scripts/deliver.test.js
git commit -m "feat: add delivery targets schema"
```

## Task 4: Update LLM Cron Runner for Multi-Target Config

**Files:**
- Modify: `scripts/run-llm-digest.js`
- Modify: `scripts/run-llm-digest.test.js`

- [ ] **Step 1: Write failing runner tests**

In `scripts/run-llm-digest.test.js`, update the prompt assertion currently matching:

```sh
*"Delivery is handled by the wrapper."*"Do not run deliver.js, Telegram/email delivery, or any delivery command/API."*"Only run prepare-digest.js, write the digest markdown file, write the workbook items JSON file, and return status."*) ;;
```

to expect:

```sh
*"Delivery is handled by the wrapper."*"Do not run deliver.js, configured delivery, or any delivery command/API."*"Only run prepare-digest.js, write the digest markdown file, write the workbook items JSON file, and return status."*) ;;
```

Then append this test:

```js
test('delivery targets use deliver wrapper instead of stdout shortcut', async t => {
  const home = await makeTempHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const fakeCodex = join(home, 'fake-codex.js');
  const fakeDeliver = join(home, 'fake-deliver.js');
  const deliveredText = join(home, 'delivered-targets.txt');

  await writeConfig(home, {
    cron: { agent: 'codex' },
    delivery: {
      targets: [
        { method: 'discord' },
        { method: 'telegram', chatId: 'chat' }
      ]
    },
    univer: { enabled: false }
  });

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
writeFileSync(digestMatch[1], 'Digest for delivery targets');
writeFileSync(itemsJsonMatch[1], JSON.stringify({
  runId: 'test-run',
  generatedAt: '2026-05-26T00:00:00.000Z',
  items: [],
  presentationHints: { weeklyThemes: [], highlightContentIds: [] }
}));
writeFileSync(finalMessagePath, 'Digest prepared.');
`);

  await writeExecutable(fakeDeliver, `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require('node:fs');
const fileArgIndex = process.argv.indexOf('--file');
writeFileSync(process.env.DELIVERED_TEXT_PATH, readFileSync(process.argv[fileArgIndex + 1], 'utf-8'));
console.log(JSON.stringify({ status: 'ok', results: [{ method: 'discord', status: 'ok' }] }));
`);

  const result = runDigestWithFakeCodex({
    codexPath: fakeCodex,
    home,
    extraEnv: {
      FOLLOW_BUILDERS_DELIVER_PATH: fakeDeliver,
      DELIVERED_TEXT_PATH: deliveredText
    }
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const text = await readFile(deliveredText, 'utf-8');
  assert.match(text, /Digest for delivery targets/);
});
```

- [ ] **Step 2: Run the targeted runner tests and verify failure**

Run:

```bash
cd scripts && node --test run-llm-digest.test.js
```

Expected:

- The updated prompt assertion fails until `run-llm-digest.js` wording changes.
- The new delivery targets test fails because `runDelivery()` treats missing legacy `delivery.method` as `stdout`.

- [ ] **Step 3: Update runner wording and target detection**

In `scripts/run-llm-digest.js`, change the prompt text:

```js
- Do not run deliver.js, Telegram/email delivery, or any delivery command/API.
```

to:

```js
- Do not run deliver.js, configured delivery, or any delivery command/API.
```

Add this helper near `runDelivery()`:

```js
function deliveryUsesStdoutOnly(delivery = {}) {
  if (Array.isArray(delivery.targets) && delivery.targets.length > 0) {
    return delivery.targets.length === 1 && (delivery.targets[0].method || 'stdout') === 'stdout';
  }
  return (delivery.method || 'stdout') === 'stdout';
}
```

Update the stdout shortcut in `runDelivery()` from:

```js
if ((config.delivery?.method || 'stdout') === 'stdout') {
```

to:

```js
if (deliveryUsesStdoutOnly(config.delivery)) {
```

- [ ] **Step 4: Run runner tests**

Run:

```bash
cd scripts && node --test run-llm-digest.test.js
```

Expected: PASS.

- [ ] **Step 5: Run all script tests**

Run:

```bash
cd scripts && npm test
```

Expected: PASS.

- [ ] **Step 6: Commit runner update**

```bash
git add scripts/run-llm-digest.js scripts/run-llm-digest.test.js
git commit -m "fix: route delivery targets through deliver wrapper"
```

## Task 5: Update Agent Onboarding in SKILL.md

**Files:**
- Modify: `SKILL.md`

- [ ] **Step 1: Update capability summary**

In the opening section, change:

```md
Users only need API keys if they choose Telegram or email delivery.
```

to:

```md
Users only need delivery credentials if they choose Telegram, Discord, or email delivery.
```

In the non-persistent platform section, change Telegram/email mentions to Telegram/Discord/email.

- [ ] **Step 2: Update delivery method choice**

Replace the non-persistent delivery choice block with:

```md
"Since you're not using a persistent agent, I need a way to send you the digest
when you're not in this terminal. You can choose one or more delivery channels:

1. **Telegram** — I'll send it as a Telegram message (free, takes ~5 min to set up)
2. **Discord** — I'll post it to a Discord server channel using a channel webhook
3. **Email** — I'll email it to you (requires a free Resend account)

Or you can skip this and just type /ai whenever you want your digest — but it
won't arrive automatically."
```

- [ ] **Step 3: Add Discord setup branch**

After the Telegram branch and before Email, add:

```md
**If they choose Discord:**
Explain: "Discord delivery uses an Incoming Webhook attached to the channel where
you want the digest. You do not need to create a Discord App or Bot."

Guide the user step by step:
1. Open Discord and enter the target server.
2. Select the text channel that should receive the digest.
3. Click the channel gear icon to open channel settings.
4. Open **Integrations** / **集成**.
5. Open **Webhooks**.
6. Click **New Webhook** / **新建 Webhook**.
7. Name it "Follow Builders Digest" or another clear name.
8. Confirm it is attached to the intended channel.
9. Click **Copy Webhook URL**.
10. Paste the webhook URL back here.

Validate that the pasted URL starts with `https://discord.com/api/webhooks/`
or `https://discordapp.com/api/webhooks/`. If it does not, ask the user to copy
the webhook URL again from Discord's Webhooks screen.

Add or replace `DISCORD_WEBHOOK_URL` in `~/.follow-builders/.env`. Do not write
the webhook URL into `config.json`.
```

- [ ] **Step 4: Update API keys section**

Replace the `.env` template with:

```bash
mkdir -p ~/.follow-builders
touch ~/.follow-builders/.env
```

Then instruct the agent to add only the needed values:

````md
Add only the credentials for the selected channels:

```bash
# Telegram bot token (only if using Telegram delivery)
TELEGRAM_BOT_TOKEN=paste_your_token_here

# Discord webhook URL (only if using Discord delivery)
DISCORD_WEBHOOK_URL=paste_your_webhook_url_here

# Resend API key (only if using email delivery)
RESEND_API_KEY=paste_your_key_here
```

The agent should write or update these values for the user after collecting them.
Do not ask the user to manually edit `.env`.
````

When editing, keep the nested fenced block valid by using four backticks for the outer Markdown block if needed.

- [ ] **Step 5: Update config save template**

Replace the delivery object in the onboarding config template with:

```json
  "delivery": {
    "targets": [
      { "method": "<telegram, discord, email, or stdout>", "chatId": "<telegram chat ID, only if telegram>", "email": "<email address, only if email>" }
    ]
  },
```

Add this note below the config template:

```md
If the user chooses a single legacy channel, `delivery.method` is still accepted,
but new setup should write `delivery.targets` so multiple channels can be added
without migration.
```

- [ ] **Step 6: Update cron and content delivery wording**

Change:

```md
**Non-persistent agent + Telegram or Email delivery:**
```

to:

```md
**Non-persistent agent + configured delivery targets:**
```

Change:

```md
**Non-persistent agent + on-demand only (no Telegram/Email):**
```

to:

```md
**Non-persistent agent + on-demand only (stdout only):**
```

Change content delivery from reading only `config.delivery.method` to:

```md
Read `config.delivery.targets` first. If it exists, use those targets. Otherwise,
fall back to legacy `config.delivery.method`.

**If any configured target is not "stdout":**
```bash
cd ${CLAUDE_SKILL_DIR}/scripts && node deliver.js --file /tmp/fb-digest.txt 2>/dev/null
```
If delivery fails, show the digest in the terminal as fallback and tell the user
which target failed according to the JSON summary.

**If the only target is "stdout" (default):**
Output the contents of `/tmp/fb-digest.txt` directly.
```

- [ ] **Step 7: Update delivery settings commands**

Replace the delivery changes list with:

```md
### Delivery Changes
- "Switch to Telegram" → Configure Telegram credentials, then set `delivery.targets` to `[{"method":"telegram","chatId":"..."}]`
- "Switch to Discord" → Guide the user through Discord webhook setup, then set `delivery.targets` to `[{"method":"discord"}]`
- "Switch to email" → Configure Resend credentials and email, then set `delivery.targets` to `[{"method":"email","email":"..."}]`
- "Also send to Discord" / "Add Discord" → Preserve existing targets and append `{ "method": "discord" }` after webhook setup
- "Send to Telegram and Discord" → Configure both channels and set both targets
- "Change my email" → Update the email target's `email` field
- "Send to this chat instead" → Set `delivery.targets` to `[{"method":"stdout"}]`
```

- [ ] **Step 8: Commit SKILL update**

Run a quick text scan:

```bash
rg -n "Telegram/email|telegram/email|Telegram or Email|no Telegram/Email|delivery\\.method" SKILL.md
```

Expected: remaining `delivery.method` mentions only refer to legacy compatibility or OpenClaw stdout setup.

Commit:

```bash
git add SKILL.md
git commit -m "docs: guide discord webhook onboarding"
```

## Task 6: Update README Documentation

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`

- [ ] **Step 1: Update English README**

In `README.md`, update setup and privacy wording:

- Change "Telegram, email, or in-chat" to "Telegram, Discord, email, or in-chat".
- In "Scheduled LLM Cron", change "Telegram or email delivery" to "configured non-stdout delivery".
- Add a short section after "Changing Settings":

```md
## Discord Delivery

Discord delivery uses an Incoming Webhook for the channel where you want the
digest to appear. You do not need to create a Discord App or Bot.

The recommended setup path is through your agent: say "send my digest to
Discord" or "also send this to Discord". The agent will walk you through creating
the channel webhook, ask you to paste the webhook URL, store it locally in
`~/.follow-builders/.env`, and update `~/.follow-builders/config.json` for you.

Follow Builders also supports sending one digest to multiple channels, such as
Telegram and Discord, using `delivery.targets`.
```

- Update Privacy from:

```md
- If you use Telegram/email delivery, those keys are stored locally in `~/.follow-builders/.env`
```

to:

```md
- If you use Telegram, Discord, or email delivery, those credentials are stored locally in `~/.follow-builders/.env`
```

- [ ] **Step 2: Update Chinese README**

In `README.zh-CN.md`, make the parallel Chinese updates. Add this section near settings or delivery content:

```md
## Discord 推送

Discord 推送使用目标频道的 Incoming Webhook。你不需要创建 Discord App
或 Bot。

推荐通过 agent 设置：告诉 agent “把 digest 发到 Discord” 或 “同时发到
Discord”。agent 会引导你在 Discord 频道里创建 Webhook，请你粘贴 Webhook
URL，然后由 agent 写入本地 `~/.follow-builders/.env` 并更新
`~/.follow-builders/config.json`。用户不需要手写配置文件。

Follow Builders 也支持一次 digest 同时推送到多个渠道，例如 Telegram 和
Discord，配置结构是 `delivery.targets`。
```

- [ ] **Step 3: Scan docs for stale wording**

Run:

```bash
rg -n "Telegram/email|telegram/email|Telegram or email|Telegram or Email" README.md README.zh-CN.md
```

Expected: no stale user-facing wording remains unless it is explicitly describing legacy behavior.

- [ ] **Step 4: Commit README update**

```bash
git add README.md README.zh-CN.md
git commit -m "docs: document discord delivery setup"
```

## Task 7: Final Verification

**Files:**
- All changed files

- [ ] **Step 1: Run full tests**

Run:

```bash
cd scripts && npm test
```

Expected: PASS.

- [ ] **Step 2: Run whitespace check**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 3: Smoke test stdout delivery**

Run:

```bash
tmp_home="$(mktemp -d)"
HOME="$tmp_home" node scripts/deliver.js --message "Smoke stdout digest"
rm -rf "$tmp_home"
```

Expected output:

```text
Smoke stdout digest
```

- [ ] **Step 4: Smoke test Discord with missing webhook**

Run:

```bash
tmp_home="$(mktemp -d)"
mkdir -p "$tmp_home/.follow-builders"
printf '{"delivery":{"targets":[{"method":"discord"}]}}\n' > "$tmp_home/.follow-builders/config.json"
HOME="$tmp_home" node scripts/deliver.js --message "Smoke discord digest"; status="$?"
rm -rf "$tmp_home"
exit "$status"
```

Expected:

- Command exits `1`.
- Output JSON contains `"method":"discord"` and `DISCORD_WEBHOOK_URL not found in .env`.

- [ ] **Step 5: Review final git history**

Run:

```bash
git log --oneline -8
git status --short
```

Expected:

- Recent commits match task commits.
- Working tree is clean.

## Self-Review Notes

Spec coverage:

- Discord Incoming Webhook delivery: Task 1 and Task 2.
- Multi-target delivery with legacy compatibility: Task 1, Task 2, and Task 3.
- Independent target failures and JSON summaries: Task 1 and Task 2.
- Discord chunking and `allowed_mentions`: Task 1 and Task 2.
- Runner wording and multi-target delivery path: Task 4.
- Agent-led Discord onboarding with no manual config editing: Task 5.
- README docs and privacy wording: Task 6.
- Verification: Task 7.

No placeholders or open product decisions remain in this plan.
