# Worker State Graph Redesign (background-aware idle) — Design

Date: 2026-07-11
Status: approved design + live-verified SDK behavior; ready for implementation planning
Probes: `.superpowers/sdd/probe-turn-lifecycle.mjs`, `.superpowers/sdd/probe-ctrlb.mjs` (run live against the Claude Agent SDK 0.3.195, streaming-input mode, 2026-07-11)

## Problem

`idle` currently means "turn ended", not "assigned work complete". A worker that launched a background shell (`run_in_background`) drops to `idle` while that shell still runs — so `idle` lies, `WorkerNotifier` can wake the master prematurely, and the planned worker-settled automation trigger would fire early. Separately, `done` is unreachable in practice (streaming input ends only via stop → `stopped`), so its name promises something it never delivers.

Requirement (user): there must be a state that truthfully means **"시킨 일 다 함" — no active turn AND no running background work**.

## Live-verified facts (Claude Agent SDK, streaming-input mode)

All verified by running real sessions through `query()` with a streaming input queue (the worker's exact mode):

1. **Auto-wake is real.** When a background task settles, the SDK emits `task_updated(status:completed)` → `task_notification`, then **spontaneously starts a new model turn with no input pushed** (non-human-authored turn), ending in its own `result`. Observed 3× across both probes.
2. **`interrupt()` does NOT kill background tasks.** A background tick loop kept running after `interrupt()` resolved (tick count 4→8→11), and its later settle **still auto-woke the model** (a `result` arrived ~37s after the interrupt).
3. **Foreground blocking Bash emits no `task_started`** when short (2s probe: no task frames). Long-running foreground commands are **auto-promoted to tracked tasks after ~3s** (`task_started` mid-turn), but their `task_notification` fires before that turn's `result` — so a turn-end snapshot of running tasks is not polluted by in-turn foreground work. Bonus: the harness **policy-blocks long foreground sleeps** outright ("Blocked: sleep 25 …") and steers the model to `run_in_background` — background tasks are *more* common than expected, not less.
4. **`terminal_reason: background_requested` was not reproduced** (attempt 1 mistimed Ctrl+B; attempt 2 the harness auto-backgrounded the command first). Non-load-bearing: detection rests on task frames, not on terminal_reason. `terminal_reason` is carried as an opaque diagnostic only.
5. **`system/init` fires at the start of EVERY turn** (including auto-wake turns) in streaming mode — Claude has a practical turn-start signal after all, symmetric with codex's explicit `turn/started`.
6. Observed task vocabulary: `task_type: "local_bash"` (raw discriminant; the `BackgroundTaskSummary` docstring's friendly `'shell'` label is a different layer). Settle = `task_updated.patch.status ∈ {completed, failed, killed}` and/or `task_notification(status: completed|failed|stopped)` — dedupe by task id.

Codex app-server (0.142.5, `codex-protocol.ts`): turn statuses `completed | interrupted | failed | inProgress`; explicit `turn/started`; every item completes inside the turn; **no background concept** → a codex worker's `bgCount` is always 0.

## Design: derived live status + terminal overrides

Replace the ad-hoc idle/running transitions with two tracked variables and a pure derivation:

```
turnActive: boolean   // turn in flight
bgCount:    number    // running harness-tracked background tasks (claude only)

liveStatus = turnActive ? "running"
           : bgCount > 0 ? "background"     // NEW state
           : "idle"
```

Terminal states (`stopped`/`error`/`failed`/`orphaned`) override via events exactly as today, guarded by the existing `repos.setWorkerStatus` terminal write-once chokepoint.

### States

| status | meaning | change |
|---|---|---|
| `provisioning` | worktree/backend setup (orchestrator, transient) | unchanged |
| `running` | turn in flight (foreground tools + native nested subagents included) | unchanged |
| **`background`** | turn ended but ≥1 background task running — still working | **new**; claude-only (codex never enters) |
| `idle` | **all assigned work complete**, awaiting instructions | semantics strengthened — the truthful "다 함" state |
| `stopped` | explicit end (stop/discard/maxTurns/costBudget/daemon drain) — terminal | unchanged; also absorbs natural generator end (see `done`) |
| `error` | stream/runtime failure — terminal | unchanged |
| `failed` | spawn/provision failure — terminal (orchestrator-only) | unchanged |
| `orphaned` | unresumable after restart — terminal (orchestrator-only) | unchanged |
| ~~`done`~~ | **retired from live transitions** — natural generator end (practically unreachable) now records a notice and lands `stopped`; legacy DB rows still parse/display | retired |

`done` is not repurposed as "work complete" because a worker in `idle` can always be continued via `send_worker` — "complete" is not terminal here, and two states meaning "all quiet" is worse than one.

### Transitions

```
spawn ─► provisioning ─► running (task) / idle (task-less)          [start failure ─► failed]

running    ─ turn_end, bgCount>0 ─► background
running    ─ turn_end, bgCount=0, no deferred ─► idle
running    ─ turn_end, deferred pending ─► running (flush next turn)
background ─ last task settles + auto-wake turn starts ─► running
background ─ last task settles, no wake follows ─► idle
idle       ─ send() ─► running
idle/background ─ AUTO-WAKE (model activity with no send) ─► running   [NEW spontaneous edge]
running/background/idle ─ stop/discard/caps/drain ─► stopped  [terminal]
running/background/idle ─ stream throw (non-abort) ─► error   [terminal]
rehydrate: resumable ─► idle (bgCount reset 0) · else ─► orphaned
```

The spontaneous `idle→running` edge is new and load-bearing: verified fact 2 shows a worker can resume activity with no `send()` (bg settle → auto-wake), including after an interrupt. Today's worker.ts cannot represent this.

### Signal mapping

| variable | Claude (claude-backend.ts) | Codex (codex-backend.ts) |
|---|---|---|
| `turnActive := true` | `system/init` (fires per turn, incl. auto-wake — fact 5) or first model activity; plus send()/deferred flush | `turn/started` |
| `turnActive := false` | `result` → `turn_end` | `turn/completed` → `turn_end` |
| `bgCount++` | `task_started` (track ids in a live set) | n/a |
| `bgCount--` | `task_updated.patch.status ∈ {completed,failed,killed}` or `task_notification` — first one wins per task id | n/a |

`AgentEvent` additions (provider-neutral port, `agent-backend.ts`):
- `{ kind: "background_task"; taskId: string; taskType?: string; status: "started" | "settled"; description?: string }` — codex adapter simply never emits it.
- `turn_end.terminalReason?: string` — opaque diagnostic passthrough (claude only).

### Settle-grace (added post-merge, fix/worker-idle-grace)

Live use (worker 74022a19) exposed a **transient idle** between the last bg settle and the auto-wake turn's first model activity (~4s: settle → wake `init` <100ms later → first thinking delta ~4s later). Event-driven consumers (WorkerNotifier, the planned worker-settled trigger) fire on any idle emit regardless of duration — one beat early, and a once-latch would latch at the wrong moment. Fix, in `worker.ts`:

- On the **last** settle while quiescent, hold `background` for a grace window (`WorkerDeps.settleGraceMs`, default 3000ms) instead of reconciling to idle; `reconcile()` refuses to derive idle while the grace is armed (the emit is suppressed, not shortened).
- The wake turn's **`init` system frame counts as the wake while the grace is armed** (it lands <100ms after the settle, vs ~4s for the first model activity) → `background → running` with no idle ever emitted. Outside the grace, init is deliberately NOT a wake signal — an eager boot-time init (e.g. a resumed worker before any send) must not flip a quiescent worker to running with no turn coming.
- Grace expiry = no wake came → truthful idle. send() supersedes the grace; terminal transitions clear it (no late expiry reconcile).

### Edge cases

- **In-turn tracked foreground tasks** (auto-promoted after ~3s — fact 3): their settle frames arrive before `result`, so the task set is empty again by turn end. The turn-end snapshot rule needs no special-casing.
- **`interrupt_worker` with bg running**: bg survives (fact 2) → post-interrupt state is `background`, not `idle`; a later settle may auto-wake the worker. Limitation documented: rookery has no per-task kill control (the SDK exposes none in 0.3.195's public surface we consume); `stop_worker` kills the subprocess tree, taking bg tasks with it.
- **Restart**: bg tasks are children of the SDK subprocess → die with the daemon. `rehydrate()` maps old `background` rows like `idle` (resumable) / `orphaned`, resetting bgCount to 0.
- **Caps during `background`**: maxTurns/costBudget trip at turn boundaries only; auto-wake turns are real turns and are themselves capped/billed — a runaway wake loop is bounded by the existing guards.
- **Monitor-type tasks** (persistent watches): counted like any task in v1 (truthful default — a watching worker is not "done"); taskType travels in the event payload so the UI can label it, and an exclusion knob can follow if it proves annoying in practice. Workers rarely create monitors.
- **WorkerNotifier / worker-settled trigger**: `background` is NOT in the SETTLED set. This silently fixes today's latent early-notify bug (notify on idle while a bg shell still runs) and gives the future worker-settled automation trigger the truthful signal for free.

## Blast radius

- `src/core/agent-backend.ts` — 2 event additions (above).
- `src/core/claude-backend.ts` — parse `task_started`/`task_updated`/`task_notification` (currently lost as unclassified system noise); pass `terminal_reason`.
- `src/core/worker.ts` — replace scattered idle/running transitions with the derived-state model (turnActive + live task-id set); new spontaneous wake transition; `background` in the status union.
- `src/core/worker-notifier.ts` — SETTLED unchanged content-wise (must NOT gain `background`); remove `done` from docs/comments as it retires.
- `src/core/fleet-orchestrator.ts` — rehydrate mapping for `background` rows; isTerminal unchanged.
- Protocol/desktop — `WorkerRow`/`worker.status` payload gains optional background-task summary (count + types); desktop `status.ts` maps (`background` → tag "BG"), i18n ko/en `status.background`, reduce tests, gitTone.
- DB — none (status column is plain TEXT, no CHECK; no migration).
- Docs — AGENTS.md worker-state union note; README unaffected.

Estimated size: **M**. No codex-side changes beyond none (its adapter simply never emits the new event).

## Out of scope (follow-ups)

- Per-task kill / interrupt-that-cancels-bg.
- Surfacing individual task rows in the desktop (a tasks panel) — v1 carries count+types only.
- `background_requested` semantics (unreproduced; opaque diagnostic).
- The worker-settled automation trigger itself (separate roadmap item; this design is its prerequisite).

## Follow-up: 2026-07-19 desktop interaction-gate gaps

This design updated the renderer's *display* channels (`lib/status.ts` RAIL/TAG/TONE, `WorkspaceHeaders`) but not
its *interaction gates*, so a worker in `background` was rendered correctly and yet could not be typed to, stopped,
or filtered for. Reported from a live Dynamic Workflow run whose worker showed "Worker ended — view only". Fixed:

- `lib/worker-composer.ts` (new) — the single worker composer gate, replacing a chain duplicated across App.tsx's
  dockable and static render paths (that duplicate is why `background` was missed in both at once). `background`
  is writable, matching `Worker.send()`, which accepts sends while running/background/idle.
- `store.ts setFleet` **and** `reduce.ts worker.status` — optimistic bubbles retained for `background`, not just
  `running`. Two independent code paths had the same running-only predicate.
- `RepoTree` — context-menu Stop and the "active/live" filter include `background`. Stop matters most:
  `fleet.stop` is the only control that kills background tasks; `interrupt` deliberately does not, so gating it
  out left a background worker with no stop path at all.
- `store.ts worker.status` unread marking — includes `stopped`, since `done` no longer occurs live and a natural
  stream end therefore produced no unread dot and no attention-bell entry.
- `lib/notify.ts` — `error` notifies (previously only its orchestrator-written sibling `failed` did).
- `lib/status.ts isLive` / `StatusBadge` — `background` keeps the live LED and does not fire the end-flash.
- `slack/reporter.ts` — terminal icon flags failures (`error`/`failed`/`orphaned`) rather than depending on the
  retired `done` for its only non-neutral case.

Deliberately unchanged: `WorkerNotifier` still excludes `background` from SETTLED (no premature master wake), and
`ConversationPane`'s composer stop button stays keyed to `running` — during `background` there is no turn to
interrupt, and offering a stop that cannot kill background tasks would be misleading. The real stop lives in the
fleet tree's context menu. Remaining `"done"` references are legacy-read paths (terminal-state sets, the union
type, the notifier's legacy-row parse fallback) and are correct as-is.
