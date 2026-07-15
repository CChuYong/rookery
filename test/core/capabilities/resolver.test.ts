import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import { CapabilityResolver } from "../../../src/core/capabilities/resolver.js";
import type { CapabilityPackManifest } from "../../../src/core/capabilities/types.js";
import { openDb } from "../../../src/persistence/db.js";
import { Repositories } from "../../../src/persistence/repositories.js";

function writePack(root: string, manifest: Partial<CapabilityPackManifest> & { id: string }): void {
  fs.mkdirSync(root, { recursive: true });
  for (const instruction of manifest.instructions ?? []) fs.writeFileSync(path.join(root, instruction.path), `${instruction.id}\n`);
  for (const skill of manifest.skills ?? []) {
    fs.mkdirSync(path.join(root, skill.path), { recursive: true });
    fs.writeFileSync(path.join(root, skill.path, "SKILL.md"), `---\nname: ${skill.id}\ndescription: ${skill.id} skill\n---\n`);
  }
  fs.writeFileSync(path.join(root, "capability.json"), JSON.stringify({
    schemaVersion: 1,
    displayName: manifest.id,
    version: "1.0.0",
    description: `${manifest.id} description`,
    ...manifest,
  }, null, 2));
}

describe("CapabilityResolver", () => {
  let root: string;
  let repos: Repositories;
  let registry: CapabilityRegistry;
  let nextId: number;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "rk-capability-resolver-"));
    repos = new Repositories(openDb(":memory:"));
    nextId = 1;
    registry = new CapabilityRegistry(repos, { id: () => `pack-${nextId++}` });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function addPack(manifest: Partial<CapabilityPackManifest> & { id: string }, trust = true) {
    const packRoot = path.join(root, manifest.id);
    writePack(packRoot, manifest);
    const pack = registry.add(packRoot);
    if (trust) registry.setTrust(pack.instanceId, pack.digest, true);
    return pack;
  }

  const master = {
    kind: "master" as const,
    id: "session-1",
    provider: "codex" as const,
    origin: "ui" as const,
    cwd: "/repo",
    repoId: "repo-1",
    homeSessionId: "session-1",
  };

  it("uses exact scope precedence and lets a disabled winner suppress a broader binding", () => {
    const pack = addPack({ id: "rules", instructions: [{ id: "rules", path: "rules.md" }] });
    const audience = { agents: ["master" as const], origins: ["ui" as const] };
    registry.setBinding("global", { packInstanceId: pack.instanceId, scopeKind: "rookery", scopeRef: "", audience, enabled: true });
    repos.createSession({ id: "session-1", cwd: "/repo", origin: "ui", provider: "codex" });
    registry.setBinding("session", { packInstanceId: pack.instanceId, scopeKind: "session", scopeRef: "session-1", audience, enabled: false });

    const suppressed = new CapabilityResolver(registry).resolve(master);
    expect(suppressed.entries).toHaveLength(1);
    expect(suppressed.entries[0]).toMatchObject({ state: "suppressed", managed: { bindingId: "session", enabled: false } });

    registry.setBinding("session", { id: "session", packInstanceId: pack.instanceId, scopeKind: "session", scopeRef: "session-1", audience, enabled: true });
    expect(new CapabilityResolver(registry).resolve(master).entries[0]).toMatchObject({
      state: "desired", managed: { bindingId: "session", enabled: true },
    });
  });

  it("filters the full agent-origin audience product and keeps deterministic pack ordering", () => {
    const zeta = addPack({ id: "zeta", instructions: [{ id: "z-rule", path: "z.md" }] });
    const alpha = addPack({ id: "alpha", instructions: [{ id: "a-rule", path: "a.md" }] });
    for (const pack of [zeta, alpha]) {
      registry.setBinding(`binding-${pack.instanceId}`, {
        packInstanceId: pack.instanceId,
        scopeKind: "rookery",
        scopeRef: "",
        audience: { agents: ["master"], origins: ["ui"] },
        enabled: true,
      });
    }
    const resolver = new CapabilityResolver(registry);
    expect(resolver.resolve(master).entries.map((entry) => entry.name)).toEqual(["a-rule", "z-rule"]);
    expect(resolver.resolve({ ...master, origin: "slack" }).entries).toEqual([]);
  });

  it("marks untrusted and invalid packs blocked without leaking file content", () => {
    const pack = addPack({ id: "untrusted", instructions: [{ id: "private", path: "private.md" }] }, false);
    registry.setBinding("binding", {
      packInstanceId: pack.instanceId,
      scopeKind: "rookery",
      scopeRef: "",
      audience: { agents: ["master"], origins: ["ui"] },
      enabled: true,
    });
    const resolver = new CapabilityResolver(registry);
    expect(resolver.resolve(master)).toMatchObject({ blocked: true, entries: [{ state: "blocked" }] });

    fs.writeFileSync(path.join(root, "untrusted", "capability.json"), "invalid");
    registry.refresh(pack.instanceId);
    const invalid = resolver.resolve(master);
    expect(invalid.entries[0]?.state).toBe("blocked");
    expect(invalid.diagnostics.some((item) => item.message.includes("invalid"))).toBe(true);
    expect(JSON.stringify(invalid)).not.toContain("private\n");
  });

  it("suppresses MCP for Side while still selecting Side instructions and skills", () => {
    const pack = addPack({
      id: "side-pack",
      instructions: [{ id: "side-rules", path: "rules.md" }],
      skills: [{ id: "side-skill", path: "skill" }],
      mcpServers: [{ id: "search", transport: "stdio", command: "search-server" }],
    });
    registry.setBinding("side", {
      packInstanceId: pack.instanceId,
      scopeKind: "rookery",
      scopeRef: "",
      audience: { agents: ["side"], origins: ["ui"] },
      enabled: true,
    });
    const result = new CapabilityResolver(registry).resolve({ ...master, kind: "side", id: "side-1" });
    expect(result.entries.map((entry) => [entry.kind, entry.state])).toEqual([
      ["instruction", "desired"],
      ["mcp", "suppressed"],
      ["skill", "desired"],
    ]);
    expect(result.diagnostics.some((diagnostic) => diagnostic.message.includes("Side"))).toBe(true);
  });

  it("uses environment and opaque Rookery secret presence for MCP availability and revision", () => {
    const pack = addPack({
      id: "mcp-pack",
      mcpServers: [
        {
          id: "required",
          transport: "stdio",
          command: "required-server",
          required: true,
          secretEnv: {
            TOKEN: { source: "rookery-secret", key: "token" },
            ACCOUNT: { source: "environment", name: "ACCOUNT_ID" },
          },
        },
        {
          id: "optional",
          transport: "streamable-http",
          url: "https://example.test/mcp",
          secretHeaders: { "X-Key": { source: "environment", name: "OPTIONAL_KEY" } },
        },
      ],
    });
    registry.setBinding("binding", {
      packInstanceId: pack.instanceId,
      scopeKind: "rookery",
      scopeRef: "",
      audience: { agents: ["master"], origins: ["ui"] },
      enabled: true,
    });
    const env: NodeJS.ProcessEnv = {};
    const resolver = new CapabilityResolver(registry, { env });
    const missing = resolver.resolve(master);
    expect(missing.blocked).toBe(true);
    expect(missing.runtime.mcpServers).toEqual([]);
    expect(missing.entries.find((entry) => entry.name === "required")?.state).toBe("blocked");
    expect(missing.entries.find((entry) => entry.name === "optional")?.state).toBe("unavailable");

    registry.setSecret(pack.instanceId, "token", "actual-secret-value");
    env.ACCOUNT_ID = "account";
    const configured = resolver.resolve(master);
    expect(configured.entries.find((entry) => entry.name === "required")?.state).toBe("desired");
    expect(configured.revision).not.toBe(missing.revision);
    expect(JSON.stringify(configured)).not.toContain("actual-secret-value");
    expect(configured.runtime).toMatchObject({
      revision: configured.revision,
      blocked: false,
      mcpServers: [{
        generatedName: "rookery__mcp_pack__required",
        packInstanceId: pack.instanceId,
        packId: "mcp-pack",
        digest: pack.digest,
        sourcePath: pack.sourcePath,
        spec: expect.objectContaining({ id: "required", transport: "stdio" }),
      }],
    });
    expect(JSON.stringify(configured.runtime)).not.toContain("actual-secret-value");
    const revision = configured.revision;
    registry.setSecret(pack.instanceId, "token", "rotated-secret-value");
    expect(resolver.resolve(master).revision).not.toBe(revision);
  });

  it("projects trusted instructions and skills for immutable provider materialization", () => {
    const pack = addPack({
      id: "team.pack",
      instructions: [{ id: "rules", path: "rules.md" }],
      skills: [{ id: "review-pr", path: "skills/review-pr" }],
      mcpServers: [{ id: "lookup-api", transport: "streamable-http", url: "https://example.test/mcp" }],
    });
    registry.setBinding("binding", {
      packInstanceId: pack.instanceId,
      scopeKind: "rookery",
      scopeRef: "",
      audience: { agents: ["master"], origins: ["ui"] },
      enabled: true,
    });

    const result = new CapabilityResolver(registry).resolve(master);
    expect(result.runtime).toEqual({
      revision: result.revision,
      blocked: false,
      instructions: [{
        id: "rules",
        packInstanceId: pack.instanceId,
        packId: "team.pack",
        digest: pack.digest,
        sourcePath: pack.sourcePath,
        path: "rules.md",
      }],
      skills: [{
        id: "review-pr",
        packInstanceId: pack.instanceId,
        packId: "team.pack",
        digest: pack.digest,
        sourcePath: pack.sourcePath,
        path: "skills/review-pr",
      }],
      mcpServers: [{
        generatedName: "rookery__team_pack__lookup_api",
        packInstanceId: pack.instanceId,
        packId: "team.pack",
        digest: pack.digest,
        sourcePath: pack.sourcePath,
        spec: { id: "lookup-api", transport: "streamable-http", url: "https://example.test/mcp" },
      }],
    });
  });

  it("selects worker, home-session, repo, then global scopes in order", () => {
    repos.createRepo({ id: "repo-1", name: "app", path: "/repo", description: "" });
    repos.createSession({ id: "session-1", cwd: "/repo", origin: "ui" });
    repos.createWorker({ id: "worker-1", sessionId: "session-1", repoPath: "/repo", label: "worker", provider: "claude" });
    const pack = addPack({ id: "worker-rules", instructions: [{ id: "worker-rules", path: "rules.md" }] });
    const audience = { agents: ["worker" as const], origins: ["ui" as const] };
    registry.setBinding("global", { packInstanceId: pack.instanceId, scopeKind: "rookery", scopeRef: "", audience, enabled: false });
    registry.setBinding("repo", { packInstanceId: pack.instanceId, scopeKind: "repo-local", scopeRef: "repo-1", audience, enabled: false });
    registry.setBinding("home", { packInstanceId: pack.instanceId, scopeKind: "session", scopeRef: "session-1", audience, enabled: false });
    registry.setBinding("worker", { packInstanceId: pack.instanceId, scopeKind: "worker", scopeRef: "worker-1", audience, enabled: true });

    const result = new CapabilityResolver(registry).resolve({
      kind: "worker",
      id: "worker-1",
      provider: "claude",
      origin: "ui",
      cwd: "/tmp/worktree",
      repoId: "repo-1",
      homeSessionId: "session-1",
    });
    expect(result.entries[0]).toMatchObject({ state: "desired", managed: { bindingId: "worker" } });
  });
});
