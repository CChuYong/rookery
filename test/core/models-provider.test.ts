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

  it("re-resolves the api key on every call (audit #30) — a key saved after boot reaches the picker without a restart", async () => {
    let key: string | undefined;
    const seen: string[] = [];
    const fetchImpl = (async (_url: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers["x-api-key"] ?? "none");
      return { ok: true, json: async () => ({ data: [{ id: "m1", display_name: "M1" }] }) };
    }) as never;
    const reader = { read: async () => null }; // no OAuth either
    const list = makeModelsProvider({ apiKey: () => key, reader, fetchImpl });
    expect(await list()).toEqual(STATIC_MODELS); // no key yet → static fallback, no fetch with a key
    key = "sk-new";
    expect((await list())[0]!.id).toBe("m1"); // the just-saved key is used live
    expect(seen).toEqual(["sk-new"]);
  });

  it("falls back to STATIC_MODELS with no auth, on fetch failure, and on a non-ok response", async () => {
    const noAuth = makeModelsProvider({ reader: { read: async () => null } });
    expect(await noAuth()).toEqual(STATIC_MODELS); // no token/key → static list

    const failing = makeModelsProvider({ apiKey: "k", fetchImpl: (async () => { throw new Error("net"); }) as never });
    expect(await failing()).toEqual(STATIC_MODELS);

    const notOk = makeModelsProvider({ apiKey: "k", fetchImpl: (async () => ({ ok: false, json: async () => ({}) })) as never });
    expect(await notOk()).toEqual(STATIC_MODELS);
  });

  // Reconnect-time degradation: on a client WS reconnect (sleep/wake, network blip) the desktop re-requests
  // models.list; if the daemon's /v1/models refetch fails transiently and returns the 3-item STATIC list, the
  // full catalog the picker was showing gets overwritten with 3 defaults until an app restart. The provider now
  // caches the last successful live catalog and serves THAT on a later transient failure, so it never downgrades.
  it("serves the last successful live catalog on a later transient failure (no downgrade to STATIC on reconnect)", async () => {
    let mode: "ok" | "fail" = "ok";
    const live = [
      { id: "claude-opus-4-8", display_name: "Claude Opus 4.8" },
      { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" },
      { id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" },
      { id: "claude-fable-5", display_name: "Claude Fable 5" },
      { id: "claude-extra-9", display_name: "Claude Extra 9" },
    ];
    const fetchImpl = (async () => {
      if (mode === "fail") throw new Error("net"); // transient failure on the reconnect refetch
      return { ok: true, json: async () => ({ data: live }) };
    }) as never;
    const provider = makeModelsProvider({ apiKey: "k", fetchImpl });
    const first = await provider();
    expect(first).toHaveLength(5); // full live catalog
    mode = "fail";
    const second = await provider();
    expect(second).toEqual(first); // survives the transient failure
    expect(second).not.toEqual(STATIC_MODELS); // NOT downgraded to the 3-item static list
  });

  it("still serves STATIC_MODELS on failure when no live fetch has ever succeeded", async () => {
    const failing = makeModelsProvider({ apiKey: "k", fetchImpl: (async () => { throw new Error("net"); }) as never });
    expect(await failing()).toEqual(STATIC_MODELS); // no last-good yet → static
  });

  it("refreshes the cached catalog when a newer live fetch succeeds", async () => {
    let data = [{ id: "a", display_name: "A" }];
    const fetchImpl = (async () => ({ ok: true, json: async () => ({ data }) })) as never;
    const provider = makeModelsProvider({ apiKey: "k", fetchImpl });
    expect((await provider()).map((m) => m.id)).toEqual(["a"]);
    data = [{ id: "a", display_name: "A" }, { id: "b", display_name: "B" }];
    expect((await provider()).map((m) => m.id)).toEqual(["a", "b"]); // cache advances to the newer success
  });

  it("keeps the last good catalog when auth momentarily disappears (token reader returns null on wake)", async () => {
    let token: string | null = "tok";
    const fetchImpl = (async () => ({ ok: true, json: async () => ({ data: [
      { id: "m1", display_name: "M1" }, { id: "m2", display_name: "M2" },
    ] }) })) as never;
    const provider = makeModelsProvider({ reader: { read: async () => token }, fetchImpl });
    expect((await provider()).map((m) => m.id)).toEqual(["m1", "m2"]);
    token = null; // transient auth loss on reconnect
    expect((await provider()).map((m) => m.id)).toEqual(["m1", "m2"]); // not the static list
  });
});
