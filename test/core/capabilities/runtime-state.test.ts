import { describe, expect, it } from "vitest";
import { EventBus } from "../../../src/core/events.js";
import { CapabilityRuntimeState } from "../../../src/core/capabilities/runtime-state.js";

describe("CapabilityRuntimeState", () => {
  it("tracks master desired/applied transitions and emits only changed secret-free state", () => {
    const bus = new EventBus();
    const events: unknown[] = [];
    bus.subscribe("session-1", (event) => events.push(event));
    const state = new CapabilityRuntimeState(bus);
    const target = { targetKind: "master" as const, targetId: "session-1", sessionId: "session-1" };

    state.setDesired(target, "revision-a", false);
    state.setDesired(target, "revision-a", false);
    expect(state.inspect(target, "revision-a", false)).toEqual({
      desiredRevision: "revision-a",
      appliedRevision: null,
      state: "pending-next-turn",
    });

    state.setApplied(target, "revision-a");
    state.setApplied(target, "revision-a");
    expect(state.inspect(target, "revision-a", false)).toEqual({
      desiredRevision: "revision-a",
      appliedRevision: "revision-a",
      state: "current",
    });
    expect(events).toEqual([
      {
        type: "capabilities.runtime",
        sessionId: "session-1",
        targetKind: "master",
        targetId: "session-1",
        desiredRevision: "revision-a",
        appliedRevision: null,
        state: "pending-next-turn",
      },
      {
        type: "capabilities.runtime",
        sessionId: "session-1",
        targetKind: "master",
        targetId: "session-1",
        desiredRevision: "revision-a",
        appliedRevision: "revision-a",
        state: "current",
      },
    ]);
  });

  it("reports worker drift, blocking, and sanitized errors without replacing the applied revision", () => {
    const state = new CapabilityRuntimeState(new EventBus());
    const target = { targetKind: "worker" as const, targetId: "worker-1", sessionId: "home-1" };

    state.setDesired(target, "revision-a", false);
    state.setApplied(target, "revision-a");
    state.setDesired(target, "revision-b", false);
    expect(state.inspect(target, "revision-b", false)).toEqual({
      desiredRevision: "revision-b",
      appliedRevision: "revision-a",
      state: "pending-reload",
    });

    state.setDesired(target, "revision-b", true);
    expect(state.inspect(target, "revision-b", true)).toEqual({
      desiredRevision: "revision-b",
      appliedRevision: "revision-a",
      state: "blocked",
    });

    state.setError(target, "revision-b", "runtime materialization failed");
    expect(state.inspect(target, "revision-b", false)).toEqual({
      desiredRevision: "revision-b",
      appliedRevision: "revision-a",
      state: "error",
      error: "runtime materialization failed",
    });
  });

  it("derives drift from the requested revision even before a desired event is recorded", () => {
    const state = new CapabilityRuntimeState(new EventBus());
    const target = { targetKind: "worker" as const, targetId: "worker-1", sessionId: "home-1" };

    expect(state.inspect(target, "revision-a", false)).toEqual({
      desiredRevision: "revision-a",
      appliedRevision: null,
      state: "pending-reload",
    });
  });
});
