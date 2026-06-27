import type { PointerEvent as ReactPointerEvent } from "react";
import { cn } from "../lib/cn.js";

// Vertical drag handle inserted between panels (thin line + wide hit area).
export function ResizeHandle({
  onPointerDown,
  className,
}: {
  onPointerDown: (e: ReactPointerEvent) => void;
  className?: string;
}): JSX.Element {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      className={cn("no-drag group relative z-20 flex w-1.5 shrink-0 cursor-col-resize items-stretch", className)}
    >
      <div className="m-auto h-full w-px bg-line transition-colors group-hover:bg-accent/60 group-active:bg-accent" />
    </div>
  );
}
