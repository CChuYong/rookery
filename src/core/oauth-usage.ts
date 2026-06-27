import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

// Server-side percentages returned by Claude's unofficial OAuth usage endpoint (sums all surfaces, same source as /usage).
export interface OAuthUsage {
  fiveHour: number | null; // 5-hour rolling utilization %
  sevenDay: number | null; // weekly utilization %
  sevenDayOpus: number | null; // Opus weekly % (null depending on plan)
  sevenDaySonnet: number | null; // Sonnet weekly % (null depending on plan)
  fiveHourResetsAt: string | null;
  sevenDayResetsAt: string | null;
  extra: { usedCredits: number; monthlyLimit: number; currency: string } | null;
}

export interface TokenReader {
  read(): Promise<string | null>;
}

interface CredsShape {
  claudeAiOauth?: { accessToken?: string; expiresAt?: number };
}
interface Cred {
  accessToken: string;
  expiresAt: number;
}
function extractCred(j: unknown): Cred | null {
  const o = (j as CredsShape)?.claudeAiOauth;
  if (typeof o?.accessToken !== "string" || !o.accessToken) return null;
  return { accessToken: o.accessToken, expiresAt: typeof o.expiresAt === "number" ? o.expiresAt : 0 };
}

// Default token reader: reads both the file (~/.claude/.credentials.json) and (on macOS) the Keychain, using the freshest token (max expiresAt).
// Because Claude Code may refresh only one of the two, leaving the other stale (e.g. Keychain is current, file is expired). Read-only — does not refresh.
export function defaultTokenReader(): TokenReader {
  return {
    async read(): Promise<string | null> {
      const candidates: Cred[] = [];
      try {
        const p = path.join(os.homedir(), ".claude", ".credentials.json");
        const c = extractCred(JSON.parse(await fsp.readFile(p, "utf8")));
        if (c) candidates.push(c);
      } catch {
        /* file missing / parse failure */
      }
      if (process.platform === "darwin") {
        try {
          const { stdout } = await pexec("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
          const c = extractCred(JSON.parse(stdout));
          if (c) candidates.push(c);
        } catch {
          /* no keychain entry */
        }
      }
      if (candidates.length === 0) return null;
      candidates.sort((a, b) => b.expiresAt - a.expiresAt); // prefer the latest to expire (= most recent)
      return candidates[0]!.accessToken;
    },
  };
}

type FetchLike = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

const OAUTH_TIMEOUT_MS = 15000;

function util(x: unknown): number | null {
  const u = (x as { utilization?: unknown })?.utilization;
  return typeof u === "number" ? u : null;
}
function resetsAt(x: unknown): string | null {
  const r = (x as { resets_at?: unknown })?.resets_at;
  return typeof r === "string" ? r : null;
}

export async function fetchOAuthUsage(token: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<OAuthUsage | null> {
  const res = await fetchImpl("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "anthropic-beta": "oauth-2025-04-20", // without this beta header it does not work
    },
    signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS), // so a stalled TLS connection does not permanently freeze the usage collector.
  });
  if (!res.ok) return null;
  const j = (await res.json()) as Record<string, unknown>;
  const ex = j.extra_usage as { is_enabled?: boolean; used_credits?: number; monthly_limit?: number; currency?: string } | undefined;
  return {
    fiveHour: util(j.five_hour),
    sevenDay: util(j.seven_day),
    sevenDayOpus: util(j.seven_day_opus),
    sevenDaySonnet: util(j.seven_day_sonnet),
    fiveHourResetsAt: resetsAt(j.five_hour),
    sevenDayResetsAt: resetsAt(j.seven_day),
    extra: ex?.is_enabled ? { usedCredits: ex.used_credits ?? 0, monthlyLimit: ex.monthly_limit ?? 0, currency: ex.currency ?? "USD" } : null,
  };
}

// Default provider that bundles token reading + usage lookup. Returns null if there is no token or on failure.
export function makeOAuthUsageProvider(reader: TokenReader = defaultTokenReader()): () => Promise<OAuthUsage | null> {
  return async () => {
    const token = await reader.read();
    if (!token) return null;
    return fetchOAuthUsage(token);
  };
}
