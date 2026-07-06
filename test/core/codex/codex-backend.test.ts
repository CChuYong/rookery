import { describe, it, expect, vi } from "vitest";
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

  it("startTurn (master path) throws a clean not-supported error", () => {
    const { backend: b } = backend(() => []);
    expect(() => b.startTurn("hi", baseOpts() as never)).toThrow(/not supported/);
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
});

describe("CodexBackend — fork timeout & explicit sandbox", () => {
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
