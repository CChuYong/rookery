import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

// Persisted fold state for the RepoTree sidebar. The sidebar conditionally renders RepoTree vs
// Sessions (App.tsx), so every tab switch unmounts the tree — component-local state would reset
// every group to "expanded". Keys are repo names plus the special "__orphans__" group; only
// collapsed(=true) keys are stored (expanded is the default, so absence means open). prune() drops
// keys whose repo no longer exists — called from the tree's render path once repos are known.
interface RepoTreeState {
  collapsed: Record<string, boolean>;
  archOpen: boolean;
  setCollapsed: (key: string, isCollapsed: boolean) => void;
  setArchOpen: (open: boolean) => void;
  prune: (validKeys: ReadonlySet<string>) => void;
}

export const useRepoTreeStore = create<RepoTreeState>()(
  persist(
    (set) => ({
      collapsed: {},
      archOpen: false,
      setCollapsed: (key, isCollapsed) =>
        set((s) => {
          if (!isCollapsed) {
            const { [key]: _drop, ...rest } = s.collapsed;
            return { collapsed: rest };
          }
          return { collapsed: { ...s.collapsed, [key]: true } };
        }),
      setArchOpen: (open) => set({ archOpen: open }),
      prune: (validKeys) =>
        set((s) => {
          const stale = Object.keys(s.collapsed).filter((k) => !validKeys.has(k));
          if (stale.length === 0) return s;
          const next = { ...s.collapsed };
          for (const k of stale) delete next[k];
          return { collapsed: next };
        }),
    }),
    {
      name: "rookery.repotree",
      version: 1,
      migrate: (persisted) => persisted as RepoTreeState,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ collapsed: s.collapsed, archOpen: s.archOpen }) as RepoTreeState,
    },
  ),
);
