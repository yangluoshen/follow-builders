# Source Expansion Discovery Design

## Context

Follow Builders currently publishes three central feeds:

- `feed-x.json` for curated X accounts
- `feed-podcasts.json` for podcast episodes and transcripts
- `feed-blogs.json` for AI company blog posts

`scripts/prepare-digest.js` fetches those feeds and prompt files, then emits one JSON payload. `scripts/run-llm-digest.js` gives that payload to Codex. Codex decides what to include in the final digest, writes the digest Markdown, and writes structured workbook items JSON. The wrapper then validates the items JSON, updates and syncs the Univer workbook, appends the workbook URL when configured, and delivers the final Markdown through stdout, Telegram, or email.

The source expansion should preserve that separation. Fetching code should gather and normalize candidates. The agent should make the final editorial judgment before anything is written to the digest, workbook, or delivery channel.

## Goals

- Add a fourth central feed, `feed-discovery.json`, for high-signal official, community, project, and product-discovery sources.
- Keep discovery content separate from blogs, podcasts, and X so source-specific filtering and quotas do not pollute existing feeds.
- Pass discovery candidates to the agent for final selection, summarization, importance scoring, and workbook item creation.
- Ensure selected discovery items are written to the Univer workbook and delivered through the existing wrapper flow.
- Keep community/product sources capped so they enrich the digest without overwhelming official and builder sources.

## Non-Goals

- Do not let deterministic fetch code generate the final digest prose.
- Do not deliver raw discovery candidates directly.
- Do not scrape Product Hunt category pages; use available Atom feeds.
- Do not require user-side API keys for these discovery sources.
- Do not build a fully generic event bus in this iteration.

## Selected Sources

### Official Discovery

- OpenAI News RSS: `https://openai.com/news/rss.xml`
- Anthropic release notes and Claude release notes:
  - `https://docs.anthropic.com/en/release-notes/api`
  - `https://docs.anthropic.com/en/release-notes/claude-code`
  - `https://docs.anthropic.com/en/release-notes/claude-apps`
- Google DeepMind Blog RSS: `https://deepmind.google/blog/rss.xml`
- Hugging Face Blog RSS: `https://huggingface.co/blog/feed.xml`

### Community and Product Discovery

- Hacker News Top Stories with AI filtering:
  - `https://hacker-news.firebaseio.com/v0/topstories.json`
- Hacker News Algolia searches:
  - `https://hn.algolia.com/api/v1/search_by_date?query=AI&tags=story`
  - `https://hn.algolia.com/api/v1/search_by_date?query=LLM&tags=story`
- GitHub Trending Daily:
  - `https://github.com/trending?since=daily`
- Reddit AI agents:
  - `https://www.reddit.com/r/AI_Agents/top/.rss?t=week`
- Product Hunt AI Featured:
  - `https://www.producthunt.com/feed?category=artificial-intelligence`
- Product Hunt Developer Tools:
  - `https://www.producthunt.com/feed?category=developer-tools`

## Architecture

Add `discovery_sources` to `config/default-sources.json`.

Add discovery fetching to `scripts/generate-feed.js` behind a `--discovery-only` flag and include discovery in the default all-feeds run. The generator writes `feed-discovery.json` in the repository root and updates `state-feed.json` with discovery item IDs.

Add `FEED_DISCOVERY_URL` and `summarize-discovery.md` to `scripts/prepare-digest.js`. Its output should include:

- `discovery`: normalized candidate items
- `stats.discoveryItems`
- `prompts.summarize_discovery`

The no-new-content condition must treat discovery as content. A run is empty only when podcast episodes, X builders, blog posts, and discovery items are all zero.

Update `scripts/run-llm-digest.js` prompt so Codex treats discovery as candidate material and makes final inclusion decisions. The wrapper remains responsible for workbook and delivery side effects.

Update the workbook contract to accept a new selected item source type: `discovery`.

## Discovery Feed Contract

`feed-discovery.json` should use this shape:

```json
{
  "generatedAt": "2026-05-26T00:00:00.000Z",
  "lookbackHours": 72,
  "discovery": [
    {
      "source": "discovery",
      "sourceKind": "official",
      "sourceName": "OpenAI News",
      "title": "Article title",
      "url": "https://example.com/item",
      "publishedAt": "2026-05-26T00:00:00.000Z",
      "author": "",
      "summary": "Short source-provided description or extracted excerpt",
      "metadata": {
        "score": 0,
        "comments": 0,
        "rank": 0,
        "tags": ["llm"]
      },
      "rawSourceKey": "stable source id or normalized URL"
    }
  ],
  "stats": {
    "discoveryItems": 1
  },
  "errors": []
}
```

`sourceKind` must be one of:

- `official`
- `hn`
- `github_trending`
- `reddit`
- `producthunt`

`rawSourceKey` must be stable enough for deduplication. Prefer native IDs when available, otherwise use a normalized URL.

## Agent Judgment

The discovery feed is candidate material, not final output.

Codex must decide:

- whether each discovery item is worth including
- whether the item belongs in the final digest and workbook output
- the short human-readable summary
- key points and topics
- `importanceScore`
- which discovery items to omit because they are too promotional, low-signal, duplicate, or stale

The deterministic generator may attach source hints such as rank, points, comments, and keyword tags. These hints must not force inclusion.

The first implementation should not write omitted discovery candidates to the workbook. The workbook remains a history of agent-selected final content, not a raw candidate archive.

## Digest Format

Add a `DISCOVERY` section to the final digest prompt. The section should appear after `OFFICIAL BLOGS` and before `PODCASTS`, unless no selected discovery items exist.

Discovery entries should answer:

- Why should an AI builder care?
- Is this an official update, community signal, trending project, Reddit discussion, or product launch?
- Is it worth reading, trying, watching, or merely tracking?
- What is the original source link?

Mandatory link rules remain unchanged: no URL means no digest item.

## Workbook Integration

Selected discovery items should become workbook items only after Codex has judged and summarized them.

Extend the items JSON contract in `scripts/run-llm-digest.js`:

```json
{
  "contentId": "discovery:<stable hash or source id>",
  "sourceType": "discovery",
  "sourceName": "HN Top Stories",
  "authorName": "source author or empty string",
  "authorHandle": "",
  "title": "Item title",
  "url": "https://example.com/item",
  "publishedAt": "2026-05-26T00:00:00.000Z",
  "capturedAt": "2026-05-26T01:00:00.000Z",
  "runDate": "2026-05-26",
  "textExcerpt": "Short excerpt",
  "summary": "Agent-written summary",
  "keyPoints": ["Why this matters"],
  "topics": ["agent", "developer tools"],
  "importanceScore": 72,
  "likes": 0,
  "retweets": 0,
  "replies": 0,
  "rawSourceKey": "source-native id or normalized URL"
}
```

Update `scripts/lib/univer-workbook-contract.js` so `discovery` is a valid `sourceType`, has label `Discovery`, and sorts after `blog` in weekly views:

1. X
2. Podcast
3. Blog
4. Discovery

Update workbook dashboard and topic heat sections to include Discovery counts. The first implementation must at minimum show Discovery in raw-data, weekly item rows, source labels, source sorting, and a dashboard count. If the topic heat grid cannot be expanded cleanly in the same change, it may remain X/Podcast/Blog-only while preserving Discovery in raw-data and weekly rows.

## Delivery Flow

The delivery flow must stay:

1. `generate-feed.js` creates central feed JSON, including `feed-discovery.json`.
2. `prepare-digest.js` fetches all feeds and prompts, then emits JSON.
3. Codex reads the JSON and writes:
   - final digest Markdown
   - structured workbook items JSON, including only selected discovery items
4. The wrapper validates items JSON.
5. The wrapper updates and syncs the Univer workbook when configured.
6. The wrapper appends the workbook public URL when configured.
7. The wrapper sends the final Markdown through stdout, Telegram, or email.

Discovery source failures must not block delivery if the existing feeds and agent output are usable.

## Filtering and Quotas

Generator-side filtering should keep the candidate set small enough for the agent:

- Official discovery: include at most 3 new items per source.
- HN Top Stories: inspect top items, keep AI-related candidates only.
- HN Algolia: query `AI` and `LLM`, merge and dedupe by object ID or URL.
- GitHub Trending Daily: keep AI-related repositories only; exclude `awesome-*`, course lists, prompt lists, and empty-description repos unless there is a strong signal.
- Reddit: use `r/AI_Agents/top/.rss?t=week`; keep at most 3 candidates before agent judgment.
- Product Hunt: merge AI and Developer Tools feeds, dedupe by Product Hunt post ID or URL, and keep AI/devtool-related candidates only.

Agent-side final quotas:

- Discovery section: max 5 items per digest.
- Community/product items: max 3 items per digest.
- Reddit: max 1 item per digest.
- Product Hunt: max 2 items per digest.

Official discovery items may outrank community items when both are relevant.

## Deduplication

Extend `state-feed.json` with `seenDiscovery`.

Use stable keys:

- OpenAI, DeepMind, Hugging Face RSS: normalized article URL or feed GUID.
- Anthropic docs pages: page URL plus heading/date anchor when available.
- HN: Algolia `objectID` or Firebase item ID.
- GitHub Trending: repository full name plus captured date for discovery, or repository URL for longer-lived deduplication.
- Reddit: entry ID, such as `t3_<id>`.
- Product Hunt: Atom entry ID, such as `tag:www.producthunt.com,2005:Post/<id>`.

Prune old discovery state after 14 days. Official discovery items may stay longer if duplicate announcements reappear in feeds.

## Error Handling

- A failed discovery source records a non-fatal `Discovery:` error in `feed-discovery.json`.
- `prepare-digest.js` records `Could not fetch discovery feed` if the remote JSON is unavailable.
- If only discovery fails, existing X, podcast, blog, workbook, and delivery behavior continues.
- If Codex omits all discovery items, no discovery workbook rows are written.
- If workbook update fails, delivery still proceeds as the wrapper already does.

## Testing

Add focused tests for:

- Atom/RSS parsing for OpenAI, DeepMind, Hugging Face, Reddit, and Product Hunt shapes.
- HN API normalization for Top Stories and Algolia results.
- GitHub Trending HTML normalization.
- Discovery deduplication using native IDs and normalized URLs.
- Discovery filtering for AI keywords, GitHub repo exclusions, and Product Hunt promotional noise.
- `prepare-digest.js` including `discovery`, `stats.discoveryItems`, and `prompts.summarize_discovery`.
- `run-llm-digest.js` prompt including discovery instructions, no-new-content logic including discovery, and workbook item schema allowing `discovery`.
- `validateItemsPayload` accepting `sourceType: "discovery"` and requiring `contentId` prefix `discovery:`.
- Workbook row mapping, sorting, dashboard counts, and weekly display behavior with discovery items.

## Rollout

1. Add discovery source config and feed generation.
2. Add `feed-discovery.json` to the GitHub Actions commit step.
3. Add discovery to `prepare-digest.js`.
4. Add `summarize-discovery.md` and update `digest-intro.md`.
5. Update `run-llm-digest.js` so Codex judges discovery and writes selected discovery workbook items.
6. Extend workbook contract and update tests.
7. Run the feed generator in `--discovery-only` mode, inspect candidate volume, then enable in the default scheduled run.

## Open Decisions Resolved

- Discovery is a separate feed, not part of `feed-blogs.json`.
- Agent judgment is required before digest inclusion and workbook insertion.
- Delivery remains wrapper-owned; Codex must not call Telegram/email APIs.
- Product Hunt uses Atom feeds, not authenticated API or category page scraping.
- Community sources are capped so the digest stays builder-focused.
