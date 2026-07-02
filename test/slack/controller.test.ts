import { describe, it, expect, vi } from "vitest";
import { SlackController } from "../../src/slack/controller.js";
import type { SlackHandle } from "../../src/slack/app.js";

const handleFor = () => ({ stop: vi.fn(async () => {}) });

describe("SlackController", () => {
  it("boot with no tokens → unconfigured", async () => {
    const emitted: string[] = [];
    const ctrl = new SlackController({ configured: () => false, enabled: () => true, setEnabled: () => {}, start: vi.fn(), emit: (s) => emitted.push(s) });
    await ctrl.boot();
    expect(ctrl.status()).toBe("unconfigured");
    expect(emitted).toEqual(["unconfigured"]);
  });
  it("boot configured + enabled → connecting then up", async () => {
    const emitted: string[] = [];
    const start = vi.fn(async () => handleFor());
    const ctrl = new SlackController({ configured: () => true, enabled: () => true, setEnabled: () => {}, start, emit: (s) => emitted.push(s) });
    await ctrl.boot();
    expect(start).toHaveBeenCalledOnce();
    expect(ctrl.status()).toBe("up");
    expect(emitted).toEqual(["connecting", "up"]);
  });
  it("boot configured + disabled → off, no start", async () => {
    const start = vi.fn(async () => handleFor());
    const ctrl = new SlackController({ configured: () => true, enabled: () => false, setEnabled: () => {}, start, emit: () => {} });
    await ctrl.boot();
    expect(ctrl.status()).toBe("off");
    expect(start).not.toHaveBeenCalled();
  });
  it("start rejects → error", async () => {
    const ctrl = new SlackController({ configured: () => true, enabled: () => true, setEnabled: () => {}, start: vi.fn(async () => { throw new Error("boom"); }), emit: () => {}, schedule: () => () => {} });
    await ctrl.boot();
    expect(ctrl.status()).toBe("error");
  });
  it("start resolves null → unconfigured", async () => {
    const ctrl = new SlackController({ configured: () => true, enabled: () => true, setEnabled: () => {}, start: vi.fn(async () => null), emit: () => {} });
    await ctrl.boot();
    expect(ctrl.status()).toBe("unconfigured");
  });
  it("setEnabled(false) when up → stops handle + off + persists false", async () => {
    const persisted: boolean[] = [];
    const handle = handleFor();
    const ctrl = new SlackController({ configured: () => true, enabled: () => true, setEnabled: (b) => persisted.push(b), start: async () => handle, emit: () => {} });
    await ctrl.boot();
    await ctrl.setEnabled(false);
    expect(handle.stop).toHaveBeenCalledOnce();
    expect(ctrl.status()).toBe("off");
    expect(persisted).toEqual([false]);
  });
  it("setEnabled(true) when off → starts → up", async () => {
    let en = false;
    const ctrl = new SlackController({ configured: () => true, enabled: () => en, setEnabled: (b) => { en = b; }, start: async () => handleFor(), emit: () => {} });
    await ctrl.boot();
    expect(ctrl.status()).toBe("off");
    await ctrl.setEnabled(true);
    expect(ctrl.status()).toBe("up");
  });
  it("setEnabled(true) when unconfigured → stays unconfigured", async () => {
    const ctrl = new SlackController({ configured: () => false, enabled: () => true, setEnabled: () => {}, start: vi.fn(), emit: () => {} });
    await ctrl.boot();
    await ctrl.setEnabled(true);
    expect(ctrl.status()).toBe("unconfigured");
  });
  it("stop() stops the live handle", async () => {
    const handle = handleFor();
    const ctrl = new SlackController({ configured: () => true, enabled: () => true, setEnabled: () => {}, start: async () => handle, emit: () => {} });
    await ctrl.boot();
    await ctrl.stop();
    expect(handle.stop).toHaveBeenCalledOnce();
  });
  it("reconcile: tokens added while enabled → (re)connects to up", async () => {
    let cfg = false;
    const ctrl = new SlackController({ configured: () => cfg, enabled: () => true, setEnabled: () => {}, start: async () => handleFor(), emit: () => {} });
    await ctrl.boot();
    expect(ctrl.status()).toBe("unconfigured");
    cfg = true; // tokens saved
    await ctrl.reconcile();
    expect(ctrl.status()).toBe("up");
  });
  it("reconcile: tokens removed while up → stops handle + unconfigured", async () => {
    let cfg = true;
    const handle = handleFor();
    const ctrl = new SlackController({ configured: () => cfg, enabled: () => true, setEnabled: () => {}, start: async () => handle, emit: () => {} });
    await ctrl.boot();
    expect(ctrl.status()).toBe("up");
    cfg = false; // tokens cleared
    await ctrl.reconcile();
    expect(handle.stop).toHaveBeenCalled();
    expect(ctrl.status()).toBe("unconfigured");
  });

  it("reconcile: token SWAP while up → tears down and reconnects (not stuck reporting up)", async () => {
    // configured stays true (a token changed, not removed). reconcile must reconnect with the new token.
    const h1 = handleFor(), h2 = handleFor();
    let n = 0;
    const start = vi.fn(async () => (n++ === 0 ? h1 : h2));
    const ctrl = new SlackController({ configured: () => true, enabled: () => true, setEnabled: () => {}, start, emit: () => {} });
    await ctrl.boot();
    expect(ctrl.status()).toBe("up");
    await ctrl.reconcile();
    expect(h1.stop).toHaveBeenCalledOnce(); // old connection torn down
    expect(start).toHaveBeenCalledTimes(2); // reconnected (bug: startBolt guard early-returns on stale "up" → only 1)
    expect(ctrl.status()).toBe("up");
  });

  // B-3: if start() never resolves, transition to error via timeout instead of getting stuck on 'connecting' (retryable).
  it("startBolt times out to error (not stuck on connecting) when start() never resolves", async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<SlackHandle>(() => {}); // never resolves
      const c = new SlackController({ configured: () => true, enabled: () => true, setEnabled: () => {}, start: () => never, emit: () => {} });
      const bootP = c.boot();
      await vi.advanceTimersByTimeAsync(30000); // fire start timeout
      await bootP;
      expect(c.status()).toBe("error"); // error, not stuck on connecting
    } finally {
      vi.useRealTimers();
    }
  });

  // A4: if a toggle-off lands while start() is connecting, clean up the late-resolving handle and do not flip to up.
  it("epoch guard: a stop during 'connecting' stops the late-arriving handle and stays off", async () => {
    let releaseStart!: (h: SlackHandle) => void;
    const startP = new Promise<SlackHandle | null>((res) => { releaseStart = res; });
    const handle = handleFor();
    const emitted: string[] = [];
    const ctrl = new SlackController({ configured: () => true, enabled: () => true, setEnabled: () => {}, start: () => startP, emit: (s) => emitted.push(s) });
    const bootP = ctrl.boot();            // → startBolt → connecting, awaits startP
    await Promise.resolve();
    expect(ctrl.status()).toBe("connecting");
    await ctrl.setEnabled(false);         // stop while connecting (handle still null)
    releaseStart(handle);                 // now start resolves
    await bootP;
    expect(handle.stop).toHaveBeenCalled(); // stop the late-arriving handle
    expect(ctrl.status()).toBe("off");      // does not flip to up
  });

  // UX-11: a connection failure does not end at error but auto-retries with exponential backoff → self-recovers once the outage clears.
  type Sched = { fn: () => void | Promise<void>; ms: number };
  const capture = () => {
    const scheduled: Sched[] = [];
    return { scheduled, schedule: (fn: () => void | Promise<void>, ms: number) => { scheduled.push({ fn, ms }); return () => {}; } };
  };

  it("auto-retries with exponential backoff after a failure and recovers to up (UX-11)", async () => {
    const { scheduled, schedule } = capture();
    let n = 0;
    const start = vi.fn(async () => { n++; if (n < 3) throw new Error("outage"); return handleFor(); });
    const ctrl = new SlackController({ configured: () => true, enabled: () => true, setEnabled: () => {}, start, emit: () => {}, schedule });
    await ctrl.boot();                       // 1st failure → error + retry scheduled
    expect(ctrl.status()).toBe("error");
    expect(scheduled.map((s) => s.ms)).toEqual([2000]); // base backoff
    await scheduled[0]!.fn();                 // fire retry → 2nd failure → error + retry(4000)
    expect(ctrl.status()).toBe("error");
    expect(scheduled.map((s) => s.ms)).toEqual([2000, 4000]); // exponential
    await scheduled[1]!.fn();                 // fire retry → 3rd succeeds
    expect(ctrl.status()).toBe("up");
    expect(start).toHaveBeenCalledTimes(3);
  });

  it("does not retry after being disabled (pending retry becomes a no-op)", async () => {
    const { scheduled, schedule } = capture();
    let en = true;
    const start = vi.fn(async () => { throw new Error("outage"); });
    const ctrl = new SlackController({ configured: () => true, enabled: () => en, setEnabled: (b) => { en = b; }, start, emit: () => {}, schedule });
    await ctrl.boot();                        // failure → error + retry scheduled
    expect(scheduled).toHaveLength(1);
    await ctrl.setEnabled(false);             // disable
    expect(ctrl.status()).toBe("off");
    await scheduled[0]!.fn();                 // retry fired late
    expect(start).toHaveBeenCalledTimes(1);   // disabled, so it does not retry
    expect(ctrl.status()).toBe("off");
  });

  it("caps the backoff at 60s and resets it after a successful connection", async () => {
    const { scheduled, schedule } = capture();
    let fail = true;
    const start = vi.fn(async () => { if (fail) throw new Error("outage"); return handleFor(); });
    const ctrl = new SlackController({ configured: () => true, enabled: () => true, setEnabled: () => {}, start, emit: () => {}, schedule });
    await ctrl.boot();
    for (let i = 0; i < 7; i++) await scheduled[scheduled.length - 1]!.fn(); // keep failing
    expect(scheduled[scheduled.length - 1]!.ms).toBe(60000); // capped at 60s
    fail = false;
    await scheduled[scheduled.length - 1]!.fn(); // recover → up
    expect(ctrl.status()).toBe("up");
    fail = true;
    await ctrl.setEnabled(false); await ctrl.setEnabled(true); // failing again starts backoff from base
    expect(scheduled[scheduled.length - 1]!.ms).toBe(2000); // reset after success
  });
});
