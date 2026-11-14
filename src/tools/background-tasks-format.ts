import type { BackgroundTaskView } from "../core/events.js";

const MAX_DESCRIPTION_CHARS = 120;

// Read-only rendering of a worker's listed background tasks, appended to get_worker_status output (master + external MCP).
// Empty list → "" so the status line is byte-identical to before when nothing is running in the background.
export function formatBackgroundTasks(tasks: BackgroundTaskView[]): string {
  if (tasks.length === 0) return "";
  const lines = tasks.map((t) => {
    const desc = t.description.length > MAX_DESCRIPTION_CHARS ? `${t.description.slice(0, MAX_DESCRIPTION_CHARS)}…` : t.description;
    return `- ${t.type}: ${desc}`;
  });
  return `\nbackground tasks:\n${lines.join("\n")}`;
}
