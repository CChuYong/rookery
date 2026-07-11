// Thin daemon protocol client (the same WS the desktop/CLI clients use), for seeding and
// conducting demo scenes: request/response by reqId + a CoreEvent listener/waiter.
import fs from "node:fs";
import path from "node:path";

export async function connectDaemon({ home, host = "127.0.0.1", port = 8787 }) {
  const token = fs.readFileSync(path.join(home, "ws-token"), "utf8").trim();
  const ws = new WebSocket(`ws://${host}:${port}/ws?token=${encodeURIComponent(token)}`);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", (e) => reject(new Error(`daemon ws connect failed: ${e.message ?? e}`)), { once: true });
  });

  let nextReq = 0;
  const pending = new Map(); // reqId -> {resolve, reject}
  const eventListeners = new Set(); // cb(coreEvent)

  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.type === "event") {
      for (const cb of eventListeners) cb(msg.event);
      return;
    }
    if (msg.reqId && pending.has(msg.reqId)) {
      const p = pending.get(msg.reqId);
      pending.delete(msg.reqId);
      if (msg.type === "error") p.reject(new Error(msg.message));
      else p.resolve(msg);
    }
  });

  return {
    // Fire-and-forget (messages with no reqId'd reply, e.g. events.subscribe).
    send(msg) { ws.send(JSON.stringify(msg)); },
    // Send a request message; resolves with the correlated reply (rejects on protocol error).
    request(msg, { timeoutMs = 30000 } = {}) {
      const reqId = `demo${nextReq++}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(reqId);
          reject(new Error(`request timeout: ${msg.type}`));
        }, timeoutMs);
        pending.set(reqId, {
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        ws.send(JSON.stringify({ ...msg, reqId }));
      });
    },
    onEvent(cb) {
      eventListeners.add(cb);
      return () => eventListeners.delete(cb);
    },
    // Resolve when a CoreEvent matching `pred` arrives (subscribe with events.subscribe first).
    waitForEvent(pred, { timeoutMs = 180000, label = "event" } = {}) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { off(); reject(new Error(`timeout waiting for ${label}`)); }, timeoutMs);
        const off = (() => {
          const cb = (e) => { if (pred(e)) { clearTimeout(timer); eventListeners.delete(cb); resolve(e); } };
          eventListeners.add(cb);
          return () => eventListeners.delete(cb);
        })();
      });
    },
    close() { try { ws.close(); } catch { /* closed */ } },
  };
}

// Wait until the daemon's /health responds (e.g. right after spawning it).
export async function waitHealthy({ host = "127.0.0.1", port = 8787, retries = 60, delayMs = 500 } = {}) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(`http://${host}:${port}/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error("daemon /health never came up");
}
