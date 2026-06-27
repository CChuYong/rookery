// Extract the spawned worker id from a spawn_worker tool result (used to navigate to that worker's view on click).
// Result format (src/tools/fleet-tools.ts): "Spawned <id> in '<repo>' (worktree branch rookery/<id>)."
// The name arrives as "spawn_worker" because master's prettyToolName strips the "mcp__fleet__" prefix.
// Unlike worker.* inline markers (worker LogItem rows), tool events are persisted, so navigation via this chip still works after a reload.
export function spawnedWorkerId(name: string, result: string | undefined): string | null {
  if (name !== "spawn_worker" || !result) return null;
  const m = result.match(/^Spawned\s+(\S+)\s+in\b/);
  return m ? (m[1] ?? null) : null;
}
