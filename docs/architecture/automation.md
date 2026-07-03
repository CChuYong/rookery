# Automation (Triggers + Actions)

> **Source of truth:** `src/core/automation-dispatcher.ts`, `src/core/automation-action.ts`, `src/core/scheduler.ts`, `src/core/automation-match.ts`, `src/slack/trigger-source.ts`, `src/core/cron.ts` — the code is authoritative; this doc explains concepts and flows. The always-loaded map/conventions live in [AGENTS.md](../../AGENTS.md); this goes deeper.

An automation rule = a **trigger** + an **action**, persisted in the `automations` table. See AGENTS.md §Automation for the table shape and the protocol/UI wiring. This doc covers the firing path, variable substitution + untrusted-input fencing, the scheduler, the Slack source, and the extension seam.

## Anatomy

- **Trigger** (`AutomationTrigger`, `kind` discriminated union): `cron` `{cron, timezone}` · `slack` `{channels?, keyword?, fromUsers?}` · `once` `{runAt}` (self-wakeup, backs the master's `schedule_*` tools).
- **Action** (`AutomationAction`): `master` `{prompt, cwd, sessionMode, targetSessionId?}` · `worker` `{repo, task, base?}`.
- Per-rule execution knobs: `model`, `effort`, `permission_mode`, `max_turns` (passed into the turn/spawn), plus `next_run_at` / `last_*` bookkeeping.

## AutomationDispatcher — the single firing point

Every trigger source funnels through `AutomationDispatcher.run(a, vars)` (`src/core/automation-dispatcher.ts:21`). The source only decides *what* rule and *which vars*; the dispatcher owns overlap policy, run-recording, and the change event.

- **Overlap guard is trigger-kind-specific:** only `cron` (time) triggers skip when already in-flight (`inflight` Set), recording `last_status:"skipped"` to prevent schedule pile-up when a run outlasts its period. `slack` (event) triggers allow **concurrent** runs — every message must be processed, none dropped. (`once` needs no dispatcher guard; the Scheduler claims it by nulling `next_run_at` before firing — the tick skips claimed rows — and deletes only after the run settles.)
- **Run recording:** sets a transient `running` (UI pulse) → `beforeRun?` hook (best-effort; the daemon uses it to attach a Slack thread reporter before the first event) → `runAutomationAction` → `setAutomationRun` with final `ok`/`error` (+ error string), **always preserving `next_run_at`** (the Scheduler owns that). Each transition emits `automation.changed` on `ALL_CHANNEL`.

## runAutomationAction — the pure action

`runAutomationAction(a, vars, deps)` (`src/core/automation-action.ts:43`):
- **master**: pick the session — `targetSessionId` (self-wakeup: resume the caller's session as-is; skip if gone) → `sessionMode:"reuse"` (`getOrCreateByKey("automation:"+id)`, grouped per rule) → fresh (`create(cwd, {origin:"automation", originRef:id})`). Then `session.master.runTurn(applyVars(prompt, vars), opts)`.
- **worker**: resolve `repo` by name (throws on unknown), get the hidden home session `getOrCreateByKey(AUTOMATION_FLEET_SESSION_KEY)` (= `"automation:fleet"`), `fleet.spawn({... task: applyVars(task, vars), ...opts})`.
- `opts` = `{model, effort, permissionMode, maxTurns}` from the rule.

### Variable substitution + untrusted-input fencing

`applyVars(s, vars)` (`automation-action.ts:32`) substitutes `{{message}}` · `{{channel}}` · `{{user}}` · `{{ts}}` · `{{threadTs}}` · `{{team}}` using a **function-form replacer** (so a `$` in the value can't trigger `$1`-style backref expansion). Missing vars become an empty string.

Each substituted value is **fenced** (`fence`, `automation-action.ts:19`) because Slack text is untrusted and flows into a `bypassPermissions`, unattended master/worker turn:
1. A fresh per-call **nonce** (`randomBytes(9).toString("base64url")`, ~12 alphanumeric chars, no regex/HTML metacharacters).
2. The value is wrapped as `<untrusted-<kind> id="<nonce>">\n…\n</untrusted-<kind> id="<nonce>">`.
3. The value is **neutralized** so it can't spoof the fence: every occurrence of the nonce is stripped (nonce re-use impossible), and a Zero-Width Space is inserted after the `<` of any literal `<untrusted-` / `</untrusted-` so it can no longer match a real tag.

The master system prompt (`master-agent.ts` `SYSTEM_PROMPT_BASE`) and the worker (`WORKER_FENCE_INSTRUCTION`, `worker.ts:16`) both instruct the model to treat anything inside `<untrusted-…>` tags as data, never instructions. This is the only prompt-injection mitigation — there are still no cost/turn budget guards beyond per-rule `max_turns`.

## Trigger source ① cron — Scheduler

`Scheduler` (`src/core/scheduler.ts`, one per daemon) uses `croner` **only to compute the next run** — no internal cron timers. `cron.ts` (`nextRun`/`isValidCron`) wraps `new Cron(expr,{timezone}).nextRun(after)`, deterministic via the injected `now()` (timezone is validated by *calling* `nextRun`, since croner checks it then, not at construction).

- `start()` backfills `next_run_at` only for enabled `cron`/`once` rules missing one (cron is forward-from-now, not back-filled; once persists `runAt` so a past-due wakeup fires on the next tick), then installs a tick (default 30 s, injectable `schedule`).
- `tick()` (`scheduler.ts:61`) selects enabled `cron`/`once` rules with `next_run_at <= now`.
- `fireCron` (`scheduler.ts:70`): **advance `next_run_at` first**, re-read the fresh row, then `dispatcher.run(fresh, {})` — so the dispatcher's run-record preserves the already-advanced value (no double recording).
- `fireOnce` (`scheduler.ts:81`): **claim the rule by nulling `next_run_at` before firing** (the tick skips claimed rows, so a slow run can't double-fire — the dispatcher has no event/once overlap guard), then **delete only after the run settles**. The surviving row makes a crash mid-run recoverable: `start()` re-arms enabled once-rows with no `next_run_at` back to `runAt`, so the wakeup refires (at-least-once) instead of vanishing.
- `runNow(id, vars)` fires once immediately without advancing `next_run_at`. `reconcile(id)` recomputes `next_run_at` on create/update/enable; the protocol layer rejects an invalid cron via `isValidCron`.

## Trigger source ② slack — trigger-source

`makeSlackTriggerHandler(d)` (`src/slack/trigger-source.ts`) is wired into Bolt's `app.message` (separate from the conversational mention path). The Slack layer pre-filters/extracts text (`src/slack/message-text.ts`: self-bot exclusion via `bot_id`, noise subtypes dropped, Block Kit/attachments/rich_text melted to text — see AGENTS.md §Automation). The handler iterates `listAutomations()`, keeps `enabled && trigger.kind==="slack"`, and matches with `matchesSlack`:

`matchesSlack(t, e)` (`src/core/automation-match.ts`) is pure: a non-empty `channels` must include `e.channel`; a non-empty `fromUsers` must include `e.userId`; a non-empty `keyword` must be a case-insensitive substring of `e.text`. Empty constraints match everything. On a match → `dispatcher.run(a, {message, channel, user, ts, threadTs, team})`.

## permission_mode / max_turns per action

Both ride in `opts` from `runAutomationAction`:
- **master**: `permissionMode` selects the SDK permission mode for that turn; `maxTurns` is **warning-only** (a `notice.turnCap`, no abort).
- **worker**: `permissionMode`/`maxTurns` are passed to `fleet.spawn` → the `Worker`, where `maxTurns` **does** stop the worker on cap (see [master-worker-turn.md](./master-worker-turn.md) and [fleet-lifecycle.md](./fleet-lifecycle.md)).

## Extension seam

A new trigger kind (webhook/reaction/interval) needs only: a union member in `AutomationTrigger` + its config, plus either an event matcher (event-type, like `matchesSlack`) or a next-run computation (time-type, like `cron.ts`), a source file that calls `dispatcher.run`, and the wiring in `server.ts`. The dispatcher, `runAutomationAction`, the execution/model path, and the Scheduler stay unchanged.

See also: `../reference/data-model.md` (`automations` table), AGENTS.md §Automation, [master-worker-turn.md](./master-worker-turn.md), [fleet-lifecycle.md](./fleet-lifecycle.md).
