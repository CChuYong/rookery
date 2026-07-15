import type { SystemPush } from "./system-push.js";
import type { ResolvedAgentCapabilities } from "./capabilities/types.js";

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

// Neutral in-process tool definition (structurally the Claude SDK's SdkMcpToolDefinition and the
// bridge's BridgeToolDef — assignability pinned by tests). Handlers close over live daemon objects.
export type ProviderToolDef = { name: string; description: string; inputSchema: Record<string, unknown>; handler: (args: never, extra: unknown) => Promise<unknown> };

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
  // Harness-tracked background task lifecycle (Claude only: run_in_background shells, backgrounded
  // subagents, monitors, workflows — docs/superpowers/specs/2026-07-11-worker-state-graph-design.md).
  // "started" adds it to the worker's running set; "settled" removes it (completed/failed/killed/stopped
  // are all just "settled" here — the state machine only needs the count). Codex does not emit
  // this YET: unawaited collab child threads DO outlive the turn (live-verified 2026-07-11,
  // probe-collab-nowait.mjs) but are only surfaced as nested-panel traffic, not background_task
  // (scope-A decision, docs/superpowers/specs/2026-07-11-codex-nested-agents-design.md).
  | { kind: "background_task"; taskId: string; taskType?: string; status: "started" | "settled" }
  // Level form of the same signal (SDK ≥0.3.203 background_tasks_changed): the FULL live-task set after a
  // membership change — REPLACE semantics. SDK guidance: do not correlate with the edge frames above; once
  // a consumer sees a level frame it should trust levels only (Worker latches edges out on first sight).
  | { kind: "background_tasks"; tasks: Array<{ taskId: string; taskType: string }> }
  // End of one turn. costUsd/numTurns/durationMs are THIS turn's raw values (numTurns is the provider's
  // per-send cumulative agentic turn count) — consumers accumulate their own session totals.
  // terminalReason: opaque provider diagnostic (Claude result.terminal_reason; absent on codex) — carried
  // for observability only, never branched on (live-verified 2026-07-11: bg detection rests on task frames).
  | { kind: "turn_end"; subtype: string; costUsd: number; numTurns: number; durationMs: number; contextTokens: number; contextWindow: number; terminalReason?: string };

// The SDK's typed interrupt receipt (0.3.205+ Query.interrupt() resolution), neutralized.
// still_queued: uuids of async user messages that survive the interrupt. [] does NOT mean
// "nothing will run" (unstamped messages are never listed) and may include internally-enqueued
// uuids — consumers surface a COUNT only, never the ids.
export interface InterruptReceipt {
  stillQueued: string[];
}

// One live agent stream: async-iterate the events; control the underlying session via the methods.
// Controls are best-effort: adapters must resolve (not throw) when the underlying session lacks a control.
export interface AgentStream extends AsyncIterable<AgentEvent> {
  interrupt(): Promise<InterruptReceipt | undefined>;
  setModel(model: string): Promise<void>;
  setPermissionMode(mode: string): Promise<void>;
  supportedCommands(): Promise<SlashCommandInfo[]>;
  // Optional: suspend/resume a provider's per-turn inactivity watchdog while a blocking interaction
  // (AskUserQuestion / approval) awaits a human — the master brackets its ask closure with these so a
  // long human think-time isn't mistaken for a wedged turn. Only the Codex adapter has such a watchdog;
  // Claude omits these (callers use `?.()`), which is a no-op there by design.
  pauseIdleWatchdog?(): void;
  resumeIdleWatchdog?(): void;
}

export interface AgentSessionOptions {
  cwd: string;
  model: string;
  effort?: string; // adapter decides applicability (e.g. Haiku rejects effort — a 400)
  permissionMode: string;
  systemPromptAppend?: string; // appended to the provider's base agent prompt (claude_code preset on Claude)
  resume?: string | null; // provider session id to resume (null/undefined → fresh session)
  abortController: AbortController;
  // Stable Rookery target identity. Required whenever managed capabilities are supplied.
  runtimeKey?: string;
  // Secret-free desired projection. Provider adapters lower it using daemon-injected runtime ports.
  capabilities?: ResolvedAgentCapabilities;
}

// Master-turn extras: provider-specific tool wiring, passed through opaquely (P2 will neutralize these).
export interface MasterTurnOptions extends AgentSessionOptions {
  // Ephemeral Side conversations run a master-style resumed turn without daemon MCP tools. Adapters
  // enforce a provider-native read-only boundary (Claude plan/read tools; Codex read-only sandbox).
  readOnly?: boolean;
  // Base in-process tool servers as RAW definitions (server name → defs). Claude adapter wraps them
  // with createSdkMcpServer; Codex adapter registers them on the daemon MCP bridge for the session.
  toolDefs?: Record<string, ProviderToolDef[]>;
  // The rookery session id — used to key the master's registration on the Codex adapter's MCP bridge.
  sessionKey?: string;
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
