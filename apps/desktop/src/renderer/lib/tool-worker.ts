// Extract the spawned worker id from a spawn_worker tool result (used to navigate to that worker's view on click).
// Result format (src/tools/fleet-tools.ts): "Spawned <id> in '<repo>' (worktree branch rookery/<id>)."
// The name arrives as "spawn_worker" because master's prettyToolName strips the "mcp__fleet__" prefix.
// Unlike worker.* inline markers (worker LogItem rows), tool events are persisted, so navigation via this chip still works after a reload.
export function spawnedWorkerId(name: string, result: string | undefined): string | null {
  if (name !== "spawn_worker" || !result) return null;
  const m = result.match(/^Spawned\s+(\S+)\s+in\b/);
  return m ? (m[1] ?? null) : null;
}

// Other fleet tool cards (unlike spawn_worker) already take the worker id as an `id` input argument
// rather than producing it in the result — src/tools/fleet-tools.ts: send/status/transcript/diff/interrupt/stop/discard
// all declare `{ id: z.string(), ... }`. Extract it the same robust way as filePathOf (tool-file.ts):
// a regex over the raw input string rather than JSON.parse, since input can be truncated mid-object.
const FLEET_INPUT_ID_TOOLS = new Set([
  "send_worker",
  "get_worker_status",
  "view_worker_transcript",
  "view_worker_diff",
  "interrupt_worker",
  "stop_worker",
  "discard_worker",
]);

export function workerIdFromInput(name: string, input: string | undefined): string | null {
  if (!input || !FLEET_INPUT_ID_TOOLS.has(name)) return null;
  const m = input.match(/"id"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`); // unescape JSON escapes (\\, \", etc.)
  } catch {
    return m[1] ?? null;
  }
}
