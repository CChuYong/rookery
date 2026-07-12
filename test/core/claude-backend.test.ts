import { describe, it, expect } from "vitest";
import { ClaudeBackend, claudeUserMessages } from "../../src/core/claude-backend.js";
import type { QueryFn } from "../../src/core/claude-backend.js";
import type { AgentEvent, AgentStream } from "../../src/core/agent-backend.js";
import type { ProviderToolDef } from "../../src/core/agent-backend.js";
import { fakeQuery, fakeStreamingQuery } from "../helpers/fake-query.js";
import { MessageQueue } from "../../src/core/message-queue.js";

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
  it("enforces the Side read-only boundary with plan mode and only read/search tools exposed", async () => {
    let captured: Record<string, unknown> | undefined;
    const q = fakeQuery([]);
    const backend = new ClaudeBackend(((input: Parameters<QueryFn>[0]) => {
      captured = input.options as unknown as Record<string, unknown>;
      return q(input);
    }) as QueryFn);
    await collect(backend.startTurn("why", baseOpts({ permissionMode: "plan", readOnly: true })));
    expect(captured?.permissionMode).toBe("plan");
    expect(captured?.allowedTools).toEqual(["Read", "Glob", "Grep"]);
    expect(captured?.disallowedTools).toEqual(expect.arrayContaining(["Bash", "Edit", "Write", "Task"]));
  });

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

  it("emits non-nested text deltas", async () => {
    const backend = new ClaudeBackend(rawQuery([
      { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "tok" } } },
      { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "s" },
    ]));
    const events = await collect(backend.startTurn("hi", baseOpts()));
    expect(events[0]).toEqual({ kind: "text_delta", text: "tok" });
  });

  it("emits tool_progress with rounded elapsed seconds", async () => {
    const backend = new ClaudeBackend(rawQuery([
      { type: "tool_progress", tool_use_id: "t9", elapsed_time_seconds: 3.6 },
      { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "s" },
    ]));
    const events = await collect(backend.startTurn("hi", baseOpts()));
    expect(events[0]).toEqual({ kind: "tool_progress", toolUseId: "t9", elapsedSec: 4 });
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

  it("wraps toolDefs groups into mcpServers.<group>; an opaque mcpServers overlay wins over a defs-wrapped group on collision", async () => {
    const cap = capture(RESULT);
    const backend = new ClaudeBackend(cap.fn);
    const stubDef = (name: string): ProviderToolDef => ({
      name,
      description: "d",
      inputSchema: {},
      handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });
    const sentinelFleet = { type: "sdk", name: "fleet", instance: {} } as unknown;
    await collect(backend.startTurn("hi", {
      ...baseOpts(),
      // askUserQuestion included alongside the base groups — must be dropped (Claude keeps its NATIVE
      // AskUserQuestion tool + canUseTool; a duplicate MCP tool of the same name would confuse the model).
      toolDefs: { memory: [stubDef("remember")], repos: [stubDef("list_repos")], fleet: [stubDef("spawn_worker")], askUserQuestion: [stubDef("AskUserQuestion")] },
      mcpServers: { fleet: sentinelFleet },
    }));
    const o = cap.input().options!;
    const servers = o.mcpServers as Record<string, { type?: string; name?: string }>;
    expect(Object.keys(servers).sort()).toEqual(["fleet", "memory", "repos"]); // no "askUserQuestion" key
    expect(servers.memory).toMatchObject({ type: "sdk", name: "memory" });
    expect(servers.repos).toMatchObject({ type: "sdk", name: "repos" });
    // The opaque overlay for "fleet" wins over the defs-wrapped "fleet" server (per-source overlays win on collision).
    expect(servers.fleet).toBe(sentinelFleet);
  });

  it("without toolDefs, an opaque mcpServers overlay passes through untouched (same identity, no wrapping)", async () => {
    const cap = capture(RESULT);
    const backend = new ClaudeBackend(cap.fn);
    const mcp = { fleet: { marker: true } };
    await collect(backend.startTurn("hi", { ...baseOpts(), mcpServers: mcp }));
    const o = cap.input().options!;
    expect(o.mcpServers).toBe(mcp);
  });

  // PICKUP from Task 2 review (M1): wrapped base servers must advertise version "0.0.1" (parity with the
  // pre-refactor inline createMemoryToolsServer()/createSdkMcpServer() calls, which always passed version).
  // The wrapped McpSdkServerConfigWithInstance only exposes {type, name, instance} publicly — the version
  // is not on the config object itself, but IS observable at runtime on the live McpServer instance's
  // underlying protocol Server (its serverInfo), so we read it there rather than relying on the code change alone.
  it("wrapped toolDefs servers advertise version \"0.0.1\" on the underlying McpServer instance", async () => {
    const cap = capture(RESULT);
    const backend = new ClaudeBackend(cap.fn);
    const stubDef = (name: string): ProviderToolDef => ({
      name,
      description: "d",
      inputSchema: {},
      handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });
    await collect(backend.startTurn("hi", { ...baseOpts(), toolDefs: { memory: [stubDef("remember")] } }));
    const o = cap.input().options!;
    const servers = o.mcpServers as Record<string, { instance?: { server?: { _serverInfo?: { version?: string } } } }>;
    expect(servers.memory?.instance?.server?._serverInfo?.version).toBe("0.0.1");
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

// ── Background-task lifecycle frames + terminal_reason (2026-07-11 state-graph redesign) ──
describe("ClaudeBackend — background_task translation", () => {
  it("maps task_started/task_notification to background_task events and drops progress/non-terminal updates", async () => {
    const backend = new ClaudeBackend(fakeQuery([
      { type: "task_started", id: "bg1", taskType: "local_bash" },
      { type: "task_progress", id: "bg1" }, // heartbeat noise — must NOT become a system_text transcript row
      { type: "task_updated", id: "bg1", status: "running" }, // non-terminal patch — ignored
      { type: "task_updated", id: "bg1", status: "completed" }, // terminal patch — settled
      { type: "task_notification", id: "bg1", status: "completed" }, // settle double-fire (consumer dedupes)
      { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "s" },
    ]));
    const events = await collect(backend.startTurn("hi", baseOpts()));
    const bg = events.filter((e) => e.kind === "background_task");
    expect(bg).toEqual([
      { kind: "background_task", taskId: "bg1", taskType: "local_bash", status: "started" },
      { kind: "background_task", taskId: "bg1", status: "settled" },
      { kind: "background_task", taskId: "bg1", status: "settled" },
    ]);
    // no task frame leaked into system_text (previously task_* polluted transcripts as unclassified system rows)
    expect(events.some((e) => e.kind === "system_text" && /task_/.test(e.text))).toBe(false);
  });

  it("carries result.terminal_reason on turn_end as an opaque diagnostic (absent when the SDK omits it)", async () => {
    const backend = new ClaudeBackend(fakeQuery([
      { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "s", terminal_reason: "completed" },
    ]));
    const events = await collect(backend.startTurn("hi", baseOpts()));
    const end = events.find((e) => e.kind === "turn_end")!;
    expect(end).toMatchObject({ kind: "turn_end", terminalReason: "completed" });

    const noReason = new ClaudeBackend(fakeQuery([
      { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "s" },
    ]));
    const events2 = await collect(noReason.startTurn("hi", baseOpts()));
    expect("terminalReason" in (events2.find((e) => e.kind === "turn_end") as object)).toBe(false);
  });
});
