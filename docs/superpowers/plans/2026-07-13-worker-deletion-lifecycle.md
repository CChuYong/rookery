# Worker Deletion Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make rapid, overlapping worker/worktree deletions remain visually monotonic—once a worker disappears from Repos it cannot be resurrected by a terminal status event or a stale fleet snapshot.

**Architecture:** `FleetOrchestrator` owns an in-memory deletion lifecycle and excludes deleting workers from every `fleet.list` snapshot before slow stop/git cleanup finishes. It broadcasts one phase-based `worker.deletion` event so every connected client observes start/completion/failure; the desktop mirrors that authority with an optimistic tombstone that filters live events and list snapshots. No DB migration is needed: a daemon crash deliberately drops the in-memory deletion intent, and the persisted worker row becomes visible again on reconnect if deletion never committed.

**Tech Stack:** TypeScript, Node 22, SQLite repositories, WebSocket/CoreEvent protocol, React 18, Zustand, Vitest.

## Global Constraints

- Activate Node 22 before every npm command because `better-sqlite3` targets ABI 127.
- Preserve permanent-delete semantics: worktree/checkpoint cleanup stays best-effort, while a successful DB row deletion is the commit point.
- Do not serialize all WebSocket traffic or disable concurrent delete controls; independent worker deletions must remain concurrent.
- Do not add a `deleting_at` migration. The daemon memory set is authoritative only while the daemon process is alive.
- `worker.spawned` and `fleet.list` own fleet membership; `worker.status` may update an existing row but must never create one.
- Keep Korean/English catalogs unchanged; the lifecycle introduces no new visible copy.
- A failed delete restores from an authoritative `fleet.list`; it must not reconstruct a partial row in the renderer.

---

### Task 1: Daemon-owned worker deletion lifecycle

**Files:**
- Modify: `src/core/events.ts:38-63`
- Modify: `src/core/fleet-orchestrator.ts:623-710`
- Modify: `src/daemon/connection.ts:289-292`
- Modify: `docs/reference/events.md:41-46`
- Test: `test/core/fleet-orchestrator.test.ts`
- Test: `test/daemon/connection.test.ts`

**Interfaces:**
- Produces CoreEvent `{ type: "worker.deletion"; sessionId: string; workerId: string; phase: "started" | "completed" | "failed"; message?: string }`.
- Produces `FleetOrchestrator.deleting: Set<string>` and `deletionFlows: Map<string, Promise<void>>`; `list()` never returns an id in `deleting`.
- Keeps `FleetOrchestrator.delete(id): Promise<void>` as the public API; duplicate calls for one id share the same in-flight promise and emit one lifecycle.

- [ ] **Step 1: Write the overlapping-delete regression test**

Add a gated `FakeGitOps` test that holds worker `a0` inside `removeWorktree`, lets `a1` finish first, and proves the pending worker never re-enters `list()`:

```ts
it("hides every deleting worker from fleet.list while overlapping deletes finish out of order", async () => {
  let releaseA!: () => void;
  const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
  class OutOfOrderDeleteGit extends FakeGitOps {
    override async removeWorktree(repo: string, wt: string, branch: string): Promise<void> {
      if (wt.endsWith("/a0")) await gateA;
      await super.removeWorktree(repo, wt, branch);
    }
  }
  const x = setup({ git: new OutOfOrderDeleteGit({ headValue: "base0" }) });
  const a = await x.fleet.spawn({ homeSessionId: "sA", repoPath: "/r", label: "A", task: "a" });
  const b = await x.fleet.spawn({ homeSessionId: "sA", repoPath: "/r", label: "B", task: "b" });
  const c = await x.fleet.spawn({ homeSessionId: "sA", repoPath: "/r", label: "C", task: "c" });
  await x.fleet.waitAllSettled();
  const phases: string[] = [];
  x.bus.subscribe("@all", (event) => {
    if (event.type === "worker.deletion") phases.push(`${event.workerId}:${event.phase}`);
  });

  const deleteA = x.fleet.delete(a.id);
  await until(() => phases.includes(`${a.id}:started`));
  const deleteB = x.fleet.delete(b.id);
  await deleteB;

  expect(x.fleet.list().map((row) => row.id)).toEqual([c.id]);
  expect(x.repos.getWorker(a.id)).toBeDefined();
  releaseA();
  await deleteA;
  expect(x.fleet.list().map((row) => row.id)).toEqual([c.id]);
  expect(phases).toEqual([
    `${a.id}:started`, `${b.id}:started`, `${b.id}:completed`, `${a.id}:completed`,
  ]);
});
```

- [ ] **Step 2: Write deletion idempotency and failure tests**

Add two tests next to the overlap test:

```ts
it("shares a duplicate delete and emits one started/completed pair", async () => {
  const x = setup();
  const { id } = await x.fleet.spawn({ homeSessionId: "sA", repoPath: "/r", label: "A", task: "a" });
  await x.fleet.waitAllSettled();
  const events: string[] = [];
  x.bus.subscribe("@all", (event) => {
    if (event.type === "worker.deletion") events.push(event.phase);
  });
  await Promise.all([x.fleet.delete(id), x.fleet.delete(id)]);
  expect(events).toEqual(["started", "completed"]);
});

it("re-exposes the row and emits failed when the DB commit fails", async () => {
  const x = setup();
  const { id } = await x.fleet.spawn({ homeSessionId: "sA", repoPath: "/r", label: "A", task: "a" });
  await x.fleet.waitAllSettled();
  const events: Array<{ phase: string; message?: string }> = [];
  x.bus.subscribe("@all", (event) => {
    if (event.type === "worker.deletion") events.push(event);
  });
  vi.spyOn(x.repos, "deleteWorker").mockImplementationOnce(() => { throw new Error("db delete failed"); });
  await expect(x.fleet.delete(id)).rejects.toThrow("db delete failed");
  expect(x.fleet.list().map((row) => row.id)).toContain(id);
  expect(events.map((event) => event.phase)).toEqual(["started", "failed"]);
  expect(events.at(-1)?.message).toContain("db delete failed");
});
```

Import `vi` from Vitest in this test file.

- [ ] **Step 3: Run the core tests and confirm the missing lifecycle fails**

Run: `npx vitest run test/core/fleet-orchestrator.test.ts`

Expected: FAIL because `worker.deletion` is not a `CoreEvent`, `list()` still exposes the gated worker, and duplicate deletes do not share an operation.

- [ ] **Step 4: Add the phase-based CoreEvent and orchestrator state**

Add this member to `CoreEvent` immediately after `worker.status`:

```ts
| {
    type: "worker.deletion";
    sessionId: string;
    workerId: string;
    phase: "started" | "completed" | "failed";
    message?: string;
  }
```

Add these fields to `FleetOrchestrator`:

```ts
private readonly deleting = new Set<string>();
private readonly deletionFlows = new Map<string, Promise<void>>();
```

Replace `delete()` with an idempotent wrapper plus a private operation:

```ts
async delete(id: string): Promise<void> {
  const current = this.deletionFlows.get(id);
  if (current) return current;
  const row = this.deps.repos.getWorker(id);
  const entry = this.entries.get(id);
  if (!row && !entry && !this.flowById.has(id)) return;
  const sessionId = row?.session_id ?? entry?.homeSessionId ?? "";
  const flow = this.performDelete(id, sessionId);
  this.deletionFlows.set(id, flow);
  return flow;
}

private async performDelete(id: string, sessionId: string): Promise<void> {
  this.deleting.add(id);
  this.deps.bus.emit({ type: "worker.deletion", sessionId, workerId: id, phase: "started" });
  try {
    try { await this.discard(id); } catch { /* worktree cleanup remains best-effort */ }
    this.deps.repos.deleteWorker(id);
    this.entries.delete(id);
    this.deps.bus.emit({ type: "worker.deletion", sessionId, workerId: id, phase: "completed" });
  } catch (error) {
    this.deps.bus.emit({
      type: "worker.deletion",
      sessionId,
      workerId: id,
      phase: "failed",
      message: String(error),
    });
    throw error;
  } finally {
    this.deleting.delete(id);
    this.deletionFlows.delete(id);
  }
}
```

Filter the batched list after mapping and before caller filters:

```ts
.filter((row) => !this.deleting.has(row.id))
.filter((row) => (filter?.status ? row.status === filter.status : true))
.filter((row) => (filter?.repoPath ? row.repoPath === filter.repoPath : true));
```

- [ ] **Step 5: Return a correlated error when the DB commit fails**

Change the `worker.delete` connection case so the desktop promise cannot hang on an exception:

```ts
case "worker.delete": {
  try {
    await this.fleet.delete(msg.id);
  } catch (error) {
    this.reply({ type: "error", message: String(error), reqId: msg.reqId });
    return;
  }
  this.reply({ type: "fleet.ack", reqId: msg.reqId, action: "delete", id: msg.id });
  return;
}
```

Extend the existing connection delete-routing test with a rejecting fleet and assert an `error` frame carrying the same `reqId`.

```ts
it("worker.delete returns a correlated error when the delete commit fails", async () => {
  const fleet = {
    delete: async () => { throw new Error("db delete failed"); },
  } as unknown as FleetOrchestrator;
  const repos = new Repositories(openDb(":memory:"));
  const sent: any[] = [];
  const socket: ClientSocket = { send: (data) => sent.push(JSON.parse(data)) };
  const conn = new Connection(socket, {} as SessionManager, new EventBus(), fleet, repos);

  await conn.handleRaw(JSON.stringify({ type: "worker.delete", reqId: "q-delete", id: "w1" }));

  expect(sent.at(-1)).toMatchObject({
    type: "error", reqId: "q-delete", message: "Error: db delete failed",
  });
});
```

- [ ] **Step 6: Document the new event and run the focused gate**

Add this row to `docs/reference/events.md`:

```md
| `worker.deletion` | `workerId`, `phase: started\|completed\|failed`, `message?` | permanent worker delete lifecycle | no | `fleet.list` excludes the id from `started` until commit/failure; `failed` makes it visible again |
```

Run: `npx vitest run test/core/fleet-orchestrator.test.ts test/daemon/connection.test.ts test/core/events.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the daemon lifecycle**

```bash
git add src/core/events.ts src/core/fleet-orchestrator.ts src/daemon/connection.ts docs/reference/events.md test/core/fleet-orchestrator.test.ts test/daemon/connection.test.ts
git commit -m "fix(core): make worker deletion a fleet lifecycle"
```

---

### Task 2: Renderer tombstones and membership invariants

**Files:**
- Modify: `apps/desktop/src/renderer/store/reduce.ts:19-35,276-297`
- Modify: `apps/desktop/src/renderer/store/store.ts:14-120,215-265`
- Test: `apps/desktop/test/store-reduce.test.ts`
- Create: `apps/desktop/test/worker-deletion-race.test.ts`

**Interfaces:**
- Extends `AppState` with `deletingWorkers: Record<string, true>`.
- Extends the Zustand store with `beginWorkerDeletion(id)`, `completeWorkerDeletion(id)`, `failWorkerDeletion(id)`, and `resetWorkerDeletions()`.
- Changes the membership invariant: `worker.status` is ignored when its worker is absent or tombstoned; `setFleet()` filters tombstoned ids before replacing `fleet`.

- [ ] **Step 1: Write reducer tests for lifecycle phases and status-event resurrection**

Add these assertions to `apps/desktop/test/store-reduce.test.ts`:

```ts
it("worker deletion tombstones block status resurrection and stale fleet snapshots", () => {
  let state = reduceEvent(emptyState(), {
    type: "worker.spawned", sessionId: "s1", workerId: "w1", repoPath: "/r", label: "one",
  });
  state = reduceEvent(state, {
    type: "worker.deletion", sessionId: "s1", workerId: "w1", phase: "started",
  });
  expect(state.fleet.w1).toBeUndefined();
  expect(state.deletingWorkers.w1).toBe(true);

  state = reduceEvent(state, {
    type: "worker.status", sessionId: "s1", workerId: "w1", status: "stopped",
  });
  expect(state.fleet.w1).toBeUndefined();

  state = reduceEvent(state, {
    type: "worker.deletion", sessionId: "s1", workerId: "w1", phase: "completed",
  });
  expect(state.fleet.w1).toBeUndefined();
  expect(state.deletingWorkers.w1).toBeUndefined();
});

it("worker.status never creates membership without worker.spawned or fleet.list", () => {
  const state = reduceEvent(emptyState(), {
    type: "worker.status", sessionId: "s1", workerId: "ghost", status: "stopped",
  });
  expect(state.fleet.ghost).toBeUndefined();
});
```

- [ ] **Step 2: Write the exact three-worker out-of-order store regression**

Create `apps/desktop/test/worker-deletion-race.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../src/renderer/store/store.js";
import { emptyState } from "../src/renderer/store/reduce.js";

const row = (id: string) => ({
  id, label: id, repoPath: "/repo", status: "stopped", branch: `rookery/${id}`,
  model: null, permissionMode: "bypassPermissions",
});

describe("overlapping worker deletion reconciliation", () => {
  beforeEach(() => useStore.setState({ ...emptyState(), attention: {} }));

  it("never resurrects worker 1 when worker 2 finishes first", () => {
    const store = useStore.getState();
    store.setFleet([row("w1"), row("w2"), row("w3")]);
    store.beginWorkerDeletion("w1");
    store.beginWorkerDeletion("w2");

    // Delete 2 committed first; the server snapshot still contains delete 1's DB row.
    useStore.getState().setFleet([row("w1"), row("w3")]);
    expect(Object.keys(useStore.getState().fleet)).toEqual(["w3"]);

    // Delete 1's late terminal event must not recreate a fallback row or unread marker.
    useStore.getState().applyEvent({
      type: "worker.status", sessionId: "s1", workerId: "w1", status: "stopped",
    });
    expect(Object.keys(useStore.getState().fleet)).toEqual(["w3"]);
    expect(useStore.getState().attention.w1).toBeUndefined();

    useStore.getState().completeWorkerDeletion("w2");
    useStore.getState().completeWorkerDeletion("w1");
    useStore.getState().setFleet([row("w3")]);
    expect(Object.keys(useStore.getState().fleet)).toEqual(["w3"]);
  });

  it("clears a failed tombstone so the authoritative row can return", () => {
    useStore.getState().setFleet([row("w1")]);
    useStore.getState().beginWorkerDeletion("w1");
    useStore.getState().failWorkerDeletion("w1");
    useStore.getState().setFleet([row("w1")]);
    expect(useStore.getState().fleet.w1).toMatchObject({ id: "w1", label: "w1" });
  });
});
```

- [ ] **Step 3: Run the desktop tests and confirm they fail**

Run: `npm -w apps/desktop test -- --run test/store-reduce.test.ts test/worker-deletion-race.test.ts`

Expected: FAIL because `deletingWorkers` and the four store actions do not exist, and `worker.status` currently creates a fallback row.

- [ ] **Step 4: Add deletion state to the pure reducer**

Extend `AppState` and `emptyState()`:

```ts
deletingWorkers: Record<string, true>;

return {
  logsBySession: {}, workerLogs: {}, fleet: {}, deletingWorkers: {}, nested: {},
  sideConversations: {}, pendingBySession: {}, pendingByWorker: {},
};
```

Handle `worker.deletion` before `worker.status`:

```ts
case "worker.deletion": {
  const deletingWorkers = { ...state.deletingWorkers };
  const fleet = { ...state.fleet };
  const pendingByWorker = { ...state.pendingByWorker };
  if (e.phase === "started") deletingWorkers[e.workerId] = true;
  else delete deletingWorkers[e.workerId];
  if (e.phase !== "failed") {
    delete fleet[e.workerId];
    delete pendingByWorker[e.workerId];
  }
  return { ...state, deletingWorkers, fleet, pendingByWorker };
}
case "worker.status": {
  const prev = state.fleet[e.workerId];
  if (!prev || state.deletingWorkers[e.workerId]) return state;
  const pendingByWorker = e.status !== "running" && state.pendingByWorker[e.workerId]?.length
    ? { ...state.pendingByWorker, [e.workerId]: [] }
    : state.pendingByWorker;
  return {
    ...state,
    pendingByWorker,
    fleet: { ...state.fleet, [e.workerId]: { ...prev, status: e.status } },
    logsBySession: {
      ...state.logsBySession,
      [e.sessionId]: appendLog(state, e.sessionId, {
        kind: "worker", workerId: e.workerId, status: e.status,
      }),
    },
  };
}
```

`attention` is store-only, so define one store helper after the `Store` interface and use it for both local actions and server events:

```ts
function applyWorkerDeletionState(
  state: Store,
  workerId: string,
  phase: "started" | "completed" | "failed",
): Partial<Store> {
  const base = reduceEvent(state, {
    type: "worker.deletion", sessionId: "", workerId, phase,
  });
  if (phase === "failed") return base;
  const attention = { ...state.attention };
  delete attention[workerId];
  return { ...base, attention };
}
```

In `applyEvent`, route the server event through that helper before the existing `worker.status` branch:

```ts
if (e.type === "worker.deletion") {
  return applyWorkerDeletionState(s, e.workerId, e.phase);
}
```

Keep the pure reducer responsible for `fleet`, `deletingWorkers`, and `pendingByWorker`; the helper owns only the store-level attention cleanup.

- [ ] **Step 5: Add idempotent store actions and tombstone-aware list replacement**

Add these methods to `Store` and its creator:

```ts
beginWorkerDeletion: (id: string) => void;
completeWorkerDeletion: (id: string) => void;
failWorkerDeletion: (id: string) => void;
resetWorkerDeletions: () => void;
```

Implement the phase actions through the same helper:

```ts
beginWorkerDeletion: (id) => set((state) => applyWorkerDeletionState(state, id, "started")),
completeWorkerDeletion: (id) => set((state) => applyWorkerDeletionState(state, id, "completed")),
failWorkerDeletion: (id) => set((state) => applyWorkerDeletionState(state, id, "failed")),
resetWorkerDeletions: () => set({ deletingWorkers: {} }),
```

Make `setFleet` derive one filtered array and use it for every map prune:

```ts
setFleet: (rows) => set((state) => {
  const visible = rows.filter((row) => !state.deletingWorkers[row.id]);
  const ids = new Set(visible.map((row) => row.id));
  const rowsById = new Map(visible.map((row) => [row.id, row]));
  return {
    fleet: Object.fromEntries(visible.map((row) => [row.id, {
      ...row, permissionMode: row.permissionMode ?? "bypassPermissions",
    }])),
    fleetLoaded: true,
    fleetLoadFailed: false,
    attention: Object.fromEntries(Object.entries(state.attention).filter(([id]) => ids.has(id))),
    pendingByWorker: Object.fromEntries(Object.entries(state.pendingByWorker).filter(([id]) => {
      const row = rowsById.get(id);
      return row?.status === "running";
    })),
  };
}),
```

Before the existing attention logic for `worker.status`, return an empty patch when `!s.fleet[e.workerId] || s.deletingWorkers[e.workerId]` so a late event creates neither a row nor an unread dot.

- [ ] **Step 6: Run the focused desktop tests and typecheck**

Run: `npm -w apps/desktop test -- --run test/store-reduce.test.ts test/worker-deletion-race.test.ts test/repos.test.tsx`

Run: `npm -w apps/desktop run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit the renderer state model**

```bash
git add apps/desktop/src/renderer/store/reduce.ts apps/desktop/src/renderer/store/store.ts apps/desktop/test/store-reduce.test.ts apps/desktop/test/worker-deletion-race.test.ts
git commit -m "fix(desktop): tombstone in-flight worker deletions"
```

---

### Task 3: Desktop request and reconnect wiring

**Files:**
- Modify: `apps/desktop/src/renderer/App.tsx:452-505,595-619`
- Test: `apps/desktop/test/worker-deletion-race.test.ts`

**Interfaces:**
- Consumes the Task 2 store actions and daemon `worker.deletion` events.
- Successful `worker.delete` clears layout and completes the local tombstone as an ack fallback; it does not start a per-delete success refetch.
- A `failed` lifecycle event or request rejection clears the tombstone and requests one authoritative fleet snapshot.

- [ ] **Step 1: Extend the race test with lifecycle event idempotency and reconnect reset**

Add these cases:

```ts
it("accepts duplicate local/server lifecycle phases idempotently", () => {
  useStore.getState().setFleet([row("w1")]);
  useStore.getState().beginWorkerDeletion("w1");
  useStore.getState().applyEvent({
    type: "worker.deletion", sessionId: "s1", workerId: "w1", phase: "started",
  });
  useStore.getState().completeWorkerDeletion("w1");
  useStore.getState().applyEvent({
    type: "worker.deletion", sessionId: "s1", workerId: "w1", phase: "completed",
  });
  expect(useStore.getState().fleet.w1).toBeUndefined();
  expect(useStore.getState().deletingWorkers.w1).toBeUndefined();
});

it("drops stale local deletion intents on reconnect before the fresh fleet seed", () => {
  useStore.getState().setFleet([row("w1")]);
  useStore.getState().beginWorkerDeletion("w1");
  useStore.getState().resetWorkerDeletions();
  useStore.getState().setFleet([row("w1")]);
  expect(useStore.getState().fleet.w1).toBeDefined();
});
```

- [ ] **Step 2: Wire optimistic start, ack fallback, and failure recovery**

Replace `deleteSub` with:

```ts
const deleteSub = useCallback((id: string) => {
  const store = useStore.getState();
  if (store.activeWorkerId === id) store.navigate({ subId: null });
  store.beginWorkerDeletion(id);
  void client?.request({ type: "worker.delete", id }).then(() => {
    useLayoutStore.getState().clear_(id);
    useStore.getState().completeWorkerDeletion(id); // idempotent fallback if the event was missed
  }).catch((error) => {
    useStore.getState().failWorkerDeletion(id);
    toast.error(tRef.current("toast.deleteFailed"), String(error));
    refetchFleet();
  });
}, [refetchFleet]);
```

Do not remove or disable the delete action for other workers while this promise is pending.

- [ ] **Step 3: Wire cross-client failure recovery and reconnect cleanup**

After `applyEvent(e)` in the WebSocket callback, refetch on failed lifecycle:

```ts
if (e.type === "worker.deletion" && e.phase === "failed") {
  void c.request({ type: "fleet.list" })
    .then((result) => useStore.getState().setFleet(result.fleet ?? []))
    .catch(() => {});
}
```

Prevent the existing terminal-status refresh from firing for a tombstoned worker:

```ts
if (
  e.type === "worker.status" &&
  ["failed", "stopped", "error"].includes(e.status) &&
  !useStore.getState().deletingWorkers[e.workerId]
) {
  void c.request({ type: "fleet.list" })
    .then((result) => useStore.getState().setFleet(result.fleet ?? []))
    .catch(() => {});
}
```

At the beginning of `c.onOpen`, before the initial `fleet.list`, call:

```ts
useStore.getState().resetWorkerDeletions();
```

This makes daemon restart recovery authoritative: a deletion that never committed may legitimately return after reconnect.

- [ ] **Step 4: Run focused tests, typecheck, and commit**

Run: `npm -w apps/desktop test -- --run test/worker-deletion-race.test.ts test/store-reduce.test.ts test/repos.test.tsx test/ws-client.test.ts`

Run: `npm -w apps/desktop run typecheck`

Expected: PASS.

```bash
git add apps/desktop/src/renderer/App.tsx apps/desktop/test/worker-deletion-race.test.ts
git commit -m "fix(desktop): reconcile overlapping worker deletes"
```

---

### Task 4: Full regression and live Repos verification

**Files:**
- Modify only files above if verification exposes a defect.

**Interfaces:**
- No new interfaces; proves deletion is monotonic across core, protocol, store, and Electron UI.

- [ ] **Step 1: Run every automated gate with Node 22**

Run: `npm test`

Run: `npm run typecheck`

Run: `npm -w apps/desktop test`

Run: `npm -w apps/desktop run typecheck`

Run: `npm run build && npm -w apps/desktop run build`

Expected: all commands PASS.

- [ ] **Step 2: Launch Electron and verify rapid deletion**

Run: `ROOKERY_DEBUG_PORT=9231 npm -w apps/desktop run dev`

In a disposable registered repository, create three stopped workers under one repo, then confirm Delete on worker 1, worker 2, and worker 3 without waiting for the previous filesystem cleanup. Observe the Repos tree through CDP for the complete request window.

Expected:

- Each confirmed row disappears once and never reappears under its repo or “Other”.
- The repo worker count decreases monotonically `3 → 2 → 1 → 0`.
- No `workerId` fallback row or unread dot appears from late `worker.status:stopped` events.
- A second connected desktop window receives the same removals from `worker.deletion` events without manual refresh.

- [ ] **Step 3: Verify failure recovery with the deterministic tests**

Run: `npx vitest run test/core/fleet-orchestrator.test.ts -t "re-exposes the row"`

Run: `npm -w apps/desktop test -- --run test/worker-deletion-race.test.ts -t "failed tombstone"`

Expected: both PASS; the row returns only after `phase:"failed"` and an authoritative list seed.

- [ ] **Step 4: Inspect the final change set**

Run: `git diff --check`

Run: `git status --short`

Run: `git log --oneline --decorate -3`

Expected: no whitespace errors, only the planned core/protocol/docs/desktop/test files changed, and the three task commits are present.
