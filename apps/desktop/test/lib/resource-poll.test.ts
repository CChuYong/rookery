import { describe, it, expect, vi } from "vitest";
import { makeResourcePoll } from "../../src/renderer/lib/resource-poll.js";

// Final review #11: the monitor's Retry needs the poll's promise — pending while it runs, rejected when it fails —
// so LoadFailed can show progress and a second failure (audit #137).
describe("makeResourcePoll", () => {
  it("resolves with the snapshot applied and clears the failure flag", async () => {
    const snapshot = vi.fn();
    const failed = vi.fn();
    const poll = makeResourcePoll(async () => ({ cpuPct: 1 }) as never, { snapshot, failed });
    await expect(poll()).resolves.toBeUndefined();
    expect(snapshot).toHaveBeenCalledWith({ cpuPct: 1 });
    expect(failed).toHaveBeenCalledWith(false);
  });

  it("rejects on a failed read and flags the failure after three in a row", async () => {
    const failed = vi.fn();
    let ok = false;
    const poll = makeResourcePoll(async () => { if (!ok) throw new Error("Error invoking remote method 'resources:get'"); return {} as never; }, { snapshot: vi.fn(), failed });
    await expect(poll()).rejects.toThrow();
    await expect(poll()).rejects.toThrow();
    expect(failed).not.toHaveBeenCalledWith(true);
    // The rejection carries no IPC text: LoadFailed then reads just "Retry failed".
    await expect(poll()).rejects.toThrow(/^$/);
    expect(failed).toHaveBeenCalledWith(true);
    ok = true;
    await poll();
    expect(failed).toHaveBeenLastCalledWith(false);
  });
});
