import { describe, it, expect, vi } from "vitest";
import { openDb } from "../../src/persistence/db.js";
import { Repositories } from "../../src/persistence/repositories.js";
import { EventBus } from "../../src/core/events.js";
import type { CoreEvent } from "../../src/core/events.js";
import { Worker } from "../../src/core/worker.js";
import { extractToolUses, extractToolResults } from "../../src/core/sdk-extract.js";
import type { QueryFn } from "../../src/core/claude-backend.js";
import { fakeQuery, fakeStreamingQuery, fakeBackend, fakeStreamingBackend } from "../helpers/fake-query.js";
import { ClaudeBackend } from "../../src/core/claude-backend.js";
import type { AgentBackend, AgentSessionOptions } from "../../src/core/agent-backend.js";
import type { ResolvedAgentCapabilities } from "../../src/core/capabilities/types.js";

// Poll until the condition becomes true (throw on timeout) — for reproducing mid-turn timing.
async function until(cond: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("until: timeout");
    await new Promise((r) => setTimeout(r, 1));
  }
}

describe("Worker cross-provider handoff seed", () => {
  it("prepends the handoff seed to the first turn's backend text but records only the user text, then clears the marker", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t", provider: "codex" });
    repos.setWorkerHandoffFrom("a1", "claude");
    let backendText = "";
    const liveQuery = ((input: { prompt?: unknown }) => {
      async function* gen(): AsyncGenerator<unknown> {
        for await (const um of input.prompt as AsyncIterable<unknown>) {
          backendText += JSON.stringify(um);
          yield { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1", parent_tool_use_id: null };
        }
      }
      return Object.assign(gen(), { interrupt: async () => {}, close: () => {}, supportedCommands: async () => [], setModel: async () => {} });
    }) as QueryFn;
    const agent = new Worker({
      id: "a1", sessionId: "s1", repoPath: "/r", label: "t", sdkSessionId: null,
      handoffSeed: "<prior-conversation>ctx-from-claude</prior-conversation>", handoffFromProvider: "claude",
      deps: { repos, bus: new EventBus(), model: "m", backend: new ClaudeBackend(liveQuery) },
    });

    agent.resume(); // handoff worker materializes idle (no native resume handle)
    await until(() => agent.status() === "idle");
    agent.send("do the task");
    await until(() => backendText.includes("do the task"));

    expect(backendText).toContain("ctx-from-claude"); // seed reached the backend
    expect(backendText).toContain("do the task");
    const userEvents = repos.listWorkerEvents("a1").filter((e) => { try { return JSON.parse(e.payload_json).role === "user"; } catch { return false; } });
    expect(userEvents.some((e) => JSON.parse(e.payload_json).content === "do the task")).toBe(true);
    expect(userEvents.some((e) => (JSON.parse(e.payload_json).content ?? "").includes("prior-conversation"))).toBe(false);
    await until(() => repos.getWorker("a1")!.handoff_from_provider === null); // cleared once sdk id assigned
    await agent.stop();
  });
});

describe("Worker", () => {
  it("forwards workflow lifecycle to the optional sink without persisting duplicate transcript events", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/repo/a", label: "task" });
    const workflowActivity = { launched: vi.fn(), taskUpdated: vi.fn(), stopWorker: vi.fn() };
    const agent = new Worker({
      id: "a1",
      sessionId: "s1",
      repoPath: "/repo/a",
      label: "task",
      deps: {
        repos,
        bus: new EventBus(),
        model: "m",
        workflowActivity,
        backend: fakeBackend([
          { type: "system", text: "init", sessionId: "sdk-1" },
          { type: "workflow_launch", id: "tool-1", taskId: "task-1", runId: "run-1", workflowName: "audit", transcriptDir: "/tmp/sdk-1/subagents/workflows/run-1" },
          { type: "task_started", id: "task-1", taskType: "local_workflow", workflowName: "audit" },
          { type: "task_progress", id: "task-1", summary: "reviewing", lastToolName: "Read" },
          { type: "task_notification", id: "task-1", status: "completed", summary: "done" },
          { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" },
        ]),
      },
    });

    agent.start("go");
    await agent.waitUntilSettled();

    expect(workflowActivity.launched).toHaveBeenCalledWith(
      { sessionId: "s1", workerId: "a1", sdkSessionId: "sdk-1" },
      expect.objectContaining({ taskId: "task-1", toolUseId: "tool-1" }),
    );
    expect(workflowActivity.taskUpdated).toHaveBeenCalledTimes(3);
    expect(workflowActivity.stopWorker).toHaveBeenCalledTimes(1);
    expect(repos.listWorkerEvents("a1").some((event) => event.type.includes("workflow"))).toBe(false);
  });

  it("runs, persists events, emits to bus, and settles to stopped on natural stream end", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/repo/a", label: "task" });
    const bus = new EventBus();
    const events: CoreEvent[] = [];
    bus.subscribe("s1", (e) => events.push(e));

    const agent = new Worker({
      id: "a1",
      sessionId: "s1",
      repoPath: "/repo/a",
      label: "task",
      deps: {
        repos,
        bus,
        model: "test-model",
        backend: fakeBackend([
          { type: "assistant", text: "working on it" },
          { type: "result", subtype: "success", total_cost_usd: 0.01, num_turns: 1, session_id: "sdk-1" },
        ]),
      },
    });

    agent.start("do the task");
    await agent.waitUntilSettled();

    expect(agent.status()).toBe("stopped"); // natural fake-stream end lands stopped (done retired 2026-07-11)
    // Persisted events: first user instruction + assistant message + result + the stream-end notice (done retired 2026-07-11)
    const persisted = repos.listWorkerEvents("a1");
    expect(persisted.map((e) => e.type)).toEqual(["message", "message", "result", "notice"]);
    // Emitted worker.event: user message + assistant message + result + stream-end notice = 4
    const msgEvents = events.filter((e) => e.type === "worker.event");
    expect(msgEvents.length).toBe(4);
    // status transition event
    expect(events.some((e) => e.type === "worker.status")).toBe(true);
    // The result's session_id is persisted → resume is possible after restart
    expect(repos.getWorker("a1")?.sdk_session_id).toBe("sdk-1");
  });

  it("does not render injected user-role text (e.g. skill body) as a transcript message", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    const agent = new Worker({
      id: "a1",
      sessionId: "s1",
      repoPath: "/r",
      label: "t",
      deps: {
        repos,
        bus: new EventBus(),
        model: "m",
        // When a skill loads, the SDK injects the skill body as user-type text → not typed by a human.
        backend: fakeBackend([
          { type: "user_text", text: "SKILL BODY: always use TDD" },
          { type: "assistant", text: "ok will do" },
          { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "s" },
        ]),
      },
    });
    agent.start("go");
    await agent.waitUntilSettled();
    const persisted = repos.listWorkerEvents("a1").map((e) => JSON.parse(e.payload_json) as { role?: string; content?: string });
    // The injected user text (skill body) must not leak into the transcript as a user message
    expect(persisted.some((p) => p.content === "SKILL BODY: always use TDD")).toBe(false);
    // The real first instruction (start) and the assistant reply remain intact
    expect(persisted.some((p) => p.role === "user" && p.content === "go")).toBe(true);
    expect(persisted.some((p) => p.role === "assistant" && p.content === "ok will do")).toBe(true);
  });

  it("stop() transitions to stopped", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    const agent = new Worker({
      id: "a1",
      sessionId: "s1",
      repoPath: "/r",
      label: "t",
      deps: { repos, bus: new EventBus(), model: "m", backend: fakeBackend([]) },
    });
    agent.start("go");
    await agent.stop();
    expect(agent.status()).toBe("stopped");
    expect(repos.getWorker("a1")?.status).toBe("stopped");
  });

  it("interruptTurn() interrupts the current turn WITHOUT closing the queue or aborting (worker stays alive)", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    // A fake that mimics a live streaming input: spy only on query.interrupt and observe whether the
    // input (queue) closes / whether abort is triggered. interrupt must neither close the queue nor abort (= unlike stop).
    let interruptCalls = 0;
    let aborted = false;
    let capturedPrompt: AsyncIterable<unknown> | undefined;
    const liveQuery = ((input: { prompt?: unknown; options?: { abortController?: AbortController } }) => {
      capturedPrompt = input.prompt as AsyncIterable<unknown>;
      input.options?.abortController?.signal.addEventListener("abort", () => { aborted = true; });
      async function* gen(): AsyncGenerator<unknown> {
        // A live session that ends only when the input queue closes (emits just the turn result, then drops to idle).
        for await (const _userMsg of input.prompt as AsyncIterable<unknown>) {
          yield { type: "assistant", parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } };
          yield { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1", parent_tool_use_id: null };
        }
      }
      return Object.assign(gen(), {
        interrupt: async () => { interruptCalls++; },
        close: () => {},
        supportedCommands: async () => [],
        setModel: async () => {},
      });
    }) as QueryFn;
    const agent = new Worker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t", deps: { repos, bus: new EventBus(), model: "m", backend: new ClaudeBackend(liveQuery) } });

    agent.start("go");
    await until(() => agent.status() === "idle"); // wait until the first turn ends and drops to idle

    await agent.interruptTurn();
    expect(interruptCalls).toBe(1); // query.interrupt was called
    expect(aborted).toBe(false); // abort is not triggered (unlike stop)
    expect(agent.status()).not.toBe("stopped"); // the worker stays alive

    // The queue is not closed, so follow-up instructions are still possible
    expect(() => agent.send("more")).not.toThrow();
    void capturedPrompt; // (the input queue stays alive until stop)

    await agent.stop(); // test cleanup: close the live streaming loop
  });

  it("resume() seeds seq from the DB so post-restart events don't collide with persisted ones", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    // 3 pre-restart events already exist in the DB (seq 0,1,2)
    repos.addWorkerEvent({ workerId: "a1", seq: 0, type: "message", payloadJson: "{}" });
    repos.addWorkerEvent({ workerId: "a1", seq: 1, type: "tool_use", payloadJson: "{}" });
    repos.addWorkerEvent({ workerId: "a1", seq: 2, type: "result", payloadJson: "{}" });
    const agent = new Worker({
      id: "a1",
      sessionId: "s1",
      repoPath: "/r",
      label: "t",
      sdkSessionId: "sdk-1",
      deps: {
        repos,
        bus: new EventBus(),
        model: "m",
        backend: fakeBackend([
          { type: "assistant", text: "resumed reply" },
          { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" },
        ]),
      },
    });
    agent.resume();
    await agent.waitUntilSettled();
    const seqs = repos.listWorkerEvents("a1").map((e) => e.seq);
    expect(seqs).toEqual([...new Set(seqs)]); // no duplicate seq
    expect(Math.max(...seqs)).toBeGreaterThanOrEqual(3); // new events continue from 3 or higher
  });

  it("resume() seeds cumulative cost/turns from the last persisted result — monotonic after restart (audit #28)", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    // A pre-restart result already persisted the lifetime-cumulative totals (cost 1.2 / turns 3).
    repos.addWorkerEvent({ workerId: "a1", seq: 0, type: "message", payloadJson: '{"kind":"message","role":"user","content":"go"}' });
    repos.addWorkerEvent({ workerId: "a1", seq: 1, type: "result", payloadJson: JSON.stringify({ kind: "result", subtype: "success", costUsd: 1.2, numTurns: 3 }) });
    const bus = new EventBus();
    const events: CoreEvent[] = [];
    bus.subscribe("s1", (e) => events.push(e));
    const agent = new Worker({
      id: "a1",
      sessionId: "s1",
      repoPath: "/r",
      label: "t",
      sdkSessionId: "sdk-1",
      // Streaming fake so resume() drops to idle and a later send() drives one more turn (+0.1 cost / +1 turn).
      deps: { repos, bus, model: "m", backend: fakeStreamingBackend(() => [{ type: "result", subtype: "success", total_cost_usd: 0.1, num_turns: 1, session_id: "sdk-1" }]) },
    });
    agent.resume();
    await until(() => agent.status() === "idle");
    agent.send("continue");
    await until(() => agent.status() === "idle");
    const results = events.filter((e) => e.type === "worker.event" && (e as Extract<CoreEvent, { type: "worker.event" }>).data.kind === "result");
    const last = (results.at(-1) as Extract<CoreEvent, { type: "worker.event" }>).data as { costUsd: number; numTurns: number };
    expect(last.costUsd).toBeCloseTo(1.3); // 1.2 (seeded) + 0.1 (this turn) — not a reset to 0.1
    expect(last.numTurns).toBe(4); // 3 (seeded) + 1 (this turn)
    await agent.stop();
  });

  it("routes nested-worker activity (parent_tool_use_id) to a live worker.nested event, not the DB", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    const bus = new EventBus();
    const events: CoreEvent[] = [];
    bus.subscribe("s1", (e) => events.push(e));
    const agent = new Worker({
      id: "a1",
      sessionId: "s1",
      repoPath: "/r",
      label: "t",
      deps: {
        repos,
        bus,
        model: "m",
        backend: fakeBackend([
          { type: "assistant", text: "nested working on it", parentToolUseId: "task-1" }, // nested Worker's text
          { type: "tool_use", id: "tn", name: "Read", parentToolUseId: "task-1" }, // nested Worker's tool
          { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" },
        ]),
      },
    });
    agent.start("go");
    await agent.waitUntilSettled();
    // It flowed to a live nested event, and
    const nested = events.filter((e) => e.type === "worker.nested");
    expect(nested.length).toBe(2);
    expect(nested[0]).toMatchObject({ workerId: "a1", parentToolUseId: "task-1", data: { kind: "message", role: "assistant", content: "nested working on it" } });
    expect(nested[1]).toMatchObject({ parentToolUseId: "task-1", data: { kind: "tool_use", name: "Read" } });
    // Nested activity is not persisted in the DB (transcript)
    const persisted = repos.listWorkerEvents("a1").map((e) => JSON.parse(e.payload_json) as { content?: string });
    expect(persisted.some((p) => p.content === "nested working on it")).toBe(false);
  });

  it("enables forwardSubagentText so nested activity is forwarded by the SDK", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    let captured: { forwardSubagentText?: boolean } | undefined;
    const inner = fakeQuery([{ type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "s" }]);
    const qfn = ((input: { options?: { forwardSubagentText?: boolean } }) => {
      captured = input.options;
      return inner(input as Parameters<typeof inner>[0]);
    }) as typeof inner;
    const agent = new Worker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t", deps: { repos, bus: new EventBus(), model: "m", backend: new ClaudeBackend(qfn) } });
    agent.start("go");
    await agent.waitUntilSettled();
    expect(captured?.forwardSubagentText).toBe(true);
  });

  it("passes effort to the SDK only when set and the model supports it (Haiku omitted)", async () => {
    async function effortIn(model: string, effort?: string): Promise<unknown> {
      const repos = new Repositories(openDb(":memory:"));
      repos.createSession({ id: "s1", cwd: "/x" });
      repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
      let captured: { effort?: unknown } = {};
      const inner = fakeQuery([{ type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "s" }]);
      const qfn = ((input: { options?: typeof captured }) => {
        captured = input.options ?? {};
        return inner(input as Parameters<typeof inner>[0]);
      }) as typeof inner;
      const agent = new Worker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t", deps: { repos, bus: new EventBus(), model, effort, backend: new ClaudeBackend(qfn) } });
      agent.start("go");
      await agent.waitUntilSettled();
      return captured.effort;
    }
    expect(await effortIn("claude-opus-4-8", "max")).toBe("max"); // supported model + specified
    expect(await effortIn("claude-haiku-4-5", "high")).toBeUndefined(); // Haiku is omitted
    expect(await effortIn("claude-opus-4-8")).toBeUndefined(); // effort not specified
  });

  it("persists its model on start and hot-swaps live via setModel (query.setModel)", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    const setModelCalls: string[] = [];
    const agent = new Worker({
      id: "a1",
      sessionId: "s1",
      repoPath: "/r",
      label: "t",
      deps: {
        repos,
        bus: new EventBus(),
        model: "claude-opus-4-8",
        backend: fakeBackend([{ type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "s" }], { onSetModel: (m) => setModelCalls.push(m) }),
      },
    });
    agent.start("go");
    await agent.waitUntilSettled();
    expect(repos.getWorker("a1")?.model).toBe("claude-opus-4-8"); // persisted on start

    await agent.setModel("claude-sonnet-4-6");
    expect(repos.getWorker("a1")?.model).toBe("claude-sonnet-4-6"); // persisted update
    expect(setModelCalls).toEqual(["claude-sonnet-4-6"]); // forwarded to the live query
  });

  it("constructs the query with the injected permissionMode and setPermissionMode hot-swaps it (mirrors setModel)", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    const setPermissionModeCalls: string[] = [];
    let captured: { permissionMode?: string } = {};
    const inner = fakeQuery([{ type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "s" }], { onSetPermissionMode: (m) => setPermissionModeCalls.push(m) });
    const qfn = ((input: { options?: typeof captured }) => {
      captured = input.options ?? {};
      return inner(input as Parameters<typeof inner>[0]);
    }) as typeof inner;
    const agent = new Worker({
      id: "a1",
      sessionId: "s1",
      repoPath: "/r",
      label: "t",
      deps: {
        repos,
        bus: new EventBus(),
        model: "claude-opus-4-8",
        permissionMode: "plan",
        backend: new ClaudeBackend(qfn),
      },
    });
    agent.start("go");
    await agent.waitUntilSettled();
    expect(captured.permissionMode).toBe("plan"); // query constructed with the injected permissionMode
    expect(repos.getWorker("a1")?.permission_mode).toBe("plan"); // persisted on start

    await agent.setPermissionMode("bypassPermissions");
    expect(repos.getWorker("a1")?.permission_mode).toBe("bypassPermissions"); // persisted update
    expect(setPermissionModeCalls).toEqual(["bypassPermissions"]); // forwarded to the live query
  });

  it("stop() does not record an error transcript even if the query throws on abort (Operation aborted)", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    // A fake that throws on abort — mimics the real SDK throwing AbortError("Operation aborted").
    const throwingQuery = ((input: { options?: { abortController?: AbortController } }) => {
      const signal = input.options?.abortController?.signal;
      async function* gen(): AsyncGenerator<unknown> {
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) return reject(new Error("Operation aborted"));
          signal?.addEventListener("abort", () => reject(new Error("Operation aborted")), { once: true });
        });
      }
      return Object.assign(gen(), { interrupt: async () => {}, close: () => {}, supportedCommands: async () => [], setModel: async () => {} });
    }) as QueryFn;
    const agent = new Worker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t", deps: { repos, bus: new EventBus(), model: "m", backend: new ClaudeBackend(throwingQuery) } });
    agent.start("go");
    await new Promise((r) => setTimeout(r, 0)); // let consume start consuming the query
    await agent.stop();
    expect(repos.listWorkerEvents("a1").some((e) => e.type === "error")).toBe(false); // abort does not leave an error
    expect(agent.status()).toBe("stopped");
  });

  it("start() without a task waits idle (no first turn, no recorded user message)", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/repo/a", label: "task" });
    const bus = new EventBus();
    const onTurnStart = vi.fn();
    // Use a streaming fake that stays alive until closed (like real SDK — doesn't settle until queue closed)
    const agent = new Worker({
      id: "a1",
      sessionId: "s1",
      repoPath: "/repo/a",
      label: "task",
      deps: {
        repos,
        bus,
        model: "test-model",
        onTurnStart,
        backend: fakeBackend([
          { type: "assistant", text: "done" },
          { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" },
        ]),
      },
    });

    // start() without a task → should be idle, no user message recorded
    agent.start();
    expect(agent.status()).toBe("idle");
    expect(onTurnStart).not.toHaveBeenCalled();
    const eventsAfterStart = repos.listWorkerEvents("a1");
    expect(eventsAfterStart.filter((e) => e.type === "message")).toHaveLength(0);

    // send("first instruction") → records the message + transitions to running
    agent.send("first instruction");
    expect(onTurnStart).toHaveBeenCalledTimes(1); // checkpoint triggered on first send
    // After send, the message is recorded immediately (idle send path)
    const eventsAfterSend = repos.listWorkerEvents("a1");
    expect(eventsAfterSend.some((e) => e.type === "message" && (JSON.parse(e.payload_json) as { role?: string; content?: string }).content === "first instruction")).toBe(true);
    await agent.waitUntilSettled();
  });

  it("start(task) still pushes the task and runs (unchanged)", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/repo/a", label: "task" });
    const bus = new EventBus();
    const onTurnStart = vi.fn();
    const agent = new Worker({
      id: "a1",
      sessionId: "s1",
      repoPath: "/repo/a",
      label: "task",
      deps: {
        repos,
        bus,
        model: "test-model",
        onTurnStart,
        backend: fakeBackend([
          { type: "assistant", text: "done" },
          { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" },
        ]),
      },
    });

    agent.start("do it");
    // The task message is recorded immediately and the agent is running
    expect(onTurnStart).toHaveBeenCalledTimes(1);
    const events = repos.listWorkerEvents("a1");
    expect(events.some((e) => e.type === "message" && (JSON.parse(e.payload_json) as { role?: string; content?: string }).content === "do it")).toBe(true);
    await agent.waitUntilSettled();
    expect(agent.status()).toBe("stopped"); // natural fake-stream end lands stopped (done retired 2026-07-11)
  });

  it("calls onTurnStart before each turn (start + send) for checkpointing", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    const onTurnStart = vi.fn();
    // Not a streaming fake that ends only when input closes; instead it drops to idle and stays alive — so after start it goes idle and send is possible.
    const agent = new Worker({
      id: "a1", sessionId: "s1", repoPath: "/r", label: "t",
      deps: { repos, bus: new EventBus(), model: "m", onTurnStart, backend: fakeBackend([{ type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "s" }]) },
    });
    agent.start("go");
    await agent.waitUntilSettled();
    expect(onTurnStart).toHaveBeenCalledTimes(1); // start
  });

  it("send() throws once the agent is stopped (control contract)", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    const agent = new Worker({
      id: "a1",
      sessionId: "s1",
      repoPath: "/r",
      label: "t",
      deps: { repos, bus: new EventBus(), model: "m", backend: fakeBackend([]) },
    });
    agent.start("go");
    await agent.stop();
    expect(() => agent.send("more")).toThrow(/not running/i);
  });

  it("defers a mid-turn user message until the current turn's result boundary (A: ordering)", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // turn0 stops at the gate just before its result → reproduces a mid-turn situation where send() arrives in the meantime.
    const gated = ((input: { prompt?: AsyncIterable<{ message?: { content?: unknown } }> }) => {
      const prompt = input.prompt!;
      async function* gen(): AsyncGenerator<unknown> {
        let turn = 0;
        for await (const um of prompt) {
          const c = um?.message?.content; const text = typeof c === "string" ? c : "";
          yield { type: "assistant", parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: `reply:${text}` }] } };
          if (turn === 0) await gate; // only turn0 stops before its result
          yield { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: `sdk-${turn}` };
          turn++;
        }
      }
      return Object.assign(gen(), { interrupt: async () => {}, close: () => {}, supportedCommands: async () => [], setModel: async () => {} });
    }) as QueryFn;

    const agent = new Worker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t", deps: { repos, bus: new EventBus(), model: "m", backend: new ClaudeBackend(gated) } });
    agent.start("task");
    // Wait until turn0's assistant is recorded (= just before the gate).
    await until(() => repos.listWorkerEvents("a1").some((e) => e.type === "message" && (JSON.parse(e.payload_json) as { content?: string }).content === "reply:task"));
    // mid-turn send — turn0 still in progress (running).
    agent.send("msg1");
    // Must be deferred: inside the gate, the msg1 echo is not in the transcript yet.
    expect(repos.listWorkerEvents("a1").some((e) => (JSON.parse(e.payload_json) as { content?: string }).content === "msg1")).toBe(false);
    release();
    await until(() => agent.status() === "idle"); // idle once all follow-up turns finish (the deferred message blocks the idle transition at the turn0 boundary).
    const order = repos.listWorkerEvents("a1").map((e) => {
      const p = JSON.parse(e.payload_json) as { role?: string; content?: string; subtype?: string };
      return p.role === "user" ? `U:${p.content}` : `${e.type}:${p.content ?? p.subtype ?? ""}`;
    });
    // task → turn0 reply → turn0 result → msg1 (after the boundary!) → turn1 reply → turn1 result
    expect(order).toEqual(["U:task", "message:reply:task", "result:success", "U:msg1", "message:reply:msg1", "result:success"]);
  });

  it("flushes multiple mid-turn messages in FIFO order, each before its own turn", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const gated = ((input: { prompt?: AsyncIterable<{ message?: { content?: unknown } }> }) => {
      const prompt = input.prompt!;
      async function* gen(): AsyncGenerator<unknown> {
        let turn = 0;
        for await (const um of prompt) {
          const c = um?.message?.content; const text = typeof c === "string" ? c : "";
          yield { type: "assistant", parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: `reply:${text}` }] } };
          if (turn === 0) await gate; // stop only turn0 so both messages arrive mid-turn.
          yield { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: `sdk-${turn}` };
          turn++;
        }
      }
      return Object.assign(gen(), { interrupt: async () => {}, close: () => {}, supportedCommands: async () => [], setModel: async () => {} });
    }) as QueryFn;
    const agent = new Worker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t", deps: { repos, bus: new EventBus(), model: "m", backend: new ClaudeBackend(gated) } });
    agent.start("task");
    await until(() => repos.listWorkerEvents("a1").some((e) => e.type === "message" && (JSON.parse(e.payload_json) as { content?: string }).content === "reply:task"));
    agent.send("m1");
    agent.send("m2"); // both arrive while turn0 is in progress → deferred
    release();
    await until(() => agent.status() === "idle");
    const order = repos.listWorkerEvents("a1").map((e) => {
      const p = JSON.parse(e.payload_json) as { role?: string; content?: string; subtype?: string };
      return p.role === "user" ? `U:${p.content}` : `${e.type}:${p.content ?? p.subtype ?? ""}`;
    });
    // Each message right before its own turn: m1 → turn1, m2 → turn2.
    expect(order).toEqual(["U:task", "message:reply:task", "result:success", "U:m1", "message:reply:m1", "result:success", "U:m2", "message:reply:m2", "result:success"]);
  });

  it("carries clientMsgId on the live user echo event (for desktop pending reconcile)", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    const bus = new EventBus();
    const events: CoreEvent[] = [];
    bus.subscribe("s1", (e) => events.push(e));
    const agent = new Worker({
      id: "a1", sessionId: "s1", repoPath: "/r", label: "t",
      deps: { repos, bus, model: "m", backend: fakeStreamingBackend((text) => [{ type: "assistant", text: `reply:${text}` }, { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "s" }]) },
    });
    agent.start("task");
    await until(() => agent.status() === "idle"); // turn0 ends → idle
    agent.send("msg1", "cmid-1"); // idle send: recorded immediately + clientMsgId attached
    await until(() => agent.status() === "idle");
    const echo = events.find((e) => e.type === "worker.event" && (e as { data?: { kind?: string; role?: string; content?: string } }).data?.kind === "message" && (e as { data?: { role?: string } }).data?.role === "user" && (e as { data?: { content?: string } }).data?.content === "msg1");
    expect((echo as { clientMsgId?: string } | undefined)?.clientMsgId).toBe("cmid-1");
  });

  it("persists coalesced thinking so worker reasoning survives reload (A5, master parity)", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    const bus = new EventBus();
    const live: CoreEvent[] = [];
    bus.subscribe("s1", (e) => live.push(e));
    const agent = new Worker({
      id: "a1", sessionId: "s1", repoPath: "/r", label: "t",
      deps: { repos, bus, model: "m", backend: fakeBackend([
        { type: "thinking", text: "let me " },
        { type: "thinking", text: "reason" },
        { type: "assistant", text: "answer" },
        { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "s" },
      ]) },
    });
    agent.start("task");
    await agent.waitUntilSettled();
    // Persisted: one coalesced thinking entry remains in worker_events and is restored on reload (seedWorkerHistory).
    const th = repos.listWorkerEvents("a1").filter((e) => e.type === "thinking");
    expect(th).toHaveLength(1);
    expect((JSON.parse(th[0].payload_json) as { text: string }).text).toBe("let me reason");
    // Live: thinking flows only as deltas (coalesced thinking is not emitted) → no duplicates.
    const liveThinkingEvents = live.filter((e) => e.type === "worker.event" && (e as { data?: { kind?: string } }).data?.kind === "thinking");
    expect(liveThinkingEvents).toHaveLength(0);
  });

  it("preserves system message text from top-level fields", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    const agent = new Worker({
      id: "a1",
      sessionId: "s1",
      repoPath: "/r",
      label: "t",
      deps: {
        repos,
        bus: new EventBus(),
        model: "m",
        backend: fakeBackend([{ type: "system", text: "session init" }]),
      },
    });
    agent.start("go");
    await agent.waitUntilSettled();
    const sys = repos.listWorkerEvents("a1").find((e) => e.type === "system");
    expect(sys && (JSON.parse(sys.payload_json) as { text: string }).text).toBe("session init");
  });

  it("emits result with cumulative cost/turns + context telemetry", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    const bus = new EventBus();
    const events: CoreEvent[] = [];
    bus.subscribe("s1", (e) => events.push(e));

    const agent = new Worker({
      id: "a1",
      sessionId: "s1",
      repoPath: "/r",
      label: "t",
      deps: {
        repos,
        bus,
        model: "test-model",
        backend: fakeBackend([
          // message_start gives us per-request usage (50000 input tokens)
          { type: "message_start", usage: { input_tokens: 50000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
          { type: "assistant", text: "working" },
          {
            type: "result",
            subtype: "success",
            total_cost_usd: 0.5,
            num_turns: 3,
            session_id: "sdk-1",
            duration_ms: 1200,
            modelUsage: { "claude-opus-4-8": { contextWindow: 200000 } },
          },
        ]),
      },
    });

    agent.start("do the task");
    await agent.waitUntilSettled();

    const resultEvents = events.filter((e) => e.type === "worker.event" && e.data.kind === "result");
    expect(resultEvents.length).toBe(1);
    const resultData = (resultEvents[0] as Extract<CoreEvent, { type: "worker.event" }>).data as Extract<typeof resultData, { kind: "result" }>;
    expect(resultData.kind).toBe("result");
    expect(resultData.costUsd).toBe(0.5); // cumulative
    expect(resultData.numTurns).toBe(3); // cumulative
    expect(resultData.durationMs).toBe(1200);
    expect(resultData.contextTokens).toBe(50000); // from message_start
    expect(resultData.contextWindow).toBe(200000); // from modelUsage
  });

  it("records terminalReason on the result event and notices dead-turn reasons", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    const agent = new Worker({
      id: "a1",
      sessionId: "s1",
      repoPath: "/r",
      label: "t",
      deps: {
        repos,
        bus: new EventBus(),
        model: "test-model",
        backend: fakeBackend([
          { type: "assistant", text: "x" },
          { type: "result", subtype: "success", total_cost_usd: 0.1, num_turns: 1, session_id: "s", terminal_reason: "model_error" },
        ]),
      },
    });

    agent.start("do the task");
    await agent.waitUntilSettled();

    const persisted = repos.listWorkerEvents("a1");
    const resultEvent = persisted.find((e) => e.type === "result");
    expect((JSON.parse(resultEvent!.payload_json) as { terminalReason?: string }).terminalReason).toBe("model_error");
    const notices = persisted.filter((e) => e.type === "notice");
    expect(notices.some((e) => (JSON.parse(e.payload_json) as { text?: string }).text === "Turn ended abnormally (model_error).")).toBe(true);
  });

  it("does not notice benign terminal reasons", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    const agent = new Worker({
      id: "a1",
      sessionId: "s1",
      repoPath: "/r",
      label: "t",
      deps: {
        repos,
        bus: new EventBus(),
        model: "test-model",
        backend: fakeBackend([
          { type: "assistant", text: "x" },
          { type: "result", subtype: "success", total_cost_usd: 0.1, num_turns: 1, session_id: "s", terminal_reason: "aborted_streaming" },
        ]),
      },
    });

    agent.start("do the task");
    await agent.waitUntilSettled();

    const persisted = repos.listWorkerEvents("a1");
    const resultEvent = persisted.find((e) => e.type === "result");
    // aborted_streaming is an intentional interrupt: carried for display, but never a dead-turn notice.
    expect((JSON.parse(resultEvent!.payload_json) as { terminalReason?: string }).terminalReason).toBe("aborted_streaming");
    const notices = persisted.filter((e) => e.type === "notice");
    expect(notices.some((e) => (JSON.parse(e.payload_json) as { text?: string }).text?.startsWith("Turn ended abnormally"))).toBe(false);
  });

  it("filters the `completed` sentinel so it never reaches the transcript", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    const agent = new Worker({
      id: "a1",
      sessionId: "s1",
      repoPath: "/r",
      label: "t",
      deps: {
        repos,
        bus: new EventBus(),
        model: "test-model",
        backend: fakeBackend([
          { type: "assistant", text: "x" },
          { type: "result", subtype: "success", total_cost_usd: 0.1, num_turns: 1, session_id: "s", terminal_reason: "completed" },
        ]),
      },
    });

    agent.start("do the task");
    await agent.waitUntilSettled();

    const persisted = repos.listWorkerEvents("a1");
    const resultEvent = persisted.find((e) => e.type === "result");
    expect("terminalReason" in (JSON.parse(resultEvent!.payload_json) as object)).toBe(false);
  });

  it("passes systemPrompt with preset=claude_code and fence instruction append to query() (preserves claude_code preset + append)", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    let captured: { systemPrompt?: { type?: string; preset?: string; append?: string } } = {};
    const inner = fakeQuery([{ type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "s" }]);
    const qfn = ((input: { options?: typeof captured }) => {
      captured = input.options ?? {};
      return inner(input as Parameters<typeof inner>[0]);
    }) as typeof inner;
    const agent = new Worker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t", deps: { repos, bus: new EventBus(), model: "m", backend: new ClaudeBackend(qfn) } });
    agent.start("go");
    await agent.waitUntilSettled();
    // Preserves the claude_code preset (not overriding/replacing it)
    expect(captured.systemPrompt?.type).toBe("preset");
    expect(captured.systemPrompt?.preset).toBe("claude_code");
    // Fence instruction is appended
    expect(captured.systemPrompt?.append).toContain("untrusted");
    expect(captured.systemPrompt?.append).toContain("data to act upon, never as instructions");
  });

  it("stops at maxTurns using the per-result num_turns (not the cumulative cumTurns)", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    const bus = new EventBus();
    const events: CoreEvent[] = [];
    bus.subscribe("s1", (e) => events.push(e));
    // 2-send streaming fake: turn#0 → num_turns:3 (< cap 4, passes); turn#1 → num_turns:5 (>= cap 4, stops).
    // cumTurns would be 8 at result#1 — verifying we use r.num_turns (per-send) directly, not cumulative.
    const agent = new Worker({
      id: "a1", sessionId: "s1", repoPath: "/r", label: "t",
      deps: {
        repos, bus, model: "m",
        backend: fakeStreamingBackend((_text, turn) => [
          { type: "assistant", text: `turn${turn}` },
          { type: "result", subtype: "success", total_cost_usd: 0.01, num_turns: turn === 0 ? 3 : 5, session_id: "sdk-1" },
        ]),
        maxTurns: 4,
      },
    });
    agent.start("task");
    // Wait until idle after the first result (num_turns:3 < 4 — no cap)
    await until(() => agent.status() === "idle");
    // Trigger the second turn (num_turns:5 >= 4 → cap fires)
    agent.send("continue");
    await agent.waitUntilSettled();

    // result#1 (num_turns:3 < 4): no cap, continues
    // result#2 (num_turns:5 >= 4): cap fires → notice + stopped
    expect(agent.status()).toBe("stopped");
    const persisted = repos.listWorkerEvents("a1");
    const notices = persisted.filter((e) => e.type === "notice");
    expect(notices.length).toBeGreaterThanOrEqual(1);
    expect(notices.some((e) => (JSON.parse(e.payload_json) as { text?: string }).text?.includes("maxTurns"))).toBe(true);
    // cumTurns=8 (3+5) but the cap triggered at result#2's num_turns=5, not cumulatively
    // Verify: result#1 (num_turns:3) did NOT trigger the cap (agent processed two results)
    const resultEvents = persisted.filter((e) => e.type === "result");
    expect(resultEvents.length).toBe(2); // both results were processed before stop
  });

  it("no maxTurns (undefined) → never caps", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    const agent = new Worker({
      id: "a1", sessionId: "s1", repoPath: "/r", label: "t",
      deps: {
        repos, bus: new EventBus(), model: "m",
        backend: fakeBackend([
          { type: "assistant", text: "done" },
          { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 100, session_id: "s" },
        ]),
        // maxTurns: undefined (not set)
      },
    });
    agent.start("task");
    await agent.waitUntilSettled();
    expect(agent.status()).toBe("stopped"); // natural fake-stream end (done retired 2026-07-11) — NOT the cap path (no cap notice)
  });

  it("stops at costBudgetUsd once cumCostUsd (lifetime) crosses it, across turns (mirror maxTurns)", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    const bus = new EventBus();
    const events: CoreEvent[] = [];
    bus.subscribe("s1", (e) => events.push(e));
    // turn#0 costs 0.4 (cumCostUsd=0.4 < budget 1.0 — passes); turn#1 costs 0.7 (cumCostUsd=1.1 >= 1.0 — stops).
    const agent = new Worker({
      id: "a1", sessionId: "s1", repoPath: "/r", label: "t",
      deps: {
        repos, bus, model: "m",
        backend: fakeStreamingBackend((_text, turn) => [
          { type: "assistant", text: `turn${turn}` },
          { type: "result", subtype: "success", total_cost_usd: turn === 0 ? 0.4 : 0.7, num_turns: 1, session_id: "sdk-1" },
        ]),
        costBudgetUsd: 1.0,
      },
    });
    agent.start("task");
    await until(() => agent.status() === "idle"); // after turn#0: cumCostUsd=0.4 < 1.0 — no stop
    agent.send("continue"); // turn#1: cumCostUsd=1.1 >= 1.0 — cost budget fires
    await agent.waitUntilSettled();

    expect(agent.status()).toBe("stopped");
    const persisted = repos.listWorkerEvents("a1");
    const notices = persisted.filter((e) => e.type === "notice");
    expect(notices.some((e) => (JSON.parse(e.payload_json) as { text?: string }).text?.includes("Cost budget reached"))).toBe(true);
    const resultEvents = persisted.filter((e) => e.type === "result");
    expect(resultEvents.length).toBe(2); // both results were processed before stop
  });

  it("no costBudgetUsd (undefined) → never stops even at high cumulative cost", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    const agent = new Worker({
      id: "a1", sessionId: "s1", repoPath: "/r", label: "t",
      deps: {
        repos, bus: new EventBus(), model: "m",
        backend: fakeBackend([
          { type: "assistant", text: "done" },
          { type: "result", subtype: "success", total_cost_usd: 999, num_turns: 1, session_id: "s" },
        ]),
        // costBudgetUsd: undefined (not set)
      },
    });
    agent.start("task");
    await agent.waitUntilSettled();
    expect(agent.status()).toBe("stopped"); // natural fake-stream end (done retired) — NOT the budget path (no budget notice)
  });

  it("maxTurns + costBudgetUsd both set, cost crosses while maxTurns does not that turn → stops via cost budget", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    const agent = new Worker({
      id: "a1", sessionId: "s1", repoPath: "/r", label: "t",
      deps: {
        repos, bus: new EventBus(), model: "m",
        backend: fakeBackend([
          { type: "assistant", text: "done" },
          { type: "result", subtype: "success", total_cost_usd: 1.5, num_turns: 2, session_id: "s" }, // cost crosses (>=1.0), turns doesn't (<100)
        ]),
        maxTurns: 100,
        costBudgetUsd: 1.0,
      },
    });
    agent.start("task");
    await agent.waitUntilSettled();
    expect(agent.status()).toBe("stopped");
    const notices = repos.listWorkerEvents("a1").filter((e) => e.type === "notice");
    expect(notices.some((e) => (JSON.parse(e.payload_json) as { text?: string }).text?.includes("Cost budget reached"))).toBe(true);
    expect(notices.some((e) => (JSON.parse(e.payload_json) as { text?: string }).text?.includes("Turn cap reached"))).toBe(false);
  });

  it("maxTurns + costBudgetUsd both cross in the SAME turn → maxTurns (checked first) wins; the cost-budget check is not reached that turn", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    const agent = new Worker({
      id: "a1", sessionId: "s1", repoPath: "/r", label: "t",
      deps: {
        repos, bus: new EventBus(), model: "m",
        backend: fakeBackend([
          { type: "assistant", text: "done" },
          { type: "result", subtype: "success", total_cost_usd: 2.0, num_turns: 5, session_id: "s" }, // both maxTurns (>=3) and cost (>=1.0) cross
        ]),
        maxTurns: 3,
        costBudgetUsd: 1.0,
      },
    });
    agent.start("task");
    await agent.waitUntilSettled();
    expect(agent.status()).toBe("stopped");
    const notices = repos.listWorkerEvents("a1").filter((e) => e.type === "notice");
    // The maxTurns cap block returns before the cost-budget check runs, so only ONE notice is recorded.
    expect(notices.length).toBe(1);
    expect((JSON.parse(notices[0]!.payload_json) as { text?: string }).text).toContain("Turn cap reached");
  });

  it("interruptTurn() clears deferred queue — no ghost turn, emits dropped notice with clientMsgId, worker lands idle", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    const bus = new EventBus();
    const events: CoreEvent[] = [];
    bus.subscribe("s1", (e) => events.push(e));

    let releaseInterrupt!: () => void;
    const interruptGate = new Promise<void>((r) => { releaseInterrupt = r; });
    let interruptCalls = 0;

    // A streaming fake that: (1) yields an assistant message, (2) waits at interruptGate before result,
    // so we can call send() + interruptTurn() while turn0 is in progress, then (3) yields result.
    const gatedQuery = ((input: { prompt?: AsyncIterable<{ message?: { content?: unknown } }> }) => {
      const prompt = input.prompt!;
      async function* gen(): AsyncGenerator<unknown> {
        for await (const _um of prompt) {
          yield { type: "assistant", parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: "working" }] } };
          await interruptGate; // wait here — interrupted before result
          yield { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1", parent_tool_use_id: null };
        }
      }
      return Object.assign(gen(), {
        interrupt: async () => { interruptCalls++; releaseInterrupt(); }, // unblock the gate so result flows
        close: () => {},
        supportedCommands: async () => [],
        setModel: async () => {},
      });
    }) as QueryFn;

    const agent = new Worker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t", deps: { repos, bus, model: "m", backend: new ClaudeBackend(gatedQuery) } });
    agent.start("task");

    // Wait until the assistant message is recorded (= turn0 is mid-flight at the gate)
    await until(() => repos.listWorkerEvents("a1").some((e) => e.type === "message" && (JSON.parse(e.payload_json) as { content?: string }).content === "working"));

    // Deferred instruction arrives while turn0 is still running
    agent.send("ghost instruction", "cmid-ghost");
    expect(agent.status()).toBe("running"); // still running

    // interruptTurn() — must clear deferred BEFORE awaiting interrupt
    await agent.interruptTurn();
    expect(interruptCalls).toBe(1);

    // Wait for the result boundary and for the worker to land idle
    await until(() => agent.status() === "idle");

    // Ghost instruction must NOT have been recorded as a user message
    const persisted = repos.listWorkerEvents("a1");
    expect(persisted.some((e) => e.type === "message" && (JSON.parse(e.payload_json) as { content?: string }).content === "ghost instruction")).toBe(false);

    // A dropped notice must have been emitted with the clientMsgId
    const noticeEvents = events.filter(
      (e) => e.type === "worker.event" && (e as { data?: { kind?: string; text?: string } }).data?.kind === "notice" &&
      (e as { data?: { text?: string } }).data?.text?.includes("Dropped deferred instruction (interrupted)")
    );
    expect(noticeEvents.length).toBe(1);
    expect((noticeEvents[0] as { clientMsgId?: string }).clientMsgId).toBe("cmid-ghost");

    // Also persisted in the DB
    const dbNotices = persisted.filter((e) => e.type === "notice" && (JSON.parse(e.payload_json) as { text?: string }).text?.includes("Dropped deferred instruction (interrupted)"));
    expect(dbNotices.length).toBe(1);

    await agent.stop();
  });

  it("interruptTurn() returns the SDK's interrupt receipt and records a notice with the still-queued count", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    const agent = new Worker({
      id: "a1", sessionId: "s1", repoPath: "/r", label: "t",
      deps: { repos, bus: new EventBus(), model: "m", backend: fakeStreamingBackend((_t) => [
        { type: "assistant", text: "ok" },
        { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" },
      ], { stillQueued: ["u1", "u2"] }) },
    });
    agent.start("go");
    await until(() => agent.status() === "idle");

    const receipt = await agent.interruptTurn();
    expect(receipt).toEqual({ stillQueued: ["u1", "u2"] });

    const notices = repos.listWorkerEvents("a1").filter(
      (e) => e.type === "notice" && (JSON.parse(e.payload_json) as { text?: string }).text === "Interrupt receipt: 2 queued message(s) may still run.",
    );
    expect(notices.length).toBe(1);

    await agent.stop();
  });

  it("interruptTurn() records NO 'Interrupt receipt' notice when stillQueued is empty/undefined", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    const agent = new Worker({
      id: "a1", sessionId: "s1", repoPath: "/r", label: "t",
      deps: { repos, bus: new EventBus(), model: "m", backend: fakeStreamingBackend((_t) => [
        { type: "assistant", text: "ok" },
        { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" },
      ]) }, // no stillQueued opt → interrupt() resolves undefined
    });
    agent.start("go");
    await until(() => agent.status() === "idle");

    const receipt = await agent.interruptTurn();
    expect(receipt).toBeUndefined();

    const notices = repos.listWorkerEvents("a1").filter(
      (e) => e.type === "notice" && (JSON.parse(e.payload_json) as { text?: string }).text?.startsWith("Interrupt receipt:"),
    );
    expect(notices.length).toBe(0);

    await agent.stop();
  });

  it("stop() clears deferred queue — emits 2 dropped notices after loop drains (no seq-interleave with consume loop)", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    const bus = new EventBus();
    const events: CoreEvent[] = [];
    bus.subscribe("s1", (e) => events.push(e));

    let releaseConsume!: () => void;
    const consumeGate = new Promise<void>((r) => { releaseConsume = r; });

    // A streaming fake that blocks after the assistant message (before result) so stop() can be called mid-turn.
    const gatedQuery = ((input: { prompt?: AsyncIterable<{ message?: { content?: unknown } }> }) => {
      const prompt = input.prompt!;
      async function* gen(): AsyncGenerator<unknown> {
        for await (const _um of prompt) {
          yield { type: "assistant", parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: "working" }] } };
          await consumeGate; // blocked until stop's abort fires
          yield { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1", parent_tool_use_id: null };
        }
      }
      return Object.assign(gen(), {
        interrupt: async () => { releaseConsume(); }, // release the gate when interrupted (by stop)
        close: () => {},
        supportedCommands: async () => [],
        setModel: async () => {},
      });
    }) as QueryFn;

    const agent = new Worker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t", deps: { repos, bus, model: "m", backend: new ClaudeBackend(gatedQuery) } });
    agent.start("task");

    // Wait until turn0's assistant is recorded (mid-turn)
    await until(() => repos.listWorkerEvents("a1").some((e) => e.type === "message" && (JSON.parse(e.payload_json) as { content?: string }).content === "working"));

    // Enqueue 2 deferred instructions
    agent.send("dropped-1");
    agent.send("dropped-2");
    expect(agent.status()).toBe("running");

    // stop() — transitions to stopped, then after await loop, emits dropped notices
    await agent.stop();
    expect(agent.status()).toBe("stopped");

    // Neither deferred instruction should have been recorded as a user message
    const persisted = repos.listWorkerEvents("a1");
    expect(persisted.some((e) => e.type === "message" && (JSON.parse(e.payload_json) as { content?: string }).content === "dropped-1")).toBe(false);
    expect(persisted.some((e) => e.type === "message" && (JSON.parse(e.payload_json) as { content?: string }).content === "dropped-2")).toBe(false);

    // 2 dropped notices emitted (after loop drains — after worker.status:stopped)
    const droppedNotices = events.filter(
      (e) => e.type === "worker.event" && (e as { data?: { kind?: string; text?: string } }).data?.kind === "notice" &&
      (e as { data?: { text?: string } }).data?.text?.includes("Dropped deferred instruction (stopped)")
    );
    expect(droppedNotices.length).toBe(2);

    // The stopped status event must come BEFORE the dropped notices (no seq-interleave with consume loop)
    const stoppedIdx = events.findIndex((e) => e.type === "worker.status" && (e as { status?: string }).status === "stopped");
    const firstDroppedIdx = events.findIndex(
      (e) => e.type === "worker.event" && (e as { data?: { text?: string } }).data?.kind === "notice" &&
      (e as { data?: { text?: string } }).data?.text?.includes("Dropped deferred instruction (stopped)")
    );
    expect(stoppedIdx).toBeGreaterThanOrEqual(0);
    expect(firstDroppedIdx).toBeGreaterThan(stoppedIdx);
  });

  it("transitions to error (not stuck idle) when the stream dies after a turn ended (non-abort throw while idle)", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    // A live query that completes one turn (worker drops to idle) then the stream dies (throws) — NOT via abort.
    const dyingQuery = ((input: { prompt?: AsyncIterable<{ message?: { content?: unknown } }> }) => {
      const prompt = input.prompt!;
      async function* gen(): AsyncGenerator<unknown> {
        for await (const _um of prompt) {
          yield { type: "assistant", parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: "done turn" }] } };
          yield { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1", parent_tool_use_id: null };
          break; // one turn → worker idle, then fall through and throw
        }
        throw new Error("transport died"); // subprocess/transport dies while the worker sits idle
      }
      return Object.assign(gen(), { interrupt: async () => {}, close: () => {}, supportedCommands: async () => [], setModel: async () => {} });
    }) as QueryFn;
    const agent = new Worker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t", deps: { repos, bus: new EventBus(), model: "m", backend: new ClaudeBackend(dyingQuery) } });
    agent.start("go");
    await agent.waitUntilSettled();
    // Must be a terminal 'error' — otherwise the entry is a zombie (stuck idle, agent never cleared) and a follow-up send wedges it.
    expect(agent.status()).toBe("error");
    expect(repos.getWorker("a1")?.status).toBe("error");
  });

  it("captures sdk_session_id from the init system message (so an interrupt before the first result still resumes)", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    // A turn that emits the init system message (carrying session_id) and ends WITHOUT a result — mimics stop before the first result.
    const initOnly = (() => {
      async function* gen(): AsyncGenerator<unknown> {
        yield { type: "system", subtype: "init", session_id: "wsdk-init-1", parent_tool_use_id: null };
      }
      return Object.assign(gen(), { interrupt: async () => {}, close: () => {}, supportedCommands: async () => [], setModel: async () => {} });
    }) as QueryFn;
    const agent = new Worker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t", deps: { repos, bus: new EventBus(), model: "m", backend: new ClaudeBackend(initOnly) } });
    agent.start("go");
    await agent.waitUntilSettled();
    expect(repos.getWorker("a1")?.sdk_session_id).toBe("wsdk-init-1"); // captured for resume even without a result
  });

  // Regression guard: a mid-turn send() is held in `deferred` (NOT eagerly enqueued — see commit 2e70867),
  // so interruptTurn(), which splices `deferred` before the boundary, can never leak it to the SDK as a ghost turn.
  it("interruptTurn() never runs a deferred mid-turn instruction as a ghost turn", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => { releaseGate = r; });
    const pulled: string[] = []; // every user message the SDK actually consumes from the queue
    const gatedQuery = ((input: { prompt?: AsyncIterable<{ message?: { content?: unknown } }> }) => {
      const prompt = input.prompt!;
      async function* gen(): AsyncGenerator<unknown> {
        let turn = 0;
        for await (const um of prompt) {
          const c = um?.message?.content; const text = typeof c === "string" ? c : "";
          pulled.push(text);
          yield { type: "assistant", parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: `reply:${text}` }] } };
          if (turn === 0) await gate; // hold turn0 open (worker running) so a mid-turn send() is deferred
          yield { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1", parent_tool_use_id: null };
          turn++;
        }
      }
      return Object.assign(gen(), { interrupt: async () => { releaseGate(); }, close: () => {}, supportedCommands: async () => [], setModel: async () => {} });
    }) as QueryFn;
    const agent = new Worker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t", deps: { repos, bus: new EventBus(), model: "m", backend: new ClaudeBackend(gatedQuery) } });
    agent.start("task");
    await until(() => repos.listWorkerEvents("a1").some((e) => e.type === "message" && (JSON.parse(e.payload_json) as { content?: string }).content === "reply:task"));
    // mid-turn send → echo deferred + message buffered in the MessageQueue (the gen is parked at the gate, not pulling input)
    agent.send("ghost instruction");
    expect(agent.status()).toBe("running");
    // interrupt releases the gate (turn0's result flows). The deferred instruction must NOT run.
    await agent.interruptTurn();
    await until(() => agent.status() === "idle");
    await new Promise((r) => setTimeout(r, 10)); // allow a ghost turn to occur if the deferred message leaked to the SDK
    expect(pulled).toEqual(["task"]); // the deferred instruction was never enqueued/consumed by the SDK
    expect(repos.listWorkerEvents("a1").some((e) => (JSON.parse(e.payload_json) as { content?: string }).content === "reply:ghost instruction")).toBe(false);
    await agent.stop();
  });
});

describe("extractToolUses / extractToolResults", () => {
  it("extracts tool_use blocks from an assistant message", () => {
    const msg = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "ok" },
          { type: "tool_use", id: "t1", name: "mcp__orchestrator__spawn_worker", input: { repoPath: "/r" } },
        ],
      },
    };
    expect(extractToolUses(msg)).toEqual([
      { id: "t1", name: "mcp__orchestrator__spawn_worker", input: { repoPath: "/r" } },
    ]);
    expect(extractToolResults(msg)).toEqual([]);
  });

  it("extracts tool_result blocks from a user message with is_error", () => {
    const msg = {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", is_error: true, content: "boom" },
          { type: "tool_result", tool_use_id: "t2", content: "ok" },
        ],
      },
    };
    expect(extractToolResults(msg)).toEqual([
      { toolUseId: "t1", isError: true, content: "boom" },
      { toolUseId: "t2", isError: false, content: "ok" },
    ]);
  });

  it("returns [] for messages without array content", () => {
    expect(extractToolUses({ type: "system", subtype: "init" })).toEqual([]);
    expect(extractToolResults({ message: { content: "plain" } })).toEqual([]);
  });
});

// ── Background-aware state machine (2026-07-11 redesign): running / background / idle derived from
//    turnActive + running bg-task set. Design: docs/superpowers/specs/2026-07-11-worker-state-graph-design.md ──
describe("Worker background state machine", () => {
  function mk(responder: Parameters<typeof fakeStreamingBackend>[0], opts?: { settleGraceMs?: number }) {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    const bus = new EventBus();
    const statusEvents: Array<{ status: string; bg?: { count: number; types: string[] } }> = [];
    bus.subscribe("s1", (e) => { if (e.type === "worker.status") statusEvents.push({ status: e.status, ...(e.bg ? { bg: e.bg } : {}) }); });
    // settleGraceMs: short by default so no-wake tests resolve fast; wake tests arrive synchronously anyway.
    const agent = new Worker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t", deps: { repos, bus, model: "m", backend: fakeStreamingBackend(responder), settleGraceMs: opts?.settleGraceMs ?? 15 } });
    return { repos, bus, statusEvents, agent };
  }

  it("turn_end with a running bg task → background (with bg payload); settle → idle (시킨 일 다 함)", async () => {
    const x = mk(() => [
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 9", run_in_background: true } },
      { type: "task_started", id: "bg1", taskType: "local_bash" },
      { type: "tool_result", id: "t1", content: "Command running in background with ID: bg1" },
      { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" },
      { type: "task_notification", id: "bg1", status: "completed" },
    ]);
    x.agent.start("go");
    await until(() => x.agent.status() === "idle");
    const seq = x.statusEvents.map((s) => s.status);
    expect(seq).toEqual(["background", "idle"]); // NOT idle at turn_end — bg still ran
    // the background event carries why (count + task types) for UI labeling
    expect(x.statusEvents[0]!.bg).toEqual({ count: 1, types: ["local_bash"] });
    expect(x.repos.getWorker("a1")!.status).toBe("idle");
    await x.agent.stop();
  });

  it("settle double-fire (task_updated completed + task_notification) is deduped — single background→idle", async () => {
    const x = mk(() => [
      { type: "task_started", id: "bg1", taskType: "local_bash" },
      { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" },
      { type: "task_updated", id: "bg1", status: "completed" },
      { type: "task_notification", id: "bg1", status: "completed" }, // second settle for the same id — no-op
    ]);
    x.agent.start("go");
    await until(() => x.agent.status() === "idle");
    expect(x.statusEvents.map((s) => s.status)).toEqual(["background", "idle"]);
    await x.agent.stop();
  });

  it("auto-wake: model activity after the settle goes background → running with NO send() and NO transient idle (settle-grace)", async () => {
    const x = mk(() => [
      { type: "task_started", id: "bg1", taskType: "local_bash" },
      { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" },
      { type: "task_notification", id: "bg1", status: "completed" },
      { type: "assistant", text: "bg finished — processed its output" }, // the SDK's spontaneous non-human wake turn
      { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" },
    ]);
    x.agent.start("go");
    // The streaming fake yields all turn-0 steps then waits for the next input (queue stays open — the live
    // lifecycle), so observe the status sequence rather than awaiting a natural end.
    await until(() => x.statusEvents.length >= 3);
    // background (bg running) → running (wake turn — the settle-grace held "background", NO transient idle) → idle
    expect(x.statusEvents.map((s) => s.status)).toEqual(["background", "running", "idle"]);
    // the wake turn's output landed in the transcript
    const persisted = x.repos.listWorkerEvents("a1").map((e) => JSON.parse(e.payload_json) as { content?: string });
    expect(persisted.some((p) => p.content === "bg finished — processed its output")).toBe(true);
    await x.agent.stop();
  });

  it("stop() from background latches stopped; late frames cannot resurrect it", async () => {
    const x = mk(() => [
      { type: "task_started", id: "bg1", taskType: "local_bash" },
      { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" },
    ]);
    x.agent.start("go");
    await until(() => x.agent.status() === "background");
    await x.agent.stop();
    expect(x.agent.status()).toBe("stopped");
    expect(() => x.agent.send("more")).toThrow(); // terminal — control contract unchanged
  });

  it("send() while background starts a turn immediately; turn end returns to background while the task still runs", async () => {
    const x = mk((_text, turn) =>
      turn === 0
        ? [
            { type: "task_started", id: "bg1", taskType: "local_bash" },
            { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" },
          ]
        : [
            { type: "assistant", text: "follow-up handled" },
            { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" },
          ],
    );
    x.agent.start("go");
    await until(() => x.agent.status() === "background");
    x.agent.send("follow-up");
    await until(() => x.statusEvents.filter((s) => s.status === "background").length >= 2, 2000);
    // background → running (send) → background (bg1 never settled)
    expect(x.statusEvents.map((s) => s.status)).toEqual(["background", "running", "background"]);
    await x.agent.stop();
  });

  it("nested-tagged traffic after the turn ends does NOT wake the worker (codex collab child keeps streaming post-turn)", async () => {
    const x = mk(() => [
      { type: "assistant", text: "spawned a child" },
      { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" },
      // codex-native child thread still streaming AFTER the parent turn ended (live-verified 2026-07-11)
      { type: "assistant", text: "child says 42", parentToolUseId: "th-child" },
    ]);
    const nestedEvents: Array<{ parentToolUseId: string }> = [];
    x.bus.subscribe("s1", (e) => { if (e.type === "worker.nested") nestedEvents.push({ parentToolUseId: e.parentToolUseId }); });
    x.agent.start("go");
    await until(() => x.agent.status() === "idle");
    await new Promise((r) => setTimeout(r, 40)); // let the trailing nested frame flow
    expect(x.agent.status()).toBe("idle"); // did NOT flip back to running
    expect(x.statusEvents.map((s) => s.status)).not.toContain("running");
    // the nested frame still reached the panel path
    expect(nestedEvents).toEqual([{ parentToolUseId: "th-child" }]);
    await x.agent.stop();
  });

  it("bg_tasks snapshot while quiescent → background (count from snapshot); snapshot to [] holds background via settle-grace, then idle", async () => {
    const x = mk(() => [
      { type: "bg_tasks", ids: [{ id: "bg1", taskType: "local_bash" }, { id: "bg2", taskType: "agent" }] },
      { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" },
      { type: "bg_tasks", ids: [] }, // membership change → empty snapshot while quiescent
    ]);
    x.agent.start("go");
    await until(() => x.agent.status() === "idle");
    expect(x.statusEvents.map((s) => s.status)).toEqual(["background", "idle"]); // no transient idle blip
    expect(x.statusEvents[0]!.bg).toEqual({ count: 2, types: expect.arrayContaining(["local_bash", "agent"]) });
    await x.agent.stop();
  });

  it("latch: once a bg_tasks snapshot is seen, later task_started/task_notification edge frames for other ids are ignored", async () => {
    const x = mk(() => [
      { type: "bg_tasks", ids: [{ id: "bg1", taskType: "local_bash" }] },
      { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" },
      { type: "task_started", id: "bg2", taskType: "agent" }, // edge frame — must be ignored once latched
      { type: "task_notification", id: "bg1", status: "completed" }, // edge settle for the snapshot's own id — also ignored
    ]);
    x.agent.start("go");
    await until(() => x.agent.status() === "background");
    // give the ignored edge frames a beat to (not) take effect
    await new Promise((r) => setTimeout(r, 40));
    expect(x.agent.status()).toBe("background"); // still background — bg1 was never removed by the ignored edge settle
    expect(x.statusEvents.map((s) => s.status)).toEqual(["background"]); // no extra transitions from the edge frames
    await x.agent.stop();
  });
});

// ── Settle-grace (fix/worker-idle-grace): no transient idle between the last bg settle and the auto-wake ──
describe("Worker settle-grace", () => {
  function mk2(responder: Parameters<typeof fakeStreamingBackend>[0], settleGraceMs: number) {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    const bus = new EventBus();
    const statuses: string[] = [];
    bus.subscribe("s1", (e) => { if (e.type === "worker.status") statuses.push(e.status); });
    const agent = new Worker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t", deps: { repos, bus, model: "m", backend: fakeStreamingBackend(responder), settleGraceMs } });
    return { statuses, agent };
  }

  it("the wake turn's init resolves the grace near-instantly (live: init lands <100ms after the settle)", async () => {
    const x = mk2(() => [
      { type: "task_started", id: "bg1", taskType: "local_bash" },
      { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" },
      { type: "task_notification", id: "bg1", status: "completed" }, // settle → grace armed, background held
      { type: "system", text: "init" }, // the auto-wake turn's init — counts as the wake DURING the grace
      { type: "assistant", text: "processed bg output" },
      { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" },
    ], 60_000); // deliberately huge: the test must resolve via init, never via expiry
    x.agent.start("go");
    await until(() => x.statuses.length >= 3);
    expect(x.statuses).toEqual(["background", "running", "idle"]); // no transient idle
    await x.agent.stop();
  });

  it("no wake within the grace → expiry derives the truthful idle (and only then)", async () => {
    const x = mk2(() => [
      { type: "task_started", id: "bg1", taskType: "local_bash" },
      { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" },
      { type: "task_notification", id: "bg1", status: "completed" }, // settle → grace armed; nothing follows
    ], 30);
    x.agent.start("go");
    await until(() => x.agent.status() === "background");
    expect(x.statuses).toEqual(["background"]); // held — no idle yet
    await until(() => x.agent.status() === "idle", 2000); // grace expired → idle
    expect(x.statuses).toEqual(["background", "idle"]);
    await x.agent.stop();
  });

  it("a bg_tasks snapshot repopulating while the idle-grace timer is armed clears it (no belated idle after the original deadline)", async () => {
    const x = mk2(() => [
      { type: "bg_tasks", ids: [{ id: "bg1", taskType: "local_bash" }] },
      { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" },
      { type: "bg_tasks", ids: [] }, // empty snapshot while quiescent → grace armed, background held
      { type: "bg_tasks", ids: [{ id: "bg2", taskType: "agent" }] }, // repopulates BEFORE expiry → clears the stale grace
    ], 30);
    x.agent.start("go");
    await until(() => x.agent.status() === "background");
    expect(x.statuses).toEqual(["background"]); // repopulation never blipped idle
    await new Promise((r) => setTimeout(r, 80)); // past the original grace deadline
    expect(x.agent.status()).toBe("background"); // the cleared timer never fired a belated idle
    expect(x.statuses).toEqual(["background"]);
    await x.agent.stop();
  });

  it("init OUTSIDE the grace is NOT a wake signal (a boot-time init must not flip a quiescent worker to running)", async () => {
    const x = mk2((_text, turn) =>
      turn === 0
        ? [
            { type: "system", text: "init" }, // session-boot init during the first turn — no grace armed later
            { type: "assistant", text: "hi" },
            { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" },
          ]
        : [],
      30);
    x.agent.start("go");
    await until(() => x.agent.status() === "idle");
    expect(x.statuses).toEqual(["idle"]); // turn ended → idle; the init never re-flipped it to running
    await x.agent.stop();
  });

  it("stop() during the grace latches stopped; the expiry cannot resurrect it", async () => {
    const x = mk2(() => [
      { type: "task_started", id: "bg1", taskType: "local_bash" },
      { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" },
      { type: "task_notification", id: "bg1", status: "completed" },
    ], 25);
    x.agent.start("go");
    await until(() => x.agent.status() === "background");
    await x.agent.stop();
    expect(x.agent.status()).toBe("stopped");
    await new Promise((r) => setTimeout(r, 60)); // let the (cleared) grace window pass
    expect(x.agent.status()).toBe("stopped"); // no late idle
    expect(x.statuses.filter((s) => s === "idle")).toEqual([]);
  });

  it("send() during the grace supersedes the wake-wait (background → running, no idle)", async () => {
    const x = mk2((_text, turn) =>
      turn === 0
        ? [
            { type: "task_started", id: "bg1", taskType: "local_bash" },
            { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" },
            { type: "task_notification", id: "bg1", status: "completed" },
          ]
        : [
            { type: "assistant", text: "follow-up done" },
            { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" },
          ],
      60_000); // huge grace: only send() can move it forward
    x.agent.start("go");
    await until(() => x.agent.status() === "background");
    x.agent.send("follow-up");
    await until(() => x.agent.status() === "idle", 2000);
    expect(x.statuses).toEqual(["background", "running", "idle"]);
    await x.agent.stop();
  });
});

describe("Worker managed capability runtime", () => {
  const managed = (revision: string): ResolvedAgentCapabilities => ({
    revision,
    blocked: false,
    instructions: [],
    skills: [],
    mcpServers: [],
  });

  it("resolves once before opening the stream and confirms the same revision on its first provider event", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/repo", label: "task" });
    const innerQuery = fakeQuery([
      { type: "system", subtype: "init", session_id: "sdk-1" },
      { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" },
    ]);
    const inner = new ClaudeBackend(innerQuery, (capabilities) => ({
      revision: capabilities.revision,
      plugins: [],
      env: {},
      diagnostics: [],
    }));
    let opened: AgentSessionOptions | undefined;
    const backend: AgentBackend = {
      openSession: (input, options) => {
        opened = options;
        return inner.openSession(input, options);
      },
      startTurn: inner.startTurn.bind(inner),
    };
    const resolve = vi.fn(() => managed("worker-revision"));
    const reporter = { setDesired: vi.fn(), setApplied: vi.fn(), setError: vi.fn() };
    const worker = new Worker({
      id: "a1",
      sessionId: "s1",
      repoPath: "/repo",
      label: "task",
      deps: {
        repos,
        bus: new EventBus(),
        backend,
        model: "m",
        managedCapabilities: resolve,
        capabilityRuntime: reporter,
      },
    });

    worker.start("go");
    await worker.waitUntilSettled();

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(opened).toMatchObject({ runtimeKey: "a1", capabilities: { revision: "worker-revision" } });
    const target = { targetKind: "worker", targetId: "a1", sessionId: "s1" };
    expect(reporter.setDesired).toHaveBeenCalledWith(target, "worker-revision", false);
    expect(reporter.setApplied).toHaveBeenCalledTimes(1);
    expect(reporter.setApplied).toHaveBeenCalledWith(target, "worker-revision");
    expect(reporter.setError).not.toHaveBeenCalled();
  });
});
