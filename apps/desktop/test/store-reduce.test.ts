import { describe, it, expect } from "vitest";
import { reduceEvent, emptyState, seedSessionLog, applySubEvent, seedWorkflowRuns } from "../src/renderer/store/reduce.js";
import type { LogItem } from "../src/renderer/store/reduce.js";
import { useStore } from "../src/renderer/store/store.js";
import { fmtTokens, fmtDuration, contextPct } from "../src/renderer/format.js";

describe("capability generation", () => {
  it("takes the daemon generation from capabilities.changed in the pure reducer and store", () => {
    const event = { type: "capabilities.changed" as const, sessionId: "@all", generation: 7, affected: [{ scopeKind: "rookery" as const, scopeRef: "" }] };
    expect(reduceEvent(emptyState(), event).capabilityGeneration).toBe(7);
    useStore.setState({ capabilityGeneration: 0 });
    useStore.getState().applyEvent(event);
    expect(useStore.getState().capabilityGeneration).toBe(7);
  });

  it("monotonically invalidates the active Effective view on capabilities.runtime", () => {
    const state = { ...emptyState(), capabilityGeneration: 7 };
    const event = {
      type: "capabilities.runtime" as const,
      sessionId: "s1",
      targetKind: "master" as const,
      targetId: "s1",
      desiredRevision: "revision-a",
      appliedRevision: "revision-a",
      state: "current" as const,
    };
    expect(reduceEvent(state, event).capabilityGeneration).toBe(8);
  });
});

describe("Dynamic Workflow reducer convergence", () => {
  const runningRun = {
    taskId: "task-1",
    toolUseId: "tool-1",
    runId: "run-1",
    workflowName: "logic-audit",
    summary: "Audit logic",
    status: "running" as const,
    visibility: "live" as const,
    startedAt: 100,
    lastActivityAt: 200,
    counts: { started: 12, active: 6, completed: 6, stopped: 0 },
    agents: [],
  };
  const toolUse = { type: "worker.event" as const, sessionId: "s1", workerId: "w1", seq: 1, data: { kind: "tool_use" as const, id: "tool-1", name: "Workflow", input: "{}" } };
  const toolResult = { type: "worker.event" as const, sessionId: "s1", workerId: "w1", seq: 2, data: { kind: "tool_result" as const, id: "tool-1", content: "Workflow launched", isError: false } };
  const runEvent = { type: "worker.workflow.run" as const, sessionId: "s1", workerId: "w1", run: runningRun };

  it.each(["tool-first", "workflow-first"] as const)("converges the Workflow card when %s", (order) => {
    let state = emptyState();
    const events = order === "tool-first" ? [toolUse, toolResult, runEvent] : [runEvent, toolUse, toolResult];
    for (const event of events) state = reduceEvent(state, event);
    expect(state.workerLogs.w1?.find((item) => item.kind === "tool" && item.toolId === "tool-1")).toMatchObject({
      status: "background",
      workflow: { taskId: "task-1", counts: { started: 12, active: 6, completed: 6, stopped: 0 } },
    });
  });

  it("settles a failed workflow card with the terminal tone", () => {
    let state = reduceEvent(reduceEvent(reduceEvent(emptyState(), toolUse), toolResult), runEvent);
    state = reduceEvent(state, { ...runEvent, run: { ...runningRun, status: "failed", lastActivityAt: 300, endedAt: 300 } });
    expect(state.workerLogs.w1?.find((item) => item.kind === "tool")).toMatchObject({ status: "complete", ok: false, workflow: { status: "failed" } });
  });

  it("decorates persisted history when the reconnect snapshot arrives later", () => {
    let state = reduceEvent(reduceEvent(emptyState(), toolUse), toolResult);
    state = seedWorkflowRuns(state, "w1", [runningRun]);
    expect(state.workerLogs.w1?.find((item) => item.kind === "tool")).toMatchObject({ status: "background", workflow: { taskId: "task-1" } });
  });

  it("ignores a stale agent-history response after another agent is selected", () => {
    useStore.setState({ workflowAgentLogs: {}, workflowAgentHistoryLoading: {}, workflowAgentHistoryFailed: {} });
    const first = "w1/task-1/a1";
    const second = "w1/task-1/a2";
    useStore.getState().beginWorkflowAgentHistory(first);
    useStore.getState().beginWorkflowAgentHistory(second);

    useStore.getState().seedWorkflowAgentHistory(first, [{ data: { kind: "message", role: "assistant", content: "stale" } }]);
    useStore.getState().failWorkflowAgentHistory(first);
    expect(useStore.getState().workflowAgentLogs[first]).toBeUndefined();
    expect(useStore.getState().workflowAgentHistoryFailed[first]).toBeUndefined();

    useStore.getState().seedWorkflowAgentHistory(second, [{ data: { kind: "message", role: "assistant", content: "current" } }]);
    expect(useStore.getState().workflowAgentLogs[second]).toEqual([{ kind: "message", role: "assistant", content: "current" }]);
  });
});

describe("pendingBySession reconcile", () => {
  it("master.message user with clientMsgId appends committed AND removes matching pending", () => {
    let s = emptyState();
    s = { ...s, pendingBySession: { s1: [{ clientMsgId: "c1", text: "q" }, { clientMsgId: "c2", text: "r" }] } };
    const next = reduceEvent(s, { type: "master.message", sessionId: "s1", role: "user", content: "q", clientMsgId: "c1" });
    expect(next.logsBySession.s1).toEqual([{ kind: "message", role: "user", content: "q" }]);
    expect(next.pendingBySession.s1).toEqual([{ clientMsgId: "c2", text: "r" }]); // only c1 removed
  });

  it("master.message user WITHOUT clientMsgId leaves pending untouched", () => {
    let s = { ...emptyState(), pendingBySession: { s1: [{ clientMsgId: "c1", text: "q" }] } };
    const next = reduceEvent(s, { type: "master.message", sessionId: "s1", role: "user", content: "x" });
    expect(next.pendingBySession.s1).toEqual([{ clientMsgId: "c1", text: "q" }]);
  });

  it("clientMsgId echo appends committed even if content duplicates the last log (A3: no content-swallow)", () => {
    // Authoritative model: optimistic bubbles live only in pending, not in logs. Sending the same content twice should commit both.
    let s = emptyState();
    s = reduceEvent(s, { type: "master.message", sessionId: "s1", role: "user", content: "ok", clientMsgId: "c1" });
    s = reduceEvent(s, { type: "master.message", sessionId: "s1", role: "user", content: "ok", clientMsgId: "c2" });
    expect(s.logsBySession.s1.filter((i) => i.kind === "message" && i.role === "user")).toHaveLength(2); // the second "ok" survives too
  });

  it("isEchoUser content-match still dedups echoes WITHOUT clientMsgId (legacy fallback)", () => {
    let s = { ...emptyState(), logsBySession: { s1: [{ kind: "message" as const, role: "user", content: "q" }] } };
    const next = reduceEvent(s, { type: "master.message", sessionId: "s1", role: "user", content: "q" }); // no clientMsgId
    expect(next.logsBySession.s1).toHaveLength(1); // fallback dedup preserved
  });
});

describe("server-authoritative state reconcile (A4/A6)", () => {
  it("setSessions prunes the running map for sessions no longer present", () => {
    useStore.setState({ running: { sGone: true, sKeep: true } });
    useStore.getState().setSessions([{ id: "sKeep", cwd: "/x", status: "active", lastActivity: "", origin: "ui" }]);
    expect(useStore.getState().running.sKeep).toBe(true);
    expect(useStore.getState().running.sGone).toBeUndefined();
  });

  it("seedRunningFromSessions is authoritative — clears a stale true when server reports non-running", () => {
    useStore.setState({ running: { s1: true } });
    useStore.getState().seedRunningFromSessions([{ id: "s1", status: "idle" }]);
    expect(useStore.getState().running.s1).toBe(false);
  });

  it("setFleet clears pendingByWorker for present-but-settled workers (reconnect ghost bubble)", () => {
    useStore.setState({ pendingByWorker: { wRun: [{ clientMsgId: "c1", text: "a" }], wIdle: [{ clientMsgId: "c2", text: "b" }] } });
    useStore.getState().setFleet([
      { id: "wRun", label: "", repoPath: "/r", status: "running", branch: null, model: null },
      { id: "wIdle", label: "", repoPath: "/r", status: "idle", branch: null, model: null },
    ]);
    expect(useStore.getState().pendingByWorker.wRun).toEqual([{ clientMsgId: "c1", text: "a" }]);
    expect(useStore.getState().pendingByWorker.wIdle ?? []).toEqual([]);
  });
});

describe("worker pending reconcile (mid-turn message ordering)", () => {
  it("commits at boundary + removes matching pending on user echo with clientMsgId", () => {
    let s = emptyState();
    s = { ...s, pendingByWorker: { w1: [{ clientMsgId: "c1", text: "msg1" }, { clientMsgId: "c2", text: "msg2" }] } };
    const next = reduceEvent(s, { type: "worker.event", sessionId: "s1", workerId: "w1", seq: 5, data: { kind: "message", role: "user", content: "msg1" }, clientMsgId: "c1" });
    expect(next.pendingByWorker.w1).toEqual([{ clientMsgId: "c2", text: "msg2" }]); // only c1 removed
    expect(next.workerLogs.w1).toEqual([{ kind: "message", role: "user", content: "msg1" }]); // committed at the boundary
  });

  it("leaves pending untouched for non-user worker events (no clientMsgId)", () => {
    const s = { ...emptyState(), pendingByWorker: { w1: [{ clientMsgId: "c1", text: "msg1" }] } };
    const next = reduceEvent(s, { type: "worker.event", sessionId: "s1", workerId: "w1", seq: 1, data: { kind: "message", role: "assistant", content: "hi" } });
    expect(next.pendingByWorker.w1).toEqual([{ clientMsgId: "c1", text: "msg1" }]);
  });

  it("pushWorkerPending adds a queued bubble (store action)", () => {
    useStore.setState({ pendingByWorker: {} });
    useStore.getState().pushWorkerPending("w7", { clientMsgId: "c9", text: "queued" });
    expect(useStore.getState().pendingByWorker.w7).toEqual([{ clientMsgId: "c9", text: "queued" }]);
  });

  it("clears worker pending when the worker settles off running (no lingering queued bubble on stop/error)", () => {
    const s = { ...emptyState(), pendingByWorker: { w1: [{ clientMsgId: "c1", text: "msg" }] } };
    const stopped = reduceEvent(s, { type: "worker.status", sessionId: "s1", workerId: "w1", status: "stopped" });
    expect(stopped.pendingByWorker.w1 ?? []).toEqual([]); // terminal state where no echo will arrive → clean up
    const errored = reduceEvent(s, { type: "worker.status", sessionId: "s1", workerId: "w1", status: "error" });
    expect(errored.pendingByWorker.w1 ?? []).toEqual([]);
  });

  it("keeps worker pending while the worker is still running", () => {
    const s = { ...emptyState(), pendingByWorker: { w1: [{ clientMsgId: "c1", text: "msg" }] } };
    const next = reduceEvent(s, { type: "worker.status", sessionId: "s1", workerId: "w1", status: "running" });
    expect(next.pendingByWorker.w1).toEqual([{ clientMsgId: "c1", text: "msg" }]);
  });

  it("setFleet prunes pendingByWorker for workers no longer in the fleet (discard/delete)", () => {
    useStore.setState({ pendingByWorker: { wKeep: [{ clientMsgId: "c1", text: "a" }], wGone: [{ clientMsgId: "c2", text: "b" }] } });
    useStore.getState().setFleet([{ id: "wKeep", label: "k", repoPath: "/r", status: "running", branch: null, model: null }]);
    expect(useStore.getState().pendingByWorker.wKeep).toEqual([{ clientMsgId: "c1", text: "a" }]);
    expect(useStore.getState().pendingByWorker.wGone).toBeUndefined();
  });

  it("worker.spawned carries its status onto the fleet row (provisioning); omitted ⇒ running (back-compat)", () => {
    const prov = reduceEvent(emptyState(), { type: "worker.spawned", sessionId: "s1", workerId: "w1", repoPath: "/r", label: "app", branch: "rookery/w1", status: "provisioning" });
    expect(prov.fleet.w1.status).toBe("provisioning");
    const legacy = reduceEvent(emptyState(), { type: "worker.spawned", sessionId: "s1", workerId: "w2", repoPath: "/r", label: "app", branch: "rookery/w2" });
    expect(legacy.fleet.w2.status).toBe("running"); // older daemon omits status → defaults to running
  });

  it("worker.status reconciles a provisioning row to running once the agent boots", () => {
    const prov = reduceEvent(emptyState(), { type: "worker.spawned", sessionId: "s1", workerId: "w1", repoPath: "/r", label: "app", status: "provisioning" });
    const running = reduceEvent(prov, { type: "worker.status", sessionId: "s1", workerId: "w1", status: "running" });
    expect(running.fleet.w1.status).toBe("running");
  });

  it("populates FleetRow.permissionMode: worker.spawned defaults bypass; setFleet keeps the carried value or defaults", () => {
    // the worker.spawned event doesn't carry permissionMode → defaults to bypassPermissions
    const s = reduceEvent(emptyState(), { type: "worker.spawned", sessionId: "s1", workerId: "w1", repoPath: "/r", label: "app", status: "provisioning" });
    expect(s.fleet.w1.permissionMode).toBe("bypassPermissions");
    // fleet.list path (setFleet): a row carrying permissionMode is preserved; one without it defaults
    useStore.getState().setFleet([
      { id: "wPlan", label: "", repoPath: "/r", status: "idle", branch: null, model: null, permissionMode: "plan" },
      { id: "wDef", label: "", repoPath: "/r", status: "idle", branch: null, model: null },
    ]);
    const f = useStore.getState().fleet;
    expect(f.wPlan.permissionMode).toBe("plan");
    expect(f.wDef.permissionMode).toBe("bypassPermissions");
  });
});

describe("message ts stamping (hover relative time)", () => {
  it("stamps ts on a finalized assistant message when now is provided", () => {
    const next = reduceEvent(emptyState(), { type: "master.message", sessionId: "s1", role: "assistant", content: "hello" }, 1234);
    expect(next.logsBySession.s1).toEqual([{ kind: "message", role: "assistant", content: "hello", ts: 1234 }]);
  });

  it("stamps ts when a streaming bubble is finalized", () => {
    let s = reduceEvent(emptyState(), { type: "master.message.delta", sessionId: "s1", delta: "par" }, 1000);
    s = reduceEvent(s, { type: "master.message", sessionId: "s1", role: "assistant", content: "partial done" }, 2000);
    expect(s.logsBySession.s1).toEqual([{ kind: "message", role: "assistant", content: "partial done", ts: 2000 }]);
  });

  it("leaves ts undefined when now is omitted (purity preserved for existing callers)", () => {
    const next = reduceEvent(emptyState(), { type: "master.message", sessionId: "s1", role: "assistant", content: "hi" });
    const item = next.logsBySession.s1[0];
    expect(item.kind === "message" && "ts" in item ? item.ts : undefined).toBeUndefined();
  });

  it("seedSessionLog stamps ts from each event's createdAt", () => {
    const iso = "2026-06-20T00:00:00.000Z";
    const log = seedSessionLog(undefined, "s1", [
      { payload: { type: "master.message", sessionId: "s1", role: "assistant", content: "old" }, createdAt: iso },
    ]);
    const item = log[0];
    expect(item.kind === "message" ? item.ts : undefined).toBe(Date.parse(iso));
  });

  it("seedSessionLog routes copied events to sid even when the payload carries a different (original) sessionId — fork case", () => {
    const log = seedSessionLog(undefined, "fork-id", [
      { payload: { type: "master.message", sessionId: "orig-id", role: "assistant", content: "hi from original" } },
    ]);
    expect(log).toHaveLength(1);
    const item = log[0];
    expect(item.kind === "message" ? item.content : undefined).toBe("hi from original");
  });
});

describe("worker message ts stamping (hover relative time)", () => {
  it("applySubEvent stamps ts on a finalized assistant message when now is provided", () => {
    expect(applySubEvent([], { kind: "message", role: "assistant", content: "done" }, 4321)).toEqual([
      { kind: "message", role: "assistant", content: "done", ts: 4321 },
    ]);
  });

  it("applySubEvent stamps ts when a streaming bubble is finalized", () => {
    let log = applySubEvent([], { kind: "message_delta", text: "par" }, 1000);
    log = applySubEvent(log, { kind: "message", role: "assistant", content: "partial done" }, 2000);
    expect(log).toEqual([{ kind: "message", role: "assistant", content: "partial done", ts: 2000 }]);
  });

  it("applySubEvent leaves ts undefined when now omitted", () => {
    const log = applySubEvent([], { kind: "message", role: "assistant", content: "hi" });
    expect(log[0].kind === "message" ? log[0].ts : "x").toBeUndefined();
  });

  it("reduceEvent worker.event stamps ts from now (live)", () => {
    const next = reduceEvent(emptyState(), { type: "worker.event", sessionId: "s1", workerId: "w1", seq: 0, data: { kind: "message", role: "assistant", content: "hi" } }, 5555);
    const item = next.workerLogs.w1[0];
    expect(item.kind === "message" ? item.ts : undefined).toBe(5555);
  });

  it("seedWorkerHistory stamps ts from each event's createdAt", () => {
    const iso = "2026-06-20T00:00:00.000Z";
    useStore.getState().seedWorkerHistory("w9", [
      { seq: 0, type: "message", payload: { kind: "message", role: "assistant", content: "old" }, createdAt: iso },
    ]);
    const item = useStore.getState().workerLogs.w9[0];
    expect(item.kind === "message" ? item.ts : undefined).toBe(Date.parse(iso));
  });
});

describe("seedSessionLog (restore by replaying master events)", () => {
  const SID = "s1";
  // One turn: user → thinking → tool(start+end) → assistant → metrics. (the persisted coalesced events)
  const turn = [
    { payload: { type: "master.message", sessionId: SID, role: "user", content: "hi" } },
    { payload: { type: "master.thinking", sessionId: SID, text: "생각 중" } },
    { payload: { type: "master.tool", sessionId: SID, toolId: "t1", name: "Bash", phase: "start", input: "ls" } },
    { payload: { type: "master.tool", sessionId: SID, toolId: "t1", name: "", phase: "end", ok: true, result: "files" } },
    { payload: { type: "master.message", sessionId: SID, role: "assistant", content: "done" } },
    { payload: { type: "master.result", sessionId: SID, subtype: "success", costUsd: 0.1, numTurns: 1, durationMs: 100, contextTokens: 1000, contextWindow: 200000 } },
  ];

  it("restart (no prev): restores not just text but thinking/tool/metrics too", () => {
    const log = seedSessionLog(undefined, SID, turn);
    expect(log.map((i) => i.kind)).toEqual(["message", "thinking", "tool", "message", "metrics"]);
    const tool = log.find((i) => i.kind === "tool")!;
    expect(tool).toMatchObject({ status: "complete", ok: true, result: "files" }); // not a dangling in_progress
    expect(log.find((i) => i.kind === "thinking")).toMatchObject({ text: "생각 중" });
  });

  it("no persisted events: keeps local (uncommitted)", () => {
    const prev: LogItem[] = [{ kind: "message", role: "user", content: "방금 보냄" }];
    expect(seedSessionLog(prev, SID, [])).toBe(prev);
  });

  it("reconnect: replays committed + preserves prev's uncommitted tail (no duplicate trailing metrics)", () => {
    // prev = committed (identical) + uncommitted live (next user + in-progress tool)
    const committed = seedSessionLog(undefined, SID, turn); // 5 items
    const prev: LogItem[] = [...committed, { kind: "message", role: "user", content: "다음" }, { kind: "tool", toolId: "t2", name: "Edit", status: "in_progress" }];
    const merged = seedSessionLog(prev, SID, turn);
    // committed 5 + tail 2 = 7 (metrics only once!)
    expect(merged.map((i) => i.kind)).toEqual(["message", "thinking", "tool", "message", "metrics", "message", "tool"]);
    expect(merged.filter((i) => i.kind === "metrics")).toHaveLength(1);
    expect(merged[6]).toMatchObject({ kind: "tool", status: "complete" }); // dangling in_progress → healed
  });

  it("full reload: an unresolved interaction card replayed before the history seed survives the seed", () => {
    // Reconnect flow: events.subscribe replays the pending card into an EMPTY log, THEN session.history seeds.
    const withCard = reduceEvent(emptyState(), { type: "interaction.request", sessionId: SID, requestId: "R9", kind: "approve", toolName: "t", inputText: "{}" } as never);
    const prev = withCard.logsBySession[SID]; // [interaction] — zero message items, so the anchor can never match
    const turn = [
      { payload: { type: "master.message", sessionId: SID, role: "user", content: "hi" } },
      { payload: { type: "master.message", sessionId: SID, role: "assistant", content: "hello" } },
    ];
    const log = seedSessionLog(prev, SID, turn);
    expect(log.filter((i) => i.kind === "message")).toHaveLength(2);
    expect(log.at(-1)).toMatchObject({ kind: "interaction", requestId: "R9", resolved: false });
  });

  it("seed does not duplicate a card that already survived in the preserved tail", () => {
    // prev = committed message + the card (normal reconnect where the anchor DOES match).
    let st = reduceEvent(emptyState(), { type: "master.message", sessionId: SID, role: "user", content: "hi" } as never);
    st = reduceEvent(st, { type: "interaction.request", sessionId: SID, requestId: "R9", kind: "approve", toolName: "t", inputText: "{}" } as never);
    const prev = st.logsBySession[SID];
    const turn = [{ payload: { type: "master.message", sessionId: SID, role: "user", content: "hi" } }];
    const log = seedSessionLog(prev, SID, turn);
    expect(log.filter((i) => i.kind === "interaction")).toHaveLength(1);
  });

  it("resolved interaction summaries are NOT resurrected by the seed", () => {
    let st = reduceEvent(emptyState(), { type: "interaction.request", sessionId: SID, requestId: "R9", kind: "approve", toolName: "t", inputText: "{}" } as never);
    st = reduceEvent(st, { type: "interaction.resolved", sessionId: SID, requestId: "R9", summary: "done" } as never);
    const prev = st.logsBySession[SID]; // [resolved interaction]
    const turn = [
      { payload: { type: "master.message", sessionId: SID, role: "user", content: "hi" } },
      { payload: { type: "master.message", sessionId: SID, role: "assistant", content: "hello" } },
    ];
    const log = seedSessionLog(prev, SID, turn);
    expect(log.filter((i) => i.kind === "interaction")).toHaveLength(0);
  });

  it("a preserved unresolved card NOT re-announced by the daemon is folded to an expired summary", () => {
    const withCard = reduceEvent(emptyState(), { type: "interaction.request", sessionId: SID, requestId: "R9", kind: "approve", toolName: "t", inputText: "{}" } as never);
    const prev = withCard.logsBySession[SID];
    const turn = [{ payload: { type: "master.message", sessionId: SID, role: "user", content: "hi" } }];
    const log = seedSessionLog(prev, SID, turn, new Set()); // daemon replayed nothing → card is dead
    const card = log.find((i) => i.kind === "interaction");
    expect(card).toMatchObject({ requestId: "R9", resolved: true, expired: true });
  });

  it("a preserved unresolved card the daemon re-announced stays actionable", () => {
    const withCard = reduceEvent(emptyState(), { type: "interaction.request", sessionId: SID, requestId: "R9", kind: "approve", toolName: "t", inputText: "{}" } as never);
    const prev = withCard.logsBySession[SID];
    const turn = [{ payload: { type: "master.message", sessionId: SID, role: "user", content: "hi" } }];
    const log = seedSessionLog(prev, SID, turn, new Set(["R9"]));
    expect(log.at(-1)).toMatchObject({ kind: "interaction", requestId: "R9", resolved: false });
  });

  it("without a liveCards set (legacy callers), unresolved cards are preserved as before", () => {
    const withCard = reduceEvent(emptyState(), { type: "interaction.request", sessionId: SID, requestId: "R9", kind: "approve", toolName: "t", inputText: "{}" } as never);
    const prev = withCard.logsBySession[SID];
    const turn = [{ payload: { type: "master.message", sessionId: SID, role: "user", content: "hi" } }];
    const log = seedSessionLog(prev, SID, turn);
    expect(log.at(-1)).toMatchObject({ kind: "interaction", requestId: "R9", resolved: false });
  });
});

describe("reduceEvent", () => {
  it("appends assistant message to session log", () => {
    let s = emptyState();
    s = reduceEvent(s, { type: "master.message", sessionId: "s1", role: "assistant", content: "hi" });
    expect(s.logsBySession["s1"]).toEqual([{ kind: "message", role: "assistant", content: "hi" }]);
  });

  it("master.notice finalizes a trailing streaming bubble (no caret) and lands after the text — the interrupt badge does not slip into the middle of the text", () => {
    let s = reduceEvent(emptyState(), { type: "master.message.delta", sessionId: "s1", delta: "부분 답변" });
    expect(s.logsBySession["s1"]).toEqual([{ kind: "message", role: "assistant", content: "부분 답변", streaming: true }]);
    s = reduceEvent(s, { type: "master.notice", sessionId: "s1", text: "⏹ 중단됨" });
    expect(s.logsBySession["s1"]).toEqual([
      { kind: "message", role: "assistant", content: "부분 답변", streaming: false }, // finalized (caret removed)
      { kind: "notice", text: "⏹ 중단됨" }, // after the text
    ]);
  });

  it("worker.event(message) appends to that worker's log", () => {
    let s = emptyState();
    s = reduceEvent(s, { type: "worker.event", sessionId: "x", workerId: "a1", seq: 0, data: { kind: "message", role: "assistant", content: "작업 중" } });
    s = reduceEvent(s, { type: "worker.event", sessionId: "x", workerId: "a1", seq: 1, data: { kind: "error", message: "boom" } });
    expect(s.workerLogs["a1"]).toEqual([
      { kind: "message", role: "assistant", content: "작업 중" },
      { kind: "message", role: "assistant", content: "⚠ boom" },
    ]);
  });

  it("skips the echo of an already-shown (optimistic) user message", () => {
    let s = emptyState();
    s = { ...s, workerLogs: { a1: [{ kind: "message", role: "user", content: "go on" }] } };
    s = reduceEvent(s, { type: "worker.event", sessionId: "x", workerId: "a1", seq: 9, data: { kind: "message", role: "user", content: "go on" } });
    expect(s.workerLogs["a1"]).toEqual([{ kind: "message", role: "user", content: "go on" }]);
  });

  it("master.message.delta streams into a bubble; agent.message commits it", () => {
    let s = emptyState();
    s = reduceEvent(s, { type: "master.message.delta", sessionId: "s1", delta: "Hel" });
    s = reduceEvent(s, { type: "master.message.delta", sessionId: "s1", delta: "lo" });
    expect(s.logsBySession["s1"]).toEqual([{ kind: "message", role: "assistant", content: "Hello", streaming: true }]);
    s = reduceEvent(s, { type: "master.message", sessionId: "s1", role: "assistant", content: "Hello!" });
    expect(s.logsBySession["s1"]).toEqual([{ kind: "message", role: "assistant", content: "Hello!" }]);
  });

  it("skips empty worker messages (old/empty events)", () => {
    let s = emptyState();
    s = reduceEvent(s, { type: "worker.event", sessionId: "x", workerId: "a1", seq: 0, data: { kind: "message", role: "assistant", content: "" } });
    s = reduceEvent(s, { type: "worker.event", sessionId: "x", workerId: "a1", seq: 1, data: { kind: "message", role: "user", content: "  " } });
    expect(s.workerLogs["a1"] ?? []).toEqual([]);
  });

  it("worker message_delta streams into a bubble; message commits it", () => {
    let s = emptyState();
    const ev = (data: any) => ({ type: "worker.event" as const, sessionId: "x", workerId: "a1", seq: 0, data });
    s = reduceEvent(s, ev({ kind: "message_delta", text: "Hel" }));
    s = reduceEvent(s, ev({ kind: "message_delta", text: "lo" }));
    expect(s.workerLogs["a1"]).toEqual([{ kind: "message", role: "assistant", content: "Hello", streaming: true }]);
    s = reduceEvent(s, ev({ kind: "message", role: "assistant", content: "Hello!" }));
    expect(s.workerLogs["a1"]).toEqual([{ kind: "message", role: "assistant", content: "Hello!" }]);
  });

  it("worker tool_use → in-progress card, tool_result → completes it with result", () => {
    let s = emptyState();
    s = reduceEvent(s, { type: "worker.event", sessionId: "x", workerId: "a1", seq: 0, data: { kind: "tool_use", id: "t1", name: "Read", input: "{}" } });
    expect(s.workerLogs["a1"]).toEqual([{ kind: "tool", toolId: "t1", name: "Read", status: "in_progress", input: "{}" }]);
    s = reduceEvent(s, { type: "worker.event", sessionId: "x", workerId: "a1", seq: 1, data: { kind: "tool_result", id: "t1", isError: false, content: "ok" } });
    expect(s.workerLogs["a1"][0]).toMatchObject({ kind: "tool", toolId: "t1", status: "complete", ok: true, result: "ok" });
  });

  it("tool start carries input; end completes with result + ok by toolId", () => {
    let s = emptyState();
    s = reduceEvent(s, { type: "master.tool", sessionId: "s1", toolId: "t1", name: "spawn_worker", phase: "start", input: '{"repo":"app"}' });
    expect(s.logsBySession["s1"].find((i) => i.kind === "tool")).toMatchObject({ toolId: "t1", name: "spawn_worker", status: "in_progress", input: '{"repo":"app"}' });
    s = reduceEvent(s, { type: "master.tool", sessionId: "s1", toolId: "t1", name: "", phase: "end", ok: true, result: "Spawned a0" });
    const tool = s.logsBySession["s1"].find((i) => i.kind === "tool") as any;
    expect(tool).toMatchObject({ toolId: "t1", name: "spawn_worker", status: "complete", ok: true, result: "Spawned a0" });
  });

  it("result force-completes unfinished tools and adds metrics (incl cumulative cost)", () => {
    let s = emptyState();
    s = reduceEvent(s, { type: "master.tool", sessionId: "s1", toolId: "t1", name: "recall", phase: "start" });
    s = reduceEvent(s, { type: "master.result", sessionId: "s1", subtype: "success", costUsd: 1.25, numTurns: 3, durationMs: 12300, contextTokens: 84200, contextWindow: 200000 });
    const items = s.logsBySession["s1"];
    expect((items.find((i) => i.kind === "tool") as any).status).toBe("complete");
    expect(items.find((i) => i.kind === "metrics")).toMatchObject({ contextPct: 42, tokens: 84200, turns: 3, durationMs: 12300, cost: 1.25 });
  });

  it("routes worker.nested into an ephemeral nested map (grouped by parentToolUseId)", () => {
    let s = emptyState();
    s = reduceEvent(s, { type: "worker.nested", sessionId: "x", workerId: "a1", parentToolUseId: "task-1", data: { kind: "message", role: "assistant", content: "doing X" } });
    s = reduceEvent(s, { type: "worker.nested", sessionId: "x", workerId: "a1", parentToolUseId: "task-1", data: { kind: "tool_use", id: "t", name: "Read", input: "{}" } });
    s = reduceEvent(s, { type: "worker.nested", sessionId: "x", workerId: "a1", parentToolUseId: "task-2", data: { kind: "message", role: "assistant", content: "other panel" } });
    expect(s.nested["a1"]["task-1"]).toEqual([
      { kind: "message", role: "assistant", content: "doing X" },
      { kind: "tool", toolId: "t", name: "Read", status: "in_progress", input: "{}" },
    ]);
    expect(s.nested["a1"]["task-2"]).toEqual([{ kind: "message", role: "assistant", content: "other panel" }]);
    expect(s.workerLogs["a1"]).toBeUndefined(); // does not touch the main transcript
  });

  it("worker.label updates an existing fleet row's label (does not resurrect discarded rows)", () => {
    let s = emptyState();
    s = reduceEvent(s, { type: "worker.spawned", sessionId: "s1", workerId: "a1", repoPath: "/r", label: "app" });
    s = reduceEvent(s, { type: "worker.label", sessionId: "s1", workerId: "a1", label: "Add 429 handling" });
    expect(s.fleet["a1"].label).toBe("Add 429 handling");
    // A nonexistent (discarded) row is not resurrected by a label event.
    const s2 = reduceEvent(emptyState(), { type: "worker.label", sessionId: "s1", workerId: "ghost", label: "X" });
    expect(s2.fleet["ghost"]).toBeUndefined();
  });

  it("worker deletion tombstones block status resurrection", () => {
    let state = reduceEvent(emptyState(), {
      type: "worker.spawned", sessionId: "s1", workerId: "w1", repoPath: "/r", label: "one",
    });
    state = reduceEvent(state, {
      type: "worker.deletion", sessionId: "s1", workerId: "w1", phase: "started",
    });
    expect(state.fleet.w1).toBeUndefined();
    expect(state.deletingWorkers.w1).toBe(true);

    state = reduceEvent(state, {
      type: "worker.status", sessionId: "s1", workerId: "w1", status: "stopped",
    });
    expect(state.fleet.w1).toBeUndefined();

    state = reduceEvent(state, {
      type: "worker.deletion", sessionId: "s1", workerId: "w1", phase: "completed",
    });
    expect(state.fleet.w1).toBeUndefined();
    expect(state.deletingWorkers.w1).toBeUndefined();
  });

  it("worker.status never creates membership without worker.spawned or fleet.list", () => {
    const state = reduceEvent(emptyState(), {
      type: "worker.status", sessionId: "s1", workerId: "ghost", status: "stopped",
    });
    expect(state.fleet.ghost).toBeUndefined();
  });

  it("worker events update fleet map", () => {
    let s = emptyState();
    s = reduceEvent(s, { type: "worker.spawned", sessionId: "s1", workerId: "a1", repoPath: "/r", label: "app" });
    s = reduceEvent(s, { type: "worker.status", sessionId: "s1", workerId: "a1", status: "done" });
    expect(s.fleet["a1"]).toMatchObject({ id: "a1", label: "app", status: "done" });
  });
});

describe("store navigation (single location model)", () => {
  it("navigate sets location + pushes history; goBack/goForward round-trip", () => {
    useStore.setState({ overlay: null, showRepos: false, activeSessionId: null, activeWorkerId: null, navBack: [], navFwd: [] });
    const g = () => useStore.getState();
    g().navigate({ overlay: null, showRepos: false, sessionId: "s1" });
    expect([g().activeSessionId, g().showRepos, g().overlay]).toEqual(["s1", false, null]);
    g().navigate({ overlay: null, showRepos: true, subId: "a1" });
    expect([g().activeWorkerId, g().showRepos]).toEqual(["a1", true]);
    expect(g().navBack.length).toBe(2); // empty location → s1
    g().goBack();
    expect([g().activeSessionId, g().showRepos, g().activeWorkerId]).toEqual(["s1", false, null]); // restores the previous one
    expect(g().navFwd.length).toBe(1);
    g().goForward();
    expect([g().activeWorkerId, g().showRepos]).toEqual(["a1", true]); // forward again
  });

  it("navigate clears unread for the explicitly-patched session/worker", () => {
    useStore.setState({ overlay: null, showRepos: false, activeSessionId: null, activeWorkerId: null, navBack: [], navFwd: [], attention: { a1: true }, sessionAttention: { s1: true } });
    useStore.getState().navigate({ subId: "a1" });
    expect(useStore.getState().attention.a1).toBe(false);
    useStore.getState().navigate({ sessionId: "s1" });
    expect(useStore.getState().sessionAttention.s1).toBe(false);
  });

  it("overlay open is a navigable step — goBack closes it back to the session", () => {
    useStore.setState({ overlay: null, showRepos: false, activeSessionId: "s1", activeWorkerId: null, navBack: [], navFwd: [] });
    useStore.getState().navigate({ overlay: "settings" });
    expect(useStore.getState().overlay).toBe("settings");
    useStore.getState().goBack();
    expect([useStore.getState().overlay, useStore.getState().activeSessionId]).toEqual([null, "s1"]); // closes and keeps the session
  });

  it("restoreLocation sets location with empty history (restore entry)", () => {
    useStore.setState({ navBack: [{ overlay: null, showRepos: false, sessionId: "old", subId: null, repoId: null }], navFwd: [] });
    useStore.getState().restoreLocation({ overlay: null, showRepos: true, sessionId: null, subId: "a9", repoId: null });
    expect([useStore.getState().activeWorkerId, useStore.getState().showRepos, useStore.getState().navBack.length]).toEqual(["a9", true, 0]);
  });
});

describe("store.applyEvent", () => {
  it("session.label updates the matching session's label live", () => {
    useStore.setState({ sessions: [{ id: "s1", cwd: "/code/app", status: "active", lastActivity: "", origin: "ui" }] });
    useStore.getState().applyEvent({ type: "session.label", sessionId: "s1", label: "Fix login redirect" });
    expect(useStore.getState().sessions.find((x) => x.id === "s1")?.label).toBe("Fix login redirect");
  });

  // (the busy map is gone — the composer's "in progress" is derived by ConversationPane from running ‖ pending. See conversation-pane.test.)

  it("attention: settles to unread when not viewed; cleared on select + on running", () => {
    useStore.getState().setFleet(["a1", "a2", "a3"].map((id) => ({
      id, label: id, repoPath: "/r", status: "running", branch: null, model: null,
    })));
    useStore.setState({ attention: {}, activeWorkerId: null });
    // an unviewed worker settles to idle → unread
    useStore.getState().applyEvent({ type: "worker.status", sessionId: "x", workerId: "a1", status: "idle" });
    expect(useStore.getState().attention.a1).toBe(true);
    // opening it (select) clears it
    useStore.getState().setActiveSub("a1");
    expect(useStore.getState().attention.a1).toBe(false);
    // the worker being viewed going idle is not unread
    useStore.getState().applyEvent({ type: "worker.status", sessionId: "x", workerId: "a1", status: "idle" });
    expect(useStore.getState().attention.a1).toBe(false);
    // another worker: idle sets, running clears
    useStore.getState().applyEvent({ type: "worker.status", sessionId: "x", workerId: "a2", status: "idle" });
    expect(useStore.getState().attention.a2).toBe(true);
    useStore.getState().applyEvent({ type: "worker.status", sessionId: "x", workerId: "a2", status: "running" });
    expect(useStore.getState().attention.a2).toBe(false);
    // a vanished worker is cleaned up by setFleet
    useStore.getState().applyEvent({ type: "worker.status", sessionId: "x", workerId: "a3", status: "idle" });
    expect(useStore.getState().attention.a3).toBe(true);
    useStore.getState().setFleet([]);
    expect(useStore.getState().attention.a3).toBeUndefined();
  });

  // The worker state graph retired `done` from live writes: a natural stream end now lands on `stopped`.
  // Marking only idle/done/error/failed therefore left a finished worker with no unread dot at all.
  it("attention: marks unread when a worker ends naturally (stopped), but not while it is in background", () => {
    useStore.getState().setFleet(["b1", "b2"].map((id) => ({
      id, label: id, repoPath: "/r", status: "running", branch: null, model: null,
    })));
    useStore.setState({ attention: {}, activeWorkerId: null });
    useStore.getState().applyEvent({ type: "worker.status", sessionId: "x", workerId: "b1", status: "stopped" });
    expect(useStore.getState().attention.b1).toBe(true);
    // background = the turn ended but the work has not — there is nothing to review yet.
    useStore.getState().applyEvent({ type: "worker.status", sessionId: "x", workerId: "b2", status: "background" });
    expect(useStore.getState().attention.b2).toBeFalsy();
  });

  it("running: agent.status running/idle drives the per-session running map", () => {
    useStore.setState({ running: {} });
    useStore.getState().applyEvent({ type: "master.status", sessionId: "s1", status: "running" });
    expect(useStore.getState().running.s1).toBe(true);
    useStore.getState().applyEvent({ type: "master.status", sessionId: "s1", status: "idle" });
    expect(useStore.getState().running.s1).toBe(false);
  });

  it("sessionAttention: master idle while not viewed → unread; cleared on select/running; pruned on setSessions", () => {
    useStore.setState({ sessionAttention: {}, activeSessionId: null });
    // an unviewed session ends idle → unread
    useStore.getState().applyEvent({ type: "master.status", sessionId: "s1", status: "idle" });
    expect(useStore.getState().sessionAttention.s1).toBe(true);
    // opening it (select) clears it
    useStore.getState().setActive("s1");
    expect(useStore.getState().sessionAttention.s1).toBe(false);
    // the session being viewed going idle is not unread
    useStore.getState().applyEvent({ type: "master.status", sessionId: "s1", status: "idle" });
    expect(useStore.getState().sessionAttention.s1).toBe(false);
    // another session: idle sets, running clears
    useStore.getState().applyEvent({ type: "master.status", sessionId: "s2", status: "idle" });
    expect(useStore.getState().sessionAttention.s2).toBe(true);
    useStore.getState().applyEvent({ type: "master.status", sessionId: "s2", status: "running" });
    expect(useStore.getState().sessionAttention.s2).toBe(false);
    // a vanished session is cleaned up by setSessions
    useStore.getState().applyEvent({ type: "master.status", sessionId: "s3", status: "idle" });
    expect(useStore.getState().sessionAttention.s3).toBe(true);
    useStore.getState().setSessions([]);
    expect(useStore.getState().sessionAttention.s3).toBeUndefined();
  });

  it("commands.changed never replaces structured actions with raw provider strings", () => {
    const existing = [{ id: "review", name: "review", description: "d", action: { type: "insert-prompt" as const, text: "/review" } }];
    useStore.setState({ activeWorkerId: "a1", activeSessionId: null, commands: existing });
    useStore.getState().applyEvent({ type: "commands.changed", sessionId: "x", scopeId: "a1", commands: [{ name: "new", description: "d" }] });
    expect(useStore.getState().commands).toEqual(existing);
    useStore.getState().applyEvent({ type: "commands.changed", sessionId: "x", scopeId: "other", commands: [{ name: "z", description: "" }] });
    expect(useStore.getState().commands).toEqual(existing);
  });
});

describe("system push notices", () => {
  it("worker notice → notice item; agent.notice → session notice item", () => {
    let s = reduceEvent(emptyState(), { type: "worker.event", sessionId: "x", workerId: "a1", seq: 0, data: { kind: "notice", text: "🗜 압축됨" } });
    expect(s.workerLogs["a1"]).toEqual([{ kind: "notice", text: "🗜 압축됨" }]);
    s = reduceEvent(emptyState(), { type: "master.notice", sessionId: "s1", text: "⏳ 재시도" });
    expect(s.logsBySession["s1"]).toEqual([{ kind: "notice", text: "⏳ 재시도" }]);
  });

  it("tool_progress updates elapsed on the in-progress tool, never on completed", () => {
    // worker
    let s = reduceEvent(emptyState(), { type: "worker.event", sessionId: "x", workerId: "a1", seq: 0, data: { kind: "tool_use", id: "t1", name: "Bash", input: "{}" } });
    s = reduceEvent(s, { type: "worker.event", sessionId: "x", workerId: "a1", seq: 1, data: { kind: "tool_progress", id: "t1", elapsedSec: 12 } });
    expect((s.workerLogs["a1"][0] as { elapsedSec?: number }).elapsedSec).toBe(12);
    // master agent.tool progress
    let m = reduceEvent(emptyState(), { type: "master.tool", sessionId: "s1", toolId: "t1", name: "Bash", phase: "start", input: "{}" });
    m = reduceEvent(m, { type: "master.tool", sessionId: "s1", toolId: "t1", name: "", phase: "progress", elapsedSec: 7 });
    expect((m.logsBySession["s1"][0] as { elapsedSec?: number }).elapsedSec).toBe(7);
    m = reduceEvent(m, { type: "master.tool", sessionId: "s1", toolId: "t1", name: "", phase: "end", ok: true, result: "done" });
    m = reduceEvent(m, { type: "master.tool", sessionId: "s1", toolId: "t1", name: "", phase: "progress", elapsedSec: 99 });
    expect((m.logsBySession["s1"][0] as { status: string; elapsedSec?: number }).status).toBe("complete");
    expect((m.logsBySession["s1"][0] as { elapsedSec?: number }).elapsedSec).toBe(7); // progress is not attached to a completed tool
  });
});

describe("thinking", () => {
  it("sub: thinking_delta accumulates, then finalizes when the answer text starts", () => {
    let s = emptyState();
    s = reduceEvent(s, { type: "worker.event", sessionId: "x", workerId: "a1", seq: 0, data: { kind: "thinking_delta", text: "Let me " } });
    s = reduceEvent(s, { type: "worker.event", sessionId: "x", workerId: "a1", seq: 1, data: { kind: "thinking_delta", text: "think." } });
    expect(s.workerLogs["a1"]).toEqual([{ kind: "thinking", text: "Let me think.", streaming: true }]);
    s = reduceEvent(s, { type: "worker.event", sessionId: "x", workerId: "a1", seq: 2, data: { kind: "message_delta", text: "Answer" } });
    expect(s.workerLogs["a1"]).toEqual([
      { kind: "thinking", text: "Let me think.", streaming: false }, // answer starts → finalized (collapsed)
      { kind: "message", role: "assistant", content: "Answer", streaming: true },
    ]);
  });

  it("master: agent.thinking.delta accumulates, agent.message finalizes thinking", () => {
    let s = emptyState();
    s = reduceEvent(s, { type: "master.thinking.delta", sessionId: "s1", delta: "hmm" });
    expect(s.logsBySession["s1"]).toEqual([{ kind: "thinking", text: "hmm", streaming: true }]);
    s = reduceEvent(s, { type: "master.message", sessionId: "s1", role: "assistant", content: "Done" });
    expect(s.logsBySession["s1"]).toEqual([
      { kind: "thinking", text: "hmm", streaming: false },
      { kind: "message", role: "assistant", content: "Done" },
    ]);
  });
});

describe("interaction (approve/AskUserQuestion inline card)", () => {
  const SID = "s9";
  it("interaction.request → adds an interaction item to the conversation (approve)", () => {
    const st = reduceEvent(emptyState(), { type: "interaction.request", sessionId: SID, requestId: "R1", kind: "approve", toolName: "mcp__fleet__spawn_worker", inputText: "{}" } as never);
    const item = (st.logsBySession[SID] ?? []).at(-1)!;
    expect(item).toMatchObject({ kind: "interaction", requestId: "R1", mode: "approve", toolName: "mcp__fleet__spawn_worker", resolved: false });
  });
  it("interaction.request → ask carries questions", () => {
    const questions = [{ question: "Format?", header: "Fmt", options: [{ label: "Summary" }, { label: "Detailed" }] }];
    const st = reduceEvent(emptyState(), { type: "interaction.request", sessionId: SID, requestId: "R2", kind: "ask", questions } as never);
    expect((st.logsBySession[SID] ?? []).at(-1)).toMatchObject({ kind: "interaction", mode: "ask", questions });
  });
  it("interaction.resolved → updates the same requestId card to resolved+summary (no duplicate item)", () => {
    let st = reduceEvent(emptyState(), { type: "interaction.request", sessionId: SID, requestId: "R3", kind: "approve" } as never);
    st = reduceEvent(st, { type: "interaction.resolved", sessionId: SID, requestId: "R3", summary: "✅ 승인됨" } as never);
    const log = st.logsBySession[SID] ?? [];
    expect(log.filter((i) => i.kind === "interaction")).toHaveLength(1); // not a new item
    expect(log.at(-1)).toMatchObject({ kind: "interaction", requestId: "R3", resolved: true, summary: "✅ 승인됨" });
  });
  it("interaction.request is idempotent by requestId (reconnect replay does not duplicate the card)", () => {
    const ev = { type: "interaction.request", sessionId: SID, requestId: "R1", kind: "approve", toolName: "t", inputText: "{}" } as never;
    const st1 = reduceEvent(emptyState(), ev);
    const st2 = reduceEvent(st1, ev); // daemon replays pending cards on every events.subscribe
    expect(st2.logsBySession[SID].filter((i) => i.kind === "interaction")).toHaveLength(1);
  });
});

describe("worker result telemetry → metrics LogItem", () => {
  it("worker result event appends a metrics LogItem (header reads it; no inline bubble)", () => {
    const log = applySubEvent([], { kind: "result", subtype: "success", costUsd: 0.5, numTurns: 3, durationMs: 1200, contextTokens: 50000, contextWindow: 200000 });
    const m = log.find((i) => i.kind === "metrics");
    expect(m).toMatchObject({ kind: "metrics", tokens: 50000, turns: 3, durationMs: 1200, cost: 0.5 });
    expect((m as any).contextPct).toBe(25); // 50000/200000
  });
  it("worker result without telemetry still appends metrics with zeros (no crash)", () => {
    const log = applySubEvent([], { kind: "result", subtype: "success", costUsd: 0, numTurns: 1 });
    expect(log.some((i) => i.kind === "metrics")).toBe(true);
  });
  it("worker result carrying terminalReason passes it through to the metrics LogItem", () => {
    const log = applySubEvent([], { kind: "result", subtype: "error", costUsd: 0.1, numTurns: 1, terminalReason: "api_error" });
    const m = log.find((i) => i.kind === "metrics");
    expect(m).toMatchObject({ kind: "metrics", terminalReason: "api_error" });
  });
  it("worker result without terminalReason omits the field (no undefined leaking in)", () => {
    const log = applySubEvent([], { kind: "result", subtype: "success", costUsd: 0.1, numTurns: 1 });
    const m = log.find((i) => i.kind === "metrics") as any;
    expect(m.terminalReason).toBeUndefined();
    expect("terminalReason" in m).toBe(false);
  });
});

describe("Side conversation reducer", () => {
  it("keeps Side transcript/status independent from its parent master or worker", () => {
    let st = emptyState();
    st = reduceEvent(st, { type: "side.event", sessionId: "home", sideId: "side-1", sourceKind: "worker", sourceId: "w1", data: { kind: "message", role: "user", content: "why?" } });
    st = reduceEvent(st, { type: "side.event", sessionId: "home", sideId: "side-1", sourceKind: "worker", sourceId: "w1", data: { kind: "message_delta", text: "because" } });
    st = reduceEvent(st, { type: "side.status", sessionId: "home", sideId: "side-1", sourceKind: "worker", sourceId: "w1", status: "idle" });

    expect(st.sideConversations["side-1"]).toMatchObject({ sourceKind: "worker", sourceId: "w1", status: "idle" });
    expect(st.sideConversations["side-1"]!.items).toEqual([
      { kind: "message", role: "user", content: "why?" },
      { kind: "message", role: "assistant", content: "because", streaming: false },
    ]);
    expect(st.workerLogs.w1).toBeUndefined();
    expect(st.logsBySession.home).toBeUndefined();
  });

  it("creates a status-only Side entry and removes volatile state when closed", () => {
    let st = reduceEvent(emptyState(), { type: "side.status", sessionId: "s1", sideId: "side-2", sourceKind: "master", sourceId: "s1", status: "running" });
    st = reduceEvent(st, { type: "side.event", sessionId: "s1", sideId: "side-2", sourceKind: "master", sourceId: "s1", data: { kind: "tool_use", id: "t1", name: "Read", input: "{}" } });
    st = reduceEvent(st, { type: "side.status", sessionId: "s1", sideId: "side-2", sourceKind: "master", sourceId: "s1", status: "closed" });
    expect(st.sideConversations["side-2"]).toBeUndefined();
  });
});

describe("format", () => {
  it("formats", () => {
    expect(fmtTokens(84200)).toBe("84.2k");
    expect(fmtDuration(12300)).toBe("12.3s");
    expect(contextPct(84200, 200000)).toBe(42);
    expect(contextPct(1_148_900, 1_000_000)).toBe(100); // over 100% is clamped (defense in depth)
    expect(contextPct(100, 0)).toBe(0); // window 0 → 0
  });
});
