import { describe, it, expect, vi } from "vitest";
import { openDb } from "../../src/persistence/db.js";
import { Repositories } from "../../src/persistence/repositories.js";
import { EventBus } from "../../src/core/events.js";
import { SessionManager, AUTOMATION_FLEET_SESSION_KEY } from "../../src/core/session-manager.js";
import { FleetOrchestrator } from "../../src/core/fleet-orchestrator.js";
import type { WorkerLike } from "../../src/core/fleet-orchestrator.js";
import { FakeGitOps } from "../../src/core/git-ops.js";
import { ClaudeBackend } from "../../src/core/claude-backend.js";
import { fakeQuery, fakeBackend } from "../helpers/fake-query.js";

function manager() {
  // Use deterministic, monotonically increasing timestamps to pin down created_at ordering (removes reliance on the implicit id tiebreaker).
  let t = 0;
  const repos = new Repositories(
    openDb(":memory:"),
    () => `2026-01-01T00:00:${String(t++).padStart(2, "0")}.000Z`,
  );
  const bus = new EventBus();
  const factory = (): WorkerLike => ({ start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
  const fleet = new FleetOrchestrator({ repos, bus, git: new FakeGitOps(), factory, worktreesDir: "/wt" });
  let n = 0;
  const sm = new SessionManager(
    { repos, bus, backends: { claude: fakeBackend([]) }, masterModel: "mm", fleet },
    () => `s${n++}`,
  );
  return { repos, bus, sm };
}

// Mirrors manager() but accepts an optional shared repos so a "cold" session row can be reached
// by a fresh manager (not in its in-memory map). Returns { sm, repos } per the brief.
function makeSM(sharedRepos?: Repositories) {
  let t = 0;
  const repos = sharedRepos ?? new Repositories(
    openDb(":memory:"),
    () => `2026-01-01T00:00:${String(t++).padStart(2, "0")}.000Z`,
  );
  const bus = new EventBus();
  const factory = (): WorkerLike => ({ start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
  const fleet = new FleetOrchestrator({ repos, bus, git: new FakeGitOps(), factory, worktreesDir: "/wt" });
  let n = 0;
  const sm = new SessionManager(
    { repos, bus, backends: { claude: fakeBackend([]) }, masterModel: "mm", fleet },
    () => `s${n++}`,
  );
  return { repos, bus, sm };
}

describe("SessionManager", () => {
  it("creates a session with master and persists it", () => {
    const { sm, repos } = manager();
    const s = sm.create("/work/repo");
    expect(s.id).toBe("s0");
    expect(s.cwd).toBe("/work/repo");
    expect(s.master).toBeTruthy();
    expect(repos.getSession("s0")?.cwd).toBe("/work/repo");
  });

  it("get returns the same in-memory session instance", () => {
    const { sm } = manager();
    const s = sm.create("/x");
    expect(sm.get("s0")).toBe(s);
  });

  it("get rehydrates a session from DB when not in memory", () => {
    const { sm, repos } = manager();
    // Seed a session directly into the DB to exercise the rehydrate path
    repos.createSession({ id: "ext", cwd: "/y" });
    repos.setSdkSessionId("ext", "sdk-prev");
    const s = sm.get("ext");
    expect(s?.cwd).toBe("/y");
    expect(s?.master.getSdkSessionId()).toBe("sdk-prev");
  });

  it("list returns persisted sessions, newest activity first", () => {
    const { sm } = manager();
    sm.create("/a");
    sm.create("/b");
    // Descending by last activity (here, creation time) → the later-created /b comes first.
    expect(sm.list().map((s) => s.cwd)).toEqual(["/b", "/a"]);
    expect(typeof sm.list()[0]!.lastActivity).toBe("string");
  });

  it("tags session origin + origin_ref: ui / slack / automation (reuse + fresh)", () => {
    const { sm } = manager();
    sm.create("/ui"); // ui
    sm.getOrCreateByKey("slack:T:C:1.0", "/sk"); // slack, ref=thread key (derived from prefix)
    sm.getOrCreateByKey("automation:auto1", "/au"); // automation reuse, ref=id (derived from prefix)
    sm.create("/fresh", { origin: "automation", originRef: "auto2" }); // automation fresh (no key, explicit)
    const byCwd = Object.fromEntries(sm.list().map((s) => [s.cwd, { origin: s.origin, originRef: s.originRef }]));
    expect(byCwd["/ui"]).toEqual({ origin: "ui", originRef: null });
    expect(byCwd["/sk"]).toEqual({ origin: "slack", originRef: "T:C:1.0" });
    expect(byCwd["/au"]).toEqual({ origin: "automation", originRef: "auto1" });
    expect(byCwd["/fresh"]).toEqual({ origin: "automation", originRef: "auto2" });
  });

  it("setPinned reflects in list().pinned", () => {
    const { sm } = manager();
    const s = sm.create("/x");
    expect(sm.list().find((x) => x.id === s.id)!.pinned).toBe(false);
    sm.setPinned(s.id, true);
    expect(sm.list().find((x) => x.id === s.id)!.pinned).toBe(true);
    sm.setPinned(s.id, false);
    expect(sm.list().find((x) => x.id === s.id)!.pinned).toBe(false);
  });

  it("delete() discards the session's workers (worktree removed + row gone) before deleting the session", async () => {
    const repos = new Repositories(openDb(":memory:"));
    const bus = new EventBus();
    const git = new FakeGitOps();
    const factory = (): WorkerLike => ({ start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
    const fleet = new FleetOrchestrator({ repos, bus, git, factory, worktreesDir: "/wt" });
    let n = 0;
    const sm = new SessionManager({ repos, bus, backends: { claude: fakeBackend([]) }, masterModel: "mm", fleet }, () => `s${n++}`);
    const s = sm.create("/work");
    const { id: wid } = await fleet.spawn({ homeSessionId: s.id, repoPath: "/code", label: "w", task: "t" });
    await fleet.waitAllSettled();
    expect(repos.getWorker(wid)).toBeTruthy();

    await sm.delete(s.id);

    // Deleting a session also cleans up that session's workers in the fleet (removes the worktree) → so we don't keep writing to a row the DB cascade has deleted.
    expect(git.calls.some((c) => c.startsWith("removeWorktree"))).toBe(true);
    expect(repos.getWorker(wid)).toBeUndefined(); // worker row removed
    expect(repos.getSession(s.id)).toBeUndefined(); // session removed
  });

  it("delete() with an armed worker settling mid-teardown does not launch a ghost turn (audit #8)", async () => {
    // A worker that settles during teardown consumes its notify arm and tries to wake its home master. If the session
    // is still live when that happens, the wake-up chains a REAL ghost SDK turn whose DB writes race the row cascade
    // (→ FK violations). delete() must remove the session from the map BEFORE tearing down workers so the settle
    // notification falls through to a pending row that the cascade then sweeps — never a live master turn.
    const repos = new Repositories(openDb(":memory:"));
    const bus = new EventBus();
    const prompts: string[] = [];
    const base = fakeQuery([{ type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk" }]);
    const queryFn = ((input: { prompt?: string }) => {
      if (typeof input?.prompt === "string") prompts.push(input.prompt); // record any turn that reaches the SDK
      return (base as (x: unknown) => unknown)(input);
    }) as ReturnType<typeof fakeQuery>;
    // Fleet fake whose delete() reproduces the settle a real Worker.stop() produces: mark terminal, consume the arm,
    // and — as the production WorkerNotifier does — route the settle back into the manager as a notification.
    const fleetFake = {
      delete: async (id: string) => {
        repos.setWorkerStatus(id, "stopped", true);
        const arm = repos.consumeWorkerNotifyArmed(id);
        if (arm?.armed) sm.deliverWorkerNotification(session.id, { label: "w", branch: "b", status: "idle", tail: "" });
      },
    };
    const sm = new SessionManager(
      { repos, bus, backends: { claude: new ClaudeBackend(queryFn) }, masterModel: "mm", fleet: fleetFake as unknown as FleetOrchestrator },
      () => "s0",
    );
    const session = sm.create("/x");
    repos.createWorker({ id: "w1", sessionId: session.id, repoPath: "/r", label: "w", worktreePath: "/wt/w1", branch: "b" });
    repos.setWorkerNotifyArmed("w1", true);

    await sm.delete(session.id);

    expect(prompts).toEqual([]); // no SDK turn was launched during deletion (no ghost turn)
    expect(repos.getSession(session.id)).toBeUndefined(); // row cascaded cleanly, no FK throw
  });

  it("get() during an in-flight delete does not resurrect the session from the DB row", async () => {
    // gate fleet.delete so the delete window stays open while we probe get()
    const repos = new Repositories(openDb(":memory:"));
    const bus = new EventBus();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // Fleet fake whose delete() awaits the gate → delete() is suspended mid-teardown with the DB row still present.
    const fleetFake = {
      delete: async (_id: string) => { await gate; },
    };
    const sm = new SessionManager(
      { repos, bus, backends: { claude: fakeBackend([]) }, masterModel: "mm", fleet: fleetFake as unknown as FleetOrchestrator },
      () => "s0",
    );
    const session = sm.create("/x");
    repos.createWorker({ id: "w1", sessionId: session.id, repoPath: "/r", label: "w", worktreePath: "/wt/w1", branch: "b" });

    const deleting = sm.delete(session.id);
    await Promise.resolve(); // let delete() reach the gated fleet.delete
    expect(sm.get(session.id)).toBeUndefined(); // no DB-fallback rebuild mid-delete

    release();
    await deleting;
    expect(sm.get(session.id)).toBeUndefined(); // row cascaded; still gone
  });

  it("fork() copies the SDK session + transcript into a new ui session labelled (fork), leaving the original intact", async () => {
    const repos = new Repositories(openDb(":memory:"));
    const bus = new EventBus();
    const factory = (): WorkerLike => ({ start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
    const fleet = new FleetOrchestrator({ repos, bus, git: new FakeGitOps(), factory, worktreesDir: "/wt" });
    const forkCalls: Array<{ provider: string; id: string; title?: string }> = [];
    const forkSession = async (provider: string, sdkSessionId: string, opts?: { title?: string }) => { forkCalls.push({ provider, id: sdkSessionId, title: opts?.title }); return { sessionId: "forked-uuid" }; };
    let n = 0;
    const sm = new SessionManager({ repos, bus, backends: { claude: fakeBackend([]) }, masterModel: "mm", fleet, forkSession }, () => `s${n++}`);
    const orig = sm.create("/work/repo"); // s0
    repos.setSdkSessionId(orig.id, "orig-sdk");
    repos.setSessionLabel(orig.id, "My session");
    repos.addSessionEvent({ sessionId: orig.id, seq: 0, type: "message", payloadJson: '{"role":"user"}' });

    const forked = await sm.fork(orig.id); // s1

    expect(forkCalls).toEqual([{ provider: "claude", id: "orig-sdk", title: "My session (fork)" }]); // forked from the orig SDK session, routed by its provider
    expect(forked.id).toBe("s1");
    const row = repos.getSession(forked.id)!;
    expect(row.sdk_session_id).toBe("forked-uuid");
    expect(row.label).toBe("My session (fork)");
    expect(row.origin).toBe("ui");
    expect(row.provider).toBe("claude"); // fork inherits the source's provider
    expect(repos.listSessionEvents(forked.id)).toHaveLength(1); // transcript copied
    expect(repos.getSession(orig.id)!.sdk_session_id).toBe("orig-sdk"); // original untouched
    expect(repos.getSession(orig.id)!.label).toBe("My session");
  });

  it("fork() of a codex session calls forkSession('codex', ...) and the fork inherits the provider", async () => {
    const repos = new Repositories(openDb(":memory:"));
    const bus = new EventBus();
    const factory = (): WorkerLike => ({ start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
    const fleet = new FleetOrchestrator({ repos, bus, git: new FakeGitOps(), factory, worktreesDir: "/wt" });
    const forkCalls: Array<{ provider: string; id: string }> = [];
    const forkSession = async (provider: string, sdkSessionId: string) => { forkCalls.push({ provider, id: sdkSessionId }); return { sessionId: "forked-thread" }; };
    let n = 0;
    const sm = new SessionManager({ repos, bus, backends: { claude: fakeBackend([]), codex: fakeBackend([]) }, masterModel: "mm", fleet, forkSession }, () => `s${n++}`);
    const orig = sm.create("/work/repo", { provider: "codex" }); // s0
    repos.setSdkSessionId(orig.id, "thread-1");

    const forked = await sm.fork(orig.id); // s1

    expect(forkCalls).toEqual([{ provider: "codex", id: "thread-1" }]);
    expect(repos.getSession(forked.id)!.provider).toBe("codex"); // fork inherits the source's (codex) provider
  });

  it("fork() throws when the source session never ran a turn (no sdk_session_id)", async () => {
    const repos = new Repositories(openDb(":memory:"));
    const bus = new EventBus();
    const factory = (): WorkerLike => ({ start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
    const fleet = new FleetOrchestrator({ repos, bus, git: new FakeGitOps(), factory, worktreesDir: "/wt" });
    const sm = new SessionManager({ repos, bus, backends: { claude: fakeBackend([]) }, masterModel: "mm", fleet, forkSession: async () => ({ sessionId: "x" }) }, () => "s0");
    const orig = sm.create("/work");
    await expect(sm.fork(orig.id)).rejects.toThrow(/nothing to fork/);
  });

  it("build() routes provider→backend and resolves the provider's model via masterModelByProvider", async () => {
    const repos = new Repositories(openDb(":memory:"));
    const bus = new EventBus();
    const factory = (): WorkerLike => ({ start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
    const fleet = new FleetOrchestrator({ repos, bus, git: new FakeGitOps(), factory, worktreesDir: "/wt" });
    const claudeModels: string[] = [];
    const codexModels: string[] = [];
    const claudeBase = fakeQuery([{ type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-c" }]);
    const claudeQueryFn = ((input: { options?: { model?: string } }) => { claudeModels.push(input.options?.model ?? ""); return (claudeBase as (x: unknown) => unknown)(input); }) as ReturnType<typeof fakeQuery>;
    const codexBase = fakeQuery([{ type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-x" }]);
    // A fake "codex" backend (built the same way as the claude one — the port is provider-agnostic) so this
    // test exercises SessionManager's routing/resolver logic in isolation from the real CodexBackend.
    const codexQueryFn = ((input: { options?: { model?: string } }) => { codexModels.push(input.options?.model ?? ""); return (codexBase as (x: unknown) => unknown)(input); }) as ReturnType<typeof fakeQuery>;
    const sm = new SessionManager({
      repos, bus,
      backends: { claude: new ClaudeBackend(claudeQueryFn), codex: new ClaudeBackend(codexQueryFn) },
      masterModel: "claude-default",
      masterModelByProvider: { codex: () => "gpt-5.5-codex" },
      fleet,
    });
    const claudeSession = sm.create("/c"); // default provider (unspecified → claude)
    await claudeSession.master.runTurn("hi");
    const codexSession = sm.create("/x", { provider: "codex" });
    await codexSession.master.runTurn("hi");

    expect(claudeModels).toEqual(["claude-default"]); // claude session → claude backend + the global model resolver
    expect(codexModels).toEqual(["gpt-5.5-codex"]); // codex session → codex backend + its provider-specific resolver
    expect(repos.getSession(claudeSession.id)!.provider).toBe("claude");
    expect(repos.getSession(codexSession.id)!.provider).toBe("codex");
  });

  it("injects a session-bound canUseTool from makeCanUseTool(externalKey) into the master query (UX-13 wiring)", async () => {
    let captured: unknown = "UNSET";
    const sentinel = (() => {}) as never;
    const calls: Array<[string | null, string]> = [];
    const repos = new Repositories(openDb(":memory:"));
    const bus = new EventBus();
    const factory = (): WorkerLike => ({ start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
    const fleet = new FleetOrchestrator({ repos, bus, git: new FakeGitOps(), factory, worktreesDir: "/wt" });
    const base = fakeQuery([{ type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk" }]);
    const queryFn = ((input: { options?: { canUseTool?: unknown } }) => { captured = input.options?.canUseTool; return (base as (x: unknown) => unknown)(input); }) as ReturnType<typeof fakeQuery>;
    const makeCanUseTool = (extKey: string | null, sid: string) => { calls.push([extKey, sid]); return extKey?.startsWith("slack:") ? sentinel : undefined; };
    const sm = new SessionManager({ repos, bus, backends: { claude: new ClaudeBackend(queryFn) }, masterModel: "m", fleet, makeCanUseTool }, () => "s0");
    const session = sm.getOrCreateByKey("slack:T1:C1:1.0", "/x");
    await session.master.runTurn("hi");
    expect(calls).toContainEqual(["slack:T1:C1:1.0", "s0"]); // called with the session's externalKey
    expect(captured).toBe(sentinel); // slack session → canUseTool injected
  });

  it("does NOT wire a blocking canUseTool for automation (unattended) sessions, even when makeCanUseTool returns one", async () => {
    // A headless automation master that hits AskUserQuestion would hang forever (no client to answer), permanently
    // wedging the cron in-flight guard. Automation sessions must get NO blocking approval handler (auto-allow).
    let captured: unknown = "UNSET";
    const sentinel = (() => {}) as never;
    const repos = new Repositories(openDb(":memory:"));
    const bus = new EventBus();
    const factory = (): WorkerLike => ({ start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
    const fleet = new FleetOrchestrator({ repos, bus, git: new FakeGitOps(), factory, worktreesDir: "/wt" });
    const base = fakeQuery([{ type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk" }]);
    const queryFn = ((input: { options?: { canUseTool?: unknown } }) => { captured = input.options?.canUseTool; return (base as (x: unknown) => unknown)(input); }) as ReturnType<typeof fakeQuery>;
    const makeCanUseTool = () => sentinel; // the registry returns a BLOCKING handler for ANY session
    let n = 0;
    const sm = new SessionManager({ repos, bus, backends: { claude: new ClaudeBackend(queryFn) }, masterModel: "m", fleet, makeCanUseTool }, () => `s${n++}`);
    // fresh automation session: keyless but origin-tagged (deriveOrigin(externalKey) alone would miss it → must key on stored origin)
    const auto = sm.create("/au", { origin: "automation", originRef: "a1" });
    await auto.master.runTurn("do it");
    expect(captured).toBeUndefined(); // automation → auto-allow, never blocked
    // a normal ui session still gets the handler (general path unchanged)
    const ui = sm.create("/ui");
    await ui.master.runTurn("hi");
    expect(captured).toBe(sentinel);
  });

  it("getOrCreateByKey returns the same session for a repeated key, new for a new key", () => {
    const { sm } = manager();
    const first = sm.getOrCreateByKey("thread-1", "/work");
    const again = sm.getOrCreateByKey("thread-1", "/work");
    expect(again.id).toBe(first.id); // same thread → same session
    const other = sm.getOrCreateByKey("thread-2", "/work"); // same cwd, different key → new session
    expect(other.id).not.toBe(first.id);
    expect(sm.list()).toHaveLength(2);
  });

  it("delivers to a live master immediately; persists for a cold session and drains it on next load", async () => {
    // sm = new SessionManager({...}) as the file builds it; repos is its injected Repositories.
    const { sm, repos } = makeSM();
    const live = sm.create("/x");                         // live (in the in-memory map)
    const spy = vi.spyOn(live.master, "notifyWorker");
    sm.deliverWorkerNotification(live.id, { label: "a", branch: "ra", status: "idle", tail: "" });
    expect(spy).toHaveBeenCalledWith({ label: "a", branch: "ra", status: "idle", tail: "" });  // live → straight to the master

    // cold: a session row exists but is NOT in the live map (simulate by deleting from the map via a fresh manager over the same repos)
    repos.createSession({ id: "cold1", cwd: "/y" });
    const sm2 = makeSM(repos).sm;                          // fresh manager — "cold1" not loaded
    sm2.deliverWorkerNotification("cold1", { label: "b", branch: "rb", status: "failed", tail: "" });
    expect(repos.pendingNotifications("cold1").map((p) => JSON.parse(p.text).status)).toEqual(["failed"]); // persisted as JSON
    const loaded = sm2.get("cold1")!;                      // load → build() drains
    await loaded.master.idle();
    expect(repos.pendingNotifications("cold1")).toEqual([]); // drained
  });

  it("hides the schedule fleet home session from list()", () => {
    const repos = new Repositories(openDb(":memory:"));
    const bus = new EventBus();
    const factory = (): WorkerLike => ({ start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
    const fleet = new FleetOrchestrator({ repos, bus, git: new FakeGitOps(), factory, worktreesDir: "/wt" });
    const sm = new SessionManager({ repos, bus, backends: { claude: fakeBackend([]) }, masterModel: "m", fleet });
    sm.getOrCreateByKey(AUTOMATION_FLEET_SESSION_KEY, "/x");
    expect(sm.list().some((s) => s.cwd === "/x")).toBe(false);
  });

});
