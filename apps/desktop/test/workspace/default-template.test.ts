import { describe, it, expect } from "vitest";
import { defaultPanels, terminalSeedHeight, isTerminalGroupCollapsed, TERMINAL_COLLAPSED_HEIGHT, TERMINAL_EXPANDED_HEIGHT } from "../../src/renderer/workspace/default-template.js";

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

// audit #30: an empty terminal group shouldn't permanently occupy ~220px.
describe("terminalSeedHeight", () => {
  it("seeds collapsed (tab-strip only) when the page has no open terminals", () => {
    expect(terminalSeedHeight(0)).toBe(TERMINAL_COLLAPSED_HEIGHT);
  });
  it("seeds full height when the page already has open terminals (e.g. restored from a previous run)", () => {
    expect(terminalSeedHeight(1)).toBe(TERMINAL_EXPANDED_HEIGHT);
    expect(terminalSeedHeight(3)).toBe(TERMINAL_EXPANDED_HEIGHT);
  });
});

describe("isTerminalGroupCollapsed", () => {
  it("is true at (or just above, for rounding) the collapsed seed height", () => {
    expect(isTerminalGroupCollapsed(TERMINAL_COLLAPSED_HEIGHT)).toBe(true);
    expect(isTerminalGroupCollapsed(TERMINAL_COLLAPSED_HEIGHT + 8)).toBe(true);
  });
  it("is false once the group is clearly bigger than the seed (a user's own resize)", () => {
    expect(isTerminalGroupCollapsed(TERMINAL_COLLAPSED_HEIGHT + 9)).toBe(false);
    expect(isTerminalGroupCollapsed(TERMINAL_EXPANDED_HEIGHT)).toBe(false);
  });
});
