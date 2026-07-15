import { describe, expect, it, vi } from "vitest";
import { CapabilityService } from "../../../src/core/capabilities/service.js";
import type {
  CapabilityContribution,
  CapabilityLibraryEntry,
  CapabilityMcpPackCreateInput,
} from "../../../src/core/capabilities/types.js";
import { CapabilityRuntimeState } from "../../../src/core/capabilities/runtime-state.js";
import { EventBus } from "../../../src/core/events.js";

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

function generatedPack(overrides: Partial<CapabilityLibraryEntry> = {}): CapabilityLibraryEntry {
  return {
    instanceId: "pack-1",
    sourceKind: "rookery-generated",
    sourcePath: "/generated/repo-tools-one",
    ownerRepoId: null,
    manifest: {
      schemaVersion: 1,
      id: "repo-tools",
      displayName: "Repo Tools",
      version: "1.0.0",
      description: "Repository MCP servers",
      mcpServers: [{
        id: "docs",
        transport: "streamable-http",
        url: "https://example.test/mcp",
        auth: { bearerToken: { source: "rookery-secret", key: "docs-token" } },
      }],
    },
    digest: "a".repeat(64),
    status: "untrusted",
    errors: [],
    files: [],
    changes: [],
    secrets: [{ key: "docs-token", configured: false }],
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    ...overrides,
  };
}

const createInput: CapabilityMcpPackCreateInput = {
  id: "repo-tools",
  displayName: "Repo Tools",
  version: "1.0.0",
  description: "Repository MCP servers",
  repoId: "repo-1",
  agents: ["master", "worker"],
  mcpServers: [{
    id: "docs",
    transport: "streamable-http",
    url: "https://example.test/mcp",
    auth: { bearerToken: { source: "rookery-secret", key: "docs-token" } },
  }],
  secretValues: { "docs-token": "actual-secret-value" },
};

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

  it("projects Claude master desired/applied runtime state and exposes the secret-free agent projection", async () => {
    const runtimeState = new CapabilityRuntimeState(new EventBus());
    const target = { targetKind: "master" as const, targetId: "s1", sessionId: "s1" };
    const runtime = { revision: "revision-a", blocked: false, instructions: [], skills: [], mcpServers: [] };
    const desired = {
      revision: runtime.revision,
      blocked: false,
      runtime,
      entries: [{
        id: "managed:pack:skill:release",
        kind: "skill" as const,
        name: "release",
        provider: "rookery" as const,
        source: "Team Pack",
        scope: "session" as const,
        state: "desired" as const,
        evidence: "declared" as const,
        managed: { packInstanceId: "pack", packId: "team", bindingId: "binding", scopeKind: "session" as const, enabled: true },
      }],
      diagnostics: [],
    };
    const capabilities = service({
      getSession: () => ({ id: "s1", cwd: "/repo", label: "Main", provider: "claude" }),
      resolver: { resolve: vi.fn(() => desired) } as never,
      runtimeState,
    });

    expect(capabilities.resolveManaged({ kind: "session", id: "s1" })).toBe(runtime);
    const pending = await capabilities.snapshot({ kind: "session", id: "s1" });
    expect(pending.appliedRevision).toBeNull();
    expect(pending.entries.find((entry) => entry.id.startsWith("managed:"))?.state).toBe("pending-next-turn");
    expect(pending.entries.find((entry) => entry.id.startsWith("managed:"))?.invocation).toEqual({ type: "prompt", name: "/release" });

    runtimeState.setDesired(target, runtime.revision, false);
    runtimeState.setApplied(target, runtime.revision);
    const applied = await capabilities.snapshot({ kind: "session", id: "s1" });
    expect(applied.appliedRevision).toBe(runtime.revision);
    expect(applied.entries.find((entry) => entry.id.startsWith("managed:"))?.state).toBe("applied");
    expect(applied.entries.find((entry) => entry.id.startsWith("managed:"))?.invocation).toEqual({ type: "prompt", name: "/release" });
  });

  it("projects Codex worker drift as pending reload and keeps blocked/unavailable/suppressed states intact", async () => {
    const runtimeState = new CapabilityRuntimeState(new EventBus());
    const target = { targetKind: "worker" as const, targetId: "w1", sessionId: "home" };
    runtimeState.setDesired(target, "revision-old", false);
    runtimeState.setApplied(target, "revision-old");
    const managed = { packInstanceId: "pack", packId: "team", bindingId: "binding", scopeKind: "worker" as const, enabled: true };
    const capabilities = service({
      getSession: () => ({ id: "home", cwd: "/repo", label: null, provider: "codex" }),
      getWorker: () => ({ id: "w1", worktreePath: "/repo/.wt/w1", repoPath: "/repo", label: "Worker", provider: "codex", homeSessionId: "home" }),
      resolver: { resolve: vi.fn(() => ({
        revision: "revision-new",
        blocked: false,
        runtime: { revision: "revision-new", blocked: false, instructions: [], skills: [], mcpServers: [] },
        entries: [
          { id: "desired", kind: "skill", name: "desired", provider: "rookery", source: "Pack", scope: "worker", state: "desired", evidence: "declared", managed },
          { id: "unavailable", kind: "mcp", name: "optional", provider: "rookery", source: "Pack", scope: "worker", state: "unavailable", evidence: "declared", managed },
          { id: "suppressed", kind: "mcp", name: "off", provider: "rookery", source: "Pack", scope: "worker", state: "suppressed", evidence: "declared", managed },
        ],
        diagnostics: [],
      })) } as never,
      runtimeState,
    });

    const snapshot = await capabilities.snapshot({ kind: "worker", id: "w1" });
    expect(snapshot.appliedRevision).toBe("revision-old");
    expect(Object.fromEntries(snapshot.entries.filter((entry) => ["desired", "unavailable", "suppressed"].includes(entry.id)).map((entry) => [entry.id, entry.state]))).toEqual({
      desired: "pending-reload",
      suppressed: "suppressed",
      unavailable: "unavailable",
    });
    expect(snapshot.entries.filter((entry) => ["desired", "unavailable", "suppressed"].includes(entry.id)).every((entry) => entry.invocation === undefined)).toBe(true);

    runtimeState.setDesired(target, "revision-new", false);
    runtimeState.setApplied(target, "revision-new");
    const applied = await capabilities.snapshot({ kind: "worker", id: "w1" });
    expect(applied.entries.find((entry) => entry.id === "desired")).toMatchObject({
      state: "applied",
      invocation: { type: "prompt", name: "$desired" },
    });
  });

  it("surfaces the same sanitized runtime error state for Claude and Codex", async () => {
    const runtimeState = new CapabilityRuntimeState(new EventBus());
    runtimeState.setError(
      { targetKind: "master", targetId: "s1", sessionId: "s1" },
      "revision-a",
      "Capability runtime application failed.",
    );
    const entry = {
      id: "managed", kind: "instruction" as const, name: "rules", provider: "rookery" as const,
      source: "Pack", scope: "session" as const, state: "desired" as const, evidence: "declared" as const,
      managed: { packInstanceId: "pack", packId: "team", bindingId: "binding", scopeKind: "session" as const, enabled: true },
    };
    const desired = {
      revision: "revision-a", blocked: false,
      runtime: { revision: "revision-a", blocked: false, instructions: [], skills: [], mcpServers: [] },
      entries: [entry], diagnostics: [],
    };
    const claude = service({
      getSession: () => ({ id: "s1", cwd: "/repo", label: "Main", provider: "claude" }),
      resolver: { resolve: () => desired } as never,
      runtimeState,
    });
    const failed = await claude.snapshot({ kind: "session", id: "s1" });
    expect(failed.entries.find((candidate) => candidate.id === "managed")?.state).toBe("error");
    expect(failed.diagnostics).toContainEqual(expect.objectContaining({
      id: "capabilities.runtime.master.s1",
      message: "Capability runtime application failed.",
    }));

    const codex = service({
      getSession: () => ({ id: "s1", cwd: "/repo", label: "Main", provider: "codex" }),
      resolver: { resolve: () => desired } as never,
      runtimeState,
    });
    const codexSnapshot = await codex.snapshot({ kind: "session", id: "s1" });
    expect(codexSnapshot.appliedRevision).toBeNull();
    expect(codexSnapshot.entries.find((candidate) => candidate.id === "managed")?.state).toBe("error");
    expect(codexSnapshot.diagnostics).toContainEqual(expect.objectContaining({
      id: "capabilities.runtime.master.s1",
      message: "Capability runtime application failed.",
    }));
  });

  it("creates an untrusted generated MCP pack, stores secrets, and binds it to the repo", () => {
    let configured = false;
    const initial = generatedPack();
    const registry = {
      add: vi.fn(() => initial),
      setSecret: vi.fn((_instanceId: string, _key: string, _value: string) => {
        configured = true;
        return { key: "docs-token", configured: true };
      }),
      setBinding: vi.fn((id: string, input: object) => ({
        id,
        ...input,
        createdAt: "2026-07-15T00:00:00.000Z",
        updatedAt: "2026-07-15T00:00:00.000Z",
      })),
      get: vi.fn(() => generatedPack({
        secrets: [{ key: "docs-token", configured }],
      })),
      remove: vi.fn(),
    };
    const generatedPacks = {
      create: vi.fn(() => "/generated/repo-tools-one"),
      remove: vi.fn(),
    };
    const capabilities = service({ registry: registry as never, generatedPacks });

    const result = capabilities.createMcpPack(createInput);

    expect(generatedPacks.create).toHaveBeenCalledWith({
      schemaVersion: 1,
      id: "repo-tools",
      displayName: "Repo Tools",
      version: "1.0.0",
      description: "Repository MCP servers",
      mcpServers: createInput.mcpServers,
    });
    expect(registry.add).toHaveBeenCalledWith("/generated/repo-tools-one", { sourceKind: "rookery-generated" });
    expect(registry.setSecret).toHaveBeenCalledWith("pack-1", "docs-token", "actual-secret-value");
    expect(registry.setBinding).toHaveBeenCalledWith(expect.any(String), {
      packInstanceId: "pack-1",
      scopeKind: "repo-local",
      scopeRef: "repo-1",
      audience: { agents: ["master", "worker"], origins: ["ui"] },
      enabled: true,
    });
    expect(result).toMatchObject({
      pack: { sourceKind: "rookery-generated", status: "untrusted", secrets: [{ key: "docs-token", configured: true }] },
      binding: { scopeKind: "repo-local", scopeRef: "repo-1" },
    });
    expect(JSON.stringify(result)).not.toContain("actual-secret-value");
  });

  it.each([
    ["registration", "add"],
    ["secret storage", "setSecret"],
    ["binding authority", "setBinding"],
  ] as const)("rolls back generated files and registry state after %s failure", (_label, failingStep) => {
    const pack = generatedPack();
    const registry = {
      add: vi.fn(() => {
        if (failingStep === "add") throw new Error("registration failed");
        return pack;
      }),
      setSecret: vi.fn(() => {
        if (failingStep === "setSecret") throw new Error("secret rejected");
        return { key: "docs-token", configured: true };
      }),
      setBinding: vi.fn(() => {
        if (failingStep === "setBinding") throw new Error("unknown repo capability scope");
        throw new Error("unexpected success");
      }),
      get: vi.fn(() => pack),
      remove: vi.fn(),
    };
    const generatedPacks = {
      create: vi.fn(() => "/generated/repo-tools-one"),
      remove: vi.fn(),
    };
    const capabilities = service({ registry: registry as never, generatedPacks });

    expect(() => capabilities.createMcpPack(createInput)).toThrow();

    if (failingStep === "add") expect(registry.remove).not.toHaveBeenCalled();
    else expect(registry.remove).toHaveBeenCalledWith("pack-1");
    expect(generatedPacks.remove).toHaveBeenCalledWith("/generated/repo-tools-one");
  });

  it("removes owned generated sources but preserves external pack directories", () => {
    const entries = [
      generatedPack(),
      generatedPack({ instanceId: "pack-2", sourceKind: "local-directory", sourcePath: "/operator/pack" }),
      generatedPack({ instanceId: "pack-3", sourceKind: "repo-shared", sourcePath: "/repo/.rookery/pack" }),
    ];
    const registry = {
      get: vi.fn((instanceId: string) => entries.find((entry) => entry.instanceId === instanceId)),
      remove: vi.fn(),
    };
    const generatedPacks = { create: vi.fn(), remove: vi.fn() };
    const capabilities = service({ registry: registry as never, generatedPacks });

    capabilities.removePack("pack-1");
    capabilities.removePack("pack-2");
    capabilities.removePack("pack-3");

    expect(registry.remove).toHaveBeenCalledTimes(3);
    expect(generatedPacks.remove).toHaveBeenCalledTimes(1);
    expect(generatedPacks.remove).toHaveBeenCalledWith("/generated/repo-tools-one");
  });

  it("delegates sanitized registry mutations through the service facade", () => {
    const library = { generation: 1, packs: [], bindings: [], diagnostics: [] };
    const registry = {
      list: vi.fn(() => library),
      add: vi.fn(() => ({ instanceId: "pack-1" })),
      get: vi.fn(() => ({ instanceId: "pack-1", sourceKind: "local-directory" })),
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
