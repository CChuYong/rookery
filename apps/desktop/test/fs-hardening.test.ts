import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { secureHomeDir, secureHomeAndLog } from "../src/main/fs-hardening.js";

describe.skipIf(process.platform === "win32")("electron fs-hardening", () => {
  it("secureHomeAndLog: home 0700, daemon.log 0600, returns an fd", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rookery-el-"));
    fs.chmodSync(home, 0o755); // precondition
    const fd = secureHomeAndLog(home);
    expect(typeof fd).toBe("number");
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(home, "daemon.log")).mode & 0o777).toBe(0o600);
    fs.closeSync(fd);
    fs.rmSync(home, { recursive: true, force: true });
  });
  it("secureHomeDir tightens an existing 0755 home to 0700 (idempotent)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rookery-el-"));
    fs.chmodSync(home, 0o755);
    secureHomeDir(home);
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
    expect(() => secureHomeDir(home)).not.toThrow();
    fs.rmSync(home, { recursive: true, force: true });
  });
});
