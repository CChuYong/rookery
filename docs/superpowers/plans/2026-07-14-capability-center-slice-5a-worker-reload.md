# Capability Center Slice 5A Worker Reload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an existing Claude or Codex worker adopt its latest managed capability revision without losing its worktree, transcript, native provider conversation, model, effort, permission mode, or budget state.

**Architecture:** Split `Worker` lifetime from an individual provider-stream cycle. A reload closes only the current cycle, swaps in a fresh `MessageQueue` and `AbortController`, and resumes the persisted provider session against a newly resolved capability projection. `FleetOrchestrator` owns duplicate-request and send gates, while protocol/UI expose immediate reload, reload-when-idle, and next-start outcomes.

**Tech Stack:** TypeScript, Node.js 22, Vitest, Zod WebSocket protocol, React 18, Zustand event state, Claude Agent SDK, Codex app-server.

## Global Constraints

- Never route capability reload through terminal `Worker.stop()` or a terminal fleet status.
- Never restart a `running` or `background` worker unless `whenIdle: true` was explicitly requested.
- Preserve the worker row, worktree, transcript sequence, `sdk_session_id`, handoff state, cumulative cost/turn counters, model, effort, permission mode, max-turn cap, and cost budget.
- Resolve managed capabilities again for every replacement provider stream; do not reuse a stale `ResolvedAgentCapabilities` object.
- Reject `worker.send` while the replacement cycle is closing/opening. A request waiting for idle may continue to accept sends until the worker actually begins replacement.
- A reload failure leaves the worker idle and retryable, emits a capability runtime error, and never writes `stopped`, `done`, `failed`, `error`, or `orphaned` to the worker lifecycle.
- Protocol/events/generated files/argv/logs must remain secret-free.
- All user-facing desktop text must exist in both Korean and English catalogs.
- Run all commands under Node 22.

---

### Task 1: Separate Worker lifetime from provider-stream cycles

**Files:**

- Modify: `src/core/worker.ts`
- Modify: `test/core/worker.test.ts`
- Modify: `test/core/worker-lifecycle.test.ts`

**Interfaces:**

- Produces: `Worker.requestCapabilityReload(input: { whenIdle: boolean; onBegin(): void }): { mode: "reloading" | "scheduled"; completion: Promise<void> }`.
- Produces: one lifetime settlement promise returned by `waitUntilSettled()` across any number of stream cycles.
- Preserves: existing `start`, `resume`, `send`, `interruptTurn`, `stop`, `listCommands`, model, and permission APIs.

- [ ] **Step 1: Add failing Worker cycle tests**

  Add deterministic hanging backends to prove all of the following:

  ```ts
  const request = worker.requestCapabilityReload({ whenIdle: false, onBegin });
  expect(request.mode).toBe("reloading");
  await request.completion;
  expect(opened.map((call) => call.options.resume)).toEqual([null, "native-session-1"]);
  expect(opened.map((call) => call.options.capabilities?.revision)).toEqual(["rev-a", "rev-b"]);
  expect(repos.getWorker("a1")?.status).toBe("idle");
  expect(worker.status()).toBe("idle");
  expect(worker.waitUntilSettled()).not.toHaveResolved();
  ```

  Cover queue identity replacement, old stream interruption, transcript sequence continuity, cumulative metrics continuity, SDK session preservation, reload retry after setup failure, and terminal `stop()` after a successful reload.

- [ ] **Step 2: Run the focused Worker tests and confirm the missing API/lifetime failures**

  Run: `npx vitest run test/core/worker.test.ts test/core/worker-lifecycle.test.ts`

  Expected: FAIL because `requestCapabilityReload` does not exist and `waitUntilSettled()` still follows one cycle loop.

- [ ] **Step 3: Introduce an explicit provider cycle**

  Replace readonly queue/abort ownership with a cycle object and keep a separate lifetime deferred:

  ```ts
  interface ProviderCycle {
    queue: MessageQueue;
    abort: AbortController;
    stream?: AgentStream;
    loop: Promise<void>;
    reloadAttempt: boolean;
  }

  interface PendingCapabilityReload {
    onBegin(): void;
    resolve(): void;
    reject(error: unknown): void;
  }

  private cycle!: ProviderCycle;
  private lifetimeSettled = false;
  private readonly lifetime = new Promise<void>((resolve) => { this.resolveLifetime = resolve; });
  private resolveLifetime!: () => void;
  private pendingReload?: PendingCapabilityReload;
  private reloading = false;
  private reloadFailure: string | null = null;
  ```

  `start()` and `resume()` create the first cycle. `consume(cycle)` uses only the passed cycle's queue, abort signal, and stream. An aborted old cycle returns before natural-end terminal handling. `transition()` resolves `lifetime` only for terminal states; `waitUntilSettled()` awaits `lifetime`, not `cycle.loop`.

- [ ] **Step 4: Implement immediate and when-idle replacement**

  Implement synchronous gating and asynchronous replacement:

  ```ts
  requestCapabilityReload({ whenIdle, onBegin }: { whenIdle: boolean; onBegin(): void }) {
    if (this.isTerminalState()) throw new Error(`Worker ${this.opts.id} is not running`);
    if (this.pendingReload || this.reloading) throw new Error(`worker ${this.opts.id} capability reload is already pending`);
    if ((this.state === "running" || this.state === "background") && !whenIdle) {
      throw new Error(`worker ${this.opts.id} is busy; retry with whenIdle`);
    }
    const completion = new Promise<void>((resolve, reject) => {
      this.pendingReload = { onBegin, resolve, reject };
    });
    if (this.state === "idle") this.beginPendingReload();
    return { mode: this.reloading ? "reloading" as const : "scheduled" as const, completion };
  }
  ```

  `transition("idle")` invokes `beginPendingReload()` synchronously before publishing the idle event, so a re-entrant send observes the reload gate. Replacement closes/aborts/interrupts the old cycle, awaits only that cycle, creates a new cycle with `resume: this.sdkSessionId`, and resolves completion after `openSession()` accepts the new options. `send()` throws `worker <id> capability reload in progress; retry` only while replacement is active.

- [ ] **Step 5: Preserve retryability on application failure**

  In a reload attempt, a failure before the first provider frame must:

  ```ts
  capabilityRuntime.setError(runtimeTarget, managed.revision, "Capability runtime application failed.");
  this.record({ kind: "notice", text: "Capability reload failed; the worker remains idle and can retry." });
  this.turnActive = false;
  this.reconcile();
  pending.reject(error);
  ```

  It must not call `transition("error")`. A subsequent reload creates another fresh cycle. Once the new cycle emits its first provider frame, the normal applied revision path resumes and later provider crashes retain existing terminal semantics.

- [ ] **Step 6: Run focused Worker tests and typecheck**

  Run: `npx vitest run test/core/worker.test.ts test/core/worker-lifecycle.test.ts && npm run typecheck`

  Expected: PASS.

- [ ] **Step 7: Commit the Worker cycle change**

  ```bash
  git add src/core/worker.ts test/core/worker.test.ts test/core/worker-lifecycle.test.ts
  git commit -m "feat: reload worker capability runtimes"
  ```

### Task 2: Add Fleet reload gates and protocol

**Files:**

- Modify: `src/core/fleet-orchestrator.ts`
- Modify: `test/core/fleet-orchestrator.test.ts`
- Modify: `src/protocol/messages.ts`
- Modify: `test/protocol/messages.test.ts`
- Modify: `src/daemon/connection.ts`
- Modify: `test/daemon/connection.test.ts`

**Interfaces:**

- Consumes: `WorkerLike.requestCapabilityReload(...)` from Task 1.
- Produces: `FleetOrchestrator.reloadCapabilities(id: string, whenIdle: boolean): Promise<{ workerId: string; mode: "reloading" | "scheduled" | "next-start" }>`.
- Produces client request: `{ type: "capabilities.worker.reload"; reqId; workerId; whenIdle?: boolean }`.
- Produces result: `{ type: "capabilities.worker.reload.result"; reqId; workerId; mode }`.

- [ ] **Step 1: Add failing fleet gate tests**

  Cover:

  ```ts
  expect(await fleet.reloadCapabilities("idle", false)).toEqual({ workerId: "idle", mode: "reloading" });
  await expect(fleet.reloadCapabilities("running", false)).rejects.toThrow(/busy/);
  expect(await fleet.reloadCapabilities("running", true)).toEqual({ workerId: "running", mode: "scheduled" });
  expect(() => fleet.send("idle", "race")).toThrow(/reload in progress.*retry/);
  expect(await fleet.reloadCapabilities("lazy", false)).toEqual({ workerId: "lazy", mode: "next-start" });
  ```

  Prove duplicate requests share neither teardown nor queue, scheduled requests allow sends until `onBegin`, stop/discard clears pending state, and a failed completion allows retry.

- [ ] **Step 2: Run focused fleet tests and confirm failure**

  Run: `npx vitest run test/core/fleet-orchestrator.test.ts`

  Expected: FAIL because the reload method and WorkerLike port are absent.

- [ ] **Step 3: Implement Fleet ownership**

  Add:

  ```ts
  interface CapabilityReloadFlow {
    phase: "waiting" | "reloading";
    completion: Promise<void>;
  }

  private readonly capabilityReloads = new Map<string, CapabilityReloadFlow>();
  ```

  A detached resumable worker returns `next-start` without materializing because its first later send already resolves the latest revision. A live worker delegates to `requestCapabilityReload`; `onBegin` switches the record to `reloading`. `send()` rejects only in that phase. Completion removes the map entry on success or failure. Terminal stop/discard/close reject or drain pending reloads without spawning another cycle.

- [ ] **Step 4: Add protocol schema and request/result mapping**

  Add the exact Zod member and result types:

  ```ts
  z.object({
    type: z.literal("capabilities.worker.reload"),
    reqId: capabilityIdSchema,
    workerId: capabilityIdSchema,
    whenIdle: z.boolean().optional(),
  })
  ```

  Map `"capabilities.worker.reload"` to `Extract<ServerMessage, { type: "capabilities.worker.reload.result" }>` in `RequestResultMap`.

- [ ] **Step 5: Route the daemon request**

  In `Connection.handleRaw`:

  ```ts
  case "capabilities.worker.reload": {
    if (!this.capabilities) return this.reply({ type: "error", message: "capability registry unavailable", reqId: msg.reqId });
    const result = await this.fleet.reloadCapabilities(msg.workerId, msg.whenIdle ?? false);
    this.reply({ type: "capabilities.worker.reload.result", reqId: msg.reqId, ...result });
    return;
  }
  ```

  The outer correlated error path remains the error transport for busy/terminal/duplicate requests.

- [ ] **Step 6: Run protocol, fleet, and connection tests**

  Run: `npx vitest run test/core/fleet-orchestrator.test.ts test/protocol/messages.test.ts test/daemon/connection.test.ts && npm run typecheck`

  Expected: PASS.

- [ ] **Step 7: Commit fleet and wire contract**

  ```bash
  git add src/core/fleet-orchestrator.ts test/core/fleet-orchestrator.test.ts src/protocol/messages.ts test/protocol/messages.test.ts src/daemon/connection.ts test/daemon/connection.test.ts
  git commit -m "feat: expose capability worker reload"
  ```

### Task 3: Add reload controls to Capability Center

**Files:**

- Modify: `apps/desktop/src/renderer/components/capabilities/types.ts`
- Modify: `apps/desktop/src/renderer/components/CapabilitiesPage.tsx`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/i18n/locales/ko/capabilities.ts`
- Modify: `apps/desktop/src/renderer/i18n/locales/en/capabilities.ts`
- Modify: `apps/desktop/test/capabilities-page.test.tsx`

**Interfaces:**

- Consumes: `capabilities.worker.reload` protocol from Task 2.
- Adds: `CapabilityCenterApi.reloadWorker(workerId, whenIdle): Promise<{ workerId: string; mode: "reloading" | "scheduled" | "next-start" }>`.

- [ ] **Step 1: Add failing desktop interaction tests**

  Render worker snapshots containing `pending-reload` and assert:

  ```tsx
  expect(screen.getByRole("button", { name: "지금 다시 불러오기" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "유휴 상태에서 다시 불러오기" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "지금 다시 불러오기" }));
  expect(api.reloadWorker).toHaveBeenCalledWith("worker-1", false);
  ```

  Cover busy immediate errors, scheduled acknowledgement, next-start acknowledgement, retry, automatic snapshot refetch after a result, and absence of controls for master targets/current workers.

- [ ] **Step 2: Run the component test and confirm missing controls**

  Run: `npm -w apps/desktop test -- capabilities-page.test.tsx`

  Expected: FAIL because `reloadWorker` and the action panel do not exist.

- [ ] **Step 3: Extend the typed desktop API**

  Wire:

  ```ts
  reloadWorker: (workerId, whenIdle) => connected()
    .request({ type: "capabilities.worker.reload", workerId, whenIdle })
    .then(({ workerId: id, mode }) => ({ workerId: id, mode })),
  ```

  Keep `capabilityApi` memoized on the stable client dependency.

- [ ] **Step 4: Render the reload confirmation/action state**

  When the selected target is a worker and any managed entry is `pending-reload` or `error`, render a warning card with two actions. Immediate reload shows an inline spinner until the request settles; when-idle returns a scheduled message. A correlated daemon error stays in the card and leaves both actions retryable. Trigger a snapshot refresh after every successful acknowledgement and continue relying on `capabilities.runtime` generation/events for final applied state.

- [ ] **Step 5: Add Korean and English copy**

  Add matching keys for reload title, explanation, immediate action, when-idle action, scheduled, next-start, in-progress, failed, and retry guidance. No raw daemon error replaces the localized summary; show raw detail below it.

- [ ] **Step 6: Run desktop focused gates**

  Run: `npm -w apps/desktop test -- capabilities-page.test.tsx && npm -w apps/desktop run typecheck`

  Expected: PASS.

- [ ] **Step 7: Commit desktop reload UX**

  ```bash
  git add apps/desktop/src/renderer/components/capabilities/types.ts apps/desktop/src/renderer/components/CapabilitiesPage.tsx apps/desktop/src/renderer/App.tsx apps/desktop/src/renderer/i18n/locales/ko/capabilities.ts apps/desktop/src/renderer/i18n/locales/en/capabilities.ts apps/desktop/test/capabilities-page.test.tsx
  git commit -m "feat: reload worker capabilities from the center"
  ```

### Task 4: Verify reload across Claude and Codex

**Files:**

- Create: `scripts/smoke-capability-center-slice5.mjs`
- Modify: `package.json`
- Modify: `docs/reference/protocol.md`
- Modify: `docs/reference/events.md`
- Modify: `docs/architecture/master-worker-turn.md`
- Modify: `AGENTS.md`

**Interfaces:**

- Consumes the complete Slice 5A runtime/protocol/UI behavior.
- Produces script: `npm run smoke:capabilities:slice5`.

- [ ] **Step 1: Add an isolated live smoke**

  The script must create a temporary Rookery home/repo, register and trust a harmless pack, start one Claude worker and one Codex worker, mutate the pack, refresh/re-trust it, observe `pending-reload`, request reload, and send a validation turn proving the new instruction/skill/MCP revision is active. It must also schedule a reload while a turn is running, prove the worktree and native session id remain unchanged, and verify no secret value appears in runtime files, target homes, argv captures, events, or logs.

- [ ] **Step 2: Register and run the smoke after a build**

  Add:

  ```json
  "smoke:capabilities:slice5": "node scripts/smoke-capability-center-slice5.mjs"
  ```

  Run: `npm run build && npm run smoke:capabilities:slice5`

  Expected: PASS with explicit Claude immediate-reload, Codex immediate-reload, when-idle scheduling, context preservation, and secret-boundary markers.

- [ ] **Step 3: Update durable documentation**

  Document request/result shapes, the replacement-cycle lifecycle, send gating, failure retryability, desired/applied transitions, and why reload is not `stop_worker`. Remove every statement that worker hot reload is unavailable.

- [ ] **Step 4: Run Slice 5A full gates**

  Run:

  ```bash
  npm run typecheck
  npm test
  npm -w apps/desktop run typecheck
  npm -w apps/desktop test
  npm run build
  ```

  Expected: all PASS.

- [ ] **Step 5: Commit smoke and documentation**

  ```bash
  git add scripts/smoke-capability-center-slice5.mjs package.json docs/reference/protocol.md docs/reference/events.md docs/architecture/master-worker-turn.md AGENTS.md
  git commit -m "test: verify capability worker reload live"
  ```

## Completion evidence

- An idle Claude worker and idle Codex worker both adopt a changed trusted pack without changing worker id, worktree, transcript sequence, or native provider conversation id.
- A busy worker rejects immediate reload and honors an explicit reload-when-idle request.
- `worker.send` cannot enter the queue during replacement.
- Reload setup failure leaves the worker idle and a second reload can succeed.
- Daemon restart/lazy resume applies the latest desired revision without eagerly spawning a provider.
- Desktop controls accurately distinguish reloading, scheduled, next-start, applied, and failed states.
- Full automated gates and the isolated real-provider smoke pass.
