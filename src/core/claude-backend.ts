import { query as sdkQuery, createSdkMcpServer, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { AgentBackend, AgentEvent, AgentSessionOptions, AgentStream, MasterTurnOptions, SlashCommandInfo } from "./agent-backend.js";
import { extractText, extractToolUses, extractToolResults } from "./sdk-extract.js";
import { classifySystemPush } from "./system-push.js";
import { turnContext } from "./result-telemetry.js";
import { effortApplies, coerceEffort } from "./effort.js";

// The Claude Agent SDK query() signature — the adapter's own contract (canonical home; formerly worker.ts).
// Injected at the composition root (real sdkQuery in the daemon, fakeQuery in tests). Claude-specific
// aux paths that bypass the port (labeler, CommandCatalog probe) consume this type directly.
export type QueryFn = typeof sdkQuery;
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
    return;
  }
  // Nested system/tool_progress/result never touch the parent session (both consumers skipped these).
  if (parentId) return;
  if (type === "system") {
    // Emit the session id EARLY (init) — an interrupt before the first result must not orphan resume.
    const sysSessionId = (msg as { session_id?: string }).session_id;
    if (sysSessionId) yield { kind: "session_id", sessionId: sysSessionId };
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
    };
  }
}

class ClaudeStream implements AgentStream {
  constructor(private readonly q: ReturnType<QueryFn>) {}

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    const state: DecodeState = { lastReqContextTokens: 0 };
    for await (const msg of this.q) yield* translate(msg, state);
  }

  async interrupt(): Promise<void> {
    await this.q.interrupt();
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
  constructor(private readonly queryFn: QueryFn) {}

  // Shared option assembly: effort gating (Haiku rejects effort — API 400), adaptive thinking display,
  // claude_code preset + append, token-level partial deltas, resume, abort.
  private baseOptions(opts: AgentSessionOptions): QueryOptions {
    return {
      cwd: opts.cwd,
      model: opts.model,
      ...(effortApplies(opts.model) && coerceEffort(opts.effort) ? { effort: coerceEffort(opts.effort) } : {}),
      ...(effortApplies(opts.model) ? { thinking: { type: "adaptive" as const, display: "summarized" as const } } : {}),
      permissionMode: opts.permissionMode as QueryOptions["permissionMode"],
      systemPrompt: { type: "preset", preset: "claude_code", ...(opts.systemPromptAppend ? { append: opts.systemPromptAppend } : {}) },
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
    const q = this.queryFn({
      prompt,
      options: {
        ...this.baseOptions(opts),
        ...(opts.canUseTool ? { canUseTool: opts.canUseTool as QueryOptions["canUseTool"] } : {}),
        ...this.buildMcpServersOption(opts),
        ...(opts.allowedTools ? { allowedTools: opts.allowedTools } : {}),
        ...(opts.disallowedTools ? { disallowedTools: opts.disallowedTools } : {}),
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
