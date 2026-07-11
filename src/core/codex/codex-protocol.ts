// Curated wire types for the `codex app-server` JSON-RPC protocol.
// Ground truth: `codex app-server generate-ts` output, Codex CLI 0.142.5 (2026-07-06),
// regenerated from CLI 0.144.1 (2026-07-11) which introduced the multi-agent (collab)
// item vocabulary below.
// Regenerate with that command after any CLI bump and diff against these types.
// Inbound decode is TOLERANT by design: unknown notification methods, unknown item
// types, and extra fields are ignored (0.x protocol churn).

export type CodexApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexTurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

// Per-turn sandbox override (TurnStartParams.sandboxPolicy) uses the object form.
export type CodexSandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess: boolean }
  | { type: "workspaceWrite"; writableRoots: string[]; networkAccess: boolean; excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean };

export interface CodexThread {
  id: string;
  sessionId?: string;
  forkedFromId?: string | null;
  parentThreadId?: string | null;
}

export interface CodexTurnError { message?: string }

export interface CodexTurn {
  id: string;
  status?: CodexTurnStatus;
  error?: CodexTurnError | null;
  durationMs?: number | null;
}

// Outbound input item (we only send text in P1). `text_elements` is required by the schema.
export interface CodexTextInput { type: "text"; text: string; text_elements: never[] }

export interface CodexThreadStartParams {
  cwd?: string;
  model?: string;
  approvalPolicy?: CodexApprovalPolicy;
  sandbox?: CodexSandboxMode;
  developerInstructions?: string;
}
export interface CodexThreadResumeParams extends CodexThreadStartParams { threadId: string }
export interface CodexThreadForkParams { threadId: string }
export interface CodexTurnStartParams {
  threadId: string;
  input: CodexTextInput[];
  model?: string;
  effort?: string;
  approvalPolicy?: CodexApprovalPolicy;
  sandboxPolicy?: CodexSandboxPolicy;
}
export interface CodexTurnInterruptParams { threadId: string; turnId: string }

// Inbound shapes (duck-typed at decode sites; these document the fields we read).
export interface CodexThreadStartResponse { thread?: CodexThread }
export interface CodexTokenUsageBreakdown {
  totalTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}
export interface CodexThreadTokenUsage {
  total?: CodexTokenUsageBreakdown;
  last?: CodexTokenUsageBreakdown;
  modelContextWindow?: number | null;
}

// Multi-agent (collab) items — 0.144.x protocol (`multi_agent` feature, stable/default-on).
// Both arrive as thread items on the SPAWNING thread; child-thread activity arrives as ordinary
// item/* notifications tagged with the child's threadId (live-probed 2026-07-11,
// .superpowers/sdd/probe-collab-spawn.mjs / probe-collab-nowait.mjs).
export interface CodexCollabAgentToolCallItem {
  type: "collabAgentToolCall";
  id: string;
  tool?: string; // spawnAgent | sendInput | resumeAgent | wait | closeAgent
  status?: string; // inProgress | completed | failed (observed values)
  senderThreadId?: string;
  receiverThreadIds?: string[];
  prompt?: string | null;
  model?: string | null;
}
export interface CodexSubAgentActivityItem {
  type: "subAgentActivity";
  id: string;
  kind?: string; // started | interacted | interrupted
  agentThreadId?: string;
  agentPath?: string;
}
