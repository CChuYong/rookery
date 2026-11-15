# Worker Steering and Per-Task Background Stop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A follow-up sent to a busy worker (Codex or Claude) lands in the running turn, and a Claude worker's background shells/monitors can be listed and stopped one at a time from the desktop (read-only for the master).

**Architecture:** Two optional methods on the provider-neutral `AgentStream` port — `steer()` (Codex `turn/steer`, Claude streaming-input push with a delivery priority) and `stopTask()` (Claude `Query.stopTask`). `Worker.send()` tries `steer()` before its existing `deferred` fallback. Background tasks gain description/ambient metadata, a filtered "listed" view, a dedicated `worker.tasks` event, a `worker.task.stop` request, a line in `get_worker_status`, and a header menu in the desktop.

**Tech Stack:** TypeScript (ESM NodeNext), Claude Agent SDK 0.3.325, Codex app-server 0.169 protocol, zod, vitest, React 18 + zustand (desktop).

**Spec:** `docs/superpowers/specs/2026-11-15-worker-steering-and-background-task-stop-design.md`

## Global Constraints

- Start from `main` **after PR #28 (speed + images) is merged**; rebase this branch (`feat/steering-and-bg-task-stop`, which holds the spec + this plan) onto it.
- Node 22 for every command (`export PATH="$HOME/.nvm/versions/node/v22.23.0/bin:$PATH"`).
- ESM relative imports end in `.js`; type-only imports use `import type`; code comments in English.
- No DB migration. Background-task data is live-only.
- Every new user-facing desktop string goes through i18n with identical key sets in `ko` and `en`.
- Steering applies to **workers only** (not masters, Side, automations). Background stop is **Claude only**; master gets **read-only** listing; no master/external stop tool.
- Listed tasks = not `ambient` and `taskType` not in `{"local_agent", "local_workflow"}`. The worker state model (`bgTasks` count → `background`) is unchanged.
- Gates before every commit that touches them: root `npm run typecheck && npx vitest run`; desktop `npm -w apps/desktop run typecheck && npm -w apps/desktop test`.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. A steer accepted just as the turn ends — the message must not be lost and the worker must not stay `running` forever (Task 3 test `steer accepted at the boundary still settles`).
2. Two quick sends while the first steer request is still in flight — they reach the model in send order (Task 3 test `sends during an in-flight steer keep order`).
3. `stop`/`interrupt` while a steer request is in flight — the message is either recorded once as delivered or dropped with the existing "Dropped deferred instruction" notice, never both, never silently (Task 3 test `stop during in-flight steer`).
4. Stopping a task that already finished, an unknown id, a Codex worker, or a stopped worker — a clean error reply, no crash, no state change (Task 6 tests).
5. A desktop that reconnects while tasks are running sees them immediately (Task 5 `fleet.list rows carry tasks`, Task 8 reducer seed test).

---

### Task 1: `steer` on the port + Codex worker implementation

**Files:**
- Modify: `src/core/agent-backend.ts` (`AgentStream`)
- Modify: `src/core/codex/codex-backend.ts` (extract input mapping from `sendTurn`; `CodexWorkerStream.steer`)
- Test: `test/core/codex/codex-backend.test.ts`

**Interfaces:**
- Produces: `AgentStream.steer?(input: AgentInput, clientMsgId?: string): Promise<boolean>` — `true` only if the provider accepted the input for the active turn; never throws.
- Produces: `toCodexInput(input: AgentInput): CodexInput[]` (module-private helper, used by `sendTurn` and `steer`).

- [ ] **Step 1: Write failing tests** (use this file's existing fake transport / request capture):
  - `steer sends turn/steer with the active turn id` — after `turn/started {turn:{id:"t1"}}`, `await stream.steer("look at foo.ts", "c-1")` resolves `true` and the captured request is `{ method: "turn/steer", params: { threadId: <thread>, expectedTurnId: "t1", clientUserMessageId: "c-1", input: [{ type: "text", text: "look at foo.ts", text_elements: [] }] } }`.
  - `steer maps images like turn/start` — an `{ text: "x", images: [{ mediaType: "image/png", data: "AAAA" }] }` input produces `[{type:"text",…},{ type: "image", url: "data:image/png;base64,AAAA" }]`.
  - `steer returns false with no active turn` — before any `turn/started` (or after `turn/completed`), resolves `false` and sends nothing.
  - `steer returns false when the server rejects it` — fake replies to `turn/steer` with a JSON-RPC error (e.g. expected-turn mismatch / non-steerable); resolves `false`, the stream stays usable, no `error` event.
  - `steer resets the idle watchdog` — follow the file's existing watchdog test pattern; a steer counts as activity.
- [ ] **Step 2: Run** `npx vitest run test/core/codex/codex-backend.test.ts` — expect the new tests to FAIL (`steer is not a function`).
- [ ] **Step 3: Implement** the optional port method in `agent-backend.ts` (doc comment: providers fold the input into the running turn; `false` = caller falls back to queuing). Extract `toCodexInput` from `sendTurn`'s current mapping. Add `steer` to `CodexWorkerStream` only (master `CodexTurnStream` does not get it): return `false` when `!this.client || !this.threadId || !this.activeTurnId || this.clientClosed`; otherwise `client.request("turn/steer", …)` inside try/catch → `true` on resolve, `false` on reject. Re-arm the idle watchdog the same way an inbound notification does.
- [ ] **Step 4: Run** the test file — PASS. Run root gates.
- [ ] **Step 5: Commit** `feat(codex): steer a running worker turn via turn/steer`.

### Task 2: Claude `steer` via the streaming input

**Files:**
- Modify: `src/core/image-input.ts` (`AgentInput` object form)
- Modify: `src/core/claude-backend.ts` (`claudeUserMessages`, `openSession`, `ClaudeStream`)
- Test: `test/core/claude-backend.test.ts`

**Interfaces:**
- Consumes: `AgentStream.steer?` (Task 1).
- Produces: `AgentInput` object form gains optional `priority?: "now" | "next" | "later"` (delivery hint; only Claude reads it). `export const CLAUDE_STEER_PRIORITY = "next" as const` in `claude-backend.ts`.

- [ ] **Step 1: Write failing tests** (capture the `prompt` iterable passed to the fake `query()`, as the file already does for options):
  - `claudeUserMessages copies priority onto the SDK message` — input `{ text: "hi", images: [], priority: "next" }` yields an `SDKUserMessage` with `priority: "next"`; an input without priority yields no `priority` key.
  - `steer pushes a priority-tagged message while a turn is active` — open a session on a `MessageQueue`, push a first input (turn active), then `await stream.steer("also check bar", "c-2")` resolves `true` and the next prompt message is `{ type: "user", priority: "next", message: { role: "user", content: [{ type: "text", text: "also check bar" }] } }`.
  - `steer does not re-apply speed flags` — `applyFlagSettings` is called once for the first input and not for the steered one.
  - `steer returns false when no turn is active or the input is closed` — before the first input, and after `queue.close()`.
- [ ] **Step 2: Run** `npx vitest run test/core/claude-backend.test.ts` — FAIL.
- [ ] **Step 3: Implement.** In `openSession`, keep the input as a push target when it has a `push(input: AgentInput): void` method (the worker passes its `MessageQueue`); pass it to `ClaudeStream`. `ClaudeStream.steer(input)` → `false` unless `this.speed.turnActive` and a push target exists; normalize string input to `{ text, images: [] }`, push `{ ...input, priority: CLAUDE_STEER_PRIORITY }`, return `true`; catch a closed-queue throw → `false`. In the `messages()` generator, skip `applyFlagSettings`/speed bookkeeping for inputs that carry `priority` (they join the current turn). `claudeUserMessages` sets `msg.priority` when present.
- [ ] **Step 4: Run** the test file — PASS. Root gates.
- [ ] **Step 5: Commit** `feat(claude): steer a running worker turn through the streaming input`.

### Task 3: Worker uses `steer` before deferring

**Files:**
- Modify: `src/core/worker.ts` (`send`, `stop`/`interrupt`/`recover` interplay)
- Test: `test/core/worker.test.ts`

**Interfaces:**
- Consumes: `AgentStream.steer?` (Tasks 1–2).
- Produces: no new public API; `Worker.send(text, clientMsgId?, speed?, imageRefs?)` keeps its synchronous `void` signature.

- [ ] **Step 1: Write failing tests** with a fake stream whose `steer` is a controllable `vi.fn()` (resolve true/false, or hold a deferred promise):
  - `mid-turn send steers and echoes once` — worker running; `send("redirect", "c-1")`; after `steer` resolves `true`: exactly one user `message` event with `clientMsgId: "c-1"`, nothing in `deferred` (the next `turn_end` settles the worker to idle with no extra turn).
  - `steer rejected falls back to the deferred path` — `steer` resolves `false`: no immediate echo; on the next `turn_end` the message is pushed to the queue and echoed (today's behavior).
  - `no steer when something is already deferred` — first send falls back (false), second send must NOT call `steer` and is deferred behind the first.
  - `sends during an in-flight steer keep order` — first `steer` held; second `send` arrives → deferred (no second steer); first then resolves `false` → it is placed ahead of the second (both later dispatched first-then-second).
  - `stop during in-flight steer` — first `steer` held; `stop()`; then `steer` resolves (`true` or `false`) → the worker is terminal, so exactly one "Dropped deferred instruction (stopped)" notice is recorded for it and no user echo; never both.
  - `steer accepted at the boundary still settles` — `steer` resolves `true`, then `turn_end`; then a spontaneous model frame and another `turn_end` (the SDK answered it as a new turn) → the worker goes `running` then `idle`, never stuck `running`.
  - `steered images are resolved up front` — a send with one image ref while running passes `{ text, images: [<resolved>] }` to `steer`.
  - `a steer resets the abort-loop streak` — mirror the existing streak test with a steered send.
  - `streams without steer keep today's behavior` — fake stream lacking `steer` → deferred as before.
- [ ] **Step 2: Run** `npx vitest run test/core/worker.test.ts` — FAIL.
- [ ] **Step 3: Implement** in `send()`'s running branch: if `this.stream?.steer && this.deferred.length === 0 && this.steeringInFlight === 0` → resolve images now, `this.steeringInFlight++`, call `steer(input, clientMsgId)`; on settle `steeringInFlight--`; if the worker is terminal by then → record the existing dropped-instruction notice for it (stop/interrupt path wording); else if `true` → `record` the user echo (with images, `clientMsgId`); else `this.deferred.unshift({ text, images, clientMsgId, speed })`. Any other running-branch send while `steeringInFlight > 0` goes to `deferred` as today. Keep the existing `speed`/`abortLoopStreak`/`clearWakeWatchdog` lines before the branch.
- [ ] **Step 4: Run** the file plus `test/core/worker-lifecycle.test.ts` — PASS. Root gates.
- [ ] **Step 5: Commit** `feat(worker): steer mid-turn sends into the running turn`.

### Task 4: Master guidance and docs for steering

**Files:**
- Modify: `src/tools/fleet-tools.ts` (`send_worker` description), `src/core/master-agent.ts:~121` (system prompt fleet line), `src/tools/external-tools.ts` (`send_worker` description if duplicated)
- Modify: `AGENTS.md` (Master vs Worker deferred-echo paragraph; Tools → fleet bullet), `docs/architecture/master-worker-turn.md`
- Test: `test/tools/fleet-tools.test.ts`

- [ ] **Step 1: Write failing test** `send_worker describes running-turn delivery` — the tool description contains `"delivered into the running turn"` and no longer contains `"queued and runs at the next turn boundary"`.
- [ ] **Step 2: Run** `npx vitest run test/tools/fleet-tools.test.ts` — FAIL.
- [ ] **Step 3: Update copy.** `send_worker`: "If the worker is mid-turn, the instruction is delivered into the running turn (the worker folds it into its current work); if that isn't possible it runs at the next turn boundary. To make it abandon its current work first, call interrupt_worker, then send_worker." Same meaning in the master prompt line and external tool. AGENTS.md/architecture: replace "echo deferred to the next result" as the primary path with "steered when possible (Codex `turn/steer`, Claude streaming input with `priority`), deferred FIFO as fallback".
- [ ] **Step 4: Run** the test + root gates — PASS.
- [ ] **Step 5: Commit** `docs(fleet): describe mid-turn sends as steering`.

### Task 5: Background-task metadata, listed view, `worker.tasks` event

**Files:**
- Modify: `src/core/agent-backend.ts` (`background_task`/`background_tasks` event shapes)
- Modify: `src/core/claude-backend.ts` (decode `description`, `ambient`)
- Modify: `src/core/events.ts` (new event + `BackgroundTaskView`)
- Modify: `src/core/worker.ts` (`bgTasks` map value, emit on membership change, `listedBackgroundTasks()`)
- Modify: `src/core/fleet-orchestrator.ts` (`WorkerAgent.backgroundTasks?`, `list()` rows)
- Test: `test/core/claude-backend.test.ts`, `test/core/worker.test.ts`, `test/core/fleet-orchestrator.test.ts`

**Interfaces:**
- Produces: `export interface BackgroundTaskView { id: string; type: string; description: string }` in `src/core/events.ts`.
- Produces: `CoreEvent` member `{ type: "worker.tasks"; sessionId: string; workerId: string; tasks: BackgroundTaskView[] }` — emitted exactly when the **listed** set changes (including to `[]`); `worker.status` is unchanged.
- Produces: `Worker.listedBackgroundTasks(): BackgroundTaskView[]`; `WorkerAgent.backgroundTasks?(): BackgroundTaskView[]`; `FleetOrchestrator.list()` rows gain `tasks?: BackgroundTaskView[]` (live workers with a non-empty listed set only).
- Produces: AgentEvent shapes `background_task { …, description?: string; ambient?: boolean }`, `background_tasks { tasks: Array<{ taskId; taskType; description?: string; ambient?: boolean }> }`.

- [ ] **Step 1: Write failing tests:**
  - claude-backend: `background_tasks_changed carries description and ambient` — SDK frame `{ tasks: [{ task_id: "b1", task_type: "local_bash", description: "npm run dev" }, { task_id: "m1", task_type: "monitor", description: "watch", ambient: true }] }` decodes to those fields; `task_started` with `description` carries it on the edge event.
  - worker: `listed tasks exclude ambient, subagents and workflows` — level frame with `local_bash` (listed), `ambient:true` task, `local_agent`, `local_workflow` → `listedBackgroundTasks()` returns only the bash task; the worker is still `background` after `turn_end` while any of the four runs (state model unchanged).
  - worker: `emits worker.tasks only when the listed set changes` — two level frames with the same listed set → one event; listed set emptied → an event with `tasks: []`; a change only in an excluded task → no event.
  - worker: `tasks are listed while running` — level frame mid-turn → `worker.tasks` emitted while status is `running`.
  - fleet-orchestrator: `fleet.list rows carry tasks` — a live worker with one listed task → its row has `tasks: [{ id, type, description }]`; others have no `tasks` key.
- [ ] **Step 2: Run** the three files — FAIL.
- [ ] **Step 3: Implement.** Decode the two optional fields; store `{ type, description, ambient }` per task id (edge frames fill what they carry; level frames replace). After any membership change compute the listed view; compare with the last emitted listed view (by ids + descriptions) and emit `worker.tasks` on the bus the same way `worker.status` is emitted. Clear the listed view (emit `[]` if non-empty) where `bgTasks` is cleared today (stream replacement/stop).
- [ ] **Step 4: Run** the files + root gates — PASS.
- [ ] **Step 5: Commit** `feat(worker): track and publish listed background tasks`.

### Task 6: Stop one background task

**Files:**
- Modify: `src/core/agent-backend.ts` (`AgentStream.stopTask?`), `src/core/claude-backend.ts` (`ClaudeStream.stopTask`)
- Modify: `src/core/worker.ts` (`stopTask`), `src/core/fleet-orchestrator.ts` (`WorkerAgent.stopTask?`, `stopTask`)
- Modify: `src/protocol/messages.ts` (client schema + response map), `src/daemon/connection.ts` (route)
- Test: `test/core/claude-backend.test.ts`, `test/core/worker.test.ts`, `test/core/fleet-orchestrator.test.ts`, `test/protocol/messages.test.ts`, `test/daemon/connection.test.ts`

**Interfaces:**
- Consumes: `Worker.listedBackgroundTasks()` (Task 5).
- Produces: `AgentStream.stopTask?(taskId: string): Promise<void>`; `Worker.stopTask(taskId: string): Promise<void>` (throws `Error("Unknown background task <id>")` if not in the listed set, `Error("Worker <id> is not running")` if terminal, `Error("Stopping background tasks is not supported for this worker")` if the stream lacks `stopTask`); `FleetOrchestrator.stopTask(id: string, taskId: string): Promise<void>` (`requireLive` then delegate).
- Produces: client message `{ type: "worker.task.stop", id: string, taskId: string, reqId?: string }`; reply `{ type: "fleet.ack", reqId, action: "task.stop", id }`; errors use the existing `{ type: "error", message, reqId }`.

- [ ] **Step 1: Write failing tests:**
  - claude-backend: `stopTask calls query.stopTask` with `"b1"`.
  - worker: `stopTask delegates for a listed task and leaves state alone` (status unchanged right after the call); `rejects unknown, excluded (local_agent) and already-settled task ids`; `rejects on a terminal worker`; `rejects when the stream has no stopTask (codex)`.
  - fleet-orchestrator: `stopTask on an unknown/detached worker throws` (existing `requireLive` message).
  - protocol: `worker.task.stop parses; missing taskId rejects`.
  - connection: `worker.task.stop replies fleet.ack`; `worker.task.stop error replies error with reqId`.
- [ ] **Step 2: Run** the files — FAIL.
- [ ] **Step 3: Implement** as specified; `ClaudeStream.stopTask` uses `(this.q as { stopTask?: (id: string) => Promise<void> }).stopTask?.(taskId)` like the other optional controls and throws if absent. The connection route mirrors `worker.interrupt` (await, ack on success; errors through the global catch).
- [ ] **Step 4: Run** the files + root gates — PASS.
- [ ] **Step 5: Commit** `feat(worker): stop a single background task`.

### Task 7: Master read-only listing in `get_worker_status`

**Files:**
- Create: `src/tools/background-tasks-format.ts`
- Modify: `src/tools/fleet-tools.ts`, `src/tools/external-tools.ts`
- Test: `test/tools/background-tasks-format.test.ts`, `test/tools/fleet-tools.test.ts`, `test/tools/external-tools.test.ts`

**Interfaces:**
- Consumes: `FleetOrchestrator` access to a live worker's `backgroundTasks?()` — add `FleetOrchestrator.backgroundTasks(id: string): BackgroundTaskView[]` (`[]` when not live) in this task.
- Produces: `formatBackgroundTasks(tasks: BackgroundTaskView[]): string` — `""` for `[]`; otherwise `"\nbackground tasks:\n- <type>: <description>"` per task, description truncated to 120 chars with `…`.

- [ ] **Step 1: Write failing tests:** formatter (empty → `""`; two tasks → two lines; 200-char description → 120 + `…`); `get_worker_status` output for a worker with one listed task ends with `background tasks:\n- local_bash: npm run dev` (both fleet and external tools); unchanged output when there are none.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** the formatter and append it to both tools' status text.
- [ ] **Step 4: Run** + root gates — PASS.
- [ ] **Step 5: Commit** `feat(fleet): list background tasks in get_worker_status`.

### Task 8: Desktop — task list and stop from the worker header

**Files:**
- Modify: `apps/desktop/src/renderer/store/reduce.ts` (`FleetRow.tasks`, `worker.tasks` case), `apps/desktop/src/renderer/store/store.ts` (fleet seed keeps `tasks` from `fleet.list`)
- Modify: `apps/desktop/src/renderer/components/WorkspaceHeaders.tsx` (replace the `background && bg.count` branch of `WorkerActivityReason` with a task button + `ContextMenu`; new `onStopTask` prop on `WorkerHeader`)
- Modify: `apps/desktop/src/renderer/App.tsx` (wire `onStopTask` → `client.request({ type: "worker.task.stop", id, taskId })`, `toast.error` on failure like `subInterrupt`)
- Modify: `apps/desktop/src/renderer/i18n/locales/{ko,en}/workspaceHeaders.ts`
- Test: `apps/desktop/test/store-reduce.test.ts`, `apps/desktop/test/workspace-headers.test.tsx`

**Interfaces:**
- Consumes: `worker.tasks` event and `fleet.list` `tasks` (Task 5); `worker.task.stop` (Task 6).
- Produces: `WorkerHeader` prop `onStopTask?: (taskId: string) => void`.

- [ ] **Step 1: Write failing tests:**
  - reducer: `worker.tasks replaces the row's tasks` (and `[]` removes them); `worker.tasks for an unknown worker is ignored`; `fleet seed keeps tasks from fleet.list`.
  - header: `shows "2 bg" while running when two tasks are listed` (status `running`); `clicking opens a menu with one "Stop: <description>" item per task, and choosing one calls onStopTask("b1")`; `no task button when tasks are empty or absent (codex worker)`; `workflow label still wins when a workflow is running` (existing behavior kept).
- [ ] **Step 2: Run** `npm -w apps/desktop test -- store-reduce workspace-headers` — FAIL.
- [ ] **Step 3: Implement.** Button text `t("workspaceHeaders.backgroundTasks", { count })` (existing key) as a ghost text button (`no-drag`, `text-meta text-muted hover:text-fg-dim`, chevron 12px); `ContextMenu` at the button's bottom-left with items `{ label: t("workspaceHeaders.stopTask", { type, description }), onClick: () => onStopTask(id), hint: type }`. New keys: `workspaceHeaders.stopTask` = en `"Stop: {description}"` / ko `"중지: {description}"`, `workspaceHeaders.tasksMenu` = en `"Background tasks"` / ko `"백그라운드 작업"` (button `aria-label`).
- [ ] **Step 4: Run** desktop gates — PASS (including i18n parity/used-keys tests).
- [ ] **Step 5: Commit** `feat(desktop): list and stop worker background tasks from the header`.

### Task 9: Live verification

**Files:**
- Modify: the spec's "Left to the builder" findings section (append a short "Live findings" note) and `AGENTS.md` if a finding changes documented behavior.

- [ ] **Step 1:** Build (`npm run build`), start an isolated daemon (`ROOKERY_HOME=$(mktemp -d) ROOKERY_PORT=8899 node dist/index.js daemon`) and drive it with `scripts/demo/daemon-ws.mjs` against a scratch git repo. Never use `~/.rookery`.
- [ ] **Step 2: Codex steer.** Spawn a Codex worker on a multi-step task; mid-turn `worker.send` a redirect; expect it acted on in the same turn (no extra turn), one user echo, worker settles `idle`. Then send exactly as a turn ends; expect no loss and no stuck `running`.
- [ ] **Step 3: Claude steer.** Same with a Claude worker. Record whether `priority: "next"` delivered without aborting the running tool; if not, try `"now"` and set `CLAUDE_STEER_PRIORITY` to whichever works. Record the observed behavior.
- [ ] **Step 4: Background stop.** Ask a Claude worker to start two background shells (e.g. two `sleep 600` with distinct descriptions). Expect `worker.tasks` with two entries (log the raw `task_type` values seen, including any monitor type). `worker.task.stop` one → it leaves the list, the other stays; the worker may wake briefly and returns to `background`.
- [ ] **Step 5:** Note findings in the spec, run all gates, commit `docs: record live findings for steering and background stop`.
