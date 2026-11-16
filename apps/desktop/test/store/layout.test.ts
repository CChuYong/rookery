import { describe, it, expect } from "vitest";
import { saveLayout, clearLayout, pruneLayouts, emptyLayoutState, isSaneLayout, migrateLayoutState, useLayoutStore } from "../../src/renderer/store/layout.js";

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

// audit #5 #6 / Review focus 2: v1 layouts saved in the broken half-width shape are dropped once; sane ones load.
describe("layout store v1 → v2 migration", () => {
  const leaf = (id: string, views: string[], size: number) => ({ type: "leaf", size, data: { id, views, activeView: views[0] } });
  const sane = { grid: { orientation: "HORIZONTAL", root: { type: "branch", size: 900, data: [
    { type: "branch", size: 1080, data: [leaf("1", ["panel:conversation"], 660), leaf("2", ["panel:terminal"], 240)] },
    leaf("3", ["panel:files", "panel:git"], 320),
  ] } }, panels: {} };
  // Side group nested beside the conversation inside a column, terminal stretched under both (shot 08).
  const broken = { grid: { orientation: "VERTICAL", root: { type: "branch", size: 1400, data: [
    { type: "branch", size: 660, data: [leaf("1", ["panel:conversation"], 1080), leaf("3", ["panel:files", "panel:git"], 320)] },
    leaf("2", ["panel:terminal"], 240),
  ] } }, panels: {} };
  const noSide = { grid: { orientation: "HORIZONTAL", root: leaf("1", ["panel:conversation"], 1400) }, panels: {} };

  it("isSaneLayout keeps root-column side panels and layouts without them, rejects nested side panels and junk", () => {
    expect(isSaneLayout(sane)).toBe(true);
    expect(isSaneLayout(noSide)).toBe(true);
    expect(isSaneLayout(broken)).toBe(false);
    expect(isSaneLayout(null)).toBe(false);
    expect(isSaneLayout({ grid: 1 })).toBe(false);
  });
  it("migrateLayoutState drops only broken v1 layouts and passes v2 through", () => {
    expect(migrateLayoutState({ byPage: { a: sane, b: broken, c: noSide } }, 1).byPage).toEqual({ a: sane, c: noSide });
    expect(migrateLayoutState({ byPage: { b: broken } }, 2).byPage).toEqual({ b: broken });
    expect(migrateLayoutState(undefined, 1).byPage).toEqual({});
  });
  it("reset_ clears the saved layout and bumps the page's reset counter even with nothing saved (audit #81)", () => {
    useLayoutStore.setState({ ...emptyLayoutState(), resetSeq: {} });
    useLayoutStore.getState().reset_("p1");
    expect(useLayoutStore.getState().resetSeq.p1).toBe(1);
    useLayoutStore.getState().save_("p1", { grid: 1 });
    useLayoutStore.getState().reset_("p1");
    expect(useLayoutStore.getState().byPage.p1).toBeUndefined();
    expect(useLayoutStore.getState().resetSeq.p1).toBe(2);
  });
});
