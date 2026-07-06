import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Repositories } from "../persistence/repositories.js";
import type { EventBus } from "./events.js";
import type { GitOps } from "./git-ops.js";
import type { SlashCommandInfo } from "./agent-backend.js";
import { truncateBytes } from "./truncate.js";

const DIFF_MAX_BYTES = 512 * 1024; // byte cap before sending a diff directly as a single WS frame (git-diff-no-chunking)

export interface WorkerLike {
  start(task?: string): void;
  resume(): void;
  send(text: string, clientMsgId?: string): void;
  stop(): Promise<void>;
  status(): string;
  waitUntilSettled(): Promise<void>;
  listCommands?(): Promise<SlashCommandInfo[]>; // slash commands/skills of a live session (absent = unsupported)
  setModel?(model: string): Promise<void>; // hot-swap the model while running (query.setModel)
  setPermissionMode?(mode: string): Promise<void>; // hot-swap the permission mode while running (query.setPermissionMode)
  interruptTurn?(): Promise<void>; // abort only the current turn (keep the session, query.interrupt) — unlike stop, does not close the queue
  notice?(text: string): void; // surface an out-of-band informational notice in the worker transcript (degraded condition the orchestrator caught)
}

export type WorkerFactory = (opts: {
  id: string;
  sessionId: string;
  repoPath: string;
  label: string;
  sdkSessionId?: string | null;
  model?: string; // model override at spawn time (falls back to global default). Fixed once running.
  effort?: string;
  permissionMode?: string; // SDK permission mode at spawn time (falls back to the Worker default "bypassPermissions"). Changeable live.
  onTurnStart?: () => void; // called right before each turn starts — for checkpointing
  maxTurns?: number; // per-result turn cap passed through to Worker
  costBudgetUsd?: number; // lifetime USD cost ceiling passed through to Worker
  provider?: string; // which AgentBackend runs this worker ('claude' | 'codex'). Fixed once running.
}) => WorkerLike;

export interface FleetDeps {
  repos: Repositories;
  bus: EventBus;
  git: GitOps;
  factory: WorkerFactory;
  worktreesDir: string;
  idgen?: () => string;
  exists?: (p: string) => boolean; // check worktree existence (for test injection, defaults to fs.existsSync)
  // automatic label generation (usually Haiku). If present, asynchronously upgrades the placeholder label to a better one right after spawn.
  // best-effort: on null/throw, keeps the placeholder. If absent, does not update the label.
  summarizeLabel?: (task: string) => Promise<string | null>;
  // Forks a worker's SDK conversation into a new branch, routed by the source worker's provider
  // (e.g. "claude" → SDK forkSession, "codex" → CodexBackend.forkSession). Absent → fork() is unavailable.
  forkSession?: (provider: string, sdkSessionId: string, opts?: { title?: string }) => Promise<{ sessionId: string }>;
}

interface Entry {
  // a detached entry (one rehydrated after restart) has no live agent → agent is optional.
  agent?: WorkerLike;
  homeSessionId: string;
  repoPath: string;
  worktreePath: string;
  branch: string;
  base: string;
  status: string;
  label?: string; // label to pass to the factory on materialize
  model?: string; // persisted current model → on resume, materialize with the same model (restart consistency)
  permissionMode?: string; // persisted current permission mode → on resume, materialize with the same mode (restart consistency)
  maxTurns?: number; // persisted per-result turn cap → materialize restores it (the unattended runaway guard)
  costBudgetUsd?: number; // persisted lifetime cost ceiling → materialize restores it (the unattended runaway guard)
  effort?: string; // persisted spawn-time effort override → materialize restores it
  provider?: string; // which AgentBackend runs this worker ('claude' | 'codex') → materialize/fork restore it
  resumeSessionId?: string; // if present, "resumable but not yet started (lazy)" state — materialize on first send/await
  pendingLabel?: boolean; // task-less spawn: relabel from the first send() message (not from spawn)
}

// ticket identifier → branch slug. A GitHub number (`#123`) becomes `issue-123`; others (Linear `ENG-123`, etc.) become a lowercase slug.
export function branchSlug(identifier: string): string {
  let s = identifier.trim();
  if (s.startsWith("#")) s = "issue-" + s.slice(1);
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export class FleetOrchestrator {
  private readonly entries = new Map<string, Entry>();
  private readonly flows = new Set<Promise<void>>(); // in-flight spawn/live flows (for shutdown-drain waiting, tracked synchronously)
  // Per-id handle on the in-flight spawn flow + cooperative-cancel marks. discard/delete during provisioning
  // set the mark and AWAIT the flow: run() checks the mark after each await and bails — removing the worktree
  // it just created and never registering an entry/agent — so nothing leaks and no ghost survives (audit #12).
  private readonly flowById = new Map<string, Promise<void>>();
  private readonly cancelledSpawns = new Set<string>();
  private readonly idgen: () => string;
  private readonly exists: (p: string) => boolean;
  private closing = false; // close() in progress — even a just-started launch flow stops and finishes its DB writes (G-SHUTDOWN-RACE)
  // per-worker checkpoint serialization chain — so consecutive onTurnStart calls for the same worker don't read seq concurrently and collide;
  // run one at a time. In-flight checkpoint writes are tracked via checkpointWrites so close() can drain them.
  private readonly ckptChains = new Map<string, Promise<void>>();
  private readonly checkpointWrites = new Set<Promise<void>>();
  private readonly ckptWarned = new Set<string>(); // workers we've already warned about a checkpoint failure (one notice, not per-turn spam)
  // Workers with a checkpoint restore in flight — send() must not start a turn while git checkout is rewriting
  // the worktree (the running-guard in restore() is only valid at the tick it runs; this closes the TOCTOU).
  private readonly restoring = new Set<string>();

  constructor(private readonly deps: FleetDeps) {
    this.idgen = deps.idgen ?? (() => randomUUID());
    this.exists = deps.exists ?? fs.existsSync;
  }

  // register a live (running/idle) agent into a flow → shutdown-drain (waitAllSettled) waiting + final
  // status cleanup on termination (settle as the worker's own terminal status). Resumed agents also go through this.
  private trackFlow(id: string, agent: WorkerLike): void {
    const flow = agent
      .waitUntilSettled()
      .then(() => {
        // Settle as the worker's own terminal status. A runtime error stays 'error' — remapping to 'failed'
        // diverged from the DB (the Worker already wrote terminal 'error'; the write-once guard dropped the
        // remap write while the entry/event said 'failed'). 'failed' is reserved for provisioning failures.
        this.setStatus(id, agent.status());
      })
      .catch(() => {});
    this.flows.add(flow);
    void flow.finally(() => this.flows.delete(flow));
  }

  // lazy resume: on first send/await, actually start the SDK session (factory+resume) → register the flow.
  private materialize(id: string, e: Entry): WorkerLike {
    const agent = this.deps.factory({ id, sessionId: e.homeSessionId, repoPath: e.worktreePath, label: e.label ?? "", sdkSessionId: e.resumeSessionId ?? null, model: e.model, effort: e.effort, maxTurns: e.maxTurns, costBudgetUsd: e.costBudgetUsd, permissionMode: e.permissionMode ?? this.deps.repos.getWorker(id)?.permission_mode, provider: e.provider, onTurnStart: () => this.checkpoint(id) });
    agent.resume();
    e.agent = agent;
    e.resumeSessionId = undefined;
    this.trackFlow(id, agent); // lazy → register as a live flow (subject to shutdown drain)
    return agent;
  }

  // called at daemon startup: restore detached entries (worktree metadata only, no live agent) from the
  // workers rows in the DB. This keeps diff/discard/stop working after a restart (the live conversation
  // can't be revived — the process is dead). Zombies stuck in running/idle have no live process, so clean them up as orphaned.
  rehydrate(): void {
    for (const row of this.deps.repos.listAllWorkers()) {
      if (this.entries.has(row.id)) continue; // already live (shouldn't happen right after startup, but defensively)
      if (!row.worktree_path || !row.branch) continue; // no worktree to manage
      let status = row.status;
      let resumeSessionId: string | undefined;
      // treat not only running/idle but also 'stopped' as resumable. On shutdown, fleet.close stops live
      // workers for a DB flush, leaving them stopped, but that is a byproduct of process termination, not user intent.
      // stop keeps the worktree, so if sdk_session+worktree are both alive, lazy-resuming (→idle) after restart is correct.
      // 'provisioning' is a worker the daemon died mid-spawn on (never got an sdk_session) → it falls to the orphaned branch
      // below, so it shows as a dead worker (diff/discard) instead of a stuck spinner.
      if (status === "running" || status === "idle" || status === "stopped" || status === "provisioning") {
        // resume condition: a saved SDK session + the worktree actually exists. If either is missing it's a zombie →
        // orphaned (diff/discard only). Resuming when the worktree is gone would advertise a dead worker as healthy.
        if (row.sdk_session_id && this.exists(row.worktree_path)) {
          // LAZY: don't start the SDK session, just mark it "resumable" → boot is light, and restored agents that go unused cost 0.
          // Actual resume happens on first send/await (materialize). To the user it appears idle (ready).
          resumeSessionId = row.sdk_session_id;
          status = "idle";
          // also update DB to idle — fleet.list (UI) reads DB status, so without this the 'stopped'/'running' stamped at shutdown
          // would still show (in particular graceful shutdown makes fleet.close turn everything 'stopped', dropping every worker to STOP).
          this.deps.repos.setWorkerStatus(row.id, "idle", true); // rehydrate intentionally updates terminal (stopped) → idle → force
        } else {
          status = "orphaned";
          this.deps.repos.setWorkerStatus(row.id, "orphaned", true); // likewise a terminal update → force
        }
      }
      this.entries.set(row.id, {
        homeSessionId: row.session_id,
        repoPath: row.repo_path,
        worktreePath: row.worktree_path,
        branch: row.branch,
        base: row.base ?? "",
        status,
        label: row.label,
        model: row.model ?? undefined,
        permissionMode: row.permission_mode ?? undefined,
        maxTurns: row.max_turns ?? undefined,
        costBudgetUsd: row.cost_budget_usd ?? undefined,
        effort: row.effort ?? undefined,
        provider: row.provider ?? undefined,
        resumeSessionId,
      });
    }
  }

  // the returned Promise resolves after worktree provisioning finishes (agent boot = SDK session start continues asynchronously).
  // → at return time the worktree exists on disk, so the renderer's root resolution (explorer/diff) points at the worktree on the first try.
  // there is no concurrent-worker cap (removed) — spawn is never rejected.
  async spawn(input: { homeSessionId: string; repoPath: string; label: string; task?: string; base?: string; model?: string; effort?: string; permissionMode?: string; ticketKey?: string; ticketUrl?: string; notify?: boolean; maxTurns?: number; costBudgetUsd?: number; provider?: string }): Promise<{ id: string }> {
    const id = this.idgen();
    // if there is a ticket, name the branch from its key (rookery/<slug>), with a short suffix only on collision. Otherwise rookery/<id>.
    const slug = input.ticketKey ? branchSlug(input.ticketKey) : "";
    let branch = slug ? `rookery/${slug}` : `rookery/${id}`;
    if (slug && (await this.deps.git.branchExists(input.repoPath, branch))) branch = `${branch}-${id.slice(0, 6)}`;
    const worktreePath = path.join(this.deps.worktreesDir, id);
    let signalReady!: () => void;
    const ready = new Promise<void>((res) => { signalReady = res; });
    const flow = this.run(id, input, branch, worktreePath, signalReady);
    this.flows.add(flow); // synchronous registration — so shutdown drain (waitAllSettled) waits even for in-flight spawns
    this.flowById.set(id, flow);
    void flow.finally(() => { this.flows.delete(flow); this.flowById.delete(id); this.cancelledSpawns.delete(id); });
    return ready.then(() => ({ id })); // {id} after worktree provisioning completes
  }

  // Fork a worker: copy its SDK conversation into a new branch + duplicate its full worktree state (committed history via a
  // branch off the source's HEAD, plus uncommitted/untracked via checkpoint→restore) + copy its transcript. The fork is
  // registered as a lazy-resumable entry (resumes the forked SDK session in its own worktree on first send). Source untouched.
  async fork(id: string): Promise<{ id: string }> {
    const src = this.deps.repos.getWorker(id);
    if (!src) throw new Error(`Unknown worker: ${id}`);
    // A restore in flight is mid-checkout on the source worktree — checkpointing it now would snapshot a half-rewritten
    // tree into the fork (silent corruption). Reject before any git work; retry once the restore finishes.
    if (this.restoring.has(id)) throw new Error(`worker ${id} is mid-restore; retry when the restore finishes`);
    if (!src.sdk_session_id) throw new Error("this worker has no SDK session yet — nothing to fork");
    if (!src.worktree_path || !this.exists(src.worktree_path)) throw new Error("this worker's worktree is gone — cannot fork");
    if (!this.deps.forkSession) throw new Error("worker forking is not available");
    const newId = this.idgen();
    const branch = `rookery/${newId}`;
    const worktreePath = path.join(this.deps.worktreesDir, newId);
    const label = `${src.label} (fork)`;
    const provider = src.provider ?? "claude";
    const { sessionId: forkedUuid } = await this.deps.forkSession(provider, src.sdk_session_id, { title: label });
    // Snapshot the source worktree's full state (tracked + untracked) → overlay it onto the fork so uncommitted work carries over.
    let snapSha: string | null = null;
    try { snapSha = await this.deps.git.checkpoint(src.worktree_path, `refs/rookery/fork/${newId}`); } catch { snapSha = null; }
    // From here the snapshot ref is already pinned in the shared .git — the try must start BEFORE addWorktree so a
    // worktree-add throw also reaches the cleanup (the worker row never exists, so nothing else could ever reclaim it).
    try {
      // New worktree branched from the source's branch HEAD (carries its committed history), then overlay the snapshot.
      await this.deps.git.addWorktree(src.repo_path, worktreePath, branch, src.branch ?? src.base ?? "HEAD");
      if (snapSha) { try { await this.deps.git.restoreCheckpoint(worktreePath, snapSha); } catch { /* best-effort: committed state still present */ } }
      // Persist the new worker (diff base = the source's base, so the fork's diff shows the same body of work).
      // The fork inherits the source's provider — a codex worker's fork must also run on codex.
      this.deps.repos.createWorker({ id: newId, sessionId: src.session_id, repoPath: src.repo_path, label, worktreePath, branch, base: src.base ?? undefined, provider });
      this.deps.repos.setWorkerSdkSessionId(newId, forkedUuid);
      if (src.model) this.deps.repos.setWorkerModel(newId, src.model);
      if (src.permission_mode) this.deps.repos.setWorkerPermissionMode(newId, src.permission_mode);
      if (src.max_turns != null) this.deps.repos.setWorkerMaxTurns(newId, src.max_turns);
      if (src.cost_budget_usd != null) this.deps.repos.setWorkerCostBudgetUsd(newId, src.cost_budget_usd);
      if (src.effort) this.deps.repos.setWorkerEffort(newId, src.effort);
      this.deps.repos.copyWorkerEvents(id, newId);
      // Register a lazy-resumable entry (like rehydrate) → idle; materializes (resumes the forked SDK session) on first send.
      this.deps.repos.setWorkerStatus(newId, "idle", true);
      this.entries.set(newId, {
        homeSessionId: src.session_id, repoPath: src.repo_path, worktreePath, branch, base: src.base ?? "",
        status: "idle", label, model: src.model ?? undefined, permissionMode: src.permission_mode ?? undefined,
        maxTurns: src.max_turns ?? undefined, costBudgetUsd: src.cost_budget_usd ?? undefined, effort: src.effort ?? undefined, provider,
        resumeSessionId: forkedUuid,
      });
      this.deps.bus.emit({ type: "worker.spawned", sessionId: src.session_id, workerId: newId, repoPath: src.repo_path, label, branch, status: "idle", ticketKey: null, ticketUrl: null });
      return { id: newId };
    } catch (err) {
      // The fork's snapshot-ref (and possibly its worktree/branch) were already created — reclaim them, or they
      // leak with no row to ever find them again (the same pre-entry class audit #12 closed for spawn()).
      // removeWorktree is harmless if addWorktree itself threw: RealGitOps ignores not-a-working-tree errors.
      try { await this.deps.git.removeWorktree(src.repo_path, worktreePath, branch); } catch { /* best-effort */ }
      try { await this.deps.git.removeCheckpointRefs(src.repo_path, newId); } catch { /* best-effort */ }
      throw err;
    }
  }

  private async run(
    id: string,
    input: { homeSessionId: string; repoPath: string; label: string; task?: string; base?: string; model?: string; effort?: string; permissionMode?: string; ticketKey?: string; ticketUrl?: string; notify?: boolean; maxTurns?: number; costBudgetUsd?: number; provider?: string },
    branch: string,
    worktreePath: string,
    signalReady: () => void,
  ): Promise<void> {
    const { repos, bus, git, factory } = this.deps;
    try {
      // persist the workers row first: even if base resolution/addWorktree fails, status/events can be safely
      // recorded in catch without an FK violation. (the base column uses the unresolved input value)
      // These provisioning statements (createWorker / notify-arm / maxTurns+costBudget+effort persists / the spawned emit) are INSIDE
      // the try on purpose — load-bearing for audit #25: createWorker itself can throw (an FK on a concurrently-deleted home
      // session, SQLITE_FULL). If it did outside the try, the catch's signalReady() would be skipped and spawn()'s returned
      // promise would never settle (a wedged master turn), while the rejected flow escaped as an unhandledRejection.
      repos.createWorker({
        id,
        sessionId: input.homeSessionId,
        repoPath: input.repoPath,
        label: input.label,
        worktreePath,
        branch,
        base: input.base,
        ticketKey: input.ticketKey,
        ticketUrl: input.ticketUrl,
        provider: input.provider,
      });
      if (input.notify) this.deps.repos.setWorkerNotifyArmed(id, true);
      if (input.maxTurns != null) repos.setWorkerMaxTurns(id, input.maxTurns);
      if (input.costBudgetUsd != null) repos.setWorkerCostBudgetUsd(id, input.costBudgetUsd);
      if (input.effort) repos.setWorkerEffort(id, input.effort);
      // Surface the worker to clients IMMEDIATELY as "provisioning" — before base-resolve / `git worktree add`, which for a large
      // repo takes seconds. Without this the row (and all feedback) only appears once the worktree finishes, so spawn looks hung.
      // The agent's boot below reconciles it to running/idle; a failed worktree-create flips it to failed via the catch.
      bus.emit({ type: "worker.spawned", sessionId: input.homeSessionId, workerId: id, repoPath: input.repoPath, label: input.label, task: input.task, branch, status: "provisioning", ticketKey: input.ticketKey ?? null, ticketUrl: input.ticketUrl ?? null });
      // launch: resolve base → addWorktree → factory(cwd=worktree) → start → reconcile status.
      // base resolution: explicit choice > remote default branch (refreshed via best-effort fetch) > current HEAD (fallback).
      let baseStale = false; // a best-effort fetch failed → branched from a possibly-stale ref (surfaced as a worker notice after boot)
      let base: string;
      if (input.base) {
        base = input.base;
      } else {
        const remoteDefault = await git.remoteDefaultBranch(input.repoPath); // "origin/main" | null
        if (remoteDefault) {
          const fetched = await git.fetch(input.repoPath, remoteDefault.replace(/^origin\//, "")).then(() => true, () => false); // best-effort refresh
          if (!fetched) baseStale = true;
          base = remoteDefault;
        } else {
          base = await git.currentBranch(input.repoPath); // fallback (current)
        }
      }
      repos.setWorkerBase(id, base); // persist the resolved base → after restart, rehydrate can diff against the correct base
      if (this.cancelledSpawns.has(id)) { signalReady(); return; } // cancelled before the worktree existed — nothing to clean
      await git.addWorktree(input.repoPath, worktreePath, branch, base);
      if (this.cancelledSpawns.has(id)) {
        // Cancelled while the worktree was being created: remove it and bail WITHOUT registering an entry or
        // starting the agent. The discard/delete that cancelled us proceeds once this flow settles.
        try { await git.removeWorktree(input.repoPath, worktreePath, branch); } catch { /* best-effort */ }
        signalReady();
        return;
      }
      signalReady(); // worktree provisioned → spawn() can return (the rest of boot continues)
      const agent = factory({ id, sessionId: input.homeSessionId, repoPath: worktreePath, label: input.label, sdkSessionId: null, model: input.model, effort: input.effort, permissionMode: input.permissionMode, onTurnStart: () => this.checkpoint(id), maxTurns: input.maxTurns, costBudgetUsd: input.costBudgetUsd, provider: input.provider });
      const entry: Entry = {
        agent,
        homeSessionId: input.homeSessionId,
        repoPath: input.repoPath,
        worktreePath,
        branch,
        base,
        status: "provisioning", // reconciled to running/idle right after start() below (a real transition that emits worker.status)
        permissionMode: input.permissionMode, // remember so a later resume (materialize) restores the same mode
        maxTurns: input.maxTurns, // remember so a later resume (materialize) restores the runaway guard
        costBudgetUsd: input.costBudgetUsd, // remember so a later resume (materialize) restores the cost-budget runaway guard
        effort: input.effort, // remember so a later resume (materialize) restores the effort override
        provider: input.provider, // remember so a later resume (materialize) restores the same backend
        pendingLabel: !input.task, // task-less spawn: relabel from the first send() message instead
      };
      this.entries.set(id, entry);
      agent.start(input.task);
      // worktree + agent are up → leave "provisioning". A task-less worker is already idle (the Worker emitted it on start);
      // a task worker is born 'running' and won't emit it itself, so reflect its current status explicitly. Because the entry
      // is still "provisioning" this is a real transition (no dedup) → persists + emits worker.status, clearing the spinner.
      this.setStatus(id, agent.status());
      // best-effort `git fetch` failed → we branched from a possibly-stale ref. Surface it (instead of silently swallowing) so
      // the user knows the worker's diff/PR may be against older code. Fires after start() so it lands after the task echo (no seq collision).
      if (baseStale) agent.notice?.(`Base refresh (git fetch) failed — branched from possibly-stale ${base}, so diffs may be against older code.`);

      // spawn already came up with a placeholder label → asynchronously generate a better label and update (best-effort, never throws).
      // task-less spawn defers relabeling to the first send() (pendingLabel=true) — no task text to summarize yet.
      if (input.task) await this.relabel(id, input.homeSessionId, input.task);

      // if this agent was just launched during a shutdown drain, stop it immediately → this flow settles so close()
      // waits to the end (including setStatus below) before db.close(). Otherwise a post-close DB write races (G-SHUTDOWN-RACE).
      if (this.closing) await agent.stop();

      // control-plane model: after spawn, the orchestrator only manages the agent's lifecycle.
      // commit/push/PR is done by the worker directly (via bash in its own worktree) — the master directs it via send_worker.
      // waitUntilSettled only resolves when the agent terminates (stopped/done/error) (not on idle). So while alive,
      // this flow stays in flows and the shutdown drain waits; when it terminates it drops out of flows.
      await agent.waitUntilSettled();
      // Settle as the worker's own terminal status (see trackFlow): a runtime error stays 'error' — no remap to 'failed'.
      this.setStatus(id, agent.status());
    } catch (err) {
      signalReady(); // so spawn() doesn't hang even if provisioning (base/worktree) fails (one-shot, duplicate calls are harmless)
      const entry = this.entries.get(id);
      if (entry) entry.status = "failed";
      try { repos.setWorkerStatus(id, "failed"); } catch { /* ignore */ }
      try {
        const seq = repos.nextWorkerSeq(id);
        const data = { kind: "error" as const, message: String(err) };
        repos.addWorkerEvent({ workerId: id, seq, type: "error", payloadJson: JSON.stringify(data) });
        // Persist+emit as a pair (like Worker.record): without the emit, a client watching the provisioning
        // worker saw the failed badge over an empty transcript until a manual history refetch (audit #27).
        bus.emit({ type: "worker.event", sessionId: input.homeSessionId, workerId: id, seq, data });
      } catch { /* ignore */ }
      // Gate the terminal emit on the row existing: a createWorker-origin failure has no row and was never announced
      // (no worker.spawned) — emitting worker.status here would materialize a phantom fleet row in clients (the desktop
      // reducer's ?? fallback). A provisioning failure (addWorktree throws) has a row + spawned emit, so it still fires.
      if (repos.getWorker(id)) bus.emit({ type: "worker.status", sessionId: input.homeSessionId, workerId: id, status: "failed" });
    }
  }

  // automatic label generation: if a labeler exists, call it to update the placeholder. Never throws (protects spawn).
  private async relabel(id: string, homeSessionId: string, task: string): Promise<void> {
    const fn = this.deps.summarizeLabel;
    if (!fn) return;
    try {
      const label = await fn(task);
      if (!label) return; // null/empty → keep the placeholder
      const e = this.entries.get(id);
      if (!e || FleetOrchestrator.isTerminal(e.status)) return; // already terminal (stopped/failed/error/done/orphaned) → a slow relabel must not label a dead worker
      e.label = label; // so a future resume (materialize) uses the better label
      this.deps.repos.setWorkerLabel(id, label);
      this.deps.bus.emit({ type: "worker.label", sessionId: homeSessionId, workerId: id, label });
    } catch {
      /* best-effort: on failure, keep the placeholder */
    }
  }

  private static isTerminal(s: string): boolean {
    return s === "stopped" || s === "done" || s === "failed" || s === "error" || s === "orphaned";
  }

  // force: user termination (stop/discard) is true — guarantees 'stopped' even if already terminal (e.g. done) (FL-4).
  // automatic settle (run/trackFlow) is false — does not overwrite an already-terminated entry (prevents a race flipping the terminal value).
  private setStatus(id: string, status: string, force = false): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.status === status) return; // ignore re-recording the same status → prevents duplicate worker.status emits (core of the A3 race)
    if (!force && FleetOrchestrator.isTerminal(entry.status)) return; // write-once: automatic settle can't overwrite a terminal state
    // On a terminal settle the Worker has usually already written this exact status to the DB AND emitted worker.status
    // (Worker.transition does both). If the DB row already holds it, our entry merely lagged — do the entry/DB bookkeeping
    // but SKIP the duplicate bus emit (otherwise a runtime error surfaces worker.status:"error" twice). Read the row before the write.
    const alreadyEmitted = FleetOrchestrator.isTerminal(status) && this.deps.repos.getWorker(id)?.status === status;
    entry.status = status;
    // on reaching a terminal state, drop the live agent reference so the Worker (query loop/transcript buffer) can be GC'd (FL-3).
    // metadata (worktreePath/branch/base) is kept so diff/discard keep working. Live (running/idle) is held by the Worker.
    if (FleetOrchestrator.isTerminal(status)) entry.agent = undefined;
    this.deps.repos.setWorkerStatus(id, status, force); // force (user stop/discard) bypasses the DB write-once too

    if (!alreadyEmitted) this.deps.bus.emit({ type: "worker.status", sessionId: entry.homeSessionId, workerId: id, status });
  }

  // Terminal write for a worker that never got an entry (cancelled mid-provisioning). force: user-initiated.
  private setStatusRowOnly(id: string, status: string): void {
    try { this.deps.repos.setWorkerStatus(id, status, true); } catch { /* row may already be deleted */ }
    const row = this.deps.repos.getWorker(id);
    this.deps.bus.emit({ type: "worker.status", sessionId: row?.session_id ?? "", workerId: id, status });
  }

  // Arm a one-shot "notify the home master when this worker next settles" (used by send_worker with notify:true).
  armNotify(id: string): void {
    this.deps.repos.setWorkerNotifyArmed(id, true);
  }

  private require(id: string): Entry {
    const e = this.entries.get(id);
    if (!e) throw new Error(`Unknown worker: ${id}`);
    return e;
  }

  // for operations like send/await that absolutely require a live agent. If the entry is resumable (lazy), materialize it here.
  // if still absent (orphaned/detached), reject explicitly.
  private requireLive(id: string): Entry & { agent: WorkerLike } {
    const e = this.require(id);
    // don't materialize during a shutdown drain — prevents a race where resume→consume writes to a closed DB (A2).
    // don't materialize a TERMINAL entry (e.g. a user-stopped lazy/rehydrated worker still holding resumeSessionId) —
    // otherwise send would silently resurrect it under bypassPermissions while the DB/list still show it stopped (split-brain).
    if (!e.agent && e.resumeSessionId && !this.closing && !FleetOrchestrator.isTerminal(e.status)) this.materialize(id, e);
    if (!e.agent) throw new Error(`Worker ${id} is not running (its session ended, likely a daemon restart).`);
    return e as Entry & { agent: WorkerLike };
  }

  send(id: string, message: string, clientMsgId?: string): void {
    // A restore is rewriting this worktree (git checkout). Starting a turn now would interleave SDK edits with
    // the checkout AND take a checkpoint of the half-rewritten tree. Reject; the caller retries after it ends.
    if (this.restoring.has(id)) throw new Error(`worker ${id} is mid-restore; retry when the restore finishes`);
    const entry = this.requireLive(id);
    if (entry.pendingLabel) {
      entry.pendingLabel = false;
      void this.relabel(id, entry.homeSessionId, message); // task-less worker: relabel from the first message (best-effort, never throws)
    }
    entry.agent.send(message, clientMsgId);
  }

  // abort only the current turn (keep the session) — parity with master turn-abort. Requires a live agent.
  async interrupt(id: string): Promise<void> {
    await this.requireLive(id).agent.interruptTurn?.();
  }

  // called right before a turn starts (onTurnStart) — snapshot the whole worktree to a hidden ref and persist by seq. best-effort,
  // never throws (must not block the turn). seq = the number of checkpoints so far.
  private checkpoint(id: string): void {
    if (this.closing) return; // during a shutdown drain, don't start new checkpoints (prevents writes to a closed DB)
    const e = this.entries.get(id);
    if (!e) return;
    // serialize on the per-worker chain — seq is assigned atomically after prev finishes, so no duplicate seqs arise.
    const prev = this.ckptChains.get(id) ?? Promise.resolve();
    const next = prev.then(async () => {
      if (this.closing) return;
      try {
        const seq = this.deps.repos.nextCheckpointSeq(id);
        const sha = await this.deps.git.checkpoint(e.worktreePath, `refs/rookery/ckpt/${id}/${seq}`);
        if (sha && !this.closing) this.deps.repos.addCheckpoint({ workerId: id, seq, sha });
        else if (!sha && !this.closing) this.warnCheckpoint(id, e); // produced no ref (silent miss) → tell the user a restore point is missing
      } catch {
        if (!this.closing) this.warnCheckpoint(id, e); // checkpoint threw → likewise surface it instead of swallowing
      }
    });
    this.ckptChains.set(id, next);
    this.checkpointWrites.add(next);
    void next.finally(() => {
      this.checkpointWrites.delete(next);
      if (this.ckptChains.get(id) === next) this.ckptChains.delete(id); // if the chain is idle, clean up the map (prevents a leak)
    });
  }

  // Tell the user (once) that checkpointing failed for this worker — otherwise they assume every turn has a restore point and
  // only discover the gap when a rollback isn't there. best-effort; never throws (called from the checkpoint chain).
  private warnCheckpoint(id: string, e: Entry): void {
    if (this.ckptWarned.has(id)) return;
    this.ckptWarned.add(id);
    try { e.agent?.notice?.("Checkpoint failed this turn — no restore point was recorded (rollback won't include it)."); } catch { /* best-effort */ }
  }

  // restore the worktree's tracked files to that checkpoint (seq). Ignore a nonexistent seq.
  async restore(id: string, seq: number): Promise<void> {
    // Another restore is already rewriting this worktree — two concurrent checkouts would interleave. Reject; retry after it finishes.
    if (this.restoring.has(id)) throw new Error(`worker ${id} is mid-restore; retry when the restore finishes`);
    const e = this.entries.get(id);
    if (!e) throw new Error(`Unknown worker: ${id}`);
    // if running, the worker's SDK is concurrently editing the same worktree → restore collides and produces a half-overwritten state.
    if (e.agent && e.agent.status() === "running") {
      throw new Error(`worker ${id} is running; stop it or wait until idle before restoring`);
    }
    const ck = this.deps.repos.listCheckpoints(id).find((c) => c.seq === seq);
    if (!ck) throw new Error(`No checkpoint seq ${seq} for ${id}`);
    // Hold the send-gate for the whole checkout: the running-check above is a point-in-time check, and a send
    // landing during the await would start a turn against a half-rewritten worktree (TOCTOU).
    this.restoring.add(id);
    try {
      await this.deps.git.restoreCheckpoint(e.worktreePath, ck.sha);
    } finally {
      this.restoring.delete(id);
    }
  }

  // change a running worker's model live. If alive, query.setModel; otherwise just persist the model (applied on next resume).
  async setModel(id: string, model: string): Promise<void> {
    const e = this.entries.get(id);
    if (e?.agent?.setModel) {
      await e.agent.setModel(model); // the Worker handles query.setModel + persistence
      return;
    }
    if (e) e.model = model;
    this.deps.repos.setWorkerModel(id, model);
  }

  // change a running worker's permission mode live. If alive, query.setPermissionMode; otherwise just persist (applied on next resume).
  async setPermissionMode(id: string, mode: string): Promise<void> {
    const e = this.entries.get(id);
    if (e?.agent?.setPermissionMode) { await e.agent.setPermissionMode(mode); if (e) e.permissionMode = mode; return; }
    if (e) e.permissionMode = mode;
    this.deps.repos.setWorkerPermissionMode(id, mode);
  }

  // list of a live worker's slash commands/skills. If detached/orphaned (no agent), [] → the caller falls back to cwd.
  async listCommands(id: string): Promise<SlashCommandInfo[]> {
    const e = this.entries.get(id);
    try {
      return (await e?.agent?.listCommands?.()) ?? [];
    } catch {
      return [];
    }
  }

  status(id: string): string {
    const e = this.entries.get(id);
    if (e) {
      // while alive (running/idle), the agent's real-time status is the truth. When terminated/restored (detached),
      // the status the orchestrator recorded (orphaned, provisioning-'failed', etc.) is canonical.
      if (e.agent) {
        const live = e.agent.status();
        if (live === "running" || live === "idle") return live;
      }
      return e.status;
    }
    return this.deps.repos.getWorker(id)?.status ?? "unknown";
  }

  async stop(id: string): Promise<void> {
    const e = this.require(id);
    if (e.agent) await e.agent.stop(); // if detached/pending there's no process to kill — just clean up the status.
    e.resumeSessionId = undefined; // a user stop is final: drop the lazy-resume ticket so a later send can't resurrect it
    this.setStatus(id, "stopped", true); // user termination — takes precedence over automatic settle (FL-4)
  }

  transcript(id: string, sinceSeq?: number): Array<{ seq: number; type: string; payload: unknown; createdAt: string }> {
    return this.deps.repos.listWorkerEvents(id, sinceSeq).map((ev) => {
      let payload: unknown;
      try {
        payload = JSON.parse(ev.payload_json);
      } catch {
        payload = { kind: "corrupt", raw: ev.payload_json }; // so one corrupt row doesn't break the whole transcript request (DPP-2)
      }
      return { seq: ev.seq, type: ev.type, payload, createdAt: ev.created_at }; // createdAt: for the message hover timestamp
    });
  }

  async diff(id: string): Promise<string> {
    const e = this.require(id);
    // sending a large diff (up to the 32MB git maxBuffer) directly as a single WS frame blows up heap/frame size → byte cap (git-diff-no-chunking).
    return truncateBytes(await this.deps.git.diff(e.worktreePath, e.base), DIFF_MAX_BYTES);
  }

  async discard(id: string): Promise<void> {
    // A provisioning spawn has no entry yet (entries.set happens after the worktree+factory). Cancel it
    // cooperatively and wait for the flow to clean up after itself; then there is nothing left to discard.
    const inflight = this.flowById.get(id);
    if (inflight && !this.entries.has(id)) {
      this.cancelledSpawns.add(id);
      await inflight.catch(() => {});
      if (!this.entries.has(id)) { this.setStatusRowOnly(id, "stopped"); return; }
    }
    const e = this.require(id);
    if (e.agent) {
      try {
        await e.agent.stop();
      } catch {
        /* ignore */
      }
    }
    e.resumeSessionId = undefined; // discard is final: drop the lazy-resume ticket (the worktree is gone anyway)
    // clean up checkpoint hidden refs (prevents ref/dangling-object buildup in the parent .git) — best-effort, independent of worktree removal.
    try { await this.deps.git.removeCheckpointRefs(e.repoPath, id); } catch { /* best-effort */ }
    try {
      await this.deps.git.removeWorktree(e.repoPath, e.worktreePath, e.branch);
    } finally {
      this.setStatus(id, "stopped", true); // status always settles even if removeWorktree throws (FL-4) — the error propagates after finally
    }
  }

  // archive/unarchive: toggle archived_at (persist). The live entry is left as-is — fleet.list carries the archived flag so the UI splits tree/archive.
  archive(id: string, archived: boolean): void {
    this.deps.repos.setWorkerArchived(id, archived);
  }

  // permanent delete: discard (remove worktree+branch) then also remove the DB row → disappears from the tree. Removes the row even if worktree removal fails.
  async delete(id: string): Promise<void> {
    try {
      await this.discard(id);
    } catch {
      /* worktree removal failed — best-effort, the row is removed below */
    }
    this.deps.repos.deleteWorker(id);
    this.entries.delete(id);
  }

  // daemon shutdown drain (G-SHUTDOWN-RACE): stop() live workers, and only after all in-flight flows
  // (including a spawn still launching) finish their DB writes does the caller call db.close(). Bounded
  // timeout so shutdown doesn't wait forever if a flow hangs.
  async close(timeoutMs = 5000): Promise<void> {
    this.closing = true;
    for (const e of this.entries.values()) {
      const live = e.agent?.status();
      // void: just trigger stop so each flow settles; the actual completion wait is handled by the drain below.
      if (e.agent && (live === "running" || live === "idle")) void e.agent.stop().catch(() => {});
    }
    // only after draining all worker flows + in-flight checkpoint writes does the caller call db.close().
    // (checkpoints aren't in flows so wait for them separately — otherwise addCheckpoint throws on a closed DB.)
    const drain = (async () => {
      await this.waitAllSettled();
      while (this.checkpointWrites.size > 0) await Promise.all([...this.checkpointWrites]);
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((res) => { timer = setTimeout(res, timeoutMs); });
    await Promise.race([drain, timeout]);
    if (timer) clearTimeout(timer);
  }

  list(filter?: { status?: string; repoPath?: string }): Array<{ id: string; label: string; repoPath: string; status: string; branch: string | null; model: string | null; permissionMode: string; provider: string; archived: boolean; ticketKey: string | null; ticketUrl: string | null; lastActivityTs?: number; costUsd?: number }> {
    const metrics = this.deps.repos.workerActivityAndCost(); // one indexed batched query for the whole fleet
    return this.deps.repos
      .listAllWorkers()
      .map((r) => ({
        id: r.id,
        label: r.label,
        repoPath: r.repo_path,
        // DB status is the most up-to-date (records both the Worker's running↔idle transitions and FleetOrchestrator's terminal states).
        status: r.status,
        branch: r.branch,
        model: r.model,
        permissionMode: r.permission_mode, // SDK permission mode (bypassPermissions | plan) — the worker composer's live selector reads this
        provider: r.provider, // which AgentBackend runs this worker ('claude' | 'codex')
        archived: !!r.archived_at, // archived or not — the UI splits into tree/archive
        ticketKey: r.ticket_key,
        ticketUrl: r.ticket_url,
        ...(metrics.get(r.id) ?? {}), // lastActivityTs / costUsd from worker_events (absent when the worker has neither)
      }))
      .filter((x) => (filter?.status ? x.status === filter.status : true))
      .filter((x) => (filter?.repoPath ? x.repoPath === filter.repoPath : true));
  }

  async waitAllSettled(): Promise<void> {
    while (this.flows.size > 0) await Promise.all([...this.flows]);
  }
}
