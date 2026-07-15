import { useCallback, useEffect, useRef, useState } from "react";
import {
  $createRangeSelection,
  $createTextNode,
  $getNodeByKey,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  HISTORY_PUSH_TAG,
  type LexicalEditor,
  type NodeKey,
} from "lexical";
import type { BrowseEntry, BrowseResult } from "../types/rookery.js";
import {
  activeMentionQuery,
  chipPathOf,
  filterEntries,
  splitPath,
} from "../lib/file-mention.js";
import {
  $createFileMentionNode,
  $isFileMentionNode,
} from "./FileMentionNode.js";

const DEBOUNCE_MS = 90;

interface Cache {
  dirPart: string;
  dir: string;
  entries: BrowseEntry[];
}

interface TextToken {
  nodeKey: NodeKey;
  start: number;
  end: number;
}

export interface LexicalFileMention {
  open: boolean;
  entries: BrowseEntry[];
  sel: number;
  setSel: (index: number) => void;
  dismiss: () => void;
  pick: (entry: BrowseEntry) => void;
}

export function useLexicalFileMention({
  editor,
  browseDir,
  disabled = false,
}: {
  editor: LexicalEditor;
  browseDir?: (dir: string) => Promise<BrowseResult>;
  disabled?: boolean;
}): LexicalFileMention {
  const enabled = !disabled && browseDir != null;
  const [query, setQuery] = useState<string | null>(null);
  const [cache, setCache] = useState<Cache | null>(null);
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const tokenRef = useRef<TextToken | null>(null);

  useEffect(() => editor.registerUpdateListener(({
    dirtyElements,
    dirtyLeaves,
    editorState,
  }) => {
    if (!enabled) {
      tokenRef.current = null;
      setQuery(null);
      return;
    }
    editorState.read(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || !selection.isCollapsed() || selection.anchor.type !== "text") {
        tokenRef.current = null;
        setQuery(null);
        return;
      }
      const node = selection.anchor.getNode();
      if (!$isTextNode(node) || $isFileMentionNode(node)) {
        tokenRef.current = null;
        setQuery(null);
        return;
      }
      const offset = selection.anchor.offset;
      const match = activeMentionQuery(node.getTextContent().slice(0, offset));
      if (match == null) {
        tokenRef.current = null;
        setQuery(null);
        return;
      }
      tokenRef.current = { nodeKey: node.getKey(), start: match.start, end: offset };
      setQuery(match.query);
      setSel(0);
      if (dirtyElements.size > 0 || dirtyLeaves.size > 0) setDismissed(false);
    });
  }), [editor, enabled]);

  const split = query == null ? null : splitPath(query);
  const entries = cache != null && split != null && cache.dirPart === split.dirPart
    ? filterEntries(cache.entries, split.filter)
    : [];
  const open = enabled && query != null && !dismissed && entries.length > 0;
  const dirPart = split?.dirPart ?? null;

  useEffect(() => {
    if (dirPart == null || !enabled || browseDir == null) return;
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      void browseDir(dirPart)
        .then((result) => {
          if (!cancelled) {
            setCache({ dirPart, dir: result.dir, entries: result.entries });
          }
        })
        .catch(() => {});
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [browseDir, dirPart, enabled]);

  const pick = useCallback((entry: BrowseEntry) => {
    const token = tokenRef.current;
    if (token == null || query == null || cache == null) return;
    const { dirPart: currentDirPart } = splitPath(query);

    editor.update(() => {
      const node = $getNodeByKey(token.nodeKey);
      if (!$isTextNode(node) || $isFileMentionNode(node)) return;
      if (token.end > node.getTextContentSize()) return;
      const selection = $createRangeSelection();
      selection.anchor.set(token.nodeKey, token.start, "text");
      selection.focus.set(token.nodeKey, token.end, "text");
      $setSelection(selection);

      if (entry.isDir) {
        selection.insertText(`@${currentDirPart}${entry.name}/`);
      } else {
        const path = chipPathOf(cache.dir, entry.name);
        selection.insertNodes([
          $createFileMentionNode(path, entry.name),
          $createTextNode(" "),
        ]);
      }
    }, { discrete: true, tag: HISTORY_PUSH_TAG });

    if (!entry.isDir) {
      tokenRef.current = null;
      setQuery(null);
    }
    requestAnimationFrame(() => editor.focus());
  }, [cache, editor, query]);

  return {
    dismiss: () => setDismissed(true),
    entries,
    open,
    pick,
    sel,
    setSel,
  };
}
