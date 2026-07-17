import type { TurnCapabilities } from "../core/master-agent.js";
import { parseSlackThreadKey } from "./interaction.js";
import { slackToolDefs, SLACK_SERVER_NAME, SLACK_TOOL_NAMES } from "../tools/slack-tools.js";
import type { SlackReadOps } from "../tools/slack-tools.js";

// System prompt fragment injected into Slack sessions — tells the model what Slack context it can fetch.
// Kept in English to match the tone of the base prompt (SYSTEM_PROMPT_BASE), which is in English.
export const SLACK_THREAD_HINT =
  "This conversation is a Slack thread. If the user's question seems to depend on earlier discussion you can't see (messages before or after in the thread), call the read_thread tool to fetch that context before answering. " +
  "You can also read other channels the bot is a member of (read_channel / list_channels), resolve user ids to names (get_user_info), and build message links (get_permalink) — all read-only. " +
  "Attachments show up as [file: … id=…] markers — call download_file with the id, then use Read on the returned local path (works for images).";

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
  getName?: () => string, // configured masterName resolver — labels our bot in transcripts (default "rookery")
): (() => TurnCapabilities) | undefined {
  const target = parseSlackThreadKey(externalKey);
  if (!target) return undefined;
  return () => ({
    toolDefs: { [SLACK_SERVER_NAME]: slackToolDefs(getOps, target.channel, target.threadTs, getName) },
    allowedTools: [...SLACK_TOOL_NAMES],
    systemPromptAppend: SLACK_THREAD_HINT,
  });
}
