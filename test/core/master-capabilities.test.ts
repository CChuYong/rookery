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
import { ClaudeBackend } from "../../src/core/claude-backend.js";
import { fakeQuery } from "../helpers/fake-query.js";

function deps(capabilities?: () => TurnCapabilities) {
  const repos = new Repositories(openDb(":memory:"));
  repos.createSession({ id: "s1", cwd: "/x" });
  const bus = new EventBus();
  const factory = (): WorkerLike => ({ start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
  const fleet = new FleetOrchestrator({ repos, bus, git: new FakeGitOps(), factory, worktreesDir: "/wt" });
  const queryFn = fakeQuery([{ type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "s" }]);
  return { repos, bus, fleet, queryFn, backend: new ClaudeBackend(queryFn), model: () => "m", effort: () => "high", name: () => "rookery", capabilities };
}

// Capture wrapper that intercepts the options passed into query().
function capture(d: ReturnType<typeof deps>) {
  let captured: Record<string, unknown> = {};
  const wrapped = ((input: { options?: Record<string, unknown> }) => {
    captured = input.options ?? {};
    return d.queryFn(input as Parameters<typeof d.queryFn>[0]);
  }) as typeof d.queryFn;
  return { d: { ...d, queryFn: wrapped, backend: new ClaudeBackend(wrapped) }, opts: () => captured };
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

  // Task 1 (final-review fix wave): schedule tools now travel to codex masters via a caps.toolDefs
  // channel instead of an opaque mcpServers entry — see master-agent.ts's doTurn toolDefs merge.
  it("caps.toolDefs surfaces as an SDK mcpServer for claude, wrapped exactly like the base groups (memory/repos/fleet)", async () => {
    const fakeDef = { name: "schedule_wakeup", description: "d", inputSchema: {}, handler: async () => ({ content: [] }) };
    const o = await runWith(() => ({ toolDefs: { schedule: [fakeDef] } }));
    expect(Object.keys(o.mcpServers ?? {}).sort()).toEqual(["fleet", "memory", "repos", "schedule"]);
  });

  it("caps.toolDefs merges into the RAW toolDefs record: caps wins a key collision with base, and the askUserQuestion group still can't be shadowed", async () => {
    // A minimal capturing fake AgentBackend (mirrors master-agent.test.ts's pattern) so we can inspect
    // the RAW MasterTurnOptions master-agent builds — ClaudeBackend wraps/strips toolDefs before the
    // SDK options the `capture()` helper above sees, so that helper can't observe the merge directly.
    function capturingBackend() {
      let captured: { toolDefs?: Record<string, Array<{ name: string }>> } | undefined;
      const backend = {
        openSession: () => { throw new Error("not used"); },
        startTurn: (_prompt: string, opts: { toolDefs?: Record<string, Array<{ name: string }>> }) => {
          captured = opts;
          async function* gen() {
            yield { kind: "turn_end" as const, subtype: "success", costUsd: 0, numTurns: 1, durationMs: 0, contextTokens: 0, contextWindow: 0 };
          }
          const it = gen();
          return Object.assign(it, { interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}, supportedCommands: async () => [] });
        },
      };
      return { backend, opts: () => captured };
    }
    const fakeDef = (name: string) => ({ name, description: "d", inputSchema: {}, handler: async () => ({ content: [] }) });

    const base = deps(() => ({
      toolDefs: {
        memory: [fakeDef("FAKE_MEMORY_OVERRIDE")], // collides with the base "memory" group
        schedule: [fakeDef("schedule_wakeup")], // caps' own additional group
        askUserQuestion: [fakeDef("SHOULD_NOT_WIN")], // attempts to shadow the reserved ask group
      },
    }));
    const cap = capturingBackend();
    const fakeCanUseTool = (() => {}) as never;
    const master = new MasterAgent({ sessionId: "s1", cwd: "/x", sdkSessionId: null, deps: { ...base, backend: cap.backend as never, canUseTool: fakeCanUseTool } });
    await master.runTurn("hi");

    const toolDefs = cap.opts()?.toolDefs;
    expect(toolDefs?.memory?.map((d) => d.name)).toEqual(["FAKE_MEMORY_OVERRIDE"]); // caps wins over base
    expect(toolDefs?.schedule?.map((d) => d.name)).toEqual(["schedule_wakeup"]); // caps' own group passes through
    expect(toolDefs?.askUserQuestion?.map((d) => d.name)).toEqual(["AskUserQuestion"]); // real ask group always wins, spread last
  });
});
