import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../../src/core/events.js";
import { ClaudeWorkflowRegistry } from "../../src/daemon/claude-workflow-registry.js";
import type { ClaudeWorkflowFiles } from "../../src/daemon/claude-workflow-files.js";

class FakeWorkflowFiles implements ClaudeWorkflowFiles {
  readonly files = new Map<string, string>();
  readonly watchers = new Map<string, Set<(name: string | null) => void>>();
  realpath = async (file: string) => file;
  stat = async (file: string) => {
    const text = this.files.get(file);
    if (text === undefined) throw new Error("ENOENT");
    return { size: Buffer.byteLength(text), mtimeMs: Buffer.byteLength(text), isFile: true };
  };
  read = async (file: string, offset: number, length: number) => Buffer.from(this.files.get(file) ?? "").subarray(offset, offset + length);
  readText = async (file: string, maxBytes: number) => Buffer.from(this.files.get(file) ?? "").subarray(-maxBytes).toString("utf8");
  watchDirectory = (dir: string, onChange: (name: string | null) => void) => {
    const set = this.watchers.get(dir) ?? new Set();
    set.add(onChange);
    this.watchers.set(dir, set);
    return { close: () => { set.delete(onChange); } };
  };
  append(file: string, text: string): void {
    this.files.set(file, (this.files.get(file) ?? "") + text);
    const dir = file.slice(0, file.lastIndexOf("/"));
    for (const cb of this.watchers.get(dir) ?? []) cb(file.slice(file.lastIndexOf("/") + 1));
  }
}

const owner = { sessionId: "s1", workerId: "w1", sdkSessionId: "sdk-1" };
const dir = "/claude/sdk-1/subagents/workflows/wf-1";
const stateFile = "/claude/sdk-1/workflows/wf-1.json";
const launch = { taskId: "task-1", toolUseId: "tool-1", runId: "wf-1", workflowName: "audit", summary: "Audit", transcriptDir: dir };

describe("ClaudeWorkflowRegistry", () => {
  it("merges task-start-before-launch and emits one stable taskId run", async () => {
    const files = new FakeWorkflowFiles();
    files.files.set(`${dir}/journal.jsonl`, "");
    const bus = new EventBus();
    const runs: unknown[] = [];
    bus.subscribe("s1", (event) => { if (event.type === "worker.workflow.run") runs.push(event.run); });
    const registry = new ClaudeWorkflowRegistry({ files, bus, now: () => 100 });
    registry.taskUpdated(owner, { taskId: "task-1", phase: "started", workflowName: "audit", description: "Audit" });
    registry.launched(owner, launch);
    await registry.flushForTest();
    expect(registry.list("w1")).toEqual([expect.objectContaining({ taskId: "task-1", toolUseId: "tool-1", runId: "wf-1", status: "running", visibility: "live" })]);
    expect(runs.length).toBeGreaterThan(0);
    await registry.close();
  });

  it("tails journal and agent files into exact counts and activity", async () => {
    const files = new FakeWorkflowFiles();
    files.files.set(`${dir}/journal.jsonl`, "");
    const registry = new ClaudeWorkflowRegistry({ files, bus: new EventBus(), now: () => 1_000 });
    registry.launched(owner, launch);
    await registry.flushForTest();
    files.files.set(`${dir}/agent-a1.meta.json`, '{"agentType":"workflow-subagent","spawnDepth":1}');
    files.append(`${dir}/journal.jsonl`, '{"type":"started","agentId":"a1","key":"k1"}\n{"type":"started","agentId":"a2","key":"k2"}\n');
    files.append(`${dir}/agent-a1.jsonl`, '{"timestamp":"2026-07-16T00:00:00.000Z","type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{}}]}}\n');
    await registry.flushForTest();
    expect(registry.list("w1")[0]).toMatchObject({ counts: { started: 2, active: 2, completed: 0, stopped: 0 } });
    expect(registry.list("w1")[0]?.agents.find((agent) => agent.agentId === "a1")).toMatchObject({ lastToolName: "Read", toolUses: 1 });
    files.append(`${dir}/journal.jsonl`, '{"type":"result","agentId":"a1","key":"k1","result":{}}\n');
    await registry.flushForTest();
    expect(registry.list("w1")[0]).toMatchObject({ counts: { started: 2, active: 1, completed: 1, stopped: 0 } });
    await registry.close();
  });

  it("groups agents from live task progress before the run snapshot exists", async () => {
    const files = new FakeWorkflowFiles();
    files.files.set(`${dir}/journal.jsonl`, '{"type":"started","agentId":"a1","key":"k1"}\n');
    const registry = new ClaudeWorkflowRegistry({ files, bus: new EventBus(), now: () => 1_250 });
    registry.taskUpdated(owner, {
      taskId: "task-1",
      phase: "progress",
      progress: {
        phases: [
          { index: 1, title: "Recon" },
          { index: 2, title: "Judge" },
        ],
        agents: [
          { agentId: "a1", label: "code:core", phaseIndex: 1, phaseTitle: "Recon", model: "claude-opus-4-8" },
        ],
      },
    });

    expect(registry.list("w1")[0]).toMatchObject({
      phases: [
        { index: 1, title: "Recon" },
        { index: 2, title: "Judge" },
      ],
      counts: { started: 0, active: 0, completed: 0, stopped: 0 },
    });

    registry.launched(owner, launch);
    await registry.flushForTest();
    expect(registry.list("w1")[0]?.agents).toEqual([
      expect.objectContaining({ agentId: "a1", label: "code:core", phaseIndex: 1, phaseTitle: "Recon", model: "claude-opus-4-8" }),
    ]);
    expect(files.files.has(stateFile)).toBe(false);
    await registry.close();
  });

  it("merges exact phase, label, and model metadata from the bounded run snapshot", async () => {
    const files = new FakeWorkflowFiles();
    files.files.set(`${dir}/journal.jsonl`, '{"type":"started","agentId":"a1","key":"k1"}\n');
    files.files.set(stateFile, JSON.stringify({
      phases: [
        { title: "Recon", detail: "Inspect code", model: "opus" },
        { title: "Judge" },
      ],
      workflowProgress: [
        { type: "workflow_phase", index: 1, title: "Recon" },
        { type: "workflow_phase", index: 2, title: "Judge" },
        { type: "workflow_agent", agentId: "a1", label: "code:core", phaseIndex: 1, phaseTitle: "Recon", model: "claude-opus-4-8", state: "progress", promptPreview: "secret" },
      ],
      script: "secret",
      result: { secret: true },
    }));
    const registry = new ClaudeWorkflowRegistry({ files, bus: new EventBus(), now: () => 1_500 });
    registry.launched(owner, launch);
    await registry.flushForTest();
    const run = registry.list("w1")[0]!;
    expect(run.phases).toEqual([
      { index: 1, title: "Recon", detail: "Inspect code", model: "opus" },
      { index: 2, title: "Judge" },
    ]);
    expect(run.agents).toEqual([expect.objectContaining({ agentId: "a1", label: "code:core", phaseIndex: 1, phaseTitle: "Recon", model: "claude-opus-4-8" })]);
    expect(JSON.stringify(run)).not.toContain("secret");

    registry.taskUpdated(owner, {
      taskId: "task-1",
      phase: "progress",
      progress: { phases: [{ index: 1, title: "Recon live" }], agents: [] },
    });
    await registry.flushForTest();
    expect(registry.list("w1")[0]?.phases?.[0]).toEqual({ index: 1, title: "Recon live", detail: "Inspect code", model: "opus" });
    await registry.close();
  });

  it("keeps journal observation live when the optional run snapshot escapes containment", async () => {
    const files = new FakeWorkflowFiles();
    files.files.set(`${dir}/journal.jsonl`, '{"type":"started","agentId":"a1","key":"k1"}\n');
    files.files.set(stateFile, JSON.stringify({ phases: [{ title: "Recon" }] }));
    files.realpath = vi.fn(async (file) => file === stateFile ? "/outside/wf-1.json" : file);
    const registry = new ClaudeWorkflowRegistry({ files, bus: new EventBus(), now: () => 1_600 });
    registry.launched(owner, launch);
    await registry.flushForTest();
    const run = registry.list("w1")[0]!;
    expect(run).toMatchObject({ visibility: "live", counts: { started: 1, active: 1, completed: 0, stopped: 0 } });
    expect(run.phases).toBeUndefined();
    expect(JSON.stringify(run)).not.toContain("/outside");
    await registry.close();
  });

  it("makes duplicate terminal frames idempotent and stops unfinished agents", async () => {
    const files = new FakeWorkflowFiles();
    files.files.set(`${dir}/journal.jsonl`, '{"type":"started","agentId":"a1","key":"k1"}\n');
    const bus = new EventBus();
    const terminal: unknown[] = [];
    bus.subscribe("s1", (event) => { if (event.type === "worker.workflow.run" && event.run.status !== "running") terminal.push(event.run); });
    const registry = new ClaudeWorkflowRegistry({ files, bus, now: () => 2_000 });
    registry.launched(owner, launch);
    await registry.flushForTest();
    registry.taskUpdated(owner, { taskId: "task-1", phase: "settled", outcome: "failed" });
    registry.taskUpdated(owner, { taskId: "task-1", phase: "settled", outcome: "failed" });
    await registry.flushForTest();
    expect(registry.list("w1")[0]).toMatchObject({ status: "failed", counts: { started: 1, active: 0, completed: 0, stopped: 1 } });
    expect(terminal).toHaveLength(1);
    await registry.close();
  });

  it("consumes a final journal result without a trailing newline before settling", async () => {
    const files = new FakeWorkflowFiles();
    files.files.set(`${dir}/journal.jsonl`, '{"type":"started","agentId":"a1","key":"k1"}\n{"type":"result","agentId":"a1","key":"k1","result":{}}');
    const registry = new ClaudeWorkflowRegistry({ files, bus: new EventBus(), now: () => 2_100 });
    registry.launched(owner, launch);
    await registry.flushForTest();
    expect(registry.list("w1")[0]).toMatchObject({ counts: { started: 1, active: 1, completed: 0, stopped: 0 } });
    registry.taskUpdated(owner, { taskId: "task-1", phase: "settled", outcome: "completed" });
    await registry.flushForTest();
    expect(registry.list("w1")[0]).toMatchObject({ status: "completed", counts: { started: 1, active: 0, completed: 1, stopped: 0 } });
    await registry.close();
  });

  it("releases a deleted worker's terminal workflow registry state", async () => {
    const files = new FakeWorkflowFiles();
    const bus = new EventBus();
    const registry = new ClaudeWorkflowRegistry({ files, bus, now: () => 2_200 });
    registry.taskUpdated(owner, { taskId: "task-1", phase: "started", workflowName: "audit" });
    registry.taskUpdated(owner, { taskId: "task-1", phase: "settled", outcome: "completed" });
    await registry.flushForTest();
    expect(registry.list("w1")).toHaveLength(1);
    bus.emit({ type: "worker.deletion", sessionId: "s1", workerId: "w1", phase: "completed" });
    expect(registry.list("w1")).toEqual([]);
    await registry.close();
  });

  it("degrades invalid paths without leaking them", async () => {
    const files = new FakeWorkflowFiles();
    files.realpath = vi.fn(async () => "/outside/wf-1");
    const registry = new ClaudeWorkflowRegistry({ files, bus: new EventBus(), now: () => 3_000 });
    registry.launched(owner, launch);
    await registry.flushForTest();
    const run = registry.list("w1")[0]!;
    expect(run).toMatchObject({ visibility: "summary-only", warning: "limited-visibility" });
    expect(JSON.stringify(run)).not.toContain("/outside");
    await registry.close();
  });

  it("rejects traversal-shaped provider ids before touching workflow files", async () => {
    const files = new FakeWorkflowFiles();
    files.files.set(`${dir}/journal.jsonl`, "");
    files.realpath = vi.fn(async (file) => file);
    const registry = new ClaudeWorkflowRegistry({ files, bus: new EventBus(), now: () => 3_100 });
    registry.launched({ ...owner, sdkSessionId: "../sdk-1" }, { ...launch, runId: "../../wf-1" });
    await registry.flushForTest();
    expect(registry.list("w1")[0]).toMatchObject({ visibility: "summary-only", warning: "limited-visibility" });
    expect(files.realpath).not.toHaveBeenCalled();
    await registry.close();
  });

  it("returns only a selected agent bounded history", async () => {
    const files = new FakeWorkflowFiles();
    files.files.set(`${dir}/journal.jsonl`, '{"type":"started","agentId":"a1","key":"k1"}\n');
    files.files.set(`${dir}/agent-a1.jsonl`, '{"timestamp":"2026-07-16T00:00:00.000Z","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\n');
    const registry = new ClaudeWorkflowRegistry({ files, bus: new EventBus(), now: () => 4_000 });
    registry.launched(owner, launch);
    await registry.flushForTest();
    await expect(registry.agentHistory("w1", "task-1", "a1")).resolves.toEqual([{ data: { kind: "message", role: "assistant", content: "done" }, createdAt: "2026-07-16T00:00:00.000Z" }]);
    await expect(registry.agentHistory("w1", "task-1", "missing")).rejects.toThrow("unknown workflow agent");
    await registry.close();
  });

  it("refuses an agent transcript symlink that escapes the validated run directory", async () => {
    const files = new FakeWorkflowFiles();
    files.files.set(`${dir}/journal.jsonl`, '{"type":"started","agentId":"a1","key":"k1"}\n');
    files.files.set(`${dir}/agent-a1.jsonl`, '{"timestamp":"2026-07-16T00:00:00.000Z","type":"assistant","message":{"content":[{"type":"text","text":"secret"}]}}\n');
    files.realpath = vi.fn(async (file) => file.endsWith("agent-a1.jsonl") ? "/outside/agent-a1.jsonl" : file);
    const registry = new ClaudeWorkflowRegistry({ files, bus: new EventBus(), now: () => 4_100 });
    registry.launched(owner, launch);
    await registry.flushForTest();
    await expect(registry.agentHistory("w1", "task-1", "a1")).rejects.toThrow("escaped transcript directory");
    await registry.close();
  });
});
