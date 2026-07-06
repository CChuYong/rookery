# Codex Parity (HIGH + MEDIUM) Implementation Plan

> **For agentic workers:** Execute inline (planner == implementer, full-context Opus). Steps use TDD. Findings from the 2026-07-07 `codex-parity-audit` workflow (run wf_4133464b-a14). Scope: HIGH (4) + MEDIUM (14); LOW (10) deferred.

**Goal:** Close the Claude-only assumptions that break or silently degrade the Codex backend across the daemon core, desktop renderer, CLI, and operator docs.

**Architecture:** Codex was bolted onto a Claude-only engine (P0–P3). The `AgentBackend` port is provider-neutral, but several consumers still assume Claude semantics (per-send `numTurns`, SDK-throws-on-abort, in-process MCP, Anthropic-only auth/data). Fixes restore per-send/per-provider parity at the seam, never by special-casing deep in Claude code.

**Tech Stack:** TypeScript ESM (NodeNext, `.js` imports), vitest, better-sqlite3, Electron renderer (React), zod protocol.

## Global Constraints

- Node 22 ABI. ESM relative imports need `.js`; type-only uses need `import type`.
- Code comments in English. Korean is the default i18n locale; new `notice.*` codes go in BOTH `src/core/i18n.ts` and the desktop renderer catalog with identical param names.
- Root gates: `npm run typecheck && npm test`. Desktop gates (when touching renderer/main): `npm -w apps/desktop run typecheck && npm -w apps/desktop test`.
- Migrations are append-only. `*_TOOL_NAMES` must stay in sync with `tool()` names.
- Do NOT push or tag (no unprompted releases).
- Model/effort injected as resolvers (re-evaluated per turn) — never snapshot.

## Decisions locked before coding

- **numTurns ([0],[4],[9]):** Codex exposes no sub-turn agentic-loop count. Emit a genuine **per-send `numTurns: 1`** from `turn/completed` (matches the port contract at `agent-backend.ts:40`). This fixes the worker's quadratic display inflation and the false-trip cap. Consequence: the per-send `maxTurns` cap is inherently **inert on codex** (both master and worker) — this is the honest state; `costBudgetUsd` is the codex runaway guard. Document it; do NOT synthesize a fake tool-call count (would corrupt the "N turns" display metric that consumers accumulate).
- **Watchdog vs AskUserQuestion ([1]):** Pause the idle watchdog while a blocking interaction is outstanding, driven from the master's own ask closure (entering the closure PROVES the bridge delivered the `tools/call`, so pausing is safe; a wedged bridge never enters it and the watchdog still fires). Add optional `pauseIdleWatchdog?()/resumeIdleWatchdog?()` to `AgentStream`; codex implements, Claude omits (no-op).
- **[8] tool_result:** Widen the inbound decode to read `item.result.content` (MCP content blocks) and serialize text; fall back to `status` when absent (older/other items unaffected).
- Nothing in scope is ambiguous enough to skip. The only deliberately-not-done item is the numTurns "synthesize agentic-loop count" alternative (rejected above with rationale).

---

## Unit A — daemon turn lifecycle & telemetry (`codex-backend.ts` + `master-agent.ts`)

Findings: [0] numTurns per-send, [9] worker cap, [4] master cap, [1] watchdog-vs-ask, [7] interrupt-escalation hang, [10] stale interaction on turn death, [5] interrupt notice on codex master stop, [8] tool_result content.

**Files:**
- Modify: `src/core/codex/codex-backend.ts`
- Modify: `src/core/master-agent.ts`
- Modify: `src/core/agent-backend.ts` (add optional `pauseIdleWatchdog?/resumeIdleWatchdog?` to `AgentStream`)
- Test: `test/core/codex/codex-backend.test.ts`, `test/core/master-agent.test.ts`
- Test helper: `test/helpers/fake-codex.ts` (add `mcpToolCall` step + `deadInterrupt` opt)

**Steps (TDD):**
1. **[0]/[9]/[4] numTurns=1.** Flip the existing test "synthesizes CUMULATIVE numTurns … [1,2,3]" to assert per-send `[1,1,1]`; run → fail. Change `turn/completed` to emit `numTurns: 1`, remove the `cumTurns` field/increment, update the correlation-guard comment. Update `worker.ts:334-335` and `master-agent.ts:417` comments to state the per-send cap is inert on codex (costBudget is the guard). Run → pass.
2. **[8] tool_result content.** Add a `mcpToolCall` step to `fake-codex.ts` that emits `item/completed` with `result.content:[{type:"text",text:"…"}]`. Test: the emitted `tool_result.content` is the serialized text (not `"completed"`). Implement `serializeMcpResult(result, fallback)` + widen decode `item.result?`. Run → pass.
3. **[7] interrupt-escalation hang.** Add `deadInterrupt` opt to fake (turn/interrupt gets NO response). Test: idle→(interrupt hangs)→ack-timeout→grace→kill+`notice.codexTurnTimeout`. Implement: race `interrupt()` in `onIdleTimeout` against `WATCHDOG_INTERRUPT_ACK_MS`. Run → pass.
4. **[1] watchdog pause.** Add `pauseIdleWatchdog/resumeIdleWatchdog` to `CodexSessionBase` (+ `watchdogPaused` flag guarding `resetIdleWatchdog`). Test: while paused, advancing past the idle window does NOT trip; after resume it re-arms. Add optional methods to `AgentStream`. Run → pass.
5. **[1] master wiring.** In `master-agent.ts` ask closure, wrap the `canUseTool` await with `this.currentQuery?.pauseIdleWatchdog?.()` / `resumeIdleWatchdog?.()` in try/finally. (Covered indirectly; add a master-agent test asserting pause/resume are called around a blocking ask via a fake stream that records them.)
6. **[5] interrupt notice on clean codex abort.** In `doTurn`, after the `for await` loop, if `abort.signal.aborted` record `notice.interrupted` and return (mirrors the catch path the Claude SDK reaches by throwing). Test with a fake backend whose stream ends cleanly after abort.
7. **[10] retire interaction on any turn death.** In `doTurn` `finally`, `abort.abort()` before nulling `currentAbort` so an interaction armed on `abort.signal` is denied-and-retired regardless of stop/crash/watchdog-kill. Test: turn ends by error while an interaction is pending → registry emits `interaction.resolved`.
8. Root typecheck + tests. Commit.

## Unit B — commands.list provider gating ([6])

**Files:** `src/daemon/connection.ts` (commands.list handler), `src/core/commands.ts` (CommandCatalog cache key), `src/daemon/server.ts` (wiring if needed), `apps/desktop/src/renderer/App.tsx` (prefetch gate). Test: `test/daemon/connection.test.ts`.

**Fix:** Thread the session/worker `provider` into the `commands.list` handler; when `provider === "codex"` short-circuit to `[]` (no Claude SDK probe). Desktop: skip the prefetch for codex sessions/workers. Commit.

## Unit C — shutdown ordering ([15])

**Files:** `src/daemon/server.ts` `close()`. Test: `test/daemon/*` (or a focused unit around ordering).

**Fix:** Drain `fleet.close`/`sessions.drain` (which lets in-flight codex master turns reach the bridge) BEFORE `closeAllConnections()`/`httpServer.close()`. Keep `db.close()` last. Verify no regression to the existing G-SHUTDOWN-RACE guard. Commit.

## Unit D — desktop model/effort/permission picker parity ([2],[11],[12],[13],[14])

**Files:** `apps/desktop/src/renderer/App.tsx` (masterControls permissionModes; worker default model provider-aware — also [22] two-liner while here), `components/Composer.tsx` (null-catalog codex → free-text), `components/AutomationForm.tsx` (split model/codexModel state + null-catalog free-text). Tests: `apps/desktop/test/*`.

**Fixes:**
- [2] `masterControls.permissionModes = provider === "codex" ? ["bypassPermissions"] : PERMISSION_MODES`.
- [11]/[14] Composer: `provider==="codex" && codexModels==null` → free-text `<Input>`, never the Claude list.
- [12] AutomationForm: separate `codexModel` state + `effectiveModel` resolver; clear the inactive field on provider switch.
- [13] AutomationForm: codex + null catalog → free-text (+ out-of-list option), not the Claude select.
- Desktop typecheck + tests. Commit.

## Unit E — CLI --provider flag ([16])

**Files:** `src/entrypoints/cli.ts`, `src/index.ts`. Test: none needed beyond typecheck (thin client), but add a parseArgs test if one exists.

**Fix:** Parse `--provider claude|codex`, thread into the `session.create` message. Commit.

## Unit F — operator docs / data consent ([17])

**Files:** `README.md` (Data Handling §, Slack §, Automation §ref [27] too while here), `apps/desktop/src/renderer/i18n/locales/{en,ko}/dataConsent.ts`.

**Fix:** State that codex-provider sessions/workers/Slack threads/automations transmit prompts/code/diffs to OpenAI; document `slackProvider`, per-automation `provider`, and the codex-requires-bypassPermissions constraint. Commit.

## Verification — DONE (2026-07-07)

- Root: `npm run typecheck` clean, `npm test` = **886 passed**.
- Desktop: `npm -w apps/desktop run typecheck` clean, `npm -w apps/desktop test` = **883 passed**.
- All 18 findings (HIGH 4 + MEDIUM 14) implemented via TDD across 6 commits on `fix/codex-parity-high-medium`.
- Final adversarial review pass (fable subagent) over the branch diff.

## Out of scope (LOW, deferred)

[18] codex $0 pricing for unlisted models, [19] tool_progress, [20] mcpServers seam no-op, [21] seedCodexHome try/catch, [22] worker default model (folded into D opportunistically), [23] effort-select blank, [24] session.open provider, [25]/[26] models-catalog auth divergence, [27] README Slack/automation (folded into F opportunistically).
