import { describe, it, expect } from "vitest";
import { defaultPanels } from "../../src/renderer/workspace/default-template.js";

describe("default template", () => {
  it("seeds the core panels in order for a worker page", () => {
    expect(defaultPanels("worker").map((x) => x.kind)).toEqual(["conversation", "files", "git", "terminal"]);
  });
  it("anchors the conversation in the center", () => {
    expect(defaultPanels("master")[0]).toEqual({ kind: "conversation", position: "center" });
  });
  it("does not seed a nested panel (added on demand)", () => {
    expect(defaultPanels("worker").map((x) => String(x.kind))).not.toContain("nested");
  });
});
