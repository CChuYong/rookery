import { describe, it, expect } from "vitest";
import { defaultPanels } from "../../src/renderer/workspace/default-template.js";

describe("default template", () => {
  it("seeds the core panels for a worker page (incl. nested)", () => {
    expect(defaultPanels("worker").map((x) => x.kind)).toEqual(["conversation", "files", "git", "terminal", "nested"]);
  });
  it("master has no nested panel", () => {
    expect(defaultPanels("master").map((x) => x.kind)).toEqual(["conversation", "files", "git", "terminal"]);
  });
  it("conversation is the root (no anchor); files anchor right of it; git stacks within files", () => {
    const p = defaultPanels("master");
    expect(p[0]).toEqual({ kind: "conversation" });
    expect(p[1]).toEqual({ kind: "files", anchor: "conversation", direction: "right" });
    expect(p[2]).toEqual({ kind: "git", anchor: "files", direction: "within" });
  });
});
