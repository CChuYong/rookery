import { describe, it, expect } from "vitest";
import { repliesToThreadMsgs, makeSlackReadOps } from "../../src/slack/read-ops.js";
import type { SlackReadClient } from "../../src/slack/read-ops.js";

describe("repliesToThreadMsgs", () => {
  it("maps Slack replies to ThreadMsg (user/text/ts) and flags bot messages by bot_id", () => {
    const out = repliesToThreadMsgs([
      { user: "U1", text: "배포 실패", ts: "1.0" },
      { bot_id: "B1", text: "원인 찾을게요", ts: "2.0" },
    ]);
    expect(out).toEqual([
      { user: "U1", text: "배포 실패", isBot: false, ts: "1.0" },
      { user: "B1", text: "원인 찾을게요", isBot: true, ts: "2.0" },
    ]);
  });

  it("tolerates missing fields", () => {
    const out = repliesToThreadMsgs([{ ts: "3.0" }]);
    expect(out[0]).toMatchObject({ text: "", isBot: false, ts: "3.0" });
    expect(typeof out[0]!.user).toBe("string");
  });
});

// Minimal fake WebClient: records calls, returns scripted responses.
function fakeClient(script: {
  replies?: unknown; history?: unknown; list?: unknown[]; user?: unknown; permalink?: string;
}): { client: SlackReadClient; calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = { replies: [], history: [], list: [], userInfo: [], permalink: [] };
  const listPages = [...(script.list ?? [])];
  const client: SlackReadClient = {
    conversations: {
      replies: async (a) => { calls.replies!.push(a); return script.replies as never; },
      history: async (a) => { calls.history!.push(a); return script.history as never; },
      list: async (a) => { calls.list!.push(a); return (listPages.shift() ?? { channels: [] }) as never; },
    },
    users: { info: async (a) => { calls.userInfo!.push(a); return script.user as never; } },
    chat: { getPermalink: async (a) => { calls.permalink!.push(a); return { permalink: script.permalink } as never; } },
  };
  return { client, calls };
}

describe("makeSlackReadOps", () => {
  it("readThread calls conversations.replies with limit 100", async () => {
    const { client, calls } = fakeClient({ replies: { messages: [{ user: "U1", text: "hi", ts: "1.0" }] } });
    const out = await makeSlackReadOps(client).readThread("C1", "1.0");
    expect(calls.replies).toEqual([{ channel: "C1", ts: "1.0", limit: 100 }]);
    expect(out).toEqual([{ user: "U1", text: "hi", isBot: false, ts: "1.0" }]);
  });

  it("readChannel calls conversations.history and returns chronological order (Slack returns newest first)", async () => {
    const { client, calls } = fakeClient({ history: { messages: [
      { user: "U2", text: "newer", ts: "2.0" },
      { user: "U1", text: "older", ts: "1.0" },
    ] } });
    const out = await makeSlackReadOps(client).readChannel("C1", 10);
    expect(calls.history).toEqual([{ channel: "C1", limit: 10 }]);
    expect(out.map((m) => m.text)).toEqual(["older", "newer"]);
  });

  it("listChannels paginates, keeps only bot-member channels, maps topic/isPrivate", async () => {
    const { client } = fakeClient({ list: [
      { channels: [
        { id: "C1", name: "general", is_member: true, topic: { value: "all hands" } },
        { id: "C2", name: "random", is_member: false },
      ], response_metadata: { next_cursor: "page2" } },
      { channels: [{ id: "G1", name: "secret", is_member: true, is_private: true }] },
    ] });
    const out = await makeSlackReadOps(client).listChannels();
    expect(out).toEqual([
      { id: "C1", name: "general", topic: "all hands", isPrivate: false },
      { id: "G1", name: "secret", topic: undefined, isPrivate: true },
    ]);
  });

  it("userInfo maps profile fields and prefers display_name", async () => {
    const { client } = fakeClient({ user: { user: {
      name: "ym", real_name: "YeongMin", tz: "Asia/Seoul",
      profile: { display_name: "clover", real_name: "YeongMin Song", title: "Engineer" },
    } } });
    const out = await makeSlackReadOps(client).userInfo("U1");
    expect(out).toEqual({ id: "U1", displayName: "clover", realName: "YeongMin Song", title: "Engineer", tz: "Asia/Seoul" });
  });

  it("userInfo returns null when the API has no user", async () => {
    const { client } = fakeClient({ user: {} });
    expect(await makeSlackReadOps(client).userInfo("U404")).toBeNull();
  });

  it("permalink maps to chat.getPermalink (message_ts)", async () => {
    const { client, calls } = fakeClient({ permalink: "https://x.slack.com/p1" });
    const out = await makeSlackReadOps(client).permalink("C1", "1.0");
    expect(calls.permalink).toEqual([{ channel: "C1", message_ts: "1.0" }]);
    expect(out).toBe("https://x.slack.com/p1");
  });
});
