import { describe, it, expect } from "vitest";
import { makeModelsProvider, fetchModels, STATIC_MODELS } from "../../src/core/models-provider.js";

type Captured = { url?: string; headers?: Record<string, string> };
function fakeFetch(captured: Captured, response: { ok: boolean; json: () => Promise<unknown> }) {
  return (async (url: string, init: { headers: Record<string, string> }) => {
    captured.url = url;
    captured.headers = init.headers;
    return response;
  }) as unknown as Parameters<typeof makeModelsProvider>[0] extends { fetchImpl?: infer F } ? F : never;
}

describe("models provider", () => {
  it("fetchModels parses /v1/models data into {id, displayName} and sends anthropic-version", async () => {
    const cap: Captured = {};
    const models = await fetchModels(
      { "x-api-key": "k", "anthropic-version": "2023-06-01" },
      fakeFetch(cap, { ok: true, json: async () => ({ data: [
        { id: "claude-opus-4-8", display_name: "Claude Opus 4.8" },
        { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" },
      ] }) }),
    );
    expect(models).toEqual([
      { id: "claude-opus-4-8", displayName: "Claude Opus 4.8" },
      { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" },
    ]);
    expect(cap.url).toContain("/v1/models");
    expect(cap.headers!["anthropic-version"]).toBe("2023-06-01");
  });

  it("uses the OAuth Bearer + oauth beta header when there is no API key (reusing a TokenReader)", async () => {
    const cap: Captured = {};
    const provider = makeModelsProvider({
      reader: { read: async () => "tok123" },
      fetchImpl: fakeFetch(cap, { ok: true, json: async () => ({ data: [{ id: "m", display_name: "M" }] }) }),
    });
    expect(await provider()).toEqual([{ id: "m", displayName: "M" }]);
    expect(cap.headers!.Authorization).toBe("Bearer tok123");
    expect(cap.headers!["anthropic-beta"]).toBe("oauth-2025-04-20");
  });

  it("prefers x-api-key over the OAuth token when an API key is present", async () => {
    const cap: Captured = {};
    const provider = makeModelsProvider({
      apiKey: "sk-test",
      reader: { read: async () => "should-not-be-used" },
      fetchImpl: fakeFetch(cap, { ok: true, json: async () => ({ data: [{ id: "m", display_name: "M" }] }) }),
    });
    await provider();
    expect(cap.headers!["x-api-key"]).toBe("sk-test");
    expect(cap.headers!.Authorization).toBeUndefined();
  });

  it("falls back to STATIC_MODELS with no auth, on fetch failure, and on a non-ok response", async () => {
    const noAuth = makeModelsProvider({ reader: { read: async () => null } });
    expect(await noAuth()).toEqual(STATIC_MODELS); // no token/key → static list

    const failing = makeModelsProvider({ apiKey: "k", fetchImpl: (async () => { throw new Error("net"); }) as never });
    expect(await failing()).toEqual(STATIC_MODELS);

    const notOk = makeModelsProvider({ apiKey: "k", fetchImpl: (async () => ({ ok: false, json: async () => ({}) })) as never });
    expect(await notOk()).toEqual(STATIC_MODELS);
  });
});
