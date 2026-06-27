import { useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

// Adjust the bottom drawer height by dragging the top edge. Dragging up (= clientY decreases) makes it larger.
// opts.onCommit: callback with the final height at drag end (pointerup) — used for store persistence.
export function useResizableHeight(
  initial: number,
  opts: { min: number; max: number; onCommit?: (h: number) => void },
): { height: number; startDrag: (e: ReactPointerEvent) => void; resizing: boolean } {
  const [height, setHeight] = useState(initial);
  const [resizing, setResizing] = useState(false);
  const startDrag = (e: ReactPointerEvent): void => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    let latest = startH;
    setResizing(true);
    const onMove = (ev: PointerEvent): void => { latest = clamp(startH + (startY - ev.clientY), opts.min, opts.max); setHeight(latest); };
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      setResizing(false);
      opts.onCommit?.(latest);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";
  };
  return { height, startDrag, resizing };
}
