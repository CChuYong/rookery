import { beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../src/renderer/store/store.js";
import { emptyState } from "../src/renderer/store/reduce.js";

const row = (id: string) => ({
  id,
  label: id,
  repoPath: "/repo",
  status: "stopped",
  branch: `rookery/${id}`,
  model: null,
  permissionMode: "bypassPermissions",
});

describe("overlapping worker deletion reconciliation", () => {
  beforeEach(() => useStore.setState({ ...emptyState(), attention: {} }));

  it("never resurrects worker 1 when worker 2 finishes first", () => {
    const store = useStore.getState();
    store.setFleet([row("w1"), row("w2"), row("w3")]);
    store.beginWorkerDeletion("w1");
    store.beginWorkerDeletion("w2");

    // Delete 2 committed first; the server snapshot still contains delete 1's DB row.
    useStore.getState().setFleet([row("w1"), row("w3")]);
    expect(Object.keys(useStore.getState().fleet)).toEqual(["w3"]);

    // Delete 1's late terminal event must not recreate a fallback row or unread marker.
    useStore.getState().applyEvent({
      type: "worker.status", sessionId: "s1", workerId: "w1", status: "stopped",
    });
    expect(Object.keys(useStore.getState().fleet)).toEqual(["w3"]);
    expect(useStore.getState().attention.w1).toBeUndefined();

    useStore.getState().completeWorkerDeletion("w2");
    useStore.getState().completeWorkerDeletion("w1");
    useStore.getState().setFleet([row("w3")]);
    expect(Object.keys(useStore.getState().fleet)).toEqual(["w3"]);
  });

  it("clears a failed tombstone so the authoritative row can return", () => {
    useStore.getState().setFleet([row("w1")]);
    useStore.getState().beginWorkerDeletion("w1");
    useStore.getState().failWorkerDeletion("w1");
    useStore.getState().setFleet([row("w1")]);
    expect(useStore.getState().fleet.w1).toMatchObject({ id: "w1", label: "w1" });
  });
});
