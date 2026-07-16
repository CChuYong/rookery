# Slack Read Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Slack-origin master sessions four new read-only Slack tools (`read_channel`, `list_channels`, `get_user_info`, `get_permalink`) alongside the existing `read_thread`, by generalizing the holder port from a single reader function to a `SlackReadOps` interface.

**Architecture:** Approach A from the spec (`docs/superpowers/specs/2026-07-17-slack-read-tools-design.md`): extend the existing `"slack"` MCP server. `src/tools/slack-thread-tools.ts` → `src/tools/slack-tools.ts` (port + 5 tool defs, pure, fake-testable); `src/slack/thread-reader.ts` → `src/slack/read-ops.ts` (bolt WebClient adapter); wiring through the existing daemon holder / `makeSlackCapabilities` path. Provider-neutral `toolDefs` port means Codex masters get the tools with zero extra work.

**Tech Stack:** TypeScript (ESM NodeNext — relative imports need `.js`, type-only imports need `import type`), zod raw shapes for tool inputs, vitest.

## Global Constraints

- All five tools are read-only (`annotations: { readOnlyHint: true }`); no write tools.
- Tool errors NEVER throw out of the handler — return a guidance string with `isError: true` (the existing `read_thread` pattern).
- `SLACK_TOOL_NAMES` must stay in sync with the registered `tool()` names (`mcp__slack__<name>`), or the tools silently can't be used (bypassPermissions allowlist gate).
- Byte budgets: transcripts 8000 bytes total / 1000 bytes per message / 50 messages max, newest-first fill then chronological order (existing `read_thread` behavior).
- Code comments in English.
- Run from repo root with Node 22 active (`nvm use 22`). Gates: `npm run typecheck` && `npm test`.

---

### Task 1: Port generalization + five tool defs (`src/tools/slack-tools.ts`)

**Files:**
- Create: `src/tools/slack-tools.ts` (content is the evolution of `src/tools/slack-thread-tools.ts`)
- Delete: `src/tools/slack-thread-tools.ts`
- Create: `test/tools/slack-tools.test.ts` (evolution of `test/tools/slack-thread-tools.test.ts`)
- Delete: `test/tools/slack-thread-tools.test.ts`
- Modify: `src/tools/fleet-tools.ts:33` (comment mentions "slack-thread-tools" → "slack-tools")

Note: after this task the tree does not typecheck as a whole (importers still point at the old file) — that's expected; Tasks 2–4 fix the importers. Run only this task's test file, not the full gate.

**Interfaces:**
- Consumes: `truncateBytes(s, maxBytes)` from `src/core/truncate.js`; `tool`/`createSdkMcpServer` from the SDK; `z` from zod.
- Produces (used by Tasks 2–4):
  - `interface ThreadMsg { user: string; text: string; isBot: boolean; ts: string }` (unchanged)
  - `interface ChannelInfo { id: string; name: string; topic?: string; isPrivate?: boolean }`
  - `interface SlackUserInfo { id: string; displayName?: string; realName?: string; title?: string; tz?: string }`
  - `interface SlackReadOps { readThread(channel, threadTs): Promise<ThreadMsg[]>; readChannel(channel, limit?): Promise<ThreadMsg[]>; listChannels(): Promise<ChannelInfo[]>; userInfo(user): Promise<SlackUserInfo | null>; permalink(channel, ts): Promise<string | null> }`
  - `SLACK_SERVER_NAME = "slack"`, `SLACK_TOOL_NAMES` (5 entries)
  - `slackToolDefs(getOps: () => SlackReadOps | null, channel: string, threadTs: string): SdkMcpToolDefinition<any>[]`
  - `createSlackToolsServer(getOps, channel, threadTs): McpSdkServerConfigWithInstance`
  - impl helpers exported for tests: `readThreadImpl`, `readChannelImpl`, `listChannelsImpl`, `userInfoImpl`, `permalinkImpl`

- [ ] **Step 1: Write the failing test**

Create `test/tools/slack-tools.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tools/slack-tools.test.ts`
Expected: FAIL — cannot resolve `../../src/tools/slack-tools.js`.

- [ ] **Step 3: Write the implementation**

Create `src/tools/slack-tools.ts` (this file supersedes `slack-thread-tools.ts` — start from its content, then delete the old file in Step 4):

```ts
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance, SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { truncateBytes } from "../core/truncate.js";

// Port that the slack read tools depend on. Slack-agnostic — src/slack implements this contract
// (src/slack/read-ops.ts) and the daemon injects it via a holder (prevents core→slack imports).
export interface ThreadMsg {
  user: string; // author's Slack user id
  text: string;
  isBot: boolean; // whether our bot wrote the message
  ts: string;
}
export interface ChannelInfo {
  id: string;
  name: string; // without the leading '#'
  topic?: string;
  isPrivate?: boolean;
}
export interface SlackUserInfo {
  id: string;
  displayName?: string;
  realName?: string;
  title?: string;
  tz?: string;
}

// Read-only view of the workspace as the bot sees it. All lookups are bot-token scoped:
// channel reads work only where the bot is a member (Slack API constraint, not ours).
export interface SlackReadOps {
  readThread(channel: string, threadTs: string): Promise<ThreadMsg[]>; // conversations.replies
  readChannel(channel: string, limit?: number): Promise<ThreadMsg[]>; // conversations.history (chronological)
  listChannels(): Promise<ChannelInfo[]>; // conversations.list, bot-member channels only
  userInfo(user: string): Promise<SlackUserInfo | null>; // users.info
  permalink(channel: string, ts: string): Promise<string | null>; // chat.getPermalink
}

export const SLACK_SERVER_NAME = "slack";
export const SLACK_TOOL_NAMES = [
  `mcp__${SLACK_SERVER_NAME}__read_thread`,
  `mcp__${SLACK_SERVER_NAME}__read_channel`,
  `mcp__${SLACK_SERVER_NAME}__list_channels`,
  `mcp__${SLACK_SERVER_NAME}__get_user_info`,
  `mcp__${SLACK_SERVER_NAME}__get_permalink`,
] as const;

const MAX_MSGS = 50; // only this many most-recent ones (older ones dropped)
const MAX_BYTES = 8000; // total byte budget per tool result (transcripts fill from the most recent)
const PER_MSG_BYTES = 1000; // text cap for a single message

type ToolText = { text: string; isError?: boolean };
const DISCONNECTED: ToolText = { text: "Slack is not connected right now — try again later.", isError: true };

// Format messages as an author-labeled transcript: fill the byte budget from the most recent
// message, then reverse back to chronological order (preserves newest first).
function formatTranscript(msgs: ThreadMsg[], emptyText: string): ToolText {
  const lines = msgs
    .filter((m) => m.text.trim().length > 0)
    .map((m) => `${m.isBot ? "rookery(bot)" : `<@${m.user}>`}: ${truncateBytes(m.text.trim(), PER_MSG_BYTES)}`);
  if (lines.length === 0) return { text: emptyText };
  const kept: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0 && kept.length < MAX_MSGS; i--) {
    const b = Buffer.byteLength(lines[i]!, "utf8") + 1; // +1 ≈ newline
    if (bytes + b > MAX_BYTES) break;
    kept.push(lines[i]!);
    bytes += b;
  }
  kept.reverse();
  return { text: kept.join("\n") };
}

// Slack Web API errors carry the code in the message ("An API error occurred: not_in_channel") —
// map the common read failures to guidance the model can act on instead of a raw error dump.
function guideError(err: unknown, what: string): ToolText {
  const s = String(err);
  if (s.includes("not_in_channel") || s.includes("channel_not_found"))
    return { text: `Couldn't read ${what}: the bot is not in that channel (or it doesn't exist). Ask a member to invite the bot, then retry.`, isError: true };
  if (s.includes("missing_scope"))
    return { text: `Couldn't read ${what}: the Slack app lacks a required OAuth scope (${s}). The workspace admin must add it and reinstall the app.`, isError: true };
  return { text: `Failed to read ${what}: ${s}`, isError: true };
}

export async function readThreadImpl(
  getOps: () => SlackReadOps | null,
  channel: string,
  threadTs: string,
): Promise<ToolText> {
  const ops = getOps();
  if (!ops) return DISCONNECTED;
  try {
    return formatTranscript(await ops.readThread(channel, threadTs), "The thread has no messages.");
  } catch (err) {
    return { text: `Failed to read thread: ${String(err)}`, isError: true };
  }
}

export async function readChannelImpl(
  getOps: () => SlackReadOps | null,
  input: { channel: string; thread_ts?: string; limit?: number },
): Promise<ToolText> {
  const ops = getOps();
  if (!ops) return DISCONNECTED;
  try {
    // Accept a raw conversation id (C…/G…/D…) or a #name / bare name resolved via listChannels.
    let id = input.channel.trim();
    if (!/^[CGD][A-Z0-9]+$/.test(id)) {
      const name = id.replace(/^#/, "").toLowerCase();
      const match = (await ops.listChannels()).find((c) => c.name.toLowerCase() === name);
      if (!match) return { text: `No channel named "${input.channel}" among the channels the bot is in — call list_channels to see what's available.`, isError: true };
      id = match.id;
    }
    const msgs = input.thread_ts
      ? await ops.readThread(id, input.thread_ts)
      : await ops.readChannel(id, Math.min(Math.max(input.limit ?? 30, 1), MAX_MSGS));
    return formatTranscript(msgs, "The channel has no messages.");
  } catch (err) {
    return guideError(err, `channel ${input.channel}`);
  }
}

export async function listChannelsImpl(getOps: () => SlackReadOps | null): Promise<ToolText> {
  const ops = getOps();
  if (!ops) return DISCONNECTED;
  let channels: ChannelInfo[];
  try {
    channels = await ops.listChannels();
  } catch (err) {
    return guideError(err, "the channel list");
  }
  if (channels.length === 0) return { text: "The bot is in no channels yet — it must be invited to a channel before it can read one." };
  const lines = channels.map((c) =>
    `#${c.name} (${c.id})${c.isPrivate ? " (private)" : ""}${c.topic ? ` — ${truncateBytes(c.topic, 200)}` : ""}`,
  );
  return { text: truncateBytes(lines.join("\n"), MAX_BYTES) };
}

export async function userInfoImpl(getOps: () => SlackReadOps | null, user: string): Promise<ToolText> {
  const ops = getOps();
  if (!ops) return DISCONNECTED;
  const id = user.trim().replace(/^<@/, "").replace(/>$/, "").split("|")[0]!; // accept U1, <@U1>, <@U1|name>
  try {
    const u = await ops.userInfo(id);
    if (!u) return { text: `No Slack user found for "${user}".`, isError: true };
    const parts = [
      u.displayName ? `display name: ${u.displayName}` : null,
      u.realName ? `real name: ${u.realName}` : null,
      u.title ? `title: ${u.title}` : null,
      u.tz ? `timezone: ${u.tz}` : null,
    ].filter((p): p is string => !!p);
    return { text: `<@${id}> — ${parts.length ? parts.join(", ") : "no profile fields visible"}` };
  } catch (err) {
    return guideError(err, `user ${user}`);
  }
}

export async function permalinkImpl(
  getOps: () => SlackReadOps | null,
  boundChannel: string,
  input: { ts: string; channel?: string },
): Promise<ToolText> {
  const ops = getOps();
  if (!ops) return DISCONNECTED;
  const channel = input.channel?.trim() || boundChannel;
  try {
    const url = await ops.permalink(channel, input.ts.trim());
    if (!url) return { text: `No permalink found for ts=${input.ts} in ${channel}.`, isError: true };
    return { text: url };
  } catch (err) {
    return guideError(err, `message ${input.ts}`);
  }
}

const asResult = ({ text, isError }: ToolText) => ({ content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) });

// Raw tool defs travelling the provider-neutral port (see agent-backend.ts's ProviderToolDef and
// schedule-tools.ts for the same pattern). read_thread is bound to the session's own thread at
// construction time; the other four take inputs. Claude wraps these with createSdkMcpServer below;
// the Codex adapter registers the same objects on the daemon MCP bridge (src/daemon/mcp-bridge.ts).
export function slackToolDefs(
  getOps: () => SlackReadOps | null,
  channel: string,
  threadTs: string,
): SdkMcpToolDefinition<any>[] {
  const readThread = tool(
    "read_thread",
    "Read the surrounding messages of the current Slack thread (the discussion before and after the message that triggered you). Call this when the user's request seems to depend on earlier context you cannot see.",
    {},
    async () => asResult(await readThreadImpl(getOps, channel, threadTs)),
    { annotations: { readOnlyHint: true } },
  );
  const readChannel = tool(
    "read_channel",
    "Read another Slack channel's recent messages (or one of its threads via thread_ts). Only works for channels the bot is a member of — use list_channels to see them.",
    {
      channel: z.string().describe("Channel id (C…) or name (#incidents)"),
      thread_ts: z.string().optional().describe("Read this specific thread instead of the channel's recent history"),
      limit: z.number().int().min(1).max(50).optional().describe("Max messages to return (default 30)"),
    },
    async (input) => asResult(await readChannelImpl(getOps, input)),
    { annotations: { readOnlyHint: true } },
  );
  const listChannels = tool(
    "list_channels",
    "List the Slack channels the bot is a member of (id, name, topic) — the ones read_channel can read.",
    {},
    async () => asResult(await listChannelsImpl(getOps)),
    { annotations: { readOnlyHint: true } },
  );
  const getUserInfo = tool(
    "get_user_info",
    "Resolve a Slack user id (U… or <@U…> mention) to their profile: display name, real name, title, timezone.",
    { user: z.string().describe("User id, e.g. U0123 or <@U0123>") },
    async (input) => asResult(await userInfoImpl(getOps, input.user)),
    { annotations: { readOnlyHint: true } },
  );
  const getPermalink = tool(
    "get_permalink",
    "Get the permanent link URL for a Slack message, to cite it in an answer. Defaults to the current channel.",
    {
      ts: z.string().describe("The message's ts (e.g. 1700000000.000100)"),
      channel: z.string().optional().describe("Channel id the message is in (default: this thread's channel)"),
    },
    async (input) => asResult(await permalinkImpl(getOps, channel, input)),
    { annotations: { readOnlyHint: true } },
  );
  return [readThread, readChannel, listChannels, getUserInfo, getPermalink];
}

export function createSlackToolsServer(
  getOps: () => SlackReadOps | null,
  channel: string,
  threadTs: string,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: SLACK_SERVER_NAME, version: "0.0.1", tools: slackToolDefs(getOps, channel, threadTs) });
}
```

Then:
- `git rm src/tools/slack-thread-tools.ts test/tools/slack-thread-tools.test.ts`
- In `src/tools/fleet-tools.ts` line 33, change the comment token `slack-thread-tools` → `slack-tools`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/tools/slack-tools.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add -A src/tools test/tools
git commit -m "feat(slack): generalize thread reader port to SlackReadOps with five read tools"
```

---

### Task 2: WebClient adapter (`src/slack/read-ops.ts`)

**Files:**
- Create: `src/slack/read-ops.ts` (absorbs `src/slack/thread-reader.ts`)
- Delete: `src/slack/thread-reader.ts`
- Create: `test/slack/read-ops.test.ts` (absorbs `test/slack/thread-reader.test.ts`)
- Delete: `test/slack/thread-reader.test.ts`

**Interfaces:**
- Consumes: `SlackReadOps`, `ThreadMsg`, `ChannelInfo`, `SlackUserInfo` from `../tools/slack-tools.js` (Task 1).
- Produces: `makeSlackReadOps(client: SlackReadClient): SlackReadOps`; `repliesToThreadMsgs(raw: RawReply[]): ThreadMsg[]`; `interface SlackReadClient` (narrow bolt WebClient shape); `interface RawReply` — used by Task 3/4 wiring and tests.

- [ ] **Step 1: Write the failing test**

Create `test/slack/read-ops.test.ts`:

```ts
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
      { channels: [ { id: "G1", name: "secret", is_member: true, is_private: true } ] },
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/slack/read-ops.test.ts`
Expected: FAIL — cannot resolve `../../src/slack/read-ops.js`.

- [ ] **Step 3: Write the implementation**

Create `src/slack/read-ops.ts`:

```ts
import type { SlackReadOps, ThreadMsg, ChannelInfo, SlackUserInfo } from "../tools/slack-tools.js";

// A single message from a conversations.replies/history response (only the fields we need). Bot messages have a bot_id.
export interface RawReply {
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  subtype?: string;
}
interface RawChannel {
  id?: string;
  name?: string;
  is_member?: boolean;
  is_private?: boolean;
  topic?: { value?: string };
}
interface RawUser {
  name?: string;
  real_name?: string;
  tz?: string;
  profile?: { display_name?: string; real_name?: string; title?: string };
}

// Slack replies/history → ThreadMsg[]. If bot_id is present, mark it as a bot message (for labeling).
export function repliesToThreadMsgs(raw: RawReply[]): ThreadMsg[] {
  return raw.map((m) => ({
    user: m.user ?? m.bot_id ?? "?",
    text: m.text ?? "",
    isBot: !!m.bot_id,
    ts: m.ts ?? "",
  }));
}

// Narrow shape of the bolt WebClient methods we call — kept small so tests can fake it without a real bolt App.
// Scopes: replies/history need *:history; list needs channels:read (+groups:read for private); users.info needs users:read.
export interface SlackReadClient {
  conversations: {
    replies(a: { channel: string; ts: string; limit?: number }): Promise<{ messages?: RawReply[] }>;
    history(a: { channel: string; limit?: number }): Promise<{ messages?: RawReply[] }>;
    list(a: { types?: string; exclude_archived?: boolean; limit?: number; cursor?: string }): Promise<{ channels?: RawChannel[]; response_metadata?: { next_cursor?: string } }>;
  };
  users: { info(a: { user: string }): Promise<{ user?: RawUser }> };
  chat: { getPermalink(a: { channel: string; message_ts: string }): Promise<{ permalink?: string }> };
}

const LIST_PAGE = 200;
const LIST_MAX = 1000; // hard cap on member channels collected (runaway-workspace backstop)

// The SlackReadOps implementation the daemon installs on its holder at connect time (src/slack/app.ts).
// Errors are NOT caught here — the tool impls in src/tools/slack-tools.ts own the guidance-string mapping.
export function makeSlackReadOps(client: SlackReadClient): SlackReadOps {
  return {
    async readThread(channel, threadTs) {
      const res = await client.conversations.replies({ channel, ts: threadTs, limit: 100 });
      return repliesToThreadMsgs(res.messages ?? []);
    },
    async readChannel(channel, limit) {
      const res = await client.conversations.history({ channel, limit: limit ?? 30 });
      // history returns newest first — reverse to chronological so the shared transcript formatter
      // (newest-first budget fill, then chronological output) treats it like a replies response.
      return repliesToThreadMsgs(res.messages ?? []).reverse();
    },
    async listChannels() {
      const out: ChannelInfo[] = [];
      let cursor: string | undefined;
      do {
        const res = await client.conversations.list({ types: "public_channel,private_channel", exclude_archived: true, limit: LIST_PAGE, cursor });
        for (const c of res.channels ?? []) {
          if (c.id && c.name && c.is_member) out.push({ id: c.id, name: c.name, topic: c.topic?.value || undefined, isPrivate: !!c.is_private });
        }
        cursor = res.response_metadata?.next_cursor || undefined;
      } while (cursor && out.length < LIST_MAX);
      return out;
    },
    async userInfo(user): Promise<SlackUserInfo | null> {
      const res = await client.users.info({ user });
      const u = res.user;
      if (!u) return null;
      return {
        id: user,
        displayName: u.profile?.display_name || undefined,
        realName: u.profile?.real_name || u.real_name || u.name,
        title: u.profile?.title || undefined,
        tz: u.tz || undefined,
      };
    },
    async permalink(channel, ts) {
      const res = await client.chat.getPermalink({ channel, message_ts: ts });
      return res.permalink ?? null;
    },
  };
}
```

Then `git rm src/slack/thread-reader.ts test/slack/thread-reader.test.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/slack/read-ops.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src/slack/read-ops.ts src/slack/thread-reader.ts test/slack
git commit -m "feat(slack): add read-ops WebClient adapter (absorbs thread-reader)"
```

---

### Task 3: Capabilities overlay (`src/slack/capabilities.ts`)

**Files:**
- Modify: `src/slack/capabilities.ts` (whole file, small)
- Modify: `test/slack/capabilities.test.ts`

**Interfaces:**
- Consumes: `slackToolDefs`, `SLACK_SERVER_NAME`, `SLACK_TOOL_NAMES`, `SlackReadOps` from `../tools/slack-tools.js` (Task 1).
- Produces: `makeSlackCapabilities(externalKey: string | null, getOps: () => SlackReadOps | null): (() => TurnCapabilities) | undefined` — Task 4's server.ts wiring calls this; `SLACK_THREAD_HINT` string.

- [ ] **Step 1: Update the test**

Replace `test/slack/capabilities.test.ts` content:

```ts
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
      "read_thread", "read_channel", "list_channels", "get_user_info", "get_permalink",
    ]);
    expect(caps.allowedTools).toEqual([...SLACK_TOOL_NAMES]);
    expect(caps.systemPromptAppend).toBe(SLACK_THREAD_HINT);
  });

  it("returns undefined for non-slack sessions", () => {
    expect(makeSlackCapabilities(null, noOps)).toBeUndefined();
    expect(makeSlackCapabilities("thread-1", noOps)).toBeUndefined();
    expect(makeSlackCapabilities("ui:fleet", noOps)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/slack/capabilities.test.ts`
Expected: FAIL (old import path / old signature).

- [ ] **Step 3: Update the implementation**

Replace `src/slack/capabilities.ts` content:

```ts
import type { TurnCapabilities } from "../core/master-agent.js";
import { parseSlackThreadKey } from "./interaction.js";
import { slackToolDefs, SLACK_SERVER_NAME, SLACK_TOOL_NAMES } from "../tools/slack-tools.js";
import type { SlackReadOps } from "../tools/slack-tools.js";

// System prompt fragment injected into Slack sessions — tells the model what Slack context it can fetch.
// Kept in English to match the tone of the base prompt (SYSTEM_PROMPT_BASE), which is in English.
export const SLACK_THREAD_HINT =
  "This conversation is a Slack thread. If the user's question seems to depend on earlier discussion you can't see (messages before or after in the thread), call the read_thread tool to fetch that context before answering. " +
  "You can also read other channels the bot is a member of (read_channel / list_channels), resolve user ids to names (get_user_info), and build message links (get_permalink) — all read-only.";

// For a Slack session, builds the capability with that thread's slack read tools + hint
// (daemon→SessionManager.makeCapabilities). For non-Slack, returns undefined → base only. Even if
// the ops holder is empty (not connected), each tool returns a guidance string (mirrors makeSlackCanUseTool).
// The defs travel via caps.toolDefs (the provider-neutral port, P2.5 Track C) rather than an opaque
// caps.mcpServers entry: master-agent.ts's doTurn merges toolDefs into the same defs record the base
// memory/repos/fleet groups travel on, so the Claude adapter wraps it with createSdkMcpServer while
// the Codex adapter flattens it onto the daemon MCP bridge — a codex slack session
// (settings.slackProvider()==="codex") gets the same tools, not just Claude.
export function makeSlackCapabilities(
  externalKey: string | null,
  getOps: () => SlackReadOps | null,
): (() => TurnCapabilities) | undefined {
  const target = parseSlackThreadKey(externalKey);
  if (!target) return undefined;
  return () => ({
    toolDefs: { [SLACK_SERVER_NAME]: slackToolDefs(getOps, target.channel, target.threadTs) },
    allowedTools: [...SLACK_TOOL_NAMES],
    systemPromptAppend: SLACK_THREAD_HINT,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/slack/capabilities.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/slack/capabilities.ts test/slack/capabilities.test.ts
git commit -m "feat(slack): expose five read tools through the slack capability overlay"
```

---

### Task 4: Wiring (holder, deps, app.ts, server.ts) + docs + full gates

**Files:**
- Modify: `src/slack/handle-incoming.ts:6,34-35,46` (deps rename)
- Modify: `src/slack/app.ts:10,174-176,214` (build/install read ops)
- Modify: `src/daemon/server.ts:67,325-328,372,612-613` (holder + capability wiring)
- Modify: `AGENTS.md:141` (scope prerequisites; `CLAUDE.md` is a symlink to it)
- Test: full gates (`npm run typecheck` && `npm test`), plus any other file that fails typecheck on the old imports.

**Interfaces:**
- Consumes: `SlackReadOps` (Task 1), `makeSlackReadOps`/`SlackReadClient` (Task 2), `makeSlackCapabilities` (Task 3).
- Produces: n/a (composition root).

- [ ] **Step 1: Rename the deps fields in `src/slack/handle-incoming.ts`**

Line 6: `import type { SlackThreadReader } from "../tools/slack-thread-tools.js";` → `import type { SlackReadOps } from "../tools/slack-tools.js";`

Lines 34-35 (inside `SlackDeps`):
```ts
  // Register the slack read ops (conversations.replies/history/list, users.info, chat.getPermalink) into the
  // daemon holder at connection time (null when disconnected). Backs the master's slack read-tool capability.
  setSlackReadOps?: (r: SlackReadOps | null) => void;
```
Line 46: `clearThreadReader?: (r: SlackThreadReader) => void;` → `clearSlackReadOps?: (r: SlackReadOps) => void;`

- [ ] **Step 2: Install the ops in `src/slack/app.ts`**

Line 10: `import { makeSlackThreadReader } from "./thread-reader.js";` → `import { makeSlackReadOps, type SlackReadClient } from "./read-ops.js";`

Lines 174-176:
```ts
  // Register the slack read ops (replies/history/list/users.info/getPermalink) on the daemon holder →
  // used by the master's slack read-tool capability (read_thread/read_channel/...).
  const readOps = makeSlackReadOps(app.client as unknown as SlackReadClient);
  deps.setSlackReadOps?.(readOps);
```

Line 214: `if (deps.clearThreadReader) deps.clearThreadReader(threadReader); else deps.setThreadReader?.(null);` → `if (deps.clearSlackReadOps) deps.clearSlackReadOps(readOps); else deps.setSlackReadOps?.(null);`

- [ ] **Step 3: Rewire the daemon composition root `src/daemon/server.ts`**

Line 67: `import type { SlackThreadReader } from "../tools/slack-thread-tools.js";` → `import type { SlackReadOps } from "../tools/slack-tools.js";`

Line 328: `const threadReaderHolder = makeHolder<SlackThreadReader>();` → `const slackReadOpsHolder = makeHolder<SlackReadOps>();` (keep the surrounding comment, s/thread reader/read ops/)

Line 372: `const slackCaps = makeSlackCapabilities(externalKey, () => threadReaderHolder.get());` → `const slackCaps = makeSlackCapabilities(externalKey, () => slackReadOpsHolder.get());` — also update the comment on lines 363-364 ("read_thread tool/hint" → "slack read tools/hint").

Lines 612-613:
```ts
      setSlackReadOps: (r) => { if (r) slackReadOpsHolder.set(r); },
      clearSlackReadOps: (r) => slackReadOpsHolder.clearIf(r),
```

- [ ] **Step 4: Update the AGENTS.md Slack prerequisites bullet (line 141)**

Change:
> subscribe to the `message.channels` event + the `channels:history` scope + invite the bot to the target channels. Without these, message events are not received.

to:
> subscribe to the `message.channels` event + the `channels:history` scope + invite the bot to the target channels. Without these, message events are not received. The master's slack read tools additionally want `channels:read`/`groups:read` (list_channels, #name resolution), `users:read` (get_user_info), and `groups:history` (private-channel read_channel) — missing scopes degrade to per-call guidance strings, they don't break the turn.

Also update the CLAUDE.md §Tools "slack-thread" bullet (same file, the in-process MCP servers list): rename the entry to `- **slack** (`slack-tools.ts`): `read_thread`, `read_channel`, `list_channels`, `get_user_info`, `get_permalink` — injected only for Slack-origin sessions (read-only)`.

- [ ] **Step 5: Run the full gates**

Run: `npm run typecheck`
Expected: clean. If any file still imports `slack-thread-tools.js` or `thread-reader.js`, fix that import to the new module (same symbols; `SlackThreadReader` function type → `SlackReadOps["readThread"]`-shaped usage should not exist outside the renamed files).

Run: `npm test`
Expected: PASS (including untouched suites — `worker-slack-relay`, `handle-incoming`, etc.).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(slack): wire SlackReadOps holder through app/daemon and document scopes"
```
