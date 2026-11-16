import { memo, useState, useRef, useEffect, useId, useLayoutEffect } from "react";
import { isImeComposing, useRovingTabIndex } from "../lib/focus.js";
import { SHORTCUT, isDeleteKey, isMenuKey, isRenameKey, withShortcut } from "../lib/shortcuts.js";
import { ChevronRight, FolderGit2, Plus, Archive, Search, Loader2, MoreHorizontal, Settings2 } from "lucide-react";
import { useStore } from "../store/store.js";
import { useRepoTreeStore } from "../store/repotree.js";
import type { FleetRow, LogItem } from "../store/reduce.js";
import { cn } from "../lib/cn.js";
import { SIDEBAR_ROW, rowState } from "../lib/ui-tokens.js";
import { Input } from "../ui/input.js";
import { railClass, statusShortKey, statusLabelKey, isLive, isProvisioning } from "../lib/status.js";
import { baseName } from "../lib/path.js";
import { relativeTime, absoluteDate } from "../lib/relative-time.js";
import { ContextMenu, type AnchorRect, type MenuItem } from "../components/ContextMenu.js";
import { Collapse } from "../components/Collapse.js";
import { shortBranch } from "../lib/branch.js";
import { WorkerCost } from "../components/WorkerCost.js";
import { ProviderBadge } from "../components/StatusBadge.js";
import { ConfirmDialog } from "../ui/confirm-dialog.js";
import { LoadFailed } from "../ui/load-state.js";
import { SkeletonRows } from "../components/Skeleton.js";
import { useT, useLocale } from "../i18n/provider.js";

type Repo = { id?: string; name: string; path: string; description: string; base: string | null };

// A worker's label started life as its repo name (the spawn-time placeholder, see fleet-tools.ts) and was never
// upgraded by the daemon's async task-summary relabel (worker.label) — i.e. it's still the repo/folder fallback,
// not a real title. This is what makes sibling workers under one repo read as a wall of identical labels (audit #46).
function isFallbackLabel(sub: FleetRow, repoNameByPath: Map<string, string>): boolean {
  const repoName = repoNameByPath.get(sub.repoPath);
  return repoName !== undefined ? sub.label === repoName : sub.label === baseName(sub.repoPath);
}

// Last message timestamp already present in this worker's log — only filled in for a worker that's been viewed at
// least once this session (worker.history) or is actively streaming over the live @all channel (same opportunistic
// coverage as WorkerCost's cost figure below). No fetch is triggered for rows that haven't been opened yet.
function lastActivityTs(items: LogItem[]): number | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "message" && it.ts) return it.ts;
  }
  return null;
}

const EMPTY_LOG: LogItem[] = [];

// Disambiguating subline for a fleet row still on its spawn-time repo-name label (audit #46) — a dim relative-time
// line under the label. Subscribes narrowly to just this one worker's log (mirrors WorkerCost's per-row live read)
// so activity elsewhere in the fleet doesn't re-render every row; renders nothing until a timestamp is available.
// Worker labels come from model output / ticket titles and can carry stray control characters (a leading \b was
// seen in the wild), which render as an odd indent. Stripped for display only.
function cleanLabel(label: string, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  return label.replace(/[\u0000-\u001f\u007f]/g, "").trim() || fallback;
}

function WorkerActivity({ workerId, fleetTs }: { workerId: string; fleetTs?: number }): JSX.Element | null {
  const t = useT();
  const locale = useLocale();
  const logTs = useStore((s) => lastActivityTs(s.workerLogs[workerId] ?? EMPTY_LOG));
  const ts = Math.max(logTs ?? 0, fleetTs ?? 0) || null; // fleet snapshot covers never-opened workers; the live log wins when fresher
  if (ts === null) return null;
  // Within 7 days, relative time (i18n); beyond that, absolute date. Same convention as GitHistory's
  // commitDateLabel / AssistantMessage's timeLabel.
  const now = Date.now();
  const rel = relativeTime(ts, now);
  const label = !rel
    ? absoluteDate(ts, now, locale)
    : rel.unit === "now" ? t("relativeTime.justNow")
    : rel.unit === "m" ? t("relativeTime.minutesAgo", { n: rel.value })
    : rel.unit === "h" ? t("relativeTime.hoursAgo", { n: rel.value })
    : t("relativeTime.daysAgo", { n: rel.value });
  return <span className="truncate text-meta leading-tight text-muted/70">{label}</span>;
}

function RepoTreeImpl(p: {
  repos: Repo[];
  fleet: FleetRow[];
  loaded?: boolean; // fleet/repos have arrived → only then is "no repos" real (avoids the cold-connect false-empty flash)
  loadFailed?: boolean; // the initial fleet.list fetch was rejected and hasn't succeeded since → error+retry row instead of staying blank forever (audit #14)
  onRetry?: () => unknown; // (may return a promise → the Retry button shows progress/failure) re-fires fleet.list (cleared by the store once it succeeds)
  activeSubId: string | null;
  onSelectSub: (id: string) => void;
  onNewRepo: () => void;
  onRemoveRepo: (name: string) => void;
  onNewSub: (repoName: string) => void;
  onRepoSettings?: (repoId: string) => void;
  attention?: Record<string, boolean>; // workers that settled without being viewed → unread dot on the right of the row
  onStopSub?: (id: string) => void;
  onRenameSub?: (id: string, label: string) => void;
  onForkSub?: (id: string) => void; // right-click → fork this worker (duplicate context + worktree into a new worker)
  onArchiveSub?: (id: string, archived: boolean) => void;
  onDeleteSub?: (id: string) => void;
  onViewBranchDiff?: (id: string) => void; // worker menu → the whole-branch diff (fleet.diff) in a read-only tab (audit #84)
}): JSX.Element {
  const t = useT();
  // Fold state lives in a persisted store, NOT component state: the sidebar conditionally renders
  // RepoTree vs Sessions, so a tab switch unmounts this component — local state would re-expand
  // everything. localStorage persistence also carries it across app restarts.
  const collapsed = useRepoTreeStore((s) => s.collapsed);
  const setCollapsed = useRepoTreeStore((s) => s.setCollapsed);
  const archOpen = useRepoTreeStore((s) => s.archOpen); // archive collapsed by default
  const setArchOpen = useRepoTreeStore((s) => s.setArchOpen);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; rect?: AnchorRect } | null>(null);
  const [repoMenu, setRepoMenu] = useState<{ key: string; title: string; repoId?: string; removable: boolean; canAdd: boolean; x: number; y: number; rect?: AnchorRect } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; name: string } | null>(null);
  const [removeConfirm, setRemoveConfirm] = useState<{ name: string } | null>(null);
  const [q, setQ] = useState(""); // fleet-at-scale filter: by worker label
  const [onlyActive, setOnlyActive] = useState(false); // show only running/idle/unread workers
  // Worker rows are one tab stop (the open worker's row), Arrow keys move between them (audit #107).
  const listRef = useRef<HTMLDivElement | null>(null);
  const roving = useRovingTabIndex(listRef);
  const refocusRow = useRef<string | null>(null);
  useLayoutEffect(() => {
    const id = refocusRow.current;
    if (renaming || !id) return;
    refocusRow.current = null;
    Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-roving-item]") ?? []).find((el) => el.dataset.rowId === id)?.focus();
  }, [renaming]);
  // After a delete confirm closes, the row that opened it may already be gone: land on the list's stop, not <body>.
  const closeConfirm = (): void => {
    setConfirm(null);
    setTimeout(() => { if (!document.activeElement || document.activeElement === document.body) roving.focusStop(); }, 0);
  };
  const treeId = useId();
  // worker spawn appearance: workers present in the first non-empty fleet are excluded as the seed; only workers spawned afterward get the rise-in.
  // Membership is non-mutating, so the class stays for the row's whole lifetime (not re-evaluated) and the appearance isn't cut off by status-change re-renders.
  // When a view switch remounts RepoTree, the seed is re-captured from the current fleet so workers don't re-appear.
  const spawnSeedRef = useRef<Set<string> | null>(null);
  if (spawnSeedRef.current === null && p.fleet.length > 0) spawnSeedRef.current = new Set(p.fleet.map((f) => f.id));
  const isFreshSpawn = (id: string): boolean => spawnSeedRef.current !== null && !spawnSeedRef.current.has(id);
  // Drop fold keys of repos that were unregistered/renamed. Gated on a non-empty list so the
  // cold-connect snapshot (before repos.list arrives) can't wipe the saved state.
  useEffect(() => {
    if (p.repos.length > 0) useRepoTreeStore.getState().prune(new Set([...p.repos.map((r) => r.name), "__orphans__"]));
  }, [p.repos]);
  const knownPaths = new Set(p.repos.map((r) => r.path));
  const repoNameByPath = new Map(p.repos.map((r) => [r.path, r.name])); // for detecting the repo-name label fallback (audit #46)
  const live = p.fleet.filter((f) => !f.archived); // archived workers are hidden from the tree
  const archived = p.fleet.filter((f) => f.archived);
  // Fleet-at-scale filter — by label + an "only active" toggle. Groups auto-open while filtering so matches surface.
  const query = q.trim().toLowerCase();
  const filtering = query.length > 0 || onlyActive;
  // "Active" = not settled for good. `background` (bg tasks still running) is the most active state there is —
  // excluding it made a worker vanish from the tree in the middle of a Dynamic Workflow run.
  const isActiveWorker = (f: FleetRow): boolean =>
    f.status === "running" || f.status === "background" || f.status === "idle" || f.status === "provisioning" || !!p.attention?.[f.id];
  const matchWorker = (f: FleetRow): boolean => (!query || f.label.toLowerCase().includes(query)) && (!onlyActive || isActiveWorker(f));
  const shown = filtering ? live.filter(matchWorker) : live;
  const orphans = shown.filter((f) => !knownPaths.has(f.repoPath));

  const subButton = (sub: FleetRow) => {
    const active = sub.id === p.activeSubId;
    if (renaming?.id === sub.id) {
      return (
        <div key={sub.id} className="px-1 py-1">
          <Input
            size="sm"
            autoFocus
            value={renaming.value}
            onChange={(e) => setRenaming({ id: sub.id, value: e.target.value })}
            aria-label={t("repoTree.renameLabel", { name: cleanLabel(sub.label, sub.id) })}
            onKeyDown={(e) => {
              if (isImeComposing(e)) return; // the IME's committing Enter must not also commit the rename (audit #76)
              // A keyboard rename (Enter/Escape) puts focus back on the row; Escape is claimed so it doesn't also close the page.
              if (e.key === "Enter") { refocusRow.current = sub.id; p.onRenameSub?.(sub.id, renaming.value.trim() || sub.label); setRenaming(null); }
              else if (e.key === "Escape") { e.preventDefault(); refocusRow.current = sub.id; setRenaming(null); }
            }}
            onBlur={() => { p.onRenameSub?.(sub.id, renaming.value.trim() || sub.label); setRenaming(null); }}
            className="w-full"
          />
        </div>
      );
    }
    // Only rows still on the spawn-time repo-name placeholder get the disambiguating subline — a real (auto- or
    // user-)generated label is already distinguishing. WorkerActivity itself is opportunistic (see lastActivityTs):
    // it renders nothing until this worker's log has been loaded, so a never-viewed worker shows no subline yet.
    const fallback = isFallbackLabel(sub, repoNameByPath);
    return (
      <div key={sub.id} className={cn("group relative", isFreshSpawn(sub.id) && "rise-in")}>
        <button
          data-roving-item
          data-row-id={sub.id}
          aria-current={active ? "page" : undefined}
          aria-keyshortcuts={`${SHORTCUT.menu.aria} ${p.onRenameSub ? SHORTCUT.rename.aria : ""} ${p.onDeleteSub ? SHORTCUT.delete.aria() : ""}`.trim()}
          onClick={() => p.onSelectSub(sub.id)}
          onContextMenu={(e) => { e.preventDefault(); setMenu({ id: sub.id, x: e.clientX, y: e.clientY }); }}
          onKeyDown={(e) => {
            // Keyboard paths for the row's mouse actions (audit #107; the '⋯' is out of the tab order).
            if (isMenuKey(e)) {
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ id: sub.id, x: r.left + 12, y: r.bottom, rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right } });
            } else if (isRenameKey(e) && p.onRenameSub) {
              e.preventDefault();
              setRenaming({ id: sub.id, value: sub.label });
            } else if (isDeleteKey(e) && p.onDeleteSub) {
              e.preventDefault();
              setConfirm({ id: sub.id, name: sub.label });
            }
          }}
          className={cn(
            // Row geometry + selection come from lib/ui-tokens.ts, shared with Sessions.tsx (audit #76 #109). Two-line
            // (title+cost / branch+state) so the branch is visible without opening the worker (DESIGN shell anatomy).
            SIDEBAR_ROW,
            "flex-col gap-0.5",
            // Selected = the shared neutral lift. Status is carried by the dot (live) and the colored state tag further
            // along the row, not a rail.
            rowState(active),
          )}
        >
          {/* line 1: status dot + title + cost (right) */}
          <span className="flex w-full min-w-0 items-center gap-1.5 text-body">
            {isProvisioning(sub.status)
              ? <Loader2 size={12} className="shrink-0 animate-spin text-accent" />
              : isLive(sub.status) && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-run led-live" />}
            <span className="flex min-w-0 flex-1 flex-col">
              <span title={cleanLabel(sub.label, sub.id)} className={cn("truncate", p.attention?.[sub.id] && !active && "font-medium text-fg")}>{cleanLabel(sub.label, sub.id)}</span>
            </span>
            {/* Cost stays visible on hover: the '⋯' overflow button sits on line 2 (over the state tag, which yields),
                so nothing is ever painted over line 1. The compact form keeps a 5-figure spend from eating the title. */}
            <WorkerCost workerId={sub.id} fleetCost={sub.costUsd} compact />
          </span>
          {/* line 2: branch/id (mono, faint) + the state word (right, in its own colour) */}
          <span className={cn("flex w-full min-w-0 items-center gap-1.5", (isProvisioning(sub.status) || isLive(sub.status)) && "pl-3")}>
            <span className="min-w-0 flex-1 truncate font-mono text-meta text-faint" title={sub.branch || sub.id}>{shortBranch(sub.branch || sub.id)}</span>
            {fallback && <span className="shrink-0 text-meta text-faint"><WorkerActivity workerId={sub.id} fleetTs={sub.lastActivityTs} /></span>}
            {/* the provider badge lives on the meta line so the title keeps the whole first line */}
            {sub.provider === "codex" && <ProviderBadge provider={sub.provider} />}
            {/* colorblind-safe short tag stays as the visible glyph (dot alt-channel), carrying the state's own color
                (not mono — it's a status word, not a measurement) — but the title carries the full localized word,
                same label source as the header StatusBadge, so tree and header never disagree (audit #50: tree used
                to say 'ORPH' while the header said 'orphaned'). */}
            <span title={t(statusLabelKey(sub.status))} className={cn("shrink-0 text-meta font-medium transition-opacity group-hover:opacity-0 group-focus-within:opacity-0", railClass(sub.status).replace("bg-", "text-"))}>{t(statusShortKey(sub.status))}</span>
            {/* unread: worker that finished without being viewed — dot on the right (neutral = ready, red = error; the blue dot
                means "working", so unread doesn't borrow it — audit #100). Disappears once viewed (select). */}
            {p.attention?.[sub.id] && !active && (
              <span title={t("repoTree.unreadTitle")} className={cn("dot-pop h-2 w-2 shrink-0 rounded-full transition-opacity group-hover:opacity-0 group-focus-within:opacity-0", sub.status === "error" || sub.status === "failed" ? "bg-fail" : "bg-fg-dim")} />
            )}
          </span>
        </button>
        {/* overflow '⋯' — worker rows previously had zero hover actions and the menu was right-click-only (audit #45; macOS
            has no context-menu key for keyboard users). Opens the SAME menu, reachable by left-click/Enter, positioned at the button. */}
        <button
          tabIndex={-1}
          title={withShortcut(t("common.moreActions"), SHORTCUT.menu.label())}
          aria-label={t("common.moreActionsFor", { name: cleanLabel(sub.label, sub.id) })}
          aria-haspopup="menu"
          onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setMenu({ id: sub.id, x: r.left, y: r.bottom + 4, rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right } }); }}
          className="absolute bottom-0.5 right-1.5 rounded p-0.5 text-muted opacity-0 transition-opacity hover:bg-line/60 hover:text-fg-dim group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
    );
  };

  const group = (key: string, title: string, subs: FleetRow[], opts: { removable: boolean; canAdd: boolean; repoId?: string }) => {
    const foldable = subs.length > 0; // collapsible only when there are workers. Otherwise just a flat header.
    const groupId = `${treeId}-group-${key.replace(/\s+/g, "_")}`; // aria-controls target (ids can't hold whitespace)
    const open = foldable && (filtering || !collapsed[key]); // filtering forces groups open so matches surface
    const headerInner = (
      <>
        <ChevronRight size={12} className={cn("shrink-0 text-muted transition-transform duration-200 ease-out", !foldable && "invisible", open && "rotate-90")} />
        <FolderGit2 size={14} className="shrink-0 text-muted" />
        <span title={title} className="truncate text-body font-medium text-fg">{title}</span>
        <span className="ml-auto shrink-0 pl-1 text-meta tabular-nums text-faint">{subs.length}</span>
      </>
    );
    // Row actions show on hover/focus only (audit #83); the always-visible spawn entry is the sidebar's "New worker"
    // row. Unregister lives in the ⋯ menu (also on right-click) instead of one slip away from +.
    const reveal = "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100";
    const hasMenu = opts.canAdd || opts.removable || (!!opts.repoId && !!p.onRepoSettings);
    const openRepoMenu = (x: number, y: number, rect?: AnchorRect): void => setRepoMenu({ key, title, repoId: opts.repoId, removable: opts.removable, canAdd: opts.canAdd, x, y, rect });
    return (
      <div key={key}>
        <div
          className="group flex items-center rounded-md pr-1 hover:bg-raised/60"
          onContextMenu={hasMenu ? (e) => { e.preventDefault(); openRepoMenu(e.clientX, e.clientY); } : undefined}
        >
          {foldable ? (
            <button onClick={() => setCollapsed(key, open)} aria-expanded={open} aria-controls={groupId} className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left">
              {headerInner}
            </button>
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5">{headerInner}</div>
          )}
          {opts.canAdd && (
            <button
              onClick={() => p.onNewSub(key)}
              aria-label={t("repoTree.spawnWorker")}
              title={t("repoTree.spawnWorker")}
              className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-fg", reveal)}
            >
              <Plus size={14} />
            </button>
          )}
          {opts.repoId && p.onRepoSettings && (
            <button
              onClick={() => p.onRepoSettings?.(opts.repoId!)}
              aria-label={t("repoTree.repoSettings", { repo: title })}
              title={t("repoTree.repoSettings", { repo: title })}
              className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-fg", reveal)}
            >
              <Settings2 size={14} />
            </button>
          )}
          {hasMenu && (
            <button
              onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); openRepoMenu(r.left, r.bottom + 4, { top: r.top, bottom: r.bottom, left: r.left, right: r.right }); }}
              aria-label={t("repoTree.repoMenu", { repo: title })}
              title={t("repoTree.repoMenu", { repo: title })}
              aria-haspopup="menu"
              className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-fg", reveal)}
            >
              <MoreHorizontal size={14} />
            </button>
          )}
        </div>
        <Collapse open={open} id={groupId}>
          <div className="ml-3 flex flex-col gap-0.5 border-l border-line pl-2">
            {subs.map(subButton)}
          </div>
        </Collapse>
      </div>
    );
  };

  const menuSub = menu ? p.fleet.find((x) => x.id === menu.id) : undefined;

  return (
    <div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-x-hidden overflow-y-auto">
      {live.length > 4 && (
        <div className="mx-1 mb-1 flex items-center gap-1.5 rounded-md border border-line bg-ink/40 px-2 py-1 transition-colors focus-within:border-accent/50">
          <Search size={12} className="shrink-0 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("repoTree.filterPlaceholder")} aria-label={t("repoTree.filterPlaceholder")} className="min-w-0 flex-1 bg-transparent text-meta text-fg-dim placeholder:text-muted focus:outline-none" />
          <button onClick={() => setOnlyActive((v) => !v)} title={t("repoTree.onlyActiveTitle")} aria-pressed={onlyActive} className={cn("shrink-0 rounded px-1.5 py-0.5 text-meta font-medium transition-colors", onlyActive ? "bg-raised text-fg" : "text-muted hover:text-fg-dim")}>
            {t("repoTree.onlyActive")}
          </button>
        </div>
      )}
      {!(p.loaded ?? true) && p.loadFailed ? (
        <LoadFailed message={t("repoTree.loadFailed")} onRetry={() => p.onRetry?.()} />
      ) : !(p.loaded ?? true) ? (
        <SkeletonRows rows={4} className="px-2" />
      ) : (
        (p.loaded ?? true) && p.repos.length === 0 && orphans.length === 0 && <div className="px-2 py-3 text-ui leading-relaxed text-muted">{t("repoTree.emptyState")}</div>
      )}
      {p.repos.filter((repo) => !filtering || shown.some((f) => f.repoPath === repo.path)).map((repo) => group(repo.name, repo.name, shown.filter((f) => f.repoPath === repo.path), { removable: true, canAdd: true, ...(repo.id ? { repoId: repo.id } : {}) }))}
      {orphans.length > 0 && group("__orphans__", t("repoTree.uncategorized"), orphans, { removable: false, canAdd: false })}
      {filtering && shown.length === 0 && <div className="px-2 py-3 text-ui text-muted">{t("repoTree.noMatches")}</div>}

      {archived.length > 0 && (
        <div className="mt-1">
          <button onClick={() => setArchOpen(!archOpen)} aria-expanded={archOpen} className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-meta font-medium text-faint hover:text-fg-dim">
            <ChevronRight size={12} className={cn("transition-transform duration-200 ease-out", archOpen && "rotate-90")} />
            <Archive size={12} /> {t("repoTree.archivedSection", { count: archived.length })}
          </button>
          <Collapse open={archOpen}><div className="ml-3 flex flex-col gap-0.5 border-l border-line pl-2 opacity-80">{archived.map(subButton)}</div></Collapse>
        </div>
      )}

      <button
        onClick={p.onNewRepo}
        className="mt-1 flex h-[26px] items-center gap-1.5 rounded-md px-2 text-body text-muted transition-colors hover:bg-raised hover:text-fg-dim"
      >
        <Plus size={14} className="shrink-0" /> {t("repoTree.newRepo")}
      </button>

      {menu && menuSub && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          anchorRect={menu.rect}
          onClose={() => setMenu(null)}
          items={[
            { label: t("repoTree.menuRename"), shortcut: { label: SHORTCUT.rename.label(), aria: SHORTCUT.rename.aria }, onClick: () => setRenaming({ id: menu.id, value: menuSub.label }) },
            { label: t("repoTree.menuFork"), onClick: () => p.onForkSub?.(menu.id) },
            ...(p.onViewBranchDiff ? [{ label: t("repoTree.menuBranchDiff"), hint: t("repoTree.menuBranchDiffHint"), onClick: () => p.onViewBranchDiff?.(menu.id) }] : []),
            // stop: whenever the worker is not terminal (running/background/idle) — keeps the worktree and pauses
            // (resumable). `background` especially: fleet.stop tears down the subprocess tree and is the ONLY way
            // to kill background tasks (interrupt aborts a turn and deliberately leaves them alive), so hiding it
            // here left a background worker with no stop path at all.
            ...(menuSub.status === "running" || menuSub.status === "background" || menuSub.status === "idle"
              ? [{ label: t("repoTree.menuStop"), hint: t("repoTree.menuStopHint"), onClick: () => p.onStopSub?.(menu.id) }]
              : []),
            { label: menuSub.archived ? t("repoTree.menuUnarchive") : t("repoTree.menuArchive"), onClick: () => p.onArchiveSub?.(menu.id, !menuSub.archived) },
            { label: t("repoTree.menuDelete"), hint: t("repoTree.menuDeleteHint"), danger: true, shortcut: { label: SHORTCUT.delete.label(), aria: SHORTCUT.delete.aria() }, onClick: () => setConfirm({ id: menu.id, name: menuSub.label }) },
          ]}
        />
      )}

      {repoMenu && (
        <ContextMenu
          x={repoMenu.x}
          y={repoMenu.y}
          anchorRect={repoMenu.rect}
          onClose={() => setRepoMenu(null)}
          items={[
            ...(repoMenu.canAdd ? [{ label: t("repoTree.spawnWorker"), onClick: () => p.onNewSub(repoMenu.key) }] : []),
            ...(repoMenu.repoId && p.onRepoSettings ? [{ label: t("repoTree.repoSettings", { repo: repoMenu.title }), onClick: () => p.onRepoSettings?.(repoMenu.repoId!) }] : []),
            ...(repoMenu.removable ? [{ label: t("repoTree.menuRemoveRepo"), hint: t("repoTree.menuRemoveRepoHint"), danger: true, onClick: () => setRemoveConfirm({ name: repoMenu.key }) }] : []),
          ] satisfies MenuItem[]}
        />
      )}

      {confirm && (
        <ConfirmDialog
          title={t("repoTree.deleteWorkerTitle")}
          body={t("repoTree.deleteWorkerConfirm", { name: confirm.name })}
          confirmLabel={t("common.delete")}
          variant="danger"
          onCancel={closeConfirm}
          onConfirm={() => p.onDeleteSub?.(confirm.id)}
        />
      )}

      {removeConfirm && (
        // Repo-remove confirm (audit #19) — unregisters the repo row only (files on disk are untouched), but its
        // workers immediately jump to the "Other (unregistered)" group, so it gets the same weight of confirm as worker delete.
        <ConfirmDialog
          title={t("repoTree.removeRepo")}
          body={t("repoTree.removeConfirmBody", { name: removeConfirm.name })}
          confirmLabel={t("repoTree.removeRepo")}
          variant="danger"
          onCancel={() => setRemoveConfirm(null)}
          onConfirm={() => p.onRemoveRepo(removeConfirm.name)}
        />
      )}
    </div>
  );
}

export const RepoTree = memo(RepoTreeImpl);
RepoTree.displayName = "RepoTree";
