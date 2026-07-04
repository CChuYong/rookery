# Fleet rows show last-activity + cost without opening each worker (design)

- Date: 2026-07-05
- Status: approved (design), pre-authorized full run → straight to plan
- Area: daemon (`src/protocol` + `src/core/fleet-orchestrator` + `src/persistence`) + desktop renderer (`apps/desktop/src/renderer`)

## Problem

In the desktop Repos/fleet sidebar (`RepoTree.tsx`), a worker's relative-time subline ("5d ago") and its cost ("$3.84") only appear **after the worker has been opened at least once this session** — because both are read from `workerLogs` (the streamed transcript), which is populated lazily via `worker.history` on open (or live streaming). Result: the sidebar shows time/cost inconsistently (only for opened/streaming workers), and the fleet-total header (`FleetBurn`, "fleet $420.91") only sums opened workers, so it under-reports.

## Goal / non-goals

**Goal**: the fleet sidebar shows each worker's last-activity time and cost **without opening it**, by having `fleet.list` carry per-worker `lastActivityTs` + `costUsd`. The fleet-total becomes accurate.

**Non-goals**: no DB migration (reuse existing `worker_events` + its index); no change to the display rule that the time **subline** is shown only on repo-name-fallback-labeled rows (per decision below); no change to how live cost/activity updates for a currently-streaming worker (that keeps coming from `workerLogs`).

## Decisions

- **Time subline scope**: stays **fallback-label-only** (repo-name-labeled rows — audit #46), now shown reliably from fleet data instead of only after open. Task-titled rows still get no subline (already disambiguated).
- **Cost**: shown on **all** rows (right side), reliably from fleet data.
- **Freshness**: render components use `max(fleetValue, workerLogsValue)` — the fleet snapshot covers never-opened workers; the live log wins for a currently-streaming worker (fresher).

## Data sources (both cheap — no transcript summing)

- **Cost** is already stored as a **cumulative running total** in every worker `result` event payload (`worker.ts:358` `cumCostUsd`; event kind `events.ts:10` `costUsd`; persisted to `worker_events` via `record()`). Because it's non-decreasing, the latest total = `MAX(json_extract(payload_json,'$.costUsd'))` over `type='result'` rows.
- **Last activity** = latest `created_at` over `type='message'` rows. `created_at` is set to `now()` = `new Date().toISOString()` (repositories.ts:104) — ISO 8601, so it is both lexicographically sortable (`MAX`) and `Date.parse`-able to ms (matching the renderer's `Date.parse(ev.createdAt)` at store.ts:273). The `idx_worker_events(worker_id, seq)` index keeps this cheap.

Both computed in ONE batched pass:
```sql
SELECT worker_id,
  MAX(CASE WHEN type='message' THEN created_at END)                        AS last_msg,
  MAX(CASE WHEN type='result'  THEN json_extract(payload_json,'$.costUsd') END) AS cost_usd
FROM worker_events
GROUP BY worker_id
```
(One indexed scan for the whole fleet, not N point-queries.)

## Server changes (`src/`)

1. **Protocol** — `src/protocol/messages.ts:147` `WorkerRow` interface: add
   ```ts
   lastActivityTs?: number; // ms epoch of the worker's last message event (fleet.list snapshot); absent if it has none
   costUsd?: number;        // cumulative $ from the worker's last result event; absent if it has never completed a turn
   ```
   These flow to both `fleet.list.result` and `worker.list.result` (both use `WorkerRow`).
2. **Repositories** — `src/persistence/repositories.ts`: new batched method
   ```ts
   // worker_id → { lastActivityTs?: ms, costUsd?: number } for the whole fleet in one indexed pass. Absent metric = no such event.
   workerActivityAndCost(): Map<string, { lastActivityTs?: number; costUsd?: number }>
   ```
   Runs the query above; for each row, `lastActivityTs = last_msg == null ? undefined : Date.parse(last_msg)` and `costUsd = cost_usd == null ? undefined : Number(cost_usd)`. Skip map entries where both are absent.
3. **FleetOrchestrator.list()** — `src/core/fleet-orchestrator.ts:647`: call `workerActivityAndCost()` once, then spread `...(m.get(r.id) ?? {})` into each mapped row. Single injection point → both list endpoints get it.

## Renderer changes (`apps/desktop/src/renderer`)

- The protocol `WorkerRow` addition auto-flows: `FleetRow extends WorkerRow` (reduce.ts:17); `setFleet`'s `{ ...r }` spread (store.ts:238) carries the new fields into the store — **no store/reducer edit**.
- **`WorkerActivity`** (RepoTree.tsx:41): additionally accept the row's `lastActivityTs`; use `max(fleetTs ?? 0, logTs ?? 0)` (→ null if both absent). Still rendered only under `fallback` (RepoTree.tsx:145).
- **`WorkerCost`** (WorkerCost.tsx): accept the row's `costUsd`; display `max(fleetCost, logCost)`. Now non-zero for never-opened workers → shows on all rows.
- **`FleetBurn`** (WorkerCost.tsx:30): sum `max(fleetCost, logCost)` per id → accurate fleet total. It needs access to each row's fleet `costUsd`, so it takes the fleet rows (or an id→cost map) instead of only ids.
- Wiring: `RepoTreeImpl` already holds `fleet: FleetRow[]` (RepoTree.tsx:61); pass each `sub`'s `lastActivityTs`/`costUsd` into the two components, and the fleet cost map into `FleetBurn`.

Live `worker.spawned/status/label` reducers (reduce.ts:250-271) still build rows without these fields; the next `fleet.list`/`setFleet` reconciles them (same pattern already used for `permissionMode`).

## Edge cases

- Worker with no `message` events → `lastActivityTs` absent → subline hidden (unchanged behavior).
- Worker with no `result` event (never finished a turn) → `costUsd` absent → cost shows nothing / 0 (unchanged).
- Archived workers are in `listAllWorkers()` too; the batched map covers them harmlessly (they're hidden from the tree regardless).
- Streaming worker: live `workerLogs` cost/ts may exceed the snapshot → `max` picks the live value.
- Deterministic-clock tests must inject an **increasing ISO** `now` (the default is ISO); a constant non-ISO clock makes `Date.parse` NaN — repo tests seed distinct ISO timestamps.

## Testing

- **Repo** (`test/persistence/repositories.test.ts`): seed a worker with message + result events (distinct ISO timestamps, increasing cumulative cost) → `workerActivityAndCost()` returns the last message's ms + the max cost; a worker with only messages → cost absent; a worker with no events → not in the map.
- **Fleet** (`test/core/fleet-orchestrator.test.ts`): `list()` includes `lastActivityTs`/`costUsd` for a worker with events.
- **Renderer**: `WorkerCost` shows the fleet `costUsd` for a worker with no `workerLogs`; prefers the larger of fleet vs log (max). `WorkerActivity` renders the fleet ts for a never-opened fallback-labeled worker. `FleetBurn` sums fleet costs across rows. (`test/usage`/existing renderer test files pattern.)

## Out of scope

- Showing the time subline on task-titled rows (kept fallback-only).
- Any recompute/caching of the fleet metrics beyond the per-`fleet.list` query (it's a cheap indexed scan; no cache needed).
- Per-worker token counts or other metrics beyond cost + last-activity.
