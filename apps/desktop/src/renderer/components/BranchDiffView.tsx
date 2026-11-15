import { useEffect, useState } from "react";
import { SkeletonRows } from "./Skeleton.js";
import { baseName as basename } from "../lib/path.js";
import { cn } from "../lib/cn.js";
import { rowState } from "../lib/ui-tokens.js";
import { GIT_TONE } from "../lib/gitTone.js";
import { splitUnifiedDiff, type DiffFile } from "../lib/unified-diff.js";
import { useT } from "../i18n/provider.js";

// Read-only whole-branch diff for a worker (audit #84): everything it changed since its base, from fleet.diff. Same
// layout as CommitView — changed files on the left, the selected file's hunks on the right — so a worker that has
// already committed its work (empty Git Changes) can still be reviewed in one place.
export function BranchDiffView({ workerId, loadDiff }: { workerId: string; loadDiff: (workerId: string) => Promise<string> }): JSX.Element {
  const t = useT();
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setFiles(null);
    setFailed(false);
    loadDiff(workerId).then(
      (diff) => {
        if (!live) return;
        const parsed = splitUnifiedDiff(diff);
        setFiles(parsed);
        setSel((cur) => (cur && parsed.some((f) => f.path === cur) ? cur : parsed[0]?.path ?? null));
      },
      () => { if (live) setFailed(true); },
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadDiff is a fresh closure every App render; attempt drives retries
  }, [workerId, attempt]);

  if (failed) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-ui text-muted">
        <span>{t("branchDiff.loadFailed")}</span>
        <button onClick={() => setAttempt((n) => n + 1)} className="rounded-md px-1.5 text-ui text-fg-dim hover:bg-raised hover:text-fg">{t("common.retry")}</button>
      </div>
    );
  }
  if (!files) return <SkeletonRows rows={8} />;
  if (files.length === 0) return <div className="flex flex-1 items-center justify-center text-ui text-muted">{t("branchDiff.empty")}</div>;
  const file = files.find((f) => f.path === sel) ?? files[0]!;
  const totalAdded = files.reduce((n, f) => n + f.added, 0);
  const totalDeleted = files.reduce((n, f) => n + f.deleted, 0);
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-56 shrink-0 flex-col overflow-y-auto border-r border-line py-1">
        <div className="flex items-baseline gap-2 px-2.5 pb-1 pt-1.5 text-ui font-medium text-fg-dim">
          <span>{t("branchDiff.files", { count: files.length })}</span>
          <span className="font-mono text-meta tabular-nums font-normal"><span className="text-pr">+{totalAdded}</span> <span className="text-fail">−{totalDeleted}</span></span>
        </div>
        {files.map((f) => (
          <button key={f.path} onClick={() => setSel(f.path)} title={f.path} className={cn("flex h-6 w-full items-center gap-2 px-2.5 text-left text-ui", rowState(f.path === file.path))}>
            <span className={cn("w-3 shrink-0 text-center font-mono text-meta", GIT_TONE[f.status] ?? "text-muted")}>{f.status}</span>
            <span className="min-w-0 flex-1 truncate">{basename(f.path)}</span>
            <span className="shrink-0 font-mono text-meta tabular-nums"><span className="text-pr">+{f.added}</span> <span className="text-fail">−{f.deleted}</span></span>
          </button>
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="shrink-0 truncate border-b border-line px-3 py-1.5 font-mono text-meta text-muted" title={file.path}>{file.path}</div>
        <pre className="min-h-0 flex-1 overflow-auto py-1 font-mono text-meta leading-relaxed">
          {file.lines.map((line, i) => (
            <div
              key={i}
              className={cn(
                "whitespace-pre px-3",
                line.startsWith("+") ? "bg-pr/10 text-pr" : line.startsWith("-") ? "bg-fail/10 text-fail" : line.startsWith("@@") ? "text-muted" : "text-fg-dim",
              )}
            >
              {line}
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}
