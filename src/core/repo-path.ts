import fs from "node:fs";
import path from "node:path";

export interface RepoPathRecord {
  id: string;
  path: string;
}

export function canonicalPath(
  value: string,
  realpath: (candidate: string) => string = fs.realpathSync.native,
): string {
  const absolute = path.resolve(value);
  try {
    return path.normalize(realpath(absolute));
  } catch {
    return path.normalize(absolute);
  }
}

export function longestContainingRepo<T extends RepoPathRecord>(
  cwd: string,
  repos: readonly T[],
  realpath: (candidate: string) => string = fs.realpathSync.native,
): T | undefined {
  const canonicalCwd = canonicalPath(cwd, realpath);
  return repos
    .map((repo) => ({ repo, canonicalRepo: canonicalPath(repo.path, realpath) }))
    .filter(({ canonicalRepo }) => {
      const relative = path.relative(canonicalRepo, canonicalCwd);
      return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
    })
    .sort((a, b) => b.canonicalRepo.length - a.canonicalRepo.length || a.repo.id.localeCompare(b.repo.id))[0]?.repo;
}

// register_repo path validation (SEC-2): absolute path + exists + git working tree (.git present — directory or file both allowed).
// null means OK, otherwise an error message. exists is for test injection (defaults to fs.existsSync).
export function repoPathError(p: string, exists: (q: string) => boolean = fs.existsSync): string | null {
  if (!path.isAbsolute(p)) return `path must be absolute: '${p}'`;
  if (!exists(p)) return `path does not exist: '${p}'`;
  if (!exists(path.join(p, ".git"))) return `path is not a git repository (no .git): '${p}'`;
  return null;
}
