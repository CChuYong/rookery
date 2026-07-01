import { describe, it, expect } from "vitest";
import { saveLayout, clearLayout, pruneLayouts, emptyLayoutState } from "../../src/renderer/store/layout.js";

describe("layout store reducers", () => {
  it("saves a layout json under a page key", () => {
    const s = saveLayout(emptyLayoutState(), "w1", { grid: 1 });
    expect(s.byPage.w1).toEqual({ grid: 1 });
  });
  it("overwrites an existing page's layout", () => {
    let s = saveLayout(emptyLayoutState(), "w1", { a: 1 });
    s = saveLayout(s, "w1", { a: 2 });
    expect(s.byPage.w1).toEqual({ a: 2 });
  });
  it("clears one page's layout", () => {
    let s = saveLayout(emptyLayoutState(), "w1", { a: 1 });
    s = clearLayout(s, "w1");
    expect(s.byPage.w1).toBeUndefined();
  });
  it("prunes unknown page keys", () => {
    let s = saveLayout(emptyLayoutState(), "w1", { a: 1 });
    s = saveLayout(s, "w2", { b: 2 });
    const pruned = pruneLayouts(s, new Set(["w2"]));
    expect(pruned.byPage.w1).toBeUndefined();
    expect(pruned.byPage.w2).toEqual({ b: 2 });
  });
});
