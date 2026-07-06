import { describe, it, expect, vi } from "vitest";
import { CodexBackend, formatDuration } from "../../../src/core/codex/codex-backend.js";
import { fakeCodexSpawn, type CodexStep } from "../../helpers/fake-codex.js";
import type { AgentEvent, AgentStream, ProviderToolDef } from "../../../src/core/agent-backend.js";
import { MessageQueue } from "../../../src/core/message-queue.js";
import { openDb } from "../../../src/persistence/db.js";
import { Repositories } from "../../../src/persistence/repositories.js";
import { scheduleToolDefs } from "../../../src/tools/schedule-tools.js";

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
    // costUsd is no longer a placeholder 0 now that RATES is filled: the fake mirrors `last` into
    // `total` when a step omits it, so this fresh session's single update bills its full delta from
    // the zero baseline — (900-100)*5.00/1M + 100*0.50/1M + 0*30.00/1M = 0.00405.
    expect(events.at(-1)).toEqual({ kind: "turn_end", subtype: "success", costUsd: 0.00405, numTurns: 1, durationMs: 42, contextTokens: 1000, contextWindow: 272000 });
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

});

describe("CodexBackend.startTurn", () => {
  // P2 REPLACES the P1 stub (which always threw "not supported yet") with the real per-turn
  // ephemeral-child implementation below — see docs/2026-07-06-p2-codex-master.md. The old stub
  // test asserted exactly the behavior this task removes, so it is replaced wholesale rather than
  // kept alongside (it would otherwise assert bypassPermissions no longer throws — a contradiction).

  function fakeToolDef(name: string): ProviderToolDef {
    return { name, description: name, inputSchema: {}, handler: async () => ({ content: [{ type: "text", text: "" }] }) };
  }

  function stubBridge() {
    const calls: Array<{ key: string; defs: () => ProviderToolDef[] }> = [];
    const bridge = {
      ensureSession(key: string, defs: () => ProviderToolDef[]): { codexHome: string } {
        calls.push({ key, defs });
        return { codexHome: "/tmp/codex-homes/sess-1" };
      },
    };
    return { bridge, calls };
  }

  it("fresh turn: thread/start carries cwd/model/approvalPolicy/sandbox + developerInstructions; spawns with CODEX_HOME env (NOT argv); events translate; stream ends after ONE turn", async () => {
    const fake = fakeCodexSpawn(() => [
      { kind: "agentMessage", text: "hi" },
      { kind: "command", id: "c1", command: "ls" },
      { kind: "turnEnd", durationMs: 10 },
    ]);
    const { bridge, calls } = stubBridge();
    const b = new CodexBackend({ spawn: fake.spawn, defaultModel: () => "gpt-5.5", bridge });
    const opts = baseOpts({
      sessionKey: "sess-1",
      toolDefs: { memory: [fakeToolDef("remember")], repos: [fakeToolDef("list_repos")] },
      systemPromptAppend: "SYS-PROMPT-1",
    });
    const stream = b.startTurn("do the task", opts as never);
    const events = await collect(stream);

    const start = fake.requests.find((r) => r.method === "thread/start")!.params;
    expect(start).toMatchObject({ cwd: "/wt", model: "gpt-5.5", approvalPolicy: "never", sandbox: "danger-full-access", developerInstructions: "SYS-PROMPT-1" });
    // Token out of argv (P2.5 Track A): the bridge-materialized CODEX_HOME travels as env, and no -c/args are ever passed.
    expect(fake.spawns[0]!.env).toMatchObject({ CODEX_HOME: "/tmp/codex-homes/sess-1" });
    expect(fake.spawns[0]!.args).toBeUndefined();

    expect(events[0]).toEqual({ kind: "session_id", sessionId: "th-1" });
    expect(events).toContainEqual({ kind: "message", role: "assistant", text: "hi", parentToolUseId: null });
    expect(events).toContainEqual({ kind: "tool_use", id: "c1", name: "shell", input: { command: "ls", cwd: undefined }, parentToolUseId: null });
    expect(events.at(-1)).toMatchObject({ kind: "turn_end", subtype: "success", durationMs: 10 });

    // Single-shot: exactly one turn/start ever sent — the stream ends itself, no queue involved.
    expect(fake.requests.filter((r) => r.method === "turn/start")).toHaveLength(1);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.key).toBe("sess-1");
    expect(calls[0]!.defs().map((d) => d.name).sort()).toEqual(["list_repos", "remember"]);
  });

  // P2.5 Track A reconciliation (item 4): a codex master turn's per-session CODEX_HOME (from the
  // bridge) must win over the P1.5 shared codexApiKey CODEX_HOME — otherwise the bridge-materialized
  // config.toml/auth.json the daemon just wrote would never be the dir the child actually reads.
  it("the bridge's per-session CODEX_HOME overrides deps.env's shared CODEX_HOME for a master turn", async () => {
    const fake = fakeCodexSpawn(() => [{ kind: "turnEnd" }]);
    const { bridge } = stubBridge();
    const b = new CodexBackend({
      spawn: fake.spawn,
      defaultModel: () => "gpt-5.5",
      bridge,
      env: () => ({ CODEX_HOME: "/shared/codex-home", OTHER_VAR: "kept" }),
    });
    const opts = baseOpts({ sessionKey: "sess-1", toolDefs: { memory: [fakeToolDef("remember")] } });
    await collect(b.startTurn("hi", opts as never));
    // The per-session dir wins for CODEX_HOME, but other base env entries survive the merge.
    expect(fake.spawns[0]!.env).toMatchObject({ CODEX_HOME: "/tmp/codex-homes/sess-1", OTHER_VAR: "kept" });
  });

  // Task 1 (final-review fix wave): schedule tools now reach codex masters too — server.ts's
  // makeCapabilities puts them on the caps.toolDefs channel (master-agent.ts merges it into the
  // same RAW toolDefs record the base groups travel on), and this backend flattens the WHOLE
  // toolDefs record onto the bridge (see startTurn below) — so the real scheduleToolDefs names must
  // show up here, not just fakes.
  it("real scheduleToolDefs names reach the bridge's flattened defs alongside base groups", async () => {
    const fake = fakeCodexSpawn(() => [{ kind: "turnEnd" }]);
    const { bridge, calls } = stubBridge();
    const b = new CodexBackend({ spawn: fake.spawn, defaultModel: () => "gpt-5.5", bridge });
    const repos = new Repositories(openDb(":memory:"));
    const schedule = scheduleToolDefs({ repos, reconcile: () => {}, now: () => new Date() }, "sess-3");
    const opts = baseOpts({
      sessionKey: "sess-3",
      toolDefs: { memory: [fakeToolDef("remember")], schedule },
    });
    await collect(b.startTurn("hi", opts as never));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.defs().map((d) => d.name).sort()).toEqual(["remember", "schedule_cancel", "schedule_list", "schedule_wakeup"]);
  });

  it("resume turn: thread/resume with threadId + UPDATED developerInstructions; session_id emitted early", async () => {
    const fake = fakeCodexSpawn(() => [{ kind: "turnEnd" }]);
    const b = new CodexBackend({ spawn: fake.spawn, defaultModel: () => "gpt-5.5" });
    const opts = baseOpts({ resume: "th-1", systemPromptAppend: "SYS-PROMPT-2 (turn 2)" });
    const events = await collect(b.startTurn("continue please", opts as never));

    const resume = fake.requests.find((r) => r.method === "thread/resume")!.params;
    expect(resume).toMatchObject({ threadId: "th-1", developerInstructions: "SYS-PROMPT-2 (turn 2)" });
    expect(fake.requests.some((r) => r.method === "thread/start")).toBe(false);
    expect(events[0]).toEqual({ kind: "session_id", sessionId: "th-1" });
  });

  it("non-bypass permissionMode throws SYNCHRONOUSLY, before any child is spawned", () => {
    const fake = fakeCodexSpawn(() => []);
    const b = new CodexBackend({ spawn: fake.spawn, defaultModel: () => "gpt-5.5" });
    expect(() => b.startTurn("hi", baseOpts({ permissionMode: "default" }) as never)).toThrow(/bypassPermissions/);
    expect(fake.spawns).toHaveLength(0);
  });

  it("no bridge deps → no CODEX_HOME override / no args; a tool-less master turn still completes", async () => {
    const fake = fakeCodexSpawn(() => [{ kind: "turnEnd" }]);
    const b = new CodexBackend({ spawn: fake.spawn, defaultModel: () => "gpt-5.5" }); // no bridge, no toolDefs/sessionKey
    const events = await collect(b.startTurn("hi", baseOpts() as never));
    expect(fake.spawns[0]!.args).toBeUndefined();
    expect(fake.spawns[0]!.env).toBeUndefined(); // no deps.env either — nothing to add
    expect(events.at(-1)).toMatchObject({ kind: "turn_end", subtype: "success" });
  });

  it("ensureSession is skipped when toolDefs/sessionKey are present but the bridge dep is not", async () => {
    const fake = fakeCodexSpawn(() => [{ kind: "turnEnd" }]);
    const b = new CodexBackend({ spawn: fake.spawn, defaultModel: () => "gpt-5.5" }); // deps.bridge absent
    const opts = baseOpts({ sessionKey: "sess-2", toolDefs: { memory: [fakeToolDef("remember")] } });
    await collect(b.startTurn("hi", opts as never));
    expect(fake.spawns[0]!.args).toBeUndefined();
    expect(fake.spawns[0]!.env).toBeUndefined();
  });

  it("interrupt mid-turn: turn/interrupt sent with the active turn id, turn_end subtype interrupted, stream ends", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fake = fakeCodexSpawn(() => [{ kind: "agentDelta", text: "working…" }]); // turn never self-ends
    const b = new CodexBackend({ spawn: fake.spawn, defaultModel: () => "gpt-5.5" });
    const stream = b.startTurn("long task", baseOpts() as never);
    const seen: AgentEvent[] = [];
    const done = (async () => { for await (const ev of stream) { seen.push(ev); if (ev.kind === "text_delta") release(); } })();
    await gate;
    await stream.interrupt();
    await done;
    const intr = fake.requests.find((r) => r.method === "turn/interrupt");
    expect(intr?.params).toEqual({ threadId: "th-1", turnId: "turn-0" });
    expect(seen.at(-1)).toMatchObject({ kind: "turn_end", subtype: "interrupted" });
  });
});

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
    // Always-explicit policy: turn 1 carries the SPAWN mode's policy (bypassPermissions →
    // dangerFullAccess), turn 2 carries the override's (plan → readOnly).
    expect(turnStarts[0]!.params).toMatchObject({ approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });
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

  it("a stale turn/completed (id ≠ active turn id) is dropped: exactly one turn_end, numTurns:1", async () => {
    const { backend: b } = backend(() => [{ kind: "staleTurnEnd" }, { kind: "turnEnd" }]);
    const q = new MessageQueue(); q.push("x"); q.close();
    const events = await collect(b.openSession(q, baseOpts()));
    const turnEnds = events.filter((e) => e.kind === "turn_end");
    expect(turnEnds).toHaveLength(1);
    expect(turnEnds[0]).toMatchObject({ numTurns: 1 });
  });

  it("abort while pump is parked on the open (unclosed) input queue ends without throwing or hanging", async () => {
    const abortController = new AbortController();
    const { backend: b } = backend(() => [{ kind: "turnEnd" }]);
    const q = new MessageQueue(); q.push("t1"); // queue stays OPEN — never closed
    const stream = b.openSession(q, baseOpts({ abortController }));
    const seen: AgentEvent[] = [];
    const done = (async () => {
      for await (const ev of stream) {
        seen.push(ev);
        if (ev.kind === "turn_end") abortController.abort();
      }
    })();
    await expect(done).resolves.toBeUndefined();
    expect(seen.some((e) => e.kind === "turn_end")).toBe(true);
  });
});

describe("CodexBackend — pricing aggregation", () => {
  it("sums per-update TOTAL deltas across a multi-call turn (fresh session baseline = zeros)", async () => {
    const { backend: b } = backend(() => [
      { kind: "tokenUsage", last: { inputTokens: 800, cachedInputTokens: 200 }, total: { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 50 } },
      { kind: "tokenUsage", last: { inputTokens: 900, cachedInputTokens: 700 }, total: { inputTokens: 2600, cachedInputTokens: 900, outputTokens: 150 } },
      { kind: "turnEnd" },
    ]);
    const q = new MessageQueue(); q.push("x"); q.close();
    const events = await collect(b.openSession(q, baseOpts({ model: "gpt-5.5" })));
    const end = events.find((e) => e.kind === "turn_end") as { costUsd: number };
    // turn delta vs zeros: input 2600 (cached 900), output 150
    // cost = (2600-900)*5.00/1M + 900*0.50/1M + 150*30.00/1M = 0.0085 + 0.00045 + 0.0045
    expect(end.costUsd).toBeCloseTo(0.01345, 10);
  });

  it("resume: first tokenUsage update only sets the baseline (thread history not billed)", async () => {
    const { backend: b } = backend(() => [
      { kind: "tokenUsage", last: { inputTokens: 100 }, total: { inputTokens: 50_000, cachedInputTokens: 10_000, outputTokens: 9_000 } }, // history-inclusive
      { kind: "tokenUsage", last: { inputTokens: 100 }, total: { inputTokens: 51_000, cachedInputTokens: 10_500, outputTokens: 9_100 } },
      { kind: "turnEnd" },
    ]);
    const q = new MessageQueue(); q.push("x"); q.close();
    const events = await collect(b.openSession(q, baseOpts({ model: "gpt-5.5", resume: "th-1" })));
    const end = events.find((e) => e.kind === "turn_end") as { costUsd: number };
    // only the second update's delta bills: input 1000 (cached 500), output 100
    // cost = 500*5.00/1M + 500*0.50/1M + 100*30.00/1M = 0.0025 + 0.00025 + 0.003
    expect(end.costUsd).toBeCloseTo(0.00575, 10);
  });

  it("accumulator resets per turn and clamps negative deltas to 0", async () => {
    const { backend: b } = backend((_t, turn) => turn === 0
      ? [{ kind: "tokenUsage", last: { inputTokens: 1 }, total: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100 } }, { kind: "turnEnd" }]
      : [{ kind: "tokenUsage", last: { inputTokens: 1 }, total: { inputTokens: 500, cachedInputTokens: 0, outputTokens: 50 } }, { kind: "turnEnd" }]); // total went BACKWARD (compaction/reset) — clamp
    const q = new MessageQueue(); q.push("a"); q.push("b"); q.close();
    const events = await collect(b.openSession(q, baseOpts({ model: "gpt-5.5" })));
    const ends = events.filter((e) => e.kind === "turn_end") as Array<{ costUsd: number }>;
    expect(ends[0]!.costUsd).toBeCloseTo(1000 * 5 / 1e6 + 100 * 30 / 1e6, 10);
    expect(ends[1]!.costUsd).toBe(0); // clamped, not negative
  });

  it("billedModel snapshots per thread: a mid-turn setModel prices the NEXT turn only, not the in-flight one", async () => {
    const { backend: b } = backend((_t, turn) => turn === 0
      ? [{ kind: "tokenUsage", last: { inputTokens: 1 }, total: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 0 } }, { kind: "turnEnd" }]
      : [{ kind: "tokenUsage", last: { inputTokens: 1 }, total: { inputTokens: 2000, cachedInputTokens: 0, outputTokens: 0 } }, { kind: "turnEnd" }]);
    const q = new MessageQueue(); q.push("t1");
    const stream = b.openSession(q, baseOpts({ model: "gpt-5.5" }));
    const seen: AgentEvent[] = [];
    const done = (async () => {
      for await (const ev of stream) {
        seen.push(ev);
        if (ev.kind === "turn_end" && (ev as { numTurns: number }).numTurns === 1) {
          await stream.setModel("gpt-5.4-mini");
          q.push("t2"); q.close();
        }
      }
    })();
    await done;
    const ends = seen.filter((e) => e.kind === "turn_end") as Array<{ costUsd: number }>;
    expect(ends).toHaveLength(2);
    // turn 1's delta (1000 input tokens vs the zero baseline) is billed at gpt-5.5's input rate —
    // the setModel call happens AFTER turn 1 settles, so it cannot reprice a turn already billed.
    expect(ends[0]!.costUsd).toBeCloseTo(1000 * 5.0 / 1e6, 10);
    // turn 2's delta (2000-1000=1000 input tokens) is billed at gpt-5.4-mini's input rate — the
    // override took effect on turn 2's turn/start, so billedModel was re-snapshotted before it billed.
    expect(ends[1]!.costUsd).toBeCloseTo(1000 * 0.75 / 1e6, 10);
  });

  it("master continuity: ONE CodexBackend persists the per-thread baseline across resumed turns (T3b)", async () => {
    // Two SEPARATE per-turn ephemeral children (startTurn spawns fresh every call), but ONE backend
    // instance — this is exactly the master's turn-by-turn shape (each turn: fresh child, resume:threadId).
    const fake = fakeCodexSpawn((text) => text === "turn 1"
      ? [{ kind: "tokenUsage", last: { inputTokens: 1000 }, total: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100 } }, { kind: "turnEnd" }]
      : [{ kind: "tokenUsage", last: { inputTokens: 2000 }, total: { inputTokens: 2000, cachedInputTokens: 0, outputTokens: 200 } }, { kind: "turnEnd" }]);
    const b = new CodexBackend({ spawn: fake.spawn, defaultModel: () => "gpt-5.5" });

    const events1 = await collect(b.startTurn("turn 1", baseOpts({ model: "gpt-5.5" }) as never));
    const end1 = events1.find((e) => e.kind === "turn_end") as { costUsd: number };
    // Fresh session baseline is zeros: bills the full total (1000 input, 100 output).
    expect(end1.costUsd).toBeCloseTo(1000 * 5.0 / 1e6 + 100 * 30.0 / 1e6, 10);

    const events2 = await collect(b.startTurn("turn 2", baseOpts({ model: "gpt-5.5", resume: "th-1" }) as never));
    const end2 = events2.find((e) => e.kind === "turn_end") as { costUsd: number };
    // WITHOUT the fix, resume always seeds prevTotal=null, so this SINGLE update would be consumed as
    // a baseline and price 0. WITH the fix, th-1's baseline was persisted after turn 1 (total
    // {1000,0,100}), so turn 2's single update {2000,0,200} bills the DELTA: 1000 input + 100 output
    // at gpt-5.5 = 0.008.
    expect(end2.costUsd).toBeCloseTo(1000 * 5.0 / 1e6 + 100 * 30.0 / 1e6, 10);
    expect(end2.costUsd).toBeCloseTo(0.008, 10);
  });

  it("cold map: a fresh backend's first-ever resume of a thread still consumes the baseline (costUsd 0, existing behavior made explicit)", async () => {
    const fake = fakeCodexSpawn(() => [
      { kind: "tokenUsage", last: { inputTokens: 100 }, total: { inputTokens: 50_000, cachedInputTokens: 10_000, outputTokens: 9_000 } },
      { kind: "turnEnd" },
    ]);
    const b = new CodexBackend({ spawn: fake.spawn, defaultModel: () => "gpt-5.5" });
    // No prior turn has ever run under this backend for "th-x" — totalsByThread is cold, so this
    // falls back to prevTotal=null and the single update is consumed as the baseline, same as before T3b.
    const events = await collect(b.startTurn("continue", baseOpts({ model: "gpt-5.5", resume: "th-x" }) as never));
    const end = events.find((e) => e.kind === "turn_end") as { costUsd: number };
    expect(end.costUsd).toBe(0);
  });
});

describe("CodexBackend — fork timeout & explicit sandbox", () => {
  // P3 Track A: the daemon's codex MASTER fork router passes an explicit env override so the
  // ephemeral fork child runs in the SOURCE session's per-session CODEX_HOME (where thread/fork can
  // find the thread) instead of the shared home — verify the override reaches the spawn verbatim.
  it("forkSession threads an explicit env override into the ephemeral spawn", async () => {
    const fake = fakeCodexSpawn(() => []);
    const b = new CodexBackend({ spawn: fake.spawn, defaultModel: () => "gpt-5.5" });
    await b.forkSession("th-1", { env: { CODEX_HOME: "/x" } });
    expect(fake.spawns[0]!.env).toEqual({ CODEX_HOME: "/x" });
  });

  // No opts (worker/claude fork paths): falls back to deps.env() exactly as before P3.
  it("forkSession with no opts falls back to deps.env() (existing behavior, unchanged)", async () => {
    const fake = fakeCodexSpawn(() => []);
    const b = new CodexBackend({ spawn: fake.spawn, defaultModel: () => "gpt-5.5", env: () => ({ CODEX_HOME: "/shared" }) });
    await b.forkSession("th-1");
    expect(fake.spawns[0]!.env).toEqual({ CODEX_HOME: "/shared" });
  });

  it("forkSession rejects after the timeout when the child never answers", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeCodexSpawn(() => [], { silentForkHang: true }); // new opt: thread/fork gets NO response
      const b = new CodexBackend({ spawn: fake.spawn, defaultModel: () => "gpt-5.5" });
      const p = b.forkSession("th-1");
      const assertion = expect(p).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("every turn/start carries explicit approvalPolicy + sandboxPolicy derived from the CURRENT mode", async () => {
    const fake = fakeCodexSpawn(() => [{ kind: "turnEnd" }]);
    const b = new CodexBackend({ spawn: fake.spawn, defaultModel: () => "gpt-5.5" });
    const q = new MessageQueue(); q.push("t1"); q.close();
    await collect(b.openSession(q, baseOpts({ permissionMode: "acceptEdits" })));
    const turn = fake.requests.find((r) => r.method === "turn/start")!.params as Record<string, unknown>;
    expect(turn.approvalPolicy).toBe("never");
    expect(turn.sandboxPolicy).toMatchObject({ type: "workspaceWrite", networkAccess: true }); // rookery decision: workspace-write is always network-on
  });
});

describe("CodexBackend — per-turn inactivity watchdog (P2.5 Track B)", () => {
  // A "silent turn" is just an ordinary responder that never scripts a `turnEnd` step — the existing
  // fake already leaves such a turn open server-side forever (see fake-codex.ts's comment on that).
  // Combined with `silentInterrupt`, the watchdog's OWN turn/interrupt also goes unanswered, so the
  // grace-window kill path actually fires instead of the interrupt resolving the turn.

  it("trips on total silence: interrupts, then (no turn/completed within grace) kills the client and fails the stream with the timeout notice", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeCodexSpawn(() => [{ kind: "agentDelta", text: "starting…" }], { silentInterrupt: true });
      const b = new CodexBackend({ spawn: fake.spawn, defaultModel: () => "gpt-5.5", idleTimeoutMs: () => 1000 });
      const q = new MessageQueue(); q.push("do the task");
      const seen: AgentEvent[] = [];
      const collected = (async () => { for await (const ev of b.openSession(q, baseOpts())) seen.push(ev); })();
      const rejection = expect(collected).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(1000); // idle window elapses with only the one delta seen → turn/interrupt sent
      await vi.advanceTimersByTimeAsync(5000); // grace window elapses with no turn/completed → kill + fail
      await rejection;

      expect(fake.requests.some((r) => r.method === "turn/interrupt")).toBe(true);
      const notice = seen.find((e) => e.kind === "push") as { push: { code?: string; params?: unknown } } | undefined;
      expect(notice?.push).toMatchObject({ code: "notice.codexTurnTimeout", params: { seconds: 1 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("trips on a master (startTurn) turn too — the watchdog lives in the shared base, not just the worker path", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeCodexSpawn(() => [{ kind: "agentDelta", text: "…" }], { silentInterrupt: true });
      const b = new CodexBackend({ spawn: fake.spawn, defaultModel: () => "gpt-5.5", idleTimeoutMs: () => 1000 });
      const collected = collect(b.startTurn("hi", baseOpts() as never));
      const rejection = expect(collected).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(5000);
      await rejection;
      expect(fake.requests.some((r) => r.method === "turn/interrupt")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("healthy turn completes normally under the SAME tiny timeout — no timeout notice", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeCodexSpawn(() => [
        { kind: "reasoningDelta", text: "hmm" },
        { kind: "agentDelta", text: "he" },
        { kind: "agentMessage", text: "hello" },
        { kind: "command", id: "c1", command: "ls" },
        { kind: "turnEnd", durationMs: 5 },
      ]);
      const b = new CodexBackend({ spawn: fake.spawn, defaultModel: () => "gpt-5.5", idleTimeoutMs: () => 1000 });
      const q = new MessageQueue(); q.push("do it"); q.close();
      const events = await collect(b.openSession(q, baseOpts()));
      await vi.advanceTimersByTimeAsync(1000); // no dangling timer should fire after a clean completion
      expect(events.some((e) => e.kind === "push" && (e as { push: { code?: string } }).push.code === "notice.codexTurnTimeout")).toBe(false);
      expect(events.at(-1)).toMatchObject({ kind: "turn_end", subtype: "success" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("multi-turn worker session: idle time BETWEEN turns (just under the timeout) never trips — each turn arms/disarms independently", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeCodexSpawn(() => [{ kind: "turnEnd" }]);
      const b = new CodexBackend({ spawn: fake.spawn, defaultModel: () => "gpt-5.5", idleTimeoutMs: () => 1000 });
      const q = new MessageQueue(); q.push("t1");
      const events: AgentEvent[] = [];
      const done = (async () => {
        for await (const ev of b.openSession(q, baseOpts())) {
          events.push(ev);
          if (ev.kind === "turn_end" && (ev as { numTurns: number }).numTurns === 1) {
            await vi.advanceTimersByTimeAsync(900); // idle gap between turns — watchdog is disarmed here, must not trip
            q.push("t2"); q.close();
          }
        }
      })();
      await done;
      const turnEnds = events.filter((e) => e.kind === "turn_end");
      expect(turnEnds).toHaveLength(2);
      expect(events.some((e) => e.kind === "push" && (e as { push: { code?: string } }).push.code === "notice.codexTurnTimeout")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("0 disables the watchdog: no timer ever armed even across a long silence; the turn only ends when explicitly interrupted", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeCodexSpawn(() => [{ kind: "agentDelta", text: "…" }]); // never self-ends
      const b = new CodexBackend({ spawn: fake.spawn, defaultModel: () => "gpt-5.5", idleTimeoutMs: () => 0 });
      const q = new MessageQueue(); q.push("slow task");
      const stream = b.openSession(q, baseOpts());
      const seen: AgentEvent[] = [];
      const done = (async () => {
        for await (const ev of stream) {
          seen.push(ev);
          if (ev.kind === "text_delta") {
            await vi.advanceTimersByTimeAsync(10 * 60_000); // 10 minutes of total silence — must be a no-op
            await stream.interrupt(); // the only thing that ends this turn
          }
          if (ev.kind === "turn_end") q.close();
        }
      })();
      await done;
      expect(seen.some((e) => e.kind === "push" && (e as { push: { code?: string } }).push.code === "notice.codexTurnTimeout")).toBe(false);
      expect(seen.at(-1)).toMatchObject({ kind: "turn_end", subtype: "interrupted" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("no idleTimeoutMs dep at all behaves like 0 (disabled) — backward compatible with existing deps callers", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeCodexSpawn(() => [{ kind: "agentDelta", text: "…" }]);
      const b = new CodexBackend({ spawn: fake.spawn, defaultModel: () => "gpt-5.5" }); // no idleTimeoutMs at all
      const q = new MessageQueue(); q.push("x");
      const stream = b.openSession(q, baseOpts());
      const seen: AgentEvent[] = [];
      const done = (async () => {
        for await (const ev of stream) {
          seen.push(ev);
          if (ev.kind === "text_delta") { await vi.advanceTimersByTimeAsync(5 * 60_000); await stream.interrupt(); }
          if (ev.kind === "turn_end") q.close();
        }
      })();
      await done;
      expect(seen.some((e) => e.kind === "push" && (e as { push: { code?: string } }).push.code === "notice.codexTurnTimeout")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("disarm on explicit interrupt(): no timeout notice afterward even past the original idle+grace window", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeCodexSpawn(() => [{ kind: "agentDelta", text: "…" }]); // never self-ends; default fake auto-completes on interrupt
      const b = new CodexBackend({ spawn: fake.spawn, defaultModel: () => "gpt-5.5", idleTimeoutMs: () => 1000 });
      const q = new MessageQueue(); q.push("x");
      const stream = b.openSession(q, baseOpts());
      const seen: AgentEvent[] = [];
      const done = (async () => {
        for await (const ev of stream) {
          seen.push(ev);
          if (ev.kind === "text_delta") await stream.interrupt();
          if (ev.kind === "turn_end") q.close();
        }
      })();
      await done;
      await vi.advanceTimersByTimeAsync(10_000); // well past idle+grace — must be a no-op, the watchdog was disarmed
      expect(seen.some((e) => e.kind === "push" && (e as { push: { code?: string } }).push.code === "notice.codexTurnTimeout")).toBe(false);
      expect(seen.at(-1)).toMatchObject({ kind: "turn_end", subtype: "interrupted" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("watchdog-driven interrupt racing turn/completed must not leave the grace timer dangling into the next turn (regression for the ordering hole in d813fef)", async () => {
    vi.useFakeTimers();
    try {
      // NORMAL interrupt behavior (default fakeCodexSpawn opts, NOT silentInterrupt): the fake acks
      // turn/interrupt AND immediately follows it with turn/completed(interrupted) — the exact
      // same-batch race (ack + completion arriving together) the buggy code missed. Every "trips
      // on..." test above uses silentInterrupt:true, which suppresses this very turn/completed and
      // so never exercised this hole.
      const fake = fakeCodexSpawn((_text, turn) =>
        turn === 0
          ? [{ kind: "command", id: "c1", command: "npm test" }] // starts a long op, then goes silent (quiet-but-alive) — never self-ends
          : [{ kind: "turnEnd" }], // turn 2: an ordinary healthy turn
      );
      const b = new CodexBackend({ spawn: fake.spawn, defaultModel: () => "gpt-5.5", idleTimeoutMs: () => 1000 });
      const q = new MessageQueue();
      q.push("t1");
      const seen: AgentEvent[] = [];
      const done = (async () => { for await (const ev of b.openSession(q, baseOpts())) seen.push(ev); })();

      await vi.advanceTimersByTimeAsync(1000); // idle window elapses on turn 1 → watchdog fires: interrupt() sent,
      // the fake's ack + turn/completed(interrupted) both land in the same microtask batch — the race.

      // Turn 1 in isolation: the interrupt-driven turn/completed already happened above. Advance well
      // past WATCHDOG_GRACE_MS (5000ms) BEFORE turn 2 even starts — if the grace timer had dangled,
      // THIS is where it would spuriously fire and fail the whole stream.
      await vi.advanceTimersByTimeAsync(6000);

      q.push("t2"); q.close(); // a second, ordinary turn — must complete cleanly if the session survived
      await done;

      const turnEnds = seen.filter((e) => e.kind === "turn_end") as Array<{ subtype: string; numTurns: number }>;
      expect(turnEnds).toHaveLength(2);
      expect(turnEnds[0]).toMatchObject({ subtype: "interrupted", numTurns: 1 });
      expect(turnEnds[1]).toMatchObject({ subtype: "success", numTurns: 2 });
      expect(seen.some((e) => e.kind === "push" && (e as { push: { code?: string } }).push.code === "notice.codexTurnTimeout")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("disarm on abort: no timeout notice afterward even past the original idle+grace window", async () => {
    vi.useFakeTimers();
    try {
      const abortController = new AbortController();
      const fake = fakeCodexSpawn(() => [{ kind: "agentDelta", text: "…" }]); // never self-ends
      const b = new CodexBackend({ spawn: fake.spawn, defaultModel: () => "gpt-5.5", idleTimeoutMs: () => 1000 });
      const q = new MessageQueue(); q.push("x");
      const stream = b.openSession(q, baseOpts({ abortController }));
      const seen: AgentEvent[] = [];
      const done = (async () => { for await (const ev of stream) { seen.push(ev); if (ev.kind === "text_delta") abortController.abort(); } })();
      await expect(done).resolves.toBeUndefined(); // abort ends the stream silently (no throw) — Claude parity
      await vi.advanceTimersByTimeAsync(10_000);
      expect(seen.some((e) => e.kind === "push" && (e as { push: { code?: string } }).push.code === "notice.codexTurnTimeout")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("formatDuration (P3-remaining Track A #5)", () => {
  it("sub-second shows ms, 1000ms+ shows rounded seconds", () => {
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(120000)).toBe("120s");
    expect(formatDuration(1500)).toBe("2s"); // rounds, doesn't truncate
  });
});

describe("CodexBackend — pre-turn handshake/thread-start timeout (P3-remaining Track A #2)", () => {
  it("stalls during initialize: the stream fails with a handshake-timeout error and the child is killed", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeCodexSpawn(() => [{ kind: "turnEnd" }], { silentInitialize: true });
      const b = new CodexBackend({ spawn: fake.spawn, defaultModel: () => "gpt-5.5", handshakeTimeoutMs: () => 1000 });
      const q = new MessageQueue(); q.push("x"); q.close();
      const collected = collect(b.openSession(q, baseOpts()));
      const rejection = expect(collected).rejects.toThrow(/handshake.*timed out/);
      await vi.advanceTimersByTimeAsync(1000);
      await rejection;
      expect(fake.killed[0]).toBe(true); // the spawned transport was killed on timeout
      expect(fake.requests.some((r) => r.method === "thread/start")).toBe(false); // never got past initialize
    } finally {
      vi.useRealTimers();
    }
  });

  it("stalls during thread/start: the stream fails with a handshake-timeout error and the child is killed", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeCodexSpawn(() => [{ kind: "turnEnd" }], { silentThreadStart: true });
      const b = new CodexBackend({ spawn: fake.spawn, defaultModel: () => "gpt-5.5", handshakeTimeoutMs: () => 1000 });
      const q = new MessageQueue(); q.push("x"); q.close();
      const collected = collect(b.openSession(q, baseOpts()));
      const rejection = expect(collected).rejects.toThrow(/handshake.*timed out/);
      await vi.advanceTimersByTimeAsync(1000);
      await rejection;
      expect(fake.killed[0]).toBe(true);
      expect(fake.requests.some((r) => r.method === "initialize")).toBe(true); // got past initialize this time
      expect(fake.requests.some((r) => r.method === "thread/start")).toBe(true); // request was sent, just never answered
    } finally {
      vi.useRealTimers();
    }
  });

  it("also trips on a master (startTurn) turn — the race lives in the shared base, not just the worker path", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeCodexSpawn(() => [{ kind: "turnEnd" }], { silentInitialize: true });
      const b = new CodexBackend({ spawn: fake.spawn, defaultModel: () => "gpt-5.5", handshakeTimeoutMs: () => 1000 });
      const collected = collect(b.startTurn("hi", baseOpts() as never));
      const rejection = expect(collected).rejects.toThrow(/handshake.*timed out/);
      await vi.advanceTimersByTimeAsync(1000);
      await rejection;
      expect(fake.killed[0]).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a normal handshake under a tiny handshakeTimeoutMs is NOT a false trip — the turn starts and completes", async () => {
    const fake = fakeCodexSpawn(() => [{ kind: "turnEnd" }]);
    const b = new CodexBackend({ spawn: fake.spawn, defaultModel: () => "gpt-5.5", handshakeTimeoutMs: () => 1000 });
    const q = new MessageQueue(); q.push("x"); q.close();
    const events = await collect(b.openSession(q, baseOpts()));
    expect(events.at(-1)).toMatchObject({ kind: "turn_end", subtype: "success" });
  });

  it("0 disables the handshake timeout — a genuinely SLOW (but completing) handshake still succeeds", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeCodexSpawn(() => [{ kind: "turnEnd" }], { initializeDelayMs: 5000 });
      const b = new CodexBackend({ spawn: fake.spawn, defaultModel: () => "gpt-5.5", handshakeTimeoutMs: () => 0 });
      const q = new MessageQueue(); q.push("x"); q.close();
      const collected = collect(b.openSession(q, baseOpts()));
      await vi.advanceTimersByTimeAsync(5000); // let the delayed initialize answer land
      const events = await collected;
      expect(events.at(-1)).toMatchObject({ kind: "turn_end", subtype: "success" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("no handshakeTimeoutMs dep at all behaves like 0 (disabled) — backward compatible with existing deps callers", async () => {
    const fake = fakeCodexSpawn(() => [{ kind: "turnEnd" }]); // no handshakeTimeoutMs at all
    const b = new CodexBackend({ spawn: fake.spawn, defaultModel: () => "gpt-5.5" });
    const q = new MessageQueue(); q.push("x"); q.close();
    const events = await collect(b.openSession(q, baseOpts()));
    expect(events.at(-1)).toMatchObject({ kind: "turn_end", subtype: "success" });
  });
});

describe("CodexBackend — in-app apiKey provisioning", () => {
  it("apiKey set + requiresOpenaiAuth:true → account/read then account/login/start (before thread/start)", async () => {
    const fake = fakeCodexSpawn(() => [{ kind: "turnEnd" }], { requiresOpenaiAuth: true });
    const b = new CodexBackend({ spawn: fake.spawn, defaultModel: () => "gpt-5.5", apiKey: () => "sk-test" });
    const q = new MessageQueue(); q.push("x"); q.close();
    await collect(b.openSession(q, baseOpts()));
    const methods = fake.requests.map((r) => r.method);
    const readIdx = methods.indexOf("account/read");
    const loginIdx = methods.indexOf("account/login/start");
    const startIdx = methods.indexOf("thread/start");
    expect(readIdx).toBeGreaterThanOrEqual(0);
    expect(loginIdx).toBeGreaterThan(readIdx);
    expect(startIdx).toBeGreaterThan(loginIdx);
    expect(fake.requests[loginIdx].params).toEqual({ type: "apiKey", apiKey: "sk-test" });
  });

  it("apiKey set + requiresOpenaiAuth:false → account/read present, NO account/login/start", async () => {
    const fake = fakeCodexSpawn(() => [{ kind: "turnEnd" }], { requiresOpenaiAuth: false });
    const b = new CodexBackend({ spawn: fake.spawn, defaultModel: () => "gpt-5.5", apiKey: () => "sk-test" });
    const q = new MessageQueue(); q.push("x"); q.close();
    await collect(b.openSession(q, baseOpts()));
    expect(fake.requests.some((r) => r.method === "account/read")).toBe(true);
    expect(fake.requests.some((r) => r.method === "account/login/start")).toBe(false);
  });

  it("no apiKey → NO account/read at all", async () => {
    const fake = fakeCodexSpawn(() => [{ kind: "turnEnd" }]);
    const b = new CodexBackend({ spawn: fake.spawn, defaultModel: () => "gpt-5.5" }); // apiKey resolver absent
    const q = new MessageQueue(); q.push("x"); q.close();
    await collect(b.openSession(q, baseOpts()));
    expect(fake.requests.some((r) => r.method === "account/read")).toBe(false);
  });
});
