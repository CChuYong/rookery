# Agent-Loop Follow-ups (Stale Cards, worker.send Visibility, #8, #9, #18) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two follow-ups from the 2026-07-03 final review (stale interaction cards after reconnect; silent desktop `worker.send` failures) and three open audit findings: #8 (session.delete races), #9 (maxTurns/effort lost on restart), #18 (Slack stopBolt strands pending approvals).

**Architecture:** Five independent surgical fixes at existing seams: renderer store/reducer reconciliation (retire cards the daemon no longer knows), a `dispose()` drain on the Slack interaction bridge, an ack + request() path for `worker.send`, a `close()` lifecycle on MasterAgent consumed by SessionManager.delete, and persistence of the worker's `max_turns`/`effort` through a new (append-only) migration. One task per fix, each with its own tests and commit.

**Tech Stack:** TypeScript (ESM NodeNext), vitest, better-sqlite3 (in-memory tests), fakeQuery SDK fake, React/Zustand renderer (jsdom vitest in `apps/desktop`).

## Global Constraints

- **Node 22 required.** Before ANY command: `nvm use 22` (better-sqlite3 ABI 127).
- **ESM NodeNext:** relative imports MUST end in `.js`; type-only imports MUST use `import type`.
- **Code comments in English.**
- **Migrations are append-only** — Task 5 APPENDS one new entry to the `MIGRATIONS` array in `src/persistence/db.ts`; NEVER modify existing entries. `test/persistence/db.test.ts` asserts applied version `=== MIGRATIONS.length` and keeps passing automatically.
- **Branch:** work directly on `feat/dockable-panes`. Do not create a new branch.
- **Typecheck separately:** root `npm run typecheck`; desktop `npm -w apps/desktop run typecheck`. vitest does not typecheck.
- **Renderer i18n invariant:** every new renderer string goes into BOTH `apps/desktop/src/renderer/i18n/locales/ko/<ns>.ts` and `en/<ns>.ts` with the same key set (parity + used-keys tests enforce this). Daemon-side strings go into BOTH ko and en catalogs of `src/core/i18n.ts`.
- **Commit trailer (repo convention):** end every commit message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Test commands:** root single file `npx vitest run test/<path>.test.ts`; desktop `npm -w apps/desktop test -- test/<file>.test.ts`.
- All paths relative to `/Users/clover/workspace/clovot`.

---

### Task 1: Renderer — retire interaction cards the daemon no longer knows (final-review follow-up #1)

Today, reconnect reconciliation only ever ADDS cards (daemon replays pending cards on every `events.subscribe`; the seed preserves unresolved cards). A card whose request died while this client was disconnected (abort, answered elsewhere, daemon restart) stays actionable-but-dead forever. Fix: track which requestIds the daemon has actually (re)announced since the last (re)connect; at seed time, fold preserved unresolved cards NOT in that set into an "expired" resolved state.

Ordering guarantee this relies on (document it in comments): the client sends `events.subscribe` FIRST in `onOpen` and requests `session.history` after it on the same socket; the daemon handles messages in order and replays all pending cards synchronously inside the `events.subscribe` handler, so every live card's `interaction.request` frame arrives BEFORE any subsequently-requested history result (TCP ordering).

**Files:**
- Modify: `apps/desktop/src/renderer/store/reduce.ts` (interaction `LogItem` gains `expired?: boolean`; `seedSessionLog` gains optional `liveCards` param)
- Modify: `apps/desktop/src/renderer/store/store.ts` (`liveInteractionIds` state + `resetLiveInteractions` action; `applyEvent` records ids; `seedHistory` passes the set)
- Modify: `apps/desktop/src/renderer/App.tsx` (call `resetLiveInteractions()` at the top of the ws `onOpen` handler, before `events.subscribe` is sent)
- Modify: `apps/desktop/src/renderer/components/InteractionCard.tsx` (resolved branch renders the expired label)
- Modify: `apps/desktop/src/renderer/i18n/locales/ko/interactionCard.ts` + `en/interactionCard.ts` (new key `interactionCard.expired`)
- Test: `apps/desktop/test/store-reduce.test.ts` (seed folding), `apps/desktop/test/store-pending.test.ts` or a new `apps/desktop/test/store-live-interactions.test.ts` (store-level set lifecycle)

**Interfaces:**
- Produces: `seedSessionLog(prev, sid, events, liveCards?: Set<string>)` — 4th param OPTIONAL; `undefined` keeps today's behavior exactly (existing tests untouched). Store state `liveInteractionIds: Set<string>`, actions `resetLiveInteractions(): void`. `LogItem` interaction variant gains `expired?: boolean`.
- Consumes: the existing `seedCore`/wrapper split in `reduce.ts` (the wrapper currently re-appends unresolved cards missing from the merge).

- [ ] **Step 1: Write the failing reducer tests**

Add inside the existing `describe("seedSessionLog (restore by replaying master events)")` in `apps/desktop/test/store-reduce.test.ts`:

```ts
it("a preserved unresolved card NOT re-announced by the daemon is folded to an expired summary", () => {
  const withCard = reduceEvent(emptyState(), { type: "interaction.request", sessionId: SID, requestId: "R9", kind: "approve", toolName: "t", inputText: "{}" } as never);
  const prev = withCard.logsBySession[SID];
  const turn = [{ payload: { type: "master.message", sessionId: SID, role: "user", content: "hi" } }];
  const log = seedSessionLog(prev, SID, turn, new Set()); // daemon replayed nothing → card is dead
  const card = log.find((i) => i.kind === "interaction");
  expect(card).toMatchObject({ requestId: "R9", resolved: true, expired: true });
});

it("a preserved unresolved card the daemon re-announced stays actionable", () => {
  const withCard = reduceEvent(emptyState(), { type: "interaction.request", sessionId: SID, requestId: "R9", kind: "approve", toolName: "t", inputText: "{}" } as never);
  const prev = withCard.logsBySession[SID];
  const turn = [{ payload: { type: "master.message", sessionId: SID, role: "user", content: "hi" } }];
  const log = seedSessionLog(prev, SID, turn, new Set(["R9"]));
  expect(log.at(-1)).toMatchObject({ kind: "interaction", requestId: "R9", resolved: false });
});

it("without a liveCards set (legacy callers), unresolved cards are preserved as before", () => {
  const withCard = reduceEvent(emptyState(), { type: "interaction.request", sessionId: SID, requestId: "R9", kind: "approve", toolName: "t", inputText: "{}" } as never);
  const prev = withCard.logsBySession[SID];
  const turn = [{ payload: { type: "master.message", sessionId: SID, role: "user", content: "hi" } }];
  const log = seedSessionLog(prev, SID, turn);
  expect(log.at(-1)).toMatchObject({ kind: "interaction", requestId: "R9", resolved: false });
});
```

- [ ] **Step 2: Run to verify the first fails**

Run: `npm -w apps/desktop test -- test/store-reduce.test.ts -t "expired"`
Expected: FAIL — card is `{resolved: false}` (fold not implemented; also `expired` doesn't exist yet).

- [ ] **Step 3: Implement the reducer part**

In `apps/desktop/src/renderer/store/reduce.ts`:

(a) Add `expired?: boolean` to the interaction LogItem variant:

```ts
  | { kind: "interaction"; requestId: string; mode: "approve" | "ask"; toolName?: string; inputText?: string; questions?: InteractionQuestion[]; resolved?: boolean; summary?: string; expired?: boolean }
```

(b) Replace the `seedSessionLog` wrapper (the function already computes via `seedCore` and re-appends dropped unresolved cards — keep `seedCore` untouched). Final form:

```ts
export function seedSessionLog(prev: LogItem[] | undefined, sid: string, events: Array<{ payload: unknown; createdAt?: string }>, liveCards?: Set<string>): LogItem[] {
  // interaction cards are live-only (never persisted to session_events), so the replay can never contain them.
  // Re-append unresolved cards from prev that the merge lost — but keep ACTIONABLE only the ones the daemon has
  // re-announced since the last (re)connect (liveCards). The daemon replays every pending card synchronously on
  // events.subscribe, and the client subscribes before requesting history on the same socket, so absence from
  // liveCards is authoritative: the request died while we were away (abort / answered elsewhere / daemon restart).
  // Those fold into an expired summary instead of staying actionable-but-dead forever. liveCards undefined =
  // legacy caller → preserve unconditionally (old behavior). The same authority applies to unresolved cards that
  // survived INSIDE the merged tail (preserved via the tail path rather than the re-append path).
  const merged = seedCore(prev, sid, events);
  const reconciled = liveCards
    ? merged.map((i) => (i.kind === "interaction" && !i.resolved && !liveCards.has(i.requestId) ? { ...i, resolved: true as const, expired: true } : i))
    : merged;
  const have = new Set(
    reconciled.filter((i): i is Extract<LogItem, { kind: "interaction" }> => i.kind === "interaction").map((i) => i.requestId),
  );
  const dropped = (prev ?? [])
    .filter((i): i is Extract<LogItem, { kind: "interaction" }> => i.kind === "interaction" && !i.resolved && !have.has(i.requestId))
    .map((i) => (liveCards && !liveCards.has(i.requestId) ? { ...i, resolved: true as const, expired: true } : i));
  return dropped.length ? [...reconciled, ...dropped] : reconciled;
}
```

- [ ] **Step 4: Run reducer tests**

Run: `npm -w apps/desktop test -- test/store-reduce.test.ts`
Expected: ALL PASS (legacy test passes because `liveCards` is undefined there).

- [ ] **Step 5: Wire the store**

In `apps/desktop/src/renderer/store/store.ts`:

(a) State field + action (in the store creator, alongside `pendingByWorker` etc.):

```ts
  // requestIds of interaction cards the daemon has announced since the last (re)connect. Reset in App's ws
  // onOpen BEFORE events.subscribe; the daemon's synchronous pending-card replay then repopulates it, so at
  // seed time "not in this set" means the daemon no longer holds that request (expired).
  liveInteractionIds: new Set<string>(),
  resetLiveInteractions: () => set(() => ({ liveInteractionIds: new Set<string>() })),
```

with the matching type entries in the store's interface:

```ts
  liveInteractionIds: Set<string>;
  resetLiveInteractions: () => void;
```

(b) In `applyEvent` (the existing wrapper around `reduceEvent`), record announced ids — extend it so an `interaction.request` also updates the set (keep the reduce call unchanged):

```ts
  applyEvent: (e) =>
    set((s) => ({
      ...(e.type === "interaction.request" ? { liveInteractionIds: new Set(s.liveInteractionIds).add(e.requestId) } : {}),
      ...reduceEventStatePatch(s, e),
    })),
```

NOTE: `applyEvent` today is `set((s) => reduceEvent(s, e, Date.now()))`-shaped — adapt to the file's actual form: compute `const next = reduceEvent(s, e, Date.now())` and merge the set patch into the returned object. Show the real existing body in your diff; do not invent a helper named `reduceEventStatePatch` if the file doesn't have one — inline it:

```ts
  applyEvent: (e) =>
    set((s) => {
      const patch = reduceEvent(s, e, Date.now());
      if (e.type === "interaction.request") return { ...patch, liveInteractionIds: new Set(s.liveInteractionIds).add(e.requestId) };
      return patch;
    }),
```

(c) `seedHistory` passes the set:

```ts
  seedHistory: (sid, events) => set((s) => ({ logsBySession: { ...s.logsBySession, [sid]: seedSessionLog(s.logsBySession[sid], sid, events, s.liveInteractionIds) } })),
```

- [ ] **Step 6: Write the failing store-level test**

Create `apps/desktop/test/store-live-interactions.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "../src/renderer/store/store.js";

const SID = "s1";
const card = (rid: string) => ({ type: "interaction.request", sessionId: SID, requestId: rid, kind: "approve", toolName: "t", inputText: "{}" }) as never;
const turn = [{ seq: 0, type: "master.message", payload: { type: "master.message", sessionId: SID, role: "user", content: "hi" } }];

describe("liveInteractionIds reconnect reconciliation", () => {
  beforeEach(() => {
    useStore.setState({ logsBySession: {}, liveInteractionIds: new Set<string>() });
  });

  it("daemon restart: card announced before the reset is expired by the seed", () => {
    useStore.getState().applyEvent(card("R1")); // card arrives live
    useStore.getState().resetLiveInteractions(); // ws reconnect to a fresh daemon — nothing replayed
    useStore.getState().seedHistory(SID, turn);
    const item = useStore.getState().logsBySession[SID]!.find((i) => i.kind === "interaction");
    expect(item).toMatchObject({ requestId: "R1", resolved: true, expired: true });
  });

  it("normal reconnect: replayed card is re-announced and stays actionable through the seed", () => {
    useStore.getState().applyEvent(card("R1"));
    useStore.getState().resetLiveInteractions();
    useStore.getState().applyEvent(card("R1")); // the daemon's events.subscribe replay (deduped by the reducer)
    useStore.getState().seedHistory(SID, turn);
    const item = useStore.getState().logsBySession[SID]!.find((i) => i.kind === "interaction");
    expect(item).toMatchObject({ requestId: "R1", resolved: false });
  });
});
```

(Check how other store tests reset state — mirror `store-pending.test.ts`'s pattern if it differs from `useStore.setState`.)

- [ ] **Step 7: Wire App + card UI + i18n**

(a) `apps/desktop/src/renderer/App.tsx` — first line inside the `c.onOpen(() => { ... })` callback (line ~415), BEFORE `c.send({ type: "events.subscribe" })`:

```ts
      useStore.getState().resetLiveInteractions(); // must precede events.subscribe: the replay repopulates the set
```

(b) `apps/desktop/src/renderer/components/InteractionCard.tsx` — resolved branch:

```tsx
  if (item.resolved) {
    return (
      <div className="max-w-[80%] self-start whitespace-pre-wrap rounded-[var(--radius)] border border-line bg-surface px-3 py-2 text-[12px] text-fg-dim">
        {item.summary ?? (item.expired ? t("interactionCard.expired") : "✅")}
      </div>
    );
  }
```

(c) i18n — `apps/desktop/src/renderer/i18n/locales/ko/interactionCard.ts` add:

```ts
  "interactionCard.expired": "만료됨 — 데몬에 더 이상 대기 중인 요청이 없어요",
```

`en/interactionCard.ts` add:

```ts
  "interactionCard.expired": "Expired — the daemon is no longer waiting on this request",
```

- [ ] **Step 8: Run the desktop suites + typecheck**

Run: `npm -w apps/desktop test && npm -w apps/desktop run typecheck`
Expected: ALL PASS (i18n parity + used-keys tests confirm the new key).

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/renderer apps/desktop/test
git commit -m "fix(desktop): expire interaction cards the daemon no longer holds after reconnect

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Slack — bridge.dispose() drains pending approvals on stop (audit #18)

`SlackHandle.stop()` (reconcile/toggle-off/shutdown) discards the bridge while `prompt()` promises are still pending — the master turn stays wedged and the old card's buttons are dead. Fix: a `dispose()` that resolves every pending prompt with deny, called from `stop()`.

**Files:**
- Modify: `src/slack/interaction.ts` (new `dispose()` on `SlackInteractionBridge`)
- Modify: `src/core/i18n.ts` (new key `interaction.expired` in BOTH ko and en — the deny message)
- Modify: `src/slack/app.ts` (`stop()` calls `bridge.dispose()` before releasing holders)
- Test: `test/slack/interaction.test.ts`, `test/core/i18n.test.ts` (parity runs automatically)

**Interfaces:**
- Produces: `SlackInteractionBridge.dispose(): void` — resolves all pending with `{ behavior: "deny", message: t(locale, "interaction.expired") }`, clears the map. Daemon i18n key `interaction.expired`.
- Consumes: the existing `pending` map and `getLocale`.

- [ ] **Step 1: Add the i18n key**

`src/core/i18n.ts` ko catalog (after `interaction.postFailed`):

```ts
  "interaction.expired": "만료됨 — 이 요청은 더 이상 대기 중이 아니에요.",
```

en catalog (same position):

```ts
  "interaction.expired": "Expired — this request is no longer pending.",
```

- [ ] **Step 2: Write the failing tests**

Add to `test/slack/interaction.test.ts`:

```ts
describe("dispose (bridge discarded with prompts pending — reconcile/toggle-off/shutdown)", () => {
  const target = { channel: "C1", threadTs: "111.222", team: "T1" };

  it("resolves every pending prompt with deny so the master turn is not wedged", async () => {
    const bridge = new SlackInteractionBridge(async () => ({}));
    const p1 = bridge.prompt(target, "Bash", { command: "ls" }, { toolUseID: "D1" });
    const p2 = bridge.prompt(target, "AskUserQuestion", { questions: [{ question: "Q?", options: [{ label: "A" }] }] }, { toolUseID: "D2" });
    bridge.dispose();
    await expect(p1).resolves.toMatchObject({ behavior: "deny" });
    await expect(p2).resolves.toMatchObject({ behavior: "deny" });
    // late clicks on the old cards are ignored no-ops, not double-resolves
    expect(bridge.handleAction(JSON.stringify({ t: "D1", d: "allow" }))).toBeUndefined();
    expect(bridge.handleAction(JSON.stringify({ t: "D2", q: 0, a: "A" }))).toBeUndefined();
  });

  it("dispose is idempotent and safe on an empty bridge", () => {
    const bridge = new SlackInteractionBridge(async () => ({}));
    expect(() => { bridge.dispose(); bridge.dispose(); }).not.toThrow();
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run test/slack/interaction.test.ts -t "dispose"`
Expected: FAIL — `dispose` is not a function.

- [ ] **Step 4: Implement**

In `src/slack/interaction.ts`, add below `failPending`:

```ts
  // The bridge is being discarded (token-swap reconcile, toggle-off, shutdown) while prompts are pending.
  // Resolve them all with deny NOW: the old cards' buttons route to a NEW bridge (or nothing) after this,
  // so these promises could otherwise never resolve and the master turn would stay wedged in canUseTool.
  dispose(): void {
    for (const [id, p] of this.pending) {
      process.stderr.write(`[rookery][slack] interaction ${id} (${p.kind}) expired: bridge disposed before an answer\n`);
      p.resolve({ behavior: "deny", message: t(this.getLocale(), "interaction.expired") });
    }
    this.pending.clear();
  }
```

In `src/slack/app.ts` `stop()`, add as the FIRST line (before the holder releases):

```ts
      bridge.dispose(); // resolve pending approval prompts with deny — a discarded bridge can never be answered
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run test/slack/interaction.test.ts test/core/i18n.test.ts test/slack/controller.test.ts && npm run typecheck`
Expected: ALL PASS.

- [ ] **Step 6: Commit**

```bash
git add src/slack/interaction.ts src/slack/app.ts src/core/i18n.ts test/slack/interaction.test.ts
git commit -m "fix(slack): dispose drains pending approvals with deny when the bridge is discarded (audit #18)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: worker.send ack — failures become visible on the desktop (final-review follow-up #2)

The desktop sends `worker.send` fire-and-forget with no reqId; the daemon's error+reqId reply can't route and the user's message silently vanishes (e.g. the new mid-restore rejection). Fix: daemon acks `worker.send` when a reqId is present; the desktop uses `request()` and, on rejection, rolls back the optimistic pending bubble and shows a toast.

Behavior tradeoff (intentional, note in the commit): with `request()`, a send while the WS is disconnected now fails fast with a visible toast instead of silently buffering in the outbox — visible failure replaces silent-maybe-delivery.

**Files:**
- Modify: `src/daemon/connection.ts` (the `worker.send` case replies `fleet.ack` when reqId present)
- Modify: `src/protocol/messages.ts` (add `"worker.send"` to `RequestResultMap`; update the fire-and-forget comment)
- Modify: `apps/desktop/src/renderer/store/store.ts` (`dropWorkerPending` action)
- Modify: `apps/desktop/src/renderer/App.tsx` (`sendToWorker` uses `request()` + rollback + toast, line ~550)
- Modify: `apps/desktop/src/renderer/i18n/locales/ko/toast.ts` + `en/toast.ts` (new key `toast.sendFailed`)
- Test: `test/daemon/connection.test.ts`, `apps/desktop/test/store-pending.test.ts`

**Interfaces:**
- Produces: daemon reply `{ type: "fleet.ack", reqId, action: "send", id }` on successful `worker.send` with reqId; store action `dropWorkerPending(id: string, clientMsgId: string): void`.
- Consumes: existing `fleet.ack` server message; `pushWorkerPending`; `toast.error`.

- [ ] **Step 1: Write the failing daemon test**

Add to `test/daemon/connection.test.ts` (mirror the file's existing fixture for building a `Connection` with a fake socket and a fleet — read its helpers first; the fleet fake needs a `send` method):

```ts
it("worker.send with a reqId is acked on success (so the desktop can await it)", async () => {
  // use the file's existing setup helper; ensure the fleet fake's send() does not throw
  await conn.handleRaw(JSON.stringify({ type: "worker.send", id: "w1", text: "hi", clientMsgId: "c1", reqId: "q1" }));
  const acks = sent.map((s) => JSON.parse(s)).filter((m) => m.type === "fleet.ack");
  expect(acks).toContainEqual(expect.objectContaining({ reqId: "q1", action: "send", id: "w1" }));
});
```

(Adapt `conn`/`sent` to the file's actual fixture names. The failure path — fleet.send throwing → error+reqId — is already covered by the outer catch; add an assertion for it only if the file lacks one.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/daemon/connection.test.ts -t "worker.send with a reqId"`
Expected: FAIL — no fleet.ack frame.

- [ ] **Step 3: Implement daemon + protocol**

`src/daemon/connection.ts` `worker.send` case:

```ts
      case "worker.send": {
        // Deliver a follow-up message to a running worker (streaming input). Throws if the agent is terminated/unknown
        // or mid-restore, and the outer try/catch responds with error+reqId. On success, ack when a reqId is present so
        // request()-style clients (desktop) get a settled promise instead of a silently-dropped frame.
        this.fleet.send(msg.id, msg.text, msg.clientMsgId);
        if (msg.reqId) this.reply({ type: "fleet.ack", reqId: msg.reqId, action: "send", id: msg.id });
        return;
      }
```

`src/protocol/messages.ts`: add to `RequestResultMap` (near the other worker entries):

```ts
  "worker.send": Extract<ServerMessage, { type: "fleet.ack" }>;
```

and update the comment at ~line 192 that lists `worker.send` as fire-and-forget (remove it from that list; it now has an ack).

- [ ] **Step 4: Implement store + App + i18n**

`apps/desktop/src/renderer/store/store.ts` — action next to `pushWorkerPending` (add its type to the store interface too: `dropWorkerPending: (id: string, clientMsgId: string) => void;`):

```ts
  // Roll back an optimistic worker bubble whose send was rejected (mid-restore, terminated worker, disconnected).
  dropWorkerPending: (id, clientMsgId) => set((s) => ({ pendingByWorker: { ...s.pendingByWorker, [id]: (s.pendingByWorker[id] ?? []).filter((p) => p.clientMsgId !== clientMsgId) } })),
```

`apps/desktop/src/renderer/App.tsx` `sendToWorker` (~line 550):

```ts
    const clientMsgId = crypto.randomUUID();
    // Show a queued bubble immediately → after the worker finishes its current turn (boundary echo) it switches to committed and settles into place.
    useStore.getState().pushWorkerPending(id, { clientMsgId, text });
    // request(): a rejected send (mid-restore, terminated worker, disconnected) rolls the bubble back and surfaces a toast —
    // fire-and-forget used to drop the daemon's error frame (no reqId) and the message silently vanished.
    void client?.request({ type: "worker.send", id, text, clientMsgId }).catch((e) => {
      useStore.getState().dropWorkerPending(id, clientMsgId);
      toast.error(tRef.current("toast.sendFailed"), String(e));
    });
```

i18n `ko/toast.ts`:

```ts
  "toast.sendFailed": "메시지 전송 실패",
```

`en/toast.ts`:

```ts
  "toast.sendFailed": "Failed to send message",
```

- [ ] **Step 5: Write the failing store test**

Add to `apps/desktop/test/store-pending.test.ts` (mirror its existing pendingByWorker tests):

```ts
it("dropWorkerPending removes exactly the rolled-back bubble", () => {
  useStore.getState().pushWorkerPending("w1", { clientMsgId: "c1", text: "a" });
  useStore.getState().pushWorkerPending("w1", { clientMsgId: "c2", text: "b" });
  useStore.getState().dropWorkerPending("w1", "c1");
  expect(useStore.getState().pendingByWorker["w1"]).toEqual([{ clientMsgId: "c2", text: "b" }]);
});
```

- [ ] **Step 6: Run all covering tests + typechecks**

Run: `npx vitest run test/daemon/connection.test.ts && npm run typecheck && npm -w apps/desktop test -- test/store-pending.test.ts && npm -w apps/desktop test && npm -w apps/desktop run typecheck`
Expected: ALL PASS (full desktop suite verifies i18n parity for the new toast key).

- [ ] **Step 7: Commit**

```bash
git add src/daemon/connection.ts src/protocol/messages.ts apps/desktop/src/renderer test/daemon/connection.test.ts apps/desktop/test/store-pending.test.ts
git commit -m "fix(desktop,daemon): worker.send is acked and failures roll back the bubble with a toast

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: MasterAgent.close() + ordered SessionManager.delete (audit #8, MEDIUM)

`SessionManager.delete()` today: awaits `master.stop()` (abort only — not the drain), tears down workers (whose settle can consume a notify arm and launch a REAL SDK ghost turn because the session is still in the live map), removes the session from the map LAST, then cascades the DB row — after which the aborted turn's drain and any QUEUED turn FK-throw. Fix: a `close()` lifecycle on MasterAgent (cancel queued turns, ignore new notifications, drain) and map-removal-first ordering in delete().

**Files:**
- Modify: `src/core/master-agent.ts` (`closing` flag; `close()`; guards in `doTurn` and `notifyWorker`)
- Modify: `src/core/session-manager.ts` (`delete()` reordered)
- Test: `test/core/master-agent.test.ts`, `test/core/session-manager.test.ts`

**Interfaces:**
- Produces: `MasterAgent.close(): Promise<void>` — sets `closing`, aborts the in-flight turn, then awaits `idle()` (the full chain drain). After `close()`: queued `runTurn`s reject with `Error("session closed")` WITHOUT touching the DB or the SDK; `notifyWorker()` is a no-op.
- Consumes: existing `stop()`/`idle()`/`turnChain`.

- [ ] **Step 1: Write the failing master-agent tests**

Add to `test/core/master-agent.test.ts` (uses the file's `deps(queryFn)` fixture; build gated queryFns like the notify tests do):

```ts
describe("close() (session deletion lifecycle)", () => {
  it("cancels queued turns without touching the SDK and drains the in-flight one", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const base = deps(fakeQuery([{ type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "s" }]));
    const wrapped = (async function* (input: unknown) {
      calls++;
      await gate; // hold the first turn in flight
      yield* base.queryFn(input as never) as never;
    }) as unknown as typeof base.queryFn;
    // NOTE: adapt the wrapper to how this file's other gated tests wrap queryFn — the SDK fake is called as a
    // function returning an async iterable, not necessarily a generator; mirror the existing gated-turn pattern.
    const master = new MasterAgent({ sessionId: "s1", cwd: "/x", sdkSessionId: null, deps: { ...base, queryFn: wrapped } });

    const turnA = master.runTurn("first");
    const turnB = master.runTurn("second"); // queued behind A
    const closing = master.close();
    release();
    await expect(turnB).rejects.toThrow(/session closed/);
    await closing;
    await turnA; // the aborted/drained in-flight turn resolves (stop() treats user aborts as non-failures)
    expect(calls).toBe(1); // the queued turn never reached the SDK
  });

  it("notifyWorker after close() is a no-op (no ghost turn, nothing persisted)", async () => {
    const prompts: string[] = [];
    const base = deps(fakeQuery([{ type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "s" }]));
    const wrapped = ((input: { prompt?: string }) => {
      if (typeof input?.prompt === "string") prompts.push(input.prompt);
      return base.queryFn(input as Parameters<typeof base.queryFn>[0]);
    }) as typeof base.queryFn;
    const master = new MasterAgent({ sessionId: "s1", cwd: "/x", sdkSessionId: null, deps: { ...base, queryFn: wrapped } });
    await master.close();
    master.notifyWorker("worker w settled");
    await master.idle();
    expect(prompts).toEqual([]);
    expect(base.repos.pendingNotifications("s1")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/core/master-agent.test.ts -t "close()"`
Expected: FAIL — `close` is not a function.

- [ ] **Step 3: Implement MasterAgent**

In `src/core/master-agent.ts`:

(a) Field (next to `currentAbort`):

```ts
  // Session teardown in progress (SessionManager.delete). Queued turns must not start (their DB writes would
  // race the row cascade → FK violations) and new worker notifications must not chain ghost SDK turns.
  private closing = false;
```

(b) Method (below `stop()`):

```ts
  // Deletion lifecycle: abort the in-flight turn, cancel everything queued, drain the chain's DB writes.
  // After this resolves it is safe to cascade-delete the session row.
  async close(): Promise<void> {
    this.closing = true;
    await this.stop();
    await this.idle(); // queued turns reject fast via the closing guard; the aborted turn finishes its drain
  }
```

(c) Guard at the very top of `doTurn` (FIRST statement, before any destructuring/DB write):

```ts
    if (this.closing) throw new Error("session closed");
```

(d) Guard at the very top of `notifyWorker`:

```ts
    if (this.closing) return; // session being deleted — a wake-up now would ghost-turn into a cascading row
```

- [ ] **Step 4: Reorder SessionManager.delete**

In `src/core/session-manager.ts` replace `delete()`:

```ts
  // Permanently delete a session. ORDER IS LOAD-BEARING (audit #8):
  // 1) remove from the live map FIRST — so a worker settling during teardown can't route a notify into this
  //    master (deliverWorkerNotification falls through to a pending row, which the cascade below sweeps), and
  //    no new turn can attach;
  // 2) close() the master — aborts the in-flight turn, cancels queued turns, and DRAINS the chain's DB writes
  //    while the row still exists (the old stop()-only path let the drain race the cascade → FK violations);
  // 3) clean up this session's workers (abort + remove worktree/branch/checkpoint refs + DB rows);
  // 4) cascade-delete the row.
  async delete(id: string): Promise<void> {
    const live = this.sessions.get(id);
    this.sessions.delete(id);
    await live?.master.close().catch(() => {});
    for (const w of this.deps.repos.listWorkers(id)) {
      try { await this.deps.fleet.delete(w.id); } catch { /* best-effort — remaining rows are cleaned up by the cascade below */ }
    }
    this.deps.repos.deleteSession(id);
  }
```

- [ ] **Step 5: Write the failing session-manager test**

Add to `test/core/session-manager.test.ts` (mirror its fixture — it builds a SessionManager with fakeQuery and an in-memory repos; check how it fakes the fleet):

```ts
it("delete() with an armed worker settling mid-teardown does not launch a ghost turn (audit #8)", async () => {
  // fleet fake whose delete() emits the settle the real Worker.stop() produces synchronously
  const prompts: string[] = [];
  // build manager with a queryFn wrapper capturing prompts (mirror the file's existing capture pattern)
  const session = manager.create("/x");
  repos.createWorker({ id: "w1", sessionId: session.id, repoPath: "/r", label: "w", worktreePath: "/wt/w1", branch: "b" });
  repos.setWorkerNotifyArmed("w1", true);
  // notifier wired as in production: settle → consumeArmed → manager.deliverWorkerNotification
  const fleetFake = {
    delete: async (id: string) => {
      repos.setWorkerStatus(id, "stopped", true);
      const arm = repos.consumeWorkerNotifyArmed(id);
      if (arm?.armed) manager.deliverWorkerNotification(session.id, "worker w settled");
    },
  };
  // inject fleetFake per the fixture's deps shape
  await manager.delete(session.id);
  expect(prompts).toEqual([]); // no SDK turn was launched during deletion
  expect(repos.getSession(session.id)).toBeUndefined(); // row cascaded cleanly, no FK throw
});
```

(Adapt injection to the file's actual fixture: the fleet is a constructor dep of SessionManager. If the existing fixture hard-codes a fleet, build a dedicated manager instance for this test.)

- [ ] **Step 6: Run all covering tests + typecheck**

Run: `npx vitest run test/core/master-agent.test.ts test/core/session-manager.test.ts test/daemon/connection.test.ts && npm run typecheck`
Expected: ALL PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/master-agent.ts src/core/session-manager.ts test/core/master-agent.test.ts test/core/session-manager.test.ts
git commit -m "fix(core): session delete closes the master first — no ghost turns, queued turns cancelled, drain before cascade (audit #8)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Persist worker maxTurns/effort across restart and fork (audit #9, MEDIUM)

`max_turns` is the ONLY unattended runaway guard and `effort` a spawn override — both live only as in-memory spawn args, so a lazy resume (rehydrate→materialize) or fork silently drops them. Persist both on the workers row (new append-only migration), restore through rehydrate/materialize, copy on fork.

**Files:**
- Modify: `src/persistence/db.ts` (APPEND one migration — never touch existing entries)
- Modify: `src/persistence/repositories.ts` (`WorkerRow` fields + `setWorkerMaxTurns`/`setWorkerEffort`)
- Modify: `src/core/fleet-orchestrator.ts` (`Entry` fields; persist in `run()`; restore in `rehydrate()`; pass in `materialize()`; copy in `fork()`)
- Modify: `docs/reference/data-model.md` (workers table: two new columns)
- Test: `test/persistence/repositories.test.ts`, `test/core/fleet-orchestrator-tier1.test.ts` (or the main fleet test file — put it wherever rehydrate/materialize are already tested; grep `rehydrate` in test/core)

**Interfaces:**
- Produces: migration adding nullable `max_turns INTEGER` and `effort TEXT` to `workers`; `WorkerRow.max_turns: number | null`, `WorkerRow.effort: string | null`; `Repositories.setWorkerMaxTurns(id: string, maxTurns: number): void`; `Repositories.setWorkerEffort(id: string, effort: string): void`.
- Consumes: `WorkerFactory` opts already accept `maxTurns?: number; effort?: string` (server.ts's subFactory forwards them — no server change needed).

- [ ] **Step 1: Write the failing repositories test**

Add to `test/persistence/repositories.test.ts`:

```ts
it("persists worker max_turns and effort (restart budget guard, audit #9)", () => {
  const repos = new Repositories(openDb(":memory:"), () => "t");
  repos.createSession({ id: "s1", cwd: "/x" });
  repos.createWorker({ id: "w1", sessionId: "s1", repoPath: "/r", label: "w" });
  expect(repos.getWorker("w1")!.max_turns).toBeNull();
  expect(repos.getWorker("w1")!.effort).toBeNull();
  repos.setWorkerMaxTurns("w1", 10);
  repos.setWorkerEffort("w1", "low");
  expect(repos.getWorker("w1")!.max_turns).toBe(10);
  expect(repos.getWorker("w1")!.effort).toBe("low");
});
```

(Match the file's existing fixture style for constructing Repositories/sessions.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/persistence/repositories.test.ts -t "max_turns"`
Expected: FAIL — `setWorkerMaxTurns` is not a function (and the columns don't exist).

- [ ] **Step 3: Implement migration + repositories**

`src/persistence/db.ts` — APPEND to the `MIGRATIONS` array (after the last existing entry, before `];`):

```ts
  (db) => {
    // Worker budget survives restart (audit #9): max_turns is the only unattended runaway guard and effort a
    // spawn-time override — both were in-memory-only, so a lazy resume (rehydrate→materialize) or a fork
    // silently ran uncapped at the global default effort. Nullable: NULL = unlimited / global default.
    db.exec("ALTER TABLE workers ADD COLUMN max_turns INTEGER");
    db.exec("ALTER TABLE workers ADD COLUMN effort TEXT");
  },
```

`src/persistence/repositories.ts`:

(a) `WorkerRow` gains (next to `permission_mode`):

```ts
  max_turns: number | null; // per-result turn cap (the unattended runaway guard). NULL = unlimited.
  effort: string | null; // spawn-time effort override. NULL = global default.
```

(b) Setters next to `setWorkerModel` (same style):

```ts
  setWorkerMaxTurns(id: string, maxTurns: number): void {
    this.db.prepare("UPDATE workers SET max_turns = ?, updated_at = ? WHERE id = ?").run(maxTurns, this.now(), id);
  }

  setWorkerEffort(id: string, effort: string): void {
    this.db.prepare("UPDATE workers SET effort = ?, updated_at = ? WHERE id = ?").run(effort, this.now(), id);
  }
```

- [ ] **Step 4: Run repositories + db tests**

Run: `npx vitest run test/persistence`
Expected: ALL PASS (db.test's `version === MIGRATIONS.length` invariant holds automatically).

- [ ] **Step 5: Write the failing orchestrator test**

Add to the fleet test file that already covers rehydrate (grep `rehydrate(` under test/core; use its fixture conventions — capturing factory + in-memory repos):

```ts
it("maxTurns/effort survive a restart: rehydrate→materialize passes them to the factory (audit #9)", async () => {
  const repos = new Repositories(openDb(":memory:"));
  repos.createSession({ id: "sA", cwd: "/x" });
  const bus = new EventBus();
  const seen: Array<{ maxTurns?: number; effort?: string }> = [];
  const factory = (o: { maxTurns?: number; effort?: string }): WorkerLike => {
    seen.push({ maxTurns: o.maxTurns, effort: o.effort });
    return { start: () => {}, resume: () => {}, send: () => {}, stop: async () => {}, status: () => "idle", waitUntilSettled: () => new Promise<void>(() => {}) };
  };
  const exists = () => true;
  const fleet1 = new FleetOrchestrator({ repos, bus, git: new FakeGitOps({ headValue: "b", checkpointSha: "ck" }), factory, worktreesDir: "/wt", idgen: () => "a0", exists });
  await fleet1.spawn({ homeSessionId: "sA", repoPath: "/code", label: "x", task: "t", maxTurns: 10, effort: "low" });
  expect(seen[0]).toEqual({ maxTurns: 10, effort: "low" }); // persisted AND passed at spawn
  repos.setWorkerSdkSessionId("a0", "sdk-1"); // make it resumable

  // "restart": a fresh orchestrator over the same DB
  const fleet2 = new FleetOrchestrator({ repos, bus, git: new FakeGitOps({ headValue: "b", checkpointSha: "ck" }), factory, worktreesDir: "/wt", idgen: () => "a1", exists });
  fleet2.rehydrate();
  fleet2.send("a0", "continue"); // lazy materialize
  expect(seen[1]).toEqual({ maxTurns: 10, effort: "low" }); // restored from the row, not dropped
});
```

(If the fixture file has helpers like `build()`/`ckptFactory`, reuse them instead — the assertions are what matter: factory receives `{maxTurns: 10, effort: "low"}` both at spawn and after rehydrate+send.)

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run` on the chosen fleet test file with `-t "survive a restart"`.
Expected: FAIL — `seen[1]` is `{ maxTurns: undefined, effort: undefined }`.

- [ ] **Step 7: Implement the orchestrator**

`src/core/fleet-orchestrator.ts`:

(a) `Entry` gains:

```ts
  maxTurns?: number; // persisted per-result turn cap → materialize restores it (the unattended runaway guard)
  effort?: string; // persisted spawn-time effort override → materialize restores it
```

(b) `run()` — persist right after the `if (input.notify)` line, and carry on the entry:

```ts
    if (input.maxTurns != null) repos.setWorkerMaxTurns(id, input.maxTurns);
    if (input.effort) repos.setWorkerEffort(id, input.effort);
```

and in the `const entry: Entry = { ... }` literal add `maxTurns: input.maxTurns, effort: input.effort,`.

(c) `rehydrate()` — in the `this.entries.set(row.id, { ... })` literal add:

```ts
        maxTurns: row.max_turns ?? undefined,
        effort: row.effort ?? undefined,
```

(d) `materialize()` — pass them to the factory call:

```ts
    const agent = this.deps.factory({ id, sessionId: e.homeSessionId, repoPath: e.worktreePath, label: e.label ?? "", sdkSessionId: e.resumeSessionId ?? null, model: e.model, effort: e.effort, maxTurns: e.maxTurns, permissionMode: e.permissionMode ?? this.deps.repos.getWorker(id)?.permission_mode, onTurnStart: () => this.checkpoint(id) });
```

(e) `fork()` — after the model/permission copies add:

```ts
    if (src.max_turns != null) this.deps.repos.setWorkerMaxTurns(newId, src.max_turns);
    if (src.effort) this.deps.repos.setWorkerEffort(newId, src.effort);
```

and in fork's `this.entries.set(newId, { ... })` literal add `maxTurns: src.max_turns ?? undefined, effort: src.effort ?? undefined,`.

- [ ] **Step 8: Update the doc**

`docs/reference/data-model.md` — in the workers table section (near `permission_mode`, line ~82), add two rows:

```
| `max_turns` | INTEGER | nullable | Per-result turn cap (unattended runaway guard). NULL = unlimited. Survives restart/fork. |
| `effort` | TEXT | nullable | Spawn-time effort override. NULL = global default. Survives restart/fork. |
```

- [ ] **Step 9: Run all covering tests + typecheck**

Run: `npx vitest run test/persistence test/core/fleet-orchestrator.test.ts test/core/fleet-orchestrator-tier1.test.ts test/core/fleet-orchestrator-checkpoints.test.ts test/core/fleet-orchestrator-close.test.ts && npm run typecheck`
Expected: ALL PASS.

- [ ] **Step 10: Commit**

```bash
git add src/persistence src/core/fleet-orchestrator.ts test docs/reference/data-model.md
git commit -m "fix(core): persist worker maxTurns/effort — the budget guard survives restart and fork (audit #9)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Full verification sweep + audit status update

**Files:** Modify: `docs/2026-07-03-agent-loop-audit.md` (status line)

- [ ] **Step 1: Root suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: ALL PASS, exit 0.

- [ ] **Step 2: Desktop suite + typecheck**

Run: `npm -w apps/desktop test && npm -w apps/desktop run typecheck`
Expected: ALL PASS, exit 0.

- [ ] **Step 3: Root build**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 4: Update the audit status line**

In `docs/2026-07-03-agent-loop-audit.md`, extend the existing `> Status 2026-07-03:` blockquote with one more sentence:

```
Follow-up wave: #8 (session.delete close-first ordering), #9 (maxTurns/effort persisted), #18 (bridge.dispose drains pending approvals) fixed, plus the two final-review follow-ups (stale-card expiry on reconnect; worker.send ack + visible failures) — see docs/superpowers/plans/2026-07-03-agent-loop-followups.md.
```

- [ ] **Step 5: Commit**

```bash
git add docs/2026-07-03-agent-loop-audit.md
git commit -m "docs: mark follow-up wave done (#8, #9, #18 + stale-card expiry + worker.send visibility)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
