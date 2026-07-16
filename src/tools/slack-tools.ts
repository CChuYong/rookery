import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance, SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { truncateBytes } from "../core/truncate.js";

// Port that the slack read tools depend on. Slack-agnostic — src/slack implements this contract
// (src/slack/read-ops.ts) and the daemon injects it via a holder (prevents core→slack imports).
export interface ThreadMsgFile {
  id: string;
  name?: string;
  mimetype?: string;
}
export interface ThreadMsg {
  user: string; // author's Slack user id
  text: string;
  isBot: boolean; // whether our bot wrote the message
  ts: string;
  files?: ThreadMsgFile[]; // attachments, rendered as [file: … id=…] markers (download via download_file)
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
  downloadFile(fileId: string): Promise<string | null>; // files.info + Bearer download → local absolute path
}

export const SLACK_SERVER_NAME = "slack";
export const SLACK_TOOL_NAMES = [
  `mcp__${SLACK_SERVER_NAME}__read_thread`,
  `mcp__${SLACK_SERVER_NAME}__read_channel`,
  `mcp__${SLACK_SERVER_NAME}__list_channels`,
  `mcp__${SLACK_SERVER_NAME}__get_user_info`,
  `mcp__${SLACK_SERVER_NAME}__get_permalink`,
  `mcp__${SLACK_SERVER_NAME}__download_file`,
] as const;

const MAX_MSGS = 50; // only this many most-recent ones (older ones dropped)
const MAX_BYTES = 8000; // total byte budget per tool result (transcripts fill from the most recent)
const PER_MSG_BYTES = 1000; // text cap for a single message

type ToolText = { text: string; isError?: boolean };
const DISCONNECTED: ToolText = { text: "Slack is not connected right now — try again later.", isError: true };

// Attachment markers appended to a message's line — the id is what download_file takes.
function fileMarkers(files: ThreadMsgFile[] | undefined): string {
  if (!files?.length) return "";
  return files.map((f) => `[file: ${f.name ?? f.id}${f.mimetype ? ` (${f.mimetype})` : ""} id=${f.id}]`).join(" ");
}

// Format messages as an author-labeled transcript: fill the byte budget from the most recent
// message, then reverse back to chronological order (preserves newest first). A message with
// attachments but no text is kept (label + markers) — it used to be silently skipped.
function formatTranscript(msgs: ThreadMsg[], emptyText: string): ToolText {
  const lines = msgs
    .filter((m) => m.text.trim().length > 0 || m.files?.length)
    .map((m) => {
      const label = m.isBot ? "rookery(bot)" : `<@${m.user}>`;
      const body = [m.text.trim(), fileMarkers(m.files)].filter(Boolean).join(" ");
      return `${label}: ${truncateBytes(body, PER_MSG_BYTES)}`;
    });
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

export async function downloadFileImpl(getOps: () => SlackReadOps | null, fileId: string): Promise<ToolText> {
  const ops = getOps();
  if (!ops) return DISCONNECTED;
  try {
    const path = await ops.downloadFile(fileId.trim());
    if (!path) return { text: "Couldn't download that file — check the file id (from the [file: … id=…] marker) and that the Slack app has the files:read scope.", isError: true };
    return { text: `Downloaded to ${path} — use the Read tool to view it (images too).` };
  } catch (err) {
    return guideError(err, `file ${fileId}`);
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
  const downloadFile = tool(
    "download_file",
    "Download a file attached to a Slack message (the [file: … id=…] markers in read_thread/read_channel output) to a local path, then use Read to view it. Works for images.",
    { file_id: z.string().describe("Slack file id from a [file: … id=F…] marker") },
    async (input) => asResult(await downloadFileImpl(getOps, input.file_id)),
    { annotations: { readOnlyHint: true } },
  );
  return [readThread, readChannel, listChannels, getUserInfo, getPermalink, downloadFile];
}

export function createSlackToolsServer(
  getOps: () => SlackReadOps | null,
  channel: string,
  threadTs: string,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: SLACK_SERVER_NAME, version: "0.0.1", tools: slackToolDefs(getOps, channel, threadTs) });
}
