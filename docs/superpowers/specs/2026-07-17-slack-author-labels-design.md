# Slack transcript author labels (real bot/user names) — design

Date: 2026-07-17
Status: approved

## Problem

`formatTranscript` labels EVERY `bot_id`-bearing message as `<masterName>(bot)` —
a leftover from when read_thread only saw the bot's own assistant thread. With
`read_channel`, other bots' (CI/monitoring) messages are mislabeled as our own,
and human authors render as raw `<@U0123>` mentions the model can't name.

## Design

### Author identity enrichment (`src/slack/read-ops.ts`)

- `RawReply` gains `bot_profile?: { name?: string }` and `username?: string`
  (both ride the replies/history payload — no extra API call for bot names).
- `ThreadMsg` gains `name?: string` (author display name) and `isSelf?: boolean`
  (our own bot).
- `makeSlackReadOps(client, download?, opts?)` gains
  `opts?: { selfBotId?: () => string | undefined; resolver?: SlackRefResolver }`:
  - bot messages: `name = bot_profile.name ?? username`,
    `isSelf = bot_id === selfBotId()`.
  - human messages: after mapping, resolve the distinct user ids in one
    `resolver.resolve([], ids)` call (connection-lifetime cache; failure →
    unnamed, best-effort).
- `src/slack/app.ts` passes `{ selfBotId: () => selfBotId, resolver: nameResolver }`
  (both already exist at connect time; `auth.test` self id is already fetched for
  trigger self-exclusion).

### Label rendering (`src/tools/slack-tools.ts` `formatTranscript`)

- our bot (`isBot && isSelf`) → `<masterName>(bot)` (unchanged behavior for our
  own replies)
- other bot → `<name>(bot)`, falling back to the raw bot id; NEVER masterName
- human with resolved name → `clover (U0123)` (same shape as the [Slack] context
  header); unresolved → `<@U0123>` (today's output)
- names are user-controlled → collapse whitespace + byte-cap 80 (same rule as the
  context header).
- Compatibility default: a bot message with no `isSelf` flag (older callers /
  fakes) keeps the legacy `<masterName>(bot)` label only when `isSelf` is
  `undefined`? No — explicit rule: `isSelf === true` → masterName; otherwise the
  bot's own name/id. Tests updated accordingly (the previous blanket labeling was
  the bug being fixed).

## Testing

- read-ops: bot_profile.name mapping, username fallback, isSelf marking via
  selfBotId, human name enrichment through a fake resolver, resolver failure →
  no names, distinct-id single resolve call.
- slack-tools: four label shapes (self bot / named other bot / unnamed other bot
  / named human / unnamed human) + name sanitization.

## Out of scope

Reactions; per-message avatars; changing the `[Slack]` context header.
