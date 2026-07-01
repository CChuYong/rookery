import { describe, it, expect } from "vitest";
import { editorPanelId, fixedPanelId } from "../../src/renderer/workspace/panel-ids.js";

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
