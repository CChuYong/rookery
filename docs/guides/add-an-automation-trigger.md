# Add an Automation Trigger (new trigger kind)

> **Source of truth:** `src/core/automation-match.ts`, `src/core/scheduler.ts`, `src/slack/trigger-source.ts`, `src/core/automation-dispatcher.ts`, `src/protocol/messages.ts`, `src/persistence/repositories.ts` — the code is authoritative; this doc explains concepts and flows. The always-loaded map/conventions live in [AGENTS.md](../../AGENTS.md); this goes deeper.

An automation = a **trigger** + an **action**. Trigger kinds today: `cron`, `slack`, `once` (`AutomationTrigger` union, `src/persistence/repositories.ts:68`). Actions (`master`, `worker`) are unchanged by new triggers. The end-to-end flow lives in [../architecture/automation.md](../architecture/automation.md).

## The extension seam

The dispatcher, the action execution, the model/effort handling, and the DB shape are **all trigger-agnostic**. `AutomationDispatcher.run(a, vars)` (`src/core/automation-dispatcher.ts:21`) is the single firing point: a trigger source only decides *what* fires and *with which vars*. So a new trigger kind needs exactly:

1. a union member (+ its config),
2. inbound validation in the protocol schema,
3. a **matcher** (event-type) or **next-run computation** (time-type),
4. a **trigger source** that calls `dispatcher.run`,
5. `server.ts` wiring to instantiate that source.

Nothing in the dispatcher/action/Scheduler-core changes.

## Event-type vs time-type (pick one)

- **Time-type** (like `cron`/`once`): fires from the `Scheduler` tick based on `next_run_at`. You compute the next run; the dispatcher **deduplicates overlapping runs** (cron's per-id in-flight Set, `src/core/automation-dispatcher.ts:26`) so a slow run doesn't pile up.
- **Event-type** (like `slack`): fires from an external event stream. You write a pure matcher; **every matching event fires** (concurrent runs allowed, no overlap guard — `src/slack/trigger-source.ts` loops and calls `dispatcher.run` per message).

This choice decides which files in step 3/4 you touch.

## Recipe

### 1. Union member + config (`src/persistence/repositories.ts:68`)
Add to `AutomationTrigger`, e.g. `| { kind: "webhook"; path: string; secret?: string }`. The repository serializes the trigger as `trigger_type` + `trigger_config_json` and rehydrates via `{ kind: row.trigger_type, ...JSON.parse(row.trigger_config_json) }` (`src/persistence/repositories.ts:490`) — so no DB migration is needed for a new kind, just the type. No schema change to the `automations` table.

### 2. Protocol validation (`src/protocol/messages.ts:15`)
Add a member to `triggerSchema` (a `discriminatedUnion("kind", …)`). Validate config fields here — this is the trust boundary. For time-type triggers needing format validation, mirror the cron `superRefine` on `automationInputSchema` (`src/protocol/messages.ts:34`) which rejects an invalid cron via `isValidCron`.

### 3a. Event-type: matcher (`src/core/automation-match.ts`)
Write a **pure** predicate like `matchesSlack(trigger, event): boolean` (`src/core/automation-match.ts:5`) — empty/absent filters match everything; all present filters must pass. Pure = trivially unit-testable, no I/O.

### 3b. Time-type: next-run computation (`src/core/scheduler.ts`)
Extend the `Scheduler`:
- `reconcile(id)` — compute and persist `next_run_at` via `repos.setAutomationNextRun` (`src/core/scheduler.ts:43`). Cron uses `nextRun(...)`; once uses `runAt`.
- `tick()` selects `enabled && next_run_at <= now` rows of your kind (`src/core/scheduler.ts:61`).
- a `fireX` method that **advances next_run FIRST, re-reads fresh, then calls `dispatcher.run(fresh, {})`** (`src/core/scheduler.ts:70`) — recording is the dispatcher's job, never double-record. The Scheduler has an injected `now()` and `schedule()` so it's deterministic in tests (no real timer).
- `start()` backfill logic if missing-`next_run_at` rows of your kind should be seeded on boot (`src/core/scheduler.ts:32`).

### 4. Trigger source
- Event-type: mirror `src/slack/trigger-source.ts` — `makeXTriggerHandler({ repos, dispatcher })` returns a handler that loops `repos.listAutomations()`, filters `enabled && trigger.kind === "x"`, applies your matcher, and calls `dispatcher.run(a, vars)` with the substitution vars your event carries. Vars feed `{{message}}`/`{{channel}}`/etc. into the action prompt (`ActionVars`, `src/core/automation-action.ts:6`); extend `ActionVars` if you introduce new placeholders.
- Time-type: the `Scheduler` *is* the source; no separate file.

### 5. Wire in `server.ts` (the only composition root)
Instantiate the source in `startDaemon()` and connect it to its event stream — mirror how `makeSlackTriggerHandler` (`src/daemon/server.ts:230`) and `new Scheduler({ repos, dispatcher })` (`src/daemon/server.ts:208`) are built and the Scheduler started. The protocol `automation.create/update/set_enabled` handlers already call `scheduler.reconcile`; if your time-type kind needs reconcile on save, ensure that path covers it.

## Gotchas

- **Don't record runs in the source.** `setAutomationRun` is the dispatcher's exclusive job; the source/Scheduler only advances `next_run_at`.
- **Overlap semantics differ by type.** Time triggers must skip on overlap (the `guard = a.trigger.kind === "cron"` line, `src/core/automation-dispatcher.ts:25` — extend it for a new time-type kind). Event triggers must NOT skip (process every event).
- **`once` deletes before firing** (`src/core/scheduler.ts:81`) to prevent double-fire; it has no dispatcher guard. Apply the same delete-first pattern for any self-deleting one-shot kind.
- **Prompt injection / no budget guards.** Untrusted text reaches the master prompt as `{{message}}` under `bypassPermissions` with no cost/turn cap. Treat new event sources as untrusted.
- **`once` is hidden from the UI list** (`src/daemon/connection.ts:447`) — internal kinds may need the same filter.
- ESM NodeNext: `.js` extensions, `import type`.

## Test & gate

Matchers and next-run logic are pure and the Scheduler/dispatcher take injected `now()`/`schedule()` — unit-test them directly (mirror `test/core/automation-*.ts`, `test/core/scheduler.test.ts`). No real timers, SDK, or network needed. Then:

```bash
npm run typecheck
npm test
```

Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
