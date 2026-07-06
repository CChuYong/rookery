# 2026-07-06 — Cost budget guard (spec)

Closes the long-standing "no cost/turn budget guard" gap (flagged since the 2026-06-22 production-readiness review; the docs promise "Runaway control (cost/turn budgets) will be introduced separately later"). Especially load-bearing now that automations can spawn **codex** masters/workers unattended (P3).

## Design: `costBudgetUsd` — a LIFETIME USD ceiling, sibling of `maxTurns`

- **Metric = cumulative cost (USD)**. Each turn accumulates `cumCostUsd` (audit `docs/2026-07-06-claude-cost-audit.md` confirmed this is correct/per-turn for Claude; codex sums real per-turn deltas via P1.5 pricing). The guard fires on the LIFETIME total, unlike `maxTurns` which is a per-send loop cap. This is the "$ runaway" control the docs promised — complementary to `maxTurns`, not a replacement.
- **Worker**: after a `turn_end`, if `cumCostUsd >= costBudgetUsd` → **stop** the worker (identical teardown to the `maxTurns` cap: notice → interrupt → queue.close → abort → transition("stopped") → clear deferred → return). Plain-string notice (workers consume pre-rendered text, like the maxTurns notice): `"Cost budget reached ($X.XX / $Y.YY) — stopping worker."`.
- **Master**: warning-only (mirror `maxTurns` master): after a `turn_end`, if `cumCostUsd >= costBudgetUsd` → emit a `notice.costBudget` i18n notice (ko+en, daemon + desktop catalogs), turn completes normally (masters are interactive; the human decides).
- **Default OFF** (`null` = unlimited) — opt-in, so existing users/tasks aren't surprised. Settings default `workerCostBudgetUsd` (null/empty = off); per-spawn override (`spawn_worker` tool + `fleet.spawn` protocol); per-automation override (automation config); per-master-turn override (`TurnOverride.costBudgetUsd`, warning-only).

## Wiring (exact mirror of `maxTurns` — trace each maxTurns site and add a parallel costBudgetUsd)

- **Migration (append-only)**: `ALTER TABLE workers ADD COLUMN cost_budget_usd REAL` (nullable, NULL = unlimited). And `ALTER TABLE automations ADD COLUMN cost_budget_usd REAL`.
- **Persistence**: `WorkerRow.cost_budget_usd: number | null`; `createWorker` accepts it; `setWorkerCostBudgetUsd(id, v)` setter (mirror setWorkerMaxTurns); the fleet row read exposes it. `Automation`/`AutomationInput` gain `costBudgetUsd: number | null`; automation CRUD carries it.
- **Worker** (`worker.ts`): `WorkerDeps.costBudgetUsd?: number`; the turn_end block adds the cost-budget check AFTER the maxTurns check (both can be set; either stops). Uses `this.cumCostUsd` (already maintained).
- **Master** (`master-agent.ts`): `TurnOverride.costBudgetUsd?: number`; warning-only notice after turn_end (mirror the maxTurns master block).
- **Fleet** (`fleet-orchestrator.ts`): `WorkerFactory` opts + `Entry` + `spawn`/`materialize`/`rehydrate`/`fork` carry `costBudgetUsd`; persist via `setWorkerCostBudgetUsd`; materialize/rehydrate restore from `row.cost_budget_usd` (survives restart, like maxTurns); fork inherits.
- **Protocol** (`messages.ts`): `fleet.spawn` schema gains `costBudgetUsd: z.number().positive().nullable().optional()`; `automationInputSchema` gains it; the outbound `WorkerRow`/automation row types gain `costBudgetUsd?: number | null`.
- **Connection** (`connection.ts`): thread costBudgetUsd through the spawn handler into `fleet.spawn`.
- **Tools** (`fleet-tools.ts`): `spawn_worker` input schema gains `costBudgetUsd` (describe: "Stop the worker once its cumulative cost reaches this many USD (runaway guard). Omit = unlimited.").
- **Automation** (`automation-action.ts`): master action → `runTurn(prompt, { ..., costBudgetUsd: a.costBudgetUsd ?? undefined })`; worker action → `fleet.spawn({ ..., costBudgetUsd: a.costBudgetUsd ?? undefined })`.
- **Settings** (`settings.ts`): `workerCostBudgetUsd(): number | null` (default null = off; parse a raw string setting, empty/0/malformed → null). SettingsValues + all() + protocol settings.set key. This is the DEFAULT applied when a spawn has no explicit override (server.ts subFactory: `costBudgetUsd: o.costBudgetUsd ?? settings.workerCostBudgetUsd() ?? undefined`).
- **i18n**: `notice.costBudget` (master warn) in daemon i18n.ts (ko+en) + desktop renderer notice catalog (ko+en), params `{spent, budget}`.
- **Desktop**: `WorkerSpawnModal` cost-budget number input (optional, USD); `AutomationForm` cost-budget input; `SettingsPage` Codex/General `workerCostBudgetUsd` default field. Fixtures for the new SettingsValues key.

## Non-goals

A lifetime TURN cap (maxTurns stays per-send; a lifetime turn budget is a separate future item). Hard mid-turn abort on budget (we check at turn boundaries — a single turn can overshoot the budget by one turn's cost, acceptable; documented). Per-model budget. Global daemon budget.

## Testing

- Worker: a fake whose turns accumulate cost past a tiny budget → the worker stops with the cost-budget notice after the crossing turn; budget null → never stops; budget + maxTurns both set → whichever crosses first stops. cumCostUsd re-seed on resume (existing) means the budget is checked against the LIFETIME total across restart.
- Master: cumCostUsd >= budget → warning notice, turn completes (no stop).
- Fleet: spawn/materialize/rehydrate/fork carry + persist + restore cost_budget_usd (mirror the maxTurns fleet tests).
- Protocol/tools: fleet.spawn + spawn_worker + automationInputSchema accept costBudgetUsd; connection threads it.
- Automation: master/worker actions pass costBudgetUsd to runTurn/spawn.
- Settings: workerCostBudgetUsd default null, override, malformed→null; server subFactory applies the default when no override.
- Migration: version bumps; round-trip (create worker/automation with cost_budget_usd → read back; default null).
- Desktop: the three fields round-trip; dual gates.

## Risks
- Overshoot by one turn: the budget is checked at turn boundaries, so a worker can exceed the budget by the cost of the turn that crosses it (can't abort mid-turn cleanly). Acceptable for a runaway guard; documented in the notice ("reached", not "exceeded by exactly").
- Default OFF means it's only protective when opted in — but ON-by-default would surprise/kill legit long tasks. The recommendation (surfaced in docs) is to set a generous `workerCostBudgetUsd` default + tighter per-automation budgets for unattended runs.
- Cost accuracy depends on the provider's per-turn cost: Claude accurate (audit), codex accurate when RATES has the model (P1.5; unknown model → 0 → budget never fires, documented).
