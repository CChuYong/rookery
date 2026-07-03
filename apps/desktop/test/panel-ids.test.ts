import { describe, it, expect } from "vitest";
import { panelIdForTab, tabIdForPanel, fixedPanelId, editorPanelId } from "../src/renderer/workspace/panel-ids.js";

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
});
