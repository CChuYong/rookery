import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export interface TermTab { id: string; title: string; exited: boolean }
// Terminal state for a single "agent page" (master session or a specific worker). Both open and tabs are scoped to the page → independent across page switches.
export interface TermPage { tabs: TermTab[]; activeTabId: string | null; open: boolean }
export interface TermState {
  byPage: Record<string, TermPage>;
  layout: Record<string, { count: number; open: boolean }>; // persisted — for restore on restart (count + open)
  height: number; // drawer height is a layout preference → shared globally
}

const CAP = 8;
const MIN_H = 120;
const MAX_H = 800;

const emptyPage = (): TermPage => ({ tabs: [], activeTabId: null, open: false });
export function emptyTermState(): TermState {
  return { byPage: {}, layout: {}, height: 280 };
}

function page(s: TermState, key: string): TermPage {
  return s.byPage[key] ?? emptyPage();
}
function put(s: TermState, key: string, next: TermPage): TermState {
  return { ...s, byPage: { ...s.byPage, [key]: next } };
}

export function openTab(s: TermState, key: string, t: TermTab): TermState {
  const cur = page(s, key);
  if (cur.tabs.length >= CAP || cur.tabs.some((x) => x.id === t.id)) return s;
  return put(s, key, { ...cur, tabs: [...cur.tabs, t], activeTabId: t.id });
}

export function closeTab(s: TermState, key: string, id: string): TermState {
  const cur = page(s, key);
  const idx = cur.tabs.findIndex((x) => x.id === id);
  if (idx === -1) return s;
  const tabs = cur.tabs.filter((x) => x.id !== id);
  const activeTabId = cur.activeTabId === id ? (tabs[idx] ?? tabs[idx - 1] ?? tabs[0])?.id ?? null : cur.activeTabId;
  return put(s, key, { ...cur, tabs, activeTabId });
}

export function setActiveTab(s: TermState, key: string, id: string): TermState {
  return put(s, key, { ...page(s, key), activeTabId: id });
}

export function markExited(s: TermState, key: string, id: string): TermState {
  const cur = page(s, key);
  return put(s, key, { ...cur, tabs: cur.tabs.map((t) => (t.id === id ? { ...t, exited: true } : t)) });
}

export function setTabs(s: TermState, key: string, tabs: TermTab[]): TermState {
  const cur = page(s, key);
  const activeTabId = tabs.some((t) => t.id === cur.activeTabId) ? cur.activeTabId : (tabs[0]?.id ?? null);
  return put(s, key, { ...cur, tabs, activeTabId });
}

export function toggleOpen(s: TermState, key: string): TermState {
  const cur = page(s, key);
  return put(s, key, { ...cur, open: !cur.open });
}

export function setHeight(s: TermState, h: number): TermState {
  return { ...s, height: Math.max(MIN_H, Math.min(MAX_H, h)) };
}

export function deriveLayout(page: TermPage): { count: number; open: boolean } {
  return { count: page.tabs.filter((t) => !t.exited).length, open: page.open };
}
export function setLayout(s: TermState, key: string): TermState {
  return { ...s, layout: { ...s.layout, [key]: deriveLayout(page(s, key)) } };
}
export function setDrawerOpen(s: TermState, key: string, open: boolean): TermState {
  return put(s, key, { ...page(s, key), open });
}
export function pruneLayout(s: TermState, knownKeys: Set<string>): TermState {
  const next: TermState["layout"] = {};
  for (const [k, v] of Object.entries(s.layout)) if (knownKeys.has(k)) next[k] = v;
  return { ...s, layout: next };
}

// zustand wrapper — exposes the pure reducers to the UI. Every action takes a pageKey and is scoped to that page.
interface TermStore extends TermState {
  open_: (key: string, t: TermTab) => void;
  close_: (key: string, id: string) => void;
  setActive_: (key: string, id: string) => void;
  markExit_: (key: string, id: string) => void;
  setTabs_: (key: string, tabs: TermTab[]) => void;
  toggleOpen_: (key: string) => void;
  setOpen_: (key: string, open: boolean) => void;
  setHeight_: (h: number) => void;
}
export const useTermStore = create<TermStore>()(
  persist(
    (set) => ({
      ...emptyTermState(),
      open_: (key, t) => set((s) => setLayout(openTab(s, key, t), key)),
      close_: (key, id) => set((s) => setLayout(closeTab(s, key, id), key)),
      setActive_: (key, id) => set((s) => setActiveTab(s, key, id)),
      markExit_: (key, id) => set((s) => setLayout(markExited(s, key, id), key)),
      setTabs_: (key, tabs) => set((s) => setLayout(setTabs(s, key, tabs), key)),
      toggleOpen_: (key) => set((s) => setLayout(toggleOpen(s, key), key)),
      setOpen_: (key, open) => set((s) => setLayout(setDrawerOpen(s, key, open), key)),
      setHeight_: (h) => set((s) => setHeight(s, h)),
    }),
    {
      name: "rookery.term",
      version: 1,
      // single v1 version — hook reserved for future schema changes (currently a no-op).
      migrate: (persisted) => persisted as { layout: TermState["layout"]; height: number },
      storage: createJSONStorage(() => localStorage),
      // live byPage (includes PTY ids) is volatile — persist only layout (count + open) + height. App restores by spawning fresh shells.
      partialize: (s) => ({ layout: s.layout, height: s.height }),
    },
  ),
);
