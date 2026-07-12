import { randomUUID } from "node:crypto";
import type { AgentBackend, AgentStream } from "./agent-backend.js";
import type { EventBus, WorkerEventData } from "./events.js";
import { truncateBytes } from "./truncate.js";

export type SideSourceKind = "master" | "worker";

export interface SideSource {
  sourceKind: SideSourceKind;
  sourceId: string;
  // Owning master session used only for EventBus routing. A worker source supplies its home session.
  sessionId: string;
  provider: string;
  cwd: string;
  sdkSessionId: string | null;
  model: string;
  effort?: string;
  // Codex master forks use an ephemeral per-Side CODEX_HOME keyed by side id. Workers and Claude omit it.
  sessionKey?: string;
}

export interface SideConversationDeps {
  bus: EventBus;
  backends: Record<string, AgentBackend>;
  resolveSource(kind: SideSourceKind, id: string): SideSource | undefined;
  forkSession(source: SideSource, sideId: string): Promise<{ sessionId: string }>;
  cleanup?: (sideId: string, source: SideSource) => void;
}

interface SideConversation {
  id: string;
  source: SideSource;
  sdkSessionId: string;
  model: string;
  effort?: string;
  running: boolean;
  closing: boolean;
  abort: AbortController | null;
  stream: AgentStream | null;
  task: Promise<void>;
}

const SIDE_SYSTEM_PROMPT =
  "You are answering a temporary Side question forked from another live conversation. " +
  "Use the inherited context and inspect the current working directory when helpful. " +
  "This is strictly read-only: never modify files, run commands that can change state, create commits, " +
  "spawn agents, or send messages. Explain clearly and keep the parent task independent.";

function textOf(value: unknown): string {
  try { return truncateBytes(JSON.stringify(value) ?? "", 4000); }
  catch { return truncateBytes(String(value), 4000); }
}

export class SideConversationManager {
  private readonly conversations = new Map<string, SideConversation>();

  constructor(
    private readonly deps: SideConversationDeps,
    private readonly idgen: () => string = () => randomUUID(),
  ) {}

  async create(input: { sourceKind: SideSourceKind; sourceId: string; model?: string; effort?: string | null }): Promise<{ id: string }> {
    const source = this.deps.resolveSource(input.sourceKind, input.sourceId);
    if (!source) throw new Error(`unknown source: ${input.sourceKind} ${input.sourceId}`);
    if (!source.sdkSessionId) throw new Error("source has no provider context yet — wait for its first turn to start");
    const backend = this.deps.backends[source.provider];
    if (!backend) throw new Error(`unsupported provider: ${source.provider}`);
    const id = this.idgen();
    let forked: { sessionId: string };
    try {
      forked = await this.deps.forkSession(source, id);
    } catch (error) {
      this.deps.cleanup?.(id, source);
      throw error;
    }
    this.conversations.set(id, {
      id,
      source: { ...source, ...(source.provider === "codex" && source.sourceKind === "master" ? { sessionKey: id } : {}) },
      sdkSessionId: forked.sessionId,
      model: input.model?.trim() || source.model,
      effort: input.effort?.trim() || source.effort,
      running: false,
      closing: false,
      abort: null,
      stream: null,
      task: Promise.resolve(),
    });
    return { id };
  }

  send(id: string, text: string): void {
    const side = this.require(id);
    if (side.closing) throw new Error(`Side conversation ${id} is closing`);
    if (side.running) throw new Error(`Side conversation ${id} is already running`);
    const prompt = text.trim();
    if (!prompt) throw new Error("Side question cannot be empty");
    side.running = true;
    this.emitData(side, { kind: "message", role: "user", content: prompt });
    this.emitStatus(side, "running");
    side.task = this.runTurn(side, prompt);
  }

  async idle(id: string): Promise<void> {
    await this.require(id).task;
  }

  async stop(id: string): Promise<void> {
    const side = this.require(id);
    side.abort?.abort();
    try { await side.stream?.interrupt(); } catch { /* best-effort */ }
  }

  async close(id: string): Promise<void> {
    const side = this.conversations.get(id);
    if (!side) return;
    side.closing = true;
    await this.stop(id);
    await side.task.catch(() => {});
    this.conversations.delete(id);
    this.emitStatus(side, "closed");
    try { this.deps.cleanup?.(id, side.source); } catch { /* best-effort */ }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.conversations.keys()].map((id) => this.close(id)));
  }

  private require(id: string): SideConversation {
    const side = this.conversations.get(id);
    if (!side) throw new Error(`unknown Side conversation: ${id}`);
    return side;
  }

  private emitData(side: SideConversation, data: WorkerEventData): void {
    const { source } = side;
    this.deps.bus.emit({ type: "side.event", sessionId: source.sessionId, sideId: side.id, sourceKind: source.sourceKind, sourceId: source.sourceId, data });
  }

  private emitStatus(side: SideConversation, status: "opening" | "running" | "idle" | "closed"): void {
    const { source } = side;
    this.deps.bus.emit({ type: "side.status", sessionId: source.sessionId, sideId: side.id, sourceKind: source.sourceKind, sourceId: source.sourceId, status });
  }

  private async runTurn(side: SideConversation, prompt: string): Promise<void> {
    const abort = new AbortController();
    side.abort = abort;
    try {
      const backend = this.deps.backends[side.source.provider]!;
      const stream = backend.startTurn(prompt, {
        cwd: side.source.cwd,
        model: side.model,
        effort: side.effort,
        permissionMode: "plan",
        systemPromptAppend: SIDE_SYSTEM_PROMPT,
        resume: side.sdkSessionId,
        abortController: abort,
        readOnly: true,
        ...(side.source.sessionKey ? { sessionKey: side.source.sessionKey, toolDefs: {} } : {}),
      });
      side.stream = stream;
      for await (const event of stream) {
        if (event.kind === "session_id") {
          side.sdkSessionId = event.sessionId;
        } else if (event.kind === "text_delta") {
          this.emitData(side, { kind: "message_delta", text: event.text });
        } else if (event.kind === "thinking_delta") {
          this.emitData(side, { kind: "thinking_delta", text: event.text });
        } else if (event.kind === "message" && event.role === "assistant" && !event.parentToolUseId) {
          this.emitData(side, { kind: "message", role: "assistant", content: event.text });
        } else if (event.kind === "tool_use" && !event.parentToolUseId) {
          this.emitData(side, { kind: "tool_use", id: event.id, name: event.name, input: textOf(event.input) });
        } else if (event.kind === "tool_result" && !event.parentToolUseId) {
          this.emitData(side, { kind: "tool_result", id: event.toolUseId, isError: event.isError, content: truncateBytes(event.content, 4000) });
        } else if (event.kind === "tool_progress") {
          this.emitData(side, { kind: "tool_progress", id: event.toolUseId, elapsedSec: event.elapsedSec });
        } else if (event.kind === "push" && event.push.kind !== "commands") {
          this.emitData(side, { kind: "notice", text: event.push.text });
        } else if (event.kind === "turn_end") {
          this.emitData(side, { kind: "result", subtype: event.subtype, costUsd: event.costUsd, numTurns: event.numTurns, durationMs: event.durationMs, contextTokens: event.contextTokens, contextWindow: event.contextWindow });
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) this.emitData(side, { kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      side.abort = null;
      side.stream = null;
      side.running = false;
      if (!side.closing) this.emitStatus(side, "idle");
    }
  }
}
