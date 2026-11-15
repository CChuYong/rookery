// Split a `git diff` (unified format, as fleet.diff returns it) into per-file sections for the read-only branch-diff
// view (audit #84). Every `diff --git ` line starts a new file; the path comes from the `+++ b/` side (the `--- a/` side
// for deletions, `rename to` for renames), with git's C-style quoting decoded — git quotes non-ASCII and special paths
// (`"b/\355\225\234.md"`). Only lines inside hunks are kept and counted, so a "+++"/"---" content line inside a hunk is
// still a change, and the daemon's truncation marker (fleet.diff caps at 512 KB) never counts.
// `from` = the old path of a rename; `mode` = the new file mode of a mode change. Both are only set when present, so a
// hunk-less file (pure rename, chmod) can say what changed.
export type DiffFile = { path: string; status: "A" | "D" | "M" | "R"; added: number; deleted: number; binary: boolean; lines: string[]; from?: string; mode?: string };

const TRUNCATION_MARKER = "…(truncated)"; // appended by the daemon's truncateBytes (src/core/truncate.ts)

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

// Decode one git path token. Unquoted tokens are returned as-is; quoted ones are C-unescaped, with octal escapes taken
// as raw bytes and the whole byte string decoded as UTF-8.
export function unquoteGitPath(token: string): string {
  if (!(token.length >= 2 && token.startsWith('"') && token.endsWith('"'))) return token;
  const body = token.slice(1, -1);
  const bytes: number[] = [];
  const enc = new TextEncoder();
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\") { bytes.push(...enc.encode(ch)); continue; }
    const next = body[i + 1] ?? "";
    if (/[0-7]/.test(next)) {
      const oct = /^[0-7]{1,3}/.exec(body.slice(i + 1))![0];
      bytes.push(parseInt(oct, 8) & 0xff);
      i += oct.length;
    } else if (next in ESCAPES) {
      bytes.push(ESCAPES[next]!);
      i += 1;
    } else {
      bytes.push(92); // a lone backslash
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

// `--- a/x` / `+++ "b/x"` → the path without its a/ or b/ prefix (null for /dev/null). Git may append a tab.
function sidePath(rest: string): string | null {
  const token = rest.replace(/\t$/, "");
  if (token === "/dev/null") return null;
  const p = unquoteGitPath(token);
  return p.startsWith("a/") || p.startsWith("b/") ? p.slice(2) : p;
}

// Best-effort path from the `diff --git` header itself (used when there are no ---/+++ lines: binary, pure rename,
// mode change). Quoted form: take the last quoted token; plain form: the text after the last " b/".
function headerPath(rest: string): string {
  const quoted = rest.match(/"(?:[^"\\]|\\.)*"/g);
  if (quoted && quoted.length > 0) {
    const p = unquoteGitPath(quoted[quoted.length - 1]!);
    return p.startsWith("b/") || p.startsWith("a/") ? p.slice(2) : p;
  }
  const i = rest.lastIndexOf(" b/");
  return i >= 0 ? rest.slice(i + 3) : rest.replace(/^a\//, "");
}

export function parseUnifiedDiff(diff: string): { files: DiffFile[]; truncated: boolean } {
  const files: DiffFile[] = [];
  const truncated = diff.trimEnd().endsWith(TRUNCATION_MARKER);
  let cur: DiffFile | null = null;
  let inHunk = false;
  let minusPath: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      cur = { path: headerPath(line.slice("diff --git ".length)), status: "M", added: 0, deleted: 0, binary: false, lines: [] };
      files.push(cur);
      inHunk = false;
      minusPath = null;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("@@")) { inHunk = true; cur.lines.push(line); continue; }
    if (!inHunk) {
      if (line.startsWith("new file mode")) cur.status = "A";
      else if (line.startsWith("deleted file mode")) cur.status = "D";
      else if (line.startsWith("rename from ")) cur.from = unquoteGitPath(line.slice("rename from ".length));
      else if (line.startsWith("new mode ")) cur.mode = line.slice("new mode ".length).trim();
      else if (line.startsWith("rename to ")) { cur.status = "R"; cur.path = unquoteGitPath(line.slice("rename to ".length)); }
      else if (line.startsWith("Binary files ")) cur.binary = true;
      else if (line.startsWith("--- ")) { minusPath = sidePath(line.slice(4)); if (minusPath) cur.path = minusPath; }
      else if (line.startsWith("+++ ")) { const plus = sidePath(line.slice(4)); cur.path = plus ?? minusPath ?? cur.path; }
      continue;
    }
    if (line.startsWith("+")) { cur.added++; cur.lines.push(line); }
    else if (line.startsWith("-")) { cur.deleted++; cur.lines.push(line); }
    else if (line.startsWith(" ") || line.startsWith("\\")) cur.lines.push(line);
    // anything else (blank tail, truncation marker) is not part of the hunk
  }
  return { files, truncated };
}

export function splitUnifiedDiff(diff: string): DiffFile[] {
  return parseUnifiedDiff(diff).files;
}
