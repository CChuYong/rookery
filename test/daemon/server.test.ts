import { describe, it, expect } from "vitest";
import { WebSocket } from "ws";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { startDaemon } from "../../src/daemon/server.js";
import { loadConfig } from "../../src/config.js";
import { fakeQuery } from "../helpers/fake-query.js";

function connect(port: number, token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>));
  });
}

describe("startDaemon (integration)", () => {
  it("accepts a ws client, creates a session, and streams a turn", async () => {
    const config = loadConfig({ ROOKERY_HOME: "/tmp/rookery-server-test", ROOKERY_PORT: "0" });
    const daemon = await startDaemon({
      config,
      acquireLock: false,
      queryFn: fakeQuery([
        { type: "assistant", text: "hi from master" },
        { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" },
      ]),
    });
    try {
      const ws = await connect(daemon.port, daemon.token);
      ws.send(JSON.stringify({ type: "session.create", cwd: "/tmp" }));
      const created = await nextMessage(ws);
      expect(created.type).toBe("session.created");
      const sessionId = created.sessionId as string;

      const events: string[] = [];
      // Wait deterministically until the turn ends (agent.result) — no fixed sleep.
      const done = new Promise<void>((resolve) => {
        ws.on("message", (data) => {
          const m = JSON.parse(data.toString()) as { type: string; event?: { type: string } };
          if (m.type === "event" && m.event) {
            events.push(m.event.type);
            if (m.event.type === "master.result") resolve();
          }
        });
      });
      ws.send(JSON.stringify({ type: "session.send", sessionId, text: "hello" }));

      await done;
      expect(events).toContain("master.message");
      expect(events).toContain("master.result");
      ws.close();
    } finally {
      await daemon.close();
    }
  });

  it("registers a capability pack and broadcasts its generation through the live daemon", async () => {
    const home = "/tmp/rookery-server-capabilities";
    const packRoot = "/tmp/rookery-server-capabilities-pack";
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(packRoot, { recursive: true, force: true });
    fs.mkdirSync(packRoot, { recursive: true });
    fs.writeFileSync(path.join(packRoot, "capability.json"), JSON.stringify({
      schemaVersion: 1,
      id: "daemon-smoke",
      displayName: "Daemon Smoke",
      version: "1.0.0",
      description: "Composition-root registry test",
    }));
    const config = loadConfig({ ROOKERY_HOME: home, ROOKERY_PORT: "0" });
    const daemon = await startDaemon({ config, acquireLock: false, queryFn: fakeQuery([]) });
    try {
      const ws = await connect(daemon.port, daemon.token);
      ws.send(JSON.stringify({ type: "events.subscribe" }));
      const received: Record<string, unknown>[] = [];
      const done = new Promise<void>((resolve) => {
        ws.on("message", (data) => {
          const message = JSON.parse(data.toString()) as Record<string, unknown>;
          received.push(message);
          const hasResult = received.some((item) => item.type === "capabilities.pack.result" && item.reqId === "pack-add");
          const hasEvent = received.some((item) => item.type === "event"
            && (item.event as { type?: string } | undefined)?.type === "capabilities.changed");
          if (hasResult && hasEvent) resolve();
        });
      });
      ws.send(JSON.stringify({ type: "capabilities.pack.add", reqId: "pack-add", path: packRoot }));
      await done;

      const result = received.find((item) => item.type === "capabilities.pack.result")!;
      expect(result).toMatchObject({ reqId: "pack-add", pack: { status: "untrusted", manifest: { id: "daemon-smoke" } } });
      const event = received.find((item) => item.type === "event"
        && (item.event as { type?: string } | undefined)?.type === "capabilities.changed")?.event;
      expect(event).toMatchObject({ type: "capabilities.changed", generation: 1, affected: [] });

      ws.send(JSON.stringify({ type: "capabilities.library", reqId: "library" }));
      let library: Record<string, unknown>;
      do library = await nextMessage(ws); while (library.reqId !== "library");
      expect(library).toMatchObject({ type: "capabilities.library.result", library: { generation: 1 } });
      ws.close();
    } finally {
      await daemon.close();
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(packRoot, { recursive: true, force: true });
    }
  });

  it("garbage-collects stale capability runtime revisions during boot", async () => {
    const home = "/tmp/rookery-server-capability-gc";
    fs.rmSync(home, { recursive: true, force: true });
    const parent = path.join(home, "capability-runtime");
    const stale = "b".repeat(64);
    fs.mkdirSync(path.join(parent, stale), { recursive: true });
    fs.writeFileSync(path.join(parent, stale, ".complete.json"), JSON.stringify({ schemaVersion: 2, revision: stale }));
    fs.mkdirSync(path.join(parent, ".tmp-interrupted"));
    fs.writeFileSync(path.join(parent, "operator-note"), "preserve");
    const config = loadConfig({ ROOKERY_HOME: home, ROOKERY_PORT: "0" });
    const daemon = await startDaemon({ config, acquireLock: false, queryFn: fakeQuery([]) });
    try {
      expect(fs.existsSync(path.join(parent, stale))).toBe(false);
      expect(fs.existsSync(path.join(parent, ".tmp-interrupted"))).toBe(false);
      expect(fs.readFileSync(path.join(parent, "operator-note"), "utf8")).toBe("preserve");
    } finally {
      await daemon.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("applies a trusted Claude pack to the next master turn and exposes matching runtime revisions", { timeout: 10000 }, async () => {
    const home = "/tmp/rookery-server-capability-runtime";
    const packRoot = "/tmp/rookery-server-capability-runtime-pack";
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(packRoot, { recursive: true, force: true });
    fs.mkdirSync(path.join(packRoot, "skills", "release"), { recursive: true });
    fs.writeFileSync(path.join(packRoot, "rules.md"), "Always mention CAPABILITY_RUNTIME_OK.");
    fs.writeFileSync(path.join(packRoot, "skills", "release", "SKILL.md"), "---\nname: release\ndescription: Release safely\n---\nShip safely.\n");
    fs.writeFileSync(path.join(packRoot, "capability.json"), JSON.stringify({
      schemaVersion: 1,
      id: "runtime-smoke",
      displayName: "Runtime Smoke",
      version: "1.0.0",
      description: "Composition-root runtime test",
      instructions: [{ id: "rules", path: "rules.md" }],
      skills: [{ id: "release", path: "skills/release" }],
    }));
    const calls: Array<{ prompt?: unknown; options?: Record<string, unknown> }> = [];
    const scripted = fakeQuery([
      { type: "assistant", text: "ok" },
      { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-runtime" },
    ]);
    const queryFn = ((input: { prompt?: unknown; options?: Record<string, unknown> }) => {
      calls.push(input);
      return scripted(input as never);
    }) as never;
    const config = loadConfig({ ROOKERY_HOME: home, ROOKERY_PORT: "0" });
    const daemon = await startDaemon({ config, acquireLock: false, queryFn });
    try {
      const ws = await connect(daemon.port, daemon.token);
      const received: Record<string, unknown>[] = [];
      ws.on("message", (data) => received.push(JSON.parse(data.toString()) as Record<string, unknown>));
      const request = (message: Record<string, unknown>): Promise<Record<string, unknown>> => new Promise((resolve) => {
        const reqId = message.reqId;
        const onMessage = (data: Buffer): void => {
          const response = JSON.parse(data.toString()) as Record<string, unknown>;
          if (response.reqId === reqId) {
            ws.off("message", onMessage);
            resolve(response);
          }
        };
        ws.on("message", onMessage);
        ws.send(JSON.stringify(message));
      });
      ws.send(JSON.stringify({ type: "events.subscribe" }));

      const added = await request({ type: "capabilities.pack.add", reqId: "add", path: packRoot });
      const pack = added.pack as { instanceId: string; digest: string };
      await request({
        type: "capabilities.trust.set",
        reqId: "trust",
        instanceId: pack.instanceId,
        digest: pack.digest,
        trusted: true,
      });
      await request({
        type: "capabilities.binding.set",
        reqId: "bind",
        id: "binding-runtime-smoke",
        binding: {
          packInstanceId: pack.instanceId,
          scopeKind: "rookery",
          scopeRef: "",
          audience: { agents: ["master"], origins: ["ui"] },
          enabled: true,
        },
      });
      const created = await request({ type: "session.create", reqId: "create", cwd: "/tmp" });
      const sessionId = created.sessionId as string;
      const turnDone = new Promise<void>((resolve) => {
        const poll = (): void => {
          const found = received.some((message) => message.type === "event"
            && (message.event as { type?: string; sessionId?: string } | undefined)?.type === "master.result"
            && (message.event as { sessionId?: string } | undefined)?.sessionId === sessionId);
          if (found) resolve(); else setTimeout(poll, 5);
        };
        poll();
      });
      ws.send(JSON.stringify({ type: "session.send", sessionId, text: "hello runtime" }));
      await turnDone;

      const turnCall = calls.find((call) => call.prompt === "hello runtime")!;
      const systemPrompt = turnCall.options?.systemPrompt as { append?: string };
      const plugins = turnCall.options?.plugins as Array<{ type: string; path: string }>;
      expect(systemPrompt.append).toContain("CAPABILITY_RUNTIME_OK");
      expect(plugins).toHaveLength(1);
      expect(plugins[0]).toMatchObject({ type: "local", path: expect.stringContaining(path.join(home, "capability-runtime")) });
      expect(fs.existsSync(path.join(plugins[0]!.path, "skills", "release", "SKILL.md"))).toBe(true);

      const runtimeEvent = received.find((message) => message.type === "event"
        && (message.event as { type?: string; state?: string } | undefined)?.type === "capabilities.runtime"
        && (message.event as { state?: string } | undefined)?.state === "current")?.event as { desiredRevision: string; appliedRevision: string };
      expect(runtimeEvent.appliedRevision).toBe(runtimeEvent.desiredRevision);
      const snapshotResult = await request({ type: "capabilities.snapshot", reqId: "snapshot", target: { kind: "session", id: sessionId } });
      expect(snapshotResult).toMatchObject({
        snapshot: {
          desiredRevision: runtimeEvent.desiredRevision,
          appliedRevision: runtimeEvent.desiredRevision,
          entries: expect.arrayContaining([expect.objectContaining({ name: "rules", state: "applied" })]),
        },
      });
      ws.close();
    } finally {
      await daemon.close();
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(packRoot, { recursive: true, force: true });
    }
  });

  it("rejects on port bind failure and releases the PID lock (no zombie)", { timeout: 10000 }, async () => {
    // Occupy a port first.
    const blocker = http.createServer(() => {});
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const busyPort = (blocker.address() as AddressInfo).port;

    const home = "/tmp/rookery-server-test-bindfail";
    const busyConfig = loadConfig({ ROOKERY_HOME: home, ROOKERY_PORT: String(busyPort) });
    // acquireLock defaults ON — the whole point: the lock must be released when listen fails.
    await expect(startDaemon({ config: busyConfig, queryFn: fakeQuery([]) })).rejects.toThrow(/EADDRINUSE/);

    // The lock must have been released: a retry with the SAME home/pidPath on a free port must succeed.
    const freeConfig = loadConfig({ ROOKERY_HOME: home, ROOKERY_PORT: "0" });
    const daemon = await startDaemon({ config: freeConfig, queryFn: fakeQuery([]) });
    await daemon.close();
    await new Promise<void>((r) => blocker.close(() => r()));
  });

  it("rejects a ws client without a valid token", async () => {
    const config = loadConfig({ ROOKERY_HOME: "/tmp/rookery-server-test3", ROOKERY_PORT: "0" });
    const daemon = await startDaemon({ config, acquireLock: false, queryFn: fakeQuery([]) });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws`); // no token → rejected
      await expect(
        new Promise((resolve, reject) => {
          ws.once("open", () => resolve("open"));
          ws.once("error", reject);
        }),
      ).rejects.toBeTruthy();
    } finally {
      await daemon.close();
    }
  });

  it("refuses a non-loopback bind unless ROOKERY_ALLOW_NONLOOPBACK is set (G-ORIGIN-AUTH)", async () => {
    const config = loadConfig({ ROOKERY_HOST: "0.0.0.0", ROOKERY_PORT: "0", ROOKERY_HOME: "/tmp/rookery-nonloop" });
    await expect(startDaemon({ config, acquireLock: false, queryFn: fakeQuery([]) })).rejects.toThrow(/non-loopback|ROOKERY_ALLOW_NONLOOPBACK/i);
  });

  it("POST /shutdown requires the token and invokes onShutdownRequest", async () => {
    const config = loadConfig({ ROOKERY_HOME: "/tmp/rookery-server-shutdown", ROOKERY_PORT: "0" });
    let calls = 0;
    const daemon = await startDaemon({ config, acquireLock: false, queryFn: fakeQuery([]), onShutdownRequest: () => { calls++; } });
    const post = (token?: string): Promise<number> => new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: daemon.port, path: "/shutdown", method: "POST", headers: token ? { "x-rookery-token": token } : {} },
        (r) => { r.resume(); resolve(r.statusCode ?? 0); },
      );
      req.on("error", reject);
      req.end();
    });
    try {
      expect(await post("wrong-token")).toBe(401);
      expect(calls).toBe(0); // bad token must not trigger shutdown
      expect(await post(daemon.token)).toBe(200);
      expect(calls).toBe(1);
    } finally {
      await daemon.close();
    }
  });

  it("rejects upgrade on non-/ws paths", async () => {
    const config = loadConfig({ ROOKERY_HOME: "/tmp/rookery-server-test2", ROOKERY_PORT: "0" });
    const daemon = await startDaemon({ config, acquireLock: false, queryFn: fakeQuery([]) });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/nope`);
      await expect(
        new Promise((resolve, reject) => {
          ws.once("open", () => resolve("open"));
          ws.once("error", reject);
        }),
      ).rejects.toBeTruthy();
    } finally {
      await daemon.close();
    }
  });

  it("sends WS heartbeat pings to detect half-open sockets", async () => {
    const config = loadConfig({ ROOKERY_HOME: "/tmp/rookery-server-hb", ROOKERY_PORT: "0" });
    const daemon = await startDaemon({ config, acquireLock: false, queryFn: fakeQuery([]), heartbeatMs: 30 });
    try {
      const ws = await connect(daemon.port, daemon.token);
      let pings = 0;
      ws.on("ping", () => { pings++; });
      await new Promise((r) => setTimeout(r, 150));
      expect(pings).toBeGreaterThan(0);
      expect(ws.readyState).toBe(WebSocket.OPEN); // a healthy (auto-pong) client is not disconnected
      ws.close();
    } finally {
      await daemon.close();
    }
  });

  // Regression guard: that automation.run's vars survive through the composition-root (server.ts automationProvider.runNow) adapter
  // and dispatcher→applyVars to be substituted into the master turn prompt. (If the adapter drops vars, they substitute to an empty string and this test fails.)
  it("manual automation.run forwards vars through the daemon wiring into the master turn prompt", async () => {
    const config = loadConfig({ ROOKERY_HOME: "/tmp/rookery-server-autovars", ROOKERY_PORT: "0" });
    const prompts: string[] = [];
    const queryFn = ((opts: { prompt?: unknown }) => {
      if (typeof opts.prompt === "string") prompts.push(opts.prompt);
      return fakeQuery([
        { type: "assistant", text: "ok" },
        { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-auto" },
      ])(opts as never);
    }) as never;
    const daemon = await startDaemon({ config, acquireLock: false, queryFn });
    try {
      const ws = await connect(daemon.port, daemon.token);
      const reqReply = (type: string, extra: Record<string, unknown>): Promise<Record<string, unknown>> => {
        const reqId = `req-${type}`;
        return new Promise((resolve) => {
          const onMsg = (data: Buffer): void => {
            const m = JSON.parse(data.toString()) as Record<string, unknown>;
            if (m.reqId === reqId) { ws.off("message", onMsg); resolve(m); }
          };
          ws.on("message", onMsg);
          ws.send(JSON.stringify({ type, reqId, ...extra }));
        });
      };
      const created = await reqReply("automation.create", {
        automation: { name: "vars-wiring", trigger: { kind: "cron", cron: "0 0 * * *", timezone: "UTC" }, action: { kind: "master", prompt: "MSG={{message}}", cwd: "/tmp", sessionMode: "fresh" } },
      });
      const id = (created.automation as { id: string }).id;
      await reqReply("automation.run", { id, vars: { message: "INJECTED" } });
      // With data-fencing, vars are wrapped in <untrusted-*> tags — the value "INJECTED" is present but fenced.
      expect(prompts.some((p) => p.includes("INJECTED"))).toBe(true); // would have been "MSG=" if the adapter had dropped vars
      expect(prompts.some((p) => p.includes("untrusted-slack-message"))).toBe(true); // fenced (not raw)
      ws.close();
    } finally {
      await daemon.close();
    }
  });

  // Item 6 (docs/2026-07-06-p25-codex-hardening.md): session.delete's combined onSessionDelete closure
  // (server.ts) must remove the session's materialized per-session CODEX_HOME dir, not just release the
  // bridge registration. A real codex turn is out of scope here (needs the actual `codex` binary/auth) —
  // we simulate a PRIOR turn having materialized the dir, then assert it's gone after session.delete.
  it("session.delete removes the session's codex-homes/<id> CODEX_HOME dir (best-effort cleanup)", async () => {
    const home = "/tmp/rookery-server-codexhome-delete";
    const config = loadConfig({ ROOKERY_HOME: home, ROOKERY_PORT: "0" });
    const daemon = await startDaemon({ config, acquireLock: false, queryFn: fakeQuery([]) });
    try {
      const ws = await connect(daemon.port, daemon.token);
      ws.send(JSON.stringify({ type: "session.create", cwd: "/tmp" }));
      const created = await nextMessage(ws);
      const sessionId = created.sessionId as string;

      const codexHomeDir = path.join(home, "codex-homes", sessionId);
      fs.mkdirSync(codexHomeDir, { recursive: true });
      fs.writeFileSync(path.join(codexHomeDir, "config.toml"), '[mcp_servers.rookery]\nurl = "http://x"\n');
      expect(fs.existsSync(codexHomeDir)).toBe(true);

      ws.send(JSON.stringify({ type: "session.delete", reqId: "d1", sessionId }));
      const ack = await nextMessage(ws);
      expect(ack).toMatchObject({ type: "fleet.ack", action: "delete", id: sessionId });
      expect(fs.existsSync(codexHomeDir)).toBe(false);
      ws.close();
    } finally {
      await daemon.close();
    }
  });
});
