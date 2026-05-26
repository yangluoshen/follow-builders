#!/usr/bin/env node

// ============================================================================
// Follow Builders — Delivery Script
// ============================================================================
// Sends a digest to the user via their chosen delivery method(s).
// Supports: Discord webhook, Telegram bot, Email (via Resend), or stdout
// (default). Multiple delivery targets can be configured.
//
// Usage:
//   echo "digest text" | node deliver.js
//   node deliver.js --message "digest text"
//   node deliver.js --file /path/to/digest.txt
//
// The script reads delivery config from ~/.follow-builders/config.json
// and API keys from ~/.follow-builders/.env
//
// Delivery methods:
//   - "discord": sends via Discord webhook (needs DISCORD_WEBHOOK_URL)
//   - "telegram": sends via Telegram Bot API (needs TELEGRAM_BOT_TOKEN + chat ID)
//   - "email": sends via Resend API (needs RESEND_API_KEY + email address)
//   - "stdout" (default): just prints to terminal
// Configure delivery.targets for multi-target delivery, or the legacy
// delivery.method object for a single target.
// ============================================================================

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { config as loadEnv } from 'dotenv';

// -- Constants ---------------------------------------------------------------

const USER_DIR = join(homedir(), '.follow-builders');
const CONFIG_PATH = join(USER_DIR, 'config.json');
const ENV_PATH = join(USER_DIR, '.env');

// -- Helpers -----------------------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];

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

// -- Read input --------------------------------------------------------------

// The digest text can come from stdin, --message flag, or --file flag
async function getDigestText() {
  const args = process.argv.slice(2);

  // Check --message flag
  const msgIdx = args.indexOf('--message');
  if (msgIdx !== -1 && args[msgIdx + 1]) {
    return args[msgIdx + 1];
  }

  // Check --file flag
  const fileIdx = args.indexOf('--file');
  if (fileIdx !== -1 && args[fileIdx + 1]) {
    return await readFile(args[fileIdx + 1], 'utf-8');
  }

  // Read from stdin
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// -- Telegram Delivery -------------------------------------------------------

// Sends the digest via Telegram Bot API.
// The user creates a bot via @BotFather and provides the token.
// The chat ID is obtained when the user sends their first message to the bot.
async function sendTelegram(text, botToken, chatId) {
  const chunks = splitMessage(text, 4000);
  const apiBase = process.env.FOLLOW_BUILDERS_TELEGRAM_API_BASE
    || `https://api.telegram.org/bot${botToken}`;
  const sendMessageUrl = `${apiBase.replace(/\/$/, '')}/sendMessage`;

  async function postTelegramMessage(chunk, useMarkdown) {
    const body = {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: true
    };
    if (useMarkdown) body.parse_mode = 'Markdown';

    return fetch(sendMessageUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const res = await postTelegramMessage(chunk, true);

    if (!res.ok) {
      const err = await readErrorBody(res);
      const message = err.description || err.message || JSON.stringify(err);
      // If Markdown parsing fails, retry without parse_mode.
      if (message.includes("can't parse")) {
        const retryRes = await postTelegramMessage(chunk, false);
        if (!retryRes.ok) {
          const retryErr = await readErrorBody(retryRes);
          throw new Error(`Telegram API error: ${retryErr.description || retryErr.message || JSON.stringify(retryErr)}`);
        }
      } else {
        throw new Error(`Telegram API error: ${message}`);
      }
    }

    // Small delay between chunks to avoid rate limiting.
    if (i < chunks.length - 1) await sleep(500);
  }
}

// -- Discord Delivery --------------------------------------------------------

async function sendDiscord(text, webhookUrl) {
  const chunks = splitMessage(text, 1900);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
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
      throw new Error(`Discord webhook error: ${err.message || JSON.stringify(err)}`);
    }

    if (i < chunks.length - 1) await sleep(500);
  }
}

// -- Email Delivery (Resend) -------------------------------------------------

// Sends the digest via Resend's email API.
// The user provides their own Resend API key and email address.
async function sendEmail(text, apiKey, toEmail) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      from: 'AI Builders Digest <digest@resend.dev>',
      to: [toEmail],
      subject: `AI Builders Digest — ${new Date().toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
      })}`,
      text
    })
  });

  if (!res.ok) {
    const err = await readErrorBody(res);
    throw new Error(`Resend API error: ${err.message || JSON.stringify(err)}`);
  }
}

async function sendTarget(target, digestText, options = {}) {
  const { printStdout = true } = options;

  switch (target.method) {
    case 'discord': {
      const webhookUrl = target.webhookUrl || process.env.DISCORD_WEBHOOK_URL;
      if (!webhookUrl) throw new Error('DISCORD_WEBHOOK_URL not found in .env');
      await sendDiscord(digestText, webhookUrl);
      return {
        status: 'ok',
        method: 'discord',
        message: 'Digest sent to Discord'
      };
    }

    case 'telegram': {
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = target.chatId;
      if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN not found in .env');
      if (!chatId) throw new Error('delivery.chatId not found in config.json');
      await sendTelegram(digestText, botToken, chatId);
      return {
        status: 'ok',
        method: 'telegram',
        message: 'Digest sent to Telegram'
      };
    }

    case 'email': {
      const apiKey = process.env.RESEND_API_KEY;
      const toEmail = target.email;
      if (!apiKey) throw new Error('RESEND_API_KEY not found in .env');
      if (!toEmail) throw new Error('delivery.email not found in config.json');
      await sendEmail(digestText, apiKey, toEmail);
      return {
        status: 'ok',
        method: 'email',
        message: `Digest sent to ${toEmail}`
      };
    }

    case 'stdout': {
      if (printStdout) console.log(digestText);
      return {
        status: 'ok',
        method: 'stdout',
        message: printStdout
          ? 'Digest printed to stdout'
          : 'Digest stdout output suppressed in multi-target mode'
      };
    }

    default:
      throw new Error(`Unsupported delivery method: ${target.method || 'missing method'}`);
  }
}

// -- Main --------------------------------------------------------------------

async function main() {
  // Load env and config
  loadEnv({ path: ENV_PATH });

  let config = {};
  if (existsSync(CONFIG_PATH)) {
    config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
  }

  const delivery = config.delivery || { method: 'stdout' };
  const targets = normalizeDeliveryTargets(delivery);
  const digestText = await getDigestText();

  if (!digestText || digestText.trim().length === 0) {
    console.log(JSON.stringify({ status: 'skipped', reason: 'Empty digest text' }));
    return;
  }

  const isSingleStdout = targets.length === 1 && targets[0].method === 'stdout';
  if (isSingleStdout) {
    console.log(digestText);
    return;
  }

  const results = [];
  for (const target of targets) {
    try {
      results.push(await sendTarget(target, digestText, { printStdout: false }));
    } catch (err) {
      results.push({
        status: 'error',
        method: target.method || 'stdout',
        message: err.message
      });
    }
  }

  const failures = results.filter(result => result.status === 'error').length;
  const status = failures === 0 ? 'ok' : failures === results.length ? 'error' : 'partial_error';
  console.log(JSON.stringify({ status, results }));
  if (failures > 0) process.exit(1);
}

main();
