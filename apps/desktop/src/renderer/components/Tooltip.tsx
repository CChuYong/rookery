import { cloneElement, isValidElement, useId } from "react";
import type { ReactElement, ReactNode } from "react";
import { cn } from "../lib/cn.js";

const SIDE = {
  top: "bottom-full left-1/2 -translate-x-1/2 mb-1",
  bottom: "top-full left-1/2 -translate-x-1/2 mt-1",
  right: "left-full top-1/2 -translate-y-1/2 ml-1",
  left: "right-full top-1/2 -translate-y-1/2 mr-1",
} as const;

// For top/bottom tips whose trigger sits at a window edge: anchor the bubble to the trigger's edge instead of
// centring it, so it cannot run off-screen (the status bar's right-hand cluster).
const ALIGN = {
  center: "",
  start: "left-0 translate-x-0",
  end: "left-auto right-0 translate-x-0",
} as const;

// `className` styles the wrapper (e.g. `w-full` so a full-width trigger keeps its width).
export function Tooltip({ label, side = "top", align = "center", className, children }: { label: string; side?: keyof typeof SIDE; align?: keyof typeof ALIGN; className?: string; children: ReactNode }): JSX.Element {
  const id = useId();
  // Associate the tip with its trigger for screen readers (aria-describedby) when children is a single element.
  const trigger = isValidElement(children)
    ? cloneElement(children as ReactElement, { "aria-describedby": id } as Record<string, unknown>)
    : children;
  return (
    <span className={cn("group relative inline-flex", className)}>
      {trigger}
      {/* wraps + caps width so long (e.g. Korean) labels don't run off-screen */}
      <span
        id={id}
        role="tooltip"
        className={cn(
          "pointer-events-none absolute z-50 w-max max-w-[220px] whitespace-normal break-words rounded-md border border-line bg-raised px-2 py-1 text-meta leading-snug text-fg-dim opacity-0 shadow-md transition-opacity group-hover:opacity-100 group-focus-within:opacity-100",
          SIDE[side],
          (side === "top" || side === "bottom") && ALIGN[align],
        )}
      >
        {label}
      </span>
    </span>
  );
}
