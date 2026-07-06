import { CodexClient } from "./codex/codex-client.js";
import type { CodexSpawn } from "./codex/codex-transport.js";

// One available Codex model (from the app-server's `model/list` catalog). Mirrors ModelInfo's role
// for the Claude models.list path, but richer (per-model reasoning-effort options) — see messages.ts's
// structurally-identical re-declaration (protocol stays transport-agnostic, no core import there).
export interface CodexModelInfo { id: string; displayName: string; defaultEffort: string; supportedEfforts: string[]; isDefault: boolean; }

const CLIENT_INFO = { name: "rookery", title: "rookery", version: "0.1.0" };
const DEFAULT_TIMEOUT_MS = 10_000;

// Maps one raw `model/list` data[] row (camelCase, ts-rs) → CodexModelInfo. Drops rows without an id.
function mapModel(m: unknown): CodexModelInfo | null {
  const o = m as { id?: unknown; displayName?: unknown; defaultReasoningEffort?: unknown; supportedReasoningEfforts?: unknown; isDefault?: unknown; hidden?: unknown };
  const id = typeof o.id === "string" ? o.id : "";
  if (!id) return null;
  const supported = Array.isArray(o.supportedReasoningEfforts)
    ? o.supportedReasoningEfforts.map((e) => (typeof e === "object" && e && typeof (e as { reasoningEffort?: unknown }).reasoningEffort === "string" ? (e as { reasoningEffort: string }).reasoningEffort : "")).filter(Boolean)
    : [];
  return { id, displayName: typeof o.displayName === "string" ? o.displayName : id, defaultEffort: typeof o.defaultReasoningEffort === "string" ? o.defaultReasoningEffort : "", supportedEfforts: supported, isDefault: o.isDefault === true };
}

// Provider for the desktop Codex model/effort picker: spawns a short-lived `codex app-server` child,
// fetches its authoritative `model/list` catalog, and caches the first successful (non-empty) result
// for the daemon's lifetime. A failure (spawn error / not authed / timeout / malformed / empty) returns
// `null` and is NOT cached, so a later call (e.g. after installing/authing codex) retries live.
export function makeCodexModelsProvider(opts: { spawn: CodexSpawn; timeoutMs?: number }): { list(): Promise<CodexModelInfo[] | null> } {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let cache: CodexModelInfo[] | null = null; // caches the first SUCCESS only
  return {
    async list() {
      if (cache) return cache;
      const client = new CodexClient(opts.spawn({}));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("codex model/list timed out")), timeoutMs); });
      try {
        await Promise.race([client.request("initialize", { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: false, requestAttestation: false } }), timeout]);
        client.notify("initialized", {});
        const res = (await Promise.race([client.request("model/list", { includeHidden: false }), timeout])) as { data?: unknown };
        const rows = Array.isArray(res?.data) ? res.data : [];
        const models = rows.map(mapModel).filter((m): m is CodexModelInfo => m !== null);
        // hidden rows are excluded server-side by includeHidden:false (mapModel has no hidden pass-through, so no client filter needed).
        if (models.length === 0) return null; // empty catalog = treat as failure, don't cache → retry later
        cache = models;
        return cache;
      } catch {
        return null; // codex missing / not authed / timeout / malformed → null (NOT cached)
      } finally {
        if (timer) clearTimeout(timer);
        client.close();
      }
    },
  };
}
