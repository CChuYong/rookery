import { useState } from "react";
import { Cpu, RefreshCw } from "lucide-react";
import type { ResourceSnapshot, ResourceBucket } from "../types/rookery.js";
import { fmtBytes } from "../format.js";
import { SkeletonRows } from "./Skeleton.js";
import { cn } from "../lib/cn.js";
import { useT } from "../i18n/provider.js";

function pct(n: number): string {
  return `${n.toFixed(1)}%`;
}

// One row of the detail popover. When indent=true it's a sub-row (Main/Renderer/Other).
function Row({ label, bucket, indent }: { label: string; bucket: ResourceBucket; indent?: boolean }): JSX.Element {
  return (
    <div className={cn("flex items-baseline justify-between gap-2 px-2 py-1 text-[11px]", indent && "pl-5")}>
      <span className={cn("truncate", indent ? "text-muted" : "text-fg-dim")}>{label}</span>
      <span className="shrink-0 font-mono text-muted">
        <span className="text-fg-dim">{pct(bucket.cpuPct)}</span>
        <span className="mx-1 text-muted/50">·</span>
        <span className="text-fg-dim">{fmtBytes(bucket.memBytes)}</span>
      </span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="eyebrow text-[8.5px] uppercase tracking-[0.12em] text-muted/70">{label}</span>
      <span className="font-mono text-[12px] text-fg-dim">{value}</span>
    </div>
  );
}

export function ResourceMonitor({
  snapshot,
  collapsed,
  onRefresh,
  onOpenChange,
}: {
  snapshot: ResourceSnapshot | null;
  collapsed?: boolean;
  onRefresh?: () => void;
  onOpenChange?: (open: boolean) => void;
}): JSX.Element {
  const t = useT();
  const [open, setOpen] = useState(false);
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

  const label = snapshot ? fmtBytes(snapshot.memBytes) : "—";
  // Hotness = the worse of CPU / RAM-share. ≥70 amber, ≥90 red + led-live so a saturated host pulses coral right in the chrome.
  const hot = snapshot ? Math.max(snapshot.cpuPct, snapshot.ramSharePct) : 0;
  const hotTone = hot >= 90 ? "text-fail" : hot >= 70 ? "text-run" : null;

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={t("resourceMonitor.resources")}
        onClick={toggle}
        title={t("resourceMonitor.tooltip")}
        className={cn(
          "no-drag flex items-center gap-1.5 rounded-md border border-line bg-ink/40 font-mono text-[11px] transition-colors hover:bg-raised",
          hotTone ?? "text-fg-dim",
          collapsed ? "h-7 w-7 justify-center" : "px-2 py-1",
        )}
      >
        <Cpu size={13} className={cn("shrink-0", hotTone ?? "text-muted", hot >= 90 && "led-live")} />
        {!collapsed && <span>{label}</span>}
      </button>

      {open && (
        <>
          {/* Close on outside click */}
          <div className="fixed inset-0 z-40" onClick={close} />
          <div
            className={cn(
              "absolute z-50 w-[300px] rounded-xl border border-line bg-surface p-1.5 shadow-2xl",
              collapsed ? "left-full top-0 ml-2" : "left-0 top-full mt-1",
            )}
          >
            <div className="flex items-center justify-between px-2 pb-1.5 pt-1">
              <span className="text-[12px] font-semibold tracking-[-0.01em]">{t("resourceMonitor.resources")}</span>
              {onRefresh && (
                <button
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
                  <div className="flex items-baseline justify-between gap-2 px-2 py-1 text-[11px]">
                    <span className="text-fg-dim">{t("resourceMonitor.daemon")}</span>
                    <span className="shrink-0 font-mono text-muted/70">{t("resourceMonitor.daemonDown")}</span>
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
