# Architecture overview

> **Source of truth:** `src/daemon/server.ts`, `src/core/events.ts`, `src/core/session-manager.ts`, `src/daemon/connection.ts` — the code is authoritative; this doc explains concepts and flows. The always-loaded map/conventions live in [../../AGENTS.md](../../AGENTS.md); this goes deeper.

This is the system shape and the end-to-end request/event flow. For term definitions see [../glossary.md](../glossary.md); the AGENTS.md [§Architecture](../../AGENTS.md) is the short version.

## System shape

A resident **daemon** is the only stateful process. It:

- hosts **master agent** sessions (one session = one conversation, built on the Claude Agent SDK),
- owns the single **fleet** (`FleetOrchestrator`) through which the master spawns **workers**, each isolated in its own git **worktree**,
- serves `/health` over HTTP and `/ws` over WebSocket.

The **CLI**, the **Electron desktop app**, and **Slack** are **thin clients**: they attach over WebSocket, send protocol commands, and render the event stream. The daemon survives client disconnects — it does not kill sessions or workers when a client goes away. (Slack is embedded in the daemon process rather than being a separate socket client, but is still just an adapter; see [automation.md](automation.md) and AGENTS.md §Slack adapter.)

## Request and event flow

Two directions cross the WS boundary: **commands flow in**, **`CoreEvent`s flow out**.

```
  thin client (CLI / desktop / Slack)
        │  WS frame (JSON)
        ▼
  Connection  (src/daemon/connection.ts)
   • validates inbound with zod clientMessageSchema (discriminated union)
   • subscribes to EventBus channels; correlates replies by reqId
        │  domain command
        ▼
  SessionManager ──► MasterAgent.runTurn(text)        (src/core/master-agent.ts)
        │                 │
        │                 ├─► query()            SDK turn (string prompt + resume)
        │                 ├─► MCP tool servers   memory / repos / fleet (+ capability overlay)
        │                 └─► FleetOrchestrator  spawn/stop/inspect workers
        │                          │
        │                          └─► Worker.run()   query() + MessageQueue (streaming)
        │                                   │  cwd: worktree, git/gh via Bash
        ▼                                   ▼
            both emit CoreEvent ──► EventBus.emit()      (src/core/events.ts)
                                        │ fan-out to channels:
                                        │   • sessionId         (the session's own events)
                                        │   • @fleet  FLEET_CHANNEL  (all worker.* events)
                                        │   • @all    ALL_CHANNEL    (every event)
                                        ▼
                              subscribed Connections
                                        │  ServerMessage (JSON.stringify, no schema)
                                        ▼
                              back to the thin client(s)
```

Key properties:

- **Inbound is schema-validated** (`clientMessageSchema`); **outbound is not** (plain `JSON.stringify` of `ServerMessage`). `reqId` correlates a request with its response; some fire-and-forget messages have none. See [../reference/protocol.md](../reference/protocol.md).
- **One emit, many channels.** `EventBus.emit` always delivers to the event's `sessionId`; additionally to `@fleet` for any `worker.*` event, and to `@all` for everything. A desktop "mission control" view subscribes to `@all` alone and sees every session and the whole fleet live; per-session subscriptions are deduped against `@all`. Each listener is wrapped in try/catch so one bad listener can't break fan-out. See [../reference/events.md](../reference/events.md).
- **Master vs worker input models differ** — master gets a string prompt + `resume`; worker gets a streaming `MessageQueue`. This distinction is the spine of the codebase; see [master-worker-turn.md](master-worker-turn.md).
- **Per-session capability overlay.** `makeCanUseTool` and `makeCapabilities` are keyed off the session's `externalKey`, so a Slack-origin session routes approvals to the Slack thread and gains the `read_thread` tool, while every session gains `schedule_*`. Wired in `startDaemon()`.

## Ports and adapters

`src/core/` is **transport-agnostic**: it never imports WS, CLI, Slack, or Electron code. It is driven by domain commands and only emits `CoreEvent` through the `EventBus`. Every external boundary is an **injectable port with a fake** for tests:

| Port | Real adapter | Fake (tests) |
|---|---|---|
| `QueryFn` (SDK `query()`) | `@anthropic-ai/claude-agent-sdk` `query` | `test/helpers/fake-query.ts` (`fakeQuery`) |
| `GitOps` (all git/gh shell-outs) | `RealGitOps` (`src/core/git-ops.ts`) | `FakeGitOps` |
| `Repositories` (SQLite) | `new Repositories(openDb(path))` | `openDb(":memory:")` |
| `SlackClient` / slack config | bolt Socket Mode (`src/slack/`) | injected resolvers |

**All wiring happens in exactly one place: `startDaemon()` of `src/daemon/server.ts`** — the single composition root. It opens the DB, constructs the `EventBus`, `Settings`, `FleetOrchestrator`, `SessionManager`, the Slack controller, the automation `Scheduler`/`Dispatcher`, the usage collector, and the WS server, then injects the ports into the core as interfaces. To add a dependency, assemble it there and pass it in; the core only ever receives interfaces. This is why unit tests can run the whole engine without a real SDK, git, or network (see [../guides/testing.md](../guides/testing.md)).

## Where to go deeper

- **A single turn, master and worker:** [master-worker-turn.md](master-worker-turn.md)
- **Spawn / stop / discard / restart rehydration:** [fleet-lifecycle.md](fleet-lifecycle.md)
- **Cron + Slack automation:** [automation.md](automation.md)
- **The daemon wire protocol and event catalog:** [../reference/protocol.md](../reference/protocol.md), [../reference/events.md](../reference/events.md)
- **Persistence schema:** [../reference/data-model.md](../reference/data-model.md)
