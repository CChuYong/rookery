import { cloneElement, isValidElement, useId, useState } from "react";
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
// Shows on hover and on KEYBOARD focus only (audit #132): `:focus-visible`, not focus-within, so a button that keeps focus
// after a mouse click doesn't leave its bubble hanging over the page it opened. Escape hides it until the pointer or
// focus leaves. The bubble keys off its own named group (`group/tip`) so an outer row's hover can't show it; the plain
// `group` stays for children that style off this wrapper.
export function Tooltip({ label, side = "top", align = "center", className, children }: { label: string; side?: keyof typeof SIDE; align?: keyof typeof ALIGN; className?: string; children: ReactNode }): JSX.Element {
  const id = useId();
  const [hidden, setHidden] = useState(false);
  // Associate the tip with its trigger for screen readers (aria-describedby) when children is a single element.
  const trigger = isValidElement(children)
    ? cloneElement(children as ReactElement, { "aria-describedby": id } as Record<string, unknown>)
    : children;
  return (
    <span
      className={cn("group group/tip relative inline-flex", className)}
      // The first Escape only hides the bubble and claims the key, so it doesn't also close the page behind it.
      onKeyDown={(e) => { if (e.key === "Escape" && !hidden) { e.preventDefault(); setHidden(true); } }}
      onMouseLeave={() => setHidden(false)}
      onBlur={() => setHidden(false)}
    >
      {trigger}
      {/* wraps + caps width so long (e.g. Korean) labels don't run off-screen */}
      <span
        id={id}
        role="tooltip"
        className={cn(
          "pointer-events-none absolute z-50 w-max max-w-[220px] whitespace-normal break-words rounded-md border border-line bg-raised px-2 py-1 text-meta leading-snug text-fg-dim opacity-0 shadow-md transition-opacity",
          hidden ? "invisible" : "group-hover/tip:opacity-100 group-has-[:focus-visible]/tip:opacity-100",
          SIDE[side],
          (side === "top" || side === "bottom") && ALIGN[align],
        )}
      >
        {label}
      </span>
    </span>
  );
}
