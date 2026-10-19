import { describe, it, expect } from "vitest";
import { SlackAgentStatus, type AgentStatusClient } from "../../src/slack/agent-status.js";

function fake(opts: { apiError?: string; apiResponse?: unknown; legacyFails?: boolean } = {}) {
  const api: Array<{ method: string; args: Record<string, unknown> }> = [];
  const legacy: Array<{ channel_id: string; thread_ts: string; status: string }> = [];
  const client: AgentStatusClient = {
    async apiCall(method, args) {
      api.push({ method, args: args as Record<string, unknown> });
      if (opts.apiError) throw Object.assign(new Error(opts.apiError), { data: { ok: false, error: opts.apiError } });
      return opts.apiResponse ?? { ok: true };
    },
    assistant: {
      threads: {
        async setStatus(a) {
          legacy.push(a);
          if (opts.legacyFails) throw new Error("nope");
          return {};
        },
      },
    },
  };
  return { client, api, legacy };
}
const T = { channel: "C1", threadTs: "1.1" };

describe("SlackAgentStatus", () => {
  it("uses agents.sessions.setStatus with thread_ts, title and initiator", async () => {
    const f = fake();
    const s = new SlackAgentStatus(() => {});
    await s.set(f.client, T, "processing", { title: "bot", initiatorUserId: "U1" });
    expect(f.api).toEqual([{ method: "agents.sessions.setStatus", args: { channel_id: "C1", thread_ts: "1.1", status: "processing", title: "bot", initiator_user_id: "U1" } }]);
    expect(f.legacy).toEqual([]);
    expect(s.heartbeatMs()).toBe(30 * 60_000);
  });

  it("falls back to the legacy status API when the method/feature is unavailable, and remembers it", async () => {
    const f = fake({ apiError: "feature_disabled" });
    const s = new SlackAgentStatus(() => {});
    await s.set(f.client, T, "processing");
    await s.set(f.client, T, "active");
    expect(f.api).toHaveLength(1); // second call skips the new API entirely
    expect(f.legacy.map((l) => l.status)).toEqual(["thinking…", ""]);
    expect(s.heartbeatMs()).toBe(90_000);
  });

  it("does not fall back on transient errors (ratelimited) and never throws", async () => {
    const f = fake({ apiError: "ratelimited" });
    const s = new SlackAgentStatus(() => {});
    await expect(s.set(f.client, T, "processing")).resolves.toBeUndefined();
    expect(f.legacy).toEqual([]);
    expect(s.heartbeatMs()).toBe(30 * 60_000);
  });

  it("skips suspended in legacy mode and swallows legacy failures", async () => {
    const f = fake({ apiError: "unknown_method", legacyFails: true });
    const s = new SlackAgentStatus(() => {});
    await s.set(f.client, T, "processing");
    await s.set(f.client, T, "suspended");
    expect(f.legacy.map((l) => l.status)).toEqual(["thinking…"]);
  });

  it("logs the missing_agent_session_stopped_event_subscription warning once", async () => {
    const f = fake({ apiResponse: { ok: true, response_metadata: { warnings: ["missing_agent_session_stopped_event_subscription"] } } });
    const logs: string[] = [];
    const s = new SlackAgentStatus((m) => logs.push(m));
    await s.set(f.client, T, "processing");
    await s.set(f.client, T, "active");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("agent_session_stopped");
    const f2 = fake({ apiResponse: { ok: true, warning: "foo,missing_agent_session_stopped_event_subscription" } });
    const logs2: string[] = [];
    await new SlackAgentStatus((m) => logs2.push(m)).set(f2.client, T, "processing");
    expect(logs2).toHaveLength(1);
  });

  it("serializes calls per thread so ordering is preserved", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const client = {
      async apiCall(_m: string, a: unknown) {
        const st = (a as { status: string }).status;
        if (st === "processing") await gate;
        order.push(st);
        return { ok: true };
      },
      assistant: { threads: { async setStatus() { return {}; } } },
    } as AgentStatusClient;
    const s = new SlackAgentStatus(() => {});
    const p1 = s.set(client, T, "processing");
    const p2 = s.set(client, T, "active");
    release();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["processing", "active"]);
  });
});
