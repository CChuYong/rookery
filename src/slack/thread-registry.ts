import type { EventBus } from "../core/events.js";
import type { SlackThreadReporter } from "./reporter.js";

export class ThreadRegistry {
  private readonly entries = new Map<string, { reporter: SlackThreadReporter; unsubscribe: () => void }>();

  // maxEntries: caps the leak where reporter+bus subscriptions accumulate without bound as threads grow, via an LRU cap (slack-thread-registry-leak).
  constructor(private readonly bus: EventBus, private readonly maxEntries = 200) {}

  ensure(sessionId: string, makeReporter: () => SlackThreadReporter): SlackThreadReporter {
    const existing = this.entries.get(sessionId);
    if (existing) {
      // LRU: move the most recently used entry to the back (Map preserves insertion order).
      this.entries.delete(sessionId);
      this.entries.set(sessionId, existing);
      return existing.reporter;
    }
    const reporter = makeReporter();
    const unsubscribe = this.bus.subscribe(sessionId, (e) => reporter.onEvent(e));
    this.entries.set(sessionId, { reporter, unsubscribe });
    // When the cap is exceeded, evict the oldest entry: unsubscribe from the bus + dispose the reporter (close any open streaming message).
    // It will be re-ensured on that thread's next message.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const e = this.entries.get(oldest)!;
      e.unsubscribe();
      void e.reporter.dispose().catch(() => {}); // best-effort: close the orphaned streamer
      this.entries.delete(oldest);
    }
    return reporter;
  }

  disposeAll(): void {
    for (const { unsubscribe, reporter } of this.entries.values()) {
      unsubscribe();
      void reporter.dispose().catch(() => {});
    }
    this.entries.clear();
  }
}
