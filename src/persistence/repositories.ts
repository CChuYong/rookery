import type { DB } from "./db.js";

export interface SessionRow {
  id: string;
  cwd: string;
  status: string;
  sdk_session_id: string | null;
  external_key: string | null;
  origin: string | null; // ui | slack | automation (source). Legacy rows / direct creation are null → consumers fall back to external_key.
  origin_ref: string | null; // Identifier within the source: slack=thread key, automation=automation id, ui=null.
  pinned_at: string | null; // Pin timestamp (if set, shown in sidebar 'pinned' section). null=not pinned.
  label: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface MessageRow {
  id: number;
  session_id: string;
  role: string;
  content: string;
  created_at: string;
}
export interface WorkerRow {
  id: string;
  session_id: string;
  repo_path: string;
  label: string;
  status: string;
  worktree_path: string | null;
  branch: string | null;
  base: string | null;
  ticket_key: string | null; // Ticket/issue identifier that spawned this worker (e.g. ENG-123, #456). null=created directly.
  ticket_url: string | null; // That ticket's URL (header shortcut button).
  sdk_session_id: string | null;
  model: string | null;
  permission_mode: string; // 'bypassPermissions' | 'plan' — the worker's SDK permission mode (spawn-set, live-changeable)
  max_turns: number | null; // per-result turn cap (the unattended runaway guard). NULL = unlimited.
  effort: string | null; // spawn-time effort override. NULL = global default.
  archived_at: string | null;
  notify_armed: number; // 0/1 — one-shot "notify the home master when I next settle"
  created_at: string;
  updated_at: string;
}
export interface RepoRow {
  id: string;
  name: string;
  path: string;
  description: string;
  base: string | null;
  remote_url: string | null;
  created_at: string;
  updated_at: string;
}
export interface WorkerEventRow {
  id: number;
  worker_id: string;
  seq: number;
  type: string;
  payload_json: string;
  created_at: string;
}
export interface MemoryRow {
  id: number;
  content: string;
  tags: string;
  created_at: string;
}

export type AutomationTrigger =
  | { kind: "cron"; cron: string; timezone: string }
  | { kind: "once"; runAt: string } // One-shot (agent self-wakeup). Fires once at runAt (ISO) then auto-deletes.
  | { kind: "slack"; channels?: string[]; keyword?: string; fromUsers?: string[] };
export type AutomationAction =
  // When targetSessionId is set, resume that session (agent self-wakeup: "continue this conversation"). Otherwise reuse(automation:<id>)/fresh.
  | { kind: "master"; prompt: string; cwd: string; sessionMode: "reuse" | "fresh"; targetSessionId?: string }
  | { kind: "worker"; repo: string; task: string; base?: string };
export interface Automation {
  id: string; name: string; enabled: boolean;
  trigger: AutomationTrigger; action: AutomationAction;
  model: string | null; effort: string | null;
  permissionMode: string | null; maxTurns: number | null;
  nextRunAt: string | null;
  // "running" is a transient state written when a run starts (so the UI shows it's firing) and reconciled to ok/error when it ends.
  lastRunAt: string | null; lastStatus: "ok" | "error" | "skipped" | "running" | null; lastError: string | null;
  createdAt: string;
  /** Present (true) when the row has corrupt config JSON; the row is surfaced as disabled so it can be fixed/deleted. */
  corrupt?: true;
}
export interface AutomationInput {
  name: string; enabled?: boolean; trigger: AutomationTrigger; action: AutomationAction;
  model?: string | null; effort?: string | null;
  permissionMode?: string | null; maxTurns?: number | null;
}

// Worker terminal statuses (for the setWorkerStatus write-once guard). Same set as FleetOrchestrator.isTerminal — a domain invariant.
const TERMINAL_WORKER_STATUSES = new Set(["stopped", "done", "error", "failed", "orphaned"]);

export class Repositories {
  private readonly warnedCorrupt = new Set<string>();

  constructor(
    private readonly db: DB,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  createSession(input: { id: string; cwd: string; externalKey?: string; origin?: string; originRef?: string | null }): SessionRow {
    const ts = this.now();
    this.db
      .prepare(
        "INSERT INTO sessions(id, cwd, status, sdk_session_id, external_key, origin, origin_ref, created_at, updated_at) VALUES (?, ?, 'active', NULL, ?, ?, ?, ?, ?)",
      )
      .run(input.id, input.cwd, input.externalKey ?? null, input.origin ?? null, input.originRef ?? null, ts, ts);
    return this.getSession(input.id)!;
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  }

  getSessionByExternalKey(key: string): SessionRow | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE external_key = ?").get(key) as
      | SessionRow
      | undefined;
  }

  listSessions(): SessionRow[] {
    return this.db.prepare("SELECT * FROM sessions ORDER BY created_at, id").all() as SessionRow[];
  }

  // Attach the last message timestamp (or the session creation time if none) and return ordered by most recent activity.
  listSessionsWithActivity(): Array<SessionRow & { last_activity: string }> {
    return this.db
      .prepare(
        "SELECT s.*, COALESCE((SELECT MAX(created_at) FROM messages m WHERE m.session_id = s.id), s.created_at) AS last_activity FROM sessions s ORDER BY last_activity DESC, s.id",
      )
      .all() as Array<SessionRow & { last_activity: string }>;
  }

  setSessionLabel(id: string, label: string): void {
    this.db
      .prepare("UPDATE sessions SET label = ?, updated_at = ? WHERE id = ?")
      .run(label, this.now(), id);
  }

  setSessionStatus(id: string, status: string): void {
    this.db
      .prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, this.now(), id);
  }

  // Boot zombie cleanup: if the previous process died mid master turn, status gets stuck at 'running'.
  // Master sessions aren't resumed at boot (lazy), so every 'running' is a dead turn → set to idle. (The session-side counterpart of worker fleet.rehydrate.)
  resetRunningSessions(): void {
    this.db.prepare("UPDATE sessions SET status = 'idle', updated_at = ? WHERE status = 'running'").run(this.now());
  }

  setSessionArchived(id: string, archived: boolean): void {
    this.db
      .prepare("UPDATE sessions SET archived_at = ?, updated_at = ? WHERE id = ?")
      .run(archived ? this.now() : null, this.now(), id);
  }

  setSessionPinned(id: string, pinned: boolean): void {
    this.db
      .prepare("UPDATE sessions SET pinned_at = ?, updated_at = ? WHERE id = ?")
      .run(pinned ? this.now() : null, this.now(), id);
  }

  // Permanently delete a session — cascades to the transcript (messages) and the workers under it (including events/checkpoints).
  // With FK (foreign_keys=ON) we delete children first. One transaction.
  deleteSession(id: string): void {
    this.db.transaction(() => {
      const subIds = (this.db.prepare("SELECT id FROM workers WHERE session_id = ?").all(id) as Array<{ id: string }>).map((r) => r.id);
      for (const sid of subIds) this.deleteWorker(sid);
      this.db.prepare("DELETE FROM session_events WHERE session_id = ?").run(id);
      this.db.prepare("DELETE FROM messages WHERE session_id = ?").run(id);
      this.db.prepare("DELETE FROM pending_notifications WHERE session_id = ?").run(id);
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    })();
  }

  setWorkerArchived(id: string, archived: boolean): void {
    this.db
      .prepare("UPDATE workers SET archived_at = ?, updated_at = ? WHERE id = ?")
      .run(archived ? this.now() : null, this.now(), id);
  }

  // Permanently delete the worker DB row (cascades to events/checkpoints). Worktree removal is handled by the caller (fleet.discard).
  deleteWorker(id: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM worker_checkpoints WHERE worker_id = ?").run(id);
      this.db.prepare("DELETE FROM worker_events WHERE worker_id = ?").run(id);
      this.db.prepare("DELETE FROM workers WHERE id = ?").run(id);
    })();
  }

  setSdkSessionId(id: string, sdkSessionId: string): void {
    this.db
      .prepare("UPDATE sessions SET sdk_session_id = ?, updated_at = ? WHERE id = ?")
      .run(sdkSessionId, this.now(), id);
  }

  addMessage(input: { sessionId: string; role: string; content: string }): MessageRow {
    const info = this.db
      .prepare("INSERT INTO messages(session_id, role, content, created_at) VALUES (?, ?, ?, ?)")
      .run(input.sessionId, input.role, input.content, this.now());
    return this.db
      .prepare("SELECT * FROM messages WHERE id = ?")
      .get(Number(info.lastInsertRowid)) as MessageRow;
  }

  listMessages(sessionId: string, limit = 2000): MessageRow[] {
    // Last `limit` rows in chronological order — prevents an unbounded single WS frame (DPP-8). Normal sessions (<limit) come back in full.
    return this.db
      .prepare("SELECT * FROM (SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC")
      .all(sessionId, limit) as MessageRow[];
  }

  // Master transcript events (coalesced) — mirror of worker_events. The source of truth for restart/reconnect restore.
  addSessionEvent(input: { sessionId: string; seq: number; type: string; payloadJson: string }): void {
    this.db
      .prepare("INSERT INTO session_events(session_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(input.sessionId, input.seq, input.type, input.payloadJson, this.now());
  }

  // Next seq = MAX(seq)+1 (0 if none). O(1) via index, prevents races on consecutive writes.
  nextSessionSeq(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM session_events WHERE session_id = ?")
      .get(sessionId) as { next: number };
    return row.next;
  }

  listSessionEvents(sessionId: string, limit = 4000): Array<{ seq: number; type: string; payload_json: string; created_at: string }> {
    // Last `limit` rows in seq order (prevents an unbounded frame). Normal sessions (<limit) come back in full. created_at is for the message hover timestamp.
    return this.db
      .prepare("SELECT seq, type, payload_json, created_at FROM (SELECT seq, type, payload_json, created_at FROM session_events WHERE session_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC")
      .all(sessionId, limit) as Array<{ seq: number; type: string; payload_json: string; created_at: string }>;
  }

  // Copy all transcript events from one session to another (session fork) — preserves seq/type/payload/created_at.
  copySessionEvents(fromId: string, toId: string): void {
    this.db
      .prepare("INSERT INTO session_events(session_id, seq, type, payload_json, created_at) SELECT ?, seq, type, payload_json, created_at FROM session_events WHERE session_id = ? ORDER BY seq")
      .run(toId, fromId);
  }

  // Copy all transcript events from one worker to another (worker fork) — preserves seq/type/payload/created_at.
  copyWorkerEvents(fromId: string, toId: string): void {
    this.db
      .prepare("INSERT INTO worker_events(worker_id, seq, type, payload_json, created_at) SELECT ?, seq, type, payload_json, created_at FROM worker_events WHERE worker_id = ? ORDER BY seq")
      .run(toId, fromId);
  }

  // Latest persisted payload of an event type — seeds in-memory cumulative counters after a rebuild (audit #22/#28).
  lastSessionEventPayload(sessionId: string, type: string): string | undefined {
    const row = this.db.prepare("SELECT payload_json FROM session_events WHERE session_id = ? AND type = ? ORDER BY seq DESC LIMIT 1").get(sessionId, type) as { payload_json: string } | undefined;
    return row?.payload_json;
  }

  lastWorkerEventPayload(workerId: string, type: string): string | undefined {
    const row = this.db.prepare("SELECT payload_json FROM worker_events WHERE worker_id = ? AND type = ? ORDER BY seq DESC LIMIT 1").get(workerId, type) as { payload_json: string } | undefined;
    return row?.payload_json;
  }

  // worker_id → { lastActivityTs?, costUsd? } for the WHOLE fleet in one indexed GROUP BY pass (idx_worker_events).
  // lastActivityTs = ms of the last 'message' event (created_at is ISO → MAX is latest, Date.parse → ms, matching the
  // renderer). costUsd = the last 'result' event's cumulative total (non-decreasing → MAX). Absent metric = no such event;
  // a worker with neither is omitted from the map.
  workerActivityAndCost(): Map<string, { lastActivityTs?: number; costUsd?: number }> {
    const rows = this.db
      .prepare(
        "SELECT worker_id AS id, " +
          "MAX(CASE WHEN type = 'message' THEN created_at END) AS last_msg, " +
          "MAX(CASE WHEN type = 'result' THEN json_extract(payload_json, '$.costUsd') END) AS cost_usd " +
          "FROM worker_events GROUP BY worker_id",
      )
      .all() as Array<{ id: string; last_msg: string | null; cost_usd: number | null }>;
    const out = new Map<string, { lastActivityTs?: number; costUsd?: number }>();
    for (const r of rows) {
      const entry: { lastActivityTs?: number; costUsd?: number } = {};
      if (r.last_msg != null) {
        const ms = Date.parse(r.last_msg);
        if (!Number.isNaN(ms)) entry.lastActivityTs = ms;
      }
      if (r.cost_usd != null) entry.costUsd = Number(r.cost_usd);
      if (entry.lastActivityTs !== undefined || entry.costUsd !== undefined) out.set(r.id, entry);
    }
    return out;
  }

  createWorker(input: {
    id: string;
    sessionId: string;
    repoPath: string;
    label: string;
    worktreePath?: string;
    branch?: string;
    base?: string;
    ticketKey?: string;
    ticketUrl?: string;
  }): WorkerRow {
    const ts = this.now();
    this.db
      .prepare(
        // Born 'provisioning': the row is inserted before `git worktree add` runs, so the UI can show the worker while a large
        // repo's worktree is still being created. The orchestrator reconciles it to running/idle once the agent boots.
        "INSERT INTO workers(id, session_id, repo_path, label, status, worktree_path, branch, base, ticket_key, ticket_url, created_at, updated_at) VALUES (?, ?, ?, ?, 'provisioning', ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(input.id, input.sessionId, input.repoPath, input.label, input.worktreePath ?? null, input.branch ?? null, input.base ?? null, input.ticketKey ?? null, input.ticketUrl ?? null, ts, ts);
    return this.getWorker(input.id)!;
  }

  getWorker(id: string): WorkerRow | undefined {
    return this.db.prepare("SELECT * FROM workers WHERE id = ?").get(id) as
      | WorkerRow
      | undefined;
  }

  listWorkers(sessionId: string): WorkerRow[] {
    return this.db
      .prepare("SELECT * FROM workers WHERE session_id = ? ORDER BY created_at, id")
      .all(sessionId) as WorkerRow[];
  }

  listAllWorkers(): WorkerRow[] {
    return this.db.prepare("SELECT * FROM workers ORDER BY created_at, id").all() as WorkerRow[];
  }

  setWorkerBase(id: string, base: string): void {
    this.db.prepare("UPDATE workers SET base = ?, updated_at = ? WHERE id = ?").run(base, this.now(), id);
  }

  setWorkerSdkSessionId(id: string, sdkSessionId: string): void {
    this.db.prepare("UPDATE workers SET sdk_session_id = ?, updated_at = ? WHERE id = ?").run(sdkSessionId, this.now(), id);
  }

  createRepo(input: { id: string; name: string; path: string; description: string; base?: string; remoteUrl?: string }): RepoRow {
    if (this.getRepoByName(input.name)) throw new Error(`A repo named "${input.name}" already exists`);
    if (this.getRepoByPath(input.path)) throw new Error(`A repo at path "${input.path}" already exists`);
    const ts = this.now();
    this.db
      .prepare("INSERT INTO repos(id, name, path, description, base, remote_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(input.id, input.name, input.path, input.description, input.base ?? null, input.remoteUrl ?? null, ts, ts);
    return this.getRepoByName(input.name)!;
  }

  getRepoByName(name: string): RepoRow | undefined {
    return this.db.prepare("SELECT * FROM repos WHERE name = ?").get(name) as RepoRow | undefined;
  }

  getRepoByPath(path: string): RepoRow | undefined {
    return this.db.prepare("SELECT * FROM repos WHERE path = ?").get(path) as RepoRow | undefined;
  }

  listRepos(): RepoRow[] {
    return this.db.prepare("SELECT * FROM repos ORDER BY name").all() as RepoRow[];
  }

  updateRepo(name: string, patch: { description?: string; base?: string }): void {
    const cur = this.getRepoByName(name);
    if (!cur) return;
    // If base is "", clear it to NULL (use HEAD); if undefined, keep the existing value (DPP-6).
    const base = patch.base === "" ? null : (patch.base ?? cur.base);
    this.db
      .prepare("UPDATE repos SET description = ?, base = ?, updated_at = ? WHERE name = ?")
      .run(patch.description ?? cur.description, base, this.now(), name);
  }

  removeRepo(name: string): void {
    this.db.prepare("DELETE FROM repos WHERE name = ?").run(name);
  }

  // Terminal status write-once (single chokepoint): both writers (Worker.transition / FleetOrchestrator.setStatus)
  // route here to write the DB, so blocking it here structurally prevents a race from overturning a terminal value (A1). force=only
  // user stop/discard·rehydrate is exempt (intentionally updating a terminal state to another terminal/idle state).
  setWorkerStatus(id: string, status: string, force = false): void {
    if (!force) {
      const cur = this.db.prepare("SELECT status FROM workers WHERE id = ?").get(id) as { status?: string } | undefined;
      if (cur && TERMINAL_WORKER_STATUSES.has(cur.status ?? "") && cur.status !== status) return; // a terminal state can't be overwritten with a different value
    }
    this.db
      .prepare("UPDATE workers SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, this.now(), id);
  }

  setWorkerNotifyArmed(id: string, armed: boolean): void {
    this.db.prepare("UPDATE workers SET notify_armed = ?, updated_at = ? WHERE id = ?").run(armed ? 1 : 0, this.now(), id);
  }

  // Atomic read + clear (one-shot). Returns the armed flag and the worker's home session, or null if the worker is gone.
  consumeWorkerNotifyArmed(id: string): { armed: boolean; sessionId: string } | null {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT notify_armed, session_id FROM workers WHERE id = ?").get(id) as { notify_armed: number; session_id: string } | undefined;
      if (!row) return null;
      if (row.notify_armed === 1) this.db.prepare("UPDATE workers SET notify_armed = 0, updated_at = ? WHERE id = ?").run(this.now(), id);
      return { armed: row.notify_armed === 1, sessionId: row.session_id };
    })();
  }

  addPendingNotification(sessionId: string, text: string): void {
    this.db.prepare("INSERT INTO pending_notifications(session_id, text, created_at) VALUES (?, ?, ?)").run(sessionId, text, this.now());
  }

  pendingNotifications(sessionId: string): Array<{ id: number; text: string }> {
    return this.db.prepare("SELECT id, text FROM pending_notifications WHERE session_id = ? ORDER BY id").all(sessionId) as Array<{ id: number; text: string }>;
  }

  deletePendingNotifications(sessionId: string): void {
    this.db.prepare("DELETE FROM pending_notifications WHERE session_id = ?").run(sessionId);
  }

  setWorkerLabel(id: string, label: string): void {
    this.db
      .prepare("UPDATE workers SET label = ?, updated_at = ? WHERE id = ?")
      .run(label, this.now(), id);
  }

  setWorkerModel(id: string, model: string): void {
    this.db
      .prepare("UPDATE workers SET model = ?, updated_at = ? WHERE id = ?")
      .run(model, this.now(), id);
  }

  setWorkerPermissionMode(id: string, mode: string): void {
    this.db
      .prepare("UPDATE workers SET permission_mode = ?, updated_at = ? WHERE id = ?")
      .run(mode, this.now(), id);
  }

  setWorkerMaxTurns(id: string, maxTurns: number): void {
    this.db.prepare("UPDATE workers SET max_turns = ?, updated_at = ? WHERE id = ?").run(maxTurns, this.now(), id);
  }

  setWorkerEffort(id: string, effort: string): void {
    this.db.prepare("UPDATE workers SET effort = ?, updated_at = ? WHERE id = ?").run(effort, this.now(), id);
  }

  addWorkerEvent(input: {
    workerId: string;
    seq: number;
    type: string;
    payloadJson: string;
  }): WorkerEventRow {
    const info = this.db
      .prepare(
        "INSERT INTO worker_events(worker_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(input.workerId, input.seq, input.type, input.payloadJson, this.now());
    return this.db
      .prepare("SELECT * FROM worker_events WHERE id = ?")
      .get(Number(info.lastInsertRowid)) as WorkerEventRow;
  }

  // Record a per-turn checkpoint (seq=transcript position). Re-recording the same seq is an INSERT (a new row when re-running after restoring a past turn).
  addCheckpoint(input: { workerId: string; seq: number; sha: string }): void {
    this.db
      .prepare("INSERT INTO worker_checkpoints(worker_id, seq, sha, created_at) VALUES (?, ?, ?, ?)")
      .run(input.workerId, input.seq, input.sha, this.now());
  }

  listCheckpoints(workerId: string): Array<{ seq: number; sha: string; created_at: string }> {
    return this.db
      .prepare("SELECT seq, sha, created_at FROM worker_checkpoints WHERE worker_id = ? ORDER BY seq, id")
      .all(workerId) as Array<{ seq: number; sha: string; created_at: string }>;
  }

  // Next checkpoint seq = MAX(seq)+1 (0 if none). Read atomically in a single statement instead of listCheckpoints().length
  // to prevent a race where consecutive onTurnStart calls for the same worker write the same seq (O(1) via index).
  nextCheckpointSeq(workerId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM worker_checkpoints WHERE worker_id = ?")
      .get(workerId) as { next: number };
    return row.next;
  }

  // Next seq to write = MAX(seq)+1 (0 if no events). Ensures the orchestrator's error events don't collide with the real seq.
  nextWorkerSeq(workerId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM worker_events WHERE worker_id = ?")
      .get(workerId) as { next: number };
    return row.next;
  }

  listWorkerEvents(workerId: string, sinceSeq?: number, limit = 4000): WorkerEventRow[] {
    if (sinceSeq === undefined) {
      // A full fetch is capped at the last `limit` rows (prevents an unbounded single WS frame / context blowup). Normal workers (<limit) come back in full.
      return this.db
        .prepare("SELECT * FROM (SELECT * FROM worker_events WHERE worker_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC")
        .all(workerId, limit) as WorkerEventRow[];
    }
    // The incremental path (sinceSeq) is client polling so it's naturally small — leave as-is.
    return this.db
      .prepare("SELECT * FROM worker_events WHERE worker_id = ? AND seq > ? ORDER BY seq")
      .all(workerId, sinceSeq) as WorkerEventRow[];
  }

  addMemory(input: { content: string; tags?: string }): MemoryRow {
    const info = this.db
      .prepare("INSERT INTO memories(content, tags, created_at) VALUES (?, ?, ?)")
      .run(input.content, input.tags ?? "", this.now());
    return this.db
      .prepare("SELECT * FROM memories WHERE id = ?")
      .get(Number(info.lastInsertRowid)) as MemoryRow;
  }

  searchMemories(query: string, limit: number): MemoryRow[] {
    const q = query.trim();
    if (!q) return []; // An empty/whitespace query returns 0 rows, not a full dump (avoids indiscriminately exposing unrelated/sensitive memories)
    // Treat LIKE wildcards (%, _) and the escape char as literals — otherwise input like '100%' or 'TODO_v2' would act as wildcards.
    const esc = q.replace(/[\\%_]/g, (c) => `\\${c}`);
    const like = `%${esc}%`;
    return this.db
      .prepare(
        "SELECT * FROM memories WHERE content LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?",
      )
      .all(like, like, limit) as MemoryRow[];
  }

  recentMemories(limit: number): MemoryRow[] {
    return this.db
      .prepare("SELECT * FROM memories ORDER BY id DESC LIMIT ?")
      .all(limit) as MemoryRow[];
  }

  getSetting(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .run(key, value, this.now());
  }

  deleteSetting(key: string): void {
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }

  private rowToAutomation(row: {
    id: string; name: string; enabled: number; trigger_type: string; trigger_config_json: string;
    action_type: string; action_config_json: string; model: string | null; effort: string | null;
    permission_mode: string | null; max_turns: number | null;
    next_run_at: string | null; last_run_at: string | null; last_status: string | null; last_error: string | null; created_at: string;
  }): Automation {
    try {
      return {
        id: row.id, name: row.name, enabled: row.enabled === 1,
        trigger: { kind: row.trigger_type, ...JSON.parse(row.trigger_config_json) } as AutomationTrigger,
        action: { kind: row.action_type, ...JSON.parse(row.action_config_json) } as AutomationAction,
        model: row.model, effort: row.effort,
        permissionMode: row.permission_mode, maxTurns: row.max_turns,
        nextRunAt: row.next_run_at,
        lastRunAt: row.last_run_at, lastStatus: (row.last_status as Automation["lastStatus"]) ?? null,
        lastError: row.last_error, createdAt: row.created_at,
      };
    } catch {
      if (!this.warnedCorrupt.has(row.id)) {
        this.warnedCorrupt.add(row.id);
        console.warn(`[automations] row ${row.id} has corrupt config JSON; surfaced as corrupt/disabled`);
      }
      return {
        id: row.id, name: row.name, enabled: false, corrupt: true,
        trigger: { kind: row.trigger_type } as AutomationTrigger,
        action: { kind: row.action_type } as AutomationAction,
        model: row.model, effort: row.effort,
        permissionMode: row.permission_mode, maxTurns: row.max_turns,
        nextRunAt: null,
        lastRunAt: row.last_run_at, lastStatus: (row.last_status as Automation["lastStatus"]) ?? null,
        lastError: row.last_error, createdAt: row.created_at,
      };
    }
  }

  createAutomation(id: string, input: AutomationInput): Automation {
    const { kind: tk, ...tc } = input.trigger; const { kind: ak, ...ac } = input.action;
    this.db.prepare(
      `INSERT INTO automations (id,name,enabled,trigger_type,trigger_config_json,action_type,action_config_json,model,effort,permission_mode,max_turns,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, input.name, input.enabled ? 1 : 0, tk, JSON.stringify(tc), ak, JSON.stringify(ac), input.model ?? null, input.effort ?? null, input.permissionMode ?? null, input.maxTurns ?? null, this.now());
    return this.getAutomation(id)!;
  }

  getAutomation(id: string): Automation | undefined {
    const row = this.db.prepare("SELECT * FROM automations WHERE id = ?").get(id) as Parameters<Repositories["rowToAutomation"]>[0] | undefined;
    return row ? this.rowToAutomation(row) : undefined;
  }
  listAutomations(): Automation[] {
    const rows = this.db.prepare("SELECT * FROM automations ORDER BY created_at ASC").all() as Parameters<Repositories["rowToAutomation"]>[0][];
    return rows.map((r) => this.rowToAutomation(r));
  }
  updateAutomation(id: string, patch: Partial<AutomationInput>): Automation | undefined {
    const cur = this.getAutomation(id); if (!cur) return undefined;
    const trigger = patch.trigger ?? cur.trigger; const action = patch.action ?? cur.action;
    const { kind: tk, ...tc } = trigger; const { kind: ak, ...ac } = action;
    this.db.prepare(
      `UPDATE automations SET name=?, enabled=?, trigger_type=?, trigger_config_json=?, action_type=?, action_config_json=?, model=?, effort=?, permission_mode=?, max_turns=? WHERE id=?`,
    ).run(
      patch.name ?? cur.name,
      (patch.enabled === undefined ? cur.enabled : patch.enabled) ? 1 : 0,
      tk, JSON.stringify(tc), ak, JSON.stringify(ac),
      patch.model === undefined ? cur.model : patch.model,
      patch.effort === undefined ? cur.effort : patch.effort,
      patch.permissionMode === undefined ? cur.permissionMode : patch.permissionMode,
      patch.maxTurns === undefined ? cur.maxTurns : patch.maxTurns,
      id,
    );
    return this.getAutomation(id);
  }
  deleteAutomation(id: string): void { this.db.prepare("DELETE FROM automations WHERE id = ?").run(id); }
  setAutomationEnabled(id: string, enabled: boolean): Automation | undefined {
    this.db.prepare("UPDATE automations SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
    return this.getAutomation(id);
  }
  setAutomationRun(id: string, run: { lastRunAt: string|null; lastStatus: "ok"|"error"|"skipped"|"running"|null; lastError: string|null }): void {
    // Deliberately does NOT touch next_run_at — the Scheduler owns it (fireCron advances it BEFORE dispatch;
    // reconcile rewrites it on edit). Writing a fire-time snapshot back here rewound in-flight advances,
    // making long cron runs refire back-to-back forever and reverting mid-run schedule edits.
    this.db.prepare("UPDATE automations SET last_run_at=?, last_status=?, last_error=? WHERE id=?")
      .run(run.lastRunAt, run.lastStatus, run.lastError, id);
  }

  // Boot cleanup: a 'running' row means the daemon died mid-run (the transient running state never reconciled) → clear it so the
  // UI doesn't show a perpetual running pulse. Counterpart of resetRunningSessions / fleet.rehydrate.
  resetRunningAutomations(): void {
    this.db.prepare("UPDATE automations SET last_status = 'error', last_error = 'interrupted by restart' WHERE last_status = 'running'").run();
  }
  setAutomationNextRun(id: string, nextRunAt: string | null): void {
    this.db.prepare("UPDATE automations SET next_run_at = ? WHERE id = ?").run(nextRunAt, id);
  }
}
