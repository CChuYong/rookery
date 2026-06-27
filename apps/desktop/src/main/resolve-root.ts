import { join } from "node:path";

// Work root for the active page: live worker worktree > session cwd > home. Shared by terminal and workspace.
export function resolveWorkRoot(
  deps: { rookeryHome: string; homeDir: string; exists: (p: string) => boolean },
  opts: { subId?: string; cwd?: string },
): string {
  if (opts.subId) {
    const wt = join(deps.rookeryHome, "worktrees", opts.subId);
    if (deps.exists(wt)) return wt;
  }
  if (opts.cwd && deps.exists(opts.cwd)) return opts.cwd;
  return deps.homeDir;
}
