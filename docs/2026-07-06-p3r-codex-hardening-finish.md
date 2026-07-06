# 2026-07-06 — P3-remaining: Codex hardening finish (spec)

Closes the Codex-track backlog (user pick "#3 only, finish it"). All mechanical hardening/UX — no new architecture, no spike needed.

## Scope

| Item | Track |
|---|---|
| #2 handshake/thread-start timeout (watchdog pre-arm blind spot) | A (daemon) |
| #4 `stripRookeryBlock` also strips `[mcp_servers.rookery.*]` sub-tables | A (daemon) |
| #5 sub-second watchdog-timeout rounding (cosmetic) | A (daemon) |
| #7 orphan `codex-homes/` boot GC | B (daemon lifecycle) |
| #3 `onSessionDelete` hook into `SessionManager.delete` | B (daemon lifecycle) |
| #6 desktop fields: `codexTurnIdleTimeoutMs` (Codex section) + `slackProvider` (Slack section) | C (renderer) |
| AutomationForm codex+non-bypass hint | C (renderer) |
| AutomationPage provider badge | C (renderer) |

## Track A — codex-backend / codex-home small fixes

**#2 handshake/thread-start timeout.** The P2.5 watchdog arms only after the `turn/start` RESPONSE (`codex-backend.ts:332`), so a child wedged during `openClient` (spawn + initialize + provisioning) or `startOrResumeThread` (thread/start|resume) never trips it — only a manual stop recovers. Fix: in `pump()`, wrap the `openClient()` + `startOrResumeThread()` phase in a timeout race (like `forkSession`'s P1.5 timeout): if the handshake+thread-start doesn't complete within `codexHandshakeTimeoutMs` (default 30000 — generous for a cold Rust-binary spawn + auth; 0 disables), `client.close()` and reject the pump → the stream FAILS (worker/master goes terminal `error` with a clear message `codex handshake/thread-start timed out after Ns`). No i18n notice needed — it's a terminal stream failure (worker records the error), not a mid-turn transcript notice like the idle watchdog. Injected resolver `handshakeTimeoutMs?: () => number` in `CodexBackendDeps`; server passes `() => settings.codexHandshakeTimeoutMs()`. New setting `codexHandshakeTimeoutMs` default "30000" (mirror `codexTurnIdleTimeoutMs` shape in SettingsValues + all() + protocol settings.set key + desktop fixtures — the 5+ SettingsValues literals).

**#4 stripRookeryBlock sub-tables.** `stripRookeryBlock` (codex-home.ts:131) removes `[mcp_servers.rookery]` but a user config carrying `[mcp_servers.rookery.headers]` (or any `[mcp_servers.rookery.*]` sub-table) survives and orphan-attaches to the freshly appended block. Fix: also strip any table header starting with `[mcp_servers.rookery.` (dot after rookery) so the whole rookery namespace is replaced cleanly. Only reachable if a user hand-writes rookery config into `~/.codex/config.toml`, but keeps the block canonical.

**#5 rounding.** `Math.round(this.idleTimeoutMsForTurn / 1000)` (codex-backend.ts:282) renders sub-second (test-sized) timeouts as "0s"/"1s". Cosmetic; irrelevant at the 120s default. Fix: for `<1000ms` show the ms (`${ms}ms`) else `${round(ms/1000)}s` — a tiny format helper. Only affects the timeout notice text.

## Track B — lifecycle (server.ts / session-manager / codex-home)

**#7 orphan codex-homes GC.** A session delete that crashes between the DB cascade and the best-effort `removeCodexHome`, or a fork whose `createSession` throws after `seedCodexHomeFromSource`, leaves a stray `<home>/codex-homes/<id>/` dir. Fix: a boot sweep. New `gcOrphanCodexHomes(rookeryHome, liveSessionIds: Set<string>): void` in codex-home.ts — `readdirSync(<home>/codex-homes)`, for each entry whose name is NOT in `liveSessionIds`, `removeCodexHome`. Best-effort, never throws (missing dir → no-op). Call at boot in server.ts AFTER `fleet.rehydrate()`/`resetRunningSessions()` (grep the boot cleanup block), with `new Set(repos.listSessions().map(s => s.id))`. ⚠️ Boot-only (no in-flight forks/creates at startup), so it can't race a mid-fork home. Document.

**#3 onSessionDelete into SessionManager.delete.** The combined `onSessionDelete` closure (bridge.release + removeCodexHome, server.ts:161) is passed to the Connection ctor and called from `connection.ts` — the ONLY delete caller today, but a future programmatic `SessionManager.delete` would leak. Fix: add `onSessionDelete?: (id: string) => void` to `SessionManagerDeps`; call it inside `SessionManager.delete` (best-effort, after the cascade `deleteSession`); server.ts injects the closure via deps instead of (or in addition to — pick ONE owner) the Connection path. Keep it best-effort/never-throw. Remove the now-redundant Connection-side call so it fires exactly once from the single owner (SessionManager.delete). Verify no double-release.

## Track C — desktop

**#6 settings fields.** `SettingsPage.tsx`: (a) `codexTurnIdleTimeoutMs` — a number/text `<Input>` in the existing **Codex** section (beside codexBin/codexWorkerModel/codexMasterModel), value `f.codexTurnIdleTimeoutMs ?? ""`, placeholder "120000", hint "0 disables"; (b) `slackProvider` — a claude|codex `<Select>` in the existing **Slack** section (it's a slack setting), value `f.slackProvider ?? "claude"`, labels reuse `workerSpawnModal.providerClaude/Codex`, hint noting codex slack is bypassPermissions-only. i18n ko+en. Fixtures already carry both keys (P2.5) — no fixture edits (codexHandshakeTimeoutMs from Track A WILL need fixtures — see Track A). Both are f-backed → saved by the existing bulk Save.

**AutomationForm codex+non-bypass hint.** The form exposes all permission modes for master actions; codex + a non-bypass mode builds an automation that fails every run (cleanly, per the P2 guard). Add a warning element (mirror the existing bypass-warning if there is one) shown when `provider === "codex" && permissionMode !== "bypassPermissions"`: "Codex sessions require bypassPermissions — this automation will fail every run." i18n ko+en.

**AutomationPage provider badge.** The automation list rows don't show which backend a rule runs on. Add a small codex badge (reuse `ProviderBadge`, codex-only like elsewhere) on rows where `automation.provider === "codex"`. The Automation type carries provider (P3).

## Non-goals

The carried non-Codex items (Claude cost audit, budget guards, sessions.test.tsx flake, dockable/UI-audit/cross-platform threads) — this wave finishes the Codex track only.

## Testing

- Track A: handshake timeout — a fake-codex that stalls during initialize/thread-start (never answers) + tiny `codexHandshakeTimeoutMs` (fake timers) → stream fails with the handshake-timeout error; a normal handshake with the tiny timeout still starts the turn; 0 disables. stripRookeryBlock — a config with `[mcp_servers.rookery.headers]` → the sub-table is stripped, one clean rookery block remains. rounding — format helper unit test (`500ms`→"500ms", `120000`→"120s").
- Track B: gcOrphanCodexHomes — temp home with dirs `a`,`b`,`c`, liveSessionIds {a,c} → only `b` removed; missing codex-homes → no-op. SessionManager.delete calls onSessionDelete once (spy); Connection no longer double-calls.
- Track C: component tests — settings codexTurnIdleTimeoutMs + slackProvider round-trip into onSave(f)/saved; AutomationForm hint shows only for codex+non-bypass; AutomationPage badge on codex rows. Dual gates (SettingsValues gains codexHandshakeTimeoutMs → fixtures).

## Risks
- Handshake timeout false-positive on a very cold first spawn (Rust binary + auth): 30s is generous; configurable; 0 disables. If a machine is slow, the setting bumps it.
- GC deleting a home for a session being created at the exact boot instant: boot GC runs before the daemon accepts connections / before any fork/create, so no live operation races it — documented.
- onSessionDelete single-owner move: must verify bridge.release/removeCodexHome fire exactly once (not zero, not twice) after the relocation — the test asserts it.
