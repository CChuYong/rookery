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
});
