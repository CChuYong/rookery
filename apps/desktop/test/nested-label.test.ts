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
