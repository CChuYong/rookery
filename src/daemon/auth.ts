import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Per-daemon shared secret. Persisted in a 0600 file — restarts reuse the same token, so client reconnects stay simple.
// (Browser JS can't read local files, so simply requiring the token blocks drive-by attacks at the source.)
export function loadOrCreateToken(tokenPath: string): string {
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) {
      try { fs.chmodSync(tokenPath, 0o600); } catch { /* best-effort */ }
      return existing;
    }
  } catch {
    /* file doesn't exist → create it */
  }
  const token = crypto.randomBytes(24).toString("base64url");
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tokenPath, token, { mode: 0o600 });
  try { fs.chmodSync(tokenPath, 0o600); } catch { /* best-effort */ }
  return token;
}

interface UpgradeReq {
  url?: string;
  headers: { origin?: string };
}

// WS upgrade auth: (1) token match (timing-safe), (2) reject external web Origins (browser drive-by defense).
// Electron (file://·null), CLI (no headers), and dev (localhost) pass through.
export function checkUpgradeAuth(req: UpgradeReq, token: string): { ok: boolean; reason?: string } {
  const origin = req.headers.origin;
  if (origin !== undefined && !isLocalOrigin(origin)) return { ok: false, reason: "forbidden origin" };
  const presented = new URL(req.url ?? "/", "http://localhost").searchParams.get("token") ?? "";
  if (!token || !timingSafeEq(presented, token)) return { ok: false, reason: "bad token" };
  return { ok: true };
}

function isLocalOrigin(origin: string): boolean {
  if (origin === "null" || origin === "") return true; // Packaged Electron (file://) is often "null"
  try {
    const u = new URL(origin);
    if (u.protocol === "file:") return true;
    const h = u.hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1";
  } catch {
    return false;
  }
}

function timingSafeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
