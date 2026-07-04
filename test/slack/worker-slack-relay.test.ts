import { describe, it, expect } from "vitest";
import { WorkerSlackRelay } from "../../src/slack/worker-slack-relay.js";
import type { WorkerRelayDeps } from "../../src/slack/worker-slack-relay.js";
import type { SlackClient, ThreadTarget } from "../../src/slack/types.js";
import type { CoreEvent, WorkerEventData } from "../../src/core/events.js";

function fakeClient() {
  const posts: Array<{ channel: string; thread_ts?: string; text: string; unfurl_links?: boolean; unfurl_media?: boolean }> = [];
  const appends: Array<{ markdown_text?: string }> = [];
  const state = { permalinks: 0 };
  const client: SlackClient = {
    chatStream: () => ({ append: async (p) => { appends.push(p as { markdown_text?: string }); }, stop: async () => {} }),
    chat: {
      postMessage: async (a) => { posts.push(a); return { ts: `ts${posts.length}` }; },
      getPermalink: async (a) => { state.permalinks++; return { permalink: `https://slack/${a.channel}/${a.message_ts}` }; },
    },
  };
  return { client, posts, appends, state };
}

const MASTER: ThreadTarget = { channel: "Cmaster", threadTs: "m1", team: "T1" };

function makeDeps(client: SlackClient, over: Partial<WorkerRelayDeps> = {}): WorkerRelayDeps {
  return { client, enabled: () => true, channel: () => "C-relay", resolveThread: () => MASTER, alert: async () => true, ...over };
}

const spawn = (over: Partial<Extract<CoreEvent, { type: "worker.spawned" }>> = {}): CoreEvent =>
  ({ type: "worker.spawned", sessionId: "s1", workerId: "w1", repoPath: "/r/app", label: "app", task: "do x", ...over });
const workerEvent = (data: WorkerEventData, workerId = "w1"): CoreEvent =>
  ({ type: "worker.event", sessionId: "s1", workerId, seq: 1, data });

describe("WorkerSlackRelay", () => {
  it("posts nothing when disabled", async () => {
    const f = fakeClient();
    const relay = new WorkerSlackRelay(makeDeps(f.client, { enabled: () => false }));
    relay.onEvent(spawn());
    await relay.idle();
    expect(f.posts).toEqual([]);
  });

  it("posts nothing when no channel is set", async () => {
    const f = fakeClient();
    const relay = new WorkerSlackRelay(makeDeps(f.client, { channel: () => "" }));
    relay.onEvent(spawn());
    await relay.idle();
    expect(f.posts).toEqual([]);
  });

  it("posts nothing when the master session is not Slack-origin", async () => {
    const f = fakeClient();
    const relay = new WorkerSlackRelay(makeDeps(f.client, { resolveThread: () => null }));
    relay.onEvent(spawn());
    await relay.idle();
    expect(f.posts).toEqual([]);
  });

  it("on spawn: posts a root card + weaves a blockquote alert into the master stream (no separate follow post)", async () => {
    const f = fakeClient();
    const alerts: Array<{ sessionId: string; md: string }> = [];
    const relay = new WorkerSlackRelay(makeDeps(f.client, { alert: async (sessionId, md) => { alerts.push({ sessionId, md }); return true; } }));
    relay.onEvent(spawn());
    await relay.idle();
    // root card → relay channel; the follow notice is now an in-stream alert, NOT a separate post
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0]!.channel).toBe("C-relay");
    expect(f.posts[0]!.thread_ts).toBeUndefined();
    expect(f.state.permalinks).toBe(1);
    // the alert is a blockquote carrying the masked permalink, routed to the master session's reporter
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.sessionId).toBe("s1");
    expect(alerts[0]!.md.startsWith("> ")).toBe(true);
    expect(alerts[0]!.md).toContain("app"); // label
    expect(alerts[0]!.md).toContain("https://slack/C-relay/ts1"); // permalink
  });

  it("falls back to a threaded post (unfurl off) when no master reporter is found", async () => {
    const f = fakeClient();
    const relay = new WorkerSlackRelay(makeDeps(f.client, { alert: async () => false }));
    relay.onEvent(spawn());
    await relay.idle();
    expect(f.posts).toHaveLength(2); // root card + fallback follow post
    const followed = f.posts[1]!;
    expect(followed.channel).toBe("Cmaster");
    expect(followed.thread_ts).toBe("m1");
    expect(followed.text.startsWith("> ")).toBe(true);
    expect(followed.text).toContain("https://slack/C-relay/ts1");
    expect(followed.unfurl_links).toBe(false);
    expect(followed.unfurl_media).toBe(false);
  });

  it("feeds a tracked worker's assistant message into its thread reporter", async () => {
    const f = fakeClient();
    const relay = new WorkerSlackRelay(makeDeps(f.client));
    relay.onEvent(spawn());
    await relay.idle();
    relay.onEvent(workerEvent({ kind: "message", role: "assistant", content: "hi from worker" }));
    await relay.idle();
    expect(f.appends.some((a) => a.markdown_text === "hi from worker")).toBe(true);
  });

  it("ignores excluded event kinds (streaming deltas)", async () => {
    const f = fakeClient();
    const relay = new WorkerSlackRelay(makeDeps(f.client));
    relay.onEvent(spawn());
    await relay.idle();
    relay.onEvent(workerEvent({ kind: "message_delta", text: "stream" }));
    await relay.idle();
    expect(f.appends).toEqual([]);
  });

  it("stops tracking a worker on a terminal status", async () => {
    const f = fakeClient();
    const relay = new WorkerSlackRelay(makeDeps(f.client));
    relay.onEvent(spawn());
    await relay.idle();
    relay.onEvent({ type: "worker.status", sessionId: "s1", workerId: "w1", status: "stopped" });
    await relay.idle();
    relay.onEvent(workerEvent({ kind: "message", role: "assistant", content: "after stop" }));
    await relay.idle();
    expect(f.appends).toEqual([]); // worker untracked → not relayed
  });

  it("events emitted before onSpawned finishes are buffered and flushed in order (audit #19)", async () => {
    const f = fakeClient();
    const relay = new WorkerSlackRelay(makeDeps(f.client));
    // spawn, then IMMEDIATELY emit worker.events WITHOUT awaiting relay.idle() — they race the spawn round-trips.
    relay.onEvent(spawn());
    relay.onEvent(workerEvent({ kind: "message", role: "assistant", content: "first" }));
    relay.onEvent(workerEvent({ kind: "message", role: "assistant", content: "second" }));
    await relay.idle();
    const delivered = f.appends.map((a) => a.markdown_text);
    expect(delivered).toContain("first");
    expect(delivered).toContain("second");
    // flushed in arrival order
    expect(delivered.indexOf("first")).toBeLessThan(delivered.indexOf("second"));
  });

  it("delivers a worker.event that arrives during the alert round-trip (not dropped)", async () => {
    const f = fakeClient();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const relay = new WorkerSlackRelay(makeDeps(f.client, { alert: async () => { await gate; return true; } }));
    relay.onEvent(spawn());
    // let onSpawned run past the root post + registration + flush, up to the blocked alert
    for (let i = 0; i < 10; i++) await Promise.resolve();
    // this event arrives while alert() is awaiting — must go straight to the registered reporter, not a cleared buffer
    relay.onEvent(workerEvent({ kind: "message", role: "assistant", content: "during-alert" }));
    release();
    await relay.idle();
    expect(f.appends.some((a) => a.markdown_text === "during-alert")).toBe(true);
  });

  it("a failed master-thread link post does not disable the relay for that worker (audit #19)", async () => {
    const posts: Array<{ channel: string; thread_ts?: string; text: string }> = [];
    const appends: Array<{ markdown_text?: string }> = [];
    const client: SlackClient = {
      chatStream: () => ({ append: async (p) => { appends.push(p as { markdown_text?: string }); }, stop: async () => {} }),
      chat: {
        // Root post to the relay channel succeeds; the link post into the master thread rejects.
        postMessage: async (a) => {
          if (a.channel === MASTER.channel) throw new Error("link post boom");
          posts.push(a);
          return { ts: `ts${posts.length}` };
        },
        getPermalink: async (a) => ({ permalink: `https://slack/${a.channel}/${a.message_ts}` }),
      },
    };
    // Force the fallback-post branch (no reporter found) so the fake client's throw-on-master-channel is actually exercised.
    const relay = new WorkerSlackRelay(makeDeps(client, { alert: async () => false }));
    relay.onEvent(spawn());
    await relay.idle();
    relay.onEvent(workerEvent({ kind: "message", role: "assistant", content: "still alive" }));
    await relay.idle();
    // the worker registered despite the failed link post → its event was relayed
    expect(appends.some((a) => a.markdown_text === "still alive")).toBe(true);
  });
});
