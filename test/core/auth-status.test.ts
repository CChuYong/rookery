import { describe, it, expect } from "vitest";
import { getAuthStatus } from "../../src/core/auth-status.js";

const tok = (v: string | null) => () => Promise.resolve(v);

describe("getAuthStatus", () => {
  it("api-key only → method api-key, masked hint, no override", async () => {
    const s = await getAuthStatus({ ANTHROPIC_API_KEY: "sk-ant-abcdefgh1234" }, tok(null));
    expect(s.method).toBe("api-key");
    expect(s.apiKeyPresent).toBe(true);
    expect(s.oauthPresent).toBe(false);
    expect(s.overridesSubscription).toBe(false);
    expect(s.apiKeyHint).toContain("sk-ant-");
    expect(s.apiKeyHint).toContain("…");
    expect(s.apiKeyHint).not.toContain("efgh"); // middle masked
  });

  it("oauth only → method oauth", async () => {
    const s = await getAuthStatus({}, tok("oauth-token"));
    expect(s.method).toBe("oauth");
    expect(s.oauthPresent).toBe(true);
    expect(s.apiKeyPresent).toBe(false);
    expect(s.overridesSubscription).toBe(false);
  });

  it("both present → api-key wins and overridesSubscription is true (surprise-billing flag)", async () => {
    const s = await getAuthStatus({ ANTHROPIC_API_KEY: "sk-ant-x" }, tok("oauth-token"));
    expect(s.method).toBe("api-key");
    expect(s.overridesSubscription).toBe(true);
  });

  it("neither → method none", async () => {
    const s = await getAuthStatus({}, tok(null));
    expect(s.method).toBe("none");
    expect(s.overridesSubscription).toBe(false);
  });
});
