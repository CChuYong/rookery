import { describe, it, expect, beforeEach } from "vitest";
import {
  useDockPanelsStore,
  hideableKindsFor,
  rightGroupKindsFor,
  isHidden,
  isGroupOpen,
} from "../../src/renderer/store/dock-panels.js";

// audit #48: dock mode had no way to hide/restore the fixed Files/Git/Terminal/
// Nested panels. These pin the pure decision logic — WorkspaceDock's actual
// dockview add/remove wiring (untestable in jsdom) is covered by a live check.
describe("hideableKindsFor / rightGroupKindsFor", () => {
  it("master pages never offer the nested (Worker) panel — it's never seeded there", () => {
    expect(hideableKindsFor("master")).toEqual(["files", "git", "terminal"]);
    expect(rightGroupKindsFor("master")).toEqual(["files", "git"]);
  });
  it("worker pages include nested", () => {
    expect(hideableKindsFor("worker")).toEqual(["files", "git", "terminal", "nested"]);
    expect(rightGroupKindsFor("worker")).toEqual(["files", "git", "nested"]);
  });
});

describe("isHidden / isGroupOpen", () => {
  it("isHidden checks single membership", () => {
    expect(isHidden(["terminal"], "terminal")).toBe(true);
    expect(isHidden(["terminal"], "files")).toBe(false);
    expect(isHidden([], "files")).toBe(false);
  });
  it("isGroupOpen is true only when every kind in the group is visible", () => {
    expect(isGroupOpen([], ["files", "git"])).toBe(true);
    expect(isGroupOpen(["git"], ["files", "git"])).toBe(false);
    expect(isGroupOpen(["nested"], ["files", "git"])).toBe(true); // unrelated hidden kind doesn't affect this group
  });
});

describe("useDockPanelsStore", () => {
  beforeEach(() => { useDockPanelsStore.setState({ hiddenByPage: {} }); });

  it("hide_ adds a kind once (idempotent) scoped to its page", () => {
    useDockPanelsStore.getState().hide_("p1", "terminal");
    useDockPanelsStore.getState().hide_("p1", "terminal");
    expect(useDockPanelsStore.getState().hiddenByPage.p1).toEqual(["terminal"]);
    expect(useDockPanelsStore.getState().hiddenByPage.p2).toBeUndefined();
  });

  it("show_ removes a kind (idempotent)", () => {
    useDockPanelsStore.getState().hide_("p1", "terminal");
    useDockPanelsStore.getState().hide_("p1", "files");
    useDockPanelsStore.getState().show_("p1", "terminal");
    useDockPanelsStore.getState().show_("p1", "terminal"); // no-op, already shown
    expect(useDockPanelsStore.getState().hiddenByPage.p1).toEqual(["files"]);
  });

  it("toggle_ flips membership", () => {
    useDockPanelsStore.getState().toggle_("p1", "terminal");
    expect(useDockPanelsStore.getState().hiddenByPage.p1).toEqual(["terminal"]);
    useDockPanelsStore.getState().toggle_("p1", "terminal");
    expect(useDockPanelsStore.getState().hiddenByPage.p1).toEqual([]);
  });

  it("toggleGroup_ hides every kind when the group is fully open, shows every kind when any member is hidden", () => {
    // Group fully open → toggling hides every kind in it.
    useDockPanelsStore.getState().toggleGroup_("p1", ["files", "git"]);
    expect(useDockPanelsStore.getState().hiddenByPage.p1).toEqual(["files", "git"]);
    // Group partially hidden → toggling shows every kind in it (restores all).
    useDockPanelsStore.getState().show_("p1", "files");
    useDockPanelsStore.getState().toggleGroup_("p1", ["files", "git"]);
    expect(useDockPanelsStore.getState().hiddenByPage.p1).toEqual([]);
  });

  it("setHidden_ replaces a page's hidden set wholesale (used to sync from actual dockview presence)", () => {
    useDockPanelsStore.getState().hide_("p1", "terminal");
    useDockPanelsStore.getState().setHidden_("p1", ["files", "nested"]);
    expect(useDockPanelsStore.getState().hiddenByPage.p1).toEqual(["files", "nested"]);
  });
});
