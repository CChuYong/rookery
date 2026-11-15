import { useEffect, useRef, useState } from "react";
import { Cpu, RefreshCw } from "lucide-react";
import type { ResourceSnapshot, ResourceBucket } from "../types/rookery.js";
import { fmtBytes } from "../format.js";
import { SkeletonRows } from "./Skeleton.js";
import { cn } from "../lib/cn.js";
import { MENU_SURFACE } from "../lib/ui-tokens.js";
import { useT } from "../i18n/provider.js";

function pct(n: number): string {
  return `${n.toFixed(1)}%`;
}

// One row of the detail popover. When indent=true it's a sub-row (Main/Renderer/Other).
function Row({ label, bucket, indent }: { label: string; bucket: ResourceBucket; indent?: boolean }): JSX.Element {
  return (
    <div className={cn("flex items-baseline justify-between gap-2 px-2 py-1 text-meta", indent && "pl-5")}>
      <span className={cn("truncate", indent ? "text-muted" : "text-fg-dim")}>{label}</span>
      <span className="flex shrink-0 items-center gap-1.5 font-mono text-fg-dim">
        <span className="tabular-nums">{pct(bucket.cpuPct)}</span>
        <span className="h-3 w-px shrink-0 bg-line" aria-hidden />
        <span className="tabular-nums">{fmtBytes(bucket.memBytes)}</span>
      </span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-meta text-faint">{label}</span>
      <span className="font-mono text-ui tabular-nums text-fg-dim">{value}</span>
    </div>
  );
}

export function ResourceMonitor({
  snapshot,
  collapsed,
  onRefresh,
  onOpenChange,
  variant = "sidebar",
  closeKey,
}: {
  snapshot: ResourceSnapshot | null;
  collapsed?: boolean;
  onRefresh?: () => void;
  onOpenChange?: (open: boolean) => void;
  variant?: "sidebar" | "statusbar"; // statusbar: borderless 11px trigger that opens the popover upward (bottom bar has no room below it)
  closeKey?: string; // the current route: a change closes the popover (audit #27)
}): JSX.Element {
  const t = useT();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const toggle = (): void => {
    setOpen((v) => {
      onOpenChange?.(!v);
      return !v;
    });
  };
  const close = (): void => {
    setOpen(false);
    onOpenChange?.(false);
  };
  // Escape closes the popover (audit #61 — mirrors OpenInAppMenu's Escape handling; previously outside-click was
  // the only way out).
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent): void => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- close/onOpenChange are recreated every render; open alone gates (re)bind
  }, [open]);
  // Close on a route change or a window resize (audit #27): keyboard/focus navigation never crosses the click-catcher
  // overlay, so the popover used to stay open over the next page's form.
  const lastKey = useRef(closeKey);
  useEffect(() => {
    if (lastKey.current === closeKey) return;
    lastKey.current = closeKey;
    if (open) close();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a route change should close
  }, [closeKey]);
  useEffect(() => {
    if (!open) return;
    const onResize = (): void => close();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- close/onOpenChange are recreated every render
  }, [open]);
  // Move focus inside on open — the Refresh button when present, otherwise the panel itself (audit #61: previously
  // opening left focus on the trigger button, so keyboard users had no way to tell the popover had opened).
  useEffect(() => {
    if (!open) return;
    (refreshRef.current ?? panelRef.current)?.focus();
  }, [open]);

  const label = snapshot ? fmtBytes(snapshot.memBytes) : "—";
  // Hotness = the worse of CPU / RAM-share. ≥70 amber, ≥90 red + led-live so a saturated host pulses coral right in the chrome.
  const hot = snapshot ? Math.max(snapshot.cpuPct, snapshot.ramSharePct) : 0;
  const hotTone = hot >= 90 ? "text-fail" : hot >= 70 ? "text-warn" : null; // a threshold is a warning, not "running" (audit #100)

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={t("resourceMonitor.resources")}
        onClick={toggle}
        title={t("resourceMonitor.tooltip")}
        className={cn(
          "no-drag flex items-center gap-1.5 font-mono transition-colors",
          variant === "statusbar"
            ? "h-5 rounded-sm px-1.5 text-meta hover:bg-raised"
            : "rounded-md border border-line bg-ink/40 text-meta hover:bg-raised",
          hotTone ?? "text-fg-dim",
          variant === "sidebar" && (collapsed ? "h-7 w-7 justify-center" : "px-2 py-1"),
        )}
      >
        <Cpu size={variant === "statusbar" ? 12 : 14} className={cn("shrink-0", hotTone ?? "text-muted", hot >= 90 && "led-live")} />
        {!collapsed && <span>{label}</span>}
      </button>

      {open && (
        <>
          {/* Close on outside click */}
          <div className="fixed inset-0 z-40" onClick={close} />
          <div
            ref={panelRef}
            tabIndex={-1}
            className={cn(
              "absolute z-50 w-[300px] focus:outline-none", MENU_SURFACE,
              // The status bar sits at the bottom of the viewport, so its popover opens upward; the collapsed
              // sidebar rail opens to the right (no room below); the full sidebar footer opens downward.
              variant === "statusbar" ? "bottom-full left-0 mb-1" : collapsed ? "left-full top-0 ml-2" : "left-0 top-full mt-1",
            )}
          >
            <div className="flex items-center justify-between px-2 pb-1.5 pt-1">
              <span className="text-ui font-medium">{t("resourceMonitor.resources")}</span>
              {onRefresh && (
                <button
                  ref={refreshRef}
                  type="button"
                  aria-label={t("common.refresh")}
                  onClick={onRefresh}
                  className="rounded p-1 text-muted hover:bg-raised hover:text-fg-dim"
                >
                  <RefreshCw size={12} />
                </button>
              )}
            </div>

            {snapshot ? (
              <>
                {/* Top totals: CPU · Memory · RAM share */}
                <div className="mb-1 grid grid-cols-3 gap-1 border-b border-line px-2 pb-2">
                  <Stat label={t("resourceMonitor.cpu")} value={pct(snapshot.cpuPct)} />
                  <Stat label={t("resourceMonitor.memory")} value={fmtBytes(snapshot.memBytes)} />
                  <Stat label={t("resourceMonitor.ramShare")} value={pct(snapshot.ramSharePct)} />
                </div>
                {/* Desktop App + sub-rows */}
                <Row label={t("resourceMonitor.desktopApp")} bucket={snapshot.app} />
                <Row label={t("resourceMonitor.main")} bucket={snapshot.app.main} indent />
                <Row label={t("resourceMonitor.renderer")} bucket={snapshot.app.renderer} indent />
                <Row label={t("resourceMonitor.other")} bucket={snapshot.app.other} indent />
                {/* Daemon */}
                {snapshot.daemon ? (
                  <Row label={t("resourceMonitor.daemon")} bucket={snapshot.daemon} />
                ) : (
                  <div className="flex items-baseline justify-between gap-2 px-2 py-1 text-meta">
                    <span className="text-fg-dim">{t("resourceMonitor.daemon")}</span>
                    <span className="shrink-0 text-muted/70">{t("resourceMonitor.daemonDown")}</span>
                  </div>
                )}
              </>
            ) : (
              <SkeletonRows rows={5} className="px-2 py-2" />
            )}
          </div>
        </>
      )}
    </div>
  );
}
