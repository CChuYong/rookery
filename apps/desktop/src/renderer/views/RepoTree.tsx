import { memo, useState, useRef } from "react";
import { ChevronRight, FolderGit2, Plus, Trash2, Archive, Search, Loader2 } from "lucide-react";
import type { FleetRow } from "../store/reduce.js";
import { cn } from "../lib/cn.js";
import { railClass, statusTag, isLive, isProvisioning } from "../lib/status.js";
import { ContextMenu } from "../components/ContextMenu.js";
import { Collapse } from "../components/Collapse.js";
import { WorkerCost, FleetBurn } from "../components/WorkerCost.js";
import { useDismissTransition } from "../lib/useDismissTransition.js";
import { useModalKeys } from "../lib/useModalKeys.js";
import { useFocusTrap } from "../lib/useFocusTrap.js";
import { useT } from "../i18n/provider.js";

type Repo = { name: string; path: string; description: string; base: string | null };

function RepoTreeImpl(p: {
  repos: Repo[];
  fleet: FleetRow[];
  loaded?: boolean; // fleet/repos have arrived → only then is "no repos" real (avoids the cold-connect false-empty flash)
  activeSubId: string | null;
  onSelectSub: (id: string) => void;
  onNewRepo: () => void;
  onRemoveRepo: (name: string) => void;
  onNewSub: (repoName: string) => void;
  attention?: Record<string, boolean>; // workers that settled without being viewed → unread dot on the right of the row
  onStopSub?: (id: string) => void;
  onRenameSub?: (id: string, label: string) => void;
  onArchiveSub?: (id: string, archived: boolean) => void;
  onDeleteSub?: (id: string) => void;
}): JSX.Element {
  const t = useT();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [archOpen, setArchOpen] = useState(false); // archive collapsed by default
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; name: string } | null>(null);
  const [q, setQ] = useState(""); // fleet-at-scale filter: by worker label
  const [onlyActive, setOnlyActive] = useState(false); // show only running/idle/unread workers
  // worker spawn appearance: workers present in the first non-empty fleet are excluded as the seed; only workers spawned afterward get the rise-in.
  // Membership is non-mutating, so the class stays for the row's whole lifetime (not re-evaluated) and the appearance isn't cut off by status-change re-renders.
  // When a view switch remounts RepoTree, the seed is re-captured from the current fleet so workers don't re-appear.
  const spawnSeedRef = useRef<Set<string> | null>(null);
  if (spawnSeedRef.current === null && p.fleet.length > 0) spawnSeedRef.current = new Set(p.fleet.map((f) => f.id));
  const isFreshSpawn = (id: string): boolean => spawnSeedRef.current !== null && !spawnSeedRef.current.has(id);
  const knownPaths = new Set(p.repos.map((r) => r.path));
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
        <div key={sub.id} className="px-1 py-0.5">
          <input
            autoFocus
            value={renaming.value}
            onChange={(e) => setRenaming({ id: sub.id, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") { p.onRenameSub?.(sub.id, renaming.value.trim() || sub.label); setRenaming(null); }
              else if (e.key === "Escape") setRenaming(null);
            }}
            onBlur={() => { p.onRenameSub?.(sub.id, renaming.value.trim() || sub.label); setRenaming(null); }}
            className="w-full rounded-md border border-accent/60 bg-ink px-2 py-1 text-[12px] text-fg outline-none"
          />
        </div>
      );
    }
    return (
      <button
        key={sub.id}
        onClick={() => p.onSelectSub(sub.id)}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ id: sub.id, x: e.clientX, y: e.clientY }); }}
        className={cn(
          "relative flex items-center gap-1.5 rounded-md py-1.5 pl-3 pr-2 text-left text-[12px] transition-colors",
          active ? "bg-accent/15 text-fg" : "text-fg-dim hover:bg-raised hover:text-fg",
          isFreshSpawn(sub.id) && "rise-in",
        )}
      >
        {/* left channel rail = result status (color), dot = live pulse (running only), spinner = provisioning (worktree being created) */}
        <span className={cn("absolute left-0.5 top-1.5 bottom-1.5 w-[2.5px] rounded-full transition-colors duration-200", active ? "bg-accent" : railClass(sub.status))} />
        {isProvisioning(sub.status)
          ? <Loader2 size={11} className="shrink-0 animate-spin text-accent" />
          : isLive(sub.status) && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-run led-live" />}
        <span className={cn("min-w-0 flex-1 truncate", p.attention?.[sub.id] && !active && "font-semibold text-fg")}>{sub.label}</span>
        <WorkerCost workerId={sub.id} />
        <span className="shrink-0 font-mono text-[8.5px] tracking-wide text-muted">{statusTag(sub.status)}</span>
        {/* unread: worker that finished without being viewed — dot on the right (ready=green / error=red). Disappears once viewed (select). */}
        {p.attention?.[sub.id] && !active && (
          <span title={t("repoTree.unreadTitle")} className={cn("dot-pop h-2 w-2 shrink-0 rounded-full", sub.status === "error" || sub.status === "failed" ? "bg-fail" : "bg-run")} />
        )}
      </button>
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
            <button onClick={() => p.onNewSub(key)} aria-label={t("repoTree.addWorker")} className="hidden h-6 w-6 items-center justify-center rounded text-muted hover:text-accent group-hover:flex">
              <Plus size={13} />
            </button>
          )}
          {opts.removable && (
            <button onClick={() => p.onRemoveRepo(key)} aria-label={t("repoTree.removeRepo")} className="hidden h-6 w-6 items-center justify-center rounded text-muted hover:text-fail group-hover:flex">
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
      <FleetBurn ids={live.map((f) => f.id)} />
      {live.length > 4 && (
        <div className="mx-1 mb-1 flex items-center gap-1.5 rounded-md border border-line bg-ink/40 px-2 py-1 transition-colors focus-within:border-accent/50">
          <Search size={11} className="shrink-0 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("repoTree.filterPlaceholder")} className="min-w-0 flex-1 bg-transparent text-[11px] text-fg-dim placeholder:text-muted focus:outline-none" />
          <button onClick={() => setOnlyActive((v) => !v)} title={t("repoTree.onlyActiveTitle")} aria-pressed={onlyActive} className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors", onlyActive ? "bg-run/15 text-run" : "text-muted hover:text-fg-dim")}>
            {t("repoTree.onlyActive")}
          </button>
        </div>
      )}
      {(p.loaded ?? true) && p.repos.length === 0 && orphans.length === 0 && <div className="px-2 py-3 text-[12px] leading-relaxed text-muted">{t("repoTree.emptyState")}</div>}
      {p.repos.filter((repo) => !filtering || shown.some((f) => f.repoPath === repo.path)).map((repo) => group(repo.name, repo.name, shown.filter((f) => f.repoPath === repo.path), { removable: true, canAdd: true }))}
      {orphans.length > 0 && group("__orphans__", t("repoTree.uncategorized"), orphans, { removable: false, canAdd: false })}
      {filtering && shown.length === 0 && <div className="px-2 py-3 text-[12px] text-muted">{t("repoTree.noMatches")}</div>}

      {archived.length > 0 && (
        <div className="mt-1">
          <button onClick={() => setArchOpen((v) => !v)} className="eyebrow flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[11px] font-medium uppercase tracking-[0.1em] text-muted hover:text-fg-dim">
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
            // stop: only when in progress (running/idle) — keeps the worktree and pauses (resumable).
            ...(menuSub.status === "running" || menuSub.status === "idle" ? [{ label: t("repoTree.menuStop"), onClick: () => p.onStopSub?.(menu.id) }] : []),
            { label: menuSub.archived ? t("repoTree.menuUnarchive") : t("repoTree.menuArchive"), onClick: () => p.onArchiveSub?.(menu.id, !menuSub.archived) },
            { label: t("repoTree.menuDelete"), danger: true, onClick: () => setConfirm({ id: menu.id, name: menuSub.label }) },
          ]}
        />
      )}

      {confirm && (
        <WorkerDeleteConfirm
          name={confirm.name}
          onCancel={() => setConfirm(null)}
          onConfirm={() => p.onDeleteSub?.(confirm.id)}
        />
      )}
    </div>
  );
}

export const RepoTree = memo(RepoTreeImpl);
RepoTree.displayName = "RepoTree";

// Destructive worker-delete confirm (removes the worktree + branch). Extracted so it mounts/unmounts with `confirm` →
// useDismissTransition resets per open and plays a symmetric enter/exit; Escape/cancel button cancel; Cancel autofocused (safe default).
function WorkerDeleteConfirm({ name, onCancel, onConfirm }: { name: string; onCancel: () => void; onConfirm: () => void }): JSX.Element {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  const { closing, dismiss } = useDismissTransition(onCancel);
  const confirmAndClose = (): void => { onConfirm(); dismiss(); };
  useModalKeys(dismiss, confirmAndClose);
  useFocusTrap(panelRef);
  return (
    <div className={cn("fixed inset-0 z-[110] flex items-center justify-center bg-black/55 backdrop-blur-sm", closing ? "motion-safe:animate-[overlay-out_130ms_ease-in]" : "motion-safe:animate-[overlay-in_140ms_ease-out]")}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={t("repoTree.deleteWorkerTitle")} className={cn("w-[360px] rounded-xl border border-line bg-surface p-5", closing ? "motion-safe:animate-[dialog-out_140ms_ease-in]" : "motion-safe:animate-[dialog-in_160ms_ease-out]")}>
        <div className="mb-1.5 text-[14px] font-semibold">{t("repoTree.deleteWorkerTitle")}</div>
        <p className="text-[12.5px] leading-relaxed text-muted">
          <span className="text-fg-dim">{name}</span>{t("repoTree.deleteWorkerConfirm")}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button autoFocus onClick={dismiss} className="rounded-lg border border-line px-3 py-1.5 text-[12.5px] text-muted hover:bg-raised hover:text-fg-dim">{t("common.cancel")}</button>
          <button onClick={confirmAndClose} className="rounded-lg bg-fail/90 px-3 py-1.5 text-[12.5px] font-medium text-fg hover:bg-fail">{t("common.delete")}</button>
        </div>
      </div>
    </div>
  );
}
