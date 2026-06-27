import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../lib/cn.js";
import { Collapse } from "./Collapse.js";

// Thinking summary (display:summarized) — collapsed by default. While streaming, a one-line preview shows it's alive.
export function ThinkingBlock({ text, streaming, className }: { text: string; streaming?: boolean; className?: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const preview = text.replace(/\s+/g, " ").trim().slice(-110);
  return (
    <div className={cn("w-full self-start", className)}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex max-w-full items-center gap-1.5 text-[11.5px] text-muted transition-colors hover:text-fg-dim"
      >
        <ChevronRight size={12} className={cn("shrink-0 transition-transform duration-200 ease-out motion-reduce:transition-none", open && "rotate-90")} />
        <span className="shrink-0">{streaming ? "Thinking…" : "Thinking"}</span>
        {streaming && <span className="led-live h-1 w-1 shrink-0 rounded-full bg-accent" />}
        {!open && streaming && preview && <span className="truncate text-muted/60">{preview}</span>}
      </button>
      <Collapse open={open}>
        <div className="mt-1 whitespace-pre-wrap border-l-2 border-line pl-3 text-[12px] leading-relaxed text-muted [overflow-wrap:anywhere]">
          {text}
        </div>
      </Collapse>
    </div>
  );
}
