import type { SystemPush } from "./system-push.js";

// Provider-neutral agent backend port (P0 seam — docs/2026-07-05-codex-backend-parity.md).
// Both stream loops (Worker/MasterAgent) consume only this vocabulary; adapters (claude-backend.ts,
// later a Codex backend) translate their provider's wire messages into it.

// A single slash command/skill. Lives here as neutral vocabulary; commands.ts re-exports it
// so its existing importers (worker, fleet-orchestrator, system-push, protocol) keep compiling.
export interface SlashCommandInfo {
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
}

// Opaque provider-specific handles: the core passes these through untouched;
// only the adapter knows (and casts back to) the real shapes.
export type ProviderMcpServer = unknown;
export type ProviderPermissionCallback = unknown;

export type AgentEvent =
  // Provider session id, emitted EARLY (on the init system message) and again on turn end —
  // an interrupt before the first turn end must not orphan resume (see worker.ts/master-agent.ts capture comments).
  | { kind: "session_id"; sessionId: string }
  | { kind: "text_delta"; text: string } // token-level answer delta (live only; non-nested only)
  | { kind: "thinking_delta"; text: string } // thinking-summary delta (live only; non-nested only)
  // Completed message text. role "user" is provider-injected content (skill body/context), never human input.
  // parentToolUseId marks native nested-subagent traffic (worker shows it in panels; master skips it).
  | { kind: "message"; role: "assistant" | "user"; text: string; parentToolUseId: string | null }
  | { kind: "tool_use"; id: string; name: string; input: unknown; parentToolUseId: string | null }
  | { kind: "tool_result"; toolUseId: string; isError: boolean; content: string; parentToolUseId: string | null }
  | { kind: "tool_progress"; toolUseId: string; elapsedSec: number } // live only
  // Classified provider push (commands_changed / compaction / retry / fallback …) — see system-push.ts.
  | { kind: "push"; push: SystemPush }
  | { kind: "system_text"; text: string } // unclassified system message (e.g. init)
  // End of one turn. costUsd/numTurns/durationMs are THIS turn's raw values (numTurns is the provider's
  // per-send cumulative agentic turn count) — consumers accumulate their own session totals.
  | { kind: "turn_end"; subtype: string; costUsd: number; numTurns: number; durationMs: number; contextTokens: number; contextWindow: number };

// One live agent stream: async-iterate the events; control the underlying session via the methods.
// Controls are best-effort: adapters must resolve (not throw) when the underlying session lacks a control.
export interface AgentStream extends AsyncIterable<AgentEvent> {
  interrupt(): Promise<void>;
  setModel(model: string): Promise<void>;
  setPermissionMode(mode: string): Promise<void>;
  supportedCommands(): Promise<SlashCommandInfo[]>;
}

export interface AgentSessionOptions {
  cwd: string;
  model: string;
  effort?: string; // adapter decides applicability (e.g. Haiku rejects effort — a 400)
  permissionMode: string;
  systemPromptAppend?: string; // appended to the provider's base agent prompt (claude_code preset on Claude)
  resume?: string | null; // provider session id to resume (null/undefined → fresh session)
  abortController: AbortController;
}

// Master-turn extras: provider-specific tool wiring, passed through opaquely (P2 will neutralize these).
export interface MasterTurnOptions extends AgentSessionOptions {
  mcpServers?: Record<string, ProviderMcpServer>;
  allowedTools?: string[];
  disallowedTools?: string[];
  canUseTool?: ProviderPermissionCallback;
}

export interface AgentBackend {
  // Long-lived streaming-input session (worker): one stream spanning many turns; push follow-ups via `input`.
  openSession(input: AsyncIterable<string>, opts: AgentSessionOptions): AgentStream;
  // Single turn with resume-based continuity (master): the stream ends when the turn completes.
  startTurn(prompt: string, opts: MasterTurnOptions): AgentStream;
}
