# Cost Budget Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** a lifetime USD cost budget that stops workers / warns masters when `cumCostUsd` crosses it — sibling of `maxTurns`. Spec: `docs/2026-07-06-cost-budget-guard.md`. Default OFF (opt-in).

**Architecture:** mirror `maxTurns` at every site (worker/master/fleet/protocol/connection/tools/automation/settings/desktop). No new mechanism — `cumCostUsd` already accumulates correctly.

## Global Constraints

- **Node 22 first**; ESM NodeNext (`.js`, `import type`); English comments; migrations append-only; no SDK/daemon imports under `src/core/codex/*`.
- **Dual gates** on shared-type/renderer changes: root + `npm -w apps/desktop`.
- New SettingsValues key + new i18n code → desktop fixtures + both i18n catalogs (the recurring dual-gate lesson).
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Sequencing: T1 (core+persistence+fleet) → T2 (protocol+connection+tools+automation+settings default) → T3 (desktop) → T4 (docs). Trace each `maxTurns` occurrence and add a parallel `costBudgetUsd`.

---

### Task 1 — core + persistence + fleet: worker stop / master warn + migration (TDD)

**Files:** `src/persistence/db.ts` (append `ALTER TABLE workers ADD COLUMN cost_budget_usd REAL`), `src/persistence/repositories.ts` (WorkerRow.cost_budget_usd + createWorker + `setWorkerCostBudgetUsd` + fleet row read), `src/core/worker.ts` (WorkerDeps.costBudgetUsd + turn_end check), `src/core/master-agent.ts` (TurnOverride.costBudgetUsd + warn), `src/core/fleet-orchestrator.ts` (factory/Entry/spawn/materialize/rehydrate/fork carry+persist+restore), `src/core/i18n.ts` (`notice.costBudget` ko+en), `apps/desktop/src/renderer/i18n/locales/{ko,en}/notice.ts` (same key). Tests: worker/master/fleet/repositories/settings tests.

- Migration append-only (END). `cost_budget_usd REAL` nullable.
- repositories: `WorkerRow.cost_budget_usd: number | null`; createWorker binds `input.costBudgetUsd ?? null`; `setWorkerCostBudgetUsd(id, v)` (mirror setWorkerMaxTurns); fleet list row includes it.
- worker.ts: `WorkerDeps.costBudgetUsd?: number`. In the turn_end block, AFTER the maxTurns check, add:
  ```ts
  const budget = this.opts.deps.costBudgetUsd;
  if (budget != null && this.cumCostUsd >= budget) {
    this.record({ kind: "notice", text: `Cost budget reached ($${this.cumCostUsd.toFixed(2)} / $${budget.toFixed(2)}) — stopping worker.` });
    void this.stream?.interrupt(); this.queue.close(); this.abort.abort(); this.transition("stopped"); this.deferred.splice(0); return;
  }
  ```
  (place BEFORE the deferred-flush/idle logic, exactly like the maxTurns block — read the surrounding structure; the maxTurns `return` and this one are mutually exclusive, both terminal.)
- master-agent.ts: `TurnOverride.costBudgetUsd?: number`. After the maxTurns master warn block, add a cost-budget warn: if `override?.costBudgetUsd != null && this.cumCostUsd >= override.costBudgetUsd` → `recordEvent notice.costBudget` (params `{ spent: this.cumCostUsd.toFixed(2), budget: override.costBudgetUsd.toFixed(2) }`), no stop.
- i18n `notice.costBudget`: ko "비용 예산 도달 (${spent}/${budget} USD) — 세션 중단을 고려하세요." en "Cost budget reached (${spent}/${budget} USD) — consider stopping this session." (match the notice.turnCap param style; params `{spent, budget}`).
- fleet-orchestrator: mirror EVERY maxTurns site — WorkerFactory opts `costBudgetUsd?: number`, Entry `costBudgetUsd?: number`, spawn input `costBudgetUsd?`, persist `if (input.costBudgetUsd != null) repos.setWorkerCostBudgetUsd(id, input.costBudgetUsd)`, remember on the entry, pass to factory; materialize reads `row.cost_budget_usd`; rehydrate reads it; fork inherits `src.cost_budget_usd`.

- [ ] Failing tests: worker stops at budget (fake accumulates cost past a tiny budget → stopped + notice; null → never); master warns (no stop); fleet spawn/materialize/rehydrate/fork carry+persist+restore cost_budget_usd (mirror maxTurns fleet tests); repositories round-trip (createWorker cost_budget_usd → read; default null); migration version. → implement → gates (dual — i18n renderer + settings later; run desktop too since notice catalog changed).
- [ ] Commit: `feat(fleet): worker cost budget guard (stop at cumCostUsd >= budget) + master warn`.

---

### Task 2 — protocol + connection + tools + automation + settings default (TDD)

**Files:** `src/protocol/messages.ts` (fleet.spawn + automationInputSchema + WorkerRow/automation row types gain costBudgetUsd), `src/daemon/connection.ts` (thread through spawn), `src/tools/fleet-tools.ts` (spawn_worker input), `src/core/automation-action.ts` (master runTurn + worker spawn), `src/persistence/db.ts` (append `ALTER TABLE automations ADD COLUMN cost_budget_usd REAL`), `src/persistence/repositories.ts` (Automation/AutomationInput costBudgetUsd + CRUD), `src/core/settings.ts` (`workerCostBudgetUsd(): number | null` default null), `src/daemon/server.ts` (subFactory applies the settings default when no override: `costBudgetUsd: o.costBudgetUsd ?? settings.workerCostBudgetUsd() ?? undefined`). Tests: protocol/connection/fleet-tools/automation-action/settings/repositories.

- protocol: `fleet.spawn` + `automationInputSchema` gain `costBudgetUsd: z.number().positive().nullable().optional()`; outbound types gain `costBudgetUsd?: number | null`.
- connection: spawn handler passes `costBudgetUsd: msg.costBudgetUsd` into fleet.spawn.
- fleet-tools: spawn_worker input schema + passthrough + description sentence.
- automations migration (append END) + Automation/AutomationInput `costBudgetUsd: number | null` + CRUD (preserve-on-undefined for update, `?? null` on insert).
- automation-action: master `runTurn(prompt, { ...opts, costBudgetUsd: a.costBudgetUsd ?? undefined })`; worker `fleet.spawn({ ...opts, costBudgetUsd: a.costBudgetUsd ?? undefined })`. Add costBudgetUsd to the `opts` object OR pass separately — NOTE: for the WORKER it's a spawn attribute (like maxTurns is in opts already — maxTurns IS in opts and passed to both runTurn and spawn; follow that: add costBudgetUsd to the shared `opts`). For the MASTER it's a TurnOverride (runTurn opts) — consistent.
- settings: `workerCostBudgetUsd()` parse (empty/0/negative/malformed → null); SettingsValues + all() + protocol settings.set key + desktop fixtures (the 5+ SettingsValues literals gain `workerCostBudgetUsd: ""`).
- server.ts subFactory: `costBudgetUsd: o.costBudgetUsd ?? settings.workerCostBudgetUsd() ?? undefined` (explicit spawn override wins; else the settings default; else unlimited).

- [ ] Failing tests → implement → DUAL gates (SettingsValues + Automation type + protocol → desktop fixtures). 
- [ ] Commit: `feat(automation+protocol): cost budget on spawn_worker/fleet.spawn/automation + workerCostBudgetUsd default`.

---

### Task 3 — desktop: cost-budget fields (TDD)

**Files (apps/desktop):** `src/renderer/components/WorkerSpawnModal.tsx` (cost-budget number input), `src/renderer/components/AutomationForm.tsx` (cost-budget input), `src/renderer/components/SettingsPage.tsx` (`workerCostBudgetUsd` default field), i18n locales. Tests: worker-spawn-modal, automation-form, settings-page.

- WorkerSpawnModal: an optional cost-budget `<Input>` (USD, number/text), threaded into the onSpawn payload → `fleet.spawn.costBudgetUsd` (mirror how maxTurns/model flow; if the modal has a maxTurns field, put it beside; if not, add near model/effort). Empty → undefined.
- AutomationForm: a cost-budget `<Input>` beside the existing maxTurns field (grep — AutomationForm has maxTurns at ~:70-71,304-318), threaded into the automation payload.
- SettingsPage: `workerCostBudgetUsd` text `<Input>` (placeholder "off", hint "default cost budget for spawned workers; empty = unlimited") — f-backed, bulk-saved. i18n ko+en.
- i18n keys ko+en for the labels/hints.

- [ ] Failing tests (each field round-trips into its payload/onSave) → implement → dual gates.
- [ ] Commit: `feat(desktop): cost budget fields (spawn modal, automation form, settings default)`.

---

### Task 4 — docs + full gates

- [ ] AGENTS.md: the "no cost/turn budget guard" caveat is now PARTLY closed — a lifetime USD cost budget (`costBudgetUsd`, default off) stops workers / warns masters at `cumCostUsd >= budget`, set per-spawn / per-automation / via the `workerCostBudgetUsd` settings default; overshoot ≤ one turn (checked at boundaries); a lifetime TURN cap is still future. Update the "still no cost/turn budget guards" pitfall line.
- [ ] docs/2026-07-05-codex-backend-parity.md (or the production-readiness doc): budget guard landed.
- [ ] docs/2026-07-06-cost-budget-guard.md status blockquote: implemented.
- [ ] Full gates: root typecheck/test/build + desktop typecheck/test.
- [ ] Commit: `docs: cost budget guard status`.

## Post-plan (controller)

Live smoke (optional): a worker with a tiny cost budget on a real (Claude) task → stops after crossing. Unit-covered; live is confirmatory. fable final review → merge.

## Self-Review Notes

- Pure mirror of maxTurns — trace every maxTurns site (grep) and add the parallel costBudgetUsd; the maxTurns tests are the template.
- Budget checked at turn boundaries (overshoot ≤ one turn) — documented, acceptable for a runaway guard.
- Default OFF — no surprise to existing users; server subFactory applies the settings default only when no explicit override.
- cumCostUsd re-seeds on resume (existing), so the budget is a true LIFETIME guard across restart.
