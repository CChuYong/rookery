import { describe, it, expect } from "vitest";
import { nextRun, isValidCron } from "../../src/core/cron.js";

describe("cron", () => {
  it("computes the next run after a given instant in a timezone", () => {
    const after = new Date("2026-06-22T00:00:00.000Z");
    const next = nextRun("0 3 * * *", "UTC", after); // daily 03:00 UTC
    expect(next?.toISOString()).toBe("2026-06-22T03:00:00.000Z");
  });

  it("returns null for an invalid expression", () => {
    expect(nextRun("not a cron", "UTC", new Date())).toBeNull();
  });

  it("validates expressions and timezones", () => {
    expect(isValidCron("*/5 * * * *", "Asia/Seoul")).toBe(true);
    expect(isValidCron("99 99 * * *", "UTC")).toBe(false);
    expect(isValidCron("0 3 * * *", "Not/AZone")).toBe(false);
  });
});
