import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/cn.js";
import { MENU_SURFACE } from "../lib/ui-tokens.js";

// hint: an optional one-line consequence shown under the label (e.g. what a teardown action reclaims / whether
// it's reversible) — makes the action self-describing at the point of use instead of relying on learned meaning.
export type MenuItem = { label: string; onClick: () => void; danger?: boolean; hint?: string };

const VIEWPORT_GUTTER = 8;

// Keep a menu opened at (x,y) inside the window (audit #26): when it would run past the bottom edge it opens above the
// anchor, past the right edge it opens to the left of it — and it never goes past the top/left gutter.
export function clampMenuPosition(
  anchor: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const left = anchor.x + size.width > viewport.width - VIEWPORT_GUTTER ? Math.max(VIEWPORT_GUTTER, anchor.x - size.width) : anchor.x;
  const top = anchor.y + size.height > viewport.height - VIEWPORT_GUTTER ? Math.max(VIEWPORT_GUTTER, anchor.y - size.height) : anchor.y;
  return { left, top };
}

// Right-click context menu. Rendered via a portal at the cursor position (x,y); closes on outside click/Esc/scroll.
// Keyboard: focuses the first item on open, Arrow Up/Down roving, Enter activates, Esc closes — so the right-click-only
// worker/file actions also have a keyboard path. `header` is an optional non-interactive block above the items.
export function ContextMenu({ x, y, items, onClose, header }: { x: number; y: number; items: MenuItem[]; onClose: () => void; header?: ReactNode }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  // Measure once mounted (before paint) and flip into the viewport if needed.
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || (r.width === 0 && r.height === 0)) { setPos({ left: x, top: y }); return; }
    setPos(clampMenuPosition({ x, y }, { width: r.width, height: r.height }, { width: window.innerWidth, height: window.innerHeight }));
  }, [x, y, items.length]);
  useEffect(() => {
    const close = (): void => onClose();
    const esc = (e: KeyboardEvent): void => { if (e.key === "Escape") onClose(); };
    window.addEventListener("mousedown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", esc);
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("scroll", close, true); window.removeEventListener("keydown", esc); };
  }, [onClose]);
  const onKeyDown = (e: ReactKeyboardEvent): void => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const btns = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    if (btns.length === 0) return;
    const idx = btns.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? (idx + 1) % btns.length : (idx - 1 + btns.length) % btns.length;
    btns[next]?.focus();
  };
  return createPortal(
    <div
      ref={ref}
      role="menu"
      onKeyDown={onKeyDown}
      style={{ left: pos.left, top: pos.top, transformOrigin: "top left" }}
      className={cn("menu-pop fixed z-[100] min-w-[150px]", MENU_SURFACE)}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {header}
      {items.map((it, i) => (
        <button
          key={i}
          role="menuitem"
          onClick={() => { onClose(); it.onClick(); }}
          className={cn("flex min-h-6 w-full flex-col justify-center rounded-md px-2.5 py-1 text-left text-ui transition-colors focus:outline-none focus-visible:outline-none", it.danger ? "text-fail hover:bg-fail/15 focus:bg-fail/15" : "text-fg-dim hover:bg-raised hover:text-fg focus:bg-raised focus:text-fg")}
        >
          {it.label}
          {it.hint && <span className="mt-0.5 block text-meta font-normal text-muted">{it.hint}</span>}
        </button>
      ))}
    </div>,
    document.body,
  );
}
