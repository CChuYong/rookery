import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "../src/renderer/store/store.js";

describe("pushPending (pending message infra — dormant)", () => {
  beforeEach(() => {
    useStore.setState({ pendingBySession: {} });
  });

  it("pushPending appends to pendingBySession", () => {
    useStore.getState().pushPending("s1", { clientMsgId: "c1", text: "hi" });
    expect(useStore.getState().pendingBySession.s1).toEqual([{ clientMsgId: "c1", text: "hi" }]);
  });

  it("pushPending accumulates multiple items for the same session", () => {
    useStore.getState().pushPending("s1", { clientMsgId: "c1", text: "first" });
    useStore.getState().pushPending("s1", { clientMsgId: "c2", text: "second" });
    expect(useStore.getState().pendingBySession.s1).toEqual([
      { clientMsgId: "c1", text: "first" },
      { clientMsgId: "c2", text: "second" },
    ]);
  });

  it("pushPending keeps different sessions isolated", () => {
    useStore.getState().pushPending("s1", { clientMsgId: "c1", text: "hi" });
    useStore.getState().pushPending("s2", { clientMsgId: "c2", text: "there" });
    expect(useStore.getState().pendingBySession.s1).toHaveLength(1);
    expect(useStore.getState().pendingBySession.s2).toHaveLength(1);
  });

  it("master.message reconcile removes the matching pending item from the store", () => {
    useStore.getState().pushPending("s1", { clientMsgId: "c1", text: "q" });
    useStore.getState().pushPending("s1", { clientMsgId: "c2", text: "r" });
    useStore.getState().applyEvent({ type: "master.message", sessionId: "s1", role: "user", content: "q", clientMsgId: "c1" });
    expect(useStore.getState().pendingBySession.s1).toEqual([{ clientMsgId: "c2", text: "r" }]);
  });
});
