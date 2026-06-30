# Worker fork — design

Date: 2026-07-01

## Problem
Master sessions can be forked (duplicate context → diverge independently). Workers can't. Users want the same:
right-click a worker → Fork → a new worker that carries the original's SDK context **and its full working-tree state
(including uncommitted changes)**, in its own isolated worktree, then continues independently. The original is untouched.

## Goal
Right-click a worker → **Fork** → a new worker that (a) carries the original's SDK conversation context, (b) starts
from a duplicate of the original's worktree (committed history + uncommitted/untracked files), (c) shows the original's
transcript in the UI, and (d) continues independently. Mirrors the master fork; the only genuinely new piece is the worktree.

## Decisions
- **Semantics:** current-state full duplicate (chosen option **(c)**: include uncommitted/untracked work).
- **Worktree base:** the new worktree is branched from the **source worker's branch HEAD** (`rookery/<srcId>`, carrying its committed history), then the source's **full working state is overlaid** via `checkpoint`(source) → `restoreCheckpoint`(fork). The fork's diff `base` column = the source's `base`, so the fork's diff shows the same body of work.
- **Gate:** fork requires the source to have an `sdk_session_id` AND an existing worktree (mirrors the resume condition + master fork). Otherwise throw → renderer toasts.
- **Live state:** forking is allowed regardless of running/idle/stopped — `checkpoint` only reads the source worktree (snapshots into a ref), so it never collides with the source's edits. A mid-turn fork is a point-in-time snapshot.
- **Home session:** the fork belongs to the **same home session** as the source → appears under the same repo in the fleet tree.
- **Resume model:** the fork is registered as a **lazy-resumable entry** (`resumeSessionId = forked uuid`, status `idle`), exactly like a rehydrated worker — it materializes (resumes the forked SDK session in its worktree) on first send. No new Worker lifecycle.

## Architecture
- **`FleetDeps.forkSession?`** — `(sdkSessionId, opts?) => Promise<{ sessionId }>`, default = SDK `forkSession`, injected at `server.ts` (same fn already injected into SessionManager). Declared inline in `FleetDeps` (no import → no cycle with session-manager).
- **`FleetOrchestrator.fork(id) → { id }`** (new):
  1. `src = repos.getWorker(id)`; throw if missing / no `sdk_session_id` / worktree absent / no `forkSession` dep.
  2. `newId = idgen()`, `branch = rookery/<newId>`, `worktreePath = worktreesDir/<newId>`, `label = "<src.label> (fork)"`.
  3. `{ sessionId: forkedUuid } = await forkSession(src.sdk_session_id, { title: label })`.
  4. `snapSha = await git.checkpoint(src.worktree_path, refs/rookery/fork/<newId>)` (best-effort; null on failure).
  5. `await git.addWorktree(src.repo_path, worktreePath, branch, src.branch ?? src.base ?? "HEAD")` → if `snapSha`, `await git.restoreCheckpoint(worktreePath, snapSha)` (best-effort).
  6. `repos.createWorker({ id:newId, sessionId:src.session_id, repoPath:src.repo_path, label, worktreePath, branch, base: src.base })` → `setWorkerSdkSessionId(newId, forkedUuid)` → carry `model`/`permission_mode`.
  7. `repos.copyWorkerEvents(id, newId)` — duplicate the transcript.
  8. `repos.setWorkerStatus(newId, "idle", true)` + register a lazy entry (`resumeSessionId = forkedUuid`, status idle) + `bus.emit(worker.spawned … status:"idle")`.
  9. Return `{ id: newId }`.
- **`repos.copyWorkerEvents(fromId, toId)`** (new) — `INSERT … SELECT` from `worker_events` (preserve seq/type/payload/created_at). Mirror of `copySessionEvents`.

## Protocol
- New client message `worker.fork { reqId, id }` → handler calls `fleet.fork(id)` → replies `{ type: "fleet.spawn.result", reqId, id }` (reused — it's just `{id}`; the renderer navigates to it) or `{ type: "error", message, reqId }`.
- `RequestResponseMap["worker.fork"] = fleet.spawn.result`.

## Renderer
- `RepoTree.tsx`: add `onForkSub?: (id: string) => void` + a **Fork** item in the worker right-click `ContextMenu` (after Rename). Shown always; the daemon validates (graceful error toast for an unforkable worker).
- `App.tsx`: `forkSub(id)` → `client.request(worker.fork)` → on reply `refetchFleet()` + `selectSub(newId)` (selectSub already navigates + fetches `worker.history` → seeds the copied transcript). Error → `toast.forkFailed`.
- ✅ **No transcript-routing fix needed** (unlike master): `worker_events` payloads are `WorkerEventData` (no `workerId` inside), and `seedWorkerHistory(newId, …)` keys by the passed id — copied events render under the fork correctly.
- i18n: `repoTree.menuFork` (ko/en). `toast.forkFailed` already exists (added for master fork).

## Data flow
Right-click → Fork → daemon: `forkSession` → `checkpoint(src)` → `addWorktree(from src.branch)` → `restoreCheckpoint` → `createWorker`+`setWorkerSdkSessionId`+`copyWorkerEvents` → lazy entry + `worker.spawned` → reply newId → renderer `selectSub(newId)` → worktree on disk + transcript shown → first send materializes (resumes the forked SDK session) → diverges. Source untouched.

## Error handling / edges
- No `sdk_session_id` / worktree gone → throw "nothing to fork" → error toast.
- `checkpoint` failure → fork still proceeds with committed state only (best-effort restore skipped); `restoreCheckpoint` failure → committed state remains. Neither aborts the fork.
- `addWorktree` / `forkSession` failure → throws before any worker row is created → clean error (no partial worker).

## Testing
- `repos.copyWorkerEvents` test: rows copied to the new id (seq order preserved), source untouched.
- `FleetOrchestrator.fork` test (FakeGitOps records calls + fake forkSession + in-memory repos): throws without `sdk_session_id`; on success calls forkSession with the src sdk id, checkpoints the source worktree, addWorktree from the src branch, restoreCheckpoint into the fork, creates a worker with the forked sdk id + "(fork)" label, copies worker_events, and registers an idle lazy entry; the materialize-on-send path resumes the forked uuid.
- Renderer: Fork menu item present (light/manual).

## Out of scope (YAGNI)
- Point-in-time / per-checkpoint worker fork (always forks the current state).
- Forking the live in-flight turn's output (snapshot is point-in-time).

## Touched files
- `src/core/fleet-orchestrator.ts` (`fork` + `FleetDeps.forkSession`), `src/persistence/repositories.ts` (`copyWorkerEvents`).
- `src/daemon/server.ts` (inject `forkSession` into the fleet), `src/daemon/connection.ts` (`worker.fork` handler), `src/protocol/messages.ts` (`worker.fork` + map).
- `apps/desktop/src/renderer/views/RepoTree.tsx` (Fork item + `onForkSub`), `apps/desktop/src/renderer/App.tsx` (`forkSub` wiring), i18n `ko/en/repoTree.ts`.
