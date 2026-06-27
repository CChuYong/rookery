import { describe, it, expect } from "vitest";
import { turnContext } from "../../src/core/result-telemetry.js";

describe("turnContext", () => {
  it("prefers lastReqContextTokens when set; contextWindow = max modelUsage", () => {
    const r = { usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 }, modelUsage: { a: { contextWindow: 200000 }, b: { contextWindow: 100000 } } };
    expect(turnContext(r, 4321)).toEqual({ contextTokens: 4321, contextWindow: 200000 });
  });
  it("falls back to cumulative usage when lastReq is 0", () => {
    const r = { usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 } };
    expect(turnContext(r, 0)).toEqual({ contextTokens: 17, contextWindow: 0 });
  });
  it("handles missing usage/modelUsage", () => {
    expect(turnContext({}, 0)).toEqual({ contextTokens: 0, contextWindow: 0 });
  });
});
