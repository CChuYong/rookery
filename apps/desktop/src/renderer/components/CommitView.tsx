import { useEffect, useState } from "react";
import { MonacoDiff } from "./MonacoDiff.js";
import { SkeletonRows } from "./Skeleton.js";
import { baseName as basename } from "../lib/path.js";
import { cn } from "../lib/cn.js";
import { rowState } from "../lib/ui-tokens.js";
import { GIT_TONE } from "../lib/gitTone.js";
import { useT } from "../i18n/provider.js";

type CFile = { path: string; status: string; added: number; deleted: number };
type CInfo = { hash: string; shortHash: string; author: string; email: string; date: string; subject: string; body: string };

// Multi-file diff page for a single commit: commit details on top + changed-file list on the left + selected-file diff (parent <-> commit) on the right.
export function CommitView({ root, hash }: { root: string; hash: string }): JSX.Element {
  const t = useT();
  const [files, setFiles] = useState<CFile[] | null>(null);
  const [info, setInfo] = useState<CInfo | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => {
    if (!root) return;
    let live = true;
    void window.rookery.ws.gitCommitFiles(root, hash).then((fs) => {
      if (!live) return;
      setFiles(fs);
      setSel((cur) => cur ?? fs[0]?.path ?? null);
    });
    void window.rookery.ws.gitCommitInfo(root, hash).then((i) => { if (live) setInfo(i); });
    return () => { live = false; };
  }, [root, hash]);

  if (!files) return <SkeletonRows rows={8} />;
  if (files.length === 0) return <div className="flex flex-1 items-center justify-center text-ui text-muted">{t("commitView.noChangedFiles")}</div>;
  const totalAdded = files.reduce((s, f) => s + f.added, 0);
  const totalDeleted = files.reduce((s, f) => s + f.deleted, 0);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Commit details (top) */}
      <div className="shrink-0 border-b border-line px-4 py-2.5">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-body font-medium tracking-[-0.01em]">{info?.subject || "—"}</span>
          <span className="shrink-0 font-mono text-meta text-muted/80">{info?.shortHash || hash.slice(0, 7)}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-meta text-muted">
          {info?.author && <span className="text-fg-dim">{info.author}</span>}
          {info?.email && <span className="text-muted/70">&lt;{info.email}&gt;</span>}
          {info?.date && <><span className="h-3 w-px bg-line" aria-hidden /><span>{info.date}</span></>}
          <span className="h-3 w-px bg-line" aria-hidden />
          <span>{t(files.length === 1 ? "commitView.filesOne" : "commitView.filesMany", { count: files.length })} <span className="tabular-nums text-pr">+{totalAdded}</span> <span className="tabular-nums text-fail">−{totalDeleted}</span></span>
        </div>
        {info?.body && <pre className="mt-2 max-h-28 overflow-y-auto whitespace-pre-wrap break-words font-sans text-meta leading-relaxed text-fg-dim/90">{info.body}</pre>}
      </div>

      <div className="flex min-h-0 flex-1">
      <div className="flex w-56 shrink-0 flex-col overflow-y-auto border-r border-line py-1">
        <div className="px-2.5 pb-1 pt-1.5 text-ui font-medium text-fg-dim">{t("commitView.changedFiles", { count: files.length })}</div>
        {files.map((f) => (
          <button
            key={f.path}
            onClick={() => setSel(f.path)}
            title={f.path}
            className={cn("flex h-6 w-full items-center gap-2 px-2.5 text-left text-ui", rowState(sel === f.path))}
          >
            <span className={cn("w-3 shrink-0 text-center font-mono text-meta", GIT_TONE[f.status] ?? "text-muted")}>{f.status}</span>
            <span className="min-w-0 flex-1 truncate">{basename(f.path)}</span>
            <span className="shrink-0 font-mono text-meta tabular-nums"><span className="text-pr">+{f.added}</span> <span className="text-fail">−{f.deleted}</span></span>
          </button>
        ))}
      </div>
        <div className="flex min-w-0 flex-1 flex-col">
          {sel && <MonacoDiff key={`${hash}:${sel}`} root={root} path={`${root}/${sel}`} commit={hash} />}
        </div>
      </div>
    </div>
  );
}
