# Audit Low Wave (#22 #23 #25 #27 #28 #29 #30 #31 #32 #33 #34 + fork window) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining LOW findings of the 2026-07-03 agent-loop audit plus the fork() pre-entry window discovered by the medium-wave review.

**Architecture:** Seven small fix tasks: fleet spawn/fork hardening (#25 + fork window + #32), master nested-traffic filter (#23), cumulative-counter seeding (#22/#28), spawn-failure live emit (#27), WsClient CONNECTING buffering (#31), dock-layout persistence polish (#33/#34), and two daemon quick-wins (#30 key resolver, #29 lock takeover race). Each task is independently tested and committed.

**Tech Stack:** TypeScript (ESM NodeNext), vitest, better-sqlite3 in-memory tests, FakeGitOps + a real-git temp-repo test for git-ops, React/Zustand renderer (jsdom).

## Global Constraints

- **Node 22 required.** Before ANY command: `nvm use 22` (better-sqlite3 ABI 127).
- **ESM NodeNext:** relative imports MUST end in `.js`; type-only imports MUST use `import type`.
- **Code comments in English.** No DB schema changes (MIGRATIONS untouched).
- **Branch:** work directly on `feat/dockable-panes`.
- **Typecheck separately:** root `npm run typecheck`; desktop `npm -w apps/desktop run typecheck`.
- **Commit trailer:** end every commit message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Test commands:** root single file `npx vitest run test/<path>.test.ts`; desktop `npm -w apps/desktop test -- test/<file>.test.ts`.
- All paths relative to `/Users/clover/workspace/clovot`.

---

### Task 1: Fleet — spawn/fork hardening (#25 pre-try throw, fork pre-entry window, #32 fork-ref leak)

Three related gaps in `src/core/fleet-orchestrator.ts`:
(a) **#25**: `run()`'s first statements (`repos.createWorker` ~line 249, `setWorkerNotifyArmed`, the maxTurns/effort persists, and the `worker.spawned` emit) execute BEFORE the `try` — a throw there (FK on a concurrently-deleted session, SQLITE_FULL) skips the catch's `signalReady()`, so `spawn()`'s returned promise never settles and the awaiting master turn wedges; the rejected flow also escapes as an unhandledRejection.
(b) **fork window**: `fork()` creates the worktree+branch (`addWorktree` ~line 217) and only later runs `createWorker` — a throw in between (e.g. the home session cascaded away mid-fork) leaks the worktree+branch forever, exactly the class #12 closed for spawn().
(c) **#32**: `fork()` pins `refs/rookery/fork/<newId>` (a full-tree snapshot) in the source repo's shared .git; `removeCheckpointRefs` only cleans `refs/rookery/ckpt/<id>/`, so every fork leaks a permanently-pinned commit.

**Files:**
- Modify: `src/core/fleet-orchestrator.ts` (`run()` try-boundary; `fork()` failure cleanup)
- Modify: `src/core/git-ops.ts` (`removeCheckpointRefs` also deletes the exact ref `refs/rookery/fork/<workerId>` — both `RealGitOps` and `FakeGitOps`; check FakeGitOps's recording shape and mirror it)
- Test: `test/core/fleet-orchestrator.test.ts` (or tier1 — wherever spawn/fork paths live), `test/core/git-ops.test.ts` (real-git temp-repo section)

**Interfaces:**
- Produces: `removeCheckpointRefs(repoPath, workerId)` now also removes `refs/rookery/fork/${workerId}` (exact ref, best-effort). `spawn()` ALWAYS settles (a pre-provisioning throw resolves `{id}` with the row marked failed where possible). `fork()` cleans up its own worktree/branch/fork-ref on failure and rethrows.

- [ ] **Step 1: Write the failing tests**

(1) `#25` — in the fleet test file:

```ts
it("spawn settles even when createWorker throws (audit #25) — no wedged master turn, no unhandled rejection", async () => {
  const git = new FakeGitOps({ headValue: "base0", checkpointSha: "ck" });
  const factory = (): WorkerLike => ({ start: () => {}, send: () => {}, resume: () => {}, stop: async () => {}, status: () => "idle", waitUntilSettled: async () => {} });
  // repos WITHOUT the home session row → createWorker FK-throws (the audit's concurrent session-delete shape)
  const repos = new Repositories(openDb(":memory:"));
  const fleet = new FleetOrchestrator({ repos, bus: new EventBus(), git, factory, worktreesDir: "/wt", idgen: () => "a0" });
  await expect(fleet.spawn({ homeSessionId: "no-such-session", repoPath: "/code", label: "x", task: "t" })).resolves.toEqual({ id: "a0" });
  await fleet.waitAllSettled(); // the flow settled through the catch — drain must not hang or reject
});
```

(2) fork window + #32 — in the fleet test file (gate `addWorktree` so the session can be cascaded mid-fork; mirror the existing AddGatedGit pattern):

```ts
it("fork failure after addWorktree cleans up its worktree and fork ref (fork pre-entry window + audit #32)", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  class GatedGit extends FakeGitOps {
    async addWorktree(repo: string, wt: string, branch: string, base: string): Promise<void> {
      await gate;
      return super.addWorktree(repo, wt, branch, base);
    }
  }
  const git = new GatedGit({ headValue: "base0", checkpointSha: "ck" });
  // fixture: session sA + source worker a0 with sdk_session_id + existing worktree; forkSession stub; idgen returns "fk1" for the fork
  // ... (reuse the file's fork fixture if present; otherwise build like the maxTurns fork test)
  const forking = fleet.fork("a0");
  await new Promise((r) => setTimeout(r, 0)); // park inside the gated addWorktree
  repos.deleteSession("sA"); // cascades the rows → createWorker(newId) will FK-throw after the gate
  release();
  await expect(forking).rejects.toThrow();
  expect(git.calls.some((c) => c.startsWith("removeWorktree"))).toBe(true); // fork cleaned its own worktree+branch
  expect(git.calls.some((c) => c.startsWith("removeCheckpointRefs"))).toBe(true); // and its fork ref
});
```

(3) #32 real-git — in `test/core/git-ops.test.ts`'s temp-repo section:

```ts
it("removeCheckpointRefs also deletes the fork snapshot ref (audit #32)", async () => {
  // in the existing mkdtemp repo fixture: create a commit, then
  const sha = await git.checkpoint(repoDir, "refs/rookery/fork/w1");
  expect(sha).toBeTruthy();
  await git.removeCheckpointRefs(repoDir, "w1");
  const refs = await /* run `git for-each-ref refs/rookery` via the fixture's exec helper */;
  expect(refs).not.toContain("refs/rookery/fork/w1");
});
```

(Adapt to the file's fixture helpers for running git; the assertion is the contract.)

- [ ] **Step 2: Run to verify they fail**

#25: FAIL — the spawn promise never settles (use a per-test `{ timeout: 5000 }`). Fork: FAIL — no removeWorktree call. git-ops: FAIL — the ref survives.

- [ ] **Step 3: Implement**

(a) `git-ops.ts` `removeCheckpointRefs` (RealGitOps) — append after the existing loop:

```ts
    // A worker created by fork() also pinned a one-shot full-tree snapshot at refs/rookery/fork/<id> (its own id).
    // It lives in the same shared .git and was never cleaned — every fork leaked a permanently-pinned commit (audit #32).
    await this.git(repoPath, ["update-ref", "-d", `refs/rookery/fork/${workerId}`]).catch(() => {});
```

Mirror in `FakeGitOps.removeCheckpointRefs` per its existing recording style (it only records the call — verify and keep behavior).

(b) `run()` (#25) — move the pre-try block INSIDE the `try` (createWorker, notify-arm, maxTurns/effort persists, and the `worker.spawned` provisioning emit become the try's first statements; delete the now-empty region above it). The existing catch already does signalReady + failed bookkeeping in nested try/ignore blocks — a createWorker throw now flows there (its `setWorkerStatus`/`addWorkerEvent` attempts fail silently against the missing row; the `worker.status: failed` emit is harmless). Update the comment above `createWorker` to note the try placement is load-bearing for #25.

(c) `fork()` — wrap everything AFTER the `await this.deps.git.addWorktree(...)` line (the restoreCheckpoint block, createWorker, the setters, copyWorkerEvents, setWorkerStatus, entries.set, the emit) in:

```ts
    try {
      // ... existing statements unchanged ...
    } catch (err) {
      // The fork's worktree/branch/snapshot-ref were already created — reclaim them, or they leak with no row
      // to ever find them again (the same pre-entry class audit #12 closed for spawn()).
      try { await this.deps.git.removeWorktree(src.repo_path, worktreePath, branch); } catch { /* best-effort */ }
      try { await this.deps.git.removeCheckpointRefs(src.repo_path, newId); } catch { /* best-effort */ }
      throw err;
    }
```

- [ ] **Step 4: Run + typecheck + commit**

```bash
npx vitest run test/core/fleet-orchestrator.test.ts test/core/fleet-orchestrator-tier1.test.ts test/core/fleet-orchestrator-close.test.ts test/core/fleet-orchestrator-checkpoints.test.ts test/core/git-ops.test.ts && npm run typecheck
git add src/core/fleet-orchestrator.ts src/core/git-ops.ts test
git commit -m "fix(core): spawn always settles, fork cleans up on failure, fork snapshot refs reclaimed (audit #25, #32 + fork window)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Master — filter native nested-subagent traffic (#23)

The worker loop routes every `parent_tool_use_id`-carrying message away from its own state; the master loop has NO such filter, so when the master uses its native Task tool, the subagent's internal tool_use/tool_result/deltas are recorded as first-class `master.tool`/message events, PERSISTED to session_events, and each nested assistant message prematurely flushes the master's coalesced thinking.

**Files:**
- Modify: `src/core/master-agent.ts` (the `for await (const msg of q)` loop, ~line 313)
- Test: `test/core/master-agent.test.ts`

**Interfaces:**
- Consumes: the SDK message shape `{ parent_tool_use_id?: string | null }` (same field the worker reads).

- [ ] **Step 1: Write the failing test**

Check `test/helpers/fake-query.ts` first: if its script entries can't carry `parent_tool_use_id`/tool_use blocks, extend the helper minimally (script entries already map to SDK-ish messages — add pass-through of a `parent_tool_use_id` field and, if needed, reuse however existing tests script tool_use). Then:

```ts
it("nested Task-subagent traffic (parent_tool_use_id) is not recorded as the master's own activity (audit #23)", async () => {
  const events: CoreEvent[] = [];
  const base = deps(fakeQuery([
    { type: "assistant", text: "sub inner", parent_tool_use_id: "task-1" }, // nested subagent output
    { type: "assistant", text: "master says" },                              // the master's own message
    { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "s" },
  ]));
  base.bus.subscribe("s1", (e) => events.push(e));
  const master = new MasterAgent({ sessionId: "s1", cwd: "/x", sdkSessionId: null, deps: base });
  await master.runTurn("go");
  const texts = events.filter((e) => e.type === "master.message" && e.role === "assistant").map((e) => (e as { content: string }).content);
  expect(texts).toEqual(["master says"]); // the nested message was neither emitted nor persisted
  const persisted = base.repos.listSessionEvents("s1").filter((r) => r.type === "master.message" && r.payload_json.includes("sub inner"));
  expect(persisted).toEqual([]);
});
```

- [ ] **Step 2: RED** — the nested message appears in both lists.

- [ ] **Step 3: Implement**

In the master's stream loop, immediately after `const type = (msg as { type?: string }).type;` add:

```ts
        // Native nested-subagent traffic (the master's own Task tool) carries parent_tool_use_id. It is NOT the
        // master's own activity: recording it persisted the subagent's internal tool churn as first-class
        // master.tool/message events and prematurely flushed the coalesced thinking. The nested concept is
        // live-only and per-worker (the master has no nested panel) — skip entirely (parity with worker.ts).
        const parentId = (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null;
        if (parentId) continue;
```

- [ ] **Step 4: Run + typecheck + commit**

```bash
npx vitest run test/core/master-agent.test.ts && npm run typecheck
git add src/core/master-agent.ts test/core/master-agent.test.ts test/helpers/fake-query.ts
git commit -m "fix(core): master ignores nested Task-subagent traffic — no transcript pollution (audit #23)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Seed cumulative cost/turn counters from the persisted transcript (#22 master, #28 worker)

Both cumulative counters are in-memory only; after a daemon restart (or fork) the next result event records a LOWER "cumulative" total than the previous persisted one — permanently non-monotonic transcript metrics.

**Files:**
- Modify: `src/persistence/repositories.ts` (two read helpers)
- Modify: `src/core/master-agent.ts` (constructor seeds), `src/core/worker.ts` (`resume()` seeds)
- Test: `test/persistence/repositories.test.ts`, `test/core/master-agent.test.ts`, `test/core/worker.test.ts` (check the worker test file's name/fixtures first)

**Interfaces:**
- Produces: `Repositories.lastSessionEventPayload(sessionId: string, type: string): string | undefined` and `Repositories.lastWorkerEventPayload(workerId: string, type: string): string | undefined` (highest-seq row of that type).

- [ ] **Step 1: Failing repositories test**

```ts
it("lastSessionEventPayload / lastWorkerEventPayload return the highest-seq payload of the type", () => {
  const repos = new Repositories(openDb(":memory:"), () => "t");
  repos.createSession({ id: "s1", cwd: "/x" });
  repos.addSessionEvent({ sessionId: "s1", seq: 0, type: "master.result", payloadJson: '{"costUsd":1}' });
  repos.addSessionEvent({ sessionId: "s1", seq: 1, type: "master.message", payloadJson: '{"content":"x"}' });
  repos.addSessionEvent({ sessionId: "s1", seq: 2, type: "master.result", payloadJson: '{"costUsd":2}' });
  expect(repos.lastSessionEventPayload("s1", "master.result")).toBe('{"costUsd":2}');
  expect(repos.lastSessionEventPayload("s1", "nope")).toBeUndefined();
  repos.createWorker({ id: "w1", sessionId: "s1", repoPath: "/r", label: "w" });
  repos.addWorkerEvent({ workerId: "w1", seq: 0, type: "result", payloadJson: '{"costUsd":3}' });
  expect(repos.lastWorkerEventPayload("w1", "result")).toBe('{"costUsd":3}');
});
```

- [ ] **Step 2: RED → implement the helpers**

```ts
  // Latest persisted payload of an event type — seeds in-memory cumulative counters after a rebuild (audit #22/#28).
  lastSessionEventPayload(sessionId: string, type: string): string | undefined {
    const row = this.db.prepare("SELECT payload_json FROM session_events WHERE session_id = ? AND type = ? ORDER BY seq DESC LIMIT 1").get(sessionId, type) as { payload_json: string } | undefined;
    return row?.payload_json;
  }

  lastWorkerEventPayload(workerId: string, type: string): string | undefined {
    const row = this.db.prepare("SELECT payload_json FROM worker_events WHERE worker_id = ? AND type = ? ORDER BY seq DESC LIMIT 1").get(workerId, type) as { payload_json: string } | undefined;
    return row?.payload_json;
  }
```

(Verify the worker_events column is `worker_id` — grep the CREATE TABLE.)

- [ ] **Step 3: Failing behavior tests**

Master (in master-agent.test.ts — reuse `deps()`; run one turn to persist a result, then REBUILD a fresh MasterAgent over the same repos and run another turn):

```ts
it("cumulative cost/turns survive a rebuild — master.result totals stay monotonic (audit #22)", async () => {
  const base = deps(fakeQuery([{ type: "result", subtype: "success", total_cost_usd: 0.5, num_turns: 2, session_id: "s" }]));
  const m1 = new MasterAgent({ sessionId: "s1", cwd: "/x", sdkSessionId: null, deps: base });
  await m1.runTurn("a");
  const m2 = new MasterAgent({ sessionId: "s1", cwd: "/x", sdkSessionId: "s", deps: base }); // "restart" rebuild
  const events: CoreEvent[] = [];
  base.bus.subscribe("s1", (e) => events.push(e));
  await m2.runTurn("b");
  const results = events.filter((e) => e.type === "master.result") as Array<{ costUsd: number; numTurns: number }>;
  expect(results.at(-1)!.costUsd).toBeCloseTo(1.0); // 0.5 (seeded) + 0.5 (this turn) — not a reset to 0.5
  expect(results.at(-1)!.numTurns).toBe(4);
});
```

Worker (in the worker test file — spawn-free direct Worker construction per its fixtures): persist a result row via `repos.addWorkerEvent` (costUsd 1.2, numTurns 3), construct a Worker with that id, call `resume()`, drive one turn via `send()` + a fakeQuery result of total_cost_usd 0.1/num_turns 1, and assert the recorded result payload has costUsd≈1.3, numTurns 4. (Adapt to the file's streaming fixtures; the assertion is the contract.)

- [ ] **Step 4: Implement seeding**

MasterAgent constructor (after `this.sdkSessionId = opts.sdkSessionId;`):

```ts
    // Seed the session-cumulative counters from the last persisted result: they are documented as cumulative,
    // and starting from 0 after a rebuild (restart/fork copies the transcript) wrote non-monotonic totals (audit #22).
    try {
      const last = opts.deps.repos.lastSessionEventPayload(opts.sessionId, "master.result");
      if (last) {
        const p = JSON.parse(last) as { costUsd?: number; numTurns?: number };
        this.cumCostUsd = p.costUsd ?? 0;
        this.cumTurns = p.numTurns ?? 0;
      }
    } catch { /* corrupt row — start from 0 */ }
```

Worker `resume()` (after the `this.seq = ...` line, and update the cum-counters field comment at ~line 70 which claims "even after restart" — now true):

```ts
    // Seed the lifetime-cumulative counters from the last persisted result (audit #28) — resume() restores seq
    // but the counters started at 0, making the transcript's metrics rows non-monotonic after a restart.
    try {
      const last = this.opts.deps.repos.lastWorkerEventPayload(this.opts.id, "result");
      if (last) {
        const p = JSON.parse(last) as { costUsd?: number; numTurns?: number };
        this.cumCostUsd = p.costUsd ?? 0;
        this.cumTurns = p.numTurns ?? 0;
      }
    } catch { /* corrupt row — start from 0 */ }
```

- [ ] **Step 5: Run + typecheck + commit**

```bash
npx vitest run test/persistence test/core/master-agent.test.ts test/core/worker.test.ts && npm run typecheck
git add src/persistence/repositories.ts src/core/master-agent.ts src/core/worker.ts test
git commit -m "fix(core): cumulative cost/turn counters seed from the persisted transcript — monotonic after restart/fork (audit #22, #28)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Fleet — spawn-failure error event is also emitted live (#27)

`run()`'s provisioning catch persists the error to worker_events but never emits a `worker.event` — a client watching the provisioning worker sees the failed badge with an empty transcript (the reason only appears after a history refetch).

**Files:**
- Modify: `src/core/fleet-orchestrator.ts` (the `run()` catch's addWorkerEvent block)
- Test: `test/core/fleet-orchestrator.test.ts`

- [ ] **Step 1: Failing test**

```ts
it("a provisioning failure emits the error worker.event live, not just persists it (audit #27)", async () => {
  class FailingGit extends FakeGitOps {
    async addWorktree(): Promise<void> { throw new Error("worktree boom"); }
  }
  const git = new FailingGit({ headValue: "base0", checkpointSha: "ck" });
  // fixture: session sA, plain factory, idgen "a0" (reuse the file's setup)
  const events: Array<{ kind: string }> = [];
  bus.subscribe("@fleet", (e) => { if (e.type === "worker.event") events.push(e.data as { kind: string }); });
  await fleet.spawn({ homeSessionId: "sA", repoPath: "/code", label: "x", task: "t" });
  await fleet.waitAllSettled();
  expect(events.some((d) => d.kind === "error")).toBe(true);
});
```

- [ ] **Step 2: RED → implement**

Replace the catch's addWorkerEvent block:

```ts
      try {
        const seq = repos.nextWorkerSeq(id);
        const data = { kind: "error", message: String(err) };
        repos.addWorkerEvent({ workerId: id, seq, type: "error", payloadJson: JSON.stringify(data) });
        // Persist+emit as a pair (like Worker.record): without the emit, a client watching the provisioning
        // worker saw the failed badge over an empty transcript until a manual history refetch (audit #27).
        bus.emit({ type: "worker.event", sessionId: input.homeSessionId, workerId: id, seq, data });
      } catch { /* ignore */ }
```

(If Task 1 moved `createWorker` inside the try and the throw WAS createWorker, `nextWorkerSeq`/`addWorkerEvent` throw against the missing row — the surrounding try/ignore keeps that safe; the emit is skipped, which is correct since there is no worker to watch.)

- [ ] **Step 3: Run + typecheck + commit**

```bash
npx vitest run test/core/fleet-orchestrator.test.ts && npm run typecheck
git add src/core/fleet-orchestrator.ts test/core/fleet-orchestrator.test.ts
git commit -m "fix(core): provisioning-failure error events are emitted live, not only persisted (audit #27)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: WsClient — buffer during the CONNECTING window (#31)

`start()` assigns `this.sock` while the browser socket is still CONNECTING; `send()` then throws InvalidStateError and the frame is neither sent nor buffered (the DSK-1 outbox only buffers when `sock === null`). Recurs on every 1s reconnect attempt while the daemon is down.

**Files:**
- Modify: `apps/desktop/src/renderer/ws/client.ts` (`SocketLike` gains optional `readyState`; `send()` open-check + fallback buffering; `request()` open-check + send-guard)
- Test: the desktop ws-client test file (find it: `grep -rl "WsClient" apps/desktop/test/` — mirror its fake-socket fixture)

**Interfaces:**
- Produces: `SocketLike.readyState?: number` (browser WebSocket: 1 = OPEN; the test fake may omit it → treated as open, preserving all existing tests).

- [ ] **Step 1: Failing tests**

```ts
it("send during CONNECTING buffers to the outbox instead of throwing (audit #31)", () => {
  // fake socket with readyState: 0 (CONNECTING); onopen not yet fired
  // client.send({...}) → no throw, frame not delivered yet
  // then set readyState = 1 and fire onopen → the buffered frame is flushed
});

it("request during CONNECTING rejects fast instead of leaking a pending entry", async () => {
  // fake socket with readyState: 0 → await expect(client.request({...})).rejects.toThrow(/not connected/);
});
```

(Write them against the file's real fixture shapes; the contracts above are binding.)

- [ ] **Step 2: RED → implement**

`SocketLike`:

```ts
  readyState?: number; // browser WebSocket readyState (1 = OPEN). The test fake may omit it → treated as open.
```

`send()`:

```ts
  send(msg: ClientMessage): void {
    const data = JSON.stringify(msg);
    // OPEN check: a socket in CONNECTING (every 1s reconnect attempt while the daemon is down) throws
    // InvalidStateError from send() — the frame was neither sent nor buffered, defeating the DSK-1 outbox.
    const open = this.sock !== null && (this.sock.readyState === undefined || this.sock.readyState === 1);
    if (open) {
      try { this.sock!.send(data); return; } catch { /* fall through to the outbox */ }
    }
    if (!this.stopped && this.outbox.length < WsClient.OUTBOX_MAX) this.outbox.push(data);
  }
```

`request()` — same open check replacing the `!this.sock` fast-reject, and guard the send so a throw can't leak the pending entry:

```ts
    const open = this.sock !== null && (this.sock.readyState === undefined || this.sock.readyState === 1);
    if (!open) return Promise.reject(new Error("not connected"));
    const reqId = `q${this.seq++}`;
    return new Promise<RequestResultMap[K]>((resolve, reject) => {
      this.pending.set(reqId, { resolve: resolve as (m: ServerMessage) => void, reject });
      try {
        this.sock!.send(JSON.stringify({ ...msg, reqId }));
      } catch (e) {
        this.pending.delete(reqId);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
```

- [ ] **Step 3: Run + typecheck + commit**

```bash
npm -w apps/desktop test && npm -w apps/desktop run typecheck
git add apps/desktop/src/renderer/ws/client.ts apps/desktop/test
git commit -m "fix(desktop): sends during the WebSocket CONNECTING window buffer instead of throwing (audit #31)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Dock layout persistence polish (#33 debounce flush, #34 clear-on-confirm)

(#33) `WorkspaceDock`'s unmount cleanup cancels the 400ms debounced layout save without flushing — the last layout change before a page switch/reload is lost. (#34) `deleteSession`/`deleteSub` clear the saved layout BEFORE the daemon confirms — a failed delete restores the row but the layout is gone.

**Files:**
- Modify: `apps/desktop/src/renderer/workspace/WorkspaceDock.tsx` (the effect cleanup, ~line 122)
- Modify: `apps/desktop/src/renderer/App.tsx` (`deleteSession` ~line 484 and `deleteSub` ~line 495: move `useLayoutStore.getState().clear_(id)` into the request's `.then`)
- Test: jsdom cannot drive dockview — this task is verified by typecheck + the full desktop suite staying green; note the residual visual check in your report (page-switch within 400ms of a layout change now persists).

- [ ] **Step 1: Implement #33**

In the effect cleanup, replace the `if (saveTimer.current) clearTimeout(saveTimer.current);` line:

```ts
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        // Flush instead of dropping (audit #33): a layout change within the 400ms debounce of a page switch,
        // reload, or quit was silently lost and the page reverted to its previous saved arrangement.
        const api = apiRef.current;
        if (api) { try { useLayoutStore.getState().save_(pageKey, api.toJSON()); } catch { /* dockview mid-teardown — keep the last saved layout */ } }
      }
```

- [ ] **Step 2: Implement #34**

`deleteSession`: remove the eager `useLayoutStore.getState().clear_(id);` line and fold it into the success path:

```ts
    void client?.request({ type: "session.delete", sessionId: id }).then(() => {
      useLayoutStore.getState().clear_(id); // only after the daemon confirms (audit #34) — a failed delete restores the row AND keeps its layout
      refetchSessions();
    }).catch((e) => { toast.error(tRef.current("toast.deleteFailed"), String(e)); refetchSessions(); });
```

`deleteSub`: same shape with `worker.delete` + `refetchFleet()`.

- [ ] **Step 3: Run + typecheck + commit**

```bash
npm -w apps/desktop test && npm -w apps/desktop run typecheck
git add apps/desktop/src/renderer/workspace/WorkspaceDock.tsx apps/desktop/src/renderer/App.tsx
git commit -m "fix(desktop): flush the debounced dock-layout save on unmount; clear layouts only after a confirmed delete (audit #33, #34)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Daemon quick-wins (#30 live API-key resolver, #29 lock-takeover race)

(#30) `makeModelsProvider({ apiKey: settings.anthropicApiKey() })` snapshots the key at boot — a key saved in Settings doesn't reach the model picker until a restart (the exact resolver-vs-snapshot antipattern the repo warns about). (#29) `acquireSingleInstance`'s stale takeover does a blind `rmSync` between reading a dead pid and re-writing — it can delete a COMPETITOR's freshly-written live lock, letting two daemons pass the gate.

**Files:**
- Modify: `src/core/models-provider.ts` (`apiKey` accepts a resolver), `src/daemon/server.ts` (pass `() => settings.anthropicApiKey()`)
- Modify: `src/daemon/lifecycle.ts` (rename-aside takeover with a captured-content re-check)
- Test: `test/core/models-provider.test.ts`, `test/daemon/lifecycle.test.ts`

- [ ] **Step 1: Failing models-provider test**

```ts
it("re-resolves the api key on every call (audit #30) — a key saved after boot reaches the picker without a restart", async () => {
  let key: string | undefined;
  const seen: string[] = [];
  const fetchImpl = (async (_url: string, init: { headers: Record<string, string> }) => {
    seen.push(init.headers["x-api-key"] ?? "none");
    return { ok: true, json: async () => ({ data: [{ id: "m1", display_name: "M1" }] }) };
  }) as never;
  const reader = { read: async () => null }; // no OAuth either
  const list = makeModelsProvider({ apiKey: () => key, reader, fetchImpl });
  expect(await list()).toEqual(STATIC_MODELS); // no key yet → static fallback, no fetch with a key
  key = "sk-new";
  expect((await list())[0]!.id).toBe("m1"); // the just-saved key is used live
  expect(seen).toEqual(["sk-new"]);
});
```

- [ ] **Step 2: RED → implement #30**

`models-provider.ts`:

```ts
export function makeModelsProvider(opts: { reader?: TokenReader; apiKey?: string | (() => string | undefined); fetchImpl?: FetchLike } = {}): () => Promise<ModelInfo[]> {
  const reader = opts.reader ?? defaultTokenReader();
  return async () => {
    try {
      // Resolve per call (audit #30): a boot-time snapshot meant a key saved in Settings never reached the
      // model picker until a daemon restart (and a rotated key kept 401ing into the static fallback).
      const apiKey = typeof opts.apiKey === "function" ? opts.apiKey() : opts.apiKey;
      let headers: Record<string, string>;
      if (apiKey) {
        headers = { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION };
      } else {
        // ... (existing OAuth branch unchanged)
```

`server.ts`: `const modelsList = makeModelsProvider({ apiKey: () => settings.anthropicApiKey() });`

- [ ] **Step 3: Failing lifecycle test + implement #29**

Tests (in `test/daemon/lifecycle.test.ts`, mirroring its tmp-dir fixtures):

```ts
it("stale takeover leaves no residue and acquires cleanly (audit #29)", () => {
  fs.writeFileSync(pidPath, "999999999"); // dead pid
  const lock = acquireSingleInstance(pidPath);
  expect(fs.readFileSync(pidPath, "utf8")).toBe(String(process.pid));
  expect(fs.readdirSync(path.dirname(pidPath)).filter((f) => f.includes(".stale"))).toEqual([]);
  lock.release();
});

it("a live competitor lock captured during takeover is restored and reported (audit #29)", () => {
  // exercise the re-check branch directly: the captured file contains a DIFFERENT, LIVE pid
  fs.writeFileSync(pidPath, String(process.pid)); // "competitor" = us (alive), read as `existing` won't match — simulate by...
  // (adapt: the deterministic way is to assert the existing live-lock rejection still throws `already running`,
  //  and unit-test the restore branch by seeding pidPath with a live pid ≠ the one first read — if the file's
  //  fixture can't interleave, keep the first test + the pre-existing live-lock test as the coverage and note it)
});
```

Implementation — replace the `fs.rmSync(pidPath)` takeover block in `acquireSingleInstance`:

```ts
      try {
        // Race-safe takeover (audit #29): a blind rm could delete a COMPETITOR's freshly-written live lock
        // (our read of the dead pid may predate their write). rename() is atomic — exactly one contender
        // captures the file; the content then proves what was captured.
        const stale = `${pidPath}.stale-${process.pid}`;
        fs.renameSync(pidPath, stale);
        let captured = NaN;
        try { captured = Number.parseInt(fs.readFileSync(stale, "utf8").trim(), 10); } catch { /* unreadable → stale */ }
        if (Number.isInteger(captured) && captured !== existing && isProcessAlive(captured)) {
          // We swept up a live competitor's lock — put it back and concede.
          try { fs.renameSync(stale, pidPath); } catch { /* they re-acquired already — fine */ }
          throw new Error(`rookery daemon already running (pid ${captured})`);
        }
        fs.rmSync(stale, { force: true }); // confirmed stale — discard and retry wx in the next loop
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("rookery daemon already running")) throw e;
        /* rename lost the race (competitor took the file first) → retry wx */
      }
```

- [ ] **Step 4: Run + typecheck + commit**

```bash
npx vitest run test/core/models-provider.test.ts test/daemon/lifecycle.test.ts test/daemon/server.test.ts && npm run typecheck
git add src/core/models-provider.ts src/daemon/server.ts src/daemon/lifecycle.ts test
git commit -m "fix(daemon): live api-key resolver for the model picker; race-safe stale-lock takeover (audit #30, #29)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Full verification sweep + audit status update

**Files:** Modify: `docs/2026-07-03-agent-loop-audit.md`

- [ ] **Step 1:** `npm test && npm run typecheck` — ALL PASS.
- [ ] **Step 2:** `npm -w apps/desktop test && npm -w apps/desktop run typecheck` — ALL PASS.
- [ ] **Step 3:** `npm run build` — exit 0.
- [ ] **Step 4:** Extend the status blockquote in `docs/2026-07-03-agent-loop-audit.md`:

```
> Low wave: #22, #23, #25, #27, #28, #29, #30, #31, #32, #33, #34 fixed, plus the fork() pre-entry window — see docs/superpowers/plans/2026-07-03-audit-low-wave.md. All confirmed audit findings are now closed except cosmetic notes (answered-elsewhere expired label; Slack card buttons on dispose).
```

- [ ] **Step 5:**

```bash
git add docs/2026-07-03-agent-loop-audit.md
git commit -m "docs: mark audit low wave done — all confirmed findings closed

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
