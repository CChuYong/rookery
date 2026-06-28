# Master & Worker Turn Lifecycle

> **Source of truth:** `src/core/master-agent.ts`, `src/core/worker.ts`, `src/core/session-manager.ts`, `src/core/message-queue.ts`, `src/core/thinking-coalescer.ts` — the code is authoritative; this doc explains concepts and flows. The always-loaded map/conventions live in [AGENTS.md](../../AGENTS.md); this goes deeper.

The master and the worker both wrap the SDK `query()`, but they feed it **two different input models**. Confusing them is the most common source of bugs in this codebase. See AGENTS.md §"Master vs Worker".

## The two input models

| | Master (`MasterAgent`) | Worker (`Worker`) |
|---|---|---|
| Input to `query()` | a **single string** `prompt` per turn | a long-lived **`MessageQueue`** (streaming input) |
| Continuation | SDK `resume: sdk_session_id` (new `query()` each turn) | same `query()` stays alive; follow up via `send()` |
| Serialization | per-session `turnChain` promise | SDK pops the queue at turn boundaries |
| MCP servers | memory/repos/fleet + per-source overlay | **none** (default `claude_code` toolset only) |
| `cwd` | session cwd | the worker's worktree |
| Lifecycle end | each turn's generator ends naturally | only ends when the queue is **closed** |

### Master: string prompt + resume

`MasterAgent.runTurn(text, override?)` (`src/core/master-agent.ts:186`) chains onto `turnChain`:

```
this.turnChain = (this.turnChain.then(() => this.doTurn(...))).catch(() => {})
```

Turns are **strictly serialized per session**: two concurrent `runTurn` calls run one at a time, and a failed turn does not contaminate the chain (its error still propagates to that caller, but `turnChain` itself is protected by `.catch`). `doTurn` (`master-agent.ts:211`) builds one `query()` call with `prompt: userText` and, if a prior turn established one, `resume: this.sdkSessionId`. The SDK session id is captured from the `result` message (`master-agent.ts:336`) and persisted via `repos.setSdkSessionId`, so the next turn resumes context.

`idle()` returns `turnChain` and is used by the shutdown drain (`SessionManager.drain`, `session-manager.ts:142`) so `db.close()` runs after the master's DB writes finish.

### Worker: streaming MessageQueue

`Worker` holds one `MessageQueue` (`src/core/message-queue.ts`) and passes it as `prompt` to `query()` inside `consume()` (`worker.ts:253`). The queue is an `AsyncIterable<SDKUserMessage>`: `push(text)` either hands the message to a waiting iterator or buffers it; `close()` resolves all waiters with `done:true`, which is the **only** way the SDK generator ends (`worker.ts:375`). Because the iterator never ends on its own, a real worker terminates by `stop()` (close + abort), not by running out of input.

`start(task?)` (`worker.ts:90`): with a task it pushes it and records the first user message; task-less it goes straight to `idle` and waits for the first `send()`. `resume()` (`worker.ts:106`) restarts a saved SDK session after a daemon restart without a new task (continuing the persisted `seq`).

## Turn lifecycle

### Master turn (`doTurn`)
1. Resolve per-turn `model`/`effort`/`permissionMode` (override → resolver/default), `caps = capabilities?.()`.
2. Emit `master.status running`, persist session status `running`.
3. Record the user message (`master.message`) — **unless** `asNotice` (worker-notification turns are recorded as `master.notice`, no relabel). Kick off `maybeLabel` concurrently.
4. Iterate the `query()` stream: `stream_event` → text/thinking deltas; `assistant` → flush thinking, record message + tool starts; `user` → record tool results; `system` → classify (`commands.changed` / `master.notice` / `master.system`); `tool_progress` → progress; `result` → capture `sdk_session_id`, accumulate `cumCostUsd`/`cumTurns`, record `master.result`, emit `notice.turnCap` if `maxTurns` reached (**warning only — master is never aborted**).
5. `catch`: a user-stop abort is surfaced as `notice.interrupted` and resolves normally; any other error records `error` and rethrows (so the caller sees the failure).
6. `finally`: flush trailing thinking, release abort handle, emit `master.status idle`, persist `idle`, await label.

`stop()` (`master-agent.ts:144`) aborts the current `AbortController` and calls `query.interrupt()`; the notice is emitted from the catch (after the stream drains) so it lands after the text, not mid-stream.

### Worker turn (`consume` loop)
Same message taxonomy, with extra handling:
- **Native nested subagent** messages carry `parent_tool_use_id` and are emitted live-only via `emitNested` (no persistence), keyed by `parentToolUseId`; their `stream_event`/`system`/`tool_progress`/`result` are ignored so they never touch the parent's state/`sdkSessionId`. Enabled by `forwardSubagentText:true`.
- On `result`: capture `sdk_session_id`, accumulate cost/turns, record `result`. `maxTurns` for a worker is **enforced** (compare `r.num_turns` directly, not `cumTurns`): on cap it records a notice, interrupts, closes the queue, aborts, transitions `stopped`, clears `deferred`.
- After `result`, the **deferred-echo** drain runs (below). If nothing is deferred and the worker is still `running`, it transitions to `idle`.

`stop()` vs `interruptTurn()` (`worker.ts:163`, `:184`): `stop` closes the queue + aborts (terminal `stopped`); `interruptTurn` only aborts the current turn (keeps the queue open, parity with master `stop`). Both synchronously splice `deferred` **before** any `await` (ordering is load-bearing — otherwise the consume loop could shift a deferred item as a ghost turn).

## Deferred echo (mid-turn `send`)

When the master/worker is mid-turn and a new instruction arrives, the user echo is recorded **at the next turn boundary**, not the moment it is sent. Why: the worker's `MessageQueue` only hands the message to the SDK on the next turn, so recording the echo immediately would wedge it into the middle of the in-progress turn's output.

- **Worker** (`worker.ts:138` `send`): if `idle`, start a new turn immediately (echo + checkpoint now, transition `running`). If `running`, push `deferred.push({text, clientMsgId})`. At the next `result` (`worker.ts:364`), `deferred.shift()` (FIFO) records the user message and re-runs `onTurnStart` so the checkpoint is taken right before the actual turn. The desktop shows a `pendingByWorker` "waiting" bubble meanwhile and reconciles it with the echo via `clientMsgId`.
- **Master** parity: serialization is via `turnChain` (a follow-up `runTurn` simply queues), and worker-completion notifications coalesce via `notifyWorker` (`master-agent.ts:194`) — buffered into **one** follow-up turn flushed when the current turn ends, recorded as `master.notice` (`asNotice`). If that flush turn fails, the lines are persisted to `pending_notifications` for retry (drained by `SessionManager.build`, `session-manager.ts:71`).

## Model / effort / name as resolvers

`MasterAgentDeps.model`/`effort`/`name` are `() => string`, **re-evaluated every turn** inside `doTurn` (`master-agent.ts:215`, `:222`, and `buildSystemPrompt` `:170`). `SessionManager.build` (`session-manager.ts:56`) passes the `Settings` resolvers straight through (wrapping a plain string in `() => value` only if a non-function was supplied). Snapshotting them to strings at session-creation time would break live `Settings` changes. Effort is gated by `effortApplies(model) && coerceEffort(effort)` (passing effort to Haiku is an API 400). A worker, by contrast, fixes `model`/`effort` at spawn but can hot-swap the model live via `setModel` (`query.setModel`).

## Thinking coalescing

`ThinkingCoalescer` (`src/core/thinking-coalescer.ts`) is shared by both. Thinking summary tokens arrive as `thinking_delta` stream events: each is `push`ed to the buffer and **also emitted live** (`master.thinking.delta` / worker `thinking_delta`). At each message/tool/turn boundary `flushThinking()` writes the accumulated buffer as a **single persisted** entry (`master.thinking` via `persistEvent`, worker `thinking` via `persistOnly` — persist only, no second live emit, since deltas already streamed). `reset()` clears leftover at turn start. This keeps the live experience token-level while persistence stays one coalesced block per step (no DB bloat / no duplicate render on restore).

## Per-turn capability overlay

The master's tools are assembled per turn (`doTurn`, `master-agent.ts:222-273`) as **base + overlay**:
- **Base** (always): MCP servers `memory` / `repos` / `fleet`, allowlist `MEMORY_TOOL_NAMES ∪ REPO_TOOL_NAMES ∪ FLEET_TOOL_NAMES` (+ `AskUserQuestion` only when a `canUseTool` handler exists).
- **Overlay** `caps = capabilities?.()` (`TurnCapabilities`, `master-agent.ts:36`): `mcpServers` (+, caps wins on key collision), `allowedTools` (+), `systemPromptAppend` (+, kept fixed within a session to preserve the cache prefix), `denyTools` (−, filtered out of the allowlist).
- `disallowedTools: NATIVE_SCHEDULE_TOOLS` always removes the harness's native schedule/watch tools (they no-op in a headless `query()`); the daemon re-exposes equivalent `schedule_*` MCP tools through the overlay instead.

`SessionManager` builds the overlay resolver via `makeCapabilities(externalKey, sessionId)` (`session-manager.ts:35`) — e.g. a Slack-origin session gets `slack-thread` tools, an automation session gets `schedule` tools. Base behavior is unchanged when no overlay is injected. Workers receive **no** MCP servers at all (only `WORKER_FENCE_INSTRUCTION` appended to the `claude_code` preset) — they cannot spawn fleet or touch memory.

## Sessions

`SessionManager` (`src/core/session-manager.ts`) owns the live `Map<id, Session>` and lazily rebuilds a cold session from its DB row on `get` (`session-manager.ts:93`). `create`/`getOrCreateByKey` derive `origin`/`originRef` from the `external_key` prefix (`deriveOrigin`: `slack:` / `automation:` / else `ui`). The `UI_FLEET_SESSION_KEY` / `AUTOMATION_FLEET_SESSION_KEY` container sessions are hidden from `list()`.

See also: [fleet-lifecycle.md](./fleet-lifecycle.md), [automation.md](./automation.md), `../reference/events.md`.
