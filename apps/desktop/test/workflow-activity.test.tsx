import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowAgentSummary, WorkflowRunSnapshot } from "@daemon/core/workflow-activity.js";
import { ActivityPanel } from "../src/renderer/views/ActivityPanel.js";
import { I18nProvider } from "../src/renderer/i18n/provider.js";
import { usePrefsStore } from "../src/renderer/store/prefs.js";
import { workflowAgentKey } from "../src/renderer/store/reduce.js";
import { useStore } from "../src/renderer/store/store.js";

function agent(id: string, status: WorkflowAgentSummary["status"] = "running", at = 100, overrides: Partial<WorkflowAgentSummary> = {}): WorkflowAgentSummary {
  return { agentId: id, agentType: "workflow-subagent", spawnDepth: 0, status, activity: status === "running" ? "tool" : status === "completed" ? "complete" : "stopped", lastToolName: status === "running" ? "Bash" : undefined, toolUses: 1, startedAt: 1, lastActivityAt: at, ...(status === "running" ? {} : { endedAt: at }), ...overrides };
}

function run(overrides: Partial<WorkflowRunSnapshot> = {}): WorkflowRunSnapshot {
  return {
    taskId: "task-1",
    toolUseId: "tool-1",
    runId: "run-1",
    workflowName: "logic-audit",
    summary: "Audit core logic",
    status: "running",
    visibility: "live",
    startedAt: 1,
    lastActivityAt: 100,
    counts: { started: 12, active: 6, completed: 6, stopped: 0 },
    agents: [],
    ...overrides,
  };
}

function panel(loadAgentHistory = vi.fn(), nestedPanels: React.ComponentProps<typeof ActivityPanel>["nestedPanels"] = []) {
  return <ActivityPanel workerId="w1" nestedPanels={nestedPanels} loadAgentHistory={loadAgentHistory} />;
}

beforeEach(() => {
  usePrefsStore.setState({ localePref: "system" });
  useStore.setState({ workflows: {}, nested: {}, workflowAgentLogs: {}, workflowAgentHistoryLoading: {}, workflowAgentHistoryFailed: {} });
});

describe("Dynamic Workflow Activity", () => {
  it("renders exact factual counts without fabricating a percentage", () => {
    useStore.setState({ workflows: { w1: { task: run() } } });
    render(<I18nProvider systemLocale="en-US">{panel()}</I18nProvider>);
    expect(screen.getByText("logic-audit")).toBeInTheDocument();
    expect(screen.getByText("Active 6 · Completed 6 · Started 12")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("%");
  });

  it("shows active agents while completed agents start collapsed", () => {
    useStore.setState({ workflows: { w1: { task: run({ counts: { started: 2, active: 1, completed: 1, stopped: 0 }, agents: [agent("active-a", "running", 200), agent("done-a", "completed", 100)] }) } } });
    render(panel());
    expect(screen.getByRole("button", { name: /active-a/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /done-a/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /완료 에이전트/ }));
    expect(screen.getByRole("button", { name: /done-a/ })).toBeInTheDocument();
  });

  it("groups labeled agents under concurrently active workflow phases", () => {
    useStore.setState({ workflows: { w1: { task: run({
      phases: [
        { index: 1, title: "Recon", detail: "Inspect code" },
        { index: 2, title: "Verify" },
      ],
      counts: { started: 3, active: 2, completed: 1, stopped: 0 },
      agents: [
        agent("a1", "running", 220, { label: "reader", phaseIndex: 1, phaseTitle: "Recon" }),
        agent("a2", "completed", 200, { label: "reader-done", phaseIndex: 1, phaseTitle: "Recon" }),
        agent("a3", "running", 210, { label: "checker", phaseIndex: 2, phaseTitle: "Verify" }),
      ],
    }) } } });
    render(<I18nProvider systemLocale="en-US">{panel()}</I18nProvider>);
    expect(screen.getByText("Phase 1 · Recon")).toBeInTheDocument();
    expect(screen.getByText("Phase 2 · Verify")).toBeInTheDocument();
    expect(screen.getByText("Inspect code")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reader · a1/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /checker · a3/ })).toBeInTheDocument();
    expect(screen.getByText("Active 1 · Completed 1 · Started 2")).toBeInTheDocument();
    expect(screen.getByText("Active 1 · Completed 0 · Started 1")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Current phase");
  });

  it("loads one selected agent lazily and renders only that transcript", () => {
    const load = vi.fn();
    useStore.setState({ workflows: { w1: { task: run({ counts: { started: 2, active: 2, completed: 0, stopped: 0 }, agents: [agent("a1"), agent("a2")] }) } } });
    render(panel(load));
    fireEvent.click(screen.getByRole("button", { name: /a1/ }));
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith("w1", "task-1", "a1");
    act(() => useStore.setState({ workflowAgentLogs: { [workflowAgentKey("w1", "task-1", "a1")]: [{ kind: "message", role: "assistant", content: "a1 transcript" }] } }));
    expect(screen.getByText("a1 transcript")).toBeInTheDocument();
    expect(screen.queryByText("a2 transcript")).toBeNull();
  });

  it("shows task-level summary and limited visibility instead of an empty state", () => {
    useStore.setState({ workflows: { w1: { task: run({ visibility: "summary-only", warning: "limited-visibility", agents: [], counts: { started: 0, active: 0, completed: 0, stopped: 0 } }) } } });
    render(panel());
    expect(screen.getByText("제한된 가시성")).toBeInTheDocument();
    expect(screen.getByText("Audit core logic")).toBeInTheDocument();
    expect(screen.queryByText(/아직 워크플로나/)).toBeNull();
  });

  it("composes workflow and native nested-agent sections, with one combined empty state", () => {
    useStore.setState({ workflows: { w1: { task: run() } } });
    const { rerender } = render(panel(vi.fn(), [{ id: "nested-1", label: "reviewer", items: [{ kind: "message", role: "assistant", content: "nested transcript" }] }]));
    expect(screen.getByText(/워크플로 실행/)).toBeInTheDocument();
    expect(screen.getByText(/중첩 에이전트/)).toBeInTheDocument();
    expect(screen.getByText("nested transcript")).toBeInTheDocument();
    act(() => useStore.setState({ workflows: {} }));
    rerender(panel());
    expect(screen.getByText("아직 워크플로나 중첩 에이전트 활동이 없어요.")).toBeInTheDocument();
  });

  it("virtualizes a 500-agent roster", () => {
    const agents = Array.from({ length: 500 }, (_, index) => agent(`agent-${index}`, "running", 1000 - index));
    useStore.setState({ workflows: { w1: { task: run({ counts: { started: 500, active: 500, completed: 0, stopped: 0 }, agents }) } } });
    render(panel());
    expect(screen.getAllByRole("button").length).toBeLessThan(80);
  });
});
