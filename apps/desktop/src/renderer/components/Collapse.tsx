import { useLayoutEffect, useRef, type ReactNode } from "react";
import { cn } from "../lib/cn.js";

// Height-safe expand/collapse primitive. Smoothly reveals its content via a
// grid-template-rows 0fr↔1fr transition (the sanctioned technique that avoids
// animating a layout property directly). A drop-in replacement for every `{open && ...}`
// hard mount. render-latch (wasOpen): if it has never been opened, the content isn't
// rendered (lazy); after it closes, the mount is kept so the exit transition can play.
// reduced-motion is handled by .collapse-anim in globals.css.
export function Collapse({
  open,
  children,
  durationMs = 200,
  className,
  id,
}: {
  id?: string; // lets a disclosure button point aria-controls at this region
  open: boolean;
  children: ReactNode;
  durationMs?: number;
  className?: string;
}): JSX.Element {
  const wasOpen = useRef(open);
  if (open) wasOpen.current = true;
  // A closed region keeps its content mounted (for the exit transition) but must not stay reachable: `inert` takes it
  // out of the tab order and the roving lists, so Tab/Arrow keys can't land on a row inside a folded group.
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (open) ref.current?.removeAttribute("inert");
    else ref.current?.setAttribute("inert", "");
  }, [open]);
  return (
    <div
      ref={ref}
      id={id}
      className={cn(
        "collapse-anim grid grid-cols-[minmax(0,1fr)] transition-[grid-template-rows]",
        open ? "ease-out grid-rows-[1fr] opacity-100" : "ease-in grid-rows-[0fr] opacity-0",
        className,
      )}
      style={{ transitionDuration: `${durationMs}ms` }}
    >
      <div className="min-h-0 min-w-0 overflow-hidden">{open || wasOpen.current ? children : null}</div>
    </div>
  );
}
