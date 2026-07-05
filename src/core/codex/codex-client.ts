import type { CodexTransport } from "./codex-transport.js";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

// Newline-delimited JSON-RPC 2.0 client for `codex app-server` (framing verified live:
// one JSON message per line, no Content-Length headers; responses may omit `jsonrpc`).
// Inbound classification: id+method = server→client request; id+result/error = response;
// method only = notification. Malformed lines are ignored (0.x tolerance).
export class CodexClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationCbs: Array<(method: string, params: unknown) => void> = [];
  private readonly serverRequestCbs: Array<(id: number | string, method: string, params: unknown) => void> = [];
  private readonly closedCbs: Array<(err?: Error) => void> = [];
  private closed = false;
  // Guards onClosed against firing twice; kept separate from `closed` (which also gates
  // new requests) so the close()/handleExit() race can't cause a double-fire or the wrong
  // argument (see restructuring note below).
  private firedClosed = false;

  constructor(private readonly transport: CodexTransport) {
    transport.onLine((line) => this.dispatch(line));
    transport.onExit((info) => this.handleExit(info));
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(`codex app-server exited (request ${method})`));
    const id = this.nextId++;
    const p = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.transport.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return p;
  }

  notify(method: string, params: unknown): void {
    this.transport.write(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  respond(id: number | string, result: unknown): void {
    this.transport.write(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  respondError(id: number | string, code: number, message: string): void {
    this.transport.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }

  onNotification(cb: (method: string, params: unknown) => void): void {
    this.notificationCbs.push(cb);
  }

  onServerRequest(cb: (id: number | string, method: string, params: unknown) => void): void {
    this.serverRequestCbs.push(cb);
  }

  onClosed(cb: (err?: Error) => void): void {
    this.closedCbs.push(cb);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.transport.kill();
    this.failPending(new Error("codex app-server closed"));
    this.fireClosed(undefined);
  }

  private dispatch(line: string): void {
    let msg: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string } };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return; // non-JSON noise on stdout — ignore
    }
    if (typeof msg !== "object" || msg === null) return;
    if (msg.id != null && msg.method) {
      for (const cb of this.serverRequestCbs) cb(msg.id, msg.method, msg.params);
      return;
    }
    if (msg.id != null) {
      const pending = this.pending.get(msg.id as number);
      if (!pending) return;
      this.pending.delete(msg.id as number);
      if (msg.error) pending.reject(new Error(`codex: ${msg.error.message ?? "error"} (code ${msg.error.code ?? "?"})`));
      else pending.resolve(msg.result);
      return;
    }
    if (msg.method) {
      for (const cb of this.notificationCbs) cb(msg.method, msg.params);
    }
  }

  private handleExit(info: { code: number | null; message?: string }): void {
    if (this.closed) return; // deliberate close() already ran — already drained, don't re-fire
    this.closed = true;
    const err = new Error(`codex app-server exited (code ${info.code ?? "?"})${info.message ? `: ${info.message.slice(0, 400)}` : ""}`);
    this.failPending(err);
    this.fireClosed(err);
  }

  private failPending(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  // Restructured from the original close()/handleExit() split (see task NOTE): both paths used
  // to set `closed = true` before failing pending requests, which made failPending's own
  // "am I closing deliberately?" check always true — so an unexpected exit ended up firing
  // onClosed with `undefined` instead of the Error, with the correctly-valued call in
  // handleExit() dead (closedCbs already drained). A dedicated `firedClosed` guard plus an
  // explicit value at each call site keeps the contract precise: deliberate close() -> undefined,
  // unexpected exit -> Error, exactly once either way.
  private fireClosed(err: Error | undefined): void {
    if (this.firedClosed) return;
    this.firedClosed = true;
    for (const cb of this.closedCbs.splice(0)) cb(err);
  }
}
