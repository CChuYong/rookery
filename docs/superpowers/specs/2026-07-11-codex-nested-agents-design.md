# Codex nested agents → NestedAgents panel wiring — design

**Date:** 2026-07-11 · **Branch:** feat/worker-state-graph · **Scope decision:** A (panel wiring only; no worker-state-graph/background integration)

## Problem

The desktop right-sidebar **NestedAgents** panel shows native nested subagents for Claude workers (Task-tool subagents, grouped by `parent_tool_use_id`) but stays empty for Codex workers. Live probes (2026-07-11, codex CLI 0.144.1) confirmed this is a rookery wiring gap, not a Codex limitation:

- Codex's `multi_agent` feature is **stable and default-on** (`codex features list`). When asked, the model spawns collab subagents.
- The parent thread receives `subAgentActivity` items (`kind:"started"`, `agentThreadId`, `agentPath`) and `collabAgentToolCall` items (`tool: spawnAgent|sendInput|resumeAgent|wait|closeAgent`, `senderThreadId`, `receiverThreadIds`).
- The **child thread's full activity** (reasoning / agentMessage + deltas / fileChange / commandExecution, `turn/*`, `thread/tokenUsage/updated`) is delivered to the same app-server client, tagged with the child's `threadId`.
- **Unawaited children outlive the parent turn**: in the no-wait probe the parent `turn/completed` landed at 11.6s and the child kept streaming until 38.5s. (De-facto background work — out of scope here, but it makes state-pollution guards mandatory.)

Today `CodexBackend.handleNotification` drops every non-own-thread notification (`codex-backend.ts` "filter to our thread"), never maps the two collab item types, and hardcodes `parentToolUseId: null` — so the nested path can never fire for codex.

Probe scripts + raw log: `.superpowers/sdd/probe-collab-spawn.mjs`, `probe-collab-nowait.mjs`, `probe-collab-spawn-raw.jsonl`.

## Approach (chosen: adapter-internal mapping)

Translate codex collab traffic into the **existing** port vocabulary inside the adapter, reusing `parentToolUseId` as the panel group key (= child threadId). Worker nested branches (`worker.ts`) and the desktop reducer (`worker.nested` → `nested[workerId][key]`) work unmodified. No port/protocol/core changes; Claude path byte-identical.

Rejected: a new `nested_activity` port event (surface growth for no benefit — `parentToolUseId` already means "panel group key"); phantom fleet workers per child thread (lifecycle/DB/worktree semantics don't fit; Claude nested is a live-only panel too).

## Design

### 1. Backend mapping — `src/core/codex/codex-backend.ts`

Replace the early-return thread filter with a branch:

- **Child-thread notifications** (`p.threadId && p.threadId !== this.threadId`) → `handleChildNotification(childThreadId, method, p)`:
  - `item/completed` `agentMessage` → `{kind:"message", role:"assistant", text, parentToolUseId: childThreadId}`. Completed messages only — child deltas are dropped (parity: the Claude adapter suppresses nested partial tokens).
  - `item/started` `commandExecution|fileChange|mcpToolCall|webSearch` → `{kind:"tool_use", …, parentToolUseId: childThreadId}` with the same name mapping as the parent path (shell / apply_patch / `<server>.<tool>` / web_search).
  - `item/completed` for those four → `{kind:"tool_result", …, parentToolUseId: childThreadId}` with the same isError/content mapping as the parent path.
  - **Everything else from child threads is dropped**, deliberately: `turn/started`/`turn/completed` (must not emit a phantom `turn_end` or clear `activeTurnId`), `thread/tokenUsage/updated` (must not pollute `turnAccum`/cost), `item/agentMessage/delta` + `item/reasoning/summaryTextDelta` (nested shows completed messages only), `item/commandExecution/outputDelta` + `item/mcpToolCall/progress` (a `tool_progress` event has no parent marker — it would show on the worker's main transcript), reasoning/hook/mcpServer noise.
  - Grandchildren (depth > 1) need no special handling: any non-own thread gets its own flat panel keyed by its threadId.
  - Child `tool_use`/`tool_result` do NOT touch `toolStartMs`/progress bookkeeping (that machinery is main-transcript-only).
- **Parent-thread collab items** become main-transcript tool cards:
  - `subAgentActivity` (arrives as `item/completed` only, `kind:"started"`) → emit a synthetic pair: `tool_use {id: agentThreadId, name: "spawn_agent", input: {agentPath}}` immediately followed by `tool_result {toolUseId: agentThreadId, isError: false, content: agentPath}`. **The tool_use id is the child threadId on purpose** — the desktop's `nestedLabel()` looks up the main-transcript tool card whose `toolId` equals the panel key, so the existing label mechanism works untouched. `kind` values other than `"started"` (`interacted`/`interrupted`) → skip (observability-only; no card).
  - `collabAgentToolCall` → normal `tool_use` (`name: "collab." + tool`, input `{prompt, model, receiverThreadIds}`) on `item/started` and `tool_result` (content from `status` + `agentsStates`) on `item/completed`. These DO use the regular tool bookkeeping (progress heartbeat is harmless — no delta stream exists for them; `clearToolProgress` on completion is already generic).
- The idle-watchdog reset on any inbound notification stays **before** the branch (child activity is genuine progress while the parent waits).
- `item?.type` narrowing: extend the duck-typed `p.item` shape with the collab fields (`kind`, `agentThreadId`, `agentPath`, `tool`, `prompt`, `receiverThreadIds`, `agentsStates`) — tolerant decode as usual.

### 2. Worker state guard — `src/core/worker.ts` (minimal correctness guard, in scope for A)

The spontaneous-wake heuristic (`!turnActive && ev.kind in {…}` → `turnActive = true`) must **exclude events with `parentToolUseId`**: codex children keep streaming after the parent turn ends, and without the guard the first child event would flip a settled worker back to `running` with no `turn_end` ever coming. On Claude this is a no-op (nested traffic only flows mid-turn).

Note: with scope A, a worker whose unawaited codex child is still running shows `idle`. Accepted (user decision 2026-07-11); background_task mapping is a follow-up. Update the stale port comment (`agent-backend.ts` "Codex never emits this") to state the runtime fact: codex CAN have post-turn child work; it is just not mapped to `background_task` yet.

### 3. Desktop label — `apps/desktop/src/renderer/components/RightSidebar.tsx`

Extend `nestedLabel()`'s regex extraction with `"agentPath"\s*:\s*"([^"]+)"` so codex panels label as e.g. `/root/compute_answer` (claude cards keep `subagent_type: description`). Fallback (`worker <id6>`) unchanged. No i18n impact (labels are data).

### 4. Curated protocol types — `src/core/codex/codex-protocol.ts`

Add curated inbound shapes for the two new item types (documenting fields we read) and refresh the pin comment: ground truth regenerated from CLI **0.144.1** (`codex app-server generate-ts`), which introduced the collab/multi-agent vocabulary (`SubAgentSource.thread_spawn`, `Thread.parentThreadId`, v2 `ThreadItem.collabAgentToolCall|subAgentActivity`). Decode stays tolerant — on 0.142.x servers the items simply never arrive.

### 5. Explicit non-goals

- No `background_task` emission / worker `background` state for codex children (scope A; follow-up candidate, prerequisite work is the 07-11 state-graph redesign).
- No master-side nested panels: `MasterAgent` keeps dropping `parentToolUseId` traffic (Claude parity). Caveat to document: a codex **master** runs on a per-turn ephemeral child process, so unawaited children die when the turn's process exits — nothing rookery can surface.
- No persistence: nested stays live-only (Claude parity; reload clears panels).
- No spawn/enable knobs: `multi_agent` is upstream-default-on; rookery neither enables nor blocks it.

### 6. Testing

- `test/core/codex-backend.test.ts` (fake-codex scripted transport, existing pattern):
  - child `item/started`/`item/completed` (command + agentMessage) → events tagged `parentToolUseId: <childThreadId>`; child deltas produce no `text_delta`.
  - child `turn/completed` emits **no** `turn_end`; child `thread/tokenUsage/updated` leaves `turnAccum` untouched (assert via the parent turn's `turn_end.costUsd`).
  - parent `subAgentActivity` → `spawn_agent` tool_use/tool_result pair with `id === agentThreadId`.
  - parent `collabAgentToolCall` started/completed → `collab.wait` tool card pair.
- `test/core/worker.test.ts`: a nested-tagged event arriving while `turnActive === false` does not flip live status to `running` (assert via status/reconcile), while non-nested events still do (existing wake test unchanged).
- Desktop: `nestedLabel` unit test for the `agentPath` extraction (file with the existing RightSidebar tests or a new one mirroring the source).
- Live re-verification after implementation: run one real codex worker spawn ("spawn a subagent …") against the daemon and confirm the panel renders. The two probe scripts remain in `.superpowers/sdd/` as the protocol ground truth.

## Verified live facts this design rests on (probe log 2026-07-11)

1. Child-thread `item/*` notifications ARE delivered to the parent's app-server client (full stream incl. deltas).
2. The spawn is represented by a parent `subAgentActivity` item (`item/completed`, kind=started) — no `collabAgentToolCall` with `tool:"spawnAgent"` was observed; `wait` was observed as `item/started`+`item/completed` with `receiverThreadIds: []`, `agentsStates: {}` (fields can be sparse — map defensively).
3. No `thread/started` notification for the child; its id is discoverable from `subAgentActivity.agentThreadId` or any child-tagged notification.
4. Unawaited children keep running (and streaming) after the parent's `turn/completed`.
