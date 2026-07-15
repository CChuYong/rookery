import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRepoSharedIndex, resolveRepoSharedPackPath } from "../../../src/core/capabilities/repo-shared.js";

const roots: string[] = [];
function temp(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rk-repo-shared-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("repo-shared capability index", () => {
  it("distinguishes a missing index from a strict valid index and normalizes disabled", () => {
    const repo = temp();
    expect(loadRepoSharedIndex(repo).status).toBe("missing");
    fs.mkdirSync(path.join(repo, ".rookery"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".rookery", "capabilities.json"), JSON.stringify({
      schemaVersion: 1,
      packs: [{ path: "team" }, { path: "legacy", disabled: true }],
    }));
    expect(loadRepoSharedIndex(repo)).toMatchObject({
      status: "valid",
      entries: [{ path: "team", disabled: false }, { path: "legacy", disabled: true }],
    });
  });

  it("rejects malformed, unknown, and oversized index fields without leaking file contents", () => {
    const repo = temp();
    fs.mkdirSync(path.join(repo, ".rookery"), { recursive: true });
    const index = path.join(repo, ".rookery", "capabilities.json");
    fs.writeFileSync(index, "{ uniquely-sensitive-bad-json");
    const malformed = loadRepoSharedIndex(repo);
    expect(malformed.status).toBe("invalid");
    expect(JSON.stringify(malformed)).not.toContain("uniquely-sensitive-bad-json");

    fs.writeFileSync(index, JSON.stringify({ schemaVersion: 1, packs: [], extra: true }));
    expect(loadRepoSharedIndex(repo).status).toBe("invalid");
    fs.writeFileSync(index, JSON.stringify({ schemaVersion: 1, packs: Array.from({ length: 257 }, (_, i) => ({ path: `p-${i}` })) }));
    expect(loadRepoSharedIndex(repo).status).toBe("invalid");
  });

  it("keeps resolved packs contained and rejects traversal, absolute paths, and symlink escapes", () => {
    const repo = temp();
    const capabilityRoot = path.join(repo, ".rookery", "capabilities");
    const outside = temp();
    fs.mkdirSync(path.join(capabilityRoot, "team"), { recursive: true });
    expect(resolveRepoSharedPackPath(repo, "team")).toBe(fs.realpathSync.native(path.join(capabilityRoot, "team")));
    expect(() => resolveRepoSharedPackPath(repo, "../outside")).toThrow(/inside/i);
    expect(() => resolveRepoSharedPackPath(repo, path.join(repo, "absolute"))).toThrow(/relative/i);
    fs.symlinkSync(outside, path.join(capabilityRoot, "escape"));
    expect(() => resolveRepoSharedPackPath(repo, "escape")).toThrow(/symlink|escapes/i);
  });
});
