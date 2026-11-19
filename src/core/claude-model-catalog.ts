import type { QueryFn } from "./claude-backend.js";
import { claudeUserMessages } from "./claude-backend.js";
import { MessageQueue } from "./message-queue.js";

// The Claude model the SDK recommends for this account — the `"default"` row of Query.supportedModels(),
// resolved to its concrete id (e.g. "claude-opus-5-5"). This is what Claude Code itself picks when no model
// is set, and it follows the account's plan and new releases without a rookery code change.
//
// The probe spins up a one-shot query, calls only supportedModels(), and closes it (no turn is sent), the
// same way CommandCatalog probes slash commands. Best-effort: a failed or timed-out probe keeps the last
// good answer (or null), and callers fall back to their configured default.

const DEFAULT_TTL_MS = 30 * 60 * 1000; // the recommendation changes with releases/plans, not per turn
const DEFAULT_TIMEOUT_MS = 10_000;

type ModelRow = { value?: unknown; resolvedModel?: unknown };
type Probeable = AsyncIterable<unknown> & {
  supportedModels(): Promise<ModelRow[]>;
  interrupt(): Promise<void>;
};

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Claude model discovery timed out")), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

// The concrete id behind the SDK's "default" alias, or null when the SDK reports none.
export function recommendedFromRows(rows: ModelRow[]): string | null {
  const row = rows.find((r) => r.value === "default");
  return typeof row?.resolvedModel === "string" && row.resolvedModel.trim() ? row.resolvedModel.trim() : null;
}

export class ClaudeModelCatalog {
  private last: string | null = null;
  private fetchedAt: number | null = null;
  private inflight: Promise<string | null> | null = null;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(
    private readonly queryFn: QueryFn,
    private readonly opts: { cwd: string; ttlMs?: number; timeoutMs?: number; now?: () => number },
  ) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
  }

  // Sync peek for per-turn resolvers: the last known recommendation (null until a probe succeeds). A missing
  // or stale answer starts a background refresh, so the next call sees the fresh value.
  recommended(): string | null {
    if (this.fetchedAt === null || this.now() - this.fetchedAt >= this.ttlMs) void this.refresh();
    return this.last;
  }

  // Probe now (coalesced). Resolves to the current recommendation, keeping the last good one on failure.
  refresh(): Promise<string | null> {
    this.inflight ??= this.probe().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async probe(): Promise<string | null> {
    const queue = new MessageQueue();
    const abort = new AbortController();
    try {
      const q = this.queryFn({
        prompt: claudeUserMessages(queue),
        // persistSession:false — the probe sends no turn, and leaves no session transcript behind.
        options: { cwd: this.opts.cwd, permissionMode: "bypassPermissions", abortController: abort, persistSession: false },
      }) as unknown as Probeable;
      // The iterator must be consumed for control responses to flow; its messages are discarded.
      const pump = (async () => { try { for await (const _m of q) { void _m; } } catch { /* aborted */ } })();
      try {
        const found = recommendedFromRows(await withTimeout(q.supportedModels(), this.timeoutMs));
        if (found) this.last = found;
        return this.last;
      } finally {
        this.fetchedAt = this.now(); // a failed probe also waits a TTL before retrying
        queue.close();
        abort.abort();
        try { await q.interrupt(); } catch { /* ignore */ }
        void pump.catch(() => {});
      }
    } catch {
      this.fetchedAt = this.now();
      return this.last;
    }
  }
}
