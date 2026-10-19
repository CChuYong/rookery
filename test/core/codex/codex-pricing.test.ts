import { describe, it, expect } from "vitest";
import { turnCostUsd, isRatedModel } from "../../../src/core/codex/codex-pricing.js";

describe("codex-pricing", () => {
  it("isRatedModel reports whether a model has a pricing entry (finding [18])", () => {
    expect(isRatedModel("gpt-5.5")).toBe(true);
    expect(isRatedModel("gpt-5.4-mini")).toBe(true);
    expect(isRatedModel("gpt-9-brand-new")).toBe(false); // a catalog model absent from RATES
    expect(isRatedModel("")).toBe(false);
  });

  it("turnCostUsd is $0 for an unrated model (documents the blind spot isRatedModel exposes)", () => {
    expect(turnCostUsd("gpt-9-brand-new", { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 500 })).toBe(0);
    expect(turnCostUsd("gpt-5.5", { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 500 })).toBeGreaterThan(0);
  });

  it("prices the 0.163-era catalog models (inclusive input, cached discount, output incl. reasoning)", () => {
    const per = (model: string, u: { inputTokens: number; cachedInputTokens: number; outputTokens: number }) => turnCostUsd(model, u);
    // 1M uncached input + 1M cached + 1M output  => (in-cached)*in + cached*cachedIn + out*out ; here input=2M incl 1M cached
    const u = { inputTokens: 2_000_000, cachedInputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(per("gpt-6.1-sol", u)).toBeCloseTo(2.0 + 0.1 + 10.0, 10);
    expect(per("gpt-6-astra", u)).toBeCloseTo(10.0 + 1.0 + 50.0, 10);
    expect(per("gpt-6-sol", u)).toBeCloseTo(2.0 + 0.2 + 10.0, 10);
    expect(per("gpt-6-luna", u)).toBeCloseTo(0.1 + 0.01 + 0.5, 10);
    expect(per("gpt-5.6-sol", u)).toBeCloseTo(4.0 + 0.4 + 20.0, 10);
    expect(per("gpt-5.6-terra", u)).toBeCloseTo(2.0 + 0.2 + 12.0, 10);
    expect(per("gpt-5.6-luna", u)).toBeCloseTo(0.2 + 0.02 + 1.2, 10);
    for (const m of ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"]) expect(isRatedModel(m)).toBe(true);
    expect(isRatedModel("gpt-9-unknown")).toBe(false);
  });
  it("does not bill cacheWriteInputTokens (no published price)", () => {
    expect(turnCostUsd("gpt-6-sol", { inputTokens: 1_000_000, cachedInputTokens: 0, cacheWriteInputTokens: 500_000, outputTokens: 0 })).toBeCloseTo(2.0, 10);
  });
});
