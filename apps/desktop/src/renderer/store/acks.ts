import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

// Persisted dismissals for attention-queue items (docs/superpowers/specs/2026-07-11-attention-queue-design.md).
// Keys are the AttentionItem.key format (e.g. "wfail:<workerId>:<status>", "afail:<id>:<lastRunAt>") — a NEW
// automation failure gets a new lastRunAt and therefore a new key, so it re-surfaces past an old dismissal.
// Bounded two ways: prune() drops keys whose underlying entity no longer exists (called from the bell's render
// path with the current candidate set), and ack() caps the list at the newest MAX_ACKS as a hard backstop.
const MAX_ACKS = 300;

interface AcksState {
  acked: string[];
  ack: (key: string) => void;
  prune: (validKeys: ReadonlySet<string>) => void;
}

export const useAcksStore = create<AcksState>()(
  persist(
    (set) => ({
      acked: [],
      ack: (key) => set((s) => ({ acked: [...s.acked.filter((k) => k !== key), key].slice(-MAX_ACKS) })),
      prune: (validKeys) =>
        set((s) => {
          const next = s.acked.filter((k) => validKeys.has(k));
          return next.length === s.acked.length ? s : { acked: next };
        }),
    }),
    {
      name: "rookery.acks",
      version: 1,
      migrate: (persisted) => persisted as AcksState,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ acked: s.acked }) as AcksState,
    },
  ),
);
