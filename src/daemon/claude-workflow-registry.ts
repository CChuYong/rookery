import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { ALL_CHANNEL, type EventBus } from "../core/events.js";
import {
  parseWorkflowAgentHistory,
  parseWorkflowAgentLine,
  parseWorkflowAgentMeta,
  parseWorkflowJournalLine,
  parseWorkflowRunState,
} from "../core/claude-workflow-transcript.js";
import type { WorkflowRunAgentMetadata } from "../core/claude-workflow-transcript.js";
import type {
  WorkflowActivityProvider,
  WorkflowActivitySink,
  WorkflowAgentHistoryEntry,
  WorkflowAgentSummary,
  WorkflowLaunch,
  WorkflowOwner,
  WorkflowPhaseSummary,
  WorkflowProgressMetadata,
  WorkflowRunSnapshot,
  WorkflowRunStatus,
  WorkflowRunSummary,
  WorkflowTaskUpdate,
} from "../core/workflow-activity.js";
import type { ClaudeWorkflowFiles, WorkflowDirectoryWatch } from "./claude-workflow-files.js";

interface RegistryDeps {
  files: ClaudeWorkflowFiles;
  bus: EventBus;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearInterval?: (timer: NodeJS.Timeout) => void;
  setTimeout?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeout?: (timer: NodeJS.Timeout) => void;
  readChunkBytes?: number;
}

interface AgentState extends WorkflowAgentSummary {
  filePath?: string;
  metaPath?: string;
  fileOffset: number;
  partial: string;
  decoder: StringDecoder;
}

interface RunState {
  owner: WorkflowOwner;
  taskId: string;
  toolUseId?: string;
  runId?: string;
  workflowName: string;
  summary: string;
  lastToolName?: string;
  status: WorkflowRunStatus;
  visibility: "live" | "summary-only";
  warning?: "limited-visibility" | "partial-data";
  startedAt: number;
  lastActivityAt: number;
  endedAt?: number;
  usage?: { totalTokens: number; toolUses: number; durationMs: number };
  phases: WorkflowPhaseSummary[];
  transcriptDir?: string;
  journalPath?: string;
  candidateDir?: string;
  sessionRoot?: string;
  workflowStateCandidate?: string;
  workflowStatePath?: string;
  workflowStateFingerprint?: string;
  agentMetadata: Map<string, WorkflowRunAgentMetadata>;
  agents: Map<string, AgentState>;
  pendingAgentIds: Set<string>;
  journalOffset: number;
  journalPartial: string;
  journalDecoder: StringDecoder;
  watch?: WorkflowDirectoryWatch;
  reconcileTimer?: NodeJS.Timeout;
  emitTimer?: NodeJS.Timeout;
  settling?: "completed" | "failed" | "stopped";
  deleted?: boolean;
  draining: Promise<void>;
}

const HISTORY_BYTES = 8 * 1_048_576;
const READ_CHUNK_BYTES = 256 * 1_024;
const MAX_PARTIAL_BYTES = 1_048_576;
const MAX_WORKFLOW_STATE_BYTES = 16 * 1_048_576;
const SAFE_PATH_ID = /^[A-Za-z0-9._-]{1,256}$/;

export class ClaudeWorkflowRegistry implements WorkflowActivitySink, WorkflowActivityProvider {
  private readonly now: () => number;
  private readonly every: (fn: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearEvery: (timer: NodeJS.Timeout) => void;
  private readonly later: (fn: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearLater: (timer: NodeJS.Timeout) => void;
  private readonly readChunkBytes: number;
  private readonly unsubscribeDeletion: () => void;
  private readonly byWorker = new Map<string, Map<string, RunState>>();

  constructor(private readonly deps: RegistryDeps) {
    this.now = deps.now ?? Date.now;
    this.every = deps.setInterval ?? setInterval;
    this.clearEvery = deps.clearInterval ?? clearInterval;
    this.later = deps.setTimeout ?? setTimeout;
    this.clearLater = deps.clearTimeout ?? clearTimeout;
    this.readChunkBytes = deps.readChunkBytes ?? READ_CHUNK_BYTES;
    this.unsubscribeDeletion = deps.bus.subscribe(ALL_CHANNEL, (event) => {
      if (event.type === "worker.deletion" && event.phase === "completed") this.deleteWorker(event.workerId);
    });
  }

  private worker(workerId: string): Map<string, RunState> {
    const current = this.byWorker.get(workerId) ?? new Map<string, RunState>();
    this.byWorker.set(workerId, current);
    return current;
  }

  private run(owner: WorkflowOwner, taskId: string): RunState {
    const runs = this.worker(owner.workerId);
    const existing = runs.get(taskId);
    if (existing) return existing;
    const now = this.now();
    const created: RunState = {
      owner,
      taskId,
      workflowName: "Workflow",
      summary: "",
      status: "running",
      visibility: "summary-only",
      startedAt: now,
      lastActivityAt: now,
      phases: [],
      agents: new Map(),
      agentMetadata: new Map(),
      pendingAgentIds: new Set(),
      journalOffset: 0,
      journalPartial: "",
      journalDecoder: new StringDecoder("utf8"),
      draining: Promise.resolve(),
    };
    runs.set(taskId, created);
    return created;
  }

  launched(owner: WorkflowOwner, launch: WorkflowLaunch): void {
    const run = this.run(owner, launch.taskId);
    Object.assign(run, {
      owner,
      toolUseId: launch.toolUseId,
      runId: launch.runId,
      workflowName: launch.workflowName,
      summary: launch.summary,
      candidateDir: launch.transcriptDir,
      lastActivityAt: this.now(),
    });
    if (run.status !== "running" || run.settling) {
      this.emit(run);
      return;
    }
    run.draining = run.draining.then(() => this.startObservation(run, launch.transcriptDir)).catch(() => this.degrade(run));
    this.scheduleEmit(run);
  }

  taskUpdated(owner: WorkflowOwner, update: WorkflowTaskUpdate): void {
    const run = this.run(owner, update.taskId);
    run.owner = owner;
    if (update.workflowName) run.workflowName = update.workflowName;
    if (update.summary) run.summary = update.summary;
    else if (!run.summary && update.description) run.summary = update.description;
    if (update.lastToolName) run.lastToolName = update.lastToolName;
    if (update.usage) run.usage = update.usage;
    if (update.progress) this.mergeWorkflowMetadata(run, update.progress);
    run.lastActivityAt = this.now();
    if (update.phase === "settled") {
      if (run.settling) return;
      if (run.status !== "running") {
        this.emit(run);
        return;
      }
      const outcome = update.outcome ?? "stopped";
      run.settling = outcome;
      run.draining = run.draining.then(async () => {
        try { await this.drain(run, null); }
        catch { run.visibility = "summary-only"; run.warning = "limited-visibility"; }
        this.settle(run, outcome);
      });
      return;
    }
    this.scheduleEmit(run);
  }

  stopWorker(workerId: string): void {
    for (const run of this.byWorker.get(workerId)?.values() ?? []) {
      if (run.status === "running") this.taskUpdated(run.owner, { taskId: run.taskId, phase: "settled", outcome: "stopped" });
      else this.closeObservation(run);
    }
  }

  list(workerId: string): WorkflowRunSnapshot[] {
    return [...(this.byWorker.get(workerId)?.values() ?? [])].map((run) => this.snapshot(run)).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  async agentHistory(workerId: string, taskId: string, agentId: string): Promise<WorkflowAgentHistoryEntry[]> {
    const run = this.byWorker.get(workerId)?.get(taskId);
    if (!run?.transcriptDir || !run.agents.has(agentId)) throw new Error("unknown workflow agent");
    const file = await this.containedFile(run, `agent-${agentId}.jsonl`);
    const text = await this.deps.files.readText(file, HISTORY_BYTES);
    return parseWorkflowAgentHistory(text);
  }

  async close(): Promise<void> {
    this.unsubscribeDeletion();
    const runs = [...this.byWorker.values()].flatMap((workerRuns) => [...workerRuns.values()]);
    for (const run of runs) {
      if (run.status === "running" && !run.settling) this.taskUpdated(run.owner, { taskId: run.taskId, phase: "settled", outcome: "stopped" });
    }
    await Promise.allSettled(runs.map((run) => run.draining));
    for (const run of runs) this.closeObservation(run);
  }

  private deleteWorker(workerId: string): void {
    const runs = this.byWorker.get(workerId);
    if (!runs) return;
    for (const run of runs.values()) {
      run.deleted = true;
      this.closeObservation(run);
    }
    this.byWorker.delete(workerId);
  }

  async flushForTest(): Promise<void> {
    for (;;) {
      const before = [...this.byWorker.values()].flatMap((runs) => [...runs.values()].map((run) => run.draining));
      await Promise.all(before);
      const after = [...this.byWorker.values()].flatMap((runs) => [...runs.values()].map((run) => run.draining));
      if (after.length === before.length && after.every((promise, index) => promise === before[index])) break;
    }
    for (const runs of this.byWorker.values()) {
      for (const run of runs.values()) {
        if (!run.emitTimer) continue;
        this.clearLater(run.emitTimer);
        delete run.emitTimer;
        this.emit(run);
      }
    }
  }

  private async startObservation(run: RunState, supplied: string): Promise<void> {
    if (run.status !== "running" || !run.owner.sdkSessionId || !run.runId || !SAFE_PATH_ID.test(run.owner.sdkSessionId) || !SAFE_PATH_ID.test(run.runId)) return this.degrade(run);
    this.closeObservation(run);
    const real = await this.deps.files.realpath(supplied);
    const normalized = path.resolve(supplied);
    const parts = real.split(path.sep).filter(Boolean);
    const expected = [run.owner.sdkSessionId, "subagents", "workflows", run.runId];
    if (real !== normalized || expected.some((part, index) => parts.at(index - expected.length) !== part)) return this.degrade(run);
    const journal = path.join(real, "journal.jsonl");
    const journalReal = await this.deps.files.realpath(journal);
    if (journalReal !== journal || path.dirname(journalReal) !== real) return this.degrade(run);
    const stat = await this.deps.files.stat(journalReal);
    if (!stat.isFile) return this.degrade(run);
    run.transcriptDir = real;
    run.journalPath = journalReal;
    run.sessionRoot = path.dirname(path.dirname(path.dirname(real)));
    run.workflowStateCandidate = path.join(run.sessionRoot, "workflows", `${run.runId}.json`);
    run.visibility = "live";
    delete run.warning;
    this.emit(run);
    run.watch = this.deps.files.watchDirectory(real, (name) => this.queueDrain(run, name));
    run.reconcileTimer = this.every(() => this.queueDrain(run, null), 1_000);
    run.reconcileTimer.unref?.();
    await this.drain(run, null);
  }

  private degrade(run: RunState): void {
    this.closeObservation(run);
    run.visibility = "summary-only";
    run.warning = "limited-visibility";
    delete run.transcriptDir;
    delete run.journalPath;
    delete run.sessionRoot;
    delete run.workflowStateCandidate;
    delete run.workflowStatePath;
    delete run.workflowStateFingerprint;
    if (run.status === "running" && !run.settling && run.candidateDir) {
      run.reconcileTimer = this.every(() => {
        run.draining = run.draining.then(() => {
          if (run.status === "running" && run.visibility === "summary-only" && run.candidateDir) return this.startObservation(run, run.candidateDir);
        }).catch(() => this.degrade(run));
      }, 1_000);
      run.reconcileTimer.unref?.();
    }
    this.scheduleEmit(run);
  }

  private queueDrain(run: RunState, name: string | null): void {
    if (run.status !== "running" || !run.transcriptDir) return;
    run.draining = run.draining.then(() => this.drain(run, name)).catch(() => this.degrade(run));
  }

  private async drain(run: RunState, name: string | null): Promise<void> {
    if (run.status !== "running" || !run.transcriptDir) return;
    if (name === null) await this.drainWorkflowState(run);
    if (name === null || name === "journal.jsonl") await this.drainJournal(run);
    if (name?.startsWith("agent-") && name.endsWith(".jsonl")) {
      const agentId = name.slice("agent-".length, -".jsonl".length);
      if (run.agents.has(agentId)) await this.drainAgent(run, agentId);
    }
    if (name?.startsWith("agent-") && name.endsWith(".meta.json")) {
      const agentId = name.slice("agent-".length, -".meta.json".length);
      const agent = run.agents.get(agentId);
      if (agent) {
        await this.readMeta(run, agent);
        this.queueAgent(run, agent);
      }
    }
    if (name === null) {
      for (const agentId of run.agents.keys()) await this.drainAgent(run, agentId);
    }
  }

  private async drainJournal(run: RunState): Promise<void> {
    const file = run.journalPath!;
    const stat = await this.deps.files.stat(file);
    if (run.status !== "running") return;
    if (stat.size < run.journalOffset) {
      run.journalOffset = 0;
      run.journalPartial = "";
      run.journalDecoder = new StringDecoder("utf8");
    }
    if (stat.size === run.journalOffset) {
      await this.flushJournalTail(run);
      return;
    }
    const chunk = await this.deps.files.read(file, run.journalOffset, Math.min(this.readChunkBytes, stat.size - run.journalOffset));
    if (run.status !== "running") return;
    run.journalOffset += chunk.length;
    const text = run.journalPartial + run.journalDecoder.write(chunk);
    const lines = text.split(/\r?\n/);
    run.journalPartial = lines.pop() ?? "";
    if (Buffer.byteLength(run.journalPartial, "utf8") > MAX_PARTIAL_BYTES) {
      run.journalPartial = "";
      run.warning = "partial-data";
    }
    for (const line of lines) await this.consumeJournalLine(run, line);
    this.scheduleEmit(run);
    if (run.journalOffset < stat.size) await this.drainJournal(run);
    else await this.flushJournalTail(run);
  }

  private async flushJournalTail(run: RunState): Promise<void> {
    if (!run.settling) return;
    const line = run.journalPartial + run.journalDecoder.end();
    run.journalPartial = "";
    run.journalDecoder = new StringDecoder("utf8");
    if (!line) return;
    await this.consumeJournalLine(run, line);
    this.scheduleEmit(run);
  }

  private async consumeJournalLine(run: RunState, line: string): Promise<void> {
    const record = parseWorkflowJournalLine(line);
    if (!record) {
      if (line.trim()) run.warning = "partial-data";
      return;
    }
    const now = this.now();
    const existing = run.agents.get(record.agentId);
    if (record.type === "started" && !existing) {
      const agent: AgentState = { agentId: record.agentId, agentType: "workflow-subagent", spawnDepth: 1, status: "running", activity: "starting", toolUses: 0, startedAt: now, lastActivityAt: now, fileOffset: 0, partial: "", decoder: new StringDecoder("utf8") };
      run.agents.set(agent.agentId, agent);
      this.applyAgentMetadata(agent, run.agentMetadata.get(agent.agentId));
      await this.readMeta(run, agent);
      this.queueAgent(run, agent);
    } else if (record.type === "result") {
      const agent = existing ?? { agentId: record.agentId, agentType: "workflow-subagent", spawnDepth: 1, status: "running" as const, activity: "starting" as const, toolUses: 0, startedAt: now, lastActivityAt: now, fileOffset: 0, partial: "", decoder: new StringDecoder("utf8") };
      run.agents.set(agent.agentId, agent);
      this.applyAgentMetadata(agent, run.agentMetadata.get(agent.agentId));
      if (agent.status !== "completed") {
        Object.assign(agent, { status: "completed", activity: "complete", endedAt: now, lastActivityAt: now });
        this.queueAgent(run, agent);
      }
    }
    run.lastActivityAt = now;
  }

  private async readMeta(run: RunState, agent: AgentState): Promise<void> {
    try {
      agent.metaPath ??= await this.containedFile(run, `agent-${agent.agentId}.meta.json`);
      const text = await this.deps.files.readText(agent.metaPath, 16_384);
      Object.assign(agent, parseWorkflowAgentMeta(text));
    } catch {
      // The meta file may land after the journal record; provider-neutral defaults remain valid.
    }
  }

  private async drainWorkflowState(run: RunState): Promise<void> {
    if (!run.workflowStateCandidate || !run.sessionRoot) return;
    try {
      if (!run.workflowStatePath) {
        const real = await this.deps.files.realpath(run.workflowStateCandidate);
        const expectedDir = path.join(run.sessionRoot, "workflows");
        if (real !== run.workflowStateCandidate || path.dirname(real) !== expectedDir || path.dirname(path.dirname(real)) !== run.sessionRoot) return;
        run.workflowStatePath = real;
      }
      const stat = await this.deps.files.stat(run.workflowStatePath);
      if (!stat.isFile || stat.size <= 0 || stat.size > MAX_WORKFLOW_STATE_BYTES) return;
      const fingerprint = `${stat.size}:${stat.mtimeMs}`;
      if (fingerprint === run.workflowStateFingerprint) return;
      const chunks: Buffer[] = [];
      let offset = 0;
      while (offset < stat.size) {
        const chunk = await this.deps.files.read(run.workflowStatePath, offset, Math.min(this.readChunkBytes, stat.size - offset));
        if (chunk.length === 0) return;
        chunks.push(chunk);
        offset += chunk.length;
      }
      if (run.status !== "running") return;
      const metadata = parseWorkflowRunState(Buffer.concat(chunks).toString("utf8"));
      if (!metadata) return;
      run.workflowStateFingerprint = fingerprint;
      this.mergeWorkflowMetadata(run, metadata);
    } catch {
      // The provider writes this optional sibling snapshot independently. Missing/partial files retry on reconciliation.
    }
  }

  private mergeWorkflowMetadata(run: RunState, metadata: WorkflowProgressMetadata): void {
    const phases = new Map(run.phases.map((phase) => [phase.index, phase]));
    for (const phase of metadata.phases) {
      const current = phases.get(phase.index);
      phases.set(phase.index, {
        index: phase.index,
        title: phase.title,
        ...(phase.detail !== undefined ? { detail: phase.detail } : current?.detail !== undefined ? { detail: current.detail } : {}),
        ...(phase.model !== undefined ? { model: phase.model } : current?.model !== undefined ? { model: current.model } : {}),
      });
    }
    const nextPhases = [...phases.values()].sort((a, b) => a.index - b.index);
    const phasesChanged = JSON.stringify(run.phases) !== JSON.stringify(nextPhases);
    if (phasesChanged) run.phases = nextPhases;

    for (const incoming of metadata.agents) {
      const current = run.agentMetadata.get(incoming.agentId);
      run.agentMetadata.set(incoming.agentId, {
        agentId: incoming.agentId,
        ...(incoming.label !== undefined ? { label: incoming.label } : current?.label !== undefined ? { label: current.label } : {}),
        ...(incoming.phaseIndex !== undefined ? { phaseIndex: incoming.phaseIndex } : current?.phaseIndex !== undefined ? { phaseIndex: current.phaseIndex } : {}),
        ...(incoming.phaseTitle !== undefined ? { phaseTitle: incoming.phaseTitle } : current?.phaseTitle !== undefined ? { phaseTitle: current.phaseTitle } : {}),
        ...(incoming.model !== undefined ? { model: incoming.model } : current?.model !== undefined ? { model: current.model } : {}),
      });
    }

    let agentChanged = false;
    for (const agent of run.agents.values()) {
      if (!this.applyAgentMetadata(agent, run.agentMetadata.get(agent.agentId))) continue;
      this.queueAgent(run, agent);
      agentChanged = true;
    }
    if (phasesChanged || agentChanged) this.scheduleEmit(run);
  }

  private applyAgentMetadata(agent: AgentState, metadata: WorkflowRunAgentMetadata | undefined): boolean {
    if (!metadata) return false;
    let changed = false;
    for (const key of ["label", "phaseIndex", "phaseTitle", "model"] as const) {
      const value = metadata[key];
      if (value === undefined || agent[key] === value) continue;
      Object.assign(agent, { [key]: value });
      changed = true;
    }
    return changed;
  }

  private async drainAgent(run: RunState, agentId: string): Promise<void> {
    const agent = run.agents.get(agentId);
    if (!agent) return;
    let file: string;
    try {
      agent.filePath ??= await this.containedFile(run, `agent-${agentId}.jsonl`);
      file = agent.filePath;
    } catch { return; }
    let stat;
    try { stat = await this.deps.files.stat(file); } catch { return; }
    if (stat.size < agent.fileOffset) {
      agent.fileOffset = 0;
      agent.partial = "";
      agent.decoder = new StringDecoder("utf8");
      agent.toolUses = 0;
    }
    if (stat.size === agent.fileOffset) return;
    const chunk = await this.deps.files.read(file, agent.fileOffset, Math.min(this.readChunkBytes, stat.size - agent.fileOffset));
    if (run.status !== "running") return;
    agent.fileOffset += chunk.length;
    const lines = (agent.partial + agent.decoder.write(chunk)).split(/\r?\n/);
    agent.partial = lines.pop() ?? "";
    if (Buffer.byteLength(agent.partial, "utf8") > MAX_PARTIAL_BYTES) {
      agent.partial = "";
      run.warning = "partial-data";
    }
    let changed = false;
    for (const line of lines) {
      const delta = parseWorkflowAgentLine(line);
      if (!delta) continue;
      agent.activity = delta.activity;
      agent.startedAt = Math.min(agent.startedAt, delta.at);
      agent.lastActivityAt = Math.max(agent.lastActivityAt, delta.at);
      agent.toolUses += delta.toolUses;
      if (delta.agentType) agent.agentType = delta.agentType;
      if (delta.lastToolName) agent.lastToolName = delta.lastToolName;
      run.lastActivityAt = Math.max(run.lastActivityAt, delta.at);
      changed = true;
    }
    if (changed) this.queueAgent(run, agent);
    if (agent.fileOffset < stat.size) this.queueDrain(run, `agent-${agentId}.jsonl`);
  }

  private counts(run: RunState): WorkflowRunSnapshot["counts"] {
    const agents = [...run.agents.values()];
    return {
      started: agents.length,
      active: agents.filter((agent) => agent.status === "running").length,
      completed: agents.filter((agent) => agent.status === "completed").length,
      stopped: agents.filter((agent) => agent.status === "stopped").length,
    };
  }

  private async containedFile(run: RunState, name: string): Promise<string> {
    if (!run.transcriptDir || path.basename(name) !== name) throw new Error("invalid workflow file");
    const expected = path.join(run.transcriptDir, name);
    const real = await this.deps.files.realpath(expected);
    if (real !== expected || path.dirname(real) !== run.transcriptDir) throw new Error("workflow file escaped transcript directory");
    return real;
  }

  private settle(run: RunState, outcome: "completed" | "failed" | "stopped"): void {
    if (run.status !== "running") return;
    run.status = outcome;
    run.endedAt = this.now();
    delete run.settling;
    for (const agent of run.agents.values()) {
      if (agent.status !== "running") continue;
      Object.assign(agent, { status: "stopped", activity: "stopped", endedAt: run.endedAt, lastActivityAt: run.endedAt });
      this.queueAgent(run, agent);
    }
    run.lastActivityAt = Math.max(run.lastActivityAt, run.endedAt);
    this.closeObservation(run);
    this.emit(run);
  }

  private summary(run: RunState): WorkflowRunSummary {
    return {
      taskId: run.taskId,
      ...(run.toolUseId ? { toolUseId: run.toolUseId } : {}),
      ...(run.runId ? { runId: run.runId } : {}),
      workflowName: run.workflowName,
      summary: run.summary,
      ...(run.lastToolName ? { lastToolName: run.lastToolName } : {}),
      status: run.status,
      visibility: run.visibility,
      ...(run.warning ? { warning: run.warning } : {}),
      startedAt: run.startedAt,
      lastActivityAt: run.lastActivityAt,
      ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
      ...(run.usage ? { usage: run.usage } : {}),
      ...(run.phases.length > 0 ? { phases: run.phases.map((phase) => ({ ...phase })) } : {}),
      counts: this.counts(run),
    };
  }

  private snapshot(run: RunState): WorkflowRunSnapshot {
    return { ...this.summary(run), agents: [...run.agents.values()].map(({ filePath: _file, metaPath: _meta, fileOffset: _offset, partial: _partial, decoder: _decoder, ...agent }) => ({ ...agent })) };
  }

  private emit(run: RunState): void {
    if (run.emitTimer) {
      this.clearLater(run.emitTimer);
      delete run.emitTimer;
    }
    if (run.deleted) {
      run.pendingAgentIds.clear();
      return;
    }
    this.deps.bus.emit({ type: "worker.workflow.run", sessionId: run.owner.sessionId, workerId: run.owner.workerId, run: this.summary(run) });
    for (const agentId of run.pendingAgentIds) {
      const agent = run.agents.get(agentId);
      if (!agent) continue;
      const { filePath: _file, metaPath: _meta, fileOffset: _offset, partial: _partial, decoder: _decoder, ...view } = agent;
      this.deps.bus.emit({ type: "worker.workflow.agent", sessionId: run.owner.sessionId, workerId: run.owner.workerId, taskId: run.taskId, agent: { ...view } });
    }
    run.pendingAgentIds.clear();
  }

  private scheduleEmit(run: RunState): void {
    if (run.emitTimer) return;
    run.emitTimer = this.later(() => { delete run.emitTimer; this.emit(run); }, 250);
    run.emitTimer.unref?.();
  }

  private queueAgent(run: RunState, agent: AgentState): void {
    run.pendingAgentIds.add(agent.agentId);
    this.scheduleEmit(run);
  }

  private closeObservation(run: RunState): void {
    run.watch?.close();
    delete run.watch;
    if (run.reconcileTimer) this.clearEvery(run.reconcileTimer);
    delete run.reconcileTimer;
    if (run.emitTimer) this.clearLater(run.emitTimer);
    delete run.emitTimer;
  }
}
