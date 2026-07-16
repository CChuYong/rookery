import { query as sdkQuery, createSdkMcpServer, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { AgentBackend, AgentEvent, AgentSessionOptions, AgentStream, InterruptReceipt, MasterTurnOptions, SlashCommandInfo } from "./agent-backend.js";
import { extractText, extractToolUses, extractToolResults, extractWorkflowLaunch } from "./sdk-extract.js";
import { classifySystemPush } from "./system-push.js";
import { turnContext } from "./result-telemetry.js";
import { effortApplies, coerceEffort } from "./effort.js";
import type { ClaudeRuntimeLaunchOptions } from "./claude-capabilities.js";
import type { ResolvedAgentCapabilities } from "./capabilities/types.js";
import { truncateBytes } from "./truncate.js";
import { parseWorkflowProgress } from "./claude-workflow-transcript.js";

// The Claude Agent SDK query() signature — the adapter's own contract (canonical home; formerly worker.ts).
// Injected at the composition root (real sdkQuery in the daemon, fakeQuery in tests). Claude-specific
// aux paths that bypass the port (labeler, CommandCatalog probe) consume this type directly.
export type QueryFn = typeof sdkQuery;
export type LoadClaudeCapabilities = (capabilities: ResolvedAgentCapabilities) => ClaudeRuntimeLaunchOptions;
type QueryInput = Parameters<QueryFn>[0];
type QueryOptions = NonNullable<QueryInput["options"]>;

// Wrap a stream of user input strings into the minimal SDKUserMessage shape required by streaming-input mode.
// No `as` assertion — if the SDK (0.x) adds mandatory fields, tsc catches it here (moved from message-queue.ts).
export async function* claudeUserMessages(input: AsyncIterable<string>): AsyncIterable<SDKUserMessage> {
  for await (const text of input) {
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    };
    yield msg;
  }
}

// Per-stream decode state: the last message_start's per-request usage. result.usage accumulates across
// multiple model calls within a turn (cache re-reads can exceed the window), so turn_end context % is
// computed from the LAST request's usage, falling back to the cumulative value (turnContext).
interface DecodeState {
  lastReqContextTokens: number;
  workflowTaskIds: Set<string>;
}

function workflowUsage(raw: unknown): { totalTokens: number; toolUses: number; durationMs: number } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as { total_tokens?: unknown; tool_uses?: unknown; duration_ms?: unknown };
  const finite = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  return {
    totalTokens: finite(usage.total_tokens),
    toolUses: finite(usage.tool_uses),
    durationMs: finite(usage.duration_ms),
  };
}

function workflowOutcome(status: string | undefined): "completed" | "failed" | "stopped" | undefined {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "stopped" || status === "killed") return "stopped";
  return undefined;
}

function workflowText(value: unknown, maxBytes: number): string | undefined {
  return typeof value === "string" && value ? truncateBytes(value, maxBytes) : undefined;
}

// Translate one raw SDK message into zero or more provider-neutral AgentEvents.
// This is the decode moved verbatim out of the worker.ts/master-agent.ts stream loops — shapes are
// duck-typed exactly as before (structural coupling; test/helpers/fake-query.ts is the de-facto spec).
function* translate(msg: unknown, state: DecodeState): Generator<AgentEvent> {
  const type = (msg as { type?: string }).type;
  const parentId = (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null;
  if (type === "stream_event") {
    if (parentId) return; // nested partial tokens are never surfaced (nested shows only completed messages)
    const ev = (msg as { event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string }; message?: { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } } } }).event;
    if (ev?.type === "message_start") {
      const mu = ev.message?.usage ?? {};
      state.lastReqContextTokens = (mu.input_tokens ?? 0) + (mu.cache_read_input_tokens ?? 0) + (mu.cache_creation_input_tokens ?? 0);
    } else if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
      yield { kind: "text_delta", text: ev.delta.text };
    } else if (ev?.type === "content_block_delta" && ev.delta?.type === "thinking_delta" && typeof ev.delta.thinking === "string") {
      yield { kind: "thinking_delta", text: ev.delta.thinking };
    }
    return;
  }
  if (type === "assistant" || type === "user") {
    const text = extractText(msg);
    if (text !== "") yield { kind: "message", role: type, text, parentToolUseId: parentId };
    for (const tu of extractToolUses(msg)) yield { kind: "tool_use", id: tu.id, name: tu.name, input: tu.input, parentToolUseId: parentId };
    for (const tr of extractToolResults(msg)) yield { kind: "tool_result", toolUseId: tr.toolUseId, isError: tr.isError, content: tr.content, parentToolUseId: parentId };
    const launch = type === "user" ? extractWorkflowLaunch(msg) : null;
    if (launch) {
      state.workflowTaskIds.add(launch.taskId);
      yield { kind: "workflow_launched", launch };
    }
    return;
  }
  // Nested system/tool_progress/result never touch the parent session (both consumers skipped these).
  if (parentId) return;
  if (type === "system") {
    // Emit the session id EARLY (init) — an interrupt before the first result must not orphan resume.
    const sysSessionId = (msg as { session_id?: string }).session_id;
    if (sysSessionId) yield { kind: "session_id", sessionId: sysSessionId };
    // Background-task lifecycle frames (task_started/task_updated/task_notification/task_progress) —
    // live-verified against SDK 0.3.195 (probe-turn-lifecycle.mjs, 2026-07-11), still current at 0.3.207:
    // started fires when a task is backgrounded (or a long foreground command is auto-promoted ~3s in);
    // settle arrives as task_updated(patch.status ∈ completed|failed|killed) immediately followed by
    // task_notification — the worker's task-id set dedupes the double settle. task_progress is heartbeat
    // noise (dropped; previously it leaked into transcripts as an unclassified system_text row).
    // background_tasks_changed (SDK ≥0.3.203) is the level form of the same signal — the full live-task
    // set after a membership change, REPLACE semantics — consumed below as its own AgentEvent kind
    // ("background_tasks"), not merged into the edge stream above (Phase 2-B of the 2026-07-12 upgrade
    // design; the worker latches to level-only once it sees the first snapshot).
    const sub = (msg as { subtype?: string }).subtype;
    if (sub === "background_tasks_changed") {
      // NOTE: this frame may also carry a top-level `session_id` — already re-emitted above (harmless/idempotent).
      const bt = msg as { tasks?: Array<{ task_id?: string; task_type?: string }> };
      const tasks = (bt.tasks ?? []).flatMap((t) => (t.task_id ? [{ taskId: t.task_id, taskType: t.task_type ?? "task" }] : []));
      yield { kind: "background_tasks", tasks };
      return;
    }
    if (sub === "task_started" || sub === "task_updated" || sub === "task_notification" || sub === "task_progress") {
      const tm = msg as {
        task_id?: string;
        tool_use_id?: string;
        task_type?: string;
        workflow_name?: string;
        description?: string;
        summary?: string;
        last_tool_name?: string;
        workflow_progress?: unknown;
        usage?: unknown;
        status?: string;
        patch?: { status?: string };
      };
      if (typeof tm.task_id !== "string" || !tm.task_id || tm.task_id.length > 512) return;
      const taskType = workflowText(tm.task_type, 256);
      const workflowName = workflowText(tm.workflow_name, 256);
      const description = workflowText(tm.description, 4_000);
      const summary = workflowText(tm.summary, 4_000);
      const lastToolName = workflowText(tm.last_tool_name, 256);
      if (sub === "task_started") {
        if (taskType === "local_workflow") {
          state.workflowTaskIds.add(tm.task_id);
          yield {
            kind: "workflow_task",
            update: {
              taskId: tm.task_id,
              phase: "started",
              ...(workflowName ? { workflowName } : {}),
              ...(description ? { description } : {}),
            },
          };
        }
        yield { kind: "background_task", taskId: tm.task_id, ...(taskType ? { taskType } : {}), status: "started" };
        return;
      }
      if (sub === "task_progress") {
        if (state.workflowTaskIds.has(tm.task_id)) {
          const usage = workflowUsage(tm.usage);
          const progress = tm.workflow_progress === undefined ? undefined : parseWorkflowProgress(tm.workflow_progress);
          yield {
            kind: "workflow_task",
            update: {
              taskId: tm.task_id,
              phase: "progress",
              ...(description ? { description } : {}),
              ...(summary ? { summary } : {}),
              ...(lastToolName ? { lastToolName } : {}),
              ...(usage ? { usage } : {}),
              ...(progress && (progress.phases.length > 0 || progress.agents.length > 0) ? { progress } : {}),
            },
          };
        }
        return;
      }
      const rawStatus = sub === "task_notification" ? (typeof tm.status === "string" ? tm.status : "completed") : tm.patch?.status;
      const outcome = workflowOutcome(rawStatus);
      if (outcome && state.workflowTaskIds.has(tm.task_id)) {
        const usage = workflowUsage(tm.usage);
        yield {
          kind: "workflow_task",
          update: {
            taskId: tm.task_id,
            phase: "settled",
            ...(summary ? { summary } : {}),
            ...(usage ? { usage } : {}),
            outcome,
          },
        };
      }
      if (sub === "task_notification" || outcome) {
        yield { kind: "background_task", taskId: tm.task_id, status: "settled" };
      }
      if (sub === "task_notification") state.workflowTaskIds.delete(tm.task_id);
      return; // non-terminal task_updated patches (running/paused/description) are ignored
    }
    const push = classifySystemPush(msg);
    if (push) {
      yield { kind: "push", push };
      return;
    }
    // A system message carries info in its top-level text/subtype (extractText can't read it).
    const s = msg as { subtype?: string; text?: string };
    yield { kind: "system_text", text: s.text ?? s.subtype ?? "system" };
    return;
  }
  if (type === "tool_progress") {
    const tp = msg as { tool_use_id?: string; elapsed_time_seconds?: number };
    if (tp.tool_use_id) yield { kind: "tool_progress", toolUseId: tp.tool_use_id, elapsedSec: Math.round(tp.elapsed_time_seconds ?? 0) };
    return;
  }
  if (type === "result") {
    const r = msg as {
      subtype?: string;
      total_cost_usd?: number;
      num_turns?: number;
      session_id?: string;
      duration_ms?: number;
      terminal_reason?: string;
      usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
      modelUsage?: Record<string, { contextWindow?: number }>;
    };
    if (r.session_id) yield { kind: "session_id", sessionId: r.session_id };
    const { contextTokens, contextWindow } = turnContext(r, state.lastReqContextTokens);
    yield {
      kind: "turn_end",
      subtype: r.subtype ?? "unknown",
      costUsd: r.total_cost_usd ?? 0,
      numTurns: r.num_turns ?? 0,
      durationMs: r.duration_ms ?? 0,
      contextTokens,
      contextWindow,
      ...(r.terminal_reason ? { terminalReason: r.terminal_reason } : {}),
    };
  }
}

class ClaudeStream implements AgentStream {
  constructor(private readonly q: ReturnType<QueryFn>) {}

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    const state: DecodeState = { lastReqContextTokens: 0, workflowTaskIds: new Set() };
    for await (const msg of this.q) yield* translate(msg, state);
  }

  async interrupt(): Promise<InterruptReceipt | undefined> {
    // 0.3.205+: the control response is the interrupt receipt; older CLIs/fakes resolve void.
    const r = (await this.q.interrupt()) as { still_queued?: string[] } | undefined | void;
    const sq = r && typeof r === "object" ? r.still_queued : undefined;
    return Array.isArray(sq) ? { stillQueued: sq } : undefined;
  }

  // Optional live controls: fakes (and other providers) may lack them — mirror the old `this.query?.x` guards.
  async setModel(model: string): Promise<void> {
    await (this.q as { setModel?: (m: string) => Promise<void> }).setModel?.(model);
  }

  async setPermissionMode(mode: string): Promise<void> {
    await (this.q as { setPermissionMode?: (m: string) => Promise<void> }).setPermissionMode?.(mode);
  }

  async supportedCommands(): Promise<SlashCommandInfo[]> {
    const cmds = (await (this.q as { supportedCommands?: () => Promise<SlashCommandInfo[]> }).supportedCommands?.()) ?? [];
    return cmds.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint, aliases: c.aliases }));
  }
}

export class ClaudeBackend implements AgentBackend {
  constructor(
    private readonly queryFn: QueryFn,
    private readonly loadCapabilities?: LoadClaudeCapabilities,
  ) {}

  // Shared option assembly: effort gating (Haiku rejects effort — API 400), adaptive thinking display,
  // claude_code preset + append, token-level partial deltas, resume, abort.
  private baseOptions(opts: AgentSessionOptions): QueryOptions {
    if (opts.capabilities && !opts.runtimeKey) throw new Error("managed capabilities require a runtimeKey");
    const managed = opts.capabilities
      ? this.loadCapabilities?.(opts.capabilities)
      : undefined;
    if (opts.capabilities && !managed) throw new Error("Claude capability runtime is unavailable");
    const systemPromptAppend = [opts.systemPromptAppend, managed?.systemPromptAppend]
      .filter((value): value is string => Boolean(value))
      .join("\n\n");
    return {
      cwd: opts.cwd,
      model: opts.model,
      ...(effortApplies(opts.model) && coerceEffort(opts.effort) ? { effort: coerceEffort(opts.effort) } : {}),
      ...(effortApplies(opts.model) ? { thinking: { type: "adaptive" as const, display: "summarized" as const } } : {}),
      permissionMode: opts.permissionMode as QueryOptions["permissionMode"],
      systemPrompt: { type: "preset", preset: "claude_code", ...(systemPromptAppend ? { append: systemPromptAppend } : {}) },
      ...(managed?.plugins.length ? { plugins: managed.plugins } : {}),
      ...(managed && Object.keys(managed.env).length > 0 ? { env: { ...process.env, ...managed.env } } : {}),
      includePartialMessages: true,
      ...(opts.resume ? { resume: opts.resume } : {}),
      abortController: opts.abortController,
    };
  }

  openSession(input: AsyncIterable<string>, opts: AgentSessionOptions): AgentStream {
    const q = this.queryFn({
      prompt: claudeUserMessages(input),
      options: {
        ...this.baseOptions(opts),
        forwardSubagentText: true, // nested subagent text/tool activity → UI panels (streaming sessions only, as before)
      },
    });
    return new ClaudeStream(q);
  }

  startTurn(prompt: string, opts: MasterTurnOptions): AgentStream {
    const readOnlyAllowed = ["Read", "Glob", "Grep"];
    const readOnlyDenied = ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Task"];
    const q = this.queryFn({
      prompt,
      options: {
        ...this.baseOptions(opts),
        ...(opts.canUseTool ? { canUseTool: opts.canUseTool as QueryOptions["canUseTool"] } : {}),
        ...this.buildMcpServersOption(opts),
        ...(opts.readOnly ? { allowedTools: readOnlyAllowed } : opts.allowedTools ? { allowedTools: opts.allowedTools } : {}),
        ...(opts.readOnly ? { disallowedTools: readOnlyDenied } : opts.disallowedTools ? { disallowedTools: opts.disallowedTools } : {}),
      },
    });
    return new ClaudeStream(q);
  }

  // Wraps `opts.toolDefs` groups (the neutral port — see agent-backend.ts) with createSdkMcpServer,
  // one server per group name, so they surface on the SDK call exactly where the old inline
  // `mcpServers: { memory: createMemoryToolsServer(...), ... }` used to (byte-identical keys/instances).
  // Merge order: wrapped-defs first, then the opaque `opts.mcpServers` spread AFTER — per-source
  // overlays (e.g. the capabilities' schedule/slack servers) win on key collision.
  // When `toolDefs` is absent, `opts.mcpServers` (if any) passes through untouched — same identity
  // as before this refactor (no toolDefs path existed).
  // The "askUserQuestion" group (master-agent.ts, injected only when deps.canUseTool exists) is
  // deliberately SKIPPED here: Claude already gets AskUserQuestion natively via the harness's own
  // tool + canUseTool (see master-agent.ts's baseAllowed) — wrapping a second MCP tool of the same
  // name would confuse the model with a duplicate. The Codex adapter has no such native tool, so it
  // flattens every group (including askUserQuestion) into the bridge as-is (CodexBackend.startTurn).
  private buildMcpServersOption(opts: MasterTurnOptions): { mcpServers?: QueryOptions["mcpServers"] } {
    if (!opts.toolDefs) {
      return opts.mcpServers ? { mcpServers: opts.mcpServers as QueryOptions["mcpServers"] } : {};
    }
    const fromDefs = Object.fromEntries(
      Object.entries(opts.toolDefs)
        .filter(([name]) => name !== "askUserQuestion")
        .map(([name, defs]) => [name, createSdkMcpServer({ name, version: "0.0.1", tools: defs as SdkMcpToolDefinition[] })]),
    );
    return { mcpServers: { ...fromDefs, ...opts.mcpServers } as QueryOptions["mcpServers"] };
  }
}
