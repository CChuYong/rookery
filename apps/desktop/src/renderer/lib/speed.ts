import type { SpeedObservation, SpeedPreference } from "@daemon/core/speed.js";
import type { SettingsValues } from "@daemon/core/settings.js";
import type { CodexModelInfo } from "@daemon/protocol/messages.js";
import type { LogItem } from "../store/reduce.js";

export function defaultSpeed(settings: Partial<SettingsValues> | null, provider: string | undefined, role: "master" | "worker"): SpeedPreference {
  const key = provider === "codex" ? (role === "master" ? "codexMasterSpeed" : "codexWorkerSpeed") : (role === "master" ? "masterSpeed" : "workerSpeed");
  return settings?.[key] === "fast" ? "fast" : "standard";
}

// CLI 0.169.0 calls the Fast catalog capability "priority"; turn/start uses "fast".
// Missing metadata is unknown, never authoritative exclusion.
export function fastAvailability(provider: string | undefined, model: string, catalog: CodexModelInfo[] | null): "supported" | "unsupported" | "unknown" {
  if (provider !== "codex") return "unknown";
  const tiers = catalog?.find((m) => m.id === model)?.serviceTiers;
  return tiers == null ? "unknown" : tiers.some((tier) => tier.id === "priority" || tier.id === "fast") ? "supported" : "unsupported";
}

export function latestSpeedObservation(items: LogItem[] | undefined): SpeedObservation | undefined {
  for (let i = (items?.length ?? 0) - 1; i >= 0; i--) {
    const item = items![i];
    if (item.kind === "speedReset") return undefined;
    if (item.kind === "speed") return item.historical ? undefined : item.observation;
    // A new user input invalidates a previous turn's effective observation.
    if (item.kind === "message" && item.role === "user") return undefined;
  }
  return undefined;
}

export function lastReportedSpeed(items: LogItem[] | undefined): SpeedObservation | undefined {
  for (let i = (items?.length ?? 0) - 1; i >= 0; i--) {
    const item = items![i];
    if (item.kind === "speed") return item.observation;
  }
  return undefined;
}

export function speedPendingNextTurn(items: LogItem[] | undefined): boolean {
  for (let i = (items?.length ?? 0) - 1; i >= 0; i--) {
    const item = items![i];
    if (item.kind === "speedReset" || (item.kind === "message" && item.role === "user")) return true;
    if (item.kind === "speed") return false;
  }
  return false;
}
