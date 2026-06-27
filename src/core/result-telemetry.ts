// Shared by master and worker: compute the current turn's context tokens/window from the SDK result + the last message_start usage.
// (Cumulative cost/turns and durationMs live at the call site — they're per-instance accumulators, so they don't belong here.)
export interface SdkResultLike {
  usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  modelUsage?: Record<string, { contextWindow?: number }>;
}
export function turnContext(r: SdkResultLike, lastReqContextTokens: number): { contextTokens: number; contextWindow: number } {
  const u = r.usage ?? {};
  const cumulative = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  const contextTokens = lastReqContextTokens || cumulative;
  const contextWindow = Math.max(0, ...Object.values(r.modelUsage ?? {}).map((m) => m.contextWindow ?? 0));
  return { contextTokens, contextWindow };
}
