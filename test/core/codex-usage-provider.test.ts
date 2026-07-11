import { describe, it, expect } from "vitest";
import { makeCodexUsageProvider, mapCodexUsage } from "../../src/core/codex-usage-provider.js";
import { fakeCodexSpawn } from "../helpers/fake-codex.js";
import type { CodexSpawn, CodexTransport } from "../../src/core/codex/codex-transport.js";

// Live-probed shapes (2026-07-11, codex 0.144.1) — see the design spec.
const RATE_LIMITS = {
  rateLimits: {
    limitId: "codex",
    primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1783762463 },
    secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1784310150 },
    planType: "pro",
  },
};
const ACCOUNT_USAGE = {
  summary: { lifetimeTokens: 4390142180 },
  dailyUsageBuckets: [
    { startDate: "2026-07-11", tokens: 1000 },
    { startDate: "2026-07-08", tokens: 200 },
    { startDate: "2026-07-01", tokens: 99999 }, // outside the 7-day window
  ],
};
const NOW = new Date(2026, 6, 11, 12, 0, 0); // local 2026-07-11

// Spawn/handshake-level failure (codex binary missing): never answers, exits immediately.
function erroringTransport(): CodexTransport {
  let exitCb: (info: { code: number | null; message?: string }) => void = () => {};
  queueMicrotask(() => exitCb({ code: 1, message: "spawn failed" }));
  return { write: () => {}, onLine: () => {}, onExit: (cb) => { exitCb = cb; }, kill: () => {} };
}
const erroringSpawn: CodexSpawn = () => erroringTransport();

describe("mapCodexUsage", () => {
  it("maps gauges (primary→fiveHour, secondary→sevenDay), planType, today/weekly bucket sums", () => {
    const u = mapCodexUsage(RATE_LIMITS, ACCOUNT_USAGE, NOW)!;
    expect(u.fiveHour).toEqual({ usedPercent: 37, resetsAt: 1783762463 });
    expect(u.sevenDay).toEqual({ usedPercent: 12, resetsAt: 1784310150 });
    expect(u.planType).toBe("pro");
    expect(u.todayTokens).toBe(1000);
    expect(u.weeklyTokens).toBe(1200); // 07-11 + 07-08; 07-01 excluded (last-7-days window)
  });

  it("partial: rateLimits only → gauges with null tokens; usage only → tokens with null gauges", () => {
    const rlOnly = mapCodexUsage(RATE_LIMITS, null, NOW)!;
    expect(rlOnly.fiveHour?.usedPercent).toBe(37);
    expect(rlOnly.todayTokens).toBeNull();
    expect(rlOnly.weeklyTokens).toBeNull();
    const usageOnly = mapCodexUsage(null, ACCOUNT_USAGE, NOW)!;
    expect(usageOnly.fiveHour).toBeNull();
    expect(usageOnly.sevenDay).toBeNull();
    expect(usageOnly.weeklyTokens).toBe(1200);
  });

  it("no usable data at all → null (treated as failure upstream)", () => {
    expect(mapCodexUsage(null, null, NOW)).toBeNull();
    expect(mapCodexUsage({}, {}, NOW)).toBeNull();
    expect(mapCodexUsage({ rateLimits: { primary: { usedPercent: "bad" } } }, { dailyUsageBuckets: "nope" }, NOW)).toBeNull();
  });

  it("a day with no bucket → todayTokens null (server buckets lag; a false 0 would mislead)", () => {
    const u = mapCodexUsage(null, { dailyUsageBuckets: [{ startDate: "2026-07-08", tokens: 200 }] }, NOW)!;
    expect(u.todayTokens).toBeNull();
    expect(u.weeklyTokens).toBe(200);
  });
});

describe("makeCodexUsageProvider", () => {
  it("fetches both RPCs from a scripted app-server and maps them", async () => {
    const fake = fakeCodexSpawn(() => [], { rateLimits: RATE_LIMITS, accountUsage: ACCOUNT_USAGE });
    const provider = makeCodexUsageProvider({ spawn: fake.spawn, now: () => NOW });
    const u = await provider.fetch();
    expect(u?.fiveHour?.usedPercent).toBe(37);
    expect(u?.weeklyTokens).toBe(1200);
    expect(fake.requests.map((r) => r.method)).toEqual(["initialize", "initialized", "account/rateLimits/read", "account/usage/read"]);
  });

  it("does NOT cache: a second fetch hits the server again (fresh child)", async () => {
    const fake = fakeCodexSpawn(() => [], { rateLimits: RATE_LIMITS, accountUsage: ACCOUNT_USAGE });
    const provider = makeCodexUsageProvider({ spawn: fake.spawn, now: () => NOW });
    await provider.fetch();
    await provider.fetch();
    expect(fake.spawns.length).toBe(2);
  });

  it("spawn failure → null (never throws)", async () => {
    const provider = makeCodexUsageProvider({ spawn: erroringSpawn, timeoutMs: 200 });
    await expect(provider.fetch()).resolves.toBeNull();
  });

  it("provisions the in-app apiKey before reading (account/read → account/login/start ordering)", async () => {
    const fake = fakeCodexSpawn(() => [], { rateLimits: RATE_LIMITS, accountUsage: ACCOUNT_USAGE, requiresOpenaiAuth: true });
    const provider = makeCodexUsageProvider({ spawn: fake.spawn, apiKey: () => "sk-test", now: () => NOW });
    const u = await provider.fetch();
    expect(u).not.toBeNull();
    expect(fake.requests.map((r) => r.method)).toEqual(["initialize", "initialized", "account/read", "account/login/start", "account/rateLimits/read", "account/usage/read"]);
  });

  it("wedged child (initialize never answered) → timeout → null", async () => {
    const fake = fakeCodexSpawn(() => [], { silentInitialize: true });
    const provider = makeCodexUsageProvider({ spawn: fake.spawn, timeoutMs: 50 });
    await expect(provider.fetch()).resolves.toBeNull();
  });
});
