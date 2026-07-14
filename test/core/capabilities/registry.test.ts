import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CapabilityRegistry } from "../../../src/core/capabilities/registry.js";
import { openDb } from "../../../src/persistence/db.js";
import { Repositories } from "../../../src/persistence/repositories.js";

function writePack(root: string, input: {
  id?: string;
  instruction?: string;
  extra?: Record<string, string>;
  secretKey?: string;
} = {}): void {
  fs.mkdirSync(root, { recursive: true });
  const instruction = input.instruction ?? "Follow the team rules.\n";
  fs.writeFileSync(path.join(root, "instructions.md"), instruction);
  for (const [relative, content] of Object.entries(input.extra ?? {})) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  }
  fs.writeFileSync(path.join(root, "capability.json"), JSON.stringify({
    schemaVersion: 1,
    id: input.id ?? "team-pack",
    displayName: "Team Pack",
    version: "1.0.0",
    description: "Shared team behavior",
    instructions: [{ id: "team-rules", path: "instructions.md" }],
    ...(input.secretKey ? {
      mcpServers: [{
        id: "issues",
        transport: "stdio",
        command: "issue-server",
        secretEnv: { ISSUE_TOKEN: { source: "rookery-secret", key: input.secretKey } },
      }],
    } : {}),
  }, null, 2));
}

function writeSharedIndex(repo: string, packs: Array<{ path: string; disabled?: boolean }>): void {
  fs.mkdirSync(path.join(repo, ".rookery"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".rookery", "capabilities.json"), JSON.stringify({ schemaVersion: 1, packs }));
}

describe("CapabilityRegistry", () => {
  let root: string;
  let repos: Repositories;
  let nextId: number;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "rk-capability-registry-"));
    repos = new Repositories(openDb(":memory:"));
    nextId = 1;
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function registry(onChanged?: ConstructorParameters<typeof CapabilityRegistry>[1]["onChanged"]): CapabilityRegistry {
    return new CapabilityRegistry(repos, { id: () => `pack-${nextId++}`, onChanged });
  }

  it("adds, lists, and removes a canonical local directory once", () => {
    const packRoot = path.join(root, "pack");
    writePack(packRoot);
    const subject = registry();
    const added = subject.add(packRoot);

    expect(added).toMatchObject({
      instanceId: "pack-1",
      sourceKind: "local-directory",
      sourcePath: fs.realpathSync.native(packRoot),
      status: "untrusted",
      manifest: { id: "team-pack" },
    });
    expect(subject.list().packs.map((pack) => pack.instanceId)).toEqual(["pack-1"]);
    expect(() => subject.add(path.join(packRoot, "."))).toThrow(/already registered/i);

    subject.remove("pack-1");
    expect(subject.list().packs).toEqual([]);
  });

  it("trusts only the current digest and records reviewable file changes on refresh", () => {
    const packRoot = path.join(root, "pack");
    writePack(packRoot, { extra: { "remove-me.txt": "old" } });
    const subject = registry();
    const added = subject.add(packRoot);

    expect(() => subject.setTrust(added.instanceId, "f".repeat(64), true)).toThrow(/current digest/i);
    expect(subject.setTrust(added.instanceId, added.digest, true).status).toBe("trusted");
    fs.appendFileSync(path.join(packRoot, "instructions.md"), "Changed.\n");
    fs.rmSync(path.join(packRoot, "remove-me.txt"));
    fs.writeFileSync(path.join(packRoot, "added.txt"), "new");

    const refreshed = subject.refresh(added.instanceId).packs[0]!;
    expect(refreshed.status).toBe("untrusted");
    expect(refreshed.changes).toEqual([
      { path: "added.txt", kind: "added" },
      { path: "instructions.md", kind: "modified" },
      { path: "remove-me.txt", kind: "removed" },
    ]);
    expect(subject.setTrust(added.instanceId, refreshed.digest, true).changes).toEqual([]);
  });

  it("persists source-missing and invalid degradation without storing file bodies", () => {
    const packRoot = path.join(root, "pack");
    writePack(packRoot, { instruction: "uniquely-sensitive-instruction-body" });
    const subject = registry();
    const added = subject.add(packRoot);
    fs.rmSync(packRoot, { recursive: true });

    expect(subject.refresh(added.instanceId).packs[0]?.status).toBe("source-missing");
    const restarted = registry();
    expect(restarted.list().packs[0]).toMatchObject({ status: "source-missing", manifest: { id: "team-pack" } });
    expect(repos.getCapabilityPack(added.instanceId)?.manifest_json).not.toContain("uniquely-sensitive-instruction-body");

    writePack(packRoot);
    fs.writeFileSync(path.join(packRoot, "capability.json"), "{ bad json");
    expect(restarted.refresh(added.instanceId).packs[0]?.status).toBe("invalid");
    expect(registry().list().packs[0]?.status).toBe("invalid");
  });

  it("accepts only declared non-empty Rookery secrets and exposes value-free status", () => {
    const packRoot = path.join(root, "pack");
    writePack(packRoot, { secretKey: "issue-token" });
    const subject = registry();
    const added = subject.add(packRoot);

    expect(() => subject.setSecret(added.instanceId, "other", "value")).toThrow(/not declared/i);
    expect(() => subject.setSecret(added.instanceId, "issue-token", "")).toThrow(/empty/i);
    expect(subject.setSecret(added.instanceId, "issue-token", "actual-secret-value"))
      .toEqual({ key: "issue-token", configured: true });
    expect(subject.getSecretValueForRuntime(added.instanceId, "issue-token")).toBe("actual-secret-value");
    expect(() => subject.getSecretValueForRuntime(added.instanceId, "other")).toThrow(/not declared/i);
    expect(JSON.stringify(subject.list())).not.toContain("actual-secret-value");
    expect(subject.list().packs[0]?.secrets).toEqual([{ key: "issue-token", configured: true }]);
    subject.deleteSecret(added.instanceId, "issue-token");
    expect(subject.list().packs[0]?.secrets).toEqual([{ key: "issue-token", configured: false }]);
  });

  it("validates binding scope authority and source ownership", () => {
    const packRoot = path.join(root, "pack");
    writePack(packRoot);
    const subject = registry();
    const added = subject.add(packRoot);
    repos.createRepo({ id: "repo-1", name: "app", path: "/repo", description: "" });
    repos.createSession({ id: "session-1", cwd: "/repo" });
    repos.createWorker({ id: "worker-1", sessionId: "session-1", repoPath: "/repo", label: "worker" });
    const base = {
      packInstanceId: added.instanceId,
      audience: { agents: ["master" as const], origins: ["ui" as const] },
      enabled: true,
    };

    expect(() => subject.setBinding("bad", { ...base, scopeKind: "rookery", scopeRef: "not-empty" })).toThrow(/empty/i);
    expect(() => subject.setBinding("bad", { ...base, scopeKind: "repo-local", scopeRef: "missing" })).toThrow(/unknown repo/i);
    expect(() => subject.setBinding("bad", { ...base, scopeKind: "session", scopeRef: "missing" })).toThrow(/unknown session/i);
    expect(() => subject.setBinding("bad", { ...base, scopeKind: "worker", scopeRef: "missing" })).toThrow(/unknown worker/i);
    expect(() => subject.setBinding("bad", { ...base, scopeKind: "repo-shared", scopeRef: "repo-1" })).toThrow(/repo-shared pack/i);
    expect(subject.setBinding("ok", { ...base, scopeKind: "session", scopeRef: "session-1" }).id).toBe("ok");
  });

  it("increments generation and reports affected scopes for every successful mutation", () => {
    const packRoot = path.join(root, "pack");
    writePack(packRoot, { secretKey: "issue-token" });
    const changes: Array<{ generation: number; affected: unknown[] }> = [];
    const subject = registry((change) => changes.push(change));
    const added = subject.add(packRoot);
    subject.setBinding("global", {
      packInstanceId: added.instanceId,
      scopeKind: "rookery",
      scopeRef: "",
      audience: { agents: ["master"], origins: ["ui"] },
      enabled: true,
    });
    subject.setTrust(added.instanceId, added.digest, true);
    subject.setSecret(added.instanceId, "issue-token", "secret");
    subject.deleteBinding("global");

    expect(changes.map((change) => change.generation)).toEqual([1, 2, 3, 4, 5]);
    expect(changes[0]?.affected).toEqual([]);
    expect(changes[1]?.affected).toEqual([{ scopeKind: "rookery", scopeRef: "" }]);
    expect(changes[2]?.affected).toEqual([{ scopeKind: "rookery", scopeRef: "" }]);
    expect(changes[4]?.affected).toEqual([{ scopeKind: "rookery", scopeRef: "" }]);
    expect(subject.list().generation).toBe(5);
  });

  it("discovers repo-owned shared packs without auto-trusting or auto-binding them", () => {
    const repo = path.join(root, "repo");
    const packRoot = path.join(repo, ".rookery", "capabilities", "team");
    writePack(packRoot, { secretKey: "issue-token" });
    writeSharedIndex(repo, [{ path: "team" }]);
    repos.createRepo({ id: "repo-1", name: "app", path: repo, description: "" });
    const subject = registry();

    const library = subject.reconcileRepoShared("repo-1");

    expect(library.packs).toHaveLength(1);
    expect(library.packs[0]).toMatchObject({
      instanceId: "pack-1", sourceKind: "repo-shared", ownerRepoId: "repo-1",
      sourcePath: fs.realpathSync.native(packRoot), status: "untrusted",
    });
    expect(library.bindings).toEqual([]);
    expect(library.diagnostics).toEqual([]);
  });

  it("keeps repo-shared identity, bindings, and secrets while digest trust fails closed on change", () => {
    const repo = path.join(root, "repo");
    const packRoot = path.join(repo, ".rookery", "capabilities", "team");
    writePack(packRoot, { secretKey: "issue-token" });
    writeSharedIndex(repo, [{ path: "team" }]);
    repos.createRepo({ id: "repo-1", name: "app", path: repo, description: "" });
    const subject = registry();
    const initial = subject.reconcileRepoShared("repo-1").packs[0]!;
    subject.setTrust(initial.instanceId, initial.digest, true);
    subject.setSecret(initial.instanceId, "issue-token", "secret-value");
    subject.setBinding("shared-binding", {
      packInstanceId: initial.instanceId, scopeKind: "repo-shared", scopeRef: "repo-1",
      audience: { agents: ["master", "worker"], origins: ["ui"] }, enabled: true,
    });

    fs.appendFileSync(path.join(packRoot, "instructions.md"), "Changed.\n");
    const changed = subject.reconcileRepoShared("repo-1").packs[0]!;

    expect(changed.instanceId).toBe(initial.instanceId);
    expect(changed.digest).not.toBe(initial.digest);
    expect(changed.status).toBe("untrusted");
    expect(changed.secrets).toEqual([{ key: "issue-token", configured: true }]);
    expect(subject.list().bindings.map((binding) => binding.id)).toEqual(["shared-binding"]);
  });

  it("treats disabled, stale, and missing repo index entries as authoritative removal tombstones", () => {
    const repo = path.join(root, "repo");
    const packRoot = path.join(repo, ".rookery", "capabilities", "team");
    writePack(packRoot);
    writeSharedIndex(repo, [{ path: "team" }]);
    repos.createRepo({ id: "repo-1", name: "app", path: repo, description: "" });
    const subject = registry();
    subject.reconcileRepoShared("repo-1");

    writeSharedIndex(repo, [{ path: "team", disabled: true }]);
    expect(subject.reconcileRepoShared("repo-1").packs).toEqual([]);
    writeSharedIndex(repo, [{ path: "team" }]);
    expect(subject.reconcileRepoShared("repo-1").packs).toHaveLength(1);
    writeSharedIndex(repo, []);
    expect(subject.reconcileRepoShared("repo-1").packs).toEqual([]);
    writeSharedIndex(repo, [{ path: "team" }]);
    subject.reconcileRepoShared("repo-1");
    fs.rmSync(path.join(repo, ".rookery", "capabilities.json"));
    expect(subject.reconcileRepoShared("repo-1").packs).toEqual([]);
  });

  it("keeps existing rows fail-closed for an invalid index and isolates invalid siblings", () => {
    const repo = path.join(root, "repo");
    const team = path.join(repo, ".rookery", "capabilities", "team");
    const valid = path.join(repo, ".rookery", "capabilities", "valid");
    writePack(team);
    writePack(valid, { id: "valid-pack" });
    writeSharedIndex(repo, [{ path: "team" }]);
    repos.createRepo({ id: "repo-1", name: "app", path: repo, description: "" });
    const subject = registry();
    const instanceId = subject.reconcileRepoShared("repo-1").packs[0]!.instanceId;
    fs.writeFileSync(path.join(repo, ".rookery", "capabilities.json"), "{ bad json");

    const invalidIndex = subject.reconcileRepoShared("repo-1");
    expect(invalidIndex.packs[0]).toMatchObject({ instanceId, status: "invalid" });
    expect(invalidIndex.diagnostics).toHaveLength(1);

    writeSharedIndex(repo, [{ path: "team" }, { path: "missing" }, { path: "valid" }]);
    const recovered = subject.reconcileRepoShared("repo-1");
    expect(recovered.packs.map((pack) => pack.manifest.id)).toEqual(["team-pack", "valid-pack"]);
    expect(recovered.packs.find((pack) => pack.instanceId === instanceId)?.status).toBe("untrusted");
    expect(recovered.diagnostics).toHaveLength(1);
    expect(recovered.diagnostics[0]?.source).toContain("#missing");
  });
});
