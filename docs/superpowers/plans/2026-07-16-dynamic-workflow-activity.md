# Dynamic Workflow Activity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Claude workers' Dynamic Workflow runs observable in the desktop with truthful run/agent counts, current activity, lazy agent transcripts, reconnect snapshots, and an inline Workflow card that remains active until the real background task settles.

**Architecture:** Claude SDK messages first become provider-neutral workflow launch/task events. The Worker forwards those events through an injected `WorkflowActivitySink` to one daemon-owned registry; that registry validates and tails the upstream workflow journal/transcripts through an injected filesystem port, emits bounded CoreEvent deltas, and serves reconnect/history snapshots over WS. The desktop composes Workflow Runs and existing Nested Agents under an Activity panel and updates the generic Workflow tool card by `toolUseId`. Design: `docs/superpowers/specs/2026-07-16-dynamic-workflow-activity-design.md`.

**Tech Stack:** TypeScript ESM/NodeNext, Node 22, Claude Agent SDK 0.3.207+, Node filesystem watcher APIs behind an injected port, zod wire validation, vitest, React 18, Zustand, Testing Library, `@tanstack/react-virtual`.

## Global Constraints

- Activate Node 22 before every npm/build/test command (`nvm use 22` or put Node 22 first on `PATH`); `better-sqlite3` requires ABI 127.
- Code comments are English. User-visible copy is duplicated in desktop ko/en catalogs.
- Relative TypeScript imports include `.js`; type-only imports use `import type`.
- `src/core/` stays transport-agnostic. Real filesystem wiring happens only in `startDaemon()`.
- `worker.nested` behavior for Claude Task subagents and Codex collab children stays unchanged.
- Worker live state remains derived only from `turnActive` + background-task membership; workflow UI events never independently change `running/background/idle`.
- Do not enable `agentProgressSummaries`; consume its optional summaries only when upstream already supplies them.
- Do not expose `transcriptDir`, `scriptPath`, or another absolute workflow path over CoreEvent or WS.
- Do not infer progress percentage, ETA, total agent count, or current phase.
- No SQLite migration and no daemon-restart workflow-history reconstruction in this slice.
- A transcript observation failure degrades the run to `summary-only`; it must never reject or interrupt the agent stream.
- Overview CoreEvents contain summaries only. Raw transcript content is returned only for an explicitly requested agent, capped at 200 events and 4,000 characters per field.
- The renderer retains at most one selected agent history per worker; beginning a different selection evicts that worker's previous history cache.
- Registry emissions are throttled to at most one non-terminal run/agent batch per run per 250 ms; each batch contains only the latest summary per changed agent, and terminal updates flush immediately.
- Root gates: `npm test`, `npm run typecheck`, `npm run build`.
- Desktop gates: `npm -w apps/desktop test`, `npm -w apps/desktop run typecheck`, `npm -w apps/desktop run build`.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File map

**Create**

- `src/core/workflow-activity.ts` — provider-neutral domain types and sink/provider ports.
- `src/core/claude-workflow-transcript.ts` — pure journal and agent JSONL decoding.
- `src/daemon/claude-workflow-files.ts` — injected filesystem port + real Node implementation.
- `src/daemon/claude-workflow-registry.ts` — run lifecycle, path validation, tailing, throttling, snapshots/history.
- `test/core/claude-workflow-transcript.test.ts` — pure decoder tests.
- `test/daemon/claude-workflow-files.test.ts` — path/read boundary tests.
- `test/daemon/claude-workflow-registry.test.ts` — lifecycle/order/idempotency/degraded-mode tests.
- `apps/desktop/src/renderer/views/ActivityPanel.tsx` — Workflow Runs + Nested Agents composition.
- `apps/desktop/src/renderer/views/WorkflowRuns.tsx` — virtualized run/agent overview and selected transcript.
- `apps/desktop/test/workflow-activity.test.tsx` — Activity and Workflow UI tests.

**Modify**

- `src/core/agent-backend.ts`, `src/core/sdk-extract.ts`, `src/core/claude-backend.ts` — workflow events.
- `test/helpers/fake-query.ts`, `test/core/claude-backend.test.ts` — provider event fixtures and tests.
- `src/core/worker.ts`, `test/core/worker.test.ts` — sink integration without state-graph pollution.
- `src/core/events.ts` — workflow run/agent CoreEvents and shared history payload.
- `src/daemon/server.ts`, `src/daemon/connection.ts`, `src/protocol/messages.ts` — composition and snapshot/history requests.
- `test/daemon/connection.test.ts`, `test/protocol/messages.test.ts` — wire behavior.
- `apps/desktop/src/renderer/store/reduce.ts`, `apps/desktop/src/renderer/store/store.ts`, `apps/desktop/test/store-reduce.test.ts` — workflow store and tool-card convergence.
- `apps/desktop/src/renderer/components/RightSidebar.tsx`, `workspace/panels.tsx`, `workspace/WorkspaceRender.tsx`, `App.tsx` — Activity host and data loading.
- `apps/desktop/src/renderer/components/ToolBlock.tsx`, `ToolGroup.tsx`, `WorkspaceHeaders.tsx` — background Workflow card and compact header reason.
- `apps/desktop/src/renderer/i18n/locales/{ko,en}/rightSidebar.ts` plus a new `{ko,en}/workflowActivity.ts` catalog and the existing tool/header catalogs.
- `apps/desktop/test/store-reduce.test.ts`, `tool-block.test.tsx`, `workspace-headers.test.tsx` — reducer convergence and presentation tests.
- `AGENTS.md`, `docs/architecture/master-worker-turn.md`, `docs/reference/events.md`, `docs/reference/protocol.md` — evergreen documentation after implementation.

---

### Task 1: Provider-neutral contracts and Claude SDK workflow events

**Files:**
- Create: `src/core/workflow-activity.ts`
- Modify: `src/core/agent-backend.ts`
- Modify: `src/core/sdk-extract.ts`
- Modify: `src/core/claude-backend.ts`
- Modify: `test/helpers/fake-query.ts`
- Test: `test/core/claude-backend.test.ts`

**Interfaces:**
- Produces: `WorkflowLaunch`, `WorkflowTaskUpdate`, `Workflow*Summary`, `WorkflowActivitySink`, `WorkflowActivityProvider`, `WorkflowAgentHistoryEntry`.
- Produces AgentEvents: `{kind:"workflow_launched", launch}` and `{kind:"workflow_task", update}`.
- Later tasks consume these names exactly; do not rename fields in downstream tasks.

- [ ] **Step 1: Add fake SDK workflow frames**

Extend `FakeStep` in `test/helpers/fake-query.ts` with:

```ts
  | {
      type: "workflow_launch";
      id: string;
      taskId: string;
      runId: string;
      workflowName: string;
      summary?: string;
      transcriptDir: string;
      scriptPath?: string;
    }
  | {
      type: "task_started";
      id: string;
      taskType?: string;
      toolUseId?: string;
      description?: string;
      workflowName?: string;
    }
  | {
      type: "task_progress";
      id: string;
      description?: string;
      summary?: string;
      lastToolName?: string;
      usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
    }
  | {
      type: "task_notification";
      id: string;
      status?: "completed" | "failed" | "stopped";
      summary?: string;
      outputFile?: string;
      usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
    }
```

Replace the existing three matching `stepToMessage` branches with:

```ts
  } else if (step.type === "workflow_launch") {
    return {
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: step.id, is_error: false, content: "Workflow launched" }],
      },
      tool_use_result: {
        status: "async_launched",
        taskId: step.taskId,
        taskType: "local_workflow",
        workflowName: step.workflowName,
        runId: step.runId,
        summary: step.summary ?? "",
        transcriptDir: step.transcriptDir,
        ...(step.scriptPath ? { scriptPath: step.scriptPath } : {}),
      },
    };
  } else if (step.type === "task_started") {
    return {
      type: "system",
      subtype: "task_started",
      task_id: step.id,
      ...(step.taskType ? { task_type: step.taskType } : {}),
      ...(step.toolUseId ? { tool_use_id: step.toolUseId } : {}),
      ...(step.description ? { description: step.description } : {}),
      ...(step.workflowName ? { workflow_name: step.workflowName } : {}),
    };
  } else if (step.type === "task_progress") {
    return {
      type: "system",
      subtype: "task_progress",
      task_id: step.id,
      description: step.description ?? "",
      ...(step.summary ? { summary: step.summary } : {}),
      ...(step.lastToolName ? { last_tool_name: step.lastToolName } : {}),
      usage: step.usage ?? { total_tokens: 0, tool_uses: 0, duration_ms: 0 },
    };
  } else if (step.type === "task_notification") {
    return {
      type: "system",
      subtype: "task_notification",
      task_id: step.id,
      status: step.status ?? "completed",
      summary: step.summary ?? "",
      output_file: step.outputFile ?? "",
      ...(step.usage ? { usage: step.usage } : {}),
    };
```

- [ ] **Step 2: Write failing Claude adapter tests**

Add to `test/core/claude-backend.test.ts`:

```ts
describe("ClaudeBackend — Dynamic Workflow activity", () => {
  it("emits the generic tool result before a structured workflow launch", async () => {
    const backend = new ClaudeBackend(fakeQuery([
      {
        type: "workflow_launch",
        id: "tool-wf",
        taskId: "task-wf",
        runId: "wf_run_1",
        workflowName: "logic-audit",
        summary: "Audit core logic",
        transcriptDir: "/claude/sdk-1/subagents/workflows/wf_run_1",
        scriptPath: "/claude/sdk-1/workflows/scripts/logic-audit.js",
      },
    ]));
    const events = await collect(backend.startTurn("go", baseOpts()));
    expect(events).toEqual([
      { kind: "tool_result", toolUseId: "tool-wf", isError: false, content: "Workflow launched", parentToolUseId: null },
      {
        kind: "workflow_launched",
        launch: {
          taskId: "task-wf",
          toolUseId: "tool-wf",
          runId: "wf_run_1",
          workflowName: "logic-audit",
          summary: "Audit core logic",
          transcriptDir: "/claude/sdk-1/subagents/workflows/wf_run_1",
          scriptPath: "/claude/sdk-1/workflows/scripts/logic-audit.js",
        },
      },
    ]);
  });

  it("maps only known local_workflow task progress and preserves precise terminal outcome", async () => {
    const backend = new ClaudeBackend(fakeQuery([
      { type: "task_started", id: "shell-1", taskType: "local_bash" },
      { type: "task_progress", id: "shell-1", summary: "not a workflow" },
      { type: "task_started", id: "task-wf", taskType: "local_workflow", toolUseId: "tool-wf", workflowName: "logic-audit", description: "Audit" },
      { type: "task_progress", id: "task-wf", description: "Reviewing", summary: "Checking persistence", lastToolName: "Read", usage: { total_tokens: 50, tool_uses: 3, duration_ms: 1200 } },
      { type: "task_updated", id: "task-wf", status: "failed" },
      { type: "task_notification", id: "task-wf", status: "failed", summary: "Agent failed", usage: { total_tokens: 60, tool_uses: 4, duration_ms: 1500 } },
    ]));
    const events = await collect(backend.startTurn("go", baseOpts()));
    expect(events.filter((event) => event.kind === "workflow_task")).toEqual([
      { kind: "workflow_task", update: { taskId: "task-wf", phase: "started", workflowName: "logic-audit", description: "Audit" } },
      { kind: "workflow_task", update: { taskId: "task-wf", phase: "progress", description: "Reviewing", summary: "Checking persistence", lastToolName: "Read", usage: { totalTokens: 50, toolUses: 3, durationMs: 1200 } } },
      { kind: "workflow_task", update: { taskId: "task-wf", phase: "settled", outcome: "failed" } },
      { kind: "workflow_task", update: { taskId: "task-wf", phase: "settled", summary: "Agent failed", usage: { totalTokens: 60, toolUses: 4, durationMs: 1500 }, outcome: "failed" } },
    ]);
    expect(events.some((event) => event.kind === "workflow_task" && event.update.taskId === "shell-1")).toBe(false);
  });

  it("does not enable upstream agentProgressSummaries", async () => {
    let captured: Record<string, unknown> | undefined;
    const q = fakeQuery([]);
    const backend = new ClaudeBackend(((input: Parameters<QueryFn>[0]) => {
      captured = input.options as unknown as Record<string, unknown>;
      return q(input);
    }) as QueryFn);
    await collect(backend.openSession(new MessageQueue(), baseOpts()));
    expect(captured?.agentProgressSummaries).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the adapter tests and confirm failure**

Run:

```bash
nvm use 22
npx vitest run test/core/claude-backend.test.ts -t "Dynamic Workflow activity"
```

Expected: FAIL because `WorkflowLaunch`, `workflow_launched`, and `workflow_task` do not exist and progress is dropped.

- [ ] **Step 4: Add the exact workflow domain contracts**

Create `src/core/workflow-activity.ts` with the domain model from the design, plus the explicit provider error contract:

```ts
import type { WorkerEventData } from "./events.js";

export type WorkflowRunStatus = "running" | "completed" | "failed" | "stopped";
export type WorkflowVisibility = "live" | "summary-only";
export type WorkflowAgentStatus = "running" | "completed" | "stopped";
export type WorkflowWarning = "limited-visibility" | "partial-data";

export interface WorkflowUsage {
  totalTokens: number;
  toolUses: number;
  durationMs: number;
}

export interface WorkflowLaunch {
  taskId: string;
  toolUseId: string;
  runId: string;
  workflowName: string;
  summary: string;
  transcriptDir: string;
  scriptPath?: string;
}

export interface WorkflowTaskUpdate {
  taskId: string;
  phase: "started" | "progress" | "settled";
  workflowName?: string;
  description?: string;
  summary?: string;
  lastToolName?: string;
  usage?: WorkflowUsage;
  outcome?: "completed" | "failed" | "stopped";
}

export interface WorkflowAgentSummary {
  agentId: string;
  agentType: string;
  spawnDepth: number;
  status: WorkflowAgentStatus;
  activity: "starting" | "thinking" | "responding" | "tool" | "complete" | "stopped";
  lastToolName?: string;
  toolUses: number;
  startedAt: number;
  lastActivityAt: number;
  endedAt?: number;
}

export interface WorkflowRunSummary {
  taskId: string;
  toolUseId?: string;
  runId?: string;
  workflowName: string;
  summary: string;
  lastToolName?: string;
  status: WorkflowRunStatus;
  visibility: WorkflowVisibility;
  warning?: WorkflowWarning;
  startedAt: number;
  lastActivityAt: number;
  endedAt?: number;
  usage?: WorkflowUsage;
  counts: { started: number; active: number; completed: number; stopped: number };
}

export interface WorkflowRunSnapshot extends WorkflowRunSummary {
  agents: WorkflowAgentSummary[];
}

export interface WorkflowOwner {
  sessionId: string;
  workerId: string;
  sdkSessionId: string | null;
}

export interface WorkflowAgentHistoryEntry {
  data: WorkerEventData;
  createdAt?: string;
}

export interface WorkflowActivitySink {
  launched(owner: WorkflowOwner, launch: WorkflowLaunch): void;
  taskUpdated(owner: WorkflowOwner, update: WorkflowTaskUpdate): void;
  stopWorker(workerId: string): void;
}

export interface WorkflowActivityProvider {
  list(workerId: string): WorkflowRunSnapshot[];
  agentHistory(workerId: string, taskId: string, agentId: string): Promise<WorkflowAgentHistoryEntry[]>;
}
```

- [ ] **Step 5: Add structured launch extraction**

In `src/core/sdk-extract.ts`, add:

```ts
import type { WorkflowLaunch } from "./workflow-activity.js";

export function extractWorkflowLaunch(message: unknown): WorkflowLaunch | null {
  const raw = (message as { tool_use_result?: unknown }).tool_use_result;
  if (!raw || typeof raw !== "object") return null;
  const result = raw as Record<string, unknown>;
  if (result.status !== "async_launched" || result.taskType !== "local_workflow") return null;
  const taskId = typeof result.taskId === "string" ? result.taskId : "";
  const runId = typeof result.runId === "string" ? result.runId : "";
  const workflowName = typeof result.workflowName === "string" ? result.workflowName : "";
  const transcriptDir = typeof result.transcriptDir === "string" ? result.transcriptDir : "";
  const toolUseId = extractToolResults(message)[0]?.toolUseId ?? "";
  if (!taskId || !toolUseId || !runId || !workflowName || !transcriptDir) return null;
  return {
    taskId,
    toolUseId,
    runId,
    workflowName,
    summary: typeof result.summary === "string" ? result.summary : "",
    transcriptDir,
    ...(typeof result.scriptPath === "string" && result.scriptPath ? { scriptPath: result.scriptPath } : {}),
  };
}
```

- [ ] **Step 6: Extend the AgentEvent union and Claude decode state**

In `src/core/agent-backend.ts`, import the two workflow types and add:

```ts
import type { WorkflowLaunch, WorkflowTaskUpdate } from "./workflow-activity.js";

// inside AgentEvent
  | { kind: "workflow_launched"; launch: WorkflowLaunch }
  | { kind: "workflow_task"; update: WorkflowTaskUpdate }
```

In `src/core/claude-backend.ts`, import `extractWorkflowLaunch`, expand `DecodeState`, and add helpers:

```ts
interface DecodeState {
  lastReqContextTokens: number;
  workflowTaskIds: Set<string>;
}

function workflowUsage(raw: unknown): { totalTokens: number; toolUses: number; durationMs: number } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as { total_tokens?: number; tool_uses?: number; duration_ms?: number };
  return {
    totalTokens: usage.total_tokens ?? 0,
    toolUses: usage.tool_uses ?? 0,
    durationMs: usage.duration_ms ?? 0,
  };
}

function workflowOutcome(status: string | undefined): "completed" | "failed" | "stopped" | undefined {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "stopped" || status === "killed") return "stopped";
  return undefined;
}
```

Initialize each stream with:

```ts
const state: DecodeState = { lastReqContextTokens: 0, workflowTaskIds: new Set() };
```

In the assistant/user branch, preserve generic event order and append the launch:

```ts
    const launch = type === "user" ? extractWorkflowLaunch(msg) : null;
    if (launch) {
      state.workflowTaskIds.add(launch.taskId);
      yield { kind: "workflow_launched", launch };
    }
```

Replace the task-frame branch with exact metadata-preserving behavior:

```ts
    if (sub === "task_started" || sub === "task_updated" || sub === "task_notification" || sub === "task_progress") {
      const tm = msg as {
        task_id?: string;
        tool_use_id?: string;
        task_type?: string;
        workflow_name?: string;
        description?: string;
        summary?: string;
        last_tool_name?: string;
        usage?: unknown;
        status?: string;
        output_file?: string;
        patch?: { status?: string };
      };
      if (!tm.task_id) return;
      if (sub === "task_started") {
        if (tm.task_type === "local_workflow") {
          state.workflowTaskIds.add(tm.task_id);
          yield {
            kind: "workflow_task",
            update: {
              taskId: tm.task_id,
              phase: "started",
              ...(tm.workflow_name ? { workflowName: tm.workflow_name } : {}),
              ...(tm.description ? { description: tm.description } : {}),
            },
          };
        }
        yield { kind: "background_task", taskId: tm.task_id, taskType: tm.task_type, status: "started" };
        return;
      }
      if (sub === "task_progress") {
        if (state.workflowTaskIds.has(tm.task_id)) {
          yield {
            kind: "workflow_task",
            update: {
              taskId: tm.task_id,
              phase: "progress",
              ...(tm.description ? { description: tm.description } : {}),
              ...(tm.summary ? { summary: tm.summary } : {}),
              ...(tm.last_tool_name ? { lastToolName: tm.last_tool_name } : {}),
              ...(workflowUsage(tm.usage) ? { usage: workflowUsage(tm.usage) } : {}),
            },
          };
        }
        return;
      }
      const rawStatus = sub === "task_notification" ? tm.status : tm.patch?.status;
      const outcome = workflowOutcome(rawStatus);
      if (outcome && state.workflowTaskIds.has(tm.task_id)) {
        yield {
          kind: "workflow_task",
          update: {
            taskId: tm.task_id,
            phase: "settled",
            ...(tm.summary ? { summary: tm.summary } : {}),
            ...(workflowUsage(tm.usage) ? { usage: workflowUsage(tm.usage) } : {}),
            outcome,
          },
        };
      }
      if (sub === "task_notification" || outcome) {
        yield { kind: "background_task", taskId: tm.task_id, status: "settled" };
      }
      return;
    }
```

- [ ] **Step 7: Run focused and full adapter tests**

Run:

```bash
npx vitest run test/core/claude-backend.test.ts -t "Dynamic Workflow activity"
npx vitest run test/core/claude-backend.test.ts
npm run typecheck
```

Expected: all PASS; existing background-state and option-assembly tests remain unchanged.

- [ ] **Step 8: Commit Task 1**

```bash
git add src/core/workflow-activity.ts src/core/agent-backend.ts src/core/sdk-extract.ts src/core/claude-backend.ts test/helpers/fake-query.ts test/core/claude-backend.test.ts
git commit -m "feat: decode dynamic workflow activity" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Pure Claude workflow journal and agent transcript decoder

**Files:**
- Create: `src/core/claude-workflow-transcript.ts`
- Test: `test/core/claude-workflow-transcript.test.ts`

**Interfaces:**
- Produces `parseWorkflowJournalLine`, `parseWorkflowAgentMeta`, `parseWorkflowAgentLine`, and `parseWorkflowAgentHistory`.
- Task 4's registry consumes both the delta parsers and `parseWorkflowAgentHistory`; Task 6 only exposes that provider method over WS.

- [ ] **Step 1: Write failing pure decoder tests**

Create `test/core/claude-workflow-transcript.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  parseWorkflowAgentHistory,
  parseWorkflowAgentLine,
  parseWorkflowAgentMeta,
  parseWorkflowJournalLine,
} from "../../src/core/claude-workflow-transcript.js";

describe("Claude Dynamic Workflow transcript decoding", () => {
  it("accepts only bounded started/result journal records", () => {
    expect(parseWorkflowJournalLine('{"type":"started","agentId":"a1","key":"k"}')).toEqual({ type: "started", agentId: "a1" });
    expect(parseWorkflowJournalLine('{"type":"result","agentId":"a1","key":"k","result":{"ok":true}}')).toEqual({ type: "result", agentId: "a1" });
    expect(parseWorkflowJournalLine('{"type":"other","agentId":"a1"}')).toBeNull();
    expect(parseWorkflowJournalLine('{"type":"started","agentId":"../../escape","key":"k"}')).toBeNull();
    expect(parseWorkflowJournalLine("not-json")).toBeNull();
    expect(parseWorkflowJournalLine("x".repeat(1_048_577))).toBeNull();
  });

  it("reads workflow agent metadata defensively", () => {
    expect(parseWorkflowAgentMeta('{"agentType":"workflow-subagent","spawnDepth":2}')).toEqual({ agentType: "workflow-subagent", spawnDepth: 2 });
    expect(parseWorkflowAgentMeta('{"agentType":7,"spawnDepth":-1}')).toEqual({ agentType: "workflow-subagent", spawnDepth: 1 });
  });

  it("derives bounded overview activity without exposing content", () => {
    expect(parseWorkflowAgentLine('{"timestamp":"2026-07-16T00:00:00.000Z","type":"assistant","attributionAgent":"workflow-subagent","message":{"role":"assistant","content":[{"type":"thinking","thinking":"secret"}]}}')).toEqual({ at: Date.parse("2026-07-16T00:00:00.000Z"), activity: "thinking", agentType: "workflow-subagent", toolUses: 0 });
    expect(parseWorkflowAgentLine('{"timestamp":"2026-07-16T00:00:01.000Z","type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/secret"}}]}}')).toEqual({ at: Date.parse("2026-07-16T00:00:01.000Z"), activity: "tool", lastToolName: "Read", toolUses: 1 });
  });

  it("turns one selected agent transcript into capped WorkerEventData", () => {
    const long = "x".repeat(5_000);
    const jsonl = [
      JSON.stringify({ timestamp: "2026-07-16T00:00:00.000Z", type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "reason" }] } }),
      JSON.stringify({ timestamp: "2026-07-16T00:00:01.000Z", type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: long } }] } }),
      JSON.stringify({ timestamp: "2026-07-16T00:00:02.000Z", type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: long }] } }),
      JSON.stringify({ timestamp: "2026-07-16T00:00:03.000Z", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
    ].join("\n");
    const events = parseWorkflowAgentHistory(jsonl);
    expect(events).toHaveLength(4);
    expect(events[0]).toEqual({ data: { kind: "thinking", text: "reason" }, createdAt: "2026-07-16T00:00:00.000Z" });
    expect(events[1]?.data.kind).toBe("tool_use");
    expect(events[1]?.data.kind === "tool_use" ? events[1].data.input.length : 0).toBeLessThanOrEqual(4_000);
    expect(events[2]?.data.kind === "tool_result" ? events[2].data.content.length : 0).toBeLessThanOrEqual(4_000);
    expect(events[3]).toEqual({ data: { kind: "message", role: "assistant", content: "done" }, createdAt: "2026-07-16T00:00:03.000Z" });
  });

  it("keeps only the newest 200 rendered events", () => {
    const jsonl = Array.from({ length: 205 }, (_, index) => JSON.stringify({ timestamp: new Date(index * 1_000).toISOString(), type: "assistant", message: { role: "assistant", content: [{ type: "text", text: String(index) }] } })).join("\n");
    const events = parseWorkflowAgentHistory(jsonl);
    expect(events).toHaveLength(200);
    expect(events[0]?.data).toMatchObject({ kind: "message", content: "5" });
  });
});
```

- [ ] **Step 2: Run the decoder test and confirm failure**

```bash
npx vitest run test/core/claude-workflow-transcript.test.ts
```

Expected: FAIL because the decoder module does not exist.

- [ ] **Step 3: Implement the complete pure decoder**

Create `src/core/claude-workflow-transcript.ts`:

```ts
import type { WorkerEventData } from "./events.js";
import type { WorkflowAgentHistoryEntry } from "./workflow-activity.js";
import { truncateBytes } from "./truncate.js";

const MAX_LINE_BYTES = 1_048_576;
const MAX_FIELD_BYTES = 4_000;
const MAX_HISTORY_EVENTS = 200;

export type WorkflowJournalRecord = { type: "started" | "result"; agentId: string };
export type WorkflowAgentMeta = { agentType: string; spawnDepth: number };
export type WorkflowAgentDelta = {
  at: number;
  activity: "thinking" | "responding" | "tool";
  agentType?: string;
  lastToolName?: string;
  toolUses: number;
};

function objectOf(line: string): Record<string, unknown> | null {
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) return null;
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function parseWorkflowJournalLine(line: string): WorkflowJournalRecord | null {
  const value = objectOf(line);
  if (!value || (value.type !== "started" && value.type !== "result") || typeof value.agentId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.agentId)) return null;
  return { type: value.type, agentId: value.agentId };
}

export function parseWorkflowAgentMeta(text: string): WorkflowAgentMeta {
  const value = objectOf(text);
  return {
    agentType: typeof value?.agentType === "string" && value.agentType ? value.agentType : "workflow-subagent",
    spawnDepth: typeof value?.spawnDepth === "number" && Number.isInteger(value.spawnDepth) && value.spawnDepth >= 0 ? value.spawnDepth : 1,
  };
}

function blocksOf(value: Record<string, unknown>): Array<Record<string, unknown>> {
  const message = value.message;
  if (!message || typeof message !== "object") return [];
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? content.filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === "object") : [];
}

export function parseWorkflowAgentLine(line: string): WorkflowAgentDelta | null {
  const value = objectOf(line);
  const at = typeof value?.timestamp === "string" ? Date.parse(value.timestamp) : Number.NaN;
  if (!value || !Number.isFinite(at) || value.type !== "assistant") return null;
  const blocks = blocksOf(value);
  const tools = blocks.filter((block) => block.type === "tool_use" && typeof block.name === "string");
  const common = typeof value.attributionAgent === "string" ? { agentType: value.attributionAgent } : {};
  const lastTool = tools.at(-1);
  if (lastTool) return { at, activity: "tool", lastToolName: String(lastTool.name), toolUses: tools.length, ...common };
  if (blocks.some((block) => block.type === "thinking")) return { at, activity: "thinking", toolUses: 0, ...common };
  if (blocks.some((block) => block.type === "text")) return { at, activity: "responding", toolUses: 0, ...common };
  return null;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => block && typeof block === "object" && (block as { type?: string }).type === "text" ? String((block as { text?: unknown }).text ?? "") : "").join("");
}

function historyOf(line: string): WorkflowAgentHistoryEntry[] {
  const value = objectOf(line);
  if (!value || (value.type !== "assistant" && value.type !== "user")) return [];
  const createdAt = typeof value.timestamp === "string" && Number.isFinite(Date.parse(value.timestamp)) ? value.timestamp : undefined;
  const entries: WorkflowAgentHistoryEntry[] = [];
  for (const block of blocksOf(value)) {
    let data: WorkerEventData | null = null;
    if (block.type === "thinking") data = { kind: "thinking", text: truncateBytes(String(block.thinking ?? ""), MAX_FIELD_BYTES) };
    else if (block.type === "text") data = { kind: "message", role: value.type === "assistant" ? "assistant" : "user", content: truncateBytes(String(block.text ?? ""), MAX_FIELD_BYTES) };
    else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") data = { kind: "tool_use", id: block.id, name: block.name, input: truncateBytes(JSON.stringify(block.input ?? {}), MAX_FIELD_BYTES) };
    else if (block.type === "tool_result" && typeof block.tool_use_id === "string") data = { kind: "tool_result", id: block.tool_use_id, isError: Boolean(block.is_error), content: truncateBytes(textOf(block.content), MAX_FIELD_BYTES) };
    if (data) entries.push({ data, ...(createdAt ? { createdAt } : {}) });
  }
  return entries;
}

export function parseWorkflowAgentHistory(text: string): WorkflowAgentHistoryEntry[] {
  return text.split(/\r?\n/).flatMap(historyOf).slice(-MAX_HISTORY_EVENTS);
}
```

- [ ] **Step 4: Run decoder tests and root typecheck**

```bash
npx vitest run test/core/claude-workflow-transcript.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/core/claude-workflow-transcript.ts test/core/claude-workflow-transcript.test.ts
git commit -m "feat: decode workflow transcript files" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Injectable workflow filesystem boundary

**Files:**
- Create: `src/daemon/claude-workflow-files.ts`
- Test: `test/daemon/claude-workflow-files.test.ts`

**Interfaces:**
- Produces `ClaudeWorkflowFiles`, `WorkflowFileStat`, `WorkflowDirectoryWatch`, and `realClaudeWorkflowFiles`.
- Task 4 injects this port into `ClaudeWorkflowRegistry`; no registry code imports `node:fs`.

- [ ] **Step 1: Write failing filesystem-port tests**

Create `test/daemon/claude-workflow-files.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { realClaudeWorkflowFiles } from "../../src/daemon/claude-workflow-files.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))));

describe("realClaudeWorkflowFiles", () => {
  it("reads exact byte ranges and bounded text", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rookery-workflow-files-"));
    dirs.push(dir);
    const file = path.join(dir, "journal.jsonl");
    await fs.writeFile(file, "one\ntwo\n", "utf8");
    expect((await realClaudeWorkflowFiles.read(file, 4, 3)).toString("utf8")).toBe("two");
    expect(await realClaudeWorkflowFiles.readText(file, 4)).toBe("two\n");
    const stat = await realClaudeWorkflowFiles.stat(file);
    expect(stat).toMatchObject({ size: 8, isFile: true });
    expect(await realClaudeWorkflowFiles.realpath(dir)).toBe(await fs.realpath(dir));
  });

  it("reports a directory change through one disposable watcher", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rookery-workflow-watch-"));
    dirs.push(dir);
    const changed = new Promise<string | null>((resolve) => {
      const watch = realClaudeWorkflowFiles.watchDirectory(dir, (name) => {
        watch.close();
        resolve(name);
      });
    });
    await fs.writeFile(path.join(dir, "journal.jsonl"), "{}\n", "utf8");
    expect(await changed).toBe("journal.jsonl");
  });
});
```

- [ ] **Step 2: Run the filesystem test and confirm failure**

```bash
npx vitest run test/daemon/claude-workflow-files.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the real filesystem port**

Create `src/daemon/claude-workflow-files.ts`:

```ts
import fs from "node:fs";
import fsp from "node:fs/promises";

export interface WorkflowFileStat {
  size: number;
  mtimeMs: number;
  isFile: boolean;
}

export interface WorkflowDirectoryWatch {
  close(): void;
}

export interface ClaudeWorkflowFiles {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<WorkflowFileStat>;
  read(path: string, offset: number, length: number): Promise<Buffer>;
  readText(path: string, maxBytes: number): Promise<string>;
  watchDirectory(path: string, onChange: (name: string | null) => void): WorkflowDirectoryWatch;
}

export const realClaudeWorkflowFiles: ClaudeWorkflowFiles = {
  realpath: (file) => fsp.realpath(file),
  stat: async (file) => {
    const stat = await fsp.stat(file);
    return { size: stat.size, mtimeMs: stat.mtimeMs, isFile: stat.isFile() };
  },
  read: async (file, offset, length) => {
    const handle = await fsp.open(file, "r");
    try {
      const buffer = Buffer.alloc(Math.max(0, length));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  },
  readText: async (file, maxBytes) => {
    const stat = await fsp.stat(file);
    const length = Math.min(stat.size, Math.max(0, maxBytes));
    const offset = Math.max(0, stat.size - length);
    const handle = await fsp.open(file, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      if (offset === 0) return text;
      const newline = text.indexOf("\n");
      return newline === -1 ? "" : text.slice(newline + 1);
    } finally {
      await handle.close();
    }
  },
  watchDirectory: (dir, onChange) => {
    const watcher = fs.watch(dir, { persistent: false }, (_event, filename) => onChange(filename?.toString() ?? null));
    watcher.on("error", () => onChange(null)); // prevent an unhandled FSWatcher error; registry reconciliation degrades safely
    return { close: () => watcher.close() };
  },
};
```

- [ ] **Step 4: Run the filesystem test and typecheck**

```bash
npx vitest run test/daemon/claude-workflow-files.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/daemon/claude-workflow-files.ts test/daemon/claude-workflow-files.test.ts
git commit -m "feat: add workflow transcript filesystem port" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Daemon workflow registry — lifecycle, safe observation, and history

**Files:**
- Create: `src/daemon/claude-workflow-registry.ts`
- Test: `test/daemon/claude-workflow-registry.test.ts`
- Modify: `src/core/workflow-activity.ts`
- Modify: `src/core/events.ts`

**Interfaces:**
- Consumes: `ClaudeWorkflowFiles`, decoder functions from Task 2, and `EventBus`.
- Implements both `WorkflowActivitySink` and `WorkflowActivityProvider`.
- Produces `worker.workflow.run` and `worker.workflow.agent` CoreEvents after Step 4 in this task adds those event variants.
- Stable external identity is `taskId`; `runId` and `toolUseId` are optional until the structured launch arrives.

- [ ] **Step 1: Make provisional run metadata explicit in the contract**

In `src/core/workflow-activity.ts`, change the two `WorkflowRunSummary` fields and history provider signature:

```ts
export interface WorkflowRunSummary {
  taskId: string;
  toolUseId?: string;
  runId?: string;
  // all remaining fields unchanged
}

export interface WorkflowActivityProvider {
  list(workerId: string): WorkflowRunSnapshot[];
  agentHistory(workerId: string, taskId: string, agentId: string): Promise<WorkflowAgentHistoryEntry[]>;
}
```

This permits task-start-before-launch ordering without inventing an id. Desktop maps runs by `taskId`; `runId` is provider metadata only.

- [ ] **Step 2: Write a deterministic fake filesystem and failing registry tests**

Create `test/daemon/claude-workflow-registry.test.ts` with this fake and the lifecycle cases:

```ts
import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../../src/core/events.js";
import { ClaudeWorkflowRegistry } from "../../src/daemon/claude-workflow-registry.js";
import type { ClaudeWorkflowFiles } from "../../src/daemon/claude-workflow-files.js";

class FakeWorkflowFiles implements ClaudeWorkflowFiles {
  readonly files = new Map<string, string>();
  readonly watchers = new Map<string, Set<(name: string | null) => void>>();
  realpath = async (file: string) => file;
  stat = async (file: string) => {
    const text = this.files.get(file);
    if (text === undefined) throw new Error("ENOENT");
    return { size: Buffer.byteLength(text), mtimeMs: 1, isFile: true };
  };
  read = async (file: string, offset: number, length: number) => Buffer.from(this.files.get(file) ?? "").subarray(offset, offset + length);
  readText = async (file: string, maxBytes: number) => Buffer.from(this.files.get(file) ?? "").subarray(-maxBytes).toString("utf8");
  watchDirectory = (dir: string, onChange: (name: string | null) => void) => {
    const set = this.watchers.get(dir) ?? new Set();
    set.add(onChange);
    this.watchers.set(dir, set);
    return { close: () => set.delete(onChange) };
  };
  append(file: string, text: string): void {
    this.files.set(file, (this.files.get(file) ?? "") + text);
    const dir = file.slice(0, file.lastIndexOf("/"));
    for (const cb of this.watchers.get(dir) ?? []) cb(file.slice(file.lastIndexOf("/") + 1));
  }
}

const owner = { sessionId: "s1", workerId: "w1", sdkSessionId: "sdk-1" };
const dir = "/claude/sdk-1/subagents/workflows/wf-1";
const launch = { taskId: "task-1", toolUseId: "tool-1", runId: "wf-1", workflowName: "audit", summary: "Audit", transcriptDir: dir };

describe("ClaudeWorkflowRegistry", () => {
  it("merges task-start-before-launch and emits one stable taskId run", async () => {
    const files = new FakeWorkflowFiles();
    files.files.set(`${dir}/journal.jsonl`, "");
    const bus = new EventBus();
    const runs: unknown[] = [];
    bus.subscribe("s1", (event) => { if (event.type === "worker.workflow.run") runs.push(event.run); });
    const registry = new ClaudeWorkflowRegistry({ files, bus, now: () => 100, setInterval: () => ({ unref() {} }) as NodeJS.Timeout, clearInterval: () => {} });
    registry.taskUpdated(owner, { taskId: "task-1", phase: "started", workflowName: "audit", description: "Audit" });
    registry.launched(owner, launch);
    await registry.flushForTest();
    expect(registry.list("w1")).toEqual([expect.objectContaining({ taskId: "task-1", toolUseId: "tool-1", runId: "wf-1", workflowName: "audit", status: "running", visibility: "live" })]);
    expect(runs.every((run) => (run as { taskId: string }).taskId === "task-1")).toBe(true);
  });

  it("tails journal/agent files into exact active and completed counts", async () => {
    const files = new FakeWorkflowFiles();
    files.files.set(`${dir}/journal.jsonl`, "");
    const registry = new ClaudeWorkflowRegistry({ files, bus: new EventBus(), now: () => 1_000 });
    registry.launched(owner, launch);
    await registry.flushForTest();
    files.append(`${dir}/journal.jsonl`, '{"type":"started","agentId":"a1","key":"k1"}\n{"type":"started","agentId":"a2","key":"k2"}\n');
    files.files.set(`${dir}/agent-a1.meta.json`, '{"agentType":"workflow-subagent","spawnDepth":1}');
    files.append(`${dir}/agent-a1.jsonl`, '{"timestamp":"2026-07-16T00:00:00.000Z","type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{}}]}}\n');
    await registry.flushForTest();
    expect(registry.list("w1")[0]).toMatchObject({ counts: { started: 2, active: 2, completed: 0, stopped: 0 } });
    expect(registry.list("w1")[0]?.agents.find((agent) => agent.agentId === "a1")).toMatchObject({ activity: "tool", lastToolName: "Read", toolUses: 1 });
    files.append(`${dir}/journal.jsonl`, '{"type":"result","agentId":"a1","key":"k1","result":{}}\n');
    await registry.flushForTest();
    expect(registry.list("w1")[0]).toMatchObject({ counts: { started: 2, active: 1, completed: 1, stopped: 0 } });
  });

  it("preserves UTF-8 JSON when a read splits a Korean tool name", async () => {
    const files = new FakeWorkflowFiles();
    files.files.set(`${dir}/journal.jsonl`, '{"type":"started","agentId":"a1","key":"k1"}\n');
    const line = '{"timestamp":"2026-07-16T00:00:00.000Z","type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"읽기","input":{}}]}}\n';
    files.files.set(`${dir}/agent-a1.jsonl`, line);
    const koreanAt = line.indexOf("읽기");
    const splitInsideFirstCodepoint = Buffer.byteLength(line.slice(0, koreanAt), "utf8") + 1;
    const registry = new ClaudeWorkflowRegistry({ files, bus: new EventBus(), now: () => 1_500, readChunkBytes: splitInsideFirstCodepoint });
    registry.launched(owner, launch);
    await registry.flushForTest();
    expect(registry.list("w1")[0]?.agents[0]?.lastToolName).toBe("읽기");
  });

  it("coalesces rapid changes to one latest agent delta per 250 ms batch", async () => {
    const files = new FakeWorkflowFiles();
    files.files.set(`${dir}/journal.jsonl`, '{"type":"started","agentId":"a1","key":"k1"}\n');
    files.files.set(`${dir}/agent-a1.jsonl`, "");
    const bus = new EventBus();
    const deltas: Array<{ lastToolName?: string }> = [];
    bus.subscribe("s1", (event) => { if (event.type === "worker.workflow.agent") deltas.push(event.agent); });
    const registry = new ClaudeWorkflowRegistry({ files, bus, now: () => 1_750 });
    registry.launched(owner, launch);
    await registry.flushForTest();
    deltas.length = 0;
    const toolLine = (name: string) => JSON.stringify({ timestamp: "2026-07-16T00:00:00.000Z", type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `t-${name}`, name, input: {} }] } }) + "\n";
    files.append(`${dir}/agent-a1.jsonl`, toolLine("Read"));
    files.append(`${dir}/agent-a1.jsonl`, toolLine("Bash"));
    files.append(`${dir}/agent-a1.jsonl`, toolLine("Write"));
    await registry.flushForTest();
    expect(deltas).toEqual([{ agentId: "a1", agentType: "workflow-subagent", spawnDepth: 1, status: "running", activity: "tool", lastToolName: "Write", toolUses: 3, startedAt: 1_750, lastActivityAt: Date.parse("2026-07-16T00:00:00.000Z") }]);
  });

  it("makes duplicate terminal task frames idempotent and stops unfinished agents", async () => {
    const files = new FakeWorkflowFiles();
    files.files.set(`${dir}/journal.jsonl`, '{"type":"started","agentId":"a1","key":"k1"}\n');
    const bus = new EventBus();
    const terminal: unknown[] = [];
    bus.subscribe("s1", (event) => { if (event.type === "worker.workflow.run" && event.run.status !== "running") terminal.push(event.run); });
    const registry = new ClaudeWorkflowRegistry({ files, bus, now: () => 2_000 });
    registry.launched(owner, launch);
    await registry.flushForTest();
    registry.taskUpdated(owner, { taskId: "task-1", phase: "settled", outcome: "failed", summary: "failed" });
    registry.taskUpdated(owner, { taskId: "task-1", phase: "settled", outcome: "failed", summary: "failed" });
    await registry.flushForTest();
    expect(registry.list("w1")[0]).toMatchObject({ status: "failed", counts: { started: 1, active: 0, completed: 0, stopped: 1 } });
    expect(terminal).toHaveLength(1);
  });

  it("degrades invalid paths without leaking them or failing task updates", async () => {
    const files = new FakeWorkflowFiles();
    files.realpath = vi.fn(async () => "/outside/wf-1");
    const registry = new ClaudeWorkflowRegistry({ files, bus: new EventBus(), now: () => 3_000 });
    registry.launched(owner, launch);
    await registry.flushForTest();
    const run = registry.list("w1")[0]!;
    expect(run).toMatchObject({ visibility: "summary-only", warning: "limited-visibility" });
    expect(JSON.stringify(run)).not.toContain("/outside");
    registry.taskUpdated(owner, { taskId: "task-1", phase: "progress", summary: "still running" });
    expect(registry.list("w1")[0]?.summary).toBe("still running");
  });

  it("promotes summary-only to live when the workflow directory materializes after launch", async () => {
    const files = new FakeWorkflowFiles();
    let reconcile: (() => void) | undefined;
    const timer = { unref() {} } as NodeJS.Timeout;
    const registry = new ClaudeWorkflowRegistry({ files, bus: new EventBus(), now: () => 3_500, setInterval: (fn) => { reconcile = fn; return timer; }, clearInterval: () => {} });
    registry.launched(owner, launch);
    await registry.flushForTest();
    expect(registry.list("w1")[0]?.visibility).toBe("summary-only");
    files.files.set(`${dir}/journal.jsonl`, "");
    reconcile?.();
    await registry.flushForTest();
    expect(registry.list("w1")[0]?.visibility).toBe("live");
  });

  it("returns only a selected agent's bounded history", async () => {
    const files = new FakeWorkflowFiles();
    files.files.set(`${dir}/journal.jsonl`, '{"type":"started","agentId":"a1","key":"k1"}\n');
    files.files.set(`${dir}/agent-a1.jsonl`, '{"timestamp":"2026-07-16T00:00:00.000Z","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\n');
    const registry = new ClaudeWorkflowRegistry({ files, bus: new EventBus(), now: () => 4_000 });
    registry.launched(owner, launch);
    await registry.flushForTest();
    await expect(registry.agentHistory("w1", "task-1", "a1")).resolves.toEqual([{ data: { kind: "message", role: "assistant", content: "done" }, createdAt: "2026-07-16T00:00:00.000Z" }]);
    await expect(registry.agentHistory("w1", "task-1", "missing")).rejects.toThrow("unknown workflow agent");
  });
});
```

- [ ] **Step 3: Run the registry test and confirm failure**

```bash
npx vitest run test/daemon/claude-workflow-registry.test.ts
```

Expected: FAIL because the registry and workflow CoreEvents do not exist.

- [ ] **Step 4: Add workflow CoreEvent variants before implementing the registry**

In `src/core/events.ts`, import the summary types and add:

```ts
import type { WorkflowAgentSummary, WorkflowRunSummary } from "./workflow-activity.js";

// inside CoreEvent
  | { type: "worker.workflow.run"; sessionId: string; workerId: string; run: WorkflowRunSummary }
  | { type: "worker.workflow.agent"; sessionId: string; workerId: string; taskId: string; agent: WorkflowAgentSummary }
```

- [ ] **Step 5: Implement registry state, path validation, and idempotent lifecycle**

Create `src/daemon/claude-workflow-registry.ts` with these exact public/dependency types and private state. Keep all emitted view objects path-free:

```ts
import path from "node:path";
import type { EventBus } from "../core/events.js";
import {
  parseWorkflowAgentHistory,
  parseWorkflowAgentLine,
  parseWorkflowAgentMeta,
  parseWorkflowJournalLine,
} from "../core/claude-workflow-transcript.js";
import type {
  WorkflowActivityProvider,
  WorkflowActivitySink,
  WorkflowAgentHistoryEntry,
  WorkflowAgentSummary,
  WorkflowLaunch,
  WorkflowOwner,
  WorkflowRunSnapshot,
  WorkflowRunStatus,
  WorkflowTaskUpdate,
} from "../core/workflow-activity.js";
import type { ClaudeWorkflowFiles, WorkflowDirectoryWatch } from "./claude-workflow-files.js";

interface RegistryDeps {
  files: ClaudeWorkflowFiles;
  bus: EventBus;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearInterval?: (timer: NodeJS.Timeout) => void;
  setTimeout?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeout?: (timer: NodeJS.Timeout) => void;
  readChunkBytes?: number;
}

interface AgentState extends WorkflowAgentSummary {
  fileOffset: number;
  partial: string;
  decoder: StringDecoder;
}

interface RunState {
  owner: WorkflowOwner;
  taskId: string;
  toolUseId?: string;
  runId?: string;
  workflowName: string;
  summary: string;
  lastToolName?: string;
  status: WorkflowRunStatus;
  visibility: "live" | "summary-only";
  warning?: "limited-visibility" | "partial-data";
  startedAt: number;
  lastActivityAt: number;
  endedAt?: number;
  usage?: { totalTokens: number; toolUses: number; durationMs: number };
  transcriptDir?: string;
  candidateDir?: string;
  agents: Map<string, AgentState>;
  pendingAgentIds: Set<string>;
  journalOffset: number;
  journalPartial: string;
  journalDecoder: StringDecoder;
  watch?: WorkflowDirectoryWatch;
  reconcileTimer?: NodeJS.Timeout;
  emitTimer?: NodeJS.Timeout;
  settling?: "completed" | "failed" | "stopped";
  draining: Promise<void>;
}

const HISTORY_BYTES = 8 * 1_048_576;
const READ_CHUNK_BYTES = 256 * 1_024;
const MAX_PARTIAL_BYTES = 1_048_576;

export class ClaudeWorkflowRegistry implements WorkflowActivitySink, WorkflowActivityProvider {
  private readonly now: () => number;
  private readonly every: (fn: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearEvery: (timer: NodeJS.Timeout) => void;
  private readonly later: (fn: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearLater: (timer: NodeJS.Timeout) => void;
  private readonly readChunkBytes: number;
  private readonly byWorker = new Map<string, Map<string, RunState>>();

  constructor(private readonly deps: RegistryDeps) {
    this.now = deps.now ?? Date.now;
    this.every = deps.setInterval ?? setInterval;
    this.clearEvery = deps.clearInterval ?? clearInterval;
    this.later = deps.setTimeout ?? setTimeout;
    this.clearLater = deps.clearTimeout ?? clearTimeout;
    this.readChunkBytes = deps.readChunkBytes ?? READ_CHUNK_BYTES;
  }

  private worker(workerId: string): Map<string, RunState> {
    const current = this.byWorker.get(workerId) ?? new Map<string, RunState>();
    this.byWorker.set(workerId, current);
    return current;
  }

  private run(owner: WorkflowOwner, taskId: string): RunState {
    const runs = this.worker(owner.workerId);
    const existing = runs.get(taskId);
    if (existing) return existing;
    const now = this.now();
    const created: RunState = {
      owner,
      taskId,
      workflowName: "Workflow",
      summary: "",
      status: "running",
      visibility: "summary-only",
      startedAt: now,
      lastActivityAt: now,
      agents: new Map(),
      pendingAgentIds: new Set(),
      journalOffset: 0,
      journalPartial: "",
      journalDecoder: new StringDecoder("utf8"),
      draining: Promise.resolve(),
    };
    runs.set(taskId, created);
    return created;
  }

  launched(owner: WorkflowOwner, launch: WorkflowLaunch): void {
    const run = this.run(owner, launch.taskId);
    Object.assign(run, {
      owner,
      toolUseId: launch.toolUseId,
      runId: launch.runId,
      workflowName: launch.workflowName,
      summary: launch.summary,
      candidateDir: launch.transcriptDir,
      lastActivityAt: this.now(),
    });
    if (run.status !== "running" || run.settling) {
      this.emit(run);
      return;
    }
    run.draining = run.draining.then(() => this.startObservation(run, launch.transcriptDir)).catch(() => this.degrade(run));
    this.scheduleEmit(run);
  }

  taskUpdated(owner: WorkflowOwner, update: WorkflowTaskUpdate): void {
    const run = this.run(owner, update.taskId);
    run.owner = owner;
    if (update.workflowName) run.workflowName = update.workflowName;
    if (update.summary) run.summary = update.summary;
    else if (!run.summary && update.description) run.summary = update.description;
    if (update.lastToolName) run.lastToolName = update.lastToolName;
    if (update.usage) run.usage = update.usage;
    run.lastActivityAt = this.now();
    if (update.phase === "settled") {
      if (run.settling) return; // richer duplicate metadata above is retained for the pending terminal emit
      if (run.status !== "running") {
        this.emit(run); // a later task_notification may add summary/usage without re-running the transition
        return;
      }
      const outcome = update.outcome ?? "stopped";
      run.settling = outcome;
      run.draining = run.draining.then(async () => {
        try { await this.drain(run, null); }
        catch { run.visibility = "summary-only"; run.warning = "limited-visibility"; }
        this.settle(run, outcome);
      });
      return;
    }
    this.scheduleEmit(run);
  }

  stopWorker(workerId: string): void {
    for (const run of this.byWorker.get(workerId)?.values() ?? []) {
      if (run.status === "running") this.taskUpdated(run.owner, { taskId: run.taskId, phase: "settled", outcome: "stopped" });
      else this.closeObservation(run);
    }
  }

  list(workerId: string): WorkflowRunSnapshot[] {
    return [...(this.byWorker.get(workerId)?.values() ?? [])].map((run) => this.snapshot(run)).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  async agentHistory(workerId: string, taskId: string, agentId: string): Promise<WorkflowAgentHistoryEntry[]> {
    const run = this.byWorker.get(workerId)?.get(taskId);
    if (!run?.transcriptDir || !run.agents.has(agentId)) throw new Error("unknown workflow agent");
    const text = await this.deps.files.readText(path.join(run.transcriptDir, `agent-${agentId}.jsonl`), HISTORY_BYTES);
    return parseWorkflowAgentHistory(text);
  }

  close(): void {
    for (const runs of this.byWorker.values()) for (const run of runs.values()) this.closeObservation(run);
  }

  async flushForTest(): Promise<void> {
    for (;;) {
      const before = [...this.byWorker.values()].flatMap((runs) => [...runs.values()].map((run) => run.draining));
      await Promise.all(before);
      const after = [...this.byWorker.values()].flatMap((runs) => [...runs.values()].map((run) => run.draining));
      if (after.length === before.length && after.every((promise, index) => promise === before[index])) break;
    }
    for (const runs of this.byWorker.values()) {
      for (const run of runs.values()) {
        if (!run.emitTimer) continue;
        this.clearLater(run.emitTimer);
        delete run.emitTimer;
        this.emit(run);
      }
    }
  }

  // Add the private observation/snapshot/emission methods in Step 6.
}
```

- [ ] **Step 6: Implement validation, one-directory watching, incremental draining, and bounded emission**

Add these private methods inside `ClaudeWorkflowRegistry` before its closing brace:

```ts
  private async startObservation(run: RunState, supplied: string): Promise<void> {
    if (run.status !== "running" || !run.owner.sdkSessionId || !run.runId) return this.degrade(run);
    this.closeObservation(run);
    const real = await this.deps.files.realpath(supplied);
    const normalized = path.resolve(supplied);
    const suffix = path.join(run.owner.sdkSessionId, "subagents", "workflows", run.runId);
    if (real !== normalized || !real.endsWith(`${path.sep}${suffix}`)) return this.degrade(run);
    const journal = path.join(real, "journal.jsonl");
    const stat = await this.deps.files.stat(journal);
    if (!stat.isFile) return this.degrade(run);
    run.transcriptDir = real;
    run.visibility = "live";
    delete run.warning;
    this.emit(run); // initial container must precede any agent delta from the first drain
    run.watch = this.deps.files.watchDirectory(real, (name) => this.queueDrain(run, name));
    run.reconcileTimer = this.every(() => this.queueDrain(run, null), 1_000);
    run.reconcileTimer.unref?.();
    await this.drain(run, null);
  }

  private degrade(run: RunState): void {
    this.closeObservation(run);
    run.visibility = "summary-only";
    run.warning = "limited-visibility";
    delete run.transcriptDir;
    if (run.status === "running" && !run.settling && run.candidateDir) {
      run.reconcileTimer = this.every(() => {
        run.draining = run.draining.then(() => {
          if (run.status === "running" && run.visibility === "summary-only" && run.candidateDir) return this.startObservation(run, run.candidateDir);
        }).catch(() => this.degrade(run));
      }, 1_000);
      run.reconcileTimer.unref?.();
    }
    this.scheduleEmit(run);
  }

  private queueDrain(run: RunState, name: string | null): void {
    if (run.status !== "running" || !run.transcriptDir) return;
    run.draining = run.draining.then(() => this.drain(run, name)).catch(() => this.degrade(run));
  }

  private async drain(run: RunState, name: string | null): Promise<void> {
    if (run.status !== "running" || !run.transcriptDir) return;
    if (name === null || name === "journal.jsonl") await this.drainJournal(run);
    if (name?.startsWith("agent-") && name.endsWith(".jsonl")) {
      const agentId = name.slice("agent-".length, -".jsonl".length);
      if (run.agents.has(agentId)) await this.drainAgent(run, agentId);
    }
    if (name?.startsWith("agent-") && name.endsWith(".meta.json")) {
      const agentId = name.slice("agent-".length, -".meta.json".length);
      const agent = run.agents.get(agentId);
      if (agent) {
        await this.readMeta(run, agent);
        this.queueAgent(run, agent);
        this.scheduleEmit(run);
      }
    }
    if (name === null) {
      for (const agentId of run.agents.keys()) await this.drainAgent(run, agentId);
    }
  }

  private async drainJournal(run: RunState): Promise<void> {
    const file = path.join(run.transcriptDir!, "journal.jsonl");
    const stat = await this.deps.files.stat(file);
    if (run.status !== "running") return;
    if (stat.size < run.journalOffset) {
      run.journalOffset = 0;
      run.journalPartial = "";
      run.journalDecoder = new StringDecoder("utf8");
    }
    if (stat.size === run.journalOffset) return;
    const chunk = await this.deps.files.read(file, run.journalOffset, Math.min(this.readChunkBytes, stat.size - run.journalOffset));
    if (run.status !== "running") return;
    run.journalOffset += chunk.length;
    const text = run.journalPartial + run.journalDecoder.write(chunk);
    const lines = text.split(/\r?\n/);
    run.journalPartial = lines.pop() ?? "";
    if (Buffer.byteLength(run.journalPartial, "utf8") > MAX_PARTIAL_BYTES) {
      run.journalPartial = "";
      run.warning = "partial-data";
    }
    for (const line of lines) {
      const record = parseWorkflowJournalLine(line);
      if (!record) {
        if (line.trim()) run.warning = "partial-data";
        continue;
      }
      const now = this.now();
      const existing = run.agents.get(record.agentId);
      if (record.type === "started" && !existing) {
        const agent: AgentState = { agentId: record.agentId, agentType: "workflow-subagent", spawnDepth: 1, status: "running", activity: "starting", toolUses: 0, startedAt: now, lastActivityAt: now, fileOffset: 0, partial: "", decoder: new StringDecoder("utf8") };
        run.agents.set(agent.agentId, agent);
        await this.readMeta(run, agent);
        this.queueAgent(run, agent);
      } else if (record.type === "result") {
        const agent = existing ?? { agentId: record.agentId, agentType: "workflow-subagent", spawnDepth: 1, status: "running" as const, activity: "starting" as const, toolUses: 0, startedAt: now, lastActivityAt: now, fileOffset: 0, partial: "", decoder: new StringDecoder("utf8") };
        run.agents.set(agent.agentId, agent);
        if (agent.status !== "completed") {
          Object.assign(agent, { status: "completed", activity: "complete", endedAt: now, lastActivityAt: now });
          this.queueAgent(run, agent);
        }
      }
      run.lastActivityAt = now;
    }
    this.scheduleEmit(run);
    // The terminal path awaits this method before marking unfinished agents stopped, so finish all
    // journal chunks in this serialized drain instead of enqueueing the remainder behind settlement.
    if (run.journalOffset < stat.size) await this.drainJournal(run);
  }

  private async readMeta(run: RunState, agent: AgentState): Promise<void> {
    try {
      const text = await this.deps.files.readText(path.join(run.transcriptDir!, `agent-${agent.agentId}.meta.json`), 16_384);
      Object.assign(agent, parseWorkflowAgentMeta(text));
    } catch {
      // The meta file may land after the journal record; provider-neutral defaults remain valid.
    }
  }

  private async drainAgent(run: RunState, agentId: string): Promise<void> {
    const agent = run.agents.get(agentId);
    if (!agent) return;
    const file = path.join(run.transcriptDir!, `agent-${agentId}.jsonl`);
    let stat;
    try { stat = await this.deps.files.stat(file); } catch { return; }
    if (stat.size < agent.fileOffset) {
      agent.fileOffset = 0;
      agent.partial = "";
      agent.decoder = new StringDecoder("utf8");
      agent.toolUses = 0;
    }
    if (stat.size === agent.fileOffset) return;
    const chunk = await this.deps.files.read(file, agent.fileOffset, Math.min(this.readChunkBytes, stat.size - agent.fileOffset));
    if (run.status !== "running") return;
    agent.fileOffset += chunk.length;
    const lines = (agent.partial + agent.decoder.write(chunk)).split(/\r?\n/);
    agent.partial = lines.pop() ?? "";
    if (Buffer.byteLength(agent.partial, "utf8") > MAX_PARTIAL_BYTES) {
      agent.partial = "";
      run.warning = "partial-data";
    }
    let changed = false;
    for (const line of lines) {
      const delta = parseWorkflowAgentLine(line);
      if (!delta) continue;
      agent.activity = delta.activity;
      agent.startedAt = Math.min(agent.startedAt, delta.at);
      agent.lastActivityAt = Math.max(agent.lastActivityAt, delta.at);
      agent.toolUses += delta.toolUses;
      if (delta.agentType) agent.agentType = delta.agentType;
      if (delta.lastToolName) agent.lastToolName = delta.lastToolName;
      run.lastActivityAt = Math.max(run.lastActivityAt, delta.at);
      changed = true;
    }
    if (changed) {
      this.queueAgent(run, agent);
      this.scheduleEmit(run);
    }
    if (agent.fileOffset < stat.size) this.queueDrain(run, `agent-${agentId}.jsonl`);
  }

  private counts(run: RunState): WorkflowRunSnapshot["counts"] {
    const agents = [...run.agents.values()];
    return {
      started: agents.length,
      active: agents.filter((agent) => agent.status === "running").length,
      completed: agents.filter((agent) => agent.status === "completed").length,
      stopped: agents.filter((agent) => agent.status === "stopped").length,
    };
  }

  private settle(run: RunState, outcome: "completed" | "failed" | "stopped"): void {
    if (run.status !== "running") return;
    run.status = outcome;
    run.endedAt = this.now();
    delete run.settling;
    for (const agent of run.agents.values()) {
      if (agent.status !== "running") continue;
      Object.assign(agent, { status: "stopped", activity: "stopped", endedAt: run.endedAt, lastActivityAt: run.endedAt });
      this.queueAgent(run, agent);
    }
    run.lastActivityAt = Math.max(run.lastActivityAt, run.endedAt);
    this.closeObservation(run);
    this.emit(run);
  }

  private summary(run: RunState) {
    return {
      taskId: run.taskId,
      ...(run.toolUseId ? { toolUseId: run.toolUseId } : {}),
      ...(run.runId ? { runId: run.runId } : {}),
      workflowName: run.workflowName,
      summary: run.summary,
      ...(run.lastToolName ? { lastToolName: run.lastToolName } : {}),
      status: run.status,
      visibility: run.visibility,
      ...(run.warning ? { warning: run.warning } : {}),
      startedAt: run.startedAt,
      lastActivityAt: run.lastActivityAt,
      ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
      ...(run.usage ? { usage: run.usage } : {}),
      counts: this.counts(run),
    };
  }

  private snapshot(run: RunState): WorkflowRunSnapshot {
    return { ...this.summary(run), agents: [...run.agents.values()].map(({ fileOffset: _offset, partial: _partial, decoder: _decoder, ...agent }) => ({ ...agent })) };
  }

  private emit(run: RunState): void {
    if (run.emitTimer) {
      this.clearLater(run.emitTimer);
      delete run.emitTimer;
    }
    this.deps.bus.emit({ type: "worker.workflow.run", sessionId: run.owner.sessionId, workerId: run.owner.workerId, run: this.summary(run) });
    for (const agentId of run.pendingAgentIds) {
      const agent = run.agents.get(agentId);
      if (!agent) continue;
      const { fileOffset: _offset, partial: _partial, decoder: _decoder, ...view } = agent;
      this.deps.bus.emit({ type: "worker.workflow.agent", sessionId: run.owner.sessionId, workerId: run.owner.workerId, taskId: run.taskId, agent: { ...view } });
    }
    run.pendingAgentIds.clear();
  }

  private scheduleEmit(run: RunState): void {
    if (run.emitTimer) return;
    run.emitTimer = this.later(() => { delete run.emitTimer; this.emit(run); }, 250);
    run.emitTimer.unref?.();
  }

  private queueAgent(run: RunState, agent: AgentState): void {
    run.pendingAgentIds.add(agent.agentId);
    this.scheduleEmit(run);
  }

  private closeObservation(run: RunState): void {
    run.watch?.close();
    delete run.watch;
    if (run.reconcileTimer) this.clearEvery(run.reconcileTimer);
    delete run.reconcileTimer;
    if (run.emitTimer) this.clearLater(run.emitTimer);
    delete run.emitTimer;
  }
```

Call `await registry.flushForTest()` in registry tests that assert throttled run emissions. The helper drains queued reads and explicitly flushes pending emit timers, so unit tests never wait for the real 250 ms delay.

- [ ] **Step 7: Run registry, decoder, and event type tests**

```bash
npx vitest run test/daemon/claude-workflow-registry.test.ts test/core/claude-workflow-transcript.test.ts
npm run typecheck
```

Expected: PASS. If the fake path separator differs on Windows CI, build `dir` with `path.join()` in the test instead of loosening production validation.

- [ ] **Step 8: Commit Task 4**

```bash
git add src/core/workflow-activity.ts src/core/events.ts src/daemon/claude-workflow-registry.ts test/daemon/claude-workflow-registry.test.ts
git commit -m "feat: track dynamic workflow runs" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Connect workers to the daemon-owned activity registry

**Files:**
- Modify: `src/core/worker.ts`
- Modify: `src/daemon/server.ts`
- Test: `test/core/worker.test.ts`
- Test: `test/daemon/server.test.ts`

**Interfaces:**
- `Worker` consumes the optional `WorkflowActivitySink` from Task 1.
- `startDaemon()` owns exactly one `ClaudeWorkflowRegistry`, injects it only into Claude workers, later exposes it to `Connection`, and closes it during daemon shutdown.
- Workflow events never enter `worker_events`; the existing background-task events remain the only worker-state inputs.

- [ ] **Step 1: Write failing Worker sink tests**

Extend the existing `agent-backend` type import with `AgentEvent` and `AgentStream`, then add a recording sink in `test/core/worker.test.ts`:

```ts
import type {
  WorkflowActivitySink,
  WorkflowLaunch,
  WorkflowOwner,
  WorkflowTaskUpdate,
} from "../../src/core/workflow-activity.js";

class RecordingWorkflowSink implements WorkflowActivitySink {
  launchedCalls: Array<{ owner: WorkflowOwner; launch: WorkflowLaunch }> = [];
  updatedCalls: Array<{ owner: WorkflowOwner; update: WorkflowTaskUpdate }> = [];
  stopped: string[] = [];
  launched(owner: WorkflowOwner, launch: WorkflowLaunch): void { this.launchedCalls.push({ owner, launch }); }
  taskUpdated(owner: WorkflowOwner, update: WorkflowTaskUpdate): void { this.updatedCalls.push({ owner, update }); }
  stopWorker(workerId: string): void { this.stopped.push(workerId); }
}

class WorkflowTestStream implements AgentStream {
  constructor(private readonly events: AgentEvent[]) {}
  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> { for (const event of this.events) yield event; }
  async interrupt(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async supportedCommands(): Promise<[]> { return []; }
}

function workflowWorker(events: AgentEvent[], sink: WorkflowActivitySink): { worker: Worker; repos: Repositories } {
  const repos = new Repositories(openDb(":memory:"));
  repos.createSession({ id: "s1", cwd: "/x" });
  repos.createWorker({ id: "w1", sessionId: "s1", repoPath: "/repo", label: "workflow" });
  const backend: AgentBackend = {
    openSession: () => new WorkflowTestStream(events),
    startTurn: () => new WorkflowTestStream(events),
  };
  return {
    repos,
    worker: new Worker({ id: "w1", sessionId: "s1", repoPath: "/repo", label: "workflow", deps: { repos, bus: new EventBus(), backend, model: "m", workflowActivity: sink } }),
  };
}
```

Add these direct lifecycle cases:

```ts
it("forwards workflow activity without persisting it as worker transcript events", async () => {
  const sink = new RecordingWorkflowSink();
  const { worker, repos } = workflowWorker([
      { kind: "session_id", sessionId: "sdk-1" },
      { kind: "workflow_task", update: { taskId: "task-1", phase: "started", workflowName: "audit" } },
      { kind: "workflow_launched", launch: { taskId: "task-1", toolUseId: "tool-1", runId: "wf-1", workflowName: "audit", summary: "Audit", transcriptDir: "/claude/sdk-1/subagents/workflows/wf-1" } },
      { kind: "workflow_task", update: { taskId: "task-1", phase: "progress", lastToolName: "Read" } },
      { kind: "turn_end", subtype: "success", costUsd: 0, numTurns: 1, durationMs: 1, contextTokens: 1, contextWindow: 1 },
  ], sink);
  worker.start("go");
  await worker.waitUntilSettled();
  expect(sink.launchedCalls[0]?.owner).toMatchObject({ sessionId: "s1", workerId: "w1", sdkSessionId: "sdk-1" });
  expect(sink.updatedCalls.map((call) => call.update.phase)).toEqual(["started", "progress"]);
  expect(repos.listWorkerEvents("w1").some((event) => event.type.startsWith("workflow"))).toBe(false);
});

it("keeps workflow activity on interrupt and stops it once on terminal transition", async () => {
  const sink = new RecordingWorkflowSink();
  const repos = new Repositories(openDb(":memory:"));
  repos.createSession({ id: "s1", cwd: "/x" });
  repos.createWorker({ id: "w1", sessionId: "s1", repoPath: "/repo", label: "workflow" });
  const worker = new Worker({ id: "w1", sessionId: "s1", repoPath: "/repo", label: "workflow", deps: { repos, bus: new EventBus(), backend: fakeStreamingBackend(() => [{ type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" }]), model: "m", workflowActivity: sink } });
  worker.start("go");
  await until(() => worker.status() === "idle");
  await worker.interruptTurn();
  expect(sink.stopped).toEqual([]);
  await worker.stop();
  await worker.stop();
  expect(sink.stopped).toEqual(["w1"]);
});
```

- [ ] **Step 2: Run the focused Worker tests and confirm failure**

```bash
npx vitest run test/core/worker.test.ts -t "workflow activity"
```

Expected: FAIL because `WorkerDeps.workflowActivity` and the two event branches do not exist.

- [ ] **Step 3: Add the sink to WorkerDeps and forward provider events**

In `src/core/worker.ts`:

```ts
import type { WorkflowActivitySink, WorkflowOwner } from "./workflow-activity.js";

export interface WorkerDeps {
  // existing fields
  workflowActivity?: WorkflowActivitySink;
}

private workflowOwner(): WorkflowOwner {
  return {
    sessionId: this.opts.sessionId,
    workerId: this.opts.id,
    sdkSessionId: this.sdkSessionId,
  };
}
```

Insert these branches immediately before `background_task` handling in `consume()`:

```ts
        } else if (ev.kind === "workflow_launched") {
          this.opts.deps.workflowActivity?.launched(this.workflowOwner(), ev.launch);
        } else if (ev.kind === "workflow_task") {
          this.opts.deps.workflowActivity?.taskUpdated(this.workflowOwner(), ev.update);
```

Inside the existing guarded terminal block in `transition()`—the block with `!this.lifetimeSettled`—add the stop call before resolving the lifetime:

```ts
      this.opts.deps.workflowActivity?.stopWorker(this.opts.id);
```

Do not add any call to `record()`, `interruptTurn()`, or `reconcile()` for these events.

- [ ] **Step 4: Wire and close one registry in the composition root**

In `src/daemon/server.ts`, import the registry/files, instantiate them immediately before `subFactory`, and inject only for Claude workers:

```ts
import { realClaudeWorkflowFiles } from "./claude-workflow-files.js";
import { ClaudeWorkflowRegistry } from "./claude-workflow-registry.js";

const workflows = new ClaudeWorkflowRegistry({ files: realClaudeWorkflowFiles, bus });

// inside Worker deps
workflowActivity: (o.provider ?? "claude") === "claude" ? workflows : undefined,
```

After `await fleet.close(5000)` in the shutdown function, call:

```ts
workflows.close();
```

Task 6 passes the same `workflows` object to `Connection`; do not create a registry per connection or worker.

- [ ] **Step 5: Verify Worker behavior and daemon composition**

```bash
npx vitest run test/core/worker.test.ts test/daemon/server.test.ts
npm run typecheck
```

Expected: PASS, including the existing settle-grace/background-state suite.

- [ ] **Step 6: Commit Task 5**

```bash
git add src/core/worker.ts src/daemon/server.ts test/core/worker.test.ts test/daemon/server.test.ts
git commit -m "feat: connect workers to workflow activity" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Add snapshot and selected-agent history to the WebSocket protocol

**Files:**
- Modify: `src/protocol/messages.ts`
- Modify: `src/daemon/connection.ts`
- Modify: `src/daemon/server.ts`
- Test: `test/protocol/messages.test.ts`
- Test: `test/daemon/connection.test.ts`

**Interfaces:**
- Requests are id-only: `workflow.list(workerId)` and `workflow.agent.history(workerId, taskId, agentId)`.
- The connection consumes `WorkflowActivityProvider`; no path supplied by a client reaches the filesystem boundary.
- `RequestResultMap` remains the single request/response typing source for the desktop `WsClient`.

- [ ] **Step 1: Write failing protocol parse/type tests**

Add to `test/protocol/messages.test.ts`:

```ts
it("parses workflow snapshot and agent-history requests without accepting paths", () => {
  expect(parseClientMessage(JSON.stringify({ type: "workflow.list", reqId: "r1", workerId: "w1" }))).toEqual({ type: "workflow.list", reqId: "r1", workerId: "w1" });
  expect(parseClientMessage(JSON.stringify({ type: "workflow.agent.history", reqId: "r2", workerId: "w1", taskId: "task-1", agentId: "a1" }))).toEqual({ type: "workflow.agent.history", reqId: "r2", workerId: "w1", taskId: "task-1", agentId: "a1" });
  expect(parseClientMessage(JSON.stringify({ type: "workflow.agent.history", reqId: "r3", workerId: "w1", taskId: "task-1", agentId: "a1", transcriptDir: "/tmp/private" }))).toEqual({ type: "workflow.agent.history", reqId: "r3", workerId: "w1", taskId: "task-1", agentId: "a1" });
});
```

Add compile-time `satisfies` fixtures beside the existing `RequestResultMap` tests for both result types.

- [ ] **Step 2: Add failing Connection request tests**

In `test/daemon/connection.test.ts`, create a fake provider:

```ts
const workflows: WorkflowActivityProvider = {
  list: vi.fn(() => [{
    taskId: "task-1", toolUseId: "tool-1", runId: "wf-1", workflowName: "audit", summary: "Audit",
    status: "running", visibility: "live", startedAt: 1, lastActivityAt: 2,
    counts: { started: 1, active: 1, completed: 0, stopped: 0 }, agents: [],
  }]),
  agentHistory: vi.fn(async () => [{ data: { kind: "message", role: "assistant", content: "done" }, createdAt: "2026-07-16T00:00:00.000Z" }]),
};
```

Pass it as the new final constructor argument and assert exact replies for both messages. Also assert that `agentHistory` receives `("w1", "task-1", "a1")` and that a rejection is returned through the existing correlated `{type:"error",reqId}` path without closing the socket.

- [ ] **Step 3: Run the protocol/connection tests and confirm failure**

```bash
npx vitest run test/protocol/messages.test.ts test/daemon/connection.test.ts -t "workflow"
```

Expected: FAIL because the messages and provider dependency are unknown.

- [ ] **Step 4: Extend protocol types**

In `src/protocol/messages.ts`, import the view types:

```ts
import type { WorkflowAgentHistoryEntry, WorkflowRunSnapshot } from "../core/workflow-activity.js";
```

Add these objects to `clientMessageSchema` next to `worker.history`:

```ts
  z.object({ type: z.literal("workflow.list"), reqId: z.string(), workerId: z.string() }),
  z.object({ type: z.literal("workflow.agent.history"), reqId: z.string(), workerId: z.string(), taskId: z.string(), agentId: z.string() }),
```

Add to `ServerMessage`:

```ts
  | { type: "workflow.list.result"; reqId: string; workerId: string; runs: WorkflowRunSnapshot[] }
  | { type: "workflow.agent.history.result"; reqId: string; workerId: string; taskId: string; agentId: string; events: WorkflowAgentHistoryEntry[] }
```

Add to `RequestResultMap`:

```ts
  "workflow.list": Extract<ServerMessage, { type: "workflow.list.result" }>;
  "workflow.agent.history": Extract<ServerMessage, { type: "workflow.agent.history.result" }>;
```

- [ ] **Step 5: Handle requests through the provider**

In `src/daemon/connection.ts`:

```ts
import type { WorkflowActivityProvider } from "../core/workflow-activity.js";

// final constructor parameter, preserving every existing positional call
private readonly workflows?: WorkflowActivityProvider,
```

Add switch cases immediately after `worker.history`:

```ts
      case "workflow.list": {
        this.reply({ type: "workflow.list.result", reqId: msg.reqId, workerId: msg.workerId, runs: this.workflows?.list(msg.workerId) ?? [] });
        break;
      }
      case "workflow.agent.history": {
        if (!this.workflows) throw new Error("workflow activity is unavailable");
        const events = await this.workflows.agentHistory(msg.workerId, msg.taskId, msg.agentId);
        this.reply({ type: "workflow.agent.history.result", reqId: msg.reqId, workerId: msg.workerId, taskId: msg.taskId, agentId: msg.agentId, events });
        break;
      }
```

Use the connection's existing async message error boundary; do not introduce a second serializer/error format.

Append `workflows` to the `new Connection(...)` call in `src/daemon/server.ts`.

- [ ] **Step 6: Verify wire behavior and root typing**

```bash
npx vitest run test/protocol/messages.test.ts test/daemon/connection.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit Task 6**

```bash
git add src/protocol/messages.ts src/daemon/connection.ts src/daemon/server.ts test/protocol/messages.test.ts test/daemon/connection.test.ts
git commit -m "feat: expose workflow activity snapshots" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Add renderer workflow state and race-safe snapshot merging

**Files:**
- Modify: `apps/desktop/src/renderer/store/reduce.ts`
- Modify: `apps/desktop/src/renderer/store/store.ts`
- Modify: `src/daemon/claude-workflow-registry.ts`
- Test: `apps/desktop/test/store-reduce.test.ts`
- Test: `test/daemon/claude-workflow-registry.test.ts`

**Interfaces:**
- Store shape: `workflows[workerId][taskId]` plus bounded selected-agent log/loading maps keyed by `workerId/taskId/agentId`.
- A snapshot is authoritative for its worker unless a live record has a greater `lastActivityAt`.
- Agent deltas never fabricate a run; the daemon emits an initial run before its first agent delta.

- [ ] **Step 1: Write failing reducer tests for event order and reconnect races**

Add fixtures and cases to `apps/desktop/test/store-reduce.test.ts`:

```ts
const runningRun: WorkflowRunSnapshot = {
  taskId: "task-1", toolUseId: "tool-1", runId: "wf-1", workflowName: "audit", summary: "Audit",
  status: "running", visibility: "live", startedAt: 100, lastActivityAt: 200,
  counts: { started: 1, active: 1, completed: 0, stopped: 0 }, agents: [],
};

it("upserts workflow run and agent deltas by taskId", () => {
  const withRun = reduceEvent(emptyState(), { type: "worker.workflow.run", sessionId: "s1", workerId: "w1", run: runningRun }, 200);
  const next = reduceEvent(withRun, { type: "worker.workflow.agent", sessionId: "s1", workerId: "w1", taskId: "task-1", agent: { agentId: "a1", agentType: "workflow-subagent", spawnDepth: 1, status: "running", activity: "tool", lastToolName: "Read", toolUses: 1, startedAt: 100, lastActivityAt: 210 } }, 210);
  expect(next.workflows.w1?.["task-1"]?.agents[0]).toMatchObject({ agentId: "a1", lastToolName: "Read" });
});

it("keeps a newer live delta when an older reconnect snapshot arrives", () => {
  const live = { ...runningRun, summary: "new", lastActivityAt: 300 };
  const state = reduceEvent(emptyState(), { type: "worker.workflow.run", sessionId: "s1", workerId: "w1", run: live }, 300);
  const seeded = seedWorkflowRuns(state, "w1", [{ ...runningRun, summary: "old", lastActivityAt: 200 }]);
  expect(seeded.workflows.w1?.["task-1"]?.summary).toBe("new");
});

it("stores and clears worker background metadata", () => {
  const spawned = reduceEvent(emptyState(), workerSpawned("w1"), 1);
  const background = reduceEvent(spawned, { type: "worker.status", sessionId: "s1", workerId: "w1", status: "background", bg: { count: 2, types: ["local_workflow"] } }, 2);
  expect(background.fleet.w1?.bg).toEqual({ count: 2, types: ["local_workflow"] });
  const idle = reduceEvent(background, { type: "worker.status", sessionId: "s1", workerId: "w1", status: "idle" }, 3);
  expect(idle.fleet.w1?.bg).toBeUndefined();
});
```

Also cover: equal timestamps prefer the snapshot, an agent delta for an unknown run is ignored, an empty authoritative snapshot clears stale runs/history after daemon restart, `worker.deletion completed` clears workflow/history state, `seedWorkflowAgentHistory` transforms entries through `applySubEvent` into one bounded read-only `LogItem[]`, and beginning history for a second agent evicts the first agent's cached log for that worker.

- [ ] **Step 2: Run reducer tests and confirm failure**

```bash
npm -w apps/desktop test -- --run test/store-reduce.test.ts
```

Expected: FAIL because workflow state and seed helpers do not exist.

- [ ] **Step 3: Add state types and pure merge helpers**

In `apps/desktop/src/renderer/store/reduce.ts`:

```ts
import type { WorkflowAgentHistoryEntry, WorkflowRunSnapshot, WorkflowRunSummary } from "@daemon/core/workflow-activity.js";

export interface FleetRow extends WorkerRow {
  archived?: boolean;
  permissionMode: string;
  bg?: { count: number; types: string[] };
}

export interface AppState {
  // existing fields
  workflows: Record<string, Record<string, WorkflowRunSnapshot>>;
  workflowAgentLogs: Record<string, LogItem[]>;
  workflowAgentHistoryLoading: Record<string, boolean>;
  workflowAgentHistoryFailed: Record<string, boolean>;
}

export function workflowAgentKey(workerId: string, taskId: string, agentId: string): string {
  return `${workerId}/${taskId}/${agentId}`;
}
```

Initialize all four maps in `emptyState()`. Add pure helpers:

```ts
function snapshotFromSummary(run: WorkflowRunSummary, previous?: WorkflowRunSnapshot): WorkflowRunSnapshot {
  return { ...run, agents: previous?.agents ?? [] };
}

export function seedWorkflowRuns(state: AppState, workerId: string, runs: WorkflowRunSnapshot[]): AppState {
  const live = state.workflows[workerId] ?? {};
  const next = Object.fromEntries(runs.map((snapshot) => {
    const current = live[snapshot.taskId];
    return [snapshot.taskId, current && current.lastActivityAt > snapshot.lastActivityAt ? current : snapshot];
  }));
  const workerPrefix = `${workerId}/`;
  const taskPrefixes = new Set(Object.keys(next).map((taskId) => `${workerPrefix}${taskId}/`));
  const retainKnownTasks = <T,>(map: Record<string, T>): Record<string, T> => Object.fromEntries(
    Object.entries(map).filter(([key]) => !key.startsWith(workerPrefix) || [...taskPrefixes].some((prefix) => key.startsWith(prefix))),
  );
  return {
    ...state,
    workflows: { ...state.workflows, [workerId]: next },
    workflowAgentLogs: retainKnownTasks(state.workflowAgentLogs),
    workflowAgentHistoryLoading: retainKnownTasks(state.workflowAgentHistoryLoading),
    workflowAgentHistoryFailed: retainKnownTasks(state.workflowAgentHistoryFailed),
  };
}

export function workflowHistoryLog(events: WorkflowAgentHistoryEntry[]): LogItem[] {
  return events.reduce<LogItem[]>((log, event) => applySubEvent(log, event.data, event.createdAt ? Date.parse(event.createdAt) : undefined), []);
}
```

In `reduceEvent()`:

```ts
    case "worker.workflow.run": {
      const runs = state.workflows[e.workerId] ?? {};
      const previous = runs[e.run.taskId];
      if (previous && previous.lastActivityAt > e.run.lastActivityAt) return state;
      const run = snapshotFromSummary(e.run, previous);
      return { ...state, workflows: { ...state.workflows, [e.workerId]: { ...runs, [run.taskId]: run } } };
    }
    case "worker.workflow.agent": {
      const runs = state.workflows[e.workerId] ?? {};
      const run = runs[e.taskId];
      if (!run) return state;
      const agents = run.agents.some((agent) => agent.agentId === e.agent.agentId)
        ? run.agents.map((agent) => agent.agentId === e.agent.agentId && agent.lastActivityAt <= e.agent.lastActivityAt ? e.agent : agent)
        : [...run.agents, e.agent];
      return { ...state, workflows: { ...state.workflows, [e.workerId]: { ...runs, [e.taskId]: { ...run, agents } } } };
    }
```

In `worker.status`, assign `bg: e.bg` and delete it when absent. In the existing completed worker-deletion path, remove that worker's `workflows` and every history key starting with `${workerId}/`.

- [ ] **Step 4: Add Zustand actions for snapshots and selected history**

Extend `Store` and its initializer in `store/store.ts`:

```ts
seedWorkflowRuns: (workerId: string, runs: WorkflowRunSnapshot[]) => void;
beginWorkflowAgentHistory: (key: string) => void;
seedWorkflowAgentHistory: (key: string, events: WorkflowAgentHistoryEntry[]) => void;
failWorkflowAgentHistory: (key: string) => void;
```

Implement all four with immutable maps. `seedWorkflowRuns` calls the pure helper; `seedWorkflowAgentHistory` calls `workflowHistoryLog`, sets loading false, and clears failed. `beginWorkflowAgentHistory` derives the `${workerId}/` prefix from the stable key and evicts every prior log/loading/failed entry with that prefix before marking the new key loading. The fail action leaves no stale transcript visible and sets mutually consistent loading/failed flags.

- [ ] **Step 5: Guarantee initial run-before-agent ordering in the registry**

In `ClaudeWorkflowRegistry.startObservation()`, after setting `visibility:"live"` and before installing/draining the transcript watcher, call:

```ts
this.emit(run);
```

This clears the launch's pending throttled timer and guarantees the renderer has a run container before `drainJournal()` emits any agent delta. Add a registry test that records event types and expects `worker.workflow.run` before `worker.workflow.agent`.

- [ ] **Step 6: Verify renderer state and registry ordering**

```bash
npm -w apps/desktop test -- --run test/store-reduce.test.ts
npx vitest run test/daemon/claude-workflow-registry.test.ts
npm -w apps/desktop run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit Task 7**

```bash
git add apps/desktop/src/renderer/store/reduce.ts apps/desktop/src/renderer/store/store.ts apps/desktop/test/store-reduce.test.ts src/daemon/claude-workflow-registry.ts test/daemon/claude-workflow-registry.test.ts
git commit -m "feat: store live workflow activity" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Build the Activity panel with lazy, virtualized agent inspection

**Files:**
- Create: `apps/desktop/src/renderer/views/ActivityPanel.tsx`
- Create: `apps/desktop/src/renderer/views/WorkflowRuns.tsx`
- Create: `apps/desktop/src/renderer/i18n/locales/en/workflowActivity.ts`
- Create: `apps/desktop/src/renderer/i18n/locales/ko/workflowActivity.ts`
- Modify: `apps/desktop/src/renderer/components/RightSidebar.tsx`
- Modify: `apps/desktop/src/renderer/workspace/panels.tsx`
- Modify: `apps/desktop/src/renderer/workspace/WorkspaceRender.tsx`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/i18n/locales/en/rightSidebar.ts`
- Modify: `apps/desktop/src/renderer/i18n/locales/ko/rightSidebar.ts`
- Test: `apps/desktop/test/workflow-activity.test.tsx`

**Interfaces:**
- `ActivityPanel` composes workflow runs and the existing `NestedAgents`; neither transport is forced into the other's data model.
- `WorkflowRuns` receives only a worker id and an id-based load callback; it self-subscribes to high-frequency workflow store slices.
- The persisted dock kind/delegate remains `nested`; only the user-facing title/body changes to Activity.

- [ ] **Step 1: Write failing Activity component tests**

Create `apps/desktop/test/workflow-activity.test.tsx` with store reset helpers and these cases:

1. A running run renders its workflow name and exact `Active 6 · Completed 6 · Started 12` values, with no `%` text.
2. Active agents are sorted before completed agents; completed agents start collapsed.
3. Clicking agent `a1` invokes `loadAgentHistory("w1","task-1","a1")` once and renders only `a1`'s `MessageList` after the store is seeded.
4. A `summary-only` run renders the localized limited-visibility notice and task-level summary instead of the no-activity empty state.
5. Workflow and nested sections render together; zero of both renders the Activity empty state.
6. With 500 agent fixtures, the DOM contains fewer than 80 agent-row buttons, proving `useVirtualizer` is active.

Use `I18nProvider` with Korean and English once each for catalog coverage; use fake timers only for relative-time rendering.

- [ ] **Step 2: Run the component test and confirm failure**

```bash
npm -w apps/desktop test -- --run test/workflow-activity.test.tsx
```

Expected: FAIL because the components and strings do not exist.

- [ ] **Step 3: Add the translated Activity vocabulary**

Change `rightSidebar.segmentWorker` to `Activity` / `활동` and `rightSidebar.noNestedAgents` to the combined empty-state wording. Add these exact catalog keys in both new `workflowActivity.ts` files:

```ts
"workflowActivity.workflows"
"workflowActivity.nestedAgents"
"workflowActivity.running"
"workflowActivity.completed"
"workflowActivity.failed"
"workflowActivity.stopped"
"workflowActivity.activeCount"
"workflowActivity.completedCount"
"workflowActivity.startedCount"
"workflowActivity.stoppedCount"
"workflowActivity.activeAgents"
"workflowActivity.completedAgents"
"workflowActivity.stoppedAgents"
"workflowActivity.selectedAgent"
"workflowActivity.latest"
"workflowActivity.limitedVisibility"
"workflowActivity.partialData"
"workflowActivity.historyLoading"
"workflowActivity.historyFailed"
"workflowActivity.empty"
"workflowActivity.taskFallbackName"
```

The glob-based catalog loader registers the files automatically. Use `t("workflowActivity.limitedVisibility")` for warning code `limited-visibility` and `partialData` for `partial-data`; never render the raw code.

- [ ] **Step 4: Implement WorkflowRuns**

`WorkflowRuns.tsx` exports:

```ts
export interface WorkflowRunsProps {
  workerId: string;
  loadAgentHistory(workerId: string, taskId: string, agentId: string): void;
}

export function WorkflowRuns(props: WorkflowRunsProps): JSX.Element | null;
```

Implementation rules:

- Select `workflows[workerId]`, the history maps, and the selected key's logs directly from Zustand; do not pass the entire App state.
- Sort runs by status rank (`running`, `failed`, `stopped`, `completed`) then `lastActivityAt` descending.
- Within a run, sort running agents by `lastActivityAt` descending and completed/stopped agents by `endedAt ?? lastActivityAt` descending. Render stopped agents in a separate collapsed group rather than under Completed.
- Render the exact four factual statuses and counts; never derive a percentage or denominator.
- Use one scroll parent and `useVirtualizer({ count, getScrollElement, estimateSize: () => 34, overscan: 8 })` for the expanded roster. Keep stable keys `taskId/agentId`.
- Keep completed agents collapsed initially with a local `Set<taskId>`; running agents are expanded.
- Selecting an agent creates `workflowAgentKey(...)`, invokes the callback only if not loaded/loading, and renders exactly that key's `MessageList` in a bounded read-only container.
- Render relative time from `lastActivityAt`, task-level `summary`/`lastToolName` fallback, and localized warning codes. Do not render `runId`, absolute paths, tool input, or agent transcript snippets in overview rows.

- [ ] **Step 5: Compose Activity with existing nested agents**

`ActivityPanel.tsx` exports:

```ts
export function ActivityPanel({
  workerId,
  nestedPanels,
  loadAgentHistory,
}: {
  workerId: string;
  nestedPanels: NestedPanel[];
  loadAgentHistory(workerId: string, taskId: string, agentId: string): void;
}): JSX.Element;
```

It renders `WorkflowRuns` first, then the existing `NestedAgents` only when non-empty, each under a localized section label. It owns the combined empty state but no network or transcript parsing.

Replace `NestedPanelBody` in `workspace/panels.tsx` with `ActivityPanelBody`. Preserve an alias export temporarily if tests or callers still import the old name, then remove the alias after all call sites are migrated. Change the `WorkspaceRender.nested` comment/implementation only; keep the property name and dock component id `nested` for saved-layout compatibility.

In `RightSidebar.tsx`, accept `loadAgentHistory`, select the same nested panels, and render `ActivityPanel` for the internal `worker` segment. Do not auto-switch `segment` when workflows arrive.

- [ ] **Step 6: Load snapshots on every worker-history path and history only on selection**

In `App.tsx`, add:

```ts
const loadWorkflowList = useCallback((workerId: string): void => {
  void client?.request({ type: "workflow.list", workerId })
    .then((result) => useStore.getState().seedWorkflowRuns(workerId, result.runs))
    .catch(() => {}); // live activity still continues; this is reconnect hydration only
}, []);

const loadWorkflowAgentHistory = useCallback((workerId: string, taskId: string, agentId: string): void => {
  const key = workflowAgentKey(workerId, taskId, agentId);
  const store = useStore.getState();
  if (store.workflowAgentLogs[key] || store.workflowAgentHistoryLoading[key]) return;
  store.beginWorkflowAgentHistory(key);
  if (!client) {
    store.failWorkflowAgentHistory(key);
    return;
  }
  void client.request({ type: "workflow.agent.history", workerId, taskId, agentId })
    .then((result) => useStore.getState().seedWorkflowAgentHistory(key, result.events))
    .catch(() => useStore.getState().failWorkflowAgentHistory(key));
}, []);
```

Create one `loadWorkerHistory(workerId)` callback that starts both `worker.history` and `workflow.list`, then replace all five direct worker-history call sites currently in `App.tsx` (initial active worker, reconnect, selection, retry, and restore/fork refresh) with it. This is the reconnect contract; do not rely on the Activity panel being mounted.

Pass `loadWorkflowAgentHistory` to both legacy `RightSidebar` and the dockable `ActivityPanelBody` delegate.

- [ ] **Step 7: Verify Activity behavior and desktop typing**

```bash
npm -w apps/desktop test -- --run test/workflow-activity.test.tsx test/store-reduce.test.ts
npm -w apps/desktop run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit Task 8**

```bash
git add apps/desktop/src/renderer/views/ActivityPanel.tsx apps/desktop/src/renderer/views/WorkflowRuns.tsx apps/desktop/src/renderer/components/RightSidebar.tsx apps/desktop/src/renderer/workspace/panels.tsx apps/desktop/src/renderer/workspace/WorkspaceRender.tsx apps/desktop/src/renderer/App.tsx apps/desktop/src/renderer/i18n/locales/en/workflowActivity.ts apps/desktop/src/renderer/i18n/locales/ko/workflowActivity.ts apps/desktop/src/renderer/i18n/locales/en/rightSidebar.ts apps/desktop/src/renderer/i18n/locales/ko/rightSidebar.ts apps/desktop/test/workflow-activity.test.tsx
git commit -m "feat: add dynamic workflow activity panel" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Keep inline Workflow cards and the worker header truthful

**Files:**
- Modify: `apps/desktop/src/renderer/store/reduce.ts`
- Modify: `apps/desktop/src/renderer/store/store.ts`
- Modify: `apps/desktop/src/renderer/components/ToolBlock.tsx`
- Modify: `apps/desktop/src/renderer/components/ToolGroup.tsx`
- Modify: `apps/desktop/src/renderer/components/WorkspaceHeaders.tsx`
- Modify: `apps/desktop/src/renderer/i18n/locales/en/toolBlock.ts`
- Modify: `apps/desktop/src/renderer/i18n/locales/ko/toolBlock.ts`
- Modify: `apps/desktop/src/renderer/i18n/locales/en/workspaceHeaders.ts`
- Modify: `apps/desktop/src/renderer/i18n/locales/ko/workspaceHeaders.ts`
- Test: `apps/desktop/test/store-reduce.test.ts`
- Test: `apps/desktop/test/tool-block.test.tsx`
- Test: `apps/desktop/test/workspace-headers.test.tsx`

**Interfaces:**
- Tool UI status gains `background`; persisted `tool_result` still means launch acknowledgement, while workflow state determines the real asynchronous completion.
- A tool item may carry a path-free `WorkflowRunSummary` for display.
- Header reason uses the workflow registry for workflow count and stored `worker.status.bg` only for the general background count.

- [ ] **Step 1: Write failing race-convergence and display tests**

In `store-reduce.test.ts`, cover both orders:

```ts
it.each(["tool-first", "workflow-first"] as const)("converges the Workflow card when %s", (order) => {
  // Apply tool_use + tool_result and worker.workflow.run in the selected order.
  // If workflow-first, apply tool_use/tool_result after the run is already in state.
  expect(final.workerLogs.w1?.find((item) => item.kind === "tool" && item.toolId === "tool-1")).toMatchObject({
    status: "background",
    workflow: expect.objectContaining({ taskId: "task-1", counts: { started: 12, active: 6, completed: 6, stopped: 0 } }),
  });
});
```

Then apply a failed terminal run and expect `{status:"complete",ok:false,workflow.status:"failed"}`. Add an authoritative reconnect-snapshot case proving `seedWorkflowRuns()` also decorates a persisted Workflow tool card.

In `tool-block.test.tsx`, assert background label/counts, failed outcome, and raw input/result disclosure. In `workspace-headers.test.tsx`, assert a running workflow count chip and a general `2 background tasks` chip; assert neither appears when settled/idle.

- [ ] **Step 2: Run focused desktop tests and confirm failure**

```bash
npm -w apps/desktop test -- --run test/store-reduce.test.ts test/tool-block.test.tsx test/workspace-headers.test.tsx
```

Expected: FAIL because `background` and workflow display metadata are not accepted.

- [ ] **Step 3: Add one tool-decoration helper used by every event order**

Change the tool variant in `LogItem`:

```ts
| {
    kind: "tool";
    toolId: string;
    name: string;
    status: "in_progress" | "background" | "complete";
    ok?: boolean;
    input?: string;
    result?: string;
    elapsedSec?: number;
    workflow?: WorkflowRunSummary;
  }
```

Add and export:

```ts
export function syncWorkflowTools(log: LogItem[], runs: Record<string, WorkflowRunSnapshot> | undefined): LogItem[] {
  if (!runs) return log;
  const byTool = new Map(Object.values(runs).flatMap((run) => run.toolUseId ? [[run.toolUseId, run] as const] : []));
  return log.map((item) => {
    if (item.kind !== "tool" || item.name !== "Workflow") return item;
    const run = byTool.get(item.toolId);
    if (!run) return item;
    const { agents: _agents, ...summary } = run;
    return {
      ...item,
      workflow: summary,
      status: run.status === "running" ? "background" : "complete",
      ok: run.status === "failed" ? false : item.ok,
    };
  });
}
```

Apply it in all three places:

1. after `applySubEvent()` in the `worker.event` reducer case;
2. after upserting a `worker.workflow.run` event;
3. in `seedWorkflowRuns()` and `seedWorkerHistory()` so either reconnect response order converges.

Do not special-case generic `tool_result` itself; the shared post-pass is the single source of truth.

- [ ] **Step 4: Render background Workflow cards**

Extend `ToolBlock` with `workflow?: WorkflowRunSummary` and status `background`. The dot and sheen remain live for both `in_progress` and `background`; `useJustEnded` receives `status !== "complete"`. For a workflow card:

- primary label: workflow name, with tool name retained as a small monospace eyebrow;
- secondary line: localized `Active {active} · Completed {completed} · Started {started}`, plus `Stopped {stopped}` when non-zero;
- right status: localized Running / Completed / Failed / Stopped based on `workflow.status`;
- terminal tone: existing success green for completed, failure red for failed, muted/neutral for stopped;
- existing disclosure still owns raw input/result and remains closed by default.

Pass `workflow` through both single and grouped paths in `ToolGroup`. Change group `running` to `tools.some((tool) => tool.status !== "complete")`.

- [ ] **Step 5: Add a compact truthful worker-header reason**

In `WorkspaceHeaders.tsx`, add a self-subscribing child so high-frequency workflow changes do not re-render the whole App:

```tsx
function WorkerActivityReason({ worker }: { worker: FleetRow }): JSX.Element | null {
  const t = useT();
  const activeWorkflows = useStore((state) => Object.values(state.workflows[worker.id] ?? {}).filter((run) => run.status === "running").length);
  if (activeWorkflows > 0) return <span className="shrink-0 rounded border border-run/25 bg-run/10 px-1.5 py-0.5 font-mono text-[10px] text-run">{t("workspaceHeaders.workflowTasks", { count: activeWorkflows })}</span>;
  if (worker.status === "background" && worker.bg?.count) return <span className="shrink-0 rounded border border-line bg-ink/40 px-1.5 py-0.5 font-mono text-[10px] text-muted">{t("workspaceHeaders.backgroundTasks", { count: worker.bg.count })}</span>;
  return null;
}
```

Render it immediately after `StatusBadge`. This does not replace or reinterpret the status badge. Add singular/plural-neutral Korean/English strings (the catalog formatter has no plural engine, so phrase them as `Workflow · {count}` and `Background · {count}`).

- [ ] **Step 6: Verify inline/header behavior and desktop gates**

```bash
npm -w apps/desktop test -- --run test/store-reduce.test.ts test/tool-block.test.tsx test/workspace-headers.test.tsx
npm -w apps/desktop run typecheck
npm -w apps/desktop run build
```

Expected: PASS.

- [ ] **Step 7: Commit Task 9**

```bash
git add apps/desktop/src/renderer/store/reduce.ts apps/desktop/src/renderer/store/store.ts apps/desktop/src/renderer/components/ToolBlock.tsx apps/desktop/src/renderer/components/ToolGroup.tsx apps/desktop/src/renderer/components/WorkspaceHeaders.tsx apps/desktop/src/renderer/i18n/locales/en/toolBlock.ts apps/desktop/src/renderer/i18n/locales/ko/toolBlock.ts apps/desktop/src/renderer/i18n/locales/en/workspaceHeaders.ts apps/desktop/src/renderer/i18n/locales/ko/workspaceHeaders.ts apps/desktop/test/store-reduce.test.ts apps/desktop/test/tool-block.test.tsx apps/desktop/test/workspace-headers.test.tsx
git commit -m "feat: show workflow background progress inline" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Update evergreen docs, run full gates, and smoke-test a real workflow

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/architecture/master-worker-turn.md`
- Modify: `docs/reference/events.md`
- Modify: `docs/reference/protocol.md`
- Modify: `docs/README.md` only if its index requires an evergreen Activity entry

- [ ] **Step 1: Update architecture and reference documentation**

Document these invariants, citing their implementation files:

- Dynamic Workflow activity is Claude-worker-only and is not `worker.nested`.
- Worker state still comes from background-task membership; workflow UI events are observational.
- daemon-lifetime registry, no SQLite/cross-daemon history;
- taskId-stable run identity, optional runId/toolUseId until launch;
- one validated workflow directory watcher, lazy selected transcript, bounded fields/events;
- `worker.workflow.run`, `worker.workflow.agent`, `workflow.list`, and `workflow.agent.history` payloads;
- Activity is the user-facing name while persisted dock/segment ids remain unchanged.

Keep `AGENTS.md` at summary level and put the full event/protocol fields in the reference catalogs.

- [ ] **Step 2: Run all focused suites once more under Node 22**

```bash
nvm use 22
npx vitest run test/core/claude-backend.test.ts test/core/claude-workflow-transcript.test.ts test/core/worker.test.ts test/daemon/claude-workflow-files.test.ts test/daemon/claude-workflow-registry.test.ts test/daemon/connection.test.ts test/protocol/messages.test.ts
npm -w apps/desktop test -- --run test/store-reduce.test.ts test/workflow-activity.test.tsx test/tool-block.test.tsx test/workspace-headers.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run the full root and desktop gates**

```bash
npm test
npm run typecheck
npm run build
npm -w apps/desktop test
npm -w apps/desktop run typecheck
npm -w apps/desktop run build
```

Expected: every command exits 0. Fix production typing before suppressing a test; do not weaken path validation or count assertions to make a gate pass.

- [ ] **Step 4: Run one live Claude Dynamic Workflow smoke**

Use `./scripts/dev.sh`, create a Claude worker in a disposable registered repo/worktree, and launch a known Dynamic Workflow that spawns at least four agents. Verify all of the following manually:

1. The worker goes `running → background → idle` without an intermediate false idle during the SDK wake.
2. Activity shows a run before its first agent row and updates Started/Active/Completed truthfully.
3. The inline Workflow tool card remains background until the task settles.
4. Selecting one agent loads only that transcript and a 100+ agent synthetic fixture remains scroll-responsive.
5. Close/reopen the desktop while the daemon and workflow stay alive; the snapshot restores the same run/roster.
6. Interrupting only the worker turn leaves workflow observation alive; stopping the worker marks unfinished agents stopped.
7. No payload visible in DevTools/WS contains `transcriptDir`, `scriptPath`, or another absolute workflow path.

Record the SDK/CLI version and the workflow/run/task ids in the implementation PR description, but do not commit local transcript content.

- [ ] **Step 5: Review the final diff for scope and naming**

```bash
git status --short
git diff --check
git diff --stat
rg -n "Nested agents|중첩 에이전트" apps/desktop/src/renderer
rg -n "transcriptDir|scriptPath" src/core/events.ts src/protocol/messages.ts apps/desktop/src/renderer
```

Expected: remaining Nested Agents strings label the nested subsection only; absolute workflow path fields exist only in provider/core/daemon-private contracts, never in emitted view/protocol structures.

- [ ] **Step 6: Commit docs and verification adjustments**

```bash
git add AGENTS.md docs/architecture/master-worker-turn.md docs/reference/events.md docs/reference/protocol.md docs/README.md
git commit -m "docs: document dynamic workflow activity" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

If `docs/README.md` did not require a change, omit it from `git add` rather than creating a cosmetic edit.
