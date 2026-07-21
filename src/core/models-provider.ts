import type { TokenReader } from "./oauth-usage.js";
import { defaultTokenReader } from "./oauth-usage.js";

// A single available Claude model (for the settings model picker). Maps id/display_name from /v1/models.
export interface ModelInfo {
  id: string;
  displayName: string;
}

// Fallback when there is no token/key or the lookup fails. Current models per claude-api (2026-06).
export const STATIC_MODELS: ModelInfo[] = [
  { id: "claude-opus-4-8", displayName: "Claude Opus 4.8" },
  { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5" },
];

const ANTHROPIC_VERSION = "2023-06-01"; // /v1/models requires this header
const OAUTH_BETA = "oauth-2025-04-20"; // needed when hitting it with an OAuth Bearer (same as oauth-usage)
const MODELS_TIMEOUT_MS = 15000;

// Minimal shape of the real fetch (for test injection). Isomorphic to oauth-usage's FetchLike.
type FetchLike = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

// GET /v1/models → ModelInfo[]. Throws on non-2xx (caller falls back). Drops entries without an id.
export async function fetchModels(headers: Record<string, string>, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<ModelInfo[]> {
  const res = await fetchImpl("https://api.anthropic.com/v1/models?limit=100", {
    headers,
    signal: AbortSignal.timeout(MODELS_TIMEOUT_MS), // so a stalled TLS doesn't freeze us forever (same as usage)
  });
  if (!res.ok) throw new Error(`models: not ok`);
  const data = (await res.json() as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data
    .map((m) => {
      const o = m as { id?: unknown; display_name?: unknown };
      const id = typeof o.id === "string" ? o.id : "";
      return { id, displayName: typeof o.display_name === "string" ? o.display_name : id };
    })
    .filter((m) => m.id);
}

// Provider that bundles token reading / auth-header selection + the lookup. **Always returns a non-empty list** (live or static fallback).
// Auth priority: ANTHROPIC_API_KEY (x-api-key) > Claude Code OAuth token (Bearer + oauth beta, same token reader as usage).
//
// Last-good caching: once a live fetch succeeds, the catalog is remembered and served on any subsequent transient
// failure (network/timeout/non-2xx/momentary auth loss) INSTEAD of the 3-item STATIC list. Without this, a client
// WS reconnect (laptop sleep/wake, network blip) re-requests models.list, the refetch fails transiently, and the
// full catalog the picker was showing gets overwritten with the 3 static defaults until an app restart. The daemon
// process outlives client reconnects, so its cache survives exactly the reconnect that used to trigger the downgrade.
// (Same spirit as codex-models-provider's cached-first-success; here we advance the cache on every fresh success.)
export function makeModelsProvider(opts: { reader?: TokenReader; apiKey?: string | (() => string | undefined); fetchImpl?: FetchLike } = {}): () => Promise<ModelInfo[]> {
  const reader = opts.reader ?? defaultTokenReader();
  let lastGood: ModelInfo[] | null = null; // last successful live catalog; null until the first success
  return async () => {
    try {
      // Resolve per call (audit #30): a boot-time snapshot meant a key saved in Settings never reached the
      // model picker until a daemon restart (and a rotated key kept 401ing into the static fallback).
      const apiKey = typeof opts.apiKey === "function" ? opts.apiKey() : opts.apiKey;
      let headers: Record<string, string>;
      if (apiKey) {
        headers = { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION };
      } else {
        const token = await reader.read();
        if (!token) return lastGood ?? STATIC_MODELS; // no auth → keep the last good catalog if we ever had one (don't downgrade on a momentary token loss)
        headers = { Authorization: `Bearer ${token}`, "anthropic-beta": OAUTH_BETA, "anthropic-version": ANTHROPIC_VERSION };
      }
      const models = await fetchModels(headers, opts.fetchImpl ?? (fetch as unknown as FetchLike));
      if (models.length > 0) { lastGood = models; return models; } // fresh success → advance the cache
      return lastGood ?? STATIC_MODELS; // empty response → serve last good rather than downgrade
    } catch {
      return lastGood ?? STATIC_MODELS; // network/non-2xx/timeout → serve last good, else static list
    }
  };
}
