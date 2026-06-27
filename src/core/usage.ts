import type { OAuthUsage } from "./oauth-usage.js";

// Usage snapshot: tokens/$ come from ccusage (JSONL parsing), % comes from the OAuth endpoint (pct).
export interface UsageSnapshot {
  session: { totalTokens: number; costUSD: number; startTime: string; endTime: string } | null;
  weekly: { totalTokens: number; costUSD: number } | null;
  today: { totalTokens: number; costUSD: number } | null;
  pct: OAuthUsage | null;
  updatedAt: string | null;
  error: string | null;
}

export interface UsageExec {
  // Passes args to ccusage and returns its stdout (a JSON string).
  run(args: string[]): Promise<string>;
}

export function emptyUsage(): UsageSnapshot {
  return { session: null, weekly: null, today: null, pct: null, updatedAt: null, error: null };
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function parseUsage(blocksOut: string, dailyOut: string, now: Date): Pick<UsageSnapshot, "session" | "weekly" | "today"> {
  const todayStr = ymd(now);
  const last7 = new Set<string>();
  for (let i = 0; i < 7; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    last7.add(ymd(d));
  }

  const blocks = (JSON.parse(blocksOut).blocks ?? []) as Array<{ isActive?: boolean; costUSD?: number; totalTokens?: number; startTime: string; endTime: string }>;
  const blk = blocks.find((b) => b.isActive) ?? null;
  const session = blk ? { totalTokens: blk.totalTokens ?? 0, costUSD: blk.costUSD ?? 0, startTime: blk.startTime, endTime: blk.endTime } : null;

  // ccusage 20.x uses `period` as the date key ("2026-06-19"). (not the older `date`)
  const days = (JSON.parse(dailyOut).daily ?? []) as Array<{ period: string; totalTokens?: number; totalCost?: number }>;
  const td = days.find((d) => d.period === todayStr);
  const today = { totalTokens: td?.totalTokens ?? 0, costUSD: td?.totalCost ?? 0 };

  let wTok = 0, wCost = 0;
  for (const d of days) {
    if (!last7.has(d.period)) continue;
    wTok += d.totalTokens ?? 0;
    wCost += d.totalCost ?? 0;
  }
  return { session, weekly: { totalTokens: wTok, costUSD: wCost }, today };
}

export class UsageCollector {
  private snap: UsageSnapshot = emptyUsage();
  private timer: ReturnType<typeof setInterval> | null = null;
  private collecting = false;

  constructor(
    private readonly opts: {
      exec: UsageExec;
      refreshMs: number;
      now?: () => Date;
      oauthUsage?: () => Promise<OAuthUsage | null>; // server-side % (if absent, pct is not collected)
    },
  ) {}

  snapshot(): UsageSnapshot {
    return this.snap;
  }

  start(): void {
    void this.collect();
    this.timer = setInterval(() => void this.collect(), this.opts.refreshMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async collect(): Promise<void> {
    // Skip if the previous collect is still in progress — prevents slow ccusage/network calls from
    // piling up on every setInterval and accumulating processes.
    if (this.collecting) return;
    this.collecting = true;
    try {
      await this.doCollect();
    } finally {
      this.collecting = false;
    }
  }

  private async doCollect(): Promise<void> {
    const stamp = (): string => (this.opts.now?.() ?? new Date()).toISOString();
    // % — OAuth first (fast): apply to the snapshot as soon as it arrives → UI shows the gauge without waiting for ccusage (slow).
    if (this.opts.oauthUsage) {
      try {
        const pct = await this.opts.oauthUsage();
        if (pct) this.snap = { ...this.snap, pct, updatedAt: stamp() };
      } catch {
        /* keep the previous pct */
      }
    }
    // tokens/$ — ccusage (slow because it parses thousands of JSONL entries)
    try {
      const blocksOut = await this.opts.exec.run(["blocks", "--active", "--json"]);
      const dailyOut = await this.opts.exec.run(["daily", "--json"]);
      this.snap = { ...this.snap, ...parseUsage(blocksOut, dailyOut, this.opts.now?.() ?? new Date()), updatedAt: stamp(), error: null };
    } catch (err) {
      this.snap = { ...this.snap, error: String(err), updatedAt: stamp() }; // keep the previous token data
    }
  }
}
