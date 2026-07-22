import { useEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/cn.js";

// hint: an optional one-line consequence shown under the label (e.g. what a teardown action reclaims / whether
// it's reversible) — makes the action self-describing at the point of use instead of relying on learned meaning.
export type MenuItem = { label: string; onClick: () => void; danger?: boolean; hint?: string };

// Right-click context menu. Rendered via a portal at the cursor position (x,y); closes on outside click/Esc/scroll.
// Keyboard: focuses the first item on open, Arrow Up/Down roving, Enter activates, Esc closes — so the right-click-only
// worker/file actions also have a keyboard path.
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
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
      style={{ left: x, top: y, transformOrigin: "top left" }}
      className="menu-pop fixed z-[100] min-w-[150px] rounded-lg border border-line bg-raised p-1 shadow-xl"
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((it, i) => (
        <button
          key={i}
          role="menuitem"
          onClick={() => { onClose(); it.onClick(); }}
          className={cn("block w-full rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors focus:outline-none", it.danger ? "text-fail hover:bg-fail/15 focus:bg-fail/15" : "text-fg-dim hover:bg-line/50 hover:text-fg focus:bg-line/50 focus:text-fg")}
        >
          {it.label}
          {it.hint && <span className="mt-0.5 block text-[10.5px] font-normal text-muted">{it.hint}</span>}
        </button>
      ))}
    </div>,
    document.body,
  );
}
