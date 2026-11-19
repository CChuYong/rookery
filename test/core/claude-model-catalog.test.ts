import { describe, expect, it, vi } from "vitest";
import { ClaudeModelCatalog } from "../../src/core/claude-model-catalog.js";
import type { QueryFn } from "../../src/core/claude-backend.js";

type Row = { value: string; resolvedModel?: string; displayName: string; description: string };

// A query() stand-in whose iterator idles until interrupted and which answers supportedModels().
function fakeQuery(rows: Row[] | (() => Promise<Row[]>)): { fn: QueryFn; calls: () => number; interrupts: () => number } {
  let calls = 0;
  let interrupts = 0;
  const fn = (() => {
    calls++;
    let stop!: () => void;
    const stopped = new Promise<void>((r) => { stop = r; });
    return {
      async *[Symbol.asyncIterator]() { await stopped; },
      supportedModels: () => (typeof rows === "function" ? rows() : Promise.resolve(rows)),
      interrupt: async () => { interrupts++; stop(); },
    };
  }) as unknown as QueryFn;
  return { fn, calls: () => calls, interrupts: () => interrupts };
}

const ROWS: Row[] = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5" },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "" },
  { value: "claude-opus-4-8", resolvedModel: "claude-opus-4-8", displayName: "Opus 4.8", description: "" },
];

describe("ClaudeModelCatalog", () => {
  it("resolves the SDK's 'default' row to its concrete model id", async () => {
    const q = fakeQuery(ROWS);
    const c = new ClaudeModelCatalog(q.fn, { cwd: "/tmp" });
    expect(c.recommended()).toBeNull(); // nothing known yet; this call starts a background probe
    expect(await c.refresh()).toBe("claude-opus-5-5");
    expect(c.recommended()).toBe("claude-opus-5-5");
    expect(q.interrupts()).toBeGreaterThan(0); // the probe is closed, no turn is sent
  });

  it("returns null when the SDK has no default row or no resolved id", async () => {
    const c = new ClaudeModelCatalog(fakeQuery([{ value: "default", displayName: "Default", description: "" }]).fn, { cwd: "/tmp" });
    expect(await c.refresh()).toBeNull();
    const d = new ClaudeModelCatalog(fakeQuery([ROWS[2]]).fn, { cwd: "/tmp" });
    expect(await d.refresh()).toBeNull();
  });

  it("keeps the last good answer when a later probe fails", async () => {
    let fail = false;
    const q = fakeQuery(async () => { if (fail) throw new Error("offline"); return ROWS; });
    let now = 0;
    const c = new ClaudeModelCatalog(q.fn, { cwd: "/tmp", ttlMs: 1000, now: () => now });
    expect(await c.refresh()).toBe("claude-opus-5-5");
    fail = true;
    now = 5000;
    expect(await c.refresh()).toBe("claude-opus-5-5");
    expect(c.recommended()).toBe("claude-opus-5-5");
  });

  it("times out a hung probe and answers null instead of hanging", async () => {
    const q = fakeQuery(() => new Promise<Row[]>(() => {}));
    const c = new ClaudeModelCatalog(q.fn, { cwd: "/tmp", timeoutMs: 20 });
    expect(await c.refresh()).toBeNull();
  });

  it("coalesces concurrent refreshes and re-probes only after the TTL", async () => {
    const q = fakeQuery(ROWS);
    let now = 0;
    const c = new ClaudeModelCatalog(q.fn, { cwd: "/tmp", ttlMs: 1000, now: () => now });
    await Promise.all([c.refresh(), c.refresh()]);
    expect(q.calls()).toBe(1);
    c.recommended(); // fresh → no new probe
    expect(q.calls()).toBe(1);
    now = 2000;
    c.recommended(); // stale → background re-probe
    await vi.waitFor(() => expect(q.calls()).toBe(2));
  });
});
