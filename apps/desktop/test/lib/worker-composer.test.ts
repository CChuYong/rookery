import { describe, it, expect } from "vitest";
import { workerComposerState } from "../../src/renderer/lib/worker-composer.js";
import { catalogs } from "../../src/renderer/i18n/catalog.js";

// The composer gate for a worker page. Worker.send() (src/core/worker.ts) accepts sends while running,
// background, AND idle — it rejects only terminal states — so the UI gate must match, or an actively
// working worker gets locked behind the "ended — view only" placeholder.
describe("workerComposerState", () => {
  it("keeps the composer open for every live state (running, background, idle)", () => {
    for (const s of ["running", "background", "idle"]) {
      expect(workerComposerState(s).disabled).toBe(false);
      expect(workerComposerState(s).controlsEditable).toBe(true);
    }
  });

  it("gives background its own placeholder instead of the ended/read-only line", () => {
    const bg = workerComposerState("background");
    expect(bg.placeholderKey).toBe("app.backgroundAddable");
    expect(bg.placeholderKey).not.toBe("app.agentEndedReadonly");
  });

  it("labels running and idle with their existing placeholders", () => {
    expect(workerComposerState("running").placeholderKey).toBe("app.busyAddable");
    expect(workerComposerState("idle").placeholderKey).toBe("app.instructWorker");
  });

  it("blocks input while the worktree is still being created", () => {
    const p = workerComposerState("provisioning");
    expect(p.disabled).toBe(true);
    expect(p.controlsEditable).toBe(false);
    expect(p.placeholderKey).toBe("app.creatingWorktree");
  });

  it("blocks input for terminal states, with the restart hint for orphaned", () => {
    expect(workerComposerState("orphaned")).toEqual({ disabled: true, controlsEditable: false, placeholderKey: "app.sessionEndedRestart" });
    for (const s of ["stopped", "done", "error", "failed"]) {
      expect(workerComposerState(s).disabled).toBe(true);
      expect(workerComposerState(s).placeholderKey).toBe("app.agentEndedReadonly");
    }
  });

  it("fails closed for an unknown state (never silently editable)", () => {
    expect(workerComposerState("bogus").disabled).toBe(true);
    expect(workerComposerState("bogus").controlsEditable).toBe(false);
  });

  it("every placeholder key it can return exists in both locale catalogs", () => {
    for (const s of ["running", "background", "idle", "provisioning", "orphaned", "stopped", "done", "error", "failed", "bogus"]) {
      const key = workerComposerState(s).placeholderKey;
      expect(catalogs.ko).toHaveProperty(key);
      expect(catalogs.en).toHaveProperty(key);
    }
  });
});
