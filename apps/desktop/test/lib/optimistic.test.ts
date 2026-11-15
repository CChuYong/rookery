import { describe, it, expect, beforeEach, vi } from "vitest";
import { useStore } from "../../src/renderer/store/store.js";
import type { FleetRow } from "../../src/renderer/store/reduce.js";
import { optimistic, patchSession, patchWorker } from "../../src/renderer/lib/optimistic.js";

// Pin/Archive used to wait for the round trip before the row moved (audit #56). These helpers flip the flag in the
// store first and put it back if the daemon rejects the request.
const session = (id: string, extra: Partial<{ pinned: boolean; archived: boolean }> = {}) => ({ id, cwd: "/x", status: "idle", lastActivity: "", origin: "ui", ...extra });
const deferred = () => {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe("optimistic session flags (audit #56)", () => {
  beforeEach(() => {
    useStore.setState({ sessions: [session("s1"), session("s2", { pinned: true })] });
  });

  it("applies the flag before the request settles and keeps it on success", async () => {
    const d = deferred();
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const done = optimistic(() => patchSession("s1", { pinned: true }), () => d.promise, { onSuccess, onError });
    expect(useStore.getState().sessions.find((x) => x.id === "s1")?.pinned).toBe(true); // moved immediately
    d.resolve();
    await done;
    expect(useStore.getState().sessions.find((x) => x.id === "s1")?.pinned).toBe(true);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("rolls back exactly the patched field when the request fails, and reports the error", async () => {
    const onError = vi.fn();
    const done = optimistic(() => patchSession("s2", { archived: true }), () => Promise.reject(new Error("boom")), { onError });
    expect(useStore.getState().sessions.find((x) => x.id === "s2")?.archived).toBe(true);
    await done;
    const s2 = useStore.getState().sessions.find((x) => x.id === "s2");
    expect(s2?.archived).toBeUndefined(); // back to its previous (absent) value
    expect(s2?.pinned).toBe(true); // untouched field survives the rollback
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it("is a no-op for an unknown session", async () => {
    const before = useStore.getState().sessions;
    await optimistic(() => patchSession("nope", { pinned: true }), () => Promise.reject(new Error("x")), { onError: () => {} });
    expect(useStore.getState().sessions).toEqual(before);
  });
});

describe("optimistic worker archive (audit #56)", () => {
  beforeEach(() => {
    useStore.setState({ fleet: { w1: { id: "w1", archived: false } as unknown as FleetRow } });
  });

  it("archives at once and restores on failure", async () => {
    const d = deferred();
    const onError = vi.fn();
    const done = optimistic(() => patchWorker("w1", { archived: true }), () => d.promise, { onError });
    expect(useStore.getState().fleet.w1?.archived).toBe(true);
    d.reject(new Error("nope"));
    await done;
    expect(useStore.getState().fleet.w1?.archived).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
