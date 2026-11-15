import { describe, it, expect } from "vitest";
import { splitUnifiedDiff } from "../../src/renderer/lib/unified-diff.js";

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " keep",
  "-old",
  "+new",
  "+added",
  "diff --git a/gone.txt b/gone.txt",
  "deleted file mode 100644",
  "--- a/gone.txt",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-bye",
  "diff --git a/new.md b/new.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/new.md",
  "@@ -0,0 +1 @@",
  "+--- a markdown rule, not a header",
].join("\n");

describe("splitUnifiedDiff (audit #84 branch diff)", () => {
  it("splits a git diff into files with their own added/deleted counts and hunk lines", () => {
    const files = splitUnifiedDiff(DIFF);
    expect(files.map((f) => [f.path, f.status, f.added, f.deleted])).toEqual([
      ["src/a.ts", "M", 2, 1],
      ["gone.txt", "D", 0, 1],
      ["new.md", "A", 1, 0],
    ]);
    expect(files[0]!.lines).toEqual(["@@ -1,3 +1,4 @@", " keep", "-old", "+new", "+added"]);
    expect(files[2]!.lines).toEqual(["@@ -0,0 +1 @@", "+--- a markdown rule, not a header"]);
  });

  it("returns nothing for an empty diff and keeps a truncation marker out of the counts", () => {
    expect(splitUnifiedDiff("")).toEqual([]);
    const files = splitUnifiedDiff(`${DIFF.split("\n").slice(0, 8).join("\n")}\n…(truncated)`);
    expect(files).toHaveLength(1);
    expect(files[0]!.added).toBe(1);
  });

  it("handles renames by using the new path", () => {
    const files = splitUnifiedDiff(["diff --git a/old.ts b/new.ts", "similarity index 100%", "rename from old.ts", "rename to new.ts"].join("\n"));
    expect(files).toEqual([{ path: "new.ts", status: "R", added: 0, deleted: 0, lines: [] }]);
  });
});
