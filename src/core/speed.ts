export type SpeedPreference = "standard" | "fast";
export type CostAccuracy = "reported" | "estimated" | "unavailable";
export interface SpeedObservation {
  requested: SpeedPreference;
  state: "unknown" | "standard" | "fast" | "cooldown";
  reason?: string;
}
export function resolveSpeed(value?: SpeedPreference | (() => SpeedPreference)): SpeedPreference {
  return (typeof value === "function" ? value() : value) === "fast" ? "fast" : "standard";
}

// Cumulative totals stay incomplete once any turn could not be priced.
export function mergeCostAccuracy(previous: CostAccuracy | undefined, current: CostAccuracy | undefined): CostAccuracy | undefined {
  if (previous === "unavailable" || current === "unavailable") return "unavailable";
  if (previous === "estimated" || current === "estimated") return "estimated";
  return current ?? previous;
}
