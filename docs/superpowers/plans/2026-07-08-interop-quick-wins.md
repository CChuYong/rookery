# Codex↔Claude interop — Quick Wins Implementation Plan

> From the 2026-07-08 `codex-claude-interop` exploration (wf_9b169a7c-7b9). Quick wins = high-impact / low-effort, mostly additive. TDD, commit per unit. Branch `feat/interop-quick-wins`.

**Goal:** make a mixed Claude/Codex setup legible and discoverable everywhere the mix already exists — without new capabilities (fork/switch are separate strategic bets).

## Global constraints
- Code comments in English; Korean default i18n; new `notice.*` codes go in BOTH `src/core/i18n.ts` and the desktop renderer catalog with identical params.
- Gates: root `npm run typecheck && npm test`; desktop `npm -w apps/desktop run typecheck && npm -w apps/desktop test`.
- No daemon/protocol shape changes beyond additive fields; no push/tag.

## Unit A — Desktop provider visibility (QW1)
`ProviderBadge` (renders "Codex" for codex, nothing for claude) is already on workers (RepoTree, WorkerHeader) and automations, but NOT on master sessions.
- **Files:** `apps/desktop/src/renderer/views/Sessions.tsx` (session Row — render `<ProviderBadge provider={s.provider} />` next to `OriginBadge`), `apps/desktop/src/renderer/components/WorkspaceHeaders.tsx` or the session header (render provider next to the session name). Test: `apps/desktop/test/*`.
- Data already flows: `session.list.result` carries `provider`; store `sessions[].provider`.

## Unit B — Master fleet-tool backend-awareness (QW2, QW6)
`fleet.list()` items already carry `provider`; `list_workers`/`get_worker_status` formatters drop it.
- **Files:** `src/tools/fleet-tools.ts`. Test: `test/tools/fleet-tools.test.ts`.
- `list_workers`: tag each line with provider (`[status·provider]`) + add an optional `provider` filter (mirrors the `status`/`repo` filters). Update the tool description.
- `get_worker_status`: append the worker's provider (`repos.getWorker(id)?.provider`).

## Unit C — Provider-attributed settlement notifications (QW3)
Worker-settled notices don't name the backend.
- **Files:** `src/core/worker-notifier.ts` (WorkerNotification + buildWorkerNotice/formatNotificationLine), `src/core/i18n.ts` (`notice.workerDone/Failed/Stopped` params), desktop renderer `notice.*` catalog. Tests: `test/core/worker-notifier.test.ts` + i18n parity.
- Thread `provider` (from the worker row, legacy → "claude") into the notification payload + notice params. Keep ko/en catalogs in lockstep.

## Unit D — Discoverability (QW4, QW5, QW7)
- **OnboardingModal:** one ConceptRow line — "Backends: pick Claude or Codex per session/worker/automation" (ko/en). File: `apps/desktop/src/renderer/components/OnboardingModal.tsx` (+ i18n).
- **README:** a short "Choosing a backend" note centralizing the bypassPermissions-only / Claude-vs-Codex tradeoff. File: `README.md`.
- **CLI `--help`:** usage text documenting `--provider claude|codex`. Files: `src/index.ts` / `src/entrypoints/cli.ts`.

## Verification — DONE (2026-07-08)
- All 4 units shipped via TDD (5 commits on `feat/interop-quick-wins`). Root `npm test` = **903 passed**, desktop = **909 passed**, both typecheck clean.
- QW1 (session provider badge), QW2/QW6 (fleet-tool provider + filter), QW3 (provider-attributed notifications), QW4/QW5/QW7 (onboarding + README + CLI --help).
- Deferred (strategic bets, separate work): cross-provider fork, codex auth-status probe, codex effort defaults / tool_progress heartbeat.
