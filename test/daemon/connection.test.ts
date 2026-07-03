import { describe, it, expect } from "vitest";
import { openDb } from "../../src/persistence/db.js";
import { Repositories } from "../../src/persistence/repositories.js";
import type { Automation, AutomationInput } from "../../src/persistence/repositories.js";
import { EventBus } from "../../src/core/events.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { FleetOrchestrator } from "../../src/core/fleet-orchestrator.js";
import type { WorkerLike } from "../../src/core/fleet-orchestrator.js";
import { FakeGitOps } from "../../src/core/git-ops.js";
import { Connection } from "../../src/daemon/connection.js";
import type { ClientSocket, AutomationProvider } from "../../src/daemon/connection.js";
import { InteractionRegistry } from "../../src/core/interaction-registry.js";
import { Settings } from "../../src/core/settings.js";
import { loadConfig } from "../../src/config.js";
import { fakeQuery } from "../helpers/fake-query.js";

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
      queryFn: fakeQuery([
        { type: "assistant", text: "ack" },
        { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" },
      ]),
      masterModel: "mm",
      fleet,
    },
    () => `s${n++}`,
  );
  const sent: string[] = [];
  const socket: ClientSocket = { send: (d) => sent.push(d) };
  const conn = new Connection(socket, sm, bus, fleet, repos);
  return { conn, sent, repos };
}

type FleetOverride = {
  list?: () => Array<{ id: string; label: string; repoPath: string; status: string; branch: string | null; model: string | null }>;
  diff?: (id: string) => Promise<string>;
  stop?: (id: string) => Promise<void>;
  discard?: (id: string) => Promise<void>;
  interrupt?: (id: string) => Promise<void>;
  setPermissionMode?: (id: string, mode: string) => Promise<void>;
  transcript?: (id: string, sinceSeq?: number) => Array<{ seq: number; type: string; payload: unknown }>;
  send?: (id: string, text: string) => void;
  spawn?: (input: { homeSessionId: string; repoPath: string; label: string; task: string; base?: string; permissionMode?: string }) => { id: string };
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
      queryFn: fakeQuery([
        { type: "assistant", text: "ack" },
        { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" },
      ]),
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
      queryFn: fakeQuery([
        { type: "assistant", text: "ack" },
        { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" },
      ]),
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
  it("replays a pending interaction card on events.subscribe (survives a full client reload → turn not left hung)", async () => {
    const repos = new Repositories(openDb(":memory:"));
    const bus = new EventBus();
    const factory = (): WorkerLike => ({ start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
    const fleet = new FleetOrchestrator({ repos, bus, git: new FakeGitOps(), factory, worktreesDir: "/wt" });
    const sm = new SessionManager({ repos, bus, queryFn: fakeQuery([]), masterModel: "mm", fleet }, () => "s1");
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
    const sm = new SessionManager({ repos, bus, queryFn: fakeQuery([]), masterModel: "mm", fleet }, () => `s${n++}`);
    const socket: ClientSocket = { send: (d) => sent.push(d) };
    const models = { list: async () => [{ id: "x-model", displayName: "X Model" }] };
    const conn = new Connection(socket, sm, bus, fleet, repos, undefined, undefined, undefined, undefined, undefined, models);
    await conn.handleRaw(JSON.stringify({ type: "models.list", reqId: "ml2" }));
    const msg = parsed(sent).find((m) => m.type === "models.result");
    expect(msg!.models).toEqual([{ id: "x-model", displayName: "X Model" }]);
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

  it("fleet.stop/discard ack", async () => {
    const sent: any[] = [];
    const calls: string[] = [];
    const fleet = { list: () => [], diff: async () => "", stop: async (id: string) => { calls.push("stop:" + id); }, discard: async (id: string) => { calls.push("discard:" + id); } };
    const conn = makeConn(sent, { fleet });
    await conn.handleRaw(JSON.stringify({ type: "fleet.stop", reqId: "r3", id: "a1" }));
    await conn.handleRaw(JSON.stringify({ type: "fleet.discard", reqId: "r4", id: "a2" }));
    expect(calls).toEqual(["stop:a1", "discard:a2"]);
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
    expect(sent.at(-1)).toMatchObject({ type: "repos.list.result", reqId: "r6", repos: [{ name: "app", description: "결제" }] });
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
    const sm = new SessionManager({ repos, bus, queryFn: fakeQuery([]), masterModel: "mm", fleet: realFleet }, () => "sess-1");
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
    const sm2 = new SessionManager({ repos: repos2, bus: bus2, queryFn: fakeQuery([]), masterModel: "mm", fleet: fleet2 }, () => "sess-2");
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
    const sm = new SessionManager({ repos, bus, queryFn: fakeQuery([]), masterModel: "mm", fleet });
    const config = loadConfig({});
    const settings = new Settings(repos, config);
    const sent: any[] = [];
    const conn = new Connection({ send: (d) => sent.push(JSON.parse(d)) }, sm, bus, fleet, repos, undefined, settings);

    await conn.handleRaw(JSON.stringify({ type: "settings.get", reqId: "g1" }));
    expect(sent.at(-1)).toMatchObject({ type: "settings.result", reqId: "g1", settings: { masterModel: config.masterModel } });

    await conn.handleRaw(JSON.stringify({ type: "settings.set", reqId: "s1", settings: { masterModel: "claude-sonnet-4-6" } }));
    expect(sent.at(-1).settings).toMatchObject({ masterModel: "claude-sonnet-4-6" });
    expect(settings.masterModel()).toBe("claude-sonnet-4-6");
  });

  it("commands.list uses the live sub when workerId given, else the cwd catalog", async () => {
    const repos = new Repositories(openDb(":memory:"));
    const bus = new EventBus();
    const fleet = {
      listCommands: async (id: string) => (id === "a1" ? [{ name: "live-cmd", description: "from live" }] : []),
    } as unknown as FleetOrchestrator;
    const catalog = { forCwd: async (cwd: string) => [{ name: "cwd-cmd", description: `for ${cwd}` }] };
    const sent: any[] = [];
    const socket: ClientSocket = { send: (d: string) => sent.push(JSON.parse(d) as unknown) };
    const conn = new Connection(socket, {} as unknown as SessionManager, bus, fleet, repos, undefined, undefined, catalog);

    await conn.handleRaw(JSON.stringify({ type: "commands.list", reqId: "q1", workerId: "a1" }));
    await conn.handleRaw(JSON.stringify({ type: "commands.list", reqId: "q2", cwd: "/r" }));

    expect(sent.find((m) => m.reqId === "q1").commands).toEqual([{ name: "live-cmd", description: "from live" }]);
    expect(sent.find((m) => m.reqId === "q2").commands).toEqual([{ name: "cwd-cmd", description: "for /r" }]);
  });

  it("commands.list falls back to the daemon cwd (process.cwd()) when neither cwd nor workerId is given (new session / skill)", async () => {
    const repos = new Repositories(openDb(":memory:"));
    const bus = new EventBus();
    const fleet = { listCommands: async () => [] } as unknown as FleetOrchestrator;
    let probed: string | undefined;
    const catalog = { forCwd: async (cwd: string) => { probed = cwd; return [{ name: "review", description: "Run a review" }]; } };
    const sent: any[] = [];
    const socket: ClientSocket = { send: (d: string) => sent.push(JSON.parse(d) as unknown) };
    const conn = new Connection(socket, {} as unknown as SessionManager, bus, fleet, repos, undefined, undefined, catalog);
    await conn.handleRaw(JSON.stringify({ type: "commands.list", reqId: "q1" })); // neither cwd nor workerId (new session, no repo selected)
    expect(probed).toBe(process.cwd()); // falls back to the same default cwd as session.create
    expect(sent.find((m) => m.reqId === "q1").commands).toEqual([{ name: "review", description: "Run a review" }]);
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
    { repos, bus, queryFn: fakeQuery([{ type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" }]), masterModel: "mm", fleet },
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
});

describe("Connection automation routes", () => {
  function makeConnWithAutomations(sent: any[], fakeAutomations: AutomationProvider): { conn: Connection; bus: EventBus } {
    const repos = new Repositories(openDb(":memory:"));
    const bus = new EventBus();
    const factory = (): WorkerLike => ({ start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
    const fleet = new FleetOrchestrator({ repos, bus, git: new FakeGitOps(), factory, worktreesDir: "/wt" });
    let n = 0;
    const sm = new SessionManager(
      { repos, bus, queryFn: fakeQuery([{ type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" }]), masterModel: "mm", fleet },
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
    const sm = new SessionManager({ repos, bus, queryFn: fakeQuery([]), masterModel: "mm", fleet });
    const socket: ClientSocket = { send: (d: string) => sent.push(JSON.parse(d) as unknown) };
    const conn = new Connection(socket, sm, bus, fleet, repos); // no automations provider
    await conn.handleRaw(JSON.stringify({ type: "automation.list", reqId: "q4" }));
    expect(sent.at(-1)).toMatchObject({ type: "error", reqId: "q4" });
  });
});
