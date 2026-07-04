# Worker-notification clean notice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the raw `<worker-notification>…</worker-notification>` tag leaking into the desktop chip and Slack with a clean, localized per-worker notice, while the model keeps receiving today's exact tagged prompt.

**Architecture:** Thread a structured `WorkerNotification` object (instead of a preformatted string) from `WorkerNotifier` → `SessionManager` → `MasterAgent`. On flush the master builds two things from it: the model prompt (unchanged wording, still tagged) and one structured `master.notice` per worker carrying a `code`+`params` so desktop/Slack (which already prefer `code`) re-localize it.

**Tech Stack:** TypeScript (ESM NodeNext, `.js` import extensions, `import type`), Node 22, vitest, better-sqlite3, in-house i18n (`src/core/i18n.ts` + renderer `apps/desktop/src/renderer/i18n`).

## Global Constraints

- Node 22 ABI 127 — run `nvm use 22` (or PATH) before any build/test.
- ESM NodeNext: relative imports need the `.js` extension; type-only imports use `import type` (`verbatimModuleSyntax`).
- Code comments in English; the change is daemon-side + renderer i18n only.
- i18n: Korean is the default. Every new `notice.*` code must be added to BOTH the daemon catalog (`src/core/i18n.ts` `KO` + `EN`) AND the renderer catalog (`apps/desktop/src/renderer/i18n/locales/{ko,en}/notice.ts`) with byte-identical keys and param names.
- The daemon `EN` catalog is typed `Record<keyof typeof KO, string>`, so a KO key missing from EN is a **typecheck** error (the parity guard for the daemon side).
- The model prompt string built in `notifyWorker` must remain byte-for-byte what it is today: `` `<worker-notification>\n${lines.join("\n")}\n\nUse view_worker_transcript / view_worker_diff for detail, send_worker to continue, or report to the user.\n</worker-notification>` `` where each line is `worker {label} ({branch}) — {status}\n  {tail}`.
- Verification gate for every task: `npm run typecheck` and `npm test` from repo root; i18n renderer tasks also run `npm -w apps/desktop test`.

---

### Task 1: Foundations — `WorkerNotification` type, helpers, and i18n notice codes

Pure additions (no behavior change yet). Introduces the shared vocabulary Task 2 consumes: the structured type, the two free helpers, and the three localized notice codes across all four catalogs.

**Files:**
- Modify: `src/core/worker-notifier.ts` (add exported type + two helpers near the top, above `WorkerNotifierDeps`)
- Modify: `src/core/i18n.ts` (add 3 keys to `KO` and 3 to `EN`)
- Modify: `apps/desktop/src/renderer/i18n/locales/ko/notice.ts` (add 3 keys)
- Modify: `apps/desktop/src/renderer/i18n/locales/en/notice.ts` (add 3 keys)
- Test: `test/core/worker-notifier.test.ts` (new `describe` block for the helpers)

**Interfaces:**
- Produces:
  - `export interface WorkerNotification { label: string; branch: string; status: string; tail: string }`
  - `export function formatNotificationLine(n: WorkerNotification): string`
  - `export function parseNotification(text: string): WorkerNotification`
  - i18n keys `notice.workerDone` / `notice.workerFailed` / `notice.workerStopped`, each with a `{label}` param.

- [ ] **Step 1: Write failing helper tests**

Append to `test/core/worker-notifier.test.ts` (top-level, after the existing imports add the two helper names to the existing `WorkerNotifier` import line, i.e. `import { WorkerNotifier, formatNotificationLine, parseNotification, type WorkerNotification } from "../../src/core/worker-notifier.js";`):

```ts
describe("worker-notification helpers", () => {
  const n: WorkerNotification = { label: "app", branch: "rookery/w1", status: "idle", tail: "did the thing" };

  it("formatNotificationLine reproduces the model-prompt line", () => {
    expect(formatNotificationLine(n)).toBe("worker app (rookery/w1) — idle\n  did the thing");
  });

  it("parseNotification round-trips a serialized notification", () => {
    expect(parseNotification(JSON.stringify(n))).toEqual(n);
  });

  it("parseNotification falls back for a legacy plain-string row", () => {
    expect(parseNotification("worker app (b) — idle")).toEqual({ label: "", branch: "", status: "done", tail: "worker app (b) — idle" });
  });
});
```

- [ ] **Step 2: Run the helper tests to verify they fail**

Run: `npx vitest run test/core/worker-notifier.test.ts -t "worker-notification helpers"`
Expected: FAIL — `formatNotificationLine`/`parseNotification` are not exported.

- [ ] **Step 3: Add the type + helpers to `worker-notifier.ts`**

Insert immediately after the `SETTLED` constant (line 7) and before `export interface WorkerNotifierDeps`:

```ts
// A settled worker's notification payload. Structured (not a preformatted string) so the master can build BOTH the
// model prompt line (formatNotificationLine) AND a clean localized display notice (buildWorkerNotice) from it.
export interface WorkerNotification {
  label: string;
  branch: string; // w.branch ?? workerId
  status: string; // idle | done | error | failed | stopped | orphaned
  tail: string;   // last assistant text (≤500 chars) — for the model prompt only, never shown in the chip
}

// The single model-prompt line for a settled worker (same wording the old buildLine produced).
export function formatNotificationLine(n: WorkerNotification): string {
  return `worker ${n.label} (${n.branch}) — ${n.status}\n  ${n.tail}`;
}

// Parse a persisted pending-notification row back into structured form. Legacy rows (plain strings written by an
// older build) fail JSON.parse or lack fields → wrapped as a done-bucket notice carrying the raw text as its tail.
export function parseNotification(text: string): WorkerNotification {
  try {
    const o = JSON.parse(text) as Partial<WorkerNotification>;
    if (o && typeof o.label === "string" && typeof o.status === "string") {
      return { label: o.label, branch: o.branch ?? "", status: o.status, tail: o.tail ?? "" };
    }
  } catch { /* legacy plain-string row → fall through */ }
  return { label: "", branch: "", status: "done", tail: text };
}
```

- [ ] **Step 4: Run the helper tests to verify they pass**

Run: `npx vitest run test/core/worker-notifier.test.ts -t "worker-notification helpers"`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the daemon i18n keys**

In `src/core/i18n.ts`, add to the `KO` object right after `"notice.turnCap": …,` (line 16):

```ts
  "notice.workerDone": "✅ 워커 {label} 완료",
  "notice.workerFailed": "⚠️ 워커 {label} 실패",
  "notice.workerStopped": "⏹ 워커 {label} 종료",
```

And add to the `EN` object right after its `"notice.turnCap": …,` line:

```ts
  "notice.workerDone": "✅ Worker {label} done",
  "notice.workerFailed": "⚠️ Worker {label} failed",
  "notice.workerStopped": "⏹ Worker {label} stopped",
```

- [ ] **Step 6: Add the renderer i18n keys**

In `apps/desktop/src/renderer/i18n/locales/ko/notice.ts`, add before the closing `} satisfies Catalog;` (after the `"notice.turnCap"` line):

```ts
  "notice.workerDone": "✅ 워커 {label} 완료",
  "notice.workerFailed": "⚠️ 워커 {label} 실패",
  "notice.workerStopped": "⏹ 워커 {label} 종료",
```

In `apps/desktop/src/renderer/i18n/locales/en/notice.ts`, add the English equivalents in the same place:

```ts
  "notice.workerDone": "✅ Worker {label} done",
  "notice.workerFailed": "⚠️ Worker {label} failed",
  "notice.workerStopped": "⏹ Worker {label} stopped",
```

- [ ] **Step 7: Typecheck + i18n parity**

Run: `npm run typecheck`
Expected: PASS (proves `EN` has all new `KO` keys — the daemon parity guard).

Run: `npm -w apps/desktop test -- catalog`
Expected: PASS (renderer ko/en key-set parity holds).

- [ ] **Step 8: Commit**

```bash
git add src/core/worker-notifier.ts src/core/i18n.ts apps/desktop/src/renderer/i18n/locales/ko/notice.ts apps/desktop/src/renderer/i18n/locales/en/notice.ts test/core/worker-notifier.test.ts
git commit -m "feat: worker-notification vocabulary — structured type, helpers, i18n codes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Core migration — structured notifier → session-manager → master display notice

The coupled type migration. Because `MasterAgent.notifyWorker`'s signature changes from `(line: string)` to `(n: WorkerNotification)`, every caller (`SessionManager`, `WorkerNotifier.deliver` via `server.ts`) and the buffer/persist paths change together to keep the build green. The master splits the flush into the (unchanged) model prompt and structured display notices.

**Files:**
- Modify: `src/core/worker-notifier.ts:43-56` (`buildLine` → `buildNotification`), `:12` (`deliver` dep type), `:24` + `:38` (deliver the object)
- Modify: `src/core/session-manager.ts:86` (drain via `parseNotification`), `:137-143` (`deliverWorkerNotification` structured)
- Modify: `src/core/master-agent.ts:113` (buffer type), `:224-229` (`drainPersistedNotifications`), `:231-250` (`notifyWorker` flush), `:252` + `:277-279` (`doTurn` opts + notice recording); add imports + `DisplayNotice`/`buildWorkerNotice`/`workerNoticeCode`
- Modify: `src/daemon/server.ts:147` (rename forwarded param for clarity)
- Test: `test/core/worker-notifier.test.ts`, `test/core/session-manager.test.ts`, `test/core/master-agent.test.ts`

**Interfaces:**
- Consumes (from Task 1): `WorkerNotification`, `formatNotificationLine`, `parseNotification`, the three `notice.worker*` codes.
- Produces:
  - `WorkerNotifier` private `buildNotification(workerId: string, status: string): WorkerNotification | null`; `WorkerNotifierDeps.deliver: (sessionId: string, n: WorkerNotification) => void`.
  - `SessionManager.deliverWorkerNotification(sessionId: string, n: WorkerNotification): void`.
  - `MasterAgent.notifyWorker(n: WorkerNotification): void`.
  - `MasterAgent` internal `interface DisplayNotice { code: string; params?: Record<string, string | number>; text: string }` and `buildWorkerNotice(n: WorkerNotification): DisplayNotice`.

- [ ] **Step 1: Update the master-agent behavioral test to the new expectations (failing)**

In `test/core/master-agent.test.ts`, the test at line 590 (`"notifyWorker runs a single coalesced notice turn …"`) currently passes string lines and asserts only the tag. Rewrite its body so `notifyWorker` receives `WorkerNotification` objects, the **model prompt** still contains the tag, and the recorded **notice** is now structured (code + params, no tag). Replace lines 596-604 (the two `notifyWorker("…")` calls through the `master.notice` assertion) with:

```ts
    master.notifyWorker({ label: "app", branch: "rookery/app", status: "idle", tail: "did A" });
    master.notifyWorker({ label: "web", branch: "rookery/web", status: "failed", tail: "hit B" });
    await master.idle();

    // Model still gets today's tagged prompt with both lines.
    expect(prompts[0]).toContain("<worker-notification>");
    expect(prompts[0]).toContain("worker app (rookery/app) — idle");
    expect(prompts[0]).toContain("worker web (rookery/web) — failed");

    // Display: one structured notice per worker, localized, WITHOUT the raw tag.
    const notices = collected.filter((e) => e.type === "master.notice") as Array<{ code?: string; params?: { label?: string }; text?: string }>;
    expect(notices.map((n) => n.code)).toEqual(["notice.workerDone", "notice.workerFailed"]);
    expect(notices.map((n) => n.params?.label)).toEqual(["app", "web"]);
    expect(notices.every((n) => !n.text?.includes("<worker-notification>"))).toBe(true);
```

> Note for the implementer: this test already captures emitted events and sent prompts. Match the existing local variable names in that test — it uses a prompts array (from the fake query capture) and an events collector. If the collector variable is named differently than `collected`, use that name; if events are captured as type strings only, extend the capture to retain the full event object so `code`/`params`/`text` can be asserted (the other notice tests in this file, e.g. line 682, already filter full `master.notice` objects — mirror that).

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/core/master-agent.test.ts -t "single coalesced notice turn"`
Expected: FAIL — `notifyWorker` still expects a string / no `code` on the notice.

- [ ] **Step 3: Migrate `worker-notifier.ts` to deliver structured**

Change the `deliver` field type (line 12):

```ts
  deliver: (sessionId: string, n: WorkerNotification) => void;
```

In `start()` replace lines 24-25:

```ts
      const n = this.buildNotification(e.workerId, e.status);
      if (n) this.d.deliver(arm.sessionId, n);
```

In `sweepSettled()` replace lines 38-39:

```ts
      const n = this.buildNotification(w.id, w.status);
      if (n) this.d.deliver(arm.sessionId, n);
```

Rename `buildLine` → `buildNotification` and return the object (replace lines 43-56):

```ts
  private buildNotification(workerId: string, status: string): WorkerNotification | null {
    const w = this.d.repos.getWorker(workerId);
    if (!w) return null;
    let tail = "(no output)";
    const events = this.d.repos.listWorkerEvents(workerId);
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]!.type !== "message") continue;
      try {
        const p = JSON.parse(events[i]!.payload_json) as { role?: string; content?: string };
        if (p.role === "assistant" && typeof p.content === "string") { tail = p.content.slice(0, 500); break; }
      } catch { /* skip malformed */ }
    }
    return { label: w.label, branch: w.branch ?? workerId, status, tail };
  }
```

- [ ] **Step 4: Migrate `session-manager.ts`**

Add an import (top of file, with the other `./` imports):

```ts
import { parseNotification, type WorkerNotification } from "./worker-notifier.js";
```

Replace the drain loop at line 86:

```ts
      for (const p of pending) master.notifyWorker(parseNotification(p.text)); // delivered via notifyWorker — flushed immediately if idle, else coalesced after the in-flight turn
```

Replace `deliverWorkerNotification` (lines 137-143):

```ts
  // Live master → deliver immediately; cold (unloaded) session → persist (as JSON) and deliver on next load (build() drains).
  deliverWorkerNotification(sessionId: string, n: WorkerNotification): void {
    if (this.deleting.has(sessionId)) return; // mid-delete: the cascade sweeps the row anyway → don't park a line
    const live = this.sessions.get(sessionId); // NOTE: not get() — must not materialize a cold session here
    if (live) { live.master.notifyWorker(n); return; }
    this.deps.repos.addPendingNotification(sessionId, JSON.stringify(n));
  }
```

- [ ] **Step 5: Migrate `master-agent.ts` — imports, buffer type, display helpers**

Add an import after line 15:

```ts
import { formatNotificationLine, parseNotification, type WorkerNotification } from "./worker-notifier.js";
```

Add the display-notice type + helpers just after the `TurnOverride` interface (after line 50), at module scope:

```ts
// A pre-localized display notice for a system-injected (non-user) turn. code+params so each client re-localizes.
interface DisplayNotice { code: string; params?: Record<string, string | number>; text: string }

// Bucket a settled worker status into a display notice code (so the verb localizes cleanly).
function workerNoticeCode(status: string): "notice.workerDone" | "notice.workerFailed" | "notice.workerStopped" {
  if (status === "error" || status === "failed") return "notice.workerFailed";
  if (status === "stopped" || status === "orphaned") return "notice.workerStopped";
  return "notice.workerDone"; // idle, done (and anything unexpected → done)
}

// The clean, localized display notice for a settled worker (no tail — the chip stays a one-line marker).
function buildWorkerNotice(n: WorkerNotification): DisplayNotice {
  const code = workerNoticeCode(n.status);
  const params = { label: n.label || n.branch || "worker" };
  return { code, params, text: t(DEFAULT_LOCALE, code, params) };
}
```

Change the buffer field type (line 113):

```ts
  private pendingNotifications: WorkerNotification[] = [];
```

- [ ] **Step 6: Migrate `master-agent.ts` — `drainPersistedNotifications` + `notifyWorker` flush**

Replace `drainPersistedNotifications`'s return mapping (line 228) so it parses rows:

```ts
    return rows.map((r) => parseNotification(r.text));
```

(Its declared return type changes to `WorkerNotification[]`; update the method signature at line 224 accordingly.)

Replace `notifyWorker` (lines 233-250):

```ts
  notifyWorker(n: WorkerNotification): void {
    if (this.closing) return; // session being deleted — a wake-up now would ghost-turn into a cascading row
    this.pendingNotifications.push(n);
    if (this.notifyFlushScheduled) return; // a flush is already queued on turnChain — it will drain everything accumulated by then
    this.notifyFlushScheduled = true;
    this.turnChain = this.turnChain.then(() => {
      this.notifyFlushScheduled = false;
      // Prepend any stranded rows from a previously-failed flush (older first) so ordering is preserved and they retry.
      const items = [...this.drainPersistedNotifications(), ...this.pendingNotifications.splice(0)];
      if (items.length === 0) return;
      const lines = items.map(formatNotificationLine);
      const prompt = `<worker-notification>\n${lines.join("\n")}\n\nUse view_worker_transcript / view_worker_diff for detail, send_worker to continue, or report to the user.\n</worker-notification>`;
      const notices = items.map(buildWorkerNotice);
      return this.doTurn(prompt, undefined, { notices }).catch(() => {
        // Turn failed → persist the notifications (as JSON) so the next activation (incl. after a restart) retries.
        for (const it of items) this.opts.deps.repos.addPendingNotification(this.opts.sessionId, JSON.stringify(it));
      });
    }).catch(() => {});
  }
```

- [ ] **Step 7: Migrate `master-agent.ts` — `doTurn` opts + notice recording**

Change the `doTurn` signature (line 252) from `opts?: { asNotice?: boolean }` to:

```ts
  private async doTurn(userText: string, override?: TurnOverride, opts?: { notices?: DisplayNotice[] }): Promise<void> {
```

Replace the `asNotice` branch (lines 277-286) so it records the structured notices instead of the raw text:

```ts
      if (opts?.notices) {
        // System-injected worker-completion turn: record clean per-worker notices (code+params, re-localized by clients);
        // the model still receives `userText` (the tagged prompt) below. Not a user message, and don't relabel the session.
        for (const dn of opts.notices) this.recordEvent({ type: "master.notice", sessionId, text: dn.text, code: dn.code, params: dn.params });
      } else {
        repos.addMessage({ sessionId, role: "user", content: userText }); // messages table (last_activity)
        this.persistEvent({ type: "master.message", sessionId, role: "user", content: userText, clientMsgId }); // Persist transcript (restore)
        bus.emit({ type: "master.message", sessionId, role: "user", content: userText, clientMsgId }); // Live echo — accurate timeline position after passing through the turn queue
        // Auto-generate a label from the first message (run concurrently so it doesn't block the response, finalized with await at the end of the turn).
        labelDone = this.maybeLabel(userText);
      }
```

- [ ] **Step 8: Update the `server.ts` wiring param name (clarity only)**

Replace line 147:

```ts
  const notifier = new WorkerNotifier({ bus, repos, deliver: (sessionId, n) => sessions.deliverWorkerNotification(sessionId, n) });
```

- [ ] **Step 9: Update the remaining string-based test call sites**

These tests pass string lines / assert `p.text` strings and must move to structured objects. Make the following edits:

`test/core/worker-notifier.test.ts` — the delivery tests now receive an object. Update:
- The module-level `h()` unchanged. In the first test (lines 22-27), replace the `line` assertions:
  ```ts
    const [sid, n] = x.deliver.mock.calls[0]!;
    expect(sid).toBe("sA");
    expect(n.label).toBe("app");
    expect(n.status).toBe("idle");
    expect(n.tail).toContain("done the thing");
  ```
- Failure test (line 47): `expect(x.deliver.mock.calls[0]![1].status).toBe("failed");`
- In the `sweepSettled` and shutdown helpers (lines 57, 91) the collector types change from `{ sessionId; line }` to `{ sessionId: string; n: WorkerNotification }`; update the `deliver` closures to `(sessionId, n) => delivered.push({ sessionId, n })`. The existing assertions only check `delivered.length` / `sessionId`, so no further changes.

`test/core/session-manager.test.ts`:
- Line 146: `if (arm?.armed) sm.deliverWorkerNotification(session.id, { label: "w", branch: "b", status: "idle", tail: "" });`
- Line 283: `sm.deliverWorkerNotification(live.id, { label: "a", branch: "ra", status: "idle", tail: "" });`
- Lines 289-290 (cold persist): the row is now JSON — assert on the parsed value:
  ```ts
    sm2.deliverWorkerNotification("cold1", { label: "b", branch: "rb", status: "failed", tail: "" });
    expect(repos.pendingNotifications("cold1").map((p) => JSON.parse(p.text).status)).toEqual(["failed"]); // persisted as JSON
  ```
- Line 282 spy (`notifyWorker`) is unchanged (it only checks it was called).

`test/core/master-agent.test.ts` — the remaining `notifyWorker("…")` string calls:
- Line 614: `master.notifyWorker({ label: "app", branch: "rookery/app", status: "idle", tail: "did A" });` and line 618 becomes `expect(d.repos.pendingNotifications("s1").map((p) => JSON.parse(p.text).label)).toEqual(["app"]);`
- Lines 640-641: `master.notifyWorker({ label: "app", branch: "ra", status: "idle", tail: "" });` and `master.notifyWorker({ label: "web", branch: "rw", status: "failed", tail: "" });`; the line 649 tag assertion (`prompts[1]).toContain("<worker-notification>")`) stays.
- Line 734: `master.notifyWorker({ label: "A", branch: "ra", status: "idle", tail: "" });` and line 736 becomes `expect(base.repos.pendingNotifications("s1").map((r) => JSON.parse(r.text).label)).toEqual(["A"]);`
- Line 738: `master.notifyWorker({ label: "B", branch: "rb", status: "idle", tail: "" });`
- Line 802: `master.notifyWorker({ label: "w", branch: "rw", status: "idle", tail: "" });`

- [ ] **Step 10: Run the full suite + typecheck**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm test`
Expected: PASS (all core tests, including the rewritten notice test and the updated call sites).

Run: `npm -w apps/desktop test`
Expected: PASS (renderer i18n parity + reducer tests unaffected).

- [ ] **Step 11: Commit**

```bash
git add src/core/worker-notifier.ts src/core/session-manager.ts src/core/master-agent.ts src/daemon/server.ts test/core/worker-notifier.test.ts test/core/session-manager.test.ts test/core/master-agent.test.ts
git commit -m "fix: clean localized worker-settled notice (no raw <worker-notification> tag)

Model still gets the tagged prompt; the desktop chip and Slack now render a
per-worker code+params notice (workerDone/Failed/Stopped) instead of the raw
wrapper. Cold-session pending notifications persist as JSON.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Clean localized notice in desktop + Slack → Task 1 (codes) + Task 2 Steps 5-7 (structured `master.notice`); render code unchanged (spec: they already prefer `code`). ✓
- Model prompt unchanged → Global Constraints + Task 2 Step 6 (byte-identical prompt string, `formatNotificationLine` reproduces the line). ✓
- Structured `WorkerNotification` threaded notifier→session→master → Task 2 Steps 3-6. ✓
- Status-bucketed codes `workerDone/Failed/Stopped`, `{label}` param, no tail in chip → Task 1 Step 5-6, Task 2 `buildWorkerNotice`. ✓
- Four catalogs updated with identical keys/params → Task 1 Steps 5-6, guarded by typecheck (daemon) + catalog test (renderer). ✓
- Cold-session pending as JSON + legacy fallback → `parseNotification` (Task 1) + Task 2 Steps 4/6/9. ✓
- Coalesced flush = N prompt lines + N notices; retry semantics unchanged → Task 2 Step 6 (`items.map`). ✓
- Tests: worker-notifier structured, master-agent notice code assertion, cold-session path → Task 1 Step 1, Task 2 Steps 1/9. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. The only soft spot is Task 2 Step 1's note about matching existing local variable names in the pre-existing test — this is guidance to read the surrounding test, not a placeholder for missing logic (the assertion code is complete).

**Type consistency:** `WorkerNotification` fields (`label`/`branch`/`status`/`tail`) are used identically across `formatNotificationLine`, `parseNotification`, `buildNotification`, `buildWorkerNotice`, and every test object. `notifyWorker(n: WorkerNotification)` matches all call sites. `DisplayNotice` (`code`/`params`/`text`) matches the `doTurn` opts and the `recordEvent` payload (`type: "master.notice"; text; code?; params?` per `events.ts:32`). Notice codes `notice.workerDone/Failed/Stopped` are consistent between `workerNoticeCode`, the four catalogs, and the test assertions.
