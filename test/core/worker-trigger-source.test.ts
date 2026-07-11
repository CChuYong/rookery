import { describe, it, expect, vi } from "vitest";
import { openDb } from "../../src/persistence/db.js";
import { Repositories } from "../../src/persistence/repositories.js";
import { EventBus } from "../../src/core/events.js";
import { startWorkerTriggerSource } from "../../src/core/worker-trigger-source.js";
import { AUTOMATION_FLEET_SESSION_KEY } from "../../src/core/session-manager.js";
import type { AutomationInput } from "../../src/persistence/repositories.js";

function h() {
  const repos = new Repositories(openDb(":memory:"), () => "t");
  repos.createSession({ id: "sA", cwd: "/x" }); // human/UI home session
  repos.createRepo({ id: "r1", name: "app", path: "/code/app", description: "" });
  repos.createWorker({ id: "w1", sessionId: "sA", repoPath: "/code/app", label: "implement auth", worktreePath: "/wt/w1", branch: "rookery/w1" });
  repos.addWorkerEvent({ workerId: "w1", seq: 0, type: "message", payloadJson: JSON.stringify({ kind: "message", role: "assistant", content: "all done, pushed" }) });
  const bus = new EventBus();
  const run = vi.fn(async () => {});
  startWorkerTriggerSource({ repos, dispatcher: { run }, bus });
  const emit = (status: string, workerId = "w1") => bus.emit({ type: "worker.status", sessionId: "sA", workerId, status });
  const rule = (over: Partial<AutomationInput> = {}) =>
    repos.createAutomation(over.name ?? "a1", {
      name: over.name ?? "a1", enabled: true,
      trigger: { kind: "worker" },
      action: { kind: "master", prompt: "handle {{workerId}} on {{branch}}: {{tail}}", cwd: "/w", sessionMode: "fresh" },
      ...over,
    });
  return { repos, bus, run, emit, rule };
}

describe("worker trigger source", () => {
  it("fires on stopped with the full var set (registered repo name, branch, raw status, fenced-ready tail)", () => {
    const x = h();
    x.rule();
    x.emit("stopped");
    expect(x.run).toHaveBeenCalledTimes(1);
    const [a, vars] = x.run.mock.calls[0]! as unknown as [{ id: string }, Record<string, string>];
    expect(a.id).toBe("a1");
    expect(vars).toEqual({
      workerId: "w1", repo: "app", branch: "rookery/w1", status: "stopped",
      label: "implement auth", tail: "all done, pushed",
    });
  });

  it("idle does NOT fire by default; fires when opted in — and then only once despite repeated idles", () => {
    const x = h();
    x.rule({ name: "default-rule" });
    x.emit("idle");
    expect(x.run).not.toHaveBeenCalled();

    x.rule({ name: "idle-rule", trigger: { kind: "worker", on: ["idle"] } });
    x.emit("idle");
    expect(x.run).toHaveBeenCalledTimes(1);
    x.emit("idle"); // steered worker idles again → latched, no re-fire
    x.emit("idle");
    expect(x.run).toHaveBeenCalledTimes(1);
  });

  it("terminal double-emit (two writers: Worker.transition + FleetOrchestrator.setStatus) fires once", () => {
    const x = h();
    x.rule();
    x.emit("stopped");
    x.emit("stopped"); // orchestrator's duplicate emit for the same terminal state
    expect(x.run).toHaveBeenCalledTimes(1);
  });

  it("loop guard: workers homed in automation:fleet never fire (self-loop structurally impossible)", () => {
    const x = h();
    x.repos.createSession({ id: AUTOMATION_FLEET_SESSION_KEY, cwd: "/x", externalKey: AUTOMATION_FLEET_SESSION_KEY });
    x.repos.createWorker({ id: "wauto", sessionId: AUTOMATION_FLEET_SESSION_KEY, repoPath: "/code/app", label: "spawned by automation", worktreePath: "/wt/wa", branch: "rookery/wa" });
    x.rule();
    x.emit("stopped", "wauto");
    expect(x.run).not.toHaveBeenCalled();
    x.emit("stopped", "w1"); // a human-origin worker still fires
    expect(x.run).toHaveBeenCalledTimes(1);
  });

  it("live statuses (running/background/provisioning) and unknown workers are ignored", () => {
    const x = h();
    x.rule();
    x.emit("running");
    x.emit("background");
    x.emit("provisioning");
    x.emit("stopped", "ghost-worker");
    expect(x.run).not.toHaveBeenCalled();
  });

  it("disabled rules and rules disabled between snapshot and dispatch do not fire (fresh re-read)", () => {
    const x = h();
    const a = x.rule({ enabled: false });
    x.emit("stopped");
    expect(x.run).not.toHaveBeenCalled();
    x.repos.setAutomationEnabled(a.id, true);
    x.emit("error", "w1"); // latch is per (automation, worker) — w1 not yet fired for this rule
    expect(x.run).toHaveBeenCalledTimes(1);
  });

  it("repo/label filters route to the matching rule only", () => {
    const x = h();
    x.rule({ name: "app-only", trigger: { kind: "worker", repo: "app" } });
    x.rule({ name: "other-repo", trigger: { kind: "worker", repo: "other" } });
    x.rule({ name: "label-miss", trigger: { kind: "worker", label: "review" } });
    x.emit("stopped");
    expect(x.run).toHaveBeenCalledTimes(1);
    expect((x.run.mock.calls[0]![0] as { name: string }).name).toBe("app-only");
  });

  it("an unregistered repo path falls back to the raw path in {{repo}} and matches unfiltered rules", () => {
    const x = h();
    x.repos.createWorker({ id: "w2", sessionId: "sA", repoPath: "/somewhere/else", label: "adhoc", worktreePath: "/wt/w2", branch: "rookery/w2" });
    x.rule();
    x.emit("failed", "w2");
    expect(x.run).toHaveBeenCalledTimes(1);
    const [, vars] = x.run.mock.calls[0]! as unknown as [unknown, Record<string, string>];
    expect(vars.repo).toBe("/somewhere/else");
    expect(vars.status).toBe("failed");
    expect(vars.tail).toBe("(no output)"); // no assistant message persisted
  });
});
