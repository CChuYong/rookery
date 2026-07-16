# Dynamic Workflow Activity — design

**Date:** 2026-07-16
**Branch at design time:** `fix/prompt-paste-undo`
**Status:** implemented
**Scope:** Claude workers only, live activity + desktop reconnect while the daemon remains alive

## Decision

Keep ordinary native subagents and Claude Dynamic Workflows as separate data models, but compose them in one user-facing **Activity** surface. A daemon-owned live registry observes workflow task frames (including Claude's live phase progress) plus validated local workflow journals, the desktop requests a reconnect snapshot and lazy selected-agent history, and the original inline `Workflow` tool card remains in a background state until the real task settles. This gives one natural place to look without pretending Dynamic Workflow is the same mechanism as `worker.nested`.

## Problem

Claude Code Dynamic Workflows do not travel through the same live stream as ordinary `Agent`/`Task` subagents. Rookery's right sidebar only understands nested traffic carrying `parent_tool_use_id`, so a workflow can run tens or hundreds of agents while the UI shows no roster, no current activity, and no completion count. The generic `Workflow` tool card also appears complete as soon as the asynchronous run is launched, even though the real work continues in the background.

The user needs truthful answers to these questions while a workflow is running:

1. Is a workflow still running, completed, failed, or stopped?
2. How many agents have started, are currently active, and have completed?
3. What is each active agent doing now, or what tool did it use most recently?
4. Can I inspect one agent's transcript without flooding the main conversation or renderer?
5. If the desktop disconnects and reconnects to the still-running daemon, does the activity view recover?

## Verified facts

### Upstream SDK contract

The current project targets `@anthropic-ai/claude-agent-sdk` `^0.3.207`.

- A successful `Workflow` tool launch returns a structured `tool_use_result` with `status:"async_launched"`, `taskId`, `taskType:"local_workflow"`, `workflowName`, `runId`, `summary`, `transcriptDir`, and `scriptPath`.
- The parent SDK stream emits task lifecycle frames:
  - `task_started`: `task_id`, `tool_use_id`, `description`, `task_type`, `workflow_name`
  - `task_progress`: `task_id`, `description`, `usage`, `last_tool_name`, optional `summary`
  - `task_updated`: a status patch
  - `task_notification`: terminal status, output file, summary, usage
- The installed Claude CLI also emits an accumulated `workflow_progress` array on raw `task_progress` system frames for `local_workflow` tasks. This field is not declared in the public SDK TypeScript definitions, but it is the live data source used by Claude Code's `/workflows` UI:
  - `workflow_phase`: exact phase `index` and `title`
  - `workflow_agent`: exact `agentId`, `label`, `phaseIndex`, `phaseTitle`, `model`, and live state
- Rookery duck-types that one raw field behind a strict parser and forwards only phase/identity metadata; prompt previews, result previews, tool summaries, timestamps, and other provider fields are discarded.
- `agentProgressSummaries` defaults to false. This design consumes summaries when upstream provides them but does **not** enable extra model-generated summaries by default.

### Local workflow artifact ground truth

A structure-only inspection of existing local Dynamic Workflow runs on 2026-07-16 found the same layout for every examined run:

```text
<parent-session>/
├── workflows/<runId>.json
└── subagents/workflows/<runId>/
    ├── journal.jsonl
    ├── agent-<agentId>.meta.json
    └── agent-<agentId>.jsonl
```

- `journal.jsonl` is append-only. Lines are either:

  ```ts
  { type: "started", agentId: string, key: string }
  { type: "result", agentId: string, key: string, result: unknown }
  ```

- Every observed agent had one transcript and one meta file.
- Meta currently contains `agentType:"workflow-subagent"` and `spawnDepth`.
- Agent transcripts contain timestamped Claude JSONL entries with thinking, assistant text, tool uses, and tool results.
- A representative interrupted run contained 12 `started` records and 6 `result` records, proving that active/completed counts can be reconstructed without guessing.
- Journal records do not carry timestamps; agent transcript timestamps and daemon observation time provide start/last-activity/end times.
- The sibling `workflows/<runId>.json` snapshot contains declared `phases[]` plus `workflowProgress[]`. Its `workflow_agent` entries provide the exact `agentId`, `label`, `phaseIndex`, `phaseTitle`, and `model` mapping that the journal and per-agent meta files omit.
- That snapshot also contains scripts, logs, prompts, and result previews. Rookery must parse it through a strict allowlist and never forward those fields.

### Current Rookery behavior

- `src/core/claude-backend.ts` maps task membership to `background_task` / `background_tasks` so the Worker state graph remains truthful.
- The adapter recognizes known workflow task ids, sanitizes their live `workflow_progress`, and maps the result into provider-neutral workflow updates. Other task-progress heartbeats remain transcript noise and are dropped.
- `src/core/worker.ts` emits `worker.status.bg {count,types}`, but the desktop reducer stores only `status` and discards `bg`.
- `worker.nested` is intentionally the wrong transport for workflows: it is flat, live-only, keyed by one parent tool-use id, and assumes forwarded child messages. Workflow activity is run → agent hierarchy backed by separate transcript files.

## Goals

1. Add a first-class **Activity** surface containing Dynamic Workflows and ordinary Nested Agents.
2. Keep the generic worker state graph unchanged: workflow tasks still count as background work, and `idle` continues to mean all assigned work is settled.
3. Show truthful workflow and agent counts without fabricating a percentage or fixed total.
4. Keep a launched `Workflow` tool card visibly active until its task settles.
5. Load detailed agent transcripts only on demand.
6. Recover all live workflow summaries after a desktop reconnect by asking the daemon for a snapshot.
7. Degrade to task-level visibility when transcript observation is unavailable; observability failure must never fail or stop the workflow itself.
8. Keep provider-specific transcript decoding behind a provider-neutral core port.
9. Group workflow agents by their exact provider-recorded phase and label while allowing multiple phases to be active concurrently.

## Non-goals

- Codex support. Codex collab children remain in the existing Nested Agents path.
- Master-side Dynamic Workflow support. The master has a restrictive native-tool allowlist and no nested/activity surface; this design targets worker streaming sessions.
- Persisting workflow activity in SQLite or reconstructing completed workflow cards after a daemon restart.
- A deterministic percentage, ETA, or total-agent denominator while the workflow can still spawn more agents.
- Parsing or executing the workflow script to infer phase state. Phase definitions and agent mappings come from provider-emitted live progress, with the provider-written run snapshot as fallback/enrichment; Rookery does not claim one exclusive “current phase.”
- New cost accounting. The UI may show upstream token/tool-use counters when present, but not a dollar amount until billing semantics are independently verified.
- Workflow control buttons such as pause/resume/stop-task. Worker stop/interrupt semantics stay unchanged.
- Turning on `agentProgressSummaries`; doing so adds upstream model work and should be a separate opt-in decision.

## User experience

### Right sidebar

Rename the user-facing **Nested agents** segment to **Activity** while retaining internal persisted ids (`worker` segment, `nested` dock panel) for layout compatibility.

```text
Activity

┌ Workflow · rookery-logic-audit         RUNNING · 7m
│ Active 6 · Completed 6 · Started 12
│ Latest: Bash · 8s ago
│
│ Phase 1 · Recon
│ Active 3 · Completed 4 · Started 7
│   ● code:core · a0e188           Bash       8s
│
│ Phase 2 · Verify
│ Active 3 · Completed 2 · Started 5
│   ● verify:persistence · a29846  Read      12s
│   ▸ Completed agents (2)
│
│ Selected agent
│   [read-only MessageList transcript]
└──────────────────────────────────────────────

Nested agents · 2
  ▸ reviewer
  ▸ /root/compute_answer
```

Rules:

- Do not automatically open or switch the right sidebar when a workflow starts.
- Running and failed work is sorted before completed work; newest activity sorts first within a group.
- Declared phases stay in provider order. Multiple phase sections may show active agents at the same time; there is no fabricated exclusive “current phase.”
- Agent rows prefer the provider-recorded `label` and retain the short `agentId` as their stable secondary identity. Agents without phase metadata fall back to an `Unassigned` section.
- Completed agents are collapsed by default.
- Stopped agents use their own collapsed group so they are not mislabeled as completed.
- A click selects one agent and loads its transcript. Overview updates remain live even when no transcript is selected.
- Lists must remain responsive with hundreds of agents. Use virtualization for the agent roster and never render all transcripts at once.
- If transcript observation fails, show `Limited visibility` with the task-level summary. Do not show an empty-state message claiming no activity.
- Never display `50%` from `6 completed / 12 started`; the denominator can grow.

### Worker header and sidebar indicator

- Preserve the existing worker status badge (`BG` / localized `Background tasks`) because it represents the Worker state graph.
- Store the existing `worker.status.bg` payload in the desktop so the header can add a compact reason, e.g. `Workflow · 1 task`, without redefining the primary status.
- The Activity segment may show a small live count badge for active workflow agents. This badge is informational and must not replace the Worker status.

### Inline Workflow tool card

The ordinary SDK tool result means only “the asynchronous workflow was launched.” When a `worker.workflow.run` update identifies the matching `toolUseId`:

- Change the tool item's UI status from `complete` to `background` while the run is active.
- Show the workflow name and `Active / Completed / Started` counts; append `Stopped` when it is non-zero.
- On terminal update, change the card to `complete` and color it by terminal outcome.
- Keep raw input/result available under the existing disclosure control.
- If the workflow launch event arrives before the generic tool-result reducer, either event order must converge to the same `background` card.

## Domain model

Create the provider-neutral definitions in `src/core/workflow-activity.ts`.

```ts
export type WorkflowRunStatus = "running" | "completed" | "failed" | "stopped";
export type WorkflowVisibility = "live" | "summary-only";
export type WorkflowAgentStatus = "running" | "completed" | "stopped";
export type WorkflowWarning = "limited-visibility" | "partial-data";

export interface WorkflowPhaseSummary {
  index: number;
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowAgentMetadata {
  agentId: string;
  label?: string;
  phaseIndex?: number;
  phaseTitle?: string;
  model?: string;
}

export interface WorkflowProgressMetadata {
  phases: WorkflowPhaseSummary[];
  agents: WorkflowAgentMetadata[];
}

export interface WorkflowLaunch {
  taskId: string;
  toolUseId: string;
  runId: string;
  workflowName: string;
  summary: string;
  transcriptDir: string; // daemon/core only; never serialized to the desktop
  scriptPath?: string;   // daemon/core only; never serialized to the desktop
}

export interface WorkflowTaskUpdate {
  taskId: string;
  phase: "started" | "progress" | "settled";
  workflowName?: string;
  description?: string;
  summary?: string;
  lastToolName?: string;
  usage?: { totalTokens: number; toolUses: number; durationMs: number };
  progress?: WorkflowProgressMetadata;
  outcome?: "completed" | "failed" | "stopped";
}

export interface WorkflowAgentSummary {
  agentId: string;
  agentType: string;
  label?: string;
  phaseIndex?: number;
  phaseTitle?: string;
  model?: string;
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
  toolUseId?: string; // absent until the Workflow launch result arrives
  runId?: string;     // absent until the Workflow launch result arrives
  workflowName: string;
  summary: string;
  lastToolName?: string;
  status: WorkflowRunStatus;
  visibility: WorkflowVisibility;
  warning?: WorkflowWarning;
  startedAt: number;
  lastActivityAt: number;
  endedAt?: number;
  usage?: { totalTokens: number; toolUses: number; durationMs: number };
  phases?: WorkflowPhaseSummary[];
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

export interface WorkflowActivitySink {
  launched(owner: WorkflowOwner, launch: WorkflowLaunch): void;
  taskUpdated(owner: WorkflowOwner, update: WorkflowTaskUpdate): void;
  stopWorker(workerId: string): void;
}

export interface WorkflowActivityProvider {
  list(workerId: string): WorkflowRunSnapshot[];
  agentHistory(workerId: string, taskId: string, agentId: string): Promise<WorkflowAgentHistoryEntry[]>;
}

export interface WorkflowAgentHistoryEntry {
  data: import("./events.js").WorkerEventData;
  createdAt?: string;
}
```

The registry implementation may contain private filesystem paths, byte offsets, partial-line buffers, watchers, and timers. None of those belong in these public view types.
`warning` is a stable machine code. The desktop maps it through its ko/en catalog; daemon-authored English warning prose is never treated as UI copy.

## Provider event mapping

Extend `AgentEvent` with two Claude-produced, provider-neutral events:

```ts
| { kind: "workflow_launched"; launch: WorkflowLaunch }
| { kind: "workflow_task"; update: WorkflowTaskUpdate }
```

### Workflow launch extraction

For an SDK `user` message:

1. Run the existing generic text/tool-result extraction first.
2. Inspect top-level `tool_use_result`.
3. Accept it only when:
   - `status === "async_launched"`
   - `taskType === "local_workflow"`
   - `taskId`, `runId`, `workflowName`, and `transcriptDir` are non-empty strings
   - the message contains a matching generic `tool_result` from which `toolUseId` can be obtained
4. Emit `workflow_launched` **after** the generic `tool_result`. This makes the normal live order update an already-existing tool card, while reducer tests still guarantee order independence.

### Task lifecycle extraction

The per-stream Claude decode state keeps a `Set<string>` of workflow task ids.

- `task_started` with `task_type:"local_workflow"` adds the id and emits both the existing `background_task(started)` event and `workflow_task(started)`.
- A decoded `workflow_launched` also adds its `taskId`, covering launch-before-start ordering.
- `task_progress` for a known workflow id emits `workflow_task(progress)` instead of being dropped. Generic task progress stays ignored.
- Terminal `task_updated` and `task_notification` for a known workflow id emit `workflow_task(settled)` with the precise outcome. Existing background settle events remain byte-for-byte compatible for the Worker state graph.
- Duplicate terminal frames are expected. The registry makes terminal updates idempotent by `taskId`.
- `background_tasks_changed` remains the authoritative membership level for Worker state after the existing latch. It does not replace workflow metadata events.

## Activity registry and transcript observation

Create one daemon-owned `ClaudeWorkflowRegistry` and inject it as both `WorkflowActivitySink` and `WorkflowActivityProvider`.

### Registration and ordering

Launch metadata and task frames can arrive in either order. The registry keys provisional state by `workerId + taskId` and merges:

- task-only state → summary-only running card
- launch metadata → run id, tool id, name, transcript directory
- transcript observation → live agent summaries
- terminal task update → terminal run status and stop all still-running agent summaries

The registry emits:

```ts
{ type: "worker.workflow.run", sessionId, workerId, run: WorkflowRunSummary }
{ type: "worker.workflow.agent", sessionId, workerId, taskId, agent: WorkflowAgentSummary }
```

Run updates carry no full agent array. Agent deltas are separate so a single active agent does not resend hundreds of siblings.
The first run update is emitted before the first agent delta, so clients never need to fabricate a parent run for an orphan agent event.

### Filesystem boundary

`ClaudeWorkflowRegistry` consumes an injected `ClaudeWorkflowFiles` port. The real implementation is wired only in `startDaemon()` and uses Node filesystem APIs. Tests use a fake port; the registry itself never imports `node:fs`.

The port must support:

```ts
interface ClaudeWorkflowFiles {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ size: number; mtimeMs: number; isFile: boolean }>;
  read(path: string, offset: number, length: number): Promise<Buffer>;
  readText(path: string, maxBytes: number): Promise<string>;
  watchDirectory(path: string, onChange: (name: string | null) => void): { close(): void };
}
```

### Path validation

Treat `transcriptDir` as provider output, not trusted desktop input.

Before reading it:

1. Require `sdkSessionId` to be known.
2. Resolve `realpath(transcriptDir)` and require it to equal the normalized supplied path.
3. Require this exact suffix hierarchy:

   ```text
   <sdkSessionId>/subagents/workflows/<runId>
   ```

4. Require `journal.jsonl` and agent files to stay under that validated real directory.
5. Derive the optional sibling snapshot as `<validated-session-root>/workflows/<runId>.json`; require its `realpath` to equal that exact path and its parent to remain the validated session root's `workflows/` directory. Do not trust `scriptPath` for this lookup.
6. Never send an absolute transcript, state, or script path over CoreEvent/WS.

If validation fails, keep the run in `summary-only` visibility and expose a generic localized warning. Do not include the rejected path in user-facing text.

### Robust tailing

- Sanitize each raw `task_progress.workflow_progress` payload at the Claude adapter boundary. Seeded `workflow_phase` records make phase headings available from the first workflow progress frame; `workflow_agent` records provide exact mapping as agents are registered. Merge metadata for not-yet-journaled agents so their first journal event is grouped immediately.
- Tail `journal.jsonl` by byte offset with a partial-line buffer.
- Use one directory watcher per workflow run, not one watcher per agent.
- A watcher callback drains the changed journal/agent file.
- Add a 1-second reconciliation timer while the run is active because `fs.watch` can coalesce or miss notifications.
- On that same timer, read the sibling run snapshot only when `{size,mtimeMs}` changes, cap it at 16 MiB, and extract only phases plus agent identity metadata. This path recovers/enriches live metadata (notably phase detail/model fields) when the provider writes the file. A missing, partial, malformed, oversized, or escaped snapshot does not remove live phase grouping or degrade the still-valid journal/transcript observation.
- If launch metadata arrives just before the workflow directory/journal is materialized, keep summary-only visibility and use that same single timer to revalidate; promote to live automatically when the path becomes valid.
- Read append-only files in bounded 256 KiB chunks and schedule another drain while unread bytes remain.
- Decode chunk boundaries with a per-file UTF-8 `StringDecoder`; Korean or other multibyte text split across reads must not corrupt JSON.
- On a terminal drain, consume one final valid journal record even when the provider omitted the trailing newline.
- Cap a single JSONL line at 1 MiB for the overview parser. Oversized/malformed lines are skipped and recorded with the `partial-data` warning code; they never crash the worker.
- Coalesce run plus per-agent deltas into at most one non-terminal emission batch per run every 250 ms. Each batch carries at most the latest summary for every changed agent; terminal updates flush immediately.
- Close watcher and timer on terminal task update, worker terminal stop, or daemon shutdown.

### Journal semantics

- First `started` for an agent creates `running`; duplicates are ignored.
- First `result` marks `completed`; duplicates are ignored.
- `result` without a prior `started` creates a completed agent so reconnect/race recovery remains monotonic.
- When a workflow settles, any agent still lacking a result becomes `stopped`.
- Terminal handling is serialized behind pending transcript reads and performs one final journal drain before marking unfinished agents `stopped`; duplicate terminal frames remain idempotent.
- Agent totals are derived from the current map:

  ```text
  started   = agents.size
  active    = status == running
  completed = status == completed
  stopped   = status == stopped
  ```

### Agent transcript summary

For overview updates, parse only fields needed for `WorkflowAgentSummary`:

- first/last valid timestamp
- `attributionAgent` or meta `agentType`
- `spawnDepth`
- assistant thinking → `activity:"thinking"`
- assistant text → `activity:"responding"`
- assistant tool use → `activity:"tool"`, `lastToolName`, increment `toolUses`
- journal result → `activity:"complete"`

Do not send prompts, tool inputs, tool results, or assistant text in summary events.

For `agentHistory()`, parse the selected agent transcript on demand into bounded `WorkerEventData` records:

- maximum 200 rendered events
- maximum 4,000 characters per thinking/message/tool input/tool result
- reuse the same safe JSON/truncation conventions as Worker transcripts
- return timestamps separately as `createdAt`

## Worker integration

Add optional `workflowActivity?: WorkflowActivitySink` to `WorkerDeps`.

- On `workflow_launched`, call `launched()` with the current `sessionId`, worker id, and captured SDK session id.
- On `workflow_task`, call `taskUpdated()`.
- These branches do not write `worker_events`; workflow activity has its own snapshot/event channel.
- The existing `background_task` and `background_tasks` branches remain the only inputs to Worker live-state derivation.
- `interrupt_worker` does not stop the registry because upstream background tasks survive interrupt.
- Worker terminal transitions call `stopWorker(workerId)` exactly once.

## Protocol and reconnect

Add client requests:

```ts
{ type: "workflow.list", reqId: string, workerId: string }
{ type: "workflow.agent.history", reqId: string, workerId: string, taskId: string, agentId: string }
```

Responses:

```ts
{ type: "workflow.list.result", reqId: string, workerId: string, runs: WorkflowRunSnapshot[] }
{ type: "workflow.agent.history.result", reqId: string, workerId: string, taskId: string, agentId: string, events: WorkflowAgentHistoryEntry[] }
```

Connection handlers never accept a path. The provider verifies ownership by ids against its registry.

Desktop behavior:

- Request `workflow.list` whenever the active worker's ordinary history is requested, including reconnect and worker selection.
- Merge the snapshot authoritatively for that worker while preserving any newer live deltas by a monotonic `lastActivityAt` check.
- Live `worker.workflow.run` and `worker.workflow.agent` events upsert individual entries.
- Permanent worker deletion clears workflow state and loaded agent history.
- A late selected-agent history response is ignored after another agent is selected, preserving the one-history-per-worker cache bound.

No SQLite migration is required. The resident daemon is the live authority and survives ordinary desktop disconnects. A daemon restart terminates the SDK subprocess and its workflow tasks; the generic persisted Workflow tool result remains in worker history, but the Activity registry starts empty.

## Failure behavior

| Failure | User-visible behavior | Worker/workflow effect |
|---|---|---|
| Missing or invalid transcript directory | `Limited visibility`; task-level status/summary | none |
| Malformed/oversized journal line | warning on run; retain last good counts | none |
| Directory watcher error/missed event | 1s reconciliation continues; summary-only if reads fail repeatedly | none |
| Agent transcript parse error | row retains last good activity; history shows load failure | none |
| Duplicate task terminal frames | one terminal transition | none |
| Desktop disconnect | daemon keeps tracking; snapshot restores UI | none |
| Worker stop/error | active run and agents become stopped; observers close | existing worker termination |
| Permanent Worker deletion | daemon registry and renderer caches for that Worker are released | existing deletion lifecycle |

## Performance constraints

- No full workflow snapshot is sent to the renderer on every agent heartbeat; live metadata is merged in the daemon and UI events remain coalesced.
- No raw transcript streaming to the renderer unless one agent is selected.
- Cache at most one selected agent history per worker in the renderer; selecting another agent evicts the previous bounded history.
- At most one directory watcher and one reconciliation timer per active workflow run.
- At most one non-terminal UI update batch per run every 250 ms; terminal events bypass the throttle.
- Agent roster virtualization is required beyond ordinary small lists.
- Renderer keys are stable: `workerId/taskId/agentId`. `taskId` is chosen because task lifecycle can arrive before launch metadata supplies `runId`.
- Retain only the daemon-lifetime run registry; do not duplicate raw workflow transcripts in SQLite.

## Alternatives rejected

### Reuse `worker.nested`

Rejected. It has no run hierarchy, no terminal state, no reconnect snapshot, and assumes live forwarded child messages. It also cannot efficiently represent hundreds of agents.

### Show only `task_progress`

Rejected as the complete solution. It is a good task-level fallback but does not provide the exact agent roster or completion counts. `summary` is optional and disabled by default unless the SDK is asked to generate it.

### Parse the workflow script to infer phases and totals

Rejected. Runtime branching makes static totals unreliable, and the observed journal has no phase association. A plausible-looking percentage would be false precision.

### Poll every agent transcript from the renderer

Rejected. It exposes filesystem paths, duplicates provider parsing in a thin client, and scales badly. The daemon owns local observation and sends bounded summaries.

### Persist every workflow event in SQLite

Rejected for v1. Upstream JSONL is already the detailed source of truth, daemon reconnect is the user requirement, and daemon restart kills the live workflow. Persisted product history can be designed separately if users later need cross-daemon audit views.

## Acceptance criteria

1. Starting a Dynamic Workflow in a Claude worker produces a visible running Workflow card in Activity and keeps the inline Workflow tool card active.
2. `started`, `active`, `completed`, and `stopped` counts match a synthetic journal exactly and never render a percentage.
3. Agent rows update their latest activity/tool without raw transcript payloads in CoreEvents.
4. Selecting one agent loads a bounded read-only transcript; no other agent transcript is rendered.
5. Ordinary Claude/Codex Nested Agents still appear and behave unchanged under the Activity section.
6. Desktop reconnect followed by `workflow.list` restores the same active run/agent roster from the daemon registry.
7. Invalid/missing transcript paths produce summary-only visibility without leaking paths or affecting the workflow.
8. Duplicate `task_updated` + `task_notification` terminal frames are idempotent.
9. Worker interrupt leaves workflow observation active; Worker stop closes it and marks unfinished agents stopped.
10. Root and desktop unit/typecheck gates pass under Node 22.
11. A live smoke run with at least four parallel workflow agents visibly transitions from active to completed and remains responsive.

## Expected file ownership

- `src/core/workflow-activity.ts` — provider-neutral public types and sink/provider ports.
- `src/core/claude-workflow-transcript.ts` — pure Claude journal/agent JSONL decoding.
- `src/core/claude-backend.ts` / `src/core/sdk-extract.ts` — SDK message → workflow launch/task events.
- `src/daemon/claude-workflow-files.ts` — real filesystem port.
- `src/daemon/claude-workflow-registry.ts` — lifecycle, path validation, tailing, throttling, snapshots/history.
- `src/core/worker.ts` / `src/daemon/server.ts` — sink calls and composition-root wiring.
- `src/core/events.ts` / `src/protocol/messages.ts` / `src/daemon/connection.ts` — live deltas and snapshot/history wire contract.
- `apps/desktop/src/renderer/store/reduce.ts` — workflow state and inline tool-card convergence.
- `apps/desktop/src/renderer/views/WorkflowRuns.tsx` — workflow/agent overview and selected transcript.
- `apps/desktop/src/renderer/views/ActivityPanel.tsx` — Workflow Runs + existing Nested Agents composition.
- `apps/desktop/src/renderer/components/RightSidebar.tsx` / `workspace/panels.tsx` — host Activity instead of a nested-only empty state.
- Desktop ko/en catalogs — Activity, workflow states/counts, limited-visibility copy.
