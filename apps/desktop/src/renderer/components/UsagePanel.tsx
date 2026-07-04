import { memo } from "react";
import { Info } from "lucide-react";
import type { UsageSnapshot } from "@daemon/core/usage.js";
import { cn } from "../lib/cn.js";
import { useT } from "../i18n/provider.js";
import { SkeletonRows } from "./Skeleton.js";
import { Tooltip } from "./Tooltip.js";

function fmtTok(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

// Single-line % gauge (server-side OAuth utilization).
function Meter({ label, pct, sub }: { label: string; pct: number; sub?: string }): JSX.Element {
  const w = Math.max(0, Math.min(100, pct));
  const near = w >= 90; // approaching limit → red pulse + text marker (for color-blind accessibility)
  const tone = near ? "bg-fail" : w >= 70 ? "bg-run" : "bg-accent";
  return (
    <div className="px-2 py-1.5">
      <div className="flex items-baseline justify-between gap-2 text-[10.5px]">
        <span className="truncate text-muted">{label}</span>
        <span className="shrink-0 font-mono text-fg-dim">
          {Math.round(pct)}%{sub ? <span className="text-muted"> · {sub}</span> : null}{near ? <span className="text-fail"> · limit</span> : null}
        </span>
      </div>
      {/* When near, drop overflow-hidden so the led-live glow shows outside the track. text-fail sets the pulse color to red. */}
      <div className={cn("mt-1 h-1 w-full rounded-full bg-line", !near && "overflow-hidden")}>
        <div className={cn("usage-fill h-full rounded-full transition-[width,background-color] duration-500 ease-out", tone, near && "led-live text-fail")} style={{ width: `${w}%` }} />
      </div>
    </div>
  );
}

// Single-line number without a gauge (ccusage tokens/$).
function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-2 px-2 py-1 text-[10.5px]">
      <span className="truncate text-muted">{label}</span>
      <span className="shrink-0 font-mono text-fg-dim">{value}</span>
    </div>
  );
}

function UsagePanelImpl({ usage, loadFailed }: { usage: UsageSnapshot | null; loadFailed?: boolean }): JSX.Element {
  const t = useT();
  const p = usage?.pct;
  const wk = usage?.weekly;
  const hasAny = !!(p || usage?.session || wk || usage?.today);
  return (
    <div className="border-t border-line pt-1">
      {/* Always-rendered header: (a) names the number's scope so a fresh install's real global ccusage figures
          don't read as "this app already spent money" (audit #56), and (b) anchors the panel's height from the
          very first paint so pre-load/loaded states don't pop the sidebar layout (audit #55). */}
      <div className="flex items-center gap-1 px-2 pt-1 text-[10.5px] text-muted">
        <span>{t("usagePanel.title")}</span>
        <Tooltip label={t("usagePanel.titleHint")} side="top">
          <Info size={11} tabIndex={0} aria-label={t("usagePanel.titleHint")} className="shrink-0 rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-accent/50" />
        </Tooltip>
      </div>

      {/* Pre-load: skeleton instead of returning null, so the meters don't suddenly pop in once usage.get resolves. */}
      {!usage && !loadFailed && <SkeletonRows rows={2} className="px-2 py-1.5" />}
      {/* Sustained failure (repeated usage.get rejections, still nothing loaded): say so instead of staying blank forever. */}
      {!usage && loadFailed && <div className="px-2 py-1.5 text-[10.5px] text-muted">{t("usagePanel.loadFailed")}</div>}
      {usage && !hasAny && <div className="px-2 py-1.5 text-[10.5px] text-muted">{t("usagePanel.loading")}</div>}

      {usage && hasAny && (
        <>
          {/* Server-side % (official, same source as /usage) */}
          {p?.fiveHour != null && <Meter label={t("usagePanel.session5h")} pct={p.fiveHour} sub={usage.session ? `${fmtTok(usage.session.totalTokens)} · ${usd(usage.session.costUSD)}` : undefined} />}
          {p?.sevenDay != null && <Meter label={t("usagePanel.weekly")} pct={p.sevenDay} sub={wk ? `${fmtTok(wk.totalTokens)} · ${usd(wk.costUSD)}` : undefined} />}
          {p?.sevenDayOpus != null && <Meter label={t("usagePanel.weeklyOpus")} pct={p.sevenDayOpus} />}
          {p?.sevenDaySonnet != null && <Meter label={t("usagePanel.weeklySonnet")} pct={p.sevenDaySonnet} />}

          {/* ccusage tokens/$ (no gauge needed) */}
          {!p && usage.session && <Stat label={t("usagePanel.session5h")} value={`${fmtTok(usage.session.totalTokens)} · ${usd(usage.session.costUSD)}`} />}
          {!p && wk && <Stat label={t("usagePanel.weekly")} value={`${fmtTok(wk.totalTokens)} · ${usd(wk.costUSD)}`} />}
          {usage.today && <Stat label={t("usagePanel.today")} value={`${fmtTok(usage.today.totalTokens)} · ${usd(usage.today.costUSD)}`} />}
          {p?.extra && <Stat label={t("usagePanel.extraCredits")} value={`${usd(p.extra.usedCredits)} / ${usd(p.extra.monthlyLimit)}`} />}
        </>
      )}
    </div>
  );
}

export const UsagePanel = memo(UsagePanelImpl);
UsagePanel.displayName = "UsagePanel";
