import type { AddPanelPositionOptions, DockviewApi, DockviewGroupPanel, IDockviewPanel } from "dockview";
import type { FixedKind } from "./panel-ids.js";
import { TERMINAL_COLLAPSED_HEIGHT } from "./default-template.js";

// Size rules for the workspace dock (audit #1 #3 #5 #6). Everything here works on a DockviewApi or on plain
// serialized JSON, with no React, so it can be tested against a real headless dockview in jsdom.

export const CONVERSATION_MIN_WIDTH = 360;
export const CONVERSATION_MIN_HEIGHT = 200;
export const EDITOR_MIN_WIDTH = 240;
export const EDITOR_MIN_HEIGHT = 120;
export const INSPECTOR_MIN_WIDTH = 220;
export const INSPECTOR_MIN_HEIGHT = 120;
// The Files / Git / Activity column never grows past this on its own, so a wide window gives the extra room to the
// conversation and editors instead of a mostly empty side panel (audit #3).
export const INSPECTOR_MAX_WIDTH = 440;
export const INSPECTOR_DEFAULT_WIDTH = 320;
const UNBOUNDED = Number.MAX_SAFE_INTEGER;

export type DockKind = FixedKind | "editor";
export type RightKind = "files" | "git" | "nested";
export const RIGHT_KINDS: readonly RightKind[] = ["files", "git", "nested"];

export function isRightKind(kind: DockKind): kind is RightKind {
  return (RIGHT_KINDS as readonly string[]).includes(kind);
}

export interface GroupConstraints {
  minimumWidth: number;
  minimumHeight: number;
  maximumWidth: number;
  maximumHeight: number;
}

const KIND_MINIMUMS: Record<DockKind, { w: number; h: number }> = {
  conversation: { w: CONVERSATION_MIN_WIDTH, h: CONVERSATION_MIN_HEIGHT },
  editor: { w: EDITOR_MIN_WIDTH, h: EDITOR_MIN_HEIGHT },
  files: { w: INSPECTOR_MIN_WIDTH, h: INSPECTOR_MIN_HEIGHT },
  git: { w: INSPECTOR_MIN_WIDTH, h: INSPECTOR_MIN_HEIGHT },
  nested: { w: INSPECTOR_MIN_WIDTH, h: INSPECTOR_MIN_HEIGHT },
  terminal: { w: INSPECTOR_MIN_WIDTH, h: TERMINAL_COLLAPSED_HEIGHT },
};

// Constraints for one dock group from the kinds of panels it holds. Minimums are the largest of its panels, so an
// editor tab sharing the conversation group still keeps the conversation readable. The maximum width applies only
// to a group of inspector panels that forms a full-height column of the root: capping a group stacked inside a
// column would cap the whole column (dockview takes the smallest child maximum).
export function groupConstraints(kinds: DockKind[], rootColumn: boolean): GroupConstraints {
  if (kinds.length === 0) return { minimumWidth: 100, minimumHeight: 100, maximumWidth: UNBOUNDED, maximumHeight: UNBOUNDED };
  const minimumWidth = Math.max(...kinds.map((k) => KIND_MINIMUMS[k].w));
  const minimumHeight = Math.max(...kinds.map((k) => KIND_MINIMUMS[k].h));
  const maximumWidth = rootColumn && kinds.every(isRightKind) ? INSPECTOR_MAX_WIDTH : UNBOUNDED;
  return { minimumWidth, minimumHeight, maximumWidth, maximumHeight: UNBOUNDED };
}

// Minimal shape of dockview's serialized grid (SerializedDockview["grid"]).
export interface GridLeaf { type: "leaf"; data: { id: string; views?: string[] } & Record<string, unknown>; size: number; visible?: boolean }
export interface GridBranch { type: "branch"; data: GridNode[]; size: number; visible?: boolean }
export type GridNode = GridLeaf | GridBranch;
export interface SerializedGrid { root: GridNode; orientation: string; width?: number; height?: number }

// Group ids that sit directly in a horizontal root with at least one sibling, i.e. full-height columns.
export function rootColumnGroupIds(grid: SerializedGrid): Set<string> {
  const ids = new Set<string>();
  const root = grid.root;
  if (grid.orientation !== "HORIZONTAL" || root.type !== "branch" || root.data.length < 2) return ids;
  for (const child of root.data) if (child.type === "leaf") ids.add(child.data.id);
  return ids;
}

// The `sizeFor` for unhideLeaves when saving: the remembered side width applies only to full-height root columns
// (a stacked side group's saved size is a height, final review #7).
export function sideWidthOverride(grid: SerializedGrid, width: number): (groupId: string) => number | undefined {
  const rootColumns = rootColumnGroupIds(grid);
  return (groupId) => (rootColumns.has(groupId) ? width : undefined);
}

// Copy of a serialized grid with the given leaves shown again. Used to persist a layout while the narrow-window
// rule has hidden the side panel: the saved layout keeps the panel at its own width, and the largest visible
// sibling gives that width back so the branch still adds up (audit #81). `sizeFor` may override the saved size of a
// leaf being shown — the side column is saved at the width the user chose, not the width the shrink squeezed it to.
export function unhideLeaves(grid: SerializedGrid, groupIds: ReadonlySet<string>, sizeFor?: (groupId: string) => number | undefined): SerializedGrid {
  if (groupIds.size === 0) return grid;
  const visit = (node: GridNode): GridNode => {
    if (node.type === "leaf") return node;
    const children = node.data.map(visit);
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      if (child.type !== "leaf" || child.visible !== false || !groupIds.has(child.data.id)) continue;
      const { visible: _hidden, ...rest } = child;
      const shown = { ...rest, size: sizeFor?.(child.data.id) ?? rest.size };
      children[i] = shown;
      let largest = -1;
      for (let j = 0; j < children.length; j++) {
        if (j === i || children[j]!.visible === false) continue;
        if (largest === -1 || children[j]!.size > children[largest]!.size) largest = j;
      }
      if (largest !== -1) {
        const sibling = children[largest]!;
        children[largest] = { ...sibling, size: Math.max(0, sibling.size - shown.size) } as GridNode;
      }
    }
    return { ...node, data: children };
  };
  return { ...grid, root: visit(grid.root) };
}

export function panelKind(panel: IDockviewPanel): DockKind {
  const kind = (panel.params as { kind?: DockKind } | undefined)?.kind;
  if (kind) return kind;
  return panel.id.startsWith("panel:editor:") ? "editor" : (panel.id.slice("panel:".length) as DockKind);
}

function gridGroups(api: DockviewApi): DockviewGroupPanel[] {
  return api.groups.filter((g) => g.api.location.type === "grid");
}

// Apply groupConstraints to every grid group and relayout when anything changed, so a layout restored with a
// crushed conversation (or a side panel stretched to half the window) snaps back inside the limits.
export function applyDockConstraints(api: DockviewApi): void {
  const columns = rootColumnGroupIds(api.toJSON().grid as unknown as SerializedGrid);
  let changed = false;
  for (const group of gridGroups(api)) {
    const next = groupConstraints(group.panels.map(panelKind), columns.has(group.id));
    if (group.minimumWidth === next.minimumWidth && group.minimumHeight === next.minimumHeight && group.maximumWidth === next.maximumWidth && group.maximumHeight === next.maximumHeight) continue;
    group.api.setConstraints(next);
    changed = true;
  }
  if (changed && api.width > 0 && api.height > 0) api.layout(api.width, api.height, true);
}

// Where a fixed panel goes when it comes back after being closed. Side panels join an existing side group if one
// is left, otherwise they open as a new full-height column on the right edge of the whole dock — never next to the
// conversation inside its column, which is what split the space in half when a terminal sat below it (audit #5 #6).
// The terminal goes below the conversation.
export function reopenPosition(kind: Exclude<FixedKind, "conversation">, api: DockviewApi): AddPanelPositionOptions {
  if (isRightKind(kind)) {
    const sibling = RIGHT_KINDS.map((k) => api.getPanel(`panel:${k}`)).find((p) => p && p.group.api.location.type === "grid" && p.group.api.isVisible);
    if (sibling) return { referencePanel: sibling.id, direction: "within" };
    return { direction: "right" };
  }
  const conversation = api.getPanel("panel:conversation");
  return conversation ? { referencePanel: conversation.id, direction: "below" } : { direction: "below" };
}

// A panel counts as shown when it exists in a visible group.
export function isKindVisible(api: DockviewApi, kind: FixedKind): boolean {
  const panel = api.getPanel(`panel:${kind}`);
  return !!panel && panel.group.api.isVisible;
}

// Hide panels: a group made only of the requested panels is hidden as a whole, so it keeps its place and size and
// comes back exactly as it was. A panel that shares a group with anything else is removed instead.
export function hidePanels(api: DockviewApi, kinds: readonly FixedKind[]): void {
  const wanted = new Set<string>(kinds.map((k) => `panel:${k}`));
  const groups = new Set<DockviewGroupPanel>();
  for (const id of wanted) {
    const panel = api.getPanel(id);
    if (panel) groups.add(panel.group);
  }
  for (const group of groups) {
    if (group.panels.every((p) => wanted.has(p.id))) {
      if (group.api.isVisible) group.api.setVisible(false);
    } else {
      for (const p of [...group.panels]) if (wanted.has(p.id)) api.removePanel(p);
    }
  }
}

// Groups the narrow-window rule may hide: visible groups that hold only side panels.
export function autoHideableRightGroups(api: DockviewApi): DockviewGroupPanel[] {
  return gridGroups(api).filter((g) => g.api.isVisible && g.panels.length > 0 && g.panels.every((p) => isRightKind(panelKind(p))));
}

// Double-click on a dock sash (audit #106): a sash between columns puts the side column back to its default width,
// a sash between rows puts the terminal back to its default height — only the dimension that sash controls.
export function resetDockSizes(api: DockviewApi, terminalHeight: number, axis: "width" | "height"): void {
  for (const group of gridGroups(api)) {
    if (!group.api.isVisible || group.panels.length === 0) continue;
    const kinds = group.panels.map(panelKind);
    if (axis === "width" && kinds.every(isRightKind)) group.api.setSize({ width: INSPECTOR_DEFAULT_WIDTH });
    else if (axis === "height" && kinds.every((k) => k === "terminal")) group.api.setSize({ height: terminalHeight });
  }
}

// The side column: the visible full-height root column holding only side panels.
function sideColumnGroup(api: DockviewApi): DockviewGroupPanel | undefined {
  const columns = rootColumnGroupIds(api.toJSON().grid as unknown as SerializedGrid);
  return gridGroups(api).find((g) => columns.has(g.id) && g.api.isVisible && g.panels.length > 0 && g.panels.every((p) => isRightKind(panelKind(p))));
}

export function sideColumnWidth(api: DockviewApi): number | undefined {
  return sideColumnGroup(api)?.api.width;
}

// Put the side column at a width (clamped by its constraints). Used to restore the width the user chose after a
// shrink squeezed it (review fix 1).
export function setSideColumnWidth(api: DockviewApi, width: number): void {
  const group = sideColumnGroup(api);
  if (group && Math.abs(group.api.width - width) > 1) group.api.setSize({ width });
}

const SIDE_IDS = new Set(RIGHT_KINDS.map((k) => `panel:${k}`));

// The side column's width as saved in a layout (its root-column leaf size), or undefined if there is none.
export function savedSideColumnWidth(grid: SerializedGrid): number | undefined {
  const columns = rootColumnGroupIds(grid);
  if (grid.root.type !== "branch") return undefined;
  for (const child of grid.root.data) {
    if (child.type !== "leaf" || !columns.has(child.data.id)) continue;
    const views = child.data.views ?? [];
    if (views.length > 0 && views.every((id) => SIDE_IDS.has(id))) return child.size;
  }
  return undefined;
}

// The narrowest dock that fits every column at its minimum, side column included (hidden or not) — the
// narrow-window rule must hide the side column below this, not only below a fixed width (review fix 8).
export function requiredDockWidth(api: DockviewApi): number {
  const grid = api.toJSON().grid as unknown as SerializedGrid;
  const minOf = new Map(api.groups.map((g) => [g.id, g.minimumWidth] as const));
  const visit = (node: GridNode, horizontal: boolean): number => {
    if (node.type === "leaf") return minOf.get(node.data.id) ?? 0;
    const widths = node.data.map((c) => visit(c, !horizontal));
    return horizontal ? widths.reduce((a, b) => a + b, 0) : Math.max(0, ...widths);
  };
  return visit(grid.root, grid.orientation === "HORIZONTAL");
}
