import { describe, it, expect } from "vitest";
import { openDb } from "../../src/persistence/db.js";
import { Repositories } from "../../src/persistence/repositories.js";
import { EventBus } from "../../src/core/events.js";
import { FakeGitOps } from "../../src/core/git-ops.js";
import { FleetOrchestrator } from "../../src/core/fleet-orchestrator.js";
import type { WorkerLike } from "../../src/core/fleet-orchestrator.js";
import { createFleetToolsServer, fleetToolDefs, FLEET_SERVER_NAME, FLEET_TOOL_NAMES, formatTranscript, spawnWorkerImpl } from "../../src/tools/fleet-tools.js";

function fleet() {
  const repos = new Repositories(openDb(":memory:"));
  repos.createSession({ id: "s1", cwd: "/x" });
  const factory = (): WorkerLike => ({ start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
  const fo = new FleetOrchestrator({ repos, bus: new EventBus(), git: new FakeGitOps(), factory, worktreesDir: "/wt" });
  return { repos, fo };
}

describe("fleet tools", () => {
  it("exposes the fleet server with 9 tools incl send and interrupt", () => {
    const { repos, fo } = fleet();
    const server = createFleetToolsServer(fo, repos, "s1");
    expect(server.type).toBe("sdk");
    expect(server.name).toBe(FLEET_SERVER_NAME);
    expect(FLEET_TOOL_NAMES).toHaveLength(9);
    expect(FLEET_TOOL_NAMES).toContain("mcp__fleet__spawn_worker");
    expect(FLEET_TOOL_NAMES).toContain("mcp__fleet__view_worker_diff");
    // 'Control' tool: the master sends follow-up instructions to a running/idle worker.
    expect(FLEET_TOOL_NAMES).toContain("mcp__fleet__send_worker");
    // 'Control' tool: abort the worker's current turn while keeping the session (then redirect via send_worker).
    expect(FLEET_TOOL_NAMES).toContain("mcp__fleet__interrupt_worker");
  });

  it("spawn_worker's provider param reaches fleet.spawn and persists on the worker row", async () => {
    const { repos, fo } = fleet();
    repos.createRepo({ id: "r1", name: "app", path: "/code/app", description: "" });
    const out = await spawnWorkerImpl(fo, repos, "s1", { repo: "app", task: "do it", provider: "codex" });
    await fo.waitAllSettled();
    expect(out.isError).toBeFalsy();
    const workers = repos.listAllWorkers();
    expect(workers).toHaveLength(1);
    expect(workers[0]!.provider).toBe("codex");
  });

  it("list_workers tags each worker with its provider and supports a provider filter (interop QW2/QW6)", async () => {
    const { repos, fo } = fleet();
    repos.createWorker({ id: "cw", sessionId: "s1", repoPath: "/a", label: "alpha", provider: "claude" });
    repos.createWorker({ id: "cx", sessionId: "s1", repoPath: "/b", label: "beta", provider: "codex" });
    const defs = fleetToolDefs(fo, repos, "s1");
    const list = defs.find((d) => d.name === "list_workers")!;
    const allText = ((await list.handler({} as never, undefined)) as { content: Array<{ text: string }> }).content[0]!.text;
    expect(allText).toContain("codex"); // provider now shown, not dropped
    expect(allText).toContain("claude");
    // provider filter narrows it (mirrors the status/repo filters)
    const codexText = ((await list.handler({ provider: "codex" } as never, undefined)) as { content: Array<{ text: string }> }).content[0]!.text;
    expect(codexText).toContain("cx");
    expect(codexText).not.toContain("cw");
  });

  it("get_worker_status includes the worker's provider (interop QW2)", async () => {
    const { repos, fo } = fleet();
    repos.createRepo({ id: "r1", name: "app", path: "/code/app", description: "" });
    await spawnWorkerImpl(fo, repos, "s1", { repo: "app", task: "x", provider: "codex" });
    await fo.waitAllSettled();
    const wid = repos.listAllWorkers()[0]!.id;
    const defs = fleetToolDefs(fo, repos, "s1");
    const status = defs.find((d) => d.name === "get_worker_status")!;
    const out = ((await status.handler({ id: wid } as never, undefined)) as { content: Array<{ text: string }> }).content[0]!.text;
    expect(out).toContain("codex");
  });

  it("spawn_worker's costBudgetUsd param reaches fleet.spawn and persists on the worker row", async () => {
    const { repos, fo } = fleet();
    repos.createRepo({ id: "r1", name: "app", path: "/code/app", description: "" });
    const out = await spawnWorkerImpl(fo, repos, "s1", { repo: "app", task: "do it", costBudgetUsd: 7.5 });
    await fo.waitAllSettled();
    expect(out.isError).toBeFalsy();
    const workers = repos.listAllWorkers();
    expect(workers).toHaveLength(1);
    expect(workers[0]!.cost_budget_usd).toBe(7.5);
  });

  it("spawn_worker omits costBudgetUsd (unlimited) when not provided", async () => {
    const { repos, fo } = fleet();
    repos.createRepo({ id: "r1", name: "app", path: "/code/app", description: "" });
    await spawnWorkerImpl(fo, repos, "s1", { repo: "app", task: "do it" });
    await fo.waitAllSettled();
    const workers = repos.listAllWorkers();
    expect(workers[0]!.cost_budget_usd).toBeNull();
  });

  it("interrupt_worker appends a still-queued note when the fleet's interrupt resolves a non-empty receipt", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    const factory = (): WorkerLike => ({
      start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {},
      interruptTurn: async () => ({ stillQueued: ["u1", "u2"] }),
    });
    const fo = new FleetOrchestrator({ repos, bus: new EventBus(), git: new FakeGitOps(), factory, worktreesDir: "/wt" });
    repos.createRepo({ id: "r1", name: "app", path: "/code/app", description: "" });
    // fleet.spawn() registers a LIVE entry (fleet.interrupt requires one) — a bare repos.createWorker row would be detached/lazy.
    const { id } = await fo.spawn({ homeSessionId: "s1", repoPath: "/code/app", label: "app", task: "do it" });
    const defs = fleetToolDefs(fo, repos, "s1");
    const interrupt = defs.find((d) => d.name === "interrupt_worker")!;
    const out = ((await interrupt.handler({ id } as never, undefined)) as { content: Array<{ text: string }> }).content[0]!.text;
    expect(out).toContain("2 queued message(s) may still run");
  });
});

describe("formatTranscript", () => {
  it("keeps the NEWEST events within the byte budget and marks older ones truncated", () => {
    const events = Array.from({ length: 40 }, (_, i) => ({ seq: i, type: "message", payload: { text: "x".repeat(100) } }));
    const out = formatTranscript(events, 500); // tiny budget → only the last few events fit
    expect(out).toContain("#39 "); // newest present (the worker's current state)
    expect(out).not.toContain("#0 "); // oldest dropped
    expect(out).toMatch(/older events truncated/);
    // kept lines are chronological → the newest is last
    const lines = out.split("\n");
    expect(lines[lines.length - 1]).toContain("#39 ");
  });
  it("returns all events chronologically when within budget", () => {
    expect(
      formatTranscript([{ seq: 0, type: "message", payload: {} }, { seq: 1, type: "result", payload: {} }], 100000),
    ).toBe("#0 message: {}\n#1 result: {}");
  });
  it("returns 'No events.' for an empty transcript", () => {
    expect(formatTranscript([], 1000)).toBe("No events.");
  });
});
