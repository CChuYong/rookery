# Master & Worker Turn Lifecycle

> **Source of truth:** `src/core/master-agent.ts`, `src/core/worker.ts`, `src/core/session-manager.ts`, `src/core/message-queue.ts`, `src/core/thinking-coalescer.ts` — the code is authoritative; this doc explains concepts and flows. The always-loaded map/conventions live in [AGENTS.md](../../AGENTS.md); this goes deeper.

The master and the worker both wrap the SDK `query()`, but they feed it **two different input models**. Confusing them is the most common source of bugs in this codebase. See AGENTS.md §"Master vs Worker".

## The two input models

| | Master (`MasterAgent`) | Worker (`Worker`) |
|---|---|---|
| Input to `query()` | a string, or **finite one-message native image iterable**, per turn | a long-lived **`MessageQueue`** (streaming input) |
| Continuation | SDK `resume: sdk_session_id` (new `query()` each turn) | same `query()` stays alive; follow up via `send()` |
| Serialization | per-session `turnChain` promise | SDK pops the queue at turn boundaries |
| MCP servers | memory/repos/fleet + per-source overlay | **none** (default `claude_code` toolset only) |
| `cwd` | session cwd | the worker's worktree |
| Lifecycle end | each turn's generator ends naturally | only ends when the queue is **closed** |

### Master: finite input + resume

`MasterAgent.enqueueTurn(text, override?)` validates the complete text/image input and chains onto `turnChain`, returning `{completion: Promise<void>}`. `runTurn` awaits that promise; WS `session.send` acknowledges acceptance immediately:

```
this.turnChain = (this.turnChain.then(() => this.doTurn(...))).catch(() => {})
```

Turns are **strictly serialized per session**: two concurrent `runTurn` calls run one at a time, and a failed turn does not contaminate the chain (its error still propagates to that caller, but `turnChain` itself is protected by `.catch`). `doTurn` (`master-agent.ts:211`) builds one `query()` call with a string input for text-only turns or native resolved images for an image-bearing turn and, if a prior turn established one, `resume: this.sdkSessionId`. The SDK session id is captured from the `result` message (`master-agent.ts:336`) and persisted via `repos.setSdkSessionId`, so the next turn resumes context.

`idle()` returns `turnChain` and is used by the shutdown drain (`SessionManager.drain`, `session-manager.ts:142`) so `db.close()` runs after the master's DB writes finish.

### Worker: streaming MessageQueue

`Worker` holds one `MessageQueue` (`src/core/message-queue.ts`) and passes it as `prompt` to `query()` inside `consume()` (`worker.ts:253`). The provider-neutral queue is an `AsyncIterable<AgentInput>`; the adapter wraps native provider messages: `push(input)` either hands the message to a waiting iterator or buffers it; `close()` resolves all waiters with `done:true`, which is the **only** way the SDK generator ends (`worker.ts:375`). Because the iterator never ends on its own, a real worker terminates by `stop()` (close + abort), not by running out of input.

`start(task?)` (`worker.ts:90`): with a task it pushes it and records the first user message; task-less it goes straight to `idle` and waits for the first `send()`. `resume()` (`worker.ts:106`) restarts a saved SDK session after a daemon restart without a new task (continuing the persisted `seq`).

## Turn lifecycle

### Master turn (`doTurn`)
1. Resolve per-turn speed intent, image bytes and `model`/`effort`/`permissionMode` (override → resolver/default), `caps = capabilities?.()`.
2. Emit `master.status running`, persist session status `running`.
3. Record the user message (`master.message`) — **unless** `asNotice` (worker-notification turns are recorded as `master.notice`, no relabel). Kick off `maybeLabel` concurrently.
4. Immediately before `startTurn`, resolve the target's secret-free managed projection, publish desired state, fail before provider spawn if blocked, and pass `runtimeKey` + `capabilities`. Claude materializes/loads the revision synchronously; successful stream creation marks it applied.
5. Iterate the stream: `stream_event` → text/thinking deltas; `assistant` → flush thinking, record message + tool starts; `user` → record tool results; `system` → classify (`commands.changed` / `master.notice` / `master.system`); `tool_progress` → progress; `result` → capture `sdk_session_id`, accumulate `cumCostUsd`/`cumTurns`, record `master.result`, emit `notice.turnCap` if `maxTurns` reached (**warning only — master is never aborted**).
6. `catch`: a pre-application failure records a sanitized capability-runtime error; a user-stop abort is surfaced as `notice.interrupted` and resolves normally; any other error records `error` and rethrows.
7. `finally`: flush trailing thinking, release abort handle, emit `master.status idle`, persist `idle`, await label.

`stop()` (`master-agent.ts:144`) aborts the current `AbortController` and calls `query.interrupt()`; the notice is emitted from the catch (after the stream drains) so it lands after the text, not mid-stream.

### Worker turn (`consume` loop)
Same message taxonomy, with extra handling:
- At each provider-stream `consume()` entry, resolve managed capabilities exactly once, publish desired state, and pass the immutable projection to `openSession`. The first provider frame confirms the revision applied. Later registry changes do not mutate that stream; snapshots report `pending-reload` until a controlled replacement.
- `requestCapabilityReload` replaces only the provider stream and queue. Idle workers reload immediately; busy workers accept only `whenIdle` and start replacement after the active result reaches idle. A synchronous `onBegin` gate makes `worker.send` fail only during replacement. The replacement resumes the same provider-native session id and preserves the worker row, worktree, transcript sequence, settings, budgets, cumulative cost/turns, and lifetime settlement promise. Setup failure records a notice/runtime error and returns to idle so the user can retry.
- **Native nested subagent** messages carry `parent_tool_use_id` and are emitted live-only via `emitNested` (no persistence), keyed by `parentToolUseId`; their `stream_event`/`system`/`tool_progress`/`result` are ignored so they never touch the parent's state/`sdkSessionId`. Enabled by `forwardSubagentText:true`.
- **Claude Dynamic Workflow** launch and task frames take a separate path: the Claude adapter strictly sanitizes raw `task_progress.workflow_progress` (the live source behind Claude Code's `/workflows` UI) into phase and agent-identity metadata, and the Worker forwards it to the optional `WorkflowActivitySink`. The adapter releases completed task ids after the terminal notification. The daemon registry validates/tails the workflow journal and per-agent transcripts for membership/status/activity, while independently validating and polling the sibling run snapshot as recovery/enrichment for phase detail/model fields; terminal drains accept a final JSONL record without a trailing newline, and permanent Worker deletion releases the registry entry. Scripts, prompts, logs, results, previews, and paths never enter CoreEvents. It emits summary-only `worker.workflow.*` events and serves reconnect snapshots/lazy selected-agent history; none of these events are written to `worker_events`. The existing `background_task(s)` frames remain the sole authority for Worker `running/background/idle` state.
- On `result`: capture `sdk_session_id`, accumulate cost/turns, record `result`. `maxTurns` for a worker is **enforced** (compare `r.num_turns` directly, not `cumTurns`): on cap it records a notice, interrupts, closes the queue, aborts, transitions `stopped`, clears `deferred`.
- After `result`, the **deferred-echo** drain runs (below). If a steer request is still in flight, the boundary waits for its outcome (bounded by the steer timeout) and the worker stays `running`. If nothing is deferred and the worker is still `running`, it transitions to `idle`.

`stop()` vs `interruptTurn()` (`worker.ts:163`, `:184`): `stop` closes the queue + aborts (terminal `stopped`); `interruptTurn` only aborts the current turn (keeps the queue open, parity with master `stop`). Both synchronously splice `deferred` **before** any `await` (ordering is load-bearing — otherwise the consume loop could shift a deferred item as a ghost turn).

## Mid-turn `send`: steering first, deferred echo as fallback

When a worker is mid-turn and a new instruction arrives, it is **steered into the running turn** when possible; otherwise its user echo is recorded **at the next turn boundary** (the deferred FIFO). Masters, Side conversations and automations never steer — they keep turn-boundary serialization.

- **Worker** (`worker.ts` `send`): if no turn is active (`idle` or `background`), start a new turn immediately (echo + checkpoint now, transition `running`).
- **Steer (primary path)**: if a turn is active, the stream exposes `steer()`, nothing is already deferred, and no other steer is in flight, `beginSteer` calls `stream.steer(input, clientMsgId)` — Codex: app-server `turn/steer` against the active turn; Claude: a push onto the streaming input with `priority: "next"`. The request races `STEER_TIMEOUT_MS` (5000 ms, injectable as `steerTimeoutMs`). On acceptance `settleSteer` records the user echo right away — it is part of the current turn, so no boundary bookkeeping is needed. A late acceptance after the timeout is ignored by the worker: no second echo, and the fallback owns the message. **Known limitation:** a Codex server that accepts `turn/steer` after the timeout has still delivered it, so the fallback delivers it a second time as its own turn — the model can see the message twice (Claude acceptance is synchronous, so this needs Codex). If a Claude steer is accepted after the turn already ended, the input is answered as a new turn: the adapter flags that `turn_end` `steerPending` and the worker holds `running` with the settle-grace until the follow-up turn's `init`. A Claude worker's system-prompt append (`WORKER_SYSTEM_APPEND`) also tells the model that these mid-turn messages ("The user sent a new message while you were working") come from the operator, unless fenced as untrusted — without it, Haiku/Sonnet 5.5 refused imperative steers as suspected prompt injection.
- **Deferred FIFO (fallback)**: if steering isn't possible (no steer support, rejected, timed out, or an older instruction is already deferred or being steered — a newer send never overtakes an older one), the entry (text, image refs, captured speed, `clientMsgId`) is held in `deferred`. A rejected/timed-out steer goes to the **front** of the FIFO; if the turn already ended while it was pending, it is dispatched immediately as the next turn. At the next `result`, `deferred.shift()` records the user message and re-runs `onTurnStart` so the checkpoint is taken right before the actual turn. Why not enqueue mid-turn: the `MessageQueue` would let the SDK read ahead and coalesce the message into the in-flight turn with no following turn, leaving the echo stuck. The desktop shows a `pendingByWorker` "waiting" bubble meanwhile and reconciles it with the echo via `clientMsgId`.
- **Teardown**: `stop()`/`abandon()` claim an in-flight steer (its late settle becomes a no-op) and drop it with the deferred entries; `interruptTurn()` only marks it — if the provider accepted it, it was delivered; otherwise it is dropped like the other queued instructions. A Claude steer is accepted (and echoed) the moment it is pushed, but it waits in the SDK's in-memory queue until a tool boundary or the next turn; the adapter keeps it in `pendingSteers()` until a result's `user_message_uuids` lists it. If `abandon()` (recover) kills the subprocess, or the stream errors, while an accepted steer is still pending, the worker records a retryable `error` for it (`clientMsgId` + `retryInput`, same as deferred entries on a stream error), so the desktop offers a resend. An interrupt does not lose it: live, the SDK's interrupt receipt lists it in `still_queued` and answers it as its own follow-up turn, which the `steerPending` hold covers without a transient `idle`. To make a worker abandon its current work, the master calls `interrupt_worker` then `send_worker`.
- **Master** parity: serialization is via `turnChain` (a follow-up `runTurn` simply queues), and worker-completion notifications coalesce via `notifyWorker` (`master-agent.ts:194`) — buffered into **one** follow-up turn flushed when the current turn ends, recorded as `master.notice` (`asNotice`). If that flush turn fails, the lines are persisted to `pending_notifications` for retry (drained by `SessionManager.build`, `session-manager.ts:71`). Stranded rows are also re-drained in-process: every subsequent notification flush prepends them (older first), and every user `runTurn` re-injects them as a follow-up notice turn — a live session no longer needs a daemon restart to retry.

## Model / effort / name as resolvers

`MasterAgentDeps.model`/`effort`/`name` are `() => string`, **re-evaluated every turn** inside `doTurn` (`master-agent.ts:215`, `:222`, and `buildSystemPrompt` `:170`). `SessionManager.build` (`session-manager.ts:56`) passes the `Settings` resolvers straight through (wrapping a plain string in `() => value` only if a non-function was supplied). Snapshotting them to strings at session-creation time would break live `Settings` changes. Effort is gated by `effortApplies(model) && coerceEffort(effort)` (passing effort to Haiku is an API 400). A worker, by contrast, fixes `model`/`effort` at spawn but can hot-swap the model live via `setModel` (`query.setModel`).

## Thinking coalescing

`ThinkingCoalescer` (`src/core/thinking-coalescer.ts`) is shared by both. Thinking summary tokens arrive as `thinking_delta` stream events: each is `push`ed to the buffer and **also emitted live** (`master.thinking.delta` / worker `thinking_delta`). At each message/tool/turn boundary `flushThinking()` writes the accumulated buffer as a **single persisted** entry (`master.thinking` via `persistEvent`, worker `thinking` via `persistOnly` — persist only, no second live emit, since deltas already streamed). `reset()` clears leftover at turn start. This keeps the live experience token-level while persistence stays one coalesced block per step (no DB bloat / no duplicate render on restore).

## Per-turn capability overlay

The master's tools are assembled per turn (`doTurn`, `master-agent.ts:222-273`) as **base + overlay**:
- **Base** (always): MCP servers `memory` / `repos` / `fleet`, allowlist `MEMORY_TOOL_NAMES ∪ REPO_TOOL_NAMES ∪ FLEET_TOOL_NAMES` (+ `AskUserQuestion` only when a `canUseTool` handler exists).
- **Overlay** `caps = capabilities?.()` (`TurnCapabilities`, `master-agent.ts:36`): `mcpServers` (+, caps wins on key collision), `allowedTools` (+), `systemPromptAppend` (+, kept fixed within a session to preserve the cache prefix), `denyTools` (−, filtered out of the allowlist).
- `disallowedTools: NATIVE_SCHEDULE_TOOLS` always removes the harness's native schedule/watch tools (they no-op in a headless `query()`); the daemon re-exposes equivalent `schedule_*` MCP tools through the overlay instead.

`SessionManager` builds the overlay resolver via `makeCapabilities(externalKey, sessionId)` — e.g. a Slack-origin session gets `slack-thread` tools, an automation session gets `schedule` tools. This path is distinct from managed packs. Workers still receive none of Rookery's in-process memory/repo/fleet/schedule servers, but a trusted managed pack may add its own provider-native MCP through a generated Claude plugin or isolated Codex home.

## Managed provider capability runtime

The resolver emits a secret-free projection with a deterministic revision. `CapabilityRuntime`
copies each selected pack into `~/.rookery/capability-runtime/<revision>/source/`, revalidates
the copied digest, then atomically publishes generated plugins under
`claude/rookery-<pack-id>-<instance-hash>/`. Direct Rookery master tool servers remain on
the existing SDK `mcpServers` path; managed MCP lives in each plugin's `.mcp.json` and uses
`${ROOKERY_CAP_SECRET_*}` aliases. Values exist only in the Claude child `env` overlay.
Because Claude's plugin loader does not apply the portable pack `cwd` field when spawning a
stdio server, the materializer replaces that field with an immutable generated Node launcher
and a public launch descriptor. The launcher uses `spawn()` directly (no shell), inherits the
already-resolved environment, and keeps every secret value out of generated files and argv.
Native Claude filesystem settings stay additive (`settingSources` is not disabled).

The same immutable source tree also produces Codex-native skill and MCP TOML. Every master
and worker receives a separate `~/.rookery/codex-homes/<target>/` assembled from the user's
base config without writing it; master homes contain both the Rookery MCP bridge and managed
servers. HTTP credentials use environment-backed aliases. Stdio secrets are translated by
an immutable direct-spawn launcher, so values stay in the child environment and out of TOML,
argv, descriptors, events, and logs. Homes are compiled before initial/lazy stream open.
Native same-provider forks run in the source home, then copy only the fork rollout and its
ancestors into the target home; target bindings compile independently on first resume.
Because Codex 0.144.x captures its inherited environment in on-disk shell snapshots before
applying shell policy, secret-bearing launches add fixed public overrides that disable that
snapshot feature and exclude `ROOKERY_CAP_SECRET_*` from model-invoked shell environments.
The override strings contain neither secret names nor values.

At daemon boot, repo-shared reconciliation runs before runtime GC. The daemon resolves the
current desired revision for every authoritative session and worker, then
`gcCapabilityRuntime` keeps only matching 64-hex directories with a regular schema-2 marker
whose embedded revision equals the directory name. Stale/invalid revisions and `.tmp-*`
staging entries are removed; unknown names, non-directory revision-shaped files, and
symlinks outside that owned set are never traversed.

## Sessions

`SessionManager` (`src/core/session-manager.ts`) owns the live `Map<id, Session>` and lazily rebuilds a cold session from its DB row on `get` (`session-manager.ts:93`). `create`/`getOrCreateByKey` derive `origin`/`originRef` from the `external_key` prefix (`deriveOrigin`: `slack:` / `automation:` / else `ui`). The `UI_FLEET_SESSION_KEY` / `AUTOMATION_FLEET_SESSION_KEY` container sessions are hidden from `list()`.

See also: [fleet-lifecycle.md](./fleet-lifecycle.md), [automation.md](./automation.md), `../reference/events.md`.

## Speed and native images at the turn boundary

Core receives `AgentInput` through an injectable `ImageResolver`; the daemon owns storage and composition. Queue state contains only refs. Validation rejects the whole invalid input before acceptance, and dispatch resolves again before an echo/provider call. The deferred FIFO keeps each message's images and requested speed together. Claude's Worker input pump awaits its flag control before native delivery; a control failure is owned by the adapter and becomes a visible original error. Master/Side image input is finite, preserving natural completion instead of leaving a streaming queue open. Codex sends image data URLs and `serviceTierForTurn` per native turn.

`master.speed` / Worker `speed` are persisted observations, separate from selected preference. Cost results carry captured requested speed and reported/estimated/unavailable quality. Cold-resume incomplete accounting remains incomplete, and budgeted Workers stop at boundaries rather than continuing with an unknown total. Details: [speed](../reference/speed.md), [image retention and retry](../reference/images.md).

Queue acceptance lets the desktop clear the accepted draft and immediately compose a follow-up while work continues. Echoes and pre-echo errors retain `clientMsgId`; a dispatch failure includes refs in `retryInput` so replay can restore the same input. Draft revision guards prevent a late acceptance from clearing a newer draft, and target/generation guards prevent late imports from crossing navigation. This adds no durable server queue. Same-provider forks share native image history and refs; cross-provider forks retain the existing textual summary only, with newly attached images delivered natively.
