import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

// Keep unsent Composer drafts per page (= session id / worker id).
// The Composer is uncontrolled (its own state + contenteditable DOM), so its contents are lost when it unmounts on tab/session switch →
// lifting the serialized draft up here and persisting it lets it survive tab switches, session switches, and reloads.
export interface DraftState {
  byPage: Record<string, string>;
}

export function emptyDraftState(): DraftState {
  return { byPage: {} };
}

// Save a draft. An empty string removes the entry — so we don't hold onto empty drafts (cleanly cleared on send/clear).
export function setDraft(s: DraftState, key: string, text: string): DraftState {
  if (!text) {
    if (!(key in s.byPage)) return s;
    const byPage = { ...s.byPage };
    delete byPage[key];
    return { ...s, byPage };
  }
  return { ...s, byPage: { ...s.byPage, [key]: text } };
}

// Remove drafts not in the known page keys (session ids ∪ live worker ids) — prevents dead-worker drafts from piling up (same convention as pruneWsPages).
export function pruneDrafts(s: DraftState, knownKeys: Set<string>): DraftState {
  const byPage: DraftState["byPage"] = {};
  for (const [k, v] of Object.entries(s.byPage)) if (knownKeys.has(k)) byPage[k] = v;
  return { ...s, byPage };
}

interface DraftStore extends DraftState {
  setDraft_: (key: string, text: string) => void;
}

export const useDraftStore = create<DraftStore>()(
  persist(
    (set) => ({
      ...emptyDraftState(),
      setDraft_: (key, text) => set((s) => setDraft(s, key, text)),
    }),
    {
      name: "rookery.drafts",
      version: 1,
      // Guard against partial persisted state: fill in missing fields with defaults (prevents zustand from discarding persisted state on version mismatch).
      migrate: (persisted) => {
        const p = persisted as Partial<DraftState> | undefined;
        return { byPage: p?.byPage ?? {} };
      },
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ byPage: s.byPage }),
    },
  ),
);
