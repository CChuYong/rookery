# Audit Medium Wave (#10, #12, #13, #15, #16, #17, #19, #20) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the eight remaining MEDIUM findings from the 2026-07-03 agent-loop audit (`docs/2026-07-03-agent-loop-audit.md`).

**Architecture:** Eight independent surgical fixes: reqId echo on schema failures (#13), fresh+concurrent Slack trigger dispatch (#16), claim-then-delete for once-wakeups (#15), consistent `error` terminal status (#10), cooperative cancel for provisioning spawns (#12), buffered early events in the worker Slack relay (#19), epoch-based pendingBySession reconciliation (#17), and two-way dock active-panel sync (#20). One task per fix, each with its own tests and commit.

**Tech Stack:** TypeScript (ESM NodeNext), vitest, better-sqlite3 in-memory tests, FakeGitOps, React/Zustand + dockview renderer (jsdom vitest in `apps/desktop`).

## Global Constraints

- **Node 22 required.** Before ANY command: `nvm use 22` (better-sqlite3 ABI 127).
- **ESM NodeNext:** relative imports MUST end in `.js`; type-only imports MUST use `import type`.
- **Code comments in English.**
- **No DB schema changes** in this wave — do NOT touch the `MIGRATIONS` array.
- **Branch:** work directly on `feat/dockable-panes`.
- **Typecheck separately:** root `npm run typecheck`; desktop `npm -w apps/desktop run typecheck`. vitest does not typecheck.
- **Renderer i18n invariant:** any new renderer string goes into BOTH ko and en catalogs (parity + used-keys tests enforce).
- **Docs follow code:** AGENTS.md (CLAUDE.md is a symlink to it) and `docs/architecture/*.md` statements changed by a task are updated IN that task's commit.
- **Commit trailer:** end every commit message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Test commands:** root single file `npx vitest run test/<path>.test.ts`; desktop `npm -w apps/desktop test -- test/<file>.test.ts`.
- All paths relative to `/Users/clover/workspace/clovot`.

---

### Task 1: Daemon — schema-failure replies echo the reqId (audit #13, MEDIUM)

`Connection.handleRaw` replies to zod parse failures with `{type:"error", message}` and NO reqId (the message object never existed), so a `request()`-style client hangs forever. Reachable from the Automation form: `automationInputSchema.superRefine` rejects an invalid cron AT PARSE TIME while the form only pre-checks the field count.

**Files:**
- Modify: `src/daemon/connection.ts` (the `parseClientMessage` catch at the top of `handleRaw`, ~line 117-123)
- Modify: `apps/desktop/src/renderer/components/AutomationForm.tsx` and/or its save call site (`AutomationPage.tsx`/`AutomationModal.tsx` — find where `automation.create`/`automation.update` requests are awaited) — ensure the now-possible rejection is surfaced (existing toast pattern), not unhandled
- Test: `test/daemon/connection.test.ts`

**Interfaces:**
- Produces: on parse failure, the error reply carries `reqId` when the raw frame contained a string `reqId` (best-effort JSON re-parse). No schema/protocol change.

- [ ] **Step 1: Write the failing test**

Add to `test/daemon/connection.test.ts` (reuse its `makeConn`-style fixture; `sent` holds parsed reply objects — adapt names):

```ts
it("a schema-invalid frame with a reqId gets an error reply carrying that reqId (no hung request)", async () => {
  await conn.handleRaw(JSON.stringify({ type: "automation.create", reqId: "q9", automation: { name: "n", trigger: { kind: "cron", cron: "61 3 * * *" }, action: { kind: "master", prompt: "p", cwd: "/w", sessionMode: "reuse" }, enabled: true } }));
  const errs = sent.filter((m) => m.type === "error");
  expect(errs.length).toBeGreaterThan(0);
  expect(errs[0]).toMatchObject({ reqId: "q9" });
});
```

(If the invalid-cron shape doesn't throw at parse in this fixture, use a plainly invalid frame instead: `{"type":"no-such-type","reqId":"q9"}` — anything `parseClientMessage` rejects.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/daemon/connection.test.ts -t "schema-invalid frame"`
Expected: FAIL — the error reply has no `reqId`.

- [ ] **Step 3: Implement**

In `src/daemon/connection.ts`, replace the parse catch:

```ts
    let msg;
    try {
      msg = parseClientMessage(raw);
    } catch (err) {
      // Best-effort reqId echo: the frame failed schema validation so `msg` never existed, but if the raw JSON
      // carried a reqId the client has a pending request() that would otherwise hang forever (the desktop's
      // WsClient drops error frames without a reqId). Reachable via e.g. an invalid cron in automation.create.
      let reqId: string | undefined;
      try { const j = JSON.parse(raw) as { reqId?: unknown }; if (typeof j.reqId === "string") reqId = j.reqId; } catch { /* not JSON at all */ }
      this.reply({ type: "error", message: `invalid message: ${String(err)}`, ...(reqId ? { reqId } : {}) });
      return;
    }
```

- [ ] **Step 4: Surface the rejection in the Automation form**

Find the `automation.create`/`automation.update` request call (grep `automation.create` under `apps/desktop/src/renderer`). If the awaiting code lacks a `.catch`/try-catch that shows the error, add the file's existing toast pattern (e.g. `catch (e) { toast.error(t("toast.saveFailed"), String(e)); }` — `toast.saveFailed` already exists in both catalogs; match how sibling handlers in the same file surface errors, including keeping any "saving" state reset in a finally). If it already catches and surfaces, leave it and note that in your report.

- [ ] **Step 5: Run tests + typechecks + commit**

```bash
npx vitest run test/daemon/connection.test.ts && npm run typecheck
npm -w apps/desktop test && npm -w apps/desktop run typecheck
git add src/daemon/connection.ts test/daemon/connection.test.ts apps/desktop/src/renderer
git commit -m "fix(daemon): schema-failure replies echo the reqId so client requests don't hang (audit #13)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Slack triggers — fresh re-read + concurrent dispatch (audit #16, MEDIUM)

`makeSlackTriggerHandler` snapshots `listAutomations()` once and serially AWAITS each matching rule's full run (minutes for a master action). A rule disabled/edited/deleted during an earlier rule's run still fires later from the stale snapshot, and later rules are needlessly delayed.

**Files:**
- Modify: `src/slack/trigger-source.ts` (whole file — it is 15 lines)
- Test: `test/slack/trigger-source.test.ts`

**Interfaces:**
- Produces: `SlackTriggerDeps.repos` widens to `Pick<Repositories, "listAutomations" | "getAutomation">`. All matching rules dispatch CONCURRENTLY, each after a fresh `getAutomation` re-check (enabled + kind + match). The handler still resolves only after all runs settle (Bolt already acked; run errors are logged, never thrown).
- Consumes: `matchesSlack` (pure), `AutomationDispatcher.run` (event triggers allow concurrent runs by design).

- [ ] **Step 1: Write the failing tests**

Add to `test/slack/trigger-source.test.ts` (mirror its existing fake repos/dispatcher fixtures):

```ts
it("matching rules dispatch concurrently — a later rule is not delayed behind an earlier rule's full run", async () => {
  let releaseA!: () => void;
  const gateA = new Promise<void>((r) => { releaseA = r; });
  const started: string[] = [];
  const dispatcher = { run: async (a: { id: string }) => { started.push(a.id); if (a.id === "a") await gateA; } };
  const rules = [mkRule("a"), mkRule("b")]; // both enabled slack rules matching the message (use the file's rule builder)
  const repos = { listAutomations: () => rules, getAutomation: (id: string) => rules.find((r) => r.id === id) };
  const handle = makeSlackTriggerHandler({ repos, dispatcher } as never);
  const p = handle({ channel: "C1", text: "hello" });
  await Promise.resolve(); await Promise.resolve();
  expect(started).toEqual(["a", "b"]); // b started while a is still gated
  releaseA();
  await p;
});

it("a rule disabled after the snapshot does not fire (fresh re-read at dispatch)", async () => {
  const ran: string[] = [];
  const dispatcher = { run: async (a: { id: string }) => { ran.push(a.id); } };
  const rule = mkRule("a");
  const repos = { listAutomations: () => [rule], getAutomation: () => ({ ...rule, enabled: false }) };
  await makeSlackTriggerHandler({ repos, dispatcher } as never)({ channel: "C1", text: "hello" });
  expect(ran).toEqual([]);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/slack/trigger-source.test.ts -t "concurrently"`
Expected: FAIL — `started` is `["a"]` (b blocked behind a's gate).

- [ ] **Step 3: Implement**

Replace `src/slack/trigger-source.ts`:

```ts
import type { Repositories } from "../persistence/repositories.js";
import type { AutomationDispatcher } from "../core/automation-dispatcher.js";
import { matchesSlack } from "../core/automation-match.js";

export interface SlackTriggerDeps { repos: Pick<Repositories, "listAutomations" | "getAutomation">; dispatcher: AutomationDispatcher }

export function makeSlackTriggerHandler(d: SlackTriggerDeps) {
  return async (e: { channel: string; userId?: string; text: string; ts?: string; threadTs?: string; team?: string }): Promise<void> => {
    const vars = { message: e.text, channel: e.channel, user: e.userId, ts: e.ts, threadTs: e.threadTs, team: e.team };
    const fired: Array<Promise<void>> = [];
    for (const a of d.repos.listAutomations()) {
      if (!a.enabled || a.trigger.kind !== "slack") continue;
      if (!matchesSlack(a.trigger, e)) continue;
      // Fresh re-read at dispatch time (parity with the Scheduler's fireCron): a rule deleted/disabled/edited
      // since the snapshot must not fire, and an edited rule fires with its CURRENT config.
      const fresh = d.repos.getAutomation(a.id);
      if (!fresh || !fresh.enabled || fresh.trigger.kind !== "slack" || !matchesSlack(fresh.trigger, e)) continue;
      // Event triggers allow concurrent runs by design — fire all matches NOW instead of serially awaiting each
      // full agentic turn (which delayed later rules by minutes and made the snapshot stale by the time they ran).
      fired.push(d.dispatcher.run(fresh, vars).catch((err) => { process.stderr.write(`[rookery] slack trigger run failed: ${String(err)}\n`); }));
    }
    await Promise.all(fired);
  };
}
```

- [ ] **Step 4: Fix the wiring type + run tests + commit**

`src/daemon/server.ts` passes the full `repos` — no change needed (grep `makeSlackTriggerHandler` to confirm).

```bash
npx vitest run test/slack/trigger-source.test.ts test/core/automation-dispatcher.test.ts && npm run typecheck
git add src/slack/trigger-source.ts test/slack/trigger-source.test.ts
git commit -m "fix(slack): trigger rules fire concurrently on a fresh re-read — no stale-snapshot firing (audit #16)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Scheduler — once-wakeups claim-then-delete (audit #15, MEDIUM)

`fireOnce` DELETES the row before dispatching; a crash/restart during the (minutes-long) run silently loses the wakeup — no row for boot recovery, no error trace. Fix: CLAIM by nulling `next_run_at` (tick skips null), delete only after the run settles. A crash mid-run leaves the row; boot's `start()` reconciles `enabled && !nextRunAt` once-rows back to `runAt` → the wakeup refires (at-least-once instead of at-most-zero).

**Files:**
- Modify: `src/core/scheduler.ts` (`fireOnce`, ~line 81-85)
- Modify: `AGENTS.md` (the line "(For `once`, the Scheduler deletes before firing to prevent double-firing — no dispatcher guard needed.)") and `docs/architecture/automation.md` (grep `delete` + `once`)
- Test: `test/core/scheduler.test.ts`

**Interfaces:**
- Consumes: existing `repos.setAutomationNextRun(id, null)`, `repos.deleteAutomation(id)`, `Scheduler.start()`'s existing reconcile of `enabled && !nextRunAt` once-rows.

- [ ] **Step 1: Write the failing tests**

Add to `test/core/scheduler.test.ts` (mirror its fixture: injected `now()`, manual `tick` via the injected `schedule`, fake/real repos — the file uses real in-memory repos):

```ts
it("once: claims (next_run=null) before firing and deletes only after the run settles — a crash mid-run can refire on boot", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const runs: string[] = [];
  const dispatcher = { run: async (a: { id: string }) => { runs.push(a.id); await gate; } };
  // build scheduler over real repos with one enabled once-automation whose runAt is in the past (overdue)
  // ... (use the file's existing once-automation creation helper/pattern)
  tick(); // fires fireOnce
  await Promise.resolve();
  expect(runs).toEqual(["a1"]);
  expect(repos.getAutomation("a1")).toBeDefined(); // row survives while the run is in flight (crash-safe)
  expect(repos.getAutomation("a1")!.nextRunAt).toBeNull(); // claimed — the next tick cannot double-fire
  tick(); // second tick during the run
  await Promise.resolve();
  expect(runs).toEqual(["a1"]); // no double fire
  release();
  await scheduler-idle-or-flush(); // however the file awaits fired promises (e.g. await vi.waitFor / flush helper)
  expect(repos.getAutomation("a1")).toBeUndefined(); // deleted after settle
});

it("once: a row left claimed by a crash is re-armed by start() and refires", () => {
  // create enabled once row, then simulate the crash state: setAutomationNextRun(id, null)
  // new Scheduler(...).start() → reconcile re-arms nextRunAt to trigger.runAt
  expect(repos.getAutomation("a1")!.nextRunAt).toBe(runAtIso);
});
```

(Adapt the pseudocode lines — `tick()`, the once-automation builder, and how the file flushes `void`-fired promises — to the file's real helpers; the assertions are the contract.)

- [ ] **Step 2: Run to verify the first fails**

Run: `npx vitest run test/core/scheduler.test.ts -t "claims"`
Expected: FAIL — the row is already deleted while the run is in flight.

- [ ] **Step 3: Implement**

Replace `fireOnce` in `src/core/scheduler.ts`:

```ts
  // Once (self-wakeup): CLAIM first (null next_run) instead of delete-before-fire. The null claim keeps the
  // 30s tick from double-firing while the run is in flight (tick skips rows without next_run_at), and the row
  // surviving the run means a daemon crash mid-run is recoverable: boot's start() re-arms enabled once-rows
  // with no next_run_at back to trigger.runAt, so the wakeup refires (at-least-once) instead of vanishing.
  // Delete only after the run settles (success or error — the wakeup fired either way).
  private async fireOnce(a: Automation): Promise<void> {
    if (a.trigger.kind !== "once") return;
    this.d.repos.setAutomationNextRun(a.id, null);
    try {
      await this.d.dispatcher.run(a, {});
    } finally {
      this.d.repos.deleteAutomation(a.id);
    }
  }
```

- [ ] **Step 4: Update the docs**

- `AGENTS.md`: replace the parenthetical "(For `once`, the Scheduler deletes before firing to prevent double-firing — no dispatcher guard needed.)" with "(For `once`, the Scheduler claims by nulling `next_run_at` before firing — the tick skips claimed rows — and deletes after the run settles; a crash mid-run is re-armed at boot and refires, at-least-once.)"
- `docs/architecture/automation.md`: update the matching sentence about once delete-before-fire the same way.

- [ ] **Step 5: Run tests + typecheck + commit**

```bash
npx vitest run test/core/scheduler.test.ts test/core/automation-dispatcher.test.ts && npm run typecheck
git add src/core/scheduler.ts test/core/scheduler.test.ts AGENTS.md docs/architecture/automation.md
git commit -m "fix(core): once-wakeups claim-then-delete — a restart mid-fire refires instead of silently losing the wakeup (audit #15)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Fleet — a worker runtime error stays `error` everywhere (audit #10, MEDIUM)

`Worker.transition("error")` writes DB `error` (terminal, write-once). The orchestrator's settle mapping then calls `setStatus(id, "failed")`: the DB write is silently dropped by the terminal guard, but the in-memory entry and the live `worker.status` event say `failed` — permanent DB vs memory/event divergence (fleet.list says error, get_worker_status says failed, the badge flips after reload). Fix: STOP remapping — `error` is the terminal status for a worker runtime error; `failed` remains only for orchestrator-level provisioning failures (run()'s catch).

**Files:**
- Modify: `src/core/fleet-orchestrator.ts` (`trackFlow` ~line 100-101 and `run()`'s settle ~line 299-300: drop the `s === "error" ? "failed" : s` mapping; update the `status()` doc comment mentioning error→failed)
- Modify: `docs/architecture/fleet-lifecycle.md` (the documented failed mapping, ~line 32)
- Test: the fleet test that asserts the error→failed mapping (grep `"failed"` in `test/core/fleet-orchestrator*.test.ts`) — update it to assert consistency instead

**Interfaces:**
- Produces: after a worker runtime error, DB row status, in-memory `fleet.status(id)`, and the emitted `worker.status` all say `"error"`. `"failed"` now exclusively means "provisioning/spawn failed". (Desktop already renders both identically — `RepoTree.tsx:97` checks `error || failed`; `WorkerNotifier.SETTLED` contains both.)

- [ ] **Step 1: Update/write the test**

Find the existing test asserting error→failed (grep). Rewrite it (or add if absent) in the main fleet test file:

```ts
it("a worker runtime error settles as 'error' everywhere — DB, orchestrator status, and the emitted event agree (audit #10)", async () => {
  const events: string[] = [];
  bus.subscribe("@fleet", (e) => { if (e.type === "worker.status") events.push(e.status); });
  // factory whose worker: status() returns "error" after settle; waitUntilSettled resolves immediately;
  // AND writes the DB the way the real Worker.transition does before settling:
  const factory = (o: { id: string }): WorkerLike => ({
    start: () => { repos.setWorkerStatus(o.id, "error"); }, // the real Worker writes terminal 'error' itself
    send: () => {}, resume: () => {}, stop: async () => {},
    status: () => "error",
    waitUntilSettled: async () => {},
  });
  const { id } = await fleet.spawn({ homeSessionId: "sA", repoPath: "/code", label: "x", task: "t" });
  await fleet.waitAllSettled();
  expect(repos.getWorker(id)!.status).toBe("error");
  expect(fleet.status(id)).toBe("error");
  expect(events).not.toContain("failed"); // no phantom 'failed' emitted for a runtime error
});
```

(Adapt fixture names — `build`/`repos`/`bus` — to the file's helpers.)

- [ ] **Step 2: Run to verify it fails**

Run the file with `-t "audit #10"`.
Expected: FAIL — `fleet.status(id)` is `"failed"` and/or events contain `"failed"`.

- [ ] **Step 3: Implement**

In `src/core/fleet-orchestrator.ts`:

`trackFlow` (drop the remap):

```ts
      .then(() => {
        // Settle as the worker's own terminal status. A runtime error stays 'error' — remapping to 'failed'
        // diverged from the DB (the Worker already wrote terminal 'error'; the write-once guard dropped the
        // remap write while the entry/event said 'failed'). 'failed' is reserved for provisioning failures.
        this.setStatus(id, agent.status());
      })
```

`run()`'s settle (same change):

```ts
      await agent.waitUntilSettled();
      this.setStatus(id, agent.status());
```

Update `status()`'s doc comment: replace the "(error→failed, orphaned, etc.)" wording with "(orphaned, provisioning-'failed', etc.)".

- [ ] **Step 4: Update the doc**

`docs/architecture/fleet-lifecycle.md`: change the error→failed mapping sentence (~line 32) to state that a worker runtime error settles as `error` (consistent across DB/memory/events) and `failed` is emitted only for provisioning/spawn failures.

- [ ] **Step 5: Run the fleet suites + typecheck + commit**

```bash
npx vitest run test/core/fleet-orchestrator.test.ts test/core/fleet-orchestrator-tier1.test.ts test/core/fleet-orchestrator-close.test.ts test/core/fleet-orchestrator-checkpoints.test.ts test/core/worker-notifier.test.ts && npm run typecheck
git add src/core/fleet-orchestrator.ts test docs/architecture/fleet-lifecycle.md
git commit -m "fix(core): worker runtime errors settle as 'error' everywhere — no DB/memory/event status divergence (audit #10)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Fleet — deleting a provisioning worker cancels the spawn cleanly (audit #12, MEDIUM)

A worker is visible as `provisioning` before `git worktree add` finishes, but the entries map has no entry until after the worktree+factory succeed. `worker.delete` in that window: `discard → require(id)` throws → `delete()` swallows it and removes the DB row → the still-running `run()` then creates the worktree, re-inserts a ghost entry, and `agent.start()` FK-throws — the worktree+branch leak forever (no row → rehydrate never sees them).

**Files:**
- Modify: `src/core/fleet-orchestrator.ts` (per-id flow map + cancelled set; cancel checks in `run()`; await-then-settle in `discard()`)
- Test: `test/core/fleet-orchestrator.test.ts` (or tier1 — wherever spawn-failure paths live)

**Interfaces:**
- Produces: `discard(id)`/`delete(id)` during provisioning: mark cancelled → await the in-flight spawn flow → the flow removes the just-created worktree itself and never registers an entry/agent → discard returns cleanly; delete then removes the row. Fields: `private readonly flowById = new Map<string, Promise<void>>();`, `private readonly cancelledSpawns = new Set<string>();`.

- [ ] **Step 1: Write the failing test**

```ts
it("delete during provisioning cancels the spawn: no worktree leak, no ghost entry, row removed (audit #12)", async () => {
  let releaseAdd!: () => void;
  const addGate = new Promise<void>((r) => { releaseAdd = r; });
  class AddGatedGit extends FakeGitOps {
    async addWorktree(repo: string, wt: string, branch: string, base: string): Promise<void> {
      await addGate;
      return super.addWorktree(repo, wt, branch, base);
    }
  }
  const git = new AddGatedGit({ headValue: "base0", checkpointSha: "ck" });
  let factoryCalls = 0;
  const factory = (): WorkerLike => { factoryCalls++; return { start: () => {}, send: () => {}, resume: () => {}, stop: async () => {}, status: () => "idle", waitUntilSettled: async () => {} }; };
  const { repos, fleet } = build(git, factory); // the file's builder (session "sA", idgen "a0")
  const spawnP = fleet.spawn({ homeSessionId: "sA", repoPath: "/code", label: "x", task: "t" });
  await Promise.resolve(); // run() parks inside the gated addWorktree; row exists as provisioning
  const deleteP = fleet.delete("a0"); // user deletes the provisioning worker
  releaseAdd();
  await deleteP;
  await spawnP.catch(() => {}); // spawn's ready promise must settle either way
  await fleet.waitAllSettled();
  expect(factoryCalls).toBe(0); // the agent never started (no ghost, no FK write)
  expect(repos.getWorker("a0")).toBeUndefined(); // row removed by delete()
  expect(fleet.status("a0")).toBe("unknown"); // no ghost entry in the map
  // the worktree created mid-cancel was removed by the bailing flow:
  expect(git.calls.some((c) => c[0] === "removeWorktree")).toBe(true); // adapt to FakeGitOps's call-recording shape
});
```

(Check `FakeGitOps`'s recorded-calls shape in `src/core/git-ops.ts` and adapt the last assertion; if it records differently — e.g. named arrays — assert accordingly.)

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL — today `fleet.delete` swallows `Unknown worker`, removes the row, then the resumed run() re-adds a ghost entry (`fleet.status("a0")` is `"failed"`) and `removeWorktree` is never called.

- [ ] **Step 3: Implement**

In `src/core/fleet-orchestrator.ts`:

(a) Fields (next to `flows`):

```ts
  // Per-id handle on the in-flight spawn flow + cooperative-cancel marks. discard/delete during provisioning
  // set the mark and AWAIT the flow: run() checks the mark after each await and bails — removing the worktree
  // it just created and never registering an entry/agent — so nothing leaks and no ghost survives (audit #12).
  private readonly flowById = new Map<string, Promise<void>>();
  private readonly cancelledSpawns = new Set<string>();
```

(b) `spawn()` — register/unregister the per-id flow:

```ts
    const flow = this.run(id, input, branch, worktreePath, signalReady);
    this.flows.add(flow); // synchronous registration — so shutdown drain (waitAllSettled) waits even for in-flight spawns
    this.flowById.set(id, flow);
    void flow.finally(() => { this.flows.delete(flow); this.flowById.delete(id); this.cancelledSpawns.delete(id); });
```

(c) `run()` — two cancel checks, one before `addWorktree` and one after it (both before the factory):

Right before `await git.addWorktree(...)`:

```ts
      if (this.cancelledSpawns.has(id)) { signalReady(); return; } // cancelled before the worktree existed — nothing to clean
```

Right after `await git.addWorktree(...)` (before `signalReady()`):

```ts
      if (this.cancelledSpawns.has(id)) {
        // Cancelled while the worktree was being created: remove it and bail WITHOUT registering an entry or
        // starting the agent. The discard/delete that cancelled us proceeds once this flow settles.
        try { await git.removeWorktree(input.repoPath, worktreePath, branch); } catch { /* best-effort */ }
        signalReady();
        return;
      }
```

(d) `discard(id)` — await a cancelled in-flight spawn first:

```ts
  async discard(id: string): Promise<void> {
    // A provisioning spawn has no entry yet (entries.set happens after the worktree+factory). Cancel it
    // cooperatively and wait for the flow to clean up after itself; then there is nothing left to discard.
    const inflight = this.flowById.get(id);
    if (inflight && !this.entries.has(id)) {
      this.cancelledSpawns.add(id);
      await inflight.catch(() => {});
      if (!this.entries.has(id)) { this.setStatusRowOnly(id, "stopped"); return; }
    }
    const e = this.require(id);
    // ... (rest of the existing discard body unchanged)
```

with a tiny row-only helper next to `setStatus` (the entry doesn't exist in this path):

```ts
  // Terminal write for a worker that never got an entry (cancelled mid-provisioning). force: user-initiated.
  private setStatusRowOnly(id: string, status: string): void {
    try { this.deps.repos.setWorkerStatus(id, status, true); } catch { /* row may already be deleted */ }
    const row = this.deps.repos.getWorker(id);
    this.deps.bus.emit({ type: "worker.status", sessionId: row?.session_id ?? "", workerId: id, status });
  }
```

(`delete(id)` needs no change: it calls `discard` — which now succeeds — then `deleteWorker` + `entries.delete`.)

- [ ] **Step 4: Run the fleet suites + typecheck + commit**

```bash
npx vitest run test/core/fleet-orchestrator.test.ts test/core/fleet-orchestrator-tier1.test.ts test/core/fleet-orchestrator-close.test.ts test/core/fleet-orchestrator-checkpoints.test.ts && npm run typecheck
git add src/core/fleet-orchestrator.ts test
git commit -m "fix(core): deleting a provisioning worker cancels the spawn — no worktree/branch leak, no ghost entry (audit #12)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Slack relay — buffer pre-registration events; a failed link-post no longer kills the relay (audit #19, MEDIUM)

`worker.spawned` is processed asynchronously (2-3 Slack round-trips) but `worker.event` is checked synchronously against the reporters map — everything a fast worker emits before registration is dropped. And the master-thread link post (`onSpawned` line ~85) has no catch: its rejection skips the registration line, permanently disabling the relay for that worker.

**Files:**
- Modify: `src/slack/worker-slack-relay.ts`
- Test: `test/slack/worker-slack-relay.test.ts` (mirror its fake-client fixtures; note its existing tests call `await relay.idle()` between spawn and events — your new tests deliberately DON'T)

**Interfaces:**
- Produces: `WorkerSlackRelay` buffers `worker.event`s that arrive between `worker.spawned` and registration (bounded at 200 per worker) and flushes them through the reporter on registration; the link post is best-effort (`try/catch` + stderr) and never blocks registration.

- [ ] **Step 1: Write the failing tests**

```ts
it("events emitted before onSpawned finishes are buffered and flushed in order (audit #19)", async () => {
  // spawn, then IMMEDIATELY emit a tool_use worker.event without awaiting relay.idle()
  relay.onEvent(spawnedEvent);
  relay.onEvent(workerEvent /* e.g. assistant message */);
  await relay.idle();
  // assert the fake client / reporter received the message content (mirror how existing tests assert delivery)
});

it("a failed master-thread link post does not disable the relay for that worker", async () => {
  // fake client: postMessage to the MASTER thread (channel === master.channel) rejects; the relay-channel root post succeeds
  relay.onEvent(spawnedEvent);
  await relay.idle();
  relay.onEvent(workerEvent);
  await relay.idle();
  // assert the event was still delivered (worker registered despite the failed link post)
});
```

(Fill in with the file's real fixtures — it has helpers for the spawned/worker events and a recording fake client.)

- [ ] **Step 2: Run to verify they fail**

Expected: FAIL — first: the early event is dropped (nothing delivered); second: nothing delivered at all (registration skipped).

- [ ] **Step 3: Implement**

In `src/slack/worker-slack-relay.ts`:

(a) Field:

```ts
  // Events that arrive while onSpawned's Slack round-trips are still in flight — flushed on registration.
  // Bounded: a stalled spawn must not buffer unboundedly (beyond the cap, oldest are kept, newest dropped).
  private readonly spawnBuffer = new Map<string, Array<Extract<CoreEvent, { type: "worker.event" }>>>();
  private static readonly SPAWN_BUFFER_MAX = 200;
```

(b) `onEvent` — open the buffer synchronously on spawned; buffer events while it exists:

```ts
  onEvent(e: CoreEvent): void {
    if (e.type === "worker.spawned") {
      if (!this.workers.has(e.workerId) && !this.spawnBuffer.has(e.workerId)) this.spawnBuffer.set(e.workerId, []);
      this.tail = this.tail.then(() => this.onSpawned(e)).catch((err) => { process.stderr.write(`[rookery] worker-slack-relay error: ${String(err)}\n`); });
    } else if (e.type === "worker.event") {
      const buf = this.spawnBuffer.get(e.workerId);
      if (buf) { if (buf.length < WorkerSlackRelay.SPAWN_BUFFER_MAX) buf.push(e); return; }
      const reporter = this.workers.get(e.workerId);
      if (!reporter) return;
      const ce = workerEventToCoreEvent(e.data, e.sessionId);
      if (ce) reporter.onEvent(ce);
    } else if (e.type === "worker.status" && TERMINAL.has(e.status)) {
      const workerId = e.workerId;
      this.tail = this.tail.then(() => this.onTerminal(workerId)).catch(() => {});
    }
  }
```

(c) `onSpawned` — try/finally clears the buffer; flush after registration; link post best-effort:

```ts
  private async onSpawned(e: Extract<CoreEvent, { type: "worker.spawned" }>): Promise<void> {
    try {
      const channel = this.channelIfEnabled();
      if (!channel) return;
      const master = this.deps.resolveThread(e.sessionId);
      if (!master) return; // not a Slack-origin master → out of scope
      if (this.workers.has(e.workerId)) return; // double-emit safety
      // ... (rows/blocks/fallback + root postMessage unchanged) ...
      const rootTs = root.ts;
      if (!rootTs) return; // can't thread/permalink without a ts
      // Link the worker thread back into the master's Slack thread — BEST-EFFORT: a failed link post must not
      // skip the registration below (it used to disable the relay for this worker entirely).
      try {
        const permalink = await this.deps.client.chat.getPermalink({ channel, message_ts: rootTs }).then((r) => r.permalink).catch(() => undefined);
        if (permalink) {
          await this.deps.client.chat.postMessage({ channel: master.channel, thread_ts: master.threadTs, text: `🧵 Worker \`${e.label || e.workerId}\` started — follow: ${permalink}` });
        }
      } catch (err) {
        process.stderr.write(`[rookery] worker-slack-relay link post failed: ${String(err)}\n`);
      }
      const reporter = new SlackThreadReporter(this.deps.client, { channel, threadTs: rootTs, team: master.team, userId: master.userId }, this.deps.getLocale);
      this.workers.set(e.workerId, reporter);
      // Flush events that raced the spawn round-trips, in arrival order.
      for (const ev of this.spawnBuffer.get(e.workerId) ?? []) {
        const ce = workerEventToCoreEvent(ev.data, ev.sessionId);
        if (ce) reporter.onEvent(ce);
      }
    } finally {
      this.spawnBuffer.delete(e.workerId); // every exit path: stop buffering (direct delivery or out-of-scope drop)
    }
  }
```

(d) `onTerminal` — also `this.spawnBuffer.delete(workerId);` first (a worker that dies before registration must not leave a buffer).

- [ ] **Step 4: Run tests + typecheck + commit**

```bash
npx vitest run test/slack/worker-slack-relay.test.ts && npm run typecheck
git add src/slack/worker-slack-relay.ts test/slack/worker-slack-relay.test.ts
git commit -m "fix(slack): relay buffers pre-registration worker events; failed link post no longer disables the relay (audit #19)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Renderer — pendingBySession fallback reconciliation (audit #17, MEDIUM)

A master pending bubble is removed ONLY by the live echo with the same clientMsgId. If the echo is lost (WS drop after persist; queued turn killed by a daemon restart; unknown-session rejection), the bubble and the busy composer persist until a full reload. Fix with two deterministic nets: (a) the history seed drops pending entries whose clientMsgId already appears in the seeded (persisted) events; (b) entries from BEFORE the last reconnect that the seed didn't reconcile are dropped (their turn is either dead, or still queued on a live daemon — in which case the echo re-renders the message normally when it fires; only the bubble disappears early, no data loss).

**Files:**
- Modify: `apps/desktop/src/renderer/store/reduce.ts` (pendingBySession item type gains `epoch?: number`)
- Modify: `apps/desktop/src/renderer/store/store.ts` (`connectionEpoch` state + `bumpConnectionEpoch()`; `pushPending` stamps the epoch; `seedHistory` reconciles)
- Modify: `apps/desktop/src/renderer/App.tsx` (call `bumpConnectionEpoch()` in `onOpen`, next to `resetLiveInteractions()`)
- Test: `apps/desktop/test/store-pending.test.ts`

**Interfaces:**
- Produces: store fields `connectionEpoch: number` (starts 0), `bumpConnectionEpoch(): void`; `pendingBySession` items become `{ clientMsgId: string; text: string; epoch?: number }`. `seedHistory(sid, events)` additionally drops pending entries for `sid` where the clientMsgId appears in `events` payloads OR `epoch < connectionEpoch`.
- Consumes: persisted `master.message` events carry `clientMsgId` (the daemon's `persistEvent` includes it), so the seed can see committed echoes.

- [ ] **Step 1: Write the failing tests**

Add to `apps/desktop/test/store-pending.test.ts`:

```ts
describe("pendingBySession fallback reconciliation (audit #17)", () => {
  const SID = "s1";
  const echoEvent = (cid: string) => ({ seq: 0, type: "master.message", payload: { type: "master.message", sessionId: SID, role: "user", content: "hi", clientMsgId: cid } });

  beforeEach(() => { useStore.setState({ pendingBySession: {}, logsBySession: {}, connectionEpoch: 0 }); });

  it("seed drops a pending entry whose echo is already committed (lost live echo)", () => {
    useStore.getState().pushPending(SID, { clientMsgId: "c1", text: "hi" });
    useStore.getState().bumpConnectionEpoch(); // reconnect
    useStore.getState().seedHistory(SID, [echoEvent("c1")]);
    expect(useStore.getState().pendingBySession[SID] ?? []).toEqual([]);
  });

  it("seed drops pre-reconnect entries with no committed echo (queued turn lost to a restart)", () => {
    useStore.getState().pushPending(SID, { clientMsgId: "c1", text: "hi" });
    useStore.getState().bumpConnectionEpoch();
    useStore.getState().seedHistory(SID, []); // fresh daemon: nothing persisted
    expect(useStore.getState().pendingBySession[SID] ?? []).toEqual([]);
  });

  it("seed KEEPS a current-epoch entry still awaiting its echo", () => {
    useStore.getState().pushPending(SID, { clientMsgId: "c1", text: "hi" });
    useStore.getState().seedHistory(SID, []); // e.g. session select — same connection
    expect(useStore.getState().pendingBySession[SID]).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Expected: FAIL — `bumpConnectionEpoch` is not a function.

- [ ] **Step 3: Implement**

(a) `reduce.ts` — widen the item type:

```ts
  pendingBySession: Record<string, { clientMsgId: string; text: string; epoch?: number }[]>;
```

(b) `store.ts` — state + actions (types added to the store interface: `connectionEpoch: number; bumpConnectionEpoch: () => void;`):

```ts
  // Bumped on every ws (re)connect (App onOpen). pending entries carry the epoch they were created in; the
  // history seed drops pre-reconnect entries — their turn is dead (restart) or their echo will re-render the
  // message anyway when the still-queued turn starts. Prevents the audit-#17 forever-ghost bubble.
  connectionEpoch: 0,
  bumpConnectionEpoch: () => set((s) => ({ connectionEpoch: s.connectionEpoch + 1 })),
```

`pushPending` stamps the epoch:

```ts
  pushPending: (sid, item) => set((s) => ({ pendingBySession: { ...s.pendingBySession, [sid]: [...(s.pendingBySession[sid] ?? []), { ...item, epoch: s.connectionEpoch }] } })),
```

`seedHistory` reconciles (keep the existing `seedSessionLog` call; add the pending filter):

```ts
  seedHistory: (sid, events) => set((s) => {
    // Fallback reconciliation (audit #17): the live echo is the primary remover, but a lost echo left the
    // bubble forever. The persisted transcript is authoritative — drop entries already committed there, and
    // drop pre-reconnect entries the seed didn't find (dead turn, or a queued echo that will re-render itself).
    const committed = new Set(events.map((ev) => (ev.payload as { clientMsgId?: string }).clientMsgId).filter((c): c is string => typeof c === "string"));
    const pending = (s.pendingBySession[sid] ?? []).filter((p) => !committed.has(p.clientMsgId) && (p.epoch === undefined || p.epoch >= s.connectionEpoch));
    return {
      logsBySession: { ...s.logsBySession, [sid]: seedSessionLog(s.logsBySession[sid], sid, events, s.liveInteractionIds) },
      pendingBySession: { ...s.pendingBySession, [sid]: pending },
    };
  }),
```

(c) `App.tsx` `onOpen` — next to `resetLiveInteractions()`:

```ts
      useStore.getState().bumpConnectionEpoch(); // pending bubbles from before this reconnect become prunable at seed time
```

- [ ] **Step 4: Run the desktop suites + typecheck + commit**

```bash
npm -w apps/desktop test && npm -w apps/desktop run typecheck
git add apps/desktop/src/renderer apps/desktop/test
git commit -m "fix(desktop): pending master bubbles reconcile against the persisted transcript on reconnect (audit #17)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Dock — two-way active-tab sync (audit #20, MEDIUM)

Dock mode never reads or writes `activeTabId`: re-clicking an already-open file/diff/commit is a silent no-op (the panel stays buried), and the FileTree highlight tracks the store instead of the focused panel. Fix: map tab-ids⇄panel-ids with pure helpers, focus the panel when the store's activeTabId changes, and write the store when the dock's active panel changes.

**Files:**
- Modify: `apps/desktop/src/renderer/workspace/panel-ids.ts` (two pure helpers)
- Modify: `apps/desktop/src/renderer/workspace/WorkspaceDock.tsx` (sync both directions)
- Test: `apps/desktop/test/panel-ids.test.ts` (create if absent; check for an existing panel-ids test first)

**Interfaces:**
- Produces (in `panel-ids.ts`; reuse its existing `fixedPanelId`/`editorPanelId` — read the file first and match its exact export style):

```ts
// tab id ("agent" | "file:..." | "diff:..." | "commit:...") → the dock panel id that renders it.
export function panelIdForTab(tabId: string): string {
  return tabId === "agent" ? fixedPanelId("conversation") : editorPanelId(tabId);
}
// dock panel id → the workspace tab id it represents, or null for fixed panels that aren't tabs (files/git/terminal/nested).
export function tabIdForPanel(panelId: string): string | null {
  if (panelId === fixedPanelId("conversation")) return "agent";
  const p = "panel:editor:";
  return panelId.startsWith(p) ? panelId.slice(p.length) : null;
}
```

(If `panel-ids.ts` already exports an editor-prefix constant, use it instead of re-declaring the literal.)

- [ ] **Step 1: Write the failing helper tests**

`apps/desktop/test/panel-ids.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { panelIdForTab, tabIdForPanel, fixedPanelId, editorPanelId } from "../src/renderer/workspace/panel-ids.js";

describe("tab⇄panel id mapping (dock active sync)", () => {
  it("round-trips editor tabs and the agent tab", () => {
    expect(panelIdForTab("file:/a/b.ts")).toBe(editorPanelId("file:/a/b.ts"));
    expect(tabIdForPanel(panelIdForTab("file:/a/b.ts"))).toBe("file:/a/b.ts");
    expect(panelIdForTab("agent")).toBe(fixedPanelId("conversation"));
    expect(tabIdForPanel(fixedPanelId("conversation"))).toBe("agent");
  });
  it("fixed non-tab panels map to null", () => {
    expect(tabIdForPanel(fixedPanelId("files"))).toBeNull();
    expect(tabIdForPanel(fixedPanelId("terminal"))).toBeNull();
  });
});
```

- [ ] **Step 2: RED → implement helpers → GREEN**

Run the new test file (FAIL: not exported), add the two helpers to `panel-ids.ts`, re-run (PASS).

- [ ] **Step 3: Wire WorkspaceDock (both directions)**

In `apps/desktop/src/renderer/workspace/WorkspaceDock.tsx`:

(a) Import the helpers: `import { fixedPanelId, editorPanelId, panelIdForTab, tabIdForPanel, type FixedKind } from "./panel-ids.js";`

(b) Store → dock: add a sync function and call it where `syncEditors` is called (both in `onReady` after `syncEditors(api)` and in the store subscription):

```ts
  // Store → dock: focus the panel for the store's active tab. Re-clicking an already-open file in the
  // FileTree only writes activeTabId (openFile_ early-returns when the tab exists) — without this, the click
  // was a silent no-op while the panel stayed buried behind another tab (audit #20).
  const syncActive = (api: DockviewApi | null): void => {
    if (!api || disposedRef.current) return;
    const want = panelIdForTab(useWsStore.getState().byPage[pageKey]?.activeTabId ?? "agent");
    if (api.activePanel?.id === want) return;
    const panel = api.getPanel(want);
    if (!panel) return;
    reconcilingRef.current = true;
    try { panel.api.setActive(); } finally { reconcilingRef.current = false; }
  };
```

In `onReady`, after `syncEditors(api);` add `syncActive(api);`. In the effect's subscription, change to:

```ts
    const unsub = useWsStore.subscribe(() => { syncEditors(apiRef.current); syncActive(apiRef.current); });
```

(c) Dock → store: in `onReady`'s disposables, add:

```ts
    // Dock → store: clicking a dock tab makes it the workspace-active tab, so the FileTree highlight and any
    // store-driven consumers track the actually-focused panel. Fixed non-tab panels (files/git/terminal) are
    // not tabs — they don't touch activeTabId.
    disposables.push(api.onDidActivePanelChange((p) => {
      if (reconcilingRef.current || disposedRef.current || !p) return;
      const tabId = tabIdForPanel(p.id);
      if (!tabId) return;
      if ((useWsStore.getState().byPage[pageKey]?.activeTabId ?? "agent") !== tabId) useWsStore.getState().setActive_(pageKey, tabId);
    }));
```

Loop safety: store→dock guards with `api.activePanel?.id === want` and sets `reconcilingRef` around `setActive()`; dock→store guards with the equality check — the cycle converges in one hop each way.

- [ ] **Step 4: Run the desktop suites + typecheck + commit**

```bash
npm -w apps/desktop test && npm -w apps/desktop run typecheck
git add apps/desktop/src/renderer/workspace apps/desktop/test/panel-ids.test.ts
git commit -m "fix(desktop): two-way dock active-panel sync — re-clicking an open file focuses its panel (audit #20)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

Note in your report: the dock wiring itself is verified by typecheck + the pure-helper tests; jsdom cannot exercise dockview focus — flag "needs a quick visual check in `npm -w apps/desktop run dev`" as a concern for the controller.

---

### Task 9: Full verification sweep + audit status update

**Files:** Modify: `docs/2026-07-03-agent-loop-audit.md`

- [ ] **Step 1:** `npm test && npm run typecheck` — ALL PASS, exit 0.
- [ ] **Step 2:** `npm -w apps/desktop test && npm -w apps/desktop run typecheck` — ALL PASS, exit 0.
- [ ] **Step 3:** `npm run build` — exit 0.
- [ ] **Step 4:** In `docs/2026-07-03-agent-loop-audit.md`, extend the status blockquote with:

```
> Medium wave: #10 (error stays error), #12 (provisioning cancel), #13 (reqId echo), #15 (once claim-then-delete), #16 (fresh concurrent slack triggers), #17 (pending reconcile), #19 (relay buffering), #20 (dock active sync) fixed — see docs/superpowers/plans/2026-07-03-audit-medium-wave.md. Remaining open: the LOW findings.
```

- [ ] **Step 5:**

```bash
git add docs/2026-07-03-agent-loop-audit.md
git commit -m "docs: mark audit medium wave done (#10 #12 #13 #15 #16 #17 #19 #20)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
