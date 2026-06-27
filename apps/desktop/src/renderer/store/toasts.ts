import { create } from "zustand";

// In-app toast layer. The renderer had no feedback surface, so ~all mutating actions failed silently (.catch(()=>{})).
// This is the single place failure (and a few success) signals surface. Volume policy lives here (pure): coalesce
// identical kind+text so a repeated failure doesn't stack, and cap the visible count so an uncapped fleet can't flood the
// corner. Auto-expire + pause-on-hover are the <Toaster>'s job (per-toast timers).
export type ToastKind = "error" | "success" | "info";
export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
  detail?: string;
}

const MAX_VISIBLE = 4;

interface ToastStore {
  toasts: Toast[];
  push: (t: Omit<Toast, "id">) => number;
  dismiss: (id: number) => void;
}

let seq = 0; // monotonic id (module-local, not Date/random — stable across re-renders)

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  push: (t) => {
    const id = ++seq;
    set((s) => {
      // coalesce: drop any showing toast with the same kind+text (the new one replaces it) → repeated failures don't stack.
      const deduped = s.toasts.filter((x) => !(x.kind === t.kind && x.text === t.text));
      // cap: keep only the most recent MAX_VISIBLE so a burst (e.g. many workers failing) can't fill the screen.
      return { toasts: [...deduped, { ...t, id }].slice(-MAX_VISIBLE) };
    });
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

// Imperative facade usable outside React (App's request callbacks / non-component modules).
export const toast = {
  error: (text: string, detail?: string): number => useToastStore.getState().push({ kind: "error", text, detail }),
  success: (text: string): number => useToastStore.getState().push({ kind: "success", text }),
  info: (text: string): number => useToastStore.getState().push({ kind: "info", text }),
};
