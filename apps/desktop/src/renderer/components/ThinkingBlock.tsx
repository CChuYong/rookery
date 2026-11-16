import { useId, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../lib/cn.js";
import { Collapse } from "./Collapse.js";

// Thinking summary (display:summarized) — collapsed by default. While streaming, a one-line preview shows it's alive.
export function ThinkingBlock({ text, streaming, className }: { text: string; streaming?: boolean; className?: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  const preview = text.replace(/\s+/g, " ").trim().slice(-110);
  return (
    <div className={cn("w-full self-start", className)}>
      {/* same flat row language as ToolBlock/ToolGroup — a quiet 24px line, not its own card. */}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={regionId}
        className="group flex h-6 max-w-full items-center gap-1.5 rounded px-1 text-ui text-muted transition-colors hover:bg-raised/50 hover:text-fg-dim"
      >
        <ChevronRight size={12} className={cn("shrink-0 text-faint transition-transform duration-200 ease-out motion-reduce:transition-none", open && "rotate-90")} />
        <span className="shrink-0">{streaming ? "Thinking…" : "Thinking"}</span>
        {streaming && <span className="led-live h-1 w-1 shrink-0 rounded-full bg-accent" />}
        {!open && streaming && preview && <span className="truncate text-muted/60">{preview}</span>}
      </button>
      <Collapse open={open} id={regionId}>
        <div className="ml-5 mt-0.5 whitespace-pre-wrap rounded-md border border-line-soft bg-sunk px-3 py-2 text-body leading-relaxed text-muted [overflow-wrap:anywhere]">
          {text}
        </div>
      </Collapse>
    </div>
  );
}
