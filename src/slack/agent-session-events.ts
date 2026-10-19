import type { AgentSessionStatus } from "./agent-status.js";
import type { SessionManager } from "../core/session-manager.js";
import { isPermittedUser, threadKey, type SlackConfig } from "./handle-incoming.js";
import { t, type Locale } from "../core/i18n.js";

// Handlers for Slack agent-session events (agent_session_stopped / agent_session_title_changed). Kept free of bolt types:
// app.ts adapts the raw events and supplies the effects, so these are unit-testable with plain fakes.

export interface AgentSessionEventDeps {
  sessions: Pick<SessionManager, "findIdByKey" | "stop" | "rename">;
  slackConfig: () => Pick<SlackConfig, "allowAll" | "allowedUsers" | "name"> & { locale: Locale };
  reporterFor: (sessionId: string) => { markStreamsStopped(): void } | undefined;
  cancelInteractions: (target: { channel: string; threadTs: string }) => void;
  post: (channel: string, threadTs: string, text: string) => Promise<void>;
  setStatus: (target: { channel: string; threadTs: string }, status: AgentSessionStatus) => Promise<void>;
  inflightTurns: (sessionId: string) => number;
  // Fleet workers homed in the session that are still running (optional → generic "stopped" line).
  activeWorkers?: (sessionId: string) => number;
  // Record the stop's event_ts for the session so messages sent before it are dropped (handleIncoming's markSessionStopped).
  markStopped?: (sessionId: string, eventTs: string) => void;
  // Duplicate/retried delivery filter: returns true if this key was already seen (see makeDeduper).
  isDuplicate?: (key: string) => boolean;
}

// Team id for an event: same source as the message path (bolt's context.teamId, derived from authorizations[0].team_id),
// falling back to the envelope's team_id. A mismatch would derive a different session key than the one messages created.
export function eventTeamId(context: { teamId?: string } | undefined, body: unknown): string {
  return context?.teamId ?? (body as { team_id?: string } | undefined)?.team_id ?? "unknown";
}

// Bounded "seen" set (insertion-ordered LRU) for retried event deliveries.
export function makeDeduper(max = 256): (key: string) => boolean {
  const seen = new Set<string>();
  return (key) => {
    if (seen.has(key)) return true;
    seen.add(key);
    if (seen.size > max) seen.delete(seen.values().next().value as string);
    return false;
  };
}

// Status after an interaction card is answered: `processing` only if a Slack-started turn is actually in flight. A turn
// that did not come from Slack (notify flush, desktop turn in a Slack session) must not leave the thread stuck in processing.
export function statusForWait(state: "waiting" | "answered", inflightTurns: number): AgentSessionStatus {
  if (state === "waiting") return "suspended";
  return inflightTurns > 0 ? "processing" : "active";
}

export interface AgentSessionEvent {
  team: string;
  channel: string;
  threadTs: string;
  user?: string;
  eventTs?: string;
  botUserId?: string; // our own bot user id (context.botUserId) — to recognize echoes of our own API calls
}

const TITLE_MAX = 200;

// Stop button. Slack has already stopped our streaming message(s); it does NOT touch session status, so we must stop the work,
// confirm to the user, and move the status out of `processing` ourselves.
export async function handleAgentSessionStopped(e: AgentSessionEvent, deps: AgentSessionEventDeps): Promise<void> {
  const sc = deps.slackConfig();
  if (!isPermittedUser(sc, e.user)) return; // same gate as messages: a stranger must not be able to stop someone's work
  if (e.eventTs && deps.isDuplicate?.(`${e.channel}:${e.threadTs}:${e.eventTs}`)) return; // retried delivery
  const sessionId = deps.sessions.findIdByKey(threadKey(e.team, e.channel, e.threadTs)); // never creates a session
  if (!sessionId) return;
  const target = { channel: e.channel, threadTs: e.threadTs };
  if (e.eventTs) deps.markStopped?.(sessionId, e.eventTs); // before any await: in-flight handleIncoming calls check it right before enqueueing

  // 1. The old stream is dead: make the reporter open a fresh one instead of erroring on the next append.
  deps.reporterFor(sessionId)?.markStreamsStopped();
  // 2. Abort the in-flight turn and drop turns queued before the stop (turns sent afterwards run normally).
  try { await deps.sessions.stop(sessionId, { cancelQueued: true }); } catch (err) { process.stderr.write(`[rookery][slack] stop failed: ${String(err)}\n`); }
  // 3. Pending approval/question cards for this thread resolve as cancelled now (the abort signal would also do it).
  deps.cancelInteractions(target);
  // 4. Confirm in the thread; workers are not stopped by this, so say so.
  const workers = deps.activeWorkers?.(sessionId) ?? 0;
  await deps.post(e.channel, e.threadTs, workers > 0 ? t(sc.locale, "slack.stoppedWorkers", { count: workers }) : t(sc.locale, "slack.stopped"));
  // 5. Leave `processing`. If aborted/cancelled turns are still draining, their handleIncoming finally sets `active` once the
  //    last one finishes — setting it here too early could be clobbered by (or clobber) a turn started right after the stop.
  if (deps.inflightTurns(sessionId) === 0) await deps.setStatus(target, "active");
}

// Title edited in Slack's UI → mirror it as the session label (existing sessions only; allowlisted users only).
export function handleAgentSessionTitleChanged(e: AgentSessionEvent & { title?: string }, deps: AgentSessionEventDeps): void {
  const sc = deps.slackConfig();
  // Echo guard: our own agents.sessions.setStatus title (the agent name) comes back as a title-changed event — applying it
  // would stamp the session label (and lock out the auto-labeler). Also ignore events without a user or from our bot.
  if (!e.user || e.user === e.botUserId || (e.title ?? "").trim() === (sc.name?.trim() || "rookery")) return;
  if (!isPermittedUser(sc, e.user)) return;
  const title = (e.title ?? "").replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
  if (!title) return;
  const sessionId = deps.sessions.findIdByKey(threadKey(e.team, e.channel, e.threadTs));
  if (!sessionId) return;
  deps.sessions.rename(sessionId, title);
}
