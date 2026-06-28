import { describe, it, expect } from "vitest";
import { baseName } from "../src/renderer/lib/path.js";

describe("baseName", () => {
  it("returns the leaf for POSIX paths", () => {
    expect(baseName("/Users/me/test/a/b/c")).toBe("c");
    expect(baseName("/work/app-api")).toBe("app-api");
  });
  it("returns the leaf for Windows paths (backslash)", () => {
    expect(baseName("C:\\Users\\me\\test\\a\\b\\c")).toBe("c");
    expect(baseName("C:\\projects\\app-api")).toBe("app-api");
  });
  it("handles trailing separators", () => {
    expect(baseName("/work/proj/")).toBe("proj");
    expect(baseName("C:\\work\\proj\\")).toBe("proj");
  });
  it("falls back to the input when there is no segment", () => {
    expect(baseName("")).toBe("");
    expect(baseName("name")).toBe("name");
  });
});
