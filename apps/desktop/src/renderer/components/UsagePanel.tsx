import { memo, useState } from "react";
import type { ReactNode } from "react";
import { ChevronRight, Info } from "lucide-react";
import type { UsageSnapshot } from "@daemon/core/usage.js";
import { cn } from "../lib/cn.js";
import { useT } from "../i18n/provider.js";
import { SkeletonRows } from "./Skeleton.js";
import { Tooltip } from "./Tooltip.js";

export type UsageTab = "claude" | "codex";

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

// One fill rule for every usage gauge (audit #55): neutral at rest, the warn token from 80%, fail from 90%. The accent
// and the "running" blue never fill a gauge (an orange bar read as the alarm, the blue as calm).
function meterTone(w: number): string {
  return w >= 90 ? "bg-fail" : w >= 80 ? "bg-warn" : "bg-fg-dim";
}

// Single-line % gauge (server-side OAuth utilization).
function Meter({ label, pct, sub }: { label: string; pct: number; sub?: ReactNode }): JSX.Element {
  const w = Math.max(0, Math.min(100, pct));
  const near = w >= 90; // approaching limit → red pulse + text marker (for color-blind accessibility)
  const tone = meterTone(w);
  return (
    <div className="px-2 py-1.5">
      <div className="flex items-baseline justify-between gap-1.5 text-meta">
        <span className="truncate text-muted">{label}</span>
        <span className="flex shrink-0 items-center gap-1.5 text-fg-dim">
          <span className="tabular-nums">{Math.round(pct)}%</span>
          {sub != null && (
            <>
              <span className="w-2 shrink-0" aria-hidden />
              <span className="inline-flex items-center gap-1.5 font-mono text-muted">{sub}</span>
            </>
          )}
          {/* "limit" is a word, not a figure — kept out of the mono run above (REFLEX 64). */}
          {near && (
            <>
              <span className="w-2 shrink-0" aria-hidden />
              <span className="text-fail">limit</span>
            </>
          )}
        </span>
      </div>
      {/* When near, drop overflow-hidden so the led-live glow shows outside the track. text-fail sets the pulse
          color to red. The fill never animates width (Floor: no width/height transitions) — a fixed full-width
          bar is scaled from the left instead. */}
      <div className={cn("mt-1 h-1 w-full rounded-full bg-line", !near && "overflow-hidden")}>
        <div
          className={cn("usage-fill h-full w-full origin-left rounded-full transition-[transform,background-color] duration-500 ease-out", tone, near && "led-live text-fail")}
          style={{ transform: `scaleX(${w / 100})` }}
        />
      </div>
    </div>
  );
}

// Single-line number without a gauge (ccusage tokens/$).
function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-2 px-2 py-1 text-meta">
      <span className="truncate text-muted">{label}</span>
      <span className="shrink-0 font-mono text-fg-dim">{value}</span>
    </div>
  );
}

// Status-bar meter: `label 31%` + a fixed 40x3px bar (neutral fill, warn from 80%, fail from 90% — meterTone).
// No width/height transition — the fill is a fixed-width bar scaled from the left (Floor: never animate width/height).
function MeterInline({ label, pct }: { label: string; pct: number }): JSX.Element {
  const w = Math.max(0, Math.min(100, pct));
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap">
      <span className="truncate text-muted">{label}</span>
      <span className="h-[3px] w-10 shrink-0 overflow-hidden rounded-full bg-line">
        <span
          className={cn("block h-full origin-left rounded-full transition-[transform,background-color] duration-500 ease-out", meterTone(w))}
          style={{ transform: `scaleX(${w / 100})` }}
        />
      </span>
      <span className="tabular-nums">{Math.round(pct)}%</span>
    </span>
  );
}

// Status-bar stat: plain `label value` pair, value in mono (parity with MeterInline's % figure).
function StatInline({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap">
      <span className="truncate text-muted">{label}</span>
      <span className="tabular-nums">{value}</span>
    </span>
  );
}

// `onOpenDetails` (statusbar only) turns the meter run into a button that opens the detail panel (audit #25); the
// Claude/Codex switch stays a sibling so buttons never nest.
// `tab`/`onTabChange` optionally control the provider tab, so the status strip and its detail popover stay on the same
// provider (review m3).
// `empty` = the poller has had several successful answers with no numbers → "no usage data" instead of "loading…"
// forever; `loadFailed` with a snapshot on screen marks the numbers as stale (audit #46).
function UsagePanelImpl({ usage, loadFailed, empty = false, compact = false, variant = "sidebar", onOpenDetails, detailsOpen, tab: tabProp, onTabChange }: { usage: UsageSnapshot | null; loadFailed?: boolean; empty?: boolean; compact?: boolean; variant?: "sidebar" | "statusbar"; onOpenDetails?: () => void; detailsOpen?: boolean; tab?: UsageTab; onTabChange?: (tab: UsageTab) => void }): JSX.Element {
  const t = useT();
  // Provider tab: Claude is the default (user direction); not persisted (YAGNI).
  const [ownTab, setOwnTab] = useState<UsageTab>("claude");
  const tab = tabProp ?? ownTab;
  const setTab = (next: UsageTab): void => { setOwnTab(next); onTabChange?.(next); };
  const [expanded, setExpanded] = useState(false);
  const p = usage?.pct;
  const wk = usage?.weekly;
  const hasAny = !!(p || usage?.session || wk || usage?.today);
  const cdx = usage?.codex;
  const showBody = !compact || expanded;

  if (variant === "statusbar") {
    const details = (body: ReactNode): JSX.Element =>
      onOpenDetails ? (
        <button
          type="button"
          onClick={onOpenDetails}
          aria-label={t("usagePanel.details")}
          aria-haspopup="dialog"
          aria-expanded={!!detailsOpen}
          title={t("usagePanel.details")}
          className={cn("no-drag inline-flex h-5 shrink-0 items-center gap-3 rounded-sm px-1 transition-colors hover:bg-raised", detailsOpen && "bg-raised")}
        >
          {body}
        </button>
      ) : <>{body}</>;
    if (!usage) return details(<span className="text-faint">{loadFailed ? t("usagePanel.loadFailed") : t("usagePanel.loading")}</span>);
    if (!hasAny && !cdx) return details(<span className="text-faint">{empty ? t("usagePanel.empty") : t("usagePanel.loading")}</span>);
    const showTabs = !!cdx; // only worth a tab switch once there's a second provider's data to switch to
    return (
      <span className="inline-flex shrink-0 items-center gap-3 text-meta">
        {showTabs && (
          <span className="inline-flex shrink-0 items-center gap-0.5">
            {(["claude", "codex"] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={tab === k}
                onClick={() => setTab(k)}
                className={cn("rounded-sm px-1 text-meta leading-none transition-colors", tab === k ? "text-fg-dim" : "text-faint hover:text-muted")}
              >
                {t(k === "claude" ? "usagePanel.tabClaude" : "usagePanel.tabCodex")}
              </button>
            ))}
          </span>
        )}
        {details(tab === "claude" ? (
          <>
            {p?.fiveHour != null && <MeterInline label={t("usagePanel.session5h")} pct={p.fiveHour} />}
            {p?.sevenDay != null && <MeterInline label={t("usagePanel.weekly")} pct={p.sevenDay} />}
            {!p && usage.session && <StatInline label={t("usagePanel.session5h")} value={usd(usage.session.costUSD)} />}
            {!p && wk && <StatInline label={t("usagePanel.weekly")} value={usd(wk.costUSD)} />}
            {usage.today && <StatInline label={t("usagePanel.today")} value={usd(usage.today.costUSD)} />}
            {!hasAny && <span className="text-faint">{empty ? t("usagePanel.empty") : t("usagePanel.loading")}</span>}
          </>
        ) : cdx ? (
          <>
            {cdx.fiveHour && <MeterInline label={t("usagePanel.session5h")} pct={cdx.fiveHour.usedPercent} />}
            {cdx.sevenDay && <MeterInline label={t("usagePanel.weekly")} pct={cdx.sevenDay.usedPercent} />}
            {cdx.todayTokens != null && <StatInline label={t("usagePanel.today")} value={fmtTok(cdx.todayTokens)} />}
          </>
        ) : (
          <span className="text-faint">{t("usagePanel.codexUnavailable")}</span>
        ))}
        {loadFailed && <span className="shrink-0 text-faint">{t("usagePanel.stale")}</span>}
      </span>
    );
  }

  return (
    <div className="border-t border-line pt-1">
      {/* Always-rendered header (audit #55/#56): per-tab title + provider tab toggle. */}
      <div className="flex items-center gap-1 px-2 pt-1 text-meta text-muted">
        <span className="min-w-0 flex-1 truncate">{t(tab === "claude" ? "usagePanel.title" : "usagePanel.titleCodex")}</span>
        <Tooltip label={t(tab === "claude" ? "usagePanel.titleHint" : "usagePanel.titleHintCodex")} side="top">
          <Info size={12} tabIndex={0} aria-label={t(tab === "claude" ? "usagePanel.titleHint" : "usagePanel.titleHintCodex")} className="shrink-0 rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-accent/50" />
        </Tooltip>
        {compact && (
          <button
            type="button"
            aria-label={t(expanded ? "usagePanel.collapse" : "usagePanel.expand")}
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className="shrink-0 rounded p-0.5 text-muted transition-colors hover:bg-raised hover:text-fg-dim"
          >
            <ChevronRight size={12} className={cn("transition-transform", expanded && "rotate-90")} />
          </button>
        )}
        {showBody && <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {(["claude", "codex"] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={tab === k}
              onClick={() => setTab(k)}
              className={cn("rounded px-1.5 py-0.5 text-meta leading-none transition-colors", tab === k ? "bg-line text-fg" : "text-muted hover:text-fg-dim")}
            >
              {t(k === "claude" ? "usagePanel.tabClaude" : "usagePanel.tabCodex")}
            </button>
          ))}
        </div>}
      </div>

      {showBody && <>
        {/* Shared pre-load states (gate on the snapshot itself, not per-tab). */}
        {!usage && !loadFailed && <SkeletonRows rows={2} className="px-2 py-1.5" />}
        {!usage && loadFailed && <div className="px-2 py-1.5 text-meta text-muted">{t("usagePanel.loadFailed")}</div>}
        {usage && loadFailed && <div role="status" className="px-2 pt-1 text-meta text-faint">{t("usagePanel.stale")}</div>}

        {usage && tab === "claude" && (
          <>
            {!hasAny && <div className="px-2 py-1.5 text-meta text-muted">{empty ? t("usagePanel.empty") : t("usagePanel.loading")}</div>}
            {hasAny && (
              <>
                {/* Server-side % (official, same source as /usage) */}
                {p?.fiveHour != null && <Meter label={t("usagePanel.session5h")} pct={p.fiveHour} sub={usage.session ? <>{fmtTok(usage.session.totalTokens)}<span className="w-2 shrink-0" aria-hidden />{usd(usage.session.costUSD)}</> : undefined} />}
                {p?.sevenDay != null && <Meter label={t("usagePanel.weekly")} pct={p.sevenDay} sub={wk ? <>{fmtTok(wk.totalTokens)}<span className="w-2 shrink-0" aria-hidden />{usd(wk.costUSD)}</> : undefined} />}
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
            <div className="px-2 py-1.5 text-meta text-muted">{t("usagePanel.codexUnavailable")}</div>
          )
        )}
      </>}
    </div>
  );
}

export const UsagePanel = memo(UsagePanelImpl);
UsagePanel.displayName = "UsagePanel";
