import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WorkerHeader, SessionHeader } from "../src/renderer/components/WorkspaceHeaders.js";
import { I18nProvider } from "../src/renderer/i18n/provider.js";
import { usePrefsStore } from "../src/renderer/store/prefs.js";
import { useDockPanelsStore } from "../src/renderer/store/dock-panels.js";
import { useLayoutStore, emptyLayoutState } from "../src/renderer/store/layout.js";
import { useStore } from "../src/renderer/store/store.js";

const baseProps = {
  termPageKey: null, termPageOpen: false, rightOpen: false,
  onToggleTerm: () => {}, onToggleRight: () => {},
  onFetchCheckpoints: async () => [], onRestore: async () => {},
};

const openExternal = vi.fn();
beforeEach(() => {
  // OpenInAppMenu (header right side) reads window.rookery.apps.list, so mock it too.
  (window as unknown as { rookery: unknown }).rookery = { openExternal, apps: { list: async () => [] } };
  useStore.setState({ workflows: {} });
});

describe("WorkerHeader background reason", () => {
  it("shows active workflow count without replacing the worker status", () => {
    useStore.setState({ workflows: { w1: { task: { taskId: "task", workflowName: "audit", summary: "", status: "running", visibility: "live", startedAt: 1, lastActivityAt: 2, counts: { started: 1, active: 1, completed: 0, stopped: 0 }, agents: [] } } } } as never);
    render(<WorkerHeader {...baseProps} worker={{ id: "w1", label: "t", repoPath: "/r", status: "background", branch: null, model: null, bg: { count: 1, types: ["local_workflow"] } } as never} />);
    expect(screen.getByText("Workflow · 1")).toBeInTheDocument();
    expect(screen.getByText("백그라운드 작업 중")).toBeInTheDocument();
    expect(screen.queryByText("백그라운드 · 1")).toBeNull();
  });

  it("falls back to the general background count and hides reasons once idle", () => {
    const { rerender } = render(<WorkerHeader {...baseProps} worker={{ id: "w2", label: "t", repoPath: "/r", status: "background", branch: null, model: null, bg: { count: 2, types: ["local_bash"] } } as never} />);
    expect(screen.getByText("백그라운드 · 2")).toBeInTheDocument();
    rerender(<WorkerHeader {...baseProps} worker={{ id: "w2", label: "t", repoPath: "/r", status: "idle", branch: null, model: null } as never} />);
    expect(screen.queryByText(/백그라운드 ·/)).toBeNull();
    expect(screen.queryByText(/Workflow ·/)).toBeNull();
  });
});
afterEach(() => { openExternal.mockReset(); delete (window as unknown as { rookery?: unknown }).rookery; });

describe("WorkerHeader ticket link", () => {
  it("renders a ticket button that opens the ticket url externally", () => {
    render(<WorkerHeader {...baseProps} worker={{ id: "w1", label: "t", repoPath: "/r", status: "running", branch: "rookery/eng-1", model: null, ticketKey: "ENG-1", ticketUrl: "https://l/ENG-1" } as never} />);
    fireEvent.click(screen.getByText("ENG-1"));
    expect(openExternal).toHaveBeenCalledWith("https://l/ENG-1");
  });

  it("shows no ticket button when the worker has no ticket", () => {
    render(<WorkerHeader {...baseProps} worker={{ id: "w2", label: "t", repoPath: "/r", status: "running", branch: "rookery/a0", model: null } as never} />);
    expect(screen.queryByText("ENG-1")).toBeNull();
  });
});

describe("WorkerHeader provider badge (Codex)", () => {
  it("renders a 'Codex' badge when the worker's provider is codex", () => {
    render(<WorkerHeader {...baseProps} worker={{ id: "w4", label: "t", repoPath: "/r", status: "running", branch: "rookery/a0", model: null, provider: "codex" } as never} />);
    expect(screen.getByText("Codex")).toBeInTheDocument();
  });

  it("renders no badge when the worker's provider is absent (claude default)", () => {
    render(<WorkerHeader {...baseProps} worker={{ id: "w5", label: "t", repoPath: "/r", status: "running", branch: "rookery/a0", model: null } as never} />);
    expect(screen.queryByText("Codex")).toBeNull();
  });
});

describe("WorkerHeader responsive-hide hooks (panel controls must never clip)", () => {
  it("gives the status badge and the background chip droppable classes so the far-right controls stay reachable on a narrow pane", () => {
    // jsdom can't evaluate the @container rules; lock the CONTRACT instead — the two newest header items carry the
    // same responsive-hide hooks the CSS drops, so they can no longer push the ml-auto controls past overflow:hidden.
    const { container } = render(<WorkerHeader {...baseProps} worker={{ id: "w1", label: "t", repoPath: "/r", status: "background", branch: null, model: null, bg: { count: 1, types: ["local_bash"] } } as never} />);
    expect(screen.getByText("백그라운드 작업 중").closest(".workspace-header-status")).not.toBeNull();
    expect(screen.getByText("백그라운드 · 1").closest(".workspace-header-activity")).not.toBeNull();
    expect(container.querySelector(".workspace-header-controls")).not.toBeNull(); // controls keep their stable hook (never in a hide-set)
  });
});

describe("SessionHeader provider badge (Codex) — interop QW1", () => {
  it("renders a 'Codex' badge when the master session's provider is codex", () => {
    render(<SessionHeader {...baseProps} name="s" sessionId="s1" cwd="/r" readOnly={false} running={false} termPageKey="p1" provider="codex" />);
    expect(screen.getByText("Codex")).toBeInTheDocument();
  });
  it("renders no badge for a claude/absent-provider session", () => {
    render(<SessionHeader {...baseProps} name="s" sessionId="s1" cwd="/r" readOnly={false} running={false} termPageKey="p1" />);
    expect(screen.queryByText("Codex")).toBeNull();
  });
});

describe("WorkerHeader terminology (reserved-word contract)", () => {
  beforeEach(() => { usePrefsStore.setState({ localePref: "system" }); });
  it("labels a worker 'Worker', never the reserved 'Agent'", () => {
    render(
      <I18nProvider systemLocale="en-US">
        <WorkerHeader {...baseProps} worker={{ id: "w3", label: "demo", repoPath: "/r", status: "running", branch: "rookery/a0", model: null } as never} />
      </I18nProvider>,
    );
    expect(screen.queryByText("Agent")).toBeNull();
    expect(screen.getByText("Worker")).toBeInTheDocument();
  });
});

// audit #48: dock mode used to hide the terminal/right-panel header toggles
// entirely. In dock mode they're restored, but now drive dockPanelsStore
// (the actual dockview panel add/remove is WorkspaceDock's job, covered by a
// live check — this only pins that the header wires the right store calls).
describe("HeaderControls dock-mode toggles (audit #48)", () => {
  beforeEach(() => { useDockPanelsStore.setState({ hiddenByPage: {} }); });

  it("SessionHeader (master): legacy toggle buttons are absent in dock mode, dock toggles are present instead", () => {
    render(<SessionHeader {...baseProps} name="s" sessionId="s1" cwd="/r" readOnly={false} running={false} termPageKey="p1" dock />);
    // Both dock buttons share aria-labels with the legacy ones — only one of each should render.
    expect(screen.getAllByLabelText("터미널")).toHaveLength(1);
    expect(screen.getAllByLabelText("우측 패널")).toHaveLength(1);
  });

  it("SessionHeader (master): terminal toggle hides/shows only the terminal panel", () => {
    render(<SessionHeader {...baseProps} name="s" sessionId="s1" cwd="/r" readOnly={false} running={false} termPageKey="p1" dock />);
    fireEvent.click(screen.getByLabelText("터미널"));
    expect(useDockPanelsStore.getState().hiddenByPage.p1).toEqual(["terminal"]);
    fireEvent.click(screen.getByLabelText("터미널"));
    expect(useDockPanelsStore.getState().hiddenByPage.p1).toEqual([]);
  });

  it("SessionHeader (master): right-panel toggle hides/shows files+git as one group (no nested — master pages never seed it)", () => {
    render(<SessionHeader {...baseProps} name="s" sessionId="s1" cwd="/r" readOnly={false} running={false} termPageKey="p1" dock />);
    fireEvent.click(screen.getByLabelText("우측 패널"));
    expect(useDockPanelsStore.getState().hiddenByPage.p1).toEqual(["files", "git"]);
    fireEvent.click(screen.getByLabelText("우측 패널"));
    expect(useDockPanelsStore.getState().hiddenByPage.p1).toEqual([]);
  });

  it("WorkerHeader: right-panel toggle's group includes nested", () => {
    render(<WorkerHeader {...baseProps} termPageKey="w1" dock worker={{ id: "w1", label: "t", repoPath: "/r", status: "running", branch: "rookery/a0", model: null } as never} />);
    fireEvent.click(screen.getByLabelText("우측 패널"));
    expect(useDockPanelsStore.getState().hiddenByPage.w1).toEqual(["files", "git", "nested"]);
  });
});

// audit #57: the "Reset layout" header control only needs to clear this page's saved layout — the live
// dockview wipe+reseed is WorkspaceDock's own layoutStore subscription (verified live, same as #48 above).
describe("HeaderControls reset-layout button (audit #57)", () => {
  beforeEach(() => { useLayoutStore.setState(emptyLayoutState()); });

  it("is absent outside dock mode", () => {
    render(<SessionHeader {...baseProps} name="s" sessionId="s1" cwd="/r" readOnly={false} running={false} termPageKey="p1" />);
    expect(screen.queryByLabelText("레이아웃 초기화")).toBeNull();
  });

  it("SessionHeader (dock mode): clears only the current page's saved layout", () => {
    useLayoutStore.getState().save_("p1", { grid: 1 });
    useLayoutStore.getState().save_("other-page", { grid: 2 });
    render(<SessionHeader {...baseProps} name="s" sessionId="s1" cwd="/r" readOnly={false} running={false} termPageKey="p1" dock />);
    fireEvent.click(screen.getByLabelText("레이아웃 초기화"));
    expect(useLayoutStore.getState().byPage.p1).toBeUndefined();
    expect(useLayoutStore.getState().byPage["other-page"]).toEqual({ grid: 2 });
  });

  it("WorkerHeader (dock mode): reset button targets the worker's page key", () => {
    useLayoutStore.getState().save_("w1", { grid: 1 });
    render(<WorkerHeader {...baseProps} termPageKey="w1" dock worker={{ id: "w1", label: "t", repoPath: "/r", status: "running", branch: "rookery/a0", model: null } as never} />);
    fireEvent.click(screen.getByLabelText("레이아웃 초기화"));
    expect(useLayoutStore.getState().byPage.w1).toBeUndefined();
  });
});
