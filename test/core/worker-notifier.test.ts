import { describe, it, expect, vi } from "vitest";
import { openDb } from "../../src/persistence/db.js";
import { Repositories } from "../../src/persistence/repositories.js";
import { EventBus } from "../../src/core/events.js";
import { WorkerNotifier, formatNotificationLine, parseNotification, type WorkerNotification } from "../../src/core/worker-notifier.js";

function h() {
  const repos = new Repositories(openDb(":memory:"), () => "t");
  repos.createSession({ id: "sA", cwd: "/x" });
  repos.createWorker({ id: "w1", sessionId: "sA", repoPath: "/r", label: "app", worktreePath: "/wt/w1", branch: "rookery/w1" });
  repos.addWorkerEvent({ workerId: "w1", seq: 0, type: "message", payloadJson: JSON.stringify({ kind: "message", role: "assistant", content: "done the thing" }) });
  const bus = new EventBus();
  const deliver = vi.fn();
  new WorkerNotifier({ bus, repos, deliver }).start();
  return { repos, bus, deliver };
}

it("background is NOT settled — an armed worker's arm survives it and fires only at the truthful idle", () => {
  const x = h();
  x.repos.setWorkerNotifyArmed("w1", true);
  // Turn ended but a run_in_background shell still runs → the master must NOT be woken yet.
  x.bus.emit({ type: "worker.status", sessionId: "sA", workerId: "w1", status: "background", bg: { count: 1, types: ["local_bash"] } });
  expect(x.deliver).not.toHaveBeenCalled();
  // The bg task settles (and the SDK's auto-wake turn ends) → idle = 시킨 일 다 함 → deliver exactly once.
  x.bus.emit({ type: "worker.status", sessionId: "sA", workerId: "w1", status: "idle" });
  expect(x.deliver).toHaveBeenCalledTimes(1);
});

it("armed worker reaching idle delivers one line to its home session, then disarms (one-shot)", () => {
  const x = h();
  x.repos.setWorkerNotifyArmed("w1", true);
  x.bus.emit({ type: "worker.status", sessionId: "sA", workerId: "w1", status: "idle" });
  expect(x.deliver).toHaveBeenCalledTimes(1);
  const [sid, n] = x.deliver.mock.calls[0]!;
  expect(sid).toBe("sA");
  expect(n.label).toBe("app");
  expect(n.status).toBe("idle");
  expect(n.tail).toContain("done the thing");
  // disarmed → a second settle does nothing
  x.bus.emit({ type: "worker.status", sessionId: "sA", workerId: "w1", status: "idle" });
  expect(x.deliver).toHaveBeenCalledTimes(1);
});

it("delivers the settled worker's provider so alerts are backend-attributed (interop QW3)", () => {
  const repos = new Repositories(openDb(":memory:"), () => "t");
  repos.createSession({ id: "sA", cwd: "/x" });
  repos.createWorker({ id: "cx", sessionId: "sA", repoPath: "/r", label: "cxw", worktreePath: "/wt/cx", branch: "b", provider: "codex" });
  const bus = new EventBus();
  const deliver = vi.fn();
  new WorkerNotifier({ bus, repos, deliver }).start();
  repos.setWorkerNotifyArmed("cx", true);
  bus.emit({ type: "worker.status", sessionId: "sA", workerId: "cx", status: "idle" });
  const [, n] = deliver.mock.calls[0]!;
  expect(n.provider).toBe("codex");
});

it("formatNotificationLine names the provider (interop QW3)", () => {
  const n: WorkerNotification = { label: "w", branch: "b", status: "done", tail: "t", provider: "codex" };
  expect(formatNotificationLine(n)).toContain("codex");
});

it("parseNotification preserves provider and defaults legacy/missing rows to claude", () => {
  expect(parseNotification(JSON.stringify({ label: "w", status: "done", provider: "codex" })).provider).toBe("codex");
  expect(parseNotification(JSON.stringify({ label: "w", status: "done" })).provider).toBe("claude"); // missing → claude
  expect(parseNotification("raw legacy text").provider).toBe("claude"); // non-JSON legacy row → claude
});

it("does not fire for unarmed workers, non-settled statuses, or failures-but-unarmed", () => {
  const x = h();
  x.bus.emit({ type: "worker.status", sessionId: "sA", workerId: "w1", status: "idle" }); // unarmed
  x.repos.setWorkerNotifyArmed("w1", true);
  x.bus.emit({ type: "worker.status", sessionId: "sA", workerId: "w1", status: "running" }); // not settled
  x.bus.emit({ type: "worker.status", sessionId: "sA", workerId: "w1", status: "provisioning" }); // not settled
  expect(x.deliver).not.toHaveBeenCalled();
});

it("fires on a failure settle too (so the master never hangs)", () => {
  const x = h();
  x.repos.setWorkerNotifyArmed("w1", true);
  x.bus.emit({ type: "worker.status", sessionId: "sA", workerId: "w1", status: "failed" });
  expect(x.deliver).toHaveBeenCalledTimes(1);
  expect(x.deliver.mock.calls[0]![1].status).toBe("failed");
});

describe("WorkerNotifier.sweepSettled (boot-time stranded arms)", () => {
  // Local helper: the boot-sweep tests use a delivered-array collector (not vi.fn) and hold the notifier instance
  // so sweepSettled() can be called directly, so it is scoped here rather than reusing the module-level h().
  function h() {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "w1", sessionId: "s1", repoPath: "/r", label: "w", worktreePath: "/wt/w1", branch: "b" });
    const delivered: Array<{ sessionId: string; n: WorkerNotification }> = [];
    const bus = new EventBus();
    const notifier = new WorkerNotifier({ bus, repos, deliver: (sessionId, n) => delivered.push({ sessionId, n }) });
    return { repos, bus, notifier, delivered };
  }

  it("delivers an arm whose worker settled without a bus event (restart/rehydrate path)", () => {
    const { repos, notifier, delivered } = h();
    repos.setWorkerNotifyArmed("w1", true);
    repos.setWorkerStatus("w1", "stopped"); // settled directly in the DB — no worker.status event ever fired
    notifier.sweepSettled();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.sessionId).toBe("s1");
    expect(repos.getWorker("w1")!.notify_armed).toBe(0); // one-shot consumed
    notifier.sweepSettled();
    expect(delivered).toHaveLength(1); // idempotent
  });

  it("does not consume arms of workers still running", () => {
    const { repos, notifier, delivered } = h();
    repos.setWorkerNotifyArmed("w1", true); // status is still the initial non-settled one (provisioning)
    notifier.sweepSettled();
    expect(delivered).toHaveLength(0);
    expect(repos.getWorker("w1")!.notify_armed).toBe(1);
  });
});

describe("shutdown parking (arm survives to the next boot)", () => {
  // Same delivered-array collector + held notifier instance as the boot-sweep helper: here we start()
  // then unsubscribe to model daemon shutdown, so the notifier must not be pre-started.
  function h() {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "w1", sessionId: "s1", repoPath: "/r", label: "w", worktreePath: "/wt/w1", branch: "b" });
    const delivered: Array<{ sessionId: string; n: WorkerNotification }> = [];
    const bus = new EventBus();
    const notifier = new WorkerNotifier({ bus, repos, deliver: (sessionId, n) => delivered.push({ sessionId, n }) });
    return { repos, bus, notifier, delivered };
  }

  it("after unsubscribe, a settle event does not consume the arm; the boot sweep delivers it later", () => {
    const { repos, bus, notifier, delivered } = h();
    repos.setWorkerNotifyArmed("w1", true);
    const off = notifier.start();
    off(); // shutdown: park the notifier BEFORE the fleet stops workers
    repos.setWorkerStatus("w1", "stopped", true);
    bus.emit({ type: "worker.status", sessionId: "s1", workerId: "w1", status: "stopped" }); // what fleet.close's stops emit
    expect(delivered).toHaveLength(0); // no ghost delivery during shutdown
    expect(repos.getWorker("w1")!.notify_armed).toBe(1); // arm preserved in the DB
    notifier.sweepSettled(); // next boot
    expect(delivered).toHaveLength(1);
  });
});

describe("worker-notification helpers", () => {
  const n: WorkerNotification = { label: "app", branch: "rookery/w1", status: "idle", tail: "did the thing", provider: "claude" };

  it("formatNotificationLine reproduces the model-prompt line", () => {
    expect(formatNotificationLine(n)).toBe("worker app (rookery/w1) [claude] — idle\n  did the thing");
  });

  it("parseNotification round-trips a serialized notification", () => {
    expect(parseNotification(JSON.stringify(n))).toEqual(n);
  });

  it("parseNotification falls back for a legacy plain-string row", () => {
    expect(parseNotification("worker app (b) — idle")).toEqual({ label: "", branch: "", status: "done", tail: "worker app (b) — idle", provider: "claude" });
  });
});
