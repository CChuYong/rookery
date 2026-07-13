import { describe, it, expect } from "vitest";
import { CommandCatalog } from "../../src/core/commands.js";
import type { QueryFn } from "../../src/core/claude-backend.js";
import { fakeQuery } from "../helpers/fake-query.js";

describe("CommandCatalog", () => {
  it("probes once per cwd, caches, and returns mapped slash commands", async () => {
    let calls = 0;
    const cmds = [{ name: "review", description: "Run a review", argumentHint: "<path>" }];
    const qfn = ((input: unknown) => {
      calls++;
      return fakeQuery([], { commands: cmds })(input as Parameters<QueryFn>[0]);
    }) as unknown as QueryFn;
    const cat = new CommandCatalog(qfn, { model: "m", ttlMs: 10_000, now: () => 0 });

    expect(await cat.forCwd("/r")).toEqual([{ name: "review", description: "Run a review", argumentHint: "<path>", aliases: undefined }]);
    await cat.forCwd("/r");
    expect(calls).toBe(1); // same cwd is cached
    await cat.forCwd("/other");
    expect(calls).toBe(2); // a different cwd triggers a new probe
  });

  it("re-probes after the cache TTL expires", async () => {
    let calls = 0;
    let t = 0;
    const qfn = ((input: unknown) => {
      calls++;
      return fakeQuery([], { commands: [] })(input as Parameters<QueryFn>[0]);
    }) as unknown as QueryFn;
    const cat = new CommandCatalog(qfn, { model: "m", ttlMs: 1000, now: () => t });
    await cat.forCwd("/r");
    t = 1500; // TTL exceeded
    await cat.forCwd("/r");
    expect(calls).toBe(2);
  });

  it("returns [] when the probe throws (best-effort, UI treats it as no candidates)", async () => {
    const qfn = (() => { throw new Error("nope"); }) as unknown as QueryFn;
    const cat = new CommandCatalog(qfn, { model: "m" });
    expect(await cat.forCwd("/r")).toEqual([]);
    expect(await cat.inspect("/r")).toEqual({ commands: [], error: "nope" });
  });

  it("exposes successful empty discovery without an error", async () => {
    const qfn = fakeQuery([], { commands: [] }) as unknown as QueryFn;
    const cat = new CommandCatalog(qfn, { model: "m" });
    expect(await cat.inspect("/r")).toEqual({ commands: [] });
  });
});
