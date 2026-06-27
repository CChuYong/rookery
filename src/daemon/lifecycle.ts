import fs from "node:fs";
import path from "node:path";

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = exists but not ours (treat as alive)
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function acquireSingleInstance(pidPath: string): { release: () => void } {
  fs.mkdirSync(path.dirname(pidPath), { recursive: true, mode: 0o700 });

  const write = () => fs.writeFileSync(pidPath, String(process.pid), { flag: "wx" });

  // Retry loop (DPP-7): tolerate one more round of the TOCTOU in stale-lock takeover
  // (the race between rm→write, or the file having just vanished). If the PID is alive, immediately conclude "already running".
  let acquired = false;
  for (let attempt = 0; attempt < 5 && !acquired; attempt++) {
    try {
      write();
      acquired = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let existing = NaN;
      try {
        existing = Number.parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10);
      } catch {
        continue; // file just vanished → retry with wx
      }
      if (Number.isInteger(existing) && isProcessAlive(existing)) {
        throw new Error(`rookery daemon already running (pid ${existing})`);
      }
      try {
        fs.rmSync(pidPath); // remove the stale lock, then retry wx in the next loop (on a race, retry if the other side won)
      } catch {
        /* another instance cleaned up/acquired it first — retry */
      }
    }
  }
  if (!acquired) throw new Error("could not acquire single-instance lock (contended)");

  return {
    release: () => {
      try {
        const owner = Number.parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10);
        if (owner === process.pid) fs.rmSync(pidPath);
      } catch {
        /* already gone */
      }
    },
  };
}
