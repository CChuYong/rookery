# 2026-07-06 — P1.5: Codex follow-ups (spec)

> Status 2026-07-06: **Implemented** — all 6 in-scope backlog items, Tracks A-E per the scope table below (item 3 folds into Track A). Live smoke PASS (priced resume turn costUsd 0.045562; usage probe confirmed total.outputTokens includes reasoning tokens).

Follow-up wave to P1 (`docs/2026-07-06-p1-codex-worker-backend.md`). Scope decided from the 8-item P1.5 backlog: **6 in, 2 re-deferred with rationale**.

## Scope decision

| # | Backlog item | Decision |
|---|---|---|
| 1 | Desktop provider UX (spawn selector, badges, settings section) | **IN** — Track A |
| 2 | Pricing: per-turn usage aggregation + RATES | **IN** — Track B |
| 3 | `codexBin` path guidance/field | **IN** — folded into Track A (settings field) + docs |
| 4 | In-app `codexApiKey` (CODEX_HOME redirection + RPC provisioning) | **IN** — Track C |
| 5 | config.toml trust-entry cleanup | **DEFER** — mutating the user's `~/.codex/config.toml` from the daemon is invasive; cosmetic-only harm. Documented residue. |
| 6 | forkSession ephemeral-child timeout | **IN** — Track D |
| 7 | numTurns granularity | **DEFER** — unreachable until automations gain `provider` (maxTurns is automation-only; automations are Claude-only). Spec caveat already in P1 doc. |
| 8 | workspace-write network semantics alignment | **IN (decided)** — Track E, see below |

## Track B — pricing: per-turn usage aggregation + RATES

Problem (final-review residual): `lastUsage` held only the turn's LAST `tokenUsage.last` (one model call) — filling RATES would silently underbill multi-call turns.

Design — per-update delta accumulation against the thread-cumulative `tokenUsage.total`:
- `CodexStream` tracks `prevTotal: CodexTokenUsageBreakdown | null` and `turnAccum: CodexTokenUsageBreakdown` (zeros).
- Init: fresh session → `prevTotal = zeros` (thread totals start at 0, so the first call's delta counts). Resumed session → `prevTotal = null`; the FIRST `thread/tokenUsage/updated` only sets the baseline (that one call is uncounted — bounded, documented; the resume response carries no usage baseline to do better).
- On every `thread/tokenUsage/updated`: if `prevTotal === null` → set it; else add clamped per-field deltas `max(0, total.x - prevTotal.x)` into `turnAccum`, then set `prevTotal = total`. (`last`-based context tracking unchanged.)
- On `turn_end`: `costUsd = turnCostUsd(modelForTurn, turnAccum)`; reset `turnAccum` to zeros. `modelForTurn = overrideModel ?? (opts.model || defaultModel())` (unchanged).
- RATES: filled with web-verified standard-tier prices (see table below, cited in the plan); unknown model → 0 (unchanged). Reasoning tokens bill as output tokens (Responses API convention) — `reasoningOutputTokens` is informational; `outputTokens` already includes billing-relevant output per OpenAI's usage reporting. The inclusive-input comment stays.

RATES (verified 2026-07-06 vs developers.openai.com/api/docs/pricing, standard tier, USD/1M):

| model | input | cachedInput | output |
|---|---|---|---|
| gpt-5.5 | 5.00 | 0.50 | 30.00 |
| gpt-5.5-pro | 30.00 | (no cache discount → use input rate) | 180.00 |
| gpt-5.4 | 2.50 | 0.25 | 15.00 |
| gpt-5.4-mini | 0.75 | 0.075 | 4.50 |
| gpt-5.4-nano | 0.20 | 0.02 | 1.25 |

Caveats baked into the table comment: reasoning tokens bill as output (Responses API); long-context surcharge (>272K input: 2× input / 1.5× output) NOT modeled — flat sub-272K rates (Codex's harness caps the window at ~258K for gpt-5.5, so the surcharge tier is effectively unreachable there); pro tiers have no cached-input discount (rate = input); `gpt-5.3`/`gpt-5.2` no longer publicly priced → intentionally absent (cost 0). Unknown model → 0 (unchanged).

## Track C — in-app `codexApiKey`

P1 deferred this because the app-server ignores `CODEX_API_KEY` env. Design (as sketched in the P1 spec):
- New write-only secret setting `codexApiKey` (same pattern as `anthropicApiKey` — never echoed by settings.get; nullable clear).
- When set, codex children run with `CODEX_HOME = <rookery home>/codex-home` (server-side resolver builds the env; dir `mkdirSync({recursive:true})` once). Session rollouts + auth.json then live under rookery's control — user's `~/.codex` untouched. When NOT set, behavior is exactly P1 (inherit `~/.codex`, `codex login`).
- Provisioning in `CodexStream.pump()` after `initialize`/`initialized`: if `deps.apiKey?.()` returns a key → `account/read` → if `requiresOpenaiAuth` → `account/login/start { type: "apiKey", apiKey }` (persists to the redirected auth.json; subsequent spawns skip via the `account/read` check). Login failure → stream throws (worker `error`, message names auth).
- `forkSession` ephemeral child: same env; no provisioning (auth.json persists from a prior session spawn; an auth failure surfaces as the fork error).
- ⚠️ Migration nuance (documented): toggling the key on/off after codex workers exist changes CODEX_HOME, so pre-existing thread rollouts live in the OTHER home — resume of old workers fails with a clean error until the key state is restored. Acceptable; noted in AGENTS.md pitfalls.
- `CodexBackendDeps` gains `apiKey?: () => string | undefined` and `env?: () => NodeJS.ProcessEnv | undefined`; `spawn(...)` call sites pass `{ env: deps.env?.() }`.

## Track D — fork timeout

`CodexBackend.forkSession`: wrap the handshake+fork in `Promise.race` with `FORK_TIMEOUT_MS = 15_000`; on timeout `client.close()` and reject `"codex fork timed out after 15s"`. Prevents a hung ephemeral child from wedging a `worker.fork` request forever.

## Track E — workspace-write network alignment (decision)

Decision: **rookery's workspace-write modes are always network-on** — workers routinely need npm/git, and Claude-parity modes never restricted network at all. Mechanism: the per-turn `turn/start` now ALWAYS includes `approvalPolicy` + `sandboxPolicy: sandboxPolicyFor(currentMode)` derived from the CURRENT mode (spawn-time mode or live override) — not only when an override was set. Turn overrides are sticky server-side, and the object form pins `networkAccess: true` for workspaceWrite, making network exposure identical regardless of path (spawn vs setPermissionMode) and independent of the user's codex config default. thread/start keeps the string `sandbox` (harmless; first turn/start immediately pins the explicit policy).

## Track A — desktop provider UX

(File map from renderer exploration — see the plan for exact paths.)
1. **Spawn UI**: provider select (`claude` default | `codex`) in the worker-spawn form; selecting codex swaps the model field's placeholder/default hint to the codex default model; `provider` rides the existing `fleet.spawn` client message (protocol already supports it).
2. **Badges**: provider chip on fleet worker rows and the worker pane header, driven by `WorkerRow.provider` (already on the wire; absent/`claude` → no badge or a neutral one — codex gets a visible badge).
3. **Settings → Codex section**: `codexBin` (text, placeholder `codex`, absolute-path help text mentioning desktop-daemon PATH), `codexWorkerModel` (text, placeholder gpt-5.5), `codexApiKey` (write-only secret field, same widget as anthropicApiKey). Renderer i18n keys added to ko+en catalogs.
4. Desktop main process untouched; renderer only.

## Out of scope (unchanged from P1)

Codex master (P2), nested-subagent panels for codex, `turn/steer`, dynamicTools, trust-entry cleanup (#5), numTurns granularity (#7).

## Testing

- Daemon: fake-codex gains a `tokenUsage`-rich multi-call turn script (two updates in one turn → cost sums both deltas); resume-baseline test (first update sets baseline, second counts); provisioning tests (apiKey set + requiresOpenaiAuth → login/start issued; not required → no login; login rejects → stream throws); fork-timeout test (fake that never answers thread/fork → rejects ~15s with fake timers or injected timeout); always-explicit sandboxPolicy assertion on first turn.
- Desktop: component tests per renderer conventions (spawn form provider select round-trip into the ws send; settings section set/clear; badge rendering from WorkerRow.provider).
- Live smoke after merge: spawn with settings-set `codexBin` absolute path + a priced turn logging non-zero costUsd (if RATES has gpt-5.5).
