import { describe, it, expect } from "vitest";
import { makeSlackRefResolver } from "../../src/slack/name-resolver.js";
import type { SlackInfoClient } from "../../src/slack/name-resolver.js";

function fakeClient(opts: {
  channels?: Record<string, string>; // id → name (missing id → API "not found" style rejection)
  users?: Record<string, string>;
  channelCalls?: string[];
  userCalls?: string[];
  throwOnChannel?: string; // id that always throws (simulates an API error, not just a miss)
}): SlackInfoClient {
  return {
    conversations: {
      info: async ({ channel }) => {
        opts.channelCalls?.push(channel);
        if (channel === opts.throwOnChannel) throw new Error("slack api error");
        const name = opts.channels?.[channel];
        return { channel: name ? { name } : {} };
      },
    },
    users: {
      info: async ({ user }) => {
        opts.userCalls?.push(user);
        const name = opts.users?.[user];
        return { user: name ? { profile: { display_name: name } } : {} };
      },
    },
  };
}

describe("makeSlackRefResolver", () => {
  it("resolves known channel and user ids to names", async () => {
    const client = fakeClient({ channels: { C1: "general" }, users: { U1: "clover" } });
    const resolver = makeSlackRefResolver(client);
    const res = await resolver.resolve(["C1"], ["U1"]);
    expect(res).toEqual({ channels: { C1: "general" }, users: { U1: "clover" } });
  });

  it("omits an id from the result when the lookup throws (API error) — caller falls back to the raw id", async () => {
    const client = fakeClient({ channels: {}, throwOnChannel: "C_BAD" });
    const resolver = makeSlackRefResolver(client);
    const res = await resolver.resolve(["C_BAD"], []);
    expect(res.channels).toEqual({});
  });

  it("omits an id when the API returns no name (e.g. deleted channel/user)", async () => {
    const client = fakeClient({});
    const resolver = makeSlackRefResolver(client);
    const res = await resolver.resolve(["C_UNKNOWN"], ["U_UNKNOWN"]);
    expect(res).toEqual({ channels: {}, users: {} });
  });

  it("caches a resolved id — a repeat resolve() does not call the API again", async () => {
    const channelCalls: string[] = [];
    const client = fakeClient({ channels: { C1: "general" }, channelCalls });
    const resolver = makeSlackRefResolver(client);
    await resolver.resolve(["C1"], []);
    await resolver.resolve(["C1"], []);
    expect(channelCalls).toEqual(["C1"]); // second call served from cache
  });

  it("resolves a mixed batch independently — one failure doesn't affect other ids", async () => {
    const client = fakeClient({ channels: { C1: "general" }, users: { U1: "clover" }, throwOnChannel: "C_BAD" });
    const resolver = makeSlackRefResolver(client);
    const res = await resolver.resolve(["C1", "C_BAD"], ["U1"]);
    expect(res).toEqual({ channels: { C1: "general" }, users: { U1: "clover" } });
  });
});
