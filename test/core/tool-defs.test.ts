import { describe, it, expect } from "vitest";
import { openDb } from "../../src/persistence/db.js";
import { Repositories } from "../../src/persistence/repositories.js";
import { EventBus } from "../../src/core/events.js";
import { FleetOrchestrator } from "../../src/core/fleet-orchestrator.js";
import type { WorkerLike } from "../../src/core/fleet-orchestrator.js";
import { FakeGitOps } from "../../src/core/git-ops.js";
import { memoryToolDefs } from "../../src/tools/memory-tools.js";
import { repoToolDefs } from "../../src/tools/repo-tools.js";
import { fleetToolDefs } from "../../src/tools/fleet-tools.js";
import { scheduleToolDefs, type ScheduleControl } from "../../src/tools/schedule-tools.js";
import type { ProviderToolDef } from "../../src/core/agent-backend.js";
import type { BridgeToolDef } from "../../src/daemon/mcp-bridge.js";

function repos(): Repositories {
  const r = new Repositories(openDb(":memory:"));
  r.createSession({ id: "s1", cwd: "/x" });
  return r;
}

function fleetStub(r: Repositories): FleetOrchestrator {
  const factory = (): WorkerLike => ({ start: () => {}, resume: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
  return new FleetOrchestrator({ repos: r, bus: new EventBus(), git: new FakeGitOps(), factory, worktreesDir: "/wt" });
}

function scheduleStub(r: Repositories): ScheduleControl {
  return { repos: r, reconcile: () => {}, now: () => new Date("2026-06-23T00:00:00.000Z") };
}

describe("tool defs — flat namespace (dev guard for the bridge's flat registration)", () => {
  it("has no duplicate tool names across memory+repos+fleet+schedule groups", () => {
    const r = repos();
    const names = [
      ...memoryToolDefs(r),
      ...repoToolDefs(r),
      ...fleetToolDefs(fleetStub(r), r, "s1"),
      ...scheduleToolDefs(scheduleStub(r), "s1"),
    ].map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    // sanity: this isn't vacuously true because the array is empty
    expect(names.length).toBeGreaterThan(0);
  });
});

describe("ProviderToolDef / BridgeToolDef assignability (compile-time pin)", () => {
  // Type-only checks: if SdkMcpToolDefinition, ProviderToolDef (agent-backend.ts), and BridgeToolDef
  // (mcp-bridge.ts) ever diverge structurally, these assignments stop compiling. Fix the TYPES to
  // realign rather than casting around the mismatch here.
  it("memoryToolDefs's SdkMcpToolDefinition[] is assignable to both neutral tool-def shapes", () => {
    const defs = memoryToolDefs(repos());
    const _asProviderToolDef: ProviderToolDef[] = defs;
    const _asBridgeToolDef: BridgeToolDef[] = defs;
    expect(_asProviderToolDef.length).toBe(defs.length);
    expect(_asBridgeToolDef.length).toBe(defs.length);
  });
});
