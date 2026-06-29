import { describe, it, expect } from "vitest";
import { workerEventToCoreEvent } from "../../src/slack/worker-event-to-core.js";
import type { WorkerEventData } from "../../src/core/events.js";

const S = "sess-1";

describe("workerEventToCoreEvent", () => {
  it("assistant message → master.message", () => {
    expect(workerEventToCoreEvent({ kind: "message", role: "assistant", content: "hi" }, S))
      .toEqual({ type: "master.message", sessionId: S, role: "assistant", content: "hi" });
  });
  it("user message → null (no echo)", () => {
    expect(workerEventToCoreEvent({ kind: "message", role: "user", content: "x" }, S)).toBeNull();
  });
  it("tool_use → master.tool start", () => {
    expect(workerEventToCoreEvent({ kind: "tool_use", id: "t1", name: "Edit", input: "foo.ts" }, S))
      .toEqual({ type: "master.tool", sessionId: S, toolId: "t1", name: "Edit", phase: "start", input: "foo.ts" });
  });
  it("tool_result → master.tool end (ok = !isError)", () => {
    expect(workerEventToCoreEvent({ kind: "tool_result", id: "t1", isError: false, content: "done" }, S))
      .toEqual({ type: "master.tool", sessionId: S, toolId: "t1", name: "t1", phase: "end", ok: true, result: "done" });
    expect(workerEventToCoreEvent({ kind: "tool_result", id: "t2", isError: true, content: "boom" }, S))
      .toMatchObject({ phase: "end", ok: false, result: "boom" });
  });
  it("result → master.result (with defaults for optional fields)", () => {
    expect(workerEventToCoreEvent({ kind: "result", subtype: "success", costUsd: 0.1, numTurns: 3 }, S))
      .toEqual({ type: "master.result", sessionId: S, subtype: "success", costUsd: 0.1, numTurns: 3, durationMs: 0, contextTokens: 0, contextWindow: 0 });
  });
  it("error → error", () => {
    expect(workerEventToCoreEvent({ kind: "error", message: "nope" }, S)).toEqual({ type: "error", sessionId: S, message: "nope" });
  });
  it("excluded kinds → null", () => {
    const excluded: WorkerEventData[] = [
      { kind: "message_delta", text: "x" },
      { kind: "thinking_delta", text: "x" },
      { kind: "thinking", text: "x" },
      { kind: "tool_progress", id: "t", elapsedSec: 1 },
      { kind: "system", text: "x" },
      { kind: "notice", text: "x" },
    ];
    for (const d of excluded) expect(workerEventToCoreEvent(d, S)).toBeNull();
  });
});
