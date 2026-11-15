import type { ImageRef } from "@daemon/core/image-input.js";
import type { SourceProviderId } from "@daemon/core/source-intake.js";
import { validateImageRefs } from "../lib/image-limits.js";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

// Keep unsent Composer drafts per page (= session id / worker id).
// The Composer is uncontrolled (its own state + contenteditable DOM), so its contents are lost when it unmounts on tab/session switch →
// lifting the serialized draft up here and persisting it lets it survive tab switches, session switches, and reloads.
export interface Draft {
  text: string;
  images: ImageRef[];
  label?: string; // spawn page drafts only: the worker label typed next to the task
  source?: SpawnDraftSource; // spawn page drafts only: the picked GitHub issue / Linear ticket (its mode is `provider`)
}
// The picked source item minus its body (the body already lives in the task text). Enough to restore the chip and to
// send ticketKey (identifier) / ticketUrl (url) on spawn.
export interface SpawnDraftSource {
  provider: SourceProviderId;
  id: string;
  identifier: string;
  title: string;
  url: string;
}
function spawnDraftSource(value: unknown): SpawnDraftSource | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (v.provider !== "github" && v.provider !== "linear") return undefined;
  if (![v.id, v.identifier, v.title, v.url].every((field) => typeof field === "string")) return undefined;
  return { provider: v.provider, id: v.id as string, identifier: v.identifier as string, title: v.title as string, url: v.url as string };
}
export const EMPTY_DRAFT: Draft = { text: "", images: [] };
export function imageRefs(images: readonly ImageRef[]): ImageRef[] {
  return images.map(({ id, name, mediaType, byteLength, width, height }) => ({
    id,
    name,
    mediaType,
    byteLength,
    width,
    height,
  }));
}
export function migrateDrafts(persisted: unknown): DraftState {
  const byPage: Record<string, Draft> = {};
  const raw = (persisted as Partial<DraftState> | undefined)?.byPage;
  if (raw && typeof raw === "object")
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "string") {
        if (value) byPage[key] = { text: value, images: [] };
      } else if (
        value &&
        typeof value.text === "string" &&
        Array.isArray(value.images)
      ) {
        let images: ImageRef[] = [];
        try {
          images = imageRefs(validateImageRefs(value.images));
        } catch {
          images = [];
        }
        byPage[key] = { text: value.text, images };
        if (typeof value.label === "string" && value.label) byPage[key].label = value.label;
        const source = spawnDraftSource(value.source);
        if (source) byPage[key].source = source;
      }
    }
  return { byPage };
}
export interface DraftState {
  byPage: Record<string, Draft>;
}

export function emptyDraftState(): DraftState {
  return { byPage: {} };
}

// Save a draft. An empty string removes the entry — so we don't hold onto empty drafts (cleanly cleared on send/clear).
export function setDraft(
  s: DraftState,
  key: string,
  text: string,
  images: ImageRef[] = [],
): DraftState {
  if (!text && !images.length) {
    if (!(key in s.byPage)) return s;
    const byPage = { ...s.byPage };
    delete byPage[key];
    return { ...s, byPage };
  }
  return {
    ...s,
    byPage: { ...s.byPage, [key]: { text, images: imageRefs(images) } },
  };
}

// A Side runtime is ephemeral; its unsent draft belongs to the stable source conversation.
export function sideDraftKey(
  kind: "master" | "worker",
  sourceId: string,
): string {
  return `side:${kind}:${sourceId}`;
}
function sideDraftSource(key: string): string | undefined {
  return /^side:(?:master|worker):(.+)$/.exec(key)?.[1];
}

// The full-page worker spawn form keeps its unsent task + label per target repo (repo name, as shown on the page).
export function spawnDraftKey(repo: string): string {
  return `spawnWorker:${repo}`;
}
const SPAWN_DRAFT_PREFIX = "spawnWorker:";

// Save a spawn page draft; an empty task, label and source removes the entry (like setDraft).
export function setSpawnDraft(
  s: DraftState,
  repo: string,
  task: string,
  label: string,
  source?: SpawnDraftSource,
): DraftState {
  const key = spawnDraftKey(repo);
  if (!task && !label && !source) return setDraft(s, key, "");
  const draft: Draft = { text: task, images: [] };
  if (label) draft.label = label;
  const picked = spawnDraftSource(source); // strips extra fields (e.g. a SourceItem's body)
  if (picked) draft.source = picked;
  return { ...s, byPage: { ...s.byPage, [key]: draft } };
}

// Remove drafts not in the known page keys (session ids ∪ live worker ids) — prevents dead-worker drafts from piling up (same convention as pruneWsPages).
// Spawn page drafts (spawnWorker:<repo>) are always kept: the boot-time prune runs once sessions + fleet arrive, which
// does not wait for the repo list, so pruning by repo here could wipe a live draft. Their count is bounded by the
// registered repo names, and App clears a repo's spawn draft when that repo is removed.
export function pruneDrafts(s: DraftState, knownKeys: Set<string>): DraftState {
  const byPage: DraftState["byPage"] = {};
  for (const [k, v] of Object.entries(s.byPage))
    if (k.startsWith(SPAWN_DRAFT_PREFIX) || knownKeys.has(k) || knownKeys.has(sideDraftSource(k) ?? ""))
      byPage[k] = v;
  return { ...s, byPage };
}

interface DraftStore extends DraftState {
  setDraft_: (key: string, text: string, images?: ImageRef[]) => void;
  setSpawnDraft_: (repo: string, task: string, label: string, source?: SpawnDraftSource) => void;
}

export const useDraftStore = create<DraftStore>()(
  persist(
    (set) => ({
      ...emptyDraftState(),
      setDraft_: (key, text, images) =>
        set((s) => setDraft(s, key, text, images)),
      setSpawnDraft_: (repo, task, label, source) =>
        set((s) => setSpawnDraft(s, repo, task, label, source)),
    }),
    {
      name: "rookery.drafts",
      version: 2,
      // Guard against partial persisted state: fill in missing fields with defaults (prevents zustand from discarding persisted state on version mismatch).
      migrate: migrateDrafts,
      merge: (persisted, current) => ({
        ...current,
        ...migrateDrafts(persisted),
      }),
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ byPage: s.byPage }),
    },
  ),
);

export function clearAcceptedDraft(
  key: string,
  text: string,
  images: ImageRef[] = [],
  expected?: Draft,
): void {
  const current = useDraftStore.getState().byPage[key];
  if (expected && current !== expected) return;
  if (
    current &&
    current.text.trim() === text.trim() &&
    JSON.stringify(current.images.map((i) => i.id)) ===
      JSON.stringify(images.map((i) => i.id))
  )
    useDraftStore.getState().setDraft_(key, "");
}
