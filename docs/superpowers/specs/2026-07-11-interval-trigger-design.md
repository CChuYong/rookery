# Automation `interval` Trigger — Design

Date: 2026-07-11
Status: approved, ready for implementation
Branch: `feat/interval-trigger`

## Goal

Add a lightweight recurring time trigger — "every N minutes" — as an alternative to `cron` for users who don't want to write cron expressions. First entry of the trigger-source expansion roadmap (the time-type variant).

## Data model

`AutomationTrigger` union (`src/persistence/repositories.ts`) gains `{ kind: "interval"; everyMinutes: number }`. **No repository/migration change** — `createAutomation`/`updateAutomation` already serialize any trigger generically (`{ kind, ...rest }` → `trigger_type` + `trigger_config_json`), and `rowToAutomation` rebuilds it, so `{everyMinutes}` round-trips for free.

## Semantics

- **Recurring, forward-from-now.** First run: `nextRunAt = now + everyMinutes`. It waits one interval before the first fire (consistent with cron not backfilling; no run at create time).
- **No catch-up.** On each fire, `nextRunAt = now + everyMinutes` (computed at fire time). If the daemon was down, it does not burst to catch up — same philosophy as cron's forward-from-now.
- **Minimum 1 minute.** The scheduler tick is 30s, so sub-minute intervals are meaningless; the protocol enforces `everyMinutes >= 1` (positive integer).
- **Overlap-skip (pile-up guard).** Interval is a recurring time trigger, so it joins cron in the dispatcher's overlap guard: if a run is still in flight when the next is due, the new one records `skipped` rather than piling up. (Event triggers like slack stay concurrent.)

## Changes

1. **`src/persistence/repositories.ts`** — add the union member. (No serialization change.)
2. **`src/protocol/messages.ts`** — `triggerSchema`: `z.object({ kind: z.literal("interval"), everyMinutes: z.number().int().positive() })`. `superRefine` unchanged (cron-only validation; interval is fully validated by zod).
3. **`src/core/scheduler.ts`** — treat `interval` as a time trigger alongside cron:
   - `start()` boot backfill: include `interval` in the "enabled time trigger with no nextRunAt → reconcile" set.
   - `reconcile(id)`: `interval` → `nextRunAt = enabled ? now + everyMinutes*60000 : null`.
   - `tick()`: select `interval` rows too.
   - `fireInterval(a)`: advance `nextRunAt = now + everyMinutes*60000` FIRST (advance-before-dispatch, mirrors `fireCron`), then `dispatcher.run(fresh, {})`.
4. **`src/core/automation-dispatcher.ts`** — overlap guard: `a.trigger.kind === "cron" || a.trigger.kind === "interval"`.
5. **Desktop `AutomationForm`** — trigger-kind selector gains an "every N minutes" option with a minutes number input (min 1). i18n ko/en.

## Testing

- `test/core/scheduler.test.ts`: interval reconcile sets `now + everyMinutes`; `tick` fires when due and advances next-run; disabled → null.
- `test/persistence/repositories.test.ts`: interval automation round-trips (`everyMinutes` preserved through create/get/update).
- `test/protocol/*` (or messages parse test): interval trigger parses; `everyMinutes: 0`/negative rejected.
- `test/core/automation-dispatcher.test.ts`: interval run in flight → second concurrent run is `skipped` (overlap guard).
- Desktop `AutomationForm` test: selecting interval + minutes lands in the submitted trigger.

## Out of scope

`interval`-with-anchor (align to wall-clock boundaries), sub-minute intervals, business-hours windows. Other trigger sources (worker-settled, webhook, polling, file-watch) are separate roadmap items.
