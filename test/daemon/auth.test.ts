import { describe, it, expect } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { checkUpgradeAuth, loadOrCreateToken } from "../../src/daemon/auth.js";

describe("checkUpgradeAuth", () => {
  const tok = "secret-token";
  const req = (url: string, origin?: string) => ({ url, headers: origin !== undefined ? { origin } : {} });

  it("accepts a matching token with no origin (CLI / Electron file://)", () => {
    expect(checkUpgradeAuth(req("/ws?token=secret-token"), tok).ok).toBe(true);
  });

  it("rejects a missing or wrong token", () => {
    expect(checkUpgradeAuth(req("/ws"), tok).ok).toBe(false);
    expect(checkUpgradeAuth(req("/ws?token=nope"), tok).ok).toBe(false);
  });

  it("accepts a localhost / file / null origin with a valid token", () => {
    expect(checkUpgradeAuth(req("/ws?token=secret-token", "http://localhost:5173"), tok).ok).toBe(true);
    expect(checkUpgradeAuth(req("/ws?token=secret-token", "file://"), tok).ok).toBe(true);
    expect(checkUpgradeAuth(req("/ws?token=secret-token", "null"), tok).ok).toBe(true);
  });

  it("rejects a foreign web origin even with a valid token (drive-by guard)", () => {
    expect(checkUpgradeAuth(req("/ws?token=secret-token", "https://evil.example"), tok).ok).toBe(false);
  });
});

describe("loadOrCreateToken", () => {
  it("creates a 0600 token file and returns the same token on re-read", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rookery-tok-"));
    const p = path.join(dir, "ws-token");
    const t1 = loadOrCreateToken(p);
    expect(t1.length).toBeGreaterThan(10);
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    expect(loadOrCreateToken(p)).toBe(t1); // persistent: same token returned on re-read
  });
});
