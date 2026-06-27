export type WorkerEventData =
  | { kind: "system"; text: string }
  | { kind: "message"; role: "assistant" | "user"; content: string }
  | { kind: "message_delta"; text: string } // token-level delta (not persisted, for live streaming)
  | { kind: "thinking_delta"; text: string } // thinking-summary delta (not persisted, live — display:summarized)
  | { kind: "thinking"; text: string } // coalesced thinking summary (persisted, persist-only — live is shown via deltas). Worker counterpart of master master.thinking
  | { kind: "tool_use"; id: string; name: string; input: string }
  | { kind: "tool_result"; id: string; isError: boolean; content: string }
  | { kind: "tool_progress"; id: string; elapsedSec: number } // elapsed seconds of an in-progress tool (live only)
  | { kind: "result"; subtype: string; costUsd: number; numTurns: number; durationMs?: number; contextTokens?: number; contextWindow?: number }
  | { kind: "notice"; text: string } // informational system push (compaction/retry/fallback) — shown as a single-line chip in the conversation
  | { kind: "error"; message: string };

export type SlackStatus = "unconfigured" | "off" | "connecting" | "up" | "error";

// A single question that surfaces the master's canUseTool (approval/AskUserQuestion) to non-Slack clients (desktop).
export interface InteractionQuestion {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export type CoreEvent =
  | { type: "master.message"; sessionId: string; role: "assistant" | "user"; content: string; clientMsgId?: string }
  | { type: "master.message.delta"; sessionId: string; delta: string }
  | { type: "master.thinking.delta"; sessionId: string; delta: string } // master thinking-summary delta (live)
  | { type: "master.thinking"; sessionId: string; text: string } // completed thinking summary (for persistence/restore — unlike deltas, coalesced into a single entry)
  | { type: "master.system"; sessionId: string; text: string }
  // Master's informational system push (compaction/retry/fallback) → shown as a notice in the conversation.
  // code/params let clients re-localize (desktop renderer i18n); text is the DEFAULT_LOCALE pre-render for dumb consumers.
  | { type: "master.notice"; sessionId: string; text: string; code?: string; params?: Record<string, string | number> }
  // SDK pushes command/skill list changes (commands_changed) → refresh the / candidates if in the active context.
  | { type: "commands.changed"; sessionId: string; scopeId: string; commands: import("./commands.js").SlashCommandInfo[] }
  | { type: "master.result"; sessionId: string; subtype: string; costUsd: number; numTurns: number; durationMs: number; contextTokens: number; contextWindow: number }
  // Master turn progress state (running↔idle) — corresponds to the worker's worker.status. Live pulse in the UI session list.
  | { type: "master.status"; sessionId: string; status: "running" | "idle" }
  // When the master session label is filled in by auto-generation (Haiku) — live refresh of the UI session list.
  | { type: "session.label"; sessionId: string; label: string }
  // status: the worker's initial state — "provisioning" while its worktree is still being created (emitted up-front so the UI
  // shows the row immediately), reconciled to running/idle once the agent boots. Omitted (back-compat) ⇒ treated as "running".
  | { type: "worker.spawned"; sessionId: string; workerId: string; repoPath: string; label: string; branch?: string; status?: string; ticketKey?: string | null; ticketUrl?: string | null }
  // clientMsgId: a live-only correlation key carried only on the user echo — used to reconcile the desktop pending bubble (absent from the persisted payload).
  | { type: "worker.event"; sessionId: string; workerId: string; seq: number; data: WorkerEventData; clientMsgId?: string }
  // Native nested subagent (SDK subagent spawned by a worker via Task) activity — live only (not persisted), grouped by parentToolUseId.
  | { type: "worker.nested"; sessionId: string; workerId: string; parentToolUseId: string; data: WorkerEventData }
  | { type: "worker.status"; sessionId: string; workerId: string; status: string }
  // When label auto-generation (Haiku) updates the placeholder to a better label — for live UI updates.
  | { type: "worker.label"; sessionId: string; workerId: string; label: string }
  | { type: "master.tool"; sessionId: string; toolId: string; name: string; phase: "start" | "end" | "progress"; ok?: boolean; input?: string; result?: string; elapsedSec?: number }
  | { type: "slack.status"; sessionId: string; status: SlackStatus }
  // Master canUseTool → inline approval/question card on non-Slack clients (desktop). The master turn waits until a respond arrives.
  | { type: "interaction.request"; sessionId: string; requestId: string; kind: "approve" | "ask"; toolName?: string; inputText?: string; questions?: InteractionQuestion[] }
  // Response handling done → replace the card with a result summary (remove buttons). Other clients/reloads of the same session also sync.
  | { type: "interaction.resolved"; sessionId: string; requestId: string; summary: string }
  | { type: "automation.changed"; sessionId: string }
  | { type: "error"; sessionId: string; message: string };

type Listener = (event: CoreEvent) => void;

export const FLEET_CHANNEL = "@fleet";
// Global channel through which all events flow — by subscribing to just this one, the UI's unified monitoring screen receives all sessions/fleet live.
export const ALL_CHANNEL = "@all";

export class EventBus {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly warnedListeners = new WeakSet<Listener>();

  subscribe(sessionId: string, listener: Listener): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      const s = this.listeners.get(sessionId);
      s?.delete(listener);
      if (s && s.size === 0) this.listeners.delete(sessionId);
    };
  }

  emit(event: CoreEvent): void {
    this.deliver(event.sessionId, event);
    // Worker events are also delivered to the global fleet channel → the GUI can observe live without opening each session.
    if (event.type.startsWith("worker.") && event.sessionId !== FLEET_CHANNEL) {
      this.deliver(FLEET_CHANNEL, event);
    }
    // All events are also delivered to the global @all channel → unified UI monitoring (syncs sessions/fleet across all paths).
    if (event.sessionId !== ALL_CHANNEL) {
      this.deliver(ALL_CHANNEL, event);
    }
  }

  private deliver(key: string, event: CoreEvent): void {
    const set = this.listeners.get(key);
    if (!set) return;
    for (const listener of [...set]) {
      try { listener(event); }
      catch (err) {
        if (!this.warnedListeners.has(listener)) {
          this.warnedListeners.add(listener);
          console.error("[EventBus] listener error (further errors from this listener suppressed until it unsubscribes):", err);
        }
      }
    }
  }
}
