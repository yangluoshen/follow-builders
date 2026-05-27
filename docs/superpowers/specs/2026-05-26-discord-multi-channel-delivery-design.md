# Discord Multi-Channel Delivery Design

Date: 2026-05-26

## Goal

Add Discord delivery to Follow Builders and allow one digest run to deliver to multiple channels, such as Telegram and Discord, without requiring users to hand-edit delivery configuration.

Discord delivery will use Discord Incoming Webhooks. This fits the current one-way delivery model and avoids asking users to create a Discord App or Bot.

## Current Context

Delivery is centralized in `scripts/deliver.js`. It currently supports:

- `stdout`
- `telegram`, using `TELEGRAM_BOT_TOKEN` from `~/.follow-builders/.env` and `delivery.chatId` from `~/.follow-builders/config.json`
- `email`, using `RESEND_API_KEY` from `.env` and `delivery.email` from `config.json`

The config schema currently models delivery as a single object with `delivery.method`. The onboarding guidance in `SKILL.md` also assumes one selected delivery method for non-OpenClaw environments.

## Chosen Approach

Use Discord Incoming Webhooks and add a multi-target delivery model.

The implementation will keep old single-method configs working and add `delivery.targets` for multi-channel delivery.

Old config remains valid:

```json
{
  "delivery": {
    "method": "telegram",
    "chatId": "123456789"
  }
}
```

New multi-channel config:

```json
{
  "delivery": {
    "targets": [
      { "method": "telegram", "chatId": "123456789" },
      { "method": "discord" },
      { "method": "email", "email": "me@example.com" }
    ]
  }
}
```

Discord uses `DISCORD_WEBHOOK_URL` from `~/.follow-builders/.env`. The webhook URL must not be stored in `config.json` because it grants write access to the target Discord channel.

## Configuration Rules

`scripts/deliver.js` will normalize delivery config into a list of targets:

1. If `delivery.targets` exists, use that array.
2. Otherwise, if `delivery.method` exists, wrap the old object as one target.
3. Otherwise, default to one `stdout` target.

`config/config-schema.json` will be updated to:

- Add `discord` to the delivery method enum.
- Allow `delivery.targets`.
- Define target objects with `method`, optional `chatId`, and optional `email`.
- Keep legacy `delivery.method`, `delivery.chatId`, and `delivery.email` valid.

## Delivery Behavior

Each target is attempted independently. A failure in one target must not prevent other targets from sending.

The script will collect per-target results and print one JSON summary for configured non-stdout multi-target delivery.

Example partial failure:

```json
{
  "status": "partial_error",
  "results": [
    { "method": "telegram", "status": "ok", "message": "Digest sent to Telegram" },
    { "method": "discord", "status": "error", "message": "DISCORD_WEBHOOK_URL not found in .env" }
  ]
}
```

Exit behavior:

- Empty digest: skip and exit `0`, matching current behavior.
- All targets succeed: exit `0`.
- One or more targets fail: continue all attempts, print the result summary, and exit `1`.

For `stdout`, current behavior should remain simple for the single default case: print the digest text directly. In multi-target mode, `stdout` may be represented as an `ok` result after printing the digest.

## Discord Sending

Discord delivery will:

- Read `DISCORD_WEBHOOK_URL` from `.env`.
- POST JSON to that URL.
- Send plain Markdown text using the `content` field.
- Avoid embeds, buttons, attachments, or Discord app features.
- Include `allowed_mentions: { "parse": [] }` so digest text cannot accidentally notify `@everyone`, `@here`, users, or roles.
- Split long digests into chunks because Discord message content is limited to 2000 characters.

The implementation should use a shared `splitMessage(text, maxLen)` helper:

- Telegram uses about 4000 characters per chunk.
- Discord uses about 1900 characters per chunk to leave margin below Discord's 2000-character content limit.
- Splitting should prefer newline boundaries near the limit.
- Multiple chunks should be sent in order with a short delay between chunks.

Discord API errors should include useful context without printing the webhook URL.

## Agent-Led Discord Onboarding

Users should not be asked to manually edit JSON or `.env` files.

`SKILL.md` will add Discord as a delivery option. When the user chooses Discord, the agent will explain that this uses a Discord channel webhook and does not require creating a Discord App or Bot.

The agent will guide the user through getting the webhook URL:

1. Open Discord and enter the target server.
2. Select the text channel that should receive the digest.
3. Open the channel settings using the gear icon.
4. Open `Integrations` / `集成`.
5. Open `Webhooks`.
6. Create a new webhook.
7. Name it `Follow Builders Digest` or another clear name.
8. Confirm it is attached to the intended channel.
9. Copy the webhook URL.
10. Paste the webhook URL back to the agent.

After the user pastes the URL, the agent will:

1. Validate that it looks like a Discord webhook URL.
2. Update `~/.follow-builders/.env`, adding or replacing `DISCORD_WEBHOOK_URL`.
3. Update `~/.follow-builders/config.json`:
   - If the user wants only Discord, configure Discord as the only target.
   - If the user wants Discord plus existing channels, preserve existing targets and add `{ "method": "discord" }`.
4. Run a test delivery.
5. Ask the user to confirm the test appeared in the Discord channel before continuing to cron or first digest setup.

User-facing commands such as "add Discord", "also send to Discord", "send only to Discord", and "send to Telegram and Discord" should be documented in `SKILL.md` as supported settings changes.

## Documentation

`README.md` and `README.zh-CN.md` will be updated to mention Discord webhook delivery and multi-channel delivery.

The docs should emphasize:

- Recommended setup is through the agent.
- Discord uses a channel webhook, not a Discord App.
- The webhook URL is stored locally in `~/.follow-builders/.env`.
- Config examples are for reference and troubleshooting, not the primary setup path.

## Testing

Add `scripts/deliver.test.js`.

Tests should cover:

- Legacy single-method config still works.
- `delivery.targets` sends to multiple targets.
- Discord webhook POST uses `content`.
- Discord payload includes `allowed_mentions: { parse: [] }`.
- Discord long text is split into multiple webhook POSTs.
- Missing `DISCORD_WEBHOOK_URL` records only the Discord target as failed.
- One target failing does not block later targets.
- Partial failure exits non-zero after all attempts are made.
- Config schema accepts `discord` and `delivery.targets`.

Update existing runner tests and prompt text where they currently say only "Telegram/email delivery". The wording should refer to configured non-stdout delivery or configured delivery so Discord and future channels are included.

## Non-Goals

This feature will not:

- Create or manage Discord Apps.
- Create or manage Discord Bots.
- Support Discord slash commands or interactive messages.
- Support separate webhook URLs per Discord target in the first implementation.
- Send Discord embeds or attachments.
- Read messages from Discord.

## Open Decisions

No open product decisions remain for this design. The implementation plan may still choose exact helper names and test fixture structure.
