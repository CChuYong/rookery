import { it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { startDaemon } from "../../src/daemon/server.js";
import { loadConfig } from "../../src/config.js";
import { fakeQuery } from "../helpers/fake-query.js";
import type { QueryFn } from "../../src/core/claude-backend.js";
import type { ImageRef } from "../../src/core/image-input.js";
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
function client(ws: WebSocket) {
  let n = 0;
  const events: unknown[] = [];
  const waiting = new Map<string, (msg: any) => void>();
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "event") events.push(msg.event);
    if (msg.reqId) {
      waiting.get(msg.reqId)?.(msg);
      waiting.delete(msg.reqId);
    }
  });
  return {
    events,
    request(input: object): Promise<any> {
      const reqId = `request-${n++}`;
      return new Promise((resolve) => {
        waiting.set(reqId, resolve);
        ws.send(JSON.stringify({ ...input, reqId }));
      });
    },
  };
}
it("authenticates upload/get, delivers native images, rejects whole invalid sends, and restores refs after restart", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rookery-image-ws-"));
  const config = loadConfig({ ROOKERY_HOME: home, ROOKERY_PORT: "0" });
  const native: unknown[] = [];
  const queryFn: QueryFn = (args) => {
    const fake = fakeQuery([
      {
        type: "result",
        subtype: "success",
        total_cost_usd: 0,
        num_turns: 1,
        session_id: "image-sdk",
      },
    ])(args);
    const generator = (async function* () {
      if (typeof args.prompt !== "string") {
        for await (const message of args.prompt) native.push(message);
      }
      yield* fake;
    })();
    return Object.assign(generator, {
      interrupt: fake.interrupt.bind(fake),
      close: () => fake.close(),
      supportedCommands: async () => [],
      setModel: async () => {},
      setPermissionMode: async () => {},
    }) as ReturnType<QueryFn>;
  };
  let daemon = await startDaemon({ config, acquireLock: false, queryFn });
  let ws: WebSocket | undefined;
  try {
    await expect(connect(daemon.port, "wrong-token")).rejects.toThrow("401");
    ws = await connect(daemon.port, daemon.token);
    let c = client(ws);
    const bytes = fs.readFileSync(
      new URL("../fixtures/images/tiny.png", import.meta.url),
    );
    const base64 = bytes.toString("base64");
    const uploaded = await c.request({
      type: "image.upload",
      name: "tiny.png",
      mediaType: "image/png",
      base64,
    });
    expect(uploaded.type).toBe("image.upload.result");
    const image: ImageRef = uploaded.image;
    expect(await c.request({ type: "image.get", id: image.id })).toMatchObject({
      type: "image.get.result",
      image,
      base64,
    });
    const session = await c.request({ type: "session.create", cwd: "/tmp" });
    expect(
      await c.request({
        type: "session.send",
        sessionId: session.sessionId,
        text: "",
        images: [image],
      }),
    ).toMatchObject({ type: "fleet.ack" });
    const messages = c.events.filter((e: any) => e.type === "master.message");
    expect(messages).toMatchObject([
      { role: "user", content: "", images: [image] },
    ]);
    expect(JSON.stringify(native)).toContain(base64);
    expect(
      await c.request({
        type: "session.send",
        sessionId: session.sessionId,
        text: "invalid",
        images: [image, { ...image, name: "tampered" }],
      }),
    ).toMatchObject({ type: "error" });
    expect(native).toHaveLength(1);
    expect(
      c.events.filter((e: any) => e.type === "master.message"),
    ).toHaveLength(1);
    ws.close();
    await daemon.close();
    daemon = await startDaemon({ config, acquireLock: false, queryFn });
    ws = await connect(daemon.port, daemon.token);
    c = client(ws);
    const history = await c.request({
      type: "session.history",
      sessionId: session.sessionId,
    });
    expect(JSON.stringify(history)).not.toContain(base64);
    expect(JSON.stringify(history)).toContain(image.id);
    expect(await c.request({ type: "image.get", id: image.id })).toMatchObject({
      image,
      base64,
    });
    // A new authenticated connection can load historical assets; deletion never implicitly collects blobs.
    await c.request({ type: "session.delete", sessionId: session.sessionId });
    expect(await c.request({ type: "image.get", id: image.id })).toMatchObject({
      image,
      base64,
    });
    const huge = new WebSocket(
      `ws://127.0.0.1:${daemon.port}/ws?token=${daemon.token}`,
    );
    await new Promise<void>((resolve, reject) => {
      huge.once("open", () => resolve());
      huge.once("error", reject);
    });
    huge.on("error", () => {});
    const closed = new Promise<number>((resolve) =>
      huge.once("close", resolve),
    );
    huge.send(" ".repeat(16 * 1024 * 1024 + 1));
    expect(await closed).toBe(1009);
  } finally {
    ws?.terminate();
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 15000);
