import type { EventBus } from "./events.js";
import { ALL_CHANNEL } from "./events.js";
import type { Repositories } from "../persistence/repositories.js";

// A worker has "finished a dispatch" once it leaves running/provisioning for any settled state — idle on success, or a
// terminal failure (so an armed master is told even when the work failed, instead of waiting forever for an idle).
// "background" is deliberately NOT settled (2026-07-11 state-graph redesign): the turn ended but background tasks
// (run_in_background shells etc.) still run — notifying there would wake the master before the work is actually done.
// The worker reaches idle after those tasks settle (and the SDK's auto-wake turn processes their results), so the arm
// fires exactly once, at the truthful completion point. "done" stays only for legacy rows (retired from live writes).
const SETTLED = new Set(["idle", "done", "error", "failed", "stopped", "orphaned"]);

// A settled worker's notification payload. Structured (not a preformatted string) so the master can build BOTH the
// model prompt line (formatNotificationLine) AND a clean localized display notice (buildWorkerNotice) from it.
export interface WorkerNotification {
  label: string;
  branch: string; // w.branch ?? workerId
  status: string; // idle | done | error | failed | stopped | orphaned
  tail: string;   // last assistant text (≤500 chars) — for the model prompt only, never shown in the chip
  provider?: string; // which agent backend ran the worker (claude | codex) — so a mixed fleet's alerts are attributed; absent → claude
}

// The single model-prompt line for a settled worker. Names the backend so the master can reason about a mixed
// claude/codex fleet ("the codex worker failed, the claude one is fine") without a separate status lookup.
export function formatNotificationLine(n: WorkerNotification): string {
  return `worker ${n.label} (${n.branch}) [${n.provider ?? "claude"}] — ${n.status}\n  ${n.tail}`;
}

// Parse a persisted pending-notification row back into structured form. Legacy rows (plain strings written by an
// older build) fail JSON.parse or lack fields → wrapped as a done-bucket notice carrying the raw text as its tail.
// A missing provider (legacy/older JSON) defaults to "claude".
export function parseNotification(text: string): WorkerNotification {
  try {
    const o = JSON.parse(text) as Partial<WorkerNotification>;
    if (o && typeof o.label === "string" && typeof o.status === "string") {
      return { label: o.label, branch: o.branch ?? "", status: o.status, tail: o.tail ?? "", provider: o.provider ?? "claude" };
    }
  } catch { /* legacy plain-string row → fall through */ }
  return { label: "", branch: "", status: "done", tail: text, provider: "claude" };
}

// Last assistant message (≤ maxChars) from a worker's persisted transcript — the "what it said last"
// summary shared by the notifier (model prompt line) and the worker-settled trigger's {{tail}} var.
export function extractWorkerTail(repos: Pick<Repositories, "listWorkerEvents">, workerId: string, maxChars = 500): string {
  const events = repos.listWorkerEvents(workerId);
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type !== "message") continue;
    try {
      const p = JSON.parse(events[i]!.payload_json) as { role?: string; content?: string };
      if (p.role === "assistant" && typeof p.content === "string") return p.content.slice(0, maxChars);
    } catch { /* skip malformed */ }
  }
  return "(no output)";
}

export interface WorkerNotifierDeps {
  bus: EventBus;
  repos: Repositories;
  deliver: (sessionId: string, n: WorkerNotification) => void;
}

// Watches worker.status; when an armed worker settles, consumes its one-shot flag and hands a one-line summary to the home master.
export class WorkerNotifier {
  constructor(private readonly d: WorkerNotifierDeps) {}

  start(): () => void {
    return this.d.bus.subscribe(ALL_CHANNEL, (e) => {
      if (e.type !== "worker.status" || !SETTLED.has(e.status)) return;
      const arm = this.d.repos.consumeWorkerNotifyArmed(e.workerId); // atomic read+clear → safe against duplicate events
      if (!arm || !arm.armed) return;
      const n = this.buildNotification(e.workerId, e.status);
      if (n) this.d.deliver(arm.sessionId, n);
    });
  }

  // Boot-time sweep: rehydrate() force-writes idle/orphaned straight to the DB (no worker.status bus event),
  // so an arm set before a restart would otherwise never fire and the master would wait forever. Called once
  // after start() at boot; consumes arms of already-settled workers and delivers (a cold session gets a
  // pending_notifications row via SessionManager.deliverWorkerNotification and is drained on next build).
  sweepSettled(): void {
    for (const w of this.d.repos.listAllWorkers()) {
      if (!SETTLED.has(w.status)) continue;
      const arm = this.d.repos.consumeWorkerNotifyArmed(w.id);
      if (!arm || !arm.armed) continue;
      const n = this.buildNotification(w.id, w.status);
      if (n) this.d.deliver(arm.sessionId, n);
    }
  }

  private buildNotification(workerId: string, status: string): WorkerNotification | null {
    const w = this.d.repos.getWorker(workerId);
    if (!w) return null;
    return { label: w.label, branch: w.branch ?? workerId, status, tail: extractWorkerTail(this.d.repos, workerId), provider: w.provider ?? "claude" };
  }
}
