import type { CoreEvent } from "../core/events.js";
import type { SlackClient, ThreadTarget } from "./types.js";
import type { Locale } from "../core/i18n.js";
import { t, DEFAULT_LOCALE } from "../core/i18n.js";
import { SlackThreadReporter } from "./reporter.js";
import { workerEventToCoreEvent } from "./worker-event-to-core.js";
import { basename } from "node:path";

export interface WorkerRelayDeps {
  client: SlackClient;
  enabled: () => boolean; // workerSlackRelayEnabled === "1"
  channel: () => string; // workerSlackRelayChannel (trimmed; "" = off)
  resolveThread: (sessionId: string) => ThreadTarget | null; // master's Slack thread, or null if the session isn't Slack-origin
  getLocale?: () => Locale;
  // Route a one-line alert into the master thread's reporter (in-stream when a turn is open, else a threaded post).
  // Returns true when a master reporter was found (delivery is best-effort inside the reporter); false → the relay posts it itself.
  alert?: (sessionId: string, markdown: string) => Promise<boolean>;
}

const TERMINAL = new Set(["stopped", "done", "error", "failed", "orphaned"]);

// Mirrors each Slack-origin master's worker activity into the configured channel (one thread per worker) and links
// that thread back into the master's Slack thread. Subscribe its onEvent to FLEET_CHANNEL. Best-effort: any Slack
// failure is logged, never thrown. Per worker it reuses a SlackThreadReporter (per-turn chatStream + plan cards),
// fed worker events translated to the master-shaped CoreEvents the reporter renders.
export class WorkerSlackRelay {
  private readonly workers = new Map<string, SlackThreadReporter>();
  private tail: Promise<void> = Promise.resolve(); // serializes async spawn/terminal work (+ deterministic in tests)
  // Events that arrive while onSpawned's Slack round-trips are still in flight — flushed on registration.
  // Bounded: a stalled spawn must not buffer unboundedly (beyond the cap, oldest are kept, newest dropped).
  private readonly spawnBuffer = new Map<string, Array<Extract<CoreEvent, { type: "worker.event" }>>>();
  private static readonly SPAWN_BUFFER_MAX = 200;

  constructor(private readonly deps: WorkerRelayDeps) {}

  onEvent(e: CoreEvent): void {
    if (e.type === "worker.spawned") {
      // Open the buffer synchronously so events racing the async spawn round-trips are captured, not dropped.
      if (!this.workers.has(e.workerId) && !this.spawnBuffer.has(e.workerId)) this.spawnBuffer.set(e.workerId, []);
      this.tail = this.tail.then(() => this.onSpawned(e)).catch((err) => { process.stderr.write(`[rookery] worker-slack-relay error: ${String(err)}\n`); });
    } else if (e.type === "worker.event") {
      const buf = this.spawnBuffer.get(e.workerId);
      if (buf) { if (buf.length < WorkerSlackRelay.SPAWN_BUFFER_MAX) buf.push(e); return; }
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
    try {
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
      // Register the reporter + flush the spawn buffer FIRST — this must not be gated on the alert below (a slow or
      // stuck alert round-trip would otherwise delay registration and risk overflowing spawnBuffer for a chatty worker).
      // master.userId → recipient_user_id, required for chat.startStream to stream in a regular (non-assistant) channel.
      const reporter = new SlackThreadReporter(this.deps.client, { channel, threadTs: rootTs, team: master.team, userId: master.userId }, this.deps.getLocale);
      this.workers.set(e.workerId, reporter);
      // Flush events that raced the spawn round-trips, in arrival order.
      for (const ev of this.spawnBuffer.get(e.workerId) ?? []) {
        const ce = workerEventToCoreEvent(ev.data, ev.sessionId);
        if (ce) reporter.onEvent(ce);
      }
      // Stop buffering NOW (atomic with the flush — no await between) so events arriving during the alert round-trip
      // below route straight to the registered reporter instead of being buffered into an entry the finally then clears.
      this.spawnBuffer.delete(e.workerId);
      // Link the worker thread back into the master's Slack thread — BEST-EFFORT: a failed link post must not
      // disable the relay for this worker (registration above already happened regardless of this outcome).
      try {
        const permalink = await this.deps.client.chat.getPermalink({ channel, message_ts: rootTs }).then((r) => r.permalink).catch(() => undefined);
        if (permalink) {
          const locale = this.deps.getLocale?.() ?? DEFAULT_LOCALE;
          const label = e.label || e.workerId;
          // masked link (no raw URL, no unfurl) as a "> " blockquote alert woven into the master's live stream
          const blockquote = `> ${t(locale, "slack.workerStartedAlert", { label })} · <${permalink}|${t(locale, "slack.openThread")}>`;
          const delivered = (await this.deps.alert?.(e.sessionId, blockquote)) ?? false;
          if (!delivered) {
            // no master reporter (edge — a spawning master normally has one): post it ourselves, unfurl off
            await this.deps.client.chat.postMessage({ channel: master.channel, thread_ts: master.threadTs, text: blockquote, unfurl_links: false, unfurl_media: false });
          }
        }
      } catch (err) {
        process.stderr.write(`[rookery] worker-slack-relay link post failed: ${String(err)}\n`);
      }
    } finally {
      this.spawnBuffer.delete(e.workerId); // every exit path: stop buffering (direct delivery or out-of-scope drop)
    }
  }

  private async onTerminal(workerId: string): Promise<void> {
    this.spawnBuffer.delete(workerId); // a worker that dies before registration must not leave a buffer behind
    const reporter = this.workers.get(workerId);
    if (!reporter) return;
    this.workers.delete(workerId);
    await reporter.dispose().catch(() => {});
  }
}
