import type { CodexModelInfo } from "@daemon/protocol/messages.js";

// A single model option. The live (daemon models.list) and static fallback both use the same shape.
export type ModelOption = { id: string; label: string };

// Static fallback — used when models.list can't be obtained from the daemon (no auth / offline). Also used as the store's initial value.
export const MODELS: ReadonlyArray<ModelOption> = [
  { id: "claude-opus-4-8", label: "Opus 4.8" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
  { id: "claude-fable-5", label: "Fable 5" },
];

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

// i18n key for an effort's display label (common.effortLow/Medium/High/Xhigh/Max) — raw tokens like
// "xhigh" are machine values and must never be shown to the user directly.
export const effortLabelKey = (e: string): string => `common.effort${e.charAt(0).toUpperCase()}${e.slice(1)}`;

export function modelLabel(id: string): string {
  return MODELS.find((m) => m.id === id)?.label ?? id;
}

// effort is unsupported on Haiku (API 400) — the UI also hides the effort selector in that case.
export function effortSupported(model: string): boolean {
  return !/haiku/i.test(model);
}

// The chosen codex model's supported reasoning-effort tokens, or [] if the model is unknown
// (or the catalog itself couldn't be fetched, i.e. list === null).
export function codexEffortsFor(model: string, list: CodexModelInfo[] | null): string[] {
  return list?.find((m) => m.id === model)?.supportedEfforts ?? [];
}

// The chosen codex model's default effort, or undefined if unknown / the catalog is null / the
// model's defaultEffort is an empty string (the `|| undefined` guard normalizes "" to "not set").
export function codexDefaultEffort(model: string, list: CodexModelInfo[] | null): string | undefined {
  return list?.find((m) => m.id === model)?.defaultEffort || undefined;
}
