# 2026-07-06 — P1: Codex worker backend (spec)

Phase 1 of `docs/2026-07-05-codex-backend-parity.md`: rookery workers runnable on **OpenAI Codex** via the `AgentBackend` port that P0 extracted. A Claude master orchestrates Codex workers; nothing else changes.

## Ground truth (verified on this machine, 2026-07-06)

- Codex CLI **0.142.5** installed at `~/.local/bin/codex`, authed (`~/.codex/auth.json`).
- Protocol schema generated from the installed binary: `codex app-server generate-ts` (2.3MB, 499 v2 types). All shapes below are from that generator output, not docs.
- **Framing verified empirically**: `codex app-server` speaks **newline-delimited JSON-RPC over stdio** (no `Content-Length` headers). `initialize` → response on one line; server notifications flow immediately after. Responses may omit `jsonrpc` — parse tolerantly.
- Handshake: `initialize {clientInfo:{name,title,version}, capabilities:{experimentalApi:false, requestAttestation:false}}` → response; then client sends the `initialized` notification.
- `model/list` (live): current default frontier model **`gpt-5.5`**, `supportedReasoningEfforts` low|medium|high|xhigh, default xhigh.

## Scope

**In:** `CodexBackend implements AgentBackend` (openSession only), `CodexTransport` port + real child-process impl + scripted fake, protocol client module, vocabulary mappings, provider plumbing (DB migration, spawn/rehydrate/fork routing, `spawn_worker` provider param, `WorkerRow.provider`), `codexApiKey`/`codexWorkerModel` settings, tests, live smoke.

**Out (explicit non-goals, deferred):** Codex master (`startTurn` throws a clean error — P2); desktop provider UX (model catalog, spawn modal, settings fields — protocol field ships, renderer untouched); real cost pricing (structure ships, returns 0 — P1.5); `turn/steer` (we keep turn-boundary semantics for cross-provider UX parity); nested-subagent panel mapping (child-thread events dropped); `dynamicTools`.

## Architecture

```
Worker (unchanged, P0)  ──consumes──▶ AgentBackend.openSession(input, opts) → AgentStream<AgentEvent>
                                          ├─ ClaudeBackend (P0)
                                          └─ CodexBackend (new)
                                               │ uses
                                               ▼
                        CodexClient (JSON-RPC framing, req/resp correlation, notification+server-request dispatch)
                                               │ over
                                               ▼
                        CodexTransport port: spawn(env) → { write(line), onLine(cb), onExit(cb), kill() }
                                 ├─ RealCodexTransport: child_process.spawn(codexBin, ["app-server"], {env})
                                 └─ FakeCodexTransport (test/helpers): scripted request→response/notification sequences
```

- **One app-server child per worker session.** Rationale: worker lifecycle maps 1:1 to process lifecycle (stop = kill), env isolation per child (`CODEX_API_KEY`), no multiplexing/shared-failure-domain complexity. A shared child is a P2 optimization if process count ever matters.
- **Protocol module** `src/core/codex/codex-protocol.ts`: hand-curated types copied from the generated schema (only what we consume), header documents the generator command + version pin (`0.142.5`). Decode is tolerant: unknown notification methods and unknown item types are ignored; unknown fields pass through.
- Composition root (`server.ts`) builds a **backend registry** `{ claude: ClaudeBackend, codex: CodexBackend }`; `subFactory` picks by the worker's `provider` (default `"claude"`). SessionManager (master) keeps the Claude backend only.

## Session lifecycle mapping

| rookery | Codex app-server |
|---|---|
| `openSession` (fresh) | spawn child → `initialize`/`initialized` → `thread/start {cwd, model, approvalPolicy, sandbox, developerInstructions?}` |
| `openSession` (resume: id) | spawn child → handshake → `thread/resume {threadId, cwd, ...}` |
| input pump (MessageQueue) | for-await one string at a time → `turn/start {threadId, input:[{type:"text", text, text_elements:[]}], model?, effort?}` → wait `turn/completed` for that turn → pull next. Mid-turn pushes buffer in MessageQueue (Worker's deferred FIFO is upstream and unchanged) |
| `interrupt()` | `turn/interrupt {threadId, turnId}` of the active turn (tracked from `turn/started`); no-op resolve when no active turn |
| `setModel(m)` | store; applied as `turn/start.model` override on the next turn |
| `setPermissionMode(m)` | store; applied as next turn's `approvalPolicy`/`sandboxPolicy` overrides |
| `supportedCommands()` | `[]` (no slash-command concept exposed) |
| input closed (stop/discard) | finish pump → kill child → stream ends |
| abort signal | kill child → stream ends silently (Worker's `abort.signal.aborted` check handles the rest — parity with Claude) |
| fork | ephemeral child: handshake → `thread/fork {threadId}` → new `thread.id` → kill (used by FleetOrchestrator fork routing) |

`sessionId` (the port's resume key, persisted in `workers.sdk_session_id`) = **`thread.id`**, emitted early from `thread/started` (fresh) or the `thread/resume` response (resume) — satisfying the port's early-emission contract.

## Event mapping (Codex notification → AgentEvent)

All events are filtered to our `threadId` (child threads from Codex-native subagents are dropped — no nested panel in P1).

| Codex | AgentEvent | Notes |
|---|---|---|
| `thread/started {thread}` / resume response | `session_id {thread.id}` | early |
| `item/agentMessage/delta {delta}` | `text_delta` | |
| `item/reasoning/summaryTextDelta {delta}` | `thinking_delta` | summaries = Claude's `display:"summarized"` parity; `textDelta` ignored (raw CoT) |
| `item/completed {item: agentMessage}` | `message {role:"assistant", text: item.text}` | |
| `item/started {item: commandExecution}` | `tool_use {id: item.id, name: "shell", input: {command, cwd}}` | |
| `item/completed {item: commandExecution}` | `tool_result {toolUseId: item.id, isError: status !== "completed", content: aggregatedOutput ?? ""}` | status enum: inProgress\|completed\|failed\|declined |
| `item/started {item: fileChange}` | `tool_use {id, name: "apply_patch", input: {changes}}` | |
| `item/completed {item: fileChange}` | `tool_result {toolUseId: id, isError: status !== "completed", content: summary of changes}` | |
| `item/started/completed {item: mcpToolCall}` | `tool_use`/`tool_result` (name from item) | workers have no MCP servers by default; mapped for completeness |
| `item/started/completed {item: webSearch}` | `tool_use {name:"web_search"}` / `tool_result` | |
| `item/completed {item: reasoning}` | (dropped) | thinking already flowed via deltas; Worker coalesces + persists |
| `item/completed {item: userMessage}` | (dropped) | echo of our own input; Worker records user text itself |
| plan/todoList, contextCompaction, review, sleep, etc. | (dropped P1) | tolerant decode; revisit if transcripts feel gappy |
| `thread/tokenUsage/updated {tokenUsage}` | (internal) | update `lastContext = last.inputTokens + last.cachedInputTokens`, `contextWindow = modelContextWindow ?? 0` |
| `turn/completed {turn}` | `turn_end {subtype, costUsd: 0 (P1), numTurns: ++cumulative, durationMs: turn.durationMs ?? 0, contextTokens: lastContext, contextWindow}` | subtype: `completed`→`"success"`, `interrupted`→`"interrupted"`, `failed`→`"error"` (+ a `push` notice with `turn.error.message` before the turn_end when failed) |
| `error {message}` (turn-scoped) | `push {kind:"notice"}` | new notice code `notice.codexError` (i18n ko+en, both catalogs) |
| transport/process death mid-stream | stream **throws** | Worker records error + transitions `error` — parity with Claude SDK process death |

**`numTurns` synthesis (the port's most fragile contract, per P0 final review):** a per-session counter incremented on every `turn/completed`, reported cumulatively — matching Claude's conversation-cumulative `num_turns` semantics that the Worker's maxTurns cap compares against. On resume, the counter re-seeds from the Worker's persisted last result (`numTurns`) — wait: the Worker re-seeds its own `cumTurns` display value, but the cap compares `ev.numTurns` directly, so the adapter seeds its counter from `opts` — **decision: the adapter counts turns within its own process lifetime and adds an offset the backend cannot know; instead CodexBackend accepts `resumeTurnOffset` — NO.** Keep it simple and correct: the adapter counter starts at 0 per stream; after a daemon restart the cap effectively resets for the resumed session. Claude behaves the same way today (a fresh `resume:` query's `num_turns` restarts from that send). Documented; contract test asserts monotonic cumulativity within one stream.

## Vocabulary mappings (single module `src/core/codex/codex-vocab.ts`)

| rookery permissionMode | approvalPolicy | sandbox |
|---|---|---|
| `bypassPermissions` (default) | `"never"` | `"danger-full-access"` |
| `acceptEdits` | `"never"` | `"workspace-write"` |
| `default` | `"never"` | `"workspace-write"` (workers have no interactive approval channel; safer than danger) |
| `plan` | `"never"` | `"read-only"` |

Effort: `low→low, medium→medium, high→high, xhigh→xhigh, max→xhigh`; unspecified → omit (Codex default). Effort values validated per model via `model/list` is P1.5 — 0.142.5 accepts the four above for gpt-5.5.

Server→client requests: with `approvalPolicy:"never"` approvals should not fire; a **defensive responder** answers any `item/*/requestApproval` / `execCommandApproval` / `applyPatchApproval` with decline (`{decision:"decline"}` — exact response shape from the schema) plus a transcript notice, and any other unexpected server request with JSON-RPC error `-32601`. Never leave a server request unanswered (it would hang the turn).

Cost: `src/core/codex/codex-pricing.ts` — `costUsd(model, usageDelta): number`, price table empty in P1 → returns 0. Token counts are visible via ccusage (supports Codex logs) for global usage; per-turn USD lands in P1.5 when we commit to a price table.

## Provider plumbing

- **DB migration (append-only)**: `ALTER TABLE workers ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'` (+ same for nothing else; sessions/automations stay Claude in P1).
- `Repositories.createWorker` accepts `provider`; row read returns it. `workers.sdk_session_id` stores the Codex thread id for codex workers (documented column-name residue).
- `WorkerFactory` opts + `Entry` + `FleetOrchestrator.spawn/materialize/rehydrate` carry `provider` through; `subFactory` (server.ts) picks the backend from the registry.
- **Fork routing**: `FleetDeps.forkSession` signature gains a provider argument: `(provider: string, sdkSessionId: string, opts?) => Promise<{sessionId}>`; server injects a router (claude → SDK `forkSession`, codex → ephemeral-child `thread/fork`). `SessionManager` fork (master) is untouched.
- Protocol: `worker.spawn` client message + `spawn_worker` fleet tool gain optional `provider: "claude"|"codex"` (zod enum, default claude); `WorkerRow.provider` optional string (renderer untouched, back-compat).
- Settings: `codexApiKey` (write-only secret; env fallback `CODEX_API_KEY`), `codexWorkerModel` (default `"gpt-5.5"`), `codexBin` (default `"codex"`, resolved via PATH). Codex workers' model default = `settings.codexWorkerModel()` when spawn has no model override; ChatGPT-plan auth (`~/.codex/auth.json`) works implicitly when no API key is set — the child inherits it.

## Error semantics (parity table)

| Failure | Behavior |
|---|---|
| Turn ends `failed` | notice (`turn.error.message`) + `turn_end {subtype:"error"}` → Worker records result, goes idle — recoverable, matches Claude error subtypes |
| App-server process dies mid-turn | stream throws → Worker records `error`, transitions `error` (terminal) |
| Spawn/handshake fails | `openSession`'s stream throws on first pull → same terminal path |
| `turn/interrupt` raced (turn already over) | JSON-RPC error swallowed (interrupt is best-effort, port contract) |
| Abort (stop/discard) | child killed, stream ends; Worker's aborted-check suppresses error records |

## Testing

- `test/helpers/fake-codex-transport.ts`: scripted transport — maps expected requests to responses and interleaves notification scripts; drives `CodexBackend` exactly like `fakeQuery` drives `ClaudeBackend`.
- Contract tests: event mapping (per table above), early session_id, numTurns cumulativity (multi-turn script), interrupt routing (turnId tracking), resume vs fresh, permission/effort vocab, defensive responder (approval request → decline + notice; unknown request → -32601), turn-failed vs process-death paths, kill-on-abort.
- Fleet plumbing tests: provider column round-trip, spawn/rehydrate with provider, fork routing per provider, spawn_worker provider param.
- **Live smoke (controller-run, post-implementation)**: real `codex app-server` in a temp git repo — spawn a codex worker, one trivial turn, interrupt, resume-after-kill. Not part of `npm test`.

## Risks

- 0.x churn: protocol module pinned to 0.142.5 with the generator command documented; tolerant decode for unknowns.
- `ReasoningEffort` is a free string in the schema — mapping table is best-effort; invalid values surface as turn failures (recoverable path).
- Approval `"granular"` variants unhandled by design (we only emit the string enums).
- Codex-native subagent (`features.multi_agent`, default on) traffic on child threads is dropped — transcripts show only the parent thread. Acceptable for P1; note in docs.
