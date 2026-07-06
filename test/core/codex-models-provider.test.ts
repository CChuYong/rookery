import { describe, it, expect } from "vitest";
import { makeCodexModelsProvider } from "../../src/core/codex-models-provider.js";
import { fakeCodexSpawn } from "../helpers/fake-codex.js";
import type { CodexSpawn, CodexTransport } from "../../src/core/codex/codex-transport.js";

// A transport that never answers ANY request and fires onExit shortly after construction — simulates a
// spawn/handshake-level failure (codex binary missing / crashed before it could answer `initialize`).
function erroringTransport(): CodexTransport {
  let exitCb: (info: { code: number | null; message?: string }) => void = () => {};
  queueMicrotask(() => exitCb({ code: 1, message: "spawn failed" }));
  return {
    write: () => {},
    onLine: () => {},
    onExit: (cb) => { exitCb = cb; },
    kill: () => {},
  };
}
const erroringSpawn: CodexSpawn = () => erroringTransport();

// Raw `model/list` data[] rows, camelCase (ts-rs), as observed live against codex 0.142.5.
const GPT_5_5 = {
  id: "gpt-5.5",
  displayName: "GPT-5.5",
  isDefault: true,
  defaultReasoningEffort: "xhigh",
  supportedReasoningEfforts: [
    { reasoningEffort: "xhigh", description: "..." },
    { reasoningEffort: "low", description: "..." },
    { reasoningEffort: "medium", description: "..." },
    { reasoningEffort: "high", description: "..." },
  ],
};
const HIDDEN_ROW = {
  id: "codex-auto-review",
  displayName: "Codex Auto Review",
  hidden: true,
  isDefault: false,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "..." }],
};

describe("makeCodexModelsProvider", () => {
  it("maps a scripted model/list catalog: efforts extracted, defaultEffort/isDefault mapped, hidden row excluded (includeHidden:false)", async () => {
    const fake = fakeCodexSpawn(() => [], { modelList: [GPT_5_5, HIDDEN_ROW] });
    const provider = makeCodexModelsProvider({ spawn: fake.spawn });
    const models = await provider.list();
    expect(models).toEqual([
      { id: "gpt-5.5", displayName: "GPT-5.5", defaultEffort: "xhigh", supportedEfforts: ["xhigh", "low", "medium", "high"], isDefault: true },
    ]);
    // The hidden row's absence comes from the server honoring includeHidden:false (mapModel itself has
    // no client-side hidden filter) — assert the provider actually requests that flag.
    const req = fake.requests.find((r) => r.method === "model/list");
    expect(req?.params).toEqual({ includeHidden: false });
  });

  it("drops data[] rows without an id", async () => {
    const fake = fakeCodexSpawn(() => [], { modelList: [GPT_5_5, { displayName: "no id" }] });
    const provider = makeCodexModelsProvider({ spawn: fake.spawn });
    const models = await provider.list();
    expect(models).toHaveLength(1);
    expect(models![0]!.id).toBe("gpt-5.5");
  });

  it("an empty catalog is treated as a failed fetch (null), not an empty array", async () => {
    const fake = fakeCodexSpawn(() => [], { modelList: [] });
    const provider = makeCodexModelsProvider({ spawn: fake.spawn });
    expect(await provider.list()).toBeNull();
  });

  it("a spawn/handshake-level failure (child dies before answering initialize) returns null", async () => {
    const provider = makeCodexModelsProvider({ spawn: erroringSpawn });
    expect(await provider.list()).toBeNull();
  });

  it("a hung handshake (initialize never responds) times out to null", async () => {
    const fake = fakeCodexSpawn(() => [], { silentInitialize: true });
    const provider = makeCodexModelsProvider({ spawn: fake.spawn, timeoutMs: 20 });
    expect(await provider.list()).toBeNull();
  });

  it("caches a successful fetch — a second list() call reuses it without re-spawning", async () => {
    const fake = fakeCodexSpawn(() => [], { modelList: [GPT_5_5] });
    const provider = makeCodexModelsProvider({ spawn: fake.spawn });
    const first = await provider.list();
    const second = await provider.list();
    expect(first).toEqual(second);
    expect(fake.spawns.length).toBe(1); // only spawned once — the second call served from cache
  });

  it("a failing call does NOT cache — the next call re-spawns and can succeed", async () => {
    const good = fakeCodexSpawn(() => [], { modelList: [GPT_5_5] });
    let calls = 0;
    const spawn: CodexSpawn = (o) => {
      calls++;
      return calls === 1 ? erroringTransport() : good.spawn(o);
    };
    const provider = makeCodexModelsProvider({ spawn });
    expect(await provider.list()).toBeNull(); // first attempt fails, not cached
    const second = await provider.list();
    expect(second).not.toBeNull();
    expect(second![0]!.id).toBe("gpt-5.5");
    expect(calls).toBe(2); // re-spawned after the failure
  });
});
