import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../../src/persistence/db.js";
import { Repositories } from "../../src/persistence/repositories.js";
import { EventBus } from "../../src/core/events.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { FleetOrchestrator } from "../../src/core/fleet-orchestrator.js";
import { FakeGitOps } from "../../src/core/git-ops.js";
import { Connection } from "../../src/daemon/connection.js";
import { ImageStore } from "../../src/daemon/image-store.js";
import { fakeBackend } from "../helpers/fake-query.js";
import { WsClient } from "../../apps/desktop/src/renderer/ws/client.js";
import type { SocketLike } from "../../apps/desktop/src/renderer/ws/client.js";
import type { AgentBackend } from "../../src/core/agent-backend.js";
import type { CoreEvent } from "../../src/core/events.js";
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    fs.rmSync(home, { recursive: true, force: true });
});
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9f8AAAAASUVORK5CYII=";
function harness() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rookery-ui-accept-"));
  homes.push(home);
  const db = openDb(":memory:");
  const repos = new Repositories(db);
  const bus = new EventBus();
  const images = new ImageStore(home, repos);
  const fleet = new FleetOrchestrator({
    repos,
    bus,
    git: new FakeGitOps(),
    factory: () => ({
      start() {},
      send() {},
      async stop() {},
      status: () => "running",
      async waitUntilSettled() {},
    }),
    worktreesDir: path.join(home, "wt"),
  });
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let starts = 0;
  const base = fakeBackend([]);
  const backend: AgentBackend = {
    ...base,
    openSession: base.openSession.bind(base),
    startTurn: vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        starts++;
        if (starts === 1) await gate;
        yield {
          type: "result" as const,
          subtype: "success",
          totalCostUsd: 0,
          numTurns: 1,
          sessionId: "sdk",
        };
      },
      interrupt: async () => {},
      close: async () => {},
    })),
  };
  const sessions = new SessionManager(
    {
      repos,
      bus,
      fleet,
      images,
      backends: { claude: backend },
      masterModel: "fake",
    },
    () => "s",
  );
  let connection: Connection;
  const events: CoreEvent[] = [];
  const socket: SocketLike = {
    onopen: null,
    onclose: null,
    onmessage: null,
    close() {},
    send(data) {
      void connection.handleRaw(data);
    },
  };
  const client = new WsClient(
    () => socket,
    (event) => events.push(event),
  );
  connection = new Connection(
    { send: (data) => socket.onmessage?.(data) },
    sessions,
    bus,
    fleet,
    repos,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    images,
  );
  client.start();
  return {
    client,
    sessions,
    images,
    events,
    db,
    repos,
    finish,
    get starts() {
      return starts;
    },
  };
}
it("real Connection/WsClient acknowledges validated image enqueue before model completion and serializes later drafts", async () => {
  const h = harness();
  await h.client.request({ type: "session.create" });
  const uploaded = await h.client.request({
    type: "image.upload",
    name: "pixel.png",
    mediaType: "image/png",
    base64: png,
  });
  await h.client.request({
    type: "session.send",
    sessionId: "s",
    text: "",
    images: [uploaded.image],
    clientMsgId: "one",
  });
  expect(h.starts).toBe(1);
  await h.client.request({
    type: "session.send",
    sessionId: "s",
    text: "",
    images: [uploaded.image],
    clientMsgId: "two",
  });
  expect(h.starts).toBe(1); // accepted second draft, provider first turn still blocked
  await expect(
    h.client.request({
      type: "session.send",
      sessionId: "s",
      text: "",
      images: [{ ...uploaded.image, name: "tampered" }],
      clientMsgId: "bad",
    }),
  ).rejects.toThrow();
  expect(h.events.filter((e) => e.type === "master.message")).toHaveLength(1);
  h.finish();
  await vi.waitFor(() => expect(h.starts).toBe(2));
  await vi.waitFor(() =>
    expect(
      h.events.filter((e) => e.type === "master.message" && e.role === "user"),
    ).toHaveLength(2),
  );
  expect(
    h.repos
      .listSessionEvents("s")
      .filter((e) => e.type === "master.message")
      .map((e) => JSON.parse(e.payload_json).clientMsgId),
  ).toEqual(["one", "two"]);
  expect(JSON.stringify(h.repos.listSessionEvents("s"))).not.toContain(png);
  h.db.close();
});
it("queued pre-echo execution failure persists correlated text+refs for retry after reconnect", async () => {
  const h = harness();
  await h.client.request({ type: "session.create" });
  const { image } = await h.client.request({
    type: "image.upload",
    name: "pixel.png",
    mediaType: "image/png",
    base64: png,
  });
  await h.client.request({
    type: "session.send",
    sessionId: "s",
    text: "first",
    clientMsgId: "one",
  });
  await h.client.request({
    type: "session.send",
    sessionId: "s",
    text: "",
    images: [image],
    clientMsgId: "failed",
  });
  fs.unlinkSync(path.join(homes.at(-1)!, "images", image.id));
  h.finish();
  await vi.waitFor(() =>
    expect(h.events).toContainEqual(
      expect.objectContaining({
        type: "error",
        clientMsgId: "failed",
        retryInput: { text: "", images: [image] },
      }),
    ),
  );
  const replay = await h.client.request({
    type: "session.history",
    sessionId: "s",
  });
  expect(replay.events).toContainEqual(
    expect.objectContaining({
      payload: expect.objectContaining({
        type: "error",
        clientMsgId: "failed",
        retryInput: { text: "", images: [image] },
      }),
    }),
  );
  expect(h.starts).toBe(1);
  h.db.close();
});
