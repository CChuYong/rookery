import { describe, it, expect } from "vitest";
import { emptyWsState, openFile, openDiff, openCommit, closeTab, setActive, setDirty, toggleRight, setSegment, setRightWidth, pruneWsPages, toggleDir, collapseAll, expandAncestors, type Tab } from "../src/renderer/store/workspace.js";

describe("workspace reducer", () => {
  it("a fresh page has a pinned agent tab", () => {
    const s = emptyWsState();
    const s2 = setActive(s, "p1", "agent"); // seed on first access to the page
    expect(s2.byPage.p1.tabs).toEqual([{ id: "agent", kind: "agent" }]);
    expect(s2.byPage.p1.activeTabId).toBe("agent");
  });

  it("openFile adds a file tab and activates it", () => {
    let s = emptyWsState();
    s = openFile(s, "p1", "/r/src/api.ts");
    expect(s.byPage.p1.tabs).toEqual([
      { id: "agent", kind: "agent" },
      { id: "file:/r/src/api.ts", kind: "file", path: "/r/src/api.ts", title: "api.ts", dirty: false },
    ]);
    expect(s.byPage.p1.activeTabId).toBe("file:/r/src/api.ts");
  });

  it("openFile on an already-open path just activates (no dup)", () => {
    let s = emptyWsState();
    s = openFile(s, "p1", "/r/a.ts");
    s = openFile(s, "p1", "/r/b.ts");
    s = openFile(s, "p1", "/r/a.ts");
    expect(s.byPage.p1.tabs.filter((t) => t.kind === "file")).toHaveLength(2);
    expect(s.byPage.p1.activeTabId).toBe("file:/r/a.ts");
  });

  it("closeTab removes a file tab and reselects a neighbor", () => {
    let s = emptyWsState();
    s = openFile(s, "p1", "/r/a.ts");
    s = closeTab(s, "p1", "file:/r/a.ts");
    expect(s.byPage.p1.tabs).toEqual([{ id: "agent", kind: "agent" }]);
    expect(s.byPage.p1.activeTabId).toBe("agent");
  });

  it("closeTab never closes the pinned agent tab", () => {
    let s = emptyWsState();
    s = openFile(s, "p1", "/r/a.ts");
    s = closeTab(s, "p1", "agent");
    expect(s.byPage.p1.tabs.some((t) => t.id === "agent")).toBe(true);
  });

  it("setDirty flags a file tab", () => {
    let s = emptyWsState();
    s = openFile(s, "p1", "/r/a.ts");
    s = setDirty(s, "p1", "file:/r/a.ts", true);
    const tab = s.byPage.p1.tabs.find((t) => t.id === "file:/r/a.ts");
    expect(tab && tab.kind === "file" && tab.dirty).toBe(true);
  });

  it("openDiff adds a read-only diff tab titled '<basename> (diff)' — distinguishes it from a same-named file tab (audit #28)", () => {
    let s = emptyWsState();
    s = openDiff(s, "p1", "/r/app.ts");
    expect(s.byPage.p1.tabs.find((t) => t.id === "diff:/r/app.ts")).toEqual({ id: "diff:/r/app.ts", kind: "diff", path: "/r/app.ts", title: "app.ts (diff)" });
    expect(s.byPage.p1.activeTabId).toBe("diff:/r/app.ts");
  });

  it("a file tab and a diff tab for the same path have distinct titles", () => {
    let s = emptyWsState();
    s = openFile(s, "p1", "/r/app.ts");
    s = openDiff(s, "p1", "/r/app.ts");
    const fileTab = s.byPage.p1.tabs.find((t): t is Extract<Tab, { kind: "file" }> => t.id === "file:/r/app.ts");
    const diffTab = s.byPage.p1.tabs.find((t): t is Extract<Tab, { kind: "diff" }> => t.id === "diff:/r/app.ts");
    expect(fileTab?.title).toBe("app.ts");
    expect(diffTab?.title).toBe("app.ts (diff)");
    expect(fileTab?.title).not.toBe(diffTab?.title);
  });

  it("openCommit adds a commit tab (title from subject, cut at 32 chars)", () => {
    let s = emptyWsState();
    s = openCommit(s, "p1", "abc123def", "y".repeat(40));
    const tab = s.byPage.p1.tabs.find((t) => t.id === "commit:abc123def");
    expect(tab).toEqual({ id: "commit:abc123def", kind: "commit", hash: "abc123def", title: "y".repeat(32) });
    expect(s.byPage.p1.activeTabId).toBe("commit:abc123def");
  });

  it("right sidebar: toggle, segment, width clamp", () => {
    let s = emptyWsState();
    expect(s.right.open).toBe(false);
    s = toggleRight(s);
    expect(s.right.open).toBe(true);
    s = setSegment(s, "git");
    expect(s.right.segment).toBe("git");
    expect(setRightWidth(s, 5000).right.width).toBe(560);
    expect(setRightWidth(s, 50).right.width).toBe(200);
  });
});

describe("pruneWsPages", () => {
  it("removes pages whose key is not in knownKeys", () => {
    let s = emptyWsState();
    s = openFile(s, "sess-1", "/r/a.ts");
    s = openFile(s, "dead-sub", "/r/b.ts");
    const pruned = pruneWsPages(s, new Set(["sess-1"]));
    expect(Object.keys(pruned.byPage)).toEqual(["sess-1"]);
  });
  it("keeps all pages when all keys are known", () => {
    let s = emptyWsState();
    s = openFile(s, "sess-1", "/r/a.ts");
    const pruned = pruneWsPages(s, new Set(["sess-1", "sess-2"]));
    expect(Object.keys(pruned.byPage)).toEqual(["sess-1"]);
  });
});

describe("expanded dirs", () => {
  it("toggleDir adds then removes a dir for a page", () => {
    let s = emptyWsState();
    s = toggleDir(s, "p1", "/r/src");
    expect(s.expandedByPage.p1).toEqual(["/r/src"]);
    s = toggleDir(s, "p1", "/r/src");
    expect(s.expandedByPage.p1).toEqual([]);
  });
  it("collapseAll clears a page's expanded set", () => {
    let s = emptyWsState();
    s = toggleDir(s, "p1", "/r/src");
    s = toggleDir(s, "p1", "/r/lib");
    s = collapseAll(s, "p1");
    expect(s.expandedByPage.p1).toEqual([]);
  });
  it("expandAncestors adds all ancestor dirs of a file (deduped)", () => {
    let s = emptyWsState();
    s = toggleDir(s, "p1", "/r"); // an already-open root is not duplicated
    s = expandAncestors(s, "p1", "/r/src/deep/c.ts", "/r");
    expect(s.expandedByPage.p1.sort()).toEqual(["/r", "/r/src", "/r/src/deep"]);
  });
  it("pruneWsPages drops expanded sets for unknown pages", () => {
    let s = emptyWsState();
    s = toggleDir(s, "sess-1", "/r/src");
    s = toggleDir(s, "dead", "/r/x");
    const pruned = pruneWsPages(s, new Set(["sess-1"]));
    expect(Object.keys(pruned.expandedByPage)).toEqual(["sess-1"]);
  });
});
