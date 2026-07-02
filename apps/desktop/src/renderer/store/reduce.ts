import type { CoreEvent, WorkerEventData, InteractionQuestion } from "@daemon/core/events.js";
import type { WorkerRow } from "@daemon/protocol/messages.js";
import { contextPct } from "../format.js";

export type LogItem =
  | { kind: "message"; role: string; content: string; streaming?: boolean; ts?: number } // ts: arrival epoch ms (for hover relative time)
  | { kind: "thinking"; text: string; streaming?: boolean } // thinking summary (collapsible, display:summarized)
  | { kind: "tool"; toolId: string; name: string; status: "in_progress" | "complete"; ok?: boolean; input?: string; result?: string; elapsedSec?: number }
  | { kind: "worker"; workerId: string; status: string }
  | { kind: "notice"; text: string; code?: string; params?: Record<string, string | number> } // informational system push (compaction/retry/fallback)
  // Master canUseTool (approve/AskUserQuestion) inline card. When resolved, shows a one-line summary instead of buttons.
  | { kind: "interaction"; requestId: string; mode: "approve" | "ask"; toolName?: string; inputText?: string; questions?: InteractionQuestion[]; resolved?: boolean; summary?: string }
  | { kind: "metrics"; contextPct: number; tokens: number; turns: number; durationMs: number; cost: number };

// The worker row's single source of truth is the protocol WorkerRow. archived always arrives on fleet.list but is omitted when building worker.* events, so it's optional.
// permissionMode is required here (the worker composer's selector reads it) — defaulted to "bypassPermissions" wherever the source (event/list) doesn't carry it.
export interface FleetRow extends WorkerRow { archived?: boolean; permissionMode: string }

export interface AppState {
  logsBySession: Record<string, LogItem[]>;
  workerLogs: Record<string, LogItem[]>;
  fleet: Record<string, FleetRow>;
  // Native nested subagent activity (live-only, not persisted): workerId → parentToolUseId (= Task call id) → logs.
  nested: Record<string, Record<string, LogItem[]>>;
  // User messages not yet acknowledged (echoed) by the daemon — removed when reconciled via master.message by clientMsgId.
  // Always empty (dormant) until the App send path in Task 2 calls pushPending.
  pendingBySession: Record<string, { clientMsgId: string; text: string }[]>;
  // "Pending" messages sent while the worker is busy (not yet committed at the boundary) — keyed by workerId. Reconciled via the clientMsgId of the worker.event echo.
  pendingByWorker: Record<string, { clientMsgId: string; text: string }[]>;
}

export function emptyState(): AppState {
  return { logsBySession: {}, workerLogs: {}, fleet: {}, nested: {}, pendingBySession: {}, pendingByWorker: {} };
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
export function seedSessionLog(prev: LogItem[] | undefined, sid: string, events: Array<{ payload: unknown; createdAt?: string }>): LogItem[] {
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
      return [...log, { kind: "metrics", contextPct: contextPct(d.contextTokens ?? 0, d.contextWindow ?? 0), tokens: d.contextTokens ?? 0, turns: d.numTurns ?? 0, durationMs: d.durationMs ?? 0, cost: d.costUsd ?? 0 }];
    case "error":
      return [...log, { kind: "message", role: "assistant", content: `⚠ ${d.message}` }];
    case "notice":
      return [...finalizeStreamingMsg(log), { kind: "notice", text: d.text }];
    default:
      return log; // system is not shown in the conversation
  }
}

// now (epoch ms): the arrival time to stamp on a message LogItem. Live: applyEvent injects Date.now(); history injects created_at.
// Optional — if omitted, no ts timestamp (pure reduce tests / existing call sites unaffected).
export function reduceEvent(state: AppState, e: CoreEvent, now?: number): AppState {
  switch (e.type) {
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
      const row: FleetRow = { id: e.workerId, label: e.label, repoPath: e.repoPath, status, branch: e.branch ?? null, model: null, permissionMode: "bypassPermissions", ticketKey: e.ticketKey ?? null, ticketUrl: e.ticketUrl ?? null };
      return { ...state, fleet: { ...state.fleet, [e.workerId]: row }, logsBySession: { ...state.logsBySession, [e.sessionId]: appendLog(state, e.sessionId, { kind: "worker", workerId: e.workerId, status }) } };
    }
    case "worker.status": {
      const prev = state.fleet[e.workerId] ?? { id: e.workerId, label: e.workerId, repoPath: "", status: e.status, branch: null, model: null, permissionMode: "bypassPermissions", ticketKey: null, ticketUrl: null };
      // Once it leaves running (stopped/error/done), any remaining "pending" bubbles get no boundary echo, so clean them up — prevents ghost bubbles.
      const pendingByWorker = e.status !== "running" && state.pendingByWorker[e.workerId]?.length
        ? { ...state.pendingByWorker, [e.workerId]: [] }
        : state.pendingByWorker;
      return { ...state, pendingByWorker, fleet: { ...state.fleet, [e.workerId]: { ...prev, status: e.status } }, logsBySession: { ...state.logsBySession, [e.sessionId]: appendLog(state, e.sessionId, { kind: "worker", workerId: e.workerId, status: e.status }) } };
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
      return { ...state, pendingByWorker, workerLogs: { ...state.workerLogs, [e.workerId]: applySubEvent(state.workerLogs[e.workerId] ?? [], d, now) } };
    }
    case "worker.nested": {
      const cur = state.nested[e.workerId] ?? {};
      const panel = applySubEvent(cur[e.parentToolUseId] ?? [], e.data, now);
      return { ...state, nested: { ...state.nested, [e.workerId]: { ...cur, [e.parentToolUseId]: panel } } };
    }
    case "error":
      // Surface the session error in the conversation (previously not shown) + clear the typing indicator.
      return { ...state, logsBySession: { ...state.logsBySession, [e.sessionId]: appendLog(state, e.sessionId, { kind: "message", role: "assistant", content: `⚠ ${e.message}` }) } };
    default:
      return state;
  }
}
