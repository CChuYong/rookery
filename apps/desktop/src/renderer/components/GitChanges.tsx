import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { RefreshCw, Plus, Minus, Undo2, GitBranch, GitCompareArrows, ArrowUp, ArrowDown, UploadCloud, ChevronDown } from "lucide-react";
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
import { useT } from "../i18n/provider.js";

type Change = { path: string; x: string; y: string; added: number; deleted: number };
type Info = { branch: string; ahead: number; behind: number; upstream: string | null };

const isUntracked = (c: Change): boolean => c.x === "?";

function IconBtn({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }): JSX.Element {
  return (
    <button title={title} aria-label={title} onClick={(e) => { e.stopPropagation(); onClick(); }} className="flex h-5 w-5 items-center justify-center rounded-sm text-muted hover:bg-raised hover:text-fg">
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
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ path: string; untracked: boolean } | null>(null);
  const [tab, setTab] = useState<"changes" | "history">("changes");
  const openDiff = useWsStore((s) => s.openDiff_);
  // Change-row landing: rows present at first load are excluded as seed, and only new changes the worker makes afterward fade-rise.
  // When root (worker) changes, reset the seed (prevents mistaking another worker's diff for a new change). Non-mutating, so appearance isn't cut off by the 2.5s polling.
  const rowSeedRef = useRef<Set<string> | null>(null);
  const seedRootRef = useRef<string>("");
  if (seedRootRef.current !== root) { seedRootRef.current = root; rowSeedRef.current = null; }

  const reload = (): void => {
    void window.rookery.ws.gitChanges(root).then(setChanges);
    void window.rookery.ws.gitInfo(root).then(setInfo);
  };
  // Re-fetch when root/version (file watch) changes + re-fetch on polling/focus.
  // Why polling is needed: in a worker worktree, `.git` is a file (gitdir pointer) so the real index/refs live in the main repo,
  // so watching the worktree root won't catch commits → lightly poll while the panel is open to auto-reflect commits/staging.
  useEffect(() => {
    let live = true; // when root changes, prevent a late response from the previous root from overwriting the new root's state
    const load = (): void => {
      void window.rookery.ws.gitChanges(root).then((c) => { if (live) setChanges(c); });
      void window.rookery.ws.gitInfo(root).then((i) => { if (live) setInfo(i); });
    };
    load();
    const iv = setInterval(load, 2500);
    const onFocus = (): void => load();
    window.addEventListener("focus", onFocus);
    return () => { live = false; clearInterval(iv); window.removeEventListener("focus", onFocus); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, version]);

  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>): Promise<void> => {
    setBusy(true); setErr(null);
    try {
      const r = await fn();
      if (!r.ok) setErr(r.error ?? t("gitChanges.actionFailed"));
    } finally { setBusy(false); reload(); }
  };
  const commit = async (): Promise<void> => {
    setBusy(true); setErr(null);
    const r = await window.rookery.ws.gitCommit(root, msg.trim());
    setBusy(false);
    if (r.ok) setMsg(""); else setErr(r.error ?? t("gitChanges.commitFailed"));
    reload();
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
    return (
      <div key={`${section}:${c.path}`} className={cn("group relative flex h-6 items-center gap-1 rounded px-2.5 hover:bg-raised focus-within:bg-raised", isFreshChange(`${section}:${c.path}`) && "rise-in")}>
        <button onClick={() => openDiff(pageKey, `${root}/${c.path}`)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <span className={cn("w-3 shrink-0 text-center font-mono text-meta", GIT_TONE[st] ?? "text-muted")}>{st}</span>
          <span className="max-w-[70%] shrink-0 truncate text-ui text-fg">{basename(c.path)}</span>
          {c.path.includes("/") && <span className="min-w-0 truncate text-meta text-faint">{c.path.slice(0, c.path.lastIndexOf("/"))}</span>}
        </button>
        {/* numstat fades out and the action buttons fade in on hover OR keyboard focus (absolute so the buttons stay in the
            tab order even while invisible — a `hidden` swap can never receive focus). */}
        <span className="shrink-0 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0"><Stat added={c.added} deleted={c.deleted} /></span>
        <span className="absolute right-2.5 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          {section === "unstaged" && <IconBtn title={t("gitChanges.revert")} onClick={() => setConfirm({ path: c.path, untracked: isUntracked(c) })}><Undo2 size={12} /></IconBtn>}
          {section === "staged"
            ? <IconBtn title={t("gitChanges.unstage")} onClick={() => void act(() => window.rookery.ws.gitUnstage(root, c.path))}><Minus size={14} /></IconBtn>
            : <IconBtn title={t("gitChanges.stage")} onClick={() => void act(() => window.rookery.ws.gitStage(root, c.path))}><Plus size={14} /></IconBtn>}
        </span>
      </div>
    );
  };

  // Collapsible-looking section head (VS Code SCM convention) — a static chevron marks the group visually; the
  // list itself isn't toggled (no state added), matching how Staged/Changes always render in full here.
  const SectionHead = ({ label, n, action }: { label: string; n: number; action?: JSX.Element }): JSX.Element => (
    <div className="flex h-6 items-center gap-1 px-2.5 text-ui font-medium text-fg-dim">
      <ChevronDown size={12} className="shrink-0 text-muted" aria-hidden />
      <span>{label}</span>
      <span className="font-mono text-meta text-faint">{n}</span>
      {action && <span className="ml-auto">{action}</span>}
    </div>
  );

  return (
    <div className="relative flex h-full flex-col">
      {/* Branch header */}
      <div className="shrink-0 px-2.5 py-1.5">
        <div className="flex items-center gap-1.5">
          <GitBranch size={12} className="shrink-0 text-muted" />
          <span className="truncate font-mono text-ui text-fg-dim" title={info?.upstream ?? undefined}>{info?.branch || "—"}</span>
          {!!info?.ahead && <span className="inline-flex shrink-0 items-center gap-px font-mono text-meta tabular-nums text-muted"><ArrowUp size={12} />{info.ahead}</span>}
          {!!info?.behind && <span className="inline-flex shrink-0 items-center gap-px font-mono text-meta tabular-nums text-muted"><ArrowDown size={12} />{info.behind}</span>}
          <span className="ml-auto flex shrink-0 items-center gap-0.5">
            <Stat added={totalAdded} deleted={totalDeleted} />
            {info?.upstream && (
              <Button variant="ghost" size="iconSm" onClick={() => void act(() => window.rookery.ws.gitPush(root))} disabled={busy || !info.ahead} title={t("gitChanges.push")} aria-label={t("gitChanges.push")}>
                <UploadCloud size={12} />
              </Button>
            )}
            {onViewBranchDiff && (
              <Button variant="ghost" size="iconSm" onClick={onViewBranchDiff} title={t("repoTree.menuBranchDiff")} aria-label={t("repoTree.menuBranchDiff")}>
                <GitCompareArrows size={12} />
              </Button>
            )}
            <Button variant="ghost" size="iconSm" onClick={reload} title={t("common.refresh")} aria-label={t("common.refresh")}><RefreshCw size={12} /></Button>
          </span>
        </div>
      </div>

      {/* Changes | History tabs — a quiet bounded track (not a full-width tab row) per the Segment pill recipe. */}
      <Segment<"changes" | "history">
        items={[
          { value: "changes", label: t("gitChanges.tabChanges") },
          { value: "history", label: t("gitChanges.tabHistory") },
        ]}
        value={tab}
        onChange={setTab}
        variant="pill"
        className="mx-2 my-1.5 h-6 w-fit shrink-0 gap-0.5 rounded-md border border-line bg-ink p-0.5"
        itemClassName="py-0.5 font-medium leading-none"
      />

      {/* rise-in crossfade when switching between the Changes ⇄ History tabs */}
      <div key={tab} className="flex min-h-0 flex-1 flex-col rise-in">
      {tab === "changes" ? (
        <>
          {/* Change list */}
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {changes === null ? (
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
                    <SectionHead label={t("gitChanges.stagedSection")} n={staged.length} action={<IconBtn title={t("gitChanges.unstageAll")} onClick={() => void act(() => window.rookery.ws.gitUnstage(root, "."))}><Minus size={12} /></IconBtn>} />
                    {staged.map((c) => Row(c, "staged"))}
                  </>
                )}
                {unstaged.length > 0 && (
                  <>
                    <SectionHead label={t("gitChanges.changedSection")} n={unstaged.length} action={<IconBtn title={t("gitChanges.stageAll")} onClick={() => void act(() => window.rookery.ws.gitStageAll(root))}><Plus size={12} /></IconBtn>} />
                    {unstaged.map((c) => Row(c, "unstaged"))}
                  </>
                )}
              </>
            )}
          </div>

          {/* Commit box */}
          <div className="shrink-0 p-2">
            {err && <div className="mb-1.5 rounded bg-fail/12 px-2 py-1 text-meta text-fail">{err}</div>}
            <Textarea
              size="sm"
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && msg.trim() && staged.length) void commit(); }}
              placeholder={staged.length ? t("gitChanges.commitPlaceholder") : t("gitChanges.commitPlaceholderEmpty")}
              rows={2}
              className="w-full resize-none"
            />
            {/* Quieter than the global neutral `primary` fill — a panel-footer action sits better as a raised
                block than a bright solid one in this narrow sidebar. Not orange either way. */}
            <Button
              variant="primary"
              size="sm"
              className="mt-1.5 h-[26px] w-full bg-raised text-fg hover:bg-line"
              onClick={() => void commit()}
              disabled={!msg.trim() || staged.length === 0}
              loading={busy}
            >
              {t("gitChanges.commit")}{staged.length ? ` ${staged.length}` : ""}
            </Button>
          </div>
        </>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          <GitHistory root={root} pageKey={pageKey} version={version} />
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
          onConfirm={() => { const c = confirm; void act(() => window.rookery.ws.gitDiscard(root, c.path, c.untracked)); }}
        />
      )}
    </div>
  );
}
