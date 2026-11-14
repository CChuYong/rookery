import type { CostAccuracy } from "@daemon/core/speed.js";
import type { LogItem } from "../store/reduce.js";

export function latestCost(items: LogItem[]): { cost: number; costAccuracy?: CostAccuracy } | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === "metrics") return item;
  }
  return undefined;
}
export function costQuality(a?: CostAccuracy, b?: CostAccuracy, provider?: string): CostAccuracy | undefined {
  if (a === "unavailable" || b === "unavailable") return "unavailable";
  if (a === "estimated" || b === "estimated" || provider === "codex") return "estimated";
  return a ?? b;
}
