import { CodexClient } from "./codex/codex-client.js";
import type { CodexSpawn } from "./codex/codex-transport.js";

// The authentication state of the Codex backend, surfaced in the desktop Settings Codex sub-tab so
// picking codex gives a readiness signal BEFORE a turn fails mid-run (Claude has the same via getAuthStatus).
// `method` is the active codex account type; `ready` = a codex turn will authenticate; `hint` = a
// human-readable detail (chatgpt email + plan), null otherwise. Re-declared structurally in messages.ts
// (protocol stays transport-agnostic, no core import there), like CodexModelInfo.
export interface CodexAuthStatus {
  method: "api-key" | "chatgpt" | "bedrock" | "none";
  ready: boolean;
  hint: string | null;
}

const CLIENT_INFO = { name: "rookery", title: "rookery", version: "0.1.0" };
const DEFAULT_TIMEOUT_MS = 10_000;

// The `account/read` (GetAccount) response, camelCase (ts-rs), verified against codex-cli 0.142.5:
// { account: { type: "apiKey" } | { type: "chatgpt", email, planType } | { type: "amazonBedrock" } | null,
//   requiresOpenaiAuth: boolean }. requiresOpenaiAuth:true means auth is MISSING (a turn would need to log in).
type AccountRead = {
  account?: { type?: string; email?: string | null; planType?: string } | null;
  requiresOpenaiAuth?: boolean;
} | null | undefined;

// Pure mapping — exported so the branch table is unit-testable without a child process.
export function mapCodexAuth(res: AccountRead): CodexAuthStatus {
  const acct = res?.account;
  const ready = res?.requiresOpenaiAuth === false && acct != null;
  if (!ready || !acct) return { method: "none", ready: false, hint: null };
  if (acct.type === "chatgpt") {
    const plan = acct.planType ? ` · ${acct.planType}` : "";
    return { method: "chatgpt", ready: true, hint: (acct.email ?? "ChatGPT") + plan };
  }
  if (acct.type === "apiKey") return { method: "api-key", ready: true, hint: null };
  if (acct.type === "amazonBedrock") return { method: "bedrock", ready: true, hint: null };
  return { method: "none", ready: false, hint: null };
}

// Probe for the desktop Codex auth-readiness card: spawns a short-lived `codex app-server` child and
// reads its account state. Mirrors CodexBackend.openClient's auth flow (initialize → account/read → if an
// in-app apiKey is set AND auth is missing, provision via account/login/start → re-read) so "ready" means
// "a real turn will authenticate". Unlike makeCodexModelsProvider this does NOT cache — auth changes at
// runtime (a `codex login`, or toggling the in-app key). Every failure returns `null` (never throws).
export function makeCodexAuthProvider(opts: {
  spawn: CodexSpawn;
  timeoutMs?: number;
  // Same resolvers CodexBackend's turn children use (server.ts wires them from the SAME closures) — the
  // probe MUST read the account the turns run under (redirected CODEX_HOME when an in-app key is set),
  // or it reports the wrong account's readiness (the findings [25]/[26] constraint, applied to auth).
  env?: () => NodeJS.ProcessEnv | undefined;
  apiKey?: () => string | undefined;
}): { status(): Promise<CodexAuthStatus | null> } {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    async status() {
      let client: CodexClient | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Inside the try so a synchronously-throwing spawn also degrades to null, not just async failures.
        client = new CodexClient(opts.spawn({ env: opts.env?.() }));
        const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("codex auth probe timed out")), timeoutMs); });
        await Promise.race([client.request("initialize", { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: false, requestAttestation: false } }), timeout]);
        client.notify("initialized", {});
        let res = (await Promise.race([client.request("account/read", {}), timeout])) as AccountRead;
        // Provision the in-app codexApiKey once (same RPC path as openClient) then re-read, so the probe
        // reports the state a real turn would end up in. No key → skip; rely on the ambient ~/.codex auth.
        const apiKey = opts.apiKey?.();
        if (apiKey && res?.requiresOpenaiAuth) {
          await Promise.race([client.request("account/login/start", { type: "apiKey", apiKey }), timeout]);
          res = (await Promise.race([client.request("account/read", {}), timeout])) as AccountRead;
        }
        return mapCodexAuth(res);
      } catch {
        return null; // codex missing / not authed / timeout / malformed → null
      } finally {
        if (timer) clearTimeout(timer);
        client?.close();
      }
    },
  };
}
