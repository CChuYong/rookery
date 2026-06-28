# rookery docs — agent entry map

> **Source of truth:** `src/...` — the code is authoritative; these docs explain concepts and flows. The always-loaded map/conventions live in [AGENTS.md](../AGENTS.md); this goes deeper.

rookery is an orchestrator agent with memory. A resident **daemon** hosts **master agent** sessions built on the Claude Agent SDK, and the master spawns, controls, and observes a **worker fleet isolated per worktree** of registered git repos. The CLI, the Electron app, and Slack are all **thin clients** that attach to the daemon over WebSocket — the daemon survives client disconnects and does not kill sessions or workers.

## Start here

Read the root [AGENTS.md](../AGENTS.md) **first**. It is the always-loaded map: directory layout, build/run commands, the architecture summary, environment variables, and the fragile-convention pitfalls (Node 22 ABI, ESM `.js` imports, append-only migrations, etc.). The docs in this tree are **on-demand depth** — open one when you need the flow or catalog it covers. Where AGENTS.md already summarizes something, these docs link back instead of repeating it.

## Table of contents

| Doc | When to read it |
|---|---|
| [glossary.md](glossary.md) | You hit a term (master/worker/fleet/session/worktree/nested subagent/capability overlay) and want its precise meaning + source file. |
| [architecture/overview.md](architecture/overview.md) | You need the system shape and the end-to-end request/event flow before changing anything. |
| [architecture/master-worker-turn.md](architecture/master-worker-turn.md) | You are touching how a master turn (string prompt + resume) or a worker turn (streaming `MessageQueue`) runs. |
| [architecture/fleet-lifecycle.md](architecture/fleet-lifecycle.md) | You are working on spawn/stop/discard, worktree isolation, terminal-state writes, or restart rehydration. |
| [architecture/automation.md](architecture/automation.md) | You are working on cron/Slack triggers, the dispatcher, or automation actions (master/worker). |
| [reference/events.md](reference/events.md) | You need the `CoreEvent` catalog and which `EventBus` channel each event flows on. |
| [reference/protocol.md](reference/protocol.md) | You need the WS wire schema (client→daemon / daemon→client messages, `reqId` correlation). |
| [reference/data-model.md](reference/data-model.md) | You need the SQLite tables/columns and the migration rules. |
| [reference/settings-and-env.md](reference/settings-and-env.md) | You need the settings keys (DB) and environment variables and how they resolve. |
| [guides/add-a-fleet-tool.md](guides/add-a-fleet-tool.md) | You are adding a master-facing MCP tool. |
| [guides/add-a-protocol-message.md](guides/add-a-protocol-message.md) | You are adding a new WS client/server message. |
| [guides/add-a-db-migration.md](guides/add-a-db-migration.md) | You are changing the SQLite schema. |
| [guides/add-an-automation-trigger.md](guides/add-an-automation-trigger.md) | You are adding a new trigger kind (webhook/reaction/interval). |
| [guides/add-an-i18n-string.md](guides/add-an-i18n-string.md) | You are adding a user-facing daemon string or `notice.*` code. |
| [guides/testing.md](guides/testing.md) | You are writing or running tests (fake ports, `fakeQuery`, in-memory DB). |

## How these docs are organized

- **`architecture/`** — flows and *why*. How the pieces move at runtime and the reasoning behind the shape.
- **`reference/`** — catalogs. Exhaustive lists (events, protocol messages, tables, settings) you look things up in.
- **`guides/`** — how-to recipes. Step-by-step procedures for common extension tasks.

These docs are **evergreen current-state reference** — they describe how the code works now. Dated design specs and implementation plans are **not** kept in this repo; if produced during development they stay out of `docs/` (local scratch), so this tree never goes stale as a pile of historical records.
