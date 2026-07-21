// Composer gate for a worker page: may the user type, may they change model/permission mode, and what does
// the placeholder say. Extracted from App.tsx, where the identical chain was duplicated across the dockable
// and static render paths — that duplicate is why `background` was missed in both at once.
//
// Liveness mirrors the daemon: Worker.send() (src/core/worker.ts) accepts sends while running, background,
// or idle and rejects only terminal states, so `background` must stay writable here. A message sent to a
// busy worker is queued and released at the next turn boundary, which is what the running/background
// placeholders promise.
export interface WorkerComposerState {
  disabled: boolean;
  controlsEditable: boolean;
  placeholderKey: string;
}

const PLACEHOLDER_KEY: Record<string, string> = {
  running: "app.busyAddable",
  background: "app.backgroundAddable",
  idle: "app.instructWorker",
  provisioning: "app.creatingWorktree",
  orphaned: "app.sessionEndedRestart",
};

// Live = the daemon will accept a send. Unknown states fall through to read-only (fail closed).
const LIVE = new Set(["running", "background", "idle"]);

export function workerComposerState(status: string): WorkerComposerState {
  const live = LIVE.has(status);
  return {
    disabled: !live,
    controlsEditable: live,
    placeholderKey: PLACEHOLDER_KEY[status] ?? "app.agentEndedReadonly",
  };
}
