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
