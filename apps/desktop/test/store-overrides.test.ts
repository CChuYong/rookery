import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "../src/renderer/store/store.js";

describe("override management (DSK-7)", () => {
  beforeEach(() => {
    globalThis.localStorage?.clear();
    useStore.setState({ overrides: {}, sessions: [] });
  });

  it("prunes overrides for sessions that no longer exist", () => {
    const st = useStore.getState();
    st.setOverride("s1", { model: "m" });
    st.setOverride("s2", { effort: "high" });
    st.setSessions([{ id: "s1", cwd: "/x", status: "active", lastActivity: "", origin: "ui" }]);
    expect(useStore.getState().overrides).toEqual({ s1: { model: "m" } }); // s2 pruned
  });

  it("persists overrides to localStorage", () => {
    useStore.getState().setOverride("s9", { model: "x" });
    expect(JSON.parse(globalThis.localStorage.getItem("rookery:overrides")!)).toEqual({ s9: { model: "x" } });
  });
});

describe("seedRunningFromSessions", () => {
  beforeEach(() => {
    useStore.setState({ running: {} });
  });

  it("seeds running authoritatively from session.list (running→true, non-running→false)", () => {
    useStore.getState().seedRunningFromSessions([
      { id: "s1", status: "running" },
      { id: "s2", status: "idle" },
      { id: "s3", status: "running" },
    ]);
    const running = useStore.getState().running;
    expect(running["s1"]).toBe(true);
    expect(running["s3"]).toBe(true);
    expect(running["s2"]).toBe(false); // authoritative seed: non-running is explicitly set to false (to clear stale true)
  });

  it("preserves existing running entries (merges, not replaces)", () => {
    useStore.setState({ running: { s0: true } });
    useStore.getState().seedRunningFromSessions([{ id: "s1", status: "running" }]);
    const running = useStore.getState().running;
    expect(running["s0"]).toBe(true);
    expect(running["s1"]).toBe(true);
  });
});
