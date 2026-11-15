import type { BackgroundTaskView } from "../core/events.js";

const MAX_DESCRIPTION_CHARS = 120;

// Collapse every whitespace run (incl. \r/\n/\t) to one space: descriptions come from model-launched commands, and an
// embedded newline would otherwise forge extra task/header lines in output that reaches the master and external clients.
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// Read-only rendering of a worker's listed background tasks, appended to get_worker_status output (master + external MCP).
// Empty list → "" so the status line is byte-identical to before when nothing is running in the background.
export function formatBackgroundTasks(tasks: BackgroundTaskView[]): string {
  if (tasks.length === 0) return "";
  const lines = tasks.map((t) => {
    const flat = oneLine(t.description);
    const desc = flat.length > MAX_DESCRIPTION_CHARS ? `${flat.slice(0, MAX_DESCRIPTION_CHARS)}…` : flat;
    return `- ${oneLine(t.type)}: ${desc}`;
  });
  return `\nbackground tasks:\n${lines.join("\n")}`;
}
