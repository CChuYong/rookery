import { describe, it, expect } from "vitest";
import { repoPathError } from "../../src/core/repo-path.js";

describe("repoPathError (SEC-2)", () => {
  const existsIn = (set: Set<string>) => (p: string) => set.has(p);

  it("rejects a relative path", () => {
    expect(repoPathError("rel/path", () => true)).toMatch(/absolute/i);
  });
  it("rejects a non-existent path", () => {
    expect(repoPathError("/abs/missing", existsIn(new Set()))).toMatch(/exist/i);
  });
  it("rejects an existing non-git directory", () => {
    expect(repoPathError("/abs/dir", existsIn(new Set(["/abs/dir"])))).toMatch(/git/i);
  });
  it("accepts an absolute existing git repo (.git present)", () => {
    expect(repoPathError("/abs/repo", existsIn(new Set(["/abs/repo", "/abs/repo/.git"])))).toBeNull();
  });
});
