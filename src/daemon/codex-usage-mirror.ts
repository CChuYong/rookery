import fs from "node:fs";
import path from "node:path";
import { codexHomeDirFor } from "./codex-home.js";

// Accounting mirror (docs/superpowers/specs/2026-07-30-codex-usage-mirror-design.md). `ccusage codex`
// scans ONE CODEX_HOME, while rookery gives every codex master/worker its own home under
// <ROOKERY_HOME>/codex-homes — so none of that spend shows up in the user's usage report. This module
// hardlinks each home's rollouts into the real home under `archived_sessions/`, which ccusage counts
// while codex keeps archived rollouts out of `thread/list` and refuses to resume them (verified against
// codex-cli 0.145.0 by scripts/probe-codex-usage-mirror.mjs). The runtime homes are NOT touched:
// config.toml (carrying the per-session MCP bridge token), auth.json, and the state/memories sqlite
// stay isolated per target — see codex-home.ts.
//
// A hardlink shares the inode, so a LIVE worker's ongoing appends are reflected with no re-sync; the
// periodic sweep exists only to notice new rollout FILES. Nothing here ever deletes: once mirrored, a
// rollout survives its home's `rm -rf`, which is what preserves usage history for deleted workers.

const MIRROR_DIR = "archived_sessions";

export interface CodexUsageMirrorResult {
  linked: number; // newly mirrored on this pass
  relinked: number; // re-pointed at a longer copy of a rollout already mirrored from another home
  skipped: number; // already mirrored and already the longest copy — the dedup for fork-ancestor copies
  failed: number; // per-file failure; the sweep continues
}

export interface CodexUsageMirrorDeps {
  // Defaults to fs.linkSync. Injectable so the cross-device fallback is testable on a single volume.
  link?: (src: string, dest: string) => void;
}

const EMPTY: CodexUsageMirrorResult = { linked: 0, relinked: 0, skipped: 0, failed: 0 };
const zero = (): CodexUsageMirrorResult => ({ ...EMPTY });

// Mirrors every rookery codex home. Best-effort and never throws: a missing codex-homes dir, an
// unreadable home, EACCES on the real home, ENOSPC — all degrade to counters.
export function syncCodexUsageMirror(
  rookeryHome: string,
  realCodexHome: string,
  deps: CodexUsageMirrorDeps = {},
): CodexUsageMirrorResult {
  const base = path.join(rookeryHome, "codex-homes");
  let names: string[];
  try {
    names = fs.readdirSync(base);
  } catch {
    return zero(); // no codex target has ever run
  }
  const total = zero();
  // Sorted so a sweep is reproducible: with two homes holding copies of one rollout, which is walked
  // first decides whether a link or a re-point happens. The end state is the same either way, but a
  // deterministic order keeps the counters (and the log line) stable.
  for (const name of names.sort()) {
    add(total, mirrorHome(path.join(base, name), realCodexHome, deps));
  }
  return total;
}

// Mirrors ONE target's home. Called immediately before a session/worker delete removes that home, so
// the usage record outlives the directory.
export function syncCodexUsageMirrorForTarget(
  rookeryHome: string,
  realCodexHome: string,
  targetId: string,
  kind: "master" | "worker",
  deps: CodexUsageMirrorDeps = {},
): CodexUsageMirrorResult {
  return mirrorHome(codexHomeDirFor(rookeryHome, targetId, kind), realCodexHome, deps);
}

function add(into: CodexUsageMirrorResult, from: CodexUsageMirrorResult): void {
  into.linked += from.linked;
  into.relinked += from.relinked;
  into.skipped += from.skipped;
  into.failed += from.failed;
}

function mirrorHome(homeDir: string, realCodexHome: string, deps: CodexUsageMirrorDeps): CodexUsageMirrorResult {
  const sessions = path.join(homeDir, "sessions");
  const result = zero();
  const link = deps.link ?? ((src: string, dest: string): void => fs.linkSync(src, dest));
  for (const file of rolloutFiles(sessions)) {
    // path.relative — NOT prefix stripping, which produced an archived_sessions/Users/... tree during
    // the design PoC.
    const dest = path.join(realCodexHome, MIRROR_DIR, path.relative(sessions, file));
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      link(file, dest);
      result.linked++;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") add(result, resolveExisting(file, dest, link));
      else if (code === "EXDEV") add(result, copyAcrossDevices(file, dest));
      else result.failed++;
    }
  }
  return result;
}

// This rollout path is already mirrored — but not necessarily from the copy that is still growing.
// A codex fork COPIES the ancestor rollout into the new target's home (codex-home.ts's
// seedCodexTargetThreadFromHome) and then keeps appending to ITS copy, so one relative path can name a
// frozen snapshot in one home and the live file in another. Whichever home the sweep walked first won,
// and a running worker's spend then never reached the report — observed live at 55,301,326 tokens
// across 3 paths. Rollouts are append-only, so the largest copy is the most complete one: re-point to
// it. That is also why re-pointing cannot double-count — the mirror still holds exactly one link per
// rollout path, and ccusage already ignores the fork-inherited prefix the copies share.
function resolveExisting(
  file: string,
  dest: string,
  link: (src: string, dest: string) => void,
): CodexUsageMirrorResult {
  try {
    const src = fs.statSync(file);
    const existing = fs.statSync(dest);
    // Same inode: already the live file. Not longer: the mirror is the better copy. Either way, done.
    if (existing.ino === src.ino || existing.size >= src.size) return { ...EMPTY, skipped: 1 };
    // Link to a temp name and rename over the mirror, so ccusage never observes a missing rollout.
    const tmp = `${dest}.mirror-${process.pid}-${existing.ino}`;
    try {
      link(file, tmp);
      fs.renameSync(tmp, dest);
      return { ...EMPTY, relinked: 1 };
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
      if ((err as NodeJS.ErrnoException).code === "EXDEV") return copyAcrossDevices(file, dest);
      return { ...EMPTY, failed: 1 };
    }
  } catch {
    return { ...EMPTY, failed: 1 };
  }
}

// The mirror root is on another volume, so no inode can be shared. Copy instead, and re-copy whenever
// the source has grown or changed — a copy cannot follow a live rollout's appends, so its freshness is
// only ever as good as the last sweep.
function copyAcrossDevices(file: string, dest: string): CodexUsageMirrorResult {
  try {
    const src = fs.statSync(file);
    let stale = true;
    try {
      const existing = fs.statSync(dest);
      stale = existing.size !== src.size || existing.mtimeMs < src.mtimeMs;
    } catch {
      /* destination absent → copy */
    }
    if (!stale) return { ...EMPTY, skipped: 1 };
    fs.copyFileSync(file, dest);
    fs.chmodSync(dest, 0o600);
    return { ...EMPTY, linked: 1 };
  } catch {
    return { ...EMPTY, failed: 1 };
  }
}

// Recursive walk of a home's sessions/ tree, mirroring codex-home.ts's rolloutFiles: an unreadable
// directory is skipped rather than fatal.
function rolloutFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(file);
    }
  };
  visit(root);
  return files;
}
