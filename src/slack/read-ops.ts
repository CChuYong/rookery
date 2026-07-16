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
