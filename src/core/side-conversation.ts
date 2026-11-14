import { acceptImages, resolveInput, type AgentInput, type ImageResolver, type ImageRef } from "./image-input.js";
import type { SpeedPreference } from "./speed.js";
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
  // Claude only: the source's last persisted provider cost total. The Side fork continues from the source's
  // running total, so this baseline keeps the Side's cost display to its own turns.
  costBaselineUsd?: number;
  model: string;
  speed?: SpeedPreference | (() => SpeedPreference);
  effort?: string;
  // Codex master forks use an ephemeral per-Side CODEX_HOME keyed by side id. Workers and Claude omit it.
  sessionKey?: string;
}

export interface SideCreateInput {
  sourceKind: SideSourceKind;
  sourceId: string;
  model?: string;
  effort?: string | null;
}

export interface SideStartInput extends SideCreateInput {
  text: string;
  images?: ImageRef[];
}

export interface PreparedSideStart {
  id: string;
  // Input bytes are already resolved. Emits the first events only after the caller acknowledges the id.
  start(): void;
}

export interface SideConversationDeps {
  images?: ImageResolver;
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
  costBaselineUsd?: number; // running provider total; starts at the source's, advanced per Side turn
  model: string;
  speed?: SpeedPreference | (() => SpeedPreference);
  effort?: string;
  running: boolean;
  closing: boolean;
  closeTask: Promise<void> | null;
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

  private async fork(input: SideCreateInput): Promise<SideConversation> {
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
      try { this.deps.cleanup?.(id, source); } catch { /* preserve the fork failure */ }
      throw error;
    }
    return {
      id,
      source: { ...source, ...(source.provider === "codex" && source.sourceKind === "master" ? { sessionKey: id } : {}) },
      sdkSessionId: forked.sessionId,
      ...(source.costBaselineUsd !== undefined ? { costBaselineUsd: source.costBaselineUsd } : {}),
      model: input.model?.trim() || source.model,
      speed: source.speed,
      effort: input.effort?.trim() || source.effort,
      running: false,
      closing: false,
      closeTask: null,
      abort: null,
      stream: null,
      task: Promise.resolve(),
    };
  }

  async create(input: SideCreateInput): Promise<{ id: string }> {
    const side = await this.fork(input);
    this.conversations.set(side.id, side);
    return { id: side.id };
  }

  async prepareStart(input: SideStartInput): Promise<PreparedSideStart> {
    const side = await this.fork(input);
    try {
      // Forking is asynchronous: revalidate and resolve the initial input AFTER it completes.
      // Keep this Side unregistered until preparation succeeds so a rejection emits no orphan events.
      const start = this.prepareTurn(side, input.text, input.images);
      this.conversations.set(side.id, side);
      return { id: side.id, start };
    } catch (error) {
      try { this.deps.cleanup?.(side.id, side.source); } catch { /* preserve the input failure */ }
      throw error;
    }
  }

  send(id: string, text: string, imageRefs?: ImageRef[]): void {
    this.prepareTurn(this.require(id), text, imageRefs)();
  }

  private prepareTurn(side: SideConversation, text: string, imageRefs?: ImageRef[]): () => void {
    const id = side.id;
    if (side.closing) throw new Error(`Side conversation ${id} is closing`);
    if (side.running) throw new Error(`Side conversation ${id} is already running`);
    const prompt = text.trim();
    const images = acceptImages(this.deps.images, imageRefs);
    if (!prompt && !images.length) throw new Error("Side question cannot be empty");
    const input = resolveInput(prompt, images, this.deps.images);
    side.running = true; // reserve the turn; no events/provider call until start() runs
    let started = false;
    return () => {
      if (started || side.closing) return;
      started = true;
      this.emitData(side, { kind: "message", role: "user", content: prompt, ...(images.length ? { images } : {}) });
      this.emitStatus(side, "running");
      side.task = this.runTurn(side, input);
    };
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
    // Disposal, failed acknowledgement and explicit close can all race to release one Side.
    await (side.closeTask ??= this.closeSide(side));
  }

  private async closeSide(side: SideConversation): Promise<void> {
    const { id } = side;
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

  private async runTurn(side: SideConversation, prompt: AgentInput): Promise<void> {
    const abort = new AbortController();
    side.abort = abort;
    try {
      const backend = this.deps.backends[side.source.provider]!;
      const stream = backend.startTurn(prompt, {
        cwd: side.source.cwd,
        model: side.model,
        effort: side.effort,
        speed: side.speed,
        permissionMode: "plan",
        systemPromptAppend: SIDE_SYSTEM_PROMPT,
        resume: side.sdkSessionId,
        ...(side.costBaselineUsd !== undefined ? { costBaselineUsd: side.costBaselineUsd } : {}),
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
        } else if (event.kind === "speed") {
          this.emitData(side, { kind: "speed", observation: event.observation });
        } else if (event.kind === "turn_end") {
          if (event.costTotalUsd !== undefined) side.costBaselineUsd = event.costTotalUsd;
          this.emitData(side, { kind: "result", subtype: event.subtype, costUsd: event.costUsd, costAccuracy: event.costAccuracy, requestedSpeed: event.requestedSpeed, numTurns: event.numTurns, durationMs: event.durationMs, contextTokens: event.contextTokens, contextWindow: event.contextWindow });
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
