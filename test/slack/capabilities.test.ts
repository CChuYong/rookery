import { describe, it, expect } from "vitest";
import { makeSlackCapabilities, SLACK_THREAD_HINT } from "../../src/slack/capabilities.js";
import { SLACK_THREAD_SERVER_NAME } from "../../src/tools/slack-thread-tools.js";

const noReader = () => null;

describe("makeSlackCapabilities", () => {
  // Task 3 (P2.5 Track C): read_thread now travels via caps.toolDefs (the provider-neutral port), not
  // an opaque caps.mcpServers entry — so a codex slack session's master turn flattens it onto the MCP
  // bridge the same way it does memory/repos/fleet/schedule (master-agent.ts's toolDefs merge already
  // handles this generically; see test/core/master-capabilities.test.ts's toolDefs-merge coverage).
  it("returns a capability resolver for a slack thread key (read_thread tool via toolDefs + hint)", () => {
    const resolve = makeSlackCapabilities("slack:T1:C1:1700.1", noReader);
    expect(resolve).toBeTypeOf("function");
    const caps = resolve!();
    expect(caps.mcpServers).toBeUndefined(); // no longer an opaque mcpServers entry
    expect(Object.keys(caps.toolDefs ?? {})).toContain(SLACK_THREAD_SERVER_NAME);
    expect(caps.toolDefs?.[SLACK_THREAD_SERVER_NAME]?.map((d) => d.name)).toEqual(["read_thread"]);
    expect(caps.allowedTools).toContain("mcp__slack__read_thread");
    expect(caps.systemPromptAppend).toBe(SLACK_THREAD_HINT);
  });

  it("returns undefined for non-slack sessions", () => {
    expect(makeSlackCapabilities(null, noReader)).toBeUndefined();
    expect(makeSlackCapabilities("thread-1", noReader)).toBeUndefined();
    expect(makeSlackCapabilities("ui:fleet", noReader)).toBeUndefined();
  });
});
