import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "../src/renderer/store/store.js";

describe("pushPending (pending message infra — dormant)", () => {
  beforeEach(() => {
    // Reset connectionEpoch too: pushPending stamps the current epoch (0), so these expectations carry epoch: 0.
    useStore.setState({ pendingBySession: {}, connectionEpoch: 0 });
  });

  it("pushPending appends to pendingBySession", () => {
    useStore.getState().pushPending("s1", { clientMsgId: "c1", text: "hi" });
    expect(useStore.getState().pendingBySession.s1).toEqual([{ clientMsgId: "c1", text: "hi", epoch: 0 }]);
  });

  it("pushPending accumulates multiple items for the same session", () => {
    useStore.getState().pushPending("s1", { clientMsgId: "c1", text: "first" });
    useStore.getState().pushPending("s1", { clientMsgId: "c2", text: "second" });
    expect(useStore.getState().pendingBySession.s1).toEqual([
      { clientMsgId: "c1", text: "first", epoch: 0 },
      { clientMsgId: "c2", text: "second", epoch: 0 },
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
    expect(useStore.getState().pendingBySession.s1).toEqual([{ clientMsgId: "c2", text: "r", epoch: 0 }]);
  });
});

describe("pendingBySession fallback reconciliation (audit #17)", () => {
  const SID = "s1";
  const echoEvent = (cid: string) => ({ seq: 0, type: "master.message", payload: { type: "master.message", sessionId: SID, role: "user", content: "hi", clientMsgId: cid } });

  beforeEach(() => { useStore.setState({ pendingBySession: {}, logsBySession: {}, connectionEpoch: 0 }); });

  it("seed drops a pending entry whose echo is already committed (lost live echo)", () => {
    useStore.getState().pushPending(SID, { clientMsgId: "c1", text: "hi" });
    useStore.getState().bumpConnectionEpoch(); // reconnect
    useStore.getState().seedHistory(SID, [echoEvent("c1")]);
    expect(useStore.getState().pendingBySession[SID] ?? []).toEqual([]);
  });

  it("seed drops pre-reconnect entries with no committed echo (queued turn lost to a restart)", () => {
    useStore.getState().pushPending(SID, { clientMsgId: "c1", text: "hi" });
    useStore.getState().bumpConnectionEpoch();
    useStore.getState().seedHistory(SID, []); // fresh daemon: nothing persisted
    expect(useStore.getState().pendingBySession[SID] ?? []).toEqual([]);
  });

  it("seed KEEPS a current-epoch entry still awaiting its echo", () => {
    useStore.getState().pushPending(SID, { clientMsgId: "c1", text: "hi" });
    useStore.getState().seedHistory(SID, []); // e.g. session select — same connection
    expect(useStore.getState().pendingBySession[SID]).toHaveLength(1);
  });
});

describe("pendingByWorker (optimistic worker bubbles)", () => {
  beforeEach(() => {
    useStore.setState({ pendingByWorker: {} });
  });

  it("dropWorkerPending removes exactly the rolled-back bubble", () => {
    useStore.getState().pushWorkerPending("w1", { clientMsgId: "c1", text: "a" });
    useStore.getState().pushWorkerPending("w1", { clientMsgId: "c2", text: "b" });
    useStore.getState().dropWorkerPending("w1", "c1");
    expect(useStore.getState().pendingByWorker["w1"]).toEqual([{ clientMsgId: "c2", text: "b" }]);
  });
});
