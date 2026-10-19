// Curated wire types for the `codex app-server` JSON-RPC protocol.
// Ground truth: `codex app-server generate-ts` output, Codex CLI 0.163.0 (2026-10-19).
// History: 0.142.5 (2026-07-06) -> 0.144.1 (2026-07-11, multi-agent/collab item vocabulary)
// -> 0.163.0 (2026-10-19). Minimum supported CLI: 0.146.1 (enforced from the `initialize`
// userAgent, see codex-version.ts). Fields newer than the minimum are optional and gated by version.
// Regenerate with that command after any CLI bump and diff against these types.
// Inbound decode is TOLERANT by design: unknown notification methods, unknown item
// types, and extra fields are ignored (0.x protocol churn).

export type CodexApprovalPolicy = "untrusted" | "on-request" | "never";
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
// `excludeTurns` skips the deprecated full-history hydration in the response. Accepted WITHOUT the
// experimentalApi capability only from CLI 0.151.0 (older CLIs reject it with -32600) — only send
// it after the version check (codex-version.ts EXCLUDE_TURNS_MIN_VERSION).
export interface CodexThreadResumeParams extends CodexThreadStartParams { threadId: string; excludeTurns?: boolean }
export interface CodexThreadForkParams { threadId: string; excludeTurns?: boolean }
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
  // Added in 0.163.0. No published cache-write price exists, so cost accounting does not bill it.
  cacheWriteInputTokens?: number;
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
  tool?: string; // spawnAgent | sendInput | resumeAgent | wait | closeAgent (+ sendMessage | followupTask | interruptAgent | listAgents since 0.163.0)
  status?: string; // inProgress | completed | failed (+ interrupted since 0.163.0); anything but "completed" maps to an error result
  senderThreadId?: string;
  receiverThreadIds?: string[];
  prompt?: string | null;
  model?: string | null;
}
export interface CodexSubAgentActivityItem {
  type: "subAgentActivity";
  id: string;
  kind?: string; // started | interacted | interrupted (+ completed since 0.163.0)
  agentThreadId?: string;
  agentPath?: string;
  model?: string | null; // since 0.163.0
  reasoningEffort?: string | null; // since 0.163.0
}
