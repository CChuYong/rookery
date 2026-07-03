import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "../src/renderer/store/store.js";

const SID = "s1";
const card = (rid: string) => ({ type: "interaction.request", sessionId: SID, requestId: rid, kind: "approve", toolName: "t", inputText: "{}" }) as never;
const turn = [{ seq: 0, type: "master.message", payload: { type: "master.message", sessionId: SID, role: "user", content: "hi" } }];

describe("liveInteractionIds reconnect reconciliation", () => {
  beforeEach(() => {
    useStore.setState({ logsBySession: {}, liveInteractionIds: new Set<string>() });
  });

  it("daemon restart: card announced before the reset is expired by the seed", () => {
    useStore.getState().applyEvent(card("R1")); // card arrives live
    useStore.getState().resetLiveInteractions(); // ws reconnect to a fresh daemon — nothing replayed
    useStore.getState().seedHistory(SID, turn);
    const item = useStore.getState().logsBySession[SID]!.find((i) => i.kind === "interaction");
    expect(item).toMatchObject({ requestId: "R1", resolved: true, expired: true });
  });

  it("normal reconnect: replayed card is re-announced and stays actionable through the seed", () => {
    useStore.getState().applyEvent(card("R1"));
    useStore.getState().resetLiveInteractions();
    useStore.getState().applyEvent(card("R1")); // the daemon's events.subscribe replay (deduped by the reducer)
    useStore.getState().seedHistory(SID, turn);
    const item = useStore.getState().logsBySession[SID]!.find((i) => i.kind === "interaction");
    expect(item).toMatchObject({ requestId: "R1", resolved: false });
  });
});
