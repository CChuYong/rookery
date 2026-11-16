import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { RefreshCw, Plus, Minus, Undo2, GitBranch, GitCompareArrows, ArrowUp, ArrowDown, UploadCloud, ChevronDown, ChevronRight } from "lucide-react";
import { useWsStore } from "../store/workspace.js";
import { baseName as basename } from "../lib/path.js";
import { cn } from "../lib/cn.js";
import { GIT_TONE } from "../lib/gitTone.js";
import { GitHistory } from "./GitHistory.js";
import { SkeletonRows } from "./Skeleton.js";
import { Textarea } from "../ui/input.js";
import { Segment } from "../ui/segment.js";
import { Button } from "../ui/button.js";
import { ConfirmDialog } from "../ui/confirm-dialog.js";
import { LoadFailed, EmptyState } from "../ui/load-state.js";
import { Tooltip } from "./Tooltip.js";
import { toast } from "../store/toasts.js";
import { useT } from "../i18n/provider.js";
import { isImeComposing } from "../lib/focus.js";

type Change = { path: string; x: string; y: string; added: number; deleted: number };
type Info = Awaited<ReturnType<Window["rookery"]["ws"]["gitInfo"]>>;
type Busy = null | "push" | "commit" | "action";

const isUntracked = (c: Change): boolean => c.x === "?";
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

// Name + parent folder for a change row. An untracked directory comes back as "dir/" — strip the slash first so a
// root-level one doesn't print its name twice ("dir  dir", audit #38).
function splitPath(path: string): { name: string; dir: string | null } {
  const clean = path.replace(/\/+$/, "");
  const cut = clean.lastIndexOf("/");
  return { name: basename(clean), dir: cut > 0 ? clean.slice(0, cut) : null };
}

// Panel polling skips while the window is hidden or the panel sits in a hidden dock group (still mounted, display:none).
// `checkVisibility` is Chromium's; where it is missing (jsdom) the panel counts as visible.
function panelVisible(el: HTMLElement | null): boolean {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return false;
  const check = (el as (HTMLElement & { checkVisibility?: () => boolean }) | null)?.checkVisibility;
  return typeof check === "function" ? check.call(el) : true;
}

function IconBtn({ title, onClick, disabled, children }: { title: string; onClick: () => void; disabled?: boolean; children: ReactNode }): JSX.Element {
  return (
    <button title={title} aria-label={title} disabled={disabled} onClick={(e) => { e.stopPropagation(); onClick(); }} className="flex h-5 w-5 items-center justify-center rounded-sm text-muted hover:bg-raised hover:text-fg disabled:pointer-events-none disabled:opacity-40">
      {children}
    </button>
  );
}

function Stat({ added, deleted }: { added: number; deleted: number }): JSX.Element | null {
  if (added === 0 && deleted === 0) return null;
  return (
    <span className="shrink-0 font-mono text-meta tabular-nums">
      {added > 0 && <span className="text-pr">+{added}</span>} {deleted > 0 && <span className="text-fail">−{deleted}</span>}
    </span>
  );
}

// `onViewBranchDiff` (worker pages only) opens the worker's whole-branch diff — the place to look once its work is
// committed and this list is empty (audit #84).
export function GitChanges({ root, pageKey, version = 0, onViewBranchDiff }: { root: string; pageKey: string; version?: number; onViewBranchDiff?: () => void }): JSX.Element {
  const t = useT();
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null); // the last read failed (git error, not "no changes")
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [historyKey, setHistoryKey] = useState(0); // bumped by the refresh button so History reloads too (audit #40)
  const [collapsed, setCollapsed] = useState<{ staged: boolean; unstaged: boolean }>({ staged: false, unstaged: false });
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ path: string; untracked: boolean } | null>(null);
  const [tab, setTab] = useState<"changes" | "history">("changes");
  const openDiff = useWsStore((s) => s.openDiff_);
  const panelRef = useRef<HTMLDivElement>(null);
  // Change-row landing: rows present at first load are excluded as seed, and only new changes the worker makes afterward fade-rise.
  // When root (worker) changes, reset the seed (prevents mistaking another worker's diff for a new change). Non-mutating, so appearance isn't cut off by the 2.5s polling.
  const rowSeedRef = useRef<Set<string> | null>(null);
  const seedRootRef = useRef<string>("");
  if (seedRootRef.current !== root) { seedRootRef.current = root; rowSeedRef.current = null; }
  // Guards a late response for a previous root (root switch) from overwriting the new root's state.
  const rootRef = useRef(root);
  rootRef.current = root;

  // Known not to be a repository (per root): reads then skip gitChanges, which only throws there (final review #6).
  // gitInfo keeps being polled, so a `git init` is picked up and the next pass reads changes again.
  const notRepoRef = useRef(false);

  // One read of info + changes. Resolves to the failure text (or null) instead of rejecting, so polling never throws.
  const fetchAll = useCallback(async (): Promise<string | null> => {
    const forRoot = root;
    const skipChanges = notRepoRef.current;
    const [i, c0] = await Promise.allSettled([
      window.rookery.ws.gitInfo(forRoot),
      skipChanges ? Promise.resolve(null) : window.rookery.ws.gitChanges(forRoot),
    ]);
    if (rootRef.current !== forRoot) return null;
    if (i.status === "fulfilled") setInfo(i.value);
    const notRepo = i.status === "fulfilled" && i.value.isRepo === false;
    notRepoRef.current = notRepo;
    if (notRepo) { setLoadErr(null); return null; } // not a repository: its own state
    // It just became a repository (or gitInfo failed after a non-repo read): read the changes now.
    const [c] = skipChanges ? await Promise.allSettled([window.rookery.ws.gitChanges(forRoot)]) : [c0];
    if (rootRef.current !== forRoot) return null;
    if (c.status === "fulfilled" && c.value !== null) setChanges(c.value);
    const failure = c.status === "rejected" ? errText(c.reason) : i.status === "rejected" ? errText(i.reason) : null;
    setLoadErr(failure);
    return failure;
  }, [root]);
  const reload = (): void => { void fetchAll(); };
  // Re-fetch when root/version (file watch) changes + re-fetch on polling/focus.
  // Why polling is needed: in a worker worktree, `.git` is a file (gitdir pointer) so the real index/refs live in the main repo,
  // so watching the worktree root won't catch commits → lightly poll while the panel is visible to auto-reflect commits/staging.
  useEffect(() => {
    setChanges(null); setInfo(null); setLoadErr(null);
    notRepoRef.current = false;
    void fetchAll();
    const iv = setInterval(() => { if (panelVisible(panelRef.current)) void fetchAll(); }, 2500);
    const onFocus = (): void => { void fetchAll(); };
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(iv); window.removeEventListener("focus", onFocus); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);
  useEffect(() => {
    if (version) void fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    setHistoryKey((k) => k + 1);
    try { await fetchAll(); } finally { setRefreshing(false); }
  };
  // The reason is already the LoadFailed detail (it follows loadErr), so a failed retry rejects without repeating it
  // (final review #10): the retry note then reads just "tried again, still failing".
  const retry = async (): Promise<void> => {
    const failure = await fetchAll();
    if (failure) throw new Error("");
  };

  const act = async (kind: Busy, fn: () => Promise<{ ok: boolean; error?: string }>): Promise<{ ok: boolean } | null> => {
    setBusy(kind); setErr(null);
    try {
      const r = await fn();
      if (!r.ok) setErr(r.error ?? t("gitChanges.actionFailed"));
      return r;
    } catch (e) {
      setErr(errText(e) || t("gitChanges.actionFailed"));
      return null;
    } finally { setBusy(null); reload(); }
  };
  const push = async (upstream: string): Promise<void> => {
    const r = await act("push", () => window.rookery.ws.gitPush(root));
    if (r?.ok) toast.success(t("gitChanges.pushed", { upstream }));
  };
  const commit = async (): Promise<void> => {
    setBusy("commit"); setErr(null);
    try {
      const r = await window.rookery.ws.gitCommit(root, msg.trim());
      if (r.ok) setMsg(""); else setErr(r.error ?? t("gitChanges.commitFailed"));
    } catch (e) {
      setErr(errText(e) || t("gitChanges.commitFailed"));
    } finally { setBusy(null); reload(); }
  };

  const list = changes ?? [];
  const staged = list.filter((c) => c.x !== " " && c.x !== "?");
  const unstaged = list.filter((c) => isUntracked(c) || (c.y !== " " && c.y !== "?"));
  const totalAdded = list.reduce((s, c) => s + c.added, 0);
  const totalDeleted = list.reduce((s, c) => s + c.deleted, 0);
  if (rowSeedRef.current === null && changes !== null) {
    const keys = new Set<string>();
    for (const c of staged) keys.add(`staged:${c.path}`);
    for (const c of unstaged) keys.add(`unstaged:${c.path}`);
    rowSeedRef.current = keys;
  }
  const isFreshChange = (key: string): boolean => rowSeedRef.current !== null && !rowSeedRef.current.has(key);

  const Row = (c: Change, section: "staged" | "unstaged"): JSX.Element => {
    const st = section === "staged" ? c.x : isUntracked(c) ? "?" : c.y;
    const { name, dir } = splitPath(c.path);
    return (
      <div key={`${section}:${c.path}`} className={cn("group relative flex h-6 items-center gap-1 rounded px-2.5 hover:bg-raised focus-within:bg-raised", isFreshChange(`${section}:${c.path}`) && "rise-in")}>
        <button onClick={() => openDiff(pageKey, `${root}/${c.path}`)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <span className={cn("w-3 shrink-0 text-center font-mono text-meta", GIT_TONE[st] ?? "text-muted")}>{st}</span>
          <span className="max-w-[70%] shrink-0 truncate text-ui text-fg">{name}</span>
          {dir && <span className="min-w-0 truncate text-meta text-faint">{dir}</span>}
        </button>
        {/* numstat fades out and the action buttons fade in on hover OR keyboard focus (absolute so the buttons stay in the
            tab order even while invisible — a `hidden` swap can never receive focus). */}
        <span className="shrink-0 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0"><Stat added={c.added} deleted={c.deleted} /></span>
        <span className="absolute right-2.5 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          {section === "unstaged" && <IconBtn title={t("gitChanges.revert")} disabled={!!busy} onClick={() => setConfirm({ path: c.path, untracked: isUntracked(c) })}><Undo2 size={12} /></IconBtn>}
          {section === "staged"
            ? <IconBtn title={t("gitChanges.unstage")} disabled={!!busy} onClick={() => void act("action", () => window.rookery.ws.gitUnstage(root, c.path))}><Minus size={14} /></IconBtn>
            : <IconBtn title={t("gitChanges.stage")} disabled={!!busy} onClick={() => void act("action", () => window.rookery.ws.gitStage(root, c.path))}><Plus size={14} /></IconBtn>}
        </span>
      </div>
    );
  };

  // Collapsible section head (VS Code SCM convention): the chevron + label is a real toggle (audit #39); the
  // section action sits beside it, not inside it, so buttons never nest.
  // Called as a plain function, not as a JSX component: a component defined in render would remount every render.
  const sectionHead = ({ id, label, n, action }: { id: "staged" | "unstaged"; label: string; n: number; action?: JSX.Element }): JSX.Element => {
    const open = !collapsed[id];
    return (
      <div className="flex h-6 items-center gap-1 px-2.5 text-ui font-medium text-fg-dim">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setCollapsed((cur) => ({ ...cur, [id]: !cur[id] }))}
          className="flex min-w-0 flex-1 items-center gap-1 rounded-sm text-left hover:text-fg"
        >
          {open ? <ChevronDown size={12} className="shrink-0 text-muted" aria-hidden /> : <ChevronRight size={12} className="shrink-0 text-muted" aria-hidden />}
          <span>{label}</span>
          <span className="font-mono text-meta text-faint">{n}</span>
        </button>
        {action && <span className="ml-auto">{action}</span>}
      </div>
    );
  };

  const isRepo = info?.isRepo !== false;
  const repoInfo = info && info.isRepo !== false ? (info as Extract<Info, { isRepo: true }>) : null;
  const ahead = repoInfo?.ahead ?? 0;
  const commitHint = staged.length === 0 ? t("gitChanges.commitNothingStaged") : !msg.trim() ? t("gitChanges.commitNeedsMessage") : t("gitChanges.commitShortcut");
  const refreshBtn = (
    <Button variant="ghost" size="iconSm" onClick={() => void refresh()} disabled={refreshing} title={t("common.refresh")} aria-label={t("common.refresh")}>
      <RefreshCw size={12} className={cn(refreshing && "animate-spin motion-reduce:animate-none")} />
    </Button>
  );

  // Not a git repository (incl. the home-folder fallback): say so instead of an empty change list (audit #88).
  if (!isRepo) {
    return (
      <div ref={panelRef} className="relative flex h-full flex-col">
        <div className="flex shrink-0 items-center justify-end px-2.5 py-1.5">{refreshBtn}</div>
        <EmptyState>{t("gitChanges.notRepo")}</EmptyState>
      </div>
    );
  }

  return (
    <div ref={panelRef} className="relative flex h-full flex-col">
      {/* Branch header */}
      <div className="shrink-0 px-2.5 py-1.5">
        <div className="flex items-center gap-1.5">
          <GitBranch size={12} className="shrink-0 text-muted" />
          <span className="truncate font-mono text-ui text-fg-dim" title={repoInfo?.upstream ?? undefined}>{repoInfo?.branch || "—"}</span>
          {!!repoInfo?.ahead && <span className="inline-flex shrink-0 items-center gap-px font-mono text-meta tabular-nums text-muted"><ArrowUp size={12} />{repoInfo.ahead}</span>}
          {!!repoInfo?.behind && <span className="inline-flex shrink-0 items-center gap-px font-mono text-meta tabular-nums text-muted"><ArrowDown size={12} />{repoInfo.behind}</span>}
          <span className="ml-auto flex shrink-0 items-center gap-0.5">
            <Stat added={totalAdded} deleted={totalDeleted} />
            {repoInfo?.upstream && (
              // Disabled reasons show in the tooltip (its wrapper takes the hover a disabled button can't, #33).
              <Tooltip label={ahead ? t("gitChanges.pushTo", { upstream: repoInfo.upstream }) : t("gitChanges.pushNothing")} side="bottom" align="end">
                <Button variant="ghost" size="iconSm" onClick={() => void push(repoInfo.upstream!)} disabled={(!!busy && busy !== "push") || !ahead} loading={busy === "push"} aria-label={t("gitChanges.push")}>
                  <UploadCloud size={12} />
                </Button>
              </Tooltip>
            )}
            {onViewBranchDiff && (
              <Button variant="ghost" size="iconSm" onClick={onViewBranchDiff} title={t("repoTree.menuBranchDiff")} aria-label={t("repoTree.menuBranchDiff")}>
                <GitCompareArrows size={12} />
              </Button>
            )}
            {refreshBtn}
          </span>
        </div>
      </div>

      {/* Changes | History — a tab strip (underline), not a filled pill track (audit #38: pills are a toy tell). */}
      <Segment<"changes" | "history">
        items={[
          { value: "changes", label: t("gitChanges.tabChanges") },
          { value: "history", label: t("gitChanges.tabHistory") },
        ]}
        value={tab}
        onChange={setTab}
        variant="underline"
        className="shrink-0 gap-0.5 border-b border-line px-1.5"
        itemClassName="px-1.5"
      />

      {/* rise-in crossfade when switching between the Changes ⇄ History tabs */}
      <div key={tab} className="flex min-h-0 flex-1 flex-col rise-in">
      {tab === "changes" ? (
        <>
          {/* Change list */}
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {loadErr && changes === null ? (
              <LoadFailed message={t("gitChanges.loadFailed")} detail={loadErr} onRetry={retry} />
            ) : changes === null ? (
              <SkeletonRows rows={6} />
            ) : staged.length === 0 && unstaged.length === 0 ? (
              <div className="px-3 py-3 text-ui text-muted">
                {t("gitChanges.noChanges")}
                {onViewBranchDiff && (
                  <button onClick={onViewBranchDiff} className="ml-1.5 text-ui text-fg-dim underline-offset-2 hover:text-fg hover:underline">{t("repoTree.menuBranchDiff")}</button>
                )}
              </div>
            ) : (
              <>
                {staged.length > 0 && (
                  <>
                    {sectionHead({ id: "staged", label: t("gitChanges.stagedSection"), n: staged.length, action: <IconBtn title={t("gitChanges.unstageAll")} disabled={!!busy} onClick={() => void act("action", () => window.rookery.ws.gitUnstage(root, "."))}><Minus size={12} /></IconBtn> })}
                    {!collapsed.staged && staged.map((c) => Row(c, "staged"))}
                  </>
                )}
                {unstaged.length > 0 && (
                  <>
                    {sectionHead({ id: "unstaged", label: t("gitChanges.changedSection"), n: unstaged.length, action: <IconBtn title={t("gitChanges.stageAll")} disabled={!!busy} onClick={() => void act("action", () => window.rookery.ws.gitStageAll(root))}><Plus size={12} /></IconBtn> })}
                    {!collapsed.unstaged && unstaged.map((c) => Row(c, "unstaged"))}
                  </>
                )}
              </>
            )}
          </div>

          {/* A later read failed while older data is on screen: keep the list, say it may be stale. */}
          {loadErr && changes !== null && <div role="status" className="shrink-0 truncate px-2.5 pb-1 text-meta text-muted" title={loadErr}>{t("gitChanges.refreshFailed")}</div>}

          {/* Commit box — only once the change list is known (nothing to commit against while loading or failed) */}
          {changes !== null && <div className="shrink-0 p-2">
            {err && <div className="mb-1.5 rounded bg-fail/12 px-2 py-1 text-meta text-fail">{err}</div>}
            <Textarea
              size="sm"
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !isImeComposing(e) && msg.trim() && staged.length && !busy) void commit(); }}
              placeholder={staged.length ? t("gitChanges.commitPlaceholder") : t("gitChanges.commitPlaceholderEmpty")}
              rows={2}
              className="w-full resize-none"
            />
            {/* Quieter than the global neutral `primary` fill — a panel-footer action sits better as a raised
                block than a bright solid one in this narrow sidebar. Not orange either way. Disabled drops the
                fill to a hairline outline so it can't be mistaken for the active state (audit #38), and the
                tooltip says why (#33). */}
            <Tooltip label={commitHint} className="mt-1.5 w-full">
              <Button
                variant="primary"
                size="sm"
                className="h-[26px] w-full border border-transparent bg-raised text-fg hover:bg-line disabled:border-line disabled:bg-transparent disabled:text-faint"
                onClick={() => void commit()}
                disabled={!msg.trim() || staged.length === 0 || (!!busy && busy !== "commit")}
                loading={busy === "commit"}
              >
                {t("gitChanges.commit")}{staged.length ? ` ${staged.length}` : ""}
              </Button>
            </Tooltip>
          </div>}
        </>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          <GitHistory root={root} pageKey={pageKey} version={version} head={repoInfo?.head ?? null} refreshKey={historyKey} />
        </div>
      )}
      </div>

      {/* Revert confirmation (audit #73 — now the shared ConfirmDialog, portaled to document.body like every other
          migrated confirm; previously this one alone stayed `absolute` within the panel, which is why it needed
          its own z-10 scoping — the portal removes that constraint, so it now centers over the whole app like the
          rest instead of being clipped to the Git panel's bounds). */}
      {confirm && (
        <ConfirmDialog
          title={t("gitChanges.revertTitle")}
          body={(confirm.untracked ? t("gitChanges.revertDescUntracked") : t("gitChanges.revertDescTracked"))
            .split("{name}")
            .flatMap((part, i) => (i === 0 ? [part] : [<span key={i} className="text-fg-dim">{basename(confirm.path)}</span>, part]))}
          confirmLabel={t("gitChanges.revert")}
          variant="danger"
          onCancel={() => setConfirm(null)}
          onConfirm={() => { const c = confirm; void act("action", () => window.rookery.ws.gitDiscard(root, c.path, c.untracked)); }}
        />
      )}
    </div>
  );
}
