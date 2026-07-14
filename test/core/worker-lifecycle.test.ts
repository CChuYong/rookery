import { describe, it, expect, vi } from "vitest";
import { openDb } from "../../src/persistence/db.js";
import { Repositories } from "../../src/persistence/repositories.js";
import { EventBus } from "../../src/core/events.js";
import { Worker } from "../../src/core/worker.js";
import { fakeStreamingBackend } from "../helpers/fake-query.js";
import type { AgentBackend, AgentSessionOptions, AgentStream } from "../../src/core/agent-backend.js";
import type { ResolvedAgentCapabilities } from "../../src/core/capabilities/types.js";

// Poll until the condition becomes true (throw on timeout) — the streaming worker only settles to terminal, so idle is observed via status().
async function until(cond: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("until: timeout");
    await new Promise((r) => setTimeout(r, 1));
  }
}

// A finite fakeQuery ends when the script finishes — the generator terminates and the worker becomes done — which differs from the real streaming SDK.
// fakeStreamingQuery stays alive until the input (MessageQueue) closes, so it faithfully reproduces spawn→idle→send→idle→stop.
describe("Worker lifecycle with a streaming query (real SDK fidelity)", () => {
  it("stays idle after each turn (not done) and reaches stopped only on stop()", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/wt", label: "x", worktreePath: "/wt", branch: "rookery/a1" });
    const bus = new EventBus();
    const backend = fakeStreamingBackend((text, turn) => [
      { type: "assistant", text: `reply ${turn}: ${text}` },
      { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: `sdk-${turn}` },
    ]);
    const sub = new Worker({ id: "a1", sessionId: "s1", repoPath: "/wt", label: "x", deps: { repos, bus, backend, model: "m" } });

    sub.start("do task");
    await until(() => sub.status() === "idle"); // first turn ends → idle (a finite fake would have become done)
    expect(sub.status()).toBe("idle");

    sub.send("more");
    await until(() => sub.status() === "idle"); // second turn also goes idle — the session stays alive
    expect(sub.status()).toBe("idle");

    await sub.stop();
    expect(sub.status()).toBe("stopped"); // terminates only via stop
  });

  it("replaces only the provider cycle and keeps the worker lifetime, queue, session, and transcript alive", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/wt", label: "x", worktreePath: "/wt", branch: "rookery/a1" });
    const bus = new EventBus();
    const delegate = fakeStreamingBackend((text, turn) => [
      { type: "assistant", text: `cycle reply ${turn}: ${text}` },
      { type: "result", subtype: "success", total_cost_usd: 0.1, num_turns: 1, session_id: "native-session-1" },
    ]);
    const opened: Array<{ input: AsyncIterable<string>; options: AgentSessionOptions }> = [];
    const backend: AgentBackend = {
      openSession(input, options) {
        opened.push({ input, options });
        const { capabilities: _capabilities, runtimeKey: _runtimeKey, ...plain } = options;
        return delegate.openSession(input, plain);
      },
      startTurn: (prompt, options) => delegate.startTurn(prompt, options),
    };
    let revision = "rev-a";
    const managedCapabilities = (): ResolvedAgentCapabilities => ({
      revision,
      blocked: false,
      instructions: [],
      skills: [],
      mcpServers: [],
    });
    const applied: string[] = [];
    const worker = new Worker({
      id: "a1", sessionId: "s1", repoPath: "/wt", label: "x",
      deps: {
        repos, bus, backend, model: "m", managedCapabilities,
        capabilityRuntime: {
          setDesired: () => {},
          setApplied: (_target, next) => applied.push(next),
          setError: () => {},
        },
      },
    });

    worker.start("first");
    await until(() => worker.status() === "idle");
    expect(applied).toEqual(["rev-a"]);
    const beforeSeq = repos.nextWorkerSeq("a1");
    revision = "rev-b";

    const request = worker.requestCapabilityReload({ whenIdle: false, onBegin: () => {} });
    expect(request.mode).toBe("reloading");
    await request.completion;
    expect(opened).toHaveLength(2);
    expect(opened[0]!.input).not.toBe(opened[1]!.input);
    expect(opened.map(({ options }) => options.resume)).toEqual([null, "native-session-1"]);
    expect(opened.map(({ options }) => options.capabilities?.revision)).toEqual(["rev-a", "rev-b"]);
    expect(worker.status()).toBe("idle");
    expect(repos.getWorker("a1")?.status).toBe("idle");

    const lifetimeSettled = vi.fn();
    void worker.waitUntilSettled().then(lifetimeSettled);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lifetimeSettled).not.toHaveBeenCalled();

    worker.send("after reload");
    await until(() => worker.status() === "idle" && applied.includes("rev-b"));
    expect(repos.nextWorkerSeq("a1")).toBeGreaterThan(beforeSeq);
    const resultPayloads = repos.listWorkerEvents("a1")
      .filter((event) => event.type === "result")
      .map((event) => JSON.parse(event.payload_json) as { costUsd: number; numTurns: number });
    expect(resultPayloads.at(-1)).toMatchObject({ costUsd: 0.2, numTurns: 2 });
    await worker.stop();
    await worker.waitUntilSettled();
  });

  it("rejects immediate busy reload, schedules when idle, and gates sends only after replacement begins", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/wt", label: "x", worktreePath: "/wt", branch: "rookery/a1" });
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });
    let releaseInterrupt!: () => void;
    const interruptGate = new Promise<void>((resolve) => { releaseInterrupt = resolve; });
    let opens = 0;
    const backend: AgentBackend = {
      openSession(input, options) {
        const index = opens++;
        async function* events() {
          for await (const _text of input) {
            if (index === 0) await turnGate;
            yield { kind: "session_id" as const, sessionId: "native-session-1" };
            yield { kind: "turn_end" as const, subtype: "success", costUsd: 0, numTurns: 1, durationMs: 0, contextTokens: 0, contextWindow: 0 };
          }
        }
        const stream = events() as AgentStream;
        return Object.assign(stream, {
          interrupt: async () => { if (index === 0) await interruptGate; return undefined; },
          setModel: async () => {},
          setPermissionMode: async () => {},
          supportedCommands: async () => [],
        });
      },
      startTurn() { throw new Error("unused"); },
    };
    const worker = new Worker({ id: "a1", sessionId: "s1", repoPath: "/wt", label: "x", deps: { repos, bus: new EventBus(), backend, model: "m" } });
    worker.start("first");

    expect(() => worker.requestCapabilityReload({ whenIdle: false, onBegin: () => {} })).toThrow(/busy.*whenIdle/i);
    const onBegin = vi.fn();
    const scheduled = worker.requestCapabilityReload({ whenIdle: true, onBegin });
    expect(scheduled.mode).toBe("scheduled");
    expect(() => worker.send("still accepted while waiting")).not.toThrow();

    releaseTurn();
    await until(() => onBegin.mock.calls.length === 1);
    expect(() => worker.send("racing replacement")).toThrow(/reload in progress.*retry/i);
    releaseInterrupt();
    await scheduled.completion;
    expect(opens).toBe(2);
    expect(worker.status()).toBe("idle");
    await worker.stop();
  });

  it("keeps a failed reload idle and allows a fresh retry", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/wt", label: "x", worktreePath: "/wt", branch: "rookery/a1" });
    const delegate = fakeStreamingBackend(() => [
      { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "native-session-1" },
    ]);
    let opens = 0;
    const backend: AgentBackend = {
      openSession(input, options) {
        opens++;
        if (opens === 2) throw new Error("replacement setup failed");
        const { capabilities: _capabilities, runtimeKey: _runtimeKey, ...plain } = options;
        return delegate.openSession(input, plain);
      },
      startTurn: (prompt, options) => delegate.startTurn(prompt, options),
    };
    let revision = "rev-a";
    const errors: string[] = [];
    const worker = new Worker({
      id: "a1", sessionId: "s1", repoPath: "/wt", label: "x",
      deps: {
        repos, bus: new EventBus(), backend, model: "m",
        managedCapabilities: () => ({ revision, blocked: false, instructions: [], skills: [], mcpServers: [] }),
        capabilityRuntime: {
          setDesired: () => {},
          setApplied: () => {},
          setError: (_target, _revision, message) => errors.push(message),
        },
      },
    });
    worker.start("first");
    await until(() => worker.status() === "idle");
    revision = "rev-b";

    await expect(worker.requestCapabilityReload({ whenIdle: false, onBegin: () => {} }).completion)
      .rejects.toThrow(/replacement setup failed/);
    expect(worker.status()).toBe("idle");
    expect(repos.getWorker("a1")?.status).toBe("idle");
    expect(errors).toEqual(["Capability runtime application failed."]);
    expect(() => worker.send("must retry first")).toThrow(/reload failed.*retry/i);

    const retry = worker.requestCapabilityReload({ whenIdle: false, onBegin: () => {} });
    await retry.completion;
    expect(opens).toBe(3);
    expect(worker.status()).toBe("idle");
    await worker.stop();
  });
});
