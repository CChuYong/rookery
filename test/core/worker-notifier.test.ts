import { it, expect, vi } from "vitest";
import { openDb } from "../../src/persistence/db.js";
import { Repositories } from "../../src/persistence/repositories.js";
import { EventBus } from "../../src/core/events.js";
import { WorkerNotifier } from "../../src/core/worker-notifier.js";

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

it("armed worker reaching idle delivers one line to its home session, then disarms (one-shot)", () => {
  const x = h();
  x.repos.setWorkerNotifyArmed("w1", true);
  x.bus.emit({ type: "worker.status", sessionId: "sA", workerId: "w1", status: "idle" });
  expect(x.deliver).toHaveBeenCalledTimes(1);
  const [sid, line] = x.deliver.mock.calls[0]!;
  expect(sid).toBe("sA");
  expect(line).toContain("app");
  expect(line).toContain("idle");
  expect(line).toContain("done the thing");
  // disarmed → a second settle does nothing
  x.bus.emit({ type: "worker.status", sessionId: "sA", workerId: "w1", status: "idle" });
  expect(x.deliver).toHaveBeenCalledTimes(1);
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
  expect(x.deliver.mock.calls[0]![1]).toContain("failed");
});
