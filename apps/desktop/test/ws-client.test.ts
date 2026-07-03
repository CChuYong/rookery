import { describe, it, expect, vi } from "vitest";
import { WsClient } from "../src/renderer/ws/client.js";
import type { CoreEvent } from "@daemon/core/events.js";

function fakeSocket() {
  const s: any = { sent: [] as string[], onmessage: null, onopen: null, onclose: null };
  s.send = (d: string) => s.sent.push(d);
  s.close = () => { s.onclose?.(); };
  return s;
}

describe("WsClient", () => {
  it("correlates a request to its reqId response", async () => {
    const sock = fakeSocket();
    const c = new WsClient(() => sock, () => {});
    c.start();
    sock.onopen?.();
    const p = c.request({ type: "fleet.list" });
    const sentReqId = JSON.parse(sock.sent.at(-1)!).reqId as string;
    sock.onmessage!(JSON.stringify({ type: "fleet.list.result", reqId: sentReqId, fleet: [{ id: "a1" }] }));
    const res: any = await p;
    expect(res.fleet[0].id).toBe("a1");
  });

  it("routes event messages to onEvent", () => {
    const sock = fakeSocket();
    const events: CoreEvent[] = [];
    const c = new WsClient(() => sock, (e) => events.push(e));
    c.start();
    sock.onmessage!(JSON.stringify({ type: "event", event: { type: "master.message", sessionId: "s1", role: "assistant", content: "hi" } }));
    expect(events[0]).toMatchObject({ type: "master.message", content: "hi" });
  });

  // A real browser WebSocket passes a MessageEvent({data}) to onmessage (not a raw string).
  // If this isn't handled, every server response is lost (empty session/fleet lists, +new unresponsive).
  it("handles a real WebSocket MessageEvent ({data}) not just a raw string", async () => {
    const sock = fakeSocket();
    const c = new WsClient(() => sock, () => {});
    c.start();
    sock.onopen?.();
    const p = c.request({ type: "session.list" });
    const reqId = JSON.parse(sock.sent.at(-1)!).reqId as string;
    // delivered as a MessageEvent shape, not a raw string
    sock.onmessage!({ data: JSON.stringify({ type: "session.list.result", reqId, sessions: [{ id: "s1", cwd: "/x", status: "active" }] }) });
    const res: any = await p;
    expect(res.sessions[0].id).toBe("s1");
  });

  it("ignores a malformed (non-JSON) frame without throwing", () => {
    const sock = fakeSocket();
    const c = new WsClient(() => sock, () => {});
    c.start();
    expect(() => sock.onmessage!("not json")).not.toThrow();
    expect(() => sock.onmessage!({ data: "not json" })).not.toThrow();
  });

  // FIX C2: pending request rejects when onclose fires
  it("rejects pending requests when socket closes", async () => {
    const sock = fakeSocket();
    const c = new WsClient(() => sock, () => {});
    c.start();
    sock.onopen?.();
    const p = c.request({ type: "fleet.list" });
    // trigger onclose without responding
    sock.onclose?.();
    await expect(p).rejects.toThrow("socket closed");
  });

  // FIX C3: request() rejects when called with no connected socket
  it("rejects request() immediately when not connected", async () => {
    const c = new WsClient(() => { throw new Error("should not connect"); }, () => {});
    // Don't call start() — sock is null
    await expect(c.request({ type: "fleet.list" })).rejects.toThrow("not connected");
  });

  // FIX C1: error message with reqId rejects the matching pending
  it("rejects pending request on error message with matching reqId", async () => {
    const sock = fakeSocket();
    const c = new WsClient(() => sock, () => {});
    c.start();
    sock.onopen?.();
    const p = c.request({ type: "fleet.diff", id: "x1" });
    const sentReqId = JSON.parse(sock.sent.at(-1)!).reqId as string;
    sock.onmessage!(JSON.stringify({ type: "error", message: "fleet.diff: not found", reqId: sentReqId }));
    await expect(p).rejects.toThrow("fleet.diff: not found");
  });

  // DSK-1: messages sent while disconnected (awaiting reconnect) are not silently lost; they flush on reconnect.
  it("buffers sends while disconnected and flushes them on reconnect", () => {
    vi.useFakeTimers();
    try {
      const socks: any[] = [];
      const c = new WsClient(() => { const s = fakeSocket(); socks.push(s); return s; }, () => {});
      c.start();
      socks[0].onopen?.();
      socks[0].onclose?.(); // disconnect → sock=null, reconnect scheduled after 1s
      c.send({ type: "session.send", sessionId: "s1", text: "hello" } as any); // sent while disconnected
      expect(socks.length).toBe(1); // not reconnected yet
      vi.advanceTimersByTime(1000); // trigger reconnect
      socks[1].onopen?.(); // new socket open → flush
      const sent = socks[1].sent.map((d: string) => JSON.parse(d));
      expect(sent.some((m: any) => m.type === "session.send" && m.text === "hello")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // audit #31: a send during the browser CONNECTING window (readyState 0) must not throw and must buffer.
  // start() assigns this.sock while the socket is still CONNECTING; the real browser send() throws
  // InvalidStateError there, so the frame must fall through to the DSK-1 outbox and flush on open.
  it("send during CONNECTING buffers to the outbox instead of throwing (audit #31)", () => {
    const sock = fakeSocket();
    sock.readyState = 0; // CONNECTING — onopen not yet fired
    const c = new WsClient(() => sock, () => {});
    c.start();
    // send while still connecting: no throw, and the frame is not delivered to the socket yet
    expect(() => c.send({ type: "session.send", sessionId: "s1", text: "hi" } as any)).not.toThrow();
    expect(sock.sent.length).toBe(0);
    // socket opens → the buffered frame flushes
    sock.readyState = 1;
    sock.onopen?.();
    const sent = sock.sent.map((d: string) => JSON.parse(d));
    expect(sent.some((m: any) => m.type === "session.send" && m.text === "hi")).toBe(true);
  });

  // audit #31: request() during the CONNECTING window rejects fast (before creating a pending entry)
  // rather than sending on a not-yet-open socket and leaking a pending that never resolves.
  it("request during CONNECTING rejects fast instead of leaking a pending entry", async () => {
    const sock = fakeSocket();
    sock.readyState = 0; // CONNECTING
    const c = new WsClient(() => sock, () => {});
    c.start();
    await expect(c.request({ type: "fleet.list" })).rejects.toThrow(/not connected/);
    expect(sock.sent.length).toBe(0);
  });

  // FIX I4: stop() drains pending and prevents reconnect
  it("stop() rejects pending and prevents reconnect", async () => {
    let connectCount = 0;
    const socks: any[] = [];
    const c = new WsClient(() => {
      connectCount++;
      const s: any = { sent: [], onmessage: null, onopen: null, onclose: null };
      s.send = (d: string) => s.sent.push(d);
      s.close = () => { s.onclose?.(); };
      socks.push(s);
      return s;
    }, () => {});
    c.start();
    socks[0].onopen?.();
    const p = c.request({ type: "fleet.list" });
    c.stop();
    await expect(p).rejects.toThrow("socket closed");
    expect(connectCount).toBe(1); // no reconnect after stop
  });
});
