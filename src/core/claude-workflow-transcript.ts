import type { WorkerEventData } from "./events.js";
import type {
  WorkflowAgentHistoryEntry,
  WorkflowAgentMetadata,
  WorkflowPhaseSummary,
  WorkflowProgressMetadata,
} from "./workflow-activity.js";
import { truncateBytes } from "./truncate.js";

const MAX_LINE_BYTES = 1_048_576;
const MAX_RUN_STATE_BYTES = 16 * 1_048_576;
const MAX_FIELD_BYTES = 4_000;
const MAX_HISTORY_EVENTS = 200;
const MAX_PHASES = 256;
const MAX_RUN_AGENTS = 10_000;
const MAX_PROGRESS_ENTRIES = 50_000;

export type WorkflowJournalRecord = { type: "started" | "result"; agentId: string };
export type WorkflowAgentMeta = { agentType: string; spawnDepth: number };
export type WorkflowRunAgentMetadata = WorkflowAgentMetadata;
export type WorkflowRunStateMetadata = WorkflowProgressMetadata;
export type WorkflowAgentDelta = {
  at: number;
  activity: "thinking" | "responding" | "tool";
  agentType?: string;
  lastToolName?: string;
  toolUses: number;
};

function objectOf(line: string): Record<string, unknown> | null {
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) return null;
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function boundedText(value: unknown, maxBytes = 256): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return truncateBytes(value, maxBytes);
}

function phaseIndex(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_PHASES ? value : undefined;
}

export function parseWorkflowRunState(text: string): WorkflowRunStateMetadata | null {
  if (Buffer.byteLength(text, "utf8") > MAX_RUN_STATE_BYTES) return null;
  let root: Record<string, unknown> | null = null;
  try { root = plainObject(JSON.parse(text) as unknown); }
  catch { return null; }
  if (!root) return null;

  return parseWorkflowProgress(root.workflowProgress, root.phases);
}

/**
 * Decode Claude's live `task_progress.workflow_progress` payload. This field is not
 * currently declared by the public SDK types, so this function is the strict privacy
 * and resource boundary between the raw provider frame and provider-neutral events.
 */
export function parseWorkflowProgress(progressValue: unknown, declaredPhases?: unknown): WorkflowRunStateMetadata {
  const phases = new Map<number, WorkflowPhaseSummary>();
  if (Array.isArray(declaredPhases)) {
    for (const [offset, raw] of declaredPhases.slice(0, MAX_PHASES).entries()) {
      const value = plainObject(raw);
      const title = boundedText(value?.title);
      if (!title) continue;
      const index = offset + 1;
      const detail = boundedText(value?.detail, MAX_FIELD_BYTES);
      const model = boundedText(value?.model);
      phases.set(index, { index, title, ...(detail ? { detail } : {}), ...(model ? { model } : {}) });
    }
  }

  const agents = new Map<string, WorkflowRunAgentMetadata>();
  if (Array.isArray(progressValue)) {
    // Phase declarations are seeded at the head; current agent updates are at the tail.
    // Preserve both ends when a malicious or runaway payload exceeds our scan budget.
    const progress = progressValue.length <= MAX_PROGRESS_ENTRIES
      ? progressValue
      : [...progressValue.slice(0, MAX_PHASES), ...progressValue.slice(-MAX_PROGRESS_ENTRIES)];
    for (const raw of progress) {
      const value = plainObject(raw);
      if (!value) continue;
      if (value.type === "workflow_phase") {
        const index = phaseIndex(value.index);
        const title = boundedText(value.title);
        if (index && title && !phases.has(index)) phases.set(index, { index, title });
        continue;
      }
      if (value.type !== "workflow_agent") continue;
      const agentId = boundedText(value.agentId, 128);
      if (!agentId || !/^[A-Za-z0-9_-]{1,128}$/.test(agentId)) continue;
      if (!agents.has(agentId) && agents.size >= MAX_RUN_AGENTS) continue;
      const label = boundedText(value.label);
      const index = phaseIndex(value.phaseIndex);
      const phaseTitle = boundedText(value.phaseTitle);
      const model = boundedText(value.model);
      agents.set(agentId, {
        agentId,
        ...(label ? { label } : {}),
        ...(index ? { phaseIndex: index } : {}),
        ...(phaseTitle ? { phaseTitle } : {}),
        ...(model ? { model } : {}),
      });
    }
  }

  return {
    phases: [...phases.values()].sort((a, b) => a.index - b.index),
    agents: [...agents.values()],
  };
}

export function parseWorkflowJournalLine(line: string): WorkflowJournalRecord | null {
  const value = objectOf(line);
  if (!value || (value.type !== "started" && value.type !== "result") || typeof value.agentId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.agentId)) return null;
  return { type: value.type, agentId: value.agentId };
}

export function parseWorkflowAgentMeta(text: string): WorkflowAgentMeta {
  const value = objectOf(text);
  return {
    agentType: typeof value?.agentType === "string" && value.agentType ? truncateBytes(value.agentType, 256) : "workflow-subagent",
    spawnDepth: typeof value?.spawnDepth === "number" && Number.isInteger(value.spawnDepth) && value.spawnDepth >= 0 ? value.spawnDepth : 1,
  };
}

function blocksOf(value: Record<string, unknown>): Array<Record<string, unknown>> {
  const message = value.message;
  if (!message || typeof message !== "object") return [];
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? content.filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === "object") : [];
}

export function parseWorkflowAgentLine(line: string): WorkflowAgentDelta | null {
  const value = objectOf(line);
  const at = typeof value?.timestamp === "string" ? Date.parse(value.timestamp) : Number.NaN;
  if (!value || !Number.isFinite(at) || value.type !== "assistant") return null;
  const blocks = blocksOf(value);
  const tools = blocks.filter((block) => block.type === "tool_use" && typeof block.name === "string");
  const common = typeof value.attributionAgent === "string" ? { agentType: truncateBytes(value.attributionAgent, 256) } : {};
  const lastTool = tools.at(-1);
  if (lastTool) return { at, activity: "tool", lastToolName: truncateBytes(String(lastTool.name), 256), toolUses: tools.length, ...common };
  if (blocks.some((block) => block.type === "thinking")) return { at, activity: "thinking", toolUses: 0, ...common };
  if (blocks.some((block) => block.type === "text")) return { at, activity: "responding", toolUses: 0, ...common };
  return null;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => block && typeof block === "object" && (block as { type?: string }).type === "text" ? String((block as { text?: unknown }).text ?? "") : "").join("");
}

function historyOf(line: string): WorkflowAgentHistoryEntry[] {
  const value = objectOf(line);
  if (!value || (value.type !== "assistant" && value.type !== "user")) return [];
  const createdAt = typeof value.timestamp === "string" && Number.isFinite(Date.parse(value.timestamp)) ? value.timestamp : undefined;
  const entries: WorkflowAgentHistoryEntry[] = [];
  for (const block of blocksOf(value)) {
    let data: WorkerEventData | null = null;
    if (block.type === "thinking") data = { kind: "thinking", text: truncateBytes(String(block.thinking ?? ""), MAX_FIELD_BYTES) };
    else if (block.type === "text") data = { kind: "message", role: value.type === "assistant" ? "assistant" : "user", content: truncateBytes(String(block.text ?? ""), MAX_FIELD_BYTES) };
    else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
      let input = "{}";
      try { input = JSON.stringify(block.input ?? {}); } catch { input = String(block.input ?? ""); }
      data = { kind: "tool_use", id: block.id, name: block.name, input: truncateBytes(input, MAX_FIELD_BYTES) };
    } else if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      data = { kind: "tool_result", id: block.tool_use_id, isError: Boolean(block.is_error), content: truncateBytes(textOf(block.content), MAX_FIELD_BYTES) };
    }
    if (data) entries.push({ data, ...(createdAt ? { createdAt } : {}) });
  }
  return entries;
}

export function parseWorkflowAgentHistory(text: string): WorkflowAgentHistoryEntry[] {
  return text.split(/\r?\n/).flatMap(historyOf).slice(-MAX_HISTORY_EVENTS);
}
