import { Coins } from "lucide-react";
import { useStore } from "../store/store.js";
import type { LogItem } from "../store/reduce.js";
import { fmtUsd } from "../format.js";
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

// Per-worker cumulative cost — surfaced on the fleet row. The engine has no budget guards, so the UI is the only place
// runaway spend is visible. Renders nothing until there's a cost (avoids $0.00 noise on fresh workers).
export function WorkerCost({ workerId }: { workerId: string }): JSX.Element | null {
  const t = useT();
  const cost = useStore((s) => latestCost(s.workerLogs[workerId] ?? EMPTY));
  if (!cost) return null;
  return <span className="shrink-0 font-mono text-[9px] tabular-nums text-muted/70" title={t("workerCost.workerTitle")}>{fmtUsd(cost)}</span>;
}

// Fleet-wide spend = sum of each live worker's cumulative cost. The "fleet is burning" signal the review flagged as missing.
export function FleetBurn({ ids }: { ids: string[] }): JSX.Element | null {
  const t = useT();
  const total = useStore((s) => ids.reduce((sum, id) => sum + latestCost(s.workerLogs[id] ?? EMPTY), 0));
  if (!total) return null;
  return (
    <div
      className="mx-1 mb-0.5 flex items-center gap-1.5 rounded-md border border-line bg-ink/40 px-2 py-1 font-mono text-[10.5px] text-fg-dim"
      title={t("workerCost.fleetTitle")}
    >
      <Coins size={11} className="shrink-0 text-muted" />
      <span className="text-muted">{t("workerCost.fleetLabel")}</span>
      <span className="ml-auto tabular-nums">{fmtUsd(total)}</span>
    </div>
  );
}
