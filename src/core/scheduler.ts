import type { Repositories, Automation } from "../persistence/repositories.js";
import type { AutomationDispatcher } from "./automation-dispatcher.js";
import type { ActionVars } from "./automation-action.js";
import { nextRun } from "./cron.js";

export interface SchedulerDeps {
  repos: Repositories;
  dispatcher: AutomationDispatcher;
  now?: () => Date;
  schedule?: (fn: () => void, ms: number) => () => void;
  tickMs?: number;
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const t = setInterval(fn, ms);
  t.unref?.();
  return () => clearInterval(t);
}

// Recurring time triggers the scheduler owns the next-run for (cron + interval). `once` (self-wakeup) is
// time-based too but its runAt is fixed, so it is handled separately (no next-run computation).
function isRecurringTimeTrigger(kind: string): boolean {
  return kind === "cron" || kind === "interval";
}

export class Scheduler {
  private cancelTick: (() => void) | null = null;
  constructor(private readonly d: SchedulerDeps) {}

  private now(): Date {
    return this.d.now ? this.d.now() : new Date();
  }

  start(): void {
    // On boot, populate next_run_at for enabled time-based automations that don't have one yet.
    // Cron: recurring → not backfilled (forward from now). Once: runAt persists, so a past-due
    // wakeup fires on the next tick (fire-overdue-on-boot); only (re)set if missing.
    for (const a of this.d.repos.listAutomations()) {
      if ((isRecurringTimeTrigger(a.trigger.kind) || a.trigger.kind === "once") && a.enabled && !a.nextRunAt) this.reconcile(a.id);
    }
    this.cancelTick = (this.d.schedule ?? defaultSchedule)(() => this.tick(), this.d.tickMs ?? 30000);
  }

  stop(): void {
    this.cancelTick?.();
    this.cancelTick = null;
  }

  reconcile(id: string): void {
    const a = this.d.repos.getAutomation(id);
    if (!a) return;
    if (a.trigger.kind === "once") {
      // Once: if enabled, schedule the fire at runAt; if disabled, clear it.
      this.d.repos.setAutomationNextRun(id, a.enabled ? a.trigger.runAt : null);
      return;
    }
    if (a.trigger.kind === "interval") {
      const next = a.enabled ? this.intervalNext(a.trigger.everyMinutes) : null;
      this.d.repos.setAutomationNextRun(id, next);
      return;
    }
    if (a.trigger.kind !== "cron") return;
    const next = a.enabled ? nextRun(a.trigger.cron, a.trigger.timezone, this.now()) : null;
    this.d.repos.setAutomationNextRun(id, next ? next.toISOString() : null);
  }

  // Next fire for an interval trigger: forward-from-now (now + everyMinutes). No wall-clock anchoring or
  // catch-up — matches cron's forward-from-now philosophy, so a daemon that was down doesn't burst.
  private intervalNext(everyMinutes: number): string {
    return new Date(this.now().getTime() + everyMinutes * 60_000).toISOString();
  }

  async runNow(id: string, vars: ActionVars = {}): Promise<void> {
    const a = this.d.repos.getAutomation(id);
    if (a) await this.d.dispatcher.run(a, vars);
  }

  private tick(): void {
    const nowMs = this.now().getTime();
    for (const a of this.d.repos.listAutomations()) {
      if ((!isRecurringTimeTrigger(a.trigger.kind) && a.trigger.kind !== "once") || !a.enabled || !a.nextRunAt) continue;
      if (new Date(a.nextRunAt).getTime() > nowMs) continue;
      void (a.trigger.kind === "once" ? this.fireOnce(a) : a.trigger.kind === "interval" ? this.fireInterval(a) : this.fireCron(a));
    }
  }

  private async fireInterval(a: Automation): Promise<void> {
    if (a.trigger.kind !== "interval") return;
    // Advance next_run FIRST (mirrors fireCron) so the dispatcher's run-record preserves the advanced value
    // and a long run can't cause pile-up (the dispatcher's overlap guard also skips a still-in-flight interval).
    this.d.repos.setAutomationNextRun(a.id, this.intervalNext(a.trigger.everyMinutes));
    const fresh = this.d.repos.getAutomation(a.id);
    if (fresh) await this.d.dispatcher.run(fresh, {});
  }

  private async fireCron(a: Automation): Promise<void> {
    if (a.trigger.kind !== "cron") return;
    // Advance next_run FIRST so the dispatcher's run-record preserves the already-advanced value.
    const next = nextRun(a.trigger.cron, a.trigger.timezone, this.now());
    this.d.repos.setAutomationNextRun(a.id, next ? next.toISOString() : null);
    const fresh = this.d.repos.getAutomation(a.id);
    if (fresh) await this.d.dispatcher.run(fresh, {});
  }

  // Once (self-wakeup): CLAIM first (null next_run) instead of delete-before-fire. The null claim keeps the
  // 30s tick from double-firing while the run is in flight (tick skips rows without next_run_at), and the row
  // surviving the run means a daemon crash mid-run is recoverable: boot's start() re-arms enabled once-rows
  // with no next_run_at back to trigger.runAt, so the wakeup refires (at-least-once) instead of vanishing.
  // Delete only after the run settles (success or error — the wakeup fired either way).
  private async fireOnce(a: Automation): Promise<void> {
    if (a.trigger.kind !== "once") return;
    this.d.repos.setAutomationNextRun(a.id, null);
    try {
      await this.d.dispatcher.run(a, {});
    } finally {
      this.d.repos.deleteAutomation(a.id);
    }
  }
}
