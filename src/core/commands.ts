import type { QueryFn } from "./worker.js";
import { MessageQueue } from "./message-queue.js";
import type { SlashCommandInfo } from "./agent-backend.js";

// Re-exported from the port module (neutral vocabulary) — existing importers keep this path.
export type { SlashCommandInfo } from "./agent-backend.js";

const DEFAULT_TTL_MS = 5 * 60 * 1000; // commands rarely change — 5-minute cache
const PROBE_TIMEOUT_MS = 8000;

// Minimal interface that only calls supportedCommands() on the query result.
type Probeable = AsyncIterable<unknown> & {
  supportedCommands(): Promise<SlashCommandInfo[]>;
  interrupt(): Promise<void>;
};

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(fallback); } }, ms);
    void p.then((v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } }, () => { if (!done) { done = true; clearTimeout(timer); resolve(fallback); } });
  });
}

// Probes the slash-command list per cwd once via the SDK and caches it. The probe spins up a
// one-shot query, calls only supportedCommands(), and closes it (no turn is sent). Best-effort — returns [] on failure/timeout.
export class CommandCatalog {
  private readonly cache = new Map<string, { commands: SlashCommandInfo[]; at: number }>();
  private readonly inflight = new Map<string, Promise<SlashCommandInfo[]>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly queryFn: QueryFn,
    private readonly opts: { model: string | (() => string); ttlMs?: number; now?: () => number },
  ) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  async forCwd(cwd: string): Promise<SlashCommandInfo[]> {
    const hit = this.cache.get(cwd);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.commands;
    const existing = this.inflight.get(cwd);
    if (existing) return existing; // coalesce concurrent requests
    const p = this.probe(cwd).finally(() => this.inflight.delete(cwd));
    this.inflight.set(cwd, p);
    return p;
  }

  private async probe(cwd: string): Promise<SlashCommandInfo[]> {
    const model = typeof this.opts.model === "function" ? this.opts.model() : this.opts.model;
    const queue = new MessageQueue();
    const abort = new AbortController();
    try {
      const q = this.queryFn({
        prompt: queue,
        options: { cwd, model, permissionMode: "bypassPermissions", abortController: abort },
      }) as unknown as Probeable;
      // Background pump: the generator must be consumed for control responses (supportedCommands) to flow. Messages are discarded.
      const pump = (async () => { try { for await (const _m of q) { void _m; } } catch { /* aborted */ } })();
      try {
        const cmds = await withTimeout(q.supportedCommands(), PROBE_TIMEOUT_MS, [] as SlashCommandInfo[]);
        const mapped = cmds.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint, aliases: c.aliases }));
        this.cache.set(cwd, { commands: mapped, at: this.now() });
        return mapped;
      } finally {
        queue.close();
        abort.abort();
        try { await q.interrupt(); } catch { /* ignore */ }
        await pump.catch(() => {});
      }
    } catch {
      return []; // probe itself failed → no candidates
    }
  }
}
