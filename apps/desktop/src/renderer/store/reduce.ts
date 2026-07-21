import type { CoreEvent, WorkerEventData, InteractionQuestion } from "@daemon/core/events.js";
import type { WorkerRow } from "@daemon/protocol/messages.js";
import type { WorkflowAgentHistoryEntry, WorkflowRunSnapshot, WorkflowRunSummary } from "@daemon/core/workflow-activity.js";
import { contextPct } from "../format.js";

export type LogItem =
  | { kind: "message"; role: string; content: string; streaming?: boolean; ts?: number } // ts: arrival epoch ms (for hover relative time)
  | { kind: "thinking"; text: string; streaming?: boolean } // thinking summary (collapsible, display:summarized)
  | { kind: "tool"; toolId: string; name: string; status: "in_progress" | "background" | "complete"; ok?: boolean; input?: string; result?: string; elapsedSec?: number; workflow?: WorkflowRunSummary }
  | { kind: "worker"; workerId: string; status: string }
  | { kind: "notice"; text: string; code?: string; params?: Record<string, string | number> } // informational system push (compaction/retry/fallback)
  // Master canUseTool (approve/AskUserQuestion) inline card. When resolved, shows a one-line summary instead of buttons.
  | { kind: "interaction"; requestId: string; mode: "approve" | "ask"; toolName?: string; inputText?: string; questions?: InteractionQuestion[]; resolved?: boolean; summary?: string; expired?: boolean }
  | { kind: "metrics"; contextPct: number; tokens: number; turns: number; durationMs: number; cost: number; terminalReason?: string };

// The worker row's single source of truth is the protocol WorkerRow. archived always arrives on fleet.list but is omitted when building worker.* events, so it's optional.
// permissionMode is required here (the worker composer's selector reads it) — defaulted to "bypassPermissions" wherever the source (event/list) doesn't carry it.
export interface FleetRow extends WorkerRow { archived?: boolean; permissionMode: string; bg?: { count: number; types: string[] } }

export interface AppState {
  capabilityGeneration: number;
  logsBySession: Record<string, LogItem[]>;
  workerLogs: Record<string, LogItem[]>;
  fleet: Record<string, FleetRow>;
  // Optimistic/server-confirmed permanent deletions. While present, neither snapshots nor late worker events may
  // restore membership. Volatile by design; reconnect resets it before the authoritative fleet seed.
  deletingWorkers: Record<string, true>;
  // Native nested subagent activity (live-only, not persisted): workerId → parentToolUseId (= Task call id) → logs.
  nested: Record<string, Record<string, LogItem[]>>;
  // Ephemeral read-only Side conversations. Volatile by design: no history request or persistence.
  sideConversations: Record<string, { sourceKind: "master" | "worker"; sourceId: string; status: "opening" | "running" | "idle" | "closed"; items: LogItem[] }>;
  // User messages not yet acknowledged (echoed) by the daemon — removed when reconciled via master.message by clientMsgId.
  // Always empty (dormant) until the App send path in Task 2 calls pushPending.
  pendingBySession: Record<string, { clientMsgId: string; text: string; epoch?: number }[]>;
  // "Pending" messages sent while the worker is busy (not yet committed at the boundary) — keyed by workerId. Reconciled via the clientMsgId of the worker.event echo.
  pendingByWorker: Record<string, { clientMsgId: string; text: string }[]>;
  workflows: Record<string, Record<string, WorkflowRunSnapshot>>;
  workflowAgentLogs: Record<string, LogItem[]>;
  workflowAgentHistoryLoading: Record<string, boolean>;
  workflowAgentHistoryFailed: Record<string, boolean>;
}

export function emptyState(): AppState {
  return { capabilityGeneration: 0, logsBySession: {}, workerLogs: {}, fleet: {}, deletingWorkers: {}, nested: {}, sideConversations: {}, pendingBySession: {}, pendingByWorker: {}, workflows: {}, workflowAgentLogs: {}, workflowAgentHistoryLoading: {}, workflowAgentHistoryFailed: {} };
}

export function workflowAgentKey(workerId: string, taskId: string, agentId: string): string {
  return `${workerId}/${taskId}/${agentId}`;
}

function finalizeSideItems(items: LogItem[]): LogItem[] {
  return items.map((item) => {
    if (item.kind === "message" && item.streaming) return { ...item, streaming: false };
    if (item.kind === "thinking" && item.streaming) return { ...item, streaming: false };
    if (item.kind === "tool" && item.status === "in_progress") return { ...item, status: "complete" as const };
    return item;
  });
}

function appendLog(state: AppState, sid: string, item: LogItem): LogItem[] {
  return [...(state.logsBySession[sid] ?? []), item];
}

// If the daemon re-echoes a user message we already added optimistically, it would duplicate, so we skip the echo of the same user message.
function isEchoUser(log: LogItem[] | undefined, role: string, content: string): boolean {
  if (role !== "user" || !log || log.length === 0) return false;
  const last = log[log.length - 1];
  return last.kind === "message" && last.role === "user" && last.content === content;
}

// On reconnect/session-select, overwriting wholesale with the DB would lose live-only state (streaming bubbles, etc.) (G-DESKTOP-RESEED).
// We replay persisted master events (coalesced CoreEvent) to build the committed transcript, and preserve prev's uncommitted tail.
// We restore not just text but tool/thinking/metrics/notice too (replacing the earlier text-only model). The replay reuses the master's own
// reduceEvent as-is (same logic as live → consistent). Non-persisted worker.* inline markers are not restored.
export function seedSessionLog(prev: LogItem[] | undefined, sid: string, events: Array<{ payload: unknown; createdAt?: string }>, liveCards?: Set<string>): LogItem[] {
  // interaction cards are live-only (never persisted to session_events), so the replay can never contain them.
  // Re-append unresolved cards from prev that the merge lost — but keep ACTIONABLE only the ones the daemon has
  // re-announced since the last (re)connect (liveCards). The daemon replays every pending card synchronously on
  // events.subscribe, and the client subscribes before requesting history on the same socket, so absence from
  // liveCards is authoritative: the request died while we were away (abort / answered elsewhere / daemon restart).
  // Those fold into an expired summary instead of staying actionable-but-dead forever. liveCards undefined =
  // legacy caller → preserve unconditionally (old behavior). The same authority applies to unresolved cards that
  // survived INSIDE the merged tail (preserved via the tail path rather than the re-append path).
  const merged = seedCore(prev, sid, events);
  const reconciled = liveCards
    ? merged.map((i) => (i.kind === "interaction" && !i.resolved && !liveCards.has(i.requestId) ? { ...i, resolved: true as const, expired: true } : i))
    : merged;
  const have = new Set(
    reconciled.filter((i): i is Extract<LogItem, { kind: "interaction" }> => i.kind === "interaction").map((i) => i.requestId),
  );
  const dropped = (prev ?? [])
    .filter((i): i is Extract<LogItem, { kind: "interaction" }> => i.kind === "interaction" && !i.resolved && !have.has(i.requestId))
    .map((i) => (liveCards && !liveCards.has(i.requestId) ? { ...i, resolved: true as const, expired: true } : i));
  return dropped.length ? [...reconciled, ...dropped] : reconciled;
}

function seedCore(prev: LogItem[] | undefined, sid: string, events: Array<{ payload: unknown; createdAt?: string }>): LogItem[] {
  let st = emptyState();
  // Inject the persisted event's created_at as the message ts → restored old messages also carry their actual arrival time.
  // Force each event's sessionId to sid: a forked session's copied events carry the ORIGINAL session's id, which would
  // otherwise route them (via reduceEvent) into the wrong session's log → the fork would render empty. No-op for normal sessions.
  for (const ev of events) st = reduceEvent(st, { ...(ev.payload as CoreEvent), sessionId: sid } as CoreEvent, ev.createdAt ? Date.parse(ev.createdAt) : undefined);
  const committed = st.logsBySession[sid] ?? [];
  if (!prev || prev.length === 0) return committed; // restart, etc. → the replay is everything
  if (events.length === 0) return prev; // nothing persisted → keep local (uncommitted)
  // Anchor by committed's message count → preserve the tail (uncommitted) after that many committed messages in prev.
  const committedMsgs = committed.filter((i) => i.kind === "message").length;
  if (committedMsgs === 0) return committed.length >= prev.length ? committed : prev;
  let seen = 0;
  let cut = -1;
  for (let i = 0; i < prev.length; i++) {
    if (prev[i].kind === "message") { seen++; if (seen === committedMsgs) { cut = i; break; } }
  }
  if (cut === -1) return committed; // prev lacks enough committed messages → the replay is the truth (fallback)
  // If there are items (metrics/notice, etc.) after committed's last message, they're duplicated at the front of prev's tail → skip them.
  let lastMsgIdx = -1;
  for (let i = 0; i < committed.length; i++) if (committed[i].kind === "message") lastMsgIdx = i;
  const trailingCommitted = committed.length - 1 - lastMsgIdx; // number of items after committed's last message
  // Preserve the uncommitted tail (in_progress tool cards severed mid-reconnect are healed to complete — prevents a stuck spinner).
  const tail = prev.slice(cut + 1 + trailingCommitted).map((it) => (it.kind === "tool" && it.status === "in_progress" ? { ...it, status: "complete" as const } : it));
  return [...committed, ...tail];
}

// If the last item is a streaming thinking, finalize it (end streaming). Called when answer text begins → O(1).
function finalizeThinking(log: LogItem[]): LogItem[] {
  const last = log[log.length - 1];
  return last && last.kind === "thinking" && last.streaming ? log.slice(0, -1).concat({ ...last, streaming: false }) : log;
}

// If the last item is a streaming assistant bubble, finalize it (remove the caret). Called right before a notice (interruption, etc.) →
// prevents a leftover blinking caret or a new bubble appearing after the notice.
function finalizeStreamingMsg(log: LogItem[]): LogItem[] {
  const last = log[log.length - 1];
  return last && last.kind === "message" && last.role === "assistant" && last.streaming ? log.slice(0, -1).concat({ ...last, streaming: false }) : log;
}

// Apply a single worker event to the log (shared by live/history). tool_use → in-progress card, tool_result → complete.
// now (epoch ms): the arrival time to stamp on a message LogItem (for hover relative time) — same convention as the master's reduceEvent.
// Live injects Date.now() in the worker.event case; history injects created_at via seedWorkerHistory. If omitted, no timestamp.
export function applySubEvent(log: LogItem[], d: WorkerEventData, now?: number): LogItem[] {
  switch (d.kind) {
    case "thinking_delta": {
      const last = log[log.length - 1];
      if (last && last.kind === "thinking" && last.streaming) {
        return log.slice(0, -1).concat({ ...last, text: last.text + d.text });
      }
      return [...log, { kind: "thinking", text: d.text, streaming: true }];
    }
    case "thinking": {
      // coalesced thinking summary (persisted/restored) — isomorphic to the master's master.thinking. Being persist-only, it doesn't arrive live and
      // only arrives during seedWorkerHistory replay → add a single finalized thinking (deltas aren't persisted, so no streaming thinking on replay).
      return [...log, { kind: "thinking", text: d.text }];
    }
    case "message_delta": {
      const base = finalizeThinking(log); // answer begins → finalize thinking summary (collapsed)
      const last = base[base.length - 1];
      if (last && last.kind === "message" && last.role === "assistant" && last.streaming) {
        return base.slice(0, -1).concat({ ...last, content: last.content + d.text });
      }
      return [...base, { kind: "message", role: "assistant", content: d.text, streaming: true, ts: now }];
    }
    case "message": {
      const base = finalizeThinking(log);
      const last = base[base.length - 1];
      // If there's a streaming assistant bubble, finalize it (replace) with the final content.
      if (d.role === "assistant" && last && last.kind === "message" && last.role === "assistant" && last.streaming) {
        return base.slice(0, -1).concat({ kind: "message", role: "assistant", content: d.content, ts: now });
      }
      // Empty messages (old data / empty SDK turns) are not turned into bubbles.
      return d.content.trim() ? [...base, { kind: "message", role: d.role, content: d.content, ts: now }] : base;
    }
    case "tool_use":
      return [...log, { kind: "tool", toolId: d.id, name: d.name, status: "in_progress", input: d.input }];
    case "tool_result":
      return log.map((i) => (i.kind === "tool" && i.toolId === d.id ? { ...i, status: "complete" as const, ok: !d.isError, result: d.content } : i));
    case "tool_progress":
      // Update only the elapsed seconds on the in-progress tool card (don't touch completed ones).
      return log.map((i) => (i.kind === "tool" && i.toolId === d.id && i.status === "in_progress" ? { ...i, elapsedSec: d.elapsedSec } : i));
    case "result":
      return [...log, { kind: "metrics", contextPct: contextPct(d.contextTokens ?? 0, d.contextWindow ?? 0), tokens: d.contextTokens ?? 0, turns: d.numTurns ?? 0, durationMs: d.durationMs ?? 0, cost: d.costUsd ?? 0, ...(d.terminalReason ? { terminalReason: d.terminalReason } : {}) }];
    case "error":
      return [...log, { kind: "message", role: "assistant", content: `⚠ ${d.message}` }];
    case "notice":
      return [...finalizeStreamingMsg(log), { kind: "notice", text: d.text }];
    default:
      return log; // system is not shown in the conversation
  }
}

export function syncWorkflowTools(log: LogItem[], runs: Record<string, WorkflowRunSnapshot> | undefined): LogItem[] {
  if (!runs) return log;
  const byTool = new Map(Object.values(runs).flatMap((run) => run.toolUseId ? [[run.toolUseId, run] as const] : []));
  return log.map((item) => {
    if (item.kind !== "tool" || item.name !== "Workflow") return item;
    const run = byTool.get(item.toolId);
    if (!run) return item;
    const { agents: _agents, ...summary } = run;
    return {
      ...item,
      workflow: summary,
      status: run.status === "running" ? "background" : "complete",
      ok: run.status === "failed" ? false : item.ok,
    };
  });
}

function snapshotFromSummary(run: WorkflowRunSummary, previous?: WorkflowRunSnapshot): WorkflowRunSnapshot {
  return { ...run, agents: previous?.agents ?? [] };
}

function retainWorkflowKeys<T>(map: Record<string, T>, workerId: string, taskIds: Set<string>): Record<string, T> {
  const workerPrefix = `${workerId}/`;
  return Object.fromEntries(Object.entries(map).filter(([key]) => {
    if (!key.startsWith(workerPrefix)) return true;
    const taskId = key.slice(workerPrefix.length).split("/")[0];
    return Boolean(taskId && taskIds.has(taskId));
  }));
}

export function seedWorkflowRuns(state: AppState, workerId: string, runs: WorkflowRunSnapshot[]): AppState {
  const live = state.workflows[workerId] ?? {};
  const next = Object.fromEntries(runs.map((snapshot) => {
    const current = live[snapshot.taskId];
    return [snapshot.taskId, current && current.lastActivityAt > snapshot.lastActivityAt ? current : snapshot];
  }));
  const taskIds = new Set(Object.keys(next));
  return {
    ...state,
    workflows: { ...state.workflows, [workerId]: next },
    workerLogs: { ...state.workerLogs, [workerId]: syncWorkflowTools(state.workerLogs[workerId] ?? [], next) },
    workflowAgentLogs: retainWorkflowKeys(state.workflowAgentLogs, workerId, taskIds),
    workflowAgentHistoryLoading: retainWorkflowKeys(state.workflowAgentHistoryLoading, workerId, taskIds),
    workflowAgentHistoryFailed: retainWorkflowKeys(state.workflowAgentHistoryFailed, workerId, taskIds),
  };
}

export function workflowHistoryLog(events: WorkflowAgentHistoryEntry[]): LogItem[] {
  return events.reduce<LogItem[]>((log, event) => applySubEvent(log, event.data, event.createdAt ? Date.parse(event.createdAt) : undefined), []);
}

// now (epoch ms): the arrival time to stamp on a message LogItem. Live: applyEvent injects Date.now(); history injects created_at.
// Optional — if omitted, no ts timestamp (pure reduce tests / existing call sites unaffected).
export function reduceEvent(state: AppState, e: CoreEvent, now?: number): AppState {
  switch (e.type) {
    case "capabilities.changed":
      return { ...state, capabilityGeneration: e.generation };
    case "capabilities.runtime":
      // Runtime events have no registry generation. Increment the same invalidation clock so an open
      // Effective tab refetches desired/applied state while preserving stale-response protection.
      return { ...state, capabilityGeneration: state.capabilityGeneration + 1 };
    case "side.event": {
      const prev = state.sideConversations[e.sideId] ?? { sourceKind: e.sourceKind, sourceId: e.sourceId, status: "running" as const, items: [] };
      const next = { ...prev, sourceKind: e.sourceKind, sourceId: e.sourceId, items: applySubEvent(prev.items, e.data, now) };
      return { ...state, sideConversations: { ...state.sideConversations, [e.sideId]: next } };
    }
    case "side.status": {
      if (e.status === "closed") {
        const sideConversations = { ...state.sideConversations };
        delete sideConversations[e.sideId];
        return { ...state, sideConversations };
      }
      const prev = state.sideConversations[e.sideId] ?? { sourceKind: e.sourceKind, sourceId: e.sourceId, status: e.status, items: [] };
      const items = e.status === "idle" ? finalizeSideItems(prev.items) : prev.items;
      return { ...state, sideConversations: { ...state.sideConversations, [e.sideId]: { ...prev, sourceKind: e.sourceKind, sourceId: e.sourceId, status: e.status, items } } };
    }
    case "master.thinking.delta": {
      const log = state.logsBySession[e.sessionId] ?? [];
      const last = log[log.length - 1];
      const next =
        last && last.kind === "thinking" && last.streaming
          ? log.slice(0, -1).concat({ ...last, text: last.text + e.delta })
          : [...log, { kind: "thinking" as const, text: e.delta, streaming: true }];
      return { ...state, logsBySession: { ...state.logsBySession, [e.sessionId]: next } };
    }
    case "master.thinking": {
      // Completed thinking summary (persisted/restored) — unlike delta accumulation, adds a single finalized thinking.
      const log = state.logsBySession[e.sessionId] ?? [];
      return { ...state, logsBySession: { ...state.logsBySession, [e.sessionId]: [...log, { kind: "thinking", text: e.text }] } };
    }
    case "master.message.delta": {
      const log = finalizeThinking(state.logsBySession[e.sessionId] ?? []); // answer begins → finalize thinking summary
      const last = log[log.length - 1];
      if (last && last.kind === "message" && last.role === "assistant" && last.streaming) {
        const next = log.slice(0, -1).concat({ ...last, content: last.content + e.delta });
        return { ...state, logsBySession: { ...state.logsBySession, [e.sessionId]: next } };
      }
      return { ...state, logsBySession: { ...state.logsBySession, [e.sessionId]: [...log, { kind: "message", role: "assistant", content: e.delta, streaming: true, ts: now }] } };
    }
    case "master.message": {
      // User echoes are matched against pending (clientMsgId) and removed (reconcile) — pending is cleaned up even if dedup returns early.
      const pendingBySession = e.role === "user" && e.clientMsgId
        ? { ...state.pendingBySession, [e.sessionId]: (state.pendingBySession[e.sessionId] ?? []).filter((p) => p.clientMsgId !== e.clientMsgId) }
        : state.pendingBySession;
      // If clientMsgId is present, it is the authoritative dedup (pending filter). Content matching (isEchoUser) is a fallback only for echoes without a clientMsgId
      // — so we don't swallow a legitimate message that sent the same content twice (A3).
      if (!e.clientMsgId && isEchoUser(state.logsBySession[e.sessionId], e.role, e.content)) return { ...state, pendingBySession };
      const log = finalizeThinking(state.logsBySession[e.sessionId] ?? []);
      const last = log[log.length - 1];
      // If there's a streaming assistant bubble, finalize it (replace) with the final content; otherwise a new bubble.
      if (e.role === "assistant" && last && last.kind === "message" && last.role === "assistant" && last.streaming) {
        const next = log.slice(0, -1).concat({ kind: "message", role: "assistant", content: e.content, ts: now });
        return { ...state, pendingBySession, logsBySession: { ...state.logsBySession, [e.sessionId]: next } };
      }
      return { ...state, pendingBySession, logsBySession: { ...state.logsBySession, [e.sessionId]: [...log, { kind: "message", role: e.role, content: e.content, ts: now }] } };
    }
    case "master.tool": {
      const log = state.logsBySession[e.sessionId] ?? [];
      if (e.phase === "start") {
        const item: LogItem = { kind: "tool", toolId: e.toolId, name: e.name, status: "in_progress", input: e.input };
        return { ...state, logsBySession: { ...state.logsBySession, [e.sessionId]: [...log, item] } };
      }
      if (e.phase === "progress") {
        const next = log.map((i) => (i.kind === "tool" && i.toolId === e.toolId && i.status === "in_progress" ? { ...i, elapsedSec: e.elapsedSec } : i));
        return { ...state, logsBySession: { ...state.logsBySession, [e.sessionId]: next } };
      }
      const next = log.map((i) => (i.kind === "tool" && i.toolId === e.toolId ? { ...i, status: "complete" as const, ok: e.ok, result: e.result } : i));
      return { ...state, logsBySession: { ...state.logsBySession, [e.sessionId]: next } };
    }
    case "master.result": {
      const log = (state.logsBySession[e.sessionId] ?? []).map((i) => (i.kind === "tool" && i.status === "in_progress" ? { ...i, status: "complete" as const } : i));
      const metrics: LogItem = { kind: "metrics", contextPct: contextPct(e.contextTokens, e.contextWindow), tokens: e.contextTokens, turns: e.numTurns, durationMs: e.durationMs, cost: e.costUsd };
      return { ...state, logsBySession: { ...state.logsBySession, [e.sessionId]: [...log, metrics] } };
    }
    case "master.notice": {
      // The master's informational system push (compaction/retry/fallback/interruption) → finalize the streaming bubble, then a notice.
      const log = finalizeStreamingMsg(state.logsBySession[e.sessionId] ?? []);
      return { ...state, logsBySession: { ...state.logsBySession, [e.sessionId]: [...log, { kind: "notice", text: e.text, code: e.code, params: e.params }] } };
    }
    case "interaction.request": {
      const cur = state.logsBySession[e.sessionId] ?? [];
      // Idempotent by requestId: the daemon replays every pending card on each events.subscribe (i.e. on every
      // WS reconnect), so the same unresolved card can arrive again — re-appending would duplicate it.
      if (cur.some((i) => i.kind === "interaction" && i.requestId === e.requestId)) return state;
      // Master canUseTool → inline approve/question card. Finalize the streaming bubble, then add the card.
      const log = finalizeStreamingMsg(cur);
      const item: LogItem = { kind: "interaction", requestId: e.requestId, mode: e.kind, toolName: e.toolName, inputText: e.inputText, questions: e.questions, resolved: false };
      return { ...state, logsBySession: { ...state.logsBySession, [e.sessionId]: [...log, item] } };
    }
    case "interaction.resolved": {
      // Replace the card with the same requestId with a result summary (remove buttons) — syncs the responding client / other clients / refresh.
      const log = (state.logsBySession[e.sessionId] ?? []).map((i) =>
        i.kind === "interaction" && i.requestId === e.requestId ? { ...i, resolved: true, summary: e.summary } : i,
      );
      return { ...state, logsBySession: { ...state.logsBySession, [e.sessionId]: log } };
    }
    case "worker.spawned": {
      // status defaults to "running" for back-compat (older daemons omit it); a current daemon sends "provisioning" up-front
      // while the worktree is created, then a worker.status reconciles it to running/idle.
      const status = e.status ?? "running";
      // the worker.spawned event doesn't carry permissionMode → default it; a later fleet.list (setFleet) reconciles the real value.
      // provider carried on the event so a codex worker shows its badge live; a later fleet.list (setFleet) reconciles the authoritative value.
      const row: FleetRow = { id: e.workerId, label: e.label, repoPath: e.repoPath, status, branch: e.branch ?? null, model: null, provider: e.provider, permissionMode: "bypassPermissions", ticketKey: e.ticketKey ?? null, ticketUrl: e.ticketUrl ?? null };
      return { ...state, fleet: { ...state.fleet, [e.workerId]: row }, logsBySession: { ...state.logsBySession, [e.sessionId]: appendLog(state, e.sessionId, { kind: "worker", workerId: e.workerId, status }) } };
    }
    case "worker.deletion": {
      const deletingWorkers = { ...state.deletingWorkers };
      const fleet = { ...state.fleet };
      const pendingByWorker = { ...state.pendingByWorker };
      if (e.phase === "started") deletingWorkers[e.workerId] = true;
      else delete deletingWorkers[e.workerId];
      if (e.phase !== "failed") {
        delete fleet[e.workerId];
        delete pendingByWorker[e.workerId];
      }
      if (e.phase === "failed") return { ...state, deletingWorkers, fleet, pendingByWorker };
      const workflows = { ...state.workflows };
      delete workflows[e.workerId];
      const taskIds = new Set<string>();
      return {
        ...state,
        deletingWorkers,
        fleet,
        pendingByWorker,
        workflows,
        workflowAgentLogs: retainWorkflowKeys(state.workflowAgentLogs, e.workerId, taskIds),
        workflowAgentHistoryLoading: retainWorkflowKeys(state.workflowAgentHistoryLoading, e.workerId, taskIds),
        workflowAgentHistoryFailed: retainWorkflowKeys(state.workflowAgentHistoryFailed, e.workerId, taskIds),
      };
    }
    case "worker.status": {
      // Membership belongs to worker.spawned/fleet.list. A late stop/error event from a permanent delete must not
      // invent a fallback row, and an event racing a tombstone must not resurrect one either.
      const prev = state.fleet[e.workerId];
      // Once it can no longer consume a queued message (stopped/error/idle…), any remaining "pending" bubbles get no
      // boundary echo, so clean them up — prevents ghost bubbles. `background` is NOT such a state: the turn ended but
      // the stream is open, the send is accepted and released at the next boundary, so its bubble must survive.
      const consumesQueued = e.status === "running" || e.status === "background";
      const pendingByWorker = !consumesQueued && state.pendingByWorker[e.workerId]?.length
        ? { ...state.pendingByWorker, [e.workerId]: [] }
        : state.pendingByWorker;
      if (!prev || state.deletingWorkers[e.workerId]) {
        return pendingByWorker === state.pendingByWorker ? state : { ...state, pendingByWorker };
      }
      const nextRow = { ...prev, status: e.status, ...(e.bg ? { bg: e.bg } : {}) };
      if (!e.bg) delete nextRow.bg;
      return { ...state, pendingByWorker, fleet: { ...state.fleet, [e.workerId]: nextRow }, logsBySession: { ...state.logsBySession, [e.sessionId]: appendLog(state, e.sessionId, { kind: "worker", workerId: e.workerId, status: e.status }) } };
    }
    case "worker.label": {
      // Auto-generated label update — update only existing rows (don't resurrect discarded rows).
      const prev = state.fleet[e.workerId];
      if (!prev) return state;
      return { ...state, fleet: { ...state.fleet, [e.workerId]: { ...prev, label: e.label } } };
    }
    case "worker.event": {
      const d = e.data;
      // When a user echo arrives with a clientMsgId (= turn-boundary flush), remove the matching pending bubble (transition to committed).
      const pendingByWorker = d.kind === "message" && d.role === "user" && e.clientMsgId
        ? { ...state.pendingByWorker, [e.workerId]: (state.pendingByWorker[e.workerId] ?? []).filter((p) => p.clientMsgId !== e.clientMsgId) }
        : state.pendingByWorker;
      // Same as master.message: clientMsgId is the authoritative dedup. Content matching is a fallback only for echoes without a clientMsgId (A3).
      if (d.kind === "message" && !e.clientMsgId && isEchoUser(state.workerLogs[e.workerId], d.role, d.content)) return { ...state, pendingByWorker };
      const log = applySubEvent(state.workerLogs[e.workerId] ?? [], d, now);
      return { ...state, pendingByWorker, workerLogs: { ...state.workerLogs, [e.workerId]: syncWorkflowTools(log, state.workflows[e.workerId]) } };
    }
    case "worker.nested": {
      const cur = state.nested[e.workerId] ?? {};
      const panel = applySubEvent(cur[e.parentToolUseId] ?? [], e.data, now);
      return { ...state, nested: { ...state.nested, [e.workerId]: { ...cur, [e.parentToolUseId]: panel } } };
    }
    case "worker.workflow.run": {
      const runs = state.workflows[e.workerId] ?? {};
      const previous = runs[e.run.taskId];
      if (previous && previous.lastActivityAt > e.run.lastActivityAt) return state;
      const run = snapshotFromSummary(e.run, previous);
      const nextRuns = { ...runs, [run.taskId]: run };
      return {
        ...state,
        workflows: { ...state.workflows, [e.workerId]: nextRuns },
        workerLogs: { ...state.workerLogs, [e.workerId]: syncWorkflowTools(state.workerLogs[e.workerId] ?? [], nextRuns) },
      };
    }
    case "worker.workflow.agent": {
      const runs = state.workflows[e.workerId] ?? {};
      const run = runs[e.taskId];
      if (!run) return state;
      const agents = run.agents.some((agent) => agent.agentId === e.agent.agentId)
        ? run.agents.map((agent) => agent.agentId === e.agent.agentId && agent.lastActivityAt <= e.agent.lastActivityAt ? e.agent : agent)
        : [...run.agents, e.agent];
      return { ...state, workflows: { ...state.workflows, [e.workerId]: { ...runs, [e.taskId]: { ...run, agents } } } };
    }
    case "error":
      // Surface the session error in the conversation (previously not shown) + clear the typing indicator.
      return { ...state, logsBySession: { ...state.logsBySession, [e.sessionId]: appendLog(state, e.sessionId, { kind: "message", role: "assistant", content: `⚠ ${e.message}` }) } };
    default:
      return state;
  }
}
