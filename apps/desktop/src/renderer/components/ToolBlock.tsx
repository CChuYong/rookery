import { useState } from "react";
import { ChevronRight, FileText, Boxes } from "lucide-react";
import { cn } from "../lib/cn.js";
import { baseName as basename } from "../lib/path.js";
import { filePathOf } from "../lib/tool-file.js";
import { spawnedWorkerId, workerIdFromInput } from "../lib/tool-worker.js";
import { useJustEnded } from "../lib/useJustEnded.js";
import { useT } from "../i18n/provider.js";
import { Collapse } from "./Collapse.js";
import type { WorkflowRunSummary } from "@daemon/core/workflow-activity.js";

export function ToolBlock({
  name,
  status,
  ok,
  input,
  result,
  elapsedSec,
  workflow,
  onOpenFile,
  onSelectWorker,
  className,
}: {
  name: string;
  status: "in_progress" | "background" | "complete";
  ok?: boolean;
  input?: string;
  result?: string;
  elapsedSec?: number;
  workflow?: WorkflowRunSummary;
  onOpenFile?: (path: string) => void;
  onSelectWorker?: (id: string) => void; // fleet tool card (spawn/send/status/diff/…) → navigate to that worker's view (repo tab)
  className?: string;
}): JSX.Element {
  const t = useT();
  const [open, setOpen] = useState(false);
  const err = ok === false;
  const hasDetail = Boolean(input || result);
  const live = status !== "complete";
  const stopped = workflow?.status === "stopped";
  const dot = err ? "bg-fail" : stopped ? "bg-muted" : status === "complete" ? "bg-pr" : "bg-run led-live";
  // dot-settle once only on the in_progress→complete transition (so the working→done beat reads off a persistent node).
  const justDone = useJustEnded(live);
  const filePath = filePathOf(input);
  // spawn_worker's id is only readable from a non-error completion result (failure results have no id);
  // the other fleet cards (send_worker/get_worker_status/view_worker_diff/…) instead take the id as an
  // input argument, available from the start regardless of outcome (audit #47).
  const workerId = (err ? null : spawnedWorkerId(name, result)) ?? workerIdFromInput(name, input);
  return (
    <div className={cn("relative max-w-[80%] self-start overflow-hidden rounded-[var(--radius)] border border-line border-l-2 border-l-accent/70 bg-surface", live && !err && "sheen", className)}>
      {/* Header: (toggle button) + (filename chip) + status — the chip is a sibling button separate from the toggle (avoids nested buttons) */}
      <div className="flex w-full items-center gap-2 px-3 py-2 text-[12.5px]">
        <button
          onClick={() => hasDetail && setOpen((v) => !v)}
          className={cn("flex min-w-0 items-center gap-2", hasDetail ? "cursor-pointer" : "cursor-default")}
        >
          {hasDetail ? (
            <ChevronRight size={12} className={cn("shrink-0 text-muted transition-transform duration-200 ease-out", open && "rotate-90")} />
          ) : (
            <span className="w-3 shrink-0" />
          )}
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full transition-colors duration-200", dot, justDone && "dot-settle")} />
          {workflow ? (
            <span className="flex min-w-0 flex-col items-start">
              <span className="font-mono text-[9px] uppercase tracking-wide text-muted">{name}</span>
              <span className="truncate font-medium text-fg-dim">{workflow.workflowName}</span>
            </span>
          ) : (
            <span className="truncate font-mono text-fg-dim">{name}</span>
          )}
        </button>
        {filePath && onOpenFile && (
          <button
            onClick={() => onOpenFile(filePath)}
            title={t("toolBlock.openFileTitle", { path: filePath })}
            className="flex min-w-0 items-center gap-1 rounded-md border border-line bg-ink/40 px-1.5 py-0.5 font-mono text-[11px] text-fg-dim transition-colors hover:bg-raised hover:text-fg"
          >
            <FileText size={11} className="shrink-0 text-muted" />
            <span className="truncate">{basename(filePath)}</span>
          </button>
        )}
        {workerId && onSelectWorker && (
          <button
            onClick={() => onSelectWorker(workerId)}
            title={t("toolBlock.goToWorkerView")}
            className="flex min-w-0 items-center gap-1 rounded-md border border-line bg-ink/40 px-1.5 py-0.5 font-mono text-[11px] text-fg-dim transition-colors hover:bg-raised hover:text-fg"
          >
            <Boxes size={11} className="shrink-0 text-muted" />
            <span className="truncate">{t("toolBlock.viewWorker")}</span>
          </button>
        )}
        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted">
          {workflow
            ? t(`workflowActivity.${workflow.status}`)
            : err
              ? t("toolBlock.error")
              : live
                ? (elapsedSec ? `${elapsedSec}s` : t(status === "background" ? "toolBlock.background" : "toolBlock.inProgress"))
                : t("toolBlock.complete")}
        </span>
      </div>
      {workflow && (
        <div className="border-t border-line/70 px-3 py-2 text-[11px] text-muted">
          {workflow.summary && <div className="mb-1 truncate text-fg-dim" title={workflow.summary}>{workflow.summary}</div>}
          <div className="font-mono">
            {t("workflowActivity.activeCount", { count: workflow.counts.active })}
            {" · "}{t("workflowActivity.completedCount", { count: workflow.counts.completed })}
            {" · "}{t("workflowActivity.startedCount", { count: workflow.counts.started })}
            {workflow.counts.stopped > 0 && <>{" · "}{t("workflowActivity.stoppedCount", { count: workflow.counts.stopped })}</>}
          </div>
        </div>
      )}
      <Collapse open={open && hasDetail}>
        <div className="space-y-2 border-t border-line px-3 py-2">
          {input && (
            <div>
              <div className="mb-1 eyebrow-sm uppercase text-muted">input</div>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-fg-dim">{input}</pre>
            </div>
          )}
          {result && (
            <div>
              <div className="mb-1 eyebrow-sm uppercase text-muted">result</div>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-fg-dim">{result}</pre>
            </div>
          )}
        </div>
      </Collapse>
    </div>
  );
}
