import { describe, it, expect } from "vitest";
import { openDb } from "../../src/persistence/db.js";
import { Repositories } from "../../src/persistence/repositories.js";
import { EventBus } from "../../src/core/events.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { FleetOrchestrator } from "../../src/core/fleet-orchestrator.js";
import type { WorkerLike } from "../../src/core/fleet-orchestrator.js";
import { FakeGitOps } from "../../src/core/git-ops.js";
import { ThreadRegistry } from "../../src/slack/thread-registry.js";
import { handleIncoming, threadKey, parseThreadKey, ensureSlackReporter } from "../../src/slack/handle-incoming.js";
import type { IncomingCtx } from "../../src/slack/handle-incoming.js";
import type { SlackClient, ChatStreamArgs, ChatStreamerLike, AppendPayload } from "../../src/slack/types.js";
import { ClaudeBackend } from "../../src/core/claude-backend.js";
import { fakeQuery } from "../helpers/fake-query.js";

function setup(opts: { allowed?: string; allowAll?: boolean; refuseReply?: boolean; queryFn?: ReturnType<typeof fakeQuery> } = {}) {
  const repos = new Repositories(openDb(":memory:"));
  const bus = new EventBus();
  const factory = (): WorkerLike => ({ start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
  const fleet = new FleetOrchestrator({ repos, bus, git: new FakeGitOps(), factory, worktreesDir: "/wt" });
  const sessions = new SessionManager({
    repos,
    bus,
    backend: new ClaudeBackend(opts.queryFn ?? fakeQuery([
      { type: "assistant", text: "hi from master" },
      { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" },
    ])),
    masterModel: "mm",
    fleet,
  });
  const slackConfig = () => ({
    cwd: "/work",
    allowedUsers: opts.allowed ? opts.allowed.split(",").map((x) => x.trim()).filter(Boolean) : [],
    allowAll: opts.allowAll ?? false,
    refuseReply: opts.refuseReply ?? true,
    refusalMessage: "Sorry, you're not authorized to use this bot.",
    locale: "ko" as const,
  });
  const home = "/home";
  const registry = new ThreadRegistry(bus);
  const appends: string[] = [];
  const statuses: string[] = [];
  const posts: string[] = [];
  const client: SlackClient = {
    chatStream(_a: ChatStreamArgs): ChatStreamerLike {
      return {
        async append(p: AppendPayload) {
          if ("chunks" in p) {
            for (const c of p.chunks) if (c.type === "markdown_text") appends.push(c.text);
          } else {
            appends.push(p.markdown_text);
          }
        },
        async stop() {},
      };
    },
    chat: { async postMessage(a) { posts.push(a.text); } },
  };
  const ctx = (text: string, threadTs: string, userId = "U1"): IncomingCtx => ({
    client,
    channel: "C1",
    threadTs,
    team: "T1",
    userId,
    text,
    setStatus: async (s) => { statuses.push(s); },
  });
  return { sessions, bus, slackConfig, home, registry, client, appends, statuses, posts, ctx, repos };
}

describe("handleIncoming", () => {
  it("computes the slack thread key", () => {
    expect(threadKey("T1", "C1", "100.1")).toBe("slack:T1:C1:100.1");
  });

  it("opens a session by thread key, runs the turn, and streams the reply", async () => {
    const s = setup({ allowAll: true });
    await handleIncoming(s.ctx("hello", "100.1"), { sessions: s.sessions, bus: s.bus, slackConfig: s.slackConfig, home: s.home }, s.registry);
    expect(s.repos.getSessionByExternalKey("slack:T1:C1:100.1")).toBeTruthy();
    expect(s.appends).toContain("hi from master");
    expect(s.statuses[0]).toContain("thinking");
    expect(s.statuses[s.statuses.length - 1]).toBe("");
  });

  it("reuses the same session for the same thread", async () => {
    const s = setup({ allowAll: true });
    const deps = { sessions: s.sessions, bus: s.bus, slackConfig: s.slackConfig, home: s.home };
    await handleIncoming(s.ctx("first", "100.1"), deps, s.registry);
    await handleIncoming(s.ctx("second", "100.1"), deps, s.registry);
    const rows = s.repos.listSessions().filter((r) => r.external_key === "slack:T1:C1:100.1");
    expect(rows).toHaveLength(1);
  });

  it("refuses a user not in the allowlist without creating a session or running a turn", async () => {
    const s = setup({ allowed: "U_ALLOWED" });
    const deps = { sessions: s.sessions, bus: s.bus, slackConfig: s.slackConfig, home: s.home };
    await handleIncoming(s.ctx("hello", "200.1", "U_STRANGER"), deps, s.registry);
    expect(s.posts).toContain("Sorry, you're not authorized to use this bot.");
    expect(s.appends).toEqual([]); // no streamed reply
    expect(s.statuses).toEqual([]); // no thinking status
    expect(s.repos.getSessionByExternalKey("slack:T1:C1:200.1")).toBeUndefined(); // no session created
  });

  it("stays silent on refusal when refuseReply is off (no post, no session)", async () => {
    const s = setup({ allowed: "U_ALLOWED", refuseReply: false });
    const deps = { sessions: s.sessions, bus: s.bus, slackConfig: s.slackConfig, home: s.home };
    await handleIncoming(s.ctx("hello", "210.1", "U_STRANGER"), deps, s.registry);
    expect(s.posts).toEqual([]); // auto-reply off → don't send any message
    expect(s.repos.getSessionByExternalKey("slack:T1:C1:210.1")).toBeUndefined();
  });

  it("refuses everyone when the allowlist is empty and ALLOW_ALL is unset (fail-closed)", async () => {
    const s = setup(); // empty allowlist, no ALLOW_ALL → default is to refuse everyone
    const deps = { sessions: s.sessions, bus: s.bus, slackConfig: s.slackConfig, home: s.home };
    await handleIncoming(s.ctx("hello", "400.1", "U_ANY"), deps, s.registry);
    expect(s.posts).toContain("Sorry, you're not authorized to use this bot.");
    expect(s.appends).toEqual([]);
    expect(s.repos.getSessionByExternalKey("slack:T1:C1:400.1")).toBeUndefined();
  });

  it("allows everyone when ROOKERY_SLACK_ALLOW_ALL=1", async () => {
    const s = setup({ allowAll: true });
    const deps = { sessions: s.sessions, bus: s.bus, slackConfig: s.slackConfig, home: s.home };
    await handleIncoming(s.ctx("hello", "410.1", "U_ANY"), deps, s.registry);
    expect(s.posts).not.toContain("Sorry, you're not authorized to use this bot.");
    expect(s.appends).toContain("hi from master");
  });

  it("does not double-post a failed turn — the reporter surfaces it once (MS-2)", async () => {
    const throwing = (() => { throw new Error("sdk boom"); }) as ReturnType<typeof fakeQuery>;
    const s = setup({ allowAll: true, queryFn: throwing });
    await handleIncoming(s.ctx("boom", "500.1"), { sessions: s.sessions, bus: s.bus, slackConfig: s.slackConfig, home: s.home }, s.registry);
    const session = s.repos.getSessionByExternalKey("slack:T1:C1:500.1")!;
    const reporter = s.registry.ensure(session.id, () => { throw new Error("reporter should already exist"); }); // return the existing reporter
    await reporter.idle(); // reporter tail flush (wait for the error post to complete)
    const warns = s.posts.filter((p) => p.includes("⚠"));
    expect(warns.length).toBe(1); // previously reporter + handle-incoming = 2
  });

  it("does not let a setStatus failure break the turn (slack-setstatus-failure)", async () => {
    const s = setup({ allowAll: true });
    const badCtx = { ...s.ctx("hi", "600.1"), setStatus: async () => { throw new Error("status fail"); } };
    await handleIncoming(badCtx, { sessions: s.sessions, bus: s.bus, slackConfig: s.slackConfig, home: s.home }, s.registry);
    expect(s.appends).toContain("hi from master"); // the turn still runs normally
  });

  it("allows a user in the allowlist", async () => {
    const s = setup({ allowed: "U_OK,U_ALLOWED" });
    const deps = { sessions: s.sessions, bus: s.bus, slackConfig: s.slackConfig, home: s.home };
    await handleIncoming(s.ctx("hello", "300.1", "U_ALLOWED"), deps, s.registry);
    expect(s.posts).not.toContain("Sorry, you're not authorized to use this bot.");
    expect(s.appends).toContain("hi from master");
  });

  // query that captures the prompt actually passed to the turn.
  function capturing(prompts: string[]): ReturnType<typeof fakeQuery> {
    const base = fakeQuery([
      { type: "assistant", text: "ok" },
      { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" },
    ]);
    return ((o: { prompt?: unknown }) => { prompts.push(String(o.prompt ?? "")); return (base as (x: unknown) => unknown)(o); }) as ReturnType<typeof fakeQuery>;
  }

  it("downloads attached files and passes them to the master as @paths (alongside the text)", async () => {
    const prompts: string[] = [];
    const s = setup({ allowAll: true, queryFn: capturing(prompts) });
    const ctx = { ...s.ctx("이 로그 봐줘", "700.1"), files: [{ id: "F1", name: "app.log", urlPrivateDownload: "u" }] };
    await handleIncoming(ctx, { sessions: s.sessions, bus: s.bus, slackConfig: s.slackConfig, home: s.home }, s.registry, async (f) => `/dl/${f.id}/app.log`);
    expect(prompts[0]).toContain("이 로그 봐줘");
    expect(prompts[0]).toContain("@/dl/F1/app.log"); // same @path format as desktop attachments
  });

  it("runs a turn for a file-only message (no text) using just the @path", async () => {
    const prompts: string[] = [];
    const s = setup({ allowAll: true, queryFn: capturing(prompts) });
    const ctx = { ...s.ctx("", "710.1"), files: [{ id: "F2", name: "diagram.png", urlPrivateDownload: "u" }] };
    await handleIncoming(ctx, { sessions: s.sessions, bus: s.bus, slackConfig: s.slackConfig, home: s.home }, s.registry, async (f) => `/dl/${f.id}/diagram.png`);
    expect(prompts[0]).toBe("@/dl/F2/diagram.png");
    expect(s.appends).toContain("ok"); // the turn actually ran
  });

  it("notices instead of running an empty turn when a file-only message can't be downloaded", async () => {
    const prompts: string[] = [];
    const s = setup({ allowAll: true, queryFn: capturing(prompts) });
    const ctx = { ...s.ctx("", "720.1"), files: [{ id: "F3", urlPrivateDownload: "u" }] };
    await handleIncoming(ctx, { sessions: s.sessions, bus: s.bus, slackConfig: s.slackConfig, home: s.home }, s.registry, async () => null); // download failed
    expect(prompts).toEqual([]); // does not run an empty turn
    expect(s.posts.some((p) => p.includes("files:read"))).toBe(true); // explains the reason
  });

  it("warns when an attachment fails to download but still runs on the text (not silently text-only)", async () => {
    const prompts: string[] = [];
    const s = setup({ allowAll: true, queryFn: capturing(prompts) });
    const ctx = { ...s.ctx("이 스크린샷 봐줘", "725.1"), files: [{ id: "F9", urlPrivateDownload: "u" }] };
    await handleIncoming(ctx, { sessions: s.sessions, bus: s.bus, slackConfig: s.slackConfig, home: s.home }, s.registry, async () => null); // download fails, but there's text
    expect(prompts[0]).toContain("이 스크린샷 봐줘"); // the turn still ran on the text
    expect(s.posts.some((p) => p.includes("files:read"))).toBe(true); // but the dropped attachment was surfaced, not swallowed
  });

  it("notices instead of silently dropping an empty message (no text, no files) — UX-8", async () => {
    const prompts: string[] = [];
    const s = setup({ allowAll: true, queryFn: capturing(prompts) });
    await handleIncoming(s.ctx("", "740.1"), { sessions: s.sessions, bus: s.bus, slackConfig: s.slackConfig, home: s.home }, s.registry);
    expect(prompts).toEqual([]); // no empty turn runs
    expect(s.posts.some((p) => p.includes("메시지"))).toBe(true); // the "please include a message" notice
    expect(s.repos.getSessionByExternalKey("slack:T1:C1:740.1")).toBeUndefined(); // no session created either
  });

  it("keeps the thinking status alive during a long turn and stops it on completion (UX-14)", async () => {
    // a gated query that keeps the turn from finishing → check the heartbeat while runTurn is blocked.
    let releaseQuery!: () => void;
    const gate = new Promise<void>((r) => { releaseQuery = r; });
    const gatedQuery = ((_o: unknown) => (async function* () {
      await gate;
      yield { type: "assistant", parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: "done" }] } };
      yield { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-1" };
    })()) as ReturnType<typeof fakeQuery>;
    const s = setup({ allowAll: true, queryFn: gatedQuery });

    let beatFn: (() => void) | undefined;
    let stopped = false;
    const scheduleHeartbeat = (fn: () => void) => { beatFn = fn; return () => { stopped = true; }; };

    const hp = handleIncoming(s.ctx("hi", "750.1"), { sessions: s.sessions, bus: s.bus, slackConfig: s.slackConfig, home: s.home }, s.registry, undefined, scheduleHeartbeat);
    await new Promise((r) => setTimeout(r, 0)); // until runTurn blocks on the gate

    expect(s.statuses.filter((x) => x.includes("thinking")).length).toBe(1); // initial thinking…
    expect(beatFn).toBeTruthy(); // heartbeat scheduled
    beatFn!(); // fire the heartbeat → reset the status (resets Slack's 2-minute timeout)
    expect(s.statuses.filter((x) => x.includes("thinking")).length).toBe(2);

    releaseQuery();
    await hp;
    expect(stopped).toBe(true); // turn done → heartbeat stops
    expect(s.statuses[s.statuses.length - 1]).toBe(""); // final status cleared
  });
});

describe("parseThreadKey (reverse of threadKey — reporter target reconstruction)", () => {
  it("reverses a slack-origin external key into team/channel/threadTs", () => {
    const key = threadKey("T123", "C456", "1699999999.001200");
    expect(parseThreadKey(key)).toEqual({ team: "T123", channel: "C456", threadTs: "1699999999.001200" });
  });
  it("returns null for non-slack or malformed keys", () => {
    expect(parseThreadKey("automation:abc")).toBeNull();
    expect(parseThreadKey("slack:onlypart")).toBeNull();
    expect(parseThreadKey("slack:T:C")).toBeNull(); // no threadTs
  });
});

describe("ensureSlackReporter (pre-run reporter ensure — headless turns reach Slack)", () => {
  function recClient(appends: string[]): SlackClient {
    return {
      chatStream: () => ({
        async append(p: AppendPayload) { if ("markdown_text" in p) appends.push(p.markdown_text); else for (const c of p.chunks) if (c.type === "markdown_text") appends.push(c.text); },
        async stop() {},
      }),
      chat: { async postMessage() {} },
    };
  }

  it("subscribes a working reporter for a slack-origin key → output reaches Slack", async () => {
    const bus = new EventBus();
    const appends: string[] = [];
    const registry = new ThreadRegistry(bus);
    ensureSlackReporter(registry, recClient(appends), "s1", threadKey("T1", "C1", "1.2"), () => "ko");
    bus.emit({ type: "master.message", sessionId: "s1", role: "assistant", content: "scheduled hello" });
    const reporter = registry.ensure("s1", () => { throw new Error("reporter should already exist"); }); // return the existing one
    await reporter.idle();
    expect(appends).toContain("scheduled hello");
  });

  it("is a no-op for non-slack keys (no reporter, no delivery)", async () => {
    const bus = new EventBus();
    const appends: string[] = [];
    const registry = new ThreadRegistry(bus);
    ensureSlackReporter(registry, recClient(appends), "s2", "automation:xyz", () => "ko");
    bus.emit({ type: "master.message", sessionId: "s2", role: "assistant", content: "x" });
    await Promise.resolve();
    expect(appends).toEqual([]);
  });
});
