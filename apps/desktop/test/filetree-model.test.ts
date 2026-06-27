import { describe, it, expect } from "vitest";
import { flatten, parentDir, ancestorDirs, fuzzyFilter, type Entry } from "../src/renderer/lib/filetree-model.js";

describe("flatten", () => {
  const children = new Map<string, Entry[]>([
    ["/r", [{ name: "src", isDir: true }, { name: "a.ts", isDir: false }]],
    ["/r/src", [{ name: "deep", isDir: true }, { name: "b.ts", isDir: false }]],
    ["/r/src/deep", [{ name: "c.ts", isDir: false }]],
  ]);
  it("returns only top-level rows when nothing is expanded", () => {
    expect(flatten("/r", new Set(), children)).toEqual([
      { path: "/r/src", name: "src", isDir: true, depth: 0 },
      { path: "/r/a.ts", name: "a.ts", isDir: false, depth: 0 },
    ]);
  });
  it("descends into expanded directories with increasing depth", () => {
    const rows = flatten("/r", new Set(["/r/src", "/r/src/deep"]), children);
    expect(rows.map((r) => [r.name, r.depth])).toEqual([
      ["src", 0], ["deep", 1], ["c.ts", 2], ["b.ts", 1], ["a.ts", 0],
    ]);
  });
  it("treats expanded-but-unloaded dirs as empty (no crash)", () => {
    expect(flatten("/r", new Set(["/r/src"]), new Map([["/r", [{ name: "src", isDir: true }]]]))).toEqual([
      { path: "/r/src", name: "src", isDir: true, depth: 0 },
    ]);
  });
});

describe("parentDir / ancestorDirs", () => {
  it("parentDir strips the last segment", () => {
    expect(parentDir("/r/src/a.ts")).toBe("/r/src");
  });
  it("ancestorDirs lists root..parent for a nested file", () => {
    expect(ancestorDirs("/r/src/deep/c.ts", "/r")).toEqual(["/r", "/r/src", "/r/src/deep"]);
  });
  it("ancestorDirs of a top-level file is just root", () => {
    expect(ancestorDirs("/r/a.ts", "/r")).toEqual(["/r"]);
  });
});

describe("fuzzyFilter", () => {
  const paths = ["src/components/FileTree.tsx", "src/store/workspace.ts", "test/file-tree.test.tsx", "README.md"];
  it("matches subsequences case-insensitively", () => {
    const r = fuzzyFilter(paths, "filetree");
    expect(r[0]).toBe("src/components/FileTree.tsx");
  });
  it("excludes non-matches", () => {
    expect(fuzzyFilter(paths, "xyz")).toEqual([]);
  });
  it("respects the limit", () => {
    expect(fuzzyFilter(paths, "s", 1)).toHaveLength(1);
  });
});
