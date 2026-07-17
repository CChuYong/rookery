import { describe, it, expect } from "vitest";
import { makeSlackCapabilities, SLACK_THREAD_HINT } from "../../src/slack/capabilities.js";
import { SLACK_SERVER_NAME, SLACK_TOOL_NAMES } from "../../src/tools/slack-tools.js";

const noOps = () => null;

describe("makeSlackCapabilities", () => {
  // read tools travel via caps.toolDefs (the provider-neutral port), not an opaque caps.mcpServers
  // entry — so a codex slack session's master turn flattens them onto the MCP bridge the same way it
  // does memory/repos/fleet/schedule (see test/core/master-capabilities.test.ts's toolDefs coverage).
  it("returns a capability resolver for a slack thread key (five read tools via toolDefs + hint)", () => {
    const resolve = makeSlackCapabilities("slack:T1:C1:1700.1", noOps);
    expect(resolve).toBeTypeOf("function");
    const caps = resolve!();
    expect(caps.mcpServers).toBeUndefined(); // no opaque mcpServers entry
    expect(Object.keys(caps.toolDefs ?? {})).toContain(SLACK_SERVER_NAME);
    expect(caps.toolDefs?.[SLACK_SERVER_NAME]?.map((d) => d.name)).toEqual([
      "read_thread", "read_channel", "list_channels", "get_user_info", "get_permalink", "download_file",
    ]);
    expect(caps.allowedTools).toEqual([...SLACK_TOOL_NAMES]);
    expect(caps.systemPromptAppend).toBe(SLACK_THREAD_HINT);
  });

  it("threads getName through to the defs (bot label uses the configured agent name)", async () => {
    const ops = {
      readThread: async () => [{ user: "B1", text: "hello from bot", isBot: true, isSelf: true, ts: "1.0" }],
      readChannel: async () => [], listChannels: async () => [], userInfo: async () => null,
      permalink: async () => null, downloadFile: async () => null,
    };
    const resolve = makeSlackCapabilities("slack:T1:C1:1700.1", () => ops, () => "제니")!;
    const readThread = resolve().toolDefs?.[SLACK_SERVER_NAME]?.[0];
    const out = await readThread!.handler({}, undefined);
    expect((out.content as { text: string }[])[0]!.text).toContain("제니(bot): hello from bot");
  });

  it("returns undefined for non-slack sessions", () => {
    expect(makeSlackCapabilities(null, noOps)).toBeUndefined();
    expect(makeSlackCapabilities("thread-1", noOps)).toBeUndefined();
    expect(makeSlackCapabilities("ui:fleet", noOps)).toBeUndefined();
  });
});
