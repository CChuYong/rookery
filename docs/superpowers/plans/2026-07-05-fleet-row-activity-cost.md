# Fleet-row last-activity + cost Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve per-worker `lastActivityTs` + `costUsd` from `fleet.list` (both from existing `worker_events` via one indexed batched query) so the desktop fleet sidebar shows each worker's last-activity time (on repo-name-labeled rows) and cost (all rows) without opening it, and the fleet-total is accurate.

**Architecture:** Add two optional fields to the shared protocol `WorkerRow`. A new batched `Repositories.workerActivityAndCost()` computes both metrics for the whole fleet in one `GROUP BY worker_id` pass; `FleetOrchestrator.list()` spreads them per row. The renderer's `WorkerCost`/`WorkerActivity`/`FleetBurn` prefer `max(fleetValue, workerLogsValue)` so never-opened workers use the snapshot and streaming workers keep live freshness.

**Tech Stack:** TypeScript (ESM NodeNext, `.js` imports, `import type`), Node 22, better-sqlite3 (JSON1 built in), vitest, React 18 + Zustand + Testing Library (desktop, jsdom).

## Global Constraints

- Node 22 ABI 127 — run `nvm use 22` (or a Node-22 `node` on PATH) before any build/test.
- ESM NodeNext: relative imports need `.js`; type-only imports use `import type`.
- Code comments in English.
- No DB migration — reuse the existing `worker_events` table + `idx_worker_events(worker_id, seq)`.
- New protocol fields are OPTIONAL (`lastActivityTs?: number`, `costUsd?: number`) — back-compat, absent when the worker has no such event.
- `created_at` is ISO 8601 (`new Date().toISOString()`), so `MAX(created_at)` is sortable and `Date.parse`-able to ms (matches the renderer's `Date.parse(ev.createdAt)`).
- Cost is a cumulative (non-decreasing) total in each `result` event's `costUsd`, so the latest total = `MAX(json_extract(payload_json,'$.costUsd'))`.
- Display rule (unchanged): the relative-time **subline** is shown only on fallback (repo-name) labeled rows; **cost** is shown on all rows.
- Verification gate: `npm run typecheck` + `npm test` (root) for Task 1; `npm -w apps/desktop run typecheck` + `npm -w apps/desktop test` for Task 2.

---

### Task 1: Daemon — batched metric query + protocol fields + fleet.list injection

**Files:**
- Modify: `src/persistence/repositories.ts` (add `workerActivityAndCost()`, after `lastWorkerEventPayload` ~line 265)
- Modify: `src/protocol/messages.ts:147-157` (`WorkerRow`: add two optional fields)
- Modify: `src/core/fleet-orchestrator.ts:647-665` (`list()`: return type + inject metrics)
- Test: `test/persistence/repositories.test.ts`, `test/core/fleet-orchestrator.test.ts`

**Interfaces:**
- Produces:
  - `Repositories.workerActivityAndCost(): Map<string, { lastActivityTs?: number; costUsd?: number }>`
  - protocol `WorkerRow.lastActivityTs?: number`, `WorkerRow.costUsd?: number`
  - `FleetOrchestrator.list()` rows now carry `lastActivityTs?`/`costUsd?`

- [ ] **Step 1: Write the failing repo test**

Append to `test/persistence/repositories.test.ts` (inside the top-level `describe`, or add a new `describe("workerActivityAndCost", …)` block). It uses a controllable clock so timestamps are deterministic:

```ts
describe("workerActivityAndCost", () => {
  it("returns each worker's last message ts (ms) and its max cumulative cost; omits absent metrics and event-less workers", () => {
    let cur = "2026-01-01T00:00:00.000Z";
    const repos = new Repositories(openDb(":memory:"), () => cur);
    repos.createSession({ id: "s", cwd: "/x" });

    // w1: two messages + two results (cumulative cost grows)
    repos.createWorker({ id: "w1", sessionId: "s", repoPath: "/r", label: "app", worktreePath: "/wt1", branch: "b1" });
    cur = "2026-01-01T00:00:01.000Z"; repos.addWorkerEvent({ workerId: "w1", seq: 0, type: "message", payloadJson: JSON.stringify({ kind: "message", role: "assistant", content: "hi" }) });
    cur = "2026-01-01T00:00:02.000Z"; repos.addWorkerEvent({ workerId: "w1", seq: 1, type: "result", payloadJson: JSON.stringify({ kind: "result", costUsd: 0.5 }) });
    cur = "2026-01-01T00:00:03.000Z"; repos.addWorkerEvent({ workerId: "w1", seq: 2, type: "message", payloadJson: JSON.stringify({ kind: "message", role: "assistant", content: "more" }) });
    cur = "2026-01-01T00:00:04.000Z"; repos.addWorkerEvent({ workerId: "w1", seq: 3, type: "result", payloadJson: JSON.stringify({ kind: "result", costUsd: 1.25 }) });

    // w2: a message only (no result → no cost)
    repos.createWorker({ id: "w2", sessionId: "s", repoPath: "/r", label: "b", worktreePath: "/wt2", branch: "b2" });
    cur = "2026-01-01T00:00:05.000Z"; repos.addWorkerEvent({ workerId: "w2", seq: 0, type: "message", payloadJson: JSON.stringify({ kind: "message", role: "assistant", content: "x" }) });

    // w3: no events at all
    repos.createWorker({ id: "w3", sessionId: "s", repoPath: "/r", label: "c", worktreePath: "/wt3", branch: "b3" });

    const m = repos.workerActivityAndCost();
    expect(m.get("w1")).toEqual({ lastActivityTs: Date.parse("2026-01-01T00:00:03.000Z"), costUsd: 1.25 });
    expect(m.get("w2")!.lastActivityTs).toBe(Date.parse("2026-01-01T00:00:05.000Z"));
    expect(m.get("w2")!.costUsd).toBeUndefined();
    expect(m.has("w3")).toBe(false);
  });
});
```

(If `openDb`/`Repositories` are not already imported in this file, add `import { openDb } from "../../src/persistence/db.js";` and `import { Repositories } from "../../src/persistence/repositories.js";`.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/persistence/repositories.test.ts -t "workerActivityAndCost"`
Expected: FAIL — `repos.workerActivityAndCost is not a function`.

- [ ] **Step 3: Implement `workerActivityAndCost`**

In `src/persistence/repositories.ts`, add this method right after `lastWorkerEventPayload` (~line 265):

```ts
  // worker_id → { lastActivityTs?, costUsd? } for the WHOLE fleet in one indexed GROUP BY pass (idx_worker_events).
  // lastActivityTs = ms of the last 'message' event (created_at is ISO → MAX is latest, Date.parse → ms, matching the
  // renderer). costUsd = the last 'result' event's cumulative total (non-decreasing → MAX). Absent metric = no such event;
  // a worker with neither is omitted from the map.
  workerActivityAndCost(): Map<string, { lastActivityTs?: number; costUsd?: number }> {
    const rows = this.db
      .prepare(
        "SELECT worker_id AS id, " +
          "MAX(CASE WHEN type = 'message' THEN created_at END) AS last_msg, " +
          "MAX(CASE WHEN type = 'result' THEN json_extract(payload_json, '$.costUsd') END) AS cost_usd " +
          "FROM worker_events GROUP BY worker_id",
      )
      .all() as Array<{ id: string; last_msg: string | null; cost_usd: number | null }>;
    const out = new Map<string, { lastActivityTs?: number; costUsd?: number }>();
    for (const r of rows) {
      const entry: { lastActivityTs?: number; costUsd?: number } = {};
      if (r.last_msg != null) {
        const ms = Date.parse(r.last_msg);
        if (!Number.isNaN(ms)) entry.lastActivityTs = ms;
      }
      if (r.cost_usd != null) entry.costUsd = Number(r.cost_usd);
      if (entry.lastActivityTs !== undefined || entry.costUsd !== undefined) out.set(r.id, entry);
    }
    return out;
  }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/persistence/repositories.test.ts -t "workerActivityAndCost"`
Expected: PASS.

- [ ] **Step 5: Add the two optional protocol fields**

In `src/protocol/messages.ts`, inside the `WorkerRow` interface (after `ticketUrl?: string | null;`, line 156):

```ts
  lastActivityTs?: number; // ms epoch of the worker's last message event (fleet.list snapshot); absent if it has none
  costUsd?: number;        // cumulative $ from the worker's last result event; absent if it never completed a turn
```

- [ ] **Step 6: Inject the metrics in `FleetOrchestrator.list()`**

In `src/core/fleet-orchestrator.ts`, replace `list()` (lines 647-665) with (adds the two optional fields to the return type, fetches the map once, spreads per row):

```ts
  list(filter?: { status?: string; repoPath?: string }): Array<{ id: string; label: string; repoPath: string; status: string; branch: string | null; model: string | null; permissionMode: string; archived: boolean; ticketKey: string | null; ticketUrl: string | null; lastActivityTs?: number; costUsd?: number }> {
    const metrics = this.deps.repos.workerActivityAndCost(); // one indexed batched query for the whole fleet
    return this.deps.repos
      .listAllWorkers()
      .map((r) => ({
        id: r.id,
        label: r.label,
        repoPath: r.repo_path,
        // DB status is the most up-to-date (records both the Worker's running↔idle transitions and FleetOrchestrator's terminal states).
        status: r.status,
        branch: r.branch,
        model: r.model,
        permissionMode: r.permission_mode, // SDK permission mode (bypassPermissions | plan) — the worker composer's live selector reads this
        archived: !!r.archived_at, // archived or not — the UI splits into tree/archive
        ticketKey: r.ticket_key,
        ticketUrl: r.ticket_url,
        ...(metrics.get(r.id) ?? {}), // lastActivityTs / costUsd from worker_events (absent when the worker has neither)
      }))
      .filter((x) => (filter?.status ? x.status === filter.status : true))
      .filter((x) => (filter?.repoPath ? x.repoPath === filter.repoPath : true));
  }
```

- [ ] **Step 7: Write the fleet `list()` test**

Append to `test/core/fleet-orchestrator.test.ts` (inside the `describe("FleetOrchestrator", …)`). It reuses the file's `setup()` helper and seeds a worker + result event directly via `repos`:

```ts
  it("list() carries lastActivityTs + costUsd from the worker's events", () => {
    const { repos, fleet } = setup();
    repos.createWorker({ id: "wX", sessionId: "sA", repoPath: "/r", label: "app", worktreePath: "/wt/wX", branch: "b" });
    repos.addWorkerEvent({ workerId: "wX", seq: 0, type: "message", payloadJson: JSON.stringify({ kind: "message", role: "assistant", content: "hi" }) });
    repos.addWorkerEvent({ workerId: "wX", seq: 1, type: "result", payloadJson: JSON.stringify({ kind: "result", costUsd: 2.5 }) });
    const row = fleet.list().find((w) => w.id === "wX")!;
    expect(row.costUsd).toBe(2.5);
    expect(typeof row.lastActivityTs).toBe("number");
  });
```

- [ ] **Step 8: Run the daemon suite + typecheck**

Run: `npx vitest run test/persistence/repositories.test.ts test/core/fleet-orchestrator.test.ts`
Expected: PASS (including the two new tests).

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 9: Full root suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/persistence/repositories.ts src/protocol/messages.ts src/core/fleet-orchestrator.ts test/persistence/repositories.test.ts test/core/fleet-orchestrator.test.ts
git commit -m "feat(fleet): serve per-worker lastActivityTs + costUsd in fleet.list

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Renderer — prefer the fleet-provided activity/cost (shown without opening)

Consumes Task 1. The protocol `WorkerRow` fields already flow into `FleetRow` (it `extends WorkerRow`) and into the store via `setFleet`'s spread — no store edit. Wire the two values into the render components with `max(fleet, log)`.

**Files:**
- Modify: `apps/desktop/src/renderer/components/WorkerCost.tsx` (`WorkerCost` + `FleetBurn`)
- Modify: `apps/desktop/src/renderer/views/RepoTree.tsx` (`WorkerActivity` + the three render sites)
- Test: `apps/desktop/test/repo-tree.test.tsx`

**Interfaces:**
- Consumes (Task 1): `FleetRow.lastActivityTs?: number`, `FleetRow.costUsd?: number` (via protocol `WorkerRow`).
- Produces: `WorkerCost({ workerId, fleetCost? })`, `FleetBurn({ rows })`, `WorkerActivity({ workerId, fleetTs? })`.

- [ ] **Step 1: Write the failing renderer tests**

In `apps/desktop/test/repo-tree.test.tsx`, add to the existing `describe("RepoTree fallback-label disambiguating subline (audit #46)", …)` block (after the last `it`, before its closing `});`):

```ts
  it("shows the subline from the fleet lastActivityTs with NO log loaded (no open needed)", () => {
    // workerLogs is empty (beforeEach) — the time comes purely from the fleet.list snapshot
    render(
      <RepoTree
        repos={[repo] as never}
        fleet={[{ ...fallbackWorker, lastActivityTs: Date.now() }] as never}
        activeSubId={null}
        onSelectSub={() => {}} onNewRepo={() => {}} onRemoveRepo={() => {}} onNewSub={() => {}}
      />,
    );
    expect(screen.getByText("방금")).toBeInTheDocument();
  });
```

And add a new describe block at the end of the file (before the final closing brace of the file, i.e. as a new top-level `describe`):

```ts
describe("RepoTree fleet-provided cost (no open needed)", () => {
  beforeEach(() => useStore.setState({ workerLogs: {} }));

  it("shows a worker's cost from the fleet costUsd with no log loaded", () => {
    render(
      <RepoTree
        repos={[repo] as never}
        fleet={[{ ...worker, costUsd: 2.5 }] as never}
        activeSubId={null}
        onSelectSub={() => {}} onNewRepo={() => {}} onRemoveRepo={() => {}} onNewSub={() => {}}
      />,
    );
    expect(screen.getByText("$2.50")).toBeInTheDocument();
  });

  it("the fleet-burn total sums fleet costUsd across workers even when none are opened", () => {
    render(
      <RepoTree
        repos={[repo] as never}
        fleet={[{ ...worker, costUsd: 2.5 }, { ...fallbackWorker, costUsd: 1.25 }] as never}
        activeSubId={null}
        onSelectSub={() => {}} onNewRepo={() => {}} onRemoveRepo={() => {}} onNewSub={() => {}}
      />,
    );
    expect(screen.getByText("$3.75")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run apps/desktop/test/repo-tree.test.tsx -t "fleet"` (from repo root) or `npm -w apps/desktop test -- repo-tree`
Expected: FAIL — the subline/cost come only from `workerLogs` today, so with empty logs nothing renders.

- [ ] **Step 3: Make `WorkerCost` + `FleetBurn` prefer the fleet value**

In `apps/desktop/src/renderer/components/WorkerCost.tsx`, replace `WorkerCost` and `FleetBurn` (lines 22-44) with:

```ts
export function WorkerCost({ workerId, fleetCost }: { workerId: string; fleetCost?: number }): JSX.Element | null {
  const t = useT();
  const logCost = useStore((s) => latestCost(s.workerLogs[workerId] ?? EMPTY));
  const cost = Math.max(logCost, fleetCost ?? 0); // fleet.list snapshot shows cost without opening; the live log wins when higher (fresher)
  if (!cost) return null;
  return <span className="shrink-0 font-mono text-[9px] tabular-nums text-muted/70" title={t("workerCost.workerTitle")}>{fmtUsd(cost)}</span>;
}

// Fleet-wide spend = sum of each live worker's cumulative cost (fleet snapshot, or the live log when higher). The "fleet
// is burning" signal — now accurate for never-opened workers too, not just the ones whose logs are loaded.
export function FleetBurn({ rows }: { rows: Array<{ id: string; costUsd?: number }> }): JSX.Element | null {
  const t = useT();
  const total = useStore((s) => rows.reduce((sum, r) => sum + Math.max(latestCost(s.workerLogs[r.id] ?? EMPTY), r.costUsd ?? 0), 0));
  if (!total) return null;
  return (
    <div
      className="mx-1 mb-0.5 flex items-center gap-1.5 rounded-md border border-line bg-ink/40 px-2 py-1 font-mono text-[10.5px] text-fg-dim"
      title={t("workerCost.fleetTitle")}
    >
      <Coins size={11} className="shrink-0 text-muted" />
      <span className="text-muted">{t("workerCost.fleetLabel")}</span>
      <span className="ml-auto tabular-nums">{fmtUsd(total)}</span>
    </div>
  );
}
```

- [ ] **Step 4: Make `WorkerActivity` prefer the fleet ts + wire the three render sites**

In `apps/desktop/src/renderer/views/RepoTree.tsx`, change the `WorkerActivity` signature + `ts` (lines 41-45):

```ts
function WorkerActivity({ workerId, fleetTs }: { workerId: string; fleetTs?: number }): JSX.Element | null {
  const t = useT();
  const locale = useLocale();
  const logTs = useStore((s) => lastActivityTs(s.workerLogs[workerId] ?? EMPTY_LOG));
  const ts = Math.max(logTs ?? 0, fleetTs ?? 0) || null; // fleet snapshot covers never-opened workers; the live log wins when fresher
  if (ts === null) return null;
```

(The rest of `WorkerActivity` — `relativeTime(ts, now)` etc. — is unchanged; it already uses `ts`.)

Then update the three call sites:
- Line 145: `{fallback && <WorkerActivity workerId={sub.id} />}` → `{fallback && <WorkerActivity workerId={sub.id} fleetTs={sub.lastActivityTs} />}`
- Line 150: `<WorkerCost workerId={sub.id} />` → `<WorkerCost workerId={sub.id} fleetCost={sub.costUsd} />`
- Line 231: `<FleetBurn ids={live.map((f) => f.id)} />` → `<FleetBurn rows={live} />`

- [ ] **Step 5: Run the renderer tests to verify they pass**

Run: `npm -w apps/desktop test -- repo-tree`
Expected: PASS (the new fleet-provided tests plus the existing subline/cost/status tests unchanged).

- [ ] **Step 6: Typecheck + desktop suite**

Run: `npm -w apps/desktop run typecheck`
Expected: PASS (`FleetRow` carries the new optional fields via the protocol type; `sub.lastActivityTs`/`sub.costUsd` and `<FleetBurn rows={live}>` all typecheck).

Run: `npm -w apps/desktop test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/components/WorkerCost.tsx apps/desktop/src/renderer/views/RepoTree.tsx apps/desktop/test/repo-tree.test.tsx
git commit -m "feat(desktop): fleet rows show last-activity + cost without opening (from fleet.list)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- `fleet.list` carries `lastActivityTs` + `costUsd` → Task 1 Steps 5-6. ✓
- Cheap batched query from `worker_events` (last message ts + max cumulative cost) → Task 1 Step 3. ✓
- Single injection at `FleetOrchestrator.list()` → Task 1 Step 6. ✓
- Renderer auto-flow via `FleetRow extends WorkerRow` + `setFleet` spread (no store edit) → relied on in Task 2 (no store file touched). ✓
- `WorkerActivity` fleet ts, fallback-only, `max` freshness → Task 2 Step 4. ✓
- `WorkerCost` on all rows via `max` → Task 2 Step 3. ✓
- `FleetBurn` accurate total → Task 2 Steps 3-4. ✓
- Edge cases (no message → no ts; no result → no cost; event-less worker omitted) → Task 1 Step 1 asserts all three. ✓
- ISO-clock test requirement → Task 1 Step 1 injects a controllable ISO clock. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. Step 2 of Task 2's "or" on the test-run command is a convenience, not a missing value.

**Type consistency:** `workerActivityAndCost(): Map<string, { lastActivityTs?: number; costUsd?: number }>` is defined in Task 1 Step 3 and consumed in `list()` (Task 1 Step 6) via `metrics.get(r.id)`. The protocol fields `lastActivityTs?: number`/`costUsd?: number` (Task 1 Step 5) match `FleetRow` usage `sub.lastActivityTs`/`sub.costUsd` and the component props `fleetTs?: number`/`fleetCost?: number` (Task 2). `FleetBurn({ rows })` takes `Array<{ id: string; costUsd?: number }>`, satisfied by `live: FleetRow[]`. `fmtUsd(2.5) === "$2.50"`, `fmtUsd(3.75) === "$3.75"` (format.ts:15) — test assertions match.
