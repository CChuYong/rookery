import type { CodexTokenUsageBreakdown } from "./codex-protocol.js";

// NOTE: inputTokens is INCLUSIVE of cachedInputTokens (OpenAI convention) — the subtraction below
// yields uncached input. An exclusive-input provider would double-discount; keep this comment when
// filling rates. Re-verified on Codex CLI 0.163.0 (2026-10-19): a rollout's token_count has
// total_tokens === input_tokens + output_tokens with cached_input_tokens <= input_tokens, and
// reasoning_output_tokens is a subset of output_tokens.
// Rates: developers.openai.com/api/docs/pricing, standard tier, USD per 1M tokens (gpt-5.x rows
// verified 2026-07-06; gpt-6*/gpt-5.6* rows fetched 2026-10-19). Reasoning tokens bill as output
// tokens (Responses API). The long-context surcharge (>272K input: 2x input/cached, 1.5x output) is
// NOT modeled — bills at the short-context rate, so very long single turns under-report. Likewise
// `cacheWriteInputTokens` (new in 0.163.0) is NOT billed: no cache-write price is published (it is
// currently always 0 in live rollouts). gpt-5.6-sol is promotional pricing "at least through
// 2026-11-21" — re-check after that date. Pro tiers have no cached-input discount → cachedInput =
// input rate. Unknown model → 0 (see isRatedModel).
const RATES: Record<string, { input: number; cachedInput: number; output: number }> = {
  "gpt-6.1-sol": { input: 2.0, cachedInput: 0.1, output: 10.0 },
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

// Whether `model` has a pricing entry (finding [18]). The desktop model picker is driven by the live
// app-server model/list catalog, which is NOT restricted to RATES keys, so a user can select a model
// absent from the table — turnCostUsd then bills it as $0, silently neutering cost metrics and the
// costBudgetUsd runaway guard (the sole codex runaway guard, since the per-send maxTurns cap is inert on
// codex). Callers warn once on a false result so the blind spot is visible instead of silent.
export function isRatedModel(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(RATES, model);
}

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
