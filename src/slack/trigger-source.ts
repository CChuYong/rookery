import type { Repositories } from "../persistence/repositories.js";
import type { AutomationDispatcher } from "../core/automation-dispatcher.js";
import { matchesSlack } from "../core/automation-match.js";

export interface SlackTriggerDeps { repos: Pick<Repositories, "listAutomations" | "getAutomation">; dispatcher: AutomationDispatcher }

export function makeSlackTriggerHandler(d: SlackTriggerDeps) {
  return async (e: { channel: string; userId?: string; text: string; ts?: string; threadTs?: string; team?: string }): Promise<void> => {
    const vars = { message: e.text, channel: e.channel, user: e.userId, ts: e.ts, threadTs: e.threadTs, team: e.team };
    const fired: Array<Promise<void>> = [];
    for (const a of d.repos.listAutomations()) {
      if (!a.enabled || a.trigger.kind !== "slack") continue;
      if (!matchesSlack(a.trigger, e)) continue;
      // Fresh re-read at dispatch time (parity with the Scheduler's fireCron): a rule deleted/disabled/edited
      // since the snapshot must not fire, and an edited rule fires with its CURRENT config.
      const fresh = d.repos.getAutomation(a.id);
      if (!fresh || !fresh.enabled || fresh.trigger.kind !== "slack" || !matchesSlack(fresh.trigger, e)) continue;
      // Event triggers allow concurrent runs by design — fire all matches NOW instead of serially awaiting each
      // full agentic turn (which delayed later rules by minutes and made the snapshot stale by the time they ran).
      fired.push(d.dispatcher.run(fresh, vars).catch((err) => { process.stderr.write(`[rookery] slack trigger run failed: ${String(err)}\n`); }));
    }
    await Promise.all(fired);
  };
}
