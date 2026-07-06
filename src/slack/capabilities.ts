import type { TurnCapabilities } from "../core/master-agent.js";
import { parseSlackThreadKey } from "./interaction.js";
import { slackThreadToolDefs, SLACK_THREAD_SERVER_NAME, SLACK_THREAD_TOOL_NAMES } from "../tools/slack-thread-tools.js";
import type { SlackThreadReader } from "../tools/slack-thread-tools.js";

// System prompt fragment injected into Slack sessions — tells the model it can fetch thread context via read_thread.
// Kept in English to match the tone of the base prompt (SYSTEM_PROMPT_BASE), which is in English.
export const SLACK_THREAD_HINT =
  "This conversation is a Slack thread. If the user's question seems to depend on earlier discussion you can't see (messages before or after in the thread), call the read_thread tool to fetch that context before answering.";

// For a Slack session, builds the capability with that thread's read_thread tool + hint (daemon→SessionManager.makeCapabilities).
// For non-Slack, returns undefined → base only. Even if the reader holder is empty (not connected), the tool returns a guidance string (mirrors makeSlackCanUseTool).
// read_thread travels via caps.toolDefs (the provider-neutral port, P2.5 Track C) rather than an opaque
// caps.mcpServers entry: master-agent.ts's doTurn merges toolDefs into the same defs record the base
// memory/repos/fleet groups travel on, so the Claude adapter wraps it with createSdkMcpServer (same as
// before) while the Codex adapter flattens it onto the daemon MCP bridge — giving a codex slack session
// (settings.slackProvider()==="codex") the read_thread tool too, not just Claude.
export function makeSlackCapabilities(
  externalKey: string | null,
  getReader: () => SlackThreadReader | null,
): (() => TurnCapabilities) | undefined {
  const target = parseSlackThreadKey(externalKey);
  if (!target) return undefined;
  return () => ({
    toolDefs: { [SLACK_THREAD_SERVER_NAME]: slackThreadToolDefs(getReader, target.channel, target.threadTs) },
    allowedTools: [...SLACK_THREAD_TOOL_NAMES],
    systemPromptAppend: SLACK_THREAD_HINT,
  });
}
