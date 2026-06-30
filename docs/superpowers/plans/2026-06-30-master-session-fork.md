# Master session fork Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`). TDD on the pure/core pieces; the SDK forkSession + renderer wiring are verified by typecheck/build + manual. macOS suite stays green.

**Goal:** Right-click a master session → Fork → a new session that carries the original's full SDK context, shows its copied transcript, and diverges independently.

**Architecture:** Eager fork (Approach A): a `ForkFn` port (default = SDK `forkSession`) is called at fork time to copy the SDK session → new uuid. `SessionManager.fork` creates a new session row, sets its `sdk_session_id` to the fork uuid, and copies the original's `session_events`. A `session.fork` protocol message wires the renderer's right-click menu.

**Tech Stack:** Node 22 ESM, `@anthropic-ai/claude-agent-sdk` (`forkSession`), SQLite, React renderer, vitest.

## Global Constraints
- Scope: master sessions only. No worker fork, no point-in-time branching.
- A session with no `sdk_session_id` (never ran a turn) cannot be forked → the daemon throws and the renderer toasts the error.
- The fork is always a plain `ui`-origin session, labelled `<original> (fork)`.
- Comments in English; new user-facing strings via i18n (ko default).

---

### Task 1: `repos.copySessionEvents(fromId, toId)`
**Files:** Modify `src/persistence/repositories.ts`; Test `test/persistence/repositories.test.ts` (or db.test.ts).
**Produces:** `copySessionEvents(fromId: string, toId: string): void` — copies all session_events rows (seq/type/payload/created_at preserved) to toId.
- [ ] Test: add events to session A (via addSessionEvent), copy A→B, assert `listSessionEvents(B)` equals A's rows (seq/type/payload), and A is unchanged.
- [ ] Implement: `this.db.prepare("INSERT INTO session_events(session_id, seq, type, payload_json, created_at) SELECT ?, seq, type, payload_json, created_at FROM session_events WHERE session_id = ?").run(toId, fromId);`
- [ ] Run the repos test → PASS. Commit.

### Task 2: `SessionManager.fork` + `ForkFn` dep
**Files:** Modify `src/core/session-manager.ts`; Test `test/core/session-manager.test.ts`.
**Interfaces:**
- Produces: `type ForkFn = (sdkSessionId: string, opts?: { title?: string }) => Promise<{ sessionId: string }>`; `SessionManagerDeps.forkSession?: ForkFn`; `async fork(sessionId: string): Promise<Session>`.
- [ ] Test (fake repos + fake forkSession): forking a session with `sdk_session_id` → calls forkFn with the orig sdk id, creates a new session (origin ui), sets its sdk_session_id to the returned uuid, copies session_events, labels it `<orig> (fork)`; forking one WITHOUT sdk_session_id → throws.
- [ ] Implement `fork`:
```ts
async fork(sessionId: string): Promise<Session> {
  const row = this.deps.repos.getSession(sessionId);
  if (!row) throw new Error(`unknown session: ${sessionId}`);
  if (!row.sdk_session_id) throw new Error("this session has no completed turn yet — nothing to fork");
  if (!this.deps.forkSession) throw new Error("session forking is not available");
  const label = row.label?.trim() || row.cwd.split(/[\\/]/).filter(Boolean).pop() || sessionId;
  const { sessionId: forkedUuid } = await this.deps.forkSession(row.sdk_session_id, { title: `${label} (fork)` });
  const created = this.create(row.cwd); // plain ui-origin session
  this.deps.repos.setSdkSessionId(created.id, forkedUuid);
  this.deps.repos.copySessionEvents(sessionId, created.id);
  this.deps.repos.setSessionLabel(created.id, `${label} (fork)`);
  return this.build(created.id, row.cwd, forkedUuid, null);
}
```
- [ ] Add `forkSession?: ForkFn;` to `SessionManagerDeps` + export `ForkFn`.
- [ ] Run the session-manager test → PASS. Commit.

### Task 3: protocol + daemon wiring
**Files:** Modify `src/protocol/messages.ts` (`session.fork`), `src/daemon/connection.ts` (handler), `src/daemon/server.ts` (inject `forkSession` from the SDK).
- [ ] `messages.ts`: add to the client message union: `{ type: z.literal("session.fork"), sessionId: z.string(), reqId: z.string().optional() }`.
- [ ] `connection.ts`: add a `case "session.fork"` next to `session.create`:
```ts
case "session.fork": {
  try {
    const forked = await this.sessions.fork(msg.sessionId);
    this.subscribe(forked.id);
    this.reply({ type: "session.created", sessionId: forked.id, cwd: forked.cwd, ...(msg.reqId ? { reqId: msg.reqId } : {}) });
  } catch (err) {
    this.reply({ type: "error", message: String(err instanceof Error ? err.message : err), ...(msg.reqId ? { reqId: msg.reqId } : {}) });
  }
  return;
}
```
- [ ] `server.ts`: `import { forkSession as sdkForkSession } from "@anthropic-ai/claude-agent-sdk";` and pass `forkSession: (id, opts) => sdkForkSession(id, opts)` into the `new SessionManager({ ... })` deps.
- [ ] `npm run typecheck` + `npm test` (root) → green. Commit.

### Task 4: renderer — right-click Fork
**Files:** Modify `apps/desktop/src/renderer/views/Sessions.tsx` (menu item + `onFork` prop), `apps/desktop/src/renderer/App.tsx` (wire `onFork` → `session.fork` request → navigate), i18n `ko/en/sessions.ts`.
- [ ] Sessions.tsx: add `onFork?: (id: string) => void` to props; add a **Fork** item to the right-click `ContextMenu` items (e.g. before Delete): `{ label: t("sessions.fork"), onClick: () => { p.onFork?.(menu.id); setMenu(null); } }`.
- [ ] App.tsx: pass `onFork={(id) => { void client?.request({ type: "session.fork", sessionId: id }).then((r) => { if (r.type === "session.created") navigate({ overlay: null, showRepos: false, sessionId: r.sessionId }); }).catch((e) => toast.error(tRef.current("toast.forkFailed"), String(e))); }}` to `<Sessions … />`.
- [ ] i18n: add `sessions.fork` ("포크"/"Fork") to ko+en; add `toast.forkFailed` to ko+en common/toast catalogs.
- [ ] `npm run typecheck` + `npm test` (desktop, incl i18n parity) + `npm run build` → green. Commit + push.

## Self-Review
- Spec coverage: copySessionEvents(T1), fork+ForkFn(T2), protocol/daemon/SDK inject(T3), renderer menu(T4). Gating = graceful daemon error (relaxed from "menu disabled" to avoid a session-list-shape ripple — documented). ✓
- Placeholders: none (code shown). The SDK `forkSession` runtime check (does it actually copy?) happens when T3's manual smoke runs — fallback to Approach B noted in the spec if it errors.
- Type consistency: `ForkFn`, `fork`, `copySessionEvents`, `session.fork` consistent across tasks. `build(id, cwd, sdkSessionId, externalKey)` matches session-manager's existing private signature.
