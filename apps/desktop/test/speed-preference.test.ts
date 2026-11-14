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

it.each(["master", "worker"] as const)("%s refresh preserves another target's pending intent and the next send's speed", async (kind) => {
  const { WsClient } = await import("../src/renderer/ws/client.js");
  const sessionRow = (id: string) => ({ ...session, id });
  const workerRow = (id: string) => ({ id, label: id, status: "idle", repoPath: "/", branch: id, model: "gpt-5.5", speed: "standard" as const });
  if (kind === "master") useStore.getState().setSessions([sessionRow("a"), sessionRow("b")]);
  else useStore.getState().setFleet([workerRow("a"), workerRow("b")]);
  const requests: Array<import("@daemon/protocol/messages.js").ClientMessage> = [];
  const socket: import("../src/renderer/ws/client.js").SocketLike = {
    send: (data) => { requests.push(JSON.parse(data)); }, close: vi.fn(), readyState: 1,
    onopen: null, onclose: null, onmessage: null,
  };
  const onEvent = vi.fn((event: import("@daemon/core/events.js").CoreEvent) => useStore.getState().applyEvent(event));
  const client = new WsClient(() => socket, onEvent);
  client.start();
  const reply = (index: number, message: Record<string, unknown>) => {
    const request = requests[index] as { reqId?: string };
    socket.onmessage!(JSON.stringify({ ...message, reqId: request.reqId }));
  };
  const writes = new Map<string, SpeedWriteState>();
  const a = persistSpeedPreference(client, kind, "a", "fast", writes);
  reply(0, { type: "fleet.ack" });
  await Promise.resolve(); // A's authoritative list response is now in flight.
  const b = persistSpeedPreference(client, kind, "b", "fast", writes);
  reply(1, kind === "master"
    ? { type: "session.list.result", sessions: [{ ...sessionRow("a"), speed: "fast" }, sessionRow("b")] }
    : { type: "fleet.list.result", fleet: [{ ...workerRow("a"), speed: "fast" }, workerRow("b")] });
  await a;
  // Capture speed exactly as App's send paths do, before B's own acknowledgement/refresh.
  const current = useStore.getState();
  const speed = kind === "master" ? current.sessions.find((row) => row.id === "b")?.speed : current.fleet.b.speed;
  if (kind === "master") client.send({ type: "session.send", sessionId: "b", text: "next", speed });
  else client.send({ type: "worker.send", id: "b", text: "next", speed });
  const sentSpeed = (requests[3] as { speed?: string }).speed;
  reply(2, { type: "fleet.ack" });
  await Promise.resolve();
  reply(4, kind === "master"
    ? { type: "session.list.result", sessions: ["a", "b"].map((id) => ({ ...sessionRow(id), speed: "fast" })) }
    : { type: "fleet.list.result", fleet: ["a", "b"].map((id) => ({ ...workerRow(id), speed: "fast" })) });
  await b;
  expect(speed).toBe("fast");
  expect(sentSpeed).toBe("fast");
  // Correlated list responses resolve only their caller; WsClient never treats them as global events.
  expect(onEvent).not.toHaveBeenCalled();
  client.stop();
});
