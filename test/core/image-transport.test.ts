import { it, expect, vi } from "vitest";
import type { AgentBackend } from "../../src/core/agent-backend.js";
import { MasterAgent } from "../../src/core/master-agent.js";
import { Worker } from "../../src/core/worker.js";
import { SideConversationManager } from "../../src/core/side-conversation.js";
import { EventBus } from "../../src/core/events.js";
import { openDb } from "../../src/persistence/db.js";
import { Repositories } from "../../src/persistence/repositories.js";
import { fakeBackend, fakeStreamingBackend } from "../helpers/fake-query.js";
import type { ImageResolver, ImageRef } from "../../src/core/image-input.js";
const ref: ImageRef = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "a.png",
  mediaType: "image/png",
  byteLength: 3,
  width: 1,
  height: 1,
};
const images: ImageResolver = {
  validate: (refs) => {
    if (refs.some((r) => r.id !== ref.id)) throw new Error("missing");
    return refs.map(() => ({ ...ref }));
  },
  resolve: () => [{ mediaType: "image/png", data: "eHl6" }],
};
function setup() {
  const repos = new Repositories(openDb(":memory:"));
  repos.createSession({ id: "s", cwd: "/tmp" });
  const bus = new EventBus();
  const base = fakeBackend([
    {
      type: "result",
      subtype: "success",
      total_cost_usd: 0,
      num_turns: 1,
      session_id: "sdk",
    },
  ]);
  const startTurn = vi.fn(base.startTurn.bind(base));
  const backend = {
    ...base,
    openSession: base.openSession.bind(base),
    startTurn,
  };
  return { repos, bus, backend, startTurn };
}
it("Master image-only/mixed inputs stay native and history remains refs-only; rejects before echo", async () => {
  const { repos, bus, backend, startTurn } = setup();
  const master = new MasterAgent({
    sessionId: "s",
    cwd: "/tmp",
    deps: {
      repos,
      bus,
      backend,
      images,
      model: () => "m",
      effort: () => "high",
      name: () => "n",
      fleet: {} as never,
    },
  });
  await master.runTurn("", { images: [ref] });
  await master.runTurn("mixed", { images: [ref] });
  expect(startTurn.mock.calls.map((c) => c[0])).toEqual([
    { text: "", images: images.resolve([ref]) },
    { text: "mixed", images: images.resolve([ref]) },
  ]);
  const events = repos.listSessionEvents("s");
  expect(JSON.stringify(events)).not.toContain("eHl6");
  expect(
    events
      .filter((e) => e.type === "master.message")
      .map((e) => JSON.parse(e.payload_json).images),
  ).toEqual([[ref], [ref]]);
  await expect(
    master.runTurn("bad", {
      images: [{ ...ref, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }],
    }),
  ).rejects.toThrow("missing");
  expect(startTurn).toHaveBeenCalledTimes(2);
});
it("Side sends image-only natively with a refs-only echo", async () => {
  const { bus, backend, startTurn } = setup();
  const emitted: unknown[] = [];
  bus.subscribe("s", (e) => emitted.push(e));
  const sides = new SideConversationManager({
    bus,
    backends: { claude: backend },
    images,
    resolveSource: () => ({
      sourceKind: "master",
      sourceId: "s",
      sessionId: "s",
      provider: "claude",
      cwd: "/tmp",
      sdkSessionId: "sdk",
      model: "m",
    }),
    forkSession: async () => ({ sessionId: "fork" }),
  });
  const { id } = await sides.create({ sourceKind: "master", sourceId: "s" });
  sides.send(id, "", [ref]);
  await sides.idle(id);
  expect(startTurn.mock.calls[0]?.[0]).toEqual({
    text: "",
    images: images.resolve([ref]),
  });
  expect(JSON.stringify(emitted)).toContain(ref.id);
  expect(JSON.stringify(emitted)).not.toContain("eHl6");
  await sides.closeAll();
});
it("Worker keeps refs until deferred dispatch and preserves image FIFO with captured speed", async () => {
  const { repos, bus } = setup();
  repos.createWorker({ id: "w", sessionId: "s", repoPath: "/tmp", label: "w" });
  const delivered: unknown[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  const backend: AgentBackend = {
    ...fakeBackend([]),
    openSession(input, opts) {
      const iterator = (async function* () {
        for await (const value of input) {
          delivered.push({
            value,
            speed: typeof opts.speed === "function" ? opts.speed() : opts.speed,
          });
          if (first) {
            first = false;
            await gate;
          }
          yield {
            kind: "turn_end" as const,
            subtype: "success",
            costUsd: 0,
            numTurns: 1,
            durationMs: 0,
            contextTokens: 0,
            contextWindow: 0,
          };
        }
      })();
      return Object.assign(iterator, {
        interrupt: async () => undefined,
        setModel: async () => {},
        setPermissionMode: async () => {},
        supportedCommands: async () => [],
      });
    },
  };
  const resolve = vi.fn(images.resolve);
  const worker = new Worker({
    id: "w",
    sessionId: "s",
    repoPath: "/tmp",
    label: "w",
    deps: { repos, bus, backend, images: { ...images, resolve }, model: "m" },
  });
  worker.start("start");
  await vi.waitFor(() => expect(delivered).toHaveLength(1));
  worker.send("", "one", "fast", [ref]);
  worker.send("second", "two", "standard", [ref]);
  expect(resolve).not.toHaveBeenCalled();
  release();
  await vi.waitFor(() => expect(worker.status()).toBe("idle"));
  expect(delivered.slice(1)).toEqual([
    { value: { text: "", images: images.resolve([ref]) }, speed: "fast" },
    {
      value: { text: "second", images: images.resolve([ref]) },
      speed: "standard",
    },
  ]);
  expect(JSON.stringify(repos.listWorkerEvents("w"))).not.toContain("eHl6");
  await worker.stop();
});

it("Master queues only refs, detects an unreadable asset before echo, and can retry the next turn", async () => {
  const { repos, bus } = setup();
  const base = fakeBackend([
    {
      type: "result",
      subtype: "success",
      total_cost_usd: 0,
      num_turns: 1,
      session_id: "sdk",
    },
  ]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const backend: AgentBackend = {
    ...base,
    startTurn(prompt, opts) {
      calls++;
      const stream = base.startTurn(prompt, opts);
      return Object.assign(
        (async function* () {
          if (calls === 1) await gate;
          yield* stream;
        })(),
        stream,
      );
    },
  };
  const resolve = vi.fn(images.resolve);
  const resolver = { ...images, resolve };
  const master = new MasterAgent({
    sessionId: "s",
    cwd: "/tmp",
    deps: {
      repos,
      bus,
      backend,
      images: resolver,
      model: () => "m",
      effort: () => "high",
      name: () => "n",
      fleet: {} as never,
    },
  });
  const first = master.runTurn("first");
  await vi.waitFor(() => expect(calls).toBe(1));
  const second = master.runTurn("", { images: [ref] });
  const failed = expect(second).rejects.toThrow("unreadable");
  expect(resolve).not.toHaveBeenCalled();
  resolve.mockImplementationOnce(() => {
    throw new Error("Image unreadable; retry");
  });
  release();
  await first;
  await failed;
  expect(calls).toBe(1);
  expect(
    repos.listSessionEvents("s").filter((e) => e.type === "master.message"),
  ).toHaveLength(1);
  await master.runTurn("", { images: [ref] });
  expect(calls).toBe(2);
});
it("cross-provider handoff stays textual while newly attached images remain native", async () => {
  const { repos, bus, backend, startTurn } = setup();
  repos.setSessionHandoffFrom("s", "codex");
  repos.addSessionEvent({
    sessionId: "s",
    seq: 0,
    type: "master.message",
    payloadJson: JSON.stringify({
      type: "master.message",
      sessionId: "s",
      role: "user",
      content: "old question",
      images: [ref],
    }),
  });
  const master = new MasterAgent({
    sessionId: "s",
    cwd: "/tmp",
    deps: {
      repos,
      bus,
      backend,
      images,
      model: () => "m",
      effort: () => "high",
      name: () => "n",
      fleet: {} as never,
    },
  });
  await master.runTurn("new question", { images: [ref] });
  expect(startTurn.mock.calls[0]?.[0]).toMatchObject({
    text: expect.stringContaining("old question"),
    images: images.resolve([ref]),
  });
  expect((startTurn.mock.calls[0]?.[0] as { text: string }).text).not.toContain(
    ref.id,
  );
});

it("Worker image-only and mixed sends survive lazy resume and provider stream replacement", async () => {
  const { repos, bus } = setup();
  repos.createWorker({ id: "w", sessionId: "s", repoPath: "/tmp", label: "w" });
  const native: unknown[] = [];
  const backend = fakeStreamingBackend((_text, _turn, content) => {
    native.push(content);
    return [
      {
        type: "result",
        subtype: "success",
        total_cost_usd: 0,
        num_turns: 1,
        session_id: "resumed-sdk",
      },
    ];
  });
  const worker = new Worker({
    id: "w",
    sessionId: "s",
    repoPath: "/tmp",
    label: "w",
    sdkSessionId: "resumed-sdk",
    deps: { repos, bus, backend, images, model: "m" },
  });
  worker.resume();
  worker.send("", "first", undefined, [ref]);
  await vi.waitFor(() => expect(worker.status()).toBe("idle"));
  await worker.requestCapabilityReload({ whenIdle: false, onBegin() {} })
    .completion;
  worker.send("after replacement", "second", undefined, [ref]);
  await vi.waitFor(() => expect(native).toHaveLength(2));
  expect(native).toEqual([
    [
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "eHl6" },
      },
    ],
    [
      { type: "text", text: "after replacement" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "eHl6" },
      },
    ],
  ]);
  await worker.stop();
});
it("Worker cancellation drops deferred image refs; unreadable queued images fail before echo", async () => {
  for (const cancel of [true, false]) {
    const { repos, bus } = setup();
    repos.createWorker({
      id: "w",
      sessionId: "s",
      repoPath: "/tmp",
      label: "w",
    });
    const resolve = vi.fn(() => {
      throw new Error("Image unreadable; retry");
    });
    const seen: string[] = [];
    const backend = fakeStreamingBackend((text) => {
      seen.push(text);
      return [
        {
          type: "result",
          subtype: "success",
          total_cost_usd: 0,
          num_turns: 1,
          session_id: "sdk",
        },
      ];
    });
    const worker = new Worker({
      id: "w",
      sessionId: "s",
      repoPath: "/tmp",
      label: "w",
      deps: { repos, bus, backend, images: { ...images, resolve }, model: "m" },
    });
    worker.start("start");
    worker.send("", "queued-image", "fast", [ref]);
    if (cancel) {
      await worker.interruptTurn();
      await vi.waitFor(() => expect(worker.status()).toBe("idle"));
      expect(resolve).not.toHaveBeenCalled();
    } else {
      await worker.waitUntilSettled();
      expect(worker.status()).toBe("error");
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(() => worker.send("retry", "retry-id", undefined, [ref])).toThrow("not running");
    }
    expect(seen).toEqual(["start"]);
    const history = repos
      .listWorkerEvents("w")
      .map((e) => JSON.parse(e.payload_json));
    expect(
      history.filter((e) => e.kind === "message" && e.role === "user"),
    ).toHaveLength(1);
    if (!cancel) expect(history).toContainEqual(expect.objectContaining({kind:"error",clientMsgId:"queued-image",retryInput:{text:"",images:[ref]}}));
    expect(JSON.stringify(history)).toContain(
      cancel ? "Dropped deferred instruction" : "unreadable",
    );
    await worker.stop();
  }
});
