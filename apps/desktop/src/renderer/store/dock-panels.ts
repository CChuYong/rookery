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

// A group toggle button reads as "on" while any panel of the group is still showing, and a click then hides the
// group (audit #8: closing only the Git tab used to flip the toggle to "off" while Files was still on screen, and the
// next click showed everything instead of hiding it). `autoHidden` panels — hidden by the narrow-window rule, not by
// the user — don't count as showing.
export function isGroupOpen(hidden: HideableKind[], kinds: HideableKind[], autoHidden: HideableKind[] = []): boolean {
  return kinds.some((k) => !hidden.includes(k) && !autoHidden.includes(k));
}

// Three-way state for a header panel toggle (audit #4 #11): "open", "closed" by the user, or "auto" — hidden only
// because the window is too narrow, which the toggle must say instead of looking like the user turned it off.
export type PanelToggleState = "open" | "closed" | "auto";
export function panelToggleState(hidden: HideableKind[], autoHidden: HideableKind[], kinds: HideableKind[]): PanelToggleState {
  if (isGroupOpen(hidden, kinds, autoHidden)) return "open";
  return kinds.some((k) => autoHidden.includes(k) && !hidden.includes(k)) ? "auto" : "closed";
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
  // Per-page panels the narrow-window rule hid (WorkspaceDock owns these writes). Kept apart from the user's own
  // hidden set so the toggles can tell the two apart and growing the window back restores only these (audit #4 #7).
  autoHiddenByPage: Record<string, HideableKind[]>;
}
interface DockPanelsStore extends DockPanelsState {
  setHidden_: (pageKey: string, hidden: HideableKind[]) => void;
  setAutoHidden_: (pageKey: string, autoHidden: HideableKind[]) => void;
  hide_: (pageKey: string, kind: HideableKind) => void;
  show_: (pageKey: string, kind: HideableKind) => void;
  toggle_: (pageKey: string, kind: HideableKind) => void;
  toggleGroup_: (pageKey: string, kinds: HideableKind[]) => void;
}

export const useDockPanelsStore = create<DockPanelsStore>((set, get) => ({
  hiddenByPage: {},
  autoHiddenByPage: {},
  setHidden_: (pageKey, hidden) => set((s) => ({ hiddenByPage: { ...s.hiddenByPage, [pageKey]: hidden } })),
  setAutoHidden_: (pageKey, autoHidden) => set((s) => ({ autoHiddenByPage: { ...s.autoHiddenByPage, [pageKey]: autoHidden } })),
  hide_: (pageKey, kind) =>
    set((s) => ({
      hiddenByPage: { ...s.hiddenByPage, [pageKey]: withHidden(s.hiddenByPage[pageKey] ?? [], kind) },
      autoHiddenByPage: { ...s.autoHiddenByPage, [pageKey]: withShown(s.autoHiddenByPage[pageKey] ?? [], kind) },
    })),
  // Showing a panel is an explicit user choice, so it also overrides the narrow-window rule for that panel.
  show_: (pageKey, kind) =>
    set((s) => ({
      hiddenByPage: { ...s.hiddenByPage, [pageKey]: withShown(s.hiddenByPage[pageKey] ?? [], kind) },
      autoHiddenByPage: { ...s.autoHiddenByPage, [pageKey]: withShown(s.autoHiddenByPage[pageKey] ?? [], kind) },
    })),
  toggle_: (pageKey, kind) => {
    const hidden = get().hiddenByPage[pageKey] ?? [];
    (isHidden(hidden, kind) ? get().show_ : get().hide_)(pageKey, kind);
  },
  // One store write for the whole group, so the dock reconciles the group in a single pass (hiding it as a unit
  // keeps its place and width instead of removing panels one by one).
  toggleGroup_: (pageKey, kinds) =>
    set((s) => {
      const hidden = s.hiddenByPage[pageKey] ?? [];
      const auto = s.autoHiddenByPage[pageKey] ?? [];
      const open = isGroupOpen(hidden, kinds, auto);
      return {
        hiddenByPage: { ...s.hiddenByPage, [pageKey]: kinds.reduce(open ? withHidden : withShown, hidden) },
        autoHiddenByPage: { ...s.autoHiddenByPage, [pageKey]: kinds.reduce(withShown, auto) },
      };
    }),
}));
