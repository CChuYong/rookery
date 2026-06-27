import { describe, it, expect } from "vitest";
import { extractSlackText, isTriggerableMessage } from "../../src/slack/message-text.js";

describe("isTriggerableMessage", () => {
  it("plain user message → true", () => {
    expect(isTriggerableMessage({ text: "hi", user: "U1" }, "B_SELF")).toBe(true);
  });
  it("our own bot message → false (feedback loop guard)", () => {
    expect(isTriggerableMessage({ bot_id: "B_SELF", subtype: "bot_message", text: "x" }, "B_SELF")).toBe(false);
  });
  it("another bot's message (bot_message subtype) → true", () => {
    expect(isTriggerableMessage({ bot_id: "B_OTHER", subtype: "bot_message", text: "deploy failed" }, "B_SELF")).toBe(true);
  });
  it("another bot without subtype → true", () => {
    expect(isTriggerableMessage({ bot_id: "B_OTHER", text: "x" }, "B_SELF")).toBe(true);
  });
  it("edit/delete/join subtypes → false", () => {
    expect(isTriggerableMessage({ subtype: "message_changed", text: "x" }, "B_SELF")).toBe(false);
    expect(isTriggerableMessage({ subtype: "message_deleted" }, "B_SELF")).toBe(false);
    expect(isTriggerableMessage({ subtype: "channel_join", text: "x" }, "B_SELF")).toBe(false);
  });
  it("unknown selfBotId → still allows other bots (best-effort)", () => {
    expect(isTriggerableMessage({ bot_id: "B_OTHER", text: "x" }, undefined)).toBe(true);
  });
});

describe("extractSlackText", () => {
  it("plain text", () => {
    expect(extractSlackText({ text: "hello world" })).toBe("hello world");
  });
  it("section + header Block Kit", () => {
    const m = { blocks: [
      { type: "header", text: { type: "plain_text", text: "Deploy Failed" } },
      { type: "section", text: { type: "mrkdwn", text: "service *app-api* in prod" } },
    ] };
    expect(extractSlackText(m)).toBe("Deploy Failed\nservice *app-api* in prod");
  });
  it("section fields", () => {
    const m = { blocks: [{ type: "section", fields: [
      { type: "mrkdwn", text: "*Env:* prod" },
      { type: "mrkdwn", text: "*Status:* down" },
    ] }] };
    expect(extractSlackText(m)).toBe("*Env:* prod\n*Status:* down");
  });
  it("rich_text run with text + emoji + bare link (when no top-level text)", () => {
    const m = { blocks: [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [
      { type: "text", text: "alert" },
      { type: "emoji", name: "fire" },
      { type: "link", url: "https://x.io/run/9" },
    ] }] }] };
    expect(extractSlackText(m)).toBe("alert\n:fire:\nhttps://x.io/run/9");
  });
  it("rich_text is skipped when m.text mirrors it (no human-message duplication)", () => {
    const m = { text: "hello there", blocks: [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [
      { type: "text", text: "hello there" },
    ] }] }] };
    expect(extractSlackText(m)).toBe("hello there");
  });
  it("legacy attachment title + text", () => {
    expect(extractSlackText({ attachments: [{ title: "Build #42", text: "failed on step lint" }] }))
      .toBe("Build #42\nfailed on step lint");
  });
  it("attachment uses fallback ONLY when nothing else present", () => {
    expect(extractSlackText({ attachments: [{ fallback: "summary line" }] })).toBe("summary line");
    expect(extractSlackText({ attachments: [{ text: "real", fallback: "real summary" }] })).toBe("real");
  });
  it("dedupes a line duplicated across text and a block", () => {
    const m = { text: "Deploy Failed", blocks: [{ type: "section", text: { type: "mrkdwn", text: "Deploy Failed" } }] };
    expect(extractSlackText(m)).toBe("Deploy Failed");
  });
  it("empty when nothing extractable", () => {
    expect(extractSlackText({ blocks: [{ type: "divider" }] })).toBe("");
    expect(extractSlackText({})).toBe("");
  });
  it("combines text + section block + attachment", () => {
    const m = {
      text: "notif",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "body" } }],
      attachments: [{ text: "extra" }],
    };
    expect(extractSlackText(m)).toBe("notif\nbody\nextra");
  });
});
