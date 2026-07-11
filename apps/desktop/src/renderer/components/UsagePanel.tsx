import { memo, useState } from "react";
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
function fmtReset(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
  // Provider tab: Claude is the default (user direction); not persisted (YAGNI).
  const [tab, setTab] = useState<"claude" | "codex">("claude");
  const p = usage?.pct;
  const wk = usage?.weekly;
  const hasAny = !!(p || usage?.session || wk || usage?.today);
  const cdx = usage?.codex;
  return (
    <div className="border-t border-line pt-1">
      {/* Always-rendered header (audit #55/#56): per-tab title + provider tab toggle. */}
      <div className="flex items-center gap-1 px-2 pt-1 text-[10.5px] text-muted">
        <span>{t(tab === "claude" ? "usagePanel.title" : "usagePanel.titleCodex")}</span>
        <Tooltip label={t(tab === "claude" ? "usagePanel.titleHint" : "usagePanel.titleHintCodex")} side="top">
          <Info size={11} tabIndex={0} aria-label={t(tab === "claude" ? "usagePanel.titleHint" : "usagePanel.titleHintCodex")} className="shrink-0 rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-accent/50" />
        </Tooltip>
        <div className="ml-auto flex items-center gap-0.5">
          {(["claude", "codex"] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={tab === k}
              onClick={() => setTab(k)}
              className={cn("rounded px-1.5 py-0.5 text-[10px] leading-none transition-colors", tab === k ? "bg-line text-fg" : "text-muted hover:text-fg-dim")}
            >
              {t(k === "claude" ? "usagePanel.tabClaude" : "usagePanel.tabCodex")}
            </button>
          ))}
        </div>
      </div>

      {/* Shared pre-load states (gate on the snapshot itself, not per-tab). */}
      {!usage && !loadFailed && <SkeletonRows rows={2} className="px-2 py-1.5" />}
      {!usage && loadFailed && <div className="px-2 py-1.5 text-[10.5px] text-muted">{t("usagePanel.loadFailed")}</div>}

      {usage && tab === "claude" && (
        <>
          {!hasAny && <div className="px-2 py-1.5 text-[10.5px] text-muted">{t("usagePanel.loading")}</div>}
          {hasAny && (
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
        </>
      )}

      {usage && tab === "codex" && (
        cdx ? (
          <>
            {/* codex plan billing has no USD — tokens only, never $ */}
            {cdx.fiveHour && <Meter label={t("usagePanel.session5h")} pct={cdx.fiveHour.usedPercent} sub={cdx.fiveHour.resetsAt != null ? t("usagePanel.resets", { time: fmtReset(cdx.fiveHour.resetsAt) }) : undefined} />}
            {cdx.sevenDay && <Meter label={t("usagePanel.weekly")} pct={cdx.sevenDay.usedPercent} sub={cdx.weeklyTokens != null ? fmtTok(cdx.weeklyTokens) : undefined} />}
            {!cdx.sevenDay && cdx.weeklyTokens != null && <Stat label={t("usagePanel.weekly")} value={fmtTok(cdx.weeklyTokens)} />}
            {cdx.todayTokens != null && <Stat label={t("usagePanel.today")} value={fmtTok(cdx.todayTokens)} />}
          </>
        ) : (
          <div className="px-2 py-1.5 text-[10.5px] text-muted">{t("usagePanel.codexUnavailable")}</div>
        )
      )}
    </div>
  );
}

export const UsagePanel = memo(UsagePanelImpl);
UsagePanel.displayName = "UsagePanel";
