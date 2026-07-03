import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { FakeGitOps, RealGitOps } from "../../src/core/git-ops.js";

describe("FakeGitOps", () => {
  it("records calls and returns deterministic values", async () => {
    const g = new FakeGitOps({ headValue: "deadbeef", diffValue: "diff!" });
    expect(await g.currentBranch("/repo")).toBe("deadbeef");
    await g.addWorktree("/repo", "/wt", "rookery/a", "main");
    expect(await g.diff("/wt", "main")).toBe("diff!");
    expect(g.calls).toContain("addWorktree /repo /wt rookery/a main");
  });

  it("checkpoint/restoreCheckpoint/listBranches record + return injected values", async () => {
    const g = new FakeGitOps({ checkpointSha: "ck1", branches: ["main", "dev"] });
    expect(await g.checkpoint("/wt", "refs/rookery/ckpt/a/0")).toBe("ck1");
    expect(g.calls).toContain("checkpoint /wt refs/rookery/ckpt/a/0");
    await g.restoreCheckpoint("/wt", "ck1");
    expect(g.calls).toContain("restoreCheckpoint /wt ck1");
    expect(await g.listBranches("/repo")).toEqual(["main", "dev"]);
    expect(g.calls).toContain("listBranches /repo");
  });

  it("branchExists reflects branches created via addWorktree", async () => {
    const g = new FakeGitOps();
    expect(await g.branchExists("/r", "rookery/eng-1")).toBe(false);
    await g.addWorktree("/r", "/wt", "rookery/eng-1", "main");
    expect(await g.branchExists("/r", "rookery/eng-1")).toBe(true);
    expect(await g.branchExists("/r", "rookery/other")).toBe(false);
  });
});

describe("RealGitOps (real git, no network)", () => {
  it("creates a worktree, commits a change, and diffs it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitops-"));
    const repo = path.join(dir, "repo");
    fs.mkdirSync(repo);
    const sh = (args: string[], cwd: string) => execFileSync("git", args, { cwd });
    sh(["init", "-q"], repo);
    sh(["config", "user.email", "x@x.com"], repo);
    sh(["config", "user.name", "x"], repo);
    fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
    sh(["add", "-A"], repo);
    sh(["commit", "-qm", "init"], repo);

    const g = new RealGitOps();
    const base = await g.currentBranch(repo);
    const wt = path.join(dir, "wt");
    await g.addWorktree(repo, wt, "rookery/test", base);
    fs.writeFileSync(path.join(wt, "new.txt"), "added\n");
    sh(["add", "-A"], wt);
    sh(["commit", "-qm", "rookery: test"], wt); // the worker commits directly in its own worktree (GitOps has no commit helper)
    const diff = await g.diff(wt, base);
    expect(diff).toContain("new.txt");
    await g.removeWorktree(repo, wt, "rookery/test");
    expect(fs.existsSync(wt)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 20000); // many real git subprocesses — under load this can exceed the default 5s timeout, so allow extra headroom

  // SEC-1: base is a free-form string controlled by the model/registration. If git parses it as an "option",
  // `git diff --output=<path>` becomes an arbitrary file write. base must always be treated as a revision (positional) only.
  it("does not let a git-option-looking base act as an option (arg-injection guard)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitops-sec-"));
    const repo = path.join(dir, "repo");
    fs.mkdirSync(repo);
    const sh = (args: string[], cwd: string) => execFileSync("git", args, { cwd });
    sh(["init", "-q"], repo);
    sh(["config", "user.email", "x@x.com"], repo);
    sh(["config", "user.name", "x"], repo);
    fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
    sh(["add", "-A"], repo);
    sh(["commit", "-qm", "init"], repo);

    const g = new RealGitOps();
    const base = await g.currentBranch(repo);
    const wt = path.join(dir, "wt");
    await g.addWorktree(repo, wt, "rookery/sec", base);
    fs.writeFileSync(path.join(wt, "f.txt"), "x\n");
    sh(["add", "-A"], wt);
    sh(["commit", "-qm", "c"], wt);

    const pwn = path.join(dir, "PWNED");
    await expect(g.diff(wt, `--output=${pwn}`)).rejects.toThrow();
    expect(fs.existsSync(pwn)).toBe(false);

    fs.rmSync(dir, { recursive: true, force: true });
  }, 20000);

  // FL-4: removeWorktree must be idempotent. To recognize "already gone" even under non-English locales (ko_KR, etc.)
  it("checkpoint snapshots tracked+untracked, restoreCheckpoint brings files back; listBranches lists local", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitops-ckpt-"));
    const repo = path.join(dir, "repo");
    fs.mkdirSync(repo);
    const sh = (args: string[], cwd: string) => execFileSync("git", args, { cwd });
    sh(["init", "-q"], repo);
    sh(["config", "user.email", "x@x.com"], repo);
    sh(["config", "user.name", "x"], repo);
    fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
    sh(["add", "-A"], repo);
    sh(["commit", "-qm", "init"], repo);
    sh(["branch", "feature"], repo);

    const g = new RealGitOps();
    const base = await g.currentBranch(repo);
    const wt = path.join(dir, "wt");
    await g.addWorktree(repo, wt, "rookery/ckpt", base);

    // write a new (untracked) file then checkpoint → modify that file → restoring brings it back to the content at checkpoint time.
    const f = path.join(wt, "work.txt");
    fs.writeFileSync(f, "v1\n");
    const sha = await g.checkpoint(wt, "refs/rookery/ckpt/test/0");
    expect(sha).toBeTruthy();
    fs.writeFileSync(f, "v2-corrupted\n");
    await g.restoreCheckpoint(wt, sha!);
    expect(fs.readFileSync(f, "utf8")).toBe("v1\n"); // restored to the checkpoint state

    const branches = await g.listBranches(repo);
    expect(branches).toContain(base);
    expect(branches).toContain("feature");

    await g.removeWorktree(repo, wt, "rookery/ckpt");
    fs.rmSync(dir, { recursive: true, force: true });
  }, 20000);

  // removeCheckpointRefs: cleans up the worker's hidden checkpoint refs from the parent repo (prevents discard/delete leaks).
  it("removeCheckpointRefs deletes all refs/rookery/ckpt/<id>/* in the repo", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitops-ckpt-refs-"));
    const repo = path.join(dir, "repo");
    fs.mkdirSync(repo);
    const sh = (args: string[], cwd: string) => execFileSync("git", args, { cwd });
    sh(["init", "-q"], repo);
    sh(["config", "user.email", "x@x.com"], repo);
    sh(["config", "user.name", "x"], repo);
    fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
    sh(["add", "-A"], repo);
    sh(["commit", "-qm", "init"], repo);

    const g = new RealGitOps();
    const base = await g.currentBranch(repo);
    const wt = path.join(dir, "wt");
    await g.addWorktree(repo, wt, "rookery/refs", base);
    fs.writeFileSync(path.join(wt, "w.txt"), "v1\n");
    await g.checkpoint(wt, "refs/rookery/ckpt/W1/0");
    await g.checkpoint(wt, "refs/rookery/ckpt/W1/1");
    await g.checkpoint(wt, "refs/rookery/ckpt/W2/0"); // a different worker — must be preserved

    const refsOf = () =>
      execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/rookery/ckpt/"], { cwd: repo }).toString().trim();
    expect(refsOf().split("\n").filter(Boolean).length).toBe(3);

    await g.removeCheckpointRefs(repo, "W1");
    const after = refsOf().split("\n").filter(Boolean);
    expect(after).toEqual(["refs/rookery/ckpt/W2/0"]); // only W1 removed, W2 preserved

    await g.removeWorktree(repo, wt, "rookery/refs");
    fs.rmSync(dir, { recursive: true, force: true });
  }, 20000);

  // #32: a fork() pins a one-shot full-tree snapshot at refs/rookery/fork/<id> in the shared .git. removeCheckpointRefs
  // (run on discard/delete) must also reclaim it, or every fork leaks a permanently-pinned commit.
  it("removeCheckpointRefs also deletes the fork snapshot ref (audit #32)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitops-fork-ref-"));
    const repo = path.join(dir, "repo");
    fs.mkdirSync(repo);
    const sh = (args: string[], cwd: string) => execFileSync("git", args, { cwd });
    sh(["init", "-q"], repo);
    sh(["config", "user.email", "x@x.com"], repo);
    sh(["config", "user.name", "x"], repo);
    fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
    sh(["add", "-A"], repo);
    sh(["commit", "-qm", "init"], repo);

    const g = new RealGitOps();
    const base = await g.currentBranch(repo);
    const wt = path.join(dir, "wt");
    await g.addWorktree(repo, wt, "rookery/fork-ref", base);
    fs.writeFileSync(path.join(wt, "w.txt"), "v1\n");
    const sha = await g.checkpoint(wt, "refs/rookery/fork/w1");
    expect(sha).toBeTruthy();
    await g.removeCheckpointRefs(repo, "w1");
    const refs = execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/rookery"], { cwd: repo }).toString();
    expect(refs).not.toContain("refs/rookery/fork/w1");

    await g.removeWorktree(repo, wt, "rookery/fork-ref");
    fs.rmSync(dir, { recursive: true, force: true });
  }, 20000);

  // git error messages must be in English (the git() helper forces LC_ALL=C).
  it("removeWorktree is idempotent — a second remove of an already-gone worktree does not throw", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitops-idem-"));
    const repo = path.join(dir, "repo");
    fs.mkdirSync(repo);
    const sh = (args: string[], cwd: string) => execFileSync("git", args, { cwd });
    sh(["init", "-q"], repo);
    sh(["config", "user.email", "x@x.com"], repo);
    sh(["config", "user.name", "x"], repo);
    fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
    sh(["add", "-A"], repo);
    sh(["commit", "-qm", "init"], repo);

    const g = new RealGitOps();
    const base = await g.currentBranch(repo);
    const wt = path.join(dir, "wt");
    await g.addWorktree(repo, wt, "rookery/idem", base);
    await g.removeWorktree(repo, wt, "rookery/idem"); // 1st: normal removal
    await expect(g.removeWorktree(repo, wt, "rookery/idem")).resolves.toBeUndefined(); // 2nd: already gone → does not throw

    fs.rmSync(dir, { recursive: true, force: true });
  }, 20000);
});

const gitE = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: { ...process.env, LC_ALL: "C", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).toString();

describe("RealGitOps.remoteDefaultBranch / fetch", () => {
  let dir: string, bare: string, work: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rookery-git-"));
    bare = path.join(dir, "remote.git");
    work = path.join(dir, "work");
    execFileSync("git", ["init", "--bare", "-b", "main", bare]);
    execFileSync("git", ["clone", bare, work]);
    gitE(work, "config", "user.email", "t@t");
    gitE(work, "config", "user.name", "t");
    fs.writeFileSync(path.join(work, "a.txt"), "1");
    gitE(work, "add", "-A");
    gitE(work, "commit", "-m", "c1");
    gitE(work, "push", "origin", "main");
    gitE(work, "remote", "set-head", "origin", "main"); // origin/HEAD → origin/main (no network needed)
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("returns origin/<default branch> when origin/HEAD is set", async () => {
    expect(await new RealGitOps().remoteDefaultBranch(work)).toBe("origin/main");
  });

  it("returns null for a repo without origin", async () => {
    const local = path.join(dir, "local");
    execFileSync("git", ["init", "-b", "main", local]);
    expect(await new RealGitOps().remoteDefaultBranch(local)).toBeNull();
  });

  it("fetch advances origin/main to the newly pushed commit", async () => {
    // push a new commit from a second clone → work's origin/main is the old sha until fetch.
    const work2 = path.join(dir, "work2");
    execFileSync("git", ["clone", bare, work2]);
    gitE(work2, "config", "user.email", "t@t");
    gitE(work2, "config", "user.name", "t");
    fs.writeFileSync(path.join(work2, "b.txt"), "2");
    gitE(work2, "add", "-A");
    gitE(work2, "commit", "-m", "c2");
    gitE(work2, "push", "origin", "main");
    const pushed = gitE(work2, "rev-parse", "HEAD").trim();
    await new RealGitOps().fetch(work, "main");
    expect(gitE(work, "rev-parse", "origin/main").trim()).toBe(pushed);
  });
});
