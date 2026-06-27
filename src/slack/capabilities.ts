import type { TurnCapabilities } from "../core/master-agent.js";
import { parseSlackThreadKey } from "./interaction.js";
import { createSlackThreadToolsServer, SLACK_THREAD_TOOL_NAMES } from "../tools/slack-thread-tools.js";
import type { SlackThreadReader } from "../tools/slack-thread-tools.js";

// System prompt fragment injected into Slack sessions — tells the model it can fetch thread context via read_thread.
// Kept in English to match the tone of the base prompt (SYSTEM_PROMPT_BASE), which is in English.
export const SLACK_THREAD_HINT =
  "This conversation is a Slack thread. If the user's question seems to depend on earlier discussion you can't see (messages before or after in the thread), call the read_thread tool to fetch that context before answering.";

// For a Slack session, builds the capability with that thread's read_thread tool + hint (daemon→SessionManager.makeCapabilities).
// For non-Slack, returns undefined → base only. Even if the reader holder is empty (not connected), the tool returns a guidance string (mirrors makeSlackCanUseTool).
export function makeSlackCapabilities(
  externalKey: string | null,
  getReader: () => SlackThreadReader | null,
): (() => TurnCapabilities) | undefined {
  const target = parseSlackThreadKey(externalKey);
  if (!target) return undefined;
  return () => ({
    mcpServers: { slack: createSlackThreadToolsServer(getReader, target.channel, target.threadTs) },
    allowedTools: [...SLACK_THREAD_TOOL_NAMES],
    systemPromptAppend: SLACK_THREAD_HINT,
  });
}
