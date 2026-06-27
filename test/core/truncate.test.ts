import { describe, it, expect } from "vitest";
import { truncateBytes } from "../../src/core/truncate.js";

describe("truncateBytes", () => {
  it("returns the string unchanged when within the byte budget", () => {
    expect(truncateBytes("hello", 100)).toBe("hello");
  });

  it("bounds output by UTF-8 bytes, not UTF-16 code units (Korean is 3 bytes/char)", () => {
    const s = "가".repeat(100); // 300 UTF-8 bytes, 100 UTF-16 code units
    const out = truncateBytes(s, 60);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(60);
    expect(out.length).toBeLessThan(s.length);
  });

  it("never splits a multi-byte code point (emoji surrogate pairs stay whole)", () => {
    const out = truncateBytes("😀".repeat(50), 30); // 4 bytes each, surrogate pair
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(30);
    expect(out.includes("�")).toBe(false); // no broken code point (replacement character)
  });
});
