import type { SpeedPreference, CostAccuracy } from "../speed.js";
import type { CodexTokenUsageBreakdown } from "./codex-protocol.js";

// NOTE: inputTokens is INCLUSIVE of cachedInputTokens (OpenAI convention) — the subtraction below
// yields uncached input. An exclusive-input provider would double-discount; keep this comment when
// filling rates. Re-verified on Codex CLI 0.163.0 (2026-10-19): a rollout's token_count has
// total_tokens === input_tokens + output_tokens with cached_input_tokens <= input_tokens, and
// reasoning_output_tokens is a subset of output_tokens.
// Standard USD per 1M token rates, verified 2026-11-14 against the official pricing.md.
// GPT-5.6 Sol promotional pricing expires 2026-11-30. Re-check then.
// The richer estimator intentionally declines mixed long-context totals and cache writes:
// app-server does not split billable usage by per-request context or cache-write retention.
const RATES: Record<string, { input: number; cachedInput: number; output: number }> = {
  "gpt-6.1-sol": { input: 2.0, cachedInput: 0.1, output: 10.0 },
  "gpt-6.1-terra": { input: 1.0, cachedInput: 0.05, output: 5.0 },
  "gpt-6-astra": { input: 10.0, cachedInput: 1.0, output: 50.0 },
  "gpt-6-sol": { input: 2.0, cachedInput: 0.2, output: 10.0 },
  "gpt-6-luna": { input: 0.1, cachedInput: 0.01, output: 0.5 },
  "gpt-5.6-sol": { input: 4.0, cachedInput: 0.4, output: 20.0 },
  "gpt-5.6-terra": { input: 2.0, cachedInput: 0.2, output: 12.0 },
  "gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, output: 1.2 },
  "gpt-5.5": { input: 5.0, cachedInput: 0.5, output: 30.0 },
  "gpt-5.5-pro": { input: 30.0, cachedInput: 30.0, output: 180.0 },
  "gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 15.0 },
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, cachedInput: 0.02, output: 1.25 },
};

// Official source: https://developers.openai.com/api/docs/pricing.md, verified 2026-11-14.
// Explicit Fast rows: never infer availability or apply a blanket multiplier.
const FAST_RATES: typeof RATES = {
  "gpt-6.1-sol": { input: 4, cachedInput: .2, output: 20 },
  "gpt-6.1-terra": { input: 2, cachedInput: .1, output: 10 },
  "gpt-6-astra": { input: 20, cachedInput: 2, output: 100 },
  "gpt-6-sol": { input: 4, cachedInput: .4, output: 20 },
  "gpt-6-luna": { input: .2, cachedInput: .02, output: 1 },
  "gpt-5.6-sol": { input: 8, cachedInput: .8, output: 40 },
  "gpt-5.6-terra": { input: 4, cachedInput: .4, output: 24 },
  "gpt-5.6-luna": { input: .4, cachedInput: .04, output: 2.4 },
  "gpt-5.5": { input: 12.5, cachedInput: 1.25, output: 75 },
  "gpt-5.4": { input: 5, cachedInput: .5, output: 30 },
  "gpt-5.4-mini": { input: 1.5, cachedInput: .15, output: 9 },
};
export function isRatedModel(model: string): boolean { return Object.hasOwn(RATES, model); }
function price(rate: (typeof RATES)[string], usage: CodexTokenUsageBreakdown): number {
  return Math.max(0, (Math.max(0, (usage.inputTokens ?? 0) - (usage.cachedInputTokens ?? 0)) * rate!.input +
    (usage.cachedInputTokens ?? 0) * rate!.cachedInput + (usage.outputTokens ?? 0) * rate!.output) / 1_000_000);
}
export function estimateTurnCost(model: string, usage: CodexTokenUsageBreakdown | undefined, speed: SpeedPreference = "standard", longContextSeen = false): { costUsd: number; accuracy: CostAccuracy } {
  const rate = (speed === "fast" ? FAST_RATES : RATES)[model];
  // Turn totals include repeated cache reads, so never infer context length from accumulated input.
  // Mixed short/long request totals cannot be split reliably from app-server cumulative usage.
  if (!rate || !usage || longContextSeen || (usage.cacheWriteInputTokens ?? 0) > 0) return { costUsd: 0, accuracy: "unavailable" };
  return { costUsd: price(rate, usage), accuracy: "estimated" };
}
// Legacy numeric helper (wire compatibility); new execution MUST use estimateTurnCost's quality.
// @deprecated Omits accounting quality, long-context applicability and cache-write retention.
export function turnCostUsd(model: string, usage: CodexTokenUsageBreakdown | undefined): number {
  return RATES[model] && usage ? price(RATES[model], usage) : 0;
}
