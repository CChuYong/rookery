import type { WorkerEventData, CoreEvent } from "../core/events.js";

// Translate a worker's emitted event into the master-shaped CoreEvent that SlackThreadReporter already renders.
// This lets the worker→Slack relay reuse the reporter's per-turn chatStream + plan-card logic for the worker's
// thread. Returns null for kinds we don't relay: streaming deltas, thinking, tool progress, system/notice, and the
// user echo. (sessionId is only carried for shape-completeness — the reporter posts to its own fixed target.)
export function workerEventToCoreEvent(data: WorkerEventData, sessionId: string): CoreEvent | null {
  switch (data.kind) {
    case "message":
      if (data.role !== "assistant") return null; // skip the worker's user-message echo
      return { type: "master.message", sessionId, role: "assistant", content: data.content };
    case "tool_use":
      return { type: "master.tool", sessionId, toolId: data.id, name: data.name, phase: "start", input: data.input };
    case "tool_result":
      // name is only a fallback at "end" (the reporter reuses the title stored at "start"); pass the id so it's non-empty.
      return { type: "master.tool", sessionId, toolId: data.id, name: data.id, phase: "end", ok: !data.isError, result: data.content };
    case "result":
      return {
        type: "master.result", sessionId,
        subtype: data.subtype, costUsd: data.costUsd, numTurns: data.numTurns,
        durationMs: data.durationMs ?? 0, contextTokens: data.contextTokens ?? 0, contextWindow: data.contextWindow ?? 0,
      };
    case "error":
      return { type: "error", sessionId, message: data.message };
    default:
      return null; // message_delta · thinking · thinking_delta · tool_progress · system · notice
  }
}
