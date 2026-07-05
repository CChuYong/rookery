import type { AgentBackend, AgentEvent, AgentSessionOptions, AgentStream, MasterTurnOptions, SlashCommandInfo } from "../agent-backend.js";
import { t, DEFAULT_LOCALE } from "../i18n.js";
import { CodexClient } from "./codex-client.js";
import type { CodexSpawn } from "./codex-transport.js";
import type { CodexTextInput, CodexThreadStartParams, CodexThreadStartResponse, CodexThreadTokenUsage, CodexTurn } from "./codex-protocol.js";
import { mapPermissionMode, sandboxPolicyFor, mapEffort } from "./codex-vocab.js";
import { turnCostUsd } from "./codex-pricing.js";

export interface CodexBackendDeps {
  spawn: CodexSpawn;
  defaultModel: () => string; // Settings resolver — used when the session has no model (spawn override wins)
}

const CLIENT_INFO = { name: "rookery", title: "rookery", version: "0.1.0" };

// Unbounded async push-queue bridging notification callbacks into the stream's pull loop.
// The waiter is a {resolve, reject} pair: fail() must REJECT a parked consumer — resolving it
// with {done:true} (an earlier design) silently dropped the error, because the throw lives in
// next()'s own body and a parked waiter never re-enters it.
class EventChannel {
  private buffer: AgentEvent[] = [];
  private waiter: { resolve: (r: IteratorResult<AgentEvent>) => void; reject: (e: Error) => void } | null = null;
  private done = false;
  private error: Error | null = null;

  push(ev: AgentEvent): void {
    if (this.done) return;
    if (this.waiter) { const w = this.waiter; this.waiter = null; w.resolve({ value: ev, done: false }); }
    else this.buffer.push(ev);
  }

  fail(err: Error): void {
    if (this.done) return;
    this.done = true;
    if (this.waiter) { const w = this.waiter; this.waiter = null; w.reject(err); }
    else this.error = err; // no parked consumer: stored, thrown after the buffer drains
  }

  end(): void {
    if (this.done) return;
    this.done = true;
    if (this.waiter) { const w = this.waiter; this.waiter = null; w.resolve({ value: undefined as never, done: true }); }
  }

  async next(): Promise<IteratorResult<AgentEvent>> {
    const buffered = this.buffer.shift();
    if (buffered !== undefined) return { value: buffered, done: false }; // buffered events flush before any stored error
    if (this.done) {
      if (this.error) { const e = this.error; this.error = null; throw e; }
      return { value: undefined as never, done: true };
    }
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; });
  }
}

class CodexStream implements AgentStream {
  private readonly channel = new EventChannel();
  private client: CodexClient | null = null;
  private threadId: string | null = null;
  private activeTurnId: string | null = null;
  private turnDone: (() => void) | null = null;
  private cumTurns = 0;
  private lastContextTokens = 0;
  private contextWindow = 0;
  private overrideModel: string | null = null;
  private overrideMode: string | null = null;
  private started = false;

  constructor(
    private readonly deps: CodexBackendDeps,
    private readonly input: AsyncIterable<string>,
    private readonly opts: AgentSessionOptions,
  ) {}

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    if (this.started) throw new Error("CodexStream is single-use");
    this.started = true;
    const pump = this.pump()
      .then(() => this.channel.end())
      .catch((err: unknown) => {
        // A user stop/abort closes the client mid-request; the resulting rejection is not a
        // failure — end silently (Claude parity: worker's abort.signal.aborted check).
        if (this.opts.abortController.signal.aborted) this.channel.end();
        else this.channel.fail(err instanceof Error ? err : new Error(String(err)));
      });
    try {
      while (true) {
        const r = await this.channel.next();
        if (r.done) break;
        yield r.value;
      }
    } finally {
      this.client?.close();
      await pump.catch(() => {});
    }
  }

  private async pump(): Promise<void> {
    const abort = this.opts.abortController;
    const transport = this.deps.spawn({});
    const client = new CodexClient(transport);
    this.client = client;
    let clientClosed = false;
    let resolveClientClosed: () => void = () => {};
    const clientClosedP = new Promise<void>((resolve) => { resolveClientClosed = resolve; });
    const onAbort = () => client.close();
    abort.signal.addEventListener("abort", onAbort, { once: true });
    try {
      client.onClosed((err) => {
        clientClosed = true;
        if (this.turnDone) { const d = this.turnDone; this.turnDone = null; d(); }
        // Unexpected child death fails the stream (worker → terminal error). A DELIBERATE close
        // (stop/abort or pump teardown) must NOT end the channel here: pump's own settlement does —
        // otherwise a pump error unwinding through finally{close()} is masked by an early clean end.
        if (err && !abort.signal.aborted) this.channel.fail(err);
        resolveClientClosed();
      });
      client.onNotification((method, params) => this.handleNotification(method, params));
      client.onServerRequest((id, method) => this.handleServerRequest(id, method));
      await client.request("initialize", { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: false, requestAttestation: false } });
      client.notify("initialized", {});

      const mode = mapPermissionMode(this.opts.permissionMode);
      const startParams: CodexThreadStartParams = {
        cwd: this.opts.cwd,
        model: this.opts.model || this.deps.defaultModel(),
        approvalPolicy: mode.approvalPolicy,
        sandbox: mode.sandbox,
        ...(this.opts.systemPromptAppend ? { developerInstructions: this.opts.systemPromptAppend } : {}),
      };
      const res = (this.opts.resume
        ? await client.request("thread/resume", { threadId: this.opts.resume, ...startParams })
        : await client.request("thread/start", startParams)) as CodexThreadStartResponse;
      const threadId = res.thread?.id ?? this.opts.resume;
      if (!threadId) throw new Error("codex: thread/start returned no thread id");
      this.threadId = threadId;
      this.channel.push({ kind: "session_id", sessionId: threadId }); // early — port contract (resume after restart)

      const inputIt = this.input[Symbol.asyncIterator]();
      while (true) {
        if (abort.signal.aborted || clientClosed) return;
        // Race the next input against client close — otherwise a stop/abort while the queue is
        // still open would leave pump parked on input forever and hang the stream's final await.
        const r = await Promise.race([inputIt.next(), clientClosedP.then(() => null)]);
        if (r === null || r.done) return;
        const text = r.value;
        const input: CodexTextInput[] = [{ type: "text", text, text_elements: [] as never[] }];
        const turnEnded = new Promise<void>((resolve) => { this.turnDone = resolve; });
        const modeOverride = this.overrideMode ? mapPermissionMode(this.overrideMode) : null;
        const turnRes = (await client.request("turn/start", {
          threadId,
          input,
          ...(this.overrideModel ? { model: this.overrideModel } : {}),
          ...(mapEffort(this.opts.effort) ? { effort: mapEffort(this.opts.effort) } : {}),
          ...(modeOverride ? { approvalPolicy: modeOverride.approvalPolicy, sandboxPolicy: sandboxPolicyFor(modeOverride.sandbox) } : {}),
        })) as { turn?: { id?: string } };
        // Track the active turn id from the RESPONSE too — the turn/started notification's ordering
        // relative to this response is undocumented (0.142.5), and interrupt() needs the id either way.
        if (turnRes.turn?.id) this.activeTurnId = turnRes.turn.id;
        await turnEnded; // resolves on turn/completed (any status) or client close
      }
    } finally {
      abort.signal.removeEventListener("abort", onAbort);
      client.close();
      resolveClientClosed(); // safety: never leave the race parked even if onClosed didn't fire
    }
  }

  private handleNotification(method: string, params: unknown): void {
    const p = params as {
      threadId?: string;
      thread?: { id?: string };
      turn?: CodexTurn;
      turnId?: string;
      itemId?: string;
      delta?: string;
      item?: { type?: string; id?: string; text?: string; command?: string; cwd?: string; status?: string; aggregatedOutput?: string | null; server?: string; tool?: string; arguments?: unknown; query?: string; changes?: unknown };
      tokenUsage?: CodexThreadTokenUsage;
      error?: { message?: string };
    };
    // filter to our thread: child threads (codex-native subagents) are dropped in P1.
    if (this.threadId && p?.threadId && p.threadId !== this.threadId) return;
    if (method === "thread/started") {
      const id = p?.thread?.id;
      if (id && !this.threadId) { this.threadId = id; this.channel.push({ kind: "session_id", sessionId: id }); }
      return;
    }
    if (method === "turn/started") {
      this.activeTurnId = p?.turn?.id ?? null;
      return;
    }
    if (method === "item/agentMessage/delta") {
      if (typeof p?.delta === "string") this.channel.push({ kind: "text_delta", text: p.delta });
      return;
    }
    if (method === "item/reasoning/summaryTextDelta") {
      if (typeof p?.delta === "string") this.channel.push({ kind: "thinking_delta", text: p.delta });
      return;
    }
    if (method === "item/started") {
      const item = p?.item;
      if (!item?.id) return;
      if (item.type === "commandExecution") this.channel.push({ kind: "tool_use", id: item.id, name: "shell", input: { command: item.command, cwd: item.cwd }, parentToolUseId: null });
      else if (item.type === "fileChange") this.channel.push({ kind: "tool_use", id: item.id, name: "apply_patch", input: { changes: item.changes }, parentToolUseId: null });
      else if (item.type === "mcpToolCall") this.channel.push({ kind: "tool_use", id: item.id, name: `${item.server ?? "mcp"}.${item.tool ?? "tool"}`, input: item.arguments, parentToolUseId: null });
      else if (item.type === "webSearch") this.channel.push({ kind: "tool_use", id: item.id, name: "web_search", input: { query: item.query }, parentToolUseId: null });
      return;
    }
    if (method === "item/completed") {
      const item = p?.item;
      if (!item?.id) return;
      if (item.type === "agentMessage") {
        if (item.text) this.channel.push({ kind: "message", role: "assistant", text: item.text, parentToolUseId: null });
      } else if (item.type === "commandExecution") {
        this.channel.push({ kind: "tool_result", toolUseId: item.id, isError: item.status !== "completed", content: item.aggregatedOutput ?? "", parentToolUseId: null });
      } else if (item.type === "fileChange") {
        this.channel.push({ kind: "tool_result", toolUseId: item.id, isError: item.status !== "completed", content: item.status ?? "", parentToolUseId: null });
      } else if (item.type === "mcpToolCall" || item.type === "webSearch") {
        this.channel.push({ kind: "tool_result", toolUseId: item.id, isError: item.status != null && item.status !== "completed", content: item.status ?? "done", parentToolUseId: null });
      }
      return; // reasoning/userMessage/plan/etc.: dropped (deltas already flowed; user echo is Worker-side)
    }
    if (method === "thread/tokenUsage/updated") {
      const last = p?.tokenUsage?.last;
      if (last) this.lastContextTokens = (last.inputTokens ?? 0) + (last.cachedInputTokens ?? 0);
      const win = p?.tokenUsage?.modelContextWindow;
      if (typeof win === "number") this.contextWindow = win;
      return;
    }
    if (method === "error") {
      const msg = p?.error?.message ?? "unknown error";
      this.channel.push({ kind: "push", push: { kind: "notice", code: "notice.codexError", params: { message: msg }, text: t(DEFAULT_LOCALE, "notice.codexError", { message: msg }) } });
      return;
    }
    if (method === "turn/completed") {
      const turn = p?.turn;
      // Correlate to the active turn: a duplicate/late completion must not inflate numTurns,
      // emit a phantom turn_end, or settle the NEXT turn's turnDone early.
      if (this.activeTurnId && turn?.id && turn.id !== this.activeTurnId) return;
      this.activeTurnId = null;
      if (turn?.status === "failed" && turn.error?.message) {
        this.channel.push({ kind: "push", push: { kind: "notice", code: "notice.codexError", params: { message: turn.error.message }, text: t(DEFAULT_LOCALE, "notice.codexError", { message: turn.error.message }) } });
      }
      this.cumTurns += 1;
      const subtype = turn?.status === "failed" ? "error" : turn?.status === "interrupted" ? "interrupted" : "success";
      this.channel.push({
        kind: "turn_end",
        subtype,
        costUsd: turnCostUsd(this.overrideModel ?? this.opts.model, undefined),
        numTurns: this.cumTurns,
        durationMs: turn?.durationMs ?? 0,
        contextTokens: this.lastContextTokens,
        contextWindow: this.contextWindow,
      });
      if (this.turnDone) { const d = this.turnDone; this.turnDone = null; d(); }
      return;
    }
    // unknown notifications: ignored (0.x tolerance)
  }

  // With approvalPolicy "never" these should not fire; if one does, decline it (with a transcript
  // notice) rather than hang the turn, and answer anything unknown with method-not-found.
  private handleServerRequest(id: number | string, method: string): void {
    const client = this.client;
    if (!client) return;
    if (method.endsWith("requestApproval") || method === "execCommandApproval" || method === "applyPatchApproval") {
      client.respond(id, { decision: "decline" });
      this.channel.push({ kind: "push", push: { kind: "notice", code: "notice.codexError", params: { message: `declined unexpected approval request (${method})` }, text: t(DEFAULT_LOCALE, "notice.codexError", { message: `declined unexpected approval request (${method})` }) } });
      return;
    }
    client.respondError(id, -32601, `rookery does not handle ${method}`);
  }

  async interrupt(): Promise<void> {
    if (!this.client || !this.threadId || !this.activeTurnId) return;
    try {
      await this.client.request("turn/interrupt", { threadId: this.threadId, turnId: this.activeTurnId });
    } catch {
      /* best-effort: turn may have just ended */
    }
  }

  async setModel(model: string): Promise<void> {
    this.overrideModel = model; // applied on the next turn/start (per-turn override)
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.overrideMode = mode; // applied on the next turn/start (approvalPolicy + sandboxPolicy overrides)
  }

  async supportedCommands(): Promise<SlashCommandInfo[]> {
    return []; // Codex has no slash-command catalog surface we expose in P1
  }
}

export class CodexBackend implements AgentBackend {
  constructor(private readonly deps: CodexBackendDeps) {}

  openSession(input: AsyncIterable<string>, opts: AgentSessionOptions): AgentStream {
    return new CodexStream(this.deps, input, opts);
  }

  startTurn(_prompt: string, _opts: MasterTurnOptions): AgentStream {
    throw new Error("Codex master sessions are not supported yet (P1 is worker-only; see docs/2026-07-06-p1-codex-worker-backend.md)");
  }

  // Fork a thread via an ephemeral app-server child (used by FleetOrchestrator fork routing).
  async forkSession(threadId: string): Promise<{ sessionId: string }> {
    const transport = this.deps.spawn({});
    const client = new CodexClient(transport);
    try {
      await client.request("initialize", { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: false, requestAttestation: false } });
      client.notify("initialized", {});
      const res = (await client.request("thread/fork", { threadId })) as CodexThreadStartResponse;
      const id = res.thread?.id;
      if (!id) throw new Error("codex: thread/fork returned no thread id");
      return { sessionId: id };
    } finally {
      client.close();
    }
  }
}
