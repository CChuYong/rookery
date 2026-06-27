import { describe, it, expect } from "vitest";
import { repliesToThreadMsgs } from "../../src/slack/thread-reader.js";

describe("repliesToThreadMsgs", () => {
  it("maps Slack replies to ThreadMsg (user/text/ts) and flags bot messages by bot_id", () => {
    const out = repliesToThreadMsgs([
      { user: "U1", text: "배포 실패", ts: "1.0" },
      { bot_id: "B1", text: "원인 찾을게요", ts: "2.0" },
    ]);
    expect(out).toEqual([
      { user: "U1", text: "배포 실패", isBot: false, ts: "1.0" },
      { user: "B1", text: "원인 찾을게요", isBot: true, ts: "2.0" },
    ]);
  });

  it("tolerates missing fields", () => {
    const out = repliesToThreadMsgs([{ ts: "3.0" }]);
    expect(out[0]).toMatchObject({ text: "", isBot: false, ts: "3.0" });
    expect(typeof out[0]!.user).toBe("string");
  });
});
