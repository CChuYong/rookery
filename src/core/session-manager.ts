import { randomUUID } from "node:crypto";
import type { Repositories } from "../persistence/repositories.js";
import type { EventBus } from "./events.js";
import type { AgentBackend, ProviderPermissionCallback } from "./agent-backend.js";
import { MasterAgent } from "./master-agent.js";
import type { TurnCapabilities } from "./master-agent.js";
import type { FleetOrchestrator } from "./fleet-orchestrator.js";
import { parseNotification, type WorkerNotification } from "./worker-notifier.js";

// Home session (container) for workers spawned directly by the UI. Not exposed in the Sessions list.
export const UI_FLEET_SESSION_KEY = "ui:fleet";
// Home (container) session for workers spawned by automation (automation: worker type) jobs. Not exposed in the Sessions list (same as UI_FLEET).
export const AUTOMATION_FLEET_SESSION_KEY = "automation:fleet";
// Home (container) session for workers spawned by external MCP clients (rookery-as-MCP). Not exposed in the Sessions list (same as UI/AUTOMATION_FLEET).
export const EXTERNAL_FLEET_SESSION_KEY = "external:fleet";

// external_key prefix → source (origin) + identifier within the source (originRef). Shared by the getOrCreateByKey creation path
// and the fallback for old rows with an empty origin column / direct creation. slack=thread key, automation=automation id.
export function deriveOrigin(externalKey: string | null): { origin: string; originRef: string | null } {
  if (externalKey?.startsWith("slack:")) return { origin: "slack", originRef: externalKey.slice("slack:".length) };
  if (externalKey?.startsWith("automation:")) return { origin: "automation", originRef: externalKey.slice("automation:".length).split(":")[0]! };
  return { origin: "ui", originRef: null };
}

// Forks a session's SDK conversation into a new branch, routed by the SOURCE session's provider
// (e.g. "claude" → SDK forkSession, "codex" → CodexBackend.forkSession — same routing shape as
// FleetOrchestrator's forkSession, see fleet-orchestrator.ts). Injected at the composition root.
// P3 Track A: sourceSessionId/newSessionId are carried so the codex router (server.ts) can relocate
// the per-session CODEX_HOME's rollouts into the new session's home (see codex-home.ts
// seedCodexHomeFromSource) — the claude router ignores both fields.
export type ForkFn = (provider: string, sdkSessionId: string, opts?: { title?: string; sourceSessionId?: string; newSessionId?: string }) => Promise<{ sessionId: string }>;

export interface SessionManagerDeps {
  repos: Repositories;
  bus: EventBus;
  // Backend registry (P2): a master session picks its AgentBackend by its persisted `provider` column.
  // Key "claude" is REQUIRED (the default backend for pre-existing rows / unspecified provider).
  backends: Record<string, AgentBackend>;
  masterModel: string | (() => string); // string or runtime-settings resolver (claude default)
  // Per-provider master model resolver overrides (e.g. { codex: () => settings.codexMasterModel() }).
  // Falls back to masterModel when the session's provider has no entry here.
  masterModelByProvider?: Record<string, string | (() => string)>;
  masterEffort?: string | (() => string); // global default effort resolver (defaults to "high" if unspecified)
  masterName?: string | (() => string); // bot name resolver (defaults to "rookery" if unspecified)
  fleet: FleetOrchestrator;
  summarizeLabel?: (text: string) => Promise<string | null>; // auto-generate the session label from the first message (Haiku)
  // Builds an approval/question (canUseTool) callback from the session's externalKey (daemon routes it to the Slack thread). auto-allow if not injected/undefined.
  makeCanUseTool?: (externalKey: string | null, sessionId: string) => ProviderPermissionCallback | undefined;
  // Builds a per-source dynamic capability resolver from the session's externalKey (slack: etc.) (assembled by the daemon). base only if not injected/undefined.
  makeCapabilities?: (externalKey: string | null, sessionId: string) => (() => TurnCapabilities) | undefined;
  // Forks a session's SDK conversation into a new branch (default = SDK forkSession). Absent → fork() is unavailable.
  forkSession?: ForkFn;
  // P3-remaining Track B #3 (docs/2026-07-06-p3r-codex-hardening-finish.md): best-effort per-session
  // cleanup for a deleted session's daemon-only state (McpBridge release + removeCodexHome), injected
  // by the daemon (server.ts). Called once, inside delete(), AFTER the row cascade — the single owner of
  // this teardown (moved off the Connection-side call so it can't fire twice or leak on a future
  // programmatic delete caller that bypasses Connection). Never throws (delete() wraps the call).
  onSessionDelete?: (id: string) => void;
}

export interface Session {
  id: string;
  cwd: string;
  master: MasterAgent;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  // Sessions currently mid-delete. While delete() awaits teardown (close/worker removal) the DB row still exists,
  // so a concurrent get()/getOrCreateByKey() would otherwise rebuild a fresh master from the row — resurrecting the
  // session. This tombstone set makes those paths treat a mid-delete session as already gone.
  private readonly deleting = new Set<string>();
  private readonly idgen: () => string;

  constructor(
    private readonly deps: SessionManagerDeps,
    idgen?: () => string,
  ) {
    this.idgen = idgen ?? (() => randomUUID());
  }

  private build(id: string, cwd: string, sdkSessionId: string | null, externalKey: string | null): Session {
    const { repos, bus, backends, masterModel, masterModelByProvider, masterEffort, masterName, fleet, summarizeLabel, makeCanUseTool, makeCapabilities } = this.deps;
    // Single row read (was two separate getSession(id) calls) — same DB row backs both provider routing and origin below.
    const row = repos.getSession(id);
    // Provider routing (P2, mirrors FleetOrchestrator's worker provider routing): pick the backend + the
    // model resolver by the row's persisted provider (default "claude" for pre-existing/unspecified rows).
    const provider = row?.provider || "claude";
    const backend = backends[provider] ?? backends["claude"]!;
    const modelForProvider = masterModelByProvider?.[provider] ?? masterModel;
    // Pass the resolver through as-is → MasterAgent resolves it per turn (Settings changes are reflected in cached sessions).
    const model = typeof modelForProvider === "function" ? modelForProvider : () => modelForProvider;
    const effort = typeof masterEffort === "function" ? masterEffort : () => masterEffort ?? "high";
    const name = typeof masterName === "function" ? masterName : () => masterName ?? "rookery";
    // Automation (unattended) sessions must never get a blocking approval/AskUserQuestion handler — a headless turn that
    // asks would hang forever (no client to answer), permanently wedging the cron in-flight guard. origin is persisted at
    // creation; fresh automation sessions are keyless so deriveOrigin(externalKey) alone would miss them → read the row.
    const origin = row?.origin || deriveOrigin(externalKey).origin;
    const canUseTool = origin === "automation" ? undefined : makeCanUseTool?.(externalKey, id); // session-bound approval/question callback (slack thread etc.). auto-allow if absent.
    const capabilities = makeCapabilities?.(externalKey, id); // session-bound per-source capability resolver (slack thread tools etc.). base only if absent.
    const master = new MasterAgent({
      sessionId: id,
      cwd,
      sdkSessionId,
      deps: { repos, bus, backend, model, effort, name, fleet, summarizeLabel, canUseTool, capabilities },
    });
    const session: Session = { id, cwd, master };
    this.sessions.set(id, session);
    const pending = repos.pendingNotifications(id);
    if (pending.length > 0) {
      for (const p of pending) master.notifyWorker(parseNotification(p.text)); // delivered via notifyWorker — flushed immediately if idle, else coalesced after the in-flight turn
      repos.deletePendingNotifications(id);
    }
    return session;
  }

  // If opts.origin is explicit (automation fresh etc.) use it as-is, otherwise derive from the externalKey prefix.
  // opts.provider (P2): which AgentBackend this session runs on ("claude" | "codex"). Absent → repos.createSession
  // defaults to "claude". (P2.5 Track C: the slack path passes this via getOrCreateByKey when
  // settings.slackProvider()==="codex"; P3: automation-origin now passes it too via runAutomationAction.
  // Note: an existing keyed session's provider is fixed at creation and not retroactively changed by a
  // later call's arg — see getOrCreateByKey below.)
  create(cwd: string, opts: { externalKey?: string; origin?: string; originRef?: string | null; provider?: string } = {}): Session {
    const id = this.idgen();
    const src = opts.origin ? { origin: opts.origin, originRef: opts.originRef ?? null } : deriveOrigin(opts.externalKey ?? null);
    this.deps.repos.createSession({ id, cwd, externalKey: opts.externalKey, origin: src.origin, originRef: src.originRef, provider: opts.provider });
    return this.build(id, cwd, null, opts.externalKey ?? null);
  }

  // provider (P2.5 Track C): only used on first creation of this key — an existing keyed session's
  // provider is fixed at creation time and is not retroactively changed by a later call's arg.
  getOrCreateByKey(externalKey: string, cwd: string, provider?: string): Session {
    const existing = this.deps.repos.getSessionByExternalKey(externalKey);
    // A keyed session (e.g. a Slack thread reply) racing its own deletion must error rather than resurrect the
    // mid-teardown session or spawn a duplicate keyed one — the caller (Slack) surfaces the error.
    if (existing && this.deleting.has(existing.id)) throw new Error(`session ${existing.id} is being deleted`);
    if (existing) return this.get(existing.id)!;
    return this.create(cwd, { externalKey, provider }); // origin is derived from the key prefix (slack/automation)
  }

  // Fork a master session: copy its SDK conversation into a new branch + duplicate its transcript, so the fork carries
  // full context and shows the same history, then diverges from the next turn. The original is untouched.
  async fork(sessionId: string, target?: { provider?: string }): Promise<Session> {
    const row = this.deps.repos.getSession(sessionId);
    if (!row) throw new Error(`unknown session: ${sessionId}`);
    const srcProvider = row.provider || "claude";
    const label = row.label?.trim() || row.cwd.split(/[\\/]/).filter(Boolean).pop() || sessionId;
    // P3 Track A: generate the new session id FIRST — the codex fork router (server.ts) needs it up
    // front to seed the new session's per-session CODEX_HOME from the source's rollouts (see
    // codex-home.ts seedCodexHomeFromSource) BEFORE that new session's row/master even exist.
    const id = this.idgen();

    // Cross-provider handoff: no native resume handle crosses providers, so start a FRESH target session,
    // copy the transcript for UI history, and mark it so the first turn bakes the source transcript into
    // turn 1 (master-agent.ts). Model/effort are NOT persisted here (no session column) — the client
    // applies them as a per-session override after the fork. See docs/2026-07-08-cross-provider-fork-design.md.
    if (target?.provider && target.provider !== srcProvider) {
      if (this.deps.repos.listSessionEvents(sessionId).length === 0) {
        throw new Error("nothing to hand off — this session has no conversation yet");
      }
      const forkLabel = `${label} (→ ${target.provider})`;
      this.deps.repos.createSession({ id, cwd: row.cwd, origin: "ui", originRef: null, provider: target.provider });
      this.deps.repos.copySessionEvents(sessionId, id);
      this.deps.repos.setSessionHandoffFrom(id, srcProvider);
      this.deps.repos.setSessionLabel(id, forkLabel);
      this.deps.bus.emit({ type: "session.label", sessionId: id, label: forkLabel }); // live UI label
      return this.build(id, row.cwd, null, null); // no sdk_session_id yet — established on the first turn
    }

    // Same-provider fork (native path): copy the SDK conversation into a new branch.
    if (!row.sdk_session_id) throw new Error("this session has no completed turn yet — nothing to fork");
    if (!this.deps.forkSession) throw new Error("session forking is not available");
    const forkLabel = `${label} (fork)`;
    const provider = srcProvider;
    const { sessionId: forkedUuid } = await this.deps.forkSession(provider, row.sdk_session_id, {
      title: forkLabel,
      sourceSessionId: sessionId,
      newSessionId: id,
    });
    // A fork is always a plain ui session, but INHERITS the source's provider — a codex master's fork must also run on codex.
    this.deps.repos.createSession({ id, cwd: row.cwd, origin: "ui", originRef: null, provider });
    this.deps.repos.setSdkSessionId(id, forkedUuid);
    this.deps.repos.copySessionEvents(sessionId, id);
    this.deps.repos.setSessionLabel(id, forkLabel);
    this.deps.bus.emit({ type: "session.label", sessionId: id, label: forkLabel }); // live UI label
    return this.build(id, row.cwd, forkedUuid, null);
  }

  get(id: string): Session | undefined {
    if (this.deleting.has(id)) return undefined; // mid-delete: don't rebuild from the still-present DB row
    const live = this.sessions.get(id);
    if (live) return live;
    const row = this.deps.repos.getSession(id);
    if (!row) return undefined;
    return this.build(row.id, row.cwd, row.sdk_session_id, row.external_key);
  }

  // Live master → deliver immediately; cold (unloaded) session → persist (as JSON) and deliver on next load (build() drains).
  deliverWorkerNotification(sessionId: string, n: WorkerNotification): void {
    if (this.deleting.has(sessionId)) return; // mid-delete: the cascade sweeps the row anyway → don't park a line
    const live = this.sessions.get(sessionId); // NOTE: not get() — must not materialize a cold session here
    if (live) { live.master.notifyWorker(n); return; }
    this.deps.repos.addPendingNotification(sessionId, JSON.stringify(n));
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

  // Permanently delete a session. ORDER IS LOAD-BEARING (audit #8):
  // 0) tombstone FIRST — while the teardown below awaits (close/worker removal), the DB row still exists and
  //    get()'s lazy DB fallback would otherwise rebuild a fresh master into the map, resurrecting the session
  //    mid-deletion (ghost turns from build()'s pending-notification drain; a permanent map ghost after the
  //    cascade). get()/getOrCreateByKey()/deliverWorkerNotification treat a tombstoned id as already gone.
  // 1) remove from the live map — so a worker settling during teardown can't route a notify into this
  //    master (deliverWorkerNotification falls through to a pending row, which the cascade below sweeps), and
  //    no new turn can attach;
  // 2) close() the master — aborts the in-flight turn, cancels queued turns, and DRAINS the chain's DB writes
  //    while the row still exists (the old stop()-only path let the drain race the cascade → FK violations);
  // 3) clean up this session's workers (abort + remove worktree/branch/checkpoint refs + DB rows);
  // 4) cascade-delete the row.
  // The try/finally clears the tombstone even if a worker removal throws, so a failure can't leave a permanent one.
  async delete(id: string): Promise<void> {
    this.deleting.add(id);
    try {
      const live = this.sessions.get(id);
      this.sessions.delete(id);
      await live?.master.close().catch(() => {});
      for (const w of this.deps.repos.listWorkers(id)) {
        try { await this.deps.fleet.delete(w.id); } catch { /* best-effort — remaining rows are cleaned up by the cascade below */ }
      }
      this.deps.repos.deleteSession(id);
      // Best-effort daemon-only teardown (bridge release + CODEX_HOME removal) — the single owner of this
      // cleanup (see SessionManagerDeps.onSessionDelete). Never allowed to fail the delete itself.
      try { this.deps.onSessionDelete?.(id); } catch { /* best-effort */ }
    } finally {
      this.deleting.delete(id);
    }
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

  list(): Array<{ id: string; cwd: string; status: string; lastActivity: string; origin: string; originRef: string | null; label: string | null; archived: boolean; pinned: boolean; provider: string }> {
    return this.deps.repos
      .listSessionsWithActivity()
      .filter((r) => r.external_key !== UI_FLEET_SESSION_KEY && r.external_key !== AUTOMATION_FLEET_SESSION_KEY && r.external_key !== EXTERNAL_FLEET_SESSION_KEY) // hide UI/automation/external fleet container sessions
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
          provider: r.provider || "claude", // which AgentBackend runs this master session ('claude' | 'codex')
        };
      });
  }
}
