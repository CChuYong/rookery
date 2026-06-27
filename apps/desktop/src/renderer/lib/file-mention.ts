// Pure logic for chat @ path autocomplete (DOM/IPC-agnostic → easy to unit test).
// Query extraction · path splitting · candidate filter/sort · chip absolute-path computation.
import type { BrowseEntry } from "../types/rookery.js";

// Extracts the active @token from the text before the caret. Only when @ is preceded by whitespace/start and has no whitespace after it (so emails and argument entry don't trigger).
// start = the index of @ (used directly for the editor's token-range replacement — textBefore is the node's slice(0,offset), so the index matches the node offset).
export function activeMentionQuery(textBeforeCaret: string): { query: string; start: number } | null {
  const m = /(^|\s)@([^\s]*)$/.exec(textBeforeCaret);
  if (!m) return null;
  return { query: m[2], start: m.index + m[1].length };
}

// Splits the query into a directory prefix (up to and including the last /) + filter (the rest). browse uses dirPart, candidate filtering uses filter.
export function splitPath(query: string): { dirPart: string; filter: string } {
  const i = query.lastIndexOf("/");
  if (i === -1) return { dirPart: "", filter: query };
  return { dirPart: query.slice(0, i + 1), filter: query.slice(i + 1) };
}

const MAX_MENTION = 50; // Popup display cap (scroll). Separate from browse's own cap (1000).

// Narrows browse entries by the filter and sorts: directories first → prefix matches preferred → by name. Applies the display cap.
// dotfiles are shown only when the filter starts with "." (Finder convention).
export function filterEntries(entries: BrowseEntry[], filter: string): BrowseEntry[] {
  const q = filter.toLowerCase();
  const showDot = filter.startsWith(".");
  const starts = (e: BrowseEntry) => e.name.toLowerCase().startsWith(q);
  return entries
    .filter((e) => (showDot || !e.name.startsWith(".")) && e.name.toLowerCase().includes(q))
    .sort((a, b) =>
      a.isDir !== b.isDir
        ? a.isDir ? -1 : 1
        : starts(a) !== starts(b)
          ? starts(a) ? -1 : 1
          : a.name.localeCompare(b.name),
    )
    .slice(0, MAX_MENTION);
}

// Absolute path to embed in the chip. The resolved dir (absolute) returned by browse + the entry name. Avoids duplicate slashes at the root ("/").
export function chipPathOf(resolvedDir: string, name: string): string {
  return resolvedDir.endsWith("/") ? `${resolvedDir}${name}` : `${resolvedDir}/${name}`;
}
