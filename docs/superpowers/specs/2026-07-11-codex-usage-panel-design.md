# Codex usage in the Usage panel (provider tabs) — design

**Date:** 2026-07-11 · **Branch:** worktree-codex-usage-panel (worktree off 6e722cd) · **Approved scope:** gauges + tokens, provider tab toggle (Claude default)

## Problem

The desktop's bottom-left Usage panel only shows Claude usage (ccusage tokens/$ + OAuth utilization %). Codex has directly analogous live sources — verified against a real `codex app-server` (0.144.1) on 2026-07-11:

- **`account/rateLimits/read`** → `{ rateLimits: { primary: { usedPercent, windowDurationMins: 300, resetsAt }, secondary: { usedPercent, windowDurationMins: 10080, resetsAt }, planType, … } }` — the 5-hour and weekly utilization gauges (unix-seconds resets).
- **`account/usage/read`** → `{ summary: { lifetimeTokens, … }, dailyUsageBuckets: [{ startDate: "YYYY-MM-DD", tokens }, …] }` — per-day token counts (no USD — plan billing).

Both respond on a bare initialized client (no thread needed). `account/rateLimits/updated` also arrives as a notification on running children, but a poll provider covers the idle case uniformly.

## Approach (chosen)

A poll provider mirroring `codex-models-provider.ts`: short-lived `codex app-server` child → `initialize` → (optional in-app `codexApiKey` provisioning, same as models/auth providers) → the two read RPCs → tolerant mapping → `null` on any failure, **never cached** (rate limits must stay fresh; the collector's interval is the cadence). Plugged into the existing `UsageCollector` alongside `oauthUsage`; flows to the desktop through the existing `usage.get` snapshot unchanged.

Rejected: passive capture of `account/rateLimits/updated` from running workers (no data while idle, no daily tokens, invasive backend→collector plumbing); parsing `~/.codex` rollouts ccusage-style (duplicates what `account/usage/read` already aggregates server-side).

## Design

### 1. Provider — `src/core/codex-usage-provider.ts` (new)

```ts
export interface CodexRateWindow { usedPercent: number; resetsAt: number | null } // resetsAt: unix seconds
export interface CodexUsage {
  fiveHour: CodexRateWindow | null;   // rateLimits.primary (observed windowDurationMins 300)
  sevenDay: CodexRateWindow | null;   // rateLimits.secondary (observed 10080)
  planType: string | null;
  todayTokens: number | null;         // dailyUsageBuckets bucket with startDate === today (local)
  weeklyTokens: number | null;        // sum of buckets within the last 7 days (today inclusive)
}
export function makeCodexUsageProvider(opts: { spawn: CodexSpawn; timeoutMs?: number; env?: () => NodeJS.ProcessEnv | undefined; apiKey?: () => string | undefined; now?: () => Date }): { fetch(): Promise<CodexUsage | null> }
```

- One child per `fetch()`: initialize → apiKey provisioning (same `account/read` → `account/login/start` dance as the models provider; skipped when no in-app key) → `account/rateLimits/read` + `account/usage/read` → kill. `Promise.race` timeout (default 10 000 ms) on every await; ANY failure (spawn, timeout, RPC error, malformed) → `null`, never throws, never caches.
- Tolerant duck-typed decode. Primary/secondary map to fiveHour/sevenDay positionally (the observed shape); a missing/malformed window → that field `null`. If `account/usage/read` fails but rateLimits succeeded, still return the gauges with `todayTokens`/`weeklyTokens` null (partial data beats none) — and vice versa.
- `env`/`apiKey` are the SAME resolvers the codex turn children use (account-mismatch prevention — parity with findings [25]/[26] on the models provider).
- Pure mapping helpers exported for tests (`mapCodexUsage(rateLimitsRes, usageRes, now)`).
- Live-observed (2026-07-11): the server materializes `dailyUsageBuckets` with a lag (no bucket for the current day mid-day despite heavy usage), so `todayTokens` is null — and the Stat hidden — until today's bucket exists; a false 0 would mislead.

### 2. Snapshot + collector — `src/core/usage.ts`

- `UsageSnapshot` gains `codex: CodexUsage | null` (add to `emptyUsage()` as `null`).
- `UsageCollector` opts gain `codexUsage?: () => Promise<CodexUsage | null>`. In `doCollect()`, fetch it like `oauthUsage`: on success (non-null) replace `snap.codex` and stamp `updatedAt`; on `null`/throw keep the previous value (a transient failure must not blank the panel).
- Ordering: run it after the oauth block, before ccusage (fast → slow). The existing `collecting` in-flight guard already prevents pile-up.

### 3. Wiring — `src/daemon/server.ts`

`makeCodexUsageProvider({ spawn: realCodexSpawn(() => settings.codexBin()), env: codexEnv, apiKey: codexApiKey })` (the same closures the models provider uses), passed to the `UsageCollector` constructor as `codexUsage: provider.fetch`. Protocol untouched — `usage.get`/`usage.result` already carry `UsageSnapshot` structurally.

### 4. Desktop — `UsagePanel.tsx` provider tabs

- The header row gains a tiny segmented toggle `[Claude | Codex]` (component-local `useState`, **Claude default** — per user direction; no persistence, YAGNI). Buttons styled like the existing small segments (text-[10.5px], accent on active); `aria-pressed` on the active one.
- **Claude tab** = exactly today's body (meters/stats), untouched.
- **Codex tab** body from `usage.codex`:
  - `fiveHour` → `Meter` (label `usagePanel.session5h` reuse) with sub = reset time (`HH:MM` local, from `resetsAt`); `sevenDay` → `Meter` (label `usagePanel.weekly`) with sub = `fmtTok(weeklyTokens)` when present.
  - `todayTokens` → `Stat` (label `usagePanel.today`, value `fmtTok` — **no `$`**: plan billing has no USD notion).
  - `usage.codex == null` → a muted `usagePanel.codexUnavailable` line ("코덱스 사용량 없음 — codex 로그인/설치 확인" / EN equivalent). The tab is always visible (discoverability) even when codex is absent.
  - Skeleton/loadFailed pre-load states stay shared (they gate on `usage` itself, not per-tab).
- The header title is **per-tab** (`usagePanel.title` stays the existing Claude wording on the Claude tab; a new `usagePanel.titleCodex` / `usagePanel.titleHintCodex` pair serves the Codex tab) — existing Claude-tab tests keep passing unchanged.
- i18n: new keys in `usagePanel` ko/en catalogs (`usagePanel.tabClaude`, `usagePanel.tabCodex`, `usagePanel.titleCodex`, `usagePanel.titleHintCodex`, `usagePanel.codexUnavailable`, `usagePanel.resets` with a `{time}` param). ko/en parity + used-keys tests enforce them.

### 5. Non-goals

- No `$` estimation for codex (RATES exists for turn billing, but account-level tokens×price would misrepresent plan usage).
- No passive `account/rateLimits/updated` capture from running children (poll only).
- No tab persistence across restarts; no per-plan credit display (`credits`/`extra` equivalents) until someone asks.
- `planType` is carried in the snapshot but not rendered yet (available for a later tooltip).

### 6. Testing

- `test/core/codex-usage-provider.test.ts`: mapping unit tests (full/partial/malformed responses, today/weekly bucket math with injected `now`), fetch-path tests via the fake codex transport (success, rateLimits-only partial, timeout → null, apiKey provisioning call order).
- `test/core/usage.test.ts` (existing file): collector merges codex like pct (success replaces, failure keeps previous), `emptyUsage().codex === null`.
- Desktop: UsagePanel test — default tab renders Claude content, clicking Codex shows codex meters/stats, null codex shows the unavailable line; i18n parity picks up the new keys automatically.
- Live check after implementation: run the daemon and confirm `usage.get` carries a real `codex` block (script or daemon log), and the panel toggles in the app if feasible.
