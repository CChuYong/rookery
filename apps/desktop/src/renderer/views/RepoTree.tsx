import { memo, useState, useRef } from "react";
import { ChevronRight, FolderGit2, Plus, Trash2, Archive, Search, Loader2, MoreHorizontal } from "lucide-react";
import { useStore } from "../store/store.js";
import type { FleetRow, LogItem } from "../store/reduce.js";
import { cn } from "../lib/cn.js";
import { railClass, statusTag, statusLabelKey, isLive, isProvisioning } from "../lib/status.js";
import { baseName } from "../lib/path.js";
import { relativeTime, absoluteDate } from "../lib/relative-time.js";
import { ContextMenu } from "../components/ContextMenu.js";
import { Collapse } from "../components/Collapse.js";
import { WorkerCost, FleetBurn } from "../components/WorkerCost.js";
import { ConfirmDialog } from "../ui/confirm-dialog.js";
import { useT, useLocale } from "../i18n/provider.js";

type Repo = { name: string; path: string; description: string; base: string | null };

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
  return <span className="truncate text-[10px] leading-tight text-muted/70">{label}</span>;
}

function RepoTreeImpl(p: {
  repos: Repo[];
  fleet: FleetRow[];
  loaded?: boolean; // fleet/repos have arrived → only then is "no repos" real (avoids the cold-connect false-empty flash)
  loadFailed?: boolean; // the initial fleet.list fetch was rejected and hasn't succeeded since → error+retry row instead of staying blank forever (audit #14)
  onRetry?: () => void; // re-fires fleet.list (cleared by the store once it succeeds)
  activeSubId: string | null;
  onSelectSub: (id: string) => void;
  onNewRepo: () => void;
  onRemoveRepo: (name: string) => void;
  onNewSub: (repoName: string) => void;
  attention?: Record<string, boolean>; // workers that settled without being viewed → unread dot on the right of the row
  onStopSub?: (id: string) => void;
  onRenameSub?: (id: string, label: string) => void;
  onForkSub?: (id: string) => void; // right-click → fork this worker (duplicate context + worktree into a new worker)
  onArchiveSub?: (id: string, archived: boolean) => void;
  onDeleteSub?: (id: string) => void;
}): JSX.Element {
  const t = useT();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [archOpen, setArchOpen] = useState(false); // archive collapsed by default
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; name: string } | null>(null);
  const [removeConfirm, setRemoveConfirm] = useState<{ name: string } | null>(null);
  const [q, setQ] = useState(""); // fleet-at-scale filter: by worker label
  const [onlyActive, setOnlyActive] = useState(false); // show only running/idle/unread workers
  // worker spawn appearance: workers present in the first non-empty fleet are excluded as the seed; only workers spawned afterward get the rise-in.
  // Membership is non-mutating, so the class stays for the row's whole lifetime (not re-evaluated) and the appearance isn't cut off by status-change re-renders.
  // When a view switch remounts RepoTree, the seed is re-captured from the current fleet so workers don't re-appear.
  const spawnSeedRef = useRef<Set<string> | null>(null);
  if (spawnSeedRef.current === null && p.fleet.length > 0) spawnSeedRef.current = new Set(p.fleet.map((f) => f.id));
  const isFreshSpawn = (id: string): boolean => spawnSeedRef.current !== null && !spawnSeedRef.current.has(id);
  const knownPaths = new Set(p.repos.map((r) => r.path));
  const repoNameByPath = new Map(p.repos.map((r) => [r.path, r.name])); // for detecting the repo-name label fallback (audit #46)
  const live = p.fleet.filter((f) => !f.archived); // archived workers are hidden from the tree
  const archived = p.fleet.filter((f) => f.archived);
  // Fleet-at-scale filter — by label + an "only active" toggle. Groups auto-open while filtering so matches surface.
  const query = q.trim().toLowerCase();
  const filtering = query.length > 0 || onlyActive;
  const isActiveWorker = (f: FleetRow): boolean => f.status === "running" || f.status === "idle" || f.status === "provisioning" || !!p.attention?.[f.id];
  const matchWorker = (f: FleetRow): boolean => (!query || f.label.toLowerCase().includes(query)) && (!onlyActive || isActiveWorker(f));
  const shown = filtering ? live.filter(matchWorker) : live;
  const orphans = shown.filter((f) => !knownPaths.has(f.repoPath));

  const subButton = (sub: FleetRow) => {
    const active = sub.id === p.activeSubId;
    if (renaming?.id === sub.id) {
      return (
        <div key={sub.id} className="px-1 py-1">
          <input
            autoFocus
            value={renaming.value}
            onChange={(e) => setRenaming({ id: sub.id, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") { p.onRenameSub?.(sub.id, renaming.value.trim() || sub.label); setRenaming(null); }
              else if (e.key === "Escape") setRenaming(null);
            }}
            onBlur={() => { p.onRenameSub?.(sub.id, renaming.value.trim() || sub.label); setRenaming(null); }}
            className="w-full rounded-md border border-accent/60 bg-ink px-2 py-1 text-[12.5px] text-fg outline-none"
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
          onClick={() => p.onSelectSub(sub.id)}
          onContextMenu={(e) => { e.preventDefault(); setMenu({ id: sub.id, x: e.clientX, y: e.clientY }); }}
          className={cn(
            // Row scale shared with Sessions.tsx (audit #76) — one sidebar-list token set for both tabs.
            "relative flex w-full items-center gap-1.5 rounded-md py-1.5 pl-3 pr-2.5 text-left text-[12.5px] transition-colors",
            active ? "bg-accent/15 text-fg" : "text-fg-dim hover:bg-raised hover:text-fg",
          )}
        >
          {/* left channel rail = result status (color), dot = live pulse (running only), spinner = provisioning (worktree being created) */}
          <span className={cn("absolute left-0.5 top-1.5 bottom-1.5 w-[2.5px] rounded-full transition-colors duration-200", active ? "bg-accent" : railClass(sub.status))} />
          {isProvisioning(sub.status)
            ? <Loader2 size={11} className="shrink-0 animate-spin text-accent" />
            : isLive(sub.status) && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-run led-live" />}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className={cn("truncate", p.attention?.[sub.id] && !active && "font-semibold text-fg")}>{sub.label}</span>
            {fallback && <WorkerActivity workerId={sub.id} fleetTs={sub.lastActivityTs} />}
          </span>
          {/* right-side indicators (cost/tag/unread) yield to the '⋯' overflow button on hover — otherwise the
              absolutely-positioned button overlaps them and the tag's full-word title becomes unreachable (audit
              final-review F1). Same idiom as Sessions.tsx's OriginBadge/unread-dot hover yield. */}
          <span className="shrink-0 transition-opacity group-hover:opacity-0"><WorkerCost workerId={sub.id} fleetCost={sub.costUsd} /></span>
          {/* colorblind-safe short tag stays as the visible glyph (rail/dot alt-channel), but the title carries the
              full localized word — same label source as the header StatusBadge, so tree and header never disagree
              (audit #50: tree used to say 'ORPH' while the header said 'orphaned'). */}
          <span title={t(statusLabelKey(sub.status))} className="shrink-0 font-mono text-[8.5px] tracking-wide text-muted transition-opacity group-hover:opacity-0">{statusTag(sub.status)}</span>
          {/* unread: worker that finished without being viewed — dot on the right (ready=green / error=red). Disappears once viewed (select). */}
          {p.attention?.[sub.id] && !active && (
            <span title={t("repoTree.unreadTitle")} className={cn("dot-pop h-2 w-2 shrink-0 rounded-full transition-opacity group-hover:opacity-0", sub.status === "error" || sub.status === "failed" ? "bg-fail" : "bg-run")} />
          )}
        </button>
        {/* overflow '⋯' — worker rows previously had zero hover actions and the menu was right-click-only (audit #45; macOS
            has no context-menu key for keyboard users). Opens the SAME menu, reachable by left-click/Enter, positioned at the button. */}
        <button
          title={t("common.moreActions")}
          aria-label={t("common.moreActions")}
          onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setMenu({ id: sub.id, x: r.left, y: r.bottom + 4 }); }}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted opacity-0 transition-opacity hover:bg-line/60 hover:text-fg-dim group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
        >
          <MoreHorizontal size={13} />
        </button>
      </div>
    );
  };

  const group = (key: string, title: string, subs: FleetRow[], opts: { removable: boolean; canAdd: boolean }) => {
    const foldable = subs.length > 0; // collapsible only when there are workers. Otherwise just a flat header.
    const open = foldable && (filtering || !collapsed[key]); // filtering forces groups open so matches surface
    const headerInner = (
      <>
        <ChevronRight size={13} className={cn("shrink-0 text-muted transition-transform duration-200 ease-out", !foldable && "invisible", open && "rotate-90")} />
        <FolderGit2 size={13} className="shrink-0 text-accent/70" />
        <span className="truncate">{title}</span>
        <span className="ml-auto font-mono text-[10px] text-muted">{subs.length}</span>
      </>
    );
    return (
      <div key={key}>
        <div className="group flex items-center rounded-lg pr-1 hover:bg-raised/60">
          {foldable ? (
            <button onClick={() => setCollapsed((c) => ({ ...c, [key]: open }))} className="flex flex-1 items-center gap-1.5 px-2 py-1.5 text-left text-[12.5px] font-medium text-fg-dim">
              {headerInner}
            </button>
          ) : (
            <div className="flex flex-1 items-center gap-1.5 px-2 py-1.5 text-[12.5px] font-medium text-fg-dim">{headerInner}</div>
          )}
          {opts.canAdd && (
            // Stays in the layout + tab order (opacity, not display:none) so it's keyboard-reachable — the hover-only
            // '+' was the sole GUI entry point for spawning a worker and was invisible to keyboard users (audit #3).
            <button
              onClick={() => p.onNewSub(key)}
              aria-label={t("repoTree.spawnWorker")}
              title={t("repoTree.spawnWorker")}
              className="flex h-6 w-6 items-center justify-center rounded text-muted opacity-0 transition-opacity hover:text-accent group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
            >
              <Plus size={13} />
            </button>
          )}
          {opts.removable && (
            <button
              onClick={() => setRemoveConfirm({ name: key })}
              aria-label={t("repoTree.removeRepo")}
              title={t("repoTree.removeRepo")}
              className="flex h-6 w-6 items-center justify-center rounded text-muted opacity-0 transition-opacity hover:text-fail group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
        <Collapse open={open}>
          <div className="ml-3 flex flex-col gap-0.5 border-l border-line pl-2">
            {subs.map(subButton)}
          </div>
        </Collapse>
      </div>
    );
  };

  const menuSub = menu ? p.fleet.find((x) => x.id === menu.id) : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
      <FleetBurn rows={live} />
      {live.length > 4 && (
        <div className="mx-1 mb-1 flex items-center gap-1.5 rounded-md border border-line bg-ink/40 px-2 py-1 transition-colors focus-within:border-accent/50">
          <Search size={11} className="shrink-0 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("repoTree.filterPlaceholder")} className="min-w-0 flex-1 bg-transparent text-[11px] text-fg-dim placeholder:text-muted focus:outline-none" />
          <button onClick={() => setOnlyActive((v) => !v)} title={t("repoTree.onlyActiveTitle")} aria-pressed={onlyActive} className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors", onlyActive ? "bg-run/15 text-run" : "text-muted hover:text-fg-dim")}>
            {t("repoTree.onlyActive")}
          </button>
        </div>
      )}
      {!(p.loaded ?? true) && p.loadFailed ? (
        <div className="flex items-center justify-between gap-2 px-2 py-3 text-[12px] leading-relaxed">
          <span className="text-fail">{t("repoTree.loadFailed")}</span>
          <button onClick={p.onRetry} className="shrink-0 rounded-md border border-line px-2 py-0.5 text-[11px] text-muted hover:bg-raised hover:text-fg-dim">{t("common.retry")}</button>
        </div>
      ) : (
        (p.loaded ?? true) && p.repos.length === 0 && orphans.length === 0 && <div className="px-2 py-3 text-[12px] leading-relaxed text-muted">{t("repoTree.emptyState")}</div>
      )}
      {p.repos.filter((repo) => !filtering || shown.some((f) => f.repoPath === repo.path)).map((repo) => group(repo.name, repo.name, shown.filter((f) => f.repoPath === repo.path), { removable: true, canAdd: true }))}
      {orphans.length > 0 && group("__orphans__", t("repoTree.uncategorized"), orphans, { removable: false, canAdd: false })}
      {filtering && shown.length === 0 && <div className="px-2 py-3 text-[12px] text-muted">{t("repoTree.noMatches")}</div>}

      {archived.length > 0 && (
        <div className="mt-1">
          <button onClick={() => setArchOpen((v) => !v)} className="eyebrow flex w-full items-center gap-1.5 px-2 py-1.5 text-left eyebrow-sm font-medium uppercase text-muted hover:text-fg-dim">
            <ChevronRight size={11} className={cn("transition-transform duration-200 ease-out", archOpen && "rotate-90")} />
            <Archive size={11} /> {t("repoTree.archive")} {archived.length}
          </button>
          <Collapse open={archOpen}><div className="ml-3 flex flex-col gap-0.5 border-l border-line pl-2 opacity-80">{archived.map(subButton)}</div></Collapse>
        </div>
      )}

      <button
        onClick={p.onNewRepo}
        className="mt-1.5 flex items-center gap-1.5 rounded-lg border border-dashed border-line px-2.5 py-2 text-[12.5px] text-muted transition-colors hover:border-accent/40 hover:text-fg-dim"
      >
        <Plus size={14} /> {t("repoTree.newRepo")}
      </button>

      {menu && menuSub && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: t("repoTree.menuRename"), onClick: () => setRenaming({ id: menu.id, value: menuSub.label }) },
            { label: t("repoTree.menuFork"), onClick: () => p.onForkSub?.(menu.id) },
            // stop: only when in progress (running/idle) — keeps the worktree and pauses (resumable).
            ...(menuSub.status === "running" || menuSub.status === "idle" ? [{ label: t("repoTree.menuStop"), onClick: () => p.onStopSub?.(menu.id) }] : []),
            { label: menuSub.archived ? t("repoTree.menuUnarchive") : t("repoTree.menuArchive"), onClick: () => p.onArchiveSub?.(menu.id, !menuSub.archived) },
            { label: t("repoTree.menuDelete"), danger: true, onClick: () => setConfirm({ id: menu.id, name: menuSub.label }) },
          ]}
        />
      )}

      {confirm && (
        <ConfirmDialog
          title={t("repoTree.deleteWorkerTitle")}
          body={<><span className="text-fg-dim">{confirm.name}</span>{t("repoTree.deleteWorkerConfirm")}</>}
          confirmLabel={t("common.delete")}
          variant="danger"
          onCancel={() => setConfirm(null)}
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
