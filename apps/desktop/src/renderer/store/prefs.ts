import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { LocalePref } from "../i18n/types.js";

interface PrefsState {
  localePref: LocalePref;
  setLocalePref: (p: LocalePref) => void;
}

export const usePrefsStore = create<PrefsState>()(
  persist(
    (set) => ({
      localePref: "system",
      setLocalePref: (p) => set({ localePref: p }),
    }),
    {
      name: "rookery.prefs",
      version: 1,
      // v1 single version — hook for future schema changes (currently a no-op).
      migrate: (persisted) => persisted as PrefsState,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ localePref: s.localePref }) as PrefsState,
    },
  ),
);
