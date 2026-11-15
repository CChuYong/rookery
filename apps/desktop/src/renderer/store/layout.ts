import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { rootColumnGroupIds, type GridNode, type SerializedGrid } from "../workspace/dock-layout.js";

// Per-page serialized dockview layout (SerializedDockview stored as opaque JSON).
// Mirrors the per-pageKey model of store/terminals.ts. The dockview arrangement
// for each master session / worker page is saved here and restored on revisit.
export interface LayoutState {
  byPage: Record<string, unknown>;
}

const SIDE_PANEL_IDS = new Set(["panel:files", "panel:git", "panel:nested"]);

// v1 → v2 migration test (audit #5 #6): before the fix, re-opening the side panel could nest it beside the
// conversation inside the conversation's column (half the width, terminal stretched under both), and that shape was
// saved. A layout is kept only if every group holding a side panel is a full-height root column; anything else —
// including unreadable JSON — is dropped so the page reseeds the default layout once.
export function isSaneLayout(json: unknown): boolean {
  const grid = (json as { grid?: SerializedGrid } | null)?.grid;
  if (!grid || typeof grid !== "object" || !grid.root) return false;
  const columns = rootColumnGroupIds(grid);
  const ok = (node: GridNode): boolean => {
    if (!node || typeof node !== "object") return false;
    if (node.type === "branch") return Array.isArray(node.data) && node.data.every(ok);
    const views = Array.isArray(node.data?.views) ? node.data.views : [];
    return !views.some((id) => SIDE_PANEL_IDS.has(id)) || columns.has(node.data.id);
  };
  return ok(grid.root);
}

export function migrateLayoutState(persisted: unknown, version: number): LayoutState {
  const byPage = (persisted as Partial<LayoutState> | undefined)?.byPage ?? {};
  if (version >= 2) return { byPage };
  const kept: LayoutState["byPage"] = {};
  for (const [k, v] of Object.entries(byPage)) if (isSaneLayout(v)) kept[k] = v;
  return { byPage: kept };
}

export function emptyLayoutState(): LayoutState {
  return { byPage: {} };
}

export function saveLayout(s: LayoutState, key: string, json: unknown): LayoutState {
  return { ...s, byPage: { ...s.byPage, [key]: json } };
}

export function clearLayout(s: LayoutState, key: string): LayoutState {
  const byPage = { ...s.byPage };
  delete byPage[key];
  return { ...s, byPage };
}

// Drop layouts whose page key is no longer known (dead sessions/workers) — parity with pruneWsPages/pruneLayout.
export function pruneLayouts(s: LayoutState, known: Set<string>): LayoutState {
  const byPage: LayoutState["byPage"] = {};
  for (const [k, v] of Object.entries(s.byPage)) if (known.has(k)) byPage[k] = v;
  return { ...s, byPage };
}

interface LayoutStore extends LayoutState {
  // Not persisted: a per-page counter WorkspaceDock watches to wipe and reseed its live dock. A counter (not the
  // saved -> cleared transition) so Reset works even when the page has no saved layout yet (audit #81).
  resetSeq: Record<string, number>;
  save_: (key: string, json: unknown) => void;
  clear_: (key: string) => void;
  reset_: (key: string) => void;
  prune_: (known: Set<string>) => void;
}

export const useLayoutStore = create<LayoutStore>()(
  persist(
    (set) => ({
      ...emptyLayoutState(),
      resetSeq: {},
      save_: (key, json) => set((s) => saveLayout(s, key, json)),
      clear_: (key) => set((s) => clearLayout(s, key)),
      reset_: (key) => set((s) => ({ ...clearLayout(s, key), resetSeq: { ...s.resetSeq, [key]: (s.resetSeq[key] ?? 0) + 1 } })),
      prune_: (known) => set((s) => pruneLayouts(s, known)),
    }),
    {
      name: "rookery.layout",
      version: 2,
      storage: createJSONStorage(() => localStorage),
      // Backfill missing fields so a partial persist isn't discarded (same guard as store/workspace.ts), and drop
      // v1 layouts saved in the broken half-width shape (see isSaneLayout).
      migrate: (persisted, version) => migrateLayoutState(persisted, version),
      partialize: (s) => ({ byPage: s.byPage }),
    },
  ),
);
