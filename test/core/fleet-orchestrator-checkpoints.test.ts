import { describe, it, expect } from "vitest";
import { openDb } from "../../src/persistence/db.js";
import { Repositories } from "../../src/persistence/repositories.js";
import { EventBus } from "../../src/core/events.js";
import { FakeGitOps } from "../../src/core/git-ops.js";
import { FleetOrchestrator } from "../../src/core/fleet-orchestrator.js";
import type { WorkerLike } from "../../src/core/fleet-orchestrator.js";

// Minimal Worker factory that receives and invokes onTurnStart. behaviour controls start/status/settle.
function ckptFactory(behaviour: {
  onStart?: (onTurnStart?: () => void) => void;
  status?: () => string;
  settle?: () => Promise<void>;
}) {
  return (o: { id: string; onTurnStart?: () => void }): WorkerLike => ({
    start: () => (behaviour.onStart ? behaviour.onStart(o.onTurnStart) : o.onTurnStart?.()),
    send: () => {},
    resume: () => {},
    stop: async () => {},
    status: () => (behaviour.status ? behaviour.status() : "done"),
    waitUntilSettled: behaviour.settle ?? (async () => {}),
  });
}

function build(git: FakeGitOps, factory: ReturnType<typeof ckptFactory>) {
  const repos = new Repositories(openDb(":memory:"));
  repos.createSession({ id: "sA", cwd: "/x" });
  const bus = new EventBus();
  const fleet = new FleetOrchestrator({ repos, bus, git, factory, worktreesDir: "/wt", idgen: () => "a0" });
  return { repos, bus, fleet };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("FleetOrchestrator checkpoints (race/shutdown/restore/cleanup)", () => {
  // 1a: Two onTurnStart calls right before the same turn (e.g. start + a fast send) must not read the same seq and create a duplicate checkpoint.
  it("assigns distinct monotonic seqs to back-to-back checkpoints (no duplicate-seq race)", async () => {
    const git = new FakeGitOps({ headValue: "base0", checkpointSha: "ck" });
    // start calls onTurnStart synchronously twice → both checkpoint() calls launch together before the git op resolves.
    const factory = ckptFactory({ onStart: (ots) => { ots?.(); ots?.(); }, status: () => "done" });
    const { repos, fleet } = build(git, factory);
    const { id } = await fleet.spawn({ homeSessionId: "sA", repoPath: "/code", label: "x", task: "t" });
    await tick();
    const seqs = repos.listCheckpoints(id).map((c) => c.seq);
    expect(seqs).toEqual([0, 1]); // monotonically increasing, not a duplicate [0,0]
  });

  // 1b: The shutdown drain must wait for an in-flight checkpoint write to finish (avoids writing to a closed DB / data loss).
  it("close() waits for an in-flight checkpoint write to settle (shutdown drain)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    // A FakeGitOps whose checkpoint blocks until the gate is released.
    class GatedGit extends FakeGitOps {
      async checkpoint(wt: string, ref: string): Promise<string | null> {
        await gate;
        return super.checkpoint(wt, ref);
      }
    }
    const git = new GatedGit({ headValue: "base0", checkpointSha: "ck" });
    const factory = ckptFactory({ status: () => "done" });
    const { fleet } = build(git, factory);
    await fleet.spawn({ homeSessionId: "sA", repoPath: "/code", label: "x", task: "t" });
    await tick(); // let the checkpoint block on the gate so it becomes in-flight
    let closed = false;
    const closeP = fleet.close(5000).then(() => { closed = true; });
    await tick();
    expect(closed).toBe(false); // close hasn't finished yet because of the in-flight checkpoint
    release();
    await closeP;
    expect(closed).toBe(true);
  });

  // 1d: While the worker is running it is concurrently editing the worktree, so a restore would conflict → it must be refused.
  it("restore() refuses while the worker is running", async () => {
    const git = new FakeGitOps({ headValue: "base0", checkpointSha: "ck" });
    const factory = ckptFactory({ status: () => "running", settle: () => new Promise<void>(() => {}) });
    const { fleet } = build(git, factory);
    const { id } = await fleet.spawn({ homeSessionId: "sA", repoPath: "/code", label: "x", task: "t" });
    await expect(fleet.restore(id, 0)).rejects.toThrow(/running/i);
  });

  // 1c: discard must clean up not only the worktree+branch but also the checkpoint hidden refs in the parent .git.
  it("discard() removes the worker's checkpoint refs from the parent repo", async () => {
    const git = new FakeGitOps({ headValue: "base0", checkpointSha: "ck" });
    const factory = ckptFactory({ status: () => "done" });
    const { fleet } = build(git, factory);
    const { id } = await fleet.spawn({ homeSessionId: "sA", repoPath: "/code", label: "x", task: "t" });
    await tick();
    await fleet.discard(id);
    expect(git.calls).toContain(`removeCheckpointRefs /code ${id}`);
  });
});
