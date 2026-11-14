import type { CostAccuracy } from "@daemon/core/speed.js";
import { latestCost, costQuality } from "../lib/cost.js";
import { useStore } from "../store/store.js";
import type { LogItem } from "../store/reduce.js";
import { fmtUsd, fmtUsdCompact } from "../format.js";
import { useT } from "../i18n/provider.js";

const EMPTY: LogItem[] = [];

// Per-worker cumulative cost, visible alongside the engine's optional budget guard.
// Renders nothing until there is a cost (avoids $0.00 noise on fresh workers).
export function WorkerCost({ workerId, fleetCost, compact }: { workerId: string; fleetCost?: number; compact?: boolean }): JSX.Element | null {
  const t = useT();
  const logCost = useStore((s) => latestCost(s.workerLogs[workerId] ?? EMPTY));
  const row = useStore((s) => s.fleet[workerId]);
  const quality = costQuality(logCost?.costAccuracy, row?.costAccuracy, row?.provider);
  const cost = Math.max(logCost?.cost ?? 0, fleetCost ?? row?.costUsd ?? 0); // fleet.list snapshot shows cost without opening; the live log wins when higher (fresher)
  if (!cost && quality !== "unavailable") return null;
  // compact (narrow tree rows): $1,000+ collapses to "$15.8k"; the exact figure stays in the tooltip.
  const exact = fmtUsd(cost);
  const shown = quality === "unavailable" ? "—" : `${quality === "estimated" ? `${t("speed.estimated")} ` : ""}${compact ? fmtUsdCompact(cost) : exact}`;
  const qualityLabel = quality === "unavailable" ? t("speed.costUnavailable") : quality === "estimated" ? t("speed.costEstimated") : undefined;
  return (
    <span className="shrink-0 font-mono text-meta tabular-nums text-muted" aria-label={qualityLabel} title={qualityLabel ? `${qualityLabel}${quality === "unavailable" ? "" : ` (${exact})`}` : shown === exact ? t("workerCost.workerTitle") : `${t("workerCost.workerTitle")} · ${exact}`}>
      {shown}
    </span>
  );
}

// Fleet-wide spend = sum of each live worker's cumulative cost (fleet snapshot, or the live log when higher). The "fleet
// is burning" signal — now accurate for never-opened workers too, not just the ones whose logs are loaded.
export function FleetBurn({ rows }: { rows: Array<{ id: string; costUsd?: number; costAccuracy?: CostAccuracy; provider?: string }> }): JSX.Element | null {
  const t = useT();
  const logs = useStore((s) => s.workerLogs);
  let quality: CostAccuracy | undefined;
  const total = rows.reduce((sum, r) => {
    const log = latestCost(logs[r.id] ?? EMPTY);
    quality = costQuality(quality, costQuality(log?.costAccuracy, r.costAccuracy, r.provider));
    return sum + Math.max(log?.cost ?? 0, r.costUsd ?? 0);
  }, 0);
  if (!total && quality !== "unavailable") return null;
  // The fleet ledger's own section head — plain text (label left, total right), not a pill/badge, same scale
  // as RepoTree's "N workers" group counters.
  return (
    <div
      className="mx-1 mb-1 flex items-center justify-between gap-2 px-2 pb-1 pt-2 text-meta font-medium"
      title={t("workerCost.fleetTitle")}
    >
      <span className="text-faint">{t("workerCost.fleetLabel")}</span>
      <span className="tabular-nums text-faint" aria-label={quality === "unavailable" ? t("speed.costUnavailable") : quality === "estimated" ? t("speed.costEstimated") : undefined}>{quality === "unavailable" ? "—" : `${quality === "estimated" ? `${t("speed.estimated")} ` : ""}${fmtUsd(total)}`}</span>
    </div>
  );
}
