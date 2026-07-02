import type { SlackHandle } from "./app.js";
import type { SlackStatus } from "../core/events.js";

export interface SlackControllerDeps {
  configured: () => boolean;         // Are both tokens present (DB or env)? A resolver, since tokens can change at runtime.
  enabled: () => boolean;            // Persisted setting slackEnabled (default on)
  setEnabled: (b: boolean) => void;  // Persist the setting
  start: () => Promise<SlackHandle | null>; // = () => startSlack({sessions,bus,config})
  emit: (status: SlackStatus) => void;      // Broadcast status
  // Retry scheduler (injected for tests). Defaults to setTimeout. Return value is a cancel function.
  schedule?: (fn: () => void | Promise<void>, ms: number) => () => void;
}

const START_TIMEOUT_MS = 30000; // If Bolt connect doesn't finish within this time, switch to error instead of getting stuck in 'connecting'
const RETRY_BASE_MS = 2000; // Starting backoff for automatic retry on connection failure
const RETRY_MAX_MS = 60000; // Backoff ceiling (retry every minute during an outage)

function defaultSchedule(fn: () => void | Promise<void>, ms: number): () => void {
  const t = setTimeout(() => { void fn(); }, ms);
  t.unref?.(); // Keep the retry timer from holding the daemon/test process alive
  return () => clearTimeout(t);
}

// Single owner of the Bolt (Socket Mode) lifecycle + status. start/stop are injected as deps → unit-tested with fakes.
export class SlackController {
  private _status: SlackStatus = "unconfigured";
  private handle: SlackHandle | null = null;
  // Incremented on every start/stop — used to tell whether an in-flight start lost its turn (a stop/toggle happened in the meantime).
  // Without it, a toggle-off interleaved during connecting would let a late-resolving handle survive and leak the bot connection (A4).
  private epoch = 0;
  private retryCancel: (() => void) | null = null; // Cancel function for the scheduled retry
  private retryAttempt = 0; // Exponential backoff step (reset to 0 on success/stop)
  constructor(private readonly d: SlackControllerDeps) {}

  status(): SlackStatus {
    return this._status;
  }
  private setStatus(s: SlackStatus): void {
    this._status = s;
    this.d.emit(s);
  }

  // One-time boot: unconfigured if no tokens, off if disabled, async startBolt if enabled.
  async boot(): Promise<void> {
    if (!this.d.configured()) { this.setStatus("unconfigured"); return; }
    if (!this.d.enabled()) { this.setStatus("off"); return; }
    await this.startBolt();
  }

  // Toggle: persist the setting + start/stop. Stays unconfigured if no tokens.
  async setEnabled(enabled: boolean): Promise<void> {
    this.d.setEnabled(enabled);
    if (!this.d.configured()) { this.setStatus("unconfigured"); return; }
    if (enabled) await this.startBolt();
    else { await this.stopBolt(); this.setStatus("off"); }
  }

  // Called after token settings change: tear down the existing connection and re-evaluate against the current configured/enabled to (re)connect.
  // On token swap it reconnects with the new token; on token removal it drops to unconfigured. Same branching as boot() plus an upfront stop.
  async reconcile(): Promise<void> {
    await this.stopBolt();
    if (!this.d.configured()) { this.setStatus("unconfigured"); return; }
    if (!this.d.enabled()) { this.setStatus("off"); return; }
    await this.startBolt();
  }

  async stop(): Promise<void> {
    await this.stopBolt();
  }

  private async startBolt(): Promise<void> {
    if (this._status === "connecting" || this._status === "up") return; // Dedup guard
    const myEpoch = ++this.epoch;
    this.clearRetry(); // Starting a new connection attempt → cancel the scheduled retry
    this.setStatus("connecting");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // If start() never resolves (an outage), we'd be stuck forever in 'connecting' and even retry would be blocked → switch to error via the timeout.
      // A late-resolving start's handle is cleaned up in .then upon detecting an epoch mismatch (prevents connection leaks).
      const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("slack start timeout")), START_TIMEOUT_MS); });
      const started = this.d.start().then((h) => {
        if (myEpoch !== this.epoch && h) void h.stop().catch(() => {}); // Already invalidated (timeout/stop) → clean up the late handle
        return h;
      });
      const h = await Promise.race([started, timeout]);
      if (myEpoch !== this.epoch) {
        // A stop/toggle happened in the meantime → this start is invalid: clean up the late-arriving handle and don't touch the status.
        if (h) { try { await h.stop(); } catch { /* best-effort */ } }
        return;
      }
      this.handle = h;
      this.setStatus(h ? "up" : "unconfigured");
      if (h) this.retryAttempt = 0; // Connection succeeded → reset backoff
    } catch {
      if (myEpoch !== this.epoch) return; // Don't reflect the failure of an invalidated start in the status
      this.epoch++; // Invalidate this attempt → the .then above stops a late-resolving start's handle (prevents leaks)
      this.handle = null;
      this.setStatus("error"); // Break out of the 'connecting' stall
      this.scheduleRetry(); // Exponential-backoff auto retry — recovers from an outage without a manual toggle
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async stopBolt(): Promise<void> {
    this.epoch++; // Invalidate any in-flight start (so it can't flip to up even if it resolves late)
    this.clearRetry(); // Cancel the scheduled auto retry
    this.retryAttempt = 0;
    // Reset the internal status so a following startBolt() (reconcile/setEnabled) passes the connecting/up dedup guard.
    // Not via setStatus (no emit): reconcile/setEnabled set the true final status right after; a bare stop() on shutdown
    // doesn't need to broadcast. Without this, a token swap while connecting/up left the guard blocking the reconnect (stuck).
    this._status = "off";
    const h = this.handle;
    this.handle = null;
    if (h) { try { await h.stop(); } catch { /* best-effort */ } }
  }

  // Schedule the next retry with exponential backoff. Only reconnects if still enabled+configured at firing time.
  private scheduleRetry(): void {
    if (!this.d.configured() || !this.d.enabled()) return;
    this.clearRetry();
    const ms = Math.min(RETRY_BASE_MS * 2 ** this.retryAttempt, RETRY_MAX_MS);
    this.retryAttempt++;
    const schedule = this.d.schedule ?? defaultSchedule;
    this.retryCancel = schedule(async () => {
      this.retryCancel = null;
      if (!this.d.configured() || !this.d.enabled()) return; // Bail if it was turned off in the meantime
      await this.startBolt();
    }, ms);
  }

  private clearRetry(): void {
    if (this.retryCancel) { this.retryCancel(); this.retryCancel = null; }
  }
}
