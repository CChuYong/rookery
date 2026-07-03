import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { acquireSingleInstance, isProcessAlive } from "../../src/daemon/lifecycle.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rookery-life-"));
const pidPath = path.join(tmp, "daemon.pid");
afterEach(() => {
  try {
    fs.rmSync(pidPath);
  } catch {
    /* ignore */
  }
});

describe("lifecycle", () => {
  it("acquires and releases the single-instance lock", () => {
    const lock = acquireSingleInstance(pidPath);
    expect(fs.existsSync(pidPath)).toBe(true);
    expect(Number(fs.readFileSync(pidPath, "utf8"))).toBe(process.pid);
    lock.release();
    expect(fs.existsSync(pidPath)).toBe(false);
  });

  it("throws if a live instance already holds the lock", () => {
    fs.writeFileSync(pidPath, String(process.pid), { flag: "wx" });
    expect(() => acquireSingleInstance(pidPath)).toThrow(/already running/);
  });

  it("overwrites a stale pid file (dead process)", () => {
    // a pid that is very unlikely to exist
    fs.writeFileSync(pidPath, "999999999");
    const lock = acquireSingleInstance(pidPath);
    expect(Number(fs.readFileSync(pidPath, "utf8"))).toBe(process.pid);
    lock.release();
  });

  it("stale takeover leaves no residue and acquires cleanly (audit #29)", () => {
    fs.writeFileSync(pidPath, "999999999"); // dead pid
    const lock = acquireSingleInstance(pidPath);
    expect(fs.readFileSync(pidPath, "utf8")).toBe(String(process.pid));
    expect(fs.readdirSync(path.dirname(pidPath)).filter((f) => f.includes(".stale"))).toEqual([]);
    lock.release();
  });

  it("isProcessAlive reports current process as alive", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });
});
