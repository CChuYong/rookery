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

export function modelLabel(id: string): string {
  return MODELS.find((m) => m.id === id)?.label ?? id;
}

// effort is unsupported on Haiku (API 400) — the UI also hides the effort selector in that case.
export function effortSupported(model: string): boolean {
  return !/haiku/i.test(model);
}
