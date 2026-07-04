import { create } from "zustand";
import type { FixedKind } from "../workspace/panel-ids.js";

// Fixed dock panels that support being hidden — everything except the pinned
// conversation panel, which is the primary view and must always stay open
// (WorkspaceDock re-adds it if a restored/edited layout ever drops it). Named
// distinctly from FixedKind so call sites can't accidentally target the
// conversation panel through this API (audit #48).
export type HideableKind = Exclude<FixedKind, "conversation">;

// Which fixed panels exist at all for a page's agentKind — master pages never
// seed a "nested" (Worker/nested-agents) panel (see default-template.ts's
// defaultPanels), so it must never be offered as hideable/toggleable there.
export function hideableKindsFor(agentKind: "master" | "worker"): HideableKind[] {
  return agentKind === "worker" ? ["files", "git", "terminal", "nested"] : ["files", "git", "terminal"];
}

// The legacy header's single "right panel" toggle represented Files · Git ·
// (worker-only) Nested as one unit (RightSidebar's segments). Dock mode splits
// them into separate panels, but the restored header toggle still treats them
// as one group for behavioral parity with the pre-dock toggle (audit #48).
export function rightGroupKindsFor(agentKind: "master" | "worker"): HideableKind[] {
  return agentKind === "worker" ? ["files", "git", "nested"] : ["files", "git"];
}

export function isHidden(hidden: HideableKind[], kind: HideableKind): boolean {
  return hidden.includes(kind);
}

// A group toggle button reads as "on" only when every panel in the group is visible.
export function isGroupOpen(hidden: HideableKind[], kinds: HideableKind[]): boolean {
  return kinds.every((k) => !hidden.includes(k));
}

function withHidden(hidden: HideableKind[], kind: HideableKind): HideableKind[] {
  return hidden.includes(kind) ? hidden : [...hidden, kind];
}
function withShown(hidden: HideableKind[], kind: HideableKind): HideableKind[] {
  return hidden.includes(kind) ? hidden.filter((k) => k !== kind) : hidden;
}

export interface DockPanelsState {
  // Per-page set of fixed panels the user currently has hidden. NOT persisted:
  // the dockview layout JSON in useLayoutStore is the real source of truth for
  // "does this panel exist" (a closed panel is simply absent from the saved
  // JSON and stays absent on restore). This store is a live mirror — Workspace-
  // Dock re-derives it from actual panel presence right after every seed/
  // restore — that the header toggle buttons read to know what's hidden and
  // to request it be shown/hidden again (audit #48).
  hiddenByPage: Record<string, HideableKind[]>;
}
interface DockPanelsStore extends DockPanelsState {
  setHidden_: (pageKey: string, hidden: HideableKind[]) => void;
  hide_: (pageKey: string, kind: HideableKind) => void;
  show_: (pageKey: string, kind: HideableKind) => void;
  toggle_: (pageKey: string, kind: HideableKind) => void;
  toggleGroup_: (pageKey: string, kinds: HideableKind[]) => void;
}

export const useDockPanelsStore = create<DockPanelsStore>((set, get) => ({
  hiddenByPage: {},
  setHidden_: (pageKey, hidden) => set((s) => ({ hiddenByPage: { ...s.hiddenByPage, [pageKey]: hidden } })),
  hide_: (pageKey, kind) =>
    set((s) => ({ hiddenByPage: { ...s.hiddenByPage, [pageKey]: withHidden(s.hiddenByPage[pageKey] ?? [], kind) } })),
  show_: (pageKey, kind) =>
    set((s) => ({ hiddenByPage: { ...s.hiddenByPage, [pageKey]: withShown(s.hiddenByPage[pageKey] ?? [], kind) } })),
  toggle_: (pageKey, kind) => {
    const hidden = get().hiddenByPage[pageKey] ?? [];
    (isHidden(hidden, kind) ? get().show_ : get().hide_)(pageKey, kind);
  },
  toggleGroup_: (pageKey, kinds) => {
    const hidden = get().hiddenByPage[pageKey] ?? [];
    const action = isGroupOpen(hidden, kinds) ? get().hide_ : get().show_;
    for (const kind of kinds) action(pageKey, kind);
  },
}));
