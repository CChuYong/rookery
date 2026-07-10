import type { QueryFn } from "../../src/core/claude-backend.js";
import { ClaudeBackend } from "../../src/core/claude-backend.js";
import type { AgentBackend } from "../../src/core/agent-backend.js";

// Minimal step that mimics the shape of an SDK message. Handles only assistant text/result.
export type FakeStep =
  // `parent_tool_use_id` (snake_case) is a verbatim pass-through of the SDK field for nested-subagent traffic tests; `parentToolUseId` (camelCase) is the pre-existing alias.
  | { type: "assistant"; text: string; parentToolUseId?: string; parent_tool_use_id?: string | null }
  // Text block carried in a user-type message — not typed by a human but text injected by the SDK (skill body/context). For bug reproduction.
  | { type: "user_text"; text: string; parentToolUseId?: string }
  | { type: "system"; text: string }
  // stream_event(thinking_delta): a thinking-summary delta. Streams live and is persisted coalesced at step boundaries.
  | { type: "thinking"; text: string }
  // stream_event(message_start): per-request usage for a single model call. The source for computing context %.
  | { type: "message_start"; usage: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }
  | { type: "tool_use"; id: string; name: string; input?: unknown; parentToolUseId?: string }
  | { type: "tool_result"; id: string; isError?: boolean; content?: string; parentToolUseId?: string }
  // Background-task lifecycle frames (system subtype task_* — live-verified shapes, probe-turn-lifecycle.mjs 2026-07-11).
  | { type: "task_started"; id: string; taskType?: string }
  | { type: "task_updated"; id: string; status: string } // patch.status: completed/failed/killed settle; running/paused ignored
  | { type: "task_notification"; id: string; status?: string }
  | { type: "task_progress"; id: string }
  | {
      type: "result";
      subtype: string;
      total_cost_usd: number;
      num_turns: number;
      session_id: string;
      duration_ms?: number;
      terminal_reason?: string;
      usage?: Record<string, number>;
      modelUsage?: Record<string, { contextWindow: number }>;
    };

// Convert a single FakeStep into an SDK message shape (shared by fakeQuery/fakeStreamingQuery).
function stepToMessage(step: FakeStep): unknown {
  if (step.type === "assistant") {
    return { type: "assistant", parent_tool_use_id: step.parent_tool_use_id ?? step.parentToolUseId ?? null, message: { role: "assistant", content: [{ type: "text", text: step.text }] } };
  } else if (step.type === "user_text") {
    return { type: "user", parent_tool_use_id: step.parentToolUseId ?? null, message: { role: "user", content: [{ type: "text", text: step.text }] } };
  } else if (step.type === "system") {
    return { type: "system", subtype: "init", text: step.text };
  } else if (step.type === "thinking") {
    return { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: step.text } } };
  } else if (step.type === "message_start") {
    return { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { usage: step.usage } } };
  } else if (step.type === "tool_use") {
    return { type: "assistant", parent_tool_use_id: step.parentToolUseId ?? null, message: { role: "assistant", content: [{ type: "tool_use", id: step.id, name: step.name, input: step.input ?? {} }] } };
  } else if (step.type === "tool_result") {
    return { type: "user", parent_tool_use_id: step.parentToolUseId ?? null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: step.id, is_error: step.isError ?? false, ...(step.content !== undefined ? { content: step.content } : {}) }] } };
  } else if (step.type === "task_started") {
    return { type: "system", subtype: "task_started", task_id: step.id, ...(step.taskType ? { task_type: step.taskType } : {}) };
  } else if (step.type === "task_updated") {
    return { type: "system", subtype: "task_updated", task_id: step.id, patch: { status: step.status } };
  } else if (step.type === "task_notification") {
    return { type: "system", subtype: "task_notification", task_id: step.id, status: step.status ?? "completed" };
  } else if (step.type === "task_progress") {
    return { type: "system", subtype: "task_progress", task_id: step.id };
  }
  return {
    type: "result",
    subtype: step.subtype,
    total_cost_usd: step.total_cost_usd,
    num_turns: step.num_turns,
    session_id: step.session_id,
    ...(step.duration_ms !== undefined ? { duration_ms: step.duration_ms } : {}),
    ...(step.terminal_reason ? { terminal_reason: step.terminal_reason } : {}),
    ...(step.usage ? { usage: step.usage } : {}),
    ...(step.modelUsage ? { modelUsage: step.modelUsage } : {}),
  };
}

// Finite fake: runs through the script once and the generator terminates (for the master's single-shot turn / simple cases).
export function fakeQuery(
  script: FakeStep[],
  opts?: {
    commands?: Array<{ name: string; description: string; argumentHint?: string; aliases?: string[] }>;
    onSetModel?: (model: string) => void;
    onSetPermissionMode?: (mode: string) => void;
  },
): QueryFn {
  const fn = ((_input: unknown) => {
    async function* gen() {
      for (const step of script) yield stepToMessage(step);
    }
    const iterator = gen();
    return Object.assign(iterator, {
      interrupt: async () => {},
      close: () => {},
      supportedCommands: async () => opts?.commands ?? [],
      setModel: async (model: string) => opts?.onSetModel?.(model),
      setPermissionMode: async (mode: string) => opts?.onSetPermissionMode?.(mode),
    });
  }) as unknown as QueryFn;
  return fn;
}

// Faithful reproduction of the streaming-input SDK: for each input (MessageQueue) message, yield the steps the responder gives,
// and the generator stays alive until the input is closed (= the worker's stop). It exposes verbatim the "stay idle after a turn"
// lifecycle that the finite fakeQuery hides (for worker tests; for the master's string prompt it terminates empty immediately).
export function fakeStreamingQuery(responder: (userText: string, turn: number) => FakeStep[]): QueryFn {
  const fn = ((input: { prompt?: unknown; options?: { abortController?: AbortController } }) => {
    const prompt = input?.prompt as AsyncIterable<{ message?: { content?: unknown } }> | undefined;
    const signal = input?.options?.abortController?.signal;
    async function* gen() {
      const asyncIter = (prompt as { [Symbol.asyncIterator]?: unknown } | undefined)?.[Symbol.asyncIterator];
      if (typeof asyncIter !== "function") return; // string prompt (master) → not a target of this fake
      let turn = 0;
      for await (const userMsg of prompt as AsyncIterable<{ message?: { content?: unknown } }>) {
        if (signal?.aborted) return;
        const c = userMsg?.message?.content;
        const text = typeof c === "string" ? c : "";
        for (const step of responder(text, turn)) yield stepToMessage(step);
        turn++;
      }
    }
    const iterator = gen();
    return Object.assign(iterator, {
      interrupt: async () => {},
      close: () => {},
      supportedCommands: async () => [],
    });
  }) as unknown as QueryFn;
  return fn;
}

// Port-level fakes: the same scripts, driven through the real ClaudeBackend adapter — worker/master tests
// exercise consumer+adapter together (equivalent coverage to the old direct-queryFn injection).
export function fakeBackend(script: FakeStep[], opts?: Parameters<typeof fakeQuery>[1]): AgentBackend {
  return new ClaudeBackend(fakeQuery(script, opts));
}
export function fakeStreamingBackend(responder: (userText: string, turn: number) => FakeStep[]): AgentBackend {
  return new ClaudeBackend(fakeStreamingQuery(responder));
}
