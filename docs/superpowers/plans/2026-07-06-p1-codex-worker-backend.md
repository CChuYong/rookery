# P1 Codex Worker Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `CodexBackend` (an `AgentBackend` for OpenAI Codex via `codex app-server`) plus provider plumbing so a Claude master can spawn/steer/interrupt/fork/rehydrate Codex workers. Spec: `docs/2026-07-06-p1-codex-worker-backend.md` (read it for design rationale; this plan is the implementation).

**Architecture:** New directory `src/core/codex/` — `codex-protocol.ts` (curated wire types, pinned to CLI 0.142.5), `codex-client.ts` (newline-delimited JSON-RPC over a `CodexTransport` port), `codex-transport.ts` (port + real child-process impl), `codex-vocab.ts` (permission/effort mapping), `codex-pricing.ts` (cost structure, returns 0 in P1), `codex-backend.ts` (the AgentBackend). Worker/master code from P0 is untouched except composition-root wiring and provider plumbing (DB column, fleet, protocol, tools).

**Tech Stack:** TypeScript ESM NodeNext, vitest, node:child_process (real transport only). No new dependencies.

## Global Constraints

- **Node 22 first** for every command: `source ~/.nvm/nvm.sh && nvm use 22` (better-sqlite3 ABI 127).
- ESM NodeNext: relative imports carry `.js`; type-only imports use `import type` (`verbatimModuleSyntax: true`). Code comments in English.
- **Migrations are append-only** — add exactly one new entry at the END of `MIGRATIONS` in `src/persistence/db.ts`; never modify existing entries.
- The provider-neutrality gate (`test/core/provider-neutral.test.ts`) must stay green — none of the 7 guarded files may import the Claude SDK; the new `src/core/codex/*` modules must not import `@anthropic-ai/claude-agent-sdk` at all.
- Protocol ground truth is the generated schema at `/private/tmp/claude-502/-Users-clover-workspace-clovot/618afac6-8a69-4469-bbc6-02c6fb60de7b/scratchpad/codex-schema/` (from `codex app-server generate-ts`, CLI 0.142.5) — consult it when in doubt; the curated types in this plan were extracted from it.
- Framing (verified live): **newline-delimited JSON**, one JSON-RPC message per line, no Content-Length headers. Responses may omit the `jsonrpc` field — never require it when parsing.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- `npm run typecheck && npm test` green at the end of every task.
- i18n: the one new notice code `notice.codexError` must be added to BOTH `src/core/i18n.ts` (ko + en) AND `apps/desktop/src/renderer/i18n/locales/{ko,en}/…` notice catalogs with byte-identical key and param names (param: `message`).

---

### Task 1: Codex protocol types + JSON-RPC client + transport port

**Files:**
- Create: `src/core/codex/codex-protocol.ts`, `src/core/codex/codex-client.ts`, `src/core/codex/codex-transport.ts`
- Test: `test/core/codex/codex-client.test.ts`

**Interfaces:**
- Produces (later tasks rely on these exact names): `CodexTransport { write(line), onLine(cb), onExit(cb), kill() }`, `CodexSpawn = (opts: { env?: NodeJS.ProcessEnv }) => CodexTransport`, `realCodexSpawn(bin: () => string): CodexSpawn`, `CodexClient` with `request(method, params): Promise<unknown>`, `notify(method, params)`, `respond(id, result)`, `respondError(id, code, message)`, `onNotification(cb: (method: string, params: unknown) => void)`, `onServerRequest(cb: (id: number | string, method: string, params: unknown) => void)`, `onClosed(cb: (err?: Error) => void)`, `close()`; protocol types below.

- [ ] **Step 1: Create `src/core/codex/codex-protocol.ts`**:

```ts
// Curated wire types for the `codex app-server` JSON-RPC protocol.
// Ground truth: `codex app-server generate-ts` output, Codex CLI 0.142.5 (2026-07-06).
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
```

- [ ] **Step 2: Create `src/core/codex/codex-transport.ts`**:

```ts
import { spawn as nodeSpawn } from "node:child_process";
import { createInterface } from "node:readline";

// Byte-transport port under the Codex JSON-RPC client. Real impl spawns `codex app-server`;
// tests inject a scripted fake (test/helpers/fake-codex-transport.ts).
export interface CodexTransport {
  write(line: string): void;
  onLine(cb: (line: string) => void): void;
  onExit(cb: (info: { code: number | null; message?: string }) => void): void;
  kill(): void;
}

export type CodexSpawn = (opts: { env?: NodeJS.ProcessEnv }) => CodexTransport;

// Real transport: one `codex app-server` child per session, newline-delimited JSON-RPC on stdio.
// `bin` is a resolver (Settings-backed) so runtime changes apply to new sessions.
// AUTH NOTE (verified against rust-v0.142.5 app-server/src/lib.rs:493): the app-server does NOT
// read CODEX_API_KEY from env (that only works for `codex exec`). Auth comes from
// $CODEX_HOME/auth.json (`codex login` / `codex login --with-api-key`). An in-app API-key setting
// would need CODEX_HOME redirection + `account/login/start` provisioning — deferred to P1.5.
export function realCodexSpawn(bin: () => string): CodexSpawn {
  return ({ env }) => {
    const child = nodeSpawn(bin(), ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    const lineCbs: Array<(line: string) => void> = [];
    const exitCbs: Array<(info: { code: number | null; message?: string }) => void> = [];
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => { for (const cb of lineCbs) cb(line); });
    let stderrTail = "";
    child.stderr.on("data", (d: Buffer) => { stderrTail = (stderrTail + d.toString()).slice(-2000); });
    // spawn failure (ENOENT etc.) surfaces as 'error', not 'exit' — funnel both into onExit.
    child.on("error", (err) => { for (const cb of exitCbs) cb({ code: null, message: String(err) }); });
    child.on("exit", (code) => { for (const cb of exitCbs) cb({ code, message: stderrTail || undefined }); });
    return {
      write: (line) => { try { child.stdin.write(line + "\n"); } catch { /* dying child — exit cb reports */ } },
      onLine: (cb) => { lineCbs.push(cb); },
      onExit: (cb) => { exitCbs.push(cb); },
      kill: () => { try { child.kill(); } catch { /* already dead */ } },
    };
  };
}
```

- [ ] **Step 3: Write the failing client tests** — `test/core/codex/codex-client.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { CodexClient } from "../../../src/core/codex/codex-client.js";
import type { CodexTransport } from "../../../src/core/codex/codex-transport.js";

// Minimal loopback transport: captures written lines; test feeds inbound lines manually.
function loopback() {
  const written: string[] = [];
  let lineCb: (l: string) => void = () => {};
  let exitCb: (i: { code: number | null; message?: string }) => void = () => {};
  const transport: CodexTransport = {
    write: (l) => written.push(l),
    onLine: (cb) => { lineCb = cb; },
    onExit: (cb) => { exitCb = cb; },
    kill: () => {},
  };
  return { transport, written, feed: (o: unknown) => lineCb(JSON.stringify(o)), feedRaw: (s: string) => lineCb(s), exit: (code: number | null, message?: string) => exitCb({ code, message }) };
}

describe("CodexClient", () => {
  it("correlates request/response by id and resolves with result", async () => {
    const { transport, written, feed } = loopback();
    const c = new CodexClient(transport);
    const p = c.request("model/list", {});
    const sent = JSON.parse(written[0]!);
    expect(sent).toMatchObject({ jsonrpc: "2.0", method: "model/list", params: {} });
    feed({ id: sent.id, result: { data: [] } }); // responses may omit jsonrpc — must still parse
    await expect(p).resolves.toEqual({ data: [] });
  });

  it("rejects on error responses and on transport exit (all pending)", async () => {
    const { transport, written, feed, exit } = loopback();
    const c = new CodexClient(transport);
    const p1 = c.request("thread/start", {});
    feed({ id: JSON.parse(written[0]!).id, error: { code: -32000, message: "boom" } });
    await expect(p1).rejects.toThrow(/boom/);
    const p2 = c.request("thread/start", {});
    exit(1, "crashed");
    await expect(p2).rejects.toThrow(/crashed|exited/);
  });

  it("dispatches notifications, server requests, and ignores malformed lines", async () => {
    const { transport, written, feed, feedRaw } = loopback();
    const c = new CodexClient(transport);
    const notes: Array<[string, unknown]> = [];
    const reqs: Array<[number | string, string]> = [];
    c.onNotification((m, p) => notes.push([m, p]));
    c.onServerRequest((id, m) => reqs.push([id, m]));
    feedRaw("not json at all");
    feed({ method: "thread/started", params: { thread: { id: "t1" } } });
    feed({ id: 77, method: "execCommandApproval", params: {} }); // id+method = server request
    c.respond(77, { decision: "decline" });
    c.respondError(78, -32601, "unknown");
    expect(notes).toEqual([["thread/started", { thread: { id: "t1" } }]]);
    expect(reqs).toEqual([[77, "execCommandApproval"]]);
    expect(JSON.parse(written.at(-2)!)).toEqual({ jsonrpc: "2.0", id: 77, result: { decision: "decline" } });
    expect(JSON.parse(written.at(-1)!)).toEqual({ jsonrpc: "2.0", id: 78, error: { code: -32601, message: "unknown" } });
  });

  it("notify writes a method-only frame; onClosed fires once on exit", () => {
    const { transport, written, exit } = loopback();
    const c = new CodexClient(transport);
    c.notify("initialized", {});
    expect(JSON.parse(written[0]!)).toEqual({ jsonrpc: "2.0", method: "initialized", params: {} });
    let closed = 0;
    c.onClosed(() => closed++);
    exit(0); exit(0);
    expect(closed).toBe(1);
  });
});
```

- [ ] **Step 4: Run to verify failure** — `npx vitest run test/core/codex/codex-client.test.ts` → FAIL (module not found).

- [ ] **Step 5: Create `src/core/codex/codex-client.ts`**:

```ts
import type { CodexTransport } from "./codex-transport.js";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

// Newline-delimited JSON-RPC 2.0 client for `codex app-server` (framing verified live:
// one JSON message per line, no Content-Length headers; responses may omit `jsonrpc`).
// Inbound classification: id+method = server→client request; id+result/error = response;
// method only = notification. Malformed lines are ignored (0.x tolerance).
export class CodexClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationCbs: Array<(method: string, params: unknown) => void> = [];
  private readonly serverRequestCbs: Array<(id: number | string, method: string, params: unknown) => void> = [];
  private readonly closedCbs: Array<(err?: Error) => void> = [];
  private closed = false;

  constructor(private readonly transport: CodexTransport) {
    transport.onLine((line) => this.dispatch(line));
    transport.onExit((info) => this.handleExit(info));
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(`codex app-server exited (request ${method})`));
    const id = this.nextId++;
    const p = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.transport.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return p;
  }

  notify(method: string, params: unknown): void {
    this.transport.write(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  respond(id: number | string, result: unknown): void {
    this.transport.write(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  respondError(id: number | string, code: number, message: string): void {
    this.transport.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }

  onNotification(cb: (method: string, params: unknown) => void): void {
    this.notificationCbs.push(cb);
  }

  onServerRequest(cb: (id: number | string, method: string, params: unknown) => void): void {
    this.serverRequestCbs.push(cb);
  }

  onClosed(cb: (err?: Error) => void): void {
    this.closedCbs.push(cb);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.transport.kill();
    this.failPending(new Error("codex app-server closed"));
  }

  private dispatch(line: string): void {
    let msg: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string } };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return; // non-JSON noise on stdout — ignore
    }
    if (typeof msg !== "object" || msg === null) return;
    if (msg.id != null && msg.method) {
      for (const cb of this.serverRequestCbs) cb(msg.id, msg.method, msg.params);
      return;
    }
    if (msg.id != null) {
      const pending = this.pending.get(msg.id as number);
      if (!pending) return;
      this.pending.delete(msg.id as number);
      if (msg.error) pending.reject(new Error(`codex: ${msg.error.message ?? "error"} (code ${msg.error.code ?? "?"})`));
      else pending.resolve(msg.result);
      return;
    }
    if (msg.method) {
      for (const cb of this.notificationCbs) cb(msg.method, msg.params);
    }
  }

  private handleExit(info: { code: number | null; message?: string }): void {
    if (this.closed) return; // deliberate close() — already drained
    this.closed = true;
    const err = new Error(`codex app-server exited (code ${info.code ?? "?"})${info.message ? `: ${info.message.slice(0, 400)}` : ""}`);
    this.failPending(err);
    for (const cb of this.closedCbs.splice(0)) cb(err);
  }

  private failPending(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
    // deliberate close(): closed callbacks fire without error
    if (this.closed) for (const cb of this.closedCbs.splice(0)) cb(undefined);
  }
}
```

NOTE to implementer: the interplay of `close()` vs `handleExit` and the single-fire `onClosed` is subtle — make the tests in Step 3 pass exactly; if the double-fire guard needs restructuring (e.g. a `firedClosed` flag instead of splice), do it, keeping the contract: onClosed fires exactly once; deliberate `close()` → `undefined`, unexpected exit → `Error`.

- [ ] **Step 6: Green + full suite** — `npx vitest run test/core/codex/codex-client.test.ts && npm run typecheck && npm test` → PASS.
- [ ] **Step 7: Commit** — `git add src/core/codex test/core/codex && git commit -m "feat(codex): protocol types + newline JSON-RPC client + transport port (CLI 0.142.5 pinned)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 2: Vocabulary + pricing + fake Codex server helper

**Files:**
- Create: `src/core/codex/codex-vocab.ts`, `src/core/codex/codex-pricing.ts`, `test/helpers/fake-codex.ts`
- Test: `test/core/codex/codex-vocab.test.ts`

**Interfaces:**
- Produces: `mapPermissionMode(mode: string): { approvalPolicy: CodexApprovalPolicy; sandbox: CodexSandboxMode }`, `sandboxPolicyFor(sandbox: CodexSandboxMode): CodexSandboxPolicy`, `mapEffort(effort: string | undefined): string | undefined`, `turnCostUsd(model: string, usage: CodexTokenUsageBreakdown | undefined): number`, and the test helper `fakeCodexSpawn(server: FakeCodexServer): { spawn: CodexSpawn; requests: Array<{ method: string; params: unknown }> }` + `scriptedCodexServer(responder, opts?)` (full code below).

- [ ] **Step 1: `src/core/codex/codex-vocab.ts`**:

```ts
import type { CodexApprovalPolicy, CodexSandboxMode, CodexSandboxPolicy } from "./codex-protocol.js";

// rookery permissionMode → Codex approval/sandbox pair. Workers have no interactive
// approval channel, so every mode maps to approvalPolicy "never" and the sandbox does
// the enforcement (see spec §Vocabulary): bypass→danger, acceptEdits/default→workspace, plan→read-only.
export function mapPermissionMode(mode: string): { approvalPolicy: CodexApprovalPolicy; sandbox: CodexSandboxMode } {
  switch (mode) {
    case "acceptEdits":
    case "default":
      return { approvalPolicy: "never", sandbox: "workspace-write" };
    case "plan":
      return { approvalPolicy: "never", sandbox: "read-only" };
    case "bypassPermissions":
    default:
      return { approvalPolicy: "never", sandbox: "danger-full-access" };
  }
}

// Per-turn override needs the object-form SandboxPolicy (thread start takes the string form).
export function sandboxPolicyFor(sandbox: CodexSandboxMode): CodexSandboxPolicy {
  switch (sandbox) {
    case "read-only":
      return { type: "readOnly", networkAccess: false };
    case "workspace-write":
      return { type: "workspaceWrite", writableRoots: [], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
    case "danger-full-access":
      return { type: "dangerFullAccess" };
  }
}

// rookery effort vocab (low..max) → Codex ReasoningEffort (low..xhigh). `max` has no
// Codex analog → xhigh. Unknown/empty → undefined (omit → Codex model default).
export function mapEffort(effort: string | undefined): string | undefined {
  switch (effort) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return effort;
    case "max":
      return "xhigh";
    default:
      return undefined;
  }
}
```

- [ ] **Step 2: `src/core/codex/codex-pricing.ts`**:

```ts
import type { CodexTokenUsageBreakdown } from "./codex-protocol.js";

// Per-model $/1M-token rates. Deliberately EMPTY in P1: hardcoding stale prices is worse
// than reporting 0 (the desktop cost UI treats 0/absent gracefully; global usage comes from
// ccusage's Codex support). Fill in P1.5 when we commit to a maintained table.
const RATES: Record<string, { input: number; cachedInput: number; output: number }> = {};

export function turnCostUsd(model: string, usage: CodexTokenUsageBreakdown | undefined): number {
  const rate = RATES[model];
  if (!rate || !usage) return 0;
  const input = ((usage.inputTokens ?? 0) - (usage.cachedInputTokens ?? 0)) * rate.input;
  const cached = (usage.cachedInputTokens ?? 0) * rate.cachedInput;
  const output = (usage.outputTokens ?? 0) * rate.output;
  return (input + cached + output) / 1_000_000;
}
```

- [ ] **Step 3: `test/helpers/fake-codex.ts`** — the scripted app-server (the Codex analog of `fakeStreamingQuery`):

```ts
import type { CodexSpawn, CodexTransport } from "../../src/core/codex/codex-transport.js";

// One step of a scripted turn — what the fake server emits in response to turn/start.
export type CodexStep =
  | { kind: "agentDelta"; text: string }
  | { kind: "reasoningDelta"; text: string }
  | { kind: "agentMessage"; text: string; id?: string }
  | { kind: "command"; id: string; command: string; output?: string; failed?: boolean }
  | { kind: "fileChange"; id: string; failed?: boolean }
  | { kind: "tokenUsage"; last: { inputTokens: number; cachedInputTokens?: number }; contextWindow?: number }
  | { kind: "errorNote"; message: string }
  | { kind: "requestApproval"; id: string } // emits a server→client commandExecution approval request
  | { kind: "turnEnd"; status?: "completed" | "interrupted" | "failed"; durationMs?: number; errorMessage?: string };

export interface FakeCodexServerOpts {
  threadId?: string;
  failThreadStart?: boolean; // reject thread/start (spawn/handshake failure path)
  dieAfterTurns?: number;    // simulate process death after N completed turns
}

// Drives CodexClient exactly like fakeStreamingQuery drives ClaudeBackend: per turn/start,
// replays the responder's steps as notifications, then turn/completed (unless the step list
// ends the turn itself). Handles initialize/thread lifecycle with canned responses.
export function fakeCodexSpawn(
  responder: (text: string, turn: number) => CodexStep[],
  opts: FakeCodexServerOpts = {},
): { spawn: CodexSpawn; requests: Array<{ method: string; params: Record<string, unknown> }> } {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const threadId = opts.threadId ?? "th-1";
  const spawn: CodexSpawn = () => {
    let lineCb: (l: string) => void = () => {};
    let exitCb: (i: { code: number | null; message?: string }) => void = () => {};
    let killed = false;
    let turnCount = 0;
    const send = (o: unknown) => { if (!killed) queueMicrotask(() => { if (!killed) lineCb(JSON.stringify(o)); }); };
    const transport: CodexTransport = {
      onLine: (cb) => { lineCb = cb; },
      onExit: (cb) => { exitCb = cb; },
      kill: () => { killed = true; },
      write: (line) => {
        const msg = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> };
        if (!msg.method) return; // client responses to server requests — recorded via requests? no: ignore
        requests.push({ method: msg.method, params: msg.params ?? {} });
        if (msg.method === "initialize") { send({ id: msg.id, result: { userAgent: "fake" } }); return; }
        if (msg.method === "initialized") return;
        if (msg.method === "thread/start" || msg.method === "thread/resume" || msg.method === "thread/fork") {
          if (opts.failThreadStart) { send({ id: msg.id, error: { code: -32000, message: "no auth" } }); return; }
          const id = msg.method === "thread/fork" ? `${threadId}-fork` : threadId;
          send({ method: "thread/started", params: { thread: { id } } });
          send({ id: msg.id, result: { thread: { id }, model: "gpt-5.5" } });
          return;
        }
        if (msg.method === "turn/interrupt") {
          send({ id: msg.id, result: {} });
          send({ method: "turn/completed", params: { threadId, turn: { id: `turn-${turnCount}`, status: "interrupted", durationMs: 5 } } });
          return;
        }
        if (msg.method === "turn/start") {
          const turnId = `turn-${turnCount}`;
          send({ id: msg.id, result: { turn: { id: turnId, status: "inProgress" } } });
          send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress" } } });
          const input = (msg.params?.input as Array<{ text?: string }> | undefined) ?? [];
          const text = input[0]?.text ?? "";
          let ended = false;
          for (const step of responder(text, turnCount)) {
            if (step.kind === "agentDelta") send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "m1", delta: step.text } });
            else if (step.kind === "reasoningDelta") send({ method: "item/reasoning/summaryTextDelta", params: { threadId, turnId, itemId: "r1", delta: step.text } });
            else if (step.kind === "agentMessage") send({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: step.id ?? "m1", text: step.text } } });
            else if (step.kind === "command") {
              send({ method: "item/started", params: { threadId, turnId, item: { type: "commandExecution", id: step.id, command: step.command, status: "inProgress" } } });
              send({ method: "item/completed", params: { threadId, turnId, item: { type: "commandExecution", id: step.id, command: step.command, status: step.failed ? "failed" : "completed", aggregatedOutput: step.output ?? "" } } });
            } else if (step.kind === "fileChange") {
              send({ method: "item/started", params: { threadId, turnId, item: { type: "fileChange", id: step.id, changes: [], status: "inProgress" } } });
              send({ method: "item/completed", params: { threadId, turnId, item: { type: "fileChange", id: step.id, changes: [], status: step.failed ? "failed" : "completed" } } });
            } else if (step.kind === "tokenUsage") {
              send({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { last: step.last, total: step.last, modelContextWindow: step.contextWindow ?? null } } });
            } else if (step.kind === "errorNote") {
              send({ method: "error", params: { threadId, turnId, error: { message: step.message }, willRetry: false } });
            } else if (step.kind === "requestApproval") {
              send({ id: 9000 + turnCount, method: "item/commandExecution/requestApproval", params: { threadId, turnId, itemId: step.id } });
            } else if (step.kind === "turnEnd") {
              ended = true;
              send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: step.status ?? "completed", durationMs: step.durationMs ?? 0, ...(step.errorMessage ? { error: { message: step.errorMessage } } : {}) } } });
            }
          }
          if (!ended) send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", durationMs: 0 } } });
          turnCount++;
          if (opts.dieAfterTurns != null && turnCount >= opts.dieAfterTurns) {
            killed = true;
            queueMicrotask(() => exitCb({ code: 1, message: "simulated crash" }));
          }
          return;
        }
        // any other request: generic empty result
        send({ id: msg.id, result: {} });
      },
    };
    return transport;
  };
  return { spawn, requests };
}
```

NOTE: `write` receives client RESPONSES to server requests too (frames with `id`+`result` and no `method`) — the early `if (!msg.method) return;` skips them; if the approval test needs to observe the decline response, extend the helper to record them in a `responses` array (do so if needed by Task 4).

- [ ] **Step 4: `test/core/codex/codex-vocab.test.ts`** — table-driven over the three functions:

```ts
import { describe, it, expect } from "vitest";
import { mapPermissionMode, sandboxPolicyFor, mapEffort } from "../../../src/core/codex/codex-vocab.js";
import { turnCostUsd } from "../../../src/core/codex/codex-pricing.js";

describe("codex vocab", () => {
  it("maps permission modes to approval/sandbox pairs", () => {
    expect(mapPermissionMode("bypassPermissions")).toEqual({ approvalPolicy: "never", sandbox: "danger-full-access" });
    expect(mapPermissionMode("acceptEdits")).toEqual({ approvalPolicy: "never", sandbox: "workspace-write" });
    expect(mapPermissionMode("default")).toEqual({ approvalPolicy: "never", sandbox: "workspace-write" });
    expect(mapPermissionMode("plan")).toEqual({ approvalPolicy: "never", sandbox: "read-only" });
    expect(mapPermissionMode("unknown-mode")).toEqual({ approvalPolicy: "never", sandbox: "danger-full-access" });
  });
  it("builds per-turn sandbox policy objects", () => {
    expect(sandboxPolicyFor("danger-full-access")).toEqual({ type: "dangerFullAccess" });
    expect(sandboxPolicyFor("read-only")).toEqual({ type: "readOnly", networkAccess: false });
    expect(sandboxPolicyFor("workspace-write")).toMatchObject({ type: "workspaceWrite", writableRoots: [] });
  });
  it("maps effort with max→xhigh and unknown→undefined", () => {
    expect(mapEffort("high")).toBe("high");
    expect(mapEffort("max")).toBe("xhigh");
    expect(mapEffort("weird")).toBeUndefined();
    expect(mapEffort(undefined)).toBeUndefined();
  });
  it("pricing returns 0 with an empty rate table", () => {
    expect(turnCostUsd("gpt-5.5", { inputTokens: 1000, outputTokens: 500 })).toBe(0);
  });
});
```

- [ ] **Step 5: Run new tests + typecheck + full suite** → PASS.
- [ ] **Step 6: Commit** — `git add -A src/core/codex test && git commit -m "feat(codex): permission/effort vocabulary, pricing skeleton, scripted fake app-server" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 3: `CodexBackend` — session state machine + event translation (TDD)

**Files:**
- Create: `src/core/codex/codex-backend.ts`
- Test: `test/core/codex/codex-backend.test.ts`

**Interfaces:**
- Consumes: Task 1's client/transport, Task 2's vocab/pricing/fake, P0's `AgentBackend`/`AgentStream`/`AgentEvent` (`src/core/agent-backend.ts`).
- Produces: `CodexBackendDeps { spawn: CodexSpawn; defaultModel: () => string }`, `class CodexBackend implements AgentBackend` — `openSession(input, opts)` full lifecycle; `startTurn()` throws `"Codex master sessions are not supported yet"`; `forkSession(threadId: string): Promise<{ sessionId: string }>` (ephemeral child).

- [ ] **Step 1: Write the failing tests** — `test/core/codex/codex-backend.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { CodexBackend } from "../../../src/core/codex/codex-backend.js";
import { fakeCodexSpawn, type CodexStep } from "../../helpers/fake-codex.js";
import type { AgentEvent, AgentStream } from "../../../src/core/agent-backend.js";
import { MessageQueue } from "../../../src/core/message-queue.js";

async function collect(stream: AgentStream): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

function backend(responder: (text: string, turn: number) => CodexStep[], opts?: Parameters<typeof fakeCodexSpawn>[1]) {
  const fake = fakeCodexSpawn(responder, opts);
  return { backend: new CodexBackend({ spawn: fake.spawn, defaultModel: () => "gpt-5.5" }), requests: fake.requests };
}

function baseOpts(over: Record<string, unknown> = {}) {
  return { cwd: "/wt", model: "gpt-5.5", effort: "high", permissionMode: "bypassPermissions", abortController: new AbortController(), ...over };
}

describe("CodexBackend.openSession — translation", () => {
  it("runs one turn: early session_id, deltas, message, command tool pair, telemetry", async () => {
    const { backend: b } = backend(() => [
      { kind: "reasoningDelta", text: "hmm" },
      { kind: "agentDelta", text: "he" },
      { kind: "agentMessage", text: "hello" },
      { kind: "command", id: "c1", command: "ls -la", output: "files" },
      { kind: "tokenUsage", last: { inputTokens: 900, cachedInputTokens: 100 }, contextWindow: 272000 },
      { kind: "turnEnd", durationMs: 42 },
    ]);
    const q = new MessageQueue();
    q.push("do the task");
    q.close();
    const events = await collect(b.openSession(q, baseOpts()));
    expect(events[0]).toEqual({ kind: "session_id", sessionId: "th-1" });
    expect(events).toContainEqual({ kind: "thinking_delta", text: "hmm" });
    expect(events).toContainEqual({ kind: "text_delta", text: "he" });
    expect(events).toContainEqual({ kind: "message", role: "assistant", text: "hello", parentToolUseId: null });
    expect(events).toContainEqual({ kind: "tool_use", id: "c1", name: "shell", input: { command: "ls -la", cwd: undefined }, parentToolUseId: null });
    expect(events).toContainEqual({ kind: "tool_result", toolUseId: "c1", isError: false, content: "files", parentToolUseId: null });
    expect(events.at(-1)).toEqual({ kind: "turn_end", subtype: "success", costUsd: 0, numTurns: 1, durationMs: 42, contextTokens: 1000, contextWindow: 272000 });
  });

  it("synthesizes CUMULATIVE numTurns across turns (port contract — worker maxTurns cap)", async () => {
    const { backend: b } = backend(() => [{ kind: "turnEnd" }]);
    const q = new MessageQueue();
    q.push("t1"); q.push("t2"); q.push("t3");
    q.close();
    const events = await collect(b.openSession(q, baseOpts()));
    const turns = events.filter((e) => e.kind === "turn_end");
    expect(turns.map((t) => (t as { numTurns: number }).numTurns)).toEqual([1, 2, 3]);
  });

  it("maps thread start options: cwd, model, effort, approval/sandbox from permissionMode", async () => {
    const { backend: b, requests } = backend(() => [{ kind: "turnEnd" }]);
    const q = new MessageQueue(); q.push("x"); q.close();
    await collect(b.openSession(q, baseOpts({ permissionMode: "plan", effort: "max" })));
    const start = requests.find((r) => r.method === "thread/start")!.params;
    expect(start).toMatchObject({ cwd: "/wt", model: "gpt-5.5", approvalPolicy: "never", sandbox: "read-only" });
    const turn = requests.find((r) => r.method === "turn/start")!.params;
    expect(turn).toMatchObject({ threadId: "th-1", effort: "xhigh", input: [{ type: "text", text: "x", text_elements: [] }] });
  });

  it("resumes via thread/resume when opts.resume is set", async () => {
    const { backend: b, requests } = backend(() => [{ kind: "turnEnd" }]);
    const q = new MessageQueue(); q.push("x"); q.close();
    const events = await collect(b.openSession(q, baseOpts({ resume: "th-1" })));
    expect(requests.some((r) => r.method === "thread/resume" && (r.params as { threadId?: string }).threadId === "th-1")).toBe(true);
    expect(requests.some((r) => r.method === "thread/start")).toBe(false);
    expect(events[0]).toEqual({ kind: "session_id", sessionId: "th-1" });
  });

  it("turn failed → notice push + turn_end subtype error (recoverable, worker stays alive)", async () => {
    const { backend: b } = backend(() => [{ kind: "turnEnd", status: "failed", errorMessage: "rate limited" }]);
    const q = new MessageQueue(); q.push("x"); q.close();
    const events = await collect(b.openSession(q, baseOpts()));
    const notice = events.find((e) => e.kind === "push");
    expect(notice).toMatchObject({ kind: "push", push: { kind: "notice", code: "notice.codexError" } });
    expect(events.at(-1)).toMatchObject({ kind: "turn_end", subtype: "error" });
  });

  it("process death mid-session → the stream throws (worker goes terminal error)", async () => {
    const { backend: b } = backend(() => [{ kind: "turnEnd" }], { dieAfterTurns: 1 });
    const q = new MessageQueue(); q.push("t1"); q.push("t2"); // second turn never runs
    await expect(collect(b.openSession(q, baseOpts()))).rejects.toThrow(/exited|crash/);
  });

  it("thread/start failure surfaces as a stream throw", async () => {
    const { backend: b } = backend(() => [], { failThreadStart: true });
    const q = new MessageQueue(); q.push("x"); q.close();
    await expect(collect(b.openSession(q, baseOpts()))).rejects.toThrow(/no auth/);
  });

  it("startTurn (master path) throws a clean not-supported error", () => {
    const { backend: b } = backend(() => []);
    expect(() => b.startTurn("hi", baseOpts() as never)).toThrow(/not supported/);
  });
});
```

- [ ] **Step 2: Run to verify failure** → module not found.

- [ ] **Step 3: Create `src/core/codex/codex-backend.ts`**:

```ts
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
class EventChannel {
  private buffer: AgentEvent[] = [];
  private waiter: ((r: IteratorResult<AgentEvent>) => void) | null = null;
  private done = false;
  private error: Error | null = null;

  push(ev: AgentEvent): void {
    if (this.done) return;
    if (this.waiter) { const w = this.waiter; this.waiter = null; w({ value: ev, done: false }); }
    else this.buffer.push(ev);
  }

  fail(err: Error): void {
    if (this.done) return;
    this.error = err;
    this.end();
  }

  end(): void {
    if (this.done && !this.waiter) return;
    this.done = true;
    if (this.waiter) { const w = this.waiter; this.waiter = null; w({ value: undefined as never, done: true }); }
  }

  async next(): Promise<IteratorResult<AgentEvent>> {
    const buffered = this.buffer.shift();
    if (buffered !== undefined) return { value: buffered, done: false };
    if (this.done) {
      if (this.error) { const e = this.error; this.error = null; throw e; }
      return { value: undefined as never, done: true };
    }
    return new Promise((resolve) => { this.waiter = resolve; });
  }

  takeError(): Error | null { const e = this.error; this.error = null; return e; }
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
```

- [ ] **Step 4: Add the i18n notice code.** In `src/core/i18n.ts`, add to BOTH the ko and en catalogs (match the file's existing `notice.*` entry style and param interpolation syntax exactly — read neighbors first):
  - ko: `"notice.codexError": "Codex 오류: {message}"`
  - en: `"notice.codexError": "Codex error: {message}"`
  Then add the byte-identical key to the desktop renderer notice catalogs (`apps/desktop/src/renderer/i18n/` — find where the other `notice.*` codes live, e.g. the locale files that contain `notice.compact`) with the same param name `message` in both ko and en. Do NOT touch `apps/desktop/src/main/i18n.ts`.

- [ ] **Step 5: Green** — `npx vitest run test/core/codex/ && npm run typecheck && npm test` → PASS. (If the i18n key assertion style in `test/core/i18n.test.ts` enumerates codes, update per its pattern.)
- [ ] **Step 6: Commit** — `git add -A src test apps/desktop/src/renderer && git commit -m "feat(codex): CodexBackend — app-server session state machine + AgentEvent translation" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 4: Contract lock-in — interrupt, controls, approvals, abort, fork (TDD)

**Files:**
- Modify: `test/core/codex/codex-backend.test.ts` (append), `test/helpers/fake-codex.ts` (only if a case needs a recorded client response — see Task 2 note)

- [ ] **Step 1: Append these tests** (all must pass against Task 3's implementation; if one fails, fix `codex-backend.ts`/`fake-codex.ts` — never weaken a test):

```ts
describe("CodexBackend — controls and edges", () => {
  it("interrupt routes turn/interrupt with the ACTIVE turn id and yields subtype interrupted", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { backend: b, requests } = backend(() => [{ kind: "agentDelta", text: "working…" }]); // turn never self-ends
    const q = new MessageQueue(); q.push("long task");
    const stream = b.openSession(q, baseOpts());
    const seen: AgentEvent[] = [];
    const done = (async () => { for await (const ev of stream) { seen.push(ev); if (ev.kind === "text_delta") release(); if (ev.kind === "turn_end") { q.close(); } } })();
    await gate;
    await stream.interrupt();
    await done;
    const intr = requests.find((r) => r.method === "turn/interrupt");
    expect(intr?.params).toEqual({ threadId: "th-1", turnId: "turn-0" });
    expect(seen.at(-1)).toMatchObject({ kind: "turn_end", subtype: "interrupted" });
  });

  it("interrupt with no active turn is a resolved no-op (no request sent)", async () => {
    const { backend: b, requests } = backend(() => [{ kind: "turnEnd" }]);
    const q = new MessageQueue(); q.push("x"); q.close();
    const stream = b.openSession(q, baseOpts());
    await collect(stream);
    await expect(stream.interrupt()).resolves.toBeUndefined();
    expect(requests.some((r) => r.method === "turn/interrupt")).toBe(false);
  });

  it("setModel/setPermissionMode apply as overrides on the NEXT turn/start", async () => {
    const { backend: b, requests } = backend(() => [{ kind: "turnEnd" }]);
    const q = new MessageQueue(); q.push("t1");
    const stream = b.openSession(q, baseOpts());
    const seen: AgentEvent[] = [];
    const done = (async () => {
      for await (const ev of stream) {
        seen.push(ev);
        if (ev.kind === "turn_end" && (ev as { numTurns: number }).numTurns === 1) {
          await stream.setModel("gpt-5.5-mini");
          await stream.setPermissionMode("plan");
          q.push("t2"); q.close();
        }
      }
    })();
    await done;
    const turnStarts = requests.filter((r) => r.method === "turn/start");
    expect(turnStarts[0]!.params).not.toHaveProperty("sandboxPolicy");
    expect(turnStarts[1]!.params).toMatchObject({ model: "gpt-5.5-mini", approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false } });
  });

  it("unexpected approval request → declined + transcript notice, turn still completes", async () => {
    const { backend: b } = backend(() => [{ kind: "requestApproval", id: "c9" }, { kind: "turnEnd" }]);
    const q = new MessageQueue(); q.push("x"); q.close();
    const events = await collect(b.openSession(q, baseOpts()));
    expect(events.some((e) => e.kind === "push" && (e as { push: { text: string } }).push.text.includes("declined unexpected approval"))).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: "turn_end", subtype: "success" });
  });

  it("abort mid-session ends the stream silently (no throw) — Claude parity", async () => {
    const abortController = new AbortController();
    const { backend: b } = backend(() => [{ kind: "agentDelta", text: "…" }]); // turn never ends
    const q = new MessageQueue(); q.push("x");
    const stream = b.openSession(q, baseOpts({ abortController }));
    const seen: AgentEvent[] = [];
    const done = (async () => { for await (const ev of stream) { seen.push(ev); if (ev.kind === "text_delta") abortController.abort(); } })();
    await expect(done).resolves.toBeUndefined();
  });

  it("supportedCommands resolves [] and forkSession returns the forked thread id", async () => {
    const { backend: b } = backend(() => [{ kind: "turnEnd" }]);
    const q = new MessageQueue(); q.push("x"); q.close();
    const stream = b.openSession(q, baseOpts());
    await collect(stream);
    await expect(stream.supportedCommands()).resolves.toEqual([]);
    await expect(b.forkSession("th-1")).resolves.toEqual({ sessionId: "th-1-fork" });
  });
});
```

Timing note for the implementer: the fake emits via `queueMicrotask`, so "await gate → interrupt" sequencing is deterministic; if a test flakes, the bug is real ordering in the backend (e.g. `activeTurnId` set too late) — fix the code, not the test.

- [ ] **Step 2: Green + full suite + typecheck.**
- [ ] **Step 3: Commit** — `git add -A test src && git commit -m "test(codex): lock interrupt/controls/approval-decline/abort/fork contracts" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 5: Provider plumbing — migration, fleet, protocol, tools, settings, server wiring

**Files:**
- Modify: `src/persistence/db.ts` (append ONE migration), `src/persistence/repositories.ts`, `src/core/fleet-orchestrator.ts`, `src/protocol/messages.ts`, `src/tools/fleet-tools.ts`, `src/daemon/connection.ts`, `src/core/settings.ts`, `src/daemon/server.ts`
- Test: `test/persistence/repositories.test.ts` (or the file where createWorker round-trips live), `test/core/fleet-orchestrator.test.ts`, `test/tools/fleet-tools.test.ts` (locations: mirror of src — verify with `ls test/`)

Read each file before editing — line anchors below are approximate; match on content.

- [ ] **Step 1: Migration.** In `src/persistence/db.ts`, append to the END of `MIGRATIONS`:

```ts
  // workers.provider: which AgentBackend runs this worker ("claude" | "codex"). Default keeps
  // every pre-existing row on the Claude backend.
  `ALTER TABLE workers ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'`,
```

(Match the array's existing entry format — if entries are functions or objects rather than SQL strings, follow that shape.) Do not touch existing entries. `db.test.ts` asserts version === MIGRATIONS.length and will pass automatically.

- [ ] **Step 2: Repositories.** In `src/persistence/repositories.ts`: `createWorker` accepts optional `provider?: string` (INSERT column with default `'claude'` when absent); the worker row type/read paths (`getWorker`, `listWorkers`, any `SELECT *` mapping) expose `provider`. Follow the existing column pattern (e.g. how `permission_mode` flows). Add a round-trip test: create with `provider: "codex"` → `getWorker(...)!.provider === "codex"`; create without → `"claude"`.

- [ ] **Step 3: FleetOrchestrator.** In `src/core/fleet-orchestrator.ts`:
  - `WorkerFactory` opts: add `provider?: string`.
  - `Entry`: add `provider?: string`.
  - `spawn(...)` and the UI/tool spawn path: accept `provider?: string`, persist via `repos.createWorker({..., provider})`, store on the entry, pass to `factory`.
  - `materialize`/`rehydrate`: read `provider` from the DB row into the entry and pass to the factory.
  - `fork(...)`: change `FleetDeps.forkSession` to `(provider: string, sdkSessionId: string, opts?: { title?: string }) => Promise<{ sessionId: string }>` and pass the source worker's provider (default `"claude"`); the forked worker row inherits the source's provider.
  - `list()`: include `provider` in the returned row (same place `permissionMode`/`model` flow).
  - Update `test/core/fleet-orchestrator.test.ts` fork stubs to the new signature (mechanical: add the leading provider arg) and add one test: spawn with `provider:"codex"` → factory received it AND the DB row has it; fork of a codex worker calls `forkSession("codex", ...)`.

- [ ] **Step 4: Protocol.** In `src/protocol/messages.ts`: the `worker.spawn` client message schema gains `provider: z.enum(["claude", "codex"]).optional()`; the outbound `WorkerRow` type gains `provider?: string`. In `src/daemon/connection.ts`, pass `provider` through the spawn handler into `fleet.spawn` (find the existing `worker.spawn` case; thread it exactly like `model`/`permissionMode`).

- [ ] **Step 5: fleet-tools.** In `src/tools/fleet-tools.ts`: `spawn_worker` input schema gains `provider: z.enum(["claude", "codex"]).optional().describe("Agent backend for this worker (default claude). codex = OpenAI Codex via app-server.")`; pass through to `fleet.spawn`. `FLEET_TOOL_NAMES` unchanged (no new tool). Update the tool's description string mentioning the provider option in one sentence. Add/extend a fleet-tools test asserting the param reaches `fleet.spawn`.

- [ ] **Step 6: Settings.** In `src/core/settings.ts` (read the file; follow the existing accessor patterns exactly):
  - `codexWorkerModel(): string` — default `"gpt-5.5"`.
  - `codexBin(): string` — default `"codex"`.
  (No `codexApiKey` in P1 — the app-server ignores `CODEX_API_KEY` env; auth relies on the user's `~/.codex/auth.json` via `codex login`. An in-app key needs CODEX_HOME redirection + `account/login/start` provisioning — P1.5.)
  Add settings tests following the file's existing test patterns (`test/core/settings.test.ts`).

- [ ] **Step 7: Server wiring.** In `src/daemon/server.ts`:

```ts
import { CodexBackend } from "../core/codex/codex-backend.js";
import { realCodexSpawn } from "../core/codex/codex-transport.js";
```

after the existing `const backend = new ClaudeBackend(queryFn);`:

```ts
  // Backend registry (P1): workers pick by provider; the master stays on Claude.
  // Codex auth = the user's ~/.codex/auth.json (`codex login`) — see codex-transport.ts AUTH NOTE.
  const codexBackend = new CodexBackend({
    spawn: realCodexSpawn(() => settings.codexBin()),
    defaultModel: () => settings.codexWorkerModel(),
  });
  const workerBackends: Record<string, import("../core/agent-backend.js").AgentBackend> = { claude: backend, codex: codexBackend };
```

`subFactory`: add `provider` to its opts type; worker deps get `backend: workerBackends[o.provider ?? "claude"] ?? backend`; codex workers use `model: o.model ?? settings.codexWorkerModel()` (claude path keeps `settings.workerModel()` — pick by provider). Fleet deps `forkSession` becomes the router:

```ts
    forkSession: (provider, id, opts) =>
      provider === "codex" ? codexBackend.forkSession(id) : sdkForkSession(id, opts),
```

(SessionManager's own `forkSession` — master fork — is unchanged.)

- [ ] **Step 8: Full verification** — `npm run typecheck && npm test` green; run `npx vitest run test/persistence test/core/fleet-orchestrator.test.ts test/tools` focused first.
- [ ] **Step 9: Commit** — `git add -A src test && git commit -m "feat(fleet): provider column + codex spawn/rehydrate/fork routing + settings + server registry" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 6: Final sweep — docs + neutrality + full gates

**Files:**
- Modify: `AGENTS.md` (CLAUDE.md symlink), `docs/2026-07-05-codex-backend-parity.md`, `test/core/provider-neutral.test.ts` (extend list)

- [ ] **Step 1: Extend the neutrality gate.** Add `"src/core/codex/codex-backend.ts"`, `"src/core/codex/codex-client.ts"`, `"src/core/codex/codex-protocol.ts"`, `"src/core/codex/codex-vocab.ts"` to `NEUTRAL_FILES` (the Codex adapter must never import the Claude SDK).
- [ ] **Step 2: AGENTS.md** — two surgical edits:
  - In the Fleet section, after the spawn sentence, add: `Workers can run on either backend: `spawn_worker`/`worker.spawn` take `provider: "claude" | "codex"` (default claude); codex workers run via a per-worker `codex app-server` child (`src/core/codex/`, protocol pinned to CLI 0.142.5 — regenerate types with `codex app-server generate-ts` on bumps). The master remains Claude-only (P2).`
  - In the "Fragile conventions / pitfalls" section add one bullet: `**Codex worker auth** rides on the user's `~/.codex/auth.json` (`codex login`) — the app-server child does NOT read `CODEX_API_KEY` (verified against rust-v0.142.5); an in-app key setting is P1.5 (CODEX_HOME redirection + account/login/start).`
- [ ] **Step 3: Parity doc** — update the status blockquote: `P1 (Codex worker backend) implemented 2026-07-06 — see docs/2026-07-06-p1-codex-worker-backend.md; desktop provider UX, per-turn pricing, and the Codex master remain open (P1.5/P2/P3).`
- [ ] **Step 4: Full gates** — `npm run typecheck && npm test && npm run build` → all green.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "docs(codex): P1 status + provider docs; extend neutrality gate to codex adapter" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

## Post-plan (controller, not subagents)

Live smoke against the real binary (this machine has Codex CLI 0.142.5, authed): temp git repo → daemon with real wiring → spawn codex worker ("create hello.txt with one line") → observe transcript events → interrupt → send follow-up → stop. Then final whole-branch review (fable) → merge decision.

## Self-Review Notes

- Spec coverage: transport/client (T1), vocab/pricing/fake (T2), backend+i18n (T3), contracts (T4), plumbing (T5), docs/gates (T6). Non-goals excluded per spec.
- Type consistency: `CodexSpawn` produced T1 consumed T2/T3/T5; `fakeCodexSpawn(responder, opts)` produced T2 consumed T3/T4; `CodexBackendDeps { spawn, defaultModel }` produced T3 consumed T5; fork router signature `(provider, id, opts)` consistent T5 across fleet-orchestrator/server/tests.
- Known risk: `EventChannel`/pump concurrency is the subtle core — T3/T4 tests pin ordering; reviewers must verify no lost-wakeup (single waiter, push-before-await races) and that `turnDone` always resolves (turn/completed OR client close) so the pump can't hang.
