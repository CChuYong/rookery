import { it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { startDaemon } from "../../src/daemon/server.js";
import { loadConfig } from "../../src/config.js";
import { fakeQuery } from "../helpers/fake-query.js";
import Database from "better-sqlite3";
import { ImageGcScheduler } from "../../src/daemon/image-store.js";
import { openDb } from "../../src/persistence/db.js";
import { Repositories } from "../../src/persistence/repositories.js";
// Keep production HTTP/WS routing while preventing startup account/network/usage probes.
vi.mock("../../src/core/usage.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/core/usage.js")>();
  return {
    ...actual,
    UsageCollector: class {
      start() {}
      stop() {}
      snapshot() {
        return actual.emptyUsage();
      }
    },
  };
});
vi.mock("../../src/core/codex-models-provider.js", () => ({
  makeCodexModelsProvider: () => ({ list: async () => null }),
}));
vi.mock("../../src/core/codex-auth-provider.js", () => ({
  makeCodexAuthProvider: () => ({ status: async () => null }),
}));
vi.mock("../../src/core/codex-usage-provider.js", () => ({
  makeCodexUsageProvider: () => ({ fetch: async () => null }),
}));
vi.mock("../../src/core/oauth-usage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/core/oauth-usage.js")>()),
  makeOAuthUsageProvider: () => async () => null,
}));
vi.mock("../../src/daemon/codex-usage-mirror.js", () => ({
  syncCodexUsageMirror: () => ({
    linked: 0,
    relinked: 0,
    skipped: 0,
    failed: 0,
  }),
  syncCodexUsageMirrorForTarget: () => ({
    linked: 0,
    relinked: 0,
    skipped: 0,
    failed: 0,
  }),
}));
function connect(port: number, token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  return new Promise<WebSocket>((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}
function request(ws: WebSocket, input: object & { reqId: string }): Promise<any> {
  return new Promise((resolve) => {
    const onMessage = (raw: unknown) => {
      const msg = JSON.parse(String(raw));
      if (msg.reqId !== input.reqId) return;
      ws.off("message", onMessage);
      resolve(msg);
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify(input));
  });
}

it("schedules image GC at boot and after permanent worker/session deletion; shutdown stops it before the DB closes", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rookery-image-gc-wiring-"));
  const config = loadConfig({ ROOKERY_HOME: home, ROOKERY_PORT: "0" });
  // Seed a detached worker row so worker.delete takes the real permanent-delete path.
  const seed = openDb(config.dbPath);
  const seedRepos = new Repositories(seed);
  seedRepos.createSession({ id: "seed-session", cwd: "/tmp" });
  seedRepos.createWorker({ id: "seed-worker", sessionId: "seed-session", repoPath: "/tmp", label: "w" });
  seed.close();

  const order: string[] = [];
  const schedule = vi.spyOn(ImageGcScheduler.prototype, "schedule");
  const originalStop = ImageGcScheduler.prototype.stop;
  const stop = vi.spyOn(ImageGcScheduler.prototype, "stop").mockImplementation(function (this: ImageGcScheduler) {
    order.push("gc.stop");
    originalStop.call(this);
  });
  const originalClose = Database.prototype.close;
  const close = vi.spyOn(Database.prototype, "close").mockImplementation(function (this: InstanceType<typeof Database>) {
    order.push("db.close");
    return originalClose.call(this);
  });
  const daemon = await startDaemon({ config, acquireLock: false, queryFn: fakeQuery([]) });
  let ws: WebSocket | undefined;
  try {
    expect(schedule.mock.calls).toEqual([["boot"]]);
    ws = await connect(daemon.port, daemon.token);
    expect(await request(ws, { type: "worker.delete", reqId: "w", id: "seed-worker" })).toMatchObject({ type: "fleet.ack", action: "delete" });
    expect(schedule).toHaveBeenCalledTimes(2);
    expect(await request(ws, { type: "session.delete", reqId: "s", sessionId: "seed-session" })).toMatchObject({ type: "fleet.ack", action: "delete" });
    expect(schedule).toHaveBeenCalledTimes(3);
  } finally {
    ws?.close();
    await daemon.close();
    schedule.mockRestore();
    stop.mockRestore();
    close.mockRestore();
    fs.rmSync(home, { recursive: true, force: true });
  }
  expect(order).toEqual(["gc.stop", "db.close"]);
});
