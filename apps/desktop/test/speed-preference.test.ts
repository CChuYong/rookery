import { beforeEach, expect, it, vi } from "vitest";
import { persistSpeedPreference, type SpeedWriteState } from "../src/renderer/lib/speed-preference.js";
import { useStore } from "../src/renderer/store/store.js";
import { emptyState } from "../src/renderer/store/reduce.js";
import { latestSpeedObservation } from "../src/renderer/lib/speed.js";

const session = { id: "s", cwd: "/", status: "idle", lastActivity: "", origin: "ui", speed: "standard" as const };
beforeEach(() => {
  useStore.setState({ ...emptyState(), sessions: [session] });
  useStore.getState().applyEvent({ type: "master.speed", sessionId: "s", observation: { requested: "standard", state: "standard" } });
});
it("acknowledges a preference-only request and restores authoritative rows", async () => {
  const request = vi.fn().mockResolvedValueOnce({ type: "fleet.ack" }).mockResolvedValueOnce({ sessions: [{ ...session, speed: "fast" }] });
  const pending = persistSpeedPreference({ request }, "master", "s", "fast", new Map());
  expect(useStore.getState().sessions[0].speed).toBe("fast");
  expect(latestSpeedObservation(useStore.getState().logsBySession.s)).toBeUndefined();
  await pending;
  expect(request.mock.calls).toEqual([[{ type: "session.setSpeed", sessionId: "s", speed: "fast" }], [{ type: "session.list" }]]);
  expect(useStore.getState().sessions[0].speed).toBe("fast");
});
it("rejection rolls back the selected intent without certifying stale effective state", async () => {
  const request = vi.fn().mockRejectedValue(new Error("rejected"));
  await expect(persistSpeedPreference({ request }, "master", "s", "fast", new Map())).rejects.toThrow("rejected");
  expect(useStore.getState().sessions[0].speed).toBe("standard");
  expect(latestSpeedObservation(useStore.getState().logsBySession.s)).toBeUndefined();
});
it("a stale failed request cannot overwrite a later accepted selection", async () => {
  let rejectFirst!: (reason: Error) => void;
  const request = vi.fn()
    .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }))
    .mockResolvedValueOnce({ type: "fleet.ack" })
    .mockResolvedValueOnce({ sessions: [{ ...session, speed: null }] });
  const versions = new Map<string, SpeedWriteState>();
  const first = persistSpeedPreference({ request }, "master", "s", "fast", versions).catch(() => {});
  await persistSpeedPreference({ request }, "master", "s", null, versions);
  rejectFirst(new Error("old rejection"));
  await first;
  expect(useStore.getState().sessions[0].speed).toBeNull();
});
it("worker preference rejection restores the worker row", async () => {
  useStore.getState().setFleet([{ id: "w", label: "work", status: "idle", repoPath: "/", branch: "work", model: "gpt-5.5", speed: "fast" }]);
  const request = vi.fn().mockRejectedValue(new Error("rejected"));
  await expect(persistSpeedPreference({ request }, "worker", "w", "standard", new Map())).rejects.toThrow();
  expect(useStore.getState().fleet.w.speed).toBe("fast");
});

it("an acknowledged preference survives a failed row refresh", async () => {
  const request = vi.fn().mockResolvedValueOnce({ type: "fleet.ack" }).mockRejectedValueOnce(new Error("refresh disconnected"));
  await expect(persistSpeedPreference({ request }, "master", "s", "fast", new Map())).rejects.toThrow("refresh disconnected");
  expect(useStore.getState().sessions[0].speed).toBe("fast");
});
it("two rejected rapid changes restore the original persisted intent", async () => {
  const request = vi.fn().mockRejectedValue(new Error("offline"));
  const writes = new Map<string, SpeedWriteState>();
  await Promise.allSettled([
    persistSpeedPreference({ request }, "master", "s", "fast", writes),
    persistSpeedPreference({ request }, "master", "s", null, writes),
  ]);
  expect(useStore.getState().sessions[0].speed).toBe("standard");
});
