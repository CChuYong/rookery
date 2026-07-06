# 2026-07-05 — Codex backend: parity analysis & effort estimate

> Status 2026-07-05+: **P0 (seam extraction) implemented** — `src/core/agent-backend.ts` (port) + `src/core/claude-backend.ts` (adapter); Worker/MasterAgent/SessionManager are SDK-import-free (guarded by `test/core/provider-neutral.test.ts`). P1 (Codex worker backend) implemented 2026-07-06 — see docs/2026-07-06-p1-codex-worker-backend.md. P1.5 implemented 2026-07-06 — desktop provider UX, per-turn pricing with verified RATES, in-app `codexApiKey` via `CODEX_HOME`, fork timeout, always-network-on workspace-write; see docs/2026-07-06-p15-codex-followups.md. Remaining: P2 (Codex master), trust-entry cleanup, numTurns granularity.

Scope: what it takes for rookery (built on the Claude Agent SDK) to also support **OpenAI Codex** as an agent backend — for workers first, optionally the master — with a seam designed for further providers later.

Method: two parallel analysis agents (both fable) — **Track A** exhaustively inventoried Claude-SDK coupling in this codebase (15+ feature dimensions, file:line, propagation depth); **Track B** verified Codex's current capabilities against live docs (CLI 0.142.5 / `@openai/codex-sdk` 0.142.5 / app-server protocol, verified 2026-07-05). This doc is the synthesis: merged parity matrix → design decision → phased estimate. Full source matrices in the appendices.

Baseline: HEAD befbaf3 on main.

---

## TL;DR

- **Integration surface: `codex app-server` (JSON-RPC over stdio), not the TS SDK, not `exec --json`.** The app-server natively covers streaming deltas, `thread/resume` (+ `thread/read` transcript recovery), `thread/fork`, `turn/interrupt`, per-turn model/effort overrides, and even `turn/steer` (mid-turn input injection — stronger than our current turn-boundary queueing). The TS SDK spawns one process per turn and has none of steer/interrupt/fork/approval-callbacks.
- **Cut the seam one level above `QueryFn`.** `QueryFn = typeof sdkQuery` (`src/core/worker.ts:13`) makes the port's contract the SDK itself. But both stream loops already translate immediately into the internal `WorkerEventData`/`CoreEvent` vocabulary — which is what the DB, wire protocol, and renderer consume. A provider-neutral `AgentSession` port emitting that vocabulary lets the orchestrator, DB, protocol, and renderer survive almost untouched (`WorkerLike` at `src/core/fleet-orchestrator.ts:12-24` already anticipates exactly this interface).
- **Worker-only Codex support is the cheap milestone**: the two genuine Codex gaps — no in-process custom tools (`createSdkMcpServer` equivalent) and no per-turn system-prompt append — only affect the **master**. Codex workers under a Claude master need neither.
- **Estimate (single senior engineer-days, see §5):** seam refactor 4–6 d → Codex workers +16–26 d (**worker-only total ≈ 20–32 d**) → Codex master +14–22 d → polish 5–8 d (**full total ≈ 39–62 d**). This is an adapter-*plus-vocabulary* project: the long tail is permission/effort/model/notice vocabulary baked into DB defaults, four protocol enums, and two i18n catalogs — not the stream decode.

---

## 1. Merged parity matrix

Severity = how deep the Claude coupling propagates in rookery (Track A). Codex = support via the app-server surface unless noted (Track B).

| # | Feature | rookery coupling | Codex support | Gap / adapter work |
|---|---------|------------------|---------------|--------------------|
| 1 | Streaming output decode | DEEP via translated vocab; raw decode isolated in 2 stream loops + `sdk-extract.ts` | NATIVE — `item/*` events; text deltas + live command output via app-server | Map `item/*` → `WorkerEventData`. `agent_message`/`reasoning`/`command_execution`/`file_change` → text/thinking/tool events. Synthesize turn-end telemetry from `turn.completed` |
| 2 | Master resume (`resume: sdk_session_id`) | DEEP — DB `sessions.sdk_session_id` | NATIVE — `thread/resume`; rollouts in `~/.codex/sessions` | `thread.started` supplies the id early in the stream (required — we capture on `system:init` *and* `result` so an interrupted first turn isn't orphaned) |
| 3 | Worker streaming input (`MessageQueue`) | DEEP — deferred-send FIFO + desktop `pendingByWorker` UX built on SDK turn-boundary coalescing | NATIVE+ — `turn/start` per message; **`turn/steer`** injects mid-turn | Decide: keep boundary semantics for cross-provider UX parity (map `send()` → queue → `turn/start`), or expose steer as a Codex-only upgrade. Adapter must emit the same turn-boundary echo events either way |
| 4 | forkSession | MEDIUM — already behind `ForkFn`; rookery copies its own transcript rows | NATIVE — `thread/fork` (app-server only; SDK lacks it) | Thin mapping. `session-manager.ts:116` already throws cleanly when fork is absent — per-provider degradation is pre-wired |
| 5 | In-process MCP servers (master control plane) | MEDIUM mechanically, but **the master's entire toolset** (memory/repos/fleet closures over live daemon objects, re-instantiated per turn) | PARTIAL — stdio + streamable-HTTP MCP consumption is stable; in-process equivalent (`dynamicTools` / `item/tool/call`) is **experimental** | **Biggest master gap.** Stable path: daemon serves its tool closures as a localhost streamable-HTTP MCP endpoint with per-session multiplexing + port auth. Experimental path: `dynamicTools`. Worker-only scope: zero work (workers get no MCP servers) |
| 6 | permissionMode + canUseTool | DEEP — zod enums ×4, DB defaults (`workers.permission_mode DEFAULT 'bypassPermissions'`), desktop selector, `AskUserQuestion` string-matched in 3 places, answers piggybacked via `PermissionResult.updatedInput` | NATIVE approvals — `item/commandExecution/requestApproval` + `item/fileChange/requestApproval` server-requests ≈ `canUseTool`; `--yolo`/sandbox ≈ `bypassPermissions` | Semantics mapping, not refactor: `bypassPermissions`→`approval_policy=never`+`danger-full-access`; `default`→`on-request`+approval callbacks; **`plan` has no analog**. AskUserQuestion (structured Q&A mid-turn) needs emulation via a custom tool — master-only concern |
| 7 | Model + effort | DEEP — resolver-per-turn pattern; effort vocab `low..max` in protocol/DB/desktop; haiku-effort regex duplicated in 2 builds; hardcoded Claude model catalog in renderer | NATIVE — per-turn `model` + `effort` on `turn/start`; efforts `minimal..xhigh`; `model/list` exposes `supportedReasoningEfforts` | Resolver pattern ports directly. Work = vocabulary: per-provider model catalog + effort mapping (`max`→`xhigh`?) in protocol/desktop; validate effort against `model/list` (same pitfall class as effort-to-Haiku 400) |
| 8 | System prompt (`claude_code` preset + append) | MEDIUM-DEEP — preset supplies the worker's *entire* toolset; master appends memories + repo catalog per turn; `@path` attachment convention is a harness behavior | PARTIAL — AGENTS.md auto-load; `model_instructions_file` (full replace, config-level); per-turn `personality`/`collaborationMode`; **no per-turn append** | Workers: fine as-is (Codex harness has its own default toolset). Master: memories/repo-catalog injection must ride in the user input preamble or a per-session instructions file |
| 9 | Nested subagents (Task) | MEDIUM — `parent_tool_use_id` demux, `worker.nested` events, renderer regexes raw Task input for `subagent_type` | NATIVE — `features.multi_agent` (stable, default on): `spawn_agent`/`wait_agent`/…, agents-as-TOML | Map Codex agent-spawn events → `worker.nested`; renderer label extraction becomes provider-aware (drop the `subagent_type` regex assumption) |
| 10 | Interrupt | SHALLOW — `query.interrupt()` vs hard abort, already two-level | NATIVE — `turn/interrupt`, thread stays usable | Direct mapping; redirect flow (`interrupt_worker`→`send_worker`) preserved |
| 11 | Turn caps | MEDIUM — rookery self-implements the cap from `result.num_turns`; SDK `maxTurns` unused | No max-turns knob; goal-mode token budgets exist (beware self-imposed budgets, openai/codex#24629) | Count `turn.completed` host-side — near-zero work since the cap is already ours |
| 12 | Usage/cost | DEEP — `total_cost_usd` persisted in result payloads, queried back via SQL `json_extract('$.costUsd')` for `fleet.list`; global usage via ccusage + Anthropic OAuth endpoint | PARTIAL — `turn.completed.usage` has token counts (incl. cached + reasoning); **no USD** | Host-side price table per model → synthesize `costUsd` before persisting (keeps `json_extract` and `fleet.list` untouched). Global usage: ccusage supports Codex session files; OAuth-usage panel degrades per provider |
| 13 | Attachments/images | SHALLOW mechanically — no content blocks anywhere; files ride as `@path` text interpreted by the Claude harness | NATIVE — `localImage`/`image` input items | Adapter converts attachment paths to input items for Codex (the `@path` convention won't be parsed by a different harness) |
| 14 | Auth | MEDIUM — ambient `ANTHROPIC_API_KEY` via `applyApiKeyToEnv`; 3 side modules re-derive Anthropic creds for display | NATIVE — `CODEX_API_KEY` (recommended for daemons); ChatGPT OAuth auto-refresh (unattended refresh = risk) | New write-only setting `codexApiKey` (DB-first env-fallback, same pattern), env injection per app-server child; settings-page provider section |
| 15 | Persisted payloads / notice codes | DEEP — `result.subtype` raw strings; notice codes name Claude runtime behaviors (`compact_boundary`, `api_retry`, …) duplicated byte-identical in 2 i18n catalogs | n/a | Provider-tagged notice codes or a `provider` param; add Codex-behavior notices (goal budget hit, etc.). i18n ×2 catalogs, ko+en |
| 16 | Slash commands/skills | MEDIUM — `supportedCommands()` probe + desktop suggestions | Not investigated in Track B (Codex has `~/.codex/prompts`; app-server exposure unverified) | Degrade to an empty catalog for Codex sessions; investigate later |
| 17 | Aux labeler | SHALLOW — pinned `claude-haiku-4-5` one-shot | n/a | Keep on Anthropic regardless of session backend (infra choice, not session-coupled). Zero work |

**What survives untouched:** `FleetOrchestrator` (WorkerLike is already provider-neutral), `EventBus`, the wire protocol (minus enum widening), the renderer's event replay, and the DB schema except one append-only migration (`provider` column on `workers`/`sessions`/`automations`; `sdk_session_id` columns are reused as the provider-scoped session id — naming residue accepted).

## 2. Design options (Track C)

**Option A — SDKMessage-emulating adapter** (make Codex fake the Claude SDK behind `QueryFn`): rejected. Consumers duck-type raw SDK fields and immediately translate to the internal vocabulary, so fabricating `system:init`/`assistant`/`result` shapes (including `total_cost_usd`, `parent_tool_use_id`, stream-event deltas) is work spent producing an intermediate representation nobody wants, and every Claude-SDK quirk (control-channel pumping, `num_turns` cumulativity) becomes part of the contract to emulate. Fast to start, permanent debt.

**Option B — provider-neutral `AgentSession` port emitting the internal vocabulary** (recommended): `start(input, opts) → AsyncIterable<NormalizedEvent>` + `interrupt() / setModel() / setPermissionMode() / supportedCommands()` + early `sessionId`. The NormalizedEvent vocabulary already exists — it is `WorkerEventData`/`CoreEvent`; the refactor codifies it as the port contract and moves the two decode loops (~100 lines each: `worker.ts:266-394`, `master-agent.ts:307-437`) into a `ClaudeAdapter`. `test/helpers/fake-query.ts` already enumerates every SDK shape relied on (~50 lines) — it becomes the adapter's spec; a `FakeBackend` replaces it for orchestrator-level tests. Fork moves behind the backend (per-provider capability flags gate `session.fork` UI).

**Option C — ACP (Agent Client Protocol) as the internal seam**: prior art worth tracking (Zed maintains `claude-agent-acp`; `cola-io/codex-acp` exists), but its editor-centric feature ceiling (no fleet-grade per-turn model/effort control, approval model shaped for IDEs) makes it a lowest-common-denominator trap as *our* port. Steal its event taxonomy; don't adopt it as the contract.

**Codex integration surface: app-server over stdio**, one child per worker (isolation, per-child env/auth) or one shared child multiplexing threads (cheaper; decide in Phase 1 design). Pin the CLI version, vendor generated schemas (`codex app-server generate-ts`), regenerate on every bump. Avoid the experimental `--listen ws://` transport and, for the stable path, avoid `dynamicTools`.

## 3. Phasing

**Phase 0 — seam extraction (no behavior change, Claude-only).** Define `AgentBackend`/`AgentSession` + codify NormalizedEvent; move decode loops into `ClaudeAdapter`; rewire `startDaemon()`; `ForkFn` folds into the backend; migrate tests to `FakeBackend` (keep `fake-query` for adapter-level tests). Exit criterion: all existing tests green with zero DB/protocol/renderer diffs.

**Phase 1 — Codex worker backend.** App-server client (process supervision, JSON-RPC, pinned schemas); event mapping incl. host-side cost synthesis; lifecycle mapping (spawn/resume/rehydrate → `thread/resume`, fork → `thread/fork`, interrupt → `turn/interrupt`, send → boundary-queued `turn/start`); vocabulary work (provider column migration, permission↔sandbox/approval mapping, effort mapping, per-provider model catalog in desktop, spawn_worker `provider` param); auth (`codexApiKey` setting + env); fake app-server test harness. Exit criterion: a Claude master spawns, steers, interrupts, diffs, and rehydrates Codex workers end-to-end.

**Phase 2 — Codex master.** MCP bridge (daemon-hosted localhost streamable-HTTP MCP exposing memory/repos/fleet with per-session multiplexing — the per-turn per-session closure binding is the hard part — plus bearer auth on the port); per-turn memory/repo-catalog injection workaround; AskUserQuestion + canUseTool emulation over approval server-requests + a custom question tool; capabilities overlay + slash-command degradation; notice/telemetry mapping.

**Phase 3 — residue & polish.** Per-provider usage telemetry (ccusage Codex mode, OAuth panel degradation), notice codes in both i18n catalogs (ko+en), settings UI provider section, docs (`docs/reference` catalogs, this file's follow-ups), live e2e hardening.

## 4. Why worker-first is the right scope cut

Workers receive **no MCP servers** and no per-turn system-prompt injection — the only two features Codex genuinely lacks. Everything a worker needs (streaming I/O, resume/rehydrate, interrupt, fork, per-turn model/effort, sandbox-style bypass, nested agents, usage) is NATIVE on the app-server. A "Claude master orchestrating Codex workers" milestone therefore ships real heterogeneous-fleet value (e.g. cross-checking implementations across vendors) while deferring every hard emulation problem. The master port is a separate, harder project dominated by the MCP bridge and interaction emulation.

## 5. Effort estimate

Unit = focused senior engineer-days, excluding code review and cross-team overhead. With the repo's agent-fleet SDD process, calendar time compresses substantially, but the verify/review tail does not — treat these as relative sizing, and the ranges as design-uncertainty bands.

| Phase | Work item | Est. (days) |
|-------|-----------|-------------|
| 0 | AgentSession port + NormalizedEvent codification + ClaudeAdapter extraction + test migration | 4–6 |
| 1 | App-server client, process supervision, schema pinning | 4–6 |
| 1 | Event mapping + turn telemetry + host-side pricing | 3–5 |
| 1 | Lifecycle: spawn/resume/rehydrate/fork/interrupt/send semantics | 3–4 |
| 1 | Vocabulary: provider migration, permission/effort/model mapping, desktop catalog + composer | 3–5 |
| 1 | Auth (settings + env plumbing + settings UI) | 1–2 |
| 1 | Fake app-server harness + hardening + live e2e | 2–4 |
| | **Worker-only total (P0+P1)** | **20–32** |
| 2 | MCP bridge (HTTP MCP + session multiplexing + auth) | 5–8 |
| 2 | System-prompt injection workaround | 2–3 |
| 2 | AskUserQuestion / canUseTool emulation | 4–6 |
| 2 | Capabilities overlay, slash degrade, notices/telemetry | 2–3 |
| 2 | Automation actions + misc integration | 1–2 |
| 3 | Usage telemetry, i18n ×2, settings UI, docs, e2e | 5–8 |
| | **Full total (P0–P3)** | **39–62** |

Ongoing maintenance tax (non-trivial, budget it): Codex is 0.x with near-daily alphas — every version bump = schema regen + event-mapping re-verify. Suggest a pinned-version policy + a small contract-test suite against the real binary in CI.

## 6. Risks

- **0.x churn** — `--json` was renamed from `--experimental-json` recently; parse tolerantly (ignore unknown event/field types), pin + regen schemas.
- **`dynamicTools` is experimental** — if chosen for the master's tools instead of the HTTP MCP bridge, it can break under us; the bridge is the stable path.
- **`plan` permission mode has no Codex analog** — product decision needed (hide the option per provider vs emulate poorly).
- **Steer vs boundary semantics** — `turn/steer` changes user-visible send timing vs the Claude deferred-send UX; pick one semantics per provider consciously (the desktop `pendingByWorker` reconcile assumes boundary echo).
- **ChatGPT-plan OAuth unattended refresh** is not daemon-grade yet (device flow in beta) — recommend API-key auth for Codex in the daemon.
- **Goal-mode self-imposed token budgets** (openai/codex#24629) can prematurely halt long unattended runs — don't enable goal mode for automation actions.
- **Effort/model vocab drift** — Codex effort names differ and per-model support varies; validate against `model/list` at spawn to avoid the 400-class errors we already gate for Haiku.

---

## Appendix A — Track A: Claude-SDK coupling matrix (rookery side)

| # | Feature | SDK surface used | Consumer files (path:line) | Propagation | Severity |
|---|---------|------------------|----------------------------|-------------|----------|
| 1 | Streaming output decode | `SDKMessage` variants `stream_event`/`assistant`/`user`/`system`/`tool_progress`/`result`; content blocks `text`, `tool_use{id,name,input}`, `tool_result{tool_use_id,is_error,content}`; usage fields; `content_block_delta.delta.{text_delta,thinking_delta}` | `src/core/worker.ts:286-394`, `src/core/master-agent.ts:343-437`, `src/core/sdk-extract.ts`, `src/core/result-telemetry.ts:3-13`, `src/core/labeler.ts:42-44` | Translated vocab (`WorkerEventData`/`CoreEvent`) persisted in `worker_events`/`session_events`, sent over WS, replayed by renderer (`apps/desktop/src/renderer/store/reduce.ts:113-160`) | DEEP via translated events; raw decode core-only |
| 2 | Master continuity (resume) | `options.resume`; `session_id` on `system:init` and `result` | `master-agent.ts:382-385,411-413,323`; `session-manager.ts:65,135` | → `repositories.ts:198` → DB `sessions.sdk_session_id` (`db.ts:17`) | DEEP |
| 3 | Worker continuity (streaming input) | `options.prompt: AsyncIterable<SDKUserMessage>`; `options.resume`; SDK read-ahead/coalescing at turn boundaries | `message-queue.ts:14-18` (only compile-time SDK message type), `worker.ts:269,281,328-332,354-357`; deferred-send `worker.ts:149-164,382-392`; rehydrate `fleet-orchestrator.ts:144-158` | → DB `workers.sdk_session_id` (`db.ts:59`); turn-boundary behavior leaks into desktop `pendingByWorker` UX | DEEP |
| 4 | forkSession | `forkSession(sdkSessionId,{title})→{sessionId}` | `server.ts:5,114,131`; `session-manager.ts:25,112-127`; `fleet-orchestrator.ts:51,199-248` | Behind `ForkFn` seam; protocol `session.fork`/`worker.fork` (`messages.ts:42,91`) | MEDIUM (seam exists), hostage to provider-side forking |
| 5 | In-process MCP servers | `tool()`, `createSdkMcpServer()`, `McpSdkServerConfigWithInstance`; `allowedTools`/`disallowedTools`; `mcp__<server>__<tool>` naming | all 5 `src/tools/*-tools.ts`; `master-agent.ts:285,325-335`; overlay `master-agent.ts:37-42`, `src/slack/capabilities.ts:19-24`, `server.ts:135-145` | Core+daemon only; `mcp__` prefix stripped before events | MEDIUM (but the master's entire control plane) |
| 6 | permissionMode + canUseTool | `PermissionMode` literals; `CanUseTool`, `PermissionResult{behavior,message,updatedInput}`; `AskUserQuestion` by name; `query.setPermissionMode()` | `master-agent.ts:279,317,319`; `worker.ts:78,139-147,277`; `interaction-registry.ts`; `src/slack/interaction.ts`; `session-manager.ts:37,75` | → zod enums (`messages.ts:32,46,86,92`), DB defaults (`db.ts:65,128`), desktop `Composer.tsx:30`, `InteractionCard` | DEEP |
| 7 | Model/effort options | `options.model/effort`, `options.thinking:{type:"adaptive"}`; `query.setModel()`; Haiku-effort-400 rule | resolvers `master-agent.ts:22-23,276-277`; `worker.ts:68,128-136,273-276`; `src/core/effort.ts`; `src/config.ts` | → `EFFORT_LEVELS` (`messages.ts:12`), DB columns, desktop duplicates model catalog + haiku regex (`models.ts:5-26`) | DEEP |
| 8 | System prompt preset | `systemPrompt:{type:"preset",preset:"claude_code",append}` — preset supplies the worker's entire toolset + `@path` behavior; native harness tools removed by name | `master-agent.ts:81,322,335`; `worker.ts:278`; `labeler.ts:35` | Slack attachments as `@path` (`handle-incoming.ts:127-137`), desktop chips as `@path` (`Composer.tsx:116`) | MEDIUM-DEEP (behavioral, invisible) |
| 9 | Nested subagents (Task) | `parent_tool_use_id`; `forwardSubagentText:true`; Task input `subagent_type` | `worker.ts:280,289,306-312`; `master-agent.ts:349-350`; `events.ts:46`; renderer regex `panels.tsx:17`, `RightSidebar.tsx:27` | Events → renderer (live-only) | MEDIUM |
| 10 | Interrupt/abort | `query.interrupt()`, `options.abortController` | `worker.ts:184-189,202,375`; `master-agent.ts:179-189,312,338`; `commands.ts:74`; `labeler.ts:27-28` | Protocol names actions, carries no SDK shape | SHALLOW |
| 11 | maxTurns/options inventory | self-implemented cap from `result.num_turns`; full option set at 4 `query()` sites: `cwd,model,effort,thinking,permissionMode,systemPrompt,includePartialMessages,forwardSubagentText,resume,abortController,mcpServers,allowedTools,disallowedTools,canUseTool` | `worker.ts:268,370-381`, `master-agent.ts:307,430-435`, `commands.ts:60`, `labeler.ts:30` | `max_turns` DB columns (`db.ts:129,146`), protocol `maxTurns` — internal concept, not the SDK option | MEDIUM |
| 12 | Usage/cost metrics | `result.total_cost_usd,num_turns,duration_ms,usage.*`, `modelUsage[].contextWindow`; out-of-band: ccusage over Claude Code JSONL, Anthropic OAuth usage endpoint, `/v1/models` | `worker.ts:353-369`, `master-agent.ts:401-429`, `result-telemetry.ts`; `usage.ts:35-50`, `oauth-usage.ts:79-107`, `models-provider.ts:43-53` | persisted `result` payloads; SQL `json_extract('$.costUsd')` (`repositories.ts:271-291`) → `fleet.list` → desktop | DEEP |
| 13 | Attachments/images | none as content blocks; files ride as `@path` text (harness Read handles images) | `handle-incoming.ts:127-137`, `file-download.ts`, `Composer.tsx:116` | Text convention only | SHALLOW mechanically; breaks on a non-`@path` harness |
| 14 | Auth | ambient env `ANTHROPIC_API_KEY` else Claude Code OAuth; nothing passed to `query()` | `settings.ts:188-191`, `config.ts:83-101`, `auth-status.ts`, `oauth-usage.ts` | `auth.status` protocol + desktop settings | MEDIUM (implicit + 3 side-channel modules) |
| 15 | Persisted near-raw payloads | `worker_events.payload_json`/`session_events.payload_json` incl. raw `result.subtype`; notice codes from Claude runtime subtypes (`compact_boundary`, `api_retry`, `model_refusal_fallback`, …) | writers `worker.ts:226-248`, `master-agent.ts:160-169`; `system-push.ts:22-55`; readers: desktop `reduce.ts`, `worker-notifier.ts:69-82`, `worker-event-to-core.ts` | DB → WS replay → renderer; notice codes byte-identical in desktop i18n | DEEP |
| 16 | Slash commands/skills | `query.supportedCommands()`; `commands_changed` push; generator must be pumped for control responses | `commands.ts:55-80`, `worker.ts:167-174`, `system-push.ts:25-28` | `commands.changed` event + protocol + desktop suggestions | MEDIUM |
| 17 | Labeler | plain `query()`, pinned `claude-haiku-4-5`, `allowedTools: []` | `labeler.ts:6,30-40` | none | SHALLOW |

Track A judgement highlights: the stream loops never import an SDK message type (coupling is structural, duck-typed field names — `fake-query.ts` is the de-facto shape spec); `sdk_session_id` is deliberately captured early (init) *and* late (result) so interrupts don't orphan sessions; `CommandCatalog.probe` encodes the SDK control-channel pumping quirk; blast-radius ranking: `worker.ts` > `master-agent.ts` > `server.ts` > desktop renderer > `protocol/messages.ts` > `persistence` > `tools/*` > managers > small SDK-shape modules > auth/usage periphery.

## Appendix B — Track B: Codex capability matrix (verified 2026-07-05, CLI/SDK 0.142.5)

| # | Feature | Codex support | Mechanism | Source |
|---|---------|---------------|-----------|--------|
| 1 | Headless streaming output | NATIVE | `codex exec --json` JSONL (`thread.started`/`turn.*`/`item.*`, item-level); app-server adds true deltas (`item/agentMessage/delta`, `item/commandExecution/outputDelta`) | developers.openai.com/codex/noninteractive, /codex/app-server |
| 2 | Session resume across restarts | NATIVE | `codex exec resume <id>`/`--last`; SDK `resumeThread(id)`; app-server `thread/resume`; rollouts in `~/.codex/sessions` (`CODEX_HOME`); `thread/read` recovers transcripts | /codex/sdk |
| 3 | Long-lived session + streaming input | NATIVE (app-server only) | `turn/start` per message on an open thread; `turn/steer` appends to an in-flight turn. TS SDK spawns one `codex exec` per turn — no mid-turn send | /codex/app-server |
| 4 | Session forking | NATIVE (app-server) / MISSING (SDK) | `thread/fork` (keeps parent `sessionId` as root); SDK fork = open issue #4972 | /codex/app-server |
| 5 | MCP + in-process tools | NATIVE (MCP) / PARTIAL (in-process) | `mcp_servers.*` stdio + streamable HTTP (+OAuth); no `createSdkMcpServer` equivalent; experimental `dynamicTools` → `item/tool/call` server-requests | /codex/mcp, /codex/app-server |
| 6 | Tool allowlisting | PARTIAL | per-server `enabled_tools`/`disabled_tools`; `tools.web_search` etc.; `codex execpolicy` command rules; no flat `allowedTools` | /codex/config-reference |
| 7 | Approval model / callbacks | NATIVE (app-server) / PARTIAL (exec/SDK) | exec: `--ask-for-approval untrusted\|on-request\|never` + `--sandbox read-only\|workspace-write\|danger-full-access`, `--yolo`; app-server: `requestApproval` server-requests (decisions incl. `acceptForSession`, execpolicy amendments) | /codex/cli/reference, /codex/app-server |
| 8 | Model + effort per turn | NATIVE (app-server) / PARTIAL (SDK thread-level) | `turn/start` accepts `model`+`effort`; efforts `minimal..xhigh`; `model/list` → `supportedReasoningEfforts` | /codex/app-server, /codex/config-reference |
| 9 | System-prompt customization | PARTIAL | `model_instructions_file` (full replace), AGENTS.md auto-load, per-turn `personality`/`collaborationMode`; no per-turn append | /codex/config-reference |
| 10 | Sub-agents | NATIVE | `features.multi_agent` (stable, default on): `spawn_agent`/`send_input`/`wait_agent`/`resume_agent`/`close_agent`; TOML agents; `max_threads=6`, `max_depth=1` | /codex/subagents |
| 11 | Interrupt keeping session | NATIVE (app-server) | `turn/interrupt` → `status:"interrupted"`, thread lives; SDK only AbortSignal (process kill, resumable from disk) | /codex/app-server |
| 12 | Turn/budget limits | PARTIAL | no max-turns; goal mode `token_budget` (self-imposed-budget bug #24629); `model_auto_compact_token_limit`, `tool_output_token_limit` | /codex/config-reference |
| 13 | Usage/cost | PARTIAL | `turn.completed.usage {input,cached_input,output,reasoning_output}`; no USD (host prices it; ccusage supports Codex) | ccusage.com/guide/codex, #17539 |
| 14 | Image/file inputs | NATIVE | exec `-i/--image`; SDK `{type:"local_image",path}`; app-server `image`/`localImage` items | /codex/cli/reference, /codex/app-server |
| 15 | Headless auth | NATIVE | `CODEX_API_KEY` (recommended programmatic); ChatGPT OAuth via `~/.codex/auth.json` auto-refresh, device flow beta | /codex/auth |
| 16 | Runtime | NATIVE | npm `@openai/codex` (Rust binary) + brew, Apache-2.0; SDK = thin CLI wrapper, Node ≥18, version-locked; `app-server generate-ts` schema pinning | github.com/openai/codex/releases |

Prior art: ACP (agentclientprotocol.com; `zed-industries/claude-agent-acp`, `cola-io/codex-acp`), `coder/agentapi` (TUI-driving, coarse), Promptfoo providers for both. Codex's own `model_providers` config can front non-OpenAI models speaking the Responses API.

Volatility: 0.x near-daily alphas; everything behind `capabilities.experimentalApi` (dynamicTools, `thread/inject_items`, `tool/requestUserInput`, background terminals) and `--listen ws://` are unstable; parse `--json` tolerantly; goal-mode budgets can halt long runs; ChatGPT-plan auth not daemon-grade.
