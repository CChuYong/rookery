// Active authentication for the Claude Agent SDK, surfaced in the desktop Settings "Claude" tab.
// The point is transparency: ANTHROPIC_API_KEY takes priority over a Claude subscription (OAuth) login,
// so when both exist the API key silently overrides the subscription — flag that to avoid surprise metered billing.
//
// Note: we deliberately do NOT report a token expiry. The OAuth access token is short-lived and auto-refreshed
// by Claude Code (via its refresh token), and on macOS the live credential is in the Keychain, not the
// ~/.claude/.credentials.json file — so any expiry we could read is both stale and the wrong granularity
// (it is not "how long the login is valid"). Presence (below) already reflects what the SDK would use.
export interface AuthStatus {
  method: "api-key" | "oauth" | "none"; // what the SDK will actually use (api key wins over oauth)
  apiKeyPresent: boolean; // ANTHROPIC_API_KEY set in the daemon env
  apiKeyHint: string | null; // masked key (e.g. "sk-ant-a…1234"), never the full secret
  oauthPresent: boolean; // a Claude Code login is available (file or, on macOS, Keychain)
  overridesSubscription: boolean; // apiKeyPresent && oauthPresent → key wins → usage billed to the API, not the subscription
}

// Mask a secret: keep the recognizable prefix + last 4, hide the middle. Short/odd keys collapse to "…".
function maskApiKey(k: string): string {
  return k.length <= 12 ? "…" : `${k.slice(0, 8)}…${k.slice(-4)}`;
}

// Assemble the active auth status. `readToken` is the SDK's own OAuth token reader (oauth-usage), which checks
// both the credentials file and the macOS Keychain — so OAuth presence here matches what the SDK would actually use.
export async function getAuthStatus(env: NodeJS.ProcessEnv, readToken: () => Promise<string | null>): Promise<AuthStatus> {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  const apiKeyPresent = !!apiKey;
  const token = await readToken().catch(() => null);
  const oauthPresent = !!token;
  const method: AuthStatus["method"] = apiKeyPresent ? "api-key" : oauthPresent ? "oauth" : "none";
  return {
    method,
    apiKeyPresent,
    apiKeyHint: apiKey ? maskApiKey(apiKey) : null,
    oauthPresent,
    overridesSubscription: apiKeyPresent && oauthPresent,
  };
}
