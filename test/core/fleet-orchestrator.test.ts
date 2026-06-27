import { describe, it, expect } from "vitest";
import { openDb } from "../../src/persistence/db.js";
import { Repositories } from "../../src/persistence/repositories.js";
import { EventBus } from "../../src/core/events.js";
import type { CoreEvent } from "../../src/core/events.js";
import { FakeGitOps } from "../../src/core/git-ops.js";
import { FleetOrchestrator, branchSlug } from "../../src/core/fleet-orchestrator.js";
import type { WorkerLike } from "../../src/core/fleet-orchestrator.js";
import { WorkerNotifier } from "../../src/core/worker-notifier.js";

// Fake Worker that settles immediately. settleStatus mimics done/error.
function fakeFactory(started: string[], settleStatus: "done" | "error" = "done") {
  return (o: { id: string; sessionId: string; repoPath: string; label: string }): WorkerLike => {
    let state = "running";
    return {
      start: (task) => { started.push(`${o.id}:${o.repoPath}:${task}`); },
      send: () => {},
      stop: async () => { state = "stopped"; },
      status: () => state,
      waitUntilSettled: async () => { state = settleStatus; },
    };
  };
}

function setup(opts: { settle?: "done" | "error"; git?: FakeGitOps; summarizeLabel?: (task: string) => Promise<string | null> } = {}) {
  const repos = new Repositories(openDb(":memory:"));
  repos.createSession({ id: "sA", cwd: "/x" });
  repos.createSession({ id: "sB", cwd: "/y" });
  const bus = new EventBus();
  const started: string[] = [];
  const git = opts.git ?? new FakeGitOps({ headValue: "base0", diffValue: "DIFF" });
  let n = 0;
  const fleet = new FleetOrchestrator({
    repos, bus, git,
    factory: fakeFactory(started, opts.settle ?? "done"),
    worktreesDir: "/wt",
    idgen: () => `a${n++}`,
    summarizeLabel: opts.summarizeLabel,
  });
  return { repos, bus, started, git, fleet };
}

describe("FleetOrchestrator", () => {
  it("checkpoints before the first turn and restore() routes to git by seq", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "sA", cwd: "/x" });
    const bus = new EventBus();
    const git = new FakeGitOps({ headValue: "base0", checkpointSha: "ck0" });
    // Factory that actually calls onTurnStart (invoked from start).
    const factory = (o: { id: string; onTurnStart?: () => void }): WorkerLike => ({
      start: () => o.onTurnStart?.(),
      send: () => {}, stop: async () => {}, resume: () => {},
      status: () => "done", waitUntilSettled: async () => {},
    });
    const fleet = new FleetOrchestrator({ repos, bus, git, factory, worktreesDir: "/wt", idgen: () => "a0" });
    const { id } = await fleet.spawn({ homeSessionId: "sA", repoPath: "/code/app", label: "app", task: "t" });
    await fleet.waitAllSettled();
    // Yield one tick so checkpoint (async void) finishes on the microtask queue.
    await new Promise((r) => setTimeout(r, 0));
    const cks = repos.listCheckpoints(id);
    expect(cks.map((c) => [c.seq, c.sha])).toEqual([[0, "ck0"]]);
    expect(git.calls.some((c) => c.startsWith(`checkpoint /wt/${id} refs/rookery/ckpt/${id}/0`))).toBe(true);
    await fleet.restore(id, 0);
    expect(git.calls).toContain(`restoreCheckpoint /wt/${id} ck0`);
  });

  it("passes spawn-time model/effort override to the factory", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "sA", cwd: "/x" });
    const bus = new EventBus();
    let captured: { model?: string; effort?: string } = {};
    const factory = (o: { model?: string; effort?: string }): WorkerLike => {
      captured = o;
      return { start: () => {}, send: () => {}, resume: () => {}, stop: async () => {}, status: () => "done", waitUntilSettled: async () => {} };
    };
    const fleet = new FleetOrchestrator({ repos, bus, git: new FakeGitOps({ headValue: "b" }), factory, worktreesDir: "/wt", idgen: () => "a0" });
    fleet.spawn({ homeSessionId: "sA", repoPath: "/code/app", label: "app", task: "t", model: "claude-sonnet-4-6", effort: "max" });
    await fleet.waitAllSettled();
    expect(captured.model).toBe("claude-sonnet-4-6");
    expect(captured.effort).toBe("max");
  });

  it("spawn threads permissionMode to the factory; setPermissionMode routes to the live agent", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "sA", cwd: "/x" });
    const bus = new EventBus();
    let captured: { permissionMode?: string } = {};
    const calls: string[] = [];
    const factory = (o: { permissionMode?: string }): WorkerLike => {
      captured = o;
      return { start: () => {}, resume: () => {}, send: () => {}, stop: async () => {}, status: () => "idle",
        waitUntilSettled: async () => {},
        setPermissionMode: async (m: string) => { calls.push(m); } };
    };
    const fleet = new FleetOrchestrator({ repos, bus, git: new FakeGitOps({ headValue: "b" }), factory, worktreesDir: "/wt", idgen: () => "a0" });
    const { id } = await fleet.spawn({ homeSessionId: "sA", repoPath: "/code/app", label: "app", task: "t", permissionMode: "plan" });
    await fleet.waitAllSettled();
    expect(captured.permissionMode).toBe("plan");                 // threaded to factory
    await fleet.setPermissionMode(id, "bypassPermissions");
    expect(calls).toContain("bypassPermissions");                 // routed to the live agent
  });

  it("passes spawn-time permissionMode and maxTurns to the factory", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "sA", cwd: "/x" });
    const bus = new EventBus();
    let captured: { permissionMode?: string; maxTurns?: number } = {};
    const factory = (o: { permissionMode?: string; maxTurns?: number }): WorkerLike => {
      captured = o;
      return { start: () => {}, send: () => {}, resume: () => {}, stop: async () => {}, status: () => "done", waitUntilSettled: async () => {} };
    };
    const fleet = new FleetOrchestrator({ repos, bus, git: new FakeGitOps({ headValue: "b" }), factory, worktreesDir: "/wt", idgen: () => "a0" });
    fleet.spawn({ homeSessionId: "sA", repoPath: "/code/app", label: "app", task: "t", permissionMode: "plan", maxTurns: 7 });
    await fleet.waitAllSettled();
    expect(captured.permissionMode).toBe("plan");
    expect(captured.maxTurns).toBe(7);
  });

  it("spawn resolves only AFTER the worktree is created (not optimistically before)", async () => {
    let openGate!: () => void;
    const gate = new Promise<void>((r) => { openGate = r; });
    class GatedGit extends FakeGitOps {
      async addWorktree(rp: string, wt: string, b: string, base: string): Promise<void> {
        await gate; // hold off worktree creation
        return super.addWorktree(rp, wt, b, base);
      }
    }
    const git = new GatedGit({ headValue: "b" });
    const s = setup({ git });
    let resolved = false;
    const p = s.fleet.spawn({ homeSessionId: "sA", repoPath: "/code/app", label: "app", task: "t" });
    void Promise.resolve(p).then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 0));
    expect(resolved).toBe(false); // worktree gate closed → spawn must not resolve yet
    openGate();
    const { id } = await p;
    expect(id).toBe("a0");
    expect(git.calls.some((c) => c.startsWith("addWorktree"))).toBe(true); // worktree creation complete by the time it returns
  });

  it("surfaces the worker as 'provisioning' up-front (before the worktree), then reconciles its status", async () => {
    let openGate!: () => void;
    const gate = new Promise<void>((r) => { openGate = r; });
    class GatedGit extends FakeGitOps {
      async addWorktree(rp: string, wt: string, b: string, base: string): Promise<void> {
        await gate; // hold off worktree creation so we can observe the up-front state
        return super.addWorktree(rp, wt, b, base);
      }
    }
    const s = setup({ git: new GatedGit({ headValue: "b" }) });
    const events: CoreEvent[] = [];
    s.bus.subscribe("sA", (e: CoreEvent) => events.push(e));
    const p = s.fleet.spawn({ homeSessionId: "sA", repoPath: "/code/app", label: "app", task: "t" });
    await new Promise((r) => setTimeout(r, 0)); // let the up-front emit fire while the worktree gate is still closed
    // worker.spawned arrives immediately as 'provisioning' — before `git worktree add` runs — so the UI shows the row at once.
    const spawned = events.find((e) => e.type === "worker.spawned");
    expect(spawned).toMatchObject({ type: "worker.spawned", status: "provisioning" });
    expect(s.git.calls.some((c) => c.startsWith("addWorktree"))).toBe(false); // worktree not created yet
    expect(s.repos.getWorker("a0")?.status).toBe("provisioning"); // DB row born provisioning → fleet.list/reconnect stays consistent
    openGate();
    await p;
    await s.fleet.waitAllSettled();
    // once the agent boots, the provisioning state is reconciled away via a worker.status transition (no stuck spinner)
    expect(events.some((e) => e.type === "worker.status")).toBe(true);
    expect(s.repos.getWorker("a0")?.status).not.toBe("provisioning");
  });

  it("spawns: creates worktree, persists fleet row, starts agent in worktree cwd", async () => {
    const s = setup();
    const events: string[] = [];
    s.bus.subscribe("sA", (e: CoreEvent) => events.push(e.type));
    const { id } = await s.fleet.spawn({ homeSessionId: "sA", repoPath: "/code/app", label: "app", task: "do it" });
    expect(id).toBe("a0");
    // Launch awaits base resolution (git.currentBranch), so it's observable a tick after spawn.
    await s.fleet.waitAllSettled();
    expect(s.git.calls).toContain("addWorktree /code/app /wt/a0 rookery/a0 base0");
    const row = s.repos.getWorker("a0");
    expect(row?.worktree_path).toBe("/wt/a0");
    expect(row?.branch).toBe("rookery/a0");
    expect(s.started).toEqual(["a0:/wt/a0:do it"]); // worker runs in the worktree
    expect(events).toContain("worker.spawned");
  });

  it("base unset + origin/HEAD present → fetches default branch and bases on origin/main", async () => {
    const git = new FakeGitOps({ headValue: "feature", diffValue: "DIFF", remoteDefault: "origin/main" });
    const s = setup({ git });
    const { id } = await s.fleet.spawn({ homeSessionId: "sA", repoPath: "/code/app", label: "app", task: "t" });
    await s.fleet.waitAllSettled();
    expect(s.git.calls).toContain("remoteDefaultBranch /code/app");
    expect(s.git.calls).toContain("fetch /code/app main");
    expect(s.git.calls).toContain(`addWorktree /code/app /wt/${id} rookery/${id} origin/main`);
    expect(s.repos.getWorker(id)?.base).toBe("origin/main");
  });

  it("base unset + no origin (remoteDefault null) → falls back to currentBranch (HEAD)", async () => {
    const git = new FakeGitOps({ headValue: "feature", diffValue: "DIFF" }); // remoteDefault unset → null
    const s = setup({ git });
    const { id } = await s.fleet.spawn({ homeSessionId: "sA", repoPath: "/code/app", label: "app", task: "t" });
    await s.fleet.waitAllSettled();
    expect(s.git.calls).toContain("currentBranch /code/app");
    expect(s.git.calls).toContain(`addWorktree /code/app /wt/${id} rookery/${id} feature`);
    expect(s.git.calls.some((c) => c.startsWith("fetch"))).toBe(false);
    expect(s.repos.getWorker(id)?.base).toBe("feature");
  });

  it("explicit base → used as-is, no remoteDefaultBranch/fetch", async () => {
    const git = new FakeGitOps({ headValue: "feature", diffValue: "DIFF", remoteDefault: "origin/main" });
    const s = setup({ git });
    const { id } = await s.fleet.spawn({ homeSessionId: "sA", repoPath: "/code/app", label: "app", task: "t", base: "release/x" });
    await s.fleet.waitAllSettled();
    expect(s.git.calls).toContain(`addWorktree /code/app /wt/${id} rookery/${id} release/x`);
    expect(s.git.calls.some((c) => c.startsWith("remoteDefaultBranch"))).toBe(false);
    expect(s.git.calls.some((c) => c.startsWith("fetch"))).toBe(false);
    expect(s.repos.getWorker(id)?.base).toBe("release/x");
  });

  it("fetch failure is best-effort → spawn still succeeds with origin/main base", async () => {
    const git = new FakeGitOps({ headValue: "feature", diffValue: "DIFF", remoteDefault: "origin/main", fetchFails: true });
    const s = setup({ git });
    const { id } = await s.fleet.spawn({ homeSessionId: "sA", repoPath: "/code/app", label: "app", task: "t" });
    await s.fleet.waitAllSettled();
    expect(s.fleet.status(id)).toBe("done"); // spawn succeeded despite fetch failure
    expect(s.git.calls).toContain(`addWorktree /code/app /wt/${id} rookery/${id} origin/main`);
    expect(s.repos.getWorker(id)?.base).toBe("origin/main");
  });

  it("a failed base fetch surfaces a stale-base notice on the worker (not silently swallowed)", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "sA", cwd: "/x" });
    const bus = new EventBus();
    const notices: string[] = [];
    const factory = (): WorkerLike => ({
      start: () => {}, resume: () => {}, send: () => {}, stop: async () => {},
      status: () => "done", waitUntilSettled: async () => {},
      notice: (txt) => notices.push(txt),
    });
    const git = new FakeGitOps({ headValue: "b", remoteDefault: "origin/main", fetchFails: true }); // fetch attempted then fails
    const fleet = new FleetOrchestrator({ repos, bus, git, factory, worktreesDir: "/wt", idgen: () => "a0" });
    await fleet.spawn({ homeSessionId: "sA", repoPath: "/code/app", label: "app", task: "t" });
    await fleet.waitAllSettled();
    expect(notices.some((n) => /stale/i.test(n))).toBe(true);
  });

  it("a failed checkpoint surfaces a one-time notice on the worker (not per-turn spam)", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "sA", cwd: "/x" });
    const bus = new EventBus();
    const notices: string[] = [];
    // status stays "running" (a real checkpoint happens mid-turn while the agent is alive) — if it settled, the entry's agent
    // would be dropped before the async checkpoint chain runs and the notice would no-op.
    const factory = (o: { onTurnStart?: () => void }): WorkerLike => ({
      start: () => { o.onTurnStart?.(); o.onTurnStart?.(); }, // two turns → two checkpoint attempts
      resume: () => {}, send: () => {}, stop: async () => {},
      status: () => "running", waitUntilSettled: async () => {},
      notice: (txt) => notices.push(txt),
    });
    const git = new FakeGitOps({ headValue: "b" }); // no checkpointSha → checkpoint() returns null = failure
    const fleet = new FleetOrchestrator({ repos, bus, git, factory, worktreesDir: "/wt", idgen: () => "a0" });
    await fleet.spawn({ homeSessionId: "sA", repoPath: "/code/app", label: "app", task: "t" });
    await fleet.waitAllSettled();
    await new Promise((r) => setTimeout(r, 0)); // let the async checkpoint chain settle
    expect(notices.filter((n) => /checkpoint/i.test(n)).length).toBe(1); // two failed attempts → one notice
  });

  it("asynchronously relabels a freshly spawned worker via the labeler (persist + event)", async () => {
    const calls: string[] = [];
    const s = setup({ summarizeLabel: async (task) => { calls.push(task); return "Add 429 handling"; } });
    const labels: string[] = [];
    s.bus.subscribe("sA", (e: CoreEvent) => { if (e.type === "worker.label") labels.push(`${e.workerId}:${e.label}`); });
    const { id } = await s.fleet.spawn({ homeSessionId: "sA", repoPath: "/code/app", label: "app", task: "add rate limiting" });
    await s.fleet.waitAllSettled();
    expect(calls).toEqual(["add rate limiting"]); // labeler called with the input task
    expect(s.repos.getWorker(id)?.label).toBe("Add 429 handling"); // persisted update
    expect(labels).toEqual([`${id}:Add 429 handling`]); // live event
  });

  it("keeps the placeholder label when the labeler returns null, and never fails spawn when it throws", async () => {
    // null → keep placeholder, no event
    const sNull = setup({ summarizeLabel: async () => null });
    let labelEvents = 0;
    sNull.bus.subscribe("sA", (e: CoreEvent) => { if (e.type === "worker.label") labelEvents++; });
    const { id } = await sNull.fleet.spawn({ homeSessionId: "sA", repoPath: "/code/app", label: "app", task: "do it" });
    await sNull.fleet.waitAllSettled();
    expect(sNull.repos.getWorker(id)?.label).toBe("app");
    expect(labelEvents).toBe(0);
    // throw → spawn still finishes normally (done), label placeholder kept
    const sThrow = setup({ summarizeLabel: async () => { throw new Error("boom"); } });
    const { id: id2 } = await sThrow.fleet.spawn({ homeSessionId: "sB", repoPath: "/code/app", label: "app", task: "do it" });
    await sThrow.fleet.waitAllSettled();
    expect(sThrow.repos.getWorker(id2)?.status).toBe("done"); // does not fall into failure
    expect(sThrow.repos.getWorker(id2)?.label).toBe("app");
  });

  it("task-less spawn: worker idle, no spawn-time relabel; relabels from the first send", async () => {
    // Use a factory where the agent stays alive (doesn't settle immediately) so we can call send.
    const labelCalls: string[] = [];
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "sA", cwd: "/x" });
    const bus = new EventBus();
    const git = new FakeGitOps({ headValue: "base0" });
    let n = 0;
    const agents = new Map<string, { settle: () => void }>();
    const factory = (o: { id: string; sessionId: string; repoPath: string; label: string }): WorkerLike => {
      let state = "running";
      let resolveSettled: () => void = () => {};
      const settled = new Promise<void>((r) => { resolveSettled = r; });
      const agent = {
        start: (_task?: string) => { state = "idle"; }, // task-less: just go idle
        send: (_text: string) => { if (state === "idle") state = "running"; },
        stop: async () => { state = "stopped"; resolveSettled(); },
        status: () => state,
        waitUntilSettled: () => settled,
        resume: () => {},
      };
      agents.set(o.id, { settle: () => { state = "done"; resolveSettled(); } });
      return agent;
    };
    const fleet = new FleetOrchestrator({
      repos, bus, git, factory, worktreesDir: "/wt",
      idgen: () => `a${n++}`,
      summarizeLabel: async (task) => { labelCalls.push(task); return `Label: ${task}`; },
    });
    const labels: string[] = [];
    bus.subscribe("sA", (e: CoreEvent) => { if (e.type === "worker.label") labels.push(`${e.workerId}:${e.label}`); });

    // task-less spawn: no task provided
    const { id } = await fleet.spawn({ homeSessionId: "sA", repoPath: "/code/app", label: "app" });

    // Let the async run() continuation happen (but agent stays alive since settled is pending)
    await new Promise((r) => setTimeout(r, 5));

    // summarizeLabel must NOT have been called at spawn time (no task text)
    expect(labelCalls).toHaveLength(0);

    // send the first message → should trigger relabel from the message
    fleet.send(id, "build the thing");

    // Let the relabel (async) complete
    await new Promise((r) => setTimeout(r, 10));

    expect(labelCalls).toEqual(["build the thing"]);
    expect(labels).toEqual([`${id}:Label: build the thing`]);
    expect(repos.getWorker(id)?.label).toBe("Label: build the thing");

    // cleanup
    agents.get(id)?.settle();
    await fleet.waitAllSettled();
  });

  it("spawn with notify:true arms the worker; armNotify arms an existing worker", async () => {
    const s = setup();
    const { id } = await s.fleet.spawn({ homeSessionId: "sA", repoPath: "/code/app", label: "app", task: "t", notify: true });
    await s.fleet.waitAllSettled();
    // armed flag is on the DB row (consumed by the notifier later)
    expect(s.repos.getWorker(id)!.notify_armed).toBe(1);
    s.repos.setWorkerNotifyArmed(id, false);
    s.fleet.armNotify(id);
    expect(s.repos.getWorker(id)!.notify_armed).toBe(1);
  });

  it("end-to-end: spawn(notify) → worker idles → home master is delivered one notification", async () => {
    const s = setup();                              // its fakeFactory worker settles to 'done' by default
    const delivered: Array<[string, string]> = [];
    new WorkerNotifier({ bus: s.bus, repos: s.repos, deliver: (sid, line) => delivered.push([sid, line]) }).start();
    const { id } = await s.fleet.spawn({ homeSessionId: "sA", repoPath: "/code/app", label: "app", task: "do it", notify: true });
    await s.fleet.waitAllSettled();
    await new Promise((r) => setTimeout(r, 0));      // let the bus listener run
    expect(delivered).toHaveLength(1);
    expect(delivered[0]![0]).toBe("sA");             // routed to the home (master) session
    expect(delivered[0]![1]).toContain("app");
  });

  it("spawn with a task relabels at spawn (unchanged)", async () => {
    const labelCalls: string[] = [];
    const s = setup({ summarizeLabel: async (task) => { labelCalls.push(task); return `Label: ${task}`; } });

    const { id } = await s.fleet.spawn({ homeSessionId: "sA", repoPath: "/code/app", label: "app", task: "fix bug" });
    await s.fleet.waitAllSettled();

    // summarizeLabel called at spawn time with the task
    expect(labelCalls).toEqual(["fix bug"]);
    expect(s.repos.getWorker(id)?.label).toBe("Label: fix bug");
  });

  it("on settle (done): records terminal status 'done'", async () => {
    // Control-plane model: the worker opens the PR itself if needed. The orchestrator does not.
    const s = setup({ settle: "done" });
    const statuses: string[] = [];
    s.bus.subscribe("sA", (e: CoreEvent) => { if (e.type === "worker.status") statuses.push(e.status); });
    const { id } = await s.fleet.spawn({ homeSessionId: "sA", repoPath: "/code/app", label: "app", task: "t" });
    await s.fleet.waitAllSettled();
    expect(s.fleet.status(id)).toBe("done");
    expect(statuses).toContain("done");
  });

  it("persists the resolved base (not the unresolved input) for restart recovery", async () => {
    // base unset → the value resolved from currentBranch ("base0") must persist in the DB so diff is correct after restart.
    const s = setup({ settle: "done" });
    const { id } = await s.fleet.spawn({ homeSessionId: "sA", repoPath: "/code/app", label: "app", task: "t" });
    await s.fleet.waitAllSettled();
    expect(s.repos.getWorker(id)?.base).toBe("base0");
  });

  it("on settle (error): records status 'failed'", async () => {
    const s = setup({ settle: "error" });
    const { id } = await s.fleet.spawn({ homeSessionId: "sA", repoPath: "/code/app", label: "app", task: "t" });
    await s.fleet.waitAllSettled();
    expect(s.fleet.status(id)).toBe("failed");
  });

  it("does not reject waitAllSettled when worktree creation fails; marks status failed", async () => {
    const badGit = new FakeGitOps({});
    badGit.addWorktree = async () => { throw new Error("worktree exists"); };
    const s = setup({ git: badGit });
    const { id } = await s.fleet.spawn({ homeSessionId: "sA", repoPath: "/code/app", label: "app", task: "t" });
    await expect(s.fleet.waitAllSettled()).resolves.toBeUndefined();
    expect(s.fleet.status(id)).toBe("failed");
  });

  it("records the failure event with a real next seq (not the magic 9999)", async () => {
    // Hardcoded 9999 collides with real seq and breaks sinceSeq incremental fetch → must use MAX(seq)+1.
    const badGit = new FakeGitOps({});
    badGit.addWorktree = async () => { throw new Error("worktree exists"); };
    const s = setup({ git: badGit });
    const { id } = await s.fleet.spawn({ homeSessionId: "sA", repoPath: "/code/app", label: "app", task: "t" });
    await s.fleet.waitAllSettled();
    const evs = s.repos.listWorkerEvents(id);
    const errEv = evs.find((e) => e.type === "error");
    expect(errEv?.seq).toBe(0); // no prior events, so the first seq is 0
    expect(evs.every((e) => e.seq !== 9999)).toBe(true);
  });

  it("list is global across home sessions; diff + discard delegate to git", async () => {
    const s = setup();
    s.fleet.spawn({ homeSessionId: "sA", repoPath: "/code/app", label: "app", task: "t" });
    s.fleet.spawn({ homeSessionId: "sB", repoPath: "/code/ledger", label: "ledger", task: "t" });
    await s.fleet.waitAllSettled();
    expect(s.fleet.list().map((x) => x.id).sort()).toEqual(["a0", "a1"]);
    expect(await s.fleet.diff("a0")).toBe("DIFF");
    await s.fleet.discard("a0");
    expect(s.git.calls).toContain("removeWorktree /code/app /wt/a0 rookery/a0");
  });

  it("does not cap concurrent spawns (ROOKERY_MAX_WORKERS concept removed)", async () => {
    const s = setup(); // no concurrent-worker cap anymore (cost handled by a separate budget) — spawn all without rejection.
    const spawns = await Promise.all([0, 1, 2, 3, 4].map(() => s.fleet.spawn({ homeSessionId: "sA", repoPath: "/r", label: "r", task: "t" })));
    expect(new Set(spawns.map((x) => x.id)).size).toBe(5); // all 5 spawn without rejection
  });

  // Controllable fake: doesn't settle before stop, mimicking a "live" state. _idle() mimics turn end (waiting).
  function liveSetup() {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "sA", cwd: "/x" });
    const bus = new EventBus();
    const git = new FakeGitOps({ headValue: "base0" });
    const agents = new Map<string, { _idle: () => void; interruptCalls: number }>();
    let n = 0;
    const factory = (o: { id: string; sessionId: string; repoPath: string; label: string }): WorkerLike => {
      let state = "running";
      let resolveSettled: () => void = () => {};
      const settled = new Promise<void>((r) => { resolveSettled = r; });
      const leaveRunning = (s: string) => { state = s; };
      const agent = {
        start: () => {},
        send: () => { if (state === "idle") state = "running"; },
        stop: async () => { leaveRunning("stopped"); resolveSettled(); },
        status: () => state,
        waitUntilSettled: () => settled,
        interruptTurn: async () => { agent.interruptCalls++; }, // interrupt current turn only (state/queue unchanged)
        _idle: () => leaveRunning("idle"),
        interruptCalls: 0,
      };
      agents.set(o.id, agent);
      return agent;
    };
    const fleet = new FleetOrchestrator({ repos, bus, git, factory, worktreesDir: "/wt", idgen: () => `a${n++}` });
    return { repos, bus, fleet, agents };
  }
  async function until(cond: () => boolean, tries = 100): Promise<void> {
    for (let i = 0; i < tries; i++) { if (cond()) return; await new Promise((r) => setTimeout(r, 1)); }
    throw new Error("until: condition never met");
  }

  it("status() reflects the live agent (idle), not a stale 'running'", async () => {
    const s = liveSetup();
    const { id } = await s.fleet.spawn({ homeSessionId: "sA", repoPath: "/r", label: "r", task: "t" });
    await until(() => s.agents.has(id));
    s.agents.get(id)!._idle();
    expect(s.fleet.status(id)).toBe("idle");
  });

  it("stop() settles a live (idle) agent's flow and marks it stopped", async () => {
    const s = liveSetup();
    const { id } = await s.fleet.spawn({ homeSessionId: "sA", repoPath: "/r", label: "r", task: "t" });
    await until(() => s.agents.has(id));
    s.agents.get(id)!._idle(); // live idle
    await s.fleet.stop(id);
    await s.fleet.waitAllSettled(); // the stopped agent's flow drops out (terminal drain)
    expect(s.fleet.status(id)).toBe("stopped");
  });

  it("interrupt() calls the live agent's interruptTurn (current turn only, agent stays alive)", async () => {
    const s = liveSetup();
    const { id } = await s.fleet.spawn({ homeSessionId: "sA", repoPath: "/r", label: "r", task: "t" });
    await until(() => s.agents.has(id));
    await s.fleet.interrupt(id);
    expect(s.agents.get(id)!.interruptCalls).toBe(1); // live agent.interruptTurn called
    expect(s.fleet.status(id)).toBe("running"); // not terminated (session kept)
    await s.fleet.stop(id); // cleanup
  });

  // A3: discard used to race trackFlow settle and emit the terminal worker.status twice → write-once means just once.
  it("emits a terminal worker.status only once when discard races trackFlow settle (write-once)", async () => {
    const s = liveSetup();
    const terminals: string[] = [];
    const TERMINAL = ["stopped", "done", "failed", "error", "orphaned"];
    s.bus.subscribe("sA", (e) => {
      if (e.type === "worker.status" && TERMINAL.includes((e as { status: string }).status)) terminals.push((e as { status: string }).status);
    });
    const { id } = await s.fleet.spawn({ homeSessionId: "sA", repoPath: "/r", label: "r", task: "t" });
    await until(() => s.agents.has(id));
    await s.fleet.discard(id);
    await s.fleet.waitAllSettled();
    expect(terminals).toEqual(["stopped"]); // exactly once (no duplicate emit / flip-flop)
  });

});

describe("FleetOrchestrator rehydrate (restart recovery)", () => {
  // Mimic a restart: the DB still has the old worker row but the entries Map is empty.
  function restarted() {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "sA", cwd: "/x" });
    repos.createWorker({ id: "old1", sessionId: "sA", repoPath: "/code/app", label: "app", worktreePath: "/wt/old1", branch: "rookery/old1", base: "main" });
    const git = new FakeGitOps({ diffValue: "DIFF" });
    const fleet = new FleetOrchestrator({
      repos, bus: new EventBus(), git,
      factory: () => { throw new Error("rehydrated fleet must not spawn"); },
      worktreesDir: "/wt",
    });
    return { repos, git, fleet };
  }

  it("rebuilds detached entries and reconciles 'running' zombies to 'orphaned'", () => {
    const s = restarted();
    s.fleet.rehydrate();
    expect(s.fleet.status("old1")).toBe("orphaned");
    expect(s.repos.getWorker("old1")?.status).toBe("orphaned");
  });

  it("resumes a running agent that has a persisted sdk_session_id (→ live idle)", () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "sA", cwd: "/x" });
    repos.createWorker({ id: "old2", sessionId: "sA", repoPath: "/code/app", label: "app", worktreePath: "/wt/old2", branch: "rookery/old2", base: "main" });
    repos.setWorkerSdkSessionId("old2", "sdk-old2");
    const resumed: string[] = [];
    let captured: { sdkSessionId?: string | null; repoPath?: string } = {};
    const fleet = new FleetOrchestrator({
      repos, bus: new EventBus(), git: new FakeGitOps(),
      factory: (o) => {
        captured = o;
        return { start: () => {}, resume: () => resumed.push(o.id), send: () => {}, stop: async () => {}, status: () => "idle", waitUntilSettled: async () => {} };
      },
      worktreesDir: "/wt", exists: () => true,
    });
    fleet.rehydrate();
    expect(resumed).toEqual([]); // lazy: no SDK resume at boot
    expect(fleet.status("old2")).toBe("idle"); // appears idle (ready) to the user
    fleet.send("old2", "hi"); // first send → lazy resume (materialize) happens here
    expect(resumed).toEqual(["old2"]); // resume() called
    expect(captured.sdkSessionId).toBe("sdk-old2"); // session id passed through
    expect(captured.repoPath).toBe("/wt/old2"); // resumed in the worktree
    expect(fleet.status("old2")).toBe("idle");
  });

  it("rehydrates a 'stopped' agent as resumable too — one stopped by a terminal flush isn't frozen as STOP after restart", () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "sA", cwd: "/x" });
    // st1: stopped with live worktree+sdk_session → restored to idle (ready)
    repos.createWorker({ id: "st1", sessionId: "sA", repoPath: "/code/app", label: "app", worktreePath: "/wt/st1", branch: "rookery/st1", base: "main" });
    repos.setWorkerSdkSessionId("st1", "sdk-st1");
    repos.setWorkerStatus("st1", "stopped"); // on shutdown fleet.close stops for flush → stopped
    // st2: stopped zombie with no worktree → orphaned
    repos.createWorker({ id: "st2", sessionId: "sA", repoPath: "/code/app", label: "app", worktreePath: "/wt/st2", branch: "rookery/st2", base: "main" });
    repos.setWorkerStatus("st2", "stopped");
    const fleet = new FleetOrchestrator({
      repos, bus: new EventBus(), git: new FakeGitOps(),
      factory: () => ({ start: () => {}, resume: () => {}, send: () => {}, stop: async () => {}, status: () => "idle", waitUntilSettled: async () => {} }),
      worktreesDir: "/wt", exists: (p) => p === "/wt/st1",
    });
    fleet.rehydrate();
    expect(fleet.status("st1")).toBe("idle"); // resumable → idle, not STOP
    expect(repos.getWorker("st1")?.status).toBe("idle"); // DB is idle too → fleet.list (UI) shows idle
    expect(fleet.status("st2")).toBe("orphaned"); // no worktree → orphaned
    expect(repos.getWorker("st2")?.status).toBe("orphaned");
  });

  it("diff works on a rehydrated (detached) agent using the persisted base", async () => {
    const s = restarted();
    s.fleet.rehydrate();
    expect(await s.fleet.diff("old1")).toBe("DIFF");
    expect(s.git.calls).toContain("diff /wt/old1 main");
  });

  it("discard removes the worktree of a rehydrated (detached) agent", async () => {
    const s = restarted();
    s.fleet.rehydrate();
    await s.fleet.discard("old1");
    expect(s.git.calls).toContain("removeWorktree /code/app /wt/old1 rookery/old1");
  });

  it("send to a rehydrated (detached) agent throws a clear 'not running' error", () => {
    const s = restarted();
    s.fleet.rehydrate();
    expect(() => s.fleet.send("old1", "hi")).toThrow(/not running/i);
  });

  // A row resumable thanks to its sdk_session_id + a controllable resume fake.
  function resumable(opts: { exists?: boolean; max?: number } = {}) {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "sA", cwd: "/x" });
    repos.createWorker({ id: "old1", sessionId: "sA", repoPath: "/code/app", label: "app", worktreePath: "/wt/old1", branch: "rookery/old1", base: "main" });
    repos.setWorkerSdkSessionId("old1", "sdk-1");
    const agents = new Map<string, { _settle: (s: string) => void }>();
    const factory = (o: { id: string }): WorkerLike => {
      let state = "running";
      let resolveSettled: () => void = () => {};
      const settled = new Promise<void>((r) => { resolveSettled = r; });
      const agent = {
        start: () => {},
        resume: () => { state = "idle"; },
        send: () => { if (state === "idle") state = "running"; },
        stop: async () => { state = "stopped"; resolveSettled(); },
        status: () => state,
        waitUntilSettled: () => settled,
        _settle: (s: string) => { state = s; resolveSettled(); },
      };
      agents.set(o.id, agent);
      return agent;
    };
    const fleet = new FleetOrchestrator({ repos, bus: new EventBus(), git: new FakeGitOps(), factory, worktreesDir: "/wt", exists: () => opts.exists ?? true });
    return { repos, fleet, agents };
  }

  it("marks resumable but does NOT eagerly resume at boot (lazy)", () => {
    const s = resumable({ exists: true });
    s.fleet.rehydrate();
    expect(s.agents.has("old1")).toBe(false); // lazy: no SDK session spun up at boot
    expect(s.fleet.status("old1")).toBe("idle"); // appears ready
  });

  it("lazily resumes (materializes) the agent on first send", () => {
    const s = resumable({ exists: true });
    s.fleet.rehydrate();
    expect(s.agents.has("old1")).toBe(false);
    s.fleet.send("old1", "continue"); // first send → resume
    expect(s.agents.has("old1")).toBe(true);
  });

  it("does not resume when the worktree is gone — marks orphaned, frees the slot", () => {
    const s = resumable({ exists: false, max: 1 });
    s.fleet.rehydrate();
    expect(s.agents.has("old1")).toBe(false);
    expect(s.fleet.status("old1")).toBe("orphaned");
    expect(() => s.fleet.spawn({ homeSessionId: "sA", repoPath: "/r", label: "r", task: "t" })).not.toThrow();
  });

  it("stopping a pending-resumable agent does not resume it (just marks stopped)", async () => {
    const s = resumable({ exists: true });
    s.fleet.rehydrate();
    await s.fleet.stop("old1");
    await s.fleet.waitAllSettled();
    expect(s.agents.has("old1")).toBe(false); // cleaned up without resuming
    expect(s.fleet.status("old1")).toBe("stopped");
  });

  // A2: during terminal drain, don't materialize a lazy-resumable worker — prevents a resume→consume write racing against a closed DB.
  it("does not materialize a lazy-resumable agent once closing (shutdown guard)", async () => {
    const s = resumable({ exists: true });
    s.fleet.rehydrate();
    await s.fleet.close(); // closing=true
    expect(() => s.fleet.send("old1", "x")).toThrow(/not running/i); // rejects without materializing
    expect(s.agents.has("old1")).toBe(false); // no SDK session spun up
  });

});

describe("ticket → branch", () => {
  it("branchSlug normalizes ticket identifiers", () => {
    expect(branchSlug("ENG-123")).toBe("eng-123");
    expect(branchSlug("#456")).toBe("issue-456");
    expect(branchSlug("  ")).toBe("");
  });

  it("spawn derives branch from ticketKey and suffixes on collision", async () => {
    const s = setup();
    await s.fleet.spawn({ homeSessionId: "sA", repoPath: "/x", label: "t", task: "x", ticketKey: "ENG-9", ticketUrl: "u" });
    expect(s.repos.listWorkers("sA")[0]!.branch).toBe("rookery/eng-9");
    expect(s.repos.listWorkers("sA")[0]!.ticket_key).toBe("ENG-9"); // persisted
    await s.fleet.spawn({ homeSessionId: "sA", repoPath: "/x", label: "t", task: "x", ticketKey: "ENG-9", ticketUrl: "u" });
    const b2 = s.repos.listWorkers("sA").find((w) => w.branch !== "rookery/eng-9")!.branch!;
    expect(b2.startsWith("rookery/eng-9-")).toBe(true); // collision → suffix
    expect(b2).not.toBe("rookery/eng-9");
  });

  it("spawn without ticketKey keeps rookery/<id>", async () => {
    const s = setup();
    await s.fleet.spawn({ homeSessionId: "sA", repoPath: "/x", label: "t", task: "x" });
    expect(s.repos.listWorkers("sA")[0]!.branch).toMatch(/^rookery\/a\d+$/);
  });
});
