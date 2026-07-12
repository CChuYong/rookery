# CoreEvent Catalog

> **Source of truth:** `src/core/events.ts` — the code is authoritative; this doc explains concepts and flows. The always-loaded map/conventions live in [AGENTS.md](../../AGENTS.md); this goes deeper.

`CoreEvent` is the single discriminated union that the transport-agnostic core emits through the `EventBus`. The core **never** imports WS/CLI/Slack/Electron; it only emits these. Every external boundary subscribes and forwards. Emit sites live in `src/core/master-agent.ts`, `src/core/worker.ts`, `src/core/fleet-orchestrator.ts`, and `src/daemon/connection.ts`. Consumers are `src/daemon/connection.ts` (wraps each event as a `{type:"event"}` `ServerMessage`) and `apps/desktop/src/renderer/store/reduce.ts`. See sibling [protocol.md](./protocol.md) for the wire layer.

## EventBus channels (`EventBus.emit`)

Every event carries a `sessionId`. `emit()` delivers to up to three channel keys:

| Channel | Key | Receives |
|---|---|---|
| Per-session | the event's `sessionId` | events for that session |
| Fleet | `FLEET_CHANNEL` = `"@fleet"` | every `worker.*` event (`type.startsWith("worker.")`), unless `sessionId` already is `@fleet` |
| All | `ALL_CHANNEL` = `"@all"` | every event, unless `sessionId` already is `@all` |

Delivery rules:
- **`worker.*` fan-out:** worker events reach both their home session channel and `@fleet` → the UI fleet view observes all workers live without opening each session.
- **`@all` fan-out:** every event also reaches `@all` → the desktop's unified monitor subscribes to one channel and sees all sessions/fleet.
- **Per-listener isolation:** `deliver()` wraps each listener in `try/catch`; a throwing listener is logged once (`warnedListeners` WeakSet) and suppressed thereafter, never blocking siblings. Delivery iterates a copy (`[...set]`) so listeners may unsubscribe during dispatch.
- **`@all` subscription dedupe:** done at the consumer, not the bus — `Connection.subscribe` skips per-session/fleet subscriptions once `@all` is subscribed, and tears down existing per-key subscriptions when `@all` is added (prevents double delivery on one socket).

Special `sessionId` values used as routing addresses (not real sessions): `connection.ts` emits `worker.label` with `sessionId:""` and `automation.changed`/`slack.status` with `sessionId: ALL_CHANNEL`.

## CoreEvent variants

`master.*` events are emitted by `master-agent.ts`; persisted ones go to `session_events` via `recordEvent`→`persistEvent` (restored on reconnect/restart through `session.history`). `worker.*` come from `worker.ts`/`fleet-orchestrator.ts`; persisted worker payloads go to `worker_events` via `record`/`persistOnly` (restored via `worker.history`).

| `type` | Key fields | Emitted when | Persisted | Notes |
|---|---|---|---|---|
| `master.message` | `role`, `content`, `clientMsgId?` | user echo at turn start; each assistant text block | yes (`session_events`); assistant text also `addMessage`→`messages` | `clientMsgId` is live-only correlation for the desktop pending bubble; absent from persisted payload |
| `master.message.delta` | `delta` | each `text_delta` partial message chunk | no (live streaming) | token-level stream; coalesced into `master.message` on completion |
| `master.thinking.delta` | `delta` | each `thinking_delta` chunk | no (live) | thinking-summary stream (`display:summarized`) |
| `master.thinking` | `text` | flushed at message/tool/turn boundary (`flushThinking`) | yes | coalesced single entry for restore (deltas are live-only) |
| `master.system` | `text` | uncategorized SDK `system` message | no (live emit only) | from top-level `text`/`subtype` |
| `master.notice` | `text`, `code?`, `params?` | compaction/retry/fallback push; turn-cap; interrupt | yes | `code`+`params` let clients re-localize (desktop i18n); `text` is the `DEFAULT_LOCALE` pre-render |
| `commands.changed` | `scopeId`, `commands` | SDK `commands_changed` push | no | refresh `/` candidates; `scopeId` = sessionId (master) or worker id (worker) |
| `master.result` | `subtype`, `costUsd`, `numTurns`, `durationMs`, `contextTokens`, `contextWindow` | each SDK `result` message | yes | cost/turns cumulative per session; context values are the current turn's |
| `master.status` | `status: running\|idle` | turn start (`running`) / turn end (`idle`) | no (live pulse) | UI session-list activity indicator |
| `session.label` | `label` | auto-label generation fills the session label | no | live refresh of UI session list (the label itself is persisted separately) |
| `worker.spawned` | `workerId`, `repoPath`, `label`, `branch?`, `status?`, `ticketKey?`, `ticketUrl?` | `fleet.spawn` up front (worktree still provisioning) | (row in `workers`) | `status:"provisioning"` so the row shows immediately; omitted ⇒ treated as `running` |
| `worker.event` | `workerId`, `seq`, `data: WorkerEventData`, `clientMsgId?` | every recorded/live worker activity | depends on `data.kind` (see below) | wraps a `WorkerEventData`; `clientMsgId` is live-only echo correlation |
| `worker.nested` | `workerId`, `parentToolUseId`, `data: WorkerEventData` | native nested subagent (SDK Task) activity | no (live only) | grouped by `parentToolUseId` in the desktop `NestedAgents` panel |
| `worker.status` | `workerId`, `status` | `Worker.transition` and `FleetOrchestrator.setStatus` | (state in `workers`) | union `running\|idle\|stopped\|done\|error` + orchestrator-only `failed`/`orphaned` |
| `worker.label` | `workerId`, `label` | auto-label update; `worker.rename` (with `sessionId:""`) | (label in `workers`) | live UI fleet-row update |
| `master.tool` | `toolId`, `name`, `phase: start\|end\|progress`, `ok?`, `input?`, `result?`, `elapsedSec?` | tool_use (`start`), tool_result (`end`), tool_progress (`progress`) | `start`/`end` yes; `progress` no | master MCP/tool calls; `name` only on `start`; `result` truncated to 2000 |
| `slack.status` | `status: SlackStatus` | `SlackController` state transition; initial sync on `events.subscribe` | no | `unconfigured\|off\|connecting\|up\|error`; broadcast to `ALL_CHANNEL` |
| `interaction.request` | `requestId`, `kind: approve\|ask`, `toolName?`, `inputText?`, `questions?` | master `canUseTool` surfaces approval/AskUserQuestion to non-Slack clients | no | master turn waits for `interaction.respond`; `requestId` = toolUseID |
| `interaction.resolved` | `requestId`, `summary` | a pending interaction is answered | no | replaces the card with a summary; syncs other clients/reloads |
| `automation.changed` | (`sessionId: @all`) | automation create/update/set_enabled/delete/run; dispatcher run | no | UI `AutomationPage` refetches |
| `error` | `message` | master turn failure (`recordEvent`); core error paths | yes (when via `recordEvent`) | |

## WorkerEventData kinds (`data` of `worker.event` / `worker.nested`)

`Worker` records via three paths: `record()` (persist to `worker_events` **and** bus-emit), `persistOnly()` (persist only, no emit — restore copy of something already shown via deltas), and `emit()` (bus only, no persist — prevents DB bloat).

| `kind` | Fields | Path / live vs persisted | Notes |
|---|---|---|---|
| `system` | `text` | `record` (persisted + live) | uncategorized SDK system message (top-level `text`/`subtype`) |
| `message` | `role`, `content` | `record` (persisted + live) | assistant text; user echo of a deferred `send` recorded at the turn boundary with `clientMsgId` |
| `message_delta` | `text` | `emit` (live only) | token-level text stream |
| `thinking_delta` | `text` | `emit` (live only) | thinking-summary stream (`display:summarized`) |
| `thinking` | `text` | `persistOnly` (persist only) | coalesced summary for restore; live is shown via `thinking_delta` |
| `tool_use` | `id`, `name`, `input` | `record` (persisted + live) | `input` truncated to 4000 |
| `tool_result` | `id`, `isError`, `content` | `record` (persisted + live) | `content` truncated to 4000 |
| `tool_progress` | `id`, `elapsedSec` | `emit` (live only) | elapsed seconds of an in-progress tool |
| `result` | `subtype`, `costUsd`, `numTurns`, `durationMs?`, `contextTokens?`, `contextWindow?`, `terminalReason?` | `record` (persisted + live) | cost/turns cumulative; drives maxTurns cap + idle/deferred transition; `terminalReason` is the provider's `terminal_reason` (worker only) |
| `notice` | `text` | `record` (persisted + live) | compaction/retry/fallback push, or turn-cap message |
| `error` | `message` | `record` (persisted + live) | not recorded if the abort came from stop/discard |

For `worker.nested` (native subagent via SDK Task), only `message`/`tool_use`/`tool_result` kinds flow, always live-only (never persisted), grouped by `parentToolUseId`.

## Persistence / restore summary

- **Master:** `recordEvent`→`persistEvent` writes to `session_events` (`master.message`, `master.thinking`, `master.notice`, `master.result`, `master.tool` start/end, `error`). On reconnect/restart `session.history` replays them (tool/thinking/metrics/notice all restored). Live-only (never persisted): `master.message.delta`, `master.thinking.delta`, `master.system`, `master.status`, `master.tool` `progress`, `session.label`, `commands.changed`.
- **Worker:** `record`/`persistOnly` write to `worker_events`; `worker.history` replays them. Live-only: `message_delta`, `thinking_delta`, `tool_progress`, and all `worker.nested`.
- See `src/persistence/repositories.ts` (`addSessionEvent`/`listSessionEvents`, `addWorkerEvent`/`transcript`).
