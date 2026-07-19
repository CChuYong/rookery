import type { TFunc } from "../i18n/provider.js";

// Worker state transition → decide the OS notification text (pure). Settled states only: `error` and `failed`
// share one line (the same outcome written by two authorities — Worker.transition vs FleetOrchestrator.setStatus),
// and `done` stays mapped for legacy rows even though the state graph retired it from live writes.
// running/background/provisioning are mid-work and deliberately absent.
const KEYS: Record<string, string> = {
  idle: "notify.idle",
  done: "notify.done",
  stopped: "notify.stopped",
  failed: "notify.failed",
  error: "notify.failed",
};

export function notifyFor(prev: string | undefined, next: string, label: string, t: TFunc): { title: string; body: string } | null {
  if (next === prev) return null; // ignore re-emission of the same state
  const key = KEYS[next];
  if (!key) return null; // not a notification target
  return { title: `🛰 ${label}`, body: t(key) };
}
