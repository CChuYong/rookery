# Worker → Slack relay — design

Date: 2026-06-30

## Problem
When a Slack-origin master spawns a worker, the user in Slack goes dark — the master dispatches the
work and then just waits, with no visibility into what the worker is doing. The worker runs isolated
in its worktree and never surfaces to Slack.

## Goal
A toggle that, when ON with a configured channel, mirrors each worker's activity into a dedicated Slack
channel (one thread per worker) and drops a link to that thread into the master's Slack thread — so the
user can click through and watch the worker work.

## Scope (decided)
- **Only workers whose home session is Slack-origin** (`origin === "slack"`). Desktop/automation workers are out of scope.
- **Relayed content:** the worker's assistant messages + a one-line summary of each action (`tool_use`), plus turn completion (`result`) and errors. Streaming deltas, `tool_result` bodies, and `thinking` are excluded (spam/rate-limit).
- **Link mechanism:** the relay posts a bot message containing the thread permalink into the master's own Slack thread (Approach A — fully decoupled from the core `spawn_worker` tool; no core change to inject the link).

## Settings (two new, Slack section, settings-only, live resolvers)
- `workerSlackRelayEnabled` — "1"/"0", default "0".
- `workerSlackRelayChannel` — Slack channel ID (e.g. `C0123…`). Empty → feature off even if enabled.
Added to `SettingsValues` (echoed, not secret) + the `settings.set` protocol schema + the desktop Slack settings UI (toggle + channel field) with i18n.

## Architecture
- **`WorkerSlackRelay`** (new, `src/slack/worker-slack-relay.ts`) — one per daemon, like `WorkerNotifier`. Slack-adapter side; the transport-agnostic core is unchanged.
- Subscribes to `worker.*` events on `FLEET_CHANNEL` (sees the whole fleet).
- Injected dependencies (wired in `server.ts`):
  - `SlackClient` (post root message, open chatStreams, get permalink).
  - `settings` resolvers: `workerSlackRelayEnabled()`, `workerSlackRelayChannel()` (read live per event).
  - `resolveSlackThread(sessionId) → ThreadTarget | null` — parses the home session's external key `slack:team:channel:threadTs`; returns null if the session isn't Slack-origin. (Implemented from `Repositories` in server.ts.)
- **Gate** (per event): `enabled && channel set && resolveSlackThread(homeSessionId) !== null && Slack bot up`. Otherwise no-op.
- **State:** in-memory `Map<workerId, { channel; rootTs; stream: ChatStreamerLike | null }>`. Lost on daemon restart (acceptable for v1 — a mid-flight worker just stops being mirrored).

## Data flow
1. **`worker.spawned`** `{ sessionId (home), workerId, repoPath, label, task? }` — if gated in:
   a. Post a simple **root message** to `workerSlackRelayChannel`: `Worker \`<label>\` · repo \`<repoPath leaf>\` · task: <task summary>`. Capture `rootTs`.
   b. `getPermalink(channel, rootTs)` → post a bot message into the **master's Slack thread**: `🧵 Worker started — follow: <permalink>`.
   c. Store `{ channel, rootTs, stream: null }`.
   - (The `task` text isn't on `worker.spawned` today — add a `task` field to the event, or derive from the worker's first user message. Decided: add `task` to `worker.spawned`.)
2. **`worker.event`** `{ workerId, data: WorkerEventData }` for a tracked worker → render to `PlanChunk`s and feed a **per-turn chatStream** opened on `(channel, thread_ts: rootTs)`:
   - `message` (assistant) → `{ type: "markdown_text", text }`.
   - `tool_use` → `{ type: "task_update", id, title: "<name> <short input>", status: "in_progress" }`.
   - `tool_result` → `{ type: "task_update", id, status: isError ? "error" : "complete" }`.
   - `result` → `stop()` the current turn's stream (optionally a one-line cost/turns footer).
   - `error` → `markdown_text` error line, then `stop()`.
   - `message_delta` / `thinking_delta` / `thinking` / `tool_progress` / `tool_result` body → **ignored**.
   - Rendering reuses the event→PlanChunk approach already in `reporter.ts` (extract the shared mapping if clean).
3. **chatStream lifecycle = per worker turn, same thread:** open a new stream on the first relayable event of a turn; `stop()` on that turn's `result`/`error`. A later `send_worker` turn opens a **new** stream under the **same `rootTs`** → the thread accumulates one plan card per turn.
4. **Settle** (terminal `worker.status`: stopped/done/error/failed) → ensure the open stream is stopped, post a final status line in the thread, drop the map entry.

## SlackClient extension (`src/slack/types.ts` + bolt impl)
- `chatStream(...)` — already exists (reused for thread cards).
- **Add** `postMessage` returning the message `ts` for a **root** (non-thread) post, and `getPermalink(channel, ts) → string`. The bolt implementation uses `chat.postMessage` (no `thread_ts`) + `chat.getPermalink`.

## Throttling / rate limits
Handled by `chatStream`'s existing buffering (`buffer_size`) — no hand-rolled batching. The root message + the one master-thread link message are single posts per worker.

## Error handling
Best-effort and non-blocking: any Slack failure is caught + logged; the worker is never affected. No-op when the bot is down, the channel is unset, the feature is off, or the home session isn't Slack-origin.

## Testing
- Unit-test `WorkerSlackRelay` with a fake `SlackClient` + fake EventBus + fake `resolveSlackThread`/settings:
  - gating (off / no channel / non-slack session → no posts),
  - root message + master-thread link on spawn,
  - WorkerEventData → PlanChunk mapping (message/tool_use/tool_result/result/error; deltas ignored),
  - per-turn stream lifecycle under one rootTs,
  - settle cleanup.
- Manual Slack smoke test once (real bot + channel).

## Out of scope (YAGNI)
- Desktop / automation-origin workers.
- `tool_result` bodies, `thinking`, nested subagents.
- Approach B (injecting the permalink into the `spawn_worker` tool result so the master "says" it).
- Restoring thread mappings after a daemon restart.

## Touched files (rough)
- `src/slack/worker-slack-relay.ts` (new) + test.
- `src/slack/types.ts` (SlackClient ext), the bolt `SlackClient` impl (postMessage-ts + getPermalink).
- `src/slack/reporter.ts` (extract shared event→PlanChunk mapping, if clean).
- `src/core/events.ts` (`task` on `worker.spawned`).
- `src/core/settings.ts` + `src/protocol/messages.ts` (2 settings).
- `src/daemon/server.ts` (wire the relay + `resolveSlackThread`).
- `apps/desktop/src/renderer/components/SettingsPage.tsx` + i18n (toggle + channel field).
