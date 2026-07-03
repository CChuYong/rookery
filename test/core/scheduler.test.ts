import { it, expect, vi } from "vitest";
import { openDb } from "../../src/persistence/db.js";
import { Repositories } from "../../src/persistence/repositories.js";
import { EventBus } from "../../src/core/events.js";
import { Scheduler } from "../../src/core/scheduler.js";
import { AutomationDispatcher } from "../../src/core/automation-dispatcher.js";

const past = "2026-06-22T03:00:00.000Z";

function harness(nowIso: string) {
  const repos = new Repositories(openDb(":memory:"), () => nowIso);
  const bus = new EventBus();
  const runTurn = vi.fn(async () => {});
  const sessions = {
    create: () => ({ id: "session-1", master: { runTurn } }),
    getOrCreateByKey: () => ({ id: "session-1", master: { runTurn } }),
    get: (id: string) => ({ id, master: { runTurn } }),
  };
  const fleet = { spawn: vi.fn(async () => ({ id: "w1" })) };
  // Use a real AutomationDispatcher but spy on its run method
  const dispatcher = new AutomationDispatcher({ repos, bus, sessions, fleet });
  const dispatchRun = vi.spyOn(dispatcher, "run");
  let ticks: Array<() => void> = [];
  const schedule = (fn: () => void) => { ticks.push(fn); return () => {}; };
  const sched = new Scheduler({ repos, dispatcher, now: () => new Date(nowIso), schedule });
  return {
    repos, bus, runTurn, dispatcher, dispatchRun, sched,
    fireTick: () => ticks.forEach((f) => f()),
  };
}

it("fires a due, enabled cron automation and advances next_run_at", async () => {
  const h = harness(past);
  h.repos.createAutomation("a1", {
    name: "n", enabled: true,
    trigger: { kind: "cron", cron: "0 3 * * *", timezone: "UTC" },
    action: { kind: "master", prompt: "go", cwd: "/w", sessionMode: "reuse" },
  });
  h.repos.setAutomationNextRun("a1", past); // due now
  h.sched.start();
  h.fireTick();
  await new Promise((r) => setTimeout(r, 0));
  expect(h.dispatchRun).toHaveBeenCalledOnce();
  const [calledA, calledVars] = h.dispatchRun.mock.calls[0]!;
  expect(calledA.id).toBe("a1");
  expect(calledVars).toEqual({});
  // next_run_at must have advanced beyond the past timestamp
  const fresh = h.repos.getAutomation("a1")!;
  expect(new Date(fresh.nextRunAt!).getTime()).toBeGreaterThan(new Date(past).getTime());
});

it("does not fire a disabled cron automation", async () => {
  const h = harness(past);
  h.repos.createAutomation("a1", {
    name: "n", enabled: false,
    trigger: { kind: "cron", cron: "0 3 * * *", timezone: "UTC" },
    action: { kind: "master", prompt: "go", cwd: "/w", sessionMode: "reuse" },
  });
  h.repos.setAutomationNextRun("a1", past);
  h.sched.start();
  h.fireTick();
  await new Promise((r) => setTimeout(r, 0));
  expect(h.dispatchRun).not.toHaveBeenCalled();
});

it("ignores slack-trigger automations even if due and enabled", async () => {
  const h = harness(past);
  h.repos.createAutomation("a1", {
    name: "slack-auto", enabled: true,
    trigger: { kind: "slack", channels: ["#general"] },
    action: { kind: "master", prompt: "hello", cwd: "/w", sessionMode: "fresh" },
  });
  // Manually set nextRunAt to make it look "due" (scheduler shouldn't care)
  h.repos.setAutomationNextRun("a1", past);
  h.sched.start();
  h.fireTick();
  await new Promise((r) => setTimeout(r, 0));
  expect(h.dispatchRun).not.toHaveBeenCalled();
});

it("does not fire a cron automation that is not yet due", async () => {
  const h = harness(past);
  h.repos.createAutomation("a1", {
    name: "n", enabled: true,
    trigger: { kind: "cron", cron: "0 4 * * *", timezone: "UTC" },
    action: { kind: "master", prompt: "go", cwd: "/w", sessionMode: "reuse" },
  });
  // next run is in the future relative to `past`
  h.repos.setAutomationNextRun("a1", "2026-06-22T04:00:00.000Z");
  h.sched.start();
  h.fireTick();
  await new Promise((r) => setTimeout(r, 0));
  expect(h.dispatchRun).not.toHaveBeenCalled();
});

it("runNow fires regardless of enabled/schedule state and does NOT advance next_run_at", async () => {
  const h = harness(past);
  h.repos.createAutomation("a1", {
    name: "n", enabled: false,
    trigger: { kind: "cron", cron: "0 3 * * *", timezone: "UTC" },
    action: { kind: "master", prompt: "go", cwd: "/w", sessionMode: "fresh" },
  });
  h.repos.setAutomationNextRun("a1", null);
  await h.sched.runNow("a1");
  expect(h.dispatchRun).toHaveBeenCalledOnce();
  const [calledA, calledVars] = h.dispatchRun.mock.calls[0]!;
  expect(calledA.id).toBe("a1");
  expect(calledVars).toEqual({});
  // nextRunAt should not be changed by runNow
  expect(h.repos.getAutomation("a1")!.nextRunAt).toBeNull();
});

it("reconcile sets next_run_at from cron expression when enabled", () => {
  const h = harness(past);
  h.repos.createAutomation("a1", {
    name: "n", enabled: true,
    trigger: { kind: "cron", cron: "0 4 * * *", timezone: "UTC" },
    action: { kind: "master", prompt: "go", cwd: "/w", sessionMode: "reuse" },
  });
  expect(h.repos.getAutomation("a1")!.nextRunAt).toBeNull();
  h.sched.reconcile("a1");
  const nxt = h.repos.getAutomation("a1")!.nextRunAt;
  expect(nxt).not.toBeNull();
  expect(new Date(nxt!).getTime()).toBeGreaterThan(new Date(past).getTime());
});

it("reconcile sets next_run_at to null when disabled", () => {
  const h = harness(past);
  h.repos.createAutomation("a1", {
    name: "n", enabled: false,
    trigger: { kind: "cron", cron: "0 4 * * *", timezone: "UTC" },
    action: { kind: "master", prompt: "go", cwd: "/w", sessionMode: "reuse" },
  });
  h.repos.setAutomationNextRun("a1", past); // set something first
  h.sched.reconcile("a1");
  expect(h.repos.getAutomation("a1")!.nextRunAt).toBeNull();
});

it("reconcile ignores slack-trigger automations", () => {
  const h = harness(past);
  h.repos.createAutomation("a1", {
    name: "n", enabled: true,
    trigger: { kind: "slack" },
    action: { kind: "master", prompt: "x", cwd: "/w", sessionMode: "reuse" },
  });
  h.repos.setAutomationNextRun("a1", past);
  h.sched.reconcile("a1"); // should be a no-op
  // nextRunAt should remain unchanged (reconcile returns early for non-cron)
  expect(h.repos.getAutomation("a1")!.nextRunAt).toBe(past);
});

// ── one-shot 'once' trigger (agent self-wakeup) ──
it("fires a due 'once' automation and DELETES it (one-shot)", async () => {
  const h = harness(past);
  h.repos.createAutomation("w1", {
    name: "wakeup", enabled: true,
    trigger: { kind: "once", runAt: past },
    action: { kind: "master", prompt: "resume", cwd: "/w", sessionMode: "reuse" },
  });
  h.repos.setAutomationNextRun("w1", past); // due
  h.sched.start();
  h.fireTick();
  await new Promise((r) => setTimeout(r, 0));
  expect(h.dispatchRun).toHaveBeenCalledOnce();
  expect(h.repos.getAutomation("w1")).toBeUndefined(); // self-deleted after firing
});

it("reconcile sets next_run_at to runAt for a 'once' trigger", () => {
  const h = harness(past);
  const at = "2026-06-22T05:00:00.000Z";
  h.repos.createAutomation("w1", { name: "wakeup", enabled: true, trigger: { kind: "once", runAt: at }, action: { kind: "master", prompt: "p", cwd: "/w", sessionMode: "reuse" } });
  expect(h.repos.getAutomation("w1")!.nextRunAt).toBeNull();
  h.sched.reconcile("w1");
  expect(h.repos.getAutomation("w1")!.nextRunAt).toBe(at);
});

it("does not fire a 'once' automation not yet due (and keeps it)", async () => {
  const h = harness(past);
  h.repos.createAutomation("w1", { name: "wakeup", enabled: true, trigger: { kind: "once", runAt: "2026-06-22T05:00:00.000Z" }, action: { kind: "master", prompt: "p", cwd: "/w", sessionMode: "reuse" } });
  h.repos.setAutomationNextRun("w1", "2026-06-22T05:00:00.000Z"); // future
  h.sched.start();
  h.fireTick();
  await new Promise((r) => setTimeout(r, 0));
  expect(h.dispatchRun).not.toHaveBeenCalled();
  expect(h.repos.getAutomation("w1")).toBeTruthy();
});

it("start() populates nextRunAt for a 'once' with runAt and no nextRunAt", () => {
  const h = harness(past);
  const at = "2026-06-22T06:00:00.000Z";
  h.repos.createAutomation("w1", { name: "wakeup", enabled: true, trigger: { kind: "once", runAt: at }, action: { kind: "master", prompt: "p", cwd: "/w", sessionMode: "reuse" } });
  h.sched.start();
  expect(h.repos.getAutomation("w1")!.nextRunAt).toBe(at);
});

it("once: claims (next_run=null) before firing and deletes only after the run settles — a crash mid-run can refire on boot", async () => {
  const h = harness(past);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const runs: string[] = [];
  // Gate the dispatch so the run stays "in flight" across the assertions below.
  h.dispatchRun.mockImplementation(async (a) => { runs.push(a.id); await gate; });
  h.repos.createAutomation("a1", {
    name: "wakeup", enabled: true,
    trigger: { kind: "once", runAt: past },
    action: { kind: "master", prompt: "resume", cwd: "/w", sessionMode: "reuse" },
  });
  h.repos.setAutomationNextRun("a1", past); // due (overdue)
  h.sched.start();
  h.fireTick(); // fires fireOnce
  await Promise.resolve();
  expect(runs).toEqual(["a1"]);
  expect(h.repos.getAutomation("a1")).toBeDefined(); // row survives while the run is in flight (crash-safe)
  expect(h.repos.getAutomation("a1")!.nextRunAt).toBeNull(); // claimed — the next tick cannot double-fire
  h.fireTick(); // second tick during the run
  await Promise.resolve();
  expect(runs).toEqual(["a1"]); // no double fire (claimed row is skipped)
  release();
  await new Promise((r) => setTimeout(r, 0)); // flush the fired promise's finally
  expect(h.repos.getAutomation("a1")).toBeUndefined(); // deleted after settle
});

it("once: a row left claimed by a crash is re-armed by start() and refires", () => {
  const h = harness(past);
  const at = "2026-06-22T05:00:00.000Z";
  h.repos.createAutomation("a1", { name: "wakeup", enabled: true, trigger: { kind: "once", runAt: at }, action: { kind: "master", prompt: "p", cwd: "/w", sessionMode: "reuse" } });
  h.repos.setAutomationNextRun("a1", null); // simulate the crash state: claimed (nulled) but not yet deleted
  h.sched.start(); // reconcile re-arms enabled once-rows with no next_run_at back to trigger.runAt
  expect(h.repos.getAutomation("a1")!.nextRunAt).toBe(at);
});

it("start() auto-populates nextRunAt for enabled cron with no nextRunAt", () => {
  const h = harness(past);
  h.repos.createAutomation("a1", {
    name: "n", enabled: true,
    trigger: { kind: "cron", cron: "0 4 * * *", timezone: "UTC" },
    action: { kind: "master", prompt: "go", cwd: "/w", sessionMode: "reuse" },
  });
  // nextRunAt is null initially
  h.sched.start();
  const nxt = h.repos.getAutomation("a1")!.nextRunAt;
  expect(nxt).not.toBeNull();
  expect(new Date(nxt!).getTime()).toBeGreaterThan(new Date(past).getTime());
});

it("runNow forwards vars to dispatcher.run (defaults to {})", async () => {
  const h = harness(past);
  h.repos.createAutomation("a1", {
    name: "n", enabled: false,
    trigger: { kind: "cron", cron: "0 3 * * *", timezone: "UTC" },
    action: { kind: "master", prompt: "go", cwd: "/w", sessionMode: "fresh" },
  });
  const captured: { vars: unknown }[] = [];
  h.dispatchRun.mockImplementation(async (_a, vars) => { captured.push({ vars }); });

  await h.sched.runNow("a1", { message: "hello", user: "U1" });
  expect(captured).toHaveLength(1);
  expect(captured[0]!.vars).toEqual({ message: "hello", user: "U1" });

  await h.sched.runNow("a1");
  expect(captured).toHaveLength(2);
  expect(captured[1]!.vars).toEqual({});
});
