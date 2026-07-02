import type { EventBus } from "./events.js";
import { ALL_CHANNEL } from "./events.js";
import type { Repositories } from "../persistence/repositories.js";

// A worker has "finished a dispatch" once it leaves running/provisioning for any settled state — idle on success, or a
// terminal failure (so an armed master is told even when the work failed, instead of waiting forever for an idle).
const SETTLED = new Set(["idle", "done", "error", "failed", "stopped", "orphaned"]);

export interface WorkerNotifierDeps {
  bus: EventBus;
  repos: Repositories;
  deliver: (sessionId: string, line: string) => void;
}

// Watches worker.status; when an armed worker settles, consumes its one-shot flag and hands a one-line summary to the home master.
export class WorkerNotifier {
  constructor(private readonly d: WorkerNotifierDeps) {}

  start(): () => void {
    return this.d.bus.subscribe(ALL_CHANNEL, (e) => {
      if (e.type !== "worker.status" || !SETTLED.has(e.status)) return;
      const arm = this.d.repos.consumeWorkerNotifyArmed(e.workerId); // atomic read+clear → safe against duplicate events
      if (!arm || !arm.armed) return;
      const line = this.buildLine(e.workerId, e.status);
      if (line) this.d.deliver(arm.sessionId, line);
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
      const line = this.buildLine(w.id, w.status);
      if (line) this.d.deliver(arm.sessionId, line);
    }
  }

  private buildLine(workerId: string, status: string): string | null {
    const w = this.d.repos.getWorker(workerId);
    if (!w) return null;
    let tail = "(no output)";
    const events = this.d.repos.listWorkerEvents(workerId);
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]!.type !== "message") continue;
      try {
        const p = JSON.parse(events[i]!.payload_json) as { role?: string; content?: string };
        if (p.role === "assistant" && typeof p.content === "string") { tail = p.content.slice(0, 500); break; }
      } catch { /* skip malformed */ }
    }
    return `worker ${w.label} (${w.branch ?? workerId}) — ${status}\n  ${tail}`;
  }
}
