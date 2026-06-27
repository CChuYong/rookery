import fs from "node:fs";
import path from "node:path";

// register_repo path validation (SEC-2): absolute path + exists + git working tree (.git present — directory or file both allowed).
// null means OK, otherwise an error message. exists is for test injection (defaults to fs.existsSync).
export function repoPathError(p: string, exists: (q: string) => boolean = fs.existsSync): string | null {
  if (!path.isAbsolute(p)) return `path must be absolute: '${p}'`;
  if (!exists(p)) return `path does not exist: '${p}'`;
  if (!exists(path.join(p, ".git"))) return `path is not a git repository (no .git): '${p}'`;
  return null;
}
