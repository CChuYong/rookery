import { describe, it, expect, vi } from "vitest";
import { redactOnReaction, REDACT_REACTION, redactedMarker } from "../../src/slack/redaction.js";
import type { RedactReactionArgs, RedactDeps } from "../../src/slack/redaction.js";

const BOT = "UBOT";
const MARKER = redactedMarker("ko");

function setup(
  cfg: { allowedUsers?: string[]; allowAll?: boolean } = {},
  updateImpl?: (a: { channel: string; ts: string; text: string; blocks: unknown[] }) => Promise<unknown>,
) {
  const calls: Array<{ channel: string; ts: string; text: string; blocks: unknown[] }> = [];
  const update = vi.fn(async (a: { channel: string; ts: string; text: string; blocks: unknown[] }) => {
    calls.push(a);
    if (updateImpl) return updateImpl(a);
    return {};
  });
  const deps: RedactDeps = {
    slackConfig: () => ({ allowedUsers: cfg.allowedUsers ?? [], allowAll: cfg.allowAll ?? false }),
    locale: () => "ko",
    update,
  };
  return { deps, update, calls };
}

const baseArgs = (over: Partial<RedactReactionArgs> = {}): RedactReactionArgs => ({
  reaction: REDACT_REACTION,
  channel: "C1",
  ts: "1700000000.000100",
  itemUser: BOT,
  reactingUser: "Ualice",
  botUserId: BOT,
  ...over,
});

describe("redactOnReaction", () => {
  it("redacts a bot message when an allowlisted user reacts with :x:", async () => {
    const { deps, update, calls } = setup({ allowedUsers: ["Ualice"] });
    await redactOnReaction(baseArgs(), deps);
    expect(update).toHaveBeenCalledTimes(1);
    expect(calls[0].channel).toBe("C1");
    expect(calls[0].ts).toBe("1700000000.000100");
    expect(calls[0].text).toBe(MARKER);
    // verify the body blocks were also replaced with the marker (so the original plan card/metrics disappear)
    expect(JSON.stringify(calls[0].blocks)).toContain(MARKER);
  });

  it("redactedMarker localizes by locale", () => {
    expect(redactedMarker("en")).toBe("🗑️ _[redacted]_");
    expect(redactedMarker("ko")).toBe("🗑️ _[삭제됨]_");
  });

  it("allows any user when allowAll is on", async () => {
    const { deps, update } = setup({ allowAll: true });
    await redactOnReaction(baseArgs({ reactingUser: "Ustranger" }), deps);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("ignores reactions from users not on the allowlist", async () => {
    const { deps, update } = setup({ allowedUsers: ["Ualice"] });
    await redactOnReaction(baseArgs({ reactingUser: "Ustranger" }), deps);
    expect(update).not.toHaveBeenCalled();
  });

  it("ignores non-:x: reactions", async () => {
    const { deps, update } = setup({ allowedUsers: ["Ualice"] });
    await redactOnReaction(baseArgs({ reaction: "thumbsup" }), deps);
    expect(update).not.toHaveBeenCalled();
  });

  it("ignores reactions on messages the bot did not author", async () => {
    const { deps, update } = setup({ allowedUsers: ["Ualice"] });
    await redactOnReaction(baseArgs({ itemUser: "Usomeone" }), deps);
    expect(update).not.toHaveBeenCalled();
  });

  it("ignores when botUserId is unknown", async () => {
    const { deps, update } = setup({ allowedUsers: ["Ualice"] });
    await redactOnReaction(baseArgs({ botUserId: undefined, itemUser: undefined }), deps);
    expect(update).not.toHaveBeenCalled();
  });

  it("swallows update failures (best-effort) without throwing", async () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { deps } = setup({ allowedUsers: ["Ualice"] }, async () => {
      throw new Error("message_not_found");
    });
    await expect(redactOnReaction(baseArgs(), deps)).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
