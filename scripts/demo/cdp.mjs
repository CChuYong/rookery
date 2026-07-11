// Minimal Chrome DevTools Protocol client over the Node 22 built-in WebSocket.
// Used to drive and record the desktop renderer when the app runs with ROOKERY_DEBUG_PORT set.
// Zero dependencies by design — this is a demo/capture tool, not product code.

export async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!res.ok) throw new Error(`CDP /json/list failed: ${res.status}`);
  return res.json();
}

// Connect to the first "page" target (optionally filtered by a URL/title substring).
export async function connectPage(port, { match = "", retries = 30, delayMs = 500 } = {}) {
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    try {
      const targets = await listTargets(port);
      const page = targets.find(
        (t) => t.type === "page" && (t.url?.includes(match) || t.title?.includes(match)),
      );
      if (page) return await CdpClient.connect(page.webSocketDebuggerUrl, page);
      lastErr = new Error(`no page target matching "${match}" (${targets.length} targets)`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(delayMs);
  }
  throw lastErr ?? new Error("connectPage: no target");
}

export class CdpClient {
  #ws;
  #nextId = 1;
  #pending = new Map(); // id -> {resolve, reject}
  #listeners = new Map(); // method -> Set<cb>

  static async connect(wsUrl, target) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", (e) => reject(new Error(`CDP connect failed: ${e.message ?? e}`)), { once: true });
    });
    const client = new CdpClient();
    client.#ws = ws;
    client.target = target;
    ws.addEventListener("message", (ev) => client.#onMessage(String(ev.data)));
    return client;
  }

  #onMessage(raw) {
    const msg = JSON.parse(raw);
    if (msg.id !== undefined) {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message}${msg.error.data ? `: ${msg.error.data}` : ""}`));
      else p.resolve(msg.result);
      return;
    }
    for (const cb of this.#listeners.get(msg.method) ?? []) cb(msg.params);
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, cb) {
    if (!this.#listeners.has(method)) this.#listeners.set(method, new Set());
    this.#listeners.get(method).add(cb);
    return () => this.#listeners.get(method)?.delete(cb);
  }

  // Evaluate an expression in the page; returns the JSON value (throws on page-side exception).
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`page eval failed: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ""}`);
    return r.result?.value;
  }

  close() {
    try { this.#ws.close(); } catch { /* already closed */ }
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
