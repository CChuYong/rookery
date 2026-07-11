import type { EventBus } from "./events.js";
import { ALL_CHANNEL } from "./events.js";
import type { Repositories } from "../persistence/repositories.js";
import type { AutomationDispatcher } from "./automation-dispatcher.js";
import type { ActionVars } from "./automation-action.js";
import { matchesWorker, workerSettleBucket } from "./automation-match.js";
import { AUTOMATION_FLEET_SESSION_KEY } from "./session-manager.js";
import { extractWorkerTail } from "./worker-notifier.js";

export interface WorkerTriggerDeps {
  repos: Pick<Repositories, "listAutomations" | "getAutomation" | "getWorker" | "getSession" | "getRepoByPath" | "listWorkerEvents">;
  dispatcher: Pick<AutomationDispatcher, "run">;
  bus: EventBus;
}

// Trigger source ③ worker (docs/superpowers/specs/2026-07-11-worker-settled-trigger-design.md): fires
// enabled `worker`-kind automations when a fleet worker settles. Subscribes worker.status on @all —
// the same signal WorkerNotifier consumes, and truthful since the background-aware state machine
// (idle = ALL assigned work complete; the settle-grace suppresses the pre-auto-wake idle blip).
// Event trigger → concurrent dispatch like slack (no overlap-skip; that guard is cron/interval-only).
// Returns the bus unsubscribe.
export function startWorkerTriggerSource(d: WorkerTriggerDeps): () => void {
  // Once-per-(automation, worker) latch, process-lifetime: `idle` recurs per dispatch (a steered worker
  // idles repeatedly) and terminal statuses double-emit on the bus (two writers: Worker.transition +
  // FleetOrchestrator.setStatus) — each rule fires at most once per worker. In-memory by design: a daemon
  // restart resets it (at-most-once per process; persistence deferred). Armed BEFORE dispatch — bus
  // delivery is synchronous, so the double-emit cannot race past it.
  const fired = new Map<string, Set<string>>(); // automationId → workerIds already fired

  return d.bus.subscribe(ALL_CHANNEL, (e) => {
    if (e.type !== "worker.status") return;
    const bucket = workerSettleBucket(e.status);
    if (!bucket) return; // running/background/provisioning — not settled
    const w = d.repos.getWorker(e.workerId);
    if (!w) return;
    // Self-loop guard: workers spawned BY automations live under the hidden automation:fleet home session.
    // Reacting to them would let a worker-trigger + worker-action rule spawn workers forever — excluded
    // structurally (no depth counter needed). Every other origin (UI/master/Slack/external MCP) matches.
    const home = d.repos.getSession(w.session_id);
    if (home?.external_key === AUTOMATION_FLEET_SESSION_KEY) return;
    const repoName = d.repos.getRepoByPath(w.repo_path)?.name;
    const ev = { bucket, repoName, label: w.label ?? "" };

    for (const a of d.repos.listAutomations()) {
      if (!a.enabled || a.trigger.kind !== "worker" || !matchesWorker(a.trigger, ev)) continue;
      const set = fired.get(a.id) ?? new Set<string>();
      if (set.has(e.workerId)) continue;
      // Fresh re-read at dispatch time (parity with the slack source/Scheduler): a rule deleted/disabled/
      // edited since the snapshot must not fire, and an edited rule fires with its CURRENT config.
      const fresh = d.repos.getAutomation(a.id);
      if (!fresh || !fresh.enabled || fresh.trigger.kind !== "worker" || !matchesWorker(fresh.trigger, ev)) continue;
      set.add(e.workerId);
      fired.set(a.id, set);
      const vars: ActionVars = {
        workerId: e.workerId,
        repo: repoName ?? w.repo_path, // registered name when known, else the raw path
        branch: w.branch ?? "",
        status: e.status, // raw status (idle/stopped/error/…), not the bucket — recipes can branch on it
        label: w.label ?? "",
        tail: extractWorkerTail(d.repos, e.workerId),
      };
      void d.dispatcher.run(fresh, vars).catch((err) => {
        process.stderr.write(`[rookery] worker trigger run failed: ${String(err)}\n`);
      });
    }
  });
}
