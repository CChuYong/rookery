// Extracts the target file path from a file tool's (Read/Edit/Write/MultiEdit/NotebookEdit) input JSON.
// Keys, not tool names, are used to decide — the master may rewrite names via prettyToolName,
// and input can be truncated at 2000~4000B, so we extract robustly with a regex instead of JSON.parse.
// To avoid colliding with Grep/Glob's `path` (a directory), we look at exactly file_path / notebook_path only.
export function filePathOf(input: string | undefined): string | null {
  if (!input) return null;
  const m = input.match(/"(?:file_path|notebook_path)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`); // unescape JSON escapes (\\, \", etc.)
  } catch {
    return m[1] ?? null;
  }
}
