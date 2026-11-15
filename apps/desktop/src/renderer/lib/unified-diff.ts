// Split a `git diff` (unified format, as fleet.diff returns it) into per-file sections for the read-only branch-diff
// view (audit #84). Only lines inside hunks are kept and counted, so a "+++"/"---" content line inside a hunk is still
// a change, and a trailing truncation marker (fleet.diff caps at 512 KB) never counts.
export type DiffFile = { path: string; status: "A" | "D" | "M" | "R"; added: number; deleted: number; lines: string[] };

export function splitUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    const head = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (head) {
      cur = { path: head[2]!, status: "M", added: 0, deleted: 0, lines: [] };
      files.push(cur);
      inHunk = false;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("@@")) { inHunk = true; cur.lines.push(line); continue; }
    if (!inHunk) {
      if (line.startsWith("new file mode")) cur.status = "A";
      else if (line.startsWith("deleted file mode")) cur.status = "D";
      else if (line.startsWith("rename to ")) { cur.status = "R"; cur.path = line.slice("rename to ".length); }
      continue;
    }
    if (line.startsWith("+")) { cur.added++; cur.lines.push(line); }
    else if (line.startsWith("-")) { cur.deleted++; cur.lines.push(line); }
    else if (line.startsWith(" ") || line.startsWith("\\")) cur.lines.push(line);
    // anything else (blank tail, truncation marker) is not part of the hunk
  }
  return files;
}
