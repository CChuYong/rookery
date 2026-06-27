import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { basename } from "../lib/basename.js";
import { ancestorDirs } from "../lib/filetree-model.js";

export type Tab =
  | { id: "agent"; kind: "agent" }
  | { id: string; kind: "file"; path: string; title: string; dirty: boolean }
  | { id: string; kind: "diff"; path: string; title: string }
  | { id: string; kind: "commit"; hash: string; title: string };

export interface WsPage { tabs: Tab[]; activeTabId: string }
export interface RightState { open: boolean; width: number; segment: "files" | "git" | "worker" }
export interface WsState { byPage: Record<string, WsPage>; right: RightState; expandedByPage: Record<string, string[]> }

const RW_MIN = 200;
const RW_MAX = 560;
const AGENT: Tab = { id: "agent", kind: "agent" };

export function emptyWsState(): WsState {
  return { byPage: {}, right: { open: false, width: 300, segment: "files" }, expandedByPage: {} };
}
function page(s: WsState, key: string): WsPage {
  return s.byPage[key] ?? { tabs: [AGENT], activeTabId: "agent" };
}
function put(s: WsState, key: string, next: WsPage): WsState {
  return { ...s, byPage: { ...s.byPage, [key]: next } };
}

export function openFile(s: WsState, key: string, path: string): WsState {
  const cur = page(s, key);
  const id = `file:${path}`;
  if (cur.tabs.some((t) => t.id === id)) return put(s, key, { ...cur, activeTabId: id });
  const tab: Tab = { id, kind: "file", path, title: basename(path), dirty: false };
  return put(s, key, { tabs: [...cur.tabs, tab], activeTabId: id });
}

export function openDiff(s: WsState, key: string, path: string): WsState {
  const cur = page(s, key);
  const id = `diff:${path}`;
  if (cur.tabs.some((t) => t.id === id)) return put(s, key, { ...cur, activeTabId: id });
  const tab: Tab = { id, kind: "diff", path, title: basename(path) };
  return put(s, key, { tabs: [...cur.tabs, tab], activeTabId: id });
}

export function openCommit(s: WsState, key: string, hash: string, subject: string): WsState {
  const cur = page(s, key);
  const id = `commit:${hash}`;
  if (cur.tabs.some((t) => t.id === id)) return put(s, key, { ...cur, activeTabId: id });
  const tab: Tab = { id, kind: "commit", hash, title: subject.slice(0, 32) || hash.slice(0, 7) };
  return put(s, key, { tabs: [...cur.tabs, tab], activeTabId: id });
}

export function closeTab(s: WsState, key: string, id: string): WsState {
  if (id === "agent") return s; // pinned tab
  const cur = page(s, key);
  const idx = cur.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return s;
  const tabs = cur.tabs.filter((t) => t.id !== id);
  const activeTabId = cur.activeTabId === id ? (tabs[idx] ?? tabs[idx - 1] ?? tabs[0]).id : cur.activeTabId;
  return put(s, key, { tabs, activeTabId });
}

export function setActive(s: WsState, key: string, id: string): WsState {
  return put(s, key, { ...page(s, key), activeTabId: id });
}

export function setDirty(s: WsState, key: string, id: string, dirty: boolean): WsState {
  const cur = page(s, key);
  return put(s, key, { ...cur, tabs: cur.tabs.map((t) => (t.id === id && t.kind === "file" ? { ...t, dirty } : t)) });
}

export function toggleRight(s: WsState): WsState { return { ...s, right: { ...s.right, open: !s.right.open } }; }
export function setSegment(s: WsState, segment: RightState["segment"]): WsState { return { ...s, right: { ...s.right, segment } }; }
export function setRightWidth(s: WsState, w: number): WsState { return { ...s, right: { ...s.right, width: Math.max(RW_MIN, Math.min(RW_MAX, w)) } }; }

export function toggleDir(s: WsState, key: string, dir: string): WsState {
  const cur = s.expandedByPage[key] ?? [];
  const next = cur.includes(dir) ? cur.filter((d) => d !== dir) : [...cur, dir];
  return { ...s, expandedByPage: { ...s.expandedByPage, [key]: next } };
}
export function collapseAll(s: WsState, key: string): WsState {
  return { ...s, expandedByPage: { ...s.expandedByPage, [key]: [] } };
}
export function expandAncestors(s: WsState, key: string, filePath: string, root: string): WsState {
  const cur = s.expandedByPage[key] ?? [];
  const merged = new Set(cur);
  for (const d of ancestorDirs(filePath, root)) merged.add(d);
  return { ...s, expandedByPage: { ...s.expandedByPage, [key]: [...merged] } };
}

// Remove byPage/expandedByPage entries not in the known page keys (session id ∪ live worker id) — prevents dead workers from piling up.
export function pruneWsPages(s: WsState, knownKeys: Set<string>): WsState {
  const byPage: WsState["byPage"] = {};
  for (const [k, v] of Object.entries(s.byPage)) if (knownKeys.has(k)) byPage[k] = v;
  const expandedByPage: WsState["expandedByPage"] = {};
  for (const [k, v] of Object.entries(s.expandedByPage)) if (knownKeys.has(k)) expandedByPage[k] = v;
  return { ...s, byPage, expandedByPage };
}

interface WsStore extends WsState {
  openFile_: (key: string, path: string) => void;
  openDiff_: (key: string, path: string) => void;
  openCommit_: (key: string, hash: string, subject: string) => void;
  closeTab_: (key: string, id: string) => void;
  setActive_: (key: string, id: string) => void;
  setDirty_: (key: string, id: string, dirty: boolean) => void;
  toggleRight_: () => void;
  setRightWidth_: (w: number) => void;
  setSegment_: (seg: RightState["segment"]) => void;
  toggleDir_: (key: string, dir: string) => void;
  collapseAll_: (key: string) => void;
  expandAncestors_: (key: string, filePath: string, root: string) => void;
}
export const useWsStore = create<WsStore>()(
  persist(
    (set) => ({
      ...emptyWsState(),
      openFile_: (key, path) => set((s) => openFile(s, key, path)),
      openDiff_: (key, path) => set((s) => openDiff(s, key, path)),
      openCommit_: (key, hash, subject) => set((s) => openCommit(s, key, hash, subject)),
      closeTab_: (key, id) => set((s) => closeTab(s, key, id)),
      setActive_: (key, id) => set((s) => setActive(s, key, id)),
      setDirty_: (key, id, dirty) => set((s) => setDirty(s, key, id, dirty)),
      toggleRight_: () => set((s) => toggleRight(s)),
      setRightWidth_: (w) => set((s) => setRightWidth(s, w)),
      setSegment_: (seg) => set((s) => setSegment(s, seg)),
      toggleDir_: (key, dir) => set((s) => toggleDir(s, key, dir)),
      collapseAll_: (key) => set((s) => collapseAll(s, key)),
      expandAncestors_: (key, filePath, root) => set((s) => expandAncestors(s, key, filePath, root)),
    }),
    {
      name: "rookery.ws",
      version: 1,
      // Guard against partial persistence: backfill missing fields with defaults (prevents zustand from discarding the persisted state on version mismatch).
      migrate: (persisted) => {
        const p = persisted as Partial<WsState> | undefined;
        return { byPage: p?.byPage ?? {}, right: p?.right ?? emptyWsState().right, expandedByPage: p?.expandedByPage ?? {} };
      },
      storage: createJSONStorage(() => localStorage),
      // Persist tabs (file/diff use path-based ids) + right sidebar + expanded state. It's fine if dirty ossifies to false (refreshed via a read on reopen).
      partialize: (s) => ({ byPage: s.byPage, right: s.right, expandedByPage: s.expandedByPage }),
    },
  ),
);
