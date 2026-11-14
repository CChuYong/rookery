import { describe, it, expect } from "vitest";
import { openDb } from "../../src/persistence/db.js";
import { Repositories } from "../../src/persistence/repositories.js";
import { Settings } from "../../src/core/settings.js";
import { loadConfig } from "../../src/config.js";
import { EventBus } from "../../src/core/events.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { FleetOrchestrator } from "../../src/core/fleet-orchestrator.js";
import { FakeGitOps } from "../../src/core/git-ops.js";
import { Worker } from "../../src/core/worker.js";
import { CodexBackend } from "../../src/core/codex/codex-backend.js";
import { ClaudeBackend, type QueryFn } from "../../src/core/claude-backend.js";
import { fakeQuery } from "../helpers/fake-query.js";
import { fakeCodexSpawn } from "../helpers/fake-codex.js";

async function until(test: () => boolean) {
  for (let n = 0; n < 1000; n++) { if (test()) return; await new Promise(r => setTimeout(r, 1)); }
  throw new Error("condition did not settle");
}
function base() {
  const db = openDb(":memory:");
  const repos = new Repositories(db);
  const bus = new EventBus();
  const settings = new Settings(repos, loadConfig({}));
  const fleet = new FleetOrchestrator({ repos, bus, git: new FakeGitOps(), worktreesDir: "/wt", factory: () => { throw new Error("unused"); } });
  return { db, repos, bus, settings, fleet };
}

describe("speed lifecycle", () => {
  it("resolves live role defaults and retains explicit session intent across restart and both fork paths", async () => {
    const d = base();
    const seen: unknown[] = [];
    const query = ((input: Parameters<QueryFn>[0]) => { seen.push(input.options?.settings); return fakeQuery([{ type: "result", subtype: "success", session_id: "sdk", total_cost_usd: 0, num_turns: 1 }])(input); }) as QueryFn;
    const backend = new ClaudeBackend(query);
    let seq = 0;
    const deps = { ...d, masterModel: "m", backends: {claude: backend, codex: backend}, masterSpeed: (p: string) => d.settings.speed(p, "master"), forkSession: async () => ({sessionId: "fork-sdk"}) };
    const sm = new SessionManager(deps, () => `session-${seq++}`);
    const session = sm.create("/x");
    await session.master.runTurn("one");
    d.settings.apply({masterSpeed: "fast"});
    await session.master.runTurn("two");
    await session.master.runTurn("three", {speed: "standard"});
    d.settings.apply({masterSpeed: "fast"});
    const resumed = new SessionManager(deps).get(session.id)!;
    await resumed.master.runTurn("four");
    expect(seen).toEqual([{fastMode: false}, {fastMode: true}, {fastMode: false}, {fastMode: false}]);
    expect(d.repos.getSession(session.id)?.speed).toBe("standard");
    const fork = await sm.fork(session.id);
    const cross = await sm.fork(session.id, {provider: "codex"});
    expect(d.repos.getSession(fork.id)?.speed).toBe("standard");
    expect(d.repos.getSession(cross.id)?.speed).toBe("standard");
    expect(d.repos.listSessionEvents(session.id).some(e => e.type === "master.speed")).toBe(true);
  });

  it("preserves per-message speed and billed tier when changes arrive while the Worker is busy", async () => {
    const d = base();
    d.repos.createSession({id: "s", cwd: "/x"});
    d.repos.createWorker({id: "w", sessionId: "s", repoPath: "/x", label: "w", provider: "codex"});
    const fake = fakeCodexSpawn((text, turn) => [{kind: "agentMessage", text}, {kind: "tokenUsage", last: {inputTokens: 1000}, total: {inputTokens: (turn + 1) * 1000}}, {kind: "turnEnd"}]);
    const backend = new CodexBackend({spawn: fake.spawn, defaultModel: () => "gpt-5.5"});
    const worker = new Worker({id: "w", sessionId: "s", repoPath: "/x", label: "w", deps: {...d, backend, model: "gpt-5.5", speed: () => d.settings.speed("codex", "worker")} });
    d.bus.subscribe("s", e => {
      if (e.type === "worker.event" && e.data.kind === "message" && e.data.role === "assistant" && e.data.content === "first") {
        worker.send("second", undefined, "fast");
        worker.send("third", undefined, "standard");
      }
    });
    worker.start("first");
    await until(() => worker.status() === "idle");
    expect(fake.requests.filter(r => r.method === "turn/start").map(r => r.params.serviceTierForTurn)).toEqual(["default", "fast", "default"]);
    const results = d.repos.listWorkerEvents("w").filter(r => r.type === "result").map(r => JSON.parse(r.payload_json));
    expect(results.map(r => r.requestedSpeed)).toEqual(["standard", "fast", "standard"]);
    [.005, .0175, .0225].forEach((cost, i) => expect(results[i].costUsd).toBeCloseTo(cost, 10));
    await worker.stop();
  });

  it("re-evaluates defaults while idle, persists setSpeed, and carries intent through provider reload and restart", async () => {
    const d = base();
    d.repos.createSession({id: "s", cwd: "/x"});
    d.repos.createWorker({id: "w", sessionId: "s", repoPath: "/x", label: "w", provider: "codex"});
    const fake = fakeCodexSpawn(() => [{kind: "tokenUsage", last: {inputTokens: 1000}}, {kind: "turnEnd"}]);
    const backend = new CodexBackend({spawn: fake.spawn, defaultModel: () => "gpt-5.5"});
    const opts = {id: "w", sessionId: "s", repoPath: "/x", label: "w", deps: {...d, backend, model: "gpt-5.5", speed: () => d.settings.speed("codex", "worker")} };
    const worker = new Worker(opts);
    worker.start("one"); await until(() => worker.status() === "idle");
    d.settings.apply({codexWorkerSpeed: "fast"});
    worker.send("two"); await until(() => worker.status() === "idle");
    await worker.setSpeed("standard");
    const reload = worker.requestCapabilityReload({whenIdle: false, onBegin() {}}); await reload.completion;
    worker.send("three"); await until(() => worker.status() === "idle");
    await worker.abandon();
    const restarted = new Worker({...opts, sdkSessionId: d.repos.getWorker("w")!.sdk_session_id});
    restarted.resume(); restarted.send("four"); await until(() => restarted.status() === "idle");
    expect(fake.requests.filter(r => r.method === "turn/start").map(r => r.params.serviceTierForTurn)).toEqual(["default", "fast", "default", "default"]);
    expect(d.repos.getWorker("w")?.speed).toBe("standard");
    await restarted.stop();
  });

  it("stops a budgeted Worker at unavailable-cost boundary and warns the Master", async () => {
    const d = base();
    d.repos.createSession({id: "s", cwd: "/x", provider: "codex"});
    d.repos.createWorker({id: "w", sessionId: "s", repoPath: "/x", label: "w", provider: "codex"});
    const fake = fakeCodexSpawn(() => [{kind: "agentMessage", text: "busy"}, {kind: "tokenUsage", last: {inputTokens: 1000}}, {kind: "turnEnd"}]);
    const backend = new CodexBackend({spawn: fake.spawn, defaultModel: () => "unknown"});
    const worker = new Worker({id: "w", sessionId: "s", repoPath: "/x", label: "w", deps: {...d, backend, model: "unknown", costBudgetUsd: 10} });
    d.bus.subscribe("s", e => { if (e.type === "worker.event" && e.data.kind === "message" && e.data.role === "assistant") worker.send("must not execute"); });
    worker.start("go"); await worker.waitUntilSettled();
    expect(worker.status()).toBe("stopped");
    expect(fake.requests.filter(r => r.method === "turn/start")).toHaveLength(1);
    expect(JSON.parse(d.repos.lastWorkerEventPayload("w", "result")!)).toMatchObject({costUsd: 0, costAccuracy: "unavailable"});
    const sm = new SessionManager({...d, backends: {codex: backend}, masterModel: "unknown"});
    await sm.get("s")!.master.runTurn("go", {costBudgetUsd: 10});
    expect(d.repos.listSessionEvents("s").some(r => r.type === "master.notice" && JSON.parse(r.payload_json).code === "notice.costUnavailable")).toBe(true);
  });

  it("persists nullable automation speed and enforces the DB contract", () => {
    const d = base();
    const a = d.repos.createAutomation("a", {name: "a", trigger: {kind: "once", at: "2030-01-01T00:00:00Z"}, action: {kind: "worker", repo: "r", task: "t"}, speed: "fast"});
    expect(a.speed).toBe("fast");
    expect(d.repos.updateAutomation("a", {speed: null})?.speed).toBeNull();
    expect(() => d.db.prepare("UPDATE automations SET speed = 'ultrafast'").run()).toThrow();
  });
});

it("does not resume another budgeted turn after previously unavailable accounting", async () => {
  const d = base();
  d.repos.createSession({id: "s", cwd: "/x"});
  d.repos.createWorker({id: "w", sessionId: "s", repoPath: "/x", label: "w"});
  d.repos.addWorkerEvent({workerId: "w", seq: 0, type: "result", payloadJson: JSON.stringify({kind: "result", costUsd: 0, numTurns: 1, costAccuracy: "unavailable"})});
  const fake = fakeCodexSpawn(() => [{kind: "turnEnd"}]);
  const worker = new Worker({id: "w", sessionId: "s", repoPath: "/x", label: "w", sdkSessionId: "old-thread", deps: {...d, backend: new CodexBackend({spawn: fake.spawn, defaultModel: () => "gpt-5.5"}), model: "gpt-5.5", costBudgetUsd: 10}});
  worker.resume();
  expect(worker.status()).toBe("stopped");
  expect(() => worker.send("again")).toThrow(/not running/);
  expect(fake.requests.some(r => r.method === "turn/start")).toBe(false);
});
