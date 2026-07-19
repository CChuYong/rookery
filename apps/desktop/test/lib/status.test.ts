import { describe, it, expect } from "vitest";
import { statusLabelKey, isLive } from "../../src/renderer/lib/status.js";
import { catalogs } from "../../src/renderer/i18n/catalog.js";

// The worker state union (src/core, mirrored in the renderer) plus the DB-only "provisioning" state.
const STATES = ["running", "idle", "stopped", "done", "error", "failed", "orphaned", "provisioning"] as const;

describe("statusLabelKey (audit #50)", () => {
  it("maps each worker state to its status.* display-label key", () => {
    for (const s of STATES) expect(statusLabelKey(s)).toBe(`status.${s}`);
  });

  it("every state resolves to a real, translated key in both locale catalogs (no raw token ever reaches the UI)", () => {
    for (const s of STATES) {
      const key = statusLabelKey(s);
      expect(catalogs.ko).toHaveProperty(key);
      expect(catalogs.en).toHaveProperty(key);
      // The label must be an actual word, not an echo of the raw machine token (parity with audit #33's "xhigh" leak fix).
      expect(catalogs.ko[key as keyof typeof catalogs.ko]).not.toBe(s);
      expect(catalogs.en[key as keyof typeof catalogs.en]).not.toBe(s);
    }
  });

  it("falls back to a status.<raw> key for an unrecognized state (never throws)", () => {
    expect(statusLabelKey("bogus")).toBe("status.bogus");
  });
});

// background = the turn ended but harness-tracked background tasks (bg shells, Dynamic Workflow runs) still run.
// The SDK auto-wakes the worker when they settle, so it is working — it must carry running's live signature.
describe("isLive (worker-state-graph: background is live)", () => {
  it("treats running and background as live", () => {
    expect(isLive("running")).toBe(true);
    expect(isLive("background")).toBe(true);
  });

  it("does not treat settled or terminal states as live", () => {
    for (const s of ["idle", "stopped", "done", "error", "failed", "orphaned", "provisioning"]) {
      expect(isLive(s)).toBe(false);
    }
  });
});
