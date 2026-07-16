// Pure extractor that pulls text, tool calls, and tool results from SDK messages (assistant/user).
// Shared by the master (master-agent) and the worker (worker) — keeping the decode logic in one place so the two stream loops don't diverge.
// (Previously worker.ts exported it and master imported it, creating a master→worker dependency edge.)
import type { WorkflowLaunch } from "./workflow-activity.js";
import { truncateBytes } from "./truncate.js";

// assistant.message.content is a block array → concatenate only the text blocks.
export function extractText(message: unknown): string {
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: "text"; text: string } =>
        typeof b === "object" && b !== null && (b as { type?: string }).type === "text",
      )
      .map((b) => b.text)
      .join("");
  }
  return "";
}

export function extractToolUses(message: unknown): Array<{ id: string; name: string; input: unknown }> {
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (b): b is { type: "tool_use"; id: string; name: string; input?: unknown } =>
        typeof b === "object" && b !== null && (b as { type?: string }).type === "tool_use",
    )
    .map((b) => ({ id: b.id, name: b.name, input: b.input }));
}

export function extractToolResults(message: unknown): Array<{ toolUseId: string; isError: boolean; content: string }> {
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (b): b is { type: "tool_result"; tool_use_id: string; is_error?: boolean; content?: unknown } =>
        typeof b === "object" && b !== null && (b as { type?: string }).type === "tool_result",
    )
    .map((b) => ({ toolUseId: b.tool_use_id, isError: Boolean(b.is_error), content: blockText(b.content) }));
}

export function extractWorkflowLaunch(message: unknown): WorkflowLaunch | null {
  const raw = (message as { tool_use_result?: unknown }).tool_use_result;
  if (!raw || typeof raw !== "object") return null;
  const result = raw as Record<string, unknown>;
  if (result.status !== "async_launched" || result.taskType !== "local_workflow") return null;
  const taskId = typeof result.taskId === "string" ? result.taskId : "";
  const runId = typeof result.runId === "string" ? result.runId : "";
  const workflowName = typeof result.workflowName === "string" ? result.workflowName : "";
  const transcriptDir = typeof result.transcriptDir === "string" ? result.transcriptDir : "";
  const toolUseId = extractToolResults(message)[0]?.toolUseId ?? "";
  if (!taskId || taskId.length > 512 || !toolUseId || typeof toolUseId !== "string" || toolUseId.length > 512 || !runId || runId.length > 256 || !workflowName || !transcriptDir) return null;
  return {
    taskId,
    toolUseId,
    runId,
    workflowName: truncateBytes(workflowName, 256),
    summary: typeof result.summary === "string" ? truncateBytes(result.summary, 4_000) : "",
    transcriptDir,
    ...(typeof result.scriptPath === "string" && result.scriptPath ? { scriptPath: result.scriptPath } : {}),
  };
}

// tool_result.content may be a string or an array of {type:text,text} blocks → coerce to text.
function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "object" && b !== null && (b as { type?: string }).type === "text" ? String((b as { text?: string }).text ?? "") : ""))
      .join("");
  }
  return "";
}
