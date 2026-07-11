import { CodexClient } from "./codex/codex-client.js";
import type { CodexSpawn } from "./codex/codex-transport.js";

// One codex rate-limit window (from account/rateLimits/read). resetsAt is unix SECONDS.
export interface CodexRateWindow { usedPercent: number; resetsAt: number | null }

// Codex account usage for the Usage panel's Codex tab. No USD anywhere — codex plan billing has
// no per-token cost notion (design spec non-goal).
export interface CodexUsage {
  fiveHour: CodexRateWindow | null; // rateLimits.primary (observed windowDurationMins 300)
  sevenDay: CodexRateWindow | null; // rateLimits.secondary (observed 10080)
  planType: string | null;
  todayTokens: number | null; // dailyUsageBuckets entry with startDate === today (local)
  weeklyTokens: number | null; // sum of buckets in the last 7 days (today inclusive)
}

const CLIENT_INFO = { name: "rookery", title: "rookery", version: "0.1.0" };
const DEFAULT_TIMEOUT_MS = 10_000;

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function mapWindow(w: unknown): CodexRateWindow | null {
  const o = w as { usedPercent?: unknown; resetsAt?: unknown } | null | undefined;
  if (typeof o?.usedPercent !== "number") return null;
  return { usedPercent: o.usedPercent, resetsAt: typeof o.resetsAt === "number" ? o.resetsAt : null };
}

// Pure response→CodexUsage mapping (exported for tests). Tolerant duck-typed decode: each side
// failing alone still yields the other's data; NOTHING usable → null (the provider treats that
// as a failed fetch so the collector keeps its previous snapshot).
export function mapCodexUsage(rateLimitsRes: unknown, usageRes: unknown, now: Date): CodexUsage | null {
  const rl = (rateLimitsRes as { rateLimits?: { primary?: unknown; secondary?: unknown; planType?: unknown } } | null | undefined)?.rateLimits;
  const fiveHour = mapWindow(rl?.primary);
  const sevenDay = mapWindow(rl?.secondary);
  const planType = typeof rl?.planType === "string" ? rl.planType : null;

  const buckets = (usageRes as { dailyUsageBuckets?: unknown } | null | undefined)?.dailyUsageBuckets;
  let todayTokens: number | null = null;
  let weeklyTokens: number | null = null;
  if (Array.isArray(buckets)) {
    const todayStr = ymd(now);
    const last7 = new Set<string>();
    for (let i = 0; i < 7; i++) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      last7.add(ymd(d));
    }
    let weekSum = 0;
    let sawAny = false;
    for (const b of buckets) {
      const o = b as { startDate?: unknown; tokens?: unknown };
      if (typeof o.startDate !== "string" || typeof o.tokens !== "number") continue;
      sawAny = true;
      if (o.startDate === todayStr) todayTokens = (todayTokens ?? 0) + o.tokens;
      if (last7.has(o.startDate)) weekSum += o.tokens;
    }
    if (sawAny) {
      weeklyTokens = weekSum;
      todayTokens = todayTokens ?? 0; // buckets exist but none for today = genuinely 0, not unknown
    }
  }

  if (!fiveHour && !sevenDay && todayTokens == null && weeklyTokens == null) return null;
  return { fiveHour, sevenDay, planType, todayTokens, weeklyTokens };
}

// Poll provider for the Usage panel's Codex tab: one short-lived `codex app-server` child per
// fetch() — initialize → (optional in-app apiKey provisioning, same dance as the models/auth
// providers) → account/rateLimits/read + account/usage/read → map. NEVER caches (rate limits must
// stay fresh; the UsageCollector interval is the cadence) and never throws — any failure → null.
// env/apiKey are the SAME resolvers the codex turn children use, so the child authenticates under
// the account the turns run under (models-provider findings [25]/[26] parity).
export function makeCodexUsageProvider(opts: {
  spawn: CodexSpawn;
  timeoutMs?: number;
  env?: () => NodeJS.ProcessEnv | undefined;
  apiKey?: () => string | undefined;
  now?: () => Date;
}): { fetch(): Promise<CodexUsage | null> } {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    async fetch() {
      let client: CodexClient | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Inside the try so a synchronously-throwing spawn also degrades to null (models-provider parity).
        client = new CodexClient(opts.spawn({ env: opts.env?.() }));
        const timeout = new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error("codex usage read timed out")), timeoutMs);
        });
        await Promise.race([client.request("initialize", { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: false, requestAttestation: false } }), timeout]);
        client.notify("initialized", {});
        const apiKey = opts.apiKey?.();
        if (apiKey) {
          const acct = (await Promise.race([client.request("account/read", {}), timeout])) as { requiresOpenaiAuth?: boolean } | null;
          if (acct?.requiresOpenaiAuth) await Promise.race([client.request("account/login/start", { type: "apiKey", apiKey }), timeout]);
        }
        // Per-read catch: one read failing alone must not sink the other (partial data beats none).
        const rateLimits = await Promise.race([client.request("account/rateLimits/read", {}), timeout]).catch(() => null);
        const usage = await Promise.race([client.request("account/usage/read", {}), timeout]).catch(() => null);
        return mapCodexUsage(rateLimits, usage, opts.now?.() ?? new Date());
      } catch {
        return null; // codex missing / not authed / timeout / malformed → null
      } finally {
        if (timer) clearTimeout(timer);
        client?.close();
      }
    },
  };
}
