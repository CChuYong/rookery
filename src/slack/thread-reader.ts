import type { SlackThreadReader, ThreadMsg } from "../tools/slack-thread-tools.js";

// A single message from a conversations.replies response (only the fields we need). Bot messages have a bot_id.
export interface RawReply {
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  subtype?: string;
}

// Slack thread replies → ThreadMsg[]. If bot_id is present, mark it as a bot message (for labeling).
export function repliesToThreadMsgs(raw: RawReply[]): ThreadMsg[] {
  return raw.map((m) => ({
    user: m.user ?? m.bot_id ?? "?",
    text: m.text ?? "",
    isBot: !!m.bot_id,
    ts: m.ts ?? "",
  }));
}

// Reader that calls conversations.replies via the bolt WebClient (app.client). Requires the *:history scope, separate from files:read.
type RepliesClient = { conversations: { replies(a: { channel: string; ts: string; limit?: number }): Promise<{ messages?: RawReply[] }> } };
export function makeSlackThreadReader(client: RepliesClient): SlackThreadReader {
  return async (channel, threadTs) => {
    const res = await client.conversations.replies({ channel, ts: threadTs, limit: 100 });
    return repliesToThreadMsgs(res.messages ?? []);
  };
}
