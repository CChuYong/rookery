import { useState } from "react";
import type { PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent } from "react";

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export const RESIZE_KEY_STEP = 16;

// Keyboard resize for a separator (audit #106): arrows move it 16px toward the arrow (so for a right-hand panel,
// ArrowLeft widens it), Home/End jump to the minimum/maximum. Null = not a resize key.
export function widthForKey(key: string, width: number, opts: { min: number; max: number; side: "left" | "right" }): number | null {
  const grow = opts.side === "left" ? "ArrowRight" : "ArrowLeft";
  const shrink = opts.side === "left" ? "ArrowLeft" : "ArrowRight";
  if (key === grow) return clamp(width + RESIZE_KEY_STEP, opts.min, opts.max);
  if (key === shrink) return clamp(width - RESIZE_KEY_STEP, opts.min, opts.max);
  if (key === "Home") return opts.min;
  if (key === "End") return opts.max;
  return null;
}

// Everything a separator element needs to be operable without a mouse and resettable by double-click.
export interface ResizeHandleBindings {
  value: number;
  min: number;
  max: number;
  onKeyDown: (e: ReactKeyboardEvent) => void;
  onReset: () => void;
}

// Resizes the panel width via mouse drag and persists it to localStorage.
// side="left": sidebar is on the left → handle at the right edge, dragging right widens it.
// side="right": sidebar is on the right → handle at the left edge, dragging left widens it.
export function useResizableWidth(
  key: string,
  initial: number,
  opts: { min: number; max: number; side: "left" | "right" },
): { width: number; startDrag: (e: ReactPointerEvent) => void; resizing: boolean; handle: ResizeHandleBindings } {
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

  const commit = (next: number): void => {
    setWidth(next);
    localStorage.setItem(key, String(next));
  };
  const handle: ResizeHandleBindings = {
    value: effectiveWidth,
    min: opts.min,
    max: opts.max,
    onKeyDown: (e) => {
      const next = widthForKey(e.key, effectiveWidth, opts);
      if (next === null) return;
      e.preventDefault();
      commit(next);
    },
    // Double-click puts the panel back to its default width (IDE convention).
    onReset: () => commit(clamp(initial, opts.min, opts.max)),
  };

  return { width: effectiveWidth, startDrag, resizing, handle };
}
