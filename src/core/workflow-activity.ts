import type { WorkerEventData } from "./events.js";

export type WorkflowRunStatus = "running" | "completed" | "failed" | "stopped";
export type WorkflowVisibility = "live" | "summary-only";
export type WorkflowAgentStatus = "running" | "completed" | "stopped";
export type WorkflowWarning = "limited-visibility" | "partial-data";

export interface WorkflowUsage {
  totalTokens: number;
  toolUses: number;
  durationMs: number;
}

export interface WorkflowPhaseSummary {
  index: number;
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowAgentMetadata {
  agentId: string;
  label?: string;
  phaseIndex?: number;
  phaseTitle?: string;
  model?: string;
}

export interface WorkflowProgressMetadata {
  phases: WorkflowPhaseSummary[];
  agents: WorkflowAgentMetadata[];
}

export interface WorkflowLaunch {
  taskId: string;
  toolUseId: string;
  runId: string;
  workflowName: string;
  summary: string;
  transcriptDir: string;
  scriptPath?: string;
}

export interface WorkflowTaskUpdate {
  taskId: string;
  phase: "started" | "progress" | "settled";
  workflowName?: string;
  description?: string;
  summary?: string;
  lastToolName?: string;
  usage?: WorkflowUsage;
  progress?: WorkflowProgressMetadata;
  outcome?: "completed" | "failed" | "stopped";
}

export interface WorkflowAgentSummary {
  agentId: string;
  agentType: string;
  label?: string;
  phaseIndex?: number;
  phaseTitle?: string;
  model?: string;
  spawnDepth: number;
  status: WorkflowAgentStatus;
  activity: "starting" | "thinking" | "responding" | "tool" | "complete" | "stopped";
  lastToolName?: string;
  toolUses: number;
  startedAt: number;
  lastActivityAt: number;
  endedAt?: number;
}

export interface WorkflowRunSummary {
  taskId: string;
  toolUseId?: string;
  runId?: string;
  workflowName: string;
  summary: string;
  lastToolName?: string;
  status: WorkflowRunStatus;
  visibility: WorkflowVisibility;
  warning?: WorkflowWarning;
  startedAt: number;
  lastActivityAt: number;
  endedAt?: number;
  usage?: WorkflowUsage;
  phases?: WorkflowPhaseSummary[];
  counts: { started: number; active: number; completed: number; stopped: number };
}

export interface WorkflowRunSnapshot extends WorkflowRunSummary {
  agents: WorkflowAgentSummary[];
}

export interface WorkflowOwner {
  sessionId: string;
  workerId: string;
  sdkSessionId: string | null;
}

export interface WorkflowAgentHistoryEntry {
  data: WorkerEventData;
  createdAt?: string;
}

export interface WorkflowActivitySink {
  launched(owner: WorkflowOwner, launch: WorkflowLaunch): void;
  taskUpdated(owner: WorkflowOwner, update: WorkflowTaskUpdate): void;
  stopWorker(workerId: string): void;
}

export interface WorkflowActivityProvider {
  list(workerId: string): WorkflowRunSnapshot[];
  agentHistory(workerId: string, taskId: string, agentId: string): Promise<WorkflowAgentHistoryEntry[]>;
}
