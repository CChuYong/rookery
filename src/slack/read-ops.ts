import type { SlackReadOps, ThreadMsg, ThreadMsgFile, ChannelInfo, SlackUserInfo } from "../tools/slack-tools.js";
import type { FileDownloader } from "./file-download.js";
import { extractSlackText } from "./message-text.js";

// A single message from a conversations.replies/history response (only the fields we need). Bot messages have a bot_id.
export interface RawReply {
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  subtype?: string;
  blocks?: unknown[]; // Block Kit — melted into text via extractSlackText
  attachments?: unknown[]; // legacy attachments — same
  files?: { id?: string; name?: string; mimetype?: string }[];
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
// Text is melted with extractSlackText (m.text + Block Kit blocks + legacy attachments, rich_text
// deduped) so blocks-only bot cards are visible; attached files ride along as marker metadata.
export function repliesToThreadMsgs(raw: RawReply[]): ThreadMsg[] {
  return raw.map((m) => {
    const files = (m.files ?? [])
      .filter((f): f is { id: string; name?: string; mimetype?: string } => typeof f.id === "string")
      .map((f): ThreadMsgFile => ({ id: f.id, name: f.name, mimetype: f.mimetype }));
    return {
      user: m.user ?? m.bot_id ?? "?",
      text: extractSlackText({ text: m.text, blocks: m.blocks, attachments: m.attachments }),
      isBot: !!m.bot_id,
      ts: m.ts ?? "",
      ...(files.length ? { files } : {}),
    };
  });
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
  files: { info(a: { file: string }): Promise<{ file?: { id?: string; name?: string; mimetype?: string; url_private_download?: string; url_private?: string } }> };
}

const LIST_PAGE = 200;
const LIST_MAX = 1000; // hard cap on member channels collected (runaway-workspace backstop)

// The SlackReadOps implementation the daemon installs on its holder at connect time (src/slack/app.ts).
// Errors are NOT caught here — the tool impls in src/tools/slack-tools.ts own the guidance-string mapping.
// `download` is the same FileDownloader instance the incoming-message path uses (Bearer bot token →
// ~/.rookery/slack-files/); absent (tests/misconfig) → downloadFile degrades to null.
export function makeSlackReadOps(client: SlackReadClient, download?: FileDownloader): SlackReadOps {
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
    async downloadFile(fileId) {
      if (!download) return null;
      const res = await client.files.info({ file: fileId });
      const f = res.file;
      if (!f?.id) return null;
      return download({ id: f.id, name: f.name, mimetype: f.mimetype, urlPrivateDownload: f.url_private_download ?? f.url_private });
    },
  };
}
