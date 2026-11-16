import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { ChevronRight, FilePlus, FolderPlus, ChevronsDownUp, MoreHorizontal, RefreshCw, Search } from "lucide-react";
import { Icon } from "@iconify/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useWsStore } from "../store/workspace.js";
import { cn } from "../lib/cn.js";
import { ROW_CURRENT_MARK, ROW_IDLE, ROW_SELECTED } from "../lib/ui-tokens.js";
import { fileIcon, FOLDER_ICON, FOLDER_OPEN_ICON } from "../lib/fileIcon.js";
import { GIT_TONE } from "../lib/gitTone.js";
import { ContextMenu, type MenuItem } from "./ContextMenu.js";
import { flatten, ancestorDirs, parentDir, fuzzyFilter, type Entry, type Row } from "../lib/filetree-model.js";
import { Input } from "../ui/input.js";
import { Button } from "../ui/button.js";
import { ConfirmDialog } from "../ui/confirm-dialog.js";
import { SkeletonRows } from "./Skeleton.js";
import { LoadFailed } from "../ui/load-state.js";
import { toast } from "../store/toasts.js";
import { useDismissTransition } from "../lib/useDismissTransition.js";
import { useModalKeys } from "../lib/useModalKeys.js";
import { useFocusTrap } from "../lib/useFocusTrap.js";
import { useT } from "../i18n/provider.js";
import { isImeComposing, isTypingTarget, rovingIndex } from "../lib/focus.js";
import { SHORTCUT, isDeleteKey, isMenuKey, isRenameKey, withShortcut } from "../lib/shortcuts.js";
import { dialogOverlayClass, dialogPanelClass } from "../ui/dialog.js";

const EMPTY: string[] = [];

export function FileTree({ root, pageKey, version = 0, activeTabPath }: { root: string; pageKey: string; version?: number; activeTabPath: string | null }): JSX.Element {
  const t = useT();
  const expandedList = useWsStore((s) => s.expandedByPage[pageKey] ?? EMPTY);
  const toggleDir = useWsStore((s) => s.toggleDir_);
  const collapseAllDirs = useWsStore((s) => s.collapseAll_);
  const openFile = useWsStore((s) => s.openFile_);
  const closeTab = useWsStore((s) => s.closeTab_);
  const tabs = useWsStore((s) => s.byPage[pageKey]?.tabs);
  const expanded = useMemo(() => new Set(expandedList), [expandedList]);

  const [children, setChildren] = useState<Map<string, Entry[]>>(new Map());
  // Root-listing state, tracked separately from expanded sub-dirs (#13): while "loading", the initial fetch must not
  // render as an empty folder, and a genuine list() failure must not look like an empty folder either.
  const [rootStatus, setRootStatus] = useState<"loading" | "loaded" | "error">("loading");
  const [git, setGit] = useState<Map<string, string>>(new Map());
  const [reloadKey, setReloadKey] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; row: Row } | null>(null);
  const [filter, setFilter] = useState("");
  const [walkPaths, setWalkPaths] = useState<string[]>([]);
  // Finder walk state (audit #114): "searching…" until the first walk returns, an error with retry, and truncation.
  const [walkState, setWalkState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [walkErr, setWalkErr] = useState<string | null>(null);
  const [walkTruncated, setWalkTruncated] = useState(false);
  const [walkAttempt, setWalkAttempt] = useState(0);
  // In-app replacements for native window.prompt/confirm (which block the renderer thread + break the ink deck).
  const [nameDialog, setNameDialog] = useState<{ kind: "newFile" | "newFolder" | "rename"; dir?: string; target?: Row; initial: string } | null>(null);
  const [trashTarget, setTrashTarget] = useState<Row | null>(null);
  const [matchSel, setMatchSel] = useState(0); // highlighted finder result (audit #69)
  const bodyRef = useRef<HTMLDivElement>(null);
  const uid = useId();
  const filtering = filter.trim().length > 0;

  // Roots that have completed at least one successful listing — gates the skeleton to a root's genuinely first
  // load. `version`/`reloadKey` re-fire this effect on every live fs event and every create/mkdir/rename/trash/
  // manual-refresh, so without this a background refetch would blink the already-rendered tree to a skeleton and
  // back on every one of those (task 10 review of #13). A `root` change (switching pages/worktrees) is never in
  // this set yet, so it still gets the initial skeleton.
  const loadedRootsRef = useRef<Set<string>>(new Set());

  // Load the root directory's contents, tracked separately from expanded sub-dirs (#13) so the initial load and a
  // genuine list() failure are never mistaken for an empty folder (re-fetches on version/reloadKey too).
  useEffect(() => {
    let live = true;
    const isFirstLoad = !loadedRootsRef.current.has(root);
    if (isFirstLoad) setRootStatus("loading");
    void window.rookery.ws.list(root).then((entries) => {
      if (!live) return;
      setChildren((m) => new Map(m).set(root, entries));
      setRootStatus("loaded");
      loadedRootsRef.current.add(root);
    }).catch((e) => {
      if (!live) return;
      if (isFirstLoad) setRootStatus("error");
      // A background refetch failing (live fs event, or a manual refresh after the root already loaded once)
      // keeps the already-rendered tree in place rather than replacing it with the error panel — the stale
      // tree plus this toast beats losing the user's expanded state over a transient failure.
      else toast.error(t("fileTree.opFailed"), String(e));
    });
    return () => { live = false; };
  }, [root, version, reloadKey, t]);

  // Load every expanded directory (root is loaded separately above with its own loading/error state — #13's scope is
  // root-only). A per-directory failure surfaces via the same fs-op toast as #11 rather than a dedicated state, since
  // collapsing and re-expanding recovers it.
  useEffect(() => {
    if (expandedList.length === 0) return;
    let live = true;
    void Promise.all(expandedList.map(async (d) => [d, await window.rookery.ws.list(d).catch((e) => { toast.error(t("fileTree.opFailed"), String(e)); return [] as Entry[]; })] as const))
      .then((pairs) => {
        if (!live) return;
        setChildren((m) => { const next = new Map(m); for (const [d, entries] of pairs) next.set(d, entries); return next; });
      });
    return () => { live = false; };
  }, [root, version, expandedList, reloadKey, t]);

  // git status → map of changed files' absolute paths + ancestor-directory markers (•).
  useEffect(() => {
    let live = true;
    void window.rookery.ws.gitStatus(root).then((files) => {
      if (!live) return;
      const m = new Map<string, string>();
      for (const f of files) {
        const abs = `${root}/${f.path}`;
        m.set(abs, f.status);
        for (const d of ancestorDirs(abs, root)) if (!m.has(d)) m.set(d, "•");
      }
      setGit(m);
    }).catch(() => {});
    return () => { live = false; };
  }, [root, version, reloadKey]);

  // Recursive walk for the finder (Go-to-file) — loaded once only while filter input is active (+ refreshed on version/reload).
  useEffect(() => {
    if (!filtering) return;
    let live = true;
    setWalkState((cur) => (cur === "ready" ? cur : "loading")); // a re-walk keeps the old paths on screen
    void window.rookery.ws.walk(root).then(
      (r) => { if (live) { setWalkPaths(r.paths); setWalkTruncated(r.truncated); setWalkErr(null); setWalkState("ready"); } },
      (e: unknown) => { if (live) { setWalkErr(e instanceof Error ? e.message : String(e)); setWalkState("error"); } },
    );
    return () => { live = false; };
  }, [filtering, root, version, reloadKey, walkAttempt]);
  useEffect(() => { setWalkState("idle"); setWalkPaths([]); setWalkTruncated(false); }, [root]);

  const rows = useMemo(() => flatten(root, expanded, children), [root, expanded, children]);
  const matches = useMemo(() => (filtering ? fuzzyFilter(walkPaths, filter.trim()) : []), [filtering, walkPaths, filter]);

  // Windowed render — only the visible rows hit the DOM, so a large worktree (or a long match list) stays cheap.
  // Rows are fixed-height (FileRow h-6 / match h-7) so a fixed estimate is exact (no per-item measurement needed).
  const rowVirt = useVirtualizer({
    count: filtering ? matches.length : rows.length,
    getScrollElement: () => bodyRef.current,
    estimateSize: () => (filtering ? 28 : 24),
    overscan: 12,
    // Seed a viewport size so the initial window computes before the element is measured (real ResizeObserver overrides
    // in-app; in jsdom there's no layout, so without this the virtualizer would render nothing).
    initialRect: { width: 280, height: 640 },
  });

  useEffect(() => { setMatchSel(0); }, [filter]);
  const openMatch = (i: number): void => {
    const rel = matches[i];
    if (rel !== undefined) openFile(pageKey, `${root}/${rel}`);
  };
  // The row element for the selected path (to anchor a keyboard-opened menu at it).
  const rowEl = (path: string): HTMLElement | undefined =>
    Array.from(bodyRef.current?.querySelectorAll<HTMLElement>("[data-path]") ?? []).find((el) => el.dataset.path === path);
  const onKeyDown = (e: ReactKeyboardEvent): void => {
    if (e.target !== e.currentTarget && isTypingTarget(e.target)) return;
    if (filtering) {
      // Finder results: Arrow/Home/End move the highlight, Enter opens it (audit #69 — this mode used to ignore keys).
      if (matches.length === 0) return;
      if (e.key === "Enter") { e.preventDefault(); openMatch(matchSel); return; }
      const ni = rovingIndex(e.key, matchSel, matches.length);
      if (ni === null) return;
      e.preventDefault();
      setMatchSel(ni);
      rowVirt.scrollToIndex(ni);
      return;
    }
    if (rows.length === 0) return;
    const idx = rows.findIndex((r) => r.path === selected);
    const cur = idx >= 0 ? rows[idx] : null;
    // Keyboard paths for the row menu (audit #68): F2 rename, Delete / Cmd+Backspace trash, Shift+F10 / Menu key menu.
    if (cur && isRenameKey(e)) { e.preventDefault(); onRename(cur); return; }
    if (cur && isDeleteKey(e)) { e.preventDefault(); onDelete(cur); return; }
    if (cur && isMenuKey(e)) {
      e.preventDefault();
      const r = rowEl(cur.path)?.getBoundingClientRect();
      setMenu({ x: (r?.left ?? 0) + 24, y: r?.bottom ?? 0, row: cur });
      return;
    }
    if (e.key === "Home" || e.key === "End") { e.preventDefault(); const ni = e.key === "Home" ? 0 : rows.length - 1; setSelected(rows[ni]!.path); rowVirt.scrollToIndex(ni); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); const ni = Math.min(rows.length - 1, idx + 1); setSelected(rows[ni]?.path ?? rows[0].path); rowVirt.scrollToIndex(ni); }
    else if (e.key === "ArrowUp") { e.preventDefault(); const ni = idx <= 0 ? 0 : idx - 1; setSelected(rows[ni].path); rowVirt.scrollToIndex(ni); }
    else if (e.key === "ArrowRight" && cur?.isDir) { e.preventDefault(); if (!expanded.has(cur.path)) toggleDir(pageKey, cur.path); }
    else if (e.key === "ArrowLeft" && cur) {
      e.preventDefault();
      if (cur.isDir && expanded.has(cur.path)) toggleDir(pageKey, cur.path);
      else { const p = parentDir(cur.path); if (p.length >= root.length) setSelected(p); }
    } else if (e.key === "Enter" && cur) { e.preventDefault(); cur.isDir ? toggleDir(pageKey, cur.path) : openFile(pageKey, cur.path); }
  };

  // Open the in-app dialogs instead of native prompt/confirm.
  const onCreateFile = (dir: string): void => setNameDialog({ kind: "newFile", dir, initial: "" });
  const onCreateFolder = (dir: string): void => setNameDialog({ kind: "newFolder", dir, initial: "" });
  const onRename = (target: Row): void => setNameDialog({ kind: "rename", target, initial: target.name });
  const onDelete = (target: Row): void => setTrashTarget(target);

  // Run the op the name dialog collected. The dialog stays open while it runs (audit #133): a failure (name taken,
  // target gone, permission denied) comes back as an inline message next to the kept name instead of a toast after the
  // dialog already closed. Resolves null on success (the dialog then closes), or the message to show.
  async function submitName(name: string): Promise<string | null> {
    const d = nameDialog;
    const nm = name.trim();
    if (!d || !nm) return null;
    try {
      if (d.kind === "newFile" && d.dir) {
        const r = await window.rookery.ws.createFile(`${d.dir}/${nm}`);
        if (r.exists) return t("fileTree.fileExistsAlert");
        if (d.dir !== root && !expanded.has(d.dir)) toggleDir(pageKey, d.dir);
        setReloadKey((k) => k + 1);
        openFile(pageKey, `${d.dir}/${nm}`);
      } else if (d.kind === "newFolder" && d.dir) {
        await window.rookery.ws.mkdir(`${d.dir}/${nm}`);
        if (d.dir !== root && !expanded.has(d.dir)) toggleDir(pageKey, d.dir);
        setReloadKey((k) => k + 1);
      } else if (d.kind === "rename" && d.target && nm !== d.target.name) {
        await window.rookery.ws.rename(d.target.path, `${parentDir(d.target.path)}/${nm}`);
        const tab = tabs?.find((x) => x.id === `file:${d.target!.path}`);
        if (tab) closeTab(pageKey, tab.id); // clean up the tab for the old path that was renamed
        setReloadKey((k) => k + 1);
      }
      return null;
    } catch (e) {
      return `${t("fileTree.opFailed")} — ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  async function confirmTrash(): Promise<void> {
    const target = trashTarget;
    setTrashTarget(null);
    if (!target) return;
    try {
      await window.rookery.ws.trash(target.path);
      const tab = tabs?.find((x) => x.id === `file:${target.path}`);
      if (tab) closeTab(pageKey, tab.id);
      setReloadKey((k) => k + 1);
    } catch (e) {
      toast.error(t("fileTree.opFailed"), String(e));
    }
  }
  const nameDialogTitle = (kind: "newFile" | "newFolder" | "rename"): string =>
    kind === "newFile" ? t("fileTree.newFileNamePrompt") : kind === "newFolder" ? t("fileTree.newFolderNamePrompt") : t("fileTree.newNamePrompt");
  function menuItems(row: Row): MenuItem[] {
    const items: MenuItem[] = [];
    if (row.isDir) {
      items.push({ label: t("fileTree.newFile"), onClick: () => void onCreateFile(row.path) });
      items.push({ label: t("fileTree.newFolder"), onClick: () => void onCreateFolder(row.path) });
    }
    items.push({ label: t("fileTree.rename"), shortcut: { label: SHORTCUT.rename.label(), aria: SHORTCUT.rename.aria }, onClick: () => void onRename(row) });
    items.push({ label: t("fileTree.copyPath"), onClick: () => void navigator.clipboard?.writeText(row.path) });
    items.push({ label: t("common.delete"), danger: true, shortcut: { label: SHORTCUT.delete.label(), aria: SHORTCUT.delete.aria() }, onClick: () => void onDelete(row) });
    return items;
  }

  const activeDescendant = filtering
    ? (matches.length > 0 ? `${uid}-m${matchSel}` : undefined)
    : (() => { const i = rows.findIndex((r) => r.path === selected); return i >= 0 ? `${uid}-r${i}` : undefined; })();

  const ToolBtn = ({ label, onClick, children }: { label: string; onClick: () => void; children: JSX.Element }): JSX.Element => (
    <button aria-label={label} title={label} onClick={onClick} className="rounded-sm p-1 text-muted hover:bg-raised hover:text-fg">{children}</button>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-7 shrink-0 items-center justify-end gap-0.5 border-b border-line/60 px-1.5">
        <ToolBtn label={t("fileTree.newFile")} onClick={() => void onCreateFile(root)}><FilePlus size={14} /></ToolBtn>
        <ToolBtn label={t("fileTree.newFolder")} onClick={() => void onCreateFolder(root)}><FolderPlus size={14} /></ToolBtn>
        <ToolBtn label={t("fileTree.collapseAll")} onClick={() => collapseAllDirs(pageKey)}><ChevronsDownUp size={14} /></ToolBtn>
        <ToolBtn label={t("common.refresh")} onClick={() => setReloadKey((k) => k + 1)}><RefreshCw size={14} /></ToolBtn>
      </div>
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-line/60 px-2 transition-colors focus-within:border-accent/50">
        <Search size={12} className="shrink-0 text-muted" />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t("fileTree.searchPlaceholder")}
          aria-label={t("fileTree.searchPlaceholder")}
          aria-controls={`${uid}-tree`}
          onKeyDown={(e) => {
            if (isImeComposing(e)) return;
            // Enter opens the top (highlighted) result; ArrowDown moves into the results / tree; Escape clears the search.
            if (e.key === "Enter" && filtering) { e.preventDefault(); openMatch(matchSel); }
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              if (!filtering && !selected && rows[0]) setSelected(rows[0].path);
              bodyRef.current?.focus();
            } else if (e.key === "Escape" && filter) { e.preventDefault(); setFilter(""); }
          }}
          className="w-full bg-transparent text-ui text-fg-dim placeholder:text-muted focus:outline-none"
        />
      </div>
      <div
        ref={bodyRef}
        id={`${uid}-tree`}
        data-testid="filetree-body"
        role="tree"
        aria-label={t("fileTree.treeLabel")}
        tabIndex={0}
        // The tree is the single tab stop; the selection is announced through aria-activedescendant (rows are tabIndex -1).
        aria-activedescendant={activeDescendant}
        onKeyDown={onKeyDown} className="min-h-0 flex-1 overflow-y-auto py-1 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/40">
        {filtering && walkState === "error" ? (
          <LoadFailed message={t("fileTree.walkFailed")} detail={walkErr} onRetry={() => setWalkAttempt((n) => n + 1)} />
        ) : filtering && matches.length === 0 && walkState !== "ready" ? (
          <div className="px-3 py-3 text-ui text-muted">{t("fileTree.searching")}</div>
        ) : filtering && matches.length === 0 ? (
          <div className="px-3 py-3 text-ui text-muted">{t("fileTree.noMatches")}</div>
        ) : !filtering && rootStatus === "loading" ? (
          <SkeletonRows rows={8} />
        ) : !filtering && rootStatus === "error" ? (
          // The whole string doubles as the retry button's label (same convention as CheckpointMenu.loadFailed).
          <button onClick={() => setReloadKey((k) => k + 1)} className="w-full px-3 py-3 text-left text-ui text-fail hover:bg-fail/10">
            {t("fileTree.loadFailed")}
          </button>
        ) : !filtering && rows.length === 0 ? (
          <div className="px-3 py-3 text-ui text-muted">{t("fileTree.emptyFolder")}</div>
        ) : (
          <div className="relative w-full" style={{ height: rowVirt.getTotalSize() }}>
            {(() => {
              // Use the measured window when available; otherwise (no layout yet / jsdom) synthesize the full list at
              // estimated offsets so every row still renders. Rows are fixed-height, so estimated offsets tile exactly.
              const win = rowVirt.getVirtualItems();
              const est = filtering ? 28 : 24;
              const items = win.length ? win : Array.from({ length: filtering ? matches.length : rows.length }, (_, i) => ({ index: i, start: i * est }));
              return items.map((vi) => {
                const style = { position: "absolute" as const, top: 0, left: 0, width: "100%", transform: `translateY(${vi.start}px)` };
                if (filtering) {
                  const rel = matches[vi.index]!;
                  const hot = vi.index === matchSel;
                  return (
                    <button
                      key={rel}
                      id={`${uid}-m${vi.index}`}
                      role="treeitem"
                      aria-selected={hot}
                      tabIndex={-1}
                      style={style}
                      onClick={() => openFile(pageKey, `${root}/${rel}`)}
                      onMouseEnter={() => setMatchSel(vi.index)}
                      className={cn("flex h-7 w-full items-center gap-1.5 rounded px-2.5 text-left text-ui text-fg-dim hover:bg-raised", hot && ROW_SELECTED)}
                    >
                      <Icon icon={fileIcon(rel)} width={14} height={14} className="shrink-0" />
                      <span className="truncate">{rel}</span>
                    </button>
                  );
                }
                const r = rows[vi.index]!;
                return (
                  <div key={r.path} style={style} className="group/row">
                    <FileRow id={`${uid}-r${vi.index}`} row={r} active={r.path === activeTabPath} selected={r.path === selected} open={r.isDir && expanded.has(r.path)} git={git.get(r.path)}
                      onClick={() => { setSelected(r.path); r.isDir ? toggleDir(pageKey, r.path) : openFile(pageKey, r.path); }}
                      onContextMenu={(e) => { e.preventDefault(); setSelected(r.path); setMenu({ x: e.clientX, y: e.clientY, row: r }); }} />
                    {/* '⋯' — the same menu for a pointer without a right button (audit #68); out of the tab order, the
                        keyboard path is Shift+F10 / F2 / Delete on the tree. */}
                    <button
                      tabIndex={-1}
                      aria-label={t("common.moreActionsFor", { name: r.name })}
                      title={withShortcut(t("common.moreActions"), SHORTCUT.menu.label())}
                      aria-haspopup="menu"
                      onClick={(e) => { e.stopPropagation(); setSelected(r.path); const b = e.currentTarget.getBoundingClientRect(); setMenu({ x: b.left, y: b.bottom + 4, row: r }); }}
                      className={cn("absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted opacity-0 transition-opacity hover:bg-line/60 hover:text-fg-dim group-hover/row:opacity-100", r.path === selected && "opacity-100")}
                    >
                      <MoreHorizontal size={14} />
                    </button>
                  </div>
                );
              });
            })()}
          </div>
        )}
      </div>
      {filtering && walkState === "ready" && walkTruncated && matches.length > 0 && (
        <div role="status" className="shrink-0 border-t border-line/60 px-3 py-1 text-meta text-muted">{t("fileTree.walkTruncated")}</div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.row)} onClose={() => setMenu(null)} />}
      {nameDialog && (
        <NameDialog title={nameDialogTitle(nameDialog.kind)} initial={nameDialog.initial} selectBase={nameDialog.kind === "rename" && !nameDialog.target?.isDir} onSubmit={submitName} onCancel={() => setNameDialog(null)} />
      )}
      {trashTarget && (
        <ConfirmDialog
          title={t("common.delete")}
          body={t("fileTree.confirmTrash", { name: trashTarget.name })}
          confirmLabel={t("common.delete")}
          variant="danger"
          onConfirm={() => void confirmTrash()}
          onCancel={() => setTrashTarget(null)}
        />
      )}
    </div>
  );
}

// In-app name prompt (new file/folder/rename) — replaces window.prompt. Focus-trapped, on-brand, non-blocking. It stays
// open while the operation runs and shows a failure inline (audit #133); Escape cancels — a one-line name is no draft
// worth guarding, unlike the larger forms that ignore Escape. A rename preselects the name without its extension.
function NameDialog({ title, initial, selectBase, onSubmit, onCancel }: { title: string; initial: string; selectBase?: boolean; onSubmit: (name: string) => Promise<string | null>; onCancel: () => void }): JSX.Element {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const errId = useId();
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { closing, dismiss } = useDismissTransition(onCancel);
  const submit = (): void => {
    const v = value.trim();
    if (busy) return;
    if (!v) { dismiss(); return; }
    setBusy(true);
    setError(null);
    void onSubmit(v).then((err) => {
      setBusy(false);
      if (err) { setError(err); inputRef.current?.focus(); } else dismiss();
    });
  };
  useModalKeys({ escape: "close", onEscape: dismiss, onSubmit: submit });
  useFocusTrap(panelRef);
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const dot = initial.lastIndexOf(".");
    if (selectBase && dot > 0) el.setSelectionRange(0, dot);
    else el.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on open
  }, []);
  return (
    <div className={dialogOverlayClass({ closing, z: "z-[110]" })}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={title} className={dialogPanelClass({ size: "sm", closing, className: "flex flex-col gap-3" })}>
        <div className="text-title font-medium">{title}</div>
        <div className="flex flex-col gap-1">
          <Input
            ref={inputRef}
            autoFocus
            aria-label={title}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errId : undefined}
            value={value}
            onChange={(e) => { setValue(e.target.value); if (error) setError(null); }}
            onKeyDown={(e) => { if (e.key === "Enter" && !isImeComposing(e)) submit(); }}
          />
          {error && <p id={errId} role="alert" className="text-ui text-fail [overflow-wrap:anywhere]">{error}</p>}
        </div>
        <div className="flex justify-end gap-2">
          {/* audit #73 — was a raw button (rounded-lg 8px) beside the Button-based confirm (--radius 10px); promoted
              to Button so the pair no longer visibly mismatch in height/rounding. */}
          <Button variant="outline" size="sm" onClick={dismiss}>{t("common.cancel")}</Button>
          <Button variant="primary" size="sm" loading={busy} onClick={submit}>{t("common.confirm")}</Button>
        </div>
      </div>
    </div>
  );
}

function FileRow({ id, row, active, selected, open, git, onClick, onContextMenu }: { id: string; row: Row; active: boolean; selected: boolean; open: boolean; git?: string; onClick: () => void; onContextMenu: (e: ReactMouseEvent) => void }): JSX.Element {
  const icon = row.isDir ? (open ? FOLDER_OPEN_ICON : FOLDER_ICON) : fileIcon(row.name);
  return (
    <button
      id={id}
      tabIndex={-1}
      data-path={row.path}
      data-active={active}
      data-selected={selected}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-selected={selected}
      aria-expanded={row.isDir ? open : undefined}
      onClick={onClick}
      onContextMenu={onContextMenu}
      style={{ paddingLeft: 8 + row.depth * 12 }}
      className={cn("relative flex h-6 w-full items-center gap-1 rounded pr-2 text-left text-ui", active || selected ? ROW_SELECTED : ROW_IDLE, active && ROW_CURRENT_MARK)}
    >
      {/* 1px indent guides — one per ancestor depth, aligned to the middle of that level's reserved column */}
      {Array.from({ length: row.depth }, (_, i) => (
        <span key={i} aria-hidden className="pointer-events-none absolute top-0 h-full w-px bg-line-soft" style={{ left: 8 + i * 12 + 5 }} />
      ))}
      {row.isDir ? <ChevronRight size={12} className={cn("shrink-0 text-muted transition-transform duration-200 ease-out", open && "rotate-90")} /> : <span className="w-3 shrink-0" />}
      <Icon icon={icon} width={14} height={14} className="shrink-0" />
      <span className="truncate">{row.name}</span>
      {git && <span data-testid={`git-${row.path}`} className={cn("ml-auto shrink-0 pl-1 font-mono text-meta transition-opacity group-hover/row:opacity-0", selected && "opacity-0", GIT_TONE[git] ?? "text-accent/60")}>{git}</span>}
    </button>
  );
}
