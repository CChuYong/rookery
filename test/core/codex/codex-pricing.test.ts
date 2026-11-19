import { describe, it, expect } from "vitest";
import { turnCostUsd, isRatedModel, estimateTurnCost } from "../../../src/core/codex/codex-pricing.js";

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
  it("keeps the legacy numeric helper compatible; richer accounting declines cache-write retention ambiguity", () => {
    // Aggregate of short requests, not one million-token context.
 const usage = { inputTokens: 1_000_000, cachedInputTokens: 0, cacheWriteInputTokens: 500_000, outputTokens: 0 };
    expect(turnCostUsd("gpt-6-sol", usage)).toBeCloseTo(2.0, 10);
    expect(estimateTurnCost("gpt-6-sol", usage).accuracy).toBe("unavailable");
  });
});

 it("prices the CLI 0.170 catalog additions gpt-6.2-sol and gpt-6.2-astra (Standard and Fast)", () => {
 // Official pricing.md, verified 2026-11-19. Inclusive input: 2M input incl. 1M cached + 1M output.
 const u = { inputTokens: 2_000_000, cachedInputTokens: 1_000_000, outputTokens: 1_000_000 };
 expect(isRatedModel("gpt-6.2-sol")).toBe(true);
 expect(isRatedModel("gpt-6.2-astra")).toBe(true);
 expect(turnCostUsd("gpt-6.2-sol", u)).toBeCloseTo(2.0 + 0.1 + 10.0, 10);
 expect(turnCostUsd("gpt-6.2-astra", u)).toBeCloseTo(8.0 + 0.4 + 40.0, 10);
 // Aggregate of short requests, priced per tier.
 const flat = { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 };
 expect(estimateTurnCost("gpt-6.2-sol", flat, "standard")).toMatchObject({ costUsd: 2, accuracy: "estimated" });
 expect(estimateTurnCost("gpt-6.2-sol", flat, "fast")).toMatchObject({ costUsd: 4, accuracy: "estimated" });
 expect(estimateTurnCost("gpt-6.2-astra", flat, "standard")).toMatchObject({ costUsd: 8, accuracy: "estimated" });
 expect(estimateTurnCost("gpt-6.2-astra", flat, "fast")).toMatchObject({ costUsd: 16, accuracy: "estimated" });
 });

 it("prices explicit Fast rates and refuses uncovered tiers", () => {
 // Aggregate of short requests, not one million-token context.
 const usage = { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 };
 expect(estimateTurnCost("gpt-5.5", usage, "fast")).toMatchObject({ costUsd: 12.5, accuracy: "estimated" });
 expect(estimateTurnCost("gpt-5.5", usage, "standard")).toMatchObject({ costUsd: 5, accuracy: "estimated" });
 expect(estimateTurnCost("gpt-5.5-pro", usage, "fast").accuracy).toBe("unavailable");
 expect(estimateTurnCost("unknown", usage, "fast").accuracy).toBe("unavailable");
 });
