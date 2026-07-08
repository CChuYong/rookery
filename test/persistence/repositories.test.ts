import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../../src/persistence/db.js";
import { Repositories } from "../../src/persistence/repositories.js";

function makeRepos(): Repositories {
  let n = 0;
  // Deterministic timestamps to stabilize ordering/assertions
  return new Repositories(openDb(":memory:"), () => `2026-01-01T00:00:${String(n++).padStart(2, "0")}.000Z`);
}

describe("Repositories", () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = makeRepos();
  });

  it("sets and clears a session's handoff_from_provider marker (cross-provider fork)", () => {
    repos.createSession({ id: "s1", cwd: "/x" });
    expect(repos.getSession("s1")!.handoff_from_provider).toBeNull();
    repos.setSessionHandoffFrom("s1", "claude");
    expect(repos.getSession("s1")!.handoff_from_provider).toBe("claude");
    repos.setSessionHandoffFrom("s1", null);
    expect(repos.getSession("s1")!.handoff_from_provider).toBeNull();
  });

  it("sets and clears a worker's handoff_from_provider marker (cross-provider fork)", () => {
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "w1", sessionId: "s1", repoPath: "/r", label: "w" });
    expect(repos.getWorker("w1")!.handoff_from_provider).toBeNull();
    repos.setWorkerHandoffFrom("w1", "codex");
    expect(repos.getWorker("w1")!.handoff_from_provider).toBe("codex");
    repos.setWorkerHandoffFrom("w1", null);
    expect(repos.getWorker("w1")!.handoff_from_provider).toBeNull();
  });

  it("setSessionPinned toggles pinned_at", () => {
    repos.createSession({ id: "sp", cwd: "/x" });
    expect(repos.getSession("sp")!.pinned_at).toBeNull();
    repos.setSessionPinned("sp", true);
    expect(repos.getSession("sp")!.pinned_at).toBeTruthy();
    repos.setSessionPinned("sp", false);
    expect(repos.getSession("sp")!.pinned_at).toBeNull();
  });

  it("copySessionEvents duplicates a session's transcript to another, leaving the source intact", () => {
    repos.createSession({ id: "src", cwd: "/x" });
    repos.createSession({ id: "dst", cwd: "/x" });
    repos.addSessionEvent({ sessionId: "src", seq: 0, type: "message", payloadJson: '{"role":"user"}' });
    repos.addSessionEvent({ sessionId: "src", seq: 1, type: "tool", payloadJson: '{"name":"Bash"}' });
    repos.copySessionEvents("src", "dst");
    expect(repos.listSessionEvents("dst").map((e) => [e.seq, e.type, e.payload_json])).toEqual([
      [0, "message", '{"role":"user"}'],
      [1, "tool", '{"name":"Bash"}'],
    ]);
    expect(repos.listSessionEvents("src")).toHaveLength(2); // source untouched
  });

  it("copyWorkerEvents duplicates a worker's transcript to another, leaving the source intact", () => {
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "wa", sessionId: "s1", repoPath: "/r", label: "a" });
    repos.createWorker({ id: "wb", sessionId: "s1", repoPath: "/r", label: "b" });
    repos.addWorkerEvent({ workerId: "wa", seq: 0, type: "message", payloadJson: '{"kind":"message"}' });
    repos.addWorkerEvent({ workerId: "wa", seq: 1, type: "tool_use", payloadJson: '{"kind":"tool_use"}' });
    repos.copyWorkerEvents("wa", "wb");
    expect(repos.listWorkerEvents("wb").map((e) => [e.seq, e.type, e.payload_json])).toEqual([
      [0, "message", '{"kind":"message"}'],
      [1, "tool_use", '{"kind":"tool_use"}'],
    ]);
    expect(repos.listWorkerEvents("wa")).toHaveLength(2); // source untouched
  });

  it("lastSessionEventPayload / lastWorkerEventPayload return the highest-seq payload of the type", () => {
    const repos = new Repositories(openDb(":memory:"), () => "t");
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.addSessionEvent({ sessionId: "s1", seq: 0, type: "master.result", payloadJson: '{"costUsd":1}' });
    repos.addSessionEvent({ sessionId: "s1", seq: 1, type: "master.message", payloadJson: '{"content":"x"}' });
    repos.addSessionEvent({ sessionId: "s1", seq: 2, type: "master.result", payloadJson: '{"costUsd":2}' });
    expect(repos.lastSessionEventPayload("s1", "master.result")).toBe('{"costUsd":2}');
    expect(repos.lastSessionEventPayload("s1", "nope")).toBeUndefined();
    repos.createWorker({ id: "w1", sessionId: "s1", repoPath: "/r", label: "w" });
    repos.addWorkerEvent({ workerId: "w1", seq: 0, type: "result", payloadJson: '{"costUsd":3}' });
    expect(repos.lastWorkerEventPayload("w1", "result")).toBe('{"costUsd":3}');
  });

  it("createWorker stores ticketKey/ticketUrl", () => {
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "w1", sessionId: "s1", repoPath: "/r", label: "t", ticketKey: "ENG-1", ticketUrl: "https://l/ENG-1" });
    const w = repos.getWorker("w1")!;
    expect(w.ticket_key).toBe("ENG-1");
    expect(w.ticket_url).toBe("https://l/ENG-1");
  });

  it("createWorker: provider round-trips ('codex' explicit, 'claude' default)", () => {
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "w1", sessionId: "s1", repoPath: "/r", label: "t", provider: "codex" });
    expect(repos.getWorker("w1")!.provider).toBe("codex");
    repos.createWorker({ id: "w2", sessionId: "s1", repoPath: "/r", label: "t" });
    expect(repos.getWorker("w2")!.provider).toBe("claude");
  });

  it("createSession: provider round-trips ('codex' explicit, 'claude' default)", () => {
    repos.createSession({ id: "s1", cwd: "/x", provider: "codex" });
    expect(repos.getSession("s1")!.provider).toBe("codex");
    repos.createSession({ id: "s2", cwd: "/x" });
    expect(repos.getSession("s2")!.provider).toBe("claude");
    // listSessionsWithActivity (SELECT s.*) surfaces it too — the row shape SessionManager.list() reads from.
    const rows = repos.listSessionsWithActivity();
    expect(rows.find((r) => r.id === "s1")!.provider).toBe("codex");
    expect(rows.find((r) => r.id === "s2")!.provider).toBe("claude");
  });

  it("persists worker max_turns and effort (restart budget guard, audit #9)", () => {
    const repos = new Repositories(openDb(":memory:"), () => "t");
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "w1", sessionId: "s1", repoPath: "/r", label: "w" });
    expect(repos.getWorker("w1")!.max_turns).toBeNull();
    expect(repos.getWorker("w1")!.effort).toBeNull();
    repos.setWorkerMaxTurns("w1", 10);
    repos.setWorkerEffort("w1", "low");
    expect(repos.getWorker("w1")!.max_turns).toBe(10);
    expect(repos.getWorker("w1")!.effort).toBe("low");
  });

  it("persists worker cost_budget_usd (cost-budget runaway guard, sibling of max_turns)", () => {
    const repos = new Repositories(openDb(":memory:"), () => "t");
    repos.createSession({ id: "s1", cwd: "/x" });
    // default (createWorker without costBudgetUsd) → null (unlimited)
    repos.createWorker({ id: "w1", sessionId: "s1", repoPath: "/r", label: "w" });
    expect(repos.getWorker("w1")!.cost_budget_usd).toBeNull();
    // createWorker binds an explicit costBudgetUsd directly
    repos.createWorker({ id: "w2", sessionId: "s1", repoPath: "/r", label: "w2", costBudgetUsd: 5 });
    expect(repos.getWorker("w2")!.cost_budget_usd).toBe(5);
    // setWorkerCostBudgetUsd round-trips (mirrors setWorkerMaxTurns)
    repos.setWorkerCostBudgetUsd("w1", 12.5);
    expect(repos.getWorker("w1")!.cost_budget_usd).toBe(12.5);
  });

  it("creates and reads a session", () => {
    const s = repos.createSession({ id: "s1", cwd: "/work/repo" });
    expect(s.status).toBe("active");
    expect(s.external_key).toBeNull();
    expect(repos.getSession("s1")?.cwd).toBe("/work/repo");
    expect(repos.listSessions().map((r) => r.id)).toEqual(["s1"]);
  });

  it("looks up a session by external key (e.g. Slack thread_ts)", () => {
    repos.createSession({ id: "s1", cwd: "/x", externalKey: "thread-42" });
    repos.createSession({ id: "s2", cwd: "/x" }); // same cwd, no key → separate session
    expect(repos.getSessionByExternalKey("thread-42")?.id).toBe("s1");
    expect(repos.getSessionByExternalKey("missing")).toBeUndefined();
    expect(repos.listSessions()).toHaveLength(2);
  });

  it("stores sdk_session_id and status", () => {
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.setSdkSessionId("s1", "sdk-123");
    repos.setSessionStatus("s1", "closed");
    const s = repos.getSession("s1");
    expect(s?.sdk_session_id).toBe("sdk-123");
    expect(s?.status).toBe("closed");
  });

  it("resetRunningSessions clears 'running' zombies to idle, leaves others", () => {
    repos.createSession({ id: "r1", cwd: "/x" });
    repos.createSession({ id: "r2", cwd: "/x" });
    repos.createSession({ id: "i1", cwd: "/x" });
    repos.createSession({ id: "a1", cwd: "/x" }); // stays 'active' (never started a turn)
    repos.setSessionStatus("r1", "running");
    repos.setSessionStatus("r2", "running");
    repos.setSessionStatus("i1", "idle");
    repos.resetRunningSessions();
    expect(repos.getSession("r1")?.status).toBe("idle"); // running zombie → idle
    expect(repos.getSession("r2")?.status).toBe("idle");
    expect(repos.getSession("i1")?.status).toBe("idle"); // already idle, unchanged
    expect(repos.getSession("a1")?.status).toBe("active"); // only running→idle, others untouched
  });

  it("updateRepo clears base to NULL on empty string but keeps it on undefined (DPP-6)", () => {
    repos.createRepo({ id: "r1", name: "app", path: "/p", description: "d", base: "main" });
    repos.updateRepo("app", { base: "" });
    expect(repos.getRepoByName("app")?.base).toBeNull();
    repos.updateRepo("app", { description: "d2" }); // base undefined → keep (NULL)
    expect(repos.getRepoByName("app")?.base).toBeNull();
    expect(repos.getRepoByName("app")?.description).toBe("d2");
  });

  it("listMessages bounds to the last N messages (DPP-8)", () => {
    repos.createSession({ id: "s1", cwd: "/x" });
    for (let i = 0; i < 5; i++) repos.addMessage({ sessionId: "s1", role: "user", content: `m${i}` });
    expect(repos.listMessages("s1", 3).map((m) => m.content)).toEqual(["m2", "m3", "m4"]);
    expect(repos.listMessages("s1").length).toBe(5); // default cap is high, so a normal session returns all
  });

  it("appends and lists messages in order", () => {
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.addMessage({ sessionId: "s1", role: "user", content: "hi" });
    repos.addMessage({ sessionId: "s1", role: "assistant", content: "hello" });
    expect(repos.listMessages("s1").map((m) => m.content)).toEqual(["hi", "hello"]);
  });

  it("archive/unarchive sessions + workers (archived_at toggle)", () => {
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    expect(repos.getSession("s1")?.archived_at).toBeNull();
    repos.setSessionArchived("s1", true);
    expect(repos.getSession("s1")?.archived_at).toBeTruthy();
    repos.setSessionArchived("s1", false);
    expect(repos.getSession("s1")?.archived_at).toBeNull();
    repos.setWorkerArchived("a1", true);
    expect(repos.getWorker("a1")?.archived_at).toBeTruthy();
  });

  it("deleteSession cascades messages + its workers (events, checkpoints); deleteWorker removes the row", () => {
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.addMessage({ sessionId: "s1", role: "user", content: "hi" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    repos.addWorkerEvent({ workerId: "a1", seq: 0, type: "message", payloadJson: "{}" });
    repos.addCheckpoint({ workerId: "a1", seq: 0, sha: "sha0" });
    repos.deleteSession("s1");
    expect(repos.getSession("s1")).toBeUndefined();
    expect(repos.listMessages("s1")).toEqual([]);
    expect(repos.getWorker("a1")).toBeUndefined(); // cascade
    expect(repos.listWorkerEvents("a1")).toEqual([]);
    expect(repos.listCheckpoints("a1")).toEqual([]);

    // deleteWorker on its own
    repos.createSession({ id: "s2", cwd: "/x" });
    repos.createWorker({ id: "a2", sessionId: "s2", repoPath: "/r", label: "t" });
    repos.addWorkerEvent({ workerId: "a2", seq: 0, type: "message", payloadJson: "{}" });
    repos.deleteWorker("a2");
    expect(repos.getWorker("a2")).toBeUndefined();
    expect(repos.getSession("s2")).toBeDefined(); // session is kept
  });

  it("tracks workers and their events with sinceSeq filter", () => {
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/repo/a", label: "fix-bug" });
    repos.addWorkerEvent({ workerId: "a1", seq: 0, type: "system", payloadJson: "{}" });
    repos.addWorkerEvent({ workerId: "a1", seq: 1, type: "message", payloadJson: '{"k":1}' });
    repos.setWorkerStatus("a1", "stopped");
    expect(repos.getWorker("a1")?.status).toBe("stopped");
    expect(repos.listWorkers("s1")).toHaveLength(1);
    expect(repos.listWorkerEvents("a1").map((e) => e.seq)).toEqual([0, 1]);
    expect(repos.listWorkerEvents("a1", 0).map((e) => e.seq)).toEqual([1]);
  });

  it("setWorkerStatus is terminal write-once unless forced (A1: single-chokepoint, no clobber)", () => {
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/r", label: "t" });
    repos.setWorkerStatus("a1", "running");
    repos.setWorkerStatus("a1", "done"); // enter terminal state
    repos.setWorkerStatus("a1", "error"); // try to overwrite with another terminal state → blocked
    expect(repos.getWorker("a1")?.status).toBe("done");
    repos.setWorkerStatus("a1", "idle"); // try to revert to a non-terminal state → blocked
    expect(repos.getWorker("a1")?.status).toBe("done");
    repos.setWorkerStatus("a1", "stopped", true); // user stop/discard·rehydrate = force → allowed
    expect(repos.getWorker("a1")?.status).toBe("stopped");
  });

  it("records and lists worker checkpoints ordered by seq", () => {
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/repo/a", label: "t" });
    repos.addCheckpoint({ workerId: "a1", seq: 0, sha: "sha0" });
    repos.addCheckpoint({ workerId: "a1", seq: 1, sha: "sha1" });
    const cks = repos.listCheckpoints("a1");
    expect(cks.map((c) => [c.seq, c.sha])).toEqual([[0, "sha0"], [1, "sha1"]]);
    expect(cks[0].created_at).toBeTruthy();
  });

  it("stores and searches memories by content/tags", () => {
    repos.addMemory({ content: "user prefers TypeScript", tags: "pref" });
    repos.addMemory({ content: "deploy script lives in infra/", tags: "ops,deploy" });
    expect(repos.searchMemories("typescript", 10).map((m) => m.content)).toEqual([
      "user prefers TypeScript",
    ]);
    expect(repos.searchMemories("deploy", 10)).toHaveLength(1);
    expect(repos.recentMemories(10)).toHaveLength(2);
  });

  it("recall escapes LIKE wildcards and returns nothing for a blank query (no full dump)", () => {
    const r = new Repositories(openDb(":memory:"));
    r.addMemory({ content: "ship is 100% done", tags: "" });
    r.addMemory({ content: "ship is 100x faster", tags: "" });
    // '%' must match literally — as a wildcard it would also catch 100x.
    expect(r.searchMemories("100%", 10).map((m) => m.content)).toEqual(["ship is 100% done"]);
    // An empty/whitespace query returns 0 rows, not a full dump.
    expect(r.searchMemories("", 10)).toEqual([]);
    expect(r.searchMemories("   ", 10)).toEqual([]);
  });

  it("listWorkerEvents caps a full fetch to the last `limit` events (no unbounded frame)", () => {
    const r = new Repositories(openDb(":memory:"));
    r.createSession({ id: "s1", cwd: "/x" });
    r.createWorker({ id: "w1", sessionId: "s1", repoPath: "/r", label: "w" });
    for (let i = 0; i < 10; i++) r.addWorkerEvent({ workerId: "w1", seq: i, type: "message", payloadJson: "{}" });
    expect(r.listWorkerEvents("w1", undefined, 3).map((e) => e.seq)).toEqual([7, 8, 9]); // last 3, seq ascending
    expect(r.listWorkerEvents("w1").length).toBe(10); // with the default limit (large), all of them
  });
});

describe("automations", () => {
  const mk = () => new Repositories(openDb(":memory:"), () => "2026-06-22T00:00:00.000Z");
  const cronMaster = {
    name: "nightly",
    trigger: { kind: "cron" as const, cron: "0 3 * * *", timezone: "Asia/Seoul" },
    action: { kind: "master" as const, prompt: "summarize", cwd: "/w", sessionMode: "reuse" as const },
  };
  const slackWorker = {
    name: "on-alert",
    trigger: { kind: "slack" as const, channels: ["C1"], keyword: "deploy failed" },
    action: { kind: "worker" as const, repo: "app-api", task: "investigate {{message}}", base: "main" },
    enabled: true,
  };

  it("creates+reads a cron/master automation (disabled, no run, next null)", () => {
    const r = mk();
    const a = r.createAutomation("a1", cronMaster);
    expect(a).toMatchObject({ id: "a1", name: "nightly", enabled: false, model: null, effort: null, costBudgetUsd: null, nextRunAt: null, lastRunAt: null, createdAt: "2026-06-22T00:00:00.000Z" });
    expect(a.trigger).toEqual({ kind: "cron", cron: "0 3 * * *", timezone: "Asia/Seoul" });
    expect(a.action).toEqual({ kind: "master", prompt: "summarize", cwd: "/w", sessionMode: "reuse" });
    expect(r.getAutomation("a1")).toEqual(a);
    expect(r.listAutomations()).toEqual([a]);
  });

  it("round-trips a slack/worker automation + enabled", () => {
    const r = mk();
    const a = r.createAutomation("a2", slackWorker);
    expect(a.enabled).toBe(true);
    expect(a.trigger).toEqual({ kind: "slack", channels: ["C1"], keyword: "deploy failed" });
    expect(a.action).toEqual({ kind: "worker", repo: "app-api", task: "investigate {{message}}", base: "main" });
  });

  it("updates, toggles enabled, records run + next-run, deletes", () => {
    const r = mk();
    r.createAutomation("a1", cronMaster);
    expect(r.updateAutomation("a1", { name: "renamed", enabled: true })?.name).toBe("renamed");
    expect(r.setAutomationEnabled("a1", false)?.enabled).toBe(false);
    r.setAutomationRun("a1", { lastRunAt: "2026-06-22T03:00:00.000Z", lastStatus: "ok", lastError: null });
    r.setAutomationNextRun("a1", "2026-06-23T03:00:00.000Z"); // next_run_at is owned by the Scheduler, not setAutomationRun
    const a = r.getAutomation("a1")!;
    expect(a.lastStatus).toBe("ok"); expect(a.nextRunAt).toBe("2026-06-23T03:00:00.000Z");
    r.setAutomationNextRun("a1", null); expect(r.getAutomation("a1")!.nextRunAt).toBeNull();
    r.deleteAutomation("a1"); expect(r.getAutomation("a1")).toBeUndefined();
  });

  it("automation stores/reads permissionMode + maxTurns, update is null-preserving", () => {
    const r = mk();
    const a = r.createAutomation("a1", { ...cronMaster, permissionMode: "plan", maxTurns: 5 });
    expect(r.getAutomation(a.id)?.permissionMode).toBe("plan");
    expect(r.getAutomation(a.id)?.maxTurns).toBe(5);
    r.updateAutomation(a.id, { name: "y" }); // undefined → preserved
    expect(r.getAutomation(a.id)?.permissionMode).toBe("plan");
    expect(r.getAutomation(a.id)?.maxTurns).toBe(5);
    r.updateAutomation(a.id, { permissionMode: null, maxTurns: null }); // explicit null → cleared
    expect(r.getAutomation(a.id)?.permissionMode).toBeNull();
    expect(r.getAutomation(a.id)?.maxTurns).toBeNull();
  });

  it("automation stores/reads costBudgetUsd (sibling of maxTurns), update is null-preserving", () => {
    const r = mk();
    const a = r.createAutomation("a1", { ...cronMaster, costBudgetUsd: 12.5 });
    expect(r.getAutomation(a.id)?.costBudgetUsd).toBe(12.5);
    r.updateAutomation(a.id, { name: "y" }); // undefined → preserved
    expect(r.getAutomation(a.id)?.costBudgetUsd).toBe(12.5);
    r.updateAutomation(a.id, { costBudgetUsd: null }); // explicit null → cleared
    expect(r.getAutomation(a.id)?.costBudgetUsd).toBeNull();
  });

  it("automation: costBudgetUsd defaults to null when omitted at creation", () => {
    const r = mk();
    const a = r.createAutomation("a1", cronMaster);
    expect(a.costBudgetUsd).toBeNull();
    expect(r.getAutomation("a1")?.costBudgetUsd).toBeNull();
  });

  it("automation: provider round-trips ('codex' explicit, 'claude' default)", () => {
    const r = mk();
    const a = r.createAutomation("a1", { ...cronMaster, provider: "codex" });
    expect(a.provider).toBe("codex");
    expect(r.getAutomation("a1")!.provider).toBe("codex");
    expect(r.listAutomations().find((x) => x.id === "a1")!.provider).toBe("codex");
    const b = r.createAutomation("a2", cronMaster);
    expect(b.provider).toBe("claude");
    expect(r.getAutomation("a2")!.provider).toBe("claude");
  });

  it("corrupt automation row degrades (visible, disabled, recoverable) — not whole-list death", () => {
    const r = mk();
    const a = r.createAutomation("a1", { name: "x", trigger: { kind: "cron", cron: "0 0 * * *", timezone: "UTC" }, action: { kind: "worker", repo: "app", task: "t" } });
    r.createAutomation("a2", { name: "ok", trigger: { kind: "cron", cron: "0 0 * * *", timezone: "UTC" }, action: { kind: "worker", repo: "app", task: "t2" } });
    // inject corrupt JSON directly
    (r as any).db.prepare("UPDATE automations SET trigger_config_json = '{bad' WHERE id = ?").run(a.id);
    const list = r.listAutomations();
    expect(list).toHaveLength(2); // whole list survives
    const bad = list.find((x) => x.id === a.id)!;
    expect(bad.corrupt).toBe(true);
    expect(bad.enabled).toBe(false);
    expect(bad.nextRunAt).toBeNull();
    expect(() => r.getAutomation(a.id)).not.toThrow();
    expect(r.getAutomation(a.id)?.corrupt).toBe(true);
    // recovery: update with valid trigger → corrupt gone
    r.updateAutomation(a.id, { trigger: { kind: "cron", cron: "5 0 * * *", timezone: "UTC" } });
    expect(r.getAutomation(a.id)?.corrupt).toBeUndefined();
  });
});

describe("repos registry + fleet workers", () => {
  function repos() {
    let n = 0;
    return new Repositories(openDb(":memory:"), () => `2026-01-01T00:00:${String(n++).padStart(2, "0")}.000Z`);
  }

  it("createRepo rejects duplicate name and duplicate path; getRepoByPath looks up by path", () => {
    const r = repos();
    r.createRepo({ id: "r1", name: "app", path: "/code/app", description: "" });
    expect(r.getRepoByPath("/code/app")?.name).toBe("app");
    expect(r.getRepoByPath("/nope")).toBeUndefined();
    expect(() => r.createRepo({ id: "r2", name: "app", path: "/code/other", description: "" })).toThrow(/already exists/i);
    expect(() => r.createRepo({ id: "r3", name: "pay2", path: "/code/app", description: "" })).toThrow(/already exists/i);
    // a new name/path works fine
    expect(r.createRepo({ id: "r4", name: "ads", path: "/code/ads", description: "" }).name).toBe("ads");
    expect(r.listRepos().map((r) => r.name)).toEqual(["ads", "app"]); // duplicates are not inserted (name order)
  });

  it("CRUDs repos by name", () => {
    const r = repos();
    r.createRepo({ id: "r1", name: "app-api", path: "/code/app", description: "결제 API", base: "main" });
    expect(r.getRepoByName("app-api")?.path).toBe("/code/app");
    expect(r.listRepos().map((x) => x.name)).toEqual(["app-api"]);
    r.updateRepo("app-api", { description: "결제 API v2" });
    expect(r.getRepoByName("app-api")?.description).toBe("결제 API v2");
    r.removeRepo("app-api");
    expect(r.getRepoByName("app-api")).toBeUndefined();
  });

  it("stores fleet columns on workers and lists globally", () => {
    const r = repos();
    r.createSession({ id: "sA", cwd: "/x" });
    r.createSession({ id: "sB", cwd: "/y" });
    r.createWorker({ id: "a1", sessionId: "sA", repoPath: "/code/app", label: "app", worktreePath: "/wt/a1", branch: "rookery/a1", base: "main" });
    r.createWorker({ id: "a2", sessionId: "sB", repoPath: "/code/app", label: "app", worktreePath: "/wt/a2", branch: "rookery/a2", base: "main" });
    const all = r.listAllWorkers();
    expect(all.map((x) => x.id).sort()).toEqual(["a1", "a2"]); // different sessions in one list
    expect(r.getWorker("a1")?.worktree_path).toBe("/wt/a1");
  });

  it("listSessionsWithActivity orders by last message time (newest first)", () => {
    const r = repos();
    r.createSession({ id: "s1", cwd: "/a" });
    r.createSession({ id: "s2", cwd: "/b" });
    r.addMessage({ sessionId: "s1", role: "user", content: "later" }); // s1 has more recent activity
    const list = r.listSessionsWithActivity();
    expect(list[0]!.id).toBe("s1");
    expect(list[0]!.last_activity >= list[1]!.last_activity).toBe(true);
  });
});

describe("notify-armed + pending notifications", () => {
  function r() {
    const repos = new Repositories(openDb(":memory:"), () => "t");
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "w1", sessionId: "s1", repoPath: "/r", label: "app", worktreePath: "/wt/w1", branch: "rookery/w1" });
    return repos;
  }
  it("workers are not armed by default; set/consume is one-shot and returns the home session", () => {
    const repos = r();
    expect(repos.getWorker("w1")!.notify_armed).toBe(0);
    repos.setWorkerNotifyArmed("w1", true);
    expect(repos.getWorker("w1")!.notify_armed).toBe(1);
    const consumed = repos.consumeWorkerNotifyArmed("w1");
    expect(consumed).toEqual({ armed: true, sessionId: "s1" });
    expect(repos.getWorker("w1")!.notify_armed).toBe(0);              // cleared
    expect(repos.consumeWorkerNotifyArmed("w1")).toEqual({ armed: false, sessionId: "s1" }); // second consume = not armed
    expect(repos.consumeWorkerNotifyArmed("nope")).toBeNull();        // unknown worker
  });
  it("pending notifications: add / list / delete by session", () => {
    const repos = r();
    repos.addPendingNotification("s1", "worker app — idle");
    repos.addPendingNotification("s1", "worker web — failed");
    expect(repos.pendingNotifications("s1").map((p) => p.text)).toEqual(["worker app — idle", "worker web — failed"]);
    repos.deletePendingNotifications("s1");
    expect(repos.pendingNotifications("s1")).toEqual([]);
  });
  it("deleteSession clears pending_notifications (FK cleanup — no constraint failure)", () => {
    const repos = r();
    repos.addPendingNotification("s1", "worker app — idle");
    expect(() => repos.deleteSession("s1")).not.toThrow();
    expect(repos.getSession("s1")).toBeUndefined();
    expect(repos.pendingNotifications("s1")).toEqual([]);
  });
  it("workers default to bypassPermissions; setWorkerPermissionMode updates the column", () => {
    const repos = new Repositories(openDb(":memory:"), () => "t");
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "w1", sessionId: "s1", repoPath: "/r", label: "app", worktreePath: "/wt/w1", branch: "rookery/w1" });
    expect(repos.getWorker("w1")!.permission_mode).toBe("bypassPermissions");
    repos.setWorkerPermissionMode("w1", "plan");
    expect(repos.getWorker("w1")!.permission_mode).toBe("plan");
  });
});

describe("workerActivityAndCost", () => {
  it("returns each worker's last message ts (ms) and its max cumulative cost; omits absent metrics and event-less workers", () => {
    let cur = "2026-01-01T00:00:00.000Z";
    const repos = new Repositories(openDb(":memory:"), () => cur);
    repos.createSession({ id: "s", cwd: "/x" });

    // w1: two messages + two results (cumulative cost grows)
    repos.createWorker({ id: "w1", sessionId: "s", repoPath: "/r", label: "app", worktreePath: "/wt1", branch: "b1" });
    cur = "2026-01-01T00:00:01.000Z"; repos.addWorkerEvent({ workerId: "w1", seq: 0, type: "message", payloadJson: JSON.stringify({ kind: "message", role: "assistant", content: "hi" }) });
    cur = "2026-01-01T00:00:02.000Z"; repos.addWorkerEvent({ workerId: "w1", seq: 1, type: "result", payloadJson: JSON.stringify({ kind: "result", costUsd: 0.5 }) });
    cur = "2026-01-01T00:00:03.000Z"; repos.addWorkerEvent({ workerId: "w1", seq: 2, type: "message", payloadJson: JSON.stringify({ kind: "message", role: "assistant", content: "more" }) });
    cur = "2026-01-01T00:00:04.000Z"; repos.addWorkerEvent({ workerId: "w1", seq: 3, type: "result", payloadJson: JSON.stringify({ kind: "result", costUsd: 1.25 }) });

    // w2: a message only (no result → no cost)
    repos.createWorker({ id: "w2", sessionId: "s", repoPath: "/r", label: "b", worktreePath: "/wt2", branch: "b2" });
    cur = "2026-01-01T00:00:05.000Z"; repos.addWorkerEvent({ workerId: "w2", seq: 0, type: "message", payloadJson: JSON.stringify({ kind: "message", role: "assistant", content: "x" }) });

    // w3: no events at all
    repos.createWorker({ id: "w3", sessionId: "s", repoPath: "/r", label: "c", worktreePath: "/wt3", branch: "b3" });

    // w4: has an event, but it is neither a message nor a result → GROUP BY row with both columns NULL → must be omitted
    repos.createWorker({ id: "w4", sessionId: "s", repoPath: "/r", label: "d", worktreePath: "/wt4", branch: "b4" });
    cur = "2026-01-01T00:00:06.000Z"; repos.addWorkerEvent({ workerId: "w4", seq: 0, type: "thinking", payloadJson: JSON.stringify({ kind: "thinking", text: "hmm" }) });

    const m = repos.workerActivityAndCost();
    expect(m.get("w1")).toEqual({ lastActivityTs: Date.parse("2026-01-01T00:00:03.000Z"), costUsd: 1.25 });
    expect(m.get("w2")!.lastActivityTs).toBe(Date.parse("2026-01-01T00:00:05.000Z"));
    expect(m.get("w2")!.costUsd).toBeUndefined();
    expect(m.has("w3")).toBe(false);
    expect(m.has("w4")).toBe(false); // events but no message/result → both metrics NULL → omitted by the guard
  });
});
