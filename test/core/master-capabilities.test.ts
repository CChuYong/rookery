import { describe, it, expect } from "vitest";
import { openDb } from "../../src/persistence/db.js";
import { Repositories } from "../../src/persistence/repositories.js";
import { EventBus } from "../../src/core/events.js";
import { FleetOrchestrator } from "../../src/core/fleet-orchestrator.js";
import type { WorkerLike } from "../../src/core/fleet-orchestrator.js";
import { FakeGitOps } from "../../src/core/git-ops.js";
import { MasterAgent } from "../../src/core/master-agent.js";
import type { TurnCapabilities } from "../../src/core/master-agent.js";
import { createMemoryToolsServer } from "../../src/tools/memory-tools.js";
import { fakeQuery } from "../helpers/fake-query.js";

function deps(capabilities?: () => TurnCapabilities) {
  const repos = new Repositories(openDb(":memory:"));
  repos.createSession({ id: "s1", cwd: "/x" });
  const bus = new EventBus();
  const factory = (): WorkerLike => ({ start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
  const fleet = new FleetOrchestrator({ repos, bus, git: new FakeGitOps(), factory, worktreesDir: "/wt" });
  const queryFn = fakeQuery([{ type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "s" }]);
  return { repos, bus, fleet, queryFn, model: () => "m", effort: () => "high", name: () => "rookery", capabilities };
}

// Capture wrapper that intercepts the options passed into query().
function capture(d: ReturnType<typeof deps>) {
  let captured: Record<string, unknown> = {};
  const wrapped = ((input: { options?: Record<string, unknown> }) => {
    captured = input.options ?? {};
    return d.queryFn(input as Parameters<typeof d.queryFn>[0]);
  }) as typeof d.queryFn;
  return { d: { ...d, queryFn: wrapped }, opts: () => captured };
}

async function runWith(capabilities?: () => TurnCapabilities) {
  const { d, opts } = capture(deps(capabilities));
  const master = new MasterAgent({ sessionId: "s1", cwd: "/x", sdkSessionId: null, deps: d });
  await master.runTurn("hi");
  return opts() as { mcpServers?: Record<string, unknown>; allowedTools?: string[]; systemPrompt?: { append?: string } };
}

describe("MasterAgent source capabilities", () => {
  it("merges injected capabilities (extra mcpServers + allowedTools + systemPromptAppend)", async () => {
    const repos = new Repositories(openDb(":memory:"));
    const extra = createMemoryToolsServer(repos); // plug an arbitrary MCP server in under the "slack" key just to verify the merge
    const o = await runWith(() => ({
      mcpServers: { slack: extra },
      allowedTools: ["mcp__slack__read_thread"],
      systemPromptAppend: "SLACK_HINT_MARKER",
    }));
    expect(Object.keys(o.mcpServers ?? {})).toEqual(expect.arrayContaining(["memory", "repos", "fleet", "slack"]));
    expect(o.allowedTools).toContain("mcp__slack__read_thread");
    expect(o.systemPrompt?.append).toContain("SLACK_HINT_MARKER");
  });

  it("denyTools removes a base tool from allowedTools", async () => {
    const o = await runWith(() => ({ denyTools: ["mcp__memory__remember"] }));
    expect(o.allowedTools).not.toContain("mcp__memory__remember");
    expect(o.allowedTools).toContain("mcp__memory__recall"); // other base tools are kept
  });

  it("without capabilities, the tool set is unchanged (base only)", async () => {
    const o = await runWith(undefined);
    expect(Object.keys(o.mcpServers ?? {}).sort()).toEqual(["fleet", "memory", "repos"]);
    expect(o.allowedTools).not.toContain("mcp__slack__read_thread");
    expect(o.systemPrompt?.append).not.toContain("SLACK_HINT_MARKER");
  });
});
