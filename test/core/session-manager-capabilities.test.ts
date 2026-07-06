import { describe, it, expect } from "vitest";
import { openDb } from "../../src/persistence/db.js";
import { Repositories } from "../../src/persistence/repositories.js";
import { EventBus } from "../../src/core/events.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { FleetOrchestrator } from "../../src/core/fleet-orchestrator.js";
import type { WorkerLike } from "../../src/core/fleet-orchestrator.js";
import { FakeGitOps } from "../../src/core/git-ops.js";
import { ClaudeBackend } from "../../src/core/claude-backend.js";
import { fakeQuery } from "../helpers/fake-query.js";

// Verifies the injected makeCapabilities flows all the way into the master's query options (per-source dynamic capability wiring).
function base() {
  const repos = new Repositories(openDb(":memory:"));
  const bus = new EventBus();
  const factory = (): WorkerLike => ({ start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
  const fleet = new FleetOrchestrator({ repos, bus, git: new FakeGitOps(), factory, worktreesDir: "/wt" });
  const inner = fakeQuery([]);
  let captured: Record<string, unknown> = {};
  const queryFn = ((input: { options?: Record<string, unknown> }) => {
    captured = input.options ?? {};
    return inner(input as Parameters<typeof inner>[0]);
  }) as typeof inner;
  return { repos, bus, fleet, queryFn, backend: new ClaudeBackend(queryFn), opts: () => captured };
}

describe("SessionManager makeCapabilities wiring", () => {
  it("injects source capabilities into the built master (externalKey, sessionId)", async () => {
    const b = base();
    const seen: Array<{ key: string | null; id: string }> = [];
    const makeCapabilities = (externalKey: string | null, sessionId: string) => {
      seen.push({ key: externalKey, id: sessionId });
      return externalKey?.startsWith("slack:")
        ? () => ({ systemPromptAppend: "CAP_MARKER", allowedTools: ["mcp__slack__read_thread"] })
        : undefined;
    };
    let n = 0;
    const sm = new SessionManager({ repos: b.repos, bus: b.bus, backends: { claude: b.backend }, masterModel: "mm", fleet: b.fleet, makeCapabilities }, () => `s${n++}`);
    const s = sm.getOrCreateByKey("slack:T:C:1.0", "/work");
    await s.master.runTurn("hi");
    expect(seen).toContainEqual({ key: "slack:T:C:1.0", id: "s0" });
    const o = b.opts() as { systemPrompt?: { append?: string }; allowedTools?: string[] };
    expect(o.systemPrompt?.append).toContain("CAP_MARKER");
    expect(o.allowedTools).toContain("mcp__slack__read_thread");
  });

  it("passes no capabilities for non-slack sessions (unchanged)", async () => {
    const b = base();
    const makeCapabilities = (externalKey: string | null) =>
      externalKey?.startsWith("slack:") ? () => ({ systemPromptAppend: "CAP_MARKER" }) : undefined;
    let n = 0;
    const sm = new SessionManager({ repos: b.repos, bus: b.bus, backends: { claude: b.backend }, masterModel: "mm", fleet: b.fleet, makeCapabilities }, () => `s${n++}`);
    const s = sm.create("/work"); // no externalKey (ui/cli)
    await s.master.runTurn("hi");
    const o = b.opts() as { systemPrompt?: { append?: string }; allowedTools?: string[] };
    expect(o.systemPrompt?.append).not.toContain("CAP_MARKER");
    expect(o.allowedTools).not.toContain("mcp__slack__read_thread");
  });
});
