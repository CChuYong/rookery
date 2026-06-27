// Pure function that converts a message arrival time (ts) into a relative-time unit to show on hover.
// null means it's too old (8+ days) → the caller renders an absolute date (toLocaleDateString).
// i18n is handled by the caller (component) via unit→text mapping (no strings are built here).

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export type RelativeTime =
  | { unit: "now" }
  | { unit: "m"; value: number }
  | { unit: "h"; value: number }
  | { unit: "d"; value: number };

// ts, now: epoch ms. Future (clock skew) or under 60 seconds is "now". Over 7 days is null.
export function relativeTime(ts: number, now: number): RelativeTime | null {
  const diff = now - ts;
  if (diff < MIN) return { unit: "now" }; // under 60s + future skew
  if (diff < HOUR) return { unit: "m", value: Math.floor(diff / MIN) };
  if (diff < DAY) return { unit: "h", value: Math.floor(diff / HOUR) };
  const days = Math.floor(diff / DAY);
  return days <= 7 ? { unit: "d", value: days } : null;
}

// Absolute date for messages older than 7 days (e.g. "Jun 12"). Includes the year if it differs from now's year ("Jun 12, 2025").
export function absoluteDate(ts: number, now: number, locale?: string): string {
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(locale, sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
}
