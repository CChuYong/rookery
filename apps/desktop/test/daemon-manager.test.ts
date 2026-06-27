import { describe, it, expect } from "vitest";
import { DaemonManager } from "../src/main/daemon-manager.js";

function deps(pingResults: boolean[], spawnFn?: () => { unref(): void }) {
  let i = 0;
  const spawned: string[] = [];
  return {
    spawned,
    d: {
      ping: async () => pingResults[Math.min(i++, pingResults.length - 1)]!,
      spawn: (node: string, entry: string) => {
        spawned.push(`${node} ${entry}`);
        if (spawnFn) return spawnFn();
        return { unref() {} };
      },
      sleep: async () => {},
    },
  };
}

describe("DaemonManager", () => {
  it("does not spawn when daemon already up", async () => {
    const { d, spawned } = deps([true]);
    const m = new DaemonManager({ host: "127.0.0.1", port: 8787, nodePath: "node", daemonEntry: "/d.js", deps: d });
    expect(await m.ensure()).toBe("already-up");
    expect(spawned).toEqual([]);
  });

  it("spawns then waits until healthy", async () => {
    const { d, spawned } = deps([false, false, true]); // ensure ping fail → spawn → poll fail,then up
    const m = new DaemonManager({ host: "127.0.0.1", port: 8787, nodePath: "node22", daemonEntry: "/d.js", deps: d });
    expect(await m.ensure()).toBe("spawned");
    expect(spawned).toEqual(["node22 /d.js"]);
  });

  it("returns failed when never healthy", async () => {
    const { d } = deps([false]);
    const m = new DaemonManager({ host: "127.0.0.1", port: 8787, nodePath: "node", daemonEntry: "/d.js", deps: d, });
    expect(await m.ensure()).toBe("failed");
  });

  // FIX I5: concurrent ensure() calls spawn only once
  it("concurrent ensure() calls spawn only once (in-flight guard)", async () => {
    const { d, spawned } = deps([false, false, true]);
    const m = new DaemonManager({ host: "127.0.0.1", port: 8787, nodePath: "node", daemonEntry: "/d.js", deps: d });
    const [r1, r2, r3] = await Promise.all([m.ensure(), m.ensure(), m.ensure()]);
    expect(r1).toBe("spawned");
    expect(r2).toBe("spawned");
    expect(r3).toBe("spawned");
    expect(spawned.length).toBe(1); // spawned only once
  });

  // FIX I6: ensure() returns "failed" when spawn throws
  it("returns failed when spawn throws", async () => {
    const { d } = deps([false], () => { throw new Error("bad node path"); });
    const m = new DaemonManager({ host: "127.0.0.1", port: 8787, nodePath: "bad-node", daemonEntry: "/d.js", deps: d });
    expect(await m.ensure()).toBe("failed");
  });

  it("returns bad-node (no spawn) when the spawn node's ABI mismatches the required one", async () => {
    const { d, spawned } = deps([false]);
    const dd = { ...d, probeNodeAbi: async () => 115 }; // e.g. Node 20 (ABI 115)
    const m = new DaemonManager({ host: "127.0.0.1", port: 8787, nodePath: "node", daemonEntry: "/d.js", deps: dd, requiredNodeAbi: 127 });
    expect(await m.ensure()).toBe("bad-node");
    expect(spawned).toEqual([]); // a wrong ABI is not even spawned → an immediate, clear result instead of an 8s timeout
  });

  it("returns bad-node when the node cannot run (abi null)", async () => {
    const { d } = deps([false]);
    const dd = { ...d, probeNodeAbi: async () => null };
    const m = new DaemonManager({ host: "127.0.0.1", port: 8787, nodePath: "node", daemonEntry: "/d.js", deps: dd, requiredNodeAbi: 127 });
    expect(await m.ensure()).toBe("bad-node");
  });

  it("spawns normally when the node ABI matches", async () => {
    const { d, spawned } = deps([false, false, true]);
    const dd = { ...d, probeNodeAbi: async () => 127 };
    const m = new DaemonManager({ host: "127.0.0.1", port: 8787, nodePath: "node", daemonEntry: "/d.js", deps: dd, requiredNodeAbi: 127 });
    expect(await m.ensure()).toBe("spawned");
    expect(spawned).toEqual(["node /d.js"]);
  });

  it("restart() SIGTERMs the running daemon, waits for it to go down, then respawns", async () => {
    const kills: Array<[number, string]> = [];
    // up, up, then down (restart wait-loop), then down again (ensure initial check), then up (ensure health poll → spawned)
    let pings = [true, true, false, false, true];
    let spawned = 0;
    const mgr = new DaemonManager({
      host: "127.0.0.1", port: 8787, nodePath: "node", daemonEntry: "/d.js",
      deps: {
        ping: async () => (pings.length > 1 ? pings.shift()! : pings[0]),
        spawn: () => { spawned++; return { unref() {} }; },
        sleep: async () => {},
        readPid: () => 4242,
        kill: (pid, sig) => { kills.push([pid, sig]); },
      },
    });
    const r = await mgr.restart();
    expect(kills[0]).toEqual([4242, "SIGTERM"]);
    expect(spawned).toBe(1); // spawn a new daemon after confirming it's down
    expect(r).toBe("spawned");
  });

  it("restart() force-kills (SIGKILL) if the daemon stays up past the deadline", async () => {
    const kills: Array<[number, string]> = [];
    const mgr = new DaemonManager({
      host: "127.0.0.1", port: 8787, nodePath: "node", daemonEntry: "/d.js", maxWaitMs: 300,
      deps: { ping: async () => true, spawn: () => ({ unref() {} }), sleep: async () => {}, readPid: () => 99, kill: (p, s) => kills.push([p, s]) },
    });
    await mgr.restart();
    expect(kills.some(([, s]) => s === "SIGTERM")).toBe(true);
    expect(kills.some(([, s]) => s === "SIGKILL")).toBe(true);
  });

  it("restart() with no running pid just ensures (spawns), no kill", async () => {
    const kills: string[] = [];
    let up = false;
    const mgr = new DaemonManager({
      host: "127.0.0.1", port: 8787, nodePath: "node", daemonEntry: "/d.js",
      deps: { ping: async () => up, spawn: () => { up = true; return { unref() {} }; }, sleep: async () => {}, readPid: () => null, kill: (_p, s) => kills.push(s) },
    });
    const r = await mgr.restart();
    expect(kills).toEqual([]);
    expect(r).toBe("spawned");
  });
});
