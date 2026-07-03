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
// (audit #2). Now: a terminal fleet status (stopped/done/error/failed/orphaned) short-circuits to `missing`
// immediately (no point waiting out 15 retries when the status already says the worktree is gone), and exhausting
// the retries without a terminal status also lands on `missing` instead of looping silently.
export function useWorkRoot(opts: { enabled: boolean; subId?: string; cwd?: string; status?: string }): { root: string | null; state: WorkRootState } {
  const { enabled, subId, cwd, status } = opts;
  const [root, setRoot] = useState<string | null>(null);
  const [state, setState] = useState<WorkRootState>("locating");
  useEffect(() => {
    if (!enabled) return;
    if (subId && status && isTerminalStatus(status)) { setRoot(null); setState("missing"); return; }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
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
