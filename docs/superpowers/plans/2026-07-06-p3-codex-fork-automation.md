# P3 Codex Fork + Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** #1 make codex master session fork work (per-session CODEX_HOME rollout seeding) + #8 automation-origin codex. Spec: `docs/2026-07-06-p3-codex-fork-automation.md` (Track A fork mechanism is live-spiked: `.superpowers/sdd/probe-fork-home2.mjs`).

**Architecture:** Track A = daemon (session-manager, codex-backend, server.ts, codex-home). Track B = daemon (db migration, repositories, protocol, automation-action) + renderer (AutomationForm).

## Global Constraints

- **Node 22 first**; ESM NodeNext (`.js`, `import type`); English comments; migrations append-only; no `@anthropic-ai/claude-agent-sdk` or `../daemon/` imports under `src/core/codex/*`.
- **Dual gates** on shared-type/renderer changes: root `npm run typecheck && npm test` AND `npm -w apps/desktop run typecheck && npm -w apps/desktop test`.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Sequencing: Task 1 (fork) and Task 2 (automation daemon) are independent files mostly; run 1→2→3(desktop)→4(docs).

---

### Task 1 — Track A: codex master fork with rollout seeding (TDD)

**Files:** `src/core/session-manager.ts` (fork restructure + remove P2.5 guard), `src/core/codex/codex-backend.ts` (`forkSession(threadId, opts?: { env? })`), `src/daemon/codex-home.ts` (a `seedCodexHomeFromSource(home, sourceSessionId, newSessionId)` helper — copy source `sessions/` tree), `src/daemon/server.ts` (the codex fork router does: locate source home → `codexBackend.forkSession(threadId, { env: { CODEX_HOME: sourceHome } })` → seed new home → return forkedUuid), `src/core/session-manager.ts` ForkFn type widened. Tests: `test/core/session-manager.test.ts`, `test/core/codex/codex-backend.test.ts`, `test/daemon/codex-home.test.ts`.

Design (from spec Track A — read it):
1. `ForkFn = (provider, sdkSessionId, opts?: { title?; sourceSessionId?; newSessionId? }) => Promise<{ sessionId }>`. Update the type + BOTH routers (fleet + SessionManager) in server.ts + all test stubs (mechanical arg addition).
2. `SessionManager.fork(sessionId)`: gen `newId` first; call `forkSession(provider, row.sdk_session_id, { title: forkLabel, sourceSessionId: sessionId, newSessionId: newId })`; `createSession({ id: newId, cwd, origin:"ui", provider })`; `setSdkSessionId(newId, forkedUuid)`; `copySessionEvents(sessionId, newId)`; `setSessionLabel`; build. REMOVE the `if (provider === "codex") throw ...` guard.
3. `CodexBackend.forkSession(threadId, opts?: { env?: NodeJS.ProcessEnv })`: spawn the ephemeral child with `env: opts?.env ?? this.deps.env?.()` (claude/worker paths pass no opts → unchanged).
4. server.ts SessionManager forkSession router: `(provider, id, opts) => provider === "codex" ? forkCodexMaster(id, opts) : sdkForkSession(id, opts)` where `forkCodexMaster(sourceThreadId, { sourceSessionId, newSessionId, title })`:
   - `sourceHome = path.join(config.home, "codex-homes", sourceSessionId)`; if `!existsSync(sourceHome)` → throw `"cannot fork codex session: source CODEX_HOME missing"`.
   - `const { sessionId: forkedUuid } = await codexBackend.forkSession(sourceThreadId, { env: { CODEX_HOME: sourceHome } })`.
   - `seedCodexHomeFromSource(config.home, sourceSessionId, newSessionId)` — cpSync `sourceHome/sessions` → `<home>/codex-homes/<newSessionId>/sessions` (recursive, only if source sessions/ exists).
   - return `{ sessionId: forkedUuid }`.
5. `seedCodexHomeFromSource` in codex-home.ts: pure fs, best-effort mkdir + cpSync; never throws on a missing source sessions/ (fork still works, just no prior context — but for a completed-turn source it always exists).

- [ ] Failing tests: session-manager codex fork now SUCCEEDS (fake forkSession router records the newId/sourceSessionId opts; the guard is gone); `forkSession` env override reaches the spawn (fake-codex records env); `seedCodexHomeFromSource` copies a temp source sessions/ tree into the new home. → implement → gates.
- [ ] Commit: `feat(codex): codex master fork seeds the new per-session CODEX_HOME from the source rollouts`.

---

### Task 2 — Track B daemon: automation provider (TDD)

**Files:** `src/persistence/db.ts` (append `ALTER TABLE automations ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'`), `src/persistence/repositories.ts` (`Automation`/`AutomationInput` + CRUD carry provider), `src/protocol/messages.ts` (`automationInputSchema` provider enum), `src/core/automation-action.ts` (master → create/getOrCreateByKey with provider; worker → fleet.spawn provider). Tests: `test/persistence/repositories.test.ts` (or automation repo test), `test/core/automation-action.test.ts`, `test/protocol/messages.test.ts`.

- Migration append-only (END of MIGRATIONS). `Automation.provider: string`, `AutomationInput.provider?: string` (default "claude" on write). automationInputSchema: `provider: z.enum(["claude","codex"]).optional()`.
- automation-action master: `getOrCreateByKey("automation:"+a.id, c.cwd, a.provider)` (reuse) / `create(c.cwd, { origin:"automation", originRef:a.id, provider: a.provider })` (fresh). worker: `fleet.spawn({ ..., provider: a.provider })`. Do NOT put provider in the `opts` passed to runTurn (it's a creation attribute). Self-wakeup path (targetSessionId) unchanged.
- Note in code: codex masters are bypass-only; a codex automation with non-bypass permission_mode fails its run with a clear error (P2 guard). Automation defaults bypass.

- [ ] Failing tests: migration version; Automation provider round-trip (default claude, codex override); automationInputSchema accepts provider; automation-action master reuse/fresh + worker spawn pass provider (recording fakes for sessions.create/getOrCreateByKey + fleet.spawn). → implement → gates (protocol change → dual? automationInputSchema is daemon-side; the desktop consumes Automation type via @daemon — if the desktop AutomationForm or a fixture references the shape, the desktop gate catches it; run both to be safe).
- [ ] Commit: `feat(automation): provider column + codex master/worker automation origin`.

---

### Task 3 — Track B desktop: AutomationForm provider selector (TDD)

**Files (apps/desktop):** `src/renderer/components/AutomationForm.tsx` (provider select), i18n keys (reuse `workerSpawnModal.provider*` or add `automation.provider*`), Test: `test/automation-form*.test.tsx` (grep the real test file name).

- Read AutomationForm: how model/effort/permission_mode fields render + how the create/update payload is built. Add a `claude | codex` `<Select>` (default claude), wire `provider` into the payload. Mirror the WorkerSpawnModal provider idiom.
- If the form has a full Automation/AutomationInput literal in tests, the provider field addition may need fixture updates — run the desktop gate.

- [ ] Failing test (provider select → payload carries provider; default claude) → implement → dual gates.
- [ ] Commit: `feat(desktop): automation provider selector`.

---

### Task 4 — Docs + full gates

- [ ] AGENTS.md: automation section — automations can run codex (master/worker) via the automation `provider`; codex masters are bypass-only (a non-bypass codex automation fails its run). Codex master fork now works (seeds the new per-session CODEX_HOME from the source rollouts) — remove/replace the P2.5 "fork not supported" note.
- [ ] docs/2026-07-05-codex-backend-parity.md status: P3 (#1 fork + #8 automation) implemented; remaining P3: #2 handshake timeout, #3 delete-hook, #4 sub-table strip, #6 desktop settings fields, #7 orphan GC + Claude cost audit.
- [ ] docs/2026-07-06-p3-codex-fork-automation.md status blockquote: implemented; live smoke (real codex fork context-preserved) by controller.
- [ ] Full gates: root typecheck/test/build + desktop typecheck/test.
- [ ] Commit: `docs(codex): P3 fork + automation status`.

## Post-plan (controller)

Live smoke: real codex master session → turn (store a fact) → SessionManager.fork → turn on the fork recalling the fact (context preserved through the real stack + rollout seeding). Then fable final review → merge.

## Self-Review Notes

- Fork mechanism is live-spiked (whole sessions/ tree copy preserves context; single-file loses it).
- Layering: all CODEX_HOME/fs knowledge in the daemon router; SessionManager passes ids only.
- The P2.5 fork guard test flips to expect-success (sanctioned — the guarded behavior is intentionally removed).
- Automation provider is a creation attribute, not a turn override.
