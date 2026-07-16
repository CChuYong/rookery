import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { ChevronRight, FilePlus, FolderPlus, ChevronsDownUp, RefreshCw, Search } from "lucide-react";
import { Icon } from "@iconify/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useWsStore } from "../store/workspace.js";
import { cn } from "../lib/cn.js";
import { fileIcon, FOLDER_ICON, FOLDER_OPEN_ICON } from "../lib/fileIcon.js";
import { GIT_TONE } from "../lib/gitTone.js";
import { ContextMenu, type MenuItem } from "./ContextMenu.js";
import { flatten, ancestorDirs, parentDir, fuzzyFilter, type Entry, type Row } from "../lib/filetree-model.js";
import { Input } from "../ui/input.js";
import { Button } from "../ui/button.js";
import { ConfirmDialog } from "../ui/confirm-dialog.js";
import { SkeletonRows } from "./Skeleton.js";
import { toast } from "../store/toasts.js";
import { useDismissTransition } from "../lib/useDismissTransition.js";
import { useModalKeys } from "../lib/useModalKeys.js";
import { useFocusTrap } from "../lib/useFocusTrap.js";
import { useT } from "../i18n/provider.js";

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
  // In-app replacements for native window.prompt/confirm (which block the renderer thread + break the ink deck).
  const [nameDialog, setNameDialog] = useState<{ kind: "newFile" | "newFolder" | "rename"; dir?: string; target?: Row; initial: string } | null>(null);
  const [trashTarget, setTrashTarget] = useState<Row | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
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
    void window.rookery.ws.walk(root).then((r) => { if (live) setWalkPaths(r.paths); }).catch(() => {});
    return () => { live = false; };
  }, [filtering, root, version, reloadKey]);

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

  const onKeyDown = (e: ReactKeyboardEvent): void => {
    if (filtering || rows.length === 0) return;
    const idx = rows.findIndex((r) => r.path === selected);
    const cur = idx >= 0 ? rows[idx] : null;
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

  // Run the op the name dialog collected; errors surface as toasts (no blocking native alert). The dialog is already
  // closed by the time this runs, so a rejection (rename/mkdir target gone, permission denied, etc.) must be caught
  // here or it silently vanishes as an unhandled rejection while the UI shows no reaction at all (#11).
  async function submitName(name: string): Promise<void> {
    const d = nameDialog;
    setNameDialog(null);
    const nm = name.trim();
    if (!d || !nm) return;
    try {
      if (d.kind === "newFile" && d.dir) {
        const r = await window.rookery.ws.createFile(`${d.dir}/${nm}`);
        if (r.exists) { toast.error(t("fileTree.fileExistsAlert")); return; }
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
    } catch (e) {
      toast.error(t("fileTree.opFailed"), String(e));
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
    items.push({ label: t("fileTree.rename"), onClick: () => void onRename(row) });
    items.push({ label: t("fileTree.copyPath"), onClick: () => void navigator.clipboard?.writeText(row.path) });
    items.push({ label: t("common.delete"), danger: true, onClick: () => void onDelete(row) });
    return items;
  }

  const ToolBtn = ({ label, onClick, children }: { label: string; onClick: () => void; children: JSX.Element }): JSX.Element => (
    <button aria-label={label} title={label} onClick={onClick} className="rounded p-1 text-muted hover:bg-raised hover:text-fg-dim">{children}</button>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-7 shrink-0 items-center justify-end gap-0.5 border-b border-line/60 px-1.5">
        <ToolBtn label={t("fileTree.newFile")} onClick={() => void onCreateFile(root)}><FilePlus size={13} /></ToolBtn>
        <ToolBtn label={t("fileTree.newFolder")} onClick={() => void onCreateFolder(root)}><FolderPlus size={13} /></ToolBtn>
        <ToolBtn label={t("fileTree.collapseAll")} onClick={() => collapseAllDirs(pageKey)}><ChevronsDownUp size={13} /></ToolBtn>
        <ToolBtn label={t("common.refresh")} onClick={() => setReloadKey((k) => k + 1)}><RefreshCw size={13} /></ToolBtn>
      </div>
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-line/60 px-2 transition-colors focus-within:border-accent/50">
        <Search size={11} className="shrink-0 text-muted" />
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("fileTree.searchPlaceholder")} className="w-full bg-transparent text-[12px] text-fg-dim placeholder:text-muted focus:outline-none" />
      </div>
      <div ref={bodyRef} data-testid="filetree-body" role="tree" tabIndex={0} onKeyDown={onKeyDown} className="min-h-0 flex-1 overflow-y-auto py-1 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/40">
        {filtering && matches.length === 0 ? (
          <div className="px-3 py-3 text-[12px] text-muted">{t("fileTree.noMatches")}</div>
        ) : !filtering && rootStatus === "loading" ? (
          <SkeletonRows rows={8} />
        ) : !filtering && rootStatus === "error" ? (
          // The whole string doubles as the retry button's label (same convention as CheckpointMenu.loadFailed).
          <button onClick={() => setReloadKey((k) => k + 1)} className="w-full px-3 py-3 text-left text-[12px] text-fail hover:bg-fail/10">
            {t("fileTree.loadFailed")}
          </button>
        ) : !filtering && rows.length === 0 ? (
          <div className="px-3 py-3 text-[12px] text-muted">{t("fileTree.emptyFolder")}</div>
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
                  return (
                    <button key={rel} style={style} onClick={() => openFile(pageKey, `${root}/${rel}`)} className="flex h-7 w-full items-center gap-1.5 rounded px-2.5 text-left text-[12px] text-fg-dim hover:bg-raised">
                      <Icon icon={fileIcon(rel)} width={14} height={14} className="shrink-0" />
                      <span className="truncate">{rel}</span>
                    </button>
                  );
                }
                const r = rows[vi.index]!;
                return (
                  <div key={r.path} style={style}>
                    <FileRow row={r} active={r.path === activeTabPath} selected={r.path === selected} open={r.isDir && expanded.has(r.path)} git={git.get(r.path)}
                      onClick={() => { setSelected(r.path); r.isDir ? toggleDir(pageKey, r.path) : openFile(pageKey, r.path); }}
                      onContextMenu={(e) => { e.preventDefault(); setSelected(r.path); setMenu({ x: e.clientX, y: e.clientY, row: r }); }} />
                  </div>
                );
              });
            })()}
          </div>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.row)} onClose={() => setMenu(null)} />}
      {nameDialog && (
        <NameDialog title={nameDialogTitle(nameDialog.kind)} initial={nameDialog.initial} onSubmit={(name) => void submitName(name)} onCancel={() => setNameDialog(null)} />
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

// In-app name prompt (new file/folder/rename) — replaces window.prompt. Focus-trapped, on-brand, non-blocking.
function NameDialog({ title, initial, onSubmit, onCancel }: { title: string; initial: string; onSubmit: (name: string) => void; onCancel: () => void }): JSX.Element {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState(initial);
  const { closing, dismiss } = useDismissTransition(onCancel);
  const submit = (): void => { const v = value.trim(); if (v) onSubmit(v); dismiss(); };
  useModalKeys({ escape: "ignore", onSubmit: submit });
  useFocusTrap(panelRef);
  return (
    <div className={cn("fixed inset-0 z-[110] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm", closing ? "motion-safe:animate-[overlay-out_130ms_ease-in]" : "motion-safe:animate-[overlay-in_140ms_ease-out]")}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={title} className={cn("flex w-[340px] flex-col gap-3 rounded-xl border border-line bg-surface p-4", closing ? "motion-safe:animate-[dialog-out_140ms_ease-in]" : "motion-safe:animate-[dialog-in_160ms_ease-out]")}>
        <div className="text-[13px] font-semibold">{title}</div>
        <Input autoFocus value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
        <div className="flex justify-end gap-2">
          {/* audit #73 — was a raw button (rounded-lg 8px) beside the Button-based confirm (--radius 10px); promoted
              to Button so the pair no longer visibly mismatch in height/rounding. */}
          <Button variant="outline" size="sm" onClick={dismiss}>{t("common.cancel")}</Button>
          <Button variant="primary" size="sm" onClick={submit}>{t("common.confirm")}</Button>
        </div>
      </div>
    </div>
  );
}

function FileRow({ row, active, selected, open, git, onClick, onContextMenu }: { row: Row; active: boolean; selected: boolean; open: boolean; git?: string; onClick: () => void; onContextMenu: (e: ReactMouseEvent) => void }): JSX.Element {
  const icon = row.isDir ? (open ? FOLDER_OPEN_ICON : FOLDER_ICON) : fileIcon(row.name);
  return (
    <button
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
      className={cn("flex h-6 w-full items-center gap-1 rounded pr-2 text-left text-[12px] hover:bg-raised", active ? "bg-accent/15 text-fg" : selected ? "bg-raised text-fg" : "text-fg-dim")}
    >
      {row.isDir ? <ChevronRight size={12} className={cn("shrink-0 text-muted transition-transform duration-200 ease-out", open && "rotate-90")} /> : <span className="w-3 shrink-0" />}
      <Icon icon={icon} width={14} height={14} className="shrink-0" />
      <span className="truncate">{row.name}</span>
      {git && <span data-testid={`git-${row.path}`} className={cn("ml-auto shrink-0 pl-1 font-mono text-[10px]", GIT_TONE[git] ?? "text-accent/60")}>{git}</span>}
    </button>
  );
}
