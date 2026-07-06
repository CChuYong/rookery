import type { CodexTokenUsageBreakdown } from "./codex-protocol.js";

// NOTE: inputTokens is INCLUSIVE of cachedInputTokens (OpenAI convention) — the subtraction below
// yields uncached input. An exclusive-input provider would double-discount; keep this comment when
// filling rates.
// Verified 2026-07-06 (developers.openai.com/api/docs/pricing, standard tier, USD per 1M tokens).
// Reasoning tokens bill as output tokens (Responses API). Long-context surcharge (>272K input:
// 2x input / 1.5x output) is NOT modeled — Codex's harness caps gpt-5.5 context (~258K) below it.
// Pro tiers have no cached-input discount → cachedInput = input rate. Unknown model → 0.
const RATES: Record<string, { input: number; cachedInput: number; output: number }> = {
  "gpt-5.5": { input: 5.0, cachedInput: 0.5, output: 30.0 },
  "gpt-5.5-pro": { input: 30.0, cachedInput: 30.0, output: 180.0 },
  "gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 15.0 },
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, cachedInput: 0.02, output: 1.25 },
};

export function turnCostUsd(model: string, usage: CodexTokenUsageBreakdown | undefined): number {
  const rate = RATES[model];
  if (!rate || !usage) return 0;
  // Upstream aggregation clamps each field independently (see codex-backend.ts turnAccum), which
  // can still leave cachedInputTokens > inputTokens for a given usage snapshot. Clamp both the
  // per-field subtraction AND the total so a cache-heavier-than-input reading never bills negative
  // (which would silently DECREASE the worker's cumulative cost).
  const input = Math.max(0, (usage.inputTokens ?? 0) - (usage.cachedInputTokens ?? 0)) * rate.input;
  const cached = (usage.cachedInputTokens ?? 0) * rate.cachedInput;
  const output = (usage.outputTokens ?? 0) * rate.output;
  return Math.max(0, (input + cached + output) / 1_000_000);
}
