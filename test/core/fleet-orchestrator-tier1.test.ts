import { describe, it, expect } from "vitest";
import { openDb } from "../../src/persistence/db.js";
import { Repositories } from "../../src/persistence/repositories.js";
import { EventBus } from "../../src/core/events.js";
import { FakeGitOps } from "../../src/core/git-ops.js";
import { FleetOrchestrator } from "../../src/core/fleet-orchestrator.js";
import type { WorkerLike } from "../../src/core/fleet-orchestrator.js";

const immediateFactory = (): WorkerLike => {
  let state = "running";
  return {
    start: () => {}, resume: () => {}, send: () => {},
    stop: async () => { state = "stopped"; },
    status: () => state,
    waitUntilSettled: async () => { state = "done"; }, // settle immediately → run() post-settle setStatus("done")
  };
};

function makeFleet(git: FakeGitOps) {
  const repos = new Repositories(openDb(":memory:"));
  repos.createSession({ id: "sA", cwd: "/x" });
  const fleet = new FleetOrchestrator({ repos, bus: new EventBus(), git, factory: immediateFactory, worktreesDir: "/wt", idgen: () => "a0" });
  return { repos, fleet };
}

describe("FleetOrchestrator Tier 1 fixes", () => {
  it("FL-4: discard() records 'stopped' even when removeWorktree fails", async () => {
    const git = new FakeGitOps({ headValue: "b" });
    git.removeWorktree = async () => { throw new Error("worktree locked"); };
    const { repos, fleet } = makeFleet(git);
    fleet.spawn({ homeSessionId: "sA", repoPath: "/code", label: "c", task: "t" });
    await fleet.waitAllSettled();
    await expect(fleet.discard("a0")).rejects.toThrow(); // a removeWorktree failure propagates
    expect(repos.getWorker("a0")?.status).toBe("stopped"); // status still always settles regardless
  });

  it("DPP-2: transcript() tolerates a corrupt payload_json row", async () => {
    const { repos, fleet } = makeFleet(new FakeGitOps({ headValue: "b" }));
    fleet.spawn({ homeSessionId: "sA", repoPath: "/code", label: "c", task: "t" });
    await fleet.waitAllSettled();
    repos.addWorkerEvent({ workerId: "a0", seq: repos.nextWorkerSeq("a0"), type: "message", payloadJson: "{not valid json" });
    let out: Array<{ payload: unknown }> = [];
    expect(() => { out = fleet.transcript("a0"); }).not.toThrow();
    expect(out.some((e) => (e.payload as { kind?: string })?.kind === "corrupt")).toBe(true);
  });

  it("git-diff: diff() is byte-capped (no huge single WS frame)", async () => {
    const big = "x".repeat(2_000_000);
    const { fleet } = makeFleet(new FakeGitOps({ headValue: "b", diffValue: big }));
    fleet.spawn({ homeSessionId: "sA", repoPath: "/code", label: "c", task: "t" });
    await fleet.waitAllSettled();
    const d = await fleet.diff("a0");
    expect(Buffer.byteLength(d, "utf8")).toBeLessThanOrEqual(512 * 1024 + 64);
    expect(d.length).toBeLessThan(big.length);
  });
});
