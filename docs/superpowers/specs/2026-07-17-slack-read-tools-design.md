# Slack read tools for Slack-origin masters — design

Date: 2026-07-17
Status: approved (approach A)

## Problem

A Slack-origin master session today gets exactly one Slack capability: `read_thread`
(the current thread's transcript). That is too thin for an agent that lives inside a
Slack workspace — it cannot look at another channel the user references, resolve a
`<@U123>` mention to a name, list which channels it could read, or link to a specific
message. The infrastructure (bolt `WebClient`, holder pattern, provider-neutral
`toolDefs` port) already exists; the tools were simply never exposed.

## Decisions (from brainstorm)

- **Read-only only.** Slack sessions run `bypassPermissions` on untrusted channel
  text; write actions (reactions, cross-channel posting, uploads) turn prompt
  injection into outbound sends. Zero write tools in this iteration.
- **Slack-origin sessions only.** Tools ride the existing `makeSlackCapabilities`
  overlay; desktop/CLI masters are unaffected.
- **Four new tools** alongside the existing `read_thread`: `read_channel`,
  `list_channels`, `get_user_info`, `get_permalink`.
- **Approach A**: extend the existing `"slack"` MCP server (same namespace
  `mcp__slack__*`), generalizing the holder port. No second server, no Capability
  Center pack.

## Design

### 1. Port: `SlackThreadReader` → `SlackReadOps`

`src/tools/slack-thread-tools.ts` is renamed to `src/tools/slack-tools.ts` and the
single-function port becomes an interface:

```ts
export interface ChannelInfo { id: string; name: string; topic?: string; isPrivate?: boolean }
export interface SlackUserInfo { id: string; displayName?: string; realName?: string; title?: string; tz?: string }

export interface SlackReadOps {
  readThread(channel: string, threadTs: string): Promise<ThreadMsg[]>;   // conversations.replies (existing)
  readChannel(channel: string, limit?: number): Promise<ThreadMsg[]>;    // conversations.history
  listChannels(): Promise<ChannelInfo[]>;                                // conversations.list (bot-member only)
  userInfo(user: string): Promise<SlackUserInfo | null>;                 // users.info
  permalink(channel: string, ts: string): Promise<string | null>;        // chat.getPermalink
}
```

The implementation lives in `src/slack/read-ops.ts` (`makeSlackReadOps(client)`),
absorbing `src/slack/thread-reader.ts` (`repliesToThreadMsgs` moves there;
`thread-reader.ts` is deleted). The daemon holder becomes
`makeHolder<SlackReadOps>()`; `SlackDeps.setThreadReader/clearThreadReader` are
renamed `setSlackReadOps/clearSlackReadOps`. The owner-scoped `clearIf` semantics
are unchanged.

### 2. Tools (server name `"slack"`, all `readOnlyHint: true`)

| Tool | Input | Behavior |
|---|---|---|
| `read_thread` | none (bound to current thread) | unchanged |
| `read_channel` | `channel` (id or `#name`), `thread_ts?`, `limit?` | Read another channel's recent messages, or one of its threads when `thread_ts` is given. `#name` resolves via `listChannels()`. Same transcript format and budgets as `read_thread` (50 msgs / 8 KB total / 1 KB per msg, newest-first fill). |
| `list_channels` | none | Channels the bot is a member of: `#name (C123) — topic` lines, byte-budgeted. The navigation companion to `read_channel`. |
| `get_user_info` | `user` (`U123` or `<@U123>`) | display name / real name / title / tz. |
| `get_permalink` | `ts`, `channel?` (defaults to current channel) | Message permalink URL. |

Error handling follows the `read_thread` pattern exactly: disconnected holder,
missing scope, or a not-a-member channel returns a guidance string with
`isError: true` — a tool call never kills the turn. The not-in-channel case tells
the model the bot must be invited.

`SLACK_TOOL_NAMES` (renamed from `SLACK_THREAD_TOOL_NAMES`) lists all five
`mcp__slack__*` names and stays in sync with the `tool()` registrations — the
existing exposure-gate rule.

### 3. Wiring and prompt hint

- `makeSlackCapabilities(externalKey, getOps)` builds all five defs bound to the
  thread target and spreads `SLACK_TOOL_NAMES` into `allowedTools`. Unchanged
  provider-neutral path: Claude wraps with `createSdkMcpServer`, Codex flattens onto
  the daemon MCP bridge — a codex Slack master gets the same tools for free.
- `SLACK_THREAD_HINT` gains one sentence: the model can also read other channels the
  bot is in, list them, resolve user ids, and build permalinks.
- `src/slack/app.ts` constructs `makeSlackReadOps(app.client)` at connect time and
  installs it on the holder (releasing with `clearIf` on stop, as today).

### 4. Slack app scopes (user-configured prerequisites)

Beyond the existing `channels:history`: `channels:read` + `groups:read`
(list/name resolution), `users:read` (user info), `groups:history` (private-channel
reads). Missing scopes degrade to per-call guidance strings at runtime. The
AGENTS.md Slack prerequisites bullet is updated.

### 5. Security posture

No write path: an injected instruction can at most read what the bot can already
see — the same risk class as today's `read_thread`. Attachment surface unchanged.

### 6. Testing

- `test/tools/slack-tools.test.ts` (renamed): per-tool tests with a fake
  `SlackReadOps` — formatting, truncation budgets, `#name` resolution, error
  guidance (disconnected / not-a-member / lookup failure).
- `test/slack/read-ops.test.ts` (absorbs thread-reader tests): fake WebClient →
  API-call mapping (`conversations.history/replies/list`, `users.info`,
  `chat.getPermalink`), member filtering.
- Capabilities test: `allowedTools` carries all five names; non-Slack externalKey
  still returns `undefined`.
- No protocol/desktop changes → root gates (`npm run typecheck`, `npm test`) suffice.

## Out of scope

- Write actions (reactions, posting, uploads) — future, gated iteration.
- Slack search (`search.messages` is user-token only).
- Exposing these tools to non-Slack masters.
