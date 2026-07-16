import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { LogItem } from "../store/reduce.js";
import { ToolBlock } from "./ToolBlock.js";
import { cn } from "../lib/cn.js";
import { useJustEnded } from "../lib/useJustEnded.js";
import { Collapse } from "./Collapse.js";
import { useT } from "../i18n/provider.js";

type ToolItem = Extract<LogItem, { kind: "tool" }>;

// Bundle consecutive tool calls into a collapsed group so the conversation text isn't buried (an agent may make dozens to hundreds of calls).
export function ToolGroup({ tools, onOpenFile, onSelectWorker, className }: { tools: ToolItem[]; onOpenFile?: (path: string) => void; onSelectWorker?: (id: string) => void; className?: string }): JSX.Element {
  const t = useT();
  const [open, setOpen] = useState(false);
  // Always call hooks above the early return (rules of hooks). Settle once when the group transitions from 'running' to 'ended'.
  const running = tools.some((t) => t.status !== "complete");
  const justSettled = useJustEnded(running);
  if (tools.length === 1) {
    const t = tools[0]!;
    return <ToolBlock name={t.name} status={t.status} ok={t.ok} input={t.input} result={t.result} elapsedSec={t.elapsedSec} workflow={t.workflow} onOpenFile={onOpenFile} onSelectWorker={onSelectWorker} className={className} />;
  }
  const errors = tools.filter((t) => t.ok === false).length;
  const names = [...new Set(tools.map((t) => t.name))].slice(0, 4).join(", ");
  return (
    <div className={cn("max-w-[80%] self-start", className)}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn("relative flex w-full items-center gap-2 overflow-hidden rounded-[var(--radius)] border border-line bg-surface px-3 py-2 text-[12px] hover:bg-raised/40", running && "sheen")}
      >
        <ChevronRight size={12} className={cn("shrink-0 text-muted transition-transform duration-200 ease-out", open && "rotate-90")} />
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full transition-colors duration-200", running ? "bg-run led-live" : errors ? "bg-fail" : "bg-pr", justSettled && "dot-settle")} />
        <span className="shrink-0 font-medium text-fg-dim">{t("toolGroup.toolCalls", { count: tools.length })}</span>
        <span className="truncate font-mono text-[10.5px] text-muted">{names}</span>
        {errors > 0 && <span className="ml-auto shrink-0 font-mono text-[10px] text-fail">{errors} error</span>}
      </button>
      <Collapse open={open}>
        <div className="mt-1 flex flex-col gap-1 pl-3">
          {tools.map((t, i) => (
            <ToolBlock key={i} name={t.name} status={t.status} ok={t.ok} input={t.input} result={t.result} elapsedSec={t.elapsedSec} workflow={t.workflow} onOpenFile={onOpenFile} onSelectWorker={onSelectWorker} />
          ))}
        </div>
      </Collapse>
    </div>
  );
}
