import type { SettingsValues } from "@daemon/core/settings.js";

// Settings page draft helpers (audit #93): which settings differ from the saved values, and which category owns
// them, so the Save bar can say "N unsaved changes" and the category list can mark where they are.

export type SettingsTab = "general" | "slack" | "models" | "capabilities" | "integration";

// The form-backed settings each category edits. Secrets (API keys, tokens) are not here: they are write-only
// actions with their own buttons, never part of the draft.
const TAB_OF: Partial<Record<keyof SettingsValues, SettingsTab>> = {
  masterName: "general",
  defaultSessionCwd: "general",
  workerCostBudgetUsd: "general",
  mcpExposure: "general",
  usageRefreshMs: "general",
  slackCwd: "slack",
  slackAllowAll: "slack",
  slackAllowedUsers: "slack",
  slackRefuseReply: "slack",
  slackRefusalMessage: "slack",
  slackLocale: "slack",
  slackProvider: "slack",
  workerSlackRelayEnabled: "slack",
  workerSlackRelayChannel: "slack",
  masterModel: "models",
  masterEffort: "models",
  workerModel: "models",
  workerEffort: "models",
  masterSpeed: "models",
  workerSpeed: "models",
  codexMasterModel: "models",
  codexWorkerModel: "models",
  codexMasterSpeed: "models",
  codexWorkerSpeed: "models",
  codexBin: "models",
  codexTurnIdleTimeoutMs: "models",
  codexHandshakeTimeoutMs: "models",
};

// The form draft for saved settings. A Claude model default that follows the SDK's recommendation (nothing saved)
// is "" in the draft — the "Recommended" option — rather than the id it currently resolves to, so saving the form
// keeps following the recommendation instead of pinning today's model ("" is saved as "not set").
export function toSettingsDraft(s: SettingsValues): SettingsValues {
  const follows = (src: SettingsValues["masterModelSource"]) => src !== undefined && src !== "setting";
  return {
    ...s,
    masterModel: follows(s.masterModelSource) ? "" : s.masterModel,
    workerModel: follows(s.workerModelSource) ? "" : s.workerModel,
  };
}

// A missing key and "" are the same value here (typing into an unset field and clearing it is not a change).
export function changedSettingKeys(draft: SettingsValues, saved: SettingsValues): Array<keyof SettingsValues> {
  const d = draft as unknown as Record<string, unknown>;
  const s = saved as unknown as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(d), ...Object.keys(s)])];
  return keys.filter((k) => (d[k] ?? "") !== (s[k] ?? "")) as Array<keyof SettingsValues>;
}

export function dirtyTabs(keys: ReadonlyArray<keyof SettingsValues>): Set<SettingsTab> {
  const out = new Set<SettingsTab>();
  for (const k of keys) {
    const tab = TAB_OF[k];
    if (tab) out.add(tab);
  }
  return out;
}

// A millisecond setting read back as a human unit (audit #119): "120000" → 2 minutes. null = nothing to say
// (blank or not a non-negative number); "off" = 0, which every ms setting here treats as disabled/default.
export type MsParts = { unit: "off" } | { unit: "ms" | "s" | "m" | "h"; value: number };
export function msParts(raw: string | undefined): MsParts | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const ms = Number(text);
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms === 0) return { unit: "off" };
  if (ms % 3_600_000 === 0) return { unit: "h", value: ms / 3_600_000 };
  if (ms % 60_000 === 0) return { unit: "m", value: ms / 60_000 };
  if (ms % 1000 === 0) return { unit: "s", value: ms / 1000 };
  return { unit: "ms", value: ms };
}
