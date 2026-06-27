import { describe, it, expect } from "vitest";
import { EventBus } from "../../src/core/events.js";
import type { CoreEvent } from "../../src/core/events.js";

describe("EventBus", () => {
  it("delivers events only to subscribers of the same session", () => {
    const bus = new EventBus();
    const a: CoreEvent[] = [];
    const b: CoreEvent[] = [];
    bus.subscribe("s1", (e) => a.push(e));
    bus.subscribe("s2", (e) => b.push(e));

    bus.emit({ type: "master.message", sessionId: "s1", role: "assistant", content: "hi" });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });

  it("stops delivering after unsubscribe", () => {
    const bus = new EventBus();
    const received: CoreEvent[] = [];
    const off = bus.subscribe("s1", (e) => received.push(e));
    off();
    bus.emit({ type: "error", sessionId: "s1", message: "boom" });
    expect(received).toHaveLength(0);
  });

  it("supports multiple listeners on one session", () => {
    const bus = new EventBus();
    let count = 0;
    bus.subscribe("s1", () => count++);
    bus.subscribe("s1", () => count++);
    bus.emit({ type: "master.system", sessionId: "s1", text: "init" });
    expect(count).toBe(2);
  });
});

describe("EventBus @fleet mirror", () => {
  it("delivers worker.* events to both home session and @fleet", () => {
    const bus = new EventBus();
    const home: string[] = [];
    const fleet: string[] = [];
    bus.subscribe("s1", (e) => home.push(e.type));
    bus.subscribe("@fleet", (e) => fleet.push(e.type));
    bus.emit({ type: "worker.status", sessionId: "s1", workerId: "a1", status: "done" });
    bus.emit({ type: "master.message", sessionId: "s1", role: "assistant", content: "hi" } as CoreEvent);
    expect(home).toEqual(["worker.status", "master.message"]);
    expect(fleet).toEqual(["worker.status"]); // non-worker events are not sent to @fleet
  });

  it("does not double-deliver when a listener is only on @fleet", () => {
    const bus = new EventBus();
    const fleet: string[] = [];
    bus.subscribe("@fleet", (e) => fleet.push(e.workerId ?? ""));
    bus.emit({ type: "worker.spawned", sessionId: "s1", workerId: "a1", repoPath: "/r", label: "x" });
    expect(fleet).toEqual(["a1"]);
  });

  it("delivers every event to @all; worker.* also to @fleet", () => {
    const bus = new EventBus();
    const all: string[] = [];
    const fleet: string[] = [];
    bus.subscribe("@all", (e) => all.push(e.type));
    bus.subscribe("@fleet", (e) => fleet.push(e.type));
    bus.emit({ type: "master.message", sessionId: "s1", role: "assistant", content: "x" } as CoreEvent);
    bus.emit({ type: "worker.status", sessionId: "s1", workerId: "a", status: "running" });
    expect(all).toEqual(["master.message", "worker.status"]);
    expect(fleet).toEqual(["worker.status"]);
  });
});

describe("EventBus listener error isolation", () => {
  it("a throwing listener on one channel does not prevent a healthy listener on another channel from being called", () => {
    const bus = new EventBus();
    const received: string[] = [];
    // throwing listener on session channel
    bus.subscribe("s1", () => { throw new Error("boom"); });
    // healthy listener on @all channel
    bus.subscribe("@all", (e) => received.push(e.type));
    // emit should not throw
    expect(() => bus.emit({ type: "worker.status", sessionId: "s1", workerId: "w1", status: "running" })).not.toThrow();
    // healthy listener on @all must still be called
    expect(received).toEqual(["worker.status"]);
  });

  it("console.error is called once per throwing listener (WeakSet dedupe) across multiple emits", () => {
    const bus = new EventBus();
    const errors: unknown[] = [];
    const origError = console.error.bind(console);
    console.error = (...args: unknown[]) => errors.push(args[0]);
    try {
      const throwingListener = () => { throw new Error("listener error"); };
      bus.subscribe("s2", throwingListener);
      // emit 3 times with the same throwing listener
      bus.emit({ type: "master.system", sessionId: "s2", text: "a" });
      bus.emit({ type: "master.system", sessionId: "s2", text: "b" });
      bus.emit({ type: "master.system", sessionId: "s2", text: "c" });
      // console.error must be called exactly once (first occurrence), not 3 times
      expect(errors).toHaveLength(1);
    } finally {
      console.error = origError;
    }
  });

  it("emit itself does not throw even when all listeners throw", () => {
    const bus = new EventBus();
    bus.subscribe("s3", () => { throw new Error("throw1"); });
    bus.subscribe("s3", () => { throw new Error("throw2"); });
    expect(() => bus.emit({ type: "master.system", sessionId: "s3", text: "x" })).not.toThrow();
  });

  it("a throwing listener is NOT unsubscribed — it keeps being called (but only logged once)", () => {
    const bus = new EventBus();
    let callCount = 0;
    const throwingListener = () => { callCount++; throw new Error("err"); };
    bus.subscribe("s4", throwingListener);
    // suppress console.error
    const origError = console.error.bind(console);
    console.error = () => {};
    try {
      bus.emit({ type: "master.system", sessionId: "s4", text: "1" });
      bus.emit({ type: "master.system", sessionId: "s4", text: "2" });
      // called both times (not unsubscribed)
      expect(callCount).toBe(2);
    } finally {
      console.error = origError;
    }
  });
});
