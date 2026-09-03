# Codex usage mirror — unified `ccusage codex` accounting across rookery's per-target homes

Date: 2026-07-30
Status: design approved (PoC verified against codex-cli 0.145.0 / ccusage 20.0.18)

## Problem

`npx ccusage` reports nothing for work done on Codex, so a rookery user has no token/cost accounting
for codex masters and workers.

Two independent causes, both verified:

1. **The plain `ccusage` command is Claude-only.** ccusage 20.x splits providers into subcommands;
   Codex is `ccusage codex daily`. The bare command parses `~/.claude/projects/**/*.jsonl` only.
   (The daemon's own collector is Claude-only too — `src/core/usage.ts` runs `blocks --active --json`
   and `daily --json`. The desktop Usage panel's Codex tab is a separate source entirely:
   `src/core/codex-usage-provider.ts` reads app-server `account/rateLimits/read` + `dailyUsageBuckets`,
   has no USD, and is unrelated to ccusage.)
2. **Even `ccusage codex daily` sees nothing**, because it scans `CODEX_HOME` (default `~/.codex`)
   while rookery redirects every codex target to its own home: `<ROOKERY_HOME>/codex-homes/<session-id>/`
   for masters and `codex-homes/worker-<worker-id>/` for workers (`src/daemon/codex-home.ts`).
   The rollouts contain the token data (`token_count` events) — ccusage simply never looks there.

Measured on this machine before any change: 9 rookery codex homes, 33 rollouts,
**156,585,821 tokens / $114.43** invisible to `ccusage codex daily`.

## Non-goal: unifying `CODEX_HOME` itself

Pointing every codex target at `~/.codex` was considered and rejected. The per-target home directory
carries live isolation invariants:

- **Per-session MCP bridge token.** `[mcp_servers.rookery] url = <session-token URL>` lives in that
  home's `config.toml` (`codex-home.ts:337`) precisely so it does not ride the child's argv
  (`codex-home.ts:6-10`). One shared config.toml means concurrent masters/workers race on a single
  `url` value — last writer wins, and a worker can end up holding another session's tool authority.
- **The user's real config is read, never written.** `materializeCodexHome` re-materializes on every
  `ensureSession` (i.e. every turn), reading the user's `config.toml` as a base
  (`codex-home.ts:34-49`, `:429-437`). Unified homes would rewrite the user's own file continuously.
- **auth.json.** With an in-app `codexApiKey`, `account/login/start` provisions auth.json into the
  managed home (`codex-home.ts:67-79`); against the real home that overwrites `codex login` credentials.
- **Teardown.** Session/worker deletion `rm -rf`s the home (`codex-home.ts:268`, `:276`) and boot GC
  sweeps whole directories (`:301-322`). Against `~/.codex` that is catastrophic, and the fork-seeding
  guard `if (fs.existsSync(destinationSessions)) return false` (`:215`) would always trip, silently
  dropping forked context.
- **A home is more than `sessions/`.** codex 0.145 keeps `state_*.sqlite`, `memories_*.sqlite`,
  `goals_*.sqlite`, `logs_*.sqlite`, `shell_snapshots/`, `skills/`, `plugins/` there. Sharing them
  mixes worker memory/goals/thread index into the user's personal codex, and spreads the
  shell-snapshot secret exposure that `CODEX_MANAGED_SECRET_SAFETY_ARGS` exists to contain
  (`src/core/codex/codex-transport.ts:12-16`).

codex 0.145 has no configurable sessions directory, so there is no partial redirect either.

## Design

Leave every runtime path untouched. Add a **read-only accounting mirror**: hardlink each rookery codex
home's rollout files into the user's real `CODEX_HOME` under `archived_sessions/`, preserving the path
relative to that home's `sessions/` directory.

```
<ROOKERY_HOME>/codex-homes/worker-<id>/sessions/2026/07/30/rollout-…-<threadId>.jsonl
                     ↓ fs.linkSync (same inode)
<real CODEX_HOME>/archived_sessions/2026/07/30/rollout-…-<threadId>.jsonl
```

`ccusage codex daily` then reports personal + rookery usage in one command, with no env var.

### Why `archived_sessions/` and not `sessions/`

Verified against codex-cli 0.145.0 (probe: `scripts/probe-codex-usage-mirror.mjs`):

| Placement | `ccusage codex daily` | `thread/list` | `thread/resume` |
|---|---|---|---|
| `sessions/` | counts it | **lists it** (indexed into a fresh `state` sqlite on app-server boot) | succeeds |
| `archived_sessions/` | counts it | **empty** — no row created in `threads` at all | refused: `session … is archived. Run codex unarchive …` |

So `archived_sessions/` keeps the user's own `codex resume`/`fork` picker and thread index clean, and
gates the one hazard of inode sharing — two writers appending to one rollout — behind an explicit,
deliberate `codex unarchive`. A same-inode link is what makes a *live* worker's ongoing appends show up
without any re-sync; codex's own refusal to resume an archived thread is what keeps that safe.

ccusage scans both trees and sums them, so personal `sessions/` usage and mirrored
`archived_sessions/` usage appear in one total (verified: 1,820,822 + 2,182,557 = 4,003,379).

### New module — `src/daemon/codex-usage-mirror.ts`

Daemon-side, alongside `codex-home.ts`: it touches the user's filesystem, which `src/core/` must not.

```ts
export interface CodexUsageMirrorResult { linked: number; relinked: number; skipped: number; failed: number }

export function syncCodexUsageMirror(
  rookeryHome: string,
  realCodexHome: string,
  deps?: CodexUsageMirrorDeps,          // injectable fs ops, for the EXDEV test
): CodexUsageMirrorResult

export function syncCodexUsageMirrorForTarget(
  rookeryHome: string,
  realCodexHome: string,
  targetId: string,
  kind: "master" | "worker",
  deps?: CodexUsageMirrorDeps,
): CodexUsageMirrorResult
```

Rules:

- Source set: `<rookeryHome>/codex-homes/*/sessions/**/*.jsonl` (recursive walk, same shape as
  `codex-home.ts`'s `rolloutFiles`). The per-target variant walks one home, resolved through
  `codexHomeDirFor` so the `worker-` prefix convention has a single owner.
- Destination: `path.join(realCodexHome, "archived_sessions", path.relative(<home>/sessions, file))`.
  Relative paths **must** come from `path.relative` — a prefix-string slip produced an
  `archived_sessions/Users/clover/…` tree during the PoC.
- Directories created `0700`, matching `fs-hardening.ts` conventions.
- `fs.linkSync`, then classify errors:
  - `EEXIST` → the path is mirrored, but not necessarily from the copy that is still growing. A codex
    fork **copies** the ancestor rollout into the new target's home (`seedCodexTargetThreadFromHome`)
    and the forked worker then keeps appending to *its* copy, so one relative path can name a frozen
    snapshot in one home and the live file in another. Compare and keep the **longest** copy (rollouts
    are append-only, so longest = most complete): same inode or destination not shorter → `skipped`;
    a longer source → link to a temp name and `rename` over the mirror → `relinked`.
    This still holds exactly one link per rollout path, so it cannot double-count — and ccusage already
    ignores the fork-inherited prefix that the copies share (verified: a 17,210-line prefix of a forked
    rollout counts 0 tokens, while the 17,823-line live file counts 17,150,492).
    Skipping instead, as the first implementation did, pins the mirror to whichever home the sweep
    walked first and a running forked worker's spend never lands in the report: found live on
    2026-08-19 with 3 of 167 paths stale, worth **55,301,326 tokens / $44.90**.
    Home names are walked sorted so a sweep is reproducible.
  - `EXDEV` (mirror on another volume) → `copyFileSync` when the destination is missing or stale
    (`size` differs or destination `mtimeMs` is older), else `skipped`. A copy cannot follow live
    appends, so staleness is re-checked every sync; `0600` on the copy.
  - anything else → `failed`, that file only.
- **Never throws.** A missing `codex-homes`, an unreadable home, `EACCES` on `~/.codex`, `ENOSPC` — all
  degrade to counters. Same contract as every function in `codex-home.ts`.
- No deletion. The mirror is append-only, so a rollout stays accounted for after its rookery home is
  `rm -rf`'d (the link becomes the sole owner of the inode). Pruning is the user's `codex delete <id>`.

### Wiring — `src/daemon/server.ts` only

The real home is resolved exactly as `materializeCodexHome`'s `realCodexHome` is today
(`process.env.CODEX_HOME || ~/.codex`), so a user who relocates their codex home gets the mirror there.

1. **Boot**, immediately **before** `gcOrphanCodexHomes(...)` (`server.ts:320`): one full sync, so a
   restart reconciles everything including homes created by the previous process.
   ⚠️ The order matters and was found by running the real daemon: `gcOrphanCodexHomes` deletes homes
   with no backing session/worker row (left by a crash mid-delete or mid-fork), so anything it collects
   first can never be accounted for. Mirror first, then collect. Verified: with a seeded orphan home the
   daemon logs `linked=1`, the GC then removes the home, and the mirrored rollout survives.
2. **Periodic**, a daemon-owned `setInterval` at the already-resolved `usageRefreshMs`
   (`server.ts:444`, default 120 s). It is not folded into `UsageCollector` because `src/core/` is
   transport-agnostic and must not write to the user's home. The timer is registered in the daemon's
   shutdown path so it is cleared like every other interval. Its job is only to notice *new* rollout
   files; existing ones track live appends through the shared inode.
3. **Pre-teardown**, inside the two existing teardown closures, before the directory is removed:
   - `onSessionDelete` (`server.ts:257`) → `syncCodexUsageMirrorForTarget(..., id, "master")` then
     `removeCodexHome`.
   - `onWorkerDiscard` (`server.ts:306`) → `syncCodexUsageMirrorForTarget(..., id, "worker")` then
     `removeCodexWorkerHome`.
   This closes the window where a worker spawned and deleted between two ticks would lose its usage
   record. Both closures already promise never to throw, and the mirror honours that.

### Logging

One summary line per sync to the daemon log when anything happened
(`codex usage mirror: linked=N skipped=N failed=N`). No per-file spam, no paths beyond the mirror root,
no secrets — rollout *contents* are never read, only linked.

## Testing

`test/daemon/codex-usage-mirror.test.ts`, temp dirs via `fs.mkdtempSync` (no real codex, no network):

1. Links every rollout of every home to `archived_sessions/<rel>`, and `fs.statSync().ino` matches the
   source — the same-inode property the live-append behaviour depends on.
2. Two homes holding the same relative rollout path (fork ancestor) → one link, `skipped=1`, no throw.
3. Idempotent: a second sync reports `linked=0`.
4. Appending to a source rollout is visible through the mirror path (same inode).
5. Injected `link` that throws `EXDEV` → copy fallback; a subsequent source change re-copies, an
   unchanged source is skipped.
6. Missing `codex-homes`, and an unreadable home directory → no throw, `linked=0`.
7. `syncCodexUsageMirrorForTarget` links only the named target's rollouts, and resolves the
   `worker-` prefix through `codexHomeDirFor`.
8. Destination path uses the `sessions/`-relative layout (regression guard for the PoC path slip).
9. Two homes holding the same rollout path: the longer copy wins regardless of walk order, the mirror
   ends up linked to the live file, and a later sweep re-points once the live copy overtakes the
   snapshot it was seeded from.

Gates: `npm run typecheck` and `npm test`. No shared daemon types the renderer consumes change, so the
desktop workspace gates are not implicated.

The codex-version-dependent facts (`archived_sessions` counted by ccusage, invisible to `thread/list`,
resume refused) cannot be unit-tested without a real codex binary. They live in
`scripts/probe-codex-usage-mirror.mjs` and should be re-run when the pinned codex CLI moves.

## PoC evidence (2026-07-30, this machine)

- 33 rollouts across 9 homes linked; `linked=24 skipped=9 failed=0` on the second pass, proving the
  EEXIST dedup path.
- `ccusage codex daily` total on `~/.codex`: 2,029,087,048 → 2,185,672,869 (+$114.43 worth of
  previously invisible rookery usage).
- Retroactive: 2026-07-06 (50,239) · 07-08 (37,336) · 07-09 (2,182,557) · 07-25 (1,820,822) ·
  07-27 (15,372,843) · 07-30 (137,122,024). Historical model attribution survives
  (gpt-5.4 / 5.5 / 5.6-sol / 5.6-terra).
- A live worker's rollout grew from 71,579,374 to 78,410,302 tokens mid-PoC and the mirror reflected it
  with no re-sync.
- After 33 links: `thread/list` exposes 0 of them and `state_5.sqlite`'s `threads` row count is
  unchanged at 146.

## Limits (recorded, not fixed here)

- The mirror cannot recover rollouts of homes already deleted before it existed.
- `ccusage codex daily` now reports personal and rookery usage as one number. Splitting them again
  requires walking `codex-homes` per home — deliberately out of scope.
- Nothing prunes the mirror, so `~/.codex/archived_sessions` grows monotonically. Hardlinks cost no
  extra space while the rookery home lives; after deletion they retain the rollout, which is the point.
- Codex collab child threads still spend tokens that `cumCostUsd` cannot see. The mirror does not
  change that; it only makes the spend visible in ccusage after the fact.
- No setting gates this: the mirror is always on, by decision, so accounting cannot silently be empty.
