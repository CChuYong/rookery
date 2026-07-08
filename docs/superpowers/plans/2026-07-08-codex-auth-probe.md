# Codex auth-status probe — Implementation Plan

> **STATUS: COMPLETE** (branch `feat/codex-auth-probe`, 5 commits, TDD). All 4 units landed; root (typecheck + 918 tests) & desktop (typecheck + 914 tests) green. Refinement beyond the plan: the desktop store slot is **tri-state** (`CodexAuthStatus | "unavailable" | null`) — null=probing ("checking"), "unavailable"=probe ran but couldn't determine (codex missing/broken), object=real status — because codex's probe returns null when the app-server can't spawn (unlike Claude's always-resolving probe), which would otherwise strand the card on a "checking" spinner. Not yet merged to main.


> Strategic bet #2 from the 2026-07-08 interop exploration. Codex has no auth-readiness probe (Claude does, `getAuthStatus`), so picking codex gives zero signal until a turn fails mid-run — worst for unattended workers/automations, and a prerequisite for a "Fork to Codex" affordance. TDD, commit per unit. Branch `feat/codex-auth-probe`.

**Goal:** surface whether Codex is authenticated (and how) in the Settings Codex sub-tab, mirroring the Claude auth card.

## Ground truth (verified against codex-cli 0.142.5 via `app-server generate-ts`)
`account/read` (`GetAccount`) returns `{ account: Account | null, requiresOpenaiAuth: boolean }` where
`Account = { type: "apiKey" } | { type: "chatgpt", email: string|null, planType: PlanType } | { type: "amazonBedrock", credentialSource }`.

## Design
- **Probe** (`src/core/codex-auth-provider.ts`, mirrors `codex-models-provider.ts`): a short-lived `codex app-server` child, spawned with the SHARED `codexEnv`/`codexApiKey` resolvers (same redirected CODEX_HOME the turns use — critical per findings [25]/[26], or it misreports). Flow mirrors `CodexBackend.openClient`: `initialize` → `account/read` → if `apiKey` set AND `requiresOpenaiAuth` → `account/login/start {type:apiKey}` (provision) → `account/read` again → map. **No cache** (auth changes); every failure → `null` (never throws), like codexModels.
- **`CodexAuthStatus`**: `{ method: "api-key" | "chatgpt" | "bedrock" | "none"; ready: boolean; hint: string | null }`. `ready = !requiresOpenaiAuth && account != null`; `method` from `account.type`; `hint` = chatgpt email (+ ` · plan`), else null.
- **Protocol** (`messages.ts`): `codex.authStatus` request → `codex.authStatus.result { status: CodexAuthStatus | null }`. `CodexAuthStatus` re-declared structurally (like `CodexModelInfo`).
- **Wiring** (`server.ts` + `connection.ts`): `makeCodexAuthProvider({ spawn: realCodexSpawn(codexBin), env: codexEnv, apiKey: codexApiKey })`; Connection handles `codex.authStatus` → `codexAuth?.status() ?? null`.
- **Desktop**: store slot `codexAuthStatus` + setter; fetch on connect (next to `codex.models.list`) AND refetch after the codex key is saved (SettingsPage `onSaveCodexKey`); render a dot+label+hint card in the Codex sub-tab of the Models settings tab, mirroring the Claude auth card. New i18n keys (ko/en).

## Units (TDD, commit each)
1. **Provider** — `codex-auth-provider.ts` + `makeCodexAuthProvider`/`mapCodexAuth`. Test via `fakeCodexSpawn` (add scripted `account/read` responses: apiKey / chatgpt / not-authed + provision path). Root.
2. **Protocol + wiring** — `codex.authStatus` message + Connection handler + server.ts. Test `connection.test.ts` (injected fake provider).
3. **Desktop store + fetch** — `codexAuthStatus` slot, connect fetch, refetch-after-save. Test store + App wiring where feasible.
4. **Desktop UI** — Codex sub-tab auth card + i18n. Test `settings` rendering (codex sub-tab shows the method/ready).

## Verification
- Root + desktop typecheck + tests green; i18n parity. Optional review.
- Out of scope (later): rate-limit/usage surfacing (`account/rateLimits/read`), a "log in with ChatGPT" button, using the probe to gate a future "Fork to Codex".
