import type { AutomationTrigger } from "../persistence/repositories.js";

export interface SlackEvent { channel: string; userId?: string; text: string }

export function matchesSlack(t: Extract<AutomationTrigger, { kind: "slack" }>, e: SlackEvent): boolean {
  if (t.channels && t.channels.length > 0 && !t.channels.includes(e.channel)) return false;
  if (t.fromUsers && t.fromUsers.length > 0 && !t.fromUsers.includes(e.userId ?? "")) return false;
  if (t.keyword && t.keyword.trim() && !e.text.toLowerCase().includes(t.keyword.toLowerCase())) return false;
  return true;
}

// ── Worker-settled trigger (docs/superpowers/specs/2026-07-11-worker-settled-trigger-design.md) ──

export type WorkerSettleBucket = "idle" | "stopped" | "failure";

// Raw worker.status → settle bucket. Non-settle statuses (running/background/provisioning) map to
// undefined and never trigger. `background` is deliberately absent: the turn ended but background
// tasks still run — not "settled". Legacy `done` folds into stopped (retired from live writes).
export function workerSettleBucket(status: string): WorkerSettleBucket | undefined {
  switch (status) {
    case "idle": return "idle";
    case "stopped": case "done": return "stopped";
    case "error": case "failed": case "orphaned": return "failure";
    default: return undefined;
  }
}

// Default settle buckets when `on` is absent/empty: idle is OPT-IN — it is the most re-fire-prone
// bucket (recurs per dispatch), so a fresh rule must not catch it by surprise.
export const DEFAULT_WORKER_TRIGGER_ON: readonly WorkerSettleBucket[] = ["stopped", "failure"];

export interface WorkerSettleEvent {
  bucket: WorkerSettleBucket;
  repoName?: string; // registered repo name resolved from the worker's repo_path (undefined = unregistered)
  label: string; // worker label (auto-generated/model text — matching only; substitution is fenced)
}

export function matchesWorker(t: Extract<AutomationTrigger, { kind: "worker" }>, e: WorkerSettleEvent): boolean {
  const on = t.on && t.on.length > 0 ? t.on : DEFAULT_WORKER_TRIGGER_ON;
  if (!on.includes(e.bucket)) return false;
  if (t.repo && t.repo.trim() && t.repo !== e.repoName) return false;
  if (t.label && t.label.trim() && !e.label.toLowerCase().includes(t.label.toLowerCase())) return false;
  return true;
}
