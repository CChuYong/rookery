import type { Automation, Repositories } from "../persistence/repositories.js";
import type { EventBus } from "./events.js";
import { ALL_CHANNEL } from "./events.js";
import { runAutomationAction } from "./automation-action.js";
import type { ActionVars, AutomationActionDeps } from "./automation-action.js";

export interface AutomationDispatcherDeps extends AutomationActionDeps {
  repos: Repositories;
  bus: EventBus;
  now?: () => Date;
  // Pre-fire hook (injected port, best-effort) — the daemon uses this to "ensure a thread reporter if the target is a Slack session".
  // The core doesn't know about Slack; it synchronously sets up the subscription before runTurn (the first event) so that headless turns (wakeup, etc.) are also delivered to Slack.
  beforeRun?: (a: Automation) => void | Promise<void>;
}

export class AutomationDispatcher {
  private readonly inflight = new Set<string>();
  constructor(private readonly d: AutomationDispatcherDeps) {}
  private now(): Date { return this.d.now ? this.d.now() : new Date(); }

  async run(a: Automation, vars: ActionVars): Promise<void> {
    const nowIso = this.now().toISOString();
    // Only time triggers (cron) skip on overlap — prevents schedule pile-up (runaway) when a run takes longer than the period.
    // Event triggers (slack) must process every message, so concurrent runs are allowed (no drop).
    const guard = a.trigger.kind === "cron";
    if (guard && this.inflight.has(a.id)) {
      this.d.repos.setAutomationRun(a.id, { lastRunAt: nowIso, lastStatus: "skipped", lastError: null, nextRunAt: a.nextRunAt });
      this.emit(); return;
    }
    if (guard) this.inflight.add(a.id);
    // Surface that the run is in flight (transient 'running') so the UI shows a live pulse even for cron/slack-triggered runs
    // (no manual click to indicate it) — reconciled to ok/error in finally. lastRunAt = the start; nextRunAt is preserved.
    this.d.repos.setAutomationRun(a.id, { lastRunAt: nowIso, lastStatus: "running", lastError: null, nextRunAt: a.nextRunAt });
    this.emit();
    // Just before firing: ensure the reporter (best-effort) — isolated in a try so a failure doesn't block the turn. Since it's before runTurn, early events aren't missed either.
    try { await this.d.beforeRun?.(a); } catch { /* best-effort: a failed guarantee doesn't turn the automation into an error */ }
    let status: "ok" | "error" = "ok"; let error: string | null = null;
    try { await runAutomationAction(a, vars, this.d); }
    catch (e) { status = "error"; error = String(e); }
    finally {
      if (guard) this.inflight.delete(a.id);
      this.d.repos.setAutomationRun(a.id, { lastRunAt: nowIso, lastStatus: status, lastError: error, nextRunAt: a.nextRunAt });
      this.emit();
    }
  }
  private emit(): void { this.d.bus.emit({ type: "automation.changed", sessionId: ALL_CHANNEL }); }
}
