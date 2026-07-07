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

// The effort actually in play for a (provider, model), given the user's current `choice`. This is the
// single source of truth every effort surface resolves through at RENDER time (not via state-syncing
// effects), so a stale/foreign level can never render a blank <select> or get submitted:
//  - claude, or codex with no catalog efforts (null catalog / unknown model): pass `choice` through — the
//    UI shows the generic EFFORTS vocabulary, and the daemon accepts/haiku-drops it as before.
//  - codex with catalog efforts: keep `choice` if it's a valid level for the model; otherwise re-derive to
//    the model's catalog default effort, falling back to its first supported level. This is what fixes a
//    Claude-vocab default like 'max' being shown/sent on a codex model that has no such level (finding [23]).
export function effectiveEffort(provider: string, model: string, choice: string, list: CodexModelInfo[] | null): string {
  if (provider !== "codex") return choice;
  const efforts = codexEffortsFor(model, list);
  if (efforts.length === 0) return choice; // free-text / model unknown to the catalog → generic vocab
  if (efforts.includes(choice)) return choice;
  return codexDefaultEffort(model, list) ?? efforts[0];
}
