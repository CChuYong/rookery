import { describe, it, expect } from "vitest";
import { makeCodexAuthProvider, mapCodexAuth } from "../../src/core/codex-auth-provider.js";
import { fakeCodexSpawn } from "../helpers/fake-codex.js";
import type { CodexSpawn, CodexTransport } from "../../src/core/codex/codex-transport.js";

// A transport that never answers ANY request and fires onExit shortly after construction — a
// spawn/handshake-level failure (codex binary missing / crashed before it could answer `initialize`).
function erroringTransport(): CodexTransport {
  let exitCb: (info: { code: number | null; message?: string }) => void = () => {};
  queueMicrotask(() => exitCb({ code: 1, message: "spawn failed" }));
  return { write: () => {}, onLine: () => {}, onExit: (cb) => { exitCb = cb; }, kill: () => {} };
}
const erroringSpawn: CodexSpawn = () => erroringTransport();

describe("mapCodexAuth (pure account/read → CodexAuthStatus mapping)", () => {
  it("maps a chatgpt account to method chatgpt + an email/plan hint, ready", () => {
    expect(mapCodexAuth({ account: { type: "chatgpt", email: "a@b.co", planType: "pro" }, requiresOpenaiAuth: false }))
      .toEqual({ method: "chatgpt", ready: true, hint: "a@b.co · pro" });
  });
  it("maps an apiKey account to method api-key, ready, no hint", () => {
    expect(mapCodexAuth({ account: { type: "apiKey" }, requiresOpenaiAuth: false }))
      .toEqual({ method: "api-key", ready: true, hint: null });
  });
  it("maps an amazonBedrock account to method bedrock, ready", () => {
    expect(mapCodexAuth({ account: { type: "amazonBedrock" }, requiresOpenaiAuth: false }).method).toBe("bedrock");
  });
  it("an authed account of an UNKNOWN future type → method other, still ready (never a false 'not authenticated')", () => {
    // requiresOpenaiAuth:false + a present account is exactly what a real turn needs — openClient gates on
    // requiresOpenaiAuth alone, never the type — so an unrecognized type must not degrade to not-ready.
    expect(mapCodexAuth({ account: { type: "futureThing" }, requiresOpenaiAuth: false })).toEqual({ method: "other", ready: true, hint: null });
  });
  it("a chatgpt account with a null email carries no fabricated brand hint (just the plan, or null)", () => {
    expect(mapCodexAuth({ account: { type: "chatgpt", email: null, planType: "pro" }, requiresOpenaiAuth: false }).hint).toBe("pro");
    expect(mapCodexAuth({ account: { type: "chatgpt", email: null }, requiresOpenaiAuth: false }).hint).toBeNull();
  });
  it("requiresOpenaiAuth:true (auth missing) → method none, not ready", () => {
    expect(mapCodexAuth({ account: null, requiresOpenaiAuth: true })).toEqual({ method: "none", ready: false, hint: null });
  });
  it("a null/absent account (even without requiresOpenaiAuth) → none, not ready", () => {
    expect(mapCodexAuth({ requiresOpenaiAuth: false }).method).toBe("none");
    expect(mapCodexAuth(null).ready).toBe(false);
  });
});

describe("makeCodexAuthProvider", () => {
  it("reports a chatgpt subscription account (method + email/plan hint, ready)", async () => {
    const fake = fakeCodexSpawn(() => [], { account: { type: "chatgpt", email: "u@x.io", planType: "plus" } });
    const status = await makeCodexAuthProvider({ spawn: fake.spawn }).status();
    expect(status).toEqual({ method: "chatgpt", ready: true, hint: "u@x.io · plus" });
  });

  it("reports an api-key account (ready)", async () => {
    const fake = fakeCodexSpawn(() => [], { account: { type: "apiKey" } });
    expect(await makeCodexAuthProvider({ spawn: fake.spawn }).status()).toEqual({ method: "api-key", ready: true, hint: null });
  });

  it("reports 'not authenticated' when no account and no in-app key (ambient ~/.codex, not logged in)", async () => {
    const fake = fakeCodexSpawn(() => [], { account: null, requiresOpenaiAuth: true });
    const status = await makeCodexAuthProvider({ spawn: fake.spawn }).status();
    expect(status).toEqual({ method: "none", ready: false, hint: null });
    expect(fake.requests.some((r) => r.method === "account/login/start")).toBe(false); // no key → no provisioning
  });

  it("provisions the in-app codexApiKey then re-reads, reporting the resulting api-key account as ready (mirrors a real turn)", async () => {
    const fake = fakeCodexSpawn(() => [], { account: null, requiresOpenaiAuth: true });
    const status = await makeCodexAuthProvider({ spawn: fake.spawn, env: () => ({ CODEX_HOME: "/redir" }), apiKey: () => "sk-test" }).status();
    expect(status).toEqual({ method: "api-key", ready: true, hint: null });
    expect(fake.requests.some((r) => r.method === "account/login/start")).toBe(true);
    expect(fake.requests.filter((r) => r.method === "account/read")).toHaveLength(2); // read → provision → re-read
  });

  it("spawns the probe child with the same CODEX_HOME/env the turn children use (findings [25]/[26])", async () => {
    const fake = fakeCodexSpawn(() => [], { account: { type: "apiKey" } });
    await makeCodexAuthProvider({ spawn: fake.spawn, env: () => ({ CODEX_HOME: "/redir" }) }).status();
    expect(fake.spawns[0]?.env).toMatchObject({ CODEX_HOME: "/redir" });
  });

  it("a spawn/handshake-level failure returns null (never throws), like codexModels", async () => {
    expect(await makeCodexAuthProvider({ spawn: erroringSpawn }).status()).toBeNull();
  });

  it("a hung handshake (initialize never responds) times out to null", async () => {
    const fake = fakeCodexSpawn(() => [], { silentInitialize: true });
    expect(await makeCodexAuthProvider({ spawn: fake.spawn, timeoutMs: 20 }).status()).toBeNull();
  });

  it("does NOT cache (auth can change) — a second status() re-spawns", async () => {
    const fake = fakeCodexSpawn(() => [], { account: { type: "apiKey" } });
    const provider = makeCodexAuthProvider({ spawn: fake.spawn });
    await provider.status();
    await provider.status();
    expect(fake.spawns.length).toBe(2); // fresh probe each call, unlike the cached models catalog
  });
});
