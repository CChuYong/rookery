# Agent-Loop Audit Fixes (High 6 + Interaction/Notify Bundles) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 11 confirmed findings from the 2026-07-03 agent-loop audit (`docs/2026-07-03-agent-loop-audit.md`): the 6 HIGH findings, the interaction-card lifecycle bundle (#1/#7/#26), and the notify-durability bundle (#11/#14/#21).

**Architecture:** All fixes are small, surgical changes at existing seams: the core `InteractionRegistry`/`MasterAgent`/`WorkerNotifier`/`FleetOrchestrator`/`AutomationDispatcher`, the daemon composition root (`server.ts`), the Slack adapter (`interaction.ts`/`app.ts`/holders), and the desktop renderer reducer (`reduce.ts`). No DB schema changes — no migrations. Each task is independently testable and committable.

**Tech Stack:** TypeScript (ESM NodeNext), vitest, better-sqlite3 (in-memory for tests), fakeQuery SDK fake, React/Zustand renderer (jsdom vitest in `apps/desktop`).

## Global Constraints

- **Node 22 required.** `better-sqlite3` is built against Node 22 ABI (127). Before ANY command: `nvm use 22` (or ensure `node -p process.versions.modules` prints `127`). Symptom of getting it wrong: native module ABI errors in vitest.
- **ESM NodeNext:** relative imports MUST end in `.js`; type-only imports MUST use `import type` (`verbatimModuleSyntax`).
- **Code comments in English** (repo-wide convention).
- **No new migrations needed** — none of these tasks change the SQLite schema. Do NOT touch the `MIGRATIONS` array.
- **Branch:** work directly on the current branch `feat/dockable-panes`. Do not create a new branch.
- **Typecheck is a separate gate:** vitest does NOT typecheck. Root: `npm run typecheck`. Desktop: `npm -w apps/desktop run typecheck`. Run the relevant one before every commit.
- **Commit trailer (repo convention):** end every commit message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Test commands:** root single file: `npx vitest run test/<path>.test.ts`. Desktop single file: `npm -w apps/desktop test -- test/<file>.test.ts` (the `--` passes the file filter to `vitest run`).
- All file paths below are relative to the repo root `/Users/clover/workspace/clovot`.

---

### Task 1: InteractionRegistry — abort emits `interaction.resolved` (audit #7, MEDIUM)

When a master turn is aborted while an approval/AskUserQuestion card is pending, `armAbort` resolves the promise with deny but never emits `interaction.resolved`. The desktop retires cards ONLY on `interaction.resolved` (`apps/desktop/src/renderer/store/reduce.ts:217-223`), so every connected client keeps a dead-but-clickable card forever.

**Files:**
- Modify: `src/core/interaction-registry.ts:91-96` (the `armAbort` method)
- Test: `test/core/interaction-registry.test.ts`

**Interfaces:**
- Consumes: existing `EventBus.emit`, existing i18n key `interaction.cancelled` (already in both ko/en catalogs in `src/core/i18n.ts`).
- Produces: an `interaction.resolved` CoreEvent on abort — `{ type: "interaction.resolved", sessionId, requestId, summary: t(DEFAULT_LOCALE, "interaction.cancelled") }`. Task 2/3 (renderer) rely on this event shape, which already exists for the respond() path.

- [ ] **Step 1: Write the failing test**

Add to `test/core/interaction-registry.test.ts` (the file already has a `setup(channel)` helper returning `{ bus, events, reg }`):

```ts
it("abort: resolves deny AND emits interaction.resolved so live cards are retired", async () => {
  const { events, reg } = setup("s3");
  const ac = new AbortController();
  const p = reg.request("s3", "x", {}, { toolUseID: "R3", signal: ac.signal });
  await Promise.resolve();
  ac.abort();
  await expect(p).resolves.toMatchObject({ behavior: "deny" });
  expect(events.find((e) => e.type === "interaction.resolved")).toMatchObject({
    type: "interaction.resolved", sessionId: "s3", requestId: "R3",
  });
  expect(reg.pendingEvents()).toEqual([]); // pending entry cleaned up
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/interaction-registry.test.ts -t "abort: resolves deny AND emits"`
Expected: FAIL — `events.find(...)` is `undefined` (no `interaction.resolved` emitted on abort).

- [ ] **Step 3: Implement**

In `src/core/interaction-registry.ts`, replace the `armAbort` method:

```ts
  // Turn cancellation (AbortSignal) → if still pending, close it out with deny (prevents a permanent hang).
  // Also emit interaction.resolved: the desktop retires a card ONLY on that event, so without it an aborted
  // turn leaves a dead-but-clickable card on every connected client (clicks are silent no-ops).
  private armAbort(requestId: string, signal: AbortSignal | undefined, resolve: (r: PermissionResult) => void): void {
    if (!signal) return;
    const onAbort = () => {
      const p = this.pending.get(requestId);
      if (!p) return;
      this.pending.delete(requestId);
      resolve({ behavior: "deny", message: t(DEFAULT_LOCALE, "interaction.cancelled") });
      this.bus.emit({ type: "interaction.resolved", sessionId: p.sessionId, requestId, summary: t(DEFAULT_LOCALE, "interaction.cancelled") });
    };
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });
  }
```

- [ ] **Step 4: Run the file's full test suite**

Run: `npx vitest run test/core/interaction-registry.test.ts`
Expected: ALL PASS (existing abort test asserted only the deny resolution — still passes).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/core/interaction-registry.ts test/core/interaction-registry.test.ts
git commit -m "fix(core): aborted interaction emits interaction.resolved so live clients retire the card

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Renderer — `interaction.request` idempotent by requestId (audit #26, LOW)

Since 7c080ba the daemon replays all pending `interaction.request` events on every `events.subscribe` — which fires on every WS reconnect. The reducer appends unconditionally, so each reconnect adds a duplicate actionable card.

**Files:**
- Modify: `apps/desktop/src/renderer/store/reduce.ts` (the `case "interaction.request"` block, around line 211)
- Test: `apps/desktop/test/store-reduce.test.ts` (there is an existing `describe("interaction (approve/AskUserQuestion inline card)")` block around line 517 — add there)

**Interfaces:**
- Consumes: `interaction.request` CoreEvent (has `requestId`), `LogItem` `{ kind: "interaction", requestId, ... }`.
- Produces: no new API — `reduceEvent` behavior change only.

- [ ] **Step 1: Write the failing test**

Add inside the existing `describe("interaction (approve/AskUserQuestion inline card)")` in `apps/desktop/test/store-reduce.test.ts`:

```ts
it("interaction.request is idempotent by requestId (reconnect replay does not duplicate the card)", () => {
  const ev = { type: "interaction.request", sessionId: SID, requestId: "R1", kind: "approve", toolName: "t", inputText: "{}" } as never;
  const st1 = reduceEvent(emptyState(), ev);
  const st2 = reduceEvent(st1, ev); // daemon replays pending cards on every events.subscribe
  expect(st2.logsBySession[SID].filter((i) => i.kind === "interaction")).toHaveLength(1);
});
```

(`SID` is the session-id constant already used throughout that file — reuse it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w apps/desktop test -- test/store-reduce.test.ts -t "idempotent by requestId"`
Expected: FAIL — length is 2.

- [ ] **Step 3: Implement**

In `apps/desktop/src/renderer/store/reduce.ts`, replace the `case "interaction.request"` block:

```ts
    case "interaction.request": {
      const cur = state.logsBySession[e.sessionId] ?? [];
      // Idempotent by requestId: the daemon replays every pending card on each events.subscribe (i.e. on every
      // WS reconnect), so the same unresolved card can arrive again — re-appending would duplicate it.
      if (cur.some((i) => i.kind === "interaction" && i.requestId === e.requestId)) return state;
      // Master canUseTool → inline approve/question card. Finalize the streaming bubble, then add the card.
      const log = finalizeStreamingMsg(cur);
      const item: LogItem = { kind: "interaction", requestId: e.requestId, mode: e.kind, toolName: e.toolName, inputText: e.inputText, questions: e.questions, resolved: false };
      return { ...state, logsBySession: { ...state.logsBySession, [e.sessionId]: [...log, item] } };
    }
```

- [ ] **Step 4: Run the file's full test suite**

Run: `npm -w apps/desktop test -- test/store-reduce.test.ts`
Expected: ALL PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npm -w apps/desktop run typecheck
git add apps/desktop/src/renderer/store/reduce.ts apps/desktop/test/store-reduce.test.ts
git commit -m "fix(desktop): dedup replayed interaction cards by requestId on reconnect

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Renderer — `seedSessionLog` preserves live-only interaction cards (audit #1, HIGH)

On a full reload, the daemon replays the pending card into an EMPTY log (zero `message` items), then the `session.history` seed runs: `seedSessionLog` anchors by message count, finds no messages in prev, returns `committed` — silently dropping the card. The master turn stays blocked with no card anywhere (the exact pre-7c080ba hang).

**Files:**
- Modify: `apps/desktop/src/renderer/store/reduce.ts` (the `seedSessionLog` function, lines ~51-76)
- Test: `apps/desktop/test/store-reduce.test.ts` (existing `describe("seedSessionLog (restore by replaying master events)")` around line 203)

**Interfaces:**
- Consumes: `LogItem` `{ kind: "interaction", requestId, resolved }`.
- Produces: `seedSessionLog(prev, sid, events)` keeps its exact signature; behavior addition: unresolved interaction items present in `prev` but missing from the merged result are re-appended at the end (interaction events are never persisted, so a replay can never contain them).

- [ ] **Step 1: Write the failing tests**

Add inside the existing `describe("seedSessionLog (restore by replaying master events)")`:

```ts
it("full reload: an unresolved interaction card replayed before the history seed survives the seed", () => {
  // Reconnect flow: events.subscribe replays the pending card into an EMPTY log, THEN session.history seeds.
  const withCard = reduceEvent(emptyState(), { type: "interaction.request", sessionId: SID, requestId: "R9", kind: "approve", toolName: "t", inputText: "{}" } as never);
  const prev = withCard.logsBySession[SID]; // [interaction] — zero message items, so the anchor can never match
  const turn = [
    { payload: { type: "master.message", sessionId: SID, role: "user", content: "hi" } },
    { payload: { type: "master.message", sessionId: SID, role: "assistant", content: "hello" } },
  ];
  const log = seedSessionLog(prev, SID, turn);
  expect(log.filter((i) => i.kind === "message")).toHaveLength(2);
  expect(log.at(-1)).toMatchObject({ kind: "interaction", requestId: "R9", resolved: false });
});

it("seed does not duplicate a card that already survived in the preserved tail", () => {
  // prev = committed message + the card (normal reconnect where the anchor DOES match).
  let st = reduceEvent(emptyState(), { type: "master.message", sessionId: SID, role: "user", content: "hi" } as never);
  st = reduceEvent(st, { type: "interaction.request", sessionId: SID, requestId: "R9", kind: "approve", toolName: "t", inputText: "{}" } as never);
  const prev = st.logsBySession[SID];
  const turn = [{ payload: { type: "master.message", sessionId: SID, role: "user", content: "hi" } }];
  const log = seedSessionLog(prev, SID, turn);
  expect(log.filter((i) => i.kind === "interaction")).toHaveLength(1);
});

it("resolved interaction summaries are NOT resurrected by the seed", () => {
  let st = reduceEvent(emptyState(), { type: "interaction.request", sessionId: SID, requestId: "R9", kind: "approve", toolName: "t", inputText: "{}" } as never);
  st = reduceEvent(st, { type: "interaction.resolved", sessionId: SID, requestId: "R9", summary: "done" } as never);
  const prev = st.logsBySession[SID]; // [resolved interaction]
  const turn = [
    { payload: { type: "master.message", sessionId: SID, role: "user", content: "hi" } },
    { payload: { type: "master.message", sessionId: SID, role: "assistant", content: "hello" } },
  ];
  const log = seedSessionLog(prev, SID, turn);
  expect(log.filter((i) => i.kind === "interaction")).toHaveLength(0);
});
```

- [ ] **Step 2: Run tests to verify the first fails**

Run: `npm -w apps/desktop test -- test/store-reduce.test.ts -t "survives the seed"`
Expected: FAIL — `log.at(-1)` is the assistant message, no interaction item.

- [ ] **Step 3: Implement**

In `apps/desktop/src/renderer/store/reduce.ts`, rename the existing `seedSessionLog` body to a private `seedCore` and add a wrapping export (keep the existing doc comment on the wrapper):

```ts
// On reconnect/session-select, overwriting wholesale with the DB would lose live-only state (streaming bubbles, etc.) (G-DESKTOP-RESEED).
// We replay persisted master events (coalesced CoreEvent) to build the committed transcript, and preserve prev's uncommitted tail.
// We restore not just text but tool/thinking/metrics/notice too (replacing the earlier text-only model). The replay reuses the master's own
// reduceEvent as-is (same logic as live → consistent). Non-persisted worker.* inline markers are not restored.
export function seedSessionLog(prev: LogItem[] | undefined, sid: string, events: Array<{ payload: unknown; createdAt?: string }>): LogItem[] {
  const merged = seedCore(prev, sid, events);
  // interaction cards are live-only (never persisted to session_events), so the replay can never contain them.
  // A full reload replays the pending card into an EMPTY log; the message-count anchor then can't match and
  // seedCore returns `committed` — dropping the card and re-hanging the blocked approval turn invisibly.
  // Re-append any UNRESOLVED card from prev that the merge lost (resolved summaries are cosmetic; let them go).
  const have = new Set(
    merged.filter((i): i is Extract<LogItem, { kind: "interaction" }> => i.kind === "interaction").map((i) => i.requestId),
  );
  const dropped = (prev ?? []).filter(
    (i): i is Extract<LogItem, { kind: "interaction" }> => i.kind === "interaction" && !i.resolved && !have.has(i.requestId),
  );
  return dropped.length ? [...merged, ...dropped] : merged;
}

function seedCore(prev: LogItem[] | undefined, sid: string, events: Array<{ payload: unknown; createdAt?: string }>): LogItem[] {
  // ... (the entire previous seedSessionLog body, unchanged)
}
```

- [ ] **Step 4: Run the file's full test suite**

Run: `npm -w apps/desktop test -- test/store-reduce.test.ts`
Expected: ALL PASS (existing seed tests unaffected: they contain no interaction items in prev).

- [ ] **Step 5: Typecheck + full desktop suite + commit**

```bash
npm -w apps/desktop run typecheck
npm -w apps/desktop test
git add apps/desktop/src/renderer/store/reduce.ts apps/desktop/test/store-reduce.test.ts
git commit -m "fix(desktop): history seed no longer wipes the replayed pending interaction card

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Daemon — `httpServer.listen` error handling + clean startup failure (audit #2, HIGH)

`startDaemon` awaits a Promise resolved only by the listen success callback, with no `error` listener. On EADDRINUSE the error is swallowed by the process-level `uncaughtException` guard and `startDaemon` never settles: a zombie process holds `daemon.pid` forever and every subsequent start fails with "already running".

**Files:**
- Modify: `src/daemon/server.ts` (hoist `close` above the listen await; wrap listen in try/catch)
- Modify: `src/index.ts` (daemon branch: catch startDaemon rejection → stderr + exit(1))
- Test: `test/daemon/server.test.ts`

**Interfaces:**
- Consumes: everything `close()` already references (`usageCollector`, `scheduler`, `heartbeat`, `wss`, `httpServer`, `slack`, `fleet`, `sessions`, `db`, `lock`) — all are defined before the listen call, so the hoist is safe.
- Produces: `startDaemon` now REJECTS on bind failure (after releasing the lock and closing the DB). `src/index.ts` exits 1 on that rejection.

- [ ] **Step 1: Write the failing test**

Add to `test/daemon/server.test.ts` (the file already imports `http` from `node:http`, `loadConfig`, `startDaemon`, and `fakeQuery`; existing tests build configs via `loadConfig({ ROOKERY_HOME: "...", ROOKERY_PORT: "0" })`). Add `import type { AddressInfo } from "node:net";`:

```ts
it("rejects on port bind failure and releases the PID lock (no zombie)", async () => {
  // Occupy a port first.
  const blocker = http.createServer(() => {});
  await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
  const busyPort = (blocker.address() as AddressInfo).port;

  const home = "/tmp/rookery-server-test-bindfail";
  const busyConfig = loadConfig({ ROOKERY_HOME: home, ROOKERY_PORT: String(busyPort) });
  // acquireLock defaults ON — the whole point: the lock must be released when listen fails.
  await expect(startDaemon({ config: busyConfig, queryFn: fakeQuery([]) })).rejects.toThrow(/EADDRINUSE/);

  // The lock must have been released: a retry with the SAME home/pidPath on a free port must succeed.
  const freeConfig = loadConfig({ ROOKERY_HOME: home, ROOKERY_PORT: "0" });
  const daemon = await startDaemon({ config: freeConfig, queryFn: fakeQuery([]) });
  await daemon.close();
  await new Promise<void>((r) => blocker.close(() => r()));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/daemon/server.test.ts -t "rejects on port bind failure"`
Expected: FAIL — the first `startDaemon` promise never settles (test times out) because the 'error' event has no listener.

- [ ] **Step 3: Implement (server.ts)**

In `src/daemon/server.ts`: move the entire `const close = async (): Promise<void> => { ... }` block to just BEFORE the listen await (all referenced variables are already in scope there), then replace the listen await:

```ts
  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(config.port, config.host, () => {
        httpServer.removeListener("error", reject);
        resolve();
      });
    });
  } catch (err) {
    // Bind failed (EADDRINUSE etc.). Without this handler the 'error' event is swallowed by the process-level
    // uncaughtException guard and startDaemon never settles — a zombie holding the PID lock forever.
    // Tear down everything already started so the lock/DB are released, then surface the failure to the caller.
    await close().catch(() => {});
    throw err;
  }
  const port = (httpServer.address() as AddressInfo).port;

  return { port, token, close };
```

Note: `close()` calls `httpServer.close()` on a server that never listened — Node invokes the callback (with ERR_SERVER_NOT_RUNNING), which still resolves the wrapping Promise, so `close()` completes. `wss.close()` likewise completes on an un-upgraded server.

- [ ] **Step 4: Implement (index.ts)**

In `src/index.ts`, wrap the startDaemon call in the daemon branch (line ~113):

```ts
    try {
      daemon = await startDaemon({ config, onShutdownRequest: shutdown });
    } catch (err) {
      // Bind/boot failure: exit non-zero instead of surviving as a half-started process (the lock and DB were
      // already released by startDaemon's own cleanup). ensureDaemon/desktop read this from daemon.log.
      process.stderr.write(`[rookery] daemon failed to start: ${String(err)}\n`);
      process.exit(1);
    }
```

TypeScript note: `daemon` is declared as `let daemon: Awaited<ReturnType<typeof startDaemon>>;` and `shutdown` references it. `process.exit(1)` has return type `never`, so definite-assignment analysis stays satisfied. If tsc still complains about use-before-assignment, change the declaration to `let daemon!: Awaited<ReturnType<typeof startDaemon>>;`.

- [ ] **Step 5: Run tests + typecheck + commit**

```bash
npx vitest run test/daemon/server.test.ts
npm run typecheck
git add src/daemon/server.ts src/index.ts test/daemon/server.test.ts
git commit -m "fix(daemon): reject startDaemon on port-bind failure instead of wedging as a zombie holding the PID lock

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Automation — `setAutomationRun` stops writing `next_run_at` (audit #3, HIGH)

The dispatcher's finally-block writes `nextRunAt` from its fire-time snapshot, silently rewinding any advance the Scheduler made during the run. A cron run longer than its period therefore refires back-to-back forever, and a schedule edit made mid-run is reverted.

**Files:**
- Modify: `src/persistence/repositories.ts` (the `setAutomationRun` method, ~line 570)
- Modify: `src/core/automation-dispatcher.ts` (3 call sites, lines 27/33/42)
- Modify: any other `setAutomationRun` callers/tests — find them all: `grep -rn "setAutomationRun" src test`
- Test: `test/core/automation-dispatcher.test.ts`

**Interfaces:**
- Produces (changed signature): `setAutomationRun(id: string, run: { lastRunAt: string|null; lastStatus: "ok"|"error"|"skipped"|"running"|null; lastError: string|null }): void` — the `nextRunAt` field is REMOVED. `next_run_at` is owned exclusively by `setAutomationNextRun` (Scheduler).

- [ ] **Step 1: Write the failing test**

Add to `test/core/automation-dispatcher.test.ts` (mirror the existing "marks the row 'running' while in flight" test's gate pattern):

```ts
it("a long run does not rewind next_run_at advanced by the scheduler mid-run (no back-to-back refire)", async () => {
  const repos = new Repositories(openDb(":memory:"), () => "t");
  const bus = new EventBus();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const runTurn = vi.fn(async () => { await gate; });
  const sessions = { create: () => ({ id: "s1", master: { runTurn } }), getOrCreateByKey: () => ({ id: "s1", master: { runTurn } }) };
  const disp = new AutomationDispatcher({ repos, bus, sessions, fleet: { spawn: vi.fn(async () => ({ id: "w" })) } });
  repos.createAutomation("a1", { name: "n", trigger: { kind: "cron", cron: "*/5 * * * *" }, action: { kind: "master", prompt: "p", cwd: "/w", sessionMode: "reuse" }, enabled: true });
  repos.setAutomationNextRun("a1", "2026-01-01T00:05:00.000Z"); // fire-time snapshot the dispatcher sees
  const a = repos.getAutomation("a1")!;
  const p = disp.run(a, {});
  await Promise.resolve();
  // Scheduler advances next_run_at while the run is in flight (what fireCron does on every overlapped tick).
  repos.setAutomationNextRun("a1", "2026-01-01T00:15:00.000Z");
  release();
  await p;
  expect(repos.getAutomation("a1")!.nextRunAt).toBe("2026-01-01T00:15:00.000Z"); // NOT rewound to 00:05
  expect(repos.getAutomation("a1")!.lastStatus).toBe("ok");
});
```

(Match the `createAutomation` cron-trigger input shape to what the file's other cron tests use — check for a `timezone` field requirement.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/automation-dispatcher.test.ts -t "does not rewind next_run_at"`
Expected: FAIL — `nextRunAt` is `"2026-01-01T00:05:00.000Z"` (the finally-write rewound it).

- [ ] **Step 3: Implement (repositories.ts)**

Replace `setAutomationRun`:

```ts
  setAutomationRun(id: string, run: { lastRunAt: string|null; lastStatus: "ok"|"error"|"skipped"|"running"|null; lastError: string|null }): void {
    // Deliberately does NOT touch next_run_at — the Scheduler owns it (fireCron advances it BEFORE dispatch;
    // reconcile rewrites it on edit). Writing a fire-time snapshot back here rewound in-flight advances,
    // making long cron runs refire back-to-back forever and reverting mid-run schedule edits.
    this.db.prepare("UPDATE automations SET last_run_at=?, last_status=?, last_error=? WHERE id=?")
      .run(run.lastRunAt, run.lastStatus, run.lastError, id);
  }
```

- [ ] **Step 4: Implement (automation-dispatcher.ts)**

Remove `nextRunAt: a.nextRunAt` from all three call sites (skip record, running record, finally record). Example (finally):

```ts
      this.d.repos.setAutomationRun(a.id, { lastRunAt: nowIso, lastStatus: status, lastError: error });
```

- [ ] **Step 5: Fix remaining callers**

Run: `grep -rn "setAutomationRun" src test`
Update every remaining call site (e.g. `test/core/automation-dispatcher.test.ts`'s `resetRunningAutomations` test passes `nextRunAt: null` — drop the field). There must be NO caller left passing `nextRunAt`.

- [ ] **Step 6: Run tests + typecheck + commit**

```bash
npx vitest run test/core/automation-dispatcher.test.ts test/core/scheduler.test.ts test/persistence
npm run typecheck
git add -A src test
git commit -m "fix(core): automation run-records no longer clobber next_run_at (scheduler owns it) — stops back-to-back cron refires

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Slack — interaction post failure resolves the pending prompt (audit #4, HIGH)

`SlackInteractionBridge.prompt()` fires the card post with `void this.post(...)`. If `chat.postMessage` rejects (archived channel, invalid blocks, msg_too_long, network), the returned Promise never resolves: the master turn is wedged inside canUseTool forever, with no card anywhere.

**Files:**
- Modify: `src/slack/interaction.ts` (the `prompt` method + a new private `failPending`)
- Modify: `src/core/i18n.ts` (new key `interaction.postFailed` in BOTH ko and en catalogs)
- Test: `test/slack/interaction.test.ts`

**Interfaces:**
- Consumes: existing `PostBlocks` (already returns `Promise<unknown>`), existing `t(locale, key)`.
- Produces: on post failure — approve resolves `{ behavior: "allow" }` (the same pass-through as a down bridge, `makeSlackCanUseTool`'s documented default); ask resolves `{ behavior: "deny", message: t(locale, "interaction.postFailed") }` (an invented empty answer would be worse than telling the model the question could not be delivered). New i18n key `interaction.postFailed`.

- [ ] **Step 1: Add the i18n key**

In `src/core/i18n.ts`, add to the ko catalog (after `"interaction.cancelled"`):

```ts
  "interaction.postFailed": "Slack에 질문 카드를 게시하지 못했어요 — 사용자에게 물어볼 수 없습니다.",
```

and to the en catalog (same position):

```ts
  "interaction.postFailed": "Failed to post the question card to Slack — the user could not be asked.",
```

(This key is used only by the daemon-side Slack bridge — the renderer catalog is NOT involved; the byte-identical duplication rule applies only to `notice.*` codes.)

- [ ] **Step 2: Write the failing tests**

Add to `test/slack/interaction.test.ts` (reuse the file's existing `ThreadTarget` fixture shape `{ channel, threadTs, team }`):

```ts
describe("post failure (card never reached Slack)", () => {
  const target = { channel: "C1", threadTs: "111.222", team: "T1" };

  it("approve: a rejected post resolves pass-through allow instead of hanging the turn", async () => {
    const bridge = new SlackInteractionBridge(async () => { throw new Error("channel_not_found"); });
    const r = await bridge.prompt(target, "Bash", { command: "ls" }, { toolUseID: "TF1" });
    expect(r).toEqual({ behavior: "allow" });
    // pending entry cleaned up: a later (impossible) click is an ignored no-op, not a double-resolve
    expect(bridge.handleAction(JSON.stringify({ t: "TF1", d: "allow" }))).toBeUndefined();
  });

  it("ask: a rejected post resolves deny with a delivery-failure message (no invented empty answer)", async () => {
    const bridge = new SlackInteractionBridge(async () => { throw new Error("msg_too_long"); });
    const r = await bridge.prompt(target, "AskUserQuestion", { questions: [{ question: "Q?", options: [{ label: "A" }] }] }, { toolUseID: "TF2" });
    expect(r).toMatchObject({ behavior: "deny" });
    expect(bridge.handleAction(JSON.stringify({ t: "TF2", q: 0, a: "A" }))).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/slack/interaction.test.ts -t "post failure"`
Expected: FAIL — both tests time out (the prompt Promise never settles).

- [ ] **Step 4: Implement**

In `src/slack/interaction.ts`, replace the two `void this.post(...)` lines in `prompt()`:

```ts
        void this.post(target, { text: t(this.getLocale(), "slack.askQuestion"), blocks: this.askBlocks(id, questions) }).catch((err) => this.failPending(id, err));
```

```ts
      void this.post(target, { text: t(this.getLocale(), "slack.approveNeeded", { tool: toolName }), blocks: this.approveBlocks(id, toolName, input) }).catch((err) => this.failPending(id, err));
```

and add the private method (below `handleAction`):

```ts
  // The card never reached Slack (rejected post: archived channel, invalid blocks, msg_too_long, network) —
  // resolve NOW instead of wedging the master turn forever waiting for a click that can never come.
  // approve falls back to allow (the same pass-through makeSlackCanUseTool uses when the bridge is down);
  // ask denies with a delivery-failure reason (an invented empty answer would silently corrupt the turn).
  private failPending(id: string, err: unknown): void {
    const p = this.pending.get(id);
    if (!p) return; // already resolved (click raced the failure, or the turn aborted)
    this.pending.delete(id);
    process.stderr.write(`[rookery][slack] interaction post failed (${p.kind}): ${String(err)}\n`);
    if (p.kind === "approve") p.resolve({ behavior: "allow" });
    else p.resolve({ behavior: "deny", message: t(this.getLocale(), "interaction.postFailed") });
  }
```

- [ ] **Step 5: Run tests + typecheck + commit**

```bash
npx vitest run test/slack/interaction.test.ts test/core/i18n.test.ts
npm run typecheck
git add src/slack/interaction.ts src/core/i18n.ts test/slack/interaction.test.ts
git commit -m "fix(slack): a failed interaction card post resolves the prompt instead of blocking the master turn forever

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Slack — owner-scoped holder clearing (audit #5, HIGH)

A timed-out `startSlack` that resolves LATE gets `h.stop()`'d by the controller; that stop unconditionally nulls the shared `slackBridge`/`slackThreadReader`/`slackReporterEnsure` holders — which by then belong to the live retry connection. Status stays 'up' while every approval silently auto-allows.

**Files:**
- Create: `src/slack/holder.ts`
- Modify: `src/slack/handle-incoming.ts` (add `clearBridge`/`clearThreadReader`/`clearReporterFor` to `SlackDeps`, lines ~25-36)
- Modify: `src/slack/app.ts` (capture `threadReader`/`reporterFor` instances; owner-scoped release in `stop()`, lines ~174-206)
- Modify: `src/daemon/server.ts` (replace the three `let` holders with `makeHolder`, wire `clear*`, lines ~122-126, 131, 135, 206-209, 240)
- Test: `test/slack/holder.test.ts` (new)

**Interfaces:**
- Produces: `makeHolder<T>(): { set(v: T): void; clearIf(v: T): void; get(): T | null }` in `src/slack/holder.ts`.
- Produces (SlackDeps additions, all optional for back-compat with existing tests):
  - `clearBridge?: (b: SlackInteractionBridge) => void;`
  - `clearThreadReader?: (r: SlackThreadReader) => void;`
  - `clearReporterFor?: (fn: (sessionId: string, externalKey: string) => void) => void;`
- Consumes: `SlackInteractionBridge`, `SlackThreadReader` types already imported in `handle-incoming.ts`.

- [ ] **Step 1: Write the failing test**

Create `test/slack/holder.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeHolder } from "../../src/slack/holder.js";

describe("makeHolder (owner-scoped shared slot)", () => {
  it("set installs; clearIf with the current owner clears", () => {
    const h = makeHolder<{ tag: string }>();
    const a = { tag: "A" };
    expect(h.get()).toBeNull();
    h.set(a);
    expect(h.get()).toBe(a);
    h.clearIf(a);
    expect(h.get()).toBeNull();
  });

  it("a late stale-connection stop does not clobber the live connection's slot (regression: silent auto-allow)", () => {
    const h = makeHolder<{ tag: string }>();
    const a = { tag: "A" }, b = { tag: "B" };
    h.set(a); // connection A comes up
    h.set(b); // retry connection B replaces it
    h.clearIf(a); // A's app.start() resolved late; controller stops the stale handle
    expect(h.get()).toBe(b); // B's holder must survive
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/slack/holder.test.ts`
Expected: FAIL — module `src/slack/holder.js` does not exist.

- [ ] **Step 3: Create `src/slack/holder.ts`**

```ts
// A shared mutable slot with owner-scoped clearing: installing overwrites unconditionally, but clearing is a
// no-op unless the caller still owns the slot. Used for the Slack bridge/thread-reader/reporter holders in the
// daemon composition root — a late-stopping superseded connection must not null the holders a newer connection
// has re-installed (that silently auto-allowed every approval while slack.status showed 'up').
export interface Holder<T> {
  set(v: T): void;
  clearIf(v: T): void;
  get(): T | null;
}

export function makeHolder<T>(): Holder<T> {
  let cur: T | null = null;
  return {
    set: (v) => { cur = v; },
    clearIf: (v) => { if (cur === v) cur = null; },
    get: () => cur,
  };
}
```

Run: `npx vitest run test/slack/holder.test.ts` — Expected: PASS.

- [ ] **Step 4: Extend `SlackDeps`**

In `src/slack/handle-incoming.ts`, after the existing `setBridge`/`setThreadReader`/`setReporterFor` fields (~lines 31-36), add:

```ts
  // Owner-scoped release counterparts of the set* holders above: stop() passes ITS OWN instance, and the daemon
  // clears the holder only if it still points at that instance. Without this, a late stop() from a superseded
  // connection (start-timeout → retry succeeded → stale start resolves late) nulls the LIVE connection's holders.
  clearBridge?: (b: SlackInteractionBridge) => void;
  clearThreadReader?: (r: SlackThreadReader) => void;
  clearReporterFor?: (fn: (sessionId: string, externalKey: string) => void) => void;
```

(Match the exact existing type spellings for `SlackThreadReader` used by `setThreadReader` in that file.)

- [ ] **Step 5: Update `src/slack/app.ts`**

Capture the instances so `stop()` can pass them (lines ~174-178):

```ts
  // Register the thread-context reader (conversations.replies) on the daemon holder → used by the master's read_thread capability.
  const threadReader = makeSlackThreadReader(app.client as unknown as Parameters<typeof makeSlackThreadReader>[0]);
  deps.setThreadReader?.(threadReader);

  // Register reporter-ensure on the daemon holder → the dispatcher calls it right before firing, so that headless turns of a Slack session (wakeup, etc.)
  // also get a subscribed reporter delivering to the thread without a human message (prevents lost firings before the first message after restart/reconnect).
  const reporterFor = (sessionId: string, externalKey: string) =>
    ensureSlackReporter(registry, app.client as unknown as SlackClient, sessionId, externalKey, () => deps.slackConfig().locale);
  deps.setReporterFor?.(reporterFor);
```

and replace the first three lines of `stop` (lines ~197-199):

```ts
    stop: async () => {
      // Owner-scoped release: a late stop() from a superseded connection must not null holders a newer
      // connection re-installed. Fall back to unconditional set*(null) only when clear* isn't wired (tests).
      if (deps.clearBridge) deps.clearBridge(bridge); else deps.setBridge?.(null);
      if (deps.clearThreadReader) deps.clearThreadReader(threadReader); else deps.setThreadReader?.(null);
      if (deps.clearReporterFor) deps.clearReporterFor(reporterFor); else deps.setReporterFor?.(null);
      unsubWorkerRelay();
      void workerRelay.dispose();
      registry.disposeAll();
      await app.stop();
    },
```

- [ ] **Step 6: Update `src/daemon/server.ts`**

Replace the three `let` holders (lines ~122-126) with:

```ts
  // Slack holders (bridge / thread reader / reporter-ensure) — installed by startSlack on connect, released
  // owner-scoped on stop (clearIf) so a stale connection's late stop can't clobber the live one's holders.
  const bridgeHolder = makeHolder<SlackInteractionBridge>();
  const threadReaderHolder = makeHolder<SlackThreadReader>();
  const reporterHolder = makeHolder<(sessionId: string, externalKey: string) => void>();
```

Add the import: `import { makeHolder } from "../slack/holder.js";`

Update every use site:
- `makeCanUseTool: (externalKey, sessionId) => makeSlackCanUseTool(externalKey, () => bridgeHolder.get()) ?? interactionRegistry.canUseToolFor(sessionId),`
- `const slackCaps = makeSlackCapabilities(externalKey, () => threadReaderHolder.get());`
- dispatcher `beforeRun` (lines ~206-209):

```ts
    beforeRun: (a) => {
      const ensure = reporterHolder.get();
      if (a.action.kind !== "master" || !a.action.targetSessionId || !ensure) return;
      const row = repos.getSession(a.action.targetSessionId);
      if (row?.external_key) ensure(row.id, row.external_key);
    },
```

- the `startSlack` deps in the SlackController wiring (line ~240):

```ts
    start: () => startSlack({ sessions, bus, slackConfig, home: config.home,
      setBridge: (b) => { if (b) bridgeHolder.set(b); },
      clearBridge: (b) => bridgeHolder.clearIf(b),
      setThreadReader: (r) => { if (r) threadReaderHolder.set(r); },
      clearThreadReader: (r) => threadReaderHolder.clearIf(r),
      setReporterFor: (fn) => { if (fn) reporterHolder.set(fn); },
      clearReporterFor: (fn) => reporterHolder.clearIf(fn),
      resolveThread: (id) => parseSlackThreadKey(repos.getSession(id)?.external_key ?? null), onMessage: slackTrigger }),
```

- [ ] **Step 7: Run the slack + daemon suites + typecheck + commit**

```bash
npx vitest run test/slack test/daemon
npm run typecheck
git add src/slack/holder.ts src/slack/handle-incoming.ts src/slack/app.ts src/daemon/server.ts test/slack/holder.test.ts
git commit -m "fix(slack): owner-scoped holder release — a stale connection's late stop no longer silently auto-allows approvals

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Fleet — `restore()` TOCTOU gate (audit #6, HIGH)

`restore()` checks the running guard once, then awaits `git checkout` with no lock. A `send_worker`/`worker.send` arriving during that await starts a turn whose SDK edits interleave with the checkout — and the send's `onTurnStart` checkpoint snapshots the half-rewritten tree as a "restore point".

**Files:**
- Modify: `src/core/fleet-orchestrator.ts` (new `restoring` set; gate in `send()`; hold in `restore()`)
- Test: `test/core/fleet-orchestrator-checkpoints.test.ts` (has an existing `ckptFactory` fixture and a `restore() refuses while running` test at ~line 74 — mirror its setup)

**Interfaces:**
- Consumes: existing `GitOps.restoreCheckpoint(worktreePath, sha): Promise<void>` (`FakeGitOps` records calls; override it with a deferred for the test).
- Produces: `fleet.send(id, ...)` now throws `worker <id> is mid-restore; retry when the restore finishes` while a restore is in flight for that worker.

- [ ] **Step 1: Write the failing test**

Add to `test/core/fleet-orchestrator-checkpoints.test.ts`. The file already has `ckptFactory(behaviour)` (a minimal WorkerLike factory), `build(git, factory)` (repos + fleet with session `"sA"` and `idgen: () => "a0"`), a `tick()` helper, and a `GatedGit extends FakeGitOps` precedent (test 1b) — mirror that subclass pattern for `restoreCheckpoint`:

```ts
// TOCTOU gate: a send landing while git checkout is rewriting the worktree must be rejected, and allowed again after.
it("send() during an in-flight restore is rejected (TOCTOU gate)", async () => {
  let releaseRestore!: () => void;
  const restoreGate = new Promise<void>((r) => { releaseRestore = r; });
  class RestoreGatedGit extends FakeGitOps {
    async restoreCheckpoint(wt: string, sha: string): Promise<void> {
      await restoreGate;
      return super.restoreCheckpoint(wt, sha);
    }
  }
  const git = new RestoreGatedGit({ headValue: "base0", checkpointSha: "ck" });
  // idle so restore() passes the running guard; settle pending so the worker stays live.
  const factory = ckptFactory({ status: () => "idle", settle: () => new Promise<void>(() => {}) });
  const { fleet } = build(git, factory);
  const { id } = await fleet.spawn({ homeSessionId: "sA", repoPath: "/code", label: "x", task: "t" });
  await tick(); // let the spawn-time checkpoint (seq 0) persist

  const restoring = fleet.restore(id, 0); // enters git checkout and parks on restoreGate
  await Promise.resolve();
  expect(() => fleet.send(id, "new instruction")).toThrow(/mid-restore/);
  releaseRestore();
  await restoring;
  expect(() => fleet.send(id, "after restore")).not.toThrow(); // gate released after the checkout completes
});
```

(If `FakeGitOps.restoreCheckpoint`'s exact signature differs, match it — it is part of the `GitOps` interface in `src/core/git-ops.ts`; check there.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/fleet-orchestrator-checkpoints.test.ts -t "TOCTOU"`
Expected: FAIL — the mid-restore `fleet.send` does NOT throw.

- [ ] **Step 3: Implement**

In `src/core/fleet-orchestrator.ts`:

Add the field next to `ckptChains` (~line 85):

```ts
  // Workers with a checkpoint restore in flight — send() must not start a turn while git checkout is rewriting
  // the worktree (the running-guard in restore() is only valid at the tick it runs; this closes the TOCTOU).
  private readonly restoring = new Set<string>();
```

Gate `send()` (line ~373):

```ts
  send(id: string, message: string, clientMsgId?: string): void {
    // A restore is rewriting this worktree (git checkout). Starting a turn now would interleave SDK edits with
    // the checkout AND take a checkpoint of the half-rewritten tree. Reject; the caller retries after it ends.
    if (this.restoring.has(id)) throw new Error(`worker ${id} is mid-restore; retry when the restore finishes`);
    const entry = this.requireLive(id);
    if (entry.pendingLabel) {
      entry.pendingLabel = false;
      void this.relabel(id, entry.homeSessionId, message); // task-less worker: relabel from the first message (best-effort, never throws)
    }
    entry.agent.send(message, clientMsgId);
  }
```

Hold the gate in `restore()` (lines ~423-433):

```ts
  // restore the worktree's tracked files to that checkpoint (seq). Ignore a nonexistent seq.
  async restore(id: string, seq: number): Promise<void> {
    const e = this.entries.get(id);
    if (!e) throw new Error(`Unknown worker: ${id}`);
    // if running, the worker's SDK is concurrently editing the same worktree → restore collides and produces a half-overwritten state.
    if (e.agent && e.agent.status() === "running") {
      throw new Error(`worker ${id} is running; stop it or wait until idle before restoring`);
    }
    const ck = this.deps.repos.listCheckpoints(id).find((c) => c.seq === seq);
    if (!ck) throw new Error(`No checkpoint seq ${seq} for ${id}`);
    // Hold the send-gate for the whole checkout: the running-check above is a point-in-time check, and a send
    // landing during the await would start a turn against a half-rewritten worktree (TOCTOU).
    this.restoring.add(id);
    try {
      await this.deps.git.restoreCheckpoint(e.worktreePath, ck.sha);
    } finally {
      this.restoring.delete(id);
    }
  }
```

Both `send()`'s gate check and `restore()`'s guard+`restoring.add` run synchronously before any await, so the two directions can't interleave on the single JS thread.

- [ ] **Step 4: Run the fleet suites + typecheck + commit**

```bash
npx vitest run test/core/fleet-orchestrator-checkpoints.test.ts test/core/fleet-orchestrator.test.ts test/core/fleet-orchestrator-tier1.test.ts test/core/fleet-orchestrator-close.test.ts
npm run typecheck
git add src/core/fleet-orchestrator.ts test/core/fleet-orchestrator-checkpoints.test.ts
git commit -m "fix(core): gate worker sends during checkpoint restore (TOCTOU) — no turn starts mid-checkout

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: WorkerNotifier — boot sweep for stranded arms (audit #11, MEDIUM)

`fleet.rehydrate()` force-writes `idle`/`orphaned` straight to the DB with NO `worker.status` bus event, and nothing scans `notify_armed=1` rows at boot. An arm set before a restart can therefore never fire — the master waits forever.

**Files:**
- Modify: `src/core/worker-notifier.ts` (new `sweepSettled()` method)
- Modify: `src/daemon/server.ts` (hold the notifier instance; call `sweepSettled()` after `start()`; keep the unsubscribe fn for Task 10)
- Modify: `docs/architecture/fleet-lifecycle.md` (the notify section — add the boot-sweep sentence)
- Test: `test/core/worker-notifier.test.ts` (create if it does not exist — check first with `ls test/core/worker-notifier.test.ts`)

**Interfaces:**
- Consumes: `repos.listAllWorkers()` (already used by `rehydrate`; rows carry `id`/`status`), `repos.consumeWorkerNotifyArmed(id)` (atomic read+clear), existing private `buildLine`.
- Produces: `WorkerNotifier.sweepSettled(): void` — Task 10's shutdown story depends on this sweep existing.

- [ ] **Step 1: Write the failing test**

In `test/core/worker-notifier.test.ts` (create with these imports if absent):

```ts
import { describe, it, expect } from "vitest";
import { openDb } from "../../src/persistence/db.js";
import { Repositories } from "../../src/persistence/repositories.js";
import { EventBus } from "../../src/core/events.js";
import { WorkerNotifier } from "../../src/core/worker-notifier.js";

function h() {
  const repos = new Repositories(openDb(":memory:"));
  repos.createSession({ id: "s1", cwd: "/x" });
  repos.createWorker({ id: "w1", sessionId: "s1", repoPath: "/r", label: "w", worktreePath: "/wt/w1", branch: "b" });
  const delivered: Array<{ sessionId: string; line: string }> = [];
  const bus = new EventBus();
  const notifier = new WorkerNotifier({ bus, repos, deliver: (sessionId, line) => delivered.push({ sessionId, line }) });
  return { repos, bus, notifier, delivered };
}

describe("WorkerNotifier.sweepSettled (boot-time stranded arms)", () => {
  it("delivers an arm whose worker settled without a bus event (restart/rehydrate path)", () => {
    const { repos, notifier, delivered } = h();
    repos.setWorkerNotifyArmed("w1", true);
    repos.setWorkerStatus("w1", "stopped"); // settled directly in the DB — no worker.status event ever fired
    notifier.sweepSettled();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.sessionId).toBe("s1");
    expect(repos.getWorker("w1")!.notify_armed).toBe(0); // one-shot consumed
    notifier.sweepSettled();
    expect(delivered).toHaveLength(1); // idempotent
  });

  it("does not consume arms of workers still running", () => {
    const { repos, notifier, delivered } = h();
    repos.setWorkerNotifyArmed("w1", true); // status is still the initial non-settled one
    notifier.sweepSettled();
    expect(delivered).toHaveLength(0);
    expect(repos.getWorker("w1")!.notify_armed).toBe(1);
  });
});
```

Note: check what status `createWorker` writes initially (likely `provisioning`) — `provisioning` is not in `SETTLED`, so the second test holds. If the initial status IS settled in this repo, set it explicitly to `running` via `repos.setWorkerStatus("w1", "running")` first.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/worker-notifier.test.ts`
Expected: FAIL — `sweepSettled` is not a function.

- [ ] **Step 3: Implement**

In `src/core/worker-notifier.ts`, add after `start()`:

```ts
  // Boot-time sweep: rehydrate() force-writes idle/orphaned straight to the DB (no worker.status bus event),
  // so an arm set before a restart would otherwise never fire and the master would wait forever. Called once
  // after start() at boot; consumes arms of already-settled workers and delivers (a cold session gets a
  // pending_notifications row via SessionManager.deliverWorkerNotification and is drained on next build).
  sweepSettled(): void {
    for (const w of this.d.repos.listAllWorkers()) {
      if (!SETTLED.has(w.status)) continue;
      const arm = this.d.repos.consumeWorkerNotifyArmed(w.id);
      if (!arm || !arm.armed) continue;
      const line = this.buildLine(w.id, w.status);
      if (line) this.d.deliver(arm.sessionId, line);
    }
  }
```

- [ ] **Step 4: Wire in `src/daemon/server.ts`**

Replace line ~146 (`new WorkerNotifier({...}).start();`) with:

```ts
  // Worker completion → wake the home master (notify mode). deliver routes to the live master or persists for a cold one.
  const notifier = new WorkerNotifier({ bus, repos, deliver: (sessionId, line) => sessions.deliverWorkerNotification(sessionId, line) });
  const stopNotifier = notifier.start();
  notifier.sweepSettled(); // arms stranded by the restart (rehydrate writes statuses with no bus events)
```

(`stopNotifier` is intentionally unused until Task 10 wires it into `close()` — if the linter complains, add `void stopNotifier;` temporarily, or do Tasks 9+10 in one working session.)

- [ ] **Step 5: Update the doc**

In `docs/architecture/fleet-lifecycle.md`, find the notify/`pending_notifications` paragraph (grep `notify_armed`) and append one sentence:

```
At boot, `WorkerNotifier.sweepSettled()` consumes arms whose workers are already settled (rehydrate writes statuses directly to the DB without bus events), so an arm set before a restart is still delivered.
```

- [ ] **Step 6: Run tests + typecheck + commit**

```bash
npx vitest run test/core/worker-notifier.test.ts test/daemon/server.test.ts
npm run typecheck
git add src/core/worker-notifier.ts src/daemon/server.ts test/core/worker-notifier.test.ts docs/architecture/fleet-lifecycle.md
git commit -m "fix(core): boot sweep delivers notify arms stranded by a daemon restart

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Shutdown — park the notifier before `fleet.close` (audit #14, MEDIUM)

During shutdown, `fleet.close()` stops every live worker; each emits `worker.status 'stopped'` synchronously. The still-subscribed WorkerNotifier consumes the arms and launches ghost master turns (real SDK queries) that race `db.close()` — and the failed re-persist swallows the notification forever.

**Files:**
- Modify: `src/daemon/server.ts` (call `stopNotifier()` at the top of `close()`, before `await fleet.close(5000)`)
- Test: `test/core/worker-notifier.test.ts` (core-level: unsubscribed notifier preserves the arm; the sweep from Task 9 delivers it "after restart")

**Interfaces:**
- Consumes: `stopNotifier` (the unsubscribe fn from Task 9), `notifier.sweepSettled()` (Task 9).
- Produces: shutdown ordering contract — notifier parked → fleet stopped → arms stay `notify_armed=1` in the DB → next boot's `sweepSettled()` delivers them.

- [ ] **Step 1: Write the failing-by-inspection test (core-level contract)**

Add to `test/core/worker-notifier.test.ts`:

```ts
describe("shutdown parking (arm survives to the next boot)", () => {
  it("after unsubscribe, a settle event does not consume the arm; the boot sweep delivers it later", () => {
    const { repos, bus, notifier, delivered } = h();
    repos.setWorkerNotifyArmed("w1", true);
    const off = notifier.start();
    off(); // shutdown: park the notifier BEFORE the fleet stops workers
    repos.setWorkerStatus("w1", "stopped", true);
    bus.emit({ type: "worker.status", sessionId: "s1", workerId: "w1", status: "stopped" }); // what fleet.close's stops emit
    expect(delivered).toHaveLength(0); // no ghost delivery during shutdown
    expect(repos.getWorker("w1")!.notify_armed).toBe(1); // arm preserved in the DB
    notifier.sweepSettled(); // next boot
    expect(delivered).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/core/worker-notifier.test.ts -t "shutdown parking"`
Expected: PASS already at the core level (unsubscribe exists) — this test pins the contract. The real defect is the WIRING (server.ts never unsubscribes). Proceed to fix the wiring.

- [ ] **Step 3: Implement (server.ts)**

In the `close` function of `src/daemon/server.ts`, add before `await fleet.close(5000);`:

```ts
    // Park worker-notify BEFORE stopping the fleet: fleet.close's stop() synchronously emits worker.status
    // 'stopped' for every live worker, and a still-subscribed notifier would consume the arms and launch ghost
    // master turns during shutdown (racing db.close; the failed re-persist then loses the notification forever).
    // Parked, the arms stay notify_armed=1 in the DB and the next boot's sweepSettled() delivers them.
    stopNotifier();
    await fleet.close(5000);
```

- [ ] **Step 4: Run the daemon suite + typecheck + commit**

```bash
npx vitest run test/daemon/server.test.ts test/core/worker-notifier.test.ts
npm run typecheck
git add src/daemon/server.ts test/core/worker-notifier.test.ts
git commit -m "fix(daemon): park WorkerNotifier before fleet shutdown — no ghost turns, arms survive to the next boot

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: MasterAgent — re-drain stranded `pending_notifications` (audit #21, LOW)

When a notification flush turn fails, the lines are persisted to `pending_notifications` "for the next activation" — but the only drain point is `SessionManager.build`, which runs once per session per daemon lifetime. For a live session the retry never happens; newer notifications overtake the stranded ones (ordering inversion).

**Files:**
- Modify: `src/core/master-agent.ts` (new private `drainPersistedNotifications()`; prepend in the notify flush; re-deliver on `runTurn`)
- Modify: `docs/architecture/master-worker-turn.md` (the retry sentence — grep `pending_notifications`)
- Test: `test/core/master-agent.test.ts` (the file has `deps()`/`makeMaster()` fixtures — extend alongside)

**Interfaces:**
- Consumes: `repos.pendingNotifications(sessionId): Array<{ id: number; text: string }>`, `repos.deletePendingNotifications(sessionId)` (both exist; better-sqlite3 is synchronous so read+delete is atomic within a tick).
- Produces: behavior only — no API change. Stranded rows are drained (a) at the front of every notification flush (fixing ordering inversion), (b) after every user `runTurn` (user activity as a retry point).

- [ ] **Step 1: Write the failing tests**

Add to `test/core/master-agent.test.ts` (uses the existing `deps` fixture; note `deps()` creates the session row `s1`):

```ts
describe("stranded pending_notifications re-drain", () => {
  it("a failed flush is retried (older lines first) on the next worker notification", async () => {
    let call = 0;
    const prompts: string[] = [];
    const base = deps(fakeQuery([{ type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "s" }]));
    const wrapped = ((input: { prompt?: string }) => {
      call++;
      if (typeof input?.prompt === "string") prompts.push(input.prompt);
      if (call === 1) throw new Error("api down"); // first flush turn dies before streaming
      return base.queryFn(input as Parameters<typeof base.queryFn>[0]);
    }) as typeof base.queryFn;
    const master = new MasterAgent({ sessionId: "s1", cwd: "/x", sdkSessionId: null, deps: { ...base, queryFn: wrapped } });

    master.notifyWorker("worker A settled");
    await master.idle();
    expect(base.repos.pendingNotifications("s1").map((r) => r.text)).toEqual(["worker A settled"]); // persisted by the catch

    master.notifyWorker("worker B settled");
    await master.idle();
    const flush = prompts.find((p) => p.includes("worker B settled"))!;
    expect(flush).toContain("worker A settled"); // stranded line drained into the same flush
    expect(flush.indexOf("worker A settled")).toBeLessThan(flush.indexOf("worker B settled")); // older first
    expect(base.repos.pendingNotifications("s1")).toEqual([]); // rows consumed
  });

  it("user activity (runTurn) re-flushes stranded rows after the user turn", async () => {
    const prompts: string[] = [];
    const base = deps(fakeQuery([{ type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "s" }]));
    const wrapped = ((input: { prompt?: string }) => {
      if (typeof input?.prompt === "string") prompts.push(input.prompt);
      return base.queryFn(input as Parameters<typeof base.queryFn>[0]);
    }) as typeof base.queryFn;
    const master = new MasterAgent({ sessionId: "s1", cwd: "/x", sdkSessionId: null, deps: { ...base, queryFn: wrapped } });
    base.repos.addPendingNotification("s1", "worker A settled"); // stranded by a previous failed flush

    await master.runTurn("hello");
    await master.idle(); // let the chained notice flush run
    expect(prompts[0]).toBe("hello"); // user turn first — stranded lines must not delay the user's answer
    expect(prompts[1]).toContain("worker A settled"); // then the retry flush
    expect(base.repos.pendingNotifications("s1")).toEqual([]);
  });
});
```

Note on the fakeQuery script: `fakeQuery` returns a generator per call — if the shared script is single-use, build a fresh `fakeQuery([...])` inside `wrapped` per invocation instead of reusing `base.queryFn` (check `test/helpers/fake-query.ts`; the existing `makeMaster` helper in this file reuses `base.queryFn` across turns, so follow whatever it does).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/core/master-agent.test.ts -t "stranded"`
Expected: FAIL — test 1: the second flush prompt does NOT contain "worker A settled" (and rows remain); test 2: `prompts` has only "hello".

- [ ] **Step 3: Implement**

In `src/core/master-agent.ts`:

Add the private helper (near `notifyWorker`):

```ts
  // Drain stranded retry rows (a failed notification flush persisted its lines). build() drains them only once
  // per process, so a live session must re-drain on its own activity — otherwise a notify:true wake-up that
  // failed once is parked until the next daemon restart. Synchronous read+delete (better-sqlite3): no race.
  private drainPersistedNotifications(): string[] {
    const { repos } = this.opts.deps;
    const rows = repos.pendingNotifications(this.opts.sessionId);
    if (rows.length === 0) return [];
    repos.deletePendingNotifications(this.opts.sessionId);
    return rows.map((r) => r.text);
  }
```

In `notifyWorker`, change the flush closure's line collection (older stranded lines first — also fixes the ordering inversion):

```ts
      const lines = [...this.drainPersistedNotifications(), ...this.pendingNotifications.splice(0)];
```

In `runTurn`, re-deliver stranded rows AFTER queuing the user turn (so the user's answer is not delayed by a retry flush):

```ts
  async runTurn(userText: string, override?: TurnOverride): Promise<void> {
    const result = this.turnChain.then(() => this.doTurn(userText, override));
    this.turnChain = result.catch(() => {});
    // User activity is a natural retry point for stranded notification rows: re-inject them through
    // notifyWorker so they flush as one coalesced notice turn AFTER this user turn.
    for (const line of this.drainPersistedNotifications()) this.notifyWorker(line);
    return result;
  }
```

- [ ] **Step 4: Update the doc**

In `docs/architecture/master-worker-turn.md`, find the sentence about failed flush retry being "drained by SessionManager.build" (grep `pending_notifications`) and extend it:

```
Stranded rows are also re-drained in-process: every subsequent notification flush prepends them (older first), and every user runTurn re-injects them as a follow-up notice turn — a live session no longer needs a daemon restart to retry.
```

- [ ] **Step 5: Run tests + typecheck + commit**

```bash
npx vitest run test/core/master-agent.test.ts test/core/session-manager.test.ts
npm run typecheck
git add src/core/master-agent.ts test/core/master-agent.test.ts docs/architecture/master-worker-turn.md
git commit -m "fix(core): stranded worker notifications re-drain on the next flush or user turn, not only at daemon restart

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Full verification sweep

**Files:** none (verification only)

- [ ] **Step 1: Root suite**

Run: `npm test`
Expected: ALL PASS (0 failures).

- [ ] **Step 2: Root typecheck**

Run: `npm run typecheck`
Expected: exit 0, no errors.

- [ ] **Step 3: Desktop suite + typecheck**

Run: `npm -w apps/desktop test && npm -w apps/desktop run typecheck`
Expected: ALL PASS, exit 0.

- [ ] **Step 4: Root build (dist consumed by the desktop app)**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 5: Update the audit report status**

In `docs/2026-07-03-agent-loop-audit.md`, add one line under the header noting which findings are fixed:

```
> Status 2026-07-03: findings #1–#8, #11, #14, #21, #26 fixed on feat/dockable-panes (see docs/superpowers/plans/2026-07-03-agent-loop-audit-fixes.md). Note: #1=reload card wipe, #2=listen error, #3=next_run_at rewind, #4=slack post failure, #5=holder clobber, #6=restore TOCTOU, #7=abort resolved, #26=card dedup, #11/#14/#21=notify durability.
```

- [ ] **Step 6: Commit**

```bash
git add docs/2026-07-03-agent-loop-audit.md
git commit -m "docs: mark agent-loop audit fixes (high 6 + interaction/notify bundles) done

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
