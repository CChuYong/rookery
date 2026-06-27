// Visual channels for worker/session status, all in one place. rail = left color rail (result status — replaces the color role of the dot),
// tag = colorblind-safe mono text (run/pr/fail are a red-green confusion trio, so a text channel is needed).
// The dot (led-live) is split out for 'alive' (running) only, to strengthen the signature.
const RAIL: Record<string, string> = {
  provisioning: "bg-accent", running: "bg-run", idle: "bg-muted", failed: "bg-fail", error: "bg-fail",
  stopped: "bg-stop", orphaned: "bg-nochg", done: "bg-pr",
};
const TAG: Record<string, string> = {
  provisioning: "PREP", running: "RUN", idle: "IDLE", failed: "ERR", error: "ERR",
  stopped: "STOP", orphaned: "ORPH", done: "DONE",
};
// Full chip tone (border/bg/text) for the StatusBadge — kept here so status→color lives in one file (dot = railClass + led-live).
const TONE: Record<string, string> = {
  running: "text-run bg-run/12 border-run/25",
  idle: "text-fg-dim bg-raised border-line",
  failed: "text-fail bg-fail/12 border-fail/25",
  error: "text-fail bg-fail/12 border-fail/25",
  stopped: "text-stop bg-stop/15 border-stop/30",
  done: "text-pr bg-pr/12 border-pr/25",
  // A rehydrated agent whose live session was lost on restart — only diff/discard work (send/await unavailable).
  orphaned: "text-nochg bg-nochg/12 border-nochg/25",
  // Worktree still being created (spawn in flight) — coral to signal "the system is working on it".
  provisioning: "text-accent bg-accent/12 border-accent/25",
};
export const railClass = (s: string): string => RAIL[s] ?? "bg-stop";
export const toneClass = (s: string): string => TONE[s] ?? "text-muted bg-raised border-line";
export const statusTag = (s: string): string => TAG[s] ?? s.slice(0, 5).toUpperCase();
export const isLive = (s: string): boolean => s === "running";
// Spawn in flight — its worktree is still being created. Rendered with a spinner instead of the LED dot.
export const isProvisioning = (s: string): boolean => s === "provisioning";
