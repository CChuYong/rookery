# Worker fork Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`). TDD on the pure/core pieces; SDK fork + renderer wiring verified by typecheck/build. macOS suite stays green.

**Goal:** Right-click a worker → Fork → a new worker carrying the original's SDK context + full worktree state (incl uncommitted), showing its transcript, diverging independently.

**Architecture:** `FleetOrchestrator.fork` = forkSession (SDK) + new worktree branched from the source's branch HEAD + `checkpoint`(source)→`restoreCheckpoint`(fork) for uncommitted state + `copyWorkerEvents` + a lazy-resumable entry (resumes on first send). Mirrors the master fork; reuses spawn's worktree-create + rehydrate's resume machinery.

**Tech Stack:** Node 22 ESM, `@anthropic-ai/claude-agent-sdk` (`forkSession`), SQLite, React renderer, vitest.

## Global Constraints
- Worktree base = source branch HEAD; overlay full state via checkpoint/restoreCheckpoint (option c).
- Fork requires source `sdk_session_id` + existing worktree → else throw → renderer toast.
- Fork is a plain worker under the source's home session, labelled `<source> (fork)`.
- Comments in English; new strings via i18n (ko default).

---

### Task 1: `repos.copyWorkerEvents(fromId, toId)`
**Files:** Modify `src/persistence/repositories.ts`; Test `test/persistence/repositories.test.ts`.
- [ ] Test: createWorker A+B (each needs a session), addWorkerEvent x2 to A, `copyWorkerEvents("wa","wb")`, assert `listWorkerEvents("wb")` matches A's rows (seq/type/payload) and A unchanged.
- [ ] Implement (next to copySessionEvents):
```ts
copyWorkerEvents(fromId: string, toId: string): void {
  this.db
    .prepare("INSERT INTO worker_events(worker_id, seq, type, payload_json, created_at) SELECT ?, seq, type, payload_json, created_at FROM worker_events WHERE worker_id = ? ORDER BY seq")
    .run(toId, fromId);
}
```
- [ ] Run repos test → PASS. Commit.

### Task 2: `FleetOrchestrator.fork` + `FleetDeps.forkSession`
**Files:** Modify `src/core/fleet-orchestrator.ts`; Test `test/core/fleet-orchestrator.test.ts`.
**Interfaces:**
- Consumes: `repos.copyWorkerEvents` (T1), `git.checkpoint`/`restoreCheckpoint`/`addWorktree` (existing), `repos.setWorkerSdkSessionId`.
- Produces: `FleetDeps.forkSession?: (sdkSessionId: string, opts?: { title?: string }) => Promise<{ sessionId: string }>`; `async fork(id: string): Promise<{ id: string }>`.
- [ ] Add to `FleetDeps`: `forkSession?: (sdkSessionId: string, opts?: { title?: string }) => Promise<{ sessionId: string }>;`
- [ ] Test (FakeGitOps + fake forkSession + in-memory repos + deterministic idgen): spawn a worker, give it an sdk_session_id (`repos.setWorkerSdkSessionId`) + a worker event, then `fork(id)`:
  - throws when the source has no sdk_session_id;
  - on success: forkSession called with the src sdk id; `git.calls` include `checkpoint`, `addWorktree`, `restoreCheckpoint`; a new worker row exists with sdk_session_id = forked uuid, label ending "(fork)", base = src base; `listWorkerEvents(newId)` copied; `status(newId)` is "idle".
- [ ] Implement `fork` (use `this.exists` for the worktree check; register a lazy entry like `rehydrate`):
```ts
async fork(id: string): Promise<{ id: string }> {
  const src = this.deps.repos.getWorker(id);
  if (!src) throw new Error(`Unknown worker: ${id}`);
  if (!src.sdk_session_id) throw new Error("this worker has no SDK session yet — nothing to fork");
  if (!src.worktree_path || !this.exists(src.worktree_path)) throw new Error("this worker's worktree is gone — cannot fork");
  if (!this.deps.forkSession) throw new Error("worker forking is not available");
  const newId = this.idgen();
  const branch = `rookery/${newId}`;
  const worktreePath = path.join(this.deps.worktreesDir, newId);
  const label = `${src.label} (fork)`;
  const { sessionId: forkedUuid } = await this.deps.forkSession(src.sdk_session_id, { title: label });
  let snapSha: string | null = null;
  try { snapSha = await this.deps.git.checkpoint(src.worktree_path, `refs/rookery/fork/${newId}`); } catch { snapSha = null; }
  await this.deps.git.addWorktree(src.repo_path, worktreePath, branch, src.branch ?? src.base ?? "HEAD");
  if (snapSha) { try { await this.deps.git.restoreCheckpoint(worktreePath, snapSha); } catch { /* committed state still present */ } }
  this.deps.repos.createWorker({ id: newId, sessionId: src.session_id, repoPath: src.repo_path, label, worktreePath, branch, base: src.base ?? undefined });
  this.deps.repos.setWorkerSdkSessionId(newId, forkedUuid);
  if (src.model) this.deps.repos.setWorkerModel(newId, src.model);
  if (src.permission_mode) this.deps.repos.setWorkerPermissionMode(newId, src.permission_mode);
  this.deps.repos.copyWorkerEvents(id, newId);
  this.deps.repos.setWorkerStatus(newId, "idle", true);
  this.entries.set(newId, { homeSessionId: src.session_id, repoPath: src.repo_path, worktreePath, branch, base: src.base ?? "", status: "idle", label, model: src.model ?? undefined, permissionMode: src.permission_mode ?? undefined, resumeSessionId: forkedUuid });
  this.deps.bus.emit({ type: "worker.spawned", sessionId: src.session_id, workerId: newId, repoPath: src.repo_path, label, branch, status: "idle", ticketKey: null, ticketUrl: null });
  return { id: newId };
}
```
- [ ] Run fleet test → PASS. `npm run typecheck`. Commit.

### Task 3: protocol + daemon wiring
**Files:** Modify `src/protocol/messages.ts`, `src/daemon/connection.ts`, `src/daemon/server.ts`.
- [ ] `messages.ts`: client union += `z.object({ type: z.literal("worker.fork"), reqId: z.string(), id: z.string() }),`; RequestResponseMap += `"worker.fork": Extract<ServerMessage, { type: "fleet.spawn.result" }>;`
- [ ] `connection.ts` (next to fleet.spawn):
```ts
case "worker.fork": {
  try {
    const { id } = await this.fleet.fork(msg.id);
    this.reply({ type: "fleet.spawn.result", reqId: msg.reqId, id });
  } catch (err) {
    this.reply({ type: "error", message: err instanceof Error ? err.message : String(err), reqId: msg.reqId });
  }
  return;
}
```
- [ ] `server.ts`: add `forkSession: (id, opts) => sdkForkSession(id, opts),` to the `new FleetOrchestrator({ … })` deps (sdkForkSession is already imported for SessionManager).
- [ ] `npm run typecheck` + `npm test` (root) → green. Commit.

### Task 4: renderer — right-click Fork on a worker
**Files:** Modify `apps/desktop/src/renderer/views/RepoTree.tsx`, `apps/desktop/src/renderer/App.tsx`, i18n `ko/en/repoTree.ts`.
- [ ] RepoTree.tsx: props += `onForkSub?: (id: string) => void;`. Add to the worker ContextMenu items after Rename: `{ label: t("repoTree.menuFork"), onClick: () => p.onForkSub?.(menu.id) },`.
- [ ] App.tsx: add `const forkSub = useCallback((id: string) => { void client?.request({ type: "worker.fork", id }).then((r) => { refetchFleet(); selectSub(r.id); }).catch((e) => toast.error(tRef.current("toast.forkFailed"), String(e))); }, [refetchFleet, selectSub]);` and pass `onForkSub={forkSub}` to `<RepoTree … />`.
- [ ] i18n: add `repoTree.menuFork` ("포크"/"Fork") to ko+en repoTree.ts. (`toast.forkFailed` already exists.)
- [ ] `npm run typecheck` + `npm test` (desktop, incl i18n parity) + `npm run build` → green. Commit + push.

## Self-Review
- Spec coverage: copyWorkerEvents(T1), fork+forkSession dep+worktree/checkpoint/restore/resume(T2), protocol/daemon/inject(T3), renderer menu(T4). ✓
- Placeholders: none (code shown). No worker-transcript routing fix needed (worker_events payloads carry no workerId — confirmed). ✓
- Type consistency: `forkSession`, `fork`, `copyWorkerEvents`, `worker.fork`, `fleet.spawn.result` consistent; `createWorker`/`setWorkerSdkSessionId`/`getWorker` match existing signatures. ✓
