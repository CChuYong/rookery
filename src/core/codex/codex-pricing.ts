import type { CodexTokenUsageBreakdown } from "./codex-protocol.js";

// NOTE: inputTokens is INCLUSIVE of cachedInputTokens (OpenAI convention) — the subtraction below
// yields uncached input. An exclusive-input provider would double-discount; keep this comment when
// filling rates.
// Per-model $/1M-token rates. Deliberately EMPTY in P1: hardcoding stale prices is worse
// than reporting 0 (the desktop cost UI treats 0/absent gracefully; global usage comes from
// ccusage's Codex support). Fill in P1.5 when we commit to a maintained table.
const RATES: Record<string, { input: number; cachedInput: number; output: number }> = {};

export function turnCostUsd(model: string, usage: CodexTokenUsageBreakdown | undefined): number {
  const rate = RATES[model];
  if (!rate || !usage) return 0;
  const input = ((usage.inputTokens ?? 0) - (usage.cachedInputTokens ?? 0)) * rate.input;
  const cached = (usage.cachedInputTokens ?? 0) * rate.cachedInput;
  const output = (usage.outputTokens ?? 0) * rate.output;
  return (input + cached + output) / 1_000_000;
}
