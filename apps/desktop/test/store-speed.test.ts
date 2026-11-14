import { beforeEach, expect, it } from "vitest";
import { emptyState, reduceEvent, seedSessionLog, applySubEvent } from "../src/renderer/store/reduce.js";
import { latestSpeedObservation, lastReportedSpeed, defaultSpeed } from "../src/renderer/lib/speed.js";
import { useStore } from "../src/renderer/store/store.js";

beforeEach(() => useStore.setState(emptyState()));
it("replays provider observations and cost quality after reconnect", () => {
  const observation = { requested: "fast", state: "unknown" } as const;
  const events = [{ payload: { type: "master.speed", sessionId: "s", observation } }, { payload: { type: "master.result", sessionId: "s", costUsd: 0, costAccuracy: "unavailable", requestedSpeed: "fast" } }];
  const log = seedSessionLog(undefined, "s", events);
  expect(latestSpeedObservation(log)).toBeUndefined();
  expect(lastReportedSpeed(log)).toEqual(observation);
  expect(log.at(-1)).toMatchObject({ costAccuracy: "unavailable", requestedSpeed: "fast" });
  expect(latestSpeedObservation(applySubEvent([], { kind: "speed", observation }))).toEqual(observation);
});
it("clears stale effective state at the next user-turn boundary", () => {
  const state = reduceEvent(emptyState(), { type: "master.speed", sessionId: "s", observation: { requested: "fast", state: "fast" } });
  const next = reduceEvent(state, { type: "master.message", sessionId: "s", role: "user", content: "next" });
  expect(latestSpeedObservation(next.logsBySession.s)).toBeUndefined();
});
it("restores nullable intent from authoritative rows and resolves four live defaults", () => {
  useStore.getState().setSessions([{ id: "s", cwd: "/", status: "idle", lastActivity: "", origin: "ui", speed: "fast" }]);
  expect(useStore.getState().sessions[0].speed).toBe("fast");
  const settings = { masterSpeed: "fast", workerSpeed: "standard", codexMasterSpeed: "standard", codexWorkerSpeed: "fast" } as const;
  expect(defaultSpeed(settings, "claude", "master")).toBe("fast");
  expect(defaultSpeed(settings, "claude", "worker")).toBe("standard");
  expect(defaultSpeed(settings, "codex", "master")).toBe("standard");
  expect(defaultSpeed(settings, "codex", "worker")).toBe("fast");
});

it("reconnect after changing configuration keeps old Fast only as historical detail", () => {
  useStore.getState().applyEvent({ type: "master.speed", sessionId: "s", observation: { requested: "fast", state: "fast" } });
  useStore.getState().invalidateSpeed("master", "s");
  expect(latestSpeedObservation(useStore.getState().logsBySession.s)).toBeUndefined();
  useStore.getState().seedHistory("s", [{ seq: 1, type: "master.speed", payload: { type: "master.speed", sessionId: "s", observation: { requested: "fast", state: "fast" } } }]);
  expect(latestSpeedObservation(useStore.getState().logsBySession.s)).toBeUndefined();
  expect(lastReportedSpeed(useStore.getState().logsBySession.s)?.state).toBe("fast");
});
