# P2.5 Codex Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Land the P2.5 backlog — bridge token out of argv (Track A), turn watchdog (B), slack-thread-defs + slackProvider (C), desktop new-session provider selector + codexMasterModel field (D). Spec: `docs/2026-07-06-p25-codex-hardening.md`. Item 5 excluded (user); item 3 dissolved (no session-level maxTurns UI exists).

**Architecture:** Tracks A/B/C are daemon-only (`src/core/codex/*`, `src/daemon/*`, `src/tools/*`, settings, protocol); Track D is renderer-only. Track A is live-spiked (`.superpowers/sdd/probe-authlink.mjs`).

## Global Constraints

- **Node 22 first** every command: `source ~/.nvm/nvm.sh && nvm use 22`.
- ESM NodeNext (`.js`, `import type`); English comments; migrations append-only (none expected this wave); no `@anthropic-ai/claude-agent-sdk` or `../daemon/` imports under `src/core/codex/*`.
- **Dual gates** on any shared-type or renderer-visible change: root `npm run typecheck && npm test` AND `npm -w apps/desktop run typecheck && npm -w apps/desktop test`.
- New i18n notice codes / renderer keys go in BOTH ko+en catalogs (daemon `src/core/i18n.ts` and/or renderer `apps/desktop/src/renderer/i18n/locales/{ko,en}/*`; parity tests enforce).
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Sequencing**: Task 1 and Task 2 both edit `src/core/codex/codex-backend.ts` — run strictly in order (1 then 2) to avoid conflicts.

---

### Task 1 — Track A: bridge token → per-session CODEX_HOME config.toml + delete cleanup

**Status: dispatched separately** (`.superpowers/sdd/p25-task-1-prompt.md`). Summary for the record: `CodexBackendDeps.bridge.ensureSession` returns `{ codexHome }` (not `{ url }`); server.ts materializes `<config.home>/codex-homes/<sessionKey>/` with `config.toml` (0600, user config preserved + `[mcp_servers.rookery] url` appended) + `auth.json` (symlink to real when no in-app key, provisioned when key set); `CodexTurnStream` spawns with `CODEX_HOME` env, no `-c` arg; session.delete removes the dir + releases the bridge via one combined hook. Live-verified pattern. Commit: `feat(codex): bridge URL via per-session CODEX_HOME config.toml (token out of argv) + delete cleanup`.

---

### Task 2 — Track B: per-turn inactivity watchdog (TDD)

**Files:** Modify `src/core/codex/codex-backend.ts` (`CodexSessionBase` turn loop), `src/core/settings.ts` (`codexTurnIdleTimeoutMs` default 120000), `src/core/i18n.ts` (notice `notice.codexTurnTimeout` ko+en), `test/core/codex/codex-backend.test.ts`, `test/helpers/fake-codex.ts` (a "silent turn" script that emits `item/started` then never completes).

**Design:** in the turn wait (`sendTurn`/the per-turn loop), arm a timer on `turn/start`; RESET it on every inbound notification (any event, incl. `item/*/outputDelta` = progress); on fire after `idleTimeoutMs` of total silence → `turn/interrupt` (graceful) then, if no `turn/completed` within a short grace (e.g. 5s), `client.close()` and `channel.fail(new Error(...))` with a transcript notice push (`notice.codexTurnTimeout`, params: seconds). Disarm on `turn/completed`, interrupt, abort, and stream end. Timeout is injected (deps resolver `idleTimeoutMs?: () => number`, server passes `() => settings.codexTurnIdleTimeoutMs()`; 0 disables). Tests inject a tiny timeout via a test-only deps value (NOT real 120s). Applies to both worker and turn streams (shared base) — harmless for a healthy turn.

- [ ] Failing test: silent-turn fake + tiny timeout → stream fails with the timeout notice; a normally-progressing multi-event turn with the same tiny timeout does NOT trip (events reset the timer); interrupt/abort disarm (no timeout notice after a clean interrupt).
- [ ] Implement (timer arm/reset/disarm in the base; settings value; notice code both catalogs; fake silent-turn knob).
- [ ] Gates: `npx vitest run test/core/codex/ && npm run typecheck && npm test`.
- [ ] Commit: `feat(codex): per-turn inactivity watchdog (interrupt+fail a wedged turn)`.

---

### Task 3 — Track C: slack-thread as defs + slackProvider (TDD)

**Files:** Modify `src/tools/slack-thread-tools.ts` (export `slackThreadToolDefs(reader, channel, threadTs): SdkMcpToolDefinition[]`; `createSlackThreadToolsServer` wraps it — byte-parity), `src/slack/capabilities.ts` (`makeSlackCapabilities` returns the read_thread tool via the `caps.toolDefs` channel P2 added, alongside the existing systemPromptAppend hint), `src/daemon/server.ts` (the makeCapabilities slack branch uses toolDefs), `src/core/settings.ts` (`slackProvider(): "claude"|"codex"` default "claude" + protocol settings.set key), `src/core/session-manager.ts` (`getOrCreateByKey` gains optional provider, threaded to `create`), `src/slack/handle-incoming.ts` (pass `settings.slackProvider()` — read how settings reach the slack handler), `src/protocol/messages.ts` (settings.set `slackProvider` enum). Tests: slack-thread defs shape/name; makeSlackCapabilities surfaces read_thread via toolDefs (fake); slackProvider default/override; getOrCreateByKey passes provider (a codex slack session builds on the codex backend — recording fake).

**Note:** codex masters are bypassPermissions-only (P2 guard) — a slack codex session inherits it; slackProvider defaults claude (opt-in). Automation-origin codex is OUT (P3) — do not touch automation.

- [ ] Failing tests → implement → dual gates (settings.set schema is renderer-visible; desktop fixtures already carry other settings but slackProvider is new — check if any desktop `SettingsValues` literal needs it: slackProvider is settings-only, NOT in SettingsValues if it's a plain setting; mirror how slackLocale is typed — if it's in SettingsValues, update the 5 fixtures; if secret-style/settings-only, no fixture change. VERIFY before assuming).
- [ ] Commit: `feat(slack): read_thread via defs for codex slack sessions; slackProvider setting`.

---

### Task 4 — Track D: desktop new-session provider selector + codexMasterModel field (TDD)

**Files (apps/desktop):** `src/renderer/components/NewSessionPage.tsx`, `src/renderer/App.tsx` (startSession), `src/renderer/store/store.ts:16` (add `provider?: string` to the inline session-row type), `src/renderer/components/SettingsPage.tsx` (codexMasterModel field), `src/renderer/i18n/locales/{ko,en}/settings.ts` + `.../newSessionPage.ts` (or wherever NewSessionPage keys live — grep), Test: `test/new-session-page-*.test.tsx`, `test/settings-page.test.tsx`.

Anchors (from the renderer map):
- NewSessionPage: state `cwd/model/effort` at :35-37, `start()` :53 → `onStart({cwd,prompt,model,effort})`. Add `provider` state (default "claude") + a `<Select>` (WorkerSpawnModal idiom, i18n `workerSpawnModal.provider*` reusable or new `newSession.provider*` keys — reuse the existing workerSpawnModal keys to avoid duplication if the labels fit); when codex, swap the model picker to a free-text field with `codexDefaultModel` placeholder. Pass `provider` (undefined for claude) up through `onStart`.
- App.startSession (:537-580): extend the `onStart` payload type + the `session.create` request with `provider`; for codex, stamp the codex model as the override instead of the Claude picker's (:548). Pass `codexDefaultModel={s.settings?.codexMasterModel || "gpt-5.5"}` to NewSessionPage.
- SettingsPage (:373-375): 3-line copy for `codexMasterModel` (`f.codexMasterModel ?? ""`, placeholder gpt-5.5). i18n keys mirror `settings.codexWorkerModel`/Hint (ko+en). Fixtures already carry codexMasterModel (P2) — no fixture edits.
- store.ts:16: add `provider?: string`.

- [ ] Failing tests (new-session provider select: default→undefined, codex→"codex" in the onStart/request; model swaps to free-text; settings codexMasterModel field round-trips into onSave(f)) → implement → dual gates (renderer + root untouched).
- [ ] Commit: `feat(desktop): new-session provider selector + codexMasterModel settings field`.

---

### Task 5 — Docs + full gates

- [ ] AGENTS.md: master-on-codex passage — the bridge token now lives in a per-session CODEX_HOME config.toml (0600), not argv; codex masters get a per-session CODEX_HOME (rollouts + auth there). Slack sessions can be codex via the `slackProvider` setting (bypassPermissions-only). Turn watchdog note.
- [ ] docs/2026-07-05-codex-backend-parity.md status: P2.5 implemented (argv-token hardening, watchdog, slack codex origin, desktop new-session UI); remaining: automation-origin codex (P3), persistent child pool.
- [ ] docs/2026-07-06-p25-codex-hardening.md: status blockquote — implemented; live smoke (argv-clean bridge round-trip) done by controller.
- [ ] Full gates: root typecheck/test/build + desktop typecheck/test.
- [ ] Commit: `docs(codex): P2.5 status + hardening notes`.

## Post-plan (controller)

Live smoke: codex master turn with the token ONLY in config.toml — grep the child's `/proc`/`ps` argv to confirm no token, and confirm a bridge tool still fires. Watchdog: optional real-binary silent-turn is impractical; unit coverage suffices. Then fable final review → merge.

## Self-Review Notes

- Task 1/2 sequencing (both touch codex-backend.ts) is called out.
- Track C keeps automations claude-only (P3) — the biggest risk-reduction of the wave.
- item 3 dissolved with evidence (no session maxTurns UI); effort select correctly left on for codex (codex supports effort).
