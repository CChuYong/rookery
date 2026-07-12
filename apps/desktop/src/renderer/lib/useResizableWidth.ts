import { useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

// Resizes the panel width via mouse drag and persists it to localStorage.
// side="left": sidebar is on the left → handle at the right edge, dragging right widens it.
// side="right": sidebar is on the right → handle at the left edge, dragging left widens it.
export function useResizableWidth(
  key: string,
  initial: number,
  opts: { min: number; max: number; side: "left" | "right" },
): { width: number; startDrag: (e: ReactPointerEvent) => void; resizing: boolean } {
  const [width, setWidth] = useState(() => {
    const saved = Number.parseInt(localStorage.getItem(key) ?? "", 10);
    // Keep the user's preferred width even when the current viewport forces a
    // smaller effective max. This lets a roomy layout return when the window is
    // widened again instead of permanently collapsing the preference.
    return Number.isFinite(saved) ? Math.max(saved, opts.min) : initial;
  });
  const [resizing, setResizing] = useState(false);
  const effectiveWidth = clamp(width, opts.min, opts.max);

  const startDrag = (e: ReactPointerEvent): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = effectiveWidth;
    let latest = startW;
    setResizing(true);
    const onMove = (ev: PointerEvent): void => {
      const delta = opts.side === "left" ? ev.clientX - startX : startX - ev.clientX;
      latest = clamp(startW + delta, opts.min, opts.max);
      setWidth(latest);
    };
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      setResizing(false);
      localStorage.setItem(key, String(latest));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  };

  return { width: effectiveWidth, startDrag, resizing };
}
