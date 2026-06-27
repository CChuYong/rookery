import { describe, it, expect } from "vitest";
import { useStore } from "../src/renderer/store/store.js";

describe("store slack status", () => {
  it("applyEvent(slack.status) updates s.slack", () => {
    useStore.getState().applyEvent({ type: "slack.status", sessionId: "@all", status: "up" } as never);
    expect(useStore.getState().slack).toBe("up");
    useStore.getState().applyEvent({ type: "slack.status", sessionId: "@all", status: "off" } as never);
    expect(useStore.getState().slack).toBe("off");
  });
});
