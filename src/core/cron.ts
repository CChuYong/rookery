import { Cron } from "croner";

// Use croner solely for next-run computation (no internal timers/callbacks) → deterministic tests via injected now().
export function nextRun(expr: string, timezone: string, after: Date): Date | null {
  try {
    return new Cron(expr, { timezone }).nextRun(after) ?? null;
  } catch {
    return null; // invalid expression/timezone
  }
}

export function isValidCron(expr: string, timezone: string): boolean {
  try {
    // We must call nextRun to validate the timezone too (croner checks the timezone at nextRun time, not at construction time).
    new Cron(expr, { timezone }).nextRun(new Date());
    return true;
  } catch {
    return false;
  }
}
