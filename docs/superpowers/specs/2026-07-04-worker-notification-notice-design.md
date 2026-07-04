# Worker-notification: clean structured notice (design)

- Date: 2026-07-04
- Status: approved (design), pending implementation plan
- Area: `src/core` (master/worker-notifier/session-manager) + i18n catalogs

## Problem

When an armed worker settles, the master is woken with a turn whose prompt is
wrapped in a literal `<worker-notification>…</worker-notification>` tag
(`src/core/master-agent.ts:243`). That same raw wrapper string is then recorded
as the display `master.notice` event (`master-agent.ts:279`, `text: userText`),
and because the notice carries **no `code`**, every consumer falls through to the
raw-`text` branch:

- Desktop chip — `apps/desktop/src/renderer/components/MessageList.tsx:124`
  (`it.code ? t(...) : it.text`) shows the whole `<worker-notification>…` string.
- Slack — `src/slack/reporter.ts:298` renders `_ℹ️ <worker-notification>…_` verbatim.

So the tag leaks into both surfaces as noisy, unlocalized text. The root cause is
that a **single string** serves two different audiences: the model (which
legitimately needs the tag + tail + instructions as its turn input) and the human
(who should see a clean one-line marker).

## Goal / non-goals

**Goal**: the human sees a clean, localized, one-line notice per settled worker
(e.g. `✅ 워커 foo 완료`) in the desktop chip and in Slack. The model keeps
receiving exactly today's tagged prompt.

**Non-goals**: no change to what the model receives; no change to the arming /
`WorkerNotifier` trigger logic; no change to desktop/Slack render code (they
already prefer `code`+`params`); no new DB migration.

## Approach (chosen: A — per-worker structured notice)

Decouple the two audiences by threading **structured data** from the notifier to
the master, and splitting the flush into "model prompt" (unchanged) and "display
notice" (new, structured).

Considered alternative **B (single coalesced notice)** — one chip per flush with a
count. Rejected: when several workers settle into one flush, per-worker
status/label is lost. A is only marginally more code and stays faithful.

### Data flow (model prompt path is byte-for-byte unchanged)

```
worker settles (worker.status ∈ SETTLED)
 → WorkerNotifier.buildNotification(workerId, status): WorkerNotification | null
     // { label, branch, status, tail } instead of a preformatted string
 → deliver(sessionId, n)
 → SessionManager.deliverWorkerNotification(sessionId, n)
     live  → session.master.notifyWorker(n)
     cold  → repos.addPendingNotification(sessionId, JSON.stringify(n))
 → MasterAgent.notifyWorker(n): buffer, coalesce onto turnChain, then on flush:
     ├─ model prompt  = `<worker-notification>\n{lines}\n\nUse view_worker_transcript … \n</worker-notification>`
     │                  where each line = `worker {label} ({branch}) — {status}\n  {tail}`   // == today
     └─ display       = one { code, params, text } per buffered notification
 → doTurn(prompt, undefined, { notices })
     notices present → record each as master.notice (code+params+text); no user echo; no relabel
     model still receives `prompt` via queryFn (tagged, with tail + instructions)
```

### New type

`WorkerNotification` (owned by `worker-notifier.ts`, imported by session-manager
and master-agent):

```ts
export interface WorkerNotification {
  label: string;
  branch: string;   // w.branch ?? workerId
  status: string;   // idle | done | error | failed | stopped | orphaned
  tail: string;     // last assistant text, ≤500 chars — for the MODEL prompt only
}
```

### New notice codes (status bucketed so the verb is fully localizable)

| worker status     | code                   | ko                     | en                        |
|-------------------|------------------------|------------------------|---------------------------|
| `idle`, `done`    | `notice.workerDone`    | `✅ 워커 {label} 완료`  | `✅ Worker {label} done`   |
| `error`, `failed` | `notice.workerFailed`  | `⚠️ 워커 {label} 실패` | `⚠️ Worker {label} failed` |
| `stopped`, `orphaned` | `notice.workerStopped` | `⏹ 워커 {label} 종료` | `⏹ Worker {label} stopped` |

- Param: `{label}` only. `label` falls back to `branch || "worker"` if empty.
- **tail is intentionally excluded from the chip** (noise removal is the point).
  Detail remains available via the model prompt, the master's own reply, and
  `view_worker_transcript` / `view_worker_diff`.
- Added to all four catalogs with identical keys + param names (repo convention):
  daemon `src/core/i18n.ts` (`KO`/`EN`), renderer
  `apps/desktop/src/renderer/i18n/locales/{ko,en}/notice.ts`.

## Touch points

1. `src/core/worker-notifier.ts`
   - export `WorkerNotification`
   - `deliver` dep type → `(sessionId: string, n: WorkerNotification) => void`
   - `buildLine` → `buildNotification(workerId, status): WorkerNotification | null`
     (same label/branch/tail derivation; return structured, not a string)
   - `start()` and `sweepSettled()` deliver the object
2. `src/core/session-manager.ts`
   - `deliverWorkerNotification(sessionId, n: WorkerNotification)`:
     live → `notifyWorker(n)`; cold → `addPendingNotification(sessionId, JSON.stringify(n))`
   - `build()` drain (line ~86): `master.notifyWorker(parseNotification(p.text))`
3. `src/core/master-agent.ts`
   - `notifyWorker(n: WorkerNotification)`; buffer holds `WorkerNotification[]`
   - flush: build the model `prompt` (via a shared `formatNotificationLine(n)` that
     reproduces today's `worker {label} ({branch}) — {status}\n  {tail}`) **and**
     `notices = buffered.map(buildWorkerNotice)`
   - `drainPersistedNotifications(): WorkerNotification[]` (JSON.parse rows)
   - failed-flush re-persist (line ~247): `addPendingNotification(sessionId, JSON.stringify(n))`
   - `doTurn` third arg: `{ notices?: DisplayNotice[] }` replaces `{ asNotice?: boolean }`;
     when present, record each notice via `recordEvent` instead of the user echo,
     and don't relabel the session
   - `buildWorkerNotice(n): DisplayNotice` maps status→code, builds
     `{ code, params: { label }, text: t(DEFAULT_LOCALE, code, { label }) }`
     (mirror of the `notice()` helper in `system-push.ts`)
4. i18n: 3 keys × 4 catalogs (daemon KO/EN + renderer ko/en)

Desktop render (`MessageList.tsx`, `store/reduce.ts`) and Slack render
(`reporter.ts`) are **unchanged** — they already prefer `code`+`params`.

## Edge cases

- **Legacy pending rows across the upgrade**: a cold session may hold
  `pending_notifications` rows written by the old build as plain formatted strings.
  `parseNotification(text)` JSON-parses; on failure it returns a legacy shape
  `{ label: "", branch: "", status: "done", tail: text }` so the row still reaches
  the model prompt and renders as a (generic `workerDone`) notice. Rare, one-time.
- **Coalesced flush (N workers at once)**: N model-prompt lines in one tagged turn
  (as today) **and** N separate display notices. Preserves per-worker fidelity.
- **Flush retry**: notices are recorded inside `doTurn` at the same point as today,
  so retry semantics (and the pre-existing possibility of a duplicated notice on a
  failed→retried flush) are unchanged — no regression, no new dedup introduced.
- **Empty label**: fall back to `branch || "worker"` when building params.

## Testing

- `test/core/worker-notifier.test.ts`: `buildNotification` returns the structured
  object (label/branch/status/tail); `deliver` receives an object.
- `test/core/master-agent.test.ts`: the two existing assertions on the literal
  `<worker-notification>` string (lines ~601, ~649) keep asserting the **model
  prompt** is unchanged, **plus** new assertions that the recorded `master.notice`
  carries `code === "notice.workerDone"` (etc.) and `params.label`, and that its
  `text` no longer contains `<worker-notification>`.
- A cold-session path test: `deliverWorkerNotification` on an unloaded session
  persists JSON; a later `build()` drains and emits the structured notice.

## Out of scope

- Batching/threshold for very high notification volume.
- Any change to worker arming (`notify:true`) or the settle detection set.
- Showing the tail anywhere in the human-facing chip.
