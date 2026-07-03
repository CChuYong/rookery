import { describe, it, expect } from "vitest";
import { editorPanelId, fixedPanelId, conversationAgentKindPatch } from "../../src/renderer/workspace/panel-ids.js";
import { fixedPanelTitle } from "../../src/renderer/workspace/panel-titles.js";

describe("panel ids", () => {
  it("derives the editor panel id from the tab id", () => {
    expect(editorPanelId("file:/a/b.ts")).toBe("panel:editor:file:/a/b.ts");
    expect(editorPanelId("diff:/x")).toBe("panel:editor:diff:/x");
  });
  it("gives a stable id per fixed kind", () => {
    expect(fixedPanelId("conversation")).toBe("panel:conversation");
    expect(fixedPanelId("terminal")).toBe("panel:terminal");
    expect(fixedPanelId("files")).toBe("panel:files");
    expect(fixedPanelId("git")).toBe("panel:git");
    expect(fixedPanelId("nested")).toBe("panel:nested");
  });
});

// task 18 review: a restored dockview layout can carry a conversation panel
// whose params lack (or disagree with) agentKind — WorkspaceDock re-asserts
// the page's known agentKind onto it via the dockview API. This pins the
// pure decision half of that reassert, plus (via fixedPanelTitle) that the
// patched value is exactly what the live tab label resolves through.
describe("conversationAgentKindPatch", () => {
  it("re-asserts the page's agentKind when the restored panel has none (pre-agentKind layout)", () => {
    const patch = conversationAgentKindPatch(undefined, "worker");
    expect(patch).toEqual({ agentKind: "worker" });
    expect(fixedPanelTitle("conversation", (k) => k, patch?.agentKind)).toBe("app.worker");
  });
  it("re-asserts when the restored panel disagrees (stale value)", () => {
    expect(conversationAgentKindPatch({ agentKind: "master" }, "worker")).toEqual({ agentKind: "worker" });
  });
  it("is a no-op when the restored panel already matches", () => {
    expect(conversationAgentKindPatch({ agentKind: "worker" }, "worker")).toBeUndefined();
  });
});
