import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ArrowUp, ChevronDown, Loader2 } from "lucide-react";
import { cn } from "../lib/cn.js";
import { MENU_SURFACE } from "../lib/ui-tokens.js";
import { useReturnFocusOnClose } from "../lib/focus.js";
import { Tooltip } from "./Tooltip.js";

// Shared chrome of the three "write a prompt" surfaces (conversation composer, New session, New worker): one box,
// one footer layout, one send button, one settings menu. Each surface keeps its own input and state; only the look
// and the layout live here, so the three stay identical (audit #85 #86).

/** The composer box: a quiet surface with a neutral focus edge, 6px radius (DESIGN.md composer radius). */
export const COMPOSER_BOX = "relative flex flex-col rounded-lg border border-line bg-surface transition-colors focus-within:border-fg/20";

/** Footer row: context on the left (may truncate or wrap inside its own group), actions pinned to the right, so the send
 *  button never wraps onto a line of its own however narrow the pane gets. */
export function ComposerFooter({ left, right, className }: { left?: ReactNode; right: ReactNode; className?: string }): JSX.Element {
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">{left}</div>
      {/* min-w-0 (not shrink-0): at an extreme width the model summary truncates; the buttons themselves never shrink. */}
      <div data-composer-actions className="flex min-w-0 items-center justify-end gap-1">{right}</div>
    </div>
  );
}

/** The send / start / spawn button: a 26px neutral circle with an arrow (never the accent). A tooltip names the action,
 *  or the reason it is disabled — the wrapper takes the hover, so it still shows while the button itself is disabled. */
export function SendButton({ label, hint, disabled, loading, onClick }: { label: string; hint?: string; disabled?: boolean; loading?: boolean; onClick: () => void }): JSX.Element {
  return (
    <Tooltip label={hint ?? label} align="end">
      <button
        type="button"
        aria-label={label}
        aria-busy={loading || undefined}
        disabled={disabled || loading}
        onClick={onClick}
        className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-fg text-ink transition-colors hover:bg-fg/90 disabled:cursor-not-allowed disabled:bg-raised disabled:text-faint"
      >
        {loading ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden /> : <ArrowUp size={14} strokeWidth={2} aria-hidden />}
      </button>
    </Tooltip>
  );
}

/** One labelled row inside a composer menu: a short label over the control, an optional quiet hint underneath. */
export function MenuField({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-1 px-2 py-1.5">
      <span className="text-meta text-muted">{label}</span>
      {children}
      {hint && <span className="text-meta leading-snug text-faint">{hint}</span>}
    </div>
  );
}

/** A quiet text button that opens a small popover (the composer's model menu, the New session folder menu). The panel
 *  stays mounted while closed (`hidden`) so typed values and selections survive closing it; Escape and an outside
 *  click close it and Escape returns focus to the trigger. */
export function ChromeMenu({
  summary,
  ariaLabel,
  children,
  side = "top",
  align = "end",
  disabled,
  icon,
  triggerClassName,
  panelClassName,
}: {
  summary: ReactNode;
  ariaLabel: string;
  children: ReactNode | ((close: () => void) => ReactNode);
  side?: "top" | "bottom";
  align?: "start" | "end";
  disabled?: boolean;
  icon?: ReactNode;
  triggerClassName?: string;
  panelClassName?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const close = (): void => setOpen(false);
  // A pick inside the panel (children's close) hides it with focus inside: hand focus back to the trigger.
  useReturnFocusOnClose(open, triggerRef, panelRef);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    // Move focus into the panel so keyboard users land on the first control.
    panelRef.current?.querySelector<HTMLElement>("select, input, button, [tabindex]")?.focus();
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div
      ref={rootRef}
      className="relative flex min-w-0"
      // Focus leaving the trigger+panel (Tab past the last control, a click elsewhere) closes the menu — it used to stay
      // open behind the user. relatedTarget null = focus went nowhere (window blur, a non-focusable click), so keep it.
      onBlur={(e) => {
        const next = e.relatedTarget as Node | null;
        if (open && next && !rootRef.current?.contains(next)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key !== "Escape" || !open) return;
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
        }}
        className={cn(
          "group flex h-6 min-w-0 items-center gap-1 rounded px-1.5 text-ui text-fg-dim transition-colors hover:bg-raised hover:text-fg disabled:cursor-not-allowed disabled:opacity-40",
          open && "bg-raised text-fg",
          triggerClassName,
        )}
      >
        {icon}
        <span className="min-w-0 truncate">{summary}</span>
        <ChevronDown size={12} className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden />
      </button>
      <div
        ref={panelRef}
        id={panelId}
        role="dialog"
        aria-label={ariaLabel}
        hidden={!open}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
          triggerRef.current?.focus();
        }}
        className={cn(
          "absolute z-40 w-64",
          side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
          align === "end" ? "right-0" : "left-0",
          MENU_SURFACE,
          panelClassName,
        )}
      >
        {typeof children === "function" ? children(close) : children}
      </div>
    </div>
  );
}
