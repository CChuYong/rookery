import { describe, it, expect } from "vitest";
import {
  classifyApp,
  parsePsRows,
  sumTree,
  collectResources,
  type ProcessMetricLike,
  type ResourceDeps,
} from "../src/main/resource-monitor.js";

const m = (type: string, cpu: number, wsKb: number): ProcessMetricLike => ({
  type,
  cpu: { percentCPUUsage: cpu },
  memory: { workingSetSize: wsKb },
});

describe("classifyApp", () => {
  it("buckets Browser→main, Tab→renderer, rest→other; KB→bytes", () => {
    const r = classifyApp([
      m("Browser", 0.3, 1000),
      m("Tab", 0.7, 2000),
      m("GPU", 0.5, 500),
      m("Utility", 0.4, 250),
    ]);
    expect(r.main).toEqual({ cpuPct: 0.3, memBytes: 1000 * 1024 });
    expect(r.renderer).toEqual({ cpuPct: 0.7, memBytes: 2000 * 1024 });
    expect(r.other).toEqual({ cpuPct: 0.5 + 0.4, memBytes: (500 + 250) * 1024 });
  });
});

describe("parsePsRows", () => {
  it("parses pid/ppid/pcpu/rss lines, skips junk", () => {
    const out = "  100  1  2.5  4096\n 200 100 0.0 2048\n\n garbage line\n 300 100 1.0 1024\n";
    expect(parsePsRows(out)).toEqual([
      { pid: 100, ppid: 1, pcpu: 2.5, rssKb: 4096 },
      { pid: 200, ppid: 100, pcpu: 0, rssKb: 2048 },
      { pid: 300, ppid: 100, pcpu: 1, rssKb: 1024 },
    ]);
  });

  it("parses the Windows PowerShell format (pid ppid 0 rssKb) — same 4-column shape, CPU placeholder 0", () => {
    const out = "1234 5678 0 120560\n9000 1234 0 4096\n";
    expect(parsePsRows(out)).toEqual([
      { pid: 1234, ppid: 5678, pcpu: 0, rssKb: 120560 },
      { pid: 9000, ppid: 1234, pcpu: 0, rssKb: 4096 },
    ]);
  });
});

describe("sumTree", () => {
  const rows: ReturnType<typeof parsePsRows> = [
    { pid: 100, ppid: 1, pcpu: 2, rssKb: 4000 }, // daemon
    { pid: 200, ppid: 100, pcpu: 1, rssKb: 2000 }, // child (claude)
    { pid: 300, ppid: 200, pcpu: 3, rssKb: 1000 }, // grandchild
    { pid: 999, ppid: 1, pcpu: 9, rssKb: 9000 }, // unrelated
  ];
  it("sums root + all descendants", () => {
    expect(sumTree(rows, 100)).toEqual({ pcpu: 6, rssKb: 7000 });
  });
  it("returns zero when root absent", () => {
    expect(sumTree(rows, 555)).toEqual({ pcpu: 0, rssKb: 0 });
  });
  it("does not loop on a cycle", () => {
    const cyc = [
      { pid: 1, ppid: 2, pcpu: 1, rssKb: 1 },
      { pid: 2, ppid: 1, pcpu: 1, rssKb: 1 },
    ];
    expect(sumTree(cyc, 1)).toEqual({ pcpu: 2, rssKb: 2 });
  });
});

describe("collectResources", () => {
  const baseDeps = (over: Partial<ResourceDeps> = {}): ResourceDeps => ({
    getAppMetrics: () => [m("Browser", 2, 1000), m("Tab", 2, 1000)],
    readDaemonPid: () => 100,
    psSnapshot: async () => [
      { pid: 100, ppid: 1, pcpu: 4, rssKb: 5000 },
      { pid: 200, ppid: 100, pcpu: 4, rssKb: 5000 },
    ],
    cpuCount: () => 4,
    totalMem: () => 1_000_000 * 1024,
    ...over,
  });

  it("normalizes cpu by core count and sums app+daemon", async () => {
    const s = await collectResources(baseDeps());
    // app cpu per-core = 2+2=4 → /4 = 1 ; daemon per-core = 4+4=8 → /4 = 2
    expect(s.app.cpuPct).toBeCloseTo(1);
    expect(s.daemon).not.toBeNull();
    expect(s.daemon!.cpuPct).toBeCloseTo(2);
    expect(s.cpuPct).toBeCloseTo(3);
    // app mem = 2000KB, daemon mem = 10000KB
    expect(s.app.memBytes).toBe(2000 * 1024);
    expect(s.daemon!.memBytes).toBe(10000 * 1024);
    expect(s.memBytes).toBe(12000 * 1024);
    expect(s.ramSharePct).toBeCloseTo((12000 / 1_000_000) * 100);
  });

  it("daemon null when pid missing", async () => {
    const s = await collectResources(baseDeps({ readDaemonPid: () => null }));
    expect(s.daemon).toBeNull();
    expect(s.memBytes).toBe(2000 * 1024); // app only
  });

  it("daemon null when ps throws (partial result keeps app)", async () => {
    const s = await collectResources(
      baseDeps({
        psSnapshot: async () => {
          throw new Error("ps failed");
        },
      }),
    );
    expect(s.daemon).toBeNull();
    expect(s.app.memBytes).toBe(2000 * 1024);
  });
});
