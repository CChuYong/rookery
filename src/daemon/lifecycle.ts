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
        // Race-safe takeover (audit #29): a blind rm could delete a COMPETITOR's freshly-written live lock
        // (our read of the dead pid may predate their write). rename() is atomic — exactly one contender
        // captures the file; the content then proves what was captured.
        const stale = `${pidPath}.stale-${process.pid}`;
        fs.renameSync(pidPath, stale);
        let captured = NaN;
        try { captured = Number.parseInt(fs.readFileSync(stale, "utf8").trim(), 10); } catch { /* unreadable → stale */ }
        if (Number.isInteger(captured) && captured !== existing && isProcessAlive(captured)) {
          // We swept up a live competitor's lock — put it back and concede.
          try { fs.renameSync(stale, pidPath); } catch { /* they re-acquired already — fine */ }
          throw new Error(`rookery daemon already running (pid ${captured})`);
        }
        fs.rmSync(stale, { force: true }); // confirmed stale — discard and retry wx in the next loop
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("rookery daemon already running")) throw e;
        /* rename lost the race (competitor took the file first) → retry wx */
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
