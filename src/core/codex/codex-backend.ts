import type { AgentBackend, AgentEvent, AgentSessionOptions, AgentStream, MasterTurnOptions, ProviderToolDef, SlashCommandInfo } from "../agent-backend.js";
import { t, DEFAULT_LOCALE } from "../i18n.js";
import { CodexClient } from "./codex-client.js";
import type { CodexSpawn } from "./codex-transport.js";
import type { CodexTextInput, CodexThreadStartParams, CodexThreadStartResponse, CodexThreadTokenUsage, CodexTokenUsageBreakdown, CodexTurn } from "./codex-protocol.js";
import { mapPermissionMode, sandboxPolicyFor, mapEffort } from "./codex-vocab.js";
import { turnCostUsd } from "./codex-pricing.js";

export interface CodexBackendDeps {
  spawn: CodexSpawn;
  defaultModel: () => string; // Settings resolver — used when the session has no model (spawn override wins)
  apiKey?: () => string | undefined; // in-app codex API key (Settings resolver). Present → provision auth.json via RPC after handshake.
  env?: () => NodeJS.ProcessEnv | undefined; // extra env for the spawned child (Settings resolver, e.g. CODEX_HOME redirection)
  // Daemon MCP bridge (P2 master turns; P2.5 Track A hardening — docs/2026-07-06-p25-codex-hardening.md):
  // registers a rookery session's in-process tool defs and returns the ready-to-use per-session
  // CODEX_HOME directory the daemon has already materialized (config.toml with the bridge url +
  // auth.json passthrough) — the bridge URL now lives ONLY in that on-disk config, never in argv.
  // core must not import daemon code, so server.ts's closure does the actual materializing (writing
  // config.toml/auth.json under `<rookery home>/codex-homes/<sessionKey>/`) and hands back just the
  // path (see docs/2026-07-06-p2-codex-master.md for the original bridge wiring).
  bridge?: { ensureSession(key: string, defs: () => ProviderToolDef[]): { codexHome: string } };
  // Per-turn inactivity watchdog (P2.5 Track B — docs/2026-07-06-p25-codex-hardening.md): resolved
  // ONCE per turn (server.ts passes `() => settings.codexTurnIdleTimeoutMs()`), matching the
  // model/effort resolver convention (re-evaluated per turn, not snapshotted). A turn armed with this
  // timeout fails (after a graceful turn/interrupt, then a short kill grace) if it goes totally
  // silent — no inbound notification of any kind — for that long. 0 (or ≤0), or the dep being absent
  // entirely, DISABLES the watchdog: no timer is ever armed. Lives in the shared CodexSessionBase
  // turn wait, so it applies to BOTH the worker's long-lived stream and the master's single-turn one.
  idleTimeoutMs?: () => number;
}

const CLIENT_INFO = { name: "rookery", title: "rookery", version: "0.1.0" };

type PermissionPair = ReturnType<typeof mapPermissionMode>;

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

// Shared per-session core reused by BOTH the worker's long-lived streaming-input stream
// (CodexWorkerStream) and the master's single-turn ephemeral-child stream (CodexTurnStream):
// client handshake + onClosed wiring, notification translation, server-request decline responder,
// EventChannel, pricing accumulator/billedModel, session_id emission, and thread-start/resume param
// assembly. Subclasses provide only the input strategy (queue-drain loop vs one turn/start) via `pump()`.
abstract class CodexSessionBase implements AgentStream {
  protected readonly channel = new EventChannel();
  protected client: CodexClient | null = null;
  protected threadId: string | null = null;
  protected activeTurnId: string | null = null;
  protected turnDone: (() => void) | null = null;
  protected cumTurns = 0;
  protected lastContextTokens = 0;
  protected contextWindow = 0;
  protected overrideModel: string | null = null;
  protected overrideMode: string | null = null;
  private started = false;
  protected clientClosed = false;
  private resolveClientClosed: () => void = () => {};
  protected clientClosedP: Promise<void> = new Promise((resolve) => { this.resolveClientClosed = resolve; });
  private onAbort: () => void = () => {};

  // Per-turn billing accumulator: deltas of the thread-cumulative tokenUsage.total between
  // updates (multi-call turns sum every call — see docs/2026-07-06-p15-codex-followups.md Track B).
  // Fresh session: baseline zeros (thread totals start at 0). Resumed session: baseline seeded from
  // the backend's totalsByThread map (T3b fix) — a WARM entry means the same daemon process priced
  // this thread's previous turn, so its recorded cumulative total is the correct baseline and the
  // first tokenUsage/updated of THIS turn is billed normally instead of silently consumed. A COLD
  // map (no entry — first resume ever seen by this process, e.g. right after a daemon restart) falls
  // back to null: the FIRST update only sets the baseline (its one call is uncounted; bounded,
  // accepted — same as the pre-fix behavior, now scoped to "once per daemon lifetime" instead of
  // "every single turn").
  protected prevTotal: CodexTokenUsageBreakdown | null;
  protected turnAccum = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  // Per-turn inactivity watchdog state (P2.5 Track B). `idleTimer` is the "no notification of any
  // kind for N ms" timer, armed at turn/start and reset on every inbound notification. `graceTimer`
  // is the short second-chance window after the watchdog's OWN turn/interrupt, before it escalates
  // to a hard kill. `idleTimeoutMsForTurn` is resolved ONCE per turn (see armIdleWatchdog) so a reset
  // mid-turn reuses the same window rather than re-querying the settings resolver on every event.
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimeoutMsForTurn = 0;
  private static readonly WATCHDOG_GRACE_MS = 5000;
  // Snapshotted once at construction, then re-snapshotted only when a turn/start actually carries a
  // model override — pricing must bill the model the THREAD was actually running under for that turn,
  // not whatever this.opts.model/defaultModel() resolve to NOW (mid-turn setModel, or a
  // codexWorkerModel settings change mid-session, must not misprice an already-billed turn).
  protected billedModel: string;

  constructor(
    protected readonly deps: CodexBackendDeps,
    protected readonly opts: AgentSessionOptions,
    // Backend-owned, daemon-lifetime map of threadId -> last-known cumulative tokenUsage.total
    // (T3b fix). Shared by reference across every stream this backend ever constructs — see
    // CodexBackend.totalsByThread for the persistence/eviction rationale.
    private readonly totalsByThread: Map<string, CodexTokenUsageBreakdown>,
  ) {
    this.prevTotal = opts.resume
      ? (this.totalsByThread.get(opts.resume) ?? null)
      : { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
    this.billedModel = this.opts.model || this.deps.defaultModel();
  }

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

  // Subclass-specific input strategy: openSession's queue-drain loop, or startTurn's one turn/start.
  protected abstract pump(): Promise<void>;

  // Spawns the child, wires the client's close/notification/server-request handlers, completes the
  // initialize handshake, and provisions the in-app API key if configured. `envOverride` carries the
  // master turn's per-session CODEX_HOME (`{CODEX_HOME: <bridge-materialized dir>}` — P2.5 Track A;
  // absent for workers and tool-less master turns, which fall back to `deps.env` alone). No `-c` arg
  // is ever passed anymore — the bridge URL lives only in that dir's config.toml (mode 0600).
  protected async openClient(envOverride?: NodeJS.ProcessEnv): Promise<CodexClient> {
    const abort = this.opts.abortController;
    // envOverride (when present) wins over the base env — a per-turn per-session CODEX_HOME must
    // override the shared codexApiKey CODEX_HOME (P1.5) for master turns. When NEITHER is set, pass
    // `env: undefined` rather than `{}`: realCodexSpawn does `{ ...process.env, ...env }`, so an empty
    // object is harmless either way, but `undefined` reads as "nothing to add" and matches prior behavior.
    const baseEnv = this.deps.env?.();
    const env = envOverride ? { ...(baseEnv ?? {}), ...envOverride } : baseEnv;
    const transport = this.deps.spawn({ env, args: undefined });
    const client = new CodexClient(transport);
    this.client = client;
    this.clientClosedP = new Promise((resolve) => { this.resolveClientClosed = resolve; });
    this.onAbort = () => { this.disarmIdleWatchdog(); client.close(); }; // P2.5 Track B: abort disarms too, not just a graceful interrupt
    abort.signal.addEventListener("abort", this.onAbort, { once: true });
    client.onClosed((err) => {
      this.clientClosed = true;
      if (this.turnDone) { const d = this.turnDone; this.turnDone = null; d(); }
      // Unexpected child death fails the stream (worker → terminal error). A DELIBERATE close
      // (stop/abort or pump teardown) must NOT end the channel here: pump's own settlement does —
      // otherwise a pump error unwinding through finally{close()} is masked by an early clean end.
      if (err && !abort.signal.aborted) this.channel.fail(err);
      this.resolveClientClosed();
    });
    client.onNotification((method, params) => this.handleNotification(method, params));
    client.onServerRequest((id, method) => this.handleServerRequest(id, method));
    await client.request("initialize", { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: false, requestAttestation: false } });
    client.notify("initialized", {});

    // In-app API key: provision the (redirected) CODEX_HOME's auth.json once via RPC —
    // the app-server ignores CODEX_API_KEY env (P1 finding). Subsequent spawns skip via account/read.
    const apiKey = this.deps.apiKey?.();
    if (apiKey) {
      const acct = (await client.request("account/read", {})) as { requiresOpenaiAuth?: boolean } | null;
      if (acct?.requiresOpenaiAuth) {
        await client.request("account/login/start", { type: "apiKey", apiKey });
      }
    }
    return client;
  }

  // Symmetric teardown for openClient(): removes the abort listener, closes the client (idempotent
  // via CodexClient's own `closed` guard), and releases anything still parked on clientClosedP
  // (safety net in case onClosed never fired). Always called from pump()'s outer finally.
  protected teardownClient(): void {
    this.disarmIdleWatchdog(); // every stream-exit path clears both timers — no dangling timer keeps the event loop alive
    this.opts.abortController.signal.removeEventListener("abort", this.onAbort);
    this.client?.close();
    this.resolveClientClosed();
  }

  // Arms the per-turn inactivity watchdog: resolves the timeout ONCE for this turn (a settings
  // resolver, re-evaluated per turn like model/effort — not mid-turn) and, if positive, starts a
  // timer that fires after that many ms of TOTAL silence (no inbound notification of any kind).
  // 0/negative/absent disables it entirely — no timer is ever created for this turn.
  private armIdleWatchdog(): void {
    this.idleTimeoutMsForTurn = this.deps.idleTimeoutMs?.() ?? 0;
    this.clearIdleTimer();
    // Defense-in-depth: a NEW turn must never inherit a stale grace timer from a previous turn's
    // onIdleTimeout race (see onIdleTimeout's own turnDone===null guard for the primary fix). If
    // some other path ever manages to leave graceTimer armed across a turn boundary, arming the
    // next turn's watchdog clears it here so it can never dangle into (and kill) turn N+1.
    if (this.graceTimer !== null) { clearTimeout(this.graceTimer); this.graceTimer = null; }
    if (this.idleTimeoutMsForTurn > 0) {
      this.idleTimer = setTimeout(() => { void this.onIdleTimeout(); }, this.idleTimeoutMsForTurn);
    }
  }

  // Any inbound notification is progress (item/*/outputDelta included — handleNotification calls
  // this before it does anything else, unconditionally). A no-op when no watchdog is currently armed
  // (disabled turn, or already fired/disarmed) — an event arriving outside an armed turn must not
  // spuriously start one.
  private resetIdleWatchdog(): void {
    if (this.idleTimer === null) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { void this.onIdleTimeout(); }, this.idleTimeoutMsForTurn);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  // Full watchdog teardown (both timers). Called on turn/completed, on an explicit interrupt()/abort,
  // and from every stream-exit path (teardownClient) — see each call site's own comment.
  protected disarmIdleWatchdog(): void {
    this.clearIdleTimer();
    if (this.graceTimer !== null) { clearTimeout(this.graceTimer); this.graceTimer = null; }
  }

  // The idle timer fired: this turn has been totally silent for idleTimeoutMsForTurn. Send a
  // graceful turn/interrupt (best-effort — reuses the same public interrupt() an external caller
  // would use, which also means it targets whatever activeTurnId is current) and arm a short grace
  // window for turn/completed to actually arrive before escalating to a hard kill.
  private async onIdleTimeout(): Promise<void> {
    this.idleTimer = null;
    try {
      await this.interrupt();
    } catch {
      /* best-effort — escalate to the grace/kill path regardless of interrupt's own outcome */
    }
    // The turn may have completed during the interrupt round-trip (ack + turn/completed can arrive
    // in one stdout batch). turnDone is nulled by both turn/completed and onClosed → null means the
    // turn already ended, so do NOT arm the grace kill (it would dangle and false-kill a later turn).
    if (this.turnDone === null) return;
    this.graceTimer = setTimeout(() => this.onGraceExpired(), CodexSessionBase.WATCHDOG_GRACE_MS);
  }

  // The graceful interrupt didn't produce turn/completed within the grace window either — the turn
  // is genuinely wedged (bridge unreachable / rmcp client stalled). Kill the child and fail the
  // stream. The notice MUST be pushed before fail(): EventChannel silently drops any push once
  // done=true, so pushing after fail() would lose the notice.
  private onGraceExpired(): void {
    this.graceTimer = null;
    const seconds = Math.round(this.idleTimeoutMsForTurn / 1000);
    this.channel.push({ kind: "push", push: { kind: "notice", code: "notice.codexTurnTimeout", params: { seconds }, text: t(DEFAULT_LOCALE, "notice.codexTurnTimeout", { seconds }) } });
    this.channel.fail(new Error(`codex turn timed out after ${seconds}s of inactivity`));
    this.client?.close();
  }

  // thread/start (fresh) or thread/resume (opts.resume set) — same param assembly either way,
  // including developerInstructions when the caller passes system-prompt text (workers rarely do;
  // master turns always do — buildSystemPrompt() changes every turn, see
  // docs/2026-07-06-p2-codex-master.md). Emits session_id EARLY, before any turn runs (port
  // contract: resume must be possible even if the turn never completes).
  protected async startOrResumeThread(client: CodexClient, mode: PermissionPair, developerInstructions?: string): Promise<string> {
    const startParams: CodexThreadStartParams = {
      cwd: this.opts.cwd,
      model: this.opts.model || this.deps.defaultModel(),
      approvalPolicy: mode.approvalPolicy,
      sandbox: mode.sandbox,
      ...(developerInstructions ? { developerInstructions } : {}),
    };
    const res = (this.opts.resume
      ? await client.request("thread/resume", { threadId: this.opts.resume, ...startParams })
      : await client.request("thread/start", startParams)) as CodexThreadStartResponse;
    const threadId = res.thread?.id ?? this.opts.resume;
    if (!threadId) throw new Error("codex: thread/start returned no thread id");
    this.threadId = threadId;
    this.channel.push({ kind: "session_id", sessionId: threadId }); // early — port contract (resume after restart)
    return threadId;
  }

  // Sends ONE turn/start with `text` and awaits its turn/completed (any status) or a client close.
  // `modelOverride` is applied verbatim to the request (worker: live setModel() override if any;
  // master: always undefined — a master turn is single-shot, see CodexBackend.startTurn). The caller
  // is responsible for snapshotting `billedModel` BEFORE calling this, so pricing bills the model the
  // thread actually ran this turn under.
  protected async sendTurn(client: CodexClient, threadId: string, text: string, mode: PermissionPair, effort: string | undefined, modelOverride: string | undefined): Promise<void> {
    const input: CodexTextInput[] = [{ type: "text", text, text_elements: [] as never[] }];
    const turnEnded = new Promise<void>((resolve) => { this.turnDone = resolve; });
    // Always explicit: sandbox/approval identical regardless of path (spawn vs live override),
    // and workspace-write is always network-on by rookery decision (spec Track E).
    const turnRes = (await client.request("turn/start", {
      threadId,
      input,
      ...(modelOverride ? { model: modelOverride } : {}),
      ...(effort ? { effort } : {}),
      approvalPolicy: mode.approvalPolicy,
      sandboxPolicy: sandboxPolicyFor(mode.sandbox),
    })) as { turn?: { id?: string } };
    // Track the active turn id from the RESPONSE too — the turn/started notification's ordering
    // relative to this response is undocumented (0.142.5), and interrupt() needs the id either way.
    if (turnRes.turn?.id) this.activeTurnId = turnRes.turn.id;
    this.armIdleWatchdog(); // P2.5 Track B — arm right as we start awaiting this turn's completion
    try {
      await turnEnded; // resolves on turn/completed (any status), a watchdog-triggered kill, or an external client close
    } finally {
      this.disarmIdleWatchdog(); // covers every resolution path (redundant with turn/completed's own disarm, but never dangling)
    }
  }

  private handleNotification(method: string, params: unknown): void {
    this.resetIdleWatchdog(); // ANY inbound notification is progress (P2.5 Track B) — unconditional, before thread filtering/dispatch
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
      const total = p?.tokenUsage?.total;
      if (total) {
        if (this.prevTotal === null) {
          this.prevTotal = total; // resumed stream: baseline only
        } else {
          this.turnAccum.inputTokens += Math.max(0, (total.inputTokens ?? 0) - (this.prevTotal.inputTokens ?? 0));
          this.turnAccum.cachedInputTokens += Math.max(0, (total.cachedInputTokens ?? 0) - (this.prevTotal.cachedInputTokens ?? 0));
          this.turnAccum.outputTokens += Math.max(0, (total.outputTokens ?? 0) - (this.prevTotal.outputTokens ?? 0));
          this.prevTotal = total;
        }
      }
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
      this.disarmIdleWatchdog(); // the turn is over — no more silence to guard against until the NEXT turn/start
      if (turn?.status === "failed" && turn.error?.message) {
        this.channel.push({ kind: "push", push: { kind: "notice", code: "notice.codexError", params: { message: turn.error.message }, text: t(DEFAULT_LOCALE, "notice.codexError", { message: turn.error.message }) } });
      }
      this.cumTurns += 1;
      const subtype = turn?.status === "failed" ? "error" : turn?.status === "interrupted" ? "interrupted" : "success";
      this.channel.push({
        kind: "turn_end",
        subtype,
        costUsd: turnCostUsd(this.billedModel, this.turnAccum),
        numTurns: this.cumTurns,
        durationMs: turn?.durationMs ?? 0,
        contextTokens: this.lastContextTokens,
        contextWindow: this.contextWindow,
      });
      // Persist this thread's latest cumulative total (T3b fix) so the NEXT resumed turn — a master's
      // next startTurn(resume:...) call, or a worker's rehydrate-resume — seeds prevTotal from here
      // instead of null. Applies to both fresh and resumed sessions alike: prevTotal is only ever null
      // when this thread has never completed a turn under this daemon process.
      if (this.threadId && this.prevTotal) this.totalsByThread.set(this.threadId, this.prevTotal);
      this.turnAccum = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }; // reset per turn, including failed/interrupted
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

  // Between sending turn/start and receiving its response (or turn/started), activeTurnId is
  // still null and interrupt() no-ops — a tiny dead window Claude's SDK interrupt doesn't have;
  // acceptable best-effort (the turn then runs to completion).
  async interrupt(): Promise<void> {
    this.disarmIdleWatchdog(); // an explicit interrupt (ours from the watchdog, or an external caller's) always disarms
    if (!this.client || !this.threadId || !this.activeTurnId) return;
    try {
      await this.client.request("turn/interrupt", { threadId: this.threadId, turnId: this.activeTurnId });
    } catch {
      /* best-effort: turn may have just ended */
    }
  }

  async setModel(model: string): Promise<void> {
    this.overrideModel = model; // applied on the next turn/start (per-turn override); a no-op on a
    // single-shot master turn (CodexTurnStream never reads it back — the next call is a NEW startTurn).
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.overrideMode = mode; // same per-turn-override semantics as setModel above.
  }

  async supportedCommands(): Promise<SlashCommandInfo[]> {
    return []; // Codex has no slash-command catalog surface we expose in P1/P2
  }
}

// Worker path (P1): a long-lived streaming-input session — many turns drained from `input` over one
// child process's lifetime.
class CodexWorkerStream extends CodexSessionBase {
  constructor(
    deps: CodexBackendDeps,
    private readonly input: AsyncIterable<string>,
    opts: AgentSessionOptions,
    totalsByThread: Map<string, CodexTokenUsageBreakdown>,
  ) {
    super(deps, opts, totalsByThread);
  }

  protected async pump(): Promise<void> {
    const abort = this.opts.abortController;
    try {
      const client = await this.openClient();
      const mode = mapPermissionMode(this.opts.permissionMode);
      const threadId = await this.startOrResumeThread(client, mode, this.opts.systemPromptAppend);

      const inputIt = this.input[Symbol.asyncIterator]();
      while (true) {
        if (abort.signal.aborted || this.clientClosed) return;
        // Race the next input against client close — otherwise a stop/abort while the queue is
        // still open would leave pump parked on input forever and hang the stream's final await.
        const r = await Promise.race([inputIt.next(), this.clientClosedP.then(() => null)]);
        if (r === null || r.done) return;
        const text = r.value;
        const currentMode = mapPermissionMode(this.overrideMode ?? this.opts.permissionMode);
        const effort = mapEffort(this.opts.effort);
        // The override actually changes the thread's model from THIS turn on — snapshot it for
        // billing before the request so turn/completed prices against what actually ran.
        if (this.overrideModel) this.billedModel = this.overrideModel;
        await this.sendTurn(client, threadId, text, currentMode, effort, this.overrideModel ?? undefined);
      }
    } finally {
      this.teardownClient();
    }
  }
}

// Master path (P2): a single-turn ephemeral child — spawn, thread/start-or-resume with fresh
// developerInstructions, ONE turn/start, await completion, then the stream ends (pump() returns and
// [Symbol.asyncIterator]'s wrapper closes the channel). See CodexBackend.startTurn for the
// bypassPermissions guard and bridge wiring that happen BEFORE this stream is even constructed.
class CodexTurnStream extends CodexSessionBase {
  constructor(
    deps: CodexBackendDeps,
    private readonly prompt: string,
    opts: MasterTurnOptions,
    private readonly envOverride: NodeJS.ProcessEnv | undefined,
    totalsByThread: Map<string, CodexTokenUsageBreakdown>,
  ) {
    super(deps, opts, totalsByThread);
  }

  protected async pump(): Promise<void> {
    try {
      // Fixed for the whole (single) turn — no live setPermissionMode influence, matching the
      // spec's "model override N/A" note: a master turn is single-shot, overrides land on the
      // NEXT startTurn() call's opts instead.
      const mode = mapPermissionMode(this.opts.permissionMode);
      const client = await this.openClient(this.envOverride);
      const threadId = await this.startOrResumeThread(client, mode, this.opts.systemPromptAppend);
      const effort = mapEffort(this.opts.effort);
      await this.sendTurn(client, threadId, this.prompt, mode, effort, undefined);
    } finally {
      this.teardownClient();
    }
  }
}

export class CodexBackend implements AgentBackend {
  // T3b fix: per-thread cumulative-usage baseline (thread/tokenUsage/updated's `.total`), persisted
  // across turns. CodexBackend is a daemon singleton (one instance for the whole process, injected
  // once in server.ts), so this map outlives any single stream/turn and is shared by every session
  // core it constructs — a master's Nth startTurn(resume:...) call sees what its (N-1)th call wrote.
  // A daemon restart empties this map, which just re-triggers the pre-existing cold-baseline
  // consumption for that thread's next turn — bounded and accepted (same as a worker's first turn
  // after a restart). No eviction: the key space is the set of threads with a live/recent rookery
  // session (masters + workers), which is bounded by the fleet/session population, not unbounded churn.
  private readonly totalsByThread = new Map<string, CodexTokenUsageBreakdown>();

  constructor(private readonly deps: CodexBackendDeps) {}

  openSession(input: AsyncIterable<string>, opts: AgentSessionOptions): AgentStream {
    return new CodexWorkerStream(this.deps, input, opts, this.totalsByThread);
  }

  // Per-turn ephemeral child (P2 — docs/2026-07-06-p2-codex-master.md). Rejects SYNCHRONOUSLY for
  // restricted sandboxes: they silently block the turn-scoped MCP bridge call rather than erroring
  // (spike finding #2), so this is the only place that footgun can be caught cleanly.
  startTurn(prompt: string, opts: MasterTurnOptions): AgentStream {
    const mode = mapPermissionMode(opts.permissionMode);
    if (mode.sandbox !== "danger-full-access") {
      throw new Error("codex master sessions require bypassPermissions (restricted sandboxes silently block the MCP bridge — see docs/2026-07-06-p2-codex-master.md)");
    }
    let envOverride: NodeJS.ProcessEnv | undefined;
    if (opts.sessionKey && opts.toolDefs && this.deps.bridge) {
      const flattened = Object.values(opts.toolDefs).flat();
      const { codexHome } = this.deps.bridge.ensureSession(opts.sessionKey, () => flattened);
      envOverride = { CODEX_HOME: codexHome };
    }
    return new CodexTurnStream(this.deps, prompt, opts, envOverride, this.totalsByThread);
  }

  private static readonly FORK_TIMEOUT_MS = 15_000;

  // Fork a thread via an ephemeral app-server child (used by FleetOrchestrator fork routing).
  async forkSession(threadId: string): Promise<{ sessionId: string }> {
    const transport = this.deps.spawn({ env: this.deps.env?.() });
    const client = new CodexClient(transport);
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A hung ephemeral child must not wedge the worker.fork request forever.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`codex fork timed out after ${CodexBackend.FORK_TIMEOUT_MS / 1000}s`)), CodexBackend.FORK_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.doFork(client, threadId), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      client.close();
    }
  }

  private async doFork(client: CodexClient, threadId: string): Promise<{ sessionId: string }> {
    await client.request("initialize", { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: false, requestAttestation: false } });
    client.notify("initialized", {});
    const res = (await client.request("thread/fork", { threadId })) as CodexThreadStartResponse;
    const id = res.thread?.id;
    if (!id) throw new Error("codex: thread/fork returned no thread id");
    return { sessionId: id };
  }
}
