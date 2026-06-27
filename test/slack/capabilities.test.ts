import { describe, it, expect } from "vitest";
import { makeSlackCapabilities, SLACK_THREAD_HINT } from "../../src/slack/capabilities.js";

const noReader = () => null;

describe("makeSlackCapabilities", () => {
  it("returns a capability resolver for a slack thread key (read_thread tool + hint)", () => {
    const resolve = makeSlackCapabilities("slack:T1:C1:1700.1", noReader);
    expect(resolve).toBeTypeOf("function");
    const caps = resolve!();
    expect(Object.keys(caps.mcpServers ?? {})).toContain("slack");
    expect(caps.allowedTools).toContain("mcp__slack__read_thread");
    expect(caps.systemPromptAppend).toBe(SLACK_THREAD_HINT);
  });

  it("returns undefined for non-slack sessions", () => {
    expect(makeSlackCapabilities(null, noReader)).toBeUndefined();
    expect(makeSlackCapabilities("thread-1", noReader)).toBeUndefined();
    expect(makeSlackCapabilities("ui:fleet", noReader)).toBeUndefined();
  });
});
