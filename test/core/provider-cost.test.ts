import { describe, it, expect } from "vitest";
import { providerCostTotalOf } from "../../src/core/provider-cost.js";

describe("providerCostTotalOf", () => {
  it("reads a finite providerCostTotalUsd", () => {
    expect(providerCostTotalOf(JSON.stringify({ costUsd: 1, providerCostTotalUsd: 0.42 }))).toBe(0.42);
    expect(providerCostTotalOf(JSON.stringify({ providerCostTotalUsd: 0 }))).toBe(0);
  });
  it("is undefined when absent, non-numeric, empty, null, or corrupt", () => {
    expect(providerCostTotalOf(JSON.stringify({ costUsd: 1 }))).toBeUndefined();
    expect(providerCostTotalOf(JSON.stringify({ providerCostTotalUsd: "1" }))).toBeUndefined();
    expect(providerCostTotalOf("")).toBeUndefined();
    expect(providerCostTotalOf(undefined)).toBeUndefined();
    expect(providerCostTotalOf(null)).toBeUndefined();
    expect(providerCostTotalOf("{not json")).toBeUndefined();
  });
});
