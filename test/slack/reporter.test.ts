import { describe, it, expect, vi } from "vitest";
import { SlackThreadReporter } from "../../src/slack/reporter.js";
import type { SlackClient, ChatStreamArgs, ChatStreamerLike, AppendPayload, PlanChunk } from "../../src/slack/types.js";
import type { CoreEvent } from "../../src/core/events.js";

interface Stream {
  args: ChatStreamArgs;
  chunks: PlanChunk[];
  stopped: boolean;
  stopBlocks?: unknown[];
}
interface Rec {
  streams: Stream[];
  posts: string[];
}

function toChunks(p: AppendPayload): PlanChunk[] {
  return "chunks" in p ? p.chunks : [{ type: "markdown_text", text: p.markdown_text }];
}

function fakeClient(rec: Rec, opts: { failFirstAppendWith?: string } = {}): SlackClient {
  let appendFails = opts.failFirstAppendWith ? 1 : 0;
  return {
    chatStream(args: ChatStreamArgs): ChatStreamerLike {
      const s: Stream = { args, chunks: [], stopped: false };
      rec.streams.push(s);
      return {
        async append(p) {
          if (appendFails > 0) {
            appendFails--;
            const err = new Error("slack") as Error & { data?: { error: string } };
            err.data = { error: opts.failFirstAppendWith! };
            throw err;
          }
          s.chunks.push(...toChunks(p));
        },
        async stop(o) {
          s.stopped = true;
          s.stopBlocks = o?.blocks;
        },
      };
    },
    chat: {
      async postMessage(a) {
        rec.posts.push(a.text);
      },
    },
  };
}

const target = { channel: "C1", threadTs: "100.1", team: "T1", userId: "U1" };
const texts = (s: Stream) => s.chunks.filter((c) => c.type === "markdown_text").map((c) => (c as { text: string }).text);
const tasks = (s: Stream) =>
  s.chunks.filter((c) => c.type === "task_update") as Array<{ id: string; title: string; status: string }>;

const ev = {
  msg: (content: string): CoreEvent => ({ type: "master.message", sessionId: "s1", role: "assistant", content }),
  msgDelta: (delta: string): CoreEvent => ({ type: "master.message.delta", sessionId: "s1", delta }),
  thinkDelta: (delta: string): CoreEvent => ({ type: "master.thinking.delta", sessionId: "s1", delta }),
  toolStart: (id: string, name: string): CoreEvent => ({ type: "master.tool", sessionId: "s1", toolId: id, name, phase: "start" }),
  toolEnd: (id: string, ok: boolean): CoreEvent => ({ type: "master.tool", sessionId: "s1", toolId: id, name: "", phase: "end", ok }),
  result: (): CoreEvent => ({ type: "master.result", sessionId: "s1", subtype: "success", costUsd: 0.05, numTurns: 3, durationMs: 12300, contextTokens: 84200, contextWindow: 200000 }),
  spawned: (): CoreEvent => ({ type: "worker.spawned", sessionId: "s1", workerId: "a1", repoPath: "/r", label: "fix" }),
  status: (status: string): CoreEvent => ({ type: "worker.status", sessionId: "s1", workerId: "a1", status }),
};

describe("SlackThreadReporter (plan card)", () => {
  it("worker.spawned label + repo localize via getLocale(en)", async () => {
    const rec: Rec = { streams: [], posts: [] };
    const r = new SlackThreadReporter(fakeClient(rec), target, () => "en");
    r.onEvent({ type: "worker.spawned", sessionId: "s1", workerId: "w1", repoPath: "/x/repo", label: "lbl" } as CoreEvent);
    await r.idle();
    const text = JSON.stringify(rec.streams);
    expect(text).toContain("Worker lbl");
    expect(text).toContain("Repo repo");
  });

  it("opens the stream in plan mode and streams prose as markdown_text", async () => {
    const rec: Rec = { streams: [], posts: [] };
    const r = new SlackThreadReporter(fakeClient(rec), target);
    r.onEvent(ev.msg("hello"));
    r.onEvent(ev.result());
    await r.idle();
    expect(rec.streams[0]!.args.task_display_mode).toBe("plan");
    expect(texts(rec.streams[0]!)).toEqual(["hello"]);
    expect(rec.streams[0]!.stopped).toBe(true);
    const blocks = JSON.stringify(rec.streams[0]!.stopBlocks);
    expect(blocks).toContain("context 42%"); // 84200/200000
    expect(blocks).toContain("84.2k tok");
    expect(blocks).toContain("12.3s");
    expect(blocks).not.toContain("$"); // cost removed
  });

  it("streams master.message.delta live (coalesced) without duplicating the final master.message", async () => {
    const rec: Rec = { streams: [], posts: [] };
    const r = new SlackThreadReporter(fakeClient(rec), target);
    // Total exceeds PROSE_FLUSH(40) — an intermediate flush fires, so it streams live across multiple chunks.
    const parts = ["The quick brown fox ", "jumps over the lazy dog ", "and keeps on running."];
    const full = parts.join("");
    for (const p of parts) r.onEvent(ev.msgDelta(p));
    r.onEvent(ev.msg(full)); // block complete — what was already streamed is not re-sent
    r.onEvent(ev.result());
    await r.idle();
    const chunks = texts(rec.streams[0]!);
    expect(chunks.join("")).toBe(full); // exactly one copy of the body, no duplication
    expect(chunks.length).toBeGreaterThan(1); // streamed live in pieces, not in one shot
  });

  it("renders thinking as a single in-place plan task card (details = plain string) → no fallback spam", async () => {
    const rec: Rec = { streams: [], posts: [] };
    const r = new SlackThreadReporter(fakeClient(rec), target);
    r.onEvent(ev.thinkDelta("Let me think about the request. "));
    r.onEvent(ev.thinkDelta("I should check the repo layout first, then the failing test, "));
    r.onEvent(ev.thinkDelta("and finally propose a minimal fix."));
    r.onEvent(ev.msg("Here's the plan.")); // answer starts → thinking card completes
    r.onEvent(ev.result());
    await r.idle();
    const think = rec.streams[0]!.chunks.filter(
      (c) => c.type === "task_update" && (c as { id?: string }).id === "__thinking__",
    ) as Array<{ status: string; details?: unknown }>;
    expect(think.length).toBeGreaterThan(0);
    expect(think.every((c) => (c as { id: string }).id === "__thinking__")).toBe(true); // same id = in-place update (no flooding)
    expect(think[0]!.status).toBe("in_progress");
    expect(think[think.length - 1]!.status).toBe("complete"); // completes when the answer starts
    expect(typeof think[0]!.details).toBe("string"); // details is a plain string (rich_text object ❌ — that was the cause of schema rejection)
    expect(think[0]!.details as string).toContain("check the repo layout");
    expect(rec.posts).toEqual([]); // no append-fallback post (= no flooding)
  });

  it("shows the tool input on the card and the error result on failure (UX-6)", async () => {
    const rec: Rec = { streams: [], posts: [] };
    const r = new SlackThreadReporter(fakeClient(rec), target);
    r.onEvent({ type: "master.tool", sessionId: "s1", toolId: "t1", name: "spawn_worker", phase: "start", input: 'repo "app", task "fix login"' });
    r.onEvent({ type: "master.tool", sessionId: "s1", toolId: "t1", name: "", phase: "end", ok: false, result: "boom: repo not found" });
    r.onEvent(ev.result());
    await r.idle();
    const cards = rec.streams[0]!.chunks.filter(
      (c) => c.type === "task_update" && (c as { id?: string }).id === "t1",
    ) as Array<{ status: string; details?: string }>;
    expect(cards[0]!.status).toBe("in_progress");
    expect(cards[0]!.details).toContain("fix login"); // shows input on start
    const errCard = cards.find((c) => c.status === "error");
    expect(errCard?.details).toContain("repo not found"); // shows the error body on failure
  });

  it("does not complete a tool task on a 'progress' event (only on end)", async () => {
    const rec: Rec = { streams: [], posts: [] };
    const r = new SlackThreadReporter(fakeClient(rec), target);
    r.onEvent({ type: "master.tool", sessionId: "s1", toolId: "t1", name: "view_worker_diff", phase: "start" });
    r.onEvent({ type: "master.tool", sessionId: "s1", toolId: "t1", name: "", phase: "progress", elapsedSec: 5 });
    await r.idle();
    const cards = tasks(rec.streams[0]!).filter((c) => c.id === "t1");
    expect(cards.every((c) => c.status === "in_progress")).toBe(true); // progress must not finalize as complete
  });

  it("renders master.notice as a blank-line-isolated blockquote (unified with worker alerts, UX-7)", async () => {
    const rec: Rec = { streams: [], posts: [] };
    const r = new SlackThreadReporter(fakeClient(rec), target);
    r.onEvent({ type: "master.notice", sessionId: "s1", text: "컨텍스트 압축 중…" });
    r.onEvent(ev.msg("done"));
    r.onEvent(ev.result());
    await r.idle();
    const md = texts(rec.streams[0]!).join("");
    expect(md).toContain("컨텍스트 압축 중…");
    expect(md).toContain("ℹ️");
    // blockquote-prefixed + blank-line isolated so it can't bleed into surrounding prose
    expect(md).toContain("\n\n> ℹ️ 컨텍스트 압축 중…\n\n");
  });

  it("logs a postMessage failure instead of silently swallowing it (UX-10)", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const client: SlackClient = {
      chatStream() { return { async append() {}, async stop() {} }; },
      chat: { async postMessage() { throw new Error("channel_not_found"); } },
    };
    const r = new SlackThreadReporter(client, target);
    r.onEvent(ev.status("done")); // terminal worker status → post(✅ …) → throw
    await r.idle();
    const wrote = spy.mock.calls.map((c) => String(c[0]));
    spy.mockRestore();
    expect(wrote.some((w) => w.includes("slack post failed"))).toBe(true);
  });

  it("renders worker.spawned as a plan card with the worker identity (UX-9)", async () => {
    const rec: Rec = { streams: [], posts: [] };
    const r = new SlackThreadReporter(fakeClient(rec), target);
    r.onEvent({ type: "worker.spawned", sessionId: "s1", workerId: "app-1", repoPath: "/code/app", label: "fix login" });
    await r.idle();
    const cards = rec.streams[0]!.chunks.filter(
      (c) => c.type === "task_update" && (c as { id?: string }).id === "worker:app-1",
    ) as Array<{ title: string; status: string; details?: string }>;
    expect(cards).toHaveLength(1);
    expect(cards[0]!.status).toBe("in_progress"); // a spawned worker is still working
    expect(cards[0]!.title).toContain("fix login"); // identified by the worker label
    expect(cards[0]!.details).toContain("app"); // repo context
    expect(rec.posts).toEqual([]); // a plan card, not a separate message
  });

  it("sends the tool input as details only once (start), not again on success end (append doubling fix)", async () => {
    const rec: Rec = { streams: [], posts: [] };
    const r = new SlackThreadReporter(fakeClient(rec), target);
    r.onEvent({ type: "master.tool", sessionId: "s1", toolId: "t1", name: "spawn_worker", phase: "start", input: '{"id":"X"}' });
    r.onEvent({ type: "master.tool", sessionId: "s1", toolId: "t1", name: "", phase: "end", ok: true });
    r.onEvent(ev.result());
    await r.idle();
    const cards = rec.streams[0]!.chunks.filter(
      (c) => c.type === "task_update" && (c as { id?: string }).id === "t1",
    ) as Array<{ status: string; details?: string }>;
    const withInput = cards.filter((c) => c.details?.includes('{"id":"X"}'));
    expect(withInput).toHaveLength(1); // input only once on start — so Slack append doesn't double it
    expect(cards.find((c) => c.status === "complete")?.details).toBeUndefined(); // a successful end does not re-send details
  });

  it("sends thinking as incremental deltas, not the repeated tail (append accumulation fix)", async () => {
    const rec: Rec = { streams: [], posts: [] };
    const r = new SlackThreadReporter(fakeClient(rec), target);
    r.onEvent(ev.thinkDelta("A".repeat(130)));
    r.onEvent(ev.thinkDelta("B".repeat(130)));
    r.onEvent(ev.msg("done"));
    r.onEvent(ev.result());
    await r.idle();
    const think = rec.streams[0]!.chunks.filter(
      (c) => c.type === "task_update" && (c as { id?: string }).id === "__thinking__",
    ) as Array<{ details?: string }>;
    const joined = think.map((c) => c.details ?? "").join("");
    expect(joined).toBe("A".repeat(130) + "B".repeat(130)); // deltas only — no overlapping-tail accumulation
  });

  it("on msg_too_long for a task-only payload, posts a synthesized summary instead of dropping it", async () => {
    const rec: Rec = { streams: [], posts: [] };
    const r = new SlackThreadReporter(fakeClient(rec, { failFirstAppendWith: "msg_too_long" }), target);
    r.onEvent(ev.toolStart("t1", "spawn_worker")); // payload with only task_update → append fails with msg_too_long
    await r.idle();
    expect(rec.posts.length).toBe(1);               // surfaced as a post instead of silently dropped
    expect(rec.posts[0]).toContain("spawn_worker"); // includes the task title summary
  });

  it("renders tool calls as task_update chunks (in_progress → complete)", async () => {
    const rec: Rec = { streams: [], posts: [] };
    const r = new SlackThreadReporter(fakeClient(rec), target);
    r.onEvent(ev.toolStart("t1", "spawn_worker"));
    r.onEvent(ev.toolEnd("t1", true));
    r.onEvent(ev.result());
    await r.idle();
    const t = tasks(rec.streams[0]!);
    expect(t).toEqual([
      { type: "task_update", id: "t1", title: "spawn_worker", status: "in_progress" },
      { type: "task_update", id: "t1", title: "spawn_worker", status: "complete" },
    ]);
  });

  it("force-completes unfinished tasks at result", async () => {
    const rec: Rec = { streams: [], posts: [] };
    const r = new SlackThreadReporter(fakeClient(rec), target);
    r.onEvent(ev.toolStart("t1", "recall"));
    r.onEvent(ev.result()); // no toolEnd → force complete
    await r.idle();
    const t = tasks(rec.streams[0]!);
    expect(t.some((c) => c.id === "t1" && c.status === "complete")).toBe(true);
    expect(rec.streams[0]!.stopped).toBe(true);
  });

  it("does NOT post a separate message for worker.spawned", async () => {
    const rec: Rec = { streams: [], posts: [] };
    const r = new SlackThreadReporter(fakeClient(rec), target);
    r.onEvent(ev.spawned());
    await r.idle();
    expect(rec.posts).toEqual([]);
  });

  it("posts terminal worker status to the thread", async () => {
    const rec: Rec = { streams: [], posts: [] };
    const r = new SlackThreadReporter(fakeClient(rec), target);
    r.onEvent(ev.status("done"));
    await r.idle();
    expect(rec.posts.some((p) => p.includes("a1") && p.includes("done"))).toBe(true);
  });

  it("posts a success line when a worker reaches done", async () => {
    const rec: Rec = { streams: [], posts: [] };
    const r = new SlackThreadReporter(fakeClient(rec), target);
    r.onEvent(ev.status("done"));
    await r.idle();
    expect(rec.posts.some((p) => p.includes("a1") && p.includes("done"))).toBe(true);
  });

  it("does NOT post idle/running status (avoids per-turn spam)", async () => {
    const rec: Rec = { streams: [], posts: [] };
    const r = new SlackThreadReporter(fakeClient(rec), target);
    r.onEvent(ev.status("idle"));
    r.onEvent(ev.status("running"));
    await r.idle();
    expect(rec.posts).toEqual([]);
  });

  // The state graph retired `done` from live writes, so keying the icon off it meant every live terminal
  // transition — failures included — posted the same neutral robot.
  it("flags a failure transition with a warning icon instead of the neutral robot", async () => {
    const rec: Rec = { streams: [], posts: [] };
    const r = new SlackThreadReporter(fakeClient(rec), target);
    r.onEvent(ev.status("error"));
    await r.idle();
    expect(rec.posts.some((p) => p.includes("⚠️") && p.includes("a1"))).toBe(true);
  });

  it("posts a neutral icon for stopped — Slack cannot tell a natural end from a user stop", async () => {
    const rec: Rec = { streams: [], posts: [] };
    const r = new SlackThreadReporter(fakeClient(rec), target);
    r.onEvent(ev.status("stopped"));
    await r.idle();
    expect(rec.posts.some((p) => p.includes("🤖") && p.includes("a1"))).toBe(true);
    expect(rec.posts.some((p) => p.includes("⚠️"))).toBe(false);
  });

  it("does NOT post background status — the worker is mid-work, not settled", async () => {
    const rec: Rec = { streams: [], posts: [] };
    const r = new SlackThreadReporter(fakeClient(rec), target);
    r.onEvent(ev.status("background"));
    await r.idle();
    expect(rec.posts).toEqual([]);
  });

  it("posts a worker's terminal status only once even if emitted twice (two-writer dedup)", async () => {
    const rec: Rec = { streams: [], posts: [] };
    const r = new SlackThreadReporter(fakeClient(rec), target);
    // Worker.transition + FleetOrchestrator.setStatus each emit the same terminal status → arrives twice.
    r.onEvent(ev.status("stopped"));
    r.onEvent(ev.status("stopped"));
    await r.idle();
    expect(rec.posts.filter((p) => p.includes("stopped"))).toHaveLength(1);
  });

  it("stops the stream and clears tasks on an errored turn so the next turn is clean", async () => {
    const rec: Rec = { streams: [], posts: [] };
    const r = new SlackThreadReporter(fakeClient(rec), target);
    r.onEvent(ev.toolStart("t1", "spawn_worker"));
    r.onEvent({ type: "error", sessionId: "s1", message: "boom" });
    await r.idle();
    expect(rec.streams[0]!.stopped).toBe(true); // an errored turn must close the stream
    // the next turn starts on a fresh stream (not polluted by reusing the old one)
    r.onEvent(ev.msg("next turn"));
    r.onEvent(ev.result());
    await r.idle();
    expect(rec.streams.length).toBe(2);
    expect(texts(rec.streams[1]!)).toEqual(["next turn"]);
  });

  it("retries append on a streaming-state error with a new stream", async () => {
    const rec: Rec = { streams: [], posts: [] };
    const r = new SlackThreadReporter(fakeClient(rec, { failFirstAppendWith: "message_not_in_streaming_state" }), target);
    r.onEvent(ev.msg("hi"));
    await r.idle();
    expect(rec.streams.length).toBeGreaterThanOrEqual(2);
    expect(texts(rec.streams[rec.streams.length - 1]!)).toEqual(["hi"]);
  });

  it("posts a worker error to the thread (slack-worker-event-deltas-dropped)", async () => {
    const rec: Rec = { streams: [], posts: [] };
    const r = new SlackThreadReporter(fakeClient(rec), target);
    r.onEvent({ type: "worker.event", sessionId: "s1", workerId: "a1", seq: 0, data: { kind: "error", message: "build broke" } });
    await r.idle();
    expect(rec.posts.some((p) => p.includes("a1") && p.includes("build broke"))).toBe(true);
  });

  it("does not re-send an oversized payload on msg_too_long; falls back to one byte-truncated post", async () => {
    const rec: Rec = { streams: [], posts: [] };
    let appendCalls = 0;
    const client: SlackClient = {
      chatStream() {
        return {
          async append() {
            appendCalls++;
            const err = new Error("slack") as Error & { data?: { error: string } };
            err.data = { error: "msg_too_long" };
            throw err;
          },
          async stop() {},
        };
      },
      chat: { async postMessage(a) { rec.posts.push(a.text); } },
    };
    const r = new SlackThreadReporter(client, target);
    r.onEvent(ev.msg("X".repeat(100000)));
    await r.idle();
    expect(appendCalls).toBe(1); // does not retry the same oversized payload indefinitely
    expect(rec.posts.length).toBe(1); // gets it through once without losing it
    expect(Buffer.byteLength(rec.posts[0]!, "utf8")).toBeLessThanOrEqual(38000); // the post is byte-truncated too, so real Slack doesn't lose it either
  });
});

describe("threadAlert", () => {
  it("weaves the alert into the live stream when a turn is streaming", async () => {
    const rec: Rec = { streams: [], posts: [] };
    const r = new SlackThreadReporter(fakeClient(rec), target);
    r.onEvent(ev.toolStart("t1", "spawn_worker")); // opens the stream (tool card)
    await r.idle();
    await r.threadAlert("> 🧵 alert · <https://x|open>");
    const streamed = rec.streams.flatMap(texts).join("");
    expect(streamed).toContain("> 🧵 alert · <https://x|open>");
    // blank-line isolated both sides so the blockquote can't bleed into the surrounding prose (Slack quotes until a blank line)
    expect(streamed).toContain("\n\n> 🧵 alert · <https://x|open>\n\n");
    expect(rec.posts).toEqual([]); // woven in, not a separate post
  });

  it("posts a threaded blockquote with unfurl off when no stream is open", async () => {
    const posts: Array<{ text: string; unfurl_links?: boolean; unfurl_media?: boolean }> = [];
    const client: SlackClient = {
      chatStream: () => { throw new Error("should not open a stream"); },
      chat: { async postMessage(a) { posts.push(a as typeof posts[number]); return {}; } },
    };
    const r = new SlackThreadReporter(client, target);
    await r.threadAlert("> 🧵 alert · <https://x|open>");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.text).toContain("> 🧵 alert");
    expect(posts[0]!.unfurl_links).toBe(false);
    expect(posts[0]!.unfurl_media).toBe(false);
  });

  it("does not pollute streamedText — the terminal master.message is still delivered whole", async () => {
    const rec: Rec = { streams: [], posts: [] };
    const r = new SlackThreadReporter(fakeClient(rec), target);
    r.onEvent(ev.toolStart("t1", "spawn_worker")); // open the stream
    await r.idle();
    await r.threadAlert("> 🧵 alert · <https://x|open>");
    r.onEvent(ev.msg("the full assistant answer")); // terminal message, no prior deltas → must send in full
    await r.idle();
    const streamed = rec.streams.flatMap(texts).join("");
    expect(streamed).toContain("> 🧵 alert · <https://x|open>"); // the alert appeared
    expect(streamed).toContain("the full assistant answer");     // the real message was NOT dropped
  });
});
