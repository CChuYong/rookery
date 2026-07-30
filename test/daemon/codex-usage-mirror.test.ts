import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncCodexUsageMirror, syncCodexUsageMirrorForTarget } from "../../src/daemon/codex-usage-mirror.js";

let tmp: string;
let rookeryHome: string;
let realCodexHome: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-test-"));
  rookeryHome = path.join(tmp, "rookery");
  realCodexHome = path.join(tmp, "codex");
  fs.mkdirSync(realCodexHome, { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Writes a rollout into a rookery codex home and returns its absolute path.
function writeRollout(homeName: string, rel: string, content = '{"type":"session_meta"}\n'): string {
  const file = path.join(rookeryHome, "codex-homes", homeName, "sessions", rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}
const mirrored = (rel: string): string => path.join(realCodexHome, "archived_sessions", rel);

describe("syncCodexUsageMirror", () => {
  it("hardlinks every home's rollouts under archived_sessions, preserving the sessions-relative path", () => {
    const a = writeRollout("019f-master", "2026/07/06/rollout-a.jsonl");
    const b = writeRollout("worker-abc", "2026/07/30/rollout-b.jsonl");

    const result = syncCodexUsageMirror(rookeryHome, realCodexHome);

    expect(result).toEqual({ linked: 2, skipped: 0, failed: 0 });
    expect(fs.existsSync(mirrored("2026/07/06/rollout-a.jsonl"))).toBe(true);
    expect(fs.existsSync(mirrored("2026/07/30/rollout-b.jsonl"))).toBe(true);
    // Same inode is what makes a live worker's ongoing appends show up with no re-sync.
    expect(fs.statSync(mirrored("2026/07/06/rollout-a.jsonl")).ino).toBe(fs.statSync(a).ino);
    expect(fs.statSync(mirrored("2026/07/30/rollout-b.jsonl")).ino).toBe(fs.statSync(b).ino);
  });

  it("counts an already-mirrored rollout as skipped, so fork-ancestor copies in two homes are deduped", () => {
    // A codex fork copies the ancestor rollout into the new target's home, so the SAME relative path
    // legitimately exists twice. Linking it once is what keeps the token total from double-counting.
    const rel = "2026/07/09/rollout-shared.jsonl";
    writeRollout("worker-one", rel);
    writeRollout("worker-two", rel);

    const result = syncCodexUsageMirror(rookeryHome, realCodexHome);

    expect(result.linked).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("is idempotent", () => {
    writeRollout("worker-abc", "2026/07/30/rollout-b.jsonl");
    syncCodexUsageMirror(rookeryHome, realCodexHome);

    expect(syncCodexUsageMirror(rookeryHome, realCodexHome)).toEqual({ linked: 0, skipped: 1, failed: 0 });
  });

  it("reflects appends to an already-mirrored rollout", () => {
    const file = writeRollout("worker-abc", "2026/07/30/rollout-b.jsonl", "first\n");
    syncCodexUsageMirror(rookeryHome, realCodexHome);

    fs.appendFileSync(file, "second\n");

    expect(fs.readFileSync(mirrored("2026/07/30/rollout-b.jsonl"), "utf8")).toBe("first\nsecond\n");
  });

  it("falls back to copying when link reports EXDEV, and refreshes a stale copy", () => {
    const file = writeRollout("worker-abc", "2026/07/30/rollout-b.jsonl", "first\n");
    const exdev = (): never => {
      const err = new Error("cross-device link") as NodeJS.ErrnoException;
      err.code = "EXDEV";
      throw err;
    };

    expect(syncCodexUsageMirror(rookeryHome, realCodexHome, { link: exdev })).toEqual({ linked: 1, skipped: 0, failed: 0 });
    const dest = mirrored("2026/07/30/rollout-b.jsonl");
    expect(fs.readFileSync(dest, "utf8")).toBe("first\n");
    expect(fs.statSync(dest).ino).not.toBe(fs.statSync(file).ino); // a copy, not a link

    // Unchanged source → nothing to do.
    expect(syncCodexUsageMirror(rookeryHome, realCodexHome, { link: exdev })).toEqual({ linked: 0, skipped: 1, failed: 0 });

    // A copy cannot follow appends, so a grown source must be re-copied.
    fs.appendFileSync(file, "second\n");
    expect(syncCodexUsageMirror(rookeryHome, realCodexHome, { link: exdev })).toEqual({ linked: 1, skipped: 0, failed: 0 });
    expect(fs.readFileSync(dest, "utf8")).toBe("first\nsecond\n");
  });

  it("never throws when codex-homes is missing or a home is unreadable", () => {
    expect(syncCodexUsageMirror(path.join(tmp, "nope"), realCodexHome)).toEqual({ linked: 0, skipped: 0, failed: 0 });

    writeRollout("worker-abc", "2026/07/30/rollout-b.jsonl");
    const unreadable = path.join(rookeryHome, "codex-homes", "worker-locked", "sessions");
    fs.mkdirSync(unreadable, { recursive: true });
    fs.chmodSync(unreadable, 0o000);
    try {
      expect(syncCodexUsageMirror(rookeryHome, realCodexHome).linked).toBe(1);
    } finally {
      fs.chmodSync(unreadable, 0o700); // let afterEach clean up
    }
  });

  it("creates the mirror root even when the real codex home does not exist yet", () => {
    writeRollout("worker-abc", "2026/07/30/rollout-b.jsonl");
    const fresh = path.join(tmp, "codex-fresh");

    expect(syncCodexUsageMirror(rookeryHome, fresh).linked).toBe(1);
    expect(fs.existsSync(path.join(fresh, "archived_sessions", "2026/07/30/rollout-b.jsonl"))).toBe(true);
  });

  it("ignores non-rollout files", () => {
    const home = path.join(rookeryHome, "codex-homes", "worker-abc", "sessions");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "notes.txt"), "x");

    expect(syncCodexUsageMirror(rookeryHome, realCodexHome)).toEqual({ linked: 0, skipped: 0, failed: 0 });
  });

  it("mirrors only the named target, resolving the worker- prefix like codexHomeDirFor", () => {
    writeRollout("worker-abc", "2026/07/30/rollout-worker.jsonl");
    writeRollout("019f-master", "2026/07/06/rollout-master.jsonl");

    const worker = syncCodexUsageMirrorForTarget(rookeryHome, realCodexHome, "abc", "worker");

    expect(worker).toEqual({ linked: 1, skipped: 0, failed: 0 });
    expect(fs.existsSync(mirrored("2026/07/30/rollout-worker.jsonl"))).toBe(true);
    expect(fs.existsSync(mirrored("2026/07/06/rollout-master.jsonl"))).toBe(false);

    const master = syncCodexUsageMirrorForTarget(rookeryHome, realCodexHome, "019f-master", "master");

    expect(master).toEqual({ linked: 1, skipped: 0, failed: 0 });
    expect(fs.existsSync(mirrored("2026/07/06/rollout-master.jsonl"))).toBe(true);
  });

  it("never throws for a target whose home is already gone", () => {
    expect(syncCodexUsageMirrorForTarget(rookeryHome, realCodexHome, "vanished", "worker"))
      .toEqual({ linked: 0, skipped: 0, failed: 0 });
  });
});
