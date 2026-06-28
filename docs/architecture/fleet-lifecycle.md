# Fleet Lifecycle

> **Source of truth:** `src/core/fleet-orchestrator.ts`, `src/core/worker.ts`, `src/core/worker-notifier.ts`, `src/core/git-ops.ts` — the code is authoritative; this doc explains concepts and flows. The always-loaded map/conventions live in [AGENTS.md](../../AGENTS.md); this goes deeper.

The fleet is the **control plane**: one `FleetOrchestrator` per daemon (a global pool) injected into every session, so any session can list/inspect/control every worker. See AGENTS.md §"Fleet = the control plane". This doc covers spawn, the state machine, restart rehydration, stop/discard, notifications, and what GitOps does (and deliberately does not) do.

## Spawn

`FleetOrchestrator.spawn(input)` (`fleet-orchestrator.ts:164`) returns `{id}` **after worktree provisioning completes** (so the renderer can resolve the worktree path on the first try); the agent boot continues asynchronously. Internally `spawn` registers `run()` into the `flows` set synchronously (so a shutdown drain waits even for in-flight spawns) and resolves a `ready` promise once the worktree exists.

`run()` (`fleet-orchestrator.ts:179`):
1. `repos.createWorker(...)` **first** — so even a later failure can record status/events without an FK violation. Arms notify if requested.
2. Emit `worker.spawned` with status `provisioning` **immediately** (before the slow `git worktree add`), so the UI shows the worker instead of looking hung.
3. Resolve **base**: explicit `input.base` → remote default branch (`git.remoteDefaultBranch`, best-effort `git.fetch` refresh; a failed fetch sets `baseStale`) → current HEAD fallback. Persist via `setWorkerBase` (so restart can diff against the right base).
4. `git.addWorktree(repo, worktreePath, branch, base)` → `signalReady()` (spawn can return).
5. `factory(...)` builds the `Worker` (cwd = worktree), `agent.start(task)`, then `setStatus(agent.status())` reconciles out of `provisioning` (a real transition that clears the spinner). If `baseStale`, surface a worker `notice`.
6. With a task, `relabel` (best-effort Haiku label). If the daemon is `closing`, immediately `stop`.
7. `await agent.waitUntilSettled()` then `setStatus(error → "failed", else the settled status)`.

**Branch naming:** `rookery/<id>`, or `rookery/<slug>` from a ticket key (`branchSlug`, e.g. `#123` → `issue-123`) with a `-<id[:6]>` suffix on collision. Worktree path: `<worktreesDir>/<id>` (= `~/.rookery/worktrees/<id>`).

**No concurrency cap** — `spawn` is never rejected (the old `ROOKERY_MAX_WORKERS` cap is gone). Runaway control is per-action `maxTurns` only (see [automation.md](./automation.md)).

## Worker state machine

Worker-owned union (`worker.ts:22`): `running | idle | stopped | done | error`. Orchestrator-only DB states: `failed`, `orphaned` (plus the transient `provisioning` stamped at spawn).

- **running** — a turn is in flight (born here when spawned with a task).
- **idle** — turn finished, queue alive, awaiting `send()` (task-less spawn starts here; a turn boundary with nothing deferred drops here, `worker.ts:368`).
- **stopped** — `stop()`/`discard`/user termination, or `maxTurns` cap, or shutdown-drain stop. Keeps the worktree.
- **done** — the SDK generator ended **naturally** (`worker.ts:376`). Rare in practice — a real streaming queue only ends on close, so workers almost always end `stopped`.
- **error** — the consume loop threw (non-abort) (`worker.ts:383`). The orchestrator maps this to `failed` at settle (`trackFlow`/`run`).
- **failed** — orchestrator terminal: a thrown worker `error`, or a spawn/provisioning failure (`run` catch, `fleet-orchestrator.ts:262`).
- **orphaned** — set only by `rehydrate()` for a zombie (no live process after restart, can't resume).

### Terminal write-once chokepoint
Two writers exist — `Worker.transition` (`worker.ts:202`) and `FleetOrchestrator.setStatus` (`fleet-orchestrator.ts:297`) — but the single guard is `repos.setWorkerStatus(id, status, force?)`. Once a row is terminal (`stopped/done/error/failed/orphaned`) it cannot be overwritten with a different value. `force=true` is the **only** exception (user stop/discard, and rehydrate's terminal→idle/orphaned rewrite). `setStatus` mirrors the same guard in memory (`isTerminal` check, skipped when `force`) and drops the live `agent` reference on reaching terminal so the `Worker` can be GC'd while keeping worktree metadata for diff/discard. Any new writer is safe as long as it routes through this chokepoint.

## waitUntilSettled / waitAllSettled / flows

`Worker.waitUntilSettled()` (`worker.ts:198`) awaits the consume `loop` — it resolves **only on termination (stopped/done/error), never on idle**. The orchestrator's `flows` set holds one promise per live spawn/resume flow; a flow stays in `flows` while the worker is alive (including idle) and drops out when it settles (`trackFlow`, `fleet-orchestrator.ts:94`). `waitAllSettled()` (`fleet-orchestrator.ts:537`) drains `flows` — used by the shutdown drain and by tests (`fakeQuery` is finite, so test workers reach `done` and settle; a real iterator would not — see AGENTS.md §Testing). `flows` is purely for drain accounting, not concurrency capping.

## Checkpoints

`onTurnStart` (passed to the worker) calls `checkpoint(id)` (`fleet-orchestrator.ts:348`) right before each turn. Checkpoints are **serialized per worker** on `ckptChains` (so concurrent `nextCheckpointSeq` reads don't collide) and tracked in `checkpointWrites` (so `close()` drains them before `db.close()`). `git.checkpoint` snapshots the **entire worktree** (tracked + untracked via a temp `GIT_INDEX_FILE`) into a hidden ref `refs/rookery/ckpt/<id>/<seq>` and persists the sha. A failure warns **once** per worker (`warnCheckpoint`). `restore(id, seq)` refuses while the worker is `running` (concurrent edits would collide).

## Restart: rehydrate()

`rehydrate()` (`fleet-orchestrator.ts:119`) runs on daemon boot and restores detached entries (worktree metadata only — the live streaming conversation died with the process). For each DB worker row with a worktree+branch:
- `running`/`idle`/`stopped`/`provisioning` → if `sdk_session_id` **and** the worktree still exist on disk → **lazy resume**: mark `resumeSessionId`, set status `idle` (force), boot stays light (an unused restored worker costs 0). Otherwise → `orphaned` (force) — diff/discard only.
- The actual SDK session restart happens on the first `send`/await via `materialize()` (`fleet-orchestrator.ts:107`), which calls `factory(... sdkSessionId: resumeSessionId)` + `agent.resume()` and registers the flow. `requireLive` (`fleet-orchestrator.ts:324`) triggers materialize lazily, but **not** during a shutdown drain (avoids resume→consume writing to a closed DB).

## stop vs discard vs delete

- `stop(id)` (`fleet-orchestrator.ts:437`) — `agent.stop()` then `setStatus("stopped", force)`. **Keeps** the worktree + branch (work preserved; resumable later).
- `discard(id)` (`fleet-orchestrator.ts:461`) — stop the agent, `git.removeCheckpointRefs`, `git.removeWorktree` (removes worktree **and** branch via `branch -D`), settle to `stopped` even if removal throws (`finally`). Loses uncommitted work.
- `delete(id)` (`fleet-orchestrator.ts:485`) — discard then `repos.deleteWorker` + drop the entry (disappears from the tree, even if worktree removal failed).
- `archive(id, bool)` — toggles `archived_at` only; the live entry is untouched.

## Async notifications (notify)

`spawn_worker`/`send_worker` accept `notify:true`. This arms a **one-shot** flag: `setWorkerNotifyArmed(id, true)` (set at spawn in `run`, or via `armNotify`). `WorkerNotifier` (`src/core/worker-notifier.ts`) subscribes to `worker.status` on `ALL_CHANNEL`; when an armed worker reaches a `SETTLED` state (`idle | done | error | failed | stopped | orphaned` — note **idle counts as settled** for notify, so the master is woken on success, and terminal failures wake it too instead of waiting forever), it `consumeWorkerNotifyArmed` (atomic read+clear, safe against duplicate events) and `deliver`s a one-line summary (worker label/branch/status + the last assistant message tail, ≤500 chars) to the **home** session's master. Delivery routes through `SessionManager.deliverWorkerNotification` → `master.notifyWorker` (live) or persists to `pending_notifications` (cold session, drained on next load). The arm persists in the DB, so it survives a restart. Re-arm on each `send` for repeated notifications.

## GitOps boundary

`GitOps` (`src/core/git-ops.ts`) does **only** worktree/diff/checkpoint/fetch operations: `currentBranch`, `branchExists`, `addWorktree`, `removeWorktree`, `diff`, `checkpoint`, `restoreCheckpoint`, `listBranches`, `removeCheckpointRefs`, `remoteDefaultBranch`, `fetch`. There is **no** `commit`/`push`/`openPr` — and **no automatic PR pipeline**. Commit → push → `gh pr create` is done by the **worker itself**, via bash inside its own worktree, when the master instructs it through `send_worker`. (The README §Fleet description of an auto-PR pipeline is stale; trust the source.)

`RealGitOps` shells out with `LC_ALL=C`/`LANG=C` (English error messages for the `removeWorktree` "already removed" regex) and `--end-of-options` on every free-form revision/branch arg (SEC-1: stops a base string being read as a `--output=` etc.). `FakeGitOps` records calls for tests.

See also: [master-worker-turn.md](./master-worker-turn.md), `../reference/data-model.md` (`workers`, `worker_events`, `worker_checkpoints`, `pending_notifications`), `../reference/events.md` (`worker.*`).
