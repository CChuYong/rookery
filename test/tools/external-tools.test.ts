import { describe, it, expect } from "vitest";
import { openDb } from "../../src/persistence/db.js";
import { Repositories } from "../../src/persistence/repositories.js";
import { EventBus } from "../../src/core/events.js";
import { FakeGitOps } from "../../src/core/git-ops.js";
import { FleetOrchestrator } from "../../src/core/fleet-orchestrator.js";
import type { WorkerLike } from "../../src/core/fleet-orchestrator.js";
import type { SessionManager } from "../../src/core/session-manager.js";
import { EXTERNAL_FLEET_SESSION_KEY } from "../../src/core/session-manager.js";
import { externalToolDefs, EXTERNAL_READONLY_TOOL_NAMES, EXTERNAL_FULL_TOOL_NAMES } from "../../src/tools/external-tools.js";

function harness() {
  const repos = new Repositories(openDb(":memory:"));
  const factory = (): WorkerLike => ({ start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
  const fo = new FleetOrchestrator({ repos, bus: new EventBus(), git: new FakeGitOps(), factory, worktreesDir: "/wt" });
  // Minimal SessionManager fake: external tools only call getOrCreateByKey → { id }.
  const calls: Array<{ key: string; cwd: string }> = [];
  const sessions = {
    getOrCreateByKey: (key: string, cwd: string) => {
      calls.push({ key, cwd });
      // materialize a real session row so the spawned worker's FK resolves
      if (!repos.getSession(key)) repos.createSession({ id: key, cwd });
      return repos.getSession(key)!;
    },
  } as unknown as SessionManager;
  return { repos, fo, sessions, calls };
}

describe("external tools (rookery-as-MCP)", () => {
  it("readonly scope exposes only the 5 read tools; none of the mutating ones", () => {
    const { repos, fo, sessions } = harness();
    const defs = externalToolDefs({ fleet: fo, repos, sessions }, "readonly");
    const names = defs.map((d) => d.name).sort();
    expect(names).toEqual([...EXTERNAL_READONLY_TOOL_NAMES].sort());
    expect(names).not.toContain("spawn_worker");
    expect(names).not.toContain("stop_worker");
    expect(names).not.toContain("discard_worker");
  });

  it("full scope exposes all 10 tools including spawn/send/interrupt/stop/discard", () => {
    const { repos, fo, sessions } = harness();
    const defs = externalToolDefs({ fleet: fo, repos, sessions }, "full");
    expect(defs.map((d) => d.name).sort()).toEqual([...EXTERNAL_FULL_TOOL_NAMES].sort());
    expect(EXTERNAL_FULL_TOOL_NAMES).toHaveLength(10);
  });

  it("spawn_worker/send_worker do NOT expose a notify field (meaningless for external:fleet)", () => {
    const { repos, fo, sessions } = harness();
    const defs = externalToolDefs({ fleet: fo, repos, sessions }, "full");
    const spawn = defs.find((d) => d.name === "spawn_worker")!;
    const send = defs.find((d) => d.name === "send_worker")!;
    expect(Object.keys(spawn.inputSchema)).not.toContain("notify");
    expect(Object.keys(send.inputSchema)).not.toContain("notify");
  });

  it("spawn_worker attributes the worker to the external:fleet home session", async () => {
    const { repos, fo, sessions, calls } = harness();
    repos.createRepo({ id: "r1", name: "app", path: "/code/app", description: "the app" });
    const defs = externalToolDefs({ fleet: fo, repos, sessions }, "full");
    const spawn = defs.find((d) => d.name === "spawn_worker")!;
    const out = (await spawn.handler({ repo: "app", task: "do it" } as never, undefined)) as { isError?: boolean };
    await fo.waitAllSettled();
    expect(out.isError).toBeFalsy();
    expect(calls[0]).toEqual({ key: EXTERNAL_FLEET_SESSION_KEY, cwd: "/code/app" });
    const workers = repos.listAllWorkers();
    expect(workers).toHaveLength(1);
    expect(workers[0]!.session_id).toBe(EXTERNAL_FLEET_SESSION_KEY);
  });

  it("spawn_worker rejects an unknown repo", async () => {
    const { repos, fo, sessions } = harness();
    const defs = externalToolDefs({ fleet: fo, repos, sessions }, "full");
    const spawn = defs.find((d) => d.name === "spawn_worker")!;
    const out = (await spawn.handler({ repo: "nope", task: "x" } as never, undefined)) as { isError?: boolean; content: Array<{ text: string }> };
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain("unknown repo");
  });
});
