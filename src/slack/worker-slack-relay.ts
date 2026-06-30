import type { CoreEvent } from "../core/events.js";
import type { SlackClient, ThreadTarget } from "./types.js";
import type { Locale } from "../core/i18n.js";
import { SlackThreadReporter } from "./reporter.js";
import { workerEventToCoreEvent } from "./worker-event-to-core.js";
import { basename } from "node:path";

export interface WorkerRelayDeps {
  client: SlackClient;
  enabled: () => boolean; // workerSlackRelayEnabled === "1"
  channel: () => string; // workerSlackRelayChannel (trimmed; "" = off)
  resolveThread: (sessionId: string) => ThreadTarget | null; // master's Slack thread, or null if the session isn't Slack-origin
  getLocale?: () => Locale;
}

const TERMINAL = new Set(["stopped", "done", "error", "failed", "orphaned"]);

// Mirrors each Slack-origin master's worker activity into the configured channel (one thread per worker) and links
// that thread back into the master's Slack thread. Subscribe its onEvent to FLEET_CHANNEL. Best-effort: any Slack
// failure is logged, never thrown. Per worker it reuses a SlackThreadReporter (per-turn chatStream + plan cards),
// fed worker events translated to the master-shaped CoreEvents the reporter renders.
export class WorkerSlackRelay {
  private readonly workers = new Map<string, SlackThreadReporter>();
  private tail: Promise<void> = Promise.resolve(); // serializes async spawn/terminal work (+ deterministic in tests)

  constructor(private readonly deps: WorkerRelayDeps) {}

  onEvent(e: CoreEvent): void {
    if (e.type === "worker.spawned") {
      this.tail = this.tail.then(() => this.onSpawned(e)).catch((err) => { process.stderr.write(`[rookery] worker-slack-relay error: ${String(err)}\n`); });
    } else if (e.type === "worker.event") {
      const reporter = this.workers.get(e.workerId);
      if (!reporter) return;
      const ce = workerEventToCoreEvent(e.data, e.sessionId);
      if (ce) reporter.onEvent(ce);
    } else if (e.type === "worker.status" && TERMINAL.has(e.status)) {
      const workerId = e.workerId;
      this.tail = this.tail.then(() => this.onTerminal(workerId)).catch(() => {});
    }
  }

  // Await all in-flight work (spawn posts + tracked reporters). For tests + graceful dispose.
  async idle(): Promise<void> {
    await this.tail.catch(() => {});
    await Promise.all([...this.workers.values()].map((r) => r.idle().catch(() => {})));
  }

  async dispose(): Promise<void> {
    await this.tail.catch(() => {});
    const all = [...this.workers.values()];
    this.workers.clear();
    await Promise.all(all.map((r) => r.dispose().catch(() => {})));
  }

  private channelIfEnabled(): string | null {
    if (!this.deps.enabled()) return null;
    const ch = this.deps.channel().trim();
    return ch || null;
  }

  private async onSpawned(e: Extract<CoreEvent, { type: "worker.spawned" }>): Promise<void> {
    const channel = this.channelIfEnabled();
    if (!channel) return;
    const master = this.deps.resolveThread(e.sessionId);
    if (!master) return; // not a Slack-origin master → out of scope
    if (this.workers.has(e.workerId)) return; // double-emit safety
    const repo = basename(e.repoPath) || e.repoPath;
    const rows: Array<[string, string]> = [["Worker", e.label || e.workerId], ["Repo", repo]];
    if (e.task) rows.push(["Task", e.task]);
    // Quoted bullet list with bold labels (rich_text, border:1). text is the mrkdwn fallback for notifications/search.
    const blocks = [{
      type: "rich_text",
      elements: [{
        type: "rich_text_list", style: "bullet", indent: 0, border: 1,
        elements: rows.map(([k, v]) => ({ type: "rich_text_section", elements: [{ type: "text", text: k, style: { bold: true } }, { type: "text", text: `: ${v}` }] })),
      }],
    }];
    const fallback = rows.map(([k, v]) => `> • *${k}*: ${v}`).join("\n");
    const root = await this.deps.client.chat.postMessage({ channel, text: fallback, blocks });
    const rootTs = root.ts;
    if (!rootTs) return; // can't thread/permalink without a ts
    // Link the worker thread back into the master's Slack thread so the user can follow it.
    const permalink = await this.deps.client.chat.getPermalink({ channel, message_ts: rootTs }).then((r) => r.permalink).catch(() => undefined);
    if (permalink) {
      await this.deps.client.chat.postMessage({ channel: master.channel, thread_ts: master.threadTs, text: `🧵 Worker \`${e.label || e.workerId}\` started — follow: ${permalink}` });
    }
    // master.userId → recipient_user_id, required for chat.startStream to stream in a regular (non-assistant) channel.
    this.workers.set(e.workerId, new SlackThreadReporter(this.deps.client, { channel, threadTs: rootTs, team: master.team, userId: master.userId }, this.deps.getLocale));
  }

  private async onTerminal(workerId: string): Promise<void> {
    const reporter = this.workers.get(workerId);
    if (!reporter) return;
    this.workers.delete(workerId);
    await reporter.dispose().catch(() => {});
  }
}
