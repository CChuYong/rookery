// Collects and normalizes resource (CPU/memory) usage of the desktop app + rookery daemon tree — pure logic.
// All Electron/OS calls are injected via ResourceDeps so this is unit-testable (WorkspaceManager pattern).

export interface ProcessMetricLike {
  type: string;
  cpu: { percentCPUUsage: number }; // % relative to a single core
  memory: { workingSetSize: number }; // KB
}

export interface PsRow {
  pid: number;
  ppid: number;
  pcpu: number; // % relative to a single core
  rssKb: number;
}

export interface ResourceBucket {
  cpuPct: number; // machine % (after normalization)
  memBytes: number;
}

export interface ResourceSnapshot {
  cpuPct: number;
  memBytes: number;
  ramSharePct: number;
  app: ResourceBucket & {
    main: ResourceBucket;
    renderer: ResourceBucket;
    other: ResourceBucket;
  };
  daemon: ResourceBucket | null;
}

export interface ResourceDeps {
  getAppMetrics: () => ProcessMetricLike[];
  readDaemonPid: () => number | null;
  psSnapshot: () => Promise<PsRow[]>;
  cpuCount: () => number;
  totalMem: () => number;
}

const KB = 1024;

// getAppMetrics → Main/Renderer/Other. cpu is summed as single-core % (normalization happens in collectResources), mem is KB→bytes.
export function classifyApp(metrics: ProcessMetricLike[]): {
  main: ResourceBucket;
  renderer: ResourceBucket;
  other: ResourceBucket;
} {
  const main: ResourceBucket = { cpuPct: 0, memBytes: 0 };
  const renderer: ResourceBucket = { cpuPct: 0, memBytes: 0 };
  const other: ResourceBucket = { cpuPct: 0, memBytes: 0 };
  for (const me of metrics) {
    const bucket = me.type === "Browser" ? main : me.type === "Tab" ? renderer : other;
    bucket.cpuPct += me.cpu.percentCPUUsage;
    bucket.memBytes += me.memory.workingSetSize * KB;
  }
  return { main, renderer, other };
}

// Parses "pid ppid pcpu rss" lines (`ps -axo pid=,ppid=,pcpu=,rss=`). Unparseable lines are skipped.
export function parsePsRows(stdout: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const pid = Number.parseInt(parts[0], 10);
    const ppid = Number.parseInt(parts[1], 10);
    const pcpu = Number.parseFloat(parts[2]);
    const rssKb = Number.parseInt(parts[3], 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    rows.push({
      pid,
      ppid,
      pcpu: Number.isFinite(pcpu) ? pcpu : 0,
      rssKb: Number.isFinite(rssKb) ? rssKb : 0,
    });
  }
  return rows;
}

// DFS over the ppid tree from rootPid → sums pcpu/rssKb (including root). visited guards against cycles.
export function sumTree(rows: PsRow[], rootPid: number): { pcpu: number; rssKb: number } {
  const byPid = new Map<number, PsRow>();
  const byParent = new Map<number, PsRow[]>();
  for (const r of rows) {
    byPid.set(r.pid, r);
    const arr = byParent.get(r.ppid);
    if (arr) arr.push(r);
    else byParent.set(r.ppid, [r]);
  }
  if (!byPid.has(rootPid)) return { pcpu: 0, rssKb: 0 };
  let pcpu = 0;
  let rssKb = 0;
  const visited = new Set<number>();
  const stack = [rootPid];
  while (stack.length > 0) {
    const pid = stack.pop() as number;
    if (visited.has(pid)) continue;
    visited.add(pid);
    const row = byPid.get(pid);
    if (row) {
      pcpu += row.pcpu;
      rssKb += row.rssKb;
    }
    for (const child of byParent.get(pid) ?? []) {
      if (!visited.has(child.pid)) stack.push(child.pid);
    }
  }
  return { pcpu, rssKb };
}

export async function collectResources(deps: ResourceDeps): Promise<ResourceSnapshot> {
  const cores = Math.max(1, deps.cpuCount());
  const norm = (perCore: number): number => perCore / cores;

  const raw = classifyApp(deps.getAppMetrics());
  const main: ResourceBucket = { cpuPct: norm(raw.main.cpuPct), memBytes: raw.main.memBytes };
  const renderer: ResourceBucket = { cpuPct: norm(raw.renderer.cpuPct), memBytes: raw.renderer.memBytes };
  const other: ResourceBucket = { cpuPct: norm(raw.other.cpuPct), memBytes: raw.other.memBytes };
  const appCpu = main.cpuPct + renderer.cpuPct + other.cpuPct;
  const appMem = main.memBytes + renderer.memBytes + other.memBytes;

  let daemon: ResourceBucket | null = null;
  const pid = deps.readDaemonPid();
  if (pid != null) {
    try {
      const { pcpu, rssKb } = sumTree(await deps.psSnapshot(), pid);
      daemon = { cpuPct: norm(pcpu), memBytes: rssKb * KB };
    } catch {
      daemon = null; // ps failed → only the daemon is hidden, app stays
    }
  }

  const memBytes = appMem + (daemon?.memBytes ?? 0);
  const cpuPct = appCpu + (daemon?.cpuPct ?? 0);
  const total = deps.totalMem();
  const ramSharePct = total > 0 ? (memBytes / total) * 100 : 0;

  return {
    cpuPct,
    memBytes,
    ramSharePct,
    app: { cpuPct: appCpu, memBytes: appMem, main, renderer, other },
    daemon,
  };
}
