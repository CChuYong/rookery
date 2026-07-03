import { describe, it, expect } from "vitest";
import { WorkerSlackRelay } from "../../src/slack/worker-slack-relay.js";
import type { WorkerRelayDeps } from "../../src/slack/worker-slack-relay.js";
import type { SlackClient, ThreadTarget } from "../../src/slack/types.js";
import type { CoreEvent, WorkerEventData } from "../../src/core/events.js";

function fakeClient() {
  const posts: Array<{ channel: string; thread_ts?: string; text: string }> = [];
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
  return { client, enabled: () => true, channel: () => "C-relay", resolveThread: () => MASTER, ...over };
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

  it("on spawn: posts a root message to the channel + a permalink into the master thread", async () => {
    const f = fakeClient();
    const relay = new WorkerSlackRelay(makeDeps(f.client));
    relay.onEvent(spawn());
    await relay.idle();
    expect(f.posts).toHaveLength(2);
    // root message → relay channel, no thread, carries label + repo leaf + task
    expect(f.posts[0]!.channel).toBe("C-relay");
    expect(f.posts[0]!.thread_ts).toBeUndefined();
    expect(f.posts[0]!.text).toContain("app");
    expect(f.posts[0]!.text).toContain("do x");
    // link message → master thread, carries the permalink
    expect(f.state.permalinks).toBe(1);
    expect(f.posts[1]!.channel).toBe("Cmaster");
    expect(f.posts[1]!.thread_ts).toBe("m1");
    expect(f.posts[1]!.text).toContain("https://slack/C-relay/ts1");
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
    const relay = new WorkerSlackRelay(makeDeps(client));
    relay.onEvent(spawn());
    await relay.idle();
    relay.onEvent(workerEvent({ kind: "message", role: "assistant", content: "still alive" }));
    await relay.idle();
    // the worker registered despite the failed link post → its event was relayed
    expect(appends.some((a) => a.markdown_text === "still alive")).toBe(true);
  });
});
