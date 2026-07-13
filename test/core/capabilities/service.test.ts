import { describe, expect, it, vi } from "vitest";
import { CapabilityService } from "../../../src/core/capabilities/service.js";
import type { CapabilityContribution } from "../../../src/core/capabilities/types.js";

const codexContribution: CapabilityContribution = {
  entries: [{
    id: "codex.skill.ship",
    kind: "skill",
    name: "ship",
    provider: "codex",
    source: "Codex skills/list",
    scope: "repo",
    state: "applied",
    evidence: "runtime",
  }],
  diagnostics: [],
};

function service(overrides: Partial<ConstructorParameters<typeof CapabilityService>[0]> = {}) {
  const deps: ConstructorParameters<typeof CapabilityService>[0] = {
    getSession: () => undefined,
    getWorker: () => undefined,
    listClaudeCommands: async () => ({ commands: [] }),
    listCodexCapabilities: async () => codexContribution,
    now: () => new Date("2026-07-13T12:00:00.000Z"),
    ...overrides,
  };
  return new CapabilityService(deps);
}

describe("CapabilityService", () => {
  it("resolves a Claude session from the authoritative row and merges Rookery commands/tools", async () => {
    const listClaudeCommands = vi.fn(async () => ({
      commands: [{ name: "review", description: "Review changes" }],
    }));
    const capabilities = service({
      getSession: (id) => id === "s1" ? { id, cwd: "/repo", label: "Main", provider: "claude" } : undefined,
      listClaudeCommands,
    });

    const snapshot = await capabilities.snapshot({ kind: "session", id: "s1" });

    expect(snapshot.target).toEqual({ kind: "session", id: "s1", cwd: "/repo", label: "Main", provider: "claude" });
    expect(snapshot.generatedAt).toBe("2026-07-13T12:00:00.000Z");
    expect(snapshot.entries.map((entry) => entry.id)).toEqual(expect.arrayContaining([
      "rookery.command.btw",
      "rookery.tool.fleet",
      "claude.command.review",
    ]));
    expect(listClaudeCommands).toHaveBeenCalledWith({ target: { kind: "session", id: "s1" }, cwd: "/repo" });
  });

  it("resolves a worker worktree and does not claim master-only Rookery tools", async () => {
    const capabilities = service({
      getWorker: (id) => id === "w1" ? { id, worktreePath: "/repo/.wt/w1", repoPath: "/repo", label: "Worker 1", provider: "claude" } : undefined,
      listClaudeCommands: async () => ({ commands: [{ name: "fix", description: "Fix" }] }),
    });

    const snapshot = await capabilities.snapshot({ kind: "worker", id: "w1" });

    expect(snapshot.target).toEqual({ kind: "worker", id: "w1", cwd: "/repo/.wt/w1", label: "Worker 1", provider: "claude" });
    expect(snapshot.entries.map((entry) => entry.id)).toEqual(expect.arrayContaining(["rookery.command.btw", "claude.command.fix"]));
    expect(snapshot.entries.map((entry) => entry.id)).not.toContain("rookery.tool.fleet");
    expect(snapshot.entries.find((entry) => entry.id === "claude.command.fix")?.scope).toBe("worker");
  });

  it("falls back to repo path when a worker has no materialized worktree", async () => {
    const capabilities = service({
      getWorker: () => ({ id: "w1", worktreePath: null, repoPath: "/repo", label: "Detached", provider: "claude" }),
    });

    expect((await capabilities.snapshot({ kind: "worker", id: "w1" })).target.cwd).toBe("/repo");
  });

  it("routes Codex targets only to the structured provider with target-specific env", async () => {
    const listClaudeCommands = vi.fn(async () => ({ commands: [] }));
    const listCodexCapabilities = vi.fn(async () => codexContribution);
    const codexEnvForTarget = vi.fn(() => ({ CODEX_HOME: "/rookery/codex-homes/s2" }));
    const capabilities = service({
      getSession: () => ({ id: "s2", cwd: "/repo", label: null, provider: "codex" }),
      listClaudeCommands,
      listCodexCapabilities,
      codexEnvForTarget,
    });

    const snapshot = await capabilities.snapshot({ kind: "session", id: "s2" });

    expect(snapshot.target.label).toBe("/repo");
    expect(listClaudeCommands).not.toHaveBeenCalled();
    expect(codexEnvForTarget).toHaveBeenCalledWith({ kind: "session", id: "s2" });
    expect(listCodexCapabilities).toHaveBeenCalledWith({
      target: { kind: "session", id: "s2" },
      cwd: "/repo",
      env: { CODEX_HOME: "/rookery/codex-homes/s2" },
    });
    expect(snapshot.entries.map((entry) => entry.id)).toContain("codex.skill.ship");
  });

  it("keeps Rookery inventory and surfaces provider failures as diagnostics", async () => {
    const capabilities = service({
      getSession: () => ({ id: "s1", cwd: "/repo", label: "Main", provider: "claude" }),
      listClaudeCommands: async () => { throw new Error("catalog crashed"); },
    });

    const snapshot = await capabilities.snapshot({ kind: "session", id: "s1" });

    expect(snapshot.entries.map((entry) => entry.id)).toContain("rookery.command.side");
    expect(snapshot.diagnostics).toEqual([expect.objectContaining({
      id: "claude.commands.discovery",
      source: "Claude supported commands",
      message: "catalog crashed",
    })]);
  });

  it("propagates an explicit Claude discovery diagnostic", async () => {
    const capabilities = service({
      getSession: () => ({ id: "s1", cwd: "/repo", label: "Main", provider: "claude" }),
      listClaudeCommands: async () => ({ commands: [], error: "probe timed out" }),
    });

    expect((await capabilities.snapshot({ kind: "session", id: "s1" })).diagnostics).toEqual([
      expect.objectContaining({ message: "probe timed out" }),
    ]);
  });

  it("deduplicates stable ids deterministically", async () => {
    const capabilities = service({
      getSession: () => ({ id: "s1", cwd: "/repo", label: "Main", provider: "codex" }),
      listCodexCapabilities: async () => ({
        entries: [codexContribution.entries[0]!, codexContribution.entries[0]!],
        diagnostics: [],
      }),
    });

    const snapshot = await capabilities.snapshot({ kind: "session", id: "s1" });
    expect(snapshot.entries.filter((entry) => entry.id === "codex.skill.ship")).toHaveLength(1);
  });

  it("rejects unknown targets and unsupported persisted providers", async () => {
    await expect(service().snapshot({ kind: "session", id: "missing" })).rejects.toThrow("unknown capability target: session:missing");
    await expect(service({
      getWorker: () => ({ id: "w1", worktreePath: null, repoPath: "/repo", label: "W", provider: "future" }),
    }).snapshot({ kind: "worker", id: "w1" })).rejects.toThrow("unsupported capability provider: future");
  });
});
