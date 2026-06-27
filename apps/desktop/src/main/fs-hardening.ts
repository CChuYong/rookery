// Self-contained permission helper — Electron main can't runtime-import the daemon/core (ABI). Intentional duplicate of the daemon's src/daemon/fs-hardening.ts.
import fs from "node:fs";
import { join } from "node:path";

export function secureHomeDir(home: string): void {
  try { fs.mkdirSync(home, { recursive: true, mode: 0o700 }); } catch { /* best-effort */ }
  try { fs.chmodSync(home, 0o700); } catch { /* Windows no-op / EPERM / RO-FS */ }
}

// Tight-create + repair home + daemon.log before spawning the daemon (protects even if the daemon dies before reaching secureHome). Returns the daemon.log fd (for stdio).
export function secureHomeAndLog(home: string): number {
  secureHomeDir(home);
  const logPath = join(home, "daemon.log");
  const fd = fs.openSync(logPath, "a", 0o600); // chmod after openSync creates it (avoids ENOENT on first run)
  try { fs.chmodSync(logPath, 0o600); } catch { /* */ }
  return fd;
}
