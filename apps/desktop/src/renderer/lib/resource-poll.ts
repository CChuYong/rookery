import type { ResourceSnapshot } from "../types/rookery.js";

// One resources.get read for the status-bar monitor (audit #137). Consecutive failures past `threshold` flag the
// monitor as failed (its popover then shows a failure + Retry instead of a skeleton forever); any success clears it.
// The returned promise follows the read (final review #11) so the Retry can show progress and a second failure. It
// rejects with an empty message: the raw IPC text means nothing to the user, and LoadFailed then reads "Retry failed".
export function makeResourcePoll(
  get: () => Promise<ResourceSnapshot>,
  on: { snapshot: (r: ResourceSnapshot) => void; failed: (failed: boolean) => void },
  threshold = 3,
): () => Promise<void> {
  let fails = 0;
  return () => get().then(
    (r) => { fails = 0; on.failed(false); on.snapshot(r); },
    () => { fails += 1; if (fails >= threshold) on.failed(true); throw new Error(""); },
  );
}
