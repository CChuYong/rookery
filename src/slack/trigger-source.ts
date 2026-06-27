import type { Repositories } from "../persistence/repositories.js";
import type { AutomationDispatcher } from "../core/automation-dispatcher.js";
import { matchesSlack } from "../core/automation-match.js";

export interface SlackTriggerDeps { repos: Pick<Repositories, "listAutomations">; dispatcher: AutomationDispatcher }

export function makeSlackTriggerHandler(d: SlackTriggerDeps) {
  return async (e: { channel: string; userId?: string; text: string; ts?: string; threadTs?: string; team?: string }): Promise<void> => {
    for (const a of d.repos.listAutomations()) {
      if (!a.enabled || a.trigger.kind !== "slack") continue;
      if (!matchesSlack(a.trigger, e)) continue;
      await d.dispatcher.run(a, { message: e.text, channel: e.channel, user: e.userId, ts: e.ts, threadTs: e.threadTs, team: e.team });
    }
  };
}
