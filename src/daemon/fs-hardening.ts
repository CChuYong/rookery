import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";

type SecureConfig = Pick<Config, "home" | "dbPath" | "pidPath" | "tokenPath" | "mcpTokenPath" | "fleet">;

// Sensitive files to tighten to 0600. ⚠️ For the current-boot WAL/SHM the real protection is home 0700 (blocks traversal);
// these -wal/-shm entries are for cleaning up leftovers from a previous boot (secureHome runs only once, before openDb).
export function secureFilePaths(config: SecureConfig): string[] {
  return [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`, path.join(config.home, "daemon.log"), config.tokenPath, config.mcpTokenPath, config.pidPath];
}
export function secureDirPaths(config: SecureConfig): string[] {
  return [path.join(config.home, "slack-files"), config.fleet.worktreesDir];
}

const QUIET = new Set(["ENOENT", "ENOSYS", "EPERM"]); // race / Windows / permissions — expected
function chmodQuiet(p: string, mode: number): void {
  if (!fs.existsSync(p)) return;
  try { fs.chmodSync(p, mode); }
  catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code && QUIET.has(code)) return;
    process.stderr.write(`[rookery] could not chmod ${p}: ${String(e)}\n`); // only the unexpected, never throws
  }
}

// On boot, tighten ~/.rookery to 0700 and repair sensitive file/directory permissions. best-effort, never throws.
export function secureHome(config: SecureConfig): void {
  try { fs.mkdirSync(config.home, { recursive: true, mode: 0o700 }); } catch { /* best-effort */ }
  try { fs.chmodSync(config.home, 0o700); } catch { /* repair an existing 0755; ignore RO-FS/EPERM/Windows */ }
  for (const p of secureFilePaths(config)) chmodQuiet(p, 0o600);
  for (const d of secureDirPaths(config)) chmodQuiet(d, 0o700);
}
