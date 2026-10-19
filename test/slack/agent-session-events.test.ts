import { describe, it, expect, vi } from "vitest";
import { handleAgentSessionStopped, handleAgentSessionTitleChanged, type AgentSessionEventDeps } from "../../src/slack/agent-session-events.js";

function setup(over: Partial<AgentSessionEventDeps> = {}, cfg: { allowAll?: boolean; allowedUsers?: string[] } = { allowedUsers: ["U1"] }) {
  const calls: string[] = [];
  const posts: string[] = [];
  const statuses: string[] = [];
  const deps: AgentSessionEventDeps = {
    sessions: {
      findIdByKey: vi.fn((k: string) => (k === "slack:T1:C1:1.1" ? "s1" : undefined)),
      stop: vi.fn(async () => { calls.push("stop"); }),
      rename: vi.fn(),
    },
    slackConfig: () => ({ allowAll: cfg.allowAll ?? false, allowedUsers: cfg.allowedUsers ?? [], locale: "en" as const }),
    reporterFor: () => ({ markStreamsStopped: () => { calls.push("markStreamsStopped"); } }),
    cancelInteractions: () => { calls.push("cancelInteractions"); },
    post: async (_c, _t, text) => { posts.push(text); },
    setStatus: async (_t, s) => { statuses.push(s); },
    inflightTurns: () => 0,
    activeWorkers: () => 0,
    ...over,
  };
  return { deps, calls, posts, statuses };
}
const stopEvt = { team: "T1", channel: "C1", threadTs: "1.1", user: "U1" };

describe("handleAgentSessionStopped", () => {
  it("drops dead streams, aborts+cancels queued, cancels interactions, confirms and sets active", async () => {
    const s = setup();
    await handleAgentSessionStopped(stopEvt, s.deps);
    expect(s.calls).toEqual(["markStreamsStopped", "stop", "cancelInteractions"]);
    expect(s.deps.sessions.stop).toHaveBeenCalledWith("s1", { cancelQueued: true });
    expect(s.posts).toEqual(["⏹️ Stopped."]);
    expect(s.statuses).toEqual(["active"]);
  });

  it("mentions running workers when there are any", async () => {
    const s = setup({ activeWorkers: () => 2 });
    await handleAgentSessionStopped(stopEvt, s.deps);
    expect(s.posts[0]).toContain("2 worker(s) keep running");
  });

  it("leaves status to the in-flight handleIncoming finally while turns are still draining", async () => {
    const s = setup({ inflightTurns: () => 1 });
    await handleAgentSessionStopped(stopEvt, s.deps);
    expect(s.statuses).toEqual([]);
  });

  it("ignores users that fail the allowlist gate (no stop, no post)", async () => {
    const s = setup();
    await handleAgentSessionStopped({ ...stopEvt, user: "U9" }, s.deps);
    expect(s.calls).toEqual([]);
    expect(s.posts).toEqual([]);
  });

  it("does nothing for threads without an existing session (never creates one)", async () => {
    const s = setup();
    await handleAgentSessionStopped({ ...stopEvt, threadTs: "9.9" }, s.deps);
    expect(s.calls).toEqual([]);
    expect(s.posts).toEqual([]);
    expect(s.statuses).toEqual([]);
  });

  it("still confirms and sets active when the stop itself throws", async () => {
    const s = setup();
    (s.deps.sessions.stop as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    await handleAgentSessionStopped(stopEvt, s.deps);
    expect(s.posts).toHaveLength(1);
    expect(s.statuses).toEqual(["active"]);
  });
});

describe("handleAgentSessionTitleChanged", () => {
  const evt = { team: "T1", channel: "C1", threadTs: "1.1", user: "U1", title: "  My   thread  " };
  it("renames the existing session with a trimmed, flattened title", () => {
    const s = setup();
    handleAgentSessionTitleChanged(evt, s.deps);
    expect(s.deps.sessions.rename).toHaveBeenCalledWith("s1", "My thread");
  });
  it("ignores empty titles, unknown threads and non-allowlisted users", () => {
    const s = setup();
    handleAgentSessionTitleChanged({ ...evt, title: "   " }, s.deps);
    handleAgentSessionTitleChanged({ ...evt, threadTs: "9.9" }, s.deps);
    handleAgentSessionTitleChanged({ ...evt, user: "U9" }, s.deps);
    expect(s.deps.sessions.rename).not.toHaveBeenCalled();
  });
  it("caps very long titles", () => {
    const s = setup();
    handleAgentSessionTitleChanged({ ...evt, title: "x".repeat(500) }, s.deps);
    expect((s.deps.sessions.rename as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toHaveLength(200);
  });
});
