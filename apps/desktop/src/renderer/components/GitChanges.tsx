import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { RefreshCw, Plus, Minus, RotateCcw, GitBranch, ArrowUp, ArrowDown, UploadCloud, Loader2 } from "lucide-react";
import { useWsStore } from "../store/workspace.js";
import { baseName as basename } from "../lib/path.js";
import { cn } from "../lib/cn.js";
import { GIT_TONE } from "../lib/gitTone.js";
import { GitHistory } from "./GitHistory.js";
import { SkeletonRows } from "./Skeleton.js";
import { Textarea } from "../ui/input.js";
import { Segment } from "../ui/segment.js";
import { useDismissTransition } from "../lib/useDismissTransition.js";
import { useModalKeys } from "../lib/useModalKeys.js";
import { useFocusTrap } from "../lib/useFocusTrap.js";
import { useT } from "../i18n/provider.js";

type Change = { path: string; x: string; y: string; added: number; deleted: number };
type Info = { branch: string; ahead: number; behind: number; upstream: string | null };

const isUntracked = (c: Change): boolean => c.x === "?";

function IconBtn({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }): JSX.Element {
  return (
    <button title={title} onClick={(e) => { e.stopPropagation(); onClick(); }} className="flex h-5 w-5 items-center justify-center rounded text-muted hover:bg-line/60 hover:text-fg-dim">
      {children}
    </button>
  );
}

function Stat({ added, deleted }: { added: number; deleted: number }): JSX.Element | null {
  if (added === 0 && deleted === 0) return null;
  return (
    <span className="shrink-0 font-mono text-[10px]">
      {added > 0 && <span className="text-pr">+{added}</span>} {deleted > 0 && <span className="text-fail">−{deleted}</span>}
    </span>
  );
}

export function GitChanges({ root, pageKey, version = 0 }: { root: string; pageKey: string; version?: number }): JSX.Element {
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
      <div key={`${section}:${c.path}`} className={cn("group relative flex items-center gap-1 rounded px-2.5 py-1 text-[12px] text-fg-dim hover:bg-raised focus-within:bg-raised", isFreshChange(`${section}:${c.path}`) && "rise-in")}>
        <button onClick={() => openDiff(pageKey, `${root}/${c.path}`)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <span className={cn("w-3 shrink-0 text-center font-mono text-[11px]", GIT_TONE[st] ?? "text-muted")}>{st}</span>
          <span className="truncate">{basename(c.path)}</span>
          <span className="min-w-0 truncate text-[10px] text-muted/60">{c.path}</span>
        </button>
        {/* numstat fades out and the action buttons fade in on hover OR keyboard focus (absolute so the buttons stay in the
            tab order even while invisible — a `hidden` swap can never receive focus). */}
        <span className="shrink-0 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0"><Stat added={c.added} deleted={c.deleted} /></span>
        <span className="absolute right-2.5 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          {section === "unstaged" && <IconBtn title={t("gitChanges.revert")} onClick={() => setConfirm({ path: c.path, untracked: isUntracked(c) })}><RotateCcw size={12} /></IconBtn>}
          {section === "staged"
            ? <IconBtn title={t("gitChanges.unstage")} onClick={() => void act(() => window.rookery.ws.gitUnstage(root, c.path))}><Minus size={13} /></IconBtn>
            : <IconBtn title={t("gitChanges.stage")} onClick={() => void act(() => window.rookery.ws.gitStage(root, c.path))}><Plus size={13} /></IconBtn>}
        </span>
      </div>
    );
  };

  const SectionHead = ({ label, n, action }: { label: string; n: number; action?: JSX.Element }): JSX.Element => (
    <div className="eyebrow flex items-center gap-1 px-2.5 pb-0.5 pt-2 text-[10.5px] uppercase tracking-wide text-muted">
      <span>{label} {n}</span>
      {action && <span className="ml-auto">{action}</span>}
    </div>
  );

  return (
    <div className="relative flex h-full flex-col">
      {/* Branch header */}
      <div className="shrink-0 border-b border-line px-2.5 py-2">
        <div className="flex items-center gap-1.5 text-[12px]">
          <GitBranch size={12} className="shrink-0 text-muted" />
          <span className="truncate font-medium text-fg-dim" title={info?.upstream ?? undefined}>{info?.branch || "—"}</span>
          {!!info?.ahead && <span className="inline-flex shrink-0 items-center text-[10px] text-muted"><ArrowUp size={10} />{info.ahead}</span>}
          {!!info?.behind && <span className="inline-flex shrink-0 items-center text-[10px] text-muted"><ArrowDown size={10} />{info.behind}</span>}
          <span className="ml-auto flex shrink-0 items-center gap-2">
            <Stat added={totalAdded} deleted={totalDeleted} />
            {info?.upstream && <button onClick={() => void act(() => window.rookery.ws.gitPush(root))} disabled={busy || !info.ahead} title={t("gitChanges.push")} className="text-muted hover:text-fg-dim disabled:opacity-40"><UploadCloud size={12} /></button>}
            <button onClick={reload} title={t("common.refresh")} className="text-muted hover:text-fg-dim"><RefreshCw size={11} /></button>
          </span>
        </div>
      </div>

      {/* Changes | History tabs */}
      <Segment<"changes" | "history">
        items={[
          { value: "changes", label: t("gitChanges.tabChanges") },
          { value: "history", label: t("gitChanges.tabHistory") },
        ]}
        value={tab}
        onChange={setTab}
        variant="pill"
        className="shrink-0 gap-1 border-b border-line px-2 py-1"
        itemClassName="font-medium"
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
              <div className="px-3 py-3 text-[12px] text-muted">{t("gitChanges.noChanges")}</div>
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
          <div className="shrink-0 border-t border-line p-2">
            {err && <div className="mb-1.5 rounded bg-fail/12 px-2 py-1 text-[11px] text-fail">{err}</div>}
            <Textarea
              size="sm"
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && msg.trim() && staged.length) void commit(); }}
              placeholder={staged.length ? t("gitChanges.commitPlaceholder") : t("gitChanges.commitPlaceholderEmpty")}
              rows={2}
              className="w-full resize-none"
            />
            <button
              onClick={() => void commit()}
              disabled={busy || !msg.trim() || staged.length === 0}
              aria-busy={busy || undefined}
              className="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-md bg-accent/90 px-3 py-1.5 text-[12px] font-medium text-accent-ink transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:bg-raised disabled:text-muted"
            >
              {busy && <Loader2 size={13} className="animate-spin motion-reduce:hidden" aria-hidden />}
              {t("gitChanges.commit")}{staged.length ? ` ${staged.length}` : ""}
            </button>
          </div>
        </>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          <GitHistory root={root} pageKey={pageKey} version={version} />
        </div>
      )}
      </div>

      {/* Revert confirmation */}
      {confirm && (
        <RevertConfirm
          name={basename(confirm.path)}
          untracked={confirm.untracked}
          onCancel={() => setConfirm(null)}
          onConfirm={() => { const c = confirm; void act(() => window.rookery.ws.gitDiscard(root, c.path, c.untracked)); }}
        />
      )}
    </div>
  );
}

// Destructive revert confirm. Extracted so it mounts/unmounts with `confirm` → useDismissTransition resets per open and plays a
// symmetric enter/exit; Escape/cancel button cancel; Cancel autofocused (safe default). Stays absolute within the panel (z-10).
function RevertConfirm({ name, untracked, onCancel, onConfirm }: { name: string; untracked: boolean; onCancel: () => void; onConfirm: () => void }): JSX.Element {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  const { closing, dismiss } = useDismissTransition(onCancel);
  const confirmAndClose = (): void => { onConfirm(); dismiss(); };
  useModalKeys(dismiss, confirmAndClose);
  useFocusTrap(panelRef);
  return (
    <div className={cn("absolute inset-0 z-10 flex items-center justify-center bg-black/55 p-3 backdrop-blur-sm", closing ? "motion-safe:animate-[overlay-out_130ms_ease-in]" : "motion-safe:animate-[overlay-in_140ms_ease-out]")}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={t("gitChanges.revertTitle")} className={cn("w-full rounded-xl border border-line bg-surface p-4", closing ? "motion-safe:animate-[dialog-out_140ms_ease-in]" : "motion-safe:animate-[dialog-in_160ms_ease-out]")}>
        <div className="mb-1 text-[13px] font-semibold">{t("gitChanges.revertTitle")}</div>
        <p className="text-[12px] leading-relaxed text-muted">
          {(untracked ? t("gitChanges.revertDescUntracked") : t("gitChanges.revertDescTracked"))
            .split("{name}")
            .flatMap((part, i) => (i === 0 ? [part] : [<span key={i} className="text-fg-dim">{name}</span>, part]))}
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <button autoFocus onClick={dismiss} className="rounded-lg border border-line px-3 py-1 text-[12px] text-muted hover:bg-raised hover:text-fg-dim">{t("common.cancel")}</button>
          <button onClick={confirmAndClose} className="rounded-lg bg-fail/90 px-3 py-1 text-[12px] font-medium text-fg hover:bg-fail">{t("gitChanges.revert")}</button>
        </div>
      </div>
    </div>
  );
}
