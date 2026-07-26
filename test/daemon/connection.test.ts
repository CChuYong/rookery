import { describe, it, expect, vi } from "vitest";
import { openDb } from "../../src/persistence/db.js";
import { Repositories } from "../../src/persistence/repositories.js";
import type { Automation, AutomationInput } from "../../src/persistence/repositories.js";
import { EventBus } from "../../src/core/events.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { FleetOrchestrator } from "../../src/core/fleet-orchestrator.js";
import type { WorkerLike } from "../../src/core/fleet-orchestrator.js";
import { FakeGitOps } from "../../src/core/git-ops.js";
import { Connection } from "../../src/daemon/connection.js";
import type { ClientSocket, AutomationProvider, SlackRefResolverFn } from "../../src/daemon/connection.js";
import { InteractionRegistry } from "../../src/core/interaction-registry.js";
import { Settings } from "../../src/core/settings.js";
import { loadConfig } from "../../src/config.js";
import { fakeBackend, fakeQuery } from "../helpers/fake-query.js";
import { ClaudeBackend } from "../../src/core/claude-backend.js";

function setup() {
  const repos = new Repositories(openDb(":memory:"));
  const bus = new EventBus();
  const factory = (): WorkerLike => ({ start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
  const fleet = new FleetOrchestrator({ repos, bus, git: new FakeGitOps(), factory, worktreesDir: "/wt" });
  let n = 0;
  const sm = new SessionManager(
    {
      repos,
      bus,
      backends: { claude: fakeBackend([
        { type: "assistant", text: "ack" },
        { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" },
      ]) },
      masterModel: "mm",
      fleet,
    },
    () => `s${n++}`,
  );
  const sent: string[] = [];
  const socket: ClientSocket = { send: (d) => sent.push(d) };
  const conn = new Connection(socket, sm, bus, fleet, repos);
  return { conn, sent, repos, bus, fleet, sm, socket };
}

type FleetOverride = {
  list?: () => Array<{ id: string; label: string; repoPath: string; status: string; branch: string | null; model: string | null }>;
  diff?: (id: string) => Promise<string>;
  stop?: (id: string) => Promise<void>;
  discard?: (id: string) => Promise<void>;
  delete?: (id: string) => Promise<void>;
  interrupt?: (id: string) => Promise<void>;
  setModel?: (id: string, model: string) => Promise<void>;
  setPermissionMode?: (id: string, mode: string) => Promise<void>;
  transcript?: (id: string, sinceSeq?: number) => Array<{ seq: number; type: string; payload: unknown }>;
  send?: (id: string, text: string) => void;
  spawn?: (input: { homeSessionId: string; repoPath: string; label: string; task: string; base?: string; permissionMode?: string; costBudgetUsd?: number }) => { id: string };
  fork?: (id: string, target?: { provider?: string; model?: string; effort?: string }) => Promise<{ id: string }>;
};

function makeConn(sent: any[], overrides: { fleet?: FleetOverride }): Connection {
  const repos = new Repositories(openDb(":memory:"));
  const bus = new EventBus();
  const factory = (): WorkerLike => ({ start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
  const realFleet = new FleetOrchestrator({ repos, bus, git: new FakeGitOps(), factory, worktreesDir: "/wt" });
  const fleet = overrides.fleet
    ? (overrides.fleet as unknown as FleetOrchestrator)
    : realFleet;
  let n = 0;
  const sm = new SessionManager(
    {
      repos,
      bus,
      backends: { claude: fakeBackend([
        { type: "assistant", text: "ack" },
        { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" },
      ]) },
      masterModel: "mm",
      fleet: realFleet,
    },
    () => `s${n++}`,
  );
  const socket: ClientSocket = { send: (d: string) => sent.push(JSON.parse(d) as unknown) };
  return new Connection(socket, sm, bus, fleet, repos);
}

function makeConnWithBus(sent: any[]): { conn: Connection; bus: EventBus } {
  const repos = new Repositories(openDb(":memory:"));
  const bus = new EventBus();
  const factory = (): WorkerLike => ({ start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
  const fleet = new FleetOrchestrator({ repos, bus, git: new FakeGitOps(), factory, worktreesDir: "/wt" });
  let n = 0;
  const sm = new SessionManager(
    {
      repos,
      bus,
      backends: { claude: fakeBackend([
        { type: "assistant", text: "ack" },
        { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" },
      ]) },
      masterModel: "mm",
      fleet,
    },
    () => `s${n++}`,
  );
  const socket: ClientSocket = { send: (d: string) => sent.push(JSON.parse(d) as unknown) };
  const conn = new Connection(socket, sm, bus, fleet, repos);
  return { conn, bus };
}

function parsed(sent: string[]): Array<Record<string, unknown>> {
  return sent.map((s) => JSON.parse(s) as Record<string, unknown>);
}

describe("Connection", () => {
  it("routes capabilities.snapshot to the injected provider and preserves reqId", async () => {
    const { sent, repos, bus, fleet, sm, socket } = setup();
    const snapshot = {
      target: { kind: "session" as const, id: "s1", label: "Main", provider: "claude" as const, cwd: "/repo" },
      generatedAt: "2026-07-13T12:00:00.000Z",
      entries: [],
      diagnostics: [],
    };
    const capabilities = { snapshot: vi.fn(async () => snapshot) };
    const conn = new Connection(
      socket, sm, bus, fleet, repos,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, capabilities,
    );

    await conn.handleRaw(JSON.stringify({ type: "capabilities.snapshot", reqId: "cap-1", target: { kind: "session", id: "s1" } }));

    expect(capabilities.snapshot).toHaveBeenCalledWith({ kind: "session", id: "s1" });
    expect(parsed(sent).at(-1)).toEqual({ type: "capabilities.snapshot.result", reqId: "cap-1", snapshot });
  });

  it("routes a capability repository preview without adding client authority", async () => {
    const { sent, repos, bus, fleet, sm, socket } = setup();
    const target = { kind: "repo" as const, id: "repo-1", provider: "claude" as const, agent: "master" as const };
    const snapshot = {
      target: { ...target, label: "Repo One", cwd: "/repo" },
      generatedAt: "2026-07-16T00:00:00.000Z",
      entries: [],
      diagnostics: [],
    };
    const capabilities = { snapshot: vi.fn(async () => snapshot) };
    const conn = new Connection(
      socket, sm, bus, fleet, repos,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, capabilities,
    );

    await conn.handleRaw(JSON.stringify({ type: "capabilities.snapshot", reqId: "preview-1", target }));

    expect(capabilities.snapshot).toHaveBeenCalledWith(target);
    expect(parsed(sent).at(-1)).toEqual({ type: "capabilities.snapshot.result", reqId: "preview-1", snapshot });
  });

  it("returns a correlated error when capability snapshot resolution fails", async () => {
    const { sent, repos, bus, fleet, sm, socket } = setup();
    const capabilities = { snapshot: vi.fn(async () => { throw new Error("unknown capability target: worker:missing"); }) };
    const conn = new Connection(
      socket, sm, bus, fleet, repos,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, capabilities,
    );

    await conn.handleRaw(JSON.stringify({ type: "capabilities.snapshot", reqId: "cap-2", target: { kind: "worker", id: "missing" } }));

    expect(parsed(sent).at(-1)).toMatchObject({ type: "error", reqId: "cap-2", message: expect.stringContaining("unknown capability target: worker:missing") });
  });

  it("routes every capability registry mutation with sanitized correlated results", async () => {
    const { sent, repos, bus, fleet, sm, socket } = setup();
    const library = { generation: 4, packs: [], bindings: [], diagnostics: [] };
    const pack = { instanceId: "pack-1", status: "trusted" };
    const binding = {
      id: "binding-1",
      packInstanceId: "pack-1",
      scopeKind: "rookery",
      scopeRef: "",
      audience: { agents: ["master"], origins: ["ui"] },
      enabled: true,
      createdAt: "t",
      updatedAt: "t",
    };
    const capabilities = {
      snapshot: vi.fn(),
      library: vi.fn(() => library),
      addPack: vi.fn(() => pack),
      removePack: vi.fn(),
      setBinding: vi.fn(() => binding),
      quickSetBinding: vi.fn(() => binding),
      deleteBinding: vi.fn(),
      setTrust: vi.fn(() => pack),
      setSecret: vi.fn(() => ({ key: "token", configured: true })),
      deleteSecret: vi.fn(() => ({ key: "token", configured: false })),
      refresh: vi.fn(() => library),
    };
    const conn = new Connection(
      socket, sm, bus, fleet, repos,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, capabilities as never,
    );
    const bindingInput = {
      packInstanceId: "pack-1", scopeKind: "rookery", scopeRef: "",
      audience: { agents: ["master"], origins: ["ui"] }, enabled: true,
    };
    const requests = [
      { type: "capabilities.library", reqId: "cap-lib" },
      { type: "capabilities.pack.add", reqId: "cap-add", path: "/pack" },
      { type: "capabilities.binding.set", reqId: "cap-bind", id: "binding-1", binding: bindingInput },
      { type: "capabilities.binding.quickSet", reqId: "cap-quick", input: { packInstanceId: "pack-1", scopeKind: "rookery", scopeRef: "", mode: "enabled", agents: ["master"] } },
      { type: "capabilities.trust.set", reqId: "cap-trust", instanceId: "pack-1", digest: "a".repeat(64), trusted: true },
      { type: "capabilities.secret.set", reqId: "cap-secret", instanceId: "pack-1", key: "token", value: "actual-secret-value" },
      { type: "capabilities.secret.delete", reqId: "cap-secret-delete", instanceId: "pack-1", key: "token" },
      { type: "capabilities.refresh", reqId: "cap-refresh", instanceId: "pack-1" },
      { type: "capabilities.binding.delete", reqId: "cap-bind-delete", id: "binding-1" },
      { type: "capabilities.pack.remove", reqId: "cap-remove", instanceId: "pack-1" },
    ];
    for (const request of requests) await conn.handleRaw(JSON.stringify(request));

    const replies = parsed(sent).slice(-requests.length);
    expect(replies.map((reply) => [reply.type, reply.reqId])).toEqual([
      ["capabilities.library.result", "cap-lib"],
      ["capabilities.pack.result", "cap-add"],
      ["capabilities.binding.result", "cap-bind"],
      ["capabilities.binding.quickSet.result", "cap-quick"],
      ["capabilities.pack.result", "cap-trust"],
      ["capabilities.secret.result", "cap-secret"],
      ["capabilities.secret.result", "cap-secret-delete"],
      ["capabilities.refresh.result", "cap-refresh"],
      ["capabilities.binding.result", "cap-bind-delete"],
      ["capabilities.pack.result", "cap-remove"],
    ]);
    expect(JSON.stringify(replies)).not.toContain("actual-secret-value");
    expect(capabilities.setSecret).toHaveBeenCalledWith("pack-1", "token", "actual-secret-value");
    expect(capabilities.quickSetBinding).toHaveBeenCalledWith({ packInstanceId: "pack-1", scopeKind: "rookery", scopeRef: "", mode: "enabled", agents: ["master"] });
    expect(replies.at(-1)).toMatchObject({ pack: null });
  });

  it("returns correlated capability mutation errors", async () => {
    const { sent, repos, bus, fleet, sm, socket } = setup();
    const capabilities = {
      snapshot: vi.fn(), library: vi.fn(), addPack: vi.fn(() => { throw new Error("invalid capability pack"); }),
    };
    const conn = new Connection(
      socket, sm, bus, fleet, repos,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, capabilities as never,
    );
    await conn.handleRaw(JSON.stringify({ type: "capabilities.pack.add", reqId: "cap-bad", path: "/bad" }));
    expect(parsed(sent).at(-1)).toMatchObject({
      type: "error", reqId: "cap-bad", message: expect.stringContaining("invalid capability pack"),
    });
  });

  it("creates an MCP pack through the provider without exposing write-only secrets", async () => {
    const { sent, repos, bus, fleet, sm, socket } = setup();
    const input = {
      id: "repo-tools",
      displayName: "Repo Tools",
      version: "1.0.0",
      description: "Repository MCP servers",
      repoId: "repo-1",
      agents: ["master", "worker"],
      mcpServers: [{
        id: "docs",
        transport: "streamable-http",
        url: "https://example.test/mcp",
        auth: { bearerToken: { source: "rookery-secret", key: "docs-token" } },
      }],
      secretValues: { "docs-token": "uniquely-sensitive-mcp-secret" },
    };
    const result = {
      pack: {
        instanceId: "pack-1",
        sourceKind: "rookery-generated",
        status: "untrusted",
        manifest: { id: "repo-tools" },
        secrets: [{ key: "docs-token", configured: true }],
      },
      binding: {
        id: "binding-1",
        packInstanceId: "pack-1",
        scopeKind: "repo-local",
        scopeRef: "repo-1",
        audience: { agents: ["master", "worker"], origins: ["ui"] },
        enabled: true,
        createdAt: "t",
        updatedAt: "t",
      },
    };
    const capabilities = { snapshot: vi.fn(), createMcpPack: vi.fn(() => result) };
    const conn = new Connection(
      socket, sm, bus, fleet, repos,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, capabilities as never,
    );

    await conn.handleRaw(JSON.stringify({ type: "capabilities.mcpPack.create", reqId: "cap-create", input }));

    expect(capabilities.createMcpPack).toHaveBeenCalledWith(input);
    expect(parsed(sent).at(-1)).toEqual({ type: "capabilities.mcpPack.result", reqId: "cap-create", ...result });
    expect(sent.join("\n")).not.toContain("uniquely-sensitive-mcp-secret");
  });

  it("creates lightweight MCP and Skill catalog entries without exposing write-only values", async () => {
    const { sent, repos, bus, fleet, sm, socket } = setup();
    const pack = {
      instanceId: "pack-1",
      sourceKind: "rookery-generated",
      status: "untrusted",
      manifest: { id: "docs" },
      secrets: [{ key: "docs-token", configured: true }],
    };
    const capabilities = {
      snapshot: vi.fn(),
      createMcp: vi.fn(() => ({ pack })),
      createSkill: vi.fn(() => ({ pack: { ...pack, instanceId: "pack-2", manifest: { id: "review" }, secrets: [] } })),
    };
    const conn = new Connection(
      socket, sm, bus, fleet, repos,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, capabilities as never,
    );
    const mcpInput = {
      id: "docs",
      displayName: "Docs MCP",
      description: "Documentation tools",
      mcpServer: {
        id: "docs",
        transport: "streamable-http",
        url: "https://example.test/mcp",
        auth: { bearerToken: { source: "rookery-secret", key: "docs-token" } },
      },
      secretValues: { "docs-token": "uniquely-sensitive-single-mcp-secret" },
    };
    const skillInput = {
      id: "review",
      displayName: "Review Skill",
      description: "Review changes",
      sourcePath: "/skills/review",
    };

    await conn.handleRaw(JSON.stringify({ type: "capabilities.mcp.create", reqId: "mcp-create", input: mcpInput }));
    await conn.handleRaw(JSON.stringify({ type: "capabilities.skill.create", reqId: "skill-create", input: skillInput }));

    expect(capabilities.createMcp).toHaveBeenCalledWith(mcpInput);
    expect(capabilities.createSkill).toHaveBeenCalledWith(skillInput);
    expect(parsed(sent).slice(-2)).toEqual([
      { type: "capabilities.catalog.create.result", reqId: "mcp-create", pack },
      { type: "capabilities.catalog.create.result", reqId: "skill-create", pack: { ...pack, instanceId: "pack-2", manifest: { id: "review" }, secrets: [] } },
    ]);
    expect(sent.join("\n")).not.toContain("uniquely-sensitive-single-mcp-secret");
  });

  it("redacts MCP write-only values from correlated creation errors", async () => {
    const { sent, repos, bus, fleet, sm, socket } = setup();
    const capabilities = {
      snapshot: vi.fn(),
      createMcpPack: vi.fn(() => { throw new Error("rejected uniquely-sensitive-mcp-secret by store"); }),
    };
    const conn = new Connection(
      socket, sm, bus, fleet, repos,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, capabilities as never,
    );

    await conn.handleRaw(JSON.stringify({
      type: "capabilities.mcpPack.create",
      reqId: "cap-create-error",
      input: {
        id: "repo-tools",
        displayName: "Repo Tools",
        version: "1.0.0",
        description: "Repository MCP servers",
        repoId: "repo-1",
        agents: ["master"],
        mcpServers: [{
          id: "docs",
          transport: "streamable-http",
          url: "https://example.test/mcp",
          auth: { bearerToken: { source: "rookery-secret", key: "docs-token" } },
        }],
        secretValues: { "docs-token": "uniquely-sensitive-mcp-secret" },
      },
    }));

    expect(parsed(sent).at(-1)).toMatchObject({
      type: "error",
      reqId: "cap-create-error",
      message: expect.stringContaining("[redacted]"),
    });
    expect(sent.join("\n")).not.toContain("uniquely-sensitive-mcp-secret");
  });

  it("routes worker capability reloads and preserves the scheduling result", async () => {
    const { sent, repos, bus, fleet, sm, socket } = setup();
    const capabilities = { snapshot: vi.fn() };
    const reload = vi.spyOn(fleet, "reloadCapabilities").mockResolvedValue({ workerId: "worker-1", mode: "scheduled" });
    const conn = new Connection(
      socket, sm, bus, fleet, repos,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, capabilities,
    );

    await conn.handleRaw(JSON.stringify({
      type: "capabilities.worker.reload", reqId: "cap-reload", workerId: "worker-1", whenIdle: true,
    }));

    expect(reload).toHaveBeenCalledWith("worker-1", true);
    expect(parsed(sent).at(-1)).toEqual({
      type: "capabilities.worker.reload.result", reqId: "cap-reload", workerId: "worker-1", mode: "scheduled",
    });
  });

  it("starts Side only after replying with its id, routes lifecycle commands, and cleans owned Side threads on dispose", async () => {
    const repos = new Repositories(openDb(":memory:"));
    const bus = new EventBus();
    const factory = (): WorkerLike => ({ start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
    const fleet = new FleetOrchestrator({ repos, bus, git: new FakeGitOps(), factory, worktreesDir: "/wt" });
    const sessions = new SessionManager({ repos, bus, backends: { claude: fakeBackend([]) }, masterModel: "m", fleet });
    const order: string[] = [];
    const socket: ClientSocket = { send: (data) => order.push(`reply:${(JSON.parse(data) as { type: string }).type}`) };
    let n = 0;
    const sides = {
      create: vi.fn(async () => ({ id: `side-${++n}` })),
      send: vi.fn((id: string, text: string) => { order.push(`send:${id}:${text}`); }),
      stop: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const conn = new Connection(socket, sessions, bus, fleet, repos,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sides);

    await conn.handleRaw(JSON.stringify({ type: "side.start", sourceKind: "worker", sourceId: "w1", text: "why", model: "m2", effort: "high", reqId: "q1" }));
    expect(sides.create).toHaveBeenCalledWith({ sourceKind: "worker", sourceId: "w1", model: "m2", effort: "high" });
    expect(order.slice(0, 2)).toEqual(["reply:side.started", "send:side-1:why"]);

    await conn.handleRaw(JSON.stringify({ type: "side.send", sideId: "side-1", text: "more", reqId: "q2" }));
    await conn.handleRaw(JSON.stringify({ type: "side.stop", sideId: "side-1", reqId: "q3" }));
    await conn.handleRaw(JSON.stringify({ type: "side.close", sideId: "side-1", reqId: "q4" }));
    expect(sides.send).toHaveBeenLastCalledWith("side-1", "more");
    expect(sides.stop).toHaveBeenCalledWith("side-1");
    expect(sides.close).toHaveBeenCalledWith("side-1");

    await conn.handleRaw(JSON.stringify({ type: "side.start", sourceKind: "master", sourceId: "s1", text: "x", reqId: "q5" }));
    conn.dispose();
    await Promise.resolve();
    expect(sides.close).toHaveBeenCalledWith("side-2");
  });

  it("replays a pending interaction card on events.subscribe (survives a full client reload → turn not left hung)", async () => {
    const repos = new Repositories(openDb(":memory:"));
    const bus = new EventBus();
    const factory = (): WorkerLike => ({ start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
    const fleet = new FleetOrchestrator({ repos, bus, git: new FakeGitOps(), factory, worktreesDir: "/wt" });
    const sm = new SessionManager({ repos, bus, backends: { claude: fakeBackend([]) }, masterModel: "mm", fleet }, () => "s1");
    const reg = new InteractionRegistry(bus);
    const sent: string[] = [];
    const socket: ClientSocket = { send: (d) => sent.push(d) };
    const conn = new Connection(socket, sm, bus, fleet, repos, undefined, undefined, undefined, undefined, undefined, undefined, reg);

    // A master turn hits AskUserQuestion → a pending interaction is registered (the promise is intentionally not awaited).
    void reg.request("s1", "AskUserQuestion", { questions: [{ question: "pick", header: "h", options: [{ label: "a" }] }] }, { toolUseID: "R1" });
    sent.length = 0; // ignore the live emit (this socket isn't subscribed yet)

    // Full desktop reload: the fresh WS connection subscribes → the pending card MUST be replayed or the held turn hangs forever.
    await conn.handleRaw(JSON.stringify({ type: "events.subscribe" }));

    const replayed = parsed(sent).filter((m) => m.type === "event" && (m.event as { type?: string }).type === "interaction.request");
    expect(replayed).toHaveLength(1);
    expect((replayed[0]!.event as { requestId?: string }).requestId).toBe("R1");
  });

  it("creates a session and replies session.created", async () => {
    const { conn, sent } = setup();
    await conn.handleRaw(JSON.stringify({ type: "session.create", cwd: "/work" }));
    const msgs = parsed(sent);
    expect(msgs[0]!.type).toBe("session.created");
    expect(msgs[0]!.sessionId).toBe("s0");
    expect(msgs[0]!.cwd).toBe("/work");
  });

  it("session.open returns the same session id for a repeated key", async () => {
    const { conn, sent } = setup();
    await conn.handleRaw(JSON.stringify({ type: "session.open", key: "thread-1", cwd: "/work" }));
    await conn.handleRaw(JSON.stringify({ type: "session.open", key: "thread-1", cwd: "/work" }));
    const created = parsed(sent).filter((m) => m.type === "session.created");
    expect(created).toHaveLength(2);
    expect(created[0]!.sessionId).toBe(created[1]!.sessionId);
  });

  it("session.open honors an explicit provider on first creation of the key (finding [24])", async () => {
    const { conn, sent, repos } = setup();
    await conn.handleRaw(JSON.stringify({ type: "session.open", key: "thread-cx", cwd: "/work", provider: "codex" }));
    const created = parsed(sent).find((m) => m.type === "session.created");
    expect(repos.getSession(created!.sessionId as string)?.provider).toBe("codex"); // not the claude default
  });

  it("runs a turn and streams agent events to the socket", async () => {
    const { conn, sent } = setup();
    await conn.handleRaw(JSON.stringify({ type: "session.create", cwd: "/work" }));
    sent.length = 0;
    await conn.handleRaw(JSON.stringify({ type: "session.send", sessionId: "s0", text: "hello" }));
    const types = parsed(sent)
      .filter((m) => m.type === "event")
      .map((m) => (m.event as { type: string }).type);
    expect(types).toContain("master.message");
    expect(types).toContain("master.result");
  });

  it("session.send with a reqId is acked on success (so the desktop can await it)", async () => {
    const { conn, sent } = setup();
    await conn.handleRaw(JSON.stringify({ type: "session.create", cwd: "/work" }));
    sent.length = 0;
    await conn.handleRaw(JSON.stringify({ type: "session.send", sessionId: "s0", text: "hi", clientMsgId: "c1", reqId: "q1" }));
    const acks = parsed(sent).filter((m) => m.type === "fleet.ack");
    expect(acks).toContainEqual(expect.objectContaining({ reqId: "q1", action: "send", id: "s0" }));
  });

  it("session.send to an unknown session replies error+reqId (so the desktop can roll back the bubble)", async () => {
    const { conn, sent } = setup();
    await conn.handleRaw(JSON.stringify({ type: "session.send", sessionId: "nope", text: "hi", clientMsgId: "c1", reqId: "q2" }));
    const err = parsed(sent).find((m) => m.type === "error");
    expect(err).toBeTruthy();
    expect(err!.reqId).toBe("q2");
  });

  it("replies with error on invalid message", async () => {
    const { conn, sent } = setup();
    await conn.handleRaw("{bad json");
    expect(parsed(sent)[0]!.type).toBe("error");
  });

  it("replies error+reqId when a handler throws (does not hang the client)", async () => {
    const { conn, sent } = setup();
    await conn.handleRaw(JSON.stringify({ type: "repos.register", reqId: "q1", name: "dup", path: "/p", description: "d" }));
    sent.length = 0;
    // Re-registering the same name -> createRepo throws on UNIQUE violation. handleRaw must not reject; it should reply with error+reqId.
    await expect(conn.handleRaw(JSON.stringify({ type: "repos.register", reqId: "q2", name: "dup", path: "/p", description: "d" }))).resolves.toBeUndefined();
    const err = parsed(sent).find((m) => m.type === "error");
    expect(err).toBeTruthy();
    expect(err!.reqId).toBe("q2");
  });

  it("a schema-invalid frame with a reqId gets an error reply carrying that reqId (no hung request)", async () => {
    const { conn, sent } = setup();
    // Invalid cron (minute 61) → automationInputSchema.superRefine rejects it AT PARSE TIME (parseClientMessage throws).
    // The client's request() has a pending reqId "q9" → the error reply must echo it or the desktop promise hangs forever.
    await conn.handleRaw(JSON.stringify({ type: "automation.create", reqId: "q9", automation: { name: "n", trigger: { kind: "cron", cron: "61 3 * * *", timezone: "UTC" }, action: { kind: "master", prompt: "p", cwd: "/w", sessionMode: "reuse" }, enabled: true } }));
    const errs = parsed(sent).filter((m) => m.type === "error");
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]).toMatchObject({ reqId: "q9" });
  });

  it("worker.send surfaces an error for an unknown/not-running agent (no silent swallow)", async () => {
    const { conn, sent } = setup();
    await conn.handleRaw(JSON.stringify({ type: "worker.send", id: "nope", text: "hi", reqId: "q1" }));
    const err = parsed(sent).find((m) => m.type === "error");
    expect(err).toBeTruthy();
    expect(err!.reqId).toBe("q1");
  });

  it("models.list replies a non-empty model list (static fallback when no provider is injected)", async () => {
    const { conn, sent } = setup();
    await conn.handleRaw(JSON.stringify({ type: "models.list", reqId: "ml1" }));
    const msg = parsed(sent).find((m) => m.type === "models.result");
    expect(msg).toBeTruthy();
    expect(msg!.reqId).toBe("ml1");
    expect((msg!.models as Array<{ id: string }>).some((x) => x.id === "claude-opus-4-8")).toBe(true);
  });

  it("models.list returns the injected provider's list", async () => {
    const sent: string[] = [];
    const repos = new Repositories(openDb(":memory:"));
    const bus = new EventBus();
    const factory = (): WorkerLike => ({ start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
    const fleet = new FleetOrchestrator({ repos, bus, git: new FakeGitOps(), factory, worktreesDir: "/wt" });
    let n = 0;
    const sm = new SessionManager({ repos, bus, backends: { claude: fakeBackend([]) }, masterModel: "mm", fleet }, () => `s${n++}`);
    const socket: ClientSocket = { send: (d) => sent.push(d) };
    const models = { list: async () => [{ id: "x-model", displayName: "X Model" }] };
    const conn = new Connection(socket, sm, bus, fleet, repos, undefined, undefined, undefined, undefined, undefined, models);
    await conn.handleRaw(JSON.stringify({ type: "models.list", reqId: "ml2" }));
    const msg = parsed(sent).find((m) => m.type === "models.result");
    expect(msg!.models).toEqual([{ id: "x-model", displayName: "X Model" }]);
  });

  it("codex.models.list replies null when no provider is injected", async () => {
    const { conn, sent } = setup();
    await conn.handleRaw(JSON.stringify({ type: "codex.models.list", reqId: "cx1" }));
    const msg = parsed(sent).find((m) => m.type === "codex.models.result");
    expect(msg).toBeTruthy();
    expect(msg!.reqId).toBe("cx1");
    expect(msg!.models).toBeNull();
  });

  it("codex.models.list returns the injected provider's list", async () => {
    const sent: string[] = [];
    const repos = new Repositories(openDb(":memory:"));
    const bus = new EventBus();
    const factory = (): WorkerLike => ({ start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
    const fleet = new FleetOrchestrator({ repos, bus, git: new FakeGitOps(), factory, worktreesDir: "/wt" });
    let n = 0;
    const sm = new SessionManager({ repos, bus, backends: { claude: fakeBackend([]) }, masterModel: "mm", fleet }, () => `s${n++}`);
    const socket: ClientSocket = { send: (d) => sent.push(d) };
    const codexModels = { list: async () => [{ id: "gpt-5.5", displayName: "GPT-5.5", defaultEffort: "xhigh", supportedEfforts: ["low", "medium", "high", "xhigh"], isDefault: true }] };
    const conn = new Connection(socket, sm, bus, fleet, repos, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, codexModels);
    await conn.handleRaw(JSON.stringify({ type: "codex.models.list", reqId: "cx2" }));
    const msg = parsed(sent).find((m) => m.type === "codex.models.result");
    expect(msg!.models).toEqual([{ id: "gpt-5.5", displayName: "GPT-5.5", defaultEffort: "xhigh", supportedEfforts: ["low", "medium", "high", "xhigh"], isDefault: true }]);
  });

  it("session.fork forwards the target provider → a cross-provider handoff session (provider + marker set)", async () => {
    const { conn, sent, repos } = setup();
    repos.createSession({ id: "src", cwd: "/x", provider: "claude" });
    repos.addSessionEvent({ sessionId: "src", seq: 0, type: "master.message", payloadJson: JSON.stringify({ kind: "message", role: "user", content: "hi" }) });
    await conn.handleRaw(JSON.stringify({ type: "session.fork", sessionId: "src", reqId: "sf", provider: "codex" }));
    const created = parsed(sent).find((m) => m.type === "session.created");
    expect(created).toBeTruthy();
    const row = repos.getSession(created!.sessionId)!;
    expect(row.provider).toBe("codex");
    expect(row.handoff_from_provider).toBe("claude");
  });

  it("worker.fork forwards provider/model/effort to fleet.fork as the target", async () => {
    const calls: Array<{ id: string; target?: unknown }> = [];
    const sent: string[] = [];
    const conn = makeConn(sent, { fleet: { fork: async (id, target) => { calls.push({ id, target }); return { id: "nw" }; } } });
    await conn.handleRaw(JSON.stringify({ type: "worker.fork", reqId: "wf", id: "src", provider: "codex", model: "gpt-5.5", effort: "high" }));
    expect(calls[0]!.target).toEqual({ provider: "codex", model: "gpt-5.5", effort: "high" });
    // makeConn's socket pushes already-parsed objects (not JSON strings) into `sent`.
    const res = (sent as unknown as Array<Record<string, unknown>>).find((m) => m.type === "fleet.spawn.result");
    expect(res!.id).toBe("nw");
  });

  it("codex.authStatus replies null when no provider is injected", async () => {
    const { conn, sent } = setup();
    await conn.handleRaw(JSON.stringify({ type: "codex.authStatus", reqId: "ca1" }));
    const msg = parsed(sent).find((m) => m.type === "codex.authStatus.result");
    expect(msg).toBeTruthy();
    expect(msg!.reqId).toBe("ca1");
    expect(msg!.status).toBeNull();
  });

  it("codex.authStatus returns the injected provider's status", async () => {
    const sent: string[] = [];
    const repos = new Repositories(openDb(":memory:"));
    const bus = new EventBus();
    const factory = (): WorkerLike => ({ start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
    const fleet = new FleetOrchestrator({ repos, bus, git: new FakeGitOps(), factory, worktreesDir: "/wt" });
    let n = 0;
    const sm = new SessionManager({ repos, bus, backends: { claude: fakeBackend([]) }, masterModel: "mm", fleet }, () => `s${n++}`);
    const socket: ClientSocket = { send: (d) => sent.push(d) };
    const codexAuth = { status: async () => ({ method: "chatgpt" as const, ready: true, hint: "u@x.io · plus" }) };
    const conn = new Connection(socket, sm, bus, fleet, repos, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, codexAuth);
    await conn.handleRaw(JSON.stringify({ type: "codex.authStatus", reqId: "ca2" }));
    const msg = parsed(sent).find((m) => m.type === "codex.authStatus.result");
    expect(msg!.status).toEqual({ method: "chatgpt", ready: true, hint: "u@x.io · plus" });
  });

  it("repos.register rejects an unsafe base ref (.. range), matching the MCP tool's isSafeGitRef gate", async () => {
    const { conn, sent } = setup();
    await conn.handleRaw(JSON.stringify({ type: "repos.register", reqId: "rr1", name: "app", path: "/code/app", description: "d", base: "main..HEAD" }));
    const msgs = parsed(sent);
    const err = msgs.find((m) => m.type === "error");
    expect(err).toBeTruthy();
    expect(err!.reqId).toBe("rr1");
    expect(String(err!.message)).toMatch(/base/i);
    expect(msgs.find((m) => m.type === "repos.ack")).toBeFalsy(); // must not be registered
  });

  it("fleet.spawn rejects an unsafe base ref (.. range), matching the MCP tool's isSafeGitRef gate", async () => {
    const { conn, sent, repos } = setup();
    repos.createRepo({ id: "r", name: "app", path: "/code/app", description: "d" });
    // '..' is range/parent syntax — not an ordinary base ref. MCP spawn_worker blocks it, and the WS path must block it too.
    await conn.handleRaw(JSON.stringify({ type: "fleet.spawn", reqId: "sp1", repo: "app", task: "t", base: "main..HEAD" }));
    const msgs = parsed(sent);
    const err = msgs.find((m) => m.type === "error");
    expect(err).toBeTruthy();
    expect(err!.reqId).toBe("sp1");
    expect(String(err!.message)).toMatch(/base/i);
    expect(msgs.find((m) => m.type === "fleet.spawn.result")).toBeFalsy(); // spawn must not happen
  });

  it("lists sessions", async () => {
    const { conn, sent } = setup();
    await conn.handleRaw(JSON.stringify({ type: "session.create", cwd: "/a" }));
    sent.length = 0;
    await conn.handleRaw(JSON.stringify({ type: "session.list" }));
    const msg = parsed(sent).find((m) => m.type === "session.list.result");
    expect((msg!.sessions as unknown[]).length).toBe(1);
  });
});

describe("Connection v2 routes", () => {
  it("fleet.list returns fleet rows with reqId", async () => {
    const sent: any[] = [];
    const fleet = { list: () => [{ id: "a1", label: "app", repoPath: "/r", status: "running", branch: "rookery/a1", model: null }], diff: async () => "D", stop: async () => {}, discard: async () => {} };
    const conn = makeConn(sent, { fleet });
    await conn.handleRaw(JSON.stringify({ type: "fleet.list", reqId: "r1" }));
    expect(sent.at(-1)).toMatchObject({ type: "fleet.list.result", reqId: "r1", fleet: [{ id: "a1", branch: "rookery/a1" }] });
  });

  it("fleet.diff delegates and echoes reqId", async () => {
    const sent: any[] = [];
    const fleet = { list: () => [], diff: async (id: string) => `diff of ${id}`, stop: async () => {}, discard: async () => {} };
    const conn = makeConn(sent, { fleet });
    await conn.handleRaw(JSON.stringify({ type: "fleet.diff", reqId: "r2", id: "a1" }));
    expect(sent.at(-1)).toMatchObject({ type: "fleet.diff.result", reqId: "r2", id: "a1", diff: "diff of a1" });
  });

  it("fleet.stop/discard ack — discard is unified with delete (full removal, not keep-row discard)", async () => {
    const sent: any[] = [];
    const calls: string[] = [];
    const fleet = { list: () => [], diff: async () => "", stop: async (id: string) => { calls.push("stop:" + id); }, delete: async (id: string) => { calls.push("delete:" + id); } };
    const conn = makeConn(sent, { fleet });
    await conn.handleRaw(JSON.stringify({ type: "fleet.stop", reqId: "r3", id: "a1" }));
    await conn.handleRaw(JSON.stringify({ type: "fleet.discard", reqId: "r4", id: "a2" }));
    expect(calls).toEqual(["stop:a1", "delete:a2"]); // fleet.discard now routes to the full delete
    expect(sent.at(-1)).toMatchObject({ type: "fleet.ack", action: "discard", id: "a2", reqId: "r4" });
  });

  it("worker.interrupt routes to fleet.interrupt and acks", async () => {
    const sent: any[] = [];
    const calls: string[] = [];
    const fleet: FleetOverride = { interrupt: async (id: string) => { calls.push("interrupt:" + id); } };
    const conn = makeConn(sent, { fleet });
    await conn.handleRaw(JSON.stringify({ type: "worker.interrupt", reqId: "r5", id: "a1" }));
    expect(calls).toEqual(["interrupt:a1"]);
    expect(sent.at(-1)).toMatchObject({ type: "fleet.ack", action: "interrupt", id: "a1", reqId: "r5" });
  });

  it("worker.setPermissionMode routes to fleet.setPermissionMode (fire-and-forget)", async () => {
    const sent: any[] = [];
    const calls: Array<[string, string]> = [];
    const fleet: FleetOverride = { setPermissionMode: async (id: string, mode: string) => { calls.push([id, mode]); } };
    const conn = makeConn(sent, { fleet });
    await conn.handleRaw(JSON.stringify({ type: "worker.setPermissionMode", id: "a1", permissionMode: "plan" }));
    expect(calls).toEqual([["a1", "plan"]]);
    expect(sent).toEqual([]); // fire-and-forget — no ack
  });

  it("worker.setModel with a reqId is acked on success (so the desktop can await it and not falsely roll back)", async () => {
    const sent: any[] = [];
    const fleet: FleetOverride = { setModel: async () => {} }; // does not throw → success path
    const conn = makeConn(sent, { fleet });
    await conn.handleRaw(JSON.stringify({ type: "worker.setModel", id: "w1", model: "sonnet", reqId: "q1" }));
    const acks = sent.filter((m) => m.type === "fleet.ack");
    expect(acks).toContainEqual(expect.objectContaining({ reqId: "q1", action: "setModel", id: "w1" }));
  });

  it("worker.setPermissionMode with a reqId is acked on success", async () => {
    const sent: any[] = [];
    const fleet: FleetOverride = { setPermissionMode: async () => {} }; // does not throw → success path
    const conn = makeConn(sent, { fleet });
    await conn.handleRaw(JSON.stringify({ type: "worker.setPermissionMode", id: "w1", permissionMode: "plan", reqId: "q1" }));
    const acks = sent.filter((m) => m.type === "fleet.ack");
    expect(acks).toContainEqual(expect.objectContaining({ reqId: "q1", action: "setPermissionMode", id: "w1" }));
  });

  it("worker.setPermissionMode rejects non-bypass modes (security boundary: default/acceptEdits never reach the worker)", async () => {
    // The enum z.enum(["bypassPermissions","plan"]) on worker.setPermissionMode must reject the
    // other SDK modes at parse time, so they can never be routed to a live worker.
    for (const mode of ["default", "acceptEdits"]) {
      const sent: any[] = [];
      const calls: Array<[string, string]> = [];
      const fleet: FleetOverride = { setPermissionMode: async (id: string, m: string) => { calls.push([id, m]); } };
      const conn = makeConn(sent, { fleet });
      await conn.handleRaw(JSON.stringify({ type: "worker.setPermissionMode", id: "a1", permissionMode: mode }));
      expect(calls).toEqual([]); // never routed to the fleet
      const err = sent.find((m) => m.type === "error");
      expect(err, `expected an error reply for permissionMode="${mode}"`).toBeTruthy();
    }
  });

  it("repos CRUD + list", async () => {
    const sent: any[] = [];
    const conn = makeConn(sent, {}); // repos is a real Repositories(:memory:)
    await conn.handleRaw(JSON.stringify({ type: "repos.register", reqId: "r5", name: "app", path: "/p", description: "결제" }));
    await conn.handleRaw(JSON.stringify({ type: "repos.list", reqId: "r6" }));
    expect(sent.at(-1)).toMatchObject({ type: "repos.list.result", reqId: "r6", repos: [{ id: expect.any(String), name: "app", description: "결제" }] });
  });

  it("session.history returns persisted transcript events", async () => {
    const sent: any[] = [];
    const conn = makeConn(sent, {}); // creates session s1
    await conn.handleRaw(JSON.stringify({ type: "session.history", reqId: "r7", sessionId: "s1" }));
    expect(sent.at(-1)).toMatchObject({ type: "session.history.result", reqId: "r7", sessionId: "s1" });
    expect(Array.isArray((sent.at(-1) as any).events)).toBe(true); // event array (seq/type/payload) — populated by the master record
  });

  it("session.history skips a corrupt row and appends a master.notice; 0 corrupt → no notice", async () => {
    // Arrange: create repos with 2 healthy + 1 corrupt row for session "sess-1"
    const repos = new Repositories(openDb(":memory:"));
    const bus = new EventBus();
    const factory = (): WorkerLike => ({ start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
    const realFleet = new FleetOrchestrator({ repos, bus, git: new FakeGitOps(), factory, worktreesDir: "/wt" });
    const sm = new SessionManager({ repos, bus, backends: { claude: fakeBackend([]) }, masterModel: "mm", fleet: realFleet }, () => "sess-1");
    const sent: any[] = [];
    const socket: ClientSocket = { send: (d: string) => sent.push(JSON.parse(d) as unknown) };
    const conn = new Connection(socket, sm, bus, realFleet, repos);

    // Create the session row (required by FK) then insert 2 healthy rows and 1 corrupt row (invalid JSON)
    repos.createSession({ id: "sess-1", cwd: "/w" });
    repos.addSessionEvent({ sessionId: "sess-1", seq: 0, type: "master.message", payloadJson: JSON.stringify({ type: "master.message", sessionId: "sess-1", role: "assistant", content: "hello" }) });
    repos.addSessionEvent({ sessionId: "sess-1", seq: 1, type: "master.message", payloadJson: "{" }); // corrupt
    repos.addSessionEvent({ sessionId: "sess-1", seq: 2, type: "master.message", payloadJson: JSON.stringify({ type: "master.message", sessionId: "sess-1", role: "assistant", content: "world" }) });

    await conn.handleRaw(JSON.stringify({ type: "session.history", reqId: "rh1", sessionId: "sess-1" }));

    const msg = sent.find((m: any) => m.type === "session.history.result" && m.reqId === "rh1");
    expect(msg, "response must still be sent even with a corrupt row").toBeTruthy();
    expect(msg.sessionId).toBe("sess-1");

    const events = msg.events as Array<{ seq: number; type: string; payload: unknown }>;
    // 2 healthy + 1 trailing master.notice
    const healthy = events.filter((e) => e.type === "master.message");
    const notice = events.filter((e) => e.type === "master.notice");
    expect(healthy).toHaveLength(2);
    expect(notice).toHaveLength(1);
    expect(notice[0]!.seq).toBe(-1);
    expect((notice[0]!.payload as any).text).toMatch(/could not be loaded/);
    // notice must be last
    expect(events.at(-1)!.type).toBe("master.notice");

    // Case: 0 corrupt → no notice appended
    const sent2: any[] = [];
    const repos2 = new Repositories(openDb(":memory:"));
    const factory2 = (): WorkerLike => ({ start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
    const bus2 = new EventBus();
    const fleet2 = new FleetOrchestrator({ repos: repos2, bus: bus2, git: new FakeGitOps(), factory: factory2, worktreesDir: "/wt" });
    const sm2 = new SessionManager({ repos: repos2, bus: bus2, backends: { claude: fakeBackend([]) }, masterModel: "mm", fleet: fleet2 }, () => "sess-2");
    const conn2 = new Connection({ send: (d: string) => sent2.push(JSON.parse(d) as unknown) }, sm2, bus2, fleet2, repos2);
    repos2.createSession({ id: "sess-2", cwd: "/w" });
    repos2.addSessionEvent({ sessionId: "sess-2", seq: 0, type: "master.system", payloadJson: JSON.stringify({ type: "master.system", sessionId: "sess-2", text: "ok" }) });
    await conn2.handleRaw(JSON.stringify({ type: "session.history", reqId: "rh2", sessionId: "sess-2" }));
    const msg2 = sent2.find((m: any) => m.type === "session.history.result");
    expect(msg2).toBeTruthy();
    const evs2 = msg2.events as Array<{ type: string }>;
    expect(evs2.some((e) => e.type === "master.notice")).toBe(false);
  });

  it("fleet.subscribe routes @fleet events to the socket", async () => {
    const sent: any[] = [];
    const { conn, bus } = makeConnWithBus(sent);
    await conn.handleRaw(JSON.stringify({ type: "fleet.subscribe" }));
    bus.emit({ type: "worker.status", sessionId: "sX", workerId: "a9", status: "running" });
    expect(sent.some((m) => m.type === "event" && m.event?.workerId === "a9")).toBe(true);
  });

  it("events.subscribe receives all events, and per-session subscribe is not doubled", async () => {
    const sent: any[] = [];
    const { conn, bus } = makeConnWithBus(sent);
    await conn.handleRaw(JSON.stringify({ type: "events.subscribe" }));
    // session.create tries subscribe(sessionId) internally, but since @all is already subscribed it should be skipped.
    await conn.handleRaw(JSON.stringify({ type: "session.create", reqId: "c1" }));
    const created = sent.find((m) => m.type === "session.created");
    bus.emit({ type: "master.message", sessionId: created.sessionId, role: "assistant", content: "hi" });
    const got = sent.filter((m) => m.type === "event" && m.event?.content === "hi");
    expect(got.length).toBe(1); // @all only once (no duplicate session subscription)
  });

  it("events.subscribe added AFTER a session subscription drops the prior sub (no double delivery)", async () => {
    const sent: any[] = [];
    const { conn, bus } = makeConnWithBus(sent);
    // Reverse order: first subscribe to the session (session.create → subscribe(sessionId)), then @all.
    await conn.handleRaw(JSON.stringify({ type: "session.create", reqId: "c1" }));
    const created = sent.find((m) => m.type === "session.created");
    await conn.handleRaw(JSON.stringify({ type: "events.subscribe" }));
    bus.emit({ type: "master.message", sessionId: created.sessionId, role: "assistant", content: "hi" });
    const got = sent.filter((m) => m.type === "event" && m.event?.content === "hi");
    expect(got.length).toBe(1); // previously both the session sub and @all sub stayed alive, delivering twice
  });
});

describe("Connection worker chat routes", () => {
  it("serves workflow snapshots and selected-agent history through the injected provider", async () => {
    const { sent, repos, bus, fleet, sm, socket } = setup();
    const snapshot = { taskId: "task-1", workflowName: "audit", summary: "Audit", status: "running" as const, visibility: "live" as const, startedAt: 1, lastActivityAt: 2, counts: { started: 1, active: 1, completed: 0, stopped: 0 }, agents: [] };
    const workflows = {
      list: vi.fn(() => [snapshot]),
      agentHistory: vi.fn(async () => [{ data: { kind: "message" as const, role: "assistant", content: "agent detail" }, createdAt: "2026-07-16T00:00:00.000Z" }]),
    };
    const conn = new Connection(socket, sm, bus, fleet, repos,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, workflows);

    await conn.handleRaw(JSON.stringify({ type: "workflow.list", reqId: "wf1", workerId: "a1" }));
    await conn.handleRaw(JSON.stringify({ type: "workflow.agent.history", reqId: "wf2", workerId: "a1", taskId: "task-1", agentId: "agent-1" }));

    expect(parsed(sent).at(-2)).toMatchObject({ type: "workflow.list.result", reqId: "wf1", workerId: "a1", runs: [snapshot] });
    expect(parsed(sent).at(-1)).toMatchObject({ type: "workflow.agent.history.result", reqId: "wf2", workerId: "a1", taskId: "task-1", agentId: "agent-1", events: [{ data: { content: "agent detail" } }] });
    expect(workflows.agentHistory).toHaveBeenCalledWith("a1", "task-1", "agent-1");
  });

  it("worker.history returns the transcript with reqId", async () => {
    const sent: any[] = [];
    const fleet: FleetOverride = {
      transcript: (id) => [{ seq: 0, type: "message", payload: { kind: "message", role: "assistant", content: `hi ${id}` } }],
    };
    const conn = makeConn(sent, { fleet });
    await conn.handleRaw(JSON.stringify({ type: "worker.history", reqId: "h1", id: "a1" }));
    expect(sent.at(-1)).toMatchObject({ type: "worker.history.result", reqId: "h1", id: "a1" });
    expect((sent.at(-1) as any).events[0].payload.content).toBe("hi a1");
  });

  it("worker.send forwards to the fleet, fire-and-forget", async () => {
    const sent: any[] = [];
    const calls: string[] = [];
    const fleet: FleetOverride = { send: (id, text) => calls.push(`${id}:${text}`) };
    const conn = makeConn(sent, { fleet });
    await conn.handleRaw(JSON.stringify({ type: "worker.send", id: "a1", text: "go on" }));
    expect(calls).toEqual(["a1:go on"]);
    expect(sent).toEqual([]);
  });

  it("worker.send surfaces (does not swallow) errors from a non-running agent", async () => {
    const sent: any[] = [];
    const fleet: FleetOverride = { send: () => { throw new Error("not running"); } };
    const conn = makeConn(sent, { fleet });
    await expect(conn.handleRaw(JSON.stringify({ type: "worker.send", id: "a1", text: "x", reqId: "q9" }))).resolves.toBeUndefined();
    expect(sent.find((m) => m.type === "error" && m.reqId === "q9")).toBeTruthy();
  });

  it("worker.send with a reqId is acked on success (so the desktop can await it)", async () => {
    const sent: any[] = [];
    const fleet: FleetOverride = { send: () => {} }; // does not throw → success path
    const conn = makeConn(sent, { fleet });
    await conn.handleRaw(JSON.stringify({ type: "worker.send", id: "w1", text: "hi", clientMsgId: "c1", reqId: "q1" }));
    const acks = sent.filter((m) => m.type === "fleet.ack");
    expect(acks).toContainEqual(expect.objectContaining({ reqId: "q1", action: "send", id: "w1" }));
  });

  it("fleet.spawn resolves a registered repo, spawns, returns the new id", async () => {
    const sent: any[] = [];
    const calls: Array<{ repoPath: string; task: string; label: string }> = [];
    const fleet: FleetOverride = { spawn: (input) => { calls.push(input); return { id: "newsub" }; } };
    const conn = makeConn(sent, { fleet });
    await conn.handleRaw(JSON.stringify({ type: "repos.register", reqId: "r0", name: "demo", path: "/code/demo", description: "d" }));
    await conn.handleRaw(JSON.stringify({ type: "fleet.spawn", reqId: "sp", repo: "demo", task: "hello.txt 만들기" }));
    expect(calls[0]).toMatchObject({ repoPath: "/code/demo", task: "hello.txt 만들기", label: "hello.txt 만들기" });
    expect(sent.at(-1)).toMatchObject({ type: "fleet.spawn.result", reqId: "sp", id: "newsub" });
  });

  it("fleet.spawn threads permissionMode into fleet.spawn", async () => {
    const sent: any[] = [];
    const calls: Array<{ permissionMode?: string }> = [];
    const fleet: FleetOverride = { spawn: (input) => { calls.push(input); return { id: "newsub" }; } };
    const conn = makeConn(sent, { fleet });
    await conn.handleRaw(JSON.stringify({ type: "repos.register", reqId: "r0", name: "demo", path: "/code/demo", description: "d" }));
    await conn.handleRaw(JSON.stringify({ type: "fleet.spawn", reqId: "sp", repo: "demo", task: "t", permissionMode: "plan" }));
    expect(calls[0]).toMatchObject({ permissionMode: "plan" });
    expect(sent.at(-1)).toMatchObject({ type: "fleet.spawn.result", reqId: "sp", id: "newsub" });
  });

  it("fleet.spawn threads costBudgetUsd into fleet.spawn", async () => {
    const sent: any[] = [];
    const calls: Array<{ costBudgetUsd?: number }> = [];
    const fleet: FleetOverride = { spawn: (input) => { calls.push(input); return { id: "newsub" }; } };
    const conn = makeConn(sent, { fleet });
    await conn.handleRaw(JSON.stringify({ type: "repos.register", reqId: "r0", name: "demo", path: "/code/demo", description: "d" }));
    await conn.handleRaw(JSON.stringify({ type: "fleet.spawn", reqId: "sp", repo: "demo", task: "t", costBudgetUsd: 3.5 }));
    expect(calls[0]).toMatchObject({ costBudgetUsd: 3.5 });
    expect(sent.at(-1)).toMatchObject({ type: "fleet.spawn.result", reqId: "sp", id: "newsub" });
  });

  it("fleet.spawn omits costBudgetUsd (undefined) when the client doesn't send it", async () => {
    const sent: any[] = [];
    const calls: Array<{ costBudgetUsd?: number }> = [];
    const fleet: FleetOverride = { spawn: (input) => { calls.push(input); return { id: "newsub" }; } };
    const conn = makeConn(sent, { fleet });
    await conn.handleRaw(JSON.stringify({ type: "repos.register", reqId: "r0", name: "demo", path: "/code/demo", description: "d" }));
    await conn.handleRaw(JSON.stringify({ type: "fleet.spawn", reqId: "sp", repo: "demo", task: "t" }));
    expect(calls[0]?.costBudgetUsd).toBeUndefined();
  });

  it("fleet.spawn errors on an unknown repo", async () => {
    const sent: any[] = [];
    const conn = makeConn(sent, { fleet: { spawn: () => ({ id: "x" }) } });
    await conn.handleRaw(JSON.stringify({ type: "fleet.spawn", reqId: "sp2", repo: "nope", task: "t" }));
    expect(sent.at(-1)).toMatchObject({ type: "error", reqId: "sp2" });
  });
});

describe("Connection settings", () => {
  it("settings.get returns defaults; settings.set persists and reflects", async () => {
    const repos = new Repositories(openDb(":memory:"));
    const bus = new EventBus();
    const factory = (): WorkerLike => ({ start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
    const fleet = new FleetOrchestrator({ repos, bus, git: new FakeGitOps(), factory, worktreesDir: "/wt" });
    const sm = new SessionManager({ repos, bus, backends: { claude: fakeBackend([]) }, masterModel: "mm", fleet });
    const config = loadConfig({});
    const settings = new Settings(repos, config);
    const sent: any[] = [];
    const conn = new Connection({ send: (d) => sent.push(JSON.parse(d)) }, sm, bus, fleet, repos, undefined, settings);

    await conn.handleRaw(JSON.stringify({ type: "settings.get", reqId: "g1" }));
    expect(sent.at(-1)).toMatchObject({ type: "settings.result", reqId: "g1", settings: { masterModel: config.masterModel } });

    await conn.handleRaw(JSON.stringify({ type: "settings.set", reqId: "s1", settings: { masterModel: "claude-sonnet-4-6" } }));
    expect(sent.at(-1).settings).toMatchObject({ masterModel: "claude-sonnet-4-6" });
    expect(settings.masterModel()).toBe("claude-sonnet-4-6");

    // codex settings keys must round-trip over the protocol (not stripped by the zod schema).
    await conn.handleRaw(JSON.stringify({ type: "settings.set", reqId: "s2", settings: { codexWorkerModel: "gpt-5.5-codex", codexBin: "/opt/codex/bin/codex" } }));
    expect(sent.at(-1).settings).toMatchObject({ codexWorkerModel: "gpt-5.5-codex", codexBin: "/opt/codex/bin/codex" });
    expect(settings.codexWorkerModel()).toBe("gpt-5.5-codex");
    expect(settings.codexBin()).toBe("/opt/codex/bin/codex");
  });

  it("external MCP: mcp.status/regenerate reply, and settings.set{mcpExposure} triggers reconcile", async () => {
    const repos = new Repositories(openDb(":memory:"));
    const bus = new EventBus();
    const factory = (): WorkerLike => ({ start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
    const fleet = new FleetOrchestrator({ repos, bus, git: new FakeGitOps(), factory, worktreesDir: "/wt" });
    const sm = new SessionManager({ repos, bus, backends: { claude: fakeBackend([]) }, masterModel: "mm", fleet });
    const settings = new Settings(repos, loadConfig({}));
    let reconciles = 0;
    let regens = 0;
    const externalMcp = {
      reconcile: () => { reconciles++; },
      status: () => ({ scope: settings.mcpExposure(), url: settings.mcpExposure() === "off" ? null : "http://127.0.0.1:8787/mcp-ext/tok" }),
      regenerateToken: () => { regens++; return { scope: settings.mcpExposure(), url: "http://127.0.0.1:8787/mcp-ext/new" }; },
      handleHttp: () => false,
    } as unknown as import("../../src/daemon/external-mcp-controller.js").ExternalMcpController;
    const sent: any[] = [];
    // externalMcp is the 17th constructor arg (after codexAuth).
    const conn = new Connection({ send: (d) => sent.push(JSON.parse(d)) }, sm, bus, fleet, repos, undefined, settings,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, externalMcp);

    await conn.handleRaw(JSON.stringify({ type: "mcp.status", reqId: "m1" }));
    expect(sent.at(-1)).toMatchObject({ type: "mcp.status.result", reqId: "m1", scope: "off", url: null });

    await conn.handleRaw(JSON.stringify({ type: "settings.set", reqId: "m2", settings: { mcpExposure: "full" } }));
    expect(reconciles).toBe(1); // mcpExposure in the patch → reconcile()
    expect(settings.mcpExposure()).toBe("full");

    await conn.handleRaw(JSON.stringify({ type: "mcp.status", reqId: "m3" }));
    expect(sent.at(-1)).toMatchObject({ type: "mcp.status.result", reqId: "m3", scope: "full", url: "http://127.0.0.1:8787/mcp-ext/tok" });

    await conn.handleRaw(JSON.stringify({ type: "mcp.regenerate_token", reqId: "m4" }));
    expect(regens).toBe(1);
    expect(sent.at(-1)).toMatchObject({ type: "mcp.status.result", reqId: "m4", url: "http://127.0.0.1:8787/mcp-ext/new" });

    // a settings.set that does NOT touch mcpExposure must not reconcile
    await conn.handleRaw(JSON.stringify({ type: "settings.set", reqId: "m5", settings: { masterModel: "x" } }));
    expect(reconciles).toBe(1);
  });

  it("commands.list projects authoritative session and worker snapshots into structured actions", async () => {
    const repos = new Repositories(openDb(":memory:"));
    const bus = new EventBus();
    const fleet = {} as FleetOrchestrator;
    const catalog = { forCwd: vi.fn(async () => [{ name: "dead-cwd", description: "must not run" }]) };
    const snapshot = (target: { kind: "session" | "worker"; id: string }) => ({
      target: { ...target, label: target.id, provider: "codex" as const, cwd: "/authoritative" },
      generatedAt: "2026-07-14T00:00:00.000Z",
      entries: [
        {
          id: `managed:${target.id}:skill:release`, kind: "skill" as const, name: "release", description: "Ship",
          provider: "rookery" as const, source: "Pack", scope: target.kind, state: "applied" as const, evidence: "runtime" as const,
          invocation: { type: "prompt" as const, name: "$release" },
          managed: { packInstanceId: "pack", packId: "team", bindingId: "binding", scopeKind: target.kind, enabled: true },
        },
        {
          id: "codex.command.clear", kind: "command" as const, name: "/clear", provider: "codex" as const,
          source: "Codex inventory", scope: target.kind, state: "applied" as const, evidence: "runtime" as const,
        },
      ],
      diagnostics: [],
    });
    const capabilities = { snapshot: vi.fn(async (target: { kind: "session" | "worker"; id: string }) => snapshot(target)) };
    const sent: any[] = [];
    const socket: ClientSocket = { send: (d: string) => sent.push(JSON.parse(d) as unknown) };
    const conn = new Connection(socket, {} as unknown as SessionManager, bus, fleet, repos,
      undefined, undefined, catalog, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, capabilities as never);

    await conn.handleRaw(JSON.stringify({ type: "commands.list", reqId: "q1", workerId: "w1", cwd: "/spoof", provider: "claude" }));
    await conn.handleRaw(JSON.stringify({ type: "commands.list", reqId: "q2", sessionId: "s1", cwd: "/spoof", provider: "claude" }));

    expect(capabilities.snapshot).toHaveBeenNthCalledWith(1, { kind: "worker", id: "w1" });
    expect(capabilities.snapshot).toHaveBeenNthCalledWith(2, { kind: "session", id: "s1" });
    expect(catalog.forCwd).not.toHaveBeenCalled();
    for (const reqId of ["q1", "q2"]) {
      const commands = sent.find((message) => message.reqId === reqId).commands;
      expect(commands.find((candidate: { name: string }) => candidate.name === "release")).toMatchObject({
        action: { type: "insert-prompt", text: "$release" },
      });
      expect(commands.find((candidate: { name: string }) => candidate.name === "capabilities")).toMatchObject({
        action: { type: "open-capability-center", tab: "effective" },
      });
      expect(commands.some((candidate: { name: string }) => candidate.name === "clear")).toBe(false);
      expect(commands.every((candidate: { action?: unknown }) => candidate.action !== undefined)).toBe(true);
    }
  });

  it("commands.list returns correlated target errors and rejects an ambiguous target", async () => {
    const repos = new Repositories(openDb(":memory:"));
    const bus = new EventBus();
    const capabilities = { snapshot: vi.fn(async () => { throw new Error("unknown capability target: session:missing"); }) };
    const sent: any[] = [];
    const socket: ClientSocket = { send: (d: string) => sent.push(JSON.parse(d) as unknown) };
    const conn = new Connection(socket, {} as SessionManager, bus, {} as FleetOrchestrator, repos,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, capabilities as never);

    await conn.handleRaw(JSON.stringify({ type: "commands.list", reqId: "q1", sessionId: "missing" }));
    await conn.handleRaw(JSON.stringify({ type: "commands.list", reqId: "q2", sessionId: "s1", workerId: "w1" }));

    expect(sent.find((message) => message.reqId === "q1")).toMatchObject({ type: "error", message: expect.stringContaining("unknown capability target") });
    expect(sent.find((message) => message.reqId === "q2")).toMatchObject({ type: "error", message: expect.stringContaining("invalid message") });
  });

  it("commands.list maps cold Claude previews to prompt actions and never probes cold Codex previews", async () => {
    const repos = new Repositories(openDb(":memory:"));
    const bus = new EventBus();
    const catalog = { forCwd: vi.fn(async (cwd: string) => [{ name: "review", description: `Review ${cwd}`, argumentHint: "[path]", aliases: ["rv"] }]) };
    const sent: any[] = [];
    const socket: ClientSocket = { send: (d: string) => sent.push(JSON.parse(d) as unknown) };
    const conn = new Connection(socket, {} as SessionManager, bus, {} as FleetOrchestrator, repos, undefined, undefined, catalog);

    await conn.handleRaw(JSON.stringify({ type: "commands.list", reqId: "q1", cwd: "/r", provider: "claude" }));
    await conn.handleRaw(JSON.stringify({ type: "commands.list", reqId: "q2", cwd: "/r", provider: "codex" }));
    await conn.handleRaw(JSON.stringify({ type: "commands.list", reqId: "q3" }));

    expect(catalog.forCwd).toHaveBeenNthCalledWith(1, "/r");
    expect(catalog.forCwd).toHaveBeenNthCalledWith(2, process.cwd());
    expect(sent.find((message) => message.reqId === "q1").commands).toEqual([{
      id: "claude.command.review",
      name: "review",
      description: "Review /r",
      argumentHint: "[path]",
      aliases: ["rv"],
      action: { type: "insert-prompt", text: "/review" },
    }]);
    expect(sent.find((message) => message.reqId === "q2").commands).toEqual([]);
    expect(sent.find((message) => message.reqId === "q3").commands[0].action).toEqual({ type: "insert-prompt", text: "/review" });
  });

  it("session/worker delete·archive·rename route to managers/repos and ack", async () => {
    const calls: string[] = [];
    const sessions = {
      rename: (id: string, l: string) => calls.push(`s.rename ${id} ${l}`),
      archive: (id: string, a: boolean) => calls.push(`s.archive ${id} ${a}`),
      delete: async (id: string) => { calls.push(`s.delete ${id}`); },
    } as unknown as SessionManager;
    const fleet = {
      archive: (id: string, a: boolean) => calls.push(`f.archive ${id} ${a}`),
      delete: async (id: string) => { calls.push(`f.delete ${id}`); },
    } as unknown as FleetOrchestrator;
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    const sent: any[] = [];
    const socket: ClientSocket = { send: (d: string) => sent.push(JSON.parse(d) as unknown) };
    const conn = new Connection(socket, sessions, new EventBus(), fleet, repos);
    await conn.handleRaw(JSON.stringify({ type: "session.rename", reqId: "q1", sessionId: "s1", label: "X" }));
    await conn.handleRaw(JSON.stringify({ type: "session.archive", reqId: "q2", sessionId: "s1", archived: true }));
    await conn.handleRaw(JSON.stringify({ type: "session.delete", reqId: "q3", sessionId: "s1" }));
    await conn.handleRaw(JSON.stringify({ type: "worker.rename", reqId: "q4", id: "a1", label: "Y" }));
    await conn.handleRaw(JSON.stringify({ type: "worker.archive", reqId: "q5", id: "a1", archived: true }));
    await conn.handleRaw(JSON.stringify({ type: "worker.delete", reqId: "q6", id: "a1" }));
    expect(calls).toEqual(["s.rename s1 X", "s.archive s1 true", "s.delete s1", "f.archive a1 true", "f.delete a1"]);
    expect(repos.getWorker("a1")?.label).toBe("Y"); // worker.rename calls repos.setWorkerLabel directly
    expect(sent.filter((m) => m.type === "fleet.ack").map((m) => m.action)).toEqual(["rename", "archive", "delete", "rename", "archive", "delete"]);
  });

  it("worker.delete returns a correlated error when the delete commit fails", async () => {
    const fleet = {
      delete: async () => { throw new Error("db delete failed"); },
    } as unknown as FleetOrchestrator;
    const repos = new Repositories(openDb(":memory:"));
    const sent: any[] = [];
    const socket: ClientSocket = { send: (data) => sent.push(JSON.parse(data) as unknown) };
    const conn = new Connection(socket, {} as SessionManager, new EventBus(), fleet, repos);

    await conn.handleRaw(JSON.stringify({ type: "worker.delete", reqId: "q-delete", id: "w1" }));

    expect(sent.at(-1)).toMatchObject({
      type: "error", reqId: "q-delete", message: "Error: db delete failed",
    });
  });

  // P3-remaining Track B #3 (docs/2026-07-06-p3r-codex-hardening-finish.md): the daemon-only teardown
  // (McpBridge release + CODEX_HOME removal) moved OFF the Connection ctor/call path and into
  // SessionManager.delete (SessionManagerDeps.onSessionDelete) — the single owner. This exercises the
  // full chain through a real SessionManager so the relocation's "fires exactly once" guarantee is
  // verified at the Connection entry point too, not just at the SessionManager unit level.
  it("session.delete triggers the daemon's onSessionDelete cleanup exactly once, via SessionManager (not Connection)", async () => {
    const repos = new Repositories(openDb(":memory:"));
    const bus = new EventBus();
    const factory = (): WorkerLike => ({ start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
    const fleet = new FleetOrchestrator({ repos, bus, git: new FakeGitOps(), factory, worktreesDir: "/wt" });
    const released: string[] = [];
    const sm = new SessionManager(
      { repos, bus, backends: { claude: fakeBackend([]) }, masterModel: "mm", fleet, onSessionDelete: (id: string) => released.push(id) },
      () => "s1",
    );
    const session = sm.create("/x");
    const sent: any[] = [];
    const socket: ClientSocket = { send: (d: string) => sent.push(JSON.parse(d) as unknown) };
    const conn = new Connection(socket, sm, bus, fleet, repos);
    await conn.handleRaw(JSON.stringify({ type: "session.delete", reqId: "q1", sessionId: session.id }));
    expect(released).toEqual([session.id]); // fired exactly once — from SessionManager.delete, not duplicated by Connection
    expect(sent.at(-1)).toMatchObject({ type: "fleet.ack", action: "delete", id: session.id });
  });

  it("session.create with provider codex persists the provider and routes turns to the codex backend", async () => {
    const repos = new Repositories(openDb(":memory:"));
    const bus = new EventBus();
    const factory = (): WorkerLike => ({ start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
    const fleet = new FleetOrchestrator({ repos, bus, git: new FakeGitOps(), factory, worktreesDir: "/wt" });
    const claudeCalls: string[] = [];
    const codexCalls: string[] = [];
    const claudeBase = fakeQuery([{ type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-c" }]);
    const claudeQueryFn = ((input: unknown) => { claudeCalls.push("claude"); return (claudeBase as (x: unknown) => unknown)(input); }) as ReturnType<typeof fakeQuery>;
    const codexBase = fakeQuery([{ type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-x" }]);
    // A fake "codex" backend built the same way as the claude one (the port is provider-agnostic) — records
    // that a turn was routed to it, independent of the real CodexBackend/bridge.
    const codexQueryFn = ((input: unknown) => { codexCalls.push("codex"); return (codexBase as (x: unknown) => unknown)(input); }) as ReturnType<typeof fakeQuery>;
    const sm = new SessionManager({ repos, bus, backends: { claude: new ClaudeBackend(claudeQueryFn), codex: new ClaudeBackend(codexQueryFn) }, masterModel: "mm", fleet });
    const sent: any[] = [];
    const socket: ClientSocket = { send: (d: string) => sent.push(JSON.parse(d) as unknown) };
    const conn = new Connection(socket, sm, bus, fleet, repos);

    await conn.handleRaw(JSON.stringify({ type: "session.create", cwd: "/x", provider: "codex", reqId: "c1" }));
    const created = sent.find((m) => m.type === "session.created")!;
    expect(repos.getSession(created.sessionId as string)!.provider).toBe("codex"); // persisted via the protocol field

    await conn.handleRaw(JSON.stringify({ type: "session.send", sessionId: created.sessionId, text: "hi", reqId: "t1" }));
    expect(codexCalls).toEqual(["codex"]); // SessionManager routed the turn to the codex backend
    expect(claudeCalls).toEqual([]); // never touched the claude backend
  });

  it("session.stop routes to sessions.stop and acks", async () => {
    const stopped: string[] = [];
    const sessions = { stop: async (id: string) => { stopped.push(id); } } as unknown as SessionManager;
    const sent: any[] = [];
    const socket: ClientSocket = { send: (d: string) => sent.push(JSON.parse(d) as unknown) };
    const conn = new Connection(socket, sessions, new EventBus(), {} as unknown as FleetOrchestrator, new Repositories(openDb(":memory:")));
    await conn.handleRaw(JSON.stringify({ type: "session.stop", reqId: "q1", sessionId: "s1" }));
    expect(stopped).toEqual(["s1"]);
    expect(sent.at(-1)).toMatchObject({ type: "fleet.ack", action: "stop", id: "s1" });
  });

  it("repo.branches and source.fetch route to the source provider", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createRepo({ id: "r1", name: "app", path: "/code/app", description: "" });
    const source = {
      listBranches: async (p: string) => (p === "/code/app" ? ["main", "dev"] : []),
      fetchSource: async (url: string) => (url.includes("issues") ? { title: "T", body: "B" } : null),
    };
    const sent: any[] = [];
    const socket: ClientSocket = { send: (d: string) => sent.push(JSON.parse(d) as unknown) };
    const conn = new Connection(socket, {} as unknown as SessionManager, new EventBus(), {} as unknown as FleetOrchestrator, repos, undefined, undefined, undefined, source);

    await conn.handleRaw(JSON.stringify({ type: "repo.branches", reqId: "q1", repo: "app" }));
    expect(sent.at(-1)).toMatchObject({ type: "repo.branches.result", branches: ["main", "dev"] });
    await conn.handleRaw(JSON.stringify({ type: "source.fetch", reqId: "q2", url: "https://github.com/o/r/issues/9" }));
    expect(sent.at(-1)).toMatchObject({ type: "source.fetch.result", item: { title: "T", body: "B" } });
  });

  it("worker.checkpoints returns repos rows; worker.restore routes to fleet.restore", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    repos.addCheckpoint({ workerId: "a1", seq: 0, sha: "ck0" });
    const restoreCalls: Array<[string, number]> = [];
    const fleet = { restore: async (id: string, seq: number) => { restoreCalls.push([id, seq]); } } as unknown as FleetOrchestrator;
    const sent: any[] = [];
    const socket: ClientSocket = { send: (d: string) => sent.push(JSON.parse(d) as unknown) };
    const conn = new Connection(socket, {} as unknown as SessionManager, new EventBus(), fleet, repos);

    await conn.handleRaw(JSON.stringify({ type: "worker.checkpoints", reqId: "q1", id: "a1" }));
    expect(sent.at(-1).checkpoints).toEqual([{ seq: 0, sha: "ck0", createdAt: expect.any(String) }]);

    await conn.handleRaw(JSON.stringify({ type: "worker.restore", reqId: "q2", id: "a1", seq: 0 }));
    expect(restoreCalls).toEqual([["a1", 0]]);
    expect(sent.at(-1)).toMatchObject({ type: "fleet.ack", action: "restore", id: "a1" });
  });
});

function makeConnWith(sent: any[], opts: { settings?: Settings; source?: unknown }): { conn: Connection; repos: Repositories } {
  const repos = new Repositories(openDb(":memory:"));
  const bus = new EventBus();
  const factory = (): WorkerLike => ({ start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
  const fleet = new FleetOrchestrator({ repos, bus, git: new FakeGitOps(), factory, worktreesDir: "/wt" });
  let n = 0;
  const sm = new SessionManager(
    { repos, bus, backends: { claude: fakeBackend([{ type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" }]) }, masterModel: "mm", fleet },
    () => `s${n++}`,
  );
  const socket: ClientSocket = { send: (d: string) => sent.push(JSON.parse(d) as unknown) };
  const conn = new Connection(socket, sm, bus, fleet, repos, undefined, opts.settings, undefined, opts.source as never);
  return { conn, repos };
}

describe("Connection — integrations / source.search", () => {
  it("source.search delegates to provider and replies items (github resolves repoPath)", async () => {
    const sent: any[] = [];
    const calls: Array<[string, string, string | undefined]> = [];
    const source = {
      listBranches: async () => [],
      fetchSource: async () => null,
      searchSource: async (provider: string, query: string, repoPath?: string) => { calls.push([provider, query, repoPath]); return [{ provider, id: "1", identifier: "#1", title: "t", url: "u", body: "b" }]; },
      integrationsStatus: async () => ({ github: { available: false }, linear: { configured: false } }),
    };
    const { conn, repos } = makeConnWith(sent, { source });
    repos.createRepo({ id: "r1", name: "app", path: "/p", description: "", base: null });
    await conn.handleRaw(JSON.stringify({ type: "source.search", reqId: "s1", provider: "github", query: "x", repo: "app" }));
    expect(calls).toEqual([["github", "x", "/p"]]);
    expect(sent.at(-1)).toMatchObject({ type: "source.search.result", reqId: "s1", items: [{ identifier: "#1" }] });
  });

  it("source.search github with unknown repo replies empty", async () => {
    const sent: any[] = [];
    const source = { listBranches: async () => [], fetchSource: async () => null, searchSource: async () => [{ provider: "github", id: "1", identifier: "#1", title: "t", url: "u", body: "b" }], integrationsStatus: async () => ({ github: { available: false }, linear: { configured: false } }) };
    const { conn } = makeConnWith(sent, { source });
    await conn.handleRaw(JSON.stringify({ type: "source.search", reqId: "s2", provider: "github", query: "x", repo: "nope" }));
    expect(sent.at(-1)).toMatchObject({ type: "source.search.result", reqId: "s2", items: [] });
  });

  it("integrations.status replies github+linear", async () => {
    const sent: any[] = [];
    const source = { listBranches: async () => [], fetchSource: async () => null, searchSource: async () => [], integrationsStatus: async () => ({ github: { available: true }, linear: { configured: true, valid: true, user: "CChuYonng" } }) };
    const { conn } = makeConnWith(sent, { source });
    await conn.handleRaw(JSON.stringify({ type: "integrations.status", reqId: "i1" }));
    expect(sent.at(-1)).toMatchObject({ type: "integrations.status.result", reqId: "i1", github: { available: true }, linear: { user: "CChuYonng" } });
  });

  it("settings.set stores linearApiKey but never echoes it", async () => {
    const sent: any[] = [];
    const repos0 = new Repositories(openDb(":memory:"));
    const settings = new Settings(repos0, loadConfig({}));
    const { conn } = makeConnWith(sent, { settings });
    await conn.handleRaw(JSON.stringify({ type: "settings.set", reqId: "x", settings: { linearApiKey: "lin_secret", masterModel: "m" } }));
    expect(settings.linearApiKey()).toBe("lin_secret");
    expect(JSON.stringify(sent.at(-1))).not.toContain("lin_secret");
    expect(sent.at(-1).settings.masterModel).toBe("m");
  });

  it("settings.set stores codexApiKey but never echoes it", async () => {
    const sent: any[] = [];
    const repos0 = new Repositories(openDb(":memory:"));
    const settings = new Settings(repos0, loadConfig({}));
    const { conn } = makeConnWith(sent, { settings });
    await conn.handleRaw(JSON.stringify({ type: "settings.set", reqId: "y", settings: { codexApiKey: "sk-test", masterModel: "m" } }));
    expect(settings.codexApiKey()).toBe("sk-test");
    expect(JSON.stringify(sent.at(-1))).not.toContain("sk-test");
    expect(sent.at(-1).settings.masterModel).toBe("m");
  });

  // Task 5 daemon pickup: codexApiKey previously flowed through the generic apply() path with no trim
  // normalization, unlike its siblings (anthropicApiKey/linearApiKey/slack tokens ~:455-462).
  it("settings.set stores codexApiKey trimmed of surrounding whitespace", async () => {
    const sent: any[] = [];
    const repos0 = new Repositories(openDb(":memory:"));
    const settings = new Settings(repos0, loadConfig({}));
    const { conn } = makeConnWith(sent, { settings });
    await conn.handleRaw(JSON.stringify({ type: "settings.set", reqId: "z", settings: { codexApiKey: "  sk-test  " } }));
    expect(settings.codexApiKey()).toBe("sk-test");
  });

  it("settings.set with a whitespace-only codexApiKey clears the stored secret", async () => {
    const sent: any[] = [];
    const repos0 = new Repositories(openDb(":memory:"));
    const settings = new Settings(repos0, loadConfig({}));
    settings.setCodexApiKey("sk-existing");
    const { conn } = makeConnWith(sent, { settings });
    await conn.handleRaw(JSON.stringify({ type: "settings.set", reqId: "w", settings: { codexApiKey: "   " } }));
    expect(settings.codexApiKey()).toBeUndefined();
  });
});

describe("Connection automation routes", () => {
  function makeConnWithAutomations(sent: any[], fakeAutomations: AutomationProvider): { conn: Connection; bus: EventBus } {
    const repos = new Repositories(openDb(":memory:"));
    const bus = new EventBus();
    const factory = (): WorkerLike => ({ start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
    const fleet = new FleetOrchestrator({ repos, bus, git: new FakeGitOps(), factory, worktreesDir: "/wt" });
    let n = 0;
    const sm = new SessionManager(
      { repos, bus, backends: { claude: fakeBackend([{ type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" }]) }, masterModel: "mm", fleet },
      () => `s${n++}`,
    );
    const socket: ClientSocket = { send: (d: string) => sent.push(JSON.parse(d) as unknown) };
    const conn = new Connection(socket, sm, bus, fleet, repos, undefined, undefined, undefined, undefined, undefined, undefined, undefined, fakeAutomations);
    return { conn, bus };
  }

  it("automation.create persists via provider, replies automation.result, and broadcasts automation.changed", async () => {
    const sent: any[] = [];
    const created: Automation[] = [];
    const fakeAutomations: AutomationProvider = {
      list: () => [],
      create: (input: AutomationInput) => {
        const automation: Automation = {
          id: "a1", name: input.name, enabled: input.enabled ?? true,
          trigger: input.trigger, action: input.action,
          model: input.model ?? null, effort: input.effort ?? null,
          lastRunAt: null, lastStatus: null, lastError: null, nextRunAt: null, createdAt: "t",
        };
        created.push(automation);
        return automation;
      },
      update: () => undefined, delete: () => {}, setEnabled: () => undefined, runNow: async () => {},
    };
    const { conn, bus } = makeConnWithAutomations(sent, fakeAutomations);

    const broadcasts: string[] = [];
    bus.subscribe("@all", (e) => { if (e.type === "automation.changed") broadcasts.push(e.type); });

    await conn.handleRaw(JSON.stringify({
      type: "automation.create", reqId: "q1",
      automation: {
        name: "n",
        trigger: { kind: "cron", cron: "0 3 * * *", timezone: "UTC" },
        action: { kind: "master", prompt: "p", cwd: "/w", sessionMode: "reuse" },
      },
    }));

    expect(created).toHaveLength(1);
    expect(sent.find((m) => m.type === "automation.result")?.reqId).toBe("q1");
    expect(broadcasts).toHaveLength(1);
  });

  it("automation.list replies automation.list.result with automations array", async () => {
    const sent: any[] = [];
    const automation: Automation = {
      id: "a1", name: "n",
      trigger: { kind: "cron", cron: "0 * * * *", timezone: "UTC" },
      action: { kind: "master", prompt: "p", cwd: "/w", sessionMode: "reuse" },
      model: null, effort: null, enabled: true,
      lastRunAt: null, lastStatus: null, lastError: null, nextRunAt: null, createdAt: "t",
    };
    const fakeAutomations: AutomationProvider = {
      list: () => [automation], create: () => automation, update: () => undefined, delete: () => {}, setEnabled: () => undefined, runNow: async () => {},
    };
    const { conn } = makeConnWithAutomations(sent, fakeAutomations);
    await conn.handleRaw(JSON.stringify({ type: "automation.list", reqId: "q2" }));
    expect(sent.at(-1)).toMatchObject({ type: "automation.list.result", reqId: "q2", automations: [{ id: "a1" }] });
  });

  it("automation.delete acks with fleet.ack and broadcasts automation.changed", async () => {
    const sent: any[] = [];
    const deleted: string[] = [];
    const fakeAutomations: AutomationProvider = {
      list: () => [], create: () => ({ id: "x" } as Automation), update: () => undefined,
      delete: (id) => { deleted.push(id); }, setEnabled: () => undefined, runNow: async () => {},
    };
    const { conn } = makeConnWithAutomations(sent, fakeAutomations);
    await conn.handleRaw(JSON.stringify({ type: "automation.delete", reqId: "q3", id: "a1" }));
    expect(deleted).toEqual(["a1"]);
    expect(sent.at(-1)).toMatchObject({ type: "fleet.ack", action: "delete", id: "a1", reqId: "q3" });
  });

  it("automation.run routes id+vars to runNow, acks with fleet.ack, and broadcasts automation.changed", async () => {
    const sent: any[] = [];
    const calls: Array<{ id: string; vars: unknown }> = [];
    const fakeAutomations: AutomationProvider = {
      list: () => [], create: () => ({ id: "x" } as Automation), update: () => undefined,
      delete: () => {}, setEnabled: () => undefined,
      runNow: async (id, vars) => { calls.push({ id, vars }); },
    };
    const { conn, bus } = makeConnWithAutomations(sent, fakeAutomations);
    const broadcasts: string[] = [];
    bus.subscribe("@all", (e) => { if (e.type === "automation.changed") broadcasts.push(e.type); });

    await conn.handleRaw(JSON.stringify({ type: "automation.run", reqId: "q9", id: "a1", vars: { message: "hello", channel: "C1" } }));
    expect(calls).toEqual([{ id: "a1", vars: { message: "hello", channel: "C1" } }]);
    expect(sent.at(-1)).toMatchObject({ type: "fleet.ack", action: "run", id: "a1", reqId: "q9" });
    expect(broadcasts).toHaveLength(1);

    // Also works without vars (defaults to {})
    await conn.handleRaw(JSON.stringify({ type: "automation.run", reqId: "q10", id: "a2" }));
    expect(calls[1]).toEqual({ id: "a2", vars: {} });
  });

  it("automation.* reply error when no provider is injected", async () => {
    const sent: any[] = [];
    const repos = new Repositories(openDb(":memory:"));
    const bus = new EventBus();
    const factory = (): WorkerLike => ({ start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
    const fleet = new FleetOrchestrator({ repos, bus, git: new FakeGitOps(), factory, worktreesDir: "/wt" });
    const sm = new SessionManager({ repos, bus, backends: { claude: fakeBackend([]) }, masterModel: "mm", fleet });
    const socket: ClientSocket = { send: (d: string) => sent.push(JSON.parse(d) as unknown) };
    const conn = new Connection(socket, sm, bus, fleet, repos); // no automations provider
    await conn.handleRaw(JSON.stringify({ type: "automation.list", reqId: "q4" }));
    expect(sent.at(-1)).toMatchObject({ type: "error", reqId: "q4" });
  });
});

// audit #51 — automation rule cards resolve raw Slack channel/user ids to names. This request is best-effort and must
// never surface as an "error" reply: no injected resolver (Slack unconfigured/off/disconnected) and a rejecting
// resolver (e.g. an API error mid-lookup) both degrade to empty maps, letting the renderer fall back to the raw id.
describe("Connection automation.resolveSlackRefs", () => {
  function makeConn(resolveSlackRefs?: SlackRefResolverFn): { conn: Connection; sent: any[] } {
    const repos = new Repositories(openDb(":memory:"));
    const bus = new EventBus();
    const factory = (): WorkerLike => ({ start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
    const fleet = new FleetOrchestrator({ repos, bus, git: new FakeGitOps(), factory, worktreesDir: "/wt" });
    const sm = new SessionManager({ repos, bus, backends: { claude: fakeBackend([]) }, masterModel: "mm", fleet });
    const sent: any[] = [];
    const socket: ClientSocket = { send: (d: string) => sent.push(JSON.parse(d) as unknown) };
    const conn = new Connection(socket, sm, bus, fleet, repos, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, resolveSlackRefs);
    return { conn, sent };
  }

  it("returns resolved names via the injected resolver", async () => {
    const { conn, sent } = makeConn(async (channels, users) => ({
      channels: Object.fromEntries(channels.map((c) => [c, "general"])),
      users: Object.fromEntries(users.map((u) => [u, "clover"])),
    }));
    await conn.handleRaw(JSON.stringify({ type: "automation.resolveSlackRefs", reqId: "q1", channels: ["C1"], users: ["U1"] }));
    expect(sent.at(-1)).toMatchObject({ type: "automation.resolveSlackRefs.result", reqId: "q1", channels: { C1: "general" }, users: { U1: "clover" } });
  });

  it("returns empty maps when no resolver is injected (Slack unconfigured/off) — no crash, no error reply", async () => {
    const { conn, sent } = makeConn(undefined);
    await conn.handleRaw(JSON.stringify({ type: "automation.resolveSlackRefs", reqId: "q2", channels: ["C1"], users: ["U1"] }));
    expect(sent.at(-1)).toEqual({ type: "automation.resolveSlackRefs.result", reqId: "q2", channels: {}, users: {} });
  });

  it("returns empty maps when the injected resolver rejects (disconnected client / API error)", async () => {
    const { conn, sent } = makeConn(async () => { throw new Error("disconnected"); });
    await conn.handleRaw(JSON.stringify({ type: "automation.resolveSlackRefs", reqId: "q3", channels: ["C1"], users: [] }));
    expect(sent.at(-1)).toEqual({ type: "automation.resolveSlackRefs.result", reqId: "q3", channels: {}, users: {} });
  });

  it("defaults channels/users to empty arrays when the request omits them", async () => {
    const calls: Array<{ channels: string[]; users: string[] }> = [];
    const { conn, sent } = makeConn(async (channels, users) => { calls.push({ channels, users }); return { channels: {}, users: {} }; });
    await conn.handleRaw(JSON.stringify({ type: "automation.resolveSlackRefs", reqId: "q4" }));
    expect(calls).toEqual([{ channels: [], users: [] }]);
    expect(sent.at(-1)).toMatchObject({ type: "automation.resolveSlackRefs.result", reqId: "q4" });
  });
});
