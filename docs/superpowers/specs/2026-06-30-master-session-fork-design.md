# Master session fork — design

Date: 2026-06-30

## Problem
There's no way to branch a conversation. To try a different direction from where a master session is now,
you'd lose (or have to abandon) the current one. Users want to right-click a session and "Fork" it — get a
copy that carries the full conversation context and then diverges independently, leaving the original intact.

## Goal
Right-click a **master** session → **Fork** → a new session that (a) carries the original's full SDK conversation
context, (b) shows the original's transcript in the UI, and (c) continues independently from the current point.
The original is untouched.

## Decisions
- **Semantics:** current-point full duplicate (not point-in-time branching).
- **Scope:** master sessions only (v1). Worker fork and point-in-time (`upToMessageId`) branching are out of scope.
- **Transcript:** copy the original's `session_events` into the fork so its UI shows the same history, then it diverges from the next turn.
- **SDK mechanism:** Approach A — eager `forkSession()` at fork time (the fork gets a real `sdk_session_id` immediately; MasterAgent is unchanged — it just resumes that id like any session).

## Architecture
- **`ForkFn` port** — `(sdkSessionId: string, opts?: { title?: string }) => Promise<{ sessionId: string }>`, default = the SDK's `forkSession` (`@anthropic-ai/claude-agent-sdk`). Injected at the composition root (`server.ts`); a fake is used in tests. (Runs in the daemon, which owns the SDK session files under `~/.claude/projects/`.)
- **`SessionManager.fork(sessionId) → { id }`** (new):
  1. `orig = repos.getSession(sessionId)`. If `!orig?.sdk_session_id` → throw (a session with no completed turn has nothing to fork).
  2. `{ sessionId: newUuid } = await forkFn(orig.sdk_session_id, { title: \`${label} (fork)\` })`.
  3. `created = repos.createSession({ id: idgen(), cwd: orig.cwd, origin: "ui" })`.
  4. `repos.setSdkSessionId(created.id, newUuid)`.
  5. `repos.copySessionEvents(orig.id, created.id)` — copy the transcript rows (preserve seq order) so the fork's UI replays the same history.
  6. Set the fork label to `${origLabel} (fork)` (`repos.setSessionLabel`), and seed `last_activity` (a messages row or touch) so it sorts sensibly in the list.
  7. Return `{ id: created.id }`.
- **`repos.copySessionEvents(fromId, toId)`** (new) — `SELECT … FROM session_events WHERE session_id=? ORDER BY seq` → INSERT each with `session_id=toId` (same seq/type/payload). Pure SQLite copy.

## Protocol
- New client message `session.fork { sessionId, reqId? }` → handler calls `SessionManager.fork` → replies `{ type: "session.created", sessionId: newId, cwd, reqId }` (reuse the existing created reply so the client refreshes the list + can navigate). On the no-sdk-session error → `{ type: "error", message, reqId }`.

## Renderer
- `Sessions.tsx` right-click `ContextMenu` (already present): add a **"Fork"** item, enabled only when the session has an `sdk_session_id` (carry/derive a `forkable` flag on the session row sent to the renderer, or gate on a known field). On click → `client.request({ type: "session.fork", sessionId })` → on reply, `navigate` to the new session. `seedHistory`/`session.history` then replays the copied transcript; the first new message resumes the forked SDK session and diverges.
- Naming: the fork shows as `<original> (fork)` in the list.

## Data flow
Right-click → Fork → daemon: `forkFn(origSdkId)` → new uuid → create session + `setSdkSessionId` + `copySessionEvents` + label → reply newId → renderer opens it → identical transcript shown → user sends → master resumes the forked SDK session → diverges. Original session unaffected.

## Error handling / edges
- No `sdk_session_id` (session never ran a turn) → Fork disabled in the menu + a guarded error if invoked anyway.
- `forkSession()` failure (SDK) → surfaced as an error reply; no partial session left (create only after fork succeeds).
- ⚠️ Verify at implementation time that the SDK's standalone `forkSession()` is functional (not a stub). If it isn't, fall back to Approach B (lazy `query({ resume, forkSession: true })` on the fork's first turn) — captured as a contingency, not the plan.

## Testing
- `SessionManager.fork` unit test (fake `ForkFn` + in-memory repos): throws without `sdk_session_id`; on success creates a new session, sets its `sdk_session_id` to the fork uuid, copies `session_events`, and labels it `(fork)`.
- `repos.copySessionEvents` test: rows copied to the new id, seq order preserved, original untouched.
- Renderer: the Fork menu item appears + is gated on forkability (light test or manual).

## Out of scope (YAGNI)
- Worker fork (needs a new git worktree/branch + worker entry — a separate effort).
- Point-in-time / `upToMessageId` branching (needs a rookery-transcript ↔ SDK-message-UUID mapping rookery doesn't track).
- Forking Slack/automation-origin sessions specially (a fork is always a plain `ui` session).

## Touched files
- `src/core/session-manager.ts` (`fork` + `ForkFn` dep), `src/persistence/repositories.ts` (`copySessionEvents`).
- `src/daemon/server.ts` (inject `ForkFn` = SDK `forkSession`), `src/daemon/connection.ts` (`session.fork` handler), `src/protocol/messages.ts` (`session.fork`).
- `apps/desktop/src/renderer/views/Sessions.tsx` (Fork menu item) + i18n, and whatever carries the session's forkable flag.
