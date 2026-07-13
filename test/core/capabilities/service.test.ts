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

  it("resolves desired state from authoritative session origin and longest registered repo", async () => {
    const resolve = vi.fn(() => ({
      revision: "desired-revision",
      blocked: true,
      entries: [{
        id: "managed.pack.instruction.rules",
        kind: "instruction" as const,
        name: "rules",
        provider: "rookery" as const,
        source: "Team Pack",
        scope: "repo" as const,
        state: "blocked" as const,
        evidence: "declared" as const,
      }],
      diagnostics: [{ id: "managed.blocked", source: "Team Pack", severity: "error" as const, message: "review required" }],
    }));
    const capabilities = service({
      getSession: () => ({
        id: "s1", cwd: "/repo/packages/web/src", label: "Main", provider: "codex",
        origin: "slack", externalKey: "slack:T:C:1",
      }),
      listRepos: () => [
        { id: "repo-root", path: "/repo" },
        { id: "repo-web", path: "/repo/packages/web" },
      ],
      resolver: { resolve } as never,
    });

    const snapshot = await capabilities.snapshot({ kind: "session", id: "s1" });
    expect(resolve).toHaveBeenCalledWith({
      kind: "master",
      id: "s1",
      provider: "codex",
      origin: "slack",
      cwd: "/repo/packages/web/src",
      repoId: "repo-web",
      homeSessionId: "s1",
    });
    expect(snapshot).toMatchObject({ desiredRevision: "desired-revision", desiredBlocked: true });
    expect(snapshot.entries.map((entry) => entry.id)).toEqual(expect.arrayContaining([
      "managed.pack.instruction.rules", "codex.skill.ship", "rookery.command.btw",
    ]));
    expect(snapshot.diagnostics.map((diagnostic) => diagnostic.id)).toContain("managed.blocked");
  });

  it("uses worker repo_path ownership and home-session origin instead of its worktree", async () => {
    const resolve = vi.fn(() => ({ revision: "r", blocked: false, entries: [], diagnostics: [] }));
    const capabilities = service({
      getSession: (id) => id === "home" ? {
        id, cwd: "/repo", label: null, provider: "claude", origin: "automation", externalKey: "automation:a1",
      } : undefined,
      getWorker: () => ({
        id: "w1", worktreePath: "/repo/packages/nested/.worktrees/w1", repoPath: "/repo",
        label: "Worker", provider: "claude", homeSessionId: "home",
      }),
      listRepos: () => [
        { id: "repo-root", path: "/repo" },
        { id: "repo-nested", path: "/repo/packages/nested" },
      ],
      resolver: { resolve } as never,
    });

    await capabilities.snapshot({ kind: "worker", id: "w1" });
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({
      kind: "worker", id: "w1", repoId: "repo-root", homeSessionId: "home", origin: "automation",
      cwd: "/repo/packages/nested/.worktrees/w1",
    }));
  });

  it("delegates sanitized registry mutations through the service facade", () => {
    const library = { generation: 1, packs: [], bindings: [] };
    const registry = {
      list: vi.fn(() => library),
      add: vi.fn(() => ({ instanceId: "pack-1" })),
      remove: vi.fn(),
      setBinding: vi.fn(() => ({ id: "binding-1" })),
      deleteBinding: vi.fn(),
      setTrust: vi.fn(() => ({ instanceId: "pack-1", status: "trusted" })),
      setSecret: vi.fn(() => ({ key: "token", configured: true })),
      deleteSecret: vi.fn(() => ({ key: "token", configured: false })),
      refresh: vi.fn(() => library),
    };
    const capabilities = service({ registry: registry as never });
    const binding = {
      packInstanceId: "pack-1", scopeKind: "rookery" as const, scopeRef: "",
      audience: { agents: ["master" as const], origins: ["ui" as const] }, enabled: true,
    };

    expect(capabilities.library()).toBe(library);
    capabilities.addPack("/pack");
    capabilities.removePack("pack-1");
    capabilities.setBinding("binding-1", binding);
    capabilities.deleteBinding("binding-1");
    capabilities.setTrust("pack-1", "a".repeat(64), true);
    expect(capabilities.setSecret("pack-1", "token", "actual-secret-value")).toEqual({ key: "token", configured: true });
    capabilities.deleteSecret("pack-1", "token");
    capabilities.refresh("pack-1");

    expect(registry.setSecret).toHaveBeenCalledWith("pack-1", "token", "actual-secret-value");
    expect(JSON.stringify(capabilities.library())).not.toContain("actual-secret-value");
  });
});
