export interface DaemonDeps {
  ping: (host: string, port: number) => Promise<boolean>;
  spawn: (nodePath: string, daemonEntry: string) => { unref(): void };
  sleep: (ms: number) => Promise<void>;
  // Query the ABI (process.versions.modules) of the external Node used to launch the daemon. Returns null if it can't run.
  probeNodeAbi?: (nodePath: string) => Promise<number | null>;
  // Read the daemon pid file (~/.rookery/daemon.pid) and verify the process is alive. Returns null if absent or dead.
  readPid?: () => number | null;
  // Send a signal to a process (wraps process.kill). Optional — only used by restart().
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

export type EnsureResult = "already-up" | "spawned" | "failed" | "bad-node";

export interface DaemonManagerOptions {
  host: string;
  port: number;
  nodePath: string;
  daemonEntry: string;
  deps: DaemonDeps;
  maxWaitMs?: number;
  requiredNodeAbi?: number; // Node ABI required by the bundled better-sqlite3 (e.g. 127 = Node 22)
}

export class DaemonManager {
  // FIX I5: in-flight guard
  private ensurePromise: Promise<EnsureResult> | null = null;

  constructor(private readonly opts: DaemonManagerOptions) {}

  async status(): Promise<"up" | "down"> {
    return (await this.opts.deps.ping(this.opts.host, this.opts.port)) ? "up" : "down";
  }

  ensure(): Promise<EnsureResult> {
    return (this.ensurePromise ??= this.runEnsure().finally(() => { this.ensurePromise = null; }));
  }

  // Restart the actual daemon process: SIGTERM (graceful) → wait for /health down → (SIGKILL if it won't die) → spawn a new daemon via ensure().
  async restart(): Promise<EnsureResult> {
    const { deps, host, port } = this.opts;
    const pid = deps.readPid?.() ?? null;
    if (pid != null) {
      try { deps.kill?.(pid, "SIGTERM"); } catch { /* already gone */ }
      const deadline = this.opts.maxWaitMs ?? 5000;
      const step = 100;
      let down = false;
      for (let waited = 0; waited < deadline; waited += step) {
        if (!(await deps.ping(host, port))) { down = true; break; }
        await deps.sleep(step);
      }
      if (!down) { try { deps.kill?.(pid, "SIGKILL"); } catch { /* */ } await deps.sleep(300); }
    }
    return this.ensure();
  }

  private async runEnsure(): Promise<EnsureResult> {
    const { deps, host, port, nodePath, daemonEntry, requiredNodeAbi } = this.opts;
    if (await deps.ping(host, port)) return "already-up";
    // Node ABI guard: if the external Node is missing or doesn't match the better-sqlite3 ABI, the daemon crashes at require
    // and surfaces only as an 8-second health timeout ("failed"). Probe ahead of time to report a clear "bad-node" immediately.
    if (requiredNodeAbi != null && deps.probeNodeAbi) {
      const abi = await deps.probeNodeAbi(nodePath);
      if (abi == null || abi !== requiredNodeAbi) return "bad-node";
    }
    // FIX I6: wrap spawn in try/catch so bad node path returns "failed" not throw
    try {
      deps.spawn(nodePath, daemonEntry).unref();
    } catch {
      return "failed";
    }
    const deadline = this.opts.maxWaitMs ?? 8000;
    const step = 100;
    for (let waited = 0; waited < deadline; waited += step) {
      await deps.sleep(step);
      if (await deps.ping(host, port)) return "spawned";
    }
    return "failed";
  }
}
