import { describe, it, expect, vi } from "vitest";
import { openDb } from "../../src/persistence/db.js";
import { Repositories } from "../../src/persistence/repositories.js";
import { EventBus } from "../../src/core/events.js";
import { AutomationDispatcher } from "../../src/core/automation-dispatcher.js";

function h() {
  const repos = new Repositories(openDb(":memory:"), () => "t");
  const bus = new EventBus();
  const runTurn = vi.fn(async () => {});
  const sessions = { create: () => ({ id: "s1", master: { runTurn } }), getOrCreateByKey: () => ({ id: "s1", master: { runTurn } }) };
  const fleet = { spawn: vi.fn(async () => ({ id: "w1" })) };
  const disp = new AutomationDispatcher({ repos, bus, sessions, fleet });
  return { repos, bus, runTurn, disp };
}

it("run() executes the action and records ok", async () => {
  const x = h();
  const a = x.repos.createAutomation("a1", { name: "n", trigger: { kind: "slack" }, action: { kind: "master", prompt: "hi", cwd: "/w", sessionMode: "reuse" }, enabled: true });
  await x.disp.run(a, {});
  expect(x.runTurn).toHaveBeenCalledOnce();
  expect(x.repos.getAutomation("a1")!.lastStatus).toBe("ok");
});

it("run() marks the row 'running' while the action is in flight, then reconciles to ok", async () => {
  const repos = new Repositories(openDb(":memory:"), () => "t");
  const bus = new EventBus();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const runTurn = vi.fn(async () => { await gate; }); // hold the action open so we can observe the in-flight state
  const sessions = { create: () => ({ id: "s1", master: { runTurn } }), getOrCreateByKey: () => ({ id: "s1", master: { runTurn } }) };
  const disp = new AutomationDispatcher({ repos, bus, sessions, fleet: { spawn: vi.fn(async () => ({ id: "w" })) } });
  const a = repos.createAutomation("a1", { name: "n", trigger: { kind: "slack" }, action: { kind: "master", prompt: "p", cwd: "/w", sessionMode: "reuse" }, enabled: true });
  const p = disp.run(a, {});
  await Promise.resolve();
  expect(repos.getAutomation("a1")!.lastStatus).toBe("running"); // surfaced while in flight (so the UI shows a live pulse)
  release();
  await p;
  expect(repos.getAutomation("a1")!.lastStatus).toBe("ok"); // reconciled when it ends
});

it("a long run does not rewind next_run_at advanced by the scheduler mid-run (no back-to-back refire)", async () => {
  const repos = new Repositories(openDb(":memory:"), () => "t");
  const bus = new EventBus();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const runTurn = vi.fn(async () => { await gate; });
  const sessions = { create: () => ({ id: "s1", master: { runTurn } }), getOrCreateByKey: () => ({ id: "s1", master: { runTurn } }) };
  const disp = new AutomationDispatcher({ repos, bus, sessions, fleet: { spawn: vi.fn(async () => ({ id: "w" })) } });
  repos.createAutomation("a1", { name: "n", trigger: { kind: "cron", cron: "*/5 * * * *", timezone: "UTC" }, action: { kind: "master", prompt: "p", cwd: "/w", sessionMode: "reuse" }, enabled: true });
  repos.setAutomationNextRun("a1", "2026-01-01T00:05:00.000Z"); // fire-time snapshot the dispatcher sees
  const a = repos.getAutomation("a1")!;
  const p = disp.run(a, {});
  await Promise.resolve();
  // Scheduler advances next_run_at while the run is in flight (what fireCron does on every overlapped tick).
  repos.setAutomationNextRun("a1", "2026-01-01T00:15:00.000Z");
  release();
  await p;
  expect(repos.getAutomation("a1")!.nextRunAt).toBe("2026-01-01T00:15:00.000Z"); // NOT rewound to 00:05
  expect(repos.getAutomation("a1")!.lastStatus).toBe("ok");
});

it("resetRunningAutomations clears a row left 'running' by a mid-run crash", () => {
  const repos = new Repositories(openDb(":memory:"), () => "t");
  repos.createAutomation("a1", { name: "n", trigger: { kind: "slack" }, action: { kind: "master", prompt: "p", cwd: "/w", sessionMode: "reuse" }, enabled: true });
  repos.setAutomationRun("a1", { lastRunAt: "t", lastStatus: "running", lastError: null });
  repos.resetRunningAutomations();
  expect(repos.getAutomation("a1")!.lastStatus).toBe("error");
});

it("run() awaits beforeRun (Slack reporter-ensure hook) before the action, best-effort", async () => {
  const repos = new Repositories(openDb(":memory:"), () => "t");
  const bus = new EventBus();
  const order: string[] = [];
  const runTurn = vi.fn(async () => { order.push("runTurn"); });
  const sessions = { create: () => ({ id: "s1", master: { runTurn } }), getOrCreateByKey: () => ({ id: "s1", master: { runTurn } }), get: () => ({ id: "s1", master: { runTurn } }) };
  const beforeRun = vi.fn(async () => { order.push("beforeRun"); });
  const disp = new AutomationDispatcher({ repos, bus, sessions, fleet: { spawn: vi.fn(async () => ({ id: "w" })) }, beforeRun });
  const a = repos.createAutomation("a1", { name: "n", trigger: { kind: "once", runAt: "2099-01-01T00:00:00.000Z" }, action: { kind: "master", prompt: "p", cwd: "/w", sessionMode: "reuse", targetSessionId: "s1" }, enabled: true });
  await disp.run(a, {});
  expect(beforeRun).toHaveBeenCalledWith(a);
  expect(order).toEqual(["beforeRun", "runTurn"]); // ensure reporter → turn (so we don't miss early events)
  expect(repos.getAutomation("a1")!.lastStatus).toBe("ok");
});

it("run() does not fail the turn if beforeRun throws (reporter ensure is best-effort)", async () => {
  const repos = new Repositories(openDb(":memory:"), () => "t");
  const bus = new EventBus();
  const runTurn = vi.fn(async () => {});
  const sessions = { create: () => ({ id: "s1", master: { runTurn } }), getOrCreateByKey: () => ({ id: "s1", master: { runTurn } }), get: () => ({ id: "s1", master: { runTurn } }) };
  const disp = new AutomationDispatcher({ repos, bus, sessions, fleet: { spawn: vi.fn(async () => ({ id: "w" })) }, beforeRun: () => { throw new Error("ensure boom"); } });
  const a = repos.createAutomation("a1", { name: "n", trigger: { kind: "once", runAt: "2099-01-01T00:00:00.000Z" }, action: { kind: "master", prompt: "p", cwd: "/w", sessionMode: "reuse", targetSessionId: "s1" }, enabled: true });
  await disp.run(a, {});
  expect(runTurn).toHaveBeenCalledOnce(); // the turn still runs
  expect(repos.getAutomation("a1")!.lastStatus).toBe("ok"); // an ensure failure does not turn the automation into an error
});

it("run() records error when action throws", async () => {
  const x = h();
  const a = x.repos.createAutomation("a1", { name: "n", trigger: { kind: "slack" }, action: { kind: "worker", repo: "nope", task: "x" }, enabled: true });
  await x.disp.run(a, {});
  const got = x.repos.getAutomation("a1")!;
  expect(got.lastStatus).toBe("error"); expect(got.lastError).toMatch(/repo/i);
});

function deferredDisp(x: ReturnType<typeof h>) {
  let release!: () => void; const gate = new Promise<void>((r) => (release = r));
  const runTurn = vi.fn(async () => { await gate; });
  const sessions = { create: () => ({ id: "s1", master: { runTurn } }), getOrCreateByKey: () => ({ id: "s1", master: { runTurn } }), get: () => ({ id: "s1", master: { runTurn } }) };
  const disp = new AutomationDispatcher({ repos: x.repos, bus: x.bus, sessions, fleet: { spawn: vi.fn(async () => ({ id: "w" })) } });
  return { disp, runTurn, release: () => release() };
}

it("run() ALLOWS overlap for slack (event) triggers — every message is handled, not dropped", async () => {
  const x = h();
  const { disp, runTurn, release } = deferredDisp(x);
  const a = x.repos.createAutomation("a1", { name: "n", trigger: { kind: "slack" }, action: { kind: "master", prompt: "p", cwd: "/w", sessionMode: "fresh" }, enabled: true });
  const p1 = disp.run(a, {});
  await Promise.resolve();
  const p2 = disp.run(a, {}); // second while first in-flight → ALSO runs (no skip)
  await Promise.resolve();
  expect(runTurn).toHaveBeenCalledTimes(2); // both fired
  release(); await Promise.all([p1, p2]);
  expect(x.repos.getAutomation("a1")!.lastStatus).toBe("ok"); // never "skipped"
});

it("run() still GUARDS overlap for cron (time) triggers — avoids scheduled pile-up", async () => {
  const x = h();
  const { disp, runTurn, release } = deferredDisp(x);
  const a = x.repos.createAutomation("a1", { name: "n", trigger: { kind: "cron", cron: "* * * * *", timezone: "UTC" }, action: { kind: "master", prompt: "p", cwd: "/w", sessionMode: "reuse" }, enabled: true });
  const p1 = disp.run(a, {});
  await Promise.resolve();
  await disp.run(a, {}); // second while first in-flight → skipped
  expect(x.repos.getAutomation("a1")!.lastStatus).toBe("skipped");
  expect(runTurn).toHaveBeenCalledOnce();
  release(); await p1;
});
