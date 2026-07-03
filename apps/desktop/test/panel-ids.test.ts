import { describe, it, expect } from "vitest";
import { panelIdForTab, tabIdForPanel, fixedPanelId, editorPanelId, editorTooltip } from "../src/renderer/workspace/panel-ids.js";
import { emptyWsState, openFile, toggleDir } from "../src/renderer/store/workspace.js";

describe("tab⇄panel id mapping (dock active sync)", () => {
  it("round-trips editor tabs and the agent tab", () => {
    expect(panelIdForTab("file:/a/b.ts")).toBe(editorPanelId("file:/a/b.ts"));
    expect(tabIdForPanel(panelIdForTab("file:/a/b.ts"))).toBe("file:/a/b.ts");
    expect(panelIdForTab("agent")).toBe(fixedPanelId("conversation"));
    expect(tabIdForPanel(fixedPanelId("conversation"))).toBe("agent");
  });
  it("fixed non-tab panels map to null", () => {
    expect(tabIdForPanel(fixedPanelId("files"))).toBeNull();
    expect(tabIdForPanel(fixedPanelId("terminal"))).toBeNull();
  });

  // The WorkspaceDock store subscription gates syncActive (which force-activates the tab panel) on
  // `state.byPage[pageKey] !== prevState.byPage[pageKey]`. This asserts that gate's precondition:
  // tree/sidebar writes leave byPage reference-equal (so they DON'T steal activation from a focused fixed
  // panel), while a tab write (even re-clicking an open file) produces a NEW page object (so it DOES sync).
  it("identity gate precondition: tree/sidebar writes keep byPage reference-equal; tab writes produce a new page object", () => {
    const s0 = emptyWsState();
    const s1 = openFile(s0, "p1", "/a.ts");
    expect(toggleDir(s1, "p1", "/dir").byPage).toBe(s1.byPage); // unrelated write → same reference
    const s2 = openFile(s1, "p1", "/a.ts"); // re-click existing tab
    expect(s2.byPage["p1"]).not.toBe(s1.byPage["p1"]); // tab write → new page object
  });
});

// audit #28: the tab label truncates and a diff tab shares a basename with its file
// counterpart, so the hover tooltip must reveal the full path + kind.
describe("editorTooltip", () => {
  it("shows the full path for a file tab", () => {
    expect(editorTooltip("file:/repo/src/deep/api.ts")).toBe("/repo/src/deep/api.ts");
  });
  it("shows the full path + a (diff) marker for a diff tab", () => {
    expect(editorTooltip("diff:/repo/src/deep/api.ts")).toBe("/repo/src/deep/api.ts (diff)");
  });
  it("has no tooltip for a commit tab or the pinned agent tab", () => {
    expect(editorTooltip("commit:abc123")).toBeUndefined();
    expect(editorTooltip("agent")).toBeUndefined();
  });
});
