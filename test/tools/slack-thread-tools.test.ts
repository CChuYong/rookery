import { describe, it, expect } from "vitest";
import {
  readThreadImpl, SLACK_THREAD_TOOL_NAMES, SLACK_THREAD_SERVER_NAME,
  slackThreadToolDefs, createSlackThreadToolsServer,
} from "../../src/tools/slack-thread-tools.js";
import type { ThreadMsg, SlackThreadReader } from "../../src/tools/slack-thread-tools.js";

const reader = (msgs: ThreadMsg[]): SlackThreadReader => async () => msgs;

describe("readThreadImpl", () => {
  it("formats the thread with author labels (user vs bot)", async () => {
    const r = reader([
      { user: "U1", text: "배포가 실패해요", isBot: false, ts: "1.0" },
      { user: "UBOT", text: "원인을 찾아볼게요", isBot: true, ts: "2.0" },
      { user: "U2", text: "어제 그 PR 이후부터요", isBot: false, ts: "3.0" },
    ]);
    const out = await readThreadImpl(() => r, "C1", "1.0");
    expect(out.isError).toBeFalsy();
    expect(out.text).toContain("<@U1>: 배포가 실패해요");
    expect(out.text).toContain("rookery(bot): 원인을 찾아볼게요");
    expect(out.text).toContain("<@U2>: 어제 그 PR 이후부터요");
  });

  it("returns an unavailable message when the reader holder is empty (Slack disconnected)", async () => {
    const out = await readThreadImpl(() => null, "C1", "1.0");
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/Slack/);
  });

  it("returns an error string when the reader throws", async () => {
    const throwing: SlackThreadReader = async () => { throw new Error("missing_scope"); };
    const out = await readThreadImpl(() => throwing, "C1", "1.0");
    expect(out.isError).toBe(true);
    expect(out.text).toContain("missing_scope");
  });

  it("skips empty-text messages and reports an empty thread", async () => {
    const out = await readThreadImpl(() => reader([{ user: "U1", text: "   ", isBot: false, ts: "1.0" }]), "C1", "1.0");
    expect(out.text).toMatch(/메시지가 없|no messages/i);
  });

  it("budgets a long thread (keeps the most recent messages, byte-capped)", async () => {
    const many: ThreadMsg[] = Array.from({ length: 200 }, (_v, i) => ({ user: `U${i}`, text: `msg ${i} ${"x".repeat(200)}`, isBot: false, ts: `${i}.0` }));
    const out = await readThreadImpl(() => reader(many), "C1", "1.0");
    // most recent messages are included, total size is capped (far below the full ~40000 chars)
    expect(out.text).toContain("msg 199");
    expect(out.text).not.toContain("msg 0 ");
    expect(out.text.length).toBeLessThan(12000);
  });

  it("exposes the tool name in sync with the server name (convention)", () => {
    expect(SLACK_THREAD_TOOL_NAMES).toEqual([`mcp__${SLACK_THREAD_SERVER_NAME}__read_thread`]);
  });
});

// Task 3 (P2.5 Track C): slackThreadToolDefs is the raw-defs extraction (mirrors scheduleToolDefs) —
// travels the provider-neutral toolDefs port so a codex slack session gets read_thread over the bridge.
describe("slackThreadToolDefs", () => {
  it("returns one def named read_thread with an empty inputSchema", () => {
    const defs = slackThreadToolDefs(() => null, "C1", "1.0");
    expect(defs).toHaveLength(1);
    expect(defs[0]!.name).toBe("read_thread");
    expect(defs[0]!.inputSchema).toEqual({});
  });

  it("the def's handler calls through to readThreadImpl (reader/channel/threadTs bound)", async () => {
    const r = reader([{ user: "U1", text: "hello", isBot: false, ts: "1.0" }]);
    const defs = slackThreadToolDefs(() => r, "C1", "1.0");
    const out = await defs[0]!.handler({}, undefined);
    expect(out.content).toEqual([{ type: "text", text: "<@U1>: hello" }]);
    expect(out.isError).toBeUndefined();
  });

  it("the def's handler surfaces isError on failure (disconnected reader)", async () => {
    const defs = slackThreadToolDefs(() => null, "C1", "1.0");
    const out = await defs[0]!.handler({}, undefined);
    expect(out.isError).toBe(true);
  });
});

describe("createSlackThreadToolsServer", () => {
  it("wraps slackThreadToolDefs into an SDK server under SLACK_THREAD_SERVER_NAME (byte-parity with the pre-extraction shape)", () => {
    const s = createSlackThreadToolsServer(() => null, "C1", "1.0");
    expect(s.name).toBe(SLACK_THREAD_SERVER_NAME);
    expect(s.instance).toBeDefined();
  });
});
