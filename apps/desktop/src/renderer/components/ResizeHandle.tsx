import type { PointerEvent as ReactPointerEvent } from "react";
import { cn } from "../lib/cn.js";
import type { ResizeHandleBindings } from "../lib/useResizableWidth.js";

// Vertical drag handle inserted between panels (thin line + wide hit area). With `handle` it is also a focusable
// separator: arrows resize, Home/End jump to the limits, double-click restores the default width (audit #106).
export function ResizeHandle({
  onPointerDown,
  handle,
  label,
  className,
}: {
  onPointerDown: (e: ReactPointerEvent) => void;
  handle?: ResizeHandleBindings;
  label?: string;
  className?: string;
}): JSX.Element {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={handle?.value}
      aria-valuemin={handle?.min}
      aria-valuemax={handle?.max}
      tabIndex={handle ? 0 : undefined}
      onKeyDown={handle?.onKeyDown}
      onDoubleClick={handle?.onReset}
      onPointerDown={onPointerDown}
      className={cn("no-drag group relative z-20 flex w-1.5 shrink-0 cursor-col-resize items-stretch outline-none", className)}
    >
      <div className="m-auto h-full w-px bg-transparent transition-colors group-hover:bg-thumb-hi group-focus-visible:bg-accent group-active:bg-accent" />
    </div>
  );
}
