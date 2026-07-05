# P0 Agent-Backend Seam Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a provider-neutral `AgentBackend` port from the Claude-SDK-coupled stream loops in `worker.ts`/`master-agent.ts`, with a `ClaudeBackend` adapter absorbing all SDK message decoding — zero behavior change (pure refactor, Phase 0 of `docs/2026-07-05-codex-backend-parity.md`).

**Architecture:** Both stream loops today duck-type raw SDK messages and immediately translate them into the internal vocabulary (`WorkerEventData`/`CoreEvent`). We codify that translation as a neutral `AgentEvent` stream: `AgentBackend.openSession(input, opts)` (worker: streaming input) and `AgentBackend.startTurn(prompt, opts)` (master: string prompt + resume) both return an `AgentStream` (`AsyncIterable<AgentEvent>` + interrupt/setModel/setPermissionMode/supportedCommands). `ClaudeBackend` wraps `QueryFn` and contains everything moved out of the two loops: option assembly (effort gating, thinking, `claude_code` preset+append), message decode, `classifySystemPush`, `turnContext`, and early session-id capture. Claude-specific aux paths (labeler, CommandCatalog probe, interaction-registry, `src/tools/*`) intentionally stay on `QueryFn`/SDK types until P1/P2.

**Tech Stack:** TypeScript (ESM NodeNext), vitest, no new dependencies.

## Global Constraints

- **Node 22 first** for every command: `source ~/.nvm/nvm.sh && nvm use 22` (or ensure `node -v` shows v22) before npm/npx — better-sqlite3 is built against ABI 127.
- ESM NodeNext: relative imports **must** carry the `.js` extension; type-only imports **must** use `import type` (`verbatimModuleSyntax: true`).
- Code comments in English. No user-facing string changes (i18n untouched). No DB migrations (schema untouched).
- Zero behavior change is the exit criterion: no protocol, DB, or renderer diffs; all existing tests stay green (only their construction sites migrate).
- Commit message trailer (repo convention): `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Typecheck gate: `npm run typecheck` must pass at the end of every task (tsx/vitest do not typecheck).

## Known intentional micro-deltas (documented, accepted)

These are the only behavior deltas, all unobservable in practice — do not "fix" them:
1. A message containing **only thinking blocks** (no text/tools) no longer triggers `flushThinking()` at that exact point; the flush happens at the next message/tool/turn-end event. Relative order of persisted rows is unchanged (nothing else is persisted in between).
2. The adapter extracts `tool_use` blocks from user-type messages too (previously worker/master only read them from assistant messages outside the nested path). Real SDK user messages never carry `tool_use` blocks.
3. Master previously read `tool_result` blocks only from user-type messages; the adapter reads them from any message. Real assistant messages never carry `tool_result` blocks.

---

### Task 1: Provider-neutral port module (`agent-backend.ts`)

**Files:**
- Create: `src/core/agent-backend.ts`
- Modify: `src/core/commands.ts` (move `SlashCommandInfo` out, re-export)

**Interfaces:**
- Produces: `AgentEvent`, `AgentStream`, `AgentBackend`, `AgentSessionOptions`, `MasterTurnOptions`, `SlashCommandInfo`, `ProviderMcpServer`, `ProviderPermissionCallback` — every later task consumes these exact names.

- [ ] **Step 1: Create `src/core/agent-backend.ts`** with exactly:

```ts
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
```

- [ ] **Step 2: Move `SlashCommandInfo` out of `src/core/commands.ts`.** Replace its interface definition (lines 4-10, the block starting `// A single slash command/skill`) with:

```ts
// Re-exported from the port module (neutral vocabulary) — existing importers keep this path.
export type { SlashCommandInfo } from "./agent-backend.js";
```

and add `import type { SlashCommandInfo } from "./agent-backend.js";` at the top of `commands.ts` (the file still uses the name internally in `Probeable`/`forCwd`/`probe`).

Note: `system-push.ts` keeps importing `SlashCommandInfo` from `./commands.js` (the re-export). The resulting import cycle (agent-backend → system-push → commands → agent-backend) is **type-only on every edge**, which `verbatimModuleSyntax` erases at compile — no runtime cycle. Do not "fix" it by moving `SystemPush`.

- [ ] **Step 3: Typecheck + full test run**

Run: `npm run typecheck && npm test`
Expected: both pass (types-only change).

- [ ] **Step 4: Commit**

```bash
git add src/core/agent-backend.ts src/core/commands.ts
git commit -m "feat(core): provider-neutral AgentBackend port types (P0 seam)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `ClaudeBackend` — option assembly + `startTurn` translation (TDD)

**Files:**
- Create: `src/core/claude-backend.ts`
- Test: `test/core/claude-backend.test.ts`

**Interfaces:**
- Consumes: Task 1's port types; existing `extractText/extractToolUses/extractToolResults` (`sdk-extract.ts`), `classifySystemPush` (`system-push.ts`), `turnContext` (`result-telemetry.ts`), `effortApplies/coerceEffort` (`effort.ts`).
- Produces: `export type QueryFn = typeof sdkQuery` (new canonical home; worker.ts's copy is removed in Task 4), `export class ClaudeBackend implements AgentBackend` with constructor `new ClaudeBackend(queryFn: QueryFn)`, `export async function* claudeUserMessages(input: AsyncIterable<string>): AsyncIterable<SDKUserMessage>`.

- [ ] **Step 1: Write the failing tests** — create `test/core/claude-backend.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ClaudeBackend, claudeUserMessages } from "../../src/core/claude-backend.js";
import type { QueryFn } from "../../src/core/claude-backend.js";
import type { AgentEvent, AgentStream } from "../../src/core/agent-backend.js";
import { fakeQuery } from "../helpers/fake-query.js";

async function collect(stream: AgentStream): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

// Raw message injector for shapes fakeQuery cannot produce (classified system pushes, nested system/result).
function rawQuery(messages: unknown[]): QueryFn {
  return ((_input: unknown) => {
    async function* gen() { for (const m of messages) yield m; }
    return Object.assign(gen(), { interrupt: async () => {} });
  }) as unknown as QueryFn;
}

function baseOpts(over: Record<string, unknown> = {}) {
  return { cwd: "/x", model: "claude-opus-4-8", effort: "high", permissionMode: "bypassPermissions", abortController: new AbortController(), ...over };
}

describe("ClaudeBackend.startTurn — event translation", () => {
  it("translates text, tools, session id, and result telemetry", async () => {
    const backend = new ClaudeBackend(fakeQuery([
      { type: "system", text: "init" },
      { type: "message_start", usage: { input_tokens: 100, cache_read_input_tokens: 50 } },
      { type: "thinking", text: "hmm" },
      { type: "assistant", text: "hello" },
      { type: "tool_use", id: "t1", name: "mcp__fleet__spawn_worker", input: { repo: "r" } },
      { type: "tool_result", id: "t1", isError: false, content: "ok" },
      { type: "result", subtype: "success", total_cost_usd: 0.5, num_turns: 2, session_id: "sdk-1", duration_ms: 10, modelUsage: { m: { contextWindow: 200000 } } },
    ]));
    const events = await collect(backend.startTurn("hi", baseOpts()));
    expect(events).toEqual([
      { kind: "system_text", text: "init" },
      { kind: "thinking_delta", text: "hmm" },
      { kind: "message", role: "assistant", text: "hello", parentToolUseId: null },
      { kind: "tool_use", id: "t1", name: "mcp__fleet__spawn_worker", input: { repo: "r" }, parentToolUseId: null },
      { kind: "tool_result", toolUseId: "t1", isError: false, content: "ok", parentToolUseId: null },
      { kind: "session_id", sessionId: "sdk-1" },
      { kind: "turn_end", subtype: "success", costUsd: 0.5, numTurns: 2, durationMs: 10, contextTokens: 150, contextWindow: 200000 },
    ]);
  });

  it("emits session_id EARLY from the init system message, before any turn end", async () => {
    const backend = new ClaudeBackend(rawQuery([
      { type: "system", subtype: "init", session_id: "sdk-early" },
      { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-early" },
    ]));
    const events = await collect(backend.startTurn("hi", baseOpts()));
    expect(events[0]).toEqual({ kind: "session_id", sessionId: "sdk-early" });
    // init with no other classification also surfaces as system_text (subtype fallback)
    expect(events[1]).toEqual({ kind: "system_text", text: "init" });
  });

  it("classifies system pushes (compact_boundary → notice push; commands_changed → commands push)", async () => {
    const backend = new ClaudeBackend(rawQuery([
      { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 150000, post_tokens: 20000 } },
      { type: "system", subtype: "commands_changed", commands: [{ name: "/x", description: "d" }] },
    ]));
    const events = await collect(backend.startTurn("hi", baseOpts()));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: "push", push: { kind: "notice", code: "notice.compact" } });
    expect(events[1]).toMatchObject({ kind: "push", push: { kind: "commands", commands: [{ name: "/x", description: "d" }] } });
  });

  it("forwards nested message/tool events with parentToolUseId, drops nested deltas/system/result", async () => {
    const backend = new ClaudeBackend(rawQuery([
      { type: "stream_event", parent_tool_use_id: "p1", event: { type: "content_block_delta", delta: { type: "text_delta", text: "nested-delta" } } },
      { type: "assistant", parent_tool_use_id: "p1", message: { role: "assistant", content: [{ type: "text", text: "nested says hi" }] } },
      { type: "system", parent_tool_use_id: "p1", subtype: "init", session_id: "nested-sdk" },
      { type: "result", parent_tool_use_id: "p1", subtype: "success", total_cost_usd: 9, num_turns: 9, session_id: "nested-sdk" },
      { type: "result", subtype: "success", total_cost_usd: 0.1, num_turns: 1, session_id: "sdk-1" },
    ]));
    const events = await collect(backend.startTurn("hi", baseOpts()));
    expect(events).toEqual([
      { kind: "message", role: "assistant", text: "nested says hi", parentToolUseId: "p1" },
      { kind: "session_id", sessionId: "sdk-1" },
      { kind: "turn_end", subtype: "success", costUsd: 0.1, numTurns: 1, durationMs: 0, contextTokens: 0, contextWindow: 0 },
    ]);
  });

  it("forwards user-role text as a message event (consumers decide to skip it)", async () => {
    const backend = new ClaudeBackend(fakeQuery([
      { type: "user_text", text: "sdk-injected context" },
      { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "s" },
    ]));
    const events = await collect(backend.startTurn("hi", baseOpts()));
    expect(events[0]).toEqual({ kind: "message", role: "user", text: "sdk-injected context", parentToolUseId: null });
  });
});

describe("ClaudeBackend — option assembly", () => {
  // Capture the exact SDK-level input the adapter builds (this suite is the adapter's option spec).
  function capture(script: Parameters<typeof fakeQuery>[0]) {
    let input: { prompt?: unknown; options?: Record<string, unknown> } = {};
    const inner = fakeQuery(script);
    const fn = ((i: typeof input) => { input = i; return inner(i as Parameters<QueryFn>[0]); }) as unknown as QueryFn;
    return { fn, input: () => input };
  }
  const RESULT = [{ type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "s" } as const];

  it("startTurn: preset+append, effort gating, resume, tool passthrough, no forwardSubagentText", async () => {
    const cap = capture(RESULT);
    const backend = new ClaudeBackend(cap.fn);
    const mcp = { fleet: { marker: true } };
    const canUse = () => {};
    await collect(backend.startTurn("hi", {
      ...baseOpts({ resume: "sdk-old", systemPromptAppend: "EXTRA" }),
      mcpServers: mcp, allowedTools: ["a", "b"], disallowedTools: ["CronCreate"], canUseTool: canUse,
    }));
    const o = cap.input().options!;
    expect(cap.input().prompt).toBe("hi");
    expect(o.model).toBe("claude-opus-4-8");
    expect(o.effort).toBe("high");
    expect(o.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(o.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "EXTRA" });
    expect(o.permissionMode).toBe("bypassPermissions");
    expect(o.includePartialMessages).toBe(true);
    expect(o.resume).toBe("sdk-old");
    expect(o.mcpServers).toBe(mcp);
    expect(o.allowedTools).toEqual(["a", "b"]);
    expect(o.disallowedTools).toEqual(["CronCreate"]);
    expect(o.canUseTool).toBe(canUse);
    expect(o.forwardSubagentText).toBeUndefined();
  });

  it("omits effort AND thinking for Haiku models; omits resume when absent", async () => {
    const cap = capture(RESULT);
    const backend = new ClaudeBackend(cap.fn);
    await collect(backend.startTurn("hi", baseOpts({ model: "claude-haiku-4-5" })));
    const o = cap.input().options!;
    expect(o.effort).toBeUndefined();
    expect(o.thinking).toBeUndefined();
    expect(o.resume).toBeUndefined();
  });
});

describe("claudeUserMessages", () => {
  it("wraps each input string into the minimal SDKUserMessage shape", async () => {
    async function* strings() { yield "one"; yield "two"; }
    const out: unknown[] = [];
    for await (const m of claudeUserMessages(strings())) out.push(m);
    expect(out).toEqual([
      { type: "user", message: { role: "user", content: "one" }, parent_tool_use_id: null },
      { type: "user", message: { role: "user", content: "two" }, parent_tool_use_id: null },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/core/claude-backend.test.ts`
Expected: FAIL — cannot resolve `../../src/core/claude-backend.js`.

- [ ] **Step 3: Create `src/core/claude-backend.ts`** with exactly:

```ts
import { query as sdkQuery, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentBackend, AgentEvent, AgentSessionOptions, AgentStream, MasterTurnOptions, SlashCommandInfo } from "./agent-backend.js";
import { extractText, extractToolUses, extractToolResults } from "./sdk-extract.js";
import { classifySystemPush } from "./system-push.js";
import { turnContext } from "./result-telemetry.js";
import { effortApplies, coerceEffort } from "./effort.js";

// The Claude Agent SDK query() signature — the adapter's own contract (canonical home; formerly worker.ts).
// Injected at the composition root (real sdkQuery in the daemon, fakeQuery in tests). Claude-specific
// aux paths that bypass the port (labeler, CommandCatalog probe) consume this type directly.
export type QueryFn = typeof sdkQuery;
type QueryInput = Parameters<QueryFn>[0];
type QueryOptions = NonNullable<QueryInput["options"]>;

// Wrap a stream of user input strings into the minimal SDKUserMessage shape required by streaming-input mode.
// No `as` assertion — if the SDK (0.x) adds mandatory fields, tsc catches it here (moved from message-queue.ts).
export async function* claudeUserMessages(input: AsyncIterable<string>): AsyncIterable<SDKUserMessage> {
  for await (const text of input) {
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    };
    yield msg;
  }
}

// Per-stream decode state: the last message_start's per-request usage. result.usage accumulates across
// multiple model calls within a turn (cache re-reads can exceed the window), so turn_end context % is
// computed from the LAST request's usage, falling back to the cumulative value (turnContext).
interface DecodeState {
  lastReqContextTokens: number;
}

// Translate one raw SDK message into zero or more provider-neutral AgentEvents.
// This is the decode moved verbatim out of the worker.ts/master-agent.ts stream loops — shapes are
// duck-typed exactly as before (structural coupling; test/helpers/fake-query.ts is the de-facto spec).
function* translate(msg: unknown, state: DecodeState): Generator<AgentEvent> {
  const type = (msg as { type?: string }).type;
  const parentId = (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null;
  if (type === "stream_event") {
    if (parentId) return; // nested partial tokens are never surfaced (nested shows only completed messages)
    const ev = (msg as { event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string }; message?: { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } } } }).event;
    if (ev?.type === "message_start") {
      const mu = ev.message?.usage ?? {};
      state.lastReqContextTokens = (mu.input_tokens ?? 0) + (mu.cache_read_input_tokens ?? 0) + (mu.cache_creation_input_tokens ?? 0);
    } else if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
      yield { kind: "text_delta", text: ev.delta.text };
    } else if (ev?.type === "content_block_delta" && ev.delta?.type === "thinking_delta" && typeof ev.delta.thinking === "string") {
      yield { kind: "thinking_delta", text: ev.delta.thinking };
    }
    return;
  }
  if (type === "assistant" || type === "user") {
    const text = extractText(msg);
    if (text !== "") yield { kind: "message", role: type, text, parentToolUseId: parentId };
    for (const tu of extractToolUses(msg)) yield { kind: "tool_use", id: tu.id, name: tu.name, input: tu.input, parentToolUseId: parentId };
    for (const tr of extractToolResults(msg)) yield { kind: "tool_result", toolUseId: tr.toolUseId, isError: tr.isError, content: tr.content, parentToolUseId: parentId };
    return;
  }
  // Nested system/tool_progress/result never touch the parent session (both consumers skipped these).
  if (parentId) return;
  if (type === "system") {
    // Emit the session id EARLY (init) — an interrupt before the first result must not orphan resume.
    const sysSessionId = (msg as { session_id?: string }).session_id;
    if (sysSessionId) yield { kind: "session_id", sessionId: sysSessionId };
    const push = classifySystemPush(msg);
    if (push) {
      yield { kind: "push", push };
      return;
    }
    // A system message carries info in its top-level text/subtype (extractText can't read it).
    const s = msg as { subtype?: string; text?: string };
    yield { kind: "system_text", text: s.text ?? s.subtype ?? "system" };
    return;
  }
  if (type === "tool_progress") {
    const tp = msg as { tool_use_id?: string; elapsed_time_seconds?: number };
    if (tp.tool_use_id) yield { kind: "tool_progress", toolUseId: tp.tool_use_id, elapsedSec: Math.round(tp.elapsed_time_seconds ?? 0) };
    return;
  }
  if (type === "result") {
    const r = msg as {
      subtype?: string;
      total_cost_usd?: number;
      num_turns?: number;
      session_id?: string;
      duration_ms?: number;
      usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
      modelUsage?: Record<string, { contextWindow?: number }>;
    };
    if (r.session_id) yield { kind: "session_id", sessionId: r.session_id };
    const { contextTokens, contextWindow } = turnContext(r, state.lastReqContextTokens);
    yield {
      kind: "turn_end",
      subtype: r.subtype ?? "unknown",
      costUsd: r.total_cost_usd ?? 0,
      numTurns: r.num_turns ?? 0,
      durationMs: r.duration_ms ?? 0,
      contextTokens,
      contextWindow,
    };
  }
}

class ClaudeStream implements AgentStream {
  constructor(private readonly q: ReturnType<QueryFn>) {}

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    const state: DecodeState = { lastReqContextTokens: 0 };
    for await (const msg of this.q) yield* translate(msg, state);
  }

  async interrupt(): Promise<void> {
    await this.q.interrupt();
  }

  // Optional live controls: fakes (and other providers) may lack them — mirror the old `this.query?.x` guards.
  async setModel(model: string): Promise<void> {
    await (this.q as { setModel?: (m: string) => Promise<void> }).setModel?.(model);
  }

  async setPermissionMode(mode: string): Promise<void> {
    await (this.q as { setPermissionMode?: (m: string) => Promise<void> }).setPermissionMode?.(mode);
  }

  async supportedCommands(): Promise<SlashCommandInfo[]> {
    const cmds = (await (this.q as { supportedCommands?: () => Promise<SlashCommandInfo[]> }).supportedCommands?.()) ?? [];
    return cmds.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint, aliases: c.aliases }));
  }
}

export class ClaudeBackend implements AgentBackend {
  constructor(private readonly queryFn: QueryFn) {}

  // Shared option assembly: effort gating (Haiku rejects effort — API 400), adaptive thinking display,
  // claude_code preset + append, token-level partial deltas, resume, abort.
  private baseOptions(opts: AgentSessionOptions): QueryOptions {
    return {
      cwd: opts.cwd,
      model: opts.model,
      ...(effortApplies(opts.model) && coerceEffort(opts.effort) ? { effort: coerceEffort(opts.effort) } : {}),
      ...(effortApplies(opts.model) ? { thinking: { type: "adaptive" as const, display: "summarized" as const } } : {}),
      permissionMode: opts.permissionMode as QueryOptions["permissionMode"],
      systemPrompt: { type: "preset", preset: "claude_code", ...(opts.systemPromptAppend ? { append: opts.systemPromptAppend } : {}) },
      includePartialMessages: true,
      ...(opts.resume ? { resume: opts.resume } : {}),
      abortController: opts.abortController,
    };
  }

  openSession(input: AsyncIterable<string>, opts: AgentSessionOptions): AgentStream {
    const q = this.queryFn({
      prompt: claudeUserMessages(input),
      options: {
        ...this.baseOptions(opts),
        forwardSubagentText: true, // nested subagent text/tool activity → UI panels (streaming sessions only, as before)
      },
    });
    return new ClaudeStream(q);
  }

  startTurn(prompt: string, opts: MasterTurnOptions): AgentStream {
    const q = this.queryFn({
      prompt,
      options: {
        ...this.baseOptions(opts),
        ...(opts.canUseTool ? { canUseTool: opts.canUseTool as QueryOptions["canUseTool"] } : {}),
        ...(opts.mcpServers ? { mcpServers: opts.mcpServers as QueryOptions["mcpServers"] } : {}),
        ...(opts.allowedTools ? { allowedTools: opts.allowedTools } : {}),
        ...(opts.disallowedTools ? { disallowedTools: opts.disallowedTools } : {}),
      },
    });
    return new ClaudeStream(q);
  }
}
```

If `SDKUserMessage` requires extra mandatory fields under the current SDK version, copy whatever `message-queue.ts` currently compiles with — the shape must stay identical to `message-queue.ts:14-18`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/core/claude-backend.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/claude-backend.ts test/core/claude-backend.test.ts
git commit -m "feat(core): ClaudeBackend adapter — SDK option assembly + AgentEvent translation" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `ClaudeBackend.openSession` streaming behavior + controls (TDD)

**Files:**
- Modify: `test/core/claude-backend.test.ts` (append suites)

`openSession` and the controls were implemented in Task 2; this task locks their behavior with tests before the Worker starts depending on them.

- [ ] **Step 1: Append these failing-or-passing tests** to `test/core/claude-backend.test.ts`:

```ts
import { MessageQueue } from "../../src/core/message-queue.js";
import { fakeStreamingQuery } from "../helpers/fake-query.js";
```

(NOTE: until Task 4 lands, `MessageQueue` still yields SDK shapes — so for THIS task drive `openSession` with a plain string generator, not MessageQueue. Do not import MessageQueue yet; the import above is added in Task 4 Step 6. Use the queue-free tests below.)

```ts
describe("ClaudeBackend.openSession", () => {
  it("wraps string input into SDKUserMessage and sets forwardSubagentText", async () => {
    let captured: { prompt?: unknown; options?: Record<string, unknown> } = {};
    const inner = fakeStreamingQuery((text) => [
      { type: "assistant", text: `echo:${text}` },
      { type: "result", subtype: "success", total_cost_usd: 0.1, num_turns: 1, session_id: "sdk-w" },
    ]);
    const fn = ((i: typeof captured) => { captured = i; return inner(i as Parameters<QueryFn>[0]); }) as unknown as QueryFn;
    const backend = new ClaudeBackend(fn);
    async function* input() { yield "task one"; }
    const events = await collect(backend.openSession(input(), baseOpts()));
    expect((captured.options as Record<string, unknown>).forwardSubagentText).toBe(true);
    expect(events).toEqual([
      { kind: "message", role: "assistant", text: "echo:task one", parentToolUseId: null },
      { kind: "session_id", sessionId: "sdk-w" },
      { kind: "turn_end", subtype: "success", costUsd: 0.1, numTurns: 1, durationMs: 0, contextTokens: 0, contextWindow: 0 },
    ]);
  });

  it("stays alive across turns and ends when the input closes (streaming lifecycle)", async () => {
    const backend = new ClaudeBackend(fakeStreamingQuery((text, turn) => [
      { type: "result", subtype: "success", total_cost_usd: 0, num_turns: turn + 1, session_id: "sdk-w" },
    ]));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    async function* input() { yield "t1"; await gate; yield "t2"; }
    const seen: AgentEvent[] = [];
    const done = (async () => { for await (const ev of backend.openSession(input(), baseOpts())) seen.push(ev); })();
    // first turn flows without closing the stream
    while (seen.filter((e) => e.kind === "turn_end").length < 1) await new Promise((r) => setTimeout(r, 1));
    release();
    await done; // generator ends only when input ends
    expect(seen.filter((e) => e.kind === "turn_end")).toHaveLength(2);
  });
});

describe("ClaudeStream controls", () => {
  it("delegates setModel/setPermissionMode/supportedCommands to the query object", async () => {
    const calls: string[] = [];
    const backend = new ClaudeBackend(fakeQuery(
      [{ type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "s" }],
      { commands: [{ name: "/c", description: "d", argumentHint: "h", aliases: ["/a"] }], onSetModel: (m) => calls.push(`model:${m}`), onSetPermissionMode: (m) => calls.push(`mode:${m}`) },
    ));
    const stream = backend.startTurn("hi", baseOpts());
    await stream.setModel("claude-sonnet-5");
    await stream.setPermissionMode("default");
    expect(await stream.supportedCommands()).toEqual([{ name: "/c", description: "d", argumentHint: "h", aliases: ["/a"] }]);
    expect(calls).toEqual(["model:claude-sonnet-5", "mode:default"]);
    await collect(stream);
  });

  it("resolves (does not throw) when the underlying session lacks a control", async () => {
    const backend = new ClaudeBackend(rawQuery([]));
    const stream = backend.startTurn("hi", baseOpts());
    await expect(stream.setModel("m")).resolves.toBeUndefined();
    await expect(stream.setPermissionMode("default")).resolves.toBeUndefined();
    await expect(stream.supportedCommands()).resolves.toEqual([]);
    await collect(stream);
  });
});
```

- [ ] **Step 2: Run and make green**

Run: `npx vitest run test/core/claude-backend.test.ts`
Expected: PASS (implementation already exists from Task 2; fix the adapter if any case fails — the tests are the spec, do not weaken them).

- [ ] **Step 3: Commit**

```bash
git add test/core/claude-backend.test.ts
git commit -m "test(core): lock ClaudeBackend openSession streaming + control delegation" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Rewire Worker onto the port (+ MessageQueue → strings, commands probe, fake helpers)

**Files:**
- Modify: `src/core/message-queue.ts` (yield strings), `src/core/worker.ts` (consume AgentStream; drop SDK/QueryFn), `src/core/commands.ts` (wrap probe queue; QueryFn import path), `test/helpers/fake-query.ts` (QueryFn path + `fakeBackend`/`fakeStreamingBackend`), `test/core/message-queue.test.ts`, `test/core/worker.test.ts`, `test/core/worker-lifecycle.test.ts`
- Modify (scope amendment, discovered during execution): `src/daemon/server.ts` — the `WorkerDeps.queryFn → backend` rename breaks `subFactory`'s direct `new Worker({deps:{queryFn}})` call, so the minimal composition-root fix moves INTO this task: add `import { ClaudeBackend }`, `const backend = new ClaudeBackend(queryFn);` after the queryFn line, and swap `queryFn,` → `backend,` in subFactory's Worker deps only. (Task 5 Step 4 shrinks accordingly: it no longer adds the import/backend/subFactory parts.)
- These move together because the `MessageQueue` element-type flip breaks worker.ts and commands.ts simultaneously.

**Interfaces:**
- Consumes: `AgentBackend.openSession(input, opts)`, `AgentStream` (Tasks 1-3).
- Produces: `WorkerDeps.backend: AgentBackend` (replaces `queryFn`); `worker.ts` re-exports `export type { QueryFn } from "./claude-backend.js";` (temporary back-compat, removed in Task 6); `fakeBackend(script, opts?)` / `fakeStreamingBackend(responder)` in fake-query.ts.

- [ ] **Step 1: Flip `src/core/message-queue.ts` to strings** — full new content:

```ts
type Waiter = (result: IteratorResult<string>) => void;

// Streaming-input queue: an open-ended stream of user input strings. Provider-agnostic — the adapter
// (claude-backend.ts claudeUserMessages) wraps each string into its provider's wire shape.
export class MessageQueue implements AsyncIterable<string> {
  private readonly buffer: string[] = [];
  private readonly waiters: Waiter[] = [];
  private closed = false;

  push(text: string): void {
    if (this.closed) throw new Error("MessageQueue is closed");
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: text, done: false });
    else this.buffer.push(text);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    let waiter: Waiter | undefined;
    while ((waiter = this.waiters.shift())) {
      // When done:true, value is ignored. Passed as an IteratorReturnResult shape without an assertion.
      waiter({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    while (true) {
      const buffered = this.buffer.shift();
      if (buffered !== undefined) {
        yield buffered;
        continue;
      }
      if (this.closed) return;
      const result = await new Promise<IteratorResult<string>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (result.done) return;
      yield result.value;
    }
  }
}
```

(Note the `!== undefined` guard replacing the old truthiness check — an empty-string push must not terminate the drain. Update `test/core/message-queue.test.ts` expectations from SDKUserMessage objects to plain strings; keep every lifecycle case.)

- [ ] **Step 2: Rewrite `src/core/worker.ts` against the port.** Replace the import block (lines 1-11) with:

```ts
import type { AgentBackend, AgentStream } from "./agent-backend.js";
import { MessageQueue } from "./message-queue.js";
import { ThinkingCoalescer } from "./thinking-coalescer.js";
import type { EventBus, WorkerEventData } from "./events.js";
import type { Repositories } from "../persistence/repositories.js";
import { truncateBytes } from "./truncate.js";
import type { SlashCommandInfo } from "./commands.js";

// Temporary back-compat re-export (removed in the final sweep): several modules still import QueryFn from here.
export type { QueryFn } from "./claude-backend.js";
```

In `WorkerDeps`, replace `queryFn: QueryFn;` with `backend: AgentBackend;`. Replace the field `private query?: ReturnType<QueryFn>;` with `private stream?: AgentStream;`. Then apply these method changes (each replaces `this.query` with `this.stream`, keeping the surrounding try/catch and comments):

- `setModel`: `await this.stream?.setModel(model);`
- `setPermissionMode`: `await this.stream?.setPermissionMode(mode);` (drop the `as PermissionMode` cast)
- `listCommands`: body becomes `return (await this.stream?.supportedCommands()) ?? [];` inside the existing try (the field mapping moved into the adapter)
- `stop` / `interruptTurn`: `await this.stream?.interrupt();`

Replace `consume()` in full with:

```ts
  private async consume(): Promise<void> {
    try {
      this.stream = this.opts.deps.backend.openSession(this.queue, {
        cwd: this.opts.repoPath,
        model: this.currentModel,
        effort: this.opts.deps.effort,
        permissionMode: this.currentPermissionMode,
        systemPromptAppend: WORKER_FENCE_INSTRUCTION,
        resume: this.sdkSessionId,
        abortController: this.abort,
      });
      for await (const ev of this.stream) {
        if (ev.kind === "text_delta") {
          this.emit({ kind: "message_delta", text: ev.text });
        } else if (ev.kind === "thinking_delta") {
          this.thinking.push(ev.text); // accumulate → persisted coalesced at message/tool/turn boundaries
          this.emit({ kind: "thinking_delta", text: ev.text });
        } else if (ev.kind === "message") {
          if (ev.parentToolUseId) {
            // native nested subagent → live-only emit (no persistence), grouped by parentToolUseId.
            if (ev.text.trim()) this.emitNested(ev.parentToolUseId, { kind: "message", role: ev.role, content: ev.text });
            continue;
          }
          this.flushThinking(); // persist this step's thinking summary before message/tool (order: thinking → message/tool)
          // user-role text is provider-injected content (skill body/context), not human input — real worker
          // instructions are recorded separately by start()/send(), so only assistant text is recorded here.
          if (ev.role === "assistant" && ev.text.trim()) this.record({ kind: "message", role: "assistant", content: ev.text });
        } else if (ev.kind === "tool_use") {
          if (ev.parentToolUseId) {
            this.emitNested(ev.parentToolUseId, { kind: "tool_use", id: ev.id, name: ev.name, input: truncate(safeJson(ev.input), 4000) });
            continue;
          }
          this.flushThinking();
          this.record({ kind: "tool_use", id: ev.id, name: ev.name, input: truncate(safeJson(ev.input), 4000) });
        } else if (ev.kind === "tool_result") {
          if (ev.parentToolUseId) {
            this.emitNested(ev.parentToolUseId, { kind: "tool_result", id: ev.toolUseId, isError: ev.isError, content: truncate(ev.content, 4000) });
            continue;
          }
          this.flushThinking();
          this.record({ kind: "tool_result", id: ev.toolUseId, isError: ev.isError, content: truncate(ev.content, 4000) });
        } else if (ev.kind === "session_id") {
          // Captured early (init) AND at turn end — an interrupt before the first turn end must not break resume.
          if (ev.sessionId !== this.sdkSessionId) {
            this.sdkSessionId = ev.sessionId;
            this.opts.deps.repos.setWorkerSdkSessionId(this.opts.id, ev.sessionId);
          }
        } else if (ev.kind === "push") {
          if (ev.push.kind === "commands") {
            this.opts.deps.bus.emit({ type: "commands.changed", sessionId: this.opts.sessionId, scopeId: this.opts.id, commands: ev.push.commands });
          } else {
            this.record({ kind: "notice", text: ev.push.text });
          }
        } else if (ev.kind === "system_text") {
          this.record({ kind: "system", text: ev.text });
        } else if (ev.kind === "tool_progress") {
          this.emit({ kind: "tool_progress", id: ev.toolUseId, elapsedSec: ev.elapsedSec }); // live only (no persistence)
        } else if (ev.kind === "turn_end") {
          this.flushThinking(); // persist the trailing thinking summary of a step that ended without an answer
          this.cumCostUsd += ev.costUsd;
          this.cumTurns += ev.numTurns;
          this.record({
            kind: "result",
            subtype: ev.subtype,
            costUsd: this.cumCostUsd,
            numTurns: this.cumTurns,
            durationMs: ev.durationMs,
            contextTokens: ev.contextTokens,
            contextWindow: ev.contextWindow,
          });
          // maxTurns cap: compare against ev.numTurns (the provider's conversation-cumulative agentic turn
          // count per send). Do NOT use cumTurns (double-counts across sends). null/undefined → unlimited.
          const cap = this.opts.deps.maxTurns;
          if (cap != null && ev.numTurns >= cap) {
            this.record({ kind: "notice", text: `Turn cap reached (maxTurns=${cap}, num_turns=${ev.numTurns}) — stopping worker.` });
            void this.stream?.interrupt(); // void: NOT await — would deadlock inside the consume loop
            this.queue.close();
            this.abort.abort();
            this.transition("stopped");
            this.deferred.splice(0); // clear deferred — cap notice already recorded; worker is terminating, no ghost turns
            return;
          }
          // turn boundary: if there's an instruction deferred while running, flush one in FIFO order now (after the previous turn's output) →
          // the user echo settles right before the next turn without wedging in. That turn runs shortly, so we don't drop to idle.
          const next = this.deferred.shift();
          if (next) {
            this.opts.deps.onTurnStart?.(); // the checkpoint must be taken right before the actual turn (= here) to stay aligned
            this.queue.push(next.text); // release the held instruction NOW (at the boundary) → it runs as its own turn, never coalesced into the just-finished one
            this.record({ kind: "message", role: "user", content: next.text }, next.clientMsgId);
          } else if (this.state === "running") {
            // nothing deferred → wait (idle). The streaming session is alive and can receive further instructions.
            this.transition("idle");
          }
        }
      }
      this.flushThinking(); // persist the trailing thinking summary before the loop terminates naturally
      // when the stream terminates naturally (generator ends), done. (real streaming ends only on stop, becoming stopped)
      if (this.state === "running" || this.state === "idle") this.transition("done");
    } catch (err) {
      // an abort caused by stop/discard is not an error — don't leave "Operation aborted" in the transcript.
      if (this.abort.signal.aborted) return;
      this.flushThinking(); // also persist the thinking summary up to right before the error (so it shows on restore)
      this.record({ kind: "error", message: String(err) });
      // A non-abort throw can arrive while the worker is running OR idle (turn ended, stream then dies). Both must go
      // terminal — otherwise an idle worker is left a zombie and a follow-up send wedges it.
      if (this.state === "running" || this.state === "idle") this.transition("error");
    }
  }
```

Everything else in worker.ts (deferred FIFO, record/persistOnly/emit/emitNested, transitions, start/resume/send/stop) is unchanged.

- [ ] **Step 3: Fix `src/core/commands.ts`** — the probe's queue is now strings; wrap it for the raw SDK call. Change the import line `import type { QueryFn } from "./worker.js";` to:

```ts
import type { QueryFn } from "./claude-backend.js";
import { claudeUserMessages } from "./claude-backend.js";
```

and in `probe()`, change `prompt: queue,` to `prompt: claudeUserMessages(queue),`. Nothing else changes (the probe stays a deliberate Claude-specific raw-QueryFn path — gated per provider in P1).

- [ ] **Step 4: Update `test/helpers/fake-query.ts`** — change line 1 to `import type { QueryFn } from "../../src/core/claude-backend.js";` and append:

```ts
import { ClaudeBackend } from "../../src/core/claude-backend.js";
import type { AgentBackend } from "../../src/core/agent-backend.js";

// Port-level fakes: the same scripts, driven through the real ClaudeBackend adapter — worker/master tests
// exercise consumer+adapter together (equivalent coverage to the old direct-queryFn injection).
export function fakeBackend(script: FakeStep[], opts?: Parameters<typeof fakeQuery>[1]): AgentBackend {
  return new ClaudeBackend(fakeQuery(script, opts));
}
export function fakeStreamingBackend(responder: (userText: string, turn: number) => FakeStep[]): AgentBackend {
  return new ClaudeBackend(fakeStreamingQuery(responder));
}
```

- [ ] **Step 5: Migrate `test/core/worker.test.ts` + `test/core/worker-lifecycle.test.ts`** with these mechanical patterns (apply to every construction site):
  - `deps: { ..., queryFn: fakeQuery(S) }` → `deps: { ..., backend: fakeBackend(S) }`
  - `deps: { ..., queryFn: fakeQuery(S, O) }` → `deps: { ..., backend: fakeBackend(S, O) }`
  - `deps: { ..., queryFn: fakeStreamingQuery(R) }` → `deps: { ..., backend: fakeStreamingBackend(R) }`
  - any hand-rolled `QueryFn` (capture/throwing wrappers): keep the wrapper, inject as `backend: new ClaudeBackend(wrappedFn)` (import `ClaudeBackend` from `../../src/core/claude-backend.js`)
  - `import type { QueryFn } from "../../src/core/worker.js"` continues to work (re-export) — leave as-is this task.

- [ ] **Step 6: Add the MessageQueue-driven openSession test** (deferred from Task 3) to `test/core/claude-backend.test.ts`: add `import { MessageQueue } from "../../src/core/message-queue.js";` and:

```ts
  it("drives openSession from a MessageQueue: push after start reaches the SDK as a user message", async () => {
    const texts: string[] = [];
    const backend = new ClaudeBackend(fakeStreamingQuery((text) => { texts.push(text); return [
      { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "s" },
    ]; }));
    const queue = new MessageQueue();
    const done = collect(backend.openSession(queue, baseOpts()));
    queue.push("hello worker");
    queue.close();
    await done;
    expect(texts).toEqual(["hello worker"]);
  });
```

- [ ] **Step 7: Run the affected suites, then everything**

Run: `npx vitest run test/core/message-queue.test.ts test/core/worker.test.ts test/core/worker-lifecycle.test.ts test/core/claude-backend.test.ts test/core/commands.test.ts`
Expected: PASS.
Run: `npm run typecheck && npm test`
Expected: PASS (master-agent & friends still compile via the worker.ts QueryFn re-export).

- [ ] **Step 8: Commit**

```bash
git add -A src/core test/core test/helpers
git commit -m "refactor(core): Worker consumes AgentBackend.openSession; MessageQueue yields strings" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Rewire MasterAgent + SessionManager + server.ts onto the port

**Files:**
- Modify: `src/core/master-agent.ts`, `src/core/session-manager.ts`, `src/daemon/server.ts`, `src/core/labeler.ts` (import path only)
- Test: `test/core/master-agent.test.ts`, `test/core/master-capabilities.test.ts`, `test/core/session-manager.test.ts`, `test/core/session-manager-capabilities.test.ts`, `test/daemon/connection.test.ts`, `test/slack/app.test.ts`, `test/slack/handle-incoming.test.ts` (+ any other `new SessionManager({... queryFn ...})` site tsc finds)

**Interfaces:**
- Consumes: `AgentBackend.startTurn(prompt, opts)`, `ProviderMcpServer`, `ProviderPermissionCallback`.
- Produces: `MasterAgentDeps.backend: AgentBackend` (replaces `queryFn`), `MasterAgentDeps.canUseTool?: ProviderPermissionCallback`, `TurnCapabilities.mcpServers?: Record<string, ProviderMcpServer>`, `SessionManagerDeps.backend: AgentBackend` (replaces `queryFn`), `SessionManagerDeps.makeCanUseTool?: (externalKey: string | null, sessionId: string) => ProviderPermissionCallback | undefined`. `startDaemon`'s `queryFn?: QueryFn` option is KEPT (tests depend on it) — server.ts wraps it.

- [ ] **Step 1: `src/core/master-agent.ts` imports/deps.** Replace lines 1-2 (`import type { CanUseTool, ... } from "@anthropic-ai/claude-agent-sdk"; import type { QueryFn } from "./worker.js";`) with:

```ts
import type { AgentBackend, ProviderMcpServer, ProviderPermissionCallback } from "./agent-backend.js";
```

Delete the now-unused imports: `extractText/extractToolUses/extractToolResults` (sdk-extract), `effortApplies/coerceEffort` (effort), `classifySystemPush` (system-push), `turnContext` (result-telemetry). In `MasterAgentDeps`: `queryFn: QueryFn;` → `backend: AgentBackend;` and `canUseTool?: CanUseTool;` → `canUseTool?: ProviderPermissionCallback;` (keep the comments). In `TurnCapabilities`: `mcpServers?: Record<string, McpSdkServerConfigWithInstance>;` → `mcpServers?: Record<string, ProviderMcpServer>;`.

- [ ] **Step 2: Rewrite the `doTurn` query construction + stream loop** (lines ~273-437). The pre-loop section keeps everything through `bus.emit/repos.setSessionStatus` and the user-echo block; changes:
  - destructure: `const { repos, bus, fleet } = this.opts.deps;` (queryFn gone)
  - `const permissionMode = override?.permissionMode?.trim() || "bypassPermissions";` (drop the `as PermissionMode` cast)
  - replace the `const q = queryFn({...})` call and the whole `for await (const msg of q)` loop with:

```ts
      const stream = this.opts.deps.backend.startTurn(userText, {
        cwd: this.opts.cwd,
        model,
        abortController: abort, // Abort signal — abort() from stop()
        effort,
        // A headless daemon has no TTY to approve permission prompts, so the master also auto-approves.
        // (Same as the worker. Security note: only in a trusted environment.)
        permissionMode, // Per-session choice (default bypassPermissions). With default etc., canUseTool is called per tool and the approval card activates.
        // Approval/question callback (when injected). bypass only falls through tools with an ask rule, so it's safe even if not injected/dormant.
        ...(this.opts.deps.canUseTool ? { canUseTool: this.opts.deps.canUseTool } : {}),
        // base system prompt + per-source fragment ("+"). The fragment is fixed within a session so it doesn't disturb the cache prefix.
        systemPromptAppend: this.buildSystemPrompt() + (caps.systemPromptAppend ? `\n\n${caps.systemPromptAppend}` : ""),
        resume: this.sdkSessionId,
        // base (memory/repos/fleet) + per-source additional servers ("+"). On key collision, caps wins.
        mcpServers: {
          memory: createMemoryToolsServer(repos),
          repos: createRepoToolsServer(repos),
          fleet: createFleetToolsServer(fleet, repos, sessionId),
          ...caps.mcpServers,
        },
        // base + per-source additions ("+"), then remove denyTools ("−").
        allowedTools: baseAllowed.filter((t) => !deny.has(t)),
        // Remove native harness schedule tools — headless no-ops that confuse with our schedule_* MCP tools.
        disallowedTools: NATIVE_SCHEDULE_TOOLS,
      });
      this.currentQuery = stream; // Handle to interrupt from stop()

      for await (const ev of stream) {
        if (ev.kind === "text_delta") {
          bus.emit({ type: "master.message.delta", sessionId, delta: ev.text });
        } else if (ev.kind === "thinking_delta") {
          this.thinking.push(ev.text); // Accumulate → persisted coalesced when the answer/tool starts
          bus.emit({ type: "master.thinking.delta", sessionId, delta: ev.text });
        } else if (ev.kind === "message") {
          // Nested Task traffic is not the master's own activity (live-only, per-worker concept — the master
          // has no nested panel); user-role text is provider-injected content, not the master's transcript.
          if (ev.parentToolUseId || ev.role !== "assistant") continue;
          this.flushThinking(); // Persist this step's thinking summary before the answer/tool (order: thinking → message/tool)
          repos.addMessage({ sessionId, role: "assistant", content: ev.text }); // messages table (last_activity)
          this.recordEvent({ type: "master.message", sessionId, role: "assistant", content: ev.text });
        } else if (ev.kind === "tool_use") {
          if (ev.parentToolUseId) continue;
          this.flushThinking();
          this.recordEvent({ type: "master.tool", sessionId, toolId: ev.id, name: prettyToolName(ev.name), phase: "start", input: toolInputText(ev.input) });
        } else if (ev.kind === "tool_result") {
          if (ev.parentToolUseId) continue;
          this.recordEvent({ type: "master.tool", sessionId, toolId: ev.toolUseId, name: "", phase: "end", ok: !ev.isError, result: truncate(ev.content, 2000) });
        } else if (ev.kind === "session_id") {
          // Captured early (init) AND at turn end — a Stop before the very first turn end must not lose context.
          if (ev.sessionId !== this.sdkSessionId) {
            this.sdkSessionId = ev.sessionId;
            repos.setSdkSessionId(sessionId, ev.sessionId);
          }
        } else if (ev.kind === "push") {
          if (ev.push.kind === "commands") {
            bus.emit({ type: "commands.changed", sessionId, scopeId: sessionId, commands: ev.push.commands });
          } else {
            this.recordEvent({ type: "master.notice", sessionId, text: ev.push.text, code: ev.push.code, params: ev.push.params });
          }
        } else if (ev.kind === "system_text") {
          bus.emit({ type: "master.system", sessionId, text: ev.text });
        } else if (ev.kind === "tool_progress") {
          bus.emit({ type: "master.tool", sessionId, toolId: ev.toolUseId, name: "", phase: "progress", elapsedSec: ev.elapsedSec });
        } else if (ev.kind === "turn_end") {
          // Carry cumulative cost/turns for the session (context tokens/window are the current turn's values).
          this.cumCostUsd += ev.costUsd;
          this.cumTurns += ev.numTurns;
          this.recordEvent({
            type: "master.result",
            sessionId,
            subtype: ev.subtype,
            costUsd: this.cumCostUsd,
            numTurns: this.cumTurns,
            durationMs: ev.durationMs,
            contextTokens: ev.contextTokens,
            contextWindow: ev.contextWindow,
          });
          // maxTurns: warning-only for master (no abort).
          const masterCap = override?.maxTurns;
          if (masterCap != null && ev.numTurns >= masterCap) {
            const params = { max: masterCap, turns: ev.numTurns };
            this.recordEvent({ type: "master.notice", sessionId, code: "notice.turnCap", params, text: t(DEFAULT_LOCALE, "notice.turnCap", params) });
          }
        }
      }
```

The `catch`/`finally` blocks are unchanged (`this.currentQuery = stream` already satisfies the `{ interrupt(): Promise<void> }` field type). Delete the now-dead `let lastReqContextTokens = 0;` and the old loop.

- [ ] **Step 3: `src/core/session-manager.ts`.** Replace `import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";` and `import type { QueryFn } from "./worker.js";` with `import type { AgentBackend, ProviderPermissionCallback } from "./agent-backend.js";`. In `SessionManagerDeps`: `queryFn: QueryFn;` → `backend: AgentBackend;` and `makeCanUseTool?: (...) => CanUseTool | undefined;` → `makeCanUseTool?: (externalKey: string | null, sessionId: string) => ProviderPermissionCallback | undefined;`. In `build()`: destructure `backend` instead of `queryFn` and pass `deps: { repos, bus, backend, model, effort, name, fleet, summarizeLabel, canUseTool, capabilities }`. `ForkFn` stays exactly as-is (it is already provider-neutral; per-provider fork routing is a P1 concern).

- [ ] **Step 4: `src/daemon/server.ts`.** (Amended: the `ClaudeBackend` import, the `const backend = new ClaudeBackend(queryFn);` line, and the subFactory `queryFn,`→`backend,` swap landed in Task 4.) Remaining here: change `import type { QueryFn } from "../core/worker.js";` → `import type { QueryFn } from "../core/claude-backend.js";` and, in the `new SessionManager({...})` call, replace `queryFn,` with `backend,`. `CommandCatalog(queryFn, ...)` and `makeLabeler(queryFn)` are unchanged.

- [ ] **Step 5: `src/core/labeler.ts`** — change `import type { QueryFn } from "./worker.js";` → `from "./claude-backend.js"` (behavior unchanged; it is a deliberate raw-QueryFn aux path).

- [ ] **Step 6: Migrate the master/session/daemon/slack tests.** Run `npm run typecheck` — every error is one of these mechanical patterns:
  - `new SessionManager({ repos, bus, queryFn: fakeQuery(S), ... })` → `new SessionManager({ repos, bus, backend: fakeBackend(S), ... })` (import `fakeBackend` from `../helpers/fake-query.js`)
  - `MasterAgent` deps helpers: in `test/core/master-agent.test.ts`, the `deps(queryFn)` helper adds `backend`:

```ts
function deps(queryFn: ReturnType<typeof fakeQuery>) {
  const repos = new Repositories(openDb(":memory:"));
  repos.createSession({ id: "s1", cwd: "/x" });
  const bus = new EventBus();
  const factory = (): WorkerLike => ({ start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
  const fleet = new FleetOrchestrator({ repos, bus, git: new FakeGitOps(), factory, worktreesDir: "/wt" });
  return { repos, bus, fleet, queryFn, backend: new ClaudeBackend(queryFn), model: () => "m", effort: () => "high", name: () => "rookery" };
}
```

  and `capture()` rebuilds the backend over the wrapped fn:

```ts
function capture(d: ReturnType<typeof deps>): { d: ReturnType<typeof deps>; opts: () => { model?: string; effort?: string } } {
  let captured: { model?: string; effort?: string } = {};
  const wrapped = ((input: { options?: typeof captured }) => {
    captured = input.options ?? {};
    return d.queryFn(input as Parameters<typeof d.queryFn>[0]);
  }) as typeof d.queryFn;
  return { d: { ...d, queryFn: wrapped, backend: new ClaudeBackend(wrapped) }, opts: () => captured };
}
```

  Same shape in `makeMaster` (wrap the prompt hook, then `backend: new ClaudeBackend(wrapped)`). The extra `queryFn` key on the deps object is harmless (variable spread — no excess-property check). `test/core/master-capabilities.test.ts` gets the same `backend: new ClaudeBackend(queryFn)` addition. `startDaemon({ queryFn: ... })` call sites need **no change**.

- [ ] **Step 7: Run everything**

Run: `npm run typecheck && npm test`
Expected: PASS. Pay attention to `master-agent.test.ts` capture assertions (systemPrompt/effort/mcpServers keys) — they now assert the ADAPTER's option assembly and must pass unmodified except the construction plumbing. If an assertion fails, the adapter diverged from the old inline options — fix `claude-backend.ts`, not the test.

- [ ] **Step 8: Commit**

```bash
git add -A src test
git commit -m "refactor(core): MasterAgent/SessionManager consume AgentBackend.startTurn; server wires ClaudeBackend" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Final sweep — neutrality gate, QueryFn re-export removal, docs

**Files:**
- Create: `test/core/provider-neutral.test.ts`
- Modify: `src/core/worker.ts` (drop the temporary QueryFn re-export), `test/core/worker.test.ts` / any file importing QueryFn from worker.js (flip to claude-backend.js), `CLAUDE.md`, `docs/2026-07-05-codex-backend-parity.md`

- [ ] **Step 1: Write the neutrality gate test** — `test/core/provider-neutral.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import fs from "node:fs";

// P0 seam guard: these core modules must stay free of direct Claude SDK imports — provider knowledge
// lives only in claude-backend.ts (adapter), interaction-registry/slack (P2 scope), and src/tools (P2 scope).
const NEUTRAL_FILES = [
  "src/core/worker.ts",
  "src/core/master-agent.ts",
  "src/core/session-manager.ts",
  "src/core/message-queue.ts",
  "src/core/agent-backend.ts",
  "src/core/fleet-orchestrator.ts",
  "src/core/events.ts",
];

describe("provider-neutral core (P0 seam)", () => {
  for (const f of NEUTRAL_FILES) {
    it(`${f} has no direct @anthropic-ai/claude-agent-sdk import`, () => {
      expect(fs.readFileSync(f, "utf8")).not.toMatch(/@anthropic-ai\/claude-agent-sdk/);
    });
  }
});
```

- [ ] **Step 2: Run it — expect ONE failure** (`worker.ts` is clean of the SDK string already, so if all pass, continue; the re-export still points at claude-backend which is allowed — the gate checks the SDK string only). Then remove the temporary re-export from `src/core/worker.ts` (`export type { QueryFn } from "./claude-backend.js";`) and flip every remaining `import ... QueryFn ... from ".../worker.js"` (tsc will list them — expected: `test/core/worker.test.ts`, possibly others) to `.../claude-backend.js`.

Run: `npm run typecheck && npm test`
Expected: PASS, including the new gate.

- [ ] **Step 3: Update CLAUDE.md** (2 surgical edits):
  - In *"Transport-agnostic core + a single composition root"*, change `**QueryFn** (SDK `query()`)` in the ports list to: `**AgentBackend** (provider-neutral agent port; `ClaudeBackend` adapts the SDK `query()` — the raw `QueryFn` remains only for Claude-specific aux paths: labeler, command probe)`.
  - In *"Testing"*, extend the fake-query bullet: `fakeBackend/fakeStreamingBackend` (fake-query driven through the real `ClaudeBackend`) is how Worker/Master tests inject the port; raw `fakeQuery` remains for adapter/aux tests.

- [ ] **Step 4: Mark P0 done in the parity doc** — add under the header of `docs/2026-07-05-codex-backend-parity.md`:

```markdown
> Status 2026-07-05+: **P0 (seam extraction) implemented** — `src/core/agent-backend.ts` (port) + `src/core/claude-backend.ts` (adapter); Worker/MasterAgent/SessionManager are SDK-import-free (guarded by `test/core/provider-neutral.test.ts`). P1 (Codex worker backend) not started.
```

- [ ] **Step 5: Full verification + commit**

Run: `npm run typecheck && npm test && npm run build`
Expected: all pass.

```bash
git add -A
git commit -m "chore(core): provider-neutrality gate test; drop QueryFn re-export; docs for P0 seam" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Notes (already applied)

- **Spec coverage:** port types (T1), adapter with option assembly + decode (T2/T3), worker rewire + MessageQueue neutralization (T4), master/session/server rewire (T5), regression gate + docs (T6). ForkFn intentionally NOT folded into the backend (already provider-neutral; per-provider fork routing is P1).
- **Type consistency:** `AgentEvent.tool_use.id` ↔ consumer `WorkerEventData.tool_use.id`; `AgentEvent.tool_result.toolUseId` maps to consumer field `id`; `tool_progress.toolUseId` → consumer `id`. `MasterTurnOptions` extends `AgentSessionOptions`. `WorkerDeps.backend` / `MasterAgentDeps.backend` / `SessionManagerDeps.backend` all `AgentBackend`.
- **Sequencing safety:** every task compiles standalone — T4 keeps a QueryFn re-export in worker.ts so master-agent/labeler/commands/fake-query stay green until T5/T6.
- **Do not** modify `src/core/interaction-registry.ts`, `src/slack/interaction.ts`, `src/tools/*` (SDK-typed by design until P2), `src/persistence/*`, `src/protocol/messages.ts`, or anything under `apps/desktop`.
