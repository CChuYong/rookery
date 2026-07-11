# Worker-Settled Automation Trigger — Design

Date: 2026-07-11
Status: approved (conversation-designed), ready for implementation
Branch: `feat/worker-settled-trigger`
Prerequisite: the background-aware worker state machine + settle-grace (merged, `..6e722cd`) — `idle` now truthfully means "all assigned work complete", so idle is a trustworthy trigger signal.

## Goal

A new automation trigger kind `worker`: fire a master-turn or worker-spawn action when a fleet worker **settles**. This is the first *internal-event* trigger source (the "reactive fleet" unlock): worker→worker handoff ("구현 워커 종료 → 같은 브랜치에 리뷰어 스폰"), failure alerting/self-healing ("워커 error → Slack 보고/수정 워커"), and completion follow-ups — with no polling by the master.

## Trigger config

```ts
{ kind: "worker"; repo?: string; on?: Array<"idle" | "stopped" | "failure">; label?: string }
```

- **`on` — settle buckets** (UI checkboxes): `idle` = 작업 완료(dispatch complete, worker alive) · `stopped` = 의도적 종료(stop/discard/caps; legacy `done` folds in) · `failure` = `error`/`failed`/`orphaned`.
  **Default (absent/empty): `["stopped","failure"]`** — idle is opt-in: it is the most re-fire-prone bucket, so a fresh rule must not catch it by surprise.
- **`repo`**: registered repo name; matches the worker's `repo_path` resolved via `getRepoByPath`. Unset = all repos. (A worker in an unregistered repo has no name → repo-filtered rules never match it.)
- **`label`**: case-insensitive substring on the worker label (mirrors slack `keyword`). Unset = all.

## Guards (the two real hazards)

1. **Loop guard**: a `worker`-trigger + `worker`-action rule would react to its own spawns forever. Workers spawned by automations live under the hidden `automation:fleet` home session → **workers whose home session's `external_key === AUTOMATION_FLEET_SESSION_KEY` are excluded from matching**, structurally breaking self-loops with no depth counter. Workers from every other origin (UI, master, Slack, external MCP) match normally.
2. **Once-latch**: `idle` recurs per dispatch (a steered worker goes idle repeatedly), and terminal statuses can double-emit on the bus (two writers: `Worker.transition` + `FleetOrchestrator.setStatus`). The source keeps an **in-memory once-per-(automation, worker) latch** — one fire per worker per automation, process-lifetime. A daemon restart resets it (at-most-once per process; documented, persistence deferred). The latch is checked/армed before dispatch, so the settle double-emit can't race it (bus delivery is synchronous).

## Template vars

`{{workerId}}` `{{repo}}` (registered name, falls back to repo_path) `{{branch}}` `{{status}}` (raw: idle/stopped/error/…) `{{label}}` `{{tail}}` (last assistant message ≤500 chars — extracted by the same logic as WorkerNotifier, refactored into a shared `extractWorkerTail`).

All are substituted through the existing `applyVars` **fencing** (`<untrusted-worker-…>` + per-call nonce) — `label`/`tail` are model-generated text (genuinely untrusted); the rest are fenced uniformly for consistency. Slack vars substitute to empty for worker-triggered runs and vice versa (existing behavior).

## Architecture (the established trigger seam — dispatcher/action/scheduler untouched)

- **`src/core/automation-match.ts`**: `matchesWorker(t, e)` pure matcher + `WORKER_SETTLE_BUCKET` (status→bucket map) + `DEFAULT_WORKER_TRIGGER_ON`.
- **`src/core/worker-trigger-source.ts`** (NEW): subscribes `bus(ALL_CHANNEL)` for `worker.status` (exactly like WorkerNotifier), buckets the status, applies the loop guard + latch, **re-reads the rule fresh at dispatch time** (parity with the slack source), and fires `dispatcher.run(a, vars)` **concurrently** (event trigger — no overlap-skip; the dispatcher's cron/interval guard doesn't apply to `worker`).
- **`src/core/automation-action.ts`**: `ActionVars` + `applyVars` gain the six worker tokens.
- **`src/core/worker-notifier.ts`**: extract `extractWorkerTail` (shared with the source).
- **Protocol**: `triggerSchema` union member; `automation.run` vars schema gains the worker keys (manual run-now can supply them).
- **Scheduler**: no change (non-time kinds already fall through reconcile/tick).
- **server.ts**: `startWorkerTriggerSource({ repos, dispatcher, bus })` wired next to the notifier; unsubscribe on shutdown.

## Desktop

- **AutomationForm**: trigger kind "워커 완료(worker settled)" → repo select (전체/등록 repo), three settle checkboxes (기본: 종료+실패 ✓, 작업 완료 ✗), label substring input. At least one bucket required for save.
- **AutomationPage**: trigger badge `worker: <repo|전체> · <buckets> · "label"` + next-run column not applicable (event kind).
- **automation-vars.ts**: `KNOWN_AUTOMATION_VARS` + the six worker tokens (run-now dialog picks up referenced ones).
- i18n ko/en.

## Testing

- `automation-match`: bucket mapping (done→stopped), default-on (idle excluded), repo/label filters, empty-config matches all terminal.
- `worker-trigger-source`: fires on stopped with vars; idle NOT fired by default / fired when opted in; loop guard (automation:fleet home); once-latch (terminal double-emit → 1 run; repeated idle → 1 run); disabled/fresh-reread semantics; unknown status (running/background/provisioning) ignored.
- `automation-action`: worker vars substitute + fenced (nonce tags), missing vars → empty.
- protocol: worker trigger parses; bad `on` value rejected; run vars accept worker keys.
- repositories: worker trigger round-trip.
- desktop: form submit (kind/on/repo/label), badge rendering, default checkboxes.

## Out of scope

Latch persistence across restarts; per-bucket latching (one automation fires once per worker, period); webhook/polling trigger sources (next roadmap items); reacting to automation-spawned workers (deliberately excluded by the loop guard).
