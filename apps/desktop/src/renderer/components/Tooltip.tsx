import { cloneElement, isValidElement, useId } from "react";
import type { ReactElement, ReactNode } from "react";
import { cn } from "../lib/cn.js";

const SIDE = {
  top: "bottom-full left-1/2 -translate-x-1/2 mb-1",
  bottom: "top-full left-1/2 -translate-x-1/2 mt-1",
  right: "left-full top-1/2 -translate-y-1/2 ml-1",
  left: "right-full top-1/2 -translate-y-1/2 mr-1",
} as const;

export function Tooltip({ label, side = "top", children }: { label: string; side?: keyof typeof SIDE; children: ReactNode }): JSX.Element {
  const id = useId();
  // Associate the tip with its trigger for screen readers (aria-describedby) when children is a single element.
  const trigger = isValidElement(children)
    ? cloneElement(children as ReactElement, { "aria-describedby": id } as Record<string, unknown>)
    : children;
  return (
    <span className="group relative inline-flex">
      {trigger}
      {/* wraps + caps width so long (e.g. Korean) labels don't run off-screen */}
      <span
        id={id}
        role="tooltip"
        className={cn(
          "pointer-events-none absolute z-50 max-w-[220px] whitespace-normal break-words rounded-md border border-line bg-raised px-2 py-1 text-[11px] leading-snug text-fg-dim opacity-0 shadow-md transition-opacity group-hover:opacity-100 group-focus-within:opacity-100",
          SIDE[side],
        )}
      >
        {label}
      </span>
    </span>
  );
}
