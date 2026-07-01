import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

// Per-page serialized dockview layout (SerializedDockview stored as opaque JSON).
// Mirrors the per-pageKey model of store/terminals.ts. The dockview arrangement
// for each master session / worker page is saved here and restored on revisit.
export interface LayoutState {
  byPage: Record<string, unknown>;
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
  save_: (key: string, json: unknown) => void;
  clear_: (key: string) => void;
  prune_: (known: Set<string>) => void;
}

export const useLayoutStore = create<LayoutStore>()(
  persist(
    (set) => ({
      ...emptyLayoutState(),
      save_: (key, json) => set((s) => saveLayout(s, key, json)),
      clear_: (key) => set((s) => clearLayout(s, key)),
      prune_: (known) => set((s) => pruneLayouts(s, known)),
    }),
    {
      name: "rookery.layout",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      // Backfill missing fields so a partial persist isn't discarded (same guard as store/workspace.ts).
      migrate: (persisted) => ({ byPage: (persisted as Partial<LayoutState> | undefined)?.byPage ?? {} }),
      partialize: (s) => ({ byPage: s.byPage }),
    },
  ),
);
