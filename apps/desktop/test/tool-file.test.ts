import { describe, it, expect } from "vitest";
import { filePathOf } from "../src/renderer/lib/tool-file.js";

describe("filePathOf", () => {
  it("extracts file_path (Read/Edit/Write/MultiEdit input)", () => {
    expect(filePathOf('{"file_path":"/r/a.ts","limit":10}')).toBe("/r/a.ts");
    expect(filePathOf('{"file_path":"/r/src/App.tsx","old_string":"x"}')).toBe("/r/src/App.tsx");
  });
  it("extracts notebook_path (NotebookEdit)", () => {
    expect(filePathOf('{"notebook_path":"/r/n.ipynb","new_source":"y"}')).toBe("/r/n.ipynb");
  });
  it("handles whitespace around the colon", () => {
    expect(filePathOf('{ "file_path" : "/r/b.md" }')).toBe("/r/b.md");
  });
  it("extracts even when input is truncated after the path", () => {
    expect(filePathOf('{"file_path":"/r/c.ts","content":"aaaaaaa')).toBe("/r/c.ts");
  });
  it("returns null for non-file tools and missing keys", () => {
    expect(filePathOf('{"command":"ls -la"}')).toBeNull();
    expect(filePathOf('{"pattern":"foo","path":"/r/src"}')).toBeNull(); // Grep's path is ignored
    expect(filePathOf(undefined)).toBeNull();
    expect(filePathOf("")).toBeNull();
    expect(filePathOf("not json at all")).toBeNull();
  });
});
