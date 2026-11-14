import { useStore } from "../store/store.js";
import type { LogItem } from "../store/reduce.js";
import { fmtUsd, fmtUsdCompact } from "../format.js";
import { useT } from "../i18n/provider.js";

const EMPTY: LogItem[] = [];

// Latest cumulative cost (the SDK's total_cost_usd) for a worker, read from the most recent metrics event in its log.
// Live worker.event metrics flow over the @all channel for every active worker, so this is available without viewing —
// a never-viewed worker's pre-connect cost only fills in once its history is seeded (on first open). 0 when unknown.
function latestCost(items: LogItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it && it.kind === "metrics") return it.cost;
  }
  return 0;
}

// Per-worker cumulative cost, visible alongside the engine's optional budget guard.
// Renders nothing until there is a cost (avoids $0.00 noise on fresh workers).
export function WorkerCost({ workerId, fleetCost, compact }: { workerId: string; fleetCost?: number; compact?: boolean }): JSX.Element | null {
  const t = useT();
  const logCost = useStore((s) => latestCost(s.workerLogs[workerId] ?? EMPTY));
  const cost = Math.max(logCost, fleetCost ?? 0); // fleet.list snapshot shows cost without opening; the live log wins when higher (fresher)
  if (!cost) return null;
  // compact (narrow tree rows): $1,000+ collapses to "$15.8k"; the exact figure stays in the tooltip.
  const exact = fmtUsd(cost);
  const shown = compact ? fmtUsdCompact(cost) : exact;
  return (
    <span className="shrink-0 font-mono text-meta tabular-nums text-muted" title={shown === exact ? t("workerCost.workerTitle") : `${t("workerCost.workerTitle")} · ${exact}`}>
      {shown}
    </span>
  );
}

// Fleet-wide spend = sum of each live worker's cumulative cost (fleet snapshot, or the live log when higher). The "fleet
// is burning" signal — now accurate for never-opened workers too, not just the ones whose logs are loaded.
export function FleetBurn({ rows }: { rows: Array<{ id: string; costUsd?: number }> }): JSX.Element | null {
  const t = useT();
  const total = useStore((s) => rows.reduce((sum, r) => sum + Math.max(latestCost(s.workerLogs[r.id] ?? EMPTY), r.costUsd ?? 0), 0));
  if (!total) return null;
  // The fleet ledger's own section head — plain text (label left, total right), not a pill/badge, same scale
  // as RepoTree's "N workers" group counters.
  return (
    <div
      className="mx-1 mb-1 flex items-center justify-between gap-2 px-2 pb-1 pt-2 text-meta font-medium"
      title={t("workerCost.fleetTitle")}
    >
      <span className="text-faint">{t("workerCost.fleetLabel")}</span>
      <span className="tabular-nums text-faint">{fmtUsd(total)}</span>
    </div>
  );
}
