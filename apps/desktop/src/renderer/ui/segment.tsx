import { Fragment, type KeyboardEvent, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../lib/cn.js";
import { useSegmentIndicator } from "../lib/useSegmentIndicator.js";
import { TAB_IDLE, TAB_LINE } from "../lib/ui-tokens.js";

export type SegmentItem<V extends string = string> = {
  value: V;
  label: ReactNode;
  icon?: LucideIcon;
  count?: number; // small dim numeric adornment after the label (e.g. Sessions' per-source counts)
  disabled?: boolean;
  title?: string; // native title attribute (e.g. a disabled-reason hint)
  // Secondary items (e.g. Sessions' trailing 'All') render after a divider, sit outside the sliding
  // indicator's tracking (selecting one hides the indicator), and get a dimmer/smaller look — they're
  // still part of the same tablist and keyboard navigation, just one rung down the hierarchy.
  tier?: "primary" | "secondary";
};

export interface SegmentProps<V extends string = string> {
  items: Array<SegmentItem<V>>;
  value: V;
  onChange: (value: V) => void;
  // underline = a tab strip: the shared 1px neutral line + full-strength text mark the active tab (no fill, no wash —
  //   the same marker as the dock tabs, audit #99).
  // pill = in-form selection (a sliding raised background block marks the active choice).
  // icon = Orca-style ghost icon tabs (no sliding indicator, no visible label — the label becomes the a11y name + title tooltip).
  variant: "underline" | "pill" | "icon";
  className?: string; // merged onto the tablist container (layout/spacing/border overrides)
  itemClassName?: string; // merged onto every non-secondary item button (sizing/padding overrides)
  indicatorClassName?: string; // fine positioning override for the sliding indicator (e.g. a few px offset)
  "aria-label"?: string;
}

// Shared 'pick one of N' control (audit #52). Two canonical visual grammars — underline (nav-tier) and pill
// (in-form selection) — built on the existing useSegmentIndicator hook, replacing 5 ad-hoc implementations
// that each invented their own way to say "this one is selected". role="tablist"/"tab" + roving tabindex +
// arrow-key navigation throughout (all 5 sites switch a visible view, so tabs — not a radiogroup — fit best).
export function Segment<V extends string = string>({
  items,
  value,
  onChange,
  variant,
  className,
  itemClassName,
  indicatorClassName,
  ...aria
}: SegmentProps<V>): JSX.Element {
  const activeTier = items.find((i) => i.value === value)?.tier ?? "primary";
  // Secondary items don't participate in the sliding indicator — matches the pre-migration behavior where
  // only primary tabs carried the data-seg the indicator tracks.
  const { containerRef, rect } = useSegmentIndicator(activeTier === "secondary" ? null : value, [items.length]);
  const firstSecondaryIdx = items.findIndex((i) => i.tier === "secondary");

  const enabledValues = items.filter((i) => !i.disabled).map((i) => i.value);
  const move = (dir: 1 | -1): void => {
    const idx = enabledValues.indexOf(value);
    const next = enabledValues[((idx === -1 ? 0 : idx) + dir + enabledValues.length) % enabledValues.length];
    if (next === undefined || next === value) return;
    onChange(next);
    containerRef.current?.querySelector<HTMLButtonElement>(`[data-seg="${next}"]`)?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "ArrowRight") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); move(-1); }
  };

  return (
    <div ref={containerRef} role="tablist" aria-label={aria["aria-label"]} onKeyDown={onKeyDown} className={cn("relative flex items-center", className)}>
      {variant !== "icon" && rect && (
        <div
          className={cn(
            // placed instantly (no left/width animation): the selection moves, it does not slide
            "pointer-events-none absolute",
            variant === "underline" ? cn("bottom-0", TAB_LINE) : "inset-y-0.5 rounded-sm bg-raised",
            indicatorClassName,
          )}
          style={{ left: rect.left, width: rect.width }}
        />
      )}
      {items.map((item, idx) => {
        const active = item.value === value;
        const Icon = item.icon;
        const secondary = item.tier === "secondary";
        const stateCls = secondary
          ? (active ? "text-fg-dim" : "text-fg-dim/40 hover:text-fg-dim")
          : item.disabled
            ? "text-muted"
            : active
              ? (variant === "icon" ? "bg-raised text-fg" : "text-fg")
              : (variant === "icon" ? "text-muted hover:bg-raised hover:text-fg-dim" : TAB_IDLE);
        return (
          <Fragment key={item.value}>
            {idx === firstSecondaryIdx && <span className="mx-1 h-3 w-px shrink-0 bg-line" aria-hidden />}
            <button
              type="button"
              data-seg={item.value}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              disabled={item.disabled}
              title={item.title}
              onClick={() => !item.disabled && onChange(item.value)}
              className={cn(
                // no disabled:pointer-events-none — a disabled item can still carry a hint tooltip (title) that
                // should show on hover (e.g. WorkerSpawnPage's "connect GitHub first"); disabled:cursor-not-allowed
                // + no hover:* class in stateCls (below) is enough to suppress any color change on hover.
                "relative z-10 flex items-center justify-center gap-1 whitespace-nowrap transition-colors active:scale-[0.97] motion-reduce:active:scale-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent-hi disabled:cursor-not-allowed disabled:opacity-40",
                secondary
                  ? "rounded-sm px-1.5 py-0.5 text-meta"
                  : variant === "icon"
                    ? "h-6 w-6 rounded-sm"
                    : cn("rounded-sm px-2 py-1 text-ui", variant === "underline" && "rounded-t-sm rounded-b-none"),
                stateCls,
                !secondary && itemClassName,
              )}
            >
              {Icon && <Icon size={variant === "icon" ? 16 : 13} />}
              {variant === "icon" ? <span className="sr-only">{item.label}</span> : item.label}
              {item.count != null && (
                variant === "icon" ? (
                  <span className="pointer-events-none absolute -right-1 -top-1 flex h-3.5 min-w-[14px] items-center justify-center rounded-full border border-line bg-ink px-0.5 font-mono text-meta leading-none text-fg-dim">{item.count}</span>
                ) : (
                  <span className="ml-1 font-mono text-meta tabular-nums text-faint">{item.count}</span>
                )
              )}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}
