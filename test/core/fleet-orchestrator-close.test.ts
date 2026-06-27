import { describe, it, expect } from "vitest";
import { openDb } from "../../src/persistence/db.js";
import { Repositories } from "../../src/persistence/repositories.js";
import { EventBus } from "../../src/core/events.js";
import { FakeGitOps } from "../../src/core/git-ops.js";
import { FleetOrchestrator } from "../../src/core/fleet-orchestrator.js";
import type { WorkerLike } from "../../src/core/fleet-orchestrator.js";

describe("FleetOrchestrator.close (shutdown drain)", () => {
  it("stops every live worker so in-flight DB writes finish before db.close()", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "sA", cwd: "/x" });
    let stopped = false;
    let release!: () => void;
    const settled = new Promise<void>((r) => { release = r; });
    const factory = (): WorkerLike => ({
      start: () => {},
      resume: () => {},
      send: () => {},
      stop: async () => { stopped = true; release(); },
      status: () => (stopped ? "stopped" : "running"),
      waitUntilSettled: () => settled, // pending while alive — only resolves once stop() arrives
    });
    const fleet = new FleetOrchestrator({ repos, bus: new EventBus(), git: new FakeGitOps({ headValue: "b" }), factory, worktreesDir: "/wt", idgen: () => "a0" });
    fleet.spawn({ homeSessionId: "sA", repoPath: "/code", label: "c", task: "t" });
    await new Promise((r) => setTimeout(r, 0)); // one tick so run() reaches agent.start
    expect(fleet.status("a0")).toBe("running");

    await fleet.close(1000);
    expect(stopped).toBe(true);
  });

  it("drains a worker still launching (mid-run) when close() was called", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "sA", cwd: "/x" });
    let releaseWorktree!: () => void;
    const worktreeGate = new Promise<void>((r) => { releaseWorktree = r; });
    const git = new FakeGitOps({ headValue: "b" });
    git.addWorktree = async () => { await worktreeGate; }; // block at addWorktree right after spawn starts

    let stopped = false;
    let settle!: () => void;
    const settled = new Promise<void>((r) => { settle = r; });
    const factory = (): WorkerLike => ({
      start: () => {}, resume: () => {}, send: () => {},
      stop: async () => { stopped = true; settle(); },
      status: () => (stopped ? "stopped" : "running"),
      waitUntilSettled: () => settled, // settles only once stopped (like a real running agent)
    });
    const fleet = new FleetOrchestrator({ repos, bus: new EventBus(), git, factory, worktreesDir: "/wt", idgen: () => "a0" });
    fleet.spawn({ homeSessionId: "sA", repoPath: "/code", label: "c", task: "t" });
    await new Promise((r) => setTimeout(r, 0)); // let run() block at addWorktree
    const closing = fleet.close(1000); // must wait for the in-progress launch too
    releaseWorktree(); // launch proceeds → the closing guard must also stop the just-started agent
    await closing;
    expect(stopped).toBe(true); // launch flow is drained (stopped) before shutdown → no writes after db.close
  });

  it("resolves without hanging when there are no live agents", async () => {
    const repos = new Repositories(openDb(":memory:"));
    const fleet = new FleetOrchestrator({ repos, bus: new EventBus(), git: new FakeGitOps(), factory: (() => ({})) as never, worktreesDir: "/wt" });
    await fleet.close(1000);
    expect(true).toBe(true);
  });
});
