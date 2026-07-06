import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance, SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { truncateBytes } from "../core/truncate.js";

// Port that the read_thread tool depends on. Slack-agnostic — src/slack implements this contract and injects it (prevents core→slack imports).
export interface ThreadMsg {
  user: string; // author's Slack user id
  text: string;
  isBot: boolean; // whether our bot wrote the message
  ts: string;
}
export type SlackThreadReader = (channel: string, threadTs: string) => Promise<ThreadMsg[]>;

export const SLACK_THREAD_SERVER_NAME = "slack";
export const SLACK_THREAD_TOOL_NAMES = [`mcp__${SLACK_THREAD_SERVER_NAME}__read_thread`] as const;

const MAX_MSGS = 50; // only this many most-recent ones (older ones dropped)
const MAX_BYTES = 8000; // total byte budget for the transcript (filled starting from the most recent)
const PER_MSG_BYTES = 1000; // text cap for a single message

// Format the thread as an author-labeled transcript. An empty holder (not connected) or a reader failure yields a guidance string (best-effort, doesn't kill the turn).
// Budget: fill from the most recent message up to the byte limit, then reverse back to chronological order (preserves newest first).
export async function readThreadImpl(
  getReader: () => SlackThreadReader | null,
  channel: string,
  threadTs: string,
): Promise<{ text: string; isError?: boolean }> {
  const reader = getReader();
  if (!reader) return { text: "Couldn't read the thread (Slack not connected).", isError: true };
  let msgs: ThreadMsg[];
  try {
    msgs = await reader(channel, threadTs);
  } catch (err) {
    return { text: `Failed to read thread: ${String(err)}`, isError: true };
  }
  const lines = msgs
    .filter((m) => m.text.trim().length > 0)
    .map((m) => `${m.isBot ? "rookery(bot)" : `<@${m.user}>`}: ${truncateBytes(m.text.trim(), PER_MSG_BYTES)}`);
  if (lines.length === 0) return { text: "The thread has no messages." };

  // Fill the budget in reverse from newest → restore chronological order.
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

// Raw tool defs (extracted so they can travel the provider-neutral port — see agent-backend.ts's
// ProviderToolDef / MasterTurnOptions.toolDefs, and schedule-tools.ts's scheduleToolDefs for the same
// pattern). read_thread has no input — channel/thread are bound at construction time. Claude wraps this
// with createSdkMcpServer below; the Codex adapter registers the same objects on the daemon MCP bridge,
// so a codex slack session also gets read_thread (src/daemon/mcp-bridge.ts).
export function slackThreadToolDefs(
  getReader: () => SlackThreadReader | null,
  channel: string,
  threadTs: string,
): SdkMcpToolDefinition<any>[] {
  const readThread = tool(
    "read_thread",
    "Read the surrounding messages of the current Slack thread (the discussion before and after the message that triggered you). Call this when the user's request seems to depend on earlier context you cannot see.",
    {},
    async () => {
      const { text, isError } = await readThreadImpl(getReader, channel, threadTs);
      return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
    },
    { annotations: { readOnlyHint: true } },
  );
  return [readThread];
}

export function createSlackThreadToolsServer(
  getReader: () => SlackThreadReader | null,
  channel: string,
  threadTs: string,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: SLACK_THREAD_SERVER_NAME, version: "0.0.1", tools: slackThreadToolDefs(getReader, channel, threadTs) });
}
