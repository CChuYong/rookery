# Side Conversation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a desktop user ask an independent, read-only question from a live master or worker conversation without pausing the parent or creating another git worktree.

**Architecture:** A daemon-owned `SideConversationManager` forks the source provider session into an ephemeral side thread and runs serialized read-only turns in the source cwd. Side lifecycle and transcript deltas travel over dedicated WebSocket messages/events; the renderer keeps them in volatile Zustand state and shows them in a transient right drawer owned by `ConversationPane`.

**Tech Stack:** TypeScript, Node 22, Claude Agent SDK, Codex app-server, Zod, WebSocket, React 18, Zustand, Tailwind, Vitest, Testing Library.

## Global Constraints

- Do not create a git worktree, worker row, session row, or persistent transcript for a Side conversation.
- A master Side uses the master cwd; a worker Side uses that worker's existing live worktree cwd.
- Side turns are read-only: Claude uses `plan` with only read/search tools exposed; Codex uses its `read-only` sandbox and no MCP bridge tools.
- The parent master/worker continues independently; stopping or closing Side affects only the Side stream.
- Side state is volatile and is cleaned up when closed, when its owning WebSocket disconnects, or when the daemon shuts down.
- All desktop strings have matching Korean and English i18n keys.
- Use Node 22 for every test, typecheck, and build command.

---

### Task 1: Side protocol and event vocabulary

**Files:**
- Modify: `src/protocol/messages.ts`
- Modify: `src/core/events.ts`
- Test: `test/protocol/messages.test.ts`

**Interfaces:**
- Produces client requests `side.start`, `side.send`, `side.stop`, and `side.close`.
- Produces response `{ type: "side.started"; reqId: string; sideId: string }` and `fleet.ack` responses for the remaining mutations.
- Produces `side.event` carrying `WorkerEventData` and `side.status` carrying `opening | running | idle | closed`.

- [ ] **Step 1: Write failing protocol tests**

Add parser assertions for a master source and worker source, and rejection assertions for missing text/source ids.

- [ ] **Step 2: Run the protocol test and verify it fails**

Run: `npx vitest run test/protocol/messages.test.ts`

Expected: FAIL because `side.start` is not part of `clientMessageSchema`.

- [ ] **Step 3: Add schemas, response types, request mappings, and CoreEvent members**

Use the exact source discriminator:

```ts
{ type: "side.start", sourceKind: "master" | "worker", sourceId: string, text: string, model?: string, effort?: string, reqId?: string }
```

Side event routing includes the parent's owning session id plus `sourceKind`, `sourceId`, and `sideId`.

- [ ] **Step 4: Re-run the protocol test**

Expected: PASS.

### Task 2: Read-only ephemeral Side execution

**Files:**
- Create: `src/core/side-conversation.ts`
- Modify: `src/core/agent-backend.ts`
- Modify: `src/core/claude-backend.ts`
- Modify: `src/core/codex/codex-backend.ts`
- Test: `test/core/side-conversation.test.ts`
- Test: `test/core/claude-backend.test.ts`
- Test: `test/core/codex/codex-backend.test.ts`

**Interfaces:**
- Produces `SideConversationManager.create(input): Promise<{ id: string }>`.
- Produces `send(id, text)`, `stop(id)`, `close(id)`, and `closeAll()`.
- Consumes a source resolver returning `{ sourceKind, sourceId, sessionId, provider, cwd, sdkSessionId, model, effort, sessionKey? }` and a provider-aware fork function.

- [ ] **Step 1: Write failing manager tests**

Cover source fork, same cwd, user echo, streamed answer/result/status, follow-up resume, concurrent-send rejection, stop isolation, cleanup, and unknown/unforkable source errors.

- [ ] **Step 2: Run the manager test and verify it fails**

Run: `npx vitest run test/core/side-conversation.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the manager and provider read-only option**

Add `readOnly?: boolean` to `MasterTurnOptions`. Claude maps it to `permissionMode: "plan"`, `allowedTools: ["Read", "Glob", "Grep"]`, and disallows mutation/shell tools. Codex permits a restricted `startTurn` only when `readOnly === true` and no MCP definitions/servers are supplied; regular Codex masters retain the bypass-only guard.

- [ ] **Step 4: Run core tests**

Run: `npx vitest run test/core/side-conversation.test.ts test/core/claude-backend.test.ts test/core/codex/codex-backend.test.ts`

Expected: PASS.

### Task 3: Daemon composition and WebSocket lifecycle

**Files:**
- Modify: `src/daemon/server.ts`
- Modify: `src/daemon/connection.ts`
- Test: `test/daemon/connection.test.ts`

**Interfaces:**
- `Connection` receives a `SideConversationController` after the existing optional dependencies.
- `side.start` creates/forks first, replies with `side.started`, then starts the initial turn so no event can arrive before the client knows the id.
- Each connection tracks its owned Side ids and closes them in `dispose()`.

- [ ] **Step 1: Write failing connection tests**

Assert request forwarding, response ordering, follow-up/stop/close acknowledgements, and disposal cleanup.

- [ ] **Step 2: Run the connection test and verify it fails**

Run: `npx vitest run test/daemon/connection.test.ts`

Expected: FAIL because Side request cases are absent.

- [ ] **Step 3: Wire source resolution and provider-specific fork/cleanup**

Master sources resolve from `sessions`; worker sources resolve from `workers`. Codex master Side forks seed an ephemeral per-side `CODEX_HOME`, while Codex worker Side uses the shared worker home. Closing a Codex master Side releases its bridge registration and removes only that Side home.

- [ ] **Step 4: Re-run daemon tests**

Expected: PASS.

### Task 4: Volatile renderer state

**Files:**
- Modify: `apps/desktop/src/renderer/store/reduce.ts`
- Test: `apps/desktop/test/store-reduce.test.ts`

**Interfaces:**
- Adds `sideConversations: Record<string, { sourceKind; sourceId; status; items }>` to `AppState`.
- `side.event` reuses `applySubEvent`; `side.status` updates lifecycle and finalizes active streaming items at idle/closed boundaries.

- [ ] **Step 1: Write failing reducer tests**

Cover independent master/worker Side logs, streaming deltas, result/status transitions, and no mutation of parent logs.

- [ ] **Step 2: Run the reducer test and verify it fails**

Run: `npm -w apps/desktop test -- --run test/store-reduce.test.ts`

- [ ] **Step 3: Implement the reducer state and handlers**

Reuse `applySubEvent` so Side rendering stays isomorphic with workers.

- [ ] **Step 4: Re-run the reducer test**

Expected: PASS.

### Task 5: Side drawer UI

**Files:**
- Create: `apps/desktop/src/renderer/components/SideConversationDrawer.tsx`
- Modify: `apps/desktop/src/renderer/components/Composer.tsx`
- Modify: `apps/desktop/src/renderer/components/ConversationPane.tsx`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Create: `apps/desktop/src/renderer/i18n/locales/ko/sideConversation.ts`
- Create: `apps/desktop/src/renderer/i18n/locales/en/sideConversation.ts`
- Modify: `apps/desktop/src/renderer/i18n/locales/ko/composer.ts`
- Modify: `apps/desktop/src/renderer/i18n/locales/en/composer.ts`
- Test: `apps/desktop/test/side-conversation.test.tsx`
- Test: `apps/desktop/test/composer.test.tsx`

**Interfaces:**
- `ComposerProps.onSideSend?: (text: string) => void` redirects the current editor contents through a question-mark action and clears the editor.
- `ConversationPane` accepts async Side start plus send/stop/close callbacks and owns the transient open/closed drawer state.
- The drawer renders source identity, read-only/live-worktree context, independent transcript, follow-up composer, status, stop, and close.

- [ ] **Step 1: Write failing component tests**

Cover question action visibility, editor redirect/clear, master and worker source copy, loading/running/idle UI, follow-up send, stop, close cleanup, and parent transcript remaining mounted.

- [ ] **Step 2: Run the component tests and verify they fail**

Run: `npm -w apps/desktop test -- --run test/side-conversation.test.tsx test/composer.test.tsx`

- [ ] **Step 3: Implement responsive drawer and App handlers**

Desktop uses a 360px right sibling with a left border; narrow screens use an absolute full-pane sheet. App passes the displayed parent model/effort to `side.start` and surfaces request failures through the existing toast system.

- [ ] **Step 4: Run desktop component and i18n tests**

Run: `npm -w apps/desktop test -- --run test/side-conversation.test.tsx test/composer.test.tsx test/i18n/catalog.test.ts test/i18n/used-keys.test.ts`

Expected: PASS.

### Task 6: Full verification

**Files:**
- Modify only files required by failures caused by this feature.

**Interfaces:**
- No new interface; validates the complete implementation.

- [ ] **Step 1: Activate Node 22**

Run: `source ~/.nvm/nvm.sh && nvm use 22`

Expected: `node --version` reports v22.x and `process.versions.modules` reports 127.

- [ ] **Step 2: Run root tests and typecheck**

Run: `npm test && npm run typecheck`

Expected: PASS.

- [ ] **Step 3: Run desktop tests and typecheck**

Run: `npm -w apps/desktop test && npm -w apps/desktop run typecheck`

Expected: PASS.

- [ ] **Step 4: Build daemon and desktop**

Run: `npm run build && npm -w apps/desktop run build`

Expected: PASS.
