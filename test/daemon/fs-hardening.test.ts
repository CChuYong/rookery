import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { secureFilePaths, secureDirPaths, secureHome } from "../../src/daemon/fs-hardening.js";

function cfg(home: string) {
  return { home, dbPath: path.join(home, "rookery.db"), pidPath: path.join(home, "daemon.pid"), tokenPath: path.join(home, "ws-token"), fleet: { worktreesDir: path.join(home, "worktrees") } };
}

describe("secure path lists", () => {
  it("file list = db(+wal/shm), daemon.log, ws-token, daemon.pid; dir list = slack-files, worktrees", () => {
    const c = cfg("/h");
    expect(secureFilePaths(c)).toEqual(["/h/rookery.db", "/h/rookery.db-wal", "/h/rookery.db-shm", "/h/daemon.log", "/h/ws-token", "/h/daemon.pid"]);
    expect(secureDirPaths(c)).toEqual(["/h/slack-files", "/h/worktrees"]);
  });
});

describe.skipIf(process.platform === "win32")("secureHome chmod effects", () => {
  it("tightens home to 0700 and existing sensitive files to 0600 (idempotent, missing-file no-op)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rookery-sec-"));
    const c = cfg(home);
    fs.chmodSync(home, 0o755); // precondition (don't rely on umask)
    fs.writeFileSync(c.dbPath, "x"); fs.chmodSync(c.dbPath, 0o644);
    fs.writeFileSync(path.join(home, "daemon.log"), "x"); fs.chmodSync(path.join(home, "daemon.log"), 0o644);
    fs.mkdirSync(path.join(home, "slack-files")); fs.chmodSync(path.join(home, "slack-files"), 0o755);
    // (ws-token/pid/worktrees absent → must be no-op, no throw)
    secureHome(c);
    expect(fs.statSync(home).mode & 0o777).toBe(0o700); // headline security contract
    expect(fs.statSync(c.dbPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(home, "daemon.log")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(home, "slack-files")).mode & 0o777).toBe(0o700);
    expect(() => secureHome(c)).not.toThrow(); // idempotent + missing files
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
    fs.rmSync(home, { recursive: true, force: true });
  });
});
