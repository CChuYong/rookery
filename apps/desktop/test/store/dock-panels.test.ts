import { describe, it, expect, beforeEach } from "vitest";
import {
  useDockPanelsStore,
  hideableKindsFor,
  rightGroupKindsFor,
  isHidden,
  isGroupOpen,
  panelToggleState,
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
  // audit #8 (intentional change): the group reads open while ANY member still shows — closing only Git used to
  // flip the toggle off while Files was on screen.
  it("isGroupOpen is true while any kind in the group is visible", () => {
    expect(isGroupOpen([], ["files", "git"])).toBe(true);
    expect(isGroupOpen(["git"], ["files", "git"])).toBe(true);
    expect(isGroupOpen(["files", "git"], ["files", "git"])).toBe(false);
    expect(isGroupOpen(["nested"], ["files", "git"])).toBe(true); // unrelated hidden kind doesn't affect this group
  });
  it("isGroupOpen does not count panels hidden by the narrow-window rule as showing", () => {
    expect(isGroupOpen([], ["files", "git"], ["files", "git"])).toBe(false);
    expect(isGroupOpen(["git"], ["files", "git"], ["files"])).toBe(false);
  });
});

// audit #4 #11: the toggle tells "closed by you" apart from "hidden because the window is narrow".
describe("panelToggleState", () => {
  it("open / closed / auto", () => {
    expect(panelToggleState([], [], ["files", "git"])).toBe("open");
    expect(panelToggleState(["files", "git"], [], ["files", "git"])).toBe("closed");
    expect(panelToggleState([], ["files", "git"], ["files", "git"])).toBe("auto");
    expect(panelToggleState(["git"], ["files"], ["files", "git"])).toBe("auto");
  });
});

describe("useDockPanelsStore", () => {
  beforeEach(() => { useDockPanelsStore.setState({ hiddenByPage: {}, autoHiddenByPage: {} }); });

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

  it("toggleGroup_ hides every kind while any member shows, shows every kind once all are hidden", () => {
    // Group fully open → toggling hides every kind in it.
    useDockPanelsStore.getState().toggleGroup_("p1", ["files", "git"]);
    expect(useDockPanelsStore.getState().hiddenByPage.p1).toEqual(["files", "git"]);
    // All hidden → toggling shows every kind.
    useDockPanelsStore.getState().toggleGroup_("p1", ["files", "git"]);
    expect(useDockPanelsStore.getState().hiddenByPage.p1).toEqual([]);
    // audit #8 (intentional change): partially hidden → toggling hides the rest instead of showing all.
    useDockPanelsStore.getState().hide_("p1", "git");
    useDockPanelsStore.getState().toggleGroup_("p1", ["files", "git"]);
    expect(useDockPanelsStore.getState().hiddenByPage.p1).toEqual(["git", "files"]);
  });

  it("toggleGroup_ on a group the narrow-window rule hid shows it and drops the auto-hidden mark (audit #4 #7)", () => {
    useDockPanelsStore.getState().setAutoHidden_("p1", ["files", "git"]);
    useDockPanelsStore.getState().toggleGroup_("p1", ["files", "git"]);
    expect(useDockPanelsStore.getState().hiddenByPage.p1).toEqual([]);
    expect(useDockPanelsStore.getState().autoHiddenByPage.p1).toEqual([]);
  });

  it("hiding a panel the user had re-opened while narrow keeps it hidden after the window grows (audit #7)", () => {
    useDockPanelsStore.getState().setAutoHidden_("p1", ["files"]);
    useDockPanelsStore.getState().hide_("p1", "files");
    expect(useDockPanelsStore.getState().autoHiddenByPage.p1).toEqual([]);
    expect(useDockPanelsStore.getState().hiddenByPage.p1).toEqual(["files"]);
  });

  it("setHidden_ replaces a page's hidden set wholesale (used to sync from actual dockview presence)", () => {
    useDockPanelsStore.getState().hide_("p1", "terminal");
    useDockPanelsStore.getState().setHidden_("p1", ["files", "nested"]);
    expect(useDockPanelsStore.getState().hiddenByPage.p1).toEqual(["files", "nested"]);
  });
});
