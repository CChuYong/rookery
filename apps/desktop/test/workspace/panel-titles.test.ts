import { describe, it, expect } from "vitest";
import { fixedPanelTitle } from "../../src/renderer/workspace/panel-titles.js";

// Identity translator — this test only cares about WHICH key is picked, not the
// rendered copy (parity is enforced separately by the i18n catalog tests).
const t = (key: string): string => key;

// audit #29: WorkspaceDock.titleFor (addPanel-time, persisted) and RookeryTab
// (live, per-render) must resolve fixed-panel labels through the exact same
// keys — this pins that shared mapping.
describe("fixedPanelTitle", () => {
  it("picks the master/worker key for the conversation panel", () => {
    expect(fixedPanelTitle("conversation", t, "master")).toBe("app.master");
    expect(fixedPanelTitle("conversation", t, "worker")).toBe("app.worker");
  });
  it("defaults conversation to master when agentKind is omitted", () => {
    expect(fixedPanelTitle("conversation", t)).toBe("app.master");
  });
  it("maps the other fixed kinds regardless of agentKind", () => {
    expect(fixedPanelTitle("files", t)).toBe("rightSidebar.segmentFiles");
    expect(fixedPanelTitle("terminal", t)).toBe("workspaceHeaders.terminalTitle");
    expect(fixedPanelTitle("nested", t)).toBe("rightSidebar.segmentWorker");
  });
  it("git is a literal, non-localized label (a proper noun)", () => {
    expect(fixedPanelTitle("git", t)).toBe("Git");
  });
});
