import { useEffect, useState } from "react";
import { isTerminalStatus } from "./status.js";

export type WorkRootState = "locating" | "ready" | "missing";

// Resolves a page's on-disk work root (worker worktree > session cwd > home) via the shared IPC resolver, retrying
// while a freshly spawned worker's worktree is still being created (`git worktree add` runs asynchronously right
// after fleet.spawn — viewing a just-created worker immediately, the resolver falls back to ~ until the worktree
// appears, so we retry until the resolved path ends with subId).
//
// Previously this retried 300ms x 15 and then just silently stayed on "locating" forever, with the same dead end
// reached instantly for an orphaned worker (its worktree already gone, so resolveWorkRoot's ~ fallback never ends
// with subId) — the Files/Git panels sat on a static placeholder with no spinner, no error, and no way out
// (audit #2).
//
// A terminal fleet status does NOT mean the worktree is gone: only discard_worker removes it — stopped/done/error/
// orphaned usually still have one (that's the whole point of the terminal state: review the diff, then decide).
// So a terminal status gets exactly ONE resolveRoot attempt (no 15x retry loop — the worktree either exists right
// now or it never will) and lands on `ready`/`missing` from that single answer. Non-terminal workers keep the
// retry loop; exhausting it without a terminal status also lands on `missing` instead of looping silently. And a
// worker that goes terminal mid-view (e.g. you stop the worker you're currently watching) must not blank an
// already-`ready` panel — re-verifying a still-live resolved root is pointless, so that case is left untouched.
export function useWorkRoot(opts: { enabled: boolean; subId?: string; cwd?: string; status?: string }): { root: string | null; state: WorkRootState } {
  const { enabled, subId, cwd, status } = opts;
  const [root, setRoot] = useState<string | null>(null);
  const [state, setState] = useState<WorkRootState>("locating");
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;

    if (subId && status && isTerminalStatus(status)) {
      // Already showing a resolved worktree for this worker when it went terminal — keep the live panel as is.
      if (state === "ready" && root && root.endsWith(subId)) return;
      void window.rookery.ws.resolveRoot({ subId, cwd }).then((r) => {
        if (!live) return;
        setRoot(r);
        setState(r.endsWith(subId) ? "ready" : "missing");
      }).catch(() => { /* ignore — a transient resolve failure just leaves the previous state in place */ });
      return () => { live = false; };
    }

    setState("locating");
    const tick = (): void => {
      void window.rookery.ws.resolveRoot({ subId, cwd }).then((r) => {
        if (!live) return;
        setRoot(r);
        if (!subId || r.endsWith(subId)) { setState("ready"); return; }
        if (tries < 15) { tries += 1; timer = setTimeout(tick, 300); }
        else setState("missing");
      }).catch(() => { /* ignore — a transient resolve failure just leaves the previous state in place */ });
    };
    tick();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [enabled, subId, cwd, status]);
  return { root, state };
}
