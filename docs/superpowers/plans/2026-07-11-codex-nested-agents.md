# Codex Nested Agents (collab subagent) Panel Wiring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Codex workers' native collab subagents (child threads) show up in the desktop NestedAgents panel, exactly like Claude Task subagents do — with guards so child traffic cannot pollute worker turn/cost state.

**Architecture:** All provider translation happens inside the adapter (`CodexBackend.handleNotification`): child-thread notifications map to existing port events tagged `parentToolUseId = <child threadId>` (the panel group key); parent-thread collab items (`subAgentActivity`, `collabAgentToolCall`) become main-transcript tool cards. The worker's spontaneous-wake heuristic learns to ignore nested-tagged events. The desktop only gains one label-extraction regex. Spec: `docs/superpowers/specs/2026-07-11-codex-nested-agents-design.md` (read it first — it records the live-probed protocol facts).

**Tech Stack:** TypeScript ESM (NodeNext — relative imports need `.js`, type-only imports need `import type`), vitest, React 18 (desktop).

## Global Constraints

- Node 22 required (`nvm use 22`) — better-sqlite3 ABI 127.
- Code comments in English.
- Claude backend path must stay byte-identical (no changes outside the files listed).
- Root gates: `npm test` + `npm run typecheck`. Desktop task additionally: `npm -w apps/desktop run typecheck && npm -w apps/desktop test`.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Live protocol ground truth (probes, 2026-07-11, codex 0.144.1): child-thread `item/*` notifications ARE delivered to the parent's app-server client; the spawn appears as a parent `subAgentActivity` item (`item/completed` only, `kind:"started"`, carries `agentThreadId` + `agentPath`); `collabAgentToolCall` arrives as `item/started`+`item/completed` pairs (observed `tool:"wait"` with `receiverThreadIds: []` — fields can be sparse, map defensively); unawaited children keep streaming after the parent's `turn/completed`.

---

### Task 1: Backend — child-thread nested mapping + parent collab tool cards

**Files:**
- Modify: `src/core/codex/codex-backend.ts` (handleNotification ~lines 495-560 + new private members)
- Modify: `src/core/codex/codex-protocol.ts` (curated item shapes + pin comment)
- Modify: `test/helpers/fake-codex.ts` (new `raw` step)
- Test: `test/core/codex/codex-backend.test.ts`

**Interfaces:**
- Consumes: existing `AgentEvent` union (`src/core/agent-backend.ts`) — no port changes.
- Produces: `tool_use`/`tool_result`/`message` events with `parentToolUseId: <child threadId>` for child threads; parent-transcript `tool_use {id: <child threadId>, name: "spawn_agent", input: {agentPath}}` + immediate matching `tool_result`; `tool_use {name: "collab.<tool>"}`/`tool_result` pairs for `collabAgentToolCall`. Task 3's label extraction relies on the spawn card's `id === <child threadId>` and its input containing `"agentPath":"…"`.

- [ ] **Step 1: Add the `raw` step to the fake codex server**

In `test/helpers/fake-codex.ts`, add to the `CodexStep` union:

```ts
  | { kind: "raw"; method: string; params: Record<string, unknown> }; // verbatim notification (child-thread / collab-item frames)
```

and in the `turn/start` replay loop (alongside the other `else if (step.kind === …)` branches, before the `turnEnd` branch):

```ts
            } else if (step.kind === "raw") {
              send({ method: step.method, params: step.params });
```

- [ ] **Step 2: Write the failing tests**

Append to `test/core/codex/codex-backend.test.ts` (uses the existing `backend()`, `baseOpts()`, `collect()` helpers and `MessageQueue`; the fake's own thread id is `"th-1"`):

```ts
describe("CodexBackend — codex-native nested subagents (collab child threads)", () => {
  const child = "th-child";

  it("child items map to nested-tagged events; child deltas/turn/tokenUsage/progress are dropped", async () => {
    const { backend: b } = backend(() => [
      { kind: "raw", method: "item/agentMessage/delta", params: { threadId: child, itemId: "cm1", delta: "par" } },
      { kind: "raw", method: "item/reasoning/summaryTextDelta", params: { threadId: child, itemId: "cr1", delta: "think" } },
      { kind: "raw", method: "item/started", params: { threadId: child, item: { type: "commandExecution", id: "cc1", command: "echo hi", status: "inProgress" } } },
      { kind: "raw", method: "item/commandExecution/outputDelta", params: { threadId: child, itemId: "cc1", delta: "hi" } },
      { kind: "raw", method: "item/completed", params: { threadId: child, item: { type: "commandExecution", id: "cc1", command: "echo hi", status: "completed", aggregatedOutput: "hi" } } },
      { kind: "raw", method: "item/completed", params: { threadId: child, item: { type: "agentMessage", id: "cm1", text: "done 42" } } },
      { kind: "raw", method: "thread/tokenUsage/updated", params: { threadId: child, tokenUsage: { last: { inputTokens: 500 }, total: { inputTokens: 500, outputTokens: 100 }, modelContextWindow: null } } },
      { kind: "raw", method: "turn/completed", params: { threadId: child, turn: { id: "child-turn", status: "completed" } } },
      { kind: "turnEnd", durationMs: 7 },
    ]);
    const q = new MessageQueue();
    q.push("go");
    q.close();
    const events = await collect(b.openSession(q, baseOpts()));
    // child tool pair + completed message, tagged with the child threadId as the panel group key
    expect(events).toContainEqual({ kind: "tool_use", id: "cc1", name: "shell", input: { command: "echo hi", cwd: undefined }, parentToolUseId: child });
    expect(events).toContainEqual({ kind: "tool_result", toolUseId: "cc1", isError: false, content: "hi", parentToolUseId: child });
    expect(events).toContainEqual({ kind: "message", role: "assistant", text: "done 42", parentToolUseId: child });
    // child deltas suppressed (nested shows completed steps only — Claude parity)
    expect(events.filter((e) => e.kind === "text_delta")).toEqual([]);
    expect(events.filter((e) => e.kind === "thinking_delta")).toEqual([]);
    expect(events.filter((e) => e.kind === "tool_progress")).toEqual([]);
    // exactly ONE turn_end (the parent's) — the child's turn/completed emitted no phantom end,
    // and the child's tokenUsage did not bill into the parent's turn cost
    const ends = events.filter((e) => e.kind === "turn_end");
    expect(ends).toHaveLength(1);
    expect((ends[0] as { costUsd: number }).costUsd).toBe(0);
  });

  it("parent subAgentActivity(kind=started) → spawn_agent tool card pair keyed by the CHILD threadId", async () => {
    const { backend: b } = backend(() => [
      { kind: "raw", method: "item/completed", params: { threadId: "th-1", item: { type: "subAgentActivity", id: "call_1", kind: "started", agentThreadId: child, agentPath: "/root/compute" } } },
      { kind: "raw", method: "item/completed", params: { threadId: "th-1", item: { type: "subAgentActivity", id: "call_2", kind: "interacted", agentThreadId: child, agentPath: "/root/compute" } } },
      { kind: "turnEnd" },
    ]);
    const q = new MessageQueue();
    q.push("go");
    q.close();
    const events = await collect(b.openSession(q, baseOpts()));
    // id is the child threadId ON PURPOSE: the desktop's nestedLabel() finds the main-transcript
    // card whose toolId equals the panel key (= child threadId)
    expect(events).toContainEqual({ kind: "tool_use", id: child, name: "spawn_agent", input: { agentPath: "/root/compute" }, parentToolUseId: null });
    expect(events).toContainEqual({ kind: "tool_result", toolUseId: child, isError: false, content: "/root/compute", parentToolUseId: null });
    // kind !== "started" (interacted/interrupted) emits nothing
    expect(events.filter((e) => e.kind === "tool_use")).toHaveLength(1);
  });

  it("parent collabAgentToolCall started/completed → collab.<tool> card pair", async () => {
    const { backend: b } = backend(() => [
      { kind: "raw", method: "item/started", params: { threadId: "th-1", item: { type: "collabAgentToolCall", id: "call_w", tool: "wait", status: "inProgress", senderThreadId: "th-1", receiverThreadIds: [], prompt: null } } },
      { kind: "raw", method: "item/completed", params: { threadId: "th-1", item: { type: "collabAgentToolCall", id: "call_w", tool: "wait", status: "completed" } } },
      { kind: "turnEnd" },
    ]);
    const q = new MessageQueue();
    q.push("go");
    q.close();
    const events = await collect(b.openSession(q, baseOpts()));
    expect(events).toContainEqual({ kind: "tool_use", id: "call_w", name: "collab.wait", input: { prompt: null, model: undefined, receiverThreadIds: [] }, parentToolUseId: null });
    expect(events).toContainEqual({ kind: "tool_result", toolUseId: "call_w", isError: false, content: "completed", parentToolUseId: null });
  });

  it("a collabAgentToolCall on a CHILD thread lands in that child's panel (grandchild spawn visibility)", async () => {
    const { backend: b } = backend(() => [
      { kind: "raw", method: "item/started", params: { threadId: child, item: { type: "collabAgentToolCall", id: "call_g", tool: "spawnAgent", status: "inProgress", prompt: "do sub-work" } } },
      { kind: "turnEnd" },
    ]);
    const q = new MessageQueue();
    q.push("go");
    q.close();
    const events = await collect(b.openSession(q, baseOpts()));
    expect(events).toContainEqual({ kind: "tool_use", id: "call_g", name: "collab.spawnAgent", input: { prompt: "do sub-work", model: undefined, receiverThreadIds: undefined }, parentToolUseId: child });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/core/codex/codex-backend.test.ts -t "nested subagents"`
Expected: 4 FAIL (child events dropped today; no spawn_agent/collab.* events exist).

- [ ] **Step 4: Add curated protocol shapes**

In `src/core/codex/codex-protocol.ts`: update the header pin comment to say ground truth was regenerated from CLI **0.144.1** (2026-07-11) which introduced the multi-agent (collab) vocabulary, and append:

```ts
// Multi-agent (collab) items — 0.144.x protocol (`multi_agent` feature, stable/default-on).
// Both arrive as thread items on the SPAWNING thread; child-thread activity arrives as ordinary
// item/* notifications tagged with the child's threadId (live-probed 2026-07-11,
// .superpowers/sdd/probe-collab-spawn.mjs / probe-collab-nowait.mjs).
export interface CodexCollabAgentToolCallItem {
  type: "collabAgentToolCall";
  id: string;
  tool?: string; // spawnAgent | sendInput | resumeAgent | wait | closeAgent
  status?: string; // inProgress | completed | failed (observed values)
  senderThreadId?: string;
  receiverThreadIds?: string[];
  prompt?: string | null;
  model?: string | null;
}
export interface CodexSubAgentActivityItem {
  type: "subAgentActivity";
  id: string;
  kind?: string; // started | interacted | interrupted
  agentThreadId?: string;
  agentPath?: string;
}
```

- [ ] **Step 5: Implement the backend mapping**

In `src/core/codex/codex-backend.ts`:

**(a)** Extend the duck-typed `p.item` shape in `handleNotification` with the collab fields (keep the existing fields; `tool` already exists for mcpToolCall):

```ts
      item?: { type?: string; id?: string; text?: string; command?: string; cwd?: string; status?: string; aggregatedOutput?: string | null; server?: string; tool?: string; arguments?: unknown; query?: string; changes?: unknown; result?: unknown; kind?: string; agentThreadId?: string; agentPath?: string; prompt?: string | null; model?: string | null; receiverThreadIds?: string[] };
```

Also add a named alias right above `handleNotification` so the helpers below can share it (TypeScript: extract the current inline item type into `type CodexItemShape = { … }` — module-private, same fields as above — and use it both in the inline cast and the helpers).

**(b)** Replace the thread filter early-return:

```ts
    // Child-thread traffic (codex-native collab subagents, multi_agent stable since 0.144.x):
    // route to the nested mapper instead of dropping. Any non-own thread — children AND
    // grandchildren — gets its own flat panel keyed by its threadId
    // (docs/superpowers/specs/2026-07-11-codex-nested-agents-design.md).
    if (this.threadId && p?.threadId && p.threadId !== this.threadId) {
      this.handleChildNotification(p.threadId, method, p.item);
      return;
    }
```

**(c)** Extract shared item→event helpers (module-private functions or private statics — either is fine, keep them next to `handleNotification`). They must reproduce the CURRENT parent mappings exactly, parameterized by the panel key:

```ts
// Shared thread-item → port-event mapping, used by the own-thread path (parent: null) and the
// child-thread nested path (parent: child threadId). Returns null for non-tool items.
function toolUseOf(item: CodexItemShape, parent: string | null): AgentEvent | null {
  if (!item.id) return null;
  if (item.type === "commandExecution") return { kind: "tool_use", id: item.id, name: "shell", input: { command: item.command, cwd: item.cwd }, parentToolUseId: parent };
  if (item.type === "fileChange") return { kind: "tool_use", id: item.id, name: "apply_patch", input: { changes: item.changes }, parentToolUseId: parent };
  if (item.type === "mcpToolCall") return { kind: "tool_use", id: item.id, name: `${item.server ?? "mcp"}.${item.tool ?? "tool"}`, input: item.arguments, parentToolUseId: parent };
  if (item.type === "webSearch") return { kind: "tool_use", id: item.id, name: "web_search", input: { query: item.query }, parentToolUseId: parent };
  if (item.type === "collabAgentToolCall") return { kind: "tool_use", id: item.id, name: `collab.${item.tool ?? "call"}`, input: { prompt: item.prompt, model: item.model, receiverThreadIds: item.receiverThreadIds }, parentToolUseId: parent };
  return null;
}

function toolResultOf(item: CodexItemShape, parent: string | null): AgentEvent | null {
  if (!item.id) return null;
  if (item.type === "commandExecution") return { kind: "tool_result", toolUseId: item.id, isError: item.status !== "completed", content: item.aggregatedOutput ?? "", parentToolUseId: parent };
  if (item.type === "fileChange") return { kind: "tool_result", toolUseId: item.id, isError: item.status !== "completed", content: item.status ?? "", parentToolUseId: parent };
  if (item.type === "mcpToolCall" || item.type === "webSearch") return { kind: "tool_result", toolUseId: item.id, isError: item.status != null && item.status !== "completed", content: serializeMcpResult(item.result, item.status ?? "done"), parentToolUseId: parent };
  if (item.type === "collabAgentToolCall") return { kind: "tool_result", toolUseId: item.id, isError: item.status != null && item.status !== "completed", content: item.status ?? "done", parentToolUseId: parent };
  return null;
}

// The spawn marker: a parent-side item/completed carrying the new child's identity. Mapped to a
// synthetic tool_use + immediate tool_result pair whose id IS the child threadId — the desktop's
// nestedLabel() finds the main-transcript card whose toolId equals the panel key, so labeling
// works with zero reducer changes. kind !== "started" (interacted/interrupted) is observability
// noise — no card.
function spawnCardsOf(item: CodexItemShape, parent: string | null): AgentEvent[] {
  if (item.type !== "subAgentActivity" || item.kind !== "started" || !item.agentThreadId) return [];
  return [
    { kind: "tool_use", id: item.agentThreadId, name: "spawn_agent", input: { agentPath: item.agentPath }, parentToolUseId: parent },
    { kind: "tool_result", toolUseId: item.agentThreadId, isError: false, content: item.agentPath ?? "", parentToolUseId: parent },
  ];
}
```

**(d)** Rewrite the own-thread `item/started` / `item/completed` branches on top of the helpers (behavior for the four existing types must stay identical, including the progress-clock bookkeeping):

```ts
    if (method === "item/started") {
      const item = p?.item;
      if (!item?.id) return;
      const ev = toolUseOf(item, null);
      if (!ev) return; // non-tool item (agentMessage/reasoning/…): no progress tracking
      this.channel.push(ev);
      this.toolStartMs.set(item.id, Date.now()); // begin the elapsed-time clock for this tool's progress heartbeat
      return;
    }
    if (method === "item/completed") {
      const item = p?.item;
      if (!item?.id) return;
      this.clearToolProgress(item.id); // tool finished → stop its progress heartbeat
      if (item.type === "agentMessage") {
        if (item.text) this.channel.push({ kind: "message", role: "assistant", text: item.text, parentToolUseId: null });
        return;
      }
      for (const ev of spawnCardsOf(item, null)) this.channel.push(ev);
      const res = toolResultOf(item, null);
      if (res) this.channel.push(res);
      return; // reasoning/userMessage/plan/etc.: dropped (deltas already flowed; user echo is Worker-side)
    }
```

**(e)** Add the child mapper:

```ts
  // Codex-native nested subagent (collab child thread) traffic → port events tagged with
  // parentToolUseId = child threadId (the NestedAgents panel group key — worker.ts routes these
  // to worker.nested, live-only). Completed messages and tool pairs only: child deltas /
  // outputDelta / progress are suppressed (nested shows completed steps — Claude parity), and
  // child turn/* + thread/tokenUsage/updated are dropped so they can never emit a phantom
  // turn_end, clear activeTurnId, or bill into this turn's turnAccum.
  private handleChildNotification(childThreadId: string, method: string, item: CodexItemShape | undefined): void {
    if (method === "item/started") {
      if (!item) return;
      const ev = toolUseOf(item, childThreadId);
      if (ev) this.channel.push(ev); // no toolStartMs: the progress heartbeat is main-transcript-only
      return;
    }
    if (method === "item/completed") {
      if (!item) return;
      if (item.type === "agentMessage") {
        if (item.text) this.channel.push({ kind: "message", role: "assistant", text: item.text, parentToolUseId: childThreadId });
        return;
      }
      for (const ev of spawnCardsOf(item, childThreadId)) this.channel.push(ev); // grandchild spawns show in the child's panel
      const res = toolResultOf(item, childThreadId);
      if (res) this.channel.push(res);
    }
    // everything else from child threads: dropped
  }
```

Note: the idle-watchdog reset at the top of `handleNotification` stays where it is (before the branch) — child activity is genuine progress while the parent waits.

- [ ] **Step 6: Run the new tests**

Run: `npx vitest run test/core/codex/codex-backend.test.ts`
Expected: ALL pass (the 4 new ones AND every pre-existing test — the helper refactor must not change parent-path behavior).

- [ ] **Step 7: Full root gate**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/core/codex/codex-backend.ts src/core/codex/codex-protocol.ts test/helpers/fake-codex.ts test/core/codex/codex-backend.test.ts
git commit -m "feat(codex): map collab child-thread activity to nested-agent events

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Worker — nested traffic must not trigger the spontaneous-wake heuristic

**Files:**
- Modify: `src/core/worker.ts` (~lines 314-325, the wake check in `consume()`)
- Modify: `src/core/agent-backend.ts` (~lines 40-45, the stale `background_task` comment)
- Test: `test/core/worker.test.ts` (inside `describe("Worker background state machine")`)

**Interfaces:**
- Consumes: `AgentEvent` union — `message`/`tool_use`/`tool_result` carry `parentToolUseId` (Task 1 makes codex emit them post-turn).
- Produces: no new API. Behavior guarantee for later work: nested-tagged events never flip `turnActive`.

- [ ] **Step 1: Write the failing test**

Add inside `describe("Worker background state machine")` in `test/core/worker.test.ts` (uses the existing `mk()` helper of that describe; `fakeStreamingBackend` maps `{type:"assistant", parentToolUseId}` through the real ClaudeBackend, preserving the tag):

```ts
  it("nested-tagged traffic after the turn ends does NOT wake the worker (codex collab child keeps streaming post-turn)", async () => {
    const x = mk(() => [
      { type: "assistant", text: "spawned a child" },
      { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" },
      // codex-native child thread still streaming AFTER the parent turn ended (live-verified 2026-07-11)
      { type: "assistant", text: "child says 42", parentToolUseId: "th-child" },
    ]);
    const nestedEvents: Array<{ parentToolUseId: string }> = [];
    x.bus.subscribe("s1", (e) => { if (e.type === "worker.nested") nestedEvents.push({ parentToolUseId: e.parentToolUseId }); });
    x.agent.start("go");
    await until(() => x.agent.status() === "idle");
    await new Promise((r) => setTimeout(r, 40)); // let the trailing nested frame flow
    expect(x.agent.status()).toBe("idle"); // did NOT flip back to running
    expect(x.statusEvents.map((s) => s.status)).not.toContain("running");
    // the nested frame still reached the panel path
    expect(nestedEvents).toEqual([{ parentToolUseId: "th-child" }]);
    await x.agent.stop();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/core/worker.test.ts -t "does NOT wake"`
Expected: FAIL — today the nested message flips `turnActive` → a `running` status event (and/or the `until(idle)` never resolves because no `turn_end` follows).

- [ ] **Step 3: Implement the guard**

In `src/core/worker.ts`, the spontaneous-wake check currently reads:

```ts
        if (
          !this.turnActive &&
          (ev.kind === "text_delta" || ev.kind === "thinking_delta" || ev.kind === "message" || ev.kind === "tool_use" || ev.kind === "tool_result" || ev.kind === "tool_progress")
        ) {
          this.turnActive = true;
          this.reconcile();
        }
```

Change to:

```ts
        // Nested-subagent traffic is NOT the worker's own turn: codex collab children keep
        // streaming after the parent turn ends (live-verified 2026-07-11), and counting them
        // here would flip a settled worker back to running with no turn_end ever coming.
        // (On Claude nested frames only flow mid-turn, so this exclusion is a no-op there.)
        const nested = (ev.kind === "message" || ev.kind === "tool_use" || ev.kind === "tool_result") && ev.parentToolUseId != null;
        if (
          !this.turnActive &&
          !nested &&
          (ev.kind === "text_delta" || ev.kind === "thinking_delta" || ev.kind === "message" || ev.kind === "tool_use" || ev.kind === "tool_result" || ev.kind === "tool_progress")
        ) {
          this.turnActive = true;
          this.reconcile();
        }
```

- [ ] **Step 4: Update the stale port comment**

In `src/core/agent-backend.ts`, the `background_task` comment block currently ends with:

```ts
  // are all just "settled" here — the state machine only needs the count). Codex never emits this
  // (its items complete inside the turn; no background concept in app-server 0.142.5).
```

Replace those two lines with:

```ts
  // are all just "settled" here — the state machine only needs the count). Codex does not emit
  // this YET: unawaited collab child threads DO outlive the turn (live-verified 2026-07-11,
  // probe-collab-nowait.mjs) but are only surfaced as nested-panel traffic, not background_task
  // (scope-A decision, docs/superpowers/specs/2026-07-11-codex-nested-agents-design.md).
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/core/worker.test.ts`
Expected: ALL pass (new test + every pre-existing wake/background test unchanged).

- [ ] **Step 6: Full root gate**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/worker.ts src/core/agent-backend.ts test/core/worker.test.ts
git commit -m "fix(worker): exclude nested-subagent traffic from the spontaneous-wake heuristic

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Desktop — shared nestedLabel with agentPath extraction

**Files:**
- Create: `apps/desktop/src/renderer/lib/nested-label.ts`
- Modify: `apps/desktop/src/renderer/components/RightSidebar.tsx` (delete its local `nestedLabel`, import the shared one)
- Modify: `apps/desktop/src/renderer/workspace/panels.tsx` (same — this was a marked "dedupe later" copy)
- Test: `apps/desktop/test/nested-label.test.ts`

**Interfaces:**
- Consumes: `LogItem` from `apps/desktop/src/renderer/store/reduce.js`; Task 1's spawn card contract (main-transcript tool with `toolId === <panel key>` whose input JSON contains `"agentPath":"…"`).
- Produces: `export function nestedLabel(mainLog: LogItem[], parentId: string): string`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/test/nested-label.test.ts` (jsdom/vitest, same conventions as sibling tests — plain `.ts`, no DOM needed):

```ts
import { describe, it, expect } from "vitest";
import { nestedLabel } from "../src/renderer/lib/nested-label.js";
import type { LogItem } from "../src/renderer/store/reduce.js";

const tool = (toolId: string, input: string): LogItem =>
  ({ kind: "tool", toolId, name: "x", input, state: "complete" }) as unknown as LogItem;

describe("nestedLabel", () => {
  it("extracts subagent_type/description from a Claude Task card", () => {
    const log = [tool("t1", '{"subagent_type":"reviewer","description":"check the diff"}')];
    expect(nestedLabel(log, "t1")).toBe("reviewer: check the diff");
  });

  it("extracts agentPath from a codex spawn_agent card", () => {
    const log = [tool("th-child", '{"agentPath":"/root/compute_answer"}')];
    expect(nestedLabel(log, "th-child")).toBe("/root/compute_answer");
  });

  it("falls back to a short id when nothing matches", () => {
    expect(nestedLabel([], "0123456789")).toBe("worker 012345");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm -w apps/desktop test -- nested-label`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Create the shared helper**

Create `apps/desktop/src/renderer/lib/nested-label.ts`:

```ts
import type { LogItem } from "../store/reduce.js";

// Nested-agent panel label, from the main-transcript tool card whose toolId equals the panel key:
// Claude → the Task call's subagent_type/description; Codex → the spawn_agent card's agentPath
// (the panel key IS the child threadId there — see codex-backend.ts spawnCardsOf). The input JSON
// may be truncated at 4000 chars, so extract robustly with regexes instead of JSON.parse.
export function nestedLabel(mainLog: LogItem[], parentId: string): string {
  const tool = mainLog.find((i) => i.kind === "tool" && i.toolId === parentId);
  const input = tool && tool.kind === "tool" ? (tool.input ?? "") : "";
  const sub = input.match(/"subagent_type"\s*:\s*"([^"]+)"/)?.[1];
  const desc = input.match(/"description"\s*:\s*"([^"]+)"/)?.[1];
  const agentPath = input.match(/"agentPath"\s*:\s*"([^"]+)"/)?.[1];
  return [sub, desc].filter(Boolean).join(": ") || agentPath || `worker ${parentId.slice(0, 6)}`;
}
```

(Match the field access against the real `LogItem` tool variant in `store/reduce.ts` before finalizing — the two existing copies read `i.kind === "tool" && i.toolId === parentId` and `t.input`, so the signature above is already conformant.)

- [ ] **Step 4: Point both call sites at it**

In `apps/desktop/src/renderer/components/RightSidebar.tsx`: delete the local `nestedLabel` function (and its comment block), add `import { nestedLabel } from "../lib/nested-label.js";`.

In `apps/desktop/src/renderer/workspace/panels.tsx`: delete the local `nestedLabel` copy (and its "Copied from RightSidebar for the PoC; dedupe in Phase 3" comment block), add `import { nestedLabel } from "../lib/nested-label.js";`.

- [ ] **Step 5: Run the desktop gates**

Run: `npm -w apps/desktop run typecheck && npm -w apps/desktop test`
Expected: PASS (new test green; `right-sidebar.test.tsx` and workspace tests unchanged).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/lib/nested-label.ts apps/desktop/src/renderer/components/RightSidebar.tsx apps/desktop/src/renderer/workspace/panels.tsx apps/desktop/test/nested-label.test.ts
git commit -m "feat(desktop): label codex nested-agent panels via agentPath (shared nestedLabel)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Post-plan (main session, not a subagent task)

Live verification per the spec §6: build (`npm run build`), run the daemon, spawn a codex worker, instruct it to spawn a collab subagent, and confirm (a) `worker.nested` events flow (or the desktop panel renders), (b) worker status/cost stay sane after the parent turn ends while the child still runs.
