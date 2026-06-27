import { describe, it, expect } from "vitest";
import { translate, interpolate } from "../../src/renderer/i18n/core.js";

describe("i18n core", () => {
  const cat = { "a.hi": "안녕", "a.count": "{count}개", "a.two": "{a} / {b}" };
  it("returns the catalog value for a known key", () => {
    expect(translate(cat, "a.hi")).toBe("안녕");
  });
  it("interpolates named params", () => {
    expect(translate(cat, "a.count", { count: 3 })).toBe("3개");
    expect(translate(cat, "a.two", { a: "x", b: "y" })).toBe("x / y");
  });
  it("returns the key itself when missing (visible fallback)", () => {
    expect(translate(cat, "a.nope")).toBe("a.nope");
  });
  it("leaves unmatched placeholders intact", () => {
    expect(interpolate("{x}{y}", { x: "1" })).toBe("1{y}");
  });
});
