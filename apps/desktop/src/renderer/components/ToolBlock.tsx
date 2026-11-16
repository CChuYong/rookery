import { useId, useState } from "react";
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
  const regionId = useId();
  const err = ok === false;
  const hasDetail = Boolean(input || result);
  const live = status !== "complete";
  const stopped = workflow?.status === "stopped";
  const dot = err ? "bg-fail" : stopped ? "bg-muted" : status === "complete" ? "bg-faint" : "bg-run led-live";
  // dot-settle once only on the in_progress→complete transition (so the working→done beat reads off a persistent node).
  const justDone = useJustEnded(live);
  const filePath = filePathOf(input);
  // spawn_worker's id is only readable from a non-error completion result (failure results have no id);
  // the other fleet cards (send_worker/get_worker_status/view_worker_diff/…) instead take the id as an
  // input argument, available from the start regardless of outcome (audit #47).
  const workerId = (err ? null : spawnedWorkerId(name, result)) ?? workerIdFromInput(name, input);
  return (
    <div className={cn("w-full self-start", className)}>
      {/* T3's "Worked for 46s ›" lightness: one flat 24px row, no card/box, no coloured left border. */}
      <div className="group flex h-6 w-full items-center gap-1.5 rounded px-1 text-ui transition-colors hover:bg-raised/50">
        <button
          onClick={() => hasDetail && setOpen((v) => !v)}
          aria-expanded={hasDetail ? open : undefined}
          aria-controls={hasDetail ? regionId : undefined}
          className={cn("flex min-w-0 items-center gap-1.5", hasDetail ? "cursor-pointer" : "cursor-default")}
        >
          {hasDetail ? (
            <ChevronRight size={12} className={cn("shrink-0 text-faint transition-transform duration-200 ease-out", open && "rotate-90")} />
          ) : (
            <span className="w-3 shrink-0" />
          )}
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full transition-colors duration-200", dot, justDone && "dot-settle")} />
          {workflow ? (
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className="text-meta text-faint">{name}</span>
              <span className="truncate text-fg-dim">{workflow.workflowName}</span>
            </span>
          ) : (
            <span className="truncate text-fg-dim">{name}</span>
          )}
        </button>
        {filePath && onOpenFile && (
          <button
            onClick={() => onOpenFile(filePath)}
            title={t("toolBlock.openFileTitle", { path: filePath })}
            className="flex min-w-0 items-center gap-1 rounded px-1 font-mono text-ui text-faint transition-colors hover:bg-raised hover:text-fg-dim"
          >
            <FileText size={12} className="shrink-0 text-faint" />
            <span className="truncate">{basename(filePath)}</span>
          </button>
        )}
        {workerId && onSelectWorker && (
          <button
            onClick={() => onSelectWorker(workerId)}
            title={t("toolBlock.goToWorkerView")}
            className="flex min-w-0 items-center gap-1 rounded px-1 font-mono text-ui text-faint transition-colors hover:bg-raised hover:text-fg-dim"
          >
            <Boxes size={12} className="shrink-0 text-faint" />
            <span className="truncate">{t("toolBlock.viewWorker")}</span>
          </button>
        )}
        <span className={cn("ml-1 shrink-0 text-meta", err ? "text-fail" : "text-faint")}>
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
        <div className="ml-5 pb-1 text-meta text-muted">
          {workflow.summary && <div className="mb-1 truncate text-fg-dim" title={workflow.summary}>{workflow.summary}</div>}
          <div className="font-mono">
            {t("workflowActivity.activeCount", { count: workflow.counts.active })}
            {" · "}{t("workflowActivity.completedCount", { count: workflow.counts.completed })}
            {" · "}{t("workflowActivity.startedCount", { count: workflow.counts.started })}
            {workflow.counts.stopped > 0 && <>{" · "}{t("workflowActivity.stoppedCount", { count: workflow.counts.stopped })}</>}
          </div>
        </div>
      )}
      <Collapse open={open && hasDetail} id={regionId}>
        <div className="ml-5 space-y-2 rounded-md border border-line-soft bg-sunk px-3 py-2">
          {input && (
            <div>
              <div className="mb-1 text-meta text-muted">{t("toolBlock.input")}</div>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap font-mono text-meta leading-relaxed text-fg-dim">{input}</pre>
            </div>
          )}
          {result && (
            <div>
              <div className="mb-1 text-meta text-muted">{t("toolBlock.result")}</div>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap font-mono text-meta leading-relaxed text-fg-dim">{result}</pre>
            </div>
          )}
        </div>
      </Collapse>
    </div>
  );
}
