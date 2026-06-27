import { useRef, type ReactNode } from "react";
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
}: {
  open: boolean;
  children: ReactNode;
  durationMs?: number;
  className?: string;
}): JSX.Element {
  const wasOpen = useRef(open);
  if (open) wasOpen.current = true;
  return (
    <div
      className={cn(
        "collapse-anim grid transition-[grid-template-rows]",
        open ? "ease-out grid-rows-[1fr] opacity-100" : "ease-in grid-rows-[0fr] opacity-0",
        className,
      )}
      style={{ transitionDuration: `${durationMs}ms` }}
    >
      <div className="min-h-0 overflow-hidden">{open || wasOpen.current ? children : null}</div>
    </div>
  );
}
