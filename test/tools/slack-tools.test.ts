import { describe, it, expect } from "vitest";
import {
  readThreadImpl, readChannelImpl, listChannelsImpl, userInfoImpl, permalinkImpl,
  SLACK_TOOL_NAMES, SLACK_SERVER_NAME, slackToolDefs, createSlackToolsServer,
} from "../../src/tools/slack-tools.js";
import type { ThreadMsg, SlackReadOps } from "../../src/tools/slack-tools.js";

// Fake ops: every method throws unless overridden — tests state exactly what they use.
function fakeOps(over: Partial<SlackReadOps>): SlackReadOps {
  const nope = (name: string) => async () => { throw new Error(`unexpected call: ${name}`); };
  return {
    readThread: over.readThread ?? nope("readThread"),
    readChannel: over.readChannel ?? nope("readChannel"),
    listChannels: over.listChannels ?? nope("listChannels"),
    userInfo: over.userInfo ?? nope("userInfo"),
    permalink: over.permalink ?? nope("permalink"),
  };
}
const msgs = (m: ThreadMsg[]) => async () => m;

describe("readThreadImpl", () => {
  it("formats the thread with author labels (user vs bot)", async () => {
    const ops = fakeOps({ readThread: msgs([
      { user: "U1", text: "배포가 실패해요", isBot: false, ts: "1.0" },
      { user: "UBOT", text: "원인을 찾아볼게요", isBot: true, ts: "2.0" },
    ]) });
    const out = await readThreadImpl(() => ops, "C1", "1.0");
    expect(out.isError).toBeFalsy();
    expect(out.text).toContain("<@U1>: 배포가 실패해요");
    expect(out.text).toContain("rookery(bot): 원인을 찾아볼게요");
  });

  it("returns an unavailable message when the ops holder is empty (Slack disconnected)", async () => {
    const out = await readThreadImpl(() => null, "C1", "1.0");
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/Slack/);
  });

  it("returns an error string when the reader throws", async () => {
    const ops = fakeOps({ readThread: async () => { throw new Error("missing_scope"); } });
    const out = await readThreadImpl(() => ops, "C1", "1.0");
    expect(out.isError).toBe(true);
    expect(out.text).toContain("missing_scope");
  });

  it("budgets a long thread (keeps the most recent messages, byte-capped)", async () => {
    const many: ThreadMsg[] = Array.from({ length: 200 }, (_v, i) => ({ user: `U${i}`, text: `msg ${i} ${"x".repeat(200)}`, isBot: false, ts: `${i}.0` }));
    const out = await readThreadImpl(() => fakeOps({ readThread: msgs(many) }), "C1", "1.0");
    expect(out.text).toContain("msg 199");
    expect(out.text).not.toContain("msg 0 ");
    expect(out.text.length).toBeLessThan(12000);
  });
});

describe("readChannelImpl", () => {
  it("reads a channel by id (recent history transcript)", async () => {
    const ops = fakeOps({ readChannel: async (ch, limit) => {
      expect(ch).toBe("C42");
      expect(limit).toBe(30);
      return [{ user: "U1", text: "incident update", isBot: false, ts: "1.0" }];
    } });
    const out = await readChannelImpl(() => ops, { channel: "C42" });
    expect(out.isError).toBeFalsy();
    expect(out.text).toContain("<@U1>: incident update");
  });

  it("resolves a #name via listChannels (case-insensitive)", async () => {
    const ops = fakeOps({
      listChannels: async () => [{ id: "C42", name: "incidents" }],
      readChannel: async (ch) => { expect(ch).toBe("C42"); return [{ user: "U1", text: "found it", isBot: false, ts: "1.0" }]; },
    });
    const out = await readChannelImpl(() => ops, { channel: "#Incidents" });
    expect(out.isError).toBeFalsy();
    expect(out.text).toContain("found it");
  });

  it("reads a specific thread when thread_ts is given", async () => {
    const ops = fakeOps({ readThread: async (ch, ts) => {
      expect(ch).toBe("C42");
      expect(ts).toBe("1700.1");
      return [{ user: "U1", text: "thread body", isBot: false, ts: "1700.1" }];
    } });
    const out = await readChannelImpl(() => ops, { channel: "C42", thread_ts: "1700.1" });
    expect(out.text).toContain("thread body");
  });

  it("guides when the #name is unknown (points at list_channels)", async () => {
    const ops = fakeOps({ listChannels: async () => [{ id: "C1", name: "general" }] });
    const out = await readChannelImpl(() => ops, { channel: "#nope" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("list_channels");
  });

  it("guides when the bot is not in the channel (not_in_channel)", async () => {
    const ops = fakeOps({ readChannel: async () => { throw new Error("An API error occurred: not_in_channel"); } });
    const out = await readChannelImpl(() => ops, { channel: "C9" });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/invite/i);
  });

  it("returns an unavailable message when disconnected", async () => {
    const out = await readChannelImpl(() => null, { channel: "C1" });
    expect(out.isError).toBe(true);
  });
});

describe("listChannelsImpl", () => {
  it("lists bot-member channels as #name (id) — topic lines", async () => {
    const ops = fakeOps({ listChannels: async () => [
      { id: "C1", name: "general", topic: "all hands" },
      { id: "C2", name: "secret-ops", isPrivate: true },
    ] });
    const out = await listChannelsImpl(() => ops);
    expect(out.isError).toBeFalsy();
    expect(out.text).toContain("#general (C1) — all hands");
    expect(out.text).toContain("#secret-ops (C2) (private)");
  });

  it("reports when the bot is in no channels", async () => {
    const out = await listChannelsImpl(() => fakeOps({ listChannels: async () => [] }));
    expect(out.text).toMatch(/no channels/i);
  });

  it("returns an error string on failure", async () => {
    const out = await listChannelsImpl(() => fakeOps({ listChannels: async () => { throw new Error("missing_scope"); } }));
    expect(out.isError).toBe(true);
    expect(out.text).toContain("missing_scope");
  });
});

describe("userInfoImpl", () => {
  it("formats a user's profile and accepts <@U1> mention syntax", async () => {
    const ops = fakeOps({ userInfo: async (u) => {
      expect(u).toBe("U1");
      return { id: "U1", displayName: "clover", realName: "YeongMin Song", title: "Engineer", tz: "Asia/Seoul" };
    } });
    const out = await userInfoImpl(() => ops, "<@U1>");
    expect(out.isError).toBeFalsy();
    expect(out.text).toContain("clover");
    expect(out.text).toContain("YeongMin Song");
    expect(out.text).toContain("Asia/Seoul");
  });

  it("reports an unknown user", async () => {
    const out = await userInfoImpl(() => fakeOps({ userInfo: async () => null }), "U404");
    expect(out.isError).toBe(true);
  });
});

describe("permalinkImpl", () => {
  it("returns the permalink for a ts in the bound channel by default", async () => {
    const ops = fakeOps({ permalink: async (ch, ts) => {
      expect(ch).toBe("Cbound");
      expect(ts).toBe("1700.2");
      return "https://x.slack.com/archives/Cbound/p17002";
    } });
    const out = await permalinkImpl(() => ops, "Cbound", { ts: "1700.2" });
    expect(out.text).toBe("https://x.slack.com/archives/Cbound/p17002");
  });

  it("uses the explicit channel when given", async () => {
    const ops = fakeOps({ permalink: async (ch) => { expect(ch).toBe("Cother"); return "url"; } });
    const out = await permalinkImpl(() => ops, "Cbound", { ts: "1.0", channel: "Cother" });
    expect(out.text).toBe("url");
  });

  it("reports a missing permalink as an error", async () => {
    const out = await permalinkImpl(() => fakeOps({ permalink: async () => null }), "C1", { ts: "1.0" });
    expect(out.isError).toBe(true);
  });
});

describe("slackToolDefs", () => {
  it("returns five defs whose names stay in sync with SLACK_TOOL_NAMES (exposure-gate convention)", () => {
    const defs = slackToolDefs(() => null, "C1", "1.0");
    expect(defs.map((d) => `mcp__${SLACK_SERVER_NAME}__${d.name}`)).toEqual([...SLACK_TOOL_NAMES]);
    expect(defs.map((d) => d.name)).toEqual(["read_thread", "read_channel", "list_channels", "get_user_info", "get_permalink"]);
  });

  it("read_thread handler is bound to the thread and calls through", async () => {
    const ops = fakeOps({ readThread: msgs([{ user: "U1", text: "hello", isBot: false, ts: "1.0" }]) });
    const defs = slackToolDefs(() => ops, "C1", "1.0");
    const out = await defs[0]!.handler({}, undefined);
    expect(out.content).toEqual([{ type: "text", text: "<@U1>: hello" }]);
    expect(out.isError).toBeUndefined();
  });

  it("handlers surface isError on failure (disconnected)", async () => {
    const defs = slackToolDefs(() => null, "C1", "1.0");
    for (const def of defs) {
      const input = def.name === "read_channel" ? { channel: "C1" } : def.name === "get_user_info" ? { user: "U1" } : def.name === "get_permalink" ? { ts: "1.0" } : {};
      const out = await def.handler(input, undefined);
      expect(out.isError, def.name).toBe(true);
    }
  });
});

describe("createSlackToolsServer", () => {
  it("wraps slackToolDefs into an SDK server under SLACK_SERVER_NAME", () => {
    const s = createSlackToolsServer(() => null, "C1", "1.0");
    expect(s.name).toBe(SLACK_SERVER_NAME);
    expect(s.instance).toBeDefined();
  });
});
