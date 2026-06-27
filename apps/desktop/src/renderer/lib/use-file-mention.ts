// State/behavior hook for chat @ path autocompletion. Combines the pure parser (file-mention.ts) + DOM helper (mention-editor.ts)
// to keep Conversation thin. Isomorphic with the slash popup (keyboard nav/Esc/IME guard) but adds async directory listing.
import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import type { BrowseEntry, BrowseResult } from "../types/rookery.js";
import { activeMentionQuery, splitPath, filterEntries, chipPathOf } from "./file-mention.js";
import { getCaretContext, replaceRange, makeChip } from "./mention-editor.js";

const DEBOUNCE_MS = 90; // Prevent IPC flooding while typing (filtering within the same folder is client-side, so it never re-requests anyway)

interface Cache { dirPart: string; dir: string; entries: BrowseEntry[]; }

export interface FileMention {
  open: boolean;
  entries: BrowseEntry[];
  sel: number;
  setSel: (i: number) => void;
  refresh: () => void; // Re-parse the @query at the caret after input/programmatic edit
  onKeyDown: (e: KeyboardEvent) => boolean; // true if the popup handled it (intercepts the parent's Enter/send)
  pick: (entry: BrowseEntry) => void; // Mouse-click selection
}

export function useFileMention(opts: {
  edRef: RefObject<HTMLDivElement | null>;
  browseDir?: (dir: string) => Promise<BrowseResult>;
  disabled?: boolean;
  afterEdit: () => void; // Reflect editor DOM changes into the Conversation text state (syncText)
}): FileMention {
  const { edRef, browseDir, disabled, afterEdit } = opts;
  const enabled = !disabled && !!browseDir;
  const [query, setQuery] = useState<string | null>(null);
  const [cache, setCache] = useState<Cache | null>(null);
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const tokenRef = useRef<{ node: Text; start: number; end: number } | null>(null);

  const split = query !== null ? splitPath(query) : null;
  // Only show candidates when the cache matches the current dirPart (so a stale cache right after a folder switch doesn't show a wrong list).
  const entries = cache && split && cache.dirPart === split.dirPart ? filterEntries(cache.entries, split.filter) : [];
  const open = query !== null && !dismissed && enabled && entries.length > 0;

  const refresh = useCallback(() => {
    setDismissed(false); // There was a keystroke → reopen even if it was closed via Esc (same as the slash popup)
    const root = edRef.current;
    if (!enabled || !root) { setQuery(null); return; }
    const ctx = getCaretContext(root);
    const m = ctx ? activeMentionQuery(ctx.textBefore) : null;
    if (!ctx || !m) { setQuery(null); tokenRef.current = null; return; }
    tokenRef.current = { node: ctx.node, start: m.start, end: ctx.offset };
    setQuery(m.query);
    setSel(0);
  }, [edRef, enabled]);

  // Re-request browse only when dirPart changes. If only the filter (filename prefix) changes within the same folder, reuse the cache (no IPC).
  const dirPart = split?.dirPart ?? null;
  useEffect(() => {
    if (dirPart === null || !enabled || !browseDir) return;
    let cancelled = false;
    const t = setTimeout(() => {
      void browseDir(dirPart)
        .then((r) => { if (!cancelled) setCache({ dirPart, dir: r.dir, entries: r.entries }); })
        .catch(() => {});
    }, DEBOUNCE_MS);
    return () => { cancelled = true; clearTimeout(t); };
  }, [dirPart, enabled, browseDir]);

  const pick = useCallback((entry: BrowseEntry) => {
    const root = edRef.current;
    const tok = tokenRef.current;
    if (!root || !tok || query === null || !cache) return;
    const { dirPart: dp } = splitPath(query);
    if (entry.isDir) {
      // Drill-in: replace the @token with @<currentPath><folder>/ → re-parse → re-list with the new dirPart (keep the popup open).
      replaceRange(tok.node, tok.start, tok.end, [document.createTextNode(`@${dp}${entry.name}/`)]);
      afterEdit();
      refresh();
    } else {
      // File: replace the @token with a mention chip (@absolutePath) and close the popup. Same chip as the existing drag-and-drop attachment.
      const abs = chipPathOf(cache.dir, entry.name);
      replaceRange(tok.node, tok.start, tok.end, [makeChip(abs, entry.name), document.createTextNode(" ")]);
      setQuery(null);
      tokenRef.current = null;
      afterEdit();
    }
    requestAnimationFrame(() => root.focus());
  }, [edRef, query, cache, afterEdit, refresh]);

  const onKeyDown = useCallback((e: KeyboardEvent): boolean => {
    if (!open) return false;
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => (s + 1) % entries.length); return true; }
    if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => (s - 1 + entries.length) % entries.length); return true; }
    // Don't intercept the IME composition-commit Enter (Korean folder names — same guard as slash popup BUG-4).
    if ((e.key === "Enter" && !e.nativeEvent.isComposing) || e.key === "Tab") { e.preventDefault(); pick(entries[sel] ?? entries[0]!); return true; }
    if (e.key === "Escape") { e.preventDefault(); setDismissed(true); return true; }
    return false;
  }, [open, entries, sel, pick]);

  return { open, entries, sel, setSel, refresh, onKeyDown, pick };
}
