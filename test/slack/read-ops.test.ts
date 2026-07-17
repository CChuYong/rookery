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

  it("melts Block Kit blocks/attachments into the text (blocks-only bot card becomes visible)", () => {
    const out = repliesToThreadMsgs([
      {
        bot_id: "B1",
        ts: "1.0",
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "*Build failed* on main" } }],
        attachments: [{ pretext: "CI alert", text: "job #42 exited 1" }],
      },
    ]);
    expect(out[0]!.text).toContain("*Build failed* on main");
    expect(out[0]!.text).toContain("job #42 exited 1");
  });

  it("maps bot identity: bot_profile.name (username fallback) + isSelf via selfBotId", () => {
    const out = repliesToThreadMsgs([
      { bot_id: "B_SELF", text: "mine", ts: "1.0", bot_profile: { name: "rookery-app" } },
      { bot_id: "B_GH", text: "build failed", ts: "2.0", bot_profile: { name: "GitHub" } },
      { bot_id: "B_LEGACY", text: "alert", ts: "3.0", username: "nagios" },
      { bot_id: "B_BARE", text: "?", ts: "4.0" },
    ], "B_SELF");
    expect(out[0]).toMatchObject({ isBot: true, isSelf: true, name: "rookery-app" });
    expect(out[1]).toMatchObject({ isBot: true, name: "GitHub" });
    expect(out[1]!.isSelf).toBeUndefined();
    expect(out[2]).toMatchObject({ name: "nagios" });
    expect(out[3]!.name).toBeUndefined();
  });

  it("maps message files to ThreadMsg.files (id required, name/mimetype through)", () => {
    const out = repliesToThreadMsgs([
      { user: "U1", text: "screenshot", ts: "1.0", files: [
        { id: "F1", name: "shot.png", mimetype: "image/png" },
        { name: "no-id.txt" },
      ] },
    ]);
    expect(out[0]!.files).toEqual([{ id: "F1", name: "shot.png", mimetype: "image/png" }]);
  });
});

// Minimal fake WebClient: records calls, returns scripted responses.
function fakeClient(script: {
  replies?: unknown; history?: unknown; list?: unknown[]; user?: unknown; permalink?: string; fileInfo?: unknown;
}): { client: SlackReadClient; calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = { replies: [], history: [], list: [], userInfo: [], permalink: [], fileInfo: [] };
  const listPages = [...(script.list ?? [])];
  const client: SlackReadClient = {
    conversations: {
      replies: async (a) => { calls.replies!.push(a); return script.replies as never; },
      history: async (a) => { calls.history!.push(a); return script.history as never; },
      list: async (a) => { calls.list!.push(a); return (listPages.shift() ?? { channels: [] }) as never; },
    },
    users: { info: async (a) => { calls.userInfo!.push(a); return script.user as never; } },
    chat: { getPermalink: async (a) => { calls.permalink!.push(a); return { permalink: script.permalink } as never; } },
    files: { info: async (a) => { calls.fileInfo!.push(a); return (script.fileInfo ?? {}) as never; } },
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

  it("readThread enriches human author names via the resolver (one call, distinct ids) and marks self", async () => {
    const { client } = fakeClient({ replies: { messages: [
      { user: "U1", text: "hi", ts: "1.0" },
      { user: "U1", text: "again", ts: "2.0" },
      { bot_id: "B_SELF", text: "reply", ts: "3.0" },
    ] } });
    const resolveCalls: string[][] = [];
    const resolver = { resolve: async (_c: string[], users: string[]) => { resolveCalls.push(users); return { channels: {}, users: { U1: "clover" } }; } };
    const ops = makeSlackReadOps(client, undefined, { selfBotId: () => "B_SELF", resolver });
    const out = await ops.readThread("C1", "1.0");
    expect(resolveCalls).toEqual([["U1"]]); // distinct ids, single call
    expect(out[0]).toMatchObject({ user: "U1", name: "clover" });
    expect(out[2]).toMatchObject({ isBot: true, isSelf: true });
  });

  it("resolver failure leaves authors unnamed (best-effort)", async () => {
    const { client } = fakeClient({ history: { messages: [{ user: "U1", text: "hi", ts: "1.0" }] } });
    const resolver = { resolve: async () => { throw new Error("rate_limited"); } };
    const out = await makeSlackReadOps(client, undefined, { resolver }).readChannel("C1");
    expect(out[0]!.name).toBeUndefined();
  });

  it("downloadFile resolves files.info then hands the SlackFile to the injected downloader", async () => {
    const { client, calls } = fakeClient({ fileInfo: { file: {
      id: "F1", name: "shot.png", mimetype: "image/png",
      url_private_download: "https://files.slack.com/dl/F1", url_private: "https://files.slack.com/v/F1",
    } } });
    const downloaded: unknown[] = [];
    const download = async (f: unknown) => { downloaded.push(f); return "/tmp/rookery/F1/shot.png"; };
    const out = await makeSlackReadOps(client, download).downloadFile("F1");
    expect(calls.fileInfo).toEqual([{ file: "F1" }]);
    expect(downloaded).toEqual([{ id: "F1", name: "shot.png", mimetype: "image/png", urlPrivateDownload: "https://files.slack.com/dl/F1" }]);
    expect(out).toBe("/tmp/rookery/F1/shot.png");
  });

  it("downloadFile falls back to url_private when url_private_download is absent", async () => {
    const { client } = fakeClient({ fileInfo: { file: { id: "F2", url_private: "https://files.slack.com/v/F2" } } });
    const download = async (f: { urlPrivateDownload?: string }) => f.urlPrivateDownload ?? null;
    const out = await makeSlackReadOps(client, download).downloadFile("F2");
    expect(out).toBe("https://files.slack.com/v/F2");
  });

  it("downloadFile returns null when files.info has no file or no downloader is injected", async () => {
    const { client } = fakeClient({ fileInfo: {} });
    expect(await makeSlackReadOps(client, async () => "/x").downloadFile("F404")).toBeNull();
    const { client: c2 } = fakeClient({ fileInfo: { file: { id: "F1", url_private: "u" } } });
    expect(await makeSlackReadOps(c2).downloadFile("F1")).toBeNull();
  });
});
