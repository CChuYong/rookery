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
      if ((a.trigger.kind === "cron" || a.trigger.kind === "once") && a.enabled && !a.nextRunAt) this.reconcile(a.id);
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
    if (a.trigger.kind !== "cron") return;
    const next = a.enabled ? nextRun(a.trigger.cron, a.trigger.timezone, this.now()) : null;
    this.d.repos.setAutomationNextRun(id, next ? next.toISOString() : null);
  }

  async runNow(id: string, vars: ActionVars = {}): Promise<void> {
    const a = this.d.repos.getAutomation(id);
    if (a) await this.d.dispatcher.run(a, vars);
  }

  private tick(): void {
    const nowMs = this.now().getTime();
    for (const a of this.d.repos.listAutomations()) {
      if ((a.trigger.kind !== "cron" && a.trigger.kind !== "once") || !a.enabled || !a.nextRunAt) continue;
      if (new Date(a.nextRunAt).getTime() > nowMs) continue;
      void (a.trigger.kind === "once" ? this.fireOnce(a) : this.fireCron(a));
    }
  }

  private async fireCron(a: Automation): Promise<void> {
    if (a.trigger.kind !== "cron") return;
    // Advance next_run FIRST so the dispatcher's run-record preserves the already-advanced value.
    const next = nextRun(a.trigger.cron, a.trigger.timezone, this.now());
    this.d.repos.setAutomationNextRun(a.id, next ? next.toISOString() : null);
    const fresh = this.d.repos.getAutomation(a.id);
    if (fresh) await this.d.dispatcher.run(fresh, {});
  }

  // Once (self-wakeup): delete BEFORE firing — so that even if the run takes longer than a tick, the next tick can't re-fire it (prevents double-firing).
  // The dispatcher has no overlap guard for event/once triggers, so this delete-first is once's only protection.
  private async fireOnce(a: Automation): Promise<void> {
    if (a.trigger.kind !== "once") return;
    this.d.repos.deleteAutomation(a.id);
    await this.d.dispatcher.run(a, {});
  }
}
