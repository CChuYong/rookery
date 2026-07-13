import { describe, it, expect } from "vitest";
import { canonicalPath, longestContainingRepo, repoPathError } from "../../src/core/repo-path.js";

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

describe("canonical repository matching", () => {
  const identity = (value: string) => value;

  it("chooses the longest containing path instead of a string-prefix sibling", () => {
    const repos = [
      { id: "root", path: "/workspace/app" },
      { id: "nested", path: "/workspace/app/packages/web" },
      { id: "sibling", path: "/workspace/application" },
    ];
    expect(longestContainingRepo("/workspace/app/packages/web/src", repos, identity)?.id).toBe("nested");
    expect(longestContainingRepo("/workspace/application/src", repos, identity)?.id).toBe("sibling");
    expect(longestContainingRepo("/workspace/app-copy", repos, identity)).toBeUndefined();
  });

  it("uses canonical real paths and has a deterministic id tie-break", () => {
    const aliases = new Map([
      ["/alias/project", "/real/project"],
      ["/alias/project/src", "/real/project/src"],
    ]);
    const realpath = (value: string) => aliases.get(value) ?? value;
    expect(canonicalPath("/alias/project", realpath)).toBe("/real/project");
    expect(longestContainingRepo("/alias/project/src", [
      { id: "z", path: "/real/project" },
      { id: "a", path: "/alias/project" },
    ], realpath)?.id).toBe("a");
  });

  it("falls back to a normalized absolute path when realpath is unavailable", () => {
    expect(canonicalPath("./missing/../pack", () => { throw new Error("missing"); }))
      .toBe(canonicalPath("./pack", () => { throw new Error("missing"); }));
  });
});
