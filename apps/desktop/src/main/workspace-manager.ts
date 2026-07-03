import path from "node:path";
import { mt } from "./i18n.js";

export interface WsFs {
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, content: string): Promise<void>;
  readdir(path: string): Promise<Array<{ name: string; isDirectory: () => boolean }>>;
  stat(path: string): Promise<{ size: number }>;
}

export interface WorkspaceManagerDeps {
  fs: WsFs;
  resolveRoot: (opts: { subId?: string; cwd?: string }) => string;
  homeDir?: string; // For ~ expansion (browse in chat @ path autocomplete). Falls back to base if absent.
  send: (channel: "fs:changed" | "fs:tree", payload: unknown) => void;
  watch: (path: string, cb: () => void) => { close: () => void };
  // Recursive root watch (for auto-reflecting agent file changes). rel is the changed file's relative path (or null).
  watchDir?: (root: string, cb: (rel: string | null) => void) => { close: () => void };
  exec?: (cmd: string, args: string[], cwd: string) => Promise<{ stdout: string; code: number; stderr?: string }>;
  mkdir?: (p: string) => Promise<void>;
  rename?: (from: string, to: string) => Promise<void>;
  trash?: (p: string) => Promise<void>;
  maxBytes?: number;
  imageMaxBytes?: number; // Image preview upper limit (larger than text). Default 25MB.
  treeDebounceMs?: number;
}

// Extension → image MIME. Only extensions listed here are eligible for image preview.
const IMAGE_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", ico: "image/x-icon", avif: "image/avif",
};

export class WorkspaceManager {
  private readonly d: WorkspaceManagerDeps;
  private readonly maxBytes: number;
  private readonly imageMaxBytes: number;
  // File watcher + refcount: when the same path is opened from multiple places (multiple tabs/pages), keep only one watch and manage it via a count.
  // (Without refcount, if unwatch always closes, closing one place kills the watch for other places still viewing it.)
  private readonly watchers = new Map<string, { close: () => void; count: number }>();
  // Per-root recursive watcher + debounce timer (tree/git auto-refresh).
  private readonly treeWatchers = new Map<string, { close: () => void }>();
  private readonly treeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly treeDebounceMs: number;
  // Allowed work roots (those resolved via root()). fs operations must be inside one of these (prevents path escape).
  private readonly allowedRoots = new Set<string>();

  constructor(deps: WorkspaceManagerDeps) {
    this.d = deps;
    this.maxBytes = deps.maxBytes ?? 1_000_000;
    this.imageMaxBytes = deps.imageMaxBytes ?? 25_000_000;
    this.treeDebounceMs = deps.treeDebounceMs ?? 200;
  }

  // Checks whether target is inside an allowed root. Otherwise throws (blocks the renderer from accessing system files via arbitrary absolute paths/.. escapes).
  // The normal flow always calls resolveRoot(=root()) first, so allowedRoots is populated.
  private guard(target: string): string {
    const t = path.resolve(target);
    for (const r of this.allowedRoots) {
      if (t === r || t.startsWith(r + path.sep)) return t;
    }
    throw new Error(mt("workspace.outsideRoot", { path: target }));
  }

  // git-family cwd isolation: before passing cwd to exec, check it is inside an allowed root (same invariant as the fs guard).
  // Since cwd is a directory, t===r (the root itself) also passes. If outside, throw → blocks running git from an arbitrary path.
  private guardCwd(cwd: string): string {
    return this.guard(cwd);
  }

  // Recursive root watch: filters out .git/ and node_modules/ noise, then emits fs:tree once after debounce.
  watchTree(root: string): void {
    if (!this.d.watchDir || this.treeWatchers.has(root)) return;
    const w = this.d.watchDir(root, (rel) => {
      if (rel === null) return; // Meaningless signal
      const r = rel.replace(/\\/g, "/"); // Windows fs.watch reports backslash-separated paths; normalize so the filters below match
      if (/(^|\/)node_modules(\/|$)/.test(r)) return; // Ignore node_modules
      if (/(^|\/)\.git(\/|$)/.test(r)) {
        // Most of .git is noise (objects/logs/lock), but commit/stage/checkout change git state
        // (index/HEAD/refs etc.) → let only these through so the Git panel auto-refreshes even after a commit.
        const meta = /(^|\/)\.git\/(index|HEAD|ORIG_HEAD|MERGE_HEAD|FETCH_HEAD|packed-refs|refs\/)/.test(r);
        if (!meta || /\.lock$/.test(r)) return;
      }
      const prev = this.treeTimers.get(root);
      if (prev) clearTimeout(prev);
      this.treeTimers.set(root, setTimeout(() => {
        this.treeTimers.delete(root);
        this.d.send("fs:tree", { root });
      }, this.treeDebounceMs));
    });
    this.treeWatchers.set(root, w);
  }

  unwatchTree(root: string): void {
    this.treeWatchers.get(root)?.close();
    this.treeWatchers.delete(root);
    const t = this.treeTimers.get(root);
    if (t) { clearTimeout(t); this.treeTimers.delete(root); }
  }

  root(opts: { subId?: string; cwd?: string }): string {
    const r = this.d.resolveRoot(opts);
    this.allowedRoots.add(path.resolve(r)); // Register the resolved root in the allowlist (the fence for subsequent fs operations)
    return r;
  }

  async list(dir: string): Promise<Array<{ name: string; isDir: boolean }>> {
    this.guard(dir);
    const ents = await this.d.fs.readdir(dir);
    return ents
      .filter((e) => e.name !== ".git")
      .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
      .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
  }

  // Directory listing for chat @ path autocomplete. Unlike list(), no guard (read-only) — because it must also
  // browse home (`~/`) and absolute paths (`/`) (within the local single-user trust boundary; readdir/stat only, no write/exec path).
  // dir: "" → work root, "~"/"~/…" → relative to home, absolute paths pass through, otherwise relative to the work root.
  async browse(opts: { dir: string; subId?: string; cwd?: string }): Promise<{ dir: string; entries: Array<{ name: string; isDir: boolean; size?: number }>; error?: string }> {
    const base = this.d.resolveRoot({ subId: opts.subId, cwd: opts.cwd });
    const abs = this.resolveBrowseDir(base, opts.dir);
    let ents: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      ents = await this.d.fs.readdir(abs);
    } catch (e) {
      return { dir: abs, entries: [], error: (e as NodeJS.ErrnoException).code ?? "EUNKNOWN" };
    }
    const BROWSE_CAP = 1000; // Guard against huge directories (node_modules etc.) — single-level listing so usually small, but cap it.
    const sorted = ents
      .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
      .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)))
      .slice(0, BROWSE_CAP);
    const entries: Array<{ name: string; isDir: boolean; size?: number }> = [];
    for (const e of sorted) {
      if (e.isDir) { entries.push(e); continue; } // Avoid the cost of computing folder size (drill-in only)
      try { entries.push({ ...e, size: (await this.d.fs.stat(path.join(abs, e.name))).size }); }
      catch { entries.push(e); } // Keep the entry even if stat fails (name/type only)
    }
    return { dir: abs, entries };
  }

  // Path resolution for browse (no guard). "" → base, "~"/"~/…" → home, absolute → as-is, relative → relative to base.
  private resolveBrowseDir(base: string, dir: string): string {
    if (dir === "") return path.resolve(base);
    if (dir === "~" || dir.startsWith("~/")) return path.resolve(path.join(this.d.homeDir ?? base, dir.slice(1)));
    if (path.isAbsolute(dir)) return path.resolve(dir);
    return path.resolve(base, dir);
  }

  async read(p: string): Promise<{ content: string; tooLarge: boolean }> {
    this.guard(p);
    const st = await this.d.fs.stat(p);
    if (st.size > this.maxBytes) return { content: "", tooLarge: true };
    const buf = await this.d.fs.readFile(p);
    if (buf.includes(0)) return { content: "", tooLarge: true }; // NUL → binary
    return { content: buf.toString("utf8"), tooLarge: false };
  }

  // Reads an image file as a base64 data URL (renderer previews it via <img>). In dev the origin is http so file:// can't be used, hence the data URL.
  async readImage(p: string): Promise<{ dataUrl?: string; tooLarge?: boolean; unsupported?: boolean }> {
    this.guard(p);
    const mime = IMAGE_MIME[p.split(".").pop()?.toLowerCase() ?? ""];
    if (!mime) return { unsupported: true };
    const st = await this.d.fs.stat(p);
    if (st.size > this.imageMaxBytes) return { tooLarge: true };
    const buf = await this.d.fs.readFile(p);
    return { dataUrl: `data:${mime};base64,${buf.toString("base64")}` };
  }

  async write(p: string, content: string): Promise<{ ok: boolean }> {
    this.guard(p);
    await this.d.fs.writeFile(p, content);
    return { ok: true };
  }

  async mkdir(p: string): Promise<{ ok: boolean }> {
    this.guard(p);
    if (!this.d.mkdir) throw new Error(mt("mkdir.unsupported"));
    await this.d.mkdir(p);
    return { ok: true };
  }

  // Creates an empty file. If a file with the same name already exists, reject instead of overwriting (data protection).
  async createFile(p: string): Promise<{ ok: boolean; exists?: boolean }> {
    this.guard(p);
    const dir = path.dirname(p);
    const name = path.basename(p);
    const ents = await this.d.fs.readdir(dir);
    if (ents.some((e) => e.name === name)) return { ok: false, exists: true };
    await this.d.fs.writeFile(p, "");
    return { ok: true };
  }

  async rename(from: string, to: string): Promise<{ ok: boolean }> {
    this.guard(from);
    this.guard(to);
    if (!this.d.rename) throw new Error(mt("rename.unsupported"));
    await this.d.rename(from, to);
    return { ok: true };
  }

  // Sends to the OS trash (recoverable). Not a permanent delete.
  async trash(p: string): Promise<{ ok: boolean }> {
    this.guard(p);
    if (!this.d.trash) throw new Error(mt("trash.unsupported"));
    await this.d.trash(p);
    return { ok: true };
  }

  // Recursively collects file paths relative to root (files only). Does not descend into .git/node_modules. For the finder (Go-to-file).
  async walk(root: string): Promise<{ paths: string[]; truncated: boolean }> {
    this.guard(root);
    const WALK_CAP = 10_000;
    const out: string[] = [];
    const stack: string[] = [root];
    let truncated = false;
    while (stack.length > 0) {
      const dir = stack.pop() as string;
      let ents: Array<{ name: string; isDirectory: () => boolean }>;
      try { ents = await this.d.fs.readdir(dir); } catch { continue; }
      for (const e of ents) {
        if (e.name === ".git" || e.name === "node_modules") continue;
        const abs = `${dir}/${e.name}`;
        if (e.isDirectory()) { stack.push(abs); continue; }
        if (out.length >= WALK_CAP) { truncated = true; continue; }
        out.push(abs.slice(root.length + 1)); // Strip root prefix + "/" → relative path
      }
    }
    return { paths: out, truncated };
  }

  watchFile(p: string): void {
    try { this.guard(p); } catch { return; } // Don't watch paths outside the work folder (silently — this is fire-and-forget IPC, so throwing would become uncaught)
    const existing = this.watchers.get(p);
    if (existing) { existing.count++; return; } // Already watching → just increment refcount (avoid duplicate watch)
    const w = this.d.watch(p, () => this.d.send("fs:changed", { path: p }));
    this.watchers.set(p, { close: w.close, count: 1 });
  }

  unwatchFile(path: string): void {
    const w = this.watchers.get(path);
    if (!w) return;
    if (--w.count > 0) return; // Keep the watch if other subscribers remain
    w.close();
    this.watchers.delete(path);
  }

  closeAll(): void {
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    for (const w of this.treeWatchers.values()) w.close();
    this.treeWatchers.clear();
    for (const t of this.treeTimers.values()) clearTimeout(t);
    this.treeTimers.clear();
  }

  async gitStatus(cwd: string): Promise<Array<{ path: string; status: string }>> {
    this.guardCwd(cwd);
    if (!this.d.exec) return [];
    const { stdout, code } = await this.d.exec("git", ["status", "--porcelain=v1"], cwd);
    if (code !== 0) return [];
    return stdout.split("\n").filter(Boolean).map((line) => {
      const xy = line.slice(0, 2);
      const path = line.slice(3).replace(/^.* -> /, ""); // rename "old -> new" → new
      const status = xy.includes("?") ? "?" : (xy.trim()[0] ?? "M");
      return { path, status };
    });
  }

  async gitDiff(cwd: string, path: string): Promise<{ head: string; work: string }> {
    this.guardCwd(cwd);
    let head = "";
    if (this.d.exec) {
      const r = await this.d.exec("git", ["show", `HEAD:${path}`], cwd);
      if (r.code === 0) head = r.stdout;
    }
    let work = "";
    try { work = (await this.d.fs.readFile(`${cwd}/${path}`)).toString("utf8"); } catch { /* deleted */ }
    return { head, work };
  }

  // branch/upstream/ahead·behind — parses porcelain v2 --branch's `# branch.*` headers.
  async gitInfo(cwd: string): Promise<{ branch: string; ahead: number; behind: number; upstream: string | null }> {
    this.guardCwd(cwd);
    const empty = { branch: "", ahead: 0, behind: 0, upstream: null as string | null };
    if (!this.d.exec) return empty;
    const { stdout, code } = await this.d.exec("git", ["status", "--porcelain=v2", "--branch"], cwd);
    if (code !== 0) return empty;
    let branch = "", upstream: string | null = null, ahead = 0, behind = 0;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("# branch.head ")) branch = line.slice(14).trim();
      else if (line.startsWith("# branch.upstream ")) upstream = line.slice(18).trim();
      else if (line.startsWith("# branch.ab ")) {
        const m = line.match(/\+(\d+)\s+-(\d+)/);
        if (m) { ahead = Number(m[1]); behind = Number(m[2]); }
      }
    }
    return { branch, ahead, behind, upstream };
  }

  // Change list — preserves porcelain v1's X(index)/Y(worktree) separately + merges +/− line counts vs HEAD (numstat).
  async gitChanges(cwd: string): Promise<Array<{ path: string; x: string; y: string; added: number; deleted: number }>> {
    this.guardCwd(cwd);
    if (!this.d.exec) return [];
    const { stdout, code } = await this.d.exec("git", ["status", "--porcelain=v1"], cwd);
    if (code !== 0) return [];
    const numstat = new Map<string, { added: number; deleted: number }>();
    const ns = await this.d.exec("git", ["diff", "HEAD", "--numstat"], cwd);
    if (ns.code === 0) {
      for (const l of ns.stdout.split("\n").filter(Boolean)) {
        const [a, d, ...rest] = l.split("\t");
        const p = rest.join("\t").replace(/^.* => /, "").replace(/[{}]/g, "");
        numstat.set(p, { added: a === "-" ? 0 : Number(a) || 0, deleted: d === "-" ? 0 : Number(d) || 0 });
      }
    }
    return stdout.split("\n").filter(Boolean).map((line) => {
      const x = line[0] ?? " ";
      const y = line[1] ?? " ";
      const path = line.slice(3).replace(/^.* -> /, "");
      const n = numstat.get(path) ?? { added: 0, deleted: 0 };
      return { path, x, y, added: n.added, deleted: n.deleted };
    });
  }

  // Recent commit history. Fields are separated by \x1f (unit sep), commits by newline (%s is a single line).
  // %ct (committer date, unix seconds) is locale-independent — unlike %cr ("2 hours ago"), which follows git/OS locale
  // regardless of the app's UI language. The renderer formats `date` via its own relativeTime()+i18n so it follows the app locale.
  async gitLog(cwd: string, limit = 50): Promise<Array<{ hash: string; shortHash: string; subject: string; author: string; date: number }>> {
    this.guardCwd(cwd);
    if (!this.d.exec) return [];
    const { stdout, code } = await this.d.exec("git", ["log", "-n", String(limit), "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ct"], cwd);
    if (code !== 0) return [];
    return stdout.split("\n").filter(Boolean).map((line) => {
      const [hash, shortHash, subject, author, date] = line.split("\x1f");
      return { hash, shortHash, subject, author, date: Number(date) };
    });
  }

  // List of files changed by a commit + status + numstat(+/−). Treats numstat as the source of truth, augmenting status letters from name-status.
  async gitCommitFiles(cwd: string, hash: string): Promise<Array<{ path: string; status: string; added: number; deleted: number }>> {
    this.guardCwd(cwd);
    if (!this.d.exec) return [];
    const ns = await this.d.exec("git", ["show", hash, "--numstat", "--format="], cwd);
    if (ns.code !== 0) return [];
    const nameStatus = await this.d.exec("git", ["show", hash, "--name-status", "--format="], cwd);
    const statusMap = new Map<string, string>();
    if (nameStatus.code === 0) {
      for (const l of nameStatus.stdout.split("\n").filter(Boolean)) {
        const parts = l.split("\t");
        statusMap.set(parts[parts.length - 1], parts[0][0] ?? "M"); // for rename, last = new path
      }
    }
    return ns.stdout.split("\n").filter(Boolean).map((l) => {
      const [a, d, ...rest] = l.split("\t");
      const path = rest.join("\t").replace(/^.* => /, "").replace(/[{}]/g, "");
      return { path, status: statusMap.get(path) ?? "M", added: a === "-" ? 0 : Number(a) || 0, deleted: d === "-" ? 0 : Number(d) || 0 };
    });
  }

  // Commit detail (including the message body). Since %b is the last field, newlines/separators inside the body have no effect.
  async gitCommitInfo(cwd: string, hash: string): Promise<{ hash: string; shortHash: string; author: string; email: string; date: string; subject: string; body: string }> {
    this.guardCwd(cwd);
    const empty = { hash: "", shortHash: "", author: "", email: "", date: "", subject: "", body: "" };
    if (!this.d.exec) return empty;
    const { stdout, code } = await this.d.exec("git", ["show", "-s", "--date=format:%Y-%m-%d %H:%M", "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%b", hash], cwd);
    if (code !== 0) return empty;
    const [h, sh, author, email, date, subject, ...body] = stdout.split("\x1f");
    return { hash: h ?? "", shortHash: sh ?? "", author: author ?? "", email: email ?? "", date: date ?? "", subject: subject ?? "", body: body.join("\x1f").trim() };
  }

  // Parent↔commit content for a specific file in a commit (for the diff view). For a root commit/added file before="", for a deleted file after="".
  async gitShowFileDiff(cwd: string, hash: string, path: string): Promise<{ before: string; after: string }> {
    this.guardCwd(cwd);
    let before = "", after = "";
    if (this.d.exec) {
      const b = await this.d.exec("git", ["show", `${hash}^:${path}`], cwd);
      if (b.code === 0) before = b.stdout;
      const a = await this.d.exec("git", ["show", `${hash}:${path}`], cwd);
      if (a.code === 0) after = a.stdout;
    }
    return { before, after };
  }

  // Shared runner for actions — on failure, uses stderr (or stdout if absent) as the error.
  private async git(cwd: string, args: string[]): Promise<{ ok: boolean; error?: string }> {
    this.guardCwd(cwd);
    if (!this.d.exec) return { ok: false, error: mt("git.unavailable") };
    const r = await this.d.exec("git", args, cwd);
    return r.code === 0 ? { ok: true } : { ok: false, error: (r.stderr || r.stdout || mt("git.commandFailed")).trim() };
  }

  gitStage(cwd: string, path: string): Promise<{ ok: boolean; error?: string }> { return this.git(cwd, ["add", "--", path]); }
  gitUnstage(cwd: string, path: string): Promise<{ ok: boolean; error?: string }> { return this.git(cwd, ["restore", "--staged", "--", path]); }
  gitStageAll(cwd: string): Promise<{ ok: boolean; error?: string }> { return this.git(cwd, ["add", "-A"]); }
  // Discard: if untracked, remove the file (clean); otherwise restore to HEAD (both staged and worktree).
  gitDiscard(cwd: string, path: string, untracked: boolean): Promise<{ ok: boolean; error?: string }> {
    return untracked ? this.git(cwd, ["clean", "-f", "--", path]) : this.git(cwd, ["checkout", "HEAD", "--", path]);
  }
  gitCommit(cwd: string, message: string): Promise<{ ok: boolean; error?: string }> { return this.git(cwd, ["commit", "-m", message]); }
  gitPush(cwd: string): Promise<{ ok: boolean; error?: string }> { return this.git(cwd, ["push"]); }
}
