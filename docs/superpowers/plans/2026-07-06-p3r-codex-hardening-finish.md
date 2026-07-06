# P3-remaining Codex Hardening Finish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** finish the Codex-track backlog — handshake timeout, stripRookeryBlock sub-tables, rounding, orphan GC, delete-hook relocation, desktop settings fields + automation hint/badge. Spec: `docs/2026-07-06-p3r-codex-hardening-finish.md`.

**Architecture:** Track A+B daemon (`src/core/codex/codex-backend.ts`, `src/daemon/codex-home.ts`, `src/daemon/server.ts`, `src/core/session-manager.ts`, settings, protocol). Track C renderer.

## Global Constraints

- **Node 22 first**; ESM NodeNext (`.js`, `import type`); English comments; no `@anthropic-ai/claude-agent-sdk` / `../daemon/` imports under `src/core/codex/*`.
- **Dual gates** on shared-type/renderer changes: root + `npm -w apps/desktop`.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Sequencing: Task 1 (codex-backend/codex-home) before nothing conflicting; Task 2 (server/session-manager) is separate files; Task 3 renderer. Run 1→2→3→4.

---

### Task 1 — Track A: handshake timeout + stripRookeryBlock sub-tables + rounding (daemon, TDD)

**Files:** `src/core/codex/codex-backend.ts`, `src/daemon/codex-home.ts`, `src/core/settings.ts` (`codexHandshakeTimeoutMs` default "30000", mirror `codexTurnIdleTimeoutMs`: SettingsValues + all() + accessor + protocol settings.set key), `src/daemon/server.ts` (pass `handshakeTimeoutMs: () => settings.codexHandshakeTimeoutMs()` into CodexBackend deps), desktop SettingsValues fixtures (the 5+ literals gain `codexHandshakeTimeoutMs: "30000"` — dual gate). Tests: `test/core/codex/codex-backend.test.ts`, `test/daemon/codex-home.test.ts`, `test/core/settings.test.ts`.

- **#2 handshake timeout**: `CodexBackendDeps.handshakeTimeoutMs?: () => number`. In `pump()`, wrap the `openClient()` + `startOrResumeThread()` phase in a `Promise.race` with a timeout (mirror `forkSession`'s P1.5 timer: `setTimeout` → reject; clear in finally). On timeout: `client.close()` (if a client exists yet) + throw `new Error("codex handshake/thread-start timed out after ${s}s")` → pump rejects → stream fails → worker/master terminal error. Resolve the timeout ONCE per stream (`?? 0`; `<=0` disables — no timer). NOTE: openClient creates the client; structure so a timeout during openClient still closes whatever was created (or the transport is killed). Read the current pump() structure and place the race around exactly the pre-first-turn handshake+thread-start, NOT the turn loop (the idle watchdog owns the turn loop).
- **#4 stripRookeryBlock**: in codex-home.ts, extend the block detection to also strip any header matching `[mcp_servers.rookery.` (a sub-table). Read the current `stripRookeryBlock` (textual TOML) and make it drop the `[mcp_servers.rookery]` block AND every `[mcp_servers.rookery.<...>]` sub-table body.
- **#5 rounding**: add a tiny `formatDuration(ms)` helper (`ms < 1000 ? \`${ms}ms\` : \`${Math.round(ms/1000)}s\``) and use it in the idle-timeout notice text (codex-backend.ts:282).

- [ ] Failing tests: handshake-stall fake (never completes initialize/thread-start) + tiny timeout → stream fails with /handshake.*timed out/; normal handshake + tiny timeout → turn starts (no false trip); 0 disables (a slow-but-completing handshake succeeds). stripRookeryBlock strips `[mcp_servers.rookery.headers]`. formatDuration cases. settings codexHandshakeTimeoutMs default/override.
- [ ] Implement → gates: `npx vitest run test/core/codex/ test/daemon/ test/core/settings.test.ts && npm run typecheck && npm test && npm -w apps/desktop run typecheck && npm -w apps/desktop test`.
- [ ] Commit: `feat(codex): handshake/thread-start timeout; strip rookery sub-tables; friendlier duration format`.

---

### Task 2 — Track B: orphan codex-homes GC + onSessionDelete relocation (daemon, TDD)

**Files:** `src/daemon/codex-home.ts` (`gcOrphanCodexHomes`), `src/daemon/server.ts` (boot GC call + onSessionDelete via SessionManager deps), `src/core/session-manager.ts` (`SessionManagerDeps.onSessionDelete?` + call in delete()). Tests: `test/daemon/codex-home.test.ts`, `test/core/session-manager.test.ts`, `test/daemon/server.test.ts` (if it has a boot test).

- **#7 GC**: `gcOrphanCodexHomes(rookeryHome, liveSessionIds: Set<string>): void` — `const base = path.join(rookeryHome, "codex-homes"); if (!existsSync(base)) return; for (const name of readdirSync(base)) if (!liveSessionIds.has(name)) removeCodexHome(rookeryHome, name);` best-effort, never throws. In server.ts boot (after `repos.resetRunningSessions()` etc.): `gcOrphanCodexHomes(config.home, new Set(repos.listSessions().map(s => s.id)))`. Comment: boot-only, no live op races it.
- **#3 delete hook**: `SessionManagerDeps.onSessionDelete?: (id: string) => void`; call it in `SessionManager.delete(id)` best-effort (try/catch, after `deleteSession`). server.ts: pass `onSessionDelete` in the SessionManager deps (the existing `const onSessionDelete` closure). REMOVE the Connection-side call of that closure (find where Connection invokes `(id) => bridge.release(id)` / the onSessionDelete — grep `bridge.release` in connection.ts and the Connection ctor arg) so it fires exactly ONCE from SessionManager.delete. If Connection needs the arg for another reason, verify; otherwise drop it. Ensure no double-release and no zero-release (a test asserts onSessionDelete fires once per delete).

- [ ] Failing tests: gcOrphanCodexHomes (temp base with a/b/c, live {a,c} → only b removed; no base → no-op); SessionManager.delete calls onSessionDelete once (spy) after cascade; Connection no longer calls it (grep/verify + a test that delete via connection triggers exactly one release). → implement → gates (root; connection change → run test/daemon).
- [ ] Commit: `feat(codex): boot GC for orphan codex-homes; onSessionDelete owned by SessionManager.delete`.

---

### Task 3 — Track C: desktop settings fields + automation hint/badge (renderer, TDD)

**Files (apps/desktop):** `src/renderer/components/SettingsPage.tsx` (codexTurnIdleTimeoutMs in Codex section, slackProvider in Slack section, codexHandshakeTimeoutMs in Codex section — from Task 1), `src/renderer/components/AutomationForm.tsx` (codex+non-bypass hint), `src/renderer/views/AutomationPage.tsx` or the automation-list component (provider badge — grep the list row), i18n locales. Tests: `test/settings-page.test.tsx`, `test/automation-form.test.tsx`, the automation-page test.

- Settings: `codexTurnIdleTimeoutMs` + `codexHandshakeTimeoutMs` text Inputs in the Codex section (f-backed, placeholders 120000/30000, hint "0 disables"); `slackProvider` `<Select>` (claude|codex) in the Slack section (labels reuse `workerSpawnModal.provider*`, hint: codex slack is bypassPermissions-only). i18n ko+en keys. Fixtures: codexTurnIdleTimeoutMs/slackProvider already present (P2.5); codexHandshakeTimeoutMs added in Task 1.
- AutomationForm: a warning element when `provider === "codex" && permissionMode !== "bypassPermissions"` (i18n ko+en). Mirror any existing warning element's styling.
- AutomationPage: `ProviderBadge` (codex-only) on list rows where `provider === "codex"`.

- [ ] Failing tests: settings fields round-trip into onSave(f); AutomationForm hint shows for codex+plan, hidden for codex+bypass and claude+plan; AutomationPage badge on a codex automation row. → implement → dual gates.
- [ ] Commit: `feat(desktop): codex timeout/slackProvider settings fields; automation codex hint + provider badge`.

---

### Task 4 — Docs + full gates

- [ ] AGENTS.md: note the codex handshake timeout (`codexHandshakeTimeoutMs`) alongside the turn watchdog; boot GC for orphan codex-homes; onSessionDelete owned by SessionManager.delete. Slack/automation codex are UI-selectable (settings/automation form) now.
- [ ] docs/2026-07-05-codex-backend-parity.md status: P3-remaining hardening done; remaining backlog = the carried non-Codex items only (Claude cost audit, budget guards, sessions.test.tsx flake, dockable/UI-audit/cross-platform).
- [ ] docs/2026-07-06-p3r-codex-hardening-finish.md status blockquote: implemented.
- [ ] Full gates: root typecheck/test/build + desktop typecheck/test.
- [ ] Commit: `docs(codex): P3-remaining hardening status`.

## Post-plan (controller)

Live smoke (optional, cheap): handshake timeout is unit-covered; a real-binary handshake-stall is impractical (would need a broken bridge). GC + settings are pure logic. Skip live smoke; fable final review → merge.

## Self-Review Notes

- Handshake timeout is separate from the idle watchdog (covers the pre-turn phase the watchdog can't).
- GC is boot-only (no race with live ops).
- onSessionDelete single-owner move must fire exactly once — test asserts it.
- codexHandshakeTimeoutMs is a NEW SettingsValues key → desktop fixtures (the P1 dual-gate lesson).
