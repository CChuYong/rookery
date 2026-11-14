# Worker steering and per-task background stop — design

Date: 2026-11-15 · Status: proposed · Base: `main` after PR #28 (speed + images) merges — both features touch
`worker.ts`, `codex-backend.ts`, `fleet-tools.ts` and the desktop composer/header that #28 also changes.

## Intent

Both providers now expose a capability Rookery does not use yet, and the goal is simply to wire it in — there is
no specific incident driving this. So the bar is: connect the SDK capability with the smallest new surface, keep
every existing contract that does not have to change, and do not invent product on top.

1. **Worker steering (Codex and Claude).** Codex app-server ≥0.169 has `turn/steer` (`{threadId, input,
   expectedTurnId, clientUserMessageId?}` → `{turnId}`), which injects user input into the *running* turn. The
   Claude SDK already folds a message that arrives on the streaming input mid-turn into the in-flight turn, and
   0.3.325 adds `SDKUserMessage.priority: 'now' | 'next' | 'later'`; Rookery deliberately suppresses this today by
   holding mid-turn sends in its `deferred` FIFO (the old echo-at-boundary bookkeeping left a coalesced message
   with no following turn, so the worker stuck in "thinking"). Today a follow-up to a busy worker of either
   provider waits until the turn ends.
2. **Per-task background stop.** The Claude Agent SDK has `Query.stopTask(taskId)` and reports every live
   background task (`background_tasks_changed`: `task_id`, `task_type`, `description`, …). Today Rookery keeps only
   the id and type, shows a count in the worker header (and only in the `background` state), and the only way to
   end a runaway background shell is to stop or recover the whole worker.

## Decisions taken (with the owner)

- **Steering is the default for workers of both providers (option A).** When a worker is mid-turn, any `send` —
  from the desktop composer or the master's `send_worker` — steers the running turn. If steering is not possible,
  it falls back to today's deferred-to-next-turn behavior. No new UI control and no new tool parameter.
- **A user-stopped background task may wake the model.** The SDK reports the stop like any settled task, which
  starts a turn; that is accepted. The model sees the task's "stopped" status; Rookery adds no extra text.
- **Background stop: desktop control + master read-only (option B).** The desktop lists a worker's live background
  tasks and can stop each one. `get_worker_status` returns the list so the master can see it. There is **no**
  master tool to stop a task (masters run `bypassPermissions`; the master can still ask the worker via
  `send_worker`).

## Goals

- A follow-up to a busy worker (Codex or Claude) reaches the model during the current turn.
- A user can see which background tasks a Claude worker is running — while it is `running` too, not only in
  `background` — and stop one without touching the rest of the worker.
- The master sees the same task list in `get_worker_status`.

## Non-goals

- Steering for **masters** of either provider (turns are serialized in `turnChain`; Codex masters use one ephemeral
  child per turn), Side conversations, or automations.
- Codex background terminals: the v2 protocol has no API to list or kill model-launched background commands
  (`command/exec/terminate` only covers client-started `command/exec`), and Rookery's Codex workers never enter
  `background`. Nothing is shown or stoppable for Codex.
- A master/external-MCP tool to stop tasks; "background this foreground task" (`backgroundTasks(toolUseId)`);
  persisting the task list across daemon restarts (tasks die with the SDK subprocess anyway).
- Stopping subagents (`local_agent`) or Dynamic Workflow runs (`local_workflow`) — they stay in the Activity panel,
  which keeps no stop control. Changing the worker state model (ambient tasks still count toward `background`).

## Anti-goals (would be a failure even if it "works")

- A steered message that is lost, recorded twice, or shown in the transcript but never delivered.
- Reintroducing the "stuck in thinking" bug: a steered message must never leave the worker `running` with no turn
  to end it, and the deferred-echo ordering guarantees must hold for messages that fall back.
- A worker that flips to `idle`/`stopped`/`error` because of a steer or a task stop.

## Constraints (from the codebase)

- Worker input model: `MessageQueue` streaming; a mid-turn `send` is held in `deferred` and released (enqueue +
  user echo) at the next `result`. The desktop shows a pending bubble reconciled by `clientMsgId`.
- `deferred` is dropped (with a notice) on stop/interrupt/recover/cap-stop; the abort-loop breaker resets its streak
  on a human `send()`.
- `AgentStream` is the provider-neutral port (`agent-backend.ts`); Codex already tracks `activeTurnId`
  (`turn/started` notification and the `turn/start` response).
- Worker live state is derived (`turnActive ? running : bgTasks>0 ? background : idle`) with a settle grace;
  `bgTasks` is fed by both edge frames and the level frame (REPLACE semantics).
- `worker.status` events carry `bg?: {count, types}`, and every `worker.status` also appends a worker row to the
  owning session's log and is consumed by `WorkerNotifier`, the worker-settled trigger and the Slack relay — so it
  must not be re-emitted just to refresh task metadata.
- New user-facing strings go through i18n (ko default, en); code comments in English; protocol inbound is zod.

## Approaches considered

### Steering

| | What | Trade-off |
|---|---|---|
| **A (chosen)** | Steer by default when a worker (either provider) is mid-turn; fall back to deferred. | No new surface, one rule for both providers; cannot express "after you finish, also…" as a distinct intent. |
| B | Explicit choice: composer "now / next turn", `send_worker mode`. | Preserves intent, but adds UI + tool surface and still needs a default. |
| C | Keep deferred as default; steer only when asked. | Safest, but the capability would rarely be used. |

### Background stop surface

| | What | Trade-off |
|---|---|---|
| A | Desktop list + stop only. | Smallest; master cannot see tasks. |
| **B (chosen)** | A + `get_worker_status` lists tasks (read-only). | Master can reason about tasks; no new mutating tool. |
| C | B + `stop_worker_task` master tool. | More autonomy, more blast radius under bypassPermissions; no need seen yet. |

## Design

### 1. Worker steering

**Port.** Add optional `steer?(input: AgentInput, clientMsgId?: string): Promise<boolean>` to `AgentStream`.
Returns `true` only when the provider accepted the input for the active turn; `false` (never throws) otherwise.
Both adapters implement it.

**Codex adapter.** `false` when there is no active turn, the turn is not steerable (`review`/`compact`), the
`expectedTurnId` no longer matches, or the request fails. `steer()` sends `turn/steer` with the session's `threadId`, the current `activeTurnId` as
`expectedTurnId`, the input mapped exactly like `sendTurn` maps text/images to `UserInput[]`, and
`clientUserMessageId` = Rookery's `clientMsgId` when present. A steer counts as activity for the idle watchdog.

**Claude adapter.** `steer()` pushes the input onto the session's streaming input immediately (instead of waiting
for the turn boundary) with the `priority` that delivers it into the running turn without aborting in-flight tool
calls — expected `'next'`; confirm `'now'` vs `'next'` semantics live and record the finding. Return `false` if the
stream is closing/closed. There is no provider ack, so acceptance = enqueued while the turn is active. If the SDK
instead answers it in a new turn (it arrived just as the turn ended), the worker must still observe that turn's
start and end like the existing spontaneous-wake path (`init` frame → `running`, `result` → settle) so it never
sticks in `running`; verify this live.

**Worker.** In `send()` while `running`, before the existing deferral:
- Steer only when the stream implements `steer`, the turn is active, and `deferred` is empty (so an older queued
  instruction is never overtaken). Otherwise defer exactly as today.
- Resolve images up front (same path as an immediate send). Await `steer()`; on `true`, record the user echo
  immediately (it is part of the current turn) with its `clientMsgId`, and treat it as a human send for the
  abort-loop breaker. On `false`, push to `deferred` as today. `send()` itself keeps its current fire-and-forget
  contract toward callers.
- A per-message `speed` cannot change a running turn; it is applied as today's speed preference for the next turn.
- If stop/interrupt/recover runs while a steer request is in flight, the outcome must be either "delivered and
  recorded" or "deferred and then dropped with today's notice" — never silent loss or a double record.

**Master and docs.** `send_worker`'s description changes from "queued to the next turn boundary" to "delivered
into the running turn (the worker folds it into its current work; if that isn't possible it runs next)", for both
providers. `interrupt_worker` → `send_worker` stays the way to make a worker abandon its current work. Update
AGENTS.md (Master vs Worker — the deferred-echo paragraph, Tools) and `docs/architecture` accordingly.

**Desktop.** No new control. A steered message's echo arrives right away, so the existing pending bubble
reconciles immediately; a fallback keeps today's pending bubble until the turn boundary.

### 2. Per-task background stop (Claude workers)

**Data.** The background-task level/edge events carry `description` and `ambient` (and the existing `taskType`). The
worker keeps `taskId → {type, description, ambient}` instead of `taskId → type`; the derived state still counts
every task (state model unchanged). Live-only, per process.

**What is listed.** Only shell and Monitor tasks (`local_bash` and the monitor type) that are not `ambient` appear in
the list, count toward the header indicator, and are stoppable. Subagents and workflow runs are excluded (Activity
panel); ambient tasks are excluded per the SDK's "hosts should exclude them from activity indicators". When a
worker is `background` only because of excluded tasks, the header shows its status badge but no list.

**Events.** A dedicated `worker.tasks {sessionId, workerId, tasks: [{id, type, description}]}` event carries the
listed set whenever it changes (including to an empty list); `worker.status` is untouched so its log/notifier/trigger
consumers see no extra emissions. `fleet.list` rows carry the same `tasks` for reconnecting clients. (Planning-time
call: the spec originally suggested extending `worker.status`; see Constraints for why not.)

**Stop.** Add optional `stopTask?(taskId: string): Promise<void>` to `AgentStream` (Claude: `Query.stopTask`).
`Worker.stopTask(taskId)` succeeds only for a listed task currently in its live set and does not change worker
state by itself; the SDK's settle frames then remove the task and the normal derivation runs. The settle wakes the
model (as for any settled task) — accepted; the model may react, including relaunching the task.
New protocol request `worker.task.stop {workerId, taskId}` (zod, `reqId`, error reply for unknown worker/task or a
non-live worker) routed through `FleetOrchestrator`.

**Master (read-only).** `get_worker_status` appends the live task list (type + description, truncated) when there
is one. The external MCP server's `get_worker_status` reuses the same formatter.

**Desktop.** The worker header shows the background indicator whenever the live list is non-empty — in `running`
as well as `background` — e.g. `2 bg ▾`. Clicking opens a small list: one row per task (type, description,
stop button). A row shows a pending state after stop until the task leaves the list; a failed stop shows an error
toast. Nothing renders for Codex workers.

```
rookery/abc  ● Running   2 bg ▾
               ┌──────────────────────────────┐
               │ Bash   npm run dev       [■] │
               │ Agent  explore codebase  [■] │
               └──────────────────────────────┘
```

## Verification expectations

- Unit tests per seam: Codex `steer` request shape and false-on-mismatch/non-steerable/no-turn; Claude `steer`
  enqueue + priority; worker steer vs fallback ordering, echo-once, never-stuck-running, interaction with
  stop/interrupt; bg list propagation incl. explicit empty;
  `worker.task.stop` validation; `get_worker_status` formatting; desktop indicator/list/stop states and i18n.
- Live checks (isolated `ROOKERY_HOME`): a Codex worker and a Claude worker each steered mid-turn act on the
  instruction in the same turn (and a send at the very end of a turn neither gets lost nor leaves the worker stuck); a Claude worker with two background shells has one stopped while the other keeps running;
  the worker may briefly wake (`running`) and then settles back to `background` with one task listed.

## Left to the builder

- Exact shapes/names of the new event fields, protocol message and i18n keys; how the header list is built (reuse
  existing popover/menu primitives per the IDE UI skill).
- How descriptions are truncated for the master and for the header.
- Whether the Codex `steer` mapping is factored out of `sendTurn` or shared helper code.
- Verify live whether Codex continues the turn when a steer is accepted at the very end of a turn (the
  `turn/completed` race); if it can drop the input, treat that case as a fallback to `deferred`.
- Confirm the Claude `priority` value and the end-of-turn behavior described above.
- Ship the current task list to a reconnecting desktop (today `fleet.list` doesn't carry `bg`), and avoid writing a
  session log row for a `worker.status` that repeats the same status only to update `bg`.

### Live findings (2026-11-15)

Isolated daemon (port 8899, temp `ROOKERY_HOME`), Claude SDK CLI 2.1.325, Codex CLI 0.169.0.

- **Claude priority: `"next"` kept.** A send during a running `Bash` (`sleep 10`) was absorbed into the same
  turn (SDK queue op `absorbed_mid_turn`, rendered as a `<system-reminder>` "The user sent a new message while you
  were working" next to the following tool result). The running tool was not aborted, there was one `result`, one
  user echo, and the worker settled `idle`. `"now"` was not needed and not tested. The model's compliance depends on
  wording: imperative "Additional instruction (do it within this same task) … Then continue with the remaining
  steps." was rejected as a suspected prompt injection by both Haiku 5.5 and Sonnet 5.5; a conversational "Oh, one
  more thing: please also create …" was followed (Haiku 5.5). Master `send_worker` text is at risk of the first
  style.
- **Claude end of turn: a separate turn, with a transient `idle`.** A send that arrives after the model's last tool
  step (here: right after the final assistant text, before `result`) is not folded. `steer()` accepts it anyway
  (`turnActive` stays true until `result`), so it is echoed once, then the SDK emits `result` for the old turn and
  answers the message as a new turn with its own `result`. Observed `worker.status`: `running → idle → running →
  idle`, with about 1.4 s (Haiku) or 3.0 s (Sonnet) of `idle` between. Nothing is lost or stuck, but the transient
  `idle` would wake a master armed with `notify:true` and could fire an `idle` worker-settled trigger. Reported as a
  bug for routing; not fixed here.
- **Codex.** `turn/steer` mid-turn was accepted and delivered as a real user message in the same turn (rollout:
  user message right after the original task, one `task_complete`). gpt-6.1-terra acted on it; gpt-6-luna (low)
  received it but ignored it. At the end of a turn (11 probes with a 0–150 ms delay after the final assistant text)
  a steer that arrives before `turn/completed` (0–10 ms) is folded into the same turn with one result and no
  transient `idle`; later sends found the worker already `idle` and started a normal turn. No send was lost or
  echoed twice, and none left the worker `running`. The "accepted at `turn/completed`" race and the
  rejected-steer fallback were not hit live.
- **Background stop (Claude).** Raw `task_type` was `local_bash` for both `run_in_background` shells (no Monitor was
  started, so no monitor type was observed). `worker.task.stop` removed the stopped task from `worker.tasks` at
  once and killed only its process; the other shell kept running. The worker did **not** wake: it stayed
  `background` for 22 s and the SDK only queued a `<task-notification>` with status `killed`, which rides the next
  turn. An unknown task id returns `Unknown background task <id>`. Stopping the worker killed the remaining shell.
  The terminal `stopped` status still carried `bg: {count: 1}` and `worker.tasks: []` followed it, as designed
  (`worker.ts` keeps the legacy `bg` payload on the status event and clears the listed view after it).

## Calls made while writing (not discussed with the owner)

- Steering waits behind an already-deferred message (never overtakes it); per-message `speed` applies next turn.
- The header list shows shells and Monitors only, excludes `ambient` tasks, and leaves the state model unchanged.
- `get_worker_status` uses the same filtered list; the external MCP server reuses that formatter.
