import { describe, it, expect, afterEach } from "vitest";
import { createDockview, type DockviewApi } from "dockview";
import {
  groupConstraints,
  rootColumnGroupIds,
  unhideLeaves,
  applyDockConstraints,
  reopenPosition,
  hidePanels,
  isKindVisible,
  autoHideableRightGroups,
  resetDockSizes,
  INSPECTOR_DEFAULT_WIDTH,
  CONVERSATION_MIN_WIDTH,
  INSPECTOR_MAX_WIDTH,
  INSPECTOR_MIN_WIDTH,
  type SerializedGrid,
} from "../../src/renderer/workspace/dock-layout.js";
import { TERMINAL_COLLAPSED_HEIGHT } from "../../src/renderer/workspace/default-template.js";

// A real headless dockview (no React): jsdom has no layout engine, but dockview sizes its grid from layout(w, h)
// alone, so group widths/heights here are the numbers the app would get at that container size.
let apis: DockviewApi[] = [];
function dock(width = 1400, height = 900): DockviewApi {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const api = createDockview(el, {
    disableAutoResizing: true,
    createComponent: () => ({ element: document.createElement("div"), init: () => {} }),
  });
  api.layout(width, height);
  apis.push(api);
  return api;
}
afterEach(() => { for (const a of apis) a.dispose(); apis = []; document.body.innerHTML = ""; });

const add = (api: DockviewApi, kind: string, position?: object, extra: object = {}) =>
  api.addPanel({ id: `panel:${kind}`, component: kind, params: { pageKey: "p", kind }, ...(position ? { position } : {}), ...extra } as never);

// The default page: conversation, side column on the right edge, terminal below the conversation.
function seeded(api: DockviewApi): void {
  add(api, "conversation");
  add(api, "files", { direction: "right" }, { initialWidth: 320 });
  add(api, "git", { referencePanel: "panel:files", direction: "within" });
  add(api, "terminal", { referencePanel: "panel:conversation", direction: "below" }, { initialHeight: 240 });
}
const width = (api: DockviewApi, kind: string) => api.getPanel(`panel:${kind}`)!.group.api.width;
const height = (api: DockviewApi, kind: string) => api.getPanel(`panel:${kind}`)!.group.api.height;

describe("groupConstraints", () => {
  it("gives the conversation group a readable minimum, even when editors share it", () => {
    expect(groupConstraints(["conversation"], false)).toMatchObject({ minimumWidth: CONVERSATION_MIN_WIDTH, minimumHeight: 200 });
    expect(groupConstraints(["conversation", "editor"], false).minimumWidth).toBe(CONVERSATION_MIN_WIDTH);
  });
  it("caps a side column only when it is a full-height root column", () => {
    expect(groupConstraints(["files", "git"], true)).toMatchObject({ minimumWidth: INSPECTOR_MIN_WIDTH, maximumWidth: INSPECTOR_MAX_WIDTH });
    expect(groupConstraints(["files", "git"], false).maximumWidth).toBe(Number.MAX_SAFE_INTEGER);
    expect(groupConstraints(["files", "editor"], true).maximumWidth).toBe(Number.MAX_SAFE_INTEGER);
  });
  it("lets the terminal group collapse to its strip", () => {
    expect(groupConstraints(["terminal"], false).minimumHeight).toBe(TERMINAL_COLLAPSED_HEIGHT);
  });
});

describe("rootColumnGroupIds", () => {
  it("lists only leaves directly under a horizontal root", () => {
    const grid: SerializedGrid = {
      orientation: "HORIZONTAL",
      root: { type: "branch", size: 900, data: [
        { type: "branch", size: 1080, data: [{ type: "leaf", size: 660, data: { id: "1" } }, { type: "leaf", size: 240, data: { id: "2" } }] },
        { type: "leaf", size: 320, data: { id: "3" } },
      ] },
    };
    expect([...rootColumnGroupIds(grid)]).toEqual(["3"]);
    expect(rootColumnGroupIds({ ...grid, orientation: "VERTICAL" }).size).toBe(0);
  });
});

describe("applyDockConstraints", () => {
  it("dragging the side panel cannot crush the conversation (audit #1)", () => {
    const api = dock();
    seeded(api);
    applyDockConstraints(api);
    api.getPanel("panel:files")!.group.api.setSize({ width: 1350 });
    expect(width(api, "conversation")).toBeGreaterThanOrEqual(CONVERSATION_MIN_WIDTH);
    expect(width(api, "files")).toBeLessThanOrEqual(INSPECTOR_MAX_WIDTH);
  });
  it("dragging the terminal up keeps the conversation at least 200px tall (audit #1)", () => {
    const api = dock();
    seeded(api);
    applyDockConstraints(api);
    api.getPanel("panel:terminal")!.group.api.setSize({ height: 880 });
    expect(height(api, "conversation")).toBeGreaterThanOrEqual(200);
  });
  it("a wide window gives the extra room to the conversation, not the side panel (audit #3)", () => {
    const api = dock();
    seeded(api);
    applyDockConstraints(api);
    api.layout(2400, 900);
    expect(width(api, "files")).toBeLessThanOrEqual(INSPECTOR_MAX_WIDTH);
  });
  it("snaps a restored layout with a crushed conversation back inside the limits (old persisted layouts)", () => {
    const api = dock();
    seeded(api);
    api.getPanel("panel:files")!.group.api.setSize({ width: 1330 }); // no constraints yet: dockview's 100px floor
    expect(width(api, "conversation")).toBeLessThan(CONVERSATION_MIN_WIDTH);
    const saved = api.toJSON();
    const fresh = dock();
    fresh.fromJSON(saved);
    applyDockConstraints(fresh);
    expect(width(fresh, "conversation")).toBeGreaterThanOrEqual(CONVERSATION_MIN_WIDTH);
  });
});

describe("reopenPosition", () => {
  it("brings the side panel back as a full-height right column at its own width, even with a terminal under the conversation (audit #5 #6)", () => {
    const api = dock();
    seeded(api);
    applyDockConstraints(api);
    api.removePanel(api.getPanel("panel:git")!);
    api.removePanel(api.getPanel("panel:files")!);
    add(api, "files", reopenPosition("files", api), { initialWidth: 320 });
    applyDockConstraints(api);
    expect(width(api, "files")).toBe(320);
    expect(height(api, "files")).toBe(900); // full height, not split beside the conversation
    expect(width(api, "terminal")).toBe(width(api, "conversation")); // terminal stays under the conversation only
  });
  it("joins a side group that is still there", () => {
    const api = dock();
    seeded(api);
    api.removePanel(api.getPanel("panel:files")!);
    expect(reopenPosition("files", api)).toEqual({ referencePanel: "panel:git", direction: "within" });
  });
  it("puts the terminal below the conversation", () => {
    const api = dock();
    seeded(api);
    expect(reopenPosition("terminal", api)).toEqual({ referencePanel: "panel:conversation", direction: "below" });
  });
});

describe("hidePanels / visibility", () => {
  it("hiding the side group and showing it again restores its width (audit #5)", () => {
    const api = dock();
    seeded(api);
    applyDockConstraints(api);
    api.getPanel("panel:files")!.group.api.setSize({ width: 380 });
    hidePanels(api, ["files", "git"]);
    expect(isKindVisible(api, "files")).toBe(false);
    expect(width(api, "conversation")).toBe(1400);
    api.getPanel("panel:files")!.group.api.setVisible(true);
    expect(width(api, "files")).toBe(380);
  });
  it("removes a panel that shares its group with something that stays", () => {
    const api = dock();
    seeded(api);
    hidePanels(api, ["git"]);
    expect(api.getPanel("panel:git")).toBeUndefined();
    expect(isKindVisible(api, "files")).toBe(true);
  });
  it("only side-only visible groups are candidates for the narrow-window rule", () => {
    const api = dock();
    seeded(api);
    expect(autoHideableRightGroups(api).map((g) => g.panels.map((p) => p.id))).toEqual([["panel:files", "panel:git"]]);
    hidePanels(api, ["files", "git"]);
    expect(autoHideableRightGroups(api)).toEqual([]);
  });
});

describe("unhideLeaves", () => {
  it("persists a narrow-window layout with the side panel back at its width (audit #81)", () => {
    const api = dock();
    seeded(api);
    applyDockConstraints(api);
    const group = api.getPanel("panel:files")!.group;
    group.api.setVisible(false);
    const json = api.toJSON();
    const patched = { ...json, grid: unhideLeaves(json.grid as unknown as SerializedGrid, new Set([group.id])) as never };
    const fresh = dock();
    fresh.fromJSON(patched);
    expect(isKindVisible(fresh, "files")).toBe(true);
    expect(width(fresh, "files")).toBe(320);
    expect(width(fresh, "conversation")).toBe(1080);
  });
  it("leaves leaves that are not in the set alone", () => {
    const grid: SerializedGrid = { orientation: "HORIZONTAL", root: { type: "branch", size: 900, data: [
      { type: "leaf", size: 1400, data: { id: "1" } }, { type: "leaf", size: 320, visible: false, data: { id: "3" } },
    ] } };
    expect(unhideLeaves(grid, new Set(["9"]))).toEqual(grid);
  });
});

describe("resetDockSizes (audit #106)", () => {
  it("puts the side column and the terminal back to their default sizes", () => {
    const api = dock();
    seeded(api);
    applyDockConstraints(api);
    api.getPanel("panel:files")!.group.api.setSize({ width: 430 });
    api.getPanel("panel:terminal")!.group.api.setSize({ height: 600 });
    resetDockSizes(api, 240);
    expect(width(api, "files")).toBe(INSPECTOR_DEFAULT_WIDTH);
    expect(height(api, "terminal")).toBe(240);
  });
});
