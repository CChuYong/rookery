import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/cn.js";
import { MENU_SURFACE } from "../lib/ui-tokens.js";
import { rovingIndex, useFocusReturn } from "../lib/focus.js";

// hint: an optional one-line consequence shown under the label (e.g. what a teardown action reclaims / whether
// it's reversible) — makes the action self-describing at the point of use instead of relying on learned meaning.
// shortcut: the keyboard equivalent, shown right-aligned and faint like an IDE menu (aria-hidden; the item carries it as
// aria-keyshortcuts instead so it doesn't become part of the item's accessible name).
export type MenuItem = { label: string; onClick: () => void; danger?: boolean; hint?: string; shortcut?: { label: string; aria: string } };

const VIEWPORT_GUTTER = 8;

export type AnchorRect = { top: number; bottom: number; left: number; right: number };

// Keep a menu opened at (x,y) inside the window (audit #26): when it would run past the bottom edge it opens above the
// anchor, past the right edge it opens to the left of it — and it never goes past the top/left gutter. With the
// trigger's rect (a button-opened menu) it flips above the trigger and lines up with its right edge, so a flipped menu
// never covers the button that opened it.
export function clampMenuPosition(
  anchor: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  rect?: AnchorRect,
): { left: number; top: number } {
  const flipX = rect ? rect.right - size.width : anchor.x - size.width;
  const flipY = rect ? rect.top - size.height : anchor.y - size.height;
  const left = anchor.x + size.width > viewport.width - VIEWPORT_GUTTER ? Math.max(VIEWPORT_GUTTER, flipX) : anchor.x;
  const top = anchor.y + size.height > viewport.height - VIEWPORT_GUTTER ? Math.max(VIEWPORT_GUTTER, flipY) : anchor.y;
  return { left, top };
}

// Right-click context menu. Rendered via a portal at the cursor position (x,y); closes on outside click/Esc/scroll.
// Keyboard: focuses the first item on open, Arrow Up/Down roving (wrapping), Home/End, Enter activates, Esc closes, Tab
// closes (a menu is not a tab stop to wander out of, audit #67) — so the right-click-only worker/file actions also have a
// keyboard path. Focus goes back to the element that had it when the menu opened (the row or '⋯' button) on Esc/Tab and
// BEFORE an item runs, so a dialog the item opens returns focus to that trigger when it closes. `header` is an optional
// non-interactive block above the items. `anchorRect` = the rect of the button that opened the menu (omit for a
// right-click at the cursor).
export function ContextMenu({ x, y, items, onClose, header, anchorRect }: { x: number; y: number; items: MenuItem[]; onClose: () => void; header?: ReactNode; anchorRect?: AnchorRect }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useFocusReturn();
  const [pos, setPos] = useState({ left: x, top: y });
  // Measure once mounted (before paint) and flip into the viewport if needed.
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || (r.width === 0 && r.height === 0)) { setPos({ left: x, top: y }); return; }
    setPos(clampMenuPosition({ x, y }, { width: r.width, height: r.height }, { width: window.innerWidth, height: window.innerHeight }, anchorRect));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- anchorRect is a fresh object per open; x/y change with it
  }, [x, y, items.length]);
  useEffect(() => {
    const close = (): void => onClose();
    // A scroll closes the menu; if focus was inside it, it would otherwise fall to <body> with the unmount.
    const onScroll = (): void => { if (ref.current?.contains(document.activeElement)) trigger.restore(); onClose(); };
    const esc = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.preventDefault(); // claimed: a page-level Escape (Settings/Automation close) must not also fire
      trigger.restore();
      onClose();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("keydown", esc);
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("scroll", onScroll, true); window.removeEventListener("keydown", esc); };
  }, [onClose, trigger]);
  const onKeyDown = (e: ReactKeyboardEvent): void => {
    if (e.key === "Tab") {
      e.preventDefault();
      trigger.restore();
      onClose();
      return;
    }
    const btns = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const next = rovingIndex(e.key, btns.indexOf(document.activeElement as HTMLButtonElement), btns.length);
    if (next === null) return;
    e.preventDefault();
    btns[next]?.focus();
  };
  return createPortal(
    <div
      ref={ref}
      role="menu"
      onKeyDown={onKeyDown}
      style={{ left: pos.left, top: pos.top, transformOrigin: "top left" }}
      className={cn("menu-pop fixed z-[100] max-h-[calc(100vh-16px)] min-w-[150px] overflow-y-auto", MENU_SURFACE)}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {header}
      {items.map((it, i) => (
        <button
          key={i}
          role="menuitem"
          tabIndex={-1}
          aria-keyshortcuts={it.shortcut?.aria}
          onClick={() => { trigger.restore(); onClose(); it.onClick(); }}
          className={cn("flex min-h-6 w-full flex-col justify-center rounded-md px-2.5 py-1 text-left text-ui transition-colors focus:outline-none focus-visible:outline-none", it.danger ? "text-fail hover:bg-fail/15 focus:bg-fail/15" : "text-fg-dim hover:bg-raised hover:text-fg focus:bg-raised focus:text-fg")}
        >
          {it.shortcut ? (
            <span className="flex w-full items-center gap-4">
              <span className="min-w-0 flex-1">{it.label}</span>
              <span aria-hidden className="shrink-0 text-meta text-faint">{it.shortcut.label}</span>
            </span>
          ) : it.label}
          {it.hint && <span className="mt-0.5 block text-meta font-normal text-muted">{it.hint}</span>}
        </button>
      ))}
    </div>,
    document.body,
  );
}
