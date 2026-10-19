import type { ThreadTarget } from "./types.js";

// Slack agent-session status (agents.sessions.setStatus). `processing` shows "Working…" plus Slack's native STOP button
// (only when the app subscribes to agent_session_stopped); `active` = ready; `suspended` = waiting on the user.
export type AgentSessionStatus = "processing" | "active" | "suspended";

// Minimal client surface. @slack/web-api 7.x has no typed agents.sessions.* methods, so the new API goes through apiCall;
// the legacy assistant.threads.setStatus is kept as a fallback for workspaces without the agent feature.
export interface AgentStatusClient {
  apiCall(method: string, args?: Record<string, unknown>): Promise<unknown>;
  assistant: { threads: { setStatus(a: { channel_id: string; thread_ts: string; status: string }): Promise<unknown> } };
}

// Method-level errors meaning "this method/feature is not available to us" → switch to the legacy API for the rest of the
// process. Everything else (ratelimited, channel_not_found, not_allowed, access_denied, …) is a per-call failure: no flip.
const UNAVAILABLE_CODES = new Set(["unknown_method", "feature_disabled", "not_allowed_token_type", "method_deprecated", "missing_scope"]);

const NEW_API_HEARTBEAT_MS = 30 * 60_000; // `processing` auto-expires after 1h → re-send well under that
const LEGACY_HEARTBEAT_MS = 90_000; // legacy status disappears after ~2 min of inactivity
const MISSING_SUB_WARNING = "missing_agent_session_stopped_event_subscription";

function errorCode(err: unknown): string | undefined {
  return (err as { data?: { error?: string } } | undefined)?.data?.error;
}

function hasWarning(res: unknown, w: string): boolean {
  const r = res as { warning?: unknown; response_metadata?: { warnings?: unknown } } | null | undefined;
  const list = r?.response_metadata?.warnings;
  if (Array.isArray(list) && list.some((x) => x === w)) return true;
  return typeof r?.warning === "string" && r.warning.split(",").map((x) => x.trim()).includes(w);
}

// Best-effort status setter shared by the Assistant (DM) and app_mention (channel thread) paths. Never throws.
export class SlackAgentStatus {
  private legacy = false; // process-wide: the new API was reported unavailable
  private warned = false;
  private readonly loggedCodes = new Set<string>(); // each distinct error code is logged once per process
  private readonly lastStatus = new Map<string, AgentSessionStatus>(); // per thread; absent = active/never set
  private readonly chains = new Map<string, Promise<void>>(); // per-thread ordering (processing → active must not reorder)

  constructor(private readonly log: (msg: string) => void = (m) => { process.stderr.write(m); }) {}

  // Heartbeat interval matching the API currently in use (read after the first set() so fallback detection has run).
  heartbeatMs(): number {
    return this.legacy ? LEGACY_HEARTBEAT_MS : NEW_API_HEARTBEAT_MS;
  }

  // title / initiatorUserId are creation-only on Slack's side (ignored for an existing session).
  set(client: AgentStatusClient, t: Pick<ThreadTarget, "channel" | "threadTs">, status: AgentSessionStatus, init?: { title?: string; initiatorUserId?: string }): Promise<void> {
    const key = `${t.channel}:${t.threadTs}`;
    if (status === "active") this.lastStatus.delete(key); else this.lastStatus.set(key, status);
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(() => this.send(client, t, status, init)).catch(() => {});
    this.chains.set(key, next);
    void next.then(() => { if (this.chains.get(key) === next) this.chains.delete(key); });
    return next;
  }

  // Heartbeat: re-send the thread's CURRENT status (processing expires; suspended must not be overwritten by a stale
  // processing). No-op when the thread is active/unknown.
  refresh(client: AgentStatusClient, t: Pick<ThreadTarget, "channel" | "threadTs">): Promise<void> {
    const last = this.lastStatus.get(`${t.channel}:${t.threadTs}`);
    return last ? this.set(client, t, last) : Promise.resolve();
  }

  private async send(client: AgentStatusClient, t: Pick<ThreadTarget, "channel" | "threadTs">, status: AgentSessionStatus, init?: { title?: string; initiatorUserId?: string }): Promise<void> {
    if (!this.legacy) {
      try {
        const res = await client.apiCall("agents.sessions.setStatus", {
          channel_id: t.channel,
          thread_ts: t.threadTs,
          status,
          ...(init?.title ? { title: init.title.slice(0, 200) } : {}),
          ...(init?.initiatorUserId ? { initiator_user_id: init.initiatorUserId } : {}),
        });
        if (!this.warned && hasWarning(res, MISSING_SUB_WARNING)) {
          this.warned = true;
          this.log("[rookery][slack] the app is not subscribed to the agent_session_stopped event — the Stop button will not appear. Subscribe to it (and agent_session_title_changed) in the Slack app's event settings.\n");
        }
        return;
      } catch (err) {
        const code = errorCode(err);
        if (code && !this.loggedCodes.has(code)) {
          this.loggedCodes.add(code);
          this.log(`[rookery][slack] agents.sessions.setStatus failed (${code})\n`);
        }
        if (!code || !UNAVAILABLE_CODES.has(code)) return; // transient / per-call failure: best-effort, no fallback
        this.legacy = true;
        this.log("[rookery][slack] falling back to assistant.threads.setStatus\n");
      }
    }
    if (status === "suspended") return; // the legacy API has no "waiting for input" state
    try {
      await client.assistant.threads.setStatus({ channel_id: t.channel, thread_ts: t.threadTs, status: status === "processing" ? "thinking…" : "" });
    } catch {
      /* best-effort (channels often don't support the assistant status) */
    }
  }
}
