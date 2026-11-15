import { describe, it, expect } from "vitest";
import { splitUnifiedDiff, parseUnifiedDiff, unquoteGitPath } from "../../src/renderer/lib/unified-diff.js";

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

// git C-quotes non-ASCII / special paths: "한글.md" → "\355\225\234\352\270\200.md"
const KO = '"\\355\\225\\234\\352\\270\\200.md"';
const KO_A = '"a/\\355\\225\\234\\352\\270\\200.md"';
const KO_B = '"b/\\355\\225\\234\\352\\270\\200.md"';

describe("unquoteGitPath", () => {
  it("decodes git C-style quoting (octal UTF-8 bytes and escapes) and leaves plain paths alone", () => {
    expect(unquoteGitPath(KO)).toBe("한글.md");
    expect(unquoteGitPath('"tab\\there \\"q\\" back\\\\slash"')).toBe('tab\there "q" back\\slash');
    expect(unquoteGitPath("plain/path.ts")).toBe("plain/path.ts");
  });
});

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

  it("returns nothing for an empty diff", () => {
    expect(splitUnifiedDiff("")).toEqual([]);
  });

  it("starts a new file at a quoted (non-ASCII) path instead of merging its hunks into the previous file", () => {
    const diff = [
      ...DIFF.split("\n").slice(0, 9),
      `diff --git ${KO_A} ${KO_B}`,
      "index 333..444 100644",
      `--- ${KO_A}`,
      `+++ ${KO_B}`,
      "@@ -1 +1 @@",
      "-가",
      "+나",
    ].join("\n");
    const files = splitUnifiedDiff(diff);
    expect(files.map((f) => [f.path, f.added, f.deleted])).toEqual([["src/a.ts", 2, 1], ["한글.md", 1, 1]]);
  });

  it("handles a quoted path as the first file", () => {
    const files = splitUnifiedDiff([`diff --git ${KO_A} ${KO_B}`, "new file mode 100644", "--- /dev/null", `+++ ${KO_B}`, "@@ -0,0 +1 @@", "+x"].join("\n"));
    expect(files).toEqual([{ path: "한글.md", status: "A", added: 1, deleted: 0, binary: false, lines: ["@@ -0,0 +1 @@", "+x"] }]);
  });

  it("takes a deleted file's path from the --- side, including when quoted", () => {
    const files = splitUnifiedDiff([`diff --git ${KO_A} ${KO_B}`, "deleted file mode 100644", `--- ${KO_A}`, "+++ /dev/null", "@@ -1 +0,0 @@", "-x"].join("\n"));
    expect(files.map((f) => [f.path, f.status, f.deleted])).toEqual([["한글.md", "D", 1]]);
  });

  it("marks binary files", () => {
    const files = splitUnifiedDiff(["diff --git a/img.png b/img.png", "index 1..2 100644", "Binary files a/img.png and b/img.png differ"].join("\n"));
    expect(files).toEqual([{ path: "img.png", status: "M", added: 0, deleted: 0, binary: true, lines: [] }]);
  });

  it("handles renames by using the new path", () => {
    const files = splitUnifiedDiff(["diff --git a/old.ts b/new.ts", "similarity index 100%", "rename from old.ts", "rename to new.ts"].join("\n"));
    expect(files).toEqual([{ path: "new.ts", status: "R", added: 0, deleted: 0, binary: false, lines: [] }]);
  });
});

describe("parseUnifiedDiff truncation", () => {
  it("detects the daemon's 512 KB truncation marker and keeps it out of the counts", () => {
    const parsed = parseUnifiedDiff(`${DIFF.split("\n").slice(0, 8).join("\n")}\n…(truncated)`);
    expect(parsed.truncated).toBe(true);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]!.added).toBe(1);
    expect(parseUnifiedDiff(DIFF).truncated).toBe(false);
  });
});
