import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const pexec = promisify(execFile);

export interface GitOps {
  currentBranch(repoPath: string): Promise<string>;
  // Whether the local branch exists (no network) — used to branch off with a suffix when the ticket-based branch name collides.
  branchExists(repoPath: string, branch: string): Promise<boolean>;
  addWorktree(repoPath: string, worktreePath: string, branch: string, base: string): Promise<void>;
  removeWorktree(repoPath: string, worktreePath: string, branch: string): Promise<void>;
  diff(worktreePath: string, base: string): Promise<string>;
  // Snapshot the entire worktree state (tracked + untracked) to a hidden ref → returns the sha (null on failure / empty worktree).
  checkpoint(worktreePath: string, ref: string): Promise<string | null>;
  // Restore tracked files to the sha's point-in-time (does not delete files created afterward — best-effort restore).
  restoreCheckpoint(worktreePath: string, sha: string): Promise<void>;
  listBranches(repoPath: string): Promise<string[]>;
  // Remove all of the worker's hidden checkpoint refs (refs/rookery/ckpt/<id>/*) from the parent repo
  // (prevents unbounded accumulation of refs/dangling objects in .git on discard/delete). best-effort.
  removeCheckpointRefs(repoPath: string, workerId: string): Promise<void>;
  // The remote-tracking ref of the remote default branch (e.g. "origin/main"). null if origin/HEAD is unset or origin is absent. No network.
  remoteDefaultBranch(repoPath: string): Promise<string | null>;
  // Fetch (refresh) the target branch from origin. Throws on failure — the caller handles it best-effort.
  fetch(repoPath: string, branch: string): Promise<void>;
}

export class RealGitOps implements GitOps {
  private async git(cwd: string, args: string[]): Promise<string> {
    return this.gitEnv(cwd, args, {});
  }

  // Force the C locale → git error messages are always in English. This keeps removeWorktree's already-removed detection (an English regex)
  // working in non-English environments like ko_KR.UTF-8 (FL-4). Output content (diff, etc.) is unaffected by locale.
  // extraEnv: used when checkpoint writes a temporary index via GIT_INDEX_FILE (non-destructive to the working index).
  private async gitEnv(cwd: string, args: string[], extraEnv: Record<string, string>): Promise<string> {
    const { stdout } = await pexec("git", args, { cwd, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LC_ALL: "C", LANG: "C", ...extraEnv } });
    return stdout.toString();
  }

  async currentBranch(repoPath: string): Promise<string> {
    return (await this.git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  }

  async branchExists(repoPath: string, branch: string): Promise<boolean> {
    try {
      await this.git(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
      return true;
    } catch {
      return false; // non-zero exit = does not exist
    }
  }

  async addWorktree(repoPath: string, worktreePath: string, branch: string, base: string): Promise<void> {
    // `--end-of-options`: base is a free-form string, so git must not mistake it for an option (SEC-1). Everything after is positional.
    await this.git(repoPath, ["worktree", "add", "-b", branch, worktreePath, "--end-of-options", base]);
  }

  async removeWorktree(repoPath: string, worktreePath: string, branch: string): Promise<void> {
    try {
      await this.git(repoPath, ["worktree", "remove", "--force", worktreePath]);
    } catch (err) {
      // Ignore worktrees that are already removed or absent (idempotent, best-effort). Other failures (lock, etc.) propagate (FL-4).
      if (!/not a working tree|is not a working tree|No such file|does not exist/i.test(String(err))) throw err;
    }
    try {
      await this.git(repoPath, ["branch", "-D", branch]);
    } catch {
      /* the branch may be gone because it was pushed/merged — best-effort */
    }
  }

  async diff(worktreePath: string, base: string): Promise<string> {
    // `--end-of-options`: treat base only as a revision, not an option (SEC-1, e.g. blocks arbitrary file writes via `--output=`).
    return this.git(worktreePath, ["diff", "--end-of-options", base]);
  }

  async checkpoint(worktreePath: string, ref: string): Promise<string | null> {
    // The temp index path must be unique per call — deriving it from pid+ref alone makes concurrent calls with the same ref share the same
    // GIT_INDEX_FILE, so one side's cleanup (rmSync) deletes the index the other is writing and corrupts the tree (checkpoint race).
    const idxFile = path.join(os.tmpdir(), `rookery-ckpt-${process.pid}-${randomUUID()}`);
    try {
      // Stage everything (add -A) into the temp index → write-tree → commit-tree, freezing the entire worktree state into a commit object
      // and pinning it to a hidden ref, without touching the working index/HEAD.
      const env = { GIT_INDEX_FILE: idxFile };
      // Clone the current index into the temp index (start from an empty index if absent), then stage everything.
      await this.gitEnv(worktreePath, ["read-tree", "HEAD"], env).catch(() => {});
      await this.gitEnv(worktreePath, ["add", "-A"], env);
      const tree = (await this.gitEnv(worktreePath, ["write-tree"], env)).trim();
      const head = (await this.git(worktreePath, ["rev-parse", "HEAD"])).trim();
      const sha = (await this.gitEnv(worktreePath, ["commit-tree", tree, "-p", head, "-m", "rookery checkpoint"], {})).trim();
      await this.git(worktreePath, ["update-ref", ref, sha]);
      return sha;
    } catch {
      return null; // best-effort — a checkpoint failure must not block the turn
    } finally {
      fs.rmSync(idxFile, { force: true }); // clean up the temp index regardless of success/failure (prevents leaks on the failure path)
    }
  }

  async restoreCheckpoint(worktreePath: string, sha: string): Promise<void> {
    // Restore tracked files to the sha tree's point-in-time. Leaves files created afterward intact (minimizes destruction).
    await this.git(worktreePath, ["checkout", "--end-of-options", sha, "--", "."]);
  }

  async listBranches(repoPath: string): Promise<string[]> {
    const out = await this.git(repoPath, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  }

  async removeCheckpointRefs(repoPath: string, workerId: string): Promise<void> {
    // List then delete refs/rookery/ckpt/<id>/*. The refs were created via update-ref from the worker's worktree, but they
    // are stored in the shared .git (repoPath), so they are visible here. best-effort — ignore failures.
    const prefix = `refs/rookery/ckpt/${workerId}/`;
    const out = await this.git(repoPath, ["for-each-ref", "--format=%(refname)", prefix]).catch(() => "");
    for (const ref of out.split("\n").map((s) => s.trim()).filter(Boolean)) {
      await this.git(repoPath, ["update-ref", "-d", ref]).catch(() => {});
    }
  }

  async remoteDefaultBranch(repoPath: string): Promise<string | null> {
    try {
      return (await this.git(repoPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).trim() || null;
    } catch {
      return null; // origin/HEAD unset · no origin → drive the fallback (do not throw)
    }
  }

  async fetch(repoPath: string, branch: string): Promise<void> {
    // branch may be a free-form string, so protect it as positional with --end-of-options (SEC-1). Refreshes origin/<branch>.
    await this.git(repoPath, ["fetch", "--end-of-options", "origin", branch]);
  }
}

export class FakeGitOps implements GitOps {
  readonly calls: string[] = [];
  constructor(
    private readonly opts: { headValue?: string; diffValue?: string; checkpointSha?: string; branches?: string[]; remoteDefault?: string | null; fetchFails?: boolean } = {},
  ) {}
  async currentBranch(repoPath: string): Promise<string> {
    this.calls.push(`currentBranch ${repoPath}`);
    return this.opts.headValue ?? "main";
  }
  private readonly created = new Set<string>(); // branches created via addWorktree (for branchExists)
  async branchExists(repoPath: string, branch: string): Promise<boolean> {
    return this.created.has(`${repoPath}\t${branch}`);
  }
  async addWorktree(repoPath: string, worktreePath: string, branch: string, base: string): Promise<void> {
    this.calls.push(`addWorktree ${repoPath} ${worktreePath} ${branch} ${base}`);
    this.created.add(`${repoPath}\t${branch}`);
  }
  async removeWorktree(repoPath: string, worktreePath: string, branch: string): Promise<void> {
    this.calls.push(`removeWorktree ${repoPath} ${worktreePath} ${branch}`);
  }
  async diff(worktreePath: string, base: string): Promise<string> {
    this.calls.push(`diff ${worktreePath} ${base}`);
    return this.opts.diffValue ?? "";
  }
  async checkpoint(worktreePath: string, ref: string): Promise<string | null> {
    this.calls.push(`checkpoint ${worktreePath} ${ref}`);
    return this.opts.checkpointSha ?? null;
  }
  async restoreCheckpoint(worktreePath: string, sha: string): Promise<void> {
    this.calls.push(`restoreCheckpoint ${worktreePath} ${sha}`);
  }
  async listBranches(repoPath: string): Promise<string[]> {
    this.calls.push(`listBranches ${repoPath}`);
    return this.opts.branches ?? [];
  }
  async removeCheckpointRefs(repoPath: string, workerId: string): Promise<void> {
    this.calls.push(`removeCheckpointRefs ${repoPath} ${workerId}`);
  }
  async remoteDefaultBranch(repoPath: string): Promise<string | null> {
    this.calls.push(`remoteDefaultBranch ${repoPath}`);
    return this.opts.remoteDefault ?? null;
  }
  async fetch(repoPath: string, branch: string): Promise<void> {
    this.calls.push(`fetch ${repoPath} ${branch}`);
    if (this.opts.fetchFails) throw new Error("fetch failed");
  }
}
