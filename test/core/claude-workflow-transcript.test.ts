import { describe, expect, it } from "vitest";
import {
  parseWorkflowAgentHistory,
  parseWorkflowAgentLine,
  parseWorkflowAgentMeta,
  parseWorkflowJournalLine,
  parseWorkflowProgress,
  parseWorkflowRunState,
} from "../../src/core/claude-workflow-transcript.js";

describe("Claude Dynamic Workflow transcript decoding", () => {
  it("accepts only bounded safe started/result journal records", () => {
    expect(parseWorkflowJournalLine('{"type":"started","agentId":"a1","key":"k"}')).toEqual({ type: "started", agentId: "a1" });
    expect(parseWorkflowJournalLine('{"type":"result","agentId":"a1","key":"k","result":{"ok":true}}')).toEqual({ type: "result", agentId: "a1" });
    expect(parseWorkflowJournalLine('{"type":"started","agentId":"../../escape","key":"k"}')).toBeNull();
    expect(parseWorkflowJournalLine("not-json")).toBeNull();
    expect(parseWorkflowJournalLine("x".repeat(1_048_577))).toBeNull();
  });

  it("reads metadata defensively", () => {
    expect(parseWorkflowAgentMeta('{"agentType":"workflow-subagent","spawnDepth":2}')).toEqual({ agentType: "workflow-subagent", spawnDepth: 2 });
    expect(parseWorkflowAgentMeta('{"agentType":7,"spawnDepth":-1}')).toEqual({ agentType: "workflow-subagent", spawnDepth: 1 });
  });

  it("extracts only bounded phase and agent identity metadata from run state", () => {
    const parsed = parseWorkflowRunState(JSON.stringify({
      phases: [
        { title: "Recon", detail: "Inspect the code", model: "opus", secret: "drop-me" },
        { title: "Judge" },
        { title: 7 },
      ],
      workflowProgress: [
        { type: "workflow_phase", index: 1, title: "Recon" },
        { type: "workflow_agent", agentId: "a1", label: "code:core", phaseIndex: 1, phaseTitle: "Recon", model: "claude-opus-4-8", state: "progress", promptPreview: "drop-me" },
        { type: "workflow_agent", agentId: "a1", label: "code:core:new", phaseIndex: 1, phaseTitle: "Recon", model: "claude-opus-4-8", state: "done", resultPreview: "drop-me" },
        { type: "workflow_agent", agentId: "../../escape", label: "bad", phaseIndex: 2, phaseTitle: "Judge" },
      ],
      script: "drop-me",
      logs: ["drop-me"],
      result: { secret: "drop-me" },
    }));

    expect(parsed).toEqual({
      phases: [
        { index: 1, title: "Recon", detail: "Inspect the code", model: "opus" },
        { index: 2, title: "Judge" },
      ],
      agents: [
        { agentId: "a1", label: "code:core:new", phaseIndex: 1, phaseTitle: "Recon", model: "claude-opus-4-8" },
      ],
    });
    expect(JSON.stringify(parsed)).not.toContain("drop-me");
  });

  it("extracts live phase grouping from raw workflow progress without content", () => {
    const parsed = parseWorkflowProgress([
      { type: "workflow_phase", index: 1, title: "Recon", kind: "parallel" },
      { type: "workflow_phase", index: 2, title: "Judge" },
      { type: "workflow_agent", agentId: "a1", label: "code:core", phaseIndex: 1, phaseTitle: "Recon", model: "claude-opus-4-8", state: "start", promptPreview: "drop-me" },
      { type: "workflow_agent", agentId: "a1", label: "code:core:live", phaseIndex: 1, phaseTitle: "Recon", model: "claude-opus-4-8", state: "progress", lastToolSummary: "drop-me" },
      { type: "workflow_agent", agentId: "../../escape", label: "bad", phaseIndex: 2, phaseTitle: "Judge", resultPreview: "drop-me" },
    ]);

    expect(parsed).toEqual({
      phases: [
        { index: 1, title: "Recon" },
        { index: 2, title: "Judge" },
      ],
      agents: [
        { agentId: "a1", label: "code:core:live", phaseIndex: 1, phaseTitle: "Recon", model: "claude-opus-4-8" },
      ],
    });
    expect(JSON.stringify(parsed)).not.toContain("drop-me");
  });

  it("derives overview activity without exposing content", () => {
    expect(parseWorkflowAgentLine('{"timestamp":"2026-07-16T00:00:00.000Z","type":"assistant","attributionAgent":"workflow-subagent","message":{"role":"assistant","content":[{"type":"thinking","thinking":"secret"}]}}')).toEqual({ at: Date.parse("2026-07-16T00:00:00.000Z"), activity: "thinking", agentType: "workflow-subagent", toolUses: 0 });
    expect(parseWorkflowAgentLine('{"timestamp":"2026-07-16T00:00:01.000Z","type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/secret"}}]}}')).toEqual({ at: Date.parse("2026-07-16T00:00:01.000Z"), activity: "tool", lastToolName: "Read", toolUses: 1 });
  });

  it("turns selected history into capped WorkerEventData", () => {
    const long = "x".repeat(5_000);
    const jsonl = [
      JSON.stringify({ timestamp: "2026-07-16T00:00:00.000Z", type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "reason" }] } }),
      JSON.stringify({ timestamp: "2026-07-16T00:00:01.000Z", type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: long } }] } }),
      JSON.stringify({ timestamp: "2026-07-16T00:00:02.000Z", type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: long }] } }),
      JSON.stringify({ timestamp: "2026-07-16T00:00:03.000Z", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
    ].join("\n");
    const events = parseWorkflowAgentHistory(jsonl);
    expect(events).toHaveLength(4);
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
