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
    expect(fixedPanelTitle("nested", t)).toBe("rightSidebar.segmentWorker");
  });
  // audit #49a: the dock TAB label uses a dedicated short key, not the verbose
  // workspaceHeaders.terminalTitle ("Terminal (bottom panel)") — that copy is
  // still correct for the header toggle button's tooltip, just not for a
  // draggable dock tab sitting next to one-word siblings like "Files"/"Git".
  it("uses the short terminalTab key for the terminal panel, not the verbose terminalTitle", () => {
    expect(fixedPanelTitle("terminal", t)).toBe("workspaceHeaders.terminalTab");
  });
  it("git is a literal, non-localized label (a proper noun)", () => {
    expect(fixedPanelTitle("git", t)).toBe("Git");
  });
});
