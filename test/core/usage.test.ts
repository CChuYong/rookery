import { describe, it, expect } from "vitest";
import { parseUsage, UsageCollector, emptyUsage } from "../../src/core/usage.js";
import { fetchOAuthUsage } from "../../src/core/oauth-usage.js";
import type { OAuthUsage } from "../../src/core/oauth-usage.js";
import type { CodexUsage } from "../../src/core/codex-usage-provider.js";

const blocksJson = JSON.stringify({
  blocks: [{ isActive: true, costUSD: 12.5, totalTokens: 1000, startTime: "2026-06-19T06:00:00.000Z", endTime: "2026-06-19T11:00:00.000Z" }],
});
const dailyJson = JSON.stringify({
  daily: [
    { period: "2026-06-19", totalTokens: 500, totalCost: 5 },
    { period: "2026-06-13", totalTokens: 100, totalCost: 1 },
    { period: "2026-06-01", totalTokens: 9999, totalCost: 99 },
  ],
});
const now = new Date(2026, 5, 19, 10, 0, 0); // local 6/19
const fakePct: OAuthUsage = { fiveHour: 25, sevenDay: 40, sevenDayOpus: null, sevenDaySonnet: 2, fiveHourResetsAt: null, sevenDayResetsAt: null, extra: null };

describe("parseUsage", () => {
  it("parses session, today, weekly(last 7d) tokens/$ from ccusage", () => {
    const s = parseUsage(blocksJson, dailyJson, now);
    expect(s.session).toMatchObject({ totalTokens: 1000, costUSD: 12.5 });
    expect(s.today).toEqual({ totalTokens: 500, costUSD: 5 });
    expect(s.weekly).toEqual({ totalTokens: 600, costUSD: 6 }); // 06-13..06-19, 06-01 excluded
  });
});

describe("fetchOAuthUsage", () => {
  it("maps utilization fields", async () => {
    const fake = async () => ({
      ok: true,
      json: async () => ({
        five_hour: { utilization: 25, resets_at: "r1" },
        seven_day: { utilization: 40, resets_at: "r2" },
        seven_day_opus: null,
        seven_day_sonnet: { utilization: 2 },
        extra_usage: { is_enabled: true, used_credits: 500, monthly_limit: 10000, currency: "USD" },
      }),
    });
    const u = await fetchOAuthUsage("tok", fake);
    expect(u).toEqual({
      fiveHour: 25, sevenDay: 40, sevenDayOpus: null, sevenDaySonnet: 2,
      fiveHourResetsAt: "r1", sevenDayResetsAt: "r2",
      extra: { usedCredits: 500, monthlyLimit: 10000, currency: "USD" },
    });
  });

  it("returns null on non-ok response", async () => {
    expect(await fetchOAuthUsage("tok", async () => ({ ok: false, json: async () => ({}) }))).toBeNull();
  });

  it("passes an abort signal (timeout) to fetch so a hung request can't freeze the collector", async () => {
    let captured: { signal?: AbortSignal } | undefined;
    await fetchOAuthUsage("tok", async (_url, init) => { captured = init; return { ok: true, json: async () => ({}) }; });
    expect(captured?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("UsageCollector", () => {
  it("collect() merges ccusage tokens and OAuth %", async () => {
    const c = new UsageCollector({
      refreshMs: 9e9,
      now: () => now,
      exec: { run: async (args) => (args[0] === "blocks" ? blocksJson : dailyJson) },
      oauthUsage: async () => fakePct,
    });
    await c.collect();
    expect(c.snapshot().today).toEqual({ totalTokens: 500, costUSD: 5 });
    expect(c.snapshot().pct).toEqual(fakePct);
    expect(c.snapshot().error).toBeNull();
  });

  it("collect() skips a refresh while one is already in flight (no overlap)", async () => {
    let active = 0;
    let maxActive = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const c = new UsageCollector({
      refreshMs: 9e9,
      now: () => now,
      exec: { run: async (args) => { active++; maxActive = Math.max(maxActive, active); await gate; active--; return args[0] === "blocks" ? blocksJson : dailyJson; } },
    });
    const p1 = c.collect();
    const p2 = c.collect(); // should be skipped if one is already in flight
    expect(maxActive).toBe(1); // the two collects must not run exec concurrently
    release();
    await Promise.all([p1, p2]);
  });

  it("keeps prior pct when OAuth fails, still updates tokens", async () => {
    let first = true;
    const c = new UsageCollector({
      refreshMs: 9e9,
      now: () => now,
      exec: { run: async (args) => (args[0] === "blocks" ? blocksJson : dailyJson) },
      oauthUsage: async () => {
        if (first) { first = false; return fakePct; }
        throw new Error("401");
      },
    });
    await c.collect();
    await c.collect();
    expect(c.snapshot().pct).toEqual(fakePct); // keep the previous value even if the second call fails
    expect(c.snapshot().today).toEqual({ totalTokens: 500, costUSD: 5 });
  });
});

describe("UsageCollector — codex", () => {
  const cx: CodexUsage = { fiveHour: { usedPercent: 37, resetsAt: 1783762463 }, sevenDay: { usedPercent: 12, resetsAt: null }, planType: "pro", todayTokens: 1000, weeklyTokens: 1200 };
  const failingExec = { run: async () => { throw new Error("no ccusage"); } };

  it("emptyUsage carries codex: null", () => {
    expect(emptyUsage().codex).toBeNull();
  });

  it("collect stores a successful codex fetch in the snapshot", async () => {
    const c = new UsageCollector({ exec: failingExec, refreshMs: 999999, codexUsage: async () => cx });
    await c.collect();
    expect(c.snapshot().codex).toEqual(cx);
  });

  it("a null/throwing codex fetch keeps the previous codex value (transient failure must not blank the panel)", async () => {
    let fail = false;
    const c = new UsageCollector({ exec: failingExec, refreshMs: 999999, codexUsage: async () => { if (fail) throw new Error("down"); return cx; } });
    await c.collect();
    fail = true;
    await c.collect();
    expect(c.snapshot().codex).toEqual(cx); // kept
    const c2 = new UsageCollector({ exec: failingExec, refreshMs: 999999, codexUsage: async () => null });
    await c2.collect();
    expect(c2.snapshot().codex).toBeNull(); // never had data — stays null
  });
});
