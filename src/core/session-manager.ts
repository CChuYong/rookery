import { randomUUID } from "node:crypto";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { Repositories } from "../persistence/repositories.js";
import type { EventBus } from "./events.js";
import type { QueryFn } from "./worker.js";
import { MasterAgent } from "./master-agent.js";
import type { TurnCapabilities } from "./master-agent.js";
import type { FleetOrchestrator } from "./fleet-orchestrator.js";

// Home session (container) for workers spawned directly by the UI. Not exposed in the Sessions list.
export const UI_FLEET_SESSION_KEY = "ui:fleet";
// Home (container) session for workers spawned by automation (automation: worker type) jobs. Not exposed in the Sessions list (same as UI_FLEET).
export const AUTOMATION_FLEET_SESSION_KEY = "automation:fleet";

// external_key prefix → source (origin) + identifier within the source (originRef). Shared by the getOrCreateByKey creation path
// and the fallback for old rows with an empty origin column / direct creation. slack=thread key, automation=automation id.
export function deriveOrigin(externalKey: string | null): { origin: string; originRef: string | null } {
  if (externalKey?.startsWith("slack:")) return { origin: "slack", originRef: externalKey.slice("slack:".length) };
  if (externalKey?.startsWith("automation:")) return { origin: "automation", originRef: externalKey.slice("automation:".length).split(":")[0]! };
  return { origin: "ui", originRef: null };
}

// Forks an SDK session into a new branch and returns the new session id (default = the SDK's forkSession). Injected at the composition root.
export type ForkFn = (sdkSessionId: string, opts?: { title?: string }) => Promise<{ sessionId: string }>;

export interface SessionManagerDeps {
  repos: Repositories;
  bus: EventBus;
  queryFn: QueryFn;
  masterModel: string | (() => string); // string or runtime-settings resolver
  masterEffort?: string | (() => string); // global default effort resolver (defaults to "high" if unspecified)
  masterName?: string | (() => string); // bot name resolver (defaults to "rookery" if unspecified)
  fleet: FleetOrchestrator;
  summarizeLabel?: (text: string) => Promise<string | null>; // auto-generate the session label from the first message (Haiku)
  // Builds an approval/question (canUseTool) callback from the session's externalKey (daemon routes it to the Slack thread). auto-allow if not injected/undefined.
  makeCanUseTool?: (externalKey: string | null, sessionId: string) => CanUseTool | undefined;
  // Builds a per-source dynamic capability resolver from the session's externalKey (slack: etc.) (assembled by the daemon). base only if not injected/undefined.
  makeCapabilities?: (externalKey: string | null, sessionId: string) => (() => TurnCapabilities) | undefined;
  // Forks a session's SDK conversation into a new branch (default = SDK forkSession). Absent → fork() is unavailable.
  forkSession?: ForkFn;
}

export interface Session {
  id: string;
  cwd: string;
  master: MasterAgent;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly idgen: () => string;

  constructor(
    private readonly deps: SessionManagerDeps,
    idgen?: () => string,
  ) {
    this.idgen = idgen ?? (() => randomUUID());
  }

  private build(id: string, cwd: string, sdkSessionId: string | null, externalKey: string | null): Session {
    const { repos, bus, queryFn, masterModel, masterEffort, masterName, fleet, summarizeLabel, makeCanUseTool, makeCapabilities } = this.deps;
    // Pass the resolver through as-is → MasterAgent resolves it per turn (Settings changes are reflected in cached sessions).
    const model = typeof masterModel === "function" ? masterModel : () => masterModel;
    const effort = typeof masterEffort === "function" ? masterEffort : () => masterEffort ?? "high";
    const name = typeof masterName === "function" ? masterName : () => masterName ?? "rookery";
    // Automation (unattended) sessions must never get a blocking approval/AskUserQuestion handler — a headless turn that
    // asks would hang forever (no client to answer), permanently wedging the cron in-flight guard. origin is persisted at
    // creation; fresh automation sessions are keyless so deriveOrigin(externalKey) alone would miss them → read the row.
    const origin = repos.getSession(id)?.origin || deriveOrigin(externalKey).origin;
    const canUseTool = origin === "automation" ? undefined : makeCanUseTool?.(externalKey, id); // session-bound approval/question callback (slack thread etc.). auto-allow if absent.
    const capabilities = makeCapabilities?.(externalKey, id); // session-bound per-source capability resolver (slack thread tools etc.). base only if absent.
    const master = new MasterAgent({
      sessionId: id,
      cwd,
      sdkSessionId,
      deps: { repos, bus, queryFn, model, effort, name, fleet, summarizeLabel, canUseTool, capabilities },
    });
    const session: Session = { id, cwd, master };
    this.sessions.set(id, session);
    const pending = repos.pendingNotifications(id);
    if (pending.length > 0) {
      for (const p of pending) master.notifyWorker(p.text); // delivered via notifyWorker — flushed immediately if the master is idle, else coalesced after the in-flight turn
      repos.deletePendingNotifications(id);
    }
    return session;
  }

  // If opts.origin is explicit (automation fresh etc.) use it as-is, otherwise derive from the externalKey prefix.
  create(cwd: string, opts: { externalKey?: string; origin?: string; originRef?: string | null } = {}): Session {
    const id = this.idgen();
    const src = opts.origin ? { origin: opts.origin, originRef: opts.originRef ?? null } : deriveOrigin(opts.externalKey ?? null);
    this.deps.repos.createSession({ id, cwd, externalKey: opts.externalKey, origin: src.origin, originRef: src.originRef });
    return this.build(id, cwd, null, opts.externalKey ?? null);
  }

  getOrCreateByKey(externalKey: string, cwd: string): Session {
    const existing = this.deps.repos.getSessionByExternalKey(externalKey);
    if (existing) return this.get(existing.id)!;
    return this.create(cwd, { externalKey }); // origin is derived from the key prefix (slack/automation)
  }

  // Fork a master session: copy its SDK conversation into a new branch + duplicate its transcript, so the fork carries
  // full context and shows the same history, then diverges from the next turn. The original is untouched.
  async fork(sessionId: string): Promise<Session> {
    const row = this.deps.repos.getSession(sessionId);
    if (!row) throw new Error(`unknown session: ${sessionId}`);
    if (!row.sdk_session_id) throw new Error("this session has no completed turn yet — nothing to fork");
    if (!this.deps.forkSession) throw new Error("session forking is not available");
    const label = row.label?.trim() || row.cwd.split(/[\\/]/).filter(Boolean).pop() || sessionId;
    const forkLabel = `${label} (fork)`;
    const { sessionId: forkedUuid } = await this.deps.forkSession(row.sdk_session_id, { title: forkLabel });
    const id = this.idgen();
    this.deps.repos.createSession({ id, cwd: row.cwd, origin: "ui", originRef: null }); // a fork is always a plain ui session
    this.deps.repos.setSdkSessionId(id, forkedUuid);
    this.deps.repos.copySessionEvents(sessionId, id);
    this.deps.repos.setSessionLabel(id, forkLabel);
    this.deps.bus.emit({ type: "session.label", sessionId: id, label: forkLabel }); // live UI label
    return this.build(id, row.cwd, forkedUuid, null);
  }

  get(id: string): Session | undefined {
    const live = this.sessions.get(id);
    if (live) return live;
    const row = this.deps.repos.getSession(id);
    if (!row) return undefined;
    return this.build(row.id, row.cwd, row.sdk_session_id, row.external_key);
  }

  // Live master → deliver immediately; cold (unloaded) session → persist and deliver on next load (build() drains).
  deliverWorkerNotification(sessionId: string, line: string): void {
    const live = this.sessions.get(sessionId); // NOTE: not get() — must not materialize a cold session here
    if (live) { live.master.notifyWorker(line); return; }
    this.deps.repos.addPendingNotification(sessionId, line);
  }

  // Aborts the in-progress master turn. Only targets live sessions (a session is always live while a turn is in progress) — otherwise no-op.
  async stop(id: string): Promise<void> {
    await this.sessions.get(id)?.master.stop();
  }

  // Change the session label + live update event (immediately reflected in the UI session list).
  rename(id: string, label: string): void {
    this.deps.repos.setSessionLabel(id, label);
    this.deps.bus.emit({ type: "session.label", sessionId: id, label });
  }

  archive(id: string, archived: boolean): void {
    this.deps.repos.setSessionArchived(id, archived);
  }

  setPinned(id: string, pinned: boolean): void {
    this.deps.repos.setSessionPinned(id, pinned);
  }

  // Permanently delete a session: abort the in-progress turn + clean up its workers + remove from the live map + DB cascade delete.
  async delete(id: string): Promise<void> {
    await this.sessions.get(id)?.master.stop().catch(() => {});
    // Clean up this session's workers in the fleet first (abort + remove worktree/branch/checkpoint ref + DB row).
    // Otherwise, even after deleteSession's cascade deletes the worker rows, a still-running worker keeps going and writing events,
    // throwing FK violations, the worktree is orphaned on disk, and the SDK session keeps consuming tokens.
    for (const w of this.deps.repos.listWorkers(id)) {
      try { await this.deps.fleet.delete(w.id); } catch { /* best-effort — remaining rows are cleaned up by the cascade below */ }
    }
    this.sessions.delete(id);
    this.deps.repos.deleteSession(id);
  }

  // Shutdown drain (G-SHUTDOWN-RACE): wait for the in-progress master turns of all live sessions to finish.
  // bounded timeout — so shutdown doesn't wait forever even if one turn hangs.
  async drain(timeoutMs = 5000): Promise<void> {
    const idles = [...this.sessions.values()].map((s) => s.master.idle().catch(() => {}));
    if (idles.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((res) => { timer = setTimeout(res, timeoutMs); });
    await Promise.race([Promise.all(idles).then(() => {}), timeout]);
    if (timer) clearTimeout(timer);
  }

  list(): Array<{ id: string; cwd: string; status: string; lastActivity: string; origin: string; originRef: string | null; label: string | null; archived: boolean; pinned: boolean }> {
    return this.deps.repos
      .listSessionsWithActivity()
      .filter((r) => r.external_key !== UI_FLEET_SESSION_KEY && r.external_key !== AUTOMATION_FLEET_SESSION_KEY) // hide UI/automation fleet container sessions
      .map((r) => {
        // Prefer the stored origin; if empty (old row), derive from external_key.
        const src = r.origin ? { origin: r.origin, originRef: r.origin_ref } : deriveOrigin(r.external_key);
        return {
          id: r.id,
          cwd: r.cwd,
          status: r.status,
          lastActivity: r.last_activity,
          label: r.label, // Haiku auto-generated label (null if absent → UI falls back to cwd)
          archived: !!r.archived_at, // archived flag — UI splits into the main list/archive (everything is sent down and the UI splits)
          pinned: !!r.pinned_at, // pinned flag — UI splits into a 'pinned' section at the top
          origin: src.origin, // ui | slack | automation
          originRef: src.originRef, // slack=thread key, automation=automation id, ui=null
        };
      });
  }
}
