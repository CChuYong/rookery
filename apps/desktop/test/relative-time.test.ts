import { describe, it, expect } from "vitest";
import { relativeTime, absoluteDate, formatNextRun } from "../src/renderer/lib/relative-time.js";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const now = 1_000_000_000_000; // fixed reference point

const at = (agoMs: number) => relativeTime(now - agoMs, now);

describe("relativeTime", () => {
  it("'now' under 60s (incl. exactly 0 and tiny clock-skew future)", () => {
    expect(at(0)).toEqual({ unit: "now" });
    expect(at(30 * SEC)).toEqual({ unit: "now" });
    expect(at(59 * SEC)).toEqual({ unit: "now" });
    expect(relativeTime(now + 5 * SEC, now)).toEqual({ unit: "now" }); // future (clock skew) → now
  });

  it("minutes from 60s up to <60m", () => {
    expect(at(60 * SEC)).toEqual({ unit: "m", value: 1 });
    expect(at(59 * MIN)).toEqual({ unit: "m", value: 59 });
  });

  it("hours from 60m up to <24h", () => {
    expect(at(60 * MIN)).toEqual({ unit: "h", value: 1 });
    expect(at(23 * HOUR)).toEqual({ unit: "h", value: 23 });
  });

  it("days from 24h up to 7d inclusive", () => {
    expect(at(24 * HOUR)).toEqual({ unit: "d", value: 1 });
    expect(at(3 * DAY)).toEqual({ unit: "d", value: 3 });
    expect(at(7 * DAY)).toEqual({ unit: "d", value: 7 });
  });

  it("null at 8d and beyond (caller renders absolute date)", () => {
    expect(at(8 * DAY)).toBeNull();
    expect(at(30 * DAY)).toBeNull();
  });
});

describe("absoluteDate", () => {
  // Built from a local Date + local formatting, so it's deterministic regardless of TZ.
  const now2026 = new Date(2026, 5, 23, 12).getTime();

  it("omits year when same year as now", () => {
    const ts = new Date(2026, 5, 12, 12).getTime();
    expect(absoluteDate(ts, now2026, "en-US")).toBe("Jun 12");
  });

  it("includes year when a different year from now", () => {
    const ts = new Date(2025, 5, 12, 12).getTime();
    expect(absoluteDate(ts, now2026, "en-US")).toBe("Jun 12, 2025");
  });
});

// audit #53: an automation's next run, shown in the viewer's local time instead of the raw UTC ISO string.
describe("formatNextRun", () => {
  const ws = (s: string) => s.replace(/\s/g, " ");
  const now = Date.parse("2026-11-15T12:00:00.000Z"); // 21:00 in Seoul
  it("shows only the time when the run is later today", () => {
    expect(ws(formatNextRun("2026-11-15T13:30:00.000Z", now, "en-US", "Asia/Seoul"))).toBe("10:30 PM");
  });
  it("adds the date for another day", () => {
    expect(ws(formatNextRun("2026-11-15T18:00:00.000Z", now, "en-US", "Asia/Seoul"))).toBe("Nov 16, 3:00 AM");
  });
  it("adds the year when it differs", () => {
    expect(ws(formatNextRun("2027-01-02T00:00:00.000Z", now, "en-US", "Asia/Seoul"))).toBe("Jan 2, 2027, 9:00 AM");
  });
  it("returns the input unchanged when it isn't a date", () => {
    expect(formatNextRun("soon", now, "en-US")).toBe("soon");
  });
});
