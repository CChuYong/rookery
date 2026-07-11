import type { LogItem } from "../store/reduce.js";

// Nested-agent panel label, from the main-transcript tool card whose toolId equals the panel key:
// Claude → the Task call's subagent_type/description; Codex → the spawn_agent card's agentPath
// (the panel key IS the child threadId there — see codex-backend.ts spawnCardsOf). The input JSON
// may be truncated at 4000 chars, so extract robustly with regexes instead of JSON.parse.
export function nestedLabel(mainLog: LogItem[], parentId: string): string {
  const tool = mainLog.find((i) => i.kind === "tool" && i.toolId === parentId);
  const input = tool && tool.kind === "tool" ? (tool.input ?? "") : "";
  const sub = input.match(/"subagent_type"\s*:\s*"([^"]+)"/)?.[1];
  const desc = input.match(/"description"\s*:\s*"([^"]+)"/)?.[1];
  const agentPath = input.match(/"agentPath"\s*:\s*"([^"]+)"/)?.[1];
  return [sub, desc].filter(Boolean).join(": ") || agentPath || `worker ${parentId.slice(0, 6)}`;
}
