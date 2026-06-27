import { describe, it, expect } from "vitest";
import { emptyTermState, openTab, closeTab, setActiveTab, markExited, setTabs, toggleOpen, setHeight, deriveLayout, setLayout, pruneLayout, setDrawerOpen } from "../src/renderer/store/terminals.js";

const tab = (id: string) => ({ id, title: id, exited: false });
const ttab = (id: string) => ({ id, title: id, exited: false });

describe("terminals reducer (per-page)", () => {
  it("openTab adds a tab to that page and makes it active", () => {
    let s = emptyTermState();
    s = openTab(s, "p1", tab("a"));
    expect(s.byPage.p1.tabs).toEqual([tab("a")]);
    expect(s.byPage.p1.activeTabId).toBe("a");
  });

  it("openTab caps at 8 per page", () => {
    let s = emptyTermState();
    for (let i = 0; i < 10; i++) s = openTab(s, "p1", tab(`t${i}`));
    expect(s.byPage.p1.tabs).toHaveLength(8);
  });

  it("closeTab removes the tab and reselects a neighbor", () => {
    let s = emptyTermState();
    s = openTab(s, "p1", tab("a"));
    s = openTab(s, "p1", tab("b"));
    s = setActiveTab(s, "p1", "a");
    s = closeTab(s, "p1", "a");
    expect(s.byPage.p1.tabs).toEqual([tab("b")]);
    expect(s.byPage.p1.activeTabId).toBe("b");
  });

  it("markExited flags the tab but keeps it", () => {
    let s = emptyTermState();
    s = openTab(s, "p1", tab("a"));
    s = markExited(s, "p1", "a");
    expect(s.byPage.p1.tabs).toEqual([{ id: "a", title: "a", exited: true }]);
  });

  it("setTabs replaces a page's tabs, keeps active if present, preserves open", () => {
    let s = emptyTermState();
    s = toggleOpen(s, "p1");
    s = openTab(s, "p1", tab("a"));
    s = setTabs(s, "p1", [tab("x"), tab("y")]);
    expect(s.byPage.p1.tabs).toEqual([tab("x"), tab("y")]);
    expect(s.byPage.p1.activeTabId).toBe("x");
    expect(s.byPage.p1.open).toBe(true);
  });

  it("open state is independent per page (repos sub vs sessions master)", () => {
    let s = emptyTermState();
    s = toggleOpen(s, "repo-sub");
    expect(s.byPage["repo-sub"].open).toBe(true);
    expect(s.byPage["master-sess"]?.open ?? false).toBe(false); // other pages are unaffected
    s = toggleOpen(s, "repo-sub");
    expect(s.byPage["repo-sub"].open).toBe(false);
  });

  it("setHeight clamps (global layout pref)", () => {
    let s = emptyTermState();
    expect(setHeight(s, 5000).height).toBe(800);
    expect(setHeight(s, 50).height).toBe(120);
  });
});

describe("terminal layout (for persistence)", () => {
  it("deriveLayout counts non-exited tabs + open", () => {
    let p = { tabs: [ttab("a"), { id: "b", title: "b", exited: true }], activeTabId: "a", open: true };
    expect(deriveLayout(p)).toEqual({ count: 1, open: true });
  });
  it("setLayout syncs from live byPage", () => {
    let s = emptyTermState();
    s = openTab(s, "p1", ttab("a"));
    s = openTab(s, "p1", ttab("b"));
    s = setLayout(s, "p1");
    expect(s.layout.p1).toEqual({ count: 2, open: false });
  });
  it("setDrawerOpen sets open deterministically", () => {
    let s = emptyTermState();
    s = openTab(s, "p1", ttab("a"));
    s = setDrawerOpen(s, "p1", true);
    expect(s.byPage.p1.open).toBe(true);
    s = setDrawerOpen(s, "p1", true);
    expect(s.byPage.p1.open).toBe(true); // idempotent
  });
  it("pruneLayout drops unknown keys", () => {
    let s = emptyTermState();
    s = openTab(s, "live", ttab("a"));
    s = setLayout(s, "live");
    s = openTab(s, "dead", ttab("b"));
    s = setLayout(s, "dead");
    s = pruneLayout(s, new Set(["live"]));
    expect(Object.keys(s.layout)).toEqual(["live"]);
  });
});
