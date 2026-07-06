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
  if (o.hidden === true) return null; // defense-in-depth: drop hidden rows even if includeHidden:false ever leaks one (spec §①)
  const supported = Array.isArray(o.supportedReasoningEfforts)
    ? o.supportedReasoningEfforts.map((e) => (typeof e === "object" && e && typeof (e as { reasoningEffort?: unknown }).reasoningEffort === "string" ? (e as { reasoningEffort: string }).reasoningEffort : "")).filter(Boolean)
    : [];
  return { id, displayName: typeof o.displayName === "string" ? o.displayName : id, defaultEffort: typeof o.defaultReasoningEffort === "string" ? o.defaultReasoningEffort : "", supportedEfforts: supported, isDefault: o.isDefault === true };
}

// Provider for the desktop Codex model/effort picker: spawns a short-lived `codex app-server` child,
// fetches its authoritative `model/list` catalog, and caches the first successful (non-empty) result
// for the daemon's lifetime. A failure (spawn error / not authed / timeout / malformed / empty) returns
// `null` and is NOT cached, so a later call (e.g. after installing/authing codex) retries live.
export function makeCodexModelsProvider(opts: {
  spawn: CodexSpawn;
  timeoutMs?: number;
  // Same resolvers CodexBackend's turn children use (server.ts wires them from the SAME closures).
  // WITHOUT these the catalog child authenticated under the ambient ~/.codex account while turns run
  // under the in-app codexApiKey / redirected CODEX_HOME — so an in-app-key-only deployment got a
  // permanently null catalog, and a mixed setup showed the wrong account's models (findings [25]/[26]).
  env?: () => NodeJS.ProcessEnv | undefined;
  apiKey?: () => string | undefined;
}): { list(): Promise<CodexModelInfo[] | null> } {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let cache: CodexModelInfo[] | null = null; // caches the first SUCCESS only
  return {
    async list() {
      if (cache) return cache;
      let client: CodexClient | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Inside the try so a synchronously-throwing spawn (or CodexClient ctor) also degrades to null,
        // not just async failures — every failure mode returns null, never rejects list().
        client = new CodexClient(opts.spawn({ env: opts.env?.() }));
        const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("codex model/list timed out")), timeoutMs); });
        await Promise.race([client.request("initialize", { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: false, requestAttestation: false } }), timeout]);
        client.notify("initialized", {});
        // Provision the in-app codexApiKey into the (redirected) CODEX_HOME once — same RPC path
        // CodexBackend.openClient uses — so the catalog authenticates under the account the turns run
        // under. No key set → skip and rely on the ambient ~/.codex auth (unchanged behavior).
        const apiKey = opts.apiKey?.();
        if (apiKey) {
          const acct = (await Promise.race([client.request("account/read", {}), timeout])) as { requiresOpenaiAuth?: boolean } | null;
          if (acct?.requiresOpenaiAuth) await Promise.race([client.request("account/login/start", { type: "apiKey", apiKey }), timeout]);
        }
        const res = (await Promise.race([client.request("model/list", { includeHidden: false }), timeout])) as { data?: unknown };
        const rows = Array.isArray(res?.data) ? res.data : [];
        const models = rows.map(mapModel).filter((m): m is CodexModelInfo => m !== null);
        // hidden rows are excluded primarily server-side by includeHidden:false; mapModel ALSO drops any
        // hidden:true row as defense-in-depth (see mapModel), so a leaked hidden row can't reach the picker.
        if (models.length === 0) return null; // empty catalog = treat as failure, don't cache → retry later
        cache = models;
        return cache;
      } catch {
        return null; // codex missing / not authed / timeout / malformed → null (NOT cached)
      } finally {
        if (timer) clearTimeout(timer);
        client?.close();
      }
    },
  };
}
