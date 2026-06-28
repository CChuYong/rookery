# Glossary

> **Source of truth:** `src/core/`, `src/tools/`, `src/daemon/` — the code is authoritative; this doc explains concepts. The always-loaded map/conventions live in [AGENTS.md](../AGENTS.md); this goes deeper.

This is the precise vocabulary of the codebase. The root [AGENTS.md §Glossary](../AGENTS.md) is the short version; this adds source pointers and edge cases.

## Reserved-word caveat (read this first)

The words **"agent"** and **"subagent"** are **reserved for the native SDK `Task`-tool concept** (see *Native nested subagent* below). rookery's own spawned units are **always called "worker" / `Worker`**, never "agent" or "subagent". The only exceptions are SDK-owned tokens that must be preserved verbatim: `forwardSubagentText` and `subagent_type`.

## Terms

### Master / MasterAgent
The orchestrator you talk to. One **session** = one master conversation. Driven by `runTurn(text)` which sends a single **string prompt** to the SDK `query()` with `resume: sdk_session_id` to continue context; turns are serialized in a per-session `turnChain`. Emits `master.*` events.
- Source: `src/core/master-agent.ts`; created via `src/core/session-manager.ts`.

### Worker / Worker
A unit the master spawns in isolation inside a **worktree**. Unlike the master it is fed a **`MessageQueue` (streaming input)** so the SDK session stays alive and can take follow-ups via `send()`. It runs the default `claude_code` toolset (Bash/Edit, etc.) with `cwd: worktree` and **receives no MCP tool servers**. Emits `worker.*` events; persisted in the `workers` table.
- Source: `src/core/worker.ts`.

### Fleet / FleetOrchestrator
The entire set of workers — the **control plane**. Exactly **one** `FleetOrchestrator` per daemon (a global pool) is injected into every session, so any session can list/inspect/control the whole fleet. It manages only worker **lifecycle** (spawn → worktree + branch → start; stop/discard; rehydrate on restart); commit/push/PR is done by the worker itself via `git`/`gh` bash.
- Source: `src/core/fleet-orchestrator.ts`. See [architecture/fleet-lifecycle.md](architecture/fleet-lifecycle.md).

### Session
A single master conversation, keyed by an internal id and optionally an `externalKey` (e.g. `slack:team:channel:threadTs`, `automation:<id>`). The `externalKey` prefix derives the session **origin** and selects per-source capabilities and the `canUseTool` route.
- Source: `src/core/session-manager.ts` (`build`, `deriveOrigin`).

### Repo
A registered git repository the master can spawn workers against. Stored in the `repos` table, managed via the repos MCP tools (`register_repo` / `list_repos` / `update_repo` / `remove_repo`). The repo catalog is injected into the master system prompt each turn.
- Source: `src/tools/repo-tools.ts`.

### Worktree
A per-worker isolated git workspace at `~/.rookery/worktrees/<id>` on branch `rookery/<id>`, created with `git worktree add -b … <base>`. Isolation means concurrent workers never collide on a working tree. `discard_worker` removes it (losing uncommitted work); `stop_worker` keeps it.
- Source: `src/core/git-ops.ts` (`RealGitOps`), `src/core/fleet-orchestrator.ts`.

### Native nested subagent
An SDK subagent that a worker (or the master) launches via the `claude_code` **`Task` tool**. It is **live-only and not persisted**, surfaced as `worker.nested` events grouped by `parentToolUseId` (desktop `NestedAgents`). This is the **only** thing the words "agent"/"subagent" refer to in this codebase.
- Source: `src/core/events.ts` (`worker.nested`), `src/core/worker.ts`.

### daemon
The resident process that owns everything: it hosts master sessions and the fleet, serves `/health` (HTTP) + `/ws` (WebSocket), and survives client disconnects without killing sessions or workers. It is the **single composition root** — all dependency wiring happens in `startDaemon()`.
- Source: `src/daemon/server.ts`.

### thin client
The CLI, the Electron desktop app, and Slack. They hold no session state of their own; they **attach to the daemon over WebSocket**, send protocol commands, and render the `CoreEvent` stream. Disconnecting a client does not stop a turn or a worker.
- Source: CLI `src/entrypoints/cli.ts`; desktop `apps/desktop/`; Slack `src/slack/`.

### turn
One unit of model interaction. A **master turn** = one string prompt + `resume`, serialized on `turnChain`. A **worker turn** runs until the SDK emits a `result`; mid-turn `send()`s are deferred so their user echo lands at the next turn boundary.
- Source: `src/core/master-agent.ts` (`runTurn`/`doTurn`), `src/core/worker.ts`. See [architecture/master-worker-turn.md](architecture/master-worker-turn.md).

### EventBus / CoreEvent
The core's only outward channel. `CoreEvent` is the discriminated union of everything the engine emits (`master.*`, `worker.*`, `slack.status`, `interaction.*`, `automation.changed`, …). `EventBus.emit` fans an event out to its `sessionId` channel, plus `@fleet` (`FLEET_CHANNEL`) for `worker.*`, plus `@all` (`ALL_CHANNEL`) for everything. The core never imports transport code; clients subscribe through the daemon `Connection`.
- Source: `src/core/events.ts`. See [reference/events.md](reference/events.md).

### MCP tool server
An in-process server returned by `create*ToolsServer()` → `createSdkMcpServer()`, exposing tools to the **master only** (workers get none). The base set every master turn is **memory / repos / fleet**; `schedule` and per-source servers (e.g. `slack-thread`) are layered on via the turn's capability overlay. Each file's `*_TOOL_NAMES` allowlist constants must stay in sync with the actual `tool()` names or the tool silently can't be called.
- Source: `src/tools/` (`memory-tools.ts`, `repo-tools.ts`, `fleet-tools.ts`, `schedule-tools.ts`, `slack-thread-tools.ts`). See [guides/add-a-fleet-tool.md](guides/add-a-fleet-tool.md).

### automation (trigger / action)
A rule = a **trigger** (`cron` | `slack`) + an **action** (`master` | `worker`). All firings go through the single `AutomationDispatcher.run(a, vars)`; `runAutomationAction` substitutes template vars (`{{message}}`, `{{channel}}`, …, untrusted Slack vars fenced) and runs a master `runTurn` or a worker `fleet.spawn`. Cron next-runs are computed by the `Scheduler`; Slack matches by `src/slack/trigger-source.ts`.
- Source: `src/core/automation-dispatcher.ts`, `src/core/automation-action.ts`, `src/core/scheduler.ts`, `src/core/automation-match.ts`. See [architecture/automation.md](architecture/automation.md).

### capability overlay
A per-session, per-source resolver (`() => TurnCapabilities`) that **adds** MCP servers and `allowedTools` on top of the base master set for a given turn — keyed off the session's `externalKey`. E.g. every master session gets the `schedule_*` tools; Slack-origin sessions additionally get the `slack-thread` `read_thread` tool. Assembled by `makeCapabilities` in the composition root and re-evaluated each turn.
- Source: `src/core/master-agent.ts` (`TurnCapabilities`), `src/core/session-manager.ts` (`makeCapabilities`), `src/daemon/server.ts`.
