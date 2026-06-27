import type { ClientMessage, ServerMessage, RequestType, RequestResultMap, RequestInput } from "@daemon/protocol/messages.js";
import type { CoreEvent } from "@daemon/core/events.js";

export interface SocketLike {
  send(data: string): void;
  close(): void;
  // The browser WebSocket passes a MessageEvent({data}) to onmessage. The test fake passes a string, so accept both.
  onmessage: ((ev: { data: string } | string) => void) | null;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
}

type Pending = { resolve: (m: ServerMessage) => void; reject: (e: unknown) => void };

export class WsClient {
  private sock: SocketLike | null = null;
  private readonly pending = new Map<string, Pending>();
  private seq = 0;
  private onOpenCb: (() => void) | null = null;
  private onCloseCb: (() => void) | null = null;
  private stopped = false;
  // DSK-1: Buffer fire-and-forget messages sent while disconnected (during reconnect backoff) and flush them on reconnect.
  // Otherwise sends in the sock=null window silently vanish and the user's messages are lost.
  private outbox: string[] = [];
  private static readonly OUTBOX_MAX = 200;

  constructor(
    private readonly connect: () => SocketLike,
    private readonly onEvent: (e: CoreEvent) => void,
  ) {}

  onOpen(cb: () => void): void { this.onOpenCb = cb; }
  // Called whenever the socket disconnects (including entering reconnect backoff) — used to lower the daemon indicator in the UI.
  onClose(cb: () => void): void { this.onCloseCb = cb; }

  start(): void {
    const sock = this.connect();
    this.sock = sock;
    sock.onopen = () => {
      this.onOpenCb?.(); // First subscribe/reseed (events.subscribe etc.) → then flush buffered messages
      this.flushOutbox();
    };
    // A real WebSocket passes a MessageEvent, the fake passes a string → extract only the data string.
    sock.onmessage = (ev) => {
      const data = typeof ev === "string" ? ev : ev?.data;
      if (typeof data === "string") this.handle(data);
    };
    sock.onclose = () => {
      this.sock = null;
      // FIX C2: drain pending on socket close
      for (const p of this.pending.values()) p.reject(new Error("socket closed"));
      this.pending.clear();
      if (!this.stopped) this.onCloseCb?.(); // Only notify on a disconnect that is not an explicit stop (reconnect keeps retrying)
      // FIX I4: skip reconnect when stopped
      if (!this.stopped) {
        setTimeout(() => this.start(), 1000); // backoff reconnect
      }
    };
  }

  // FIX I4: stop() method to cleanly shut down
  stop(): void {
    this.stopped = true;
    this.outbox = []; // After an explicit shutdown, do not send buffered messages
    this.sock?.close();
    for (const p of this.pending.values()) p.reject(new Error("socket closed"));
    this.pending.clear();
  }

  private flushOutbox(): void {
    if (!this.sock || this.outbox.length === 0) return;
    const queued = this.outbox;
    this.outbox = [];
    for (const d of queued) this.sock.send(d);
  }

  private handle(data: string): void {
    let msg: ServerMessage & { reqId?: string };
    try {
      msg = JSON.parse(data) as ServerMessage & { reqId?: string };
    } catch {
      return; // Ignore broken frames (so the handler doesn't crash)
    }
    if (msg.type === "event") { this.onEvent((msg as { event: CoreEvent }).event); return; }
    // FIX C1: handle error messages with reqId
    if (msg.type === "error" && msg.reqId && this.pending.has(msg.reqId)) {
      const reqId = msg.reqId;
      this.pending.get(reqId)!.reject(new Error(msg.message));
      this.pending.delete(reqId);
      return;
    }
    if (msg.reqId && this.pending.has(msg.reqId)) {
      this.pending.get(msg.reqId)!.resolve(msg);
      this.pending.delete(msg.reqId);
    }
  }

  send(msg: ClientMessage): void {
    const data = JSON.stringify(msg);
    if (this.sock) { this.sock.send(data); return; }
    // While disconnected, don't drop it but buffer it in the outbox (flushed in the reconnect onopen). Capped to prevent unbounded growth.
    if (!this.stopped && this.outbox.length < WsClient.OUTBOX_MAX) this.outbox.push(data);
  }

  // Type-safe: the request type determines the response type (RequestResultMap[K]). reqId is injected here, so callers omit it.
  // Responses are correlated by reqId, and we cast trusting the contract that the daemon sends the response for that type (the protocol is the single source for the request-response mapping).
  request<K extends RequestType>(msg: RequestInput<K>): Promise<RequestResultMap[K]> {
    // FIX C3: reject immediately when not connected
    if (!this.sock) {
      return Promise.reject(new Error("not connected"));
    }
    const reqId = `q${this.seq++}`;
    return new Promise<RequestResultMap[K]>((resolve, reject) => {
      this.pending.set(reqId, { resolve: resolve as (m: ServerMessage) => void, reject });
      this.sock?.send(JSON.stringify({ ...msg, reqId }));
    });
  }
}
