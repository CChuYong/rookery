import { describe, expect, it, vi } from "vitest";
import type { AgentBackend, AgentEvent, AgentSessionOptions, AgentStream, MasterTurnOptions } from "../../src/core/agent-backend.js";
import { EventBus } from "../../src/core/events.js";
import { SideConversationManager, type SideSource } from "../../src/core/side-conversation.js";

class ScriptedStream implements AgentStream {
  interrupted = false;
  constructor(private readonly events: AgentEvent[], private readonly gate?: Promise<void>) {}
  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    if (this.gate) await this.gate;
    for (const event of this.events) yield event;
  }
  async interrupt(): Promise<void> { this.interrupted = true; }
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async supportedCommands(): Promise<[]> { return []; }
}

function harness(events: AgentEvent[] = []) {
  const bus = new EventBus();
  const emitted: unknown[] = [];
  bus.subscribe("@all", (event) => emitted.push(event));
  const turns: Array<{ prompt: string; opts: MasterTurnOptions; stream: ScriptedStream }> = [];
  const backend: AgentBackend = {
    openSession(_input: AsyncIterable<string>, _opts: AgentSessionOptions): AgentStream { throw new Error("unused"); },
    startTurn(prompt, opts) {
      const stream = new ScriptedStream(events);
      turns.push({ prompt, opts, stream });
      return stream;
    },
  };
  const source: SideSource = {
    sourceKind: "worker", sourceId: "w1", sessionId: "home", provider: "claude", cwd: "/live/w1",
    sdkSessionId: "sdk-source", model: "claude-opus-4-8", effort: "high",
  };
  const forkSession = vi.fn(async () => ({ sessionId: "sdk-side" }));
  const cleanup = vi.fn();
  const manager = new SideConversationManager({
    bus,
    backends: { claude: backend },
    resolveSource: (kind, id) => kind === source.sourceKind && id === source.sourceId ? source : undefined,
    forkSession,
    cleanup,
  }, () => "side-1");
  return { manager, source, forkSession, cleanup, turns, emitted };
}

describe("SideConversationManager", () => {
  it("forks provider context without creating a worktree and runs read-only in the source cwd", async () => {
    const h = harness([
      { kind: "session_id", sessionId: "sdk-side-next" },
      { kind: "thinking_delta", text: "checking" },
      { kind: "text_delta", text: "answer" },
      { kind: "message", role: "assistant", text: "answer", parentToolUseId: null },
      { kind: "turn_end", subtype: "success", costUsd: 0.01, numTurns: 1, durationMs: 12, contextTokens: 100, contextWindow: 1000 },
    ]);

    const { id } = await h.manager.create({ sourceKind: "worker", sourceId: "w1", model: "override-model", effort: "medium" });
    expect(id).toBe("side-1");
    expect(h.forkSession).toHaveBeenCalledWith(h.source, "side-1");
    expect(h.emitted).toEqual([]); // connection can reply with side.started before any live event

    h.manager.send(id, "why?");
    await h.manager.idle(id);

    expect(h.turns[0]?.prompt).toBe("why?");
    expect(h.turns[0]?.opts).toMatchObject({
      cwd: "/live/w1", model: "override-model", effort: "medium", permissionMode: "plan",
      resume: "sdk-side", readOnly: true,
    });
    expect(h.emitted).toContainEqual(expect.objectContaining({ type: "side.event", sideId: id, sourceKind: "worker", sourceId: "w1", data: { kind: "message", role: "user", content: "why?" } }));
    expect(h.emitted).toContainEqual(expect.objectContaining({ type: "side.event", sideId: id, data: { kind: "message_delta", text: "answer" } }));
    expect(h.emitted).toContainEqual(expect.objectContaining({ type: "side.status", sideId: id, status: "idle" }));

    h.manager.send(id, "and then?");
    await h.manager.idle(id);
    expect(h.turns[1]?.opts.resume).toBe("sdk-side-next");
  });

  it("rejects unknown/unforkable sources", async () => {
    const h = harness();
    await expect(h.manager.create({ sourceKind: "master", sourceId: "missing" })).rejects.toThrow(/unknown source/);
    const manager = new SideConversationManager({
      bus: new EventBus(), backends: {},
      resolveSource: () => ({ ...h.source, sdkSessionId: null }),
      forkSession: h.forkSession,
    });
    await expect(manager.create({ sourceKind: "worker", sourceId: "w1" })).rejects.toThrow(/no provider context/);
  });

  it("rejects overlapping follow-ups and cleans up only the Side conversation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const bus = new EventBus();
    const stream = new ScriptedStream([{ kind: "turn_end", subtype: "stopped", costUsd: 0, numTurns: 1, durationMs: 1, contextTokens: 0, contextWindow: 0 }], gate);
    const backend: AgentBackend = {
      openSession(): AgentStream { throw new Error("unused"); },
      startTurn(): AgentStream { return stream; },
    };
    const cleanup = vi.fn();
    const manager = new SideConversationManager({
      bus, backends: { claude: backend },
      resolveSource: () => ({ sourceKind: "master", sourceId: "s1", sessionId: "s1", provider: "claude", cwd: "/repo", sdkSessionId: "sdk", model: "m", effort: "high" }),
      forkSession: async () => ({ sessionId: "forked" }), cleanup,
    }, () => "side-x");
    const { id } = await manager.create({ sourceKind: "master", sourceId: "s1" });
    manager.send(id, "one");
    expect(() => manager.send(id, "two")).toThrow(/already running/);
    await manager.stop(id);
    expect(stream.interrupted).toBe(true);
    release();
    await manager.idle(id);
    await manager.close(id);
    expect(cleanup).toHaveBeenCalledWith(id, expect.objectContaining({ sourceId: "s1" }));
    expect(() => manager.send(id, "after close")).toThrow(/unknown Side conversation/);
  });
});
