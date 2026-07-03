import { describe, it, expect, vi } from "vitest";
import { WorkspaceManager } from "../src/main/workspace-manager.js";

function fakeFs(files: Record<string, string>, dirs: Record<string, Array<{ name: string; isDir: boolean }>>) {
  return {
    readFile: vi.fn(async (p: string) => { if (!(p in files)) throw new Error("ENOENT"); return Buffer.from(files[p]); }),
    writeFile: vi.fn(async (p: string, c: string) => { files[p] = c; }),
    readdir: vi.fn(async (d: string) => (dirs[d] ?? []).map((e) => ({ name: e.name, isDirectory: () => e.isDir }))),
    stat: vi.fn(async (p: string) => ({ size: Buffer.byteLength(files[p] ?? "") })),
  };
}

function setup(over: Record<string, unknown> = {}) {
  const files = { "/r/a.ts": "export const x = 1;\n", "/r/big": "x".repeat(2_000_000), "/r/bin": "a\0b", "/r/logo.png": "PNGDATA" };
  const dirs = { "/r": [{ name: "src", isDir: true }, { name: "a.ts", isDir: false }, { name: ".git", isDir: true }] };
  const fs = fakeFs(files, dirs);
  const changed: string[] = [];
  const mgr = new WorkspaceManager({
    fs: fs as never,
    resolveRoot: () => "/r",
    send: (_ch, p) => changed.push((p as { path: string }).path),
    watch: (path, cb) => { (setup as never as { _cbs: Record<string, () => void> })._cbs = { ...(setup as never as { _cbs?: Record<string, () => void> })._cbs, [path]: cb }; return { close: () => {} }; },
    maxBytes: 1_000_000,
    ...over,
  });
  mgr.root({}); // resolveRoot("/r") → seed "/r" as an allowed root (same as the UI flow: always resolveRoot first)
  return { mgr, fs, changed };
}

describe("WorkspaceManager fs", () => {
  it("lists entries with dirs first, name-sorted, excluding .git", async () => {
    const { mgr } = setup();
    expect(await mgr.list("/r")).toEqual([{ name: "src", isDir: true }, { name: "a.ts", isDir: false }]);
  });
  it("reads a text file", async () => {
    const { mgr } = setup();
    expect(await mgr.read("/r/a.ts")).toEqual({ content: "export const x = 1;\n", tooLarge: false });
  });
  it("refuses files over maxBytes", async () => {
    const { mgr } = setup();
    expect(await mgr.read("/r/big")).toEqual({ content: "", tooLarge: true });
  });
  it("refuses binary (NUL) files", async () => {
    const { mgr } = setup();
    expect((await mgr.read("/r/bin")).tooLarge).toBe(true);
  });
  it("readImage returns a base64 data URL with the right mime", async () => {
    const { mgr } = setup();
    const r = await mgr.readImage("/r/logo.png");
    expect(r.dataUrl).toBe(`data:image/png;base64,${Buffer.from("PNGDATA").toString("base64")}`);
  });
  it("readImage reports unsupported for non-image extensions", async () => {
    const { mgr } = setup();
    expect(await mgr.readImage("/r/a.ts")).toEqual({ unsupported: true });
  });
  it("readImage confines to allowed roots (rejects outside)", async () => {
    const { mgr } = setup();
    await expect(mgr.readImage("/etc/evil.png")).rejects.toThrow();
  });

  it("writes a file", async () => {
    const { mgr, fs } = setup();
    expect(await mgr.write("/r/a.ts", "new")).toEqual({ ok: true });
    expect(fs.writeFile).toHaveBeenCalledWith("/r/a.ts", "new");
  });

  it("confines read/write/list to allowed roots — rejects escapes & absolute paths outside", async () => {
    const { mgr, fs } = setup();
    await expect(mgr.read("/r/../../etc/passwd")).rejects.toThrow(); // .. escape
    await expect(mgr.read("/etc/passwd")).rejects.toThrow(); // absolute path outside the root
    await expect(mgr.write("/r/../evil", "x")).rejects.toThrow();
    await expect(mgr.list("/etc")).rejects.toThrow();
    expect(fs.writeFile).not.toHaveBeenCalled(); // a rejected write never touches fs
    // paths inside the root are fine
    expect(await mgr.read("/r/a.ts")).toEqual({ content: "export const x = 1;\n", tooLarge: false });
  });

  it("watchFile silently skips out-of-root paths (no throw — fire-and-forget IPC, so a throw would be uncaught)", () => {
    const watch = vi.fn(() => ({ close: () => {} }));
    const { mgr } = setup({ watch });
    expect(() => mgr.watchFile("/etc/passwd")).not.toThrow(); // outside the work folder → silently ignore (avoid a dialog)
    expect(watch).not.toHaveBeenCalled();
    mgr.watchFile("/r/a.ts"); // inside the root → registered normally
    expect(watch).toHaveBeenCalledWith("/r/a.ts", expect.any(Function));
  });

  it("refcounts watchers — close only after the last unwatch (same file opened multiple times)", () => {
    const close = vi.fn();
    const watch = vi.fn(() => ({ close }));
    const { mgr } = setup({ watch });
    mgr.watchFile("/r/a.ts");
    mgr.watchFile("/r/a.ts"); // second subscription → just bump the refcount, no duplicate watch
    expect(watch).toHaveBeenCalledTimes(1);
    mgr.unwatchFile("/r/a.ts"); // still 1 subscriber left → keep it
    expect(close).not.toHaveBeenCalled();
    mgr.unwatchFile("/r/a.ts"); // last subscriber → close
    expect(close).toHaveBeenCalledTimes(1);
    mgr.unwatchFile("/r/a.ts"); // already gone → no-op (does not throw)
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("read/write/list before any root() resolution are rejected (allowed set empty)", async () => {
    // create the manager directly without setup's seeding → allowed set is empty.
    const fs = fakeFs({ "/r/a.ts": "x" }, { "/r": [] });
    const mgr = new WorkspaceManager({ fs: fs as never, resolveRoot: () => "/r", send: () => {}, watch: () => ({ close: () => {} }) });
    await expect(mgr.read("/r/a.ts")).rejects.toThrow();
    mgr.root({}); // resolveRoot → seed
    expect(await mgr.read("/r/a.ts")).toEqual({ content: "x", tooLarge: false });
  });

  it("mkdir creates a directory inside root and is guarded", async () => {
    const mkdir = vi.fn(async () => {});
    const { mgr } = setup({ mkdir });
    expect(await mgr.mkdir("/r/newdir")).toEqual({ ok: true });
    expect(mkdir).toHaveBeenCalledWith("/r/newdir");
    await expect(mgr.mkdir("/etc/evil")).rejects.toThrow(); // rejected outside the root
  });

  it("createFile writes an empty file, refusing to clobber an existing name", async () => {
    const { mgr, fs } = setup();
    expect(await mgr.createFile("/r/fresh.ts")).toEqual({ ok: true });
    expect(fs.writeFile).toHaveBeenCalledWith("/r/fresh.ts", "");
    // a.ts is already in the /r directory listing (setup's dirs) → refuse to overwrite
    expect(await mgr.createFile("/r/a.ts")).toEqual({ ok: false, exists: true });
  });

  it("rename moves within root and guards both ends", async () => {
    const rename = vi.fn(async () => {});
    const { mgr } = setup({ rename });
    expect(await mgr.rename("/r/a.ts", "/r/b.ts")).toEqual({ ok: true });
    expect(rename).toHaveBeenCalledWith("/r/a.ts", "/r/b.ts");
    await expect(mgr.rename("/r/a.ts", "/etc/x")).rejects.toThrow(); // destination outside the root
    await expect(mgr.rename("/etc/x", "/r/a.ts")).rejects.toThrow(); // source outside the root
  });

  it("trash sends the path to the OS trash, guarded", async () => {
    const trash = vi.fn(async () => {});
    const { mgr } = setup({ trash });
    expect(await mgr.trash("/r/a.ts")).toEqual({ ok: true });
    expect(trash).toHaveBeenCalledWith("/r/a.ts");
    await expect(mgr.trash("/etc/passwd")).rejects.toThrow();
  });

  it("walk returns relative file paths recursively, skipping .git/node_modules", async () => {
    const files = { "/r/a.ts": "", "/r/src/b.ts": "", "/r/src/deep/c.ts": "" };
    const dirs = {
      "/r": [{ name: "a.ts", isDir: false }, { name: "src", isDir: true }, { name: ".git", isDir: true }, { name: "node_modules", isDir: true }],
      "/r/src": [{ name: "b.ts", isDir: false }, { name: "deep", isDir: true }],
      "/r/src/deep": [{ name: "c.ts", isDir: false }],
      "/r/.git": [{ name: "HEAD", isDir: false }],
      "/r/node_modules": [{ name: "x.js", isDir: false }],
    };
    const fs = fakeFs(files, dirs);
    const mgr = new WorkspaceManager({ fs: fs as never, resolveRoot: () => "/r", send: () => {}, watch: () => ({ close: () => {} }) });
    mgr.root({});
    const r = await mgr.walk("/r");
    expect(r.paths.sort()).toEqual(["a.ts", "src/b.ts", "src/deep/c.ts"]);
    expect(r.truncated).toBe(false);
  });
});

describe("WorkspaceManager browse (unguarded read-only — for @ autocomplete)", () => {
  function browseSetup() {
    const files = { "/r/a.ts": "export\n", "/r/.env": "X=1\n", "/r/src/index.ts": "x" };
    const dirs: Record<string, Array<{ name: string; isDir: boolean }>> = {
      "/r": [{ name: "a.ts", isDir: false }, { name: "src", isDir: true }, { name: ".env", isDir: false }],
      "/r/src": [{ name: "index.ts", isDir: false }, { name: "comp", isDir: true }],
      "/home/u": [{ name: "notes.md", isDir: false }, { name: "Documents", isDir: true }],
    };
    const fs = fakeFs(files, dirs);
    const mgr = new WorkspaceManager({
      fs: fs as never,
      resolveRoot: (opts) => (opts.subId ? `/wt/${opts.subId}` : opts.cwd ?? "/r"),
      homeDir: "/home/u",
      send: () => {},
      watch: () => ({ close: () => {} }),
    });
    return { mgr, fs };
  }

  it("empty dir lists the work root, dirs first then name (dotfiles included — the renderer filters)", async () => {
    const { mgr } = browseSetup();
    expect(await mgr.browse({ dir: "" })).toEqual({
      dir: "/r",
      entries: [
        { name: "src", isDir: true },
        { name: ".env", isDir: false, size: 4 },
        { name: "a.ts", isDir: false, size: 7 },
      ],
    });
  });

  it("relative dir resolves against the work root", async () => {
    const { mgr } = browseSetup();
    expect(await mgr.browse({ dir: "src/" })).toEqual({
      dir: "/r/src",
      entries: [
        { name: "comp", isDir: true },
        { name: "index.ts", isDir: false, size: 1 },
      ],
    });
  });

  it("~ and ~/ expand to the home directory (outside the work root)", async () => {
    const { mgr } = browseSetup();
    expect((await mgr.browse({ dir: "~" })).dir).toBe("/home/u");
    const r = await mgr.browse({ dir: "~/" });
    expect(r.dir).toBe("/home/u");
    expect(r.entries).toEqual([
      { name: "Documents", isDir: true },
      { name: "notes.md", isDir: false, size: 0 },
    ]);
  });

  it("absolute paths pass through unguarded (no work-root confinement)", async () => {
    const { mgr } = browseSetup();
    expect((await mgr.browse({ dir: "/home/u" })).dir).toBe("/home/u");
  });

  it("resolves the base from {subId} like resolveWorkRoot", async () => {
    const { mgr, fs } = browseSetup();
    await mgr.browse({ dir: "", subId: "w1" });
    expect(fs.readdir).toHaveBeenCalledWith("/wt/w1");
  });

  it("nonexistent / unreadable dir → empty entries + error code (no throw)", async () => {
    const fs = {
      readFile: vi.fn(),
      writeFile: vi.fn(),
      readdir: vi.fn(async () => { const e = new Error("ENOENT"); (e as NodeJS.ErrnoException).code = "ENOENT"; throw e; }),
      stat: vi.fn(),
    };
    const mgr = new WorkspaceManager({ fs: fs as never, resolveRoot: () => "/r", homeDir: "/home/u", send: () => {}, watch: () => ({ close: () => {} }) });
    const r = await mgr.browse({ dir: "nope" });
    expect(r.dir).toBe("/r/nope");
    expect(r.entries).toEqual([]);
    expect(r.error).toBe("ENOENT");
  });
});

describe("WorkspaceManager tree watch", () => {
  function treeSetup() {
    vi.useFakeTimers();
    let treeCb: ((rel: string | null) => void) | null = null;
    const sent: Array<{ ch: string; payload: unknown }> = [];
    const mgr = new WorkspaceManager({
      fs: {} as never,
      resolveRoot: () => "/r",
      send: (ch, payload) => sent.push({ ch, payload }),
      watch: () => ({ close: () => {} }),
      watchDir: (_root, cb) => { treeCb = cb; return { close: () => {} }; },
    });
    return { mgr, sent, fire: (rel: string | null) => treeCb?.(rel) };
  }

  it("debounces real changes into a single fs:tree event for the root", () => {
    const { mgr, sent, fire } = treeSetup();
    mgr.watchTree("/r");
    fire("src/a.ts"); fire("src/b.ts"); fire("README.md"); // burst
    expect(sent).toHaveLength(0); // debounced — not emitted yet
    vi.advanceTimersByTime(250);
    expect(sent).toEqual([{ ch: "fs:tree", payload: { root: "/r" } }]);
    vi.useRealTimers();
  });

  it("ignores node_modules + .git object/log/lock churn (no event)", () => {
    const { mgr, sent, fire } = treeSetup();
    mgr.watchTree("/r");
    fire("node_modules/foo/x.js"); fire(".git/objects/ab/cd"); fire(".git/logs/HEAD"); fire(".git/index.lock"); fire(null);
    vi.advanceTimersByTime(250);
    expect(sent).toEqual([]);
    vi.useRealTimers();
  });

  it("emits on git-meta changes (commit/stage/checkout) so the Git panel auto-refreshes", () => {
    const { mgr, sent, fire } = treeSetup();
    mgr.watchTree("/r");
    fire(".git/index"); // stage/commit → index changes
    vi.advanceTimersByTime(250);
    expect(sent).toEqual([{ ch: "fs:tree", payload: { root: "/r" } }]);
    fire(".git/refs/heads/main"); // commit → branch ref updated
    vi.advanceTimersByTime(250);
    expect(sent).toHaveLength(2);
    vi.useRealTimers();
  });
});

describe("WorkspaceManager git", () => {
  function gitSetup() {
    const calls: string[][] = [];
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "status") return { stdout: " M src/app.ts\n?? new.ts\nA  added.ts\n", code: 0 };
      if (args[0] === "show") return { stdout: "old content\n", code: 0 };
      return { stdout: "", code: 0 };
    });
    const files = { "/r/src/app.ts": "new content\n" };
    const fs = {
      readFile: vi.fn(async (p: string) => Buffer.from(files[p as keyof typeof files] ?? "")),
      writeFile: vi.fn(), readdir: vi.fn(), stat: vi.fn(async () => ({ size: 12 })),
    };
    const mgr = new WorkspaceManager({ fs: fs as never, resolveRoot: () => "/r", send: () => {}, watch: () => ({ close: () => {} }), exec });
    mgr.root({}); // seed "/r" as an allowed root (to pass the git cwd guard — same as the UI flow)
    return { mgr, exec, calls };
  }
  it("parses git status --porcelain into {path,status}", async () => {
    const { mgr } = gitSetup();
    expect(await mgr.gitStatus("/r")).toEqual([
      { path: "src/app.ts", status: "M" },
      { path: "new.ts", status: "?" },
      { path: "added.ts", status: "A" },
    ]);
  });
  it("gitDiff returns HEAD version and working version", async () => {
    const { mgr } = gitSetup();
    expect(await mgr.gitDiff("/r", "src/app.ts")).toEqual({ head: "old content\n", work: "new content\n" });
  });

  it("gitInfo parses branch/upstream/ahead·behind from porcelain v2", async () => {
    const exec = vi.fn(async () => ({ stdout: "# branch.head feature-x\n# branch.upstream origin/feature-x\n# branch.ab +3 -1\n", code: 0 }));
    const mgr = new WorkspaceManager({ fs: {} as never, resolveRoot: () => "/r", send: () => {}, watch: () => ({ close: () => {} }), exec });
    mgr.root({});
    expect(await mgr.gitInfo("/r")).toEqual({ branch: "feature-x", upstream: "origin/feature-x", ahead: 3, behind: 1 });
  });

  it("gitChanges splits X/Y and merges numstat +/-", async () => {
    const exec = vi.fn(async (_c: string, args: string[]) => {
      if (args[0] === "status") return { stdout: "M  src/app.ts\n?? new.ts\nMM lib/a.ts\n", code: 0 };
      if (args.includes("--numstat")) return { stdout: "10\t2\tsrc/app.ts\n5\t5\tlib/a.ts\n", code: 0 };
      return { stdout: "", code: 0 };
    });
    const mgr = new WorkspaceManager({ fs: {} as never, resolveRoot: () => "/r", send: () => {}, watch: () => ({ close: () => {} }), exec });
    mgr.root({});
    expect(await mgr.gitChanges("/r")).toEqual([
      { path: "src/app.ts", x: "M", y: " ", added: 10, deleted: 2 }, // staged
      { path: "new.ts", x: "?", y: "?", added: 0, deleted: 0 }, // untracked
      { path: "lib/a.ts", x: "M", y: "M", added: 5, deleted: 5 }, // staged+unstaged
    ]);
  });

  it("gitLog parses recent commits (NUL-ish field split), date as a locale-independent unix-seconds number (%ct)", async () => {
    const exec = vi.fn(async () => ({ stdout: "abc123\x1fabc\x1ffix app bug\x1fCChuYonng\x1f1750000000\ndef456\x1fdef\x1finit\x1fbob\x1f1750086400\n", code: 0 }));
    const mgr = new WorkspaceManager({ fs: {} as never, resolveRoot: () => "/r", send: () => {}, watch: () => ({ close: () => {} }), exec });
    mgr.root({});
    expect(await mgr.gitLog("/r", 50)).toEqual([
      { hash: "abc123", shortHash: "abc", subject: "fix app bug", author: "CChuYonng", date: 1750000000 },
      { hash: "def456", shortHash: "def", subject: "init", author: "bob", date: 1750086400 },
    ]);
  });

  it("gitCommitFiles merges numstat with name-status", async () => {
    const exec = vi.fn(async (_c: string, args: string[]) => {
      if (args.includes("--numstat")) return { stdout: "10\t2\tsrc/app.ts\n0\t5\told.ts\n", code: 0 };
      if (args.includes("--name-status")) return { stdout: "M\tsrc/app.ts\nD\told.ts\n", code: 0 };
      return { stdout: "", code: 0 };
    });
    const mgr = new WorkspaceManager({ fs: {} as never, resolveRoot: () => "/r", send: () => {}, watch: () => ({ close: () => {} }), exec });
    mgr.root({});
    expect(await mgr.gitCommitFiles("/r", "abc")).toEqual([
      { path: "src/app.ts", status: "M", added: 10, deleted: 2 },
      { path: "old.ts", status: "D", added: 0, deleted: 5 },
    ]);
  });

  it("gitCommitInfo parses full commit detail incl. multi-line body", async () => {
    const exec = vi.fn(async () => ({ stdout: "abc123\x1fabc\x1fCChuYonng\x1fc@x.com\x1f2026-06-21 10:00\x1ffix app\x1fdetail line 1\ndetail line 2\n", code: 0 }));
    const mgr = new WorkspaceManager({ fs: {} as never, resolveRoot: () => "/r", send: () => {}, watch: () => ({ close: () => {} }), exec });
    mgr.root({});
    expect(await mgr.gitCommitInfo("/r", "abc123")).toEqual({
      hash: "abc123", shortHash: "abc", author: "CChuYonng", email: "c@x.com", date: "2026-06-21 10:00",
      subject: "fix app", body: "detail line 1\ndetail line 2",
    });
  });

  it("gitShowFileDiff returns parent and commit versions", async () => {
    const exec = vi.fn(async (_c: string, args: string[]) => {
      if (args[1] === "abc^:src/app.ts") return { stdout: "old\n", code: 0 };
      if (args[1] === "abc:src/app.ts") return { stdout: "new\n", code: 0 };
      return { stdout: "", code: 1 };
    });
    const mgr = new WorkspaceManager({ fs: {} as never, resolveRoot: () => "/r", send: () => {}, watch: () => ({ close: () => {} }), exec });
    mgr.root({});
    expect(await mgr.gitShowFileDiff("/r", "abc", "src/app.ts")).toEqual({ before: "old\n", after: "new\n" });
  });

  it("git actions run the right commands; surface stderr on failure", async () => {
    const calls: string[][] = [];
    const exec = vi.fn(async (_c: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "commit") return { stdout: "", stderr: "nothing to commit", code: 1 };
      return { stdout: "", code: 0 };
    });
    const mgr = new WorkspaceManager({ fs: {} as never, resolveRoot: () => "/r", send: () => {}, watch: () => ({ close: () => {} }), exec });
    mgr.root({});
    expect(await mgr.gitStage("/r", "a.ts")).toEqual({ ok: true });
    expect(await mgr.gitUnstage("/r", "a.ts")).toEqual({ ok: true });
    expect(await mgr.gitDiscard("/r", "a.ts", false)).toEqual({ ok: true });
    expect(await mgr.gitDiscard("/r", "u.ts", true)).toEqual({ ok: true });
    expect(await mgr.gitCommit("/r", "msg")).toEqual({ ok: false, error: "nothing to commit" });
    expect(calls).toEqual([
      ["add", "--", "a.ts"],
      ["restore", "--staged", "--", "a.ts"],
      ["checkout", "HEAD", "--", "a.ts"],
      ["clean", "-f", "--", "u.ts"],
      ["commit", "-m", "msg"],
    ]);
  });

  it("confines git cwd to allowed roots — rejects out-of-root cwd and never touches exec", async () => {
    const { mgr, exec } = gitSetup(); // only "/r" is seeded
    // for both reads and actions, a cwd outside the work root makes the guard throw → never reaches exec (blocks running git on arbitrary paths).
    await expect(mgr.gitStatus("/etc")).rejects.toThrow();
    await expect(mgr.gitInfo("/etc")).rejects.toThrow();
    await expect(mgr.gitChanges("/etc")).rejects.toThrow();
    await expect(mgr.gitLog("/etc")).rejects.toThrow();
    await expect(mgr.gitDiff("/etc", "x")).rejects.toThrow();
    await expect(mgr.gitShowFileDiff("/etc", "abc", "x")).rejects.toThrow();
    await expect(mgr.gitCommitFiles("/etc", "abc")).rejects.toThrow();
    await expect(mgr.gitCommitInfo("/etc", "abc")).rejects.toThrow();
    await expect(mgr.gitStage("/etc", "a.ts")).rejects.toThrow();
    await expect(mgr.gitCommit("/etc", "msg")).rejects.toThrow();
    await expect(mgr.gitPush("/r/../etc")).rejects.toThrow(); // .. escape
    expect(exec).not.toHaveBeenCalled();
  });
});
