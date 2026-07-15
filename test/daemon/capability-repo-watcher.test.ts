import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { CapabilityRegistry } from "../../src/core/capabilities/registry.js";
import { CapabilityRepoWatcher } from "../../src/daemon/capability-repo-watcher.js";
import { openDb } from "../../src/persistence/db.js";
import { Repositories } from "../../src/persistence/repositories.js";

function writePack(repo: string, name = "team", body = "Follow the rules.\n"): void {
  const pack = path.join(repo, ".rookery", "capabilities", name);
  fs.mkdirSync(pack, { recursive: true });
  fs.writeFileSync(path.join(pack, "instructions.md"), body);
  fs.writeFileSync(path.join(pack, "capability.json"), JSON.stringify({
    schemaVersion: 1, id: `${name}-pack`, displayName: name, version: "1", description: name,
    instructions: [{ id: "rules", path: "instructions.md" }],
  }));
  fs.mkdirSync(path.join(repo, ".rookery"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".rookery", "capabilities.json"), JSON.stringify({ schemaVersion: 1, packs: [{ path: name }] }));
}

class FakeWatcher extends EventEmitter {
  closed = false;
  close(): void { this.closed = true; }
}

describe("CapabilityRepoWatcher", () => {
  let root: string;
  let repos: Repositories;
  let registry: CapabilityRegistry;
  let callbacks: Array<{ filename: string; listener: (event: string, filename: string | null) => void; watcher: FakeWatcher }>;
  let subject: CapabilityRepoWatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "rk-capability-watch-"));
    repos = new Repositories(openDb(":memory:"));
    registry = new CapabilityRegistry(repos, { id: (() => { let n = 0; return () => `pack-${++n}`; })() });
    callbacks = [];
    const watch = ((filename: string, _options: { persistent: boolean }, listener: (event: string, filename: string | null) => void) => {
      const watcher = new FakeWatcher();
      callbacks.push({ filename, listener, watcher });
      return watcher;
    }) as unknown as typeof fs.watch;
    subject = new CapabilityRepoWatcher(repos, registry, { debounceMs: 200, watch: watch as never, warn: vi.fn() });
  });

  afterEach(() => {
    subject.close();
    vi.useRealTimers();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("discovers at boot and debounces nested repo changes before rebuilding watchers", async () => {
    writePack(root);
    repos.createRepo({ id: "repo-1", name: "app", path: root, description: "" });
    subject.start();
    const initial = registry.list().packs[0]!;
    expect(initial.manifest.id).toBe("team-pack");
    const nested = callbacks.find((entry) => entry.filename.endsWith(path.join("capabilities", "team")))!;
    fs.writeFileSync(path.join(root, ".rookery", "capabilities", "team", "instructions.md"), "Changed.\n");

    nested.listener("change", "instructions.md");
    nested.listener("change", "instructions.md");
    await vi.advanceTimersByTimeAsync(199);
    expect(registry.list().packs[0]?.digest).toBe(initial.digest);
    await vi.advanceTimersByTimeAsync(1);
    expect(registry.list().packs[0]?.digest).not.toBe(initial.digest);
    expect(nested.watcher.closed).toBe(true);
  });

  it("observes repos registered after start and invalidates affected scopes on removal", async () => {
    subject.start();
    writePack(root);
    repos.createRepo({ id: "repo-1", name: "app", path: root, description: "" });
    await vi.advanceTimersByTimeAsync(200);
    const pack = registry.list().packs[0]!;
    registry.setBinding("global", {
      packInstanceId: pack.instanceId, scopeKind: "rookery", scopeRef: "",
      audience: { agents: ["master"], origins: ["ui"] }, enabled: true,
    });
    const generation = registry.list().generation;

    repos.removeRepo("app");

    expect(registry.list().packs).toEqual([]);
    expect(registry.list().generation).toBe(generation + 1);
    expect(callbacks.every((entry) => entry.watcher.closed)).toBe(true);
  });

  it("ignores unrelated root changes and closes subscriptions and pending timers", async () => {
    writePack(root);
    repos.createRepo({ id: "repo-1", name: "app", path: root, description: "" });
    subject.start();
    const generation = registry.list().generation;
    const rootWatch = callbacks.find((entry) => entry.filename === root)!;
    rootWatch.listener("change", "README.md");
    await vi.advanceTimersByTimeAsync(500);
    expect(registry.list().generation).toBe(generation);
    rootWatch.listener("change", ".rookery");
    subject.close();
    await vi.advanceTimersByTimeAsync(500);
    expect(registry.list().generation).toBe(generation);
  });
});
