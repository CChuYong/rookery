import { describe, it, expect } from "vitest";
import { CodexClient } from "../../../src/core/codex/codex-client.js";
import type { CodexTransport } from "../../../src/core/codex/codex-transport.js";

// Minimal loopback transport: captures written lines; test feeds inbound lines manually.
function loopback() {
  const written: string[] = [];
  let lineCb: (l: string) => void = () => {};
  let exitCb: (i: { code: number | null; message?: string }) => void = () => {};
  const transport: CodexTransport = {
    write: (l) => written.push(l),
    onLine: (cb) => { lineCb = cb; },
    onExit: (cb) => { exitCb = cb; },
    kill: () => {},
  };
  return { transport, written, feed: (o: unknown) => lineCb(JSON.stringify(o)), feedRaw: (s: string) => lineCb(s), exit: (code: number | null, message?: string) => exitCb({ code, message }) };
}

describe("CodexClient", () => {
  it("correlates request/response by id and resolves with result", async () => {
    const { transport, written, feed } = loopback();
    const c = new CodexClient(transport);
    const p = c.request("model/list", {});
    const sent = JSON.parse(written[0]!);
    expect(sent).toMatchObject({ jsonrpc: "2.0", method: "model/list", params: {} });
    feed({ id: sent.id, result: { data: [] } }); // responses may omit jsonrpc — must still parse
    await expect(p).resolves.toEqual({ data: [] });
  });

  it("rejects on error responses and on transport exit (all pending)", async () => {
    const { transport, written, feed, exit } = loopback();
    const c = new CodexClient(transport);
    const p1 = c.request("thread/start", {});
    feed({ id: JSON.parse(written[0]!).id, error: { code: -32000, message: "boom" } });
    await expect(p1).rejects.toThrow(/boom/);
    const p2 = c.request("thread/start", {});
    exit(1, "crashed");
    await expect(p2).rejects.toThrow(/crashed|exited/);
  });

  it("dispatches notifications, server requests, and ignores malformed lines", async () => {
    const { transport, written, feed, feedRaw } = loopback();
    const c = new CodexClient(transport);
    const notes: Array<[string, unknown]> = [];
    const reqs: Array<[number | string, string]> = [];
    c.onNotification((m, p) => notes.push([m, p]));
    c.onServerRequest((id, m) => reqs.push([id, m]));
    feedRaw("not json at all");
    feed({ method: "thread/started", params: { thread: { id: "t1" } } });
    feed({ id: 77, method: "execCommandApproval", params: {} }); // id+method = server request
    c.respond(77, { decision: "decline" });
    c.respondError(78, -32601, "unknown");
    expect(notes).toEqual([["thread/started", { thread: { id: "t1" } }]]);
    expect(reqs).toEqual([[77, "execCommandApproval"]]);
    expect(JSON.parse(written.at(-2)!)).toEqual({ jsonrpc: "2.0", id: 77, result: { decision: "decline" } });
    expect(JSON.parse(written.at(-1)!)).toEqual({ jsonrpc: "2.0", id: 78, error: { code: -32601, message: "unknown" } });
  });

  it("notify writes a method-only frame; onClosed fires once on exit", () => {
    const { transport, written, exit } = loopback();
    const c = new CodexClient(transport);
    c.notify("initialized", {});
    expect(JSON.parse(written[0]!)).toEqual({ jsonrpc: "2.0", method: "initialized", params: {} });
    let closed = 0;
    let closedArg: Error | undefined | "unset" = "unset";
    c.onClosed((e) => { closed++; closedArg = e; });
    exit(1, "boom"); exit(1, "boom");
    expect(closed).toBe(1);
    expect(closedArg).toBeInstanceOf(Error);
  });

  it("deliberate close() fires onClosed with undefined and rejects pending", async () => {
    const { transport } = loopback();
    const c = new CodexClient(transport);
    let closedArg: Error | undefined | "unset" = "unset";
    c.onClosed((e) => { closedArg = e; });
    const p = c.request("thread/start", {});
    c.close();
    await expect(p).rejects.toThrow(/closed/);
    expect(closedArg).toBeUndefined();
  });
});
