import { describe, it, expect } from "vitest";
import { openDb } from "../../src/persistence/db.js";
import { Repositories } from "../../src/persistence/repositories.js";
import { EventBus } from "../../src/core/events.js";
import { FakeGitOps } from "../../src/core/git-ops.js";
import { FleetOrchestrator } from "../../src/core/fleet-orchestrator.js";
import type { WorkerLike } from "../../src/core/fleet-orchestrator.js";
import { createFleetToolsServer, FLEET_SERVER_NAME, FLEET_TOOL_NAMES, formatTranscript } from "../../src/tools/fleet-tools.js";

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
